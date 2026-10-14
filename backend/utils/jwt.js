import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = () => {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret.length < 32 || secret.includes('change_this') || secret.includes('change_in_production')) {
      throw new Error('FATAL: JWT_SECRET missing or insecure in production environment');
    }
    return secret;
  }
  return secret || 'hackathon_secret_key_2024_change_in_production';
};

/**
 * AES-256-GCM key derived from COOKIE_ENCRYPT_SECRET env var.
 * Lives only on the server — never sent to the client.
 */
const ENCRYPT_KEY = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const raw = process.env.COOKIE_ENCRYPT_SECRET;
  if (isProduction && (!raw || raw.trim().length < 32 || raw.includes('change_in_production') || raw.includes('secret_32b!'))) {
    throw new Error('FATAL SECURITY CONFIGURATION: COOKIE_ENCRYPT_SECRET must be explicitly set and secure in production mode.');
  }
  return crypto.createHash('sha256').update(raw || 'xtract_cookie_encrypt_secret_32b!').digest(); // stable 32-byte key
};

/**
 * Sign a JWT for the given identity.
 */
export const generateToken = (userId, email, role = 'PARTICIPANT', teamId = null, teamName = null, deviceId = null) => {
  const payload = { userId, id: userId, email, role, teamId, teamName };
  if (deviceId) payload.deviceId = deviceId;
  return jwt.sign(
    payload,
    JWT_SECRET(),
    { expiresIn: '24h' }
  );
};

/**
 * Verify and decode a raw JWT (used ONLY server-side in middleware after decryption).
 */
export const decodeToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET());
  } catch (err) {
    return null;
  }
};

/**
 * AES-256-GCM encrypt the raw JWT.
 * Wire format: base64url( iv[12] || authTag[16] || ciphertext )
 *
 * Used for BOTH:
 *   1. The HttpOnly cookie value — so even if the cookie is stolen the contents are opaque.
 *   2. The `sessionRef` field in the login response body — a second encrypted copy.
 *
 * Decryption only ever happens server-side via decryptTokenServerOnly().
 */
export const encryptToken = (rawToken) => {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY(), iv);
  const encrypted = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
};

/**
 * SERVER-SIDE ONLY — reverses encryptToken().
 * Called by auth middleware to unwrap the encrypted cookie before JWT verification.
 * Never exported via `export default` — not accessible to any client bundle.
 * Returns the raw JWT string on success, or null on any failure (tampered/wrong key/corrupt).
 */
export const decryptTokenServerOnly = (encryptedBlob) => {
  try {
    const buf = Buffer.from(encryptedBlob, 'base64url');
    if (buf.length < 29) return null; // minimum: 12 (iv) + 16 (tag) + 1 (data)

    const iv      = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Wrong key, tampered data, or invalid format — reject silently
    return null;
  }
};

// NOTE: decryptTokenServerOnly is intentionally omitted from the default export
// so it stays server-internal and is never accidentally re-exported to clients.
export default { generateToken, decodeToken, encryptToken };
