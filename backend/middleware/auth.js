import jwt from 'jsonwebtoken';
import { decryptTokenServerOnly } from '../utils/jwt.js';
import db from '../db/database.js';

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
 * Extract and decrypt the token from the request.
 *
 * Priority:
 *   1. HttpOnly cookie (__xsid) — contains an AES-256-GCM encrypted JWT.
 *      The cookie is invisible to JS; even if extracted the value is encrypted ciphertext.
 *      We decrypt it server-side before verifying.
 *   2. Authorization header — fallback for programmatic clients (Postman, admin CLI).
 *      Expected as raw JWT (Bearer <token>) for backward-compat.
 *
 * Returns the raw (decrypted) JWT string, or null if nothing valid is found.
 */
const extractToken = (req) => {
  // 1. HttpOnly encrypted cookie — decrypt server-side
  if (req.cookies && req.cookies.__xsid) {
    const decrypted = decryptTokenServerOnly(req.cookies.__xsid);
    if (decrypted) return decrypted;         // successfully decrypted → raw JWT
    // If decryption fails (tampered / wrong key) fall through to reject
    return null;
  }
  // 2. Authorization header fallback (non-browser / admin tooling)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    return authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
  }
  return null;
};

export const verifyToken = (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    req.userId = decoded.userId || decoded.id;
    req.user = decoded;
    req.email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session' });
  }
};

export const requireAuth = verifyToken;

/**
 * Role guard with DB-backed verification.
 *
 * Trusting only the JWT role claim is insufficient — a manipulated token
 * (e.g. role set to "ADMIN" on the client) would pass a naive check.
 * We re-verify against the authoritative data store so a forged role
 * is rejected even if the JWT signature is otherwise valid.
 */
export const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    // 1. Fast fail: role claim in token must match
    if (req.user.role !== role) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN_ROLE',
          message: `Access denied: Requires ${role} privileges.`
        }
      });
    }

    // 2. DB-backed verification: confirm the role is legitimate in the authoritative store.
    //    This prevents a tampered JWT where the role field was manually set to 'ADMIN'.
    if (role === 'ADMIN') {
      const userId = req.userId || req.user?.id || req.user?.userId;
      const dbUser = db.getUserById(userId) || db.getUserByEmail(req.email);

      if (!dbUser || dbUser.role !== 'ADMIN') {
        return res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN_ROLE',
            message: 'Access denied: Admin privileges could not be verified.'
          }
        });
      }
    }

    next();
  };
};

export const requireTeam = (req, res, next) => {
  if (!req.user || !req.user.teamId) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'TEAM_REQUIRED',
        message: 'Access denied: You must be assigned to an active team to perform this action.'
      }
    });
  }
  next();
};

export const optionalAuth = (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token) {
      const decoded = jwt.verify(token, getJwtSecret());
      req.userId = decoded.userId || decoded.id;
      req.user = decoded;
      req.email = decoded.email;
    }
  } catch (err) {
    // Ignore invalid/expired token for optional authentication
  }
  next();
};

export default { verifyToken, requireAuth, requireRole, requireTeam, optionalAuth };

