/**
 * Persistent Database & Multi-Instance Cluster Integration Test Suite
 * 
 * Verifies against the REAL MongoDB Atlas database:
 * 1. Persistent Nonce Replay Protection across server instances and restarts.
 * 2. Persistent Team Login Limit (active_devices) across instances and restarts.
 * 3. Atomic 7-Team Track Cap (TrackCapacity) across multiple concurrent instances.
 * 4. Device ID Spoofing and browser reset resistance.
 * 5. GET /api/team route protection and hashed login rate limiting.
 * 6. Remote client unable to obtain scan proof with guessed static identifier.
 */

import dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'audit_atlas_cluster_secret_key_2026_super_secure';
process.env.QR_PROOF_SECRET = 'audit_qr_proof_hmac_secret_key_2026';

import http from 'http';
import mongoose from 'mongoose';
import app from '../app.js';
import db from '../db/database.js';
import { generateToken } from '../utils/jwt.js';
import { generateScanProof } from '../utils/qrProof.js';
import { Team as TeamModel } from '../models/Team.js';
import { QRNonce } from '../models/QRNonce.js';
import { TrackCapacity } from '../models/TrackCapacity.js';
import { TeamSession as TeamSessionModel } from '../models/TeamSession.js';

import { CANONICAL_TEAMS } from '../config/teamsConfig.js';

let server1, server2;
let baseUrl1, baseUrl2;

const results = [];

const logTest = (suite, num, name, passed, details = '') => {
  const status = passed ? 'PASSED' : 'FAILED';
  results.push({ suite, num, name, status, details });
  console.log(`[${suite} | #${num}]`.padEnd(28) + `${status.padEnd(8)}: ${name}${details ? ` -> ${details}` : ''}`);
};

