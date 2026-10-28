/**
 * Customer transcript segment tests.
 *
 * Two layers are covered here:
 *   1. the pure segment store (`src/lib/customerTranscript.ts`), which owns the
 *      ordering, de-duplication and stale-session rules;
 *   2. the real `CallEngine` transcript forwarding using its fake Ultravox SDK.
 *
 * These tests prove event handling and text preservation only. They do NOT
 * prove speech-recognition accuracy, language detection or audio quality: the
 * SDK exposes no language/confidence metadata and real recognition requires
 * representative recordings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Role, UltravoxSessionStatus } from 'ultravox-client';
import { CallEngine } from '../src/lib/callEngine';
import {
  applyCustomerTranscriptEvent,
  bindCustomerTranscriptSession,
  createCustomerTranscriptState,
  latestCustomerTranscriptSegment,
  latestFinalCustomerTranscriptSegment,
  CUSTOMER_TRANSCRIPT_MAX_SEGMENTS,
} from '../src/lib/customerTranscript';

const segmentTexts = (state: ReturnType<typeof createCustomerTranscriptState>) =>
  state.segments.map((segment) => segment.text);

const applyAll = (
  events: Array<{ text: string; isFinal: boolean; ordinal: number; callId?: string; medium?: string }>,
  callId: string | null = null
) => {
  let state = createCustomerTranscriptState(callId);
  for (const event of events) state = applyCustomerTranscriptEvent(state, event).state;
  return state;
};

test('partial updates replace the same ordinal instead of appending text', () => {
  let state = createCustomerTranscriptState('call-a');
  const first = applyCustomerTranscriptEvent(state, {
    text: 'I need the',
    isFinal: false,
    ordinal: 4,
    callId: 'call-a',
    medium: 'voice',
  });
  assert.equal(first.applied, true);
  state = first.state;

  const second = applyCustomerTranscriptEvent(state, {
    text: 'I need the enterprise plan',
    isFinal: false,
    ordinal: 4,
    callId: 'call-a',
  });
  assert.equal(second.applied, true);
  assert.equal(second.state.segments.length, 1);
  assert.equal(second.state.segments[0].text, 'I need the enterprise plan');

  const final = applyCustomerTranscriptEvent(second.state, {
    text: 'I need the enterprise plan.',
    isFinal: true,
    ordinal: 4,
    callId: 'call-a',
  });
  assert.equal(final.state.segments.length, 1, 'still exactly one segment for ordinal 4');
  assert.equal(final.state.segments[0].text, 'I need the enterprise plan.');
  assert.equal(final.state.segments[0].isFinal, true);
  assert.equal(
    final.state.segments[0].medium,
    'voice',
    'available SDK metadata is preserved across updates, nothing else is invented'
  );
});

test('a final segment is represented exactly once even if the SDK re-emits it', () => {
  const state = applyAll([
    { text: 'We have forty seats.', isFinal: true, ordinal: 1, callId: 'call-a' },
    { text: 'We have forty seats.', isFinal: true, ordinal: 1, callId: 'call-a' },
    { text: 'We have forty seats.', isFinal: true, ordinal: 1, callId: 'call-a' },
  ]);
  assert.equal(state.segments.length, 1);
  assert.deepEqual(segmentTexts(state), ['We have forty seats.']);
});

test('legitimate repeated words are preserved verbatim', () => {
  const text = 'No, no. I said the the price is is too high, very very high.';
  const state = applyAll([{ text, isFinal: true, ordinal: 2 }]);
  assert.equal(state.segments[0].text, text);
  assert.ok(state.segments[0].text.includes('the the'));
  assert.ok(state.segments[0].text.includes('is is'));
  assert.ok(state.segments[0].text.includes('very very'));
});


test('out-of-order, duplicate and stale partial events never corrupt the transcript', () => {
  let state = createCustomerTranscriptState('call-a');
  // Ordinal 2 arrives before ordinal 1. Each utterance stays separate and the
  // display order is ordinal order, not arrival order.
  state = applyCustomerTranscriptEvent(state, {
    text: 'Second sentence.',
    isFinal: true,
    ordinal: 2,
    callId: 'call-a',
  }).state;
  state = applyCustomerTranscriptEvent(state, {
    text: 'First sentence.',
    isFinal: true,
    ordinal: 1,
    callId: 'call-a',
  }).state;
  assert.deepEqual(segmentTexts(state), ['First sentence.', 'Second sentence.']);

  // A late partial for the finalized ordinal 2 cannot reopen or shorten it.
  const stalePartial = applyCustomerTranscriptEvent(state, {
    text: 'Second',
    isFinal: false,
    ordinal: 2,
    callId: 'call-a',
  });
  assert.equal(stalePartial.applied, false);
  assert.equal(stalePartial.reason, 'stale-partial');
  assert.equal(stalePartial.state.segments[1].text, 'Second sentence.');

  // A shorter late partial for an in-progress ordinal is ignored; a longer one
  // replaces it (the SDK sends the full text so far).
  let live = applyCustomerTranscriptEvent(stalePartial.state, {
    text: 'Third partial text',
    isFinal: false,
    ordinal: 3,
    callId: 'call-a',
  }).state;
  const shorter = applyCustomerTranscriptEvent(live, {
    text: 'Third',
    isFinal: false,
    ordinal: 3,
    callId: 'call-a',
  });
  assert.equal(shorter.applied, false);
  live = applyCustomerTranscriptEvent(live, {
    text: 'Third partial text is longer',
    isFinal: false,
    ordinal: 3,
    callId: 'call-a',
  }).state;
  assert.equal(live.segments[2].text, 'Third partial text is longer');

  // Garbage payloads are rejected without deleting existing speech.
  for (const event of [
    { text: '   ', isFinal: true, ordinal: 4 },
    { text: 'No ordinal', isFinal: true, ordinal: Number.NaN },
    { text: 42, isFinal: true, ordinal: 4 },
  ]) {
    const result = applyCustomerTranscriptEvent(live, event as never);
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'invalid');
    assert.equal(result.state.segments.length, live.segments.length);
  }
});

test('a new Ultravox call cannot inherit segments from the previous call', () => {
  let state = applyAll(
    [
      { text: 'From the old call.', isFinal: true, ordinal: 1, callId: 'call-old' },
      { text: 'Also old.', isFinal: true, ordinal: 2, callId: 'call-old' },
    ],
    'call-old'
  );
  assert.equal(state.segments.length, 2);

  const rebound = bindCustomerTranscriptSession(state, 'call-new');
  assert.equal(rebound.callId, 'call-new');
  assert.equal(rebound.segments.length, 0, 'ordinals restart, so old segments are dropped');

  // A delayed transcript from the replaced call must not appear in the new one.
  const stale = applyCustomerTranscriptEvent(rebound, {
    text: 'Delayed old speech.',
    isFinal: true,
    ordinal: 1,
    callId: 'call-old',
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale-session');
  assert.equal(stale.state.segments.length, 0);

  const fresh = applyCustomerTranscriptEvent(stale.state, {
    text: 'Fresh call speech.',
    isFinal: true,
    ordinal: 1,
    callId: 'call-new',
  });
  assert.equal(fresh.applied, true);
  assert.deepEqual(segmentTexts(fresh.state), ['Fresh call speech.']);
});

test('mixed-language and code-switching speech is preserved exactly', () => {
  const fixtures = [
    { text: 'Quiero el plan básico, but I need it for my team of twenty.' },
    { text: 'أحتاج عرض السعر, and can you send it by email?' },
    { text: 'Je veux le forfait entreprise, mais le budget est limité cette année.' },
    { text: 'Hindi mein: mujhe do seats chahiye, aur invoice PDF mein bhej dena.' },
    { text: 'Zusätzliche Nutzer kosten extra, right?' },
  ];
  const state = applyAll(
    fixtures.map((fixture, index) => ({ text: fixture.text, isFinal: true, ordinal: index }))
  );
  assert.deepEqual(segmentTexts(state), fixtures.map((fixture) => fixture.text));
  // No language labels exist in the SDK payload, so the store never invents one.
  for (const segment of state.segments) {
    assert.equal('language' in segment, false);
    assert.equal('confidence' in segment, false);
  }
});

test('the latest final utterance is exposed separately from partial text', () => {
  const state = applyAll([
    { text: 'First final.', isFinal: true, ordinal: 0 },
    { text: 'Second final.', isFinal: true, ordinal: 1 },
    { text: 'Live partial', isFinal: false, ordinal: 2 },
  ]);
  assert.equal(latestCustomerTranscriptSegment(state)?.text, 'Live partial');
  assert.equal(latestFinalCustomerTranscriptSegment(state)?.text, 'Second final.');
});

test('transcript state is bounded without dropping an in-progress utterance', () => {
  let state = createCustomerTranscriptState('call-a');
  for (let ordinal = 0; ordinal < CUSTOMER_TRANSCRIPT_MAX_SEGMENTS + 5; ordinal += 1) {
    state = applyCustomerTranscriptEvent(state, {
      text: `Utterance ${ordinal}`,
      isFinal: true,
      ordinal,
      callId: 'call-a',
    }).state;
  }
  assert.equal(state.segments.length, CUSTOMER_TRANSCRIPT_MAX_SEGMENTS);
  assert.equal(state.segments[0].text, 'Utterance 5');
  const live = applyCustomerTranscriptEvent(state, {
    text: 'Still speaking',
    isFinal: false,
    ordinal: CUSTOMER_TRANSCRIPT_MAX_SEGMENTS + 5,
    callId: 'call-a',
  });
  assert.equal(live.applied, true);
  assert.equal(live.state.segments.length, CUSTOMER_TRANSCRIPT_MAX_SEGMENTS);
  assert.equal(live.state.segments[live.state.segments.length - 1].text, 'Still speaking');
});


// ---------------------------------------------------------------------------
// Engine forwarding (fake SDK)
// ---------------------------------------------------------------------------

(globalThis as any).window = {
  setTimeout: (handler: (...args: any[]) => void, timeout?: number) =>
    setTimeout(handler, timeout) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  setInterval: (handler: (...args: any[]) => void, timeout?: number) =>
    setInterval(handler, timeout) as unknown as number,
  clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
};

class FakeSession extends EventTarget {
  status: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;
  transcripts: Array<{
    text: string;
    isFinal: boolean;
    speaker: Role;
    medium: string;
    ordinal: number;
  }> = [];
  micSourceNode: unknown = undefined;

  setStatus(status: UltravoxSessionStatus): void {
    this.status = status;
    this.dispatchEvent(new Event('status'));
  }

  joinCall(): void {
    this.setStatus(UltravoxSessionStatus.CONNECTING);
  }

  async leaveCall(): Promise<void> {
    this.setStatus(UltravoxSessionStatus.DISCONNECTED);
  }

  setOutputMedium(): void {}
  muteSpeaker(): void {}
  muteMic(): void {}
  unmuteMic(): void {}

  /** Mirrors the SDK: replace by ordinal, then emit the whole array. */
  emitTranscript(transcript: {
    text: string;
    isFinal: boolean;
    speaker: Role;
    ordinal: number;
    medium?: string;
  }): void {
    const index = this.transcripts.findIndex((item) => item.ordinal === transcript.ordinal);
    const value = { ...transcript, medium: transcript.medium ?? 'voice' };
    if (index >= 0) this.transcripts[index] = value;
    else this.transcripts.push(value);
    this.dispatchEvent(new Event('transcripts'));
  }

  emitError(message: string): void {
    const event = new Event('error') as Event & { error: Error };
    event.error = new Error(message);
    this.dispatchEvent(event);
  }
}

