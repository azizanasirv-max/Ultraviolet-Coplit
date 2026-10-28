/**
 * AI session lifecycle tests for CallEngine.
 *
 * IMPORTANT: these tests use a FAKE `UltravoxSession` (injected through
 * `createAiSession`) and a mocked `fetch`. They prove the recovery logic,
 * generation guards, bounded retries and reporting behaviour. They do NOT
 * prove connectivity to the real Ultravox service; that needs a real API key
 * and network access (see docs/prototype2-architecture.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UltravoxSessionStatus } from 'ultravox-client';
import { CallEngine } from '../src/lib/callEngine';

// The engine uses browser timers in the AI paths.
(globalThis as any).window = {
  setTimeout: (handler: (...args: any[]) => void, timeout?: number) =>
    setTimeout(handler, timeout) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  setInterval: (handler: (...args: any[]) => void, timeout?: number) =>
    setInterval(handler, timeout) as unknown as number,
  clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal stand-in for ultravox-client's UltravoxSession. */
class FakeSession extends EventTarget {
  status: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;
  transcripts: Array<{
    text: string;
    isFinal: boolean;
    speaker: string;
    medium: string;
    ordinal: number;
  }> = [];
  micSourceNode: unknown = undefined;
  joinCalls: string[] = [];
  /** Whether the agent speaker was already muted when each join happened. */
  speakerMutedAtJoin: boolean[] = [];
  leaveCalls = 0;
  outputMedium: string | null = null;
  speakerMuted = false;
  micMuted = false;

  setStatus(status: UltravoxSessionStatus): void {
    this.status = status;
    this.dispatchEvent(new Event('status'));
  }

  joinCall(joinUrl: string): void {
    this.joinCalls.push(joinUrl);
    this.speakerMutedAtJoin.push(this.speakerMuted);
    this.setStatus(UltravoxSessionStatus.CONNECTING);
  }

  async leaveCall(): Promise<void> {
    this.leaveCalls += 1;
    this.setStatus(UltravoxSessionStatus.DISCONNECTING);
    this.setStatus(UltravoxSessionStatus.DISCONNECTED);
  }

  setOutputMedium(medium: string): void {
    this.outputMedium = medium;
  }

  muteSpeaker(): void {
    this.speakerMuted = true;
  }

  muteMic(): void {
    this.micMuted = true;
  }

  unmuteMic(): void {
    this.micMuted = false;
  }

  emitError(message: string): void {
    const event = new Event('error') as Event & { error: Error };
    event.error = new Error(message);
    this.dispatchEvent(event);
  }

  emitTranscript(transcript: { text: string; isFinal: boolean; speaker: string; ordinal: number }): void {
    // Mirrors the SDK's per-ordinal accumulator: replace, never append a second
    // copy, then emit the whole array.
    const index = this.transcripts.findIndex((item) => item.ordinal === transcript.ordinal);
    const value = { ...transcript, medium: 'text' };
    if (index >= 0) this.transcripts[index] = value;
    else this.transcripts.push(value);
    this.dispatchEvent(new Event('transcripts'));
  }
}

interface Harness {
  engine: CallEngine;
  sessions: FakeSession[];
  requests: Array<{ url: string; body: any; headers: Record<string, string> }>;
  signals: any[];
  snapshots: any[];
  restoreFetch: () => void;
}

