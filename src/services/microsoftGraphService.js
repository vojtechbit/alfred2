/**
 * Microsoft Graph API Service
 *
 * This service provides access to Microsoft 365 services through Microsoft Graph API:
 * - Outlook Mail (replaces Gmail)
 * - Outlook Calendar (replaces Google Calendar)
 * - Microsoft To Do (replaces Google Tasks)
 * - OneDrive/Excel (replaces Google Drive/Sheets)
 * - Outlook Contacts (replaces Google Contacts via Sheets)
 *
 * Implements the same interface as googleApiService.js for drop-in replacement.
 *
 * @module microsoftGraphService
 */

import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import { refreshAccessToken } from '../config/microsoft.js';
import { getUserByMicrosoftId, updateTokens, updateLastUsed } from './databaseService.js';
import { generateSignedAttachmentUrl } from '../utils/signedUrlGenerator.js';
import { isBlocked } from '../utils/attachmentSecurity.js';
import { getPragueOffsetHours } from '../utils/helpers.js';
import { REFERENCE_TIMEZONE } from '../config/limits.js';
import { debugStep, wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { logDuration, startTimer } from '../utils/performanceLogger.js';
import dotenv from 'dotenv';
import { determineExpiryDate, isTokenExpired } from '../utils/tokenExpiry.js';
import { retryWithExponentialBackoff, isRetryableError } from '../utils/exponentialBackoff.js';
import { executeWithRetry } from '../utils/graphRetry.js';
import { convertIANAToWindows, convertWindowsToIANA, convertDateTimeToMicrosoft, convertDateTimeToGoogle } from '../utils/timezoneConverter.js';
import { mapGoogleApiError, throwServiceError } from './serviceErrors.js';
import XLSX from 'xlsx-js-style';

dotenv.config();

// ==================== TOKEN REFRESH MUTEX ====================
const activeRefreshes = new Map();

// ==================== EMAIL SIZE LIMITS ====================
const EMAIL_SIZE_LIMITS = {
  MAX_SIZE_BYTES: 100000,
  MAX_BODY_LENGTH: 8000,
  MAX_HTML_LENGTH: 5000,
  WARNING_SIZE_BYTES: 50000
};

const CONTENT_PREVIEW_LIMIT = 500;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

// ==================== FOLDER DIRECTORY CACHE ====================
// Microsoft uses Folders instead of Labels
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const folderDirectoryCache = new Map();

const USER_ADDRESS_CACHE_TTL_MS = 5 * 60 * 1000;
const userAddressCache = new Map();

const DEBUG_CACHE_ENTRY_LIMIT = 20;

// ==================== GMAIL → OUTLOOK FOLDER MAPPING ====================
// Map Gmail system labels to Outlook well-known folders
const GMAIL_TO_OUTLOOK_FOLDER_MAP = {
  'INBOX': 'inbox',
  'SENT': 'sentitems',
  'DRAFT': 'drafts',
  'SPAM': 'junkemail',
  'TRASH': 'deleteditems',
  'UNREAD': null,  // Handled via isRead property
  'STARRED': null,  // Handled via flag property
  'IMPORTANT': null  // No direct equivalent
};

const OUTLOOK_TO_GMAIL_FOLDER_MAP = {
  'inbox': 'INBOX',
  'sentitems': 'SENT',
  'drafts': 'DRAFT',
  'junkemail': 'SPAM',
  'deleteditems': 'TRASH'
};

// ==================== CACHE HELPER FUNCTIONS ====================

function maskDebugKey(key) {
  if (typeof key !== 'string') {
    return typeof key;
  }

  if (key.length <= 6) {
    return key;
  }

  return `${key.slice(0, 3)}…${key.slice(-2)}`;
}

function summarizeCacheEntries(cache, { ttlMs, valueSummary } = {}) {
  const now = Date.now();
  const entries = [];

  for (const [key, value] of cache.entries()) {
    const timestamp = typeof value?.timestamp === 'number' ? value.timestamp : null;
    const ageMs = timestamp ? now - timestamp : null;
    const summary = typeof valueSummary === 'function' ? valueSummary(value) : {};

    entries.push({
      key: maskDebugKey(key),
      cachedAt: timestamp ? new Date(timestamp).toISOString() : null,
      ageMs,
      expiresInMs: timestamp && typeof ttlMs === 'number'
        ? Math.max(0, ttlMs - ageMs)
        : null,
      ...summary
    });
  }

  entries.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));

  return {
    size: cache.size,
    ttlMs: ttlMs ?? null,
    entries: entries.slice(0, DEBUG_CACHE_ENTRY_LIMIT)
  };
}

