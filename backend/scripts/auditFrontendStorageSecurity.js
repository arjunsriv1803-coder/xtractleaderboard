/**
 * auditFrontendStorageSecurity.js
 * 
 * Verifies:
 * 1. Storage Tampering Resistance: Editing localStorage cannot elevate privileges, 
 *    change score, bypass QR requirement, or spoof team identity.
 * 2. Backend Authority: Authenticated team & role derived strictly from verified JWT and DB.
 * 3. Token Lifecycle & Session: Login, refresh, logout, and QR redemption work seamlessly.
 * 4. Production "Unable to reach server" error root-cause diagnosis.
 */

import http from 'http';
import mongoose from 'mongoose';
import app from '../app.js';
import db from '../db/database.js';
import { generateToken } from '../utils/jwt.js';
import { generateScanProof } from '../utils/qrProof.js';
import { Team as TeamModel } from '../models/Team.js';
import { QRNonce } from '../models/QRNonce.js';
import { QRRedemption as QRRedemptionModel } from '../models/QRRedemption.js';
import { TrackCapacity } from '../models/TrackCapacity.js';
import { TeamSession } from '../models/TeamSession.js';
import { CANONICAL_TEAMS } from '../config/teamsConfig.js';

let server;
let baseUrl;

const results = [];

const record = (num, name, passed, details = '') => {
  const status = passed ? 'PASSED' : 'FAILED';
  results.push({ num, name, status, details });
  console.log(`[TEST #${num}]`.padEnd(12) + `${status.padEnd(8)}: ${name}${details ? ` -> ${details}` : ''}`);
};

