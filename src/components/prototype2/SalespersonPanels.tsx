import React from 'react';
import { Activity, Brain, MessageSquareText, RefreshCw, Sparkles } from 'lucide-react';
import type { EngineSnapshot, SuggestionCard, ParticipantRole } from '../../lib/callEngine';
import type { SpeechSegment } from '../../lib/transcript';
import { DiagGrid } from './ui';

/**
 * Salesperson-only panels. Everything here is private to the salesperson's
 * workspace: AI suggestions, the customer transcript, and diagnostics. The
 * customer interface imports none of it.
 */

const TONE_CLASS: Record<'emerald' | 'amber' | 'red' | 'slate' | 'indigo', string> = {
  emerald: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  amber: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  red: 'border-rose-500/40 text-rose-300 bg-rose-500/10',
  slate: 'border-slate-700 text-slate-400 bg-slate-900',
  indigo: 'border-indigo-500/40 text-indigo-300 bg-indigo-500/10',
};

/** Compact AI state chip: colour + the shared, human-readable label. */
export const AiStateChip: React.FC<{ label: string; tone: keyof typeof TONE_CLASS; title?: string }> = ({
  label,
  tone,
  title,
}) => (
  <span
    className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${TONE_CLASS[tone]}`}
    data-testid="ai-state-chip"
    title={title ?? label}
  >
    {label}
  </span>
);

export interface AiPanelStatus {
  label: string;
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  error: string | null;
}

/**
 * Private AI suggestions. Visually distinct from speech, and explicitly
 * labelled so an AI line can never be mistaken for something the customer said.
 */
export const AiSuggestionPanel: React.FC<{
  suggestions: SuggestionCard[];
  ai: AiPanelStatus;
  onReconnect: () => void;
  disabled: boolean;
}> = ({ suggestions, ai, onReconnect, disabled }) => {
  const latest = [...suggestions].reverse().find((item) => item.text) ?? null;
  return (
    <section
      className="rounded-2xl border border-indigo-500/30 bg-indigo-500/[0.07] p-4 flex flex-col min-h-0"
      data-testid="ai-panel"
      aria-label="Private AI suggestions"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          AI suggestions
        </h2>
        <button
          type="button"
          onClick={onReconnect}
          disabled={disabled}
          data-testid="ai-reconnect"
          className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-indigo-400/40 text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-40 inline-flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          Restart AI
        </button>
      </header>
      <p className="mt-1 text-[10px] text-indigo-300/70">Private to you · not spoken by the customer</p>

      <div className="mt-2 text-xs" data-testid="ai-state">
        <span className="font-semibold text-slate-200">{ai.label}</span>
        {ai.connected ? (
          <span className="text-slate-400"> · listening to the customer</span>
        ) : ai.reconnecting ? (
          <span className="text-amber-300"> · recovery attempt {ai.reconnectAttempt}/{ai.maxReconnectAttempts}</span>
        ) : null}
        {ai.error ? (
          <p className="mt-1 text-rose-300" data-testid="ai-error">
            {ai.error}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex-1 min-h-0 space-y-2 overflow-y-auto max-h-56" data-testid="ai-suggestions">
        {latest ? (
          <article
            className="rounded-xl bg-indigo-950/50 border border-indigo-500/30 px-3 py-2"
            data-testid="ai-suggestion-latest"
          >
            <p className="text-[10px] uppercase tracking-wider text-indigo-300/80 mb-1">Latest suggestion</p>
            <p className="text-sm leading-relaxed text-indigo-50">{latest.text}</p>
            {latest.isFinal ? null : <p className="mt-1 text-[10px] text-indigo-300/70 italic">updating…</p>}
          </article>
        ) : (
          <p className="text-slate-400 text-sm flex items-start gap-2" data-testid="ai-suggestions-empty">
            <Brain className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            Suggestions appear here once the customer starts speaking.
          </p>
        )}
        {suggestions.length > 1 ? (
          <ul className="space-y-1.5">
            {suggestions
              .slice(0, -1)
              .reverse()
              .slice(0, 6)
              .map((suggestion) => (
                <li
                  key={suggestion.id}
                  className="text-[13px] text-slate-300/90 border-l-2 border-indigo-500/30 pl-2"
                >
                  {suggestion.text}
                </li>
              ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
};


/** The customer's actual spoken words (from the customer device's transcript). */
export const CustomerTranscriptPanel: React.FC<{
  segments: SpeechSegment[];
  customerSpeech: string;
  aiLive: boolean;
}> = ({ segments, customerSpeech, aiLive }) => {
  const status = segments.length
    ? `${segments.filter((segment) => segment.isFinal).length} finalized`
    : aiLive
      ? 'Listening'
      : 'Waiting';
  return (
    <section
      className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 flex flex-col min-h-0"
      data-testid="customer-transcript"
      aria-label="Customer transcript"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <MessageSquareText className="w-3.5 h-3.5" aria-hidden="true" />
          Customer said
        </h2>
        <span className="text-[10px] text-slate-500">{status}</span>
      </header>
      <div className="mt-2 flex-1 min-h-0 overflow-y-auto max-h-48 space-y-1.5">
        {segments.length === 0 ? (
          <p className="text-sm text-slate-500">
            {customerSpeech || 'The customer’s words will appear here during the call.'}
          </p>
        ) : (
          segments.map((segment) => (
            <p
              key={segment.ordinal}
              data-testid="customer-transcript-segment"
              data-final={segment.isFinal ? 'true' : 'false'}
              className={segment.isFinal ? 'text-sm text-slate-200' : 'text-sm text-slate-500 italic'}
            >
              {segment.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
};


/** Advanced diagnostics, collapsed by default so the call stays the focus. */
export const DiagnosticsPanel: React.FC<{
  snapshot: EngineSnapshot | null;
  role: ParticipantRole;
  serverRows: Array<[string, string]>;
  serverLoading: boolean;
}> = ({ snapshot, role, serverRows, serverLoading }) => (
  <div className="space-y-3" data-testid="diagnostics-panel">
    <DiagGrid
      rows={[
        ['role', role],
        ['participant', snapshot?.participantId?.slice(0, 10) ?? '—'],
        ['ws', snapshot?.wsStatus ?? 'not started'],
        ['peer', snapshot?.peerRole ?? 'none'],
        ['pc', snapshot?.diagnostics.pcState ?? 'none'],
        ['ice', snapshot?.diagnostics.iceState ?? 'none'],
        ['path', snapshot?.selectedPair ?? 'none'],
        ['dtls', snapshot?.diagnostics.dtlsState ?? 'none'],
        ['rtp out', `${snapshot?.diagnostics.bytesSent ?? 0} B`],
        ['rtp in', `${snapshot?.diagnostics.bytesReceived ?? 0} B`],
        ['media flowing', snapshot?.mediaFlowing ? 'yes (RTP received)' : 'no RTP yet'],
        ['mic perm', snapshot?.micPermission ?? 'unknown'],
        ['mic track', snapshot?.diagnostics.localTrackState ?? 'none'],
        ['local senders', String(snapshot?.diagnostics.localSenderCount ?? 0)],
        ['remote track', snapshot?.diagnostics.remoteTrackState ?? 'none'],
        ['playback', snapshot?.diagnostics.audioElementPaused ? 'paused' : 'playing'],
        ['playback error', snapshot?.diagnostics.playbackError ?? 'none'],
        ['reconnects', String(snapshot?.reconnectAttempt ?? 0)],
      ]}
    />
    <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Server</p>
    {serverLoading ? (
      <p className="text-[11px] text-slate-500">Loading server diagnostics…</p>
    ) : serverRows.length ? (
      <DiagGrid rows={serverRows} />
    ) : (
      <p className="text-[11px] text-slate-500">No server diagnostics yet.</p>
    )}
    <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Call log</p>
    <pre className="text-[10px] leading-4 text-slate-400 bg-slate-950 border border-slate-800 rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap">
      {snapshot?.logs.length ? snapshot.logs.join('\n') : 'No events yet.'}
    </pre>
  </div>
);

export const DiagnosticsToggle: React.FC<{ open: boolean; onToggle: () => void }> = ({ open, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    data-testid="diagnostics-toggle"
    aria-expanded={open}
    className="w-full flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 px-1 py-1"
  >
    <span className="flex items-center gap-1.5">
      <Activity className="w-3.5 h-3.5" aria-hidden="true" />
      Diagnostics &amp; recovery
    </span>
    <span>{open ? 'Hide' : 'Show'}</span>
  </button>
);
