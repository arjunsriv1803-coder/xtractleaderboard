import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { env } from "../config/env.js";
import { Team } from "../models/Team.js";
import { TeamSession } from "../models/TeamSession.js";
import { Question } from "../models/Question.js";
import { Submission } from "../models/Submission.js";
import { ActivityLog } from "../models/ActivityLog.js";
import { logActivity } from "./activityService.js";
import { db } from "../db/database.js";
import { broadcastLeaderboardUpdate } from "./websocketService.js";
import bcrypt from "bcryptjs";
import { CANONICAL_TEAMS } from "../config/teamsConfig.js";

/**
 * Updates points for a team across both the in-memory store and MongoDB,
 * then triggers a real-time broadcast.
 */
export const updateTeamPoints = async (teamId, points) => {
  const numericPoints = Number(points);

  // 1. Update in-memory DB
  const memTeam = db.getTeamById(teamId);
  if (memTeam) {
    memTeam.score = numericPoints;
  }

  // 2. Update MongoDB persistent store
  const updatedDoc = await Team.findOneAndUpdate(
    {
      $or: [
        { team_id: teamId },
        { _id: teamId.match(/^[0-9a-fA-F]{24}$/) ? teamId : null }
      ]
    },
    { $set: { points: numericPoints } },
    { new: true }
  );

  // 3. Await broadcast AFTER DB document is written
  if (typeof broadcastLeaderboardUpdate === "function") {
    await broadcastLeaderboardUpdate();
  }

  return memTeam || updatedDoc;
};

/**
 * Computes high-level overview metrics across teams, questions, and submissions.
 */
export const getDashboardOverview = async () => {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const [
        totalTeams,
        loggedInTeams,
        rateLimitViolators,
        disqualifiedTeams,
        totalQuestions,
        totalSubmissions,
        correctSubmissions,
        allQuestions,
      ] = await Promise.all([
        Team.countDocuments({}),
        Team.countDocuments({ is_logged_in: true }),
        Team.countDocuments({ rate_limit_violations: { $gt: 0 } }),
        Team.countDocuments({ disqualified: true }),
        Question.countDocuments({}),
        Submission.countDocuments({}),
        Submission.countDocuments({ is_correct: true }),
        Question.find({}, "stage track points submitted_teams").lean(),
      ]);

      let totalSolvedInstances = 0;
      allQuestions.forEach((q) => {
        totalSolvedInstances += (q.submitted_teams || []).length;
      });

      return {
        overview: {
          totalTeams,
          loggedInTeams,
          rateLimitViolators,
          disqualifiedTeams,
          activeTeams: Math.max(0, totalTeams - disqualifiedTeams),
          totalQuestions,
          totalSubmissions,
          correctSubmissions,
          failedSubmissions: Math.max(0, totalSubmissions - correctSubmissions),
          totalSolvedInstances,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      // Fall through to in-memory fallback
    }
  }

  // Authoritative in-memory fallback if MongoDB is disconnected
  const allTeams = db.getAllTeams();
  const allProblems = db.getAllProblems();
  const allSubmissions = Array.from(db.submissions.values());
  const disqualifiedCount = allTeams.filter(t => t.disqualified).length;
  const correctSubs = allSubmissions.filter(s => s.isCorrect).length;

  return {
    overview: {
      totalTeams: allTeams.length,
      loggedInTeams: allTeams.filter(t => t.is_logged_in).length,
      rateLimitViolators: allTeams.filter(t => (t.rate_limit_violations || 0) > 0).length,
      disqualifiedTeams: disqualifiedCount,
      activeTeams: Math.max(0, allTeams.length - disqualifiedCount),
      totalQuestions: allProblems.length,
      totalSubmissions: allSubmissions.length,
      correctSubmissions: correctSubs,
      failedSubmissions: Math.max(0, allSubmissions.length - correctSubs),
      totalSolvedInstances: correctSubs,
    },
    timestamp: new Date().toISOString(),
  };
};

/**
 * SECTION 1: QUESTIONS MANAGEMENT
 */
