import mongoose from 'mongoose';

const competitionStateSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'global',
      unique: true
    },
    isRunning: {
      type: Boolean,
      default: false
    },
    startTime: {
      type: Date,
      default: null
    },
    stoppedAt: {
      type: Date,
      default: null
    },
    updatedBy: {
      type: String,
      default: 'admin'
    }
  },
  {
    timestamps: true
  }
);

export const CompetitionState = mongoose.model('CompetitionState', competitionStateSchema);
export default CompetitionState;
