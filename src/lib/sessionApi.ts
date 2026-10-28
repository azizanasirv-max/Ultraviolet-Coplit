/** Typed client for the Prototype 2 session/invitation API. */

export interface SessionPublicState {
  sessionId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  salespersonConnected: boolean;
  customerConnected: boolean;
  invitationStatus: 'active' | 'redeemed' | 'revoked' | 'expired' | 'missing';
  invitationExpiresAt: number | null;
  /** A server-side Ultravox call record exists (not proof of a live session). */
  aiReady: boolean;
  aiCallCreated: boolean;
  /** Live AI state reported by the customer device. */
  ai: {
    state: string | null;
    connected: boolean;
    error: string | null;
    reconnectAttempt: number;
    audioReachingAi: boolean;
    lastResponseAt: number | null;
    lastSuggestionAt: number | null;
    updatedAt: number | null;
  };
}

export interface CreatedSession {
  sessionId: string;
  salespersonKey: string;
  sessionExpiresAt: number;
  inviteUrl: string | null;
  inviteExpiresAt: number | null;
}

export interface RedeemedInvitation {
  sessionId: string;
  customerKey: string;
  resumed: boolean;
  session: SessionPublicState;
  baseUrl: string;
}

export interface SessionDiagnosticsResponse {
  diagnostics: {
    sessionId: string;
    label: string;
    createdAt: number;
    expiresAt: number;
    salespersonConnected: boolean;
    customerConnected: boolean;
    invitationStatus: string;
    invitationExpiresAt: number | null;
    aiReady: boolean;
    aiCallCreated: boolean;
    ai: {
      state: string | null;
      connected: boolean;
      error: string | null;
      reconnectAttempt: number;
      audioReachingAi: boolean;
      lastResponseAt: number | null;
      lastSuggestionAt: number | null;
      updatedAt: number | null;
    };
    aiCallId: string | null;
    aiLastError: string | null;
    participants: Array<{
      participantId: string;
      role: 'customer' | 'salesperson';
      connected: boolean;
      connectedAt: number;
      lastSeenAt: number;
      connectionCount: number;
      diagnostics: Record<string, unknown> | null;
    }>;
    signals: {
      offers: number;
      answers: number;
      iceCandidates: number;
      aiSuggestions: number;
      rejectedMessages: number;
      relayFailures: number;
      audioChecks: number;
      lastError: string | null;
      lastActivityAt: number;
    };
    serverTime: number;
    storage: string;
  };
  ice: {
    configured: boolean;
    credentialMode: 'ephemeral' | 'static' | 'provider' | 'none';
    iceTransportPolicy: 'all' | 'relay';
    hasErrors: boolean;
    warnings: string[];
  };
  ai: {
    ready: boolean;
    provider: string;
    model: string;
    missing: string[];
    message: string;
  };
  hasUltravoxKey: boolean;
}

export interface HealthResponse {
  status: string;
  model: string;
  ai: {
    ready: boolean;
    provider: string;
    model: string;
    missing: string[];
    message: string;
  };
  hasUltravoxKey: boolean;
  ice: {
    configured: boolean;
    credentialMode: 'ephemeral' | 'static' | 'provider' | 'none';
    iceTransportPolicy: 'all' | 'relay';
    hasErrors: boolean;
    warnings: string[];
  };
  hasTurn: boolean;
  iceTransportPolicy: 'all' | 'relay';
  publicAppUrl: string | null;
  appUrlWarnings: string[];
  sessions: { sessions: number; invitations: number; participants: number };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Parsed error body (may carry TURN warnings/errors). Never contains secrets. */
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface IceConfigResponse {
  iceServers: RTCIceServer[];
  hasTurn: boolean;
  hasStun: boolean;
  iceTransportPolicy: 'all' | 'relay';
  turn: {
    configured: boolean;
    credentialMode: 'ephemeral' | 'static' | 'provider' | 'none';
    urlCount: number;
    expiresAt: number | null;
  };
  warnings: string[];
  errors: string[];
  generatedAt: string;
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      typeof body?.error === 'string' ? body.error : 'REQUEST_FAILED',
      typeof body?.message === 'string' ? body.message : `Request failed (HTTP ${response.status}).`,
      response.status,
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    );
  }
  return body as T;
};

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

export const createSession = (label?: string): Promise<CreatedSession> =>
  request<CreatedSession>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ label }),
  });

export const getSession = (sessionId: string, key: string): Promise<{ session: SessionPublicState }> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}`, { headers: auth(key) });

export const rotateInvitation = (
  sessionId: string,
  key: string
): Promise<{ inviteUrl: string; inviteExpiresAt: number; session: SessionPublicState }> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/invitations`, {
    method: 'POST',
    headers: auth(key),
  });

export const revokeInvitation = (
  sessionId: string,
  key: string
): Promise<{ revoked: boolean; session: SessionPublicState }> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/invitations/revoke`, {
    method: 'POST',
    headers: auth(key),
  });

export const getSessionDiagnostics = (
  sessionId: string,
  key: string
): Promise<SessionDiagnosticsResponse> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/diagnostics`, { headers: auth(key) });

export const redeemInvitation = (
  inviteToken: string,
  customerKey?: string | null
): Promise<RedeemedInvitation> =>
  request('/api/invitations/redeem', {
    method: 'POST',
    body: JSON.stringify({ inviteToken, customerKey: customerKey || undefined }),
  });

/**
 * ICE/TURN configuration for one participant. Session-authenticated: TURN
 * credentials are never served to anonymous visitors.
 *
 * `timeoutMs` bounds the request: a hanging provider lookup on the server must
 * never leave a joining participant waiting forever. The abort surfaces as a
 * normal fetch rejection, which the call engine retries.
 */
export const getIceConfig = (
  sessionId: string,
  credential: string,
  options: { timeoutMs?: number } = {}
): Promise<IceConfigResponse> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/ice-config`, {
    headers: auth(credential),
    ...(options.timeoutMs && options.timeoutMs > 0
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  });

export const getHealth = (options: { timeoutMs?: number } = {}): Promise<HealthResponse> =>
  request('/api/health', {
    ...(options.timeoutMs && options.timeoutMs > 0
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  });
