/**
 * End-to-end setup page + ExpressTURN delivery tests.
 *
 * The flow under test deliberately needs no hosting environment variable:
 *   - first visit creates a setup password in the browser (scrypt-hashed);
 *   - later changes need that password, a signed HttpOnly session cookie and a
 *     per-session CSRF token;
 *   - TURN credentials are kept in process memory and are delivered only via the
 *     session-authenticated ICE endpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototype2Server } from '../server';
import { ADMIN_COOKIE_NAME, resetAdminAuthStateForTests } from '../server/admin';
import { clearExpressTurnCredentials, getExpressTurnStatus } from '../server/expressTurn';

const SETUP_PASSWORD = 'ExpressTURN-Setup-2026!';
const SECOND_SETUP_PASSWORD = 'Fresh-Setup-Password-2026#';
const WRONG_PASSWORD = 'wrong-password-123';
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

/** Simulates a fresh process for each test file run (memory-only state). */
const clearTestEnv = (): void => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ICE_TRANSPORT_POLICY = 'all';
  clearExpressTurnCredentials();
  resetAdminAuthStateForTests();
};

interface RequestOptions {
  body?: unknown;
  cookie?: string;
  origin?: string;
  csrf?: string;
  contentType?: string | null;
}

const jsonRequest = async (
  base: string,
  method: string,
  route: string,
  options: RequestOptions = {}
) => {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
    if (contentType) headers['Content-Type'] = contentType;
  }
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin) headers.Origin = options.origin;
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf;

  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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

interface AdminSession {
  cookie: string;
  csrf: string;
}

const readSessionCookie = (response: { status: number; headers: Headers }, expectedStatus = 200): string => {
  assert.equal(response.status, expectedStatus);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE_NAME}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  return setCookie.split(';')[0];
};

/** Completes first-run setup and returns the resulting authenticated session. */
const claimSetup = async (
  base: string,
  password = SETUP_PASSWORD
): Promise<AdminSession> => {
  const response = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    body: { password },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.setup.claimed, true);
  assert.ok(!JSON.stringify(response.body).includes(password), 'setup password must not be echoed');
  return { cookie: readSessionCookie(response, 201), csrf: response.body.csrfToken as string };
};

const signIn = async (base: string, password = SETUP_PASSWORD): Promise<AdminSession> => {
  const response = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password },
  });
  assert.equal(response.status, 200);
  return { cookie: readSessionCookie(response), csrf: response.body.csrfToken as string };
};

const saveCredentials = async (
  base: string,
  session: AdminSession,
  overrides: Record<string, unknown> = {}
) =>
  jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    origin: base,
    cookie: session.cookie,
    csrf: session.csrf,
    body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD, ...overrides },
  });

const pageModeText = (text: string): string => {
  if (/First-time setup/.test(text)) return 'setup';
  if (/<h2>Sign in<\/h2>/.test(text)) return 'login';
  if (/ExpressTURN credentials/.test(text)) return 'settings';
  return 'unknown';
};

