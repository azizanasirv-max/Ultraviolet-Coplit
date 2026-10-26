/**
 * Server-rendered admin page for the ExpressTURN settings.
 *
 * The page never receives the ExpressTURN secret, the admin password, the
 * encryption key or the one-time setup token. Setup mode shows only the *path*
 * of the bootstrap-token file (read it through Render Shell/SSH).
 */
import type { TurnSettingsStatus } from './turnSettingsStore';

export type AdminPageMode = 'setup' | 'login' | 'settings' | 'disabled';

export interface AdminPageOptions {
  mode: AdminPageMode;
  status: TurnSettingsStatus | null;
  /** Filesystem path of the one-time setup token; never the token itself. */
  setupTokenPath?: string | null;
  error?: string | null;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const pageStyles = `
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; }
  main { max-width: 660px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.1rem; margin: 0 0 1rem; }
  section { border: 1px solid #2a3441; border-radius: 12px; padding: 1.25rem; background: #111823; }
  label { display: block; font-size: .85rem; margin: 1rem 0 .35rem; color: #9fb0c3; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border-radius: 8px; border: 1px solid #33404f; background: #0b1118; color: inherit; font-size: 1rem; }
  button { margin-top: 1rem; padding: .6rem 1rem; border-radius: 8px; border: 0; background: #2f81f7; color: #fff; font-weight: 600; cursor: pointer; }
  button.secondary { background: #263241; }
  form#logout-form { margin: 0; }
  .muted { color: #9fb0c3; font-size: .85rem; }
  .ok { color: #3fb950; }
  .warn { color: #d29922; font-size: .9rem; }
  .err { color: #f85149; min-height: 1.2em; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 0 0 1rem; }
  dt { color: #9fb0c3; }
  dd { margin: 0; word-break: break-word; }
  code { font-size: .85em; }
`;

/**
 * Shared browser code. It never receives secrets from the server; the setup
 * token and new password are read from the form and posted once.
 */
const pageScript = `
(function () {
  var message = document.getElementById('message');
  var show = function (text, ok) {
    if (!message) return;
    message.textContent = text;
    message.className = ok ? 'ok' : 'err';
  };
  var readJson = function (response) {
    return response.json().catch(function () { return {}; });
  };
  var submit = function (formId, url, buildPayload, successText) {
    var form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(buildPayload())
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (response.ok) {
            if (successText) show(successText, true);
            window.location.reload();
            return;
          }
          show(body.message || 'Request failed.', false);
        });
      }).catch(function () { show('Request failed.', false); });
    });
  };
  submit('login-form', '/api/admin/login', function () {
    return { password: document.getElementById('password').value };
  }, '');
  submit('setup-form', '/api/admin/setup', function () {
    return {
      token: document.getElementById('setup-token').value,
      password: document.getElementById('new-password').value,
      confirmPassword: document.getElementById('confirm-password').value
    };
  }, '');
  var settings = document.getElementById('settings-form');
  if (settings) {
    settings.addEventListener('submit', function (event) {
      event.preventDefault();
      var payload = {
        host: document.getElementById('host').value,
        port: Number(document.getElementById('port').value),
        ttlSeconds: Number(document.getElementById('ttl').value)
      };
      var secret = document.getElementById('secret').value;
      if (secret) payload.secretKey = secret;
      fetch('/api/admin/turn-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) { show(body.message || 'Save failed.', false); return; }
          document.getElementById('secret').value = '';
          show('Saved. New ExpressTURN credentials will be issued on the next call.', true);
        });
      }).catch(function () { show('Save failed.', false); });
    });
  }
  var logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', function (event) {
      event.preventDefault();
      fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function () { window.location.reload(); })
        .catch(function () { window.location.reload(); });
    });
  }
})();
`;

export const renderAdminPage = ({
  mode,
  status,
  setupTokenPath,
  error,
}: AdminPageOptions): string => {
  const configured = Boolean(status?.configured);
  const host = escapeHtml(status?.host ?? '');
  const port = status?.port ?? 3478;
  const ttlSeconds = status?.ttlSeconds ?? 3600;
  const durability = status?.durable ?? 'assumed-ephemeral';
  const durabilityNote =
    durability === 'persistent-disk-mounted'
      ? '<p class="ok">Persistent volume detected. Settings, encryption key and admin password survive restarts.</p>'
      : `<p class="warn">This filesystem is ephemeral: the encrypted file at <code>${escapeHtml(
          status?.path ?? ''
        )}</code> and its key are lost on redeploy/restart. Attach a Render persistent disk (paid) and set <code>SETTINGS_STORE_PATH</code> to a path on it (for example <code>/var/data/uv-admin/settings.enc</code>).</p>`;
  const errorBlock = error ? `<p class="err">${escapeHtml(error)}</p>` : '';

  const setupSection = `
    <section>
      <h2>First-time setup</h2>
      <p class="muted">No admin password exists yet. A one-time setup token was written to the server filesystem. Read it through Render's Shell/SSH (or via a mounted secret file), then set your password below. The token is deleted after setup and is never shown in this page, logs or API responses.</p>
      <p>Token file: <code>${escapeHtml(setupTokenPath ?? 'not available')}</code></p>
      ${errorBlock}
      <form id="setup-form">
        <label for="setup-token">One-time setup token</label>
        <input id="setup-token" name="token" type="password" autocomplete="off" required minlength="16" />
        <label for="new-password">New admin password (min 12 characters)</label>
        <input id="new-password" name="password" type="password" autocomplete="new-password" required minlength="12" />
        <label for="confirm-password">Confirm password</label>
        <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" />
        <button type="submit">Set password and sign in</button>
      </form>
      <p id="message" class="err" role="status"></p>
    </section>`;

  const loginSection = `
    <section>
      <h2>Sign in</h2>
      ${errorBlock}
      <form id="login-form">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required minlength="12" />
        <button type="submit">Sign in</button>
      </form>
      <p id="message" class="err" role="status"></p>
    </section>`;

  const settingsSection = `
    <section>
      <h2>ExpressTURN settings</h2>
      <dl>
        <dt>Secret key</dt><dd>${configured ? 'configured (encrypted at rest)' : 'not configured'}</dd>
        <dt>Storage</dt><dd>${escapeHtml(status?.storage ?? 'encrypted-file')} / ${escapeHtml(status?.encryption ?? 'aes-256-gcm')}</dd>
        <dt>Encryption key</dt><dd>${escapeHtml(status?.keySource ?? 'unknown')}</dd>
        <dt>File</dt><dd><code>${escapeHtml(status?.path ?? '')}</code></dd>
        <dt>Last update</dt><dd>${status?.updatedAt ? new Date(status.updatedAt).toISOString() : '&mdash;'}</dd>
      </dl>
      ${durabilityNote}
      ${errorBlock}
      <form id="settings-form">
        <label for="host">TURN hostname</label>
        <input id="host" name="host" value="${host}" placeholder="free.expressturn.com" required />
        <label for="port">TURN port</label>
        <input id="port" name="port" type="number" min="1" max="65535" value="${port}" required />
        <label for="ttl">Credential TTL (seconds)</label>
        <input id="ttl" name="ttl" type="number" min="300" max="86400" value="${ttlSeconds}" required />
        <label for="secret">Secret key ${configured ? '(leave blank to keep the current key)' : ''}</label>
        <input id="secret" name="secret" type="password" autocomplete="new-password" ${configured ? '' : 'required'} />
        <p class="muted">Official scheme: username <code>&lt;expiry&gt;:&lt;user&gt;</code>, credential <code>base64(HMAC-SHA1(secret, username))</code>.</p>
        <button type="submit">Save settings</button>
      </form>
      <p id="message" class="err" role="status"></p>
      <form id="logout-form"><button type="submit" class="secondary">Sign out</button></form>
    </section>`;

  const disabledSection = `
    <section>
      <h2>Admin setup unavailable</h2>
      ${errorBlock || '<p class="err">The encrypted settings store is not usable.</p>'}
      <p class="muted">Provide a writable persistent volume, or a one-time token through ADMIN_SETUP_TOKEN / ADMIN_SETUP_TOKEN_FILE. No insecure fallback is enabled.</p>
    </section>`;

  const body =
    mode === 'setup'
      ? setupSection
      : mode === 'login'
        ? loginSection
        : mode === 'settings'
          ? settingsSection
          : disabledSection;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>ExpressTURN settings</title>
<style>${pageStyles}</style>
</head>
<body>
<main>
  <h1>ExpressTURN settings</h1>
  ${body}
</main>
<script>${pageScript}</script>
</body>
</html>`;
};

