/**
 * Server-side bridge between the customer's microphone and the self-hosted
 * Modal AI service.
 *
 * The customer's browser never receives the Modal endpoint, its signed join URL
 * or any credential. It streams 16 kHz mono PCM16 frames to this server over an
 * authenticated same-origin WebSocket (`/ws/ai`); this module opens the single
 * upstream WebSocket to Modal and forwards only that audio. Model output is
 * text (`transcript` / `suggestion`) and is delivered to the salesperson by the
 * signaling layer, so the AI is never a participant in the human call and no
 * audio can ever be injected into it.
 *
 * Safety properties:
 *   - The upstream URL comes from `createAiCall` (host-pinned); no client input
 *     can influence it.
 *   - Frames are byte-bounded, non-blocking and dropped under backpressure.
 *   - Failures are contained: they change AI status only and can never throw
 *     into a media path.
 *   - No audio, URL, token or transcript is logged.
 */
import { WebSocket } from 'ws';
import {
  AiServiceError,
  AiServiceSettings,
  createAiCall,
  endAiCallQuietly,
  sanitizeProviderDetail,
} from './aiService';

/** Audio contract shared with the browser and `modal_app/pipeline.py`. */
export const AI_AUDIO_SAMPLE_RATE = 16000;
export const AI_PROTOCOL = 'salescopilot-ai/1';
/** One 64 KiB max upstream frame (Modal enforces the same bound). */
export const AI_MAX_FRAME_BYTES = 64 * 1024;
/** Stop queueing audio instead of growing server memory. */
export const AI_MAX_BUFFERED_BYTES = 1_000_000;
/** A socket with no traffic for this long is considered dead. */
export const AI_IDLE_TIMEOUT_MS = 60_000;
export const AI_PING_INTERVAL_MS = 15_000;
/** Bounded upstream recovery. Each attempt is one new Modal call. */
export const AI_MAX_RECONNECTS = 2;
const AI_RECONNECT_DELAYS_MS = [1_500, 4_000] as const;

export type AiBridgeState =
  | 'off'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'reconnecting'
  | 'error'
  | 'closed';

export interface AiBridgeStatus {
  state: AiBridgeState;
  callId: string | null;
  model: string | null;
  connected: boolean;
  listening: boolean;
  error: string | null;
  reconnectAttempt: number;
  audioReachingAi: boolean;
  lastResponseAt: number | null;
  lastSuggestionAt: number | null;
}

export type AiBridgeEvent =
  | ({ type: 'status' } & AiBridgeStatus)
  | { type: 'suggestion'; text: string; ordinal: number; isFinal: boolean }
  | { type: 'transcript'; text: string; ordinal: number; isFinal: boolean };