test('first-time setup needs no ADMIN_PASSWORD and rejects weak passwords', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  // Even if an old deployment still has ADMIN_PASSWORD, it must not gate or
  // authenticate the new flow.
  process.env.ADMIN_PASSWORD = 'ignored-render-env-password';

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const page = await fetchText(base, '/admin/turn');
  assert.equal(page.status, 200);
  assert.equal(pageModeText(page.text), 'setup');
  assert.match(page.text, /Create setup password/);
  assert.ok(!page.text.includes('ADMIN_PASSWORD'), 'the page must not require an env var');
  assert.ok(!page.text.includes(SETUP_PASSWORD));
  assert.ok(!page.text.includes(TURN_USERNAME));
  assert.ok(!page.text.includes(TURN_PASSWORD));

  // No session: every settings route is unauthorized, including delete.
  assert.equal((await jsonRequest(base, 'GET', '/api/admin/turn-settings')).status, 401);
  assert.equal(
    (await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
      origin: base,
      body: { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD },
    })).status,
    401
  );
  assert.equal(
    (await jsonRequest(base, 'DELETE', '/api/admin/turn-settings', { origin: base })).status,
    401
  );

  // A legacy env password cannot log in before setup exists.
  const envLogin = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password: 'ignored-render-env-password' },
  });
  assert.equal(envLogin.status, 409);
  assert.equal(envLogin.body.error, 'SETUP_REQUIRED');

  const short = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    body: { password: 'short' },
  });
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'PASSWORD_TOO_SHORT');

  const weak = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    body: { password: 'alllowercaseonly' },
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, 'PASSWORD_TOO_WEAK');

  // Weak attempts did not claim setup.
  assert.equal(pageModeText((await fetchText(base, '/admin/turn')).text), 'setup');

  const session = await claimSetup(base);
  assert.ok(session.cookie.startsWith(`${ADMIN_COOKIE_NAME}=`));
  assert.ok(session.csrf.length >= 16);
  assert.ok(!JSON.stringify(session).includes(SETUP_PASSWORD));

  const settingsPage = await fetchText(base, '/admin/turn', session.cookie);
  assert.equal(settingsPage.status, 200);
  assert.equal(pageModeText(settingsPage.text), 'settings');
  assert.match(settingsPage.text, /not configured/);
  assert.ok(!settingsPage.text.includes(SETUP_PASSWORD));
  assert.ok(!settingsPage.text.includes(TURN_USERNAME));
  assert.ok(!settingsPage.text.includes(TURN_PASSWORD));

  // Setup is closed as soon as it is claimed.
  const takeover = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    body: { password: SECOND_SETUP_PASSWORD },
  });
  assert.equal(takeover.status, 409);
  assert.equal(takeover.body.error, 'SETUP_ALREADY_CLAIMED');
  assert.equal(pageModeText((await fetchText(base, '/admin/turn')).text), 'login');
});

test('setup takeover is prevented once claimed or configured', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const session = await claimSetup(base);
  assert.equal((await saveCredentials(base, session)).status, 200);
  assert.equal(getExpressTurnStatus().configured, true);

  // Anonymous visitors get the sign-in form, never first-time setup.
  assert.equal(pageModeText((await fetchText(base, '/admin/turn')).text), 'login');

  // Re-claiming is rejected with or without the current session.
  const anonymousTakeover = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    body: { password: SECOND_SETUP_PASSWORD },
  });
  assert.equal(anonymousTakeover.status, 409);
  assert.equal(anonymousTakeover.body.error, 'SETUP_ALREADY_CLAIMED');

  const authenticatedTakeover = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    cookie: session.cookie,
    body: { password: SECOND_SETUP_PASSWORD },
  });
  assert.equal(authenticatedTakeover.status, 409);

  // The attempted takeover changed nothing: old password still works, new one
  // does not, and the saved credentials are still configured.
  const oldPassword = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password: SETUP_PASSWORD },
  });
  assert.equal(oldPassword.status, 200);

  const newPassword = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password: SECOND_SETUP_PASSWORD },
  });
  assert.equal(newPassword.status, 401);
  assert.equal(newPassword.body.error, 'INVALID_SETUP_PASSWORD');
  assert.equal(getExpressTurnStatus().configured, true);

  const page = await fetchText(base, '/admin/turn');
  assert.ok(!page.text.includes(SECOND_SETUP_PASSWORD));
  assert.ok(!page.text.includes(TURN_USERNAME));
  assert.ok(!page.text.includes(TURN_PASSWORD));
});

test('login accepts the correct setup password and rejects the rest', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  await claimSetup(base);

  const wrong = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password: WRONG_PASSWORD },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'INVALID_SETUP_PASSWORD');
  assert.ok(!JSON.stringify(wrong.body).includes(SETUP_PASSWORD));

  const missing = await jsonRequest(base, 'POST', '/api/admin/login', { origin: base, body: {} });
  assert.equal(missing.status, 401);

  const session = await signIn(base);
  const status = await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie: session.cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.setup.claimed, true);
  assert.equal(status.body.csrfToken, session.csrf);
  assert.ok(!JSON.stringify(status.body).includes(SETUP_PASSWORD));

  // Each successful sign-in issues a fresh CSRF token.
  const secondSession = await signIn(base);
  assert.notEqual(secondSession.csrf, session.csrf);
});