export const getQuestionsMonitoring = async () => {
  let questions = [];
  try {
    questions = await Question.find({}).sort({ track: 1, stage: 1 }).lean();
  } catch (err) {
    // Database offline fallback
  }

  const hasMock = questions.some((q) => q.ans === 'caesar cipher' || q.ans === 'diffie-hellman');
  const canonical = db.getAllProblems();

  if (questions.length === 0 || hasMock) {
    try {
      if (hasMock) {
        await Question.deleteMany({});
      }
      for (const p of canonical) {
        await Question.findOneAndUpdate(
          { track: p.track, stage: p.stage },
          {
            $set: {
              ques: p.ques,
              title: p.title,
              ans: p.ans,
              stage: p.stage,
              track: p.track,
              points: p.points,
              nextHint: p.nextHint,
              qrToken: p.qrToken
            }
          },
          { upsert: true, new: true }
        );
      }
      questions = await Question.find({}).sort({ track: 1, stage: 1 }).lean();
    } catch (e) {
      // Return in-memory canonical questions if Mongo is unavailable
      return canonical.map((p) => ({
        _id: p.id,
        title: p.title,
        ques: p.ques,
        stage: p.stage,
        track: p.track,
        points: p.points,
        nextHint: p.nextHint,
        qrToken: p.qrToken,
        ans: p.ans,
        discoveredBy: [],
        qrscanned_teams: [],
        submitted_teams: p.submitted_teams || [],
        solvedCount: (p.submitted_teams || []).length,
      }));
    }
  }

  return questions.map((q) => ({
    _id: q._id,
    title: q.title || `Stage ${q.stage} (${['DS', 'ML', 'NLP', 'OPEN_CV'][q.stage - 1]})`,
    ques: q.ques,
    stage: q.stage,
    track: q.track,
    points: q.points,
    nextHint: q.nextHint,
    qrToken: q.qrToken,
    ans: q.ans,
    discoveredBy: q.discoveredBy || [],
    qrscanned_teams: q.qrscanned_teams || [],
    submitted_teams: q.submitted_teams || [],
    solvedCount: (q.submitted_teams || []).length,
  }));
};

export const createQuestion = async (data) => {
  const question = await Question.create({
    ques: data.ques,
    ans: data.ans || "",
    stage: Number(data.stage) || 1,
    track: Number(data.track) || 1,
    points: Number(data.points) || 100,
    nextHint: data.nextHint || "",
    discoveredBy: data.discoveredBy || [],
    qrscanned_teams: data.qrscanned_teams || [],
    submitted_teams: data.submitted_teams || [],
  });

  await logActivity({
    event: "QUESTION_CREATED",
    action: `Created new question for Stage ${question.stage}, Track ${question.track}`,
    details: question.ques,
    stage: question.stage,
    track: question.track,
  });

  return question;
};

export const updateQuestion = async (questionId, data) => {
  const question = await Question.findById(questionId);
  if (!question) {
    const error = new Error(`Question ${questionId} not found.`);
    error.statusCode = 404;
    error.code = "QUESTION_NOT_FOUND";
    throw error;
  }

  if (data.ques !== undefined) question.ques = data.ques;
  if (data.stage !== undefined) question.stage = Number(data.stage);
  if (data.track !== undefined) question.track = Number(data.track);
  if (data.points !== undefined) question.points = Number(data.points);
  if (data.nextHint !== undefined) question.nextHint = data.nextHint;
  if (data.discoveredBy !== undefined)
    question.discoveredBy = data.discoveredBy;

  if (data.ans !== undefined) question.ans = data.ans;
  if (data.title !== undefined) question.title = data.title;

  await question.save();

  // Synchronize in-memory problems
  const trackKey = ['desert', 'forest', 'volcanic', 'arctic'][question.track - 1] || 'desert';
  const probKeys = [`prob_${question.track}_${question.stage}`, `prob_${trackKey}_${question.stage}`, `prob_winter_${question.stage}`];
  for (const pk of probKeys) {
    const memProb = db.getProblemById(pk);
    if (memProb) {
      if (data.ques !== undefined) {
        memProb.ques = data.ques;
        memProb.statement = data.ques.split('\n');
      }
      if (data.ans !== undefined) memProb.ans = data.ans;
      if (data.points !== undefined) memProb.points = Number(data.points);
      if (data.title !== undefined) memProb.title = data.title;
      if (data.nextHint !== undefined) memProb.nextHint = data.nextHint;
    }
  }

  await logActivity({
    event: "QUESTION_UPDATED",
    action: `Admin updated Question (Stage ${question.stage}, Track ${question.track})`,
    details: `Updated question prompt/details.`,
    stage: question.stage,
    track: question.track,
  });

  return question;
};

