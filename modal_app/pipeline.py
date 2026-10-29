"""Framework-free audio pipeline pieces for the self-hosted AI service.

Deliberately free of Modal, FastAPI, numpy, torch and the model runtimes so the
segmentation, prompting and output-cleaning rules can be unit tested on a plain
`python3` (no GPU required). `modal_app/app.py` imports these helpers.

Audio contract: 16 kHz, mono, signed 16-bit little-endian PCM, delivered as
20 ms frames (640 bytes). The WebSocket layer may receive larger chunks; it
splits them before calling `VadSegmenter.push`.
"""

from __future__ import annotations

import math
import re
from array import array
from collections import deque
from dataclasses import dataclass
from typing import Iterable, Sequence

PROTOCOL = "salescopilot-ai/1"

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2

DEFAULT_SYSTEM_PROMPT = (
    "You are an AI sales copilot assisting a salesperson in a live sales call. "
    "Listen attentively to the customer statements, questions, and objections. "
    "Generate concise, natural, 1-2 sentence ready-to-read sales responses and "
    "qualification questions for the salesperson to read aloud."
)

SUGGESTION_INSTRUCTION = (
    "Rules: answer with exactly one suggestion the salesperson can read aloud, "
    "at most 2 short sentences. Address the customer's point or ask one useful "
    "qualifying question. No preamble, no labels, no quotation marks, no bullet "
    "points, no repetition of the customer's words."
)

REFUSAL_MARKERS = (
    "as an ai",
    "i'm sorry, but i can't",
    "i cannot assist",
    "i can't help with that",
)


@dataclass(frozen=True)
class Segment:
    """One contiguous span of speech, ready for transcription."""

    pcm: bytes
    start_ms: int
    end_ms: int
    speech_ms: int

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def frame_rms(pcm: bytes) -> float:
    """Root-mean-square amplitude of a PCM16 frame, normalised to 0..1."""
    if not pcm or len(pcm) % 2:
        return 0.0
    samples = array("h")
    samples.frombytes(pcm)
    if not samples:
        return 0.0
    total = 0.0
    for value in samples:
        normalised = value / 32768.0
        total += normalised * normalised
    return math.sqrt(total / len(samples))


def is_speech_like(rms: float, noise_floor: float, *, min_rms: float, ratio: float) -> bool:
    """Energy gate with an adaptive floor. Speech must exceed both bounds."""
    return rms >= min_rms and rms >= max(noise_floor * ratio, min_rms)



