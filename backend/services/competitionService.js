import mongoose from 'mongoose';
import { CompetitionState } from '../models/CompetitionState.js';
import { Team as TeamModel } from '../models/Team.js';
import db from '../db/database.js';
import { connectDB } from '../config/db.js';
import { logActivity } from './activityService.js';
import { broadcastTelemetryUpdate, broadcastAdminActivity } from '../sockets/socketManager.js';
import { getAllStageConfig } from '../config/stageConfig.js';

export const getCompetitionStatus = async () => {
  if (mongoose.connection.readyState === 0 && process.env.MONGODB_URI) {
    try { await connectDB(); } catch (e) {}
  }

  let mongoState = null;
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      mongoState = await CompetitionState.findOne({ key: 'global' }).lean();
      if (mongoState) {
        db.setCompetitionState({
          isRunning: Boolean(mongoState.isRunning),
          startTime: mongoState.startTime ? new Date(mongoState.startTime) : null,
          stoppedAt: mongoState.stoppedAt ? new Date(mongoState.stoppedAt) : null
        });
      }
    } catch (e) {
      console.error('[CompetitionService] Error fetching state from Mongo:', e.message);
    }
  }

  const state = db.getCompetitionState();
  const stagesConfig = getAllStageConfig();

  return {
    isRunning: Boolean(state.isRunning),
    startTime: state.startTime || null,
    stoppedAt: state.stoppedAt || null,
    stageConfig: stagesConfig,
    now: new Date().toISOString()
  };
};

export const startCompetition = async () => {
  if (mongoose.connection.readyState === 0 && process.env.MONGODB_URI) {
    try { await connectDB(); } catch (e) {}
  }

  const existing = db.getCompetitionState();
  const startTime = existing.startTime || new Date();
  const now = new Date();

  // 1. Update in-memory DB
  db.setCompetitionState({
    isRunning: true,
    startTime: startTime,
    stoppedAt: null
  });

  for (const team of db.teams.values()) {
    if (!team.stage_start_time) {
      team.stage_start_time = startTime;
    }
  }

  // 2. Persist to MongoDB
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await CompetitionState.findOneAndUpdate(
        { key: 'global' },
        {
          $set: {
            isRunning: true,
            startTime: startTime,
            stoppedAt: null,
            updatedBy: 'admin'
          }
        },
        { upsert: true, new: true }
      );

      await TeamModel.updateMany(
        { stage_start_time: null },
        { $set: { stage_start_time: startTime } }
      );
    } catch (e) {
      console.error('[CompetitionService] Error saving start state in Mongo:', e.message);
    }
  }

  // 3. Log Activity
  try {
    const act = await logActivity({
      event: 'COMPETITION_STARTED',
      action: 'Administrator started the competition',
      details: `Competition enabled at ${now.toISOString()}. Stage 1 threshold timer active.`
    });
    if (act) broadcastAdminActivity(act);
  } catch (e) {}

  // 4. Real-time Telemetry Broadcast
  const payload = {
    isRunning: true,
    startTime: startTime,
    stoppedAt: null,
    timestamp: now.toISOString()
  };
  broadcastTelemetryUpdate('competition-update', payload);

  return payload;
};

export const stopCompetition = async () => {
  if (mongoose.connection.readyState === 0 && process.env.MONGODB_URI) {
    try { await connectDB(); } catch (e) {}
  }

  const now = new Date();
  const existing = db.getCompetitionState();

  // 1. Update in-memory DB
  db.setCompetitionState({
    isRunning: false,
    stoppedAt: now
  });

  // 2. Persist to MongoDB
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await CompetitionState.findOneAndUpdate(
        { key: 'global' },
        {
          $set: {
            isRunning: false,
            stoppedAt: now,
            updatedBy: 'admin'
          }
        },
        { upsert: true, new: true }
      );
    } catch (e) {
      console.error('[CompetitionService] Error saving stop state in Mongo:', e.message);
    }
  }

  // 3. Log Activity
  try {
    const act = await logActivity({
      event: 'COMPETITION_STOPPED',
      action: 'Administrator stopped/paused the competition',
      details: `Submissions globally disabled at ${now.toISOString()}.`
    });
    if (act) broadcastAdminActivity(act);
  } catch (e) {}

  // 4. Real-time Telemetry Broadcast
  const payload = {
    isRunning: false,
    startTime: existing.startTime || null,
    stoppedAt: now,
    timestamp: now.toISOString()
  };
  broadcastTelemetryUpdate('competition-update', payload);

  return payload;
};

export const resetCompetition = async () => {
  if (mongoose.connection.readyState === 0 && process.env.MONGODB_URI) {
    try { await connectDB(); } catch (e) {}
  }

  const now = new Date();

  // 1. Update in-memory DB
  db.setCompetitionState({
    isRunning: false,
    startTime: null,
    stoppedAt: null
  });

  for (const team of db.teams.values()) {
    team.stage_start_time = null;
  }

  // 2. Persist to MongoDB
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await CompetitionState.findOneAndUpdate(
        { key: 'global' },
        {
          $set: {
            isRunning: false,
            startTime: null,
            stoppedAt: null,
            updatedBy: 'admin'
          }
        },
        { upsert: true, new: true }
      );

      await TeamModel.updateMany(
        {},
        { $set: { stage_start_time: null } }
      );
    } catch (e) {
      console.error('[CompetitionService] Error resetting state in Mongo:', e.message);
    }
  }

  // 3. Log Activity
  try {
    const act = await logActivity({
      event: 'COMPETITION_RESET',
      action: 'Administrator reset the competition timer',
      details: `Competition state and Stage 1 timer reset at ${now.toISOString()}.`
    });
    if (act) broadcastAdminActivity(act);
  } catch (e) {}

  // 4. Real-time Telemetry Broadcast
  const payload = {
    isRunning: false,
    startTime: null,
    stoppedAt: null,
    timestamp: now.toISOString()
  };
  broadcastTelemetryUpdate('competition-update', payload);

  return payload;
};

export default {
  getCompetitionStatus,
  startCompetition,
  stopCompetition,
  resetCompetition
};
