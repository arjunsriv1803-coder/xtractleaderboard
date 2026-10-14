import mongoose from 'mongoose';

/**
 * QR Nonce collection with TTL indexing.
 * Ensures single-use nonce consumption is atomic across all backend server instances
 * and persists across server restarts.
 * Documents automatically expire and are purged by MongoDB when expires_at is reached.
 */
const qrNonceSchema = new mongoose.Schema(
  {
    nonce: { type: String, required: true, unique: true, index: true },
    qr_token: { type: String, required: true },
    expires_at: { type: Date, required: true, expires: 0 } // MongoDB TTL index
  },
  { timestamps: true }
);

export const QRNonce = mongoose.models.QRNonce || mongoose.model('QRNonce', qrNonceSchema);
export default QRNonce;
