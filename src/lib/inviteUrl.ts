/**
 * Helpers for building the shareable Prototype 2 customer invitation URL.
 *
 * The authorization token lives in the URL (as it must for a link the customer
 * opens), but the URL alone is never trusted: the server validates the token,
 * binds it to one session and exchanges it for a session-scoped customer key.
 *
 * AI Studio serves applets from two different kinds of Cloud Run hostnames:
 *   - `ais-dev-<id>.run.app` : the private development preview, which redirects
 *     every request to the AI Studio auth bridge. A customer can never reach the
 *     app through it.
 *   - the published/shared deployment : publicly reachable.
 *
 * An invitation URL must therefore be derived from an explicitly configured
 * public base URL when one exists, and must never be fabricated by rewriting the
 * hostname.
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
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return baseUrl;
  } catch {
    return baseUrl;
  }
  return baseUrl.replace(/^http:\/\//i, 'https://');
};

export interface CustomerInviteUrlOptions {
  configuredPublicUrl?: string | null;
  currentOrigin: string;
  inviteToken: string;
}

/** Builds the exact URL a customer opens. The token is issued by the server. */
export const buildCustomerInviteUrl = ({
  configuredPublicUrl,
  currentOrigin,
  inviteToken,
}: CustomerInviteUrlOptions): string => {
  const configuredBase = sanitizeBaseUrl(configuredPublicUrl);
  const base = configuredBase || forceHttps(currentOrigin);
  return `${base.replace(/\/+$/, '')}/join?invite=${encodeURIComponent(inviteToken)}`;
};
