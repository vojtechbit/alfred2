import { getUserByMicrosoftId, updateTokens } from './databaseService.js';
import { determineExpiryDate } from '../utils/tokenExpiry.js';
import { refreshAccessToken } from '../config/microsoft.js';
import { getDatabase } from '../config/database.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';

/**
 * Background Token Refresh Service
 */

let refreshInterval = null;
const REFRESH_CONCURRENCY = Math.max(1, parseInt(process.env.TOKEN_REFRESH_CONCURRENCY || '3', 10));
const TEN_MINUTES_MS = 10 * 60 * 1000;
const STARTUP_REFRESH_THRESHOLD_MS = parseInt(process.env.STARTUP_REFRESH_THRESHOLD_MS || '') || TEN_MINUTES_MS;
const BACKGROUND_REFRESH_THRESHOLD_MS = parseInt(process.env.BACKGROUND_REFRESH_THRESHOLD_MS || '') || TEN_MINUTES_MS;

// determineExpiryDate now imported from shared utility

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clearRefreshFailure(microsoftId) {
  try {
    const db = await getDatabase();
    await db.collection('users').updateOne(
      { microsoft_id: microsoftId },
      {
        $set: { refresh_token_revoked: false },
        $unset: { refresh_error: '' }
      }
    );
  } catch (error) {
    console.warn('⚠️  Failed to clear refresh failure metadata:', error.message);
  }
}

async function markRefreshFailure(microsoftId, errorInfo, refreshTokenRevoked = false) {
  try {
    const db = await getDatabase();
    const updateDoc = {
      refresh_error: {
        ...errorInfo,
        at: new Date()
      }
    };

    if (refreshTokenRevoked) {
      updateDoc.refresh_token_revoked = true;
    }

    await db.collection('users').updateOne(
      { microsoft_id: microsoftId },
      { $set: updateDoc }
    );
  } catch (error) {
    console.warn('⚠️  Failed to persist refresh failure metadata:', error.message);
  }
}

async function refreshSingleUser(rawUserDoc, options = {}) {
  const { reason } = options;
  const microsoftId = rawUserDoc.microsoft_id;
  const email = rawUserDoc.email;

  if (rawUserDoc.refresh_token_revoked) {
    console.warn(`⏭️  Skipping ${email} (refresh token marked revoked)`);
    return { status: 'skipped', reason: 'refresh_token_revoked' };
  }

  const userData = await getUserByMicrosoftId(microsoftId);

  if (!userData || !userData.refreshToken) {
    console.warn(`⏭️  Skipping ${email} (no refresh token available)`);
    return { status: 'skipped', reason: 'missing_refresh_token' };
  }

  await delay(Math.floor(Math.random() * 200));

  try {
    console.log(`🔄 Refreshing token for ${email}${reason ? ` (${reason})` : ''}...`);
    const newTokens = await refreshAccessToken(userData.refreshToken);
    const expiryDate = determineExpiryDate(newTokens);

    await updateTokens(microsoftId, {
      accessToken: newTokens.access_token,
      refreshToken: newTokens.refresh_token || userData.refreshToken,
      expiryDate,
      email,
      source: reason ? `refresh:${reason}` : 'refresh:background'
    });

    await clearRefreshFailure(microsoftId);
    console.log(`✅ Refreshed token for ${email}`);
    return { status: 'success' };
  } catch (error) {
    const status = error.response?.status;
    const errorCode = error.response?.data?.error || error.code || 'unknown_error';
    const isInvalidGrant = errorCode === 'invalid_grant';

    console.error(`❌ Failed to refresh token for ${email}`, {
      status,
      errorCode,
      message: error.message
    });

    await markRefreshFailure(
      microsoftId,
      {
        status,
        errorCode,
        message: error.message
      },
      isInvalidGrant
    );

    return { status: 'failed', errorCode };
  }
}

