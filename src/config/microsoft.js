/**
 * Microsoft OAuth 2.0 Configuration
 *
 * Provides OAuth authentication for Microsoft Identity Platform (Azure AD).
 * This is a replacement for Google OAuth (oauth.js) to support Microsoft services:
 * - Outlook Mail (replacing Gmail)
 * - Outlook Calendar (replacing Google Calendar)
 * - Microsoft To Do (replacing Google Tasks)
 * - OneDrive/Excel (replacing Google Drive/Sheets)
 * - Outlook Contacts (replacing Google Contacts)
 *
 * Uses manual token management (not MSAL cache) for compatibility with
 * existing database token storage.
 *
 * @module microsoft
 */

import dotenv from 'dotenv';
import fetch from 'isomorphic-fetch';

dotenv.config();

// Environment variables
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'common';
const REDIRECT_URI = process.env.REDIRECT_URI;

// Validate required environment variables
if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !REDIRECT_URI) {
  console.error('❌ Missing required Microsoft OAuth credentials in .env:');
  if (!MICROSOFT_CLIENT_ID) console.error('  - MICROSOFT_CLIENT_ID');
  if (!MICROSOFT_CLIENT_SECRET) console.error('  - MICROSOFT_CLIENT_SECRET');
  if (!REDIRECT_URI) console.error('  - REDIRECT_URI');
  console.error('\n💡 Tip: Create Azure AD app registration at https://portal.azure.com');
  console.error('   and add these variables to your .env file.');
  process.exit(1);
}

/**
 * Microsoft Graph API scopes
 *
 * IMPORTANT: 'offline_access' is REQUIRED to receive refresh tokens!
 */
const SCOPES = [
  // OpenID Connect scopes
  'openid',
  'profile',
  'email',
  'offline_access',  // CRITICAL: Required for refresh token!

  // Mail scopes
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',

  // Calendar scopes
  'Calendars.Read',
  'Calendars.ReadWrite',

  // Tasks/To Do scopes
  'Tasks.ReadWrite',

  // Files/OneDrive scopes (for Excel contacts file)
  'Files.ReadWrite',
  'Files.ReadWrite.All',

  // Contacts scopes
  'Contacts.Read',
  'Contacts.ReadWrite',

  // User profile
  'User.Read'
];

/**
 * Microsoft OAuth endpoints
 */
const AUTHORITY = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`;
const AUTHORIZE_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/token`;
const GRAPH_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me';

/**
 * Generates authorization URL for Microsoft OAuth flow
 *
 * @param {string} state - State parameter for CSRF protection
 * @param {Object} [pkceParams={}] - PKCE parameters
 * @param {string} [pkceParams.code_challenge] - PKCE code challenge
 * @param {string} [pkceParams.code_challenge_method='S256'] - PKCE challenge method
 * @returns {string} Authorization URL to redirect user to
 *
 * @example
 * const authUrl = getAuthUrl('random-state', {
 *   code_challenge: 'challenge-string',
 *   code_challenge_method: 'S256'
 * });
 * res.redirect(authUrl);
 */
export function getAuthUrl(state, pkceParams = {}) {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state: state || 'default_state',
    prompt: 'consent'  // Force consent screen to ensure all scopes granted
  });

  // Add PKCE parameters if provided (RFC 7636)
  if (pkceParams.code_challenge) {
    params.append('code_challenge', pkceParams.code_challenge);
    params.append('code_challenge_method', pkceParams.code_challenge_method || 'S256');
  }

  const authUrl = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;

  console.log('🔐 [MICROSOFT_AUTH] Generated authorization URL');
  console.log('Scopes:', SCOPES.join(', '));

  return authUrl;
}

