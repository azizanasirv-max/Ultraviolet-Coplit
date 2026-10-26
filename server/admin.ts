/**
 * Minimal admin authentication for the ExpressTURN settings page.
 *
 * There is no user database in this project: sessions are in-memory and belong
 * to salespeople/customers, not operators. The admin credential therefore comes
 * from a server-side environment variable (ADMIN_PASSWORD) and is exchanged for
 * a short-lived, HMAC-signed, HttpOnly cookie. No password or session secret is
 * ever sent to the browser or written to logs.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const ADMIN_COOKIE_NAME = 'uv_admin';
export const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_VERSION = 'v1';
const MIN_ADMIN_PASSWORD_LENGTH = 12;

const adminPassword = (env: NodeJS.ProcessEnv): string | null => {
  const value = env.ADMIN_PASSWORD?.trim();
  if (!value || value.length < MIN_ADMIN_PASSWORD_LENGTH) return null;
  return value;
};

/** True when ADMIN_PASSWORD is present and long enough to enable the page. */
export const isAdminConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(adminPassword(env));

export const adminConfigurationError = (env: NodeJS.ProcessEnv = process.env): string | null =>
  adminPassword(env)
    ? null
    : `ADMIN_PASSWORD is not configured (minimum ${MIN_ADMIN_PASSWORD_LENGTH} characters). The admin settings page is disabled until it is set.`;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time password comparison (length-independent via fixed-size digests). */
export const adminPasswordMatches = (
  candidate: unknown,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  const expected = adminPassword(env);
  if (!expected || typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    return timingSafeEqual(digest(expected), digest(candidate));
  } catch {
    return false;
  }
};

const sessionKey = (env: NodeJS.ProcessEnv): Buffer =>
  digest(
    [
      'ultraviolet-copilot/admin-session/v1',
      env.ADMIN_PASSWORD?.trim() || '',
      env.SETTINGS_ENCRYPTION_KEY?.trim() || '',
    ].join('\0')
  );

const sign = (payload: string, env: NodeJS.ProcessEnv): string =>
  createHmac('sha256', sessionKey(env)).update(payload).digest('base64url');

/** Creates a signed session token; the cookie value never contains the password. */
export const createAdminSessionToken = (
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): string => {
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  return `${payload}.${sign(payload, env)}`;
};

export const verifyAdminSessionToken = (
  token: unknown,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): boolean => {
  if (typeof token !== 'string' || token.length > 512) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isInteger(expiresAt) || expiresAt <= now) return false;
  // Defensive: reject absurd expiries even if something signed them.
  if (expiresAt > now + ADMIN_SESSION_TTL_MS + 60_000) return false;

  const expected = sign(`${parts[0]}.${parts[1]}`, env);
  try {
    const provided = Buffer.from(parts[2], 'base64url');
    const wanted = Buffer.from(expected, 'base64url');
    return provided.length === wanted.length && timingSafeEqual(provided, wanted);
  } catch {
    return false;
  }
};

/** Parses a Cookie header without any dependency. */
export const readCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
};

export const isAdminRequestAuthorized = (
  cookieHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): boolean => {
  if (!isAdminConfigured(env)) return false;
  return verifyAdminSessionToken(readCookie(cookieHeader, ADMIN_COOKIE_NAME), env, now);
};
