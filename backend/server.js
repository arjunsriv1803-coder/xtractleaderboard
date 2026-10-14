import os from 'os';
import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import db from './db/database.js';
import { Team as TeamModel } from './models/Team.js';
import { Question as QuestionModel } from './models/Question.js';
import { Submission as SubmissionModel } from './models/Submission.js';
import { TrackCapacity as TrackCapacityModel } from './models/TrackCapacity.js';
import { initLeaderboardWebSocket } from './services/websocketService.js';
import { initSocketServer } from './sockets/socketManager.js';

const getLanIp = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
};

const startServer = async () => {
  try {
    console.log('[Startup] Initializing Xtract 5.0 backend...');
    await connectDB();

    // Hydrate in-memory state and reconcile TrackCapacity from persistent MongoDB collections
    if (typeof db.syncFromMongo === 'function') {
      await db.syncFromMongo(TeamModel, QuestionModel, SubmissionModel, TrackCapacityModel);
    }

    const httpServer = http.createServer(app);

    // 1. Initialize Socket.IO engine for telemetry and admin feeds
    if (typeof initSocketServer === 'function') {
      initSocketServer(httpServer);
    }

    const lanIp = getLanIp();
    const server = httpServer.listen(env.PORT, '0.0.0.0', () => {
      console.log(
        `[Server] Running in ${env.NODE_ENV} mode on http://0.0.0.0:${env.PORT} (LAN: http://${lanIp}:${env.PORT})`
      );
      console.log(`[CORS] Allowed origin: *`);
    });

    // 2. Attach Native WebSocket server for real-time leaderboard (/ws/leaderboard)
    if (typeof initLeaderboardWebSocket === 'function') {
      initLeaderboardWebSocket(server);
    }

    const shutdown = async (signal) => {
      console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
      server.close(async () => {
        await disconnectDB();
        console.log('[Server] Database disconnected and server stopped.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('[Process] Uncaught Exception:', err);
    });
  } catch (error) {
    console.error(`[Fatal] Server failed to start:`, error.message);
    process.exit(1);
  }
};

startServer();