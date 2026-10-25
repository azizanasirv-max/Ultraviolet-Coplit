/**
 * Transcript merge rules and salesperson speech capture.
 *
 * These are unit tests with a FAKE SpeechRecognition implementation: no audio
 * is captured and no speech provider is contacted. They verify the ordering /
 * de-duplication rules the dashboards depend on, and the start/stop/pause
 * behaviour that keeps a muted salesperson out of the customer transcript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpeechSegment, transcriptText, SpeechSegment } from '../src/lib/transcript';
import {
  SalespersonSpeechCapture,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
} from '../src/lib/salespersonSpeech';

test('a partial segment is replaced in place when it becomes final', () => {
  let segments: SpeechSegment[] = [];
  segments = mergeSpeechSegment(segments, { ordinal: 1, text: 'Our starter', isFinal: false, at: 1 });
  segments = mergeSpeechSegment(segments, { ordinal: 1, text: 'Our starter plan', isFinal: false, at: 2 });
  segments = mergeSpeechSegment(segments, { ordinal: 1, text: 'Our starter plan includes onboarding.', isFinal: true, at: 3 });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'Our starter plan includes onboarding.');
  assert.equal(segments[0].isFinal, true);
});

test('a finalized segment is never downgraded by a late partial', () => {
  let segments = mergeSpeechSegment([], { ordinal: 2, text: 'Fixed text', isFinal: true });
  segments = mergeSpeechSegment(segments, { ordinal: 2, text: 'Fixed te', isFinal: false });
  assert.equal(segments[0].text, 'Fixed text');
  assert.equal(segments[0].isFinal, true);
});

test('out-of-order updates stay sorted and are not duplicated', () => {
  let segments = mergeSpeechSegment([], { ordinal: 2, text: 'second', isFinal: true });
  segments = mergeSpeechSegment(segments, { ordinal: 1, text: 'first', isFinal: true });
  segments = mergeSpeechSegment(segments, { ordinal: 2, text: 'second', isFinal: true });
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ['first', 'second']
  );
  assert.equal(transcriptText(segments), 'first second');
});

test('the same finalized line under a new ordinal is not shown twice', () => {
  let segments = mergeSpeechSegment([], { ordinal: 1, text: 'Thanks for calling.', isFinal: true });
  segments = mergeSpeechSegment(segments, { ordinal: 2, text: 'Thanks for calling.', isFinal: true });
  assert.equal(segments.length, 1);
});

test('empty partials are ignored and whitespace is normalized', () => {
  let segments = mergeSpeechSegment([], { ordinal: 1, text: '   ', isFinal: false });
  assert.equal(segments.length, 0);
  segments = mergeSpeechSegment(segments, { ordinal: 2, text: '  hello   there ', isFinal: true });
  assert.equal(segments[0].text, 'hello there');
});

/** Minimal fake of the browser SpeechRecognition API. */
class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  starts = 0;
  stops = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start(): void {
    this.starts += 1;
    this.onstart?.();
  }

  stop(): void {
    this.stops += 1;
    this.onend?.();
  }

  emit(items: Array<{ text: string; isFinal: boolean }>, resultIndex = 0): void {
    const results = items.map((item) => {
      const result = [ { transcript: item.text } ] as unknown as SpeechRecognitionEventLike['results'][number];
      Object.defineProperty(result, 'isFinal', { value: item.isFinal });
      Object.defineProperty(result, 'length', { value: 1 });
      return result;
    }) as unknown as SpeechRecognitionEventLike['results'];
    this.onresult?.({ resultIndex, results });
  }
}

const captureHarness = () => {
  const recognition = new FakeRecognition();
  const segments: Array<{ ordinal: number; text: string; isFinal: boolean }> = [];
  const statuses: Array<{ status: string; detail?: string }> = [];
  const capture = new SalespersonSpeechCapture({
    createRecognition: () => recognition,
    onSegment: (segment) => segments.push(segment),
    onStatus: (status, detail) => statuses.push({ status, detail }),
    restartDelayMs: 1,
  });
  return { recognition, segments, statuses, capture };
};

test('capture emits one ordinal per phrase across interim and final results', () => {
  const { recognition, segments, statuses, capture } = captureHarness();
  capture.start();
  assert.deepEqual(statuses.map((entry) => entry.status), ['starting', 'listening']);
  assert.equal(recognition.continuous, true, 'continuous recognition keeps captions alive');
  assert.equal(recognition.interimResults, true, 'partial results are used for live text');

  recognition.emit([{ text: 'Our starter', isFinal: false }]);
  recognition.emit([{ text: 'Our starter plan', isFinal: true }]);
  recognition.emit(
    [
      { text: 'Our starter plan', isFinal: true },
      { text: 'includes onboarding', isFinal: false },
    ],
    1
  );

  assert.deepEqual(segments, [
    { ordinal: 0, text: 'Our starter', isFinal: false },
    { ordinal: 0, text: 'Our starter plan', isFinal: true },
    { ordinal: 1, text: 'includes onboarding', isFinal: false },
  ]);
  capture.stop();
  assert.equal(recognition.stops, 1);
});

test('pausing stops recognising and does not restart automatically', async () => {
  const { recognition, statuses, capture } = captureHarness();
  capture.start();
  capture.pause();
  assert.equal(recognition.stops, 1);
  recognition.onend?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recognition.starts, 1, 'a paused capture must not restart itself');
  assert.equal(statuses.at(-1)?.status, 'inactive');

  capture.resume();
  assert.equal(recognition.starts, 2);
  capture.stop();
});

test('a permission error is reported and does not loop', async () => {
  const { recognition, statuses, capture } = captureHarness();
  capture.start();
  recognition.onerror?.({ error: 'not-allowed' });
  recognition.onend?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recognition.starts, 1);
  assert.equal(statuses.at(-1)?.status, 'error');
  assert.match(String(statuses.at(-1)?.detail), /blocked/i);
});

test('an unsupported browser is reported instead of failing silently', () => {
  const statuses: string[] = [];
  const capture = new SalespersonSpeechCapture({
    createRecognition: () => null,
    onSegment: () => undefined,
    onStatus: (status) => statuses.push(status),
  });
  capture.start();
  assert.deepEqual(statuses, ['unsupported']);
  assert.equal(capture.getStatus(), 'unsupported');
});
