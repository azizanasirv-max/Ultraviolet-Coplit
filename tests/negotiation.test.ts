/**
 * Deterministic negotiation / recovery tests for CallEngine.
 *
 * IMPORTANT: these tests inject a fake `RTCPeerConnection`, a fake WebSocket and
 * a fake `UltravoxSession`. They prove the signaling state machine, offer
 * de-duplication, bounded ICE-restart recovery and terminal-failure behaviour.
 * They do NOT prove real network connectivity; `tests/browser-audio.test.ts`
 * exercises the real Chromium WebRTC stack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UltravoxSessionStatus } from 'ultravox-client';
import { CallEngine } from '../src/lib/callEngine';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Browser environment shims
// ---------------------------------------------------------------------------

const timerWindow = {
  setTimeout: (handler: (...args: any[]) => void, timeout?: number) =>
    setTimeout(handler, timeout) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  setInterval: (handler: (...args: any[]) => void, timeout?: number) =>
    setInterval(handler, timeout) as unknown as number,
  clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
  location: { protocol: 'http:', host: 'localhost:3000' },
  SpeechRecognition: undefined,
  webkitSpeechRecognition: undefined,
};
(globalThis as any).window = timerWindow;

class FakeTrack {
  kind = 'audio';
  id: string;
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  muted = false;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  onended: (() => void) | null = null;
  constructor(id: string) {
    this.id = id;
  }
  addEventListener() {
    // CallEngine only listens to local tracks for recovery; not needed here.
  }
  stop() {
    this.readyState = 'ended';
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack(`track-${Math.random().toString(36).slice(2)}`)]) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeSessionDescription {
  type: string;
  sdp: string;
  constructor(init: { type: string; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

class FakeIceCandidate {
  candidate: string;
  constructor(init: { candidate: string }) {
    this.candidate = init.candidate;
  }
  toJSON() {
    return { candidate: this.candidate };
  }
}

(globalThis as any).RTCSessionDescription = FakeSessionDescription;
(globalThis as any).RTCIceCandidate = FakeIceCandidate;

let offerSequence = 0;


/** Minimal RTCPeerConnection with controllable state transitions. */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  id: number;
  configuration: any;
  connectionState: string = 'new';
  iceConnectionState: string = 'new';
  iceGatheringState: string = 'new';
  signalingState: string = 'stable';
  localDescription: any = null;
  remoteDescription: any = null;
  onicecandidate: ((event: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: any) => void) | null = null;
  createOfferCalls: Array<{ iceRestart: boolean }> = [];
  setRemoteDescriptionCalls: any[] = [];
  setConfigurationCalls: any[] = [];
  failCreateOffer = false;
  failSetLocalDescription = false;
  senders: Array<{ track: FakeTrack; replaceTrack: (track: FakeTrack) => Promise<void> }> = [];
  closed = false;

  constructor(configuration: any) {
    this.configuration = configuration;
    this.id = FakePeerConnection.instances.length + 1;
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    this.senders.push({
      track,
      replaceTrack: async (next: FakeTrack) => {
        const sender = this.senders.find((item) => item.track === track);
        if (sender) sender.track = next;
      },
    });
  }

  getSenders() {
    return this.senders;
  }

  createOffer(options?: { iceRestart?: boolean }) {
    this.createOfferCalls.push({ iceRestart: Boolean(options?.iceRestart) });
    if (this.failCreateOffer) return Promise.reject(new Error('createOffer rejected'));
    offerSequence += 1;
    return Promise.resolve({
      type: 'offer',
      sdp: `v=0\r\na=ice-ufrag:ufrag${offerSequence}\r\na=ice-pwd:pwd${offerSequence}\r\n`,
    });
  }

  createAnswer() {
    offerSequence += 1;
    return Promise.resolve({
      type: 'answer',
      sdp: `v=0\r\na=ice-ufrag:ans${offerSequence}\r\na=ice-pwd:anspwd${offerSequence}\r\n`,
    });
  }

  setLocalDescription(description: any) {
    if (description?.type !== 'rollback' && this.failSetLocalDescription) {
      return Promise.reject(new Error('setLocalDescription rejected'));
    }
    if (description?.type === 'rollback') {
      this.signalingState = 'stable';
      this.localDescription = null;
      return Promise.resolve();
    }
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: any) {
    this.setRemoteDescriptionCalls.push(description);
    this.remoteDescription = description;
    this.signalingState = 'stable';
    return Promise.resolve();
  }

  addIceCandidate() {
    return Promise.resolve();
  }

  getConfiguration() {
    return this.configuration;
  }

  setConfiguration(configuration: any) {
    this.setConfigurationCalls.push(configuration);
    this.configuration = { ...this.configuration, ...configuration };
  }

  getStats() {
    return Promise.resolve(new Map());
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }

  __setConnectionState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  __setIceState(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  __setIceGatheringState(state: string) {
    this.iceGatheringState = state;
    (this as any).onicegatheringstatechange?.();
  }
}

