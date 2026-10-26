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
 *   - rstream's managed STUN/TURN service is supported natively through its
 *     documented Control plane API (RSTREAM_AUTHENTICATION_TOKEN +
 *     RSTREAM_PROJECT_ENDPOINT / RSTREAM_PROJECT_ID). See the "rstream" section
 *     below for the exact request/response contract.
 *   - `ICE_TRANSPORT_POLICY=relay` without a usable TURN configuration is a hard
 *     error, never a silent STUN-only fallback.
 *   - Credentials are never logged and never included in /api/health.
 */
import { createHash, createHmac } from 'crypto';
import { ExpressTurnServerSettings, generateExpressTurnCredentials } from './expressTurn';

export type IceTransportPolicy = 'all' | 'relay';
export type TurnCredentialMode = 'ephemeral' | 'static' | 'provider' | 'none';
export type TurnProvider = 'expressturn' | 'rstream' | 'rstream-static' | 'generic';

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
    /** True when credentials are issued by a server-side provider at request time. */
    providerConfigured?: boolean;
    /** Which provider issues them. Never contains credentials. */
    provider?: TurnProvider;
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
  /** Which provider supplies TURN, when applicable. Never contains credentials. */
  provider?: TurnProvider;
}

export interface BuildIceConfigOptions {
  /** Used as the ephemeral credential user id; not a secret. */
  sessionId?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Ignore provider-issued credentials (rstream, TURN_CREDENTIALS_URL) and build
   * only from static TURN_URLS/TURN_SECRET or TURN_USERNAME/TURN_CREDENTIAL.
   * Used to compute the static fallback if a provider is unreachable.
   */
  ignoreProviders?: boolean;
  /**
   * ExpressTURN settings from the encrypted admin store. When present it is the
   * highest-priority TURN source: short-lived credentials are generated locally
   * with the official HMAC-SHA1 scheme.
   */
  expressTurn?: ExpressTurnServerSettings | null;
  /** Safe, actionable error when stored ExpressTURN settings are unusable. */
  expressTurnError?: string | null;
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
/** rstream reports ttl 1-3600 for issued credentials; static JSON expires too. */
const DEFAULT_RSTREAM_STATIC_TTL_SECONDS = 600;
const MAX_RSTREAM_STATIC_TTL_SECONDS = 3600;

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
 * Validity window for the optional static rstream credential. rstream caps
 * issued credentials at one hour; anything outside 1-3600 is clamped so a typo
 * cannot make the server treat an expired credential as valid indefinitely.
 */
const resolveRstreamStaticTtlSeconds = (env: NodeJS.ProcessEnv): number => {
  const parsed = Number(env.RSTREAM_TURN_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RSTREAM_STATIC_TTL_SECONDS;
  return Math.min(Math.max(Math.round(parsed), 1), MAX_RSTREAM_STATIC_TTL_SECONDS);
};

/**
 * First time this process served a given static rstream credential. The TTL
 * window is anchored here (not at rstream issuance, which we cannot observe),
 * so a credential is never treated as valid beyond RSTREAM_TURN_TTL_SECONDS of
 * first use. The key is a hash; the credential itself is never stored.
 */
const rstreamStaticFirstSeen = new Map<string, number>();

export const clearRstreamStaticState = (): void => rstreamStaticFirstSeen.clear();

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
  /** rstream Control plane bearer token (server-side only, never exposed). */
  rstreamToken: string | null;
  /** rstream project endpoint, e.g. `abc123` in the dashboard. */
  rstreamProjectEndpoint: string | null;
  /** rstream project id, alternative to the project endpoint. */
  rstreamProjectId: string | null;
  /** Control plane origin; `https://rstream.io` unless overridden. */
  rstreamBaseUrl: string;
  /**
   * Optional static rstream TURN JSON credentials (username/credential/URLs).
   * Used only when the API-based rstream flow or a generic provider is not
   * configured. These are NOT renewed automatically; see the expiry handling in
   * buildIceConfig.
   */
  rstreamStaticUsername: string | null;
  rstreamStaticCredential: string | null;
  rstreamStaticUrls: string[];
  rstreamStaticInvalidUrls: string[];
  /** Validity window declared for the static credential (seconds). */
  rstreamStaticTtlSeconds: number;
}

/** Reads and normalises the deployment's ICE/TURN settings. */
export const resolveTurnSettings = (env: NodeJS.ProcessEnv = process.env): TurnSettings => {
  const turn = parseTurnUrls(env.TURN_URLS);
  const stun = parseStunUrls(env.STUN_URLS);
  const rstreamStaticTurn = parseTurnUrls(env.RSTREAM_TURN_URLS);
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
    rstreamToken: env.RSTREAM_AUTHENTICATION_TOKEN?.trim() || null,
    rstreamProjectEndpoint: env.RSTREAM_PROJECT_ENDPOINT?.trim() || null,
    rstreamProjectId: env.RSTREAM_PROJECT_ID?.trim() || null,
    rstreamBaseUrl: (env.RSTREAM_API_BASE_URL?.trim() || 'https://rstream.io').replace(/\/+$/, ''),
    rstreamStaticUsername: env.RSTREAM_TURN_USERNAME?.trim() || null,
    rstreamStaticCredential: env.RSTREAM_TURN_CREDENTIAL?.trim() || null,
    rstreamStaticUrls: rstreamStaticTurn.urls,
    rstreamStaticInvalidUrls: rstreamStaticTurn.invalid,
    rstreamStaticTtlSeconds: resolveRstreamStaticTtlSeconds(env),
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

  for (const invalid of settings.invalidStunUrls) {
    warnings.push(`STUN_URLS contains an invalid entry ("${redactUrl(invalid)}") which was ignored.`);
  }

  // Static-TURN diagnostics are collected separately: they only apply when no
  // provider-issued credentials are configured/usable.
  const staticWarnings: string[] = [];
  const staticErrors: string[] = [];

  // 1. Static / coturn credentials. These remain the fallback when no provider
  //    is configured, and are preserved when a provider is configured but
  //    unreachable (see mergeRstreamIceServers).
  let credentialMode: TurnCredentialMode = 'none';
  let turnUsername: string | null = null;
  let turnCredential: string | null = null;
  let expiresAt: number | null = null;

  if (settings.turnUrls.length > 0) {
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
      staticWarnings.push(
        'TURN uses static credentials. Prefer TURN_SECRET (coturn REST credentials) so browsers receive short-lived credentials.'
      );
    } else {
      staticErrors.push(
        'TURN_URLS is set but TURN authentication is missing. Configure TURN_SECRET (preferred) or both TURN_USERNAME and TURN_CREDENTIAL. Without credentials the relay will reject every allocation.'
      );
    }
  } else if (settings.username || settings.credential || settings.secret) { // eslint-disable-line

    staticWarnings.push('TURN credentials are configured but TURN_URLS is empty; no relay will be used.');
  }

