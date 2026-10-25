/**
 * Prototype 2 server: session API, invitation redemption, role-enforcing
 * WebSocket signaling and the Ultravox proxy.
 *
 * Trust boundaries:
 *   - The browser never sees ULTRAVOX_API_KEY. TURN credentials are only sent to
 *     browsers that need to establish media.
 *   - Session membership is proven by a credential (salesperson key or the
 *     customer key derived from a redeemed invitation). A URL parameter alone
 *     grants nothing.
 *   - Signaling is relayed only between the two authorized participants of the
 *     same session; unknown peers get a machine-readable `signal_error`.
 */
import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import { pathToFileURL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ParticipantRole, SessionRecord, SessionStore } from './server/sessionStore';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
];

const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500);
const JOIN_DEADLINE_MS = 10000;
const REDEEM_RATE_LIMIT = 30;
const REDEEM_RATE_WINDOW_MS = 60_000;

const parseUrlList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * ICE server list for the peer-to-peer (human to human) audio call.
 *
 * STUN alone only works when both devices can reach each other directly. When
 * either side is behind a symmetric / carrier-grade NAT (a phone on mobile data
 * for example) no direct path exists and media never flows, even though
 * signaling and the AI pipeline keep working. TURN is the only fix, so it must
 * be configurable per deployment.
 */
const buildIceServers = (): RTCIceServerLike[] => {
  const stunUrls = parseUrlList(process.env.STUN_URLS);
  const turnUrls = parseUrlList(process.env.TURN_URLS);

  const iceServers: RTCIceServerLike[] = [
    { urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS },
  ];

  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  return iceServers;
};

/** Optional relay-only mode for deployments whose networks block direct media. */
const resolveIceTransportPolicy = (): 'all' | 'relay' =>
  process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all';

