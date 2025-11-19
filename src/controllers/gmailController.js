import * as gmailService from '../services/microsoftGraphService.js';
import { heavyLimiter } from '../server.js';
import {
  parseRelativeTime,
  normalizeQuery as normalizeQueryUtil,
  computeETag,
  checkETagMatch
} from '../utils/helpers.js';
import { createSnapshot, getSnapshot } from '../utils/snapshotStore.js';
import { handleControllerError } from '../utils/errors.js';
import { 
  PAGE_SIZE_DEFAULT, 
  PAGE_SIZE_MAX, 
  BATCH_PREVIEW_MAX_IDS, 
  BATCH_READ_MAX_IDS,
  BATCH_READ_CONCURRENCY,
  AGGREGATE_CAP_MAIL 
} from '../config/limits.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


// ==================== EMAIL OPERATIONS ====================

function cloneSearchMessage(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  const clone = { ...message };
  if (!('links' in clone) || typeof clone.links === 'undefined') {
    clone.links = null;
  }

  return clone;
}

function cloneSearchMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map(item => cloneSearchMessage(item));
}

async function sendEmail(req, res) {
  try {
    let { to, subject, body, cc, bcc, toSelf, confirmSelfSend } = req.body;

    if (toSelf && !to) {
      if (!confirmSelfSend) {
        return res.status(400).json({
          error: 'Confirmation required',
          message: 'To send email to yourself, confirmSelfSend must be true',
          code: 'CONFIRM_SELF_SEND_REQUIRED'
        });
      }
      to = req.user.email || req.user.primaryEmail;
    }

    if (!to || !subject || !body) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: to, subject, body'
      });
    }

    const result = await gmailService.sendEmail(req.user.microsoftId, {
      to, subject, body, cc, bcc
    });

    res.json({
      success: true,
      messageId: result.id,
      threadId: result.threadId,
      message: 'Email sent successfully',
      sentToSelf: toSelf === true,
      preview: { to, subject, body, cc, bcc }
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.sendEmail',
      defaultMessage: 'Email send failed',
      defaultCode: 'EMAIL_SEND_FAILED'
    });
  }
}

async function replyToEmail(req, res) {
  try {
    const { messageId } = req.params;
    let { body, toSelf, confirmSelfSend } = req.body;

    if (!body) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required field: body'
      });
    }

    if (toSelf && !confirmSelfSend) {
      return res.status(400).json({
        error: 'Confirmation required',
        message: 'To reply to yourself, confirmSelfSend must be true',
        code: 'CONFIRM_SELF_SEND_REQUIRED'
      });
    }

    const result = await gmailService.replyToEmail(req.user.microsoftId, messageId, { body });

    res.json({
      success: true,
      messageId: result.id,
      threadId: result.threadId,
      message: 'Reply sent successfully',
      repliedToSelf: toSelf === true
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.replyToEmail',
      defaultMessage: 'Email reply failed',
      defaultCode: 'EMAIL_REPLY_FAILED'
    });
  }
}

async function readEmail(req, res) {
  try {
    const { messageId } = req.params;
    const { format = 'full', autoTruncate = 'true', includeAttachments = 'false' } = req.query;

    const ids = messageId.split(',').map(id => id.trim()).filter(id => id);
    
    if (ids.length > 5) {
      req.body = { ids };
      return batchRead(req, res);
    }

    const result = await gmailService.readEmail(
      req.user.microsoftId, 
      messageId,
      { 
        format, 
        autoTruncate: autoTruncate === 'true',
        includeAttachments: includeAttachments === 'true'
      }
    );

    const etag = computeETag(result);
    if (checkETagMatch(req.headers['if-none-match'], etag)) {
      return res.status(304).end();
    }

    res.setHeader('ETag', etag);
    res.json({
      success: true,
      email: result,
      truncated: result.truncated || false
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.readEmail',
      defaultMessage: 'Email read failed',
      defaultCode: 'EMAIL_READ_FAILED'
    });
  }
}