  const staticUsable =
    settings.turnUrls.length > 0 && credentialMode !== 'none' && !settings.invalidTurnUrls.length;

  // 2. Server-issued provider credentials take precedence over static ones.
  //    The provider token/URL never leaves this process. ExpressTURN (admin
  //    settings, encrypted store) is the highest-priority source.
  let provider: TurnProvider | null = null;
  let providerReady = false;
  let expressTurnCredentials: {
    urls: string[];
    username: string;
    credential: string;
    expiresAt: number;
  } | null = null;

  if (!options.ignoreProviders && options.expressTurn) {
    try {
      expressTurnCredentials = generateExpressTurnCredentials({
        secretKey: options.expressTurn.secretKey,
        host: options.expressTurn.host,
        port: options.expressTurn.port,
        ttlSeconds: options.expressTurn.ttlSeconds,
        userId: options.sessionId,
        now,
      });
      provider = 'expressturn';
      providerReady = true;
    } catch {
      // Invalid stored values: never log or echo them.
      errors.push(
        'Stored ExpressTURN settings are invalid; re-save the hostname, port and secret key from the admin settings page.'
      );
    }
  }

  if (!options.ignoreProviders && !providerReady) {
    const rstreamRequested = Boolean(
      settings.rstreamToken || settings.rstreamProjectEndpoint || settings.rstreamProjectId
    );
    if (rstreamRequested) {
      provider = 'rstream';
      const hasProject = Boolean(settings.rstreamProjectEndpoint || settings.rstreamProjectId);
      providerReady = Boolean(settings.rstreamToken && hasProject);
      if (!providerReady) {
        errors.push(
          settings.rstreamToken
            ? 'RSTREAM_AUTHENTICATION_TOKEN is set but neither RSTREAM_PROJECT_ENDPOINT nor RSTREAM_PROJECT_ID is configured, so rstream TURN credentials cannot be requested.'
            : 'RSTREAM_PROJECT_ENDPOINT/RSTREAM_PROJECT_ID is set but RSTREAM_AUTHENTICATION_TOKEN is missing; rstream TURN credentials cannot be requested.'
        );
      }
    } else if (settings.credentialsUrl) {
      provider = 'generic';
      providerReady = true;
    }
  }