export const deleteQuestion = async (questionId) => {
  const question = await Question.findByIdAndDelete(questionId);
  if (!question) {
    const error = new Error(`Question ${questionId} not found.`);
    error.statusCode = 404;
    error.code = "QUESTION_NOT_FOUND";
    throw error;
  }

  await logActivity({
    event: "QUESTION_DELETED",
    action: `Admin deleted Question ${questionId}`,
    details: question.ques,
    stage: question.stage,
    track: question.track,
  });

  return question;
};

/**
 * SECTION 2: ANSWER LOGS (SUBMISSIONS)
 */
export const getAnswerLogs = async ({
  page = 1,
  limit = 50,
  team_id = null,
  is_correct = null,
  stage = null,
  track = null,
} = {}) => {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const filter = {};
      if (team_id) filter.team_id = team_id;
      if (is_correct !== null && is_correct !== undefined && is_correct !== "") {
        filter.is_correct = String(is_correct) === "true";
      }
      if (stage) filter.stage = Number(stage);
      if (track) filter.track = Number(track);

      const skip = (Math.max(1, page) - 1) * limit;

      const [total, logs] = await Promise.all([
        Submission.countDocuments(filter),
        Submission.find(filter)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);

      return {
        logs,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (e) {
      // Fall through to in-memory fallback
    }
  }

  // In-memory fallback
  let allSubs = Array.from(db.submissions.values()).map(s => ({
    team_id: s.teamId || s.team_id,
    team_name: s.team_name || db.getTeamById(s.teamId || s.team_id)?.team_name || s.teamId,
    stage: s.stage || 1,
    track: s.track || 1,
    submitted_answer: s.answer || s.submitted_answer,
    correct_answer: s.correct_answer || '—',
    is_correct: Boolean(s.isCorrect || s.is_correct),
    is_rate_limited: Boolean(s.isRateLimited || s.is_rate_limited),
    points_awarded: s.points_awarded || 0,
    timestamp: s.timestamp || s.createdAt || new Date()
  })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (team_id) allSubs = allSubs.filter(s => s.team_id === team_id);
  if (is_correct !== null && is_correct !== undefined) allSubs = allSubs.filter(s => String(s.is_correct) === String(is_correct));

  const total = allSubs.length;
  const skip = (Math.max(1, page) - 1) * limit;
  const logs = allSubs.slice(skip, skip + limit);

  return {
    logs,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

export const recordSubmissionLog = async (data) => {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const submission = await Submission.create({
        team_id: data.team_id,
        team_name: data.team_name,
        question_id: data.question_id || null,
        question_text: data.question_text || "",
        stage: Number(data.stage) || 1,
        track: Number(data.track) || 1,
        submitted_answer: data.submitted_answer,
        correct_answer: data.correct_answer || "",
        is_correct: Boolean(data.is_correct),
        points_awarded: Number(data.points_awarded) || 0,
        is_rate_limited: Boolean(data.is_rate_limited),
        timestamp: new Date(),
      });

      await logActivity({
        event: submission.is_correct ? "ANSWER_CORRECT" : "ANSWER_WRONG",
        team_id: submission.team_id,
        team_name: submission.team_name,
        action: `Submitted answer: "${submission.submitted_answer}" (${submission.is_correct ? "Correct" : "Incorrect"})`,
        details: `Question: ${submission.question_text || "Stage " + submission.stage + " Track " + submission.track}`,
        stage: submission.stage,
        track: submission.track,
      });

      return submission;
    } catch (e) {}
  }

  return {
    team_id: data.team_id,
    team_name: data.team_name,
    is_correct: Boolean(data.is_correct),
    submitted_answer: data.submitted_answer,
    timestamp: new Date()
  };
};

/**
 * SECTION 3: TEAM DATA MANAGEMENT
 */
export const getTeamsMonitoring = async () => {
  if (mongoose.connection.readyState === 0 && env.MONGODB_URI) {
    try {
      await connectDB();
    } catch (e) {}
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const teams = await Team.find({})
        .sort({ points: -1, stage: -1, team_name: 1 })
        .lean();

      const questions = await Question.find({}, "submitted_teams").lean();
      const solvedCountMap = {};

      questions.forEach((q) => {
        (q.submitted_teams || []).forEach((sub) => {
          if (sub.team_id) {
            solvedCountMap[sub.team_id] = (solvedCountMap[sub.team_id] || 0) + 1;
          }
        });
      });

      return teams.map((team) => {
        const memTeam = db.getTeamById(team.team_id) || db.getTeamByTeamId(team.team_id);
        const memActiveCount = (memTeam && typeof db.getActiveSessionsForTeam === 'function')
          ? db.getActiveSessionsForTeam(team.team_id).length
          : 0;
        const isLoggedIn = Boolean(
          team.is_logged_in ||
          (team.active_devices && team.active_devices.length > 0) ||
          memTeam?.is_logged_in ||
          memActiveCount > 0
        );

        const activeDevices = Array.isArray(team.active_devices) ? team.active_devices : (memTeam?.active_devices || []);
        const activeDevicesCount = activeDevices.length || memActiveCount || (isLoggedIn ? 1 : 0);

        return {
          ...team,
          is_logged_in: isLoggedIn,
          active_devices_count: activeDevicesCount,
          active_devices: activeDevices,
          rate_limit_violations: team.rate_limit_violations ?? memTeam?.rate_limit_violations ?? 0,
          password: team.password || memTeam?.plainPassword || 'Password123!',
          solvedCount: solvedCountMap[team.team_id] || 0,
        };
      });
    } catch (e) {
      console.error('[AdminService] Mongo getTeamsMonitoring error:', e);
    }
  }

  // Authoritative in-memory fallback
  const memTeams = db.getAllTeams();
  return memTeams.map((team) => {
    const memActiveCount = typeof db.getActiveSessionsForTeam === 'function'
      ? db.getActiveSessionsForTeam(team.team_id || team.id).length
      : 0;
    const isLoggedIn = Boolean(
      team.is_logged_in ||
      (team.active_devices && team.active_devices.length > 0) ||
      memActiveCount > 0
    );

    const activeDevices = Array.isArray(team.active_devices) ? team.active_devices : [];
    const activeDevicesCount = activeDevices.length || memActiveCount || (isLoggedIn ? 1 : 0);

    return {
      team_id: team.team_id || team.id,
      team_name: team.team_name || team.name,
      points: team.points || team.score || 0,
      stage: team.stage || 1,
      track: team.track,
      trackConfirmed: Boolean(team.trackConfirmed),
      disqualified: Boolean(team.disqualified),
      is_logged_in: isLoggedIn,
      active_devices_count: activeDevicesCount,
      active_devices: activeDevices,
      rate_limit_violations: team.rate_limit_violations || 0,
      password: team.plainPassword || 'Password123!',
      solvedCount: Object.keys(team.stageProgress || {}).length
    };
  });
};

export const deleteTeam = async (teamId) => {
  let team = null;
  const canonicalTeamId = String(teamId).trim().toUpperCase();

  if (mongoose.connection.readyState === 0 && env.MONGODB_URI) {
    try {
      await connectDB();
    } catch (e) {}
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      team = await Team.findOneAndDelete({
        $or: [
          { team_id: teamId },
          { team_id: canonicalTeamId },
          { _id: teamId.match(/^[0-9a-fA-F]{24}$/) ? teamId : null },
        ],
      });

      if (team) {
        await Question.updateMany(
          {},
          {
            $pull: {
              submitted_teams: { team_id: team.team_id },
              qrscanned_teams: { team_id: team.team_id },
              discoveredBy: team.team_id,
            },
          },
        );
      }
    } catch (e) {
      console.error('[AdminService] Mongo deleteTeam error:', e);
    }
  }

  const memTeam = db.getTeamById(canonicalTeamId) || db.getTeamById(teamId);
  if (memTeam) {
    db.teams.delete(canonicalTeamId);
    db.teams.delete(teamId);
  }

  if (!team && !memTeam) {
    const error = new Error(`Team ${teamId} not found.`);
    error.statusCode = 404;
    error.code = "TEAM_NOT_FOUND";
    throw error;
  }

  const resultTeam = team ? team.toObject() : { ...memTeam };

  await logActivity({
    event: "TEAM_DELETED",
    team_id: resultTeam.team_id || canonicalTeamId,
    team_name: resultTeam.team_name,
    action: `Admin deleted team ${resultTeam.team_name} (${resultTeam.team_id})`,
    details: `Team removed from database and leaderboards.`,
  });

  if (typeof broadcastLeaderboardUpdate === "function") {
    broadcastLeaderboardUpdate();
  }
  return resultTeam;
};