/** The small `ws` surface the bridge needs; tests inject a local socket. */
export interface AiBridgeSocket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (data: unknown) => void): void;
  on(event: 'close', handler: (code?: number, reason?: Buffer | string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}

export interface AiBridgeOptions {
  /** Service settings; `null` makes the bridge unavailable (AI off). */
  settings: AiServiceSettings | null;
  fetchImpl: typeof fetch;
  /** Operator-controlled prompt. Never taken from a browser. */
  systemPrompt: string;
  /** Test seam: replace the real upstream WebSocket. */
  createSocket?: (url: string) => AiBridgeSocket;
  onEvent: (sessionId: string, event: AiBridgeEvent) => void;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface BridgeRuntime {
  sessionId: string;
  callId: string | null;
  model: string | null;
  expiresAt: number | null;
  socket: AiBridgeSocket | null;
  state: AiBridgeState;
  error: string | null;
  reconnectAttempt: number;
  ended: boolean;
  createdAt: number;
  lastMessageAt: number;
  lastAudioAt: number | null;
  audioBytes: number;
  audioReachingAi: boolean;
  lastResponseAt: number | null;
  lastSuggestionAt: number | null;
  lastSuggestionText: string | null;
  ordinal: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

const isOpen = (socket: AiBridgeSocket | null): boolean =>
  Boolean(socket && socket.readyState === 1);

const parseJson = (data: unknown): Record<string, unknown> | null => {
  const text =
    typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : null;
  if (!text || text.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};


const boundedText = (value: unknown, max = 4000): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/** The operator-controlled prompt. Not browser input. */
export const AI_SYSTEM_PROMPT =
  'You are an AI sales copilot assisting a salesperson in a live sales call. ' +
  'Listen attentively to the customer statements, questions, and objections. ' +
  'Generate concise, natural, 1-2 sentence ready-to-read sales responses and ' +
  'qualification questions for the salesperson to read aloud.';

/**
 * Owns at most one upstream Modal call per room and forwards customer audio.
 *
 * One instance per HTTP server. It never stores data in a browser, never logs
 * payloads and never throws on a media path.
 */
export class AiBridgeManager {
  private readonly runtimes = new Map<string, BridgeRuntime>();
  private readonly pending = new Map<
    string,
    Promise<{ callId: string; model: string; reused: boolean }>
  >();
  private readonly options: AiBridgeOptions;
  private readonly now: () => number;
  private stopped = false;

  constructor(options: AiBridgeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Current status without creating anything. */
  status(sessionId: string): AiBridgeStatus | null {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? this.snapshot(runtime) : null;
  }

  /** Sessions with a live or pending upstream call (for expiry cleanup). */
  activeSessions(): string[] {
    return [...this.runtimes.keys()];
  }

  has(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    return Boolean(runtime && !runtime.ended);
  }

  /**
   * Creates (or reuses) the upstream call. Reuse only happens while the
   * upstream socket is genuinely open, so a dead call is never handed out.
   */
  async ensure(sessionId: string): Promise<{ callId: string; model: string; reused: boolean }> {
    if (this.stopped) {
      throw new AiServiceError('AI_SERVICE_UNAVAILABLE', 503, 'The AI service is not available.');
    }
    const settings = this.options.settings;
    if (!settings) {
      throw new AiServiceError(
        'AI_SERVICE_NOT_CONFIGURED',
        503,
        'The server is missing AI_SERVICE_URL and/or AI_SERVICE_TOKEN.'
      );
    }

    const existing = this.runtimes.get(sessionId);
    if (existing && !existing.ended && isOpen(existing.socket)) {
      return {
        callId: existing.callId ?? '',
        model: existing.model ?? settings.model,
        reused: true,
      };
    }

    const inFlight = this.pending.get(sessionId);
    if (inFlight) return { ...(await inFlight), reused: true };

    const operation = this.createAndConnect(sessionId, settings);
    this.pending.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(sessionId);
    }
  }

  /** Forwards one PCM16 frame. Returns false when it was dropped. */
  pushAudio(sessionId: string, pcm: Buffer): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.ended) return false;
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) return false;
    if (pcm.length > AI_MAX_FRAME_BYTES) return false;
    if (!isOpen(runtime.socket)) return false;
    if ((runtime.socket?.bufferedAmount ?? 0) > AI_MAX_BUFFERED_BYTES) return false;

    try {
      runtime.socket?.send(pcm);
    } catch {
      return false;
    }
    runtime.audioBytes += pcm.length;
    runtime.lastAudioAt = this.now();
    if (!runtime.audioReachingAi) {
      runtime.audioReachingAi = true;
      this.emitStatus(runtime);
    }
    return true;
  }

  /** Ends the current upstream call and immediately creates a new one. */
  async restart(sessionId: string): Promise<{ callId: string; model: string }> {
    this.end(sessionId, 'restarted');
    const call = await this.ensure(sessionId);
    return { callId: call.callId, model: call.model };
  }

  /**
   * Stops the upstream call. Idempotent; never throws.
   *
   * `silent` keeps a terminal `error` status visible instead of overwriting it
   * with `off` (the human call is unaffected either way).
   */
  end(sessionId: string, reason = 'ended', options: { silent?: boolean } = {}): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    const wasEnded = runtime.ended;
    runtime.ended = true;
    this.clearTimers(runtime);
    const socket = runtime.socket;
    runtime.socket = null;
    if (socket) {
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'audio.end' }));
      } catch {
        // The socket is being torn down anyway.
      }
      try {
        socket.close(1000, reason.slice(0, 60));
      } catch {
        // Ignore.
      }
    }
    const settings = this.options.settings;
    const callId = runtime.callId;
    this.runtimes.delete(sessionId);
    if (settings && callId) {
      void endAiCallQuietly(this.options.fetchImpl, settings, callId);
    }
    if (!wasEnded && !options.silent) {
      this.options.onEvent(sessionId, {
        type: 'status',
        state: 'off',
        callId: null,
        model: runtime.model,
        connected: false,
        listening: false,
        error: null,
        reconnectAttempt: 0,
        audioReachingAi: false,
        lastResponseAt: runtime.lastResponseAt,
        lastSuggestionAt: runtime.lastSuggestionAt,
      });
    }
  }

  /** Used on shutdown; no events are emitted for a stopping server. */
  stopAll(): void {
    this.stopped = true;
    for (const sessionId of [...this.runtimes.keys()]) {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime) continue;
      runtime.ended = true;
      this.clearTimers(runtime);
      try {
        runtime.socket?.close(1001, 'server stopping');
      } catch {
        // Ignore.
      }
      this.runtimes.delete(sessionId);
    }
  }


  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createAndConnect(
    sessionId: string,
    settings: AiServiceSettings
  ): Promise<{ callId: string; model: string; reused: boolean }> {
    const call = await createAiCall(this.options.fetchImpl, settings, {
      sessionId,
      systemPrompt: this.options.systemPrompt,
    });

    const runtime: BridgeRuntime = {
      sessionId,
      callId: call.callId,
      model: call.model,
      expiresAt: call.expiresAt,
      socket: null,
      state: 'connecting',
      error: null,
      reconnectAttempt: 0,
      ended: false,
      createdAt: this.now(),
      lastMessageAt: this.now(),
      lastAudioAt: null,
      audioBytes: 0,
      audioReachingAi: false,
      lastResponseAt: null,
      lastSuggestionAt: null,
      lastSuggestionText: null,
      ordinal: 0,
      reconnectTimer: null,
      pingTimer: null,
      expiryTimer: null,
    };
    this.runtimes.set(sessionId, runtime);
    this.emitStatus(runtime);
    this.connect(runtime, call.joinUrl);
    return { callId: call.callId, model: call.model, reused: false };
  }

  private connect(runtime: BridgeRuntime, joinUrl: string): void {
    if (runtime.ended) return;
    let socket: AiBridgeSocket;
    try {
      socket =
        this.options.createSocket?.(joinUrl) ?? (new WebSocket(joinUrl) as unknown as AiBridgeSocket);
    } catch (error) {
      this.fail(runtime, sanitizeProviderDetail((error as Error)?.message) ?? 'AI connection failed.');
      return;
    }

    runtime.socket = socket;
    runtime.state = 'connecting';
    runtime.error = null;

    socket.on('open', () => {
      if (runtime.socket !== socket || runtime.ended) return;
      runtime.lastMessageAt = this.now();
      try {
        socket.send(
          JSON.stringify({
            type: 'audio.start',
            protocol: AI_PROTOCOL,
            sampleRate: AI_AUDIO_SAMPLE_RATE,
            format: 'pcm_s16le',
          })
        );
      } catch {
        this.fail(runtime, 'The AI service connection could not be initialised.');
        return;
      }
      this.startTimers(runtime);
    });

    socket.on('message', (data: unknown) => {
      if (runtime.socket !== socket || runtime.ended) return;
      // Binary frames from the model are not part of the contract and are
      // deliberately ignored: the AI is text-only.
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return;
      const message = parseJson(data);
      if (!message) return;
      runtime.lastMessageAt = this.now();
      this.handleUpstream(runtime, message);
    });

    socket.on('close', () => {
      if (runtime.socket !== socket) return;
      runtime.socket = null;
      this.clearTimers(runtime);
      if (runtime.ended) return;
      this.scheduleReconnect(runtime, runtime.error ?? 'The AI service connection closed.');
    });

    socket.on('error', (error: Error) => {
      if (runtime.socket !== socket || runtime.ended) return;
      runtime.error =
        sanitizeProviderDetail(error?.message, 200) ?? 'The AI service connection failed.';
      // `close` follows; recovery is scheduled there.
    });
  }

  private handleUpstream(runtime: BridgeRuntime, message: Record<string, unknown>): void {
    const kind = message.type;

    if (kind === 'ready') {
      if (typeof message.model === 'string' && message.model.trim()) {
        runtime.model = message.model.trim().slice(0, 80);
      }
      runtime.state = 'listening';
      runtime.error = null;
      this.emitStatus(runtime);
      return;
    }

    if (kind === 'status') {
      const status = message.status;
      if (status === 'thinking') {
        runtime.state = 'thinking';
      } else if (status === 'listening' || status === 'idle' || status === 'speaking') {
        // The pipeline is text-only: `speaking` is never reached, and if it were
        // it would still mean "model busy". Never report AI speech.
        runtime.state = 'listening';
      } else {
        return;
      }
      this.emitStatus(runtime);
      return;
    }

    if (kind === 'transcript') {
      if (message.speaker && message.speaker !== 'user') return;
      const text = boundedText(message.text);
      if (!text) return;
      runtime.ordinal = this.nextOrdinal(runtime, message.ordinal);
      this.options.onEvent(runtime.sessionId, {
        type: 'transcript',
        text,
        ordinal: runtime.ordinal,
        isFinal: message.isFinal !== false,
      });
      runtime.lastResponseAt = this.now();
      this.emitStatus(runtime);
      return;
    }

    if (kind === 'suggestion') {
      const text = boundedText(message.text, 1000);
      if (!text) return;
      // Never flood the panel with the same sentence twice in a row.
      if (runtime.lastSuggestionText === text) return;
      runtime.lastSuggestionText = text;
      runtime.ordinal = this.nextOrdinal(runtime, message.ordinal);
      runtime.lastSuggestionAt = this.now();
      runtime.lastResponseAt = runtime.lastSuggestionAt;
      this.options.onEvent(runtime.sessionId, {
        type: 'suggestion',
        text,
        ordinal: runtime.ordinal,
        isFinal: message.isFinal !== false,
      });
      this.emitStatus(runtime);
      return;
    }

    if (kind === 'error') {
      const detail =
        sanitizeProviderDetail(message.message, 200) ?? 'The AI model could not process the audio.';
      runtime.error = detail;
      const code = typeof message.code === 'string' ? message.code : '';
      if (code === 'MAX_DURATION' || code === 'PROTOCOL_ERROR') {
        this.emitStatus(runtime);
        this.end(runtime.sessionId, code.toLowerCase(), { silent: true });
        return;
      }
      // Per-segment failures must not tear down the session.
      this.emitStatus(runtime);
    }
  }



  private nextOrdinal(runtime: BridgeRuntime, value: unknown): number {
    const requested =
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    runtime.ordinal = Math.max(runtime.ordinal + 1, requested);
    return runtime.ordinal;
  }

  private startTimers(runtime: BridgeRuntime): void {
    this.clearTimers(runtime);
    runtime.pingTimer = setInterval(() => {
      if (runtime.ended || !isOpen(runtime.socket)) return;
      if (this.now() - runtime.lastMessageAt > AI_IDLE_TIMEOUT_MS) {
        runtime.error = 'The AI service stopped responding.';
        try {
          runtime.socket?.close(4000, 'idle');
        } catch {
          // The close handler schedules recovery.
        }
        return;
      }
      try {
        runtime.socket?.send(JSON.stringify({ type: 'ping', at: this.now() }));
      } catch {
        // Close handler recovers.
      }
    }, AI_PING_INTERVAL_MS);
    (runtime.pingTimer as unknown as { unref?: () => void }).unref?.();

    if (runtime.expiresAt) {
      const remaining = Math.max(0, runtime.expiresAt - this.now());
      runtime.expiryTimer = setTimeout(() => {
        if (runtime.ended) return;
        runtime.error = 'The AI call reached its maximum duration.';
        this.end(runtime.sessionId, 'max-duration');
      }, remaining);
      (runtime.expiryTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private scheduleReconnect(runtime: BridgeRuntime, reason: string): void {
    if (runtime.ended || this.stopped) return;
    const attempt = runtime.reconnectAttempt + 1;
    if (attempt > AI_MAX_RECONNECTS) {
      runtime.state = 'error';
      runtime.error = sanitizeProviderDetail(reason, 200) ?? 'The AI service is unavailable.';
      this.emitStatus(runtime);
      this.end(runtime.sessionId, 'giving-up', { silent: true });
      return;
    }
    runtime.reconnectAttempt = attempt;
    runtime.state = 'reconnecting';
    runtime.error = sanitizeProviderDetail(reason, 200);
    runtime.audioReachingAi = false;
    this.emitStatus(runtime);
    const delay =
      AI_RECONNECT_DELAYS_MS[Math.min(attempt - 1, AI_RECONNECT_DELAYS_MS.length - 1)];
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      if (runtime.ended || this.stopped) return;
      void this.recreate(runtime);
    }, delay);
    (runtime.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async recreate(runtime: BridgeRuntime): Promise<void> {
    const settings = this.options.settings;
    if (!settings) return;
    try {
      const call = await createAiCall(this.options.fetchImpl, settings, {
        sessionId: runtime.sessionId,
        systemPrompt: this.options.systemPrompt,
      });
      if (runtime.ended) {
        void endAiCallQuietly(this.options.fetchImpl, settings, call.callId);
        return;
      }
      runtime.callId = call.callId;
      runtime.model = call.model;
      runtime.expiresAt = call.expiresAt;
      runtime.error = null;
      runtime.audioBytes = 0;
      runtime.audioReachingAi = false;
      this.connect(runtime, call.joinUrl);
      this.emitStatus(runtime);
    } catch (error) {
      const detail =
        sanitizeProviderDetail(
          error instanceof AiServiceError ? error.detail ?? error.message : (error as Error)?.message,
          200
        ) ?? 'The AI service could not be reached.';
      this.scheduleReconnect(runtime, detail);
    }
  }

  private fail(runtime: BridgeRuntime, detail: string): void {
    runtime.error = detail;
    runtime.state = 'error';
    runtime.audioReachingAi = false;
    this.emitStatus(runtime);
    this.end(runtime.sessionId, 'failed', { silent: true });
  }

  private clearTimers(runtime: BridgeRuntime): void {
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    if (runtime.pingTimer) clearInterval(runtime.pingTimer);
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    runtime.reconnectTimer = null;
    runtime.pingTimer = null;
    runtime.expiryTimer = null;
  }

  private snapshot(runtime: BridgeRuntime): AiBridgeStatus {
    return {
      state: runtime.state,
      callId: runtime.callId,
      model: runtime.model,
      connected: runtime.state === 'listening' || runtime.state === 'thinking',
      listening: runtime.state === 'listening' || runtime.state === 'thinking',
      error: runtime.error,
      reconnectAttempt: runtime.reconnectAttempt,
      audioReachingAi: runtime.audioReachingAi && !runtime.ended,
      lastResponseAt: runtime.lastResponseAt,
      lastSuggestionAt: runtime.lastSuggestionAt,
    };
  }

  private emitStatus(runtime: BridgeRuntime): void {
    if (runtime.ended && runtime.state !== 'error') return;
    this.options.onEvent(runtime.sessionId, { type: 'status', ...this.snapshot(runtime) });
  }
}
