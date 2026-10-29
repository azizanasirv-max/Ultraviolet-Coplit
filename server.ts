/**
 * Prototype 2 server: session API, invitation redemption, role-enforcing
 * WebSocket signaling and the self-hosted AI call proxy.
 *
 * Trust boundaries:
 *   - The browser never sees AI_SERVICE_TOKEN. TURN credentials are only sent to
 *     browsers that need to establish media.
 *   - Session membership is proven by a credential (salesperson key or the
 *     customer key derived from a redeemed invitation). A URL parameter alone
 *     grants nothing.
 *   - Signaling is relayed only between the two authorized participants of the
 *     same session; unknown peers get a machine-readable `signal_error`.
 */
import express, { Request, Response } from 'express';
import http from 'http';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ParticipantRole, SessionRecord, SessionStore } from './server/sessionStore';
import {
  buildIceConfig,
  describeIceSettingsForLog,
  fetchProviderIceServers,
  fetchRstreamTurnCredentials,
  mergeProviderIceServers,
  mergeRstreamIceServers,
  ProviderIceResult,
  resolveIceTransportPolicy,
  resolveTurnSettings,
  RstreamTurnResult,
  turnSummary,
} from './server/turn';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  AdminSetupPasswordError,
  claimAdminSetupPassword,
  createAdminSession,
  getAdminSetupStatus,
  isAdminSetupClaimed,
  readAdminSessionFromCookie,
  verifyAdminCsrfToken,
  verifyAdminSetupPassword,
} from './server/admin';
import type { AdminSession } from './server/admin';
import { renderAdminPage } from './server/adminPage';
import type { AdminPageMode } from './server/adminPage';
import {
  ExpressTurnValidationError,
  clearExpressTurnCredentials,
  getExpressTurnCredentials,
  getExpressTurnStatus,
  setExpressTurnCredentials,
} from './server/expressTurn';
import {
  AiServiceError,
  AiServiceSettings,
  aiServiceReadiness,
  resolveAiServiceSettings,
  sanitizeProviderDetail,
} from './server/aiService';
import {
  AI_MAX_FRAME_BYTES,
  AI_PROTOCOL,
  AI_SYSTEM_PROMPT,
  AiBridgeEvent,
  AiBridgeManager,
  AiBridgeSocket,
} from './server/aiBridge';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500);
const JOIN_DEADLINE_MS = 10000;
const REDEEM_RATE_LIMIT = 30;
const REDEEM_RATE_WINDOW_MS = 60_000;

/** AI readiness: the app serves human audio even when the AI is unconfigured. */
const aiReadiness = () => aiServiceReadiness(process.env);

const configuredPublicUrl = (): string | null => {
  const value = process.env.APP_URL?.trim();
  if (!value || value === 'MY_APP_URL') return null;
  if (!/^https?:\/\//i.test(value)) return null;
  return value.replace(/\/+$/, '');
};

/** APP_URL sanity checks: invitation links and WSS depend on it. */
const appUrlDiagnostics = () => {
  const configured = configuredPublicUrl();
  const warnings: string[] = [];
  if (!configured) {
    warnings.push(
      'APP_URL is not set: invitation links fall back to the request host. Set APP_URL to the public https Render URL.'
    );
  } else {
    if (process.env.NODE_ENV === 'production' && !configured.startsWith('https://')) {
      warnings.push(
        'APP_URL must use https in production, otherwise microphone access and WSS fail for the customer.'
      );
    }
    if (/localhost|127\.0\.0\.1/i.test(configured) && process.env.NODE_ENV === 'production') {
      warnings.push('APP_URL points at localhost in production; customers cannot open that link.');
    }
  }
  return { configured, warnings };
};

const roleOf = (value: unknown): ParticipantRole | null =>
  value === 'customer' || value === 'salesperson' ? value : null;

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  return null;
};

const publicBaseUrl = (req: Request): string => {
  const configured = configuredPublicUrl();
  if (configured) return configured;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto =
    (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : '') ||
    (req.secure ? 'https' : 'http');
  const forwardedHost = req.headers['x-forwarded-host'];
  const host =
    (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : '') ||
    req.headers.host ||
    'localhost';
  return `${proto}://${host}`;
};

