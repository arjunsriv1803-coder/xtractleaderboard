import { connectDB } from '../config/db.js';
import { Team } from '../models/Team.js';
import { TeamSession } from '../models/TeamSession.js';
import mongoose from 'mongoose';

async function main() {
  await connectDB();
  console.log('[Clean] Connected to MongoDB Atlas');

  const resTeams = await Team.updateMany(
    {},
    { $set: { active_devices: [], is_logged_in: false } }
  );
  console.log(`[Clean] Cleared active_devices on ${resTeams.modifiedCount} teams.`);

  const resSessions = await TeamSession.updateMany(
    {},
    { $set: { is_revoked: true } }
  );
  console.log(`[Clean] Revoked ${resSessions.modifiedCount} old sessions.`);

  const sample = await Team.find({}, { team_id: 1, active_devices: 1, is_logged_in: 1 }).lean();
  console.log(`[Clean] Verified all ${sample.length} teams have clean active_devices.`);

  await mongoose.disconnect();
  console.log('[Clean] Done!');
}

main().catch((err) => {
  console.error('[Clean] Error:', err);
  process.exit(1);
});
