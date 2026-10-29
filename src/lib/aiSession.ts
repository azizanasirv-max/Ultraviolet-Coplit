/**
 * Self-hosted AI voice session (replaces the hosted `ultravox-client` SDK).
 *
 * The customer's browser captures its microphone a second time (the first
 * capture belongs to the human-to-human WebRTC call), downsamples it to 16 kHz
 * mono PCM and streams it to OUR server over a same-origin WebSocket at
 * `/ws/ai`. The server forwards it to the Modal model; model text goes to the
 * salesperson, never back to this page and never into the call.
 *
 * The only URL this class ever receives is the short-lived, single-use ticket
 * URL minted by `POST /api/sessions/:id/ai-call`. A cross-origin URL is refused
 * so a misconfiguration can never expose the Modal endpoint to a browser.
 *
 * The public surface deliberately mirrors the small subset of the previous SDK
 * that `CallEngine` used, so the AI lifecycle, recovery logic and dashboards are
 * unchanged:
 *
 *   status, transcripts, micSourceNode
 *   joinCall(ticketUrl), leaveCall(), muteMic(), unmuteMic(),
 *   muteSpeaker(), setOutputMedium(medium)
 *   events: 'status', 'transcripts', 'error'
 *
 * AI output is text-only: no audio is ever sent back to the customer, so the AI
 * can never talk over either participant.
 *
 * IMPORTANT: this file is transport logic only. It cannot prove that the
 * deployed Modal service transcribes and suggests correctly; see
 * docs/self-hosted-ai-modal.md for the manual verification checklist.
 */

/** Wire protocol version understood by the Modal service. */
export const AI_SESSION_PROTOCOL = 'salescopilot-ai/1';

/** Audio format sent to the service. */
export const AI_AUDIO_SAMPLE_RATE = 16000;
/** One outbound frame is 100 ms of 16 kHz mono PCM16. */
export const AI_FRAME_SAMPLES = (AI_AUDIO_SAMPLE_RATE * 100) / 1000;

/** Lifecycle states reported by a session (same values the UI already renders). */
export const AiSessionStatus = {
  DISCONNECTED: 'disconnected',
  DISCONNECTING: 'disconnecting',
  CONNECTING: 'connecting',
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
} as const;

export type AiSessionStatus = (typeof AiSessionStatus)[keyof typeof AiSessionStatus];

