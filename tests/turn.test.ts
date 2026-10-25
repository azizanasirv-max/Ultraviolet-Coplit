/**
 * Unit tests for server/turn.ts.
 *
 * These use synthetic environment variables only: they prove parsing,
 * credential generation and diagnostics logic. They do NOT prove that a real
 * TURN relay is reachable or that media traverses it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import {
  buildEphemeralTurnCredential,
  buildIceConfig,
  parseTurnUrls,
  resolveIceTransportPolicy,
  turnSummary,
} from '../server/turn';

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp',
  TURN_USERNAME: 'relay-user',
  TURN_CREDENTIAL: 'relay-pass',
  ...overrides,
});

test('parses multiple TURN URLs with turn: and turns: schemes', () => {
  const parsed = parseTurnUrls(
    'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349?transport=tcp ,turn:192.0.2.10:3478'
  );
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.urls.length, 3);
  assert.ok(parsed.urls[0].startsWith('turn:'));
  assert.ok(parsed.urls[1].startsWith('turns:'));
  assert.ok(parsed.urls[2].includes('192.0.2.10'));
});

test('rejects malformed or unsupported TURN entries', () => {
  const parsed = parseTurnUrls('stun:stun.example.com:3478,turn:,turn:ok.example.com:3478,http://example.com');
  assert.deepEqual(parsed.urls, ['turn:ok.example.com:3478']);
  assert.equal(parsed.invalid.length, 3);
});

test('returns valid STUN and TURN entries with static credentials', () => {
  const config = buildIceConfig({ env: env(), now: 1_700_000_000_000 });
  assert.equal(config.hasTurn, true);
  assert.equal(config.hasStun, true);
  assert.equal(config.turn.configured, true);
  assert.equal(config.turn.credentialMode, 'static');
  assert.equal(config.turn.urlCount, 2);
  assert.equal(config.iceTransportPolicy, 'all');

  const turnEntry = config.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  );
  assert.ok(turnEntry);
  assert.equal(turnEntry?.username, 'relay-user');
  assert.equal(turnEntry?.credential, 'relay-pass');
  assert.ok(config.warnings.some((warning) => /static credentials/i.test(warning)));
});

test('generates short-lived coturn REST credentials when TURN_SECRET is set', () => {
  const secret = 'unit-test-shared-secret';
  const now = 1_700_000_000_000;
  const config = buildIceConfig({
    env: env({ TURN_SECRET: secret, TURN_TTL_SECONDS: '600' }),
    now,
    sessionId: 'session-abc',
  });

  assert.equal(config.turn.credentialMode, 'ephemeral');
  const expectedExpiry = Math.floor(now / 1000) + 600;
  assert.equal(config.turn.expiresAt, expectedExpiry * 1000);

  const turnEntry = config.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  );
  assert.ok(turnEntry);
  assert.equal(turnEntry?.username, `${expectedExpiry}:session-abc`);
  const expectedCredential = createHmac('sha1', secret)
    .update(`${expectedExpiry}:session-abc`)
    .digest('base64');
  assert.equal(turnEntry?.credential, expectedCredential);

  // The shared secret itself must never be part of the payload.
  assert.ok(!JSON.stringify(config).includes(secret));
  assert.ok(!JSON.stringify(config).includes('relay-pass'));
});

test('ephemeral credentials are scoped to one session and expiry', () => {
  const a = buildEphemeralTurnCredential({ secret: 's', expiresAtSeconds: 1000, userId: 'a' });
  const b = buildEphemeralTurnCredential({ secret: 's', expiresAtSeconds: 1000, userId: 'b' });
  assert.equal(a.username, '1000:a');
  assert.notEqual(a.credential, b.credential);
});

test('TURN_URLS without authentication is an actionable error, not a silent success', () => {
  const config = buildIceConfig({
    env: { TURN_URLS: 'turn:turn.example.com:3478' },
  });
  assert.equal(config.hasTurn, false);
  assert.equal(config.turn.credentialMode, 'none');
  assert.ok(config.errors.some((error) => /TURN authentication is missing/i.test(error)));
  assert.ok(!config.iceServers.some((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  ));
});

test('relay-only mode without usable TURN is a hard error', () => {
  const config = buildIceConfig({ env: { ICE_TRANSPORT_POLICY: 'relay' } });
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.hasTurn, false);
  assert.ok(config.errors.some((error) => /relay requires a usable TURN relay/i.test(error)));
});

test('relay-only mode with TURN configured has no errors', () => {
  const config = buildIceConfig({ env: env({ TURN_SECRET: 'secret', ICE_TRANSPORT_POLICY: 'relay' }) });
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.hasTurn, true);
  assert.deepEqual(config.errors, []);
});

test('warns when no TURN is configured but STUN-only calls are allowed', () => {
  const config = buildIceConfig({ env: {} });
  assert.equal(config.hasTurn, false);
  assert.equal(config.iceTransportPolicy, 'all');
  assert.deepEqual(config.errors, []);
  assert.ok(config.warnings.some((warning) => /No usable TURN relay/i.test(warning)));
  assert.equal(config.iceServers.length, 1);
});

test('credentials set without TURN_URLS produce a warning, not a relay entry', () => {
  const config = buildIceConfig({ env: { TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' } });
  assert.equal(config.hasTurn, false);
  assert.ok(config.warnings.some((warning) => /TURN_URLS is empty/i.test(warning)));
});

test('ICE transport policy only accepts relay explicitly', () => {
  assert.equal(resolveIceTransportPolicy({}), 'all');
  assert.equal(resolveIceTransportPolicy({ ICE_TRANSPORT_POLICY: 'all' }), 'all');
  assert.equal(resolveIceTransportPolicy({ ICE_TRANSPORT_POLICY: 'relay' }), 'relay');
  assert.equal(resolveIceTransportPolicy({ ICE_TRANSPORT_POLICY: 'RELAY' }), 'all');
});

test('health summary never contains URLs, usernames, credentials, or the secret', () => {
  const summary = turnSummary(env({ TURN_SECRET: 'super-secret' }));
  const serialized = JSON.stringify(summary);
  assert.equal(summary.configured, true);
  assert.equal(summary.credentialMode, 'ephemeral');
  assert.ok(!serialized.includes('turn.example.com'));
  assert.ok(!serialized.includes('relay-user'));
  assert.ok(!serialized.includes('relay-pass'));
  assert.ok(!serialized.includes('super-secret'));
});


// ---------------------------------------------------------------------------
// Provider-issued (short-lived) credentials — mocked HTTP only.
// ---------------------------------------------------------------------------
import { clearProviderIceCache, fetchProviderIceServers, mergeProviderIceServers, parseProviderIceServers } from '../server/turn';

test('parses provider payload shapes and drops non-TURN entries', () => {
  const fromArray = parseProviderIceServers([
    { url: 'turn:relay.example.com:3478', username: 'u1', credential: 'c1' },
    { urls: ['turns:relay.example.com:5349'], username: 'u2', password: 'c2' },
    { urls: 'stun:stun.example.com:3478', username: 'u3', credential: 'c3' },
    { urls: 'turn:missing-auth.example.com:3478' },
  ]);
  assert.equal(fromArray.length, 2);
  assert.deepEqual(fromArray[0], { urls: 'turn:relay.example.com:3478', username: 'u1', credential: 'c1' });
  assert.deepEqual(fromArray[1], { urls: 'turns:relay.example.com:5349', username: 'u2', credential: 'c2' });

  assert.equal(parseProviderIceServers({ iceServers: fromArray }).length, 2);
  assert.equal(parseProviderIceServers({ ice_servers: fromArray }).length, 2);
  assert.equal(parseProviderIceServers({ data: fromArray }).length, 2);
  assert.deepEqual(parseProviderIceServers({}), []);
});

test('fetches, caches, and expires provider credentials (mock HTTP)', async () => {
  clearProviderIceCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        iceServers: [{ urls: 'turn:provider.invalid:3478', username: 'temp-user', credential: 'temp-pass' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const cache = new Map();
  const first = await fetchProviderIceServers({
    credentialsUrl: 'https://provider.invalid/creds',
    fetchImpl,
    now: 1_000,
    cacheTtlMs: 60_000,
    cache,
  });
  assert.equal(calls, 1);
  assert.equal(first.iceServers[0].username, 'temp-user');
  assert.equal(first.expiresAt, 61_000);

  const second = await fetchProviderIceServers({
    credentialsUrl: 'https://provider.invalid/creds',
    fetchImpl,
    now: 2_000,
    cacheTtlMs: 60_000,
    cache,
  });
  assert.equal(calls, 1, 'cached credentials must not trigger another request');
  assert.deepEqual(second, first);
});

test('provider failures are actionable and leak no URL or auth header', async () => {
  clearProviderIceCache();
  const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchProviderIceServers({
      credentialsUrl: 'https://provider.invalid/creds?apiKey=super-secret',
      authorization: 'Bearer provider-secret',
      fetchImpl: failing,
      cache: new Map(),
    }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes('super-secret'));
      assert.ok(!error.message.includes('provider-secret'));
      return true;
    }
  );

  const unreachable = (async () => {
    throw new Error('ECONNREFUSED 10.0.0.1');
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchProviderIceServers({
      credentialsUrl: 'https://provider.invalid/creds',
      fetchImpl: unreachable,
      cache: new Map(),
    }),
    /could not be reached/i
  );

  // Some fetch/runtime errors echo the full request URL. It may contain the
  // provider API key (Metered style), so it must never reach a log or payload.
  const echoesUrl = (async () => {
    throw new Error(
      'Failed to parse URL from https://app.metered.live/api/v1/turn/credentials?apiKey=super-secret'
    );
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchProviderIceServers({
      credentialsUrl: 'https://app.metered.live/api/v1/turn/credentials?apiKey=super-secret',
      fetchImpl: echoesUrl,
      cache: new Map(),
    }),
    (error: Error) => {
      assert.ok(!error.message.includes('super-secret'));
      assert.ok(!error.message.includes('app.metered.live'));
      assert.match(error.message, /provider-url/);
      return true;
    }
  );
});

test('provider success replaces TURN entries; failure is fatal only for relay policy', () => {
  const base = buildIceConfig({ env: { TURN_CREDENTIALS_URL: 'https://provider.invalid/creds' } });
  assert.equal(base.turn.credentialMode, 'provider');
  assert.equal(base.turn.providerConfigured, true);

  const merged = mergeProviderIceServers(
    base,
    {
      iceServers: [{ urls: 'turn:provider.invalid:3478', username: 'temp', credential: 'pass' }],
      fetchedAt: 1,
      expiresAt: 2,
    },
    null
  );
  assert.equal(merged.providerOk, true);
  assert.equal(merged.config.hasTurn, true);
  assert.equal(merged.config.turn.credentialMode, 'provider');
  assert.ok(
    merged.config.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
    )
  );
  assert.ok(merged.config.iceServers.some((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('stun'))
  ));

  const failedAll = mergeProviderIceServers(base, null, new Error('provider down'));
  assert.equal(failedAll.providerOk, false);
  assert.equal(failedAll.config.hasTurn, false);
  assert.ok(failedAll.config.warnings.some((warning) => warning.includes('provider down')));

  // A provider deployment may also carry TURN_URLS. Those entries have no
  // usable credential when the provider fails, so they must not be sent to the
  // browser (the relay would reject every allocation).
  const providerWithUrls = buildIceConfig({
    env: {
      TURN_CREDENTIALS_URL: 'https://provider.invalid/creds',
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp',
      TURN_USERNAME: 'stale-user',
      TURN_CREDENTIAL: 'stale-pass',
    },
  });
  const failedWithUrls = mergeProviderIceServers(providerWithUrls, null, new Error('provider down'));
  assert.equal(failedWithUrls.config.hasTurn, false);
  assert.equal(
    failedWithUrls.config.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => /^turns?:/i.test(url))
    ),
    false,
    'unauthenticated TURN entries are dropped'
  );
  assert.ok(
    failedWithUrls.config.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => /^stuns?:/i.test(url))
    ),
    'STUN is still available for a direct path'
  );

  const relayBase = buildIceConfig({
    env: { TURN_CREDENTIALS_URL: 'https://provider.invalid/creds', ICE_TRANSPORT_POLICY: 'relay' },
  });
  const failedRelay = mergeProviderIceServers(relayBase, null, new Error('provider down'));
  assert.ok(failedRelay.config.errors.some((error) => error.includes('provider down')));
});

test('provider POST mode sends a TTL and accepts an object-shaped iceServers payload', async () => {
  let method = '';
  let body = '';
  let contentType = '';
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    method = String(init?.method);
    body = String(init?.body ?? '');
    contentType = String((init?.headers as Record<string, string>)?.['Content-Type'] ?? '');
    return new Response(
      JSON.stringify({
        iceServers: {
          urls: ['turn:turn.cloudflare.invalid:3478?transport=udp'],
          username: 'cf-user',
          credential: 'cf-pass',
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const result = await fetchProviderIceServers({
    credentialsUrl: 'https://rtc.invalid/v1/turn/keys/key/credentials/generate',
    authorization: 'Bearer cf-token',
    method: 'POST',
    ttlSeconds: 900,
    fetchImpl,
    cache: new Map(),
    now: 5_000,
    cacheTtlMs: 60_000,
  });

  assert.equal(method, 'POST');
  assert.equal(contentType, 'application/json');
  assert.deepEqual(JSON.parse(body), { ttl: 900 });
  assert.equal(result.iceServers.length, 1);
  assert.equal(result.iceServers[0].username, 'cf-user');
  assert.equal(result.iceServers[0].urls, 'turn:turn.cloudflare.invalid:3478?transport=udp');
  assert.equal(result.expiresAt, 65_000);
});
