/**
 * Helpers for building the shareable Prototype 2 customer invitation URL.
 *
 * AI Studio serves applets from two different kinds of Cloud Run hostnames:
 *   - `ais-dev-<id>.run.app` : the private development preview. Every request
 *     (document, /api/*, and the /ws WebSocket upgrade) is redirected to
 *     `https://aistudio.google.com/applet-auth-bridge`, which in turn redirects
 *     unauthenticated visitors to `accounts.google.com`. A customer can never
 *     reach the app through this hostname.
 *   - the published/shared deployment : publicly reachable.
 *
 * Because of that, an invitation URL must be derived from an explicitly
 * configured public base URL when one exists, and must never be fabricated by
 * rewriting the hostname (e.g. turning `ais-dev-` into `ais-pre-` produces a
 * hostname that does not exist and returns HTTP 404).
 */

const INVALID_PLACEHOLDERS = ['MY_APP_URL'];

/** Returns a clean absolute http(s) base URL, or null when the value is unusable. */
export const sanitizeBaseUrl = (raw?: string | null): string | null => {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (INVALID_PLACEHOLDERS.includes(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
};

/** True when the URL is served from the auth-gated AI Studio development preview. */
export const isAistudioDevPreview = (url: string): boolean => {
  try {
    return new URL(url).hostname.startsWith('ais-dev-');
  } catch {
    return false;
  }
};

/** Upgrade plain http origins to https, except for local development hosts. */
export const forceHttps = (baseUrl: string): string => {
  if (!baseUrl.startsWith('http://')) return baseUrl;

  try {
    const hostname = new URL(baseUrl).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
      return baseUrl;
    }
  } catch {
    return baseUrl;
  }

  return baseUrl.replace(/^http:\/\//i, 'https://');
};

export interface CustomerInviteUrlOptions {
  /** Explicit public deployment URL (APP_URL). Wins over the current origin. */
  configuredPublicUrl?: string | null;
  /** window.location.origin of the page generating the link. */
  currentOrigin: string;
  /** window.location.pathname of the page generating the link. */
  currentPathname: string;
  roomId: string;
}

/** Builds the exact URL a customer should open to join a Prototype 2 room. */
export const buildCustomerInviteUrl = ({
  configuredPublicUrl,
  currentOrigin,
  currentPathname,
  roomId,
}: CustomerInviteUrlOptions): string => {
  const configuredBase = sanitizeBaseUrl(configuredPublicUrl);

  let origin = currentOrigin;
  let pathname = currentPathname || '/';

  if (configuredBase) {
    const parsed = new URL(configuredBase);
    origin = parsed.origin;
    // An explicitly configured base may carry an app path; prefer it over the
    // path of the page that generated the link.
    const configuredPath = parsed.pathname.replace(/\/+$/, '');
    if (configuredPath) pathname = configuredPath;
  }

  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  return `${forceHttps(origin)}${pathname}?prototype=2&room=${encodeURIComponent(roomId)}&role=customer`;
};
