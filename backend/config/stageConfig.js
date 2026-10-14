/**
 * Per-stage scoring configuration.
 *
 * "Stage" = a problem's `order` within a track (1 = first problem, which is
 * also the one that locks the team into the track; up to 4). The same
 * stage numbers and config are shared across all 4 tracks - stage 2 of ML
 * and stage 2 of Mobile both use stageConfig[2].
 *
 * Lives in STAGE_CONFIG in .env as a JSON string so it can be tuned per
 * event without touching code. Falls back to the dummy schema below if the
 * env var is missing or malformed (and logs a warning so a typo doesn't
 * fail silently).
 *
 *   fullPoints  - points awarded if solved at/before `threshold`
 *   threshold   - minutes allowed before points start decaying
 *   decayRate   - points lost per minute once past `threshold`
 *                 (lower = more lenient/slower decay)
 *
 * Scoring formula (see utils/scoring.js):
 *   minutesTaken <= threshold  -> fullPoints
 *   minutesTaken  > threshold  -> max(50, fullPoints - decayRate * (minutesTaken - threshold))
 *
 * This is a linear-decay assumption, not something you specified exactly -
 * swap calculatePoints() in scoring.js for a different curve (percentage/
 * exponential decay, etc.) if that's not what you had in mind.
 */

const DEFAULT_STAGE_CONFIG = {
  1: { fullPoints: 100, threshold: 78, decayRate: 0.8 },  // easy — mild penalty for delay
  2: { fullPoints: 100, threshold: 90, decayRate: 0.7 },  // moderate — fairer on timing
  3: { fullPoints: 100, threshold: 100, decayRate: 0.5 }, // harder — slower decay
  4: { fullPoints: 100, threshold: 120, decayRate: 0.4 }  // very hard — most lenient
};

function loadStageConfig() {
  const raw = process.env.STAGE_CONFIG;

  if (!raw) {
    return DEFAULT_STAGE_CONFIG;
  }

  try {
    const parsed = JSON.parse(raw);
    // Normalize keys to numbers-as-strings consistently and sanity-check shape
    const normalized = {};
    for (const [stage, cfg] of Object.entries(parsed)) {
      if (
        typeof cfg.fullPoints !== 'number' ||
        typeof cfg.threshold !== 'number' ||
        typeof cfg.decayRate !== 'number'
      ) {
        throw new Error(`Stage ${stage} is missing fullPoints/threshold/decayRate as numbers`);
      }
      normalized[stage] = cfg;
    }
    return normalized;
  } catch (err) {
    console.warn(
      `[stageConfig] Failed to parse STAGE_CONFIG from .env (${err.message}). ` +
      'Falling back to the built-in default stage config.'
    );
    return DEFAULT_STAGE_CONFIG;
  }
}

const STAGE_CONFIG = loadStageConfig();

const getStageConfig = (stageNumber) => STAGE_CONFIG[String(stageNumber)] || null;

const getAllStageConfig = () => STAGE_CONFIG;

const getMaxStage = () => Math.max(...Object.keys(STAGE_CONFIG).map(Number));

export { getStageConfig, getAllStageConfig, getMaxStage, DEFAULT_STAGE_CONFIG };

