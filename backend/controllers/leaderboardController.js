import { fetchLeaderboardData, getConnectedClientsCount } from '../services/websocketService.js';
import leaderboardService from '../services/leaderboardService.js';

/** Fetch the persisted, score-sorted leaderboard. */
export const fetchLeaderboard = async () => {
  if (typeof fetchLeaderboardData === 'function') {
    return await fetchLeaderboardData();
  }
  return await leaderboardService.getAuthoritativeLeaderboard();
};

/** GET leaderboard endpoint; returns real-time WebSocket connection info and initial leaderboard state. */
export const getPersistentLeaderboard = async (req, res, next) => {
  try {
    const leaderboard = await fetchLeaderboard();
    
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return res.status(200).json({
      success: true,
      websocketUrl: '/ws/leaderboard',
      connectedClients: typeof getConnectedClientsCount === 'function' ? getConnectedClientsCount() : 0,
      data: {
        title: 'MORNING LINE ODDS',
        leaderboard,
        teams: leaderboard,
        totalTeams: leaderboard.length
      },
      leaderboard,
      teams: leaderboard
    });
  } catch (error) {
    console.error('[LeaderboardController] Error fetching leaderboard:', error);
    if (typeof next === 'function') {
      return next(error);
    }
    return res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
};

export default { fetchLeaderboard, getPersistentLeaderboard };