export const toggleTeamDisqualification = async (teamId, disqualified) => {
  let team = null;
  const canonicalTeamId = String(teamId).trim().toUpperCase();
  const isDisqualified = Boolean(disqualified);

  if (mongoose.connection.readyState === 0 && env.MONGODB_URI) {
    try {
      await connectDB();
    } catch (e) {}
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      team = await Team.findOne({
        $or: [
          { team_id: teamId },
          { team_id: canonicalTeamId },
          { _id: teamId.match(/^[0-9a-fA-F]{24}$/) ? teamId : null },
        ],
      });

      if (team) {
        team.disqualified = isDisqualified;
        await team.save();
      }
    } catch (e) {
      console.error('[AdminService] Mongo toggleTeamDisqualification error:', e);
    }
  }

  // Update in-memory DB (authoritative fallback)
  const memTeam = db.getTeamById(canonicalTeamId) || db.getTeamById(teamId) || db.getTeamByTeamId(teamId);
  if (memTeam) {
    memTeam.disqualified = isDisqualified;
  }

  if (!team && !memTeam) {
    const error = new Error(`Team ${teamId} not found.`);
    error.statusCode = 404;
    error.code = "TEAM_NOT_FOUND";
    throw error;
  }

  const resultTeam = team ? team.toObject() : { ...memTeam };
  resultTeam.disqualified = isDisqualified;

  try {
    await logActivity({
      event: isDisqualified ? "TEAM_DISQUALIFIED" : "TEAM_REQUALIFIED",
      team_id: resultTeam.team_id || canonicalTeamId,
      team_name: resultTeam.team_name,
      action: isDisqualified
        ? `Team disqualified by administrator`
        : `Team reinstated by administrator`,
      details: `Team ${resultTeam.team_name} (${resultTeam.team_id}) status changed to ${isDisqualified ? "Disqualified" : "Active"}`,
      stage: resultTeam.stage,
      track: resultTeam.track,
    });
  } catch (e) {}

  if (typeof broadcastLeaderboardUpdate === "function") {
    try {
      broadcastLeaderboardUpdate();
    } catch (e) {}
  }
  return resultTeam;
};