const makeEngine = (options: { role?: 'customer' | 'salesperson' } = {}) => {
  const sessions: FakeSession[] = [];
  const signals: any[] = [];
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    return new Response(
      JSON.stringify({
        callId: `call-${callCount}`,
        joinUrl: `wss://ai.invalid/join-${callCount}`,
        isReused: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const engine = new CallEngine({
    sessionId: 'session-test',
    role: options.role ?? 'customer',
    credential: 'credential-test',
    enableAi: true,
    apiBase: '',
    onUpdate: () => undefined,
    createAiSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session as unknown as any;
    },
  });
  (engine as any).ws = {
    readyState: 1,
    send: (raw: string) => signals.push(JSON.parse(raw)),
  };
  return {
    engine,
    sessions,
    signals,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const customerTranscriptSignals = (signals: any[]) =>
  signals.filter((signal) => signal.type === 'customer_speech_transcript');

test('engine forwards every partial once and the final once, and never re-sends older finals', async () => {
  const harness = makeEngine();
  try {
    await harness.engine.retryAi();
    const session = harness.sessions[0];
    session.setStatus(UltravoxSessionStatus.LISTENING);

    session.emitTranscript({ text: 'I need', isFinal: false, speaker: Role.USER, ordinal: 0 });
    session.emitTranscript({ text: 'I need two seats', isFinal: false, speaker: Role.USER, ordinal: 0 });
    session.emitTranscript({ text: 'I need two seats.', isFinal: true, speaker: Role.USER, ordinal: 0 });

    // A later utterance re-emits the whole SDK array: ordinal 0 must not be sent again.
    session.emitTranscript({ text: 'And annual billing', isFinal: false, speaker: Role.USER, ordinal: 1 });
    session.emitTranscript({ text: 'And annual billing please.', isFinal: false, speaker: Role.USER, ordinal: 1 });

    const forwarded = customerTranscriptSignals(harness.signals);
    const ordinal0 = forwarded.filter((signal) => signal.ordinal === 0);
    assert.equal(ordinal0.length, 3, 'two partial updates and one final, no repeat');
    assert.deepEqual(
      ordinal0.map((signal) => [signal.text, signal.isFinal]),
      [
        ['I need', false],
        ['I need two seats', false],
        ['I need two seats.', true],
      ]
    );
    assert.equal(ordinal0.filter((signal) => signal.isFinal).length, 1);
    assert.equal(forwarded.filter((signal) => signal.ordinal === 1).length, 2);
    assert.equal(forwarded.every((signal) => signal.callId === 'call-1'), true);
    assert.equal(forwarded.every((signal) => signal.medium === 'voice'), true);
  } finally {
    await harness.engine.stop('test');
    harness.restore();
  }
});

test('engine preserves repeated words and mixed-language text byte-for-byte', async () => {
  const harness = makeEngine();
  try {
    await harness.engine.retryAi();
    const session = harness.sessions[0];
    session.setStatus(UltravoxSessionStatus.LISTENING);

    const repeated = 'No, no, the the price is is final.';
    const mixed = 'Quiero el plan básico, but I need it for my team.';
    session.emitTranscript({ text: repeated, isFinal: true, speaker: Role.USER, ordinal: 0 });
    session.emitTranscript({ text: mixed, isFinal: true, speaker: Role.USER, ordinal: 1 });

    const forwarded = customerTranscriptSignals(harness.signals);
    assert.deepEqual(
      forwarded.map((signal) => signal.text),
      [repeated, mixed]
    );
  } finally {
    await harness.engine.stop('test');
    harness.restore();
  }
});

test('an AI session failure stops transcript forwarding but leaves the call engine intact', async () => {
  const harness = makeEngine();
  try {
    await harness.engine.retryAi();
    const session = harness.sessions[0];
    session.setStatus(UltravoxSessionStatus.LISTENING);
    session.emitTranscript({ text: 'Before the failure.', isFinal: true, speaker: Role.USER, ordinal: 0 });

    session.emitError('connect ECONNREFUSED api.ultravox.ai:443');
    // A transcript callback queued before the failure must be ignored as stale.
    session.emitTranscript({ text: 'After the failure.', isFinal: true, speaker: Role.USER, ordinal: 1 });

    const texts = customerTranscriptSignals(harness.signals).map((signal) => signal.text);
    assert.deepEqual(texts, ['Before the failure.']);
    const state = harness.engine.getSnapshot();
    assert.notEqual(state.callState, 'failed', 'the human call is not failed by AI');
    assert.equal(state.ai.connected, false);
    assert.ok(
      state.ai.state === 'error' || state.ai.state === 'reconnecting',
      `the AI failure is visible (state ${state.ai.state})`
    );
  } finally {
    await harness.engine.stop('test');
    harness.restore();
  }
});

test('a reconnect creates a new AI call and a new forwarding ordinal space', async () => {
  const harness = makeEngine();
  try {
    await harness.engine.retryAi();
    const first = harness.sessions[0];
    first.setStatus(UltravoxSessionStatus.LISTENING);
    first.emitTranscript({ text: 'Old session speech.', isFinal: true, speaker: Role.USER, ordinal: 0 });

    await harness.engine.retryAi();
    const second = harness.sessions[1];
    assert.notEqual(first, second);
    second.setStatus(UltravoxSessionStatus.LISTENING);
    // The new call's ordinal 0 is a different utterance; it must be forwarded,
    // not suppressed by the previous call's ordinal 0.
    second.emitTranscript({ text: 'New session speech.', isFinal: true, speaker: Role.USER, ordinal: 0 });

    const forwarded = customerTranscriptSignals(harness.signals);
    assert.deepEqual(
      forwarded.map((signal) => signal.text),
      ['Old session speech.', 'New session speech.']
    );
    assert.notEqual(forwarded[0].callId, forwarded[1].callId);
    assert.equal(forwarded[1].callId, 'call-2');
  } finally {
    await harness.engine.stop('test');
    harness.restore();
  }
});

test('the salesperson transcript view de-duplicates ordinals and rejects stale-session events', async () => {
  const harness = makeEngine({ role: 'salesperson' });
  const handle = (payload: Record<string, unknown>) =>
    (harness.engine as any).handleSignal({ sessionId: 'session-test', ...payload });
  try {
    await handle({ type: 'ai_status', state: 'connected', connected: true, callId: 'call-A' });
    await handle({
      type: 'customer_speech_transcript',
      text: 'I need',
      isFinal: false,
      ordinal: 0,
      callId: 'call-A',
      medium: 'voice',
    });
    await handle({
      type: 'customer_speech_transcript',
      text: 'I need the pro plan',
      isFinal: false,
      ordinal: 0,
      callId: 'call-A',
    });
    await handle({
      type: 'customer_speech_transcript',
      text: 'I need the pro plan.',
      isFinal: true,
      ordinal: 0,
      callId: 'call-A',
    });
    // Duplicate final: exactly one segment, and it is the final text.
    await handle({
      type: 'customer_speech_transcript',
      text: 'I need the pro plan.',
      isFinal: true,
      ordinal: 0,
      callId: 'call-A',
    });

    let state = harness.engine.getSnapshot();
    assert.equal(state.customerTranscript.segments.length, 1);
    assert.equal(state.customerTranscript.segments[0].text, 'I need the pro plan.');
    assert.equal(state.customerTranscript.segments[0].isFinal, true);
    assert.equal(state.customerTranscript.segments[0].medium, 'voice');
    assert.equal(state.customerSpeech, 'I need the pro plan.');

    // A new Ultravox call resets the view before its own ordinal 0 arrives.
    await handle({ type: 'ai_status', state: 'connected', connected: true, callId: 'call-B' });
    state = harness.engine.getSnapshot();
    assert.equal(state.customerTranscript.segments.length, 0);
    assert.equal(state.customerSpeech, '');

    // A delayed segment from call A must not leak into call B.
    await handle({
      type: 'customer_speech_transcript',
      text: 'Delayed old speech.',
      isFinal: true,
      ordinal: 0,
      callId: 'call-A',
    });
    state = harness.engine.getSnapshot();
    assert.equal(state.customerTranscript.segments.length, 0);

    await handle({
      type: 'customer_speech_transcript',
      text: 'Fresh call speech.',
      isFinal: true,
      ordinal: 0,
      callId: 'call-B',
    });
    state = harness.engine.getSnapshot();
    assert.deepEqual(
      state.customerTranscript.segments.map((segment) => segment.text),
      ['Fresh call speech.']
    );
  } finally {
    await harness.engine.stop('test');
    harness.restore();
  }
});

