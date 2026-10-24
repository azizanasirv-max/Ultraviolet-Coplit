import React, { useState, useEffect, useRef } from 'react';
import { UltravoxSession, UltravoxSessionStatus, Role, Medium } from 'ultravox-client';
import { buildCustomerInviteUrl, isAistudioDevPreview } from '../lib/inviteUrl';
import {
  Mic,
  Square,
  Copy,
  Check,
  AlertCircle,
  Radio,
  Share2,
  Users,
  Send,
  Sparkles,
  ExternalLink,
  Volume2,
  VolumeX,
  ShieldCheck,
  PhoneCall,
  PhoneOff,
  RefreshCw,
} from 'lucide-react';

interface SuggestionCard {
  id: string;
  ordinal: number;
  text: string;
  isFinal: boolean;
  timestamp: string;
}

type ParticipantRole = 'customer' | 'salesperson';

/** WebSocket signaling transport state (independent from media state). */
type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** Actual audio/peer-connection state shown to the user. */
type CallStatus =
  | 'idle'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed'
  | 'mic_denied'
  | 'rejected';

interface PeerInfo {
  participantId: string;
  role: ParticipantRole;
  joinedAt?: number;
}

interface PendingIceCandidate {
  candidate: RTCIceCandidateInit;
  from: string | null;
  sessionId: string | null;
}

/**
 * Fallback ICE configuration. The live configuration is fetched from
 * `/api/ice-config` because a deployment may provide a TURN relay; without a
 * TURN server the peer-to-peer call can only work when both devices can reach
 * each other directly (never across carrier-grade NAT / mobile data).
 */
const DEFAULT_RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

/**
 * A silent WAV generated at runtime. Playing this inside the "Join" click
 * handler unlocks the remote-audio element on browsers that require a user
 * gesture per media element (notably iOS Safari). The clip loops so the element
 * is already in a playing state when the real MediaStream is attached later.
 */
let silentClipUrl: string | null = null;
const getSilentClipUrl = (): string => {
  if (silentClipUrl) return silentClipUrl;
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
  new Uint8Array(buffer, 44).fill(128); // 8-bit PCM silence
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  silentClipUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return silentClipUrl;
};

interface IceConfigResponse {
  iceServers: RTCIceServer[];
  hasTurn: boolean;
  hasStun: boolean;
  iceTransportPolicy?: RTCIceTransportPolicy;
}

interface PeerDiagnostics {
  signaling: WsStatus;
  peerId: string | null;
  peerRole: ParticipantRole | null;
  pcState: string;
  iceState: string;
  iceGatheringState: string;
  candidates: { host: number; srflx: number; relay: number };
  selectedLocalType: string;
  selectedRemoteType: string;
  bytesSent: number;
  bytesReceived: number;
  sendBitrateKbps: number;
  receiveBitrateKbps: number;
  localTrack: string;
  remoteTracks: number;
  audioPaused: boolean;
  audioMuted: boolean;
  audioCurrentTime: number;
  audioSrcAttached: boolean;
  hasTurn: boolean;
  relayPath: boolean;
  updatedAt: string;
}

const RECONNECT_BASE_DELAY_MS = 800;
const RECONNECT_MAX_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 8;
const JOIN_ACK_TIMEOUT_MS = 10000;

/**
 * Deterministic session identifier for a pair of participants. Both sides
 * compute the same value, so stale signaling from an earlier peer connection
 * can be rejected after a reconnect or participant replacement.
 */
const buildSessionId = (a: string | null, b: string | null): string | null =>
  a && b ? [a, b].sort().join('|') : null;

const hasLiveAudioTrack = (stream: MediaStream | null): boolean =>
  Boolean(stream && stream.getAudioTracks().some((track) => track.readyState === 'live'));

/**
 * Extracts the ICE ufrag/pwd pair from an SDP. A repeated offer for the same
 * peer connection keeps these values; a genuine ICE restart changes them.
 */
const iceCredentials = (sdp: string | null): string | null => {
  if (!sdp) return null;
  const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/);
  const pwd = sdp.match(/a=ice-pwd:([^\r\n]+)/);
  return ufrag && pwd ? `${ufrag[1]}|${pwd[1]}` : null;
};

interface CallStatusMeta {
  label: string;
  tone: 'emerald' | 'amber' | 'red' | 'slate';
}

const CALL_STATUS_META: Record<CallStatus, CallStatusMeta> = {
  idle: { label: 'Not Connected', tone: 'slate' },
  waiting: { label: 'Waiting for Peer...', tone: 'amber' },
  connecting: { label: 'Connecting Audio...', tone: 'amber' },
  connected: { label: 'P2P Audio Connected', tone: 'emerald' },
  disconnected: { label: 'Peer Disconnected', tone: 'red' },
  reconnecting: { label: 'Reconnecting Signaling...', tone: 'amber' },
  failed: { label: 'Connection Failed', tone: 'red' },
  mic_denied: { label: 'Microphone Blocked', tone: 'red' },
  rejected: { label: 'Join Rejected', tone: 'red' },
};

const STATUS_TONE_CLASS: Record<CallStatusMeta['tone'], string> = {
  emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  amber: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  red: 'bg-red-500/10 text-red-300 border-red-500/30',
  slate: 'bg-slate-800 text-slate-300 border-slate-700',
};

const DiagRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-2 border-b border-slate-800/60 py-0.5">
    <span className="text-slate-500">{label}</span>
    <span className="text-slate-200 text-right break-all">{value}</span>
  </div>
);

