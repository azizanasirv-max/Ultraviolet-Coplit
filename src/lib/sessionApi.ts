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
  aiReady: boolean;
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
      lastError: string | null;
      lastActivityAt: number;
    };
    serverTime: number;
    storage: string;
  };
  ice: { hasTurn: boolean; iceTransportPolicy: 'all' | 'relay' };
  hasUltravoxKey: boolean;
}

export interface HealthResponse {
  status: string;
  model: string;
  hasUltravoxKey: boolean;
  hasTurn: boolean;
  iceTransportPolicy: 'all' | 'relay';
  publicAppUrl: string | null;
  sessions: { sessions: number; invitations: number; participants: number };
  serverTime?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
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
      response.status
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

export const getIceConfig = (): Promise<{
  iceServers: RTCIceServer[];
  hasTurn: boolean;
  hasStun: boolean;
  iceTransportPolicy: 'all' | 'relay';
}> => request('/api/ice-config');

export const getHealth = (): Promise<HealthResponse> => request('/api/health');
