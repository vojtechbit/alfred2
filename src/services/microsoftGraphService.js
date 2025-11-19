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
    const needsRefresh = forceRefresh || isTokenExpired(user.tokenExpiry);

    if (!needsRefresh) {
      console.log('✅ [MICROSOFT_GRAPH] Access token still valid, using cached token');
      await updateLastUsed(microsoftId);
      return user.accessToken;
    }

    // Start refresh process
    console.log('🔄 [MICROSOFT_GRAPH] Access token expired or force refresh requested, refreshing...');

    const refreshPromise = (async () => {
      try {
        const newTokens = await refreshAccessToken(user.refreshToken);

        // Update tokens in database
        const tokenExpiry = determineExpiryDate(newTokens.expires_in);

        await updateTokens(microsoftId, {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,  // IMPORTANT: Save new refresh token!
          expiryDate: tokenExpiry,
          source: 'getValidAccessToken'
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

// ==================== MAIL API HELPER FUNCTIONS ====================

/**
 * Extracts skip token from @odata.nextLink for pagination
 */
function extractSkipToken(nextLink) {
  if (!nextLink) return null;

  try {
    const url = new URL(nextLink);
    return url.searchParams.get('$skiptoken') || url.searchParams.get('$skip');
  } catch (error) {
    console.warn('Failed to extract skip token from nextLink:', nextLink);
    return null;
  }
}

/**
 * Converts Microsoft Graph message to Gmail-compatible format
 *
 * @param {Object} message - Microsoft Graph message object
 * @param {string} microsoftId - User's Microsoft ID
 * @returns {Object} Gmail-compatible message object
 */
function convertMessageToGmailFormat(message, microsoftId) {
  // Extract email addresses
  const from = message.from?.emailAddress;
  const to = message.toRecipients?.map(r => r.emailAddress) || [];
  const cc = message.ccRecipients?.map(r => r.emailAddress) || [];
  const bcc = message.bccRecipients?.map(r => r.emailAddress) || [];

  // Map Outlook folders to Gmail labels
  const labels = [];
  if (message.parentFolderId) {
    const gmailLabel = OUTLOOK_TO_GMAIL_FOLDER_MAP[message.parentFolderId.toLowerCase()];
    if (gmailLabel) labels.push(gmailLabel);
  }

  // Add UNREAD label if not read
  if (!message.isRead) labels.push('UNREAD');

  // Add STARRED label if flagged
  if (message.flag?.flagStatus === 'flagged') labels.push('STARRED');

  // Extract attachments info
  const attachments = (message.attachments || []).map(att => ({
    filename: att.name,
    mimeType: att.contentType,
    size: att.size,
    attachmentId: att.id,
    isInline: att.isInline || false
  }));

  // Get body content
  const bodyContent = message.body?.content || '';
  const bodyType = message.body?.contentType || 'text';

  return {
    id: message.id,
    threadId: message.conversationId,
    labelIds: labels,
    snippet: message.bodyPreview || '',
    internalDate: new Date(message.receivedDateTime || message.sentDateTime).getTime(),
    payload: {
      headers: [
        { name: 'From', value: from ? `${from.name || ''} <${from.address}>` : '' },
        { name: 'To', value: to.map(r => `${r.name || ''} <${r.address}>`).join(', ') },
        { name: 'Cc', value: cc.map(r => `${r.name || ''} <${r.address}>`).join(', ') },
        { name: 'Subject', value: message.subject || '' },
        { name: 'Date', value: message.receivedDateTime || message.sentDateTime }
      ],
      mimeType: bodyType === 'html' ? 'text/html' : 'text/plain',
      body: {
        size: bodyContent.length,
        data: Buffer.from(bodyContent).toString('base64')
      },
      parts: attachments.length > 0 ? attachments : undefined
    },
    sizeEstimate: message.body?.content?.length || 0,
    raw: message,  // Keep original Microsoft message for reference

    // Microsoft-specific fields
    _microsoft: {
      parentFolderId: message.parentFolderId,
      conversationId: message.conversationId,
      isRead: message.isRead,
      isDraft: message.isDraft,
      flag: message.flag,
      importance: message.importance,
      categories: message.categories
    }
  };
}

/**
 * Builds OData filter for email search
 *
 * @param {Object} options - Search options
 * @returns {string} OData filter string
 */
function buildEmailFilter(options = {}) {
  const filters = [];

  if (options.from) {
    filters.push(`from/emailAddress/address eq '${options.from}'`);
  }

  if (options.to) {
    filters.push(`toRecipients/any(r: r/emailAddress/address eq '${options.to}')`);
  }

  if (options.subject) {
    filters.push(`contains(subject, '${options.subject}')`);
  }

  if (options.hasAttachment !== undefined) {
    filters.push(`hasAttachments eq ${options.hasAttachment}`);
  }

  if (options.isRead !== undefined) {
    filters.push(`isRead eq ${options.isRead}`);
  }

  if (options.receivedAfter) {
    const date = new Date(options.receivedAfter).toISOString();
    filters.push(`receivedDateTime ge ${date}`);
  }

  if (options.receivedBefore) {
    const date = new Date(options.receivedBefore).toISOString();
    filters.push(`receivedDateTime le ${date}`);
  }

  return filters.join(' and ');
}

// ==================== MAIL API FUNCTIONS ====================

/**
 * Search/list emails with filters
 *
 * Equivalent to Gmail's messages.list()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Object} options - Search options
 * @param {string} [options.folder='inbox'] - Folder to search (inbox, sentitems, drafts, etc.)
 * @param {number} [options.maxResults=100] - Maximum number of results
 * @param {string} [options.pageToken] - Page token for pagination
 * @param {string} [options.q] - Search query
 * @param {boolean} [options.includeSpamTrash=false] - Include spam and trash
 * @returns {Promise<Object>} Search results with messages and nextPageToken
 */
async function searchEmails(microsoftId, options = {}) {
  const timer = startTimer();

  try {
    const {
      folder = 'inbox',
      maxResults = 100,
      pageToken = null,
      q = null,
      includeSpamTrash = false
    } = options;

    const client = await getAuthenticatedClient(microsoftId);

    // Build request
    let request = client.api(`/me/mailFolders/${folder}/messages`)
      .top(Math.min(maxResults, 999))  // Microsoft Graph max is 999
      .orderby('receivedDateTime DESC')
      .select([
        'id',
        'conversationId',
        'subject',
        'bodyPreview',
        'from',
        'toRecipients',
        'ccRecipients',
        'receivedDateTime',
        'sentDateTime',
        'hasAttachments',
        'isRead',
        'isDraft',
        'flag',
        'importance',
        'parentFolderId'
      ].join(','));

    // Add search query if provided
    if (q) {
      request = request.search(q);
    }

    // Add pagination token
    if (pageToken) {
      request = request.skiptoken(pageToken);
    }

    const response = await handleGraphApiCall(microsoftId, () => request.get());

    const messages = (response.value || []).map(msg =>
      convertMessageToGmailFormat(msg, microsoftId)
    );

    const nextPageToken = extractSkipToken(response['@odata.nextLink']);

    logDuration('graph.searchEmails', timer, {
      folder,
      count: messages.length,
      hasNext: !!nextPageToken
    });

    return {
      messages,
      nextPageToken,
      resultSizeEstimate: messages.length
    };

  } catch (error) {
    console.error('❌ Failed to search emails:', error);
    throw mapGoogleApiError(error, 'searchEmails');
  }
}

/**
 * Read full email message
 *
 * Equivalent to Gmail's messages.get()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @param {Object} [options] - Read options
 * @param {string} [options.format='full'] - Response format (full, metadata, minimal)
 * @returns {Promise<Object>} Full message object
 */
async function readEmail(microsoftId, messageId, options = {}) {
  const timer = startTimer();

  try {
    const { format = 'full' } = options;

    const client = await getAuthenticatedClient(microsoftId);

    let select = [
      'id',
      'conversationId',
      'subject',
      'body',
      'bodyPreview',
      'from',
      'toRecipients',
      'ccRecipients',
      'bccRecipients',
      'replyTo',
      'receivedDateTime',
      'sentDateTime',
      'hasAttachments',
      'isRead',
      'isDraft',
      'flag',
      'importance',
      'categories',
      'parentFolderId',
      'conversationIndex',
      'internetMessageId'
    ];

    if (format === 'minimal') {
      select = ['id', 'subject', 'from', 'receivedDateTime'];
    } else if (format === 'metadata') {
      select = select.filter(f => f !== 'body');
    }

    const request = client.api(`/me/messages/${messageId}`)
      .select(select.join(','))
      .expand('attachments');

    const message = await handleGraphApiCall(microsoftId, () => request.get());

    const result = convertMessageToGmailFormat(message, microsoftId);

    logDuration('graph.readEmail', timer, {
      messageId,
      format,
      hasAttachments: message.hasAttachments
    });

    return result;

  } catch (error) {
    console.error('❌ Failed to read email:', error);
    throw mapGoogleApiError(error, 'readEmail');
  }
}

/**
 * Get email preview (lighter version of readEmail)
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @returns {Promise<Object>} Email preview
 */
async function getEmailPreview(microsoftId, messageId) {
  return await readEmail(microsoftId, messageId, { format: 'metadata' });
}

/**
 * Send email with optional attachments
 *
 * Equivalent to Gmail's messages.send()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Object} emailData - Email data
 * @param {string} emailData.to - Recipient email (comma-separated for multiple)
 * @param {string} [emailData.cc] - CC recipients
 * @param {string} [emailData.bcc] - BCC recipients
 * @param {string} emailData.subject - Email subject
 * @param {string} emailData.body - Email body (can be HTML)
 * @param {boolean} [emailData.isHtml=false] - Whether body is HTML
 * @param {Array} [emailData.attachments] - Attachments array
 * @returns {Promise<Object>} Sent message info
 */
async function sendEmail(microsoftId, emailData) {
  const timer = startTimer();

  try {
    const {
      to,
      cc,
      bcc,
      subject,
      body,
      isHtml = false,
      attachments = []
    } = emailData;

    // Parse recipients
    const toRecipients = to.split(',').map(email => ({
      emailAddress: { address: email.trim() }
    }));

    const ccRecipients = cc ? cc.split(',').map(email => ({
      emailAddress: { address: email.trim() }
    })) : [];

    const bccRecipients = bcc ? bcc.split(',').map(email => ({
      emailAddress: { address: email.trim() }
    })) : [];

    // Build message
    const message = {
      subject,
      body: {
        contentType: isHtml ? 'HTML' : 'Text',
        content: body
      },
      toRecipients,
      ccRecipients,
      bccRecipients
    };

    // Add attachments if provided
    if (attachments && attachments.length > 0) {
      message.attachments = attachments.map(att => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: att.filename || att.name,
        contentType: att.mimeType || 'application/octet-stream',
        contentBytes: att.data  // Base64 encoded
      }));
    }

    const client = await getAuthenticatedClient(microsoftId);

    const result = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/sendMail')
        .post({
          message,
          saveToSentItems: true
        })
    );

    logDuration('graph.sendEmail', timer, {
      to: toRecipients.length,
      cc: ccRecipients.length,
      attachments: attachments.length
    });

    return {
      success: true,
      messageId: result?.id,
      message: 'Email sent successfully'
    };

  } catch (error) {
    console.error('❌ Failed to send email:', error);
    throw mapGoogleApiError(error, 'sendEmail');
  }
}

/**
 * Reply to an email
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID to reply to
 * @param {Object} replyData - Reply data
 * @param {string} replyData.body - Reply body
 * @param {boolean} [replyData.isHtml=false] - Whether body is HTML
 * @param {boolean} [replyData.replyAll=false] - Reply to all recipients
 * @returns {Promise<Object>} Reply result
 */
async function replyToEmail(microsoftId, messageId, replyData) {
  const timer = startTimer();

  try {
    const {
      body,
      isHtml = false,
      replyAll = false
    } = replyData;

    const client = await getAuthenticatedClient(microsoftId);

    const endpoint = replyAll
      ? `/me/messages/${messageId}/replyAll`
      : `/me/messages/${messageId}/reply`;

    await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .post({
          comment: body
        })
    );

    logDuration('graph.replyToEmail', timer, {
      messageId,
      replyAll
    });

    return {
      success: true,
      message: 'Reply sent successfully'
    };

  } catch (error) {
    console.error('❌ Failed to reply to email:', error);
    throw mapGoogleApiError(error, 'replyToEmail');
  }
}

/**
 * Create draft email
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Object} draftData - Draft email data (same as sendEmail)
 * @returns {Promise<Object>} Created draft
 */
async function createDraft(microsoftId, draftData) {
  const timer = startTimer();

  try {
    const {
      to,
      cc,
      bcc,
      subject,
      body,
      isHtml = false
    } = draftData;

    const toRecipients = to ? to.split(',').map(email => ({
      emailAddress: { address: email.trim() }
    })) : [];

    const ccRecipients = cc ? cc.split(',').map(email => ({
      emailAddress: { address: email.trim() }
    })) : [];

    const bccRecipients = bcc ? bcc.split(',').map(email => ({
      emailAddress: { address: email.trim() }
    })) : [];

    const message = {
      subject: subject || '',
      body: {
        contentType: isHtml ? 'HTML' : 'Text',
        content: body || ''
      },
      toRecipients,
      ccRecipients,
      bccRecipients
    };

    const client = await getAuthenticatedClient(microsoftId);

    const draft = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/messages')
        .post(message)
    );

    logDuration('graph.createDraft', timer, { draftId: draft.id });

    return convertMessageToGmailFormat(draft, microsoftId);

  } catch (error) {
    console.error('❌ Failed to create draft:', error);
    throw mapGoogleApiError(error, 'createDraft');
  }
}

