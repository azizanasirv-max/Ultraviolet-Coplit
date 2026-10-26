/**
 * End-to-end admin page + ExpressTURN delivery tests.
 *
 * The admin page is protected by ADMIN_PASSWORD (the only server setting this
 * feature needs). TURN credentials are entered in the page, kept in process
 * memory, and delivered only through the session-authenticated ICE endpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototype2Server } from '../server';
import { ADMIN_COOKIE_NAME } from '../server/admin';
import { clearExpressTurnCredentials } from '../server/expressTurn';

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const TURN_USERNAME = 'expressturn-username-do-not-leak';
const TURN_PASSWORD = 'expressturn-password-do-not-leak';
const TURN_ADDRESS = 'turn:free.expressturn.com:3478';
const ENV_KEYS = [
  'ADMIN_PASSWORD',
  'SETTINGS_STORE_PATH',
  'SETTINGS_ENCRYPTION_KEY',
  'ADMIN_SETUP_TOKEN',
  'ADMIN_SETUP_TOKEN_FILE',
  'RSTREAM_AUTHENTICATION_TOKEN',
  'RSTREAM_PROJECT_ENDPOINT',
  'RSTREAM_PROJECT_ID',
  'TURN_CREDENTIALS_URL',
  'TURN_URLS',
  'TURN_USERNAME',
  'TURN_CREDENTIAL',
  'TURN_SECRET',
  'ICE_TRANSPORT_POLICY',
] as const;

const snapshotEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = (saved: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const clearTestEnv = (): void => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ICE_TRANSPORT_POLICY = 'all';
  clearExpressTurnCredentials();
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

const startServer = async () =>
  createPrototype2Server({
    serveFrontend: false,
    port: 0,
    turnFetch: (async () => {
      throw new Error('ExpressTURN credentials are static and never fetched');
    }) as unknown as typeof fetch,
  });

const login = async (base: string) => {
  const response = await jsonRequest(base, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE_NAME}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  return setCookie.split(';')[0];
};


test('the admin page is disabled without ADMIN_PASSWORD', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearExpressTurnCredentials();
  });

  const page = await fetchText(base, '/admin/turn');
  assert.equal(page.status, 503);
  assert.match(page.text, /ADMIN_PASSWORD/);
  assert.ok(!page.text.includes(TURN_PASSWORD));

  assert.equal((await jsonRequest(base, 'GET', '/api/admin/turn-settings')).status, 503);
  assert.equal(
    (await jsonRequest(base, 'PUT', '/api/admin/turn-settings', { body: { serverAddress: TURN_ADDRESS } }))
      .status,
    503
  );
  assert.equal((await jsonRequest(base, 'POST', '/api/admin/login', { body: { password: '' } })).status, 503);
});

test('admin login, credential save/replace, and memory-only status', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearExpressTurnCredentials();
  });

  await t.test('shows an empty login form and rejects wrong credentials', async () => {
    const page = await fetchText(base, '/admin/turn');
    assert.equal(page.status, 200);
    assert.match(page.text, /Sign in/);
    assert.ok(!page.text.includes(TURN_USERNAME));
    assert.ok(!page.text.includes(TURN_PASSWORD));
    assert.ok(!page.text.includes(ADMIN_PASSWORD));
    assert.ok(!/Secret Key/i.test(page.text));

    const wrong = await jsonRequest(base, 'POST', '/api/admin/login', { body: { password: 'nope' } });
    assert.equal(wrong.status, 401);

    const crossOrigin = await jsonRequest(base, 'POST', '/api/admin/login', {
      origin: 'https://evil.example',
      body: { password: ADMIN_PASSWORD },
    });
    assert.equal(crossOrigin.status, 403);
  });

  const cookie = await login(base);

  await t.test('never returns credentials in status, page or health', async () => {
    const initial = await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, {
      configured: false,
      urlCount: 0,
      updatedAt: null,
      storage: 'memory',
    });

    const settingsPage = await fetchText(base, '/admin/turn', cookie);
    assert.equal(settingsPage.status, 200);
    assert.match(settingsPage.text, /not configured/);
    assert.ok(!settingsPage.text.includes(TURN_USERNAME));
    assert.ok(!settingsPage.text.includes(TURN_PASSWORD));

    const health = await jsonRequest(base, 'GET', '/api/health');
    assert.ok(!JSON.stringify(health.body).includes(TURN_USERNAME));
    assert.ok(!JSON.stringify(health.body).includes(TURN_PASSWORD));
  });

  await t.test('requires the admin session and same-origin writes', async () => {
    assert.equal((await jsonRequest(base, 'GET', '/api/admin/turn-settings')).status, 401);
    assert.equal(
      (
        await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
          body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD },
        })
      ).status,
      401
    );
    const crossOrigin = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      origin: 'https://evil.example',
      body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD },
    });
    assert.equal(crossOrigin.status, 403);
  });

  await t.test('rejects invalid values without echoing them', async () => {
    const invalid = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: { serverAddress: 'https://free.expressturn.com', username: TURN_USERNAME, password: TURN_PASSWORD },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'INVALID_TURN_CREDENTIALS');
    assert.ok(!JSON.stringify(invalid.body).includes(TURN_PASSWORD));
    assert.ok(!JSON.stringify(invalid.body).includes(TURN_USERNAME));

    const missingPassword = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: '' },
    });
    assert.equal(missingPassword.status, 400);
    assert.equal((await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie })).body.configured, false);
  });

  await t.test('saves the credentials and never returns them', async () => {
    const updated = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.ok, true);
    assert.equal(updated.body.settings.configured, true);
    assert.equal(updated.body.settings.urlCount, 1);
    assert.equal(updated.body.settings.storage, 'memory');
    const serialized = JSON.stringify(updated.body);
    assert.ok(!serialized.includes(TURN_USERNAME));
    assert.ok(!serialized.includes(TURN_PASSWORD));
    assert.ok(!serialized.includes('free.expressturn.com'));

    const settingsPage = await fetchText(base, '/admin/turn', cookie);
    assert.match(settingsPage.text, /<dd>configured<\/dd>/);
    assert.ok(!settingsPage.text.includes(TURN_USERNAME));
    assert.ok(!settingsPage.text.includes(TURN_PASSWORD));
  });

  await t.test('replaces the credentials with newly entered values', async () => {
    const replaced = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      cookie,
      body: {
        serverAddress: 'turn:free.expressturn.com:3480?transport=tcp',
        username: 'second-user',
        password: 'second-password',
      },
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.settings.urlCount, 1);
    assert.ok(!JSON.stringify(replaced.body).includes('second-user'));

    const fixture = await createFixture(base, 'replaced');
    const response = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
      headers: { Authorization: `Bearer ${fixture.salespersonKey}` },
    });
    assert.equal(response.status, 200);
    const config = (await response.json()) as any;
    const turnEntry = config.iceServers.find((entry: any) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
    );
    assert.equal(turnEntry.username, 'second-user');
    assert.equal(turnEntry.credential, 'second-password');
    assert.deepEqual(turnEntry.urls, ['turn:free.expressturn.com:3480?transport=tcp']);
  });

  await t.test('signs out by clearing the session cookie', async () => {
    const logout = await jsonRequest(base, 'POST', '/api/admin/logout', { cookie });
    assert.equal(logout.status, 200);
    const cleared = logout.headers.get('set-cookie') || '';
    assert.match(cleared, new RegExp(`^${ADMIN_COOKIE_NAME}=;`));
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  });
});

test('ICE configuration reaches only the two authorized session participants', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearExpressTurnCredentials();
  });

  const cookie = await login(base);
  const savedCredentials = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    cookie,
    body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD },
  });
  assert.equal(savedCredentials.status, 200);

  const fixture = await createFixture(base, 'role-isolation');
  const other = await createFixture(base, 'other-session');

  const sales = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.salespersonKey}` },
  });
  assert.equal(sales.status, 200);
  const salesConfig = (await sales.json()) as any;
  assert.equal(salesConfig.turn.provider, 'expressturn');
  assert.equal(salesConfig.turn.credentialMode, 'static');
  assert.equal(salesConfig.turn.expiresAt, null);
  assert.equal(salesConfig.turn.configured, true);

  const customer = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(customer.status, 200);
  const customerConfig = (await customer.json()) as any;

  const pickTurn = (config: any) =>
    config.iceServers.find((entry: any) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
    );
  const salesTurn = pickTurn(salesConfig);
  const customerTurn = pickTurn(customerConfig);
  assert.deepEqual(salesTurn, {
    urls: [TURN_ADDRESS],
    username: TURN_USERNAME,
    credential: TURN_PASSWORD,
  });
  assert.deepEqual(customerTurn, salesTurn);

  // Anonymous, cross-session and unrelated credentials are rejected.
  assert.equal((await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
        headers: { Authorization: `Bearer ${other.salespersonKey}` },
      })
    ).status,
    401
  );
  assert.equal(
    (
      await fetch(`${base}/api/sessions/${other.sessionId}/ice-config`, {
        headers: { Authorization: `Bearer ${fixture.customerKey}` },
      })
    ).status,
    401
  );

  // /api/health stays credential-free.
  const health = await jsonRequest(base, 'GET', '/api/health');
  assert.ok(!JSON.stringify(health.body).includes(TURN_USERNAME));
  assert.ok(!JSON.stringify(health.body).includes(TURN_PASSWORD));
});

test('credentials, admin password and requests never reach the logs', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

  const logMock = t.mock.method(console, 'log');
  const warnMock = t.mock.method(console, 'warn');
  const errorMock = t.mock.method(console, 'error');

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearExpressTurnCredentials();
  });

  const cookie = await login(base);
  const save = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    cookie,
    body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD },
  });
  assert.equal(save.status, 200);

  const fixture = await createFixture(base, 'logs');
  const ice = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(ice.status, 200);

  const allLogs = [...logMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
    .map((call) => call.arguments.map((value: unknown) => String(value)).join(' '))
    .join('\n');
  assert.ok(allLogs.length > 0, 'the server did log something (sanity check)');
  assert.ok(!allLogs.includes(ADMIN_PASSWORD), 'admin password must never be logged');
  assert.ok(!allLogs.includes(TURN_USERNAME), 'TURN username must never be logged');
  assert.ok(!allLogs.includes(TURN_PASSWORD), 'TURN password must never be logged');
  assert.ok(!allLogs.includes('free.expressturn.com'), 'TURN URL must never be logged');
});
