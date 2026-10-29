/**
 * Tests for the browser-side self-hosted AI session.
 *
 * A fake WebSocket, a fake microphone stream and a fake AudioContext stand in
 * for the browser. These tests prove the protocol handling, the PCM framing,
 * mute behaviour, teardown and error redaction.
 *
 * They do NOT prove that real microphone audio reaches a deployed Modal
 * service or that ASR/suggestions work. Only a manual call on a real device can
 * prove that; see docs/self-hosted-ai-modal.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_FRAME_SAMPLES,
  AiSessionStatus,
  Role,
  SelfHostedAiSession,
  resampleToPcm16,
} from '../src/lib/aiSession';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket {
  static instances: FakeSocket[] = [];

  static latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    assert.ok(socket, 'no socket was created');
    return socket;
  }

  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  jsonSent(): Array<Record<string, unknown>> {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item) as Record<string, unknown>);
  }

  framesSent(): ArrayBuffer[] {
    return this.sent.filter((item): item is ArrayBuffer => typeof item !== 'string');
  }
}

interface MicHarness {
  session: SelfHostedAiSession;
  processor: { onaudioprocess: ((event: unknown) => void) | null };
  tracksStopped: () => number;
}

const makeSession = (
  options: { pingIntervalMs?: number; idleTimeoutMs?: number } = {}
): MicHarness => {
  let tracksStopped = 0;
  const track = {
    stop: () => {
      tracksStopped += 1;
    },
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const processor = { onaudioprocess: null as ((event: unknown) => void) | null };

  const context = {
    state: 'running',
    sampleRate: 48000,
    destination: {},
    createMediaStreamSource: () => ({ connect: () => undefined }),
    createGain: () => ({
      gain: { value: 0 },
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createScriptProcessor: () =>
      Object.assign(processor, { connect: () => undefined, disconnect: () => undefined }),
    resume: async () => undefined,
    close: async () => undefined,
  };

  const session = new SelfHostedAiSession({
    createWebSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    getUserMedia: async () => stream,
    createAudioContext: () => context as unknown as AudioContext,
    pingIntervalMs: options.pingIntervalMs ?? 60_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
  });

  return { session, processor, tracksStopped: () => tracksStopped };
};

/** Feeds one ScriptProcessor buffer of 48 kHz mono float samples. */
const feed = (harness: MicHarness, sampleCount = 4096): void => {
  const samples = new Float32Array(sampleCount).fill(0.4);
  harness.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
};

test('joining sends the protocol handshake and 100 ms PCM frames', async () => {
  FakeSocket.instances = [];
  const harness = makeSession();
  const statuses: string[] = [];
  harness.session.addEventListener('status', () => statuses.push(harness.session.status));

  harness.session.joinCall('wss://service.modal.run/v1/stream?call_id=c1');
  assert.equal(harness.session.status, AiSessionStatus.CONNECTING);

  const socket = FakeSocket.latest();
  assert.equal(socket.url, 'wss://service.modal.run/v1/stream?call_id=c1');
  socket.open();
  await flush();

  const handshake = socket.jsonSent()[0];
  assert.equal(handshake.type, 'audio.start');
  assert.equal(handshake.sampleRate, 16000);
  assert.equal(handshake.format, 'pcm_s16le');

  // 4096 samples at 48 kHz -> ~1365 samples at 16 kHz: not a full frame yet.
  feed(harness, 4096);
  assert.equal(socket.framesSent().length, 0);
  assert.equal(harness.session.micSourceNode, null, 'no audio published yet');

  feed(harness, 4096);
  const frames = socket.framesSent();
  assert.equal(frames.length, 1, 'one 1600-sample frame was sent');
  assert.equal(frames[0].byteLength, AI_FRAME_SAMPLES * 2);
  assert.equal(harness.session.status, AiSessionStatus.LISTENING);
  assert.ok(harness.session.micSourceNode, 'the microphone is now reaching the AI');
  assert.ok(statuses.includes(AiSessionStatus.LISTENING));

  await harness.session.leaveCall();
});

