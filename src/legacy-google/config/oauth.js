import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Validate required environment variables
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !REDIRECT_URI) {
  console.error('❌ Missing required Google OAuth credentials in .env:');
  if (!GOOGLE_CLIENT_ID) console.error('  - GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) console.error('  - GOOGLE_CLIENT_SECRET');
  if (!REDIRECT_URI) console.error('  - REDIRECT_URI');
  process.exit(1);
}

// Full Gmail, Calendar, Drive, and Sheets scopes
const SCOPES = [
  'https://mail.google.com/', // Full Gmail access
  'https://www.googleapis.com/auth/calendar', // Full Calendar access
  'https://www.googleapis.com/auth/drive.file', // Drive access (for finding sheets)
  'https://www.googleapis.com/auth/spreadsheets', // Sheets access (for contacts)
  'https://www.googleapis.com/auth/tasks', // Tasks access
  'openid',
  'email',
  'profile'
];

// Create OAuth2 client
function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

function getAuthUrl(state, pkceParams = {}) {
  const client = createOAuthClient();

  const authParams = {
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to ensure refresh token
    state: state || 'default_state',
    include_granted_scopes: true
  };

  // Add PKCE parameters if provided (RFC 7636)
  if (pkceParams.code_challenge) {
    authParams.code_challenge = pkceParams.code_challenge;
    authParams.code_challenge_method = pkceParams.code_challenge_method || 'S256';
  }

  return client.generateAuthUrl(authParams);
}

async function getTokensFromCode(code, codeVerifier = null) {
  try {
    const client = createOAuthClient();

    // Prepare token request options
    // IMPORTANT: Must include redirect_uri for PKCE verification
    const tokenOptions = {
      code,
      redirect_uri: REDIRECT_URI // Required for PKCE and OAuth security
    };

    // Add PKCE codeVerifier if provided (RFC 7636)
    // NOTE: google-auth-library expects camelCase, not snake_case
    if (codeVerifier) {
      tokenOptions.codeVerifier = codeVerifier;
    }

    const { tokens } = await client.getToken(tokenOptions);
    return tokens;
  } catch (error) {
    console.error('❌ [OAUTH_ERROR] Failed to exchange authorization code for tokens');
    console.error('Details:', {
      errorMessage: error.message,
      code: error.code,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

async function refreshAccessToken(refreshToken) {
  try {
    const client = createOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();

    console.log('✅ Access token refreshed successfully');
    return credentials;
  } catch (error) {
    console.error('❌ [TOKEN_REFRESH_ERROR] Failed to refresh access token');
    console.error('Details:', {
      errorMessage: error.message,
      code: error.code,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

export {
  createOAuthClient,
  getAuthUrl,
  getTokensFromCode,
  refreshAccessToken,
  SCOPES
};
