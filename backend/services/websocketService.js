import { WebSocketServer, WebSocket } from 'ws';
import mongoose from 'mongoose';
import { Team } from '../models/Team.js';
import { Question } from '../models/Question.js';
import { db } from '../db/database.js';

import leaderboardService from './leaderboardService.js';

let wss = null;
const clients = new Set();

/**
 * Fetch and format authoritative leaderboard data.
 */
export const fetchLeaderboardData = async () => {
  try {
    return await leaderboardService.getAuthoritativeLeaderboard();
  } catch (error) {
    console.error('[WebSocket] Error fetching leaderboard data:', error.message);
    return [];
  }
};

/**
 * Broadcast current leaderboard data to all active WebSocket clients.
 */
export const broadcastLeaderboardUpdate = async () => {
  if (!wss || clients.size === 0) return;

  const leaderboard = await fetchLeaderboardData();
  const payload = JSON.stringify({
    type: 'leaderboard:update',
    event: 'leaderboard:update',
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    data: {
      leaderboard,
      totalTeams: leaderboard.length
    }
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
};

/**
 * Attach WebSocket server to the HTTP Server instance
 */
export const initLeaderboardWebSocket = (server) => {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    // Accept standard WebSocket mount paths
    if (
      pathname === '/ws/leaderboard' ||
      pathname === '/ws' ||
      pathname === '/api/leaderboard/ws'
    ) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (ws) => {
    clients.add(ws);
    console.log(`[WebSocket] Client connected for live leaderboard (${clients.size} active)`);

    // Instantly send current leaderboard state upon connection
    const leaderboard = await fetchLeaderboardData();
    const initPayload = JSON.stringify({
      type: 'leaderboard:init',
      event: 'leaderboard:init',
      timestamp: new Date().toISOString(),
      connectedClients: clients.size,
      data: {
        leaderboard,
        totalTeams: leaderboard.length
      }
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(initPayload);
    }

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        } else if (parsed.type === 'leaderboard:request') {
          const freshData = await fetchLeaderboardData();
          ws.send(
            JSON.stringify({
              type: 'leaderboard:update',
              event: 'leaderboard:update',
              timestamp: new Date().toISOString(),
              data: { leaderboard: freshData, totalTeams: freshData.length }
            })
          );
        }
      } catch (err) {
        // Ignore unparseable client messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WebSocket] Client disconnected (${clients.size} remaining)`);
    });

    ws.on('error', (err) => {
      console.error('[WebSocket] Socket error:', err.message);
      clients.delete(ws);
    });
  });

  // Keep-alive heartbeat interval
  const interval = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  if (interval.unref) interval.unref();

  wss.on('close', () => clearInterval(interval));

  console.log('[WebSocket] Live Leaderboard engine attached at /ws/leaderboard');
  return wss;
};

export const getConnectedClientsCount = () => clients.size;