  if (providerReady && provider !== 'expressturn') {
    credentialMode = 'provider';
    turnUsername = null;
    turnCredential = null;
    expiresAt = null;
  } else if (expressTurnCredentials) {
    credentialMode = 'ephemeral';
    turnUsername = expressTurnCredentials.username;
    turnCredential = expressTurnCredentials.credential;
    expiresAt = expressTurnCredentials.expiresAt;
  }

  // 3. Optional static rstream JSON credentials (RSTREAM_TURN_USERNAME/
  //    RSTREAM_TURN_CREDENTIAL/RSTREAM_TURN_URLS). Used only when no API-based
  //    provider is configured. They expire after RSTREAM_TURN_TTL_SECONDS
  //    (counted from first use in this process) and are NEVER renewed
  //    automatically: an operator must paste fresh credentials and redeploy.
  const rstreamStaticAny = Boolean(
    settings.rstreamStaticUsername ||
      settings.rstreamStaticCredential ||
      settings.rstreamStaticUrls.length > 0 ||
      settings.rstreamStaticInvalidUrls.length > 0
  );
  const rstreamStaticComplete = Boolean(
    settings.rstreamStaticUsername &&
      settings.rstreamStaticCredential &&
      settings.rstreamStaticUrls.length > 0
  );
  let rstreamStaticReady = false;

