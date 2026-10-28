/**
 * Microphone capture policy for the participant (human) audio path.
 *
 * `getUserMedia` constraints used to be three hard-coded `true` flags, and
 * nothing ever asked the browser what it had *actually* applied. That is a
 * problem for audio quality, not just for tidiness:
 *
 *   - Echo cancellation (AEC) is the only thing that stops a two-way call on
 *     open speakers from becoming a feedback loop. If the browser silently
 *     drops it (a device held by another capture, an unsupported platform), the
 *     participants hear themselves (echo / "doubled" voices) while every RTP
 *     counter still looks healthy.
 *   - Noise suppression is a *processing* stage, not a gate. It is never used
 *     here to decide whether audio is sent: quiet speech is always published.
 *   - Automatic gain control was evaluated and is requested **off** for this
 *     path. AGC is a moving gain stage: it lifts the noise floor while nobody
 *     is speaking (audible hiss/crackle in the pauses) and changes the level of
 *     the same voice between phrases ("pumping"). On the customer device a
 *     second, independent capture (the Ultravox/LiveKit capture used for
 *     transcription) already applies its own AGC, so the human path does not
 *     need a second one. The trade-off is explicit: no AGC means a genuinely
 *     low-gain device stays quiet instead of being pumped up, so the measured
 *     microphone level is exposed in diagnostics. Change the single constant
 *     below to re-enable AGC after real-device testing.
 *   - Mono is requested because stereo capture disables echo cancellation on
 *     some devices and buys nothing for a voice call.
 *
 * Everything in this module is pure so the policy and its interpretation can be
 * unit tested without a browser.
 */

export interface MicrophoneProcessingPolicy {
  /** Browser echo cancellation (AEC): protects against acoustic feedback. */
  echoCancellation: boolean;
  /** Browser noise suppression: reduces steady room noise, never gates audio. */
  noiseSuppression: boolean;
  /** Automatic gain control: off, so the voice level stays natural and steady. */
  autoGainControl: boolean;
  /** Mono capture: AEC is unreliable (and unsupported on some devices) in stereo. */
  channelCount: number;
}

/**
 * The one place the human-path microphone processing is decided.
 *
 * Every value is requested as an `ideal` constraint (see
 * `buildMicrophoneConstraints`): a device that cannot honour a request must
 * still return a usable capture, because refusing to capture audio is worse
 * than capturing it without a processing stage.
 */
export const PARTICIPANT_MICROPHONE_POLICY: MicrophoneProcessingPolicy = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  channelCount: 1,
});

/**
 * Builds the `getUserMedia` audio constraints for the participant call.
 *
 * `ideal` (not `exact`) is deliberate: `exact` would reject the whole call when
 * a browser/device cannot provide a stage, and no processing stage is worth
 * losing the microphone over.
 */
export const buildMicrophoneConstraints = (
  policy: MicrophoneProcessingPolicy = PARTICIPANT_MICROPHONE_POLICY
): MediaTrackConstraints => ({
  echoCancellation: { ideal: policy.echoCancellation },
  noiseSuppression: { ideal: policy.noiseSuppression },
  autoGainControl: { ideal: policy.autoGainControl },
  channelCount: { ideal: policy.channelCount },
});


/** What the browser reports it actually applied to a capture. */
export interface AppliedMicrophoneProcessing {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  channelCount: number | null;
  sampleRate: number | null;
}

const readBoolean = (settings: Record<string, unknown>, key: string): boolean | null => {
  const value = settings[key];
  return typeof value === 'boolean' ? value : null;
};

