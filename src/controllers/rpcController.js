/**
 * RPC Controller - Unified RPC endpoint dispatcher
 * 
 * Dispatches RPC calls to appropriate service operations
 * based on `op` parameter.
 */
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


import * as gmailService from '../services/microsoftGraphService.js';
import * as calendarService from '../services/microsoftGraphService.js';
import * as contactsService from '../services/contactsService.js';
import * as tasksService from '../services/tasksService.js';
import { computeETag, generateSheetUrl } from '../utils/helpers.js';

const rpcTestOverrides = globalThis.__RPC_TEST_OVERRIDES || {};
const gmailSvc = rpcTestOverrides.gmailService || gmailService;
const contactsSvc = rpcTestOverrides.contactsService || contactsService;
const tasksSvc = rpcTestOverrides.tasksService || tasksService;

function cloneMessageWithLinks(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  const clone = { ...message };
  if (!('links' in clone) || typeof clone.links === 'undefined') {
    clone.links = null;
  }

  if (Array.isArray(clone.messages)) {
    clone.messages = clone.messages.map(item => cloneMessageWithLinks(item));
  }

  return clone;
}

function cloneMessagesWithLinks(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map(message => cloneMessageWithLinks(message));
}

function cloneThreadsWithLinks(threads) {
  if (!Array.isArray(threads)) {
    return threads;
  }

  return threads.map(thread => {
    if (!thread || typeof thread !== 'object') {
      return thread;
    }

    const clone = { ...thread };
    if (!('links' in clone) || typeof clone.links === 'undefined') {
      clone.links = null;
    }

    if (Array.isArray(clone.messages)) {
      clone.messages = clone.messages.map(message => cloneMessageWithLinks(message));
    }

    return clone;
  });
}

function normalizeSearchResult(result) {
  const payload = result && typeof result === 'object' ? { ...result } : {};
  const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
  payload.messages = cloneMessagesWithLinks(rawMessages);

  if (Array.isArray(result?.threads)) {
    payload.threads = cloneThreadsWithLinks(result.threads);
  }

  // Add hint when more results are available
  if (payload.nextPageToken) {
    const messageCount = payload.messages?.length || 0;
    payload.hint = `This response contains ${messageCount} message IDs. nextPageToken exists meaning the response is not complete. If user asks for summary or wants to see all matching emails, they usually expect complete data - it is recommended to call this function again with nextPageToken and continue until nextPageToken is null for complete results.`;
  }

  return payload;
}

// ==================== MAIL RPC ====================

