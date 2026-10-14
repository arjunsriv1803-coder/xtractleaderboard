import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema(
  {
    ques: { type: String, required: true },
    title: { type: String },
    ans: { type: String, required: true },
    stage: { type: Number, required: true },
    track: { type: Number, required: true },
    qrToken: { type: String },
    submitted_teams: [
      {
        team_id: { type: String, required: true },
        timestamp: { type: Date, default: Date.now }
      }
    ],
    discoveredBy: { type: [String], default: [] },
    points: { type: Number, required: true },
    nextHint: { type: String, required: true },
    qrscanned_teams: [
      {
        team_id: { type: String },
        team_name: { type: String },
        timestamp: { type: Date, default: Date.now }
      }
    ]
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

export const Question = mongoose.model('Question', questionSchema);
export default Question;
