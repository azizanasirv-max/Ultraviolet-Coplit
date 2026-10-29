"""Token tests for the Modal AI service (stdlib only, no GPU)."""

import time
import unittest
from urllib.parse import parse_qs, urlparse

from modal_app.tokens import (
    TOKEN_PARAM_CALL_ID,
    TOKEN_PARAM_EXPIRES,
    TOKEN_PARAM_SIGNATURE,
    build_join_url,
    sign_call,
    verify_call,
)

SECRET = "unit-test-secret"


class SigningTests(unittest.TestCase):
    def test_round_trip(self):
        expires = int(time.time() * 1000) + 60_000
        signature = sign_call("abc123", expires, SECRET)
        self.assertTrue(verify_call("abc123", expires, signature, SECRET))

    def test_rejects_a_tampered_call_id(self):
        expires = int(time.time() * 1000) + 60_000
        signature = sign_call("abc123", expires, SECRET)
        self.assertFalse(verify_call("abc124", expires, signature, SECRET))

    def test_rejects_a_tampered_expiry(self):
        expires = int(time.time() * 1000) + 60_000
        signature = sign_call("abc123", expires, SECRET)
        self.assertFalse(verify_call("abc123", expires + 1000, signature, SECRET))

    def test_rejects_another_secret(self):
        expires = int(time.time() * 1000) + 60_000
        signature = sign_call("abc123", expires, SECRET)
        self.assertFalse(verify_call("abc123", expires, signature, "other-secret"))

    def test_rejects_expired_tokens(self):
        now = int(time.time() * 1000)
        expires = now - 1
        signature = sign_call("abc123", expires, SECRET)
        self.assertFalse(verify_call("abc123", expires, signature, SECRET, now_ms=now))

    def test_rejects_empty_inputs(self):
        self.assertFalse(verify_call("", 0, "", SECRET))
        self.assertFalse(verify_call("abc", 0, "sig", ""))
        with self.assertRaises(ValueError):
            sign_call("", 1, SECRET)


class JoinUrlTests(unittest.TestCase):
    def test_https_becomes_wss(self):
        expires = int(time.time() * 1000) + 60_000
        url = build_join_url("https://example--app.modal.run", "call1", expires, SECRET)
        parsed = urlparse(url)
        self.assertEqual(parsed.scheme, "wss")
        self.assertEqual(parsed.netloc, "example--app.modal.run")
        self.assertEqual(parsed.path, "/v1/stream")
        query = parse_qs(parsed.query)
        self.assertEqual(query[TOKEN_PARAM_CALL_ID], ["call1"])
        self.assertEqual(query[TOKEN_PARAM_EXPIRES], [str(expires)])
        self.assertTrue(
            verify_call("call1", expires, query[TOKEN_PARAM_SIGNATURE][0], SECRET)
        )

    def test_trailing_slash_is_normalised(self):
        expires = int(time.time() * 1000) + 60_000
        url = build_join_url("https://example--app.modal.run/", "call1", expires, SECRET)
        self.assertTrue(url.startswith("wss://example--app.modal.run/v1/stream?"))

    def test_relative_base_is_rejected(self):
        with self.assertRaises(ValueError):
            build_join_url("/v1", "call1", 1, SECRET)


if __name__ == "__main__":
    unittest.main()
