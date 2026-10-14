import { connectDB, disconnectDB } from '../config/db.js';
import { seedSampleData } from '../services/adminService.js';
import db from '../db/database.js';

export const runSeed = async () => {
  console.log('\n--- Seeding Xtract 5.0 Admin Dashboard Database ---');
  db.reset();
  await connectDB();
  const result = await seedSampleData();
  console.log(`✓ Created ${result.teamsCount} teams complying with teams_schema.md`);
  console.log(`✓ Created ${result.questionsCount} questions complying with questions_schema.md`);
  console.log(`✓ Created ${result.activitiesCount} participant activity logs`);
  console.log('✓ Seeding complete!\n');
  await disconnectDB();
};

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed error:', err);
      process.exit(1);
    });
}
