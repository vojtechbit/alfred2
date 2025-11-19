/**
 * FILE: src/controllers/confirmationController.js
 * 
 * Handles confirmation workflows for:
 * - calendar.schedule enrichment
 * - contacts.safeAdd deduplication
 */
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


import * as facadeService from '../services/facadeService.js';
import {
  getPendingConfirmation,
  cancelPendingConfirmation
} from '../utils/confirmationStore.js';
import { handleControllerError } from '../utils/errors.js';

/**
 * POST /api/macros/confirm
 * Complete pending confirmation
 */
async function confirmMacroOperation(req, res) {
  try {
    const { confirmToken, action } = req.body;

    if (!confirmToken) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Missing required field: confirmToken',
        code: 'INVALID_PARAM'
      });
    }

    if (!action) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Missing required field: action',
        code: 'INVALID_PARAM'
      });
    }

    // Get pending confirmation to know its type
    const confirmation = await getPendingConfirmation(confirmToken);

    if (!confirmation) {
      return res.status(400).json({
        error: 'Invalid confirmation',
        message: 'Confirmation token expired or not found',
        code: 'CONFIRMATION_EXPIRED',
        hint: 'Please try the operation again from the beginning'
      });
    }

    // Dispatch based on confirmation type
    let result;

    if (confirmation.type === 'enrichment') {
      if (!['auto-fill', 'skip'].includes(action)) {
        return res.status(400).json({
          error: 'Invalid action',
          message: 'For enrichment, action must be: auto-fill or skip',
          code: 'INVALID_PARAM'
        });
      }

      result = await facadeService.completeCalendarScheduleEnrichment(
        req.user.microsoftId,
        confirmToken,
        action
      );
    } else if (confirmation.type === 'deduplication') {
      const normalizedAction = action === 'create' ? 'keepBoth' : action;

      if (!['merge', 'keepBoth', 'skip'].includes(normalizedAction)) {
        return res.status(400).json({
          error: 'Invalid action',
          message:
            'For deduplication, action must be: merge, keepBoth, or skip',
          code: 'INVALID_PARAM'
        });
      }

      result = await facadeService.completeContactsDeduplication(
        req.user.microsoftId,
        confirmToken,
        normalizedAction
      );
    } else {
      return res.status(400).json({
        error: 'Unknown confirmation type',
        message: `Confirmation type not recognized: ${confirmation.type}`,
        code: 'INVALID_PARAM'
      });
    }

    res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'confirmation.confirmMacroOperation',
      defaultMessage: 'Confirmation failed',
      defaultCode: 'CONFIRMATION_FAILED'
    });
  }
}

/**
 * GET /api/macros/confirm/:confirmToken
 * Preview pending confirmation
 */
async function getPendingConfirmationPreview(req, res) {
  try {
    const { confirmToken } = req.params;

    const confirmation = await getPendingConfirmation(confirmToken);

    if (!confirmation) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Confirmation token not found or expired',
        code: 'CONFIRMATION_NOT_FOUND'
      });
    }

    // Return user-friendly preview
    let preview;

    if (confirmation.type === 'enrichment') {
      preview = {
        type: 'enrichment',
        operation: confirmation.data.operation,
        preview: {
          event: {
            title: confirmation.data.eventData.title,
            when: confirmation.data.eventData.when
          },
          suggestedEnrichment: confirmation.data.suggestedFields,
          availableActions: ['auto-fill', 'skip']
        }
      };
    } else if (confirmation.type === 'deduplication') {
      preview = {
        type: 'deduplication',
        operation: confirmation.data.operation,
        preview: {
          entriesToAdd: confirmation.data.entriesToAdd.map(e => ({
            name: e.name,
            email: e.email
          })),
          potentialDuplicates: confirmation.data.duplicateFindings
            .filter(f => f.candidates.length > 0)
            .map(f => ({
              entry: { name: f.entry.name, email: f.entry.email },
              candidates: f.candidates.slice(0, 3)
            })),
          availableActions: ['merge', 'keepBoth', 'skip']
        }
      };
    }

    res.json({
      ok: true,
      confirmToken,
      preview,
      expiresAt: confirmation.expiresAt
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'confirmation.getPendingConfirmationPreview',
      defaultMessage: 'Failed to retrieve confirmation',
      defaultCode: 'CONFIRMATION_PREVIEW_FAILED'
    });
  }
}

/**
 * POST /api/macros/confirm/:confirmToken/cancel
 * Cancel pending confirmation
 */
async function cancelConfirmation(req, res) {
  try {
    const { confirmToken } = req.params;

    const confirmation = await getPendingConfirmation(confirmToken);

    if (!confirmation) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Confirmation token not found or expired',
        code: 'CONFIRMATION_NOT_FOUND'
      });
    }

    await cancelPendingConfirmation(confirmToken);

    res.json({
      ok: true,
      message: 'Confirmation cancelled',
      confirmToken
    });
  } catch (error) {
    return handleControllerError(res, error, {
      context: 'confirmation.cancelConfirmation',
      defaultMessage: 'Failed to cancel confirmation',
      defaultCode: 'CONFIRMATION_CANCEL_FAILED'
    });
  }
}

const traced = wrapModuleFunctions('controllers.confirmationController', {
  confirmMacroOperation,
  getPendingConfirmationPreview,
  cancelConfirmation,
});

const {
  confirmMacroOperation: tracedConfirmMacroOperation,
  getPendingConfirmationPreview: tracedGetPendingConfirmationPreview,
  cancelConfirmation: tracedCancelConfirmation,
} = traced;

export {
  tracedConfirmMacroOperation as confirmMacroOperation,
  tracedGetPendingConfirmationPreview as getPendingConfirmationPreview,
  tracedCancelConfirmation as cancelConfirmation,
};