async function mailRpc(req, res) {
  try {
    const { op, params = {} } = req.body;
    
    if (!op) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Missing required field: op',
        code: 'INVALID_PARAM'
      });
    }
    
    let result;

    switch (op) {
      case 'search': {
        const searchResult = await gmailSvc.searchEmails(req.user.microsoftId, params);
        result = normalizeSearchResult(searchResult);
        break;
      }
        
      case 'preview':
        result = await Promise.all(
          (params.ids || []).map(id =>
            gmailSvc.readEmail(req.user.microsoftId, id, 'metadata')
          )
        );
        break;
        
      case 'read':
        if (params.ids && params.ids.length > 1) {
          result = await Promise.all(
            params.ids.map(id =>
              gmailSvc.readEmail(req.user.microsoftId, id, params.format || 'full')
            )
          );
        } else if (params.ids && params.ids.length === 1) {
          result = await gmailSvc.readEmail(
            req.user.microsoftId,
            params.ids[0],
            params.format || 'full'
          );
        } else if (params.searchQuery) {
          const searchResult = await gmailSvc.searchEmails(req.user.microsoftId, {
            q: params.searchQuery,
            maxResults: 10
          });
          result = await Promise.all(
            searchResult.messages.map(m =>
              gmailSvc.readEmail(req.user.microsoftId, m.id, params.format || 'full')
            )
          );
        }
        break;

      case 'createDraft':
        if (!params || typeof params !== 'object') {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'params object is required for createDraft operation',
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'createDraft', params: { to: 'string', subject: 'string', body: 'string' } }
          });
        }

        const missingDraftFields = ['to', 'subject', 'body'].filter(field => {
          const value = params[field];
          return typeof value !== 'string' || value.trim() === '';
        });

        if (missingDraftFields.length > 0) {
          return res.status(400).json({
            error: 'Invalid request format',
            message: `Missing or invalid field(s) for createDraft: ${missingDraftFields.join(', ')}`,
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'createDraft', params: { to: 'recipient@example.com', subject: 'string', body: 'string' } }
          });
        }

        const draftPayload = {
          to: params.to.trim(),
          subject: params.subject.trim(),
          body: params.body
        };

        if (typeof params.cc === 'string' && params.cc.trim().length > 0) {
          draftPayload.cc = params.cc;
        }
        if (typeof params.bcc === 'string' && params.bcc.trim().length > 0) {
          draftPayload.bcc = params.bcc;
        }
        if (typeof params.threadId === 'string' && params.threadId.trim().length > 0) {
          draftPayload.threadId = params.threadId.trim();
        }

        result = await gmailSvc.createDraft(req.user.microsoftId, draftPayload);
        break;

      case 'send':
        // FIXED: Better validation for send operation
        if (!params) {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'params object is required for send operation',
            code: 'INVALID_PARAM',
            details: 'Expected one of:',
            option1: { params: { draftId: 'string' } },
            option2: { params: { to: 'email@example.com', subject: 'string', body: 'string' } }
          });
        }
        
        if (params.draftId) {
          // Send existing draft - VALIDATE draftId format
          if (typeof params.draftId !== 'string' || params.draftId.trim() === '') {
            return res.status(400).json({
              error: 'Invalid draftId format',
              message: 'draftId must be a non-empty string',
              code: 'INVALID_PARAM',
              received: { type: typeof params.draftId, value: params.draftId }
            });
          }
          result = await gmailSvc.sendDraft(req.user.microsoftId, params.draftId);
        } else if (params.to && params.subject && params.body) {
          // Create and send new email - VALIDATE fields
          if (typeof params.to !== 'string' || params.to.trim() === '') {
            return res.status(400).json({
              error: 'Invalid email format',
              message: 'to field must be non-empty email string',
              code: 'INVALID_PARAM'
            });
          }
          if (typeof params.subject !== 'string' || params.subject.trim() === '') {
            return res.status(400).json({
              error: 'Invalid subject format',
              message: 'subject field must be non-empty string',
              code: 'INVALID_PARAM'
            });
          }
          if (typeof params.body !== 'string' || params.body.trim() === '') {
            return res.status(400).json({
              error: 'Invalid body format',
              message: 'body field must be non-empty string',
              code: 'INVALID_PARAM'
            });
          }
          // Create and send new email
          if (params.toSelf && !params.confirmSelfSend) {
            return res.status(400).json({
              error: 'Confirmation required',
              message: 'To send email to yourself, confirmSelfSend must be true',
              code: 'CONFIRM_SELF_SEND_REQUIRED'
            });
          }
          result = await gmailSvc.sendEmail(req.user.microsoftId, params);
        } else {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'Missing required fields for send operation',
            code: 'INVALID_PARAM',
            details: 'Must provide EITHER draftId OR (to + subject + body)',
            providedFields: Object.keys(params || {})
          });
        }
        break;

      case 'updateDraft': {
        if (!params || typeof params !== 'object') {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'params object is required for updateDraft operation',
            code: 'INVALID_PARAM',
            expectedFormat: {
              op: 'updateDraft',
              params: {
                draftId: 'string',
                to: 'recipient@example.com',
                subject: 'string',
                body: 'string'
              }
            }
          });
        }

        const { draftId, to, subject, body } = params;

        const missingFields = [];
        if (typeof draftId !== 'string' || draftId.trim() === '') missingFields.push('draftId');
        if (typeof to !== 'string' || to.trim() === '') missingFields.push('to');
        if (typeof subject !== 'string' || subject.trim() === '') missingFields.push('subject');
        if (typeof body !== 'string') missingFields.push('body');

        if (missingFields.length > 0) {
          return res.status(400).json({
            error: 'Invalid request format',
            message: `Missing or invalid field(s) for updateDraft: ${missingFields.join(', ')}`,
            code: 'INVALID_PARAM',
            expectedFormat: {
              op: 'updateDraft',
              params: {
                draftId: 'existing-draft-id',
                to: 'recipient@example.com',
                subject: 'string',
                body: 'string'
              }
            }
          });
        }

        const updatePayload = {
          to: to.trim(),
          subject: subject.trim(),
          body
        };

        if (typeof params.cc === 'string' && params.cc.trim().length > 0) {
          updatePayload.cc = params.cc;
        }
        if (typeof params.bcc === 'string' && params.bcc.trim().length > 0) {
          updatePayload.bcc = params.bcc;
        }
        if (typeof params.threadId === 'string' && params.threadId.trim().length > 0) {
          updatePayload.threadId = params.threadId.trim();
        }

        result = await gmailSvc.updateDraft(req.user.microsoftId, draftId.trim(), updatePayload);
        break;
      }

      case 'listDrafts': {
        const safeParams = typeof params === 'object' && params !== null ? params : {};
        result = await gmailSvc.listDrafts(req.user.microsoftId, safeParams);
        break;
      }

      case 'getDraft': {
        const draftId = params?.draftId;
        if (typeof draftId !== 'string' || draftId.trim().length === 0) {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'Missing required field: draftId',
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'getDraft', params: { draftId: 'string' } }
          });
        }

        result = await gmailSvc.getDraft(req.user.microsoftId, draftId.trim(), {
          format: typeof params.format === 'string' ? params.format : undefined
        });
        break;
      }

      case 'reply':
        result = await gmailSvc.replyToEmail(
          req.user.microsoftId,
          params.messageId,
          params
        );
        break;

      case 'modify':
        result = await Promise.all(
          (params.ids || []).map(id =>
            gmailSvc.modifyMessageLabels(req.user.microsoftId, id, params.actions)
          )
        );
        break;

      case 'attachmentPreview':
        if (params.mode === 'text') {
          result = await gmailSvc.previewAttachmentText(
            req.user.microsoftId,
            params.messageId,
            params.attachmentId,
            params.maxKb || 256
          );
        } else if (params.mode === 'table') {
          result = await gmailSvc.previewAttachmentTable(
            req.user.microsoftId,
            params.messageId,
            params.attachmentId,
            {
              maxRows: Math.min(params.maxRows || 200, 200),
              delimiter: params.delimiter || 'auto'
            }
          );
        }
        break;

      case 'labels': {
        if (params.list) {
          const includeMatchesFor = params.includeMatchesFor || params.search || params.lookup;
          const options = {};
          if (typeof includeMatchesFor !== 'undefined') {
            options.includeMatchesFor = Array.isArray(includeMatchesFor)
              ? includeMatchesFor
              : [includeMatchesFor];
          }
          if (params.forceRefresh === true) {
            options.forceRefresh = true;
          }
          result = await gmailSvc.listLabels(req.user.microsoftId, options);
        } else if (params.resolve) {
          result = await gmailSvc.resolveLabelIdentifiers(
            req.user.microsoftId,
            params.resolve,
            {
              forceRefresh: params.forceRefresh === true
            }
          );
        } else if (params.modify) {
          // Support batch processing when ids array is provided
          if (Array.isArray(params.modify.ids) && params.modify.ids.length > 0) {
            result = await Promise.all(
              params.modify.ids.map(id =>
                gmailSvc.modifyMessageLabels(req.user.microsoftId, id, {
                  add: params.modify.add,
                  remove: params.modify.remove
                })
              )
            );
          } else {
            result = await gmailSvc.modifyMessageLabels(
              req.user.microsoftId,
              params.modify.messageId || params.modify.ids?.[0],
              {
                add: params.modify.add,
                remove: params.modify.remove
              }
            );
          }
        } else if (params.create) {
          result = await gmailSvc.createLabel(req.user.microsoftId, params.create);
        } else {
          return res.status(400).json({
            error: 'Bad request',
            message: 'labels operation requires one of: params.list, params.resolve, params.modify, or params.create',
            code: 'INVALID_PARAM',
            expectedFormat: {
              list: { op: 'labels', params: { list: true } },
              resolve: { op: 'labels', params: { resolve: ['label1', 'label2'] } },
              modify: { op: 'labels', params: { modify: { messageId: 'id', add: ['label'], remove: [] } } },
              create: { op: 'labels', params: { create: { name: 'LabelName' } } }
            }
          });
        }
        break;
      }
        
      default:
        return res.status(400).json({
          error: 'Bad request',
          message: `Unknown operation: ${op}`,
          code: 'INVALID_PARAM'
        });
    }

    // Safety check: result should never be undefined after successful operation
    if (result === undefined) {
      console.error(`⚠️ Mail RPC operation "${op}" completed but result is undefined`);
      return res.status(500).json({
        error: 'Internal server error',
        message: `Operation "${op}" completed but produced no result. This may indicate a configuration issue.`,
        code: 'UNDEFINED_RESULT'
      });
    }

    res.json({
      ok: true,
      data: result
    });

  } catch (error) {
    console.error('❌ Mail RPC failed:', error.message);

    // Check if error requires re-authentication
    if (error.requiresReauth === true ||
        error.code === 'GOOGLE_UNAUTHORIZED' ||
        error.statusCode === 401 ||
        error.statusCode === 403) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required',
        message: error.message || 'You need to re-authenticate to access Gmail.',
        code: error.code || 'GOOGLE_UNAUTHORIZED',
        details: error.details,
        requiresReauth: true
      });
    }

    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = error.code || (status === 451 ? 'ATTACHMENT_BLOCKED' : 'SERVER_ERROR');

    const payload = {
      ok: false,
      error: error.message,
      code
    };

    if (error.details) {
      payload.details = error.details;
    }

    res.status(status).json(payload);
  }
}

