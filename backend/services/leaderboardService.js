import mongoose from 'mongoose';
import Team from '../models/Team.js';
import Question from '../models/Question.js';
import Submission from '../models/Submission.js';
import db from '../db/database.js';

const TRACK_NAMES = {
  1: 'Desert',
  2: 'Forest',
  3: 'Volcanic',
  4: 'Arctic'
};

/**
 * Calculates authoritative leaderboard directly from MongoDB (single source of truth).
 * Deterministic ranking rules:
 * 1. Active teams rank ahead of disqualified teams.
 * 2. Higher points rank first.
 * 3. Teams with identical points are ranked by earliest submission timestamp.
 * 4. Alphabetical tie-breaker.
 */
export const getAuthoritativeLeaderboard = async () => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return (typeof db.getLeaderboard === 'function' ? db.getLeaderboard() : []);
    }

    // 1. Fetch all teams from MongoDB (exclude sensitive fields like passwords)
    const teams = await Team.find(
      {},
      'team_id team_name points stage track disqualified createdAt updatedAt'
    ).lean();

    if (!teams || teams.length === 0) {
      // In case MongoDB collection is momentarily unseeded, fallback to in-memory db
      return (typeof db.getLeaderboard === 'function' ? db.getLeaderboard() : []);
    }

    // 2. Fetch solved questions to compute solvedCount & first/last submission timestamps
    const questions = await Question.find({}, 'track stage submitted_teams').lean();
    const solvedCountMap = {};
    const lastSolvedAtMap = {};
    const firstSubmissionAtMap = {};

    questions.forEach((q) => {
      (q.submitted_teams || []).forEach((sub) => {
        if (sub.team_id) {
          const tid = sub.team_id.toUpperCase();
          solvedCountMap[tid] = (solvedCountMap[tid] || 0) + 1;
          const ts = sub.timestamp ? new Date(sub.timestamp).getTime() : 0;
          if (ts > (lastSolvedAtMap[tid] || 0)) {
            lastSolvedAtMap[tid] = ts;
          }
          if (ts > 0 && (firstSubmissionAtMap[tid] === undefined || ts < firstSubmissionAtMap[tid])) {
            firstSubmissionAtMap[tid] = ts;
          }
        }
      });
    });

    // Also check Submission model to catch any submissions
    try {
      const submissions = await Submission.find({}, 'team_id timestamp').lean();
      submissions.forEach((sub) => {
        if (sub.team_id && sub.timestamp) {
          const tid = sub.team_id.toUpperCase();
          const ts = new Date(sub.timestamp).getTime();
          if (ts > 0 && (firstSubmissionAtMap[tid] === undefined || ts < firstSubmissionAtMap[tid])) {
            firstSubmissionAtMap[tid] = ts;
          }
        }
      });
    } catch (e) {
      // Fallback silently if Submission collection query fails
    }

    // 3. Map into clean leaderboard representations
    const mapped = teams.map((team) => {
      const upperId = (team.team_id || '').toUpperCase();
      const solvedCount = solvedCountMap[upperId] || 0;
      const lastSolvedAt = lastSolvedAtMap[upperId] || null;
      const firstSubmissionAt = firstSubmissionAtMap[upperId] ? new Date(firstSubmissionAtMap[upperId]).toISOString() : null;
      const numericTrack = Number(team.track);
      const pointsNum = typeof team.points === 'number' ? team.points : (Number(team.points) || 0);

      return {
        teamId: team.team_id,
        teamName: team.team_name,
        name: team.team_name,
        points: pointsNum,
        score: pointsNum,
        stage: Number(team.stage) || 1,
        track: numericTrack,
        trackName: TRACK_NAMES[numericTrack] || null,
        solvedCount,
        stagesCompleted: solvedCount,
        disqualified: Boolean(team.disqualified),
        status: team.disqualified ? 'DISQUALIFIED' : 'ACTIVE',
        lastSolvedAt,
        firstSubmissionAt
      };
    });

    // 4. Deterministic Sort:
    // Rule 1: Non-disqualified before Disqualified
    // Rule 2: Highest points first
    // Rule 3: For tied points, earlier submission first
    // Rule 4: Alphabetical tie-breaker
    mapped.sort((a, b) => {
      if (a.disqualified !== b.disqualified) {
        return a.disqualified ? 1 : -1;
      }

      if (b.points !== a.points) {
        return b.points - a.points;
      }

      const tsA = a.firstSubmissionAt ? new Date(a.firstSubmissionAt).getTime() : (a.lastSolvedAt ? new Date(a.lastSolvedAt).getTime() : null);
      const tsB = b.firstSubmissionAt ? new Date(b.firstSubmissionAt).getTime() : (b.lastSolvedAt ? new Date(b.lastSolvedAt).getTime() : null);

      if (tsA !== null && tsB !== null) {
        if (tsA !== tsB) return tsA - tsB;
      }
      if (tsA !== null && tsB === null) return -1;
      if (tsA === null && tsB !== null) return 1;

      return (a.teamName || '').localeCompare(b.teamName || '');
    });

    // 5. Assign 1-based ranks
    return mapped.map((team, idx) => ({
      rank: idx + 1,
      ...team
    }));
  } catch (error) {
    console.error('[LeaderboardService] Error fetching leaderboard from MongoDB:', error.message);
    return typeof db.getLeaderboard === 'function' ? db.getLeaderboard() : [];
  }
};

export default { getAuthoritativeLeaderboard };
