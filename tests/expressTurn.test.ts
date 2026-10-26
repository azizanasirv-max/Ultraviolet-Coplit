/**
 * ExpressTURN credential generation tests.
 *
 * The credential derivation is checked against an independent crypto
 * calculation of the official scheme documented at
 * https://www.expressturn.com/webrtc-secret-key-examples
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import {
  buildExpressTurnUrls,
  generateExpressTurnCredentials,
  normalizeExpressTurnTtlSeconds,
  validateExpressTurnSettings,
  type ExpressTurnServerSettings,
} from '../server/expressTurn';
import { buildIceConfig, describeIceSettingsForLog, turnSummary } from '../server/turn';

const SECRET = 'unit-test-expressturn-secret';
const NOW = 1_800_000_000_000;

const settings = (overrides: Partial<ExpressTurnServerSettings> = {}): ExpressTurnServerSettings => ({
  host: 'turn.expressturn.com',
  port: 3478,
  ttlSeconds: 600,
  secretKey: SECRET,
  updatedAt: NOW,
  ...overrides,
});

const expectedCredential = (username: string, secret = SECRET): string =>
  createHmac('sha1', secret).update(username).digest('base64');

test('generates the documented <expiry>:<user> username and HMAC-SHA1 Base64 credential', () => {
  const credentials = generateExpressTurnCredentials({
    secretKey: SECRET,
    host: 'turn.expressturn.com',
    port: 3478,
    ttlSeconds: 600,
    userId: 'session-abc',
    now: NOW,
  });

  const expiresAtSeconds = Math.floor(NOW / 1000) + 600;
  assert.equal(credentials.username, `${expiresAtSeconds}:session-abc`);
  assert.equal(credentials.credential, expectedCredential(credentials.username));
  assert.equal(credentials.expiresAt, expiresAtSeconds * 1000);
  assert.equal(credentials.ttlSeconds, 600);
  assert.deepEqual(credentials.urls, [
    'turn:turn.expressturn.com:3478?transport=udp',
    'turn:turn.expressturn.com:3478?transport=tcp',
  ]);
});

test('scopes credentials to the session id and sanitizes unsafe characters', () => {
  const a = generateExpressTurnCredentials({
    secretKey: SECRET,
    host: 'turn.expressturn.com',
    port: 3478,
    ttlSeconds: 600,
    userId: 'session-a',
    now: NOW,
  });
  const b = generateExpressTurnCredentials({
    secretKey: SECRET,
    host: 'turn.expressturn.com',
    port: 3478,
    ttlSeconds: 600,
    userId: 'session-b',
    now: NOW,
  });
  assert.notEqual(a.credential, b.credential);

  const sanitized = generateExpressTurnCredentials({
    secretKey: SECRET,
    host: 'turn.expressturn.com',
    port: 3478,
    userId: 'bad id/../with spaces',
    now: NOW,
  });
  assert.match(sanitized.username, /^\d+:[A-Za-z0-9._-]+$/);
  assert.ok(!sanitized.username.includes(' '));
  assert.ok(!sanitized.username.includes('/'));
});

test('clamps TTL to the 300-86400 second window and builds both transports', () => {
  assert.equal(normalizeExpressTurnTtlSeconds(undefined), 3600);
  assert.equal(normalizeExpressTurnTtlSeconds('nope'), 3600);
  assert.equal(normalizeExpressTurnTtlSeconds(5), 300);
  assert.equal(normalizeExpressTurnTtlSeconds(10_000_000), 86_400);
  assert.deepEqual(buildExpressTurnUrls('192.0.2.10', 3479), [
    'turn:192.0.2.10:3479?transport=udp',
    'turn:192.0.2.10:3479?transport=tcp',
  ]);
});

test('validates host, port, TTL and secret without echoing the secret', () => {
  const good = validateExpressTurnSettings({
    host: ' Turn.ExpressTURN.com ',
    port: '3478',
    ttlSeconds: '600',
    secretKey: `  ${SECRET}  `,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600 });
  assert.equal(good.secretKey, SECRET);

  for (const host of ['https://turn.expressturn.com', 'turn.expressturn.com:3478', 'bad host', '']) {
    const result = validateExpressTurnSettings({ host, port: 3478, secretKey: SECRET });
    assert.equal(result.ok, false, `host should be rejected: ${host}`);
  }

  const badPort = validateExpressTurnSettings({ host: 'turn.expressturn.com', port: 70000, secretKey: SECRET });
  assert.equal(badPort.ok, false);
  assert.ok(badPort.errors.some((error) => /port/i.test(error)));

  const badTtl = validateExpressTurnSettings({
    host: 'turn.expressturn.com',
    port: 3478,
    ttlSeconds: 10,
    secretKey: SECRET,
  });
  assert.equal(badTtl.ok, false);
  assert.ok(badTtl.errors.some((error) => /TTL/.test(error)));

  const shortSecret = validateExpressTurnSettings({ host: 'turn.expressturn.com', port: 3478, secretKey: 'short' });
  assert.equal(shortSecret.ok, false);
  assert.ok(!JSON.stringify(shortSecret).includes('short'));

  // The secret must never be included in validation output.
  assert.ok(!JSON.stringify(good.value).includes(SECRET));
});

test('buildIceConfig issues ExpressTURN credentials as the highest-priority provider', () => {
  const now = 1_850_000_000_000;
  const config = buildIceConfig({
    env: {
      // Even with rstream configured, ExpressTURN wins because it is the
      // operator-configured provider.
      RSTREAM_AUTHENTICATION_TOKEN: 'legacy-token',
      RSTREAM_PROJECT_ENDPOINT: 'legacy-project',
    },
    expressTurn: settings({ ttlSeconds: 600 }),
    sessionId: 'session-42',
    now,
  });

  assert.equal(config.hasTurn, true);
  assert.equal(config.turn.credentialMode, 'ephemeral');
  assert.equal(config.turn.provider, 'expressturn');
  assert.equal(config.turn.configured, true);
  assert.equal(config.turn.urlCount, 2);
  assert.equal(config.turn.expiresAt, now + 600_000);
  assert.deepEqual(config.errors, []);

  const expectedUsername = `${Math.floor(now / 1000) + 600}:session-42`;
  const turnEntry = config.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  );
  assert.ok(turnEntry);
  assert.equal(turnEntry?.username, expectedUsername);
  assert.equal(turnEntry?.credential, expectedCredential(expectedUsername));
  assert.deepEqual(turnEntry?.urls, [
    'turn:turn.expressturn.com:3478?transport=udp',
    'turn:turn.expressturn.com:3478?transport=tcp',
  ]);

  // STUN is preserved and the secret never appears in the payload.
  assert.ok(
    config.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).every((url) => url.startsWith('stun'))
    )
  );
  assert.ok(!JSON.stringify(config).includes(SECRET));
});

test('an unusable ExpressTURN config is reported and does not use the secret', () => {
  const now = 1_850_000_000_000;
  const failed = buildIceConfig({
    env: {},
    expressTurn: settings({ secretKey: '' }),
    expressTurnError: 'Stored ExpressTURN settings could not be decrypted.',
    now,
  });
  assert.equal(failed.hasTurn, false);
  assert.ok(failed.errors.some((error) => /ExpressTURN/.test(error)));

  // With a working coturn fallback the same problem is only a warning.
  const withFallback = buildIceConfig({
    env: { TURN_URLS: 'turn:coturn.invalid:3478?transport=udp', TURN_SECRET: 'coturn-secret' },
    expressTurnError: 'Stored ExpressTURN settings could not be decrypted.',
    now,
  });
  assert.equal(withFallback.hasTurn, true);
  assert.equal(withFallback.turn.credentialMode, 'ephemeral');
  assert.ok(withFallback.warnings.some((warning) => /ExpressTURN/.test(warning)));
});

test('ExpressTURN is ignored for the static fallback build and never leaks into health/logs', () => {
  const env = { TURN_URLS: 'turn:coturn.invalid:3478?transport=udp', TURN_SECRET: 'coturn-secret' };
  const fallback = buildIceConfig({ env, expressTurn: settings(), ignoreProviders: true });
  assert.equal(fallback.turn.provider, undefined);
  assert.equal(fallback.turn.credentialMode, 'ephemeral');

  const summary = turnSummary(env, { expressTurn: settings() });
  const serialized = JSON.stringify(summary);
  assert.equal(summary.configured, true);
  assert.equal(summary.provider, 'expressturn');
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes('turn.expressturn.com'));
  assert.ok(!serialized.includes('3478'));

  const logLine = describeIceSettingsForLog(env, { expressTurn: true });
  assert.match(logLine, /credentialMode=ephemeral:expressturn/);
  assert.ok(!logLine.includes(SECRET));
  assert.ok(!logLine.includes('turn.expressturn.com'));
});

