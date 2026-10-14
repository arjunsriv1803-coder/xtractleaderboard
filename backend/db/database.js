import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { CANONICAL_TEAMS } from '../config/teamsConfig.js';

class Database {
  constructor() {
    // Initialize data structures
    this.users = new Map();
    this.teams = new Map();
    this.paths = new Map();
    this.teamPathAssignments = new Map();
    this.problems = new Map();
    this.submissions = new Map();
    this.teamQRScans = new Map(); // key: `${teamId}_${problemId}` -> { scannedAt, qrToken }
    this.teamSessions = new Map(); // key: `${teamId}_${deviceId}` -> { teamId, deviceId, userId, isRevoked, lastActive, expiresAt }
    this.competitionState = {
      isRunning: false,
      startTime: null,
      stoppedAt: null
    };

    this.initializePaths();
    this.seedProblems();
    this.seedAdminUser();
    if (process.env.SEED_CANONICAL_TEAMS === 'true') {
      this.seedCanonicalTeams();
    }
  }

  seedAdminUser() {
    const passwordHash = bcrypt.hashSync('Xtr@ct5#Sec!9827Qz', 10);
    const adminUser = {
      id: 'admin_root',
      email: 'admin@xtract.org',
      password: passwordHash,
      name: 'admin',
      role: 'ADMIN',
      createdAt: new Date()
    };
    this.users.set('admin_root', adminUser);
  }

  seedCanonicalTeams() {
    CANONICAL_TEAMS.forEach((t) => {
      const passwordHash = bcrypt.hashSync(t.password, 10);
      const teamId = t.team_id;

      // Exactly 3 participant records per team
      const member1Id = `user_${teamId}_1`;
      const member2Id = `user_${teamId}_2`;
      const member3Id = `user_${teamId}_3`;

      const members = [member1Id, member2Id, member3Id];

      members.forEach((mId, index) => {
        this.users.set(mId, {
          id: mId,
          name: `${t.team_name} Member ${index + 1}`,
          email: `${teamId.toLowerCase()}_${index + 1}@xtract.org`,
          password: passwordHash,
          role: 'PARTICIPANT',
          teamId: teamId,
          createdAt: new Date()
        });
      });

      const teamDoc = {
        id: teamId,
        team_id: teamId,
        name: t.team_name,
        team_name: t.team_name,
        password: passwordHash,
        plainPassword: t.password,
        leaderId: member1Id,
        members,
        team_size: 5,
        pathAssigned: t.pathAssigned || null,
        track: t.track !== undefined ? t.track : -1,
        trackConfirmed: !!t.trackConfirmed,
        confirmedAt: t.trackConfirmed ? new Date() : null,
        confirmedByParticipant: t.trackConfirmed ? member1Id : null,
        confirmedViaSubmissionId: null,
        score: t.points || 0,
        points: t.points || 0,
        stage: t.stage || 1,
        stageProgress: t.stageProgress || {},
        disqualified: !!t.disqualified,
        is_logged_in: false,
        rate_limit_violations: t.rate_limit_violations || 0,
        createdAt: new Date()
      };

      this.teams.set(teamId, teamDoc);
      // Also register into path assignment if pre-assigned
      if (t.pathAssigned) {
        const path = this.getPathByName(t.pathAssigned);
        if (path) {
          path.teams.push(teamId);
          path.currentTeams++;
          this.teamPathAssignments.set(teamId, path.name);
        }
      }
    });
  }

  initializePaths() {
    // Exactly 4 canonical Xtract tracks (Max 7 teams per track, 28 teams total)
    // Track 1: Desert (formerly Harvest)
    // Track 2: Forest
    // Track 3: Volcanic (formerly Autumn)
    // Track 4: Arctic (formerly Winter)
    const canonicalTracks = [
      { id: 'desert', name: 'Desert', trackNumber: 1, envelope: 'Desert / Gold' },
      { id: 'forest', name: 'Forest', trackNumber: 2, envelope: 'Ice / Green' },
      { id: 'volcanic', name: 'Volcanic', trackNumber: 3, envelope: 'Fire / Red' },
      { id: 'arctic', name: 'Arctic', trackNumber: 4, envelope: 'Water / Blue' }
    ];

    canonicalTracks.forEach((tr) => {
      this.paths.set(tr.name, {
        id: tr.id,
        name: tr.name,
        trackNumber: tr.trackNumber,
        envelope: tr.envelope,
        maxTeams: 7,
        currentTeams: 0,
        isLocked: false,
        teams: []
      });
    });
  }

