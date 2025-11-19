/**
 * Facade Service - Business Façade Layer (BFF)
 *
 * Orchestrates existing backend services into high-level macros
 * optimized for GPT consumption.
 */
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


import * as gmailService from './microsoftGraphService.js';
import * as calendarService from './microsoftGraphService.js';
import * as contactsService from './contactsService.js';
import * as tasksService from './tasksService.js';
import { createServiceError, throwServiceError } from './serviceErrors.js';
import { getUserByGoogleSub } from './databaseService.js';
import { classifyEmailCategory } from './microsoftGraphService.js';
import { startTimer, logDuration } from '../utils/performanceLogger.js';
import {
  parseRelativeTime,
  parseIsoDateToPragueRange,
  getPragueOffsetHours,
  getPragueMidnightUtc,
  addPragueDays,
  getPragueDateParts,
  normalizeCalendarTime
} from '../utils/helpers.js';
import { REFERENCE_TIMEZONE } from '../config/limits.js';
import { processAttachments } from '../utils/attachmentSecurity.js';
import { generateSignedAttachmentUrl } from '../utils/signedUrlGenerator.js';
import {
  UNREPLIED_LABEL_NAME,
  UNREPLIED_LABEL_DEFAULTS,
  TRACKING_LABEL_NAME,
  TRACKING_LABEL_DEFAULTS
} from '../config/unrepliedLabels.js';
import {
  createPendingConfirmation,
  getPendingConfirmation,
  confirmPendingConfirmation,
  completePendingConfirmation
} from '../utils/confirmationStore.js';

export const EMAIL_QUICK_READ_FORMATS = Object.freeze([
  'snippet',
  'minimal',
  'metadata',
  'full'
]);

const FACADE_VALIDATION_ERROR = 'FacadeValidationError';

function throwFacadeValidationError(message, { code = 'INVALID_PARAM', details, cause } = {}) {
  throwServiceError(message, {
    name: FACADE_VALIDATION_ERROR,
    statusCode: 400,
    code,
    details,
    expose: true,
    cause
  });
}

/**
 * Selects the Gmail service implementation for the current runtime.
 *
 * In production we always use the real service, but tests can provide
 * deterministic responses by attaching overrides to
 * `globalThis.__facadeMocks.gmailService`.
 */
function resolveGmailService() {
  const mocks = globalThis?.__facadeMocks;

  if (process.env.NODE_ENV === 'test' && mocks?.gmailService) {
    return Object.assign({}, gmailService, mocks.gmailService);
  }

  return gmailService;
}

/**
 * Returns the unanswered-thread collector that should be used.
 *
 * Unit tests can inject a deterministic implementation via
 * `globalThis.__facadeMocks.collectUnansweredThreads`.
 */
function resolveCollectUnansweredThreads() {
  const mocks = globalThis?.__facadeMocks;

  if (process.env.NODE_ENV === 'test' && typeof mocks?.collectUnansweredThreads === 'function') {
    return mocks.collectUnansweredThreads;
  }

  return collectUnansweredThreads;
}

/**
 * Returns the database service wrapper for the current environment.
 *
 * Tests can stub individual methods (for example `getUserByGoogleSub`)
 * by providing `globalThis.__facadeMocks.databaseService`.
 */
function resolveDatabaseService() {
  const mocks = globalThis?.__facadeMocks;

  if (process.env.NODE_ENV === 'test' && mocks?.databaseService) {
    return Object.assign({ getUserByGoogleSub }, mocks.databaseService);
  }

  return { getUserByGoogleSub };
}

function resolveCalendarService() {
  const mocks = globalThis?.__facadeMocks;

  if (process.env.NODE_ENV === 'test' && mocks?.calendarService) {
    return Object.assign({}, calendarService, mocks.calendarService);
  }

  return calendarService;
}

function resolveContactsService() {
  const mocks = globalThis?.__facadeMocks;

  if (process.env.NODE_ENV === 'test' && mocks?.contactsService) {
    return Object.assign({}, contactsService, mocks.contactsService);
  }

  return contactsService;
}

function resolveCreatePendingConfirmation() {
  const mocks = globalThis?.__facadeMocks;

  if (
    process.env.NODE_ENV === 'test' &&
    mocks?.confirmationStore?.createPendingConfirmation
  ) {
    return mocks.confirmationStore.createPendingConfirmation;
  }

  return createPendingConfirmation;
}

// ==================== INBOX MACROS ====================

/**
 * Inbox Overview - lightweight cards without snippets
 * Step 1: Search for message IDs
 * Step 2: Batch fetch metadata for all messages
 * Step 3: Return enriched items with sender, subject, etc.
 */
async function inboxOverview(microsoftId, params = {}) {
  const {
    timeRange,
    maxItems = 100,
    filters = {},
    pageToken,
    query: rawQuery
  } = params;

  const gmail = resolveGmailService();

  const queryParts = [];
  let labelResolution = null;
  let requestedLabelCount = 0;

  // Handle sent/inbox filter based on filters
  // sentOnly: true → search only in sent folder
  // includeSent: true → search everywhere (inbox + sent + archived)
  // default (both false) → search only inbox
  if (filters.sentOnly) {
    queryParts.push('in:sent');
  } else if (filters.includeSent) {
    // Search everywhere - no in:inbox restriction
    // Still exclude drafts, trash, spam
    queryParts.push('-in:draft');
    queryParts.push('-in:trash');
    queryParts.push('-in:spam');
  } else {
    // Default: search only inbox (excludes sent, archived, trash, spam)
    queryParts.push('in:inbox');
    // Exclude drafts as extra safety
    queryParts.push('-in:draft');
  }

  if (typeof rawQuery === 'string' && rawQuery.trim()) {
    queryParts.push(rawQuery.trim());
  }

  if (filters.from) {
    const sanitizedFrom = filters.from.trim();
    if (sanitizedFrom) {
      const needsQuotes = /\s/.test(sanitizedFrom) && !/^".*"$/.test(sanitizedFrom);
      const value = needsQuotes ? `"${sanitizedFrom}"` : sanitizedFrom;
      queryParts.push(`from:${value}`);
    }
  }

  if (filters.hasAttachment) {
    queryParts.push('has:attachment');
  }

  if (filters.category) {
    // Gmail categories: use category: search syntax
    // IMPORTANT: category:primary returns ALL inbox (not just primary!)
    // Must use negative filters to exclude other categories
    const categoryLower = filters.category.toLowerCase();
    const validCategories = ['primary', 'work', 'promotions', 'social', 'updates', 'forums'];

    if (validCategories.includes(categoryLower)) {
      if (categoryLower === 'primary' || categoryLower === 'work') {
        // Primary = inbox minus other categories
        queryParts.push('-category:promotions');
        queryParts.push('-category:social');
        queryParts.push('-category:updates');
        queryParts.push('-category:forums');
      } else {
        // Other categories work normally
        queryParts.push(`category:${categoryLower}`);
      }
    }
  }

  if (filters.labelIds) {
    const requestedIdentifiers = Array.isArray(filters.labelIds)
      ? filters.labelIds
      : [filters.labelIds];

    const cleanedIdentifiers = requestedIdentifiers
      .map(value => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean);

    if (cleanedIdentifiers.length > 0) {
      requestedLabelCount = cleanedIdentifiers.length;
      labelResolution = await gmail.resolveLabelIdentifiers(microsoftId, cleanedIdentifiers);

      const appliedIds = labelResolution.appliedLabelIds || [];
      appliedIds.forEach(id => {
        if (id) {
          queryParts.push(`label:${id}`);
        }
      });

      if (appliedIds.length === 0 && labelResolution.requiresConfirmation) {
        return {
          items: [],
          subset: false,
          nextPageToken: null,
          labelResolution: {
            ...labelResolution,
            requestedCount: requestedLabelCount,
            queryAppliedLabelIds: [],
            querySkipped: true
          }
        };
      }
    }
  }

  if (timeRange) {
    if (timeRange.relative) {
      const times = parseRelativeTime(timeRange.relative);
      if (times?.after && times?.before) {
        queryParts.push(`after:${times.after}`);
        queryParts.push(`before:${times.before}`);
      } else {
        throw new ServiceError(
          `Invalid timeRange.relative value: "${timeRange.relative}". Supported values: today, yesterday, thisWeek, last7d, last24h, last3h, lastHour`,
          400
        );
      }
    } else {
      // Support both start/end and after/before formats
      const startDate = timeRange.start || timeRange.after;
      const endDate = timeRange.end || timeRange.before;

      if (!startDate || !endDate) {
        throw new ServiceError(
          'Invalid timeRange: must provide either "relative" or both "start"/"end" (or "after"/"before")',
          400
        );
      }

      // Parse dates in Prague timezone (handles "2025-11-07" as Prague day, not UTC)
      const startRange = parseIsoDateToPragueRange(startDate);
      const endRange = parseIsoDateToPragueRange(endDate);

      if (!startRange || !endRange) {
        throw new ServiceError(
          `Invalid date format in timeRange: start="${startDate}", end="${endDate}". Use ISO 8601 format (e.g., "2025-11-07")`,
          400
        );
      }

      // Determine actual end timestamp
      // If same date: use end of that day (e.g., "2025-11-07" to "2025-11-07" = full day)
      // If different dates: end date is exclusive (e.g., "2025-11-07" to "2025-11-08" = only 7th)
      let actualEnd;
      if (startDate === endDate) {
        actualEnd = startRange.before; // End of the same day
      } else {
        actualEnd = endRange.after - 1; // Midnight of end date minus 1 second
      }

      if (startRange.after >= actualEnd) {
        throw new ServiceError(
          'Invalid timeRange: start date must be before end date',
          400
        );
      }

      queryParts.push(`after:${startRange.after}`);
      queryParts.push(`before:${actualEnd}`);
    }
  }

  const builtQuery = queryParts.join(' ').trim();

  const searchResults = await gmail.searchEmails(microsoftId, {
    query: builtQuery || undefined,
    maxResults: Math.min(maxItems, 200),
    pageToken
  });
  
  if (!searchResults?.messages || searchResults.messages.length === 0) {
    return {
      items: [],
      subset: false,
      nextPageToken: null
    };
  }
  
  // Step 2: Batch fetch metadata for ALL message IDs (parallel batches for speed)
  const messageIds = searchResults.messages.map(m => m.id);
  const batchSize = 10; // Fetch 10 at a time to avoid rate limiting
  const batchCount = Math.ceil(messageIds.length / batchSize);
  const overviewTimer = startTimer();

  // Create all batch promises upfront (parallel execution)
  const batchPromises = [];
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const batchPromise = Promise.all(
      batch.map(id =>
        gmail.readEmail(microsoftId, id, { format: 'metadata' })
          .catch(err => {
            console.error(`Failed to fetch metadata for ${id}:`, err.message);
            return null;
          })
      )
    );
    batchPromises.push(batchPromise);
  }

  // Execute all batches in parallel and flatten results
  const batchResults = await Promise.all(batchPromises);
  const enrichedMessages = batchResults.flat().filter(m => m !== null);

  logDuration('inbox.overview.metadata', overviewTimer, {
    totalEmails: messageIds.length,
    batches: batchCount,
    successful: enrichedMessages.length
  });
  
  // Step 3: Map to standardized items
  const items = enrichedMessages.map(msg => {
    const fromHeader = msg.from || '';
    const fromEmail = extractEmail(fromHeader);
    const fromName = extractSenderName(fromHeader);
    const readState = buildReadStateFromLabels(msg.labelIds);
    const links = msg.links || buildGmailLinks(msg.threadId, msg.id);

    return {
      messageId: msg.id,
      senderName: fromName || null,
      senderAddress: fromEmail || fromHeader,
      subject: msg.subject || '(no subject)',
      receivedAt: msg.date || null,
      inboxCategory: classifyEmailCategory(msg),
      snippet: msg.snippet || '',
      readState,
      links
    };
  });
  
  const hasMore = Boolean(searchResults.nextPageToken);

  const response = {
    items,
    subset: hasMore,
    nextPageToken: searchResults.nextPageToken || null
  };

  // Add hint when more results are available
  if (hasMore) {
    response.hint = `This response contains ${items.length} emails with metadata. nextPageToken exists meaning the response is not complete. If user asks for summary or wants to see all matching emails, they usually expect complete data - it is recommended to call this function again with nextPageToken and continue until nextPageToken is null for complete results.`;
  }

  if (labelResolution) {
    response.labelResolution = {
      ...labelResolution,
      requestedCount: requestedLabelCount,
      queryAppliedLabelIds: labelResolution.appliedLabelIds || []
    };
  }

  return response;
}

/**
 * Inbox Snippets - overview with snippets and attachment URLs
 */
async function inboxSnippets(microsoftId, params = {}) {
  const { includeAttachments = true } = params;

  const gmail = resolveGmailService();
  const overview = await inboxOverview(microsoftId, params);

  if (overview.items.length === 0) {
    const emptyResponse = {
      items: [],
      subset: overview.subset,
      nextPageToken: overview.nextPageToken
    };

    if (overview.labelResolution) {
      emptyResponse.labelResolution = overview.labelResolution;
    }

    return emptyResponse;
  }

  const batchSize = 10;
  const batchCount = Math.ceil(overview.items.length / batchSize);
  const snippetsTimer = startTimer();

  // Create all batch promises upfront (parallel execution)
  const batchPromises = [];
  for (let i = 0; i < overview.items.length; i += batchSize) {
    const batch = overview.items.slice(i, i + batchSize);

    const batchPromise = Promise.all(
      batch.map(async (item) => {
        try {
          const preview = await gmail.getEmailPreview(microsoftId, item.messageId, {
            maxBytes: 4096
          });

          const bodySnippet = buildBodySnippetFromPayload(preview.payload, item.snippet || preview.snippet);

          const enriched = {
            ...item,
            snippet: bodySnippet,
            readState: buildReadStateFromLabels(preview.labelIds),
            attachmentUrls: []
          };

          if (includeAttachments) {
            const attachments = extractAttachmentMetadata(preview.payload || {});
            const processed = processAttachments(attachments, (att) =>
              generateSignedAttachmentUrl(item.messageId, att.body?.attachmentId)
            );

            enriched.attachmentUrls = processed.attachments
              .filter(a => !a.blocked && a.url)
              .map(a => a.url);

            if (processed.securityWarnings.length > 0) {
              enriched.attachmentSecurityWarnings = processed.securityWarnings;
            }
          }

          return enriched;
        } catch (error) {
          if (error?.statusCode === 451) {
            throw error;
          }

          console.error(`Failed to build snippet for ${item.messageId}:`, error.message);
          return {
            ...item,
            snippet: buildFallbackSnippet(item.snippet),
            attachmentUrls: []
          };
        }
      })
    );
    batchPromises.push(batchPromise);
  }

  // Execute all batches in parallel and flatten results
  const batchResults = await Promise.all(batchPromises);
  const enrichedItems = batchResults.flat();

  logDuration('inbox.snippets.enrichment', snippetsTimer, {
    totalEmails: overview.items.length,
    batches: batchCount,
    successful: enrichedItems.length
  });

  const response = {
    items: enrichedItems,
    subset: overview.subset,
    nextPageToken: overview.nextPageToken
  };

  // Pass through pagination hint from overview
  if (overview.hint) {
    response.hint = overview.hint;
  }

  if (overview.labelResolution) {
    response.labelResolution = overview.labelResolution;
  }

  return response;
}

