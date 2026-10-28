/**
 * Prototype 2 call engine.
 *
 * Owns every media and signaling concern for one participant, independent of
 * the React tree:
 *   - WebSocket signaling (join, offer/answer/ICE relay, AI text relay)
 *   - the single RTCPeerConnection used for salesperson <-> customer audio
 *   - microphone acquisition, mute, track recovery and diagnostics
 *   - the customer-side Ultravox session that feeds the AI pipeline
 *
 * Negotiation policy: the salesperson is always the offerer, the customer is
 * always the answerer. This removes glare by construction.
 */
import { UltravoxSession, UltravoxSessionStatus, Role, Medium } from 'ultravox-client';
import {
  AI_RECONNECT_DELAYS_MS,
  AI_RECONNECT_MAX_ATTEMPTS,
  AiStatus,
  AiLifecycleState,
  emptyAiStatus,
  isLiveAiStatus,
  sanitizeAiDetail,
} from './aiStatus';
import { ApiError, getHealth, getIceConfig, IceConfigResponse } from './sessionApi';

export type ParticipantRole = 'customer' | 'salesperson';
export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type EngineCallState =
  | 'idle'
  | 'requesting_mic'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed'
  | 'mic_denied'
  | 'rejected'
  | 'ended';

export interface SuggestionCard {
  id: string;
  ordinal: number;
  text: string;
  isFinal: boolean;
  timestamp: string;
}

/**
 * What the browser is actually doing with the incoming participant audio.
 * `blocked` means the autoplay policy refused playback; `paused` means the
 * element exists but is not running (interruption, stale element, ended stream).
 */
export type AudioPlaybackState = 'no-track' | 'playing' | 'paused' | 'blocked' | 'ended' | 'error';

/**
 * The salesperson-facing answer to "is the customer's voice reaching me?".
 * Each code maps to exactly one distinct condition, so the UI never reports
 * working audio merely because WebRTC says "connected".
 */
export type AudioHealthCode =
  | 'no-peer'
  | 'transport-down'
  | 'no-remote-track'
  | 'no-packets'
  | 'silent'
  | 'playback-blocked'
  | 'playback-paused'
  | 'not-sending'
  | 'ok';

export interface IncomingAudioStatus {
  /** The customer participant is present in the session. */
  customerConnected: boolean;
  /** ICE + DTLS are connected (transport only — never proof of audio). */
  transportConnected: boolean;
  /** Inbound audio RTP packets counted on the receiver. */
  packetsReceived: number;
  /** Inbound audio RTP bytes counted on the receiver. */
  bytesReceived: number;
  /** Measurable sound arrived recently (audio level / energy). */
  soundDetected: boolean;
  /** True when the browser exposes a measurable inbound audio level. */
  soundMeasurable: boolean;
  /** Latest inbound audio level (0..1) when the browser reports one. */
  audioLevel: number | null;
  remoteTrack: 'none' | 'live' | 'muted' | 'ended';
  playback: AudioPlaybackState;
  code: AudioHealthCode;
  /** Actionable, salesperson-only warning. Null when audio is healthy. */
  warning: string | null;
}

export interface CallDiagnostics {
  wsStatus: WsStatus;
  pcState: RTCPeerConnectionState | 'none';
  iceState: RTCIceConnectionState | 'none';
  iceGatheringState: RTCIceGatheringState | 'none';
  dtlsState: string;
  selectedLocalType: string;
  selectedRemoteType: string;
  relayPath: boolean;
  candidates: { host: number; srflx: number; prflx: number; relay: number };
  bytesSent: number;
  bytesReceived: number;
  sendBitrateKbps: number;
  receiveBitrateKbps: number;
  localSenderCount: number;
  localTrackState: string;
  remoteTrackState: string;
  remoteTrackMuted: boolean | null;
  audioElementPaused: boolean | null;
  audioElementMuted: boolean | null;
  audioElementVolume: number | null;
  playbackError: string | null;
  hasTurn: boolean;
  iceTransportPolicy: 'all' | 'relay';
  /** RTP is arriving right now (the only proof of working inbound audio). */
  mediaFlowing: boolean;
  /** Inbound audio RTP packets counted by the receiver. */
  inboundPackets: number;
  /** Outbound audio RTP packets counted by the sender. */
  outboundPackets: number;
  /** Inbound audio RTP packets lost (cumulative), when the browser reports it. */
  inboundPacketsLost: number;
  /** Latest inbound audio level (0..1) when the browser exposes one. */
  inboundAudioLevel: number | null;
  /** Latest local capture level (0..1), i.e. what this device is sending. */
  localAudioLevel: number | null;
  /** True when the browser can measure inbound audio level/energy at all. */
  inboundSoundMeasurable: boolean;
  /** Measurable sound arrived within the last few seconds. */
  inboundSound: boolean;
  /** Milliseconds since sound was last detected (null = never). */
  lastSoundAgoMs: number | null;
  /** Remote audio track readyState / enabled / muted flags. */
  remoteTrackEnabled: boolean | null;
  /** Negotiated direction of this participant's audio transceiver. */
  sendDirection: string;
  /** ReadyState of the track this participant is publishing. */
  senderTrackState: string;
  /** Whether the incoming audio is actually playing through the element. */
  playbackState: AudioPlaybackState;
  /** Media element playback position (proves the clock advances). */
  audioElementCurrentTime: number | null;
  /** Sanitized last audio report relayed by the customer device. */
  peerAudioReport: string | null;
  /** Which RTP directions produced bytes in the last sample (diagnosis aid). */
  audioFlow: 'both' | 'inbound-only' | 'outbound-only' | 'none';
  /** Milliseconds since the last inbound RTP increase (null = never). */
  lastMediaAgoMs: number | null;
}

export interface EngineSnapshot {
  sessionId: string;
  role: ParticipantRole;
  participantId: string | null;
  wsStatus: WsStatus;
  callState: EngineCallState;
  peerPresent: boolean;
  peerParticipantId: string | null;
  peerRole: ParticipantRole | null;
  participants: Array<{ participantId: string; role: ParticipantRole }>;
  micPermission: 'unknown' | 'requesting' | 'granted' | 'denied';
  micMuted: boolean;
  localTrackState: 'none' | 'live' | 'ended';
  localTrackMuted: boolean;
  localSenderCount: number;
  remoteTrackState: 'none' | 'live' | 'ended';
  speakerMuted: boolean;
  audioUnlocked: boolean;
  playbackBlocked: boolean;
  aiStatus: UltravoxSessionStatus | AiLifecycleState;
  aiError: string | null;
  /** Full AI lifecycle state (local for the customer, reported for the salesperson). */
  ai: AiStatus;
  /** Salesperson only: when they asked the customer device to restart the AI. */
  aiReconnectRequestedAt: number | null;
  suggestions: SuggestionCard[];
  customerSpeech: string;
  /**
   * Salesperson only: browser speech-recognition state for salesperson captions.
   * 'unsupported' means the browser has no SpeechRecognition implementation; the
   * call itself keeps working and the customer simply sees no captions.
   */
  captionStatus: 'off' | 'listening' | 'paused' | 'unsupported' | 'error';
  /** Customer only: latest caption text received from the salesperson. */
  salespersonCaption: string;
  reconnectAttempt: number;
  lastError: string | null;
  lastServerError: string | null;
  /** True once the session-authenticated ICE payload was applied. */
  iceConfigLoaded: boolean;
  iceConfigError: string | null;
  iceConfigWarnings: string[];
  turnConfigured: boolean;
  turnCredentialMode: 'ephemeral' | 'static' | 'provider' | 'none';
  turnExpiresAt: number | null;
  relayCandidates: number;
  selectedPair: string;
  /** RTP actually arriving within the last few seconds (not just "connected"). */
  mediaFlowing: boolean;
  /**
   * Salesperson only: whether the customer's voice is really reaching this
   * device (transport, packets, measurable sound and playback, separately).
   * Never exposed to the customer.
   */
  audioHealth: IncomingAudioStatus | null;
  diagnostics: CallDiagnostics;
  logs: string[];
}

export interface CallEngineOptions {
  sessionId: string;
  role: ParticipantRole;
  credential: string;
  resumeToken?: string | null;
  apiBase?: string;
  onUpdate: (snapshot: EngineSnapshot) => void;
  /** Customer only: start the Ultravox AI session after joining. */
  enableAi?: boolean;
  /** Notified when the server rotates/returns the resume token. */
  onResumeToken?: (token: string) => void;
  /**
   * Test seam: replace the real `UltravoxSession`. Production never sets this.
   * The fake must implement the same subset of the SDK API.
   */
  createAiSession?: () => UltravoxSession;
  /** Test seam: override automatic AI recovery backoff (ms per attempt). */
  aiRetryDelaysMs?: readonly number[];
  /** Test seam: backoff before each automatic ICE-restart attempt. */
  iceRestartDelaysMs?: readonly number[];
  /** Test seam: how long an unanswered local offer may stay outstanding. */
  offerAnswerTimeoutMs?: number;
  /** Test seam: grace period before a `disconnected` transport is treated as broken. */
  disconnectGraceMs?: number;
  /** Test seam: how long an ICE restart is given to restore media. */
  iceRestartVerifyMs?: number;
  /** Test seam: upper bound for one ICE configuration request. */
  iceConfigTimeoutMs?: number;
  /** Test seam: backoff between ICE configuration fetch attempts. */
  iceConfigRetryDelaysMs?: readonly number[];
  /** Test seam: how long a peer connection may stay unconnected before recovery. */
  connectWatchdogMs?: number;
  /** Test seam: how often a connected call is checked for real audio. */
  mediaFlowCheckMs?: number;
  /** Test seam: grace for a connected call that has never delivered RTP. */
  mediaFlowGraceMs?: number;
  /** Test seam: allowed silence after audio was flowing. */
  mediaStallMs?: number;
  /** Test seam: cadence of the media-element playback supervisor. */
  playbackCheckMs?: number;
  /** Test seam: how long the salesperson waits for audio after a re-publish request. */
  audioRepairWaitMs?: number;
}

const RECONNECT_BASE_DELAY_MS = 800;
const RECONNECT_MAX_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 8;
const JOIN_ACK_TIMEOUT_MS = 10000;
const MAX_LOGS = 140;

/**
 * How long the SDK may spend connecting before the attempt is treated as
 * failed and a fresh call is requested. The SDK has no public connect timeout.
 */
const AI_CONNECT_TIMEOUT_MS = 20000;
/** Bounded teardown: `leaveCall()` must never delay leaving the human call. */
const AI_LEAVE_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// WebRTC negotiation / recovery policy
//
// Exactly one participant (the salesperson) may create offers. Every offer is
// tracked so presence refreshes can never create a second, competing offer for
// the same negotiation. Recovery is explicit and bounded: ICE restarts with
// backoff, then a terminal failure that the user can deliberately retry.
// ---------------------------------------------------------------------------

/** An offer that has not been answered in this window is rolled back and retried. */
const OFFER_ANSWER_TIMEOUT_MS = 12000;
/** Total offers allowed for one initial negotiation before it is terminal. */
const MAX_NEGOTIATION_ATTEMPTS = 3;
/** Total ICE-restart attempts (automatic) before the connection is terminal. */
const MAX_ICE_RESTART_ATTEMPTS = 3;
/** Bounded backoff for automatic ICE restarts. */
const ICE_RESTART_DELAYS_MS = [1000, 4000, 9000] as const;
/** How long an ICE restart is given to restore media before the next attempt. */
const ICE_RESTART_VERIFY_MS = 10000;
/**
 * A peer connection that never reaches `connected` must not stay "connecting"
 * forever: some ICE agents never emit `failed` (for example when every
 * candidate is discarded). The watchdog starts the bounded recovery sequence.
 */
const CONNECT_WATCHDOG_MS = 20000;
/**
 * A `connected` peer connection proves ICE+DTLS, not that audio is flowing. A
 * call that connects but delivers no RTP (dead relay path, one-way NAT, blocked
 * media port range) is silent for as long as nothing checks. This is how long a
 * freshly connected call may deliver no inbound RTP before recovery starts, and
 * how long media may stop mid-call before the same recovery runs.
 */
const MEDIA_FLOW_CHECK_MS = 4000;
/** Grace for a freshly connected call that has never delivered any RTP. */
const MEDIA_FLOW_GRACE_MS = 8000;
/**
 * Allowed silence before a call that WAS carrying audio is treated as broken.
 * Kept generous: two people not talking for twenty seconds is not a fault.
 */
const MEDIA_STALL_MS = 20000;
/** Inbound RTP this recent is reported as ``mediaFlowing`` in the snapshot. */
const MEDIA_FLOW_FRESH_MS = 5000;
/**
 * Inbound audio level (0..1 RMS) above this counts as "measurable sound".
 * Browser echo cancellation leaves digital silence at ~0, and real speech is
 * usually well above 0.002, so this is a conservative audibility threshold.
 */
const AUDIBLE_LEVEL = 0.0015;
/** How long a detected sound keeps being reported as present. */
const SOUND_FRESH_MS = 6000;
/** How often the playback supervisor reconciles the audio element. */
const PLAYBACK_CHECK_MS = 1200;
/**
 * A media element with a live remote track whose clock does not advance for
 * this long is stale (remounted element, interrupted audio route, stuck
 * pipeline). The supervisor re-attaches the stream instead of staying silent.
 */
const PLAYBACK_STALL_MS = 4000;
/**
 * Before interrupting the working direction with an ICE restart, the
 * salesperson asks the customer device to re-publish its microphone and waits
 * this long for inbound audio to come back.
 */
const AUDIO_REPAIR_WAIT_MS = 6000;
/** How many times one peer connection may ask for a re-publish first. */
const MAX_AUDIO_REPAIR_REQUESTS = 2;
/** A `disconnected` transport may recover on its own; only then is it broken. */
const DISCONNECT_GRACE_MS = 4000;
/** Actionable, credential-free terminal error shown to both participants. */
const TERMINAL_PEER_ERROR =
  'The audio connection could not be established. Check your network and use Reconnect to try again.';

// ---------------------------------------------------------------------------
// ICE configuration acquisition policy
//
// The authenticated ICE payload must be fetched *before* a peer connection is
// created, but a single transient failure (a dropped request, a cold server, a
// provider timeout) must not kill the call. Transient failures are retried with
// a short bounded backoff; if the payload still cannot be read:
//   - `ICE_TRANSPORT_POLICY=relay` deployments fail closed (no silent STUN),
//   - everything else continues with direct-connection STUN defaults, which is
//     strictly better than refusing to start a call that may still work.
// ---------------------------------------------------------------------------

/** Upper bound for one ICE configuration request. */
const ICE_CONFIG_TIMEOUT_MS = 8000;
/** Bounded backoff between transient ICE configuration attempts. */
const ICE_CONFIG_RETRY_DELAYS_MS = [400, 1200] as const;

/** HTTP statuses that a retry can plausibly fix. */
const isRetryableIceStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * A fetch that never reached the server throws a TypeError / AbortError rather
 * than producing an ApiError. Those are transport failures and are retryable.
 * Authorization (401/403) and session (404) failures are not.
 */
const isRetryableIceError = (error: unknown): boolean => {
  if (error instanceof ApiError) return isRetryableIceStatus(error.status);
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') return isRetryableIceStatus(status);
  return true;
};

/** Short, credential-free description for the salesperson diagnostics. */
const describeIceFetchError = (error: unknown): string => {
  if (error instanceof ApiError) {
    const detail = error.message.trim();
    return detail
      ? `ICE configuration request failed (${error.code || `HTTP ${error.status}`}): ${detail}`
      : `ICE configuration request failed (HTTP ${error.status}).`;
  }
  const name = (error as { name?: unknown })?.name;
  const message = String((error as { message?: unknown })?.message || error || 'unknown error');
  if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(message)) {
    return 'ICE configuration request timed out.';
  }
  // Network-level failure (the browser's own "Failed to fetch" text is kept for
  // the salesperson log; it is never rendered to a customer).
  return `ICE configuration request could not reach the server: ${message}`;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

// Used only before the authenticated payload arrives; start() aborts if the
// real configuration cannot be fetched, so this never silently goes live.
const DEFAULT_ICE: IceConfigResponse = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  hasTurn: false,
  hasStun: true,
  iceTransportPolicy: 'all',
  turn: { configured: false, credentialMode: 'none', urlCount: 0, expiresAt: null },
  warnings: [],
  errors: [],
  generatedAt: new Date(0).toISOString(),
};

const hasLiveAudioTrack = (stream: MediaStream | null): boolean =>
  Boolean(stream && stream.getAudioTracks().some((track) => track.readyState === 'live'));

/** Extracts the ICE ufrag/pwd pair, used to reject duplicate SDP offers. */
const iceCredentials = (sdp: string | null): string | null => {
  if (!sdp) return null;
  const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/);
  const pwd = sdp.match(/a=ice-pwd:([^\r\n]+)/);
  return ufrag && pwd ? `${ufrag[1]}|${pwd[1]}` : null;
};

/** A tiny silent WAV used to unlock playback inside the join gesture. */
const silentClipUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const sampleRate = 8000;
  const frameCount = Math.floor(sampleRate * 0.5);
  const buffer = new ArrayBuffer(44 + frameCount);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + frameCount, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeString(36, 'data');
  view.setUint32(40, frameCount, true);
  const bytes = new Uint8Array(buffer, 44);
  bytes.fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
};

export class CallEngine {
  private readonly options: CallEngineOptions;
  private readonly apiBase: string;
  private readonly silentClip: string;

  // Media / signaling objects
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private ultravox: UltravoxSession | null = null;
  private readonly createAiSession: () => UltravoxSession;

  // Lifecycle flags
  private started = false;
  private stopped = false;
  private intentionalLeave = false;
  private connecting = false;
  private joinedThisSocket = false;
  private makingOffer = false;
  /** An offer was sent and has not been answered yet (per peer connection). */
  private offerInFlight = false;
  /** A matching answer is currently being applied to this peer connection. */
  private answerInFlight = false;
  private audioUnlocked = false;
  private pcGeneration = 0;
  private recoveryInFlight = false;

  // Peer-connection recovery state. All of it is per peer connection and is
  // cleared when that connection is replaced or the call ends.
  /** Latched only after every permitted recovery attempt failed. */
  private peerFailureConfirmed = false;
  private negotiationAttempts = 0;
  private iceRestartAttempts = 0;
  private iceRestartInFlight = false;
  /**
   * True while a recovery was started because the call was connected but no
   * audio was arriving. The ICE-restart budget must keep counting until audio
   * is actually observed, otherwise a transport that reconnects silently would
   * reset the budget forever.
   */
  private awaitingMediaAfterRecovery = false;
  /** True while an ICE-credential refresh is running as part of recovery. */
  private recoveryAttemptInFlight = false;
  private pendingIceRestartReason: string | null = null;
  private pendingIceRestartForce = false;