(globalThis as any).RTCPeerConnection = FakePeerConnection;


class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: any[] = [];
  failSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.open(), 0);
  }

  open() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(raw: string) {
    if (this.failSend) throw new Error('simulated signaling send failure');
    this.sent.push(JSON.parse(raw));
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  offers() {
    return this.sent.filter((message) => message.type === 'offer');
  }
}

(globalThis as any).WebSocket = FakeWebSocket;

class FakeUltravoxSession extends EventTarget {
  status: UltravoxSessionStatus = UltravoxSessionStatus.DISCONNECTED;
  leaveCalls = 0;
  joinCalls: string[] = [];
  micSourceNode: unknown = { fake: true };
  transcripts: any[] = [];
  setOutputMedium() {}
  muteSpeaker() {}
  muteMic() {}
  unmuteMic() {}
  joinCall(url: string) {
    this.joinCalls.push(url);
    this.setStatus(UltravoxSessionStatus.CONNECTING);
  }
  async leaveCall() {
    this.leaveCalls += 1;
    this.setStatus(UltravoxSessionStatus.DISCONNECTED);
  }
  setStatus(status: UltravoxSessionStatus) {
    this.status = status;
    this.dispatchEvent(new Event('status'));
  }
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const icePayload = (overrides: Record<string, unknown> = {}) => ({
  iceServers: [{ urls: 'stun:test.invalid:19302' }],
  hasTurn: false,
  hasStun: true,
  iceTransportPolicy: 'all',
  turn: { configured: false, credentialMode: 'none', urlCount: 0, expiresAt: null },
  warnings: [],
  errors: [],
  generatedAt: new Date(0).toISOString(),
  ...overrides,
});

const turnIcePayload = (credential: string) =>
  icePayload({
    iceServers: [
      { urls: 'stun:test.invalid:19302' },
      {
        urls: 'turn:turn.test.invalid:3478?transport=udp',
        username: 'turn-user',
        credential,
      },
    ],
    hasTurn: true,
    turn: { configured: true, credentialMode: 'static', urlCount: 1, expiresAt: null },
  });

let iceFetchCount = 0;

/** Deterministic ICE endpoint behaviour, including transient/permanent failures. */
type IceFetchBehavior = (attempt: number) => Response | Promise<Response>;

const installFetch = (
  options: { iceFetch?: IceFetchBehavior; healthPolicy?: 'all' | 'relay' } = {}
) => {
  iceFetchCount = 0;
  (globalThis as any).fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/ice-config')) {
      iceFetchCount += 1;
      if (options.iceFetch) return options.iceFetch(iceFetchCount);
      return jsonResponse(icePayload());
    }
    if (url.includes('/api/health')) {
      return jsonResponse({
        status: 'ok',
        ice: { iceTransportPolicy: options.healthPolicy ?? 'all' },
        iceTransportPolicy: options.healthPolicy ?? 'all',
      });
    }
    if (url.includes('/ultravox-call')) {
      return jsonResponse({ callId: 'call_test', joinUrl: 'wss://ai.invalid/join', isReused: false });
    }
    return jsonResponse({});
  };
};

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'en-US',
    onLine: true,
    mediaDevices: { getUserMedia: async () => new FakeStream() },
  },
});

interface Harness {
  engine: CallEngine;
  ws: FakeWebSocket;
  pc: FakePeerConnection;
  snapshots: any[];
  sessions: FakeUltravoxSession[];
}

const otherRole = (role: 'customer' | 'salesperson') =>
  role === 'customer' ? 'salesperson' : 'customer';

/**
 * Starts an engine, opens its signaling socket and delivers the join
 * acknowledgement for a session that already contains the other participant.
 */