  if (!providerReady && rstreamStaticAny) {
    const staticRstreamMessages: string[] = [];

    for (const invalid of settings.rstreamStaticInvalidUrls) {
      staticRstreamMessages.push(
        `RSTREAM_TURN_URLS contains an invalid entry ("${redactUrl(invalid)}"). Use turn:<host>[:port] or turns:<host>[:port].`
      );
    }

    if (!rstreamStaticComplete) {
      staticRstreamMessages.push(
        'rstream static TURN configuration is incomplete. Set RSTREAM_TURN_USERNAME, RSTREAM_TURN_CREDENTIAL and RSTREAM_TURN_URLS together, or leave all three unset.'
      );
    } else {
      const fingerprint = createHash('sha256')
        .update(
          [
            settings.rstreamStaticUsername,
            settings.rstreamStaticCredential,
            settings.rstreamStaticUrls.join(','),
          ].join('\0')
        )
        .digest('hex')
        .slice(0, 16);
      const firstSeen = rstreamStaticFirstSeen.get(fingerprint) ?? now;
      if (!rstreamStaticFirstSeen.has(fingerprint)) rstreamStaticFirstSeen.set(fingerprint, now);
      const staticExpiresAt = firstSeen + settings.rstreamStaticTtlSeconds * 1000;

      if (now >= staticExpiresAt) {
        // Report the expired timestamp only when nothing else supplies TURN;
        // otherwise keep the active relay's own expiry.
        if (!staticUsable) expiresAt = staticExpiresAt;
        staticRstreamMessages.push(
          `rstream static TURN credentials have expired (RSTREAM_TURN_TTL_SECONDS=${settings.rstreamStaticTtlSeconds}s from first use). They are NOT renewed automatically; replace RSTREAM_TURN_USERNAME, RSTREAM_TURN_CREDENTIAL and RSTREAM_TURN_URLS with fresh credentials and redeploy.`
        );
      } else {
        rstreamStaticReady = true;
        provider = 'rstream-static';
        credentialMode = 'static';
        turnUsername = settings.rstreamStaticUsername;
        turnCredential = settings.rstreamStaticCredential;
        expiresAt = staticExpiresAt;
        staticWarnings.push(
          `rstream static TURN credentials expire after ${settings.rstreamStaticTtlSeconds}s (counted from first use in this process). They are NOT renewed automatically; replace them manually with fresh credentials and redeploy before expiry.`
        );
      }
    }

    if (staticRstreamMessages.length > 0) {
      // With another usable relay this is a warning; if it is the only relay it
      // is fatal (the HTTP layer then fails closed for relay-only mode).
      (staticUsable ? staticWarnings : staticErrors).push(...staticRstreamMessages);
    }

    if (!rstreamStaticReady && !staticUsable) provider = 'rstream-static';
  }

  if (!providerReady) {
    warnings.push(...staticWarnings);
    errors.push(...staticErrors);
    if (!rstreamStaticReady) {
      for (const invalid of settings.invalidTurnUrls) {
        errors.push(
          `TURN_URLS contains an invalid entry ("${redactUrl(invalid)}"). Use turn:<host>[:port] or turns:<host>[:port].`
        );
      }
    }
  }

  if (options.expressTurnError) {
    const message = options.expressTurnError;
    // With another usable relay this is a warning; otherwise it is actionable
    // and (for relay-only mode) fatal.
    if (providerReady || rstreamStaticReady || staticUsable) warnings.push(message);
    else errors.push(message);
  }

  const usableTurn = providerReady || rstreamStaticReady || staticUsable;

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