  /**
   * Canonical Xtract 5.0 Problems:
   * 4 Tracks: Desert, Forest, Volcanic, Arctic
   * 4 Stages per track:
   *   Stage 1: DS (Data Science)
   *   Stage 2: ML (Machine Learning)
   *   Stage 3: NLP (Natural Language Processing)
   *   Stage 4: OPEN_CV (Computer Vision - Common Final Stage)
   */
  seedProblems() {
    // Hardcoded mock questions removed. Questions are authoritative and hydrated from MongoDB (QuestionModel).
  }

  // User methods
  createUser(email, hashedPassword, name, role = 'PARTICIPANT') {
    const userId = `user_${Date.now()}`;
    this.users.set(userId, {
      id: userId,
      email,
      password: hashedPassword,
      name,
      role,
      createdAt: new Date()
    });
    return this.users.get(userId);
  }

  getUserByEmail(identifier) {
    if (!identifier) return null;
    const lower = identifier.toLowerCase().trim();
    for (let user of this.users.values()) {
      if (
        user.email.toLowerCase() === lower ||
        (user.name && user.name.toLowerCase() === lower) ||
        user.id === identifier
      ) {
        return user;
      }
    }
    return null;
  }

  getUserById(userId) {
    return this.users.get(userId);
  }

  // Team methods
  createTeam(name, leaderId) {
    const teamId = `team_${Date.now()}`;
    this.teams.set(teamId, {
      id: teamId,
      name,
      leaderId,
      members: [leaderId],
      pathAssigned: null,
      track: -1,
      trackConfirmed: false,
      confirmedAt: null,
      confirmedByParticipant: null,
      confirmedViaSubmissionId: null,
      score: 0,
      stage: 1,
      stageProgress: {},
      disqualified: false,
      createdAt: new Date()
    });
    return this.teams.get(teamId);
  }

  getTeamById(teamId) {
    if (!teamId) return null;
    return this.teams.get(teamId) || this.getTeamByTeamId(teamId);
  }

  getTeamByTeamId(teamId) {
    if (!teamId) return null;
    const clean = String(teamId).trim().toUpperCase();
    for (let team of this.teams.values()) {
      if (
        (team.team_id && team.team_id.toUpperCase() === clean) ||
        (team.id && team.id.toUpperCase() === clean)
      ) {
        return team;
      }
    }
    return null;
  }

  getTeamByName(name) {
    if (!name) return null;
    const clean = String(name).trim().toUpperCase();
    for (let team of this.teams.values()) {
      if (
        (team.name && team.name.toUpperCase() === clean) ||
        (team.team_name && team.team_name.toUpperCase() === clean)
      ) {
        return team;
      }
    }
    return null;
  }

  addMember(teamId, userId) {
    const team = this.getTeamById(teamId);
    if (!team) return null;

    if (team.members.includes(userId)) {
      return { team, alreadyMember: true };
    }

    if (team.members.length >= 4) {
      return { team, full: true };
    }

    team.members.push(userId);
    return { team, added: true };
  }

  getTeamsByLeader(leaderId) {
    const result = [];
    for (let team of this.teams.values()) {
      if (team.leaderId === leaderId) {
        result.push(team);
      }
    }
    return result;
  }

  getTeamsByMember(userId) {
    const result = [];
    for (let team of this.teams.values()) {
      if (team.members && team.members.includes(userId)) {
        result.push(team);
      }
    }
    return result;
  }

  getAllTeams() {
    return Array.from(this.teams.values());
  }

  // Path / Track methods
  getPathByName(nameOrId) {
    if (!nameOrId) return null;
    let query = String(nameOrId).trim().toLowerCase();
    if (query === 'autumn' || query === 'volcaninc') query = 'volcanic';
    if (query === 'harvest') query = 'desert';
    if (query === 'winter') query = 'arctic';
    for (let path of this.paths.values()) {
      if (
        path.name.toLowerCase() === query ||
        path.id.toLowerCase() === query ||
        String(path.trackNumber) === query ||
        `track ${path.trackNumber}` === query ||
        `track-${path.trackNumber}` === query
      ) {
        return path;
      }
    }
    return null;
  }

