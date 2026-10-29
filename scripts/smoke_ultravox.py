#!/usr/bin/env python3
"""Smoke test for the deployed Ultravox v0.5 suggestion service.

Stdlib only. Sends one short WAV file to POST /v1/suggest and prints the
returned text suggestion. Never prints the service token.

Examples
--------
    # health only (cheap; starts a container if none is warm)
    python3 scripts/smoke_ultravox.py --url https://<app>.modal.run --health

    # real check with a recording
    export ULTRAVOX_SERVICE_TOKEN='<token>'
    python3 scripts/smoke_ultravox.py --url https://<app>.modal.run \
        --audio samples/customer-question.wav

    # wiring check with a generated tone (no speech: expect NO_SPEECH)
    python3 scripts/smoke_ultravox.py --url https://<app>.modal.run

Exit codes: 0 on a usable response, 1 on any error.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
import wave
from array import array

TOKEN_ENV = "ULTRAVOX_SERVICE_TOKEN"
DEFAULT_TIMEOUT = 120.0


def synthetic_wav(seconds: float = 1.2, rate: int = 16000) -> bytes:
    """A short, amplitude-modulated tone: proves the pipeline runs end to end.

    It contains no speech, so the model is expected to answer NO_SPEECH. Pass
    ``--audio`` with a real customer clip to check suggestion quality.
    """
    frames = array("h")
    total = int(seconds * rate)
    for index in range(total):
        t = index / rate
        envelope = 0.5 * (1.0 - math.cos(2.0 * math.pi * 3.0 * t))
        frames.append(int(9000 * envelope * math.sin(2.0 * math.pi * 220.0 * t)))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(frames.tobytes())
    return buffer.getvalue()


def read_audio(path: str | None) -> bytes:
    if not path:
        return synthetic_wav()
    with open(path, "rb") as handle:
        return handle.read()


def request(url: str, *, token: str | None, payload: dict | None) -> tuple[int, dict]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as response:
            body = response.read().decode("utf-8", "replace")
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, {"error": {"code": "HTTP_ERROR", "message": body[:300]}}
    except urllib.error.URLError as exc:
        return 0, {
            "error": {
                "code": "UNREACHABLE",
                "message": f"Could not reach {url}: {exc.reason}",
            }
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default=os.environ.get("ULTRAVOX_SERVICE_URL", ""),
        help="Base URL of the Modal app (or set ULTRAVOX_SERVICE_URL).",
    )
    parser.add_argument("--audio", help="Path to a short WAV file (16 kHz mono ideal).")
    parser.add_argument("--context", default="", help="Optional recent transcript.")
    parser.add_argument("--health", action="store_true", help="Only call /v1/health.")
    args = parser.parse_args(argv)

    if not args.url:
        print("error: --url or ULTRAVOX_SERVICE_URL is required", file=sys.stderr)
        return 1
    base = args.url.rstrip("/")

    token = os.environ.get(TOKEN_ENV, "").strip()

    if args.health:
        status, body = request(f"{base}/v1/health", token=None, payload=None)
        print(json.dumps({"status": status, "body": body}, indent=2))
        return 0 if status == 200 else 1

    if not token:
        print(
            f"error: {TOKEN_ENV} is not set in this shell. Export the same value "
            "stored in the Modal secret 'ultravox-service'.",
            file=sys.stderr,
        )
        return 1

    try:
        audio = read_audio(args.audio)
    except OSError as exc:
        print(f"error: cannot read audio: {exc}", file=sys.stderr)
        return 1
    if not audio:
        print("error: audio file is empty", file=sys.stderr)
        return 1

    print(
        f"POST {base}/v1/suggest  ({len(audio) / 1024:.1f} KiB audio, "
        f"{'file ' + args.audio if args.audio else 'synthetic tone'})",
        file=sys.stderr,
    )
    started = time.monotonic()
    status, body = request(
        f"{base}/v1/suggest",
        token=token,
        payload={
            "audioBase64": base64.b64encode(audio).decode("ascii"),
            "mimeType": "audio/wav",
            "context": args.context,
        },
    )
    elapsed = time.monotonic() - started

    if status != 200:
        print(json.dumps({"status": status, "body": body}, indent=2), file=sys.stderr)
        return 1

    print(json.dumps(body, indent=2))
    suggestion = (body.get("suggestion") or "").strip()
    print("\n--- suggestion ---", file=sys.stderr)
    if suggestion:
        print(suggestion, file=sys.stderr)
    else:
        print(
            f"(no suggestion: {body.get('emptyReason') or 'empty'}) "
            "-- expected for synthetic audio without speech.",
            file=sys.stderr,
        )
    print(
        f"wall={elapsed:.1f}s reported={body.get('latencyMs')}ms "
        f"model={body.get('model')}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
