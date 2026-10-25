import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createPrototype2Server } from '../server';

// Injected server-side key; the browser never sees it.
process.env.ULTRAVOX_API_KEY = 'test-ultravox-key';

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const startServer = async (
  options: { turnFetch?: typeof fetch; ultravoxFetch?: typeof fetch } = {}
): Promise<Harness> => {
  const instance = await createPrototype2Server({
    serveFrontend: false,
    port: 0,
    ultravoxFetch:
      options.ultravoxFetch ??
      ((async () =>
        new Response(JSON.stringify({ callId: 'call_test', joinUrl: 'wss://ai.invalid/join' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch),
    turnFetch: options.turnFetch,
  });
  return { base: `http://127.0.0.1:${instance.port}`, close: instance.close };
};

const post = async (base: string, path: string, body: unknown, key?: string) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

    // A. customer AI text -> salesperson only
    customer.send({
      type: 'ai_suggestion',
      sessionId: fixture.sessionId,
      text: 'Ask about their timeline.',
      isFinal: true,
      ordinal: 3,
      timestamp: '10:00',
    });
    const suggestion = await salesperson.next((message) => message.type === 'ai_suggestion');
    assert.equal(suggestion.text, 'Ask about their timeline.');
    assert.equal(suggestion.from, customerJoin.participantId);

    // Salesperson may not inject AI suggestions.
    salesperson.send({ type: 'ai_suggestion', sessionId: fixture.sessionId, text: 'fake' });
    const rejection = await salesperson.next((message) => message.type === 'error');
    assert.equal(rejection.code, 'INVALID_SIGNALING_ROLE');

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

    // Session A's AI text must not appear in session B.
    customerA.send({ type: 'ai_suggestion', sessionId: a.sessionId, text: 'A only' });
    const suggestionA = await salesA.next((message) => message.type === 'ai_suggestion');
    assert.equal(suggestionA.text, 'A only');
    await assert.rejects(salesB.next((message) => message.type === 'ai_suggestion', 700), /Timed out/);

    for (const socket of [salesA, customerA, salesB, customerB, intruder]) socket.close();
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

  await t.test('only the authorized customer may start the AI call', async () => {
    const fixture = await createFixture(harness.base);
    const bySalesperson = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.salespersonKey
    );
    assert.equal(bySalesperson.status, 403);

    const unauthenticated = await post(harness.base, `/api/sessions/${fixture.sessionId}/ultravox-call`, {});
    assert.equal(unauthenticated.status, 403);

    const byCustomer = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.customerKey
    );
    assert.equal(byCustomer.status, 200);
    assert.equal(byCustomer.body.joinUrl, 'wss://ai.invalid/join');

    const reused = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.customerKey
    );
    assert.equal(reused.status, 200);
    assert.equal(reused.body.isReused, true);
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
    ULTRAVOX_API_KEY: process.env.ULTRAVOX_API_KEY,
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

  await t.test('starts and serves health without an AI key, with a clear AI error', async () => {
    delete process.env.ULTRAVOX_API_KEY;

    const health = await get(harness.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ai.ready, false);
    assert.deepEqual(health.body.ai.missing, ['ULTRAVOX_API_KEY']);
    assert.match(health.body.ai.message, /Human-to-human audio is unaffected/i);

    const aiCall = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.customerKey
    );
    assert.equal(aiCall.status, 503);
    assert.equal(aiCall.body.error, 'MISSING_API_KEY');

    process.env.ULTRAVOX_API_KEY = 'test-ultravox-key';
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
// Ultravox call lifecycle (server-side; the provider HTTP call is mocked)
// ---------------------------------------------------------------------------

test('prototype2 AI call rotation and status relay', async (t) => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let failNext = false;
  const ultravoxFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: String(input), body });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (failNext) {
      failNext = false;
      return new Response(JSON.stringify({ error: 'provider unavailable' }), { status: 503 });
    }
    const created = calls.filter((call) => call.method === 'POST').length;
    return new Response(
      JSON.stringify({
        callId: `call_${created}`,
        // Deliberately secret-looking: it must never reach the salesperson.
        joinUrl: `wss://ai.invalid/join-${created}?token=secret-${created}`,
        model: 'ultravox-v0.7',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const harness = await startServer({ ultravoxFetch });
  t.after(async () => {
    await harness.close();
  });

  await t.test('replace=true creates a genuinely new call and ends the old one', async () => {
    const fixture = await createFixture(harness.base, 'rotate');
    const first = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.customerKey
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.callId, 'call_1');
    assert.equal(first.body.isReused, false);

    const reused = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.customerKey
    );
    assert.equal(reused.body.isReused, true);
    assert.equal(reused.body.callId, 'call_1');

    // This is what the client sends for every recovery attempt.
    const rotated = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      { replace: true },
      fixture.customerKey
    );
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.isReused, false);
    assert.equal(rotated.body.callId, 'call_2');
    assert.match(rotated.body.joinUrl, /join-2/);

    // Best-effort provider cleanup for the superseded call.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(
      calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/call_1')),
      'the superseded call is terminated'
    );
  });

  await t.test('a failed creation clears the cached record so retry cannot reuse a dead URL', async () => {
    const fixture = await createFixture(harness.base, 'retry-after-failure');
    failNext = true;
    const failed = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      {},
      fixture.customerKey
    );
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error, 'ULTRAVOX_API_ERROR');

    const retried = await post(
      harness.base,
      `/api/sessions/${fixture.sessionId}/ultravox-call`,
      { replace: true },
      fixture.customerKey
    );
    assert.equal(retried.status, 200);
    assert.equal(retried.body.isReused, false);
    assert.notEqual(retried.body.callId, failed.body.callId);
  });
});


