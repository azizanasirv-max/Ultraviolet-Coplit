/**
 * Client-side credential storage.
 *
 * Salesperson credentials live in localStorage (one dashboard per browser),
 * customer credentials and signaling resume tokens live in sessionStorage so a
 * reload keeps this tab's identity while a second tab cannot hijack it.
 */

export interface StoredSalespersonSession {
  sessionId: string;
  salespersonKey: string;
  createdAt: number;
  displayName: string;
}

const SALESPERSON_KEY = 'sc.prototype2.salesperson';
const DISPLAY_NAME_KEY = 'sc.prototype2.displayName';

export const loadSalespersonSession = (): StoredSalespersonSession | null => {
  try {
    const raw = localStorage.getItem(SALESPERSON_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSalespersonSession;
    if (!parsed?.sessionId || !parsed?.salespersonKey) return null;
    return { ...parsed, displayName: parsed.displayName || loadDisplayName() };
  } catch {
    return null;
  }
};

export const saveSalespersonSession = (session: StoredSalespersonSession): void => {
  try {
    localStorage.setItem(SALESPERSON_KEY, JSON.stringify(session));
    localStorage.setItem(DISPLAY_NAME_KEY, session.displayName || '');
  } catch {
    // Storage can be unavailable in private modes; the session still works in-memory.
  }
};

export const clearSalespersonSession = (): void => {
  try {
    localStorage.removeItem(SALESPERSON_KEY);
  } catch {
    // Ignore.
  }
};

export const loadDisplayName = (): string => {
  try {
    return localStorage.getItem(DISPLAY_NAME_KEY) || '';
  } catch {
    return '';
  }
};

export const saveDisplayName = (name: string): void => {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, name);
  } catch {
    // Ignore.
  }
};

export interface StoredCustomerSession {
  sessionId: string;
  customerKey: string;
}

const customerKeyFor = (inviteToken: string) => `sc.prototype2.customer.${inviteToken}`;

export const loadCustomerSession = (inviteToken: string): StoredCustomerSession | null => {
  try {
    const raw = sessionStorage.getItem(customerKeyFor(inviteToken));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCustomerSession;
    if (!parsed?.sessionId || !parsed?.customerKey) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveCustomerSession = (inviteToken: string, session: StoredCustomerSession): void => {
  try {
    sessionStorage.setItem(customerKeyFor(inviteToken), JSON.stringify(session));
  } catch {
    // Ignore.
  }
};

export const loadResumeToken = (sessionId: string, role: string): string | null => {
  try {
    return sessionStorage.getItem(`sc.prototype2.resume.${sessionId}.${role}`);
  } catch {
    return null;
  }
};

export const saveResumeToken = (sessionId: string, role: string, token: string): void => {
  try {
    sessionStorage.setItem(`sc.prototype2.resume.${sessionId}.${role}`, token);
  } catch {
    // Ignore.
  }
};