async function runWithConcurrency(items, handler, concurrency, options = {}) {
  const results = [];
  const executing = new Set();
  let index = 0;

  async function enqueue() {
    while (index < items.length) {
      const item = items[index++];
      const promise = handler(item, options)
        .then(result => {
          results.push(result);
        })
        .catch(error => {
          console.error('❌ Unexpected error during refresh task:', error.message);
          results.push({ status: 'failed', errorCode: 'unexpected_error' });
        })
        .finally(() => {
          executing.delete(promise);
        });

      executing.add(promise);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
  }

  await enqueue();
  await Promise.allSettled(Array.from(executing));
  return results;
}

/**
 * Refresh tokens for ALL users on server startup
 */
async function refreshAllTokensOnStartup() {
  try {
    const db = await getDatabase();
    const users = db.collection('users');

    const allUsers = await users.find({}).toArray();

    if (allUsers.length === 0) {
      console.log('⚪ No users to refresh');
      return;
    }

    const now = Date.now();
    const threshold = new Date(now + STARTUP_REFRESH_THRESHOLD_MS);

    const candidates = allUsers.filter(user => {
      if (!user.token_expiry) {
        return true;
      }

      const expiryTime = new Date(user.token_expiry).getTime();
      if (Number.isNaN(expiryTime)) {
        return true;
      }

      return expiryTime <= threshold.getTime();
    });

    if (candidates.length === 0) {
      console.log('⚪ All tokens valid beyond startup threshold');
      return;
    }

    console.log(`🔄 Startup refresh: ${candidates.length}/${allUsers.length} users need refresh`);

    const results = await runWithConcurrency(candidates, refreshSingleUser, REFRESH_CONCURRENCY, {
      reason: 'startup'
    });

    const summary = results.reduce(
      (acc, result) => {
        acc[result.status] = (acc[result.status] || 0) + 1;
        return acc;
      },
      { success: 0, failed: 0, skipped: 0 }
    );

    console.log(`✅ Startup refresh complete: ${summary.success} success, ${summary.failed} failed, ${summary.skipped} skipped`);

  } catch (error) {
    console.error('❌ Startup token refresh failed:', error.message);
  }
}

/**
 * Refresh tokens for active users (background job)
 */
async function refreshAllActiveTokens() {
  try {
    const db = await getDatabase();
    const users = db.collection('users');

    // Find users active in last 24 hours
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeUsers = await users.find({
      last_used: { $gte: yesterday }
    }).toArray();

    if (activeUsers.length === 0) {
      console.log('⚪ No active users to refresh');
      return;
    }

    const now = new Date();

    const candidates = activeUsers.filter(user => {
      if (!user.token_expiry) {
        return true;
      }

      const expiry = new Date(user.token_expiry);
      const timeUntilExpiry = expiry.getTime() - now.getTime();
      return timeUntilExpiry <= BACKGROUND_REFRESH_THRESHOLD_MS;
    });

    if (candidates.length === 0) {
      console.log('⚪ All active tokens healthy');
      return;
    }

    console.log(`🔄 Refreshing tokens for ${candidates.length} active users...`);

    const results = await runWithConcurrency(candidates, refreshSingleUser, REFRESH_CONCURRENCY, {
      reason: 'background'
    });

    const summary = results.reduce(
      (acc, result) => {
        acc[result.status] = (acc[result.status] || 0) + 1;
        return acc;
      },
      { success: 0, failed: 0, skipped: 0 }
    );

    console.log(`✅ Background refresh complete: ${summary.success} success, ${summary.failed} failed, ${summary.skipped} skipped`);

  } catch (error) {
    console.error('❌ Background token refresh failed:', error.message);
  }
}

/**
 * Start background token refresh
 * Runs every 30 minutes while server is active
 */
function startBackgroundRefresh() {
  if (refreshInterval) {
    console.log('⚠️  Background refresh already running');
    return;
  }

  console.log('🚀 Starting background token refresh (every 30 minutes)');

  // Run immediately on start
  setTimeout(() => refreshAllActiveTokens(), 5000); // Wait 5s for server to fully start

  // Then run every 30 minutes
  refreshInterval = setInterval(() => {
    refreshAllActiveTokens();
  }, 30 * 60 * 1000); // 30 minutes
}

/**
 * Stop background token refresh
 */
function stopBackgroundRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log('🛑 Background token refresh stopped');
  }
}

const traced = wrapModuleFunctions('services.backgroundRefreshService', {
  refreshAllTokensOnStartup,
  refreshAllActiveTokens,
  startBackgroundRefresh,
  stopBackgroundRefresh,
});

const {
  refreshAllTokensOnStartup: tracedRefreshAllTokensOnStartup,
  refreshAllActiveTokens: tracedRefreshAllActiveTokens,
  startBackgroundRefresh: tracedStartBackgroundRefresh,
  stopBackgroundRefresh: tracedStopBackgroundRefresh,
} = traced;

export {
  tracedRefreshAllTokensOnStartup as refreshAllTokensOnStartup,
  tracedRefreshAllActiveTokens as refreshAllActiveTokens,
  tracedStartBackgroundRefresh as startBackgroundRefresh,
  tracedStopBackgroundRefresh as stopBackgroundRefresh,
};