// ==================== CALENDAR RPC ====================

async function calendarRpc(req, res) {
  try {
    const { op, params } = req.body;
    
    if (!op) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Missing required field: op',
        code: 'INVALID_PARAM'
      });
    }
    
    let result;
    
    switch (op) {
      case 'list': {
        const { calendarId = 'primary', ...rest } = params;
        result = await calendarService.listCalendarEvents(req.user.microsoftId, {
          calendarId,
          ...rest
        });
        break;
      }

      case 'get': {
        const { calendarId = 'primary', eventId } = params;
        result = await calendarService.getCalendarEvent(
          req.user.microsoftId,
          eventId,
          { calendarId }
        );
        break;
      }

      case 'create': {
        const { calendarId = 'primary', ...eventData } = params;
        result = await calendarService.createCalendarEvent(
          req.user.microsoftId,
          eventData,
          { calendarId }
        );
        break;
      }
        
      case 'update': {
        // FIXED: Validate calendar update structure
        if (!params || !params.eventId) {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'params.eventId is required for update operation',
            code: 'INVALID_PARAM'
          });
        }

        if (!params.updates) {
          return res.status(400).json({
            error: 'Invalid request format',
            message: 'params.updates object is required',
            code: 'INVALID_PARAM'
          });
        }

        // Validate start/end structure if present
        if (params.updates.start || params.updates.end) {
          const validateTimeField = (field, fieldName) => {
            if (!field) return null; // Optional
            if (!field.dateTime) {
              return `${fieldName}.dateTime is required (ISO 8601 format, e.g., "2025-10-21T15:00:00")`;
            }
            if (!field.timeZone) {
              return `${fieldName}.timeZone is required (e.g., "Europe/Prague")`;
            }
            return null;
          };

          const startError = validateTimeField(params.updates.start, 'start');
          if (startError) {
            return res.status(400).json({
              error: 'Invalid request format',
              message: startError,
              code: 'INVALID_TIME_FORMAT',
              expectedFormat: {
                start: { dateTime: 'ISO8601 string', timeZone: 'string' },
                end: { dateTime: 'ISO8601 string', timeZone: 'string' }
              }
            });
          }

          const endError = validateTimeField(params.updates.end, 'end');
          if (endError) {
            return res.status(400).json({
              error: 'Invalid request format',
              message: endError,
              code: 'INVALID_TIME_FORMAT',
              expectedFormat: {
                start: { dateTime: 'ISO8601 string', timeZone: 'string' },
                end: { dateTime: 'ISO8601 string', timeZone: 'string' }
              }
            });
          }
        }

        const { calendarId = 'primary' } = params;

        result = await calendarService.updateCalendarEvent(
          req.user.microsoftId,
          params.eventId,
          params.updates,
          { calendarId }
        );
        break;
      }

      case 'delete':
        result = await calendarService.deleteCalendarEvent(
          req.user.microsoftId,
          params.eventId,
          { calendarId: params.calendarId || 'primary' }
        );
        break;

      case 'checkConflicts':
        if (!params.start || !params.end) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'Missing required fields: start, end',
            code: 'INVALID_PARAM'
          });
        }
        result = await calendarService.checkConflicts(req.user.microsoftId, {
          calendarId: params.calendarId || 'primary',
          start: params.start,
          end: params.end,
          excludeEventId: params.excludeEventId
        });
        break;
        
      default:
        return res.status(400).json({
          error: 'Bad request',
          message: `Unknown operation: ${op}`,
          code: 'INVALID_PARAM'
        });
    }
    
    res.json({
      ok: true,
      data: result
    });
    
  } catch (error) {
    console.error('❌ Calendar RPC failed:', error.message);

    // Check if error requires re-authentication
    if (error.requiresReauth === true ||
        error.code === 'GOOGLE_UNAUTHORIZED' ||
        error.statusCode === 401 ||
        error.statusCode === 403) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required',
        message: error.message || 'You need to re-authenticate to access Google Calendar.',
        code: error.code || 'GOOGLE_UNAUTHORIZED',
        details: error.details,
        requiresReauth: true
      });
    }

    if (error.statusCode === 409) {
      return res.status(409).json({
        ok: false,
        error: 'Conflict',
        message: error.message,
        code: 'CONFLICT',
        alternatives: error.alternatives || []
      });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    res.status(statusCode).json({
      ok: false,
      error: error.message || 'Calendar operation failed',
      code: error.code || 'CALENDAR_ERROR'
    });
  }
}

