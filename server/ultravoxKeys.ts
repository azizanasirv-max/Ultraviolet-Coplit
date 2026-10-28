/**
 * Ultravox API-key pool, failure classification and bounded failover.
 *
 * Provider semantics this module is built on (checked 2026-10; see
 * docs/deployment.md for the documented sources):
 *
 *   - Authentication uses `X-API-Key`. Keys are documented as 41 chars
 *     ("8 chars" + "." + "32 chars") and must never reach client code.
 *   - Rate limits are applied at BOTH account (500 req/s) and API-key
 *     (200 req/s) level. Call-creation limits (Free/PAYGO 5/s, 30/min; Pro
 *     10/s, 120/min) and concurrency (Free/PAYGO 5 concurrent calls) are
 *     account/plan scoped.
 *   - A 429 means "too many requests", including account-wide concurrency or
 *     call-creation limits. It is NOT proof that a key's quota is exhausted.
 *   - `Retry-After` (seconds or an HTTP date) is documented for 429 and 503.
 *   - 503 is used for capacity / priority-concurrency unavailability.
 *   - The REST docs document 401 (missing/invalid API key) and 403
 *     (insufficient authorization) separately from 429. Provider error bodies
 *     are not part of the documented schema, so the body is treated only as
 *     evidence, never as a guarantee.
 *   - Create Call has no documented idempotency key. A timed-out or
 *     network-failed POST may have created a live call, so this module never
 *     automatically retries a non-idempotent creation attempt.
 *
 * Security rules:
 *   - Raw keys live only in this module's in-memory entries and the provider
 *     request. They are never logged, returned to a browser, or put into
 *     diagnostics. Diagnostics use operator-chosen non-secret ids only.
 *   - A key id is never derived from key material; generated ids are ordinal.
 *
 * State is per process. The deployment is a single Render web service with
 * in-memory sessions, so cooldowns are lost on restart/redeploy and are never
 * shared between instances. That limitation is documented.
 */

export type UltravoxKeyHealth =
  | 'eligible'
  | 'cooling_down'
  | 'quota_exhausted'
  | 'authentication_failed';

export type UltravoxFailureCategory =
  | 'none'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'authentication'
  | 'permission'
  | 'invalid_request'
  | 'transient'
  | 'unknown';

export type UltravoxRetryAction = 'none' | 'rotate' | 'wait' | 'retry_same_key' | 'fail';

export interface UltravoxKeyEntry {
  id: string;
  /** Secret. Never log, serialise or return this field. */
  key: string;
}

export interface UltravoxKeyConfigResult {
  entries: UltravoxKeyEntry[];
  source: 'multi' | 'legacy' | 'none';
  /** Safe, key-free configuration problems. */
  errors: string[];
  /** Safe, key-free non-fatal notices. */
  warnings: string[];
}

export interface UltravoxProviderFailure {
  /** HTTP status, or 0 for a network/timeout failure. */
  status: number;
  headers?: Headers | { get(name: string): string | null } | null;
  /** Response body text, used only for keyword/reset evidence. Never logged. */
  body?: string | null;
  /** True when fetch rejected or timed out; no response was received. */
  networkError?: boolean;
  /** DELETE is idempotent; Create Call is not. */
  idempotent: boolean;
}

export interface UltravoxFailureClassification {
  category: UltravoxFailureCategory;
  action: UltravoxRetryAction;
  /** Safe machine-readable reason, suitable for logs/diagnostics. */
  reason: string;
  /** Parsed Retry-After/reset hint in ms from "now", or null. */
  retryAfterMs: number | null;
  /** Absolute provider-supplied reset time when one was found, or null. */
  resetAt: number | null;
  /** True when a create call may or may not have succeeded. */
  ambiguous: boolean;
  /** True when the documented limit is account/plan scoped. */
  accountScoped: boolean;
}

