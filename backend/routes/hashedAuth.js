import express from 'express';
import { register, login, getProfile } from '../controllers/authController.js';
import { verifyToken } from '../middleware/auth.js';
import { loginRateLimiter } from './auth.js';
import { getHashedPath } from '../utils/endpointHash.js';

const router = express.Router();

router.post(getHashedPath('auth.register').replace('/api', ''), register);
router.post(getHashedPath('auth.login').replace('/api', ''), loginRateLimiter, login);
router.get(getHashedPath('auth.profile').replace('/api', ''), verifyToken, getProfile);

export default router;
