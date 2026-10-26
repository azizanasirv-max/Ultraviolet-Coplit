/**
 * Admin settings + ExpressTURN end-to-end tests (mocked relay, real encryption).
 *
 * Proves: the admin page is protected, the secret is never returned/logged, the
 * encrypted settings drive the existing authenticated ICE endpoint, and
 * customer/salesperson role isolation is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { createPrototype2Server } from '../server';
import { ADMIN_COOKIE_NAME } from '../server/admin';
import { clearTurnSettingsCache } from '../server/turnSettingsStore';

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const TURN_SECRET = 'admin-flow-expressturn-secret';
const ENV_KEYS = [
  'ADMIN_PASSWORD',
  'SETTINGS_ENCRYPTION_KEY',
  'SETTINGS_STORE_PATH',
  'SETTINGS_PERSISTENT_STORAGE',
  'RSTREAM_AUTHENTICATION_TOKEN',
  'RSTREAM_PROJECT_ENDPOINT',
  'RSTREAM_PROJECT_ID',
  'RSTREAM_TURN_USERNAME',
  'RSTREAM_TURN_CREDENTIAL',
  'RSTREAM_TURN_URLS',
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

const jsonRequest = async (
  base: string,
  method: string,
  route: string,
  options: { body?: unknown; cookie?: string; origin?: string } = {}
) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as any,
    headers: response.headers,
  };
};

const fetchText = async (base: string, route: string, cookie?: string) => {
  const response = await fetch(`${base}${route}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: response.status, text: await response.text() };
};

const createFixture = async (base: string, label: string) => {
  const created = await jsonRequest(base, 'POST', '/api/sessions', { body: { label } });
  assert.equal(created.status, 201);
  const inviteUrl: string = created.body.inviteUrl;
  const inviteToken = decodeURIComponent(inviteUrl.split('invite=')[1]);
  const redeemed = await jsonRequest(base, 'POST', '/api/invitations/redeem', { body: { inviteToken } });
  assert.equal(redeemed.status, 200);
  return {
    sessionId: created.body.sessionId as string,
    salespersonKey: created.body.salespersonKey as string,
    customerKey: redeemed.body.customerKey as string,
  };
};

const hmacCredential = (username: string, secret = TURN_SECRET): string =>
  createHmac('sha1', secret).update(username).digest('base64');

test('admin login protects encrypted ExpressTURN settings used by the ICE endpoint', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-'));
  const storePath = path.join(dir, 'turn-settings.enc');
  const saved = snapshotEnv();
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.SETTINGS_STORE_PATH = storePath;
  process.env.SETTINGS_PERSISTENT_STORAGE = 'false';
  delete process.env.RSTREAM_AUTHENTICATION_TOKEN;
  delete process.env.RSTREAM_PROJECT_ENDPOINT;
  delete process.env.RSTREAM_PROJECT_ID;
  delete process.env.RSTREAM_TURN_USERNAME;
  delete process.env.RSTREAM_TURN_CREDENTIAL;
  delete process.env.RSTREAM_TURN_URLS;
  delete process.env.TURN_CREDENTIALS_URL;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  process.env.ICE_TRANSPORT_POLICY = 'all';
  clearTurnSettingsCache();

  let providerCalls = 0;
  const instance = await createPrototype2Server({
    serveFrontend: false,
    port: 0,
    turnFetch: (async () => {
      providerCalls += 1;
      throw new Error('no HTTP TURN provider should be called for ExpressTURN');
    }) as unknown as typeof fetch,
  });
  const base = `http://127.0.0.1:${instance.port}`;
  t.after(async () => {
    await instance.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  let cookie = '';

  await t.test('serves a login page but no settings without a session', async () => {
    const page = await fetchText(base, '/admin/turn');
    assert.equal(page.status, 200);
    assert.match(page.text, /Sign in/);
    assert.ok(!page.text.includes(ADMIN_PASSWORD));

    assert.equal((await jsonRequest(base, 'GET', '/api/admin/turn-settings')).status, 401);
    assert.equal((await fetchText(base, '/api/admin/turn-settings')).status, 401);
  });

  await t.test('rejects a wrong password and accepts the configured one', async () => {
    const wrong = await jsonRequest(base, 'POST', '/api/admin/login', {
      body: { password: 'wrong-password-123' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const login = await jsonRequest(base, 'POST', '/api/admin/login', {
      body: { password: ADMIN_PASSWORD },
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.ok(!setCookie.includes(ADMIN_PASSWORD));
    cookie = setCookie.split(';')[0];
  });


  await t.test('stores settings encrypted and never returns the secret', async () => {
    const initial = await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.ok(!('secretKey' in initial.body));
    assert.ok(!JSON.stringify(initial.body).includes(ADMIN_PASSWORD));

    const crossOrigin = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      origin: 'https://evil.example',
      body: { host: 'turn.expressturn.com', port: 3478, secretKey: TURN_SECRET },
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: { host: 'https://turn.expressturn.com', port: 3478, secretKey: TURN_SECRET },
    });
    assert.equal(invalid.status, 400);
    assert.ok(!JSON.stringify(invalid.body).includes(TURN_SECRET));

    const updated = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: TURN_SECRET },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.settings.configured, true);
    assert.equal(updated.body.settings.host, 'turn.expressturn.com');
    assert.ok(!JSON.stringify(updated.body).includes(TURN_SECRET));
    assert.ok(!('secretKey' in updated.body.settings));

    const raw = await readFile(storePath, 'utf8');
    assert.ok(!raw.includes(TURN_SECRET), 'secret is not plaintext on disk');
    assert.ok(!raw.includes('turn.expressturn.com'));

    const authedPage = await fetchText(base, '/admin/turn', cookie);
    assert.equal(authedPage.status, 200);
    assert.match(authedPage.text, /turn\.expressturn\.com/);
    assert.ok(!authedPage.text.includes(TURN_SECRET));
  });

  await t.test('issues short-lived ExpressTURN credentials to both session roles only', async () => {
    const fixture = await createFixture(base, 'expressturn');
    const icePath = `/api/sessions/${fixture.sessionId}/ice-config`;

    assert.equal((await jsonRequest(base, 'GET', icePath)).status, 401);
    const other = await createFixture(base, 'other');
    const otherCall = await fetch(`${base}${icePath}`, {
      headers: { Authorization: `Bearer ${other.customerKey}` },
    });
    assert.equal(otherCall.status, 401);

    const before = Date.now();
    for (const key of [fixture.salespersonKey, fixture.customerKey]) {
      const response = await fetch(`${base}${icePath}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.hasTurn, true);
      assert.equal(body.turn.provider, 'expressturn');
      assert.equal(body.turn.credentialMode, 'ephemeral');
      assert.ok(body.turn.expiresAt >= before + 590_000);

      const turnEntry = body.iceServers.find((entry: any) =>
        (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
      );
      assert.ok(turnEntry);
      assert.deepEqual(turnEntry.urls, [
        'turn:turn.expressturn.com:3478?transport=udp',
        'turn:turn.expressturn.com:3478?transport=tcp',
      ]);
      const expectedUserSuffix = fixture.sessionId.replace(/[^A-Za-z0-9._-]/g, '');
      assert.match(turnEntry.username, new RegExp(`^\\d+:${expectedUserSuffix}$`));
      assert.equal(turnEntry.credential, hmacCredential(turnEntry.username));
      assert.ok(
        body.iceServers.some((entry: any) =>
          (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).every((url: string) => url.startsWith('stun'))
        ),
        'STUN is preserved'
      );
      assert.ok(!JSON.stringify(body).includes(TURN_SECRET));
    }

    assert.equal(providerCalls, 0, 'ExpressTURN credentials are generated locally');

    const health = JSON.stringify((await jsonRequest(base, 'GET', '/api/health')).body);
    assert.ok(!health.includes(TURN_SECRET));
    assert.ok(!health.includes('turn.expressturn.com'));
  });
});


test('admin page is disabled without ADMIN_PASSWORD (no insecure default)', async (t) => {
  const saved = snapshotEnv();
  delete process.env.ADMIN_PASSWORD;
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.SETTINGS_STORE_PATH = path.join(os.tmpdir(), `uv-unused-${randomBytes(4).toString('hex')}.enc`);
  clearTurnSettingsCache();

  const instance = await createPrototype2Server({ serveFrontend: false, port: 0 });
  const base = `http://127.0.0.1:${instance.port}`;
  t.after(async () => {
    await instance.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
  });

  const page = await fetchText(base, '/admin/turn');
  assert.equal(page.status, 503);
  assert.match(page.text, /ADMIN_PASSWORD/);

  const login = await jsonRequest(base, 'POST', '/api/admin/login', { body: { password: 'anything-at-all' } });
  assert.equal(login.status, 503);
  assert.equal(login.body.error, 'ADMIN_DISABLED');

  assert.equal((await jsonRequest(base, 'GET', '/api/admin/turn-settings')).status, 401);
});

test('a corrupt encrypted store degrades safely and never exposes ciphertext', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-corrupt-'));
  const storePath = path.join(dir, 'turn-settings.enc');
  const corrupt = JSON.stringify({ v: 2, alg: 'aes-256-gcm', iv: 'AAAA', tag: 'BBBB', data: 'CCCC' });
  await writeFile(storePath, corrupt);

  const saved = snapshotEnv();
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.SETTINGS_STORE_PATH = storePath;
  delete process.env.RSTREAM_AUTHENTICATION_TOKEN;
  delete process.env.RSTREAM_PROJECT_ENDPOINT;
  delete process.env.RSTREAM_PROJECT_ID;
  delete process.env.RSTREAM_TURN_USERNAME;
  delete process.env.RSTREAM_TURN_CREDENTIAL;
  delete process.env.RSTREAM_TURN_URLS;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  delete process.env.TURN_CREDENTIALS_URL;
  process.env.ICE_TRANSPORT_POLICY = 'all';
  clearTurnSettingsCache();

  const instance = await createPrototype2Server({ serveFrontend: false, port: 0 });
  const base = `http://127.0.0.1:${instance.port}`;
  t.after(async () => {
    await instance.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  const fixture = await createFixture(base, 'corrupt-store');
  const response = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.hasTurn, false);
  assert.ok(body.errors.some((error: string) => /could not be decrypted/i.test(error)));
  assert.ok(!JSON.stringify(body).includes('CCCC'), 'ciphertext is never exposed');
  assert.ok(!JSON.stringify(body).includes(process.env.SETTINGS_ENCRYPTION_KEY as string));
});


test('the ExpressTURN secret never reaches server logs during save or ICE delivery', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-logs-'));
  const saved = snapshotEnv();
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.SETTINGS_STORE_PATH = path.join(dir, 'turn-settings.enc');
  delete process.env.RSTREAM_AUTHENTICATION_TOKEN;
  delete process.env.RSTREAM_PROJECT_ENDPOINT;
  delete process.env.RSTREAM_PROJECT_ID;
  delete process.env.TURN_URLS;
  delete process.env.TURN_SECRET;
  process.env.ICE_TRANSPORT_POLICY = 'all';
  clearTurnSettingsCache();

  const logMock = t.mock.method(console, 'log');
  const warnMock = t.mock.method(console, 'warn');
  const errorMock = t.mock.method(console, 'error');

  const instance = await createPrototype2Server({ serveFrontend: false, port: 0 });
  const base = `http://127.0.0.1:${instance.port}`;
  t.after(async () => {
    await instance.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  const login = await jsonRequest(base, 'POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const updated = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    cookie,
    body: { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: TURN_SECRET },
  });
  assert.equal(updated.status, 200);

  const fixture = await createFixture(base, 'logs');
  const ice = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(ice.status, 200);

  const allLogs = [...logMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
    .map((call) => call.arguments.map((value: unknown) => String(value)).join(' '))
    .join('\n');
  assert.ok(allLogs.length > 0, 'the server did log something (sanity check)');
  assert.ok(!allLogs.includes(TURN_SECRET), 'secret must never appear in logs');
  assert.ok(!allLogs.includes(ADMIN_PASSWORD), 'admin password must never appear in logs');
});

