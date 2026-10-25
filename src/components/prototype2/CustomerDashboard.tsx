import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, Bot, Headphones, Mic, MicOff, PhoneCall, PhoneOff, RefreshCw,
  ShieldCheck, Sparkles, Volume2, VolumeX, Activity, UserRound,
} from 'lucide-react';
import { CallEngine, EngineSnapshot } from '../../lib/callEngine';
import { aiStateLabel, aiTone } from '../../lib/aiStatus';
import { ApiError, RedeemedInvitation, SessionPublicState, redeemInvitation } from '../../lib/sessionApi';
import {
  loadCustomerSession, loadResumeToken, saveCustomerSession, saveResumeToken,
} from '../../lib/participantStorage';
import { Banner, DiagGrid, Panel, StatusLine } from './ui';

const ROLE = 'customer' as const;

const callStateLabel = (snapshot: EngineSnapshot | null) => {
  const callState = snapshot?.callState ?? 'idle';
  switch (callState) {
    case 'connected':
      return snapshot?.mediaFlowing
        ? { label: 'Audio flowing', tone: 'emerald' as const }
        : { label: 'Connected — waiting for media', tone: 'amber' as const };
    case 'connecting': return { label: 'Connecting', tone: 'amber' as const };
    case 'waiting': return { label: 'Waiting for salesperson', tone: 'amber' as const };
    case 'requesting_mic': return { label: 'Microphone permission', tone: 'amber' as const };
    case 'reconnecting': return { label: 'Reconnecting', tone: 'amber' as const };
    case 'failed': return { label: 'Connection failed', tone: 'red' as const };
    case 'mic_denied': return { label: 'Microphone blocked', tone: 'red' as const };
    case 'rejected': return { label: 'Invitation rejected', tone: 'red' as const };
    case 'disconnected': return { label: 'Salesperson disconnected', tone: 'red' as const };
    case 'ended': return { label: 'Call ended', tone: 'slate' as const };
    default: return { label: 'Not joined', tone: 'slate' as const };
  }
};

