/**
 * Adversarial Security & Invariant Audit Test Suite for Xtract 5.0
 * 
 * Verifies:
 * 1. QR Security (Bypass, Guessing, Forgery, Replay, Out-of-Order, Unredeemed Submissions, Cross-Team)
 * 2. Concurrent Logins & Per-Team Device Limit (Simultaneous logins, Session release, Re-login/Refresh)
 * 3. 8-Team Simultaneous Track Claim Race (Exactly 7 claim, 8th receives exact track-full error)
 * 4. Cross-Track Lockout & Duplicate Submissions (No extra slot consumption)
 * 5. Admin Authorization, Socket.IO, Scoring, Leaderboard, and JWT Security Regressions
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'audit_jwt_secret_key_2026';
process.env.QR_PROOF_SECRET = 'audit_qr_proof_hmac_secret_key_2026';

import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import db from '../db/database.js';
import { generateToken, encryptToken, decryptTokenServerOnly } from '../utils/jwt.js';
import { generateScanProof } from '../utils/qrProof.js';
import leaderboardService from '../services/leaderboardService.js';
import { initSocketServer } from '../sockets/socketManager.js';
import { io as ClientIO } from '../../../Frontend/frontend/node_modules/socket.io-client/build/esm/index.js';

let server;
let baseUrl;
let socketServer;

const auditResults = [];

const record = (category, testNum, testName, passed, details = '') => {
  const status = passed ? 'PASSED' : 'FAILED';
  auditResults.push({ category, testNum, testName, status, details });
  const prefix = `[${category} | #${testNum}]`;
  console.log(`${prefix.padEnd(28)} ${status.padEnd(8)}: ${testName}${details ? ` -> ${details}` : ''}`);
};

const req = async (path, options = {}) => {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, headers: res.headers, data };
};

const runAudit = async () => {
  console.log('======================================================================');
  console.log('   XTRACT 5.0 FINAL ADVERSARIAL SECURITY & CAPACITY AUDIT');
  console.log('======================================================================\n');

  server = http.createServer(app);
  socketServer = initSocketServer(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/api`;
  console.log(`[Audit Test Server] Active on ${baseUrl}\n`);

  try {
    // Helper tokens
    const team1Id = 'TEAM-01';
    const team2Id = 'TEAM-02';
    const team1Token = generateToken('user_TEAM-01_1', 'team-01@xtract.org', 'PARTICIPANT', team1Id, 'CipherSentinels');
    const team2Token = generateToken('user_TEAM-02_1', 'team-02@xtract.org', 'PARTICIPANT', team2Id, 'QuantumBreakers');
    const adminToken = generateToken('admin_root', 'admin@xtract.org', 'ADMIN', null, 'Admin');

    // =====================================================================
    // 1. QR SECURITY AUDIT (Adversarial Bypass & Injection Tests)
    // =====================================================================
    console.log('--- SUITE 1: QR SECURITY & ADVERSARIAL REDEMPTION ---');

    // 1.1 Direct POST redemption without scan proof
    const r1_1 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS' })
    });
    record('QR Security', 1, 'Direct POST redemption without scanProof rejected',
      r1_1.status === 403 && r1_1.data.error === 'SCAN_PROOF_REQUIRED',
      `HTTP ${r1_1.status} (${r1_1.data.error})`
    );

    // 1.2 Forged HMAC signature in scan proof
    const forgedProof = `QR-AUTUMN-DS.${Date.now()}.${Date.now() + 300000}.fakeNonce12345678.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
    const r1_2 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: forgedProof })
    });
    record('QR Security', 2, 'Forged HMAC signature in scan proof rejected',
      r1_2.status === 403 && r1_2.data.error === 'INVALID_SCAN_PROOF',
      `HTTP ${r1_2.status} (${r1_2.data.error})`
    );

    // 1.3 Expired scan proof (> 5 minutes old)
    const expiredIssued = Date.now() - 400000;
    const expiredAt = Date.now() - 100000;
    const expNonce = crypto.randomBytes(16).toString('hex');
    const expPayload = `QR-AUTUMN-DS:${expiredIssued}:${expiredAt}:${expNonce}`;
    const expHmac = crypto.createHmac('sha256', process.env.QR_PROOF_SECRET).update(expPayload).digest('hex');
    const expiredProof = `QR-AUTUMN-DS.${expiredIssued}.${expiredAt}.${expNonce}.${expHmac}`;
    const r1_3 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: expiredProof })
    });
    record('QR Security', 3, 'Expired scan proof (>5 min old) rejected',
      r1_3.status === 403 && r1_3.data.error === 'SCAN_PROOF_EXPIRED',
      `HTTP ${r1_3.status} (${r1_3.data.error})`
    );

    // 1.4 Mismatched QR token in scan proof (Proof generated for Forest, used for Autumn)
    const forestProof = generateScanProof('QR-FOREST-DS');
    const r1_4 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: forestProof })
    });
    record('QR Security', 4, 'Mismatched QR token in scan proof rejected',
      r1_4.status === 403 && r1_4.data.error === 'SCAN_PROOF_MISMATCH',
      `HTTP ${r1_4.status} (${r1_4.data.error})`
    );

    // 1.5 Replay attack (Single-use nonce reuse)
    const validProofForReplay = generateScanProof('QR-AUTUMN-DS');
    const r1_5a = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: validProofForReplay })
    });
    const r1_5b = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: validProofForReplay })
    });
    record('QR Security', 5, 'Replay attack with consumed nonce rejected',
      r1_5a.status === 200 && r1_5b.status === 403 && r1_5b.data.error === 'REPLAYED_REDEMPTION',
      `First: ${r1_5a.status}, Replay: ${r1_5b.status} (${r1_5b.data.error})`
    );

    // 1.6 Out-of-order stage skipping (Team on Stage 1 DS tries to redeem Stage 2 ML or Stage 3 NLP)
    const stage2Proof = generateScanProof('QR-AUTUMN-ML');
    const r1_6 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-ML', scanProof: stage2Proof })
    });
    record('QR Security', 6, 'Out-of-order stage skipping rejected',
      r1_6.status === 403 && r1_6.data.error === 'WRONG_STAGE',
      `HTTP ${r1_6.status} (${r1_6.data.error}: ${r1_6.data.message})`
    );

    // 1.7 Direct answer submission to /api/submissions without QR redemption
    // Team 2 has never redeemed QR-AUTUMN-DS
    const r1_7 = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team2Token}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record('QR Security', 7, 'Direct submission without QR redemption rejected',
      r1_7.status === 403 && r1_7.data.error === 'QR_REQUIRED',
      `HTTP ${r1_7.status} (${r1_7.data.error}: ${r1_7.data.message})`
    );

    // 1.8 Direct answer submission after redeeming the WRONG track QR
    // Team 2 redeems Forest DS QR, then tries to submit to Autumn DS problem
    const proofForestDS = generateScanProof('QR-FOREST-DS');
    await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team2Token}` },
      body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proofForestDS })
    });
    const r1_8 = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team2Token}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record('QR Security', 8, 'Submission with wrong track QR redeemed rejected',
      r1_8.status === 403 && r1_8.data.error === 'WRONG_QR_CODE',
      `HTTP ${r1_8.status} (${r1_8.data.error})`
    );

    // 1.9 Cross-team submission spoofing (Team 1 submitting with teamId: TEAM-02 in payload)
    const r1_9 = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ teamId: 'TEAM-02', problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record('QR Security', 9, 'Cross-team submission spoofing rejected',
      r1_9.status === 403 && r1_9.data.error === 'FORBIDDEN',
      `HTTP ${r1_9.status} (${r1_9.data.error})`
    );

    // 1.10 Unauthenticated request to /api/qr/redeem
    const r1_10 = await req('/qr/redeem', {
      method: 'POST',
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: generateScanProof('QR-AUTUMN-DS') })
    });
    record('QR Security', 10, 'Unauthenticated redemption rejected',
      r1_10.status === 401,
      `HTTP ${r1_10.status}`
    );


    // =====================================================================
    // 2. CONCURRENT LOGINS & TEAM DEVICE LIMIT AUDIT
    // =====================================================================
    console.log('\n--- SUITE 2: CONCURRENT LOGINS & DEVICE LIMIT ENFORCEMENT ---');

    // 2.1 Team of size N (TEAM-03 has size 3) permitted exactly 3 distinct devices
    const l1 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_slot1' }) });
    const l2 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_slot2' }) });
    const l3 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_slot3' }) });
    const l4 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_slot4' }) });

    record('Login Limits', 11, 'Enforce configured team size login limit (3/3 allowed, 4th rejected)',
      l1.status === 200 && l2.status === 200 && l3.status === 200 && l4.status === 403 && l4.data.error === 'LOGIN_LIMIT_EXCEEDED',
      `Slot 1-3: 200, Slot 4: ${l4.status} (${l4.data.error})`
    );

    // 2.2 Concurrent login race: 10 simultaneous login requests for TEAM-04 (size 3)
    const concurrentDeviceIds = Array.from({ length: 10 }, (_, i) => `dev_race_team4_${i + 1}`);
    const concurrentLoginPromises = concurrentDeviceIds.map((devId) =>
      req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: devId }) })
    );
    const concurrentResponses = await Promise.all(concurrentLoginPromises);
    const succLogins = concurrentResponses.filter((r) => r.status === 200).length;
    const blockedLogins = concurrentResponses.filter((r) => r.status === 403 && r.data.error === 'LOGIN_LIMIT_EXCEEDED').length;

    record('Login Limits', 12, '10 simultaneous logins for team of size 3: exactly 3 succeed, 7 rejected',
      succLogins === 3 && blockedLogins === 7,
      `Success: ${succLogins}, Blocked: ${blockedLogins}`
    );

    // 2.3 Re-login / token refresh on existing device does not consume new slot
    const relogin = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-03',
        password: 'Password123!',
        deviceId: 'dev_team3_slot1',
        deviceSignature: l1.data.deviceSignature
      })
    });
    const activeSessionsT3 = db.getActiveSessions('TEAM-03');
    record('Login Limits', 13, 'Re-login on existing device ID does not consume extra slot',
      relogin.status === 200 && activeSessionsT3.length === 3,
      `HTTP ${relogin.status}, Active Sessions: ${activeSessionsT3.length}`
    );

    // 2.4 Explicit logout releases device slot immediately
    const logoutRes = await req('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${l1.data.token}` },
      body: JSON.stringify({ teamId: 'TEAM-03', deviceId: 'dev_team3_slot1' })
    });
    // Now dev_team3_slot4 can take the released slot
    const slot4Retry = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_slot4' }) });
    record('Login Limits', 14, 'Logout releases session slot allowing new device to log in',
      logoutRes.status === 200 && slot4Retry.status === 200,
      `Logout: ${logoutRes.status}, New Login: ${slot4Retry.status}`
    );

    // 2.5 Client cannot tamper with team_size or members array in login body
    const tamperedLogin = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-03',
        password: 'Password123!',
        deviceId: 'dev_team3_tamper_attempt',
        team_size: 99,
        members: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
      })
    });
    record('Login Limits', 15, 'Client tampering with team_size in login payload is rejected',
      tamperedLogin.status === 403 && tamperedLogin.data.error === 'LOGIN_LIMIT_EXCEEDED',
      `HTTP ${tamperedLogin.status} (${tamperedLogin.data.error})`
    );


    // =====================================================================
    // 3. 8-TEAM SIMULTANEOUS TRACK CLAIM RACE SIMULATION
    // =====================================================================
    console.log('\n--- SUITE 3: 8 TEAMS SIMULTANEOUS TRACK CLAIM RACE ---');

    // Clean reset track 'Winter' to 0 teams for isolation
    const winterTrack = db.getPathByName('Winter');
    winterTrack.teams = [];
    winterTrack.currentTeams = 0;
    winterTrack.isLocked = false;

    // Prepare 8 distinct participant teams (TEAM-16 through TEAM-23)
    const raceTeamIds = ['TEAM-16', 'TEAM-17', 'TEAM-18', 'TEAM-19', 'TEAM-20', 'TEAM-21', 'TEAM-22', 'TEAM-23'];
    const raceTeamTokens = {};

    for (const tId of raceTeamIds) {
      const teamDoc = db.getTeamById(tId);
      // Reset progression
      teamDoc.track = -1;
      teamDoc.trackConfirmed = false;
      teamDoc.pathAssigned = null;
      teamDoc.stage = 1;
      teamDoc.stageProgress = {};

      const token = generateToken(`user_${tId}_1`, `${tId.toLowerCase()}@xtract.org`, 'PARTICIPANT', tId, tId);
      raceTeamTokens[tId] = token;

      // Legitimate QR scan for Winter DS
      const proof = generateScanProof('QR-WINTER-DS');
      const redeemRes = await req('/qr/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ qrToken: 'QR-WINTER-DS', scanProof: proof })
      });
      if (redeemRes.status !== 200) {
        throw new Error(`Failed to redeem QR-WINTER-DS for ${tId}: ${JSON.stringify(redeemRes.data)}`);
      }
    }

    // SIMULTANEOUS SUBMISSION: All 8 teams submit correct answer to Winter DS simultaneously
    const expectedFullMessage = 'This track is full. All 7 team slots have already been claimed. Please choose another available track.';
    
    const simultaneousSubmissions = raceTeamIds.map((tId) =>
      req('/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${raceTeamTokens[tId]}` },
        body: JSON.stringify({ problemId: 'prob_winter_1', answer: '2022-08-04' })
      })
    );

    const raceResults = await Promise.all(simultaneousSubmissions);

    const claimedTeams = [];
    const rejectedTeams = [];

    raceResults.forEach((res, index) => {
      const tId = raceTeamIds[index];
      if (res.status === 201 && res.data.isCorrect && res.data.trackAssigned === 'Winter') {
        claimedTeams.push({ teamId: tId, res });
      } else if (res.status === 409 && res.data.trackFull === true) {
        rejectedTeams.push({ teamId: tId, res });
      }
    });

    record('Track Capacity', 16, 'Exactly 7 teams claim the track under simultaneous race',
      claimedTeams.length === 7,
      `Claimed count: ${claimedTeams.length}/8`
    );

    record('Track Capacity', 17, 'Exactly 1 team rejected with exact full-track message',
      rejectedTeams.length === 1 && rejectedTeams[0].res.data.message === expectedFullMessage,
      `Rejected count: ${rejectedTeams.length}, Msg: "${rejectedTeams[0]?.res?.data?.message}"`
    );

    record('Track Capacity', 18, 'Winter track currentTeams count capped strictly at 7',
      winterTrack.currentTeams === 7 && winterTrack.teams.length === 7,
      `currentTeams: ${winterTrack.currentTeams}, teams.length: ${winterTrack.teams.length}`
    );

    // Verify 8th team is not locked into Winter and has no confirmed track
    const rejectedTeamDoc = db.getTeamById(rejectedTeams[0].teamId);
    record('Track Capacity', 19, 'Rejected 8th team was not assigned or confirmed to full track',
      rejectedTeamDoc.trackConfirmed === false && rejectedTeamDoc.pathAssigned === null,
      `trackConfirmed: ${rejectedTeamDoc.trackConfirmed}, pathAssigned: ${rejectedTeamDoc.pathAssigned}`
    );

    // 3.5 The rejected 8th team can pivot to Harvest and successfully claim it
    const pivotTeamId = rejectedTeams[0].teamId;
    const pivotToken = raceTeamTokens[pivotTeamId];
    const harvestProof = generateScanProof('QR-HARVEST-DS');
    await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pivotToken}` },
      body: JSON.stringify({ qrToken: 'QR-HARVEST-DS', scanProof: harvestProof })
    });
    const pivotSub = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pivotToken}` },
      body: JSON.stringify({ problemId: 'prob_harvest_1', answer: '2022-08-04' })
    });
    record('Track Capacity', 20, 'Rejected team can pivot and claim another open track',
      pivotSub.status === 201 && pivotSub.data.isCorrect && pivotSub.data.trackAssigned === 'Harvest',
      `HTTP ${pivotSub.status}, Assigned: ${pivotSub.data.trackAssigned}`
    );


    // =====================================================================
    // 4. MULTI-TRACK & DUPLICATE SUBMISSION INVARIANTS
    // =====================================================================
    console.log('\n--- SUITE 4: MULTI-TRACK LOCKOUT & DUPLICATE SUBMISSIONS ---');

    // 4.1 Cross-track lockout: Team confirmed in Winter cannot submit to Autumn
    const winterConfirmedTeam = claimedTeams[0].teamId;
    const winterTeamTok = raceTeamTokens[winterConfirmedTeam];
    // Redeem Autumn QR (attempt)
    const proofAutumnDS = generateScanProof('QR-AUTUMN-DS');
    const wrongTrackRedeem = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${winterTeamTok}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: proofAutumnDS })
    });
    // Direct submission to Autumn
    const wrongTrackSub = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${winterTeamTok}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record('Multi-Track', 21, 'Team locked into Winter blocked from other tracks',
      wrongTrackRedeem.status === 403 && wrongTrackSub.status === 403,
      `Redeem: ${wrongTrackRedeem.status} (${wrongTrackRedeem.data.error}), Sub: ${wrongTrackSub.status}`
    );

    // 4.2 Duplicate submission by confirmed team does not consume extra slots
    const winterCountBefore = winterTrack.currentTeams;
    const teamDocBefore = { ...db.getTeamById(winterConfirmedTeam) };
    const dupSub = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${winterTeamTok}` },
      body: JSON.stringify({ problemId: 'prob_winter_1', answer: '2022-08-04' })
    });
    const winterCountAfter = winterTrack.currentTeams;
    const teamDocAfter = db.getTeamById(winterConfirmedTeam);
    record('Multi-Track', 22, 'Duplicate submission does not consume additional slots or duplicate points',
      dupSub.status === 201 && winterCountBefore === winterCountAfter && teamDocBefore.score === teamDocAfter.score,
      `Track count: ${winterCountBefore} -> ${winterCountAfter}, Points: ${teamDocAfter.score}`
    );

    // 4.3 Incorrect answer does not consume slot
    const forestTrack = db.getPathByName('Forest');
    const forestCountBefore = forestTrack.currentTeams;
    const unconfirmedTeamId = 'TEAM-24';
    const unconfirmedToken = generateToken('user_TEAM-24_1', 'team-24@xtract.org', 'PARTICIPANT', unconfirmedTeamId, unconfirmedTeamId);
    const proofForest = generateScanProof('QR-FOREST-DS');
    await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${unconfirmedToken}` },
      body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proofForest })
    });
    const wrongAnsSub = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${unconfirmedToken}` },
      body: JSON.stringify({ problemId: 'prob_forest_1', answer: 'incorrect-random-string' })
    });
    const forestCountAfter = forestTrack.currentTeams;
    record('Multi-Track', 23, 'Incorrect answer does not consume slot',
      wrongAnsSub.status === 200 && wrongAnsSub.data.isCorrect === false && forestCountBefore === forestCountAfter,
      `isCorrect: ${wrongAnsSub.data.isCorrect}, Track count: ${forestCountAfter}`
    );


    // =====================================================================
    // 5. REGRESSION AUDIT (Admin Auth, Sockets, Scoring, Leaderboard, JWT)
    // =====================================================================
    console.log('\n--- SUITE 5: REGRESSION TESTING (ADMIN, SOCKETS, LEADERBOARD, JWT) ---');

    // 5.1 Admin routes block unauthenticated access
    const adminEndpoints = ['/admin/overview', '/admin/questions', '/admin/answer-logs', '/admin/teams', '/admin/activity'];
    let allUnauthBlocked = true;
    for (const ep of adminEndpoints) {
      const r = await req(ep);
      if (r.status !== 401) allUnauthBlocked = false;
    }
    record('Regression', 24, 'All admin endpoints reject unauthenticated requests with 401',
      allUnauthBlocked,
      `Tested: ${adminEndpoints.length} endpoints`
    );

    // 5.2 Admin routes block participant tokens
    let allParticipantBlocked = true;
    for (const ep of adminEndpoints) {
      const r = await req(ep, { headers: { Authorization: `Bearer ${team1Token}` } });
      if (r.status !== 403) allParticipantBlocked = false;
    }
    record('Regression', 25, 'All admin endpoints reject participant tokens with 403 FORBIDDEN_ROLE',
      allParticipantBlocked,
      `Tested: ${adminEndpoints.length} endpoints`
    );

    // 5.3 Forged admin role in token (valid signature, but user is not admin in authoritative store)
    const forgedAdminToken = jwt.sign(
      { userId: 'user_TEAM-01_1', email: 'team-01@xtract.org', role: 'ADMIN', teamId: 'TEAM-01' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const forgedAdminReq = await req('/admin/overview', {
      headers: { Authorization: `Bearer ${forgedAdminToken}` }
    });
    record('Regression', 26, 'Forged role in JWT rejected by authoritative DB check',
      forgedAdminReq.status === 403,
      `HTTP ${forgedAdminReq.status}`
    );

    // 5.4 Legitimate Admin can access admin endpoints
    const legitAdminReq = await req('/admin/overview', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Regression', 27, 'Legitimate Admin successfully accesses /admin/overview',
      legitAdminReq.status === 200 && legitAdminReq.data.success === true,
      `HTTP ${legitAdminReq.status}`
    );

    // 5.5 Admin Seed endpoint rejects unauthenticated and non-admin
    const seedUnauth = await req('/admin/seed', { method: 'POST', body: JSON.stringify({}) });
    const seedPart = await req('/admin/seed', { method: 'POST', headers: { Authorization: `Bearer ${team1Token}` }, body: JSON.stringify({}) });
    record('Regression', 28, 'Admin seed endpoint rejects unauthenticated and participant requests',
      seedUnauth.status === 401 && seedPart.status === 403,
      `Unauth: ${seedUnauth.status}, Participant: ${seedPart.status}`
    );

    // 5.6 Confidentiality: /api/health and /health status only, no route disclosure
    const healthApi = await req('/health');
    const healthApiSub = await req('/health');
    const endpointDisclosure = await req('/endpoints');
    record('Regression', 29, 'Health check returns status only; no route disclosure endpoint exists',
      healthApi.status === 200 && !healthApi.data.routes && endpointDisclosure.status === 404,
      `/health: ${healthApi.status}, /endpoints: ${endpointDisclosure.status}`
    );

    // 5.7 Public paths endpoint (/api/path) never leaks team count or competitor lists
    const publicPaths = await req('/path');
    const leaksCounts = Array.isArray(publicPaths.data?.paths) && publicPaths.data.paths.some((p) => p.currentTeams !== undefined || p.teams !== undefined);
    record('Regression', 30, 'Public path endpoint does not leak team counts or competitor identities',
      publicPaths.status === 200 && !leaksCounts,
      `HTTP ${publicPaths.status}, Leaks: ${leaksCounts}`
    );

    // 5.8 Authoritative Leaderboard calculation & deterministic ranking
    const lbData = await leaderboardService.getAuthoritativeLeaderboard();
    const isSorted = lbData.every((item, i) => {
      if (i === 0) return true;
      const prev = lbData[i - 1];
      if (prev.disqualified !== item.disqualified) return !prev.disqualified && item.disqualified;
      return prev.points >= item.points;
    });
    record('Regression', 31, 'Leaderboard calculation is authoritative and deterministically ranked',
      Array.isArray(lbData) && lbData.length > 0 && isSorted,
      `Total teams: ${lbData.length}, Ranked correctly: ${isSorted}`
    );

    // 5.9 JWT AES-256-GCM Cookie encryption & Server-side decryption roundtrip
    const sampleToken = generateToken('user_test_1', 'test@xtract.org', 'PARTICIPANT', 'TEAM-01', 'TestTeam');
    const encryptedCookie = encryptToken(sampleToken);
    const decryptedServerToken = decryptTokenServerOnly(encryptedCookie);
    const tamperedCookie = encryptedCookie.substring(0, encryptedCookie.length - 4) + 'zzzz';
    const tamperedDecrypt = decryptTokenServerOnly(tamperedCookie);
    record('Regression', 32, 'AES-256-GCM cookie encryption & tamper resistance verified',
      decryptedServerToken === sampleToken && tamperedDecrypt === null,
      `Decrypted matched: ${decryptedServerToken === sampleToken}, Tamper rejected: ${tamperedDecrypt === null}`
    );

    // 5.10 Socket.IO room security & connection authentication
    const clientSocket = ClientIO(`http://127.0.0.1:${port}`, {
      auth: { token: team1Token },
      transports: ['websocket'],
      autoConnect: false
    });

    const statusPromise = new Promise((resolve) => {
      clientSocket.on('team:status', (data) => {
        resolve(data.teamId === 'TEAM-01' && data.room === 'team:TEAM-01');
      });
      setTimeout(() => resolve(false), 2000);
    });

    const connectPromise = new Promise((resolve) => {
      clientSocket.on('connect', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });

    clientSocket.connect();

    const socketConnected = await connectPromise;
    const teamStatusReceived = await statusPromise;

    clientSocket.disconnect();

    record('Regression', 33, 'Socket.IO handshake derives team room strictly from verified JWT',
      socketConnected && teamStatusReceived,
      `Connected: ${socketConnected}, Team Room Verified: ${teamStatusReceived}`
    );

  } catch (err) {
    console.error('Fatal audit suite error:', err);
  } finally {
    if (socketServer) socketServer.close();
    if (server) server.close();
  }

  // Summary
  console.log('\n======================================================================');
  console.log('   AUDIT EXECUTION SUMMARY');
  console.log('======================================================================');
  const passedCount = auditResults.filter((r) => r.status === 'PASSED').length;
  const failedCount = auditResults.filter((r) => r.status === 'FAILED').length;
  console.log(`TOTAL AUDIT CHECKS: ${auditResults.length}`);
  console.log(`PASSED:             ${passedCount}/${auditResults.length}`);
  console.log(`FAILED:             ${failedCount}/${auditResults.length}`);
  console.log('======================================================================\n');

  if (failedCount > 0) {
    process.exitCode = 1;
  }
};

runAudit();