/**
 * Send existing draft
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} draftId - Draft ID
 * @returns {Promise<Object>} Send result
 */
async function sendDraft(microsoftId, draftId) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    await handleGraphApiCall(microsoftId, () =>
      client.api(`/me/messages/${draftId}/send`)
        .post({})
    );

    logDuration('graph.sendDraft', timer, { draftId });

    return {
      success: true,
      message: 'Draft sent successfully'
    };

  } catch (error) {
    console.error('❌ Failed to send draft:', error);
    throw mapGoogleApiError(error, 'sendDraft');
  }
}

/**
 * Update draft email
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} draftId - Draft ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated draft
 */
async function updateDraft(microsoftId, draftId, updates) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const message = {};

    if (updates.subject !== undefined) {
      message.subject = updates.subject;
    }

    if (updates.body !== undefined) {
      message.body = {
        contentType: updates.isHtml ? 'HTML' : 'Text',
        content: updates.body
      };
    }

    if (updates.to !== undefined) {
      message.toRecipients = updates.to.split(',').map(email => ({
        emailAddress: { address: email.trim() }
      }));
    }

    const draft = await handleGraphApiCall(microsoftId, () =>
      client.api(`/me/messages/${draftId}`)
        .patch(message)
    );

    logDuration('graph.updateDraft', timer, { draftId });

    return convertMessageToGmailFormat(draft, microsoftId);

  } catch (error) {
    console.error('❌ Failed to update draft:', error);
    throw mapGoogleApiError(error, 'updateDraft');
  }
}

