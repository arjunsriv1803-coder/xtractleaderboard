import crypto from 'crypto';

/**
 * Generate request signature for integrity verification
 * Client and server both know the secret
 */
export const generateRequestSignature = (payload, secret = process.env.JWT_SECRET) => {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto
    .createHmac('sha256', secret)
    .update(payloadString)
    .digest('hex');
};

/**
 * Verify request signature
 */
export const verifyRequestSignature = (payload, signature, secret = process.env.JWT_SECRET) => {
  const expectedSignature = generateRequestSignature(payload, secret);
  return signature === expectedSignature;
};

/**
 * Hash data with SHA-256 (for client-side reference)
 */
export const hashData = (data) => {
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex');
};

export default {
  generateRequestSignature,
  verifyRequestSignature,
  hashData
};
