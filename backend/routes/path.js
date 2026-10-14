import express from 'express';
import { getAllPaths, getPathStats, assignTeamToPath, getPathByName, getPathQuestions } from '../controllers/pathController.js';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/', getAllPaths);
router.get('/stats', getPathStats);
router.get('/:pathName/questions', verifyToken, getPathQuestions);
router.get('/:pathName', getPathByName);
router.post('/assign', verifyToken, assignTeamToPath);

export default router;
