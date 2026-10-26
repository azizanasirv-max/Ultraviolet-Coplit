/**
 * rstream managed STUN/TURN integration tests.
 *
 * All provider HTTP calls are mocked: these tests prove the verified request
 * contract (URL, bearer auth, ttlSeconds body), payload validation, caching and
 * expiry handling, error mapping, secret hygiene, and the authenticated ICE
 * endpoint wiring. They do NOT prove that a real rstream project or relay is
 * reachable.
 *
 * Contract source (verified 2026-10):
 *   https://rstream.io/docs/integrations/stun-turn
 *   https://rstream.io/docs/integrations/apis
 *   https://rstream.io/api/openapi.json
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIceConfig,
  buildRstreamCredentialsUrl,
  describeIceSettingsForLog,
  fetchRstreamTurnCredentials,
  mergeRstreamIceServers,
  parseRstreamTurnPayload,
  turnSummary,
} from '../server/turn';
import type { RstreamTurnResult } from '../server/turn';
import { createPrototype2Server } from '../server';

// Isolate the encrypted admin store so tests never touch the repo's ./data.
process.env.SETTINGS_STORE_PATH ||= `${process.env.TMPDIR || '/tmp'}/uv-test-store-${process.pid}/settings.enc`;

const TOKEN = 'rstream-access-token-do-not-leak';

const rstreamEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  RSTREAM_AUTHENTICATION_TOKEN: TOKEN,
  RSTREAM_PROJECT_ENDPOINT: 'demo-project',
  ...overrides,
});

const successPayload = (overrides: Record<string, unknown> = {}) => ({
  username: 'v1:1700000600:api:demo-project:user-1',
  credential: 'temp-credential-value',
  urls: [
    'turn:turn.rstream.invalid:3478?transport=udp',
    'turns:turn.rstream.invalid:5349?transport=tcp',
  ],
  ttl: 600,
  ...overrides,
});

const okResponse = (payload: unknown = successPayload()) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('builds the documented Control plane TURN URLs', () => {
  assert.equal(
    buildRstreamCredentialsUrl({ projectEndpoint: 'demo project/1' }),
    'https://rstream.io/api/projects/tunnels/resolve/demo%20project%2F1/turn-server/credentials'
  );
  assert.equal(
    buildRstreamCredentialsUrl({ baseUrl: 'https://engine.internal/', projectId: 'proj-123' }),
    'https://engine.internal/api/projects/tunnels/proj-123/turn-server/credentials'
  );
  assert.throws(() => buildRstreamCredentialsUrl({}), /RSTREAM_PROJECT_ENDPOINT or RSTREAM_PROJECT_ID/);
  assert.throws(
    () => buildRstreamCredentialsUrl({ baseUrl: 'http://public.example.com', projectId: 'p' }),
    /must be an https/
  );
  // http is allowed only for localhost (local/self-hosted testing).
  assert.equal(
    buildRstreamCredentialsUrl({ baseUrl: 'http://localhost:8080', projectId: 'p' }),
    'http://localhost:8080/api/projects/tunnels/p/turn-server/credentials'
  );
});

test('requests credentials with bearer auth and ttlSeconds, then maps the response', async () => {
  let seenUrl = '';
  let seenMethod = '';
  let seenAuth = '';
  let seenContentType = '';
  let seenBody = '';
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenMethod = String(init?.method);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenAuth = headers.Authorization ?? '';
    seenContentType = headers['Content-Type'] ?? '';
    seenBody = String(init?.body ?? '');
    return okResponse();
  }) as unknown as typeof fetch;

  const result = await fetchRstreamTurnCredentials({
    token: TOKEN,
    projectEndpoint: 'demo-project',
    ttlSeconds: 600,
    fetchImpl,
    cache: new Map(),
    now: 1_700_000_000_000,
  });

  assert.equal(
    seenUrl,
    'https://rstream.io/api/projects/tunnels/resolve/demo-project/turn-server/credentials'
  );
  assert.equal(seenMethod, 'POST');
  assert.equal(seenAuth, `Bearer ${TOKEN}`);
  assert.equal(seenContentType, 'application/json');
  assert.deepEqual(JSON.parse(seenBody), { ttlSeconds: 600 });

  assert.deepEqual(result.urls, successPayload().urls);
  assert.equal(result.ttlSeconds, 600);
  assert.equal(result.expiresAt, 1_700_000_600_000);
  assert.ok(result.cacheExpiresAt < result.expiresAt, 'cache refresh happens before expiry');
  assert.deepEqual(result.iceServers, [
    {
      urls: result.urls,
      username: successPayload().username,
      credential: 'temp-credential-value',
    },
  ]);
});

test('clamps the requested TTL to the documented 1-3600 range', async () => {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return okResponse();
  }) as unknown as typeof fetch;

  await fetchRstreamTurnCredentials({
    token: TOKEN,
    projectId: 'p',
    ttlSeconds: 90_000,
    fetchImpl,
    cache: new Map(),
  });
  await fetchRstreamTurnCredentials({
    token: TOKEN,
    projectId: 'p',
    ttlSeconds: 0,
    fetchImpl,
    cache: new Map(),
  });

  assert.deepEqual(bodies, [{ ttlSeconds: 3600 }, { ttlSeconds: 1 }]);
});

test('caches until the refresh margin and never serves expired credentials', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return okResponse(successPayload({ ttl: 600 }));
  }) as unknown as typeof fetch;
  const cache = new Map<string, RstreamTurnResult>();

  const params = {
    token: TOKEN,
    projectEndpoint: 'demo-project',
    ttlSeconds: 600,
    fetchImpl,
    cache,
  };

  const first = await fetchRstreamTurnCredentials({ ...params, now: 1_000_000 });
  const cached = await fetchRstreamTurnCredentials({ ...params, now: 1_500_000 });
  assert.equal(calls, 1, 'within the refresh window the cached credential is reused');
  assert.equal(cached.expiresAt, first.expiresAt);

  // Refresh happens before the credential expires (600s TTL - 60s margin).
  await fetchRstreamTurnCredentials({ ...params, now: 1_541_000 });
  assert.equal(calls, 2, 'a credential near expiry is refreshed instead of reused');

  // An entry whose credentials have expired must never be served, even if the
  // cache would otherwise consider it fresh.
  const stale = [...cache.values()][0];
  const staleExpiry = stale.expiresAt;
  stale.cacheExpiresAt = staleExpiry + 999_999;
  await fetchRstreamTurnCredentials({ ...params, now: staleExpiry });
  assert.equal(calls, 3, 'expired credentials force a fresh fetch');
});

test('validates the documented payload and drops unusable URLs', () => {
  assert.deepEqual(parseRstreamTurnPayload(successPayload())?.urls, successPayload().urls);
  assert.equal(parseRstreamTurnPayload({ ...successPayload(), username: '' }), null);
  assert.equal(parseRstreamTurnPayload({ ...successPayload(), credential: '' }), null);
  assert.equal(parseRstreamTurnPayload({ ...successPayload(), urls: ['stun:stun.example.com:3478'] }), null);
  assert.equal(parseRstreamTurnPayload({ ...successPayload(), urls: [] }), null);
  assert.equal(parseRstreamTurnPayload([successPayload()]), null);
  assert.equal(parseRstreamTurnPayload(null), null);

  const partial = parseRstreamTurnPayload(
    successPayload({ urls: ['turn:turn.rstream.invalid:3478', 'https://not-a-turn-url'] })
  );
  assert.deepEqual(partial?.urls, ['turn:turn.rstream.invalid:3478']);

  // A malformed/out-of-range ttl falls back to the documented 600s default.
  assert.equal(parseRstreamTurnPayload(successPayload({ ttl: 'soon' }))?.ttlSeconds, 600);
  assert.equal(parseRstreamTurnPayload(successPayload({ ttl: 7200 }))?.ttlSeconds, 600);
});

test('maps provider errors to safe, actionable messages without the token', async () => {
  const cases: Array<[number, RegExp]> = [
    [400, /HTTP 400/],
    [401, /HTTP 401[\s\S]*rotate the token/i],
    [403, /HTTP 403[\s\S]*turn\.credentials\.create/i],
    [404, /HTTP 404[\s\S]*RSTREAM_PROJECT_ENDPOINT/i],
    [409, /HTTP 409/],
    [429, /HTTP 429/],
    [503, /HTTP 503/],
    [500, /HTTP 500/],
  ];

  for (const [status, pattern] of cases) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status })) as unknown as typeof fetch;
    await assert.rejects(
      fetchRstreamTurnCredentials({
        token: TOKEN,
        projectEndpoint: 'demo-project',
        fetchImpl,
        cache: new Map(),
      }),
      (error: Error) => {
        assert.match(error.message, pattern);
        assert.ok(!error.message.includes(TOKEN), 'token must never appear in errors');
        assert.ok(!error.message.includes('nope'), 'provider body must not be echoed');
        return true;
      }
    );
  }
});

test('handles timeouts, network failures, non-JSON and invalid payloads safely', async () => {
  const hanging = (async (_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')));
    })) as unknown as typeof fetch;

  await assert.rejects(
    fetchRstreamTurnCredentials({
      token: TOKEN,
      projectEndpoint: 'demo-project',
      fetchImpl: hanging,
      timeoutMs: 20,
      cache: new Map(),
    }),
    /timed out after 20ms/
  );

  const network = (async () => {
    throw new Error(`connect ECONNREFUSED for ${TOKEN}`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchRstreamTurnCredentials({
      token: TOKEN,
      projectEndpoint: 'demo-project',
      fetchImpl: network,
      cache: new Map(),
    }),
    (error: Error) => {
      assert.match(error.message, /failed/i);
      assert.ok(!error.message.includes(TOKEN), 'token is redacted from network errors');
      return true;
    }
  );

  const nonJson = (async () =>
    new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchRstreamTurnCredentials({
      token: TOKEN,
      projectEndpoint: 'demo-project',
      fetchImpl: nonJson,
      cache: new Map(),
    }),
    /non-JSON/
  );

  const invalid = (async () => okResponse({ username: 'u' })) as unknown as typeof fetch;
  await assert.rejects(
    fetchRstreamTurnCredentials({
      token: TOKEN,
      projectEndpoint: 'demo-project',
      fetchImpl: invalid,
      cache: new Map(),
    }),
    /invalid TURN credential payload/
  );
});


test('buildIceConfig enables rstream provider mode only with both token and project', () => {
  const ready = buildIceConfig({ env: rstreamEnv() });
  assert.equal(ready.turn.credentialMode, 'provider');
  assert.equal(ready.turn.provider, 'rstream');
  assert.equal(ready.turn.providerConfigured, true);
  assert.equal(ready.hasTurn, true);
  assert.deepEqual(ready.errors, []);
  // No static TURN entry: credentials are only issued at request time.
  assert.equal(
    ready.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
    ),
    false
  );

  const noProject = buildIceConfig({ env: { RSTREAM_AUTHENTICATION_TOKEN: TOKEN } });
  assert.equal(noProject.turn.provider, 'rstream');
  assert.equal(noProject.turn.providerConfigured, false);
  assert.equal(noProject.hasTurn, false);
  assert.ok(noProject.errors.some((error) => /RSTREAM_PROJECT_ENDPOINT/.test(error)));

  const noToken = buildIceConfig({ env: { RSTREAM_PROJECT_ENDPOINT: 'demo-project' } });
  assert.equal(noToken.turn.providerConfigured, false);
  assert.ok(noToken.errors.some((error) => /RSTREAM_AUTHENTICATION_TOKEN is missing/.test(error)));

  // Generic TURN_CREDENTIALS_URL still works when rstream is not configured.
  const generic = buildIceConfig({ env: { TURN_CREDENTIALS_URL: 'https://provider.invalid/creds' } });
  assert.equal(generic.turn.provider, 'generic');
  assert.equal(generic.turn.credentialMode, 'provider');
});

test('rstream failure falls back to the preserved static TURN config', () => {
  const env = rstreamEnv({
    TURN_URLS: 'turn:static.invalid:3478?transport=udp',
    TURN_SECRET: 'static-secret',
  });
  const base = buildIceConfig({ env, sessionId: 'sess-1', now: 1_000 });
  const fallback = buildIceConfig({ env, sessionId: 'sess-1', now: 1_000, ignoreProviders: true });
  assert.equal(fallback.hasTurn, true);
  assert.equal(fallback.turn.credentialMode, 'ephemeral');

  const failed = mergeRstreamIceServers(base, null, new Error('rstream down (HTTP 503)'), fallback);
  assert.equal(failed.providerOk, false);
  assert.equal(failed.config.hasTurn, true, 'static relay must survive a provider outage');
  assert.equal(failed.config.turn.credentialMode, 'ephemeral');
  assert.ok(failed.config.warnings.some((warning) => /static TURN relay/.test(warning)));
  const turnEntry = failed.config.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  );
  assert.ok(turnEntry?.username?.endsWith(':sess-1'));

  // No fallback: behaves like the generic provider (fatal only for relay-only).
  const noStatic = buildIceConfig({ env: rstreamEnv() });
  const downgraded = mergeRstreamIceServers(noStatic, null, new Error('rstream down'));
  assert.equal(downgraded.config.hasTurn, false);
  assert.ok(downgraded.config.errors.some((error) => /rstream down/.test(error)));

  const relay = buildIceConfig({ env: rstreamEnv({ ICE_TRANSPORT_POLICY: 'relay' }) });
  const relayFailure = mergeRstreamIceServers(relay, null, new Error('rstream down'));
  assert.ok(relayFailure.config.errors.some((error) => /rstream down/.test(error)));
  assert.equal(relayFailure.config.iceTransportPolicy, 'relay');
});

test('rstream success replaces TURN entries and keeps STUN', () => {
  const base = buildIceConfig({ env: rstreamEnv() });
  const provider: RstreamTurnResult = {
    iceServers: [
      {
        urls: ['turn:turn.rstream.invalid:3478?transport=udp'],
        username: 'v1:1700000600:api:demo-project:user-1',
        credential: 'temp-credential-value',
      },
    ],
    urls: ['turn:turn.rstream.invalid:3478?transport=udp'],
    expiresAt: 1_700_000_600_000,
    cacheExpiresAt: 1_700_000_540_000,
    ttlSeconds: 600,
  };

  const merged = mergeRstreamIceServers(base, provider, null);
  assert.equal(merged.providerOk, true);
  assert.equal(merged.config.hasTurn, true);
  assert.equal(merged.config.turn.credentialMode, 'provider');
  assert.equal(merged.config.turn.provider, 'rstream');
  assert.equal(merged.config.turn.expiresAt, provider.expiresAt);
  assert.equal(merged.config.turn.urlCount, 1);
  assert.ok(
    merged.config.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('stun'))
    )
  );
  assert.deepEqual(merged.config.iceServers.at(-1), provider.iceServers[0]);
});

test('health summary and log line expose no rstream secret, project, or credential', () => {
  const summary = turnSummary(rstreamEnv());
  const serialized = JSON.stringify(summary);
  assert.equal(summary.configured, true);
  assert.equal(summary.credentialMode, 'provider');
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes('demo-project'));
  assert.ok(!serialized.includes('temp-credential-value'));

  const logLine = describeIceSettingsForLog(rstreamEnv());
  assert.match(logLine, /credentialMode=provider:rstream/);
  assert.ok(!logLine.includes(TOKEN));
  assert.ok(!logLine.includes('demo-project'));
});


// ---------------------------------------------------------------------------
// Endpoint wiring: authorization and role isolation are unchanged.
// ---------------------------------------------------------------------------

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const post = async (base: string, path: string, body: unknown, key?: string) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({}) as any) };
};

const get = async (base: string, path: string, key?: string) => {
  const response = await fetch(`${base}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  return { status: response.status, body: await response.json().catch(() => ({}) as any) };
};

const startServer = async (turnFetch: typeof fetch): Promise<Harness> => {
  const instance = await createPrototype2Server({ serveFrontend: false, port: 0, turnFetch });
  return { base: `http://127.0.0.1:${instance.port}`, close: instance.close };
};

const createFixture = async (base: string, label: string) => {
  const created = await post(base, '/api/sessions', { label });
  assert.equal(created.status, 201);
  const inviteUrl: string = created.body.inviteUrl;
  const inviteToken = decodeURIComponent(inviteUrl.split('invite=')[1]);
  const redeemed = await post(base, '/api/invitations/redeem', { inviteToken });
  assert.equal(redeemed.status, 200);
  return {
    sessionId: created.body.sessionId as string,
    salespersonKey: created.body.salespersonKey as string,
    customerKey: redeemed.body.customerKey as string,
  };
};

const RSTREAM_ENV_KEYS = [
  'RSTREAM_AUTHENTICATION_TOKEN',
  'RSTREAM_PROJECT_ENDPOINT',
  'RSTREAM_PROJECT_ID',
  'RSTREAM_API_BASE_URL',
  'TURN_CREDENTIALS_URL',
  'TURN_URLS',
  'TURN_USERNAME',
  'TURN_CREDENTIAL',
  'TURN_SECRET',
  'ICE_TRANSPORT_POLICY',
  'APP_URL',
] as const;

const snapshotEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(RSTREAM_ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = (saved: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};


test('ICE endpoint serves rstream credentials to both session roles only', async (t) => {
  const saved = snapshotEnv();
  process.env.RSTREAM_AUTHENTICATION_TOKEN = TOKEN;
  process.env.RSTREAM_PROJECT_ENDPOINT = 'demo-project';
  delete process.env.RSTREAM_PROJECT_ID;
  delete process.env.RSTREAM_API_BASE_URL;
  delete process.env.TURN_CREDENTIALS_URL;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  process.env.ICE_TRANSPORT_POLICY = 'all';

  let providerCalls = 0;
  let seenAuth = '';
  const turnFetch = (async (_url: string | URL, init?: RequestInit) => {
    providerCalls += 1;
    seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
    return okResponse();
  }) as unknown as typeof fetch;

  const harness = await startServer(turnFetch);
  t.after(async () => {
    await harness.close();
    restoreEnv(saved);
  });

  const fixture = await createFixture(harness.base, 'rstream');
  const icePath = `/api/sessions/${fixture.sessionId}/ice-config`;

  await t.test('rejects anonymous and cross-session callers', async () => {
    assert.equal((await get(harness.base, icePath)).status, 401);
    const other = await createFixture(harness.base, 'other');
    assert.equal((await get(harness.base, icePath, other.salespersonKey)).status, 401);
    assert.equal((await get(harness.base, icePath, other.customerKey)).status, 401);
    assert.equal(providerCalls, 0, 'unauthorized callers must not trigger provider calls');
  });

  await t.test('returns rstream ICE servers to salesperson and customer', async () => {
    for (const key of [fixture.salespersonKey, fixture.customerKey]) {
      const response = await get(harness.base, icePath, key);
      assert.equal(response.status, 200);
      assert.equal(response.body.hasTurn, true);
      assert.equal(response.body.turn.credentialMode, 'provider');
      assert.equal(response.body.turn.provider, 'rstream');
      assert.equal(response.body.turn.configured, true);
      const turnEntry = response.body.iceServers.find((entry: any) =>
        (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
      );
      assert.equal(turnEntry.username, successPayload().username);
      assert.equal(turnEntry.credential, 'temp-credential-value');
      assert.ok(response.body.turn.expiresAt > Date.now());
    }
    assert.ok(providerCalls >= 1, 'provider is called server-side');
    assert.equal(seenAuth, `Bearer ${TOKEN}`, 'bearer token is sent from the server');
  });

  await t.test('reuses the cached credential across both participants', async () => {
    const before = providerCalls;
    await get(harness.base, icePath, fixture.salespersonKey);
    await get(harness.base, icePath, fixture.customerKey);
    assert.equal(providerCalls, before, 'a fresh credential is reused until its refresh margin');
  });

  await t.test('never exposes the token or temporary credential in health', async () => {
    const health = JSON.stringify((await get(harness.base, '/api/health')).body);
    assert.ok(!health.includes(TOKEN));
    assert.ok(!health.includes('temp-credential-value'));
    assert.ok(!health.includes('turn.rstream.invalid'));
  });
});


test('ICE endpoint degrades safely when rstream fails and preserves static TURN', async (t) => {
  const saved = snapshotEnv();
  process.env.RSTREAM_AUTHENTICATION_TOKEN = TOKEN;
  process.env.RSTREAM_PROJECT_ENDPOINT = 'demo-project';
  process.env.TURN_URLS = 'turn:static.invalid:3478?transport=udp';
  process.env.TURN_SECRET = 'static-secret';
  delete process.env.TURN_USERNAME;
  delete process.env.TURN_CREDENTIAL;
  delete process.env.TURN_CREDENTIALS_URL;
  process.env.ICE_TRANSPORT_POLICY = 'all';

  const harness = await startServer(
    (async () => new Response('down', { status: 401 })) as unknown as typeof fetch
  );
  t.after(async () => {
    await harness.close();
    restoreEnv(saved);
  });

  const fixture = await createFixture(harness.base, 'rstream-down');
  const response = await get(
    harness.base,
    `/api/sessions/${fixture.sessionId}/ice-config`,
    fixture.customerKey
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.hasTurn, true, 'static relay is preserved');
  assert.equal(response.body.turn.credentialMode, 'ephemeral');
  assert.ok(response.body.warnings.some((warning: string) => /HTTP 401/.test(warning)));
  assert.ok(response.body.warnings.some((warning: string) => /static TURN relay/.test(warning)));
  assert.ok(!JSON.stringify(response.body).includes(TOKEN));
});

