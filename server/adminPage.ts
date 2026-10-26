/**
 * Server-rendered admin page for the ExpressTURN settings.
 *
 * The page never receives the secret key: it only renders host/port/TTL and a
 * boolean "configured". The key is submitted once, over the same-origin admin
 * API, and is encrypted server-side.
 */
import type { TurnSettingsStatus } from './turnSettingsStore';

export interface AdminPageOptions {
  authenticated: boolean;
  adminError: string | null;
  status: TurnSettingsStatus | null;
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
  main { max-width: 640px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
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

export const renderAdminPage = ({ authenticated, adminError, status }: AdminPageOptions): string => {
  const configured = Boolean(status?.configured);
  const host = escapeHtml(status?.host ?? '');
  const port = status?.port ?? 3478;
  const ttlSeconds = status?.ttlSeconds ?? 3600;
  const statusError = status?.error ? `<p class="err">${escapeHtml(status.error)}</p>` : '';
  const durability = status?.durable ?? 'unknown';
  const durabilityNote =
    durability === 'persistent-disk-mounted'
      ? '<p class="ok">Persistent disk detected (SETTINGS_PERSISTENT_STORAGE=true).</p>'
      : '<p class="warn">Durability not confirmed. The encrypted file below survives restarts only when SETTINGS_STORE_PATH is on a mounted persistent disk. Otherwise the settings are lost on redeploy/restart and must be re-entered.</p>';

  const loginSection = `
    <section>
      <h2>Sign in</h2>
      <p class="muted">Operator access only. The password is verified on the server and exchanged for a short-lived HttpOnly session cookie.</p>
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
        <dt>File</dt><dd><code>${escapeHtml(status?.path ?? '')}</code></dd>
        <dt>Last update</dt><dd>${status?.updatedAt ? new Date(status.updatedAt).toISOString() : '&mdash;'}</dd>
      </dl>
      ${durabilityNote}
      ${statusError}
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
  ${adminError ? `<section><p class="err">${escapeHtml(adminError)}</p></section>` : ''}
  ${adminError ? '' : authenticated ? settingsSection : loginSection}
</main>
<script>
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
  var login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', function (event) {
      event.preventDefault();
      fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: document.getElementById('password').value })
      }).then(function (response) {
        if (response.ok) { window.location.reload(); return; }
        return readJson(response).then(function (body) { show(body.message || 'Sign-in failed.', false); });
      }).catch(function () { show('Sign-in failed.', false); });
    });
  }
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
</script>
</body>
</html>`;
};