  const activeTurnUrls =
    expressTurnCredentials?.urls ?? (rstreamStaticReady ? settings.rstreamStaticUrls : settings.turnUrls);
  const iceServers: IceServerConfig[] = [{ urls: settings.stunUrls }];
  const hasLocallyGeneratedTurn = Boolean(expressTurnCredentials);
  if (
    credentialMode !== 'none' &&
    activeTurnUrls.length > 0 &&
    (hasLocallyGeneratedTurn || !providerReady)
  ) {
    iceServers.push({
      urls: activeTurnUrls,
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
      urlCount: hasLocallyGeneratedTurn ? activeTurnUrls.length : providerReady ? 0 : activeTurnUrls.length,
      expiresAt,
      providerConfigured: providerReady,
      ...(provider ? { provider } : {}),
    },
    warnings,
    errors,
    generatedAt: new Date(now).toISOString(),
  };
};

/** Health-safe summary: no URLs, no usernames, no credentials. */
export const turnSummary = (
  env: NodeJS.ProcessEnv = process.env,
  options: { expressTurn?: ExpressTurnServerSettings | null; expressTurnError?: string | null } = {}
): TurnSummary => {
  // Uses the real clock so static rstream expiry is reported accurately.
  const config = buildIceConfig({ env, now: Date.now(), ...options });
  const settings = resolveTurnSettings(env);
  return {
    configured: config.turn.configured,
    credentialMode: config.turn.credentialMode,
    iceTransportPolicy: settings.policy,
    hasErrors: config.errors.length > 0,
    warnings: config.errors.length > 0 ? config.errors : config.warnings,
    ...(config.turn.provider ? { provider: config.turn.provider } : {}),
  };
};

export const describeIceSettingsForLog = (
  env: NodeJS.ProcessEnv = process.env,
  options: { expressTurn?: boolean } = {}
): string => {
  const settings = resolveTurnSettings(env);
  const rstream = settings.rstreamToken && (settings.rstreamProjectEndpoint || settings.rstreamProjectId);
  const rstreamStatic =
    settings.rstreamStaticUsername &&
    settings.rstreamStaticCredential &&
    settings.rstreamStaticUrls.length > 0;
  const mode = options.expressTurn
    ? 'ephemeral:expressturn'
    : rstream
      ? 'provider:rstream'
      : settings.credentialsUrl
        ? 'provider:generic'
        : rstreamStatic
          ? 'static:rstream'
          : settings.secret
            ? 'ephemeral'
            : settings.username && settings.credential
              ? 'static'
              : 'none';
  return `turnUrls=${settings.turnUrls.length} rstreamStaticUrls=${settings.rstreamStaticUrls.length} credentialMode=${mode} policy=${settings.policy} stunUrls=${settings.stunUrls.length}`;
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

// ---------------------------------------------------------------------------
// rstream managed STUN/TURN (Control plane API)
//
// Verified against the official contract (2026-10):
//   Docs:    https://rstream.io/docs/integrations/stun-turn
//            https://rstream.io/docs/integrations/apis
//   OpenAPI: https://rstream.io/api/openapi.json
//
//   POST https://rstream.io/api/projects/tunnels/<project-id>/turn-server/credentials
//   POST https://rstream.io/api/projects/tunnels/resolve/<project-endpoint>/turn-server/credentials
//     Authorization: Bearer <access token>          (bearerAuth)
//     Content-Type:  application/json
//     Body:          { "ttlSeconds": 1-3600 }       (optional, default 600)
//     Response 200:  { username, credential, urls: string[], ttl }
//     Errors:        400 | 401 | 403 | 404 | 409 | 429 | 503 (all Cache-Control: no-store)
//     Rules:         turn.credentials.create + project access
//
// The access token is an rstream access token (OAuth device flow, or the token
// obtained from application credentials by the official SDK). It is read from
// RSTREAM_AUTHENTICATION_TOKEN and never leaves this process.
// ---------------------------------------------------------------------------

export interface RstreamTurnResult {
  iceServers: IceServerConfig[];
  urls: string[];
  /** When the credentials themselves expire (epoch ms). */
  expiresAt: number;
  /** When this process should fetch again (epoch ms, before expiresAt). */
  cacheExpiresAt: number;
  ttlSeconds: number;
}

export interface RstreamRequestParams {
  token: string;
  projectId?: string | null;
  projectEndpoint?: string | null;
  baseUrl?: string;
  ttlSeconds?: number;
  timeoutMs?: number;
  now?: number;
  fetchImpl?: typeof fetch;
  cache?: Map<string, RstreamTurnResult>;
}

const DEFAULT_RSTREAM_TTL_SECONDS = 600;
const RSTREAM_MAX_TTL_SECONDS = 3600;
const RSTREAM_MAX_RESPONSE_BYTES = 32 * 1024;

const rstreamCache = new Map<string, RstreamTurnResult>();

export const clearRstreamTurnCache = (): void => rstreamCache.clear();

const isNonEmptyString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const clampRstreamTtl = (raw: unknown): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RSTREAM_TTL_SECONDS;
  return Math.min(Math.max(Math.round(parsed), 1), RSTREAM_MAX_TTL_SECONDS);
};

/**
 * Builds the documented Control plane TURN issuance URL. Path segments are
 * encoded; the endpoint contains no secrets.
 */
export const buildRstreamCredentialsUrl = (params: {
  baseUrl?: string;
  projectId?: string | null;
  projectEndpoint?: string | null;
}): string => {
  const base = (params.baseUrl?.trim() || 'https://rstream.io').replace(/\/+$/, '');
  const isHttps = /^https:\/\//i.test(base);
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base);
  if (!isHttps && !isLocalHttp) {
    throw new Error('RSTREAM_API_BASE_URL must be an https:// origin (http is only allowed for localhost).');
  }
  if (params.projectId) {
    return `${base}/api/projects/tunnels/${encodeURIComponent(params.projectId)}/turn-server/credentials`;
  }
  if (params.projectEndpoint) {
    return `${base}/api/projects/tunnels/resolve/${encodeURIComponent(params.projectEndpoint)}/turn-server/credentials`;
  }
  throw new Error('rstream TURN requires RSTREAM_PROJECT_ENDPOINT or RSTREAM_PROJECT_ID.');
};