/**
 * Helper function to progressively simplify search queries when no results are found
 * Returns array of search query attempts in order from most to least specific
 */
function generateFallbackSearchQueries(originalQuery) {
  const queries = [originalQuery];

  // Parse query to extract sender and subject filters
  const senderMatch = originalQuery.match(/from:([^\s]+|"[^"]+")/);
  const subjectMatch = originalQuery.match(/subject:([^\s]+|"[^"]+")/);

  // If we have both sender and subject, try variations
  if (senderMatch && subjectMatch) {
    const sender = senderMatch[0];
    const subject = subjectMatch[1].replace(/^"|"$/g, ''); // Remove quotes
    const otherParts = originalQuery
      .replace(senderMatch[0], '')
      .replace(/subject:([^\s]+|"[^"]+")/g, '')
      .trim();

    // Try just sender (with other filters if any)
    const senderOnly = [sender, otherParts].filter(p => p).join(' ');
    if (senderOnly !== originalQuery) {
      queries.push(senderOnly);
    }

    // Try progressively shorter subject strings
    if (subject.length > 3) {
      for (let len = Math.floor(subject.length * 0.7); len >= 3; len = Math.floor(len * 0.7)) {
        const shortSubject = subject.substring(0, len);
        queries.push(`subject:"${shortSubject}" ${sender} ${otherParts}`.trim());
      }
    }

    // Try subject only (with other filters if any)
    const subjectOnly = [`subject:"${subject}"`, otherParts].filter(p => p).join(' ');
    if (subjectOnly !== originalQuery && !queries.includes(subjectOnly)) {
      queries.push(subjectOnly);
    }
  } else if (subjectMatch) {
    // Only subject filter exists, try progressively shorter versions
    const subject = subjectMatch[1].replace(/^"|"$/g, '');
    const otherParts = originalQuery
      .replace(/subject:([^\s]+|"[^"]+")/g, '')
      .trim();

    if (subject.length > 3) {
      for (let len = Math.floor(subject.length * 0.7); len >= 3; len = Math.floor(len * 0.7)) {
        const shortSubject = subject.substring(0, len);
        const newQuery = [`subject:"${shortSubject}"`, otherParts].filter(p => p).join(' ');
        if (!queries.includes(newQuery)) {
          queries.push(newQuery);
        }
      }
    }
  }

  return queries;
}

/**
 * Search emails with progressive time range expansion
 * Tries: 3 days → 7 days → 14 days → 30 days
 * Returns { messages, timeRange, attemptedTimeRanges } where timeRange is the successful one
 */
async function searchEmailsWithProgressiveTime(microsoftId, searchQuery, options = {}) {
  const { maxResults = 100, pageToken, filters = {} } = options;
  const gmail = resolveGmailService();

  // Progressive time ranges to try
  const timeRanges = [
    { name: '3 days', relative: 'last3d', days: 3 },
    { name: '7 days', relative: 'last7d', days: 7 },
    { name: '14 days', relative: 'last14d', days: 14 },
    { name: '30 days', relative: 'last30d', days: 30 }
  ];

  const attemptedTimeRanges = [];

  for (const timeRange of timeRanges) {
    attemptedTimeRanges.push(timeRange.name);

    // Build query with time filter
    const queryParts = [];

    // Add sent/inbox filter
    if (filters.sentOnly) {
      queryParts.push('in:sent');
    } else if (!filters.includeSent) {
      queryParts.push('-in:sent');
    }

    // Add search query
    if (searchQuery) {
      queryParts.push(searchQuery);
    }

    // Add time filter
    const times = parseRelativeTime(timeRange.relative);
    if (times?.after && times?.before) {
      queryParts.push(`after:${times.after}`);
      queryParts.push(`before:${times.before}`);
    }

    // Add other filters
    if (filters.from) {
      const sanitizedFrom = filters.from.trim();
      if (sanitizedFrom) {
        const needsQuotes = /\s/.test(sanitizedFrom) && !/^".*"$/.test(sanitizedFrom);
        const value = needsQuotes ? `"${sanitizedFrom}"` : sanitizedFrom;
        queryParts.push(`from:${value}`);
      }
    }

    if (filters.hasAttachment) {
      queryParts.push('has:attachment');
    }

    const finalQuery = queryParts.join(' ');

    const result = await gmail.searchEmails(microsoftId, {
      query: finalQuery,
      maxResults,
      pageToken
    });

    const messages = result?.messages || [];
    if (messages.length > 0) {
      return {
        messages,
        nextPageToken: result?.nextPageToken || null,
        timeRange: timeRange.name,
        timeRangeUsed: timeRange.relative,
        attemptedTimeRanges,
        progressiveSearchUsed: true
      };
    }
  }

  // No results found even with 30 days
  return {
    messages: [],
    nextPageToken: null,
    timeRange: null,
    attemptedTimeRanges,
    progressiveSearchUsed: true
  };
}

/**
 * Smart email search with progressive time expansion AND query fallback
 * Combines both strategies:
 * 1. First tries progressive time ranges (3d → 7d → 14d → 30d)
 * 2. If still nothing, tries query fallback (simpler subject/sender)
 *
 * Returns comprehensive result with all attempted strategies
 */
async function searchEmailsSmart(microsoftId, searchQuery, options = {}) {
  const { maxResults = 100, pageToken, filters = {}, enableFallback = true } = options;

  const attemptLog = {
    timeRanges: [],
    queries: [],
    success: null
  };

  // Strategy 1: Try progressive time ranges with original query
  if (enableFallback) {
    const timeResult = await searchEmailsWithProgressiveTime(microsoftId, searchQuery, {
      maxResults,
      pageToken,
      filters
    });

    attemptLog.timeRanges = timeResult.attemptedTimeRanges;

    if (timeResult.messages.length > 0) {
      return {
        messages: timeResult.messages,
        nextPageToken: timeResult.nextPageToken,
        strategy: 'progressive_time',
        timeRangeUsed: timeResult.timeRange,
        attemptedStrategies: attemptLog,
        smartSearchUsed: true
      };
    }
  }

  // Strategy 2: If time expansion didn't help, try query fallback (without time limits)
  if (enableFallback && searchQuery) {
    const fallbackQueries = generateFallbackSearchQueries(searchQuery);
    attemptLog.queries = fallbackQueries;

    for (const query of fallbackQueries) {
      const result = await searchEmailsWithFallback(microsoftId, query, {
        maxResults,
        pageToken,
        enableFallback: false // Don't recurse
      });

      if (result.messages.length > 0) {
        return {
          messages: result.messages,
          nextPageToken: result.nextPageToken,
          strategy: 'query_fallback',
          queryUsed: query,
          originalQuery: searchQuery,
          attemptedStrategies: attemptLog,
          smartSearchUsed: true
        };
      }
    }
  }

  // Nothing found
  return {
    messages: [],
    nextPageToken: null,
    strategy: 'none',
    attemptedStrategies: attemptLog,
    smartSearchUsed: true
  };
}

/**
 * Search emails with automatic fallback to less strict queries
 * Returns { messages, query, attemptedQueries } where query is the successful query used
 */
async function searchEmailsWithFallback(microsoftId, searchQuery, options = {}) {
  const { maxResults = 100, pageToken, enableFallback = true } = options;
  const gmail = resolveGmailService();

  if (!enableFallback) {
    // Just do a single search without fallback
    const result = await gmail.searchEmails(microsoftId, {
      query: searchQuery,
      maxResults,
      pageToken
    });
    return {
      messages: result?.messages || [],
      nextPageToken: result?.nextPageToken || null,
      query: searchQuery,
      attemptedQueries: [searchQuery],
      fallbackUsed: false
    };
  }

  const fallbackQueries = generateFallbackSearchQueries(searchQuery);
  const attemptedQueries = [];

  for (const query of fallbackQueries) {
    attemptedQueries.push(query);

    const result = await gmail.searchEmails(microsoftId, {
      query,
      maxResults,
      pageToken
    });

    const messages = result?.messages || [];
    if (messages.length > 0) {
      return {
        messages,
        nextPageToken: result?.nextPageToken || null,
        query,
        attemptedQueries,
        fallbackUsed: query !== searchQuery
      };
    }
  }

  // No results found even with fallback
  return {
    messages: [],
    nextPageToken: null,
    query: searchQuery,
    attemptedQueries,
    fallbackUsed: false
  };
}

/**
 * Email Quick Read - single or batch read with attachments
 */
async function emailQuickRead(microsoftId, params = {}) {
  const { ids, searchQuery, format, pageToken, enableFallback = true } = params;

  const resolvedFormat = format ?? 'full';

  // Validate format parameter
  if (resolvedFormat && !EMAIL_QUICK_READ_FORMATS.includes(resolvedFormat)) {
    throwFacadeValidationError(
      `Invalid format: ${resolvedFormat}. Must be one of: ${EMAIL_QUICK_READ_FORMATS.join(', ')}`,
      {
        code: 'EMAIL_QUICK_READ_FORMAT_INVALID',
        details: {
          allowed: EMAIL_QUICK_READ_FORMATS,
          received: resolvedFormat
        }
      }
    );
  }

  let messageIds = ids;
  let nextPageToken = null;
  let subset = false;
  let usedQuery = null;
  let fallbackInfo = null;

  // Check if searchQuery is a thread ID (format: "thread:xxxxx")
  const threadIdMatch = searchQuery?.match(/^thread:([a-f0-9]+)$/i);

  if (threadIdMatch && !messageIds) {
    // Load thread directly using threads.get API
    const threadId = threadIdMatch[1];
    const gmail = resolveGmailService();

    try {
      const thread = await gmail.getThread(microsoftId, threadId);

      if (thread && Array.isArray(thread.messages) && thread.messages.length > 0) {
        messageIds = thread.messages.map(msg => msg.id);
        usedQuery = `thread:${threadId}`;
      } else {
        throwFacadeValidationError(
          `Thread not found or empty: "${threadId}"`,
          {
            code: 'EMAIL_THREAD_NOT_FOUND',
            details: {
              threadId,
              suggestion: 'Thread may not exist or may have been deleted'
            }
          }
        );
      }
    } catch (error) {
      if (error.code === 'EMAIL_THREAD_NOT_FOUND') {
        throw error;
      }
      throwFacadeValidationError(
        `Failed to load thread: "${threadId}"`,
        {
          code: 'EMAIL_THREAD_LOAD_FAILED',
          details: {
            threadId,
            error: error.message
          }
        }
      );
    }
  } else if (!messageIds && searchQuery) {
    // If searchQuery provided (but not thread ID), get IDs first (with optional fallback)
    const searchResult = await searchEmailsWithFallback(microsoftId, searchQuery, {
      maxResults: 100,
      pageToken,
      enableFallback
    });

    messageIds = searchResult.messages.map(m => m.id);
    nextPageToken = searchResult.nextPageToken;
    subset = Boolean(nextPageToken);
    usedQuery = searchResult.query;

    // If fallback was used, include info about it
    if (searchResult.fallbackUsed) {
      fallbackInfo = {
        originalQuery: searchQuery,
        usedQuery: searchResult.query,
        attemptedQueries: searchResult.attemptedQueries
      };
    }

    // If search returned no results even with fallback, throw error
    if (!messageIds || messageIds.length === 0) {
      throwFacadeValidationError(
        `Search query returned no results: "${searchQuery}"`,
        {
          code: 'EMAIL_SEARCH_NO_RESULTS',
          details: {
            searchQuery,
            attemptedQueries: searchResult.attemptedQueries,
            suggestion: 'Try a different search query, or use message/thread IDs directly if available'
          }
        }
      );
    }
  }

  if (!messageIds || messageIds.length === 0) {
    throwFacadeValidationError('No message IDs provided or found', {
      code: 'EMAIL_MESSAGE_IDS_MISSING',
      details: {
        suggestion: 'Provide either "ids" array or "searchQuery" parameter'
      }
    });
  }

  const gmail = resolveGmailService();

  // Decide single vs batch
  if (messageIds.length === 1) {
    const message = await gmail.readEmail(microsoftId, messageIds[0], { format: resolvedFormat });
    const enriched = enrichEmailWithAttachments(message, messageIds[0]);

    const result = {
      mode: 'single',
      item: enriched,
      subset,
      nextPageToken
    };

    if (fallbackInfo) {
      result.searchFallback = fallbackInfo;
    }

    return result;
  } else {
    const messages = await Promise.all(
      messageIds.map(id => gmail.readEmail(microsoftId, id, { format: resolvedFormat }))
    );

    const enriched = messages.map((msg, idx) =>
      enrichEmailWithAttachments(msg, messageIds[idx])
    );

    const result = {
      mode: 'batch',
      items: enriched,
      subset,
      nextPageToken
    };

    if (fallbackInfo) {
      result.searchFallback = fallbackInfo;
    }

    return result;
  }
}

async function inboxUserUnansweredRequests(microsoftId, params = {}) {
  const {
    includeUnread = true,
    includeRead = true,
    maxItems = 20,
    timeRange = null,
    timeWindow: timeWindowParam = null,
    strictNoReply = true,
    unreadPageToken,
    readPageToken,
    labelName = UNREPLIED_LABEL_NAME,
    labelColor,
    query: additionalQuery,
    primaryOnly = true,
    autoAddLabels = true
  } = params;

  const includeUnreadFinal = includeUnread !== false;
  const includeReadFinal = includeRead !== false;
  const limit = Math.max(1, Math.min(Number(maxItems) || 20, 100));

  const normalizedLabelName = typeof labelName === 'string' && labelName.trim().length > 0
    ? labelName.trim()
    : UNREPLIED_LABEL_NAME;

  let effectiveTimeRange = timeRange;
  let usingDefaultTimeRange = false;
  let explicitTimeWindowSource = null;
  if (timeWindowParam === 'today') {
    effectiveTimeRange = { relative: 'today' };
    explicitTimeWindowSource = 'timeWindow_today';
  }
  if (!effectiveTimeRange) {
    effectiveTimeRange = { relative: 'today' };
    usingDefaultTimeRange = true;
  }

  const timeFilters = buildTimeFilterClauses(effectiveTimeRange);
  const timeWindowResolved = describeTimeFilters(timeFilters);
  const primaryOnlyFinal = primaryOnly !== false;

  const baseQueryParts = ['in:inbox', '-from:me', '-in:draft', '-in:trash', '-in:spam'];
  if (primaryOnlyFinal) {
    // Primary = inbox minus other categories (category:primary returns ALL inbox!)
    baseQueryParts.push('-category:promotions');
    baseQueryParts.push('-category:social');
    baseQueryParts.push('-category:updates');
    baseQueryParts.push('-category:forums');
  }
  if (timeFilters.after) {
    baseQueryParts.push(`after:${timeFilters.after}`);
  }
  if (timeFilters.before) {
    baseQueryParts.push(`before:${timeFilters.before}`);
  }
  if (typeof additionalQuery === 'string' && additionalQuery.trim().length > 0) {
    baseQueryParts.push(additionalQuery.trim());
  }

  const baseQuery = baseQueryParts.join(' ').trim();

  const gmail = resolveGmailService();
  const database = resolveDatabaseService();

  const [labels, userRecord, userAddressesRaw] = await Promise.all([
    gmail.listLabels(microsoftId),
    database.getUserByGoogleSub(microsoftId).catch(() => null),
    gmail.getUserAddresses(microsoftId).catch(() => [])
  ]);

  let trackingLabelRecommendation = buildLabelRecommendation(
    labels,
    TRACKING_LABEL_NAME,
    TRACKING_LABEL_DEFAULTS.color
  );

  // Auto-create tracking label if it doesn't exist
  if (autoAddLabels !== false && !trackingLabelRecommendation.existingLabel) {
    try {
      const createdTrackingLabel = await gmail.createLabel(microsoftId, {
        name: TRACKING_LABEL_NAME,
        color: TRACKING_LABEL_DEFAULTS.color,
        labelListVisibility: 'labelHide', // Hide from label list by default
        messageListVisibility: 'hide' // Hide from message list by default
      });

      if (createdTrackingLabel?.id) {
        const createdTrackingMetadata = {
          id: createdTrackingLabel.id,
          name: createdTrackingLabel.name,
          color: createdTrackingLabel.color
            ? {
                backgroundColor: createdTrackingLabel.color,
                textColor: createdTrackingLabel.textColor || null
              }
            : null
        };

        labels.push({
          id: createdTrackingLabel.id,
          name: createdTrackingLabel.name,
          type: 'user',
          color: createdTrackingMetadata.color
        });

        trackingLabelRecommendation = buildLabelRecommendation(
          labels,
          TRACKING_LABEL_NAME,
          TRACKING_LABEL_DEFAULTS.color
        );

        console.log(`✓ Auto-created tracking label "${TRACKING_LABEL_NAME}" (ID: ${createdTrackingLabel.id})`);
      }
    } catch (creationError) {
      console.warn('⚠️ Unable to auto-create tracking label:', creationError.message);
    }
  }

  const watchlistLabelColor = normalizeWatchlistLabelColor(labelColor);

  let baseLabelRecommendation = buildLabelRecommendation(
    labels,
    normalizedLabelName,
    watchlistLabelColor,
    {
      extraLabelIds: trackingLabelRecommendation.existingLabel
        ? [trackingLabelRecommendation.existingLabel.id]
        : []
    }
  );

  let labelRecommendation = {
    ...baseLabelRecommendation,
    missingLabel: !baseLabelRecommendation.existingLabel
  };

  if (autoAddLabels !== false && !labelRecommendation.existingLabel) {
    try {
      const createdLabel = await gmail.createLabel(microsoftId, {
        name: normalizedLabelName,
        color: watchlistLabelColor,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      });

      if (createdLabel?.id) {
        const appliedIds = [createdLabel.id];
        if (trackingLabelRecommendation.existingLabel?.id) {
          appliedIds.push(trackingLabelRecommendation.existingLabel.id);
        }

        const createdLabelMetadata = {
          id: createdLabel.id,
          name: createdLabel.name,
          color: createdLabel.color
            ? {
                backgroundColor: createdLabel.color,
                textColor: createdLabel.textColor || null
              }
            : null
        };

        labels.push({
          id: createdLabel.id,
          name: createdLabel.name,
          type: 'user',
          color: createdLabelMetadata.color
        });

        baseLabelRecommendation = buildLabelRecommendation(
          labels,
          normalizedLabelName,
          watchlistLabelColor,
          {
            extraLabelIds: trackingLabelRecommendation.existingLabel
              ? [trackingLabelRecommendation.existingLabel.id]
              : []
          }
        );

        labelRecommendation = {
          ...baseLabelRecommendation,
          existingLabel: createdLabelMetadata,
          canCreate: false,
          createRequest: null,
          applyRequestTemplate: {
            op: 'labels',
            params: {
              modify: {
                messageId: '<messageId>',
                add: appliedIds,
                remove: []
              }
            }
          },
          missingLabel: false
        };
      }
    } catch (creationError) {
      console.warn('⚠️ Unable to auto-create watchlist label:', creationError.message);
    }
  }

  let labelMatch = labelRecommendation.existingLabel
    ? labels.find(label => label.id === labelRecommendation.existingLabel.id)
    : null;

  const trackingLabelMatch = trackingLabelRecommendation.existingLabel
    ? labels.find(label => label.id === trackingLabelRecommendation.existingLabel.id)
    : null;

  const userAddressSet = new Set(
    (userAddressesRaw || [])
      .concat(userRecord?.email ? [userRecord.email] : [])
      .map(value => (typeof value === 'string' ? value.toLowerCase() : ''))
      .filter(Boolean)
  );

  const searchOptions = {
    microsoftId,
    baseQuery,
    limit,
    userAddresses: Array.from(userAddressSet),
    strictNoReply: strictNoReply !== false,
    labelMatch,
    trackingLabelMatch
  };

  // Resolve at call time so unit tests can swap in deterministic collectors.
  const collectThreads = resolveCollectUnansweredThreads();

  const unreadResult = includeUnreadFinal
    ? await collectThreads({ ...searchOptions, querySuffix: 'is:unread', pageToken: unreadPageToken })
    : createEmptyUnansweredBucket();

  const readResult = includeReadFinal
    ? await collectThreads({ ...searchOptions, querySuffix: '-is:unread', pageToken: readPageToken })
    : createEmptyUnansweredBucket();

  if (autoAddLabels !== false) {
    await autoApplyWatchlistLabels({
      microsoftId,
      gmail,
      targetLabel: labelRecommendation.existingLabel,
      trackingLabel: trackingLabelRecommendation.existingLabel,
      unreadBucket: unreadResult,
      readBucket: readResult
    });

    // Refresh label match reference if it was missing earlier but now created.
    if (!labelMatch && labelRecommendation.existingLabel) {
      labelMatch = {
        id: labelRecommendation.existingLabel.id,
        name: labelRecommendation.existingLabel.name
      };
    }
  }

  const labelAppliedCount = unreadResult.items.filter(item => item.labelApplied).length
    + readResult.items.filter(item => item.labelApplied).length;
  const trackingLabelAppliedCount = unreadResult.items.filter(item => item.trackingLabelApplied).length
    + readResult.items.filter(item => item.trackingLabelApplied).length;
  const skippedMetaSeen = (unreadResult.skippedReasons.trackingLabelPresent || 0)
    + (readResult.skippedReasons.trackingLabelPresent || 0);

  const summary = {
    totalAwaiting: unreadResult.items.length + readResult.items.length,
    unreadCount: unreadResult.items.length,
    readCount: readResult.items.length,
    strictMode: strictNoReply !== false,
    timeRangeApplied: Boolean(timeFilters.after || timeFilters.before),
    timeRangeSource: explicitTimeWindowSource || (usingDefaultTimeRange ? 'default_today' : null),
    timeWindow: timeWindowResolved,
    primaryOnly: primaryOnlyFinal,
    scannedMessages: unreadResult.scanned + readResult.scanned,
    overflowCount: unreadResult.overflowCount + readResult.overflowCount,
    strictFilteredCount:
      (unreadResult.skippedReasons.userReplyPresent || 0)
      + (readResult.skippedReasons.userReplyPresent || 0),
    labelAlreadyApplied: labelAppliedCount,
    missingLabel: !labelRecommendation.existingLabel,
    trackingLabelAlreadyApplied: trackingLabelAppliedCount,
    trackingLabelMissing: !trackingLabelRecommendation.existingLabel,
    trackingLabelSkipped: skippedMetaSeen
  };

  return {
    summary,
    unread: unreadResult,
    read: readResult,
    labelRecommendation,
    trackingLabel: {
      ...trackingLabelRecommendation,
      role: 'watchlist_tracking',
      skipReason: 'trackingLabelPresent'
    }
  };
}

// ==================== BRIEFING MACROS ====================

const MAX_MEETING_BRIEFING_EVENTS = 25;
const MAX_MEETING_BRIEFING_SEARCH_RESULTS = 10;
const MAX_MEETING_BRIEFING_AUTO_KEYWORDS = 5;
const MAX_MEETING_BRIEFING_SEARCH_VARIANTS = 30;

async function meetingEmailsToday(microsoftId, rawParams = {}) {
  const params = rawParams || {};
  const {
    date,
    lookbackDays = 14,
    calendarId = 'primary',
    globalKeywordHints
  } = params;

  const targetDateParts = normalizeBriefingDateParts(date);
  const safeLookbackDays = normalizeBriefingLookback(lookbackDays);
  const safeCalendarId = normalizeBriefingCalendarId(calendarId);
  const keywordHints = normalizeBriefingKeywordHints(globalKeywordHints);

  const dayStartUtc = getPragueMidnightUtc(targetDateParts);
  const nextDayUtc = getPragueMidnightUtc(addPragueDays(targetDateParts, 1));
  const lookbackStartParts = addPragueDays(targetDateParts, -safeLookbackDays);
  const lookbackStartUtc = getPragueMidnightUtc(lookbackStartParts);

  const searchWindowStartSeconds = Math.floor(lookbackStartUtc.getTime() / 1000);
  const searchWindowEndSeconds = Math.floor(nextDayUtc.getTime() / 1000);
  const timeWindowClause = `after:${searchWindowStartSeconds} before:${searchWindowEndSeconds}`;

  const calendarApi = resolveCalendarService();
  const gmail = resolveGmailService();

  const eventsResponse = await calendarApi.listCalendarEvents(microsoftId, {
    calendarId: safeCalendarId,
    timeMin: dayStartUtc.toISOString(),
    timeMax: nextDayUtc.toISOString(),
    maxResults: MAX_MEETING_BRIEFING_EVENTS
  });

  const calendarEvents = Array.isArray(eventsResponse?.items) ? eventsResponse.items : [];
  const metadataCache = new Map();
  const accumulatedWarnings = [];
  let subsetDetected = false;

  const events = [];

  for (const event of calendarEvents) {
    const processed = await buildMeetingBriefingEntry({
      event,
      gmail,
      microsoftId,
      timeWindowClause,
      keywordHints,
      metadataCache,
      accumulatedWarnings
    });

    if (!processed) {
      continue;
    }

    events.push(processed.entry);

    if (processed.subset) {
      subsetDetected = true;
    }
  }

  return {
    date: formatDateParts(targetDateParts),
    lookbackDays: safeLookbackDays,
    calendarId: safeCalendarId,
    globalKeywordHintsUsed: keywordHints,
    events,
    subset: subsetDetected,
    warnings: dedupeWarnings(accumulatedWarnings)
  };
}

function normalizeBriefingDateParts(dateValue) {
  if (dateValue === undefined || dateValue === null || dateValue === '') {
    return getPragueDateParts(new Date());
  }

  if (typeof dateValue !== 'string') {
    throwFacadeValidationError('date must be a string in YYYY-MM-DD format.', {
      details: { field: 'date', receivedType: typeof dateValue }
    });
  }

  const trimmed = dateValue.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throwFacadeValidationError('date must use YYYY-MM-DD format.', {
      details: { field: 'date', value: trimmed }
    });
  }

  const [yearStr, monthStr, dayStr] = trimmed.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throwFacadeValidationError('date must represent a valid calendar day.', {
      details: { field: 'date', value: trimmed }
    });
  }

  const utcCandidate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcCandidate.getUTCFullYear() !== year ||
    utcCandidate.getUTCMonth() + 1 !== month ||
    utcCandidate.getUTCDate() !== day
  ) {
    throwFacadeValidationError('date must represent a valid calendar day.', {
      details: { field: 'date', value: trimmed }
    });
  }

  return { year, month, day };
}

function normalizeBriefingLookback(value) {
  if (value === undefined || value === null || value === '') {
    return 14;
  }

  const parsed = Number(value);
  const asInteger = Number.isFinite(parsed) ? Math.floor(parsed) : NaN;

  if (!Number.isFinite(asInteger) || asInteger < 1 || asInteger > 30) {
    throwFacadeValidationError('lookbackDays must be an integer between 1 and 30.', {
      details: { field: 'lookbackDays', value }
    });
  }

  return asInteger;
}

function normalizeBriefingCalendarId(calendarId) {
  if (calendarId === undefined || calendarId === null) {
    return 'primary';
  }

  const cleaned = cleanValue(calendarId);
  return cleaned || 'primary';
}

function normalizeBriefingKeywordHints(hints) {
  if (hints === undefined || hints === null) {
    return [];
  }

  if (!Array.isArray(hints)) {
    throwFacadeValidationError('globalKeywordHints must be an array of strings.', {
      details: { field: 'globalKeywordHints' }
    });
  }

  if (hints.length > 10) {
    throwFacadeValidationError('globalKeywordHints may include at most 10 entries.', {
      details: { field: 'globalKeywordHints', count: hints.length }
    });
  }

  const normalized = [];
  const seen = new Set();

  for (const hint of hints) {
    if (typeof hint !== 'string') {
      throwFacadeValidationError('globalKeywordHints entries must be strings.', {
        details: { field: 'globalKeywordHints', invalidEntry: hint }
      });
    }

    const trimmed = hint.trim();
    if (trimmed.length === 0) {
      throwFacadeValidationError('globalKeywordHints entries must not be empty.', {
        details: { field: 'globalKeywordHints' }
      });
    }

    if (trimmed.length > 80) {
      throwFacadeValidationError('globalKeywordHints entries must be 80 characters or fewer.', {
        details: { field: 'globalKeywordHints', length: trimmed.length }
      });
    }

    const signature = trimmed.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    normalized.push(trimmed);
  }

  return normalized;
}

function formatDateParts(parts) {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function buildMeetingBriefingEntry({ event, gmail, microsoftId, timeWindowClause, keywordHints, metadataCache, accumulatedWarnings }) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const attendees = extractBriefingAttendees(event);
  const autoKeywords = deriveBriefingAutoKeywords(event);
  const eventWarnings = [];
  let subset = false;

  const entry = {
    eventId: event.id || null,
    title: cleanValue(event.summary) || '(No title)',
    start: resolveBriefingEventInstant(event.start),
    end: resolveBriefingEventInstant(event.end),
    attendeesUsed: attendees,
    keywordSources: {
      auto: autoKeywords,
      hints: keywordHints
    },
    searches: [],
    relevantEmails: [],
    possibleMatches: [],
    notes: null
  };

  if (!entry.start && event?.start?.date) {
    entry.start = `${event.start.date}T00:00:00.000Z`;
  }

  if (!entry.end && event?.end?.date) {
    entry.end = `${event.end.date}T00:00:00.000Z`;
  }

  const descriptorCandidates = [];
  for (const email of attendees) {
    descriptorCandidates.push({ type: 'attendee', key: email });
  }
  for (const keyword of autoKeywords) {
    descriptorCandidates.push({ type: 'keyword', key: keyword });
  }
  for (const hint of keywordHints) {
    descriptorCandidates.push({ type: 'hint', key: hint });
  }

  if (attendees.length === 0) {
    entry.notes = 'No attendee email addresses found; relying on keyword searches.';
  }

  if (descriptorCandidates.length === 0) {
    entry.notes = entry.notes
      ? `${entry.notes} No keywords or hints available for Gmail searches.`
      : 'No attendees or keyword hints available; Gmail search skipped.';
    return { entry, subset: false, warnings: eventWarnings };
  }

  const descriptorSet = new Set();
  const normalizedAttendees = new Set(attendees.map(email => email.toLowerCase()));
  const messageSummaries = new Map();

  for (const descriptor of descriptorCandidates) {
    if (entry.searches.length >= MAX_MEETING_BRIEFING_SEARCH_VARIANTS) {
      subset = true;
      break;
    }

    const signature = `${descriptor.type}:${descriptor.key.toLowerCase()}`;
    if (descriptorSet.has(signature)) {
      continue;
    }
    descriptorSet.add(signature);

    const query = buildBriefingGmailQuery(timeWindowClause, descriptor);

    try {
      const searchResult = await gmail.searchEmails(microsoftId, {
        query,
        maxResults: MAX_MEETING_BRIEFING_SEARCH_RESULTS
      });

      const matchedCount = normalizeBriefingSearchCount(searchResult);
      entry.searches.push({
        type: descriptor.type,
        query,
        matchedCount
      });

      if (
        matchedCount > MAX_MEETING_BRIEFING_SEARCH_RESULTS ||
        Boolean(searchResult?.nextPageToken)
      ) {
        subset = true;
      }

      const messages = Array.isArray(searchResult?.messages) ? searchResult.messages : [];
      for (const messageRef of messages) {
        if (!messageRef?.id) {
          continue;
        }

        const metadata = await fetchBriefingMessageMetadata({
          gmail,
          microsoftId,
          messageId: messageRef.id,
          cache: metadataCache,
          warnings: eventWarnings
        });

        if (!metadata) {
          continue;
        }

        const normalizedFrom = (metadata.fromEmail || '').toLowerCase();
        const reasonDetails = determineBriefingReason({
          descriptor,
          normalizedFrom,
          normalizedAttendees
        });

        recordBriefingMessage(messageSummaries, metadata, reasonDetails);
      }
    } catch (error) {
      eventWarnings.push(`Gmail search failed for ${descriptor.type} "${descriptor.key}": ${error.message}`);
    }
  }

  const finalized = finalizeBriefingMessages(messageSummaries);
  entry.relevantEmails = finalized.relevant;
  entry.possibleMatches = finalized.possible;

  if (!entry.notes && finalized.relevant.length === 0 && finalized.possible.length === 0) {
    entry.notes = 'No related emails found within the requested lookback window.';
  }

  accumulatedWarnings.push(...eventWarnings);

  return { entry, subset, warnings: eventWarnings };
}

function extractBriefingAttendees(event) {
  const attendees = [];
  const seen = new Set();

  const register = (candidate) => {
    const value = cleanValue(candidate);
    if (!value || !value.includes('@')) {
      return;
    }

    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    attendees.push(value);
  };

  if (Array.isArray(event?.attendees)) {
    for (const attendee of event.attendees) {
      register(attendee?.email || attendee?.address);
    }
  }

  if (event?.organizer?.email) {
    register(event.organizer.email);
  }

  if (event?.creator?.email) {
    register(event.creator.email);
  }

  return attendees.slice(0, 15);
}

function deriveBriefingAutoKeywords(event) {
  const keywords = [];

  const append = (value) => {
    const sanitized = sanitizeBriefingKeywordCandidate(value);
    if (!sanitized) {
      return;
    }

    const normalized = sanitized.toLowerCase();
    if (keywords.some(existing => existing.toLowerCase() === normalized)) {
      return;
    }

    keywords.push(sanitized);
  };

  append(event?.summary);
  append(event?.location);

  if (typeof event?.description === 'string') {
    const lines = event.description
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      append(line);
      if (keywords.length >= MAX_MEETING_BRIEFING_AUTO_KEYWORDS) {
        break;
      }
    }
  }

  return keywords.slice(0, MAX_MEETING_BRIEFING_AUTO_KEYWORDS);
}