const MAX_CONFIGURED_KEYS = 10;
const MAX_CONFIG_INPUT_LENGTH = 16_384;
const MAX_EVIDENCE_LENGTH = 8_192;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const DEFAULT_AUTH_COOLDOWN_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const PLACEHOLDER_PATTERN =
  /^(?:MY_|YOUR_|REPLACE_|EXAMPLE_|CHANGEME|CHANGE_ME|TODO|<.*>|\$\{.*\})/i;

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const envNumber = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isPlaceholder = (value: string): boolean =>
  PLACEHOLDER_PATTERN.test(value) || value.toLowerCase() === 'changeme';

const validateKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 512) return null;
  // Whitespace/control characters are not part of an API key and usually mean
  // an operator pasted something else or an unquoted multi-line value.
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return null;
  if (isPlaceholder(key)) return null;
  return key;
};

/**
 * Parses `ULTRAVOX_API_KEYS`.
 *
 * Documented format (JSON, recommended):
 *   ULTRAVOX_API_KEYS='[{"id":"primary","key":"..."},{"id":"backup","key":"..."}]'
 *
 * Convenience format (single-line/multiline list):
 *   ULTRAVOX_API_KEYS='primary=...<newline>backup=...'
 *   ULTRAVOX_API_KEYS='primary=...,backup=...'
 *
 * Bare keys are accepted and receive the non-secret ids `key-1`, `key-2`, ...
 * Blank lines and `#` comment lines are ignored. A missing `id` on a JSON
 * object also receives an ordinal id. Invalid/duplicate/placeholder entries are
 * skipped with a safe error; partial configuration still works.
 */
export const parseUltravoxApiKeys = (
  raw: string
): { entries: UltravoxKeyEntry[]; errors: string[] } => {
  const entries: UltravoxKeyEntry[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const trimmedRaw = raw.trim();

  if (!trimmedRaw) return { entries, errors };
  if (trimmedRaw.length > MAX_CONFIG_INPUT_LENGTH) {
    return { entries, errors: ['ULTRAVOX_API_KEYS is too large; use at most 10 keys.'] };
  }

  type RawEntry = { id?: unknown; key?: unknown; ordinal: number };
  const rawEntries: RawEntry[] = [];

  if (trimmedRaw.startsWith('{')) {
    return {
      entries,
      errors: ['ULTRAVOX_API_KEYS must be a JSON array of {id, key} objects.'],
    };
  }

  if (trimmedRaw.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedRaw);
    } catch {
      return {
        entries,
        errors: ['ULTRAVOX_API_KEYS is not valid JSON; expected an array of {id, key} objects.'],
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        entries,
        errors: ['ULTRAVOX_API_KEYS must be a JSON array of {id, key} objects.'],
      };
    }
    parsed.forEach((item, index) => {
      if (typeof item === 'string') rawEntries.push({ key: item, ordinal: index });
      else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        rawEntries.push({ id: record.id, key: record.key ?? record.apiKey, ordinal: index });
      } else {
        errors.push(
          `ULTRAVOX_API_KEYS entry ${index + 1} must be a string or an {id, key} object.`
        );
      }
    });
  } else {
    const lines = trimmedRaw
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    lines.forEach((line, index) => {
      const separator = line.indexOf('=');
      if (separator > 0 && separator < line.length - 1) {
        rawEntries.push({
          id: line.slice(0, separator).trim(),
          key: line.slice(separator + 1).trim(),
          ordinal: index,
        });
      } else {
        rawEntries.push({ key: line, ordinal: index });
      }
    });
  }

  for (const rawEntry of rawEntries) {
    if (entries.length >= MAX_CONFIGURED_KEYS) {
      errors.push(
        `ULTRAVOX_API_KEYS has more than ${MAX_CONFIGURED_KEYS} keys; the rest were ignored.`
      );
      break;
    }
    const ordinalId = `key-${rawEntry.ordinal + 1}`;
    const idValue =
      rawEntry.id === undefined || rawEntry.id === null || rawEntry.id === ''
        ? ordinalId
        : rawEntry.id;
    const id = typeof idValue === 'string' ? idValue.trim() : '';
    if (!id || !KEY_ID_PATTERN.test(id)) {
      errors.push(
        `ULTRAVOX_API_KEYS entry ${rawEntry.ordinal + 1} has an invalid id; use letters, digits, ".", "_" or "-" (max 32 chars).`
      );
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(
        `ULTRAVOX_API_KEYS entry ${rawEntry.ordinal + 1} repeats id "${id}"; it was ignored.`
      );
      continue;
    }
    const key = validateKey(rawEntry.key);
    if (!key) {
      errors.push(
        `ULTRAVOX_API_KEYS entry ${rawEntry.ordinal + 1} ("${id}") is empty, a placeholder, or not a valid key; it was ignored.`
      );
      continue;
    }
    if (seenKeys.has(key)) {
      errors.push(
        `ULTRAVOX_API_KEYS entry ${rawEntry.ordinal + 1} ("${id}") repeats an earlier key; it was ignored.`
      );
      continue;
    }
    seenIds.add(id);
    seenKeys.add(key);
    entries.push({ id, key });
  }

  return { entries, errors };
};


