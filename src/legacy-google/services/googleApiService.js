import { google } from 'googleapis';
import { refreshAccessToken } from '../config/oauth.js';
import { getUserByGoogleSub, updateTokens, updateLastUsed } from './databaseService.js';
import { generateSignedAttachmentUrl } from '../utils/signedUrlGenerator.js';
import { isBlocked } from '../utils/attachmentSecurity.js';
import { getPragueOffsetHours } from '../utils/helpers.js';
import { REFERENCE_TIMEZONE } from '../config/limits.js';
import { debugStep, wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { logDuration, startTimer } from '../utils/performanceLogger.js';
import dotenv from 'dotenv';
import { determineExpiryDate, isTokenExpired } from '../utils/tokenExpiry.js';
import { retryWithExponentialBackoff, isRetryableError } from '../utils/exponentialBackoff.js';
import { mapGoogleApiError, throwServiceError } from './serviceErrors.js';
import {
  UNREPLIED_LABEL_NAME,
  UNREPLIED_LABEL_DEFAULTS,
  TRACKING_LABEL_NAME,
  TRACKING_LABEL_DEFAULTS,
  FOLLOWUP_LABEL_NAME,
  FOLLOWUP_LABEL_DEFAULTS
} from '../config/unrepliedLabels.js';
import {
  isGmailColorSupported,
  findClosestGmailColor,
  GMAIL_LABEL_PRESETS
} from '../config/gmailColorPalette.js';
// pdf-parse má problém s importem - načteme až když je potřeba
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

// ==================== LABEL DIRECTORY CACHE ====================
const LABEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes is enough for interactive sessions
const labelDirectoryCache = new Map();

const USER_ADDRESS_CACHE_TTL_MS = 5 * 60 * 1000;
const userAddressCache = new Map();

const DEBUG_CACHE_ENTRY_LIMIT = 20;

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
    labelDirectoryCache: summarizeCacheEntries(labelDirectoryCache, {
      ttlMs: LABEL_CACHE_TTL_MS,
      valueSummary: value => ({
        labelCount: Array.isArray(value?.labels) ? value.labels.length : 0
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
    normalizedTargets.filter(target => target === 'labels' || target === 'addresses')
  );

  if (targetSet.size === 0) {
    targetSet.add('labels');
    targetSet.add('addresses');
  }

  const cleared = {};

  if (targetSet.has('labels')) {
    const removed = labelDirectoryCache.size;
    labelDirectoryCache.clear();
    cleared.labels = removed;
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

/**
 * Create authenticated Google API client
 */
async function getAuthenticatedClient(googleSub, forceRefresh = false) {
  const accessToken = await getValidAccessToken(googleSub, forceRefresh);
  
  const { OAuth2 } = google.auth;
  const client = new OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  
  client.setCredentials({ access_token: accessToken });
  
  return client;
}

/**
 * Wrapper to handle Google API errors with automatic token refresh on 401
 */
async function handleGoogleApiCall(googleSub, apiCall, retryCount = 0) {
  const MAX_RETRIES = 2;
  const callTimer = startTimer();

  try {
    const result = await apiCall();
    logDuration('google.apiCall', callTimer, {
      googleSub,
      retry: retryCount
    });
    return result;
  } catch (error) {
    logDuration('google.apiCall', callTimer, {
      googleSub,
      retry: retryCount,
      status: 'error',
      error: error?.code || error?.response?.status || error?.message?.slice(0, 120) || 'unknown'
    });
    const is401 = error.code === 401 ||
                  error.response?.status === 401 ||
                  error.message?.includes('Login Required') ||
                  error.message?.includes('Invalid Credentials') ||
                  error.message?.includes('invalid_grant');
    
    if (is401 && retryCount < MAX_RETRIES) {
      console.log(`⚠️ 401 error detected (attempt ${retryCount + 1}/${MAX_RETRIES + 1}), forcing token refresh...`);

      try {
        await getValidAccessToken(googleSub, true);
        await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
        return await handleGoogleApiCall(googleSub, apiCall, retryCount + 1);
      } catch (refreshError) {
        if (refreshError.message?.includes('invalid_grant') ||
            refreshError.message?.includes('Token has been expired')) {
          throwServiceError('Your session has expired. Please log in again.', {
            statusCode: 401,
            code: 'GOOGLE_UNAUTHORIZED',
            requiresReauth: true,
            cause: refreshError
          });
        }
      }
    }

    if (is401) {
      throwServiceError('Authentication required - please log in again', {
        statusCode: 401,
        code: 'GOOGLE_UNAUTHORIZED',
        requiresReauth: true,
        cause: error
      });
    }

    throw mapGoogleApiError(error, {
      message: 'Google API request failed',
      details: { googleSub },
      cause: error
    });
  }
}

/**
 * Get valid access token (auto-refresh if expired)
 */
async function getValidAccessToken(googleSub, forceRefresh = false) {
  const overallTimer = startTimer();
  let refreshed = false;
  let status = 'success';
  let lastError;

  try {
    debugStep('Resolving valid access token', { googleSub, forceRefresh });
    const user = await getUserByGoogleSub(googleSub);

    if (!user) {
      debugStep('User missing in database', { googleSub });
      throwServiceError('User not found in database', {
        statusCode: 401,
        code: 'GOOGLE_USER_NOT_FOUND',
        requiresReauth: true
      });
    }

    updateLastUsed(googleSub).catch(err =>
      console.error('Failed to update last_used:', err.message)
    );

    const isExpired = isTokenExpired(user.tokenExpiry);

    if (forceRefresh || isExpired) {
      debugStep('Access token requires refresh', {
        forceRefresh,
        isExpired,
        expiry: user.tokenExpiry
      });
      if (activeRefreshes.has(googleSub)) {
        const waitTimer = startTimer();
        await activeRefreshes.get(googleSub);
        logDuration('google.tokenRefresh.waitForExisting', waitTimer, { googleSub });
        refreshed = true;
        const updatedUser = await getUserByGoogleSub(googleSub);
        debugStep('Awaited existing refresh promise', { googleSub });
        return updatedUser.accessToken;
      }

      const refreshPromise = (async () => {
        try {
          debugStep('Refreshing access token with Google', { googleSub });
          const refreshTimer = startTimer();
          const newTokens = await refreshAccessToken(user.refreshToken);
          logDuration('google.refreshAccessToken', refreshTimer, { googleSub });

          const expiryDate = determineExpiryDate(newTokens);

          await updateTokens(googleSub, {
            accessToken: newTokens.access_token,
            refreshToken: newTokens.refresh_token || user.refreshToken,
            expiryDate,
            email: user.email,
            source: 'refresh:googleApiService'
          });

          console.log('✅ Access token refreshed successfully');
          debugStep('Stored refreshed tokens', { googleSub, expiryDate });
          refreshed = true;
          return newTokens.access_token;
        } catch (refreshError) {
          debugStep('Refresh token request failed', {
            googleSub,
            error: refreshError.message
          });
          throwServiceError('Authentication required - please log in again', {
            statusCode: 401,
            code: 'GOOGLE_UNAUTHORIZED',
            requiresReauth: true,
            cause: refreshError
          });
        } finally {
          debugStep('Released refresh mutex', { googleSub });
          activeRefreshes.delete(googleSub);
        }
      })();

      activeRefreshes.set(googleSub, refreshPromise);
      return await refreshPromise;
    }

    debugStep('Returning cached access token', { googleSub });
    return user.accessToken;
  } catch (error) {
    console.error('❌ [TOKEN_ERROR] Failed to get valid access token:', error.message);
    status = 'error';
    lastError = error;
    throw mapGoogleApiError(error, {
      message: 'Failed to resolve Google access token',
      details: { googleSub, forceRefresh },
      cause: error
    });
  } finally {
    logDuration('google.getValidAccessToken', overallTimer, {
      googleSub,
      forceRefresh,
      refreshed,
      status,
      verificationMethod: 'google',
      publicFields: ['verificationMethod'],
      error: lastError?.message?.slice(0, 120)
    });
  }
}

// ==================== HELPER FUNCTIONS ====================

function extractPlainText(payload) {
  let text = '';

  if (!payload) return text;

  if (payload.body && payload.body.data) {
    try {
      text = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } catch (e) {
      console.error('Error decoding body:', e.message);
    }
  }
  
  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        try {
          text += Buffer.from(part.body.data, 'base64').toString('utf-8');
        } catch (e) {
          console.error('Error decoding part:', e.message);
        }
      }
      
      if (part.parts) {
        text += extractPlainText(part);
      }
    }
  }

  return text;
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '\n\n[... Text zkrácen kvůli velikosti ...]';
}

function generateGmailLinks(threadId, messageId) {
  if (!threadId) {
    return null;
  }

  const threadLink = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
  const messageLink = messageId
    ? `${threadLink}?projector=1&messageId=${messageId}`
    : null;

  return {
    thread: threadLink,
    message: messageLink
  };
}

/**
 * Generate Gmail links for drafts
 * @param {string} draftId - The draft ID
 * @param {string} messageId - The message ID (optional)
 * @returns {object|null} Object with draft and message links, or null if draftId is missing
 */
function generateDraftLinks(draftId, messageId) {
  if (!draftId) {
    return null;
  }

  const draftLink = `https://mail.google.com/mail/u/0/#drafts/${draftId}`;
  const messageLink = messageId
    ? `${draftLink}?projector=1&messageId=${messageId}`
    : null;

  return {
    draft: draftLink,
    message: messageLink
  };
}

/**
 * Decorate a draft object with links and normalize ID
 *
 * IMPORTANT: This function returns message.id as the primary 'id' field instead of draft.id
 * because message.id is stable (doesn't change when user opens draft in Gmail UI),
 * while draft.id changes frequently. The original draft.id is preserved in the 'draftId' field.
 *
 * @param {object} draft - The draft object from Gmail API
 * @returns {object} Draft object with links added and normalized ID
 */
function decorateDraftWithLinks(draft) {
  if (!draft || typeof draft !== 'object') {
    return draft;
  }

  if (draft.links && typeof draft.links === 'object') {
    return draft;
  }

  const draftId = draft.id;
  const messageId = draft.message?.id;

  const links = generateDraftLinks(draftId, messageId);
  if (!links) {
    return draft;
  }

  const decorated = {
    ...draft,
    links
  };

  // Return message.id as primary ID for stability
  // Keep original draft.id for reference
  if (messageId) {
    return {
      ...decorated,
      id: messageId,
      draftId: draftId
    };
  }

  return decorated;
}

/**
 * Decorate an array of drafts with links
 * @param {array} drafts - Array of draft objects
 * @returns {array} Array of drafts with links added
 */
function decorateDraftsWithLinks(drafts) {
  if (!Array.isArray(drafts)) {
    return drafts;
  }

  return drafts.map(draft => decorateDraftWithLinks(draft));
}

function decorateMessageWithLinks(message, fallbackThreadId) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  if (message.links && typeof message.links === 'object') {
    return message;
  }

  const resolvedThreadId = typeof message.threadId === 'string' && message.threadId.length > 0
    ? message.threadId
    : (typeof fallbackThreadId === 'string' && fallbackThreadId.length > 0
        ? fallbackThreadId
        : (typeof message.thread?.id === 'string' && message.thread.id.length > 0
            ? message.thread.id
            : (typeof message.id === 'string' && message.id.length > 0 ? message.id : null)));

  const resolvedMessageId = typeof message.id === 'string' && message.id.length > 0
    ? message.id
    : (typeof message.messageId === 'string' && message.messageId.length > 0 ? message.messageId : null);

  const links = generateGmailLinks(resolvedThreadId, resolvedMessageId);
  if (!links) {
    return message;
  }

  return {
    ...message,
    links
  };
}

function decorateMessagesWithLinks(messages, { fallbackThreadId } = {}) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  let mutated = false;
  const decorated = messages.map(message => {
    const decoratedMessage = decorateMessageWithLinks(message, fallbackThreadId);
    if (decoratedMessage !== message) {
      mutated = true;
    }
    return decoratedMessage;
  });

  return mutated ? decorated : messages;
}

function decorateThreadsWithLinks(threads) {
  if (!Array.isArray(threads)) {
    return threads;
  }

  let mutated = false;

  const decorated = threads.map(thread => {
    if (!thread || typeof thread !== 'object') {
      return thread;
    }

    let updated = thread;
    const threadId = typeof thread.threadId === 'string' && thread.threadId.length > 0
      ? thread.threadId
      : (typeof thread.id === 'string' && thread.id.length > 0 ? thread.id : null);

    if (!thread.links) {
      const representativeMessageId = typeof thread.lastMessageId === 'string' && thread.lastMessageId.length > 0
        ? thread.lastMessageId
        : (Array.isArray(thread.messages) && thread.messages.length > 0
            ? thread.messages[thread.messages.length - 1]?.id ?? null
            : null);

      const threadLinks = generateGmailLinks(threadId, representativeMessageId);
      if (threadLinks) {
        updated = {
          ...updated,
          links: threadLinks
        };
      }
    }

    if (Array.isArray(thread.messages)) {
      const decoratedMessages = decorateMessagesWithLinks(thread.messages, { fallbackThreadId: threadId });
      if (decoratedMessages !== thread.messages) {
        if (updated === thread) {
          updated = { ...thread };
        }
        updated.messages = decoratedMessages;
      }
    }

    if (updated !== thread) {
      mutated = true;
    }

    return updated;
  });

  return mutated ? decorated : threads;
}

function getHeaderValue(headers = [], name) {
  const lower = name.toLowerCase();
  return headers.find(header => header.name?.toLowerCase() === lower)?.value || '';
}

function formatPragueTimestamps(internalDate) {
  if (!internalDate) {
    return null;
  }

  const timestamp = typeof internalDate === 'string'
    ? parseInt(internalDate, 10)
    : Number(internalDate);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const utcDate = new Date(timestamp);
  const offsetHours = getPragueOffsetHours(utcDate);
  const pragueDate = new Date(utcDate.getTime() + offsetHours * 60 * 60 * 1000);
  const sign = offsetHours >= 0 ? '+' : '-';
  const offset = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;

  return {
    epochMs: timestamp,
    utc: utcDate.toISOString(),
    prague: pragueDate.toISOString().replace('Z', offset),
    offsetHours
  };
}

