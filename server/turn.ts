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
export type TurnCredentialMode = 'ephemeral' | 'static' | 'none';

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
      warnings.push(
        'TURN uses static credentials. Prefer TURN_SECRET (coturn REST credentials) so browsers receive short-lived credentials.'
      );
    } else {
      errors.push(
        'TURN_URLS is set but TURN authentication is missing. Configure TURN_SECRET (preferred) or both TURN_USERNAME and TURN_CREDENTIAL. Without credentials the relay will reject every allocation.'
      );
    }
  } else if (settings.username || settings.credential || settings.secret) {
    warnings.push('TURN credentials are configured but TURN_URLS is empty; no relay will be used.');
  }

  const usableTurn =
    settings.turnUrls.length > 0 && credentialMode !== 'none' && !settings.invalidTurnUrls.length;

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
