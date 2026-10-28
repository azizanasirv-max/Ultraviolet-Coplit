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
  /** What the browser reports for this capture (mirrors getSettings()). */
  settings: Record<string, unknown> = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,
  };
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  constructor(id: string) {
    this.id = id;
  }
  getSettings() {
    return { ...this.settings };
  }
  addEventListener(type: string, listener: (...args: any[]) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (...args: any[]) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  /** Test-only: how many handlers are still attached for one event type. */
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
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

/** Minimal MediaStream: the engine keeps ONE remote stream and swaps tracks. */
class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(track: FakeTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
  }
}

(globalThis as any).MediaStream = FakeMediaStream;

/**
 * Controllable Web Audio measurement stack.
 *
 * The engine only ever reads levels through an AnalyserNode (it is never
 * connected to a destination), so a fake that reports a fixed RMS per context
 * is enough to prove both "sound detected" and "connected but silent".
 */
let fakeAudioAmplitude = 0;

class FakeAnalyserNode {
  fftSize = 1024;
  smoothingTimeConstant = 0;
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
  getFloatTimeDomainData(target: Float32Array) {
    for (let index = 0; index < target.length; index += 1) {
      target[index] = Math.sin((index / target.length) * Math.PI * 2) * fakeAudioAmplitude;
    }
  }
}

class FakeMediaStreamAudioSourceNode {
  connected = false;
  connect() {
    this.connected = true;
  }
  disconnect() {}
  constructor() {
    // Proves that one track is measured by one analyser graph only.
    mediaStreamSourceCreations += 1;
  }
}

/** How many MediaStreamAudioSourceNodes the engine built (one per analyser). */
let mediaStreamSourceCreations = 0;

