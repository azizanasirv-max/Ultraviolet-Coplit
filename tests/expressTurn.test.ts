/**
 * ExpressTURN static credential tests.
 *
 * ExpressTURN's free plan supplies a TURN server URL, username and password.
 * No Secret Key exists and no HMAC credential derivation is allowed, so these
 * tests assert the operator's values are forwarded verbatim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExpressTurnValidationError,
  clearExpressTurnCredentials,
  getExpressTurnCredentials,
  getExpressTurnStatus,
  parseExpressTurnServerAddress,
  setExpressTurnCredentials,
  validateExpressTurnCredentials,
} from '../server/expressTurn';
import { buildIceConfig, describeIceSettingsForLog, turnSummary } from '../server/turn';

const USERNAME = 'expressturn-user.do-not-leak';
const PASSWORD = 'expressturn-password-do-not-leak';
const NOW = 1_800_000_000_000;

const input = (overrides: Record<string, unknown> = {}) => ({
  serverAddress: 'turn:free.expressturn.com:3478',
  username: USERNAME,
  password: PASSWORD,
  ...overrides,
});

test.afterEach(() => clearExpressTurnCredentials());

test('normalizes the dashboard TURN URL/address without altering credentials', () => {
  assert.deepEqual(parseExpressTurnServerAddress('turn:free.expressturn.com:3478'), [
    'turn:free.expressturn.com:3478',
  ]);
  assert.deepEqual(parseExpressTurnServerAddress('free.expressturn.com:3478'), [
    'turn:free.expressturn.com:3478',
  ]);
  assert.deepEqual(parseExpressTurnServerAddress('turns:turn.example.com:5349'), [
    'turns:turn.example.com:5349',
  ]);
  assert.deepEqual(
    parseExpressTurnServerAddress(
      'turn:free.expressturn.com:3478?transport=udp, turn:free.expressturn.com:3478?transport=tcp\n'
    ),
    ['turn:free.expressturn.com:3478?transport=udp', 'turn:free.expressturn.com:3478?transport=tcp']
  );
  // Duplicates collapse; whitespace is trimmed.
  assert.deepEqual(
    parseExpressTurnServerAddress(' turn:free.expressturn.com:3478 , turn:free.expressturn.com:3478 '),
    ['turn:free.expressturn.com:3478']
  );

  const saved = validateExpressTurnCredentials(input(), NOW);
  assert.equal(saved.username, USERNAME);
  assert.equal(saved.credential, PASSWORD);
  assert.equal(saved.updatedAt, NOW);
});

test('rejects invalid addresses and empty credentials without echoing values', () => {
  for (const serverAddress of [
    'https://free.expressturn.com',
    'turn:free.expressturn.com/path',
    'turn:free.expressturn.com:99999',
    'stun:stun.example.com:3478',
    '',
  ]) {
    assert.throws(
      () => parseExpressTurnServerAddress(serverAddress),
      ExpressTurnValidationError,
      `should reject ${serverAddress}`
    );
  }

  for (const field of ['username', 'password'] as const) {
    const result = (() => {
      try {
        validateExpressTurnCredentials(input({ [field]: '   ' }), NOW);
        return null;
      } catch (err) {
        return err as Error;
      }
    })();
    assert.ok(result instanceof ExpressTurnValidationError);
    assert.ok(!result.message.includes(PASSWORD));
    assert.ok(!result.message.includes(USERNAME));
  }

  const tooLong = 'x'.repeat(513);
  assert.throws(
    () => validateExpressTurnCredentials(input({ password: tooLong }), NOW),
    (err: Error) => err instanceof ExpressTurnValidationError && !err.message.includes(tooLong)
  );
  assert.throws(
    () => validateExpressTurnCredentials(input({ username: 'bad\nuser' }), NOW),
    ExpressTurnValidationError
  );
  // Credentials are never silently trimmed: surrounding whitespace is rejected.
  assert.throws(
    () => validateExpressTurnCredentials(input({ password: ` ${PASSWORD}` }), NOW),
    (err: Error) =>
      err instanceof ExpressTurnValidationError && /whitespace/.test(err.message) && !err.message.includes(PASSWORD)
  );
});


test('keeps credentials in process memory only and exposes safe status', () => {
  clearExpressTurnCredentials();
  assert.equal(getExpressTurnCredentials(), null);
  assert.deepEqual(getExpressTurnStatus(), {
    configured: false,
    urlCount: 0,
    updatedAt: null,
    storage: 'memory',
  });

  const saved = setExpressTurnCredentials(
    input({ serverAddress: 'free.expressturn.com:3478,free.expressturn.com:3480' }),
    NOW
  );
  assert.deepEqual(saved.urls, [
    'turn:free.expressturn.com:3478',
    'turn:free.expressturn.com:3480',
  ]);
  assert.deepEqual(getExpressTurnCredentials(), saved);

  const status = getExpressTurnStatus();
  assert.deepEqual(status, {
    configured: true,
    urlCount: 2,
    updatedAt: NOW,
    storage: 'memory',
  });
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(USERNAME));
  assert.ok(!serialized.includes(PASSWORD));
  assert.ok(!serialized.includes('expressturn.com'));

  clearExpressTurnCredentials();
  assert.equal(getExpressTurnStatus().configured, false);
});

test('buildIceConfig forwards the supplied username/password and URL verbatim', () => {
  const credentials = {
    urls: ['turn:free.expressturn.com:3478?transport=udp', 'turn:free.expressturn.com:3478?transport=tcp'],
    username: USERNAME,
    credential: PASSWORD,
    updatedAt: NOW,
  };

  const config = buildIceConfig({
    env: {
      // ExpressTURN is the operator-configured, highest-priority source.
      RSTREAM_AUTHENTICATION_TOKEN: 'legacy-token',
      RSTREAM_PROJECT_ENDPOINT: 'legacy-project',
      TURN_URLS: 'turn:coturn.invalid:3478?transport=udp',
      TURN_SECRET: 'legacy-coturn-secret',
    },
    expressTurn: credentials,
    sessionId: 'session-42',
    now: NOW,
  });

  assert.equal(config.hasTurn, true);
  assert.equal(config.turn.configured, true);
  assert.equal(config.turn.credentialMode, 'static');
  assert.equal(config.turn.provider, 'expressturn');
  assert.equal(config.turn.expiresAt, null);
  assert.equal(config.turn.urlCount, 2);
  assert.deepEqual(config.errors, []);

  const turnEntry = config.iceServers.find((entry) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => url.startsWith('turn'))
  );
  assert.ok(turnEntry);
  assert.equal(turnEntry?.username, USERNAME);
  assert.equal(turnEntry?.credential, PASSWORD);
  assert.deepEqual(turnEntry?.urls, credentials.urls);

  // STUN is preserved and no HMAC/derived credential appears.
  assert.ok(
    config.iceServers.some((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).every((url) => url.startsWith('stun'))
    )
  );
  assert.ok(!JSON.stringify(config).includes('legacy-coturn-secret'));
});

test('ExpressTURN is ignored for the static fallback build and never leaks into health/logs', () => {
  const credentials = {
    urls: ['turn:free.expressturn.com:3478'],
    username: USERNAME,
    credential: PASSWORD,
    updatedAt: NOW,
  };
  const env = { TURN_URLS: 'turn:coturn.invalid:3478?transport=udp', TURN_SECRET: 'coturn-secret' };

  const fallback = buildIceConfig({ env, expressTurn: credentials, ignoreProviders: true });
  assert.equal(fallback.turn.provider, undefined);
  assert.equal(fallback.turn.credentialMode, 'ephemeral');

  const summary = turnSummary(env, { expressTurn: credentials });
  const serialized = JSON.stringify(summary);
  assert.equal(summary.configured, true);
  assert.equal(summary.provider, 'expressturn');
  assert.equal(summary.credentialMode, 'static');
  assert.ok(!serialized.includes(USERNAME));
  assert.ok(!serialized.includes(PASSWORD));
  assert.ok(!serialized.includes('expressturn.com'));
  assert.ok(!serialized.includes('3478'));

  const logLine = describeIceSettingsForLog(env, { expressTurn: true });
  assert.match(logLine, /credentialMode=static:expressturn/);
  assert.ok(!logLine.includes(USERNAME));
  assert.ok(!logLine.includes(PASSWORD));
  assert.ok(!logLine.includes('expressturn.com'));
});
