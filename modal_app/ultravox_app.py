"""Modal deployment for Ultravox v0.5 — audio in, text suggestion out.

Standalone service. It does not import, wrap or replace the application's
existing AI path, and it is not wired into the main app yet.

  GET  /v1/health    public capability flags
  POST /v1/suggest   Bearer-authenticated inference (audio -> text)

Deploy with:

  modal deploy modal_app/ultravox_app.py

Required Modal secret ``ultravox-service``:

  ULTRAVOX_SERVICE_TOKEN  random value; your server sends it as a bearer token
  HF_TOKEN                Hugging Face token with access to
                          meta-llama/Llama-3.1-8B-Instruct (gated)

See docs/ultravox-modal.md for cost estimates and the verification checklist.
Nothing in this file deploys or spends GPU credit on import.
"""

from __future__ import annotations

import os

import modal

try:  # `modal deploy modal_app/ultravox_app.py` mounts modal_app/ as the root.
    from ultravox_api import create_app  # type: ignore[import-not-found]
    from ultravox_core import MODEL_ID as DEFAULT_MODEL_ID
    from ultravox_engine import UltravoxEngine  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - repo-root imports (tests)
    from modal_app.ultravox_api import create_app
    from modal_app.ultravox_core import MODEL_ID as DEFAULT_MODEL_ID
    from modal_app.ultravox_engine import UltravoxEngine

APP_NAME = os.environ.get("ULTRAVOX_APP_NAME", "ultravox-v05-service")
MODEL_ID = os.environ.get("ULTRAVOX_MODEL_ID", DEFAULT_MODEL_ID)
DEVICE = os.environ.get("ULTRAVOX_DEVICE", "cuda")

# One A100 40 GB first (requirement), then an in-stock alternative with more
# VRAM. Modal respects this order. Override, e.g.
#   ULTRAVOX_GPU="A100-40GB"            # strictly 40 GB (may queue)
#   ULTRAVOX_GPU="L40S"                 # cheapest 48 GB option
GPU_TYPES = [
    gpu.strip()
    for gpu in os.environ.get("ULTRAVOX_GPU", "A100-40GB,L40S").split(",")
    if gpu.strip()
]

SCALEDOWN_WINDOW = int(os.environ.get("ULTRAVOX_SCALEDOWN_WINDOW", "300"))
MAX_CONTAINERS = int(os.environ.get("ULTRAVOX_MAX_CONTAINERS", "1"))
MAX_INPUTS = int(os.environ.get("ULTRAVOX_MAX_INPUTS", "4"))
REQUEST_TIMEOUT = int(os.environ.get("ULTRAVOX_REQUEST_TIMEOUT", "180"))
STARTUP_TIMEOUT = int(os.environ.get("ULTRAVOX_STARTUP_TIMEOUT", "1800"))
# Loading ~17.5 GB of bf16 weights needs headroom above the GPU copy.
CPU_CORES = float(os.environ.get("ULTRAVOX_CPU", "4"))
MEMORY_MB = int(os.environ.get("ULTRAVOX_MEMORY_MB", "24576"))

MAX_AUDIO_SECONDS = int(os.environ.get("ULTRAVOX_MAX_AUDIO_SECONDS", "60"))
MAX_NEW_TOKENS = int(os.environ.get("ULTRAVOX_MAX_NEW_TOKENS", "64"))
INFERENCE_TIMEOUT_SECONDS = float(
    os.environ.get("ULTRAVOX_INFERENCE_TIMEOUT_SECONDS", "25")
)

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    # ffmpeg decodes webm/ogg/mp3 uploads; WAV is handled by the stdlib.
    .apt_install("ffmpeg")
    .pip_install(
        "fastapi==0.115.6",
        "python-multipart==0.0.20",
        "numpy==2.1.3",
        # torch 2.5.1 ships CUDA 12.4 wheels; A100 (sm_80) is supported.
        "torch==2.5.1",
        # 4.48.1 is the transformers release this checkpoint was exported with
        # (config.transformers_version); its custom code relies on 4.x
        # torch_dtype/_init_weights internals, so majors are not interchangeable.
        "transformers==4.48.1",
        "accelerate==1.3.0",
        # Required by the checkpoint's custom ultravox_model.py (imported even
        # though no LoRA adapters are applied at inference time).
        "peft==0.14.0",
    )
    .env(
        {
            "HF_HOME": "/models/hf",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "ULTRAVOX_MODEL_ID": MODEL_ID,
            "ULTRAVOX_DEVICE": DEVICE,
            "ULTRAVOX_MAX_AUDIO_SECONDS": str(MAX_AUDIO_SECONDS),
            "ULTRAVOX_MAX_NEW_TOKENS": str(MAX_NEW_TOKENS),
            "ULTRAVOX_INFERENCE_TIMEOUT_SECONDS": str(INFERENCE_TIMEOUT_SECONDS),
        }
    )
)