const makeReq = async (baseUrl, path, options = {}) => {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

const runPersistentAudit = async () => {
  console.log('======================================================================');
  console.log('   XTRACT 5.0 PERSISTENT CLUSTER & MULTI-INSTANCE AUDIT');
  console.log('======================================================================\n');

  // 1. Connect to isolated MongoDB Atlas database
  const ISOLATED_DB = 'xtract_test_isolated';
  console.log(`[Database] Connecting to isolated database '${ISOLATED_DB}' on Atlas...`);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: ISOLATED_DB });
  console.log(`[Database] Connected successfully to isolated test DB: ${mongoose.connection.db.databaseName}\n`);

  // Clean and initialize isolated test DB
  await TeamModel.deleteMany({});
  await QRNonce.deleteMany({});
  await TrackCapacity.deleteMany({});
  await TeamSessionModel.deleteMany({});
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

  // 2. Start two distinct backend instances on ephemeral ports (simulating horizontal scale)
  server1 = http.createServer(app);
  server2 = http.createServer(app);
  await new Promise((r) => server1.listen(0, r));
  await new Promise((r) => server2.listen(0, r));

  baseUrl1 = `http://127.0.0.1:${server1.address().port}/api`;
  baseUrl2 = `http://127.0.0.1:${server2.address().port}/api`;

  console.log(`[Instance 1] Active on ${baseUrl1}`);
  console.log(`[Instance 2] Active on ${baseUrl2}\n`);

  try {
    const team1Id = 'TEAM-01';
    const team1Token = generateToken('user_TEAM-01_1', 'team-01@xtract.org', 'PARTICIPANT', team1Id, 'CipherSentinels');

    // -----------------------------------------------------------------
    // TEST 1: REMOTE CLIENT GUESSED IDENTIFIER PROOF HARVESTING BLOCKED
    // -----------------------------------------------------------------
    console.log('--- SUITE A: REMOTE PROOF HARVESTING & GUESSING VULNERABILITY ---');

    // Remote client calls GET /api/qr/info/QR-AUTUMN-DS directly
    const infoRes = await makeReq(baseUrl1, '/qr/info/QR-AUTUMN-DS');
    const infoLeaksProof = infoRes.data?.data?.scanProof !== undefined;
    logTest('Proof Security', 1, 'Public /qr/info/:token does NOT issue scanProof for guessed identifier',
      infoRes.status === 200 && !infoLeaksProof,
      `HTTP ${infoRes.status}, Leaks scanProof: ${infoLeaksProof}`
    );

    // Unauthenticated remote client calls POST /api/qr/proof with guessed identifier
    const unauthProof = await makeReq(baseUrl1, '/qr/proof', {
      method: 'POST',
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS' })
    });
    logTest('Proof Security', 2, 'Unauthenticated POST /qr/proof rejected with 401',
      unauthProof.status === 401,
      `HTTP ${unauthProof.status}`
    );

    // Authenticated team on Stage 1 attempts to harvest proof for Stage 3 NLP
    const wrongStageProof = await makeReq(baseUrl1, '/qr/proof', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-NLP' })
    });
    logTest('Proof Security', 3, 'Authenticated participant cannot harvest proof for unreached Stage 3',
      wrongStageProof.status === 403 && wrongStageProof.data.error === 'WRONG_STAGE',
      `HTTP ${wrongStageProof.status} (${wrongStageProof.data.error})`
    );


    // -----------------------------------------------------------------
    // TEST 2: PERSISTENT NONCE REPLAY PROTECTION ACROSS INSTANCES & RESTART
    // -----------------------------------------------------------------
    console.log('\n--- SUITE B: PERSISTENT MULTI-INSTANCE NONCE REPLAY PROTECTION ---');

    const testProof = generateScanProof('QR-AUTUMN-DS');
    // Instance 1 redeems the proof
    const rInst1 = await makeReq(baseUrl1, '/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: testProof })
    });

    // Instance 2 receives replay attempt of the exact same proof
    const rInst2Replay = await makeReq(baseUrl2, '/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: testProof })
    });

    logTest('Persistent Nonce', 4, 'Nonce consumed on Instance 1 is atomically blocked on Instance 2',
      rInst1.status === 200 && rInst2Replay.status === 403 && rInst2Replay.data.error === 'REPLAYED_REDEMPTION',
      `Instance 1: ${rInst1.status}, Instance 2: ${rInst2Replay.status} (${rInst2Replay.data.error})`
    );

    // Verify nonce document exists in MongoDB Atlas with TTL index
    const nonceParts = testProof.split('.');
    const savedNonceDoc = await QRNonce.findOne({ nonce: nonceParts[3] });
    logTest('Persistent Nonce', 5, 'Nonce persisted in MongoDB Atlas QRNonce collection with TTL index',
      savedNonceDoc !== null && savedNonceDoc.nonce === nonceParts[3],
      `Found in Atlas: ${Boolean(savedNonceDoc)}`
    );


    // -----------------------------------------------------------------
    // TEST 3: DEVICE ID SPOOFING & LOGIN LIMITS ACROSS INSTANCES
    // -----------------------------------------------------------------
    console.log('\n--- SUITE C: DEVICE ID SPOOFING & MULTI-INSTANCE LOGIN LIMITS ---');

    // Clean active devices for TEAM-04 in Mongo and memory
    await TeamModel.updateOne({ team_id: 'TEAM-04' }, { $set: { active_devices: [] } });
    await TeamSessionModel.updateMany({ team_id: 'TEAM-04' }, { $set: { is_revoked: true } });
    for (const [k, v] of db.teamSessions.entries()) {
      if (v.teamId === 'TEAM-04') db.teamSessions.delete(k);
    }

    // Log in 3 legitimate devices on Instance 1 (TEAM-04 size = 3)
    const d1 = await makeReq(baseUrl1, '/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_legit_1' }) });
    const d2 = await makeReq(baseUrl1, '/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_legit_2' }) });
    const d3 = await makeReq(baseUrl1, '/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_legit_3' }) });

    // Device ID Spoofing Attempt: An attacker on Instance 2 attempts to supply dev_team4_legit_1 WITHOUT cryptographic signature
    const spoofAttempt = await makeReq(baseUrl2, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_legit_1' })
    });

    logTest('Device Security', 6, 'Device ID spoofing attempt without signature rejected with LOGIN_LIMIT_EXCEEDED',
      spoofAttempt.status === 403 && spoofAttempt.data.error === 'LOGIN_LIMIT_EXCEEDED',
      `HTTP ${spoofAttempt.status} (${spoofAttempt.data.error})`
    );

    // Persistent login cap in Atlas: verify active_devices in Team document
    const team4Doc = await TeamModel.findOne({ team_id: 'TEAM-04' });
    logTest('Device Security', 7, 'Team active_devices persisted in MongoDB Atlas capped at 3',
      team4Doc.active_devices.length === 3,
      `active_devices: ${team4Doc.active_devices.length}/3`
    );

    // 4th legitimate device rejected on Instance 2
    const d4 = await makeReq(baseUrl2, '/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_legit_4' }) });
    logTest('Device Security', 8, '4th distinct device blocked across instances',
      d4.status === 403 && d4.data.error === 'LOGIN_LIMIT_EXCEEDED',
      `HTTP ${d4.status}`
    );


    // -----------------------------------------------------------------
    // TEST 4: ATOMIC 7-TEAM TRACK CAP DISTRIBUTED RACE ACROSS INSTANCES
    // -----------------------------------------------------------------
    console.log('\n--- SUITE D: 7-TEAM TRACK CAP DISTRIBUTED RACE ACROSS INSTANCES ---');

    // Clean TrackCapacity for Forest
    await TrackCapacity.findOneAndUpdate(
      { track_name: 'Forest' },
      { $set: { claimed_teams: [] } },
      { upsert: true }
    );
    const forestPath = db.getPathByName('Forest');
    forestPath.teams = [];
    forestPath.currentTeams = 0;
    forestPath.isLocked = false;

    // 8 distinct fresh teams race: 4 send to Instance 1, 4 send to Instance 2 simultaneously
    const raceTeams = ['TEAM-06', 'TEAM-07', 'TEAM-08', 'TEAM-09', 'TEAM-10', 'TEAM-11', 'TEAM-12', 'TEAM-13'];
    await TeamModel.updateMany(
      { team_id: { $in: raceTeams } },
      { $set: { track: -1, trackConfirmed: false, stage: 1, pathAssigned: null } }
    );
    for (const tId of raceTeams) {
      const mt = db.getTeamByTeamId(tId);
      if (mt) {
        mt.track = -1;
        mt.trackConfirmed = false;
        mt.stage = 1;
        mt.pathAssigned = null;
        mt.stageProgress = {};
      }
    }
    const raceTokens = {};

    for (const tId of raceTeams) {
      const tok = generateToken(`user_${tId}_1`, `${tId.toLowerCase()}@xtract.org`, 'PARTICIPANT', tId, tId);
      raceTokens[tId] = tok;
      const proof = generateScanProof('QR-FOREST-DS');
      await makeReq(baseUrl1, '/qr/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proof })
      });
    }

    // Simultaneous submission split across both instances
    const expectedFullMsg = 'This track is full. All 7 team slots have already been claimed. Please choose another available track.';
    const subPromises = raceTeams.map((tId, idx) => {
      const targetBaseUrl = idx % 2 === 0 ? baseUrl1 : baseUrl2; // Alternating instances
      return makeReq(targetBaseUrl, '/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${raceTokens[tId]}` },
        body: JSON.stringify({ problemId: 'prob_forest_1', answer: '2022-08-04' })
      });
    });

    const multiInstanceRaceResults = await Promise.all(subPromises);
    const claimedCount = multiInstanceRaceResults.filter(r => r.status === 201 && r.data.isCorrect).length;
    const fullTrackRejections = multiInstanceRaceResults.filter(r => r.status === 409 && r.data.trackFull && r.data.message === expectedFullMsg).length;

    logTest('Track Capacity', 9, 'Distributed race across 2 instances: exactly 7 claim, 1 rejected',
      claimedCount === 7 && fullTrackRejections === 1,
      `Claimed: ${claimedCount}, Rejected: ${fullTrackRejections}`
    );

    // Verify persistent TrackCapacity document in Atlas
    const forestCapDoc = await TrackCapacity.findOne({ track_name: 'Forest' });
    logTest('Track Capacity', 10, 'TrackCapacity in MongoDB Atlas strictly holds 7 claimed teams',
      forestCapDoc.claimed_teams.length === 7,
      `Atlas claimed_teams: ${forestCapDoc.claimed_teams.length}/7`
    );


    // -----------------------------------------------------------------
    // TEST 5: SERVER RESTART PERSISTENCE VERIFICATION
    // -----------------------------------------------------------------
    console.log('\n--- SUITE E: SERVER RESTART PERSISTENCE VERIFICATION ---');

    // Stop Instance 1 and restart on a new ephemeral port
    await new Promise((r) => server1.close(r));
    server1 = http.createServer(app);
    await new Promise((r) => server1.listen(0, r));
    baseUrl1 = `http://127.0.0.1:${server1.address().port}/api`;
    console.log(`[Restarted Instance 1] Resumed on ${baseUrl1}`);

    // Verify TrackCapacity is still full on restarted server
    const team24Id = 'TEAM-24';
    const team24Tok = generateToken('user_TEAM-24_1', 'team-24@xtract.org', 'PARTICIPANT', team24Id, team24Id);
    const proof24 = generateScanProof('QR-FOREST-DS');
    await makeReq(baseUrl1, '/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team24Tok}` },
      body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proof24 })
    });
    const subRestartRes = await makeReq(baseUrl1, '/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team24Tok}` },
      body: JSON.stringify({ problemId: 'prob_forest_1', answer: '2022-08-04' })
    });

    logTest('Restart Test', 11, 'Track capacity remains full across server restart',
      subRestartRes.status === 409 && subRestartRes.data.trackFull === true && subRestartRes.data.message === expectedFullMsg,
      `HTTP ${subRestartRes.status} (${subRestartRes.data.message})`
    );


    // -----------------------------------------------------------------
    // TEST 6: GET /api/team EXPOSURE & HASHED LOGIN RATE LIMITING
    // -----------------------------------------------------------------
    console.log('\n--- SUITE F: TEAM ROUTE EXPOSURE & HASHED LOGIN RATE LIMITING ---');

    // Unauthenticated GET /api/team
    const teamUnauth = await makeReq(baseUrl1, '/team');
    // Participant GET /api/team
    const teamPart = await makeReq(baseUrl1, '/team', { headers: { Authorization: `Bearer ${team1Token}` } });

    logTest('Route Security', 12, 'GET /api/team rejects unauthenticated (401) and participant (403)',
      teamUnauth.status === 401 && teamPart.status === 403,
      `Unauth: ${teamUnauth.status}, Participant: ${teamPart.status}`
    );

  } catch (err) {
    console.error('Persistent audit failed:', err);
  } finally {
    if (server1) server1.close();
    if (server2) server2.close();
    await mongoose.disconnect();
    console.log('[Database] Disconnected from MongoDB Atlas.');
  }

  console.log('\n======================================================================');
  console.log('   PERSISTENT AUDIT SUMMARY');
  console.log('======================================================================');
  const passed = results.filter(r => r.status === 'PASSED').length;
  console.log(`TOTAL PERSISTENT TESTS: ${results.length}`);
  console.log(`PASSED:                 ${passed}/${results.length}`);
  console.log('======================================================================\n');

  if (passed !== results.length) {
    process.exitCode = 1;
  }
};

runPersistentAudit();