/**
 * Resolves the effective key configuration.
 *
 * Backward compatibility: when `ULTRAVOX_API_KEYS` is absent/empty, the legacy
 * single `ULTRAVOX_API_KEY` is used with the non-secret id `default`.
 * If both are present, the multi-key variable wins (the legacy one is ignored
 * with a warning). If the multi-key variable is present but yields no usable
 * key, a valid legacy key is used as a safe fallback with a warning rather than
 * taking the AI down because of a typo.
 */
export const resolveUltravoxKeyConfig = (
  env: NodeJS.ProcessEnv = process.env
): UltravoxKeyConfigResult => {
  const multiRaw = typeof env.ULTRAVOX_API_KEYS === 'string' ? env.ULTRAVOX_API_KEYS.trim() : '';
  const legacyRaw = typeof env.ULTRAVOX_API_KEY === 'string' ? env.ULTRAVOX_API_KEY.trim() : '';

  if (multiRaw) {
    const parsed = parseUltravoxApiKeys(multiRaw);
    if (parsed.entries.length > 0) {
      const warnings = legacyRaw
        ? ['ULTRAVOX_API_KEY is ignored because ULTRAVOX_API_KEYS is configured.']
        : [];
      return { entries: parsed.entries, source: 'multi', errors: parsed.errors, warnings };
    }
    const legacyKey = validateKey(legacyRaw);
    if (legacyKey) {
      return {
        entries: [{ id: 'default', key: legacyKey }],
        source: 'legacy',
        errors: parsed.errors,
        warnings: [
          'ULTRAVOX_API_KEYS is invalid or empty; falling back to the legacy ULTRAVOX_API_KEY.',
        ],
      };
    }
    return {
      entries: [],
      source: 'none',
      errors: parsed.errors.length
        ? parsed.errors
        : ['ULTRAVOX_API_KEYS did not contain a usable key.'],
      warnings: [],
    };
  }

  const legacyKey = validateKey(legacyRaw);
  if (!legacyKey) {
    return {
      entries: [],
      source: 'none',
      errors: [],
      warnings: legacyRaw
        ? ['ULTRAVOX_API_KEY is a placeholder or invalid; AI suggestions stay disabled.']
        : [],
    };
  }
  return {
    entries: [{ id: 'default', key: legacyKey }],
    source: 'legacy',
    errors: [],
    warnings: [],
  };
};