  getAllPaths() {
    return Array.from(this.paths.values());
  }

  /**
   * Public path info for participants.
   * Security rule: Never expose current team counts, remaining slots, or competitor lists to participants.
   */
  getPublicPaths() {
    return Array.from(this.paths.values()).map((p) => ({
      id: p.id,
      name: p.name,
      trackNumber: p.trackNumber,
      envelope: p.envelope
    }));
  }

  getPathStats() {
    const stats = {};
    for (let [pathName, pathData] of this.paths) {
      stats[pathName] = {
        name: pathData.name,
        trackNumber: pathData.trackNumber,
        currentTeams: pathData.currentTeams,
        maxTeams: pathData.maxTeams,
        isLocked: pathData.isLocked,
        availableSpots: Math.max(0, pathData.maxTeams - pathData.currentTeams)
      };
    }
    return stats;
  }

  /**
   * ATOMIC CLAIM:
   * Assigns a team to a track ONLY after solving DS, and ONLY if current assigned teams < 7.
   * Synchronous execution in Node.js event loop ensures race-free capacity checks.
   */
  confirmTeamTrack(teamId, trackName, meta = {}) {
    const team = this.getTeamById(teamId);
    const path = this.getPathByName(trackName);

    if (!team || !path) {
      return { success: false, error: 'Team or track not found' };
    }

    // Already locked to a track
    if (team.trackConfirmed) {
      return {
        success: true,
        alreadyConfirmed: true,
        message: `Team already locked into ${team.pathAssigned}`,
        team
      };
    }

    // Enforce 7-team track capacity
    if (path.currentTeams >= path.maxTeams) {
      path.isLocked = true;
      return {
        success: false,
        trackFull: true,
        error: 'This track is full. All 7 team slots have already been claimed. Please choose another available track.'
      };
    }

    // Assign team
    team.pathAssigned = path.name;
    team.track = path.trackNumber;
    team.trackConfirmed = true;
    team.confirmedAt = new Date();
    team.confirmedByParticipant = meta.participantId || null;
    team.confirmedViaSubmissionId = meta.submissionId || null;

    path.teams.push(teamId);
    path.currentTeams++;

    if (path.currentTeams >= path.maxTeams) {
      path.isLocked = true;
    }

    this.teamPathAssignments.set(teamId, path.name);

    return {
      success: true,
      alreadyConfirmed: false,
      message: `Team successfully assigned to ${path.name}`,
      team,
      pathStatus: path
    };
  }

  // Problem methods
  getProblemById(problemId) {
    if (!problemId) return null;
    const direct = this.problems.get(problemId);
    if (direct) return direct;
    const normalized = problemId
      .replace(/prob_autumn_/i, 'prob_volcanic_')
      .replace(/prob_volcaninc_/i, 'prob_volcanic_')
      .replace(/prob_harvest_/i, 'prob_desert_')
      .replace(/prob_winter_/i, 'prob_arctic_');
    return this.problems.get(normalized) || null;
  }

  getProblemsByTrack(trackName) {
    const path = this.getPathByName(trackName);
    if (!path) return [];
    return Array.from(this.problems.values())
      .filter((p) => p.trackName === path.name || p.track === path.trackNumber)
      .sort((a, b) => a.order - b.order);
  }

  getAllProblems() {
    return Array.from(this.problems.values()).sort((a, b) => a.track - b.track || a.order - b.order);
  }

  /**
   * Visible problems for a team:
   * - Unconfirmed team: ONLY stage 1 (DS) is visible across any track.
   * - Confirmed team: Only problems of their assigned track, up to their current stage.
   * Injects per-team `qrScanned` state for each problem.
   */
  getVisibleProblems(team, trackName) {
    const path = this.getPathByName(trackName);
    if (!path) return [];
    const allProblems = this.getProblemsByTrack(path.name);

    let accessible = [];
    if (!team || !team.trackConfirmed) {
      accessible = allProblems.filter((p) => p.order === 1);
    } else if (team.pathAssigned !== path.name || team.track !== path.trackNumber) {
      return [];
    } else {
      const solvedStages = Object.keys(team.stageProgress || {}).map(Number);
      const highestSolved = solvedStages.length ? Math.max(...solvedStages) : 0;
      const maxVisibleOrder = Math.min(4, highestSolved + 1);
      accessible = allProblems.filter((p) => p.order <= maxVisibleOrder);
    }

    return accessible.map((p) => ({
      ...p,
      qrScanned: team ? this.isQRScanned(team.id, p.id) : false
    }));
  }

