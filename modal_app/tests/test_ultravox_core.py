"""Tests for the framework-free Ultravox helpers (stdlib only, no GPU)."""

from __future__ import annotations

import base64
import io
import math
import os
import time
import unittest
import wave
from array import array
from unittest import mock

from modal_app import ultravox_core as core


def make_wav(
    seconds: float = 1.0,
    rate: int = 16000,
    channels: int = 1,
    width: int = 2,
    freq: float = 220.0,
) -> bytes:
    """Builds a deterministic PCM WAV in memory."""
    total = max(1, int(seconds * rate))
    frames = array("h")
    for index in range(total):
        value = int(12000 * math.sin(2 * math.pi * freq * index / rate))
        frames.extend([value] * channels)
    if width != 2:
        # Narrow/widen via audioop so the WAV header matches the samples.
        import audioop

        raw = audioop.lin2lin(frames.tobytes(), 2, width)
    else:
        raw = frames.tobytes()

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        handle.writeframes(raw)
    return buffer.getvalue()


class AudioValidationTests(unittest.TestCase):
    def test_empty_payload_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.validate_audio_bytes(b"")
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "EMPTY_AUDIO")

    def test_oversized_payload_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.validate_audio_bytes(b"x" * 101, max_bytes=100)
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(ctx.exception.code, "AUDIO_TOO_LARGE")

    def test_non_audio_content_type_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.validate_audio_bytes(b"abc", content_type="text/plain")
        self.assertEqual(ctx.exception.status, 415)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_MEDIA_TYPE")

    def test_unknown_audio_content_type_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.validate_audio_bytes(b"abc", content_type="audio/x-aiff")
        self.assertEqual(ctx.exception.status, 415)

    def test_known_and_generic_content_types_are_accepted(self):
        for content_type in (
            "",
            "application/octet-stream",
            "audio/wav",
            "audio/wav; codecs=1",
            "audio/webm",
        ):
            core.validate_audio_bytes(b"abc", content_type=content_type)


class WavDecodeTests(unittest.TestCase):
    def test_mono_16k_is_passed_through(self):
        clip = core.decode_wav(make_wav(1.0))
        self.assertEqual(clip.source_format, "wav")
        self.assertEqual(clip.source_rate, 16000)
        self.assertEqual(clip.source_channels, 1)
        self.assertEqual(clip.samples, 16000)
        self.assertEqual(len(clip.pcm), 32000)
        self.assertEqual(clip.duration_ms, 1000)

    def test_stereo_48k_is_downmixed_and_resampled(self):
        clip = core.decode_wav(make_wav(1.0, rate=48000, channels=2))
        self.assertEqual(clip.source_rate, 48000)
        self.assertEqual(clip.source_channels, 2)
        self.assertAlmostEqual(clip.samples, 16000, delta=2)
        self.assertEqual(clip.duration_ms, 1000)

    def test_8_bit_wav_is_widened_to_16_bit(self):
        clip = core.decode_wav(make_wav(0.5, width=1))
        self.assertEqual(len(clip.pcm), 16000)
        self.assertEqual(clip.samples, 8000)

    def test_short_audio_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_wav(make_wav(0.1))
        self.assertEqual(ctx.exception.code, "AUDIO_TOO_SHORT")

    def test_long_audio_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_wav(make_wav(2.0), max_seconds=1)
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(ctx.exception.code, "AUDIO_TOO_LONG")

    def test_three_channels_are_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_wav(make_wav(0.5, channels=3))
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_AUDIO_FORMAT")

    def test_corrupt_wav_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_wav(b"RIFF\x00\x00\x00\x00WAVEjunk")
        self.assertEqual(ctx.exception.status, 415)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_AUDIO_FORMAT")


class FfmpegTests(unittest.TestCase):
    def test_transcodes_with_ffmpeg_and_reports_duration(self):
        seen: dict[str, object] = {}

        def runner(args, data):
            seen["args"] = list(args)
            seen["size"] = len(data)
            return b"\x00\x01" * 16000  # 1s of 16 kHz mono PCM16

        clip = core.decode_audio(
            b"\x1aE\xdf\xa3not-a-wav",
            content_type="audio/webm",
            ffmpeg_runner=runner,
        )
        self.assertEqual(clip.source_format, "ffmpeg")
        self.assertEqual(clip.duration_ms, 1000)
        self.assertEqual(clip.source_rate, core.SAMPLE_RATE)
        self.assertEqual(seen["size"], len(b"\x1aE\xdf\xa3not-a-wav"))
        args = seen["args"]
        self.assertIn("-ar", args)
        self.assertIn(str(core.SAMPLE_RATE), args)
        self.assertIn("-ac", args)

    def test_empty_ffmpeg_output_is_rejected(self):
        with self.assertRaises(core.ServiceError) as ctx:
            core.transcode_with_ffmpeg(b"data", runner=lambda args, data: b"")
        self.assertEqual(ctx.exception.code, "EMPTY_AUDIO")

    def test_ffmpeg_failure_is_reported(self):
        def failing(args, data):
            raise core.ServiceError(415, "UNSUPPORTED_AUDIO_FORMAT", "no ffmpeg")

        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_audio(b"\x00\x01junk", ffmpeg_runner=failing)
        self.assertEqual(ctx.exception.status, 415)