const configuredPublicUrl = (): string | null => {
  const value = process.env.APP_URL?.trim();
  if (!value || value === 'MY_APP_URL') return null;
  if (!/^https?:\/\//i.test(value)) return null;
  return value.replace(/\/+$/, '');
};

const ultravoxApiKey = (): string | null => {
  const key = process.env.ULTRAVOX_API_KEY?.trim();
  if (!key || key === 'MY_ULTRAVOX_API_KEY') return null;
  return key;
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
  /** Injected for tests so no real Ultravox call is created. */
  ultravoxFetch?: typeof fetch;
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
  const fetchImpl = options.ultravoxFetch ?? fetch;

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

  const broadcastSession = (session: SessionRecord) => {
    const payload = {
      type: 'session_state',
      sessionId: session.sessionId,
      session: store.publicState(session),
      participants: connectedParticipants(session),
    };
    for (const participant of [session.salesperson, session.customer]) {
      if (!participant?.connected) continue;
      safeSend(sockets.get(participant.participantId), payload);
    }
  };

  const counterpartOf = (session: SessionRecord, role: ParticipantRole) =>
    role === 'salesperson' ? session.customer : session.salesperson;

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
    for (const participant of diagnostics.participants) {
      if (!participant.connected) {
        console.warn(
          `[session:${session.sessionId.slice(0, 8)}] diagnostics: ${participant.role} not connected`
        );
      }
    }
    res.json({
      diagnostics,
      ice: {
        hasTurn: buildIceServers().some((serverConfig) => {
          const urls = Array.isArray(serverConfig.urls) ? serverConfig.urls : [serverConfig.urls];
          return urls.some((url) => /^turns?:/i.test(url));
        }),
        iceTransportPolicy: resolveIceTransportPolicy(),
      },
      hasUltravoxKey: Boolean(ultravoxApiKey()),
    });
  });

  /**
   * Redeems a customer invitation. Returns a session-scoped customer key that is
   * required for the WebSocket join and for the Ultravox call request.
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
      session: result.session,
      baseUrl: publicBaseUrl(req),
    });
  });

  /**
   * Creates (or returns) the single Ultravox call for this session. Only the
   * customer may fetch the join URL: it is a media credential.
   */
  app.post('/api/sessions/:sessionId/ultravox-call', async (req, res) => {
    const session = store.getSession(req.params.sessionId);
    if (!session || store.isExpiredSession(session.sessionId)) {
      res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Unknown or expired session.' });
      return;
    }

    const isCustomer = Boolean(store.authorizeCustomer(session.sessionId, bearer(req)));
    if (!isCustomer) {
      store.countSignal(session.sessionId, 'rejectedMessages');
      console.warn(
        `[session:${session.sessionId.slice(0, 8)}] rejected Ultravox call request: not the session customer`
      );
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Only the authorized customer of this session may start the AI conversation.',
      });
      return;
    }

    const existing = store.getUltravoxCall(session.sessionId);
    if (existing) {
      res.json({
        callId: existing.callId,
        joinUrl: existing.joinUrl,
        isReused: true,
        model: 'ultravox-v0.7',
      });
      return;
    }

    const apiKey = ultravoxApiKey();
    if (!apiKey) {
      res.status(503).json({
        error: 'MISSING_API_KEY',
        message: 'The server is missing ULTRAVOX_API_KEY. Ask the operator to configure it.',
      });
      return;
    }

    const systemPrompt =
      typeof req.body?.systemPrompt === 'string' && req.body.systemPrompt.trim()
        ? req.body.systemPrompt.slice(0, 4000)
        : 'You are an AI sales copilot assisting a salesperson in a live sales call. Listen attentively to the customer statements, questions, and objections. Generate concise, natural, 1-2 sentence ready-to-read sales responses and qualification questions for the salesperson to read aloud.';

    try {
      const response = await fetchImpl('https://api.ultravox.ai/api/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          model: 'ultravox-v0.7',
          initialOutputMedium: 'MESSAGE_MEDIUM_TEXT',
          maxDuration: '3600s',
          systemPrompt,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        store.recordError(session.sessionId, `Ultravox HTTP ${response.status}`);
        res.status(response.status).json({
          error: 'ULTRAVOX_API_ERROR',
          status: response.status,
          message: `Ultravox API returned HTTP ${response.status}`,
          details: errText.slice(0, 500),
        });
        return;
      }

      const data = (await response.json()) as { callId: string; joinUrl: string; model?: string };
      store.setUltravoxCall(session.sessionId, {
        callId: data.callId,
        joinUrl: data.joinUrl,
        createdAt: Date.now(),
        createdByParticipantId: session.customer?.participantId || 'unknown',
      });
      broadcastSession(store.getSession(session.sessionId) as SessionRecord);

      res.json({
        callId: data.callId,
        joinUrl: data.joinUrl,
        isReused: false,
        model: data.model || 'ultravox-v0.7',
      });
    } catch (err) {
      store.recordError(session.sessionId, 'Ultravox request failed');
      res.status(502).json({
        error: 'ULTRAVOX_UNREACHABLE',
        message: (err as Error)?.message || 'Failed to reach Ultravox.',
      });
    }
  });

  // -------------------------------------------------------------------------
  // Prototype 1 (single-speaker engine test) and shared endpoints
  // -------------------------------------------------------------------------

  app.post('/api/ultravox/call', async (req, res) => {
    const apiKey = ultravoxApiKey();
    if (!apiKey) {
      res.status(503).json({
        error: 'MISSING_API_KEY',
        message: 'The server is missing ULTRAVOX_API_KEY. Ask the operator to configure it.',
      });
      return;
    }

    const { systemPrompt, temperature = 0.1 } = req.body || {};

    try {
      const response = await fetchImpl('https://api.ultravox.ai/api/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          model: 'ultravox-v0.7',
          initialOutputMedium: 'MESSAGE_MEDIUM_TEXT',
          maxDuration: '3600s',
          systemPrompt:
            typeof systemPrompt === 'string' && systemPrompt.trim()
              ? systemPrompt.slice(0, 4000)
              : 'You are a sales copilot assistant. Provide brief, concise text responses when prompted.',
          temperature: typeof temperature === 'number' ? temperature : 0.1,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        res.status(response.status).json({
          error: 'ULTRAVOX_API_ERROR',
          status: response.status,
          message: `Ultravox API returned HTTP ${response.status}`,
          details: errText.slice(0, 500),
        });
        return;
      }

      const data = (await response.json()) as Record<string, unknown>;
      res.json({
        callId: data.callId,
        joinUrl: data.joinUrl,
        model: data.model || 'ultravox-v0.7',
        created: data.created,
      });
    } catch (err) {
      res.status(502).json({
        error: 'ULTRAVOX_UNREACHABLE',
        message: (err as Error)?.message || 'Failed to contact Ultravox.',
      });
    }
  });

  // ICE configuration for the peer-to-peer human-to-human audio call. The
  // browser cannot read deployment secrets directly, so STUN/TURN servers are
  // resolved here, and only here, from the server environment.
  app.get('/api/ice-config', (_req, res) => {
    const iceServers = buildIceServers();
    const urlsOf = (serverConfig: RTCIceServerLike) =>
      Array.isArray(serverConfig.urls) ? serverConfig.urls : [serverConfig.urls];

    res.json({
      iceServers,
      hasTurn: iceServers.some((serverConfig) =>
        urlsOf(serverConfig).some((url) => /^turns?:/i.test(url))
      ),
      hasStun: iceServers.some((serverConfig) =>
        urlsOf(serverConfig).some((url) => /^stuns?:/i.test(url))
      ),
      iceTransportPolicy: resolveIceTransportPolicy(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      model: 'ultravox-v0.7',
      hasUltravoxKey: Boolean(ultravoxApiKey()),
      hasTurn: Boolean(parseUrlList(process.env.TURN_URLS).length),
      iceTransportPolicy: resolveIceTransportPolicy(),
      publicAppUrl: configuredPublicUrl(),
      sessions: store.stats(),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
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
      'reconnectAttempt', 'candidates',
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
        session: store.publicState(session),
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
        if (state.role !== 'customer') {
          rejectMessage(
            session.sessionId,
            'INVALID_SIGNALING_ROLE',
            'Only the customer may send AI suggestions or transcripts.'
          );
          return;
        }
        if (typeof data.text !== 'string') {
          rejectMessage(session.sessionId, 'INVALID_SIGNALING_PAYLOAD', 'Suggestion text is required.');
          return;
        }
        store.countSignal(session.sessionId, 'aiSuggestions');
        relayToCounterpart(session, current, type, {
          text: data.text.slice(0, 4000),
          isFinal: Boolean(data.isFinal),
          ordinal: typeof data.ordinal === 'number' ? data.ordinal : 0,
          timestamp: typeof data.timestamp === 'string' ? data.timestamp.slice(0, 40) : '',
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

  // Upgrade HTTP requests to WebSocket for /ws
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url
      ? new URL(request.url, `http://${request.headers.host}`).pathname
      : '';
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Vite middleware in dev vs static files in prod
  if (options.serveFrontend !== false) {
    if (process.env.NODE_ENV !== 'production') {
      const vite = await createViteServer({
        server: { middlewareMode: true, host: '0.0.0.0', port: 3000 },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distDir = path.join(__dirname, 'dist');
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        const indexPath = path.join(distDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res.status(404).send('Build output dist/index.html not found. Please run npm run build.');
        }
      });
    }
  }

  // Periodically release expired sessions / stale participants.
  const sweeper = setInterval(() => store.sweep(), 60_000);
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
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { app, server, wss, store, port: actualPort, close };
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
