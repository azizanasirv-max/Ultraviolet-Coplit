import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RoomClient {
  ws: WebSocket;
  role: 'customer' | 'salesperson';
  roomId: string;
}

interface RoomState {
  roomId: string;
  clients: RoomClient[];
  ultravoxCallId: string | null;
  ultravoxJoinUrl: string | null;
  createdTime: number;
}

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
    res.json({
      status: 'ok',
      hasUltravoxKey: Boolean(
        process.env.ULTRAVOX_API_KEY && process.env.ULTRAVOX_API_KEY !== 'MY_ULTRAVOX_API_KEY'
      ),
      activeRooms: rooms.size,
      model: 'ultravox-v0.7',
      timestamp: new Date().toISOString(),
    });
  });

  // Handle WebSocket Signaling Protocol for WebRTC P2P & AI Relay
  wss.on('connection', (ws: WebSocket) => {
    let currentClient: RoomClient | null = null;

    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message.toString());
        const { type, roomId } = data;

        if (type === 'join_room') {
          const { role } = data as { role: 'customer' | 'salesperson' };
          const room = getOrCreateRoom(roomId);

          // Remove old stale connection from same role if exists
          room.clients = room.clients.filter((c) => c.role !== role && c.ws.readyState === WebSocket.OPEN);

          currentClient = { ws, role, roomId };
          room.clients.push(currentClient);

          // Notify room of joined peer
          const peerMessage = JSON.stringify({
            type: 'peer_joined',
            role,
            activeRoles: room.clients.map((c) => c.role),
            hasUltravoxCall: Boolean(room.ultravoxJoinUrl),
          });

          room.clients.forEach((c) => {
            if (c.ws.readyState === WebSocket.OPEN) {
              c.ws.send(peerMessage);
            }
          });
          return;
        }

        if (!currentClient) return;

        const room = rooms.get(currentClient.roomId);
        if (!room) return;

        // Relay signaling messages (offer, answer, ice_candidate) to other peer in room
        if (type === 'offer' || type === 'answer' || type === 'ice_candidate') {
          room.clients.forEach((c) => {
            if (c.ws !== ws && c.ws.readyState === WebSocket.OPEN) {
              c.ws.send(JSON.stringify(data));
            }
          });
          return;
        }

        // Relay AI generated suggestions from Customer to Salesperson
        if (type === 'ai_suggestion' || type === 'customer_speech_transcript') {
          room.clients.forEach((c) => {
            if (c.role === 'salesperson' && c.ws.readyState === WebSocket.OPEN) {
              c.ws.send(JSON.stringify(data));
            }
          });
          return;
        }
      } catch (err) {
        console.error('WebSocket signaling message parse error:', err);
      }
    });

    ws.on('close', () => {
      if (currentClient) {
        const room = rooms.get(currentClient.roomId);
        if (room) {
          room.clients = room.clients.filter((c) => c.ws !== ws);
          const leftRole = currentClient.role;

          // Notify remaining peer that client left
          room.clients.forEach((c) => {
            if (c.ws.readyState === WebSocket.OPEN) {
              c.ws.send(
                JSON.stringify({
                  type: 'peer_left',
                  role: leftRole,
                  activeRoles: room.clients.map((cli) => cli.role),
                })
              );
            }
          });

          // Clean up empty room after 10 minutes
          if (room.clients.length === 0) {
            setTimeout(() => {
              const currentRoom = rooms.get(currentClient!.roomId);
              if (currentRoom && currentRoom.clients.length === 0) {
                rooms.delete(currentClient!.roomId);
              }
            }, 600000);
          }
        }
      }
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