/**
 * List draft emails
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {number} [maxResults=100] - Maximum number of results
 * @returns {Promise<Array>} Array of draft messages
 */
async function listDrafts(microsoftId, maxResults = 100) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const response = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/mailFolders/drafts/messages')
        .top(Math.min(maxResults, 999))
        .orderby('lastModifiedDateTime DESC')
        .get()
    );

    const drafts = (response.value || []).map(msg =>
      convertMessageToGmailFormat(msg, microsoftId)
    );

    logDuration('graph.listDrafts', timer, { count: drafts.length });

    return drafts;

  } catch (error) {
    console.error('❌ Failed to list drafts:', error);
    throw mapGoogleApiError(error, 'listDrafts');
  }
}

/**
 * Get single draft by ID
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} draftId - Draft ID
 * @returns {Promise<Object>} Draft message
 */
async function getDraft(microsoftId, draftId) {
  return await readEmail(microsoftId, draftId);
}

/**
 * Delete email message
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @returns {Promise<Object>} Delete result
 */
async function deleteEmail(microsoftId, messageId) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    await handleGraphApiCall(microsoftId, () =>
      client.api(`/me/messages/${messageId}`)
        .delete()
    );

    logDuration('graph.deleteEmail', timer, { messageId });

    return {
      success: true,
      message: 'Email deleted successfully'
    };

  } catch (error) {
    console.error('❌ Failed to delete email:', error);
    throw mapGoogleApiError(error, 'deleteEmail');
  }
}

