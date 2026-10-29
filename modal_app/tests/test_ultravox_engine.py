"""Tests for the Ultravox engine: loading, input contract, parsing, timeout."""

from __future__ import annotations

import os
import time
import unittest
from unittest import mock

from modal_app import ultravox_core as core
from modal_app.tests.test_ultravox_core import make_wav
from modal_app.ultravox_engine import ModelLoadError, UltravoxEngine

try:
    import numpy as np
except ImportError:  # pragma: no cover - numpy ships in the image
    np = None


class FakePipeline:
    """Stands in for the transformers custom pipeline."""

    def __init__(self, output="Happy to walk you through the pricing."):
        self.output = output
        self.calls: list[tuple[dict, dict]] = []

    def __call__(self, inputs, **kwargs):
        self.calls.append((inputs, kwargs))
        if isinstance(self.output, BaseException):
            raise self.output
        return self.output


class LoaderSpy:
    def __init__(self, pipeline_factory=FakePipeline, error: Exception | None = None):
        self.calls: list[tuple[str, str]] = []
        self._factory = pipeline_factory
        self._error = error

    def __call__(self, model_id: str, device: str):
        self.calls.append((model_id, device))
        if self._error is not None:
            raise self._error
        return self._factory()


class LoadingTests(unittest.TestCase):
    def setUp(self):
        # The gated Llama backbone needs HF_TOKEN in the environment.
        env = mock.patch.dict(os.environ, {"HF_TOKEN": "hf_unit_test"}, clear=False)
        env.start()
        self.addCleanup(env.stop)

    def test_load_uses_the_model_card_id_and_device(self):
        loader = LoaderSpy()
        engine = UltravoxEngine(loader=loader)
        self.assertFalse(engine.loaded)

        engine.load()

        self.assertTrue(engine.loaded)
        self.assertEqual(loader.calls, [(core.MODEL_ID, "cuda")])

    def test_load_is_idempotent(self):
        loader = LoaderSpy()
        engine = UltravoxEngine(loader=loader)
        engine.load()
        engine.load()
        self.assertEqual(len(loader.calls), 1)

    def test_device_can_be_overridden(self):
        loader = LoaderSpy()
        UltravoxEngine(loader=loader, device="cpu").load()
        self.assertEqual(loader.calls[0][1], "cpu")

    def test_load_failure_is_reported_with_context(self):
        loader = LoaderSpy(error=OSError("401 gated repo"))
        engine = UltravoxEngine(loader=loader)
        with self.assertRaises(ModelLoadError) as ctx:
            engine.load()
        message = str(ctx.exception)
        self.assertIn(core.MODEL_ID, message)
        self.assertIn("OSError", message)
        self.assertIn("gated repo", message)
        self.assertFalse(engine.loaded)

    def test_load_fails_fast_without_hf_token(self):
        loader = LoaderSpy()
        engine = UltravoxEngine(loader=loader)
        with mock.patch.dict(
            os.environ,
            {"HF_TOKEN": "", "HUGGING_FACE_HUB_TOKEN": ""},
            clear=False,
        ):
            with self.assertRaises(core.ServiceError) as ctx:
                engine.load()
        self.assertEqual(ctx.exception.code, "HF_TOKEN_MISSING")
        self.assertIn("Llama-3.1", ctx.exception.message)
        self.assertEqual(loader.calls, [])
        self.assertFalse(engine.loaded)

    def test_default_loader_is_used_when_none_is_injected(self):
        engine = UltravoxEngine()
        self.assertEqual(engine._loader.__name__, "default_loader")


