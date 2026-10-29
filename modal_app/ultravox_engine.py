"""Ultravox v0.5 inference engine (one model per GPU container).

Loading follows the official model card and the "Use this model" snippet on
Hugging Face:

    transformers.pipeline(
        model="fixie-ai/ultravox-v0_5-llama-3_1-8b", trust_remote_code=True
    )

The checkpoint ships custom code (``ultravox_model.py``,
``ultravox_pipeline.py``, ``ultravox_processing.py``) so ``trust_remote_code``
is required. Its ``model.safetensors`` holds only the Whisper audio encoder and
the multimodal projector (~1.37 GB); the Llama-3.1-8B text weights are loaded
from the gated ``meta-llama/Llama-3.1-8B-Instruct`` repo, so ``HF_TOKEN`` with
accepted Llama 3.1 terms is mandatory (see docs/ultravox-modal.md).

The pipeline is the documented audio + turns interface:

    pipe({"audio": float32_array_at_16k, "turns": [...], "sampling_rate": 16000},
         max_new_tokens=64)

This module imports torch/transformers/numpy lazily inside the loader so it can
be imported and unit tested on a machine without the ML stack. The heavy
runtime is injected through ``loader``, which is what the tests replace.
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from modal_app.ultravox_core import (
    DEFAULT_INFERENCE_TIMEOUT_SECONDS,
    DEFAULT_MAX_NEW_TOKENS,
    DEFAULT_SYSTEM_PROMPT,
    MODEL_ID,
    SAMPLE_RATE,
    AudioClip,
    InferenceError,
    InferenceTimeout,
    build_turns,
    call_with_deadline,
    parse_suggestion,
    require_hf_token,
)

try:  # `modal deploy modal_app/ultravox_app.py` mounts this directory itself.
    from ultravox_core import (  # type: ignore[no-redef]
        DEFAULT_INFERENCE_TIMEOUT_SECONDS,
        DEFAULT_MAX_NEW_TOKENS,
        DEFAULT_SYSTEM_PROMPT,
        MODEL_ID,
        SAMPLE_RATE,
        AudioClip,
        InferenceError,
        InferenceTimeout,
        build_turns,
        call_with_deadline,
        parse_suggestion,
        require_hf_token,
    )
except ImportError:  # pragma: no cover - repo-root imports (tests)
    pass


class ModelLoadError(RuntimeError):
    """The model could not be downloaded or placed on the device."""


def default_loader(model_id: str, device: str) -> Any:
    """Loads the documented Ultravox pipeline onto ``device``.

    ``torch_dtype`` is bfloat16 on GPU (the checkpoint's own dtype) and float32
    on CPU, where bfloat16 matmuls are impractically slow. ``transformers`` is
    pinned to 4.48.1, the release this checkpoint was exported with; its custom
    code depends on 4.x internals such as ``torch_dtype`` and ``_init_weights``
    that later majors changed.
    """
    import torch
    import transformers

    dtype = torch.bfloat16 if str(device).startswith("cuda") else torch.float32
    return transformers.pipeline(
        model=model_id,
        trust_remote_code=True,
        torch_dtype=dtype,
        device=device,
    )


class UltravoxEngine:
    """Owns one loaded Ultravox pipeline and serialises GPU work."""

    def __init__(
        self,
        *,
        model_id: str = MODEL_ID,
        device: str | None = None,
        max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
        loader: Callable[[str, str], Any] | None = None,
    ) -> None:
        self.model_id = model_id
        self.device = device or os.environ.get("ULTRAVOX_DEVICE", "cuda")
        self.max_new_tokens = int(max_new_tokens)
        self._loader = loader or default_loader
        self._pipeline: Any = None
        self._lock = threading.Lock()
        # One long-lived worker keeps GPU work serialised even when a request
        # times out: the abandoned generation still occupies the worker, so the
        # next one queues behind it instead of running concurrently.
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="ultravox-gpu"
        )
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        """Downloads (if needed) and loads the model. Idempotent."""
        if self._loaded:
            return
        # Fail fast and clearly: the checkpoint's custom code authenticates the
        # gated Llama backbone from the environment, not from a forwarded token.
        require_hf_token()
        try:
            pipeline = self._loader(self.model_id, self.device)
        except Exception as exc:  # noqa: BLE001 - surface every load failure
            raise ModelLoadError(
                f"Could not load {self.model_id} on {self.device}: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        self._pipeline = pipeline
        self._loaded = True

    def suggest(
        self,
        clip: AudioClip,
        *,
        system_prompt: str | None = None,
        context: str = "",
        max_new_tokens: int | None = None,
        timeout_seconds: float = DEFAULT_INFERENCE_TIMEOUT_SECONDS,
    ) -> str:
        """Runs one audio -> text suggestion request.

        Returns the cleaned suggestion ("" when the model reports no speech).
        Raises :class:`InferenceTimeout` when the deadline passes and
        :class:`InferenceError` when the model output is unusable.
        """
        if not self._loaded or self._pipeline is None:
            raise InferenceError("The model is not loaded yet.")

        try:
            import numpy as np
        except ImportError as exc:  # pragma: no cover - image always ships numpy
            raise InferenceError("numpy is required for audio preprocessing.") from exc

        audio = np.frombuffer(clip.pcm, dtype=np.int16).astype(np.float32)
        audio = audio / np.float32(32768.0)
        inputs = {
            "audio": audio,
            "turns": build_turns(system_prompt or DEFAULT_SYSTEM_PROMPT, context=context),
            "sampling_rate": SAMPLE_RATE,
        }
        tokens = int(max_new_tokens or self.max_new_tokens)

        def run() -> Any:
            # temperature=None keeps generation greedy (deterministic).
            return self._pipeline(
                inputs,
                max_new_tokens=tokens,
                repetition_penalty=1.1,
                temperature=None,
            )

        # One GPU, one generation at a time. The lock plus the dedicated worker
        # means a timed-out request cannot overlap the next one on the GPU.
        with self._lock:
            try:
                output = call_with_deadline(
                    run, timeout_seconds, executor=self._executor
                )
            except InferenceTimeout:
                raise
            except Exception as exc:  # noqa: BLE001 - CUDA/OOM/processor errors
                raise InferenceError(
                    f"Ultravox inference failed: {type(exc).__name__}: {exc}"
                ) from exc

        return parse_suggestion(output)
