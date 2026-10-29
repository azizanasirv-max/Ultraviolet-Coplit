/**
 * Client for the self-hosted AI model service (Modal).
 *
 * This is one of only two server modules that talk to the AI provider (the other
 * is aiBridge.ts, which owns the upstream stream). Trust rules:
 *
 *   - `AI_SERVICE_TOKEN` and `AI_CALL_SECRET` are server-side secrets. They are
 *     never sent to a browser and never logged.
 *   - Only the customer of an existing session can ask for a call (enforced by
 *     the route in server.ts), so an anonymous visitor cannot burn GPU time.
 *   - A returned join URL is a short-lived credential. It is validated against
 *     the configured service host before it is stored or handed to a browser.
 *   - Provider error text is sanitised: URLs, tokens and keys never reach the
 *     dashboard or the logs.
 */

export interface AiServiceSettings {
  /** Public base URL of the deployed Modal app, without a trailing slash. */
  baseUrl: string;
  /** Server-side bearer token accepted by POST /v1/calls. */
  token: string;
  /** Label shown in health/readiness; the model itself is chosen server-side. */
  model: string;
  /** Upper bound requested for one AI call, in seconds. */
  maxCallSeconds: number;
  /** Host the browser is allowed to connect to for audio streaming. */
  joinHost: string;
}

export interface AiCall {
  callId: string;
  joinUrl: string;
  model: string;
  expiresAt: number | null;
}

const DEFAULT_MAX_CALL_SECONDS = 3600;
const DEFAULT_MODEL_LABEL = 'faster-whisper-small.en+Qwen2.5-3B-Instruct';
const CALL_REQUEST_TIMEOUT_MS = 15_000;
const MAX_JOIN_URL_LENGTH = 2048;

const PLACEHOLDERS = new Set(['', 'MY_AI_SERVICE_URL', 'MY_AI_SERVICE_TOKEN']);

const clean = (value: string | undefined): string => (value ?? '').trim();

export const sanitizeAiCallId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
};

/**
 * Removes credentials and authenticated endpoints from provider error text.
 * Kept in this module so every provider failure goes through it.
 */
