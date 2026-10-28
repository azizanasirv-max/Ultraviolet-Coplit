/**
 * Salesperson-facing description of the inbound (customer -> salesperson) audio
 * path.
 *
 * A WebRTC connection reaching `connected`, and even inbound RTP arriving, is
 * NOT proof that a human can hear anything:
 *
 *   - the transport can connect while the remote track is missing,
 *   - RTP keeps flowing (as silence) while the customer's microphone track is
 *     muted or held by another capture on their device,
 *   - the browser can refuse to start playback (autoplay policy) so a perfectly
 *     healthy stream stays inaudible.
 *
 * This module turns the raw measurements into one honest state so the UI never
 * claims working audio without evidence. It is pure and unit tested.
 */

/** RMS (0..1) above which a 1024-sample window counts as audible sound. */
export const INBOUND_SOUND_RMS_THRESHOLD = 0.002;
/** How recent measured sound must be to still count as "audible right now". */
export const SOUND_FRESH_MS = 6000;

export type PlaybackState = 'no_track' | 'playing' | 'paused' | 'blocked';

export type CustomerAudioState =
  /** The customer is not in the session at all. */
  | 'no_customer'
  /** The customer is connected but the audio transport is not up yet. */
  | 'connecting'
  /** Transport is up, but no inbound audio packets arrive. */
  | 'no_packets'
  /** Packets arrive, but they carry no measurable sound (silent microphone). */
  | 'silent'
  /** Sound is arriving, but the browser is not playing it. */
  | 'playback_blocked'
  /** The salesperson muted the customer's audio locally. */
  | 'muted_locally'
  /** Everything measured is healthy. */
  | 'ok';

export interface CustomerAudioInput {
  /** Server-authoritative presence of the customer device in this session. */
  customerConnected: boolean;
  callState: string;
  pcState: string;
  /** Inbound RTP packets received from the customer. */
  inboundPackets: number;
  inboundBytes: number;
  /** Measured RMS of the decoded inbound audio (null = not measured yet). */
  inboundAudioLevel: number | null;
  /** True when the inbound stream carried measurable sound recently. */
  soundDetected: boolean;
  playbackBlocked: boolean;
  playbackState: PlaybackState;
  remoteTrackState: string;
  speakerMuted: boolean;
}

export type CustomerAudioAction = 'none' | 'enable_audio' | 'reconnect' | 'wait';

export interface CustomerAudioReport {
  state: CustomerAudioState;
  label: string;
  tone: 'emerald' | 'amber' | 'red' | 'slate';
  /** Each of the five independent facts the UI must show separately. */
  customerConnected: boolean;
  transportConnected: boolean;
  receivingPackets: boolean;
  audibleSound: boolean;
  playbackWorking: boolean;
  /** Actionable warning, or null when nothing needs attention. */
  warning: { title: string; detail: string; action: CustomerAudioAction; actionLabel: string } | null;
}


const WARNING_ACTION_LABELS: Record<CustomerAudioAction, string> = {
  none: '',
  enable_audio: 'Enable audio',
  reconnect: 'Reconnect',
  wait: 'Retry now',
};

const report = (
  state: CustomerAudioState,
  label: string,
  tone: CustomerAudioReport['tone'],
  facts: Omit<CustomerAudioReport, 'state' | 'label' | 'tone' | 'warning'>,
  warning: { title: string; detail: string; action: CustomerAudioAction } | null
): CustomerAudioReport => ({
  state,
  label,
  tone,
  ...facts,
  warning: warning ? { ...warning, actionLabel: WARNING_ACTION_LABELS[warning.action] } : null,
});

/**
 * Derives the honest inbound-audio state from measured facts.
 *
 * Precedence is deliberate: transport -> packets -> playback -> sound. A later
 * fact can only be judged once the earlier one holds, so "connected" alone can
 * never be reported as working audio.
 */
export const describeCustomerAudio = (input: CustomerAudioInput): CustomerAudioReport => {
  const facts = {
    customerConnected: input.customerConnected,
    transportConnected: input.pcState === 'connected',
    receivingPackets: input.inboundPackets > 0,
    audibleSound: input.soundDetected,
    playbackWorking: input.playbackState === 'playing' && !input.playbackBlocked,
  };

  if (!input.customerConnected) {
    return report('no_customer', 'Waiting for the customer', 'amber', facts, null);
  }

  if (!facts.transportConnected) {
    const pending = input.callState === 'connecting' || input.callState === 'reconnecting';
    return report(
      'connecting',
      pending ? 'Connecting customer audio' : 'Customer connected — audio not connected',
      'amber',
      facts,
      pending
        ? null
        : {
            title: 'Customer audio is not connected',
            detail:
              'The customer is in the call but the audio transport is not up, so you cannot hear them yet.',
            action: 'reconnect',
          }
    );
  }

  if (input.speakerMuted) {
    // The user deliberately silenced the customer: the call is fine, playback is
    // not expected. Say so instead of warning.
    return report('muted_locally', 'Customer audio muted by you', 'slate', facts, null);
  }

  if (!facts.receivingPackets) {
    return report('no_packets', 'Connected — no customer audio arriving', 'amber', facts, {
      title: 'You are not receiving the customer’s audio',
      detail:
        'The audio transport is connected but no audio packets are arriving from the customer. Reconnect to rebuild the audio path.',
      action: 'reconnect',
    });
  }

  if (input.playbackBlocked || input.playbackState === 'blocked') {
    return report('playback_blocked', 'Customer audio blocked by the browser', 'amber', facts, {
      title: 'Your browser is not playing the customer’s audio',
      detail:
        'Audio is arriving, but the browser blocked playback. Click Enable audio to start it (the call stays connected).',
      action: 'enable_audio',
    });
  }

  if (input.playbackState === 'paused') {
    return report('playback_blocked', 'Customer audio paused', 'amber', facts, {
      title: 'Customer audio is paused in your browser',
      detail: 'Audio is arriving but playback is paused. Click Enable audio (or Reconnect) to restore it.',
      action: 'enable_audio',
    });
  }

  if (!facts.audibleSound) {
    return report('silent', 'Customer audio is silent', 'amber', facts, {
      title: 'The customer’s microphone is sending silence',
      detail:
        'Audio packets are arriving but they contain no measurable sound. Ask the customer to check that their microphone is allowed and not muted, or reconnect.',
      action: 'reconnect',
    });
  }

  return report('ok', 'Customer audio is playing', 'emerald', facts, null);
};

/** Compact `rms -> dBFS` formatting for diagnostics. */
export const formatAudioLevel = (level: number | null | undefined): string => {
  if (level === null || level === undefined || !Number.isFinite(level)) return 'not measured';
  if (level <= 0) return 'silent (-∞ dBFS)';
  const db = 20 * Math.log10(level);
  return `${level.toFixed(4)} rms (${db.toFixed(1)} dBFS)`;
};
