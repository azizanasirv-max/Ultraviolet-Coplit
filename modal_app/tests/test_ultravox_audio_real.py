"""End-to-end audio path with a real ffmpeg binary.

Skipped automatically when `ffmpeg` is not on PATH (as in the default dev
sandbox). In the Modal image `apt_install("ffmpeg")` provides it, so these are
the checks that mirror production container behaviour.
"""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - fastapi ships in the image
    TestClient = None

from modal_app import ultravox_core as core
from modal_app.tests.test_ultravox_core import extensible_wav

FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = unittest.skipUnless(FFMPEG, "ffmpeg is not installed")


def encode_webm(path: str, *, seconds: float = 1.0, rate: int = 48000, channels: int = 1) -> bytes:
    """Writes a MediaRecorder-style WebM/Opus clip and returns its bytes."""
    subprocess.run(  # noqa: S603 - fixed argv
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=300:duration={seconds}",
            "-ac",
            str(channels),
            "-ar",
            str(rate),
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            path,
        ],
        check=True,
    )
    with open(path, "rb") as handle:
        return handle.read()


@requires_ffmpeg
class RealFfmpegAudioTests(unittest.TestCase):
    def test_browser_webm_opus_becomes_16k_mono(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = encode_webm(os.path.join(tmp, "browser.webm"), seconds=1.0)
        # EBML magic: this is a real WebM container, not a synthetic header.
        self.assertEqual(data[:4], b"\x1aE\xdf\xa3")
        self.assertFalse(core.looks_like_wav(data))

        clip = core.decode_audio(data, content_type="audio/webm")

        self.assertEqual(clip.source_format, "ffmpeg")
        self.assertEqual(clip.source_rate, 16000)
        self.assertEqual(clip.source_channels, 1)
        self.assertAlmostEqual(clip.duration_ms, 1000, delta=60)
        self.assertAlmostEqual(clip.samples, 16000, delta=1000)

    def test_stereo_webm_is_downmixed_to_mono(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = encode_webm(
                os.path.join(tmp, "stereo.webm"), seconds=1.0, channels=2
            )
        clip = core.decode_audio(data, content_type="video/webm")
        self.assertEqual(clip.source_rate, 16000)
        self.assertAlmostEqual(clip.samples, 16000, delta=1000)

    def test_extensible_wav_is_decoded_by_ffmpeg(self):
        clip = core.decode_audio(extensible_wav(1.0), content_type="audio/wav")
        self.assertEqual(clip.source_format, "ffmpeg")
        self.assertEqual(clip.samples, 16000)

    @unittest.skipIf(TestClient is None, "fastapi/httpx are not installed")
    def test_api_accepts_a_real_webm_upload(self):
        from modal_app.ultravox_api import create_app

        env_token = "unit-test-inference-token"
        env = mock.patch.dict(
            os.environ, {"ULTRAVOX_SERVICE_TOKEN": env_token}, clear=False
        )
        env.start()
        self.addCleanup(env.stop)

        class Engine:
            model_id = core.MODEL_ID
            loaded = True
            calls: list = []

            def suggest(self, clip, **kwargs):
                self.calls.append(clip)
                return "Sounds good - shall we book a demo?"

        engine = Engine()
        client = TestClient(create_app(engine))
        with tempfile.TemporaryDirectory() as tmp:
            data = encode_webm(os.path.join(tmp, "browser.webm"), seconds=1.0)

        response = client.post(
            "/v1/suggest",
            files={"audio": ("recording.webm", data, "audio/webm")},
            data={"context": "Customer asked about pricing."},
            headers={"Authorization": f"Bearer {env_token}"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["suggestion"], "Sounds good - shall we book a demo?"
        )
        clip = engine.calls[0]
        self.assertEqual(clip.source_rate, 16000)
        self.assertEqual(clip.source_channels, 1)
        self.assertEqual(clip.source_format, "ffmpeg")

    @unittest.skipIf(TestClient is None, "fastapi/httpx are not installed")
    def test_api_accepts_base64_webm(self):
        from modal_app.ultravox_api import create_app

        env_token = "unit-test-inference-token"
        env = mock.patch.dict(
            os.environ, {"ULTRAVOX_SERVICE_TOKEN": env_token}, clear=False
        )
        env.start()
        self.addCleanup(env.stop)

        class Engine:
            model_id = core.MODEL_ID
            loaded = True

            def suggest(self, clip, **kwargs):
                return "ok"

        client = TestClient(create_app(Engine()))
        with tempfile.TemporaryDirectory() as tmp:
            data = encode_webm(os.path.join(tmp, "b.webm"), seconds=0.5)
        response = client.post(
            "/v1/suggest",
            json={
                "audioBase64": base64.b64encode(data).decode(),
                "mimeType": "audio/webm",
            },
            headers={"Authorization": f"Bearer {env_token}"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["suggestion"], "ok")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
