/**
 * ExpressTURN short-lived credential generation.
 *
 * Algorithm verified against the official documentation
 * https://www.expressturn.com/webrtc-secret-key-examples :
 *
 *   username   = "<unix expiry seconds>:<user id>"
 *   credential = base64(HMAC-SHA1(shared secret key, username))
 *   ICE entry  = { urls: ["turn:free.expressturn.com:3478"], username, credential }
 *
 * The secret key stays server-side; only the derived, expiring username and
 * credential are ever sent to authorized browsers.
 */
import { createHmac } from 'crypto';

export interface ExpressTurnServerSettings {
  host: string;
  port: number;
  ttlSeconds: number;
  secretKey: string;
  /** Last admin update (epoch ms). */
  updatedAt: number;
}

export interface ExpressTurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  ttlSeconds: number;
  /** Credential expiry (epoch ms). */
  expiresAt: number;
}

export const DEFAULT_EXPRESSTURN_HOST = 'free.expressturn.com';
export const DEFAULT_EXPRESSTURN_PORT = 3478;
export const DEFAULT_EXPRESSTURN_TTL_SECONDS = 3600;
export const MIN_EXPRESSTURN_TTL_SECONDS = 300;
export const MAX_EXPRESSTURN_TTL_SECONDS = 86_400;
export const MAX_EXPRESSTURN_SECRET_LENGTH = 256;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const USER_ID_PATTERN = /[^A-Za-z0-9._-]+/g;

/** TURN hostname or IPv4 literal; no scheme, path, port or whitespace. */
export const isValidExpressTurnHost = (host: string): boolean =>
  typeof host === 'string' &&
  host.length > 0 &&
  host.length <= 253 &&
  (HOSTNAME_PATTERN.test(host) || IPV4_PATTERN.test(host));

export const normalizeExpressTurnPort = (raw: unknown): number | null => {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
};

export const normalizeExpressTurnTtlSeconds = (raw: unknown): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXPRESSTURN_TTL_SECONDS;
  return Math.min(
    Math.max(Math.round(parsed), MIN_EXPRESSTURN_TTL_SECONDS),
    MAX_EXPRESSTURN_TTL_SECONDS
  );
};

export interface ExpressTurnSettingsInput {
  host: unknown;
  port: unknown;
  ttlSeconds?: unknown;
  secretKey?: unknown;
}

export interface ExpressTurnValidationResult {
  ok: boolean;
  errors: string[];
  value?: Omit<ExpressTurnServerSettings, 'secretKey' | 'updatedAt'>;
  secretKey?: string;
}

/**
 * Validates admin input / decrypted settings. The secret is never echoed in
 * errors or returned in `value`.
 */
export const validateExpressTurnSettings = (input: ExpressTurnSettingsInput): ExpressTurnValidationResult => {
  const errors: string[] = [];
  const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
  if (!isValidExpressTurnHost(host)) {
    errors.push('TURN hostname must be a hostname or IPv4 address, without scheme, path or port.');
  }

  const port = normalizeExpressTurnPort(input.port);
  if (port === null) errors.push('TURN port must be an integer between 1 and 65535.');

  const ttlSeconds = normalizeExpressTurnTtlSeconds(input.ttlSeconds ?? DEFAULT_EXPRESSTURN_TTL_SECONDS);
  if (input.ttlSeconds !== undefined) {
    const raw = Number(input.ttlSeconds);
    if (!Number.isFinite(raw) || raw <= 0) {
      errors.push('TTL must be a positive number of seconds.');
    } else if (raw < MIN_EXPRESSTURN_TTL_SECONDS || raw > MAX_EXPRESSTURN_TTL_SECONDS) {
      errors.push(
        `TTL must be between ${MIN_EXPRESSTURN_TTL_SECONDS} and ${MAX_EXPRESSTURN_TTL_SECONDS} seconds.`
      );
    }
  }

  let secretKey: string | undefined;
  if (input.secretKey !== undefined) {
    if (typeof input.secretKey !== 'string') {
      errors.push('Secret key must be a string.');
    } else {
      const trimmed = input.secretKey.trim();
      if (trimmed.length < 8 || trimmed.length > MAX_EXPRESSTURN_SECRET_LENGTH) {
        errors.push(
          `Secret key must be between 8 and ${MAX_EXPRESSTURN_SECRET_LENGTH} characters (whitespace is trimmed).`
        );
      } else {
        secretKey = trimmed;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { host, port: port as number, ttlSeconds },
    ...(secretKey ? { secretKey } : {}),
  };
};

/** `turn:host:port?transport=udp` and the TCP variant on the same port. */
export const buildExpressTurnUrls = (host: string, port: number): string[] => [
  `turn:${host}:${port}?transport=udp`,
  `turn:${host}:${port}?transport=tcp`,
];

const sanitizeUserId = (userId: string | undefined): string => {
  const cleaned = (userId || '').replace(USER_ID_PATTERN, '').slice(0, 64);
  return cleaned || 'participant';
};

/**
 * Official ExpressTURN credential derivation. Deterministic for a given `now`,
 * which is what the tests assert against.
 */
export const generateExpressTurnCredentials = (params: {
  secretKey: string;
  host: string;
  port: number;
  ttlSeconds?: number;
  userId?: string;
  now?: number;
}): ExpressTurnCredentials => {
  if (!params.secretKey) throw new Error('ExpressTURN secret key is not configured.');
  if (!isValidExpressTurnHost(params.host)) throw new Error('ExpressTURN host is invalid.');
  if (normalizeExpressTurnPort(params.port) === null) throw new Error('ExpressTURN port is invalid.');

  const ttlSeconds = normalizeExpressTurnTtlSeconds(params.ttlSeconds ?? DEFAULT_EXPRESSTURN_TTL_SECONDS);
  const now = params.now ?? Date.now();
  const expiresAtSeconds = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiresAtSeconds}:${sanitizeUserId(params.userId)}`;
  const credential = createHmac('sha1', params.secretKey).update(username).digest('base64');

  return {
    urls: buildExpressTurnUrls(params.host, params.port),
    username,
    credential,
    ttlSeconds,
    expiresAt: expiresAtSeconds * 1000,
  };
};