async function getEmailSnippet(req, res) {
  try {
    const { messageId } = req.params;

    const result = await gmailService.readEmail(
      req.user.microsoftId, 
      messageId,
      { format: 'snippet' }
    );

    const etag = computeETag(result);
    if (checkETagMatch(req.headers['if-none-match'], etag)) {
      return res.status(304).end();
    }

    res.setHeader('ETag', etag);
    res.json({
      success: true,
      snippet: result.snippet,
      messageId: result.id,
      sizeEstimate: result.sizeEstimate,
      headers: result.headers,
      readState: result.readState
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.getEmailSnippet',
      defaultMessage: 'Snippet retrieval failed',
      defaultCode: 'EMAIL_SNIPPET_FAILED'
    });
  }
}

/**
 * FIXED: Summary should NOT include snippet
 * According to OpenAPI spec, summary should only have: from, subject, date
 */
async function fetchBatchPreview(microsoftId, ids, kind) {
  const results = [];
  
  for (let i = 0; i < ids.length; i += BATCH_READ_CONCURRENCY) {
    const batch = ids.slice(i, i + BATCH_READ_CONCURRENCY);
    
    const promises = batch.map(async (id) => {
      try {
        if (kind === 'summary') {
          const msg = await gmailService.readEmail(microsoftId, id, { format: 'metadata' });
          // FIXED: summary should NOT include snippet
          return {
            id,
            from: msg.from,
            subject: msg.subject,
            date: msg.date,
            readState: msg.readState
          };
        } else if (kind === 'snippet') {
          const msg = await gmailService.readEmail(microsoftId, id, { format: 'snippet' });
          return {
            id,
            snippet: msg.snippet,
            readState: msg.readState
          };
        } else {
          const msg = await gmailService.readEmail(microsoftId, id, { format: 'metadata' });
          return msg;
        }
      } catch (err) {
        console.error(`Failed to fetch ${kind} for ${id}:`, err.message);
        return { id, error: err.message };
      }
    });
    
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }
  
  return results;
}

async function batchPreview(req, res) {
  try {
    const { ids, kind = 'summary' } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid field: ids'
      });
    }

    if (!['summary', 'snippet', 'metadata'].includes(kind)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid kind. Must be: summary, snippet, or metadata'
      });
    }

    const chunks = [];
    for (let i = 0; i < ids.length; i += BATCH_PREVIEW_MAX_IDS) {
      chunks.push(ids.slice(i, i + BATCH_PREVIEW_MAX_IDS));
    }

    let allResults = [];
    for (const chunk of chunks) {
      const chunkResults = await fetchBatchPreview(req.user.microsoftId, chunk, kind);
      allResults = allResults.concat(chunkResults);
    }

    res.json({
      success: true,
      idsRequested: ids.length,
      idsReturned: allResults.length,
      kind,
      items: allResults
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.batchPreview',
      defaultMessage: 'Batch preview failed',
      defaultCode: 'BATCH_PREVIEW_FAILED'
    });
  }
}

async function batchRead(req, res) {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid field: ids'
      });
    }

    const limitedIds = ids.slice(0, BATCH_READ_MAX_IDS);
    const truncated = ids.length > BATCH_READ_MAX_IDS;

    const results = [];

    for (let i = 0; i < limitedIds.length; i += BATCH_READ_CONCURRENCY) {
      const batch = limitedIds.slice(i, i + BATCH_READ_CONCURRENCY);
      
      const promises = batch.map(async (id) => {
        try {
          return await gmailService.readEmail(req.user.microsoftId, id, {
            format: 'full',
            autoTruncate: true
          });
        } catch (err) {
          console.error(`Failed to read ${id}:`, err.message);
          return { id, error: err.message };
        }
      });
      
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }

    const response = {
      success: true,
      idsRequested: ids.length,
      idsReturned: results.length,
      items: results
    };

    if (truncated) {
      response.note = `Request truncated to ${BATCH_READ_MAX_IDS} items`;
    }

    res.json(response);
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.batchRead',
      defaultMessage: 'Batch read failed',
      defaultCode: 'BATCH_READ_FAILED'
    });
  }
}

