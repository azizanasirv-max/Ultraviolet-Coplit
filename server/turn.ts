/**
 * ICE / TURN configuration resolution.
 *
 * Hard rules implemented here:
 *   - TURN URLs are parsed and validated, including multiple entries and both
 *     `turn:` and `turns:` schemes.
 *   - TURN credentials are only produced for authenticated session participants
 *     (the HTTP layer enforces that; this module just builds the payload).
 *   - Both static credentials (TURN_USERNAME/TURN_CREDENTIAL) and coturn-style
 *     short-lived credentials (TURN_SECRET, HMAC-SHA1) are supported. Ephemeral
 *     credentials are preferred when a secret is present so no long-lived TURN
 *     password has to be shipped to browsers.
 *   - `ICE_TRANSPORT_POLICY=relay` without a usable TURN configuration is a hard
 *     error, never a silent STUN-only fallback.
 *   - Credentials are never logged and never included in /api/health.
 */
import { createHmac } from 'crypto';

export type IceTransportPolicy = 'all' | 'relay';
export type TurnCredentialMode = 'ephemeral' | 'static' | 'provider' | 'none';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigPayload {
  iceServers: IceServerConfig[];
  hasTurn: boolean;
  hasStun: boolean;
  iceTransportPolicy: IceTransportPolicy;
  turn: {
    configured: boolean;
    credentialMode: TurnCredentialMode;
    urlCount: number;
    expiresAt: number | null;
    /** True when credentials are issued by TURN_CREDENTIALS_URL at request time. */
    providerConfigured?: boolean;
  };
  warnings: string[];
  errors: string[];
  generatedAt: string;
}

export interface TurnSummary {
  configured: boolean;
  credentialMode: TurnCredentialMode;
  iceTransportPolicy: IceTransportPolicy;
  hasErrors: boolean;
  warnings: string[];
}

export interface BuildIceConfigOptions {
  /** Used as the ephemeral credential user id; not a secret. */
  sessionId?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
];

// turn:host[:port][?transport=udp] | turns:host[:port][?transport=tcp]
const TURN_URL_PATTERN = /^turns?:(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?(?:\?[^\s,]+)?$/;
const STUN_URL_PATTERN = /^stuns?:(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?(?:\?[^\s,]+)?$/;

const DEFAULT_TURN_TTL_SECONDS = 3600;

export const parseUrlList = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const parseTurnUrls = (raw: unknown): { urls: string[]; invalid: string[] } => {
  const entries = parseUrlList(raw);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (TURN_URL_PATTERN.test(entry)) {
      if (!urls.includes(entry)) urls.push(entry);
    } else {
      invalid.push(entry.slice(0, 120));
    }
  }
  return { urls, invalid };
};

export const parseStunUrls = (raw: unknown): { urls: string[]; invalid: string[] } => {
  const entries = parseUrlList(raw);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (STUN_URL_PATTERN.test(entry)) {
      if (!urls.includes(entry)) urls.push(entry);
    } else {
      invalid.push(entry.slice(0, 120));
    }
  }
  return { urls, invalid };
};

export const resolveIceTransportPolicy = (env: NodeJS.ProcessEnv = process.env): IceTransportPolicy =>
  env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all';

