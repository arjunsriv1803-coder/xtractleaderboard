import mongoose from 'mongoose';
import db from '../db/database.js';
import submissionQueue from '../utils/submissionQueue.js';
import { minutesBetween, calculatePoints } from '../utils/scoring.js';
import { getStageConfig } from '../config/stageConfig.js';
import { logActivity } from '../services/activityService.js';
import { Team as TeamModel } from '../models/Team.js';
import { Submission as SubmissionModel } from '../models/Submission.js';
import { Question as QuestionModel } from '../models/Question.js';
import { QRRedemption as QRRedemptionModel } from '../models/QRRedemption.js';
import { TrackCapacity as TrackCapacityModel } from '../models/TrackCapacity.js';
import {
  isTeamInCooldown,
  checkSubmissionRateLimit,
  recordIncorrectSubmission,
  recordCorrectSubmission
} from '../middleware/submissionRateLimiter.js';

// Mutex lock for atomic track claiming across all concurrent submissions
const trackClaimLocks = new Map();

const acquireTrackClaimLock = async (trackName) => {
  const timeout = Date.now() + 5000;
  while (trackClaimLocks.get(trackName)) {
    if (Date.now() > timeout) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  trackClaimLocks.set(trackName, true);
};

const releaseTrackClaimLock = (trackName) => {
  trackClaimLocks.delete(trackName);
};
import {
  fetchLeaderboardData,
  broadcastLeaderboardUpdate as broadcastWsLeaderboard,
  getConnectedClientsCount
} from '../services/websocketService.js';
import {
  broadcastAdminActivity,
  broadcastTelemetryUpdate,
  broadcastLeaderboardUpdate as broadcastSocketIoLeaderboard
} from '../sockets/socketManager.js';
import leaderboardService from '../services/leaderboardService.js';
import { getPersistentLeaderboard } from './leaderboardController.js';

const checkAnswer = (problem, answer) => {
  return typeof answer === 'string' && answer.trim().length > 0;
};

/** Unified broadcast helper to trigger both Socket.IO and WS engines */
const triggerLeaderboardBroadcast = async () => {
  try {
    const updatedData = await leaderboardService.getAuthoritativeLeaderboard();
    if (typeof broadcastSocketIoLeaderboard === 'function') {
      broadcastSocketIoLeaderboard(updatedData);
    }
    if (typeof broadcastWsLeaderboard === 'function') {
      broadcastWsLeaderboard(updatedData);
    }
  } catch (err) {
    // Fallback broadcast
    if (typeof broadcastWsLeaderboard === 'function') {
      broadcastWsLeaderboard();
    }
  }
};

export const submitSolution = async (req, res) => {
  const participantId = req.userId;
  const authenticatedTeamId = req.user?.teamId;
  const requestedTeamId = req.body?.teamId;

  // Prevent cross-team tampering
  if (requestedTeamId && authenticatedTeamId && requestedTeamId !== authenticatedTeamId) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Access denied: You cannot submit for another team.'
    });
  }

  const teamId = req.user?.role === 'ADMIN' ? (requestedTeamId || authenticatedTeamId) : authenticatedTeamId;
  const { problemId, answer } = req.body;

  // Competition Active Guard: reject all submissions if competition has not started or is stopped
  const compState = db.getCompetitionState ? db.getCompetitionState() : null;
  if (!compState || !compState.isRunning) {
    return res.status(403).json({
      error: 'COMPETITION_NOT_ACTIVE',
      message: 'The competition is currently stopped or has not started yet. Submissions are disabled.'
    });
  }

  if (!teamId || !problemId || answer === undefined) {
    return res.status(400).json({ error: 'problemId and answer are required' });
  }

  const canonicalTeamId = String(teamId).trim().toUpperCase();

  const team = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId);
  if (!team) {
    return res.status(404).json({ error: 'Team not found' });
  }

  if (
    team.members &&
    !team.members.includes(participantId) &&
    team.leaderId !== participantId &&
    team.id !== participantId &&
    team.team_id !== participantId
  ) {
    return res.status(403).json({ error: 'You are not a member of this team' });
  }

  const problem = db.getProblemById(problemId);
  if (!problem) {
    return res.status(404).json({ error: 'Problem not found' });
  }

  // Authoritative Physical QR Checkpoint validation
  let isQRScanned = db.isQRScanned(canonicalTeamId, problemId);
  if (!isQRScanned && mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const redemption = await QRRedemptionModel.findOne({
        team_id: canonicalTeamId,
        problem_id: problemId
      });
      if (redemption) {
        isQRScanned = true;
        db.recordQRScan(canonicalTeamId, problemId, redemption.qr_token);
      }
    } catch (e) { }
  }

  if (!isQRScanned) {
    const scannedProblems = db.getScannedProblemsForTeam ? db.getScannedProblemsForTeam(canonicalTeamId) : [];
    if (scannedProblems.length > 0 && !scannedProblems.includes(problemId)) {
      const otherProblem = db.getProblemById(scannedProblems[scannedProblems.length - 1]);
      return res.status(403).json({
        error: 'WRONG_QR_CODE',
        message: `Wrong QR code! You scanned the QR code for ${otherProblem ? otherProblem.trackName + ' (' + otherProblem.title + ')' : 'another problem'
          }, which does not belong to this problem (${problem.trackName} - ${problem.title}). Please scan the correct QR code for this problem.`
      });
    }

    return res.status(403).json({
      error: 'QR_REQUIRED',
      message: 'You must scan the physical QR code for this problem before submitting.'
    });
  }

  const stageNumber = problem.order || problem.stage;

  submissionQueue
    .enqueue(canonicalTeamId, async () => {
      // Re-verify rate limit cooldown inside queue
      if (isTeamInCooldown(canonicalTeamId)) {
        const check = checkSubmissionRateLimit({ user: { teamId: canonicalTeamId } });
        return {
          status: 429,
          body: {
            error: 'TOO_MANY_REQUESTS',
            message: `Rate limit exceeded. Cooldown active for ${check.retryAfterSeconds}s remaining.`,
            retryAfterSeconds: check.retryAfterSeconds,
            isRateLimited: true,
            penaltyTier: check.penaltyTier
          }
        };
      }

      // Re-verify competition state inside queue
      const queuedCompState = db.getCompetitionState ? db.getCompetitionState() : null;
      if (!queuedCompState || !queuedCompState.isRunning) {
        return {
          status: 403,
          body: {
            error: 'COMPETITION_NOT_ACTIVE',
            message: 'The competition is currently stopped or has not started yet. Submissions are disabled.'
          }
        };
      }

      let freshTeam = db.getTeamById(teamId) || db.getTeamByTeamId(teamId);
      if (!freshTeam) {
        return { status: 404, body: { error: 'Team not found' } };
      }

      if (mongoose.connection && mongoose.connection.readyState === 1 && teamId) {
        try {
          const canonicalId = (freshTeam.team_id || freshTeam.id || teamId).toUpperCase();
          const mongoTeam = await TeamModel.findOne({ team_id: canonicalId }).lean();
          if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
            freshTeam = db.syncTeamFromMongo(mongoTeam) || freshTeam;
          }
        } catch (e) { }
      }

      const canonicalTeamName = freshTeam.team_name || freshTeam.name || canonicalTeamId;

      // Track assignment validation
      if (
        freshTeam.trackConfirmed &&
        (freshTeam.pathAssigned !== problem.trackName || freshTeam.track !== problem.track)
      ) {
        return {
          status: 403,
          body: {
            error: `Your team is locked into ${freshTeam.pathAssigned}. Submissions to ${problem.trackName} are not accepted.`
          }
        };
      }

      // Stage progression check
      if (!freshTeam.trackConfirmed && stageNumber !== 1) {
        return {
          status: 403,
          body: {
            error: 'You must complete Stage 1 (DS) and be assigned to a track before attempting later stages.'
          }
        };
      }

      if (freshTeam.trackConfirmed && stageNumber > 1) {
        const prevSolved = freshTeam.stageProgress[String(stageNumber - 1)];
        if (!prevSolved) {
          return {
            status: 403,
            body: {
              error: `You must solve Stage ${stageNumber - 1} before attempting Stage ${stageNumber}.`
            }
          };
        }
      }

      const isCorrect = db.checkAnswer ? db.checkAnswer(problem, answer) : checkAnswer(problem, answer);
      const submission = db.createSubmission(canonicalTeamId, problemId, participantId, answer, isCorrect);
      const isAlreadySolved = !!(freshTeam.stageProgress && freshTeam.stageProgress[String(stageNumber)]);

      // Calculate score according to the threshold & linear decay formula
      const stageStart = db.getStageStartTime(freshTeam, stageNumber);
      const minutesTaken = stageStart ? minutesBetween(submission.createdAt, stageStart) : 0;
      const stageCfg = getStageConfig(stageNumber);
      const points = stageCfg ? calculatePoints(stageCfg, Math.max(0, minutesTaken)) : (problem.points || 100);

      // MongoDB Submission log
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          await SubmissionModel.create({
            team_id: canonicalTeamId,
            team_name: canonicalTeamName,
            question_id: null,
            question_text: problem.title || problem.ques,
            stage: stageNumber,
            track: Number(problem.track) || 1,
            submitted_answer: answer,
            is_correct: isCorrect,
            points_awarded: isCorrect && !isAlreadySolved ? points : 0
          });
        } catch (e) {
          // Log silently
        }
      }

      if (!isCorrect) {
        const rlResult = await recordIncorrectSubmission(
          canonicalTeamId,
          stageNumber,
          problem,
          `Answer: "${answer}"`
        );

        try {
          const act = await logActivity({
            event: 'answer_incorrect',
            team_id: canonicalTeamId,
            team_name: canonicalTeamName,
            action: `Team ${canonicalTeamName} incorrect attempt on Stage ${stageNumber}`,
            details: `Problem: ${problem.title || problemId}`,
            stage: stageNumber,
            track: Number(problem.track) || 1,
            track_name: problem.trackName || null
          });

          if (act && typeof broadcastAdminActivity === 'function') {
            broadcastAdminActivity(act);
          }
          if (typeof broadcastTelemetryUpdate === 'function') {
            broadcastTelemetryUpdate('new-submission', {
              team_id: canonicalTeamId,
              team_name: canonicalTeamName,
              stage: stageNumber,
              track: Number(problem.track) || 1,
              is_correct: false,
              submitted_answer: answer
            });
          }
        } catch (err) {
          // Log silently
        }

        return {
          status: 200,
          body: {
            submission: {
              id: submission.id,
              teamId: canonicalTeamId,
              problemId,
              isCorrect: false,
              createdAt: submission.createdAt
            },
            isCorrect: false,
            isRateLimited: Boolean(rlResult?.isRateLimited),
            retryAfterSeconds: rlResult?.retryAfterSeconds || 0,
            attemptsRemaining: rlResult?.attemptsRemaining !== undefined ? rlResult.attemptsRemaining : 0,
            attemptsUsed: rlResult?.attemptsUsed || 0,
            maxAllowed: rlResult?.maxAllowed || 3,
            penaltyTier: rlResult?.penaltyTier || 0,
            message: rlResult?.message || 'Incorrect answer. Try again.'
          }
        };
      }

      // Stage 1 Track Capacity check (Atomic limit of 7 teams per track)
      let lockResult = null;
      if (stageNumber === 1 && !freshTeam.trackConfirmed) {
        await acquireTrackClaimLock(problem.trackName);
        try {
          // Distributed atomic slot reservation in MongoDB (shared across multiple backend instances)
          if (mongoose.connection && mongoose.connection.readyState === 1) {
            let claimDoc = null;
            try {
              claimDoc = await TrackCapacityModel.findOneAndUpdate(
                {
                  track_name: problem.trackName,
                  $or: [
                    { claimed_teams: canonicalTeamId },
                    { 'claimed_teams.6': { $exists: false } }
                  ]
                },
                {
                  $setOnInsert: { track_number: Number(problem.track) || 1, max_teams: 7 },
                  $addToSet: { claimed_teams: canonicalTeamId }
                },
                { upsert: true, new: true }
              );
            } catch (err) {
              if (err.code === 11000) {
                claimDoc = null;
              } else {
                console.error('[SubmissionController] TrackCapacity error:', err.message);
              }
            }

            if (!claimDoc || (!claimDoc.claimed_teams.includes(canonicalTeamId) && claimDoc.claimed_teams.length >= 7)) {
              return {
                status: 409,
                body: {
                  submission: {
                    id: submission.id,
                    teamId: canonicalTeamId,
                    problemId,
                    isCorrect: false,
                    createdAt: submission.createdAt
                  },
                  error: 'This track is full. All 7 team slots have already been claimed. Please choose another available track.',
                  message: 'This track is full. All 7 team slots have already been claimed. Please choose another available track.',
                  trackFull: true,
                  isCorrect: false
                }
              };
            }
          }

          let mongoTrackCount = 0;
          try {
            mongoTrackCount = await TeamModel.countDocuments({
              track: Number(problem.track),
              trackConfirmed: true
            });
          } catch (e) { }

          const path = db.getPathByName(problem.trackName);
          const memTrackCount = path ? path.currentTeams : 0;
          const currentClaimed = Math.max(mongoTrackCount, memTrackCount);

          if (currentClaimed >= 7) {
            return {
              status: 409,
              body: {
                submission: {
                  id: submission.id,
                  teamId: canonicalTeamId,
                  problemId,
                  isCorrect: false,
                  createdAt: submission.createdAt
                },
                error: 'This track is full. All 7 team slots have already been claimed. Please choose another available track.',
                message: 'This track is full. All 7 team slots have already been claimed. Please choose another available track.',
                trackFull: true,
                isCorrect: false
              }
            };
          }

          lockResult = db.confirmTeamTrack(canonicalTeamId, problem.trackName, {
            participantId,
            submissionId: submission.id
          });

          if (!lockResult.success) {
            return {
              status: 409,
              body: {
                submission: {
                  id: submission.id,
                  teamId: canonicalTeamId,
                  problemId,
                  isCorrect: false,
                  createdAt: submission.createdAt
                },
                error: lockResult.error || 'This track is full. All 7 team slots have already been claimed. Please choose another available track.',
                message: lockResult.error || 'This track is full. All 7 team slots have already been claimed. Please choose another available track.',
                trackFull: true,
                isCorrect: false
              }
            };
          }

          // Persist track assignment to MongoDB Team
          if (mongoose.connection && mongoose.connection.readyState === 1) {
            try {
              await TeamModel.findOneAndUpdate(
                { team_id: canonicalTeamId },
                {
                  $set: {
                    track: Number(problem.track),
                    pathAssigned: problem.trackName,
                    trackConfirmed: true
                  }
                }
              );
            } catch (e) { }
          }
        } finally {
          releaseTrackClaimLock(problem.trackName);
        }
      }

      // Reset rate limit penalty tier and attempts on correct solve
      recordCorrectSubmission(canonicalTeamId);

      // Record stage solve in memory using decayed points
      const scoreResult = db.recordStageSolve(canonicalTeamId, stageNumber, points, minutesTaken, submission.id);
      const isFinalStage = stageNumber === 4;
      const revealNote = isFinalStage
        ? 'Victory! All districts claimed.'
        : `Stage ${stageNumber + 1} (${['DS', 'ML', 'NLP', 'OPEN_CV'][stageNumber]}) is now available.`;

      if (!isAlreadySolved) {
        // Sync QuestionModel
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          try {
            const numericTrack = Number(problem.track) || 1;
            let questionDoc = await QuestionModel.findOne({ track: numericTrack, stage: stageNumber });
            if (!questionDoc) {
              await QuestionModel.create({
                ques: problem.ques || (Array.isArray(problem.statement) ? problem.statement.join('\n') : ''),
                title: problem.title,
                ans: problem.ans || '',
                stage: stageNumber,
                track: numericTrack,
                points: points,
                nextHint: problem.nextHint || '',
                qrToken: problem.qrToken || '',
                submitted_teams: [{ team_id: canonicalTeamId, timestamp: new Date() }]
              });
            } else {
              const alreadySubmitted = (questionDoc.submitted_teams || []).some(
                (st) => (st.team_id || '').toLowerCase() === canonicalTeamId.toLowerCase()
              );
              if (!alreadySubmitted) {
                await QuestionModel.updateOne(
                  { _id: questionDoc._id },
                  {
                    $push: {
                      submitted_teams: {
                        team_id: canonicalTeamId,
                        timestamp: new Date()
                      }
                    }
                  }
                );
              }
            }
          } catch (e) {
            console.error('[SubmissionController] Failed to persist Question solve to MongoDB:', e.message);
          }
        }

        // Sync in-memory problem
        try {
          if (!problem.submitted_teams) {
            problem.submitted_teams = [];
          }
          const memAlready = problem.submitted_teams.some(
            (st) => (st.team_id || '').toLowerCase() === canonicalTeamId.toLowerCase()
          );
          if (!memAlready) {
            problem.submitted_teams.push({
              team_id: canonicalTeamId,
              timestamp: new Date()
            });
          }
        } catch (e) { }

        // Sync MongoDB Team
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          try {
            await TeamModel.findOneAndUpdate(
              { team_id: canonicalTeamId },
              {
                $set: {
                  track: freshTeam.track,
                  stage: freshTeam.stage,
                  points: scoreResult.totalScore,
                  pathAssigned: freshTeam.pathAssigned,
                  trackConfirmed: Boolean(freshTeam.trackConfirmed),
                  stageProgress: freshTeam.stageProgress
                }
              }
            );
          } catch (e) {
            console.error('[SubmissionController] Failed to update Team in MongoDB:', e.message);
          }
        }

        // Log Activity
        let loggedActivity = null;
        try {
          loggedActivity = await logActivity({
            event: 'answer_correct',
            team_id: canonicalTeamId,
            team_name: canonicalTeamName,
            action: `Team ${canonicalTeamName} solved Stage ${stageNumber}`,
            details: `Problem: ${problem.title || problemId} (Track ${problem.trackName || problem.track})`,
            stage: stageNumber,
            track: Number(problem.track) || 1,
            track_name: problem.trackName || null
          });
        } catch (err) {
          console.error('[SubmissionController] Failed to log activity:', err.message);
        }

        // Telemetry & Broadcasts
        try {
          if (loggedActivity && typeof broadcastAdminActivity === 'function') {
            broadcastAdminActivity(loggedActivity);
          }
          if (typeof broadcastTelemetryUpdate === 'function') {
            broadcastTelemetryUpdate('questions-update', {
              track: Number(problem.track) || 1,
              stage: stageNumber,
              teamId: canonicalTeamId
            });
            broadcastTelemetryUpdate('teams-update', {
              teamId: canonicalTeamId,
              stage: freshTeam.stage,
              track: freshTeam.track,
              points: scoreResult.totalScore
            });
            broadcastTelemetryUpdate('new-submission', {
              team_id: canonicalTeamId,
              team_name: canonicalTeamName,
              stage: stageNumber,
              track: Number(problem.track) || 1,
              is_correct: true,
              submitted_answer: answer,
              points_awarded: points
            });
          }

          await triggerLeaderboardBroadcast();
        } catch (e) { }
      }

      await triggerLeaderboardBroadcast();

      const response = {
        submission: {
          id: submission.id,
          teamId: canonicalTeamId,
          problemId,
          isCorrect: true,
          pointsAwarded: points,
          createdAt: submission.createdAt
        },
        isCorrect: true,
        pointsAwarded: points,
        message:
          stageNumber === 1
            ? lockResult && lockResult.alreadyConfirmed
              ? `Correct! Stage 1 of ${problem.trackName} solved (+${points} pts). ${revealNote}`
              : `Correct! Your team is assigned to Track ${problem.trackName} (+${points} pts). ${revealNote}`
            : `Correct! Stage ${stageNumber} solved (+${points} pts). ${revealNote}`,
        assignedTrack: freshTeam.pathAssigned,
        trackAssigned: freshTeam.pathAssigned,
        stageProgress: scoreResult.stageProgress,
        totalScore: scoreResult.totalScore,
        isFinalStage
      };

      return { status: 201, body: response };
    })
    .then((result) => res.status(result.status).json(result.body))
    .catch((err) => {
      console.error('[SubmissionController] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
};

export const getSubmissionsByTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    const canonicalTeamId = String(teamId || '').trim().toUpperCase();

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        const mongoSubs = await SubmissionModel.find({
          $or: [{ team_id: teamId }, { team_id: canonicalTeamId }]
        }).sort({ timestamp: -1, createdAt: -1 }).lean();

        if (mongoSubs && mongoSubs.length > 0) {
          return res.json({
            submissions: mongoSubs.map((s) => ({
              id: s._id,
              teamId: s.team_id,
              problemId: s.question_id || `prob_${s.track}_${s.stage}`,
              answer: s.submitted_answer,
              isCorrect: s.is_correct,
              points_awarded: s.points_awarded,
              createdAt: s.timestamp || s.createdAt
            }))
          });
        }
      } catch (e) { }
    }

    const submissions = db.getSubmissionsByTeam(teamId);
    res.json({ submissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getProblemsByTrack = async (req, res) => {
  try {
    const { trackName } = req.params;
    const authenticatedTeamId = req.user?.teamId;
    const requestedTeamId = req.query?.teamId;

    if (requestedTeamId && authenticatedTeamId && requestedTeamId !== authenticatedTeamId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: "Access denied: You cannot view another team's challenge state."
      });
    }

    const teamId = authenticatedTeamId || requestedTeamId;

    const path = db.getPathByName(trackName);
    if (!path) {
      return res.status(404).json({ error: `Track ${trackName} not found` });
    }

    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Problem database is unavailable' });
    }

    const questions = await QuestionModel.find({ track: path.trackNumber })
      .sort({ stage: 1 })
      .lean();

    if (questions.length === 0) {
      return res.status(404).json({ error: `No problems found for track ${trackName}` });
    }

    if (!teamId) {
      return res.json({
        problems: questions.filter((question) => question.stage === 1).map((question) => ({
          id: `prob_${path.id}_${question.stage}`,
          _id: question._id,
          title: question.title,
          ques: question.ques,
          statement: question.ques ? question.ques.split('\n') : [],
          stage: question.stage,
          order: question.stage,
          track: question.track,
          trackName: path.name,
          points: question.points,
          nextHint: question.nextHint,
          qrToken: question.qrToken
        })),
        note: 'Pass ?teamId=<your team id> to see problems unlocked by your team.'
      });
    }

    let team = db.getTeamById(teamId) || db.getTeamByTeamId(teamId);

    if (teamId) {
      try {
        const canonicalId = (team?.team_id || team?.id || teamId).toUpperCase();
        const mongoTeam = await TeamModel.findOne({ team_id: canonicalId }).lean();
        if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
          team = db.syncTeamFromMongo(mongoTeam) || team;
        }
      } catch (e) { }
    }

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const participantId = req.userId;
    if (
      team.members &&
      !team.members.includes(participantId) &&
      team.leaderId !== participantId &&
      team.id !== participantId &&
      team.team_id !== participantId
    ) {
      return res.status(403).json({ error: 'You are not a member of this team' });
    }

    if (team.trackConfirmed && team.pathAssigned !== path.name && team.track !== path.trackNumber) {
      return res.status(403).json({
        error: 'TRACK_LOCKED',
        locked: true,
        message: `Your team is locked into track ${team.pathAssigned}. Submissions and problem access for ${path.name} are forbidden.`
      });
    }

    const solvedStages = Object.keys(team.stageProgress || {}).map(Number);
    const highestSolved = solvedStages.length ? Math.max(...solvedStages) : 0;
    const maxVisibleStage = team.trackConfirmed ? Math.min(4, highestSolved + 1) : 1;
    const problems = questions
      .filter((question) => question.stage <= maxVisibleStage)
      .map((question) => ({
        id: `prob_${path.id}_${question.stage}`,
        _id: question._id,
        title: question.title,
        ques: question.ques,
        statement: question.ques ? question.ques.split('\n') : [],
        stage: question.stage,
        order: question.stage,
        track: question.track,
        trackName: path.name,
        points: question.points,
        nextHint: question.nextHint,
        qrToken: question.qrToken,
        qrScanned: db.isQRScanned(team.id, `prob_${path.id}_${question.stage}`)
      }));

    res.json({
      problems,
      trackLockedForTeam: team.trackConfirmed,
      teamTrack: team.pathAssigned,
      locked: false
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getLeaderboard = getPersistentLeaderboard;

export default { submitSolution, getSubmissionsByTeam, getProblemsByTrack, getLeaderboard };