  // QR Code Verification & Tracking
  getProblemByQRToken(token) {
    if (!token) return null;
    const clean = token.trim().toUpperCase();

    if (clean === 'QR-CV' || clean === 'QR-ALL-CV' || clean === 'QR-COMMON-CV') {
      for (let prob of this.problems.values()) {
        if (prob.stage === 4) {
          return prob;
        }
      }
    }

    for (let prob of this.problems.values()) {
      if (prob.qrToken && prob.qrToken.toUpperCase() === clean) {
        return prob;
      }
    }
    return null;
  }

  isQRScanned(teamId, problemId) {
    if (!teamId || !problemId) return false;
    const team = this.getTeamById(teamId) || this.getTeamByTeamId(teamId);
    const idKey = team ? (team.team_id || team.id) : teamId;
    return (
      this.teamQRScans.has(`${idKey}_${problemId}`) ||
      this.teamQRScans.has(`${teamId}_${problemId}`) ||
      (team ? this.teamQRScans.has(`${team.id}_${problemId}`) : false)
    );
  }

  recordQRScan(teamId, problemId, token) {
    if (!teamId || !problemId) return false;
    const team = this.getTeamById(teamId) || this.getTeamByTeamId(teamId);
    const payload = { scannedAt: new Date(), qrToken: token };
    this.teamQRScans.set(`${teamId}_${problemId}`, payload);
    if (team) {
      this.teamQRScans.set(`${team.id}_${problemId}`, payload);
      if (team.team_id) {
        this.teamQRScans.set(`${team.team_id}_${problemId}`, payload);
      }
    }
    return true;
  }

  getScannedProblemsForTeam(teamId) {
    if (!teamId) return [];
    const team = this.getTeamById(teamId) || this.getTeamByTeamId(teamId);
    const idKey = team ? (team.team_id || team.id) : teamId;
    const scanned = [];
    for (const [key] of this.teamQRScans.entries()) {
      if (key.startsWith(`${idKey}_`) || key.startsWith(`${teamId}_`)) {
        const pId = key.substring(key.indexOf('_') + 1);
        if (!scanned.includes(pId)) {
          scanned.push(pId);
        }
      }
    }
    return scanned;
  }

  // Team Session Tracking
  getActiveSessions(teamId) {
    const cleanId = String(teamId).trim().toUpperCase();
    const now = Date.now();
    const active = [];
    for (const [key, session] of this.teamSessions.entries()) {
      if (session.teamId === cleanId && !session.isRevoked && session.expiresAt > now) {
        active.push(session);
      }
    }
    return active;
  }

  recordSession(teamId, deviceId, userId, expiresAt) {
    const cleanId = String(teamId).trim().toUpperCase();
    const key = `${cleanId}_${deviceId}`;
    const session = {
      teamId: cleanId,
      deviceId,
      userId,
      isRevoked: false,
      lastActive: Date.now(),
      expiresAt: typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime()
    };
    this.teamSessions.set(key, session);
    return session;
  }

  revokeSession(teamId, deviceId) {
    const cleanId = String(teamId).trim().toUpperCase();
    const key = `${cleanId}_${deviceId}`;
    if (this.teamSessions.has(key)) {
      this.teamSessions.get(key).isRevoked = true;
      return true;
    }
    return false;
  }

  cleanExpiredSessions() {
    const now = Date.now();
    for (const [key, session] of this.teamSessions.entries()) {
      if (session.expiresAt <= now || session.isRevoked) {
        this.teamSessions.delete(key);
      }
    }
  }

  getActiveSessionsForTeam(teamId) {
    if (!teamId || !this.teamSessions) return [];
    const cleanId = String(teamId).trim().toUpperCase();
    const now = Date.now();
    const active = [];
    for (const session of this.teamSessions.values()) {
      if (session.teamId === cleanId && !session.isRevoked && session.expiresAt > now) {
        active.push(session);
      }
    }
    return active;
  }