const inviteUrlFor = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/join?invite=${encodeURIComponent(token)}`;

export interface CreateServerOptions {
  /** Injected for tests. */
  store?: SessionStore;
  /** Disable Vite/static serving (API + WebSocket only test mode). */
  serveFrontend?: boolean;
  /**
   * Injected for tests so no real self-hosted AI call is created.
   */
  aiServiceFetch?: typeof fetch;
  /**
   * Explicit AI service settings. Production reads them from the environment;
   * tests inject them (or null to prove the AI-off path).
   */
  aiSettings?: AiServiceSettings | null;
  /** Test seam: replace the upstream Modal WebSocket client. */
  aiSocketFactory?: (url: string) => AiBridgeSocket;
  /** Injected for tests so no real TURN credential provider is called. */
  turnFetch?: typeof fetch;
  /** Per-server cache for provider-issued TURN credentials. */
  turnCache?: Map<string, ProviderIceResult>;
  /** Per-server cache for rstream-issued TURN credentials. */
  rstreamCache?: Map<string, RstreamTurnResult>;
  /** 0 picks a free port. */
  port?: number;
}

interface SocketState {
  participantId: string;
  sessionId: string;
  role: ParticipantRole;
  superseded: boolean;
  joined: boolean;
}

export async function createPrototype2Server(options: CreateServerOptions = {}) {
  const store = options.store ?? new SessionStore();
  const aiServiceFetch = options.aiServiceFetch ?? fetch;
  const turnFetch = options.turnFetch ?? fetch;
  const turnCache = options.turnCache ?? new Map<string, ProviderIceResult>();
  const rstreamCache = options.rstreamCache ?? new Map<string, RstreamTurnResult>();

  /**
   * ExpressTURN credentials are entered at /admin/turn and held in this
   * process's memory only (lost on restart by design). Nothing is read from the
   * environment, a disk or a database.
   */
  const expressTurnOptions = () => ({ expressTurn: getExpressTurnCredentials() });

  /**
   * One in-flight AI call creation per session. Two concurrent "reconnect"
   * presses must not create (and pay for) two GPU calls.
   */
  const aiCallInFlight = new Set<string>();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  /** Customer -> server audio upload only. Not a participant socket. */
  const aiWss = new WebSocketServer({ noServer: true, maxPayload: AI_MAX_FRAME_BYTES });

  /** Authoritative map participantId -> live socket. */
  const sockets = new Map<string, WebSocket>();
  const socketState = new WeakMap<WebSocket, SocketState>();

  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const allowRequest = (key: string): boolean => {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + REDEEM_RATE_WINDOW_MS });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= REDEEM_RATE_LIMIT;
  };

  const safeSend = (ws: WebSocket | undefined, payload: unknown): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error('WebSocket send failed:', (err as Error)?.message);
      return false;
    }
  };

  const connectedParticipants = (session: SessionRecord) =>
    [session.salesperson, session.customer]
      .filter((p): p is NonNullable<typeof p> => Boolean(p && p.connected))
      .map((p) => ({ participantId: p.participantId, role: p.role, joinedAt: p.connectedAt }));

  const peersOf = (session: SessionRecord, exceptParticipantId: string) =>
    connectedParticipants(session).filter((p) => p.participantId !== exceptParticipantId);

  // The customer never receives internal AI state (`aiReady`/`aiCallCreated`
  // reveal that an AI call exists, and `ai` is the live AI lifecycle). Role-
  // specific views are built on the server, not hidden in the UI.
  const stateFor = (session: SessionRecord, role: ParticipantRole) => {
    const state = store.publicState(session);
    if (role !== 'customer') return state;
    const {
      aiReady: _aiReady,
      aiCallCreated: _aiCallCreated,
      ai: _ai,
      ...customerSafe
    } = state;
    return customerSafe;
  };

  const broadcastSession = (session: SessionRecord) => {
    for (const participant of [session.salesperson, session.customer]) {
      if (!participant?.connected) continue;
      safeSend(sockets.get(participant.participantId), {
        type: 'session_state',
        sessionId: session.sessionId,
        session: stateFor(session, participant.role),
        participants: connectedParticipants(session),
      });
    }
  };

  const counterpartOf = (session: SessionRecord, role: ParticipantRole) =>
    role === 'salesperson' ? session.customer : session.salesperson;

  // -------------------------------------------------------------------------
  // Server-side AI bridge
  //
  // ONE outbound path to the Modal service. The browser only ever receives a
  // single-use same-origin ticket; the upstream URL and credentials never leave
  // this process. Only the customer's audio socket may feed it.
  // -------------------------------------------------------------------------

  const AI_TICKET_TTL_MS = 120_000;
  const AI_TICKET_MAX = 2_000;
  const aiTickets = new Map<
    string,
    { sessionId: string; role: ParticipantRole; expiresAt: number }
  >();
  /** sessionId -> the single live customer audio socket. */
  const aiSockets = new Map<string, WebSocket>();

  const pruneAiTickets = (now = Date.now()) => {
    for (const [token, ticket] of aiTickets) {
      if (ticket.expiresAt <= now) aiTickets.delete(token);
    }
    while (aiTickets.size >= AI_TICKET_MAX) {
      const oldest = aiTickets.keys().next().value;
      if (!oldest) break;
      aiTickets.delete(oldest);
    }
  };

  /**
   * A ticket is bound to the session AND to the role that requested it. Only a
   * customer ticket can ever open `/ws/ai`, so a salesperson cannot feed their
   * own microphone (or any other audio) to the model.
   */
  const mintAiTicket = (sessionId: string, role: ParticipantRole) => {
    pruneAiTickets();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + AI_TICKET_TTL_MS;
    aiTickets.set(token, { sessionId, role, expiresAt });
    return { token, expiresAt };
  };

  const consumeAiTicket = (
    token: string
  ): { sessionId: string; role: ParticipantRole } | null => {
    const ticket = aiTickets.get(token);
    if (!ticket) return null;
    aiTickets.delete(token);
    if (ticket.expiresAt <= Date.now()) return null;
    return { sessionId: ticket.sessionId, role: ticket.role };
  };

  /**
   * Origin of THIS request, not APP_URL: the AI socket is same-origin by
   * design, so it must match the page the customer actually loaded (including
   * localhost development). APP_URL is still used for invitation links.
   */
  const requestOrigin = (req: Request): string => {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto =
      (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : '') ||
      (req.secure ? 'https' : 'http');
    const forwardedHost = req.headers['x-forwarded-host'];
    const host =
      (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : '') ||
      req.headers.host ||
      'localhost';
    return `${proto}://${host}`;
  };

  const aiSocketUrlFor = (req: Request, token: string): string =>
    `${requestOrigin(req).replace(/^http/i, 'ws')}/ws/ai?ticket=${encodeURIComponent(token)}`;

  const sendSalesperson = (session: SessionRecord, payload: unknown): boolean => {
    const salesperson = session.salesperson;
    if (!salesperson?.connected) return false;
    return safeSend(sockets.get(salesperson.participantId), payload);
  };

  /**
   * Translates bridge events into the two existing text channels: the
   * salesperson's signaling messages and the customer audio socket's status.
   * Audio is never involved and the model can never address the customer page.
   */
  const handleAiEvent = (sessionId: string, event: AiBridgeEvent): void => {
    const session = store.getSession(sessionId);
    if (!session) return;
    const timestamp = new Date().toISOString();

    if (event.type === 'status') {
      // Expose the dashboard's lifecycle vocabulary: the bridge's finer states
      // (`listening`/`thinking`) map to `connected`, never to a fake `speaking`.
      const lifecycle =
        event.state === 'listening' || event.state === 'thinking'
          ? 'connected'
          : event.state === 'connecting'
            ? 'connecting'
            : event.state === 'reconnecting'
              ? 'reconnecting'
              : event.state === 'error'
                ? 'error'
                : 'disconnected';
      store.setAiRuntime(sessionId, {
        state: lifecycle,
        connected: event.connected,
        error: event.error,
        callId: event.callId,
        reconnectAttempt: event.reconnectAttempt,
        audioReachingAi: event.audioReachingAi,
        lastResponseAt: event.lastResponseAt,
        lastSuggestionAt: event.lastSuggestionAt,
      });
      sendSalesperson(session, {
        type: 'ai_status',
        state: lifecycle,
        activity:
          event.state === 'thinking'
            ? 'generating'
            : event.state === 'listening'
              ? 'listening'
              : event.state === 'error'
                ? 'error'
                : event.state === 'connecting' || event.state === 'reconnecting'
                  ? 'connecting'
                  : 'idle',
        connected: event.connected,
        listening: event.listening,
        error: event.error,
        callId: event.callId,
        reconnectAttempt: event.reconnectAttempt,
        maxReconnectAttempts: 2,
        audioReachingAi: event.audioReachingAi,
        lastResponseAt: event.lastResponseAt,
        lastSuggestionAt: event.lastSuggestionAt,
        timestamp,
      });

      const audioSocket = aiSockets.get(sessionId);
      if (audioSocket) {
        if (event.state === 'error') {
          // Fatal bridge failure: the browser session reports an error and its
          // bounded recovery asks the server for a fresh ticket. The human call
          // is never touched.
          safeSend(audioSocket, {
            type: 'error',
            message: event.error ?? 'The AI session failed.',
            code: 'AI_ERROR',
          });
        } else {
          const transportStatus =
            event.state === 'listening' || event.state === 'thinking'
              ? event.state
              : event.state === 'connecting' || event.state === 'reconnecting'
                ? 'connecting'
                : 'disconnecting';
          safeSend(audioSocket, { type: 'status', status: transportStatus });
        }
      }

      broadcastSession(store.getSession(sessionId) as SessionRecord);
      return;
    }

    if (event.type === 'transcript') {
      // The customer's own speech, used by the salesperson for context. It is
      // sent only to the salesperson; the customer page never receives it back.
      sendSalesperson(session, {
        type: 'customer_speech_transcript',
        text: event.text,
        isFinal: event.isFinal,
        ordinal: event.ordinal,
        timestamp,
      });
      return;
    }

    store.countSignal(sessionId, 'aiSuggestions');
    store.setAiRuntime(sessionId, {
      state: 'listening',
      connected: true,
      error: null,
      audioReachingAi: true,
      lastResponseAt: Date.now(),
      lastSuggestionAt: Date.now(),
    });
    sendSalesperson(session, {
      type: 'ai_suggestion',
      text: event.text,
      isFinal: event.isFinal,
      ordinal: event.ordinal,
      timestamp,
    });
    broadcastSession(store.getSession(sessionId) as SessionRecord);
  };

  const aiBridge = new AiBridgeManager({
    settings:
      options.aiSettings !== undefined
        ? options.aiSettings
        : resolveAiServiceSettings(process.env),
    fetchImpl: aiServiceFetch,
    systemPrompt: AI_SYSTEM_PROMPT,
    createSocket: options.aiSocketFactory,
    onEvent: handleAiEvent,
  });

  /** Restart requested over signaling by the salesperson. Never touches media. */
  const restartAiFromSignaling = async (
    session: SessionRecord,
    participant: NonNullable<ReturnType<typeof store.getParticipant>>
  ): Promise<void> => {
    try {
      const call = await aiBridge.restart(session.sessionId);
      store.setAiCall(session.sessionId, {
        callId: call.callId,
        createdAt: Date.now(),
        createdByParticipantId: participant.participant.participantId,
      });
    } catch (err) {
      const message =
        sanitizeProviderDetail((err as Error)?.message, 200) ??
        'The AI service could not be restarted.';
      store.setAiRuntime(session.sessionId, {
        state: 'error',
        connected: false,
        error: message,
        audioReachingAi: false,
      });
      sendSalesperson(session, {
        type: 'ai_status',
        state: 'error',
        connected: false,
        listening: false,
        error: message,
        callId: null,
        reconnectAttempt: 0,
        maxReconnectAttempts: 2,
        audioReachingAi: false,
        timestamp: new Date().toISOString(),
      });
      broadcastSession(store.getSession(session.sessionId) as SessionRecord);
    }
  };

  /**
   * Customer audio upload socket.
   *
   * Authorization is a single-use ticket minted by `/api/sessions/:id/ai-call`
   * for an authorized session participant. Only binary PCM16 frames are
   * accepted; `audio.start` must declare the verified contract (16 kHz, mono,
   * PCM signed 16-bit little-endian). The salesperson has no way to reach this
   * path, so salesperson speech can never enter the AI pipeline.
   */
  aiWss.on('connection', (ws: WebSocket, request) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      ws.close(4400, 'bad request');
      return;
    }
    const ticket = url.searchParams.get('ticket') ?? '';
    const granted = consumeAiTicket(ticket);
    if (!granted) {
      ws.close(4401, 'invalid ticket');
      return;
    }
    if (granted.role !== 'customer') {
      // Defense in depth: salesperson audio must never enter the AI pipeline.
      ws.close(4403, 'customer audio only');
      return;
    }
    const sessionId = granted.sessionId;
    const session = store.getSession(sessionId);
    if (!session || store.isExpiredSession(sessionId)) {
      ws.close(4404, 'session not found');
      return;
    }
    if (!session.customer?.connected) {
      ws.close(4409, 'customer not connected');
      return;
    }

    // One audio socket per room. A reconnect supersedes the old socket instead
    // of creating a second audio source (and a second bridge consumer).
    const previous = aiSockets.get(sessionId);
    if (previous && previous !== ws) {
      aiSockets.delete(sessionId);
      try {
        previous.close(4001, 'superseded');
      } catch {
        // Ignore.
      }
    }
    aiSockets.set(sessionId, ws);
    store.setAiRuntime(sessionId, {
      state: 'creating',
      connected: false,
      error: null,
      audioReachingAi: false,
      reconnectAttempt: 0,
    });

    const maxSeconds = Math.min(3600, Math.max(1, Number(process.env.AI_MAX_CALL_SECONDS) || 3600));
    const MAX_AUDIO_BYTES = maxSeconds * 16000 * 2;
    let started = false;
    let audioBytes = 0;
    let ended = false;

    const endBridge = (reason: string) => {
      if (ended) return;
      ended = true;
      if (aiSockets.get(sessionId) === ws) aiSockets.delete(sessionId);
      aiBridge.end(sessionId, reason);
    };

    ws.on('message', (raw, isBinary) => {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (isBinary) {
        if (!started) return;
        if (data.length === 0 || data.length > AI_MAX_FRAME_BYTES || data.length % 2 !== 0) return;
        audioBytes += data.length;
        if (audioBytes > MAX_AUDIO_BYTES) {
          safeSend(ws, {
            type: 'error',
            code: 'MAX_DURATION',
            message: 'The AI audio stream reached its maximum duration.',
          });
          endBridge('max-duration');
          try {
            ws.close(4008, 'max audio');
          } catch {
            // Ignore.
          }
          return;
        }
        aiBridge.pushAudio(sessionId, data);
        return;
      }

      if (data.length > 4096) return;
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data.toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      if (!started) {
        if (message.type !== 'audio.start' && message.type !== 'join') {
          safeSend(ws, {
            type: 'error',
            code: 'AI_PROTOCOL',
            message: 'The first AI message must be audio.start.',
          });
          return;
        }
        if (message.protocol !== undefined && message.protocol !== AI_PROTOCOL) {
          safeSend(ws, {
            type: 'error',
            code: 'AI_PROTOCOL',
            message: 'Unsupported AI audio protocol.',
          });
          try {
            ws.close(4400, 'protocol');
          } catch {
            // Ignore.
          }
          return;
        }
        if (message.sampleRate !== undefined && Number(message.sampleRate) !== 16000) {
          safeSend(ws, {
            type: 'error',
            code: 'AI_AUDIO_FORMAT',
            message: 'The AI pipeline accepts 16 kHz audio only.',
          });
          return;
        }
        if (message.format !== undefined && message.format !== 'pcm_s16le') {
          safeSend(ws, {
            type: 'error',
            code: 'AI_AUDIO_FORMAT',
            message: 'The AI pipeline accepts PCM signed 16-bit little-endian audio only.',
          });
          return;
        }
        started = true;
        safeSend(ws, { type: 'ready', protocol: AI_PROTOCOL, sampleRate: 16000, frameBytes: 3200 });
        const status = aiBridge.status(sessionId);
        safeSend(ws, {
          type: 'status',
          status:
            status?.state === 'thinking'
              ? 'thinking'
              : status?.state === 'listening'
                ? 'listening'
                : 'connecting',
        });
        return;
      }

      if (message.type === 'ping') {
        safeSend(ws, { type: 'pong', at: message.at });
        return;
      }
      if (message.type === 'audio.end' || message.type === 'stop') {
        endBridge('client stopped');
        try {
          ws.close(1000, 'done');
        } catch {
          // Ignore.
        }
      }
    });

    ws.on('close', () => {
      endBridge('audio socket closed');
    });
    ws.on('error', (err) => {
      console.error('[ai] audio socket error:', (err as Error)?.message);
    });
  });

  // -------------------------------------------------------------------------
  // HTTP API: sessions, invitations, diagnostics
  // -------------------------------------------------------------------------

  const requireSalesperson = (req: Request, res: Response): SessionRecord | null => {
    const session = store.authorizeSalesperson(req.params.sessionId, bearer(req));
    if (!session) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'A valid salesperson credential is required for this session.',
      });
      return null;
    }
    return session;
  };

  /** Creates a session. The response contains the only copy of the salesperson key. */
  app.post('/api/sessions', (req, res) => {
    if (store.stats().sessions >= MAX_SESSIONS) {
      store.sweep();
      if (store.stats().sessions >= MAX_SESSIONS) {
        res.status(503).json({ error: 'CAPACITY', message: 'Too many active sessions. Try again shortly.' });
        return;
      }
    }

    const label = typeof req.body?.label === 'string' ? req.body.label : 'Sales call';
    const created = store.createSession(label);
    const invitation = store.createInvitation(created.sessionId);

    res.status(201).json({
      sessionId: created.sessionId,
      salespersonKey: created.salespersonKey,
      sessionExpiresAt: created.expiresAt,
      inviteUrl: invitation ? inviteUrlFor(publicBaseUrl(req), invitation.token) : null,
      inviteExpiresAt: invitation?.expiresAt ?? null,
    });
  });

  /** Salesperson view of the session (no secrets). */
  app.get('/api/sessions/:sessionId', (req, res) => {
    const session = requireSalesperson(req, res);
    if (!session) return;
    res.json({
      session: store.publicState(session),
      participants: connectedParticipants(session),
    });
  });

  /** Rotates the invitation, revoking the previous one. */
  app.post('/api/sessions/:sessionId/invitations', (req, res) => {
    const session = requireSalesperson(req, res);
    if (!session) return;
    const invitation = store.createInvitation(session.sessionId);
    if (!invitation) {
      res.status(409).json({ error: 'SESSION_EXPIRED', message: 'This session has ended.' });
      return;
    }
    res.json({
      inviteUrl: inviteUrlFor(publicBaseUrl(req), invitation.token),
      inviteExpiresAt: invitation.expiresAt,
      session: store.publicState(session),
    });
  });

  app.post('/api/sessions/:sessionId/invitations/revoke', (req, res) => {
    const session = requireSalesperson(req, res);
    if (!session) return;
    const revoked = store.revokeInvitation(session.sessionId);
    res.json({ revoked, session: store.publicState(session) });
  });

  /** Backend-side diagnosis of signaling and routing, independent of the UI. */
  app.get('/api/sessions/:sessionId/diagnostics', (req, res) => {
    const session = requireSalesperson(req, res);
    if (!session) return;
    const diagnostics = store.diagnostics(session);
    res.json({
      diagnostics,
      // Summary only: never include TURN credentials here.
      ice: turnSummary(),
      hasAiService: aiReadiness().ready,
      ai: aiReadiness(),
    });
  });

  /**
   * Redeems a customer invitation. Returns a session-scoped customer key that is
   * required for the WebSocket join and for the AI call request.
   */
  app.post('/api/invitations/redeem', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!allowRequest(ip)) {
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and retry.' });
      return;
    }

    const inviteToken = typeof req.body?.inviteToken === 'string' ? req.body.inviteToken.trim() : '';
    const customerKey = typeof req.body?.customerKey === 'string' ? req.body.customerKey : null;

    if (!inviteToken || inviteToken.length > 200) {
      res.status(400).json({ error: 'INVALID_INVITATION', message: 'An invitation token is required.' });
      return;
    }

    const result = store.redeemInvitation(inviteToken, customerKey);
    if (!result.ok) {
      console.warn(`[invite] redemption rejected: ${result.code}`);
      const status = result.code === 'INVITE_NOT_FOUND' ? 404 : 403;
      res.status(status).json({ error: result.code, message: result.message });
      return;
    }

    res.json({
      sessionId: result.sessionId,
      customerKey: result.customerKey,
      resumed: result.resumed,
      session: (({ aiReady: _aiReady, aiCallCreated: _aiCallCreated, ai: _ai, ...safe }) => safe)(
        result.session
      ),
      baseUrl: publicBaseUrl(req),
    });
  });

  /**
   * Starts (or restarts) the server-side AI bridge for one session.
   *
   * The response contains a short-lived, single-use same-origin ticket URL. The
   * Modal endpoint, the signed upstream join URL and every credential stay on
   * the server. Audio is accepted only from the customer at `/ws/ai`.
   *
   * Both participants may start/restart the AI (the salesperson owns the
   * suggestion panel); neither may submit audio through this route.
   */
  const createAiCallRoute = async (req: Request, res: Response) => {
    const session = store.getSession(req.params.sessionId);
    if (!session || store.isExpiredSession(session.sessionId)) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Unknown or expired session.' });
      return;
    }

    const credential = bearer(req);
    const isCustomer = Boolean(store.authorizeCustomer(session.sessionId, credential));
    const isSalesperson = Boolean(store.authorizeSalesperson(session.sessionId, credential));
    if (!isCustomer && !isSalesperson) {
      store.countSignal(session.sessionId, 'rejectedMessages');
      console.warn(
        `[session:${session.sessionId.slice(0, 8)}] rejected AI call request: not a session participant`
      );
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Only a participant of this session may start the AI copilot.',
      });
      return;
    }

    const settings = resolveAiServiceSettings(process.env);
    if (!settings) {
      store.setAiRuntime(session.sessionId, {
        state: 'error',
        connected: false,
        error: 'The AI service is not configured on the server.',
        audioReachingAi: false,
      });
      res.status(503).json({
        error: 'AI_SERVICE_NOT_CONFIGURED',
        message:
          'The server is missing AI_SERVICE_URL and/or AI_SERVICE_TOKEN. Ask the operator to configure the self-hosted AI service.',
      });
      return;
    }

    if (aiCallInFlight.has(session.sessionId)) {
      res.status(409).json({
        error: 'AI_CALL_IN_PROGRESS',
        message: 'An AI session is already being created for this session. Retry in a moment.',
      });
      return;
    }
    aiCallInFlight.add(session.sessionId);

    const replace = req.body?.replace === true || req.body?.rotate === true;

    try {
      const call = replace
        ? await aiBridge.restart(session.sessionId)
        : await aiBridge.ensure(session.sessionId);
      store.setAiCall(session.sessionId, {
        callId: call.callId,
        createdAt: Date.now(),
        createdByParticipantId:
          session.customer?.participantId || session.salesperson?.participantId || 'unknown',
      });
      const ticket = mintAiTicket(session.sessionId, isCustomer ? 'customer' : 'salesperson');
      res.json({
        callId: call.callId,
        aiSocketUrl: aiSocketUrlFor(req, ticket.token),
        ticketExpiresAt: ticket.expiresAt,
        isReused: !replace && Boolean((call as { reused?: boolean }).reused),
        createdAt: Date.now(),
        model: call.model,
        audio: { sampleRate: 16000, format: 'pcm_s16le', transport: 'websocket' },
      });
    } catch (err) {
      const failure =
        err instanceof AiServiceError
          ? err
          : new AiServiceError(
              'AI_SERVICE_UNREACHABLE',
              502,
              sanitizeProviderDetail((err as Error)?.message, 200) ||
                'Failed to reach the self-hosted AI service.'
            );

      store.recordError(session.sessionId, `AI service: ${failure.code}`);
      store.setAiRuntime(session.sessionId, {
        state: 'error',
        connected: false,
        error: failure.message,
        audioReachingAi: false,
      });
      broadcastSession(store.getSession(session.sessionId) as SessionRecord);
      console.warn(
        `[ai] call creation failed for session ${session.sessionId.slice(0, 8)}: ${failure.code} (${failure.status})`
      );
      res.status(failure.status).json({
        error: failure.code,
        status: failure.status,
        message: failure.message,
        ...(failure.detail ? { details: failure.detail } : {}),
      });
    } finally {
      aiCallInFlight.delete(session.sessionId);
    }
  };

  app.post('/api/sessions/:sessionId/ai-call', createAiCallRoute);

  // -------------------------------------------------------------------------
  // Shared session endpoints
  // -------------------------------------------------------------------------

  /**
   * ICE/TURN configuration for one authenticated participant.
   *
   * This replaced the previous public `/api/ice-config`: TURN credentials must
   * never be handed to an unauthenticated visitor. Both the salesperson and the
   * customer of a session may read it; nobody else can.
   */
  app.get('/api/sessions/:sessionId/ice-config', async (req, res) => {
    const session = store.getSession(req.params.sessionId);
    if (!session || store.isExpiredSession(session.sessionId)) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Unknown or expired session.' });
      return;
    }

    const credential = bearer(req);
    const authorized =
      Boolean(store.authorizeSalesperson(session.sessionId, credential)) ||
      Boolean(store.authorizeCustomer(session.sessionId, credential));
    if (!authorized) {
      store.countSignal(session.sessionId, 'rejectedMessages');
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'A valid participant credential is required for ICE configuration.',
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');

    try {
      let config = buildIceConfig({ sessionId: session.sessionId, ...expressTurnOptions() });

      if (config.turn.provider === 'rstream' && config.turn.providerConfigured) {
        // rstream managed TURN: the access token is read here and never logged or
        // returned. If rstream is unavailable, any static/ephemeral TURN config is
        // preserved instead of degrading to STUN-only.
        const settings = resolveTurnSettings();
        const fallback = buildIceConfig({ sessionId: session.sessionId, ignoreProviders: true });
        try {
          const provider = await fetchRstreamTurnCredentials({
            token: settings.rstreamToken ?? '',
            projectId: settings.rstreamProjectId,
            projectEndpoint: settings.rstreamProjectEndpoint,
            baseUrl: settings.rstreamBaseUrl,
            ttlSeconds: Math.min(settings.ttlSeconds, 3600),
            fetchImpl: turnFetch,
            cache: rstreamCache,
          });
          config = mergeRstreamIceServers(config, provider, null, fallback).config;
          const remainingSeconds = Math.max(0, Math.round((provider.expiresAt - Date.now()) / 1000));
          console.log(
            `[ice] rstream TURN credentials ready (${provider.urls.length} URL(s), ${remainingSeconds}s remaining) for session ${session.sessionId.slice(0, 8)}`
          );
        } catch (err) {
          const error = err as Error;
          // Error messages are provider-status based and contain no token/header.
          console.error(`[ice] rstream TURN credential request failed: ${error.message}`);
          config = mergeRstreamIceServers(config, null, error, fallback).config;
          store.recordError(session.sessionId, 'rstream TURN credential request failed');
        }
      } else if (config.turn.provider === 'generic' && config.turn.providerConfigured) {
        const credentialsUrl = process.env.TURN_CREDENTIALS_URL?.trim();
        try {
          if (!credentialsUrl) throw new Error('TURN_CREDENTIALS_URL is not configured.');
          const provider = await fetchProviderIceServers({
            credentialsUrl,
            authorization: process.env.TURN_CREDENTIALS_AUTH?.trim() || null,
            method: process.env.TURN_CREDENTIALS_METHOD === 'POST' ? 'POST' : 'GET',
            ttlSeconds: Number(process.env.TURN_TTL_SECONDS) || 3600,
            fetchImpl: turnFetch,
            cache: turnCache,
          });
          config = mergeProviderIceServers(config, provider, null).config;
          console.log(
            `[ice] provider issued ${provider.iceServers.length} short-lived TURN entr(ies) for session ${session.sessionId.slice(0, 8)}`
          );
        } catch (err) {
          const error = err as Error;
          // Never log the provider URL or authorization header.
          console.error(`[ice] TURN credential provider failed: ${error.message}`);
          config = mergeProviderIceServers(config, null, error).config;
          store.recordError(session.sessionId, 'TURN credential provider failed');
        }
      }

      // Relay-only mode without a usable relay is a deployment error. Returning
      // STUN-only servers here would silently produce a connected-but-silent call.
      if (config.errors.length > 0 && config.iceTransportPolicy === 'relay') {
        res.status(503).json({
          error: 'TURN_MISCONFIGURED',
          message: config.errors[0],
          ...config,
        });
        return;
      }

      res.json(config);
    } catch (err) {
      // Never let an unexpected failure escape as an unhandled rejection (which
      // would take the whole process down) or as an HTML error page. The detail
      // stays in the server log; the client only receives a stable code.
      console.error(
        `[ice] failed to build ICE configuration for session ${session.sessionId.slice(0, 8)}: ${
          (err as Error)?.message || err
        }`
      );
      store.recordError(session.sessionId, 'ICE configuration generation failed');
      if (!res.headersSent) {
        res.status(500).json({
          error: 'ICE_CONFIG_UNAVAILABLE',
          message: 'ICE configuration could not be generated. Please retry.',
        });
      }
    }
  });

  app.get('/api/health', (_req, res) => {
    // Public: capability flags only. No keys, no TURN usernames/credentials.
    const appUrl = appUrlDiagnostics();
    const ice = turnSummary(process.env, expressTurnOptions());
    const ai = aiReadiness();
    res.json({
      status: 'ok',
      model: ai.model,
      ai,
      hasAiService: ai.ready,
      ice,
      hasTurn: ice.configured,
      iceTransportPolicy: ice.iceTransportPolicy,
      publicAppUrl: appUrl.configured,
      appUrlWarnings: appUrl.warnings,
      sessions: store.stats(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // ExpressTURN admin page (operator-only; credentials held in memory)
  //
  // First-run setup creates a setup password in the browser, so no hosting
  // environment variable is required. Only a scrypt hash is kept. Sessions are
  // signed per-process cookies carrying a per-session CSRF token; every
  // mutation must be same-origin, JSON and present that token.
  // -------------------------------------------------------------------------

  const ADMIN_ATTEMPT_LIMIT = 8;
  const ADMIN_ATTEMPT_WINDOW_MS = 10 * 60_000;
  const ADMIN_ATTEMPT_MAX_KEYS = 2048;
  const adminAttemptBuckets = new Map<string, { count: number; resetAt: number }>();

  app.use('/api/admin', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  const adminClientKey = (req: Request, scope: 'setup' | 'login'): string =>
    `${scope}:${req.ip || req.socket.remoteAddress || 'unknown'}`;

  /** Fixed-window attempt limiter for first-run setup and login. */
  const consumeAdminAttempt = (key: string): boolean => {
    const now = Date.now();
    if (adminAttemptBuckets.size > ADMIN_ATTEMPT_MAX_KEYS) {
      for (const [bucketKey, bucket] of adminAttemptBuckets) {
        if (now > bucket.resetAt) adminAttemptBuckets.delete(bucketKey);
      }
    }
    const bucket = adminAttemptBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      adminAttemptBuckets.set(key, { count: 1, resetAt: now + ADMIN_ATTEMPT_WINDOW_MS });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= ADMIN_ATTEMPT_LIMIT;
  };

  const resetAdminAttempts = (key: string): void => {
    adminAttemptBuckets.delete(key);
  };

  const adminCookieOptions = (secure: boolean) => ({
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: '/',
    maxAge: ADMIN_SESSION_TTL_MS,
  });

  /**
   * CSRF / cross-origin guard: browser mutations must carry an Origin (or a
   * Referer fallback) whose host matches the request Host. A request with
   * neither header is rejected; a script client must opt in explicitly and
   * still needs the session cookie plus the per-session CSRF token.
   */
  const adminMutationOriginOk = (req: Request): boolean => {
    const source = req.headers.origin ?? req.headers.referer;
    if (!source) return false;

    const hosts = new Set<string>();
    const addHost = (value: string | string[] | undefined): void => {
      if (!value) return;
      const first = String(value).split(',')[0].trim();
      if (first) hosts.add(first);
    };
    addHost(req.headers.host);
    addHost(req.headers['x-forwarded-host']);
    const publicUrl = configuredPublicUrl();
    if (publicUrl) {
      try {
        hosts.add(new URL(publicUrl).host);
      } catch {
        // APP_URL is validated elsewhere; ignore an unparseable value here.
      }
    }

    try {
      const url = new URL(source);
      return (url.protocol === 'http:' || url.protocol === 'https:') && hosts.has(url.host);
    } catch {
      return false;
    }
  };

  const adminJsonContentTypeOk = (req: Request): boolean => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return true;
    const value = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    return value === 'application/json';
  };

  const requireAdminSession = (req: Request, res: Response, next: () => void): void => {
    const session = readAdminSessionFromCookie(req.headers.cookie);
    if (!session) {
      res.status(401).json({ error: 'ADMIN_UNAUTHORIZED', message: 'Sign in to the admin page first.' });
      return;
    }
    res.locals.adminSession = session;
    next();
  };

  /** Same-origin + JSON content type + per-session CSRF token. */
  const requireAdminMutation = (req: Request, res: Response, next: () => void): void => {
    if (!adminMutationOriginOk(req)) {
      res.status(403).json({ error: 'BAD_ORIGIN', message: 'Cross-origin admin requests are not allowed.' });
      return;
    }
    if (!adminJsonContentTypeOk(req)) {
      res.status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Admin changes must be sent as application/json.',
      });
      return;
    }
    const session = res.locals.adminSession as AdminSession | undefined;
    if (!session || !verifyAdminCsrfToken(session, req.get('x-csrf-token'))) {
      res.status(403).json({ error: 'CSRF_TOKEN_INVALID', message: 'A valid CSRF token is required.' });
      return;
    }
    next();
  };

  const secureCookie = (req: Request): boolean => req.secure || process.env.NODE_ENV === 'production';

  /** Safe status only: no TURN URL, username, password or password hash. */
  const adminSettingsPayload = (session: AdminSession) => ({
    ...getExpressTurnStatus(),
    setup: getAdminSetupStatus(),
    csrfToken: session.csrfToken,
  });

  /**
   * Public, unauthenticated readiness probe for the in-app Admin Settings panel.
   * It decides whether the panel shows first-time setup or sign-in. Only safe
   * flags are returned: never the TURN URL, username, password or hash.
   */
  app.get('/api/admin/status', (_req, res) => {
    res.json({
      setup: getAdminSetupStatus(),
      ...getExpressTurnStatus(),
    });
  });

  app.get(['/admin', '/admin/turn'], (req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html');

    const session = readAdminSessionFromCookie(req.headers.cookie);
    const setup = getAdminSetupStatus();
    const mode: AdminPageMode = session ? 'settings' : setup.claimed ? 'login' : 'setup';
    res.send(
      renderAdminPage({
        mode,
        status: getExpressTurnStatus(),
        setup,
        csrfToken: session?.csrfToken ?? null,
      })
    );
  });

  /**
   * First-run claim. Allowed only while no setup password exists AND no TURN
   * credentials have been configured, so a configured deployment cannot be
   * taken over by resetting the setup password.
   */
  app.post('/api/admin/setup', async (req, res) => {
    if (!adminMutationOriginOk(req)) {
      res.status(403).json({ error: 'BAD_ORIGIN', message: 'Cross-origin admin requests are not allowed.' });
      return;
    }
    if (!adminJsonContentTypeOk(req)) {
      res.status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Admin changes must be sent as application/json.',
      });
      return;
    }

    const bucketKey = adminClientKey(req, 'setup');
    if (!consumeAdminAttempt(bucketKey)) {
      res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many setup attempts. Try again later.' });
      return;
    }

    if (isAdminSetupClaimed() || getExpressTurnCredentials() !== null) {
      res.status(409).json({
        error: 'SETUP_ALREADY_CLAIMED',
        message: 'Setup has already been claimed. Sign in with the existing setup password instead.',
      });
      return;
    }

    const password = (req.body as { password?: unknown } | undefined)?.password;
    try {
      const claimed = await claimAdminSetupPassword(password);
      if (!claimed) {
        res.status(409).json({
          error: 'SETUP_ALREADY_CLAIMED',
          message: 'Setup has already been claimed. Sign in with the existing setup password instead.',
        });
        return;
      }
    } catch (err) {
      if (err instanceof AdminSetupPasswordError) {
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      console.error('[admin] first-time setup failed; no setup password was stored.');
      res.status(500).json({ error: 'SETUP_FAILED', message: 'Setup could not be completed. Try again.' });
      return;
    }

    resetAdminAttempts(bucketKey);
    const session = createAdminSession();
    res.cookie(ADMIN_COOKIE_NAME, session.token, adminCookieOptions(secureCookie(req)));
    console.log('[admin] first-time setup password claimed (scrypt hash, memory-only).');
    res.status(201).json({
      ok: true,
      expiresInSeconds: Math.round(ADMIN_SESSION_TTL_MS / 1000),
      ...adminSettingsPayload(session),
    });
  });

  app.post('/api/admin/login', async (req, res) => {
    if (!adminMutationOriginOk(req)) {
      res.status(403).json({ error: 'BAD_ORIGIN', message: 'Cross-origin admin requests are not allowed.' });
      return;
    }
    if (!adminJsonContentTypeOk(req)) {
      res.status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Admin changes must be sent as application/json.',
      });
      return;
    }

    const bucketKey = adminClientKey(req, 'login');
    if (!consumeAdminAttempt(bucketKey)) {
      res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts. Try again later.' });
      return;
    }

    if (!isAdminSetupClaimed()) {
      res.status(409).json({
        error: 'SETUP_REQUIRED',
        message: 'No setup password exists yet. Complete first-time setup at /admin/turn.',
      });
      return;
    }

    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (!(await verifyAdminSetupPassword(password))) {
      res.status(401).json({ error: 'INVALID_SETUP_PASSWORD', message: 'Invalid setup password.' });
      return;
    }

    resetAdminAttempts(bucketKey);
    const session = createAdminSession();
    res.cookie(ADMIN_COOKIE_NAME, session.token, adminCookieOptions(secureCookie(req)));
    res.json({
      ok: true,
      expiresInSeconds: Math.round(ADMIN_SESSION_TTL_MS / 1000),
      ...adminSettingsPayload(session),
    });
  });

  app.post('/api/admin/logout', requireAdminSession, requireAdminMutation, (req, res) => {
    res.clearCookie(ADMIN_COOKIE_NAME, { ...adminCookieOptions(secureCookie(req)), maxAge: undefined });
    res.json({ ok: true });
  });

  /** Safe status only: never the URL, username, password or password hash. */
  app.get('/api/admin/turn-settings', requireAdminSession, (_req, res) => {
    const session = res.locals.adminSession as AdminSession;
    res.setHeader('Cache-Control', 'no-store');
    res.json(adminSettingsPayload(session));
  });

  app.put('/api/admin/turn-settings', requireAdminSession, requireAdminMutation, (req, res) => {
    const body = (req.body ?? {}) as {
      serverAddress?: unknown;
      username?: unknown;
      password?: unknown;
    };
    try {
      const saved = setExpressTurnCredentials({
        serverAddress: body.serverAddress,
        username: body.username,
        password: body.password,
      });
      // Only the URL count is logged; never the URL, username or password.
      console.log(`[expressturn] credentials updated (urls=${saved.urls.length}, memory-only)`);
    } catch (err) {
      const message = (err as Error)?.message || 'Credentials could not be saved.';
      res.status(400).json({
        error: err instanceof ExpressTurnValidationError ? 'INVALID_TURN_CREDENTIALS' : 'SAVE_FAILED',
        message,
      });
      return;
    }

    res.json({ ok: true, settings: getExpressTurnStatus() });
  });

  app.delete('/api/admin/turn-settings', requireAdminSession, requireAdminMutation, (_req, res) => {
    clearExpressTurnCredentials();
    console.log('[expressturn] credentials cleared (memory-only).');
    res.json({ ok: true, settings: getExpressTurnStatus() });
  });


  // Unknown API routes must not fall through to the SPA HTML handler.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown API route.' });
  });

  // -------------------------------------------------------------------------
  // WebSocket signaling (session-scoped, role-enforcing)
  // -------------------------------------------------------------------------

  const sanitizeDiagnostics = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = new Set([
      'wsStatus', 'callState', 'micPermission', 'muted', 'localTrackState', 'localSenderCount',
      'remoteTrackState', 'playbackBlocked', 'bytesSent', 'bytesReceived', 'pcState', 'iceState',
      'iceGatheringState', 'selectedLocalType', 'selectedRemoteType', 'relayPath', 'aiStatus',
      'aiConnected', 'aiState', 'aiAudioReaching', 'aiLastResponseAt', 'aiReconnectAttempt',
      'reconnectAttempt', 'candidates', 'iceConfigLoaded', 'turnConfigured',
      'turnCredentialMode', 'relayCandidates', 'mediaFlowing', 'dtlsState',
      'audioFlow', 'lastMediaAgoMs',
    ]);
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(key)) continue;
      if (raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        out[key] = typeof raw === 'string' ? raw.slice(0, 120) : raw;
      } else if (key === 'candidates' && raw && typeof raw === 'object') {
        const candidates: Record<string, number> = {};
        for (const [candidateType, count] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof count === 'number') candidates[candidateType.slice(0, 20)] = count;
        }
        out.candidates = candidates;
      }
    }
    return out;
  };

  wss.on('connection', (ws: WebSocket) => {
    let state: SocketState | null = null;

    const joinDeadline = setTimeout(() => {
      if (!state) {
        console.warn('[ws] closing socket that never authenticated');
        try {
          ws.close(4008, 'join_timeout');
        } catch {
          // Ignore close errors.
        }
      }
    }, JOIN_DEADLINE_MS);

    const rejectJoin = (code: string, message: string) => {
      safeSend(ws, { type: 'join_rejected', code, message });
      try {
        ws.close(4003, code.slice(0, 60));
      } catch {
        // Ignore close errors.
      }
    };

    const handleJoin = (data: Record<string, unknown>) => {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
      const credential = typeof data.credential === 'string' ? data.credential : null;
      const resumeToken = typeof data.resumeToken === 'string' ? data.resumeToken : null;
      const claimedRole = roleOf(data.role);

      const result = store.join({ sessionId, claimedRole, credential, resumeToken });
      if (!result.ok) {
        store.countSignal(sessionId, 'rejectedMessages');
        store.recordError(sessionId, `join rejected: ${result.code}`);
        console.warn(
          `[ws] join rejected for session ${sessionId.slice(0, 8) || '(none)'}: ${result.code}`
        );
        rejectJoin(result.code, result.message);
        return;
      }

      const previous = sockets.get(result.participantId);
      if (previous && previous !== ws) {
        const previousState = socketState.get(previous);
        if (previousState) previousState.superseded = true;
        sockets.delete(result.participantId);
        try {
          previous.close(4001, 'superseded');
        } catch {
          // Ignore close errors.
        }
      }

      sockets.set(result.participantId, ws);
      state = {
        participantId: result.participantId,
        sessionId: result.sessionId,
        role: result.role,
        superseded: false,
        joined: true,
      };
      socketState.set(ws, state);
      clearTimeout(joinDeadline);

      const session = store.getSession(result.sessionId);
      if (!session) {
        rejectJoin('SESSION_NOT_FOUND', 'The session disappeared during join.');
        return;
      }

      safeSend(ws, {
        type: 'joined',
        sessionId: result.sessionId,
        role: result.role,
        participantId: result.participantId,
        resumeToken: result.resumeToken,
        peers: peersOf(session, result.participantId),
        participants: connectedParticipants(session),
        session: stateFor(session, result.role),
        // Last AI state reported by the customer device, so the salesperson
        // dashboard is accurate immediately after (re)joining. Never sent back to
        // the customer: AI status is salesperson-only information.
        ...(result.role === 'salesperson' ? { ai: store.publicState(session).ai } : {}),
        replacedConnection: result.replacedConnection,
        serverTime: new Date().toISOString(),
      });

      const counterpart = counterpartOf(session, result.role);
      if (counterpart?.connected) {
        safeSend(sockets.get(counterpart.participantId), {
          type: 'peer_joined',
          peer: { participantId: result.participantId, role: result.role },
          participants: connectedParticipants(session),
        });
      }
      broadcastSession(session);
    };

    const relayToCounterpart = (
      session: SessionRecord,
      current: NonNullable<ReturnType<typeof store.getParticipant>>,
      type: string,
      data: Record<string, unknown>
    ) => {
      const counterpart = counterpartOf(session, current.participant.role);
      const targetWs = counterpart?.connected ? sockets.get(counterpart.participantId) : undefined;
      if (!targetWs) {
        store.countSignal(session.sessionId, 'relayFailures');
        store.recordError(
          session.sessionId,
          `no ${current.participant.role === 'customer' ? 'salesperson' : 'customer'} to relay ${type}`
        );
        safeSend(ws, {
          type: 'signal_error',
          code: 'PEER_UNAVAILABLE',
          forType: type,
          message: 'The other participant is not connected yet.',
        });
        return;
      }

      safeSend(targetWs, {
        ...data,
        type,
        sessionId: session.sessionId,
        from: current.participant.participantId,
        fromRole: current.participant.role,
        relayedAt: Date.now(),
      });
    };

    const rejectMessage = (sessionId: string, code: string, message: string) => {
      store.countSignal(sessionId, 'rejectedMessages');
      store.recordError(sessionId, `${code}: ${message}`);
      safeSend(ws, { type: 'error', code, message });
    };

    const handleMessage = (data: Record<string, unknown>) => {
      if (!state) return;
      const type = typeof data.type === 'string' ? data.type : '';
      const current = store.getParticipant(state.participantId);
      if (!current) {
        rejectJoin('SESSION_NOT_FOUND', 'Your session is no longer active.');
        return;
      }
      const session = current.session;
      store.touch(state.participantId);

      if (typeof data.sessionId === 'string' && data.sessionId !== session.sessionId) {
        rejectMessage(session.sessionId, 'WRONG_SESSION', 'Signaling messages must match your session.');
        return;
      }

      if (type === 'ping') {
        safeSend(ws, { type: 'pong', serverTime: Date.now() });
        return;
      }

      if (type === 'leave') {
        try {
          ws.close(1000, 'client_leave');
        } catch {
          // Ignore close errors.
        }
        return;
      }

      if (type === 'client_diagnostics') {
        store.setDiagnostics(state.participantId, sanitizeDiagnostics(data.diagnostics));
        return;
      }

      // AI lifecycle is owned by the server bridge. A browser (either role) is
      // not an authority on model state and cannot feed or fake it.
      if (type === 'ai_status') {
        rejectMessage(
          session.sessionId,
          'INVALID_SIGNALING_ROLE',
          'AI status is reported by the server, not by a browser.'
        );
        return;
      }

      /** The salesperson may restart the server-side AI bridge at any time. */
      if (type === 'ai_reconnect') {
        if (state.role !== 'salesperson') {
          rejectMessage(
            session.sessionId,
            'INVALID_SIGNALING_ROLE',
            'Only the salesperson may request an AI reconnect.'
          );
          return;
        }
        void restartAiFromSignaling(session, current);
        return;
      }

      if (type === 'offer') {
        if (state.role !== 'salesperson') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_ROLE', 'Only the salesperson may send an offer.');
          return;
        }
        const offer = data.offer as { sdp?: unknown; type?: unknown } | undefined;
        if (!offer || typeof offer.sdp !== 'string' || offer.type !== 'offer') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_PAYLOAD', 'A valid SDP offer is required.');
          return;
        }
        store.countSignal(session.sessionId, 'offers');
        relayToCounterpart(session, current, 'offer', { offer });
        return;
      }

      if (type === 'ice_restart') {
        // The customer is the answerer and cannot create an offer, so it asks
        // the offerer to perform an ICE restart. Role-checked, text-only.
        if (state.role !== 'customer') {
          rejectMessage(
            session.sessionId,
            'INVALID_SIGNALING_ROLE',
            'Only the customer may request an ICE restart.'
          );
          return;
        }
        relayToCounterpart(session, current, 'ice_restart', {
          reason: typeof data.reason === 'string' ? data.reason.slice(0, 120) : 'customer requested',
        });
        return;
      }

      if (type === 'answer') {
        if (state.role !== 'customer') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_ROLE', 'Only the customer may send an answer.');
          return;
        }
        const answer = data.answer as { sdp?: unknown; type?: unknown } | undefined;
        if (!answer || typeof answer.sdp !== 'string' || answer.type !== 'answer') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_PAYLOAD', 'A valid SDP answer is required.');
          return;
        }
        store.countSignal(session.sessionId, 'answers');
        relayToCounterpart(session, current, 'answer', { answer });
        return;
      }

      if (type === 'ice_candidate') {
        const candidate = data.candidate as { candidate?: unknown } | undefined;
        if (!candidate || typeof candidate !== 'object' || typeof candidate.candidate !== 'string') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_PAYLOAD', 'A valid ICE candidate is required.');
          return;
        }
        store.countSignal(session.sessionId, 'iceCandidates');
        relayToCounterpart(session, current, 'ice_candidate', { candidate });
        return;
      }

      if (type === 'ai_suggestion' || type === 'customer_speech_transcript') {
        // Obsolete browser-relayed AI path: the server generates and delivers
        // suggestions itself. Accepting these would let either browser inject
        // fake AI output into the salesperson's panel.
        rejectMessage(
          session.sessionId,
          'INVALID_SIGNALING_ROLE',
          'AI text is delivered by the server, not sent by a browser.'
        );
        return;
      }

      if (type === 'salesperson_caption') {
        if (state.role !== 'salesperson') {
          rejectMessage(
            session.sessionId,
            'INVALID_SIGNALING_ROLE',
            'Only the salesperson may send captions.'
          );
          return;
        }
        if (typeof data.text !== 'string') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_PAYLOAD', 'Caption text is required.');
          return;
        }
        relayToCounterpart(session, current, 'salesperson_caption', {
          text: data.text.slice(0, 1000),
          isFinal: Boolean(data.isFinal),
        });
        return;
      }

      rejectMessage(
        session.sessionId,
        'UNKNOWN_MESSAGE_TYPE',
        `Unsupported message type: ${type || '(none)'}`
      );
    };

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        safeSend(ws, { type: 'error', code: 'INVALID_JSON' });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        safeSend(ws, { type: 'error', code: 'INVALID_MESSAGE' });
        return;
      }
      const data = parsed as Record<string, unknown>;

      if (!state) {
        if (data.type !== 'join') {
          rejectJoin('JOIN_REQUIRED', 'The first message must be a join.');
          return;
        }
        handleJoin(data);
        return;
      }

      handleMessage(data);
    });

    ws.on('close', () => {
      clearTimeout(joinDeadline);
      if (!state) return;
      const own = state;

      // A superseded socket no longer owns the participant identity.
      if (own.superseded) return;

      if (sockets.get(own.participantId) === ws) {
        sockets.delete(own.participantId);
      }

      const detached = store.detach(own.participantId);
      if (!detached) return;
      const session = detached.session;

      // The AI bridge is fed only by the customer's audio socket. When that
      // participant leaves, stop the upstream call so no GPU time is spent on a
      // room nobody is in, and close the audio upload socket too.
      if (detached.role === 'customer') {
        const audioSocket = aiSockets.get(session.sessionId);
        aiSockets.delete(session.sessionId);
        if (audioSocket) {
          try {
            audioSocket.close(1000, 'customer left');
          } catch {
            // Ignore.
          }
        }
        aiBridge.end(session.sessionId, 'customer left');
        store.setAiRuntime(session.sessionId, {
          state: 'disconnected',
          connected: false,
          error: 'The customer left; the AI session ended.',
          audioReachingAi: false,
          reconnectAttempt: 0,
        });
      }

      const counterpart = counterpartOf(session, detached.role);
      if (counterpart?.connected) {
        safeSend(sockets.get(counterpart.participantId), {
          type: 'peer_left',
          participantId: own.participantId,
          role: detached.role,
          participants: connectedParticipants(session),
        });
      }
      broadcastSession(session);
    });

    ws.on('error', (err) => {
      console.error('[ws] socket error:', (err as Error)?.message);
    });
  });

  // Upgrade HTTP requests to WebSocket. `/ws` is the participant signaling
  // socket; `/ws/ai` is the customer's audio upload socket for the AI bridge.
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url
      ? new URL(request.url, `http://${request.headers.host}`).pathname
      : '';
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/ws/ai') {
      aiWss.handleUpgrade(request, socket, head, (ws) => {
        aiWss.emit('connection', ws, request);
      });
      return;
    }
    socket.destroy();
  });

  // Vite is a build/dev-time dependency only: production serves the built
  // assets and never loads vite, so a production install can omit devDeps.
  if (options.serveFrontend !== false) {
    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true, host: '0.0.0.0', port: 3000 },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distDir = path.join(__dirname, 'dist');
      const indexPath = path.join(distDir, 'index.html');
      if (!fs.existsSync(indexPath)) {
        console.error(
          `[startup] NODE_ENV=production but ${indexPath} is missing. Run "npm run build" during the build step.`
        );
      }
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res
            .status(503)
            .send('Build output dist/index.html not found. The build step (npm run build) did not run or failed.');
        }
      });
    }
  }

  // Startup ICE/TURN diagnostics: actionable, and free of credentials/URLs.
  const startupExpressTurn = expressTurnOptions();
  console.log(
    `[ice] ${describeIceSettingsForLog(process.env, { expressTurn: Boolean(startupExpressTurn.expressTurn) })}`
  );
  const iceStartup = turnSummary(process.env, startupExpressTurn);
  if (iceStartup.hasErrors) {
    console.error(`[ice] CONFIGURATION ERROR: ${iceStartup.warnings.join(' ')}`);
  } else if (!iceStartup.configured) {
    console.warn(`[ice] ${iceStartup.warnings.join(' ')}`);
    console.log(
      '[ice] ExpressTURN can be configured at /admin/turn; the first visit creates its own setup password (no environment variable).'
    );
  } else if (iceStartup.provider === 'expressturn') {
    console.log('[ice] ExpressTURN static credentials configured at /admin/turn (memory-only).');
  } else if (iceStartup.credentialMode === 'static') {
    console.warn(
      iceStartup.provider === 'rstream-static'
        ? '[ice] rstream static TURN credentials are in use; they expire and must be replaced manually with fresh values.'
        : '[ice] TURN uses static credentials. Set TURN_SECRET for short-lived credentials.'
    );
  }

  const aiStartup = aiReadiness();
  if (!aiStartup.ready) console.warn(`[ai] ${aiStartup.message}`);
  for (const warning of appUrlDiagnostics().warnings) console.warn(`[app-url] ${warning}`);

  // Periodically release expired sessions / stale participants.
  const sweeper = setInterval(() => {
    store.sweep();
    // An expired/removed session must not keep an upstream GPU call alive.
    for (const sessionId of aiBridge.activeSessions()) {
      if (!store.getSession(sessionId) || store.isExpiredSession(sessionId)) {
        const audioSocket = aiSockets.get(sessionId);
        aiSockets.delete(sessionId);
        try {
          audioSocket?.close(1000, 'session expired');
        } catch {
          // Ignore.
        }
        aiBridge.end(sessionId, 'session expired');
      }
    }
  }, 60_000);
  sweeper.unref?.();

  const port = options.port ?? (Number(process.env.PORT) || 3000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  const close = async () => {
    clearInterval(sweeper);
    for (const participant of [...sockets.values()]) {
      try {
        participant.close(1001, 'server_shutdown');
      } catch {
        // Ignore close errors.
      }
    }
    sockets.clear();
    for (const audioSocket of [...aiSockets.values()]) {
      try {
        audioSocket.close(1001, 'server_shutdown');
      } catch {
        // Ignore close errors.
      }
    }
    aiSockets.clear();
    aiBridge.stopAll();
    wss.close();
    aiWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { app, server, wss, aiWss, store, aiBridge, port: actualPort, close };
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  createPrototype2Server()
    .then(({ port }) => {
      console.log(`Server & WebSocket signaling running at http://0.0.0.0:${port}`);
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
