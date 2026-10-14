import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import db from '../db/database.js';
import { Team as TeamModel } from '../models/Team.js';
import { Question as QuestionModel } from '../models/Question.js';
import { QRRedemption as QRRedemptionModel } from '../models/QRRedemption.js';
import { CompetitionState as CompetitionStateModel } from '../models/CompetitionState.js';
import { getIO, ADMIN_ROOM } from '../sockets/socketManager.js';
import { logActivity } from '../services/activityService.js';
import { broadcastAdminActivity } from '../sockets/socketManager.js';
import { generateScanProof, verifyAndConsumeScanProof } from '../utils/qrProof.js';
import { generateToken } from '../utils/jwt.js';
import { resolveQRToken } from '../utils/qrHash.js';

const comparePassword = async (plainPassword, hashedPassword) => {
  if (!plainPassword || !hashedPassword) return false;
  return bcrypt.compare(plainPassword, hashedPassword);
};

export const TRACK_NAMES = {
  1: 'Desert',
  2: 'Forest',
  3: 'Volcanic',
  4: 'Arctic'
};

export const TRACK_MAP = {
  DESERT: { id: 'desert', name: 'Desert', num: 1 },
  HARVEST: { id: 'desert', name: 'Desert', num: 1 },
  FOREST: { id: 'forest', name: 'Forest', num: 2 },
  VOLCANIC: { id: 'volcanic', name: 'Volcanic', num: 3 },
  VOLCANINC: { id: 'volcanic', name: 'Volcanic', num: 3 },
  AUTUMN: { id: 'volcanic', name: 'Volcanic', num: 3 },
  ARCTIC: { id: 'arctic', name: 'Arctic', num: 4 },
  WINTER: { id: 'arctic', name: 'Arctic', num: 4 },
  ALL: { id: 'all', name: 'All Tracks', num: 0 },
  COMMON: { id: 'common', name: 'All Tracks', num: 0 }
};

export const STAGE_MAP = {
  DS: { stage: 1, code: 'DS', name: 'Data Science (DS)' },
  ML: { stage: 2, code: 'ML', name: 'Machine Learning (ML)' },
  NLP: { stage: 3, code: 'NLP', name: 'Natural Language Processing (NLP)' },
  CV: { stage: 4, code: 'CV', name: 'Computer Vision (OPEN_CV)' },
  OPENCV: { stage: 4, code: 'OPENCV', name: 'Computer Vision (OPEN_CV)' },
  OPEN_CV: { stage: 4, code: 'OPENCV', name: 'Computer Vision (OPEN_CV)' }
};

// Concurrency mutex lock per team to make redemption atomic
const teamRedemptionLocks = new Map();

const acquireRedemptionLock = async (teamId) => {
  const timeout = Date.now() + 5000;
  while (teamRedemptionLocks.get(teamId)) {
    if (Date.now() > timeout) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  teamRedemptionLocks.set(teamId, true);
};

const releaseRedemptionLock = (teamId) => {
  teamRedemptionLocks.delete(teamId);
};

const isCompetitionActive = async () => {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const compDoc = await CompetitionStateModel.findOne({ key: 'global' }).lean();
      if (compDoc) {
        db.setCompetitionState({
          isRunning: Boolean(compDoc.isRunning),
          startTime: compDoc.startTime,
          stoppedAt: compDoc.stoppedAt
        });
        return Boolean(compDoc.isRunning);
      }
    } catch (e) {}
  }

  const memState = db.getCompetitionState ? db.getCompetitionState() : null;
  return Boolean(memState?.isRunning);
};

/**
 * Validates and parses a physical QR token (hashed or canonical).
 */
