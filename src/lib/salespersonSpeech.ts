/**
 * Salesperson speech capture for the customer-facing transcript.
 *
 * Why this shape:
 *   - The Ultravox session that feeds the AI only ever receives the *customer*
 *     microphone, so it cannot transcribe the salesperson. The salesperson
 *     device therefore captions its own microphone with the browser's Speech
 *     Recognition API and relays the resulting text to the customer.
 *   - No audio is forwarded, mixed or re-published: only text leaves this class.
 *   - Everything is injected (`createRecognition`) so the routing rules can be
 *     tested without a real browser or a real speech provider.
 *
 * Limitations (see docs/prototype2-architecture.md):
 *   - Chrome/Edge only (webkitSpeechRecognition). Firefox has no implementation
 *     and Safari support is partial, so the customer is told captions are
 *     unavailable instead of seeing a silent panel.
 *   - Quality, punctuation and language support come from the browser/provider.
 *   - Captions stop while the salesperson is muted and resume on unmute.
 */

export type SpeechCaptureStatus = 'inactive' | 'starting' | 'listening' | 'error' | 'unsupported';

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionErrorLike {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
}

export interface SpeechSegmentEvent {
  /** Monotonic ordinal, stable across interim -> final updates of one phrase. */
  ordinal: number;
  text: string;
  isFinal: boolean;
}

export interface SpeechCaptureOptions {
  createRecognition: () => SpeechRecognitionLike | null;
  onSegment: (segment: SpeechSegmentEvent) => void;
  onStatus: (status: SpeechCaptureStatus, detail?: string) => void;
  lang?: string;
  /** Restart delay after the browser ends a continuous session. */
  restartDelayMs?: number;
}

export const SPEECH_UNSUPPORTED_MESSAGE =
  'Live captions are not available in this browser. Chrome or Edge is required.';

const errorMessage = (code: string): string => {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access for live captions was blocked. Allow microphone access and reconnect.';
    case 'audio-capture':
      return 'No microphone is available for live captions.';
    case 'network':
      return 'The caption service is unreachable. Check the network connection.';
    case 'language-not-supported':
      return 'This language is not supported for live captions.';
    default:
      return `Live captions stopped (${code}).`;
  }
};

export class SalespersonSpeechCapture {
  private readonly options: SpeechCaptureOptions;
  private readonly restartDelayMs: number;
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;
  private paused = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextOrdinal = 0;
  /** resultIndex -> ordinal for the current recognition session. */
  private ordinals = new Map<number, number>();
  private status: SpeechCaptureStatus = 'inactive';

  constructor(options: SpeechCaptureOptions) {
    this.options = options;
    this.restartDelayMs = options.restartDelayMs ?? 400;
  }

  getStatus(): SpeechCaptureStatus {
    return this.status;
  }

  start(): void {
    if (this.active) return;
    const recognition = this.options.createRecognition();
    if (!recognition) {
      this.setStatus('unsupported', SPEECH_UNSUPPORTED_MESSAGE);
      return;
    }
    this.active = true;
    this.paused = false;
    this.recognition = recognition;
    this.ordinals = new Map();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.options.lang ?? 'en-US';
    recognition.onstart = () => this.setStatus('listening');
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are normal for continuous recognition.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.setStatus('error', errorMessage(event.error));
      if (
        event.error === 'not-allowed' ||
        event.error === 'service-not-allowed' ||
        event.error === 'audio-capture'
      ) {
        // Never loop on a permission error; wait for an explicit restart.
        this.active = false;
      }
    };
    recognition.onend = () => {
      if (!this.active || this.paused) {
        // Keep a failure visible; a normal stop is reported as inactive.
        if (this.status !== 'error' && this.status !== 'unsupported') this.setStatus('inactive');
        return;
      }
      this.scheduleRestart();
    };

    this.setStatus('starting');
    try {
      recognition.start();
    } catch (err) {
      this.setStatus('error', (err as Error)?.message || 'Live captions could not be started.');
      this.active = false;
    }
  }

  /** Stops capturing and releases the recognition session. */
  stop(): void {
    this.active = false;
    this.paused = false;
    this.clearRestartTimer();
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.stop();
      } catch {
        // Ignore: the session may already be closed.
      }
    }
    this.setStatus('inactive');
  }

  /** Used while the salesperson is muted: captions must not include muted speech. */
  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.clearRestartTimer();
    try {
      this.recognition?.stop();
    } catch {
      // Ignore.
    }
    this.setStatus('inactive');
  }

  resume(): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.ordinals = new Map();
    try {
      this.recognition?.start();
      this.setStatus('starting');
    } catch {
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.active || this.paused) return;
      this.ordinals = new Map();
      try {
        this.recognition?.start();
        this.setStatus('starting');
      } catch {
        this.setStatus('error', 'Live captions stopped unexpectedly.');
        this.active = false;
      }
    }, this.restartDelayMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer as unknown as number);
      this.restartTimer = null;
    }
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const results = event.results ?? [];
    for (let index = event.resultIndex ?? 0; index < results.length; index += 1) {
      const result = results[index];
      const text = result?.[0]?.transcript ?? '';
      if (!text.trim()) continue;
      let ordinal = this.ordinals.get(index);
      if (ordinal === undefined) {
        ordinal = this.nextOrdinal;
        this.nextOrdinal += 1;
        this.ordinals.set(index, ordinal);
      }
      if (this.status !== 'listening') this.setStatus('listening');
      this.options.onSegment({ ordinal, text, isFinal: Boolean(result.isFinal) });
    }
  }

  private setStatus(status: SpeechCaptureStatus, detail?: string): void {
    this.status = status;
    this.options.onStatus(status, detail);
  }
}

/** Browser factory. Returns null where the API does not exist. */
export const createBrowserRecognition = (): SpeechRecognitionLike | null => {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Constructor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Constructor) return null;
  try {
    return new Constructor();
  } catch {
    return null;
  }
};
