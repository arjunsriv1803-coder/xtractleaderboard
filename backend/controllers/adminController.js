import * as adminService from '../services/adminService.js';
import * as activityService from '../services/activityService.js';
import * as competitionService from '../services/competitionService.js';
import db from '../db/database.js';
import { resetRateLimits, resetTeamRateLimit } from '../middleware/submissionRateLimiter.js';
import { broadcastLeaderboardUpdate, broadcastTelemetryUpdate } from '../sockets/socketManager.js';
import leaderboardService from '../services/leaderboardService.js';

export const getOverview = async (req, res, next) => {
  try {
    const data = await adminService.getDashboardOverview();
    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

/**
 * SECTION 1: QUESTIONS
 */
export const getQuestions = async (req, res, next) => {
  try {
    const questions = await adminService.getQuestionsMonitoring();
    res.status(200).json({
      success: true,
      data: { questions }
    });
  } catch (error) {
    next(error);
  }
};

export const createQuestion = async (req, res, next) => {
  try {
    const question = await adminService.createQuestion(req.body);
    res.status(201).json({
      success: true,
      data: { question }
    });
  } catch (error) {
    next(error);
  }
};

export const updateQuestion = async (req, res, next) => {
  try {
    const { questionId } = req.params;
    const question = await adminService.updateQuestion(questionId, req.body);
    res.status(200).json({
      success: true,
      data: { question }
    });
  } catch (error) {
    next(error);
  }
};

export const deleteQuestion = async (req, res, next) => {
  try {
    const { questionId } = req.params;
    const question = await adminService.deleteQuestion(questionId);
    res.status(200).json({
      success: true,
      message: 'Question deleted successfully.',
      data: { question }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * SECTION 2: ANSWER LOGS (SUBMISSIONS)
 */
export const getAnswerLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '50', 10);
    const team_id = req.query.team_id || null;
    const is_correct = req.query.is_correct ?? null;
    const stage = req.query.stage || null;
    const track = req.query.track || null;

    const result = await adminService.getAnswerLogs({ page, limit, team_id, is_correct, stage, track });
    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

export const recordSubmission = async (req, res, next) => {
  try {
    const submission = await adminService.recordSubmissionLog(req.body);
    res.status(201).json({
      success: true,
      data: { submission }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * SECTION 3: TEAM DATA
 */
export const getTeams = async (req, res, next) => {
  try {
    const teams = await adminService.getTeamsMonitoring();
    res.status(200).json({
      success: true,
      data: { teams }
    });
  } catch (error) {
    next(error);
  }
};

export const deleteTeam = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const deleted = await adminService.deleteTeam(teamId);

    // Keep in-memory DB and live leaderboards in sync
    try {
      db.teams.delete(teamId);
      const updatedLeaderboard = await leaderboardService.getAuthoritativeLeaderboard();
      broadcastLeaderboardUpdate(updatedLeaderboard);
      broadcastTelemetryUpdate('teams-update', { teamId, action: 'deleted' });
    } catch (e) {}

    res.status(200).json({
      success: true,
      message: `Team ${teamId} deleted successfully.`,
      data: { team: deleted }
    });
  } catch (error) {
    next(error);
  }
};

export const toggleDisqualification = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const { disqualified } = req.body;
    const updatedTeam = await adminService.toggleTeamDisqualification(teamId, disqualified);

    // Keep in-memory DB and live leaderboards in sync
    try {
      if (db.teams && db.teams.has(teamId)) {
        const memTeam = db.teams.get(teamId);
        if (memTeam) memTeam.disqualified = Boolean(disqualified);
      }
      const updatedLeaderboard = await leaderboardService.getAuthoritativeLeaderboard();
      broadcastLeaderboardUpdate(updatedLeaderboard);
      broadcastTelemetryUpdate('teams-update', {
        teamId,
        disqualified: Boolean(disqualified),
        stage: updatedTeam.stage,
        track: updatedTeam.track,
        points: updatedTeam.points
      });
    } catch (e) {
      console.error('[AdminController] Broadcast error:', e);
    }

    res.status(200).json({
      success: true,
      data: { team: updatedTeam }
    });
  } catch (error) {
    next(error);
  }
};

export const updateRateLimit = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const { count } = req.body;
    const updatedTeam = await adminService.updateTeamRateLimit(teamId, count);
    resetTeamRateLimit(teamId);

    try {
      broadcastTelemetryUpdate('teams-update', {
        teamId,
        rate_limit_violations: updatedTeam.rate_limit_violations !== undefined ? updatedTeam.rate_limit_violations : Number(count) || 0
      });
    } catch (e) {}

    res.status(200).json({
      success: true,
      data: { team: updatedTeam }
    });
  } catch (error) {
    next(error);
  }
};

export const updateTeamPoints = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const { points } = req.body;
    const updatedTeam = await adminService.updateTeamPoints(teamId, Number(points));

    try {
      broadcastTelemetryUpdate('teams-update', {
        teamId,
        points: Number(points)
      });
    } catch (e) {}

    res.status(200).json({
      success: true,
      data: { team: updatedTeam }
    });
  } catch (error) {
    next(error);
  }
};

export const clearTeamDevices = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const result = await adminService.clearTeamDevices(teamId);
    try {
      broadcastTelemetryUpdate('teams-update', {
        teamId,
        team_id: teamId,
        is_logged_in: false,
        active_devices_count: 0,
        active_devices: []
      });
    } catch (e) {}
    res.status(200).json({
      success: true,
      message: 'All devices logged out for team',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PARTICIPANT ACTIVITY & SEEDING
 */
export const getActivity = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '50', 10);
    const event = req.query.event || null;
    const team_id = req.query.team_id || req.query.teamId || null;

    const result = await activityService.getActivityFeed({ page, limit, event, team_id });
    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

export const seedDatabase = async (req, res, next) => {
  try {
    db.reset();
    resetRateLimits();
    const result = await adminService.seedSampleData();
    res.status(200).json({
      success: true,
      message: 'Database reseeded successfully with teams, questions, and submission logs.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * TIME & COMPETITION CONTROL
 */
export const getCompetitionStatus = async (req, res, next) => {
  try {
    const status = await competitionService.getCompetitionStatus();
    res.status(200).json({
      success: true,
      data: status
    });
  } catch (error) {
    next(error);
  }
};

export const startCompetition = async (req, res, next) => {
  try {
    const result = await competitionService.startCompetition();
    res.status(200).json({
      success: true,
      message: 'Competition started successfully. Submissions enabled and Stage 1 timer active.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

export const stopCompetition = async (req, res, next) => {
  try {
    const result = await competitionService.stopCompetition();
    res.status(200).json({
      success: true,
      message: 'Competition stopped successfully. Submissions globally disabled.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

export const resetCompetition = async (req, res, next) => {
  try {
    const result = await competitionService.resetCompetition();
    res.status(200).json({
      success: true,
      message: 'Competition state and timer reset successfully.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};
