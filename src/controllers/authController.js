import { getAuthUrl, getTokensFromCode } from '../config/microsoft.js';
import { saveUser } from '../services/databaseService.js';
import { handleControllerError } from '../utils/errors.js';
import { determineExpiryDate } from '../utils/tokenExpiry.js';
import dotenv from 'dotenv';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


dotenv.config();

/**
 * Initiate OAuth flow
 * GET /auth/microsoft
 */
async function initiateOAuth(req, res) {
  try {
    // Generate random state for CSRF protection
    const state = Math.random().toString(36).substring(7);
    
    // Get authorization URL
    const authUrl = getAuthUrl(state);
    
    console.log('🔐 Initiating OAuth flow');
    console.log('Redirect URL:', authUrl);

    // Redirect user to Microsoft consent screen
    res.redirect(authUrl);

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'auth.initiateOAuth',
      defaultMessage: 'Unable to start authentication process',
      defaultCode: 'OAUTH_INIT_FAILED'
    });
  }
}

/**
 * Handle OAuth callback from Microsoft
 * GET /auth/microsoft/callback
 */
async function handleCallback(req, res) {
  try {
    const { code, error, state } = req.query;

    // Check if user denied access
    if (error) {
      console.error('❌ [OAUTH_ERROR] User denied access or error occurred');
      console.error('Error:', error);

      return res.status(400).send(`
        <html>
          <head><title>Authentication Failed</title></head>
          <body style="font-family: Arial; padding: 50px; text-align: center;">
            <h1>❌ Authentication Failed</h1>
            <p>You denied access or an error occurred: ${error}</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    // Check if authorization code is present
    if (!code) {
      console.error('❌ [OAUTH_ERROR] Authorization code missing');
      
      return res.status(400).send(`
        <html>
          <head><title>Authentication Failed</title></head>
          <body style="font-family: Arial; padding: 50px; text-align: center;">
            <h1>❌ Authentication Failed</h1>
            <p>Authorization code not received.</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    console.log('🔄 Exchanging authorization code for tokens...');

    // Exchange authorization code for tokens
    const tokens = await getTokensFromCode(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Access token or refresh token missing from Microsoft response');
    }

    console.log('✅ Tokens received from Microsoft');

    // Get user info from Microsoft Graph API
    const { getUserInfo } = await import('../config/microsoft.js');
    const userInfo = await getUserInfo(tokens.access_token);

    console.log('✅ User info retrieved:', userInfo.email);

    // Calculate token expiry using shared utility
    const expiryDate = determineExpiryDate(tokens);

    // Save user to database with encrypted tokens
    await saveUser({
      microsoftId: userInfo.id,
      email: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: expiryDate
    });

    console.log('✅ User authenticated and saved to database:', userInfo.email);

    // Success page with auto-close for ChatGPT
    res.send(`
      <html>
        <head>
          <title>Authentication Successful</title>
          <meta http-equiv="refresh" content="3;url=https://chat.openai.com">
        </head>
        <body style="font-family: Arial; padding: 50px; text-align: center;">
          <h1>✅ Authentication Successful!</h1>
          <p>You have successfully connected your Microsoft account.</p>
          <p><strong>${userInfo.email}</strong></p>
          <p>Redirecting back to ChatGPT...</p>
          <script>
            // Try to close window (works if opened by ChatGPT)
            setTimeout(() => {
              window.close();
            }, 2000);
          </script>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('❌ [OAUTH_ERROR] Callback handling failed');
    console.error('Details:', {
      errorMessage: error.message,
      errorCode: error.code,
      timestamp: new Date().toISOString()
    });

    res.status(500).send(`
      <html>
        <head><title>Authentication Error</title></head>
        <body style="font-family: Arial; padding: 50px; text-align: center;">
          <h1>❌ Authentication Error</h1>
          <p>Something went wrong during authentication.</p>
          <p>Error: ${error.message}</p>
          <p>Please try again or contact support.</p>
        </body>
      </html>
    `);
  }
}

/**
 * Check authentication status
 * GET /auth/status
 */
async function checkStatus(req, res) {
  try {
    // This endpoint is protected by authMiddleware
    // If we reach here, user is authenticated
    
    res.json({
      authenticated: true,
      user: {
        email: req.user.email,
        microsoftId: req.user.microsoftId,
        name: req.user.name
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'auth.checkStatus',
      defaultMessage: 'Unable to verify authentication status',
      defaultCode: 'AUTH_STATUS_FAILED'
    });
  }
}

const traced = wrapModuleFunctions('controllers.authController', {
  initiateOAuth,
  handleCallback,
  checkStatus,
});

const {
  initiateOAuth: tracedInitiateOAuth,
  handleCallback: tracedHandleCallback,
  checkStatus: tracedCheckStatus,
} = traced;

export {
  tracedInitiateOAuth as initiateOAuth,
  tracedHandleCallback as handleCallback,
  tracedCheckStatus as checkStatus,
};
