"""Short-lived call tokens for the self-hosted AI service.

The application server holds `AI_CALL_SECRET` and never sends it to a browser.
Creating a call returns a `wss://` join URL whose query string carries the call
id, an expiry and an HMAC of both. The browser can use that URL only until it
expires, which bounds GPU spend if a URL leaks.

Stdlib only: unit-testable without Modal or a GPU.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from urllib.parse import urlencode

TOKEN_PARAM_CALL_ID = "call_id"
TOKEN_PARAM_EXPIRES = "exp"
TOKEN_PARAM_SIGNATURE = "sig"

DEFAULT_TTL_SECONDS = 3900


def _payload(call_id: str, expires_at_ms: int) -> bytes:
    return f"{call_id}.{expires_at_ms}".encode("utf-8")


def sign_call(call_id: str, expires_at_ms: int, secret: str) -> str:
    """HMAC-SHA256 over the call id and expiry, hex encoded."""
    if not call_id or not secret:
        raise ValueError("call_id and secret are required")
    return hmac.new(secret.encode("utf-8"), _payload(call_id, expires_at_ms), hashlib.sha256).hexdigest()


def verify_call(
    call_id: str,
    expires_at_ms: int,
    signature: str,
    secret: str,
    *,
    now_ms: int | None = None,
) -> bool:
    """Constant-time signature check plus expiry check."""
    if not call_id or not signature or not secret:
        return False
    expected = sign_call(call_id, expires_at_ms, secret)
    if not hmac.compare_digest(expected, signature):
        return False
    current = int(time.time() * 1000) if now_ms is None else int(now_ms)
    return expires_at_ms > current


def build_join_url(base_url: str, call_id: str, expires_at_ms: int, secret: str) -> str:
    """Builds the browser-facing WebSocket URL for one call."""
    base = (base_url or "").rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    elif not base.startswith(("wss://", "ws://")):
        raise ValueError("base_url must be an absolute http(s) URL")
    query = urlencode(
        {
            TOKEN_PARAM_CALL_ID: call_id,
            TOKEN_PARAM_EXPIRES: str(expires_at_ms),
            TOKEN_PARAM_SIGNATURE: sign_call(call_id, expires_at_ms, secret),
        }
    )
    return f"{base}/v1/stream?{query}"
