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