export const updateTeamRateLimit = async (teamId, count) => {
  let team = null;
  const canonicalTeamId = String(teamId).trim().toUpperCase();
  const numericCount = Math.max(0, Number(count) || 0);

  if (mongoose.connection.readyState === 0 && env.MONGODB_URI) {
    try {
      await connectDB();
    } catch (e) {}
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      team = await Team.findOne({
        $or: [
          { team_id: teamId },
          { team_id: canonicalTeamId },
          { _id: teamId.match(/^[0-9a-fA-F]{24}$/) ? teamId : null },
        ],
      });

      if (team) {
        team.rate_limit_violations = numericCount;
        await team.save();
      }
    } catch (e) {
      console.error('[AdminService] Mongo updateTeamRateLimit error:', e);
    }
  }

  const memTeam = db.getTeamById(canonicalTeamId) || db.getTeamById(teamId) || db.getTeamByTeamId(teamId);
  if (memTeam) {
    memTeam.rate_limit_violations = numericCount;
  }

  if (!team && !memTeam) {
    const error = new Error(`Team ${teamId} not found.`);
    error.statusCode = 404;
    error.code = "TEAM_NOT_FOUND";
    throw error;
  }

  const resultTeam = team ? team.toObject() : { ...memTeam };
  resultTeam.rate_limit_violations = numericCount;
  return resultTeam;
};