async function searchEmails(req, res) {
  const runSearch = async (req, res) => {
    try {
      let {
        query,
        maxResults,
        pageToken,
        aggregate,
        include,
        normalizeQuery: normalizeQueryFlag,
        relative,
        after,
        before,
        snapshotToken,
        label,
        labelIds
      } = req.query;

      // Handle label filters
      let labelFilter = '';
      if (label) {
        const labels = Array.isArray(label) ? label : [label];
        labelFilter = labels.map(l => `label:${l}`).join(' ');
      }
      if (labelIds) {
        const ids = Array.isArray(labelIds) ? labelIds : [labelIds];
        labelFilter += ' ' + ids.map(id => `label:${id}`).join(' ');
      }

      // Handle date filters
      let dateFilter = '';
      if (relative) {
        const times = parseRelativeTime(relative);
        if (!times) {
          return res.status(400).json({
            error: 'Bad Request',
            message: `Invalid relative time: ${relative}`
          });
        }
        dateFilter = `after:${times.after} before:${times.before}`;
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

      // Build final query
      query = `${query || ''} ${labelFilter} ${dateFilter}`.trim();

      let originalQuery = query;
      if (normalizeQueryFlag === 'true') {
        query = normalizeQueryUtil(query);
      }

      const aggregateMode = aggregate === 'true';
      const includeSummary = include === 'summary';

      if (aggregateMode) {
        let allItems = [];
        let currentPageToken = pageToken;
        let pagesConsumed = 0;
        let hasMore = false;
        let partial = false;
        let truncated = false;

        while (true) {
          const result = await gmailService.searchEmails(req.user.microsoftId, {
            query,
            maxResults: PAGE_SIZE_DEFAULT,
            pageToken: currentPageToken
          });

          const items = cloneSearchMessages(result.messages || []);
          allItems = allItems.concat(items);
          pagesConsumed++;

          const nextPageToken = result.nextPageToken;
          const hasNextPage = Boolean(nextPageToken);
          const exceededCap = allItems.length > AGGREGATE_CAP_MAIL;
          const reachedCap = allItems.length >= AGGREGATE_CAP_MAIL;

          if (reachedCap) {
            const hasAdditionalResults = hasNextPage;
            if (exceededCap) {
              allItems = allItems.slice(0, AGGREGATE_CAP_MAIL);
              truncated = true;
            }
            hasMore = hasAdditionalResults;
            partial = hasAdditionalResults;
            truncated = truncated || hasAdditionalResults;
            break;
          }

          if (hasNextPage) {
            currentPageToken = nextPageToken;
          } else {
            hasMore = false;
            break;
          }
        }

        let summariesReturned = 0;
        let summariesPartial = false;

        if (includeSummary && allItems.length > 0) {
          const ids = allItems.map(item => item.id);
          const summaries = await fetchBatchPreview(req.user.microsoftId, ids, 'summary');
          
          const summaryMap = new Map(summaries.map(s => [s.id, s]));
          allItems = allItems.map(item => ({
            ...item,
            summary: summaryMap.get(item.id)
          }));

          summariesReturned = summaries.filter(s => !s.error).length;
          summariesPartial = summariesReturned < ids.length;
        }

        const newSnapshotToken = createSnapshot(query, { aggregate: true });

        const response = {
          success: true,
          items: allItems,
          totalExact: allItems.length,
          pagesConsumed,
          hasMore,
          partial,
          truncated,
          snapshotToken: newSnapshotToken,
          idsReturned: allItems.length
        };

        if (includeSummary) {
          response.summariesReturned = summariesReturned;
          if (summariesPartial) {
            response.summariesPartial = true;
          }
        }

        if (normalizeQueryFlag === 'true') {
          response.originalQuery = originalQuery;
          response.normalizedQuery = query;
        }

        const etag = computeETag(response);
        if (checkETagMatch(req.headers['if-none-match'], etag)) {
          return res.status(304).end();
        }

        res.setHeader('ETag', etag);
        return res.json(response);

      } else {
        const pageSize = Math.min(
          parseInt(maxResults) || PAGE_SIZE_DEFAULT,
          PAGE_SIZE_MAX
        );

        const result = await gmailService.searchEmails(req.user.microsoftId, {
          query,
          maxResults: pageSize,
          pageToken
        });

        const items = cloneSearchMessages(result.messages || []);
        const hasMore = !!result.nextPageToken;
        const nextPageToken = result.nextPageToken;

        let summariesReturned = 0;
        let summariesPartial = false;

        if (includeSummary && items.length > 0) {
          const ids = items.map(item => item.id);
          const summaries = await fetchBatchPreview(req.user.microsoftId, ids, 'summary');
          
          const summaryMap = new Map(summaries.map(s => [s.id, s]));
          const itemsWithSummary = items.map(item => ({
            ...item,
            summary: summaryMap.get(item.id)
          }));

          summariesReturned = summaries.filter(s => !s.error).length;
          summariesPartial = summariesReturned < ids.length;

          const response = {
            success: true,
            items: itemsWithSummary,
            hasMore,
            nextPageToken,
            idsReturned: items.length,
            summariesReturned
          };

          if (summariesPartial) {
            response.summariesPartial = true;
          }

          if (normalizeQueryFlag === 'true') {
            response.originalQuery = originalQuery;
            response.normalizedQuery = query;
          }

          const etag = computeETag(response);
          if (checkETagMatch(req.headers['if-none-match'], etag)) {
            return res.status(304).end();
          }

          res.setHeader('ETag', etag);
          return res.json(response);
        }

        const response = {
          success: true,
          items,
          hasMore,
          nextPageToken,
          idsReturned: items.length
        };

        if (normalizeQueryFlag === 'true') {
          response.originalQuery = originalQuery;
          response.normalizedQuery = query;
        }

        const etag = computeETag(response);
        if (checkETagMatch(req.headers['if-none-match'], etag)) {
          return res.status(304).end();
        }

        res.setHeader('ETag', etag);
        return res.json(response);
    }
  } catch (error) {
      return handleControllerError(res, error, {
        context: 'gmail.searchEmails',
        defaultMessage: 'Email search failed',
        defaultCode: 'EMAIL_SEARCH_FAILED'
      });
    }
  };

  if (req.query.aggregate === 'true') {
    heavyLimiter(req, res, () => runSearch(req, res));
  } else {
    runSearch(req, res);
  }
}

async function createDraft(req, res) {
  try {
    const { to, subject, body } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: to, subject, body'
      });
    }

    const result = await gmailService.createDraft(req.user.microsoftId, {
      to, subject, body
    });

    res.json({
      success: true,
      draftId: result.id,
      message: 'Draft created successfully'
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.createDraft',
      defaultMessage: 'Draft creation failed',
      defaultCode: 'DRAFT_CREATE_FAILED'
    });
  }
}

