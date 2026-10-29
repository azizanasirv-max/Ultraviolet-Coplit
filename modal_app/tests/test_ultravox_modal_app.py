"""Deployment-file tests: the Modal app must build and stay conservative."""

from __future__ import annotations

import unittest

try:
    import modal
except ImportError:  # pragma: no cover - the Modal CLI is a deploy-time tool
    modal = None

from modal_app import ultravox_core as core


@unittest.skipIf(modal is None, "modal is not installed")
class ModalAppTests(unittest.TestCase):
    def setUp(self):
        import modal_app.ultravox_app as module

        self.module = module

    def test_model_id_matches_the_requested_checkpoint(self):
        self.assertEqual(
            self.module.MODEL_ID, "fixie-ai/ultravox-v0_5-llama-3_1-8b"
        )
        self.assertEqual(self.module.MODEL_ID, core.MODEL_ID)

    def test_a100_40gb_is_preferred(self):
        self.assertEqual(self.module.GPU_TYPES[0], "A100-40GB")
        self.assertIn("L40S", self.module.GPU_TYPES)

    def test_scaling_is_conservative(self):
        import pathlib

        self.assertEqual(self.module.MAX_CONTAINERS, 1)
        self.assertGreaterEqual(self.module.SCALEDOWN_WINDOW, 30)
        self.assertLessEqual(self.module.SCALEDOWN_WINDOW, 900)
        source = pathlib.Path(self.module.__file__).read_text(encoding="utf-8")
        # No always-warm GPU on the $30 credit.
        self.assertIn("min_containers=0", source)

    def test_no_whisper_or_qwen_pipeline_is_referenced(self):
        import pathlib

        source = pathlib.Path(self.module.__file__).read_text(encoding="utf-8")
        for forbidden in ("faster_whisper", "WhisperModel", "Qwen", "ASR_MODEL"):
            self.assertNotIn(forbidden, source)

    def test_service_exposes_health_and_inference_routes(self):
        from modal_app.ultravox_api import create_app

        class Engine:
            model_id = core.MODEL_ID
            loaded = True

        paths = [route.path for route in create_app(Engine()).routes]
        self.assertIn("/v1/health", paths)
        self.assertIn("/v1/suggest", paths)

    def test_secrets_are_named_and_not_inlined(self):
        import pathlib
        import re

        source = pathlib.Path(self.module.__file__).read_text(encoding="utf-8")
        self.assertIn("ULTRAVOX_SERVICE_TOKEN", source)
        self.assertIn("HF_TOKEN", source)
        # No literal credential values are baked into the deployment file.
        self.assertIsNone(re.search(r"hf_[A-Za-z0-9]{20,}", source))
        self.assertIn('Secret.from_name(', source)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
