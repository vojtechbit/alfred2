import { getAuthUrl, getTokensFromCode } from '../config/microsoft.js';
import { saveUser } from '../services/databaseService.js';
import {
  generateAuthCode,
  generateProxyToken,
  saveAuthCode,
  validateAndConsumeAuthCode,
  saveProxyToken
} from '../services/proxyTokenService.js';
import { microsoft } from 'microsoftapis';
import dotenv from 'dotenv';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { sanitizeForLog, summarizeSecret } from '../utils/redact.js';
import { generatePKCEPair } from '../utils/pkce.js';
import { validateRedirectUri } from '../utils/oauthSecurity.js';
import { determineExpiryDate } from '../utils/tokenExpiry.js';


dotenv.config();

// Client credentials (set in .env and Custom GPT configuration)
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'mcp1-oauth-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 'your-secure-secret-here';

// Note: ChatGPT callback URL comes dynamically from redirect_uri parameter
// Format: https://chat.openai.com/aip/g-{YOUR-GPT-ID}/oauth/callback

/**
 * OAuth Authorization Endpoint
 * GET /oauth/authorize
 * 
 * ChatGPT redirects user here to start OAuth flow
 * We redirect to Microsoft OAuth
 */
async function authorize(req, res) {
  try {
    const { client_id, redirect_uri, state, scope } = req.query;

    console.log('🔐 [OAUTH_PROXY] Authorization request received', {
      clientId: client_id,
      redirectUri: redirect_uri,
      scope: sanitizeForLog(scope),
      state: summarizeSecret(String(state || ''))
    });

    // Validate client_id (optional but recommended)
    if (client_id !== OAUTH_CLIENT_ID) {
      console.error('❌ Invalid client_id:', client_id);
      return res.status(400).json({
        error: 'invalid_client',
        error_description: 'Invalid client_id'
      });
    }

    // Validate redirect_uri with whitelist
    if (!validateRedirectUri(redirect_uri)) {
      console.error('❌ Invalid redirect_uri:', redirect_uri);
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Invalid redirect_uri - must be ChatGPT callback URL'
      });
    }

    // Validate state parameter (required for CSRF protection)
    if (!state) {
      console.error('❌ Missing state parameter');
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing state parameter'
      });
    }

    // Generate PKCE pair for secure OAuth flow (RFC 7636)
    const { codeVerifier, codeChallenge } = generatePKCEPair();

    // Store state + PKCE verifier (we'll need it in callback)
    const stateData = {
      chatgpt_state: state,
      chatgpt_redirect_uri: redirect_uri,
      code_verifier: codeVerifier, // Store for callback
      timestamp: Date.now()
    };

    // Encode state data to pass through Microsoft OAuth
    const encodedState = Buffer.from(JSON.stringify(stateData)).toString('base64url');

    // Get Microsoft OAuth URL with our encoded state and PKCE challenge
    const microsoftAuthUrl = getAuthUrl(encodedState, {
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    console.log('✅ Redirecting to Microsoft OAuth...');

    // Redirect user to Microsoft OAuth consent screen
    res.redirect(microsoftAuthUrl);

  } catch (error) {
    console.error('❌ [OAUTH_PROXY_ERROR] Authorization failed');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      error: 'server_error',
      error_description: 'Authorization failed'
    });
  }
}

/**
 * OAuth Callback Endpoint
 * GET /oauth/callback
 * 
 * Microsoft redirects here after user consent
 * We exchange code for tokens, create proxy token, redirect to ChatGPT
 */
