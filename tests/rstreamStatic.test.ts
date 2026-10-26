/**
 * Static rstream TURN credential tests (no API token, no project id).
 *
 * These prove parsing, precedence over/under the API-based flow, missing-variable
 * diagnostics, TTL/expiry handling and secret hygiene for the optional
 * RSTREAM_TURN_* configuration. All provider HTTP is mocked; no real relay is
 * contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIceConfig,
  clearRstreamStaticState,
  describeIceSettingsForLog,
  mergeRstreamIceServers,
  resolveTurnSettings,
  turnSummary,
} from '../server/turn';
import { createPrototype2Server } from '../server';

// Isolate the encrypted admin store so tests never touch the repo's ./data.
process.env.SETTINGS_STORE_PATH ||= `${process.env.TMPDIR || '/tmp'}/uv-test-store-${process.pid}/settings.enc`;

const STATIC_USERNAME = 'static-rstream-user';
const STATIC_CREDENTIAL = 'static-rstream-credential-value';
const STATIC_URLS =
  'turn:static.rstream.invalid:3478?transport=udp, turns:static.rstream.invalid:5349?transport=tcp';

const staticEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  RSTREAM_TURN_USERNAME: STATIC_USERNAME,
  RSTREAM_TURN_CREDENTIAL: STATIC_CREDENTIAL,
  RSTREAM_TURN_URLS: STATIC_URLS,
  RSTREAM_TURN_TTL_SECONDS: '600',
  ...overrides,
});

const turnEntryOf = (config: ReturnType<typeof buildIceConfig>) =>
  config.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  );

test('parses RSTREAM_TURN_URLS as a comma-separated TURN URL list', () => {
  const settings = resolveTurnSettings(
    staticEnv({
      RSTREAM_TURN_URLS:
        ' turn:a.rstream.invalid:3478?transport=udp , turns:b.rstream.invalid:5349?transport=tcp, ,turn:a.rstream.invalid:3478?transport=udp,stun:ignored.example.com:3478,http://nope',
    })
  );

  assert.deepEqual(settings.rstreamStaticUrls, [
    'turn:a.rstream.invalid:3478?transport=udp',
    'turns:b.rstream.invalid:5349?transport=tcp',
  ]);
  assert.equal(settings.rstreamStaticInvalidUrls.length, 2);
  assert.ok(settings.rstreamStaticInvalidUrls.includes('stun:ignored.example.com:3478'));
});

test('clamps RSTREAM_TURN_TTL_SECONDS to a 1-3600 second window with a 600s default', () => {
  const ttl = (raw?: string) =>
    resolveTurnSettings(raw === undefined ? {} : { RSTREAM_TURN_TTL_SECONDS: raw }).rstreamStaticTtlSeconds;

  assert.equal(ttl(), 600);
  assert.equal(ttl(''), 600);
  assert.equal(ttl('0'), 600);
  assert.equal(ttl('nope'), 600);
  assert.equal(ttl('30'), 30);
  assert.equal(ttl('7200'), 3600);
});

test('uses static rstream credentials without a token or project id', () => {
  clearRstreamStaticState();
  const now = 1_800_000_000_000;
  const config = buildIceConfig({ env: staticEnv(), now });

  assert.equal(config.hasTurn, true);
  assert.equal(config.hasStun, true);
  assert.equal(config.turn.configured, true);
  assert.equal(config.turn.credentialMode, 'static');
  assert.equal(config.turn.provider, 'rstream-static');
  assert.equal(config.turn.providerConfigured, false);
  assert.equal(config.turn.urlCount, 2);
  assert.equal(config.turn.expiresAt, now + 600_000);
  assert.deepEqual(config.errors, []);

  const entry = turnEntryOf(config);
  assert.ok(entry);
  assert.deepEqual(entry?.urls, [
    'turn:static.rstream.invalid:3478?transport=udp',
    'turns:static.rstream.invalid:5349?transport=tcp',
  ]);
  assert.equal(entry?.username, STATIC_USERNAME);
  assert.equal(entry?.credential, STATIC_CREDENTIAL);

  // STUN remains present alongside the static TURN entry.
  assert.ok(
    config.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).every((url) => url.startsWith('stun'))
    )
  );

  // The operator is told these expire and are not auto-renewed.
  assert.ok(
    config.warnings.some(
      (warning) => /expire after 600s/i.test(warning) && /NOT renewed automatically/i.test(warning)
    )
  );
});

test('API-based rstream credentials stay preferred when token and project are set', () => {
  clearRstreamStaticState();
  const env = staticEnv({
    RSTREAM_AUTHENTICATION_TOKEN: 'api-token-value',
    RSTREAM_PROJECT_ENDPOINT: 'demo-project',
  });

  const config = buildIceConfig({ env });
  assert.equal(config.turn.credentialMode, 'provider');
  assert.equal(config.turn.provider, 'rstream');
  assert.equal(config.turn.providerConfigured, true);
  assert.equal(turnEntryOf(config), undefined, 'static credentials are not shipped while the API flow is active');

  // If the API call fails, the same static credentials are a usable fallback.
  const fallback = buildIceConfig({ env, ignoreProviders: true });
  assert.equal(fallback.turn.credentialMode, 'static');
  assert.equal(fallback.turn.provider, 'rstream-static');
  assert.equal(turnEntryOf(fallback)?.credential, STATIC_CREDENTIAL);

  const merged = mergeRstreamIceServers(config, null, new Error('rstream down (HTTP 503)'), fallback);
  assert.equal(merged.config.hasTurn, true);
  assert.equal(merged.config.turn.credentialMode, 'static');
  assert.equal(turnEntryOf(merged.config)?.username, STATIC_USERNAME);
});

test('reports incomplete static rstream configuration instead of using it', () => {
  clearRstreamStaticState();

  const onlyUser = buildIceConfig({ env: { RSTREAM_TURN_USERNAME: STATIC_USERNAME } });
  assert.equal(onlyUser.hasTurn, false);
  assert.equal(turnEntryOf(onlyUser), undefined);
  assert.ok(onlyUser.errors.some((error) => /incomplete/i.test(error)));

  const userAndCredential = buildIceConfig({
    env: {
      RSTREAM_TURN_USERNAME: STATIC_USERNAME,
      RSTREAM_TURN_CREDENTIAL: STATIC_CREDENTIAL,
    },
  });
  assert.equal(userAndCredential.hasTurn, false);
  assert.ok(userAndCredential.errors.some((error) => /RSTREAM_TURN_URLS/.test(error)));

  const onlyUrls = buildIceConfig({ env: { RSTREAM_TURN_URLS: STATIC_URLS } });
  assert.equal(onlyUrls.hasTurn, false);
  assert.ok(onlyUrls.errors.some((error) => /incomplete/i.test(error)));

  // Invalid URLs alone are also surfaced, never silently ignored.
  const invalidUrls = buildIceConfig({
    env: staticEnv({ RSTREAM_TURN_URLS: 'https://not-a-turn-url, turn:' }),
  });
  assert.equal(invalidUrls.hasTurn, false);
  assert.ok(invalidUrls.errors.some((error) => /RSTREAM_TURN_URLS contains an invalid entry/.test(error)));
});


test('static rstream credentials expire after RSTREAM_TURN_TTL_SECONDS and are not renewed', () => {
  clearRstreamStaticState();
  const env = staticEnv({ RSTREAM_TURN_TTL_SECONDS: '60' });
  const start = 1_900_000_000_000;

  const fresh = buildIceConfig({ env, now: start });
  assert.equal(fresh.hasTurn, true);
  assert.equal(fresh.turn.expiresAt, start + 60_000);

  const later = buildIceConfig({ env, now: start + 30_000 });
  assert.equal(later.hasTurn, true);
  assert.equal(later.turn.expiresAt, start + 60_000, 'the window is anchored at first use');

  const expired = buildIceConfig({ env, now: start + 60_000 });
  assert.equal(expired.hasTurn, false);
  assert.equal(expired.turn.configured, false);
  assert.equal(expired.turn.credentialMode, 'none');
  assert.equal(turnEntryOf(expired), undefined);
  assert.equal(expired.turn.expiresAt, start + 60_000);
  assert.ok(expired.errors.some((error) => /have expired/i.test(error)));
  assert.ok(expired.errors.some((error) => /NOT renewed automatically/.test(error)));
  assert.ok(expired.errors.some((error) => /replace RSTREAM_TURN_USERNAME/.test(error)));

  // Fresh credentials are a new identity and start a new window; nothing is
  // renewed automatically by the server itself.
  const rotated = buildIceConfig({
    env: staticEnv({ RSTREAM_TURN_TTL_SECONDS: '60', RSTREAM_TURN_CREDENTIAL: 'rotated-credential' }),
    now: start + 60_001,
  });
  assert.equal(rotated.hasTurn, true);
  assert.equal(rotated.turn.expiresAt, start + 60_001 + 60_000);
});

test('expired static rstream credentials defer to a working static TURN relay', () => {
  clearRstreamStaticState();
  const env = staticEnv({
    RSTREAM_TURN_TTL_SECONDS: '30',
    TURN_URLS: 'turn:coturn.invalid:3478?transport=udp',
    TURN_SECRET: 'coturn-secret',
    TURN_TTL_SECONDS: '300',
  });
  const start = 1_950_000_000_000;

  buildIceConfig({ env, now: start });
  const expired = buildIceConfig({ env, now: start + 30_000 });

  assert.equal(expired.hasTurn, true);
  assert.equal(expired.turn.credentialMode, 'ephemeral');
  assert.deepEqual(turnEntryOf(expired)?.urls, ['turn:coturn.invalid:3478?transport=udp']);
  assert.equal(
    expired.turn.expiresAt,
    start + 30_000 + 300_000,
    'the active relay expiry is kept, not the expired static one'
  );
  assert.ok(expired.warnings.some((warning) => /have expired/i.test(warning)));
  assert.deepEqual(expired.errors, []);
});

test('static rstream credentials never appear in health output or the startup log line', () => {
  clearRstreamStaticState();

  const summary = turnSummary(staticEnv());
  const serialized = JSON.stringify(summary);
  assert.equal(summary.configured, true);
  assert.equal(summary.credentialMode, 'static');
  assert.ok(!serialized.includes(STATIC_USERNAME));
  assert.ok(!serialized.includes(STATIC_CREDENTIAL));
  assert.ok(!serialized.includes('static.rstream.invalid'));

  const logLine = describeIceSettingsForLog(staticEnv());
  assert.match(logLine, /credentialMode=static:rstream/);
  assert.ok(!logLine.includes(STATIC_USERNAME));
  assert.ok(!logLine.includes(STATIC_CREDENTIAL));
  assert.ok(!logLine.includes('static.rstream.invalid'));
});


// ---------------------------------------------------------------------------
// Existing authenticated ICE endpoint (no API token, static credentials only).
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'RSTREAM_TURN_USERNAME',
  'RSTREAM_TURN_CREDENTIAL',
  'RSTREAM_TURN_URLS',
  'RSTREAM_TURN_TTL_SECONDS',
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
  Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = (saved: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const post = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

test('ICE endpoint serves static rstream credentials without any API token', async (t) => {
  const saved = snapshotEnv();
  process.env.RSTREAM_TURN_USERNAME = STATIC_USERNAME;
  process.env.RSTREAM_TURN_CREDENTIAL = STATIC_CREDENTIAL;
  process.env.RSTREAM_TURN_URLS = STATIC_URLS;
  process.env.RSTREAM_TURN_TTL_SECONDS = '600';
  delete process.env.RSTREAM_AUTHENTICATION_TOKEN;
  delete process.env.RSTREAM_PROJECT_ENDPOINT;
  delete process.env.RSTREAM_PROJECT_ID;
  delete process.env.RSTREAM_API_BASE_URL;
  delete process.env.TURN_CREDENTIALS_URL;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  process.env.ICE_TRANSPORT_POLICY = 'all';

  let providerCalls = 0;
  const turnFetch = (async () => {
    providerCalls += 1;
    throw new Error('static credentials must not call an HTTP provider');
  }) as unknown as typeof fetch;

  const instance = await createPrototype2Server({ serveFrontend: false, port: 0, turnFetch });
  const base = `http://127.0.0.1:${instance.port}`;
  t.after(async () => {
    await instance.close();
    restoreEnv(saved);
    clearRstreamStaticState();
  });

  const fixture = await createFixture(base, 'rstream-static');
  const icePath = `/api/sessions/${fixture.sessionId}/ice-config`;

  assert.equal((await get(base, icePath)).status, 401);
  const other = await createFixture(base, 'other');
  assert.equal((await get(base, icePath, other.salespersonKey)).status, 401);
  assert.equal((await get(base, icePath, other.customerKey)).status, 401);
  assert.equal(providerCalls, 0);

  for (const key of [fixture.salespersonKey, fixture.customerKey]) {
    const response = await get(base, icePath, key);
    assert.equal(response.status, 200);
    assert.equal(response.body.hasTurn, true);
    assert.equal(response.body.turn.credentialMode, 'static');
    assert.equal(response.body.turn.provider, 'rstream-static');
    assert.equal(response.body.turn.providerConfigured, false);
    assert.ok(response.body.turn.expiresAt > Date.now());
    const turnEntry = response.body.iceServers.find((entry: any) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
    );
    assert.equal(turnEntry.username, STATIC_USERNAME);
    assert.equal(turnEntry.credential, STATIC_CREDENTIAL);
  }
  assert.equal(providerCalls, 0, 'the static path performs no provider HTTP call');

  const health = JSON.stringify((await get(base, '/api/health')).body);
  assert.ok(!health.includes(STATIC_CREDENTIAL));
  assert.ok(!health.includes(STATIC_USERNAME));
  assert.ok(!health.includes('static.rstream.invalid'));
});