export const parseQRToken = (token) => {
  if (!token || typeof token !== 'string') return null;
  const clean = token.trim();

  // 1. Resolve via cryptographic hash map or canonical mapping
  const resolved = resolveQRToken(clean);
  if (resolved) {
    const trackInfo = TRACK_MAP[resolved.track] || TRACK_MAP.ALL;
    const stageInfo = STAGE_MAP[resolved.stage] || STAGE_MAP.CV;
    if (trackInfo && stageInfo) {
      return {
        token: resolved.hash,
        canonicalToken: resolved.canonical,
        hash: resolved.hash,
        trackNum: trackInfo.num,
        trackName: trackInfo.name,
        trackId: trackInfo.id,
        stageNum: stageInfo.stage,
        stageCode: stageInfo.code,
        stageName: stageInfo.name
      };
    }
  }

  // 2. Fallback for custom / legacy tokens
  const cleanUpper = clean.toUpperCase();
  if (cleanUpper === 'QR-CV' || cleanUpper === 'QR-ALL-CV' || cleanUpper === 'QR-COMMON-CV' || cleanUpper === 'QR-OPENCV') {
    return {
      token: cleanUpper,
      canonicalToken: 'QR-CV',
      hash: null,
      trackNum: 0,
      trackName: 'All Tracks',
      trackId: 'all',
      stageNum: 4,
      stageCode: 'CV',
      stageName: 'Computer Vision (OPEN_CV)'
    };
  }

  const parts = cleanUpper.split('-');
  if (parts.length >= 2 && parts[0] === 'QR') {
    if (parts.length === 2 && (parts[1] === 'CV' || parts[1] === 'OPENCV')) {
      return {
        token: cleanUpper,
        canonicalToken: 'QR-CV',
        hash: null,
        trackNum: 0,
        trackName: 'All Tracks',
        trackId: 'all',
        stageNum: 4,
        stageCode: 'CV',
        stageName: 'Computer Vision (OPEN_CV)'
      };
    }

    const trackKey = parts[1];
    const stageKey = parts.slice(2).join('_');

    const trackInfo = TRACK_MAP[trackKey];
    const stageInfo = STAGE_MAP[stageKey] || STAGE_MAP[parts[2]];

    if (!trackInfo || !stageInfo) return null;

    return {
      token: cleanUpper,
      canonicalToken: cleanUpper,
      hash: null,
      trackNum: trackInfo.num,
      trackName: trackInfo.name,
      trackId: trackInfo.id,
      stageNum: stageInfo.stage,
      stageCode: stageInfo.code,
      stageName: stageInfo.name
    };
  }

  return null;
};

/**
 * Public QR inspection endpoint (GET /api/qr/info/:token).
 * Allows the participant's phone camera landing page to inspect checkpoint identity before logging in.
 * Never exposes answers, passwords, or cryptographic scan proofs to unauthenticated callers.
 */
export const getQRInfo = async (req, res) => {
  try {
    const rawToken = req.params?.token || req.query?.token;
    if (!rawToken || typeof rawToken !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'TOKEN_REQUIRED',
        message: 'QR token is required.'
      });
    }

    const parsed = parseQRToken(rawToken);
    if (!parsed) {
      return res.status(404).json({
        success: false,
        error: 'QR_NOT_FOUND',
        message: 'Invalid or unrecognized QR token.'
      });
    }

    // Public checkpoint metadata only — no scan proof given to unauthenticated callers
    return res.status(200).json({
      success: true,
      valid: true,
      data: {
        qrToken: parsed.token,
        track: parsed.trackName,
        trackNumber: parsed.trackNum,
        stage: parsed.stageNum,
        stageCode: parsed.stageCode,
        stageName: parsed.stageName
      }
    });
  } catch (err) {
    console.error('[QR Controller] Error inspecting QR token:', err);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Failed to inspect QR token.'
    });
  }
};

/**
 * Authenticated Scan Proof Issuance Endpoint (POST /api/qr/proof).
 * Requires valid authenticated team JWT.
 * Verifies team eligibility (cannot request proof for wrong track or out-of-order stage).
 */