const setupPeer = async (
  role: 'customer' | 'salesperson',
  options: {
    enableAi?: boolean;
    offerAnswerTimeoutMs?: number;
    iceRestartDelaysMs?: readonly number[];
    iceRestartVerifyMs?: number;
    disconnectGraceMs?: number;
    iceFetch?: IceFetchBehavior;
    healthPolicy?: 'all' | 'relay';
    iceConfigRetryDelaysMs?: readonly number[];
    iceConfigTimeoutMs?: number;
    connectWatchdogMs?: number;
  } = {}
): Promise<Harness> => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  installFetch({ iceFetch: options.iceFetch, healthPolicy: options.healthPolicy });

  const snapshots: any[] = [];
  const sessions: FakeUltravoxSession[] = [];
  const engine = new CallEngine({
    sessionId: 'session-test',
    role,
    credential: 'credential-test',
    apiBase: '',
    enableAi: Boolean(options.enableAi),
    offerAnswerTimeoutMs: options.offerAnswerTimeoutMs ?? 60,
    iceRestartDelaysMs: options.iceRestartDelaysMs ?? [1, 1, 1],
    iceRestartVerifyMs: options.iceRestartVerifyMs ?? 30,
    disconnectGraceMs: options.disconnectGraceMs ?? 20,
    iceConfigRetryDelaysMs: options.iceConfigRetryDelaysMs ?? [1, 1],
    iceConfigTimeoutMs: options.iceConfigTimeoutMs ?? 500,
    connectWatchdogMs: options.connectWatchdogMs ?? 20000,
    createAiSession: () => {
      const session = new FakeUltravoxSession();
      sessions.push(session);
      return session as unknown as any;
    },
    onUpdate: (snapshot) => snapshots.push(snapshot),
  });

  await engine.start();
  await sleep(5);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  assert.ok(ws, 'engine must open a signaling socket');

  const selfId = `${role}-1`;
  const peer = { participantId: `${otherRole(role)}-1`, role: otherRole(role) };
  ws.receive({
    type: 'joined',
    sessionId: 'session-test',
    participantId: selfId,
    role,
    peers: [peer],
    participants: [{ participantId: selfId, role }, peer],
  });
  await sleep(10);

  const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  assert.ok(pc, 'a peer connection must be created for the joined peer');
  return { engine, ws, pc, snapshots, sessions };
};

/** Applies the pending answer as the salesperson (the only offerer). */
const answerOffer = async (ws: FakeWebSocket, pc: FakePeerConnection) => {
  if (pc.signalingState !== 'have-local-offer') return;
  ws.receive({ type: 'answer', answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a\r\na=ice-pwd:b\r\n' } });
  await sleep(5);
};

const sessionStateFor = (role: 'customer' | 'salesperson') => ({
  type: 'session_state',
  sessionId: 'session-test',
  participants: [
    { participantId: `${role}-1`, role },
    { participantId: `${otherRole(role)}-1`, role: otherRole(role) },
  ],
});

test('repeated session_state events never create a duplicate offer', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  assert.equal(ws.offers().length, 1, 'the initial negotiation sends one offer');
  assert.equal(pc.createOfferCalls.length, 1);

  // The offer is answered, but ICE/DTLS is still connecting. This is exactly
  // the window in which presence refreshes used to send a second offer.
  await answerOffer(ws, pc);
  pc.__setConnectionState('connecting');
  assert.equal(pc.signalingState, 'stable');

  for (let index = 0; index < 6; index += 1) {
    ws.receive(sessionStateFor('salesperson'));
  }
  await sleep(20);

  assert.equal(pc.createOfferCalls.length, 1, 'presence refreshes must not call createOffer again');
  assert.equal(ws.offers().length, 1, 'presence refreshes must not send another offer');
  assert.equal(pc.signalingState, 'stable', 'signaling must not be wedged by a presence refresh');

  // A genuinely connected transport keeps the same single negotiation.
  pc.__setConnectionState('connected');
  ws.receive(sessionStateFor('salesperson'));
  await sleep(10);
  assert.equal(pc.createOfferCalls.length, 1);
});

test('an offer is not created while signalingState is have-local-offer', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  assert.equal(pc.signalingState, 'have-local-offer');
  const before = pc.createOfferCalls.length;

  // Directly request offers while the first one is outstanding, including an
  // ICE restart: no second setLocalDescription/offer may be created.
  await (engine as any).makeOffer({ reason: 'presence refresh' });
  await (engine as any).makeOffer({ iceRestart: true, reason: 'early restart' });
  await sleep(10);

  assert.equal(pc.createOfferCalls.length, before);
  assert.equal(ws.offers().length, 1);
  assert.equal((engine as any).pendingIceRestartReason, 'early restart');
});