const resolveTtlSeconds = (env: NodeJS.ProcessEnv): number => {
  const parsed = Number(env.TURN_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TURN_TTL_SECONDS;
  return Math.min(Math.max(Math.round(parsed), 60), 86_400);
};

/**
 * coturn / TURN REST API ephemeral credential:
 *   username   = "<unix expiry>:<user id>"
 *   credential = base64(HMAC-SHA1(shared secret, username))
 */
export const buildEphemeralTurnCredential = (params: {
  secret: string;
  expiresAtSeconds: number;
  userId: string;
}): { username: string; credential: string } => {
  const username = `${params.expiresAtSeconds}:${params.userId}`;
  const credential = createHmac('sha1', params.secret).update(username).digest('base64');
  return { username, credential };
};

export interface TurnSettings {
  turnUrls: string[];
  stunUrls: string[];
  username: string | null;
  credential: string | null;
  secret: string | null;
  credentialsUrl: string | null;
  credentialsAuthorization: string | null;
  credentialsMethod: 'GET' | 'POST';
  ttlSeconds: number;
  policy: IceTransportPolicy;
  invalidTurnUrls: string[];
  invalidStunUrls: string[];
}

/** Reads and normalises the deployment's ICE/TURN settings. */
export const resolveTurnSettings = (env: NodeJS.ProcessEnv = process.env): TurnSettings => {
  const turn = parseTurnUrls(env.TURN_URLS);
  const stun = parseStunUrls(env.STUN_URLS);
  return {
    turnUrls: turn.urls,
    stunUrls: stun.urls.length > 0 ? stun.urls : DEFAULT_STUN_URLS,
    username: env.TURN_USERNAME?.trim() || null,
    credential: env.TURN_CREDENTIAL?.trim() || null,
    secret: env.TURN_SECRET?.trim() || null,
    credentialsUrl: env.TURN_CREDENTIALS_URL?.trim() || null,
    credentialsAuthorization: env.TURN_CREDENTIALS_AUTH?.trim() || null,
    credentialsMethod: env.TURN_CREDENTIALS_METHOD === 'POST' ? 'POST' : 'GET',
    ttlSeconds: resolveTtlSeconds(env),
    policy: resolveIceTransportPolicy(env),
    invalidTurnUrls: turn.invalid,
    invalidStunUrls: stun.invalid,
  };
};

const redactUrl = (url: string): string => url.replace(/\/\/[^@/]+@/, '//***@');

/**
 * Builds the ICE configuration for one authenticated participant.
 *
 * `errors` are fatal only in the sense that the deployment is misconfigured; the
 * HTTP layer turns them into a 503 when relay-only mode was requested, so the
 * client cannot silently downgrade to STUN-only.
 */
export const buildIceConfig = (options: BuildIceConfigOptions = {}): IceConfigPayload => {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const settings = resolveTurnSettings(env);
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const invalid of settings.invalidTurnUrls) {
    errors.push(
      `TURN_URLS contains an invalid entry ("${redactUrl(invalid)}"). Use turn:<host>[:port] or turns:<host>[:port].`
    );
  }
  for (const invalid of settings.invalidStunUrls) {
    warnings.push(`STUN_URLS contains an invalid entry ("${redactUrl(invalid)}") which was ignored.`);
  }

  let credentialMode: TurnCredentialMode = 'none';
  let turnUsername: string | null = null;
  let turnCredential: string | null = null;
  let expiresAt: number | null = null;

  if (settings.credentialsUrl) {
    // Credentials come from the provider at request time; nothing static is
    // shipped. The URL/auth stay server-side.
    credentialMode = 'provider';
    turnUsername = null;
    turnCredential = null;
  } else if (settings.turnUrls.length > 0) {
    if (settings.secret) {
      const expiresAtSeconds = Math.floor(now / 1000) + settings.ttlSeconds;
      const generated = buildEphemeralTurnCredential({
        secret: settings.secret,
        expiresAtSeconds,
        userId: options.sessionId || 'participant',
      });
      credentialMode = 'ephemeral';
      turnUsername = generated.username;
      turnCredential = generated.credential;
      expiresAt = expiresAtSeconds * 1000;
    } else if (settings.username && settings.credential) {
      credentialMode = 'static';
      turnUsername = settings.username;
      turnCredential = settings.credential;
      warnings.push(
        'TURN uses static credentials. Prefer TURN_SECRET (coturn REST credentials) so browsers receive short-lived credentials.'
      );
    } else {
      errors.push(
        'TURN_URLS is set but TURN authentication is missing. Configure TURN_SECRET (preferred) or both TURN_USERNAME and TURN_CREDENTIAL. Without credentials the relay will reject every allocation.'
      );
    }
  } else if (settings.username || settings.credential || settings.secret) { // eslint-disable-line

    warnings.push('TURN credentials are configured but TURN_URLS is empty; no relay will be used.');
  }

  const usableTurn =
    Boolean(settings.credentialsUrl) ||
    (settings.turnUrls.length > 0 && credentialMode !== 'none' && !settings.invalidTurnUrls.length);

  if (!usableTurn) {
    if (settings.policy === 'relay') {
      errors.push(
        'ICE_TRANSPORT_POLICY=relay requires a usable TURN relay (TURN_URLS plus TURN_SECRET or TURN_USERNAME/TURN_CREDENTIAL). Relay-only mode cannot work with STUN alone.'
      );
    } else {
      warnings.push(
        'No usable TURN relay is configured. Calls work only when both devices can reach each other directly; mobile-data or symmetric-NAT participants will have no audio.'
      );
    }
  }

  const iceServers: IceServerConfig[] = [{ urls: settings.stunUrls }];
  if (settings.turnUrls.length > 0 && credentialMode !== 'none') {
    iceServers.push({
      urls: settings.turnUrls,
      ...(turnUsername ? { username: turnUsername } : {}),
      ...(turnCredential ? { credential: turnCredential } : {}),
    });
  }

  return {
    iceServers,
    hasTurn: usableTurn,
    hasStun: settings.stunUrls.length > 0,
    iceTransportPolicy: settings.policy,
    turn: {
      configured: usableTurn,
      credentialMode,
      urlCount: settings.turnUrls.length,
      expiresAt,
      providerConfigured: Boolean(settings.credentialsUrl),
    },
    warnings,
    errors,
    generatedAt: new Date(now).toISOString(),
  };
};