/**
 * Toggle star/flag on email
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @param {boolean} starred - Whether to star or unstar
 * @returns {Promise<Object>} Update result
 */
async function toggleStar(microsoftId, messageId, starred) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    await handleGraphApiCall(microsoftId, () =>
      client.api(`/me/messages/${messageId}`)
        .patch({
          flag: {
            flagStatus: starred ? 'flagged' : 'notFlagged'
          }
        })
    );

    logDuration('graph.toggleStar', timer, { messageId, starred });

    return {
      success: true,
      starred
    };

  } catch (error) {
    console.error('❌ Failed to toggle star:', error);
    throw mapGoogleApiError(error, 'toggleStar');
  }
}

/**
 * Mark email as read or unread
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @param {boolean} read - Whether to mark as read or unread
 * @returns {Promise<Object>} Update result
 */
async function markAsRead(microsoftId, messageId, read) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    await handleGraphApiCall(microsoftId, () =>
      client.api(`/me/messages/${messageId}`)
        .patch({ isRead: read })
    );

    logDuration('graph.markAsRead', timer, { messageId, read });

    return {
      success: true,
      isRead: read
    };

  } catch (error) {
    console.error('❌ Failed to mark as read:', error);
    throw mapGoogleApiError(error, 'markAsRead');
  }
}

/**
 * Move message to folder (modify labels in Gmail terminology)
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @param {Array<string>} addLabels - Labels to add (folder names)
 * @param {Array<string>} removeLabels - Labels to remove
 * @returns {Promise<Object>} Update result
 */
async function modifyMessageLabels(microsoftId, messageId, addLabels = [], removeLabels = []) {
  const timer = startTimer();

  try {
    // In Outlook, we can only move message to one folder at a time
    // Take the first label to add and convert to Outlook folder
    if (addLabels.length > 0) {
      const targetLabel = addLabels[0];
      const targetFolder = GMAIL_TO_OUTLOOK_FOLDER_MAP[targetLabel] || targetLabel;

      const client = await getAuthenticatedClient(microsoftId);

      await handleGraphApiCall(microsoftId, () =>
        client.api(`/me/messages/${messageId}/move`)
          .post({
            destinationId: targetFolder
          })
      );
    }

    logDuration('graph.modifyMessageLabels', timer, {
      messageId,
      added: addLabels.length,
      removed: removeLabels.length
    });

    return {
      success: true,
      message: 'Labels modified successfully'
    };

  } catch (error) {
    console.error('❌ Failed to modify labels:', error);
    throw mapGoogleApiError(error, 'modifyMessageLabels');
  }
}

/**
 * Get email thread (conversation)
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} threadId - Thread/conversation ID
 * @returns {Promise<Array>} Array of messages in thread
 */
async function getThread(microsoftId, threadId) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    // Search for all messages with this conversation ID
    const response = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/messages')
        .filter(`conversationId eq '${threadId}'`)
        .orderby('receivedDateTime ASC')
        .expand('attachments')
        .get()
    );

    const messages = (response.value || []).map(msg =>
      convertMessageToGmailFormat(msg, microsoftId)
    );

    logDuration('graph.getThread', timer, {
      threadId,
      count: messages.length
    });

    return messages;

  } catch (error) {
    console.error('❌ Failed to get thread:', error);
    throw mapGoogleApiError(error, 'getThread');
  }
}

/**
 * Get attachment metadata
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @param {string} attachmentId - Attachment ID
 * @returns {Promise<Object>} Attachment metadata
 */