test('a pending ICE restart is retried as soon as signaling becomes stable', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  assert.equal(pc.signalingState, 'have-local-offer');
  pc.connectionState = 'failed';
  pc.iceConnectionState = 'failed';
  pc.onconnectionstatechange?.();
  await sleep(10);

  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    0,
    'no ICE-restart offer may be created while signaling is not stable'
  );
  assert.equal((engine as any).pendingIceRestartReason, 'peer connection failed');

  await answerOffer(ws, pc);
  await sleep(20);

  const restarts = pc.createOfferCalls.filter((call) => call.iceRestart);
  assert.equal(restarts.length, 1, 'the queued restart runs once signaling is stable');
  assert.equal(ws.sent.filter((message) => message.type === 'offer').length, 2);
});

test('a customer ICE-restart request makes the salesperson restart even while its own PC looks connected', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  assert.equal(engine.getSnapshot().callState, 'connected');

  ws.receive({
    type: 'ice_restart',
    from: 'customer-1',
    reason: 'customer network changed',
  });
  await sleep(20);

  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    1,
    'a customer request must trigger a real restart offer'
  );
  assert.equal(pc.signalingState, 'have-local-offer');

  // Stale peer requests are ignored (existing role isolation).
  ws.receive({ type: 'ice_restart', from: 'someone-else', reason: 'spoofed' });
  await sleep(10);
  assert.equal(pc.createOfferCalls.filter((call) => call.iceRestart).length, 1);
});


test('duplicate failure events produce one bounded recovery sequence and a terminal error', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  assert.equal(engine.getSnapshot().callState, 'connected');

  // Both connectionState and iceConnectionState report failure, repeatedly.
  pc.__setConnectionState('failed');
  pc.__setIceState('failed');
  pc.__setConnectionState('failed');

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    await answerOffer(ws, pc);
    await sleep(10);
    if (engine.getSnapshot().callState === 'failed') break;
  }

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'failed', 'recovery must end in a terminal failure');
  assert.match(String(snapshot.lastError), /Reconnect/i, 'the error must be actionable');

  const restarts = pc.createOfferCalls.filter((call) => call.iceRestart);
  assert.equal(restarts.length, 3, 'the recovery sequence is exactly one bounded budget');
  assert.equal(pc.createOfferCalls.filter((call) => !call.iceRestart).length, 1);

  // No peer-connection churn is allowed after the terminal failure.
  const connectionsAfterFailure = FakePeerConnection.instances.length;
  for (let index = 0; index < 10; index += 1) {
    ws.receive(sessionStateFor('salesperson'));
  }
  await sleep(50);
  assert.equal(FakePeerConnection.instances.length, connectionsAfterFailure);
  assert.equal(engine.getSnapshot().callState, 'failed');

  // A deliberate retry is still possible inside the same call.
  engine.retryConnection();
  await sleep(10);
  assert.equal(FakePeerConnection.instances.length, connectionsAfterFailure + 1);
  assert.equal(engine.getSnapshot().callState, 'connecting');
  const fresh = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  assert.equal(fresh.createOfferCalls.length, 1);
  assert.equal(fresh.signalingState, 'have-local-offer');
});

test('replacing a peer connection cancels timers and ignores stale callbacks', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  // Attach a remote track to the old connection, then keep its handler.
  const oldTrack = new FakeTrack('old-remote');
  pc.ontrack?.({ track: oldTrack, streams: [new FakeStream([oldTrack])] });
  const staleOntrack = pc.ontrack;
  assert.equal(engine.getSnapshot().remoteTrackState, 'live');

  // Start the disconnect grace timer, then deliberately replace the connection.
  pc.__setConnectionState('disconnected');
  await sleep(5);
  engine.retryConnection();
  await sleep(10);

  const fresh = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  assert.notEqual(fresh, pc);
  assert.equal(pc.closed, true);
  assert.equal(engine.getSnapshot().remoteTrackState, 'none');

  // Complete the fresh negotiation so its own answer watchdog cannot fire.
  await answerOffer(ws, fresh);
  const offersAfterRetry = ws.offers().length;

  // Stale callbacks from the replaced connection must be ignored.
  staleOntrack?.({ track: new FakeTrack('stale'), streams: [new FakeStream()] });
  oldTrack.onended?.();
  oldTrack.onmute?.();
  pc.__setConnectionState('failed');
  pc.__setIceState('failed');
  await sleep(80);

  const snapshot = engine.getSnapshot();
  assert.notEqual(snapshot.callState, 'failed', 'the stale failure must not affect the new connection');
  assert.equal(snapshot.remoteTrackState, 'none');
  assert.equal(ws.offers().length, offersAfterRetry, 'stale events must not create offers');
  assert.equal(fresh.closed, false);
});


