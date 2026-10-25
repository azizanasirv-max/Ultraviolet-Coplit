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
import { ApiError, getIceConfig, IceConfigResponse } from './sessionApi';

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
  aiStatus: UltravoxSessionStatus | 'off' | 'error';
  aiError: string | null;
  suggestions: SuggestionCard[];
  customerSpeech: string;
  reconnectAttempt: number;
  lastError: string | null;
  lastServerError: string | null;
  /** True once the session-authenticated ICE payload was applied. */
  iceConfigLoaded: boolean;
  iceConfigError: string | null;
  iceConfigWarnings: string[];
  turnConfigured: boolean;
  turnCredentialMode: 'ephemeral' | 'static' | 'none';
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
  /** Customer only: start the Ultravox AI session after joining. */
  enableAi?: boolean;
  /** Notified when the server rotates/returns the resume token. */
  onResumeToken?: (token: string) => void;
}

const RECONNECT_BASE_DELAY_MS = 800;
const RECONNECT_MAX_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 8;
const JOIN_ACK_TIMEOUT_MS = 10000;
const MAX_LOGS = 140;

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

  // Lifecycle flags
  private started = false;
  private stopped = false;
  private intentionalLeave = false;
  private connecting = false;
  private joinedThisSocket = false;
  private makingOffer = false;
  private audioUnlocked = false;
  private aiStarting = false;
  private pcGeneration = 0;
  private recoveryInFlight = false;

  // Timers
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private joinTimeout: number | null = null;
  private statsTimer: number | null = null;
  private reportTimer: number | null = null;
  private micRecoveryTimer: number | null = null;

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
  private suggestions: SuggestionCard[] = [];
  private customerSpeech = '';
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
  };
  private lastStats: { at: number; bytesSent: number; bytesReceived: number } | null = null;

  constructor(options: CallEngineOptions) {
    this.options = options;
    this.apiBase = options.apiBase ?? '';
    this.resumeToken = options.resumeToken ?? null;
    this.silentClip = silentClipUrl();
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
      suggestions: this.suggestions,
      customerSpeech: this.customerSpeech,
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
      mediaFlowing: this.lastMediaAt > 0 && Date.now() - this.lastMediaAt < 5000,
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

    this.startDiagnosticsLoop();
    this.connectSignaling(false);
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
    this.closePeerConnection(`stop: ${reason}`);
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
   * connection exists. Returns false when the deployment configuration cannot
   * be applied (for example relay-only mode without a usable TURN relay).
   */
  private async loadIceConfig(): Promise<boolean> {
    try {
      const config = await getIceConfig(this.options.sessionId, this.options.credential);
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

      if (this.iceConfig.errors.length > 0 && this.iceConfig.iceTransportPolicy === 'relay') {
        this.lastError =
          this.iceConfig.errors[0] ||
          'Relay-only ICE was requested but no usable TURN relay is configured.';
        return false;
      }
      return true;
    } catch (err) {
      const apiError = err as ApiError;
      const detail =
        apiError?.code === 'TURN_MISCONFIGURED'
          ? apiError.message
          : `ICE configuration request failed: ${(err as Error)?.message || err}`;
      this.iceConfigLoaded = false;
      this.iceConfigError = detail;
      this.lastError = detail;
      this.log(`ICE configuration unavailable; refusing to start with unverified ICE settings. ${detail}`);
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

    const track = this.localStream?.getAudioTracks()[0];
    if (track) {
      // Keep the diagnostics view truthful immediately, not at the next sample.
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
      const senders = this.pc.getSenders().filter((sender) => sender.track?.kind === 'audio');
      if (senders.length === 0) {
        this.pc.addTrack(track, stream as MediaStream);
      } else {
        for (const sender of senders) await sender.replaceTrack(track);
      }
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

  private closePeerConnection(reason: string): void {
    this.pcGeneration += 1;
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        // The sender tracks belong to this.localStream and may be reused by the
        // next peer connection, so they are stopped only in releaseLocalMedia().
        pc.close();
      } catch {
        // Ignore close errors.
      }
      this.log(`Closed peer connection (${reason}).`);
    }
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
    const track = stream?.getAudioTracks()[0];
    if (stream && track) {
      pc.addTrack(track, stream);
      track.enabled = !this.micMuted;
      this.log('Added local microphone track to the peer connection.');
    } else {
      this.log('No live microphone track available at peer connection creation.');
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
        this.callState = 'connected';
        this.emit();
        void this.resumePlayback();
      } else if (pc.connectionState === 'connecting') {
        this.callState = 'connecting';
        this.emit();
      } else if (pc.connectionState === 'disconnected') {
        this.callState = 'disconnected';
        this.emit();
      } else if (pc.connectionState === 'failed') {
        this.callState = 'failed';
        this.emit();
        void this.attemptIceRestart();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      this.log(`ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') void this.attemptIceRestart();
    };

    pc.ontrack = (event) => {
      if (this.pc !== pc || this.pcGeneration !== generation) return;
      this.log(`Received remote ${event.track.kind} track from ${peer.role}.`);
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.remoteStream = remote;
      this.remoteTrackState = 'live';
      this.attachRemoteStream(remote);
      this.emit();

      event.track.onmute = () => {
        this.remoteTrackState = 'live';
        this.log('Remote audio track muted (no media arriving yet).');
        this.emit();
      };
      event.track.onunmute = () => {
        this.remoteTrackState = 'live';
        this.log('Remote audio track unmuted (media arriving).');
        this.emit();
      };
      event.track.onended = () => {
        this.remoteTrackState = 'ended';
        this.log('Remote audio track ended.');
        this.emit();
      };
    };
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
    if (this.makingOffer) {
      this.log('Offer skipped: another offer is being negotiated.');
      return;
    }
    if (pc.signalingState !== 'stable') {
      this.log(`Offer skipped: signalingState is "${pc.signalingState}".`);
      return;
    }

    this.makingOffer = true;
    try {
      const offer = await pc.createOffer(options.iceRestart ? { iceRestart: true } : undefined);
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (!pc.localDescription) return;
      const sent = this.sendSignal({ type: 'offer', offer: pc.localDescription });
      this.log(
        `${options.iceRestart ? 'ICE-restart offer' : 'Offer'} ${sent ? 'sent' : 'not sent (signaling unavailable)'}${options.reason ? ` [${options.reason}]` : ''}.`
      );
    } catch (err) {
      this.log(`Failed to create/send offer: ${(err as Error)?.message || err}`);
    } finally {
      this.makingOffer = false;
    }
  }

  private async attemptIceRestart(): Promise<void> {
    if (!this.pc || this.options.role !== 'salesperson') return;
    this.log('Attempting ICE restart after a failed connection.');
    await this.makeOffer({ iceRestart: true, reason: 'ICE failure' });
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

    if (wasReconnect) this.closePeerConnection('rejoin negotiation reset');

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
      void this.startAi();
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
      this.peerParticipantId = null;
      this.peerRole = null;
      this.remoteTrackState = 'none';
      this.callState = 'waiting';
      return;
    }

    const pc = this.pc;
    if (
      !options.forceRecreate &&
      this.peerParticipantId === counterpart.participantId &&
      pc &&
      pc.connectionState !== 'failed' &&
      pc.connectionState !== 'closed'
    ) {
      this.log(`Presence refreshed (${source}); keeping the existing peer connection.`);
      this.peerRole = counterpart.role;
      if (this.options.role === 'salesperson' && pc.connectionState !== 'connected') {
        void this.makeOffer({ reason: `presence refresh: ${source}` });
      }
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
      this.peerParticipantId = null;
      this.peerRole = null;
      this.remoteTrackState = 'none';
      this.callState = 'waiting';
      this.participants = Array.isArray(data.participants) ? data.participants : [];
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

    if (type === 'answer') {
      if (this.options.role !== 'salesperson') return;
      const answer = data.answer;
      if (!answer || typeof answer.sdp !== 'string') {
        this.log('Ignoring answer without SDP.');
        return;
      }
      const pc = this.pc;
      if (!pc) return;
      if (pc.signalingState !== 'have-local-offer') {
        this.log(`Ignoring answer in signalingState="${pc.signalingState}" (duplicate or stale).`);
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushPendingIceCandidates();
        this.log('Answer applied.');
      } catch (err) {
        this.log(`Failed to apply answer: ${(err as Error)?.message || err}`);
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
      this.emit();
      return;
    }

    if (type === 'customer_speech_transcript') {
      if (this.options.role !== 'salesperson') return;
      this.customerSpeech = typeof data.text === 'string' ? data.text : '';
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

  private async startAi(): Promise<void> {
    if (this.options.role !== 'customer' || this.ultravox || this.aiStarting) return;
    this.aiStarting = true;
    try {
      this.log('Requesting the session AI call from the server...');
      const response = await fetch(`${this.apiBase}/api/sessions/${encodeURIComponent(this.options.sessionId)}/ultravox-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.credential}`,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.message || `AI call request failed (HTTP ${response.status})`);
      }

      const call = (await response.json()) as { callId: string; joinUrl: string; isReused: boolean };
      this.log(`AI call ${call.isReused ? 'reused' : 'created'} (${String(call.callId).slice(0, 8)}).`);

      const session = new UltravoxSession();
      this.ultravox = session;
      this.aiStatus = UltravoxSessionStatus.CONNECTING;
      this.aiError = null;
      this.emit();

      session.addEventListener('status', () => {
        const status = session.status;
        this.aiStatus = status;
        this.log(`AI session status: ${status}`);
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
        this.emit();
      });

      session.addEventListener('transcripts', () => {
        const timestamp = new Date().toLocaleTimeString();
        for (const transcript of session.transcripts) {
          if (transcript.speaker === Role.AGENT && transcript.text.trim()) {
            this.sendSignal({
              type: 'ai_suggestion',
              text: transcript.text,
              isFinal: transcript.isFinal,
              ordinal: transcript.ordinal,
              timestamp,
            });
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
            this.emit();
          }
        }
      });

      session.addEventListener('error', (event) => {
        const error = (event as unknown as { error?: Error }).error;
        this.aiStatus = 'error';
        this.aiError = error?.message || 'AI session ended unexpectedly.';
        this.log(`AI session error: ${this.aiError}`);
        this.emit();
      });

      session.joinCall(call.joinUrl);
    } catch (err) {
      this.aiStatus = 'error';
      this.aiError = (err as Error)?.message || 'AI setup failed.';
      this.log(`AI setup failed: ${this.aiError}`);
      this.emit();
    } finally {
      this.aiStarting = false;
    }
  }

  /** Retries AI startup without disturbing the human-to-human audio path. */
  async retryAi(): Promise<void> {
    await this.stopAi();
    this.aiStatus = 'off';
    this.aiError = null;
    this.emit();
    await this.startAi();
  }

  private async stopAi(): Promise<void> {
    const session = this.ultravox;
    this.ultravox = null;
    if (!session) return;
    // leaveCall() can wait on a transport that never connected, which must never
    // delay leaving the human call.
    void Promise.resolve()
      .then(() => session.leaveCall())
      .catch(() => undefined);
    this.aiStatus = 'off';
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
        reconnectAttempt: this.reconnectAttempt,
        candidates: this.diagnostics.candidates,
        iceConfigLoaded: this.iceConfigLoaded,
        turnConfigured: this.iceConfig.turn.configured,
        turnCredentialMode: this.iceConfig.turn.credentialMode,
        relayCandidates: this.candidateTypes.relay,
        mediaFlowing: this.lastMediaAt > 0 && Date.now() - this.lastMediaAt < 5000,
        dtlsState: this.dtlsState,
      },
    });
  }
}

