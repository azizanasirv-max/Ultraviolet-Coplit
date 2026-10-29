import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ArrowLeft, Check, Copy, Headphones, Link2, Mic, MicOff, PhoneCall,
  PhoneOff, RefreshCw, Sparkles, Volume2, VolumeX, Activity, UserRound,
} from 'lucide-react';
import { CallEngine, EngineSnapshot, ParticipantRole } from '../../lib/callEngine';
import { aiActivityLabel, aiStateLabel, aiTone, AiLifecycleState } from '../../lib/aiStatus';
import {
  ApiError, CreatedSession, SessionDiagnosticsResponse, SessionPublicState,
  createSession, getSession, getSessionDiagnostics, rotateInvitation,
} from '../../lib/sessionApi';
import {
  StoredSalespersonSession, clearSalespersonSession, loadDisplayName,
  loadResumeToken, loadSalespersonSession, saveDisplayName, saveResumeToken,
  saveSalespersonSession,
} from '../../lib/participantStorage';
import { Banner, DiagGrid, Panel, StatusLine, timeLeft } from './ui';

const ROLE: ParticipantRole = 'salesperson';

type StatusTone = 'emerald' | 'amber' | 'red' | 'slate' | 'indigo';

/**
 * "Connected" alone is not proof of audio: ICE/DTLS can connect while no RTP
 * arrives (blocked relay, rejected TURN credentials, muted remote track). The
 * label only claims working audio once RTP has actually been received.
 */