test('the customer requests a restart over signaling and AI state survives WebRTC failure', async (t) => {
  const { engine, ws, pc, sessions } = await setupPeer('customer', { enableAi: true });
  t.after(async () => engine.stop('test finished'));

  // Let the customer-side AI session reach a live state.
  await sleep(20);
  const ai = sessions[0];
  assert.ok(ai, 'the customer must create an AI session');
  ai.setStatus(UltravoxSessionStatus.LISTENING);
  await sleep(10);
  assert.equal(engine.getSnapshot().ai.state, 'connected');
  const leaveCallsBefore = ai.leaveCalls;

  // A customer is the answerer: it must ask the salesperson instead of
  // creating a competing offer.
  pc.__setConnectionState('failed');
  pc.__setIceState('failed');

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    await sleep(10);
    if (engine.getSnapshot().callState === 'failed') break;
  }

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'failed');
  assert.match(String(snapshot.lastError), /Reconnect/i);
  assert.equal(pc.createOfferCalls.length, 0, 'the customer must never create an offer');

  const requests = ws.sent.filter((message) => message.type === 'ice_restart');
  assert.equal(requests.length, 3, 'restart requests are bounded, never an infinite loop');

  // The healthy AI session is completely independent from WebRTC failure.
  assert.equal(snapshot.ai.state, 'connected');
  assert.equal(snapshot.ai.connected, true);
  assert.equal(ai.leaveCalls, leaveCallsBefore, 'terminal WebRTC failure must not stop the AI session');


});

test('a temporary disconnect is not treated as a confirmed failure', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  assert.equal(engine.getSnapshot().callState, 'connected');

  // A short disconnect recovers before the grace period expires.
  pc.__setConnectionState('disconnected');
  await sleep(10);
  assert.equal(engine.getSnapshot().callState, 'connected', 'a transient drop is not reported as failed');
  pc.__setConnectionState('connected');
  await sleep(40);

  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    0,
    'a transient disconnect must not trigger a restart'
  );
  assert.equal(engine.getSnapshot().callState, 'connected');

  // A disconnect that outlives the grace period is a real failure and starts
  // exactly one bounded recovery sequence.
  pc.__setConnectionState('disconnected');
  await sleep(40);
  assert.equal(engine.getSnapshot().callState, 'reconnecting');
  assert.equal(pc.createOfferCalls.filter((call) => call.iceRestart).length, 1);
});

test('an unanswered offer is rolled back and retried, then bounded', async (t) => {
  const { engine, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  assert.equal(pc.signalingState, 'have-local-offer');
  assert.equal(pc.createOfferCalls.length, 1);

  // The offer is abandoned (no answer ever arrives). The watchdog must roll it
  // back and retry, never leaving signaling wedged.
  await sleep(90);
  assert.equal(pc.createOfferCalls.length, 2, 'the abandoned offer is retried once');
  assert.equal(pc.signalingState, 'have-local-offer');

  // Attempt budget is bounded: after the third offer the connection becomes
  // terminal instead of retrying forever.
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline && engine.getSnapshot().callState !== 'failed') {
    await sleep(40);
  }
  assert.equal(pc.createOfferCalls.length, 3, 'negotiation attempts are bounded to three');
  assert.equal(engine.getSnapshot().callState, 'failed');
  assert.match(String(engine.getSnapshot().lastError), /Reconnect/i);
});

test('a persistent signaling-send failure consumes the budget and reaches terminal without looping', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    iceRestartDelaysMs: [5, 5, 5],
    iceRestartVerifyMs: 200,
    offerAnswerTimeoutMs: 500,
  });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  assert.equal(engine.getSnapshot().callState, 'connected');

  ws.failSend = true;
  pc.__setConnectionState('failed');

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && engine.getSnapshot().callState !== 'failed') {
    await sleep(5);
  }

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'failed');
  assert.match(String(snapshot.lastError), /Reconnect/i);
  const restartCalls = pc.createOfferCalls.filter((call) => call.iceRestart).length;
  assert.equal(restartCalls, 3, 'each failed attempt consumes exactly one budget slot');

  // The terminal state must not spin or leave a retry timer/in-flight flag.
  await sleep(60);
  assert.equal(pc.createOfferCalls.filter((call) => call.iceRestart).length, 3, 'no busy retry loop');
  assert.equal((engine as any).iceRestartTimer, null);
  assert.equal((engine as any).iceRestartInFlight, false);
  assert.equal((engine as any).answerInFlight, false);
});

