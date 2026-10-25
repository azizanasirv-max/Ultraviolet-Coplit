import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Check, Copy, Headphones, Link2, Mic, MicOff, PhoneCall, PhoneOff,
  RefreshCw, ShieldCheck, Sparkles, Users, Volume2, VolumeX, Activity, UserRound,
} from 'lucide-react';
import { CallEngine, EngineSnapshot, ParticipantRole } from '../../lib/callEngine';
import {
  ApiError, CreatedSession, SessionDiagnosticsResponse, SessionPublicState,
  createSession, getSession, getSessionDiagnostics, revokeInvitation, rotateInvitation,
} from '../../lib/sessionApi';
import {
  StoredSalespersonSession, clearSalespersonSession, loadDisplayName,
  loadResumeToken, loadSalespersonSession, saveDisplayName, saveResumeToken,
  saveSalespersonSession,
} from '../../lib/participantStorage';
import { Banner, DiagGrid, Panel, StatusLine, timeLeft } from './ui';

const ROLE: ParticipantRole = 'salesperson';

const callStateLabel = (state: EngineSnapshot['callState']): { label: string; tone: 'emerald' | 'amber' | 'red' | 'slate' } => {
  switch (state) {
    case 'connected': return { label: 'Audio connected', tone: 'emerald' };
    case 'connecting': return { label: 'Connecting audio', tone: 'amber' };
    case 'waiting': return { label: 'Waiting for customer', tone: 'amber' };
    case 'requesting_mic': return { label: 'Requesting microphone', tone: 'amber' };
    case 'reconnecting': return { label: 'Reconnecting', tone: 'amber' };
    case 'failed': return { label: 'Connection failed', tone: 'red' };
    case 'mic_denied': return { label: 'Microphone blocked', tone: 'red' };
    case 'rejected': return { label: 'Join rejected', tone: 'red' };
    case 'disconnected': return { label: 'Peer disconnected', tone: 'red' };
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

  // Exposed for diagnostics tooling and automated browser tests (read-only).
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

  // Poll the server-side session view so "customer connected" is authoritative,
  // not inferred from local WebSocket state alone.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { session: state } = await getSession(session.sessionId, session.salespersonKey);
        if (!cancelled) setSessionState(state);
      } catch {
        // Keep the last known state; the engine reports transport failures itself.
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
    engine.setSpeakerMuted(!snapshot.speakerMuted);
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

  const callState = snapshot ? callStateLabel(snapshot.callState) : { label: 'Not started', tone: 'slate' as const };
  const micLive = snapshot?.micPermission === 'granted' && snapshot.localTrackState === 'live';
  const incomingAudioLive = Boolean(
    snapshot &&
      snapshot.remoteTrackState === 'live' &&
      (snapshot.diagnostics.bytesReceived ?? 0) > 0 &&
      !snapshot.speakerMuted
  );

  const latestSuggestion = useMemo(
    () => (snapshot?.suggestions.length ? snapshot.suggestions[snapshot.suggestions.length - 1] : null),
    [snapshot?.suggestions]
  );

  if (booting) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950" data-testid="role-salesperson-loading">
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Preparing your sales session...
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

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 text-white">
              <Headphones className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100">Salesperson dashboard</h1>
              <p className="text-[11px] text-slate-400 font-mono">
                session {session.sessionId.slice(0, 10)} · expires in {timeLeft(sessionState?.expiresAt ?? null)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5">
              <UserRound className="w-4 h-4 text-slate-500" />
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => {
                  saveDisplayName(displayName);
                  saveSalespersonSession({ ...session, displayName });
                  setSession({ ...session, displayName });
                }}
                placeholder="Your name"
                className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none w-32"
                aria-label="Salesperson name"
              />
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              callState.tone === 'emerald'
                ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                : callState.tone === 'amber'
                  ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                  : callState.tone === 'red'
                    ? 'border-rose-500/40 text-rose-300 bg-rose-500/10'
                    : 'border-slate-700 text-slate-400 bg-slate-900'
            }`} data-testid="call-state">
              {callState.label}
            </span>
          </div>
        </header>

        {bootError ? <Banner tone="red" title="Session error">{bootError}</Banner> : null}
        {actionError ? (
          <Banner tone="red" title="Action failed" action={<button onClick={() => setActionError(null)} className="underline">dismiss</button>}>
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
            Tap Enable audio (a user gesture is required before audio can play).
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

        {/* Call controls */}
        <div className="flex flex-wrap items-center gap-2 bg-slate-900/70 border border-slate-800 rounded-2xl p-3">
          {!engineStarted ? (
            <button
              onClick={() => void startCall()}
              data-testid="join-call"
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2"
            >
              <PhoneCall className="w-4 h-4" /> Start microphone & connect
            </button>
          ) : (
            <>
              <button
                onClick={toggleMute}
                data-testid="mic-toggle"
                aria-pressed={Boolean(snapshot?.micMuted)}
                className={`px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 ${
                  snapshot?.micMuted
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                }`}
              >
                {snapshot?.micMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                {snapshot?.micMuted ? 'Unmute microphone' : 'Mute microphone'}
              </button>
              <button
                onClick={toggleSpeaker}
                data-testid="speaker-toggle"
                aria-pressed={Boolean(snapshot?.speakerMuted)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-semibold flex items-center gap-2"
              >
                {snapshot?.speakerMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                {snapshot?.speakerMuted ? 'Unmute customer audio' : 'Mute customer audio'}
              </button>
              <button
                onClick={() => void restartCall()}
                data-testid="reconnect"
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" /> Reconnect
              </button>
              <button
                onClick={() => void leaveCall()}
                data-testid="leave-call"
                className="px-4 py-2 rounded-xl bg-rose-600/90 hover:bg-rose-500 text-white text-sm font-semibold flex items-center gap-2"
              >
                <PhoneOff className="w-4 h-4" /> Leave
              </button>
            </>
          )}
          <span className="text-[11px] text-slate-500 ml-auto">
            {snapshot?.micPermission === 'granted' ? 'Microphone permission granted' : 'Microphone permission not granted yet'}
          </span>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Session + invitation */}
          <Panel title="Session & customer invitation" icon={<Link2 className="w-3.5 h-3.5" />}>
            <div className="space-y-3">
              <StatusLine
                label="Customer connection"
                value={sessionState?.customerConnected ? 'Connected' : 'Not connected'}
                tone={sessionState?.customerConnected ? 'emerald' : 'slate'}
              />
              <StatusLine
                label="Invitation"
                value={sessionState?.invitationStatus ?? 'unknown'}
                tone={sessionState?.invitationStatus === 'active' || sessionState?.invitationStatus === 'redeemed' ? 'emerald' : 'amber'}
                detail={inviteExpiresAt ? `expires in ${timeLeft(inviteExpiresAt)}` : undefined}
              />

              {inviteUrl ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={inviteUrl}
                      data-testid="salesperson-invite-url"
                      onFocus={(event) => event.currentTarget.select()}
                      className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] font-mono text-cyan-200"
                    />
                    <button
                      onClick={() => void copyInvite()}
                      data-testid="copy-invite"
                      className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Send this link to the customer. It works once, in one browser, and is bound to this session.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  No active link is shown for a restored session. Generate a fresh invitation to invite the customer.
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void regenerateInvite()}
                  data-testid="regenerate-invite"
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Generate new invitation
                </button>
                <button
                  onClick={() => void revokeCurrentInvite()}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
                >
                  Revoke invitation
                </button>
                <button
                  onClick={() => void endSession()}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold ml-auto"
                >
                  New session
                </button>
              </div>
              <p className="text-[10px] text-slate-500 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" /> Role and invitation permissions are enforced by the server.
              </p>
            </div>
          </Panel>

          {/* Audio status */}
          <Panel title="Audio status" icon={<Activity className="w-3.5 h-3.5" />}>
            <div className="space-y-1">
              <StatusLine
                label="Signaling socket"
                value={snapshot?.wsStatus ?? 'not started'}
                tone={snapshot?.wsStatus === 'connected' ? 'emerald' : snapshot?.wsStatus === 'reconnecting' ? 'amber' : 'slate'}
              />
              <StatusLine
                label="Outgoing microphone"
                value={
                  !snapshot || snapshot.micPermission !== 'granted'
                    ? 'no capture'
                    : snapshot.micMuted
                      ? 'muted'
                      : micLive
                        ? `live · ${snapshot.localSenderCount} sender(s)`
                        : 'stopped'
                }
                tone={micLive && !snapshot?.micMuted ? 'emerald' : snapshot?.micMuted ? 'amber' : 'red'}
              />
              <StatusLine
                label="Customer connected"
                value={snapshot?.peerParticipantId ? (sessionState?.customerConnected ? 'connected' : 'joining') : 'waiting'}
                tone={snapshot?.peerParticipantId ? 'emerald' : 'slate'}
              />
              <StatusLine
                label="Incoming customer audio"
                value={
                  !snapshot?.peerParticipantId
                    ? 'no peer'
                    : snapshot.speakerMuted
                      ? 'muted locally'
                      : snapshot.playbackBlocked
                        ? 'blocked by browser'
                        : incomingAudioLive
                          ? `live · ${snapshot.diagnostics.receiveBitrateKbps} kbps`
                          : 'waiting for media'
                }
                tone={incomingAudioLive ? 'emerald' : snapshot?.playbackBlocked ? 'red' : 'amber'}
                detail={
                  snapshot
                    ? `pc=${snapshot.diagnostics.pcState} ice=${snapshot.diagnostics.iceState} rtp in ${snapshot.diagnostics.bytesReceived} B / out ${snapshot.diagnostics.bytesSent} B`
                    : undefined
                }
              />
              <StatusLine
                label="Network path"
                value={
                  snapshot?.diagnostics.relayPath
                    ? 'TURN relay'
                    : snapshot && snapshot.diagnostics.selectedLocalType !== 'none'
                      ? `${snapshot.diagnostics.selectedLocalType} → ${snapshot.diagnostics.selectedRemoteType}`
                      : 'not negotiated'
                }
                tone={snapshot?.diagnostics.relayPath ? 'indigo' : 'slate'}
                detail={
                  snapshot
                    ? `candidates host ${snapshot.diagnostics.candidates.host} / srflx ${snapshot.diagnostics.candidates.srflx} / relay ${snapshot.diagnostics.candidates.relay} · TURN ${snapshot.diagnostics.hasTurn ? 'configured' : 'not configured'}`
                    : undefined
                }
              />
            </div>
          </Panel>
        </div>

        {/* AI suggestions */}
        <Panel
          title="AI copilot responses"
          icon={<Sparkles className="w-3.5 h-3.5" />}
          action={
            <span className="text-[10px] text-slate-500 flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> customer mic → AI → this dashboard
            </span>
          }
        >
          {latestSuggestion ? (
            <div className="space-y-3" data-testid="ai-suggestions">
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
                <p className="text-[10px] uppercase tracking-wide text-indigo-300 font-semibold mb-1">
                  Latest suggestion {latestSuggestion.isFinal ? '' : '(live)'}
                </p>
                <p className="text-sm text-slate-100 leading-relaxed" data-testid="ai-suggestion-latest">
                  {latestSuggestion.text}
                </p>
              </div>
              <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {[...snapshot!.suggestions].reverse().slice(1, 12).map((item) => (
                  <li key={item.id} className="text-[11px] text-slate-400 border-l-2 border-slate-800 pl-2">
                    <span className="text-slate-600 font-mono mr-1.5">{item.timestamp}</span>
                    {item.text}
                  </li>
                ))}
              </ul>
              {snapshot?.customerSpeech ? (
                <p className="text-[11px] text-slate-500 border-t border-slate-800 pt-2">
                  Customer said: <span className="text-slate-300">{snapshot.customerSpeech}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              AI responses appear here once the customer joins and speaks. The AI listens on the customer device only,
              so the salesperson microphone can never be transcribed by the AI.
            </p>
          )}
        </Panel>

        {/* Diagnostics & recovery */}
        <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <Activity className="w-3.5 h-3.5" /> Diagnostics & recovery
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => void engineRef.current?.resumePlayback()}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
              >
                Retry audio
              </button>
              <button
                onClick={() => setShowDiagnostics((value) => !value)}
                data-testid="toggle-diagnostics"
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
              >
                {showDiagnostics ? 'Hide details' : 'Show details'}
              </button>
            </div>
          </div>

          {showDiagnostics ? (
            <div className="grid gap-4 lg:grid-cols-2" data-testid="diagnostics-panel">
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Browser</p>
                <DiagGrid
                  rows={[
                    ['role', 'salesperson'],
                    ['participant', snapshot?.participantId?.slice(0, 10) ?? '—'],
                    ['session', session.sessionId.slice(0, 10)],
                    ['ws', snapshot?.wsStatus ?? 'not started'],
                    ['pc', snapshot?.diagnostics.pcState ?? 'none'],
                    ['ice', snapshot?.diagnostics.iceState ?? 'none'],
                    ['gather', snapshot?.diagnostics.iceGatheringState ?? 'none'],
                    ['path', `${snapshot?.diagnostics.selectedLocalType ?? '—'} → ${snapshot?.diagnostics.selectedRemoteType ?? '—'}`],
                    ['mic perm', snapshot?.micPermission ?? 'unknown'],
                    ['mic track', snapshot?.diagnostics.localTrackState ?? 'none'],
                    ['senders', String(snapshot?.diagnostics.localSenderCount ?? 0)],
                    ['remote', snapshot?.diagnostics.remoteTrackState ?? 'none'],
                    ['rtp out', `${snapshot?.diagnostics.bytesSent ?? 0} B`],
                    ['rtp in', `${snapshot?.diagnostics.bytesReceived ?? 0} B`],
                    ['playback', snapshot?.diagnostics.audioElementPaused ? 'paused' : 'playing'],
                    ['autoplay error', snapshot?.diagnostics.playbackError ?? 'none'],
                    ['reconnects', String(snapshot?.reconnectAttempt ?? 0)],
                  ]}
                />
              </div>

              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Server</p>
                {serverDiagnostics ? (
                  <DiagGrid
                    rows={[
                      ['customer online', String(serverDiagnostics.diagnostics.customerConnected)],
                      ['salesperson online', String(serverDiagnostics.diagnostics.salespersonConnected)],
                      ['invitation', serverDiagnostics.diagnostics.invitationStatus],
                      ['AI call', serverDiagnostics.diagnostics.aiReady ? 'created' : 'not created'],
                      ['offers', String(serverDiagnostics.diagnostics.signals.offers)],
                      ['answers', String(serverDiagnostics.diagnostics.signals.answers)],
                      ['ice relayed', String(serverDiagnostics.diagnostics.signals.iceCandidates)],
                      ['AI text relayed', String(serverDiagnostics.diagnostics.signals.aiSuggestions)],
                      ['relay failures', String(serverDiagnostics.diagnostics.signals.relayFailures)],
                      ['rejected msgs', String(serverDiagnostics.diagnostics.signals.rejectedMessages)],
                      ['last server error', serverDiagnostics.diagnostics.signals.lastError ?? 'none'],
                      ['TURN configured', String(serverDiagnostics.ice.hasTurn)],
                      ['ICE policy', serverDiagnostics.ice.iceTransportPolicy],
                      ['Ultravox key', serverDiagnostics.hasUltravoxKey ? 'present' : 'missing'],
                      ['storage', serverDiagnostics.diagnostics.storage],
                    ]}
                  />
                ) : (
                  <p className="text-[11px] text-slate-500">Loading server diagnostics...</p>
                )}

                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold pt-2">Call log</p>
                <pre className="text-[10px] leading-4 text-slate-400 bg-slate-950 border border-slate-800 rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                  {snapshot?.logs.length ? snapshot.logs.join('\n') : 'No events yet.'}
                </pre>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">
              Open the details panel for signaling, ICE, RTP byte counts, microphone and playback state, and the
              server's own view of this session.
            </p>
          )}
        </section>
      </div>
    </div>
  );
};

export default SalespersonDashboard;
