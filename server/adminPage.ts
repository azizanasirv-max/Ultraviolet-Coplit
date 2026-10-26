/**
 * Server-rendered page for ExpressTURN setup and credentials.
 *
 * First run: the operator creates a setup password. Later visits: the operator
 * signs in with that password. The page never receives the TURN username, TURN
 * password, setup password or setup-password hash: forms are always rendered
 * empty and status is limited to "configured / not configured" plus timestamps.
 *
 * The CSRF token is embedded in a meta tag for the authenticated settings view
 * only. It is tied to the signed HttpOnly session cookie and is required on
 * state-changing requests by the server.
 */
import type { AdminSetupStatus } from './admin';
import { ADMIN_SETUP_PASSWORD_MIN_LENGTH } from './admin';
import type { ExpressTurnStatus } from './expressTurn';

export type AdminPageMode = 'setup' | 'login' | 'settings';

export interface AdminPageOptions {
  mode: AdminPageMode;
  status: ExpressTurnStatus;
  setup: AdminSetupStatus;
  csrfToken?: string | null;
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
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 0 0 1rem; }
  section { border: 1px solid #2a3441; border-radius: 12px; padding: 1.25rem; background: #111823; margin-bottom: 1rem; }
  label { display: block; font-size: .85rem; margin: 1rem 0 .35rem; color: #9fb0c3; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border-radius: 8px; border: 1px solid #33404f; background: #0b1118; color: inherit; font-size: 1rem; }
  button { margin-top: 1rem; padding: .6rem 1rem; border-radius: 8px; border: 0; background: #2f81f7; color: #fff; font-weight: 600; cursor: pointer; }
  button.secondary { background: #263241; }
  button.danger { background: #8b1a1a; }
  form#logout-form, form#clear-form { display: inline-block; margin-right: .5rem; }
  .muted { color: #9fb0c3; font-size: .85rem; }
  .ok { color: #3fb950; }
  .warn { color: #d29922; font-size: .9rem; }
  .err { color: #f85149; min-height: 1.2em; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 0 0 1rem; }
  dt { color: #9fb0c3; }
  dd { margin: 0; word-break: break-word; }
  code { font-size: .85em; }
  .actions { margin-top: 1.5rem; }
`;

const pageScript = `
(function () {
  var message = document.getElementById('message');
  var show = function (text, ok) {
    if (!message) return;
    message.textContent = text;
    message.className = ok ? 'ok' : 'err';
  };
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';
  var readJson = function (response) {
    return response.json().catch(function () { return {}; });
  };
  var send = function (url, method, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf
      },
      body: body ? JSON.stringify(body) : undefined
    });
  };

  var setup = document.getElementById('setup-form');
  if (setup) {
    setup.addEventListener('submit', function (event) {
      event.preventDefault();
      var password = document.getElementById('setup-password').value;
      var confirm = document.getElementById('setup-password-confirm').value;
      if (password !== confirm) { show('The two passwords do not match.', false); return; }
      send('/api/admin/setup', 'POST', { password: password }).then(function (response) {
        return readJson(response).then(function (body) {
          if (response.ok) { window.location.reload(); return; }
          show(body.message || 'Setup failed.', false);
        });
      }).catch(function () { show('Setup failed.', false); });
    });
  }

  var login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', function (event) {
      event.preventDefault();
      send('/api/admin/login', 'POST', { password: document.getElementById('password').value })
        .then(function (response) {
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
      send('/api/admin/turn-settings', 'PUT', payload).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) { show(body.message || 'Save failed.', false); return; }
          document.getElementById('turn-password').value = '';
          document.getElementById('username').value = '';
          show('Saved. New calls will use these TURN credentials.', true);
        });
      }).catch(function () { show('Save failed.', false); });
    });
  }

  var clear = document.getElementById('clear-form');
  if (clear) {
    clear.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!window.confirm('Remove the in-memory TURN credentials? Calls will fall back to STUN/other providers.')) return;
      fetch('/api/admin/turn-settings', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrf }
      }).then(function (response) {
        if (response.ok) { window.location.reload(); return; }
        show('Could not remove the credentials.', false);
      }).catch(function () { show('Could not remove the credentials.', false); });
    });
  }

  var logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', function (event) {
      event.preventDefault();
      send('/api/admin/logout', 'POST').then(function () { window.location.reload(); })
        .catch(function () { window.location.reload(); });
    });
  }
})();
`;

const storageNotice = `
  <p class="warn">TURN credentials and the setup password live only in this server process's memory. A restart or redeploy clears both, so this page returns to first-time setup and you re-enter the ExpressTURN values. Nothing is written to disk, a database, Git or an environment variable.</p>`;

export const renderAdminPage = ({
  mode,
  status,
  setup,
  csrfToken,
  error,
}: AdminPageOptions): string => {
  const configured = Boolean(status?.configured);
  const errorBlock = error ? `<p class="err">${escapeHtml(error)}</p>` : '';

  const setupSection = `
    <section>
      <h2>First-time setup</h2>
      ${errorBlock}
      <p>No setup password exists yet, so you can create one now. It protects all
        later changes to the ExpressTURN credentials. There is no recovery email and
        no environment variable involved.</p>
      <form id="setup-form">
        <label for="setup-password">Create a setup password</label>
        <input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="${ADMIN_SETUP_PASSWORD_MIN_LENGTH}" required />
        <label for="setup-password-confirm">Confirm setup password</label>
        <input id="setup-password-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="${ADMIN_SETUP_PASSWORD_MIN_LENGTH}" required />
        <p class="muted">At least ${ADMIN_SETUP_PASSWORD_MIN_LENGTH} characters, using at least three of: lowercase, uppercase, numbers, symbols.</p>
        <button type="submit">Create setup password</button>
      </form>
      <p id="message" class="err" role="status"></p>
      ${storageNotice}
      <p class="warn">Until setup is claimed, the first visitor to this page can claim it. Complete this step immediately after a deploy or restart.</p>
    </section>`;

  const loginSection = `
    <section>
      <h2>Sign in</h2>
      ${errorBlock}
      <p>Setup has already been claimed on this server process. Enter the setup password you created. If this is a fresh deploy that you have not configured yet, this page would show first-time setup instead.</p>
      <form id="login-form">
        <label for="password">Setup password</label>
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
        <dt>Last update</dt><dd>${status?.updatedAt ? escapeHtml(new Date(status.updatedAt).toISOString()) : '&mdash;'}</dd>
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
      ${storageNotice}
      <div class="actions">
        ${configured ? '<form id="clear-form"><button type="submit" class="danger">Remove credentials</button></form>' : ''}
        <form id="logout-form"><button type="submit" class="secondary">Sign out</button></form>
      </div>
    </section>`;

  const body =
    mode === 'setup' ? setupSection : mode === 'login' ? loginSection : settingsSection;

  const csrfMeta = csrfToken
    ? `<meta name="csrf-token" content="${escapeHtml(csrfToken)}" />`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
${csrfMeta}
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
