import dotenv from 'dotenv';
dotenv.config();

// MongoDB is optional for the in-memory game backend. When a URI is not
// supplied, db.js attempts the local development default and gracefully
// continues if MongoDB is unavailable.

const validateJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';
  const insecureDefaults = [
    'xtract_dashboard_secret_key',
    'hackathon_secret_key_2024_change_in_production',
    'your_jwt_secret_key_change_this_in_production',
    'change_in_production',
    'secret'
  ];

  if (isProduction) {
    if (!secret || secret.trim().length < 32 || insecureDefaults.includes(secret.trim())) {
      throw new Error(
        'FATAL SECURITY CONFIGURATION: JWT_SECRET must be explicitly set, at least 32 characters long, and must not use insecure default values in production mode.'
      );
    }
  }

  return secret || 'xtract_dashboard_secret_key';
};

const validateCookieSecret = () => {
  const secret = process.env.COOKIE_ENCRYPT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';
  const insecureDefaults = [
    'xtract_device_secret_32b!',
    'xtract_cookie_encrypt_secret_32b!',
    'default_cookie_secret_32bytes_long!',
    'change_in_production',
    'secret'
  ];

  if (isProduction) {
    if (!secret || secret.trim().length < 32 || insecureDefaults.includes(secret.trim())) {
      throw new Error(
        'FATAL SECURITY CONFIGURATION: COOKIE_ENCRYPT_SECRET must be explicitly set, at least 32 characters long, and must not use insecure default values in production mode.'
      );
    }
  }

  return secret || 'xtract_cookie_encrypt_secret_32b!';
};

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://deepamsipani3_db_user:NHwI9Kz2ZJ9fb8Cx@cluster0.hp7mz4g.mongodb.net/?appName=Cluster0',
  JWT_SECRET: validateJwtSecret(),
  COOKIE_ENCRYPT_SECRET: validateCookieSecret(),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1h',
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug'
};
