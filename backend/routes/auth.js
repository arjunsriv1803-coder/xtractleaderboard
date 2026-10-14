import express from 'express';
import rateLimit from 'express-rate-limit';
import { register, login, getProfile, logout } from '../controllers/authController.js';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

// Brute-force protection: max 15 failed login attempts per 15 minutes per client device
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Successful logins never count against rate limit
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const deviceId = req.headers['x-device-id'] || req.body?.deviceId;
    if (deviceId && typeof deviceId === 'string' && deviceId.trim().length > 0) {
      // Locks out only the specific device/browser attempting the logins
      return `login_dev_${deviceId.trim()}`;
    }
    return req.ip || 'anonymous';
  },
  skip: (req) => process.env.NODE_ENV === 'test' || req.body?.context === 'qr_checkpoint' || req.body?.isQrScan === true,
  message: {
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many failed login attempts from this device. Please try again after 15 minutes.'
  }
});

router.post('/register', register);
router.post('/login', loginRateLimiter, login);
router.post('/logout', (req, res, next) => {
  if (req.headers.authorization || (req.cookies && req.cookies.__xsid)) {
    return verifyToken(req, res, next);
  }
  next();
}, logout);
router.get('/profile', verifyToken, getProfile);
router.get('/me', verifyToken, getProfile);

export default router;