  // Submission methods
  createSubmission(teamId, problemId, participantId, answer, isCorrect) {
    const submissionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const submission = {
      id: submissionId,
      teamId,
      problemId,
      participantId,
      answer,
      isCorrect,
      createdAt: new Date()
    };
    this.submissions.set(submissionId, submission);
    return submission;
  }

  getSubmissionsByTeam(teamId) {
    return Array.from(this.submissions.values())
      .filter((s) => s.teamId === teamId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  recordStageSolve(teamId, stageNumber, points, minutesTaken, submissionId) {
    const team = this.getTeamById(teamId);
    if (!team) {
      return { success: false, error: 'Team not found' };
    }

    const key = String(stageNumber);
    if (team.stageProgress[key]) {
      return { success: true, alreadyScored: true, stageProgress: team.stageProgress[key], totalScore: team.score };
    }

    const progress = {
      solvedAt: new Date(),
      minutesTaken: Math.round(minutesTaken * 100) / 100,
      points,
      submissionId,
      qrScanned: true
    };

    team.stageProgress[key] = progress;
    team.score = Math.round(((team.score || 0) + points) * 100) / 100;
    team.stage = Math.min(4, stageNumber + 1);

    return { success: true, alreadyScored: false, stageProgress: progress, totalScore: team.score };
  }

  checkAnswer(problem, answer) {
    if (!problem || typeof answer !== 'string') return false;
    const clean = answer.trim().toLowerCase();
    if (!clean) return false;

    if (problem.acceptedAnswers && Array.isArray(problem.acceptedAnswers)) {
      if (problem.acceptedAnswers.map((a) => a.toLowerCase()).includes(clean)) return true;
    }
    if (problem.ans && problem.ans.toLowerCase() === clean) return true;
    if (problem.answer && problem.answer.toLowerCase() === clean) return true;
    return false;
  }

  getCompetitionState() {
    return this.competitionState;
  }

  setCompetitionState(state) {
    this.competitionState = {
      ...this.competitionState,
      ...state
    };
    return this.competitionState;
  }

  getStageStartTime(team, stageNumber) {
    if (stageNumber === 1) {
      return this.competitionState?.startTime || team?.stage_start_time || team?.createdAt || new Date();
    }
    const prevProgress = team?.stageProgress && team.stageProgress[String(stageNumber - 1)];
    return prevProgress ? prevProgress.solvedAt : null;
  }

  // Authoritative Leaderboard
  getLeaderboard() {
    return this.getAllTeams()
      .map((team) => {
        const stagesCompleted = Object.keys(team.stageProgress || {}).length;
        return {
          teamId: team.id,
          name: team.name,
          teamName: team.name,
          track: team.pathAssigned || null,
          trackConfirmed: !!team.trackConfirmed,
          score: team.score || 0,
          points: team.score || 0,
          stage: stagesCompleted < 4 ? stagesCompleted + 1 : 4,
          stagesCompleted,
          disqualified: !!team.disqualified,
          stageProgress: team.stageProgress || {}
        };
      })
      .sort((a, b) => {
        if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
        if (b.score !== a.score) return b.score - a.score;
        return b.stagesCompleted - a.stagesCompleted;
      })
      .map((team, index) => ({
        ...team,
        rank: index + 1
      }));
  }

  syncTeamFromMongo(mt) {
    if (!mt) return null;
    const tid = String(mt.team_id || mt.id).trim();
    let memTeam = this.getTeamById(tid) || this.getTeamByTeamId(tid);
    if (!memTeam) {
      const member1Id = `user_${tid}_1`;
      const member2Id = `user_${tid}_2`;
      const member3Id = `user_${tid}_3`;
      const members = Array.isArray(mt.members) && mt.members.length > 0 ? mt.members : [member1Id, member2Id, member3Id];
      const leaderId = mt.leaderId || members[0] || member1Id;

      members.forEach((mId, index) => {
        if (!this.users.has(mId)) {
          this.users.set(mId, {
            id: mId,
            name: `${mt.team_name || tid} Member ${index + 1}`,
            email: `${String(tid).toLowerCase()}_${index + 1}@xtract.org`,
            password: mt.password,
            role: 'PARTICIPANT',
            teamId: tid,
            createdAt: new Date()
          });
        }
      });

      memTeam = {
        id: tid,
        team_id: tid,
        name: mt.team_name || tid,
        team_name: mt.team_name || tid,
        password: mt.password,
        plainPassword: mt.plainPassword || mt.password,
        leaderId,
        members,
        team_size: mt.team_size || 5,
        pathAssigned: mt.pathAssigned || null,
        track: mt.track !== undefined ? Number(mt.track) : -1,
        trackConfirmed: Boolean(mt.trackConfirmed),
        confirmedAt: mt.trackConfirmed ? (mt.updatedAt || new Date()) : null,
        confirmedByParticipant: mt.trackConfirmed ? leaderId : null,
        confirmedViaSubmissionId: null,
        score: Number(mt.points || 0),
        points: Number(mt.points || 0),
        stage: Number(mt.stage || 1),
        stageProgress: mt.stageProgress || {},
        disqualified: Boolean(mt.disqualified),
        is_logged_in: Boolean(mt.is_logged_in),
        active_devices: Array.isArray(mt.active_devices) ? mt.active_devices : [],
        rate_limit_violations: Number(mt.rate_limit_violations || 0),
        createdAt: mt.createdAt || new Date()
      };
      this.teams.set(tid, memTeam);
      if (tid.toUpperCase() !== tid) {
        this.teams.set(tid.toUpperCase(), memTeam);
      }
    } else {
      if (mt.team_name) {
        memTeam.team_name = mt.team_name;
        memTeam.name = mt.team_name;
      }
      if (mt.password) {
        memTeam.password = mt.password;
      }
      if (mt.plainPassword) {
        memTeam.plainPassword = mt.plainPassword;
      }
      if (mt.team_size) {
        memTeam.team_size = mt.team_size;
      }
      if (Array.isArray(mt.active_devices)) {
        memTeam.active_devices = mt.active_devices;
      }
      if (mt.is_logged_in !== undefined) {
        memTeam.is_logged_in = Boolean(mt.is_logged_in);
      }
      if (mt.rate_limit_violations !== undefined) {
        memTeam.rate_limit_violations = Number(mt.rate_limit_violations);
      }
    }

    // Normalize legacy track names if present in MongoDB document
    let rawPath = mt.pathAssigned;
    if (rawPath) {
      const lower = String(rawPath).trim().toLowerCase();
      if (lower === 'autumn' || lower === 'volcaninc') rawPath = 'Volcanic';
      else if (lower === 'harvest') rawPath = 'Desert';
      else if (lower === 'winter') rawPath = 'Arctic';
    }

    if (mt.track !== undefined && mt.track !== -1) {
      memTeam.track = Number(mt.track);
      // Reconcile legacy swap: If team was assigned Autumn (now Volcanic, Track 3) when Autumn was Track 1
      if (rawPath === 'Volcanic' && memTeam.track === 1) {
        memTeam.track = 3;
      } else if (rawPath === 'Desert' && memTeam.track === 3) {
        memTeam.track = 1;
      }
      memTeam.trackConfirmed = Boolean(mt.trackConfirmed !== undefined ? mt.trackConfirmed : true);
      const path = this.paths.get(memTeam.track) || Array.from(this.paths.values()).find(p => p.trackNumber === memTeam.track);
      if (path) {
        memTeam.pathAssigned = path.name;
        if (!path.teams.includes(memTeam.id) && !path.teams.includes(tid)) {
          path.teams.push(tid);
          path.currentTeams++;
          if (path.currentTeams >= path.maxTeams) {
            path.isLocked = true;
          }
        }
        this.teamPathAssignments.set(tid, memTeam.pathAssigned);
      } else {
        memTeam.pathAssigned = rawPath || 'Desert';
      }
    } else if (rawPath) {
      memTeam.pathAssigned = rawPath;
      const path = this.getPathByName(rawPath);
      if (path) {
        memTeam.track = path.trackNumber;
      }
      if (mt.trackConfirmed) {
        memTeam.trackConfirmed = true;
      }
    }

    if (mt.trackConfirmed !== undefined) {
      memTeam.trackConfirmed = Boolean(mt.trackConfirmed);
    }
    if (mt.stage !== undefined) {
      memTeam.stage = Number(mt.stage);
    }
    if (mt.points !== undefined) {
      memTeam.points = Number(mt.points);
      memTeam.score = Number(mt.points);
    }
    if (mt.disqualified !== undefined) {
      memTeam.disqualified = Boolean(mt.disqualified);
    }
    if (mt.stageProgress && typeof mt.stageProgress === 'object') {
      memTeam.stageProgress = { ...memTeam.stageProgress, ...mt.stageProgress };
    }
    return memTeam;
  }

  async syncFromMongo(TeamModel, QuestionModel, SubmissionModel, TrackCapacityModel) {
    try {
      if (!TeamModel || !mongoose.connection || mongoose.connection.readyState !== 1) return;
      const mongoTeams = await TeamModel.find({}).lean();
      if (mongoTeams && mongoTeams.length > 0) {
        for (const mt of mongoTeams) {
          this.syncTeamFromMongo(mt);
        }
      }

      // Reconcile existing confirmed track assignments into TrackCapacity collection
      if (TrackCapacityModel && mongoTeams && mongoTeams.length > 0) {
        // Clean up legacy track documents
        await TrackCapacityModel.deleteMany({
          track_name: { $in: ['Autumn', 'Harvest', 'Winter', 'Volcaninc'] }
        }).catch(() => { });

        const canonicalTracks = [
          { name: 'Desert', num: 1 },
          { name: 'Forest', num: 2 },
          { name: 'Volcanic', num: 3 },
          { name: 'Arctic', num: 4 }
        ];
        for (const ct of canonicalTracks) {
          const trackConfirmedTeams = mongoTeams
            .filter((t) => {
              const tPath = String(t.pathAssigned || '').toLowerCase();
              const isMatch = (t.track === ct.num) ||
                (ct.num === 1 && (tPath === 'desert' || tPath === 'harvest')) ||
                (ct.num === 2 && tPath === 'forest') ||
                (ct.num === 3 && (tPath === 'volcanic' || tPath === 'autumn' || tPath === 'volcaninc')) ||
                (ct.num === 4 && (tPath === 'arctic' || tPath === 'winter'));
              return isMatch && t.trackConfirmed;
            })
            .map((t) => t.team_id);

          const cappedTeams = trackConfirmedTeams.slice(0, 7);
          await TrackCapacityModel.findOneAndUpdate(
            { track_name: ct.name },
            {
              $setOnInsert: { max_teams: 7 },
              $set: { track_number: ct.num, claimed_teams: cappedTeams }
            },
            { upsert: true, new: true }
          );
        }
      }

      if (QuestionModel) {
        const questions = await QuestionModel.find({}).lean();
        if (questions && questions.length > 0) {
          for (const q of questions) {
            const trackNum = Number(q.track);
            const stageNum = Number(q.stage);
            const trackNames = ['desert', 'forest', 'volcanic', 'arctic'];
            const trackName = trackNames[trackNum - 1] || 'desert';
            const probIdCanonical = `prob_${trackName}_${stageNum}`;
            const probIdNumeric = `prob_${trackNum}_${stageNum}`;
            const codeNames = ['DS', 'ML', 'NLP', 'OPENCV'];
            const code = codeNames[stageNum - 1] || `STAGE${stageNum}`;
            const defaultQrToken = stageNum === 4 ? 'QR-CV' : `QR-${trackName.toUpperCase()}-${code}`;

            const statement = q.ques ? (Array.isArray(q.ques) ? q.ques : String(q.ques).split('\n')) : [];
            const ansStr = q.ans !== undefined ? String(q.ans) : '';

            let memProb = this.problems.get(probIdCanonical) || this.problems.get(probIdNumeric);
            if (!memProb) {
              memProb = {
                id: probIdCanonical,
                _id: q._id ? String(q._id) : probIdCanonical,
                trackName: trackName.charAt(0).toUpperCase() + trackName.slice(1),
                track: trackNum,
                trackNumber: trackNum,
                stage: stageNum,
                order: stageNum,
                code,
                title: q.title || `Stage ${stageNum}`,
                ques: Array.isArray(q.ques) ? q.ques.join('\n') : (q.ques || ''),
                statement,
                points: q.points !== undefined ? Number(q.points) : 100,
                nextHint: q.nextHint || '',
                ans: ansStr,
                acceptedAnswers: ansStr ? [ansStr] : [],
                qrToken: q.qrToken || defaultQrToken,
                isFirst: stageNum === 1,
                isFinal: stageNum === 4
              };
              this.problems.set(probIdCanonical, memProb);
              this.problems.set(probIdNumeric, memProb);
              if (q._id) {
                this.problems.set(String(q._id), memProb);
              }
            } else {
              if (q.ques) {
                memProb.ques = Array.isArray(q.ques) ? q.ques.join('\n') : q.ques;
                memProb.statement = statement;
              }
              if (q.title) memProb.title = q.title;
              if (q.ans) {
                memProb.ans = ansStr;
                memProb.acceptedAnswers = [ansStr];
              }
              if (q.points !== undefined) memProb.points = Number(q.points);
              if (q.nextHint) memProb.nextHint = q.nextHint;
              if (q.qrToken) memProb.qrToken = q.qrToken;
            }

            // Restore scanned QR checkpoints into memory
            if (Array.isArray(q.qrscanned_teams)) {
              for (const scan of q.qrscanned_teams) {
                if (scan.team_id) {
                  const tokenToUse = q.qrToken || `QR-TRACK${trackNum}-STAGE${stageNum}`;
                  this.recordQRScan(scan.team_id, probIdCanonical, tokenToUse);
                  this.recordQRScan(scan.team_id, probIdNumeric, tokenToUse);
                }
              }
            }

            // Restore completed stages and submitted_teams into memory
            if (Array.isArray(q.submitted_teams)) {
              for (const sub of q.submitted_teams) {
                if (sub.team_id) {
                  const team = this.getTeamById(sub.team_id) || this.getTeamByTeamId(sub.team_id);
                  if (team) {
                    if (!team.stageProgress) team.stageProgress = {};
                    team.stageProgress[String(stageNum)] = {
                      solvedAt: sub.timestamp || new Date(),
                      minutesTaken: 0,
                      points: q.points || 100,
                      qrScanned: true
                    };
                  }
                }
              }
            }
          }
        }
      }
      // Restore submissions from MongoDB into memory
      if (SubmissionModel) {
        try {
          const mongoSubs = await SubmissionModel.find({}).sort({ timestamp: -1, createdAt: -1 }).limit(1000).lean();
          if (mongoSubs && mongoSubs.length > 0) {
            for (const s of mongoSubs) {
              const subId = String(s._id || s.id);
              if (!this.submissions.has(subId)) {
                this.submissions.set(subId, {
                  id: subId,
                  teamId: s.team_id,
                  team_name: s.team_name,
                  problemId: s.question_id || `prob_${s.track}_${s.stage}`,
                  userId: s.team_id,
                  stage: s.stage,
                  track: s.track,
                  answer: s.submitted_answer,
                  submitted_answer: s.submitted_answer,
                  isCorrect: Boolean(s.is_correct),
                  is_correct: Boolean(s.is_correct),
                  points_awarded: s.points_awarded || 0,
                  createdAt: s.createdAt || s.timestamp || new Date(),
                  timestamp: s.timestamp || s.createdAt || new Date()
                });
              }
            }
          }
        } catch (e) { }
      }

      // Sync global competition state
      try {
        const compDoc = await mongoose.model('CompetitionState').findOne({ key: 'global' }).lean();
        if (compDoc) {
          this.setCompetitionState({
            isRunning: Boolean(compDoc.isRunning),
            startTime: compDoc.startTime ? new Date(compDoc.startTime) : null,
            stoppedAt: compDoc.stoppedAt ? new Date(compDoc.stoppedAt) : null
          });
        }
      } catch (e) { }

      console.log('[Database] Authoritative MongoDB state successfully synchronized into memory.');
    } catch (err) {
      console.error('[Database] Warning: Failed to sync state from MongoDB:', err.message);
    }
  }

  reset() {
    this.users.clear();
    this.teams.clear();
    this.paths.clear();
    this.teamPathAssignments.clear();
    this.problems.clear();
    this.submissions.clear();
    this.teamQRScans.clear();

    this.initializePaths();
    this.seedProblems();
    this.seedAdminUser();
    if (process.env.SEED_CANONICAL_TEAMS === 'true') {
      this.seedCanonicalTeams();
    }
  }
}

// Create singleton instance
const db = new Database();

export { Database, db };
export default db;
