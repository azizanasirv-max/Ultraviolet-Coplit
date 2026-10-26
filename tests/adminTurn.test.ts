/**
 * End-to-end admin setup + ExpressTURN delivery tests.
 *
 * No ADMIN_PASSWORD or SETTINGS_ENCRYPTION_KEY is set: the first admin is
 * bootstrapped with the one-time token file on the server filesystem, the
 * encryption key is generated on disk, and settings/password survive a restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createPrototype2Server } from '../server';
import { ADMIN_COOKIE_NAME } from '../server/admin';
import { clearTurnSettingsCache } from '../server/turnSettingsStore';

const PASSWORD = 'correct-horse-battery-staple';
const TURN_SECRET = 'admin-flow-expressturn-secret';
const ENV_KEYS = [
  'ADMIN_PASSWORD',
  'SETTINGS_ENCRYPTION_KEY',
  'SETTINGS_STORE_PATH',
  'SETTINGS_PERSISTENT_STORAGE',
  'ADMIN_SETUP_TOKEN',
  'ADMIN_SETUP_TOKEN_FILE',
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

const clearTestEnv = (storePath: string): void => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SETTINGS_STORE_PATH = storePath;
  process.env.ICE_TRANSPORT_POLICY = 'all';
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

const startServer = async () => {
  const instance = await createPrototype2Server({
    serveFrontend: false,
    port: 0,
    turnFetch: (async () => {
      throw new Error('ExpressTURN credentials are generated locally');
    }) as unknown as typeof fetch,
  });
  return { base: `http://127.0.0.1:${instance.port}`, close: instance.close };
};

test('first-run token setup, encrypted settings, and restart persistence without env secrets', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-'));
  const storePath = path.join(dir, 'settings.enc');
  const saved = snapshotEnv();
  clearTestEnv(storePath);
  clearTurnSettingsCache();

  let server = await startServer();
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  const tokenPath = path.join(dir, 'admin-setup-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  assert.ok(token.length >= 32);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(dir, 'settings.key'))).mode & 0o777, 0o600);

  let cookie = '';

  await t.test('shows the setup form with the token path (never the token)', async () => {
    const page = await fetchText(server.base, '/admin/turn');
    assert.equal(page.status, 200);
    assert.match(page.text, /First-time setup/);
    assert.match(page.text, /admin-setup-token/);
    assert.ok(!page.text.includes(token), 'token must never be rendered');
    assert.ok(!page.text.includes(PASSWORD));
    assert.equal((await jsonRequest(server.base, 'GET', '/api/admin/turn-settings')).status, 401);
  });

  await t.test('rejects a wrong token or weak password, then sets the password', async () => {
    const wrong = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
      body: { token: 'not-the-right-token-value', password: PASSWORD, confirmPassword: PASSWORD },
    });
    assert.equal(wrong.status, 401);

    const weak = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
      body: { token, password: 'short', confirmPassword: 'short' },
    });
    assert.equal(weak.status, 400);

    const mismatch = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
      body: { token, password: PASSWORD, confirmPassword: 'a-different-password' },
    });
    assert.equal(mismatch.status, 400);

    const ok = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
      body: { token, password: PASSWORD, confirmPassword: PASSWORD },
    });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    cookie = setCookie.split(';')[0];

    // The bootstrap token is deleted and cannot be reused.
    await assert.rejects(readFile(tokenPath, 'utf8'));
    const reuse = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
      body: { token, password: PASSWORD, confirmPassword: PASSWORD },
    });
    assert.equal(reuse.status, 409);
  });


  await t.test('saves ExpressTURN settings encrypted and never returns the secret', async () => {
    const initial = await jsonRequest(server.base, 'GET', '/api/admin/turn-settings', { cookie });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.adminConfigured, true);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.keySource, 'key-file');
    assert.ok(!('secretKey' in initial.body));

    const crossOrigin = await jsonRequest(server.base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      origin: 'https://evil.example',
      body: { host: 'turn.expressturn.com', port: 3478, secretKey: TURN_SECRET },
    });
    assert.equal(crossOrigin.status, 403);

    const updated = await jsonRequest(server.base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: TURN_SECRET },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.settings.configured, true);
    assert.ok(!JSON.stringify(updated.body).includes(TURN_SECRET));

    const raw = await readFile(storePath, 'utf8');
    assert.ok(!raw.includes(TURN_SECRET), 'secret is encrypted on disk');
    assert.ok(!raw.includes('turn.expressturn.com'));
    assert.ok(!raw.includes(PASSWORD));

    const page = await fetchText(server.base, '/admin/turn', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /turn\.expressturn\.com/);
    assert.ok(!page.text.includes(TURN_SECRET));
    assert.ok(!page.text.includes(PASSWORD));
  });

  await t.test('issues ExpressTURN credentials to both roles and survives a restart', async () => {
    const fixture = await createFixture(server.base, 'expressturn');
    const icePath = `/api/sessions/${fixture.sessionId}/ice-config`;

    assert.equal((await jsonRequest(server.base, 'GET', icePath)).status, 401);
    const other = await createFixture(server.base, 'other');
    const crossSession = await fetch(`${server.base}${icePath}`, {
      headers: { Authorization: `Bearer ${other.customerKey}` },
    });
    assert.equal(crossSession.status, 401);

    for (const key of [fixture.salespersonKey, fixture.customerKey]) {
      const response = await fetch(`${server.base}${icePath}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.turn.provider, 'expressturn');
      assert.equal(body.turn.credentialMode, 'ephemeral');
      const entry = body.iceServers.find((server_: any) =>
        (Array.isArray(server_.urls) ? server_.urls : [server_.urls]).some((url: string) =>
          url.startsWith('turn')
        )
      );
      assert.equal(entry.credential, hmacCredential(entry.username));
      assert.ok(!JSON.stringify(body).includes(TURN_SECRET));
    }

    const health = JSON.stringify((await jsonRequest(server.base, 'GET', '/api/health')).body);
    assert.ok(!health.includes(TURN_SECRET));
    assert.ok(!health.includes('turn.expressturn.com'));

    // Restart: new process-style state, same persistent files.
    await server.close();
    clearTurnSettingsCache();
    server = await startServer();

    const login = await jsonRequest(server.base, 'POST', '/api/admin/login', {
      body: { password: PASSWORD },
    });
    assert.equal(login.status, 200);
    const restartedCookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const status = await jsonRequest(server.base, 'GET', '/api/admin/turn-settings', {
      cookie: restartedCookie,
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, true);
    assert.equal(status.body.adminConfigured, true);

    const restartedFixture = await createFixture(server.base, 'after-restart');
    const restartedIce = await fetch(
      `${server.base}/api/sessions/${restartedFixture.sessionId}/ice-config`,
      { headers: { Authorization: `Bearer ${restartedFixture.customerKey}` } }
    );
    assert.equal(restartedIce.status, 200);
    const restartedBody = (await restartedIce.json()) as any;
    assert.equal(restartedBody.turn.provider, 'expressturn');
    assert.ok(!JSON.stringify(restartedBody).includes(TURN_SECRET));
  });
});


test('supports an operator-provided token file (Render secret file) instead of a generated token', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-secretfile-'));
  const tokenPath = path.join(dir, 'operator-token');
  const token = randomBytes(24).toString('base64url');
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });

  const saved = snapshotEnv();
  clearTestEnv(path.join(dir, 'settings.enc'));
  process.env.ADMIN_SETUP_TOKEN_FILE = tokenPath;
  clearTurnSettingsCache();

  const server = await startServer();
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  const page = await fetchText(server.base, '/admin/turn');
  assert.equal(page.status, 200);
  assert.match(page.text, /First-time setup/);
  assert.match(page.text, /operator-token/);
  assert.ok(!page.text.includes(token));

  // No second, auto-generated token should be created in the store directory.
  await assert.rejects(readFile(path.join(dir, 'admin-setup-token'), 'utf8'));

  const setup = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
    body: { token, password: PASSWORD, confirmPassword: PASSWORD },
  });
  assert.equal(setup.status, 200);

  // The operator-provided token file is not deleted by the app.
  assert.match(await readFile(tokenPath, 'utf8'), new RegExp(token));
});

test('the setup token, admin password and ExpressTURN secret never reach logs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-logs-'));
  const saved = snapshotEnv();
  clearTestEnv(path.join(dir, 'settings.enc'));
  clearTurnSettingsCache();

  const logMock = t.mock.method(console, 'log');
  const warnMock = t.mock.method(console, 'warn');
  const errorMock = t.mock.method(console, 'error');

  const server = await startServer();
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  const token = (await readFile(path.join(dir, 'admin-setup-token'), 'utf8')).trim();
  const setup = await jsonRequest(server.base, 'POST', '/api/admin/setup', {
    body: { token, password: PASSWORD, confirmPassword: PASSWORD },
  });
  assert.equal(setup.status, 200);
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];

  const savedSettings = await jsonRequest(server.base, 'PUT', '/api/admin/turn-settings', {
    cookie,
    body: { host: 'turn.expressturn.com', port: 3478, ttlSeconds: 600, secretKey: TURN_SECRET },
  });
  assert.equal(savedSettings.status, 200);

  const fixture = await createFixture(server.base, 'logs');
  const ice = await fetch(`${server.base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(ice.status, 200);

  const allLogs = [...logMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
    .map((call) => call.arguments.map((value: unknown) => String(value)).join(' '))
    .join('\n');
  assert.ok(allLogs.length > 0, 'the server did log something (sanity check)');
  assert.ok(!allLogs.includes(token), 'setup token must never be logged');
  assert.ok(!allLogs.includes(PASSWORD), 'admin password must never be logged');
  assert.ok(!allLogs.includes(TURN_SECRET), 'ExpressTURN secret must never be logged');
});

test('a corrupt encrypted store degrades safely and never exposes ciphertext', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uv-admin-corrupt-'));
  const storePath = path.join(dir, 'settings.enc');
  await writeFile(
    storePath,
    JSON.stringify({ v: 2, alg: 'aes-256-gcm', iv: 'AAAA', tag: 'BBBB', data: 'CCCC' })
  );

  const saved = snapshotEnv();
  clearTestEnv(storePath);
  clearTurnSettingsCache();

  const server = await startServer();
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTurnSettingsCache();
    await rm(dir, { recursive: true, force: true });
  });

  const page = await fetchText(server.base, '/admin/turn');
  assert.equal(page.status, 503);
  assert.match(page.text, /could not be decrypted/i);
  assert.ok(!page.text.includes('CCCC'));

  const fixture = await createFixture(server.base, 'corrupt-store');
  const response = await fetch(`${server.base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.hasTurn, false);
  assert.ok(body.errors.some((error: string) => /could not be decrypted/i.test(error)));
  assert.ok(!JSON.stringify(body).includes('CCCC'));
});

