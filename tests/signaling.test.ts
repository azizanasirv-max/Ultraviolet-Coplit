import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createPrototype2Server } from '../server';
import type { AiBridgeSocket } from '../server/aiBridge';

// Injected server-side AI service config; the browser never sees the token.
process.env.AI_SERVICE_URL = 'https://ai.invalid';
process.env.AI_SERVICE_TOKEN = 'test-ai-token';

interface Harness {
  base: string;
  close: () => Promise<void>;
}

/**
 * In-process stand-in for the upstream Modal WebSocket. It records every frame
 * the server forwards and can emit any model event, so the whole server-side
 * bridge (audio in, text out) is exercised without a GPU or a real deployment.
 */
class FakeUpstream implements AiBridgeSocket {
  static instances: FakeUpstream[] = [];
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Array<string | Buffer> = [];
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  constructor(readonly url: string) {
    FakeUpstream.instances.push(this);
  }

  static latest(): FakeUpstream {
    const instance = FakeUpstream.instances.at(-1);
    assert.ok(instance, 'an upstream AI socket was created');
    return instance;
  }

  static reset(): void {
    FakeUpstream.instances = [];
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

  get json(): any[] {
    return this.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item));
  }

  get audio(): Buffer[] {
    return this.sent.filter((item): item is Buffer => Buffer.isBuffer(item));
  }
}