class TurnsTests(unittest.TestCase):
    def test_default_turns_end_with_the_audio_placeholder(self):
        turns = core.build_turns()
        self.assertEqual(turns[0]["role"], "system")
        self.assertIn(core.DEFAULT_SYSTEM_PROMPT, turns[0]["content"])
        self.assertIn("text only", turns[0]["content"])
        self.assertEqual(turns[-1], {"role": "user", "content": "<|audio|>"})
        self.assertEqual(len(turns), 2)

    def test_context_is_whitespace_normalised_and_capped(self):
        turns = core.build_turns(context="  hi\n\tthere  " + "x" * 5000)
        self.assertEqual(turns[1]["content"][:30], "Recent conversation: hi there ")
        self.assertLessEqual(len(turns[1]["content"]), core.MAX_CONTEXT_CHARS + 30)
        self.assertEqual(turns[-1]["content"], "<|audio|>")

    def test_custom_system_prompt_is_used_verbatim(self):
        turns = core.build_turns("Be terse.")
        self.assertTrue(turns[0]["content"].startswith("Be terse."))

    def test_blank_system_prompt_falls_back_to_the_default(self):
        turns = core.build_turns("   ")
        self.assertIn(core.DEFAULT_SYSTEM_PROMPT, turns[0]["content"])


class ParseSuggestionTests(unittest.TestCase):
    def test_plain_text_is_returned_unchanged(self):
        self.assertEqual(
            core.parse_suggestion("We can start with a pilot next week."),
            "We can start with a pilot next week.",
        )

    def test_labels_markdown_quotes_and_bullets_are_stripped(self):
        raw = '  Suggestion: **"We can start with a pilot."**\n\nExtra explanation'
        self.assertEqual(core.parse_suggestion(raw), "We can start with a pilot.")

    def test_bullets_are_stripped(self):
        self.assertEqual(
            core.parse_suggestion("- Happy to share pricing."),
            "Happy to share pricing.",
        )

    def test_no_speech_marker_returns_empty(self):
        self.assertEqual(core.parse_suggestion("NO_SPEECH"), "")

    def test_refusals_return_empty(self):
        self.assertEqual(
            core.parse_suggestion("I'm sorry, but I can't help with that."), ""
        )

    def test_blank_and_none_are_handled(self):
        self.assertEqual(core.parse_suggestion("   "), "")
        with self.assertRaises(core.InferenceError):
            core.parse_suggestion(None)

    def test_non_text_output_is_rejected(self):
        with self.assertRaises(core.InferenceError):
            core.parse_suggestion([1, 2, 3])

    def test_long_output_is_cut_at_a_sentence_boundary(self):
        raw = "First sentence is useful. " * 20
        cleaned = core.parse_suggestion(raw, max_chars=60)
        self.assertLessEqual(len(cleaned), 61)
        self.assertTrue(cleaned.endswith((".", "\u2026")))


class AuthTests(unittest.TestCase):
    def test_matching_token_is_accepted(self):
        self.assertTrue(core.verify_bearer("Bearer s3cret", "s3cret"))

    def test_scheme_is_case_insensitive(self):
        self.assertTrue(core.verify_bearer("bearer s3cret", "s3cret"))

    def test_wrong_or_missing_token_is_rejected(self):
        self.assertFalse(core.verify_bearer("Bearer nope", "s3cret"))
        self.assertFalse(core.verify_bearer("", "s3cret"))
        self.assertFalse(core.verify_bearer("s3cret", "s3cret"))
        self.assertFalse(core.verify_bearer("Bearer ", "s3cret"))

    def test_missing_expected_token_always_fails(self):
        self.assertFalse(core.verify_bearer("Bearer anything", ""))
        self.assertFalse(core.verify_bearer("Bearer ", ""))


class LimitTests(unittest.TestCase):
    def test_ints_are_clamped_and_defaulted(self):
        self.assertEqual(core.resolve_int("12", 4, maximum=64), 12)
        self.assertEqual(core.resolve_int("999", 4, maximum=64), 64)
        self.assertEqual(core.resolve_int("0", 4, maximum=64), 4)
        self.assertEqual(core.resolve_int("abc", 4, maximum=64), 4)
        self.assertEqual(core.resolve_int(None, 4, maximum=64), 4)

    def test_seconds_are_clamped_and_defaulted(self):
        self.assertAlmostEqual(core.resolve_seconds("2.5", 1.0, maximum=10), 2.5)
        self.assertAlmostEqual(core.resolve_seconds("99", 1.0, maximum=10), 10.0)
        self.assertAlmostEqual(core.resolve_seconds("-1", 1.0, maximum=10), 1.0)
        self.assertAlmostEqual(
            core.resolve_seconds(float("nan"), 1.0, maximum=10), 1.0
        )

    def test_base64_round_trip_and_errors(self):
        payload = make_wav(0.3)
        self.assertEqual(
            core.decode_base64_audio(base64.b64encode(payload).decode()), payload
        )
        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_base64_audio("not base64!!")
        self.assertEqual(ctx.exception.code, "INVALID_BASE64")
        with self.assertRaises(core.ServiceError) as ctx:
            core.decode_base64_audio(123)
        self.assertEqual(ctx.exception.code, "INVALID_AUDIO_FIELD")


class DeadlineTests(unittest.TestCase):
    def test_fast_work_returns_its_value(self):
        self.assertEqual(core.call_with_deadline(lambda: "ok", 1.0), "ok")

    def test_slow_work_raises_inference_timeout(self):
        def slow():
            time.sleep(0.25)
            return "late"

        with self.assertRaises(core.InferenceTimeout):
            core.call_with_deadline(slow, 0.05)

    def test_non_positive_deadline_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            core.call_with_deadline(lambda: "ok", 0)

    def test_exceptions_propagate(self):
        with self.assertRaises(ZeroDivisionError):
            core.call_with_deadline(lambda: 1 / 0, 1.0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