test('first-time setup attempts are rate limited', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await jsonRequest(base, 'POST', '/api/admin/setup', {
      origin: base,
      body: { password: 'short' },
    });
    assert.equal(response.status, 400, `attempt ${attempt} should reach validation`);
  }

  const limited = await jsonRequest(base, 'POST', '/api/admin/setup', {
    origin: base,
    body: { password: SETUP_PASSWORD },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'TOO_MANY_ATTEMPTS');
  // Even a correct password is refused while the bucket is exhausted.
  assert.equal(pageModeText((await fetchText(base, '/admin/turn')).text), 'setup');
});

test('login attempts are rate limited', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  await claimSetup(base);

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await jsonRequest(base, 'POST', '/api/admin/login', {
      origin: base,
      body: { password: WRONG_PASSWORD },
    });
    assert.equal(response.status, 401, `attempt ${attempt} should reach password verification`);
  }

  const limited = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password: SETUP_PASSWORD },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'TOO_MANY_ATTEMPTS');
});

test('mutations require same-origin, JSON and the per-session CSRF token', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const session = await claimSetup(base);
  const body = { serverAddress: TURN_ADDRESS, username: TURN_USERNAME, password: TURN_PASSWORD };

  const noCsrf = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    origin: base,
    cookie: session.cookie,
    body,
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, 'CSRF_TOKEN_INVALID');

  const badCsrf = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    origin: base,
    cookie: session.cookie,
    csrf: 'not-the-token',
    body,
  });
  assert.equal(badCsrf.status, 403);

  const crossOrigin = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    origin: 'https://evil.example',
    cookie: session.cookie,
    csrf: session.csrf,
    body,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error, 'BAD_ORIGIN');

  // No Origin/Referer at all is rejected too: a mutation must prove its origin.
  const noOrigin = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    cookie: session.cookie,
    csrf: session.csrf,
    body,
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error, 'BAD_ORIGIN');

  const wrongContentType = await jsonRequest(base, 'PUT', '/api/admin/turn-settings', {
    origin: base,
    cookie: session.cookie,
    csrf: session.csrf,
    contentType: 'text/plain',
    body,
  });
  assert.equal(wrongContentType.status, 415);

  const crossOriginLogin = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: 'https://evil.example',
    body: { password: SETUP_PASSWORD },
  });
  assert.equal(crossOriginLogin.status, 403);

  assert.equal(getExpressTurnStatus().configured, false, 'rejected writes must not store credentials');

  const savedCredentials = await saveCredentials(base, session);
  assert.equal(savedCredentials.status, 200);
  assert.equal(savedCredentials.body.settings.configured, true);

  const deleteWithoutCsrf = await jsonRequest(base, 'DELETE', '/api/admin/turn-settings', {
    origin: base,
    cookie: session.cookie,
  });
  assert.equal(deleteWithoutCsrf.status, 403);
  assert.equal(getExpressTurnStatus().configured, true);

  const deleted = await jsonRequest(base, 'DELETE', '/api/admin/turn-settings', {
    origin: base,
    cookie: session.cookie,
    csrf: session.csrf,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.settings.configured, false);
  assert.equal(getExpressTurnStatus().configured, false);
});

test('credentials and the setup password never come back to the browser', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const session = await claimSetup(base);

  const initial = await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie: session.cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.configured, false);
  assert.equal(initial.body.urlCount, 0);
  assert.equal(initial.body.updatedAt, null);
  assert.equal(initial.body.storage, 'memory');
  assert.equal(initial.body.setup.claimed, true);
  assert.equal(initial.body.csrfToken, session.csrf);

  const save = await saveCredentials(base, session);
  assert.equal(save.status, 200);
  assert.equal(save.body.ok, true);
  assert.equal(save.body.settings.configured, true);
  assert.equal(save.body.settings.urlCount, 1);
  assert.equal(save.body.settings.storage, 'memory');

  const status = await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie: session.cookie });
  assert.equal(status.status, 200);
  const page = await fetchText(base, '/admin/turn', session.cookie);
  const health = await jsonRequest(base, 'GET', '/api/health');
  const payloads = [
    JSON.stringify(initial.body),
    JSON.stringify(save.body),
    JSON.stringify(status.body),
    page.text,
    JSON.stringify(health.body),
  ];
  for (const payload of payloads) {
    assert.ok(!payload.includes(SETUP_PASSWORD), 'setup password must never be returned');
    assert.ok(!payload.includes(TURN_USERNAME), 'TURN username must never be returned');
    assert.ok(!payload.includes(TURN_PASSWORD), 'TURN password must never be returned');
  }
  // The page keeps a generic example placeholder, so only API/health payloads
  // are checked for the configured URL itself.
  for (const payload of [
    JSON.stringify(initial.body),
    JSON.stringify(save.body),
    JSON.stringify(status.body),
    JSON.stringify(health.body),
  ]) {
    assert.ok(!payload.includes('free.expressturn.com'), 'TURN URL must never be returned');
  }
  assert.match(page.text, /<dd>configured<\/dd>/);
  assert.ok(!page.text.includes('scrypt$'), 'the password hash must never be rendered');

  // The server still has the real values for authorized ICE delivery.
  assert.equal(getExpressTurnStatus().configured, true);
});

