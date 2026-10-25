import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Check, Copy, Headphones, Link2, Mic, MicOff, PhoneCall, PhoneOff,
  RefreshCw, ShieldCheck, UserRound, Volume2, VolumeX,
} from 'lucide-react';
import { CallEngine, EngineSnapshot, ParticipantRole } from '../../lib/callEngine';
import { AiLifecycleState, aiStateLabel, aiTone } from '../../lib/aiStatus';
import {
  ApiError, CreatedSession, SessionDiagnosticsResponse, SessionPublicState,
  createSession, getSession, getSessionDiagnostics, revokeInvitation, rotateInvitation,
} from '../../lib/sessionApi';
import {
  StoredSalespersonSession, clearSalespersonSession, loadDisplayName,
  loadResumeToken, loadSalespersonSession, saveDisplayName, saveResumeToken,
  saveSalespersonSession,
} from '../../lib/participantStorage';
import { Banner, StatusLine, timeLeft } from './ui';
import {
  AiStateChip, AiSuggestionPanel, CustomerTranscriptPanel, DiagnosticsPanel, DiagnosticsToggle,
} from './SalespersonPanels';

const ROLE: ParticipantRole = 'salesperson';

type StatusTone = 'emerald' | 'amber' | 'red' | 'slate' | 'indigo';

const TONE_BORDER: Record<StatusTone, string> = {
  emerald: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  amber: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  red: 'border-rose-500/40 text-rose-300 bg-rose-500/10',
  slate: 'border-slate-700 text-slate-400 bg-slate-900',
  indigo: 'border-indigo-500/40 text-indigo-300 bg-indigo-500/10',
};

/**
 * "Connected" alone is not proof of audio: ICE/DTLS can connect while no RTP
 * arrives. The label only claims working audio once RTP has been received.
 */
const callStateLabel = (snapshot: EngineSnapshot | null): { label: string; tone: StatusTone } => {
  switch (snapshot?.callState ?? 'idle') {
    case 'connected':
      return snapshot?.mediaFlowing
        ? { label: 'Audio flowing', tone: 'emerald' }
        : { label: 'Connected — waiting for media', tone: 'amber' };
    case 'disconnected': return { label: 'Customer disconnected', tone: 'red' };
    case 'connecting': return { label: 'Connecting audio', tone: 'amber' };
    case 'waiting': return { label: 'Waiting for customer', tone: 'amber' };
    case 'requesting_mic': return { label: 'Requesting microphone', tone: 'amber' };
    case 'reconnecting': return { label: 'Reconnecting', tone: 'amber' };
    case 'failed': return { label: 'Connection failed', tone: 'red' };
    case 'mic_denied': return { label: 'Microphone blocked', tone: 'red' };
    case 'rejected': return { label: 'Join rejected', tone: 'red' };
    case 'ended': return { label: 'Call ended', tone: 'slate' };
    default: return { label: 'Not connected', tone: 'slate' };
  }
};

