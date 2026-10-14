import mongoose from 'mongoose';
import { Team as TeamModel } from '../models/Team.js';
import { Submission as SubmissionModel } from '../models/Submission.js';
import db from '../db/database.js';
import { connectDB } from '../config/db.js';
import { logActivity } from '../services/activityService.js';
import { broadcastAdminActivity, broadcastTelemetryUpdate } from '../sockets/socketManager.js';

export const SUBMISSION_RATE_LIMIT_MAX = Number(process.env.SUBMISSION_MAX_ATTEMPTS || 3);
export const SUBMISSION_RATE_LIMIT_WINDOW_MS = Number(process.env.SUBMISSION_RATE_LIMIT_WINDOW_MS || 60000); // 1-minute sliding window

/**
 * In-memory map of rate limit states keyed by canonical teamId (or fallback key)
 * Key -> {
 *   incorrectTimestamps: number[], // Timestamps (ms) of failed attempts within sliding window
 *   penaltyTier: number,           // Current penalty tier (0 before first penalty, 1 for 2m, 2 for 4m, 3 for 8m, etc.)
 *   cooldownUntil: number,         // Timestamp (ms) when current cooldown expires (0 if inactive)
 *   lastCooldownDuration: number   // Duration in seconds of current/latest cooldown
 * }
 */
const teamRateLimits = new Map();

/**
 * Calculates exponential cooldown in seconds based on penalty tier:
 * Tier 1 = 2 mins (120s)
 * Tier 2 = 4 mins (240s)
 * Tier 3 = 8 mins (480s)
 * Tier 4 = 16 mins (960s) ...
 */
export const calculateCooldownSeconds = (tier) => {
  const t = Math.max(1, Number(tier) || 1);
  const minutes = Math.pow(2, t); // 2^1 = 2, 2^2 = 4, 2^3 = 8, 2^4 = 16...
  return minutes * 60;
};

/**
 * Extract canonical key from request (prioritizing verified teamId)
 */
export const getCanonicalKey = (req) => {
  const raw = req?.user?.teamId || req?.userId || req?.ip || 'anonymous';
  return String(raw).trim().toUpperCase();
};

/**
 * Get or initialize rate limit state for a key
 */
export const getTeamRateLimitState = (key) => {
  const canonicalKey = String(key || 'anonymous').trim().toUpperCase();
  let state = teamRateLimits.get(canonicalKey);
  if (!state) {
    state = {
      incorrectTimestamps: [],
      penaltyTier: 0,
      cooldownUntil: 0,
      lastCooldownDuration: 0
    };
    teamRateLimits.set(canonicalKey, state);
  }

  // If cooldown has elapsed, clear cooldownUntil so team can submit again
  if (state.cooldownUntil && Date.now() >= state.cooldownUntil) {
    state.cooldownUntil = 0;
  }

  return state;
};

/**
 * Check if a team is currently in an active cooldown window
 */
export const isTeamInCooldown = (key) => {
  const canonicalKey = String(key || 'anonymous').trim().toUpperCase();
  const state = teamRateLimits.get(canonicalKey);
  if (!state || !state.cooldownUntil) return false;
  return Date.now() < state.cooldownUntil;
};

/**
 * Reset all rate limits (called upon competition reset)
 */
export const resetRateLimits = () => {
  teamRateLimits.clear();
};

/**
 * Reset a single team's rate limit (called when admin resets a team's rate limit)
 */
export const resetTeamRateLimit = (key) => {
  const canonicalKey = String(key || 'anonymous').trim().toUpperCase();
  teamRateLimits.delete(canonicalKey);
  const memTeam = db.getTeamById(canonicalKey) || db.getTeamByTeamId(canonicalKey);
  if (memTeam) {
    memTeam.rate_limit_violations = 0;
  }
};

/**
 * Record a correct submission - clears sliding window attempts and penalty tier
 * so the team enters the next stage fresh.
 */
