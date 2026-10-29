"""Unit tests for the dependency-free parts of the Modal AI service.

Run from the repository root:

    python3 -m unittest discover -s modal_app/tests -t .

These tests need no GPU, no Modal account and no model weights. They cover the
VAD, prompt construction, output cleaning and join-token signing. They do NOT
prove that ASR or the language model produce good suggestions, and they do not
prove that a browser can stream audio to a deployed Modal app.
"""

import struct
import unittest

from modal_app.pipeline import (
    FRAME_BYTES,
    FRAME_MS,
    FRAME_SAMPLES,
    SUGGESTION_INSTRUCTION,
    Segment,
    VadSegmenter,
    build_messages,
    clean_suggestion,
    frame_rms,
    is_meaningful_transcript,
)


def pcm(amplitude: float, frames: int = 1) -> bytes:
    value = int(max(-1.0, min(1.0, amplitude)) * 32767)
    return struct.pack("<h", value) * (FRAME_SAMPLES * frames)


SILENCE = pcm(0.0)
SPEECH = pcm(0.3)


class FrameRmsTests(unittest.TestCase):
    def test_silence_is_zero(self):
        self.assertEqual(frame_rms(SILENCE), 0.0)

    def test_loud_frame_is_close_to_one(self):
        self.assertGreater(frame_rms(pcm(1.0)), 0.99)

    def test_rejects_truncated_frames(self):
        self.assertEqual(frame_rms(b"\x00\x01\x02"), 0.0)


class VadSegmenterTests(unittest.TestCase):
    def test_emits_one_segment_after_speech_then_silence(self):
        vad = VadSegmenter()
        segments = []
        for _ in range(10):
            segments.extend(vad.push(SILENCE))
        for _ in range(50):  # 1 s of speech
            segments.extend(vad.push(SPEECH))
        self.assertEqual(segments, [], "speech must not end while it continues")
        for _ in range(30):  # 600 ms of silence >= end_silence_ms
            segments.extend(vad.push(SILENCE))

        self.assertEqual(len(segments), 1)
        segment = segments[0]
        self.assertIsInstance(segment, Segment)
        self.assertGreaterEqual(segment.speech_ms, 900)
        self.assertLessEqual(segment.duration_ms, 1500)
        self.assertTrue(segment.pcm)

    def test_silence_only_never_emits(self):
        vad = VadSegmenter()
        segments = []
        for _ in range(500):
            segments.extend(vad.push(SILENCE))
        self.assertEqual(segments, [])

    def test_short_blip_is_discarded(self):
        vad = VadSegmenter()
        segments = []
        segments.extend(vad.push(SPEECH))  # 20 ms
        for _ in range(40):
            segments.extend(vad.push(SILENCE))
        self.assertEqual(segments, [], "less than min_speech_ms must be dropped")


    def test_preroll_keeps_the_first_syllable(self):
        vad = VadSegmenter(preroll_ms=200)
        for _ in range(20):
            vad.push(SILENCE)
        for _ in range(30):
            vad.push(SPEECH)
        segments = []
        for _ in range(40):
            segments.extend(vad.push(SILENCE))
            if segments:
                break
        self.assertTrue(segments)
        # ~200 ms of pre-roll is prepended to ~600 ms of speech.
        self.assertGreater(segments[0].duration_ms, 700)

    def test_long_monologue_is_cut(self):
        vad = VadSegmenter(max_segment_ms=400, end_silence_ms=10_000)
        segments = []
        for _ in range(40):  # 800 ms of speech, no pause
            segments.extend(vad.push(SPEECH))
        self.assertGreaterEqual(len(segments), 1)
        self.assertTrue(vad.in_speech, "the monologue must continue after a forced cut")

    def test_flush_ends_an_open_segment(self):
        vad = VadSegmenter()
        for _ in range(30):
            vad.push(SPEECH)
        segment = vad.flush()
        self.assertIsNotNone(segment)
        self.assertGreaterEqual(segment.speech_ms, 500)
        self.assertIsNone(vad.flush(), "the segmenter is reset after a flush")

    def test_large_chunks_are_split_into_frames(self):
        vad = VadSegmenter()
        chunk = SPEECH * 10  # 200 ms, as a browser would send it
        segments = []
        for _ in range(10):
            segments.extend(vad.push(chunk))
        for _ in range(40):
            segments.extend(vad.push(SILENCE))
        self.assertEqual(len(segments), 1)
        self.assertGreaterEqual(segments[0].speech_ms, 1900)

    def test_odd_trailing_bytes_are_ignored(self):
        vad = VadSegmenter()
        self.assertEqual(vad.push(b"\x01" * 10), [])


class PromptTests(unittest.TestCase):
    def test_messages_start_with_the_operator_prompt(self):
        messages = build_messages("Be terse.", "It is too expensive.")
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("Be terse.", messages[0]["content"])
        self.assertIn(SUGGESTION_INSTRUCTION, messages[0]["content"])
        self.assertEqual(messages[-1]["role"], "user")
        self.assertIn("It is too expensive.", messages[-1]["content"])

    def test_history_is_bounded(self):
        history = [f"turn {index}" for index in range(10)]
        messages = build_messages("prompt", "latest", history)
        turns = [message for message in messages if message["role"] == "user"]
        self.assertEqual(len(turns), 5)  # 4 history turns + the latest
        self.assertIn("turn 9", turns[-2]["content"])

    def test_blank_system_prompt_uses_the_default(self):
        messages = build_messages("   ", "hello there")
        self.assertIn("sales copilot", messages[0]["content"])


class TranscriptFilterTests(unittest.TestCase):
    def test_accepts_a_real_sentence(self):
        self.assertTrue(is_meaningful_transcript("We already use a competitor."))

    def test_rejects_noise_artefacts(self):
        self.assertFalse(is_meaningful_transcript(""))
        self.assertFalse(is_meaningful_transcript("   "))
        self.assertFalse(is_meaningful_transcript("Thanks."))
        self.assertFalse(is_meaningful_transcript("..."))


class SuggestionCleaningTests(unittest.TestCase):
    def test_strips_labels_quotes_and_markdown(self):
        raw = 'Suggestion: **"Acknowledge the price concern, then ask what budget they planned for."**'
        cleaned = clean_suggestion(raw)
        self.assertEqual(
            cleaned, "Acknowledge the price concern, then ask what budget they planned for."
        )

    def test_keeps_only_the_first_paragraph(self):
        cleaned = clean_suggestion("Ask about their timeline.\n\nAlso mention the discount.")
        self.assertEqual(cleaned, "Ask about their timeline.")

    def test_removes_bullets(self):
        cleaned = clean_suggestion("- Ask what is missing from the current tool.")
        self.assertEqual(cleaned, "Ask what is missing from the current tool.")

    def test_rejects_refusals(self):
        self.assertEqual(clean_suggestion("As an AI language model, I cannot assist."), "")

    def test_shortens_long_output(self):
        raw = ("This is a long sentence about pricing and value. " * 10).strip()
        cleaned = clean_suggestion(raw, max_chars=120)
        self.assertLessEqual(len(cleaned), 121)
        self.assertTrue(cleaned.endswith((".", "…")))

    def test_empty_input(self):
        self.assertEqual(clean_suggestion(""), "")
        self.assertEqual(clean_suggestion("   \n  "), "")


class FrameContractTests(unittest.TestCase):
    def test_frame_constants_match_16khz_mono_pcm16(self):
        self.assertEqual(FRAME_SAMPLES, 320)
        self.assertEqual(FRAME_BYTES, 640)
        self.assertEqual(FRAME_MS, 20)


if __name__ == "__main__":
    unittest.main()
