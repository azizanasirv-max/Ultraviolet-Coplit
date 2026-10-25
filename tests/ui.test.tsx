/**
 * Customer/salesperson presentation and data-flow tests.
 *
 * Component tests render to static markup (no browser, no audio). Engine tests
 * use a fake WebSocket and a fake speech recogniser: they verify which inbound
 * frames each role accepts and that the salesperson never creates an Ultravox
 * session. They do NOT prove physical-device audio quality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CallEngine, EngineSnapshot, SuggestionCard } from '../src/lib/callEngine';
import {
  buildCustomerCallView,
  customerPhaseFor,
  formatDuration,
} from '../src/lib/customerCallView';
import { CustomerCallScreen } from '../src/components/prototype2/CustomerCallScreen';
import { AiSuggestionPanel, CustomerTranscriptPanel } from '../src/components/prototype2/SalespersonPanels';

(globalThis as any).window = {
  setTimeout: (handler: (...args: any[]) => void, timeout?: number) =>
    setTimeout(handler, timeout) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  setInterval: (handler: (...args: any[]) => void, timeout?: number) =>
    setInterval(handler, timeout) as unknown as number,
  clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
};

const baseSnapshot = (overrides: Partial<EngineSnapshot> = {}): EngineSnapshot =>
  ({
    sessionId: 'session-1',
    role: 'customer',
    participantId: 'participant-1',
    wsStatus: 'connected',
    callState: 'connected',
    peerPresent: true,
    peerParticipantId: 'participant-2',
    peerRole: 'salesperson',
    participants: [],
    micPermission: 'granted',
    micMuted: false,
    localTrackState: 'live',
    localTrackMuted: false,
    localSenderCount: 1,
    remoteTrackState: 'live',
    speakerMuted: false,
    audioUnlocked: true,
    playbackBlocked: false,
    aiStatus: 'connected',
    aiError: null,
    ai: {
      state: 'connected',
      status: null,
      connected: true,
      error: 'SECRET_PROVIDER_ERROR',
      callId: 'call_SECRET_ID',
      reconnectAttempt: 2,
      maxReconnectAttempts: 3,
      reconnecting: false,
      audioReachingAi: true,
      lastEventAt: Date.now(),
      lastSuggestionAt: Date.now(),
      lastResponseAt: Date.now(),
      source: 'local',
    },
    aiReconnectRequestedAt: null,
    suggestions: [
      { id: '1', ordinal: 1, text: 'SECRET_AI_SUGGESTION: offer a discount', isFinal: true, timestamp: '10:00' },
    ],
    customerSpeech: 'SECRET_CUSTOMER_SPEECH',
    customerTranscript: [],
    salespersonTranscript: [],
    transcript: { status: 'inactive', error: null, peerState: 'live', peerDetail: null },
    reconnectAttempt: 0,
    lastError: null,
    lastServerError: null,
    iceConfigLoaded: true,
    iceConfigError: null,
    iceConfigWarnings: [],
    turnConfigured: true,
    turnCredentialMode: 'ephemeral',
    turnExpiresAt: null,
    relayCandidates: 1,
    selectedPair: 'relay → relay',
    mediaFlowing: true,
    diagnostics: {} as EngineSnapshot['diagnostics'],
    logs: ['SECRET_DIAGNOSTIC_LOG'],
    ...overrides,
  }) as EngineSnapshot;

test('the customer call view cannot carry private assistant state', () => {
  const view = buildCustomerCallView({
    snapshot: baseSnapshot({
      salespersonTranscript: [
        { ordinal: 1, text: 'Hi, thanks for taking my call.', isFinal: true, at: 1 },
        { ordinal: 2, text: 'Our starter plan', isFinal: false, at: 2 },
      ],
    }),
    sessionLabel: 'Sales call with Dana',
    durationSeconds: 75,
    joined: true,
  });

  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /SECRET_/);
  assert.doesNotMatch(serialized, /"ai"|suggestion|copilot|ultravox|callId/i);
  assert.equal(view.salespersonLabel, 'Dana');
  assert.equal(view.phase, 'connected');
  assert.equal(view.transcript.length, 2);
  assert.equal(view.transcript[0].text, 'Hi, thanks for taking my call.');
  assert.equal(view.durationSeconds, 75);
});

test('call states map to the labels a caller expects', () => {
  assert.equal(customerPhaseFor(baseSnapshot({ callState: 'waiting' }), true), 'waiting');
  assert.equal(customerPhaseFor(baseSnapshot({ callState: 'connecting' }), true), 'connecting');
  assert.equal(customerPhaseFor(baseSnapshot({ callState: 'disconnected' }), true), 'reconnecting');
  assert.equal(customerPhaseFor(baseSnapshot({ callState: 'ended' }), true), 'ended');
  assert.equal(customerPhaseFor(baseSnapshot({ callState: 'failed' }), true), 'error');
  assert.equal(customerPhaseFor(null, false), 'prejoin');

  const waiting = buildCustomerCallView({
    snapshot: baseSnapshot({ callState: 'waiting' }),
    durationSeconds: null,
    joined: true,
  });
  assert.equal(waiting.headline, 'Ringing');

  const denied = buildCustomerCallView({
    snapshot: baseSnapshot({ micPermission: 'denied', callState: 'mic_denied' }),
    durationSeconds: null,
    joined: true,
  });
  assert.match(String(denied.notice?.message), /microphone/i);

  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(75), '01:15');
  assert.equal(formatDuration(3675), '1:01:15');
});

test('the customer call screen renders only call UI', () => {
  const view = buildCustomerCallView({
    snapshot: baseSnapshot({
      salespersonTranscript: [{ ordinal: 1, text: 'The onboarding is included.', isFinal: true, at: 1 }],
    }),
    sessionLabel: 'Sales call with Dana',
    durationSeconds: 12,
    joined: true,
  });

  const html = renderToStaticMarkup(
    <CustomerCallScreen
      view={view}
      onJoin={() => undefined}
      onMuteToggle={() => undefined}
      onSpeakerToggle={() => undefined}
      onEndCall={() => undefined}
      onReconnect={() => undefined}
    />
  );

  // Ordinary call UI is present.
  assert.match(html, /Dana/);
  assert.match(html, /The onboarding is included\./);
  assert.match(html, /data-testid="mic-toggle"/);
  assert.match(html, /data-testid="leave-call"/);
  assert.match(html, /data-testid="customer-transcript"/);
  assert.match(html, /00:12/);

  // No private assistant content, even as hidden markup or attributes.
  assert.doesNotMatch(html, /SECRET_/);
  assert.doesNotMatch(html, /\bAI\b/);
  assert.doesNotMatch(html, /suggestion|copilot|ultravox|diagnostic|callId/i);
});

test('a finished call shows the ended state without a live transcript', () => {
  const view = buildCustomerCallView({
    snapshot: baseSnapshot({ callState: 'ended' }),
    durationSeconds: 30,
    joined: true,
  });
  const html = renderToStaticMarkup(
    <CustomerCallScreen
      view={view}
      onJoin={() => undefined}
      onMuteToggle={() => undefined}
      onSpeakerToggle={() => undefined}
      onEndCall={() => undefined}
      onReconnect={() => undefined}
    />
  );
  assert.match(html, /Call ended/);
  assert.doesNotMatch(html, /data-testid="customer-transcript"/);
});

test('salesperson panels separate AI suggestions from customer speech', () => {
  const suggestions: SuggestionCard[] = [
    { id: 'a', ordinal: 1, text: 'Ask about their renewal date.', isFinal: true, timestamp: '10:00' },
  ];
  const suggestionHtml = renderToStaticMarkup(
    <AiSuggestionPanel
      suggestions={suggestions}
      ai={{
        label: 'AI connected',
        connected: true,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 3,
        error: null,
      }}
      onReconnect={() => undefined}
      disabled={false}
    />
  );
  assert.match(suggestionHtml, /Ask about their renewal date\./);
  assert.match(suggestionHtml, /not spoken by the customer/);
  assert.match(suggestionHtml, /data-testid="ai-state"/);
  assert.doesNotMatch(suggestionHtml, /Customer said/);

  const transcriptHtml = renderToStaticMarkup(
    <CustomerTranscriptPanel
      segments={[
        { ordinal: 1, text: 'We need this by Friday.', isFinal: true, at: 1 },
        { ordinal: 2, text: 'and the', isFinal: false, at: 2 },
      ]}
      customerSpeech="and the"
      aiLive
    />
  );
  assert.match(transcriptHtml, /We need this by Friday\./);
  assert.match(transcriptHtml, /data-final="false"/);
  assert.doesNotMatch(transcriptHtml, /renewal date/);
});

// ---------------------------------------------------------------------------
// Engine routing (fake sockets + fake recogniser; no media, no provider)
// ---------------------------------------------------------------------------

class FakeAiSession extends EventTarget {
  status = 'disconnected';
  transcripts: any[] = [];
  micSourceNode: unknown = {};
  joinCall(): void {}
  async leaveCall(): Promise<void> {}
  setOutputMedium(): void {}
  muteSpeaker(): void {}
  muteMic(): void {}
  unmuteMic(): void {}
}

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  starts = 0;
  stops = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  start(): void { this.starts += 1; this.onstart?.(); }
  stop(): void { this.stops += 1; this.onend?.(); }
}

const makeEngine = (role: 'customer' | 'salesperson', options: { recognition?: FakeRecognition } = {}) => {
  const signals: any[] = [];
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const sessions: FakeAiSession[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ callId: 'call_1', joinUrl: 'wss://ai.invalid/join', isReused: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const engine = new CallEngine({
    sessionId: 'session-1',
    role,
    credential: 'credential-1',
    enableAi: true,
    enableTranscript: true,
    createSpeechRecognition: () => options.recognition ?? null,
    createAiSession: () => {
      const session = new FakeAiSession();
      sessions.push(session);
      return session as unknown as any;
    },
    onUpdate: () => undefined,
  });
  (engine as any).ws = {
    readyState: 1,
    send: (raw: string) => signals.push(JSON.parse(raw)),
  };

  return {
    engine,
    signals,
    requests,
    sessions,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

test('the customer merges salesperson captions and ignores AI frames', async () => {
  const harness = makeEngine('customer');
  try {
    const engine = harness.engine;
    (engine as any).handleSignal({ type: 'salesperson_transcript', text: 'Thanks for', isFinal: false, ordinal: 0 });
    (engine as any).handleSignal({ type: 'salesperson_transcript', text: 'Thanks for joining.', isFinal: true, ordinal: 0 });
    (engine as any).handleSignal({ type: 'salesperson_transcript', text: 'Thanks for joining.', isFinal: true, ordinal: 0 });

    const snapshot = engine.getSnapshot();
    assert.equal(snapshot.salespersonTranscript.length, 1, 'no duplicated captions');
    assert.equal(snapshot.salespersonTranscript[0].text, 'Thanks for joining.');
    assert.equal(snapshot.transcript.peerState, 'live');

    // Frames that only the salesperson may consume are ignored here.
    (engine as any).handleSignal({ type: 'ai_suggestion', text: 'SECRET', isFinal: true, ordinal: 3 });
    (engine as any).handleSignal({ type: 'customer_speech_transcript', text: 'SECRET', ordinal: 4, isFinal: true });
    assert.equal(engine.getSnapshot().suggestions.length, 0);
    assert.equal(engine.getSnapshot().customerTranscript.length, 0);
  } finally {
    await harness.engine.stop('test').catch(() => undefined);
    harness.restore();
  }
});

test('the salesperson receives customer speech and private AI suggestions', async () => {
  const harness = makeEngine('salesperson');
  try {
    const engine = harness.engine;
    (engine as any).handleSignal({ type: 'customer_speech_transcript', text: 'We need', isFinal: false, ordinal: 0 });
    (engine as any).handleSignal({ type: 'customer_speech_transcript', text: 'We need it by Friday.', isFinal: true, ordinal: 0 });
    (engine as any).handleSignal({ type: 'ai_suggestion', text: 'Offer the weekly plan.', isFinal: true, ordinal: 1 });

    const snapshot = engine.getSnapshot();
    assert.equal(snapshot.customerTranscript.length, 1);
    assert.equal(snapshot.customerTranscript[0].text, 'We need it by Friday.');
    assert.equal(snapshot.suggestions.length, 1);
    assert.equal(snapshot.suggestions[0].text, 'Offer the weekly plan.');

    // A salesperson engine must not accept customer-only transcript frames.
    (engine as any).handleSignal({ type: 'salesperson_transcript', text: 'self', ordinal: 9 });
    assert.equal(engine.getSnapshot().salespersonTranscript.length, 0);
  } finally {
    await harness.engine.stop('test').catch(() => undefined);
    harness.restore();
  }
});

test('the salesperson engine never creates an Ultravox session', async () => {
  const harness = makeEngine('salesperson');
  try {
    const engine = harness.engine;
    (engine as any).handleJoined({
      participantId: 'sales-1',
      resumeToken: 'resume',
      peers: [],
      participants: [],
      session: { sessionId: 'session-1' },
      ai: { state: 'connected', connected: true },
    });
    await (engine as any).retryAi();

    assert.equal(harness.sessions.length, 0, 'no Ultravox SDK session on the salesperson device');
    assert.equal(
      harness.requests.filter((request) => request.url.includes('/ultravox-call')).length,
      0,
      'the salesperson never requests a paid AI call'
    );
    assert.equal(engine.getSnapshot().ai.state, 'connected', 'the relayed state is displayed');
    assert.equal(
      engine.getSnapshot().ai.source,
      'remote',
      'salesperson AI state is always the customer-reported copy'
    );
  } finally {
    await harness.engine.stop('test').catch(() => undefined);
    harness.restore();
  }
});

test('only the customer device requests the AI call', async () => {
  const harness = makeEngine('customer');
  try {
    await (harness.engine as any).retryAi();
    assert.equal(harness.requests.length, 1);
    assert.match(harness.requests[0].url, /\/api\/sessions\/session-1\/ultravox-call$/);
    assert.equal(harness.requests[0].body.replace, true);
    assert.equal(harness.requests[0].headers.Authorization, 'Bearer credential-1');
    assert.equal(harness.sessions.length, 1);
  } finally {
    await harness.engine.stop('test').catch(() => undefined);
    harness.restore();
  }
});

test('muting the salesperson pauses customer-facing captions', async () => {
  const recognition = new FakeRecognition();
  const harness = makeEngine('salesperson', { recognition });
  try {
    const engine = harness.engine;
    (engine as any).localStream = {
      getAudioTracks: () => [{ enabled: true, readyState: 'live', muted: false }],
    };
    (engine as any).handleJoined({
      participantId: 'sales-1',
      peers: [],
      participants: [],
      session: { sessionId: 'session-1' },
    });
    assert.equal(recognition.starts, 1, 'captions start when the salesperson joins');

    engine.setMicMuted(true);
    assert.ok(recognition.stops >= 1, 'muted speech is not captioned for the customer');
  } finally {
    harness.restore();
  }
});
