import crypto from 'crypto';

const SALT = process.env.QR_HASH_SALT || 'xtract_5_0_physical_qr_checkpoint_salt_2026';

// Track 1: DESERT (formerly Harvest)
// Track 2: FOREST
// Track 3: VOLCANIC (formerly Autumn)
// Track 4: ARCTIC (formerly Winter)
export const TRACKS = ['DESERT', 'FOREST', 'VOLCANIC', 'ARCTIC'];
export const STAGES = ['DS', 'ML', 'NLP', 'CV'];

/**
 * Generate deterministic hash for the unified Stage 4 (CV) checkpoint
 */
export const hashCommonCVIdentifier = () => {
  return crypto
    .createHmac('sha256', SALT)
    .update('XTRACT_QR_COMMON_CV')
    .digest('hex')
    .substring(0, 16);
};

/**
 * Normalize track name including aliases and typos
 */
export const normalizeTrackName = (track) => {
  const norm = String(track || '').trim().toUpperCase();
  if (norm === 'AUTUMN' || norm === 'VOLCANINC') return 'VOLCANIC';
  if (norm === 'HARVEST') return 'DESERT';
  if (norm === 'WINTER') return 'ARCTIC';
  return norm;
};

/**
 * Generate deterministic, unguessable cryptographic hash for a QR checkpoint
 */
export const hashQRIdentifier = (track, stage) => {
  let normTrack = normalizeTrackName(track);
  const normStage = String(stage || '').trim().toUpperCase().replace('OPEN_CV', 'CV').replace('OPENCV', 'CV');

  if (normStage === 'CV' && (normTrack === 'COMMON' || normTrack === 'ALL' || !normTrack)) {
    return hashCommonCVIdentifier();
  }

  return crypto
    .createHmac('sha256', SALT)
    .update(`XTRACT_QR_${normTrack}_${normStage}`)
    .digest('hex')
    .substring(0, 16);
};

// Pre-build bidirectional mapping
export const QR_HASH_MAP = {};
export const CANONICAL_TO_HASH = {};

// 1. Tracks × Stages (DS, ML, NLP)
for (const track of TRACKS) {
  for (const stage of ['DS', 'ML', 'NLP']) {
    const canonical = `QR-${track}-${stage}`;
    const hash = hashQRIdentifier(track, stage);
    QR_HASH_MAP[hash.toLowerCase()] = { track, stage, canonical, hash };
    CANONICAL_TO_HASH[canonical] = hash;
  }
}

// 2. Unified Common CV Checkpoint (single QR for all tracks)
const commonCVHash = hashCommonCVIdentifier();
const commonCVEntry = { track: 'ALL', stage: 'CV', canonical: 'QR-CV', hash: commonCVHash };
QR_HASH_MAP[commonCVHash.toLowerCase()] = commonCVEntry;
CANONICAL_TO_HASH['QR-CV'] = commonCVHash;
CANONICAL_TO_HASH['QR-ALL-CV'] = commonCVHash;
CANONICAL_TO_HASH['QR-COMMON-CV'] = commonCVHash;

// 3. Backwards-compatible aliases for legacy Autumn/Harvest/Winter & Volcaninc typo tokens
for (const stage of ['DS', 'ML', 'NLP']) {
  // Volcanic aliases: Autumn & Volcaninc
  const volcHash = CANONICAL_TO_HASH[`QR-VOLCANIC-${stage}`];
  if (volcHash) {
    CANONICAL_TO_HASH[`QR-AUTUMN-${stage}`] = volcHash;
    CANONICAL_TO_HASH[`QR-VOLCANINC-${stage}`] = volcHash;
  }

  // Desert alias: Harvest
  const desertHash = CANONICAL_TO_HASH[`QR-DESERT-${stage}`];
  if (desertHash) {
    CANONICAL_TO_HASH[`QR-HARVEST-${stage}`] = desertHash;
  }

  // Arctic alias: Winter
  const arcticHash = CANONICAL_TO_HASH[`QR-ARCTIC-${stage}`];
  if (arcticHash) {
    CANONICAL_TO_HASH[`QR-WINTER-${stage}`] = arcticHash;
  }

  // Also support legacy hashes generated under XTRACT_QR_AUTUMN / XTRACT_QR_HARVEST / XTRACT_QR_WINTER
  const legacyAutumnHash = crypto.createHmac('sha256', SALT).update(`XTRACT_QR_AUTUMN_${stage}`).digest('hex').substring(0, 16);
  if (!QR_HASH_MAP[legacyAutumnHash.toLowerCase()]) {
    QR_HASH_MAP[legacyAutumnHash.toLowerCase()] = { track: 'VOLCANIC', stage, canonical: `QR-VOLCANIC-${stage}`, hash: volcHash };
  }

  const legacyHarvestHash = crypto.createHmac('sha256', SALT).update(`XTRACT_QR_HARVEST_${stage}`).digest('hex').substring(0, 16);
  if (!QR_HASH_MAP[legacyHarvestHash.toLowerCase()]) {
    QR_HASH_MAP[legacyHarvestHash.toLowerCase()] = { track: 'DESERT', stage, canonical: `QR-DESERT-${stage}`, hash: desertHash };
  }

  const legacyWinterHash = crypto.createHmac('sha256', SALT).update(`XTRACT_QR_WINTER_${stage}`).digest('hex').substring(0, 16);
  if (!QR_HASH_MAP[legacyWinterHash.toLowerCase()]) {
    QR_HASH_MAP[legacyWinterHash.toLowerCase()] = { track: 'ARCTIC', stage, canonical: `QR-ARCTIC-${stage}`, hash: arcticHash };
  }
}

/**
 * Resolve any QR token representation (hashed, QR-CV, canonical, or legacy alias)
 * Returns { track, stage, canonical, hash } or null
 */
export const resolveQRToken = (token) => {
  if (!token || typeof token !== 'string') return null;
  const clean = token.trim();

  // 1. Check if token is a direct hash (case-insensitive)
  const byHash = QR_HASH_MAP[clean.toLowerCase()];
  if (byHash) return byHash;

  // 2. Check unified CV canonical tokens
  const upper = clean.toUpperCase();
  if (upper === 'QR-CV' || upper === 'QR-ALL-CV' || upper === 'QR-COMMON-CV' || upper === 'QR-OPENCV' || upper === 'QR-OPEN_CV') {
    return commonCVEntry;
  }

  // 3. Check canonical format (QR-TRACK-STAGE)
  const parts = upper.split('-');
  if (parts.length >= 2 && parts[0] === 'QR') {
    if (parts.length === 2 && (parts[1] === 'CV' || parts[1] === 'OPENCV')) {
      return commonCVEntry;
    }

    let track = normalizeTrackName(parts[1]);
    let stage = parts.slice(2).join('_');
    if (stage === 'OPEN_CV' || stage === 'OPENCV') stage = 'CV';

    if (stage === 'CV') {
      return commonCVEntry;
    }

    if (TRACKS.includes(track) && STAGES.includes(stage)) {
      const canonical = `QR-${track}-${stage}`;
      const hash = CANONICAL_TO_HASH[canonical] || hashQRIdentifier(track, stage);
      return { track, stage, canonical, hash };
    }
  }

  return null;
};

export default {
  TRACKS,
  STAGES,
  normalizeTrackName,
  hashCommonCVIdentifier,
  hashQRIdentifier,
  QR_HASH_MAP,
  CANONICAL_TO_HASH,
  resolveQRToken
};