class FakeAudioContext {
  sampleRate = 48000;
  state = 'running';
  analysers: FakeAnalyserNode[] = [];
  createMediaStreamSource() {
    return new FakeMediaStreamAudioSourceNode();
  }
  createAnalyser() {
    const analyser = new FakeAnalyserNode();
    this.analysers.push(analyser);
    return analyser;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

(globalThis as any).AudioContext = FakeAudioContext;

/** Minimal <audio> element: records play() outcomes the test controls. */
class FakeAudioElement {
  srcObject: any = null;
  paused = true;
  muted = false;
  volume = 1;
  loop = false;
  playCalls = 0;
  /** Set by the test: 'ok' | 'blocked' | 'abort'. */
  playOutcome: 'ok' | 'blocked' | 'abort' = 'ok';
  private srcValue = '';

  get src() {
    return this.srcValue;
  }
  set src(value: string) {
    this.srcValue = value;
  }
  hasAttribute(name: string) {
    return name === 'src' ? this.srcValue.length > 0 : false;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.srcValue = '';
  }
  load() {
    this.paused = true;
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.playCalls += 1;
    if (this.playOutcome === 'blocked') {
      const error = new Error('play() failed because the user did not interact with the document first.');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    }
    if (this.playOutcome === 'abort') {
      const error = new Error('The play() request was interrupted.');
      error.name = 'AbortError';
      return Promise.reject(error);
    }
    this.paused = false;
    return Promise.resolve();
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
  senders: Array<{
    track: FakeTrack | null;
    replaceTrack: (track: FakeTrack | null) => Promise<void>;
  }> = [];
  transceivers: Array<{ receiver: any; direction: string; sender: any }> = [];
  /** Configurable getStats() output: inbound/outbound audio RTP counters. */
  inboundBytes = 0;
  outboundBytes = 0;
  /** Remote receivers, used to prove an audio track is adopted without ontrack. */
  receiverTracks: FakeTrack[] = [];
  /** Negotiated direction reported by getTransceivers(); null = unsupported. */
  audioCurrentDirection: string | null = null;
  closed = false;

  constructor(configuration: any) {
    this.configuration = configuration;
    this.id = FakePeerConnection.instances.length + 1;
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    const sender = {
      track: track as FakeTrack | null,
      replaceTrack: async (next: FakeTrack | null) => {
        sender.track = next;
      },
    };
    this.senders.push(sender);
    return sender;
  }

  /** Mirrors Chrome: the sender appears in getSenders() with no track yet. */
  addTransceiver(kind: string, init?: { direction?: string }) {
    const sender = {
      track: null as FakeTrack | null,
      replaceTrack: async (next: FakeTrack | null) => {
        sender.track = next;
      },
    };
    const transceiver = { receiver: { kind }, direction: init?.direction ?? 'sendrecv', sender };
    this.transceivers.push(transceiver);
    this.senders.push(sender);
    return transceiver;
  }

  getSenders() {
    return this.senders;
  }

  /** Mirrors the browser API the direction guard uses. */
  getTransceivers() {
    if (this.audioCurrentDirection === null) return [];
    return [
      {
        receiver: { kind: 'audio', track: this.receiverTracks[0] ?? null },
        sender: this.senders[0] ?? { track: null },
        direction: 'sendrecv',
        currentDirection: this.audioCurrentDirection,
      },
    ];
  }

  getReceivers() {
    return this.receiverTracks.map((track) => ({ track }));
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
    const reports = new Map<string, any>();
    reports.set('inbound', {
      id: 'inbound',
      type: 'inbound-rtp',
      kind: 'audio',
      bytesReceived: this.inboundBytes,
      packetsReceived: Math.floor(this.inboundBytes / 160),
    });
    reports.set('outbound', {
      id: 'outbound',
      type: 'outbound-rtp',
      kind: 'audio',
      bytesSent: this.outboundBytes,
      packetsSent: Math.floor(this.outboundBytes / 160),
    });
    return Promise.resolve(reports);
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
  ultravoxCallCount = 0;
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
      ultravoxCallCount += 1;
      return jsonResponse({ callId: 'call_test', joinUrl: 'wss://ai.invalid/join', isReused: false });
    }
    return jsonResponse({});
  };
};

/** How many AI calls this engine asked the server to create. */
let ultravoxCallCount = 0;

/** Which capture every getUserMedia() call returns. Tests may override it. */
let micStreamFactory: () => FakeStream = () => new FakeStream();

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'en-US',
    onLine: true,
    mediaDevices: { getUserMedia: async () => micStreamFactory() },
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
    mediaFlowCheckMs?: number;
    mediaFlowGraceMs?: number;
    mediaStallMs?: number;
    /** Initial microphone capture (defaults to a fresh live fake track). */
    micStream?: () => FakeStream;
  } = {}
): Promise<Harness> => {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];
  micStreamFactory = options.micStream ?? (() => new FakeStream());
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
    mediaFlowCheckMs: options.mediaFlowCheckMs ?? 60000,
    mediaFlowGraceMs: options.mediaFlowGraceMs ?? 60000,
    mediaStallMs: options.mediaStallMs ?? 60000,
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

test('a peer connection always negotiates an outbound audio m-line for a late microphone', async t => {
  // The capture exists but the track already ended (permission revoked, device
  // switched, or recovery in progress) when the peer connection is created.
  const dead = () => new FakeStream([Object.assign(new FakeTrack('dead'), { readyState: 'ended' })]);
  const { engine, ws, pc } = await setupPeer('salesperson', { micStream: dead });
  t.after(async () => engine.stop('test finished'));

  assert.equal(pc.transceivers.length, 1, 'an audio transceiver must always be negotiated');
  assert.equal(pc.transceivers[0].direction, 'sendrecv');
  assert.equal(pc.senders.length, 1, 'the transceiver must expose a sender');
  assert.equal(pc.senders[0].track, null, 'no dead track may be attached');

  await answerOffer(ws, pc);
  const offersBeforeRecovery = ws.offers().length;

  // Level one: the microphone becomes available after negotiation.
  const live = new FakeStream([new FakeTrack('live')]);
  micStreamFactory = () => live;
  await (engine as any).recoverLocalTrack('microphone returned');
  await sleep(10);

  assert.equal(pc.senders.length, 1, 'recovery must replace the track, not add a second sender');
  assert.ok(pc.senders[0].track, 'the recovered microphone must reach the peer connection');
  assert.equal((pc.senders[0].track as FakeTrack).readyState, 'live');
  assert.equal(engine.getSnapshot().localSenderCount, 1);

  // The recovered microphone is renegotiated so the peer receives the m-line.
  assert.ok(ws.offers().length > offersBeforeRecovery, 'the salesperson must renegotiate the new sender');
});

