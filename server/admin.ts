/**
 * First-run setup, password verification, CSRF tokens and signed sessions for
 * the operator-only /admin/turn page.
 *
 * Why there is no environment variable:
 *   The operator may not have access to the hosting dashboard, so the admin
 *   credential is created in the browser on first use. Until then the page is
 *   open for a one-time "claim" (there is nothing secret to protect yet). Once
 *   claimed, only the setup password can open or change TURN settings.
 *
 * Security model (all state is process-local, by design):
 *   - The setup password is hashed with scrypt (random 16-byte salt, N=16384,
 *     r=8, p=1, 32-byte key) and compared in constant time. The plaintext and
 *     the hash are never logged, rendered or returned by an API.
 *   - Sessions are HttpOnly/SameSite=Strict cookies signed with a random
 *     per-process HMAC key, so they cannot outlive a restart.
 *   - Every session carries a random CSRF token that is required in the
 *     X-CSRF-Token header on state-changing requests. The cookie alone is not
 *     enough, so a cross-site request cannot mutate configuration.
 *   - A restart clears the setup password AND the TURN credentials together
 *     (both live only in memory), so the page returns to first-run setup. No
 *     stale credential is ever exposed; the operator simply claims setup again.
 *
 * Residual limitation (documented on the page and in docs/deployment.md): on a
 * fresh process the first visitor can claim setup. Complete first-time setup
 * immediately after a deploy/restart.
 */
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

export const ADMIN_COOKIE_NAME = 'uv_admin';
export const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const ADMIN_SETUP_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_SETUP_PASSWORD_MAX_LENGTH = 256;

export type AdminSetupPasswordErrorCode =
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_LONG'
  | 'PASSWORD_TOO_WEAK';

export class AdminSetupPasswordError extends Error {
  readonly code: AdminSetupPasswordErrorCode;

  constructor(code: AdminSetupPasswordErrorCode, message: string) {
    super(message);
    this.name = 'AdminSetupPasswordError';
    this.code = code;
  }
}

// scrypt cost parameters. Keep these in the stored hash so a future increase
// can verify old hashes before re-hashing.
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SESSION_VERSION = 'v2';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * Validates a new setup password and returns it unchanged.
 * Policy: 12-256 characters and at least three of lowercase, uppercase, digit
 * and symbol. Error messages never contain the submitted value.
 */
export const assertAdminSetupPassword = (candidate: unknown): string => {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new AdminSetupPasswordError('PASSWORD_REQUIRED', 'A setup password is required.');
  }
  if (candidate.length < ADMIN_SETUP_PASSWORD_MIN_LENGTH) {
    throw new AdminSetupPasswordError(
      'PASSWORD_TOO_SHORT',
      `Setup password must be at least ${ADMIN_SETUP_PASSWORD_MIN_LENGTH} characters.`
    );
  }
  if (candidate.length > ADMIN_SETUP_PASSWORD_MAX_LENGTH) {
    throw new AdminSetupPasswordError(
      'PASSWORD_TOO_LONG',
      `Setup password must be at most ${ADMIN_SETUP_PASSWORD_MAX_LENGTH} characters.`
    );
  }

  const classes = [
    /[a-z]/.test(candidate),
    /[A-Z]/.test(candidate),
    /[0-9]/.test(candidate),
    /[^A-Za-z0-9]/.test(candidate),
  ].filter(Boolean).length;
  if (classes < 3) {
    throw new AdminSetupPasswordError(
      'PASSWORD_TOO_WEAK',
      'Setup password must use at least 3 of: lowercase letters, uppercase letters, numbers, symbols.'
    );
  }

  return candidate;
};

const hashSetupPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
};

/** Constant-time verification of a stored scrypt hash. */
const verifySetupPasswordHash = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a corrupted/tampered store.
  if (N < 1024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  if (128 * N * r > SCRYPT_MAXMEM) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
};

interface SetupState {
  passwordHash: string;
  claimedAt: number;
}

