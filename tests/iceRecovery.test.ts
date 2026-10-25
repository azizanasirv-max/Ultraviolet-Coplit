/**
 * Bounded ICE-recovery tests for CallEngine.
 *
 * IMPORTANT: these use a FAKE RTCPeerConnection and a fake signaling socket.
 * They prove the retry budget, de-duplication and the customer -> salesperson
 * restart request. They do NOT prove that real ICE succeeds or that a TURN
 * relay is reachable; the Chromium tests cover the real browser stack and a
 * real relay is still required for NAT-restricted pairs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CallEngine } from '../src/lib/callEngine';

(globalThis as any).window = {
  setTimeout: (handler: (...args: any[]) => void, timeout?: number) =>
    setTimeout(handler, timeout) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakePc {
  pc: any;
  offers: Array<{ iceRestart?: boolean }>;
}

/** Minimal RTCPeerConnection surface used by makeOffer(). */
const makePc = (): FakePc => {
  const offers: Array<{ iceRestart?: boolean }> = [];
  const pc: any = {
    signalingState: 'stable',
    localDescription: null,
    async createOffer(options?: { iceRestart?: boolean }) {
      offers.push({ ...(options ?? {}) });
      return {
        type: 'offer',
        sdp: `v=0\r\na=ice-ufrag:u${offers.length}\r\na=ice-pwd:p${offers.length}\r\n`,
      };
    },
    async setLocalDescription(description: any) {
      pc.localDescription = description;
      // The remote answer is applied immediately by the fake peer.
      pc.signalingState = 'stable';
    },
    close() {},
    getSenders() {
      return [];
    },
  };
  return { pc, offers };
};

const makeEngine = (
  role: 'customer' | 'salesperson',
  delays: number[]
): { engine: CallEngine; signals: any[]; fake: FakePc } => {
  const engine = new CallEngine({
    sessionId: 'session-ice',
    role,
    credential: 'credential-ice',
    iceRestartDelaysMs: delays,
    onUpdate: () => {},
  });
  const signals: any[] = [];
  (engine as any).ws = {
    readyState: 1,
    send: (raw: string) => signals.push(JSON.parse(raw)),
  };
  const fake = makePc();
  (engine as any).pc = fake.pc;
  (engine as any).peerParticipantId = 'peer-1';
  (engine as any).peerRole = role === 'salesperson' ? 'customer' : 'salesperson';
  return { engine, signals, fake };
};

test('salesperson ICE restarts are bounded and report the missing TURN relay', async () => {
  const { engine, signals, fake } = makeEngine('salesperson', [0, 0, 0]);
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await (engine as any).attemptIceRestart(`failure ${attempt}`);
      await sleep(10);
    }

    assert.equal(fake.offers.length, 3, 'never more than the bounded number of restarts');
    assert.ok(fake.offers.every((offer) => offer.iceRestart === true), 'every retry is an ICE restart');
    assert.equal(signals.filter((signal) => signal.type === 'offer').length, 3);

    const state = engine.getSnapshot();
    assert.equal(state.callState, 'failed');
    assert.match(String(state.lastError), /no TURN relay configured/i);
    assert.match(String(state.lastError), /TURN_URLS|TURN_CREDENTIALS_URL/);
  } finally {
    await engine.stop('test');
  }
});

test('simultaneous failed/disconnected events collapse into one restart', async () => {
  const { engine, fake } = makeEngine('salesperson', [30, 30, 30]);
  try {
    for (let event = 0; event < 5; event += 1) {
      await (engine as any).attemptIceRestart('duplicate event');
    }
    assert.equal(fake.offers.length, 0, 'no offer before the backoff elapses');
    await sleep(50);
    assert.equal(fake.offers.length, 1, 'one restart for a burst of failure events');
  } finally {
    await engine.stop('test');
  }
});

test('a recovered connection resets the ICE restart budget', async () => {
  const { engine, fake } = makeEngine('salesperson', [0, 0, 0]);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await (engine as any).attemptIceRestart(`failure ${attempt}`);
      await sleep(10);
    }
    assert.equal(fake.offers.length, 3);

    // What the connected handler does.
    (engine as any).noteIceHealthy();
    (engine as any).callState = 'connected';

    await (engine as any).attemptIceRestart('a new network failure');
    await sleep(10);
    assert.equal(fake.offers.length, 4, 'a healthy connection starts a fresh budget');
  } finally {
    await engine.stop('test');
  }
});

test('the customer asks the salesperson to restart instead of creating an offer', async () => {
  const { engine, signals, fake } = makeEngine('customer', [0, 0, 0]);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await (engine as any).attemptIceRestart(`customer failure ${attempt}`);
      await sleep(10);
    }

    assert.equal(fake.offers.length, 0, 'the answerer never creates an offer');
    const requests = signals.filter((signal) => signal.type === 'ice_restart_request');
    assert.equal(requests.length, 3, 'restart requests are bounded too');
    assert.equal(engine.getSnapshot().callState, 'failed');
  } finally {
    await engine.stop('test');
  }
});
