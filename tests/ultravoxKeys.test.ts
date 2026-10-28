/**
 * Ultravox multi-key configuration, failure classification and bounded
 * failover.
 *
 * All provider responses are mocked; no production quota is consumed. Tests
 * use a fake clock for cooldown behaviour so they are deterministic. They prove
 * the server's routing/retry decisions, not real Ultravox client behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createPrototype2Server } from '../server';
import {
  classifyUltravoxFailure,
  createUltravoxKeyPool,
  parseResetFromBody,
  parseRetryAfterMs,
  parseUltravoxApiKeys,
  resolveUltravoxKeyConfig,
  UltravoxKeyPool,
} from '../server/ultravoxKeys';

const SECRET_A = 'ultravox-key-alpha-0123456789abcdef';
const SECRET_B = 'ultravox-key-bravo-fedcba9876543210';
const SECRET_C = 'ultravox-key-charlie-aaaabbbbccccdddd';

const okPayload = (n: number) =>
  JSON.stringify({ callId: `call_${n}`, joinUrl: `wss://ai.invalid/join-${n}`, model: 'ultravox-v0.7' });

const okResponse = (n: number) =>
  new Response(okPayload(n), { status: 200, headers: { 'Content-Type': 'application/json' } });

const errorResponse = (
  status: number,
  body: unknown = { error: 'provider error' },
  headers: Record<string, string> = {}
) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const post = async (base: string, path: string, body: unknown, credential?: string) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const get = async (base: string, path: string, credential?: string) => {
  const response = await fetch(`${base}${path}`, {
    headers: credential ? { Authorization: `Bearer ${credential}` } : {},
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const createSession = async (base: string, label: string) => {
  const created = await post(base, '/api/sessions', { label });
  assert.equal(created.status, 201);
  const inviteToken = decodeURIComponent(String(created.body.inviteUrl).split('invite=')[1]);
  const redeemed = await post(base, '/api/invitations/redeem', { inviteToken });
  assert.equal(redeemed.status, 200);
  return {
    sessionId: String(created.body.sessionId),
    customerKey: String(redeemed.body.customerKey),
    salespersonKey: String(created.body.salespersonKey),
  };
};

const makePool = (
  entries: Array<{ id: string; key: string }>,
  options: { clock?: () => number; maxAttempts?: number } = {}
) =>
  new UltravoxKeyPool({
    env: { ULTRAVOX_API_KEYS: JSON.stringify(entries) },
    ...options,
  });

test('single-key backward compatibility: legacy ULTRAVOX_API_KEY still works', () => {
  const config = resolveUltravoxKeyConfig({ ULTRAVOX_API_KEY: SECRET_A });
  assert.equal(config.source, 'legacy');
  assert.deepEqual(config.entries, [{ id: 'default', key: SECRET_A }]);
  assert.deepEqual(config.errors, []);

  const pool = createUltravoxKeyPool({ ULTRAVOX_API_KEY: SECRET_A });
  assert.equal(pool.configuredCount, 1);
  assert.equal(pool.attemptBudget(), 1);
  assert.equal(pool.select()?.id, 'default');
  assert.equal(pool.select()?.key, SECRET_A);

  // Placeholder values from .env.example must not be selected as real keys.
  const placeholder = resolveUltravoxKeyConfig({ ULTRAVOX_API_KEY: 'MY_ULTRAVOX_API_KEY' });
  assert.equal(placeholder.entries.length, 0);
  assert.equal(createUltravoxKeyPool({ ULTRAVOX_API_KEY: 'MY_ULTRAVOX_API_KEY' }).hasKeys(), false);
});

test('multiple-key configuration is parsed, trimmed and validated without exposing keys', () => {
  const parsed = parseUltravoxApiKeys(
    JSON.stringify([
      { id: 'primary', key: ` ${SECRET_A} ` },
      { id: 'backup', key: SECRET_B },
      { id: 'primary', key: SECRET_C },
      { id: 'empty', key: '   ' },
      { id: 'placeholder', key: 'CHANGEME' },
      { id: 'not valid id', key: SECRET_C },
    ])
  );
  assert.deepEqual(parsed.entries, [
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  assert.ok(parsed.errors.some((error) => /repeats id "primary"/.test(error)));
  assert.ok(parsed.errors.some((error) => /empty, a placeholder/.test(error)));
  assert.ok(parsed.errors.some((error) => /invalid id/.test(error)));
  assert.equal(JSON.stringify(parsed.errors).includes(SECRET_A), false);

  // Convenience list form, including comments and ordinal ids.
  const list = parseUltravoxApiKeys(
    `# primary\nprimary=${SECRET_A}\n${SECRET_B}\n`
  );
  assert.deepEqual(list.entries, [
    { id: 'primary', key: SECRET_A },
    { id: 'key-2', key: SECRET_B },
  ]);

  // Duplicate key material is rejected even under another id.
  const duplicate = parseUltravoxApiKeys(
    JSON.stringify([
      { id: 'one', key: SECRET_A },
      { id: 'two', key: SECRET_A },
    ])
  );
  assert.equal(duplicate.entries.length, 1);
  assert.match(duplicate.errors[0], /repeats an earlier key/);

  // Multi-key config takes precedence; legacy is a safe fallback only when the
  // multi-key value yields no usable key.
  const both = resolveUltravoxKeyConfig({
    ULTRAVOX_API_KEYS: JSON.stringify([{ id: 'primary', key: SECRET_A }]),
    ULTRAVOX_API_KEY: SECRET_B,
  });
  assert.equal(both.source, 'multi');
  assert.equal(both.warnings.length, 1);
  const fallback = resolveUltravoxKeyConfig({
    ULTRAVOX_API_KEYS: '[{"id":"primary",}]',
    ULTRAVOX_API_KEY: SECRET_B,
  });
  assert.equal(fallback.source, 'legacy');
  assert.equal(fallback.entries[0].key, SECRET_B);
  assert.ok(fallback.warnings.some((warning) => /falling back/.test(warning)));
});

test('quota exhaustion is classified separately from a rate limit and rotates', () => {
  const now = 1_700_000_000_000;
  const quota = classifyUltravoxFailure(
    {
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
      body: '{"error":"quota exceeded"}',
      idempotent: false,
    },
    { now }
  );
  assert.equal(quota.category, 'quota_exhausted');
  assert.equal(quota.action, 'rotate');
  assert.equal(quota.retryAfterMs, 30_000);

  const payment = classifyUltravoxFailure(
    { status: 402, body: 'payment required', idempotent: false },
    { now }
  );
  assert.equal(payment.category, 'quota_exhausted');
  assert.equal(payment.action, 'rotate');

  const rate = classifyUltravoxFailure(
    { status: 429, body: 'rate limit exceeded', idempotent: false },
    { now }
  );
  assert.equal(rate.category, 'rate_limited');
  assert.equal(rate.action, 'rotate');

  // Documented account/plan concurrency: do not rotate keys; honour the wait.
  const concurrency = classifyUltravoxFailure(
    { status: 429, body: 'account concurrency limit exceeded', idempotent: false },
    { now }
  );
  assert.equal(concurrency.category, 'rate_limited');
  assert.equal(concurrency.action, 'wait');
  assert.equal(concurrency.accountScoped, true);
});

test('Retry-After and reset hints are parsed from both headers and safe body fields', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': '12' }), now), 12_000);
  assert.equal(
    parseRetryAfterMs(new Headers({ 'retry-after': 'Wed, 28 Oct 2026 12:00:30 GMT' }), now),
    30_000
  );
  assert.equal(parseRetryAfterMs(new Headers(), now), null);
  assert.equal(
    parseResetFromBody(JSON.stringify({ retry_after_seconds: 45 }), now),
    now + 45_000
  );
  assert.equal(
    parseResetFromBody(JSON.stringify({ error: { reset_at: '2026-10-28T12:05:00Z' } }), now),
    now + 300_000
  );
  assert.equal(parseResetFromBody('not json', now), null);
});

test('authentication and permission errors fail without cycling through the pool', async (t) => {
  for (const [status, expectedError] of [
    [401, 'ULTRAVOX_AUTH_FAILED'],
    [403, 'ULTRAVOX_PERMISSION_DENIED'],
  ] as const) {
    let attempts = 0;
    const keys = makePool([
      { id: 'primary', key: SECRET_A },
      { id: 'backup', key: SECRET_B },
    ]);
    const server = await createPrototype2Server({
      port: 0,
      serveFrontend: false,
      ultravoxKeyPool: keys,
      ultravoxFetch: (async () => {
        attempts += 1;
        return errorResponse(status, { error: 'insufficient authorization' });
      }) as unknown as typeof fetch,
    });
    t.after(async () => server.close());
    const base = `http://127.0.0.1:${server.port}`;
    const session = await createSession(base, `auth-${status}`);
    const result = await post(
      base,
      `/api/sessions/${session.sessionId}/ultravox-call`,
      { replace: true },
      session.customerKey
    );
    assert.equal(attempts, 1, `HTTP ${status} must not try every key`);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, expectedError);
    assert.equal(keys.diagnostics().keys[1].health, 'eligible', 'the healthy key is untouched');
  }
});


test('invalid requests and unknown errors never retry and never mark a key exhausted', async (t) => {
  for (const [status, expected] of [
    [400, 'ULTRAVOX_INVALID_REQUEST'],
    [302, 'ULTRAVOX_API_ERROR'],
  ] as const) {
    let attempts = 0;
    const keys = makePool([
      { id: 'primary', key: SECRET_A },
      { id: 'backup', key: SECRET_B },
    ]);
    const server = await createPrototype2Server({
      port: 0,
      serveFrontend: false,
      ultravoxKeyPool: keys,
      ultravoxFetch: (async () => {
        attempts += 1;
        return new Response(status === 302 ? null : 'bad request', { status });
      }) as unknown as typeof fetch,
    });
    t.after(async () => server.close());
    const base = `http://127.0.0.1:${server.port}`;
    const session = await createSession(base, `invalid-${status}`);
    const result = await post(
      base,
      `/api/sessions/${session.sessionId}/ultravox-call`,
      { replace: true },
      session.customerKey
    );
    assert.equal(attempts, 1);
    assert.equal(result.body.error, expected);
    assert.equal(keys.diagnostics().keys[0].health, 'eligible');
    assert.equal(keys.diagnostics().keys[0].lastErrorCategory, null);
  }
});

test('transient failures are not quota exhaustion and non-idempotent creates are not retried', async (t) => {
  const network = classifyUltravoxFailure(
    { status: 0, networkError: true, idempotent: false },
    { now: 0 }
  );
  assert.equal(network.category, 'transient');
  assert.equal(network.action, 'fail');
  assert.equal(network.ambiguous, true);

  const idempotent = classifyUltravoxFailure(
    { status: 503, idempotent: true, headers: new Headers({ 'retry-after': '2' }) },
    { now: 0 }
  );
  assert.equal(idempotent.action, 'retry_same_key');
  assert.equal(idempotent.retryAfterMs, 2_000);

  let attempts = 0;
  const keys = makePool([
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async () => {
      attempts += 1;
      return errorResponse(503);
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const session = await createSession(base, 'transient');
  const result = await post(
    base,
    `/api/sessions/${session.sessionId}/ultravox-call`,
    { replace: true },
    session.customerKey
  );
  assert.equal(attempts, 1, 'a POST with an ambiguous outcome is never repeated');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'ULTRAVOX_API_ERROR');
  assert.equal(keys.diagnostics().keys[0].health, 'eligible', '5xx does not exhaust a key');

  // Same for a network failure: exactly one attempt and an explicit ambiguity.
  const networkKeys = makePool([{ id: 'primary', key: SECRET_A }]);
  let networkAttempts = 0;
  const networkServer = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: networkKeys,
    ultravoxFetch: (async () => {
      networkAttempts += 1;
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  t.after(async () => networkServer.close());
  const networkBase = `http://127.0.0.1:${networkServer.port}`;
  const networkSession = await createSession(networkBase, 'network');
  const networkResult = await post(
    networkBase,
    `/api/sessions/${networkSession.sessionId}/ultravox-call`,
    { replace: true },
    networkSession.customerKey
  );
  assert.equal(networkAttempts, 1);
  assert.equal(networkResult.status, 502);
  assert.equal(networkResult.body.error, 'ULTRAVOX_UNREACHABLE');
  assert.equal(networkResult.body.ambiguous, true);
  assert.equal(networkKeys.diagnostics().keys[0].health, 'eligible');
});


test('quota exhaustion fails over to the next key and records non-secret diagnostics', async (t) => {
  const usedKeys: string[] = [];
  const responses = [
    () => errorResponse(429, { error: 'quota exceeded for this key' }),
    () => okResponse(2),
  ];
  const keys = makePool([
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      usedKeys.push(String((init?.headers as Record<string, string>)['X-API-Key']));
      return responses.shift()?.() ?? okResponse(99);
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'quota-failover');

  const result = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.callId, 'call_2');
  assert.deepEqual(usedKeys, [SECRET_A, SECRET_B], 'failover used the second configured key');

  const diagnostics = keys.diagnostics();
  assert.equal(diagnostics.configuredCount, 2);
  assert.equal(diagnostics.lastOperation?.succeeded, true);
  assert.equal(diagnostics.lastOperation?.failover, true);
  assert.equal(diagnostics.lastOperation?.selectedKeyId, 'backup');
  assert.equal(diagnostics.keys[0].health, 'quota_exhausted');
  assert.equal(diagnostics.keys[0].lastErrorCategory, 'quota_exhausted');
  assert.equal(diagnostics.keys[1].health, 'eligible');

  // Operator diagnostics are available to the salesperson only.
  const operator = await get(
    base,
    `/api/sessions/${fixture.sessionId}/diagnostics`,
    fixture.salespersonKey
  );
  assert.equal(operator.status, 200);
  assert.equal(operator.body.ultravoxKeys.configuredCount, 2);
  const serialized = JSON.stringify(operator.body);
  assert.equal(serialized.includes(SECRET_A), false);
  assert.equal(serialized.includes(SECRET_B), false);
  assert.match(serialized, /quota_exhausted/);
});

test('rate limits honour Retry-After, rotate within bounds and cool down the key', async (t) => {
  let clock = 1_800_000_000_000;
  const usedKeys: string[] = [];
  const responses = [
    () => errorResponse(429, { error: 'rate limit' }, { 'Retry-After': '45' }),
    () => okResponse(1),
  ];
  const keys = makePool(
    [
      { id: 'primary', key: SECRET_A },
      { id: 'backup', key: SECRET_B },
    ],
    { clock: () => clock }
  );
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      usedKeys.push(String((init?.headers as Record<string, string>)['X-API-Key']));
      return responses.shift()?.() ?? okResponse(9);
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'rate-failover');
  const result = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(result.status, 200);
  assert.deepEqual(usedKeys, [SECRET_A, SECRET_B]);

  const cooling = keys.diagnostics().keys[0];
  assert.equal(cooling.health, 'cooling_down');
  assert.equal(cooling.availableInSeconds, 45, 'Retry-After is honoured');
  assert.equal(keys.diagnostics().keys[1].health, 'eligible');

  // Once Retry-After elapses the key is eligible again.
  clock += 45_000;
  assert.equal(keys.select()?.id, 'primary');
});


test('account-wide concurrency 429 waits instead of rotating keys', async (t) => {
  let attempts = 0;
  const keys = makePool([
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async () => {
      attempts += 1;
      return errorResponse(
        429,
        { error: 'account concurrency limit exceeded' },
        { 'Retry-After': '10' }
      );
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'concurrency');
  const result = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(attempts, 1, 'an account-wide limit is not fixed by another key');
  assert.equal(result.status, 429);
  assert.equal(result.body.error, 'ULTRAVOX_RATE_LIMITED');
  assert.equal(result.body.retryAfterSeconds, 10);
  assert.equal(keys.diagnostics().keys[1].health, 'eligible');
});

test('every logical operation has a finite attempt budget', async (t) => {
  let attempts = 0;
  const keys = makePool(
    [
      { id: 'k1', key: SECRET_A },
      { id: 'k2', key: SECRET_B },
      { id: 'k3', key: SECRET_C },
      { id: 'k4', key: 'ultravox-key-delta-1111222233334444' },
      { id: 'k5', key: 'ultravox-key-echo-5555666677778888' },
    ],
    { maxAttempts: 2 }
  );
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async () => {
      attempts += 1;
      return errorResponse(429, { error: 'quota exceeded' });
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'bounded');
  const result = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(attempts, 2, 'attempts are capped by ULTRAVOX_MAX_KEY_ATTEMPTS');
  assert.equal(result.status, 429);
  assert.equal(result.body.error, 'ULTRAVOX_QUOTA_EXHAUSTED');
  assert.equal(keys.diagnostics().lastOperation?.attempts, 2);
  assert.equal(keys.diagnostics().keys.filter((key) => key.health !== 'eligible').length, 2);

  // A subsequent call also stops at the budget and does not rotate through the
  // remaining keys in a loop.
  attempts = 0;
  const second = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(attempts, 2);
  assert.equal(second.status, 429);
});


test('concurrent failures only extend cooldowns and never corrupt eligibility state', () => {
  let clock = 2_000_000_000_000;
  const keys = makePool(
    [
      { id: 'primary', key: SECRET_A },
      { id: 'backup', key: SECRET_B },
    ],
    { clock: () => clock }
  );

  keys.markRateLimited('primary', 60_000, 'first-429');
  keys.markRateLimited('primary', 5_000, 'second-429'); // a shorter concurrent report
  let primary = keys.diagnostics().keys[0];
  assert.equal(primary.health, 'cooling_down');
  assert.equal(primary.availableInSeconds, 60, 'a later shorter report cannot shorten the cooldown');
  assert.equal(primary.rateLimitStrikes, 2);

  // A quota report is stronger evidence and extends the same key.
  keys.markQuotaExhausted('primary', clock + 120_000, 'quota');
  primary = keys.diagnostics().keys[0];
  assert.equal(primary.health, 'quota_exhausted');
  assert.equal(primary.availableInSeconds, 120);

  // A subsequent rate report cannot downgrade the quota state or shorten it.
  keys.markRateLimited('primary', 1_000, 'later-429');
  primary = keys.diagnostics().keys[0];
  assert.equal(primary.health, 'quota_exhausted');
  assert.equal(primary.availableInSeconds, 120);

  // The healthy key was unaffected by all of the above.
  assert.equal(keys.diagnostics().keys[1].health, 'eligible');
  assert.equal(keys.select()?.id, 'backup');
});

test('expired cooldowns are reconsidered safely for rate, quota and auth states', () => {
  let clock = 3_000_000_000_000;
  const keys = makePool([{ id: 'primary', key: SECRET_A }], { clock: () => clock });
  assert.equal(keys.select()?.id, 'primary');

  keys.markRateLimited('primary', 30_000);
  assert.equal(keys.select(), null);
  assert.equal(keys.secondsUntilNextEligible(), 30);
  clock += 30_000;
  assert.equal(keys.select()?.id, 'primary');
  assert.equal(keys.diagnostics().keys[0].rateLimitStrikes, 0, 'strikes reset after expiry');

  keys.markQuotaExhausted('primary', clock + 60_000);
  assert.equal(keys.select(), null);
  clock += 60_000;
  assert.equal(keys.select()?.id, 'primary');
  assert.equal(keys.diagnostics().keys[0].health, 'eligible');

  keys.markAuthenticationFailed('primary');
  assert.equal(keys.diagnostics().keys[0].health, 'authentication_failed');
  assert.equal(keys.select(), null);
  clock += 5 * 60_000;
  assert.equal(keys.select()?.id, 'primary');
});

test('no key is selected from an empty configuration and all-key exhaustion is explicit', async (t) => {
  const empty = createUltravoxKeyPool({
    ULTRAVOX_API_KEYS: JSON.stringify([{ id: 'bad id', key: SECRET_A }]),
  });
  assert.equal(empty.hasKeys(), false);
  assert.equal(empty.select(), null);
  assert.ok(empty.configErrors.length > 0);

  let attempts = 0;
  const keys = makePool([
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  keys.markQuotaExhausted('primary', Date.now() + 60_000);
  keys.markQuotaExhausted('backup', Date.now() + 60_000);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async () => {
      attempts += 1;
      return okResponse(1);
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'all-exhausted');
  const result = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(attempts, 0, 'no provider call is attempted while every key is exhausted');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'ULTRAVOX_KEYS_EXHAUSTED');
  assert.ok(result.body.retryAfterSeconds >= 1);
  assert.equal(keys.diagnostics().lastOperation?.allKeysExhausted, true);
});


test('no raw key appears in logs, client responses, health or diagnostics', async (t) => {
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  t.after(() => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  });

  const keys = makePool([
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async () =>
      errorResponse(401, {
        error: `invalid api key ${SECRET_A}`,
        authorization: `X-API-Key ${SECRET_B}`,
      })) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'secrecy');

  const call = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  const health = await get(base, '/api/health');
  const diagnostics = await get(
    base,
    `/api/sessions/${fixture.sessionId}/diagnostics`,
    fixture.salespersonKey
  );

  for (const payload of [call.body, health.body, diagnostics.body]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(SECRET_A), false);
    assert.equal(serialized.includes(SECRET_B), false);
  }
  const allLogs = logs.join('\n');
  assert.equal(allLogs.includes(SECRET_A), false);
  assert.equal(allLogs.includes(SECRET_B), false);
  assert.match(allLogs, /category=authentication/, 'the safe classification is logged');
  assert.equal(call.body.error, 'ULTRAVOX_AUTH_FAILED');
  assert.equal('details' in call.body, false, 'provider payloads are not returned');
});

test('an existing live call is reused without switching its key or session identity', async (t) => {
  let providerCalls = 0;
  const usedKeys: string[] = [];
  const keys = makePool([
    { id: 'primary', key: SECRET_A },
    { id: 'backup', key: SECRET_B },
  ]);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      providerCalls += 1;
      usedKeys.push(String((init?.headers as Record<string, string>)['X-API-Key']));
      return okResponse(providerCalls);
    }) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'cached-call');

  const first = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.callId, 'call_1');

  // The key becomes unavailable, but an existing live call must keep working.
  keys.markQuotaExhausted('primary', Date.now() + 60_000);
  const reused = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    {},
    fixture.customerKey
  );
  assert.equal(reused.status, 200);
  assert.equal(reused.body.isReused, true);
  assert.equal(reused.body.callId, 'call_1');
  assert.equal(reused.body.joinUrl, first.body.joinUrl);
  assert.equal(providerCalls, 1, 'reuse never contacts the provider');

  // An explicit replacement is the only path that selects another key.
  const replaced = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.callId, 'call_2');
  assert.deepEqual(usedKeys, [SECRET_A, SECRET_B]);
});


test('an AI-call failure leaves session signaling healthy for both participants', async (t) => {
  const keys = makePool([{ id: 'primary', key: SECRET_A }]);
  const server = await createPrototype2Server({
    port: 0,
    serveFrontend: false,
    ultravoxKeyPool: keys,
    ultravoxFetch: (async () =>
      errorResponse(503, { error: 'provider unavailable' })) as unknown as typeof fetch,
  });
  t.after(async () => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const fixture = await createSession(base, 'audio-independent');

  const aiFailure = await post(
    base,
    `/api/sessions/${fixture.sessionId}/ultravox-call`,
    { replace: true },
    fixture.customerKey
  );
  assert.equal(aiFailure.status, 503);

  const join = (role: 'salesperson' | 'customer', credential: string) =>
    new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out joining as ${role}`));
      }, 3_000);
      socket.on('open', () => {
        socket.send(
          JSON.stringify({ type: 'join', sessionId: fixture.sessionId, role, credential })
        );
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'joined') {
          clearTimeout(timer);
          socket.close();
          resolve(message);
        } else if (message.type === 'signal_error') {
          clearTimeout(timer);
          socket.close();
          reject(new Error(`${role} join rejected: ${message.code}`));
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

  const [salespersonJoined, customerJoined] = await Promise.all([
    join('salesperson', fixture.salespersonKey),
    join('customer', fixture.customerKey),
  ]);
  assert.equal(salespersonJoined.type, 'joined');
  assert.equal(customerJoined.type, 'joined');
  // No AI state was fabricated by the failed provider call.
  const session = await get(base, `/api/sessions/${fixture.sessionId}`, fixture.salespersonKey);
  assert.equal(session.body.session.aiCallCreated, false);
  assert.equal(session.body.session.ai.connected, false);
});