class SuggestTests(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, {"HF_TOKEN": "hf_unit_test"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        self.clip = core.decode_wav(make_wav(1.0))
        self.pipeline = FakePipeline()
        self.engine = UltravoxEngine(loader=LoaderSpy(lambda: self.pipeline))
        self.engine.load()

    @unittest.skipIf(np is None, "numpy is not installed")
    def test_inputs_follow_the_documented_audio_plus_turns_format(self):
        suggestion = self.engine.suggest(self.clip)

        self.assertEqual(suggestion, "Happy to walk you through the pricing.")
        self.assertEqual(len(self.pipeline.calls), 1)
        inputs, kwargs = self.pipeline.calls[0]

        self.assertEqual(set(inputs), {"audio", "turns", "sampling_rate"})
        self.assertEqual(inputs["sampling_rate"], 16000)

        audio = inputs["audio"]
        self.assertEqual(audio.dtype, np.float32)
        self.assertEqual(audio.ndim, 1)
        self.assertEqual(audio.shape[0], self.clip.samples)
        self.assertLessEqual(float(np.max(np.abs(audio))), 1.0)

        turns = inputs["turns"]
        self.assertEqual(turns[0]["role"], "system")
        self.assertIn("sales", turns[0]["content"].lower())
        self.assertEqual(turns[-1], {"role": "user", "content": "<|audio|>"})

        self.assertEqual(kwargs["max_new_tokens"], core.DEFAULT_MAX_NEW_TOKENS)
        self.assertEqual(kwargs["repetition_penalty"], 1.1)
        self.assertIsNone(kwargs["temperature"])

    @unittest.skipIf(np is None, "numpy is not installed")
    def test_prompt_context_and_token_overrides_are_forwarded(self):
        self.engine.suggest(
            self.clip,
            system_prompt="Answer like a CFO.",
            context="Customer asked about onboarding.",
            max_new_tokens=24,
        )
        inputs, kwargs = self.pipeline.calls[0]
        self.assertIn("Answer like a CFO.", inputs["turns"][0]["content"])
        self.assertIn("Customer asked about onboarding.", inputs["turns"][1]["content"])
        self.assertEqual(kwargs["max_new_tokens"], 24)

    def test_output_is_cleaned(self):
        pipeline = FakePipeline('  Suggestion: **"We can start Monday."**')
        engine = UltravoxEngine(loader=LoaderSpy(lambda: pipeline))
        engine.load()
        self.assertEqual(engine.suggest(self.clip), "We can start Monday.")

    def test_no_speech_output_becomes_empty_string(self):
        pipeline = FakePipeline("NO_SPEECH")
        engine = UltravoxEngine(loader=LoaderSpy(lambda: pipeline))
        engine.load()
        self.assertEqual(engine.suggest(self.clip), "")

    def test_unexpected_model_output_raises_inference_error(self):
        pipeline = FakePipeline(None)
        engine = UltravoxEngine(loader=LoaderSpy(lambda: pipeline))
        engine.load()
        with self.assertRaises(core.InferenceError):
            engine.suggest(self.clip)

    def test_model_exceptions_are_wrapped(self):
        pipeline = FakePipeline(RuntimeError("CUDA out of memory"))
        engine = UltravoxEngine(loader=LoaderSpy(lambda: pipeline))
        engine.load()
        with self.assertRaises(core.InferenceError) as ctx:
            engine.suggest(self.clip)
        self.assertIn("CUDA out of memory", str(ctx.exception))

    def test_slow_generation_raises_inference_timeout(self):
        def slow_pipeline(inputs, **kwargs):
            time.sleep(0.3)
            return "late"

        engine = UltravoxEngine(loader=LoaderSpy(lambda: slow_pipeline))
        engine.load()
        with self.assertRaises(core.InferenceTimeout):
            engine.suggest(self.clip, timeout_seconds=0.05)

    def test_suggest_before_load_fails_cleanly(self):
        engine = UltravoxEngine(loader=LoaderSpy())
        with self.assertRaises(core.InferenceError):
            engine.suggest(self.clip)

    def test_gpu_work_stays_serialised_after_a_timeout(self):
        state = {"active": 0, "peak": 0, "runs": 0}

        def slow_pipeline(inputs, **kwargs):
            state["active"] += 1
            state["runs"] += 1
            state["peak"] = max(state["peak"], state["active"])
            try:
                time.sleep(0.15)
                return "done"
            finally:
                state["active"] -= 1

        engine = UltravoxEngine(loader=LoaderSpy(lambda: slow_pipeline))
        engine.load()

        with self.assertRaises(core.InferenceTimeout):
            engine.suggest(self.clip, timeout_seconds=0.02)

        # The abandoned generation still owns the single worker; this call waits
        # for it instead of starting a second one on the same GPU.
        self.assertEqual(engine.suggest(self.clip, timeout_seconds=2.0), "done")
        self.assertEqual(state["peak"], 1)
        self.assertEqual(state["runs"], 2)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
