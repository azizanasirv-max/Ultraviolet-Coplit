"""Modal app: self-hosted speech-to-text + sales-suggestion service.

Replaces the hosted Ultravox call. Two endpoints:

  POST /v1/calls          (Bearer AI_SERVICE_TOKEN) -> {callId, joinUrl, model}
  WS   /v1/stream?call_id=..&exp=..&sig=..          -> text events

The application server creates a call and hands the signed `wss://` URL to the
customer's browser only. The browser streams 16 kHz mono PCM16 and receives
`transcript`/`suggestion` JSON; no audio is ever returned, so the AI stays
text-only and cannot talk over either participant.

Deploy with:  modal deploy modal_app/app.py
Requires the Modal secret `ai-service` with AI_SERVICE_TOKEN and AI_CALL_SECRET.
See docs/self-hosted-ai-modal.md.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import threading
import time
from typing import Any

import modal

try:  # `modal deploy modal_app/app.py` mounts this directory as the root.
    from pipeline import (  # type: ignore[import-not-found]
        FRAME_BYTES,
        PROTOCOL,
        SAMPLE_RATE,
        VadSegmenter,
        build_messages,
        clean_suggestion,
        is_meaningful_transcript,
    )
    from tokens import build_join_url, verify_call  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - local package imports
    from modal_app.pipeline import (
        FRAME_BYTES,
        PROTOCOL,
        SAMPLE_RATE,
        VadSegmenter,
        build_messages,
        clean_suggestion,
        is_meaningful_transcript,
    )
    from modal_app.tokens import build_join_url, verify_call

APP_NAME = os.environ.get("AI_APP_NAME", "sales-copilot-ai")
ASR_MODEL = os.environ.get("ASR_MODEL", "small.en")
LLM_MODEL = os.environ.get("LLM_MODEL", "Qwen/Qwen2.5-3B-Instruct")
MAX_CALL_SECONDS = int(os.environ.get("MAX_CALL_SECONDS", "3600"))
MAX_SEGMENTS_PER_CALL = int(os.environ.get("MAX_SEGMENTS_PER_CALL", "240"))
MAX_FRAME_BYTES = 64 * 1024
MODEL_LABEL = f"{ASR_MODEL}+{LLM_MODEL.split('/')[-1]}"

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    # faster-whisper needs libgomp for the CTranslate2 CPU kernels.
    .apt_install("libgomp1")
    .pip_install(
        "fastapi[standard]==0.115.6",
        "uvicorn[standard]==0.34.0",
        "numpy==2.1.3",
        "faster-whisper==1.1.1",
        "torch==2.5.1",
        "transformers==4.47.1",
        "accelerate==1.2.1",
        "sentencepiece==0.2.0",
        "huggingface-hub==0.27.1",
        # CTranslate2 (faster-whisper) loads cuDNN/cuBLAS at runtime; pip puts
        # them under site-packages/nvidia/*, so point the loader at them.
        "nvidia-cublas-cu12==12.4.5.8",
        "nvidia-cudnn-cu12==9.1.0.70",
    )
    .env(
        {
            "HF_HOME": "/models/hf",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            # Deploy-time values are baked in here: module-level `os.environ`
            # reads happen in the container, where the local shell is absent.
            "ASR_MODEL": ASR_MODEL,
            "LLM_MODEL": LLM_MODEL,
            "MAX_CALL_SECONDS": str(MAX_CALL_SECONDS),
            "MAX_SEGMENTS_PER_CALL": str(MAX_SEGMENTS_PER_CALL),
            "MAX_NEW_TOKENS": os.environ.get("MAX_NEW_TOKENS", "96"),
            "AI_DEVICE": os.environ.get("AI_DEVICE", "cuda"),
            "LD_LIBRARY_PATH": (
                "/usr/local/lib/python3.11/site-packages/nvidia/cublas/lib:"
                "/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib"
            ),
        }
    )
)

# Cached weights: without a Volume every cold start re-downloads ~7 GB.
model_cache = modal.Volume.from_name("ai-model-cache", create_if_missing=True)
# Shared call records: the WS connection may land on a different container than
# the POST that created the call.
call_records = modal.Dict.from_name("ai-call-records", create_if_missing=True)



class SuggestionEngine:
    """Loads the ASR and instruction models once per container.

    Both models live on the GPU, so the locks serialise inference. Streaming,
    receives and sends stay concurrent; only the GPU work queues.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._asr: Any = None
        self._tokenizer: Any = None
        self._llm: Any = None
        self._loaded = False
        self.max_new_tokens = int(os.environ.get("MAX_NEW_TOKENS", "96"))

    def load(self) -> None:
        # Imported here so the module can be imported (and syntax-checked)
        # without the ML stack installed.
        import torch
        from faster_whisper import WhisperModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        device = os.environ.get("AI_DEVICE", "cuda")
        if device == "cuda":
            self._asr = WhisperModel(ASR_MODEL, device="cuda", compute_type="int8_float16")
        else:
            self._asr = WhisperModel(ASR_MODEL, device="cpu", compute_type="int8")

        self._tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL)
        self._llm = AutoModelForCausalLM.from_pretrained(
            LLM_MODEL,
            torch_dtype=torch.float16 if device == "cuda" else torch.float32,
            device_map=device,
            low_cpu_mem_usage=True,
        )
        self._llm.eval()
        self._loaded = True

    @property
    def loaded(self) -> bool:
        return self._loaded

    def transcribe(self, pcm: bytes) -> str:
        import numpy as np

        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if audio.size == 0:
            return ""
        with self._lock:
            segments, _info = self._asr.transcribe(
                audio,
                language=os.environ.get("ASR_LANGUAGE") or None,
                beam_size=1,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            return " ".join(segment.text.strip() for segment in segments).strip()

    def suggest(self, messages: list[dict[str, str]]) -> str:
        import torch

        prompt = self._tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self._tokenizer(prompt, return_tensors="pt").to(self._llm.device)
        with self._lock, torch.inference_mode():
            output = self._llm.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=True,
                temperature=0.2,
                top_p=0.9,
                repetition_penalty=1.05,
                pad_token_id=self._tokenizer.eos_token_id,
            )
        generated = output[0][inputs["input_ids"].shape[1] :]
        return self._tokenizer.decode(generated, skip_special_tokens=True)

    def process_segment(
        self,
        system_prompt: str,
        segment_pcm: bytes,
        history: list[str],
    ) -> tuple[str, str]:
        """Returns (transcript, suggestion); either may be empty."""
        transcript = self.transcribe(segment_pcm)
        if not is_meaningful_transcript(transcript):
            return transcript, ""
        raw = self.suggest(build_messages(system_prompt, transcript, history))
        return transcript, clean_suggestion(raw)


