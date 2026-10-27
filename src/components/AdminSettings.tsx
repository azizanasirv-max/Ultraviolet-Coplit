import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle2, KeyRound, Loader2, Lock, Server, Settings, ShieldCheck, Trash2, X,
} from 'lucide-react';
import {
  AdminApiError,
  AdminStatusResponse,
  AdminTurnStatus,
  clearTurnCredentials,
  createAdminSetup,
  getAdminSession,
  getAdminStatus,
  loginAdmin,
  logoutAdmin,
  saveTurnCredentials,
} from '../lib/adminApi';

type Stage = 'checking' | 'setup' | 'login' | 'settings' | 'unavailable';

const SETUP_PASSWORD_MIN_LENGTH = 12;

const errorMessage = (err: unknown, fallback: string): string =>
  (err as AdminApiError)?.message || (err as Error)?.message || fallback;

/**
 * In-app Admin Settings.
 *
 * A thin UI over the existing PR #10 admin backend (`/api/admin/*` and
 * server/admin.ts): first-run setup, sign-in, then ExpressTURN credentials.
 * `/admin/turn` keeps working unchanged.
 *
 * Secrets handling:
 *   - no secret is written to localStorage/sessionStorage;
 *   - the TURN password field is cleared as soon as a save finishes;
 *   - save/clear/sign-out always send the per-session CSRF token and rely on
 *     the HttpOnly cookie, so nothing secret is kept in JavaScript storage.
 */
