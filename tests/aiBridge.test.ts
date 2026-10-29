import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MAX_FRAME_BYTES,
  AiBridgeEvent,
  AiBridgeManager,
  AiBridgeSocket,
} from '../server/aiBridge';
import type { AiServiceSettings } from '../server/aiService';

/**
 * Unit tests for the server-side AI bridge. The HTTP call creation and the
 * upstream WebSocket are both faked, so these prove the forwarding rules
 * (customer frames only, bounded size/backpressure, text de-duplication and
 * single-call lifecycle) without a GPU or a deployment.
 */

class FakeSocket implements AiBridgeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<string | Buffer> = [];
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(payload: unknown): void {
    this.emit('message', JSON.stringify(payload));
  }

  get audio(): Buffer[] {
    return this.sent.filter((item): item is Buffer => Buffer.isBuffer(item));
  }

  get json(): any[] {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map((item) => JSON.parse(item));
  }
}

const settings: AiServiceSettings = {
  baseUrl: 'https://ai.example',
  token: 'server-token',
  model: 'test-model',
  maxCallSeconds: 3600,
  joinHost: 'ai.example',
};

const makeManager = () => {
  const events: Array<{ sessionId: string; event: AiBridgeEvent }> = [];
  const calls: Array<{ method: string; url: string }> = [];
  let created = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input) });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    created += 1;
    return new Response(
      JSON.stringify({
        callId: `call_${created}`,
        joinUrl: `wss://ai.example/stream?call_id=call_${created}&sig=secret`,
        model: 'test-model',
        expiresAt: Date.now() + 3_600_000,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  FakeSocket.instances = [];
  const manager = new AiBridgeManager({
    settings,
    fetchImpl,
    systemPrompt: 'test prompt',
    createSocket: (url) => new FakeSocket(url),
    onEvent: (sessionId, event) => events.push({ sessionId, event }),
  });
  return { manager, events, calls };
};

const lastStatus = (events: Array<{ event: AiBridgeEvent }>) =>
  events
    .filter((entry) => entry.event.type === 'status')
    .map((entry) => entry.event as Extract<AiBridgeEvent, { type: 'status' }>)
    .at(-1);

test('one live upstream call per room, reused until it is actually open', async () => {
  const { manager, events } = makeManager();

  const first = await manager.ensure('room-a');
  assert.equal(first.callId, 'call_1');
  assert.equal(first.reused, false);
  const socket = FakeSocket.instances[0];
  assert.ok(socket);

  // The socket is not open yet: a retry must create a new call rather than hand
  // out a dead upstream.
  const second = await manager.ensure('room-a');
  assert.equal(second.callId, 'call_2');
  assert.equal(FakeSocket.instances.length, 2);

  const live = FakeSocket.instances[1];
  live.open();
  live.message({ type: 'ready' });
  const reused = await manager.ensure('room-a');
  assert.equal(reused.callId, 'call_2');
  assert.equal(reused.reused, true);
  assert.equal(FakeSocket.instances.length, 2);

  // Status is observable and never contains the upstream URL or token.
  const status = lastStatus(events);
  assert.ok(status);
  assert.equal(status.state, 'listening');
  assert.equal(status.connected, true);
  assert.doesNotMatch(JSON.stringify(events), /ai\.example|sig=secret|server-token/);
});

test('only well-formed, bounded, open frames are forwarded', async () => {
  const { manager } = makeManager();
  await manager.ensure('room-b');
  const socket = FakeSocket.instances[0];

  // Not open yet -> dropped.
  assert.equal(manager.pushAudio('room-b', Buffer.alloc(320, 1)), false);
  assert.equal(manager.pushAudio('unknown-room', Buffer.alloc(320, 1)), false);

  socket.open();
  assert.equal(manager.pushAudio('room-b', Buffer.alloc(0)), false, 'empty frame rejected');
  assert.equal(manager.pushAudio('room-b', Buffer.alloc(3, 1)), false, 'odd byte count rejected');
  assert.equal(
    manager.pushAudio('room-b', Buffer.alloc(AI_MAX_FRAME_BYTES + 2, 1)),
    false,
    'oversized frame rejected'
  );
  assert.equal(socket.audio.length, 0);

  socket.bufferedAmount = 2_000_000;
  assert.equal(manager.pushAudio('room-b', Buffer.alloc(320, 1)), false, 'backpressure drops audio');
  socket.bufferedAmount = 0;

  assert.equal(manager.pushAudio('room-b', Buffer.alloc(320, 7)), true);
  assert.equal(socket.audio.length, 1);
  assert.deepEqual(socket.audio[0], Buffer.alloc(320, 7));
});

test('model text is forwarded once, in order, and never as audio', async () => {
  const { manager, events } = makeManager();
  await manager.ensure('room-c');
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.message({ type: 'ready' });

  socket.message({ type: 'transcript', speaker: 'user', text: 'Hello there.', ordinal: 1 });
  socket.message({ type: 'suggestion', text: 'Ask about timing.', ordinal: 2 });
  socket.message({ type: 'suggestion', text: 'Ask about timing.', ordinal: 2 });
  socket.message({ type: 'suggestion', text: 'Ask about budget.', ordinal: 3 });
  socket.message({ type: 'suggestion', speaker: 'agent', text: '   ', ordinal: 4 });
  socket.message({ type: 'transcript', speaker: 'agent', text: 'Should be ignored', ordinal: 5 });

  const forwarded = events
    .filter((entry) => entry.event.type !== 'status')
    .map((entry) => entry.event);
  assert.deepEqual(
    forwarded.map((event: any) => [event.type, event.text, event.ordinal]),
    [
      ['transcript', 'Hello there.', 1],
      ['suggestion', 'Ask about timing.', 2],
      ['suggestion', 'Ask about budget.', 3],
    ]
  );

  const status = lastStatus(events);
  assert.ok(status);
  assert.equal(status.audioReachingAi, false);
  assert.ok(status.lastSuggestionAt && status.lastResponseAt);
});

test('per-segment errors keep the session alive; the human call is never involved', async () => {
  const { manager, events } = makeManager();
  await manager.ensure('room-d');
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.message({ type: 'ready' });
  socket.message({
    type: 'error',
    code: 'PIPELINE_ERROR',
    message: 'segment failed at wss://ai.example/stream?token=super-secret',
  });

  assert.equal(manager.has('room-d'), true);
  const status = lastStatus(events);
  assert.ok(status);
  assert.match(String(status.error), /segment failed/);
  assert.doesNotMatch(String(status.error), /super-secret|wss:\/\//);
});

test('restart and end create/terminate exactly one upstream call each', async () => {
  const { manager, calls } = makeManager();
  await manager.ensure('room-e');
  const first = FakeSocket.instances[0];
  first.open();
  first.message({ type: 'ready' });

  const restarted = await manager.restart('room-e');
  assert.equal(restarted.callId, 'call_2');
  assert.equal(FakeSocket.instances.length, 2);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/call_1')));

  manager.end('room-e');
  assert.equal(manager.has('room-e'), false);
  assert.equal(manager.status('room-e'), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/call_2')));
});

test('a missing service configuration is a clear, non-throwing refusal', async () => {
  const manager = new AiBridgeManager({
    settings: null,
    fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    systemPrompt: 'x',
    onEvent: () => undefined,
    createSocket: () => {
      throw new Error('must not connect');
    },
  });
  await assert.rejects(
    manager.ensure('room-f'),
    (error: any) => error?.code === 'AI_SERVICE_NOT_CONFIGURED'
  );
  assert.equal(manager.pushAudio('room-f', Buffer.alloc(320, 1)), false);
});