export const CustomerDashboard: React.FC<{ inviteToken: string; legacyInvitation?: boolean }> = ({
  inviteToken,
  legacyInvitation = false,
}) => {
  const [status, setStatus] = useState<'loading' | 'invalid' | 'ready'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState<RedeemedInvitation | null>(null);
  const [sessionState, setSessionState] = useState<SessionPublicState | null>(null);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [joined, setJoined] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [customerName, setCustomerName] = useState('');

  const engineRef = useRef<CallEngine | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void engineRef.current?.stop('customer dashboard unmounted');
      engineRef.current = null;
    };
  }, []);

  // Exposed for diagnostics tooling and automated browser tests (read-only).
  useEffect(() => {
    (window as any).__prototype2 = {
      role: 'customer',
      getSnapshot: () => engineRef.current?.getSnapshot() ?? null,
      getSessionId: () => redeemed?.sessionId ?? null,
    };
    return () => {
      delete (window as any).__prototype2;
    };
  }, [redeemed]);

  const redeem = useCallback(async () => {
    if (legacyInvitation) {
      setStatus('invalid');
      setErrorCode('LEGACY_LINK');
      setErrorMessage(
        'This link is not a valid invitation. Ask the salesperson to send the invitation link from their dashboard.'
      );
      return;
    }
    if (!inviteToken) {
      setStatus('invalid');
      setErrorCode('MISSING_INVITATION');
      setErrorMessage('No invitation token was provided. Open the link the salesperson sent you.');
      return;
    }

    setStatus('loading');
    setErrorMessage(null);
    try {
      const stored = loadCustomerSession(inviteToken);
      const result = await redeemInvitation(inviteToken, stored?.customerKey);
      if (!mountedRef.current) return;
      saveCustomerSession(inviteToken, { sessionId: result.sessionId, customerKey: result.customerKey });
      setRedeemed(result);
      setSessionState(result.session);
      setStatus('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      const apiError = err as ApiError;
      setStatus('invalid');
      setErrorCode(apiError?.code || 'INVITE_INVALID');
      setErrorMessage(apiError?.message || 'This invitation could not be used.');
    }
  }, [inviteToken, legacyInvitation]);

  useEffect(() => {
    void redeem();
  }, [redeem]);

  const joinCall = async () => {
    if (!redeemed || engineRef.current) return;
    setErrorMessage(null);
    const engine = new CallEngine({
      sessionId: redeemed.sessionId,
      role: ROLE,
      credential: redeemed.customerKey,
      resumeToken: loadResumeToken(redeemed.sessionId, ROLE),
      enableAi: true,
      onUpdate: (next) => {
        if (mountedRef.current) setSnapshot(next);
      },
      onResumeToken: (token) => saveResumeToken(redeemed.sessionId, ROLE, token),
    });
    engine.attachAudioElement(audioRef.current);
    engineRef.current = engine;
    setJoined(true);
    await engine.start();
  };

  const leaveCall = async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    setJoined(false);
    if (engine) await engine.stop('customer left the call');
  };

  const rejoin = async () => {
    await leaveCall();
    await joinCall();
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

  const retryAi = () => {
    void engineRef.current?.retryAi();
  };

  if (status === 'loading') {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950" data-testid="role-customer-loading">
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" /> Checking your invitation...
        </div>
      </div>
    );
  }

  if (status === 'invalid') {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950 p-6" data-testid="role-customer-invalid">
        <div className="max-w-md space-y-3 text-center">
          <AlertCircle className="w-8 h-8 text-rose-400 mx-auto" />
          <h1 className="text-lg font-semibold text-slate-100">This invitation cannot be used</h1>
          <p className="text-sm text-slate-400">{errorMessage}</p>
          {errorCode ? <p className="text-[11px] font-mono text-slate-600">code: {errorCode}</p> : null}
          <button
            onClick={() => void redeem()}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-semibold"
          >
            Check again
          </button>
        </div>
      </div>
    );
  }

  const callState = callStateLabel(snapshot);
  const salespersonConnected = Boolean(snapshot?.peerParticipantId);
  const incomingLive = Boolean(snapshot && snapshot.mediaFlowing && !snapshot.speakerMuted);
  const latestAi = [...(snapshot?.suggestions ?? [])].reverse().find((item) => item.text) ?? null;

  return (
    <div className="min-h-screen overflow-y-auto bg-slate-950" data-testid="role-customer">
      <audio ref={audioRef} autoPlay playsInline className="hidden" data-testid="remote-audio" />

      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-emerald-600 to-cyan-500 text-white">
              <UserRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100">Customer call</h1>
              <p className="text-[11px] text-slate-400 font-mono">
                {customerName ? `${customerName} · ` : ''}session {redeemed?.sessionId.slice(0, 10)}
              </p>
            </div>
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
        </header>

        {snapshot?.iceConfigError ? (
          <Banner tone="red" title="ICE / TURN configuration problem" testId="ice-error">
            {snapshot.iceConfigError}
          </Banner>
        ) : null}
        {snapshot && !snapshot.turnConfigured && !snapshot.iceConfigError ? (
          <Banner tone="amber" title="TURN relay not configured" testId="turn-warning">
            The call may stay silent on mobile data or strict NATs. The operator must configure TURN on the server.
          </Banner>
        ) : null}
        {snapshot?.diagnostics.iceTransportPolicy === 'relay' && snapshot.relayCandidates === 0 ? (
          <Banner tone="red" title="No relay path available" testId="relay-warning">
            Relay-only mode is enabled but this network could not reach the TURN server. Check your connection or ask
            the salesperson to verify the TURN configuration.
          </Banner>
        ) : null}
        {snapshot?.iceConfigWarnings.length && !snapshot.iceConfigError ? (
          <Banner tone="amber" title="ICE warning">{snapshot.iceConfigWarnings[0]}</Banner>
        ) : null}

        {snapshot?.playbackBlocked ? (
          <Banner
            tone="amber"
            title="Salesperson audio is blocked"
            action={
              <button
                onClick={() => void engineRef.current?.resumePlayback()}
                className="px-3 py-1 rounded-lg bg-amber-500 text-slate-950 font-semibold"
              >
                Enable audio
              </button>
            }
          >
            Tap Enable audio to allow the call to play through this device.
          </Banner>
        ) : null}
        {snapshot?.lastError ? <Banner tone="red" title="Connection problem">{snapshot.lastError}</Banner> : null}
        {snapshot?.lastServerError ? (
          <Banner tone="amber" title="Server signaling error">{snapshot.lastServerError}</Banner>
        ) : null}

        {!joined ? (
          <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4" data-testid="customer-prejoin">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-100">You are invited to a live product call</h2>
              <p className="text-xs text-slate-400">
                Your microphone is used for two things: an AI assistant that helps the salesperson, and the live
                conversation with the salesperson. Nothing is recorded by this page.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold" htmlFor="customer-name">
                Your name (optional)
              </label>
              <input
                id="customer-name"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="Customer name"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-cyan-600"
              />
            </div>

            <div className="text-xs text-slate-400 space-y-1">
              <p>Salesperson: {sessionState?.salespersonConnected ? 'connected and waiting' : 'not connected yet'}</p>
              <p>Invitation status: {sessionState?.invitationStatus ?? 'unknown'}</p>
            </div>

            <button
              onClick={() => void joinCall()}
              data-testid="join-call"
              className="w-full px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold flex items-center justify-center gap-2"
            >
              <PhoneCall className="w-4 h-4" /> Join call with microphone
            </button>
            <p className="text-[10px] text-slate-500 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Your browser will ask for microphone permission now.
            </p>
          </section>
        ) : (
          <div className="flex flex-wrap gap-2">
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
              {snapshot?.speakerMuted ? 'Unmute salesperson' : 'Mute salesperson'}
            </button>
            <button
              onClick={() => void rejoin()}
              data-testid="reconnect"
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" /> Reconnect
            </button>
            <button
              onClick={() => void leaveCall()}
              data-testid="leave-call"
              className="px-4 py-2 rounded-xl bg-rose-600/90 hover:bg-rose-500 text-white text-sm font-semibold flex items-center gap-2 ml-auto"
            >
              <PhoneOff className="w-4 h-4" /> Leave
            </button>
          </div>
        )}

        {joined ? (
          <div className="flex items-center gap-2 bg-slate-900/70 border border-slate-800 rounded-2xl px-3 py-2">
            <Mic className="w-4 h-4 text-slate-500" />
            <span className="text-[11px] text-slate-400">
              Microphone: {snapshot?.micPermission === 'granted' ? (snapshot.micMuted ? 'muted' : 'live') : snapshot?.micPermission ?? 'unknown'}
            </span>
            <span className="text-[11px] text-slate-600">·</span>
            <span className="text-[11px] text-slate-400">
              AI: {snapshot ? aiStateLabel(snapshot.ai.state) : 'not started'}
            </span>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Panel title="Connection & audio" icon={<Activity className="w-3.5 h-3.5" />}>
            <div className="space-y-1">
              <StatusLine
                label="Signaling"
                value={snapshot?.wsStatus ?? 'not started'}
                tone={snapshot?.wsStatus === 'connected' ? 'emerald' : snapshot?.wsStatus === 'reconnecting' ? 'amber' : 'slate'}
              />
              <StatusLine
                label="Salesperson"
                value={salespersonConnected ? 'connected' : 'waiting'}
                tone={salespersonConnected ? 'emerald' : 'slate'}
              />
              <StatusLine
                label="Your microphone"
                value={
                  snapshot?.micPermission !== 'granted'
                    ? 'not granted'
                    : snapshot.micMuted
                      ? 'muted'
                      : snapshot.localTrackState === 'live'
                        ? 'live'
                        : 'stopped'
                }
                tone={snapshot?.micPermission === 'granted' && !snapshot?.micMuted && snapshot?.localTrackState === 'live' ? 'emerald' : snapshot?.micMuted ? 'amber' : 'red'}
              />
              <StatusLine
                label="Salesperson voice"
                value={
                  !salespersonConnected
                    ? 'not connected'
                    : snapshot?.speakerMuted
                      ? 'muted locally'
                      : snapshot?.playbackBlocked
                        ? 'blocked by browser'
                        : incomingLive
                          ? `live · ${snapshot?.diagnostics.receiveBitrateKbps} kbps`
                          : 'waiting for media'
                }
                tone={incomingLive ? 'emerald' : snapshot?.playbackBlocked ? 'red' : 'amber'}
                detail={snapshot ? `rtp in ${snapshot.diagnostics.bytesReceived} B / out ${snapshot.diagnostics.bytesSent} B` : undefined}
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
              />
            </div>
          </Panel>

          <Panel
            title="AI assistant"
            icon={<Bot className="w-3.5 h-3.5" />}
            action={
              <button
                onClick={retryAi}
                disabled={!joined}
                className="text-[10px] px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold disabled:opacity-40"
              >
                Restart AI
              </button>
            }
          >
            <div className="space-y-2" data-testid="ai-status">
              <StatusLine
                label="AI session"
                value={snapshot ? aiStateLabel(snapshot.ai.state) : 'not started'}
                tone={snapshot ? aiTone(snapshot.ai.state) : 'slate'}
                detail={snapshot?.ai.error ?? undefined}
                testId="customer-ai-state"
                detailTestId="customer-ai-error"
              />
              <StatusLine
                label="Your voice reaches the AI"
                value={
                  !snapshot
                    ? 'unknown'
                    : snapshot.ai.audioReachingAi
                      ? 'yes'
                      : snapshot.ai.connected
                        ? 'not yet'
                        : 'no'
                }
                tone={snapshot?.ai.audioReachingAi ? 'emerald' : 'amber'}
                testId="customer-ai-audio"
              />
              {snapshot?.ai.reconnecting ? (
                <p className="text-[11px] text-amber-300" data-testid="customer-ai-reconnecting">
                  Reconnecting AI (attempt {snapshot.ai.reconnectAttempt} of {snapshot.ai.maxReconnectAttempts})…
                  the call audio is unaffected.
                </p>
              ) : null}
              {snapshot?.ai.lastSuggestionAt ? (
                <p className="text-[11px] text-slate-500" data-testid="customer-ai-last-response">
                  Last AI response: {new Date(snapshot.ai.lastSuggestionAt).toLocaleTimeString()}
                </p>
              ) : null}
              {snapshot?.customerSpeech ? (
                <p className="text-[11px] text-slate-400 border-t border-slate-800 pt-2">
                  AI heard: <span className="text-slate-200">{snapshot.customerSpeech}</span>
                </p>
              ) : (
                <p className="text-[11px] text-slate-500">
                  Speak normally. The AI transcribes your words and sends ready-to-read suggestions to the salesperson.
                </p>
              )}
              {latestAi ? (
                <p className="text-[11px] text-slate-400 border-t border-slate-800 pt-2">
                  <Sparkles className="w-3 h-3 inline mr-1 text-indigo-300" />
                  AI suggested to the salesperson: <span className="text-slate-300">{latestAi.text}</span>
                </p>
              ) : null}
              <p className="text-[10px] text-slate-500 border-t border-slate-800 pt-2 flex items-start gap-1">
                <Headphones className="w-3 h-3 mt-0.5 shrink-0" />
                The AI replies as text in this prototype so it never speaks over the salesperson.
              </p>
            </div>
          </Panel>
        </div>

        {joined ? (
          <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" /> Diagnostics
              </h2>
              <button
                onClick={() => setShowDiagnostics((value) => !value)}
                data-testid="toggle-diagnostics"
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold"
              >
                {showDiagnostics ? 'Hide details' : 'Show details'}
              </button>
            </div>
            {showDiagnostics ? (
              <div className="space-y-2" data-testid="diagnostics-panel">
                <DiagGrid
                  rows={[
                    ['role', 'customer'],
                    ['participant', snapshot?.participantId?.slice(0, 10) ?? '—'],
                    ['ws', snapshot?.wsStatus ?? 'not started'],
                    ['pc', snapshot?.diagnostics.pcState ?? 'none'],
                    ['ice', snapshot?.diagnostics.iceState ?? 'none'],
                    ['path', `${snapshot?.diagnostics.selectedLocalType ?? '—'} → ${snapshot?.diagnostics.selectedRemoteType ?? '—'}`],
                    ['mic perm', snapshot?.micPermission ?? 'unknown'],
                    ['mic track', snapshot?.diagnostics.localTrackState ?? 'none'],
                    ['senders', String(snapshot?.diagnostics.localSenderCount ?? 0)],
                    ['remote', snapshot?.diagnostics.remoteTrackState ?? 'none'],
                    ['rtp out', `${snapshot?.diagnostics.bytesSent ?? 0} B`],
                    ['rtp in', `${snapshot?.diagnostics.bytesReceived ?? 0} B`],
                    ['playback', snapshot?.diagnostics.audioElementPaused ? 'paused' : 'playing'],
                    ['autoplay error', snapshot?.diagnostics.playbackError ?? 'none'],
                    ['ice config', snapshot?.iceConfigLoaded ? 'loaded (session auth)' : snapshot?.iceConfigError ? 'error' : 'not loaded'],
                    ['ice policy', snapshot?.diagnostics.iceTransportPolicy ?? 'unknown'],
                    ['turn', snapshot ? `${snapshot.turnConfigured ? 'configured' : 'none'} / ${snapshot.turnCredentialMode}` : 'unknown'],
                    ['relay candidates', String(snapshot?.relayCandidates ?? 0)],
                    ['selected pair', snapshot?.selectedPair ?? 'none'],
                    ['dtls', snapshot?.diagnostics.dtlsState ?? 'none'],
                    ['media flowing', snapshot?.mediaFlowing ? 'yes (RTP received)' : 'no RTP yet'],
                    ['ai', snapshot ? aiStateLabel(snapshot.ai.state) : 'not started'],
                    ['ai sdk status', String(snapshot?.ai.status ?? 'none')],
                    ['ai call id', snapshot?.ai.callId ? `${snapshot.ai.callId.slice(0, 10)}…` : 'none'],
                    ['ai audio in', snapshot?.ai.audioReachingAi ? 'yes' : 'no'],
                    ['ai reconnect', `${snapshot?.ai.reconnectAttempt ?? 0}/${snapshot?.ai.maxReconnectAttempts ?? 0}`],
                    ['ai last response', snapshot?.ai.lastSuggestionAt ? new Date(snapshot.ai.lastSuggestionAt).toLocaleTimeString() : 'none'],
                    ['reconnects', String(snapshot?.reconnectAttempt ?? 0)],
                  ]}
                />
                <pre className="text-[10px] leading-4 text-slate-400 bg-slate-950 border border-slate-800 rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap">
                  {snapshot?.logs.length ? snapshot.logs.join('\n') : 'No events yet.'}
                </pre>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                Signaling, ICE, RTP byte counters, microphone state and playback errors are available here.
              </p>
            )}
          </section>
        ) : null}

        <p className="text-[10px] text-slate-600 text-center pb-6">
          Prototype 2 · session-scoped, server-authorized conversation
        </p>
      </div>
    </div>
  );
};

export default CustomerDashboard;