export const SalespersonDashboard: React.FC = () => {
  const [session, setSession] = useState<StoredSalespersonSession | null>(null);
  const [sessionState, setSessionState] = useState<SessionPublicState | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState<string>(() => loadDisplayName());
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [engineStarted, setEngineStarted] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [serverDiagnostics, setServerDiagnostics] = useState<SessionDiagnosticsResponse | null>(null);

  const engineRef = useRef<CallEngine | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(true);

  const stopEngine = useCallback(async (reason: string) => {
    const engine = engineRef.current;
    engineRef.current = null;
    setEngineStarted(false);
    if (engine) await engine.stop(reason);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void engineRef.current?.stop('dashboard unmounted');
      engineRef.current = null;
    };
  }, []);

  const adoptSession = useCallback(async (created: CreatedSession, name: string) => {
    const stored: StoredSalespersonSession = {
      sessionId: created.sessionId,
      salespersonKey: created.salespersonKey,
      createdAt: Date.now(),
      displayName: name,
    };
    saveSalespersonSession(stored);
    setSession(stored);
    setInviteUrl(created.inviteUrl);
    setInviteExpiresAt(created.inviteExpiresAt);
    try {
      const { session: state } = await getSession(stored.sessionId, stored.salespersonKey);
      if (mountedRef.current) setSessionState(state);
    } catch {
      // Non-fatal: the invite panel still works.
    }
  }, []);

  const createFreshSession = useCallback(async () => {
    setBootError(null);
    try {
      const created = await createSession(displayName ? `Sales call with ${displayName}` : 'Sales call');
      await adoptSession(created, displayName);
    } catch (err) {
      setBootError((err as Error)?.message || 'Could not create a session.');
    }
  }, [adoptSession, displayName]);

  const boot = useCallback(async () => {
    setBooting(true);
    const stored = loadSalespersonSession();
    if (stored) {
      try {
        const { session: state } = await getSession(stored.sessionId, stored.salespersonKey);
        if (!mountedRef.current) return;
        setSession(stored);
        setSessionState(state);
        setDisplayName(stored.displayName || displayName);
        setBooting(false);
        return;
      } catch (err) {
        const apiError = err as ApiError;
        // Only discard the stored session when the server explicitly rejects it.
        if (apiError?.status === 401 || apiError?.status === 404) clearSalespersonSession();
      }
    }
    await createFreshSession();
    if (mountedRef.current) setBooting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createFreshSession]);

  // Read-only hook for diagnostics tooling and automated tests.
  useEffect(() => {
    (window as any).__prototype2 = {
      role: 'salesperson',
      getSnapshot: () => engineRef.current?.getSnapshot() ?? null,
      getServerSession: () => sessionState,
    };
    return () => {
      delete (window as any).__prototype2;
    };
  }, [sessionState]);

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the server-side session view so "customer connected" is authoritative.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { session: state } = await getSession(session.sessionId, session.salespersonKey);
        if (!cancelled) setSessionState(state);
      } catch {
        // Keep the last known state; the engine reports transport failures.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session]);

  useEffect(() => {
    if (!showDiagnostics || !session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await getSessionDiagnostics(session.sessionId, session.salespersonKey);
        if (!cancelled) setServerDiagnostics(data);
      } catch (err) {
        if (!cancelled) setActionError((err as Error)?.message || 'Diagnostics request failed.');
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [showDiagnostics, session]);

  const startCall = async () => {
    if (!session || engineRef.current) return;
    setActionError(null);
    const engine = new CallEngine({
      sessionId: session.sessionId,
      role: ROLE,
      credential: session.salespersonKey,
      resumeToken: loadResumeToken(session.sessionId, ROLE),
      // Salesperson: caption my own microphone for the customer transcript.
      // This engine never creates an Ultravox session (enableAi is customer-only).
      enableTranscript: true,
      onUpdate: (next) => {
        if (mountedRef.current) setSnapshot(next);
      },
      onResumeToken: (token) => saveResumeToken(session.sessionId, ROLE, token),
    });
    engine.attachAudioElement(audioRef.current);
    engineRef.current = engine;
    setEngineStarted(true);
    await engine.start();
  };

  const leaveCall = async () => {
    await stopEngine('salesperson left the call');
  };

  const restartCall = async () => {
    await stopEngine('manual reconnect');
    await startCall();
  };

  const toggleMute = () => {
    const engine = engineRef.current;
    if (!engine || !snapshot) return;
    engine.setMicMuted(!snapshot.micMuted);
  };

  const toggleSpeaker = () => {
    const engine = engineRef.current;
    if (!engine || !snapshot) return;
    if (snapshot.playbackBlocked) {
      void engine.resumePlayback();
      return;
    }
    engine.setSpeakerMuted(!snapshot.speakerMuted);
  };

  const reconnectAi = () => {
    const engine = engineRef.current;
    if (!engine) {
      setActionError('Start the call before asking the customer device to restart the AI.');
      return;
    }
    engine.requestAiReconnect();
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('Clipboard access was blocked. Select the link and copy it manually.');
    }
  };

  const regenerateInvite = async () => {
    if (!session) return;
    setActionError(null);
    try {
      const result = await rotateInvitation(session.sessionId, session.salespersonKey);
      setInviteUrl(result.inviteUrl);
      setInviteExpiresAt(result.inviteExpiresAt);
      setSessionState(result.session);
    } catch (err) {
      setActionError((err as Error)?.message || 'Could not generate a new invitation.');
    }
  };

  const revokeCurrentInvite = async () => {
    if (!session) return;
    setActionError(null);
    try {
      const result = await revokeInvitation(session.sessionId, session.salespersonKey);
      setInviteUrl(null);
      setInviteExpiresAt(null);
      setSessionState(result.session);
    } catch (err) {
      setActionError((err as Error)?.message || 'Could not revoke the invitation.');
    }
  };

  /**
   * AI status shown to the salesperson.
   *
   * The Ultravox session lives on the customer device. `snapshot.ai` is the
   * live value relayed over signaling; `sessionState.ai` is the server's
   * persisted copy (used before the first relay or after a signaling blip).
   * Both are real reported states, never "the server has an API key".
   */
  const aiView = useMemo(() => {
    const live = snapshot?.ai;
    const polled = sessionState?.ai;
    const liveHasReport = Boolean(live && live.state !== 'off');
    const rawState = ((liveHasReport ? live?.state : null) ?? polled?.state ?? 'off') as AiLifecycleState;
    const known: AiLifecycleState[] = [
      'off', 'creating', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'error',
    ];
    const state = known.includes(rawState) ? rawState : 'error';
    const reported = liveHasReport ? live : null;
    return {
      state,
      label: aiStateLabel(state),
      tone: aiTone(state) as StatusTone,
      error: (reported ? reported.error : polled?.error) ?? null,
      connected: Boolean((reported ? reported.connected : polled?.connected) && state === 'connected'),
      reconnecting: state === 'creating' || state === 'connecting' || state === 'reconnecting',
      reconnectAttempt: reported?.reconnectAttempt ?? polled?.reconnectAttempt ?? 0,
      maxReconnectAttempts: reported?.maxReconnectAttempts ?? 3,
      audioReachingAi: Boolean((reported ? reported.audioReachingAi : polled?.audioReachingAi) && state === 'connected'),
      lastResponseAt: reported?.lastSuggestionAt ?? polled?.lastSuggestionAt ?? null,
      callCreated: Boolean(sessionState?.aiCallCreated ?? sessionState?.aiReady),
      callId: reported?.callId ?? null,
      source: liveHasReport ? 'live signaling' : polled?.state ? 'server poll' : 'none',
    };
  }, [snapshot?.ai, sessionState?.ai, sessionState?.aiCallCreated, sessionState?.aiReady]);

  /** Caption status of this device's speech capture (drives the customer panel). */
  const captionStatus = useMemo(() => {
    const transcript = snapshot?.transcript;
    if (!transcript) return 'not started';
    if (transcript.status === 'listening') return 'live for the customer';
    if (transcript.status === 'unsupported') return 'unavailable in this browser';
    if (transcript.status === 'error') return transcript.error ?? 'stopped';
    if (transcript.status === 'starting') return 'starting';
    return 'not started';
  }, [snapshot?.transcript]);

  const serverRows = useMemo<Array<[string, string]>>(() => {
    if (!serverDiagnostics) return [];
    const d = serverDiagnostics.diagnostics;
    return [
      ['customer online', String(d.customerConnected)],
      ['salesperson online', String(d.salespersonConnected)],
      ['invitation', d.invitationStatus],
      ['AI call created', d.aiCallCreated ? `yes (${d.aiCallId?.slice(0, 10) ?? 'unknown'})` : 'no'],
      ['AI live (customer)', d.ai.connected ? 'yes' : 'no'],
      ['AI state', d.ai.state ?? 'none'],
      ['AI error', d.aiLastError ?? 'none'],
      ['AI audio in', d.ai.audioReachingAi ? 'yes' : 'no'],
      ['AI reconnect attempt', String(d.ai.reconnectAttempt)],
      ['offers', String(d.signals.offers)],
      ['answers', String(d.signals.answers)],
      ['ice relayed', String(d.signals.iceCandidates)],
      ['AI text relayed', String(d.signals.aiSuggestions)],
      ['captions relayed', String(d.signals.salespersonTranscripts ?? 0)],
      ['relay failures', String(d.signals.relayFailures)],
      ['rejected msgs', String(d.signals.rejectedMessages)],
      ['last server error', d.signals.lastError ?? 'none'],
      ['TURN configured', String(serverDiagnostics.ice.configured)],
      ['TURN credentials', serverDiagnostics.ice.credentialMode],
      ['ICE policy', serverDiagnostics.ice.iceTransportPolicy],
      ['AI server readiness', serverDiagnostics.ai.ready ? 'key configured' : `no (${serverDiagnostics.ai.missing.join(', ')})`],
      ['storage', d.storage],
    ];
  }, [serverDiagnostics]);

  const endSession = async () => {
    await stopEngine('session ended by salesperson');
    clearSalespersonSession();
    setSession(null);
    setSessionState(null);
    setInviteUrl(null);
    setInviteExpiresAt(null);
    setSnapshot(null);
    await createFreshSession();
  };

  const callState = callStateLabel(snapshot);
  const micLive = snapshot?.micPermission === 'granted' && snapshot.localTrackState === 'live';
  const incomingAudioLive = Boolean(snapshot && snapshot.mediaFlowing && !snapshot.speakerMuted);

  if (booting) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950" data-testid="role-salesperson-loading">
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Preparing your sales session…
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 p-6" data-testid="role-salesperson-error">
        <div className="max-w-md space-y-3 text-center">
          <AlertCircle className="w-8 h-8 text-rose-400 mx-auto" />
          <h1 className="text-lg font-semibold text-slate-100">Salesperson dashboard unavailable</h1>
          <p className="text-sm text-slate-400">{bootError || 'The session could not be created.'}</p>
          <button
            onClick={() => void createFreshSession()}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-950" data-testid="role-salesperson">
      <audio ref={audioRef} autoPlay playsInline className="hidden" data-testid="remote-audio" />

      <div className="max-w-7xl mx-auto p-3 sm:p-4 space-y-3">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 text-white">
              <Headphones className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100">Live sales call</h1>
              <p className="text-[11px] text-slate-400 font-mono">
                session {session.sessionId.slice(0, 10)} · expires in {timeLeft(sessionState?.expiresAt ?? null)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5">
              <UserRound className="w-4 h-4 text-slate-500" aria-hidden="true" />
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => {
                  saveDisplayName(displayName);
                  saveSalespersonSession({ ...session, displayName });
                  setSession({ ...session, displayName });
                }}
                placeholder="Your name"
                className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none w-28"
                aria-label="Salesperson name"
              />
            </div>
            <span
              className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${TONE_BORDER[callState.tone]}`}
              data-testid="call-state"
            >
              {callState.label}
            </span>
            <AiStateChip label={aiView.label} tone={aiView.tone} title={aiView.error ?? aiView.label} />
          </div>
        </header>

        {snapshot?.iceConfigError ? (
          <Banner tone="red" title="ICE / TURN configuration problem" testId="ice-error">
            {snapshot.iceConfigError}
          </Banner>
        ) : null}
        {snapshot && !snapshot.turnConfigured && !snapshot.iceConfigError ? (
          <Banner tone="amber" title="TURN relay not configured" testId="turn-warning">
            The customer may be inaudible on mobile data or strict NATs. Configure TURN on the server.
          </Banner>
        ) : null}
        {snapshot?.diagnostics.iceTransportPolicy === 'relay' && snapshot.relayCandidates === 0 ? (
          <Banner tone="red" title="Relay-only mode without a relay path" testId="relay-warning">
            TURN is unreachable or rejected the credentials, so no media path can be established.
          </Banner>
        ) : null}
        {snapshot?.iceConfigWarnings.length && !snapshot.iceConfigError ? (
          <Banner tone="amber" title="ICE warning">{snapshot.iceConfigWarnings[0]}</Banner>
        ) : null}
        {actionError ? (
          <Banner
            tone="red"
            title="Action failed"
            action={<button onClick={() => setActionError(null)} className="underline">dismiss</button>}
          >
            {actionError}
          </Banner>
        ) : null}
        {snapshot?.playbackBlocked ? (
          <Banner
            tone="amber"
            title="Customer audio is blocked by the browser"
            action={
              <button
                onClick={() => void engineRef.current?.resumePlayback()}
                className="px-3 py-1 rounded-lg bg-amber-500 text-slate-950 font-semibold"
              >
                Enable audio
              </button>
            }
          >
            A user gesture is required before audio can play.
          </Banner>
        ) : null}
        {snapshot?.lastError ? (
          <Banner tone="red" title="Connection problem">
            {snapshot.lastError}
            {snapshot.reconnectAttempt > 0 ? ` (reconnect attempt ${snapshot.reconnectAttempt})` : ''}
          </Banner>
        ) : null}
        {snapshot?.lastServerError ? (
          <Banner tone="amber" title="Server signaling error">{snapshot.lastServerError}</Banner>
        ) : null}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] gap-3 items-start">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-4">
              <div
                className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center bg-gradient-to-br from-slate-700 to-slate-800 text-slate-100 ${
                  snapshot?.peerParticipantId ? 'ring-2 ring-emerald-400/40' : ''
                }`}
                aria-hidden="true"
              >
                <UserRound className="w-7 h-7" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-slate-100">Customer</h2>
                <p className="text-sm text-slate-400" data-testid="customer-connection">
                  {!snapshot?.peerParticipantId
                    ? sessionState?.customerConnected
                      ? 'Connected, joining audio…'
                      : 'Waiting for the customer to join'
                    : incomingAudioLive
                      ? 'Customer audio is live'
                      : snapshot?.playbackBlocked
                        ? 'Tap Enable audio to hear the customer'
                        : 'Connected — waiting for customer audio'}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {micLive && !snapshot?.micMuted
                    ? 'Your microphone is live'
                    : snapshot?.micMuted
                      ? 'Your microphone is muted (captions paused)'
                      : 'Microphone not captured'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!engineStarted ? (
                <button
                  onClick={() => void startCall()}
                  data-testid="join-call"
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2"
                >
                  <PhoneCall className="w-4 h-4" aria-hidden="true" /> Start microphone &amp; connect
                </button>
              ) : (
                <>
                  <button
                    onClick={toggleMute}
                    data-testid="mic-toggle"
                    aria-pressed={Boolean(snapshot?.micMuted)}
                    className={`px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 ${
                      snapshot?.micMuted
                        ? 'bg-rose-600 hover:bg-rose-500 text-white'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {snapshot?.micMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    {snapshot?.micMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button
                    onClick={toggleSpeaker}
                    data-testid="speaker-toggle"
                    aria-pressed={Boolean(snapshot?.speakerMuted)}
                    className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-semibold flex items-center gap-2"
                  >
                    {snapshot?.speakerMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    {snapshot?.speakerMuted ? 'Unmute audio' : 'Mute audio'}
                  </button>
                  <button
                    onClick={() => void restartCall()}
                    data-testid="reconnect"
                    className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" /> Reconnect
                  </button>
                  <button
                    onClick={() => void leaveCall()}
                    data-testid="leave-call"
                    className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold flex items-center gap-2"
                  >
                    <PhoneOff className="w-4 h-4" aria-hidden="true" /> End call
                  </button>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
              <StatusLine
                label="Signaling"
                value={snapshot?.wsStatus ?? 'not started'}
                tone={snapshot?.wsStatus === 'connected' ? 'emerald' : snapshot?.wsStatus === 'reconnecting' ? 'amber' : 'slate'}
              />
              <StatusLine
                label="Customer audio in"
                value={
                  !snapshot?.peerParticipantId
                    ? 'no peer'
                    : snapshot.speakerMuted
                      ? 'muted locally'
                      : incomingAudioLive
                        ? `live · ${snapshot.diagnostics.receiveBitrateKbps} kbps`
                        : 'waiting for media'
                }
                tone={incomingAudioLive ? 'emerald' : 'amber'}
              />
              <StatusLine
                label="Captions to customer"
                value={captionStatus}
                tone={snapshot?.transcript.status === 'listening' ? 'emerald' : snapshot?.transcript.status === 'error' ? 'red' : 'slate'}
                detail={snapshot?.transcript.error ?? undefined}
              />
              <StatusLine
                label="Network path"
                value={snapshot?.diagnostics.relayPath ? 'TURN relay' : snapshot?.selectedPair ?? 'not negotiated'}
                tone={snapshot?.diagnostics.relayPath ? 'indigo' : 'slate'}
              />
            </div>
          </section>

          <aside className="space-y-3">
            <AiSuggestionPanel
              suggestions={snapshot?.suggestions ?? []}
              ai={aiView}
              onReconnect={reconnectAi}
              disabled={!engineStarted || !sessionState?.customerConnected}
            />
            <CustomerTranscriptPanel
              segments={snapshot?.customerTranscript ?? []}
              customerSpeech={snapshot?.customerSpeech ?? ''}
              aiLive={Boolean(aiView.connected)}
            />
          </aside>
        </div>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Customer invitation
            </h2>
            <span className="text-[10px] text-slate-500">
              expires in {timeLeft(inviteExpiresAt ?? sessionState?.invitationExpiresAt ?? null)}
            </span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              readOnly
              value={inviteUrl ?? ''}
              placeholder="No active invitation"
              data-testid="salesperson-invite-url"
              onFocus={(event) => event.currentTarget.select()}
              className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 outline-none"
              aria-label="Customer invitation URL"
            />
            {inviteUrl ? (
              <button
                onClick={() => void copyInvite()}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
            ) : null}
            <button
              onClick={() => void regenerateInvite()}
              data-testid="regenerate-invite"
              className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
            >
              New invitation
            </button>
            {inviteUrl ? (
              <button
                onClick={() => void revokeCurrentInvite()}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
              >
                Revoke
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-[10px] text-slate-500 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Invitations are single-use and enforced by the server.
            </p>
            <button
              onClick={() => void endSession()}
              className="text-[10px] font-semibold text-slate-400 hover:text-rose-300 underline"
            >
              End session and start a new one
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-2">
          <DiagnosticsToggle open={showDiagnostics} onToggle={() => setShowDiagnostics((open) => !open)} />
          {showDiagnostics ? (
            <div className="p-2">
              <DiagnosticsPanel
                snapshot={snapshot}
                role={ROLE}
                serverRows={serverRows}
                serverLoading={!serverDiagnostics}
              />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default SalespersonDashboard;