async function deleteEmail(req, res) {
  try {
    const { messageId } = req.params;

    const result = await gmailService.deleteEmail(req.user.microsoftId, messageId);

    res.json({
      success: true,
      messageId: result.messageId,
      message: 'Email moved to trash'
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.deleteEmail',
      defaultMessage: 'Email deletion failed',
      defaultCode: 'EMAIL_DELETE_FAILED'
    });
  }
}

async function toggleStar(req, res) {
  try {
    const { messageId } = req.params;
    const { star } = req.body;

    if (typeof star !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid field: star (must be boolean)'
      });
    }

    const result = await gmailService.toggleStar(req.user.microsoftId, messageId, star);

    res.json({
      success: true
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.toggleStar',
      defaultMessage: 'Star toggle failed',
      defaultCode: 'STAR_TOGGLE_FAILED'
    });
  }
}

async function markAsRead(req, res) {
  try {
    const { messageId } = req.params;
    const { read } = req.body;

    if (typeof read !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid field: read (must be boolean)'
      });
    }

    const result = await gmailService.markAsRead(req.user.microsoftId, messageId, read);

    res.json({
      success: true
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.markAsRead',
      defaultMessage: 'Mark as read failed',
      defaultCode: 'MARK_READ_FAILED'
    });
  }
}