function getDebugDiagnostics() {
  return {
    activeRefreshes: {
      count: activeRefreshes.size,
      users: Array.from(activeRefreshes.keys()).map(maskDebugKey)
    },
    folderDirectoryCache: summarizeCacheEntries(folderDirectoryCache, {
      ttlMs: FOLDER_CACHE_TTL_MS,
      valueSummary: value => ({
        folderCount: Array.isArray(value?.folders) ? value.folders.length : 0
      })
    }),
    userAddressCache: summarizeCacheEntries(userAddressCache, {
      ttlMs: USER_ADDRESS_CACHE_TTL_MS,
      valueSummary: value => ({
        addressCount: Array.isArray(value?.addresses) ? value.addresses.length : 0
      })
    })
  };
}

function flushDebugCaches({ targets = [] } = {}) {
  const normalizedTargets = Array.isArray(targets)
    ? targets.map(target => String(target).toLowerCase())
    : [];

  const targetSet = new Set(
    normalizedTargets.filter(target => target === 'folders' || target === 'addresses')
  );

  if (targetSet.size === 0) {
    targetSet.add('folders');
    targetSet.add('addresses');
  }

  const cleared = {};

  if (targetSet.has('folders')) {
    const removed = folderDirectoryCache.size;
    folderDirectoryCache.clear();
    cleared.folders = removed;
  }

  if (targetSet.has('addresses')) {
    const removed = userAddressCache.size;
    userAddressCache.clear();
    cleared.addresses = removed;
  }

  return {
    cleared,
    targets: Array.from(targetSet)
  };
}

// ==================== AUTHENTICATION & TOKEN MANAGEMENT ====================

/**
 * Creates Microsoft Graph API client with access token
 *
 * @param {string} accessToken - Valid access token
 * @returns {Object} Microsoft Graph Client instance
 */
function createGraphClient(accessToken) {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    }
  });
}

/**
 * Gets valid access token for Microsoft ID, refreshing if necessary
 *
 * Equivalent to getValidAccessToken in googleApiService.js
 *
 * @param {string} microsoftId - Microsoft user ID (from user.id in Microsoft Graph)
 * @param {boolean} [forceRefresh=false] - Force token refresh even if valid
 * @returns {Promise<string>} Valid access token
 */