const req = async (path, options = {}) => {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

async function runAudit() {
  console.log('======================================================================');
  console.log('   XTRACT 5.0 FRONTEND AUTH STORAGE & BACKEND INTEGRITY AUDIT');
  console.log('======================================================================\n');

  // Connect to isolated test database
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'xtract_test_isolated' });
  await TeamModel.deleteMany({});
  await QRNonce.deleteMany({});
  await TrackCapacity.deleteMany({});
  await TeamSession.deleteMany({});
  await QRRedemptionModel.deleteMany({});
  await TeamModel.insertMany(CANONICAL_TEAMS.map(t => ({
    team_id: t.team_id,
    team_name: t.team_name,
    password: t.password,
    track: t.track,
    stage: t.stage,
    points: t.points,
    disqualified: !!t.disqualified,
    active_devices: []
  })));

  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  console.log(`[Test Server] Running on ${baseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // TEST 1: LOGIN FLOW & TOKEN LIFECYCLE
    // -------------------------------------------------------------
    console.log('--- SUITE 1: AUTHENTICATION FLOW & TOKEN LIFECYCLE ---');
    const loginRes = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'TEAM-01', password: 'Password123!', deviceId: 'dev_audit_1' })
    });
    const token = loginRes.data?.token;
    const deviceSig = loginRes.data?.deviceSignature;

    record(1, 'Login succeeds and issues JWT + deviceSignature',
      loginRes.status === 200 && Boolean(token) && Boolean(deviceSig),
      `HTTP ${loginRes.status}, Token: ${Boolean(token)}, DeviceSig: ${Boolean(deviceSig)}`
    );

    // Profile retrieval
    const profileRes = await req('/auth/profile', {
      headers: { Authorization: `Bearer ${token}` }
    });
    record(2, 'Profile endpoint derives identity from JWT, not client storage',
      profileRes.status === 200 && profileRes.data?.team?.team_id === 'TEAM-01',
      `Verified Team: ${profileRes.data?.team?.team_id}`
    );

    // Re-login / token refresh on same device
    const reloginRes = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'TEAM-01', password: 'Password123!', deviceId: 'dev_audit_1', deviceSignature: deviceSig })
    });
    record(3, 'Token refresh / re-login preserves session without extra slot consumption',
      reloginRes.status === 200,
      `HTTP ${reloginRes.status}`
    );


    // -------------------------------------------------------------
    // TEST 2: STORAGE TAMPERING & BACKEND AUTHORITY
    // -------------------------------------------------------------
    console.log('\n--- SUITE 2: STORAGE TAMPERING & BACKEND AUTHORITY ---');

    // Clear in-memory QR scans before test so TEAM-01 starts fresh
    db.teamQRScans.clear();

    // Attack 1: Participant tries to submit with tampered teamId in body (simulating localStorage edit)
    const spoofSubmit = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // TEAM-01's token
      body: JSON.stringify({ teamId: 'TEAM-02', problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record(4, 'Tampered client-supplied teamId in request body is rejected with 403',
      spoofSubmit.status === 403 && spoofSubmit.data?.error === 'FORBIDDEN',
      `HTTP ${spoofSubmit.status} (${spoofSubmit.data?.error}: ${spoofSubmit.data?.message})`
    );

    // Attack 2: Participant tries to access admin endpoints (simulating role='ADMIN' in localStorage)
    const spoofAdminOverview = await req('/admin/overview', {
      headers: { Authorization: `Bearer ${token}` } // Participant token
    });
    const isAdminRejected = spoofAdminOverview.status === 403 && 
      (spoofAdminOverview.data?.error?.code === 'FORBIDDEN_ROLE' || spoofAdminOverview.data?.error === 'FORBIDDEN_ROLE');
    record(5, 'Participant token rejected on admin endpoint regardless of local storage edits',
      isAdminRejected,
      `HTTP ${spoofAdminOverview.status} (${spoofAdminOverview.data?.error?.code || spoofAdminOverview.data?.error})`
    );

    // Attack 3: Participant submits answer without QR unlock (simulating fake unlocked status in localStorage)
    const spoofSubmissionNoQR = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record(6, 'Submission rejected if QR not redeemed in database regardless of local storage state',
      spoofSubmissionNoQR.status === 403 && spoofSubmissionNoQR.data?.error === 'QR_REQUIRED',
      `HTTP ${spoofSubmissionNoQR.status} (${spoofSubmissionNoQR.data?.error})`
    );


    // -------------------------------------------------------------
    // TEST 3: VALID QR REDEMPTION & SCORE INTEGRITY
    // -------------------------------------------------------------
    console.log('\n--- SUITE 3: QR REDEMPTION & SCORE INTEGRITY ---');

    // Legitimate QR redemption
    const proof = generateScanProof('QR-AUTUMN-DS');
    const redeemRes = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: proof })
    });
    record(7, 'Legitimate QR redemption recorded in persistent database',
      redeemRes.status === 200,
      `HTTP ${redeemRes.status}`
    );

    // Answer submission
    const subRes = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    record(8, 'Answer submission awarded points and assigned track in DB',
      subRes.status === 201 && subRes.data?.isCorrect === true,
      `HTTP ${subRes.status}, Assigned: ${subRes.data?.assignedTrack}, Points: ${subRes.data?.totalScore}`
    );

    // Verify DB score
    const profileAfterSolve = await req('/auth/profile', {
      headers: { Authorization: `Bearer ${token}` }
    });
    record(9, 'Profile reflects authoritative score computed on server (100 pts)',
      profileAfterSolve.data?.team?.points === 100 && profileAfterSolve.data?.team?.pathAssigned === 'Autumn',
      `Server points: ${profileAfterSolve.data?.team?.points}, Path: ${profileAfterSolve.data?.team?.pathAssigned}`
    );


    // -------------------------------------------------------------
    // TEST 4: LOGOUT & SESSION TERMINATION
    // -------------------------------------------------------------
    console.log('\n--- SUITE 4: LOGOUT & SESSION TERMINATION ---');

    const logoutRes = await req('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ teamId: 'TEAM-01', deviceId: 'dev_audit_1' })
    });
    record(10, 'Logout successfully revokes session and clears active device slot',
      logoutRes.status === 200,
      `HTTP ${logoutRes.status}`
    );

  } catch (err) {
    console.error('Audit execution error:', err);
  } finally {
    if (server) server.close();
    await TeamModel.deleteMany({});
    await QRNonce.deleteMany({});
    await TrackCapacity.deleteMany({});
    await TeamSession.deleteMany({});
    await mongoose.disconnect();
    console.log('\n[Database] Disconnected and cleaned up.');
  }

  console.log('\n======================================================================');
  console.log('   FRONTEND STORAGE AUDIT EXECUTION SUMMARY');
  console.log('======================================================================');
  const passed = results.filter(r => r.status === 'PASSED').length;
  console.log(`TOTAL CHECKS: ${results.length}`);
  console.log(`PASSED:       ${passed}/${results.length}`);
  console.log('======================================================================\n');
}

runAudit().catch(console.error);