export const clearTeamDevices = async (teamId) => {
  const canonicalTeamId = String(teamId).trim().toUpperCase();
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await Team.updateOne(
        { team_id: canonicalTeamId },
        { $set: { active_devices: [], is_logged_in: false } }
      );
      await TeamSession.updateMany(
        { team_id: canonicalTeamId },
        { $set: { is_revoked: true } }
      );
    } catch (e) {
      console.error('[AdminService] clearTeamDevices Mongo error:', e.message);
    }
  }

  const memTeam = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId);
  if (memTeam) {
    memTeam.active_devices = [];
    memTeam.is_logged_in = false;
  }
  if (typeof db.revokeAllSessionsForTeam === 'function') {
    db.revokeAllSessionsForTeam(canonicalTeamId);
  }

  return { success: true, team_id: canonicalTeamId };
};

/**
 * DATABASE SEEDING
 */
export const seedSampleData = async () => {
  // 1. Drop existing indexes safely
  try {
    await Team.collection.dropIndexes();
  } catch (e) {}
  try {
    await Question.collection.dropIndexes();
  } catch (e) {}
  try {
    await Submission.collection.dropIndexes();
  } catch (e) {}

  // 2. Reset in-memory database
  if (db && typeof db.reset === "function") {
    db.reset();
  }

  // 3. Reset competition run state (Submissions, Sessions, ActivityLog)
  await Submission.deleteMany({});
  await ActivityLog.deleteMany({});

  // Reset Question progression (scans and solves) while preserving actual questions in DB
  await Question.updateMany({}, {
    $set: {
      submitted_teams: [],
      qrscanned_teams: [],
      discoveredBy: []
    }
  });

  // If CANONICAL_TEAMS is provided, re-seed them; otherwise reset existing teams to initial state
  const sampleTeams = (CANONICAL_TEAMS || []).map((t) => ({
    team_id: t.team_id,
    team_name: t.team_name,
    password: bcrypt.hashSync(t.password, 10),
    track: t.track !== undefined ? t.track : -1,
    stage: t.stage || 1,
    points: t.points || 0,
    role: "team",
    stage_start_time: t.trackConfirmed ? new Date(Date.now() - 45 * 60 * 1000) : null,
    disqualified: !!t.disqualified,
    is_logged_in: false,
    rate_limit_violations: 0,
  }));

  let createdTeams = [];
  if (sampleTeams.length > 0) {
    await Team.deleteMany({});
    try {
      createdTeams = await Team.insertMany(sampleTeams);
    } catch (err) {
      if (err.code === 11000 || err.name === 'MongoBulkWriteError') {
        createdTeams = await Team.find({});
      } else {
        throw err;
      }
    }
  } else {
    // Reset existing database teams to initial state without deleting them
    await Team.updateMany({}, {
      $set: {
        track: -1,
        stage: 1,
        points: 0,
        trackConfirmed: false,
        pathAssigned: null,
        stage_start_time: null,
        is_logged_in: false,
        active_devices: [],
        rate_limit_violations: 0,
        stageProgress: {}
      }
    });
    createdTeams = await Team.find({});
  }

  const createdQuestions = await Question.find({});

  // 7. Seed Activities (System initialized log)
  const sampleActivities = [
    {
      event: "SYSTEM_INITIALIZED",
      team_id: null,
      team_name: null,
      action: "Competition environment initialized",
      details: "All 28 teams and canonical tracks loaded in fresh state.",
      stage: null,
      track: null,
      timestamp: new Date()
    }
  ];

  await ActivityLog.insertMany(sampleActivities);

  if (typeof broadcastLeaderboardUpdate === "function") {
    broadcastLeaderboardUpdate();
  }

  return {
    teamsCount: createdTeams.length,
    questionsCount: createdQuestions.length,
    submissionsCount: createdSubmissions.length,
    activitiesCount: sampleActivities.length,
  };
};