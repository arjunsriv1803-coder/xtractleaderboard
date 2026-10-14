import mongoose from 'mongoose';
import { env } from './env.js';

let isConnected = false;
let connectPromise = null;

// Track connection state via mongoose events
mongoose.connection.on('connected', () => {
  isConnected = true;
});
mongoose.connection.on('disconnected', () => {
  isConnected = false;
  connectPromise = null;
});
mongoose.connection.on('error', (err) => {
  console.warn(`[MongoDB] Connection error: ${err.message}`);
  isConnected = false;
  connectPromise = null;
});

export const connectDB = async (uri = env.MONGODB_URI) => {
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return mongoose.connection;
  }

  // If already connecting, await ongoing connection attempt
  if (connectPromise) {
    return connectPromise;
  }

  if (!uri) {
    console.warn('[MongoDB] No MONGODB_URI provided. Operating in standalone in-memory mode.');
    return null;
  }

  connectPromise = (async () => {
    try {
      const conn = await mongoose.connect(uri, {
        autoIndex: true,
        serverSelectionTimeoutMS: 15000
      });
      isConnected = true;
      if (env.NODE_ENV !== 'test') {
        console.log(`[MongoDB] Connected to database: ${conn.connection.host}/${conn.connection.name}`);
      }
      return conn;
    } catch (error) {
      console.warn(`[MongoDB] Could not connect to MongoDB (${error.message}). Continuing in fallback mode.`);
      isConnected = false;
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
};

export const disconnectDB = async () => {
  if (!isConnected) return;
  try {
    await mongoose.disconnect();
  } catch (err) {
    // Ignore error
  }
  isConnected = false;
};

export default { connectDB, disconnectDB };