test('a healthy capture is never reopened, and a dead one is replaced without overlap', async t => {
  let captures = 0;
  let capture: FakeStream | null = null;
  const { engine, pc } = await setupPeer('salesperson', {
    micStream: () => {
      captures += 1;
      capture = new FakeStream([new FakeTrack(`capture-${captures}`)]);
      return capture;
    },
  });
  t.after(async () => engine.stop('test finished'));

  const previous = (capture as unknown as FakeStream).getAudioTracks()[0];
  assert.equal(previous.readyState, 'live');
  assert.equal(captures, 1);

  // 1. Recovery is idempotent: reopening a device that is already publishing is
  // what produces clicks, a second processing pipeline and AI-capture contention.
  await (engine as any).recoverLocalTrack('spurious ended event');
  await sleep(5);
  assert.equal(captures, 1, 'a healthy capture must not be re-acquired');
  assert.equal(previous.readyState, 'live');

  // 2. A capture the browser muted is replaced, and the old one is stopped
  // BEFORE the replacement is opened (no two simultaneous captures).
  previous.muted = true;
  let liveCapturesAtAcquire: number | null = null;
  micStreamFactory = () => {
    liveCapturesAtAcquire = previous.readyState === 'live' ? 1 : 0;
    captures += 1;
    return new FakeStream([new FakeTrack('second')]);
  };
  await (engine as any).recoverLocalTrack('track muted by the browser');
  await sleep(10);

  assert.equal(previous.readyState, 'ended', 'the stale capture must not stay hot');
  assert.equal(liveCapturesAtAcquire, 0, 'the dead capture must be released before the new one opens');
  assert.equal(pc.senders.length, 1);
  assert.equal(pc.senders[0].track?.readyState, 'live');
  assert.equal(pc.senders[0].track?.id, 'second');
  assert.equal(engine.getSnapshot().diagnostics.micCaptures, 2);
});

test('microphone recovery is bounded and never reopens the device in a loop', async t => {
  let captures = 0;
  // Every capture is immediately muted, like a device held by another process.
  const { engine } = await setupPeer('salesperson', {
    micStream: () => {
      captures += 1;
      return new FakeStream([Object.assign(new FakeTrack(`muted-${captures}`), { muted: true })]);
    },
  });
  t.after(async () => engine.stop('test finished'));

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await (engine as any).recoverLocalTrack('track muted by the browser');
    await sleep(5);
  }

  assert.equal(captures, 3, 'the initial capture plus exactly two bounded re-acquires');
  assert.ok(
    (engine as any).micCaptures <= 1 + 2,
    `recovery must stay within its budget, opened ${(engine as any).micCaptures} captures`
  );
  const logs = engine.getSnapshot().logs.join('\n');
  assert.match(logs, /recovery budget exhausted/i);
});

test('recovery cleans up the listeners and timers of the replaced capture', async t => {
  const first = new FakeStream([new FakeTrack('first')]);
  let calls = 0;
  const { engine } = await setupPeer('salesperson', {
    // A real getUserMedia always returns a fresh stream; only the first call
    // returns the capture that is about to be replaced.
    micStream: () => (++calls === 1 ? first : new FakeStream([new FakeTrack(`next-${calls}`)])),
  });
  t.after(async () => engine.stop('test finished'));

  const track = first.getAudioTracks()[0];
  assert.ok(track.listenerCount('mute') > 0, 'the capture must be supervised');

  track.muted = true;
  await (engine as any).recoverLocalTrack('track muted by the browser');
  await sleep(10);

  assert.equal(track.listenerCount('mute'), 0, 'a replaced capture must not keep dispatching events');
  assert.equal(track.listenerCount('ended'), 0);
  assert.equal(track.listenerCount('unmute'), 0);
  assert.equal((engine as any).micRecoveryTimer, null);
});

