import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import helmet from 'helmet';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';

// Import hashed routes
import hashedAuthRoutes from './routes/hashedAuth.js';
import hashedTeamRoutes from './routes/hashedTeam.js';
import hashedPathRoutes from './routes/hashedPath.js';
import hashedSubmissionRoutes from './routes/hashedSubmission.js';
import hashedLeaderboardRoutes from './routes/hashedLeaderboard.js';

// Import readable routes
import authRoutes from './routes/auth.js';
import teamRoutes from './routes/team.js';
import pathRoutes from './routes/path.js';
import adminRoutes from './routes/adminRoutes.js';
import leaderboardRoutes from './routes/leaderboard.js';
import qrRoutes from './routes/qrRoutes.js';

// endpointHash import removed — hashed route map must not be exposed publicly
import { errorHandler } from './middleware/errorHandler.js';
import { globalRateLimiter } from './middleware/globalRateLimiter.js';

export const createApp = () => {
  const app = express();
  app.set('trust proxy', 1);

  // Apply Helmet to protect HTTP headers, enforce HSTS, nosniff, and remove x-powered-by
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false // API does not serve HTML; allows cross-origin clients and websockets
    })
  );

  // Allowed origins — normalize origins by stripping trailing slashes and supporting vercel/local origins
  const configuredOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim().replace(/\/+$/, ''))
    : null;

  // Basic security and parsing middleware
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, server-to-server)
        if (!requestOrigin) return callback(null, true);

        const cleanRequest = requestOrigin.replace(/\/+$/, '');

        // If specific origins are configured in environment variables
        if (configuredOrigins && configuredOrigins.length > 0) {
          const isExplicitlyAllowed = configuredOrigins.some((allowed) => {
            const cleanAllowed = allowed.replace(/\/+$/, '');
            return (
              cleanAllowed === '*' ||
              cleanAllowed === cleanRequest ||
              (cleanAllowed.startsWith('*.') && cleanRequest.endsWith(cleanAllowed.slice(1)))
            );
          });
          if (isExplicitlyAllowed) {
            return callback(null, true);
          }
        }

        // Always allow production Vercel frontend, local development hosts, and local network IPs
        if (
          cleanRequest === 'https://participant-xtract-5-0.vercel.app' ||
          cleanRequest.endsWith('.vercel.app') ||
          cleanRequest.startsWith('http://localhost:') ||
          cleanRequest.startsWith('http://127.0.0.1:') ||
          cleanRequest.startsWith('http://192.168.') ||
          cleanRequest.startsWith('http://10.')
        ) {
          return callback(null, true);
        }

        // If no CORS_ORIGIN was specified at all, allow all
        if (!configuredOrigins) {
          return callback(null, true);
        }

        return callback(null, false);
      },
      credentials: true  // required for HttpOnly cookies to be sent cross-origin
    })
  );

  app.use(cookieParser());                                    // parse HttpOnly session cookie
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: true, limit: '50kb' }));

  // Ensure DB connection if Mongo URI is available and not connected
  app.use(async (req, res, next) => {
    if (mongoose.connection.readyState === 0 && env.MONGODB_URI) {
      try {
        await connectDB();
      } catch (e) { }
    }
    next();
  });

  // Global site-wide rate limiter with device fingerprinting (protects against scrapers/DDoS while isolating clients behind shared NATs)
  app.use('/api', globalRateLimiter);
  app.use('/qr', globalRateLimiter);

  // Hashed endpoints (Hackathon game system)
  app.use('/api', hashedAuthRoutes);
  app.use('/api', hashedTeamRoutes);
  app.use('/api', hashedPathRoutes);
  app.use('/api', hashedSubmissionRoutes);
  app.use('/api', hashedLeaderboardRoutes);

  // Standard API endpoints
  app.use('/api/auth', authRoutes);
  app.use('/api/team', teamRoutes);
  app.use('/api/path', pathRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/qr', qrRoutes);
  app.use('/qr', qrRoutes);

  // Health check endpoint — status only, no route disclosure
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Hackathon backend is running', timestamp: new Date().toISOString() });
  });

  // /api/health must NOT expose hashed endpoints (confidential route map)
  app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Hackathon backend is running', timestamp: new Date().toISOString() });
  });

  // /api/endpoints removed — exposing the full hashed endpoint map is a critical information leak

  // Centralized Error Handling Middleware
  app.use(errorHandler);

  return app;
};

export default createApp();
//hi