/** Status-specific, actionable, secret-free error messages. */
const describeRstreamStatus = (status: number): string => {
  switch (status) {
    case 400:
      return 'rstream rejected the TURN credential request (HTTP 400). Verify the requested TTL is between 1 and 3600 seconds.';
    case 401:
      return 'rstream rejected the credentials (HTTP 401). RSTREAM_AUTHENTICATION_TOKEN is invalid or expired; rotate the token.';
    case 403:
      return 'rstream denied TURN issuance (HTTP 403). The token needs turn.credentials.create and access to the configured project.';
    case 404:
      return 'rstream could not find the configured project (HTTP 404). Verify RSTREAM_PROJECT_ENDPOINT or RSTREAM_PROJECT_ID.';
    case 409:
      return 'rstream reports the project or TURN serving scope is inactive (HTTP 409).';
    case 429:
      return 'rstream rate limited TURN issuance (HTTP 429). Retry later.';
    case 503:
      return 'rstream TURN serving metadata or signing keys are unavailable (HTTP 503). Retry later.';
    default:
      return `rstream TURN credential request failed (HTTP ${status}).`;
  }
};

/** Parses and validates the documented { username, credential, urls, ttl } payload. */
export const parseRstreamTurnPayload = (
  payload: unknown
): { urls: string[]; username: string; credential: string; ttlSeconds: number } | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (!isNonEmptyString(record.username, 512)) return null;
  if (!isNonEmptyString(record.credential, 1024)) return null;

  const urls = (Array.isArray(record.urls) ? record.urls : [])
    .slice(0, 16)
    .filter((url): url is string => typeof url === 'string' && url.length <= 2048)
    .map((url) => url.trim())
    .filter((url) => TURN_URL_PATTERN.test(url));
  if (urls.length === 0) return null;

  const ttl = Number(record.ttl);
  const ttlSeconds =
    Number.isInteger(ttl) && ttl >= 1 && ttl <= RSTREAM_MAX_TTL_SECONDS
      ? ttl
      : DEFAULT_RSTREAM_TTL_SECONDS;

  return { urls, username: record.username.trim(), credential: record.credential, ttlSeconds };
};

/**
 * Requests short-lived TURN credentials from rstream and caches them until
 * shortly before they expire. Throws a safe, actionable Error on failure; the
 * token and response body are never included in the message.
 *
 * Expired cache entries are never returned. Nothing is served from cache if the
 * entry would expire within the refresh margin (10% of TTL, 5-60s).
 */