test('transcripts and suggestions become AI transcripts in order', async () => {
  FakeSocket.instances = [];
  const harness = makeSession();
  harness.session.joinCall('wss://service.modal.run/v1/stream?call_id=c2');
  const socket = FakeSocket.latest();
  socket.open();
  await flush();

  let events = 0;
  harness.session.addEventListener('transcripts', () => {
    events += 1;
  });

  socket.emit({ type: 'transcript', speaker: 'user', text: 'It is too expensive.', ordinal: 1 });
  socket.emit({ type: 'suggestion', text: 'Ask what budget they planned for.', ordinal: 2 });

  assert.equal(events, 2);
  assert.equal(harness.session.transcripts.length, 2);
  assert.equal(harness.session.transcripts[0].speaker, Role.USER);
  assert.equal(harness.session.transcripts[0].text, 'It is too expensive.');
  assert.equal(harness.session.transcripts[0].ordinal, 1);
  assert.equal(harness.session.transcripts[1].speaker, Role.AGENT);
  assert.equal(harness.session.transcripts[1].ordinal, 2);

  // A repeated ordinal replaces instead of duplicating: the engine de-dupes on
  // ordinal and a retried segment must not create two cards.
  socket.emit({ type: 'suggestion', text: 'Ask what budget they planned for.', ordinal: 2 });
  assert.equal(harness.session.transcripts.length, 2);

  await harness.session.leaveCall();
});


test('mute stops frames without touching the human call track', async () => {
  FakeSocket.instances = [];
  const harness = makeSession();
  harness.session.joinCall('wss://service.modal.run/v1/stream?call_id=c3');
  const socket = FakeSocket.latest();
  socket.open();
  await flush();

  feed(harness, 4096);
  harness.session.muteMic();
  const before = socket.framesSent().length;
  feed(harness, 8192);
  assert.equal(socket.framesSent().length, before, 'a muted AI stream sends no audio');
  assert.equal(harness.tracksStopped(), 0, 'the AI must not stop the call microphone');

  harness.session.unmuteMic();
  feed(harness, 8192);
  assert.ok(socket.framesSent().length > before);

  await harness.session.leaveCall();
  assert.equal(harness.tracksStopped(), 1, 'teardown releases only its own capture');
});

test('leaving ends the call and reports the terminal statuses', async () => {
  FakeSocket.instances = [];
  const harness = makeSession();
  harness.session.joinCall('wss://service.modal.run/v1/stream?call_id=c4');
  const socket = FakeSocket.latest();
  socket.open();
  await flush();

  const statuses: string[] = [];
  harness.session.addEventListener('status', () => statuses.push(harness.session.status));

  await harness.session.leaveCall();

  assert.deepEqual(statuses, [AiSessionStatus.DISCONNECTING, AiSessionStatus.DISCONNECTED]);
  assert.ok(socket.jsonSent().some((message) => message.type === 'audio.end'));
  assert.equal(socket.readyState, 3);
});

test('a service error is surfaced once and redacted', async () => {
  FakeSocket.instances = [];
  const harness = makeSession();
  const errors: string[] = [];
  harness.session.addEventListener('error', (event) => {
    errors.push((event as unknown as { error: Error }).error.message);
  });

  harness.session.joinCall('wss://service.modal.run/v1/stream?call_id=c5&sig=top-secret');
  const socket = FakeSocket.latest();
  socket.open();
  await flush();

  socket.emit({
    type: 'error',
    code: 'PIPELINE_ERROR',
    message: 'failed at wss://service.modal.run/v1/stream?call_id=c5&sig=top-secret',
  });

  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('top-secret'), 'the signed URL must be redacted');
  assert.equal(harness.session.status, AiSessionStatus.DISCONNECTED);
});

test('an unresponsive service is detected by the heartbeat', async () => {
  FakeSocket.instances = [];
  const harness = makeSession({ pingIntervalMs: 5, idleTimeoutMs: 1 });
  const errors: string[] = [];
  harness.session.addEventListener('error', (event) => {
    errors.push((event as unknown as { error: Error }).error.message);
  });

  harness.session.joinCall('wss://service.modal.run/v1/stream?call_id=c6');
  FakeSocket.latest().open();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(errors.length, 1);
  assert.match(errors[0], /stopped responding/i);
  await harness.session.leaveCall();
});

test('resampling produces 16 kHz mono PCM16', () => {
  const input = new Float32Array(4800).fill(0.5);
  const pcm = resampleToPcm16(input, 48000);
  assert.equal(pcm.length, 1600);
  assert.ok(Math.abs(pcm[0] - 16383) <= 1);

  const clipped = resampleToPcm16(new Float32Array([2, -2]), 16000);
  assert.deepEqual(Array.from(clipped), [32767, -32768]);

  const passthrough = resampleToPcm16(new Float32Array([0, 0.5]), 16000);
  assert.equal(passthrough.length, 2);
});

