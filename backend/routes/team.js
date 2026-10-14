import express from 'express';
import { createTeam, getMyTeams, getTeamById, getAllTeams } from '../controllers/teamController.js';
import { verifyToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.post('/', verifyToken, createTeam);
router.get('/my-teams', verifyToken, getMyTeams);
router.get('/:teamId', verifyToken, getTeamById);
router.get('/', verifyToken, requireRole('ADMIN'), getAllTeams);

export default router;