const makeHarness = (options: {
  role?: 'customer' | 'salesperson';
  fetchImpl?: typeof fetch;
  delays?: number[];
} = {}): Harness => {
  const sessions: FakeSession[] = [];
  const requests: Harness['requests'] = [];
  const signals: any[] = [];
  const snapshots: any[] = [];
  const originalFetch = globalThis.fetch;

  const fetchImpl =
    options.fetchImpl ??
    ((async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({
        url: String(input),
        body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const callNumber = requests.length;
      return new Response(
        JSON.stringify({
          callId: `call_${callNumber}`,
          joinUrl: `wss://ai.invalid/join-${callNumber}`,
          isReused: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch);

  const engine = new CallEngine({
    sessionId: 'session-test',
    role: options.role ?? 'customer',
    credential: 'credential-test',
    enableAi: true,
    apiBase: '',
    aiRetryDelaysMs: options.delays ?? [20, 20, 20],
    createAiSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session as unknown as any;
    },
    onUpdate: (snapshot) => snapshots.push(snapshot),
  });

  globalThis.fetch = fetchImpl;

  // A fake signaling socket so ai_status reporting can be observed.
  (engine as any).ws = {
    readyState: 1, // WebSocket.OPEN
    send: (raw: string) => signals.push(JSON.parse(raw)),
  };

  return {
    engine,
    sessions,
    requests,
    signals,
    snapshots,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const snapshot = (engine: CallEngine) => engine.getSnapshot();

test('manual retry creates a brand new Ultravox call and a new SDK session', async () => {
  const harness = makeHarness();
  const { engine, sessions, requests, signals, restoreFetch } = harness;
  try {
    await engine.retryAi();

    assert.equal(requests.length, 1, 'one call request');
    assert.equal(requests[0].body.replace, true, 'client must explicitly replace the cached call');
    assert.equal(requests[0].headers.Authorization, 'Bearer credential-test');
    assert.equal(sessions.length, 1, 'one new SDK session');
    assert.deepEqual(sessions[0].joinCalls, ['wss://ai.invalid/join-1']);

    const state = snapshot(engine);
    assert.equal(state.ai.state, 'connecting');
    assert.equal(state.ai.connected, false);
    assert.equal(state.ai.callId, 'call_1');

    const reported = signals.filter((signal) => signal.type === 'ai_status');
    assert.ok(reported.length > 0, 'AI state is reported over signaling');
    assert.equal(reported.at(-1).connected, false);
    assert.equal(reported.at(-1).state, 'connecting');
    assert.doesNotMatch(JSON.stringify(state.logs), /wss:\/\/ai\.invalid/);
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});

test('the agent speaker is muted and the output is text-only before the room is joined', async () => {
  // Why this matters: `ultravox-client` enables a subscribed agent-audio
  // publication unless its speaker mute flag is already set, so muting only after
  // the first live status lets the agent's greeting play on the customer's
  // speakers. Both of the customer's microphone captures pick that up: the voice
  // is doubled with the salesperson's and the AI hears itself (repeated words).
  const harness = makeHarness();
  const { engine, sessions, restoreFetch } = harness;
  try {
    await engine.retryAi();
    const session = sessions[0];

    assert.deepEqual(session.joinCalls, ['wss://ai.invalid/join-1']);
    assert.deepEqual(
      session.speakerMutedAtJoin,
      [true],
      'the agent speaker must already be muted when the call is joined'
    );
    assert.equal(session.outputMedium, 'text', 'the agent is text-only from the start');
    assert.equal(session.speakerMuted, true);

    // The same guarantees survive a live status (the SDK may re-subscribe).
    session.setStatus(UltravoxSessionStatus.LISTENING);
    assert.equal(session.speakerMuted, true);
    assert.equal(session.outputMedium, 'text');
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});

test('a live SDK status is the only way to become connected, and audio reaching the AI is reported', async () => {
  const harness = makeHarness();
  const { engine, sessions, signals, restoreFetch } = harness;
  try {
    await engine.retryAi();
    const session = sessions[0];

    // No connected state before the SDK reports one.
    assert.equal(snapshot(engine).ai.connected, false);

    session.micSourceNode = {};
    session.setStatus(UltravoxSessionStatus.LISTENING);

    const state = snapshot(engine);
    assert.equal(state.ai.state, 'connected');
    assert.equal(state.ai.connected, true);
    assert.equal(state.aiStatus, UltravoxSessionStatus.LISTENING);
    assert.equal(state.ai.audioReachingAi, true);
    assert.equal(session.outputMedium, 'text', 'AI output stays text-only');

    const last = signals.filter((signal) => signal.type === 'ai_status').at(-1);
    assert.equal(last.state, 'connected');
    assert.equal(last.connected, true);
    assert.equal(last.audioReachingAi, true);

    engine.setMicMuted(true);
    assert.equal(snapshot(engine).ai.audioReachingAi, false);
    assert.equal(
      signals.filter((signal) => signal.type === 'ai_status').at(-1).audioReachingAi,
      false
    );
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});

test('an AI disconnect is reported with code and detail, and audio call state is untouched', async () => {
  const harness = makeHarness();
  const { engine, sessions, restoreFetch } = harness;
  try {
    await engine.retryAi();
    const session = sessions[0];
    session.micSourceNode = {};
    session.setStatus(UltravoxSessionStatus.LISTENING);

    // The engine's WebRTC state is independent of the AI lifecycle.
    (engine as any).callState = 'connected';

    session.emitError('Session socket closed abnormally. code=1006 reason=');

    const state = snapshot(engine);
    assert.equal(state.ai.state, 'reconnecting');
    assert.equal(state.ai.connected, false);
    assert.match(String(state.ai.error), /Session socket closed abnormally/);
    assert.match(String(state.ai.error), /code=1006/);
    assert.equal(state.callState, 'connected', 'the human call is NOT interrupted by an AI failure');
    assert.equal((engine as any).pc, null, 'no peer connection was created or disturbed');

    // A manual restart resets the bounded counter and asks for another new call.
    await engine.retryAi();
    assert.equal(snapshot(engine).ai.reconnectAttempt, 0);
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});


test('recovery after an abnormal close requests a new call and ignores stale callbacks from the dead session', async () => {
  const harness = makeHarness({ delays: [10, 10, 10] });
  const { engine, sessions, requests, restoreFetch } = harness;
  try {
    await engine.retryAi();
    const first = sessions[0];
    first.micSourceNode = {};
    first.setStatus(UltravoxSessionStatus.LISTENING);

    first.emitError('Session socket closed abnormally. code=1006 reason=');
    first.setStatus(UltravoxSessionStatus.DISCONNECTED);

    let state = snapshot(engine);
    assert.equal(state.ai.state, 'reconnecting');
    assert.equal(state.ai.reconnectAttempt, 1);
    await sleep(0);
    assert.equal(first.leaveCalls, 1, 'the dead session is torn down');

    await sleep(60);
    assert.equal(requests.length, 2, 'recovery requested a new call');
    assert.equal(requests[1].body.replace, true);
    assert.equal(sessions.length, 2, 'recovery created a new SDK session');
    assert.deepEqual(sessions[1].joinCalls, ['wss://ai.invalid/join-2']);

    const second = sessions[1];
    state = snapshot(engine);
    assert.equal(state.ai.callId, 'call_2');
    assert.equal(state.ai.state, 'connecting');

    // A late error/status from the OLD session must not overwrite the new one.
    first.emitError('Session socket closed abnormally. code=1006 reason=stale');
    first.setStatus(UltravoxSessionStatus.DISCONNECTED);
    await sleep(10);
    state = snapshot(engine);
    assert.equal(state.ai.callId, 'call_2');
    assert.equal(state.ai.state, 'connecting');
    assert.doesNotMatch(String(state.ai.error ?? ''), /stale/);

    // The new session can still become live.
    second.micSourceNode = {};
    second.setStatus(UltravoxSessionStatus.LISTENING);
    assert.equal(snapshot(engine).ai.connected, true);
    assert.equal(snapshot(engine).ai.callId, 'call_2');
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});

test('automatic recovery is bounded and surfaces the real failure instead of a false connected state', async () => {
  const failingFetch = (async () => {
    throw new Error('connect ECONNREFUSED api.ultravox.ai:443');
  }) as unknown as typeof fetch;
  const harness = makeHarness({ delays: [5, 5, 5], fetchImpl: failingFetch });
  const { engine, snapshots, restoreFetch } = harness;
  try {
    await engine.retryAi();

    // Initial attempt + 3 bounded recoveries, then it must stop.
    const started = Date.now();
    while (Date.now() - started < 1000) {
      const state = snapshot(engine);
      if (state.ai.state === 'error' && /stopped after 3 attempts/.test(String(state.ai.error))) break;
      await sleep(20);
    }

    const state = snapshot(engine);
    assert.equal(state.ai.state, 'error');
    assert.equal(state.ai.connected, false);
    assert.equal(state.aiStatus, 'error');
    assert.match(String(state.ai.error), /stopped after 3 attempts/);
    assert.match(String(state.ai.error), /ECONNREFUSED/);

    const attempts = snapshots.filter((item) => item.ai.state === 'reconnecting').length;
    assert.ok(attempts >= 3, `expected at least 3 recovery attempts, saw ${attempts}`);

    // No infinite retry loop: no further state changes once exhausted.
    const emitted = snapshots.length;
    await sleep(120);
    assert.equal(snapshots.length, emitted, 'no further recovery attempts after the bound');
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});


test('concurrent retry requests do not create duplicate calls', async () => {
  let resolveFetch: (value: Response) => void = () => undefined;
  const slowFetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
  const harness = makeHarness({ fetchImpl: slowFetch });
  const { engine, sessions, restoreFetch } = harness;
  try {
    const first = engine.retryAi();
    await sleep(0);
    const second = engine.retryAi(); // must be ignored while the first is in flight
    await sleep(0);
    assert.equal(sessions.length, 0, 'no SDK session before the call exists');

    resolveFetch(
      new Response(JSON.stringify({ callId: 'call_slow', joinUrl: 'wss://ai.invalid/slow' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await Promise.all([first, second]);
    assert.equal(sessions.length, 1, 'exactly one SDK session despite two retry calls');
    assert.equal(snapshot(engine).ai.callId, 'call_slow');
  } finally {
    await engine.stop('test');
    restoreFetch();
  }
});

test('salesperson reconnects AI over signaling without touching the WebRTC peer connection', () => {
  const harness = makeHarness({ role: 'salesperson' });
  const { engine, signals, restoreFetch } = harness;
  restoreFetch();

  assert.equal((engine as any).pc, null, 'no peer connection exists in this test');
  engine.requestAiReconnect();

  const request = signals.find((signal) => signal.type === 'ai_reconnect');
  assert.ok(request, 'ai_reconnect is sent to the server');
  assert.equal(request.sessionId, 'session-test');
  assert.equal((engine as any).pc, null, 'AI reconnect must not create a peer connection');
});

test('salesperson displays the customer-reported AI state and sanitises failure detail', () => {
  const harness = makeHarness({ role: 'salesperson' });
  const { engine, restoreFetch } = harness;
  restoreFetch();

  (engine as any).handleSignal({
    type: 'ai_status',
    state: 'connected',
    connected: true,
    audioReachingAi: true,
    lastSuggestionAt: Date.now(),
    error: null,
  });
  let state = snapshot(engine);
  assert.equal(state.ai.state, 'connected');
  assert.equal(state.ai.connected, true);
  assert.equal(state.ai.audioReachingAi, true);
  assert.equal(state.aiStatus, 'connected');

  (engine as any).handleSignal({
    type: 'ai_status',
    state: 'error',
    connected: false,
    error:
      'Session socket closed abnormally. code=1006 reason= see wss://api.ultravox.ai/join?token=super-secret',
  });
  state = snapshot(engine);
  assert.equal(state.ai.state, 'error');
  assert.equal(state.ai.connected, false);
  assert.equal(state.aiStatus, 'error');
  assert.match(String(state.ai.error), /code=1006/);
  assert.doesNotMatch(String(state.ai.error), /super-secret/);
  assert.doesNotMatch(String(state.ai.error), /wss:\/\//);

  // A claimed "connected" with a non-connected state is not trusted.
  (engine as any).handleSignal({ type: 'ai_status', state: 'closed', connected: true });
  assert.equal(snapshot(engine).ai.connected, false);
});