test('a connected call with no audio recovers instead of reporting success', async t => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    mediaFlowCheckMs: 5,
    mediaFlowGraceMs: 10,
    mediaStallMs: 10,
    iceRestartVerifyMs: 15,
  });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  // ICE + DTLS connect, but no RTP ever arrives: the classic "connected but
  // silent" call. Sender statistics exist, inbound is zero.
  pc.outboundBytes = 4000;
  pc.__setConnectionState('connected');
  await sleep(30);

  assert.equal(pc.createOfferCalls.filter((call) => call.iceRestart).length >= 1, true,
    'a silent connected call must trigger an ICE restart');

  // Answer every restart offer the way the real customer would; only the
  // audio itself stays missing.
  for (let index = 0; index < 8; index += 1) {
    await answerOffer(ws, pc);
    await sleep(40);
  }

  // After the bounded attempts it must stop and report an actionable failure.
  await sleep(200);
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.callState, 'failed', `state=${snapshot.callState} logs=${snapshot.logs.join(' | ')}`);
  assert.match(String(snapshot.lastError), /could not be established/i);
});

test('real inbound audio prevents the media watchdog from restarting ICE', async t => {
  const { engine, ws, pc } = await setupPeer('salesperson', {
    mediaFlowCheckMs: 5,
    mediaFlowGraceMs: 10,
    mediaStallMs: 60,
    iceRestartVerifyMs: 15,
  });
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.outboundBytes = 8000;
  pc.inboundBytes = 5000;
  pc.__setConnectionState('connected');

  for (let index = 0; index < 4; index += 1) {
    pc.inboundBytes += 2000;
    pc.outboundBytes += 2500;
    await (engine as any).sampleStats();
    await sleep(15);
  }

  assert.equal(
    pc.createOfferCalls.filter((call) => call.iceRestart).length,
    0,
    'audio that is actually arriving must never cause an ICE restart'
  );
  assert.equal(engine.getSnapshot().diagnostics.audioFlow, 'both');
  assert.equal(engine.getSnapshot().diagnostics.mediaFlowing, true);
});

// ---------------------------------------------------------------------------
// Customer -> salesperson inbound audio
//
// These tests drive the real engine with a fake peer connection and a fake Web
// Audio stack. They prove that the engine reports inbound audio only when sound
// is measurable, that playback is supervised, and that a missing or replaced
// remote track is handled without duplicating the audio path.
// ---------------------------------------------------------------------------

const inboundTrack = (id: string) => new FakeTrack(id);

const deliverRemoteTrack = (pc: FakePeerConnection, track: FakeTrack) => {
  pc.receiverTracks = [track];
  pc.ontrack?.({ track, streams: [new FakeStream([track])] });
};

test('inbound audio is reported as working only when sound is measurable', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  pc.inboundBytes = 4800;

  const track = inboundTrack('customer-mic');
  deliverRemoteTrack(pc, track);
  await sleep(5);

  // RTP arrives, the microphone on the other side is silent (muted device or a
  // second capture holding it). The old code called this "audio flowing".
  fakeAudioAmplitude = 0;
  await (engine as any).sampleStats();
  let snapshot = engine.getSnapshot();
  assert.equal(snapshot.mediaFlowing, true, 'RTP counters must show that packets arrive');
  assert.equal(snapshot.diagnostics.inboundPackets > 0, true);
  assert.equal(snapshot.inboundSoundDetected, false, 'silence must not be reported as audible');
  assert.equal(snapshot.diagnostics.playbackState, 'playing');
  assert.ok(
    (snapshot.diagnostics.inboundAudioLevel ?? 1) < 0.002,
    `silent stream measured ${snapshot.diagnostics.inboundAudioLevel}`
  );

  // Real sound on the same stream.
  fakeAudioAmplitude = 0.4;
  await (engine as any).sampleStats();
  snapshot = engine.getSnapshot();
  assert.equal(snapshot.inboundSoundDetected, true, 'measurable sound must be reported');
  assert.ok(
    (snapshot.diagnostics.inboundAudioLevel ?? 0) > 0.1,
    `loud stream measured ${snapshot.diagnostics.inboundAudioLevel}`
  );
  assert.ok(snapshot.diagnostics.lastSoundAgoMs !== null);
});