const readNumber = (settings: Record<string, unknown>, key: string): number | null => {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * Reads `MediaStreamTrack.getSettings()` into an explicit report.
 *
 * A missing property means "this browser/device does not report it", which is
 * *not* the same as "off": the distinction is kept so the UI can never claim
 * that echo cancellation is active when it was never measured.
 */
export const readAppliedMicrophoneProcessing = (
  settings: MediaTrackSettings | Record<string, unknown> | null | undefined
): AppliedMicrophoneProcessing => {
  const source =
    settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {};
  return {
    echoCancellation: readBoolean(source, 'echoCancellation'),
    noiseSuppression: readBoolean(source, 'noiseSuppression'),
    autoGainControl: readBoolean(source, 'autoGainControl'),
    channelCount: readNumber(source, 'channelCount'),
    sampleRate: readNumber(source, 'sampleRate'),
  };
};

const stageLabel = (
  label: string,
  value: boolean | null,
  onText: string,
  offText: string
): string => {
  if (value === null) return `${label} unmeasured`;
  return `${label} ${value ? onText : offText}`;
};

export interface MicrophoneProcessingReport {
  /** Compact, diagnostics-only summary of the applied stages. */
  summary: string;
  /** True/false when the browser reports AEC state; null when unmeasurable. */
  echoCancellationActive: boolean | null;
  /** Actionable notes for the operator log. Never rendered to a customer. */
  warnings: string[];
}

/**
 * Turns the applied settings into one honest summary plus warnings.
 *
 * No warning here changes capture behaviour: this is measurement only, so a
 * browser that refuses a processing stage still publishes the microphone.
 */
export const describeMicrophoneProcessing = (
  applied: AppliedMicrophoneProcessing,
  policy: MicrophoneProcessingPolicy = PARTICIPANT_MICROPHONE_POLICY
): MicrophoneProcessingReport => {
  const channel =
    applied.channelCount === null ? 'ch unmeasured' : `${applied.channelCount}ch`;
  const rate =
    applied.sampleRate === null ? 'rate unmeasured' : `${Math.round(applied.sampleRate)} Hz`;
  const summary = [
    stageLabel('aec', applied.echoCancellation, 'on', 'off'),
    stageLabel('ns', applied.noiseSuppression, 'on', 'off'),
    stageLabel('agc', applied.autoGainControl, 'on', 'off'),
    channel,
    rate,
  ].join(' · ');

  const warnings: string[] = [];
  if (applied.echoCancellation === false) {
    warnings.push(
      'Echo cancellation is not active on this capture: the other participant may hear themselves. ' +
        'Use headphones or close the other application that is holding the microphone.'
    );
  } else if (applied.echoCancellation === null) {
    warnings.push('This browser does not report echo cancellation, so it cannot be verified.');
  }
  if (applied.noiseSuppression === null) {
    warnings.push('This browser does not report noise suppression, so it cannot be verified.');
  }
  if (policy.autoGainControl === false && applied.autoGainControl === true) {
    warnings.push(
      'The browser kept automatic gain control on despite the request to disable it; the level may pump.'
    );
  }
  if (applied.channelCount !== null && applied.channelCount > 1) {
    warnings.push(
      `The browser opened the microphone with ${applied.channelCount} channels instead of mono; ` +
        'echo cancellation may be less effective.'
    );
  }

  return { summary, echoCancellationActive: applied.echoCancellation, warnings };
};

/** The subset of a track this module needs; keeps the helpers pure/testable. */
export interface CaptureState {
  readyState?: string;
  muted?: boolean;
  enabled?: boolean;
}

/**
 * True when a capture is actually being published.
 *
 * A `live` track that the browser has muted (another capture holds the device,
 * or the OS revoked it) carries no audio, and a disabled track is muted
 * locally. Both need a replacement; a genuinely healthy capture must never be
 * reopened, because every `getUserMedia` of a running device adds a click, a
 * second processing pipeline and contention with the customer's AI capture.
 */
export const isCapturePublishable = (
  track: CaptureState | null | undefined,
  micMuted = false
): boolean => {
  if (!track) return false;
  if (track.readyState !== 'live') return false;
  if (track.muted === true) return false;
  if (track.enabled === false && !micMuted) return false;
  return true;
};