export const requestScanProof = async (req, res) => {
  try {
    const active = await isCompetitionActive();
    if (!active) {
      return res.status(403).json({
        success: false,
        error: 'COMPETITION_NOT_ACTIVE',
        message: 'The competition is currently stopped or has not started yet. QR checkpoints cannot be unlocked.'
      });
    }

    const teamId = req.user?.teamId;
    if (!teamId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const rawToken = req.body?.qrToken || req.body?.token;
    if (!rawToken || typeof rawToken !== 'string') {
      return res.status(400).json({ success: false, error: 'TOKEN_REQUIRED', message: 'QR token is required.' });
    }

    const parsed = parseQRToken(rawToken);
    if (!parsed) {
      return res.status(404).json({ success: false, error: 'QR_NOT_FOUND', message: 'Invalid QR token.' });
    }

    const canonicalTeamId = String(teamId).trim().toUpperCase();
    let team = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId);

    if (mongoose.connection && mongoose.connection.readyState === 1 && teamId) {
      try {
        const mongoTeam = await TeamModel.findOne({ team_id: canonicalTeamId }).lean();
        if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
          team = db.syncTeamFromMongo(mongoTeam) || team;
        }
      } catch (e) {}
    }

    if (!team) {
      return res.status(404).json({ success: false, error: 'TEAM_NOT_FOUND' });
    }

    if (team.disqualified) {
      return res.status(403).json({ success: false, error: 'TEAM_NOT_AUTHORIZED', message: 'Team is disqualified.' });
    }

    const { trackNum, trackName, stageNum, stageCode } = parsed;
    const teamTrackNum = Number(team.track ?? -1);
    const teamStageNum = Number(team.stage ?? 1);
    const trackConfirmed = Boolean(team.trackConfirmed);

    // Progression gating: Team cannot request scan proof for an unreached stage or wrong track
    const isCommonStage = stageNum === 4 || parsed.trackId === 'all' || parsed.trackId === 'common';

    if (!trackConfirmed || teamStageNum === 1) {
      if (stageNum !== 1) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_STAGE',
          message: 'This checkpoint is not for your current PS.'
        });
      }
    } else {
      // For Stage 4 (CV / OPENCV), the problem is common across all tracks: bypass track check
      if (!isCommonStage && trackNum !== teamTrackNum) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_TRACK',
          message: 'This QR code is not for your current PS.'
        });
      }
      if (stageNum !== teamStageNum) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_STAGE',
          message: 'This QR code is not for your current PS.'
        });
      }
    }

    // Issue time-limited cryptographic scan proof bound to this physical visit
    const scanProof = generateScanProof(parsed.token);

    return res.status(200).json({
      success: true,
      data: {
        qrToken: parsed.token,
        scanProof,
        expiresIn: 300
      }
    });
  } catch (err) {
    console.error('[QR Controller] Error issuing scan proof:', err);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
};

/**
 * Authenticated QR Redemption Endpoint (POST /api/qr/redeem and POST /api/qr/scan).
 * Strictly authenticates the team via JWT (req.user.teamId), validates single-use scanProof,
 * enforces strict progression rules, records persistent redemption in MongoDB & memory,
 * and emits real-time unlock notifications.
 */