function extractEmailAddress(value) {
  if (!value) {
    return null;
  }

  const match = value.match(/<([^>]+)>/);
  if (match) {
    return match[1].trim().toLowerCase();
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch
    ? emailMatch[0].trim().toLowerCase()
    : value.trim().toLowerCase();
}

function parseAddressList(headerValue) {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/<([^>]+)>/);
      const address = match
        ? match[1].trim()
        : part.replace(/^["']|["']$/g, '').trim();

      const nameRaw = match
        ? part.replace(match[0], '').trim()
        : '';

      const name = nameRaw ? nameRaw.replace(/^["']|["']$/g, '') : null;

      return {
        address,
        name,
        raw: part,
        normalized: address.toLowerCase()
      };
    });
}

function buildRecipientList(headerValue, userEmailNormalized) {
  return parseAddressList(headerValue).map(entry => ({
    address: entry.address,
    name: entry.name,
    raw: entry.raw,
    isUser: userEmailNormalized ? entry.normalized === userEmailNormalized : false
  }));
}

function collectParticipants(messages, userEmailNormalized) {
  const seen = new Map();

  for (const message of messages) {
    const headers = message.payload?.headers || [];
    const fields = ['From', 'To', 'Cc', 'Bcc'];

    for (const field of fields) {
      const entries = parseAddressList(getHeaderValue(headers, field));
      for (const entry of entries) {
        if (!entry.address) {
          continue;
        }

        const key = entry.normalized;
        if (!seen.has(key)) {
          seen.set(key, {
            address: entry.address,
            name: entry.name,
            raw: entry.raw,
            firstSeenIn: field.toLowerCase(),
            firstMessageId: message.id,
            isUser: userEmailNormalized ? key === userEmailNormalized : false
          });
        }
      }
    }
  }

  return Array.from(seen.values());
}

function findLastInboundMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const labels = message.labelIds || [];

    if (labels.includes('SENT') || labels.includes('DRAFT')) {
      continue;
    }

    return message;
  }

  return null;
}

function hasFileAttachments(payload) {
  if (!payload) {
    return false;
  }

  const stack = Array.isArray(payload.parts) ? [...payload.parts] : [];

  while (stack.length > 0) {
    const part = stack.pop();
    if (!part) {
      continue;
    }

    if (part.body?.attachmentId && (part.filename || '').trim().length > 0) {
      return true;
    }

    if (Array.isArray(part.parts) && part.parts.length > 0) {
      stack.push(...part.parts);
    }
  }

  return false;
}

function buildContentMetadata(payload) {
  if (!payload) {
    return null;
  }

  const state = {
    plainText: {
      available: false,
      bytes: 0,
      preview: null,
      truncated: false
    },
    html: {
      available: false,
      inline: false,
      viaAttachments: false,
      bytes: 0,
      preview: null,
      truncated: false
    },
    inlineImages: 0,
    inlineAttachments: 0
  };

  function updatePreview(target, text) {
    if (!text) {
      return;
    }

    if (!target.preview) {
      const trimmed = text.length > CONTENT_PREVIEW_LIMIT
        ? text.substring(0, CONTENT_PREVIEW_LIMIT)
        : text;
      target.preview = trimmed;
      target.truncated = text.length > CONTENT_PREVIEW_LIMIT;
    }
  }

  function decodeBody(body) {
    if (!body) return { text: '', bytes: 0 };

    if (body.data) {
      try {
        const buffer = Buffer.from(body.data, 'base64');
        return {
          text: buffer.toString('utf-8'),
          bytes: buffer.length
        };
      } catch (error) {
        console.error('Failed to decode MIME part:', error.message);
        return { text: '', bytes: 0 };
      }
    }

    if (typeof body.size === 'number') {
      return { text: '', bytes: body.size };
    }

    return { text: '', bytes: 0 };
  }

  function processPart(part) {
    if (!part) return;

    const mimeType = part.mimeType || '';
    const lowerMime = mimeType.toLowerCase();

    if (lowerMime.startsWith('multipart/')) {
      (part.parts || []).forEach(processPart);
      return;
    }

    const { text, bytes } = decodeBody(part.body);

    if (lowerMime === 'text/plain') {
      state.plainText.available = true;
      state.plainText.bytes += bytes;
      updatePreview(state.plainText, text);
    } else if (lowerMime === 'text/html') {
      state.html.available = true;
      state.html.bytes += bytes;
      if (part.body?.data) {
        state.html.inline = true;
        updatePreview(state.html, text);
      }
      if (part.body?.attachmentId) {
        state.html.viaAttachments = true;
      }
    } else {
      const headers = part.headers || [];
      const hasContentId = headers.some(h => h.name?.toLowerCase() === 'content-id');
      const disposition = headers.find(h => h.name?.toLowerCase() === 'content-disposition')?.value || '';
      const isInline = hasContentId || disposition.toLowerCase().includes('inline');

      if (isInline) {
        if (lowerMime.startsWith('image/')) {
          state.inlineImages += 1;
        } else {
          state.inlineAttachments += 1;
        }
      }
    }

    if (part.parts) {
      part.parts.forEach(processPart);
    }
  }

  processPart(payload);

  return state;
}

/**
 * FIX: Classify email into inbox category based on Gmail labels
 * @param {object} message - Gmail message object with labelIds
 * @returns {string} Category: primary, work, promotions, social, updates, forums,
 *                   sent, draft, archived, trash, spam, other
 */
function buildReadState(labelIds = []) {
  const labels = Array.isArray(labelIds) ? labelIds : [];
  const normalized = labels.map(label => label.toUpperCase());
  const isUnread = normalized.includes('UNREAD');

  return {
    isUnread,
    isRead: !isUnread
  };
}

function classifyEmailCategory(message) {
  if (!message || !message.labelIds) {
    return 'other';
  }

  const labelIds = message.labelIds || [];
  const labelIdLowercase = labelIds.map(l => l.toLowerCase());

  // Gmail system labels (canonical names)
  const hasLabel = (name) => labelIdLowercase.includes(name.toLowerCase());

  // Sent/Drafts/Trash/Spam should be recognized regardless of Inbox status
  if (hasLabel('TRASH')) {
    return 'trash';
  }

  if (hasLabel('SPAM')) {
    return 'spam';
  }

  if (hasLabel('SENT')) {
    return 'sent';
  }

  if (hasLabel('DRAFT')) {
    return 'draft';
  }

  const inInbox = hasLabel('INBOX');

  // Messages outside of the inbox (but not sent/draft/trash/spam) are archived
  if (!inInbox) {
    return 'archived';
  }

  // Check categories in priority order
  // Note: Gmail category labels are internal - check by label name patterns

  // CATEGORY_PROMOTIONS
  if (hasLabel('CATEGORY_PROMOTIONS')) {
    return 'promotions';
  }
  
  // CATEGORY_SOCIAL
  if (hasLabel('CATEGORY_SOCIAL')) {
    return 'social';
  }
  
  // CATEGORY_UPDATES
  if (hasLabel('CATEGORY_UPDATES')) {
    return 'updates';
  }
  
  // CATEGORY_FORUMS
  if (hasLabel('CATEGORY_FORUMS')) {
    return 'forums';
  }
  
  // CATEGORY_PERSONAL/PRIMARY - these are "important" emails
  // Check both IMPORTANT flag and CATEGORY_PERSONAL
  if (hasLabel('IMPORTANT') || hasLabel('CATEGORY_PERSONAL')) {
    return 'primary';
  }
  
  // Check for work-related patterns (custom user labels containing 'work')
  for (const label of labelIds) {
    if (label.toLowerCase().includes('work')) {
      return 'work';
    }
  }

  // If none matched, return other
  return 'other';
}

/**
 * Extract attachments from email payload
 */
function extractAttachments(payload, messageId) {
  const attachments = [];
  
  if (!payload || !payload.parts) return attachments;
  
  function traverseParts(parts) {
    for (const part of parts) {
      if (part.filename && part.body && part.body.attachmentId) {
        attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body.size || 0,
          isInline: part.headers?.some(h => 
            h.name.toLowerCase() === 'content-disposition' && 
            h.value.includes('inline')
          ) || false,
          cid: part.headers?.find(h => 
            h.name.toLowerCase() === 'content-id'
          )?.value?.replace(/[<>]/g, '') || null
        });
      }
      
      if (part.parts) {
        traverseParts(part.parts);
      }
    }
  }
  
  traverseParts(payload.parts);
  return attachments;
}

// ==================== GMAIL FUNCTIONS ====================

async function sendEmail(googleSub, { to, subject, body, cc, bcc }) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
    
    const messageParts = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      'Content-Transfer-Encoding: 7bit',
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
    ];

    if (cc) messageParts.push(`Cc: ${cc}`);
    if (bcc) messageParts.push(`Bcc: ${bcc}`);
    
    messageParts.push('', body);

    const message = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(message, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });

    console.log('✅ Email sent:', result.data.id);

    // Add links to sent message
    return decorateMessageWithLinks(result.data);
  });
}

/**
 * Extract email metadata (from, subject, date) from Gmail message
 * @param {object} messageData - Gmail message data with payload.headers
 * @returns {object} Extracted metadata fields
 */
function extractEmailMetadata(messageData) {
  const headers = messageData?.payload?.headers || [];
  const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
  const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';

  let from = fromHeader;
  let fromEmail = fromHeader;
  let fromName = '';

  const emailMatch = fromHeader.match(/<(.+)>/);
  if (emailMatch) {
    fromEmail = emailMatch[1];
    fromName = fromHeader.replace(/<.+>/, '').trim().replace(/^["']|["']$/g, '');
  }

  // FIX 20.10.2025: Return Prague local time with timezone offset, not UTC
  // Reason: UTC without timezone info (11:02Z) gets displayed wrong by GPT
  // Now: Prague local time (13:02+02:00) so GPT knows the timezone
  const utcDate = new Date(parseInt(messageData.internalDate));
  const offsetHours = getPragueOffsetHours(utcDate);
  const pragueDate = new Date(utcDate.getTime() + offsetHours * 60 * 60 * 1000);
  const pragueIso = pragueDate.toISOString().replace('Z', `+${String(offsetHours).padStart(2, '0')}:00`);

  return {
    from,
    fromEmail,
    fromName,
    subject: subjectHeader,
    date: pragueIso
  };
}

/**
 * Read email with optional includeAttachments parameter
 * @param {string|object} options - format string OR options object
 */
async function readEmail(googleSub, messageId, options = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    // Handle string format parameter for backwards compatibility
    const opts = typeof options === 'string' 
      ? { format: options }
      : (options || {});
    
    const { 
      format = 'full',
      autoTruncate = true,
      includeAttachments = false
    } = opts;

    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const metadataResult = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date']
    });

    const sizeEstimate = metadataResult.data.sizeEstimate || 0;
    const snippet = metadataResult.data.snippet || '';
    
    if (format === 'snippet') {
      return {
        id: messageId,
        snippet: snippet,
        sizeEstimate: sizeEstimate,
        headers: metadataResult.data.payload.headers,
        labelIds: metadataResult.data.labelIds || [],
        readState: buildReadState(metadataResult.data.labelIds),
        format: 'snippet',
        threadId: metadataResult.data.threadId,
        links: generateGmailLinks(metadataResult.data.threadId, messageId)
      };
    }

    if (format === 'metadata') {
      const metadata = extractEmailMetadata(metadataResult.data);

      return {
        ...metadataResult.data,
        ...metadata,  // Add extracted from, subject, date fields
        snippet: snippet,
        readState: buildReadState(metadataResult.data.labelIds),
        links: generateGmailLinks(metadataResult.data.threadId, messageId)
      };
    }

    const isTooLarge = sizeEstimate > EMAIL_SIZE_LIMITS.MAX_SIZE_BYTES;

    if (isTooLarge && autoTruncate) {
      const fullResult = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: format === 'minimal' ? 'minimal' : 'full'
      });

      const plainText = extractPlainText(fullResult.data.payload);
      const truncatedText = truncateText(plainText, EMAIL_SIZE_LIMITS.MAX_BODY_LENGTH);

      // FIX: Extract metadata for truncated emails
      const metadata = extractEmailMetadata(metadataResult.data);

      const response = {
        ...metadataResult.data,
        ...metadata,  // Add extracted from, subject, date fields
        snippet: snippet,
        bodyPreview: truncatedText,
        truncated: true,
        truncationInfo: {
          originalSize: sizeEstimate,
          maxAllowedSize: EMAIL_SIZE_LIMITS.MAX_SIZE_BYTES,
          truncatedBodyLength: EMAIL_SIZE_LIMITS.MAX_BODY_LENGTH
        },
        readState: buildReadState(metadataResult.data.labelIds),
        links: generateGmailLinks(metadataResult.data.threadId, messageId)
      };

      if (includeAttachments) {
        response.attachments = extractAttachments(fullResult.data.payload, messageId);
      }

      const contentMetadata = buildContentMetadata(fullResult.data.payload);
      if (contentMetadata) {
        response.contentMetadata = contentMetadata;
      }

      return response;
    }

    const result = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: format === 'minimal' ? 'minimal' : 'full'
    });

    // FIX: Extract metadata (from, subject, date) for full format
    const metadata = extractEmailMetadata(result.data);

    const response = {
      ...result.data,
      ...metadata,  // Add extracted from, subject, date fields
      truncated: false,
      readState: buildReadState(result.data.labelIds),
      links: generateGmailLinks(result.data.threadId, messageId)
    };

    if (includeAttachments) {
      response.attachments = extractAttachments(result.data.payload, messageId);
    }

    const contentMetadata = buildContentMetadata(result.data.payload);
    if (contentMetadata) {
      response.contentMetadata = contentMetadata;
    }

    return response;
  });
}

async function getEmailPreview(googleSub, messageId, options = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    const { maxBytes = 4096 } = options || {};

    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const result = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const data = result.data || {};
    const payload = clonePayloadForPreview(data.payload, maxBytes);

    return {
      id: data.id,
      threadId: data.threadId,
      labelIds: data.labelIds || [],
      snippet: data.snippet || '',
      internalDate: data.internalDate,
      payload,
      links: generateGmailLinks(data.threadId, messageId)
    };
  });
}

