import React from 'react';

export type Tone = 'emerald' | 'amber' | 'red' | 'slate' | 'indigo';
const TONE_DOT: Record<Tone, string> = {
  emerald: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]',
  amber: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]',
  red: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]',
  slate: 'bg-slate-500',
  indigo: 'bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.6)]',
};
const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-rose-300',
  slate: 'text-slate-400',
  indigo: 'text-indigo-300',
};

export const StatusLine: React.FC<{
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
}> = ({ label, value, tone, detail }) => (
  <div className="flex items-start justify-between gap-3 py-1.5">
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      {detail ? <p className="text-[11px] text-slate-500 truncate" title={detail}>{detail}</p> : null}
    </div>
    <span className={`flex items-center gap-1.5 text-xs font-semibold shrink-0 ${TONE_TEXT[tone]}`}>
      <span className={`w-2 h-2 rounded-full ${TONE_DOT[tone]}`} />
      {value}
    </span>
  </div>
);

export const Panel: React.FC<{
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, icon, action, children, className = '' }) => (
  <section className={`bg-slate-900/70 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0 ${className}`}>
    <header className="flex items-center justify-between gap-2 mb-2">
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      {action}
    </header>
    <div className="flex-1 min-h-0">{children}</div>
  </section>
);

export const Banner: React.FC<{
  tone: 'amber' | 'red' | 'emerald' | 'indigo';
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}> = ({ tone, title, children, action, testId }) => {
  const styles = {
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    red: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
    emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    indigo: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200',
  }[tone];
  return (
    <div data-testid={testId} className={`border rounded-xl px-3 py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1 ${styles}`}>
      <strong className="font-semibold">{title}</strong>
      <span className="text-current/80 flex-1 min-w-[12rem]">{children}</span>
      {action}
    </div>
  );
};

export const DiagGrid: React.FC<{ rows: Array<[string, string]> }> = ({ rows }) => (
  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono">
    {rows.map(([label, value]) => (
      <React.Fragment key={label}>
        <dt className="text-slate-500 truncate" title={label}>{label}</dt>
        <dd className="text-slate-300 text-right truncate" title={value}>{value}</dd>
      </React.Fragment>
    ))}
  </dl>
);

export const timeLeft = (timestamp: number | null): string => {
  if (!timestamp) return 'unknown';
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return 'expired';
  const minutes = Math.round(remaining / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
};
