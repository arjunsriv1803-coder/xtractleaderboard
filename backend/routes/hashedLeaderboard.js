import express from 'express';
import { getPersistentLeaderboard } from '../controllers/leaderboardController.js';
import { getHashedPath } from '../utils/endpointHash.js';

const router = express.Router();

router.get(getHashedPath('leaderboard.get').replace('/api', ''), getPersistentLeaderboard);

export default router;