async function getAttachmentMeta(microsoftId, messageId, attachmentId) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const attachment = await handleGraphApiCall(microsoftId, () =>
      client.api(`/me/messages/${messageId}/attachments/${attachmentId}`)
        .get()
    );

    logDuration('graph.getAttachmentMeta', timer, {
      messageId,
      attachmentId,
      size: attachment.size
    });

    return {
      filename: attachment.name,
      mimeType: attachment.contentType,
      size: attachment.size,
      attachmentId: attachment.id,
      data: attachment.contentBytes  // Base64 encoded
    };

  } catch (error) {
    console.error('❌ Failed to get attachment metadata:', error);
    throw mapGoogleApiError(error, 'getAttachmentMeta');
  }
}

/**
 * Download attachment
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} messageId - Message ID
 * @param {string} attachmentId - Attachment ID
 * @returns {Promise<Object>} Attachment data
 */
async function downloadAttachment(microsoftId, messageId, attachmentId) {
  return await getAttachmentMeta(microsoftId, messageId, attachmentId);
}

/**
 * Get user's email addresses
 *
 * @param {string} microsoftId - Microsoft user ID
 * @returns {Promise<Array>} Array of email addresses
 */
async function getUserAddresses(microsoftId) {
  const timer = startTimer();

  // Check cache first
  const cached = userAddressCache.get(microsoftId);
  if (cached && (Date.now() - cached.timestamp) < USER_ADDRESS_CACHE_TTL_MS) {
    return cached.addresses;
  }

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const user = await handleGraphApiCall(microsoftId, () =>
      client.api('/me')
        .select('mail,userPrincipalName,proxyAddresses')
        .get()
    );

    const addresses = [
      user.mail,
      user.userPrincipalName,
      ...(user.proxyAddresses || [])
        .filter(addr => addr.startsWith('SMTP:'))
        .map(addr => addr.substring(5))
    ].filter(Boolean);

    // Cache the result
    userAddressCache.set(microsoftId, {
      addresses,
      timestamp: Date.now()
    });

    logDuration('graph.getUserAddresses', timer, {
      count: addresses.length
    });

    return addresses;

  } catch (error) {
    console.error('❌ Failed to get user addresses:', error);
    throw mapGoogleApiError(error, 'getUserAddresses');
  }
}

/**
 * List mail folders (labels in Gmail)
 *
 * @param {string} microsoftId - Microsoft user ID
 * @returns {Promise<Array>} Array of folders
 */
async function listLabels(microsoftId) {
  const timer = startTimer();

  // Check cache first
  const cached = folderDirectoryCache.get(microsoftId);
  if (cached && (Date.now() - cached.timestamp) < FOLDER_CACHE_TTL_MS) {
    return cached.folders;
  }

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const response = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/mailFolders')
        .select('id,displayName,totalItemCount,unreadItemCount')
        .get()
    );

    const folders = (response.value || []).map(folder => ({
      id: folder.id,
      name: folder.displayName,
      type: 'user',
      messagesTotal: folder.totalItemCount,
      messagesUnread: folder.unreadItemCount,
      // Map to Gmail label if applicable
      _gmailEquivalent: OUTLOOK_TO_GMAIL_FOLDER_MAP[folder.id.toLowerCase()]
    }));

    // Cache the result
    folderDirectoryCache.set(microsoftId, {
      folders,
      timestamp: Date.now()
    });

    logDuration('graph.listLabels', timer, {
      count: folders.length
    });

    return folders;

  } catch (error) {
    console.error('❌ Failed to list labels:', error);
    throw mapGoogleApiError(error, 'listLabels');
  }
}

/**
 * Create new mail folder (label)
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} name - Folder name
 * @returns {Promise<Object>} Created folder
 */
async function createLabel(microsoftId, name) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const folder = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/mailFolders')
        .post({
          displayName: name
        })
    );

    // Invalidate cache
    folderDirectoryCache.delete(microsoftId);

    logDuration('graph.createLabel', timer, { name });

    return {
      id: folder.id,
      name: folder.displayName,
      type: 'user'
    };

  } catch (error) {
    console.error('❌ Failed to create label:', error);
    throw mapGoogleApiError(error, 'createLabel');
  }
}

// ==================== CALENDAR API FUNCTIONS ====================

/**
 * Create calendar event
 *
 * Equivalent to Google Calendar's events.insert()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Object} eventData - Event data
 * @param {string} eventData.summary - Event title
 * @param {string} [eventData.description] - Event description
 * @param {Object} eventData.start - Start time ({ dateTime, timeZone } or { date })
 * @param {Object} eventData.end - End time ({ dateTime, timeZone } or { date })
 * @param {string} [eventData.location] - Event location
 * @param {Array} [eventData.attendees] - Array of attendee emails or objects
 * @param {Object} [eventData.reminders] - Reminder settings
 * @param {Object} [options] - Additional options
 * @param {string} [options.calendarId='primary'] - Calendar ID
 * @returns {Promise<Object>} Created event
 */