const startServer = async (
  options: {
    turnFetch?: typeof fetch;
    aiServiceFetch?: typeof fetch;
    aiSocketFactory?: (url: string) => AiBridgeSocket;
  } = {}
): Promise<Harness> => {
  const instance = await createPrototype2Server({
    serveFrontend: false,
    port: 0,
    aiServiceFetch:
      options.aiServiceFetch ??
      ((async () =>
        new Response(JSON.stringify({ callId: 'call_test', joinUrl: 'wss://ai.invalid/join' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch),
    aiSocketFactory: options.aiSocketFactory ?? ((url: string) => new FakeUpstream(url)),
    turnFetch: options.turnFetch,
  });
  return { base: `http://127.0.0.1:${instance.port}`, close: instance.close };
};

const post = async (base: string, path: string, body: unknown, key?: string) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const get = async (base: string, path: string, key?: string) => {
  const response = await fetch(`${base}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

interface TestSocket {
  send: (payload: unknown) => void;
  next: (predicate?: (message: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => void;
}

const openSocket = async (base: string): Promise<TestSocket> => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const queue: any[] = [];
  const waiters: Array<{ predicate: (message: any) => boolean; resolve: (value: any) => void }> = [];

  ws.on('message', (raw) => {
    let parsed: any;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return {
    send: (payload) => ws.send(JSON.stringify(payload)),
    next: (predicate = () => true, timeoutMs = 4000) => {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const position = waiters.findIndex((waiter) => waiter.resolve === wrapped);
          if (position >= 0) waiters.splice(position, 1);
          reject(new Error('Timed out waiting for a signaling message'));
        }, timeoutMs);
        const wrapped = (message: any) => {
          clearTimeout(timer);
          resolve(message);
        };
        waiters.push({ predicate, resolve: wrapped });
      });
    },
    close: () => ws.close(),
  };
};

interface Fixture {
  sessionId: string;
  salespersonKey: string;
  inviteUrl: string;
  inviteToken: string;
  customerKey: string;
}

const createFixture = async (base: string, label = 'Test'): Promise<Fixture> => {
  const created = await post(base, '/api/sessions', { label });
  assert.equal(created.status, 201);
  const inviteUrl: string = created.body.inviteUrl;
  assert.match(inviteUrl, /\/join\?invite=/);
  const inviteToken = decodeURIComponent(inviteUrl.split('invite=')[1]);

  const redeemed = await post(base, '/api/invitations/redeem', { inviteToken });
  assert.equal(redeemed.status, 200);

  return {
    sessionId: created.body.sessionId,
    salespersonKey: created.body.salespersonKey,
    inviteUrl,
    inviteToken,
    customerKey: redeemed.body.customerKey,
  };
};

const join = async (
  socket: TestSocket,
  params: { sessionId: string; role: string; credential: string; resumeToken?: string }
) => {
  socket.send({ type: 'join', ...params });
  return socket.next((message) => message.type === 'joined' || message.type === 'join_rejected');
};

test('prototype2 signaling protocol', async (t) => {
  const harness = await startServer();
  t.after(async () => {
    await harness.close();
  });

  await t.test('rejects a socket whose first message is not a join', async () => {
    const socket = await openSocket(harness.base);
    socket.send({ type: 'offer', offer: { type: 'offer', sdp: 'x' } });
    const rejection = await socket.next();
    assert.equal(rejection.type, 'join_rejected');
    assert.equal(rejection.code, 'JOIN_REQUIRED');
    socket.close();
  });

  await t.test('rejects invented credentials and invented sessions', async () => {
    const fixture = await createFixture(harness.base);
    const socket = await openSocket(harness.base);
    const rejected = await join(socket, {
      sessionId: fixture.sessionId,
      role: 'salesperson',
      credential: 'role=salesperson',
    });
    assert.equal(rejected.type, 'join_rejected');
    assert.equal(rejected.code, 'INVALID_CREDENTIAL');
    socket.close();

    const unknown = await openSocket(harness.base);
    const missing = await join(unknown, {
      sessionId: 'made-up-session',
      role: 'salesperson',
      credential: fixture.salespersonKey,
    });
    assert.equal(missing.type, 'join_rejected');
    assert.equal(missing.code, 'SESSION_NOT_FOUND');
    unknown.close();
  });

  await t.test('rejects unauthorized role switching', async () => {
    const fixture = await createFixture(harness.base);
    const socket = await openSocket(harness.base);
    const rejected = await join(socket, {
      sessionId: fixture.sessionId,
      role: 'customer',
      credential: fixture.salespersonKey,
    });
    assert.equal(rejected.type, 'join_rejected');
    assert.equal(rejected.code, 'ROLE_MISMATCH');
    socket.close();
  });

  await t.test('routes the three communication paths inside one session', async () => {
    const fixture = await createFixture(harness.base);
    const salesperson = await openSocket(harness.base);
    const customer = await openSocket(harness.base);

    const salespersonJoin = await join(salesperson, {
      sessionId: fixture.sessionId,
      role: 'salesperson',
      credential: fixture.salespersonKey,
    });
    assert.equal(salespersonJoin.type, 'joined');
    assert.equal(salespersonJoin.role, 'salesperson');

    const customerJoin = await join(customer, {
      sessionId: fixture.sessionId,
      role: 'customer',
      credential: fixture.customerKey,
    });
    assert.equal(customerJoin.type, 'joined');
    assert.equal(customerJoin.role, 'customer');

    const peerJoined = await salesperson.next((message) => message.type === 'peer_joined');
    assert.equal(peerJoined.peer.role, 'customer');

    // B. salesperson -> customer signaling (offer)
    salesperson.send({
      type: 'offer',
      sessionId: fixture.sessionId,
      offer: { type: 'offer', sdp: 'v=0 offer-sdp' },
    });
    const offer = await customer.next((message) => message.type === 'offer');
    assert.equal(offer.from, salespersonJoin.participantId);
    assert.equal(offer.fromRole, 'salesperson');
    assert.equal(offer.offer.sdp, 'v=0 offer-sdp');

    // C. customer -> salesperson signaling (answer + ICE both ways)
    customer.send({
      type: 'answer',
      sessionId: fixture.sessionId,
      answer: { type: 'answer', sdp: 'v=0 answer-sdp' },
    });
    const answer = await salesperson.next((message) => message.type === 'answer');
    assert.equal(answer.from, customerJoin.participantId);
    assert.equal(answer.answer.sdp, 'v=0 answer-sdp');

    // C2. The answerer may ask the offerer for an ICE restart (role-checked).
    customer.send({
      type: 'ice_restart',
      sessionId: fixture.sessionId,
      reason: 'network changed',
    });
    const restartRequest = await salesperson.next((message) => message.type === 'ice_restart');
    assert.equal(restartRequest.from, customerJoin.participantId);
    assert.equal(restartRequest.fromRole, 'customer');
    assert.equal(restartRequest.reason, 'network changed');

    salesperson.send({ type: 'ice_restart', sessionId: fixture.sessionId, reason: 'spoofed' });
    const restartRejection = await salesperson.next(
      (message) => message.type === 'error' && message.code === 'INVALID_SIGNALING_ROLE'
    );
    assert.equal(restartRejection.code, 'INVALID_SIGNALING_ROLE');

    customer.send({
      type: 'ice_candidate',
      sessionId: fixture.sessionId,
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0' },
    });
    const ice = await salesperson.next((message) => message.type === 'ice_candidate');
    assert.match(ice.candidate.candidate, /typ host/);

    salesperson.send({
      type: 'ice_candidate',
      sessionId: fixture.sessionId,
      candidate: { candidate: 'candidate:2 1 udp 1 127.0.0.1 5001 typ host', sdpMid: '0' },
    });
    const reverseIce = await customer.next((message) => message.type === 'ice_candidate');
    assert.match(reverseIce.candidate.candidate, /5001/);

    // A. No browser may inject AI text: the server bridge is the only sender.
    for (const sender of [customer, salesperson]) {
      sender.send({
        type: 'ai_suggestion',
        sessionId: fixture.sessionId,
        text: 'Ask about their timeline.',
        isFinal: true,
        ordinal: 3,
      });
      const rejection = await sender.next((message) => message.type === 'error');
      assert.equal(rejection.code, 'INVALID_SIGNALING_ROLE');
      assert.match(rejection.message, /delivered by the server/);
    }

    // The customer is the only answerer; it may not offer.
    customer.send({
      type: 'offer',
      sessionId: fixture.sessionId,
      offer: { type: 'offer', sdp: 'v=0 rogue' },
    });
    const offerRejection = await customer.next(
      (message) => message.type === 'error' && message.code === 'INVALID_SIGNALING_ROLE'
    );
    assert.equal(offerRejection.code, 'INVALID_SIGNALING_ROLE');

    salesperson.close();
    customer.close();
  });

  await t.test('customer never receives AI/private data and cannot be sent transcripts reserved for the salesperson', async () => {
    const fixture = await createFixture(harness.base, 'Privacy');
    const salesperson = await openSocket(harness.base);
    const customer = await openSocket(harness.base);
    const salesJoin = await join(salesperson, {
      sessionId: fixture.sessionId,
      role: 'salesperson',
      credential: fixture.salespersonKey,
    });
    const customerJoin = await join(customer, {
      sessionId: fixture.sessionId,
      role: 'customer',
      credential: fixture.customerKey,
    });
    assert.equal(customerJoin.type, 'joined');

    // Hydration: the customer's joined payload has no AI/private/diagnostic fields
    // and no other participant's credentials.
    const hydration = JSON.stringify(customerJoin);
    assert.doesNotMatch(hydration, /suggestion|diagnostics|notes|transcript|ultravox|joinUrl|salespersonKey|aiReady/i);
    assert.equal(hydration.includes(fixture.salespersonKey), false);
    assert.equal(hydration.includes(salesJoin.resumeToken), false);
    // The salesperson's own view still carries its AI readiness flag.
    assert.equal(salesJoin.session.aiReady, false);

    // The salesperson may not send customer-reserved message types.
    for (const type of ['customer_speech_transcript', 'ai_suggestion']) {
      salesperson.send({ type, sessionId: fixture.sessionId, text: 'spoofed', isFinal: true });
      const rejection = await salesperson.next((message) => message.type === 'error');
      assert.equal(rejection.code, 'INVALID_SIGNALING_ROLE');
    }

    // The customer may not inject salesperson captions.
    customer.send({ type: 'salesperson_caption', sessionId: fixture.sessionId, text: 'spoofed', isFinal: true });
    const captionRejection = await customer.next((message) => message.type === 'error');
    assert.equal(captionRejection.code, 'INVALID_SIGNALING_ROLE');

    // The customer may not inject AI output either: only the server sends it.
    for (const type of ['customer_speech_transcript', 'ai_suggestion']) {
      customer.send({ type, sessionId: fixture.sessionId, text: 'spoofed', isFinal: true });
      const rejection = await customer.next((message) => message.type === 'error');
      assert.equal(rejection.code, 'INVALID_SIGNALING_ROLE');
    }

    // Salesperson captions are relayed to the paired customer only, never echoed.
    salesperson.send({
      type: 'salesperson_caption',
      sessionId: fixture.sessionId,
      text: 'Our plan starts at $49 per seat.',
      isFinal: true,
    });
    const caption = await customer.next((message) => message.type === 'salesperson_caption');
    assert.equal(caption.text, 'Our plan starts at $49 per seat.');
    assert.equal(caption.fromRole, 'salesperson');
    await assert.rejects(
      salesperson.next((message) => message.type === 'salesperson_caption', 700),
      /Timed out/
    );

    salesperson.close();
    customer.close();
  });

  await t.test('keeps two customer sessions isolated', async () => {
    const a = await createFixture(harness.base, 'A');
    const b = await createFixture(harness.base, 'B');

    const salesA = await openSocket(harness.base);
    const customerA = await openSocket(harness.base);
    const salesB = await openSocket(harness.base);
    const customerB = await openSocket(harness.base);

    assert.equal(
      (await join(salesA, { sessionId: a.sessionId, role: 'salesperson', credential: a.salespersonKey })).type,
      'joined'
    );
    assert.equal(
      (await join(customerA, { sessionId: a.sessionId, role: 'customer', credential: a.customerKey })).type,
      'joined'
    );
    assert.equal(
      (await join(salesB, { sessionId: b.sessionId, role: 'salesperson', credential: b.salespersonKey })).type,
      'joined'
    );
    assert.equal(
      (await join(customerB, { sessionId: b.sessionId, role: 'customer', credential: b.customerKey })).type,
      'joined'
    );

    // Cross-session credential is rejected even for a valid-looking session id.
    const intruder = await openSocket(harness.base);
    const intruderJoin = await join(intruder, {
      sessionId: a.sessionId,
      role: 'customer',
      credential: b.customerKey,
    });
    assert.equal(intruderJoin.type, 'join_rejected');
    assert.equal(intruderJoin.code, 'INVALID_CREDENTIAL');

    // A message tagged with another session is rejected, not relayed.
    salesA.send({
      type: 'offer',
      sessionId: b.sessionId,
      offer: { type: 'offer', sdp: 'v=0 leak-attempt' },
    });
    const wrong = await salesA.next((message) => message.type === 'error');
    assert.equal(wrong.code, 'WRONG_SESSION');

    await assert.rejects(
      customerB.next((message) => message.type === 'offer', 700),
      /Timed out/
    );

    // Session A's server-generated AI text must not appear in session B.
    const startedA = await post(
      harness.base,
      `/api/sessions/${a.sessionId}/ai-call`,
      {},
      a.customerKey
    );
    assert.equal(startedA.status, 200);
    const upstreamA = FakeUpstream.latest();
    upstreamA.open();
    upstreamA.message({ type: 'ready' });
    upstreamA.message({ type: 'suggestion', text: 'A only', isFinal: true, ordinal: 1 });
    const suggestionA = await salesA.next((message) => message.type === 'ai_suggestion');
    assert.equal(suggestionA.text, 'A only');
    await assert.rejects(salesB.next((message) => message.type === 'ai_suggestion', 700), /Timed out/);

    for (const socket of [salesA, customerA, salesB, customerB, intruder]) socket.close();
  });

  await t.test('creating a second invitation never touches the first session', async () => {
    const first = await createFixture(harness.base, 'First');
    const before = await get(harness.base, `/api/sessions/${first.sessionId}`, first.salespersonKey);
    assert.equal(before.status, 200);

    // A salesperson creating another invitation means a brand-new session; the
    // original session, its invitation and its customer credential stay valid.
    const second = await post(harness.base, '/api/sessions', { label: 'Second' });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.sessionId, first.sessionId);
    assert.notEqual(second.body.inviteUrl, first.inviteUrl);

    const after = await get(harness.base, `/api/sessions/${first.sessionId}`, first.salespersonKey);
    assert.equal(after.status, 200);
    assert.equal(after.body.session.sessionId, first.sessionId);
    assert.equal(after.body.session.invitationStatus, before.body.session.invitationStatus);
    assert.equal(after.body.session.invitationExpiresAt, before.body.session.invitationExpiresAt);

    // The original invitation is still the same one and still redeemable state-wise.
    const socket = await openSocket(harness.base);
    const joined = await join(socket, {
      sessionId: first.sessionId,
      role: 'customer',
      credential: first.customerKey,
    });
    assert.equal(joined.type, 'joined');
    socket.close();
  });

  await t.test('reconnection reuses the participant instead of duplicating it', async () => {
    const fixture = await createFixture(harness.base);
    const first = await openSocket(harness.base);
    const joined = await join(first, {
      sessionId: fixture.sessionId,
      role: 'salesperson',
      credential: fixture.salespersonKey,
    });
    assert.equal(joined.type, 'joined');

    const resumeToken = joined.resumeToken;
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await openSocket(harness.base);
    const rejoined = await join(second, {
      sessionId: fixture.sessionId,
      role: 'salesperson',
      credential: fixture.salespersonKey,
      resumeToken,
    });
    assert.equal(rejoined.type, 'joined');
    assert.equal(rejoined.participantId, joined.participantId);

    const diagnostics = await get(harness.base, `/api/sessions/${fixture.sessionId}/diagnostics`, fixture.salespersonKey);
    assert.equal(diagnostics.status, 200);
    const salespeople = diagnostics.body.diagnostics.participants.filter(
      (participant: any) => participant.role === 'salesperson'
    );
    assert.equal(salespeople.length, 1);
    assert.equal(salespeople[0].connectionCount, 2);
    assert.equal(salespeople[0].connected, true);
    second.close();
  });

  await t.test('reports peer_left exactly once when the peer disconnects', async () => {
    const fixture = await createFixture(harness.base);
    const salesperson = await openSocket(harness.base);
    const customer = await openSocket(harness.base);
    await join(salesperson, { sessionId: fixture.sessionId, role: 'salesperson', credential: fixture.salespersonKey });
    await join(customer, { sessionId: fixture.sessionId, role: 'customer', credential: fixture.customerKey });
    await salesperson.next((message) => message.type === 'peer_joined');
    customer.close();

    const left = await salesperson.next((message) => message.type === 'peer_left');
    assert.equal(left.role, 'customer');
    await assert.rejects(salesperson.next((message) => message.type === 'peer_left', 600), /Timed out/);
    salesperson.close();
  });

  await t.test('rejects invalid JSON with a machine-readable error', async () => {
    const socket = await openSocket(harness.base);
    const raw = (socket as any);
    // Send non-JSON through the underlying socket.
    const ws = new WebSocket(`${harness.base.replace('http', 'ws')}/ws`);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    const message = new Promise<any>((resolve) => ws.on('message', (data) => resolve(JSON.parse(data.toString()))));
    ws.send('not json');
    const error = await message;
    assert.equal(error.code, 'INVALID_JSON');
    ws.close();
    socket.close();
    void raw;
  });
});

test('prototype2 HTTP authorization and invitations', async (t) => {
  const harness = await startServer();
  t.after(async () => {
    await harness.close();
  });

  await t.test('a salesperson can create a session and generate an invitation', async () => {
    const created = await post(harness.base, '/api/sessions', { label: 'Demo' });
    assert.equal(created.status, 201);
    assert.ok(created.body.sessionId);
    assert.ok(created.body.salespersonKey.length > 30);
    assert.match(created.body.inviteUrl, /^http:\/\/127\.0\.0\.1:\d+\/join\?invite=/);

    const rotated = await post(
      harness.base,
      `/api/sessions/${created.body.sessionId}/invitations`,
      {},
      created.body.salespersonKey
    );
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.inviteUrl, /\/join\?invite=/);

    const unauthorized = await post(harness.base, `/api/sessions/${created.body.sessionId}/invitations`, {});
    assert.equal(unauthorized.status, 401);
  });

  await t.test('invitation resolves to its own session and cannot be reused', async () => {
    const fixture = await createFixture(harness.base);
    const replay = await post(harness.base, '/api/invitations/redeem', { inviteToken: fixture.inviteToken });
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error, 'INVITE_REDEEMED');

    const resumed = await post(harness.base, '/api/invitations/redeem', {
      inviteToken: fixture.inviteToken,
      customerKey: fixture.customerKey,
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.sessionId, fixture.sessionId);
    assert.equal(resumed.body.resumed, true);
  });

  await t.test('rejected invitations cannot join an active session', async () => {
    const fixture = await createFixture(harness.base);
    const revoked = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/invitations/revoke`,
      {},
      fixture.salespersonKey
    );
    assert.equal(revoked.status, 200);

    const attempt = await post(harness.base, '/api/invitations/redeem', { inviteToken: fixture.inviteToken });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.error, 'INVITE_REVOKED');

    const unknown = await post(harness.base, '/api/invitations/redeem', { inviteToken: 'nope' });
    assert.equal(unknown.status, 404);
  });

  await t.test('diagnostics require the salesperson credential and never leak secrets', async () => {
    const fixture = await createFixture(harness.base);
    assert.equal((await get(harness.base, `/api/sessions/${fixture.sessionId}/diagnostics`)).status, 401);
    assert.equal(
      (await get(harness.base, `/api/sessions/${fixture.sessionId}/diagnostics`, fixture.customerKey)).status,
      401
    );

    const diagnostics = await get(
      harness.base,
      `/api/sessions/${fixture.sessionId}/diagnostics`,
      fixture.salespersonKey
    );
    assert.equal(diagnostics.status, 200);
    const serialized = JSON.stringify(diagnostics.body);
    assert.ok(!serialized.includes(fixture.salespersonKey));
    assert.ok(!serialized.includes(fixture.customerKey));
    assert.ok(!serialized.includes(fixture.inviteToken));
    assert.equal(diagnostics.body.diagnostics.storage, 'in-memory');
  });

  await t.test('AI start tickets are participant-only and never expose the upstream call', async () => {
    const fixture = await createFixture(harness.base, 'ai-ticket');
    FakeUpstream.reset();

    assert.equal(
      (await post(harness.base, `/api/sessions/${fixture.sessionId}/ai-call`, {})).status,
      403
    );

    const other = await createFixture(harness.base, 'ai-other');
    assert.equal(
      (
        await post(
          harness.base,
          `/api/sessions/${fixture.sessionId}/ai-call`,
          {},
          other.customerKey
        )
      ).status,
      403
    );

    const byCustomer = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      {},
      fixture.customerKey
    );
    assert.equal(byCustomer.status, 200);
    assert.equal(byCustomer.body.callId, 'call_test');
    assert.match(String(byCustomer.body.aiSocketUrl), /\/ws\/ai\?ticket=/);
    // The upstream join URL and the credential never reach the browser.
    assert.equal(byCustomer.body.joinUrl, undefined);
    const serialized = JSON.stringify(byCustomer.body);
    assert.doesNotMatch(serialized, /ai\.invalid/);
    assert.doesNotMatch(serialized, /token=secret/);
    assert.deepEqual(byCustomer.body.audio, {
      sampleRate: 16000,
      format: 'pcm_s16le',
      transport: 'websocket',
    });

    // The salesperson may restart the AI for their own panel; that is a control
    // action, not an audio source.
    const bySalesperson = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      { replace: true },
      fixture.salespersonKey
    );
    assert.equal(bySalesperson.status, 200);
    assert.match(String(bySalesperson.body.aiSocketUrl), /\/ws\/ai\?ticket=/);

    // A salesperson ticket can never become an AI audio source: the socket is
    // rejected before any frame is accepted.
    const salespersonAudioClose = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(bySalesperson.body.aiSocketUrl);
      socket.on('close', (code) => resolve(code));
      socket.on('error', reject);
    });
    assert.equal(salespersonAudioClose, 4403);
  });

  await t.test('health exposes no credentials', async () => {
    const health = await get(harness.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    const serialized = JSON.stringify(health.body);
    assert.ok(!serialized.toLowerCase().includes('apikey":'));
  });
});

