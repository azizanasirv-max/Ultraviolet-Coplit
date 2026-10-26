/**
 * Admin session cookies and password check for the ExpressTURN settings page.
 *
 * The page is protected by `ADMIN_PASSWORD` (a server-side environment variable
 * set once in the hosting dashboard; it is never sent back to the browser or
 * written to logs). Sessions use an HttpOnly, SameSite=Strict cookie signed with
 * a random per-process key, so sessions never outlive a restart and no signing
 * secret has to be configured or persisted.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const ADMIN_COOKIE_NAME = 'uv_admin';
export const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_VERSION = 'v1';
const SESSION_KEY = randomBytes(32);

/** True when the operator configured ADMIN_PASSWORD. Never returns the value. */
export const isAdminPasswordConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.trim());

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time comparison against ADMIN_PASSWORD; never logs the attempt. */
export const verifyAdminPassword = (
  candidate: unknown,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  const expected = env.ADMIN_PASSWORD?.trim();
  if (!expected || typeof candidate !== 'string') return false;

  const provided = candidate.trim();
  if (!provided) return false;
  try {
    return timingSafeEqual(digest(expected), digest(provided));
  } catch {
    return false;
  }
};


const sign = (payload: string): string =>
  createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');

/** Creates a signed session token; it never contains a password or key. */
export const createAdminSessionToken = (now = Date.now()): string => {
  const payload = `${SESSION_VERSION}.${now + ADMIN_SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
};

export const verifyAdminSessionToken = (token: unknown, now = Date.now()): boolean => {
  if (typeof token !== 'string' || token.length > 512) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isInteger(expiresAt) || expiresAt <= now) return false;
  if (expiresAt > now + ADMIN_SESSION_TTL_MS + 60_000) return false;

  const expected = sign(`${parts[0]}.${parts[1]}`);
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
  now = Date.now()
): boolean => verifyAdminSessionToken(readCookie(cookieHeader, ADMIN_COOKIE_NAME), now);
