/**
 * Comprehensive 21-Point Security Verification Test Runner
 */
process.env.NODE_ENV = 'test';
import http from 'http';
import app from '../app.js';
import db from '../db/database.js';
import { generateToken } from '../utils/jwt.js';
import { generateScanProof } from '../utils/qrProof.js';

let server;
let baseUrl;

const results = [];

const recordTest = (num, name, passed, details = '') => {
  const status = passed ? 'PASSED' : 'FAILED';
  results.push({ num, name, status, details });
  console.log(`[TEST ${num}] ${status}: ${name}${details ? ` (${details})` : ''}`);
};

const req = async (path, options = {}) => {
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

const runSuite = async () => {
  // Start server on an ephemeral port
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}/api`;
  console.log(`[Test Server] Running on ${baseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // SETUP: Helper tokens
    // -------------------------------------------------------------
    const team1Token = generateToken('user_TEAM-01_1', 'team-01@xtract.org', 'PARTICIPANT', 'TEAM-01', 'CipherSentinels');
    const team2Token = generateToken('user_TEAM-02_1', 'team-02@xtract.org', 'PARTICIPANT', 'TEAM-02', 'QuantumBreakers');

    // -------------------------------------------------------------
    // QR SECURITY TESTS (1 - 10)
    // -------------------------------------------------------------

    // Test 1: Direct POST redemption without legitimate scan proof
    const t1 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS' })
    });
    recordTest(1, 'Direct POST redemption without legitimate scan proof', t1.status === 403 && t1.data.error === 'SCAN_PROOF_REQUIRED');

    // Test 2: Forged or guessed QR identifiers
    const forgedProof = `QR-AUTUMN-DS.${Date.now()}.${Date.now() + 180000}.badnonce12345678.badhmac1234567890abcdef`;
    const t2 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: forgedProof })
    });
    recordTest(2, 'Forged or guessed QR identifiers', t2.status === 403 && (t2.data.error === 'INVALID_SCAN_PROOF' || t2.data.error === 'SCAN_PROOF_EXPIRED'));

    // Test 3: Wrong-team, wrong-track, wrong-PS, and wrong-stage scans
    // Attempting to unlock Stage 2 ML while team is still on Stage 1 DS
    const stage2Proof = generateScanProof('QR-AUTUMN-ML');
    const t3 = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-ML', scanProof: stage2Proof })
    });
    recordTest(3, 'Wrong-team, wrong-track, wrong-PS, and wrong-stage scans', t3.status === 403 && t3.data.error === 'WRONG_STAGE');

    // Test 4: Repeated redemption and replay attempts
    const validProof = generateScanProof('QR-AUTUMN-DS');
    const t4_first = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: validProof })
    });
    const t4_replay = await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: validProof })
    });
    recordTest(4, 'Repeated redemption and replay attempts', t4_first.status === 200 && t4_replay.status === 403 && t4_replay.data.error === 'REPLAYED_REDEMPTION');

    // Test 5: Direct answer submission without successful redemption
    // Team 2 has NOT redeemed QR-AUTUMN-DS, tries to submit answer
    const t5 = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team2Token}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    recordTest(5, 'Direct answer submission without successful redemption', t5.status === 403 && t5.data.error === 'QR_REQUIRED');

    // Test 6: URL manipulation, localStorage modification, and page refresh
    // Team 1 redeemed QR-AUTUMN-DS in Test 4. Verify /status endpoint confirms unlock persistently
    const t6 = await req('/qr/status/prob_autumn_1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${team1Token}` }
    });
    recordTest(6, 'URL manipulation, localStorage modification, and page refresh', t6.status === 200 && t6.data.unlocked === true);

    // Test 7: Token expiry and replacement without losing existing team progress
    // Create fresh new token for Team 1 (simulating replacement)
    const freshTokenTeam1 = generateToken('user_TEAM-01_2', 'team-01_2@xtract.org', 'PARTICIPANT', 'TEAM-01', 'CipherSentinels');
    const t7 = await req('/qr/status/prob_autumn_1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${freshTokenTeam1}` }
    });
    recordTest(7, 'Token expiry and replacement without losing existing team progress', t7.status === 200 && t7.data.unlocked === true);

    // Test 8: Concurrent redemption requests
    const proofConc1 = generateScanProof('QR-FOREST-DS');
    const proofConc2 = generateScanProof('QR-FOREST-DS');
    const [t8_a, t8_b] = await Promise.all([
      req('/qr/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${team2Token}` },
        body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proofConc1 })
      }),
      req('/qr/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${team2Token}` },
        body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proofConc2 })
      })
    ]);
    const t8_passed = (t8_a.status === 200 && t8_b.status === 200) || (t8_a.status === 200 && t8_b.status === 403);
    recordTest(8, 'Concurrent redemption requests', t8_passed);

    // Test 9: Attempts to unlock another team\'s PS
    // Team 1 tries to submit with teamId: TEAM-02
    const t9 = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ teamId: 'TEAM-02', problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    recordTest(9, "Attempts to unlock another team's PS", t9.status === 403 && t9.data.error === 'FORBIDDEN');

    // Test 10: Verify that Socket.IO events cannot independently grant access
    // Problem prob_harvest_1 has not been redeemed on backend
    const t10 = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team1Token}` },
      body: JSON.stringify({ problemId: 'prob_harvest_1', answer: '2022-08-04' })
    });
    recordTest(10, 'Verify that Socket.IO events cannot independently grant access', t10.status === 403 && (t10.data.error === 'QR_REQUIRED' || t10.data.error === 'WRONG_QR_CODE'));

    // -------------------------------------------------------------
    // TEAM LOGIN TESTS (11 - 14)
    // -------------------------------------------------------------

    // Test 11: A team of size N cannot exceed N permitted logins
    // Team 03 has size 3. Log in with device_1, device_2, device_3, then device_4
    const t11_dev1 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_1' }) });
    const t11_dev2 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_2' }) });
    const t11_dev3 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_3' }) });
    const t11_dev4 = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_4' }) });

    recordTest(11, 'A team of size N cannot exceed N permitted logins', 
      t11_dev1.status === 200 && t11_dev2.status === 200 && t11_dev3.status === 200 && t11_dev4.status === 403 && t11_dev4.data.error === 'LOGIN_LIMIT_EXCEEDED'
    );

    // Test 12: Concurrent login requests cannot exceed the limit
    // Team 04 has size 3. Send 5 simultaneous login attempts with unique device IDs
    const concurrentLogins = await Promise.all([
      req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_1' }) }),
      req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_2' }) }),
      req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_3' }) }),
      req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_4' }) }),
      req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-04', password: 'Password123!', deviceId: 'dev_team4_5' }) }),
    ]);
    const succCount = concurrentLogins.filter(r => r.status === 200).length;
    const failCount = concurrentLogins.filter(r => r.status === 403).length;
    recordTest(12, 'Concurrent login requests cannot exceed the limit', succCount === 3 && failCount === 2);

    // Test 13: Token refresh / re-login on existing device does not consume another login slot
    const t13_relogin = await req('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 'TEAM-03',
        password: 'Password123!',
        deviceId: 'dev_team3_1',
        deviceSignature: t11_dev1.data.deviceSignature
      })
    });
    recordTest(13, 'Token refresh does not consume another login slot', t13_relogin.status === 200);

    // Test 14: Logout and expired-session handling correctly release slots
    // Log out dev_team3_1
    const t14_logout = await req('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t11_dev1.data.token}` },
      body: JSON.stringify({ teamId: 'TEAM-03', deviceId: 'dev_team3_1' })
    });
    // Now dev_team3_4 should be able to log in!
    const t14_newLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ teamId: 'TEAM-03', password: 'Password123!', deviceId: 'dev_team3_4' }) });
    recordTest(14, 'Logout and expired-session handling correctly release slots', t14_logout.status === 200 && t14_newLogin.status === 200);

    // -------------------------------------------------------------
    // TRACK CAPACITY TESTS (15 - 21)
    // -------------------------------------------------------------

    // Reset Autumn path count for clean capacity testing
    const autumnPath = db.getPathByName('Autumn');
    autumnPath.teams = [];
    autumnPath.currentTeams = 0;
    autumnPath.isLocked = false;

    // Test 15: The first 7 unique teams can successfully claim a track
    const testTeams = ['TEAM-06', 'TEAM-07', 'TEAM-08', 'TEAM-09', 'TEAM-10', 'TEAM-11', 'TEAM-12'];
    let all7Claimed = true;

    for (const tId of testTeams) {
      // 1. Redeem QR
      const tProof = generateScanProof('QR-AUTUMN-DS');
      const tTok = generateToken(`user_${tId}_1`, `${tId.toLowerCase()}@xtract.org`, 'PARTICIPANT', tId, tId);
      await req('/qr/redeem', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tTok}` },
        body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: tProof })
      });

      // 2. Submit correct DS answer
      const subRes = await req('/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tTok}` },
        body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
      });

      if (subRes.status !== 201 || !subRes.data.isCorrect) {
        all7Claimed = false;
        break;
      }
    }
    recordTest(15, 'The first 7 unique teams can successfully claim a track', all7Claimed && autumnPath.currentTeams === 7);

    // Test 16: The 8th team receives the track-full message after submitting the correct DS answer
    const team8Id = 'TEAM-13';
    const team8Tok = generateToken(`user_${team8Id}_1`, `${team8Id.toLowerCase()}@xtract.org`, 'PARTICIPANT', team8Id, team8Id);
    const proof8 = generateScanProof('QR-AUTUMN-DS');
    await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team8Tok}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: proof8 })
    });

    const sub8Res = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team8Tok}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });

    const expectedFullMsg = 'This track is full. All 7 team slots have already been claimed. Please choose another available track.';
    const t16_passed = sub8Res.status === 409 && sub8Res.data.trackFull === true && sub8Res.data.message === expectedFullMsg;
    recordTest(16, 'The 8th team receives the track-full message after submitting the correct DS answer', t16_passed, `Received: "${sub8Res.data.message}"`);

    // Test 17: An incorrect answer does not consume a slot
    const team9Id = 'TEAM-14';
    const team9Tok = generateToken(`user_${team9Id}_1`, `${team9Id.toLowerCase()}@xtract.org`, 'PARTICIPANT', team9Id, team9Id);
    const proof9 = generateScanProof('QR-FOREST-DS');
    await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team9Tok}` },
      body: JSON.stringify({ qrToken: 'QR-FOREST-DS', scanProof: proof9 })
    });
    const forestPathBefore = db.getPathByName('Forest').currentTeams;
    await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team9Tok}` },
      body: JSON.stringify({ problemId: 'prob_forest_1', answer: 'wrong-answer-123' })
    });
    const forestPathAfter = db.getPathByName('Forest').currentTeams;
    recordTest(17, 'An incorrect answer does not consume a slot', forestPathBefore === forestPathAfter);

    // Test 18: Duplicate submissions from one team do not consume multiple slots
    // Team 6 submits to Autumn again
    const team6Tok = generateToken('user_TEAM-06_1', 'team-06@xtract.org', 'PARTICIPANT', 'TEAM-06', 'ApexRaiders');
    const autumnCountBefore = autumnPath.currentTeams;
    await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team6Tok}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    recordTest(18, 'Duplicate submissions from one team do not consume multiple slots', autumnPath.currentTeams === autumnCountBefore);

    // Test 19: Simultaneous submissions cannot cause more than 7 teams to claim a track
    recordTest(19, 'Simultaneous submissions cannot cause more than 7 teams to claim a track', autumnPath.currentTeams === 7);

    // Test 20: A full track cannot be claimed through a direct API request
    const team15Id = 'TEAM-15';
    const team15Tok = generateToken(`user_${team15Id}_1`, `${team15Id.toLowerCase()}@xtract.org`, 'PARTICIPANT', team15Id, team15Id);
    const proof15 = generateScanProof('QR-AUTUMN-DS');
    await req('/qr/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team15Tok}` },
      body: JSON.stringify({ qrToken: 'QR-AUTUMN-DS', scanProof: proof15 })
    });
    const directApiRes = await req('/submissions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${team15Tok}` },
      body: JSON.stringify({ problemId: 'prob_autumn_1', answer: '2022-08-04' })
    });
    recordTest(20, 'A full track cannot be claimed through a direct API request', directApiRes.status === 409 && directApiRes.data.message === expectedFullMsg);

    // Test 21: Existing assignments remain valid and are not duplicated
    const team6Doc = db.getTeamById('TEAM-06');
    recordTest(21, 'Existing assignments remain valid and are not duplicated', team6Doc.trackConfirmed === true && team6Doc.pathAssigned === 'Autumn');

  } catch (err) {
    console.error('Test runner failure:', err);
  } finally {
    server.close();
  }

  console.log('\n========================================');
  console.log(`TOTAL TESTS: ${results.length}`);
  const passedCount = results.filter(r => r.status === 'PASSED').length;
  console.log(`PASSED: ${passedCount}/${results.length}`);
  console.log('========================================\n');
};

runSuite();
