/**
 * Typed client for the operator-only admin endpoints (ExpressTURN setup).
 *
 * Reuses the server/admin.ts authentication flow unchanged:
 *   - first-run setup / sign-in return the per-session CSRF token;
 *   - the session itself is an HttpOnly, SameSite=Strict cookie, so this client
 *     never touches or stores it;
 *   - every mutation sends the CSRF token in `X-CSRF-Token`;
 *   - the TURN password is only ever held in component state for the duration
 *     of the request and is never written to localStorage/sessionStorage.
 */

export interface AdminSetupStatus {
  claimed: boolean;
  claimedAt: number | null;
}

export interface AdminTurnStatus {
  configured: boolean;
  urlCount: number;
  updatedAt: number | null;
  storage: 'memory';
}

export interface AdminStatusResponse extends AdminTurnStatus {
  setup: AdminSetupStatus;
}

export interface AdminSessionResponse extends AdminStatusResponse {
  csrfToken: string;
}

export interface AdminAuthenticatedResponse extends AdminSessionResponse {
  ok: true;
  expiresInSeconds: number;
}

export interface TurnCredentialsInput {
  serverAddress: string;
  username: string;
  password: string;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
    this.status = status;
  }
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AdminApiError(
      typeof body?.error === 'string' ? body.error : 'ADMIN_REQUEST_FAILED',
      typeof body?.message === 'string' ? body.message : `Request failed (HTTP ${response.status}).`,
      response.status
    );
  }
  return body as T;
};

/** Safe, unauthenticated flags: setup claimed? and TURN configured? */
export const getAdminStatus = (): Promise<AdminStatusResponse> =>
  request<AdminStatusResponse>('/api/admin/status');

/** Reuses an existing signed cookie session; throws 401 when not signed in. */
export const getAdminSession = (): Promise<AdminSessionResponse> =>
  request<AdminSessionResponse>('/api/admin/turn-settings');

export const createAdminSetup = (password: string): Promise<AdminAuthenticatedResponse> =>
  request<AdminAuthenticatedResponse>('/api/admin/setup', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });

export const loginAdmin = (password: string): Promise<AdminAuthenticatedResponse> =>
  request<AdminAuthenticatedResponse>('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });

export const saveTurnCredentials = (
  input: TurnCredentialsInput,
  csrfToken: string
): Promise<{ ok: true; settings: AdminTurnStatus }> =>
  request('/api/admin/turn-settings', {
    method: 'PUT',
    headers: { 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(input),
  });

export const clearTurnCredentials = (
  csrfToken: string
): Promise<{ ok: true; settings: AdminTurnStatus }> =>
  request('/api/admin/turn-settings', {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  });

export const logoutAdmin = (csrfToken: string): Promise<{ ok: true }> =>
  request('/api/admin/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    // The server requires application/json on admin mutations; send an empty
    // JSON object so signing out is not rejected with 415.
    body: '{}',
  });
