import mongoose from 'mongoose';

const teamSessionSchema = new mongoose.Schema(
  {
    team_id: { type: String, required: true, index: true },
    device_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true },
    is_revoked: { type: Boolean, default: false, index: true },
    last_active_at: { type: Date, default: Date.now },
    expires_at: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

teamSessionSchema.index({ team_id: 1, device_id: 1 }, { unique: true });
teamSessionSchema.index({ team_id: 1, is_revoked: 1, expires_at: 1 });

export const TeamSession = mongoose.model('TeamSession', teamSessionSchema);
export default TeamSession;
