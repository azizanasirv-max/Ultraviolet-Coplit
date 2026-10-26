/**
 * Server-rendered admin page for the ExpressTURN credentials.
 *
 * The page never receives the TURN username, the TURN password or the admin
 * password: forms are always rendered empty, and status is limited to
 * "configured / not configured" plus a timestamp. Credentials are typed by the
 * operator and posted once over the authenticated admin session.
 */
import type { ExpressTurnStatus } from './expressTurn';

export type AdminPageMode = 'login' | 'settings' | 'disabled';

export interface AdminPageOptions {
  mode: AdminPageMode;
  status: ExpressTurnStatus | null;
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
        return readJson(response).then(function (body) {
          if (response.ok) { window.location.reload(); return; }
          show(body.message || 'Sign in failed.', false);
        });
      }).catch(function () { show('Sign in failed.', false); });
    });
  }
  var settings = document.getElementById('settings-form');
  if (settings) {
    settings.addEventListener('submit', function (event) {
      event.preventDefault();
      var payload = {
        serverAddress: document.getElementById('server-address').value,
        username: document.getElementById('username').value,
        password: document.getElementById('turn-password').value
      };
      fetch('/api/admin/turn-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) { show(body.message || 'Save failed.', false); return; }
          document.getElementById('turn-password').value = '';
          document.getElementById('username').value = '';
          show('Saved. New calls will use these TURN credentials.', true);
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


export const renderAdminPage = ({ mode, status, error }: AdminPageOptions): string => {
  const configured = Boolean(status?.configured);
  const errorBlock = error ? `<p class="err">${escapeHtml(error)}</p>` : '';

  const loginSection = `
    <section>
      <h2>Sign in</h2>
      ${errorBlock}
      <form id="login-form">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>
      <p id="message" class="err" role="status"></p>
    </section>`;

  const settingsSection = `
    <section>
      <h2>ExpressTURN credentials</h2>
      <dl>
        <dt>Status</dt><dd>${configured ? 'configured' : 'not configured'}</dd>
        <dt>Storage</dt><dd>server memory (not persisted; lost on restart)</dd>
        <dt>URLs</dt><dd>${configured ? `${status?.urlCount ?? 0} configured` : '&mdash;'}</dd>
        <dt>Last update</dt><dd>${status?.updatedAt ? new Date(status.updatedAt).toISOString() : '&mdash;'}</dd>
      </dl>
      ${errorBlock}
      <form id="settings-form">
        <label for="server-address">TURN server URL / address</label>
        <input id="server-address" name="serverAddress" autocomplete="off" spellcheck="false" placeholder="turn:free.expressturn.com:3478" required />
        <label for="username">TURN username</label>
        <input id="username" name="username" autocomplete="off" spellcheck="false" required />
        <label for="turn-password">TURN password</label>
        <input id="turn-password" name="password" type="password" autocomplete="new-password" required />
        <p class="muted">Copy these three values from the ExpressTURN dashboard. They are used verbatim and never shown again after saving. Enter all three again to replace them.</p>
        <button type="submit">Save credentials</button>
      </form>
      <p id="message" class="err" role="status"></p>
      <form id="logout-form"><button type="submit" class="secondary">Sign out</button></form>
    </section>`;

  const disabledSection = `
    <section>
      <h2>Admin access disabled</h2>
      ${errorBlock || '<p class="err">ADMIN_PASSWORD is not set on the server.</p>'}
      <p class="muted">Set the <code>ADMIN_PASSWORD</code> environment variable in the hosting dashboard, then reload this page. No other Render environment variable, Shell access, persistent disk or database is required.</p>
    </section>`;

  const body =
    mode === 'login' ? loginSection : mode === 'settings' ? settingsSection : disabledSection;

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
