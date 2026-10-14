import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

let ioInstance = null;
export const ADMIN_ROOM = 'admin-channel';
const sseClients = new Set();

/**
 * Initializes the Socket.IO server with JWT-authenticated team and admin rooms.
 */
export const initSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      credentials: false
    }
  });

  // Authenticate socket connections via handshake auth / headers / query
  io.use((socket, next) => {
    try {
      const rawToken =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
        socket.handshake.query?.token;

      if (rawToken && typeof rawToken === 'string') {
        const decoded = jwt.verify(
          rawToken.trim(),
          env.JWT_SECRET || process.env.JWT_SECRET || 'hackathon_secret_key_2024_change_in_production'
        );
        socket.user = decoded;
      } else {
        socket.user = null;
      }
    } catch (err) {
      // Invalid token: socket connects as unauthenticated public client
      socket.user = null;
    }
    next();
  });

  io.on('connection', (socket) => {
    // 1. Privileged Admin room
    if (socket.user?.role === 'ADMIN') {
      socket.join(ADMIN_ROOM);
      socket.emit('admin:status', {
        connected: true,
        message: 'Connected to Xtract 5.0 Admin Real-Time Engine',
        timestamp: new Date().toISOString()
      });
    }

    // 2. Authoritative Team room (derived strictly from verified JWT)
    if (socket.user?.teamId) {
      const teamRoom = `team:${socket.user.teamId}`;
      socket.join(teamRoom);
      socket.emit('team:status', {
        connected: true,
        teamId: socket.user.teamId,
        room: teamRoom,
        timestamp: new Date().toISOString()
      });
    }

    // Allow client to authenticate on the fly (after connection establishment)
    socket.on('admin:auth', (data) => {
      const token = data?.token;
      if (token && typeof token === 'string') {
        try {
          const decoded = jwt.verify(
            token.trim(),
            env.JWT_SECRET || process.env.JWT_SECRET || 'hackathon_secret_key_2024_change_in_production'
          );
          if (decoded.role === 'ADMIN') {
            socket.user = decoded;
            socket.join(ADMIN_ROOM);
            socket.emit('admin:status', {
              connected: true,
              authenticated: true,
              message: 'Connected to Xtract 5.0 Admin Real-Time Engine',
              timestamp: new Date().toISOString()
            });
          }
        } catch (e) {}
      }
    });

    // Security: Reject arbitrary room join attempts or spoofed client emissions
    socket.on('join', () => {
      console.warn(`[Socket Security] Client ${socket.id} attempted arbitrary room join. Blocked.`);
    });

    socket.on('leaderboard:update', () => {
      console.warn(`[Socket Security] Client ${socket.id} attempted to emit leaderboard:update. Blocked.`);
    });

    socket.on('disconnect', () => {
      // Clean disconnect
    });
  });

  ioInstance = io;
  return io;
};

/**
 * Emits an event specifically to a team's authenticated Socket.IO room.
 */
export const emitTeamQREvent = (teamId, eventName, data) => {
  if (ioInstance && teamId) {
    ioInstance.to(`team:${teamId}`).emit(eventName, data);
  }
};

/**
 * Returns current Socket.IO instance if initialized.
 */
export const getIO = () => ioInstance;

/**
 * Registers an HTTP Server-Sent Events (SSE) client response stream.
 */
export const registerSSEClient = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('data: {"type":"CONNECTED"}\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
};

/**
 * Broadcasts to all connected SSE clients.
 */
export const broadcastToSSE = (type, data) => {
  const payload = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
};

/**
 * Broadcasts a participant activity event to all connected admin dashboards.
 */
export const broadcastAdminActivity = (activity) => {
  if (ioInstance) {
    ioInstance.to(ADMIN_ROOM).emit('admin:activity', activity);
    ioInstance.emit('admin:activity', activity);
  }
  broadcastToSSE('activity', activity);
};

/**
 * Broadcasts an overview/teams/questions telemetry update to all connected admins.
 */
export const broadcastTelemetryUpdate = (type, data) => {
  if (ioInstance) {
    ioInstance.to(ADMIN_ROOM).emit(`admin:${type}`, data);
    ioInstance.emit(`admin:${type}`, data);
  }
  broadcastToSSE(type, data);
};

/**
 * Broadcasts an authoritative leaderboard update to all connected clients and admins.
 */
export const broadcastLeaderboardUpdate = (leaderboardData) => {
  const payload = {
    success: true,
    data: {
      title: 'MORNING LINE ODDS',
      teams: leaderboardData
    },
    leaderboard: leaderboardData,
    teams: leaderboardData,
    timestamp: new Date().toISOString()
  };

  if (ioInstance) {
    // Broadcast to public participant sockets
    ioInstance.emit('leaderboard:update', payload);
    // Also notify admin room
    ioInstance.to(ADMIN_ROOM).emit('admin:leaderboard-update', payload);
  }
  broadcastToSSE('leaderboard:update', payload);
};

export default {
  initSocketServer,
  getIO,
  emitTeamQREvent,
  registerSSEClient,
  broadcastAdminActivity,
  broadcastTelemetryUpdate,
  broadcastLeaderboardUpdate,
  ADMIN_ROOM
};
