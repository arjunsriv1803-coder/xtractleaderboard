import mongoose from 'mongoose';

/**
 * TrackCapacity Model for atomic distributed track slot claims.
 * Ensures the 7-team limit is enforced atomically at the database level across
 * multiple server instances and across restarts without in-memory mutexes.
 */
const trackCapacitySchema = new mongoose.Schema(
  {
    track_name: { type: String, required: true, unique: true, index: true },
    track_number: { type: Number, required: true },
    max_teams: { type: Number, default: 7 },
    claimed_teams: [{ type: String }] // array of canonical team_ids
  },
  { timestamps: true }
);

export const TrackCapacity = mongoose.models.TrackCapacity || mongoose.model('TrackCapacity', trackCapacitySchema);
export default TrackCapacity;
