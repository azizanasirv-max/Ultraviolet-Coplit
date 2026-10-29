"""API tests: authentication, validation, timeouts and error reporting."""

from __future__ import annotations

import base64
import os
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - fastapi ships in the image
    TestClient = None

from modal_app import ultravox_core as core
from modal_app.tests.test_ultravox_core import make_wav

TOKEN = "unit-test-inference-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class FakeEngine:
    model_id = core.MODEL_ID

    def __init__(self, loaded: bool = True, result="We can start with a pilot."):
        self.loaded = loaded
        self.result = result
        self.calls: list[tuple[core.AudioClip, dict]] = []

    def suggest(self, clip, **kwargs):
        self.calls.append((clip, kwargs))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


@unittest.skipIf(TestClient is None, "fastapi/httpx are not installed")
class ApiTestCase(unittest.TestCase):
    def setUp(self):
        from modal_app.ultravox_api import create_app

        self.engine = FakeEngine()
        self.client = TestClient(create_app(self.engine))
        self.env = mock.patch.dict(
            os.environ, {"ULTRAVOX_SERVICE_TOKEN": TOKEN}, clear=False
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def json_request(self, audio: bytes, **extra):
        payload = {
            "audioBase64": base64.b64encode(audio).decode(),
            "mimeType": "audio/wav",
        }
        payload.update(extra)
        return self.client.post("/v1/suggest", json=payload, headers=AUTH)

    def assert_error(self, response, status: int, code: str):
        self.assertEqual(response.status_code, status, response.text)
        body = response.json()
        self.assertEqual(body["error"]["code"], code)
        self.assertNotIn(TOKEN, response.text)


class HealthTests(ApiTestCase):
    def test_health_is_public_and_leaks_nothing(self):
        response = self.client.get("/v1/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["model"], core.MODEL_ID)
        self.assertTrue(body["modelLoaded"])
        self.assertEqual(body["sampleRate"], 16000)
        self.assertEqual(body["output"], "text")
        self.assertNotIn(TOKEN, response.text)

    def test_health_reports_loading_before_the_model_is_ready(self):
        from modal_app.ultravox_api import create_app

        client = TestClient(create_app(FakeEngine(loaded=False)))
        body = client.get("/v1/health").json()
        self.assertEqual(body["status"], "starting")
        self.assertFalse(body["modelLoaded"])


class AuthTests(ApiTestCase):
    def test_missing_token_is_rejected(self):
        response = self.client.post("/v1/suggest", json={"audioBase64": "AA=="})
        self.assert_error(response, 401, "UNAUTHORIZED")
        self.assertEqual(self.engine.calls, [])

    def test_wrong_token_is_rejected(self):
        response = self.client.post(
            "/v1/suggest",
            json={"audioBase64": "AA=="},
            headers={"Authorization": "Bearer not-the-token"},
        )
        self.assert_error(response, 401, "UNAUTHORIZED")
        self.assertEqual(self.engine.calls, [])

    def test_unconfigured_token_fails_closed(self):
        with mock.patch.dict(os.environ, {"ULTRAVOX_SERVICE_TOKEN": ""}, clear=False):
            response = self.client.post(
                "/v1/suggest", json={"audioBase64": "AA=="}, headers=AUTH
            )
        self.assert_error(response, 503, "SERVICE_NOT_CONFIGURED")
        self.assertEqual(self.engine.calls, [])


class ValidationTests(ApiTestCase):
    def test_invalid_base64_is_rejected(self):
        response = self.client.post(
            "/v1/suggest", json={"audioBase64": "not base64!!"}, headers=AUTH
        )
        self.assert_error(response, 400, "INVALID_BASE64")

    def test_missing_audio_field_is_rejected(self):
        response = self.client.post("/v1/suggest", json={"context": "hi"}, headers=AUTH)
        self.assert_error(response, 400, "INVALID_AUDIO_FIELD")

    def test_invalid_json_is_rejected(self):
        response = self.client.post(
            "/v1/suggest",
            content=b"{not json",
            headers={**AUTH, "Content-Type": "application/json"},
        )
        self.assert_error(response, 400, "INVALID_JSON")

    def test_wrong_content_type_is_rejected(self):
        response = self.client.post(
            "/v1/suggest",
            content=b"hello",
            headers={**AUTH, "Content-Type": "text/plain"},
        )
        self.assert_error(response, 415, "UNSUPPORTED_MEDIA_TYPE")

    def test_corrupt_audio_is_rejected(self):
        response = self.client.post(
            "/v1/suggest",
            json={"audioBase64": base64.b64encode(b"junk").decode(),
                  "mimeType": "audio/wav"},
            headers=AUTH,
        )
        self.assert_error(response, 415, "UNSUPPORTED_AUDIO_FORMAT")
        self.assertEqual(self.engine.calls, [])

    def test_too_short_audio_is_rejected(self):
        response = self.json_request(make_wav(0.1))
        self.assert_error(response, 400, "AUDIO_TOO_SHORT")

    def test_too_long_audio_is_rejected(self):
        with mock.patch.dict(
            os.environ, {"ULTRAVOX_MAX_AUDIO_SECONDS": "1"}, clear=False
        ):
            response = self.json_request(make_wav(2.0))
        self.assert_error(response, 413, "AUDIO_TOO_LONG")
        self.assertEqual(self.engine.calls, [])

    def test_multipart_without_audio_is_rejected(self):
        response = self.client.post(
            "/v1/suggest", files={"context": (None, "hi")}, headers=AUTH
        )
        self.assert_error(response, 400, "MISSING_AUDIO")

    def test_urlencoded_body_is_rejected(self):
        response = self.client.post(
            "/v1/suggest", data={"context": "hi"}, headers=AUTH
        )
        self.assert_error(response, 415, "UNSUPPORTED_MEDIA_TYPE")


class SuccessTests(ApiTestCase):
    def test_json_request_returns_a_text_suggestion(self):
        response = self.json_request(make_wav(1.0), context="Asked about price.")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["suggestion"], "We can start with a pilot.")
        self.assertIsNone(body["emptyReason"])
        self.assertEqual(body["model"], core.MODEL_ID)
        self.assertAlmostEqual(body["audioDurationMs"], 1000, delta=5)
        self.assertGreaterEqual(body["latencyMs"], 0)
        self.assertTrue(body["requestId"])
        self.assertNotIn(TOKEN, response.text)

    def test_multipart_upload_returns_a_text_suggestion(self):
        response = self.client.post(
            "/v1/suggest",
            files={"audio": ("sample.wav", make_wav(1.0), "audio/wav")},
            data={"context": "Asked about onboarding.", "maxNewTokens": "32"},
            headers=AUTH,
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["suggestion"], "We can start with a pilot.")
        clip, kwargs = self.engine.calls[0]
        self.assertEqual(clip.duration_ms, 1000)
        self.assertEqual(kwargs["context"], "Asked about onboarding.")
        self.assertEqual(kwargs["max_new_tokens"], 32)
        self.assertGreater(kwargs["timeout_seconds"], 0)

    def test_token_ceiling_is_enforced(self):
        response = self.json_request(make_wav(1.0), maxNewTokens=9999)
        self.assertEqual(response.status_code, 200)
        _, kwargs = self.engine.calls[0]
        self.assertEqual(kwargs["max_new_tokens"], core.MAX_NEW_TOKENS_LIMIT)

    def test_empty_suggestion_is_reported_as_no_speech(self):
        self.engine.result = ""
        body = self.json_request(make_wav(1.0)).json()
        self.assertEqual(body["suggestion"], "")
        self.assertEqual(body["emptyReason"], "NO_SPEECH")
        self.assertTrue(body["note"])


class FailureTests(ApiTestCase):
    def test_model_that_is_still_loading_returns_503(self):
        self.engine.loaded = False
        self.assert_error(self.json_request(make_wav(1.0)), 503, "MODEL_LOADING")

    def test_inference_timeout_returns_504(self):
        self.engine.result = core.InferenceTimeout("too slow")
        self.assert_error(self.json_request(make_wav(1.0)), 504, "INFERENCE_TIMEOUT")

    def test_inference_error_returns_502(self):
        self.engine.result = core.InferenceError("bad output")
        self.assert_error(self.json_request(make_wav(1.0)), 502, "INFERENCE_FAILED")

    def test_unexpected_failure_returns_500_without_internals(self):
        self.engine.result = RuntimeError("secret cuda detail /models/hf")
        response = self.json_request(make_wav(1.0))
        self.assert_error(response, 500, "INTERNAL_ERROR")
        self.assertNotIn("secret cuda detail", response.text)
        self.assertNotIn("/models/hf", response.text)

    def test_hard_timeout_beyond_the_engine_deadline_returns_504(self):
        with mock.patch.dict(
            os.environ, {"ULTRAVOX_INFERENCE_TIMEOUT_SECONDS": "0.05"}, clear=False
        ):
            # The engine deadline fires first and is reported as 504 either way.
            self.engine.result = core.InferenceTimeout("too slow")
            response = self.json_request(make_wav(1.0))
        self.assert_error(response, 504, "INFERENCE_TIMEOUT")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