test('ICE configuration reaches only the two authorized session participants', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const session = await claimSetup(base);
  assert.equal((await saveCredentials(base, session)).status, 200);

  const fixture = await createFixture(base, 'role-isolation');
  const other = await createFixture(base, 'other-session');

  const getIce = async (sessionId: string, credential?: string) =>
    fetch(`${base}/api/sessions/${sessionId}/ice-config`, {
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
    });

  const sales = await getIce(fixture.sessionId, fixture.salespersonKey);
  assert.equal(sales.status, 200);
  const salesConfig = (await sales.json()) as any;
  assert.equal(salesConfig.turn.provider, 'expressturn');
  assert.equal(salesConfig.turn.credentialMode, 'static');
  assert.equal(salesConfig.turn.expiresAt, null);
  assert.equal(salesConfig.turn.configured, true);

  const customer = await getIce(fixture.sessionId, fixture.customerKey);
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
  assert.equal((await getIce(fixture.sessionId)).status, 401);
  assert.equal((await getIce(fixture.sessionId, other.salespersonKey)).status, 401);
  assert.equal((await getIce(fixture.sessionId, other.customerKey)).status, 401);
  assert.equal((await getIce(other.sessionId, fixture.customerKey)).status, 401);

  const health = await jsonRequest(base, 'GET', '/api/health');
  assert.ok(!JSON.stringify(health.body).includes(TURN_USERNAME));
  assert.ok(!JSON.stringify(health.body).includes(TURN_PASSWORD));
});


test('a restart clears settings and setup can be safely reclaimed', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const firstSession = await claimSetup(base, SETUP_PASSWORD);
  assert.equal((await saveCredentials(base, firstSession)).status, 200);

  const fixture = await createFixture(base, 'before-restart');
  const before = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.salespersonKey}` },
  });
  assert.equal(before.status, 200);
  assert.equal(((await before.json()) as any).turn.configured, true);

  // Simulate a process restart: both in-memory stores vanish and the session
  // signing key rotates, exactly as a redeploy would do.
  resetAdminAuthStateForTests();
  clearExpressTurnCredentials();

  assert.equal(getExpressTurnStatus().configured, false);
  assert.equal(
    (await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie: firstSession.cookie })).status,
    401,
    'pre-restart sessions must not survive'
  );
  assert.equal(pageModeText((await fetchText(base, '/admin/turn')).text), 'setup');

  // The old TURN credentials are gone, not exposed: the call falls back to STUN.
  const after = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.salespersonKey}` },
  });
  assert.equal(after.status, 200);
  const afterConfig = (await after.json()) as any;
  assert.equal(afterConfig.turn.configured, false);
  assert.ok(
    !afterConfig.iceServers.some((entry: any) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
    ),
    'no old TURN entry may be served after the restart'
  );
  assert.ok(!JSON.stringify(afterConfig).includes(TURN_USERNAME));
  assert.ok(!JSON.stringify(afterConfig).includes(TURN_PASSWORD));

  // Safe reclaim: first-time setup is available again and requires a new
  // password. The old password no longer authenticates.
  const secondSession = await claimSetup(base, SECOND_SETUP_PASSWORD);
  const loginBeforeClaimWithOldPassword = await jsonRequest(base, 'POST', '/api/admin/login', {
    origin: base,
    body: { password: SETUP_PASSWORD },
  });
  // Setup is claimed again, so this is a real password check and must fail.
  assert.equal(loginBeforeClaimWithOldPassword.status, 401);

  const freshLogin = await signIn(base, SECOND_SETUP_PASSWORD);
  assert.ok(freshLogin.cookie.startsWith(`${ADMIN_COOKIE_NAME}=`));
  assert.equal(
    (await jsonRequest(base, 'GET', '/api/admin/turn-settings', { cookie: secondSession.cookie })).status,
    200
  );

  // Re-entering fresh ExpressTURN values restores relay delivery.
  const replaced = await saveCredentials(base, freshLogin, {
    username: 'reclaimed-turn-user',
    password: 'reclaimed-turn-password',
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.settings.configured, true);

  const restored = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  const restoredConfig = (await restored.json()) as any;
  const turnEntry = restoredConfig.iceServers.find((entry: any) =>
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url: string) => url.startsWith('turn'))
  );
  assert.equal(turnEntry.username, 'reclaimed-turn-user');
  assert.equal(turnEntry.credential, 'reclaimed-turn-password');
});