  // Timers
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private joinTimeout: number | null = null;
  private statsTimer: number | null = null;
  private reportTimer: number | null = null;
  private micRecoveryTimer: number | null = null;
  private offerWatchdog: number | null = null;
  private negotiationRetryTimer: number | null = null;
  private iceRestartTimer: number | null = null;
  private iceRestartVerifyTimer: number | null = null;
  private disconnectGraceTimer: number | null = null;
  private connectWatchdog: number | null = null;
  private mediaWatchdog: number | null = null;
  /** Sender that carries this participant's microphone to the peer. */
  private audioSender: RTCRtpSender | null = null;
  /** Inbound audio telemetry (never exposed to the customer). */
  private lastSoundAt = 0;
  private inboundSoundMeasurable = false;
  private lastInboundPackets = 0;
  /** Playback supervision state for the remote audio element. */
  private playbackState: AudioPlaybackState = 'no-track';
  private playbackTimer: number | null = null;
  private playbackClock = 0;
  private playbackClockAt = 0;
  private playbackStalledSince = 0;
  /** Bounded "ask the customer to re-publish audio" recovery bookkeeping. */
  private audioRepairRequests = 0;
  private lastAudioRepairAt = 0;
  private peerAudioReport: string | null = null;
  private audioRenegotiateRequests = 0;

  // Negotiation state
  private participantId: string | null = null;
  private resumeToken: string | null;
  private peerParticipantId: string | null = null;
  private peerRole: ParticipantRole | null = null;
  private pendingIce: Array<{ candidate: RTCIceCandidateInit; from: string | null }> = [];
  private lastRemoteOfferSdp: string | null = null;
  private iceConfig: IceConfigResponse = DEFAULT_ICE;
  private iceConfigLoaded = false;
  private iceConfigError: string | null = null;
  private iceConfigWarnings: string[] = [];
  /** Where the applied configuration came from. */
  private iceConfigSource: 'none' | 'server' | 'fallback' = 'none';
  private iceRefreshInFlight = false;
  private lastMediaAt = 0;
  private dtlsState = 'none';

  // Observed state
  private wsStatus: WsStatus = 'disconnected';
  private callState: EngineCallState = 'idle';
  private micPermission: EngineSnapshot['micPermission'] = 'unknown';
  private micMuted = false;
  private speakerMuted = false;
  private playbackBlocked = false;
  private playbackError: string | null = null;
  private remoteTrackState: EngineSnapshot['remoteTrackState'] = 'none';
  private aiStatus: EngineSnapshot['aiStatus'] = 'off';
  private aiError: string | null = null;
  private ai: AiStatus = emptyAiStatus('local');
  /** Incremented on every new/stopped session; stale callbacks are ignored. */
  private aiGeneration = 0;
  private aiOperationInFlight = false;
  private aiRecoveryAttempt = 0;
  private aiRecoveryTimer: number | null = null;
  private aiConnectTimer: number | null = null;
  private aiEverConnected = false;
  private aiConnectedSince: number | null = null;
  private aiReconnectRequestedAt: number | null = null;
  private suggestions: SuggestionCard[] = [];
  private customerSpeech = '';
  private captionStatus: EngineSnapshot['captionStatus'] = 'off';
  private salespersonCaption = '';
  private recognition: any = null;
  private recognitionWanted = false;
  private recognitionRestartTimer: number | null = null;
  private lastError: string | null = null;
  private lastServerError: string | null = null;
  private logs: string[] = [];
  private participants: Array<{ participantId: string; role: ParticipantRole }> = [];
  private candidateTypes = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  private diagnostics: CallDiagnostics = {
    wsStatus: 'disconnected',
    pcState: 'none',
    iceState: 'none',
    iceGatheringState: 'none',
    dtlsState: 'none',
    selectedLocalType: 'none',
    selectedRemoteType: 'none',
    relayPath: false,
    candidates: { host: 0, srflx: 0, prflx: 0, relay: 0 },
    bytesSent: 0,
    bytesReceived: 0,
    sendBitrateKbps: 0,
    receiveBitrateKbps: 0,
    localSenderCount: 0,
    localTrackState: 'none',
    remoteTrackState: 'none',
    remoteTrackMuted: null,
    audioElementPaused: null,
    audioElementMuted: null,
    audioElementVolume: null,
    playbackError: null,
    hasTurn: false,
    iceTransportPolicy: 'all',
    mediaFlowing: false,
    inboundPackets: 0,
    outboundPackets: 0,
    inboundPacketsLost: 0,
    inboundAudioLevel: null,
    localAudioLevel: null,
    inboundSoundMeasurable: false,
    inboundSound: false,
    lastSoundAgoMs: null,
    remoteTrackEnabled: null,
    sendDirection: 'unknown',
    senderTrackState: 'none',
    playbackState: 'no-track',
    audioElementCurrentTime: null,
    peerAudioReport: null,
    audioFlow: 'none',
    lastMediaAgoMs: null,
  };
  private lastStats: { at: number; bytesSent: number; bytesReceived: number } | null = null;
  /** Cumulative inbound audio energy, used to detect real (non-silent) audio. */
  private lastInboundEnergy: number | null = null;

  /** State of the track this participant publishes to the peer. */
  private senderTrack(): string {
    const track = this.audioSender?.track ?? this.localStream?.getAudioTracks()[0] ?? null;
    if (!track) return 'none';
    return `${track.readyState}${track.enabled ? '' : ' (disabled)'}${track.muted ? ' (muted)' : ''}`;
  }

  constructor(options: CallEngineOptions) {
    this.options = options;
    this.apiBase = options.apiBase ?? '';
    this.resumeToken = options.resumeToken ?? null;
    this.silentClip = silentClipUrl();
    this.createAiSession = options.createAiSession ?? (() => new UltravoxSession());
    this.ai = emptyAiStatus(options.role === 'customer' ? 'local' : 'remote');
  }

  // -------------------------------------------------------------------------
  // Snapshot plumbing
  // -------------------------------------------------------------------------

  getSnapshot(): EngineSnapshot {
    return {
      sessionId: this.options.sessionId,
      role: this.options.role,
      participantId: this.participantId,
      wsStatus: this.wsStatus,
      callState: this.callState,
      peerPresent: Boolean(this.peerParticipantId) && this.callState === 'connected',
      peerParticipantId: this.peerParticipantId,
      peerRole: this.peerRole,
      participants: this.participants,
      micPermission: this.micPermission,
      micMuted: this.micMuted,
      localTrackState: this.localTrackState(),
      localTrackMuted: Boolean(this.localStream?.getAudioTracks()[0]?.muted),
      localSenderCount: this.pc?.getSenders().filter((s) => s.track?.kind === 'audio').length ?? 0,
      remoteTrackState: this.remoteTrackState,
      speakerMuted: this.speakerMuted,
      audioUnlocked: this.audioUnlocked,
      playbackBlocked: this.playbackBlocked,
      aiStatus: this.aiStatus,
      aiError: this.aiError,
      ai: this.ai,
      aiReconnectRequestedAt: this.aiReconnectRequestedAt,
      suggestions: this.suggestions,
      customerSpeech: this.customerSpeech,
      captionStatus: this.captionStatus,
      salespersonCaption: this.salespersonCaption,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
      lastServerError: this.lastServerError,
      iceConfigLoaded: this.iceConfigLoaded,
      iceConfigError: this.iceConfigError,
      iceConfigWarnings: this.iceConfigWarnings,
      turnConfigured: this.iceConfig.turn.configured,
      turnCredentialMode: this.iceConfig.turn.credentialMode,
      turnExpiresAt: this.iceConfig.turn.expiresAt,
      relayCandidates: this.candidateTypes.relay,
      selectedPair:
        this.diagnostics.selectedLocalType === 'none'
          ? 'none'
          : `${this.diagnostics.selectedLocalType} → ${this.diagnostics.selectedRemoteType}`,
      mediaFlowing: this.lastMediaAt > 0 && Date.now() - this.lastMediaAt < MEDIA_FLOW_FRESH_MS,
      audioHealth: this.computeAudioHealth(),
      diagnostics: { ...this.diagnostics, wsStatus: this.wsStatus },
      logs: this.logs,
    };
  }

  /**
   * Builds the distinct inbound-audio states the salesperson UI must show.
   *
   * "connected" is only the transport. Audio is reported as working only when
   * packets are arriving, measurable sound was detected and the browser is
   * actually playing the stream. The result stays null for the customer, so no
   * private diagnostics are ever rendered on the customer device.
   */
  private computeAudioHealth(): IncomingAudioStatus | null {
    if (this.options.role !== 'salesperson') return null;

    const customerConnected =
      Boolean(this.peerParticipantId) ||
      this.participants.some((participant) => participant.role === 'customer');
    const transportConnected = this.isPeerConnected();
    const track = this.remoteAudioTrack();
    const remoteTrack: IncomingAudioStatus['remoteTrack'] = !track
      ? this.remoteTrackState === 'ended'
        ? 'ended'
        : 'none'
      : track.readyState !== 'live'
        ? 'ended'
        : track.muted
          ? 'muted'
          : 'live';

    const packetsReceived = this.diagnostics.inboundPackets;
    const bytesReceived = this.diagnostics.bytesReceived;
    const soundDetected = this.lastSoundAt > 0 && Date.now() - this.lastSoundAt < SOUND_FRESH_MS;
    const playback = this.playbackState;

    let code: AudioHealthCode = 'ok';
    let warning: string | null = null;
    if (!customerConnected) {
      code = 'no-peer';
    } else if (!transportConnected) {
      code = 'transport-down';
      warning =
        'The customer is connected, but the WebRTC audio transport is not. Check your network (a TURN relay is required across mobile networks) and press Reconnect.';
    } else if (packetsReceived === 0 && (remoteTrack === 'none' || remoteTrack === 'ended')) {
      code = 'no-remote-track';
      warning =
        "The customer's microphone track is not arriving. Press Ask customer to check mic, then Reconnect if it does not recover.";
    } else if (packetsReceived === 0) {
      code = 'no-packets';
      warning =
        'No incoming audio packets are arriving from the customer. Press Ask customer to check mic, then Reconnect if it does not recover.';
    } else if (this.inboundSoundMeasurable && !soundDetected) {
      code = 'silent';
      warning =
        'Audio packets are arriving, but they contain no measurable sound. The customer may be muted, their microphone may be blocked, or it may not be reaching the call.';
    } else if (playback === 'blocked') {
      code = 'playback-blocked';
      warning = 'The browser blocked playback of the customer audio. Press Enable audio.';
    } else if (playback === 'paused' || playback === 'error' || playback === 'no-track') {
      code = 'playback-paused';
      warning =
        'The customer audio is not playing through this device. Press Enable audio, or Reconnect if it stays paused.';
    }

    return {
      customerConnected,
      transportConnected,
      packetsReceived,
      bytesReceived,
      soundDetected,
      soundMeasurable: this.inboundSoundMeasurable,
      audioLevel: this.diagnostics.inboundAudioLevel,
      remoteTrack,
      playback,
      code,
      warning,
    };
  }

  private emit(): void {
    try {
      this.options.onUpdate(this.getSnapshot());
    } catch (err) {
      // Never let a render error break media handling.
      console.error('CallEngine onUpdate failed', err);
    }
  }

  private log(message: string): void {
    const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs = [...this.logs.slice(-(MAX_LOGS - 1)), entry];
    this.diagnostics = { ...this.diagnostics, wsStatus: this.wsStatus };
    this.emit();
  }

  private localTrackState(): EngineSnapshot['localTrackState'] {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return 'none';
    return track.readyState === 'live' ? 'live' : 'ended';
  }

  private setState(patch: Partial<{
    wsStatus: WsStatus;
    callState: EngineCallState;
    playbackBlocked: boolean;
    aiStatus: EngineSnapshot['aiStatus'];
    aiError: string | null;
    lastError: string | null;
    reconnectAttempt: number;
  }>): void {
    if (patch.wsStatus !== undefined) this.wsStatus = patch.wsStatus;
    if (patch.callState !== undefined) this.callState = patch.callState;
    if (patch.playbackBlocked !== undefined) this.playbackBlocked = patch.playbackBlocked;
    if (patch.aiStatus !== undefined) this.aiStatus = patch.aiStatus;
    if (patch.aiError !== undefined) this.aiError = patch.aiError;
    if (patch.lastError !== undefined) this.lastError = patch.lastError;
    if (patch.reconnectAttempt !== undefined) this.reconnectAttempt = patch.reconnectAttempt;
    this.emit();
  }

  /**
   * Binds the remote-audio element. Safe to call again at any time (React
   * remount, view switch, error banner): a stream received before the element
   * existed — or after it was replaced — is re-attached instead of being
   * silently dropped, which is one way the salesperson ended up "connected"
   * with no audio at all.
   */
  attachAudioElement(element: HTMLAudioElement | null): void {
    if (this.audioElement === element) {
      if (element && this.remoteStream && element.srcObject !== this.remoteStream) {
        this.attachRemoteStream(this.remoteStream);
      }
      return;
    }
    const previous = this.audioElement;
    if (previous && previous !== element) {
      try {
        previous.pause();
        previous.srcObject = null;
      } catch {
        // Ignore teardown errors on a detached element.
      }
    }
    this.audioElement = element;
    if (element) {
      this.log('Remote audio element attached.');
      if (this.remoteStream) this.attachRemoteStream(this.remoteStream);
      this.startPlaybackSupervisor();
    } else {
      this.stopPlaybackSupervisor();
      this.playbackState = 'no-track';
    }
  }

  // -------------------------------------------------------------------------
  // Audio playback (autoplay unlock + remote stream attachment)
  // -------------------------------------------------------------------------

  /** Must be called from a user gesture (the Join click). */
  async unlockAudio(): Promise<boolean> {
    const element = this.audioElement;
    if (!element) return false;
    element.muted = this.speakerMuted;
    element.volume = 1;
    try {
      if (!element.srcObject) {
        element.src = this.silentClip;
        element.loop = true;
        element.load();
      }
      await element.play();
      this.audioUnlocked = true;
      this.playbackError = null;
      this.playbackBlocked = false;
      // A silent clip counts as "unlocked", not as playing customer audio: the
      // state is only "playing" once a live remote track is attached.
      if (!this.remoteAudioTrack()) this.playbackState = 'no-track';
      this.log('Remote audio element unlocked by user gesture.');
      return true;
    } catch (err) {
      const error = err as Error;
      this.audioUnlocked = false;
      this.playbackBlocked = true;
      this.playbackError = `${error?.name || 'Error'}: ${error?.message || error}`;
      this.playbackState = 'blocked';
      this.log(`Remote audio unlock rejected: ${this.playbackError}`);
      return false;
    }
  }

  /** Retries playback after a blocked autoplay attempt (tap anywhere). */
  async resumePlayback(): Promise<boolean> {
    const element = this.audioElement;
    if (!element) return false;
    if (element.srcObject || this.remoteStream) {
      if (!element.srcObject && this.remoteStream) {
        this.attachRemoteStream(this.remoteStream);
        return true;
      }
      element.muted = this.speakerMuted;
      try {
        await element.play();
        this.playbackBlocked = false;
        this.playbackError = null;
        this.audioUnlocked = true;
        this.playbackState = this.remoteAudioTrack() ? 'playing' : 'no-track';
        this.log('Remote audio resumed after user interaction.');
        this.emit();
        return true;
      } catch (err) {
        const error = err as Error;
        this.playbackBlocked = true;
        this.playbackState = 'blocked';
        this.playbackError = `${error?.name || 'Error'}: ${error?.message || error}`;
        this.log(`Remote audio resume failed: ${this.playbackError}`);
        this.emit();
        return false;
      }
    }
    return this.unlockAudio();
  }

  /** The single remote audio track this participant is supposed to hear. */
  private remoteAudioTrack(): MediaStreamTrack | null {
    return (this.remoteStream?.getAudioTracks() ?? [])[0] ?? null;
  }

  /**
   * Attaches exactly one remote audio track to the element and starts
   * playback. Called for every `ontrack` (including track replacement after a
   * reconnection) and whenever the element (re)appears.
   */
  private attachRemoteStream(stream: MediaStream, options: { silent?: boolean } = {}): void {
    const element = this.audioElement;
    if (!element) {
      // Not an error: the supervisor re-attaches as soon as an element exists.
      this.log('Remote audio element is not mounted yet; keeping the stream for later attachment.');
      this.playbackState = 'no-track';
      return;
    }
    element.muted = this.speakerMuted;
    element.volume = 1;
    element.loop = false;
    if (!options.silent) {
      // A stale `src` (the silent unlock clip) must never shadow srcObject.
      try {
        element.pause();
      } catch {
        // Ignore.
      }
      if (element.getAttribute('src')) {
        element.removeAttribute('src');
        try {
          element.load();
        } catch {
          // Ignore reload errors on detached elements.
        }
      }
    }
    try {
      element.srcObject = stream;
    } catch (err) {
      this.playbackState = 'error';
      this.log(`Could not attach the remote stream: ${(err as Error)?.message || err}`);
      return;
    }
    element
      .play()
      .then(() => {
        this.playbackBlocked = false;
        this.playbackError = null;
        this.audioUnlocked = true;
        this.playbackState = 'playing';
        this.playbackClock = element.currentTime;
        this.playbackClockAt = Date.now();
        this.playbackStalledSince = 0;
        if (!options.silent) this.log('Playing remote audio stream live.');
        this.emit();
      })
      .catch((err: Error) => {
        // AbortError is what a replaced stream produces; it is not a policy block.
        if (err?.name === 'AbortError') return;
        this.playbackBlocked = true;
        this.playbackState = 'blocked';
        this.playbackError = `${err?.name || 'Error'}: ${err?.message || err}`;
        this.log(`Remote audio playback blocked: ${this.playbackError}`);
        this.emit();
      });
  }

  /**
   * Keeps the remote audio element honest for the whole call.
   *
   * Autoplay refusals, audio-route interruptions, a stream attached to an
   * element that React replaced, and a pipeline that stops advancing all end
   * up as "connected but nothing is audible". This supervisor re-attaches and
   * re-plays, and records the real playback state for diagnostics and UI.
   */
  private startPlaybackSupervisor(): void {
    if (this.playbackTimer !== null || !this.audioElement) return;
    const tickMs = this.options.playbackCheckMs ?? PLAYBACK_CHECK_MS;
    this.playbackTimer = window.setInterval(() => this.syncPlayback(), tickMs);
    this.syncPlayback();
  }

