import mongoose from 'mongoose';
import db from '../db/database.js';
import { Team as TeamModel } from '../models/Team.js';

/**
 * Team Creation by participants is disabled.
 * All 28 teams are seeded and pre-assigned.
 */
export const createTeam = (req, res) => {
  return res.status(403).json({
    error: 'REGISTRATION_CLOSED',
    message: 'Participant team creation is disabled. Competition teams are pre-assigned.'
  });
};

/**
 * Retrieve the verified team belonging to the authenticated session.
 */
export const getMyTeams = async (req, res) => {
  try {
    const teamId = req.user?.teamId || req.userId;
    let team = db.getTeamById(teamId) || db.getTeamByTeamId(teamId);

    if (mongoose.connection && mongoose.connection.readyState === 1 && teamId) {
      try {
        const canonicalId = (team?.team_id || team?.id || teamId).toUpperCase();
        const mongoTeam = await TeamModel.findOne({ team_id: canonicalId }).lean();
        if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
          team = db.syncTeamFromMongo(mongoTeam) || team;
        }
      } catch (e) {}
    }

    if (!team) {
      return res.status(404).json({ error: 'No team associated with this session' });
    }

    const teamPayload = {
      id: team.team_id || team.id,
      team_id: team.team_id || team.id,
      name: team.team_name || team.name,
      leaderId: team.leaderId,
      members: team.members,
      pathAssigned: team.pathAssigned,
      trackConfirmed: team.trackConfirmed,
      score: team.score || team.points || 0,
      points: team.points || team.score || 0,
      stageProgress: team.stageProgress,
      createdAt: team.createdAt
    };

    res.json({
      teams: [teamPayload]
    });
  } catch (err) {
    console.error('[TeamController] getMyTeams Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getTeamById = async (req, res) => {
  try {
    const { teamId } = req.params;
    const authenticatedTeamId = req.user?.teamId;

    if (authenticatedTeamId && teamId !== authenticatedTeamId && req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden: You cannot inspect another team\'s state.' });
    }

    let team = db.getTeamById(teamId) || db.getTeamByTeamId(teamId);

    if (mongoose.connection && mongoose.connection.readyState === 1 && teamId) {
      try {
        const canonicalId = (team?.team_id || team?.id || teamId).toUpperCase();
        const mongoTeam = await TeamModel.findOne({ team_id: canonicalId }).lean();
        if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
          team = db.syncTeamFromMongo(mongoTeam) || team;
        }
      } catch (e) {}
    }
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json({
      team: {
        id: team.team_id || team.id,
        team_id: team.team_id || team.id,
        name: team.team_name || team.name,
        leaderId: team.leaderId,
        members: team.members,
        pathAssigned: team.pathAssigned,
        trackConfirmed: team.trackConfirmed,
        score: team.score || team.points || 0,
        points: team.points || team.score || 0,
        stageProgress: team.stageProgress,
        createdAt: team.createdAt
      }
    });
  } catch (err) {
    console.error('[TeamController] getTeamById Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getAllTeams = (req, res) => {
  try {
    const teams = db.getAllTeams();
    res.json({
      teams: teams.map(t => ({
        id: t.team_id || t.id,
        team_id: t.team_id || t.id,
        name: t.team_name || t.name,
        track: t.track,
        stage: t.stage,
        score: t.score || t.points || 0,
        points: t.points || t.score || 0,
        pathAssigned: t.pathAssigned,
        trackConfirmed: t.trackConfirmed,
        disqualified: t.disqualified
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const addMember = (req, res) => {
  return res.status(403).json({
    error: 'MEMBERSHIP_LOCKED',
    message: 'Team membership is fixed by tournament administrators.'
  });
};

export const addTeamMember = addMember;

export default { createTeam, getMyTeams, getTeamById, getAllTeams, addMember, addTeamMember };