function sanitizeBriefingKeywordCandidate(value) {
  const trimmed = cleanValue(value);
  if (!trimmed) {
    return null;
  }

  const collapsed = trimmed.replace(/\s+/g, ' ');
  if (collapsed.length < 3) {
    return null;
  }

  if (collapsed.length > 80) {
    return collapsed.slice(0, 80).trim();
  }

  return collapsed;
}

function resolveBriefingEventInstant(edge) {
  if (!edge) {
    return null;
  }

  if (edge.dateTime) {
    return edge.dateTime;
  }

  if (edge.date) {
    try {
      const parts = normalizeBriefingDateParts(edge.date);
      return getPragueMidnightUtc(parts).toISOString();
    } catch (error) {
      return `${edge.date}T00:00:00.000Z`;
    }
  }

  return null;
}

function buildBriefingGmailQuery(timeWindowClause, descriptor) {
  const parts = [timeWindowClause];

  if (descriptor.type === 'attendee') {
    parts.push(`from:${descriptor.key}`);
  } else {
    const sanitized = descriptor.key.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sanitized) {
      return timeWindowClause;
    }

    const quoted = `"${sanitized}"`;
    if (descriptor.type === 'keyword') {
      parts.push(`(${quoted} OR subject:${quoted})`);
    } else {
      parts.push(quoted);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function normalizeBriefingSearchCount(result) {
  if (Number.isFinite(result?.resultSizeEstimate)) {
    return result.resultSizeEstimate;
  }

  if (Array.isArray(result?.messages)) {
    return result.messages.length;
  }

  return 0;
}

async function fetchBriefingMessageMetadata({ gmail, microsoftId, messageId, cache, warnings }) {
  if (cache.has(messageId)) {
    return cache.get(messageId);
  }

  try {
    const metadata = await gmail.readEmail(microsoftId, messageId, { format: 'metadata' });
    cache.set(messageId, metadata);
    return metadata;
  } catch (error) {
    warnings.push(`Failed to load Gmail message ${messageId}: ${error.message}`);
    cache.set(messageId, null);
    return null;
  }
}

function determineBriefingReason({ descriptor, normalizedFrom, normalizedAttendees }) {
  if (descriptor.type === 'attendee') {
    return {
      bucket: 'relevant',
      reason: `attendeeMatch:${descriptor.key}`
    };
  }

  if (normalizedAttendees.has(normalizedFrom)) {
    const prefix = descriptor.type === 'hint' ? 'hintKeyword+attendee' : 'keyword+attendee';
    return {
      bucket: 'relevant',
      reason: `${prefix}:${descriptor.key}`
    };
  }

  const prefix = descriptor.type === 'hint' ? 'hintKeyword' : 'keyword';
  return {
    bucket: 'possible',
    reason: `${prefix}:${descriptor.key}`
  };
}

function recordBriefingMessage(messageSummaries, metadata, { bucket, reason }) {
  if (!metadata?.id) {
    return;
  }

  const existing = messageSummaries.get(metadata.id) || {
    metadata,
    reasons: [],
    bucket: 'possible'
  };

  if (!existing.metadata && metadata) {
    existing.metadata = metadata;
  }

  existing.reasons.push(reason);

  if (bucket === 'relevant') {
    existing.bucket = 'relevant';
  }

  messageSummaries.set(metadata.id, existing);
}

function finalizeBriefingMessages(messageSummaries) {
  const relevant = [];
  const possible = [];

  for (const summary of messageSummaries.values()) {
    if (!summary?.metadata) {
      continue;
    }

    const payload = buildBriefingEmailEntry(summary.metadata, summary.reasons);
    if (summary.bucket === 'relevant') {
      relevant.push(payload);
    } else {
      possible.push(payload);
    }
  }

  const sorter = (a, b) => {
    const aTime = a.sentAt ? Date.parse(a.sentAt) : 0;
    const bTime = b.sentAt ? Date.parse(b.sentAt) : 0;
    return bTime - aTime;
  };

  relevant.sort(sorter);
  possible.sort(sorter);

  return { relevant, possible };
}

function buildBriefingEmailEntry(metadata, reasons = []) {
  const reasonText = reasons.filter(Boolean).join('; ') || null;
  const fromName = cleanValue(metadata?.fromName) || null;
  const fromEmail = cleanValue(metadata?.fromEmail || metadata?.from) || null;
  const links = metadata?.links || { thread: null, message: null };

  return {
    threadId: metadata?.threadId || null,
    messageId: metadata?.id || null,
    sentAt: metadata?.date || null,
    from: {
      name: fromName || null,
      email: fromEmail || null
    },
    subject: metadata?.subject || '(No subject)',
    reason: reasonText,
    links
  };
}

function dedupeWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const warning of warnings) {
    const cleaned = cleanValue(warning);
    if (!cleaned) {
      continue;
    }

    const signature = cleaned.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    result.push(cleaned);
  }

  return result;
}