/** Health-safe summary: no URLs, no usernames, no credentials. */
export const turnSummary = (env: NodeJS.ProcessEnv = process.env): TurnSummary => {
  const config = buildIceConfig({ env, now: 0 });
  const settings = resolveTurnSettings(env);
  return {
    configured: config.turn.configured,
    credentialMode: config.turn.credentialMode,
    iceTransportPolicy: settings.policy,
    hasErrors: config.errors.length > 0,
    warnings: config.errors.length > 0 ? config.errors : config.warnings,
  };
};

export const describeIceSettingsForLog = (env: NodeJS.ProcessEnv = process.env): string => {
  const settings = resolveTurnSettings(env);
  const mode = settings.secret ? 'ephemeral' : settings.username && settings.credential ? 'static' : 'none';
  return `turnUrls=${settings.turnUrls.length} credentialMode=${mode} policy=${settings.policy} stunUrls=${settings.stunUrls.length}`;
};

// ---------------------------------------------------------------------------
// Provider-issued (short-lived) TURN credentials
//
// Some managed TURN providers expose an HTTP endpoint that returns temporary
// ICE servers (Twilio Network Traversal, Metered, or a small internal proxy).
// The API key stays on the server; the browser only receives the temporary
// username/credential.
//
// Expected response shapes (any of):
//   [ { "urls": "turn:...", "username": "...", "credential": "..." } ]
//   [ { "url": "turn:...", "username": "...", "credential": "..." } ]
//   { "iceServers": [ ... ] }  /  { "ice_servers": [ ... ] }
// ---------------------------------------------------------------------------

export const parseProviderIceServers = (payload: unknown): IceServerConfig[] => {
  const unwrapped =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).iceServers ??
        (payload as Record<string, unknown>).ice_servers ??
        (payload as Record<string, unknown>).data ??
        [])
      : payload;
  const candidates =
    unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)
      ? [unwrapped]
      : unwrapped;

  if (!Array.isArray(candidates)) return [];

  const servers: IceServerConfig[] = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawUrls = record.urls ?? record.url;
    const urls = (Array.isArray(rawUrls) ? rawUrls : [rawUrls])
      .filter((url): url is string => typeof url === 'string')
      .map((url) => url.trim())
      .filter((url) => TURN_URL_PATTERN.test(url));
    if (urls.length === 0) continue;

    const username = typeof record.username === 'string' ? record.username : undefined;
    const credential =
      typeof record.credential === 'string'
        ? record.credential
        : typeof record.password === 'string'
          ? record.password
          : undefined;
    if (!username || !credential) continue;

    servers.push({ urls: urls.length === 1 ? urls[0] : urls, username, credential });
  }
  return servers;
};