export const Prototype2View: React.FC = () => {
  // Navigation & Room Parameters
  // Initialize synchronously from the URL so an invitation never renders (or
  // joins) the default room for a frame before the query parameters apply.
  const [roomId, setRoomId] = useState<string>(() => {
    const roomParam = new URLSearchParams(window.location.search).get('room');
    return roomParam || 'room-101';
  });
  const [role, setRole] = useState<ParticipantRole>(() =>
    new URLSearchParams(window.location.search).get('role') === 'customer'
      ? 'customer'
      : 'salesperson'
  );
  const [isJoined, setIsJoined] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Statuses & Indicators
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
  const [callState, setCallState] = useState<CallStatus>('idle');
  const [peerPresent, setPeerPresent] = useState<boolean>(false);
  const [remoteRole, setRemoteRole] = useState<ParticipantRole | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState<boolean>(false);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [ultravoxStatus, setUltravoxStatus] = useState<UltravoxSessionStatus>(UltravoxSessionStatus.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customKey, setCustomKey] = useState<string>('');
  const [publicAppUrl, setPublicAppUrl] = useState<string | null>(null);

  // AI Suggestions & Speech
  const [aiSuggestions, setAiSuggestions] = useState<SuggestionCard[]>([]);
  const [latestSpeechText, setLatestSpeechText] = useState<string>('');
  const [salesContextInput, setSalesContextInput] = useState<string>('');
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [iceInfo, setIceInfo] = useState<{ hasTurn: boolean; hasStun: boolean }>({
    hasTurn: false,
    hasStun: true,
  });
  const [diagnostics, setDiagnostics] = useState<PeerDiagnostics | null>(null);

  // Logs
  const [logs, setLogs] = useState<string[]>([]);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const ultravoxRef = useRef<UltravoxSession | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const rtcConfigRef = useRef<RTCConfiguration>(DEFAULT_RTC_CONFIGURATION);
  const iceCandidateTypesRef = useRef({ host: 0, srflx: 0, relay: 0 });
  const diagnosticsRef = useRef<PeerDiagnostics | null>(null);
  const lastStatsRef = useRef<{ at: number; bytesSent: number; bytesReceived: number } | null>(null);
  const audioUnlockedRef = useRef<boolean>(false);
  const micRecoveryInFlightRef = useRef<boolean>(false);
  const micRecoveryTimerRef = useRef<number | null>(null);

  // Lifecycle & negotiation refs
  const mountedRef = useRef<boolean>(true);
  const intentionalLeaveRef = useRef<boolean>(false);
  const supersededRef = useRef<boolean>(false);
  const connectingRef = useRef<boolean>(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const joinTimeoutRef = useRef<number | null>(null);
  const joinedThisSocketRef = useRef<boolean>(false);
  const participantIdRef = useRef<string | null>(null);
  const resumeTokenRef = useRef<string | null>(null);
  const remoteParticipantIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingIceCandidatesRef = useRef<PendingIceCandidate[]>([]);
  const lastRemoteOfferSdpRef = useRef<string | null>(null);
  const makingOfferRef = useRef<boolean>(false);
  const pcGenerationRef = useRef<number>(0);
  const iceRestartAttemptsRef = useRef<number>(0);
  const roomIdRef = useRef<string>(roomId);
  const roleRef = useRef<ParticipantRole>(role);
  const joinedRef = useRef<boolean>(isJoined);

  // Keep refs in sync with render state for use inside long-lived socket/pc callbacks.
  roomIdRef.current = roomId;
  roleRef.current = role;
  joinedRef.current = isJoined;

  const displayStatus: CallStatusMeta =
    playbackBlocked && callState === 'connected'
      ? { label: 'Remote Audio Blocked', tone: 'red' }
      : CALL_STATUS_META[callState];

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    console.log(formatted);
    setLogs((prev) => [...prev.slice(-30), formatted]);
  };

  /**
   * Unlocks the remote-audio element while the user gesture is still active.
   *
   * Browsers that require a gesture per media element (iOS Safari in
   * particular) reject a play() call issued later from an async `ontrack`
   * handler, which silently produces "connected but no audio". Priming the
   * element here makes the later swap to the real MediaStream audible.
   */
  const unlockRemoteAudio = async () => {
    const el = remoteAudioRef.current;
    if (!el) return;
    el.muted = false;
    el.volume = 1;
    try {
      // Always re-prime when no remote stream is attached yet (for example when
      // rejoining a room after the previous peer connection was closed).
      if (!el.srcObject) {
        el.src = getSilentClipUrl();
        el.loop = true;
        el.load();
      }
      await el.play();
      audioUnlockedRef.current = true;
      addLog('Remote audio element unlocked by user gesture.');
    } catch (err: any) {
      addLog(`Remote audio unlock rejected: ${err?.name || 'Error'} - ${err?.message || err}`);
    }
  };

  /** Attaches the peer's MediaStream to the audio element and starts playback. */
  const attachRemoteStream = (stream: MediaStream) => {
    const el = remoteAudioRef.current;
    if (!el) {
      addLog('Remote audio element is not mounted; cannot play remote stream.');
      return;
    }
    el.muted = false;
    el.volume = 1;
    el.loop = false;
    if (el.src) {
      // An explicit src (the silent unlock clip) takes precedence over srcObject
      // until it is removed.
      el.pause();
      el.removeAttribute('src');
    }
    el.srcObject = stream;
    el.play()
      .then(() => {
        setPlaybackBlocked(false);
        addLog('Playing remote audio stream live.');
      })
      .catch((err: any) => {
        setPlaybackBlocked(true);
        addLog(`Remote audio playback blocked: ${err?.name || 'Error'} - ${err?.message || err}`);
      });
  };

  // Load the configured public deployment URL (APP_URL) for customer invites
  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.publicAppUrl) setPublicAppUrl(data.publicAppUrl);
      })
      .catch(() => {
        // Invitation links fall back to the current origin when config is unavailable.
      });
  }, []);

  // Load the deployment's ICE servers (STUN/TURN) for the human-to-human call.
  // TURN is what makes the call work when the two devices are on different
  // networks and no direct path exists.
  useEffect(() => {
    let cancelled = false;
    const applyIceConfig = (payload: Partial<IceConfigResponse> | null) => {
      if (cancelled || !payload) return;
      if (Array.isArray(payload.iceServers) && payload.iceServers.length > 0) {
        rtcConfigRef.current = {
          iceServers: payload.iceServers,
          iceTransportPolicy: payload.iceTransportPolicy ?? 'all',
        };
      }
      setIceInfo({ hasTurn: Boolean(payload.hasTurn), hasStun: payload.hasStun !== false });
    };

    fetch('/api/ice-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => applyIceConfig(data))
      .catch(() => {
        // Fall back to the built-in STUN-only configuration.
        applyIceConfig(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup on unmount: always close the socket, cancel timers and release media.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardownSession(true, 'component unmount');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser connectivity: wait for `online` instead of spinning a tight retry loop.
  useEffect(() => {
    const handleOffline = () => {
      addLog('Browser went offline.');
      if (joinedRef.current && !intentionalLeaveRef.current) {
        setWsStatus('reconnecting');
        setCallState('reconnecting');
      }
    };

    const handleOnline = () => {
      addLog('Browser is back online.');
      if (!joinedRef.current || intentionalLeaveRef.current || !mountedRef.current) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      clearReconnectTimer();
      // Use the next scheduled attempt if one exists; otherwise retry now.
      if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        connectSignaling(true);
      }
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Media diagnostics
  //
  // The two-device failure mode this reports on is "connected but silent": the
  // connection state alone cannot distinguish a blocked autoplay element from a
  // muted microphone track or from RTP that never arrives. These counters can.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    (window as any).__p2pDiagnostics = () => diagnosticsRef.current;
  }, []);

  useEffect(() => {
    if (!isJoined) {
      diagnosticsRef.current = null;
      setDiagnostics(null);
      return;
    }

    let cancelled = false;
    let running = false;

    const tick = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        const pc = pcRef.current;
        const el = remoteAudioRef.current;
        const next: PeerDiagnostics = {
          signaling: wsStatus,
          peerId: remoteParticipantIdRef.current,
          peerRole: remoteRole,
          pcState: pc?.connectionState ?? 'none',
          iceState: pc?.iceConnectionState ?? 'none',
          iceGatheringState: pc?.iceGatheringState ?? 'none',
          candidates: { ...iceCandidateTypesRef.current },
          selectedLocalType: 'none',
          selectedRemoteType: 'none',
          bytesSent: 0,
          bytesReceived: 0,
          sendBitrateKbps: 0,
          receiveBitrateKbps: 0,
          localTrack: 'none',
          remoteTracks: 0,
          audioPaused: el ? el.paused : true,
          audioMuted: el ? el.muted : true,
          audioCurrentTime: el ? Number(el.currentTime.toFixed(2)) : 0,
          audioSrcAttached: Boolean(el?.srcObject),
          hasTurn: iceInfo.hasTurn,
          relayPath: false,
          updatedAt: new Date().toLocaleTimeString(),
        };

        const localTrack = localStreamRef.current?.getAudioTracks()[0];
        if (localTrack) {
          next.localTrack = `${localTrack.readyState}/${localTrack.enabled ? 'enabled' : 'disabled'}/${
            localTrack.muted ? 'muted' : 'live'
          }`;
        }

        if (pc) {
          next.remoteTracks = pc.getReceivers().filter((receiver) => receiver.track?.kind === 'audio').length;
          try {
            const stats = await pc.getStats();
            const candidates = new Map<string, any>();
            let pair: any = null;
            stats.forEach((report) => {
              if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                candidates.set(report.id, report);
              }
            });
            stats.forEach((report) => {
              if (report.type === 'candidate-pair' && (report.nominated || report.selected) && report.state === 'succeeded') {
                pair = report;
              }
              if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                next.bytesReceived = report.bytesReceived ?? 0;
              }
              if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                next.bytesSent = report.bytesSent ?? 0;
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
            const previous = lastStatsRef.current;
            if (previous) {
              const seconds = Math.max((now - previous.at) / 1000, 0.001);
              next.sendBitrateKbps = Math.round(((next.bytesSent - previous.bytesSent) * 8) / seconds / 1000);
              next.receiveBitrateKbps = Math.round(
                ((next.bytesReceived - previous.bytesReceived) * 8) / seconds / 1000
              );
            }
            lastStatsRef.current = { at: now, bytesSent: next.bytesSent, bytesReceived: next.bytesReceived };
          } catch (err: any) {
            addLog(`getStats failed: ${err?.message || err}`);
          }
        } else {
          lastStatsRef.current = null;
        }

        if (cancelled) return;
        diagnosticsRef.current = next;
        setDiagnostics(next);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isJoined, wsStatus, remoteRole, iceInfo.hasTurn]);

  // Any tap on the page is a chance to recover blocked remote audio. Kept as a
  // document-level listener because the reported failure is easy to miss.
  useEffect(() => {
    const resume = () => {
      const el = remoteAudioRef.current;
      if (el?.srcObject && el.paused) {
        el.muted = false;
        el.play()
          .then(() => {
            setPlaybackBlocked(false);
            addLog('Remote audio resumed after user interaction.');
          })
          .catch(() => {
            setPlaybackBlocked(true);
          });
      }
    };
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
    return () => {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
    };
  }, []);

  const getCustomerInviteUrl = () =>
    buildCustomerInviteUrl({
      configuredPublicUrl: publicAppUrl,
      currentOrigin: window.location.origin,
      currentPathname: window.location.pathname,
      roomId,
    });

  const handleCopyInviteLink = () => {
    navigator.clipboard.writeText(getCustomerInviteUrl());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // ---------------------------------------------------------------------------
  // Signaling & peer-connection lifecycle
  //
  // Negotiation policy: the salesperson is always the offerer, the customer is
  // always the answerer. This removes offer glare and makes duplicate offers
  // impossible by construction.
  // ---------------------------------------------------------------------------

  const sendSignal = (payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addLog('Signaling send skipped: WebSocket is not open.');
      return false;
    }
    try {
      ws.send(
        JSON.stringify({
          ...payload,
          roomId: roomIdRef.current,
          sessionId: sessionIdRef.current ?? undefined,
        })
      );
      return true;
    } catch (err: any) {
      addLog(`Signaling send failed: ${err?.message || err}`);
      return false;
    }
  };

  const clearJoinTimeout = () => {
    if (joinTimeoutRef.current !== null) {
      window.clearTimeout(joinTimeoutRef.current);
      joinTimeoutRef.current = null;
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  /** Closes the current peer connection without touching local microphone tracks. */
  const closePeerConnection = (reason: string) => {
    const pc = pcRef.current;
    pcRef.current = null;
    // Invalidate all callbacks belonging to the closed connection.
    pcGenerationRef.current += 1;
    makingOfferRef.current = false;
    pendingIceCandidatesRef.current = [];
    lastRemoteOfferSdpRef.current = null;
    remoteParticipantIdRef.current = null;
    sessionIdRef.current = null;
    iceRestartAttemptsRef.current = 0;
    setPeerPresent(false);
    setRemoteRole(null);
    setPlaybackBlocked(false);

    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.ontrack = null;
      try {
        pc.close();
      } catch (err: any) {
        addLog(`Peer connection close warning: ${err?.message || err}`);
      }
      addLog(`Peer connection closed (${reason}).`);
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  const flushPendingIceCandidates = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;

    // Drain in arrival order. Candidates that arrive while we are awaiting
    // addIceCandidate() are picked up by the next loop iteration.
    while (pendingIceCandidatesRef.current.length > 0) {
      const batch = pendingIceCandidatesRef.current;
      pendingIceCandidatesRef.current = [];

      for (const entry of batch) {
        if (pcRef.current !== pc) return;
        if (entry.from && remoteParticipantIdRef.current && entry.from !== remoteParticipantIdRef.current) {
          addLog('Discarding buffered ICE candidate from a previous peer.');
          continue;
        }
        if (entry.sessionId && sessionIdRef.current && entry.sessionId !== sessionIdRef.current) {
          addLog('Discarding buffered ICE candidate from a previous negotiation session.');
          continue;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(entry.candidate));
        } catch (err: any) {
          // Do not swallow silently: a failed candidate is a real diagnostic,
          // but one bad candidate must not abort the remaining batch.
          addLog(`addIceCandidate failed (candidate discarded): ${err?.message || err}`);
        }
      }
    }
    addLog('Flushed buffered ICE candidates after remote description.');
  };

  const createPeerConnection = (peer: PeerInfo) => {
    // Candidates can arrive before the offer that creates the connection.
    // Preserve only those addressed to this new peer; discard older sessions.
    const earlyCandidates = pendingIceCandidatesRef.current.filter(
      (entry) => !entry.from || entry.from === peer.participantId
    );

    // Never reuse a connection that belonged to a previous participant.
    closePeerConnection('replaced by new peer session');
    pendingIceCandidatesRef.current = earlyCandidates;

    const generation = pcGenerationRef.current + 1;
    pcGenerationRef.current = generation;

    addLog(`Initializing RTCPeerConnection for peer ${peer.role} (${peer.participantId.slice(0, 8)}).`);
    const iceServers = rtcConfigRef.current.iceServers ?? [];
    const turnConfigured = iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
    });
    addLog(
      `ICE configuration: ${iceServers.length} server entr${iceServers.length === 1 ? 'y' : 'ies'}, TURN ${
        turnConfigured ? 'configured' : 'NOT configured (direct paths only)'
      }.`
    );
    iceCandidateTypesRef.current = { host: 0, srflx: 0, relay: 0 };
    const pc = new RTCPeerConnection(rtcConfigRef.current);
    pcRef.current = pc;
    remoteParticipantIdRef.current = peer.participantId;
    sessionIdRef.current = buildSessionId(participantIdRef.current, peer.participantId);
    setPeerPresent(true);
    setRemoteRole(peer.role);
    setCallState('connecting');

    const localStream = localStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      addLog('Added local microphone track to WebRTC P2P connection.');
    } else {
      addLog('No local microphone stream available while creating peer connection.');
    }

    pc.onicecandidate = (event) => {
      if (pcRef.current !== pc || pcGenerationRef.current !== generation) return;
      if (event.candidate) {
        const type = event.candidate.type;
        if (type === 'host' || type === 'srflx' || type === 'relay') {
          iceCandidateTypesRef.current[type] += 1;
        }
        sendSignal({ type: 'ice_candidate', candidate: event.candidate });
      } else {
        const gathered = iceCandidateTypesRef.current;
        addLog(
          `ICE gathering complete: host=${gathered.host}, srflx=${gathered.srflx}, relay=${gathered.relay}.`
        );
        if (gathered.relay === 0) {
          addLog(
            'No relay candidate was gathered: the peer-to-peer audio can only connect when both devices can reach each other directly (no TURN server configured).'
          );
        }
      }
    };

    pc.onicecandidateerror = (event: any) => {
      if (pcRef.current !== pc || pcGenerationRef.current !== generation) return;
      addLog(
        `ICE server error (${event?.url || 'unknown'}): ${event?.errorCode || ''} ${event?.errorText || ''}`.trim()
      );
    };

    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc || pcGenerationRef.current !== generation) return;

      addLog(`WebRTC P2P Connection State: ${pc.connectionState}`);
      switch (pc.connectionState) {
        case 'connected':
          setCallState('connected');
          setPeerPresent(true);
          // Autoplay may have been blocked before the connection completed.
          if (remoteAudioRef.current?.srcObject && remoteAudioRef.current.paused) {
            remoteAudioRef.current.muted = false;
            remoteAudioRef.current
              .play()
              .then(() => setPlaybackBlocked(false))
              .catch(() => setPlaybackBlocked(true));
          }
          break;
        case 'connecting':
          setCallState('connecting');
          break;
        case 'disconnected':
          setCallState('disconnected');
          break;
        case 'failed':
          setCallState('failed');
          setPeerPresent(false);
          void attemptIceRestart();
          break;
        case 'closed':
          setCallState((prev) => (prev === 'idle' ? prev : 'disconnected'));
          break;
        default:
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pcRef.current !== pc || pcGenerationRef.current !== generation) return;
      addLog(`ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        void attemptIceRestart();
      }
    };

    pc.ontrack = (event) => {
      if (pcRef.current !== pc || pcGenerationRef.current !== generation) return;
      addLog(`Received remote audio track from peer (${event.track.kind}).`);
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      attachRemoteStream(stream);

      // A remote track that mutes/unmutes mid-call explains "connected silence"
      // far better than the connection state does, so surface it.
      event.track.onmute = () => addLog('Remote audio track muted (no media arriving).');
      event.track.onunmute = () => addLog('Remote audio track unmuted (media arriving).');
      event.track.onended = () => addLog('Remote audio track ended.');
    };

    return pc;
  };

  const makeOffer = async (options: { iceRestart?: boolean; reason?: string } = {}) => {
    const pc = pcRef.current;
    const remoteId = remoteParticipantIdRef.current;

    if (!pc || !remoteId) {
      addLog('Offer skipped: no active peer connection.');
      return;
    }
    if (roleRef.current !== 'salesperson') {
      addLog('Offer skipped: customer is the answerer in this negotiation policy.');
      return;
    }
    if (makingOfferRef.current) {
      addLog('Offer skipped: another offer is already being negotiated.');
      return;
    }
    if (pc.signalingState !== 'stable') {
      addLog(`Offer skipped: signalingState is "${pc.signalingState}".`);
      return;
    }

    makingOfferRef.current = true;
    try {
      const offer = await pc.createOffer(options.iceRestart ? { iceRestart: true } : undefined);
      if (pcRef.current !== pc) {
        addLog('Offer aborted: peer connection was replaced during negotiation.');
        return;
      }
      await pc.setLocalDescription(offer);
      const description = pc.localDescription;
      if (!description) {
        addLog('Offer aborted: local description was not created.');
        return;
      }
      const sent = sendSignal({ type: 'offer', offer: description });
      addLog(
        `${options.iceRestart ? 'ICE-restart offer' : 'WebRTC offer'} ${
          sent ? 'sent' : 'not sent (signaling unavailable)'
        }${options.reason ? ` [${options.reason}]` : ''}.`
      );
    } catch (err: any) {
      addLog(`Failed to create/send WebRTC offer: ${err?.message || err}`);
    } finally {
      makingOfferRef.current = false;
    }
  };

  const attemptIceRestart = async () => {
    const pc = pcRef.current;
    if (!pc || roleRef.current !== 'salesperson' || !remoteParticipantIdRef.current) {
      setCallState('failed');
      return;
    }
    if (iceRestartAttemptsRef.current >= 1) {
      addLog('ICE restart already attempted; waiting for a manual retry.');
      setCallState('failed');
      return;
    }
    iceRestartAttemptsRef.current += 1;
    addLog('Connection failed; attempting one ICE restart.');
    await makeOffer({ iceRestart: true, reason: 'ice failure recovery' });
  };

  /**
   * Replaces the track the peer connection is sending with a freshly captured
   * microphone track. Used when the browser mutes/ends the original track,
   * which happens on mobile when a second capture (the Ultravox AI session on
   * the customer device) takes over the microphone.
   */
  const recoverP2PAudioTrack = async (reason: string) => {
    if (micRecoveryInFlightRef.current) return;
    const pc = pcRef.current;
    if (!pc) return;

    micRecoveryInFlightRef.current = true;
    try {
      addLog(`Recovering local microphone track for the peer connection (${reason})...`);
      const stream = await ensureLocalStream(true);
      const track = stream?.getAudioTracks()[0];
      if (!track) {
        addLog('Microphone recovery failed: no capture track available.');
        return;
      }
      if (pcRef.current !== pc) return;

      const audioSenders = pc.getSenders().filter((sender) => sender.track?.kind === 'audio');
      if (audioSenders.length === 0) {
        pc.addTrack(track, stream!);
        addLog('Re-attached a local microphone track after the previous one was lost.');
        return;
      }
      for (const sender of audioSenders) {
        await sender.replaceTrack(track);
      }
      addLog('Replaced the outbound microphone track on the peer connection.');
      if (roleRef.current === 'salesperson' && audioSenders.length > 0) {
        // A replacement track needs a fresh offer for the peer to accept it on
        // browsers that cannot renegotiate in place.
        void makeOffer({ reason: 'microphone track recovery' });
      }
    } catch (err: any) {
      addLog(`Microphone track recovery failed: ${err?.name || 'Error'} - ${err?.message || err}`);
    } finally {
      micRecoveryInFlightRef.current = false;
    }
  };

  /**
   * Watches the microphone track that feeds the peer connection. Silent
   * "connected but no audio" failures are caused by the browser muting or
   * ending this track after a second capture starts, so every transition is
   * logged and recoverable.
   */
  const watchLocalTrack = (stream: MediaStream) => {
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('mute', () => {
        addLog('Local microphone track was muted by the browser.');
        if (micRecoveryTimerRef.current !== null) window.clearTimeout(micRecoveryTimerRef.current);
        micRecoveryTimerRef.current = window.setTimeout(() => {
          micRecoveryTimerRef.current = null;
          if (track.muted && track.readyState === 'live') {
            void recoverP2PAudioTrack('track muted');
          }
        }, 2000);
      });
      track.addEventListener('unmute', () => {
        addLog('Local microphone track unmuted.');
        if (micRecoveryTimerRef.current !== null) {
          window.clearTimeout(micRecoveryTimerRef.current);
          micRecoveryTimerRef.current = null;
        }
      });
      track.addEventListener('ended', () => {
        addLog('Local microphone track ended by the browser.');
        void recoverP2PAudioTrack('track ended');
      });
    });
  };

  /** Acquires the microphone only when there is no reusable live track. */
  const ensureLocalStream = async (force = false): Promise<MediaStream | null> => {
    if (!force && hasLiveAudioTrack(localStreamRef.current)) {

      addLog('Reusing existing live microphone stream (no new permission prompt).');
      return localStreamRef.current;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not available in this browser context.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      setIsMuted(track ? !track.enabled : false);
      watchLocalTrack(stream);
      addLog(
        `Acquired local microphone stream for WebRTC conversation (track ${track?.readyState ?? 'missing'}${
          track?.muted ? ', muted' : ''
        }).`
      );
      return stream;
    } catch (err: any) {
      addLog(`Microphone access error: ${err?.name || 'Error'} - ${err?.message || err}`);
      setCallState('mic_denied');
      setErrorMessage(
        err?.name === 'NotAllowedError' ||
          err?.name === 'PermissionDeniedError' ||
          err?.name === 'SecurityError'
          ? 'Microphone permission denied. Please allow microphone access (or open the Standalone Tab) and retry.'
          : err?.message || 'Failed to access microphone.'
      );
      return null;
    }
  };

  const handleJoinRoom = async () => {
    setErrorMessage(null);
    intentionalLeaveRef.current = false;
    supersededRef.current = false;
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setAiSuggestions([]);
    addLog(`Joining Prototype 2 Room: "${roomId}" as Role: "${role.toUpperCase()}"`);

    // Must run synchronously inside the click gesture: this is what allows the
    // remote microphone to be played back later without a second tap.
    void unlockRemoteAudio();

    const stream = await ensureLocalStream();
    if (!stream) {
      setIsJoined(false);
      return;
    }

    setCallState('connecting');
    setWsStatus('connecting');
    setPeerPresent(false);
    setRemoteRole(null);
    setIsJoined(true);
    connectSignaling(false);
  };

  const connectSignaling = (isReconnect: boolean) => {
    if (!mountedRef.current || intentionalLeaveRef.current) return;
    if (connectingRef.current) {
      addLog('Signaling connection attempt already in progress; not opening a duplicate socket.');
      return;
    }

    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      addLog('Signaling socket is already open or connecting; skipping duplicate connection.');
      return;
    }

    clearReconnectTimer();
    connectingRef.current = true;
    joinedThisSocketRef.current = false;
    setWsStatus(isReconnect ? 'reconnecting' : 'connecting');
    if (isReconnect) setCallState('reconnecting');

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    addLog(`Connecting to WebSocket signaling: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      try {
        const data = JSON.parse(event.data);
        void handleSignal(data);
      } catch (err: any) {
        addLog(`Signaling message parse error: ${err?.message || err}`);
      }
    };

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      connectingRef.current = false;
      setWsStatus('connected');
      addLog(
        isReconnect
          ? 'Signaling reconnected. Re-joining room and confirming role authorization...'
          : 'WebSocket signaling connected. Joining room...'
      );

      ws.send(
        JSON.stringify({
          type: 'join_room',
          roomId: roomIdRef.current,
          role: roleRef.current,
          // The server only accepts this private token as proof that this is
          // the same participant reconnecting; the public participant ID is
          // not sufficient and duplicates are otherwise rejected.
          resumeToken: resumeTokenRef.current ?? undefined,
        })
      );

      clearJoinTimeout();
      joinTimeoutRef.current = window.setTimeout(() => {
        joinTimeoutRef.current = null;
        if (wsRef.current === ws && !joinedThisSocketRef.current) {
          addLog('Room join was not acknowledged in time; retrying signaling.');
          try {
            ws.close(4000, 'join_timeout');
          } catch {
            // Ignore close errors.
          }
        }
      }, JOIN_ACK_TIMEOUT_MS);
    };

    ws.onerror = () => {
      addLog('WebSocket error encountered.');
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      connectingRef.current = false;
      clearJoinTimeout();

      if (intentionalLeaveRef.current || supersededRef.current || !mountedRef.current) {
        addLog(`Signaling socket closed intentionally (code ${event.code}).`);
        return;
      }

      addLog(`Signaling socket lost unexpectedly (code ${event.code}).`);
      setWsStatus('reconnecting');
      setCallState('reconnecting');
      // Signaling is required to re-establish negotiation. The microphone is
      // kept for the reconnect window but the obsolete peer connection is not.
      closePeerConnection('signaling lost');
      setPeerPresent(false);
      setRemoteRole(null);
      scheduleReconnect();
    };
  };

  // Start the customer-side Ultravox session once per room membership. It is
  // intentionally not restarted for transient signaling reconnects.
  const startUltravoxIfNeeded = async () => {
    if (roleRef.current !== 'customer' || ultravoxRef.current) return;

    try {
      addLog('Fetching Ultravox call configuration from backend (enforces 1 call per room)...');
      const res = await fetch('/api/room/ultravox-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: roomIdRef.current, customKey }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to initialize room Ultravox session');
      }

      const callData = await res.json();
      addLog(`Ultravox Call ${callData.isReused ? 'Reused' : 'Created'}. Call ID: ${callData.callId}`);

      const ultravox = new UltravoxSession();
      ultravoxRef.current = ultravox;

      ultravox.addEventListener('status', () => {
        const status = ultravox.status;
        setUltravoxStatus(status);
        addLog(`Customer Ultravox Status: ${status}`);

        if (status === UltravoxSessionStatus.LISTENING || status === UltravoxSessionStatus.IDLE) {
          try {
            ultravox.setOutputMedium(Medium.TEXT);
            ultravox.muteSpeaker();
          } catch {
            // Ignore unsupported output-medium transitions.
          }
        }
      });

      ultravox.addEventListener('transcripts', () => {
        const rawTranscripts = ultravox.transcripts;
        const now = new Date().toLocaleTimeString();

        rawTranscripts.forEach((t) => {
          if (t.speaker === Role.AGENT && t.text.trim()) {
            // Use the current socket so suggestions keep flowing after a
            // signaling reconnect (never a captured, closed socket).
            sendSignal({
              type: 'ai_suggestion',
              text: t.text,
              isFinal: t.isFinal,
              ordinal: t.ordinal,
              timestamp: now,
            });
          } else if (t.speaker === Role.USER) {
            setLatestSpeechText(t.text);
          }
        });
      });

      ultravox.joinCall(callData.joinUrl);
    } catch (e: any) {
      addLog(`Customer Ultravox setup error: ${e?.message || e}`);
      setErrorMessage(e?.message || 'Ultravox setup failed.');
    }
  };

  const scheduleReconnect = () => {
    if (!mountedRef.current || intentionalLeaveRef.current) return;
    if (reconnectTimerRef.current !== null) {
      addLog('Reconnect is already scheduled; not creating a second loop.');
      return;
    }
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      failRecovery('Could not recover the signaling connection. Check your network and retry.');
      return;
    }

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setReconnectAttempt(attempt);

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    setWsStatus('reconnecting');
    setCallState('reconnecting');
    addLog(`Reconnecting signaling in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}).`);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!mountedRef.current || intentionalLeaveRef.current) return;
      if (!navigator.onLine) {
        addLog('Browser is offline; waiting for the online event before retrying.');
        return;
      }
      connectSignaling(true);
    }, delay);
  };

  const failRecovery = (message: string) => {
    clearReconnectTimer();
    clearJoinTimeout();
    addLog(`Signaling recovery failed: ${message}`);

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close(4000, 'recovery_failed');
      } catch {
        // Ignore close errors.
      }
    }

    closePeerConnection('recovery exhausted');
    releaseLocalMedia('unrecoverable signaling failure');
    setWsStatus('disconnected');
    setCallState('failed');
    setPeerPresent(false);
    setRemoteRole(null);
    setErrorMessage(message);
  };

  // Handle Signaling Messages
  /** Reconciles presence and (re)creates negotiation only when the peer changed. */
  const applyRoomPeers = (peers: PeerInfo[], source: string) => {
    const counterpart =
      peers.find(
        (p) => p.participantId !== participantIdRef.current && p.role !== roleRef.current
      ) ??
      peers.find((p) => p.participantId !== participantIdRef.current) ??
      null;

    if (!counterpart) {
      if (remoteParticipantIdRef.current) {
        closePeerConnection(`peer absent (${source})`);
      }
      setPeerPresent(false);
      setRemoteRole(null);
      setCallState('waiting');
      return;
    }

    const pc = pcRef.current;
    if (
      remoteParticipantIdRef.current === counterpart.participantId &&
      pc &&
      pc.connectionState !== 'failed' &&
      pc.connectionState !== 'closed'
    ) {
      addLog(`Presence refreshed (${source}); keeping the existing peer connection.`);
      setPeerPresent(true);
      setRemoteRole(counterpart.role);
      if (roleRef.current === 'salesperson' && pc.connectionState !== 'connected') {
        void makeOffer({ reason: `presence refresh: ${source}` });
      }
      return;
    }

    addLog(`Establishing a fresh peer connection for ${counterpart.role} (${source}).`);
    createPeerConnection(counterpart);
    if (roleRef.current === 'salesperson') {
      void makeOffer({ reason: source });
    }
  };

  const handleJoined = (data: any) => {
    clearJoinTimeout();
    joinedThisSocketRef.current = true;

    if (typeof data.participantId !== 'string' || !data.participantId) {
      addLog('Join acknowledgement did not include a participant ID; reconnecting.');
      try {
        wsRef.current?.close(4000, 'missing_participant_id');
      } catch {
        // Ignore close errors.
      }
      return;
    }

    const previousId = participantIdRef.current;
    const wasReconnect = Boolean(previousId) || reconnectAttemptRef.current > 0;

    participantIdRef.current = data.participantId;
    if (typeof data.resumeToken === 'string') {
      resumeTokenRef.current = data.resumeToken;
    }
    if (wasReconnect) {
      // The server issues a new participant ID per connection, so the old
      // negotiation session is always obsolete after a reconnect.
      closePeerConnection('rejoin negotiation reset');
    }

    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setWsStatus('connected');
    setErrorMessage(null);
    addLog(
      `Room membership confirmed as ${data.role} (${String(data.participantId).slice(0, 8)})${
        wasReconnect ? ' after reconnect' : ''
      }.`
    );

    const peers: PeerInfo[] = Array.isArray(data.peers)
      ? data.peers.filter(
          (p: any) =>
            p &&
            typeof p.participantId === 'string' &&
            (p.role === 'customer' || p.role === 'salesperson')
        )
      : [];

    applyRoomPeers(peers, wasReconnect ? 'reconnect' : 'join');

    if (roleRef.current === 'customer') {
      void startUltravoxIfNeeded();
    }
  };

  const handleJoinRejected = (data: any) => {
    const code = typeof data.code === 'string' ? data.code : 'JOIN_REJECTED';
    const rejectedRole = data.role === 'customer' || data.role === 'salesperson' ? data.role : roleRef.current;
    const rejectedRoom = typeof data.roomId === 'string' ? data.roomId : roomIdRef.current;

    const message =
      code === 'ROLE_OCCUPIED'
        ? `Cannot join as ${rejectedRole}: that role is already taken in room "${rejectedRoom}". The existing conversation was not interrupted.`
        : code === 'ROOM_FULL'
          ? `Cannot join room "${rejectedRoom}": it already has two participants.`
          : data.message || `Join rejected (${code}).`;

    addLog(`Join rejected [${code}]: ${message}`);
    intentionalLeaveRef.current = true;
    clearReconnectTimer();
    clearJoinTimeout();
    setErrorMessage(message);
    setCallState('rejected');

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch {
        // Ignore close errors.
      }
    }

    closePeerConnection('join rejected');
    releaseLocalMedia('join rejected');
    participantIdRef.current = null;
    resumeTokenRef.current = null;
    setWsStatus('disconnected');
    setPeerPresent(false);
    setRemoteRole(null);
    setIsJoined(false);
  };

  const handlePeerJoined = (data: any) => {
    const peerId = typeof data.participantId === 'string' ? data.participantId : null;
    if (!peerId || peerId === participantIdRef.current) return;

    const peerRole: ParticipantRole =
      data.role === 'customer' || data.role === 'salesperson' ? data.role : roleRef.current === 'customer' ? 'salesperson' : 'customer';

    const peers: PeerInfo[] = Array.isArray(data.participants)
      ? data.participants.filter(
          (p: any) =>
            p &&
            typeof p.participantId === 'string' &&
            (p.role === 'customer' || p.role === 'salesperson')
        )
      : [{ participantId: peerId, role: peerRole }];

    addLog(`Peer joined room: ${peerRole} (${peerId.slice(0, 8)}).`);
    applyRoomPeers(peers, 'peer joined');
  };

  const handlePeerLeft = (data: any) => {
    const leftId = typeof data.participantId === 'string' ? data.participantId : null;

    if (leftId && remoteParticipantIdRef.current && leftId !== remoteParticipantIdRef.current) {
      addLog('Ignoring peer_left for a participant that is not the current peer.');
      return;
    }

    addLog(`Peer left the room (${data.reason || 'left'}).`);
    closePeerConnection('remote peer left');
    setPeerPresent(false);
    setRemoteRole(null);
    setCallState('waiting');
  };

  const handleRoomState = (data: any) => {
    const peers: PeerInfo[] = Array.isArray(data.peers)
      ? data.peers.filter(
          (p: any) =>
            p &&
            typeof p.participantId === 'string' &&
            (p.role === 'customer' || p.role === 'salesperson')
        )
      : [];
    addLog(`Room state received: ${peers.map((p) => p.role).join(', ') || 'no peers'}.`);
    applyRoomPeers(peers, 'room state');
  };

  const handleNegotiationSignal = async (type: string, data: any, from: string | null) => {
    if (type === 'offer') {
      if (roleRef.current !== 'customer') {
        addLog('Ignoring offer: the salesperson is the only offerer.');
        return;
      }
      if (!data.offer || typeof data.offer !== 'object') {
        addLog('Ignoring offer: missing SDP payload.');
        return;
      }

      // Under reconnect races the offer can arrive just before presence state;
      // create the answerer connection from the server-tagged sender identity.
      if (!remoteParticipantIdRef.current && from) {
        createPeerConnection({ participantId: from, role: 'salesperson' });
      }

      const pc = pcRef.current;
      if (!pc) {
        addLog('Ignoring offer: no peer connection for this participant.');
        return;
      }
      if (data.sessionId && sessionIdRef.current && data.sessionId !== sessionIdRef.current) {
        addLog('Ignoring offer from a previous negotiation session.');
        return;
      }
      const offerSdp = typeof data.offer.sdp === 'string' ? data.offer.sdp : null;
      if (offerSdp && lastRemoteOfferSdpRef.current === offerSdp) {
        addLog('Ignoring duplicate offer: identical SDP was already applied.');
        return;
      }
      if (offerSdp && pc.remoteDescription) {
        const incomingCredentials = iceCredentials(offerSdp);
        const activeCredentials = iceCredentials(pc.remoteDescription.sdp);
        if (incomingCredentials && activeCredentials && incomingCredentials === activeCredentials) {
          addLog('Ignoring duplicate offer: ICE credentials match the active session.');
          return;
        }
      }
      if (pc.signalingState !== 'stable') {
        addLog(`Ignoring duplicate offer while signalingState="${pc.signalingState}".`);
        return;
      }

      try {
        addLog('Received WebRTC offer. Creating answer...');
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        lastRemoteOfferSdpRef.current = offerSdp;
        await flushPendingIceCandidates();
        const answer = await pc.createAnswer();
        if (pcRef.current !== pc) return;
        await pc.setLocalDescription(answer);
        sendSignal({ type: 'answer', answer: pc.localDescription ?? answer });
        addLog('WebRTC answer sent.');
      } catch (err: any) {
        addLog(`Failed to apply offer/create answer: ${err?.name || 'Error'} - ${err?.message || err}`);
      }
      return;
    }

    if (type === 'answer') {
      if (roleRef.current !== 'salesperson') {
        addLog('Ignoring answer: the customer is the only answerer.');
        return;
      }
      if (!data.answer || typeof data.answer !== 'object') {
        addLog('Ignoring answer: missing SDP payload.');
        return;
      }

      const pc = pcRef.current;
      if (!pc) return;
      if (pc.signalingState !== 'have-local-offer') {
        addLog(`Ignoring answer in signalingState="${pc.signalingState}" (duplicate or stale).`);
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await flushPendingIceCandidates();
        addLog('WebRTC answer applied.');
      } catch (err: any) {
        addLog(`Failed to apply WebRTC answer: ${err?.name || 'Error'} - ${err?.message || err}`);
      }
      return;
    }

    if (type === 'ice_candidate') {
      if (!data.candidate || typeof data.candidate !== 'object') {
        addLog('Ignoring ICE candidate without a payload.');
        return;
      }

      const pc = pcRef.current;
      const entry: PendingIceCandidate = {
        candidate: data.candidate,
        from,
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
      };

      if (!pc || !pc.remoteDescription) {
        // Buffer even when the offer has not created the connection yet.
        pendingIceCandidatesRef.current.push(entry);
        addLog(
          `Buffered ICE candidate until remote description is applied (${pendingIceCandidatesRef.current.length} queued).`
        );
        return;
      }

      if (entry.from && remoteParticipantIdRef.current && entry.from !== remoteParticipantIdRef.current) {
        addLog('Discarding ICE candidate from a previous peer.');
        return;
      }

      try {
        await pc.addIceCandidate(new RTCIceCandidate(entry.candidate));
      } catch (err: any) {
        addLog(`addIceCandidate failed: ${err?.name || 'Error'} - ${err?.message || err}`);
      }
    }
  };
  const handleSignal = async (data: any) => {
    const type = data?.type;
    if (typeof type !== 'string') return;

    // Room isolation: never accept a message for a different room.
    if (data.roomId && data.roomId !== roomIdRef.current) {
      addLog(`Ignoring ${type} addressed to a different room.`);
      return;
    }

    const from = typeof data.from === 'string' ? data.from : null;
    if (from && participantIdRef.current && from === participantIdRef.current) return;

    // Stale signaling from a previous participant/session is discarded.
    if (from && remoteParticipantIdRef.current && from !== remoteParticipantIdRef.current) {
      addLog(`Ignoring stale ${type} from previous peer (${from.slice(0, 8)}).`);
      return;
    }
    if (data.sessionId && sessionIdRef.current && data.sessionId !== sessionIdRef.current) {
      addLog(`Ignoring stale ${type} from a previous negotiation session.`);
      return;
    }

    switch (type) {
      case 'joined':
        handleJoined(data);
        break;
      case 'join_rejected':
        handleJoinRejected(data);
        break;
      case 'peer_joined':
        handlePeerJoined(data);
        break;
      case 'peer_left':
        handlePeerLeft(data);
        break;
      case 'room_state':
        handleRoomState(data);
        break;
      case 'session_replaced':
        supersededRef.current = true;
        addLog('This signaling session was replaced by a newer connection.');
        break;
      case 'offer':
      case 'answer':
      case 'ice_candidate':
        await handleNegotiationSignal(type, data, from);
        break;
      case 'ai_suggestion': {
        const newCard: SuggestionCard = {
          id: `sug-${data.ordinal}-${data.isFinal ? 'final' : 'interim'}`,
          ordinal: data.ordinal,
          text: data.text,
          isFinal: data.isFinal,
          timestamp: data.timestamp || new Date().toLocaleTimeString(),
        };

        setAiSuggestions((prev) => {
          const idx = prev.findIndex((s) => s.ordinal === data.ordinal);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = newCard;
            return updated;
          }
          return [...prev, newCard];
        });
        break;
      }
      case 'peer_unavailable':
        addLog('Peer is not currently available; waiting for them to join.');
        break;
      case 'error':
        addLog(`Signaling error${data.code ? ` [${data.code}]` : ''}: ${data.message || 'unknown error'}`);
        break;
      case 'left':
        addLog('Server confirmed room departure.');
        break;
      default:
        addLog(`Unhandled signaling message type: ${type}`);
    }
  };

  /** Stops microphone capture and releases the device. */
  const releaseLocalMedia = (reason: string) => {
    if (micRecoveryTimerRef.current !== null) {
      window.clearTimeout(micRecoveryTimerRef.current);
      micRecoveryTimerRef.current = null;
    }
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore stop errors.
        }
      });
      addLog(`Released local microphone tracks (${reason}).`);
    }
    setIsMuted(false);
  };

  const teardownSession = (notifyServer: boolean, reason: string) => {
    clearReconnectTimer();
    clearJoinTimeout();
    intentionalLeaveRef.current = true;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      if (notifyServer && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'leave_room', roomId: roomIdRef.current }));
        } catch {
          // Ignore send failures; the close below still removes membership.
        }
      }
      try {
        ws.onclose = null;
        ws.close(1000, 'client_leave');
      } catch {
        // Ignore close errors.
      }
    }

    closePeerConnection(reason);
    releaseLocalMedia(reason);

    if (ultravoxRef.current) {
      ultravoxRef.current.leaveCall().catch(() => {});
      ultravoxRef.current = null;
    }

    participantIdRef.current = null;
    resumeTokenRef.current = null;
    remoteParticipantIdRef.current = null;
    sessionIdRef.current = null;
    joinedThisSocketRef.current = false;
  };

  const handleLeaveRoom = () => {
    addLog('Leaving room and tearing down WebRTC media streams...');
    teardownSession(true, 'intentional leave');
    setIsJoined(false);
    setWsStatus('disconnected');
    setCallState('idle');
    setPeerPresent(false);
    setRemoteRole(null);
    setPlaybackBlocked(false);
    setReconnectAttempt(0);
    reconnectAttemptRef.current = 0;
    setUltravoxStatus(UltravoxSessionStatus.DISCONNECTED);
  };

  /** Manual recovery after exhausted retries or a failed peer connection. */
  const handleRetry = async () => {
    if (!isJoined) {
      await handleJoinRoom();
      return;
    }

    setErrorMessage(null);
    intentionalLeaveRef.current = false;
    supersededRef.current = false;
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setCallState('connecting');
    setWsStatus('connecting');
    closePeerConnection('manual retry');

    void unlockRemoteAudio();

    const stream = await ensureLocalStream();
    if (!stream) {
      setCallState('mic_denied');
      return;
    }
    connectSignaling(false);
  };

  const handleEnableRemoteAudio = async () => {
    if (!remoteAudioRef.current) return;
    try {
      await remoteAudioRef.current.play();
      setPlaybackBlocked(false);
      addLog('Remote audio playback enabled by user gesture.');
    } catch (err: any) {
      addLog(`Remote audio could not be enabled: ${err?.message || err}`);
      setPlaybackBlocked(true);
    }
  };

  // Mute / Unmute Local Mic
  const handleToggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
        addLog(`Local microphone track ${audioTrack.enabled ? 'enabled' : 'disabled'} by user.`);
      }
    }

    // The customer device captures the microphone twice (P2P call + Ultravox AI
    // session). Muting only the P2P track would leave the AI listening, so the
    // AI input is muted with the same control.
    if (roleRef.current === 'customer' && ultravoxRef.current) {
      try {
        if (localStreamRef.current?.getAudioTracks()[0]?.enabled === false) {
          ultravoxRef.current.muteMic();
          addLog('Ultravox customer microphone muted.');
        } else {
          ultravoxRef.current.unmuteMic();
          addLog('Ultravox customer microphone unmuted.');
        }
      } catch (err: any) {
        addLog(`Ultravox mute toggle failed: ${err?.message || err}`);
      }
    }
  };

  // Send Custom Context Update to Ultravox Session
  const handleSendCustomContext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!salesContextInput.trim() || !ultravoxRef.current) return;
    try {
      ultravoxRef.current.sendText(`[Salesperson Spoke]: ${salesContextInput.trim()}`);
      addLog(`Sent custom salesperson text context to Ultravox.`);
      setSalesContextInput('');
    } catch (err: any) {
      addLog(`Failed to send context update: ${err.message}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-slate-950 text-slate-100 font-sans">
      {/*
        Remote peer audio output. Kept in the DOM and NOT display:none so that
        mobile browsers keep it eligible for playback; it is visually hidden but
        still mounted.
      */}
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        aria-hidden="true"
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />

      {/* Blocking remote-audio banner: "connected but silent" is otherwise invisible. */}
      {isJoined && playbackBlocked && (
        <div className="bg-amber-500/15 border-b border-amber-500/40 px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <VolumeX className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-xs text-amber-100">
              Your browser blocked playback of the other participant's microphone. Until you enable
              it you will not hear them even though the call is connected.
            </span>
          </div>
          <button
            onClick={handleEnableRemoteAudio}
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 shrink-0"
          >
            <Volume2 className="w-4 h-4" />
            Enable Audio
          </button>
        </div>
      )}

      {/* Error Alert */}
      {errorMessage && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-2.5 text-xs text-red-300 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400 hover:text-red-200 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {!isJoined ? (
        /* Room Join & Link Generation Setup Screen */
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="text-center space-y-1">
              <div className="inline-flex p-3 bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 rounded-2xl mb-2">
                <Users className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-bold text-slate-100">Prototype 2: Live Sales Copilot</h2>
              <p className="text-xs text-slate-400">
                P2P WebRTC Audio Call + Real-Time Streaming Ultravox AI Suggestions
              </p>
            </div>

            {/* Room ID & Role Form */}
            <div className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Interview Room ID
                </label>
                <input
                  type="text"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.trim().toLowerCase() || 'room-101')}
                  className="w-full px-3.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
                  placeholder="e.g. room-101"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Select Your Role</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRole('salesperson')}
                    className={`p-3 rounded-xl border text-center transition-all ${
                      role === 'salesperson'
                        ? 'bg-indigo-600 border-indigo-500 text-white font-bold shadow'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="text-xs">Salesperson</div>
                    <div className="text-[10px] opacity-75 font-normal">Dashboard & AI Suggestions</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRole('customer')}
                    className={`p-3 rounded-xl border text-center transition-all ${
                      role === 'customer'
                        ? 'bg-emerald-600 border-emerald-500 text-white font-bold shadow'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="text-xs">Customer</div>
                    <div className="text-[10px] opacity-75 font-normal">Invitation Join View</div>
                  </button>
                </div>
              </div>

              {/* Shareable Customer Invitation Link Generator */}
              <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
                    <Share2 className="w-3.5 h-3.5 text-cyan-400" /> Customer Invite Link
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyInviteLink}
                    className="flex items-center gap-1 text-[10px] font-semibold text-cyan-400 hover:text-cyan-300"
                  >
                    {copiedLink ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copiedLink ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
                <div className="font-mono text-[10px] text-slate-400 bg-slate-900 p-2 rounded-lg truncate border border-slate-800/80">
                  {getCustomerInviteUrl()}
                </div>
                {isAistudioDevPreview(getCustomerInviteUrl()) && (
                  <p className="text-[10px] leading-relaxed text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
                    This is an AI Studio development preview URL and requires a Google sign-in, so
                    customers cannot open it. Publish the app and set <span className="font-mono">APP_URL</span> to
                    the public deployment URL to generate a working invitation link.
                  </p>
                )}
              </div>

              {/* Join Action Button */}
              <button
                type="button"
                onClick={handleJoinRoom}
                className={`w-full py-3 text-sm font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 ${
                  role === 'salesperson'
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/20'
                }`}
              >
                <PhoneCall className="w-4 h-4" />
                {role === 'salesperson' ? 'Open Salesperson Dashboard' : 'Join Sales Call as Customer'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Active Interview View (Salesperson Dashboard or Customer Interface) */
        <div className="flex-1 flex flex-col min-h-0">
          {/* Active Call Header */}
          <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
                {role.toUpperCase()}
              </span>
              <span className="text-xs font-mono text-slate-400">
                Room: <strong className="text-slate-200">{roomId}</strong>
              </span>
            </div>

            {/* Live Connection Badges */}
            <div className="flex items-center gap-2 text-xs">
              {/* Actual WebRTC media state (never derived from socket state alone) */}
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold border ${STATUS_TONE_CLASS[displayStatus.tone]} ${
                  displayStatus.tone === 'amber' ? 'animate-pulse' : ''
                }`}
                aria-live="polite"
              >
                <Radio className="w-3 h-3" />
                {displayStatus.label}
              </span>

              <span
                className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono border ${
                  wsStatus === 'connected'
                    ? 'bg-slate-800 text-emerald-300 border-slate-700'
                    : 'bg-slate-800 text-amber-300 border-slate-700'
                }`}
                title="WebSocket signaling transport"
              >
                WS: {wsStatus}
                {wsStatus === 'reconnecting' && reconnectAttempt > 0
                  ? ` (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`
                  : ''}
              </span>

              {playbackBlocked && (
                <button
                  onClick={handleEnableRemoteAudio}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1 shadow transition-colors sm:hidden"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  Enable Audio
                </button>
              )}

              {isMuted && (
                <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase bg-red-500/15 text-red-300 border border-red-500/40">
                  Mic Muted
                </span>
              )}

              <button
                onClick={handleToggleMute}
                className={`px-3 py-1 border font-semibold rounded-lg text-xs flex items-center gap-1 shadow transition-colors ${
                  isMuted
                    ? 'bg-red-600 hover:bg-red-500 text-white border-red-500'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                }`}
                title={isMuted ? 'Unmute your microphone' : 'Mute your microphone'}
              >
                {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                {isMuted ? 'Unmute' : 'Mute'}
              </button>

              <button
                onClick={() => setShowDiagnostics((prev) => !prev)}
                className={`px-3 py-1 border font-semibold rounded-lg text-xs flex items-center gap-1 transition-colors ${
                  showDiagnostics
                    ? 'bg-slate-700 text-white border-slate-600'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                }`}
                title="Show live audio-path diagnostics"
              >
                <Radio className="w-3.5 h-3.5" />
                Diagnostics
              </button>

              {(callState === 'failed' || wsStatus === 'disconnected') && (
                <button
                  onClick={handleRetry}
                  className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1 shadow transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry
                </button>
              )}

              {/* Leave Call Button */}
              <button
                onClick={handleLeaveRoom}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1 shadow transition-colors"
              >
                <PhoneOff className="w-3.5 h-3.5" />
                Leave
              </button>
            </div>
          </header>

          {/* Live audio-path diagnostics (both roles) */}
          {showDiagnostics && (
            <div className="bg-slate-900/95 border-b border-slate-800 px-4 py-3 text-[11px] font-mono shrink-0 max-h-64 overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold uppercase tracking-wider text-slate-300">
                  Audio Path Diagnostics
                </span>
                <span className="text-slate-500">{diagnostics?.updatedAt ?? 'collecting...'}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
                <DiagRow label="Signaling WS" value={diagnostics?.signaling ?? wsStatus} />
                <DiagRow label="Peer" value={diagnostics?.peerRole ?? 'none'} />
                <DiagRow label="PC / ICE state" value={`${diagnostics?.pcState ?? '-'} / ${diagnostics?.iceState ?? '-'}`} />
                <DiagRow
                  label="ICE candidates"
                  value={
                    diagnostics
                      ? `host ${diagnostics.candidates.host} · srflx ${diagnostics.candidates.srflx} · relay ${diagnostics.candidates.relay}`
                      : '-'
                  }
                />
                <DiagRow
                  label="Selected path"
                  value={
                    diagnostics
                      ? `${diagnostics.selectedLocalType} → ${diagnostics.selectedRemoteType}${
                          diagnostics.relayPath ? ' (TURN relay)' : ''
                        }`
                      : '-'
                  }
                />
                <DiagRow label="TURN configured" value={iceInfo.hasTurn ? 'yes' : 'NO — direct paths only'} />
                <DiagRow label="Local mic track" value={diagnostics?.localTrack ?? 'none'} />
                <DiagRow label="Remote audio tracks" value={String(diagnostics?.remoteTracks ?? 0)} />
                <DiagRow
                  label="Audio element"
                  value={
                    diagnostics
                      ? `${diagnostics.audioSrcAttached ? 'attached' : 'empty'} · ${
                          diagnostics.audioMuted ? 'muted' : 'unmuted'
                        } · ${diagnostics.audioPaused ? 'PAUSED' : 'playing'}`
                      : '-'
                  }
                />
                <DiagRow
                  label="RTP send / receive"
                  value={
                    diagnostics
                      ? `${diagnostics.sendBitrateKbps} kbps / ${diagnostics.receiveBitrateKbps} kbps`
                      : '-'
                  }
                />
                <DiagRow
                  label="Audio clock"
                  value={diagnostics ? `${diagnostics.audioCurrentTime}s` : '-'}
                />
                <DiagRow label="Role" value={role} />
              </div>
              {diagnostics &&
                diagnostics.sendBitrateKbps === 0 &&
                diagnostics.receiveBitrateKbps === 0 &&
                diagnostics.pcState !== 'connected' && (
                  <p className="mt-2 text-amber-300">
                    No media path yet. If this stays at 0/0 while the AI text keeps working, the two
                    devices cannot reach each other directly — configure TURN_URLS / TURN_USERNAME /
                    TURN_CREDENTIAL on the server.
                  </p>
                )}
            </div>
          )}

          {/* Main Content View Split */}
          {role === 'salesperson' ? (
            /* SALESPERSON DASHBOARD: Teleprompter AI Suggestions Display */
            <div className="flex-1 overflow-hidden p-4 sm:p-6 flex flex-col max-w-5xl w-full mx-auto">
              <div className="flex-1 bg-slate-900/80 border border-slate-800 rounded-2xl p-4 sm:p-6 flex flex-col min-h-0 shadow-2xl space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
                      Real-Time AI Sales Suggestions (Ready to Read Aloud)
                    </h3>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 bg-slate-950 px-2.5 py-1 rounded-md border border-slate-800">
                    Model: ultravox-v0.7
                  </span>
                </div>

                {/* AI Teleprompter Suggestion Cards */}
                <div className="flex-1 overflow-y-auto space-y-3.5 pr-1 custom-scrollbar">
                  {aiSuggestions.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
                      <Sparkles className="w-10 h-10 mb-3 opacity-30 text-cyan-400" />
                      <p className="text-sm font-medium text-slate-300">
                        {peerPresent && callState === 'connected'
                          ? 'Listening to customer speech... AI suggestions will stream here live.'
                          : peerPresent
                            ? 'Connecting to the customer audio stream...'
                            : 'Waiting for customer to join call...'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1 max-w-md">
                        When the customer speaks into their microphone, Ultravox generates instant ready-to-read response suggestions on your screen.
                      </p>
                    </div>
                  ) : (
                    aiSuggestions.map((card, idx) => {
                      const isLatest = idx === aiSuggestions.length - 1;
                      return (
                        <div
                          key={card.id}
                          className={`p-4 rounded-2xl border transition-all ${
                            isLatest
                              ? 'bg-gradient-to-r from-cyan-950/40 to-indigo-950/40 border-cyan-500/50 shadow-lg shadow-cyan-500/10'
                              : 'bg-slate-950/60 border-slate-800/80 opacity-70'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2 text-[10px] font-mono">
                            <span
                              className={`px-2 py-0.5 rounded font-bold uppercase ${
                                isLatest
                                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {isLatest ? 'Recommended Response' : 'Prior Suggestion'}
                            </span>
                            <span className="text-slate-500">{card.timestamp}</span>
                          </div>

                          <p className="text-sm sm:text-base text-slate-100 font-sans leading-relaxed font-medium">
                            "{card.text}"
                          </p>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* CUSTOMER VIEW: Clean Live Audio Session Interface */
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col items-center justify-center">
              <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-center space-y-5">
                <div className="inline-flex p-4 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-3xl animate-pulse">
                  <Mic className="w-8 h-8" />
                </div>

                <div>
                  <h3 className="text-base font-bold text-slate-100">
                    {callState === 'connected'
                      ? 'Live Conversation Active'
                      : callState === 'waiting'
                        ? 'Waiting for the Salesperson...'
                        : callState === 'connecting'
                          ? 'Connecting Live Audio...'
                          : callState === 'reconnecting'
                            ? 'Reconnecting to the Call...'
                            : callState === 'failed'
                              ? 'Audio Connection Lost'
                              : callState === 'mic_denied'
                                ? 'Microphone Permission Required'
                                : 'Session Not Connected'}
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    {callState === 'connected'
                      ? 'You are connected live with the salesperson. Speak naturally into your microphone.'
                      : callState === 'waiting'
                        ? 'You are in the room. Audio will start automatically when the salesperson joins.'
                        : callState === 'failed' || wsStatus === 'disconnected'
                          ? 'The connection could not be recovered automatically. Use Retry or leave and rejoin.'
                          : callState === 'mic_denied'
                            ? 'Allow microphone access in your browser, then retry the call.'
                            : 'Establishing a direct peer-to-peer audio connection...'}
                  </p>
                </div>

                {(callState === 'failed' || callState === 'mic_denied' || wsStatus === 'disconnected') && (
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Retry Connection
                  </button>
                )}

                {latestSpeechText && (
                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-left">
                    <span className="text-[10px] font-mono font-bold uppercase text-slate-400 block mb-1">
                      Your Recognized Speech:
                    </span>
                    <p className="text-xs text-slate-200 font-sans italic">"{latestSpeechText}"</p>
                  </div>
                )}

                <div className="pt-2 flex items-center justify-center gap-3">
                  <button
                    onClick={handleToggleMute}
                    className={`px-4 py-2 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                      isMuted
                        ? 'bg-red-500/20 text-red-300 border-red-500/40'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                    }`}
                  >
                    {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
                    {isMuted ? 'Microphone Muted' : 'Mute Microphone'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bottom Action Footer */}
          <footer className="bg-slate-900 border-t border-slate-800 p-3 sm:p-4 shrink-0">
            <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Prototype 2 Engine Active</span>
              </div>
              <button
                onClick={() => window.open(getCustomerInviteUrl(), '_blank', 'noopener,noreferrer')}
                className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-semibold"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Standalone Tab
              </button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
};