class VadSegmenter:
    """Energy-based endpointing.

    Not a replacement for a neural VAD; it is intentionally simple, predictable
    and cheap. It keeps a short pre-roll so the first syllable is not clipped,
    ends a segment after `end_silence_ms` of quiet, and forces a cut at
    `max_segment_ms` so one long monologue still produces suggestions.
    """

    def __init__(
        self,
        *,
        min_speech_ms: int = 280,
        end_silence_ms: int = 560,
        max_segment_ms: int = 20000,
        preroll_ms: int = 240,
        min_rms: float = 0.008,
        ratio: float = 3.0,
    ) -> None:
        self.min_speech_ms = min_speech_ms
        self.end_silence_ms = end_silence_ms
        self.max_segment_ms = max_segment_ms
        self.min_rms = min_rms
        self.ratio = ratio
        self._preroll_frames = max(1, preroll_ms // FRAME_MS)
        self._preroll: deque[bytes] = deque(maxlen=self._preroll_frames)
        self._noise_floor = min_rms / 2
        self._buffer = bytearray()
        self._in_speech = False
        self._speech_ms = 0
        self._silence_ms = 0
        self._elapsed_ms = 0
        self._start_ms = 0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def push(self, pcm: bytes) -> list[Segment]:
        """Feeds audio and returns any segments completed by this chunk."""
        completed: list[Segment] = []
        for offset in range(0, len(pcm) - FRAME_BYTES + 1, FRAME_BYTES):
            frame = pcm[offset : offset + FRAME_BYTES]
            segment = self._push_frame(frame)
            if segment is not None:
                completed.append(segment)
        return completed

    def flush(self) -> Segment | None:
        """Ends the current segment, if it contains enough speech."""
        if not self._in_speech:
            return None
        segment = self._emit(trim_silence_ms=self._silence_ms)
        self._reset()
        return segment

    def _push_frame(self, frame: bytes) -> Segment | None:
        rms = frame_rms(frame)
        speech = is_speech_like(rms, self._noise_floor, min_rms=self.min_rms, ratio=self.ratio)
        self._elapsed_ms += FRAME_MS

        if not self._in_speech:
            # Track the background level only while nobody is talking.
            self._noise_floor = (self._noise_floor * 0.95) + (rms * 0.05)
            self._preroll.append(frame)
            if not speech:
                return None
            self._in_speech = True
            self._speech_ms = FRAME_MS
            self._silence_ms = 0
            self._buffer = bytearray(b"".join(self._preroll))
            self._start_ms = max(
                0, self._elapsed_ms - (len(self._buffer) // 2 * 1000 // SAMPLE_RATE)
            )
            return None

        self._buffer.extend(frame)
        if speech:
            self._speech_ms += FRAME_MS
            self._silence_ms = 0
        else:
            self._silence_ms += FRAME_MS

        if self._silence_ms >= self.end_silence_ms:
            return self._finish()
        if len(self._buffer) // 2 * 1000 // SAMPLE_RATE >= self.max_segment_ms:
            return self._finish(continue_speech=True)
        return None

    def _finish(self, *, continue_speech: bool = False) -> Segment | None:
        segment = self._emit(trim_silence_ms=self._silence_ms)
        if continue_speech:
            # Keep the rollover continuous: the tail of this buffer becomes the
            # pre-roll of the next segment instead of being dropped.
            tail = bytes(self._buffer[-FRAME_BYTES * self._preroll_frames :])
            self._preroll.clear()
            self._preroll.append(tail)
            self._reset(keep_preroll=True)
        else:
            self._reset()
        return segment

    def _emit(self, *, trim_silence_ms: int) -> Segment | None:
        data = bytes(self._buffer)
        if trim_silence_ms > 0:
            trim_frames = min(
                trim_silence_ms // FRAME_MS,
                max(0, len(data) // FRAME_BYTES - 1),
            )
            data = data[: len(data) - (trim_frames * FRAME_BYTES)]
        if not data:
            return None
        if self._speech_ms < self.min_speech_ms:
            return None
        end_ms = self._start_ms + (len(data) // 2 * 1000 // SAMPLE_RATE)
        return Segment(pcm=data, start_ms=self._start_ms, end_ms=end_ms, speech_ms=self._speech_ms)

    def _reset(self, *, keep_preroll: bool = False) -> None:
        self._buffer = bytearray()
        self._in_speech = False
        self._speech_ms = 0
        self._silence_ms = 0
        if not keep_preroll:
            self._preroll.clear()


def _normalise_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def is_meaningful_transcript(text: str, *, min_words: int = 2) -> bool:
    """Filters one-word artefacts and empty ASR output."""
    cleaned = _normalise_space(text)
    if not cleaned:
        return False
    words = [word for word in re.split(r"\s+", cleaned) if re.search(r"[A-Za-z0-9]", word)]
    return len(words) >= min_words


def build_messages(
    system_prompt: str,
    transcript: str,
    history: Sequence[str] = (),
) -> list[dict[str, str]]:
    """Chat messages for the instruction model.

    The last few customer utterances are included for context; the system prompt
    is operator-controlled and is never taken from the browser.
    """
    system = _normalise_space(system_prompt) or DEFAULT_SYSTEM_PROMPT
    messages: list[dict[str, str]] = [
        {"role": "system", "content": f"{system}\n\n{SUGGESTION_INSTRUCTION}"}
    ]
    for previous in list(history)[-4:]:
        text = _normalise_space(previous)
        if text:
            messages.append({"role": "user", "content": f'Customer said: "{text}"'})
    messages.append(
        {"role": "user", "content": f'Customer just said: "{_normalise_space(transcript)}"'}
    )
    return messages


def clean_suggestion(text: str, *, max_chars: int = 280) -> str:
    """Normalises model output into one short, read-aloud suggestion."""
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    # Drop the model repeating a role/label prefix.
    cleaned = re.sub(
        r"^\s*(?:assistant|suggestion|response|salesperson|copilot)\s*:\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    # Keep the first paragraph, then remove markdown emphasis and bullets.
    cleaned = cleaned.split("\n\n")[0]
    cleaned = re.sub(r"^\s*(?:[-*\u2022]|\d+[.)])\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = cleaned.replace("**", "").replace("__", "")
    cleaned = cleaned.strip().strip('"').strip("'").strip()
    cleaned = _normalise_space(cleaned)
    if not cleaned:
        return ""

    lowered = cleaned.lower()
    if any(marker in lowered[:40] for marker in REFUSAL_MARKERS):
        return ""

    if len(cleaned) > max_chars:
        window = cleaned[:max_chars]
        boundary = max(window.rfind(". "), window.rfind("? "), window.rfind("! "))
        cleaned = (window[: boundary + 1] if boundary >= 40 else window.rstrip()).strip()
        if not cleaned.endswith((".", "?", "!")):
            cleaned = f"{cleaned}\u2026"
    return cleaned


def chunks(payload: bytes, size: int = FRAME_BYTES) -> Iterable[bytes]:
    """Splits arbitrary client chunks into exactly-sized VAD frames."""
    for offset in range(0, len(payload), size):
        chunk = payload[offset : offset + size]
        if len(chunk) == size:
            yield chunk