test('blocked browser playback is reported and later cleared without dropping the call', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  element.playOutcome = 'blocked';
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  deliverRemoteTrack(pc, inboundTrack('customer-mic'));
  await sleep(10);

  let snapshot = engine.getSnapshot();
  assert.equal(snapshot.playbackBlocked, true, 'a rejected play() must be surfaced');
  assert.equal(snapshot.playbackState, 'blocked');
  assert.match(String((engine as any).playbackError), /NotAllowedError/);
  assert.equal(snapshot.callState, 'connected', 'a playback failure must not end the call');

  // A user gesture (the Enable audio button) resumes playback.
  element.playOutcome = 'ok';
  assert.equal(await engine.resumePlayback(), true);
  snapshot = engine.getSnapshot();
  assert.equal(snapshot.playbackBlocked, false);
  assert.equal(snapshot.playbackState, 'playing');
  assert.equal((engine as any).playbackError, null);
});

test('a play() interrupted by a newer attach is not reported as blocked', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  element.playOutcome = 'abort';
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  deliverRemoteTrack(pc, inboundTrack('customer-mic'));
  await sleep(10);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.playbackBlocked, false, 'AbortError is not a playback policy failure');
});

test('a replaced remote track reuses one stream and never duplicates playback', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  const first = inboundTrack('first-mic');
  deliverRemoteTrack(pc, first);
  await sleep(5);
  const stream = (engine as any).remoteStream as FakeMediaStream;
  assert.ok(stream, 'the salesperson must hold a remote stream');
  assert.equal(element.srcObject, stream);

  // The customer's track is replaced (renegotiation / ICE restart).
  const second = inboundTrack('second-mic');
  pc.receiverTracks = [second];
  pc.ontrack?.({ track: second, streams: [new FakeStream([second])] });
  await sleep(5);

  assert.equal((engine as any).remoteStream, stream, 'the element must keep one stream object');
  assert.equal(stream.getAudioTracks().length, 1, 'exactly one remote audio track may be attached');
  assert.equal(stream.getAudioTracks()[0].id, 'second-mic');
  assert.equal(element.srcObject, stream, 'playback must not be re-pointed at a second stream');
});

test('a repeated ontrack for the same track keeps one playback path and one analyser', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  const track = inboundTrack('customer-mic');
  deliverRemoteTrack(pc, track);
  await sleep(5);

  const stream = (engine as any).remoteStream as FakeMediaStream;
  const playCallsAfterFirstAttach = element.playCalls;
  mediaStreamSourceCreations = 0;
  fakeAudioAmplitude = 0.4;
  await (engine as any).sampleStats();
  assert.equal(engine.getSnapshot().inboundSoundDetected, true, 'sound must be measured first');

  // The browser emits `ontrack` again for the same m-line (a second stream
  // object, a re-emitted event, the receiver fallback).
  pc.ontrack?.({ track, streams: [new FakeStream([track])] });
  await sleep(5);
  pc.ontrack?.({ track, streams: [new FakeStream([track])] });
  await sleep(5);

  assert.equal((engine as any).remoteStream, stream, 'the stable remote stream must be reused');
  assert.equal(stream.getAudioTracks().length, 1, 'exactly one remote track may be attached');
  assert.equal(element.srcObject, stream, 'the element must keep the single stream');
  assert.equal(
    element.playCalls,
    playCallsAfterFirstAttach,
    'a repeated ontrack must not restart playback'
  );
  assert.equal(
    mediaStreamSourceCreations,
    0,
    'a repeated ontrack must not build a second analyser graph'
  );
  // The measured sound clock belongs to the stream, not to the event.
  assert.equal(
    engine.getSnapshot().inboundSoundDetected,
    true,
    'a repeated ontrack must not reset the measured sound state'
  );
});

