import crypto from 'crypto';

/**
 * Generate deterministic hash for endpoint names
 * Same input always produces same hash
 */
export const hashEndpoint = (endpoint, secret = process.env.JWT_SECRET || 'hackathon_secret_key_2024_change_in_production') => {
  return crypto
    .createHmac('sha256', secret)
    .update(endpoint)
    .digest('hex')
    .substring(0, 16); // Use first 16 chars for shorter URLs
};

/**
 * Endpoint hash mapping
 * Readable name -> Hashed endpoint
 */
export const ENDPOINT_MAP = {
  // Auth endpoints
  'auth.register': hashEndpoint('auth.register'),
  'auth.login': hashEndpoint('auth.login'),
  'auth.profile': hashEndpoint('auth.profile'),

  // Team endpoints
  'team.create': hashEndpoint('team.create'),
  'team.getMyTeams': hashEndpoint('team.getMyTeams'),
  'team.getTeamById': hashEndpoint('team.getTeamById'),
  'team.getAllTeams': hashEndpoint('team.getAllTeams'),
  'team.addMember': hashEndpoint('team.addMember'),

  // Path endpoints
  'path.getAllPaths': hashEndpoint('path.getAllPaths'),
  'path.getPathStats': hashEndpoint('path.getPathStats'),
  'path.getPathByName': hashEndpoint('path.getPathByName'),
  'path.assignTeamToPath': hashEndpoint('path.assignTeamToPath'),

  // Problem endpoints
  'problem.getByTrack': hashEndpoint('problem.getByTrack'),

  // Submission endpoints
  'submission.submit': hashEndpoint('submission.submit'),
  'submission.getByTeam': hashEndpoint('submission.getByTeam'),
  'submission.getLeaderboard': hashEndpoint('submission.getLeaderboard'),

  // Leaderboard endpoint
  'leaderboard.get': hashEndpoint('leaderboard.get'),
};

/**
 * Convert readable endpoint name to hashed path
 */
export const getHashedPath = (endpointName) => {
  const hash = ENDPOINT_MAP[endpointName];
  if (!hash) {
    throw new Error(`Unknown endpoint: ${endpointName}`);
  }
  return `/api/${hash}`;
};

/**
 * Get all hashed endpoints
 */
export const getAllHashedEndpoints = () => {
  const result = {};
  for (const [name, hash] of Object.entries(ENDPOINT_MAP)) {
    result[name] = `/api/${hash}`;
  }
  return result;
};

/**
 * Middleware to map hashed routes back to readable names (for internal routing)
 */
export const createHashedRouteMapper = () => {
  const hashToReadable = {};

  // Build reverse mapping
  for (const [readable, hash] of Object.entries(ENDPOINT_MAP)) {
    hashToReadable[hash] = readable;
  }

  return (req, res, next) => {
    // Extract hash from path
    const pathParts = req.path.split('/');
    const hash = pathParts[2]; // /api/hash

    if (hashToReadable[hash]) {
      req.endpointName = hashToReadable[hash];
    }

    next();
  };
};

export default {
  hashEndpoint,
  ENDPOINT_MAP,
  getHashedPath,
  getAllHashedEndpoints,
  createHashedRouteMapper
};
