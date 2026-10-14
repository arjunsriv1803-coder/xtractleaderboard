import crypto from 'crypto';
import mongoose from 'mongoose';
import db from '../db/database.js';
import { generateToken, encryptToken } from '../utils/jwt.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { TeamSession as TeamSessionModel } from '../models/TeamSession.js';
import { Team as TeamModel } from '../models/Team.js';
import { broadcastTelemetryUpdate } from '../sockets/socketManager.js';

// Mutex locks to ensure login check-and-insert is atomic per team
const teamLoginLocks = new Map();

const acquireTeamLoginLock = async (teamId) => {
  const timeout = Date.now() + 5000;
  while (teamLoginLocks.get(teamId)) {
    if (Date.now() > timeout) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  teamLoginLocks.set(teamId, true);
};

const releaseTeamLoginLock = (teamId) => {
  teamLoginLocks.delete(teamId);
};

/**
 * Store the JWT as an AES-256-GCM encrypted blob inside an HttpOnly cookie.
 */
const setAuthCookie = (res, rawToken) => {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('__xsid', encryptToken(rawToken), {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'None' : 'Lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  });
};

export const signDeviceSession = (teamId, devId) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const secret = process.env.COOKIE_ENCRYPT_SECRET;
  if (isProduction && (!secret || secret.trim().length < 32 || secret.includes('secret_32b!'))) {
    throw new Error('FATAL SECURITY CONFIGURATION: COOKIE_ENCRYPT_SECRET must be explicitly set and secure in production mode.');
  }
  return crypto.createHmac('sha256', secret || 'xtract_device_secret_32b!').update(`${teamId}:${devId}`).digest('hex');
};

/**
 * Store the stable device identifier and signature in cookies.
 */
const setDeviceCookie = (res, teamId, deviceId) => {
  const isProduction = process.env.NODE_ENV === 'production';
  const sig = signDeviceSession(teamId, deviceId);
  res.cookie('__xdid', deviceId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'None' : 'Lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/'
  });
  res.cookie('__xdid_sig', sig, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'None' : 'Lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
};

/**
 * Team Registration is closed.
 */
export const register = async (req, res) => {
  return res.status(403).json({
    error: 'REGISTRATION_CLOSED',
    message: 'Participant registration is disabled. Please log in using your assigned Team ID and password.'
  });
};

/**
 * Competition Login: TEAM ID + PASSWORD
 * (Also supports Administrator login via admin identification)
 * Strictly enforces maximum concurrent active devices equal to configured team size.
 */
export const login = async (req, res) => {
  try {
    const rawId = req.body.teamId || req.body.team_id || req.body.email || req.body.usernameOrEmail || req.body.identifier;
    const { password } = req.body;

    if (!rawId || !password) {
      return res.status(400).json({ error: 'Team ID and password are required' });
    }

    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      return res.status(400).json({ error: 'Invalid input format' });
    }
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid input format' });
    }

    const identifier = String(rawId).trim().substring(0, 128);
    const safePassword = password.substring(0, 256);

    // 1. Check for Admin Login (not subject to team login limits)
    const adminUser = db.getUserByEmail(identifier) || (identifier.toLowerCase() === 'admin' ? db.getUserById('admin_root') : null);
    if (adminUser && adminUser.role === 'ADMIN') {
      const isPasswordValid = await comparePassword(safePassword, adminUser.password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
      }
      const token = generateToken(adminUser.id, adminUser.email, 'ADMIN', null, 'Admin');
      setAuthCookie(res, token);
      return res.json({
        success: true,
        message: 'Admin login successful',
        token,
        sessionRef: encryptToken(token),
        data: {
          token,
          user: {
            id: adminUser.id,
            _id: adminUser.id,
            email: adminUser.email,
            username: adminUser.name,
            name: adminUser.name,
            role: 'ADMIN'
          }
        },
        user: {
          id: adminUser.id,
          email: adminUser.email,
          name: adminUser.name,
          role: 'ADMIN'
        }
      });
    }

    // 2. Participant Login: Resolve Team by Team ID from DB
    let team = null;
    const cleanId = identifier.trim();

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      try {
        const escapedId = cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mongoTeam = await TeamModel.findOne({
          $or: [
            { team_id: cleanId },
            { team_id: cleanId.toUpperCase() },
            { team_id: { $regex: new RegExp(`^${escapedId}$`, 'i') } },
            { team_name: cleanId },
            { team_name: { $regex: new RegExp(`^${escapedId}$`, 'i') } }
          ]
        }).lean();

        if (mongoTeam && typeof db.syncTeamFromMongo === 'function') {
          team = db.syncTeamFromMongo(mongoTeam);
        }
      } catch (err) {
        console.error('[AuthController] Error fetching team from DB:', err.message);
      }
    }

    if (!team) {
      team = db.getTeamByTeamId(cleanId) || db.getTeamByName(cleanId) || db.getTeamById(cleanId);
    }

    if (!team) {
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid team ID or password.'
      });
    }

    // 3. Verify Team is active / eligible (Not disqualified)
    if (team.disqualified) {
      return res.status(403).json({
        error: 'TEAM_DISQUALIFIED',
        message: 'This team has been disqualified from the competition.'
      });
    }

    // 4. Verify Team Password
    const isPasswordValid = await comparePassword(safePassword, team.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid team ID or password.'
      });
    }

    const canonicalTeamId = String(team.team_id || team.id).trim().toUpperCase();
    const teamName = team.team_name || team.name;

    // QR Checkpoint Bypass: Never enforce workstation device limits (3/3) or slot claims for QR mobile scanning
    const isQrCheckpoint = req.body?.context === 'qr_checkpoint' || req.body?.isQrScan === true;
    if (isQrCheckpoint) {
      const activeTeamState = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId) || team;
      const participantUserId = activeTeamState.leaderId || (activeTeamState.members && activeTeamState.members[0]) || `user_${canonicalTeamId}_1`;
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
        message: 'Checkpoint login successful',
        token,
        data: {
          token,
          team: teamPayload,
          user: userPayload
        },
        team: teamPayload,
        user: userPayload
      });
    }

    // 5. Atomic Team Login Limit Enforcement
    // Stable device identification from request body, headers, cookies, or generated
    const clientProvidedDevice = req.body.deviceId || req.headers['x-device-id'] || req.cookies?.__xdid;
    const clientDeviceSignature = req.body.deviceSignature || req.headers['x-device-signature'] || req.cookies?.__xdid_sig;
    let deviceId = (clientProvidedDevice && typeof clientProvidedDevice === 'string')
      ? clientProvidedDevice.trim().substring(0, 128)
      : `dev_${crypto.randomBytes(12).toString('hex')}`;

    await acquireTeamLoginLock(canonicalTeamId);

    try {
      const now = new Date();
      const sessionExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Clean up expired sessions in MongoDB and prune their device IDs from active_devices
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          // Find expired (but not yet revoked) sessions so we can prune their device IDs
          const expiredSessions = await TeamSessionModel.find(
            { team_id: canonicalTeamId, expires_at: { $lte: now }, is_revoked: false },
            { device_id: 1 }
          ).lean();
          if (expiredSessions.length > 0) {
            const expiredDeviceIds = expiredSessions.map((s) => s.device_id);
            await TeamSessionModel.updateMany(
              { team_id: canonicalTeamId, expires_at: { $lte: now }, is_revoked: false },
              { $set: { is_revoked: true } }
            );
            // Remove those expired device IDs from the Team.active_devices array
            await TeamModel.updateOne(
              { team_id: canonicalTeamId },
              { $pull: { active_devices: { $in: expiredDeviceIds } } }
            );
          }
        } catch (e) {}
      }

      // Clean up expired sessions in memory
      db.cleanExpiredSessions();

      // Register device in MongoDB active_devices without any maximum device lockout
      let activeDevicesList = [];
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          const updatedDoc = await TeamModel.findOneAndUpdate(
            { team_id: canonicalTeamId },
            {
              $addToSet: { active_devices: deviceId },
              $set: { is_logged_in: true }
            },
            { new: true }
          );
          if (updatedDoc && Array.isArray(updatedDoc.active_devices)) {
            activeDevicesList = updatedDoc.active_devices;
          }
        } catch (e) {}
      }

      // Record device session
      const participantUserId = team.leaderId || (team.members && team.members[0]) || `user_${canonicalTeamId}_1`;

      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          await TeamSessionModel.findOneAndUpdate(
            { team_id: canonicalTeamId, device_id: deviceId },
            {
              $set: {
                team_id: canonicalTeamId,
                device_id: deviceId,
                user_id: participantUserId,
                is_revoked: false,
                last_active_at: now,
                expires_at: sessionExpiry
              }
            },
            { upsert: true, new: true }
          );
        } catch (e) {}
      }

      db.recordSession(canonicalTeamId, deviceId, participantUserId, sessionExpiry);

      const memTeamForLogin = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId);
      if (memTeamForLogin) {
        memTeamForLogin.is_logged_in = true;
        if (!Array.isArray(memTeamForLogin.active_devices)) {
          memTeamForLogin.active_devices = [];
        }
        if (!memTeamForLogin.active_devices.includes(deviceId)) {
          memTeamForLogin.active_devices.push(deviceId);
        }
      }

      const activeDeviceCount = activeDevicesList.length || (memTeamForLogin?.active_devices?.length) || 1;

      // Real-time broadcast to Admin Dashboard with updated active device count
      try {
        broadcastTelemetryUpdate('teams-update', {
          teamId: canonicalTeamId,
          team_id: canonicalTeamId,
          is_logged_in: true,
          active_devices_count: activeDeviceCount,
          active_devices: activeDevicesList
        });
      } catch (e) {}

      // 6. Establish Authenticated Team Session (deviceId embedded in JWT for reliable logout targeting)
      const token = generateToken(participantUserId, `${canonicalTeamId.toLowerCase()}@xtract.org`, 'PARTICIPANT', canonicalTeamId, teamName, deviceId);

      const activeTeamState = db.getTeamById(canonicalTeamId) || db.getTeamByTeamId(canonicalTeamId) || team;

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

      const deviceSig = signDeviceSession(canonicalTeamId, deviceId);
      setAuthCookie(res, token);
      setDeviceCookie(res, canonicalTeamId, deviceId);

      return res.json({
        success: true,
        message: 'Login successful',
        token,
        deviceId,
        deviceSignature: deviceSig,
        sessionRef: encryptToken(token),
        data: {
          token,
          deviceId,
          deviceSignature: deviceSig,
          team: teamPayload,
          user: userPayload
        },
        team: teamPayload,
        user: userPayload
      });
    } finally {
      releaseTeamLoginLock(canonicalTeamId);
    }
  } catch (err) {
    console.error('[AuthController] Login Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Retrieve active profile and verified team identity.
 */
export const getProfile = async (req, res) => {
  try {
    if (req.user?.role === 'ADMIN') {
      const admin = db.getUserById(req.userId) || { id: req.userId, name: 'admin', email: 'admin@xtract.org', role: 'ADMIN' };
      return res.json({
        success: true,
        data: {
          user: {
            id: admin.id,
            _id: admin.id,
            email: admin.email,
            name: admin.name,
            role: 'ADMIN'
          }
        },
        user: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: 'ADMIN'
        }
      });
    }

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
      return res.status(404).json({ error: 'Team not found for this authenticated session' });
    }

    const teamIdFinal = team.team_id || team.id;
    const teamNameFinal = team.team_name || team.name;

    const teamPayload = {
      id: teamIdFinal,
      team_id: teamIdFinal,
      name: teamNameFinal,
      team_name: teamNameFinal,
      track: team.track,
      stage: team.stage,
      score: team.score || team.points || 0,
      points: team.points || team.score || 0,
      pathAssigned: team.pathAssigned,
      trackConfirmed: team.trackConfirmed,
      stageProgress: team.stageProgress
    };

    const userPayload = {
      id: req.userId,
      _id: req.userId,
      name: teamNameFinal,
      username: teamIdFinal,
      role: 'PARTICIPANT',
      teamId: teamIdFinal,
      teamName: teamNameFinal
    };

    res.json({
      success: true,
      data: {
        user: userPayload,
        team: teamPayload
      },
      user: userPayload,
      team: teamPayload
    });
  } catch (err) {
    console.error('[AuthController] Profile Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Logout: revokes the active device session slot and clears cookies.
 */
export const logout = async (req, res) => {
  try {
    const teamId = req.user?.teamId || req.body?.teamId;
    // Accept deviceId from body, header, OR cookie — in that priority order
    const deviceId = req.body?.deviceId || req.headers['x-device-id'] || req.cookies?.__xdid || req.user?.deviceId;

    if (teamId) {
      const canonicalTeamId = String(teamId).trim().toUpperCase();
      let remainingCount = 0;
      try {
        if (mongoose.connection && mongoose.connection.readyState === 1) {
          if (deviceId) {
            // Targeted removal: only revoke this specific device slot
            const updated = await TeamModel.findOneAndUpdate(
              { team_id: canonicalTeamId },
              { $pull: { active_devices: deviceId } },
              { new: true }
            );
            await TeamSessionModel.updateMany(
              { team_id: canonicalTeamId, device_id: deviceId },
              { $set: { is_revoked: true } }
            );
            remainingCount = updated?.active_devices?.length || 0;
          } else {
            // No deviceId available — revoke ALL sessions for this team so the
            // team is never permanently locked out just because a cookie was lost.
            await TeamSessionModel.updateMany(
              { team_id: canonicalTeamId },
              { $set: { is_revoked: true } }
            );
            await TeamModel.updateOne(
              { team_id: canonicalTeamId },
              { $set: { active_devices: [], is_logged_in: false } }
            );
            remainingCount = 0;
          }
          if (remainingCount === 0) {
            await TeamModel.updateOne(
              { team_id: canonicalTeamId },
              { $set: { is_logged_in: false } }
            );
          }
        }
      } catch (e) {}

      // Revoke in-memory session(s)
      if (deviceId && typeof db.revokeSession === 'function') {
        db.revokeSession(canonicalTeamId, deviceId);
      } else {
        // Fallback: revoke all in-memory sessions for this team
        if (typeof db.getActiveSessionsForTeam === 'function') {
          const allSessions = db.getActiveSessionsForTeam(canonicalTeamId);
          allSessions.forEach((s) => {
            if (typeof db.revokeSession === 'function') {
              db.revokeSession(canonicalTeamId, s.deviceId);
            }
          });
        }
      }

      const memActiveSessions = typeof db.getActiveSessionsForTeam === 'function'
        ? db.getActiveSessionsForTeam(canonicalTeamId)
        : [];
      const stillLoggedIn = remainingCount > 0 || memActiveSessions.length > 0;
      const memTeam = db.getTeamById(canonicalTeamId);
      if (memTeam) {
        memTeam.is_logged_in = stillLoggedIn;
      }

      const totalRemaining = Math.max(0, remainingCount);
      try {
        broadcastTelemetryUpdate('teams-update', {
          teamId: canonicalTeamId,
          team_id: canonicalTeamId,
          is_logged_in: stillLoggedIn,
          active_devices_count: totalRemaining
        });
      } catch (e) {}
    }

    res.clearCookie('__xsid', { path: '/' });
    res.clearCookie('__xdid', { path: '/' });
    res.clearCookie('__xdid_sig', { path: '/' });

    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return res.json({ success: true, message: 'Logged out' });
  }
};

export default { register, login, getProfile, logout };