@app.cls(
    image=image,
    # T4 is the cheapest option that runs a 3B model in fp16 (~$0.000164/s).
    gpu=os.environ.get("AI_GPU", "T4"),
    cpu=2.0,
    memory=16384,
    scaledown_window=int(os.environ.get("SCALEDOWN_WINDOW", "120")),
    # A call may last up to 1 hour; the default 300 s would kill it.
    timeout=3900,
    startup_timeout=900,
    max_containers=int(os.environ.get("MAX_CONTAINERS", "2")),
    secrets=[service_secret],
    volumes={"/models": model_cache},
)
@modal.concurrent(max_inputs=2)
class AiService:
    def __init__(self) -> None:
        self.engine = SuggestionEngine()

    @modal.enter()
    def start(self) -> None:
        self.engine.load()

    @modal.asgi_app()
    def web(self) -> Any:
        return create_app(self.engine)

service_secret = modal.Secret.from_name("ai-service")



def _service_token() -> str:
    return os.environ.get("AI_SERVICE_TOKEN", "")


def _call_secret() -> str:
    return os.environ.get("AI_CALL_SECRET", "")


def _public_base(request: Any) -> str:
    """Public base URL the browser can reach (Modal proxy aware)."""
    override = os.environ.get("AI_PUBLIC_URL", "").strip().rstrip("/")
    if override:
        base = override
    else:
        base = str(request.base_url).rstrip("/")
    if base.startswith("http://") and "localhost" not in base and "127.0.0.1" not in base:
        # Modal terminates TLS in front of the container.
        base = "https://" + base[len("http://") :]
    return base