// ==================== NEW: LABELS ====================

async function listLabels(req, res) {
  try {
    const { search, q, lookup, forceRefresh } = req.query;
    const searchQuery = typeof search !== 'undefined' ? search : (typeof lookup !== 'undefined' ? lookup : q);

    let responsePayload;

    if (typeof searchQuery !== 'undefined') {
      const matchesFor = Array.isArray(searchQuery) ? searchQuery : [searchQuery];
      const result = await gmailService.listLabels(req.user.microsoftId, {
        includeMatchesFor: matchesFor,
        forceRefresh: forceRefresh === 'true'
      });

      if (Array.isArray(result)) {
        responsePayload = { success: true, labels: result };
      } else {
        responsePayload = {
          success: true,
          labels: result.labels,
          resolution: result.resolution
        };
      }
    } else {
      const labels = await gmailService.listLabels(req.user.microsoftId, {
        forceRefresh: forceRefresh === 'true'
      });

      if (Array.isArray(labels)) {
        responsePayload = { success: true, labels };
      } else {
        responsePayload = {
          success: true,
          labels: labels.labels,
          resolution: labels.resolution
        };
      }
    }

    res.json(responsePayload);
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.listLabels',
      defaultMessage: 'Label listing failed',
      defaultCode: 'LABEL_LIST_FAILED'
    });
  }
}

async function modifyMessageLabels(req, res) {
  try {
    const { messageId } = req.params;
    const { add = [], remove = [] } = req.body;

    const result = await gmailService.modifyMessageLabels(req.user.microsoftId, messageId, { add, remove });

    res.json(result);
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.modifyMessageLabels',
      defaultMessage: 'Label modification failed',
      defaultCode: 'LABEL_MODIFY_FAILED'
    });
  }
}

async function modifyThreadLabels(req, res) {
  try {
    const { threadId } = req.params;
    const { add = [], remove = [] } = req.body;

    const result = await gmailService.modifyThreadLabels(req.user.microsoftId, threadId, { add, remove });

    res.json(result);
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.modifyThreadLabels',
      defaultMessage: 'Thread label modification failed',
      defaultCode: 'THREAD_LABEL_MODIFY_FAILED'
    });
  }
}

// ==================== NEW: THREADS ====================

async function getThread(req, res) {
  try {
    const { threadId } = req.params;

    const thread = await gmailService.getThread(req.user.microsoftId, threadId);

    res.json({
      success: true,
      thread
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.getThread',
      defaultMessage: 'Thread retrieval failed',
      defaultCode: 'THREAD_GET_FAILED'
    });
  }
}

async function setThreadRead(req, res) {
  try {
    const { threadId } = req.params;
    const { read } = req.body;

    if (typeof read !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid field: read (must be boolean)'
      });
    }

    await gmailService.setThreadRead(req.user.microsoftId, threadId, read);

    res.json({
      success: true
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.setThreadRead',
      defaultMessage: 'Thread read status change failed',
      defaultCode: 'THREAD_READ_STATUS_FAILED'
    });
  }
}

async function replyToThread(req, res) {
  try {
    const { threadId } = req.params;
    const { body, toSelf, confirmSelfSend } = req.body;

    if (!body) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required field: body'
      });
    }

    if (toSelf && !confirmSelfSend) {
      return res.status(400).json({
        error: 'Confirmation required',
        message: 'To reply to yourself, confirmSelfSend must be true',
        code: 'CONFIRM_SELF_SEND_REQUIRED'
      });
    }

    const result = await gmailService.replyToThread(req.user.microsoftId, threadId, { body });

    res.json({
      success: true,
      messageId: result.id,
      threadId: result.threadId
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.replyToThread',
      defaultMessage: 'Thread reply failed',
      defaultCode: 'THREAD_REPLY_FAILED'
    });
  }
}

// ==================== NEW: ATTACHMENTS ====================