test('a remounted audio element leaves exactly one playback path', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const first = new FakeAudioElement();
  engine.attachAudioElement(first as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  deliverRemoteTrack(pc, inboundTrack('customer-mic'));
  await sleep(5);
  const stream = (engine as any).remoteStream as FakeMediaStream;
  assert.equal(first.srcObject, stream);
  assert.equal(first.paused, false);

  // React remounts the <audio> element: a new instance becomes the mounted one.
  const second = new FakeAudioElement();
  engine.attachAudioElement(second as unknown as HTMLAudioElement);
  await sleep(5);

  assert.equal(first.paused, true, 'the detached element must stop playing');
  assert.equal(first.srcObject, null, 'the detached element must not keep the stream');
  assert.equal(second.srcObject, stream, 'the mounted element adopts the same single stream');
  assert.equal(second.paused, false, 'the mounted element must play');
  assert.equal(
    [first, second].filter((element) => element.srcObject !== null).length,
    1,
    'only one element may hold a playback path'
  );
  assert.equal((engine as any).audioElement, second, 'the engine must point at the mounted element');
});

test('a reconnect detaches the old playback path before a new one exists', async (t) => {
  const { engine, ws, pc, sessions } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  deliverRemoteTrack(pc, inboundTrack('customer-mic'));
  await sleep(5);
  assert.equal(element.paused, false);

  // The peer leaves and rejoins: a fresh peer connection and a fresh stream.
  ws.receive({ type: 'peer_left', participantId: 'customer-1' });
  await sleep(10);
  assert.equal(element.srcObject, null, 'a closed connection must not keep its stream');
  assert.equal(element.paused, true);
  assert.equal(engine.getSnapshot().playbackState, 'no_track');

  ws.receive({
    type: 'joined',
    sessionId: 'session-test',
    participantId: 'salesperson-1',
    role: 'salesperson',
    peers: [{ participantId: 'customer-1', role: 'customer' }],
    participants: [
      { participantId: 'salesperson-1', role: 'salesperson' },
      { participantId: 'customer-1', role: 'customer' },
    ],
  });
  await sleep(10);
  const nextPc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  await answerOffer(ws, nextPc);
  nextPc.__setConnectionState('connected');
  const replacement = inboundTrack('customer-mic-2');
  nextPc.receiverTracks = [replacement];
  nextPc.ontrack?.({ track: replacement, streams: [new FakeStream([replacement])] });
  await sleep(10);

  const stream = (engine as any).remoteStream as FakeMediaStream;
  assert.ok(stream, 'the reconnected call must hold a remote stream');
  assert.equal(element.srcObject, stream, 'one element, one stream after the reconnect');
  assert.equal(stream.getAudioTracks().length, 1);
  assert.equal(element.paused, false, 'audio must play again after the reconnect');
  assert.equal(sessions.length, 0, 'a salesperson never creates an AI session');
});

test('stopping the call releases the capture, its listeners, the analysers and playback', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  deliverRemoteTrack(pc, inboundTrack('customer-mic'));
  await sleep(10);

  const context = (engine as any).audioContext as FakeAudioContext;
  const localTrack = (engine as any).localStream.getAudioTracks()[0] as FakeTrack;
  assert.ok(localTrack.listenerCount('ended') > 0, 'the capture must be supervised');
  assert.equal(element.paused, false);

  await engine.stop('test finished');

  assert.equal(localTrack.readyState, 'ended', 'the microphone capture must be released');
  assert.equal(
    localTrack.listenerCount('ended'),
    0,
    'a stopped call must not leave track listeners behind'
  );
  assert.equal(localTrack.listenerCount('mute'), 0);
  assert.equal(element.srcObject, null, 'the playback path must be detached');
  assert.equal(element.paused, true);
  assert.equal((engine as any).remoteStream, null);
  assert.equal((engine as any).remoteTrack, null);
  assert.equal((engine as any).inboundAnalyser, null);
  assert.equal((engine as any).outboundAnalyser, null);
  assert.equal(context.state, 'closed', 'the measurement AudioContext must be closed');
  assert.equal((engine as any).statsTimer, null);
  assert.equal((engine as any).reportTimer, null);
  assert.equal((engine as any).micRecoveryTimer, null);
  assert.equal(engine.getSnapshot().playbackState, 'no_track');
});