async function createCalendarEvent(microsoftId, eventData, options = {}) {
  const timer = startTimer();

  try {
    const { calendarId = 'primary' } = options;
    const fallbackTimeZone = eventData.timeZone || REFERENCE_TIMEZONE;

    // Build event object for Microsoft Graph
    const event = {
      subject: eventData.summary,
      body: {
        contentType: 'Text',
        content: eventData.description || ''
      }
    };

    // Handle start time
    if (eventData.start) {
      if (eventData.start.dateTime) {
        // Timed event
        const timeZone = eventData.start.timeZone || fallbackTimeZone;
        event.start = {
          dateTime: eventData.start.dateTime,
          timeZone: convertIANAToWindows(timeZone)
        };
      } else if (eventData.start.date) {
        // All-day event
        event.start = {
          dateTime: eventData.start.date,
          timeZone: 'UTC'
        };
        event.isAllDay = true;
      }
    }

    // Handle end time
    if (eventData.end) {
      if (eventData.end.dateTime) {
        const timeZone = eventData.end.timeZone || fallbackTimeZone;
        event.end = {
          dateTime: eventData.end.dateTime,
          timeZone: convertIANAToWindows(timeZone)
        };
      } else if (eventData.end.date) {
        event.end = {
          dateTime: eventData.end.date,
          timeZone: 'UTC'
        };
        event.isAllDay = true;
      }
    }

    // Handle location
    if (eventData.location) {
      event.location = {
        displayName: eventData.location
      };
    }

    // Handle attendees
    if (eventData.attendees && eventData.attendees.length > 0) {
      event.attendees = eventData.attendees.map(attendee => {
        if (typeof attendee === 'string') {
          return {
            emailAddress: { address: attendee },
            type: 'required'
          };
        } else if (attendee && attendee.email) {
          return {
            emailAddress: {
              address: attendee.email,
              name: attendee.displayName
            },
            type: attendee.optional ? 'optional' : 'required'
          };
        }
        return null;
      }).filter(Boolean);
    }

    // Handle reminders
    if (eventData.reminders) {
      if (eventData.reminders.useDefault === false && eventData.reminders.overrides) {
        event.isReminderOn = true;
        event.reminderMinutesBeforeStart = eventData.reminders.overrides[0]?.minutes || 15;
      }
    }

    const client = await getAuthenticatedClient(microsoftId);

    // Determine endpoint based on calendar ID
    const endpoint = calendarId === 'primary'
      ? '/me/events'
      : `/me/calendars/${calendarId}/events`;

    const result = await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .post(event)
    );

    logDuration('graph.createCalendarEvent', timer, {
      calendarId,
      hasAttendees: !!eventData.attendees,
      isAllDay: !!event.isAllDay
    });

    return result;

  } catch (error) {
    console.error('❌ Failed to create calendar event:', error);
    throw mapGoogleApiError(error, 'createCalendarEvent');
  }
}

/**
 * Get single calendar event
 *
 * Equivalent to Google Calendar's events.get()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} eventId - Event ID
 * @param {Object} [options] - Additional options
 * @param {string} [options.calendarId='primary'] - Calendar ID
 * @returns {Promise<Object>} Event object
 */
async function getCalendarEvent(microsoftId, eventId, options = {}) {
  const timer = startTimer();

  try {
    const { calendarId = 'primary' } = options;

    const client = await getAuthenticatedClient(microsoftId);

    const endpoint = calendarId === 'primary'
      ? `/me/events/${eventId}`
      : `/me/calendars/${calendarId}/events/${eventId}`;

    const event = await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .get()
    );

    logDuration('graph.getCalendarEvent', timer, { eventId, calendarId });

    return event;

  } catch (error) {
    console.error('❌ Failed to get calendar event:', error);
    throw mapGoogleApiError(error, 'getCalendarEvent');
  }
}

/**
 * List calendar events
 *
 * Equivalent to Google Calendar's events.list()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Object} [options] - List options
 * @param {string} [options.calendarId='primary'] - Calendar ID
 * @param {string} [options.timeMin] - Start time (ISO 8601)
 * @param {string} [options.timeMax] - End time (ISO 8601)
 * @param {number} [options.maxResults=250] - Maximum results
 * @param {string} [options.query] - Search query
 * @returns {Promise<Object>} Events list
 */
async function listCalendarEvents(microsoftId, options = {}) {
  const timer = startTimer();

  try {
    const {
      calendarId = 'primary',
      timeMin,
      timeMax,
      maxResults = 250,
      query
    } = options;

    const client = await getAuthenticatedClient(microsoftId);

    const endpoint = calendarId === 'primary'
      ? '/me/calendar/events'
      : `/me/calendars/${calendarId}/events`;

    let request = client.api(endpoint)
      .top(Math.min(maxResults, 999))
      .orderby('start/dateTime ASC');

    // Build filter
    const filters = [];
    if (timeMin) {
      filters.push(`start/dateTime ge '${timeMin}'`);
    }
    if (timeMax) {
      filters.push(`start/dateTime le '${timeMax}'`);
    }

    if (filters.length > 0) {
      request = request.filter(filters.join(' and '));
    }

    // Add search if provided
    if (query) {
      request = request.search(query);
    }

    const response = await handleGraphApiCall(microsoftId, () => request.get());

    logDuration('graph.listCalendarEvents', timer, {
      calendarId,
      count: response.value?.length || 0
    });

    return {
      items: response.value || [],
      nextPageToken: extractSkipToken(response['@odata.nextLink'])
    };

  } catch (error) {
    console.error('❌ Failed to list calendar events:', error);
    throw mapGoogleApiError(error, 'listCalendarEvents');
  }
}

