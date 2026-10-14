import { Router } from 'express';
import * as adminController from '../controllers/adminController.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { registerSSEClient } from '../sockets/socketManager.js';

const router = Router();

// All admin routes require a valid JWT with ADMIN role
// Apply as a router-level guard so every route below inherits it
router.use(verifyToken, requireRole('ADMIN'));

// Real-time Event Stream (Server-Sent Events)
router.get('/events', registerSSEClient);

// Overview metrics
router.get('/overview', adminController.getOverview);

// Section 1: Questions (view & edit)
router.get('/questions', adminController.getQuestions);
router.post('/questions', adminController.createQuestion);
router.put('/questions/:questionId', adminController.updateQuestion);
router.delete('/questions/:questionId', adminController.deleteQuestion);

// Section 2: Answer Logs (all submission details)
router.get('/answer-logs', adminController.getAnswerLogs);
router.post('/answer-logs', adminController.recordSubmission);

// Section 3: Team Data (logins, rate limiting, passwords, delete)
router.get('/teams', adminController.getTeams);
router.delete('/teams/:teamId', adminController.deleteTeam);
router.patch('/teams/:teamId/disqualify', adminController.toggleDisqualification);
router.patch('/teams/:teamId/rate-limit', adminController.updateRateLimit);
router.patch('/teams/:teamId/points', adminController.updateTeamPoints);
router.post('/teams/:teamId/clear-devices', adminController.clearTeamDevices);
router.delete('/teams/:teamId/devices', adminController.clearTeamDevices);

// Activity Stream & Database Seed
router.get('/activity', adminController.getActivity);
router.post('/seed', adminController.seedDatabase);

// Time & Competition Control
router.get('/competition/status', adminController.getCompetitionStatus);
router.post('/competition/start', adminController.startCompetition);
router.post('/competition/stop', adminController.stopCompetition);
router.post('/competition/reset', adminController.resetCompetition);

export default router;