async function callback(req, res) {
  try {
    const { code, error, state } = req.query;

    console.log('🔄 [OAUTH_PROXY] Callback received from Microsoft');

    // Check if user denied access
    if (error) {
      console.error('❌ User denied access or error occurred:', error);
      return res.status(400).send(`
        <html>
          <head><title>Authorization Denied</title></head>
          <body style="font-family: Arial; padding: 50px; text-align: center;">
            <h1>❌ Authorization Denied</h1>
            <p>You denied access or an error occurred: ${error}</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    // Check if authorization code is present
    if (!code) {
      console.error('❌ Authorization code missing');
      return res.status(400).send(`
        <html>
          <head><title>Authorization Failed</title></head>
          <body style="font-family: Arial; padding: 50px; text-align: center;">
            <h1>❌ Authorization Failed</h1>
            <p>Authorization code not received from Microsoft.</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    // Decode state to get ChatGPT redirect info
    let stateData;
    try {
      const decodedState = Buffer.from(state, 'base64url').toString('utf8');
      stateData = JSON.parse(decodedState);
    } catch (err) {
      console.error('❌ Failed to decode state:', err.message);
      return res.status(400).send(`
        <html>
          <head><title>Invalid State</title></head>
          <body style="font-family: Arial; padding: 50px; text-align: center;">
            <h1>❌ Invalid State Parameter</h1>
            <p>The state parameter is invalid or corrupted.</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    console.log('✅ State decoded');

    // Exchange Microsoft authorization code for tokens with PKCE verifier
    console.log('🔄 Exchanging Microsoft code for tokens (with PKCE)...');
    const codeVerifier = stateData.code_verifier;

    if (!codeVerifier) {
      console.error('❌ Missing code_verifier in state (PKCE required)');
      return res.status(400).send(`
        <html>
          <head><title>PKCE Verification Failed</title></head>
          <body style="font-family: Arial; padding: 50px; text-align: center;">
            <h1>❌ Security Verification Failed</h1>
            <p>PKCE code verifier missing. Please restart the authentication flow.</p>
          </body>
        </html>
      `);
    }

    const tokens = await getTokensFromCode(code, codeVerifier);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Access token or refresh token missing from Microsoft response');
    }

    console.log('✅ Microsoft tokens received from Microsoft OAuth');

    // Get user info from Microsoft
    const { createOAuthClient } = await import('../config/oauth.js');
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials(tokens);

    const oauth2 = microsoft.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfoResponse = await oauth2.userinfo.get();
    const userInfo = userInfoResponse.data;

    console.log('✅ User info retrieved:', userInfo.email);

    // Calculate token expiry using shared utility
    const expiryDate = determineExpiryDate(tokens);

    // Save user to database with encrypted Microsoft tokens
    await saveUser({
      microsoftId: userInfo.id,
      email: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: expiryDate
    });

    console.log('✅ User saved to database:', userInfo.email);

    // Generate authorization code for ChatGPT
    const authCode = generateAuthCode();
    
    // Save auth code with mapping to microsoft_sub
    await saveAuthCode({
      authCode: authCode,
      microsoftId: userInfo.id,
      state: stateData.chatgpt_state,
      chatgptRedirectUri: stateData.chatgpt_redirect_uri
    });

    console.log('✅ Auth code generated for ChatGPT');

    // Redirect back to ChatGPT with our authorization code
    const chatgptRedirectUrl = `${stateData.chatgpt_redirect_uri}?code=${authCode}&state=${stateData.chatgpt_state}`;
    
    console.log('✅ Redirecting to ChatGPT:', chatgptRedirectUrl);

    res.redirect(chatgptRedirectUrl);

  } catch (error) {
    console.error('❌ [OAUTH_PROXY_ERROR] Callback handling failed');
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
 * OAuth Token Exchange Endpoint
 * POST /oauth/token
 * 
 * ChatGPT calls this to exchange authorization code for access token
 * We return a proxy token that ChatGPT will use for all API calls
 */
async function token(req, res) {
  try {
    const { grant_type, code, client_id, client_secret, redirect_uri } = req.body;

    console.log('🔐 [OAUTH_PROXY] Token exchange request', {
      grantType: grant_type,
      clientId: client_id,
      redirectUri: redirect_uri,
      code: summarizeSecret(String(code || ''))
    });

    // Validate grant_type
    if (grant_type !== 'authorization_code') {
      console.error('❌ Invalid grant_type:', grant_type);
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant type is supported'
      });
    }

    // Validate client credentials
    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
      console.error('❌ Invalid client credentials');
      return res.status(401).json({
        error: 'invalid_client',
        error_description: 'Invalid client credentials'
      });
    }

    // Validate authorization code
    if (!code) {
      console.error('❌ Missing authorization code');
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing authorization code'
      });
    }

    if (!redirect_uri) {
      console.error('❌ Missing redirect_uri in token request');
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing redirect_uri'
      });
    }

    // Validate and consume authorization code
    const authFlow = await validateAndConsumeAuthCode(code);

    if (!authFlow) {
      console.error('❌ Invalid or expired authorization code');
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid, expired, or already used authorization code'
      });
    }

    const { microsoftId, chatgptRedirectUri } = authFlow;

    if (chatgptRedirectUri !== redirect_uri) {
      console.error('❌ redirect_uri mismatch for authorization code', {
        expectedRedirectUri: chatgptRedirectUri,
        providedRedirectUri: redirect_uri
      });
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match original authorization request'
      });
    }

    console.log('✅ Authorization code validated for user:', microsoftId);

    // Generate proxy token for ChatGPT
    const proxyToken = generateProxyToken();
    const expiresIn = 2592000; // 30 days in seconds

    // Save proxy token with mapping to microsoft_sub
    await saveProxyToken({
      proxyToken: proxyToken,
      microsoftId: microsoftId,
      expiresIn: expiresIn
    });

    console.log('✅ Proxy token generated and saved');

    // Return access token response (OpenAI format)
    const tokenResponse = {
      access_token: proxyToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      // Optional: refresh_token for token refresh flow
      // refresh_token: generateProxyToken()
    };

    console.log('✅ Token response sent to ChatGPT');

    res.json(tokenResponse);

  } catch (error) {
    console.error('❌ [OAUTH_PROXY_ERROR] Token exchange failed');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      error: 'server_error',
      error_description: 'Token exchange failed'
    });
  }
}

const traced = wrapModuleFunctions('controllers.oauthProxyController', {
  authorize,
  callback,
  token,
});

const {
  authorize: tracedAuthorize,
  callback: tracedCallback,
  token: tracedToken,
} = traced;

export {
  tracedAuthorize as authorize,
  tracedCallback as callback,
  tracedToken as token,
};
