import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, Headphones, Mic, MicOff, PhoneCall, PhoneOff, RefreshCw,
  ShieldCheck, Volume2, VolumeX, UserRound,
} from 'lucide-react';
import { CallEngine, EngineSnapshot } from '../../lib/callEngine';
import { ApiError, RedeemedInvitation, SessionPublicState, redeemInvitation } from '../../lib/sessionApi';
import {
  customerCallLabel,
  customerCallNotice,
  customerInvitationMessage,
} from '../../lib/customerMessages';
import {
  loadCustomerSession, loadResumeToken, saveCustomerSession, saveResumeToken,
} from '../../lib/participantStorage';
import { Banner } from './ui';

const ROLE = 'customer' as const;

/** Tone of the customer status badge, derived from the call state only. */
const callStateTone = (snapshot: EngineSnapshot | null) => {
  const callState = snapshot?.callState ?? 'idle';
  if (callState === 'connected') return snapshot?.mediaFlowing ? ('emerald' as const) : ('amber' as const);
  if (callState === 'failed' || callState === 'mic_denied' || callState === 'rejected') return 'red' as const;
  if (callState === 'ended') return 'slate' as const;
  return 'amber' as const;
};

export const CustomerDashboard: React.FC<{ inviteToken: string; legacyInvitation?: boolean }> = ({
  inviteToken,
  legacyInvitation = false,
}) => {
  const [status, setStatus] = useState<'loading' | 'invalid' | 'ready'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState<RedeemedInvitation | null>(null);
  const [sessionState, setSessionState] = useState<SessionPublicState | null>(null);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [joined, setJoined] = useState(false);
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
      setErrorMessage(customerInvitationMessage('LEGACY_LINK'));
      return;
    }
    if (!inviteToken) {
      setStatus('invalid');
      setErrorMessage('No invitation was found. Open the link the salesperson sent you.');
      return;
    }

    setStatus('loading');
    setErrorMessage(null);
    try {
      const stored = loadCustomerSession(inviteToken);
      const result = await redeemInvitation(inviteToken, stored?.customerKey);
      if (!mountedRef.current) return;
      // A 2xx response without the fields the screen needs must not be treated
      // as success: rendering with a partial payload would crash the tree.
      if (!result || typeof result.sessionId !== 'string' || typeof result.customerKey !== 'string') {
        setStatus('invalid');
        setErrorMessage(
          'We could not open this invitation. Please try again or ask the salesperson for a new link.'
        );
        return;
      }
      saveCustomerSession(inviteToken, { sessionId: result.sessionId, customerKey: result.customerKey });
      setRedeemed(result);
      setSessionState(result.session ?? null);
      setStatus('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      // Only a mapped, customer-safe sentence is stored. The API code/message is
      // never rendered, so a raw server response cannot reach this screen.
      const apiError = err as ApiError;
      setStatus('invalid');
      setErrorMessage(customerInvitationMessage(apiError?.code));
    }
  }, [inviteToken, legacyInvitation]);

  useEffect(() => {
    void redeem();
  }, [redeem]);

  /**
   * AI recovery is internal bookkeeping. The customer screen never renders AI
   * status, errors, transcripts or suggestions; if the AI session drops it is
   * retried a few times in the background and the human call is unaffected.
   *
   * NOTE: this hook must stay ABOVE the loading/invalid early returns. A hook
   * after them changes the hook order once the invitation resolves, which makes
   * React unmount the tree and leaves the customer with a blank page.
   */
  const aiRetriesRef = useRef(0);
  useEffect(() => {
    if (!joined || snapshot?.aiStatus !== 'error') return;
    if (aiRetriesRef.current >= 3) return;
    const timer = window.setTimeout(() => {
      aiRetriesRef.current += 1;
      void engineRef.current?.retryAi();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [joined, snapshot?.aiStatus]);

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

  const callState = { label: customerCallLabel(snapshot?.callState), tone: callStateTone(snapshot) };
  const customerNotice = customerCallNotice(snapshot?.callState);
  const salespersonConnected = Boolean(snapshot?.peerParticipantId);
  const captionText = snapshot?.salespersonCaption ?? '';

  return (
    <div className="min-h-screen bg-slate-950" data-testid="role-customer">
      <audio ref={audioRef} autoPlay playsInline className="hidden" data-testid="remote-audio" />

      <div className="max-w-xl mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-slate-800 text-slate-200">
              <UserRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100">Customer call</h1>
              {customerName ? <p className="text-[11px] text-slate-400">{customerName}</p> : null}
            </div>
          </div>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
              callState.tone === 'emerald'
                ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                : callState.tone === 'amber'
                  ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                  : callState.tone === 'red'
                    ? 'border-rose-500/40 text-rose-300 bg-rose-500/10'
                    : 'border-slate-700 text-slate-400 bg-slate-900'
            }`}
            data-testid="call-state"
          >
            {callState.label}
          </span>
        </header>

        {snapshot?.diagnostics.iceTransportPolicy === 'relay' && snapshot.relayCandidates === 0 ? (
          <Banner tone="red" title="Audio could not start" testId="relay-warning">
            We could not establish audio on this network. Check your connection and try Reconnect.
          </Banner>
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
        {joined && customerNotice ? (
          <Banner
            tone={snapshot?.callState === 'failed' ? 'red' : 'amber'}
            title={snapshot?.callState === 'failed' ? 'Unable to connect' : 'Call status'}
            testId={snapshot?.callState === 'failed' ? 'ice-error' : 'customer-notice'}
          >
            {customerNotice}
          </Banner>
        ) : null}


        {!joined ? (
          <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4" data-testid="customer-prejoin">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-100">You are invited to a live call</h2>
              <p className="text-xs text-slate-400">
                Your microphone is used for the live conversation with the salesperson. Nothing is recorded by this
                page.
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

            <p className="text-xs text-slate-400">
              Salesperson: {sessionState?.salespersonConnected ? 'connected and waiting' : 'not connected yet'}
            </p>

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
          <>
            <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col items-center gap-3">
              <div
                className={`p-5 rounded-full ${
                  callState.tone === 'emerald'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : callState.tone === 'red'
                      ? 'bg-rose-500/15 text-rose-300'
                      : 'bg-slate-800 text-slate-300'
                }`}
              >
                <Headphones className="w-10 h-10" />
              </div>
              <p className="text-sm font-semibold text-slate-100">
                {salespersonConnected ? 'Connected to the salesperson' : 'Waiting for the salesperson'}
              </p>
              <p className="text-xs text-slate-400 text-center">
                {snapshot?.mediaFlowing && !snapshot?.speakerMuted
                  ? 'Audio is flowing.'
                  : 'Keep this page open to stay in the call.'}
              </p>

              <div className="flex flex-wrap justify-center gap-2 pt-1">
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
                  className="px-4 py-2 rounded-xl bg-rose-600/90 hover:bg-rose-500 text-white text-sm font-semibold flex items-center gap-2"
                >
                  <PhoneOff className="w-4 h-4" /> Leave
                </button>
              </div>

              <p className="text-[11px] text-slate-500" data-testid="customer-mic-status">
                Microphone:{' '}
                {snapshot?.micMuted
                  ? 'muted'
                  : snapshot?.micPermission === 'granted'
                    ? 'on'
                    : snapshot?.micPermission === 'denied'
                      ? 'blocked'
                      : 'not available yet'}
              </p>
            </section>

            <section className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-2" data-testid="customer-captions">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Salesperson captions</h2>
              {captionText ? (
                <p className="text-sm text-slate-100 leading-relaxed" data-testid="salesperson-caption">
                  {captionText}
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Captions appear here when the salesperson's browser supports live speech recognition.
                </p>
              )}
            </section>
          </>
        )}

        <p className="text-[10px] text-slate-600 text-center pb-6">Secure session</p>
      </div>
    </div>
  );
};

export default CustomerDashboard;