async function searchEmails(googleSub, { query, q, maxResults = 100, pageToken, labelIds, relative, after, before } = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    let finalQuery = typeof query === 'string' && query.trim().length > 0
      ? query.trim()
      : (typeof q === 'string' && q.trim().length > 0 ? q.trim() : '');

    // Handle date filters (same logic as gmailController)
    let dateFilter = '';
    if (relative) {
      const { parseRelativeTime } = await import('../utils/helpers.js');
      const times = parseRelativeTime(relative);
      if (times) {
        dateFilter = `after:${times.after} before:${times.before}`;
      }
    } else {
      // Support explicit after/before parameters (format: YYYY/MM/DD or YYYY-MM-DD)
      if (after) {
        const afterDate = after.replace(/-/g, '/');  // Convert YYYY-MM-DD to YYYY/MM/DD for Gmail
        dateFilter += `after:${afterDate} `;
      }
      if (before) {
        const beforeDate = before.replace(/-/g, '/');  // Convert YYYY-MM-DD to YYYY/MM/DD for Gmail
        dateFilter += `before:${beforeDate}`;
      }
      dateFilter = dateFilter.trim();
    }

    // Append date filter to query
    if (dateFilter) {
      finalQuery = `${finalQuery} ${dateFilter}`.trim();
    }

    const params = {
      userId: 'me',
      q: finalQuery || undefined,
      maxResults
    };

    if (pageToken) params.pageToken = pageToken;

    const normalizedLabelIds = Array.isArray(labelIds)
      ? labelIds
      : (typeof labelIds === 'string' ? [labelIds] : []);

    const finalLabelIds = normalizedLabelIds
      .map(id => (typeof id === 'string' ? id.trim() : ''))
      .filter(id => id.length > 0);

    if (finalLabelIds.length > 0) {
      params.labelIds = finalLabelIds;
    }

    const result = await gmail.users.messages.list(params);
    const data = result.data || {};

    const decoratedMessages = decorateMessagesWithLinks(data.messages);
    const decoratedThreads = decorateThreadsWithLinks(data.threads);

    if (decoratedMessages !== data.messages || decoratedThreads !== data.threads) {
      const response = { ...data };
      if (decoratedMessages !== data.messages) {
        response.messages = decoratedMessages;
      }
      if (decoratedThreads !== data.threads) {
        response.threads = decoratedThreads;
      }
      return response;
    }

    return data;
  });
}

function buildDraftMimeMessage({ to, subject, body, cc, bcc }) {
  const safeSubject = typeof subject === 'string' ? subject.trim() : '';
  if (!safeSubject) {
    throwServiceError('Draft subject is required', {
      statusCode: 400,
      code: 'DRAFT_SUBJECT_REQUIRED',
      expose: true
    });
  }

  const safeBody = typeof body === 'string' ? body : '';
  const encodedSubject = `=?UTF-8?B?${Buffer.from(safeSubject, 'utf8').toString('base64')}?=`;

  const headers = [
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    'Content-Transfer-Encoding: 7bit'
  ];

  const addressHeaders = [
    { key: 'To', value: to },
    { key: 'Cc', value: cc },
    { key: 'Bcc', value: bcc }
  ];

  for (const { key, value } of addressHeaders) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        headers.push(`${key}: ${trimmed}`);
      }
    }
  }

  headers.push(`Subject: ${encodedSubject}`);

  const message = [...headers, '', safeBody].join('\r\n');

  return Buffer.from(message, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function listFollowupCandidates(googleSub, options = {}) {
  const dbUser = await getUserByGoogleSub(googleSub).catch(() => null);
  const userEmailNormalized = dbUser?.email?.toLowerCase() || null;

  const {
    minAgeDays = 3,
    maxAgeDays = 14,
    maxThreads = 15,
    includeBodies = true,
    includeDrafts = false,
    query: additionalQuery,
    historyLimit = 5,
    pageToken
  } = options || {};

  const parsedMinAge = Number(minAgeDays);
  const safeMinAge = Number.isFinite(parsedMinAge) && parsedMinAge >= 0
    ? parsedMinAge
    : 3;

  const parsedMaxAge = Number(maxAgeDays);
  let safeMaxAge = Number.isFinite(parsedMaxAge) && parsedMaxAge > 0
    ? parsedMaxAge
    : null;

  if (safeMaxAge !== null && safeMaxAge < safeMinAge) {
    throwServiceError('maxAgeDays must be greater than or equal to minAgeDays', {
      statusCode: 400,
      code: 'INVALID_FOLLOWUP_WINDOW',
      expose: true,
      details: { minAgeDays: safeMinAge, maxAgeDays: safeMaxAge }
    });
  }

  const parsedMaxThreads = Number(maxThreads);
  const safeMaxThreads = Math.min(50, Math.max(1, Number.isFinite(parsedMaxThreads) ? Math.floor(parsedMaxThreads) : 15));

  const parsedHistoryLimit = Number(historyLimit);
  const safeHistoryLimit = Math.min(10, Math.max(1, Number.isFinite(parsedHistoryLimit) ? Math.floor(parsedHistoryLimit) : 5));

  const queryParts = ['in:sent', '-label:drafts', '-label:chats', '-label:spam'];

  if (safeMinAge >= 1) {
    queryParts.push(`older_than:${Math.floor(safeMinAge)}d`);
  }

  if (safeMaxAge !== null) {
    queryParts.push(`newer_than:${Math.ceil(safeMaxAge)}d`);
  }

  if (typeof additionalQuery === 'string' && additionalQuery.trim().length > 0) {
    queryParts.push(additionalQuery.trim());
  }

  const searchQuery = queryParts.join(' ').replace(/\s+/g, ' ').trim();

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const threads = [];
    const seenThreadIds = new Set();
    const stats = {
      scannedMessages: 0,
      inspectedThreads: 0,
      skipped: {}
    };

    const now = Date.now();
    const minAgeMs = safeMinAge * DAY_IN_MS;
    const maxAgeMs = safeMaxAge !== null ? safeMaxAge * DAY_IN_MS : null;

    let nextPageToken = null;
    const initialPageToken = typeof pageToken === 'string' && pageToken.trim().length > 0
      ? pageToken.trim()
      : undefined;
    let currentPageToken = initialPageToken;

    const maxResultsPerCall = Math.min(100, Math.max(20, safeMaxThreads * 4));

    while (threads.length < safeMaxThreads) {
      const listResult = await gmail.users.messages.list({
        userId: 'me',
        q: searchQuery,
        labelIds: ['SENT'],
        maxResults: maxResultsPerCall,
        pageToken: currentPageToken
      });

      const messageRefs = listResult.data.messages || [];
      stats.scannedMessages += messageRefs.length;

      if (messageRefs.length === 0) {
        nextPageToken = listResult.data.nextPageToken || null;
        break;
      }

      for (const messageRef of messageRefs) {
        if (threads.length >= safeMaxThreads) {
          nextPageToken = listResult.data.nextPageToken || null;
          break;
        }

        if (!messageRef.threadId) {
          stats.skipped.missingThread = (stats.skipped.missingThread || 0) + 1;
          continue;
        }

        if (seenThreadIds.has(messageRef.threadId)) {
          stats.skipped.duplicateThread = (stats.skipped.duplicateThread || 0) + 1;
          continue;
        }

        seenThreadIds.add(messageRef.threadId);

        const threadResult = await gmail.users.threads.get({
          userId: 'me',
          id: messageRef.threadId,
          format: includeBodies ? 'full' : 'metadata'
        });

        const threadMessages = threadResult.data.messages || [];

        if (threadMessages.length === 0) {
          stats.skipped.emptyThread = (stats.skipped.emptyThread || 0) + 1;
          continue;
        }

        stats.inspectedThreads += 1;

        const lastMessage = threadMessages[threadMessages.length - 1];
        const lastInternalDate = parseInt(lastMessage.internalDate, 10);

        if (!Number.isFinite(lastInternalDate)) {
          stats.skipped.missingInternalDate = (stats.skipped.missingInternalDate || 0) + 1;
          continue;
        }

        const ageMs = now - lastInternalDate;

        if (ageMs < minAgeMs) {
          stats.skipped.tooRecent = (stats.skipped.tooRecent || 0) + 1;
          continue;
        }

        if (maxAgeMs !== null && ageMs > maxAgeMs) {
          stats.skipped.tooOld = (stats.skipped.tooOld || 0) + 1;
          continue;
        }

        const lastLabels = lastMessage.labelIds || [];

        if (!lastLabels.includes('SENT')) {
          const fromHeader = getHeaderValue(lastMessage.payload?.headers, 'From');
          const fromAddress = extractEmailAddress(fromHeader);

          if (!fromAddress || (userEmailNormalized && fromAddress !== userEmailNormalized)) {
            stats.skipped.lastNotFromUser = (stats.skipped.lastNotFromUser || 0) + 1;
            continue;
          }
        }

        if (!includeDrafts && lastLabels.includes('DRAFT')) {
          stats.skipped.endsWithDraft = (stats.skipped.endsWithDraft || 0) + 1;
          continue;
        }

        const headers = lastMessage.payload?.headers || [];
        const subject = getHeaderValue(headers, 'Subject') || threadResult.data.snippet || '';
        const toHeader = getHeaderValue(headers, 'To');
        const ccHeader = getHeaderValue(headers, 'Cc');
        const bccHeader = getHeaderValue(headers, 'Bcc');
        const fromHeader = getHeaderValue(headers, 'From');
        const dateHeader = getHeaderValue(headers, 'Date');

        const fromAddressEntry = parseAddressList(fromHeader)[0] || null;
        const senderAddressNormalized = fromAddressEntry?.normalized || extractEmailAddress(fromHeader);

        const lastInboundMessage = findLastInboundMessage(threadMessages);
        const lastInboundTimestamps = lastInboundMessage
          ? formatPragueTimestamps(lastInboundMessage.internalDate)
          : null;
        const lastInboundFrom = lastInboundMessage
          ? getHeaderValue(lastInboundMessage.payload?.headers, 'From')
          : null;

        const timestamps = formatPragueTimestamps(lastInternalDate);
        const waitingDays = timestamps
          ? Number(((now - timestamps.epochMs) / DAY_IN_MS).toFixed(1))
          : null;

        const plainText = includeBodies
          ? truncateText(
              extractPlainText(lastMessage.payload),
              EMAIL_SIZE_LIMITS.MAX_BODY_LENGTH
            )
          : undefined;

        const contentMetadata = includeBodies
          ? buildContentMetadata(lastMessage.payload)
          : undefined;

        const conversation = threadMessages
          .slice(Math.max(0, threadMessages.length - safeHistoryLimit))
          .map(message => {
            const messageHeaders = message.payload?.headers || [];
            const messageTimestamps = formatPragueTimestamps(message.internalDate);
            const labels = message.labelIds || [];
            const direction = labels.includes('SENT')
              ? 'outgoing'
              : (labels.includes('DRAFT') ? 'draft' : 'incoming');

            return {
              id: message.id,
              direction,
              subject: getHeaderValue(messageHeaders, 'Subject') || subject,
              from: getHeaderValue(messageHeaders, 'From') || null,
              to: getHeaderValue(messageHeaders, 'To') || null,
              cc: getHeaderValue(messageHeaders, 'Cc') || null,
              bcc: getHeaderValue(messageHeaders, 'Bcc') || null,
              snippet: message.snippet,
              timestamps: messageTimestamps,
              labelIds: labels,
              hasAttachments: hasFileAttachments(message.payload),
              readState: buildReadState(labels)
            };
          });

        const threadSummary = {
          threadId: threadResult.data.id,
          historyId: threadResult.data.historyId,
          messageCount: threadMessages.length,
          subject,
          snippet: lastMessage.snippet || threadResult.data.snippet || '',
          waitingSince: timestamps,
          waitingDays,
          lastMessageId: lastMessage.id,
          recipients: {
            to: buildRecipientList(toHeader, userEmailNormalized),
            cc: buildRecipientList(ccHeader, userEmailNormalized),
            bcc: buildRecipientList(bccHeader, userEmailNormalized)
          },
          sender: {
            raw: fromHeader || null,
            address: fromAddressEntry?.address || senderAddressNormalized || null,
            name: fromAddressEntry?.name || null,
            isUser: userEmailNormalized
              ? (senderAddressNormalized || '') === userEmailNormalized
              : false
          },
          headers: {
            subject,
            from: fromHeader || null,
            to: toHeader || null,
            cc: ccHeader || null,
            bcc: bccHeader || null,
            date: dateHeader || null
          },
          lastMessage: {
            id: lastMessage.id,
            snippet: lastMessage.snippet,
            timestamps,
            labelIds: lastLabels,
            readState: buildReadState(lastLabels),
            sizeEstimate: lastMessage.sizeEstimate,
            hasAttachments: hasFileAttachments(lastMessage.payload),
            plainText,
            contentMetadata,
            links: generateGmailLinks(threadResult.data.id, lastMessage.id)
          },
          lastInbound: lastInboundMessage
            ? {
                id: lastInboundMessage.id,
                from: lastInboundFrom,
                fromAddress: extractEmailAddress(lastInboundFrom),
                snippet: lastInboundMessage.snippet,
                timestamps: lastInboundTimestamps,
                ageDays: lastInboundTimestamps
                  ? Number(((now - lastInboundTimestamps.epochMs) / DAY_IN_MS).toFixed(1))
                  : null
              }
            : null,
          participants: collectParticipants(threadMessages, userEmailNormalized),
          conversation,
          candidateMessageIds: Array.from(new Set(
            threadMessages
              .map(message => typeof message.id === 'string' ? message.id : null)
              .filter(id => typeof id === 'string' && id.length > 0)
          )),
          links: generateGmailLinks(threadResult.data.id, lastMessage.id)
        };

        threads.push(threadSummary);
      }

      if (threads.length >= safeMaxThreads) {
        break;
      }

      if (!listResult.data.nextPageToken) {
        nextPageToken = null;
        break;
      }

      currentPageToken = listResult.data.nextPageToken;
      nextPageToken = currentPageToken;
    }

    const moreAvailable = threads.length >= safeMaxThreads || Boolean(nextPageToken);

    return {
      threads,
      searchQuery,
      generatedAt: new Date().toISOString(),
      filters: {
        minAgeDays: safeMinAge,
        maxAgeDays: safeMaxAge,
        maxThreads: safeMaxThreads,
        includeBodies,
        includeDrafts,
        historyLimit: safeHistoryLimit,
        additionalQuery: typeof additionalQuery === 'string' && additionalQuery.trim().length > 0
          ? additionalQuery.trim()
          : null,
        pageToken: initialPageToken || null
      },
      stats,
      hasMore: moreAvailable,
      nextPageToken: nextPageToken || null
    };
  });

  const { followupLabel } = await getFollowupLabelContext(googleSub).catch(() => ({
    followupLabel: null
  }));

  const labelRecommendation = buildFollowupLabelRecommendation(followupLabel);

  return {
    ...baseResult,
    labelRecommendation
  };
}

function clonePayloadForPreview(payload, maxBytes) {
  if (!payload) return null;

  const seen = new WeakMap();

  function clonePart(part, budget) {
    if (!part) return { cloned: null, remaining: budget };
    if (seen.has(part)) {
      return { cloned: seen.get(part), remaining: budget };
    }

    const cloned = {
      partId: part.partId,
      mimeType: part.mimeType,
      filename: part.filename,
      headers: part.headers
    };

    seen.set(part, cloned);

    let remaining = budget;

    if (part.body) {
      const { data, ...bodyMeta } = part.body;
      cloned.body = { ...bodyMeta };

      if (typeof data === 'string' && remaining > 0) {
        const estimatedBytes = Math.ceil((data.length * 3) / 4);
        if (estimatedBytes > remaining) {
          const allowedChars = Math.max(0, Math.floor((remaining * 4) / 3));
          const truncated = data.slice(0, allowedChars - (allowedChars % 4 || 0));
          cloned.body.data = truncated;
          remaining = 0;
        } else {
          remaining -= estimatedBytes;
        }
      } else if (typeof data === 'string') {
        cloned.body.data = data;
      }
    }

    if (Array.isArray(part.parts)) {
      cloned.parts = [];
      for (const child of part.parts) {
        const { cloned: clonedChild, remaining: newRemaining } = clonePart(child, remaining);
        if (clonedChild) {
          cloned.parts.push(clonedChild);
        }
        remaining = newRemaining;
      }
    }

    return { cloned, remaining };
  }

  const { cloned } = clonePart(payload, typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : Infinity);
  return cloned;
}

