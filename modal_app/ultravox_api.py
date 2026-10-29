"""HTTP API for the Ultravox v0.5 suggestion service.

Two endpoints:

  GET  /v1/health    public, capability flags only (no secrets, no audio)
  POST /v1/suggest   Bearer-authenticated, audio in -> text suggestion out

The handler never returns or streams audio and never logs audio bytes or the
service token. Errors use a stable ``{"error": {"code", "message"}}`` shape so
the calling server can map them without parsing prose.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from modal_app.ultravox_core import (
    DEFAULT_INFERENCE_TIMEOUT_SECONDS,
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_MAX_AUDIO_SECONDS,
    DEFAULT_MAX_NEW_TOKENS,
    DEFAULT_MAX_REQUEST_BYTES,
    MAX_AUDIO_SECONDS_LIMIT,
    MAX_INFERENCE_TIMEOUT_SECONDS,
    MAX_NEW_TOKENS_LIMIT,
    MODEL_ID,
    SAMPLE_RATE,
    InferenceError,
    InferenceTimeout,
    ServiceError,
    decode_audio,
    decode_base64_audio,
    resolve_int,
    resolve_seconds,
    verify_bearer,
)

try:  # `modal deploy modal_app/ultravox_app.py` mounts this directory itself.
    from ultravox_core import (  # type: ignore[no-redef]
        DEFAULT_INFERENCE_TIMEOUT_SECONDS,
        DEFAULT_MAX_AUDIO_BYTES,
        DEFAULT_MAX_AUDIO_SECONDS,
        DEFAULT_MAX_NEW_TOKENS,
        DEFAULT_MAX_REQUEST_BYTES,
        MAX_AUDIO_SECONDS_LIMIT,
        MAX_INFERENCE_TIMEOUT_SECONDS,
        MAX_NEW_TOKENS_LIMIT,
        MODEL_ID,
        SAMPLE_RATE,
        InferenceError,
        InferenceTimeout,
        ServiceError,
        decode_audio,
        decode_base64_audio,
        resolve_int,
        resolve_seconds,
        verify_bearer,
    )
except ImportError:  # pragma: no cover - repo-root imports (tests)
    pass

LOG = logging.getLogger("ultravox.api")

SERVICE_TOKEN_ENV = "ULTRAVOX_SERVICE_TOKEN"
EMPTY_SUGGESTION = (
    "No intelligible customer speech was detected, so no suggestion was generated."
)


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    return resolve_int(
        os.environ.get(name), default, minimum=minimum, maximum=maximum
    )


def max_audio_seconds() -> int:
    return _env_int(
        "ULTRAVOX_MAX_AUDIO_SECONDS",
        DEFAULT_MAX_AUDIO_SECONDS,
        minimum=1,
        maximum=MAX_AUDIO_SECONDS_LIMIT,
    )


def max_audio_bytes() -> int:
    return _env_int(
        "ULTRAVOX_MAX_AUDIO_BYTES",
        DEFAULT_MAX_AUDIO_BYTES,
        minimum=64 * 1024,
        maximum=DEFAULT_MAX_REQUEST_BYTES,
    )


def max_new_tokens() -> int:
    return _env_int(
        "ULTRAVOX_MAX_NEW_TOKENS",
        DEFAULT_MAX_NEW_TOKENS,
        minimum=1,
        maximum=MAX_NEW_TOKENS_LIMIT,
    )


def inference_timeout() -> float:
    return resolve_seconds(
        os.environ.get("ULTRAVOX_INFERENCE_TIMEOUT_SECONDS"),
        DEFAULT_INFERENCE_TIMEOUT_SECONDS,
        maximum=MAX_INFERENCE_TIMEOUT_SECONDS,
    )


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
    )


def _service_error(exc: ServiceError) -> JSONResponse:
    return _error(exc.status, exc.code, exc.message)


def _check_token(request: Request) -> JSONResponse | None:
    """Enforces the bearer token. Fails closed when the secret is missing."""
    expected = os.environ.get(SERVICE_TOKEN_ENV, "").strip()
    if not expected:
        LOG.error("%s is not configured; refusing inference.", SERVICE_TOKEN_ENV)
        return _error(
            503,
            "SERVICE_NOT_CONFIGURED",
            "The AI service is not configured with an inference token.",
        )
    if not verify_bearer(request.headers.get("authorization", ""), expected):
        return _error(401, "UNAUTHORIZED", "A valid bearer token is required.")
    return None


async def _read_audio_request(request: Request) -> dict[str, Any]:
    """Extracts audio, context and maxNewTokens from JSON or multipart."""
    content_type = request.headers.get("content-type", "")
    base_type = content_type.split(";", 1)[0].strip().lower()
    limit = max_audio_bytes()

    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > DEFAULT_MAX_REQUEST_BYTES:
                raise ServiceError(
                    413, "REQUEST_TOO_LARGE", "The request body is too large."
                )
        except ValueError:
            raise ServiceError(
                400, "INVALID_CONTENT_LENGTH", "Invalid Content-Length header."
            ) from None

    if base_type == "multipart/form-data":
        try:
            form = await request.form()
        except Exception as exc:  # noqa: BLE001 - malformed body is a client error
            raise ServiceError(
                400, "INVALID_MULTIPART", "The multipart body could not be parsed."
            ) from exc
        upload = form.get("audio")
        if upload is None or isinstance(upload, str):
            raise ServiceError(
                400, "MISSING_AUDIO", "Attach the audio as a file field named 'audio'."
            )
        try:
            data = await upload.read(limit + 1)
        finally:
            # Release the spooled temp file as soon as the bytes are copied.
            await upload.close()
        context = form.get("context")
        tokens = form.get("maxNewTokens")
        return {
            "audio": data,
            "content_type": getattr(upload, "content_type", "") or "",
            "context": context if isinstance(context, str) else "",
            "max_new_tokens": tokens if isinstance(tokens, str) else None,
        }

    if base_type not in ("application/json", ""):
        raise ServiceError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Send application/json or multipart/form-data.",
        )

    body = await request.body()
    if len(body) > DEFAULT_MAX_REQUEST_BYTES:
        raise ServiceError(413, "REQUEST_TOO_LARGE", "The request body is too large.")
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001 - malformed JSON is a client error
        raise ServiceError(
            400, "INVALID_JSON", "The request body is not valid JSON."
        ) from exc
    if not isinstance(payload, dict):
        raise ServiceError(
            400, "INVALID_JSON", "The request body must be a JSON object."
        )

    return {
        "audio": decode_base64_audio(payload.get("audioBase64")),
        "content_type": str(payload.get("mimeType") or ""),
        "context": payload.get("context"),
        "max_new_tokens": payload.get("maxNewTokens"),
    }


def create_app(engine: Any) -> FastAPI:
    """Builds the ASGI app around ``engine`` (a loaded UltravoxEngine)."""
    api = FastAPI(
        title="Ultravox v0.5 sales-copilot suggestions",
        version="1",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @api.get("/v1/health")
    async def health() -> dict[str, Any]:
        # Public on purpose: capability flags only, never secrets or audio.
        loaded = bool(getattr(engine, "loaded", False))
        return {
            "status": "ok" if loaded else "starting",
            "service": "ultravox-suggestions",
            "model": getattr(engine, "model_id", MODEL_ID),
            "modelLoaded": loaded,
            "sampleRate": SAMPLE_RATE,
            "maxAudioSeconds": max_audio_seconds(),
            "maxNewTokens": max_new_tokens(),
            "inferenceTimeoutSeconds": inference_timeout(),
            "output": "text",
        }

    @api.post("/v1/suggest")
    async def suggest(request: Request) -> Any:
        started = time.monotonic()
        request_id = secrets.token_hex(8)

        denied = _check_token(request)
        if denied is not None:
            return denied

        try:
            fields = await _read_audio_request(request)
            clip = decode_audio(
                fields["audio"],
                max_seconds=max_audio_seconds(),
                max_bytes=max_audio_bytes(),
                content_type=fields["content_type"],
            )
        except ServiceError as exc:
            LOG.info(
                "request=%s rejected code=%s status=%s",
                request_id,
                exc.code,
                exc.status,
            )
            return _service_error(exc)
        except Exception:  # noqa: BLE001 - never leak internals to the caller
            LOG.exception("request=%s failed while decoding audio", request_id)
            return _error(500, "INTERNAL_ERROR", "The audio could not be processed.")

        if not getattr(engine, "loaded", False):
            return _error(
                503, "MODEL_LOADING", "The model is still loading. Retry shortly."
            )

        context = fields.get("context")
        context = context if isinstance(context, str) else ""
        tokens = resolve_int(
            fields.get("max_new_tokens"),
            max_new_tokens(),
            minimum=1,
            maximum=MAX_NEW_TOKENS_LIMIT,
        )
        timeout = inference_timeout()

        try:
            # The engine enforces its own deadline; this outer guard also caps a
            # wedged lock or a stuck CUDA call.
            suggestion = await asyncio.wait_for(
                asyncio.to_thread(
                    engine.suggest,
                    clip,
                    context=context,
                    max_new_tokens=tokens,
                    timeout_seconds=timeout,
                ),
                timeout=timeout + 5.0,
            )
        except InferenceTimeout:
            LOG.warning("request=%s timed out after %.1fs", request_id, timeout)
            return _error(504, "INFERENCE_TIMEOUT", "The model did not answer in time.")
        except InferenceError as exc:
            LOG.warning("request=%s inference error: %s", request_id, exc)
            return _error(
                502, "INFERENCE_FAILED", "The model could not answer that audio."
            )
        except asyncio.TimeoutError:
            LOG.warning(
                "request=%s hard timeout after %.1fs", request_id, timeout + 5.0
            )
            return _error(504, "INFERENCE_TIMEOUT", "The model did not answer in time.")
        except Exception:  # noqa: BLE001 - never leak internals to the caller
            LOG.exception("request=%s failed during inference", request_id)
            return _error(500, "INTERNAL_ERROR", "The AI service failed unexpectedly.")

        elapsed_ms = int((time.monotonic() - started) * 1000)
        LOG.info(
            "request=%s ok duration=%sms audio=%sms chars=%s",
            request_id,
            elapsed_ms,
            clip.duration_ms,
            len(suggestion),
        )
        return {
            "suggestion": suggestion,
            "emptyReason": None if suggestion else "NO_SPEECH",
            "note": None if suggestion else EMPTY_SUGGESTION,
            "model": getattr(engine, "model_id", MODEL_ID),
            "audioDurationMs": clip.duration_ms,
            "latencyMs": elapsed_ms,
            "requestId": request_id,
        }

    return api