// ==================== CONTACTS RPC ====================

async function contactsRpc(req, res) {
  try {
    let { op, params } = req.body;
    
    if (!op) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Missing required field: op',
        code: 'INVALID_PARAM'
      });
    }

    // ✅ FALLBACK: If params not provided, try to extract from root level
    // This handles both:
    // 1. {op: 'add', params: {name, email, ...}}
    // 2. {op: 'add', name, email, ...}
    if (!params) {
      params = {};
      const possibleParamKeys = [
        'email', 'name', 'phone', 'realestate', 'notes',
        'query', 'contacts', 'emails', 'rowIds',
        'eventId', 'updates', 'taskListId', 'taskId',
        'includeSheetUrl'
      ];
      
      for (const key of possibleParamKeys) {
        if (key in req.body && key !== 'op') {
          params[key] = req.body[key];
        }
      }
    }
    
    let result;
    
    const mutationRedirect = (operation) => {
      const redirectMap = {
        update: '/api/contacts/actions/modify',
        delete: '/api/contacts/actions/delete',
        bulkDelete: '/api/contacts/actions/bulkDelete'
      };

      return res.status(410).json({
        ok: false,
        error: 'Contacts RPC mutation disabled',
        message: `The contacts RPC no longer supports the \"${operation}\" operation. Call the dedicated facade endpoint instead.`,
        code: 'CONTACTS_RPC_MUTATION_DISABLED',
        endpoints: redirectMap
      });
    };

    switch (op) {
      case 'list': {
        const { contacts, spreadsheetId } = await contactsSvc.listAllContacts(req.user.accessToken);
        result = {
          contacts,
          sheetUrl: generateSheetUrl(spreadsheetId),
          assistantHint: "Link na Google Sheet poskytni uživateli JEN když explicitně chce vidět/procházet všechny kontakty. Pokud jen potřebuješ email pro jiný úkol (např. přidat attendee), link neukazuj."
        };
        break;
      }

      case 'search':
        if (!params || !params.query) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'search requires params.query',
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'search', params: { query: 'string' } }
          });
        }
        {
          const { contacts, spreadsheetId } = await contactsSvc.searchContacts(req.user.accessToken, params.query);
          result = {
            contacts,
            sheetUrl: generateSheetUrl(spreadsheetId),
            assistantHint: "Link na Google Sheet poskytni uživateli JEN když explicitně chce vidět výsledky vyhledávání v Sheets. Pokud jen potřebuješ najít email pro jiný úkol, link neukazuj."
          };
        }
        break;
        
      case 'add':
        if (!params || !params.email || !params.name) {
          return res.status(400).json({
            error: 'Bad request',
        message: 'add requires params: {name, email, phone?, realEstate?, notes?}',
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'add', params: { name: 'string', email: 'string', notes: 'string?', realEstate: 'string?', phone: 'string?' } }
          });
        }
        result = await contactsSvc.addContact(req.user.accessToken, params);
        break;
        
      case 'update':
        return mutationRedirect('update');

      case 'delete':
        return mutationRedirect('delete');
        
      case 'dedupe':
        result = await contactsSvc.findDuplicates(req.user.accessToken);
        break;
        
      case 'bulkUpsert':
        if (!params || !params.contacts || !Array.isArray(params.contacts)) {
          return res.status(400).json({
            error: 'Bad request',
        message: 'bulkUpsert requires params: {contacts: [{name, email, phone?, realEstate?, notes?}]}',
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'bulkUpsert', params: { contacts: [{ name: 'string', email: 'string' }] } }
          });
        }
        result = await contactsSvc.bulkUpsert(req.user.accessToken, params.contacts);
        break;
        
      case 'bulkDelete':
        return mutationRedirect('bulkDelete');
        
      case 'addressSuggest':
        if (!params || !params.query) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'addressSuggest requires params.query',
            code: 'INVALID_PARAM',
            expectedFormat: { op: 'addressSuggest', params: { query: 'partial name or email' } }
          });
        }
        result = await contactsSvc.getAddressSuggestions(req.user.accessToken, params.query);
        break;
        
      default:
        return res.status(400).json({
          error: 'Bad request',
          message: `Unknown operation: ${op}`,
          code: 'INVALID_PARAM'
        });
    }
    
    res.json({
      ok: true,
      data: result
    });
    
  } catch (error) {
    console.error('❌ Contacts RPC failed:', error.message);

    // Check if error requires re-authentication (via requiresReauth flag or specific codes)
    if (error.requiresReauth === true ||
        error.code === 'GOOGLE_UNAUTHORIZED' ||
        error.statusCode === 401 ||
        error.statusCode === 403) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required',
        message: error.message || 'You need to re-authenticate to access Google Sheets and Drive.',
        code: error.code || 'GOOGLE_UNAUTHORIZED',
        details: error.details,
        requiresReauth: true,
        hint: 'User needs to re-authenticate via OAuth to grant necessary scopes (Drive/Sheets access).'
      });
    }

    // Return error with proper status code and details
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    res.status(statusCode).json({
      ok: false,
      error: error.message || 'Contacts operation failed',
      code: error.code || 'CONTACTS_ERROR',
      details: error.details
    });
  }
}