// ==================== CALENDAR MACROS ====================

/**
 * Calendar Plan - daily/weekly view with status
 */
async function calendarPlan(microsoftId, params) {
  const {
    scope,
    date,
    includePast = false,
    pastTreatment = 'minimal',
    calendarId = 'primary'
  } = params;
  
  // Validate scope parameter
  const validScopes = ['daily', 'weekly'];
  if (!validScopes.includes(scope)) {
    throwFacadeValidationError(`Invalid scope: ${scope}. Must be one of: ${validScopes.join(', ')}`, {
      details: { field: 'scope', allowed: validScopes, received: scope }
    });
  }
  
  // Parse date and calculate range using Prague timezone
  const anchorDate = new Date(date);
  const pragueDate = getPragueDateParts(anchorDate);
  let start, end;

  if (scope === 'daily') {
    start = getPragueMidnightUtc(pragueDate);
    end = getPragueMidnightUtc(addPragueDays(pragueDate, 1));
  } else if (scope === 'weekly') {
    const dayOfWeek = new Date(pragueDate.year, pragueDate.month - 1, pragueDate.day).getDay();
    const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

    const monday = addPragueDays(pragueDate, daysToMonday);
    start = getPragueMidnightUtc(monday);
    end = getPragueMidnightUtc(addPragueDays(monday, 7));
  }
  
  // Fetch events
  const calendarApi = resolveCalendarService();

  const events = await calendarApi.listCalendarEvents(microsoftId, {
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    orderBy: 'startTime',
    singleEvents: true
  });
  
  // Compute status for each event
  const now = new Date();
  const items = events.items.map(event => {
    const eventStart = new Date(event.start.dateTime || event.start.date);
    const eventEnd = new Date(event.end.dateTime || event.end.date);
    
    let status;
    if (now > eventEnd) {
      status = 'past';
    } else if (now >= eventStart && now <= eventEnd) {
      status = 'ongoing';
    } else {
      status = 'upcoming';
    }
    
    // Filter based on pastTreatment
    if (status === 'past' && !includePast) {
      return null;
    }
    
    const item = {
      eventId: event.id,
      title: event.summary || '(No title)',
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      status,
      locationText: event.location || null,
      mapUrl: event.location ? generateMapsUrl(event.location) : null,
      attendees: (event.attendees || []).map(a => ({
        name: a.displayName || null,
        email: a.email
      }))
    };
    
    // Minimal treatment for past events
    if (status === 'past' && pastTreatment === 'minimal') {
      return {
        eventId: item.eventId,
        title: item.title,
        start: item.start,
        end: item.end,
        status: item.status
      };
    }
    
    return item;
  }).filter(Boolean);
  
  return {
    range: {
      start: start.toISOString(),
      end: end.toISOString(),
      tz: 'Europe/Prague'
    },
    items
  };
}

async function calendarListCalendars(microsoftId) {
  const calendars = await calendarService.listCalendars(microsoftId);
  return calendars;
}

/**
 * Calendar Schedule - create event with optional contact enrichment
 * 
 * WORKFLOW FOR enrichFromContacts='ask':
 * 1. Check if contact exists for first attendee
 * 2. If found → return confirmToken + suggested fields
 * 3. User confirms with /api/macros/confirm endpoint
 * 4. Complete operation with enriched data
 */
