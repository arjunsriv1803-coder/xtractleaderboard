import express from 'express';
import { submitSolution, getSubmissionsByTeam, getProblemsByTrack, getLeaderboard } from '../controllers/submissionController.js';
import { verifyToken, optionalAuth } from '../middleware/auth.js';
import { submissionRateLimiter, checkSubmissionRateLimit } from '../middleware/submissionRateLimiter.js';
import { getHashedPath } from '../utils/endpointHash.js';

const router = express.Router();

// Rate limit status inspection endpoint (verified from backend)
router.get(
  '/submissions/rate-limit',
  optionalAuth,
  (req, res) => {
    const status = checkSubmissionRateLimit(req);
    return res.status(200).json({ success: true, ...status });
  }
);

router.post(
  getHashedPath('submission.submit').replace('/api', ''),
  verifyToken,
  submissionRateLimiter,
  submitSolution
);

// Standard unhashed endpoint used by frontend ProblemPage
router.post(
  '/submissions',
  verifyToken,
  submissionRateLimiter,
  submitSolution
);

const submissionsHashPath = getHashedPath('submission.getByTeam').replace('/api', '');
router.get(`${submissionsHashPath}/:teamId`, verifyToken, getSubmissionsByTeam);

const problemsHashPath = getHashedPath('problem.getByTrack').replace('/api', '');
router.get(`${problemsHashPath}/:trackName`, verifyToken, getProblemsByTrack);

router.get(getHashedPath('submission.getLeaderboard').replace('/api', ''), getLeaderboard);

export default router;