test('repeated createOffer rejection reaches terminal within the budget', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    iceRestartDelaysMs: [5, 5, 5],
    iceRestartVerifyMs: 200,
    offerAnswerTimeoutMs: 500,
  });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  pc.failCreateOffer = true;
  pc.__setConnectionState('failed');

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && engine.getSnapshot().callState !== 'failed') {
    await sleep(5);
  }

  assert.equal(engine.getSnapshot().callState, 'failed');
  assert.match(String(engine.getSnapshot().lastError), /Reconnect/i);
  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    3,
    'createOffer failures consume the bounded budget'
  );
  await sleep(60);
  assert.equal(pc.createOfferCalls.filter((call) => call.iceRestart).length, 3);
  assert.equal((engine as any).iceRestartTimer, null);
});


test('repeated setLocalDescription rejection reaches terminal within the budget', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    iceRestartDelaysMs: [5, 5, 5],
    iceRestartVerifyMs: 200,
    offerAnswerTimeoutMs: 500,
  });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  pc.failSetLocalDescription = true;
  pc.__setConnectionState('failed');

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && engine.getSnapshot().callState !== 'failed') {
    await sleep(5);
  }

  assert.equal(engine.getSnapshot().callState, 'failed');
  assert.match(String(engine.getSnapshot().lastError), /Reconnect/i);
  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    3,
    'setLocalDescription failures consume the bounded budget'
  );
  await sleep(60);
  assert.equal(pc.createOfferCalls.filter((call) => call.iceRestart).length, 3);
  assert.equal((engine as any).iceRestartTimer, null);
});

test('a later ICE-restart attempt within the budget can still recover', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    iceRestartDelaysMs: [30, 30, 30],
    iceRestartVerifyMs: 200,
    offerAnswerTimeoutMs: 500,
  });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  ws.failSend = true;
  pc.__setConnectionState('failed');
  await sleep(10);
  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    1,
    'the first attempt fails and consumes one slot'
  );

  ws.failSend = false;
  await sleep(80);
  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    2,
    'the second bounded attempt succeeds'
  );

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  await sleep(10);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'connected');
  assert.equal((engine as any).iceRestartAttempts, 0, 'only a genuine connection resets the budget');
  assert.equal((engine as any).iceRestartInFlight, false);
  assert.equal((engine as any).iceRestartTimer, null);
});


test('an answer in flight past the watchdog deadline is never rolled back', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    offerAnswerTimeoutMs: 40,
    iceRestartDelaysMs: [5, 5, 5],
    iceRestartVerifyMs: 200,
  });
  t.after(async () => engine.stop('test finished'));

  const originalSetRemote = pc.setRemoteDescription.bind(pc);
  const controlled: { release: (() => void) | null } = { release: null };
  let controlledCalls = 0;
  pc.setRemoteDescription = (description: any) => {
    controlledCalls += 1;
    return new Promise<void>((resolve, reject) => {
      controlled.release = () => {
        Promise.resolve(originalSetRemote(description)).then(resolve, reject);
      };
    });
  };

  const answer = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a\r\na=ice-pwd:b\r\n' };
  ws.receive({ type: 'answer', from: 'customer-1', answer });
  await sleep(5);
  assert.equal((engine as any).answerInFlight, true);
  // A duplicate answer while the first is being applied must be ignored.
  ws.receive({ type: 'answer', from: 'customer-1', answer });
  await sleep(5);

  // The watchdog deadline passes while setRemoteDescription is still pending.
  await sleep(70);
  assert.equal(pc.createOfferCalls.length, 1, 'the watchdog must not create a retry offer');
  assert.equal(controlledCalls, 1, 'the duplicate answer is ignored');
  assert.equal((engine as any).answerInFlight, true);

  assert.ok(controlled.release, 'the controlled answer promise must be pending');
  controlled.release!();
  await sleep(10);

  assert.equal(pc.createOfferCalls.length, 1);
  assert.equal(pc.signalingState, 'stable');
  assert.equal((engine as any).answerInFlight, false);
  assert.equal((engine as any).offerInFlight, false);
  assert.equal(
    engine.getSnapshot().logs.some((line) => /Rolled back the outstanding offer/.test(line)),
    false,
    'a valid negotiation must never be rolled back'
  );
});

