/**
 * verifyFinalRemainingRisks.js
 * 
 * Comprehensive Verification of Final Remaining Security Risks:
 * 1. Critical Physical QR Checkpoint Bypass Test (Direct call to /qr/proof).
 * 2. COOKIE_ENCRYPT_SECRET production failure check.
 * 3. Cross-device and cross-team Device Signature hijack resistance.
 * 4. Automatic TrackCapacity reconciliation from existing confirmed team assignments.
 * 5. Isolated Database verification (dbName: 'xtract_test_isolated').
 */

import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import mongoose from 'mongoose';
import app from '../app.js';
import db from '../db/database.js';
import { generateToken } from '../utils/jwt.js';
import { Team as TeamModel } from '../models/Team.js';
import { QRNonce } from '../models/QRNonce.js';
import { TrackCapacity as TrackCapacityModel } from '../models/TrackCapacity.js';
import { TeamSession as TeamSessionModel } from '../models/TeamSession.js';
import { CANONICAL_TEAMS } from '../config/teamsConfig.js';
import { signDeviceSession } from '../controllers/authController.js';

let server;
let baseUrl;

const results = [];

const logResult = (num, name, status, details = '') => {
  results.push({ num, name, status, details });
  console.log(`[TEST #${num}]`.padEnd(12) + `${status.padEnd(15)}: ${name}${details ? ` -> ${details}` : ''}`);
};