// Process-local: a restart clears this together with the TURN credentials.
let setupState: SetupState | null = null;
// Rotated whenever the process restarts; also rotated by the test helper below.
let sessionKey = randomBytes(32);

export interface AdminSetupStatus {
  claimed: boolean;
  claimedAt: number | null;
}

export const getAdminSetupStatus = (): AdminSetupStatus => ({
  claimed: setupState !== null,
  claimedAt: setupState?.claimedAt ?? null,
});

export const isAdminSetupClaimed = (): boolean => setupState !== null;

/**
 * Claims first-run setup by storing a scrypt hash of the chosen password.
 * Returns false when setup has already been claimed (takeover prevention).
 * Throws AdminSetupPasswordError for a password that fails the policy.
 */
export const claimAdminSetupPassword = async (
  candidate: unknown,
  now = Date.now()
): Promise<boolean> => {
  if (setupState) return false;
  const password = assertAdminSetupPassword(candidate);
  const passwordHash = await hashSetupPassword(password);
  // Re-check after the await: two concurrent claims may have raced.
  if (setupState) return false;
  setupState = { passwordHash, claimedAt: now };
  return true;
};

/** Verifies a login attempt. Always false while setup has not been claimed. */
export const verifyAdminSetupPassword = async (candidate: unknown): Promise<boolean> => {
  if (!setupState) return false;
  if (typeof candidate !== 'string') return false;
  if (candidate.length === 0 || candidate.length > ADMIN_SETUP_PASSWORD_MAX_LENGTH) return false;
  return verifySetupPasswordHash(candidate, setupState.passwordHash);
};

/**
 * Test-only: simulates a process restart by clearing the in-memory setup state
 * and rotating the session signing key. Never called by production code.
 */
export const resetAdminAuthStateForTests = (): void => {
  setupState = null;
  sessionKey = randomBytes(32);
};

const sign = (payload: string): string =>
  createHmac('sha256', sessionKey).update(payload).digest('base64url');

export interface AdminSession {
  expiresAt: number;
  /** Random per-session token required in the X-CSRF-Token header. */
  csrfToken: string;
}

export interface AdminSessionToken extends AdminSession {
  token: string;
}

/** Creates a signed session token; it never contains the password or hash. */
export const createAdminSession = (now = Date.now()): AdminSessionToken => {
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const csrfToken = randomBytes(24).toString('base64url');
  const payload = `${SESSION_VERSION}.${expiresAt}.${csrfToken}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt, csrfToken };
};

/** Parses and verifies a signed session token. Returns null when invalid. */
export const readAdminSession = (token: unknown, now = Date.now()): AdminSession | null => {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;

  const expiresAt = Number(parts[1]);
  if (!Number.isInteger(expiresAt) || expiresAt <= now) return null;
  if (expiresAt > now + ADMIN_SESSION_TTL_MS + 60_000) return null;

  const csrfToken = parts[2];
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(csrfToken)) return null;

  const expected = sign(`${parts[0]}.${parts[1]}.${csrfToken}`);
  try {
    const provided = Buffer.from(parts[3], 'base64url');
    const wanted = Buffer.from(expected, 'base64url');
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;
  } catch {
    return null;
  }

  return { expiresAt, csrfToken };
};

export const verifyAdminSessionToken = (token: unknown, now = Date.now()): boolean =>
  readAdminSession(token, now) !== null;

/** Constant-time CSRF token check for an already-verified session. */
export const verifyAdminCsrfToken = (session: AdminSession, candidate: unknown): boolean => {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 128) return false;
  const provided = Buffer.from(candidate);
  const expected = Buffer.from(session.csrfToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

/** Parses a Cookie header without any dependency. */
export const readCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
};

export const readAdminSessionFromCookie = (
  cookieHeader: string | undefined,
  now = Date.now()
): AdminSession | null => readAdminSession(readCookie(cookieHeader, ADMIN_COOKIE_NAME), now);

export const isAdminRequestAuthorized = (
  cookieHeader: string | undefined,
  now = Date.now()
): boolean => readAdminSessionFromCookie(cookieHeader, now) !== null;
