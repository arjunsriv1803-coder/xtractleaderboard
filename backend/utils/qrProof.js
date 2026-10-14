import crypto from 'crypto';

const QR_PROOF_SECRET = () => process.env.QR_PROOF_SECRET || process.env.JWT_SECRET || 'xtract_qr_proof_hmac_secret_key_2026';

// In-memory set of used nonces with expiration cleanup to prevent replaying
const usedNonces = new Map(); // nonce -> expiresAt

// Periodic cleanup of expired nonces (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of usedNonces.entries()) {
    if (expiresAt <= now) {
      usedNonces.delete(nonce);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Generates an HMAC-signed, time-limited scan proof for a canonical QR code.
 * Returned when the phone camera visits /api/qr/info/:token.
 */
export const generateScanProof = (qrToken) => {
  const cleanToken = String(qrToken).trim().toUpperCase();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60 * 1000; // Valid for 5 minutes
  const nonce = crypto.randomBytes(16).toString('hex');

  const payload = `${cleanToken}:${issuedAt}:${expiresAt}:${nonce}`;
  const hmac = crypto.createHmac('sha256', QR_PROOF_SECRET()).update(payload).digest('hex');

  return `${cleanToken}.${issuedAt}.${expiresAt}.${nonce}.${hmac}`;
};

/**
 * Validates and atomically consumes a scan proof.
 * Guarantees that:
 * 1. The proof was signed by the server.
 * 2. The proof has not expired.
 * 3. The proof corresponds to the exact QR token being redeemed.
 * 4. The nonce has NOT been used before (single-use guarantee).
 */
import mongoose from 'mongoose';
import { QRNonce } from '../models/QRNonce.js';

export const verifyAndConsumeScanProof = async (qrToken, scanProof) => {
  if (!scanProof || typeof scanProof !== 'string') {
    return { valid: false, error: 'SCAN_PROOF_REQUIRED', message: 'Scan proof is required to verify physical presence.' };
  }

  const parts = scanProof.split('.');
  if (parts.length !== 5) {
    return { valid: false, error: 'INVALID_SCAN_PROOF', message: 'Malformed scan proof format.' };
  }

  const [proofToken, issuedAtStr, expiresAtStr, nonce, receivedHmac] = parts;
  const cleanRequestedToken = String(qrToken).trim().toUpperCase();

  if (proofToken.toUpperCase() !== cleanRequestedToken) {
    return { valid: false, error: 'SCAN_PROOF_MISMATCH', message: 'Scan proof does not match this QR checkpoint.' };
  }

  const issuedAt = parseInt(issuedAtStr, 10);
  const expiresAt = parseInt(expiresAtStr, 10);
  const now = Date.now();

  if (isNaN(issuedAt) || isNaN(expiresAt) || now > expiresAt) {
    return { valid: false, error: 'SCAN_PROOF_EXPIRED', message: 'Scan proof has expired. Please re-scan the physical QR checkpoint.' };
  }

  if (issuedAt > now + 30000) {
    return { valid: false, error: 'INVALID_SCAN_PROOF', message: 'Invalid scan proof timestamp.' };
  }

  // Verify HMAC signature
  const payload = `${proofToken}:${issuedAt}:${expiresAt}:${nonce}`;
  const expectedHmac = crypto.createHmac('sha256', QR_PROOF_SECRET()).update(payload).digest('hex');

  const receivedBuf = Buffer.from(receivedHmac, 'hex');
  const expectedBuf = Buffer.from(expectedHmac, 'hex');

  if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    return { valid: false, error: 'INVALID_SCAN_PROOF', message: 'Forged or tampered scan proof.' };
  }

  // 1. Fast in-memory check
  if (usedNonces.has(nonce)) {
    return { valid: false, error: 'REPLAYED_REDEMPTION', message: 'This scan ticket has already been used. Please scan the physical QR code again.' };
  }

  // 2. Persistent atomic check in MongoDB (across all server instances and restarts)
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      await QRNonce.create({
        nonce,
        qr_token: cleanRequestedToken,
        expires_at: new Date(expiresAt)
      });
    } catch (err) {
      if (err.code === 11000) {
        return { valid: false, error: 'REPLAYED_REDEMPTION', message: 'This scan ticket has already been used. Please scan the physical QR code again.' };
      }
    }
  }

  // Record nonce as consumed in memory as well
  usedNonces.set(nonce, expiresAt);

  return { valid: true, nonce, issuedAt };
};

export default {
  generateScanProof,
  verifyAndConsumeScanProof
};