const callStateLabel = (snapshot: EngineSnapshot | null): { label: string; tone: StatusTone } => {
  const state = snapshot?.callState ?? 'idle';
  switch (state) {
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

const toneClasses = (tone: StatusTone): string => {
  switch (tone) {
    case 'emerald': return 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10';
    case 'amber': return 'border-amber-500/40 text-amber-300 bg-amber-500/10';
    case 'red': return 'border-rose-500/40 text-rose-300 bg-rose-500/10';
    case 'indigo': return 'border-indigo-500/40 text-indigo-300 bg-indigo-500/10';
    default: return 'border-slate-700 text-slate-400 bg-slate-900';
  }
};

/** Captions are a best-effort browser feature; the call never depends on them. */
const captionStatusLabel = (snapshot: EngineSnapshot | null): string => {
  switch (snapshot?.captionStatus) {
    case 'listening': return 'Customer captions on';
    case 'paused': return 'Customer captions paused (muted)';
    case 'unsupported': return 'Captions unavailable in this browser';
    case 'error': return 'Captions stopped — call audio is unaffected';
    default: return 'Captions off';
  }
};


export const SalespersonDashboard: React.FC = () => {
  const [session, setSession] = useState<StoredSalespersonSession | null>(null);
  const [sessionState, setSessionState] = useState<SessionPublicState | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null);
  const [inviteSessionId, setInviteSessionId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>(() => loadDisplayName());
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [engineStarted, setEngineStarted] = useState(false);
  const [view, setView] = useState<'dashboard' | 'invitation'>('dashboard');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [serverDiagnostics, setServerDiagnostics] = useState<SessionDiagnosticsResponse | null>(null);

  const engineRef = useRef<CallEngine | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(true);

  const stopEngine = useCallback(async (reason: string) => {
    const engine = engineRef.current;
    engineRef.current = null;
    setEngineStarted(false);
    setSnapshot(null);
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

  const adoptSession = useCallback(
    async (created: CreatedSession, name: string, nextView: 'dashboard' | 'invitation') => {
      const stored: StoredSalespersonSession = {
        sessionId: created.sessionId,
        salespersonKey: created.salespersonKey,
        createdAt: Date.now(),
        displayName: name,
      };
      saveSalespersonSession(stored);
      setSession(stored);
      setSessionState(null);
      setInviteUrl(created.inviteUrl);
      setInviteExpiresAt(created.inviteExpiresAt);
      setInviteSessionId(created.sessionId);
      setView(nextView);
      try {
        const { session: state } = await getSession(stored.sessionId, stored.salespersonKey);
        if (mountedRef.current) setSessionState(state);
      } catch {
        // Non-fatal: the call and invite screens still work.
      }
    },
    []
  );

  const createFreshSession = useCallback(
    async (nextView: 'dashboard' | 'invitation') => {
      setBootError(null);
      const created = await createSession(displayName ? `Sales call with ${displayName}` : 'Sales call');
      await adoptSession(created, displayName, nextView);
    },
    [adoptSession, displayName]
  );

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
        setView('dashboard');
        setBooting(false);
        return;
      } catch (err) {
        const apiError = err as ApiError;
        // Only discard the stored session when the server explicitly rejects it.
        if (apiError?.status === 401 || apiError?.status === 404) clearSalespersonSession();
      }
    }
    try {
      // A fresh visit creates an invitation, so it opens on the invitation screen.
      await createFreshSession('invitation');
    } catch (err) {
      setBootError((err as Error)?.message || 'Could not create a session.');
    }
    if (mountedRef.current) setBooting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createFreshSession]);

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const reconnectAi = () => {
    const engine = engineRef.current;
    if (!engine) {
      setActionError('Start the call before asking the server to restart the AI.');
      return;
    }
    // Salesperson-side recovery is a request: only the customer holds the
    // AI session and the microphone. This never touches the WebRTC audio path.
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

  /**
   * Creates a brand-new, independent session + invitation. An active call is
   * never touched: its engine, peer connection and session stay exactly as they
   * were, and "Back to dashboard" returns to them.
   */
  const createInvitation = async () => {
    setActionError(null);
    try {
      const created = await createSession(displayName ? `Sales call with ${displayName}` : 'Sales call');
      if (!mountedRef.current) return;
      if (!session) {
        await adoptSession(created, displayName, 'invitation');
        return;
      }
      setInviteUrl(created.inviteUrl);
      setInviteExpiresAt(created.inviteExpiresAt);
      setInviteSessionId(created.sessionId);
      setView('invitation');
    } catch (err) {
      setActionError((err as Error)?.message || 'Could not create an invitation.');
    }
  };

  /**
   * Replaces the invitation link of the invitation screen. When the link belongs
   * to the current session this is a rotation on that session (the call is not
   * touched); a link that belongs to another session cannot be rotated from here
   * without affecting that session, so it is replaced by a fresh invitation.
   */
  const regenerateInvite = async () => {
    setActionError(null);
    try {
      if (session && inviteSessionId === session.sessionId) {
        const result = await rotateInvitation(session.sessionId, session.salespersonKey);
        if (!mountedRef.current) return;
        setInviteUrl(result.inviteUrl);
        setInviteExpiresAt(result.inviteExpiresAt);
        setSessionState(result.session);
        return;
      }
      await createInvitation();
    } catch (err) {
      setActionError((err as Error)?.message || 'Could not regenerate the invitation.');
    }
  };

  const backToDashboard = async () => {
    setActionError(null);
    if (!session && inviteUrl && inviteSessionId) {
      // The invitation's session becomes this dashboard's session.
      const stored = loadSalespersonSession();
      if (stored && stored.sessionId === inviteSessionId) {
        setSession(stored);
        setView('dashboard');
        return;
      }
    }
    setView('dashboard');
  };

  const endSession = async () => {
    await stopEngine('session ended by salesperson');
    clearSalespersonSession();
    setSession(null);
    setSessionState(null);
    setInviteUrl(null);
    setInviteExpiresAt(null);
    setInviteSessionId(null);
    try {
      await createFreshSession('invitation');
    } catch (err) {
      setBootError((err as Error)?.message || 'Could not create a session.');
    }
  };

  const callState = callStateLabel(snapshot);
  const micLive = snapshot?.micPermission === 'granted' && snapshot.localTrackState === 'live';
  const latestSuggestion = useMemo(
    () => (snapshot?.suggestions.length ? snapshot.suggestions[snapshot.suggestions.length - 1] : null),
    [snapshot?.suggestions]
  );
  /**
   * AI status shown to the salesperson.
   *
   * The AI session is owned by the server's Modal bridge. `snapshot.ai` is the
   * live state relayed over signaling; `sessionState.ai` is the server's
   * persisted copy (used before the first relay or after a signaling blip).
   * Both are real bridge states, never "the server has an API key".
   */
  const aiView = useMemo(() => {
    const live = snapshot?.ai;
    const polled = sessionState?.ai;
    // `off` is the engine's initial value, not a report. Prefer the polled state
    // in that case so an already-running AI is not briefly shown as "not started".
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
      tone: aiTone(state),
      error: (reported ? reported.error : polled?.error) ?? null,
      connected: Boolean((reported ? reported.connected : polled?.connected) && state === 'connected'),
      reconnecting: state === 'creating' || state === 'connecting' || state === 'reconnecting',
      reconnectAttempt: reported?.reconnectAttempt ?? polled?.reconnectAttempt ?? 0,
      maxReconnectAttempts: reported?.maxReconnectAttempts ?? 3,
      audioReachingAi: Boolean((reported ? reported.audioReachingAi : polled?.audioReachingAi) && state === 'connected'),
      activity: aiActivityLabel(
        reported?.activity ?? (state === 'connected' ? 'listening' : state === 'error' ? 'error' : 'idle')
      ),
      lastResponseAt: reported?.lastSuggestionAt ?? polled?.lastSuggestionAt ?? null,
      callCreated: Boolean(sessionState?.aiCallCreated ?? sessionState?.aiReady),
      callId: reported?.callId ?? null,
      source: liveHasReport ? 'live signaling' : polled?.state ? 'server poll' : 'none',
    };
  }, [snapshot?.ai, sessionState?.ai, sessionState?.aiCallCreated, sessionState?.aiReady]);

  const inviteBelongsToCurrent = Boolean(session && inviteSessionId === session.sessionId);

  if (booting) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950" data-testid="role-salesperson-loading">
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" /> Preparing your sales session...
        </div>
      </div>
    );
  }

  if (!session && view !== 'invitation') {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 p-6" data-testid="role-salesperson-error">
        <div className="max-w-md space-y-3 text-center">
          <AlertCircle className="w-8 h-8 text-rose-400 mx-auto" />
          <h1 className="text-lg font-semibold text-slate-100">Salesperson dashboard unavailable</h1>
          <p className="text-sm text-slate-400">{bootError || 'The session could not be created.'}</p>
          <button
            onClick={() => void createInvitation()}
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
      {/* Mounted in both views so switching screens never interrupts live audio. */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" data-testid="remote-audio" />

      {view === 'invitation' && inviteUrl ? (
        <div className="max-w-lg mx-auto p-4 space-y-4" data-testid="salesperson-invitation">
          <header className="flex items-center gap-2">
            <button
              onClick={() => void backToDashboard()}
              data-testid="back-to-dashboard"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Dashboard
            </button>
          </header>

          <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-indigo-500/15 text-indigo-300">
                <Link2 className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-100">Invitation ready</h1>
                <p className="text-[11px] text-slate-400">
                  Works once, in one browser · {inviteExpiresAt ? `expires in ${timeLeft(inviteExpiresAt)}` : 'single use'}
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-400">
              {session && !inviteBelongsToCurrent
                ? 'This invitation belongs to a new, separate session. Your current call and session are untouched.'
                : 'Send this link to the customer to start the call.'}
            </p>

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
                {copied ? 'Copied' : 'Copy Link'}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void backToDashboard()}
                className="flex-1 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold"
              >
                Back to Dashboard
              </button>
              <button
                onClick={() => void regenerateInvite()}
                data-testid="regenerate-invite"
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold"
                title={
                  session && inviteBelongsToCurrent
                    ? 'Replace this link on the current session (the call is not affected)'
                    : 'Create a fresh invitation for a new session'
                }
              >
                Regenerate link
              </button>
            </div>
          </section>

          {actionError ? (
            <Banner tone="red" title="Action failed" action={<button onClick={() => setActionError(null)} className="underline">dismiss</button>}>
              {actionError}
            </Banner>
          ) : null}
        </div>
      ) : null}

      {view === 'invitation' && inviteUrl ? null : session ? (
        <div className="max-w-4xl mx-auto p-4 space-y-4">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-slate-800 text-slate-200">
                <UserRound className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-100">Salesperson</h1>
                <p className="text-[11px] text-slate-400 font-mono">
                  session {session.sessionId.slice(0, 10)} · expires in {timeLeft(sessionState?.expiresAt ?? null)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => {
                  saveDisplayName(displayName);
                  saveSalespersonSession({ ...session, displayName });
                  setSession({ ...session, displayName });
                }}
                placeholder="Your name"
                className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 outline-none w-28"
                aria-label="Salesperson name"
              />
              {inviteUrl && inviteBelongsToCurrent ? (
                <button
                  onClick={() => setView('invitation')}
                  data-testid="show-invitation"
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5"
                >
                  <Link2 className="w-3.5 h-3.5" /> Invitation
                </button>
              ) : (
                <button
                  onClick={() => void createInvitation()}
                  data-testid="create-invitation"
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <Link2 className="w-3.5 h-3.5" /> New invitation
                </button>
              )}
              <button
                onClick={() => setShowDiagnostics((value) => !value)}
                data-testid="toggle-diagnostics"
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
              >
                Details
              </button>
            </div>
          </header>

          {bootError ? <Banner tone="red" title="Session error">{bootError}</Banner> : null}
          {actionError ? (
            <Banner tone="red" title="Action failed" action={<button onClick={() => setActionError(null)} className="underline">dismiss</button>}>
              {actionError}
            </Banner>
          ) : null}
          {snapshot?.iceConfigError ? (
            <Banner tone="red" title="ICE / TURN configuration problem" testId="ice-error" action={
              <button onClick={() => void restartCall()} className="underline">retry</button>
            }>
              {snapshot.iceConfigError}
            </Banner>
          ) : null}
          {snapshot && !snapshot.turnConfigured && !snapshot.iceConfigError ? (
            <Banner tone="amber" title="TURN relay not configured" testId="turn-warning">
              Audio works only when both devices can reach each other directly. Configure TURN_URLS on the server for
              mobile data or strict NATs.
            </Banner>
          ) : null}
          {snapshot?.diagnostics.iceTransportPolicy === 'relay' && snapshot.relayCandidates === 0 ? (
            <Banner tone="red" title="Relay-only mode: no relay candidates gathered" testId="relay-warning">
              TURN is unreachable or rejected the credentials, so no media path can be established.
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

          {/* The call itself is the visual focus. */}
          <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col items-center gap-3">
            <div
              className={`p-5 rounded-full ${
                engineStarted
                  ? callState.tone === 'emerald'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : callState.tone === 'red'
                      ? 'bg-rose-500/15 text-rose-300'
                      : 'bg-amber-500/15 text-amber-300'
                  : 'bg-slate-800 text-slate-300'
              }`}
            >
              {engineStarted ? <Headphones className="w-10 h-10" /> : <PhoneCall className="w-10 h-10" />}
            </div>
            <p className="text-lg font-semibold text-slate-100" data-testid="call-state">{callState.label}</p>
            <span
              className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${toneClasses(aiView.tone)}`}
              data-testid="ai-state-chip"
            >
              {aiView.label}
            </span>
            <p className="text-xs text-slate-400 text-center">
              {sessionState?.customerConnected ? 'Customer connected' : 'Waiting for the customer to open the invitation'}
              {snapshot?.micPermission === 'granted'
                ? ` · microphone ${micLive ? 'live' : 'ready'}${snapshot.micMuted ? ' (muted)' : ''}`
                : ''}
            </p>


            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {!engineStarted ? (
                <button
                  onClick={() => void startCall()}
                  data-testid="join-call"
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2"
                >
                  <PhoneCall className="w-4 h-4" /> Start call
                </button>
              ) : (
                <>
                  <button
                    onClick={toggleMute}
                    data-testid="mic-toggle"
                    aria-pressed={Boolean(snapshot?.micMuted)}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 ${
                      snapshot?.micMuted ? 'bg-rose-600 hover:bg-rose-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'
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
            </div>

            {engineStarted ? (
              <p className="text-[11px] text-slate-500" data-testid="captions-status">
                {captionStatusLabel(snapshot)}
                {snapshot?.captionStatus === 'unsupported'
                  ? ' — the customer sees the call without captions.'
                  : ''}
              </p>
            ) : null}
          </section>

          {/* AI copilot status: the real server-side Modal session */}
          <Panel
            title="AI copilot status"
            icon={<Sparkles className="w-3.5 h-3.5" />}
            action={
              <button
                onClick={reconnectAi}
                data-testid="ai-reconnect"
                disabled={!engineStarted || !sessionState?.customerConnected}
                title={
                  !engineStarted
                    ? 'Start the call first'
                    : !sessionState?.customerConnected
                      ? 'The customer must be connected to restart the AI'
                      : 'Restart the server-side AI session'
                }
                className="text-[10px] px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold disabled:opacity-40"
              >
                Restart AI
              </button>
            }
          >
            <div className="space-y-1" data-testid="ai-panel">
              <StatusLine
                label="AI session"
                value={aiView.label}
                tone={aiView.tone}
                detail={aiView.error ?? undefined}
                testId="ai-state"
                detailTestId="ai-error"
              />
              <StatusLine
                label="AI activity"
                value={aiView.activity}
                tone={
                  aiView.activity === 'error'
                    ? 'red'
                    : aiView.activity === 'generating' || aiView.activity === 'listening'
                      ? 'emerald'
                      : 'amber'
                }
                testId="ai-activity"
              />
              <StatusLine
                label="Customer voice reaches the AI"
                value={
                  !engineStarted
                    ? 'not started'
                    : aiView.audioReachingAi
                      ? 'yes'
                      : aiView.connected
                        ? 'not yet'
                        : 'no'
                }
                tone={aiView.audioReachingAi ? 'emerald' : 'amber'}
                testId="ai-audio"
              />
              <StatusLine
                label="Last AI response"
                value={aiView.lastResponseAt ? new Date(aiView.lastResponseAt).toLocaleTimeString() : 'none yet'}
                tone={aiView.lastResponseAt ? 'emerald' : 'slate'}
                testId="ai-last-response"
              />
              <StatusLine
                label="AI service call created"
                value={aiView.callCreated ? 'yes (not proof of connection)' : 'no'}
                tone={aiView.callCreated ? 'indigo' : 'slate'}
                detail={`state source: ${aiView.source}${aiView.callId ? ` · call ${aiView.callId.slice(0, 8)}` : ''}`}
                testId="ai-call-created"
              />
              {aiView.reconnecting ? (
                <p className="text-[11px] text-amber-300" data-testid="ai-reconnecting">
                  {aiView.state === 'reconnecting'
                    ? `Reconnecting AI (attempt ${aiView.reconnectAttempt} of ${aiView.maxReconnectAttempts}); the customer call audio is unaffected.`
                    : 'The server is creating/connecting a new AI session…'}
                </p>
              ) : null}
              {snapshot?.aiReconnectRequestedAt && !aiView.reconnecting && !aiView.connected ? (
                <p className="text-[11px] text-slate-400" data-testid="ai-reconnect-pending">
                  Restart requested at {new Date(snapshot.aiReconnectRequestedAt).toLocaleTimeString()}; waiting for the
                  server to confirm the new AI session.
                </p>
              ) : null}
              {!sessionState?.customerConnected ? (
                <p className="text-[11px] text-slate-500">
                  The AI runs on the server and listens to the customer's voice only. It cannot start until the customer is connected.
                </p>
              ) : null}
            </div>
          </Panel>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Customer speech" icon={<UserRound className="w-3.5 h-3.5" />}>
              <div className="space-y-2" data-testid="customer-speech">
                {snapshot?.customerSpeech ? (
                  <p className="text-sm text-slate-100 leading-relaxed">{snapshot.customerSpeech}</p>
                ) : (
                  <p className="text-xs text-slate-500">
                    {sessionState?.customerConnected
                      ? 'Waiting for the customer to speak.'
                      : 'Customer speech appears here once the customer joins.'}
                  </p>
                )}
              </div>
            </Panel>

            <Panel
              title="AI suggestions"
              icon={<Sparkles className="w-3.5 h-3.5" />}
              action={<span className="text-[10px] text-indigo-300 font-semibold">Private · only you</span>}
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
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Suggestions appear here once the customer joins and speaks. They are never shown to the customer.
                </p>
              )}
            </Panel>
          </div>

          {showDiagnostics ? (
            <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" /> Diagnostics
              </h2>
              <div className="grid gap-4 lg:grid-cols-2" data-testid="diagnostics-panel">
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Browser</p>
                  <DiagGrid
                    rows={[
                      ['ws', snapshot?.wsStatus ?? 'not started'],
                      ['pc', snapshot?.diagnostics.pcState ?? 'none'],
                      ['ice', snapshot?.diagnostics.iceState ?? 'none'],
                      ['path', `${snapshot?.diagnostics.selectedLocalType ?? '—'} → ${snapshot?.diagnostics.selectedRemoteType ?? '—'}`],
                      ['mic', snapshot?.localTrackState ?? 'none'],
                      ['remote', snapshot?.diagnostics.remoteTrackState ?? 'none'],
                      ['rtp out', `${snapshot?.diagnostics.bytesSent ?? 0} B`],
                      ['rtp in', `${snapshot?.diagnostics.bytesReceived ?? 0} B`],
                      ['audio flow', snapshot?.diagnostics.audioFlow ?? 'none'],
                      [
                        'audio last in',
                        snapshot?.diagnostics.lastMediaAgoMs === null ||
                        snapshot?.diagnostics.lastMediaAgoMs === undefined
                          ? 'never'
                          : `${Math.round(snapshot.diagnostics.lastMediaAgoMs / 1000)}s ago`,
                      ],
                      ['captions', snapshot?.captionStatus ?? 'off'],
                      ['ice policy', snapshot?.diagnostics.iceTransportPolicy ?? 'unknown'],
                      [
                        'turn',
                        snapshot
                          ? snapshot.turnConfigured
                            ? `configured / ${snapshot.turnCredentialMode}`
                            : 'none — no relay, cross-network audio will fail'
                          : 'unknown',
                      ],
                      ['relay candidates', String(snapshot?.relayCandidates ?? 0)],
                      ['dtls', snapshot?.diagnostics.dtlsState ?? 'none'],
                    ]}
                  />
                  <pre className="text-[10px] leading-4 text-slate-400 bg-slate-950 border border-slate-800 rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                    {snapshot?.logs.length ? snapshot.logs.join('\n') : 'No events yet.'}
                  </pre>
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
                        ['TURN configured', String(serverDiagnostics.ice.configured)],
                        ['TURN credentials', serverDiagnostics.ice.credentialMode],
                        ['storage', serverDiagnostics.diagnostics.storage],
                      ]}
                    />
                  ) : (
                    <p className="text-[11px] text-slate-500">Loading server diagnostics...</p>
                  )}
                  <button
                    onClick={() => void endSession()}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
                  >
                    End session &amp; create new
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default SalespersonDashboard;
