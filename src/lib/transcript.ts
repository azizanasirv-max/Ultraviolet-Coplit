/**
 * Speaker-specific transcript segments.
 *
 * Both dashboards receive incremental transcript updates: a provider may send
 * the same `ordinal` several times while a phrase is still being recognised.
 * The merge rules below are the only place that decides how an update becomes
 * visible text, so neither dashboard has to guess:
 *
 *   - one segment per ordinal (a partial update replaces its own text),
 *   - segments stay ordered by ordinal (text never jumps around the panel),
 *   - a finalized segment is never replaced by a partial one,
 *   - a repeated finalized line is not appended twice.
 */

export interface SpeechSegment {
  /** Stable provider ordinal. The merge key. */
  ordinal: number;
  text: string;
  isFinal: boolean;
  /** Client-side wall-clock time of the last update (display only). */
  at: number;
}

export const MAX_SEGMENTS = 200;
export const MAX_SEGMENT_TEXT = 4000;

const normalize = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT_TEXT);

/** Merges one incoming segment into an ordered segment list. */
export const mergeSpeechSegment = (
  segments: SpeechSegment[],
  incoming: { ordinal: number; text: string; isFinal?: boolean; at?: number }
): SpeechSegment[] => {
  const text = normalize(incoming.text ?? '');
  const ordinal = Number.isFinite(incoming.ordinal) ? Math.round(incoming.ordinal) : segments.length;
  const isFinal = Boolean(incoming.isFinal);
  const at = incoming.at ?? Date.now();

  if (!text && !isFinal) return segments;

  const index = segments.findIndex((segment) => segment.ordinal === ordinal);
  if (index >= 0) {
    const existing = segments[index];
    // A provider may resend the final version of an already final segment.
    if (existing.text === text && existing.isFinal === isFinal) return segments;
    // Finalised text must not be downgraded to a partial guess.
    if (existing.isFinal && !isFinal) return segments;
    const next = [...segments];
    next[index] = { ordinal, text: text || existing.text, isFinal, at };
    return next;
  }

  // The same finalized line can arrive under a new ordinal after a provider
  // reconnect. Do not show it twice next to each other.
  const last = segments[segments.length - 1];
  if (isFinal && last && last.isFinal && last.text === text) return segments;

  const next = [...segments, { ordinal, text, isFinal, at }];
  next.sort((a, b) => a.ordinal - b.ordinal);
  return next.length > MAX_SEGMENTS ? next.slice(next.length - MAX_SEGMENTS) : next;
};

/** Plain text of a transcript, used for "copy" actions and accessibility. */
export const transcriptText = (segments: SpeechSegment[]): string =>
  segments
    .map((segment) => segment.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** True when the transcript has at least one finalized segment. */
export const hasFinalSegment = (segments: SpeechSegment[]): boolean =>
  segments.some((segment) => segment.isFinal && Boolean(segment.text));