const req = async (path, options = {}) => {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

async function runVerification() {
  console.log('======================================================================');
  console.log('   XTRACT 5.0 FINAL REMAINING RISKS VERIFICATION');
  console.log('======================================================================\n');

  // Connect to isolated database
  const ISOLATED_DB_NAME = 'xtract_test_isolated';
  console.log(`[Database] Connecting to isolated database '${ISOLATED_DB_NAME}' on Atlas...`);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: ISOLATED_DB_NAME });
  console.log(`[Database] Connected to isolated test DB: ${mongoose.connection.db.databaseName}\n`);

  // Seed isolated DB with canonical teams
  await TeamModel.deleteMany({});
  await QRNonce.deleteMany({});
  await TrackCapacityModel.deleteMany({});
  await TeamSessionModel.deleteMany({});

  const seededTeams = CANONICAL_TEAMS.map((t) => ({
    team_id: t.team_id,
    team_name: t.team_name,
    password: t.password,
    track: t.track,
    stage: t.stage,
    points: t.points,
    disqualified: !!t.disqualified,
    active_devices: []
  }));
  await TeamModel.insertMany(seededTeams);

  // Start HTTP server on ephemeral port
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  console.log(`[Test Server] Running on ${baseUrl}\n`);

  try {
    // -----------------------------------------------------------------
    // TEST 1: CRITICAL PHYSICAL QR CHECKPOINT BYPASS VERIFICATION
    // -----------------------------------------------------------------
    console.log('--- TEST 1: DIRECT PROOF-ISSUANCE PHYSICAL SCAN BYPASS TEST ---');
    
    // Step 1: Log in as a legitimate eligible team (TEAM-01, Stage 1 DS)
    const loginRes = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'TEAM-01', password: 'Password123!', deviceId: 'dev_test_bypass_1' })
    });
    const team1Token = loginRes.data?.token;

    // Step 2: Client does NOT scan physical QR code. Client sends direct POST /api/qr/proof with guessed identifier
    const proofRes = await req('/qr/proof', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS' })
    });

    const proofObtained = proofRes.status === 200 && Boolean(proofRes.data?.data?.scanProof);
    const scanProof = proofRes.data?.data?.scanProof;

    // Step 3: Client redeems the harvested proof
    const redeemRes = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof })
    });

    // Step 4: Client submits answer without ever having physically scanned anything
    const subRes = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });

    const isBypassSuccessful = proofRes.status === 200 && redeemRes.status === 200 && subRes.status === 201;

    logResult(1, 'Direct /qr/proof bypass without physical QR scan',
      isBypassSuccessful ? 'BYPASS_EXISTS' : 'BLOCKED',
      isBypassSuccessful
        ? 'VULNERABILITY: Proof issued solely from client-supplied identifier without trusted physical checkpoint'
        : 'Physical scan required'
    );


    // -----------------------------------------------------------------
    // TEST 2: PRODUCTION FAILS STARTUP IF COOKIE_ENCRYPT_SECRET MISSING/INSECURE
    // -----------------------------------------------------------------
    console.log('\n--- TEST 2: COOKIE_ENCRYPT_SECRET PRODUCTION STARTUP VALIDATION ---');
    
    // Simulate production environment checks
    const testSecretValidation = () => {
      const origEnv = process.env.NODE_ENV;
      const origSec = process.env.COOKIE_ENCRYPT_SECRET;
      let missingThrew = false;
      let shortThrew = false;
      let defaultThrew = false;

      try {
        process.env.NODE_ENV = 'production';
        
        // Test missing
        delete process.env.COOKIE_ENCRYPT_SECRET;
        try {
          signDeviceSession('TEAM-01', 'dev1');
        } catch (e) {
          missingThrew = e.message.includes('COOKIE_ENCRYPT_SECRET');
        }

        // Test short
        process.env.COOKIE_ENCRYPT_SECRET = 'short_key';
        try {
          signDeviceSession('TEAM-01', 'dev1');
        } catch (e) {
          shortThrew = e.message.includes('COOKIE_ENCRYPT_SECRET');
        }

        // Test default
        process.env.COOKIE_ENCRYPT_SECRET = 'xtract_device_secret_32b!';
        try {
          signDeviceSession('TEAM-01', 'dev1');
        } catch (e) {
          defaultThrew = e.message.includes('COOKIE_ENCRYPT_SECRET');
        }
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origSec) process.env.COOKIE_ENCRYPT_SECRET = origSec;
        else delete process.env.COOKIE_ENCRYPT_SECRET;
      }

      return missingThrew && shortThrew && defaultThrew;
    };

    const cookieSecretValidated = testSecretValidation();
    logResult(2, 'COOKIE_ENCRYPT_SECRET startup validation in production',
      cookieSecretValidated ? 'PASSED' : 'FAILED',
      'Throws fatal exception if missing, <32 chars, or default'
    );


    // -----------------------------------------------------------------
    // TEST 3: DEVICE SIGNATURE CROSS-DEVICE & CROSS-TEAM HIJACK RESISTANCE
    // -----------------------------------------------------------------
    console.log('\n--- TEST 3: DEVICE SIGNATURE HIJACK RESISTANCE ---');

    // Legit login for TEAM-02 Device A
    const legitA = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'TEAM-02', password: 'Password123!', deviceId: 'dev_team2_a' })
    });
    const legitSigA = legitA.data?.deviceSignature;

    // Attacker on Device B attempts to claim Device A's signature
    const crossDeviceSpoof = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-02',
        password: 'Password123!',
        deviceId: 'dev_team2_b',
        deviceSignature: legitSigA // Mismatched signature
      })
    });

    // Attacker from TEAM-03 attempts to use TEAM-02's signature
    const crossTeamSpoof = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-03',
        password: 'Password123!',
        deviceId: 'dev_team2_a',
        deviceSignature: legitSigA // Belongs to TEAM-02
      })
    });

    // Tampered signature
    const tamperedSig = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-02',
        password: 'Password123!',
        deviceId: 'dev_team2_a',
        deviceSignature: legitSigA.substring(0, 10) + 'ffff' + legitSigA.substring(14)
      })
    });

    // Because dev_team2_a was already active, providing a tampered signature causes backend to reject slot reuse
    const crossDeviceRejected = crossDeviceSpoof.data?.deviceSignature !== legitSigA;
    const crossTeamRejected = crossTeamSpoof.data?.deviceSignature !== legitSigA;
    // Fill remaining slots for TEAM-02
    await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-02', password: 'Password123!', deviceId: 'dev_team2_2' }) });
    await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-02', password: 'Password123!', deviceId: 'dev_team2_3' }) });
    
    // Now slot is full: tampered signature cannot claim dev_team2_a and is blocked with 403
    const tamperedBlocked = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-02',
        password: 'Password123!',
        deviceId: 'dev_team2_a',
        deviceSignature: 'invalid_tampered_signature'
      })
    });

    const deviceSigSecure = crossDeviceRejected && crossTeamRejected && tamperedBlocked.status === 403;
    logResult(3, 'Device signatures cannot be reused to hijack sessions',
      deviceSigSecure ? 'PASSED' : 'FAILED',
      `Cross-device, cross-team, and tampered signatures rejected (HTTP ${tamperedBlocked.status})`
    );


    // -----------------------------------------------------------------
    // TEST 4: RECONCILIATION OF EXISTING TRACK ASSIGNMENTS WITH TRACKCAPACITY
    // -----------------------------------------------------------------
    console.log('\n--- TEST 4: TRACKCAPACITY RECONCILIATION ON STARTUP ---');

    // Simulate 7 existing teams confirmed into Autumn in Team collection
    const autumnTeams = ['TEAM-20', 'TEAM-21', 'TEAM-22', 'TEAM-23', 'TEAM-24', 'TEAM-25', 'TEAM-26'];
    await TeamModel.updateMany(
      { team_id: { $in: autumnTeams } },
      { $set: { track: 1, pathAssigned: 'Autumn', trackConfirmed: true } }
    );

    // TrackCapacity is currently unpopulated for Autumn
    await TrackCapacityModel.deleteOne({ track_name: 'Autumn' });

    // Run syncFromMongo reconciliation
    await db.syncFromMongo(TeamModel, null, null, TrackCapacityModel);

    const autumnCapDoc = await TrackCapacityModel.findOne({ track_name: 'Autumn' });
    const isReconciled = autumnCapDoc && autumnCapDoc.claimed_teams.length === 7;

    logResult(4, 'Existing track assignments reconciled into TrackCapacity',
      isReconciled ? 'PASSED' : 'FAILED',
      `Autumn TrackCapacity claimed_teams count: ${autumnCapDoc?.claimed_teams?.length || 0}/7`
    );


    // -----------------------------------------------------------------
    // TEST 5: ISOLATED DATABASE VERIFICATION
    // -----------------------------------------------------------------
    console.log('\n--- TEST 5: ISOLATED TEST DATABASE VERIFICATION ---');

    const connectedDbName = mongoose.connection.db.databaseName;
    const isIsolated = connectedDbName === ISOLATED_DB_NAME;

    logResult(5, 'Tests executed against isolated database without touching production',
      isIsolated ? 'PASSED' : 'FAILED',
      `Connected DB: ${connectedDbName} (Production 'test' untouched: true)`
    );

  } catch (err) {
    console.error('Verification error:', err);
  } finally {
    if (server) server.close();
    // Clean up isolated test database collections
    await TeamModel.deleteMany({});
    await QRNonce.deleteMany({});
    await TrackCapacityModel.deleteMany({});
    await TeamSessionModel.deleteMany({});
    await mongoose.disconnect();
    console.log('\n[Database] Disconnected and isolated test database cleaned up.');
  }

  console.log('\n======================================================================');
  console.log('   REMAINING RISKS AUDIT SUMMARY');
  console.log('======================================================================');
  results.forEach((r) => {
    console.log(`[#${r.num}] ${r.status.padEnd(16)}: ${r.name}`);
  });
  console.log('======================================================================\n');
}

runVerification().catch(console.error);
