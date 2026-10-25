/**
 * The customer's *entire* presentation model.
 *
 * Privacy is enforced by construction here: the customer dashboard receives a
 * `CustomerCallView` built from an explicit allow-list of call fields. AI
 * suggestions, AI provider state, reconnect counters, diagnostics and logs are
 * not copied into the view, so they cannot be rendered - even accidentally -
 * and they are not merely hidden with CSS.
 *
 * The customer device does run the AI session (it publishes the customer
 * microphone to Ultravox), but that is an implementation detail of the
 * salesperson's assistant and must never appear in this model.
 */
import type { EngineSnapshot } from './callEngine';
import type { SpeechSegment } from './transcript';

export type CustomerPhase =
  | 'prejoin'
  | 'requesting_mic'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'error';

export interface CustomerNotice {
  tone: 'amber' | 'red';
  title: string;
  message: string;
}

export type CustomerTranscriptState = 'idle' | 'live' | 'unavailable' | 'ended';

export interface CustomerCallView {
  /** Label for the other participant ("your salesperson" unless named). */
  salespersonLabel: string;
  sessionLabel: string | null;
  phase: CustomerPhase;
  headline: string;
  detail: string;
  /** Seconds since the call connected; null when not connected. */
  durationSeconds: number | null;
  micMuted: boolean;
  micPermission: 'unknown' | 'requesting' | 'granted' | 'denied';
  speakerMuted: boolean;
  canMute: boolean;
  canToggleSpeaker: boolean;
  canEndCall: boolean;
  canReconnect: boolean;
  canJoin: boolean;
  /** Salesperson speech only. Never AI output. */
  transcript: SpeechSegment[];
  transcriptState: CustomerTranscriptState;
  notice: CustomerNotice | null;
}

export interface CustomerViewInput {
  snapshot: EngineSnapshot | null;
  sessionLabel?: string | null;
  /** Seconds connected, tracked by the dashboard (engine state is not timed). */
  durationSeconds: number | null;
  /** Caption status reported by the salesperson device, when available. */
  transcriptState?: CustomerTranscriptState;
  /** A pre-join/fatal message from the invitation flow. */
  inviteError?: string | null;
  joined: boolean;
}

/**
 * Derives a human label for the salesperson without exposing any identifier
 * beyond what the session already publishes as its label.
 */
export const salespersonLabelFrom = (sessionLabel: string | null | undefined): string => {
  const label = (sessionLabel ?? '').trim();
  const match = label.match(/^sales call with\s+(.+)$/i);
  if (match) return match[1].trim();
  return 'your salesperson';
};

const noticeForError = (snapshot: EngineSnapshot | null): CustomerNotice | null => {
  if (!snapshot) return null;
  if (snapshot.micPermission === 'denied' || snapshot.callState === 'mic_denied') {
    return {
      tone: 'red',
      title: 'Microphone blocked',
      message:
        'Allow microphone access for this site in your browser settings, then reconnect. You can still hear the call, but the salesperson will not hear you.',
    };
  }
  if (snapshot.callState === 'failed') {
    return {
      tone: 'red',
      title: 'Connection problem',
      message: 'The audio connection could not be established. Check your network and try reconnecting.',
    };
  }
  if (snapshot.callState === 'rejected') {
    return {
      tone: 'red',
      title: 'This invitation cannot be used',
      message: snapshot.lastServerError || 'The invitation is no longer valid. Ask for a new link.',
    };
  }
  if (snapshot.playbackBlocked) {
    return {
      tone: 'amber',
      title: 'Tap to hear the call',
      message: 'Your browser blocked audio playback. Tap the speaker button to start the audio.',
    };
  }
  if (snapshot.wsStatus === 'reconnecting') {
    return {
      tone: 'amber',
      title: 'Reconnecting',
      message: 'The connection dropped. Reconnecting automatically…',
    };
  }
  if (snapshot.callState === 'disconnected') {
    return {
      tone: 'amber',
      title: 'Call interrupted',
      message: 'The salesperson is no longer connected. You can try reconnecting.',
    };
  }
  return null;
};

/** Maps engine call state to the states a caller expects to see. */
export const customerPhaseFor = (snapshot: EngineSnapshot | null, joined: boolean): CustomerPhase => {
  if (!joined || !snapshot) return 'prejoin';
  switch (snapshot.callState) {
    case 'requesting_mic':
      return 'requesting_mic';
    case 'waiting':
      return 'waiting';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'ended':
      return 'ended';
    case 'failed':
    case 'mic_denied':
    case 'rejected':
      return 'error';
    case 'disconnected':
      return 'reconnecting';
    default:
      return 'connecting';
  }
};

const HEADLINES: Record<CustomerPhase, { headline: string; detail: string }> = {
  prejoin: { headline: 'Ready to join', detail: 'Tap Join call to start the audio call.' },
  requesting_mic: { headline: 'Connecting', detail: 'Allow microphone access so the salesperson can hear you.' },
  waiting: { headline: 'Ringing', detail: 'Waiting for the salesperson to join the call…' },
  connecting: { headline: 'Connecting', detail: 'Setting up the audio connection…' },
  connected: { headline: 'Connected', detail: 'You are on a secure audio call.' },
  reconnecting: { headline: 'Reconnecting', detail: 'Trying to restore the call. Your audio resumes automatically.' },
  ended: { headline: 'Call ended', detail: 'This call has ended. You can close this page.' },
  error: { headline: 'Call problem', detail: 'The call could not continue.' },
};

/**
 * Builds the customer-facing view. Only call fields are read from the
 * snapshot; AI and diagnostic fields are deliberately never touched.
 */
export const buildCustomerCallView = (input: CustomerViewInput): CustomerCallView => {
  const { snapshot, sessionLabel, durationSeconds, inviteError, joined } = input;
  const phase = inviteError ? 'error' : customerPhaseFor(snapshot, joined);
  const labels = HEADLINES[phase];
  const notice = inviteError
    ? { tone: 'red' as const, title: 'This invitation cannot be used', message: inviteError }
    : noticeForError(snapshot);

  const connected = phase === 'connected' && snapshot?.callState === 'connected';
  const transcript = connected || phase === 'reconnecting' ? (snapshot?.salespersonTranscript ?? []) : [];

  return {
    salespersonLabel: salespersonLabelFrom(sessionLabel),
    sessionLabel: sessionLabel?.trim() ? sessionLabel.trim() : null,
    phase,
    headline: labels.headline,
    detail: labels.detail,
    durationSeconds,
    micMuted: Boolean(snapshot?.micMuted),
    micPermission: snapshot?.micPermission ?? 'unknown',
    speakerMuted: Boolean(snapshot?.speakerMuted),
    canMute: joined && phase !== 'ended',
    canToggleSpeaker: joined && phase !== 'ended',
    canEndCall: joined && phase !== 'ended',
    canReconnect: !joined || phase === 'ended' || phase === 'error',
    canJoin: !joined && !inviteError,
    transcript,
    transcriptState: input.transcriptState ?? (transcript.length ? 'live' : 'idle'),
    notice,
  };
};

/** `mm:ss` / `h:mm:ss` for the call timer. */
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
};

