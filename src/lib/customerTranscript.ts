/**
 * Customer speech transcript segments.
 *
 * `ultravox-client@0.6` stores transcripts as a sparse array indexed by
 * `ordinal` and re-emits the *whole* array on every update ("transcripts"
 * event). That is the only supported semantic:
 *
 *   - a partial transcript (`isFinal === false`) is the full text so far for
 *     one ordinal and must be replaced, never appended;
 *   - a final transcript (`isFinal === true`) closes that ordinal
 *     ("Whether to expect additional transcript messages for this conversation
 *     round");
 *   - `ordinal` is "the position of the message within the call, used for
 *     ordering".
 *
 * The SDK exposes no language and no confidence metadata on a transcript, so
 * this module never invents either. It keeps the recognised text byte-for-byte
 * (including legitimate repeated words and mixed-language speech) and only
 * tracks which ordinal it belongs to.
 *
 * This module is intentionally side-effect free so the ordering, de-duplication
 * and stale-session rules can be tested without a browser or the SDK.
 */

/**
 * Segments kept per call. Ultravox ordinals are sequential, so 200 utterances
 * covers a long sales call while bounding React state and memory.
 */
export const CUSTOMER_TRANSCRIPT_MAX_SEGMENTS = 200;

export type CustomerTranscriptMedium = 'voice' | 'text';

export type CustomerTranscriptDropReason =
  /** Not a usable transcript (missing/blank text or a bad ordinal). */
  | 'invalid'
  /** Belongs to a different (older) Ultravox call. */
  | 'stale-session'
  /** The exact same ordinal/text/finality was already applied. */
  | 'duplicate'
  /** A partial for an ordinal whose final text was already received. */
  | 'stale-partial';

export interface CustomerTranscriptEvent {
  text?: unknown;
  isFinal?: unknown;
  ordinal?: unknown;
  /** Ultravox call id the segment was produced on, when known. */
  callId?: unknown;
  /** SDK `medium` metadata ('voice' for speech). */
  medium?: unknown;
  /** Display-only receipt time supplied by the sender. */
  timestamp?: unknown;
}

export interface CustomerTranscriptSegment {
  ordinal: number;
  /** Exactly the recognised text; whitespace is preserved. */
  text: string;
  isFinal: boolean;
  /** Available SDK metadata only; null when the sender did not provide it. */
  medium: CustomerTranscriptMedium | null;
  /** Receipt label, not part of the recognised transcript. */
  timestamp: string;
}

export interface CustomerTranscriptState {
  /** Ultravox call the segments belong to; null until reported. */
  callId: string | null;
  segments: CustomerTranscriptSegment[];
  dropped: {
    total: number;
    lastReason: CustomerTranscriptDropReason | null;
  };
}

export interface CustomerTranscriptResult {
  state: CustomerTranscriptState;
  applied: boolean;
  reason: CustomerTranscriptDropReason | null;
}

const MAX_CALL_ID_LENGTH = 100;

export const normalizeTranscriptCallId = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && value.trim().length <= MAX_CALL_ID_LENGTH
    ? value.trim()
    : null;

const normalizeOrdinal = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;

const normalizeMedium = (value: unknown): CustomerTranscriptMedium | null =>
  value === 'voice' || value === 'text' ? value : null;

export const createCustomerTranscriptState = (callId: string | null = null): CustomerTranscriptState => ({
  callId,
  segments: [],
  dropped: { total: 0, lastReason: null },
});

const withDrop = (
  state: CustomerTranscriptState,
  reason: CustomerTranscriptDropReason
): CustomerTranscriptResult => ({
  state: {
    ...state,
    dropped: { total: state.dropped.total + 1, lastReason: reason },
  },
  applied: false,
  reason,
});


/**
 * Binds the salesperson's transcript view to one Ultravox call.
 *
 * A different call id always starts a fresh view: a reconnected customer gets a
 * new Ultravox call whose ordinals restart at the beginning, so keeping the old
 * segments would mix two conversations. Adopting a call id when none was known
 * yet keeps segments that arrived before the first status report.
 */
export const bindCustomerTranscriptSession = (
  state: CustomerTranscriptState,
  callId: unknown
): CustomerTranscriptState => {
  const next = normalizeTranscriptCallId(callId);
  if (!next || next === state.callId) return state;
  if (state.callId === null) return { ...state, callId: next };
  return createCustomerTranscriptState(next);
};

const sameSegment = (segment: CustomerTranscriptSegment, next: Omit<CustomerTranscriptSegment, 'timestamp'>) =>
  segment.text === next.text && segment.isFinal === next.isFinal;

