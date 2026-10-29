"""Framework-free rules for the Ultravox v0.5 suggestion service.

Deliberately free of Modal, FastAPI, numpy and torch so the audio validation,
resampling, prompt/turns construction, output cleaning, authentication and
timeout rules can be unit tested with a plain ``python3`` (no GPU, no Modal
account, no Hugging Face token).

Audio contract: WAV (PCM) is decoded with the standard library; anything else
is transcoded with ``ffmpeg`` and the result is always 16 kHz mono signed
16-bit little-endian PCM, which is what the Ultravox processor expects.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import io
import re
import subprocess
import wave
from array import array
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Any, Callable, Sequence

# --- Model -----------------------------------------------------------------

MODEL_ID = "fixie-ai/ultravox-v0_5-llama-3_1-8b"

#: The only sampling rate the Ultravox processor accepts without resampling.
SAMPLE_RATE = 16000

#: Audio placeholder the Ultravox processor replaces with audio embeddings.
AUDIO_PLACEHOLDER = "<|audio|>"

# --- Service limits (all overridable at deploy time via the environment) ----

DEFAULT_MAX_AUDIO_SECONDS = 60
MAX_AUDIO_SECONDS_LIMIT = 120
DEFAULT_MIN_AUDIO_SECONDS = 0.25
DEFAULT_MAX_AUDIO_BYTES = 12 * 1024 * 1024
DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_NEW_TOKENS = 64
MAX_NEW_TOKENS_LIMIT = 160
DEFAULT_INFERENCE_TIMEOUT_SECONDS = 25.0
MAX_INFERENCE_TIMEOUT_SECONDS = 60.0
MAX_CONTEXT_CHARS = 2000
MAX_SUGGESTION_CHARS = 280

# --- Prompting -------------------------------------------------------------

DEFAULT_SYSTEM_PROMPT = (
    "You are an AI sales copilot listening live to a sales call. "
    "You hear the customer through the attached audio. "
    "Your job is to give the salesperson their next line: one short, "
    "relevant, ready-to-speak suggestion that responds directly to what the "
    "customer just said. Be specific, natural and conversational, and prefer "
    "a concrete answer or one useful qualifying question over generic filler."
)

SUGGESTION_RULES = (
    "Rules: reply with text only. Never produce or describe audio, and never "
    "speak or role-play both sides. Output exactly one suggestion of at most "
    "two short sentences (about 25 words) that the salesperson can read aloud "
    "verbatim. No preamble, no labels such as 'Suggestion:', no quotation "
    "marks, no bullet points, no markdown, no repetition of the customer's "
    "words, no explanation of your reasoning. If the audio contains no "
    "intelligible customer speech, reply with exactly: NO_SPEECH"
)

NO_SPEECH_MARKER = "NO_SPEECH"

REFUSAL_MARKERS = (
    "as an ai",
    "i'm sorry, but i can't",
    "i cannot assist",
    "i can't help with that",
    "i am unable to",
)

WAV_CONTENT_TYPES = frozenset(
    {"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"}
)

#: Audio containers we are willing to hand to ffmpeg, e.g. browser recordings.
FFMPEG_CONTENT_TYPES = frozenset(
    {
        "audio/webm",
        "audio/ogg",
        "audio/mp4",
        "audio/mpeg",
        "audio/mp3",
        "audio/aac",
        "audio/flac",
        "audio/x-m4a",
        "audio/m4a",
        "audio/opus",
        "audio/3gpp",
        "video/webm",
        "video/mp4",
    }
)


# --- Errors ----------------------------------------------------------------


class ServiceError(Exception):
    """An error that maps to a specific HTTP status and stable error code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = str(code)
        self.message = str(message)

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class InferenceTimeout(Exception):
    """Raised when model work does not finish inside the request budget."""


class InferenceError(Exception):
    """Raised when the model returns something unusable."""



# --- Audio -----------------------------------------------------------------


@dataclass(frozen=True)
class AudioClip:
    """Audio normalised to what Ultravox expects."""

    #: 16 kHz, mono, signed 16-bit little-endian PCM.
    pcm: bytes
    duration_ms: int
    source_rate: int
    source_channels: int
    source_format: str

    @property
    def samples(self) -> int:
        return len(self.pcm) // 2

    @property
    def duration_seconds(self) -> float:
        return self.duration_ms / 1000.0