/**
 * Update calendar event
 *
 * Equivalent to Google Calendar's events.update()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} eventId - Event ID
 * @param {Object} updates - Fields to update
 * @param {Object} [options] - Additional options
 * @param {string} [options.calendarId='primary'] - Calendar ID
 * @returns {Promise<Object>} Updated event
 */
async function updateCalendarEvent(microsoftId, eventId, updates, options = {}) {
  const timer = startTimer();

  try {
    const { calendarId = 'primary' } = options;

    const client = await getAuthenticatedClient(microsoftId);

    // First get the existing event
    const endpoint = calendarId === 'primary'
      ? `/me/events/${eventId}`
      : `/me/calendars/${calendarId}/events/${eventId}`;

    const existing = await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .get()
    );

    // Build update object
    const updateData = {};

    if (updates.summary !== undefined) {
      updateData.subject = updates.summary;
    }

    if (updates.description !== undefined) {
      updateData.body = {
        contentType: 'Text',
        content: updates.description
      };
    }

    if (updates.location !== undefined) {
      updateData.location = {
        displayName: updates.location
      };
    }

    if (updates.start) {
      if (updates.start.dateTime) {
        const timeZone = updates.start.timeZone || REFERENCE_TIMEZONE;
        updateData.start = {
          dateTime: updates.start.dateTime,
          timeZone: convertIANAToWindows(timeZone)
        };
      } else if (updates.start.date) {
        updateData.start = {
          dateTime: updates.start.date,
          timeZone: 'UTC'
        };
        updateData.isAllDay = true;
      }
    }

    if (updates.end) {
      if (updates.end.dateTime) {
        const timeZone = updates.end.timeZone || REFERENCE_TIMEZONE;
        updateData.end = {
          dateTime: updates.end.dateTime,
          timeZone: convertIANAToWindows(timeZone)
        };
      } else if (updates.end.date) {
        updateData.end = {
          dateTime: updates.end.date,
          timeZone: 'UTC'
        };
        updateData.isAllDay = true;
      }
    }

    if (updates.attendees) {
      updateData.attendees = updates.attendees.map(attendee => {
        if (typeof attendee === 'string') {
          return {
            emailAddress: { address: attendee },
            type: 'required'
          };
        } else if (attendee && attendee.email) {
          return {
            emailAddress: {
              address: attendee.email,
              name: attendee.displayName
            },
            type: attendee.optional ? 'optional' : 'required'
          };
        }
        return null;
      }).filter(Boolean);
    }

    const result = await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .patch(updateData)
    );

    logDuration('graph.updateCalendarEvent', timer, { eventId, calendarId });

    return result;

  } catch (error) {
    console.error('❌ Failed to update calendar event:', error);
    throw mapGoogleApiError(error, 'updateCalendarEvent');
  }
}

/**
 * Delete calendar event
 *
 * Equivalent to Google Calendar's events.delete()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {string} eventId - Event ID
 * @param {Object} [options] - Additional options
 * @param {string} [options.calendarId='primary'] - Calendar ID
 * @returns {Promise<Object>} Delete result
 */
async function deleteCalendarEvent(microsoftId, eventId, options = {}) {
  const timer = startTimer();

  try {
    const { calendarId = 'primary' } = options;

    const client = await getAuthenticatedClient(microsoftId);

    const endpoint = calendarId === 'primary'
      ? `/me/events/${eventId}`
      : `/me/calendars/${calendarId}/events/${eventId}`;

    await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .delete()
    );

    logDuration('graph.deleteCalendarEvent', timer, { eventId, calendarId });

    return {
      success: true,
      eventId
    };

  } catch (error) {
    console.error('❌ Failed to delete calendar event:', error);
    throw mapGoogleApiError(error, 'deleteCalendarEvent');
  }
}

/**
 * Check for calendar conflicts
 *
 * @param {string} microsoftId - Microsoft user ID
 * @param {Object} options - Check options
 * @param {string} [options.calendarId='primary'] - Calendar ID
 * @param {string} options.start - Start time (ISO 8601)
 * @param {string} options.end - End time (ISO 8601)
 * @param {string} [options.excludeEventId] - Event ID to exclude
 * @returns {Promise<Array>} Array of conflicting events
 */
async function checkConflicts(microsoftId, options) {
  const timer = startTimer();

  try {
    const {
      calendarId = 'primary',
      start,
      end,
      excludeEventId
    } = options;

    const client = await getAuthenticatedClient(microsoftId);

    const endpoint = calendarId === 'primary'
      ? '/me/calendar/events'
      : `/me/calendars/${calendarId}/events`;

    const response = await handleGraphApiCall(microsoftId, () =>
      client.api(endpoint)
        .filter(`start/dateTime lt '${end}' and end/dateTime gt '${start}'`)
        .select('id,subject,start,end,webLink')
        .get()
    );

    const events = response.value || [];
    const conflicts = [];
    const requestStart = new Date(start);
    const requestEnd = new Date(end);

    for (const event of events) {
      if (excludeEventId && event.id === excludeEventId) {
        continue;
      }

      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);

      if (eventStart < requestEnd && eventEnd > requestStart) {
        conflicts.push({
          eventId: event.id,
          summary: event.subject,
          start: event.start.dateTime,
          end: event.end.dateTime,
          htmlLink: event.webLink
        });
      }
    }

    logDuration('graph.checkConflicts', timer, {
      calendarId,
      conflicts: conflicts.length
    });

    return conflicts;

  } catch (error) {
    console.error('❌ Failed to check conflicts:', error);
    throw mapGoogleApiError(error, 'checkConflicts');
  }
}