const trimSegments = (segments: CustomerTranscriptSegment[]): CustomerTranscriptSegment[] => {
  if (segments.length <= CUSTOMER_TRANSCRIPT_MAX_SEGMENTS) return segments;
  let excess = segments.length - CUSTOMER_TRANSCRIPT_MAX_SEGMENTS;
  const kept: CustomerTranscriptSegment[] = [];
  // Prefer dropping the oldest finalized segments; an unfinished utterance is
  // still being displayed and must not disappear mid-update.
  for (const segment of segments) {
    if (excess > 0 && segment.isFinal) {
      excess -= 1;
      continue;
    }
    kept.push(segment);
  }
  return kept.slice(-CUSTOMER_TRANSCRIPT_MAX_SEGMENTS);
};

/**
 * Applies one SDK transcript (or one relayed transcript event) to the view.
 *
 * Rules, in order:
 *   1. reject an unusable payload;
 *   2. reject an event from a different Ultravox call (stale session);
 *   3. replace the segment with the same ordinal instead of appending it;
 *   4. never let a late partial overwrite a final, or a shorter late partial
 *      overwrite a longer newer partial of the same utterance;
 *   5. keep every other utterance as its own segment, sorted by ordinal.
 *
 * Text is never merged across ordinals, trimmed, translated or completed.
 */
export const applyCustomerTranscriptEvent = (
  state: CustomerTranscriptState,
  event: CustomerTranscriptEvent,
  receivedAt = new Date().toLocaleTimeString()
): CustomerTranscriptResult => {
  const text = typeof event.text === 'string' ? event.text : null;
  const ordinal = normalizeOrdinal(event.ordinal);
  if (text === null || text.trim().length === 0 || ordinal === null) {
    return withDrop(state, 'invalid');
  }

  const eventCallId = normalizeTranscriptCallId(event.callId);
  // An event with a call id that does not match the bound call is from an old
  // session. Events without a call id (older clients / same-session relays)
  // are accepted so this never silently drops live speech.
  if (state.callId !== null && eventCallId !== null && eventCallId !== state.callId) {
    return withDrop(state, 'stale-session');
  }

  const next: Omit<CustomerTranscriptSegment, 'timestamp'> = {
    ordinal,
    text,
    isFinal: event.isFinal === true,
    medium: normalizeMedium(event.medium),
  };

  const existingIndex = state.segments.findIndex((segment) => segment.ordinal === ordinal);
  if (existingIndex >= 0) {
    const existing = state.segments[existingIndex];

    if (sameSegment(existing, next)) {
      return withDrop(state, 'duplicate');
    }
    if (existing.isFinal && !next.isFinal) {
      // A final transcript closes the utterance; a late partial cannot reopen it.
      return withDrop(state, 'stale-partial');
    }
    if (
      !existing.isFinal &&
      !next.isFinal &&
      next.text.length < existing.text.length &&
      existing.text.startsWith(next.text)
    ) {
      // The SDK replaces with the full text so far. A shorter prefix is an
      // older partial delivered late; the newer text is more complete.
      return withDrop(state, 'stale-partial');
    }

    const segments = [...state.segments];
    segments[existingIndex] = {
      ...next,
      // Keep metadata that an update omitted rather than replacing it with null.
      medium: next.medium ?? existing.medium,
      timestamp:
        typeof event.timestamp === 'string' && event.timestamp
          ? event.timestamp
          : existing.timestamp,
    };
    return {
      state: {
        ...state,
        callId: state.callId ?? eventCallId,
        segments,
        dropped: state.dropped,
      },
      applied: true,
      reason: null,
    };
  }

  const segment: CustomerTranscriptSegment = {
    ...next,
    timestamp: typeof event.timestamp === 'string' && event.timestamp ? event.timestamp : receivedAt,
  };
  const segments = trimSegments(
    [...state.segments, segment].sort((left, right) => left.ordinal - right.ordinal)
  );
  return {
    state: {
      ...state,
      callId: state.callId ?? eventCallId,
      segments,
      dropped: state.dropped,
    },
    applied: true,
    reason: null,
  };
};

/** The most recent utterance (partial or final), or null. */
export const latestCustomerTranscriptSegment = (
  state: CustomerTranscriptState
): CustomerTranscriptSegment | null => state.segments[state.segments.length - 1] ?? null;

/**
 * The most recent *final* utterance, used for the single-line compatibility
 * field. Partial text is shown in the segment list, never here, so a caller
 * that only renders `customerSpeech` does not flicker.
 */
export const latestFinalCustomerTranscriptSegment = (
  state: CustomerTranscriptState
): CustomerTranscriptSegment | null => {
  for (let index = state.segments.length - 1; index >= 0; index -= 1) {
    if (state.segments[index].isFinal) return state.segments[index];
  }
  return null;
};
