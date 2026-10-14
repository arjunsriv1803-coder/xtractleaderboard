import { verifyRequestSignature } from '../utils/crypto.js';

/**
 * Middleware to verify request signatures
 * Ensures request integrity and authenticity
 */
export const verifySignature = (req, res, next) => {
  try {
    const signature = req.headers['x-request-signature'];

    // Optional: Skip signature verification for non-sensitive routes
    if (req.method === 'GET') {
      return next();
    }

    if (!signature) {
      return res.status(400).json({
        error: 'Request signature missing. Include X-Request-Signature header.'
      });
    }

    // Get raw request body
    const payload = JSON.stringify(req.body);

    // Verify signature
    const isValid = verifyRequestSignature(payload, signature);

    if (!isValid) {
      return res.status(401).json({
        error: 'Invalid request signature. Request may have been tampered with.'
      });
    }

    next();
  } catch (err) {
    console.error('Signature verification error:', err);
    res.status(500).json({ error: 'Signature verification failed' });
  }
};

export default { verifySignature };