async function calendarSchedule(microsoftId, params) {
  const {
    title,
    when,
    attendees = [],
    enrichFromContacts = 'ask',
    conference = 'none',
    location,
    notes,
    reminders = [],
    privacy = 'default',
    calendarId = 'primary'
  } = params;

  const calendarApi = resolveCalendarService();
  const contactsApi = resolveContactsService();
  const createPendingConfirmationFn = resolveCreatePendingConfirmation();

  // Validate attendees parameter
  if (attendees && attendees.length > 20) {
    throwFacadeValidationError('Too many attendees. Maximum 20 allowed.', {
      details: { field: 'attendees', count: attendees.length }
    });
  }

  // Validate reminders parameter
  if (reminders && reminders.length > 0) {
    if (reminders.length > 5) {
      throwFacadeValidationError('Too many reminders. Maximum 5 allowed.', {
        details: { field: 'reminders', count: reminders.length }
      });
    }

    for (const reminder of reminders) {
      const value = parseInt(reminder);
      if (isNaN(value) || value < 1 || value > 1440) {
        throwFacadeValidationError(`Invalid reminder value: ${reminder}. Must be between 1-1440 minutes.`, {
          details: { field: 'reminders', value: reminder }
        });
      }
    }
  }

  // ========== STEP 0: Handle proposals with conflict checking ==========
  
  let timeSlot;
  let availableProposals = [];
  
  if (when.fixed) {
    timeSlot = when.fixed;
  } else if (when.proposals && when.proposals.length > 0) {
    // Check each proposal for conflicts
    const conflictResults = await Promise.all(
      when.proposals.map(async (proposal) => {
        try {
          const conflicts = await calendarApi.checkConflicts(microsoftId, {
            calendarId,
            start: proposal.start,
            end: proposal.end
          });
          
          return {
            proposal,
            hasConflicts: conflicts.length > 0,
            conflicts: conflicts
          };
        } catch (error) {
          console.warn('Error checking conflicts for proposal:', error.message);
          return {
            proposal,
            hasConflicts: false,
            conflicts: []
          };
        }
      })
    );
    
    // Get proposals without conflicts
    availableProposals = conflictResults
      .filter(r => !r.hasConflicts)
      .map(r => r.proposal);
    
    // If all proposals have conflicts, return 409 with alternatives
    if (availableProposals.length === 0) {
      const alternatives = conflictResults.map(r => ({
        proposal: r.proposal,
        conflicts: r.conflicts || []
      }));

      const conflictError = createServiceError('All proposed times conflict with existing events', {
        name: FACADE_VALIDATION_ERROR,
        statusCode: 409,
        code: 'CALENDAR_PROPOSALS_CONFLICT',
        details: { alternatives }
      });

      conflictError.alternatives = alternatives;
      throw conflictError;
    }

    // Use first available proposal
    timeSlot = availableProposals[0];
  } else {
    throwFacadeValidationError('Invalid when: must provide fixed or proposals', {
      details: { field: 'when' }
    });
  }

  // ========== STEP 1: Check for enrichment opportunities ==========
  
  let enrichmentSuggestions = null;
  let confirmToken = null;
  let pendingSuggestedFields = null;

  if (enrichFromContacts !== 'off' && attendees.length > 0) {
    // Get first attendee (primary contact to enrich from)
    const primaryAttendee = attendees[0];

    try {
      // Search for contact in Google Contacts
      const contactsResult = await contactsApi.searchContacts(
        microsoftId,
        primaryAttendee.email
      );

      if (contactsResult && contactsResult.connections && contactsResult.connections.length > 0) {
        const contact = contactsResult.connections[0];
        
        // Extract enrichable fields
        enrichmentSuggestions = extractContactFields(contact);

        // ========== STEP 2: Handle enrichFromContacts strategy ==========

        if (enrichFromContacts === 'ask') {
          // Create pending confirmation
          const suggestedFieldsSnapshot = { ...enrichmentSuggestions };

          const confirmation = await createPendingConfirmationFn(
            microsoftId,
            'enrichment',
            {
              operation: 'calendar.schedule',
              eventData: {
                title,
                when: timeSlot,
                attendees,
                conference,
                location,
                notes,
                reminders,
                privacy,
                calendarId
              },
              contactId: contact.resourceName,
              suggestedFields: suggestedFieldsSnapshot
            }
          );

          confirmToken = confirmation.confirmToken;
          pendingSuggestedFields = suggestedFieldsSnapshot;
          enrichmentSuggestions = null; // Don't use yet, wait for confirmation
        }
        // If enrichFromContacts='auto', enrichmentSuggestions will be used below
      }
    } catch (error) {
      console.warn(
        `❌ Contact enrichment search failed for ${primaryAttendee.email}:`,
        error.message
      );
      // Silently fail - continue without enrichment
      enrichmentSuggestions = null;
    }
  }

  // ========== STEP 3: If confirmToken needed, return early ==========

  if (confirmToken) {
    return {
      event: null, // Don't create event yet
      confirmToken,
      warnings: [
        `Found contact for ${attendees[0].email}`,
        pendingSuggestedFields
          ? 'Suggested enrichment: ' + Object.keys(pendingSuggestedFields).join(', ')
          : 'Suggested enrichment data is ready',
        'Call /api/macros/confirm with confirmToken to proceed'
      ]
    };
  }

  // ========== STEP 4: Create event (with or without enrichment) ==========

  const slotTimeZone = typeof timeSlot.timeZone === 'string' && timeSlot.timeZone.trim()
    ? timeSlot.timeZone.trim()
    : REFERENCE_TIMEZONE;

  let normalizedStart;
  let normalizedEnd;

  try {
    normalizedStart = normalizeCalendarTime(timeSlot.start, slotTimeZone);
    normalizedEnd = normalizeCalendarTime(timeSlot.end, slotTimeZone);
  } catch (error) {
    throwFacadeValidationError('Invalid time slot provided', {
      details: { field: 'when', timeZone: slotTimeZone },
      cause: error
    });
  }

  if (!normalizedStart || !normalizedEnd) {
    throwFacadeValidationError('Invalid time slot provided', {
      details: { field: 'when', timeZone: slotTimeZone }
    });
  }

  const eventData = {
    summary: title,
    start: normalizedStart,
    end: normalizedEnd,
    attendees: attendees.map(a => {
      const attendeeObj = { email: a.email };
      if (a.name) attendeeObj.displayName = a.name;
      return attendeeObj;
    }),
    location: location || undefined,
    description: notes || undefined,
    reminders: {
      useDefault: reminders.length === 0,
      overrides:
        reminders.length > 0
          ? reminders.map(r => ({
              method: 'popup',
              minutes: parseInt(r)
            }))
          : undefined
    }
  };

  // Add enriched fields if available (auto mode)
  if (enrichmentSuggestions) {
    if (enrichmentSuggestions.phone && !eventData.description) {
      eventData.description = `Phone: ${enrichmentSuggestions.phone}`;
    } else if (enrichmentSuggestions.phone) {
      eventData.description += `\nPhone: ${enrichmentSuggestions.phone}`;
    }
  }

  // Add conference if requested
  if (conference === 'meet') {
    eventData.conferenceData = {
      createRequest: {
        requestId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    };
  } else if (conference === 'zoom') {
    // Zoom requires external integration - add as location instead
    if (!eventData.location) {
      eventData.location = 'Zoom Meeting (link to be added manually)';
    }
    if (!eventData.description) {
      eventData.description = 'Zoom meeting link will be added by organizer.';
    } else {
      eventData.description += '\n\nZoom meeting link will be added by organizer.';
    }
  }

  // Create event in calendar
  const event = await calendarApi.createCalendarEvent(microsoftId, eventData, {
    calendarId,
    conferenceDataVersion: conference === 'meet' ? 1 : 0
  });

  return {
    event: {
      eventId: event.id,
      title: event.summary,
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      htmlLink: event.htmlLink || null,
      status: 'upcoming',
      locationText: event.location || null,
      mapUrl: event.location ? generateMapsUrl(event.location) : null,
      attendees: (event.attendees || []).map(a => ({
        name: a.displayName || null,
        email: a.email
      }))
    },
    confirmToken: null,
    warnings: enrichmentSuggestions
      ? ['Event created with auto-filled contact details']
      : []
  };
}

/**
 * Complete enriched calendar schedule (after user confirms via confirmToken)
 */
async function completeCalendarScheduleEnrichment(
  microsoftId,
  confirmToken,
  action
) {
  const confirmation = await getPendingConfirmation(confirmToken);

  if (!confirmation) {
    throw { statusCode: 400, message: 'Confirmation expired or not found' };
  }

  if (confirmation.type !== 'enrichment') {
    throwFacadeValidationError('Invalid confirmation type', {
      code: 'CONFIRMATION_TYPE_INVALID',
      details: { expected: 'enrichment', actual: confirmation.type }
    });
  }

  await confirmPendingConfirmation(confirmToken, action);

  const { eventData, suggestedFields } = confirmation.data;

  // Rebuild event with enrichment
  let updatedEventData = { ...eventData };

  if (action === 'auto-fill' && suggestedFields) {
    let description = eventData.notes || '';

    if (suggestedFields.phone) {
      description += `\n📞 Phone: ${suggestedFields.phone}`;
    }
    if (suggestedFields.address) {
      description += `\n📍 Address: ${suggestedFields.address}`;
    }

    updatedEventData = {
      ...updatedEventData,
      description: description.trim()
    };
  }

  // Create event
  const confirmTimeZone = typeof updatedEventData.when?.timeZone === 'string'
    && updatedEventData.when.timeZone.trim().length > 0
      ? updatedEventData.when.timeZone.trim()
      : REFERENCE_TIMEZONE;

  let normalizedStart;
  let normalizedEnd;

  try {
    normalizedStart = normalizeCalendarTime(updatedEventData.when.start, confirmTimeZone);
    normalizedEnd = normalizeCalendarTime(updatedEventData.when.end, confirmTimeZone);
  } catch (error) {
    throwFacadeValidationError('Invalid time slot provided', {
      details: { field: 'when', timeZone: confirmTimeZone },
      cause: error
    });
  }

  if (!normalizedStart || !normalizedEnd) {
    throwFacadeValidationError('Invalid time slot provided', {
      details: { field: 'when', timeZone: confirmTimeZone }
    });
  }

  const event = await calendarService.createCalendarEvent(microsoftId, {
    summary: updatedEventData.title,
    start: normalizedStart,
    end: normalizedEnd,
    attendees: (updatedEventData.attendees || []).map(a => ({
      email: a.email,
      displayName: a.name
    })),
    location: updatedEventData.location,
    description: updatedEventData.description,
    reminders: {
      useDefault: (updatedEventData.reminders || []).length === 0,
      overrides:
        (updatedEventData.reminders || []).length > 0
          ? updatedEventData.reminders.map(r => ({
              method: 'popup',
              minutes: parseInt(r)
            }))
          : undefined
    }
  }, {
    calendarId: updatedEventData.calendarId || 'primary',
    conferenceDataVersion: updatedEventData.conference === 'meet' ? 1 : 0
  });

  await completePendingConfirmation(confirmToken);

  return {
    event: {
      eventId: event.id,
      title: event.summary,
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      htmlLink: event.htmlLink || null,
      status: 'upcoming',
      attendees: (event.attendees || []).map(a => ({
        name: a.displayName || null,
        email: a.email
      }))
    }
  };
}

// ==================== CONTACTS MACROS ====================

/**
 * Safe Add Contacts - with deduplication detection
 * 
 * WORKFLOW:
 * 1. Get all existing contacts from Google Contacts Sheet
 * 2. For each new entry, check for duplicates by email/name/phone
 * 3. If duplicates found AND dedupeStrategy='ask' → return confirmToken for user decision
 * 4. Otherwise → add according to strategy (keepBoth/skip/merge)
 * 
 * dedupeStrategy options:
 * - 'ask' (default): Return duplicates for user confirmation
 * - 'keepBoth': Always add (may create duplicates)
 * - 'skip': Skip entries with duplicates
 * - 'merge': Auto-merge into existing contacts (>70% match)
 */
async function contactsSafeAdd(microsoftId, params) {
  const { entries, dedupeStrategy = 'ask' } = params;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throwFacadeValidationError('entries parameter required: array of {name, email, phone?, notes?, realestate?}', {
      details: { field: 'entries' }
    });
  }

  const normalizedStrategy = normalizeDedupeStrategy(dedupeStrategy);

  // ========== STEP 1: Get all existing contacts from Sheet ==========

  let existingContacts = [];
  try {
    const result = await contactsService.listAllContacts(microsoftId);
    existingContacts = result?.contacts || [];
  } catch (error) {
    console.warn('⚠️ Failed to list existing contacts:', error.message);
    existingContacts = [];
  }

  // ========== STEP 2: Find duplicates for each entry ==========

  const duplicateFindings = [];

  for (const entry of entries) {
    const entryEmail = (entry.email || '').toLowerCase().trim();
    const entryName = (entry.name || '').toLowerCase().trim();
    const entryPhone = (entry.phone || '').replace(/\D/g, '');

    // Find duplicates in existing contacts
    const candidates = existingContacts.filter(contact => {
      const contactEmail = (contact.email || '').toLowerCase().trim();
      const contactName = (contact.name || '').toLowerCase().trim();
      const contactPhone = (contact.phone || '').replace(/\D/g, '');

      // Match by email (highest confidence)
      if (entryEmail && contactEmail && entryEmail === contactEmail) {
        return true;
      }

      // Match by phone (high confidence)
      if (entryPhone && contactPhone && entryPhone === contactPhone && entryPhone.length > 5) {
        return true;
      }

      // Match by name (lower confidence)
      if (entryName && contactName && entryName === contactName) {
        return true;
      }

      // Partial name match (first + last name in common)
      if (entryName && contactName) {
        const entryParts = entryName.split(/\s+/).filter(p => p.length > 2);
        const contactParts = contactName.split(/\s+/).filter(p => p.length > 2);
        const commonParts = entryParts.filter(p => contactParts.includes(p));
        if (commonParts.length > 0 && Math.max(entryParts.length, contactParts.length) > 1) {
          return true;
        }
      }

      return false;
    });

    duplicateFindings.push({
      entry,
      candidates: candidates.map(c => ({
        ...c,
        rowIndex: c.rowIndex
      }))
    });
  }

  // ========== STEP 3: Check if any duplicates found ==========

  const hasAnyDuplicates = duplicateFindings.some(f => f.candidates.length > 0);

  // ========== STEP 4: Handle dedupeStrategy ==========

  if (hasAnyDuplicates && normalizedStrategy === 'ask') {
    // Return pending confirmation for user to decide
    const confirmation = await createPendingConfirmation(
      microsoftId,
      'deduplication',
      {
        operation: 'contacts.safeAdd',
        entriesToAdd: entries,
        duplicateFindings
      }
    );

    return {
      created: [],
      merged: [],
      skipped: duplicateFindings
        .filter(f => f.candidates.length > 0)
        .map(f => ({
          email: f.entry.email,
          name: f.entry.name,
          reason: `Found ${f.candidates.length} existing contact(s)`,
          existing: f.candidates
        })),
      confirmToken: confirmation.confirmToken,
      warnings: [
        `Found potential duplicates for ${duplicateFindings.filter(f => f.candidates.length > 0).length}/${entries.length} contact(s)`,
        "Call /api/macros/confirm with confirmToken and action: 'keepBoth' (add all), 'skip' (skip duplicates), or 'merge' (merge)"
      ]
    };
  }

  // ========== STEP 5: Perform bulk operation based on strategy ==========

  return await performContactsBulkAdd(
    microsoftId,
    entries,
    duplicateFindings,
    normalizedStrategy
  );
}

