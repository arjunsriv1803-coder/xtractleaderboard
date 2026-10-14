import mongoose from 'mongoose';

const qrRedemptionSchema = new mongoose.Schema(
  {
    team_id: { type: String, required: true, index: true },
    problem_id: { type: String, required: true, index: true },
    qr_token: { type: String, required: true },
    track: { type: Number, required: true },
    stage: { type: Number, required: true },
    redeemed_at: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// Enforce one redemption per team per problem
qrRedemptionSchema.index({ team_id: 1, problem_id: 1 }, { unique: true });

export const QRRedemption = mongoose.model('QRRedemption', qrRedemptionSchema);
export default QRRedemption;