export const fetchRstreamTurnCredentials = async (
  params: RstreamRequestParams
): Promise<RstreamTurnResult> => {
  const now = params.now ?? Date.now();
  const ttlSeconds = clampRstreamTtl(params.ttlSeconds);
  const cache = params.cache ?? rstreamCache;
  // A token fingerprint (not the token) keeps cache entries tied to the
  // credential identity, so rotating the token takes effect immediately.
  const tokenFingerprint = createHash('sha256')
    .update(params.token?.trim() || '')
    .digest('hex')
    .slice(0, 16);
  const cacheKey = [
    params.baseUrl?.trim() || 'https://rstream.io',
    params.projectId || '',
    params.projectEndpoint || '',
    ttlSeconds,
    tokenFingerprint,
  ].join('|');

  const cached = cache.get(cacheKey);
  if (cached && cached.cacheExpiresAt > now && cached.expiresAt > now) return cached;

  const url = buildRstreamCredentialsUrl({
    baseUrl: params.baseUrl,
    projectId: params.projectId,
    projectEndpoint: params.projectEndpoint,
  });

  const token = params.token?.trim();
  if (!token) throw new Error('RSTREAM_AUTHENTICATION_TOKEN is not configured.');

  const timeoutMs = params.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    const fetchImpl = params.fetchImpl ?? fetch;
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ttlSeconds }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`rstream TURN credential request timed out after ${timeoutMs}ms.`);
    }
    const reason = (err as Error)?.message || 'network error';
    // Defensive: never echo the token even if a runtime included it.
    throw new Error(`rstream TURN credential request failed (${reason.split(token).join('***')}).`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(describeRstreamStatus(response.status));
  }

  const raw = await response.text().catch(() => '');
  if (raw.length > RSTREAM_MAX_RESPONSE_BYTES) {
    throw new Error('rstream returned an oversized TURN credential response.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('rstream returned a non-JSON TURN credential response.');
  }

  const parsed = parseRstreamTurnPayload(payload);
  if (!parsed) {
    throw new Error(
      'rstream returned an invalid TURN credential payload (expected non-empty username, credential and at least one turn:/turns: URL).'
    );
  }

  const ttlMs = parsed.ttlSeconds * 1000;
  const refreshMarginMs = Math.min(60_000, Math.max(5_000, Math.round(ttlMs * 0.1)));
  const result: RstreamTurnResult = {
    iceServers: [
      {
        urls: parsed.urls.length === 1 ? parsed.urls[0] : parsed.urls,
        username: parsed.username,
        credential: parsed.credential,
      },
    ],
    urls: parsed.urls,
    expiresAt: now + ttlMs,
    cacheExpiresAt: now + Math.max(0, ttlMs - refreshMarginMs),
    ttlSeconds: parsed.ttlSeconds,
  };

  if (result.cacheExpiresAt > now && result.expiresAt > now) cache.set(cacheKey, result);
  return result;
};


/**
 * Applies rstream-issued TURN servers to an ICE config.
 *
 * On failure, an existing static/ephemeral TURN configuration (`fallback`) is
 * preserved instead of dropping the relay, so a provider outage degrades to the
 * previously configured relay rather than to STUN-only. Without a fallback the
 * error is surfaced exactly like the generic provider path (fatal only for
 * `ICE_TRANSPORT_POLICY=relay`).
 */
export const mergeRstreamIceServers = (
  base: IceConfigPayload,
  provider: RstreamTurnResult | null,
  error: Error | null,
  fallback: IceConfigPayload | null = null
): { config: IceConfigPayload; providerOk: boolean } => {
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
        turn: {
          ...base.turn,
          configured: true,
          credentialMode: 'provider',
          provider: 'rstream',
          urlCount: provider.urls.length,
          expiresAt: provider.expiresAt,
          providerConfigured: true,
        },
      },
    };
  }

  const message = error?.message || 'rstream TURN credential request failed.';

  if (fallback && fallback.hasTurn) {
    return {
      providerOk: false,
      config: {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `rstream TURN unavailable; continuing with the configured static TURN relay. ${message}`,
        ],
      },
    };
  }

  const isRelay = base.iceTransportPolicy === 'relay';
  return {
    providerOk: false,
    config: {
      ...base,
      hasTurn: false,
      warnings: isRelay ? base.warnings : [...base.warnings, message],
      errors: [...base.errors, message],
      turn: {
        ...base.turn,
        configured: false,
        credentialMode: 'none',
        provider: 'rstream',
        expiresAt: null,
        providerConfigured: true,
      },
    },
  };
};