test('setup password and TURN credentials never reach the logs', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();

  const logMock = t.mock.method(console, 'log');
  const warnMock = t.mock.method(console, 'warn');
  const errorMock = t.mock.method(console, 'error');

  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  const session = await claimSetup(base);
  assert.equal((await saveCredentials(base, session)).status, 200);
  assert.equal(
    (await jsonRequest(base, 'POST', '/api/admin/login', {
      origin: base,
      body: { password: WRONG_PASSWORD },
    })).status,
    401
  );

  const fixture = await createFixture(base, 'logs');
  const ice = await fetch(`${base}/api/sessions/${fixture.sessionId}/ice-config`, {
    headers: { Authorization: `Bearer ${fixture.customerKey}` },
  });
  assert.equal(ice.status, 200);

  const allLogs = [...logMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
    .map((call) => call.arguments.map((value: unknown) => String(value)).join(' '))
    .join('\n');
  assert.ok(allLogs.length > 0, 'the server did log something (sanity check)');
  assert.ok(!allLogs.includes(SETUP_PASSWORD), 'setup password must never be logged');
  assert.ok(!allLogs.includes(WRONG_PASSWORD), 'failed attempts must never be logged');
  assert.ok(!allLogs.includes(TURN_USERNAME), 'TURN username must never be logged');
  assert.ok(!allLogs.includes(TURN_PASSWORD), 'TURN password must never be logged');
  assert.ok(!allLogs.includes('free.expressturn.com'), 'TURN URL must never be logged');
  assert.ok(!allLogs.includes('scrypt$'), 'the password hash must never be logged');


});

test('in-app admin status is public, safe and reflects setup and credentials', async (t) => {
  const saved = snapshotEnv();
  clearTestEnv();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    restoreEnv(saved);
    clearTestEnv();
  });

  // Unauthenticated: this is what the in-app Admin Settings panel reads first.
  const before = await jsonRequest(base, 'GET', '/api/admin/status');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.setup, { claimed: false, claimedAt: null });
  assert.equal(before.body.configured, false);
  assert.equal(before.body.urlCount, 0);
  assert.equal(before.body.updatedAt, null);
  assert.equal(before.body.storage, 'memory');
  assert.equal(before.body.csrfToken, undefined, 'status must not mint a session');
  assert.equal(before.headers.get('cache-control'), 'no-store');

  const session = await claimSetup(base);
  const afterSetup = await jsonRequest(base, 'GET', '/api/admin/status');
  assert.equal(afterSetup.status, 200);
  assert.equal(afterSetup.body.setup.claimed, true);
  assert.equal(typeof afterSetup.body.setup.claimedAt, 'number');
  assert.equal(afterSetup.body.configured, false);

  assert.equal((await saveCredentials(base, session)).status, 200);
  const afterSave = await jsonRequest(base, 'GET', '/api/admin/status');
  assert.equal(afterSave.status, 200);
  assert.equal(afterSave.body.configured, true);
  assert.equal(afterSave.body.urlCount, 1);
  assert.equal(typeof afterSave.body.updatedAt, 'number');

  // The public probe is a safe-status endpoint, exactly like the authenticated one.
  const serialized = JSON.stringify(afterSave.body);
  for (const secret of [TURN_USERNAME, TURN_PASSWORD, TURN_ADDRESS, SETUP_PASSWORD, session.csrf]) {
    assert.ok(!serialized.includes(secret), `public admin status leaked ${secret}`);
  }
});
