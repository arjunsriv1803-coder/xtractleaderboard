import mongoose from 'mongoose';
import db from '../db/database.js';
import { Team as TeamModel } from '../models/Team.js';
import { TrackCapacity as TrackCapacityModel } from '../models/TrackCapacity.js';
import { Question as QuestionModel } from '../models/Question.js';

/**
 * Get all 4 tracks.
 * Participant view: Never exposes remaining capacity, current teams count, or competitor lists.
 */
export const getAllPaths = (req, res) => {
  try {
    const paths = db.getAllPaths();

    res.json({
      paths: paths.map((path) => ({
        id: path.id,
        name: path.name,
        trackNumber: path.trackNumber,
        envelope: path.envelope
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Operational stats for administrators.
 */
export const getPathStats = (req, res) => {
  try {
    const stats = db.getPathStats();

    res.json({
      totalPaths: 4,
      maxTeamsPerPath: 7,
      stats: stats
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const assignTeamToPath = async (req, res) => {
  try {
    const { teamId, pathName } = req.body;
    const userId = req.userId;
    const authenticatedTeamId = req.user?.teamId;

    if (!teamId || !pathName) {
      return res.status(400).json({ error: 'Team ID and path name are required' });
    }

    if (authenticatedTeamId && teamId !== authenticatedTeamId && req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden: You cannot assign paths for another team.' });
    }

    const team = db.getTeamById(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (team.leaderId !== userId && team.id !== userId && team.team_id !== authenticatedTeamId) {
      return res.status(403).json({ error: 'Only team leader can assign path' });
    }

    // ── Security fix: Prevent self-lock without solving Stage 1 ──────────────
    // A team must have already solved Stage 1 (DS) before it can lock into a
    // track. Without this check any team could POST to this endpoint to claim a
    // slot on a track without answering anything, freezing other teams out.
    const hasStage1 = !!(team.stageProgress && team.stageProgress['1']);
    if (!hasStage1) {
      return res.status(403).json({
        error: 'STAGE_REQUIRED',
        message: 'You must solve Stage 1 (DS) before locking into a track.'
      });
    }

    const path = db.getPathByName(pathName);
    if (!path) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const result = db.confirmTeamTrack(teamId, path.name);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const canonicalTeamId = String(team.team_id || team.id || teamId).trim().toUpperCase();
      try {
        await TeamModel.findOneAndUpdate(
          { team_id: canonicalTeamId },
          {
            $set: {
              track: path.trackNumber,
              pathAssigned: path.name,
              trackConfirmed: true
            }
          }
        );
        await TrackCapacityModel.findOneAndUpdate(
          {
            track_name: path.name,
            $or: [
              { claimed_teams: canonicalTeamId },
              { 'claimed_teams.6': { $exists: false } }
            ]
          },
          {
            $setOnInsert: { track_number: path.trackNumber, max_teams: 7 },
            $addToSet: { claimed_teams: canonicalTeamId }
          },
          { upsert: true, new: true }
        );
      } catch (e) {
        console.error('[PathController] Failed to persist track assignment to MongoDB:', e.message);
      }
    }

    res.json({
      message: result.message,
      team: {
        id: team.id,
        name: team.name,
        pathAssigned: team.pathAssigned
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getPathByName = (req, res) => {
  try {
    const { pathName } = req.params;
    const path = db.getPathByName(pathName);

    if (!path) {
      return res.status(404).json({ error: 'Path not found' });
    }

    res.json({
      path: {
        id: path.id,
        name: path.name,
        trackNumber: path.trackNumber,
        envelope: path.envelope
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getPathQuestions = async (req, res) => {
  try {
    const { pathName } = req.params;
    const teamId = req.user?.teamId;
    const userRole = req.user?.role;

    if (!pathName) {
      return res.status(400).json({ error: 'Track name is required' });
    }

    const cleanName = String(pathName).trim().toLowerCase();
    const TRACK_NUM_MAP = {
      autumn: 1,
      forest: 2,
      harvest: 3,
      winter: 4
    };
    const trackNum = TRACK_NUM_MAP[cleanName];
    const path = db.getPathByName(cleanName) || (trackNum ? db.getAllPaths().find((p) => p.trackNumber === trackNum) : null);

    if (!path && !trackNum) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const canonicalTrackName = path ? path.name : (cleanName.charAt(0).toUpperCase() + cleanName.slice(1));
    const canonicalTrackNum = trackNum || (path ? path.trackNumber : 1);

    // Fetch team
    let team = null;
    if (teamId) {
      const canonicalTeamId = String(teamId).trim().toUpperCase();
      team = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId);
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          const mongoTeam = await TeamModel.findOne({ team_id: canonicalTeamId }).lean();
          if (mongoTeam) {
            team = { ...(team || {}), ...mongoTeam };
          }
        } catch (e) {}
      }
    }

    // Determine accessible problems
    let accessible = [];
    if (userRole === 'ADMIN') {
      accessible = db.getProblemsByTrack(canonicalTrackName);
    } else {
      accessible = db.getVisibleProblems(team, canonicalTrackName);
    }

    // Pull latest question statements and titles from MongoDB if available
    let mongoQuestionsMap = new Map();
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        const docs = await QuestionModel.find({ track: canonicalTrackNum }).lean();
        for (const doc of docs) {
          mongoQuestionsMap.set(doc.stage, doc);
        }
      } catch (e) {}
    }

    // Security sanitization: NEVER expose ans, acceptedAnswers, or qrToken!
    const sanitized = accessible.map((p) => {
      const mongoDoc = mongoQuestionsMap.get(p.stage);
      const quesText = mongoDoc?.ques || p.ques || '';
      const title = mongoDoc?.title || p.title || `Stage ${p.stage}`;
      const statement = quesText ? quesText.split('\n') : (p.statement || []);

      return {
        id: p.id,
        problemId: p.id,
        trackName: p.trackName,
        track: p.track,
        stage: p.stage,
        order: p.order || p.stage,
        code: p.code,
        title,
        statement,
        ques: quesText,
        points: mongoDoc?.points || p.points || 100,
        qrScanned: Boolean(p.qrScanned)
      };
    });

    res.json({
      success: true,
      track: canonicalTrackName.toLowerCase(),
      trackNumber: canonicalTrackNum,
      questions: sanitized
    });
  } catch (err) {
    console.error('[PathController] getPathQuestions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export default { getAllPaths, getPathStats, assignTeamToPath, getPathByName, getPathQuestions };
