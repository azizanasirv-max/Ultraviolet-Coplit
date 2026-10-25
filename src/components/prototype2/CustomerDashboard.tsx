import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { CallEngine, EngineSnapshot } from '../../lib/callEngine';
import { buildCustomerCallView, CustomerTranscriptState } from '../../lib/customerCallView';
import { RedeemedInvitation, ApiError, redeemInvitation } from '../../lib/sessionApi';
import {
  loadCustomerSession, loadResumeToken, saveCustomerSession, saveResumeToken,
} from '../../lib/participantStorage';
import { CustomerCallScreen } from './CustomerCallScreen';

const ROLE = 'customer' as const;

/**
 * Customer dashboard.
 *
 * Owns the call lifecycle (invitation redemption, engine start/stop, controls)
 * and renders `CustomerCallScreen` from a `CustomerCallView`. The AI session
 * that this device hosts is an implementation detail of the salesperson's
 * assistant: no AI suggestions, AI state, provider errors, reconnect counters
 * or diagnostics are read here.
 */
export const CustomerDashboard: React.FC<{ inviteToken: string; legacyInvitation?: boolean }> = ({
  inviteToken,
  legacyInvitation = false,
}) => {
  const [status, setStatus] = useState<'loading' | 'invalid' | 'ready'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState<RedeemedInvitation | null>(null);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** True once this page has joined (stays true after the call ends). */
  const [joined, setJoined] = useState(false);

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

  // Read-only hook for diagnostics tooling and automated tests.
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

  const joinCall = useCallback(async () => {
    if (!redeemed || engineRef.current) return;
    setErrorMessage(null);
    const engine = new CallEngine({
      sessionId: redeemed.sessionId,
      role: ROLE,
      credential: redeemed.customerKey,
      resumeToken: loadResumeToken(redeemed.sessionId, ROLE),
      // Only the customer device publishes a microphone to the AI.
      enableAi: true,
      onUpdate: (next) => {
        if (mountedRef.current) setSnapshot(next);
      },
      onResumeToken: (token) => saveResumeToken(redeemed.sessionId, ROLE, token),
    });
    engine.attachAudioElement(audioRef.current);
    engineRef.current = engine;
    setJoined(true);
    setJoinedAt(Date.now());
    await engine.start();
  }, [redeemed]);

  const leaveCall = useCallback(async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) await engine.stop('customer ended the call');
  }, []);

  const reconnect = useCallback(async () => {
    await leaveCall();
    await joinCall();
  }, [joinCall, leaveCall]);

  const toggleMute = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !snapshot) return;
    engine.setMicMuted(!snapshot.micMuted);
  }, [snapshot]);

  const toggleSpeaker = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !snapshot) return;
    if (snapshot.playbackBlocked) {
      void engine.resumePlayback();
      return;
    }
    engine.setSpeakerMuted(!snapshot.speakerMuted);
  }, [snapshot]);

  // Call timer: only ticks while the human call is actually connected.
  useEffect(() => {
    if (snapshot?.callState !== 'connected') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.callState]);

  const durationSeconds = useMemo(
    () => (joinedAt ? Math.max(0, Math.floor((now - joinedAt) / 1000)) : null),
    [joinedAt, now]
  );

  const transcriptState: CustomerTranscriptState = useMemo(() => {
    if (!snapshot) return 'idle';
    if (snapshot.callState === 'ended') return 'ended';
    if (snapshot.transcript.peerState === 'unavailable') return 'unavailable';
    if (snapshot.transcript.peerState === 'live' || snapshot.salespersonTranscript.length) return 'live';
    return 'idle';
  }, [snapshot]);

  const view = useMemo(
    () =>
      buildCustomerCallView({
        snapshot,
        sessionLabel: redeemed?.session.label ?? null,
        durationSeconds,
        transcriptState,
        joined,
      }),
    [snapshot, redeemed, durationSeconds, transcriptState, joined]
  );

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950" data-testid="role-customer-loading">
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" /> Checking your invitation…
        </div>
      </div>
    );
  }

  if (status === 'invalid') {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-slate-950 p-6"
        data-testid="role-customer-invalid"
      >
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

  return (
    <>
      {/* Remote salesperson audio: one hidden element, attached once. */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" data-testid="remote-audio" />
      <CustomerCallScreen
        view={view}
        onJoin={() => void joinCall()}
        onMuteToggle={toggleMute}
        onSpeakerToggle={toggleSpeaker}
        onEndCall={() => void leaveCall()}
        onReconnect={() => void reconnect()}
      />
    </>
  );
};

export default CustomerDashboard;
