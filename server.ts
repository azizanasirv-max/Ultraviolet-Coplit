import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type ParticipantRole = 'customer' | 'salesperson';

interface RoomClient {
  /** Server-generated identity for this specific WebSocket connection. */
  participantId: string;
  /** Private, connection-scoped token used only to authorize reconnection. */
  resumeToken: string;
  ws: WebSocket;
  role: ParticipantRole;
  roomId: string;
  joinedAt: number;
}

interface RoomState {
  roomId: string;
  clients: RoomClient[];
  ultravoxCallId: string | null;
  ultravoxJoinUrl: string | null;
  createdTime: number;
}

/** Room policy: exactly one customer and one salesperson per room. */
const MAX_CLIENTS_PER_ROOM = 2;
const MAX_ROOM_ID_LENGTH = 128;

const isValidRole = (value: unknown): value is ParticipantRole =>
  value === 'customer' || value === 'salesperson';

const normalizeRoomId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ROOM_ID_LENGTH) return null;
  // Reject control characters but keep human-readable room names working.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
};

async function startServer() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const rooms = new Map<string, RoomState>();

  // Helper: Get or create room state
  const getOrCreateRoom = (roomId: string): RoomState => {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        clients: [],
        ultravoxCallId: null,
        ultravoxJoinUrl: null,
        createdTime: Date.now(),
      };
      rooms.set(roomId, room);
    }
    return room;
  };

  // ---------------------------------------------------------------------------
  // Room membership helpers
  //
  // Membership is represented by RoomState.clients only. A WebSocket that was
  // rejected, replaced, or has left the room has no entry here, so it can never
  // relay signaling into a live conversation.
  // ---------------------------------------------------------------------------

  const safeSend = (ws: WebSocket, payload: unknown): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error('WebSocket send failed:', err);
      return false;
    }
  };

  const peersOf = (room: RoomState, exceptParticipantId?: string) =>
    room.clients
      .filter((c) => c.participantId !== exceptParticipantId)
      .map((c) => ({
        participantId: c.participantId,
        role: c.role,
        joinedAt: c.joinedAt,
      }));

  const roomSnapshot = (room: RoomState, participantId?: string) => ({
    type: 'room_state',
    roomId: room.roomId,
    participants: room.clients.map((c) => ({
      participantId: c.participantId,
      role: c.role,
      joinedAt: c.joinedAt,
    })),
    peers: peersOf(room, participantId),
    activeRoles: room.clients.map((c) => c.role),
    hasUltravoxCall: Boolean(room.ultravoxJoinUrl),
  });

  const notifyPeers = (room: RoomState, payload: unknown, exceptWs?: WebSocket) => {
    room.clients.forEach((c) => {
      if (c.ws !== exceptWs) safeSend(c.ws, payload);
    });
  };

  /**
   * Removes a participant from its room and tells the remaining peer about the
   * departure. Idempotent: a socket closed twice (or after a role takeover)
   * only produces one peer_left event.
   */
  const removeParticipant = (
    client: RoomClient,
    reason: 'left' | 'socket_closed' | 'replaced' | 'stale'
  ): boolean => {
    const room = rooms.get(client.roomId);
    if (!room) return false;

    const index = room.clients.findIndex(
      (c) => c.participantId === client.participantId || c.ws === client.ws
    );
    if (index === -1) return false;

    room.clients.splice(index, 1);

    notifyPeers(room, {
      type: 'peer_left',
      participantId: client.participantId,
      role: client.role,
      reason,
      activeRoles: room.clients.map((c) => c.role),
      peers: peersOf(room),
    });

    // Clean up empty rooms after 10 minutes (same retention as before).
    if (room.clients.length === 0) {
      setTimeout(() => {
        const currentRoom = rooms.get(room.roomId);
        if (currentRoom && currentRoom.clients.length === 0) {
          rooms.delete(room.roomId);
        }
      }, 600000).unref?.();
    }

    return true;
  };

  /**
   * Drops entries whose socket is no longer open. Their `close` handler may not
   * have run yet (for example a half-open connection), so prune them explicitly
   * and notify the surviving peer exactly once.
   */
  const pruneClosedClients = (room: RoomState) => {
    [...room.clients]
      .filter((c) => c.ws.readyState !== WebSocket.OPEN)
      .forEach((c) => removeParticipant(c, 'stale'));
  };

  // API Route: Prototype 1 Single Call Creation
  app.post('/api/ultravox/call', async (req: Request, res: Response) => {
    try {
      const apiKey =
        process.env.ULTRAVOX_API_KEY ||
        (req.headers['x-ultravox-api-key'] as string) ||
        req.body?.apiKey;

      if (!apiKey || apiKey === 'MY_ULTRAVOX_API_KEY') {
        res.status(401).json({
          error: 'MISSING_API_KEY',
          message:
            'Ultravox API Key is required. Please set ULTRAVOX_API_KEY in server environment or configure in settings.',
        });
        return;
      }

      const { systemPrompt, temperature = 0.1 } = req.body || {};

      const payload: Record<string, any> = {
        model: 'ultravox-v0.7',
        initialOutputMedium: 'MESSAGE_MEDIUM_TEXT',
        maxDuration: '3600s',
        systemPrompt:
          systemPrompt ||
          'You are a sales copilot assistant. Provide brief, concise text responses when prompted.',
        temperature,
      };

      const response = await fetch('https://api.ultravox.ai/api/calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        res.status(response.status).json({
          error: 'ULTRAVOX_API_ERROR',
          status: response.status,
          message: `Ultravox API returned HTTP ${response.status}`,
          details: errText,
        });
        return;
      }

      const data = await response.json();
      res.json({
        callId: data.callId,
        joinUrl: data.joinUrl,
        model: data.model || 'ultravox-v0.7',
        created: data.created,
      });
    } catch (err: any) {
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: err?.message || 'Failed to connect to Ultravox proxy server',
      });
    }
  });

  // API Route: Prototype 2 Room Call Creation (Enforces EXACTLY ONE Ultravox call per room)
  app.post('/api/room/ultravox-call', async (req: Request, res: Response) => {
    try {
      const { roomId = 'default-room', customKey, systemPrompt } = req.body || {};
      const room = getOrCreateRoom(roomId);

      // Reuse existing call session if already created for this room
      if (room.ultravoxJoinUrl && room.ultravoxCallId) {
        res.json({
          callId: room.ultravoxCallId,
          joinUrl: room.ultravoxJoinUrl,
          isReused: true,
          model: 'ultravox-v0.7',
        });
        return;
      }

      const apiKey =
        process.env.ULTRAVOX_API_KEY ||
        (req.headers['x-ultravox-api-key'] as string) ||
        customKey;

      if (!apiKey || apiKey === 'MY_ULTRAVOX_API_KEY') {
        res.status(401).json({
          error: 'MISSING_API_KEY',
          message:
            'Ultravox API Key is required. Please set ULTRAVOX_API_KEY in server environment or configure in settings.',
        });
        return;
      }

      const payload: Record<string, any> = {
        model: 'ultravox-v0.7',
        initialOutputMedium: 'MESSAGE_MEDIUM_TEXT',
        maxDuration: '3600s',
        systemPrompt:
          systemPrompt ||
          'You are an AI sales copilot assisting a salesperson in a live sales call. Listen attentively to the customer statements, questions, and objections. Generate concise, natural, 1-2 sentence ready-to-read sales responses and qualification questions for the salesperson to read aloud.',
        temperature: 0.1,
      };

      const response = await fetch('https://api.ultravox.ai/api/calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        res.status(response.status).json({
          error: 'ULTRAVOX_API_ERROR',
          status: response.status,
          message: `Ultravox API returned HTTP ${response.status}`,
          details: errText,
        });
        return;
      }

      const data = await response.json();
      room.ultravoxCallId = data.callId;
      room.ultravoxJoinUrl = data.joinUrl;

      res.json({
        callId: data.callId,
        joinUrl: data.joinUrl,
        isReused: false,
        model: data.model || 'ultravox-v0.7',
      });
    } catch (err: any) {
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: err?.message || 'Failed to create room call',
      });
    }
  });

  // Health check endpoint
  app.get('/api/health', (_req, res) => {
    // Explicit public deployment URL used to build customer invitation links.
    // Ignored when unset or left at the placeholder value.
    const configuredAppUrl = process.env.APP_URL?.trim();
    const publicAppUrl =
      configuredAppUrl &&
      /^https?:\/\//i.test(configuredAppUrl) &&
      configuredAppUrl !== 'MY_APP_URL'
        ? configuredAppUrl.replace(/\/+$/, '')
        : null;

    res.json({
      status: 'ok',
      hasUltravoxKey: Boolean(
        process.env.ULTRAVOX_API_KEY && process.env.ULTRAVOX_API_KEY !== 'MY_ULTRAVOX_API_KEY'
      ),
      activeRooms: rooms.size,
      model: 'ultravox-v0.7',
      publicAppUrl,
      timestamp: new Date().toISOString(),
    });
  });

  // Handle WebSocket Signaling Protocol for WebRTC P2P & AI Relay
  wss.on('connection', (ws: WebSocket) => {
    let currentClient: RoomClient | null = null;
    // Once a socket leaves or is rejected it is permanently outside the room.
    // Every message handler below re-checks membership, so a rejected socket
    // cannot inject offers, answers, or ICE candidates.
    let sessionEnded = false;

    const rejectJoin = (code: string, message: string, extra: Record<string, unknown> = {}) => {
      sessionEnded = true;
      safeSend(ws, { type: 'join_rejected', code, message, ...extra });
      ws.close(4001, code.slice(0, 120));
    };

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        const { type } = data;

        if (type === 'join_room') {
          if (sessionEnded) return;

          if (currentClient) {
            rejectJoin('ALREADY_JOINED', 'This connection has already joined a room.', {
              roomId: currentClient.roomId,
              role: currentClient.role,
            });
            return;
          }

          const roomId = normalizeRoomId(data.roomId);
          if (!roomId) {
            rejectJoin('INVALID_ROOM', 'A valid room ID is required to join.');
            return;
          }

          if (!isValidRole(data.role)) {
            rejectJoin('INVALID_ROLE', 'Role must be either "customer" or "salesperson".', {
              roomId,
            });
            return;
          }

          const role = data.role;
          const room = getOrCreateRoom(roomId);
          pruneClosedClients(room);

          const occupied = room.clients.find((c) => c.role === role);

          if (occupied) {
            // A reconnecting client may legitimately replace its own previous
            // connection, but only by presenting the private resume token the
            // server generated for that connection. The public participant ID
            // is shared with the peer and therefore is NOT sufficient.
            const resumeToken =
              typeof data.resumeToken === 'string' ? data.resumeToken : null;

            if (resumeToken && occupied.resumeToken === resumeToken) {
              removeParticipant(occupied, 'replaced');
              safeSend(occupied.ws, { type: 'session_replaced', role, roomId });
              occupied.ws.close(4002, 'session_replaced');
            } else {
              rejectJoin(
                'ROLE_OCCUPIED',
                `The ${role} role in this room is already occupied by another participant.`,
                {
                  roomId,
                  role,
                  activeRoles: room.clients.map((c) => c.role),
                }
              );
              return;
            }
          }

          if (room.clients.length >= MAX_CLIENTS_PER_ROOM) {
            rejectJoin('ROOM_FULL', 'This room already has the maximum of two participants.', {
              roomId,
              role,
              activeRoles: room.clients.map((c) => c.role),
            });
            return;
          }

          const client: RoomClient = {
            participantId: randomUUID(),
            resumeToken: randomUUID(),
            ws,
            role,
            roomId,
            joinedAt: Date.now(),
          };

          currentClient = client;
          room.clients.push(client);

          // Acknowledge the join with authoritative membership state.
          safeSend(ws, {
            type: 'joined',
            participantId: client.participantId,
            // Private to this connection; never broadcast to the peer.
            resumeToken: client.resumeToken,
            roomId,
            role,
            participants: room.clients.map((c) => ({
              participantId: c.participantId,
              role: c.role,
              joinedAt: c.joinedAt,
            })),
            peers: peersOf(room, client.participantId),
            activeRoles: room.clients.map((c) => c.role),
            hasUltravoxCall: Boolean(room.ultravoxJoinUrl),
          });

          // Tell existing participants about the newcomer. The newcomer already
          // received the same information in its `joined` acknowledgement.
          notifyPeers(
            room,
            {
              type: 'peer_joined',
              participantId: client.participantId,
              role,
              participants: room.clients.map((c) => ({
                participantId: c.participantId,
                role: c.role,
                joinedAt: c.joinedAt,
              })),
              activeRoles: room.clients.map((c) => c.role),
              hasUltravoxCall: Boolean(room.ultravoxJoinUrl),
            },
            ws
          );

          console.log(
            `[room ${roomId}] ${role} joined as ${client.participantId} (${room.clients.length}/${MAX_CLIENTS_PER_ROOM})`
          );
          return;
        }

        if (sessionEnded || !currentClient) {
          safeSend(ws, {
            type: 'error',
            code: 'NOT_IN_ROOM',
            message: 'Join a room before sending messages.',
          });
          return;
        }

        const room = rooms.get(currentClient.roomId);
        if (!room) {
          safeSend(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room no longer exists.' });
          return;
        }

        // Membership is authoritative: an entry must still exist for this exact
        // socket/participant pair, otherwise the connection is no longer allowed
        // to influence the conversation.
        const isMember = room.clients.some(
          (c) => c.ws === ws && c.participantId === currentClient!.participantId
        );
        if (!isMember) {
          sessionEnded = true;
          safeSend(ws, {
            type: 'error',
            code: 'NOT_IN_ROOM',
            message: 'You are no longer a participant in this room.',
          });
          return;
        }

        if (type === 'leave_room') {
          const client = currentClient;
          currentClient = null;
          sessionEnded = true;
          removeParticipant(client, 'left');
          safeSend(ws, { type: 'left', roomId: client.roomId });
          console.log(`[room ${client.roomId}] ${client.role} ${client.participantId} left`);
          return;
        }

        if (type === 'get_room_state') {
          safeSend(ws, roomSnapshot(room, currentClient.participantId));
          return;
        }

        // Relay WebRTC signaling (offer, answer, ice_candidate) to the other
        // participant in this room only. Messages are tagged with the sender's
        // server-generated identity so clients can reject stale signaling from
        // a previous peer connection.
        if (type === 'offer' || type === 'answer' || type === 'ice_candidate') {
          const peer = room.clients.find((c) => c.participantId !== currentClient!.participantId);

          if (!peer) {
            safeSend(ws, {
              type: 'peer_unavailable',
              roomId: room.roomId,
              message: 'No peer is currently connected to receive signaling.',
            });
            return;
          }

          if (type === 'offer') {
            if (currentClient.role !== 'salesperson') {
              safeSend(ws, {
                type: 'error',
                code: 'INVALID_SIGNALING_ROLE',
                message: 'Only the salesperson may create WebRTC offers.',
              });
              return;
            }
            if (!data.offer || typeof data.offer !== 'object') {
              safeSend(ws, { type: 'error', code: 'INVALID_SIGNALING_PAYLOAD' });
              return;
            }
          }

          if (type === 'answer') {
            if (currentClient.role !== 'customer') {
              safeSend(ws, {
                type: 'error',
                code: 'INVALID_SIGNALING_ROLE',
                message: 'Only the customer may send WebRTC answers.',
              });
              return;
            }
            if (!data.answer || typeof data.answer !== 'object') {
              safeSend(ws, { type: 'error', code: 'INVALID_SIGNALING_PAYLOAD' });
              return;
            }
          }

          if (type === 'ice_candidate' && (!data.candidate || typeof data.candidate !== 'object')) {
            safeSend(ws, { type: 'error', code: 'INVALID_SIGNALING_PAYLOAD' });
            return;
          }

          safeSend(peer.ws, {
            ...data,
            roomId: room.roomId,
            from: currentClient.participantId,
            fromRole: currentClient.role,
          });
          return;
        }

        // Relay AI generated suggestions and transcripts from the customer to
        // the salesperson, using the same room-scoped, identity-tagged path.
        if (type === 'ai_suggestion' || type === 'customer_speech_transcript') {
          if (currentClient.role !== 'customer') {
            safeSend(ws, {
              type: 'error',
              code: 'INVALID_SIGNALING_ROLE',
              message: 'Only the customer may send AI suggestions or transcripts.',
            });
            return;
          }

          room.clients.forEach((c) => {
            if (c.role === 'salesperson') {
              safeSend(c.ws, {
                ...data,
                roomId: room.roomId,
                from: currentClient!.participantId,
                fromRole: currentClient!.role,
              });
            }
          });
          return;
        }

        safeSend(ws, {
          type: 'error',
          code: 'UNKNOWN_MESSAGE_TYPE',
          message: `Unsupported message type: ${String(type)}`,
        });
      } catch (err) {
        console.error('WebSocket signaling message parse error:', err);
        safeSend(ws, { type: 'error', code: 'INVALID_JSON' });
      }
    });

    ws.on('close', () => {
      if (!currentClient) return;
      const client = currentClient;
      currentClient = null;
      removeParticipant(client, 'socket_closed');
    });

    ws.on('error', (err) => {
      console.error('WebSocket connection error:', err);
    });
  });

  // Upgrade HTTP requests to WebSocket for /ws
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '';
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Vite middleware in dev vs static files in prod
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: 3000,
      },
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

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Server & WebSocket Signaling running at http://0.0.0.0:${port}`);
  });
}

startServer();
