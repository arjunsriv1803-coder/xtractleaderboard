/**
 * Pure scoring functions - no DB/IO here so they're trivial to test.
 */

export const minutesBetween = (laterDate, earlierDate) => {
  return (laterDate.getTime() - earlierDate.getTime()) / (1000 * 60);
};

/**
 * Linear decay: full points up to `threshold` minutes, then lose
 * `decayRate` points per minute past it, floored at 50.
 *
 * @param {{fullPoints:number, threshold:number, decayRate:number}} stageCfg
 * @param {number} minutesTaken
 * @returns {number} points, rounded to 2 decimal places
 */
export const calculatePoints = (stageCfg, minutesTaken) => {
  const { fullPoints, threshold, decayRate } = stageCfg;

  if (minutesTaken <= threshold) {
    return fullPoints;
  }

  const overtime = minutesTaken - threshold;
  const decayed = fullPoints - decayRate * overtime;
  return Math.max(50, Math.round(decayed * 100) / 100);
};

export default { minutesBetween, calculatePoints };
