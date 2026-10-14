import express from 'express';
import { getAllPaths, getPathStats, assignTeamToPath, getPathByName } from '../controllers/pathController.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { getHashedPath } from '../utils/endpointHash.js';

const router = express.Router();

// Require authentication for all hashed path routes
router.get(getHashedPath('path.getAllPaths').replace('/api', ''), verifyToken, getAllPaths);
// Path stats reveal capacity info — admin only
router.get(getHashedPath('path.getPathStats').replace('/api', ''), verifyToken, requireRole('ADMIN'), getPathStats);

const pathHashPath = getHashedPath('path.getPathByName').replace('/api', '');
router.get(`${pathHashPath}/:pathName`, verifyToken, getPathByName);

router.post(getHashedPath('path.assignTeamToPath').replace('/api', ''), verifyToken, assignTeamToPath);

export default router;
