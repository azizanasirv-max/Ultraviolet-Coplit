/**
 * Customer-facing wording.
 *
 * The customer screen must never render internal networking or API detail
 * (ICE/TURN/SDP values, HTTP statuses, server error codes, fetch errors,
 * signaling diagnostics or salesperson AI material). Every visible sentence
 * comes from this module, so the mapping is unit-testable and there is a single
 * place that guarantees raw error text cannot leak into the customer interface.
 */
import type { EngineCallState } from './callEngine';

const CALL_LABELS: Record<EngineCallState, string> = {
  idle: 'Not joined',
  requesting_mic: 'Microphone permission',
  waiting: 'Waiting for salesperson',
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Connection interrupted',
  reconnecting: 'Reconnecting',
  failed: 'Unable to connect',
  mic_denied: 'Microphone blocked',
  rejected: 'Invitation no longer valid',
  ended: 'Call ended',
};

const CALL_NOTICES: Record<EngineCallState, string | null> = {
  idle: 'Connecting to your salesperson...',
  requesting_mic: 'Waiting for microphone permission...',
  waiting: 'Connecting to your salesperson...',
  connecting: 'Connecting to your salesperson...',
  connected: null,
  disconnected: 'Connection interrupted. Reconnecting...',
  reconnecting: 'Connection interrupted. Reconnecting...',
  failed: 'Unable to connect. Please try again.',
  mic_denied:
    'Microphone access is needed for this call. Allow the microphone in your browser, then try again.',
  rejected: 'This call is no longer available. Ask the salesperson for a new invitation.',
  ended: 'The call has ended.',
};

/** Short status badge text for the customer call screen. */
export const customerCallLabel = (state: EngineCallState | null | undefined): string => {
  const key = state ?? 'idle';
  return Object.prototype.hasOwnProperty.call(CALL_LABELS, key) ? CALL_LABELS[key] : CALL_LABELS.idle;
};

/**
 * Customer-safe explanation for the current call state. `null` means there is
 * nothing to show (the call is healthy).
 */
export const customerCallNotice = (state: EngineCallState | null | undefined): string | null => {
  const key = state ?? 'idle';
  return Object.prototype.hasOwnProperty.call(CALL_NOTICES, key) ? CALL_NOTICES[key] : CALL_NOTICES.idle;
};

/**
 * Maps an invitation/redemption API error code to friendly copy. Unknown codes
 * fall back to a generic sentence: the raw code or server message is never
 * returned, so it cannot be rendered by accident.
 */
export const customerInvitationMessage = (code: string | null | undefined): string => {
  switch (code) {
    case 'INVITE_EXPIRED':
    case 'SESSION_EXPIRED':
      return 'This invitation has expired. Ask the salesperson for a new one.';
    case 'INVITE_REVOKED':
      return 'This invitation is no longer valid. Ask the salesperson to send a new link.';
    case 'INVITE_REDEEMED':
      return 'This invitation has already been used. Ask the salesperson to send a new link.';
    case 'INVITE_NOT_FOUND':
    case 'LEGACY_LINK':
      return 'This invitation link is not valid. Ask the salesperson to send a new link.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait a moment and try again.';
    default:
      return 'This invitation could not be used. Ask the salesperson for a new one.';
  }
};