async function replyToEmail(googleSub, messageId, { body }) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const original = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Message-ID']
    });

    const headers = original.data.payload.headers;
    const originalFrom = headers.find(h => h.name === 'From')?.value;
    const originalSubject = headers.find(h => h.name === 'Subject')?.value;
    const originalMessageId = headers.find(h => h.name === 'Message-ID')?.value;

    const { unrepliedLabel } = await getWatchlistLabelContext(googleSub);
    let unrepliedLabelReminder = null;
    if (unrepliedLabel && Array.isArray(original.data.labelIds) && original.data.labelIds.includes(unrepliedLabel.id)) {
      unrepliedLabelReminder = buildUnrepliedLabelReminderPayload(unrepliedLabel, {
        messageIds: [messageId],
        threadId: original.data.threadId
      });
    }

    const replySubject = originalSubject?.replace(/^Re: /, '') || '';
    const encodedSubject = `=?UTF-8?B?${Buffer.from(`Re: ${replySubject}`, 'utf8').toString('base64')}?=`;

    const messageParts = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      'Content-Transfer-Encoding: 7bit',
      `To: ${originalFrom}`,
      `Subject: ${encodedSubject}`,
      `In-Reply-To: ${originalMessageId}`,
      `References: ${originalMessageId}`,
      '',
      body
    ];

    const message = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(message, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: original.data.threadId
      }
    });

    // Add links to sent reply
    const sentMessage = decorateMessageWithLinks(result.data);

    return {
      ...sentMessage,
      unrepliedLabelReminder
    };
  });
}

async function createDraft(googleSub, { to, subject, body, cc, bcc, threadId } = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    if (typeof to !== 'string' || to.trim().length === 0) {
      throwServiceError('Draft recipient is required', {
        statusCode: 400,
        code: 'DRAFT_RECIPIENT_REQUIRED',
        expose: true
      });
    }

    const encodedMessage = buildDraftMimeMessage({ to, subject, body, cc, bcc });

    const requestBody = {
      message: { raw: encodedMessage }
    };

    if (threadId && typeof threadId === 'string' && threadId.trim().length > 0) {
      requestBody.message.threadId = threadId.trim();
    }

    const result = await gmail.users.drafts.create({
      userId: 'me',
      requestBody
    });

    // ✅ VALIDACE draft response
    if (!result.data) {
      console.error('❌ [DRAFT_ERROR] Gmail API vrátila prázdný response');
      throwServiceError('Draft creation failed - empty response from Gmail API', {
        statusCode: 502,
        code: 'GMAIL_DRAFT_INVALID',
        details: { to }
      });
    }

    if (!result.data.id) {
      console.error('🔴 [DRAFT_ERROR] Draft ID chybí v odpovědi!');
      console.error('Full response:', JSON.stringify(result.data, null, 2));
      throwServiceError('Draft creation failed - missing draft ID in response', {
        statusCode: 502,
        code: 'GMAIL_DRAFT_INVALID',
        details: { to }
      });
    }

    if (typeof result.data.id !== 'string') {
      console.error('⚠️ [DRAFT_ERROR] Draft ID má nesprávný typ:', typeof result.data.id);
      throwServiceError('Draft creation failed - draft ID is not a string', {
        statusCode: 502,
        code: 'GMAIL_DRAFT_INVALID',
        details: { to, type: typeof result.data.id }
      });
    }

    // 🔍 DEBUG: Inspekce kompletního response
    console.log(`✅ Draft created successfully`);
    console.log('[DRAFT_RESPONSE_DEBUG]', {
      hasId: !!result.data.id,
      id: result.data.id,
      idType: typeof result.data.id,
      hasMessage: !!result.data.message,
      messageId: result.data.message?.id,
      messageIdType: typeof result.data.message?.id,
      allKeys: Object.keys(result.data)
    });
    console.log(`✅ Using draft.id: ${result.data.id}`);

    // Add links to draft
    // Note: decorateDraftWithLinks now automatically returns message.id as primary ID
    return decorateDraftWithLinks(result.data);
  });
}

/**
 * Helper function to find a draft by ID (tries draft.id first, then message.id)
 *
 * Why this order?
 * - Gmail API requires draft.id for all operations (get/send/update)
 * - Trying draft.id first is O(1) - single API call
 * - Searching by message.id is O(N) - must list all drafts and compare
 *
 * @param {Object} gmail - Authenticated Gmail API client
 * @param {string} id - Either draft.id or message.id
 * @param {string} format - Format for draft.get (full/metadata/minimal)
 * @param {Function} [getWatchlistLabelContext] - Optional function to get watchlist context
 * @param {string} [googleSub] - User's Google sub (required if getWatchlistLabelContext is provided)
 * @returns {Promise<{draft: Object, actualDraftId: string, unrepliedLabelReminder: Object|null}>}
 */
async function findDraftById(gmail, id, format, getWatchlistLabelContext = null, googleSub = null) {
  let actualDraftId = id;
  let draftData = null;
  let unrepliedLabelReminder = null;

  // Step 1: Try to get draft using ID as draft.id (fast path - O(1))
  try {
    const draft = await gmail.users.drafts.get({
      userId: 'me',
      id: id,
      format: format,
      metadataHeaders: format === 'metadata' ? ['Message-ID'] : undefined
    });

    draftData = draft.data;
    console.log(`✅ Found draft using provided ID as draft.id`);

    // Check for unreplied label if needed
    if (getWatchlistLabelContext) {
      const { unrepliedLabel } = await getWatchlistLabelContext(googleSub);
      if (unrepliedLabel) {
        const threadId = draft.data?.message?.threadId || null;
        if (threadId) {
          const thread = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'metadata'
          });

          const messageIds = (thread.data?.messages || [])
            .filter(msg => Array.isArray(msg.labelIds) && msg.labelIds.includes(unrepliedLabel.id))
            .map(msg => msg.id);

          unrepliedLabelReminder = buildUnrepliedLabelReminderPayload(unrepliedLabel, {
            messageIds,
            threadId
          });
        }
      }
    }

    return { draft: draftData, actualDraftId, unrepliedLabelReminder };
  } catch (error) {
    console.warn(`⚠️ Draft not found using ID as draft.id: ${error.message}`);
  }

  // Step 2: ID is not a valid draft.id, try to find by message.id (slow path - O(N))
  console.log(`🔍 Attempting to find draft by message ID (ID: ${id})...`);

  try {
    const draftsResponse = await gmail.users.drafts.list({
      userId: 'me',
      maxResults: 100
    });

    if (!draftsResponse.data.drafts || draftsResponse.data.drafts.length === 0) {
      throwServiceError('Draft not found', {
        statusCode: 404,
        code: 'DRAFT_NOT_FOUND',
        expose: true
      });
    }

    console.log(`📋 Found ${draftsResponse.data.drafts.length} drafts, searching for matching message ID...`);

    // Search through all drafts to find one with matching message.id
    for (const draftSummary of draftsResponse.data.drafts) {
      try {
        const fullDraft = await gmail.users.drafts.get({
          userId: 'me',
          id: draftSummary.id,
          format: format,
          metadataHeaders: format === 'metadata' ? ['Message-ID'] : undefined
        });

        if (fullDraft.data.message?.id === id) {
          console.log(`✅ Found matching draft by message ID! New draft ID: ${fullDraft.data.id}`);
          draftData = fullDraft.data;
          actualDraftId = fullDraft.data.id;

          // Check for unreplied label if needed
          if (getWatchlistLabelContext) {
            const { unrepliedLabel } = await getWatchlistLabelContext(googleSub);
            if (unrepliedLabel) {
              const threadId = fullDraft.data?.message?.threadId || null;
              if (threadId) {
                const thread = await gmail.users.threads.get({
                  userId: 'me',
                  id: threadId,
                  format: 'metadata'
                });

                const messageIds = (thread.data?.messages || [])
                  .filter(msg => Array.isArray(msg.labelIds) && msg.labelIds.includes(unrepliedLabel.id))
                  .map(msg => msg.id);

                unrepliedLabelReminder = buildUnrepliedLabelReminderPayload(unrepliedLabel, {
                  messageIds,
                  threadId
                });
              }
            }
          }

          return { draft: draftData, actualDraftId, unrepliedLabelReminder };
        }
      } catch (getDraftError) {
        console.warn(`Failed to get draft ${draftSummary.id}:`, getDraftError.message);
      }
    }

    // Draft not found by message.id either
    throwServiceError('Draft not found. The draft may have been deleted or is no longer accessible.', {
      statusCode: 404,
      code: 'DRAFT_NOT_FOUND',
      expose: true,
      details: { providedId: id }
    });
  } catch (searchError) {
    if (searchError.statusCode === 404) {
      throw searchError;
    }
    throwServiceError('Draft not found', {
      statusCode: 404,
      code: 'DRAFT_NOT_FOUND',
      expose: true,
      details: { providedId: id }
    });
  }
}

/**
 * Send an existing draft by ID (accepts either draft.id or message.id)
 */
async function sendDraft(googleSub, draftId) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Find the draft by ID (tries draft.id first, then message.id)
    let { actualDraftId, unrepliedLabelReminder } = await findDraftById(
      gmail,
      draftId,
      'metadata',
      getWatchlistLabelContext,
      googleSub
    );

    // Send the draft using the actual draft.id
    let result;
    try {
      result = await gmail.users.drafts.send({
        userId: 'me',
        id: actualDraftId
      });
    } catch (sendError) {
      // If draft is invalid (400), it may have been modified/deleted between findDraftById and send
      // Retry by finding draft again using message.id fallback
      const is400 = sendError.response?.status === 400 || sendError.statusCode === 400 || sendError.code === 400;
      const isInvalidDraft = sendError.message?.toLowerCase().includes('invalid') ||
                              sendError.response?.data?.error?.message?.toLowerCase().includes('invalid');

      if (is400 && isInvalidDraft) {
        console.warn(`⚠️ Draft send failed with "Invalid draft" (400), retrying with message.id fallback...`);

        // Try to find draft again (will use message.id fallback if draft.id is stale)
        const retryResult = await findDraftById(
          gmail,
          draftId,
          'metadata',
          getWatchlistLabelContext,
          googleSub
        );

        actualDraftId = retryResult.actualDraftId;
        unrepliedLabelReminder = retryResult.unrepliedLabelReminder;

        console.log(`🔄 Retrying send with refreshed draft ID: ${actualDraftId}`);

        // Retry send with the refreshed draft ID
        result = await gmail.users.drafts.send({
          userId: 'me',
          id: actualDraftId
        });

        console.log('✅ Draft sent successfully after retry');
      } else {
        // Re-throw if it's not an "Invalid draft" error
        throw sendError;
      }
    }

    console.log('✅ Draft sent:', actualDraftId);

    // Add links to sent message
    const sentMessage = decorateMessageWithLinks(result.data);

    return {
      ...sentMessage,
      unrepliedLabelReminder
    };
  });
}

async function updateDraft(googleSub, draftId, { to, subject, body, cc, bcc, threadId } = {}) {
  if (typeof draftId !== 'string' || draftId.trim().length === 0) {
    throwServiceError('Draft ID is required', {
      statusCode: 400,
      code: 'DRAFT_ID_REQUIRED',
      expose: true
    });
  }

  if (typeof to !== 'string' || to.trim().length === 0) {
    throwServiceError('Draft recipient is required', {
      statusCode: 400,
      code: 'DRAFT_RECIPIENT_REQUIRED',
      expose: true
    });
  }

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Find the draft by ID (tries draft.id first, then message.id)
    const { actualDraftId } = await findDraftById(gmail, draftId.trim(), 'metadata');

    const encodedMessage = buildDraftMimeMessage({ to, subject, body, cc, bcc });

    const requestBody = {
      id: actualDraftId,
      message: {
        raw: encodedMessage
      }
    };

    if (threadId && typeof threadId === 'string' && threadId.trim().length > 0) {
      requestBody.message.threadId = threadId.trim();
    }

    const result = await gmail.users.drafts.update({
      userId: 'me',
      id: actualDraftId,
      requestBody
    });

    // Add links to draft
    // Note: decorateDraftWithLinks now automatically returns message.id as primary ID
    return decorateDraftWithLinks(result.data);
  });
}

async function listDrafts(googleSub, { maxResults = 100, pageToken } = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const safeMaxResults = Math.min(500, Math.max(1, Number.isFinite(Number(maxResults)) ? Number(maxResults) : 100));

    const params = {
      userId: 'me',
      maxResults: safeMaxResults
    };

    if (typeof pageToken === 'string' && pageToken.trim().length > 0) {
      params.pageToken = pageToken.trim();
    }

    const result = await gmail.users.drafts.list(params);

    // Add links to all drafts
    if (result.data.drafts && Array.isArray(result.data.drafts)) {
      result.data.drafts = decorateDraftsWithLinks(result.data.drafts);
    }

    return result.data;
  });
}

async function getDraft(googleSub, draftId, { format = 'full' } = {}) {
  if (typeof draftId !== 'string' || draftId.trim().length === 0) {
    throwServiceError('Draft ID is required', {
      statusCode: 400,
      code: 'DRAFT_ID_REQUIRED',
      expose: true
    });
  }

  const safeFormat = ['full', 'metadata', 'minimal'].includes(format) ? format : 'full';

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Find the draft by ID (tries draft.id first, then message.id)
    const { draft } = await findDraftById(gmail, draftId.trim(), safeFormat);

    // Add links to draft
    // Note: decorateDraftWithLinks now automatically returns message.id as primary ID
    return decorateDraftWithLinks(draft);
  });
}

async function deleteEmail(googleSub, messageId) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    await gmail.users.messages.trash({
      userId: 'me',
      id: messageId
    });

    return { success: true, messageId };
  });
}

async function toggleStar(googleSub, messageId, star = true) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: star ? ['STARRED'] : [],
        removeLabelIds: star ? [] : ['STARRED']
      }
    });

    return { success: true, messageId, starred: star };
  });
}

async function markAsRead(googleSub, messageId, read = true) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: read ? [] : ['UNREAD'],
        removeLabelIds: read ? ['UNREAD'] : []
      }
    });

    return { success: true, messageId, read };
  });
}