// ==================== TASKS RPC ====================

async function tasksRpc(req, res) {
  try {
    let { op, params } = req.body;

    if (!op) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Missing required field: op',
        code: 'INVALID_PARAM'
      });
    }

    if (!params || typeof params !== 'object') {
      const fallbackKeys = {
        list: ['taskListId', 'maxResults', 'pageToken', 'showCompleted'],
        get: ['taskListId', 'taskId'],
        complete: ['taskListId', 'taskId'],
        reopen: ['taskListId', 'taskId']
      }[op] || [];

      if (fallbackKeys.length > 0) {
        const fallback = {};
        for (const key of fallbackKeys) {
          if (Object.prototype.hasOwnProperty.call(req.body, key)) {
            fallback[key] = req.body[key];
          }
        }

        if (Object.keys(fallback).length > 0 || op === 'list') {
          params = fallback;
        }
      }
    }

    if (!params) {
      params = {};
    }

    const mutationRedirect = (operation) => {
      const endpoints = {
        create: '/api/tasks/actions/create',
        modify: '/api/tasks/actions/modify',
        delete: '/api/tasks/actions/delete'
      };

      const hintMap = {
        create: 'POST /api/tasks/actions/create with {title, notes?, due?}',
        update: 'POST /api/tasks/actions/modify with {taskListId, taskId, ...updates}',
        complete: 'POST /api/tasks/actions/modify with {taskListId, taskId, status: "completed"}',
        reopen: 'POST /api/tasks/actions/modify with {taskListId, taskId, status: "needsAction"}',
        delete: 'POST /api/tasks/actions/delete with {taskListId, taskId}'
      };

      return res.status(410).json({
        ok: false,
        error: 'Tasks RPC mutation disabled',
        message: `The tasks RPC no longer supports the "${operation}" operation. Call the dedicated facade endpoint instead.`,
        code: 'TASKS_RPC_MUTATION_DISABLED',
        endpoints,
        hint: hintMap[operation]
      });
    };

    switch (op) {
      case 'list': {
        const result = await tasksSvc.listTasks(req.user.microsoftId, params);
        return res.json({
          ok: true,
          data: result
        });
      }

      case 'get':
        return res.status(501).json({
          error: 'Not implemented',
          message: 'Get single task not yet implemented',
          code: 'NOT_IMPLEMENTED'
        });

      case 'create':
        return mutationRedirect('create');

      case 'update':
        return mutationRedirect('update');

      case 'delete':
        return mutationRedirect('delete');

      case 'complete':
        return mutationRedirect('complete');

      case 'reopen':
        return mutationRedirect('reopen');

      default:
        return res.status(400).json({
          error: 'Bad request',
          message: `Unknown operation: ${op}`,
          code: 'INVALID_PARAM'
        });
    }
    
  } catch (error) {
    console.error('❌ Tasks RPC failed:', error.message);

    // Check if error requires re-authentication
    if (error.requiresReauth === true ||
        error.code === 'GOOGLE_UNAUTHORIZED' ||
        error.statusCode === 401 ||
        error.statusCode === 403) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required',
        message: error.message || 'You need to re-authenticate to access Google Tasks.',
        code: error.code || 'GOOGLE_UNAUTHORIZED',
        details: error.details,
        requiresReauth: true
      });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    res.status(statusCode).json({
      ok: false,
      error: error.message || 'Tasks operation failed',
      code: error.code || 'TASKS_ERROR'
    });
  }
}

const traced = wrapModuleFunctions('controllers.rpcController', {
  mailRpc,
  calendarRpc,
  contactsRpc,
  tasksRpc,
});

const {
  mailRpc: tracedMailRpc,
  calendarRpc: tracedCalendarRpc,
  contactsRpc: tracedContactsRpc,
  tasksRpc: tracedTasksRpc,
} = traced;

export {
  tracedMailRpc as mailRpc,
  tracedCalendarRpc as calendarRpc,
  tracedContactsRpc as contactsRpc,
  tracedTasksRpc as tasksRpc,
};