async function getAttachmentMeta(req, res) {
  try {
    const { messageId, attachmentId } = req.params;

    const attachment = await gmailService.getAttachmentMeta(
      req.user.microsoftId,
      messageId,
      attachmentId
    );

    res.json({
      success: true,
      attachment
    });
  } catch (error) {
    if (error.statusCode === 451) {
      return res.status(451).json({
        error: 'Attachment blocked',
        message: error.message,
        code: error.code || 'ATTACHMENT_BLOCKED'
      });
    }

    return handleControllerError(res, error, {
      context: 'gmail.getAttachmentMeta',
      defaultMessage: 'Attachment metadata retrieval failed',
      defaultCode: 'ATTACHMENT_META_FAILED'
    });
  }
}

async function previewAttachmentText(req, res) {
  try {
    const { messageId, attachmentId } = req.params;
    const { maxKb = 256 } = req.query;

    const preview = await gmailService.previewAttachmentText(
      req.user.microsoftId,
      messageId,
      attachmentId,
      parseInt(maxKb)
    );

    res.json(preview);
  } catch (error) {
    if (error.statusCode === 451) {
      return res.status(451).json({
        error: 'Attachment blocked',
        message: error.message,
        code: error.code || 'ATTACHMENT_BLOCKED'
      });
    }

    return handleControllerError(res, error, {
      context: 'gmail.previewAttachmentText',
      defaultMessage: 'Attachment text preview failed',
      defaultCode: 'ATTACHMENT_TEXT_PREVIEW_FAILED'
    });
  }
}

async function previewAttachmentTable(req, res) {
  try {
    const { messageId, attachmentId } = req.params;
    const { sheet = 0, maxRows = 50 } = req.query;

    const preview = await gmailService.previewAttachmentTable(
      req.user.microsoftId,
      messageId,
      attachmentId,
      { sheet, maxRows: parseInt(maxRows) }
    );

    res.json(preview);
  } catch (error) {
    if (error.statusCode === 451) {
      return res.status(451).json({
        error: 'Attachment blocked',
        message: error.message,
        code: error.code || 'ATTACHMENT_BLOCKED'
      });
    }

    return handleControllerError(res, error, {
      context: 'gmail.previewAttachmentTable',
      defaultMessage: 'Attachment table preview failed',
      defaultCode: 'ATTACHMENT_TABLE_PREVIEW_FAILED'
    });
  }
}

/**
 * Download attachment using signed URL
 * This endpoint is called via the signed URL generated by getAttachmentMeta
 */
async function downloadAttachment(req, res) {
  try {
    const { messageId, attachmentId } = req.params;
    const { expires, signature } = req.query;

    if (!expires || !signature) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required parameters: expires, signature'
      });
    }

    // Verify signature
    const { verifySignedUrl } = await import('../utils/signedUrlGenerator.js');
    const verification = verifySignedUrl(messageId, attachmentId, expires, signature);
    
    if (!verification.valid) {
      return res.status(403).json({
        error: 'Forbidden',
        message: verification.error,
        code: verification.code
      });
    }

    // Signature is valid - download the attachment
    const attachment = await gmailService.downloadAttachment(
      req.user.microsoftId,
      messageId,
      attachmentId
    );

    // Set appropriate headers for download
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
    res.setHeader('Content-Length', attachment.data.length);
    
    // Send the binary data
    res.send(attachment.data);

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.downloadAttachment',
      defaultMessage: 'Attachment download failed',
      defaultCode: 'ATTACHMENT_DOWNLOAD_FAILED'
    });
  }
}