test('a failed answer re-arms the watchdog and keeps bounded recovery alive', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    offerAnswerTimeoutMs: 60,
    iceRestartDelaysMs: [5, 5, 5],
    iceRestartVerifyMs: 200,
  });
  t.after(async () => engine.stop('test finished'));

  pc.setRemoteDescription = () => Promise.reject(new Error('answer rejected by the browser'));
  ws.receive({
    type: 'answer',
    from: 'customer-1',
    answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a\r\na=ice-pwd:b\r\n' },
  });
  await sleep(10);
  assert.equal((engine as any).answerInFlight, false);

  // The re-armed watchdog fires, rolls back and retries within the budget.
  await sleep(80);
  assert.ok(
    pc.createOfferCalls.length >= 2 && pc.createOfferCalls.length <= 3,
    'the watchdog is still alive after a failed answer and stays bounded'
  );
  assert.equal(pc.signalingState, 'have-local-offer');
});

test('a stale answer from a previous peer cannot cancel the new watchdog', async (t) => {
  const { engine, ws } = await setupPeer('salesperson', {
    offerAnswerTimeoutMs: 50,
    iceRestartDelaysMs: [5, 5, 5],
    iceRestartVerifyMs: 200,
  });
  t.after(async () => engine.stop('test finished'));

  ws.receive({
    type: 'peer_joined',
    sessionId: 'session-test',
    peer: { participantId: 'customer-2', role: 'customer' },
    participants: [],
  });
  await sleep(10);
  const fresh = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  assert.equal(fresh.signalingState, 'have-local-offer');

  // This answer belongs to the replaced peer identity and must be ignored.
  ws.receive({
    type: 'answer',
    from: 'customer-1',
    answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:stale\r\na=ice-pwd:stale\r\n' },
  });
  await sleep(90);

  assert.equal(fresh.setRemoteDescriptionCalls.length, 0, 'the stale answer is ignored');
  assert.ok(fresh.createOfferCalls.length >= 2, 'the new watchdog still retried its own offer');
});

test('signaling rejoin after terminal failure starts a fresh negotiation and leaves the failed state', async (t) => {
  const { engine, ws } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  (engine as any).enterTerminalPeerFailure('test terminal');
  assert.equal(engine.getSnapshot().callState, 'failed');

  ws.receive({
    type: 'joined',
    sessionId: 'session-test',
    participantId: 'salesperson-1',
    role: 'salesperson',
    peers: [{ participantId: 'customer-1', role: 'customer' }],
    participants: [],
  });
  await sleep(10);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'connecting', 'a fresh negotiation must leave the failed state');
  const fresh = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  assert.equal(fresh.createOfferCalls.length, 1);

  fresh.__setConnectionState('connected');
  await sleep(5);
  assert.equal(engine.getSnapshot().callState, 'connected');
  assert.equal(engine.getSnapshot().lastError, null);
});

// ---------------------------------------------------------------------------
// ICE configuration acquisition / refresh
// ---------------------------------------------------------------------------