/**
 * Complete deduplication workflow (after user confirms via confirmToken)
 */
async function completeContactsDeduplication(
  microsoftId,
  confirmToken,
  action // 'keepBoth', 'skip', or 'merge'
) {
  const confirmation = await getPendingConfirmation(confirmToken);

  if (!confirmation) {
    throwFacadeValidationError('Confirmation expired or not found', {
      code: 'CONFIRMATION_NOT_FOUND',
      details: { confirmToken }
    });
  }

  if (confirmation.type !== 'deduplication') {
    throwFacadeValidationError('Invalid confirmation type', {
      code: 'CONFIRMATION_TYPE_INVALID',
      details: { expected: 'deduplication', actual: confirmation.type }
    });
  }

  const { entriesToAdd, duplicateFindings } = confirmation.data;
  
  const result = await performContactsBulkAdd(
    microsoftId,
    entriesToAdd,
    duplicateFindings,
    normalizeDedupeStrategy(action)
  );

  await completePendingConfirmation(confirmToken);

  return result;
}

// ==================== TASKS MACROS ====================

/**
 * Tasks Overview - grouped by section
 */
async function tasksOverview(microsoftId, params) {
  const { scope, includeCompleted = false, project, labelIds = [] } = params;
  
  // Validate scope parameter
  const validScopes = ['daily', 'weekly'];
  if (!validScopes.includes(scope)) {
    throwFacadeValidationError(`Invalid scope: ${scope}. Must be one of: ${validScopes.join(', ')}`, {
      details: { field: 'scope', allowed: validScopes, received: scope }
    });
  }
  
  // Calculate date range based on scope
  const now = new Date();
  let start, end;
  
  if (scope === 'daily') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  } else if (scope === 'weekly') {
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start = new Date(now);
    start.setDate(start.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
  }
  
  // Fetch tasks
  const tasks = await tasksService.listTasks(microsoftId, {
    showCompleted: includeCompleted,
    dueMin: start.toISOString(),
    dueMax: end.toISOString()
  });
  
  // Group tasks by section
  const sections = {
    today: [],
    thisWeek: [],
    overdue: [],
    completed: []
  };
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  for (const task of tasks.items || []) {
    if (task.completed && includeCompleted) {
      sections.completed.push(task);
    } else if (task.due) {
      const due = new Date(task.due);
      if (due < today) {
        sections.overdue.push(task);
      } else if (due < start) {
        sections.today.push(task);
      } else {
        sections.thisWeek.push(task);
      }
    } else {
      sections.thisWeek.push(task);
    }
  }
  
  return { sections };
}

/**
 * Format ISO datetime range to human-readable Czech format
 * @param {string} startIso - Start time ISO 8601 string
 * @param {string} endIso - End time ISO 8601 string
 * @returns {string} Formatted time range like "15:00-16:00, 21.10.2025"
 */
function formatTimeRangeForEmail(startIso, endIso) {
  if (!startIso || !endIso) return '';
  try {
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);

    // Formátování času (HH:MM)
    const startTime = startDate.toLocaleString('cs-CZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Prague'
    });

    const endTime = endDate.toLocaleString('cs-CZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Prague'
    });

    // Formátování data (DD.MM YYYY)
    const dateStr = startDate.toLocaleString('cs-CZ', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Prague'
    });

    return `${startTime}-${endTime}, ${dateStr}`;
  } catch (e) {
    console.warn('Failed to format time range:', startIso, endIso, e.message);
    return `${startIso} - ${endIso}`;
  }
}

/**
 * Reminder Drafts - bulk email reminders for today's events
 * Hybrid approach: prepareOnly (default) returns data for GPT, or creates drafts directly
 */
async function calendarReminderDrafts(microsoftId, params) {
  const {
    window = 'today',
    hours,
    template,
    includeLocation = true,
    prepareOnly = true,
    calendarId = 'primary'
  } = params;

  // Validate window parameter
  const validWindows = ['today', 'nextHours'];
  if (!validWindows.includes(window)) {
    throwFacadeValidationError(`Invalid window: ${window}. Must be one of: ${validWindows.join(', ')}`, {
      details: { field: 'window', allowed: validWindows, received: window }
    });
  }

  // Validate hours parameter when window='nextHours'
  if (window === 'nextHours') {
    if (!hours || typeof hours !== 'number' || hours < 1 || hours > 24) {
      throwFacadeValidationError('hours parameter must be between 1-24 when window=nextHours', {
        details: { field: 'hours', value: hours }
      });
    }
  }

  // Calculate time window
  const now = new Date();
  let start, end;

  if (window === 'today') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  } else if (window === 'nextHours') {
    start = now;
    end = new Date(now.getTime() + (hours || 4) * 60 * 60 * 1000);
  }

  // Fetch upcoming events with attendees
  const events = await calendarService.listCalendarEvents(microsoftId, {
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    orderBy: 'startTime',
    singleEvents: true
  });

  const upcomingEvents = events.items.filter(e => {
    const eventStart = new Date(e.start.dateTime || e.start.date);
    return eventStart > now && e.attendees && e.attendees.length > 0;
  });

  // If prepareOnly mode, return structured data for GPT to process
  if (prepareOnly) {
    const preparedEvents = upcomingEvents.map(event => {
      const attendeesList = (event.attendees || []).filter(a => a && a.email);
      const timeRange = formatTimeRangeForEmail(
        event.start.dateTime || event.start.date,
        event.end.dateTime || event.end.date
      );

      return {
        eventId: event.id,
        summary: event.summary,
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        location: event.location || null,
        htmlLink: event.htmlLink || null,
        timeRangeFormatted: timeRange,
        attendees: attendeesList.map(a => ({
          email: a.email,
          displayName: a.displayName || null
        }))
      };
    });

    return {
      mode: 'prepareOnly',
      events: preparedEvents,
      count: preparedEvents.length,
      window,
      note: 'Use these prepared events to create personalized reminder drafts via /rpc/mail with op:createDraft'
    };
  }

  // Legacy mode: create drafts directly (without proper Czech grammar)
  const drafts = [];

  for (const event of upcomingEvents) {
    const attendeesList = (event.attendees || []).filter(a => a && a.email);
    if (attendeesList.length === 0) {
      continue;
    }

    const subject = `Reminder: ${event.summary}`;
    const locationText = includeLocation && event.location ? `\nMísto: ${event.location}` : '';
    const timeRange = formatTimeRangeForEmail(
      event.start.dateTime || event.start.date,
      event.end.dateTime || event.end.date
    );
    const eventLink = event.htmlLink ? `\nOdkaz na událost: ${event.htmlLink}` : '';

    // Create personalized email for each attendee
    for (const attendee of attendeesList) {
      const recipientLabel = attendee.displayName || attendee.email;
      const body = buildReminderBody({
        event,
        template,
        locationText,
        timeRange,
        eventLink,
        recipientLabel,
        isGroup: false
      });

      const draftId = await createReminderDraft(microsoftId, true, {
        to: attendee.email,
        subject,
        body,
        logLabel: attendee.email
      });

      drafts.push({
        draftId,
        to: attendee.email,
        subject,
        preview: body.substring(0, 200),
        eventId: event.id
      });
    }
  }

  return {
    mode: 'createDrafts',
    drafts,
    count: drafts.length,
    note: 'Drafts created but may have imperfect Czech grammar (no declension). Use prepareOnly:true for GPT-personalized drafts.'
  };
}

function buildReminderBody({
  event,
  template,
  recipientLabel,
  timeRange,
  locationText,
  eventLink,
  isGroup
}) {
  const safeSummary = event.summary || '';
  const greetingName = recipientLabel ? ` ${recipientLabel}` : '';
  const closing = isGroup ? 'Těšíme se!' : 'Těším se!';

  if (template) {
    return template
      .replace(/{title}/g, safeSummary)
      .replace(/{start}/g, event.start.dateTime || event.start.date || '')
      .replace(/{end}/g, event.end.dateTime || event.end.date || '')
      .replace(/{location}/g, event.location || '')
      .replace(/{recipientName}/g, recipientLabel || (isGroup ? 'všichni' : ''))
      .replace(/{timeRange}/g, timeRange || '')
      .replace(/{eventLink}/g, eventLink || '');
  }

  return `Ahoj${greetingName},\n\njen připomínám, že s tebou počítám na akci "${safeSummary}"\nČas: ${timeRange}${locationText}${eventLink}\n\n${closing}`;
}

async function createReminderDraft(microsoftId, shouldCreate, { to, subject, body, logLabel }) {
  if (!shouldCreate) {
    return null;
  }

  try {
    const draft = await gmailService.createDraft(microsoftId, {
      to,
      subject,
      body
    });

    if (!draft) {
      console.error(`❌ [DRAFT_VALIDATION] Draft object is null/undefined for ${logLabel}`);
      throwServiceError('Gmail API returned null draft', {
        name: 'DraftValidationError',
        statusCode: 502,
        code: 'GMAIL_DRAFT_INVALID',
        details: { logLabel }
      });
    }

    if (!draft.id) {
      console.error(`❌ [DRAFT_VALIDATION] Draft ID is missing for ${logLabel}`);
      console.error('Draft object keys:', Object.keys(draft));
      console.error('Full draft:', JSON.stringify(draft, null, 2));
      throwServiceError('Draft created but missing ID field', {
        name: 'DraftValidationError',
        statusCode: 502,
        code: 'GMAIL_DRAFT_INVALID',
        details: { logLabel }
      });
    }

    if (typeof draft.id !== 'string') {
      console.error(
        `⚠️ [DRAFT_VALIDATION] Draft ID type is ${typeof draft.id}, expected string: ${draft.id}`
      );
      throwServiceError(`Invalid draft ID type: ${typeof draft.id}`, {
        name: 'DraftValidationError',
        statusCode: 502,
        code: 'GMAIL_DRAFT_INVALID',
        details: { logLabel, type: typeof draft.id }
      });
    }

    console.log(`✅ [DRAFT_SUCCESS] Draft created with ID: ${draft.id} for ${logLabel}`);
    return draft.id;
  } catch (error) {
    console.error(`❌ [DRAFT_ERROR] Failed to create draft for ${logLabel}:`, error.message);
    if (error && error.stack) {
      console.error('Stack:', error.stack);
    }
    return null;
  }
}

// ==================== HELPER FUNCTIONS ====================

function decodePayloadData(data) {
  if (!data) return '';

  try {
    return Buffer.from(data, 'base64').toString('utf-8');
  } catch (error) {
    console.error('Failed to decode payload data:', error.message);
    return '';
  }
}

function stripHtmlTags(html = '') {
  return html
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeWhitespace(text = '') {
  return text.replace(/\s+/g, ' ').trim();
}

function extractBodyText(payload = {}, limit = Infinity) {
  if (!payload) return '';

  const queue = [payload];
  let plainText = '';
  let htmlText = '';

  while (queue.length > 0 && (plainText.length < limit || htmlText.length < limit)) {
    const part = queue.shift();

    if (part.body?.data) {
      const decoded = decodePayloadData(part.body.data);

      if (part.mimeType?.startsWith('text/plain')) {
        if (plainText.length < limit) {
          const remaining = limit - plainText.length;
          plainText += remaining >= decoded.length ? decoded : decoded.slice(0, remaining);
        }
      } else if (part.mimeType?.startsWith('text/html')) {
          if (htmlText.length < limit) {
            const remaining = limit - htmlText.length;
            htmlText += remaining >= decoded.length ? decoded : decoded.slice(0, remaining);
          }
      }
    }

    if (Array.isArray(part.parts)) {
      queue.push(...part.parts);
    }
  }

  const normalizedPlain = normalizeWhitespace(plainText);
  if (normalizedPlain) {
    return normalizedPlain;
  }

  if (htmlText) {
    const stripped = stripHtmlTags(htmlText);
    return normalizeWhitespace(stripped);
  }

  return '';
}

function buildBodySnippetFromPayload(payload, fallbackSnippet = '') {
  const MIN_LENGTH = 200;
  const MAX_LENGTH = 300;

  const text = extractBodyText(payload, MAX_LENGTH + 200);
  const source = text || normalizeWhitespace(fallbackSnippet);

  if (!source) {
    return '';
  }

  if (source.length <= MAX_LENGTH) {
    return source;
  }

  const candidate = source.slice(0, MAX_LENGTH + 1);

  let cutoff = candidate.lastIndexOf('. ');
  if (cutoff < MIN_LENGTH) {
    cutoff = candidate.lastIndexOf(' ');
  }
  if (cutoff < MIN_LENGTH) {
    cutoff = MAX_LENGTH;
  }

  const snippet = candidate.slice(0, cutoff).trim();
  return snippet.length ? `${snippet}…` : source.slice(0, MAX_LENGTH).trim();
}

function buildFallbackSnippet(snippet = '') {
  const normalized = normalizeWhitespace(snippet);
  if (!normalized) {
    return 'Náhled zprávy není k dispozici.';
  }

  if (normalized.length <= 200) {
    return normalized;
  }

  return `${normalized.slice(0, 200)}…`;
}

function categorizeEmail(message) {
  const labels = message.labelIds || [];

  if (labels.includes('CATEGORY_SOCIAL')) return 'social';
  if (labels.includes('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labels.includes('CATEGORY_UPDATES')) return 'updates';
  if (labels.includes('CATEGORY_FORUMS')) return 'forums';
  if (labels.includes('IMPORTANT')) return 'primary';
  if (labels.includes('INBOX')) return 'primary';

  return 'other';
}

function extractAttachmentMetadata(payload) {
  const attachments = [];
  
  function traverse(part) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size,
        body: { attachmentId: part.body.attachmentId }
      });
    }
    
    if (part.parts) {
      part.parts.forEach(traverse);
    }
  }
  
  traverse(payload);
  return attachments;
}