export const AdminSettings: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [stage, setStage] = useState<Stage>('checking');
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [serverAddress, setServerAddress] = useState('');
  const [username, setUsername] = useState('');
  const [turnPassword, setTurnPassword] = useState('');

  const clearSecrets = useCallback(() => {
    setSetupPassword('');
    setSetupConfirm('');
    setLoginPassword('');
    setServerAddress('');
    setUsername('');
    setTurnPassword('');
  }, []);

  const adoptSession = useCallback((session: AdminStatusResponse & { csrfToken: string }) => {
    setStatus(session);
    setCsrfToken(session.csrfToken);
    setStage('settings');
  }, []);

  const load = useCallback(async () => {
    setStage('checking');
    setError(null);
    setNotice(null);
    clearSecrets();

    // An existing signed cookie session is reused without asking for the
    // password again. Otherwise the safe status endpoint decides between
    // first-time setup and sign-in.
    try {
      adoptSession(await getAdminSession());
      return;
    } catch (err) {
      if (!(err instanceof AdminApiError) || err.status !== 401) {
        setError(errorMessage(err, 'Admin Settings could not be loaded.'));
        setStage('unavailable');
        return;
      }
    }

    try {
      const safe = await getAdminStatus();
      setStatus(safe);
      setStage(safe.setup.claimed ? 'login' : 'setup');
    } catch (err) {
      setError(errorMessage(err, 'Admin Settings could not be loaded.'));
      setStage('unavailable');
    }
  }, [adoptSession, clearSecrets]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const finish = () => {
    clearSecrets();
    onClose();
  };

  const submitSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (setupPassword.length < SETUP_PASSWORD_MIN_LENGTH) {
      setError(`Setup password must be at least ${SETUP_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (setupPassword !== setupConfirm) {
      setError('The setup passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      adoptSession(await createAdminSetup(setupPassword));
      clearSecrets();
      setNotice('Admin setup complete. Now enter your ExpressTURN credentials.');
    } catch (err) {
      setError(errorMessage(err, 'Setup could not be completed.'));
      setSetupPassword('');
      setSetupConfirm('');
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      adoptSession(await loginAdmin(loginPassword));
      clearSecrets();
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed.'));
      setLoginPassword('');
    } finally {
      setBusy(false);
    }
  };

  /** A 401 means the cookie session expired; return to sign-in instead of looping. */
  const handleMutationError = (err: unknown, fallback: string): void => {
    if (err instanceof AdminApiError && err.status === 401) {
      setCsrfToken(null);
      setStage('login');
      setError('Your admin session expired. Sign in again.');
      return;
    }
    setError(errorMessage(err, fallback));
  };

  const submitTurn = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!csrfToken) {
      setError('Your admin session expired. Reload Admin Settings and sign in again.');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveTurnCredentials(
        { serverAddress, username, password: turnPassword },
        csrfToken
      );
      setStatus((prev) => (prev ? { ...prev, ...saved.settings } : prev));
      setServerAddress('');
      setUsername('');
      setTurnPassword('');
      setNotice('ExpressTURN credentials saved in server memory. New calls will use the relay.');
    } catch (err) {
      setTurnPassword('');
      handleMutationError(err, 'Credentials could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const removeTurn = async () => {
    if (!csrfToken) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const cleared = await clearTurnCredentials(csrfToken);
      setStatus((prev) => (prev ? { ...prev, ...cleared.settings } : prev));
      setNotice('ExpressTURN credentials removed from server memory.');
    } catch (err) {
      handleMutationError(err, 'Credentials could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (csrfToken) await logoutAdmin(csrfToken);
    } catch {
      // The session may already have expired; returning to sign-in is correct.
    } finally {
      clearSecrets();
      setCsrfToken(null);
      setStage('login');
      setBusy(false);
    }
  };

  const statusRows = (value: AdminTurnStatus | null) => (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-slate-400">Admin setup</dt>
      <dd className={status?.setup.claimed ? 'text-emerald-300' : 'text-amber-300'}>
        {status?.setup.claimed ? 'completed' : 'not completed'}
      </dd>
      <dt className="text-slate-400">TURN relay</dt>
      <dd className={value?.configured ? 'text-emerald-300' : 'text-amber-300'}>
        {value?.configured ? `configured (${value.urlCount} URL${value.urlCount === 1 ? '' : 's'})` : 'not configured'}
      </dd>
      <dt className="text-slate-400">Last update</dt>
      <dd className="text-slate-300">
        {value?.updatedAt ? new Date(value.updatedAt).toLocaleString() : '—'}
      </dd>
      <dt className="text-slate-400">Storage</dt>
      <dd className="text-slate-300">server memory (lost on restart)</dd>
    </dl>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-slate-950/80 p-3 sm:p-6 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-settings-title"
        data-testid="admin-settings-panel"
        className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl my-auto"
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-indigo-500/15 text-indigo-300">
              <Settings className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 id="admin-settings-title" className="text-sm font-bold text-slate-100">Admin Settings</h2>
              <p className="text-[10px] text-slate-400">ExpressTURN relay setup · operator only</p>
            </div>
          </div>
          <button
            onClick={finish}
            aria-label="Close Admin Settings"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 space-y-3">
          {error ? (
            <div role="alert" className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div role="status" className="flex items-start gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{notice}</span>
            </div>
          ) : null}

          {stage === 'checking' ? (
            <div className="flex items-center gap-2 py-6 justify-center text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking admin setup…
            </div>
          ) : null}

          {stage === 'unavailable' ? (
            <p className="text-sm text-slate-400 py-2">
              Admin Settings cannot reach the server right now. Try again, or open{' '}
              <a href="/admin/turn" className="text-cyan-300 underline">/admin/turn</a>.
            </p>
          ) : null}

          {stage === 'setup' ? (
            <form onSubmit={submitSetup} className="space-y-3" data-testid="admin-setup-form">
              <p className="text-xs text-slate-400">
                This server process has no admin password yet. Create one to finish admin setup.
                It is stored only as a scrypt hash in server memory.
              </p>
              <label className="block text-xs font-semibold text-slate-300">
                New setup password
                <input
                  type="password"
                  value={setupPassword}
                  onChange={(event) => setSetupPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={SETUP_PASSWORD_MIN_LENGTH}
                  required
                  className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
                  data-testid="admin-setup-password"
                />
              </label>
              <label className="block text-xs font-semibold text-slate-300">
                Confirm setup password
                <input
                  type="password"
                  value={setupConfirm}
                  onChange={(event) => setSetupConfirm(event.target.value)}
                  autoComplete="new-password"
                  minLength={SETUP_PASSWORD_MIN_LENGTH}
                  required
                  className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
                  data-testid="admin-setup-confirm"
                />
              </label>
              <p className="text-[11px] text-slate-500">
                At least {SETUP_PASSWORD_MIN_LENGTH} characters, using at least three of: lowercase,
                uppercase, numbers, symbols.
              </p>
              <button
                type="submit"
                disabled={busy}
                className="w-full px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                Complete admin setup
              </button>
              <p className="text-[11px] text-amber-300/90">
                Complete this immediately after a deploy or restart: a fresh process has not been
                claimed yet.
              </p>
            </form>
          ) : null}


          {stage === 'login' ? (
            <form onSubmit={submitLogin} className="space-y-3" data-testid="admin-login-form">
              <p className="text-xs text-slate-400">
                Admin setup is already complete on this server process. Sign in with the setup
                password you created.
              </p>
              <label className="block text-xs font-semibold text-slate-300">
                Setup password
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
                  data-testid="admin-login-password"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                Sign in
              </button>
            </form>
          ) : null}


          {stage === 'settings' ? (
            <div className="space-y-3">
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2.5" data-testid="admin-status">
                {statusRows(status)}
              </div>

              <form onSubmit={submitTurn} className="space-y-3" data-testid="admin-turn-form">
                <label className="block text-xs font-semibold text-slate-300">
                  TURN server URL / address
                  <input
                    value={serverAddress}
                    onChange={(event) => setServerAddress(event.target.value)}
                    placeholder="turn:free.expressturn.com:3478"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-indigo-500 font-mono"
                    data-testid="admin-turn-server"
                  />
                </label>
                <label className="block text-xs font-semibold text-slate-300">
                  TURN username
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500 font-mono"
                    data-testid="admin-turn-username"
                  />
                </label>
                <label className="block text-xs font-semibold text-slate-300">
                  TURN password
                  <input
                    type="password"
                    value={turnPassword}
                    onChange={(event) => setTurnPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                    className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
                    data-testid="admin-turn-password"
                  />
                </label>
                <p className="text-[11px] text-slate-500">
                  Copy these three values from the ExpressTURN dashboard. They are used verbatim,
                  kept in server memory only, and never shown again after saving.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="flex-1 min-w-[9rem] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2"
                    data-testid="admin-turn-save"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
                    Save credentials
                  </button>
                  {status?.configured ? (
                    <button
                      type="button"
                      onClick={() => void removeTurn()}
                      disabled={busy}
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-rose-300 text-sm font-semibold flex items-center gap-1.5"
                      data-testid="admin-turn-remove"
                    >
                      <Trash2 className="w-4 h-4" /> Remove
                    </button>
                  ) : null}
                </div>
              </form>

              <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-2.5">
                <p className="text-[10px] text-slate-500 flex items-center gap-1">
                  <KeyRound className="w-3 h-3" /> Session expires in 2 hours; a restart clears everything.
                </p>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={busy}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-60"
                  data-testid="admin-logout"
                >
                  Sign out
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default AdminSettings;