# Weights live on a Volume so a cold start does not re-download ~17.5 GB.
model_cache = modal.Volume.from_name(
    os.environ.get("ULTRAVOX_VOLUME_NAME", "ultravox-model-cache"),
    create_if_missing=True,
)

# Both values are read only inside the container; neither is ever returned.
service_secret = modal.Secret.from_name(
    os.environ.get("ULTRAVOX_SECRET_NAME", "ultravox-service"),
    required_keys=["ULTRAVOX_SERVICE_TOKEN", "HF_TOKEN"],
)



def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set; add it to the Modal secret.")
    return value


@app.function(
    image=image,
    volumes={"/models": model_cache},
    secrets=[service_secret],
    cpu=4.0,
    memory=16384,
    timeout=3600,
)
def download_models() -> str:
    """Pre-fetches every weight file into the Volume using CPU time only.

    Run this once after creating the secret, before the first GPU request, so
    the ~17.5 GB download is not billed at GPU rates.

        modal run modal_app/ultravox_app.py::download_models
    """
    from huggingface_hub import snapshot_download

    token = _require_env("HF_TOKEN")
    hf_home = os.environ.get("HF_HOME", "/models/hf")

    # 1.37 GB: audio tower + projector + custom code + tokenizer.
    snapshot_download(
        repo_id=MODEL_ID,
        cache_dir=hf_home,
        token=token,
        allow_patterns=["*.json", "*.safetensors", "*.py", "*.model"],
    )
    # ~16 GB: the frozen Llama-3.1-8B-Instruct text backbone. The gated repo
    # needs a token whose account accepted the Llama 3.1 licence.
    snapshot_download(
        repo_id="meta-llama/Llama-3.1-8B-Instruct",
        cache_dir=hf_home,
        token=token,
        allow_patterns=["*.json", "*.safetensors", "tokenizer*", "*.model"],
    )
    # The Whisper feature-extractor config the processor fetches directly.
    snapshot_download(
        repo_id="openai/whisper-large-v3-turbo",
        cache_dir=hf_home,
        allow_patterns=["*.json"],
    )
    model_cache.commit()
    return f"weights cached in {hf_home}"


@app.cls(
    image=image,
    gpu=GPU_TYPES,
    volumes={"/models": model_cache},
    secrets=[service_secret],
    cpu=CPU_CORES,
    memory=MEMORY_MB,
    min_containers=0,
    max_containers=MAX_CONTAINERS,
    scaledown_window=SCALEDOWN_WINDOW,
    timeout=REQUEST_TIMEOUT,
    startup_timeout=STARTUP_TIMEOUT,
)
# Input concurrency lets /v1/health answer while a generation is running. The
# engine's lock still serialises GPU work, so this is about HTTP responsiveness,
# not parallel inference.
@modal.concurrent(max_inputs=MAX_INPUTS)
class UltravoxService:
    """One Ultravox pipeline per container, serving HTTP and internal calls."""

    engine: UltravoxEngine

    @modal.enter()
    def load(self) -> None:
        import torch

        # If Modal allocated a different accelerator, say so in the log; the
        # pipeline still runs, just with a different dtype/throughput.
        if DEVICE.startswith("cuda"):
            available = torch.cuda.is_available()
            name = torch.cuda.get_device_name(0) if available else "cpu"
            vram = (
                torch.cuda.get_device_properties(0).total_memory / (1024**3)
                if available
                else 0.0
            )
            print(
                f"[ultravox] cuda_available={available} device={name} "
                f"vram_gib={vram:.1f} requested_gpu={GPU_TYPES}",
                flush=True,
            )

        self.engine = UltravoxEngine(
            model_id=MODEL_ID,
            device=DEVICE,
            max_new_tokens=MAX_NEW_TOKENS,
        )
        self.engine.load()
        print(f"[ultravox] model loaded: {MODEL_ID}", flush=True)

    @modal.method()
    def suggest(
        self,
        audio_wav_base64: str,
        context: str = "",
        max_new_tokens: int = MAX_NEW_TOKENS,
    ) -> dict[str, object]:
        """Internal invocation path (``modal run``) for smoke tests."""
        import base64

        try:
            from ultravox_core import decode_audio
        except ImportError:  # pragma: no cover - repo layout
            from modal_app.ultravox_core import decode_audio

        clip = decode_audio(base64.b64decode(audio_wav_base64))
        suggestion = self.engine.suggest(
            clip,
            context=context,
            max_new_tokens=max_new_tokens,
            timeout_seconds=INFERENCE_TIMEOUT_SECONDS,
        )
        return {
            "suggestion": suggestion,
            "model": MODEL_ID,
            "audioDurationMs": clip.duration_ms,
        }

    @modal.asgi_app()
    def web(self):
        return create_app(self.engine)