export const sanitizeProviderDetail = (value: unknown, maxLength = 300): string | null => {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/wss?:\/\/[^\s"']+/gi, '[url redacted]')
    .replace(/https?:\/\/[^\s"']+/gi, '[url redacted]')
    .replace(
      /((?:token|api[_-]?key|authorization|credential|password|secret)\s*[=:]\s*)[^\s&,;"']+/gi,
      '$1[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};

const parseMaxCallSeconds = (value: string | undefined): number => {
  const parsed = Number(clean(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CALL_SECONDS;
  return Math.min(Math.round(parsed), DEFAULT_MAX_CALL_SECONDS);
};


/** Returns null when the service is not configured; never throws. */
export const resolveAiServiceSettings = (
  env: NodeJS.ProcessEnv = process.env
): AiServiceSettings | null => {
  const rawUrl = clean(env.AI_SERVICE_URL);
  const rawToken = clean(env.AI_SERVICE_TOKEN);
  if (PLACEHOLDERS.has(rawUrl) || PLACEHOLDERS.has(rawToken)) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) return null;

  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, ''),
    token: rawToken,
    model: clean(env.AI_SERVICE_MODEL) || DEFAULT_MODEL_LABEL,
    maxCallSeconds: parseMaxCallSeconds(env.AI_MAX_CALL_SECONDS),
    joinHost: parsed.host,
  };
};

export interface AiReadiness {
  ready: boolean;
  provider: 'modal-self-hosted';
  model: string;
  transport: 'websocket';
  /** Environment variable names that are missing/invalid (never values). */
  missing: string[];
  message: string;
}

/**
 * Capability summary for /api/health.
 *
 * `ready` means "the server is configured to create calls". It is NOT proof
 * that the deployed model service is reachable or that audio streams: only a
 * live bridge state proves that.
 */
export const aiServiceReadiness = (env: NodeJS.ProcessEnv = process.env): AiReadiness => {
  const settings = resolveAiServiceSettings(env);
  if (settings) {
    return {
      ready: true,
      provider: 'modal-self-hosted',
      model: settings.model,
      transport: 'websocket',
      missing: [],
      message:
        'The server is configured to create self-hosted AI calls. Readiness is not proof that a live AI session is connected; see the session AI state.',
    };
  }

  const missing: string[] = [];
  if (PLACEHOLDERS.has(clean(env.AI_SERVICE_URL))) missing.push('AI_SERVICE_URL');
  if (PLACEHOLDERS.has(clean(env.AI_SERVICE_TOKEN))) missing.push('AI_SERVICE_TOKEN');
  if (!missing.length) missing.push('AI_SERVICE_URL');

  return {
    ready: false,
    provider: 'modal-self-hosted',
    model: DEFAULT_MODEL_LABEL,
    transport: 'websocket',
    missing,
    message:
      'AI suggestions are unavailable until AI_SERVICE_URL and AI_SERVICE_TOKEN point at the self-hosted Modal service. Human-to-human audio is unaffected.',
  };
};

export class AiServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | null;

  constructor(code: string, status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = 'AiServiceError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const isAcceptableJoinUrl = (value: string, settings: AiServiceSettings): boolean => {
  if (!value || value.length > MAX_JOIN_URL_LENGTH) return false;
  // Production must be TLS. A plain `ws://` URL is accepted only when the
  // configured service itself is loopback http (local Modal/dev harness).
  const secure = /^wss:\/\/\S+$/i.test(value);
  const loopback = settings.baseUrl.startsWith('http://') && /^ws:\/\/\S+$/i.test(value);
  if (!secure && !loopback) return false;
  try {
    return new URL(value).host === settings.joinHost;
  } catch {
    return false;
  }
};

/**
 * Creates one AI call on the self-hosted service.
 *
 * Throws `AiServiceError` with a stable code so the route can answer with JSON
 * instead of leaking provider internals.
 */
export const createAiCall = async (
  fetchImpl: typeof fetch,
  settings: AiServiceSettings,
  input: { sessionId: string; systemPrompt: string }
): Promise<AiCall> => {
  const body = JSON.stringify({
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    maxDurationSeconds: settings.maxCallSeconds,
  });

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.token}`,
      },
      body,
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(CALL_REQUEST_TIMEOUT_MS);
    }
    response = await fetchImpl(`${settings.baseUrl}/v1/calls`, init);
  } catch (error) {
    const detail = sanitizeProviderDetail((error as Error)?.message, 160);
    throw new AiServiceError(
      'AI_SERVICE_UNREACHABLE',
      502,
      detail || 'The self-hosted AI service could not be reached.',
      detail
    );
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    const detail = sanitizeProviderDetail(raw, 300);
    const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    throw new AiServiceError(
      'AI_SERVICE_ERROR',
      status,
      `The self-hosted AI service returned HTTP ${response.status}.`,
      detail
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AiServiceError(
      'AI_SERVICE_INVALID_RESPONSE',
      502,
      'The self-hosted AI service returned an unreadable response.'
    );
  }

  const callId = sanitizeAiCallId(data.callId);
  const joinUrl = typeof data.joinUrl === 'string' ? data.joinUrl.trim() : '';
  if (!callId || !isAcceptableJoinUrl(joinUrl, settings)) {
    throw new AiServiceError(
      'AI_SERVICE_INVALID_RESPONSE',
      502,
      'The self-hosted AI service did not return a usable call id and join URL.'
    );
  }

  const expiresAt =
    typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : null;

  return {
    callId,
    joinUrl,
    model:
      typeof data.model === 'string' && data.model.trim()
        ? data.model.trim().slice(0, 80)
        : settings.model,
    expiresAt,
  };
};

/**
 * Best-effort termination of a superseded call so a replaced session stops
 * consuming GPU time. Never awaited on a path that can block a new call.
 */
export const endAiCallQuietly = async (
  fetchImpl: typeof fetch,
  settings: AiServiceSettings,
  callId: string,
  timeoutMs = 2500
): Promise<boolean> => {
  const safeCallId = sanitizeAiCallId(callId);
  if (!safeCallId) return false;
  try {
    const response = await Promise.race([
      fetchImpl(`${settings.baseUrl}/v1/calls/${encodeURIComponent(safeCallId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${settings.token}` },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (response && !response.ok) {
      console.warn(`[ai] previous call cleanup returned HTTP ${response.status}`);
      return false;
    }
    return Boolean(response);
  } catch {
    console.warn('[ai] previous call cleanup failed (ignored).');
    return false;
  }
};

