import express from 'express';
import { getQRInfo, redeemQR, getQRStatus, requestScanProof, qrAuthenticate } from '../controllers/qrController.js';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

// 1. Explicitly gate & block any development token leak endpoints (PART 10)
router.all('/dev/tokens', (req, res) => {
  return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Endpoint not available.' });
});

// 2. Checkpoint Authentication Gate (used exclusively by mobile camera QR landing page)
// Unrestricted by workstation device slots / rate limiting
router.post('/auth', qrAuthenticate);

// 3. Public QR inspection endpoint (used by mobile landing page to display track/stage info)
router.get('/info/:token', getQRInfo);

// 4. Authenticated single-use scan proof issuance (requires valid session & matching PS)
router.post('/proof', verifyToken, requestScanProof);

// 5. Authenticated QR redemption endpoints
router.post('/redeem', verifyToken, redeemQR);
router.post('/scan', verifyToken, redeemQR); // Backwards-compatible alias

// 6. Authenticated problem unlock status check for workstation
router.get('/status/:problemId', verifyToken, getQRStatus);

// 7. Fallback for GET /api/qr/:token (routes non-reserved paths to getQRInfo)
router.get('/:token', (req, res, next) => {
  if (['redeem', 'scan', 'status', 'info', 'dev', 'proof', 'auth'].includes(req.params.token)) {
    return next();
  }
  return getQRInfo(req, res);
});

export default router;