  private stopPlaybackSupervisor(): void {
    if (this.playbackTimer !== null) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.playbackClock = 0;
    this.playbackClockAt = 0;
    this.playbackStalledSince = 0;
  }

  private syncPlayback(): void {
    if (this.stopped) return;
    const element = this.audioElement;
    if (!element) {
      this.playbackState = 'no-track';
      return;
    }
    if (element.muted !== this.speakerMuted) element.muted = this.speakerMuted;
    const track = this.remoteAudioTrack();
    if (!track || track.readyState !== 'live') {
      this.playbackState = track ? 'ended' : 'no-track';
      return;
    }
    // The element was replaced (or the stream was restored): re-attach the
    // current stream instead of playing whatever the element still holds.
    if (element.srcObject !== this.remoteStream) {
      if (this.remoteStream) this.attachRemoteStream(this.remoteStream);
      return;
    }
    if (element.paused) {
      if (this.playbackState !== 'blocked') this.playbackState = 'paused';
      void element.play().then(
        () => {
          this.playbackBlocked = false;
          this.playbackState = 'playing';
          this.playbackError = null;
          this.playbackClock = element.currentTime;
          this.playbackClockAt = Date.now();
          this.emit();
        },
        () => {
          this.playbackState = 'blocked';
          this.playbackBlocked = true;
        }
      );
      return;
    }
    // Not paused, but is the clock actually advancing? A "playing" element that
    // never advances produces no sound (interrupted route, stuck pipeline).
    const now = Date.now();
    if (element.currentTime !== this.playbackClock) {
      this.playbackClock = element.currentTime;
      this.playbackClockAt = now;
      this.playbackStalledSince = 0;
      if (this.playbackState !== 'playing') this.playbackState = 'playing';
      if (this.playbackBlocked) {
        this.playbackBlocked = false;
        this.playbackError = null;
        this.emit();
      }
      return;
    }
    if (this.playbackStalledSince === 0) {
      this.playbackStalledSince = now;
      return;
    }
    if (now - this.playbackStalledSince < PLAYBACK_STALL_MS) return;
    this.playbackStalledSince = 0;
    this.playbackState = 'paused';
    this.log('Remote audio element stopped advancing; re-attaching the stream.');
    if (this.remoteStream) this.attachRemoteStream(this.remoteStream);
    this.emit();
  }

  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    if (this.audioElement) this.audioElement.muted = muted;
    this.log(
      muted
        ? `${this.options.role === 'customer' ? 'Salesperson' : 'Customer'} audio playback muted locally.`
        : `${this.options.role === 'customer' ? 'Salesperson' : 'Customer'} audio playback unmuted.`
    );
  }

  // -------------------------------------------------------------------------
  // Start / stop
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.intentionalLeave = false;
    this.reconnectAttempt = 0;

    this.setState({ callState: 'requesting_mic', lastError: null });
    void this.unlockAudio();

    const iceReady = await this.loadIceConfig();
    if (!iceReady) {
      // Never silently fall back to STUN-only when the deployment requires a
      // relay or the configuration could not be verified.
      this.started = false;
      this.releaseLocalMedia('ICE configuration failed');
      this.callState = 'failed';
      this.emit();
      return;
    }

    const stream = await this.ensureLocalStream();
    if (!stream) {
      this.started = false;
      this.setState({ callState: 'mic_denied' });
      return;
    }

    this.startCaptions();
    this.startDiagnosticsLoop();
    this.startPlaybackSupervisor();
    this.connectSignaling(false);
  }

  // -------------------------------------------------------------------------
  // Salesperson captions (browser SpeechRecognition -> signaling -> customer)
  //
  // The salesperson's microphone is NOT sent to Ultravox and is NOT merged into
  // the customer's AI audio path. Captions are produced locally by the browser's
  // speech recognizer and forwarded as text over the authenticated signaling
  // socket, which only relays them to the paired customer.
  // -------------------------------------------------------------------------

  private speechRecognitionCtor(): any {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }

  private startCaptions(): void {
    if (this.options.role !== 'salesperson') return;
    const Ctor = this.speechRecognitionCtor();
    if (!Ctor) {
      this.captionStatus = 'unsupported';
      this.log('Browser speech recognition is unavailable; salesperson captions are off.');
      this.emit();
      return;
    }
    if (this.recognition) return;

    try {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

      recognition.onresult = (event: any) => {
        // Only forward while the customer is actually in this session; otherwise
        // the server would answer every caption with PEER_UNAVAILABLE.
        if (!this.peerParticipantId) return;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = String(result?.[0]?.transcript || '').trim();
          if (!text) continue;
          this.sendSignal({ type: 'salesperson_caption', text, isFinal: Boolean(result.isFinal) });
        }
      };

      recognition.onerror = (event: any) => {
        const code = String(event?.error || 'unknown');
        // 'no-speech' and 'aborted' are routine; anything else is reported once.
        if (code === 'no-speech' || code === 'aborted') return;
        this.captionStatus = code === 'not-allowed' || code === 'service-not-allowed' ? 'unsupported' : 'error';
        this.lastError = null;
        this.log(`Salesperson caption recognizer error: ${code}. Call audio is unaffected.`);
        this.emit();
      };

      recognition.onend = () => {
        if (!this.recognitionWanted) return;
        if (this.captionStatus === 'unsupported' || this.captionStatus === 'paused') return;
        // Chrome ends the session periodically; restart while the call is live.
        if (this.recognitionRestartTimer !== null) window.clearTimeout(this.recognitionRestartTimer);
        this.recognitionRestartTimer = window.setTimeout(() => {
          this.recognitionRestartTimer = null;
          if (!this.recognitionWanted || !this.recognition) return;
          try {
            this.recognition.start();
            this.captionStatus = 'listening';
          } catch {
            // Already started or blocked; the next stop()/start() cycle recovers.
          }
          this.emit();
        }, 400);
      };

      this.recognition = recognition;
      this.recognitionWanted = true;
      recognition.start();
      this.captionStatus = 'listening';
      this.log('Salesperson speech recognition started (captions to customer only).');
      this.emit();
    } catch (err) {
      this.recognition = null;
      this.recognitionWanted = false;
      this.captionStatus = 'error';
      this.log(`Could not start salesperson captions: ${(err as Error)?.message || err}. Call audio is unaffected.`);
      this.emit();
    }
  }

  private stopCaptions(): void {
    this.recognitionWanted = false;
    if (this.recognitionRestartTimer !== null) {
      window.clearTimeout(this.recognitionRestartTimer);
      this.recognitionRestartTimer = null;
    }
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // Ignore stop errors on an already-stopped recognizer.
      }
      this.log('Salesperson speech recognition stopped.');
    }
    if (this.options.role === 'salesperson') this.captionStatus = 'off';
  }

  private pauseCaptions(): void {
    if (!this.recognition || this.captionStatus === 'unsupported') return;
    try {
      this.recognition.stop();
    } catch {
      // Ignore.
    }
    this.captionStatus = 'paused';
    this.emit();
  }

  private resumeCaptions(): void {
    if (this.options.role !== 'salesperson') return;
    if (!this.recognition) {
      this.startCaptions();
      return;
    }
    try {
      this.recognition.start();
      this.captionStatus = 'listening';
    } catch {
      // Ignore double starts; the restart handler keeps the loop alive.
    }
    this.emit();
  }

  async stop(reason = 'left the call'): Promise<void> {
    this.intentionalLeave = true;
    this.stopped = true;
    this.started = false;
    this.clearReconnectTimer();
    this.clearJoinTimeout();
    this.stopDiagnosticsLoop();
    this.stopPlaybackSupervisor();
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.srcObject = null;
      } catch {
        // Ignore teardown errors on a detached element.
      }
    }
    this.playbackState = 'no-track';
    this.lastSoundAt = 0;
    this.lastMediaAt = 0;
    this.lastInboundPackets = 0;
    this.peerAudioReport = null;
    this.audioRepairRequests = 0;

    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }));
        socket.onclose = null;
        socket.close(1000, 'client_leave');
      } catch {
        // Ignore close errors.
      }
    }

    await this.stopAi();
    this.stopCaptions();
    this.closePeerConnection(`stop: ${reason}`);
    this.resetPeerRecoveryState('call stopped');
    this.releaseLocalMedia(reason);

    this.participantId = null;
    this.peerParticipantId = null;
    this.peerRole = null;
    this.participants = [];
    this.remoteTrackState = 'none';
    this.wsStatus = 'disconnected';
    this.callState = 'ended';
    this.log(`Call stopped (${reason}).`);
  }

  /**
   * Loads and applies the session's STUN/TURN configuration before any peer
   * connection exists.
   *
   * Returns false only when the call must not start: relay-only deployments
   * (`ICE_TRANSPORT_POLICY=relay`) without a verified relay. In every other
   * case a payload that cannot be fetched after bounded retries degrades to
   * direct-connection STUN defaults instead of failing the whole call.
   */
  private async loadIceConfig(): Promise<boolean> {
    const fetched = await this.fetchIceConfigWithRetry();
    if (!fetched.ok) {
      this.iceConfigLoaded = false;
      this.iceConfigError = fetched.error;
      this.iceConfigWarnings = [];

      const relayRequired = await this.isRelayRequired();
      if (relayRequired) {
        // Fail closed: relay-only without a verified relay produces a
        // connected-but-silent call, which is worse than an honest failure.
        this.iceConfig = { ...DEFAULT_ICE, iceTransportPolicy: 'relay' };
        this.iceConfigSource = 'none';
        this.lastError = TERMINAL_PEER_ERROR;
        this.log(
          `ICE configuration unavailable and relay-only ICE is required; refusing to start. ${fetched.error}`
        );
        return false;
      }

      // Direct paths (host/srflx) can still work, so keep the call startable.
      this.iceConfig = { ...DEFAULT_ICE };
      this.iceConfigSource = 'fallback';
      this.log(
        `ICE configuration unavailable; continuing with direct-connection STUN defaults. ${fetched.error}`
      );
      return true;
    }

    this.applyIceConfig(fetched.config);
    this.iceConfigSource = 'server';

    if (this.iceConfig.errors.length > 0 && this.iceConfig.iceTransportPolicy === 'relay') {
      // The payload itself proves the relay-only deployment has no relay.
      this.lastError =
        this.iceConfig.errors[0] ||
        'Relay-only ICE was requested but no usable TURN relay is configured.';
      return false;
    }
    return true;
  }

  /** Fetches the authenticated ICE payload, retrying transient failures. */
  private async fetchIceConfigWithRetry(): Promise<
    { ok: true; config: IceConfigResponse } | { ok: false; error: string }
  > {
    const retryDelays = this.options.iceConfigRetryDelaysMs ?? ICE_CONFIG_RETRY_DELAYS_MS;
    const timeoutMs = this.options.iceConfigTimeoutMs ?? ICE_CONFIG_TIMEOUT_MS;
    const attempts = retryDelays.length + 1;
    let lastError = 'ICE configuration request failed.';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const config = await getIceConfig(this.options.sessionId, this.options.credential, {
          timeoutMs,
        });
        if (attempt > 1) this.log(`ICE configuration fetched on attempt ${attempt}/${attempts}.`);
        return { ok: true, config };
      } catch (err) {
        lastError = describeIceFetchError(err);
        const retryable = isRetryableIceError(err);
        this.log(
          `ICE configuration attempt ${attempt}/${attempts} failed (${retryable ? 'retryable' : 'permanent'}): ${lastError}`
        );
        if (this.stopped || this.intentionalLeave || !retryable || attempt === attempts) break;
        await delay(retryDelays[attempt - 1]);
      }
    }

    return { ok: false, error: lastError };
  }

  /**
   * Best-effort recovery helper: re-reads the ICE payload so refreshed TURN
   * credentials (provider-issued credentials expire) are applied before an ICE
   * restart reuses them. A failure keeps the currently applied configuration.
   */
  private async refreshIceConfigForRecovery(): Promise<void> {
    if (this.stopped || this.intentionalLeave || this.iceRefreshInFlight) return;
    this.iceRefreshInFlight = true;
    try {
      const config = await getIceConfig(this.options.sessionId, this.options.credential, {
        timeoutMs: this.options.iceConfigTimeoutMs ?? ICE_CONFIG_TIMEOUT_MS,
      });
      if (this.stopped || this.intentionalLeave) return;
      this.applyIceConfig(config);
      this.iceConfigSource = 'server';

      const pc = this.pc;
      if (pc && typeof pc.setConfiguration === 'function') {
        try {
          pc.setConfiguration({
            iceServers: this.iceConfig.iceServers,
            iceTransportPolicy: this.iceConfig.iceTransportPolicy,
            bundlePolicy: 'max-bundle',
          });
          this.log('Applied refreshed ICE configuration to the existing peer connection.');
        } catch (err) {
          this.log(`Could not apply the refreshed ICE configuration: ${(err as Error)?.message || err}`);
        }
      }
    } catch (err) {
      // Never fatal: the previous configuration stays in effect.
      this.log(`ICE configuration refresh failed; keeping the current servers. ${describeIceFetchError(err)}`);
    } finally {
      this.iceRefreshInFlight = false;
    }
  }

  /** Applies a server-issued ICE payload to engine state (never mutates the PC). */
  private applyIceConfig(config: IceConfigResponse): void {
    this.iceConfig = {
      iceServers:
        Array.isArray(config.iceServers) && config.iceServers.length
          ? config.iceServers
          : DEFAULT_ICE.iceServers,
      hasTurn: Boolean(config.hasTurn),
      hasStun: Boolean(config.hasStun),
      iceTransportPolicy: config.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      turn: config.turn ?? DEFAULT_ICE.turn,
      warnings: Array.isArray(config.warnings) ? config.warnings : [],
      errors: Array.isArray(config.errors) ? config.errors : [],
      generatedAt: config.generatedAt || new Date().toISOString(),
    };
    this.iceConfigLoaded = true;
    this.iceConfigError = this.iceConfig.errors[0] ?? null;
    this.iceConfigWarnings = this.iceConfig.warnings;
    this.diagnostics = {
      ...this.diagnostics,
      hasTurn: this.iceConfig.hasTurn,
      iceTransportPolicy: this.iceConfig.iceTransportPolicy,
    };

    const turnServers = this.iceConfig.iceServers.filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => /^turns?:/i.test(url));
    });
    // Never log usernames/credentials, only shape.
    this.log(
      `ICE configuration loaded: ${this.iceConfig.iceServers.length} server entr(ies), ` +
        `TURN ${this.iceConfig.turn.configured ? `configured (${this.iceConfig.turn.credentialMode}, ${turnServers.length} entry)` : 'not configured'}, ` +
        `policy ${this.iceConfig.iceTransportPolicy}.`
    );
    for (const warning of this.iceConfig.warnings) this.log(`ICE warning: ${warning}`);
    for (const error of this.iceConfig.errors) this.log(`ICE error: ${error}`);
  }

  /**
   * `ICE_TRANSPORT_POLICY=relay` is a server-side deployment setting. When the
   * ICE payload cannot be read, the public health endpoint is the only
   * credential-free way to learn whether a STUN-only fallback is allowed.
   */
  private async isRelayRequired(): Promise<boolean> {
    if (this.iceConfigSource === 'server' || this.iceConfigLoaded) {
      return this.iceConfig.iceTransportPolicy === 'relay';
    }
    try {
      const health = await getHealth({ timeoutMs: 4000 });
      return health?.iceTransportPolicy === 'relay';
    } catch {
      // Unknown policy: prefer attempting a direct call over refusing outright.
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Microphone capture, mute and recovery
  // -------------------------------------------------------------------------

  /** Acquires the microphone only when there is no reusable live track. */
  private async ensureLocalStream(force = false): Promise<MediaStream | null> {
    if (!force && hasLiveAudioTrack(this.localStream)) {
      this.log('Reusing the existing live microphone stream (no new permission prompt).');
      return this.localStream;
    }

    this.micPermission = 'requesting';
    this.emit();
    const previous = this.localStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is not available in this browser context.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.localStream = stream;
      const track = stream.getAudioTracks()[0];
      if (track) track.enabled = !this.micMuted;
      this.micPermission = 'granted';
      this.watchLocalTrack(stream);
      if (previous && previous !== stream) {
        // Releasing the old capture is not optional: a second live capture of
        // the same device keeps the microphone "in use", competes with the AI
        // capture, and on some mobile browsers mutes the new track. It also
        // leaves the microphone hot after a recovered call.
        previous.getTracks().forEach((oldTrack) => {
          if (!stream.getTracks().includes(oldTrack)) oldTrack.stop();
        });
        this.log('Stopped the previous microphone capture after re-acquiring it.');
      }
      this.log(
        `Microphone captured (track ${track?.readyState ?? 'missing'}${track?.muted ? ', muted by OS' : ''}).`
      );
      return stream;
    } catch (err) {
      const error = err as Error & { name?: string };
      this.micPermission = 'denied';
      const denied =
        error?.name === 'NotAllowedError' ||
        error?.name === 'PermissionDeniedError' ||
        error?.name === 'SecurityError';
      this.lastError = denied
        ? 'Microphone permission denied. Allow microphone access for this site, then retry.'
        : error?.message || 'Failed to access the microphone.';
      this.log(`Microphone error: ${error?.name || 'Error'} - ${error?.message || error}`);
      return null;
    }
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });

    // The customer's microphone feeds two paths: the peer connection and the
    // AI. Muting must silence both, otherwise the AI keeps transcribing a
    // customer who believes they are muted.
    if (this.options.role === 'customer' && this.ultravox) {
      try {
        if (muted) this.ultravox.muteMic();
        else if (this.ultravox.status !== UltravoxSessionStatus.DISCONNECTED) this.ultravox.unmuteMic();
      } catch {
        // Ignore unsupported transitions before the AI session is live.
      }
    }

    // The salesperson's captions come from the same microphone: muting must stop
    // the recognizer as well, otherwise the customer keeps reading a muted
    // participant's speech.
    if (this.options.role === 'salesperson') {
      if (muted) this.pauseCaptions();
      else this.resumeCaptions();
    }

    if (this.options.role === 'customer' && this.ai.state !== 'off') {
      this.ai = {
        ...this.ai,
        audioReachingAi:
          this.ai.connected && !muted && Boolean(this.ultravox?.micSourceNode),
      };
      this.reportAiStatus();
    }

    const track = this.localStream?.getAudioTracks()[0];
    if (track) {
      this.diagnostics = {
        ...this.diagnostics,
        localTrackState: `${track.readyState}${track.enabled ? '' : ' (disabled)'}${track.muted ? ' (muted)' : ''}`,
      };
    }

    this.log(
      muted
        ? `Microphone muted locally${this.options.role === 'customer' ? ' (AI input and human audio)' : ''}.`
        : 'Microphone unmuted locally.'
    );
  }

  private watchLocalTrack(stream: MediaStream): void {
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('mute', () => {
        this.log('Local microphone track muted by the browser.');
        this.emit();
        if (this.micRecoveryTimer !== null) window.clearTimeout(this.micRecoveryTimer);
        this.micRecoveryTimer = window.setTimeout(() => {
          this.micRecoveryTimer = null;
          if (track.muted && track.readyState === 'live' && !this.micMuted) {
            void this.recoverLocalTrack('track muted by the browser');
          }
        }, 2500);
      });
      track.addEventListener('unmute', () => {
        this.log('Local microphone track unmuted.');
        this.emit();
        if (this.micRecoveryTimer !== null) {
          window.clearTimeout(this.micRecoveryTimer);
          this.micRecoveryTimer = null;
        }
      });
      track.addEventListener('ended', () => {
        this.log('Local microphone track ended by the browser.');
        this.emit();
        if (!this.micMuted) void this.recoverLocalTrack('track ended');
      });
    });
  }

  /**
   * Mobile browsers can end/mute the microphone track when a second capture
   * starts (the customer device also runs the Ultravox AI session). Reacquire
   * and replace the outbound track instead of silently going dead.
   */
  private async recoverLocalTrack(reason: string): Promise<void> {
    if (this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    try {
      this.log(`Recovering local microphone track (${reason})...`);
      const stream = await this.ensureLocalStream(true);
      const track = stream?.getAudioTracks()[0];
      if (!track) {
        this.log('Microphone recovery failed: no capture track available.');
        return;
      }
      if (!this.pc) {
        this.log('Microphone recovered; waiting for a peer connection to attach it to.');
        return;
      }
      await this.attachOutboundAudioTrack(track, stream as MediaStream);
      this.log('Outbound microphone track replaced after recovery.');
      if (this.options.role === 'salesperson') {
        void this.makeOffer({ reason: 'microphone recovery' });
      }
    } catch (err) {
      this.log(`Microphone recovery failed: ${(err as Error)?.message || err}`);
    } finally {
      this.recoveryInFlight = false;
    }
  }

  /**
   * Attaches (or replaces) the microphone on the current peer connection.
   *
   * `replaceTrack` is used whenever a sender exists so no renegotiation is
   * needed. A peer connection is always created with an audio sender (either
   * from `addTrack` or from a sendrecv transceiver), so a microphone acquired
   * after negotiation still reaches the peer instead of leaving a connected but
   * silent call.
   */
  private async attachOutboundAudioTrack(
    track: MediaStreamTrack,
    stream: MediaStream
  ): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const sender = this.findAudioSender(pc);
    if (sender) {
      if (sender.track !== track) await sender.replaceTrack(track);
      this.audioSender = sender;
      return;
    }
    this.audioSender = pc.addTrack(track, stream);
    if (this.options.role === 'salesperson') {
      // A brand-new sender only exists when the m-line was never negotiated
      // (no transceiver and no track at creation time). Renegotiate it.
      void this.makeOffer({ reason: 'microphone attached' });
    } else {
      const sent = this.sendSignal({ type: 'ice_restart', reason: 'customer microphone attached' });
      this.log(
        `Asked the salesperson to renegotiate after attaching the microphone${sent ? '' : ': signaling is unavailable'}.`
      );
    }
  }

  /** The negotiated audio transceiver of the current peer connection. */
  private audioTransceiver(): RTCRtpTransceiver | null {
    const pc = this.pc;
    if (!pc || typeof pc.getTransceivers !== 'function') return null;
    try {
      return (
        pc.getTransceivers().find(
          (transceiver) =>
            transceiver.sender?.track?.kind === 'audio' ||
            transceiver.receiver?.track?.kind === 'audio'
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Finds the sender that owns the audio m-line — including a transceiver whose
   * sender has no track yet. Without this the engine added a *second* audio
   * m-line instead of filling the one that was already negotiated, so a
   * microphone acquired after the offer could end up on an m-line the remote
   * side never accepted.
   */
  private findAudioSender(pc: RTCPeerConnection): RTCRtpSender | null {
    if (this.audioSender) return this.audioSender;
    const direct = pc.getSenders().find((sender) => sender.track?.kind === 'audio') ?? null;
    if (direct) return direct;
    const transceiver = this.audioTransceiver();
    if (transceiver?.sender) return transceiver.sender;
    return null;
  }

  /** Negotiated direction of this participant's outbound audio. */
  private sendDirection(): string {
    const transceiver = this.audioTransceiver();
    const direction = (transceiver?.currentDirection ?? transceiver?.direction ?? null) as
      | string
      | null;
    return direction ?? 'unknown';
  }

  /**
   * Makes sure the live microphone is actually published on the negotiated
   * audio m-line. Idempotent: it never adds a second track or a second
   * transceiver when one already exists.
   */
  private async syncOutboundAudio(reason: string): Promise<void> {
    const pc = this.pc;
    if (!pc || this.stopped || this.intentionalLeave) return;
    const stream = this.localStream;
    const track = stream?.getAudioTracks()[0] ?? null;
    if (!stream || !track || track.readyState !== 'live') return;
    const sender = this.findAudioSender(pc);
    if (!sender) {
      await this.attachOutboundAudioTrack(track, stream);
      this.log(`Attached the microphone to the peer connection (${reason}).`);
      return;
    }
    this.audioSender = sender;
    if (sender.track !== track) {
      try {
        await sender.replaceTrack(track);
        this.log(`Re-published the microphone with replaceTrack (${reason}).`);
      } catch (err) {
        this.log(`replaceTrack failed (${reason}): ${(err as Error)?.message || err}`);
      }
    }
    // A negotiated direction that does not allow sending means the remote side
    // never accepted our audio m-line: only the offerer can fix that.
    const direction = this.sendDirection();
    if (direction === 'recvonly' || direction === 'inactive') {
      this.requestAudioRenegotiation(reason);
    }
  }

  /** Asks the offerer for a fresh offer when this side cannot send audio. */
  private requestAudioRenegotiation(reason: string): void {
    if (this.options.role !== 'customer') return;
    if (this.audioRenegotiateRequests >= 2) return;
    this.audioRenegotiateRequests += 1;
    const sent = this.sendSignal({ type: 'audio_renegotiate', reason: reason.slice(0, 120) });
    this.log(
      `Asked the salesperson to renegotiate so the microphone can be published${
        sent ? '' : ': signaling is unavailable'
      }.`
    );
  }

  /**
   * Customer-side answer to a `audio_recheck` request: verify the capture,
   * re-acquire it if the device dropped it, re-publish it on the negotiated
   * m-line and report the outcome to the salesperson.
   */
  private async repairOutboundAudio(reason: string): Promise<void> {
    if (this.options.role !== 'customer') return;
    const pc = this.pc;
    if (!pc) {
      this.sendAudioState('no peer connection');
      return;
    }
    let stream = this.localStream;
    let track = stream?.getAudioTracks()[0] ?? null;
    const needsCapture = !track || track.readyState !== 'live' || (track.muted && !this.micMuted);
    if (needsCapture && !this.micMuted) {
      this.log(`Re-acquiring the microphone after a salesperson audio check (${reason}).`);
      const refreshed = await this.ensureLocalStream(true);
      if (refreshed) {
        stream = refreshed;
        track = refreshed.getAudioTracks()[0] ?? track;
      }
    }
    if (!stream || !track) {
      this.log('Audio check: no microphone capture is available to publish.');
      this.sendAudioState('no microphone capture available');
      return;
    }
    track.enabled = !this.micMuted;
    await this.syncOutboundAudio('audio check');
    this.audioRenegotiateRequests = 0;
    this.sendAudioState(reason);
  }

  /**
   * Sends a sanitized audio-path report to the salesperson only. It contains
   * states and counters, never device ids, SDP, ICE data or credentials.
   */
  private sendAudioState(reason: string): void {
    if (this.options.role !== 'customer') return;
    const sender = this.pc ? this.findAudioSender(this.pc) : null;
    const track = this.localStream?.getAudioTracks()[0] ?? null;
    this.sendSignal({
      type: 'audio_state',
      reason: reason.slice(0, 120),
      track: track ? `${track.readyState}${track.enabled ? '' : ' disabled'}${track.muted ? ' muted' : ''}` : 'none',
      sender: sender ? (sender.track ? 'track' : 'empty') : 'none',
      direction: this.sendDirection(),
      packetsSent: this.diagnostics.outboundPackets,
      level: this.diagnostics.localAudioLevel,
    });
  }

  private releaseLocalMedia(reason: string): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
      this.log(`Released microphone tracks (${reason}).`);
    }
    if (this.micRecoveryTimer !== null) {
      window.clearTimeout(this.micRecoveryTimer);
      this.micRecoveryTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Signaling transport
  // -------------------------------------------------------------------------

  private sendSignal(payload: Record<string, unknown>): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.log('Signaling send skipped: WebSocket is not open.');
      return false;
    }
    try {
      socket.send(JSON.stringify({ ...payload, sessionId: this.options.sessionId }));
      return true;
    } catch (err) {
      this.log(`Signaling send failed: ${(err as Error)?.message || err}`);
      return false;
    }
  }

  private clearJoinTimeout(): void {
    if (this.joinTimeout !== null) {
      window.clearTimeout(this.joinTimeout);
      this.joinTimeout = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connectSignaling(isReconnect: boolean): void {
    if (this.stopped || this.intentionalLeave) return;
    if (this.connecting) {
      this.log('Signaling connection attempt already in progress.');
      return;
    }
    const existing = this.ws;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      this.log('Signaling socket is already open or connecting.');
      return;
    }

    this.clearReconnectTimer();
    this.connecting = true;
    this.joinedThisSocket = false;
    this.wsStatus = isReconnect ? 'reconnecting' : 'connecting';
    if (isReconnect) this.callState = 'reconnecting';
    this.emit();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    this.log(`Connecting signaling socket (${isReconnect ? 'reconnect' : 'initial'}).`);

    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        void this.handleSignal(JSON.parse(event.data));
      } catch (err) {
        this.log(`Signaling message parse error: ${(err as Error)?.message || err}`);
      }
    };

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.connecting = false;
      this.wsStatus = 'connected';
      this.emit();
      this.log('Signaling connected. Authenticating session membership...');

      socket.send(
        JSON.stringify({
          type: 'join',
          sessionId: this.options.sessionId,
          role: this.options.role,
          credential: this.options.credential,
          resumeToken: this.resumeToken ?? undefined,
        })
      );

      this.clearJoinTimeout();
      this.joinTimeout = window.setTimeout(() => {
        this.joinTimeout = null;
        if (this.ws === socket && !this.joinedThisSocket) {
          this.log('Join was not acknowledged in time; reconnecting signaling.');
          try {
            socket.close(4000, 'join_timeout');
          } catch {
            // Ignore close errors.
          }
        }
      }, JOIN_ACK_TIMEOUT_MS);
    };

    socket.onerror = () => this.log('Signaling socket error.');

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.connecting = false;
      this.clearJoinTimeout();

      if (this.intentionalLeave || this.stopped) {
        this.log(`Signaling closed intentionally (code ${event.code}).`);
        return;
      }

      this.log(`Signaling lost unexpectedly (code ${event.code}).`);
      this.wsStatus = 'reconnecting';
      this.callState = 'reconnecting';
      this.closePeerConnection('signaling lost');
      this.peerParticipantId = null;
      this.peerRole = null;
      this.remoteTrackState = 'none';
      this.emit();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.intentionalLeave) return;
    if (this.reconnectTimer !== null) {
      this.log('Reconnect already scheduled.');
      return;
    }
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.failRecovery('Could not recover the signaling connection. Check your network and retry.');
      return;
    }

    this.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    this.setState({ reconnectAttempt: this.reconnectAttempt, wsStatus: 'reconnecting' });
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}).`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.intentionalLeave) return;
      if (!navigator.onLine) {
        this.log('Browser is offline; waiting for the online event.');
        return;
      }
      this.connectSignaling(true);
    }, delay);
  }

  private failRecovery(message: string): void {
    this.clearReconnectTimer();
    this.clearJoinTimeout();
    this.lastError = message;
    this.log(`Recovery failed: ${message}`);

    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.onclose = null;
        socket.close(4000, 'recovery_failed');
      } catch {
        // Ignore close errors.
      }
    }

    this.closePeerConnection('recovery exhausted');
    this.releaseLocalMedia('unrecoverable signaling failure');
    this.wsStatus = 'disconnected';
    this.callState = 'failed';
    this.peerParticipantId = null;
    this.peerRole = null;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Peer connection
  // -------------------------------------------------------------------------

  private clearOfferWatchdog(): void {
    if (this.offerWatchdog !== null) window.clearTimeout(this.offerWatchdog);
    this.offerWatchdog = null;
  }

  private clearNegotiationRetry(): void {
    if (this.negotiationRetryTimer !== null) window.clearTimeout(this.negotiationRetryTimer);
    this.negotiationRetryTimer = null;
  }

  private clearIceRestartTimer(): void {
    if (this.iceRestartTimer !== null) window.clearTimeout(this.iceRestartTimer);
    this.iceRestartTimer = null;
  }

  private clearIceRestartVerifyTimer(): void {
    if (this.iceRestartVerifyTimer !== null) window.clearTimeout(this.iceRestartVerifyTimer);
    this.iceRestartVerifyTimer = null;
  }

  private clearDisconnectGraceTimer(): void {
    if (this.disconnectGraceTimer !== null) window.clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
  }

  private clearConnectWatchdog(): void {
    if (this.connectWatchdog !== null) window.clearTimeout(this.connectWatchdog);
    this.connectWatchdog = null;
  }

  private clearMediaWatchdog(): void {
    if (this.mediaWatchdog !== null) window.clearTimeout(this.mediaWatchdog);
    this.mediaWatchdog = null;
  }

  /** Cancels every timer that belongs to the current peer connection. */
  private clearPeerTimers(): void {
    this.clearOfferWatchdog();
    this.clearNegotiationRetry();
    this.clearIceRestartTimer();
    this.clearIceRestartVerifyTimer();
    this.clearDisconnectGraceTimer();
    this.clearConnectWatchdog();
    this.clearMediaWatchdog();
  }

  /**
   * Resets per-connection negotiation and recovery state. Called only when a
   * new peer connection is created, when the peer leaves, or after a genuine
   * reconnection. A presence refresh must never reset this.
   */
  private resetPeerRecoveryState(reason: string): void {
    this.clearPeerTimers();
    this.offerInFlight = false;
    this.answerInFlight = false;
    this.makingOffer = false;
    this.peerFailureConfirmed = false;
    this.negotiationAttempts = 0;
    this.iceRestartAttempts = 0;
    this.iceRestartInFlight = false;
    this.awaitingMediaAfterRecovery = false;
    this.recoveryAttemptInFlight = false;
    this.pendingIceRestartReason = null;
    this.pendingIceRestartForce = false;
    if (reason) this.log(`Peer recovery state reset (${reason}).`);
  }

  private closePeerConnection(reason: string): void {
    this.pcGeneration += 1;
    this.clearPeerTimers();
    this.audioSender = null;
    this.offerInFlight = false;
    this.answerInFlight = false;
    this.makingOffer = false;
    this.iceRestartInFlight = false;
    this.pendingIceRestartReason = null;
    this.pendingIceRestartForce = false;

    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.ontrack = null;
        // Per-track handlers belong to this connection's generation. A late
        // mute/ended event from a replaced track must not touch the new state.
        this.remoteStream?.getTracks().forEach((track) => {
          track.onmute = null;
          track.onunmute = null;
          track.onended = null;
        });
        // The sender tracks belong to this.localStream and may be reused by the
        // next peer connection, so they are stopped only in releaseLocalMedia().
        pc.close();
      } catch {
        // Ignore close errors.
      }
      this.log(`Closed peer connection (${reason}).`);
    }
    // Never leave a dead stream (or a stale element) playing the old call.
    if (this.audioElement) {
      try {
        this.audioElement.pause();
        this.audioElement.srcObject = null;
      } catch {
        // Ignore teardown errors on a detached element.
      }
    }
    this.playbackState = 'no-track';
    this.playbackClock = 0;
    this.playbackStalledSince = 0;
    this.lastSoundAt = 0;
    this.inboundSoundMeasurable = false;
    this.lastInboundPackets = 0;
    this.audioRepairRequests = 0;
    this.remoteStream = null;
    this.pendingIce = [];
    this.lastRemoteOfferSdp = null;
    this.remoteTrackState = 'none';
    this.lastMediaAt = 0;
    this.dtlsState = 'none';
    this.diagnostics = {
      ...this.diagnostics,
      pcState: 'none',
      iceState: 'none',
      dtlsState: 'none',
      localSenderCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
    };
    this.lastStats = null;
  }

  private createPeerConnection(peer: { participantId: string; role: ParticipantRole }): void {
    this.closePeerConnection('replacing peer');
    this.resetPeerRecoveryState('new peer connection');
    this.peerParticipantId = peer.participantId;
    this.peerRole = peer.role;

    const generation = this.pcGeneration + 1;
    this.pcGeneration = generation;
    this.candidateTypes = { host: 0, srflx: 0, prflx: 0, relay: 0 };

    // The fetched (session-authenticated) ICE configuration is applied to every
    // peer connection, including reconnects and ICE restarts.
    const configuration: RTCConfiguration = {
      iceServers: this.iceConfig.iceServers,
      iceTransportPolicy: this.iceConfig.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
    };

    const pc = new RTCPeerConnection(configuration);
    this.pc = pc;
    this.log(
      `Created RTCPeerConnection (peer ${peer.role}, ${this.iceConfig.iceServers.length} ICE entr(ies), ` +
        `TURN ${this.iceConfig.turn.configured ? this.iceConfig.turn.credentialMode : 'absent'}, ` +
        `policy ${this.iceConfig.iceTransportPolicy}).`
    );

    const stream = this.localStream;
    const track = stream && hasLiveAudioTrack(stream) ? stream.getAudioTracks()[0] : null;
    if (stream && track) {
      this.audioSender = pc.addTrack(track, stream);
      track.enabled = !this.micMuted;
      this.log('Added local microphone track to the peer connection.');
    } else {
      // No capture is available yet (permission granted late, recovery in
      // progress, or the track already ended). Negotiate a sendrecv audio
      // m-line now so a track acquired later can be attached with
      // replaceTrack() and actually reach the peer. Without it the call can
      // connect while one direction carries no audio at all.
      try {
        this.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
        this.log('Negotiated a sendrecv audio m-line; the microphone will attach when available.');
      } catch (err) {
        this.audioSender = null;
        this.log(`Could not negotiate a sendrecv audio m-line: ${(err as Error)?.message || err}`);
      }
    }

    pc.onicecandidate = (event) => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (!event.candidate) {
        this.log('ICE candidate gathering complete.');
        return;
      }
      const candidate = event.candidate;
      const candidateType = candidate.type || 'unknown';
      if (candidateType in this.candidateTypes) {
        this.candidateTypes[candidateType as keyof typeof this.candidateTypes] += 1;
      }
      const sent = this.sendSignal({ type: 'ice_candidate', candidate: candidate.toJSON() });
      if (!sent) this.log('ICE candidate could not be sent (signaling unavailable).');
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      this.log(`Peer connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        this.handlePeerConnected();
      } else if (pc.connectionState === 'connecting') {
        // A failed connection must never be reported as connected. While a
        // retry is running the call is explicitly "reconnecting".
        if (this.callState !== 'reconnecting') this.callState = 'connecting';
        this.emit();
      } else if (pc.connectionState === 'disconnected') {
        // ICE can be temporarily disconnected and recover on its own. Wait for
        // the grace period before calling it broken.
        this.startDisconnectGrace();
      } else if (pc.connectionState === 'failed') {
        this.onPeerFailure('peer connection failed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      this.log(`ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        this.onPeerFailure('ICE connection failed');
      } else if (pc.iceConnectionState === 'disconnected') {
        this.startDisconnectGrace();
      } else if (
        (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') &&
        pc.connectionState === 'connected'
      ) {
        // Keep recovery state in sync even if the connection-state event was
        // coalesced. Only a fully connected transport (ICE + DTLS) counts.
        this.handlePeerConnected();
      }
    };

    pc.onicegatheringstatechange = () => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      this.log(`ICE gathering state: ${pc.iceGatheringState}`);
      if (pc.iceGatheringState !== 'complete' || this.isPeerConnected()) return;
      // Gathering complete with no candidates at all means no media path can
      // exist (for example relay-only with an unreachable TURN server). Some
      // ICE agents never emit `failed` in that case, so recovery must start here.
      const total =
        this.candidateTypes.host +
        this.candidateTypes.srflx +
        this.candidateTypes.prflx +
        this.candidateTypes.relay;
      if (total === 0) {
        this.log('ICE gathering completed with no candidates: no media path is possible.');
        this.onPeerFailure('ICE gathered no candidates');
      }
    };

    pc.ontrack = (event) => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      const track = event.track;
      if (track.kind !== 'audio') {
        this.log(`Ignoring remote ${track.kind} track; only audio is used.`);
        return;
      }
      this.log(`Received remote audio track from ${peer.role}.`);
      // Exactly one audio track per element: a new stream object per ontrack
      // guarantees a replaced track replaces the old one instead of stacking a
      // second playback path on top of it.
      const remote =
        typeof MediaStream === 'function'
          ? new MediaStream([track])
          : ((event.streams?.[0] ?? null) as MediaStream | null);
      if (!remote) {
        this.log('Remote audio track arrived without a usable stream; ignoring it.');
        return;
      }
      this.remoteStream = remote;
      this.remoteTrackState = 'live';
      this.attachRemoteStream(remote);
      this.emit();

      // A replaced track from an older peer connection must not change the
      // current connection's state.
      const isStale = () => this.pc !== pc || this.pcGeneration !== generation;
      track.onmute = () => {
        if (isStale()) return;
        this.log('Remote audio track muted (no media arriving yet).');
        this.emit();
      };
      track.onunmute = () => {
        if (isStale()) return;
        this.log('Remote audio track unmuted (media arriving).');
        if (this.remoteStream !== remote) {
          this.remoteStream = remote;
          this.attachRemoteStream(remote, { silent: true });
        }
        this.emit();
      };
      track.onended = () => {
        if (isStale()) return;
        this.remoteTrackState = 'ended';
        this.log('Remote audio track ended; the peer must publish again.');
        this.playbackState = 'ended';
        // A dead remote track cannot be repaired by an ICE restart (the
        // transport may be perfectly healthy). Ask the peer to publish again.
        if (this.options.role === 'salesperson') {
          this.requestAudioRepair('remote track ended');
        }
        this.emit();
      };
    };

    // A fresh peer connection means a fresh negotiation is starting. This is
    // deliberately not "connected" until ICE and DTLS report connected.
    this.callState = 'connecting';
    this.armConnectWatchdog(pc);
  }

  /**
   * Bounds how long a peer connection may stay unconnected. Without it, an ICE
   * agent that never emits `failed` leaves both participants on "connecting"
   * forever, with no recovery and no final message.
   */
  private armConnectWatchdog(pc: RTCPeerConnection): void {
    this.clearConnectWatchdog();
    const generation = this.pcGeneration;
    const timeoutMs = this.options.connectWatchdogMs ?? CONNECT_WATCHDOG_MS;
    this.connectWatchdog = window.setTimeout(() => {
      this.connectWatchdog = null;
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      if (this.isPeerConnected()) {
        this.handlePeerConnected();
        return;
      }
      if (this.iceRestartInFlight || this.iceRestartTimer !== null || this.callState === 'reconnecting') {
        // A bounded recovery is already running; keep watching so a stuck
        // attempt still reaches a definite outcome.
        this.armConnectWatchdog(pc);
        return;
      }
      this.log('Peer connection did not connect in time.');
      this.onPeerFailure('connection did not establish in time');
    }, timeoutMs);
  }

  // -------------------------------------------------------------------------
  // Peer-connection negotiation and bounded recovery
  // -------------------------------------------------------------------------

  private isPeerConnected(): boolean {
    return this.pc?.connectionState === 'connected';
  }

  /**
   * Only a genuinely connected transport (ICE + DTLS) resets the recovery
   * budget. A `disconnected` or `connecting` state must not do so.
   */
  private handlePeerConnected(): void {
    if (this.stopped || this.intentionalLeave) return;
    this.clearPeerTimers();
    this.offerInFlight = false;
    this.iceRestartInFlight = false;
    this.pendingIceRestartReason = null;
    this.peerFailureConfirmed = false;
    this.negotiationAttempts = 0;
    // A transport that reconnects is only a success if audio arrives again.
    // While a media-triggered recovery is pending, the restart budget keeps
    // counting until RTP is observed, so a silent path cannot loop forever.
    if (!this.awaitingMediaAfterRecovery || this.mediaFlowingNow()) {
      this.awaitingMediaAfterRecovery = false;
      this.iceRestartAttempts = 0;
    }
    this.lastError = null;
    this.callState = 'connected';
    this.emit();
    void this.resumePlayback();
    // A microphone that became available after the offer/answer (or after a
    // device-recovery) is published here, so a "connected" call is never
    // silently one-way.
    void this.syncOutboundAudio('peer connected');
    const pc = this.pc;
    // ICE+DTLS is not audio. Keep checking that RTP actually arrives.
    if (pc) this.armMediaWatchdog(pc);
  }

  /** Inbound RTP arrived recently enough to count as working audio. */
  private mediaFlowingNow(): boolean {
    return this.lastMediaAt > 0 && Date.now() - this.lastMediaAt < MEDIA_FLOW_FRESH_MS;
  }

  /**
   * A `connected` transport with no inbound RTP is a silent call. Nothing else
   * in the state machine notices, because every failure event stays quiet while
   * ICE believes the path is healthy. This watchdog turns that silence into a
   * bounded recovery (with refreshed TURN credentials) instead of an endless
   * "connected" UI with no audio.
   */
  private armMediaWatchdog(pc: RTCPeerConnection): void {
    this.clearMediaWatchdog();
    const generation = this.pcGeneration;
    const checkMs = this.options.mediaFlowCheckMs ?? MEDIA_FLOW_CHECK_MS;
    const graceMs = this.options.mediaFlowGraceMs ?? MEDIA_FLOW_GRACE_MS;
    const stallMs = this.options.mediaStallMs ?? MEDIA_STALL_MS;
    const schedule = (delayMs?: number) => {
      this.mediaWatchdog = window.setTimeout(check, delayMs ?? checkMs);
    };
    const check = () => {
      this.mediaWatchdog = null;
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      if (pc.connectionState !== 'connected') return;
      if (this.isPageHidden()) {
        // Background tabs throttle timers: a missed sample is not evidence of
        // lost media, so never restart ICE because of it.
        schedule();
        return;
      }
      const sinceLastMedia = this.lastMediaAt > 0 ? Date.now() - this.lastMediaAt : null;
      // Never-any-audio and audio-that-stopped have different deadlines: a long
      // pause in conversation is normal, no audio at all from the start is not.
      const deadline = sinceLastMedia === null ? graceMs : stallMs;
      if (sinceLastMedia !== null && sinceLastMedia < deadline) {
        if (this.awaitingMediaAfterRecovery) {
          this.awaitingMediaAfterRecovery = false;
          this.iceRestartAttempts = 0;
          this.log('Audio is flowing again after recovery.');
          this.emit();
        }
        schedule();
        return;
      }
      // An ICE restart briefly interrupts the direction that does work and
      // cannot repair a remote track that was never published. Ask the other
      // device to verify and re-publish its microphone first, then give the
      // transport a chance to recover before restarting anything.
      if (this.canRequestAudioRepair()) {
        this.requestAudioRepair(
          sinceLastMedia === null ? 'no incoming audio' : 'incoming audio stopped'
        );
        schedule(this.audioRepairWaitMs());
        return;
      }
      this.log(
        `Peer connection is connected but no audio has arrived for ${
          sinceLastMedia === null ? 'the whole call' : `${Math.round(sinceLastMedia / 1000)}s`
        }; starting recovery.`
      );
      this.callState = 'reconnecting';
      this.emit();
      // Forced: a connected transport would otherwise be treated as healthy by
      // runRecoveryAttempt() and no ICE restart (or TURN credential refresh)
      // would ever run.
      this.awaitingMediaAfterRecovery = true;
      this.requestIceRecovery('connected but no incoming audio', true);
    };
    schedule();
  }

  private audioRepairWaitMs(): number {
    return this.options.audioRepairWaitMs ?? AUDIO_REPAIR_WAIT_MS;
  }

  /** True when asking the peer to re-publish audio is still allowed. */
  private canRequestAudioRepair(): boolean {
    if (this.options.role !== 'salesperson') return false;
    if (!this.pc || !this.peerParticipantId) return false;
    if (this.audioRepairRequests >= MAX_AUDIO_REPAIR_REQUESTS) return false;
    return Date.now() - this.lastAudioRepairAt >= this.audioRepairWaitMs();
  }

  /**
   * Salesperson -> customer: ask the customer device to verify, re-acquire and
   * re-publish its microphone. Bounded so a broken device cannot be spammed.
   */
  requestAudioRepair(reason: string): boolean {
    if (this.options.role !== 'salesperson') return false;
    if (this.audioRepairRequests >= MAX_AUDIO_REPAIR_REQUESTS) {
      this.log('Audio check skipped: the bounded re-publish budget is exhausted.');
      return false;
    }
    this.audioRepairRequests += 1;
    this.lastAudioRepairAt = Date.now();
    const sent = this.sendSignal({ type: 'audio_recheck', reason: reason.slice(0, 120) });
    this.log(
      `Asked the customer device to re-publish microphone audio (attempt ${this.audioRepairRequests}/${MAX_AUDIO_REPAIR_REQUESTS})${
        sent ? '' : ': signaling is unavailable'
      }.`
    );
    this.emit();
    return sent;
  }

  /** Public salesperson control (the warning banner action). */
  requestAudioCheck(): void {
    if (this.options.role !== 'salesperson') return;
    // A manual request is allowed to consume the next attempt even inside the
    // automatic wait window, but it stays bounded overall.
    this.lastAudioRepairAt = 0;
    if (!this.requestAudioRepair('salesperson requested audio check')) {
      this.log('Audio check could not be requested; falling back to a connection retry.');
      this.retryConnection();
    }
  }

  private isPageHidden(): boolean {
    const doc = (globalThis as { document?: Document }).document;
    return Boolean(doc && typeof doc.visibilityState === 'string' && doc.visibilityState !== 'visible');
  }

  private startDisconnectGrace(): void {
    const pc = this.pc;
    if (!pc || this.peerFailureConfirmed || this.disconnectGraceTimer !== null) return;
    const generation = this.pcGeneration;
    if (this.callState === 'connected') {
      this.log('Peer connection temporarily disconnected; waiting for recovery before retrying.');
    }
    const graceMs = this.options.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
    this.disconnectGraceTimer = window.setTimeout(() => {
      this.disconnectGraceTimer = null;
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      if (pc.connectionState === 'connected') return;
      if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
        this.onPeerFailure('connection did not recover');
        return;
      }
      this.log('Peer connection stayed disconnected after the grace period.');
      this.callState = 'reconnecting';
      this.emit();
      this.requestIceRecovery('connection stayed disconnected');
    }, graceMs);
  }

  /** Confirmed failure (not a transient disconnect): start bounded recovery. */
  private onPeerFailure(reason: string): void {
    if (!this.pc || this.peerFailureConfirmed || this.stopped || this.intentionalLeave) return;
    this.clearDisconnectGraceTimer();
    if (this.callState === 'connected' || this.callState === 'failed') {
      this.log(`Audio connection lost (${reason}).`);
    }
    this.callState = 'reconnecting';
    this.emit();
    this.requestIceRecovery(reason);
  }

  /**
   * Requests exactly one bounded recovery sequence. Duplicate failure events
   * (connectionState and iceConnectionState both firing) are coalesced.
   */
  private requestIceRecovery(reason: string, force = false): void {
    if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
    if (!this.pc || !this.peerParticipantId) return;
    if (this.iceRestartTimer !== null) {
      this.log(`Recovery already scheduled; ignoring duplicate failure (${reason}).`);
      return;
    }
    if (this.iceRestartInFlight) {
      this.log(`An ICE restart is already in flight; ignoring duplicate failure (${reason}).`);
      return;
    }
    if (this.recoveryAttemptInFlight) {
      this.log(`A recovery attempt is already starting; ignoring duplicate failure (${reason}).`);
      return;
    }
    if (this.iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      this.enterTerminalPeerFailure(reason);
      return;
    }

    const attempt = this.iceRestartAttempts + 1;
    const delays = this.options.iceRestartDelaysMs ?? ICE_RESTART_DELAYS_MS;
    const delay = attempt === 1 ? 0 : (delays[Math.min(attempt - 2, delays.length - 1)] ?? 1000);
    this.log(
      `Scheduling recovery attempt ${attempt}/${MAX_ICE_RESTART_ATTEMPTS} in ${delay}ms (${reason}).`
    );

    this.iceRestartTimer = window.setTimeout(() => {
      this.iceRestartTimer = null;
      void this.runRecoveryAttempt(reason, force);
    }, delay);
  }

  private async runRecoveryAttempt(reason: string, force = false): Promise<void> {
    if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
    const pc = this.pc;
    if (!pc || !this.peerParticipantId) return;
    if (!force && pc.connectionState === 'connected') {
      this.handlePeerConnected();
      return;
    }
    if (this.iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      this.enterTerminalPeerFailure(reason);
      return;
    }

    // TURN credentials issued by a provider expire. Re-read the payload before
    // reusing it so a restart after a long call does not retry dead credentials.
    // This is best effort and never fatal; a slow/failed refresh keeps the
    // current servers and delays the restart by at most the fetch timeout.
    // The flag coalesces failure events that arrive while the refresh runs.
    this.recoveryAttemptInFlight = true;
    try {
      await this.refreshIceConfigForRecovery();
    } finally {
      this.recoveryAttemptInFlight = false;
    }
    if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
    if (this.pc !== pc || !this.peerParticipantId) return;
    if (!force && pc.connectionState === 'connected') {
      this.handlePeerConnected();
      return;
    }

    // The customer cannot create an offer. It asks the offerer through the
    // existing role-checked signaling channel and then waits for reconnection.
    if (this.options.role === 'customer') {
      this.iceRestartAttempts += 1;
      this.iceRestartInFlight = true;
      const sent = this.sendSignal({ type: 'ice_restart', reason: reason.slice(0, 120) });
      this.log(
        `Requested an ICE restart from the salesperson (attempt ${this.iceRestartAttempts}/${MAX_ICE_RESTART_ATTEMPTS})${sent ? '' : ': signaling unavailable'}.`
      );
      this.armIceRestartVerification(reason);
      return;
    }

    if (this.makingOffer || pc.signalingState !== 'stable') {
      // Signaling is not stable yet: remember the request and run it when the
      // outstanding negotiation settles. It is never silently dropped.
      this.pendingIceRestartReason = reason;
      this.pendingIceRestartForce = force;
      this.log(
        `ICE restart queued: signalingState is "${pc.signalingState}". It will run when signaling is stable.`
      );
      return;
    }

    this.iceRestartAttempts += 1;
    this.pendingIceRestartReason = null;
    this.pendingIceRestartForce = false;
    this.log(
      `Starting ICE restart attempt ${this.iceRestartAttempts}/${MAX_ICE_RESTART_ATTEMPTS} (${reason}).`
    );
    // makeOffer marks the restart in flight only after the offer is actually
    // sent; setting it here would make its own duplicate guard skip the offer.
    void this.makeOffer({ iceRestart: true, reason: `ICE restart: ${reason}` });
    this.armIceRestartVerification(reason);
  }

  private tryPendingIceRestart(): void {
    const reason = this.pendingIceRestartReason;
    if (!reason || this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
    const pc = this.pc;
    if (!pc || pc.signalingState !== 'stable' || this.makingOffer) return;
    const force = this.pendingIceRestartForce;
    this.pendingIceRestartReason = null;
    this.pendingIceRestartForce = false;
    void this.runRecoveryAttempt(reason, force);
  }

  private armIceRestartVerification(reason: string): void {
    this.clearIceRestartVerifyTimer();
    const pc = this.pc;
    if (!pc) return;
    const generation = this.pcGeneration;
    const startedAt = Date.now();
    const verifyMs = this.options.iceRestartVerifyMs ?? ICE_RESTART_VERIFY_MS;
    this.iceRestartVerifyTimer = window.setTimeout(() => {
      this.iceRestartVerifyTimer = null;
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      if (this.isPeerConnected()) {
        // A restart that reconnects but still carries no audio has not fixed
        // anything: keep counting the attempt instead of resetting the budget.
        if (this.awaitingMediaAfterRecovery && this.lastMediaAt < startedAt) {
          this.iceRestartInFlight = false;
          this.log(`Recovery attempt restored the transport but not audio (${reason}).`);
          this.requestIceRecovery('ICE restart restored no audio', true);
          return;
        }
        this.handlePeerConnected();
        return;
      }
      this.iceRestartInFlight = false;
      this.log(`Recovery attempt did not restore media (${reason}).`);
      this.requestIceRecovery('ICE restart did not restore media');
    }, verifyMs);
  }

  /**
   * Terminal state: no more automatic attempts, no more presence-driven peer
   * connection churn. The failed peer connection is kept (so an incoming
   * legitimate offer can still recover it without creating another PC), but
   * automatic retries are stopped. The AI session is deliberately untouched.
   */
  private enterTerminalPeerFailure(reason: string): void {
    if (this.peerFailureConfirmed) return;
    this.peerFailureConfirmed = true;
    this.clearPeerTimers();
    this.iceRestartInFlight = false;
    this.recoveryAttemptInFlight = false;
    this.awaitingMediaAfterRecovery = false;
    this.pendingIceRestartReason = null;
    this.pendingIceRestartForce = false;
    this.log(
      `Audio recovery exhausted after ${this.iceRestartAttempts} attempt(s) (${reason}). Automatic retries stopped.`
    );
    this.callState = 'failed';
    this.lastError = TERMINAL_PEER_ERROR;
    this.emit();
  }

  /**
   * Public, deliberate retry. Creates exactly one replacement peer connection
   * (the previous one is closed) and restarts negotiation within the existing
   * call, without reloading the page or touching the AI session.
   */
  retryConnection(): void {
    if (this.stopped || this.intentionalLeave) return;
    if (!this.peerParticipantId || !this.peerRole) {
      this.log('Connection retry ignored: there is no connected peer to retry with.');
      return;
    }
    const peer = { participantId: this.peerParticipantId, role: this.peerRole };
    this.log('Manual connection retry requested.');
    // Pick up refreshed TURN credentials; the new peer connection otherwise
    // reuses whatever was fetched when the call started.
    void this.refreshIceConfigForRecovery();
    this.lastError = null;
    this.callState = 'connecting';
    this.createPeerConnection(peer);
    if (this.options.role === 'salesperson') {
      void this.makeOffer({ reason: 'manual retry' });
    } else {
      const sent = this.sendSignal({ type: 'ice_restart', reason: 'customer manual retry' });
      this.log(
        `Asked the salesperson to restart negotiation${sent ? '' : ': signaling is unavailable'}.`
      );
    }
    this.emit();
  }

  private async makeOffer(options: { iceRestart?: boolean; reason?: string } = {}): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.peerParticipantId) {
      this.log('Offer skipped: no peer connection or peer.');
      return;
    }
    if (this.options.role !== 'salesperson') {
      this.log('Offer skipped: the customer is the answerer.');
      return;
    }
    if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) {
      this.log('Offer skipped: the peer connection is terminal or the call is ending.');
      return;
    }
    if (this.makingOffer) {
      if (options.iceRestart) this.pendingIceRestartReason = options.reason ?? 'ICE restart';
      this.log('Offer skipped: another offer is being negotiated.');
      return;
    }
    if (pc.signalingState !== 'stable') {
      // Never create a second offer while one is outstanding. This is the
      // guard that presence refreshes and duplicate failure events hit.
      if (options.iceRestart) this.pendingIceRestartReason = options.reason ?? 'ICE restart';
      this.log(`Offer skipped: signalingState is "${pc.signalingState}".`);
      return;
    }
    if (this.offerInFlight && !options.iceRestart) {
      this.log('Offer skipped: an offer for this negotiation is already in flight.');
      return;
    }
    if (options.iceRestart && this.iceRestartInFlight) {
      this.log('ICE-restart offer skipped: a restart is already in flight.');
      return;
    }

    this.makingOffer = true;
    if (!options.iceRestart) this.negotiationAttempts += 1;
    try {
      const offer = await pc.createOffer(options.iceRestart ? { iceRestart: true } : undefined);
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (this.pc !== pc) return;
      if (!pc.localDescription) return;
      const sent = this.sendSignal({ type: 'offer', offer: pc.localDescription });
      if (!sent) {
        // Abandoned offer: roll back so a later retry can negotiate safely.
        await this.rollbackLocalOffer(pc, 'offer could not be sent');
        if (options.iceRestart) {
          // The attempt already consumed its budget slot in runRecoveryAttempt.
          // Never refund it here: a persistent failure must still reach the
          // bounded terminal state instead of retrying forever.
          this.iceRestartInFlight = false;
          this.requestIceRecovery('signaling unavailable for ICE restart');
        } else {
          this.scheduleNegotiationRetry('signaling unavailable');
        }
        return;
      }
      this.offerInFlight = true;
      if (options.iceRestart) this.iceRestartInFlight = true;
      this.armOfferWatchdog(pc, options.iceRestart ? 'iceRestart' : 'negotiation');
      this.log(
        `${options.iceRestart ? 'ICE-restart offer' : 'Offer'} sent${options.reason ? ` [${options.reason}]` : ''}.`
      );
    } catch (err) {
      this.log(`Failed to create/send offer: ${(err as Error)?.message || err}`);
      if (this.pc === pc) await this.rollbackLocalOffer(pc, 'offer creation failed');
      if (options.iceRestart) {
        this.iceRestartInFlight = false;
        this.requestIceRecovery('ICE-restart offer failed');
      } else if (this.negotiationAttempts >= MAX_NEGOTIATION_ATTEMPTS) {
        this.enterTerminalPeerFailure('offer creation failed');
      } else {
        this.scheduleNegotiationRetry('offer creation failed');
      }
    } finally {
      this.makingOffer = false;
      if (this.pc === pc) this.tryPendingIceRestart();
    }
  }

  /** Rolls an unanswered local offer back so a new offer may be created. */
  private async rollbackLocalOffer(pc: RTCPeerConnection, reason: string): Promise<void> {
    if (this.pc !== pc) return;
    if (pc.signalingState !== 'have-local-offer') {
      this.offerInFlight = false;
      this.clearOfferWatchdog();
      return;
    }
    try {
      await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit);
      this.log(`Rolled back the outstanding offer (${reason}).`);
    } catch (err) {
      this.log(`Could not roll back the outstanding offer: ${(err as Error)?.message || err}`);
    }
    if (this.pc === pc) {
      this.offerInFlight = false;
      this.clearOfferWatchdog();
    }
  }

  /**
   * A failed offer must not leave negotiation permanently idle. Retry once
   * after a short delay while the attempt budget allows it; the peer connection
   * generation guard makes the timer harmless after a replacement.
   */
  private scheduleNegotiationRetry(reason: string): void {
    if (this.negotiationRetryTimer !== null || this.stopped || this.peerFailureConfirmed) return;
    const pc = this.pc;
    if (!pc) return;
    const generation = this.pcGeneration;
    this.negotiationRetryTimer = window.setTimeout(() => {
      this.negotiationRetryTimer = null;
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      if (pc.connectionState === 'connected' || pc.signalingState !== 'stable') return;
      if (this.negotiationAttempts >= MAX_NEGOTIATION_ATTEMPTS) {
        this.enterTerminalPeerFailure(reason);
        return;
      }
      this.log(`Retrying negotiation (${reason}).`);
      void this.makeOffer({ reason: `negotiation retry: ${reason}` });
    }, 1000);
  }

  /**
   * Watches an outstanding offer. A lost answer is not allowed to wedge
   * signaling in "have-local-offer" forever; the offer is rolled back and the
   * negotiation or ICE restart is retried within its budget.
   */
  private armOfferWatchdog(pc: RTCPeerConnection, kind: 'negotiation' | 'iceRestart'): void {
    this.clearOfferWatchdog();
    const generation = this.pcGeneration;
    const timeoutMs = this.options.offerAnswerTimeoutMs ?? OFFER_ANSWER_TIMEOUT_MS;
    this.offerWatchdog = window.setTimeout(() => {
      this.offerWatchdog = null;
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      if (this.answerInFlight) {
        // The matching answer is being applied. Suspending here is what keeps
        // a valid negotiation from being rolled back; re-arm in case applying
        // that answer never settles, so the watchdog is not permanently lost.
        this.log('Offer watchdog suspended while an answer is being applied.');
        this.armOfferWatchdog(pc, kind);
        return;
      }
      if (this.isPeerConnected()) {
        this.offerInFlight = false;
        this.iceRestartInFlight = false;
        return;
      }
      if (pc.signalingState === 'have-local-offer') {
        this.log('Outstanding offer was not answered; rolling it back and retrying.');
        void this.rollbackLocalOffer(pc, 'answer timeout').then(() => {
          if (this.pc !== pc || this.stopped || this.peerFailureConfirmed) return;
          if (kind === 'iceRestart') {
            this.iceRestartInFlight = false;
            this.requestIceRecovery('ICE restart offer timed out');
          } else if (this.negotiationAttempts >= MAX_NEGOTIATION_ATTEMPTS) {
            this.enterTerminalPeerFailure('negotiation answer timeout');
          } else {
            this.log('Retrying negotiation after the answer timeout.');
            void this.makeOffer({ reason: 'negotiation retry' });
          }
        });
        return;
      }
      // The answer was applied but the transport is not connected. Recovery
      // owns the retry; a fresh non-restart offer would not help here.
      this.offerInFlight = false;
      if (kind === 'iceRestart') {
        this.iceRestartInFlight = false;
        this.requestIceRecovery('ICE restart did not connect');
      }
    }, timeoutMs);
  }

  // -------------------------------------------------------------------------
  // Signaling message handling
  // -------------------------------------------------------------------------

  private async flushPendingIceCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) return;
    const batch = this.pendingIce;
    this.pendingIce = [];
    for (const entry of batch) {
      if (entry.from && this.peerParticipantId && entry.from !== this.peerParticipantId) continue;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(entry.candidate));
      } catch (err) {
        this.log(`addIceCandidate failed: ${(err as Error)?.message || err}`);
      }
    }
  }

  private handleJoined(data: Record<string, any>): void {
    this.clearJoinTimeout();
    this.joinedThisSocket = true;

    if (typeof data.participantId !== 'string' || !data.participantId) {
      this.log('Join acknowledgement had no participant id; reconnecting.');
      try {
        this.ws?.close(4000, 'missing_participant_id');
      } catch {
        // Ignore close errors.
      }
      return;
    }

    const previousId = this.participantId;
    const wasReconnect = Boolean(previousId) || this.reconnectAttempt > 0;

    this.participantId = data.participantId;
    if (typeof data.resumeToken === 'string') {
      this.resumeToken = data.resumeToken;
      this.options.onResumeToken?.(data.resumeToken);
    }

    if (wasReconnect) {
      this.closePeerConnection('rejoin negotiation reset');
      // A re-authenticated signaling transport starts a genuinely new
      // negotiation, so a previous terminal WebRTC failure must not block it.
      this.resetPeerRecoveryState('signaling rejoin');
    }

    this.reconnectAttempt = 0;
    this.wsStatus = 'connected';
    this.lastError = null;
    this.lastServerError = null;
    this.log(
      `Session membership confirmed as ${data.role} (${String(data.participantId).slice(0, 8)})${
        wasReconnect ? ' after reconnect' : ''
      }.`
    );

    const peers: Array<{ participantId: string; role: ParticipantRole }> = Array.isArray(data.peers)
      ? data.peers.filter(
          (peer: any) =>
            peer &&
            typeof peer.participantId === 'string' &&
            (peer.role === 'customer' || peer.role === 'salesperson')
        )
      : [];
    this.participants = Array.isArray(data.participants) ? data.participants : peers;

    this.applyPeers(peers, wasReconnect ? 'reconnect' : 'join');
    this.emit();

    if (this.options.role === 'customer' && this.options.enableAi) {
      // Start the AI once per engine. Recovery (after a terminal session) is
      // owned by the bounded AI recovery loop, not by signaling reconnects.
      if (this.ai.state === 'off') void this.startAi({ replace: true });
      // Re-publish the live state on the new socket so the server/salesperson
      // do not keep a state that changed while signaling was down.
      else this.reportAiStatus();
    } else if (this.options.role === 'salesperson') {
      // Last known AI state reported by the customer device (server-persisted).
      this.hydrateRemoteAi(data.ai ?? data.session?.ai);
    }
  }

  private applyPeers(
    peers: Array<{ participantId: string; role: ParticipantRole }>,
    source: string,
    options: { forceRecreate?: boolean } = {}
  ): void {
    const counterpart =
      peers.find((peer) => peer.participantId !== this.participantId && peer.role !== this.options.role) ??
      null;

    if (!counterpart) {
      if (this.peerParticipantId) this.closePeerConnection(`peer absent (${source})`);
      this.resetPeerRecoveryState('');
      this.peerParticipantId = null;
      this.peerRole = null;
      this.remoteTrackState = 'none';
      this.callState = 'waiting';
      return;
    }

    // A terminal WebRTC failure must not be "recovered" by presence refreshes.
    // Only a deliberate retry, a new peer identity or a new negotiation does.
    if (
      this.peerFailureConfirmed &&
      !options.forceRecreate &&
      this.peerParticipantId === counterpart.participantId
    ) {
      this.log(`Presence refreshed (${source}); peer connection is terminal, not recreating it.`);
      this.peerRole = counterpart.role;
      return;
    }

    const pc = this.pc;
    if (
      !options.forceRecreate &&
      this.peerParticipantId === counterpart.participantId &&
      pc &&
      pc.connectionState !== 'closed'
    ) {
      // Presence is a liveness hint, not a negotiation trigger. Offers and ICE
      // restarts are owned by the negotiation/recovery state machine, so a
      // presence refresh can never create a second offer or reset recovery.
      this.log(`Presence refreshed (${source}); keeping the existing peer connection.`);
      this.peerRole = counterpart.role;
      return;
    }

    this.log(`Establishing a fresh peer connection for ${counterpart.role} (${source}).`);
    this.createPeerConnection(counterpart);
    if (this.options.role === 'salesperson') void this.makeOffer({ reason: source });
  }

  private handleJoinRejected(data: Record<string, any>): void {
    const code = typeof data.code === 'string' ? data.code : 'JOIN_REJECTED';
    const message = typeof data.message === 'string' ? data.message : `Join rejected (${code}).`;

    this.log(`Join rejected [${code}]: ${message}`);
    this.intentionalLeave = true;
    this.clearReconnectTimer();
    this.clearJoinTimeout();
    this.lastError = message;
    this.callState = 'rejected';

    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.onclose = null;
        socket.close();
      } catch {
        // Ignore close errors.
      }
    }

    this.closePeerConnection('join rejected');
    this.releaseLocalMedia('join rejected');
    this.participantId = null;
    this.resumeToken = null;
    this.wsStatus = 'disconnected';
    this.peerParticipantId = null;
    this.peerRole = null;
    this.emit();
  }

  private async handleSignal(data: Record<string, any>): Promise<void> {
    const type = data?.type;
    if (typeof type !== 'string') return;
    if (typeof data.sessionId === 'string' && data.sessionId !== this.options.sessionId) {
      this.log('Ignoring signaling message for a different session.');
      return;
    }

    if (type === 'joined') {
      this.handleJoined(data);
      return;
    }

    if (type === 'join_rejected') {
      this.handleJoinRejected(data);
      return;
    }

    if (type === 'session_state') {
      const participants = Array.isArray(data.participants) ? data.participants : [];
      this.participants = participants.filter(
        (peer: any) => peer && typeof peer.participantId === 'string'
      );
      if (this.participantId) {
        this.applyPeers(
          this.participants.filter((peer) => peer.participantId !== this.participantId),
          'session_state'
        );
      }
      if (this.options.role === 'salesperson') this.hydrateRemoteAi(data.session?.ai);
      this.emit();
      return;
    }

    if (type === 'peer_joined') {
      const peer = data.peer;
      if (!peer || typeof peer.participantId !== 'string') return;
      if (peer.participantId === this.participantId) return;
      this.log(`Peer joined: ${peer.role}.`);
      this.participants = Array.isArray(data.participants) ? data.participants : this.participants;
      this.applyPeers(
        [{ participantId: peer.participantId, role: peer.role === 'customer' ? 'customer' : 'salesperson' }],
        'peer_joined',
        // peer_joined always announces a fresh connection for that identity.
        { forceRecreate: true }
      );
      this.emit();
      return;
    }

    if (type === 'peer_left') {
      if (data.participantId !== this.peerParticipantId) return;
      this.log(`Peer left (${data.role || 'unknown'}).`);
      this.closePeerConnection('peer left');
      this.resetPeerRecoveryState('peer left');
      this.peerParticipantId = null;
      this.peerRole = null;
      this.remoteTrackState = 'none';
      this.callState = 'waiting';
      this.participants = Array.isArray(data.participants) ? data.participants : [];
      // The AI session lives on the customer device; if the customer is gone the
      // AI is gone too. Say so instead of leaving a stale "connected" badge.
      if (this.options.role === 'salesperson' && data.role === 'customer') {
        this.applyRemoteAi({
          state: 'disconnected',
          status: null,
          connected: false,
          error: 'The customer device left; the AI session ended with it.',
          audioReachingAi: false,
          reconnecting: false,
        });
        this.aiReconnectRequestedAt = null;
      }
      this.emit();
      return;
    }

    if (type === 'offer') {
      if (this.options.role !== 'customer') {
        this.log('Ignoring offer: only the customer answers.');
        return;
      }
      const offer = data.offer;
      if (!offer || typeof offer.sdp !== 'string') {
        this.log('Ignoring offer without SDP.');
        return;
      }
      if (data.from && this.peerParticipantId && data.from !== this.peerParticipantId) {
        this.log('Offer came from a stale peer; ignoring.');
        return;
      }

      if (!this.pc) {
        this.createPeerConnection({
          participantId: data.from || 'unknown',
          role: 'salesperson',
        });
      }
      const pc = this.pc;
      if (!pc) return;

      const offerSdp = String(offer.sdp);
      const incomingCredentials = iceCredentials(offerSdp);
      const activeCredentials = iceCredentials(this.lastRemoteOfferSdp);
      if (
        this.lastRemoteOfferSdp === offerSdp ||
        (incomingCredentials && activeCredentials && incomingCredentials === activeCredentials)
      ) {
        this.log('Ignoring duplicate offer: ICE credentials match the active session.');
        return;
      }
      if (pc.signalingState !== 'stable') {
        this.log(`Ignoring offer while signalingState="${pc.signalingState}".`);
        return;
      }

      try {
        this.log('Received offer. Creating answer...');
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.lastRemoteOfferSdp = offerSdp;
        await this.flushPendingIceCandidates();
        // A microphone that only became available after the offer arrived is
        // attached before the answer is created, so the answer always carries a
        // sendrecv audio m-line instead of recvonly.
        await this.syncOutboundAudio('offer received');
        const answer = await pc.createAnswer();
        if (this.pc !== pc) return;
        await pc.setLocalDescription(answer);
        this.sendSignal({ type: 'answer', answer: pc.localDescription ?? answer });
        this.log(
          `Answer sent (audio direction: ${this.sendDirection()}).`
        );
      } catch (err) {
        this.log(`Failed to apply offer/create answer: ${(err as Error)?.message || err}`);
      }
      return;
    }

    if (type === 'audio_recheck') {
      // Salesperson -> customer: verify and re-publish the microphone. This is
      // the repair for a customer track that died (device capture dropped,
      // mobile OS stole it, sender replaced with null) while the transport
      // stayed connected in one direction.
      if (this.options.role !== 'customer') {
        this.log('Ignoring audio-check request: only the customer device holds the microphone.');
        return;
      }
      if (data.from && this.peerParticipantId && data.from !== this.peerParticipantId) {
        this.log('Ignoring audio-check request from a stale peer.');
        return;
      }
      this.log('The salesperson asked this device to verify and re-publish microphone audio.');
      void this.repairOutboundAudio(
        typeof data.reason === 'string' ? data.reason : 'salesperson audio check'
      );
      return;
    }

    if (type === 'audio_state') {
      // Customer -> salesperson: sanitized report about the customer's
      // microphone. Never relayed back to the customer.
      if (this.options.role !== 'salesperson') return;
      if (data.from && this.peerParticipantId && data.from !== this.peerParticipantId) return;
      const value = (key: string): string =>
        typeof data[key] === 'string' ? String(data[key]).slice(0, 40) : '?';
      const number = (() => {
        const level = typeof data.level === 'number' && Number.isFinite(data.level) ? data.level : null;
        return level === null ? 'n/a' : level.toFixed(4);
      })();
      this.peerAudioReport =
        `track ${value('track')} · sender ${value('sender')} · direction ${value('direction')} · ` +
        `sent ${Number(data.packetsSent) || 0} · level ${number}`;
      this.diagnostics = { ...this.diagnostics, peerAudioReport: this.peerAudioReport };
      this.log(`Customer audio check report: ${this.peerAudioReport}`);
      this.emit();
      return;
    }

    if (type === 'audio_renegotiate') {
      // Customer -> salesperson: the customer cannot publish on the negotiated
      // m-line, so the offerer must send a fresh offer.
      if (this.options.role !== 'salesperson') return;
      if (data.from && this.peerParticipantId && data.from !== this.peerParticipantId) return;
      if (this.stopped || this.intentionalLeave || this.peerFailureConfirmed) return;
      this.log('The customer asked for a renegotiation so its microphone can be published.');
      void this.makeOffer({ reason: 'customer audio renegotiation' });
      return;
    }

    if (type === 'ice_restart') {
      if (this.options.role !== 'salesperson') {
        this.log('Ignoring ICE-restart request: only the salesperson performs one.');
        return;
      }
      if (data.from && this.peerParticipantId && data.from !== this.peerParticipantId) {
        this.log('Ignoring ICE-restart request from a stale peer.');
        return;
      }
      this.log('The customer requested an ICE restart.');
      this.requestIceRecovery('customer requested ICE restart', true);
      return;
    }

    if (type === 'answer') {
      if (this.options.role !== 'salesperson') return;
      const answer = data.answer;
      if (!answer || typeof answer.sdp !== 'string') {
        this.log('Ignoring answer without SDP.');
        return;
      }
      const pc = this.pc;
      if (!pc) return;
      if (data.from && this.peerParticipantId && data.from !== this.peerParticipantId) {
        this.log('Ignoring answer from a stale peer.');
        return;
      }
      if (this.answerInFlight) {
        this.log('Ignoring duplicate answer: another answer is being applied.');
        return;
      }
      if (pc.signalingState !== 'have-local-offer') {
        this.log(`Ignoring answer in signalingState="${pc.signalingState}" (duplicate or stale).`);
        return;
      }

      const generation = this.pcGeneration;
      const offerKind: 'negotiation' | 'iceRestart' = this.iceRestartInFlight
        ? 'iceRestart'
        : 'negotiation';
      // Mark the answer in flight and stop the watchdog *before* awaiting, so a
      // valid answer near the deadline can never be rolled back underneath us.
      this.answerInFlight = true;
      this.clearOfferWatchdog();
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        if (this.pc !== pc || this.pcGeneration !== generation) return;
        this.answerInFlight = false;
        this.offerInFlight = false;
        this.iceRestartInFlight = false;
        await this.flushPendingIceCandidates();
        if (this.pc !== pc || this.pcGeneration !== generation) return;
        this.log(`Answer applied (audio direction: ${this.sendDirection()}).`);
        await this.syncOutboundAudio('answer applied');
        // `sendonly` on this side means ICE/DTLS are up, this participant is
        // sending — and the remote side agreed not to send anything back. That
        // is exactly "the customer cannot be heard", detected before any RTP
        // watchdog has to fire.
        if (this.sendDirection() === 'sendonly') {
          this.log(
            'The negotiated answer is sendonly: the customer is not publishing audio. Requesting a re-publish.'
          );
          this.requestAudioRepair('answer is sendonly');
        }
        // A restart requested while signaling was not stable is now runnable.
        this.tryPendingIceRestart();
      } catch (err) {
        if (this.pc !== pc || this.pcGeneration !== generation) return;
        this.answerInFlight = false;
        this.log(`Failed to apply answer: ${(err as Error)?.message || err}`);
        // A failed answer must not permanently disable recovery. Re-arm only
        // for the still-current offer and only if signaling still permits it.
        if (pc.signalingState === 'have-local-offer') {
          this.log('Re-arming the offer watchdog after the failed answer.');
          this.armOfferWatchdog(pc, offerKind);
        }
      }
      return;
    }

    if (type === 'ice_candidate') {
      const candidate = data.candidate;
      if (!candidate || typeof candidate !== 'object') return;
      const pc = this.pc;
      const entry = {
        candidate: candidate as RTCIceCandidateInit,
        from: typeof data.from === 'string' ? data.from : null,
      };

      if (!pc || !pc.remoteDescription) {
        this.pendingIce.push(entry);
        this.log(`Buffered ICE candidate (${this.pendingIce.length} queued).`);
        return;
      }
      if (entry.from && this.peerParticipantId && entry.from !== this.peerParticipantId) {
        this.log('Discarding ICE candidate from a previous peer.');
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(entry.candidate));
      } catch (err) {
        this.log(`addIceCandidate failed: ${(err as Error)?.message || err}`);
      }
      return;
    }

    if (type === 'ai_status') {
      if (this.options.role !== 'salesperson') return;
      const rawState = typeof data.state === 'string' ? data.state : '';
      const allowed: AiStatus['state'][] = [
        'off', 'creating', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'error',
      ];
      const state = (allowed as string[]).includes(rawState)
        ? (rawState as AiStatus['state'])
        : 'error';
      this.applyRemoteAi({
        state,
        status: null,
        connected: data.connected === true && state === 'connected',
        error: sanitizeAiDetail(data.error),
        callId: typeof data.callId === 'string' ? data.callId.slice(0, 100) : null,
        reconnectAttempt:
          typeof data.reconnectAttempt === 'number' ? Math.max(0, Math.round(data.reconnectAttempt)) : 0,
        reconnecting: state === 'reconnecting' || state === 'creating' || state === 'connecting',
        audioReachingAi: data.audioReachingAi === true && state === 'connected',
        lastResponseAt: typeof data.lastResponseAt === 'number' ? data.lastResponseAt : null,
        lastSuggestionAt: typeof data.lastSuggestionAt === 'number' ? data.lastSuggestionAt : null,
        lastEventAt: Date.now(),
      });
      return;
    }

    if (type === 'ai_reconnect') {
      if (this.options.role !== 'customer') return;
      this.log('The salesperson requested a fresh AI session.');
      this.aiRecoveryAttempt = 0;
      this.clearAiRecoveryTimer();
      void this.startAi({ replace: true });
      return;
    }

    if (type === 'ai_suggestion') {
      if (this.options.role !== 'salesperson') return;
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) return;
      const ordinal = typeof data.ordinal === 'number' ? data.ordinal : this.suggestions.length;
      const isFinal = Boolean(data.isFinal);
      const existing = this.suggestions.find((item) => item.ordinal === ordinal);
      if (existing) {
        if (existing.text === text && existing.isFinal === isFinal) return;
        this.suggestions = this.suggestions.map((item) =>
          item.ordinal === ordinal ? { ...item, text, isFinal } : item
        );
      } else {
        this.suggestions = [
          ...this.suggestions,
          {
            id: `${ordinal}-${Date.now()}`,
            ordinal,
            text,
            isFinal,
            timestamp:
              typeof data.timestamp === 'string' && data.timestamp
                ? data.timestamp
                : new Date().toLocaleTimeString(),
          },
        ].sort((a, b) => a.ordinal - b.ordinal);
      }
      // A suggestion is proof that the live AI produced a response, even if a
      // status message was lost.
      this.ai = {
        ...this.ai,
        source: 'remote',
        lastSuggestionAt: Date.now(),
        lastResponseAt: Date.now(),
      };
      this.aiReconnectRequestedAt = null;
      this.emit();
      return;
    }

    if (type === 'customer_speech_transcript') {
      if (this.options.role !== 'salesperson') return;
      this.customerSpeech = typeof data.text === 'string' ? data.text : '';
      this.emit();
      return;
    }

    if (type === 'salesperson_caption') {
      if (this.options.role !== 'customer') return;
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) return;
      this.salespersonCaption = text;
      this.emit();
      return;
    }

    if (type === 'signal_error') {
      this.lastServerError = `${data.code || 'SIGNAL_ERROR'}${data.forType ? ` (${data.forType})` : ''}`;
      this.log(`Server signaling error: ${this.lastServerError}`);
      return;
    }

    if (type === 'error') {
      this.lastServerError = `${data.code || 'ERROR'}: ${data.message || ''}`.trim();
      this.log(`Server error: ${this.lastServerError}`);
      return;
    }

    if (type === 'pong') return;
  }

  // -------------------------------------------------------------------------
  // Customer-side AI pipeline (Ultravox)
  //
  // The customer device is the only place a microphone is published to the AI.
  // The salesperson never publishes to Ultravox, so salesperson speech can
  // never enter the customer -> AI pipeline.
  // -------------------------------------------------------------------------

  /**
   * Requests a genuinely new Ultravox call and connects a new SDK session.
   *
   * Replacement is the supported recovery path: Ultravox calls are finite, the
   * SDK has no reconnect API, and a join URL belongs to one call. The server's
   * cached call is never reused after a failure.
   */
  private async startAi(options: { replace?: boolean; recovery?: boolean } = {}): Promise<void> {
    if (this.options.role !== 'customer' || !this.options.enableAi) return;
    if (this.stopped || this.intentionalLeave) return;
    if (this.aiOperationInFlight) {
      this.log('AI start ignored: another AI session operation is already in progress.');
      return;
    }
    // The signaling socket reconnects independently of the AI. If the SDK
    // session is still live, keep it instead of creating a new (paid) call.
    if (!options.replace && this.ultravox && this.ai.connected) {
      this.log('AI session is already connected; not creating another one.');
      return;
    }

    this.aiOperationInFlight = true;
    this.clearAiRecoveryTimer();
    this.clearAiConnectTimer();

    // Invalidate the previous session before touching it, so its late status,
    // error or transcript callbacks can never overwrite the new session's state.
    const generation = ++this.aiGeneration;
    await this.teardownAiSession('replacing the previous AI session');

    if (this.stopped || this.intentionalLeave || generation !== this.aiGeneration) {
      // The call was stopped while the previous session was tearing down.
      this.aiOperationInFlight = false;
      return;
    }

    this.setAi({
      state: options.recovery ? 'reconnecting' : 'creating',
      status: null,
      connected: false,
      error: null,
      callId: null,
      reconnectAttempt: options.recovery ? this.aiRecoveryAttempt : 0,
      reconnecting: Boolean(options.recovery),
      audioReachingAi: false,
      lastEventAt: Date.now(),
    });

    let failure: string | null = null;
    try {
      this.log('Requesting a new AI call from the server...');
      const response = await fetch(
        `${this.apiBase}/api/sessions/${encodeURIComponent(this.options.sessionId)}/ultravox-call`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.credential}`,
          },
          // Explicit replacement: never accept a previously used join URL.
          body: JSON.stringify({ replace: true }),
        }
      );

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
          status?: number;
        };
        const code = errorBody.error ? `${errorBody.error}: ` : '';
        throw new Error(
          `${code}${errorBody.message || `AI call request failed (HTTP ${response.status})`}` +
            (errorBody.status ? ` [HTTP ${errorBody.status}]` : '')
        );
      }

      const call = (await response.json()) as {
        callId?: string;
        joinUrl?: string;
        isReused?: boolean;
      };
      if (!call.callId || !call.joinUrl) throw new Error('The server returned an incomplete AI call.');
      if (call.isReused) {
        // Defensive: this client always asks for replacement.
        throw new Error('The server reused an existing AI call; a fresh call is required.');
      }
      if (generation !== this.aiGeneration) return;

      this.log(`New AI call created (${String(call.callId).slice(0, 8)}).`);
      const session = this.createAiSession();
      this.ultravox = session;
      this.aiEverConnected = false;
      this.aiConnectedSince = null;
      this.setAi({
        state: 'connecting',
        status: UltravoxSessionStatus.CONNECTING,
        connected: false,
        error: null,
        callId: call.callId,
        audioReachingAi: false,
        lastEventAt: Date.now(),
      });

      const isStale = () => generation !== this.aiGeneration || this.ultravox !== session;

      session.addEventListener('status', () => {
        if (isStale()) return; // a previous session must not change this state
        const status = session.status;
        if (status === UltravoxSessionStatus.DISCONNECTED) {
          this.failAiSession(
            generation,
            'closed',
            this.aiEverConnected
              ? 'The AI session ended (the provider closed the session).'
              : 'The AI session closed before it connected.'
          );
          return;
        }
        if (status === UltravoxSessionStatus.DISCONNECTING) {
          this.setAi({
            state: 'disconnected',
            status,
            connected: false,
            audioReachingAi: false,
            reconnecting: false,
            lastEventAt: Date.now(),
          });
          return;
        }

        const connected = isLiveAiStatus(status);
        if (connected) {
          this.aiEverConnected = true;
          if (this.aiConnectedSince === null) this.aiConnectedSince = Date.now();
          this.clearAiConnectTimer();
          if (status === UltravoxSessionStatus.LISTENING || status === UltravoxSessionStatus.IDLE) {
            try {
              // Text-only output: the AI must not speak over the salesperson.
              session.setOutputMedium(Medium.TEXT);
              session.muteSpeaker();
            } catch {
              // Ignore unsupported output-medium transitions.
            }
          }
          if (this.micMuted) {
            try {
              session.muteMic();
            } catch {
              // Ignore.
            }
          }
        }

        this.setAi({
          state: connected ? 'connected' : 'connecting',
          status,
          connected,
          error: connected ? null : this.ai.error,
          reconnecting: false,
          // Only claim the microphone reaches the AI once the SDK actually
          // captured and published a local track.
          audioReachingAi: connected && !this.micMuted && Boolean(session.micSourceNode),
          lastEventAt: Date.now(),
        });
      });

      session.addEventListener('transcripts', () => {
        if (isStale()) return;
        const timestamp = new Date().toLocaleTimeString();
        let lastSuggestionAt = this.ai.lastSuggestionAt;
        let lastResponseAt = this.ai.lastResponseAt;
        for (const transcript of session.transcripts) {
          if (transcript.speaker === Role.AGENT && transcript.text.trim()) {
            this.sendSignal({
              type: 'ai_suggestion',
              text: transcript.text,
              isFinal: transcript.isFinal,
              ordinal: transcript.ordinal,
              timestamp,
            });
            lastResponseAt = Date.now();
            if (transcript.isFinal) lastSuggestionAt = lastResponseAt;
          } else if (transcript.speaker === Role.USER) {
            this.customerSpeech = transcript.text;
            if (transcript.isFinal && transcript.text.trim()) {
              this.sendSignal({
                type: 'customer_speech_transcript',
                text: transcript.text,
                isFinal: true,
                ordinal: transcript.ordinal,
                timestamp,
              });
            }
          }
        }
        this.setAi(
          { lastResponseAt, lastSuggestionAt, lastEventAt: Date.now() },
          { report: false }
        );
        this.reportAiStatus();
      });

      session.addEventListener('error', (event) => {
        if (isStale()) return;
        const error = (event as unknown as { error?: Error }).error;
        const detail = sanitizeAiDetail(error?.message) || 'The AI session ended unexpectedly.';
        this.log(`AI session error: ${detail}`);
        this.failAiSession(generation, 'error', detail);
      });

      // The SDK has no public connect timeout: without this an attempt could
      // stay in "connecting" forever and never recover.
      this.aiConnectTimer = window.setTimeout(() => {
        this.aiConnectTimer = null;
        if (isStale()) return;
        this.failAiSession(
          generation,
          'error',
          `Timed out after ${Math.round(AI_CONNECT_TIMEOUT_MS / 1000)}s waiting for the AI session to connect.`
        );
      }, AI_CONNECT_TIMEOUT_MS);

      this.log(`Joining the new AI call (${String(call.callId).slice(0, 8)}).`);
      session.joinCall(call.joinUrl);
    } catch (err) {
      failure = sanitizeAiDetail((err as Error)?.message) || 'AI setup failed.';
      this.log(`AI setup failed: ${failure}`);
    } finally {
      this.aiOperationInFlight = false;
    }

    if (failure !== null) {
      if (generation !== this.aiGeneration) return;
      this.setAi({
        state: 'error',
        status: null,
        connected: false,
        error: failure,
        audioReachingAi: false,
        reconnecting: false,
      });
      this.scheduleAiRecovery(failure);
    }
  }


  private setAi(
    patch: Partial<AiStatus>,
    options: { report?: boolean } = {}
  ): void {
    this.ai = { ...this.ai, ...patch, source: 'local' };
    // Compatibility view used by older dashboard code: the raw SDK status while
    // live, otherwise the lifecycle state. "Connected" therefore cannot be
    // rendered unless the SDK actually reported a live session.
    this.aiStatus = isLiveAiStatus(this.ai.status)
      ? (this.ai.status as UltravoxSessionStatus)
      : this.ai.state;
    this.aiError = this.ai.error;
    this.emit();
    if (options.report !== false) this.reportAiStatus();
  }

  /** Forwards the customer's real AI state to the server/salesperson. */
  private reportAiStatus(): void {
    if (this.options.role !== 'customer' || !this.options.enableAi) return;
    this.sendSignal({
      type: 'ai_status',
      state: this.ai.state,
      connected: this.ai.connected,
      error: this.ai.error,
      callId: this.ai.callId,
      reconnectAttempt: this.ai.reconnectAttempt,
      audioReachingAi: this.ai.audioReachingAi,
      lastResponseAt: this.ai.lastResponseAt,
      lastSuggestionAt: this.ai.lastSuggestionAt,
    });
  }

  /** Mirrors customer-reported AI state into the salesperson's engine. */
  private applyRemoteAi(patch: Partial<AiStatus> & { state: AiStatus['state'] }): void {
    if (this.options.role !== 'salesperson') return;
    this.ai = { ...this.ai, ...patch, source: 'remote' };
    this.aiStatus = this.ai.state;
    this.aiError = this.ai.error;
    if (this.ai.reconnecting || this.ai.connected) this.aiReconnectRequestedAt = null;
    this.emit();
  }

  /** Hydrates the salesperson view from an HTTP/WS session snapshot. */
  private hydrateRemoteAi(value: unknown): void {
    if (this.options.role !== 'salesperson' || !value || typeof value !== 'object') return;
    const runtime = value as Record<string, unknown>;
    const rawState = typeof runtime.state === 'string' ? runtime.state : '';
    if (!rawState) return;
    const state = rawState as AiStatus['state'];
    this.applyRemoteAi({
      state,
      connected: runtime.connected === true && state === 'connected',
      status: null,
      error: sanitizeAiDetail(runtime.error),
      callId: typeof runtime.callId === 'string' ? runtime.callId.slice(0, 100) : null,
      reconnectAttempt:
        typeof runtime.reconnectAttempt === 'number'
          ? Math.max(0, Math.round(runtime.reconnectAttempt))
          : 0,
      reconnecting: state === 'reconnecting' || state === 'creating' || state === 'connecting',
      audioReachingAi: runtime.audioReachingAi === true && state === 'connected',
      lastResponseAt: typeof runtime.lastResponseAt === 'number' ? runtime.lastResponseAt : null,
      lastSuggestionAt: typeof runtime.lastSuggestionAt === 'number' ? runtime.lastSuggestionAt : null,
    });
  }


  /**
   * Tears down one SDK session without letting a broken transport delay the
   * human call. The session's callbacks are already invalidated by the caller.
   */
  private leaveAiSession(session: UltravoxSession): void {
    void Promise.race([
      Promise.resolve()
        .then(() => session.leaveCall())
        .catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, AI_LEAVE_TIMEOUT_MS)),
    ]);
  }

  private async teardownAiSession(reason: string): Promise<void> {
    this.clearAiConnectTimer();
    const session = this.ultravox;
    this.ultravox = null;
    if (!session) return;
    this.log(`Closing the previous AI session (${reason}).`);
    await Promise.race([
      Promise.resolve()
        .then(() => session.leaveCall())
        .catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, AI_LEAVE_TIMEOUT_MS)),
    ]);
  }

  /** Marks the current session dead, then performs a bounded recovery. */
  private failAiSession(generation: number, state: 'error' | 'closed', message: string): void {
    if (generation !== this.aiGeneration) return;
    const session = this.ultravox;
    // Invalidate first: DISCONNECTED always follows an error event, and it must
    // not start a second recovery for the same failure.
    this.aiGeneration += 1;
    this.ultravox = null;
    this.clearAiConnectTimer();
    this.aiConnectedSince = null;
    if (session) this.leaveAiSession(session);
    this.setAi({
      state,
      status: null,
      connected: false,
      error: sanitizeAiDetail(message) || 'The AI session ended unexpectedly.',
      audioReachingAi: false,
      reconnecting: false,
    });
    this.scheduleAiRecovery(this.ai.error || 'AI session ended unexpectedly.');
  }

  private clearAiRecoveryTimer(): void {
    if (this.aiRecoveryTimer !== null) window.clearTimeout(this.aiRecoveryTimer);
    this.aiRecoveryTimer = null;
  }

  private clearAiConnectTimer(): void {
    if (this.aiConnectTimer !== null) window.clearTimeout(this.aiConnectTimer);
    this.aiConnectTimer = null;
  }



  private scheduleAiRecovery(reason: string): void {
    if (this.options.role !== 'customer' || !this.options.enableAi) return;
    if (this.stopped || this.intentionalLeave) return;
    if (this.aiRecoveryTimer !== null || this.aiOperationInFlight) return;

    // A session that stayed live for a while earns a fresh retry budget, so a
    // long call that drops once is not penalised, while instant flapping stops
    // after the bound.
    if (this.aiConnectedSince !== null && Date.now() - this.aiConnectedSince > 60_000) {
      this.aiRecoveryAttempt = 0;
    }

    if (this.aiRecoveryAttempt >= AI_RECONNECT_MAX_ATTEMPTS) {
      const detail = `${reason} Automatic recovery stopped after ${AI_RECONNECT_MAX_ATTEMPTS} attempts; the human call is unaffected. Use "Restart AI" to try again.`;
      this.setAi({
        state: 'error',
        status: null,
        connected: false,
        error: sanitizeAiDetail(detail, 400),
        reconnecting: false,
        audioReachingAi: false,
      });
      this.log('AI recovery stopped after the bounded retry limit.');
      return;
    }

    this.aiRecoveryAttempt += 1;
    const delays = this.options.aiRetryDelaysMs ?? AI_RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.aiRecoveryAttempt - 1, delays.length - 1)] ?? 4000;
    this.setAi({
      state: 'reconnecting',
      status: null,
      connected: false,
      error: sanitizeAiDetail(reason),
      reconnectAttempt: this.aiRecoveryAttempt,
      reconnecting: true,
      audioReachingAi: false,
    });
    this.log(
      `AI recovery scheduled in ${delay}ms (attempt ${this.aiRecoveryAttempt}/${AI_RECONNECT_MAX_ATTEMPTS}).`
    );

    this.aiRecoveryTimer = window.setTimeout(() => {
      this.aiRecoveryTimer = null;
      if (this.stopped || this.intentionalLeave) return;
      void this.startAi({ replace: true, recovery: true });
    }, delay);
  }

  /**
   * Public recovery entry point. The customer restarts locally; the
   * salesperson asks the customer device over signaling because only that
   * device holds the AI session and the microphone.
   */
  async retryAi(): Promise<void> {
    if (this.options.role !== 'customer') {
      this.requestAiReconnect();
      return;
    }
    this.aiRecoveryAttempt = 0;
    this.clearAiRecoveryTimer();
    this.log('Manual AI restart requested; a brand new Ultravox call will be created.');
    await this.startAi({ replace: true });
  }

  /** Salesperson control: never touches the salesperson<->customer WebRTC path. */
  requestAiReconnect(): void {
    if (this.options.role === 'customer') {
      void this.retryAi();
      return;
    }
    const sent = this.sendSignal({ type: 'ai_reconnect', reason: 'salesperson requested' });
    if (!sent) {
      this.lastError = 'Could not ask the customer device to restart the AI: signaling is not connected.';
      this.log(this.lastError);
      this.emit();
      return;
    }
    this.aiReconnectRequestedAt = Date.now();
    this.log('Asked the customer device to create a fresh AI session.');
    this.emit();
  }

  private async stopAi(): Promise<void> {
    // Invalidate every callback from the session being stopped before waiting.
    this.aiGeneration += 1;
    this.clearAiRecoveryTimer();
    this.clearAiConnectTimer();
    this.aiRecoveryAttempt = 0;
    this.aiConnectedSince = null;
    const session = this.ultravox;
    this.ultravox = null;
    if (session) this.leaveAiSession(session);
    this.setAi(
      {
        state: 'off',
        status: null,
        connected: false,
        error: null,
        callId: null,
        reconnectAttempt: 0,
        reconnecting: false,
        audioReachingAi: false,
      },
      { report: false }
    );
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  private startDiagnosticsLoop(): void {
    this.stopDiagnosticsLoop();
    this.statsTimer = window.setInterval(() => void this.sampleStats(), 1500);
    this.reportTimer = window.setInterval(() => this.reportToServer(), 5000);
    void this.sampleStats();
  }

  private stopDiagnosticsLoop(): void {
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    if (this.reportTimer !== null) window.clearInterval(this.reportTimer);
    this.statsTimer = null;
    this.reportTimer = null;
    this.lastStats = null;
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    const element = this.audioElement;
    const localTrack = this.localStream?.getAudioTracks()[0];
    const remoteTrack = (this.remoteStream?.getAudioTracks() ?? [])[0];

    const next: CallDiagnostics = {
      ...this.diagnostics,
      wsStatus: this.wsStatus,
      pcState: pc?.connectionState ?? 'none',
      iceState: pc?.iceConnectionState ?? 'none',
      iceGatheringState: pc?.iceGatheringState ?? 'none',
      candidates: { ...this.candidateTypes },
      localSenderCount: pc?.getSenders().filter((sender) => sender.track?.kind === 'audio').length ?? 0,
      localTrackState: localTrack ? `${localTrack.readyState}${localTrack.enabled ? '' : ' (disabled)'}${localTrack.muted ? ' (muted)' : ''}` : 'none',
      remoteTrackState: remoteTrack ? `${remoteTrack.readyState}${remoteTrack.muted ? ' (muted)' : ''}` : this.remoteTrackState,
      remoteTrackMuted: remoteTrack ? remoteTrack.muted : null,
      audioElementPaused: element ? element.paused : null,
      audioElementMuted: element ? element.muted : null,
      audioElementVolume: element ? element.volume : null,
      playbackError: this.playbackError,
      hasTurn: this.iceConfig.hasTurn,
      iceTransportPolicy: this.iceConfig.iceTransportPolicy,
      sendBitrateKbps: 0,
      receiveBitrateKbps: 0,
      remoteTrackEnabled: remoteTrack ? remoteTrack.enabled : null,
      sendDirection: this.sendDirection(),
      senderTrackState: this.pc ? this.senderTrack() : 'none',
      playbackState: this.playbackState,
      audioElementCurrentTime: element ? Number(element.currentTime.toFixed(2)) : null,
      peerAudioReport: this.peerAudioReport,
    };

    if (pc) {
      try {
        const stats = await pc.getStats();
        const candidates = new Map<string, any>();
        let pair: any = null;
        let inboundLevel: number | null = null;
        let outboundLevel: number | null = null;
        let previousEnergy: number | null = null;
        let energy: number | null = null;

        stats.forEach((report: any) => {
          if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
            candidates.set(report.id, report);
          }
          if (
            report.type === 'candidate-pair' &&
            (report.nominated || report.selected) &&
            report.state === 'succeeded'
          ) {
            pair = report;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            next.bytesReceived = report.bytesReceived ?? 0;
            next.inboundPackets = report.packetsReceived ?? 0;
            next.inboundPacketsLost = report.packetsLost ?? 0;
            if (typeof report.audioLevel === 'number') inboundLevel = report.audioLevel;
            if (typeof report.totalAudioEnergy === 'number') energy = report.totalAudioEnergy;
          }
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            next.bytesSent = report.bytesSent ?? 0;
            next.outboundPackets = report.packetsSent ?? 0;
          }
          if (report.type === 'media-source' && report.kind === 'audio') {
            if (typeof report.audioLevel === 'number') outboundLevel = report.audioLevel;
          }
          if (report.type === 'transport') {
            next.dtlsState = report.dtlsState ?? 'unknown';
          }
        });

        // `getSynchronizationSources()` reports the measured level of the
        // decoded remote audio and is available in every current browser, so it
        // is preferred over the (optional) per-report audioLevel.
        if (!inboundLevel) {
          const sources = this.audioTransceiver()?.receiver?.getSynchronizationSources?.() ?? [];
          const levels = sources
            .map((source) => source.audioLevel)
            .filter((level): level is number => typeof level === 'number');
          if (levels.length) inboundLevel = Math.max(...levels);
        }
        // Sound can only be claimed/denied when the browser exposes a level or
        // an energy counter. Packet counts prove delivery, not audibility — so
        // they must never be used to call a call "silent".
        const measurable = inboundLevel !== null || energy !== null;
        this.inboundSoundMeasurable = measurable;
        next.inboundAudioLevel = inboundLevel;
        next.localAudioLevel = outboundLevel;
        // Sound = a measurable level above the audibility threshold, or a rise
        // in cumulative audio energy (the only proof that the received audio is
        // not digital silence).
        if (typeof energy === 'number') {
          previousEnergy = this.lastInboundEnergy;
          this.lastInboundEnergy = energy;
        }
        const levelAudible = typeof inboundLevel === 'number' && inboundLevel >= AUDIBLE_LEVEL;
        const energyRose =
          typeof energy === 'number' && typeof previousEnergy === 'number' && energy > previousEnergy;
        if (levelAudible || energyRose) this.lastSoundAt = Date.now();

        if (pair) {
          const local = candidates.get(pair.localCandidateId);
          const remote = candidates.get(pair.remoteCandidateId);
          next.selectedLocalType = local?.candidateType ?? 'unknown';
          next.selectedRemoteType = remote?.candidateType ?? 'unknown';
          next.relayPath = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        }

        const now = Date.now();
        const previous = this.lastStats;
        if (next.bytesReceived > (previous?.bytesReceived ?? 0)) {
          // RTP is actually arriving: this is the only proof of working media.
          this.lastMediaAt = now;
        }
        if (previous) {
          const seconds = Math.max((now - previous.at) / 1000, 0.001);
          next.sendBitrateKbps = Math.round(((next.bytesSent - previous.bytesSent) * 8) / seconds / 1000);
          next.receiveBitrateKbps = Math.round(
            ((next.bytesReceived - previous.bytesReceived) * 8) / seconds / 1000
          );
        }
        this.lastStats = { at: now, bytesSent: next.bytesSent, bytesReceived: next.bytesReceived };
      } catch (err) {
        this.log(`getStats failed: ${(err as Error)?.message || err}`);
      }
    } else {
      this.lastStats = null;
    }

    const mediaAge = this.lastMediaAt > 0 ? Date.now() - this.lastMediaAt : null;
    next.lastMediaAgoMs = mediaAge;
    next.mediaFlowing = mediaAge !== null && mediaAge < MEDIA_FLOW_FRESH_MS;
    const soundAge = this.lastSoundAt > 0 ? Date.now() - this.lastSoundAt : null;
    next.lastSoundAgoMs = soundAge;
    next.inboundSound = soundAge !== null && soundAge < SOUND_FRESH_MS;
    next.inboundSoundMeasurable = this.inboundSoundMeasurable;
    // Which directions are actually carrying audio right now. A connected call
    // with "outbound-only" means the peer cannot hear this participant, and
    // "inbound-only" means this participant cannot hear the peer.
    const sending = next.sendBitrateKbps > 0;
    const receiving = next.receiveBitrateKbps > 0;
    next.audioFlow = sending && receiving ? 'both' : receiving ? 'inbound-only' : sending ? 'outbound-only' : 'none';

    this.diagnostics = next;
    this.dtlsState = next.dtlsState;
    this.emit();
  }

  /**
   * Pushes a sanitised summary to the backend so signaling and routing failures
   * can be diagnosed server-side, without the frontend console.
   */
  private reportToServer(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.participantId) return;
    this.sendSignal({
      type: 'client_diagnostics',
      diagnostics: {
        wsStatus: this.wsStatus,
        callState: this.callState,
        micPermission: this.micPermission,
        muted: this.micMuted,
        localTrackState: this.diagnostics.localTrackState,
        localSenderCount: this.diagnostics.localSenderCount,
        remoteTrackState: this.diagnostics.remoteTrackState,
        playbackBlocked: this.playbackBlocked,
        bytesSent: this.diagnostics.bytesSent,
        bytesReceived: this.diagnostics.bytesReceived,
        pcState: this.diagnostics.pcState,
        iceState: this.diagnostics.iceState,
        iceGatheringState: this.diagnostics.iceGatheringState,
        selectedLocalType: this.diagnostics.selectedLocalType,
        selectedRemoteType: this.diagnostics.selectedRemoteType,
        relayPath: this.diagnostics.relayPath,
        aiStatus: this.aiStatus,
        aiConnected: this.ai.connected,
        aiState: this.ai.state,
        aiAudioReaching: this.ai.audioReachingAi,
        aiLastResponseAt: this.ai.lastResponseAt,
        aiReconnectAttempt: this.ai.reconnectAttempt,
        reconnectAttempt: this.reconnectAttempt,
        candidates: this.diagnostics.candidates,
        iceConfigLoaded: this.iceConfigLoaded,
        turnConfigured: this.iceConfig.turn.configured,
        turnCredentialMode: this.iceConfig.turn.credentialMode,
        relayCandidates: this.candidateTypes.relay,
        mediaFlowing: this.lastMediaAt > 0 && Date.now() - this.lastMediaAt < MEDIA_FLOW_FRESH_MS,
        audioFlow: this.diagnostics.audioFlow,
        lastMediaAgoMs: this.diagnostics.lastMediaAgoMs,
        inboundPackets: this.diagnostics.inboundPackets,
        outboundPackets: this.diagnostics.outboundPackets,
        inboundPacketsLost: this.diagnostics.inboundPacketsLost,
        inboundAudioLevel: this.diagnostics.inboundAudioLevel,
        inboundSound: this.diagnostics.inboundSound,
        lastSoundAgoMs: this.diagnostics.lastSoundAgoMs,
        sendDirection: this.diagnostics.sendDirection,
        senderTrackState: this.diagnostics.senderTrackState,
        playbackState: this.diagnostics.playbackState,
        audioHealth: this.computeAudioHealth()?.code ?? null,
        dtlsState: this.dtlsState,
      },
    });
  }
}