export const recordCorrectSubmission = (key) => {
  const canonicalKey = String(key || 'anonymous').trim().toUpperCase();
  const state = getTeamRateLimitState(canonicalKey);
  state.incorrectTimestamps = [];
  state.penaltyTier = 0;
  state.cooldownUntil = 0;
  state.lastCooldownDuration = 0;
};

/**
 * Record an incorrect submission attempt using a 1-minute sliding window.
 * If 3 incorrect submissions occur within the 1-minute window:
 *  - Increases penalty tier (1 -> 2 -> 3 ...)
 *  - Calculates exponential cooldown: 2 mins -> 4 mins -> 8 mins
 *  - Sets cooldownUntil timestamp
 *  - Records violation in DB and broadcasts telemetry
 */
export const recordIncorrectSubmission = async (key, stage = 1, problem = null, details = '') => {
  const canonicalKey = String(key || 'anonymous').trim().toUpperCase();
  const state = getTeamRateLimitState(canonicalKey);
  const now = Date.now();

  // 1-minute sliding window: filter out attempts older than SUBMISSION_RATE_LIMIT_WINDOW_MS
  const recentTimestamps = (state.incorrectTimestamps || []).filter(
    (t) => now - t < SUBMISSION_RATE_LIMIT_WINDOW_MS
  );

  // Add current incorrect attempt
  recentTimestamps.push(now);
  state.incorrectTimestamps = recentTimestamps;

  // Check if threshold of allowed incorrect attempts (3) in 1-min sliding window has been reached
  if (recentTimestamps.length >= SUBMISSION_RATE_LIMIT_MAX) {
    state.penaltyTier += 1;
    const cooldownSeconds = calculateCooldownSeconds(state.penaltyTier);
    state.cooldownUntil = now + cooldownSeconds * 1000;
    state.lastCooldownDuration = cooldownSeconds;
    state.incorrectTimestamps = []; // Clear window attempts upon entering cooldown

    // Resolve team info
    const memTeam = db.getTeamById(canonicalKey) || db.getTeamByTeamId(canonicalKey);
    const teamName = memTeam?.team_name || memTeam?.name || canonicalKey;
    const track = Number(problem?.track) || Number(memTeam?.track) || 1;
    let updatedViolations = 1;

    // 1. Update in-memory DB
    if (memTeam) {
      memTeam.rate_limit_violations = (memTeam.rate_limit_violations || 0) + 1;
      updatedViolations = memTeam.rate_limit_violations;
    }

    // 2. Persist to MongoDB asynchronously
    if (/^[A-Z0-9_-]{1,32}$/.test(canonicalKey)) {
      if (mongoose.connection?.readyState === 0 && process.env.MONGODB_URI) {
        try { await connectDB(); } catch (e) {}
      }

      if (mongoose.connection?.readyState === 1) {
        try {
          const updatedDoc = await TeamModel.findOneAndUpdate(
            { team_id: canonicalKey },
            { $inc: { rate_limit_violations: 1 } },
            { new: true }
          );
          if (updatedDoc?.rate_limit_violations) {
            updatedViolations = updatedDoc.rate_limit_violations;
          }
        } catch (e) {
          console.error('[RateLimiter] Failed to update violation count in MongoDB:', e.message);
        }
      }
    }

    // 3. Log Activity
    try {
      const act = await logActivity({
        event: 'RATE_LIMIT_EXCEEDED',
        team_id: canonicalKey,
        team_name: teamName,
        action: `Rate limit triggered: ${SUBMISSION_RATE_LIMIT_MAX} incorrect submissions in 1m window (Tier ${state.penaltyTier}, ${cooldownSeconds / 60}m cooldown)`,
        details: `${details || `${SUBMISSION_RATE_LIMIT_MAX} incorrect submissions within 1m`}. Cooldown: ${cooldownSeconds}s. Total violations: ${updatedViolations}`,
        stage,
        track
      });
      if (act) broadcastAdminActivity(act);
    } catch (e) {}

    // 4. Broadcast instant telemetry update to Admin Dashboard
    try {
      broadcastTelemetryUpdate('teams-update', {
        teamId: canonicalKey,
        team_id: canonicalKey,
        rate_limit_violations: updatedViolations
      });
      broadcastTelemetryUpdate('rate-limit', {
        team_id: canonicalKey,
        team_name: teamName,
        retryAfter: cooldownSeconds,
        penaltyTier: state.penaltyTier,
        rate_limit_violations: updatedViolations,
        timestamp: new Date()
      });
    } catch (e) {}

    return {
      isRateLimited: true,
      retryAfterSeconds: cooldownSeconds,
      cooldownMinutes: cooldownSeconds / 60,
      attemptsUsed: SUBMISSION_RATE_LIMIT_MAX,
      maxAllowed: SUBMISSION_RATE_LIMIT_MAX,
      attemptsRemaining: 0,
      penaltyTier: state.penaltyTier,
      message: `Incorrect answer. Rate limit reached (${SUBMISSION_RATE_LIMIT_MAX} incorrect submissions in 1 min). Cooldown active for ${cooldownSeconds / 60} minutes (${cooldownSeconds}s).`
    };
  }

  // Not yet rate limited
  const remaining = SUBMISSION_RATE_LIMIT_MAX - recentTimestamps.length;
  return {
    isRateLimited: false,
    retryAfterSeconds: 0,
    attemptsUsed: recentTimestamps.length,
    maxAllowed: SUBMISSION_RATE_LIMIT_MAX,
    attemptsRemaining: remaining,
    penaltyTier: state.penaltyTier,
    message: `Incorrect answer. Try again. (${recentTimestamps.length}/${SUBMISSION_RATE_LIMIT_MAX} incorrect attempts used in 1-min window)`
  };
};