export interface ProviderIceResult {
  iceServers: IceServerConfig[];
  fetchedAt: number;
  expiresAt: number;
}

const providerCache = new Map<string, ProviderIceResult>();

export const clearProviderIceCache = (): void => providerCache.clear();

/**
 * Fetches temporary TURN credentials from TURN_CREDENTIALS_URL.
 * Throws an actionable error on HTTP failure, timeout, or an unusable payload.
 */
export const fetchProviderIceServers = async (params: {
  credentialsUrl: string;
  authorization?: string | null;
  /** GET (Metered-style) or POST with a {ttl} JSON body (Cloudflare-style). */
  method?: 'GET' | 'POST';
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: number;
  cache?: Map<string, ProviderIceResult>;
}): Promise<ProviderIceResult> => {
  const cache = params.cache ?? providerCache;
  const now = params.now ?? Date.now();
  const cached = cache.get(params.credentialsUrl);
  if (cached && cached.expiresAt > now) return cached;

  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 5000);
  let response: Response;
  try {
    const method = params.method === 'POST' ? 'POST' : 'GET';
    response = await fetchImpl(params.credentialsUrl, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(params.authorization ? { Authorization: params.authorization } : {}),
      },
      ...(method === 'POST'
        ? { body: JSON.stringify({ ttl: params.ttlSeconds ?? DEFAULT_TURN_TTL_SECONDS }) }
        : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `TURN_CREDENTIALS_URL could not be reached (${(err as Error)?.message || err}). Check the URL and network egress.`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `TURN_CREDENTIALS_URL returned HTTP ${response.status}. Verify TURN_CREDENTIALS_AUTH and the provider account.`
    );
  }

  const payload = await response.json().catch(() => null);
  const iceServers = parseProviderIceServers(payload);
  if (iceServers.length === 0) {
    throw new Error(
      'TURN_CREDENTIALS_URL returned no usable TURN servers. It must return ICE servers with turn:/turns: URLs and temporary username/credential.'
    );
  }

  const result: ProviderIceResult = {
    iceServers,
    fetchedAt: now,
    expiresAt: now + (params.cacheTtlMs ?? 5 * 60_000),
  };
  cache.set(params.credentialsUrl, result);
  return result;
};

export interface ProviderMergeResult {
  config: IceConfigPayload;
  providerOk: boolean;
}

/**
 * Replaces the TURN entries of a base config with provider-issued (short-lived)
 * credentials. On failure the config gains an actionable error and keeps STUN.
 */
export const mergeProviderIceServers = (
  base: IceConfigPayload,
  provider: ProviderIceResult | null,
  error: Error | null
): ProviderMergeResult => {
  if (provider) {
    const stun = base.iceServers.filter((entry) =>
      (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).every((url) => url.startsWith('stun'))
    );
    return {
      providerOk: true,
      config: {
        ...base,
        iceServers: [...stun, ...provider.iceServers],
        hasTurn: true,
        turn: { ...base.turn, configured: true, credentialMode: 'provider', expiresAt: provider.expiresAt },
      },
    };
  }

  const message = error?.message || 'TURN credential provider failed.';
  const isRelay = base.iceTransportPolicy === 'relay';
  return {
    providerOk: false,
    config: {
      ...base,
      hasTurn: false,
      warnings: isRelay ? base.warnings : [...base.warnings, message],
      errors: [...base.errors, message],
      turn: { ...base.turn, configured: false, credentialMode: 'none' },
    },
  };
};