def _parse_positive_int(value: Any, default: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed <= 0:
        return default
    return min(parsed, maximum)


def create_app(engine: SuggestionEngine) -> Any:
    """Builds the ASGI app. Kept separate so it can be imported without Modal."""
    from fastapi import FastAPI, HTTPException, Request, WebSocket

    api = FastAPI(
        title="Sales Copilot self-hosted AI",
        version="1",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def require_bearer(request: Request) -> None:
        expected = _service_token()
        provided = request.headers.get("authorization", "")
        if not expected or not hmac.compare_digest(provided, f"Bearer {expected}"):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @api.get("/v1/health")
    async def health() -> dict[str, Any]:
        # Public on purpose: capability flags only, never secrets or transcripts.
        return {
            "status": "ok" if engine.loaded else "starting",
            "protocol": PROTOCOL,
            "asr": ASR_MODEL,
            "llm": LLM_MODEL,
            "sampleRate": SAMPLE_RATE,
            "maxCallSeconds": MAX_CALL_SECONDS,
        }

    @api.post("/v1/calls")
    async def create_call(request: Request) -> dict[str, Any]:
        require_bearer(request)
        if not _call_secret():
            raise HTTPException(status_code=503, detail="AI_CALL_SECRET is not configured")
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON is a client error
            payload = {}
        if not isinstance(payload, dict):
            payload = {}

        system_prompt = str(payload.get("systemPrompt") or "")[:4000]
        session_id = str(payload.get("sessionId") or "")[:100]
        ttl_seconds = _parse_positive_int(
            payload.get("maxDurationSeconds"), MAX_CALL_SECONDS, MAX_CALL_SECONDS
        )
        ttl_seconds = max(60, ttl_seconds)

        call_id = secrets.token_hex(16)
        now_ms = int(time.time() * 1000)
        expires_at = now_ms + ttl_seconds * 1000
        join_url = build_join_url(_public_base(request), call_id, expires_at, _call_secret())

        await asyncio.to_thread(
            call_records.put,
            call_id,
            {
                "callId": call_id,
                "sessionId": session_id,
                "systemPrompt": system_prompt,
                "createdAt": now_ms,
                "expiresAt": expires_at,
                "maxDurationSeconds": ttl_seconds,
            },
        )

        return {
            "callId": call_id,
            "joinUrl": join_url,
            "model": MODEL_LABEL,
            "expiresAt": expires_at,
            "protocol": PROTOCOL,
        }

    @api.delete("/v1/calls/{call_id}")
    async def delete_call(call_id: str, request: Request) -> dict[str, Any]:
        require_bearer(request)
        # Bookkeeping only: the socket exits on its own when the browser leaves.
        try:
            await asyncio.to_thread(call_records.pop, call_id, None)
        except Exception:  # noqa: BLE001 - bookkeeping only, never fail the request
            pass
        return {"ended": True, "callId": call_id}

    @api.websocket("/v1/stream")
    async def stream(socket: WebSocket) -> None:
        call_id = socket.query_params.get("call_id", "")
        try:
            expires_at = int(socket.query_params.get("exp") or 0)
        except ValueError:
            expires_at = 0
        signature = socket.query_params.get("sig", "")

        if not verify_call(call_id, expires_at, signature, _call_secret()):
            await socket.close(code=4401)
            return

        try:
            record = await asyncio.to_thread(call_records.get, call_id)

        except Exception:  # noqa: BLE001 - a missing Dict must not 500 the socket
            record = None
        if not record or int(record.get("expiresAt") or 0) <= int(time.time() * 1000):
            await socket.close(code=4404)
            return

        await socket.accept()
        await _run_call(engine, socket, record)

    return api


async def _run_call(engine: SuggestionEngine, socket: Any, record: dict[str, Any]) -> None:
    """One streaming call: PCM in, transcript/suggestion JSON out."""
    segmenter = VadSegmenter()
    ordinal = 0
    processed_segments = 0
    history: list[str] = []
    started = time.monotonic()
    max_seconds = min(
        int(record.get("maxDurationSeconds") or MAX_CALL_SECONDS), MAX_CALL_SECONDS
    )
    system_prompt = str(record.get("systemPrompt") or "")

    async def send(payload: dict[str, Any]) -> None:
        try:
            await socket.send_json(payload)
        except Exception:  # noqa: BLE001 - the peer may have gone away
            pass

    async def process(segment: Any) -> None:
        nonlocal ordinal, processed_segments
        if processed_segments >= MAX_SEGMENTS_PER_CALL:
            return
        processed_segments += 1
        await send({"type": "status", "status": "thinking"})
        try:
            transcript, suggestion = await asyncio.to_thread(
                engine.process_segment, system_prompt, segment.pcm, history
            )
        except Exception:  # noqa: BLE001 - a model failure must not kill the call
            await send(
                {
                    "type": "error",
                    "code": "PIPELINE_ERROR",
                    "message": "The AI model could not process that segment.",
                }
            )
            await send({"type": "status", "status": "listening"})
            return

        if transcript:
            ordinal += 1
            await send(
                {
                    "type": "transcript",
                    "speaker": "user",
                    "text": transcript,
                    "isFinal": True,
                    "ordinal": ordinal,
                    "startMs": segment.start_ms,
                    "endMs": segment.end_ms,
                }
            )
            history.append(transcript)
            del history[:-6]
        if suggestion:
            ordinal += 1
            await send(
                {
                    "type": "suggestion",
                    "speaker": "agent",
                    "text": suggestion,
                    "isFinal": True,
                    "ordinal": ordinal,
                }
            )
        await send({"type": "status", "status": "listening"})

    await send(
        {
            "type": "ready",
            "protocol": PROTOCOL,
            "callId": record.get("callId"),
            "model": MODEL_LABEL,
            "sampleRate": SAMPLE_RATE,
            "frameBytes": FRAME_BYTES,
        }
    )
    await send({"type": "status", "status": "listening"})

    try:
        while True:
            if time.monotonic() - started > max_seconds:
                await send(
                    {
                        "type": "error",
                        "code": "MAX_DURATION",
                        "message": "The AI call reached its maximum duration.",
                    }
                )
                break

            message = await socket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            audio = message.get("bytes")
            if audio:
                if len(audio) > MAX_FRAME_BYTES:
                    # A malformed client must not grow the server buffer.
                    continue
                for segment in segmenter.push(audio):
                    await process(segment)
                continue

            text = message.get("text")
            if not text:
                continue
            try:
                event = json.loads(text)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue

            kind = event.get("type")
            if kind == "ping":
                await send({"type": "pong", "at": event.get("at")})
            elif kind in ("audio.end", "stop"):
                final = segmenter.flush()
                if final is not None:
                    await process(final)
                break
    except Exception:  # noqa: BLE001 - disconnect/preemption ends the call
        return
    finally:
        try:
            await socket.close()
        except Exception:  # noqa: BLE001
            pass