async function getValidAccessToken(microsoftId, forceRefresh = false) {
  // Check if there's already an active refresh for this user
  if (activeRefreshes.has(microsoftId)) {
    console.log(`⏳ [MICROSOFT_GRAPH] Token refresh already in progress for user, waiting...`);
    return await activeRefreshes.get(microsoftId);
  }

  try {
    // Get user from database
    const user = await getUserByMicrosoftId(microsoftId);

    if (!user) {
      throw new Error(`User not found for Microsoft ID: ${microsoftId}`);
    }

    // Check if token needs refresh
    const needsRefresh = forceRefresh || isTokenExpired(user.token_expiry);

    if (!needsRefresh) {
      console.log('✅ [MICROSOFT_GRAPH] Access token still valid, using cached token');
      await updateLastUsed(microsoftId);
      return user.access_token;
    }

    // Start refresh process
    console.log('🔄 [MICROSOFT_GRAPH] Access token expired or force refresh requested, refreshing...');

    const refreshPromise = (async () => {
      try {
        const newTokens = await refreshAccessToken(user.refresh_token);

        // Update tokens in database
        const tokenExpiry = determineExpiryDate(newTokens.expires_in);

        await updateTokens(microsoftId, {
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token,  // IMPORTANT: Save new refresh token!
          token_expiry: tokenExpiry
        });

        console.log('✅ [MICROSOFT_GRAPH] Access token refreshed successfully');
        console.log('New token expiry:', tokenExpiry);

        return newTokens.access_token;

      } catch (error) {
        console.error('❌ [MICROSOFT_GRAPH_ERROR] Token refresh failed:', error.message);

        // If refresh token is invalid, user needs to re-authenticate
        if (error.message?.includes('invalid_grant') || error.message?.includes('refresh token')) {
          throw new Error('REFRESH_TOKEN_EXPIRED: User must re-authenticate');
        }

        throw error;
      }
    })();

    // Store promise in active refreshes
    activeRefreshes.set(microsoftId, refreshPromise);

    try {
      const accessToken = await refreshPromise;
      return accessToken;
    } finally {
      // Clean up active refresh
      activeRefreshes.delete(microsoftId);
    }

  } catch (error) {
    console.error('❌ [MICROSOFT_GRAPH_ERROR] Failed to get valid access token:', error);
    throw error;
  }
}

/**
 * Creates authenticated Graph client for user
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {boolean} [forceRefresh=false] - Force token refresh
 * @returns {Promise<Object>} Microsoft Graph Client
 */
async function getAuthenticatedClient(microsoftId, forceRefresh = false) {
  const accessToken = await getValidAccessToken(microsoftId, forceRefresh);
  return createGraphClient(accessToken);
}

/**
 * Wrapper to handle Microsoft Graph API calls with automatic retry and token refresh
 *
 * Equivalent to handleGoogleApiCall in googleApiService.js
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Function} apiCall - Async function that makes the API call
 * @param {number} [retryCount=0] - Current retry count
 * @returns {Promise<*>} API call result
 */
async function handleGraphApiCall(microsoftId, apiCall, retryCount = 0) {
  const MAX_RETRIES = 2;
  const callTimer = startTimer();

  try {
    const result = await apiCall();
    logDuration('graph.apiCall', callTimer, {
      microsoftId,
      retry: retryCount
    });
    return result;
  } catch (error) {
    logDuration('graph.apiCall', callTimer, {
      microsoftId,
      retry: retryCount,
      status: 'error',
      error: error?.statusCode || error?.code || error?.message?.slice(0, 120) || 'unknown'
    });

    // Check for 401 Unauthorized (token expired)
    const is401 = error.statusCode === 401 ||
                  error.code === 'InvalidAuthenticationToken' ||
                  error.message?.includes('Access token has expired') ||
                  error.message?.includes('Unauthorized');

    if (is401 && retryCount < MAX_RETRIES) {
      console.log(`⚠️ 401 error detected (attempt ${retryCount + 1}/${MAX_RETRIES + 1}), forcing token refresh...`);

      try {
        // Force token refresh
        await getValidAccessToken(microsoftId, true);

        console.log('🔄 Retrying API call with refreshed token...');
        return await handleGraphApiCall(microsoftId, apiCall, retryCount + 1);
      } catch (refreshError) {
        console.error('❌ Token refresh failed during retry:', refreshError);
        throw refreshError;
      }
    }

    // For other errors or max retries exceeded, throw
    throw error;
  }
}

// ==================== TO BE CONTINUED ====================
// This is Part 1 of microsoftGraphService.js
// Part 2 will include Mail API functions
// Part 3 will include Calendar API functions
// Part 4 will include Tasks and Contacts API functions

// Placeholder exports (will be implemented in next parts)
export {
  EMAIL_SIZE_LIMITS,
  getValidAccessToken,
  getDebugDiagnostics,
  flushDebugCaches
};