test('quiet speech is measured and never gated by audio processing', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');
  deliverRemoteTrack(pc, inboundTrack('customer-mic'));

  // A quiet talker: about -40 dBFS. Any gate or level threshold would drop this,
  // and the engine has none - it only *measures*.
  fakeAudioAmplitude = 0.01;
  await (engine as any).sampleStats();
  let snapshot = engine.getSnapshot();
  const quietRms = snapshot.diagnostics.localAudioLevel ?? 0;
  assert.ok(quietRms > 0.006, `a quiet capture must still be measured (rms ${quietRms})`);
  assert.equal(snapshot.localTrackState, 'live', 'quiet audio must not stop the capture');
  assert.equal((engine as any).micCaptures, 1, 'quiet audio must not trigger a re-capture');

  // The same quiet level on the inbound side is quiet, but still audible.
  fakeAudioAmplitude = 0.02;
  await (engine as any).sampleStats();
  snapshot = engine.getSnapshot();
  assert.equal(snapshot.inboundSoundDetected, true, 'quiet speech must count as audible');
  assert.ok((snapshot.diagnostics.inboundAudioLevel ?? 0) > 0.005);
  assert.equal(snapshot.playbackState, 'playing', 'playback must stay running');
});

test('each participant publishes its own microphone and plays only the remote track', async (t) => {
  // Salesperson: one audio sender, one remote playback path.
  const sales = await setupPeer('salesperson');
  t.after(async () => sales.engine.stop('test finished'));
  await answerOffer(sales.ws, sales.pc);
  sales.pc.__setConnectionState('connected');
  const salesElement = new FakeAudioElement();
  sales.engine.attachAudioElement(salesElement as unknown as HTMLAudioElement);
  const salesRemote = inboundTrack('customer-mic');
  deliverRemoteTrack(sales.pc, salesRemote);
  await sleep(10);
  assert.equal(sales.pc.senders.length, 1, 'the salesperson publishes exactly one audio sender');
  assert.equal(sales.pc.senders[0].track?.readyState, 'live');
  assert.notEqual(sales.pc.senders[0].track, salesRemote, 'a participant never republishes the remote track');
  assert.equal(salesElement.srcObject !== null, true);
  assert.equal(
    ((salesElement.srcObject as FakeMediaStream).getAudioTracks()[0] as FakeTrack).id,
    'customer-mic',
    'the element must play the remote track'
  );
  assert.equal(sales.sessions.length, 0, 'the salesperson microphone is never sent to Ultravox');

  // Customer: the same shape in the other direction.
  const customer = await setupPeer('customer');
  t.after(async () => customer.engine.stop('test finished'));
  await answerOffer(customer.ws, customer.pc);
  customer.pc.__setConnectionState('connected');
  const customerElement = new FakeAudioElement();
  customer.engine.attachAudioElement(customerElement as unknown as HTMLAudioElement);
  const customerRemote = inboundTrack('salesperson-mic');
  deliverRemoteTrack(customer.pc, customerRemote);
  await sleep(10);
  assert.equal(customer.pc.senders.length, 1, 'the customer publishes exactly one audio sender');
  assert.equal(customer.pc.senders[0].track?.readyState, 'live');
  assert.notEqual(customer.pc.senders[0].track, customerRemote);
  assert.equal(
    ((customerElement.srcObject as FakeMediaStream).getAudioTracks()[0] as FakeTrack).id,
    'salesperson-mic',
    'the element must play the remote track'
  );
});

test('a remote audio receiver is adopted even when ontrack never fires', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);

  // The browser delivered the receiver but never emitted ontrack.
  pc.receiverTracks = [inboundTrack('receiver-mic')];
  pc.__setConnectionState('connected');
  await sleep(10);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.remoteTrackState, 'live');
  const stream = (engine as any).remoteStream as FakeMediaStream;
  assert.ok(stream, 'the receiver track must reach the audio element');
  assert.equal(stream.getAudioTracks()[0].id, 'receiver-mic');
  assert.equal(element.srcObject, stream);
});