function enrichEmailWithAttachments(message, messageId) {
  const base = {
    messageId,
    senderName: extractSenderName(message.from),
    senderAddress: extractEmail(message.from),
    subject: message.subject || '(no subject)',
    receivedAt: message.internalDate ? new Date(parseInt(message.internalDate)).toISOString() : null,
    inboxCategory: classifyEmailCategory(message),
    label: message.labelIds?.[0] || null,
    readState: buildReadStateFromLabels(message.labelIds),
    headers: {},
    body: message.snippet || message.body || null,
    truncated: Boolean(message.truncated),
    links: message.links || (message.threadId ? buildGmailLinks(message.threadId, messageId) : null)
  };

  // Process attachments
  if (message.payload?.parts) {
    const rawAttachments = extractAttachmentMetadata(message.payload);
    const processed = processAttachments(rawAttachments, (att) =>
      generateSignedAttachmentUrl(messageId, att.body?.attachmentId)
    );
    base.attachments = processed.attachments;
  } else {
    base.attachments = [];
  }

  if (message.contentMetadata) {
    base.contentMetadata = message.contentMetadata;
  }

  if (message.truncationInfo) {
    base.truncationInfo = message.truncationInfo;
  }

  return base;
}

function createEmptyUnansweredBucket() {
  return {
    items: [],
    subset: false,
    nextPageToken: null,
    scanned: 0,
    overflowCount: 0,
    skippedReasons: {}
  };
}

const TRACKED_WATCHLIST_SKIP_REASONS = new Set(['userReplyPresent', 'trackingLabelPresent']);

function buildTimeFilterClauses(timeRange) {
  if (!timeRange) {
    return {};
  }

  if (typeof timeRange.relative === 'string' && timeRange.relative.trim().length > 0) {
    const parsed = parseRelativeTime(timeRange.relative.trim());
    return parsed || {};
  }

  const result = {};
  if (timeRange.start) {
    const startDate = new Date(timeRange.start);
    if (!Number.isNaN(startDate.getTime())) {
      result.after = Math.floor(startDate.getTime() / 1000);
    }
  }
  if (timeRange.end) {
    const endDate = new Date(timeRange.end);
    if (!Number.isNaN(endDate.getTime())) {
      result.before = Math.floor(endDate.getTime() / 1000);
    }
  }
  return result;
}

function describeTimeFilters(filters = {}) {
  if (!filters || (!filters.after && !filters.before)) {
    return null;
  }

  const start = filters.after ? toPragueIso(filters.after * 1000) : null;
  const end = filters.before ? toPragueIso(filters.before * 1000) : null;

  return {
    start,
    end,
    timezone: REFERENCE_TIMEZONE
  };
}

async function collectUnansweredThreads({
  microsoftId,
  baseQuery,
  querySuffix,
  pageToken,
  limit,
  userAddresses,
  strictNoReply,
  labelMatch,
  trackingLabelMatch
}) {
  const combinedQuery = [baseQuery, querySuffix].filter(Boolean).join(' ').trim();
  const effectiveLimit = Math.max(1, Math.min(limit || 20, 100));

  const items = [];
  const seenThreads = new Set();
  const skippedReasons = {};

  let nextPageToken = pageToken || null;
  let currentToken = pageToken || undefined;
  let subset = false;
  let scanned = 0;
  let overflowCount = 0;
  let iterations = 0;

  const normalizedAddresses = new Set(
    (userAddresses || []).map(email => (typeof email === 'string' ? email.toLowerCase() : '')).filter(Boolean)
  );

  while (iterations < 5 && items.length < effectiveLimit) {
    iterations += 1;

    const searchResult = await gmailService.searchEmails(microsoftId, {
      query: combinedQuery || undefined,
      maxResults: Math.min(200, Math.max(effectiveLimit * 2, 20)),
      pageToken: currentToken
    });

    const messages = searchResult?.messages || [];
    scanned += messages.length;

    if (messages.length === 0) {
      nextPageToken = searchResult?.nextPageToken || null;
      subset = false;
      break;
    }

    for (const message of messages) {
      if (!message.threadId) {
        continue;
      }
      if (seenThreads.has(message.threadId)) {
        continue;
      }
      seenThreads.add(message.threadId);

      const thread = await gmailService.getThread(microsoftId, message.threadId);
      if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) {
        continue;
      }

      const evaluation = evaluateThreadForUnanswered(thread, {
        normalizedAddresses,
        strictNoReply,
        labelMatch,
        trackingLabelMatch
      });

      if (!evaluation.awaiting) {
        if (evaluation.reason && TRACKED_WATCHLIST_SKIP_REASONS.has(evaluation.reason)) {
          skippedReasons[evaluation.reason] = (skippedReasons[evaluation.reason] || 0) + 1;
        }
        continue;
      }

      if (items.length < effectiveLimit) {
        items.push(evaluation.item);
      } else {
        overflowCount += 1;
      }
    }

    if (items.length >= effectiveLimit) {
      subset = overflowCount > 0 || Boolean(searchResult.nextPageToken);
      nextPageToken = searchResult.nextPageToken || null;
      break;
    }

    if (!searchResult.nextPageToken) {
      nextPageToken = null;
      subset = overflowCount > 0;
      break;
    }

    currentToken = searchResult.nextPageToken;
    nextPageToken = searchResult.nextPageToken;
    subset = true;
  }

  if (!subset) {
    nextPageToken = null;
  }

  return {
    items,
    subset,
    nextPageToken,
    scanned,
    overflowCount,
    skippedReasons
  };
}

async function autoApplyWatchlistLabels({ microsoftId, gmail, targetLabel, trackingLabel, unreadBucket, readBucket }) {
  if (!targetLabel?.id || !gmail?.modifyMessageLabels) {
    return;
  }

  const processedIds = new Set();
  const buckets = [unreadBucket, readBucket].filter(Boolean);

  for (const bucket of buckets) {
    if (!bucket || !Array.isArray(bucket.items)) {
      continue;
    }

    for (const item of bucket.items) {
      if (!item || item.labelApplied) {
        continue;
      }

      const candidateIds = Array.isArray(item.candidateMessageIds) && item.candidateMessageIds.length > 0
        ? item.candidateMessageIds
        : (item.messageId ? [item.messageId] : []);

      const uniqueIds = candidateIds
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(value => value.length > 0 && !processedIds.has(value));

      if (uniqueIds.length === 0) {
        continue;
      }

      let applied = false;

      const addIds = [targetLabel.id];
      if (trackingLabel?.id && !addIds.includes(trackingLabel.id)) {
        addIds.push(trackingLabel.id);
      }

      for (const messageId of uniqueIds) {
        try {
          await gmail.modifyMessageLabels(microsoftId, messageId, {
            add: addIds,
            remove: []
          });
          processedIds.add(messageId);
          applied = true;
        } catch (modError) {
          console.warn(`⚠️ Unable to auto-apply watchlist label on message ${messageId}:`, modError.message);
        }
      }

      if (applied) {
        item.labelApplied = true;
        if (trackingLabel?.id) {
          item.trackingLabelApplied = true;
        }
        if (item.label) {
          item.label.alreadyApplied = true;
          item.label.suggestedId ||= targetLabel.id;
          item.label.suggestedName ||= targetLabel.name;
        } else {
          item.label = {
            suggestedId: targetLabel.id,
            suggestedName: targetLabel.name,
            alreadyApplied: true
          };
        }
      }
    }
  }
}

function evaluateThreadForUnanswered(thread, { normalizedAddresses, strictNoReply, labelMatch, trackingLabelMatch }) {
  const messages = Array.isArray(thread.messages) ? [...thread.messages] : [];
  messages.sort((a, b) => {
    const aTime = typeof a.internalDate === 'number' ? a.internalDate : (typeof a.internalDate === 'string' ? parseInt(a.internalDate, 10) : 0);
    const bTime = typeof b.internalDate === 'number' ? b.internalDate : (typeof b.internalDate === 'string' ? parseInt(b.internalDate, 10) : 0);
    return aTime - bTime;
  });

  if (messages.length === 0) {
    return { awaiting: false, reason: 'noMessages' };
  }

  const trackingLabelApplied = trackingLabelMatch
    ? (Array.isArray(thread.labelIds) && thread.labelIds.includes(trackingLabelMatch.id))
      || messages.some(msg => Array.isArray(msg.labelIds) && msg.labelIds.includes(trackingLabelMatch.id))
    : false;

  if (trackingLabelApplied) {
    return { awaiting: false, reason: 'trackingLabelPresent' };
  }

  const decorated = messages.map(msg => {
    const timestamp = typeof msg.internalDate === 'number'
      ? msg.internalDate
      : (typeof msg.internalDate === 'string' ? parseInt(msg.internalDate, 10) : null);
    const fromEmail = typeof msg.from?.email === 'string' ? msg.from.email.toLowerCase() : null;
    const isUser = fromEmail ? normalizedAddresses.has(fromEmail) : false;
    return {
      raw: msg,
      timestamp,
      isUser
    };
  });

  const lastEntry = decorated[decorated.length - 1];
  if (!lastEntry) {
    return { awaiting: false, reason: 'noMessages' };
  }

  if (lastEntry.isUser) {
    return { awaiting: false, reason: 'lastMessageFromUser' };
  }

  const incomingEntries = decorated.filter(entry => !entry.isUser);
  if (incomingEntries.length === 0) {
    return { awaiting: false, reason: 'noIncomingMessages' };
  }

  const lastIncoming = incomingEntries[incomingEntries.length - 1];
  const userReplies = decorated.filter(entry => entry.isUser);
  const hasUserReply = userReplies.length > 0;

  if (strictNoReply && hasUserReply) {
    return { awaiting: false, reason: 'userReplyPresent' };
  }

  const lastUserReply = userReplies[userReplies.length - 1] || null;
  const waitingMinutes = lastIncoming.timestamp
    ? Math.max(0, Math.round((Date.now() - lastIncoming.timestamp) / 60000))
    : null;

  const sinceLastUserReplyMinutes = lastUserReply?.timestamp && lastIncoming.timestamp
    ? Math.max(0, Math.round((lastIncoming.timestamp - lastUserReply.timestamp) / 60000))
    : null;

  const labelApplied = labelMatch ? Array.isArray(thread.labelIds) && thread.labelIds.includes(labelMatch.id) : false;
  const readSourceLabels = lastIncoming.raw.labelIds?.length ? lastIncoming.raw.labelIds : thread.labelIds || [];
  const readState = buildReadStateFromLabels(readSourceLabels);

  const candidateMessageIds = Array.from(new Set(
    messages
      .map(msg => (typeof msg.id === 'string' ? msg.id : null))
      .filter(id => typeof id === 'string' && id.length > 0)
  ));

  const item = {
    threadId: thread.threadId,
    messageId: lastIncoming.raw.id,
    candidateMessageIds,
    subject: lastIncoming.raw.subject || '(bez předmětu)',
    sender: {
      name: lastIncoming.raw.from?.name || null,
      email: lastIncoming.raw.from?.email || null
    },
    receivedAt: toPragueIso(lastIncoming.timestamp),
    receivedInternal: lastIncoming.timestamp || null,
    snippet: lastIncoming.raw.snippet || '',
    gmailLinks: buildGmailLinks(thread.threadId, lastIncoming.raw.id),
    messageCount: thread.count || messages.length,
    readState,
    hasUserReply,
    lastUserReplyAt: lastUserReply?.timestamp ? toPragueIso(lastUserReply.timestamp) : null,
    lastUserReplyInternal: lastUserReply?.timestamp || null,
    waitingMinutes,
    waitingHoursApprox: typeof waitingMinutes === 'number' ? Number((waitingMinutes / 60).toFixed(1)) : null,
    sinceLastUserReplyMinutes,
    participants: Array.isArray(thread.participants)
      ? thread.participants.map(participant => ({
          email: participant.email,
          name: participant.name || null
        }))
      : [],
    label: labelMatch
      ? {
          suggestedId: labelMatch.id,
          suggestedName: labelMatch.name,
          alreadyApplied: labelApplied
        }
      : null,
    labelApplied,
    trackingLabelApplied,
    strictFiltered: hasUserReply
  };

  return {
    awaiting: true,
    item
  };
}

function toPragueIso(timestamp) {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const offsetHours = getPragueOffsetHours(date);
  const pragueDate = new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
  const sign = offsetHours >= 0 ? '+' : '-';
  const offset = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  return pragueDate.toISOString().replace('Z', offset);
}