test('prototype2 ICE/TURN delivery is session-authenticated and secret-safe', async (t) => {
  const restore: Record<string, string | undefined> = {
    TURN_URLS: process.env.TURN_URLS,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
    TURN_SECRET: process.env.TURN_SECRET,
    TURN_TTL_SECONDS: process.env.TURN_TTL_SECONDS,
    ICE_TRANSPORT_POLICY: process.env.ICE_TRANSPORT_POLICY,
    STUN_URLS: process.env.STUN_URLS,
    APP_URL: process.env.APP_URL,
    AI_SERVICE_URL: process.env.AI_SERVICE_URL,
    AI_SERVICE_TOKEN: process.env.AI_SERVICE_TOKEN,
  };

  process.env.TURN_URLS =
    'turn:turn.invalid:3478?transport=udp,turns:turn.invalid:5349?transport=tcp';
  process.env.TURN_USERNAME = 'turn-user';
  process.env.TURN_CREDENTIAL = 'turn-pass';
  delete process.env.TURN_SECRET;
  process.env.ICE_TRANSPORT_POLICY = 'all';

  const harness = await startServer();
  t.after(async () => {
    await harness.close();
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fixture = await createFixture(harness.base, 'ICE');
  const icePath = `/api/sessions/${fixture.sessionId}/ice-config`;

  await t.test('rejects anonymous and cross-session callers', async () => {
    assert.equal((await get(harness.base, icePath)).status, 401);

    const other = await createFixture(harness.base, 'Other');
    assert.equal((await get(harness.base, icePath, other.salespersonKey)).status, 401);
    assert.equal((await get(harness.base, icePath, other.customerKey)).status, 401);
    assert.equal((await get(harness.base, icePath, 'invented')).status, 401);
    assert.equal(
      (await get(harness.base, '/api/sessions/missing/ice-config', fixture.salespersonKey)).status,
      404
    );
  });

  await t.test('returns TURN URLs and static credentials to both session participants', async () => {
    for (const key of [fixture.salespersonKey, fixture.customerKey]) {
      const response = await get(harness.base, icePath, key);
      assert.equal(response.status, 200);
      assert.equal(response.body.hasTurn, true);
      assert.equal(response.body.turn.configured, true);
      assert.equal(response.body.turn.credentialMode, 'static');
      assert.equal(response.body.turn.urlCount, 2);
      assert.equal(response.body.iceTransportPolicy, 'all');

      const turnEntry = response.body.iceServers.find((entry: any) =>
        (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
      );
      assert.ok(turnEntry);
      assert.deepEqual(turnEntry.urls, [
        'turn:turn.invalid:3478?transport=udp',
        'turns:turn.invalid:5349?transport=tcp',
      ]);
      assert.equal(turnEntry.username, 'turn-user');
      assert.equal(turnEntry.credential, 'turn-pass');
    }
  });

  await t.test('never exposes TURN credentials in health or diagnostics', async () => {
    const health = await get(harness.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ice.configured, true);
    assert.equal(health.body.hasTurn, true);
    const healthJson = JSON.stringify(health.body);
    assert.ok(!healthJson.includes('turn-pass'));
    assert.ok(!healthJson.includes('turn-user'));
    assert.ok(!healthJson.includes('turn.invalid'));

    const diagnostics = await get(
      harness.base,
      `/api/sessions/${fixture.sessionId}/diagnostics`,
      fixture.salespersonKey
    );
    assert.equal(diagnostics.status, 200);
    const diagnosticsJson = JSON.stringify(diagnostics.body);
    assert.ok(!diagnosticsJson.includes('turn-pass'));
    assert.ok(!diagnosticsJson.includes('turn-user'));
    assert.ok(!diagnosticsJson.includes('turn.invalid'));
  });

  await t.test('serves short-lived coturn credentials when TURN_SECRET is set', async () => {
    const secret = 'signaling-test-secret';
    process.env.TURN_SECRET = secret;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;

    const response = await get(harness.base, icePath, fixture.customerKey);
    assert.equal(response.status, 200);
    assert.equal(response.body.turn.credentialMode, 'ephemeral');
    assert.ok(response.body.turn.expiresAt > Date.now());

    const turnEntry = response.body.iceServers.find((entry: any) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
    );
    assert.ok(turnEntry.username.endsWith(`:${fixture.sessionId}`));
    assert.ok(turnEntry.credential.length > 10);

    const json = JSON.stringify(response.body);
    assert.ok(!json.includes(secret));
    delete process.env.TURN_SECRET;
    process.env.TURN_USERNAME = 'turn-user';
    process.env.TURN_CREDENTIAL = 'turn-pass';
  });

  await t.test('relay-only mode without TURN fails instead of falling back to STUN', async () => {
    delete process.env.TURN_URLS;
    process.env.ICE_TRANSPORT_POLICY = 'relay';

    const response = await get(harness.base, icePath, fixture.customerKey);
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'TURN_MISCONFIGURED');
    assert.match(response.body.message, /relay requires a usable TURN relay/i);
    assert.equal(response.body.iceTransportPolicy, 'relay');

    const health = await get(harness.base, '/api/health');
    assert.equal(health.body.ice.hasErrors, true);
    assert.equal(health.body.ice.iceTransportPolicy, 'relay');

    process.env.TURN_URLS =
      'turn:turn.invalid:3478?transport=udp,turns:turn.invalid:5349?transport=tcp';
    process.env.ICE_TRANSPORT_POLICY = 'all';
  });

  await t.test('uses APP_URL for invitation links when configured', async () => {
    process.env.APP_URL = 'https://ultraviolet-copilot.onrender.com';
    const created = await post(harness.base, '/api/sessions', { label: 'APP_URL' });
    assert.equal(created.status, 201);
    assert.match(
      created.body.inviteUrl,
      /^https:\/\/ultraviolet-copilot\.onrender\.com\/join\?invite=/
    );
    const health = await get(harness.base, '/api/health');
    assert.equal(health.body.publicAppUrl, 'https://ultraviolet-copilot.onrender.com');
    assert.deepEqual(health.body.appUrlWarnings, []);
    delete process.env.APP_URL;
  });

  await t.test('starts and serves health without AI service config, with a clear AI error', async () => {
    delete process.env.AI_SERVICE_URL;
    delete process.env.AI_SERVICE_TOKEN;

    const health = await get(harness.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ai.ready, false);
    assert.deepEqual(health.body.ai.missing, ['AI_SERVICE_URL', 'AI_SERVICE_TOKEN']);
    assert.match(health.body.ai.message, /Human-to-human audio is unaffected/i);

    const aiCall = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      {},
      fixture.customerKey
    );
    assert.equal(aiCall.status, 503);
    assert.equal(aiCall.body.error, 'AI_SERVICE_NOT_CONFIGURED');

    process.env.AI_SERVICE_URL = 'https://ai.invalid';
    process.env.AI_SERVICE_TOKEN = 'test-ai-token';
  });
});


test('ICE configuration with missing or invalid TURN settings is structured JSON, never a 5xx', async (t) => {
  const saved = {
    TURN_URLS: process.env.TURN_URLS,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
    TURN_SECRET: process.env.TURN_SECRET,
    RSTREAM_AUTHENTICATION_TOKEN: process.env.RSTREAM_AUTHENTICATION_TOKEN,
    RSTREAM_PROJECT_ENDPOINT: process.env.RSTREAM_PROJECT_ENDPOINT,
    RSTREAM_PROJECT_ID: process.env.RSTREAM_PROJECT_ID,
    TURN_CREDENTIALS_URL: process.env.TURN_CREDENTIALS_URL,
    ICE_TRANSPORT_POLICY: process.env.ICE_TRANSPORT_POLICY,
    STUN_URLS: process.env.STUN_URLS,
  };
  for (const key of Object.keys(saved) as Array<keyof typeof saved>) delete process.env[key];
  process.env.ICE_TRANSPORT_POLICY = 'all';

  const harness = await startServer();
  t.after(async () => {
    await harness.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fixture = await createFixture(harness.base, 'ICE settings');
  const icePath = `/api/sessions/${fixture.sessionId}/ice-config`;

  await t.test('TURN URLs without authentication return an actionable 200 payload', async () => {
    process.env.TURN_URLS = 'turn:turn.invalid:3478?transport=udp';
    const response = await get(harness.base, icePath, fixture.customerKey);
    assert.equal(response.status, 200, 'a broken relay config must not break the ICE endpoint');
    assert.equal(response.body.hasTurn, false);
    assert.equal(response.body.turn.configured, false);
    assert.ok(
      response.body.errors.some((error: string) => /TURN authentication is missing/i.test(error))
    );
    // No credentials exist, and nothing secret may appear in the payload.
    const serialized = JSON.stringify(response.body);
    assert.ok(!/credential":"[^"]+/.test(serialized));
    assert.ok(!serialized.includes('turn-pass'));
  });

  await t.test('malformed TURN URLs are reported without crashing or echoing secrets', async () => {
    process.env.TURN_URLS = 'htp:/broken, turn:ok.invalid:3478?transport=udp';
    process.env.TURN_USERNAME = 'turn-user';
    process.env.TURN_CREDENTIAL = 'turn-pass';
    const response = await get(harness.base, icePath, fixture.customerKey);
    assert.equal(response.status, 200);
    // A malformed entry fails the relay closed rather than using a partial set.
    assert.equal(response.body.hasTurn, false);
    assert.equal(response.body.turn.configured, false);
    assert.ok(
      response.body.errors.some((error: string) => /invalid entry/i.test(error)),
      'the malformed entry must be reported'
    );
    // With no usable relay the credential must not be sent at all.
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes('turn-pass'));
    assert.ok(!serialized.includes('turn-user'));
  });

  await t.test('an unknown session and an unauthorized caller get JSON errors', async () => {
    const missing = await get(harness.base, '/api/sessions/missing/ice-config', fixture.customerKey);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'SESSION_NOT_FOUND');

    const unauthorized = await get(harness.base, icePath, 'not-a-credential');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'UNAUTHORIZED');
  });
});

test('TURN credential provider is fetched server-side and never exposed', async (t) => {
  const saved = {
    TURN_URLS: process.env.TURN_URLS,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
    TURN_SECRET: process.env.TURN_SECRET,
    TURN_CREDENTIALS_URL: process.env.TURN_CREDENTIALS_URL,
    TURN_CREDENTIALS_AUTH: process.env.TURN_CREDENTIALS_AUTH,
    ICE_TRANSPORT_POLICY: process.env.ICE_TRANSPORT_POLICY,
  };

  delete process.env.TURN_URLS;
  delete process.env.TURN_USERNAME;
  delete process.env.TURN_CREDENTIAL;
  delete process.env.TURN_SECRET;
  process.env.TURN_CREDENTIALS_URL = 'https://provider.invalid/turn-credentials';
  process.env.TURN_CREDENTIALS_AUTH = 'Bearer provider-secret';
  process.env.ICE_TRANSPORT_POLICY = 'all';

  let providerCalls = 0;
  let seenAuth: string | null = null;
  const turnFetch = (async (_url: string, init?: RequestInit) => {
    providerCalls += 1;
    seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    return new Response(
      JSON.stringify({
        iceServers: [
          { urls: 'turn:provider.invalid:3478', username: 'temp-user', credential: 'temp-pass' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const harness = await startServer({ turnFetch });
  t.after(async () => {
    await harness.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const fixture = await createFixture(harness.base, 'provider');
  const response = await get(
    harness.base,
    `/api/sessions/${fixture.sessionId}/ice-config`,
    fixture.customerKey
  );
  assert.equal(response.status, 200);
  assert.equal(providerCalls, 1);
  assert.equal(seenAuth, 'Bearer provider-secret', 'auth header must be sent server-side');
  assert.equal(response.body.hasTurn, true);
  assert.equal(response.body.turn.credentialMode, 'provider');

  const turnEntry = response.body.iceServers.find((entry: any) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
  );
  assert.equal(turnEntry.username, 'temp-user');
  assert.equal(turnEntry.credential, 'temp-pass');

  const health = JSON.stringify((await get(harness.base, '/api/health')).body);
  assert.ok(!health.includes('provider-secret'));
  assert.ok(!health.includes('temp-pass'));
  assert.ok(!health.includes('provider.invalid'));

  const diagnostics = JSON.stringify(
    (await get(harness.base, `/api/sessions/${fixture.sessionId}/diagnostics`, fixture.salespersonKey)).body
  );
  assert.ok(!diagnostics.includes('provider-secret'));
  assert.ok(!diagnostics.includes('temp-pass'));

  // Provider outage: relay-only must fail closed; policy "all" may continue
  // with a warning so same-network calls still work.
  const failingServer = await startServer({
    turnFetch: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
  });
  t.after(async () => {
    await failingServer.close();
  });
  const failingFixture = await createFixture(failingServer.base, 'provider-down');

  const degraded = await get(
    failingServer.base,
    `/api/sessions/${failingFixture.sessionId}/ice-config`,
    failingFixture.customerKey
  );
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.hasTurn, false);
  assert.ok(degraded.body.warnings.some((warning: string) => /HTTP 503/.test(warning)));

  process.env.ICE_TRANSPORT_POLICY = 'relay';
  const relayFailure = await get(
    failingServer.base,
    `/api/sessions/${failingFixture.sessionId}/ice-config`,
    failingFixture.customerKey
  );
  assert.equal(relayFailure.status, 503);
  assert.equal(relayFailure.body.error, 'TURN_MISCONFIGURED');
});

// ---------------------------------------------------------------------------
// Server-side AI bridge (upstream transport mocked, real HTTP/WS used)
// ---------------------------------------------------------------------------

test('prototype2 AI call rotation and lifecycle', async (t) => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let failNext = false;
  let created = 0;
  const aiServiceFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: String(input), body });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (failNext) {
      failNext = false;
      return new Response(JSON.stringify({ error: 'provider unavailable' }), { status: 503 });
    }
    created += 1;
    return new Response(
      JSON.stringify({
        callId: `call_${created}`,
        // Deliberately secret-looking: it must never reach a browser.
        joinUrl: `wss://ai.invalid/join-${created}?token=secret-${created}`,
        model: 'test-model',
        expiresAt: Date.now() + 3_600_000,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const harness = await startServer({ aiServiceFetch });
  t.after(async () => {
    await harness.close();
  });

  await t.test('replace=true creates a genuinely new call and ends the old one', async () => {
    const fixture = await createFixture(harness.base, 'rotate');
    FakeUpstream.reset();

    const first = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      {},
      fixture.customerKey
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.callId, 'call_1');
    assert.equal(first.body.isReused, false);

    // A live upstream is reused: recovery must not spawn (and pay for) a second
    // GPU call while the first is healthy.
    FakeUpstream.latest().open();
    const reused = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      {},
      fixture.customerKey
    );
    assert.equal(reused.body.isReused, true);
    assert.equal(reused.body.callId, 'call_1');
    assert.notEqual(reused.body.aiSocketUrl, first.body.aiSocketUrl, 'a fresh single-use ticket');

    const rotated = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      { replace: true },
      fixture.customerKey
    );
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.isReused, false);
    assert.equal(rotated.body.callId, 'call_2');
    assert.doesNotMatch(JSON.stringify(rotated.body), /join-2/);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(
      calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/call_1')),
      'the superseded call is terminated'
    );
  });

  await t.test('a failed creation is a clear AI error and never touches the call', async () => {
    const fixture = await createFixture(harness.base, 'retry-after-failure');
    failNext = true;
    const failed = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      {},
      fixture.customerKey
    );
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error, 'AI_SERVICE_ERROR');
    assert.match(String(failed.body.message), /HTTP 503/);

    // The session is still fully usable.
    const state = await get(
      harness.base,
      `/api/sessions/${fixture.sessionId}`,
      fixture.salespersonKey
    );
    assert.equal(state.status, 200);
    assert.equal(state.body.session.ai.state, 'error');

    const retried = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ai-call`,
      { replace: true },
      fixture.customerKey
    );
    assert.equal(retried.status, 200);
    assert.notEqual(retried.body.callId, failed.body.callId);
  });
});

test('prototype2 customer audio reaches the model and model text only the salesperson', async (t) => {
  const harness = await startServer();
  t.after(async () => {
    await harness.close();
  });

  const fixture = await createFixture(harness.base, 'bridge');
  const salesperson = await openSocket(harness.base);
  const customer = await openSocket(harness.base);
  t.after(() => {
    salesperson.close();
    customer.close();
  });
  FakeUpstream.reset();

  await join(salesperson, {
    sessionId: fixture.sessionId,
    role: 'salesperson',
    credential: fixture.salespersonKey,
  });
  await join(customer, {
    sessionId: fixture.sessionId,
    role: 'customer',
    credential: fixture.customerKey,
  });
  await salesperson.next((message) => message.type === 'peer_joined');

  const started = await post(
    harness.base,
    `/api/sessions/${fixture.sessionId}/ai-call`,
    {},
    fixture.customerKey
  );
  assert.equal(started.status, 200);

  const upstream = FakeUpstream.latest();
  upstream.open();
  upstream.message({ type: 'ready', model: 'whisper+qwen', sampleRate: 16000 });

  const audioSocket = new WebSocket(started.body.aiSocketUrl);
  const fromServer: any[] = [];
  audioSocket.on('message', (raw) => {
    try {
      fromServer.push(JSON.parse(raw.toString()));
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    audioSocket.once('open', () => resolve());
    audioSocket.once('error', reject);
  });
  audioSocket.send(
    JSON.stringify({ type: 'audio.start', protocol: 'salescopilot-ai/1', sampleRate: 16000, format: 'pcm_s16le' })
  );

  // 100 ms of PCM16 at 16 kHz.
  const frame = Buffer.alloc(3200, 7);
  audioSocket.send(frame);
  const deadline = Date.now() + 2000;
  while (upstream.audio.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(upstream.audio.length, 1, 'the customer frame is forwarded upstream');
  assert.deepEqual(upstream.audio[0], frame);

  // The ticket is single-use: a replay cannot add a second audio source.
  const replayClose = await new Promise<number>((resolve, reject) => {
    const replay = new WebSocket(started.body.aiSocketUrl);
    replay.on('close', (code) => resolve(code));
    replay.on('error', reject);
  });
  assert.equal(replayClose, 4401);

  upstream.message({ type: 'status', status: 'thinking' });
  upstream.message({ type: 'transcript', speaker: 'user', text: 'We need this live by June.', isFinal: true, ordinal: 1 });
  upstream.message({ type: 'suggestion', speaker: 'agent', text: 'What is driving the June date?', isFinal: true, ordinal: 2 });

  const speech = await salesperson.next((message) => message.type === 'customer_speech_transcript');
  assert.equal(speech.text, 'We need this live by June.');
  const suggestion = await salesperson.next((message) => message.type === 'ai_suggestion');
  assert.equal(suggestion.text, 'What is driving the June date?');

  // Duplicate model output must not flood the panel.
  upstream.message({ type: 'suggestion', text: 'What is driving the June date?', isFinal: true, ordinal: 3 });
  await assert.rejects(
    salesperson.next((message) => message.type === 'ai_suggestion', 600),
    /Timed out/
  );

  // The customer page never receives AI text, only transport status.
  await assert.rejects(
    customer.next(
      (message) => message.type === 'ai_suggestion' || message.type === 'customer_speech_transcript',
      600
    ),
    /Timed out/
  );

  const status = await salesperson.next(
    (message) => message.type === 'ai_status' && message.audioReachingAi === true
  );
  assert.equal(status.state, 'connected');
  assert.equal(status.connected, true);
  assert.equal(status.audioReachingAi, true);
  // No upstream URL or token ever reaches a browser or the dashboard.
  assert.doesNotMatch(JSON.stringify(status), /ai\.invalid|secret/);
  const clientStatuses = fromServer.filter((message) => message.type === 'status');
  assert.ok(clientStatuses.some((message) => message.status === 'listening'));
  assert.ok(!fromServer.some((message) => message.type === 'suggestion' || message.type === 'transcript'));

  // Persisted state is the bridge state, so a polling dashboard agrees.
  const sessionState = await get(
    harness.base,
    `/api/sessions/${fixture.sessionId}`,
    fixture.salespersonKey
  );
  assert.equal(sessionState.body.session.ai.state, 'connected');
  assert.equal(sessionState.body.session.ai.connected, true);
  assert.equal(sessionState.body.session.aiCallCreated, true);

  // A second audio socket supersedes the first (one active audio source).
  const firstClosed = new Promise<number>((resolve) => {
    audioSocket.once('close', (code) => resolve(code));
  });
  const secondTicket = await post(
    harness.base,
    `/api/sessions/${fixture.sessionId}/ai-call`,
    {},
    fixture.customerKey
  );
  assert.equal(secondTicket.body.isReused, true);
  const replacement = new WebSocket(secondTicket.body.aiSocketUrl);
  await new Promise<void>((resolve, reject) => {
    replacement.once('open', () => resolve());
    replacement.once('error', reject);
  });
  assert.equal(await firstClosed, 4001);
  const replacementClosed = new Promise<void>((resolve) => replacement.once('close', () => resolve()));
  replacement.close();
  await replacementClosed;

  // Closing the audio socket ends the upstream call (no idle GPU spend). A new
  // start request creates a fresh bridge whose failure is reported, not fatal.
  const restarted = await post(
    harness.base,
    `/api/sessions/${fixture.sessionId}/ai-call`,
    {},
    fixture.customerKey
  );
  assert.equal(restarted.status, 200);
  const upstream2 = FakeUpstream.latest();
  upstream2.open();
  upstream2.message({ type: 'ready' });
  upstream2.close(1006, 'network');
  const reconnecting = await salesperson.next(
    (message) => message.type === 'ai_status' && message.state === 'reconnecting'
  );
  assert.match(String(reconnecting.error), /closed|network/i);

  // Signaling still works while the AI recovers.
  salesperson.send({
    type: 'offer',
    sessionId: fixture.sessionId,
    offer: { type: 'offer', sdp: 'v=0 still-alive' },
  });
  const offer = await customer.next((message) => message.type === 'offer');
  assert.equal(offer.offer.sdp, 'v=0 still-alive');

  salesperson.close();
  customer.close();
});

