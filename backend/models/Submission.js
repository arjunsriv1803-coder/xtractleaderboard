import mongoose from 'mongoose';

const submissionSchema = new mongoose.Schema(
  {
    team_id: {
      type: String,
      required: true,
      index: true
    },
    team_name: {
      type: String,
      required: true
    },
    question_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      default: null
    },
    question_text: {
      type: String,
      default: ''
    },
    stage: {
      type: Number,
      required: true
    },
    track: {
      type: Number,
      required: true
    },
    submitted_answer: {
      type: String,
      required: true
    },
    correct_answer: {
      type: String,
      default: ''
    },
    is_correct: {
      type: Boolean,
      required: true,
      index: true
    },
    points_awarded: {
      type: Number,
      default: 0
    },
    is_rate_limited: {
      type: Boolean,
      default: false
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

export const Submission = mongoose.model('Submission', submissionSchema);
export default Submission;