/**
 * Exchanges authorization code for tokens
 *
 * This uses direct HTTP calls (not MSAL) for explicit refresh token access,
 * allowing storage in database (compatible with existing alfred2 architecture).
 *
 * @param {string} code - Authorization code from callback
 * @param {string|null} [codeVerifier=null] - PKCE code verifier (if using PKCE)
 * @returns {Promise<Object>} Token response
 * @returns {string} return.access_token - Access token for API calls
 * @returns {string} return.refresh_token - Refresh token for token renewal
 * @returns {number} return.expires_in - Token expiration in seconds
 * @returns {string} return.token_type - Token type (usually "Bearer")
 * @returns {string} return.scope - Granted scopes (space-separated)
 * @returns {string} return.id_token - ID token with user info
 * @throws {Error} If token exchange fails
 *
 * @example
 * const tokens = await getTokensFromCode(authCode, codeVerifier);
 * // {
 * //   access_token: "...",
 * //   refresh_token: "...",
 * //   expires_in: 3600,
 * //   token_type: "Bearer",
 * //   scope: "openid profile email offline_access Mail.Read ...",
 * //   id_token: "..."
 * // }
 */
export async function getTokensFromCode(code, codeVerifier = null) {
  try {
    console.log('🔄 [MICROSOFT_AUTH] Exchanging authorization code for tokens...');

    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' ')
    });

    // Add PKCE code verifier if provided
    if (codeVerifier) {
      params.append('code_verifier', codeVerifier);
      console.log('🔒 Using PKCE for enhanced security');
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ [MICROSOFT_AUTH_ERROR] Token exchange failed');
      console.error('Error:', data.error);
      console.error('Description:', data.error_description);

      throw new Error(
        `Microsoft token exchange failed: ${data.error_description || data.error}`
      );
    }

    // Validate that we received necessary tokens
    if (!data.access_token) {
      throw new Error('Access token missing from Microsoft response');
    }

    if (!data.refresh_token) {
      console.warn('⚠️ Refresh token missing! Check if offline_access scope is granted.');
    }

    console.log('✅ [MICROSOFT_AUTH] Tokens received successfully');
    console.log('Token expiration:', data.expires_in, 'seconds');
    console.log('Granted scopes:', data.scope);

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      token_type: data.token_type,
      scope: data.scope,
      id_token: data.id_token,
      // Add expiry_date for compatibility with Google format
      expiry_date: Date.now() + (data.expires_in * 1000)
    };

  } catch (error) {
    console.error('❌ [MICROSOFT_AUTH_ERROR] Failed to exchange authorization code');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Refreshes access token using refresh token
 *
 * Uses manual HTTP request (not MSAL cache) to get explicit refresh token
 * in response, allowing storage in database.
 *
 * IMPORTANT: Microsoft implements refresh token rotation!
 * - Always save the NEW refresh_token from the response
 * - Old refresh token may still work but could be revoked
 *
 * @param {string} refreshToken - Current refresh token
 * @returns {Promise<Object>} New tokens
 * @returns {string} return.access_token - New access token
 * @returns {string} return.refresh_token - New refresh token (SAVE THIS!)
 * @returns {number} return.expires_in - Token expiration in seconds
 * @throws {Error} If refresh fails (token expired, revoked, or invalid)
 *
 * @example
 * const newTokens = await refreshAccessToken(user.refresh_token);
 * // IMPORTANT: Save the new refresh_token!
 * await updateUserTokens(userId, {
 *   access_token: newTokens.access_token,
 *   refresh_token: newTokens.refresh_token,  // ← NEW token!
 *   token_expiry: calculateExpiry(newTokens.expires_in)
 * });
 */
export async function refreshAccessToken(refreshToken) {
  try {
    console.log('🔄 [MICROSOFT_AUTH] Refreshing access token...');

    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES.join(' ')
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle specific error cases
      if (data.error === 'invalid_grant') {
        console.error('❌ [MICROSOFT_AUTH_ERROR] Refresh token expired or revoked');
        console.error('User must re-authenticate');
      } else {
        console.error('❌ [MICROSOFT_AUTH_ERROR] Token refresh failed');
        console.error('Error:', data.error);
        console.error('Description:', data.error_description);
      }

      throw new Error(
        `Microsoft token refresh failed: ${data.error_description || data.error}`
      );
    }

    console.log('✅ [MICROSOFT_AUTH] Access token refreshed successfully');
    console.log('New token expiration:', data.expires_in, 'seconds');

    if (data.refresh_token) {
      console.log('🔄 New refresh token received (token rotation)');
    } else {
      console.warn('⚠️ No new refresh token in response (using existing)');
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,  // Use new or fallback to existing
      expires_in: data.expires_in,
      token_type: data.token_type,
      scope: data.scope,
      id_token: data.id_token,
      // Add expiry_date for compatibility with Google format
      expiry_date: Date.now() + (data.expires_in * 1000)
    };

  } catch (error) {
    console.error('❌ [MICROSOFT_AUTH_ERROR] Failed to refresh access token');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Gets user info from Microsoft Graph API
 *
 * Equivalent to Google's oauth2.userinfo.get()
 *
 * @param {string} accessToken - Valid access token
 * @returns {Promise<Object>} User information
 * @returns {string} return.id - Microsoft user ID (use as 'sub' equivalent)
 * @returns {string} return.email - User's email address
 * @returns {boolean} return.verified_email - Always true for Microsoft accounts
 * @returns {string} return.name - User's display name
 * @returns {string} return.given_name - User's first name
 * @returns {string} return.family_name - User's last name
 * @throws {Error} If user info fetch fails
 *
 * @example
 * const userInfo = await getUserInfo(accessToken);
 * // {
 * //   id: "microsoft-user-id",
 * //   email: "user@outlook.com",
 * //   verified_email: true,
 * //   name: "John Doe",
 * //   given_name: "John",
 * //   family_name: "Doe"
 * // }
 */
export async function getUserInfo(accessToken) {
  try {
    console.log('👤 [MICROSOFT_AUTH] Fetching user info...');

    const response = await fetch(GRAPH_ME_ENDPOINT, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Failed to get user info: ${error.error?.message || response.statusText}`
      );
    }

    const data = await response.json();

    // Microsoft Graph /me response:
    // {
    //   id: "...",
    //   userPrincipalName: "user@outlook.com",
    //   mail: "user@outlook.com",
    //   displayName: "John Doe",
    //   givenName: "John",
    //   surname: "Doe",
    //   ...
    // }

    console.log('✅ [MICROSOFT_AUTH] User info retrieved');
    console.log('User:', data.displayName, `(${data.mail || data.userPrincipalName})`);

    // Convert to Google-like format for compatibility with existing alfred2 code
    return {
      id: data.id,  // Use as google_sub equivalent
      email: data.mail || data.userPrincipalName,
      verified_email: true,  // Microsoft accounts are always verified
      name: data.displayName,
      given_name: data.givenName,
      family_name: data.surname,
      picture: null,  // Can fetch from /me/photo if needed
      // Include Microsoft-specific fields for reference
      _microsoft: {
        userPrincipalName: data.userPrincipalName,
        mail: data.mail,
        jobTitle: data.jobTitle,
        officeLocation: data.officeLocation
      }
    };

  } catch (error) {
    console.error('❌ [MICROSOFT_AUTH_ERROR] Failed to get user info');
    console.error('Details:', error);
    throw error;
  }
}

/**
 * Validates access token by attempting to fetch user info
 *
 * @param {string} accessToken - Access token to validate
 * @returns {Promise<boolean>} True if token is valid
 */
export async function validateToken(accessToken) {
  try {
    await getUserInfo(accessToken);
    return true;
  } catch (error) {
    console.warn('⚠️ Token validation failed:', error.message);
    return false;
  }
}

/**
 * Revokes refresh token (logs user out)
 *
 * Note: Microsoft doesn't provide a standard revocation endpoint for v2.0 tokens.
 * The refresh token will expire naturally based on its lifetime/inactivity.
 *
 * @param {string} refreshToken - Refresh token to revoke
 * @returns {Promise<boolean>} Always returns true (no-op for Microsoft)
 */
export async function revokeToken(refreshToken) {
  console.log('ℹ️ [MICROSOFT_AUTH] Token revocation not supported for Microsoft v2.0 tokens');
  console.log('Token will expire based on lifetime and inactivity policies');
  console.log('Consider deleting token from database to prevent further use');
  return true;
}

// Named exports
export {
  SCOPES,
  AUTHORITY,
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
  GRAPH_ME_ENDPOINT
};

// Default export for convenience
export default {
  getAuthUrl,
  getTokensFromCode,
  refreshAccessToken,
  getUserInfo,
  validateToken,
  revokeToken,
  SCOPES
};