/** Transcript speakers, matching the copilot semantics used by the engine. */
export const Role = {
  USER: 'user',
  AGENT: 'agent',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/** Output medium. The self-hosted pipeline is text-only by design. */
export const Medium = {
  TEXT: 'text',
  VOICE: 'voice',
} as const;

export type Medium = (typeof Medium)[keyof typeof Medium];

export interface AiTranscript {
  text: string;
  isFinal: boolean;
  speaker: Role;
  medium: Medium;
  ordinal: number;
}

/**
 * The surface `CallEngine` depends on. Any implementation (the real
 * `SelfHostedAiSession` or a test fake) must provide exactly this.
 *
 * `EventTarget` supplies `addEventListener('status' | 'transcripts' | 'error')`.
 */
export interface AiVoiceSession extends EventTarget {
  readonly status: AiSessionStatus;
  readonly transcripts: readonly AiTranscript[];
  /** Non-null once the microphone is actually being sent to the AI. */
  readonly micSourceNode: unknown;
  joinCall(joinUrl: string): void;
  leaveCall(): Promise<void>;
  muteMic(): void;
  unmuteMic(): void;
  muteSpeaker(): void;
  setOutputMedium(medium: Medium): void;
}

export interface SelfHostedAiSessionOptions {
  /** Test seams. Production uses the browser globals. */
  createWebSocket?: (url: string) => WebSocket;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  /** How often a ping is sent to the service (ms). */
  pingIntervalMs?: number;
  /** No message from the service for this long means the session is dead (ms). */
  idleTimeoutMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
/** Backpressure guard: stop queueing audio rather than growing memory. */
const MAX_BUFFERED_BYTES = 1_000_000;


/** AudioWorklet source: batches render quanta into one message per 2048 frames. */
const CAPTURE_WORKLET_SOURCE = `
class SalesCopilotCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this._buffer.length - this._offset);
      this._buffer.set(channel.subarray(read, read + take), this._offset);
      this._offset += take;
      read += take;
      if (this._offset === this._buffer.length) {
        this.port.postMessage(this._buffer.slice());
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('salescopilot-ai-capture', SalesCopilotCapture);
`;

/**
 * Converts float samples to mono PCM16 at 16 kHz using a box filter. Speech
 * recognition is not sensitive to the small aliasing this introduces, and it
 * avoids shipping a resampling dependency to the browser.
 */
export const resampleToPcm16 = (input: Float32Array, inputRate: number): Int16Array => {
  const ratio = inputRate > 0 ? inputRate / AI_AUDIO_SAMPLE_RATE : 1;
  if (!(ratio > 1)) {
    const direct = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const value = Math.max(-1, Math.min(1, input[index] ?? 0));
      direct[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return direct;
  }

  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor] ?? 0;
    const value = end > start ? sum / (end - start) : input[start] ?? 0;
    const clamped = Math.max(-1, Math.min(1, value));
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
};

/**
 * Rejects any AI socket URL that is not this page's origin. Node/test harnesses
 * have no `location`, so the check is skipped there (the server is authoritative).
 */
const isSameOriginSocketUrl = (value: string): boolean => {
  const location = (globalThis as { location?: Location }).location;
  if (!location || !location.host) return true;
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return false;
    return url.host === location.host;
  } catch {
    return false;
  }
};

const LIVE_STATUSES: ReadonlySet<string> = new Set([
  AiSessionStatus.IDLE,
  AiSessionStatus.LISTENING,
  AiSessionStatus.THINKING,
  AiSessionStatus.SPEAKING,
]);

/**
 * One AI session over one WebSocket to the self-hosted service.
 *
 * Lifecycle: CONNECTING -> CONNECTING (socket open) -> LISTENING (microphone
 * frames are flowing) -> IDLE/THINKING/SPEAKING as reported by the service.
 * Any transport or service failure dispatches `error` and then DISCONNECTED, so
 * the engine's existing bounded recovery applies unchanged.
 */
export class SelfHostedAiSession extends EventTarget implements AiVoiceSession {
  status: AiSessionStatus = AiSessionStatus.DISCONNECTED;
  transcripts: AiTranscript[] = [];
  micSourceNode: unknown = null;

  private readonly options: SelfHostedAiSessionOptions;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private captureNode: AudioNode | null = null;
  private sinkNode: GainNode | null = null;
  private pending: Int16Array = new Int16Array(0);
  private ordinal = 0;
  private micMuted = false;
  private speakerMuted = false;
  private outputMedium: Medium = Medium.TEXT;
  private closedByCaller = false;
  private failed = false;
  private pingTimer: number | null = null;
  private lastMessageAt = 0;

  constructor(options: SelfHostedAiSessionOptions = {}) {
    super();
    this.options = options;
  }

  /** Joins the server's AI audio socket. `socketUrl` must be same-origin. */
  joinCall(socketUrl: string): void {
    if (this.socket || this.status !== AiSessionStatus.DISCONNECTED) {
      void this.leaveCall();
    }

    this.closedByCaller = false;
    this.failed = false;
    this.transcripts = [];
    this.ordinal = 0;
    this.pending = new Int16Array(0);
    this.micSourceNode = null;
    this.setStatus(AiSessionStatus.CONNECTING);

    if (!isSameOriginSocketUrl(socketUrl)) {
      this.fail('The AI audio connection must use this application origin.');
      return;
    }

    let socket: WebSocket;
    try {
      socket = this.createSocket(socketUrl);
    } catch {
      this.fail('Could not open a connection to the AI service.');
      return;
    }

    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.sendJson({
        type: 'audio.start',
        protocol: AI_SESSION_PROTOCOL,
        sampleRate: AI_AUDIO_SAMPLE_RATE,
        format: 'pcm_s16le',
      });
      this.startTimers();
      void this.startCapture();
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.handleMessage(event.data);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.fail('The AI service connection failed.');
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closedByCaller || this.failed) return;
      this.stopTimers();
      this.stopCapture();
      this.setStatus(AiSessionStatus.DISCONNECTED);
    };
  }

  async leaveCall(): Promise<void> {
    this.closedByCaller = true;
    const socket = this.socket;
    this.socket = null;
    this.stopTimers();
    if (socket && socket.readyState === 1) {
      // Best effort: lets the service end the GPU segment promptly.
      try {
        socket.send(JSON.stringify({ type: 'audio.end' }));
      } catch {
        // Ignore: the socket is being torn down anyway.
      }
    }
    this.setStatus(AiSessionStatus.DISCONNECTING);
    this.stopCapture();
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore.
      }
    }
    this.micSourceNode = null;
    this.setStatus(AiSessionStatus.DISCONNECTED);
  }

  /**
   * Mutes only the AI stream. The human-to-human track belongs to `CallEngine`
   * and is never touched here: a muted customer must stay silent to both.
   */
  muteMic(): void {
    this.micMuted = true;
    this.pending = new Int16Array(0);
  }

  unmuteMic(): void {
    this.micMuted = false;
  }

  /** Kept for interface parity. The pipeline never returns audio. */
  muteSpeaker(): void {
    this.speakerMuted = true;
  }

  unmuteSpeaker(): void {
    this.speakerMuted = false;
  }

  /** Kept for interface parity. Only text output exists. */
  setOutputMedium(medium: Medium): void {
    this.outputMedium = medium;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private createSocket(joinUrl: string): WebSocket {
    const factory =
      this.options.createWebSocket ??
      ((url: string) => {
        const Ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
        if (!Ctor) throw new Error('WebSocket is unavailable in this browser.');
        return new Ctor(url);
      });
    return factory(joinUrl);
  }

  private sendJson(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // A send failure surfaces through onerror/onclose.
    }
  }

  private handleMessage(data: unknown): void {
    // The protocol is text-only. Binary frames are deliberately ignored:
    // playback is not implemented and must not be implied.
    if (typeof data !== 'string') return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (message.type) {
      case 'status': {
        if (isKnownStatus(message.status)) this.setStatus(message.status);
        return;
      }
      case 'transcript': {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!text) return;
        this.pushTranscript({
          text,
          isFinal: message.isFinal !== false,
          speaker: message.speaker === 'agent' ? Role.AGENT : Role.USER,
          medium: Medium.TEXT,
          ordinal: this.nextOrdinal(message.ordinal),
        });
        return;
      }
      case 'suggestion': {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!text) return;
        this.pushTranscript({
          text,
          isFinal: message.isFinal !== false,
          speaker: Role.AGENT,
          medium: Medium.TEXT,
          ordinal: this.nextOrdinal(message.ordinal),
        });
        return;
      }
      case 'error': {
        const detail =
          typeof message.message === 'string' && message.message.trim()
            ? message.message.trim()
            : 'The AI service reported an error.';
        this.fail(detail);
        return;
      }
      case 'ready':
      case 'pong':
      default:
        return;
    }
  }

  private nextOrdinal(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const ordinal = Math.floor(value);
      this.ordinal = Math.max(this.ordinal, ordinal);
      return ordinal;
    }
    this.ordinal += 1;
    return this.ordinal;
  }

  private pushTranscript(entry: AiTranscript): void {
    const existing = this.transcripts.findIndex((item) => item.ordinal === entry.ordinal);
    if (existing >= 0) this.transcripts[existing] = entry;
    else this.transcripts = [...this.transcripts, entry];
    this.dispatchEvent(new Event('transcripts'));
  }

  private setStatus(status: AiSessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new Event('status'));
  }

  private fail(message: string): void {
    if (this.failed || this.closedByCaller) return;
    this.failed = true;
    const event = new Event('error') as Event & { error: Error };
    event.error = new Error(sanitizeSessionError(message));
    this.dispatchEvent(event);
    this.stopTimers();
    this.stopCapture();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore.
      }
    }
    this.micSourceNode = null;
    this.setStatus(AiSessionStatus.DISCONNECTED);
  }

  private startTimers(): void {
    this.stopTimers();
    this.lastMessageAt = Date.now();
    const pingInterval = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const idleTimeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.pingTimer = globalThis.setInterval(() => {
      this.sendJson({ type: 'ping', at: Date.now() });
      if (Date.now() - this.lastMessageAt > idleTimeout) {
        this.fail('The AI service stopped responding.');
      }
    }, pingInterval) as unknown as number;
    // Node (tests, SSR) must not stay alive only for this heartbeat. Browsers
    // return a number here and have no `unref`.
    (this.pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) globalThis.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // -------------------------------------------------------------------------
  // Microphone capture
  // -------------------------------------------------------------------------

  private async startCapture(): Promise<void> {
    try {
      const getUserMedia =
        this.options.getUserMedia ??
        ((constraints: MediaStreamConstraints) => {
          const mediaDevices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
          if (!mediaDevices?.getUserMedia) {
            throw new Error('This browser cannot capture a microphone.');
          }
          return mediaDevices.getUserMedia(constraints);
        });

      const stream = await getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.failed || this.closedByCaller) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;

      const factory =
        this.options.createAudioContext ??
        (() => {
          const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
          if (!Ctor) throw new Error('This browser cannot process microphone audio.');
          return new Ctor();
        });
      const context = factory();
      this.context = context;
      if (context.state === 'suspended') await context.resume().catch(() => undefined);

      const source = context.createMediaStreamSource(stream);
      const sink = context.createGain();
      sink.gain.value = 0;
      sink.connect(context.destination);
      this.sinkNode = sink;

      const handle = (samples: Float32Array) => this.onSamples(samples, context.sampleRate);

      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          const moduleUrl = URL.createObjectURL(
            new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' })
          );
          try {
            await context.audioWorklet.addModule(moduleUrl);
          } finally {
            URL.revokeObjectURL(moduleUrl);
          }
          const node = new AudioWorkletNode(context, 'salescopilot-ai-capture');
          node.port.onmessage = (event: MessageEvent) => handle(event.data as Float32Array);
          source.connect(node);
          node.connect(sink);
          this.captureNode = node;
          return;
        } catch {
          // Fall through to the widely supported ScriptProcessor fallback.
        }
      }

      if (typeof context.createScriptProcessor !== 'function') {
        throw new Error('This browser cannot process microphone audio.');
      }
      const node = context.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event: AudioProcessingEvent) =>
        handle(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(sink);
      this.captureNode = node;
    } catch (error) {
      this.fail(sanitizeSessionError(error));
      return;
    }
    // The transport is open and the microphone is capturing: the session is
    // live from the engine's point of view. `micSourceNode` still only becomes
    // non-null once a frame has actually been sent.
    this.setStatus(AiSessionStatus.LISTENING);
  }

  private onSamples(samples: Float32Array, inputRate: number): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    if (this.micMuted) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;

    const pcm = resampleToPcm16(samples, inputRate);
    if (!pcm.length) return;

    const merged = new Int16Array(this.pending.length + pcm.length);
    merged.set(this.pending, 0);
    merged.set(pcm, this.pending.length);

    let offset = 0;
    while (merged.length - offset >= AI_FRAME_SAMPLES) {
      const frame = merged.subarray(offset, offset + AI_FRAME_SAMPLES);
      offset += AI_FRAME_SAMPLES;
      try {
        socket.send(frame.slice().buffer);
      } catch {
        return;
      }
      if (!this.micSourceNode && this.captureNode) {
        // The microphone is genuinely reaching the AI from this point on.
        this.micSourceNode = this.captureNode;
        this.dispatchEvent(new Event('status'));
      }
    }
    this.pending = merged.slice(offset);
  }

  private stopCapture(): void {
    const node = this.captureNode;
    this.captureNode = null;
    if (node) {
      try {
        node.disconnect();
      } catch {
        // Ignore.
      }
      const worklet = node as AudioWorkletNode;
      if (worklet.port) worklet.port.onmessage = null;
      if ('onaudioprocess' in node) (node as ScriptProcessorNode).onaudioprocess = null;
    }
    if (this.sinkNode) {
      try {
        this.sinkNode.disconnect();
      } catch {
        // Ignore.
      }
      this.sinkNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.context) {
      void this.context.close().catch(() => undefined);
      this.context = null;
    }
    this.pending = new Int16Array(0);
  }
}

/** Never forward a URL or token from a browser error to the dashboard. */
const sanitizeSessionError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const text = message
    .replace(/wss?:\/\/\S+/gi, '[url redacted]')
    .replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(
      /((?:token|api[_-]?key|authorization|credential|password|secret)\s*[=:]\s*)\S+/gi,
      '$1[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 300) || 'The AI session could not start.';
};

const isKnownStatus = (value: unknown): value is AiSessionStatus =>
  typeof value === 'string' && (Object.values(AiSessionStatus) as string[]).includes(value);

/** True when a reported status means a live session. */
export const isLiveAiSessionStatus = (status: AiSessionStatus | null): boolean =>
  Boolean(status && LIVE_STATUSES.has(status));
