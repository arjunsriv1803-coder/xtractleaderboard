import mongoose from 'mongoose';

const teamSchema = new mongoose.Schema(
  {
    team_id: { type: String, unique: true, required: true, index: true },
    team_name: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    track: { type: Number, default: -1 },
    stage: { type: Number, default: 1 },
    points: { type: Number, default: 0 },
    role: { type: String, default: 'team' },
    team_size: { type: Number, default: 5 },
    trackConfirmed: { type: Boolean, default: false },
    pathAssigned: { type: String, default: null },
    stage_start_time: { type: Date, default: null },
    disqualified: { type: Boolean, default: false },
    is_logged_in: { type: Boolean, default: false },
    active_devices: [{ type: String }],
    rate_limit_violations: { type: Number, default: 0 },
    stageProgress: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      }
    }
  }
);

export const Team = mongoose.model('Team', teamSchema);
export default Team;
