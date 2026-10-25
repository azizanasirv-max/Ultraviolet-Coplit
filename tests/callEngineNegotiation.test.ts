/**
 * Deterministic negotiation / recovery tests for CallEngine.
 *
 * These use a fake RTCPeerConnection and a manual clock installed on `window`,
 * so every timer and state transition is observable without real media or a
 * real network. Real-browser coverage lives in tests/browser-audio.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class Clock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void; interval: number | null }>();

  now(): number {
    return this.time;
  }

  setTimeout = (callback: () => void, ms = 0): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback, interval: null });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  setInterval = (callback: () => void, ms = 0): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(1, ms), callback, interval: Math.max(1, ms) });
    return id;
  };

  clearInterval = (id: number): void => {
    this.timers.delete(id);
  };

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.time = timer.at;
      if (timer.interval === null) this.timers.delete(nextId);
      else timer.at = this.time + timer.interval;
      timer.callback();
    }
    this.time = end;
  }
}

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url = '') {
    FakeSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(): void {
    this.readyState = 3;
  }
}

class FakeTrack {
  kind = 'audio';
  readyState = 'live';
  enabled = true;
  muted = false;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  onended: (() => void) | null = null;
  addEventListener(): void {}
  stop(): void {
    this.readyState = 'ended';
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeDescription {
  constructor(public init: { type: string; sdp?: string }) {}
  get type() {
    return this.init.type;
  }
  get sdp() {
    return this.init.sdp ?? '';
  }
}

class FakeCandidate {
  constructor(public init: any) {}
  toJSON() {
    return this.init;
  }
}


class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static constructed = 0;
  static ufragSeq = 0;

  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: FakeDescription | null = null;
  remoteDescription: FakeDescription | null = null;
  onicecandidate: ((event: any) => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  ontrack: ((event: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  offerOptions: any[] = [];
  senders: Array<{ track: FakeTrack; replaceTrack: (track: FakeTrack) => Promise<void> }> = [];
  rollbacks = 0;
  closed = false;

  constructor(public config: any) {
    FakePeerConnection.constructed += 1;
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack): void {
    const sender = { track, replaceTrack: async (next: FakeTrack) => { sender.track = next; } };
    this.senders.push(sender);
  }

  getSenders() {
    return this.senders;
  }

  async createOffer(options?: any): Promise<FakeDescription> {
    this.offerOptions.push(options ?? null);
    FakePeerConnection.ufragSeq += 1;
    return new FakeDescription({
      type: 'offer',
      sdp: `v=0\r\na=ice-ufrag:u${FakePeerConnection.ufragSeq}\r\na=ice-pwd:p${FakePeerConnection.ufragSeq}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`,
    });
  }

  async createAnswer(): Promise<FakeDescription> {
    return new FakeDescription({
      type: 'answer',
      sdp: `v=0\r\na=ice-ufrag:u${FakePeerConnection.ufragSeq}\r\na=ice-pwd:p${FakePeerConnection.ufragSeq}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`,
    });
  }

  async setLocalDescription(description: FakeDescription): Promise<void> {
    if (description.type === 'rollback') {
      this.rollbacks += 1;
      this.localDescription = null;
      this.signalingState = 'stable';
    } else if (description.type === 'offer') {
      this.localDescription = description;
      this.signalingState = 'have-local-offer';
    } else {
      this.localDescription = description;
      this.signalingState = 'stable';
    }
    this.onsignalingstatechange?.();
  }

  async setRemoteDescription(description: FakeDescription): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.onsignalingstatechange?.();
  }

  async addIceCandidate(): Promise<void> {}

  async getStats() {
    return { forEach: () => undefined };
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  emitConnection(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  emitIce(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

const clock = new Clock();
const globalWindow: any = {
  location: { protocol: 'http:', host: 'localhost' },
  setTimeout: clock.setTimeout,
  clearTimeout: clock.clearTimeout,
  setInterval: clock.setInterval,
  clearInterval: clock.clearInterval,
};
(globalThis as any).window = globalWindow;
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true, language: 'en-US' },
  configurable: true,
});
(globalThis as any).WebSocket = FakeSocket;
(globalThis as any).RTCPeerConnection = FakePeerConnection;
(globalThis as any).MediaStream = FakeStream;
(globalThis as any).RTCSessionDescription = FakeDescription;
(globalThis as any).RTCIceCandidate = FakeCandidate;
if (typeof (URL as any).createObjectURL !== 'function') {
  (URL as any).createObjectURL = () => 'blob:test';
}

const { CallEngine } = await import('../src/lib/callEngine');
type Engine = InstanceType<typeof CallEngine>;

const tick = () => new Promise((resolve) => setImmediate(resolve));

const makeEngine = (role: 'salesperson' | 'customer', enableAi = false) => {
  const updates: any[] = [];
  const engine: Engine = new CallEngine({
    sessionId: 'session-test',
    role,
    credential: 'credential',
    enableAi,
    onUpdate: (snapshot: any) => updates.push(snapshot),
  });
  const socket = new FakeSocket();
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const internals = engine as any;
  internals.started = true;
  internals.participantId = 'self';
  internals.ws = socket;
  internals.localStream = stream;
  internals.micPermission = 'granted';
  internals.iceConfigLoaded = true;
  internals.iceConfig = {
    iceServers: [],
    hasTurn: false,
    hasStun: false,
    iceTransportPolicy: 'all',
    turn: { configured: false, credentialMode: 'none', urlCount: 0, expiresAt: null },
    warnings: [],
    errors: [],
    generatedAt: new Date(0).toISOString(),
  };
  return { engine, socket, updates, track, stream };
};

const connectPeer = async (role: 'salesperson' | 'customer') => {
  const context = makeEngine(role);
  const engine = context.engine as any;
  engine.peerParticipantId = 'peer';
  engine.peerRole = role === 'salesperson' ? 'customer' : 'salesperson';
  engine.createPeerConnection({ participantId: 'peer', role: engine.peerRole });
  const pc: FakePeerConnection = engine.pc;
  if (role === 'salesperson') {
    await engine.makeOffer({ reason: 'test' });
    await tick();
    await engine.handleSignal({
      type: 'answer',
      from: 'peer',
      answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a1\r\na=ice-pwd:p1\r\n' },
    });
  }
  pc.emitConnection('connected');
  pc.emitIce('connected');
  return { ...context, pc };
};

const offers = (socket: FakeSocket) => socket.sent.filter((message) => message.type === 'offer');

const sessionState = (role: 'salesperson' | 'customer') => ({
  type: 'session_state',
  participants: [
    { participantId: 'self', role },
    { participantId: 'peer', role: role === 'salesperson' ? 'customer' : 'salesperson' },
  ],
  session: {},
});


test('presence refreshes never create a duplicate offer during negotiation', async () => {
  const { engine, socket } = makeEngine('salesperson');
  const internals = engine as any;
  internals.peerParticipantId = 'peer';
  internals.peerRole = 'customer';
  internals.createPeerConnection({ participantId: 'peer', role: 'customer' });
  const pc: FakePeerConnection = internals.pc;

  await internals.makeOffer({ reason: 'initial' });
  await tick();
  assert.equal(offers(socket).length, 1);
  assert.equal(pc.signalingState, 'have-local-offer');

  for (let index = 0; index < 6; index += 1) {
    await internals.handleSignal(sessionState('salesperson'));
  }
  assert.equal(pc.offerOptions.length, 1, 'no second createOffer while have-local-offer');
  assert.equal(offers(socket).length, 1, 'no duplicate offer was sent');
  assert.equal(pc.signalingState, 'have-local-offer');

  // Answer arrives: the negotiation is complete and a later presence refresh
  // still must not re-offer.
  await internals.handleSignal({
    type: 'answer',
    from: 'peer',
    answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a1\r\na=ice-pwd:p1\r\n' },
  });
  assert.equal(pc.signalingState, 'stable');
  for (let index = 0; index < 6; index += 1) {
    await internals.handleSignal(sessionState('salesperson'));
  }
  assert.equal(offers(socket).length, 1);
});

test('makeOffer is refused while an offer is already awaiting an answer or signaling is not stable', async () => {
  const { engine, socket } = makeEngine('salesperson');
  const internals = engine as any;
  internals.peerParticipantId = 'peer';
  internals.peerRole = 'customer';
  internals.createPeerConnection({ participantId: 'peer', role: 'customer' });
  const pc: FakePeerConnection = internals.pc;

  await internals.makeOffer({ reason: 'initial' });
  await tick();
  const sentBefore = offers(socket).length;
  const createdBefore = pc.offerOptions.length;

  const second = await internals.makeOffer({ reason: 'duplicate' });
  assert.equal(second, false);
  assert.equal(offers(socket).length, sentBefore);
  assert.equal(pc.offerOptions.length, createdBefore);

  pc.signalingState = 'have-remote-offer';
  const third = await internals.makeOffer({ reason: 'unstable' });
  assert.equal(third, false);
  assert.equal(offers(socket).length, sentBefore);
});

test('a pending ICE restart is queued and starts when signaling becomes stable', async () => {
  const { engine, socket, pc } = await connectPeer('salesperson');
  const internals = engine as any;
  const offersBefore = offers(socket).length;

  // Simulate a renegotiation already in flight.
  pc.signalingState = 'have-local-offer';
  internals.offerInFlight = true;
  internals.requestIceRestart('simulated failure');
  assert.equal(internals.restartAttempts, 0);
  assert.equal(internals.pendingIceRestart, true);
  assert.equal(offers(socket).length, offersBefore);

  pc.signalingState = 'stable';
  internals.handleSignalingStable(pc, internals.pcGeneration);
  await tick();

  assert.equal(internals.restartAttempts, 1);
  assert.equal(internals.pendingIceRestart, false);
  const restartOffers = offers(socket).slice(offersBefore);
  assert.equal(restartOffers.length, 1);
  assert.equal(pc.offerOptions.at(-1)?.iceRestart, true);
});

test('duplicate connection/ICE failure events produce one bounded restart attempt', async () => {
  const { engine, socket, pc } = await connectPeer('salesperson');
  const internals = engine as any;
  const offersBefore = offers(socket).length;

  pc.emitConnection('failed');
  pc.emitIce('failed');
  await tick();

  assert.equal(internals.restartAttempts, 1, 'only one recovery attempt was started');
  assert.equal(offers(socket).length, offersBefore + 1);
  assert.equal(pc.offerOptions.at(-1)?.iceRestart, true);

  // Answering alone does not reset the budget; only a genuine `connected` does.
  await internals.handleSignal({
    type: 'answer',
    from: 'peer',
    answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a2\r\na=ice-pwd:p2\r\n' },
  });
  assert.equal(internals.restartAttempts, 1);
  assert.equal(engine.getSnapshot().recovery.phase, 'recovering');

  pc.emitConnection('connected');
  assert.equal(internals.restartAttempts, 0);
  assert.equal(engine.getSnapshot().recovery.phase, 'idle');
  assert.equal(engine.getSnapshot().callState, 'connected');
});


test('exhausted recovery produces one actionable terminal error and no peer-connection churn', async () => {
  const { engine, socket, pc } = await connectPeer('salesperson');
  const internals = engine as any;
  const ai = { ...engine.getSnapshot().ai, state: 'connected', connected: true } as any;
  internals.ai = ai;
  let stopAiCalls = 0;
  internals.stopAi = async () => {
    stopAiCalls += 1;
  };

  const answer = async () => {
    await internals.handleSignal({
      type: 'answer',
      from: 'peer',
      answer: { type: 'answer', sdp: `v=0\r\na=ice-ufrag:a${internals.restartAttempts}\r\na=ice-pwd:p\r\n` },
    });
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    pc.emitConnection('failed');
    await tick();
    assert.equal(internals.restartAttempts, attempt);
    await answer();
    clock.advance(8000); // restart outcome timeout (still not connected)
    if (attempt < 3) clock.advance(4000); // bounded backoff before the next attempt
    await tick();
  }

  assert.equal(internals.terminalFailure, true);
  assert.equal(engine.getSnapshot().callState, 'failed');
  assert.equal(engine.getSnapshot().recovery.phase, 'exhausted');
  assert.match(String(engine.getSnapshot().lastError), /Could not restore the audio connection/i);
  assert.match(String(engine.getSnapshot().lastError), /retry/i);
  assert.equal(stopAiCalls, 0, 'terminal WebRTC failure must not stop the AI session');
  assert.equal(engine.getSnapshot().ai.connected, true);

  const constructed = FakePeerConnection.constructed;
  const offersBefore = offers(socket).length;
  for (let index = 0; index < 8; index += 1) {
    await internals.handleSignal(sessionState('salesperson'));
  }
  assert.equal(FakePeerConnection.constructed, constructed, 'no peer-connection churn after terminal failure');
  assert.equal(offers(socket).length, offersBefore, 'no offers after terminal failure');
  assert.equal(engine.getSnapshot().callState, 'failed');
});

test('a manual retry leaves terminal state and creates exactly one fresh connection', async () => {
  const { engine, socket } = await connectPeer('salesperson');
  const internals = engine as any;
  internals.failCall('Could not restore the audio connection after repeated attempts.');
  assert.equal(engine.getSnapshot().callState, 'failed');
  const constructedBefore = FakePeerConnection.constructed;
  const offersBefore = offers(socket).length;

  engine.retryCall('user pressed retry');
  await tick();

  assert.equal(engine.getSnapshot().callState === 'failed', false);
  assert.equal(FakePeerConnection.constructed, constructedBefore + 1);
  assert.equal(offers(socket).length, offersBefore + 1);
  assert.equal(engine.getSnapshot().recovery.attempt, 0);
  assert.equal(engine.getSnapshot().recovery.phase, 'idle');
});

test('replacing a peer connection cancels timers and ignores stale callbacks', async () => {
  const { engine, socket } = makeEngine('salesperson');
  const internals = engine as any;
  internals.peerParticipantId = 'peer';
  internals.peerRole = 'customer';
  internals.createPeerConnection({ participantId: 'peer', role: 'customer' });
  const oldPc: FakePeerConnection = internals.pc;

  // Remote track handlers on the old connection.
  const remoteTrack = new FakeTrack();
  oldPc.ontrack?.({ track: remoteTrack, streams: [new FakeStream([remoteTrack])] });
  assert.equal(engine.getSnapshot().remoteTrackState, 'live');
  const oldConnectionHandler = oldPc.onconnectionstatechange;
  const oldTrackEnded = remoteTrack.onended;

  // Offer that is awaiting an answer -> a live answer timeout on the old PC.
  await internals.makeOffer({ reason: 'old offer' });
  await tick();
  const offersBefore = offers(socket).length;
  assert.equal(offersBefore, 1);
  assert.notEqual(internals.offerTimer, null);

  // Replace the connection without making a new offer yet.
  internals.createPeerConnection({ participantId: 'peer', role: 'customer' });
  const freshPc: FakePeerConnection = internals.pc;
  assert.notEqual(freshPc, oldPc);
  assert.equal(internals.offerTimer, null, 'the old offer timeout was cancelled');

  clock.advance(60000);
  assert.equal(offers(socket).length, offersBefore, 'the replaced PC sent nothing');

  // Stale callbacks from the old generation are ignored.
  freshPc.emitConnection('connecting');
  assert.equal(engine.getSnapshot().callState, 'connecting');
  oldPc.connectionState = 'connected';
  oldConnectionHandler?.();
  oldTrackEnded?.();
  assert.equal(engine.getSnapshot().callState, 'connecting');
  assert.equal(engine.getSnapshot().remoteTrackState, 'none');

  // Teardown clears every remaining timer.
  internals.closePeerConnection('test teardown');
  assert.equal(internals.offerTimer, null);
  assert.equal(internals.restartOutcomeTimer, null);
  assert.equal(internals.restartRetryTimer, null);
  assert.equal(internals.disconnectTimer, null);
});


test('the customer requests a bounded restart through signaling and independent AI survives failure', async () => {
  const { engine, socket, pc } = await connectPeer('customer');
  const internals = engine as any;
  const ai = { ...engine.getSnapshot().ai, state: 'connected', connected: true } as any;
  internals.ai = ai;
  let stopAiCalls = 0;
  internals.stopAi = async () => {
    stopAiCalls += 1;
  };

  pc.emitConnection('failed');
  await tick();
  const requests = socket.sent.filter((message) => message.type === 'restart_request');
  assert.equal(requests.length, 1);
  assert.match(String(requests[0].reason), /connection failed/);

  // Repeated failure events are throttled into the same request.
  pc.emitConnection('failed');
  pc.emitIce('failed');
  await tick();
  assert.equal(socket.sent.filter((message) => message.type === 'restart_request').length, 1);

  // Bounded customer deadline.
  clock.advance(40000);
  assert.equal(engine.getSnapshot().callState, 'failed');
  assert.equal(engine.getSnapshot().recovery.phase, 'exhausted');
  assert.match(String(engine.getSnapshot().lastError), /Could not restore the audio connection/i);
  assert.equal(stopAiCalls, 0);
  assert.equal(engine.getSnapshot().ai.connected, true);

  const constructed = FakePeerConnection.constructed;
  engine.retryCall('customer retry');
  await tick();
  assert.equal(FakePeerConnection.constructed, constructed + 1);
  assert.equal(socket.sent.filter((message) => message.type === 'restart_request').length, 2);
});

test('the salesperson answers a customer restart request with a fresh ICE-restart offer', async () => {
  const { engine, socket, pc } = await connectPeer('salesperson');
  const internals = engine as any;
  const offersBefore = offers(socket).length;

  await internals.handleSignal({ type: 'restart_request', from: 'peer', reason: 'customer failure' });
  await tick();

  assert.equal(offers(socket).length, offersBefore + 1);
  assert.equal(pc.offerOptions.at(-1)?.iceRestart, true);
});

test('an identical offer is answered again (lost answer) but a same-credential renegotiation is processed', async () => {
  const { engine, socket } = makeEngine('customer');
  const internals = engine as any;
  internals.peerParticipantId = 'peer';
  internals.peerRole = 'salesperson';
  internals.createPeerConnection({ participantId: 'peer', role: 'salesperson' });
  const pc: FakePeerConnection = internals.pc;
  const constructed = FakePeerConnection.constructed;

  const firstOffer = {
    type: 'offer',
    from: 'peer',
    offer: {
      type: 'offer',
      sdp: 'v=0\r\na=ice-ufrag:u1\r\na=ice-pwd:p1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    },
  };
  await internals.handleSignal(firstOffer);
  assert.equal(socket.sent.filter((message) => message.type === 'answer').length, 1);

  // Exact duplicate (the offerer re-sent because our answer was lost).
  await internals.handleSignal(firstOffer);
  assert.equal(socket.sent.filter((message) => message.type === 'answer').length, 2);
  assert.equal(FakePeerConnection.constructed, constructed, 'no new peer connection for a duplicate offer');

  // Same ICE credentials but a different SDP is a legitimate renegotiation,
  // not a duplicate: it must be answered.
  const renegotiation = {
    type: 'offer',
    from: 'peer',
    offer: {
      type: 'offer',
      sdp: 'v=0\r\na=ice-ufrag:u1\r\na=ice-pwd:p1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 0\r\n',
    },
  };
  pc.signalingState = 'stable';
  await internals.handleSignal(renegotiation);
  assert.equal(socket.sent.filter((message) => message.type === 'answer').length, 3);
});


test('a connection that never fires failed still recovers via the bounded connect watchdog', async () => {
  const { engine, socket } = makeEngine('salesperson');
  const internals = engine as any;
  internals.peerParticipantId = 'peer';
  internals.peerRole = 'customer';
  internals.createPeerConnection({ participantId: 'peer', role: 'customer' });
  const pc: FakePeerConnection = internals.pc;

  await internals.makeOffer({ reason: 'initial' });
  await tick();
  await internals.handleSignal({
    type: 'answer',
    from: 'peer',
    answer: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:a1\r\na=ice-pwd:p1\r\n' },
  });
  assert.equal(pc.signalingState, 'stable');
  assert.equal(engine.getSnapshot().callState, 'connecting');
  const offersBefore = offers(socket).length;

  clock.advance(29999);
  assert.equal(internals.restartAttempts, 0);
  assert.equal(offers(socket).length, offersBefore);

  clock.advance(1);
  await tick();
  assert.equal(internals.restartAttempts, 1);
  assert.equal(offers(socket).length, offersBefore + 1);
  assert.equal(pc.offerOptions.at(-1)?.iceRestart, true);
});

test('duplicate peer_joined announcements keep one connection; a new peer identity gets a fresh offer', async () => {
  const { engine, socket } = await connectPeer('salesperson');
  const internals = engine as any;
  const constructed = FakePeerConnection.constructed;
  const offersBefore = offers(socket).length;

  await internals.handleSignal({
    type: 'peer_joined',
    peer: { participantId: 'peer', role: 'customer' },
    participants: [
      { participantId: 'self', role: 'salesperson' },
      { participantId: 'peer', role: 'customer' },
    ],
  });
  assert.equal(FakePeerConnection.constructed, constructed, 'live connection must be kept');
  assert.equal(offers(socket).length, offersBefore, 'no duplicate offer for a repeated announcement');

  await internals.handleSignal({
    type: 'peer_joined',
    peer: { participantId: 'peer-new', role: 'customer' },
    participants: [
      { participantId: 'self', role: 'salesperson' },
      { participantId: 'peer-new', role: 'customer' },
    ],
  });
  await tick();
  assert.equal(FakePeerConnection.constructed, constructed + 1, 'a new peer identity gets a fresh connection');
  assert.equal(offers(socket).length, offersBefore + 1);
  assert.equal(internals.peerParticipantId, 'peer-new');
});
