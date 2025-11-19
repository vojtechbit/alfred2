/**
 * Auth Status Controller
 * Provides authentication status check endpoint
 * Used by ChatGPT to verify if user is logged in
 */

/**
 * Get authentication status
 * GET /api/auth/status
 * 
 * Returns user info if authenticated, triggers OAuth if not
 */
import { handleControllerError } from '../utils/errors.js';
import { debugStep, wrapModuleFunctions } from '../utils/advancedDebugging.js';

async function getAuthStatus(req, res) {
  try {
    // User info is already attached by authMiddleware
    const { email, microsoftId } = req.user;

    console.log('✅ [AUTH_STATUS] User is authenticated:', email);
    debugStep('Auth status confirmed', { email, microsoftId });

    return res.json({
      authenticated: true,
      email: email,
      message: `✅ Přihlášen jako ${email}`,
      google_sub: microsoftId
    });

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'authStatus.getAuthStatus',
      defaultMessage: 'Unable to check authentication status',
      defaultCode: 'AUTH_STATUS_FAILED'
    });
  }
}

const traced = wrapModuleFunctions('controllers.authStatusController', { getAuthStatus });

const { getAuthStatus: tracedGetAuthStatus } = traced;

export { tracedGetAuthStatus as getAuthStatus };
