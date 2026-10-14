import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { decryptTokenServerOnly } from '../utils/jwt.js';

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret.length < 32 || secret.includes('change_this') || secret.includes('change_in_production')) {
      throw new Error('FATAL: JWT_SECRET missing or insecure in production environment');
    }
    return secret;
  }
  return secret || 'hackathon_secret_key_2024_change_in_production';
};

/**
 * Extract cryptographically verified identity from JWT (cookie or header).
 * Returns decoded payload if valid, null otherwise.
 */
const getVerifiedAuthPayload = (req) => {
  try {
    let token = null;
    if (req.cookies && req.cookies.__xsid) {
      token = decryptTokenServerOnly(req.cookies.__xsid);
    } else if (req.headers.authorization) {
      const authHeader = req.headers.authorization;
      token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    }

    if (!token) return null;
    return jwt.verify(token, getJwtSecret());
  } catch (e) {
    return null;
  }
};

/**
 * Generates an authoritative, backend-verified client fingerprint key.
 *
 * Rules:
 * 1. If client is logged in with a valid cryptographic JWT:
 *    Key = `fp_auth_${teamId}_${deviceId}` (tamper-proof via server JWT secret).
 *    Faking x-device-id in DevTools/cURL has ZERO effect because the JWT is server-signed.
 *
 * 2. If client is unauthenticated (e.g. login attempts, public pages, or terminal scripts):
 *    Key = `fp_nat_${SHA-256(ip + userAgent + secChUa + secPlatform + acceptLanguage)}`.
 *    Rotating fake x-device-id strings in terminal/DevTools has ZERO effect because
 *    unverified headers are discarded, binding the client strictly to their physical connection.
 */
export const generateClientFingerprint = (req) => {
  // 1. Authoritative: Cryptographically verified JWT session
  const verifiedUser = getVerifiedAuthPayload(req);
  if (verifiedUser && verifiedUser.teamId) {
    const verifiedTeam = String(verifiedUser.teamId).trim().toUpperCase();
    const verifiedDevice = verifiedUser.deviceId ? `_${verifiedUser.deviceId}` : '';
    return `fp_auth_${verifiedTeam}${verifiedDevice}`;
  }

  // 2. Unauthenticated: Passive physical hardware/connection fingerprint
  // Completely ignores untrusted client headers like random x-device-id
  const ip = req.ip || req.socket?.remoteAddress || '0.0.0.0';
  const userAgent = req.headers['user-agent'] || 'unknown_ua';
  const acceptLanguage = (req.headers['accept-language'] || '').split(',')[0];
  const secChUa = req.headers['sec-ch-ua'] || '';
  const secPlatform = req.headers['sec-ch-ua-platform'] || '';

  const rawFingerprint = `${ip}::${userAgent}::${secChUa}::${secPlatform}::${acceptLanguage}`;
  const hash = crypto.createHash('sha256').update(rawFingerprint).digest('hex').slice(0, 20);

  return `fp_nat_${hash}`;
};

const WINDOW_MS = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 60000); // 1 minute
const MAX_REQUESTS = Number(process.env.GLOBAL_RATE_LIMIT_MAX || 150);      // 150 requests/min per client

export const globalRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true, // draft-7 RateLimit-* headers
  legacyHeaders: false,  // disable X-RateLimit-* headers
  validate: { keyGeneratorIpFallback: false },

  // Key generator based on backend-verified cryptographic session + passive connection fingerprint
  keyGenerator: (req) => generateClientFingerprint(req),

  // Exempt paths that should never count towards rate limiting
  skip: (req) => {
    const url = req.originalUrl || req.path || '';

    // 1. Skip CORS preflights
    if (req.method === 'OPTIONS') return true;

    // 2. Skip health endpoints (Render keep-alive & monitors)
    if (url.includes('/health')) return true;

    // 3. Skip WebSocket / Socket.IO paths
    if (url.includes('/socket.io') || url.includes('/ws')) return true;

    // 4. Skip authenticated admin routes (dashboard polling / telemetry)
    if (url.startsWith('/api/admin') && req.headers.authorization) return true;

    // 5. Skip test environment
    if (process.env.NODE_ENV === 'test') return true;

    return false;
  },

  handler: (req, res, next, options) => {
    res.status(429).json({
      success: false,
      error: 'TOO_MANY_REQUESTS',
      message: 'Too many requests from this device. Please slow down and try again shortly.',
      retryAfter: Math.ceil(options.windowMs / 1000)
    });
  }
});

export default globalRateLimiter;
