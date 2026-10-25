import React from 'react';
import {
  Lock,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { CustomerCallView } from '../../lib/customerCallView';
import { formatDuration } from '../../lib/customerCallView';
import type { SpeechSegment } from '../../lib/transcript';

/**
 * Pure customer call screen: a familiar audio-call layout and nothing else.
 *
 * It receives a `CustomerCallView` (call fields only), so there is no AI
 * suggestion, AI status or internal diagnostics prop to render. Privacy is a
 * property of the type, not of CSS.
 */
export interface CustomerCallScreenProps {
  view: CustomerCallView;
  onJoin: () => void;
  onMuteToggle: () => void;
  onSpeakerToggle: () => void;
  onEndCall: () => void;
  onReconnect: () => void;
}

const initialsFor = (label: string): string =>
  label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'S';

const phaseTone = (phase: CustomerCallView['phase']): string => {
  switch (phase) {
    case 'connected':
      return 'text-emerald-300';
    case 'waiting':
    case 'connecting':
    case 'requesting_mic':
    case 'reconnecting':
      return 'text-amber-300';
    case 'error':
      return 'text-rose-300';
    default:
      return 'text-slate-300';
  }
};

const Transcript: React.FC<{ view: CustomerCallView }> = ({ view }) => {
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const count = view.transcript.length;

  React.useEffect(() => {
    // Only scroll inside the transcript box; never move the page.
    const element = endRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [count, view.transcript[count - 1]?.text]);

  const statusText =
    view.transcriptState === 'unavailable'
      ? 'Live transcript is not available for this call.'
      : view.transcriptState === 'live'
        ? 'Live'
        : 'Waiting for the salesperson to speak';

  return (
    <section
      className="w-full rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm"
      data-testid="customer-transcript"
      aria-label="Live transcript of the salesperson"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/10">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          Transcript
        </h2>
        <span
          className={`flex items-center gap-1.5 text-[11px] font-medium ${
            view.transcriptState === 'live' ? 'text-emerald-300' : 'text-slate-400'
          }`}
          data-testid="customer-transcript-status"
        >
          <Radio className="w-3 h-3" />
          {statusText}
        </span>
      </header>
      <div
        className="px-4 py-3 max-h-40 sm:max-h-56 overflow-y-auto overscroll-contain space-y-2 text-[15px] leading-relaxed"
        data-testid="customer-transcript-scroll"
      >
        {count === 0 ? (
          <p className="text-slate-400" data-testid="customer-transcript-empty">
            {view.transcriptState === 'unavailable'
              ? 'The salesperson’s browser cannot provide a live transcript. You can still hear the call.'
              : `When ${view.salespersonLabel} speaks, their words appear here.`}
          </p>
        ) : (
          view.transcript.map((segment: SpeechSegment) => (
            <p
              key={segment.ordinal}
              data-testid="customer-transcript-segment"
              data-final={segment.isFinal ? 'true' : 'false'}
              className={segment.isFinal ? 'text-slate-100' : 'text-slate-400 italic'}
            >
              {segment.text}
              {segment.isFinal ? null : (
                <span className="sr-only"> (in progress)</span>
              )}
            </p>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
};

/** Round call control; 48px+ touch target, labelled for Assistive Tech. */
const CallButton: React.FC<{
  onClick: () => void;
  label: string;
  testId: string;
  tone?: 'neutral' | 'active' | 'danger';
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onClick, label, testId, tone = 'neutral', disabled, children }) => {
  const styles =
    tone === 'danger'
      ? 'bg-rose-500 hover:bg-rose-400 text-white'
      : tone === 'active'
        ? 'bg-white text-slate-900 hover:bg-slate-200'
        : 'bg-white/10 text-slate-100 hover:bg-white/20';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={tone === 'active' ? true : undefined}
      title={label}
      data-testid={testId}
      className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${styles}`}
    >
      {children}
    </button>
  );
};

export const CustomerCallScreen: React.FC<CustomerCallScreenProps> = ({
  view,
  onJoin,
  onMuteToggle,
  onSpeakerToggle,
  onEndCall,
  onReconnect,
}) => {
  const connected = view.phase === 'connected';
  const initials = initialsFor(view.salespersonLabel);

  return (
    <div
      className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100 flex flex-col"
      data-testid="role-customer"
    >
      <header className="flex items-center justify-between px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-slate-300">
          <Lock className="w-4 h-4" aria-hidden="true" />
          <span className="text-xs font-medium tracking-wide">Secure audio call</span>
        </div>
        <span className={`text-xs font-semibold ${phaseTone(view.phase)}`} data-testid="call-state">
          {view.headline}
        </span>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 pb-6 flex flex-col items-center gap-5 sm:gap-6">
        {view.notice ? (
          <div
            role="alert"
            data-testid="customer-notice"
            className={`w-full rounded-xl border px-4 py-3 text-sm ${
              view.notice.tone === 'red'
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-100'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-100'
            }`}
          >
            <p className="font-semibold">{view.notice.title}</p>
            <p className="mt-0.5 text-[13px] opacity-90">{view.notice.message}</p>
          </div>
        ) : null}

        {!view.canJoin ? (
          <>
            <div className="pt-2 sm:pt-6 flex flex-col items-center text-center gap-3">
              <div className="relative" data-testid="salesperson-avatar">
                <div
                  className={`w-28 h-28 sm:w-32 sm:h-32 rounded-full flex items-center justify-center text-3xl font-semibold tracking-wide text-white bg-gradient-to-br from-indigo-500 to-cyan-500 ${
                    connected ? 'ring-4 ring-emerald-400/30' : ''
                  }`}
                  aria-hidden="true"
                >
                  {initials}
                </div>
                {connected ? (
                  <span className="absolute inset-0 rounded-full border-2 border-emerald-400/40 animate-ping" />
                ) : null}
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-semibold" data-testid="salesperson-name">
                  {view.salespersonLabel}
                </h1>
                <p className="text-sm text-slate-400 mt-1" data-testid="call-status">
                  {view.detail}
                </p>
              </div>
              <p
                className="text-sm font-mono text-slate-300 tabular-nums"
                data-testid="call-duration"
                aria-live="off"
              >
                {view.durationSeconds !== null ? formatDuration(view.durationSeconds) : '—'}
              </p>
            </div>

            {connected || view.phase === 'reconnecting' ? <Transcript view={view} /> : null}
          </>
        ) : (
          <section
            className="w-full mt-4 sm:mt-10 rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-7 text-center"
            data-testid="customer-prejoin"
          >
            <div className="w-16 h-16 mx-auto rounded-full bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center text-xl font-semibold">
              {initials}
            </div>
            <h1 className="mt-4 text-xl font-semibold">Call with {view.salespersonLabel}</h1>
            <p className="mt-1 text-sm text-slate-400">
              {view.phase === 'error'
                ? 'This call cannot continue.'
                : 'Joining lets you hear and speak with the salesperson.'}
            </p>
            <p className="mt-3 text-xs text-slate-500">
              Your browser will ask for microphone access. You can listen without granting it.
            </p>
            <div className="mt-5 flex flex-col sm:flex-row gap-2 justify-center">
              {view.canJoin ? (
                <button
                  type="button"
                  onClick={onJoin}
                  data-testid="join-call"
                  className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm"
                >
                  Join call
                </button>
              ) : null}
              {view.canReconnect ? (
                <button
                  type="button"
                  onClick={onReconnect}
                  data-testid="reconnect"
                  className="px-6 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-slate-100 font-semibold text-sm inline-flex items-center justify-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  {view.phase === 'error' ? 'Start a new call' : 'Reconnect'}
                </button>
              ) : null}
            </div>
          </section>
        )}
      </main>

      {!view.canJoin ? (
        <footer className="w-full border-t border-white/10 bg-slate-950/80 backdrop-blur px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-md flex items-center justify-center gap-4 sm:gap-6">
            <CallButton
              onClick={onMuteToggle}
              label={view.micMuted ? 'Unmute microphone' : 'Mute microphone'}
              testId="mic-toggle"
              tone={view.micMuted ? 'active' : 'neutral'}
              disabled={!view.canMute}
            >
              {view.micMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </CallButton>
            <CallButton
              onClick={onSpeakerToggle}
              label={view.speakerMuted ? 'Turn speaker on' : 'Turn speaker off'}
              testId="speaker-toggle"
              disabled={!view.canToggleSpeaker}
            >
              {view.speakerMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
            </CallButton>
            <CallButton
              onClick={onEndCall}
              label="End call"
              testId="leave-call"
              tone="danger"
              disabled={!view.canEndCall}
            >
              <PhoneOff className="w-6 h-6" />
            </CallButton>
          </div>
          <p className="mt-2 text-center text-[11px] text-slate-500" data-testid="mic-state">
            {view.micPermission === 'denied'
              ? 'Microphone permission is blocked'
              : view.micMuted
                ? 'Your microphone is muted'
                : 'Your microphone is on'}
          </p>
        </footer>
      ) : null}
    </div>
  );
};

export default CustomerCallScreen;
