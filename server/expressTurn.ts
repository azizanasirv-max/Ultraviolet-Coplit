/**
 * ExpressTURN credentials entered by the operator at /admin/turn.
 *
 * The ExpressTURN **free** plan gives a TURN server URL, a username and a
 * password (long-term credential mechanism, `lt-cred-mech`). It does NOT give a
 * Secret Key: shared-secret (`static-auth-secret`) authentication is a Premium
 * feature. Therefore no HMAC credential derivation happens anywhere: the
 * operator's username and password are passed to the ICE configuration exactly
 * as supplied.
 *
 * Storage is intentionally a module-level variable: the credentials live only in
 * this server process's memory and disappear on restart. The /admin/turn setup
 * password (server/admin.ts) is process-local too, so a restart clears the
 * password hash and the credentials together and the page returns to first-time
 * setup. Nothing is written to disk, a database or an environment variable.
 */

export interface ExpressTurnCredentials {
  /** TURN URLs exactly as supplied (bare `host:port` is prefixed with `turn:`). */
  urls: string[];
  username: string;
  credential: string;
  /** Last admin save (epoch ms). */
  updatedAt: number;
}

export interface ExpressTurnStatus {
  configured: boolean;
  urlCount: number;
  updatedAt: number | null;
  /** Always `memory`: credentials are not persisted. */
  storage: 'memory';
}

export interface ExpressTurnInput {
  serverAddress: unknown;
  username: unknown;
  password: unknown;
}

export class ExpressTurnValidationError extends Error {}

export const MAX_EXPRESSTURN_FIELD_LENGTH = 512;

// turn:host[:port][?transport=udp] | turns:host[:port][?transport=tcp]
const TURN_URL_PATTERN =
  /^turns?:(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?(?:\?[^,\s]+)?$/;

const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

const assertValidPort = (url: string): void => {
  const portMatch = url.match(/:(\d{1,5})(?:\?|$)/);
  if (!portMatch) return;
  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ExpressTurnValidationError('TURN server port must be between 1 and 65535.');
  }
};

/**
 * Normalizes the TURN server URL/address from the ExpressTURN dashboard.
 * Accepts `turn:`/`turns:` URLs, or a bare `host[:port]` (prefixed with `turn:`),
 * comma/newline separated for multiple entries. Invalid input is rejected
 * without echoing the submitted value.
 */
export const parseExpressTurnServerAddress = (raw: unknown): string[] => {
  if (typeof raw !== 'string') {
    throw new ExpressTurnValidationError('TURN server address is required.');
  }

  const entries = raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new ExpressTurnValidationError('TURN server address is required.');
  }
  if (entries.length > 8) {
    throw new ExpressTurnValidationError('Enter at most 8 TURN server URLs.');
  }

  const urls: string[] = [];
  for (const entry of entries) {
    if (hasControlCharacters(entry) || entry.length > 300) {
      throw new ExpressTurnValidationError('TURN server address is not a valid turn:/turns: URL.');
    }

    const url = /^turns?:/i.test(entry) ? entry : `turn:${entry}`;
    if (!TURN_URL_PATTERN.test(url)) {
      throw new ExpressTurnValidationError(
        'TURN server address must look like turn:host:3478 (or turns:host:5349), without a path.'
      );
    }
    assertValidPort(url);
    if (!urls.includes(url)) urls.push(url);
  }

  return urls;
};

const readCredentialField = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new ExpressTurnValidationError(`${label} is required.`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new ExpressTurnValidationError(`${label} is required.`);
  }
  if (value !== value.trim()) {
    // Never silently modify a credential: reject surrounding whitespace instead.
    throw new ExpressTurnValidationError(`${label} must not start or end with whitespace.`);
  }
  if (value.length > MAX_EXPRESSTURN_FIELD_LENGTH) {
    throw new ExpressTurnValidationError(
      `${label} must be at most ${MAX_EXPRESSTURN_FIELD_LENGTH} characters.`
    );
  }
  if (hasControlCharacters(value)) {
    throw new ExpressTurnValidationError(`${label} must not contain control characters.`);
  }
  return value;
};

/** Validates operator input. Error messages never echo a submitted value. */
export const validateExpressTurnCredentials = (
  input: ExpressTurnInput,
  now = Date.now()
): ExpressTurnCredentials => ({
  urls: parseExpressTurnServerAddress(input.serverAddress),
  username: readCredentialField(input.username, 'TURN username'),
  credential: readCredentialField(input.password, 'TURN password'),
  updatedAt: now,
});

// Process-local storage. Losing this on restart is expected and acceptable.
let stored: ExpressTurnCredentials | null = null;

/** Replaces the in-memory credentials with validated operator input. */
export const setExpressTurnCredentials = (
  input: ExpressTurnInput,
  now = Date.now()
): ExpressTurnCredentials => {
  stored = validateExpressTurnCredentials(input, now);
  return stored;
};

export const getExpressTurnCredentials = (): ExpressTurnCredentials | null => stored;

/** Drops the in-memory credentials (admin "clear" action / tests). */
export const clearExpressTurnCredentials = (): void => {
  stored = null;
};

/** Safe status for the admin page: no URL, username or password. */
export const getExpressTurnStatus = (): ExpressTurnStatus => ({
  configured: stored !== null,
  urlCount: stored?.urls.length ?? 0,
  updatedAt: stored?.updatedAt ?? null,
  storage: 'memory',
});