export const redeemQR = async (req, res) => {
  const active = await isCompetitionActive();
  if (!active) {
    return res.status(403).json({
      success: false,
      error: 'COMPETITION_NOT_ACTIVE',
      message: 'The competition is currently stopped or has not started yet. QR checkpoints cannot be unlocked.'
    });
  }

  // 1. Team identity MUST be derived strictly from the authenticated JWT
  const teamId = req.user?.teamId;
  if (!teamId) {
    return res.status(403).json({
      success: false,
      error: 'TEAM_NOT_AUTHORIZED',
      message: 'You must belong to an active participant team to redeem QR checkpoints.'
    });
  }

  // 2. Extract QR token
  const rawToken = req.body?.qrToken || req.body?.token;
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'TOKEN_REQUIRED',
      message: 'QR token is required.'
    });
  }

  // 3. Scan Proof validation: prevent direct POST without legitimate physical scan proof
  const scanProof = req.body?.scanProof || req.headers['x-scan-proof'];
  if (!scanProof) {
    return res.status(403).json({
      success: false,
      error: 'SCAN_PROOF_REQUIRED',
      message: 'Direct redemption with raw QR identifier is rejected. Valid physical scan verification required.'
    });
  }

  const proofResult = await verifyAndConsumeScanProof(rawToken, scanProof);
  if (!proofResult.valid) {
    return res.status(403).json({
      success: false,
      error: proofResult.error || 'INVALID_SCAN_PROOF',
      message: proofResult.message || 'Invalid or expired scan proof.'
    });
  }

  const canonicalTeamId = String(teamId).trim().toUpperCase();

  // Acquire mutex lock to ensure atomic redemption per team
  await acquireRedemptionLock(canonicalTeamId);

  try {
    // 4. Fetch authoritative team state from MongoDB & in-memory database
    let mongoTeam = null;
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        mongoTeam = await TeamModel.findOne({ team_id: canonicalTeamId });
      } catch (e) {}
    }

    const memTeam = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId);
    if (!mongoTeam && !memTeam) {
      return res.status(404).json({
        success: false,
        error: 'TEAM_NOT_FOUND',
        message: 'Team not found in authoritative records.'
      });
    }

    const canonicalTeamName = mongoTeam?.team_name || memTeam?.team_name || canonicalTeamId;
    const isDisqualified = Boolean(mongoTeam?.disqualified || memTeam?.disqualified);

    // 5. Validate team is active and eligible
    if (isDisqualified) {
      return res.status(403).json({
        success: false,
        error: 'TEAM_NOT_AUTHORIZED',
        message: 'This team has been disqualified from the competition.'
      });
    }

    // 6. Parse and validate QR Token format
    const parsed = parseQRToken(rawToken);
    if (!parsed) {
      return res.status(404).json({
        success: false,
        error: 'WRONG_QR_CODE',
        message: 'Invalid or unrecognized QR token.'
      });
    }

    const { trackNum, trackName, stageNum, stageCode, token, canonicalToken } = parsed;
    const isCommonStage = stageNum === 4 || parsed.trackId === 'all' || parsed.trackId === 'common';

    // 7. Check sequencing against authoritative team progression
    const teamTrackNum = Number(mongoTeam?.track ?? memTeam?.track ?? -1);
    const teamStageNum = Number(mongoTeam?.stage ?? memTeam?.stage ?? 1);
    const trackConfirmed = Boolean(mongoTeam?.trackConfirmed || memTeam?.trackConfirmed || teamTrackNum > 0);

    // For Stage 4 (CV), problem IDs are per-track (prob_<track>_4), resolve for team's track
    const teamTrackId = (TRACK_NAMES[teamTrackNum] || memTeam?.pathAssigned || 'autumn').toLowerCase();
    const problemId = stageNum === 4 ? `prob_${teamTrackId}_4` : `prob_${parsed.trackId}_${stageNum}`;
    let problem = db.getProblemById(problemId) || db.getProblemByQRToken(token) || (canonicalToken ? db.getProblemByQRToken(canonicalToken) : null);

    if (!problem && stageNum === 4) {
      for (const p of db.problems.values()) {
        if (p.stage === 4 && (p.track === teamTrackNum || p.trackNumber === teamTrackNum)) {
          problem = p;
          break;
        }
      }
      if (!problem) {
        for (const p of db.problems.values()) {
          if (p.stage === 4) {
            problem = p;
            break;
          }
        }
      }
    }

    if (!problem) {
      return res.status(404).json({
        success: false,
        error: 'WRONG_QR_CODE',
        message: 'No challenge associated with this QR checkpoint.'
      });
    }

    // Case A: Team has not confirmed track (Stage 1 DS)
    if (!trackConfirmed || teamStageNum === 1) {
      if (stageNum !== 1) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_STAGE',
          message: 'This QR code is not for your current PS.'
        });
      }
      // If team has somehow already locked a track at stage 1, check track match
      if (trackConfirmed && teamTrackNum > 0 && trackNum !== teamTrackNum) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_TRACK',
          message: 'This QR code is not for your current PS.'
        });
      }
    } else {
      // Case B: Team has confirmed track (Stage >= 2)
      // Check track match (bypassed for common Stage 4 CV)
      if (!isCommonStage && trackNum !== teamTrackNum) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_TRACK',
          message: 'This QR code is not for your current PS.'
        });
      }

      // Check stage progression
      if (stageNum < teamStageNum) {
        return res.status(403).json({
          success: false,
          error: 'QR_ALREADY_USED',
          message: 'This QR code is not for your current PS.'
        });
      }

      if (stageNum > teamStageNum) {
        return res.status(403).json({
          success: false,
          error: 'WRONG_STAGE',
          message: 'This QR code is not for your current PS.'
        });
      }
    }

    // 8. Execute atomic unlock: Record in in-memory DB and MongoDB QRRedemption
    db.recordQRScan(canonicalTeamId, problem.id, token);

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        await QRRedemptionModel.findOneAndUpdate(
          { team_id: canonicalTeamId, problem_id: problem.id },
          {
            $setOnInsert: {
              team_id: canonicalTeamId,
              problem_id: problem.id,
              qr_token: token,
              track: trackNum,
              stage: stageNum,
              redeemed_at: new Date()
            }
          },
          { upsert: true, new: true }
        );
      } catch (e) {}

      try {
        await QuestionModel.updateOne(
          { track: trackNum, stage: stageNum },
          {
            $addToSet: {
              qrscanned_teams: {
                team_id: canonicalTeamId,
                team_name: canonicalTeamName,
                timestamp: new Date()
              }
            }
          }
        );
      } catch (e) {}
    }

    // 9. Log activity
    let act = null;
    try {
      act = await logActivity({
        event: 'QR_SCANNED',
        team_id: canonicalTeamId,
        team_name: canonicalTeamName,
        action: `Team ${canonicalTeamName} unlocked QR Checkpoint ${problem.trackName} Stage ${problem.stage}`,
        details: `QR Token: ${token}`,
        stage: problem.stage,
        track: problem.track,
        track_name: problem.trackName
      });
    } catch (e) {}

    // 10. Emit real-time unlock event strictly to the team's Socket.IO room
    const io = getIO();
    if (io) {
      io.to(`team:${canonicalTeamId}`).emit('qr:unlocked', {
        track: problem.trackName,
        stage: problem.stage,
        qrToken: token
      });

      // Admin telemetry
      io.to(ADMIN_ROOM).emit('admin:qr-unlocked', {
        teamId: canonicalTeamId,
        teamName: canonicalTeamName,
        track: problem.trackName,
        stage: problem.stage,
        timestamp: new Date().toISOString()
      });

      if (act) {
        broadcastAdminActivity(act);
      }
    }

    // 11. Respond to the phone (NO PASSWORD OR ANSWER EXPOSED!)
    return res.status(200).json({
      success: true,
      unlocked: true,
      qrScanned: true,
      message: '✓ PASSWORD UNLOCKED. You can return to your PC.',
      data: {
        problemId: problem.id,
        track: problem.trackName,
        stage: problem.stage,
        qrScanned: true,
        unlocked: true
      }
    });
  } catch (err) {
    console.error('[QR Controller] Error redeeming QR:', err);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Failed to process QR unlock.'
    });
  } finally {
    releaseRedemptionLock(canonicalTeamId);
  }
};

