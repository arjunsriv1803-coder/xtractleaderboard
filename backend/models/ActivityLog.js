import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema(
  {
    event: {
      type: String,
      required: true,
      index: true
    },
    team_id: {
      type: String,
      default: null,
      index: true
    },
    team_name: {
      type: String,
      default: null
    },
    action: {
      type: String,
      required: true
    },
    details: {
      type: String,
      default: ''
    },
    stage: {
      type: Number,
      default: null
    },
    track: {
      type: Number,
      default: null
    },
    track_name: {
      type: String,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: false,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      }
    }
  }
);

export const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
export default ActivityLog;