test('a transient ICE configuration failure is retried and the real payload is applied', async t => {
  const { engine, pc } = await setupPeer('salesperson', {
    iceFetch: (attempt) => {
      if (attempt === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return jsonResponse(turnIcePayload('fresh-pass'));
    },
  });
  t.after(async () => engine.stop('test finished'));

  const snapshot = engine.getSnapshot();
  assert.equal(iceFetchCount, 2, 'one transient failure must be retried exactly once');
  assert.equal(snapshot.iceConfigLoaded, true);
  assert.equal(snapshot.iceConfigError, null);
  assert.equal(snapshot.turnConfigured, true);
  assert.equal(snapshot.callState, 'connecting');

  const turn = pc.configuration.iceServers.find((entry: any) =>
    String(entry.urls).startsWith('turn:')
  );
  assert.ok(turn, 'the retried payload must reach RTCPeerConnection');
  assert.equal(turn.credential, 'fresh-pass');
});

test('an unreachable ICE endpoint still starts the call with direct-connection defaults', async t => {
  const { engine, pc } = await setupPeer('salesperson', {
    iceFetch: () => new Response('down', { status: 503 }),
    healthPolicy: 'all',
  });
  t.after(async () => engine.stop('test finished'));

  const snapshot = engine.getSnapshot();
  assert.equal(iceFetchCount, 3, 'all bounded attempts must be used before falling back');
  assert.equal(snapshot.iceConfigLoaded, false);
  assert.match(String(snapshot.iceConfigError), /HTTP 503/);
  assert.equal(snapshot.lastError, null, 'a degraded direct call is not a terminal failure');
  assert.notEqual(snapshot.callState, 'failed');

  assert.ok(pc, 'the call must still negotiate instead of refusing to start');
  const urls = pc.configuration.iceServers.map((entry: any) => entry.urls);
  assert.deepEqual(urls, ['stun:stun.l.google.com:19302']);
  assert.equal(pc.configuration.iceTransportPolicy, 'all');
});

test('an authorization failure is permanent: no retry, no terminal failure, no raw surface', async t => {
  const { engine } = await setupPeer('salesperson', {
    iceFetch: () =>
      new Response(
        JSON.stringify({ error: 'UNAUTHORIZED', message: 'A valid participant credential is required.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  t.after(async () => engine.stop('test finished'));

  const snapshot = engine.getSnapshot();
  assert.equal(iceFetchCount, 1, '401 must not be retried');
  assert.equal(snapshot.iceConfigLoaded, false);
  assert.match(String(snapshot.iceConfigError), /UNAUTHORIZED/);
  assert.notEqual(snapshot.callState, 'failed');
});

test('relay-only ICE with an unreachable configuration refuses to start (fail closed)', async () => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  installFetch({
    iceFetch: () => new Response('down', { status: 503 }),
    healthPolicy: 'relay',
  });

  const engine = new CallEngine({
    sessionId: 'session-test',
    role: 'salesperson',
    credential: 'credential-test',
    apiBase: '',
    iceConfigRetryDelaysMs: [1, 1],
    iceConfigTimeoutMs: 500,
    onUpdate: () => undefined,
  });

  await engine.start();
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'failed');
  assert.equal(snapshot.iceConfigLoaded, false);
  assert.match(String(snapshot.iceConfigError), /HTTP 503/);
  assert.equal(
    snapshot.lastError,
    'The audio connection could not be established. Check your network and use Reconnect to try again.',
    'the participant-facing error must stay free of transport detail'
  );
  assert.equal(snapshot.wsStatus, 'disconnected');
  assert.equal(snapshot.micPermission, 'unknown');
  assert.equal(FakeWebSocket.instances.length, 0, 'no signaling socket may open');
  assert.equal(FakePeerConnection.instances.length, 0, 'no peer connection may be created');
});

test('an ICE restart re-reads the ICE payload and applies refreshed TURN credentials', async t => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    iceFetch: (attempt) => jsonResponse(turnIcePayload(`cred-${attempt}`)),
  });
  t.after(async () => engine.stop('test finished'));

  assert.equal(iceFetchCount, 1);
  assert.equal(engine.getSnapshot().turnCredentialMode, 'static');

  // Settle the initial negotiation so the recovery path can create an offer.
  await answerOffer(ws, pc);
  assert.equal(pc.signalingState, 'stable');

  pc.__setConnectionState('failed');
  await sleep(60);

  assert.ok(iceFetchCount >= 2, 'recovery must refresh the ICE payload');
  assert.ok(pc.setConfigurationCalls.length >= 1, 'refreshed servers must reach the live peer connection');
  const applied = pc.setConfigurationCalls[pc.setConfigurationCalls.length - 1];
  const turn = applied.iceServers.find((entry: any) => String(entry.urls).startsWith('turn:'));
  assert.ok(turn);
  assert.notEqual(turn.credential, 'cred-1', 'the stale credential must be replaced');

  const restartOffers = pc.createOfferCalls.filter((call) => call.iceRestart);
  assert.equal(restartOffers.length, 1, 'exactly one bounded ICE-restart offer is created');
});

test('ICE gathering with zero candidates starts bounded recovery instead of hanging', async t => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  assert.equal(engine.getSnapshot().callState, 'connecting');

  // Relay-only with an unreachable TURN server: gathering completes with no
  // host/srflx/relay candidates and no `failed` event is ever emitted.
  pc.__setIceGatheringState('complete');
  await sleep(30);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'reconnecting', 'a zero-candidate ICE must not stay connecting');
  const restartOffers = pc.createOfferCalls.filter((call) => call.iceRestart);
  assert.equal(restartOffers.length, 1, 'the bounded recovery must attempt an ICE restart');
});

test('a peer connection that never connects is bounded by the watchdog', async t => {
  const { engine, ws, pc } = await setupPeer('salesperson', { connectWatchdogMs: 20 });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  assert.equal(engine.getSnapshot().callState, 'connecting');

  await sleep(60);
  const snapshot = engine.getSnapshot();
  assert.ok(
    ['reconnecting', 'failed'].includes(snapshot.callState),
    `a stuck connection must leave connecting, got ${snapshot.callState}`
  );
  assert.ok(
    pc.createOfferCalls.some((call) => call.iceRestart),
    'the watchdog must start the bounded ICE-restart recovery'
  );
});