test('prototype2 AI status reaches the salesperson and never leaks connection secrets', async (t) => {
  const harness = await startServer();
  t.after(async () => {
    await harness.close();
  });

  const fixture = await createFixture(harness.base, 'ai-status');
  const salesperson = await openSocket(harness.base);
  const customer = await openSocket(harness.base);
  t.after(() => {
    salesperson.close();
    customer.close();
  });

  const salesJoin = await join(salesperson, {
    sessionId: fixture.sessionId,
    role: 'salesperson',
    credential: fixture.salespersonKey,
  });
  assert.equal(salesJoin.type, 'joined');
  assert.equal(salesJoin.ai?.state ?? null, null, 'no AI state before the customer reports one');

  const customerJoin = await join(customer, {
    sessionId: fixture.sessionId,
    role: 'customer',
    credential: fixture.customerKey,
  });
  assert.equal(customerJoin.type, 'joined');
  await salesperson.next((message) => message.type === 'peer_joined');

  // A connected report with a message that embeds a join URL and a token.
  const now = Date.now();
  customer.send({
    type: 'ai_status',
    sessionId: fixture.sessionId,
    state: 'connected',
    connected: true,
    audioReachingAi: true,
    reconnectAttempt: 0,
    lastSuggestionAt: now,
    lastResponseAt: now,
    error:
      'Session socket closed abnormally. code=1006 reason=see wss://api.ultravox.ai/join?token=super-secret',
  });

  const relayed = await salesperson.next((message) => message.type === 'ai_status');
  assert.equal(relayed.state, 'connected');
  assert.equal(relayed.connected, true);
  assert.equal(relayed.audioReachingAi, true);
  assert.equal(relayed.lastSuggestionAt, now);
  assert.doesNotMatch(JSON.stringify(relayed), /super-secret/);
  assert.doesNotMatch(JSON.stringify(relayed), /wss:\/\//);
  assert.match(relayed.error, /code=1006/);
  assert.match(relayed.error, /\[url redacted\]/);

  // Server-persisted copy is available to the salesperson without the relay.
  const sessionResponse = await get(
    harness.base,
    `/api/sessions/${fixture.sessionId}`,
    fixture.salespersonKey
  );
  assert.equal(sessionResponse.body.session.ai.state, 'connected');
  assert.equal(sessionResponse.body.session.ai.connected, true);
  assert.equal(sessionResponse.body.session.ai.audioReachingAi, true);
  assert.equal(sessionResponse.body.session.aiCallCreated, false, 'no Ultravox call exists in this test');
  assert.equal(sessionResponse.body.session.aiReady, false);

  const diagnostics = await get(
    harness.base,
    `/api/sessions/${fixture.sessionId}/diagnostics`,
    fixture.salespersonKey
  );
  assert.equal(diagnostics.body.diagnostics.ai.connected, true);
  assert.equal(diagnostics.body.diagnostics.ai.state, 'connected');
  assert.equal(diagnostics.body.diagnostics.aiCallId, null);
  assert.ok(!JSON.stringify(diagnostics.body).includes('super-secret'));

  // A "connected" claim whose state is not connected is refused.
  customer.send({
    type: 'ai_status',
    sessionId: fixture.sessionId,
    state: 'closed',
    connected: true,
  });
  const closed = await salesperson.next(
    (message) => message.type === 'ai_status' && message.state === 'closed'
  );
  assert.equal(closed.connected, false, 'connected must match the reported state');

  // Unknown states are rejected with a machine-readable code.
  customer.send({ type: 'ai_status', sessionId: fixture.sessionId, state: 'teleported' });
  const invalid = await customer.next(
    (message) => message.type === 'error' && message.code === 'INVALID_SIGNALING_PAYLOAD'
  );
  assert.match(invalid.message, /AI state/);

  // Role enforcement: only the customer reports, only the salesperson requests.
  salesperson.send({ type: 'ai_status', sessionId: fixture.sessionId, state: 'connected', connected: true });
  const wrongReporter = await salesperson.next(
    (message) => message.type === 'error' && message.code === 'INVALID_SIGNALING_ROLE'
  );
  assert.match(wrongReporter.message, /Only the customer/);

  customer.send({ type: 'ai_reconnect', sessionId: fixture.sessionId });
  const wrongRequester = await customer.next(
    (message) => message.type === 'error' && message.code === 'INVALID_SIGNALING_ROLE'
  );
  assert.match(wrongRequester.message, /Only the salesperson/);

  salesperson.send({ type: 'ai_reconnect', sessionId: fixture.sessionId, reason: 'dashboard button' });
  const request = await customer.next((message) => message.type === 'ai_reconnect');
  assert.equal(request.reason, 'dashboard button');

  // A reconnecting salesperson dashboard receives the last known state on join.
  salesperson.close();
  const salesperson2 = await openSocket(harness.base);
  t.after(() => salesperson2.close());
  const rejoin = await join(salesperson2, {
    sessionId: fixture.sessionId,
    role: 'salesperson',
    credential: fixture.salespersonKey,
  });
  assert.equal(rejoin.type, 'joined');
  assert.equal(rejoin.ai.state, 'closed');
  assert.equal(rejoin.ai.connected, false);

  // When the customer device disconnects, persisted AI state must stop
  // claiming a live session (it existed only on that device).
  customer.close();
  const started = Date.now();
  let lastAi: any = null;
  while (Date.now() - started < 2000) {
    const response = await get(harness.base, `/api/sessions/${fixture.sessionId}`, fixture.salespersonKey);
    lastAi = response.body.session.ai;
    if (lastAi.connected === false && lastAi.state === 'disconnected') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(lastAi.connected, false);
  assert.equal(lastAi.state, 'disconnected');
  assert.match(String(lastAi.error), /customer device disconnected/i);

  // A brand new invitation/session starts with no AI state carried over.
  const freshFixture = await createFixture(harness.base, 'fresh');
  const fresh = await get(harness.base, `/api/sessions/${freshFixture.sessionId}`, freshFixture.salespersonKey);
  assert.equal(fresh.body.session.ai.state, null);
  assert.equal(fresh.body.session.ai.connected, false);
});