def looks_like_wav(data: bytes) -> bool:
    """True for a RIFF/WAVE container (checked before decoding)."""
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _normalise_content_type(content_type: str) -> str:
    return (content_type or "").split(";", 1)[0].strip().lower()


def validate_audio_bytes(
    data: bytes,
    *,
    max_bytes: int = DEFAULT_MAX_AUDIO_BYTES,
    content_type: str = "",
) -> None:
    """Rejects obviously unusable uploads before any decoding work happens."""
    if not data:
        raise ServiceError(400, "EMPTY_AUDIO", "The request contained no audio.")
    if len(data) > max_bytes:
        raise ServiceError(
            413,
            "AUDIO_TOO_LARGE",
            f"Audio payload exceeds the {max_bytes // (1024 * 1024)} MiB limit.",
        )

    declared = _normalise_content_type(content_type)
    if not declared or declared == "application/octet-stream":
        return
    if declared.startswith("multipart/"):
        # The multipart part carries its own content type; the decoded part is
        # validated separately.
        return
    allowed = WAV_CONTENT_TYPES | FFMPEG_CONTENT_TYPES
    if declared not in allowed:
        raise ServiceError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Send an audio/wav (PCM) file, or another audio container ffmpeg "
            "can decode.",
        )


def _clamp_duration(duration_seconds: float, *, max_seconds: int) -> int:
    if duration_seconds < DEFAULT_MIN_AUDIO_SECONDS:
        raise ServiceError(
            400,
            "AUDIO_TOO_SHORT",
            f"Audio must be at least {DEFAULT_MIN_AUDIO_SECONDS:.2f} seconds.",
        )
    if duration_seconds > max_seconds:
        raise ServiceError(
            413,
            "AUDIO_TOO_LONG",
            f"Audio must be at most {max_seconds} seconds.",
        )
    return int(round(duration_seconds * 1000))


def _downmix_and_resample(
    frames: bytes, *, width: int, channels: int, rate: int
) -> bytes:
    """Converts PCM input to 16 kHz mono PCM16.

    ``audioop`` is a stdlib C extension, so this is fast and dependency free.
    It was removed in Python 3.13, so the image pins Python 3.11; a pure-python
    fallback keeps the module importable (and testable) elsewhere.
    """
    try:
        import audioop  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover - Python >= 3.13
        return _downmix_and_resample_python(
            frames, width=width, channels=channels, rate=rate
        )

    if width != 2:
        frames = audioop.lin2lin(frames, width, 2)
    if channels > 1:
        # 0.5/0.5 averages the channels instead of summing them (no clipping).
        frames = audioop.tomono(frames, 2, 0.5, 0.5)
    if rate != SAMPLE_RATE:
        frames, _ = audioop.ratecv(frames, 2, 1, rate, SAMPLE_RATE, None)
    return frames


def _downmix_and_resample_python(  # pragma: no cover - fallback path
    frames: bytes, *, width: int, channels: int, rate: int
) -> bytes:
    if width != 2:
        raise ServiceError(
            415, "UNSUPPORTED_AUDIO_FORMAT", "Only 16-bit PCM WAV is supported."
        )
    usable = len(frames) - (len(frames) % (2 * channels))
    samples = array("h")
    samples.frombytes(frames[:usable])
    if channels == 1:
        mono = list(samples)
    else:
        mono = [
            int(sum(samples[i : i + channels]) / channels)
            for i in range(0, len(samples), channels)
        ]
    if rate == SAMPLE_RATE:
        return array("h", mono).tobytes()
    ratio = SAMPLE_RATE / float(rate)
    out_len = int(len(mono) * ratio)
    out = array("h")
    for index in range(out_len):
        position = index / ratio
        before = int(position)
        after = min(before + 1, len(mono) - 1)
        frac = position - before
        out.append(int(mono[before] * (1.0 - frac) + mono[after] * frac))
    return out.tobytes()