function stripDiacritics(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeLabelNameCandidate(value = '') {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findLabelByName(labels = [], targetName) {
  if (!targetName) {
    return null;
  }
  const normalizedTarget = normalizeLabelNameCandidate(targetName);
  return labels.find(label => normalizeLabelNameCandidate(label.name || '') === normalizedTarget) || null;
}

function buildLabelRecommendation(labels = [], targetName, preferredColor, options = {}) {
  const existing = findLabelByName(labels, targetName);

  let backgroundColor = '#d93025';
  let textColor = '#ffffff';

  if (typeof preferredColor === 'string' && preferredColor.trim().startsWith('#')) {
    backgroundColor = preferredColor.trim();
  } else if (preferredColor && typeof preferredColor === 'object') {
    if (typeof preferredColor.backgroundColor === 'string' && preferredColor.backgroundColor.trim().startsWith('#')) {
      backgroundColor = preferredColor.backgroundColor.trim();
    }
    if (typeof preferredColor.textColor === 'string' && preferredColor.textColor.trim().length > 0) {
      textColor = preferredColor.textColor.trim();
    }
  }

  const extraLabelIds = Array.isArray(options.extraLabelIds)
    ? options.extraLabelIds.filter(value => typeof value === 'string' && value.length > 0)
    : [];

  const applyLabelIds = existing
    ? Array.from(new Set([existing.id, ...extraLabelIds]))
    : [];

  return {
    suggestedName: targetName,
    suggestedColor: backgroundColor,
    textColor,
    existingLabel: existing
      ? { id: existing.id, name: existing.name, color: existing.color || null }
      : null,
    canCreate: !existing,
    createRequest: !existing
      ? {
          op: 'labels',
          params: {
            create: {
              name: targetName,
              color: {
                backgroundColor,
                textColor
              }
            }
          }
        }
      : null,
    applyRequestTemplate: existing
      ? {
          op: 'labels',
          params: {
            modify: {
              messageId: '<messageId>',
              add: applyLabelIds,
              remove: []
            }
          }
        }
      : null
  };
}

function normalizeWatchlistLabelColor(preference) {
  const fallback = UNREPLIED_LABEL_DEFAULTS.color || { backgroundColor: '#d93025', textColor: '#ffffff' };

  if (typeof preference === 'string' && preference.trim().startsWith('#')) {
    return {
      backgroundColor: preference.trim(),
      textColor: fallback.textColor || '#ffffff'
    };
  }

  if (preference && typeof preference === 'object') {
    const backgroundColor = typeof preference.backgroundColor === 'string' && preference.backgroundColor.trim().startsWith('#')
      ? preference.backgroundColor.trim()
      : fallback.backgroundColor || '#d93025';
    const textColor = typeof preference.textColor === 'string' && preference.textColor.trim().length > 0
      ? preference.textColor.trim()
      : fallback.textColor || '#ffffff';

    return { backgroundColor, textColor };
  }

  return {
    backgroundColor: fallback.backgroundColor || '#d93025',
    textColor: fallback.textColor || '#ffffff'
  };
}

function generateMapsUrl(locationText) {
  const encoded = encodeURIComponent(locationText);
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

function buildReadStateFromLabels(labelIds = []) {
  const labels = Array.isArray(labelIds) ? labelIds : [];
  const normalized = labels.map(label => label.toUpperCase());
  const isUnread = normalized.includes('UNREAD');

  return {
    isUnread,
    isRead: !isUnread
  };
}

function buildGmailLinks(threadId, messageId) {
  if (!threadId) {
    return null;
  }

  const threadLink = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
  return {
    thread: threadLink,
    message: messageId ? `${threadLink}?projector=1&messageId=${messageId}` : null
  };
}

/**
 * Extract enrichable fields from Google Contact
 */
function extractContactFields(contact) {
  const fields = {};

  // Phone
  if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
    fields.phone = contact.phoneNumbers[0].value;
  }

  // Address
  if (contact.addresses && contact.addresses.length > 0) {
    const addr = contact.addresses[0];
    fields.address = [
      addr.streetAddress,
      addr.city,
      addr.postalCode,
      addr.countryRegion
    ]
      .filter(Boolean)
      .join(', ');
  }

  // Email (already have from search)
  if (contact.emailAddresses && contact.emailAddresses.length > 1) {
    fields.alternateEmails = contact.emailAddresses
      .slice(1)
      .map(e => e.value);
  }

  return fields;
}

/**
 * Perform bulk contact add/merge with specified strategy
 * Strategy:
 * - 'keepBoth': Always add new contact (may duplicate)
 * - 'skip': Skip entries that have duplicates
 * - 'merge': Merge into existing contact
 */
async function performContactsBulkAdd(accessToken, entries, duplicateFindings, strategy) {
  const result = {
    created: [],
    merged: [],
    skipped: []
  };

  for (let i = 0; i < entries.length; i++) {
    const rawEntry = entries[i] || {};
    const entry = normalizeContactEntry(rawEntry);
    const finding = duplicateFindings[i] || { candidates: [] };
    const candidates = Array.isArray(finding.candidates) ? finding.candidates : [];
    const hasDuplicates = candidates.length > 0;

    if (!hasDuplicates || strategy === 'keepBoth') {
      try {
        await contactsService.addContact(accessToken, entry);
        result.created.push({
          name: entry.name,
          email: entry.email
        });
      } catch (error) {
        console.error(`❌ Failed to create contact ${entry.name}:`, error.message);
        result.skipped.push({
          email: entry.email,
          name: entry.name,
          reason: `Add failed: ${error.message}`
        });
      }
      continue;
    }

    if (strategy === 'skip') {
      result.skipped.push({
        email: entry.email,
        name: entry.name,
        reason: `Skipped: ${candidates.length} duplicate(s) found`,
        existing: candidates
      });
      continue;
    }

    if (strategy === 'merge') {
      const existingContact = candidates[0];

      if (!existingContact) {
        result.skipped.push({
          email: entry.email,
          name: entry.name,
          reason: 'Merge requested but no duplicate candidates found'
        });
        continue;
      }

      try {
        const { payload: mergedContact, changeSummaries } = mergeContactRecords(
          existingContact,
          entry
        );

        await contactsService.updateContact(accessToken, {
          ...mergedContact,
          rowIndex: existingContact.rowIndex
        });

        result.merged.push({
          merged_into: existingContact.email,
          from: entry.email || entry.name,
          fields_updated: changeSummaries.length > 0
            ? changeSummaries
            : ['No changes needed (duplicate already up to date)']
        });
      } catch (error) {
        console.error(`❌ Failed to merge contact ${entry.name}:`, error.message);
        result.skipped.push({
          email: entry.email,
          name: entry.name,
          reason: `Merge failed: ${error.message}`
        });
      }
      continue;
    }

    const unsupportedError = createServiceError(`Unsupported dedupe strategy: ${strategy}`, {
      name: FACADE_VALIDATION_ERROR,
      statusCode: 400,
      code: 'DEDUPE_STRATEGY_UNSUPPORTED',
      expose: true,
      details: { strategy }
    });
    console.error(unsupportedError.message);
    throw unsupportedError;
  }

  return result;
}

function normalizeDedupeStrategy(strategy) {
  const allowedStrategies = ['ask', 'keepBoth', 'skip', 'merge'];
  const candidate =
    strategy === undefined || strategy === null || strategy === '' ? 'ask' : strategy;
  const normalized =
    typeof candidate === 'string' ? candidate.trim() : String(candidate).trim();

  if (!normalized) {
    return 'ask';
  }

  if (normalized === 'create') {
    return 'keepBoth';
  }

  if (!allowedStrategies.includes(normalized)) {
    throwFacadeValidationError(
      `Invalid dedupe strategy: ${strategy}. Must be one of: ${allowedStrategies.join(', ')}`,
      {
        code: 'DEDUPE_STRATEGY_UNSUPPORTED',
        details: { allowed: allowedStrategies, received: strategy }
      }
    );
  }

  return normalized;
}

function normalizeContactEntry(entry = {}) {
  return {
    name: cleanValue(entry.name),
    email: cleanValue(entry.email),
    phone: cleanValue(entry.phone),
    realEstate: cleanValue(entry.realEstate ?? entry.realestate),
    notes: cleanValue(entry.notes)
  };
}

function cleanValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function mergeContactRecords(existingContact = {}, incomingEntry = {}) {
  const existing = {
    name: cleanValue(existingContact.name),
    email: cleanValue(existingContact.email),
    phone: cleanValue(existingContact.phone),
    realEstate: cleanValue(existingContact.realEstate ?? existingContact.realestate),
    notes: cleanValue(existingContact.notes)
  };

  const incoming = {
    name: cleanValue(incomingEntry.name),
    email: cleanValue(incomingEntry.email),
    phone: cleanValue(incomingEntry.phone),
    realEstate: cleanValue(incomingEntry.realEstate ?? incomingEntry.realestate),
    notes: cleanValue(incomingEntry.notes)
  };

  const summaries = [];

  const nameMerge = mergeTextField(existing.name, incoming.name, {
    separator: ' / ',
    label: 'name'
  });

  const phoneMerge = mergePhoneField(existing.phone, incoming.phone);
  const realEstateMerge = mergeTextField(existing.realEstate, incoming.realEstate, {
    separator: '\n',
    label: 'realEstate'
  });

  const notesMerge = mergeNotesField(existing.notes, incoming.notes);

  let mergedNotes = notesMerge.value;
  summaries.push(...notesMerge.changes);

  const primaryEmail = existing.email || incoming.email;
  if (!existing.email && incoming.email) {
    summaries.push(`email: set to ${incoming.email}`);
  } else if (
    existing.email &&
    incoming.email &&
    !equalsIgnoreCase(existing.email, incoming.email)
  ) {
    const altEmailLine = `Další e-mail: ${incoming.email}`;
    if (!containsCaseInsensitive(mergedNotes, incoming.email)) {
      mergedNotes = appendParagraph(mergedNotes, altEmailLine);
      summaries.push(`notes: added alternate email ${incoming.email}`);
    }
  }

  const mergedContact = {
    name: nameMerge.value,
    email: primaryEmail,
    phone: phoneMerge.value,
    realEstate: realEstateMerge.value,
    notes: mergedNotes
  };

  [nameMerge, phoneMerge, realEstateMerge].forEach(change => {
    if (change.updated && change.description) {
      summaries.push(change.description);
    }
  });

  return {
    payload: mergedContact,
    changeSummaries: summaries
  };
}

function mergeTextField(existing, incoming, { separator, label }) {
  const base = cleanValue(existing);
  const addition = cleanValue(incoming);

  if (!addition) {
    return { value: base, updated: false };
  }

  if (!base) {
    return {
      value: addition,
      updated: true,
      description: `${label}: added ${addition}`
    };
  }

  if (equalsIgnoreCase(base, addition) || containsCaseInsensitive(base, addition)) {
    return { value: base, updated: false };
  }

  const combined = `${base}${separator}${addition}`;
  return {
    value: combined,
    updated: true,
    description: `${label}: appended ${addition}`
  };
}

function mergePhoneField(existing, incoming) {
  const base = cleanValue(existing);
  const addition = cleanValue(incoming);

  if (!addition) {
    return { value: base, updated: false };
  }

  const baseNumbers = extractPhoneVariants(base);
  const additionNumber = normalizePhone(addition);

  if (!additionNumber) {
    return { value: base, updated: false };
  }

  if (baseNumbers.has(additionNumber)) {
    return { value: base, updated: false };
  }

  if (!base) {
    return {
      value: addition,
      updated: true,
      description: `phone: added ${addition}`
    };
  }

  return {
    value: `${base}, ${addition}`,
    updated: true,
    description: `phone: appended ${addition}`
  };
}

function mergeNotesField(existing, incoming) {
  const base = cleanValue(existing);
  const addition = cleanValue(incoming);
  const changes = [];

  if (!addition) {
    return { value: base, changes };
  }

  if (containsCaseInsensitive(base, addition)) {
    return { value: base, changes };
  }

  const value = appendParagraph(base, addition);
  changes.push('notes: appended from new entry');
  return { value, changes };
}

function appendParagraph(base, addition) {
  if (!base) return addition;
  if (!addition) return base;
  return `${base}\n\n${addition}`;
}

function equalsIgnoreCase(a, b) {
  return cleanValue(a).localeCompare(cleanValue(b), undefined, {
    sensitivity: 'accent',
    usage: 'search'
  }) === 0;
}

function containsCaseInsensitive(haystack, needle) {
  const base = cleanValue(haystack).toLowerCase();
  const target = cleanValue(needle).toLowerCase();
  if (!base || !target) return false;
  return base.includes(target);
}

function normalizePhone(value) {
  return cleanValue(value).replace(/\D/g, '');
}

function extractPhoneVariants(value) {
  const normalized = cleanValue(value);
  if (!normalized) {
    return new Set();
  }

  const parts = normalized
    .split(/[;,\n]/)
    .map(segment => normalizePhone(segment))
    .filter(segment => segment.length > 0);

  return new Set(parts);
}



/**
 * Helper: Extract email from "Name <email@example.com>" format
 */
function extractEmail(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<(.+?)>/);
  return match ? match[1] : fromHeader.trim();
}

/**
 * Helper: Extract name from "Name <email@example.com>" format
 */
function extractSenderName(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/^(.+?)\s*<(.+?)>/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, '');
    return name || null;
  }
  // If no angle brackets, return as-is (or null if it looks like email)
  return fromHeader.includes('@') ? null : fromHeader.trim();
}

const traced = wrapModuleFunctions('services.facadeService', {
  inboxOverview,
  inboxSnippets,
  emailQuickRead,
  inboxUserUnansweredRequests,
  meetingEmailsToday,
  calendarPlan,
  calendarSchedule,
  completeCalendarScheduleEnrichment,
  contactsSafeAdd,
  completeContactsDeduplication,
  tasksOverview,
  calendarReminderDrafts,
  calendarListCalendars,
});

const {
  inboxOverview: tracedInboxOverview,
  inboxSnippets: tracedInboxSnippets,
  emailQuickRead: tracedEmailQuickRead,
  inboxUserUnansweredRequests: tracedInboxUserUnansweredRequests,
  meetingEmailsToday: tracedMeetingEmailsToday,
  calendarPlan: tracedCalendarPlan,
  calendarSchedule: tracedCalendarSchedule,
  completeCalendarScheduleEnrichment: tracedCompleteCalendarScheduleEnrichment,
  contactsSafeAdd: tracedContactsSafeAdd,
  completeContactsDeduplication: tracedCompleteContactsDeduplication,
  tasksOverview: tracedTasksOverview,
  calendarReminderDrafts: tracedCalendarReminderDrafts,
  calendarListCalendars: tracedCalendarListCalendars,
} = traced;

export {
  tracedInboxOverview as inboxOverview,
  tracedInboxSnippets as inboxSnippets,
  tracedEmailQuickRead as emailQuickRead,
  tracedInboxUserUnansweredRequests as inboxUserUnansweredRequests,
  tracedMeetingEmailsToday as meetingEmailsToday,
  tracedCalendarPlan as calendarPlan,
  tracedCalendarSchedule as calendarSchedule,
  tracedCompleteCalendarScheduleEnrichment as completeCalendarScheduleEnrichment,
  tracedContactsSafeAdd as contactsSafeAdd,
  tracedCompleteContactsDeduplication as completeContactsDeduplication,
  tracedTasksOverview as tasksOverview,
  tracedCalendarReminderDrafts as calendarReminderDrafts,
  tracedCalendarListCalendars as calendarListCalendars,
};

export const __facadeTestUtils = {
  resolveGmailService,
  resolveCalendarService,
  resolveContactsService,
  resolveCreatePendingConfirmation,
  generateFallbackSearchQueries,
  searchEmailsWithFallback,
  searchEmailsWithProgressiveTime,
  searchEmailsSmart,
};
