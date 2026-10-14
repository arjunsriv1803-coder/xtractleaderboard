import mongoose from 'mongoose';
import { ActivityLog } from '../models/ActivityLog.js';

const TRACK_NAME_TO_NUM = {
  desert: 1,
  harvest: 1,
  forest: 2,
  volcanic: 3,
  volcaninc: 3,
  autumn: 3,
  arctic: 4,
  winter: 4,
};

const TRACK_NUM_TO_NAME = {
  1: 'Desert',
  2: 'Forest',
  3: 'Volcanic',
  4: 'Arctic',
};

/**
 * Service to persist participant events for retrieval through the activity API.
 */
export const logActivity = async ({
  event,
  team_id = null,
  team_name = null,
  action,
  details = '',
  stage = null,
  track = null,
  track_name = null,
  metadata = {}
}) => {
  try {
    let numericTrack = null;
    let resolvedTrackName = track_name || null;

    if (typeof track === 'number') {
      numericTrack = track;
      if (!resolvedTrackName && TRACK_NUM_TO_NAME[track]) {
        resolvedTrackName = TRACK_NUM_TO_NAME[track];
      }
    } else if (typeof track === 'string') {
      const num = Number(track);
      if (!isNaN(num)) {
        numericTrack = num;
        if (!resolvedTrackName && TRACK_NUM_TO_NAME[num]) {
          resolvedTrackName = TRACK_NUM_TO_NAME[num];
        }
      } else {
        const lower = track.trim().toLowerCase();
        if (TRACK_NAME_TO_NUM[lower]) {
          numericTrack = TRACK_NAME_TO_NUM[lower];
          resolvedTrackName = TRACK_NUM_TO_NAME[numericTrack];
        }
      }
    }

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const logDoc = await ActivityLog.create({
        event,
        team_id,
        team_name,
        action: action || `Participant event: ${event}`,
        details,
        stage: stage !== null && !isNaN(Number(stage)) ? Number(stage) : null,
        track: numericTrack,
        track_name: resolvedTrackName,
        metadata,
        timestamp: new Date()
      });
      return logDoc;
    }
    return null;
  } catch (error) {
    console.error(`[ActivityLog] Failed to log event ${event}:`, error.message);
    return null;
  }
};

/**
 * Retrieves paginated participant activity feed.
 */
export const getActivityFeed = async ({ page = 1, limit = 50, event = null, team_id = null } = {}) => {
  const filter = {};
  if (event) filter.event = event;
  if (team_id) filter.team_id = team_id;

  const skip = (Math.max(1, page) - 1) * limit;

  const [total, events] = await Promise.all([
    ActivityLog.countDocuments(filter),
    ActivityLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return {
    events,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};