def decode_wav(
    data: bytes, *, max_seconds: int = DEFAULT_MAX_AUDIO_SECONDS
) -> AudioClip:
    """Decodes a PCM WAV file and normalises it to 16 kHz mono PCM16."""
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as exc:
        raise ServiceError(
            415,
            "UNSUPPORTED_AUDIO_FORMAT",
            "Audio is not a readable PCM WAV file.",
        ) from exc

    if channels < 1 or channels > 2:
        raise ServiceError(
            415,
            "UNSUPPORTED_AUDIO_FORMAT",
            f"WAV must be mono or stereo, got {channels} channels.",
        )
    if width not in (1, 2, 3, 4):
        raise ServiceError(
            415, "UNSUPPORTED_AUDIO_FORMAT", f"Unsupported WAV sample width {width}."
        )
    if rate < 8000 or rate > 192000:
        raise ServiceError(
            415, "UNSUPPORTED_AUDIO_FORMAT", f"Unsupported WAV sample rate {rate}."
        )
    if not frames:
        raise ServiceError(400, "EMPTY_AUDIO", "The WAV file contains no samples.")

    duration_seconds = len(frames) / float(width * channels * rate)
    duration_ms = _clamp_duration(duration_seconds, max_seconds=max_seconds)
    pcm = _downmix_and_resample(frames, width=width, channels=channels, rate=rate)
    return AudioClip(
        pcm=pcm,
        duration_ms=duration_ms,
        source_rate=rate,
        source_channels=channels,
        source_format="wav",
    )