/**
 * Express Middleware: Blocks submission if the team is actively cooled down
 */
export const submissionRateLimiter = async (req, res, next) => {
  const key = getCanonicalKey(req);
  const now = Date.now();
  const state = getTeamRateLimitState(key);

  if (state.cooldownUntil && now < state.cooldownUntil) {
    const retryAfter = Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000));
    const targetTeamId = key;
    const memTeam = db.getTeamById(targetTeamId) || db.getTeamByTeamId(targetTeamId);
    const teamName = memTeam?.team_name || req.user?.teamName || targetTeamId;

    // Broadcast telemetry for repeated attempt during cooldown
    try {
      broadcastTelemetryUpdate('rate-limit', {
        team_id: targetTeamId,
        team_name: teamName,
        retryAfter,
        penaltyTier: state.penaltyTier,
        timestamp: new Date()
      });
    } catch (e) {}

    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: `Rate limit exceeded. Cooldown active for ${retryAfter}s remaining.`,
      retryAfterSeconds: retryAfter,
      isRateLimited: true,
      penaltyTier: state.penaltyTier
    });
  }

  next();
};

/**
 * Check current submission rate limit status without recording an attempt
 */
export const checkSubmissionRateLimit = (req) => {
  const key = getCanonicalKey(req);
  const now = Date.now();
  const state = getTeamRateLimitState(key);

  const isRateLimited = Boolean(state.cooldownUntil && now < state.cooldownUntil);
  const retryAfterSeconds = isRateLimited
    ? Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000))
    : 0;

  const recentAttempts = (state.incorrectTimestamps || []).filter(
    (t) => now - t < SUBMISSION_RATE_LIMIT_WINDOW_MS
  );

  return {
    isRateLimited,
    retryAfterSeconds,
    attemptsUsed: recentAttempts.length,
    maxAllowed: SUBMISSION_RATE_LIMIT_MAX,
    attemptsRemaining: Math.max(0, SUBMISSION_RATE_LIMIT_MAX - recentAttempts.length),
    penaltyTier: state.penaltyTier,
    cooldownDurationSeconds: state.lastCooldownDuration,
    windowMs: SUBMISSION_RATE_LIMIT_WINDOW_MS
  };
};

export default submissionRateLimiter;
