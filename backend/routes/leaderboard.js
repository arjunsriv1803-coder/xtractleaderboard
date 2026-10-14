import express from 'express';
import { getPersistentLeaderboard } from '../controllers/leaderboardController.js';

const router = express.Router();

router.get('/', getPersistentLeaderboard);

// Explicitly reject tampering attempts to modify scores via leaderboard routes
router.all('/', (req, res) => {
  return res.status(405).json({
    error: 'METHOD_NOT_ALLOWED',
    message: 'Leaderboard is read-only. Scores cannot be modified directly.'
  });
});

export default router;