// ==================== NEW: LABELS ====================

const LABEL_ALIAS_TOKENS = {
  INBOX: ['inbox', 'primary'],
  CATEGORY_PERSONAL: ['primary', 'personal', 'work'],
  CATEGORY_PROMOTIONS: ['promotions', 'promo', 'nabidky'],
  CATEGORY_SOCIAL: ['social', 'socialni'],
  CATEGORY_UPDATES: ['updates', 'aktualizace'],
  CATEGORY_FORUMS: ['forums', 'diskuze'],
  IMPORTANT: ['important', 'dulezite'],
  STARRED: ['starred', 'hvezdicka'],
  SENT: ['sent', 'odeslane'],
  DRAFT: ['draft', 'drafts', 'koncept'],
  TRASH: ['trash', 'kose', 'smazane'],
  SPAM: ['spam', 'nevyzadane'],
  CATEGORY_FINANCE: ['finance'],
  CATEGORY_RECEIPTS: ['receipts', 'potvrzeni'],
  CATEGORY_TRAVEL: ['travel', 'cestovani'],
  CATEGORY_PURCHASES: ['purchases', 'nakupy']
};

function normalizeLabelCandidate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      raw: value ?? '',
      tokens: [],
      ordered: '',
      sorted: '',
      collapsed: ''
    };
  }

  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const tokens = normalized
    .split(/[^a-z0-9]+/u)
    .map(token => token.trim())
    .filter(Boolean);

  const ordered = tokens.join(' ');
  const sorted = [...tokens].sort().join(' ');
  const collapsed = tokens.join('');

  return { raw: value, tokens, ordered, sorted, collapsed };
}

function computeLabelMeta(label) {
  const baseMeta = normalizeLabelCandidate(label.name || '');
  const idMeta = normalizeLabelCandidate(label.id || '');
  const aliasMetas = (LABEL_ALIAS_TOKENS[label.id] || []).map(token => normalizeLabelCandidate(token));

  const tokenSet = new Set([
    ...baseMeta.tokens,
    ...idMeta.tokens,
    ...aliasMetas.flatMap(meta => meta.tokens)
  ]);

  const aliasLookup = new Set([
    ...aliasMetas.map(meta => meta.ordered),
    ...aliasMetas.map(meta => meta.sorted),
    ...aliasMetas.map(meta => meta.collapsed)
  ].filter(Boolean));

  return {
    baseMeta,
    idMeta,
    tokenSet,
    aliasLookup
  };
}

function getLabelMeta(label) {
  if (!label) return null;
  if (!label.__matchMeta) {
    Object.defineProperty(label, '__matchMeta', {
      value: computeLabelMeta(label),
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return label.__matchMeta;
}

function computeTokenOverlap(tokens, tokenSet) {
  if (!tokens.length || !tokenSet || tokenSet.size === 0) {
    return 0;
  }

  let overlap = 0;
  const seen = new Set();
  for (const token of tokens) {
    if (!seen.has(token) && tokenSet.has(token)) {
      overlap++;
      seen.add(token);
    }
  }
  return overlap;
}

function matchLabelCandidates(labels, rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (!input) return [];

  const inputMeta = normalizeLabelCandidate(input);
  if (inputMeta.tokens.length === 0) {
    return [];
  }

  const matches = [];

  for (const label of labels) {
    const meta = getLabelMeta(label);
    if (!meta) continue;

    let confidence = 0;
    let reason = 'noOverlap';

    if (label.id && label.id.toLowerCase() === input.toLowerCase()) {
      confidence = 1;
      reason = 'idExact';
    } else if (meta.baseMeta.ordered && meta.baseMeta.ordered === inputMeta.ordered) {
      confidence = 0.97;
      reason = 'orderedExact';
    } else if (meta.baseMeta.sorted && meta.baseMeta.sorted === inputMeta.sorted) {
      confidence = 0.94;
      reason = 'tokenExact';
    } else if (meta.aliasLookup.has(inputMeta.ordered) ||
               meta.aliasLookup.has(inputMeta.sorted) ||
               meta.aliasLookup.has(inputMeta.collapsed)) {
      confidence = 0.95;
      reason = 'alias';
    } else {
      const overlap = computeTokenOverlap(inputMeta.tokens, meta.tokenSet);
      const inputCoverage = overlap / inputMeta.tokens.length;
      const labelCoverage = meta.tokenSet.size ? overlap / meta.tokenSet.size : 0;

      if (inputCoverage === 1 && labelCoverage >= 0.5) {
        confidence = 0.88;
        reason = 'inputSubset';
      } else if (inputCoverage >= 0.66 && labelCoverage >= 0.5) {
        confidence = 0.78;
        reason = 'strongOverlap';
      } else if (inputCoverage >= 0.5) {
        confidence = 0.65;
        reason = 'partialOverlap';
      } else if (meta.baseMeta.ordered && meta.baseMeta.ordered.includes(inputMeta.ordered) && inputMeta.ordered) {
        confidence = 0.62;
        reason = 'orderedSubstring';
      } else if (inputMeta.tokens.length === 1) {
        const token = inputMeta.tokens[0];
        const hasPrefix = Array.from(meta.tokenSet).some(labelToken =>
          labelToken.startsWith(token) || token.startsWith(labelToken)
        );
        if (hasPrefix) {
          confidence = 0.58;
          reason = 'prefixOverlap';
        }
      }
    }

    if (confidence > 0) {
      matches.push({
        label,
        confidence,
        reason
      });
    }
  }

  matches.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return (a.label.name || '').localeCompare(b.label.name || '', 'cs', { sensitivity: 'base' });
  });

  return matches;
}

async function fetchLabelDirectory(googleSub) {
  const authClient = await getAuthenticatedClient(googleSub);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const result = await gmail.users.labels.list({
    userId: 'me'
  });

  const labels = (result.data.labels || []).map(label => ({
    id: label.id,
    name: label.name,
    type: label.type === 'system' ? 'system' : 'user',
    color: label.color?.backgroundColor || null
  }));

  labels.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs', { sensitivity: 'base' }));
  return labels;
}

async function getLabelDirectory(googleSub, { forceRefresh = false } = {}) {
  const cacheKey = googleSub || '__anon__';
  const cached = labelDirectoryCache.get(cacheKey);
  const now = Date.now();

  if (!forceRefresh && cached && (now - cached.timestamp) < LABEL_CACHE_TTL_MS) {
    return cached.labels;
  }

  const labels = await handleGoogleApiCall(googleSub, () => fetchLabelDirectory(googleSub));
  labelDirectoryCache.set(cacheKey, { labels, timestamp: now });
  console.log('✅ Labels listed:', labels.length, forceRefresh ? '(forced refresh)' : '');
  return labels;
}

async function resolveLabelIdentifiers(googleSub, requestedIdentifiers, options = {}) {
  const inputsArray = Array.isArray(requestedIdentifiers)
    ? requestedIdentifiers
    : [requestedIdentifiers];

  const normalizedInputs = inputsArray
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(value => value.length > 0);

  if (normalizedInputs.length === 0) {
    return {
      resolved: [],
      ambiguous: [],
      unmatched: [],
      requiresConfirmation: false,
      appliedLabels: [],
      appliedLabelIds: [],
      requested: []
    };
  }

  const labels = options.labels || await getLabelDirectory(googleSub, {
    forceRefresh: options.forceRefresh === true
  });

  const resolved = [];
  const ambiguous = [];
  const unmatched = [];
  const seenInputs = new Set();

  for (const input of normalizedInputs) {
    const lowerInput = input.toLowerCase();
    if (seenInputs.has(lowerInput)) {
      continue;
    }
    seenInputs.add(lowerInput);

    const direct = labels.find(label => label.id?.toLowerCase() === lowerInput);
    if (direct) {
      resolved.push({
        input,
        label: direct,
        confidence: 1,
        reason: 'idExact'
      });
      continue;
    }

    const matches = matchLabelCandidates(labels, input);
    if (matches.length === 0) {
      unmatched.push({ input, suggestions: [] });
      continue;
    }

    const best = matches[0];
    const topConfidence = best.confidence;
    const strongReason = ['idExact', 'orderedExact', 'tokenExact', 'alias'].includes(best.reason);
    const closeMatches = matches.filter(match =>
      match.confidence >= 0.6 && (topConfidence - match.confidence) <= 0.1
    );

    if ((strongReason || topConfidence >= 0.86) && closeMatches.length === 1) {
      resolved.push({
        input,
        label: best.label,
        confidence: best.confidence,
        reason: best.reason
      });
      continue;
    }

    if (topConfidence < 0.55) {
      unmatched.push({
        input,
        suggestions: matches.slice(0, 5)
      });
      continue;
    }

    ambiguous.push({
      input,
      options: matches.slice(0, 5)
    });
  }

  return {
    resolved,
    ambiguous,
    unmatched,
    requiresConfirmation: ambiguous.length > 0 || unmatched.length > 0,
    appliedLabels: resolved.map(entry => entry.label),
    appliedLabelIds: resolved.map(entry => entry.label.id),
    requested: normalizedInputs
  };
}

/**
 * List all Gmail labels
 */
async function listLabels(googleSub, options = {}) {
  const includeMatchesFor = options.includeMatchesFor;
  const forceRefresh = options.forceRefresh === true;

  const labels = await getLabelDirectory(googleSub, { forceRefresh });

  if (typeof includeMatchesFor === 'undefined') {
    return labels;
  }

  const resolution = await resolveLabelIdentifiers(googleSub, includeMatchesFor, {
    labels
  });

  return {
    labels,
    resolution
  };
}

function findLabelByExactName(labels = [], targetName) {
  if (!targetName) {
    return null;
  }

  return labels.find(label =>
    typeof label?.name === 'string'
      && label.name.localeCompare(targetName, 'cs', { sensitivity: 'base' }) === 0
  ) || null;
}

async function getWatchlistLabelContext(googleSub, { forceRefresh = false } = {}) {
  const labels = await getLabelDirectory(googleSub, { forceRefresh });
  const unrepliedLabel = findLabelByExactName(labels, UNREPLIED_LABEL_NAME);
  const trackingLabel = findLabelByExactName(labels, TRACKING_LABEL_NAME);

  return {
    labels,
    unrepliedLabel,
    trackingLabel
  };
}

async function getFollowupLabelContext(googleSub, { forceRefresh = false } = {}) {
  const labels = await getLabelDirectory(googleSub, { forceRefresh });
  const followupLabel = findLabelByExactName(labels, FOLLOWUP_LABEL_NAME);

  return {
    labels,
    followupLabel
  };
}

function buildUnrepliedLabelReminderPayload(label, { messageIds = [], threadId } = {}) {
  if (!label) {
    return null;
  }

  const uniqueMessageIds = Array.from(new Set(
    (Array.isArray(messageIds) ? messageIds : [])
      .filter(value => typeof value === 'string' && value.length > 0)
  ));

  if (uniqueMessageIds.length === 0) {
    return null;
  }

  return {
    labelId: label.id,
    labelName: label.name,
    threadId: threadId || null,
    messages: uniqueMessageIds.map(id => ({
      messageId: id,
      removeRequest: {
        op: 'labels',
        params: {
          modify: {
            messageId: id,
            add: [],
            remove: [label.id]
          }
        }
      }
    }))
  };
}

function buildFollowupLabelRecommendation(followupLabel) {
  const targetName = FOLLOWUP_LABEL_NAME || FOLLOWUP_LABEL_DEFAULTS.name;
  const defaultColors = FOLLOWUP_LABEL_DEFAULTS.color || {};

  const existing = followupLabel
    ? {
        id: followupLabel.id,
        name: followupLabel.name,
        color: followupLabel.color || null
      }
    : null;

  const suggestedColor = existing?.color || defaultColors.backgroundColor || '#42a5f5';
  const textColor = defaultColors.textColor || '#ffffff';

  return {
    suggestedName: targetName,
    suggestedColor,
    textColor,
    existingLabel: existing,
    canCreate: !existing,
    createRequest: existing
      ? null
      : {
          op: 'labels',
          params: {
            create: {
              name: targetName,
              color: {
                backgroundColor: defaultColors.backgroundColor || suggestedColor,
                textColor
              }
            }
          }
        },
    applyRequestTemplate: existing
      ? {
          op: 'labels',
          params: {
            modify: {
              messageId: '<messageId>',
              add: [existing.id],
              remove: []
            }
          }
        }
      : null
  };
}

async function ensureTrackingLabelIncluded(googleSub, addIds = []) {
  const normalizedAdd = Array.isArray(addIds)
    ? addIds.filter(id => typeof id === 'string' && id.length > 0)
    : [];

  if (normalizedAdd.length === 0) {
    return normalizedAdd;
  }

  const addSet = new Set(normalizedAdd);
  const { unrepliedLabel, trackingLabel } = await getWatchlistLabelContext(googleSub);

  if (!unrepliedLabel || !addSet.has(unrepliedLabel.id)) {
    return Array.from(addSet);
  }

  let trackingLabelId = trackingLabel?.id || null;

  if (!trackingLabelId) {
    try {
      const created = await createLabel(googleSub, {
        name: TRACKING_LABEL_NAME,
        color: TRACKING_LABEL_DEFAULTS.color,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      });
      trackingLabelId = created?.id || null;
    } catch (createError) {
      console.warn('⚠️ Unable to auto-create tracking label meta_seen:', createError.message);
      const refreshed = await getWatchlistLabelContext(googleSub, { forceRefresh: true });
      trackingLabelId = refreshed.trackingLabel?.id || null;
    }
  }

  if (trackingLabelId) {
    addSet.add(trackingLabelId);
  }

  return Array.from(addSet);
}

function normalizeLabelInputArray(values) {
  return Array.isArray(values)
    ? values
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(value => value.length > 0)
    : [];
}

function normalizeLabelAlias(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s/_-]+/g, '');
}

const MANAGED_LABEL_DEFINITIONS = [
  {
    key: 'unreplied',
    alias: normalizeLabelAlias(UNREPLIED_LABEL_NAME),
    defaults: UNREPLIED_LABEL_DEFAULTS,
    fallbackName: UNREPLIED_LABEL_NAME
  },
  {
    key: 'tracking',
    alias: normalizeLabelAlias(TRACKING_LABEL_NAME),
    defaults: TRACKING_LABEL_DEFAULTS,
    fallbackName: TRACKING_LABEL_NAME
  },
  {
    key: 'followup',
    alias: normalizeLabelAlias(FOLLOWUP_LABEL_NAME),
    defaults: FOLLOWUP_LABEL_DEFAULTS,
    fallbackName: FOLLOWUP_LABEL_NAME
  }
];

