import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment.');
  process.exit(1);
}

async function migrate() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const db = mongoose.connection.db;

  // 1. Migrate Teams collection
  console.log('\n--- 1. Migrating Teams Collection ---');
  const teamsCollection = db.collection('teams');
  const allTeams = await teamsCollection.find({}).toArray();
  console.log(`Found ${allTeams.length} teams in MongoDB.`);

  let teamsUpdated = 0;
  for (const team of allTeams) {
    let newPath = team.pathAssigned;
    let newTrack = team.track;
    let changed = false;

    const lowerPath = String(team.pathAssigned || '').trim().toLowerCase();

    // Map old names to new canonical names and tracks
    if (lowerPath === 'autumn' || lowerPath === 'volcaninc') {
      newPath = 'Volcanic';
      newTrack = 3;
      changed = true;
    } else if (lowerPath === 'harvest') {
      newPath = 'Desert';
      newTrack = 1;
      changed = true;
    } else if (lowerPath === 'winter') {
      newPath = 'Arctic';
      newTrack = 4;
      changed = true;
    } else if (lowerPath === 'forest') {
      newPath = 'Forest';
      newTrack = 2;
      if (team.pathAssigned !== 'Forest' || team.track !== 2) changed = true;
    } else if (lowerPath === 'volcanic') {
      newPath = 'Volcanic';
      newTrack = 3;
      if (team.track !== 3) changed = true;
    } else if (lowerPath === 'desert') {
      newPath = 'Desert';
      newTrack = 1;
      if (team.track !== 1) changed = true;
    } else if (lowerPath === 'arctic') {
      newPath = 'Arctic';
      newTrack = 4;
      if (team.track !== 4) changed = true;
    }

    if (changed) {
      await teamsCollection.updateOne(
        { _id: team._id },
        { $set: { pathAssigned: newPath, track: newTrack } }
      );
      console.log(`  Updated ${team.team_id}: track ${team.track} -> ${newTrack}, path ${team.pathAssigned} -> ${newPath}`);
      teamsUpdated++;
    }
  }
  console.log(`Teams updated: ${teamsUpdated}`);

  // 2. Migrate TrackCapacities collection
  console.log('\n--- 2. Migrating TrackCapacities Collection ---');
  const capCollection = db.collection('trackcapacities');

  // Remove old legacy documents
  const deleteRes = await capCollection.deleteMany({
    track_name: { $in: ['Autumn', 'Harvest', 'Winter', 'Volcaninc', 'autumn', 'harvest', 'winter'] }
  });
  console.log(`  Deleted ${deleteRes.deletedCount} legacy TrackCapacity documents.`);

  // Canonical tracks
  const canonicalTracks = [
    { name: 'Desert', num: 1 },
    { name: 'Forest', num: 2 },
    { name: 'Volcanic', num: 3 },
    { name: 'Arctic', num: 4 }
  ];

  // Re-fetch updated teams to compute claimed_teams
  const updatedTeams = await teamsCollection.find({}).toArray();

  for (const ct of canonicalTracks) {
    const claimed = updatedTeams
      .filter((t) => t.track === ct.num && t.trackConfirmed)
      .map((t) => t.team_id)
      .slice(0, 7);

    await capCollection.findOneAndUpdate(
      { track_name: ct.name },
      {
        $set: {
          track_name: ct.name,
          track_number: ct.num,
          max_teams: 7,
          claimed_teams: claimed,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`  Upserted TrackCapacity for ${ct.name} (Track ${ct.num}): ${claimed.length}/7 claimed teams [${claimed.join(', ')}]`);
  }

  // 3. Update Questions collection with canonical problems & QR tokens
  console.log('\n--- 3. Synchronizing Questions Collection ---');
  const { db: inMemDb } = await import('../db/database.js');
  const canonicalProblems = inMemDb.getAllProblems();
  const questionsCollection = db.collection('questions');

  let questionsUpdated = 0;
  for (const prob of canonicalProblems) {
    const res = await questionsCollection.updateOne(
      { track: prob.track, stage: prob.stage },
      {
        $set: {
          title: prob.title,
          ques: prob.ques,
          ans: prob.ans,
          points: prob.points,
          nextHint: prob.nextHint,
          qrToken: prob.qrToken
        }
      }
    );
    if (res.modifiedCount > 0) questionsUpdated++;
  }
  console.log(`  Updated ${questionsUpdated} questions with canonical metadata and QR tokens.`);

  console.log('\n✓ MongoDB track migration completed successfully!\n');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
