/**
 * Shared, UI-safe description of the customer-side self-hosted AI session.
 *
 * The AI session only exists in the customer's browser (it publishes the
 * customer microphone to the self-hosted model service). The salesperson therefore consumes a
 * *reported* copy of this state over signaling. These types and labels are
 * shared by the engine and both dashboards so a state is never rendered with a
 * different meaning on each side.
 */
import { AiSessionStatus, isLiveAiSessionStatus } from './aiSession';

/** Lifecycle states that are meaningful to a human reading the dashboard. */
export type AiLifecycleState =
  /** AI disabled for this participant (the salesperson never starts one). */
  | 'off'
  /** Asking the server for a *new* AI call. */
  | 'creating'
  /** A join URL was obtained and the AI transport is opening. */
  | 'connecting'
  /** The AI transport reports a live session (idle/listening/thinking/speaking). */
  | 'connected'
  /** A previous session failed and a new one is being created. */
  | 'reconnecting'
  /** The session went away without a provider error. */
  | 'disconnected'
  /** The AI call ended (socket closed); the join URL is no longer usable. */
  | 'closed'
  /** Setup or the live session failed; `error` explains what happened. */
  | 'error';

export interface AiStatus {
  state: AiLifecycleState;
  /** Raw transport status while a session object exists. */
  status: AiSessionStatus | null;
  /** True only while the transport reports a live session. */
  connected: boolean;
  /** Safe explanation of the most recent failure (no URLs or credentials). */
  error: string | null;
  /** AI call id (not a credential) of the current/last attempt. */
  callId: string | null;
  /** Bounded automatic recovery attempt counter (0 = none running). */
  reconnectAttempt: number;
  /** Maximum automatic attempts before recovery stops. */
  maxReconnectAttempts: number;
  /** True while a recovery attempt is scheduled or in progress. */
  reconnecting: boolean;
  /** The customer microphone is captured and published to the AI. */
  audioReachingAi: boolean;
  /** Last time any AI status/transcript event was observed. */
  lastEventAt: number | null;
  /** Last time an agent suggestion was received. */
  lastSuggestionAt: number | null;
  /** Last time the AI produced any response for this session. */
  lastResponseAt: number | null;
  /** Where this view came from: this device or the other participant. */
  source: 'local' | 'remote';
}

export const AI_RECONNECT_MAX_ATTEMPTS = 3;

/** Backoff for automatic recovery; kept bounded on purpose. */
export const AI_RECONNECT_DELAYS_MS = [1500, 4000, 9000] as const;

export const emptyAiStatus = (source: AiStatus['source'] = 'local'): AiStatus => ({
  state: 'off',
  status: null,
  connected: false,
  error: null,
  callId: null,
  reconnectAttempt: 0,
  maxReconnectAttempts: AI_RECONNECT_MAX_ATTEMPTS,
  reconnecting: false,
  audioReachingAi: false,
  lastEventAt: null,
  lastSuggestionAt: null,
  lastResponseAt: null,
  source,
});

/** Statuses that only arrive after the audio transport is live. */
export const isLiveAiStatus = (status: AiSessionStatus | null): boolean =>
  isLiveAiSessionStatus(status);

export type AiTone = 'emerald' | 'amber' | 'red' | 'slate' | 'indigo';

export const aiStateLabel = (state: AiLifecycleState): string => {
  switch (state) {
    case 'creating': return 'Creating AI session';
    case 'connecting': return 'Connecting AI';
    case 'connected': return 'AI connected';
    case 'reconnecting': return 'Reconnecting AI';
    case 'disconnected': return 'AI disconnected';
    case 'closed': return 'AI session closed';
    case 'error': return 'AI error';
    default: return 'AI not started';
  }
};

export const aiTone = (state: AiLifecycleState): AiTone => {
  switch (state) {
    case 'connected': return 'emerald';
    case 'creating':
    case 'connecting':
    case 'reconnecting': return 'amber';
    case 'error':
    case 'disconnected':
    case 'closed': return 'red';
    default: return 'slate';
  }
};

/** Compact, human-readable failure text. Never includes provider URLs. */
export const describeAiFailure = (ai: Pick<AiStatus, 'state' | 'error'>): string | null => {
  if (ai.state === 'off') return null;
  if (ai.error) return ai.error;
  return null;
};

/**
 * Redacts anything that looks like a credential or an authenticated endpoint
 * from provider/SDK error text before it is rendered or forwarded.
 */
export const sanitizeAiDetail = (value: unknown, maxLength = 300): string | null => {
  if (typeof value !== 'string') return null;
  let text = value;
  // Authenticated join/socket URLs must never reach the other dashboard.
  text = text.replace(/wss?:\/\/[^\s"']+/gi, '[url redacted]');
  text = text.replace(/https?:\/\/[^\s"']+/gi, '[url redacted]');
  // Collapse secret-looking query/form assignments.
  text = text.replace(
    /((?:token|api[_-]?key|authorization|credential|password|secret)\s*[=:]\s*)[^\s&,;"']+/gi,
    '$1[redacted]'
  );
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};