function getManagedLabelDefinition(input) {
  const alias = normalizeLabelAlias(input);
  if (!alias) {
    return null;
  }

  return MANAGED_LABEL_DEFINITIONS.find(definition => definition.alias === alias) || null;
}

async function prepareLabelModificationRequest(googleSub, { add = [], remove = [] } = {}) {
  const requestedAdd = normalizeLabelInputArray(add);
  const requestedRemove = normalizeLabelInputArray(remove);

  const details = {
    requested: {
      add: requestedAdd,
      remove: requestedRemove
    },
    resolved: {
      add: [],
      remove: []
    },
    createdLabels: [],
    unmatched: {
      add: [],
      remove: []
    },
    availableLabels: []
  };

  if (requestedAdd.length === 0 && requestedRemove.length === 0) {
    // Mark that no labels were actually requested
    details.noLabelsRequested = true;
    return {
      addLabelIds: [],
      removeLabelIds: [],
      details
    };
  }

  const labels = await getLabelDirectory(googleSub, {});
  const labelById = new Map();
  const labelByName = new Map();
  const labelByAlias = new Map();
  const availableLabels = [];

  for (const label of labels) {
    if (!label) continue;

    if (typeof label.id === 'string' && label.id.length > 0) {
      labelById.set(label.id.toLowerCase(), label);
    }

    if (typeof label.name === 'string' && label.name.trim().length > 0) {
      const lowerName = label.name.toLowerCase();
      labelByName.set(lowerName, label);

      const alias = normalizeLabelAlias(label.name);
      if (alias.length > 0 && !labelByAlias.has(alias)) {
        labelByAlias.set(alias, label);
      }

      availableLabels.push({
        id: label.id || null,
        name: label.name,
        managed: getManagedLabelDefinition(label.name)?.key || null
      });
    }
  }

  const seenAddInputs = new Set();
  const seenRemoveInputs = new Set();
  const addLabelIds = [];
  const removeLabelIds = [];
  const seenAddIds = new Set();
  const seenRemoveIds = new Set();
  const createdLabelIds = new Set();

  function registerManagedLabel(label, definition) {
    if (!label) {
      return;
    }

    if (typeof label.id === 'string' && label.id.length > 0) {
      labelById.set(label.id.toLowerCase(), label);
      createdLabelIds.add(label.id);
    }

    if (typeof label.name === 'string' && label.name.trim().length > 0) {
      const lowerName = label.name.toLowerCase();
      labelByName.set(lowerName, label);
      const alias = normalizeLabelAlias(label.name);
      if (alias.length > 0) {
        labelByAlias.set(alias, label);
      }

      availableLabels.push({
        id: label.id || null,
        name: label.name,
        managed: definition?.key || null
      });
    }
  }

  function resolveExistingLabel(input) {
    const lower = input.toLowerCase();
    return (
      labelById.get(lower)
      || labelByName.get(lower)
      || labelByAlias.get(normalizeLabelAlias(input))
    );
  }

  for (const input of requestedAdd) {
    const key = normalizeLabelAlias(input) || input.toLowerCase();
    if (seenAddInputs.has(key)) {
      continue;
    }
    seenAddInputs.add(key);

    let targetLabel = resolveExistingLabel(input);

    if (!targetLabel) {
      const managedDefinition = getManagedLabelDefinition(input);

      if (managedDefinition) {
        const defaults = managedDefinition.defaults || {};
        const labelName = defaults.name || managedDefinition.fallbackName || input;

        try {
          targetLabel = await createLabel(googleSub, {
            name: labelName,
            color: defaults.color,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          });

          details.createdLabels.push({
            id: targetLabel?.id || null,
            name: targetLabel?.name || labelName,
            color: targetLabel?.color || defaults.color?.backgroundColor || null,
            textColor: targetLabel?.textColor || defaults.color?.textColor || null,
            managed: managedDefinition.key,
            requestedBy: input
          });

          registerManagedLabel(targetLabel, managedDefinition);
        } catch (creationError) {
          console.error(
            `❌ Failed to auto-create managed label "${managedDefinition.fallbackName}":`,
            creationError.message
          );

          // Throw a more specific error for managed label creation failure
          throwServiceError(
            `Failed to create label "${managedDefinition.fallbackName}". ${creationError.message || 'Unknown error during label creation.'}`,
            {
              statusCode: creationError.statusCode || 500,
              code: 'MANAGED_LABEL_CREATION_FAILED',
              expose: true,
              details: {
                labelName: managedDefinition.fallbackName,
                managedType: managedDefinition.key,
                originalError: creationError.message,
                suggestion: `The system attempted to automatically create the "${managedDefinition.fallbackName}" label but failed. Please check your Gmail permissions or try creating the label manually.`
              }
            }
          );
        }
      }
    }

    if (!targetLabel || typeof targetLabel.id !== 'string') {
      details.unmatched.add.push(input);
      continue;
    }

    if (!seenAddIds.has(targetLabel.id)) {
      addLabelIds.push(targetLabel.id);
      seenAddIds.add(targetLabel.id);
    }

    details.resolved.add.push({
      input,
      labelId: targetLabel.id,
      labelName: targetLabel.name || null,
      created: createdLabelIds.has(targetLabel.id)
    });
  }

  for (const input of requestedRemove) {
    const key = normalizeLabelAlias(input) || input.toLowerCase();
    if (seenRemoveInputs.has(key)) {
      continue;
    }
    seenRemoveInputs.add(key);

    const targetLabel = resolveExistingLabel(input);

    if (targetLabel && typeof targetLabel.id === 'string') {
      if (!seenRemoveIds.has(targetLabel.id)) {
        removeLabelIds.push(targetLabel.id);
        seenRemoveIds.add(targetLabel.id);
      }

      details.resolved.remove.push({
        input,
        labelId: targetLabel.id,
        labelName: targetLabel.name || null,
        created: createdLabelIds.has(targetLabel.id)
      });
    } else {
      details.unmatched.remove.push(input);
    }
  }

  details.availableLabels = availableLabels;

  if (details.unmatched.add.length > 0 || details.unmatched.remove.length > 0) {
    const unmatchedMessages = [];
    const unmatchedLabels = [];

    if (details.unmatched.add.length > 0) {
      unmatchedMessages.push(`add [${details.unmatched.add.join(', ')}]`);
      unmatchedLabels.push(...details.unmatched.add);
    }
    if (details.unmatched.remove.length > 0) {
      unmatchedMessages.push(`remove [${details.unmatched.remove.join(', ')}]`);
      unmatchedLabels.push(...details.unmatched.remove);
    }

    const availableLabelNames = availableLabels
      .filter(l => l.name)
      .map(l => l.name)
      .slice(0, 10);

    throwServiceError(
      unmatchedMessages.length > 0
        ? `Label(s) not found: ${unmatchedLabels.join(', ')}. These labels don't exist in your Gmail account. Please create them first or use an existing label.`
        : 'Some labels could not be resolved',
      {
        statusCode: 400,
        code: 'LABEL_NOT_FOUND',
        expose: true,
        details: {
          ...details,
          suggestion: `Labels "${unmatchedLabels.join('", "')}" do not exist. ${availableLabelNames.length > 0 ? `Available labels include: ${availableLabelNames.join(', ')}${availableLabels.length > 10 ? ', ...' : ''}` : 'No custom labels found.'}`,
          action: 'Create the label first using the "labels" operation with params.create, or use an existing label name.'
        }
      }
    );
  }

  return {
    addLabelIds,
    removeLabelIds,
    details
  };
}

async function createLabel(googleSub, options = {}) {
  const { name, color, labelListVisibility, messageListVisibility } = options;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throwServiceError('Label name is required', {
      statusCode: 400,
      code: 'LABEL_NAME_REQUIRED',
      expose: true
    });
  }

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const requestBody = {
      name: name.trim(),
      labelListVisibility: labelListVisibility || 'labelShow',
      messageListVisibility: messageListVisibility || 'show'
    };

    if (color && typeof color === 'object') {
      let backgroundColor = color.backgroundColor || GMAIL_LABEL_PRESETS.RED_DARK;
      let textColor = color.textColor || GMAIL_LABEL_PRESETS.WHITE;

      // Validate and auto-correct unsupported colors
      if (!isGmailColorSupported(backgroundColor)) {
        const originalColor = backgroundColor;
        backgroundColor = findClosestGmailColor(backgroundColor);
        console.warn(
          `[createLabel] Background color ${originalColor} is not supported by Gmail API. ` +
          `Auto-corrected to closest supported color: ${backgroundColor}`
        );
      }

      if (!isGmailColorSupported(textColor)) {
        const originalColor = textColor;
        textColor = findClosestGmailColor(textColor);
        console.warn(
          `[createLabel] Text color ${originalColor} is not supported by Gmail API. ` +
          `Auto-corrected to closest supported color: ${textColor}`
        );
      }

      requestBody.color = {
        backgroundColor,
        textColor
      };
    }

    const result = await gmail.users.labels.create({
      userId: 'me',
      requestBody
    });

    const created = result.data || {};
    const cacheKey = googleSub || '__anon__';
    labelDirectoryCache.delete(cacheKey);
    return {
      id: created.id,
      name: created.name,
      color: created.color?.backgroundColor || null,
      textColor: created.color?.textColor || null,
      messageListVisibility: created.messageListVisibility,
      labelListVisibility: created.labelListVisibility
    };
  });
}

/**
 * Modify labels on a message
 */
function normalizeLabelIdArray(ids = []) {
  return Array.isArray(ids)
    ? ids
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(id => id.length > 0)
    : [];
}

function evaluateLabelMutationSnapshot(snapshotLabelIds, { addIds = [], removeIds = [] } = {}) {
  const normalizedAdd = normalizeLabelIdArray(addIds);
  const normalizedRemove = normalizeLabelIdArray(removeIds);
  const normalizedSnapshot = Array.isArray(snapshotLabelIds)
    ? snapshotLabelIds.filter(id => typeof id === 'string' && id.length > 0)
    : null;

  if (!normalizedSnapshot) {
    return {
      ok: normalizedAdd.length === 0 && normalizedRemove.length === 0,
      verified: false,
      labelIds: null,
      missingAdd: normalizedAdd,
      remainingRemove: normalizedRemove
    };
  }

  const snapshotSet = new Set(normalizedSnapshot);
  const missingAdd = normalizedAdd.filter(id => !snapshotSet.has(id));
  const remainingRemove = normalizedRemove.filter(id => snapshotSet.has(id));

  return {
    ok: missingAdd.length === 0 && remainingRemove.length === 0,
    verified: true,
    labelIds: normalizedSnapshot,
    missingAdd,
    remainingRemove
  };
}

function extractLabelIdsFromThreadSnapshot(threadData) {
  if (!threadData) {
    return null;
  }

  if (Array.isArray(threadData.messages) && threadData.messages.length > 0) {
    const aggregated = new Set();

    for (const message of threadData.messages) {
      if (!message || !Array.isArray(message.labelIds)) {
        continue;
      }

      for (const labelId of message.labelIds) {
        if (typeof labelId === 'string' && labelId.length > 0) {
          aggregated.add(labelId);
        }
      }
    }

    return Array.from(aggregated);
  }

  if (Array.isArray(threadData.labelIds) && threadData.labelIds.length > 0) {
    return threadData.labelIds.filter(id => typeof id === 'string' && id.length > 0);
  }

  return null;
}

async function modifyMessageLabels(googleSub, messageId, { add = [], remove = [] }) {
  const { addLabelIds, removeLabelIds, details } = await prepareLabelModificationRequest(googleSub, { add, remove });
  const finalAdd = await ensureTrackingLabelIncluded(googleSub, addLabelIds);

  const expectedAdd = Array.from(new Set(normalizeLabelIdArray(finalAdd)));
  const expectedRemove = Array.from(new Set(normalizeLabelIdArray(removeLabelIds)));

  const hasMutation = expectedAdd.length > 0 || expectedRemove.length > 0;
  const verificationSnapshot = {
    source: hasMutation ? 'modify_response' : 'not_requested',
    labelIds: null,
    error: null
  };

  if (hasMutation) {
    await handleGoogleApiCall(googleSub, async () => {
      const authClient = await getAuthenticatedClient(googleSub);
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      const response = await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds: expectedAdd,
          removeLabelIds: expectedRemove
        }
      });

      const responseData = response?.data || response || null;
      if (Array.isArray(responseData?.labelIds)) {
        verificationSnapshot.labelIds = responseData.labelIds;
      } else {
        verificationSnapshot.source = 'followup_fetch';
        try {
          const followUp = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'metadata',
            fields: 'id,labelIds'
          });
          if (Array.isArray(followUp?.data?.labelIds)) {
            verificationSnapshot.labelIds = followUp.data.labelIds;
          } else {
            verificationSnapshot.source = 'unverified_snapshot';
          }
        } catch (snapshotError) {
          verificationSnapshot.source = 'snapshot_fetch_failed';
          verificationSnapshot.error = snapshotError.message || 'Unknown verification failure';
        }
      }
    });

  const evaluation = evaluateLabelMutationSnapshot(verificationSnapshot.labelIds, {
    addIds: expectedAdd,
    removeIds: expectedRemove
  });

  if (!evaluation.ok) {
    throwServiceError('Label mutation verification failed', {
      statusCode: 502,
      code: 'LABEL_MUTATION_VERIFICATION_FAILED',
      details: {
        attemptedAdd: expectedAdd,
        attemptedRemove: expectedRemove,
        snapshotSource: verificationSnapshot.source,
        snapshotError: verificationSnapshot.error,
        missingAdd: evaluation.missingAdd,
        remainingRemove: evaluation.remainingRemove
      }
    });
  }

    console.log(`✅ Labels modified on message ${messageId}`);

    details.verification = {
      source: verificationSnapshot.source,
      labelIds: evaluation.labelIds,
      missingAdd: evaluation.missingAdd,
      remainingRemove: evaluation.remainingRemove,
      verified: evaluation.verified
    };
  } else {
    console.log(`ℹ️ No label changes requested for message ${messageId}`);
    details.verification = {
      source: 'not_requested',
      labelIds: [],
      missingAdd: [],
      remainingRemove: [],
      verified: true
    };
  }

  const response = {
    success: true,
    labelUpdates: {
      ...details,
      appliedAddLabelIds: expectedAdd,
      appliedRemoveLabelIds: expectedRemove
    }
  };

  // Add warning if no labels were actually requested
  if (details.noLabelsRequested === true) {
    response.warning = 'No labels were specified in the modify request. No changes were made.';
    response.labelUpdates.noLabelsRequested = true;
  }

  return response;
}

/**
 * Modify labels on all messages in a thread
 */
