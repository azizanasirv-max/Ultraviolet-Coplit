/**
 * Prototype 2 call engine.
 *
 * Owns every media and signaling concern for one participant, independent of
 * the React tree:
 *   - WebSocket signaling (join, offer/answer/ICE relay, AI text relay)
 *   - the single RTCPeerConnection used for salesperson <-> customer audio
 *   - microphone acquisition, mute, track recovery and diagnostics
 *   - the server-side AI session transport that feeds the AI pipeline
 *
 * Negotiation policy: the salesperson is always the offerer, the customer is
 * always the answerer. This removes glare by construction.
 */
import { AiSessionStatus, AiVoiceSession, Medium, SelfHostedAiSession } from './aiSession';
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
  aiStatus: AiSessionStatus | AiLifecycleState;
  aiError: string | null;
  /** Full AI lifecycle state (local for the customer, reported for the salesperson). */
  ai: AiStatus;
  /** Salesperson only: when they asked the server to restart the AI. */
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
  /** Customer only: start the self-hosted AI session after joining. */
  enableAi?: boolean;
  /** Notified when the server rotates/returns the resume token. */
  onResumeToken?: (token: string) => void;
  /**
   * Test seam: replace the real `SelfHostedAiSession`. Production never sets
   * this. The fake must implement the `AiVoiceSession` interface.
   */
  createAiSession?: () => AiVoiceSession;
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
  private aiVoice: AiVoiceSession | null = null;
  private readonly createAiSession: () => AiVoiceSession;

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
    audioFlow: 'none',
    lastMediaAgoMs: null,
  };
  private lastStats: { at: number; bytesSent: number; bytesReceived: number } | null = null;

  constructor(options: CallEngineOptions) {
    this.options = options;
    this.apiBase = options.apiBase ?? '';
    this.resumeToken = options.resumeToken ?? null;
    this.silentClip = silentClipUrl();
    this.createAiSession = options.createAiSession ?? (() => new SelfHostedAiSession());
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
      diagnostics: { ...this.diagnostics, wsStatus: this.wsStatus },
      logs: this.logs,
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

  attachAudioElement(element: HTMLAudioElement | null): void {
    this.audioElement = element;
    if (element && this.remoteStream) this.attachRemoteStream(this.remoteStream);
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
      this.log('Remote audio element unlocked by user gesture.');
      return true;
    } catch (err) {
      const error = err as Error;
      this.audioUnlocked = false;
      this.playbackBlocked = true;
      this.playbackError = `${error?.name || 'Error'}: ${error?.message || error}`;
      this.log(`Remote audio unlock rejected: ${this.playbackError}`);
      return false;
    }
  }

  /** Retries playback after a blocked autoplay attempt (tap anywhere). */
  async resumePlayback(): Promise<boolean> {
    const element = this.audioElement;
    if (!element) return false;
    if (element.srcObject) {
      element.muted = this.speakerMuted;
      try {
        await element.play();
        this.playbackBlocked = false;
        this.playbackError = null;
        this.audioUnlocked = true;
        this.log('Remote audio resumed after user interaction.');
        this.emit();
        return true;
      } catch (err) {
        const error = err as Error;
        this.playbackBlocked = true;
        this.playbackError = `${error?.name || 'Error'}: ${error?.message || error}`;
        this.log(`Remote audio resume failed: ${this.playbackError}`);
        this.emit();
        return false;
      }
    }
    return this.unlockAudio();
  }

  private attachRemoteStream(stream: MediaStream): void {
    const element = this.audioElement;
    if (!element) {
      this.log('Remote audio element is not mounted yet; stream will attach on mount.');
      return;
    }
    element.muted = this.speakerMuted;
    element.volume = 1;
    element.loop = false;
    if (element.src) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    element.srcObject = stream;
    element
      .play()
      .then(() => {
        this.playbackBlocked = false;
        this.playbackError = null;
        this.log('Playing remote audio stream live.');
        this.emit();
      })
      .catch((err: Error) => {
        this.playbackBlocked = true;
        this.playbackError = `${err?.name || 'Error'}: ${err?.message || err}`;
        this.log(`Remote audio playback blocked: ${this.playbackError}`);
        this.emit();
      });
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
    this.connectSignaling(false);
  }

  // -------------------------------------------------------------------------
  // Salesperson captions (browser SpeechRecognition -> signaling -> customer)
  //
  // The salesperson's microphone is NOT sent to the AI and is NOT merged into
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
    if (this.options.role === 'customer' && this.aiVoice) {
      try {
        if (muted) this.aiVoice.muteMic();
        else if (this.aiVoice.status !== AiSessionStatus.DISCONNECTED) this.aiVoice.unmuteMic();
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
          this.ai.connected && !muted && Boolean(this.aiVoice?.micSourceNode),
      };
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
   * starts (the customer device also owns the /ws/ai audio upload). Reacquire
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
    const sender =
      this.audioSender ??
      pc.getSenders().find((candidate) => candidate.track?.kind === 'audio') ??
      null;
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
      this.log(`Received remote ${event.track.kind} track from ${peer.role}.`);
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.remoteStream = remote;
      this.remoteTrackState = 'live';
      this.attachRemoteStream(remote);
      this.emit();

      // A replaced track from an older peer connection must not change the
      // current connection's state.
      const isStale = () => this.pc !== pc || this.pcGeneration !== generation;
      event.track.onmute = () => {
        if (isStale()) return;
        this.remoteTrackState = 'live';
        this.log('Remote audio track muted (no media arriving yet).');
        this.emit();
      };
      event.track.onunmute = () => {
        if (isStale()) return;
        this.remoteTrackState = 'live';
        this.log('Remote audio track unmuted (media arriving).');
        this.emit();
      };
      event.track.onended = () => {
        if (isStale()) return;
        this.remoteTrackState = 'ended';
        this.log('Remote audio track ended.');
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
    const schedule = () => {
      this.mediaWatchdog = window.setTimeout(check, checkMs);
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
    } else if (this.options.role === 'salesperson') {
      // Last known AI state persisted by the server bridge.
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
      // The AI audio source is the customer socket; if the customer is gone the
      // AI is gone too. Say so instead of leaving a stale "connected" badge.
      if (this.options.role === 'salesperson' && data.role === 'customer') {
        this.applyRemoteAi({
          state: 'disconnected',
          status: null,
          connected: false,
          error: 'The customer left; the AI session ended.',
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
        const answer = await pc.createAnswer();
        if (this.pc !== pc) return;
        await pc.setLocalDescription(answer);
        this.sendSignal({ type: 'answer', answer: pc.localDescription ?? answer });
        this.log('Answer sent.');
      } catch (err) {
        this.log(`Failed to apply offer/create answer: ${(err as Error)?.message || err}`);
      }
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
        this.log('Answer applied.');
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
        activity: (['idle', 'connecting', 'listening', 'generating', 'error'] as string[]).includes(
          String(data.activity)
        )
          ? (data.activity as AiStatus['activity'])
          : state === 'connected'
            ? 'listening'
            : state === 'error'
              ? 'error'
              : state === 'off'
                ? 'idle'
                : 'connecting',
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
  // Customer-side AI pipeline (self-hosted model service)
  //
  // The customer device is the only place a microphone is sent to the AI; the
  // The salesperson never publishes to the AI, so salesperson speech can
  // never enter the customer -> AI pipeline.
  // -------------------------------------------------------------------------

  /**
   * Requests a genuinely new AI call and connects a new AI session.
   *
   * Replacement is the supported recovery path: AI calls are finite, the
   * transport has no reconnect API, and a join URL belongs to one call. The
   * server's cached call is never reused after a failure.
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
    if (!options.replace && this.aiVoice && this.ai.connected) {
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
        `${this.apiBase}/api/sessions/${encodeURIComponent(this.options.sessionId)}/ai-call`,
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
        /** Same-origin audio upload URL minted by the server. */
        aiSocketUrl?: string;
        isReused?: boolean;
      };
      if (!call.callId || !call.aiSocketUrl) {
        throw new Error('The server returned an incomplete AI call.');
      }
      if (generation !== this.aiGeneration) return;

      this.log(`New AI call created (${String(call.callId).slice(0, 8)}).`);
      const session = this.createAiSession();
      this.aiVoice = session;
      this.aiEverConnected = false;
      this.aiConnectedSince = null;
      this.setAi({
        state: 'connecting',
        status: AiSessionStatus.CONNECTING,
        connected: false,
        error: null,
        callId: call.callId,
        audioReachingAi: false,
        lastEventAt: Date.now(),
      });

      const isStale = () => generation !== this.aiGeneration || this.aiVoice !== session;

      session.addEventListener('status', () => {
        if (isStale()) return; // a previous session must not change this state
        const status = session.status;
        if (status === AiSessionStatus.DISCONNECTED) {
          this.failAiSession(
            generation,
            'closed',
            this.aiEverConnected
              ? 'The AI session ended (the provider closed the session).'
              : 'The AI session closed before it connected.'
          );
          return;
        }
        if (status === AiSessionStatus.DISCONNECTING) {
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
          if (status === AiSessionStatus.LISTENING || status === AiSessionStatus.IDLE) {
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
      session.joinCall(call.aiSocketUrl);
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
      ? (this.ai.status as AiSessionStatus)
      : this.ai.state;
    this.aiError = this.ai.error;
    this.emit();
    // AI state is owned by the server bridge now: nothing is reported from the
    // browser. `options` is kept for call-site compatibility.
    void options;
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
      activity:
        state === 'connected'
          ? this.ai.activity === 'generating'
            ? 'generating'
            : 'listening'
          : state === 'error'
            ? 'error'
            : state === 'off' || state === 'disconnected' || state === 'closed'
              ? 'idle'
              : 'connecting',
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
  private leaveAiSession(session: AiVoiceSession): void {
    void Promise.race([
      Promise.resolve()
        .then(() => session.leaveCall())
        .catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, AI_LEAVE_TIMEOUT_MS)),
    ]);
  }

  private async teardownAiSession(reason: string): Promise<void> {
    this.clearAiConnectTimer();
    const session = this.aiVoice;
    this.aiVoice = null;
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
    const session = this.aiVoice;
    // Invalidate first: DISCONNECTED always follows an error event, and it must
    // not start a second recovery for the same failure.
    this.aiGeneration += 1;
    this.aiVoice = null;
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
   * salesperson asks the server over signaling because only the customer
   * device holds the AI session and the microphone.
   */
  async retryAi(): Promise<void> {
    if (this.options.role !== 'customer') {
      this.requestAiReconnect();
      return;
    }
    this.aiRecoveryAttempt = 0;
    this.clearAiRecoveryTimer();
    this.log('Manual AI restart requested; a brand new AI call will be created.');
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
      this.lastError = 'Could not ask the server to restart the AI: signaling is not connected.';
      this.log(this.lastError);
      this.emit();
      return;
    }
    this.aiReconnectRequestedAt = Date.now();
    this.log('Asked the server to create a fresh AI session.');
    this.emit();
  }

  private async stopAi(): Promise<void> {
    // Invalidate every callback from the session being stopped before waiting.
    this.aiGeneration += 1;
    this.clearAiRecoveryTimer();
    this.clearAiConnectTimer();
    this.aiRecoveryAttempt = 0;
    this.aiConnectedSince = null;
    const session = this.aiVoice;
    this.aiVoice = null;
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
    };

    if (pc) {
      try {
        const stats = await pc.getStats();
        const candidates = new Map<string, any>();
        let pair: any = null;

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
          }
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            next.bytesSent = report.bytesSent ?? 0;
          }
          if (report.type === 'transport') {
            next.dtlsState = report.dtlsState ?? 'unknown';
          }
        });

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
        dtlsState: this.dtlsState,
      },
    });
  }
}