async function listFollowupCandidates(req, res) {
  try {
    const {
      minAgeDays,
      maxAgeDays,
      maxThreads,
      includeBodies,
      includeDrafts,
      query,
      historyLimit,
      pageToken
    } = req.query;

    const options = {
      includeBodies: includeBodies !== 'false',
      includeDrafts: includeDrafts === 'true'
    };

    if (typeof minAgeDays !== 'undefined') {
      const parsed = Number(minAgeDays);
      if (Number.isFinite(parsed)) {
        options.minAgeDays = parsed;
      }
    }

    if (typeof maxAgeDays !== 'undefined') {
      const parsed = Number(maxAgeDays);
      if (Number.isFinite(parsed)) {
        options.maxAgeDays = parsed;
      }
    }

    if (typeof maxThreads !== 'undefined') {
      const parsed = Number(maxThreads);
      if (Number.isFinite(parsed)) {
        options.maxThreads = parsed;
      }
    }

    if (typeof historyLimit !== 'undefined') {
      const parsed = Number(historyLimit);
      if (Number.isFinite(parsed)) {
        options.historyLimit = parsed;
      }
    }

    if (typeof query === 'string' && query.trim().length > 0) {
      options.query = query.trim();
    }

    if (typeof pageToken === 'string' && pageToken.trim().length > 0) {
      options.pageToken = pageToken.trim();
    }

    const result = await gmailService.listFollowupCandidates(
      req.user.microsoftId,
      options
    );

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'gmail.listFollowupCandidates',
      defaultMessage: 'Failed to build follow-up candidate list',
      defaultCode: 'FOLLOWUP_LIST_FAILED'
    });
  }
}

const traced = wrapModuleFunctions('controllers.gmailController', {
  sendEmail,
  replyToEmail,
  readEmail,
  batchPreview,
  batchRead,
  getEmailSnippet,
  searchEmails,
  listFollowupCandidates,
  createDraft,
  deleteEmail,
  toggleStar,
  markAsRead,
  listLabels,
  modifyMessageLabels,
  modifyThreadLabels,
  getThread,
  setThreadRead,
  replyToThread,
  getAttachmentMeta,
  previewAttachmentText,
  previewAttachmentTable,
  downloadAttachment,
});

const {
  sendEmail: tracedSendEmail,
  replyToEmail: tracedReplyToEmail,
  readEmail: tracedReadEmail,
  batchPreview: tracedBatchPreview,
  batchRead: tracedBatchRead,
  getEmailSnippet: tracedGetEmailSnippet,
  searchEmails: tracedSearchEmails,
  listFollowupCandidates: tracedListFollowupCandidates,
  createDraft: tracedCreateDraft,
  deleteEmail: tracedDeleteEmail,
  toggleStar: tracedToggleStar,
  markAsRead: tracedMarkAsRead,
  listLabels: tracedListLabels,
  modifyMessageLabels: tracedModifyMessageLabels,
  modifyThreadLabels: tracedModifyThreadLabels,
  getThread: tracedGetThread,
  setThreadRead: tracedSetThreadRead,
  replyToThread: tracedReplyToThread,
  getAttachmentMeta: tracedGetAttachmentMeta,
  previewAttachmentText: tracedPreviewAttachmentText,
  previewAttachmentTable: tracedPreviewAttachmentTable,
  downloadAttachment: tracedDownloadAttachment,
} = traced;

export {
  tracedSendEmail as sendEmail,
  tracedReplyToEmail as replyToEmail,
  tracedReadEmail as readEmail,
  tracedBatchPreview as batchPreview,
  tracedBatchRead as batchRead,
  tracedGetEmailSnippet as getEmailSnippet,
  tracedSearchEmails as searchEmails,
  tracedListFollowupCandidates as listFollowupCandidates,
  tracedCreateDraft as createDraft,
  tracedDeleteEmail as deleteEmail,
  tracedToggleStar as toggleStar,
  tracedMarkAsRead as markAsRead,
  tracedListLabels as listLabels,
  tracedModifyMessageLabels as modifyMessageLabels,
  tracedModifyThreadLabels as modifyThreadLabels,
  tracedGetThread as getThread,
  tracedSetThreadRead as setThreadRead,
  tracedReplyToThread as replyToThread,
  tracedGetAttachmentMeta as getAttachmentMeta,
  tracedPreviewAttachmentText as previewAttachmentText,
  tracedPreviewAttachmentTable as previewAttachmentTable,
  tracedDownloadAttachment as downloadAttachment,
};