async function modifyThreadLabels(googleSub, threadId, { add = [], remove = [] }) {
  const { addLabelIds, removeLabelIds, details } = await prepareLabelModificationRequest(googleSub, { add, remove });
  const finalAdd = await ensureTrackingLabelIncluded(googleSub, addLabelIds);

  const expectedAdd = Array.from(new Set(normalizeLabelIdArray(finalAdd)));
  const expectedRemove = Array.from(new Set(normalizeLabelIdArray(removeLabelIds)));

  const hasMutation = expectedAdd.length > 0 || expectedRemove.length > 0;
  const verificationSnapshot = {
    source: hasMutation ? 'modify_response' : 'not_requested',
    labelIds: null,
    error: null
  };

  if (hasMutation) {
    await handleGoogleApiCall(googleSub, async () => {
      const authClient = await getAuthenticatedClient(googleSub);
      const gmail = google.gmail({ version: 'v1', auth: authClient });

      const response = await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: {
          addLabelIds: expectedAdd,
          removeLabelIds: expectedRemove
        }
      });

      const responseData = response?.data || response || null;
      const responseLabels = extractLabelIdsFromThreadSnapshot(responseData);

      if (Array.isArray(responseLabels)) {
        verificationSnapshot.labelIds = responseLabels;
      } else {
        verificationSnapshot.source = 'followup_fetch';

        try {
          const followUp = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'minimal',
            fields: 'messages(id,labelIds)'
          });

          const followUpLabels = extractLabelIdsFromThreadSnapshot(followUp?.data);
          if (Array.isArray(followUpLabels)) {
            verificationSnapshot.labelIds = followUpLabels;
          } else {
            verificationSnapshot.source = 'unverified_snapshot';
          }
        } catch (snapshotError) {
          verificationSnapshot.source = 'snapshot_fetch_failed';
          verificationSnapshot.error = snapshotError.message || 'Unknown verification failure';
        }
      }
    });

  const evaluation = evaluateLabelMutationSnapshot(verificationSnapshot.labelIds, {
    addIds: expectedAdd,
    removeIds: expectedRemove
  });

  if (!evaluation.ok) {
    throwServiceError('Label mutation verification failed', {
      statusCode: 502,
      code: 'LABEL_MUTATION_VERIFICATION_FAILED',
      details: {
        attemptedAdd: expectedAdd,
        attemptedRemove: expectedRemove,
        snapshotSource: verificationSnapshot.source,
        snapshotError: verificationSnapshot.error,
        missingAdd: evaluation.missingAdd,
        remainingRemove: evaluation.remainingRemove
      }
    });
  }

    console.log(`✅ Labels modified on thread ${threadId}`);

    details.verification = {
      source: verificationSnapshot.source,
      labelIds: evaluation.labelIds,
      missingAdd: evaluation.missingAdd,
      remainingRemove: evaluation.remainingRemove,
      verified: evaluation.verified
    };
  } else {
    console.log(`ℹ️ No label changes requested for thread ${threadId}`);
    details.verification = {
      source: 'not_requested',
      labelIds: [],
      missingAdd: [],
      remainingRemove: [],
      verified: true
    };
  }

  const response = {
    success: true,
    labelUpdates: {
      ...details,
      appliedAddLabelIds: expectedAdd,
      appliedRemoveLabelIds: expectedRemove
    }
  };

  // Add warning if no labels were actually requested
  if (details.noLabelsRequested === true) {
    response.warning = 'No labels were specified in the modify request. No changes were made.';
    response.labelUpdates.noLabelsRequested = true;
  }

  return response;
}

async function fetchUserAddressDirectory(googleSub) {
  const authClient = await getAuthenticatedClient(googleSub);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const [profileResult, sendAsResult] = await Promise.allSettled([
    gmail.users.getProfile({ userId: 'me' }),
    gmail.users.settings.sendAs.list({ userId: 'me' })
  ]);

  const addresses = new Set();

  if (profileResult.status === 'fulfilled') {
    const profileEmail = profileResult.value?.data?.emailAddress;
    if (profileEmail) {
      addresses.add(profileEmail);
    }
  }

  if (sendAsResult.status === 'fulfilled') {
    const sendAsEntries = sendAsResult.value?.data?.sendAs || [];
    for (const entry of sendAsEntries) {
      if (entry?.sendAsEmail) {
        addresses.add(entry.sendAsEmail);
      }
    }
  } else if (sendAsResult.reason) {
    console.warn('⚠️ Failed to list send-as addresses:', sendAsResult.reason.message || sendAsResult.reason);
  }

  return Array.from(addresses);
}

async function getUserAddresses(googleSub, { forceRefresh = false } = {}) {
  const cacheKey = googleSub || '__anon__';
  const cached = userAddressCache.get(cacheKey);
  const now = Date.now();

  if (!forceRefresh && cached && (now - cached.timestamp) < USER_ADDRESS_CACHE_TTL_MS) {
    return cached.addresses;
  }

  const addresses = await handleGoogleApiCall(googleSub, () => fetchUserAddressDirectory(googleSub));

  userAddressCache.set(cacheKey, { addresses, timestamp: now });
  return addresses;
}

// ==================== NEW: THREADS ====================

/**
 * Get thread summary
 */
async function getThread(googleSub, threadId) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    const result = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date']
    });

    const messages = result.data.messages || [];

    const normalizedMessages = decorateMessagesWithLinks(messages.map(msg => {
      const headers = msg.payload?.headers || [];
      const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';

      let fromEmail = fromHeader;
      let fromName = '';
      const emailMatch = fromHeader.match(/<(.+)>/);
      if (emailMatch) {
        fromEmail = emailMatch[1];
        fromName = fromHeader.replace(/<.+>/, '').trim().replace(/^["']|["']$/g, '');
      }

      const internalDateMs = msg.internalDate ? parseInt(msg.internalDate) : null;
      const internalIso = internalDateMs ? new Date(internalDateMs).toISOString() : null;

      return {
        id: msg.id,
        threadId: msg.threadId,
        labelIds: msg.labelIds || [],
        snippet: msg.snippet || '',
        subject: subjectHeader,
        from: {
          name: fromName || null,
          email: fromEmail || null,
          raw: fromHeader || null
        },
        internalDate: internalDateMs,
        receivedAt: internalIso
      };
    }), { fallbackThreadId: threadId });

    const lastMessage = normalizedMessages[normalizedMessages.length - 1] || null;

    const participantsMap = new Map();
    normalizedMessages.forEach(msg => {
      const email = msg.from?.email;
      if (!email) {
        return;
      }

      const existing = participantsMap.get(email);
      const candidateName = msg.from?.name || null;

      if (!existing) {
        participantsMap.set(email, {
          email,
          name: candidateName
        });
      } else if (!existing.name && candidateName) {
        participantsMap.set(email, {
          email,
          name: candidateName
        });
      }
    });

    const isUnread = normalizedMessages.some(msg => (msg.labelIds || []).includes('UNREAD'));
    const allLabelIds = new Set();
    normalizedMessages.forEach(msg => {
      (msg.labelIds || []).forEach(id => allLabelIds.add(id));
    });

    return {
      threadId: threadId,
      count: normalizedMessages.length,
      unread: isUnread,
      participants: Array.from(participantsMap.values()),
      messageIds: normalizedMessages.map(m => m.id),
      labelIds: Array.from(allLabelIds),
      messages: normalizedMessages,
      last: lastMessage
        ? {
            id: lastMessage.id,
            from: lastMessage.from,
            subject: lastMessage.subject,
            date: lastMessage.receivedAt,
            snippet: lastMessage.snippet,
            links: lastMessage.links || null
          }
        : null
    };
  });
}

/**
 * Mark thread as read/unread
 */
async function setThreadRead(googleSub, threadId, read = true) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: {
        addLabelIds: read ? [] : ['UNREAD'],
        removeLabelIds: read ? ['UNREAD'] : []
      }
    });

    console.log(`✅ Thread marked as ${read ? 'read' : 'unread'}:`, threadId);
    return { success: true };
  });
}

/**
 * Reply to a thread
 */
async function replyToThread(googleSub, threadId, { body }) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Get thread to find last message
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Message-ID']
    });

    const messages = thread.data.messages || [];
    const lastMessage = messages[messages.length - 1];
    const headers = lastMessage?.payload?.headers || [];

    const { unrepliedLabel } = await getWatchlistLabelContext(googleSub);
    const unrepliedLabelReminder = unrepliedLabel
      ? buildUnrepliedLabelReminderPayload(unrepliedLabel, {
          messageIds: messages
            .filter(msg => Array.isArray(msg.labelIds) && msg.labelIds.includes(unrepliedLabel.id))
            .map(msg => msg.id),
          threadId
        })
      : null;

    const originalFrom = headers.find(h => h.name === 'From')?.value;
    const originalSubject = headers.find(h => h.name === 'Subject')?.value;
    const originalMessageId = headers.find(h => h.name === 'Message-ID')?.value;

    const replySubject = originalSubject?.replace(/^Re: /, '') || '';
    const encodedSubject = `=?UTF-8?B?${Buffer.from(`Re: ${replySubject}`, 'utf8').toString('base64')}?=`;

    const messageParts = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      'Content-Transfer-Encoding: 7bit',
      `To: ${originalFrom}`,
      `Subject: ${encodedSubject}`,
      `In-Reply-To: ${originalMessageId}`,
      `References: ${originalMessageId}`,
      '',
      body
    ];

    const message = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(message, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: threadId
      }
    });

    console.log('✅ Reply sent to thread:', threadId);

    // Add links to sent reply
    const sentMessage = decorateMessageWithLinks(result.data);

    return {
      ...sentMessage,
      unrepliedLabelReminder
    };
  });
}

// ==================== NEW: ATTACHMENTS ====================

/**
 * Get attachment metadata with download URL
 */
async function getAttachmentMeta(googleSub, messageId, attachmentId) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Get message to find attachment details
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    let attachmentMeta = null;
    
    function findAttachment(parts) {
      for (const part of parts) {
        if (part.body?.attachmentId === attachmentId) {
          attachmentMeta = {
            attachmentId: attachmentId,
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size || 0,
            isInline: part.headers?.some(h => 
              h.name.toLowerCase() === 'content-disposition' && 
              h.value.includes('inline')
            ) || false,
            cid: part.headers?.find(h => 
              h.name.toLowerCase() === 'content-id'
            )?.value?.replace(/[<>]/g, '') || null
          };
          return true;
        }
        if (part.parts) {
          if (findAttachment(part.parts)) return true;
        }
      }
      return false;
    }

    if (message.data.payload?.parts) {
      findAttachment(message.data.payload.parts);
    }

    if (!attachmentMeta) {
      throwServiceError('Attachment not found', {
        statusCode: 404,
        code: 'ATTACHMENT_NOT_FOUND',
        expose: true,
        details: { messageId, attachmentId }
      });
    }

    // Check if attachment is blocked by security policy
    if (isBlocked(attachmentMeta)) {
      throwServiceError(`Attachment blocked: ${attachmentMeta.filename} (security policy)`, {
        statusCode: 451,
        code: 'ATTACHMENT_BLOCKED',
        expose: true,
        details: { filename: attachmentMeta.filename, mimeType: attachmentMeta.mimeType }
      });
    }

    // Generate signed URL with 1-hour expiration
    const { downloadUrl, expiresAt } = generateSignedAttachmentUrl(
      messageId,
      attachmentId
    );
    
    attachmentMeta.downloadUrl = downloadUrl;
    attachmentMeta.expiresAt = expiresAt;

    return attachmentMeta;
  });
}

/**
 * Preview attachment text (PDF, TXT, HTML) - FULL IMPLEMENTATION
 */
async function previewAttachmentText(googleSub, messageId, attachmentId, maxKb = 256) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Get message to find attachment MIME type
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    let mimeType = 'application/octet-stream';
    
    function findMimeType(parts) {
      for (const part of parts) {
        if (part.body?.attachmentId === attachmentId) {
          mimeType = part.mimeType || mimeType;
          return true;
        }
        if (part.parts) {
          if (findMimeType(part.parts)) return true;
        }
      }
      return false;
    }

    if (message.data.payload?.parts) {
      findMimeType(message.data.payload.parts);
    }

    // Get attachment data
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: attachmentId
    });

    const data = Buffer.from(attachment.data.data, 'base64url');
    const sizeKb = data.length / 1024;
    
    if (sizeKb > maxKb * 2) {
      return {
        success: false,
        error: 'Attachment too large for preview',
        sizeKb: Math.round(sizeKb),
        maxKb: maxKb
      };
    }

    let text = '';
    let contentType = 'text/plain';

    try {
      // Handle PDF files
      if (mimeType === 'application/pdf') {
        // Dynamicky importuj pdf-parse až když je potřeba
        const pdfParse = (await import('pdf-parse')).default;
        const pdfData = await pdfParse(data);
        text = pdfData.text;
        contentType = 'application/pdf';
      }
      // Handle plain text
      else if (mimeType.includes('text/plain')) {
        text = data.toString('utf-8');
        contentType = 'text/plain';
      }
      // Handle HTML
      else if (mimeType.includes('text/html')) {
        text = data.toString('utf-8');
        contentType = 'text/html';
      }
      // Fallback
      else {
        text = data.toString('utf-8', 0, Math.min(data.length, maxKb * 1024));
        contentType = mimeType;
      }

      // Truncate if needed
      const maxChars = maxKb * 1024;
      const truncated = text.length > maxChars;
      if (truncated) {
        text = text.substring(0, maxChars);
      }

      return {
        success: true,
        truncated: truncated,
        chars: text.length,
        bytesScanned: data.length,
        contentType: contentType,
        text: text
      };

    } catch (error) {
      console.error('Error extracting text:', error.message);
      
      // Fallback to raw text
      text = data.toString('utf-8', 0, Math.min(data.length, maxKb * 1024));
      
      return {
        success: true,
        truncated: true,
        chars: text.length,
        bytesScanned: Math.min(data.length, maxKb * 1024),
        contentType: 'text/plain',
        text: text,
        warning: 'Could not parse as PDF, showing raw text'
      };
    }
  });
}

/**
 * Preview attachment table (CSV, XLSX) - FULL IMPLEMENTATION
 */