test('an ended remote track is reported and a replacement track restores audio', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  const element = new FakeAudioElement();
  engine.attachAudioElement(element as unknown as HTMLAudioElement);
  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  const first = inboundTrack('first-mic');
  deliverRemoteTrack(pc, first);
  await sleep(5);
  first.readyState = 'ended';
  first.onended?.();
  await sleep(5);
  assert.equal(engine.getSnapshot().remoteTrackState, 'ended');
  assert.equal(engine.getSnapshot().playbackState, 'no_track');

  const second = inboundTrack('replacement-mic');
  pc.receiverTracks = [second];
  pc.ontrack?.({ track: second, streams: [new FakeStream([second])] });
  await sleep(5);
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.remoteTrackState, 'live');
  assert.equal(((engine as any).remoteStream as FakeMediaStream).getAudioTracks()[0].id, 'replacement-mic');
  assert.notEqual(engine.getSnapshot().playbackState, 'no_track');
});

test('the customer asks for a renegotiation when its microphone cannot be sent', async (t) => {
  const { engine, ws, pc } = await setupPeer('customer');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  // The negotiated answer cannot carry the customer's microphone.
  pc.audioCurrentDirection = 'recvonly';
  pc.__setConnectionState('connected');
  await sleep(10);

  const requests = ws.sent.filter((message) => message.type === 'renegotiate');
  assert.equal(requests.length, 1, 'the customer must ask the offerer to renegotiate');
  assert.match(String(requests[0].reason), /send/);

  // The request is bounded: repeated checks do not flood signaling.
  await (engine as any).checkAudioDirection('repeat');
  await sleep(5);
  assert.equal(ws.sent.filter((message) => message.type === 'renegotiate').length, 1);
});

test('the salesperson renegotiates when the answer cannot deliver customer audio', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  // The customer answered recvonly: this side can send but never receive.
  pc.audioCurrentDirection = 'sendonly';
  pc.__setConnectionState('connected');
  await sleep(20);

  const offers = pc.createOfferCalls.filter((call) => !call.iceRestart);
  assert.ok(offers.length >= 2, 'a repair offer must follow the one-way negotiation');
  assert.equal(engine.getSnapshot().diagnostics.audioDirection, 'sendonly');
});

test('a sendrecv negotiation never triggers a direction repair', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.audioCurrentDirection = 'sendrecv';
  pc.__setConnectionState('connected');
  await sleep(20);

  assert.equal(pc.createOfferCalls.filter((call) => !call.iceRestart).length, 1);
  assert.match(String(ws.sent.filter((m) => m.type === 'renegotiate').length), /^0$/);
});

test('the salesperson never creates an Ultravox session for its own microphone', async (t) => {
  const { engine, sessions } = await setupPeer('salesperson', { enableAi: true });
  t.after(async () => engine.stop('test finished'));

  await sleep(20);
  assert.equal(sessions.length, 0, 'only the customer device may run the AI session');
  assert.equal(ultravoxCallCount, 0, 'the salesperson must never request an AI call');
  assert.equal(engine.getSnapshot().ai.state, 'off');
});

test('an outbound capture that ended without an event is re-acquired, never published as silence', async (t) => {
  const { engine, ws, pc } = await setupPeer('salesperson');
  t.after(async () => engine.stop('test finished'));

  await answerOffer(ws, pc);
  pc.__setConnectionState('connected');

  const sender = pc.getSenders()[0] as { track: FakeTrack | null };
  const original = sender.track;
  assert.ok(original, 'the microphone must be published');
  // `track.stop()` and some OS revocations end the track with no `ended` event.
  original.readyState = 'ended';

  await (engine as any).sampleStats();
  await sleep(20);

  assert.notEqual(sender.track, original, 'the sender must carry a freshly captured track');
  assert.equal(sender.track?.readyState, 'live');
  assert.equal(engine.getSnapshot().localTrackState, 'live');
});