def _run_ffmpeg(args: Sequence[str], data: bytes) -> bytes:
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            list(args),
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ServiceError(
            415,
            "UNSUPPORTED_AUDIO_FORMAT",
            "This service can only decode WAV audio (ffmpeg is unavailable).",
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ServiceError(
            413, "AUDIO_DECODE_TIMEOUT", "Audio decoding took too long."
        ) from exc
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ServiceError(
            415,
            "UNSUPPORTED_AUDIO_FORMAT",
            "Audio could not be decoded"
            + (f": {detail[-1][:200]}" if detail else "."),
        )
    return completed.stdout


def transcode_with_ffmpeg(
    data: bytes,
    *,
    max_seconds: int = DEFAULT_MAX_AUDIO_SECONDS,
    runner: Callable[[Sequence[str], bytes], bytes] | None = None,
) -> AudioClip:
    """Decodes webm/ogg/mp3/... to 16 kHz mono PCM16 via ffmpeg."""
    args = (
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-t",
        str(max_seconds + 1),
        "-vn",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "pipe:1",
    )
    pcm = (runner or _run_ffmpeg)(args, data)
    if not pcm:
        raise ServiceError(
            400, "EMPTY_AUDIO", "The audio contained no decodable samples."
        )
    # s16le @ 16 kHz mono => 32000 bytes per second.
    duration_seconds = len(pcm) / float(SAMPLE_RATE * 2)
    duration_ms = _clamp_duration(duration_seconds, max_seconds=max_seconds)
    return AudioClip(
        pcm=pcm,
        duration_ms=duration_ms,
        source_rate=SAMPLE_RATE,
        source_channels=1,
        source_format="ffmpeg",
    )


# --- Prompt / turns --------------------------------------------------------


def normalise_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def build_turns(
    system_prompt: str | None = None,
    *,
    context: str = "",
) -> list[dict[str, str]]:
    """Builds the model card's ``turns`` input (a list of chat turns).

    The final user turn carries the ``<|audio|>`` placeholder, exactly as the
    official Ultravox usage example does; the processor swaps it for audio
    embeddings. Any recent conversation text is passed as a separate user turn
    so the model's answer stays anchored to what the customer just said.
    """
    system = normalise_space(system_prompt) or DEFAULT_SYSTEM_PROMPT
    turns: list[dict[str, str]] = [
        {"role": "system", "content": f"{system}\n\n{SUGGESTION_RULES}"}
    ]
    recent = normalise_space(context)[:MAX_CONTEXT_CHARS]
    if recent:
        turns.append({"role": "user", "content": f"Recent conversation: {recent}"})
    turns.append({"role": "user", "content": AUDIO_PLACEHOLDER})
    return turns


# --- Output ----------------------------------------------------------------

_LEADING_LABEL = re.compile(
    r"^\s*(?:assistant|suggestion|response|salesperson|copilot|customer)\s*:\s*",
    re.IGNORECASE,
)


def parse_suggestion(text: Any, *, max_chars: int = MAX_SUGGESTION_CHARS) -> str:
    """Normalises model output into one short, ready-to-speak suggestion.

    Returns an empty string when the model produced nothing usable (empty, a
    refusal, or the explicit no-speech marker). Anything that is not a string
    is rejected with :class:`InferenceError`.
    """
    if text is None:
        raise InferenceError("The model returned no output.")
    if not isinstance(text, str):
        raise InferenceError(
            f"The model returned an unexpected {type(text).__name__} instead of text."
        )

    cleaned = text.strip()
    if not cleaned:
        return ""
    if NO_SPEECH_MARKER in cleaned.upper()[:40]:
        return ""

    cleaned = _LEADING_LABEL.sub("", cleaned)
    cleaned = cleaned.split("\n\n")[0]
    cleaned = re.sub(
        r"^\s*(?:[-*\u2022]|\d+[.)])\s+", "", cleaned, flags=re.MULTILINE
    )
    cleaned = cleaned.replace("**", "").replace("__", "")
    cleaned = cleaned.strip().strip('"').strip("'").strip()
    cleaned = normalise_space(cleaned)
    if not cleaned:
        return ""

    if any(marker in cleaned.lower()[:60] for marker in REFUSAL_MARKERS):
        return ""

    if len(cleaned) > max_chars:
        window = cleaned[:max_chars]
        boundary = max(window.rfind(". "), window.rfind("? "), window.rfind("! "))
        cleaned = (window[: boundary + 1] if boundary >= 40 else window.rstrip()).strip()
        if not cleaned.endswith((".", "?", "!")):
            cleaned = f"{cleaned}\u2026"
    return cleaned


# --- Authentication --------------------------------------------------------


def verify_bearer(header: str, expected: str) -> bool:
    """Constant-time check of an ``Authorization: Bearer <token>`` header."""
    if not expected:
        return False
    value = (header or "").strip()
    if len(value) < 8 or value[:7].lower() != "bearer ":
        return False
    provided = value[7:].strip()
    if not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


# --- Limits / deadlines ----------------------------------------------------


def resolve_seconds(value: Any, default: float, *, maximum: float) -> float:
    """Parses a positive float from a request field, clamped to ``maximum``."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float(default)
    if parsed != parsed or parsed <= 0:  # NaN or non-positive
        return float(default)
    return float(min(parsed, maximum))


def resolve_int(value: Any, default: int, *, minimum: int = 1, maximum: int) -> int:
    """Parses a positive int from a request field, clamped to ``maximum``."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return int(default)
    if parsed < minimum:
        return int(default)
    return int(min(parsed, maximum))


def decode_base64_audio(value: Any) -> bytes:
    """Decodes a base64 audio field, rejecting anything that is not a string."""
    if not isinstance(value, str) or not value.strip():
        raise ServiceError(
            400, "INVALID_AUDIO_FIELD", "Field 'audioBase64' must be a base64 string."
        )
    try:
        return base64.b64decode(value.strip(), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ServiceError(
            400, "INVALID_BASE64", "Field 'audioBase64' is not valid base64."
        ) from exc


def call_with_deadline(fn: Callable[[], Any], timeout_seconds: float) -> Any:
    """Runs ``fn`` and raises :class:`InferenceTimeout` after the deadline.

    The worker thread cannot be interrupted in Python, so a timed-out
    generation finishes in the background; the container's per-request timeout
    and the ``max_new_tokens`` cap bound how much work that can be.
    """
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ultravox")
    try:
        future = executor.submit(fn)
        return future.result(timeout=timeout_seconds)
    except FutureTimeout as exc:
        raise InferenceTimeout(
            f"Inference exceeded the {timeout_seconds:.1f}s deadline."
        ) from exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)



def decode_audio(
    data: bytes,
    *,
    max_seconds: int = DEFAULT_MAX_AUDIO_SECONDS,
    max_bytes: int = DEFAULT_MAX_AUDIO_BYTES,
    content_type: str = "",
    ffmpeg_runner: Callable[[Sequence[str], bytes], bytes] | None = None,
) -> AudioClip:
    """Validates and normalises one uploaded audio payload."""
    validate_audio_bytes(data, max_bytes=max_bytes, content_type=content_type)
    if looks_like_wav(data):
        return decode_wav(data, max_seconds=max_seconds)
    return transcode_with_ffmpeg(data, max_seconds=max_seconds, runner=ffmpeg_runner)