async function previewAttachmentTable(googleSub, messageId, attachmentId, options = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    const { sheet = 0, maxRows = 50 } = options;
    
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Get message to find attachment MIME type and filename
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    let mimeType = 'application/octet-stream';
    let filename = 'unknown';
    
    function findAttachmentInfo(parts) {
      for (const part of parts) {
        if (part.body?.attachmentId === attachmentId) {
          mimeType = part.mimeType || mimeType;
          filename = part.filename || filename;
          return true;
        }
        if (part.parts) {
          if (findAttachmentInfo(part.parts)) return true;
        }
      }
      return false;
    }

    if (message.data.payload?.parts) {
      findAttachmentInfo(message.data.payload.parts);
    }

    // Get attachment data
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: attachmentId
    });

    const data = Buffer.from(attachment.data.data, 'base64url');

    try {
      // Handle CSV files
      if (mimeType.includes('csv') || filename.toLowerCase().endsWith('.csv')) {
        const text = data.toString('utf-8');
        const lines = text.split('\n').filter(l => l.trim());
        
        if (lines.length === 0) {
          return {
            success: false,
            error: 'CSV file is empty'
          };
        }

        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
        const rows = lines.slice(1, Math.min(lines.length, maxRows + 1))
          .map(line => {
            // Simple CSV parsing (handles basic cases)
            return line.split(',').map(cell => cell.trim().replace(/^["']|["']$/g, ''));
          });
        
        return {
          success: true,
          truncated: lines.length > maxRows + 1,
          totalRows: lines.length - 1,
          totalCols: headers.length,
          headers: headers,
          rows: rows
        };
      }
      
      // Handle XLSX files
      else if (mimeType.includes('spreadsheet') || 
               mimeType.includes('excel') ||
               filename.toLowerCase().endsWith('.xlsx') ||
               filename.toLowerCase().endsWith('.xls')) {
        
        const workbook = XLSX.read(data, { type: 'buffer' });
        
        // Get sheet names
        const sheetNames = workbook.SheetNames;
        
        if (sheetNames.length === 0) {
          return {
            success: false,
            error: 'Excel file has no sheets'
          };
        }

        // Determine which sheet to read
        let sheetName;
        if (typeof sheet === 'string') {
          sheetName = sheet;
          if (!sheetNames.includes(sheetName)) {
            return {
              success: false,
              error: `Sheet "${sheetName}" not found`,
              sheets: sheetNames
            };
          }
        } else {
          const sheetIndex = parseInt(sheet);
          if (sheetIndex >= sheetNames.length) {
            return {
              success: false,
              error: `Sheet index ${sheetIndex} out of range`,
              sheets: sheetNames
            };
          }
          sheetName = sheetNames[sheetIndex];
        }

        const worksheet = workbook.Sheets[sheetName];
        
        // Convert to JSON array
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
          header: 1,  // Return array of arrays
          defval: null,  // Use null for empty cells
          blankrows: false  // Skip blank rows
        });

        if (jsonData.length === 0) {
          return {
            success: false,
            error: 'Sheet is empty',
            sheetName: sheetName,
            sheets: sheetNames
          };
        }

        const headers = jsonData[0].map(h => h !== null ? String(h) : '');
        const rows = jsonData.slice(1, Math.min(jsonData.length, maxRows + 1));
        
        return {
          success: true,
          truncated: jsonData.length > maxRows + 1,
          sheetName: sheetName,
          sheets: sheetNames,
          totalRows: jsonData.length - 1,
          totalCols: headers.length,
          headers: headers,
          rows: rows
        };
      }
      
      // Unsupported type
      else {
        return {
          success: false,
          error: 'Unsupported file type for table preview',
          mimeType: mimeType,
          filename: filename,
          hint: 'Only CSV and XLSX files are supported'
        };
      }

    } catch (error) {
      console.error('Error parsing table:', error.message);
      
      return {
        success: false,
        error: 'Failed to parse file',
        details: error.message,
        mimeType: mimeType,
        filename: filename
      };
    }
  });
}

// ==================== CALENDAR FUNCTIONS ====================

async function createCalendarEvent(googleSub, eventData, options = {}) {
  const {
    calendarId = 'primary',
    conferenceDataVersion
  } = options;

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const fallbackTimeZone = eventData.timeZone || REFERENCE_TIMEZONE;

    const normalizeTimeForApi = (time, label) => {
      if (!time) {
        throwServiceError(`Event ${label} is required`, {
          statusCode: 400,
          code: 'CALENDAR_EVENT_TIME_REQUIRED',
          expose: true,
          details: { field: label }
        });
      }

      if (time.dateTime) {
        // Controller already normalized the time with proper timeZone field
        // Pass through as-is (may have timeZone field for Prague times)
        const normalized = { dateTime: time.dateTime };
        if (time.timeZone) {
          normalized.timeZone = time.timeZone;
        }
        return normalized;
      }

      if (time.date) {
        // All-day events
        const normalized = { date: time.date };
        if (time.timeZone || fallbackTimeZone) {
          normalized.timeZone = time.timeZone || fallbackTimeZone;
        }
        return normalized;
      }

      throwServiceError(`Unsupported ${label} format. Provide dateTime or date`, {
        statusCode: 400,
        code: 'CALENDAR_EVENT_TIME_UNSUPPORTED',
        expose: true,
        details: { field: label }
      });
    };

    const event = {
      summary: eventData.summary,
      description: eventData.description || '',
      start: normalizeTimeForApi(eventData.start, 'start'),
      end: normalizeTimeForApi(eventData.end, 'end')
    };

    if (eventData.attendees) {
      event.attendees = eventData.attendees.map(attendee => {
        if (typeof attendee === 'string') {
          return { email: attendee };
        } else if (attendee && attendee.email) {
          const obj = { email: attendee.email };
          if (attendee.displayName) obj.displayName = attendee.displayName;
          return obj;
        }
        return null;
      }).filter(Boolean);
    }

    if (eventData.location) {
      event.location = eventData.location;
    }

    if (eventData.reminders) {
      event.reminders = eventData.reminders;
    }

    const insertConfig = {
      calendarId,
      requestBody: event,
      sendUpdates: eventData.attendees ? 'all' : 'none'
    };

    if (typeof conferenceDataVersion === 'number') {
      insertConfig.conferenceDataVersion = conferenceDataVersion;
    } else if (eventData.conferenceData) {
      insertConfig.conferenceDataVersion = 1;
    }

    const result = await calendar.events.insert(insertConfig);

    return result.data;
  });
}

async function getCalendarEvent(googleSub, eventId, options = {}) {
  const { calendarId = 'primary' } = options;

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const result = await calendar.events.get({
      calendarId,
      eventId: eventId
    });

    return result.data;
  });
}

async function listCalendarEvents(googleSub, {
  calendarId = 'primary',
  timeMin,
  timeMax,
  maxResults = 250,
  query
} = {}) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const params = {
      calendarId,
      timeMin: timeMin || new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    };

    if (timeMax) params.timeMax = timeMax;
    if (query) params.q = query;

    const result = await calendar.events.list(params);
    return result.data;
  });
}

async function updateCalendarEvent(googleSub, eventId, updates, options = {}) {
  const { calendarId = 'primary' } = options;

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const existing = await calendar.events.get({
      calendarId,
      eventId: eventId
    });

    const updatedEvent = {
      ...existing.data,
      ...updates
    };

    // Transform attendees if provided
    if (updatedEvent.attendees) {
      updatedEvent.attendees = updatedEvent.attendees.map(attendee => {
        if (typeof attendee === 'string') {
          return { email: attendee };
        } else if (attendee && attendee.email) {
          const obj = { email: attendee.email };
          if (attendee.displayName) obj.displayName = attendee.displayName;
          return obj;
        }
        return null;
      }).filter(Boolean);
    }

    const result = await calendar.events.update({
      calendarId,
      eventId: eventId,
      requestBody: updatedEvent,
      sendUpdates: updatedEvent.attendees ? 'all' : 'none'
    });

    return result.data;
  });
}

async function deleteCalendarEvent(googleSub, eventId, options = {}) {
  const { calendarId = 'primary' } = options;

  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    await calendar.events.delete({
      calendarId,
      eventId: eventId
    });

    return { success: true, eventId };
  });
}

async function checkConflicts(googleSub, { calendarId = 'primary', start, end, excludeEventId }) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const result = await calendar.events.list({
      calendarId,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = result.data.items || [];
    const conflicts = [];
    const requestStart = new Date(start);
    const requestEnd = new Date(end);

    for (const event of events) {
      if (excludeEventId && event.id === excludeEventId) {
        continue;
      }

      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);

      if (eventStart < requestEnd && eventEnd > requestStart) {
        conflicts.push({
          eventId: event.id,
          summary: event.summary,
          start: event.start.dateTime || event.start.date,
          end: event.end.dateTime || event.end.date,
          htmlLink: event.htmlLink
        });
      }
    }

    return conflicts;
  });
}

async function listCalendars(googleSub) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    const result = await calendar.calendarList.list();
    const items = result.data.items || [];

    return items.map(item => ({
      id: item.id,
      displayName: item.summary,
      isPrimary: item.primary === true,
      accessRole: item.accessRole
    }));
  });
}

/**
 * Download attachment (for signed URL endpoint)
 */
async function downloadAttachment(googleSub, messageId, attachmentId) {
  return await handleGoogleApiCall(googleSub, async () => {
    const authClient = await getAuthenticatedClient(googleSub);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Get message to find attachment info
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    let attachmentInfo = null;
    
    function findAttachment(parts) {
      for (const part of parts) {
        if (part.body?.attachmentId === attachmentId) {
          attachmentInfo = {
            filename: part.filename || 'attachment',
            mimeType: part.mimeType || 'application/octet-stream',
            size: part.body.size || 0
          };
          return true;
        }
        if (part.parts) {
          if (findAttachment(part.parts)) return true;
        }
      }
      return false;
    }

    if (message.data.payload?.parts) {
      findAttachment(message.data.payload.parts);
    }

    if (!attachmentInfo) {
      throwServiceError('Attachment not found', {
        statusCode: 404,
        code: 'ATTACHMENT_NOT_FOUND',
        expose: true,
        details: { messageId, attachmentId }
      });
    }

    // Get attachment data
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: attachmentId
    });

    const data = Buffer.from(attachment.data.data, 'base64url');

    return {
      filename: attachmentInfo.filename,
      mimeType: attachmentInfo.mimeType,
      size: attachmentInfo.size,
      data: data
    };
  });
}

const traced = wrapModuleFunctions('services.googleApiService', {
  EMAIL_SIZE_LIMITS,
  getValidAccessToken,
  sendEmail,
  readEmail,
  getEmailPreview,
  searchEmails,
  listFollowupCandidates,
  replyToEmail,
  createDraft,
  sendDraft,
  updateDraft,
  listDrafts,
  getDraft,
  deleteEmail,
  toggleStar,
  markAsRead,
  listLabels,
  createLabel,
  resolveLabelIdentifiers,
  modifyMessageLabels,
  modifyThreadLabels,
  getUserAddresses,
  getThread,
  setThreadRead,
  replyToThread,
  getAttachmentMeta,
  previewAttachmentText,
  previewAttachmentTable,
  downloadAttachment,
  classifyEmailCategory,
  createCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
  checkConflicts,
  listCalendars,
  getDebugDiagnostics,
  flushDebugCaches
});

const {
  EMAIL_SIZE_LIMITS: tracedEMAIL_SIZE_LIMITS,
  getValidAccessToken: tracedGetValidAccessToken,
  sendEmail: tracedSendEmail,
  readEmail: tracedReadEmail,
  getEmailPreview: tracedGetEmailPreview,
  searchEmails: tracedSearchEmails,
  listFollowupCandidates: tracedListFollowupCandidates,
  replyToEmail: tracedReplyToEmail,
  createDraft: tracedCreateDraft,
  sendDraft: tracedSendDraft,
  updateDraft: tracedUpdateDraft,
  listDrafts: tracedListDrafts,
  getDraft: tracedGetDraft,
  deleteEmail: tracedDeleteEmail,
  toggleStar: tracedToggleStar,
  markAsRead: tracedMarkAsRead,
  listLabels: tracedListLabels,
  createLabel: tracedCreateLabel,
  resolveLabelIdentifiers: tracedResolveLabelIdentifiers,
  modifyMessageLabels: tracedModifyMessageLabels,
  modifyThreadLabels: tracedModifyThreadLabels,
  getUserAddresses: tracedGetUserAddresses,
  getThread: tracedGetThread,
  setThreadRead: tracedSetThreadRead,
  replyToThread: tracedReplyToThread,
  getAttachmentMeta: tracedGetAttachmentMeta,
  previewAttachmentText: tracedPreviewAttachmentText,
  previewAttachmentTable: tracedPreviewAttachmentTable,
  downloadAttachment: tracedDownloadAttachment,
  classifyEmailCategory: tracedClassifyEmailCategory,
  createCalendarEvent: tracedCreateCalendarEvent,
  getCalendarEvent: tracedGetCalendarEvent,
  listCalendarEvents: tracedListCalendarEvents,
  updateCalendarEvent: tracedUpdateCalendarEvent,
  deleteCalendarEvent: tracedDeleteCalendarEvent,
  checkConflicts: tracedCheckConflicts,
  listCalendars: tracedListCalendars,
  getDebugDiagnostics: tracedGetDebugDiagnostics,
  flushDebugCaches: tracedFlushDebugCaches
} = traced;

export {
  tracedEMAIL_SIZE_LIMITS as EMAIL_SIZE_LIMITS,
  tracedGetValidAccessToken as getValidAccessToken,
  tracedSendEmail as sendEmail,
  tracedReadEmail as readEmail,
  tracedGetEmailPreview as getEmailPreview,
  tracedSearchEmails as searchEmails,
  tracedListFollowupCandidates as listFollowupCandidates,
  tracedReplyToEmail as replyToEmail,
  tracedCreateDraft as createDraft,
  tracedSendDraft as sendDraft,
  tracedUpdateDraft as updateDraft,
  tracedListDrafts as listDrafts,
  tracedGetDraft as getDraft,
  tracedDeleteEmail as deleteEmail,
  tracedToggleStar as toggleStar,
  tracedMarkAsRead as markAsRead,
  tracedListLabels as listLabels,
  tracedCreateLabel as createLabel,
  tracedResolveLabelIdentifiers as resolveLabelIdentifiers,
  tracedModifyMessageLabels as modifyMessageLabels,
  tracedModifyThreadLabels as modifyThreadLabels,
  tracedGetUserAddresses as getUserAddresses,
  tracedGetThread as getThread,
  tracedSetThreadRead as setThreadRead,
  tracedReplyToThread as replyToThread,
  tracedGetAttachmentMeta as getAttachmentMeta,
  tracedPreviewAttachmentText as previewAttachmentText,
  tracedPreviewAttachmentTable as previewAttachmentTable,
  tracedDownloadAttachment as downloadAttachment,
  tracedClassifyEmailCategory as classifyEmailCategory,
  tracedCreateCalendarEvent as createCalendarEvent,
  tracedGetCalendarEvent as getCalendarEvent,
  tracedListCalendarEvents as listCalendarEvents,
  tracedUpdateCalendarEvent as updateCalendarEvent,
  tracedDeleteCalendarEvent as deleteCalendarEvent,
  tracedCheckConflicts as checkConflicts,
  tracedListCalendars as listCalendars,
  tracedGetDebugDiagnostics as getDebugDiagnostics,
  tracedFlushDebugCaches as flushDebugCaches
};