/** Parses `Retry-After` seconds or an HTTP date. Returns ms from `now`. */
export const parseRetryAfterMs = (
  headers: UltravoxProviderFailure['headers'],
  now: number
): number | null => {
  const value = headers?.get?.('retry-after')?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.max(0, Number(value) * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
};

const toTimestamp = (value: unknown, now: number): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds (~1.7e9) vs epoch milliseconds (~1.7e12).
    return value > 1e12 ? value : value > 1e9 ? value * 1000 : now + value * 1000;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return toTimestamp(Number(trimmed), now);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Looks for documented reset information in a provider error body. The body is
 * not a documented schema, so only conservative, well-known keys are read.
 */
export const parseResetFromBody = (
  body: string | null | undefined,
  now: number
): number | null => {
  if (!body) return null;
  const text = body.slice(0, MAX_EVIDENCE_LENGTH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const candidateKeys = new Set([
    'retryafter',
    'retry_after',
    'retryafterseconds',
    'retry_after_seconds',
    'resetat',
    'reset_at',
    'resetsat',
    'resets_at',
    'quota_reset_at',
    'quotaresetat',
    'periodend',
    'period_end',
  ]);
  let found: number | null = null;
  const visit = (value: unknown, depth: number): void => {
    if (!value || depth > 2 || found !== null) return;
    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (candidateKeys.has(key.toLowerCase().replace(/[^a-z0-9_]/g, ''))) {
        const timestamp = toTimestamp(item, now);
        if (timestamp !== null) {
          found = timestamp;
          return;
        }
      }
      visit(item, depth + 1);
    }
  };
  visit(parsed, 0);
  if (found !== null) return found;

  // Plain-text fallback: "retry after 30 seconds", "reset in 2 minutes".
  const match = text.match(/retry[\s_-]*after[^0-9]{0,8}(\d{1,6})/i);
  if (match) return now + Number(match[1]) * 1000;
  return null;
};


const truncateEvidence = (body: string | null | undefined): string =>
  typeof body === 'string' ? body.slice(0, MAX_EVIDENCE_LENGTH).toLowerCase() : '';

const QUOTA_EVIDENCE =
  /quota|insufficient[ _-]?(?:credit|credits|fund|funds|balance)|credit balance|out of credits|exceeded your (?:plan|usage)|billing|payment required/;
const CONCURRENCY_EVIDENCE =
  /concurren|simultaneous|too many active|account[ _-]?(?:limit|wide|level)|plan[ _-]?limit|global limit/;
const KEY_LIMIT_EVIDENCE = /api[ _-]?key|per[ _-]?key|key[ _-]?limit|key[ _-]?quota/;

/**
 * Classifies one provider failure.
 *
 * The rules are intentionally conservative:
 *   - 401/403 (without explicit quota wording) never cycle through keys.
 *   - 400/404/409/413/415/422 never retry; the request itself is wrong.
 *   - 429 is a rate/concurrency limit, not a quota exhaustion, unless the body
 *     contains explicit quota/billing evidence.
 *   - Account/plan concurrency evidence returns `wait` (honour Retry-After)
 *     instead of rotating, because the docs say those limits are account-wide.
 *   - Network/5xx failures never mark a key exhausted. Non-idempotent Create
 *     Call requests are never automatically retried because the outcome is
 *     ambiguous.
 */
export const classifyUltravoxFailure = (
  failure: UltravoxProviderFailure,
  options: { now?: number } = {}
): UltravoxFailureClassification => {
  const now = options.now ?? Date.now();
  const retryAfterMs = failure.networkError ? null : parseRetryAfterMs(failure.headers, now);
  const resetAt = failure.networkError ? null : parseResetFromBody(failure.body, now);
  const evidence = truncateEvidence(failure.body);
  const base = {
    retryAfterMs,
    resetAt,
    ambiguous: false,
    accountScoped: false,
  };

  if (failure.networkError) {
    return {
      ...base,
      category: 'transient',
      action: failure.idempotent ? 'retry_same_key' : 'fail',
      reason: 'network_error',
      ambiguous: true,
    };
  }

  const status = failure.status;
  if (status === 401) {
    return {
      ...base,
      category: 'authentication',
      action: 'fail',
      reason: 'http-401-invalid-api-key',
    };
  }
  if (status === 402) {
    return {
      ...base,
      category: 'quota_exhausted',
      action: 'rotate',
      reason: 'http-402-payment-required',
    };
  }
  if (status === 403) {
    if (QUOTA_EVIDENCE.test(evidence)) {
      return {
        ...base,
        category: 'quota_exhausted',
        action: 'rotate',
        reason: 'http-403-quota-evidence',
      };
    }
    return {
      ...base,
      category: 'permission',
      action: 'fail',
      reason: 'http-403-insufficient-authorization',
    };
  }
  if (status === 429) {
    if (QUOTA_EVIDENCE.test(evidence)) {
      return {
        ...base,
        category: 'quota_exhausted',
        action: 'rotate',
        reason: 'http-429-quota-evidence',
        accountScoped: CONCURRENCY_EVIDENCE.test(evidence) && !KEY_LIMIT_EVIDENCE.test(evidence),
      };
    }
    if (CONCURRENCY_EVIDENCE.test(evidence) && !KEY_LIMIT_EVIDENCE.test(evidence)) {
      return {
        ...base,
        category: 'rate_limited',
        action: 'wait',
        reason: 'http-429-account-concurrency',
        accountScoped: true,
      };
    }
    return {
      ...base,
      category: 'rate_limited',
      action: 'rotate',
      reason: KEY_LIMIT_EVIDENCE.test(evidence)
        ? 'http-429-api-key-rate-limit'
        : 'http-429-rate-limit',
      accountScoped: false,
    };
  }
  if (status === 408) {
    return {
      ...base,
      category: 'transient',
      action: failure.idempotent ? 'retry_same_key' : 'fail',
      reason: 'http-408-request-timeout',
      ambiguous: !failure.idempotent,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      ...base,
      category: 'transient',
      action: failure.idempotent ? 'retry_same_key' : 'fail',
      reason: `http-${status}-provider-unavailable`,
      ambiguous: !failure.idempotent,
    };
  }
  if ([400, 404, 409, 413, 415, 422].includes(status)) {
    return {
      ...base,
      category: 'invalid_request',
      action: 'fail',
      reason: `http-${status}-invalid-request`,
    };
  }
  if (status >= 400 && status <= 499) {
    return {
      ...base,
      category: 'invalid_request',
      action: 'fail',
      reason: `http-${status}-rejected`,
    };
  }
  return {
    ...base,
    category: 'unknown',
    action: 'fail',
    reason: `unclassified-status-${status || 'none'}`,
  };
};


interface KeyRuntime {
  id: string;
  key: string;
  blockedUntil: number;
  blockedReason: 'rate_limited' | 'quota_exhausted' | 'authentication_failed' | null;
  rateLimitStrikes: number;
  lastErrorCategory: UltravoxFailureCategory | null;
  lastErrorReason: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
}

export interface UltravoxKeyPoolOptions {
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  /** Fallback cooldown when the provider gives no reset hint. */
  quotaCooldownMs?: number;
  rateLimitCooldownMs?: number;
  authCooldownMs?: number;
  maxRateLimitCooldownMs?: number;
  maxQuotaCooldownMs?: number;
  /** Bounded attempt budget per logical operation (1..5). */
  maxAttempts?: number;
}

export interface UltravoxKeyOperationSummary {
  selectedKeyId: string | null;
  attempts: number;
  failover: boolean;
  succeeded: boolean;
  finalCategory: UltravoxFailureCategory;
  finalAction: UltravoxRetryAction;
  finalReason: string | null;
  allKeysExhausted: boolean;
  retryAfterSeconds: number | null;
}

export interface UltravoxKeyPublicState {
  id: string;
  health: UltravoxKeyHealth;
  availableAt: string | null;
  availableInSeconds: number;
  lastErrorCategory: UltravoxFailureCategory | null;
  lastErrorReason: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  rateLimitStrikes: number;
}

export interface UltravoxKeyDiagnostics {
  configuredCount: number;
  eligibleCount: number;
  coolingDownCount: number;
  quotaExhaustedCount: number;
  authenticationFailedCount: number;
  source: UltravoxKeyConfigResult['source'];
  maxAttempts: number;
  configErrors: string[];
  configWarnings: string[];
  lastOperation: UltravoxKeyOperationSummary | null;
  keys: UltravoxKeyPublicState[];
}

/**
 * Per-process key state and selection.
 *
 * All mutations are synchronous (Node's event loop cannot interleave them), and
 * cooldown writes use `Math.max`, so two concurrent failures can only extend a
 * cooldown — never clear or shorten another request's evidence. Expiry is the
 * only path back to `eligible`, so a success does not erase a cooldown another
 * in-flight request just recorded.
 */
export class UltravoxKeyPool {
  private entries: KeyRuntime[] = [];
  private config: UltravoxKeyConfigResult = {
    entries: [],
    source: 'none',
    errors: [],
    warnings: [],
  };
  private configFingerprint = '';
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => number;
  private readonly quotaCooldownMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly authCooldownMs: number;
  private readonly maxRateLimitCooldownMs: number;
  private readonly maxQuotaCooldownMs: number;
  private readonly maxAttempts: number;
  private lastOperation: UltravoxKeyOperationSummary | null = null;

  constructor(options: UltravoxKeyPoolOptions = {}) {
    this.env = options.env ?? process.env;
    this.clock = options.clock ?? Date.now;
    this.quotaCooldownMs = clamp(
      options.quotaCooldownMs ??
        envNumber(
          this.env,
          'ULTRAVOX_KEY_QUOTA_COOLDOWN_SECONDS',
          DEFAULT_QUOTA_COOLDOWN_MS / 1000
        ) * 1000,
      60_000,
      MAX_QUOTA_COOLDOWN_MS
    );
    this.rateLimitCooldownMs = clamp(
      options.rateLimitCooldownMs ??
        envNumber(
          this.env,
          'ULTRAVOX_KEY_RATE_LIMIT_COOLDOWN_SECONDS',
          DEFAULT_RATE_LIMIT_COOLDOWN_MS / 1000
        ) * 1000,
      1_000,
      60_000
    );
    this.authCooldownMs = clamp(
      options.authCooldownMs ??
        envNumber(this.env, 'ULTRAVOX_KEY_AUTH_COOLDOWN_SECONDS', DEFAULT_AUTH_COOLDOWN_MS / 1000) *
          1000,
      30_000,
      60 * 60_000
    );
    this.maxRateLimitCooldownMs = clamp(
      options.maxRateLimitCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS,
      1_000,
      MAX_QUOTA_COOLDOWN_MS
    );
    this.maxQuotaCooldownMs = clamp(
      options.maxQuotaCooldownMs ?? MAX_QUOTA_COOLDOWN_MS,
      60_000,
      MAX_QUOTA_COOLDOWN_MS
    );
    this.maxAttempts = clamp(
      Math.floor(
        options.maxAttempts ??
          envNumber(this.env, 'ULTRAVOX_MAX_KEY_ATTEMPTS', DEFAULT_MAX_ATTEMPTS)
      ),
      1,
      5
    );
    this.refresh(true);
  }

  /** Safe one-line summary; contains no key material. */
  summaryForLog(): string {
    return `${this.entries.length} configured key(s), source=${this.config.source}, attempt budget=${this.attemptBudget()}`;
  }

  get configuredCount(): number {
    return this.entries.length;
  }

  get source(): UltravoxKeyConfigResult['source'] {
    return this.config.source;
  }

  get configErrors(): string[] {
    return [...this.config.errors];
  }

  get configWarnings(): string[] {
    return [...this.config.warnings];
  }

  hasKeys(): boolean {
    return this.entries.length > 0;
  }

  attemptBudget(): number {
    return Math.min(this.entries.length, this.maxAttempts);
  }


  /**
   * Re-reads key configuration. Cooldown state is preserved while the key
   * configuration is unchanged; it is reset only when keys actually change
   * (a redeploy/config edit invalidates old cooldown evidence).
   */
  refresh(force = false): boolean {
    const multi = typeof this.env.ULTRAVOX_API_KEYS === 'string' ? this.env.ULTRAVOX_API_KEYS : '';
    const legacy = typeof this.env.ULTRAVOX_API_KEY === 'string' ? this.env.ULTRAVOX_API_KEY : '';
    // Non-cryptographic fingerprint over the raw values. It is kept in memory
    // only and is never logged; it lets a running process notice an env change
    // (including in tests) without rebuilding state on every request.
    let hash = 2166136261;
    for (const value of [multi, legacy]) {
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 0x9e3779b9;
    }
    const fingerprint = `${multi.length}:${legacy.length}:${hash >>> 0}`;
    if (!force && fingerprint === this.configFingerprint) return false;

    const previous = new Map(this.entries.map((entry) => [entry.id, entry]));
    const nextConfig = resolveUltravoxKeyConfig(this.env);
    this.config = nextConfig;
    this.entries = nextConfig.entries.map((entry) => {
      const existing = previous.get(entry.id);
      // Reuse state only when the id still maps to the same key. Key material is
      // compared in memory and never emitted.
      if (existing && existing.key === entry.key) return existing;
      return {
        id: entry.id,
        key: entry.key,
        blockedUntil: 0,
        blockedReason: null,
        rateLimitStrikes: 0,
        lastErrorCategory: null,
        lastErrorReason: null,
        lastErrorAt: null,
        lastSuccessAt: null,
      };
    });
    this.configFingerprint = fingerprint;
    // A pool with no keys cannot have a meaningful "last operation".
    if (this.entries.length === 0) this.lastOperation = null;
    else if (this.lastOperation && this.lastOperation.selectedKeyId) {
      const stillExists = this.entries.some(
        (entry) => entry.id === this.lastOperation?.selectedKeyId
      );
      if (!stillExists) this.lastOperation = null;
    }
    return true;
  }

  healthOf(entry: KeyRuntime, now: number): UltravoxKeyHealth {
    if (entry.blockedUntil > now && entry.blockedReason) {
      if (entry.blockedReason === 'quota_exhausted') return 'quota_exhausted';
      if (entry.blockedReason === 'authentication_failed') return 'authentication_failed';
      return 'cooling_down';
    }
    return 'eligible';
  }

  /** Expires cooldowns in place. Called before every selection/read. */
  private expire(now: number): void {
    for (const entry of this.entries) {
      if (entry.blockedUntil > 0 && entry.blockedUntil <= now) {
        entry.blockedUntil = 0;
        entry.blockedReason = null;
        // Once the documented Retry-After window has passed, the next failure
        // starts a fresh backoff rather than escalating stale strikes.
        entry.rateLimitStrikes = 0;
      }
    }
  }

  /** Deterministic config-order selection of the first eligible key. */
  select(excludeIds: ReadonlySet<string> = new Set()): UltravoxKeyEntry | null {
    const now = this.clock();
    this.expire(now);
    for (const entry of this.entries) {
      if (excludeIds.has(entry.id)) continue;
      if (this.healthOf(entry, now) === 'eligible') return { id: entry.id, key: entry.key };
    }
    return null;
  }

  /** Raw key for a configured id, used only for best-effort cleanup. */
  keyForId(id: string | null | undefined): UltravoxKeyEntry | null {
    if (!id) return null;
    const entry = this.entries.find((candidate) => candidate.id === id);
    return entry ? { id: entry.id, key: entry.key } : null;
  }

  /** First configured key regardless of cooldown, for best-effort cleanup. */
  firstConfiguredKey(): UltravoxKeyEntry | null {
    const entry = this.entries[0];
    return entry ? { id: entry.id, key: entry.key } : null;
  }


  /**
   * Records a rate-limit cooldown. `retryAfterMs` (documented) wins over the
   * exponentiated fallback; the larger of the existing and new deadline is
   * kept so concurrent failures cannot shorten each other's evidence.
   */
  markRateLimited(id: string, retryAfterMs: number | null, reason = 'rate_limited'): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    const now = this.clock();
    entry.rateLimitStrikes += 1;
    const backoff = Math.min(
      this.rateLimitCooldownMs * Math.pow(2, Math.max(0, entry.rateLimitStrikes - 1)),
      this.maxRateLimitCooldownMs
    );
    const cooldown = clamp(retryAfterMs ?? backoff, 1_000, this.maxRateLimitCooldownMs);
    const target = now + cooldown;
    this.noteFailure(entry, 'rate_limited', reason, now);
    if (target > entry.blockedUntil) {
      entry.blockedUntil = target;
      entry.blockedReason = 'rate_limited';
    } else if (entry.blockedReason === null) {
      entry.blockedReason = 'rate_limited';
    }
  }

  /** Records a quota-exhaustion cooldown for the documented/configured window. */
  markQuotaExhausted(id: string, resetAt: number | null, reason = 'quota_exhausted'): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    const now = this.clock();
    const fallback = now + this.quotaCooldownMs;
    const target = clamp(
      Math.max(resetAt ?? fallback, now + 60_000),
      now + 60_000,
      now + this.maxQuotaCooldownMs
    );
    this.noteFailure(entry, 'quota_exhausted', reason, now);
    if (target > entry.blockedUntil) {
      entry.blockedUntil = target;
      entry.blockedReason = 'quota_exhausted';
    }
  }

  /**
   * Marks an authentication failure for diagnostics and a short local cooldown.
   * The operation does NOT rotate after this: cycling every key on a credential
   * or permission problem only hides the configuration error.
   */
  markAuthenticationFailed(id: string, reason = 'http-401-invalid-api-key'): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    const now = this.clock();
    this.noteFailure(entry, 'authentication', reason, now);
    const target = now + this.authCooldownMs;
    if (target > entry.blockedUntil) {
      entry.blockedUntil = target;
      entry.blockedReason = 'authentication_failed';
    }
  }

  private noteFailure(
    entry: KeyRuntime,
    category: UltravoxFailureCategory,
    reason: string,
    now: number
  ): void {
    entry.lastErrorCategory = category;
    entry.lastErrorReason = reason;
    entry.lastErrorAt = now;
  }

  /**
   * Records a successful provider call. It deliberately does not clear a
   * cooldown: another concurrent request may have recorded a newer 429 while
   * this request was in flight. Cooldowns expire only by time.
   */
  noteSuccess(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    const now = this.clock();
    entry.lastSuccessAt = now;
    if (entry.blockedUntil <= now) {
      entry.blockedUntil = 0;
      entry.blockedReason = null;
    }
  }

  recordOperation(summary: UltravoxKeyOperationSummary): void {
    this.lastOperation = { ...summary };
  }

  /** Non-secret diagnostics. Safe for the salesperson diagnostics endpoint. */
  diagnostics(): UltravoxKeyDiagnostics {
    const now = this.clock();
    this.expire(now);
    const keys: UltravoxKeyPublicState[] = this.entries.map((entry) => {
      const health = this.healthOf(entry, now);
      const remaining = health === 'eligible' ? 0 : Math.max(0, entry.blockedUntil - now);
      return {
        id: entry.id,
        health,
        availableAt: health === 'eligible' ? null : new Date(entry.blockedUntil).toISOString(),
        availableInSeconds: Math.ceil(remaining / 1000),
        lastErrorCategory: entry.lastErrorCategory,
        lastErrorReason: entry.lastErrorReason,
        lastErrorAt: entry.lastErrorAt === null ? null : new Date(entry.lastErrorAt).toISOString(),
        lastSuccessAt:
          entry.lastSuccessAt === null ? null : new Date(entry.lastSuccessAt).toISOString(),
        rateLimitStrikes: entry.rateLimitStrikes,
      };
    });
    const count = (health: UltravoxKeyHealth) =>
      keys.filter((key) => key.health === health).length;
    return {
      configuredCount: this.entries.length,
      eligibleCount: count('eligible'),
      coolingDownCount: count('cooling_down'),
      quotaExhaustedCount: count('quota_exhausted'),
      authenticationFailedCount: count('authentication_failed'),
      source: this.config.source,
      maxAttempts: this.attemptBudget(),
      configErrors: [...this.config.errors],
      configWarnings: [...this.config.warnings],
      lastOperation: this.lastOperation ? { ...this.lastOperation } : null,
      keys,
    };
  }

  /** Seconds until any key becomes eligible again, for a Retry-After hint. */
  secondsUntilNextEligible(): number | null {
    const now = this.clock();
    this.expire(now);
    const waits = this.entries
      .filter((entry) => entry.blockedUntil > now)
      .map((entry) => entry.blockedUntil - now);
    if (waits.length === 0) return null;
    return Math.max(1, Math.ceil(Math.min(...waits) / 1000));
  }
}

export const createUltravoxKeyPool = (
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<UltravoxKeyPoolOptions, 'env'> = {}
): UltravoxKeyPool => new UltravoxKeyPool({ ...options, env });

/** Safe, key-free classification message for logs. */
export const describeFailureForLog = (
  classification: UltravoxFailureClassification,
  status: number,
  keyId: string | null
): string =>
  `[ai] Ultravox attempt key=${keyId ?? 'none'} status=${status || 'network'} ` +
  `category=${classification.category} action=${classification.action} reason=${classification.reason}`;

