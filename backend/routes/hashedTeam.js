import express from 'express';
import { createTeam, getMyTeams, getTeamById, getAllTeams, addTeamMember } from '../controllers/teamController.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { getHashedPath } from '../utils/endpointHash.js';

const router = express.Router();

router.post(getHashedPath('team.create').replace('/api', ''), verifyToken, createTeam);
router.get(getHashedPath('team.getMyTeams').replace('/api', ''), verifyToken, getMyTeams);
// getAllTeams exposes all team info — require admin
router.get(getHashedPath('team.getAllTeams').replace('/api', ''), verifyToken, requireRole('ADMIN'), getAllTeams);

const teamHashPath = getHashedPath('team.getTeamById').replace('/api', '');
router.get(`${teamHashPath}/:teamId`, verifyToken, getTeamById);

const addMemberHashPath = getHashedPath('team.addMember').replace('/api', '');
router.post(`${addMemberHashPath}/:teamId`, verifyToken, addTeamMember);

export default router;