/**
 * Check if a problem is currently unlocked for the authenticated team (GET /api/qr/status/:problemId).
 * Used by the workstation on initial mount or page refresh.
 * Preserves unlock state using the stable teamId across reloads and token refreshes.
 */
export const getQRStatus = async (req, res) => {
  try {
    const active = await isCompetitionActive();
    if (!active) {
      return res.status(200).json({
        success: true,
        unlocked: false,
        competitionActive: false,
        problemId: req.params?.problemId
      });
    }

    const teamId = req.user?.teamId;
    if (!teamId) {
      return res.status(403).json({ success: false, error: 'TEAM_NOT_AUTHORIZED' });
    }

    const { problemId } = req.params;
    if (!problemId) {
      return res.status(400).json({ success: false, error: 'PROBLEM_ID_REQUIRED' });
    }

    const canonicalTeamId = String(teamId).trim().toUpperCase();
    let unlocked = db.isQRScanned(canonicalTeamId, problemId);

    // If not found in in-memory map, check persistent MongoDB QRRedemption record
    if (!unlocked && mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        const redemption = await QRRedemptionModel.findOne({
          team_id: canonicalTeamId,
          problem_id: problemId
        });
        if (redemption) {
          unlocked = true;
          db.recordQRScan(canonicalTeamId, problemId, redemption.qr_token);
        }
      } catch (e) {}
    }

    return res.status(200).json({
      success: true,
      unlocked: Boolean(unlocked),
      problemId
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
};

export const scanQR = redeemQR;

/**
 * Checkpoint Authentication Gate (POST /api/qr/auth).
 * Used exclusively after scanning physical QR code on mobile camera.
 * Validates team credentials and fetches authoritative track/stage info
 * WITHOUT rate-limiting or workstation device slot restrictions (does not consume active_devices).
 */
export const qrAuthenticate = async (req, res) => {
  try {
    const active = await isCompetitionActive();
    if (!active) {
      return res.status(403).json({
        success: false,
        error: 'COMPETITION_NOT_ACTIVE',
        message: 'The competition is currently stopped or has not started yet. QR checkpoints cannot be unlocked.'
      });
    }

    const { team_id, password } = req.body || {};
    const identifier = String(team_id || '').trim();
    const safePassword = String(password || '').trim();

    if (!identifier || !safePassword) {
      return res.status(400).json({
        success: false,
        error: 'CREDENTIALS_REQUIRED',
        message: 'Team ID and password are required.'
      });
    }

    let team = db.getTeamByTeamId(identifier) || db.getTeamByName(identifier) || db.getTeamById(identifier);
    if (!team) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid team ID or password.'
      });
    }

    if (team.disqualified) {
      return res.status(403).json({
        success: false,
        error: 'TEAM_DISQUALIFIED',
        message: 'This team has been disqualified from the competition.'
      });
    }

    const isPasswordValid = await comparePassword(safePassword, team.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid team ID or password.'
      });
    }

    const canonicalTeamId = String(team.team_id || team.id).trim().toUpperCase();
    const teamName = team.team_name || team.name;

    // Synchronize latest authoritative state from persistent MongoDB
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        const mongoTeam = await TeamModel.findOne({ team_id: canonicalTeamId }).lean();
        if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
          db.syncTeamFromMongo(mongoTeam);
        }
      } catch (e) {}
    }

    const activeTeamState = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId) || team;
    const participantUserId = activeTeamState.leaderId || (activeTeamState.members && activeTeamState.members[0]) || `user_${canonicalTeamId}_1`;

    // Issue token without device slot consumption or workstation session lock
    const token = generateToken(participantUserId, `${canonicalTeamId.toLowerCase()}@xtract.org`, 'PARTICIPANT', canonicalTeamId, teamName);

    const teamPayload = {
      id: canonicalTeamId,
      team_id: canonicalTeamId,
      name: teamName,
      team_name: teamName,
      track: activeTeamState.track,
      stage: activeTeamState.stage,
      score: activeTeamState.score || activeTeamState.points || 0,
      points: activeTeamState.points || activeTeamState.score || 0,
      pathAssigned: activeTeamState.pathAssigned,
      trackConfirmed: activeTeamState.trackConfirmed,
      stageProgress: activeTeamState.stageProgress
    };

    const userPayload = {
      id: participantUserId,
      _id: participantUserId,
      name: teamName,
      username: canonicalTeamId,
      role: 'PARTICIPANT',
      teamId: canonicalTeamId,
      teamName: teamName
    };

    return res.json({
      success: true,
      message: 'Checkpoint authenticated successfully',
      token,
      team: teamPayload,
      user: userPayload,
      data: {
        token,
        team: teamPayload,
        user: userPayload
      }
    });
  } catch (err) {
    console.error('[QR Controller] qrAuthenticate Error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export default {
  getQRInfo,
  redeemQR,
  scanQR,
  getQRStatus,
  parseQRToken,
  qrAuthenticate
};