/**
 * List user's calendars
 *
 * Equivalent to Google Calendar's calendarList.list()
 *
 * @param {string} microsoftId - Microsoft user ID
 * @returns {Promise<Array>} Array of calendars
 */
async function listCalendars(microsoftId) {
  const timer = startTimer();

  try {
    const client = await getAuthenticatedClient(microsoftId);

    const response = await handleGraphApiCall(microsoftId, () =>
      client.api('/me/calendars')
        .select('id,name,isDefaultCalendar,canEdit')
        .get()
    );

    const calendars = (response.value || []).map(calendar => ({
      id: calendar.id,
      displayName: calendar.name,
      isPrimary: calendar.isDefaultCalendar || false,
      accessRole: calendar.canEdit ? 'owner' : 'reader'
    }));

    logDuration('graph.listCalendars', timer, {
      count: calendars.length
    });

    return calendars;

  } catch (error) {
    console.error('❌ Failed to list calendars:', error);
    throw mapGoogleApiError(error, 'listCalendars');
  }
}

// ==================== TASKS API FUNCTIONS ====================
// (To be implemented in next update)

// ==================== CONTACTS API FUNCTIONS ====================
// (To be implemented in next update)

// ==================== EXPORTS ====================

const traced = wrapModuleFunctions('services.microsoftGraphService', {
  // Mail functions
  searchEmails,
  readEmail,
  getEmailPreview,
  sendEmail,
  replyToEmail,
  createDraft,
  sendDraft,
  updateDraft,
  listDrafts,
  getDraft,
  deleteEmail,
  toggleStar,
  markAsRead,
  modifyMessageLabels,
  getThread,
  getAttachmentMeta,
  downloadAttachment,
  getUserAddresses,
  listLabels,
  createLabel,
  // Calendar functions
  createCalendarEvent,
  getCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
  checkConflicts,
  listCalendars,
});

const {
  searchEmails: tracedSearchEmails,
  readEmail: tracedReadEmail,
  getEmailPreview: tracedGetEmailPreview,
  sendEmail: tracedSendEmail,
  replyToEmail: tracedReplyToEmail,
  createDraft: tracedCreateDraft,
  sendDraft: tracedSendDraft,
  updateDraft: tracedUpdateDraft,
  listDrafts: tracedListDrafts,
  getDraft: tracedGetDraft,
  deleteEmail: tracedDeleteEmail,
  toggleStar: tracedToggleStar,
  markAsRead: tracedMarkAsRead,
  modifyMessageLabels: tracedModifyMessageLabels,
  getThread: tracedGetThread,
  getAttachmentMeta: tracedGetAttachmentMeta,
  downloadAttachment: tracedDownloadAttachment,
  getUserAddresses: tracedGetUserAddresses,
  listLabels: tracedListLabels,
  createLabel: tracedCreateLabel,
  // Calendar functions
  createCalendarEvent: tracedCreateCalendarEvent,
  getCalendarEvent: tracedGetCalendarEvent,
  listCalendarEvents: tracedListCalendarEvents,
  updateCalendarEvent: tracedUpdateCalendarEvent,
  deleteCalendarEvent: tracedDeleteCalendarEvent,
  checkConflicts: tracedCheckConflicts,
  listCalendars: tracedListCalendars,
} = traced;

export {
  EMAIL_SIZE_LIMITS,
  getValidAccessToken,
  getDebugDiagnostics,
  flushDebugCaches,
  // Mail API
  tracedSearchEmails as searchEmails,
  tracedReadEmail as readEmail,
  tracedGetEmailPreview as getEmailPreview,
  tracedSendEmail as sendEmail,
  tracedReplyToEmail as replyToEmail,
  tracedCreateDraft as createDraft,
  tracedSendDraft as sendDraft,
  tracedUpdateDraft as updateDraft,
  tracedListDrafts as listDrafts,
  tracedGetDraft as getDraft,
  tracedDeleteEmail as deleteEmail,
  tracedToggleStar as toggleStar,
  tracedMarkAsRead as markAsRead,
  tracedModifyMessageLabels as modifyMessageLabels,
  tracedGetThread as getThread,
  tracedGetAttachmentMeta as getAttachmentMeta,
  tracedDownloadAttachment as downloadAttachment,
  tracedGetUserAddresses as getUserAddresses,
  tracedListLabels as listLabels,
  tracedCreateLabel as createLabel,
  // Calendar API
  tracedCreateCalendarEvent as createCalendarEvent,
  tracedGetCalendarEvent as getCalendarEvent,
  tracedListCalendarEvents as listCalendarEvents,
  tracedUpdateCalendarEvent as updateCalendarEvent,
  tracedDeleteCalendarEvent as deleteCalendarEvent,
  tracedCheckConflicts as checkConflicts,
  tracedListCalendars as listCalendars,
};
