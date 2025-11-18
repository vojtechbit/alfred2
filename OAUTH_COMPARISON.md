# OAuth Flow - Google vs Microsoft: Detailní srovnání

**Pro projekt:** alfred2
**Datum:** 18.11.2025

---

## 📋 Současná implementace (Google OAuth 2.0)

### Package dependencies:
```json
{
  "googleapis": "^128.0.0"  // → ODSTRANIT
}
```

### Environment variables (.env):
```bash
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
REDIRECT_URI=https://alfred2-oauth-server.onrender.com/oauth/callback
```

### OAuth scopes (src/config/oauth.js):
```javascript
const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/tasks',
  'openid',
  'email',
  'profile'
];
```

### OAuth endpoints (Google):
```javascript
// Authorization URL:
https://accounts.google.com/o/oauth2/v2/auth

// Token endpoint:
https://oauth2.googleapis.com/token

// Userinfo endpoint:
https://www.googleapis.com/oauth2/v2/userinfo
```

### Implementace (src/config/oauth.js):

```javascript
import { google } from 'googleapis';

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
    prompt: 'consent',
    state: state || 'default_state',
    include_granted_scopes: true
  };

  if (pkceParams.code_challenge) {
    authParams.code_challenge = pkceParams.code_challenge;
    authParams.code_challenge_method = pkceParams.code_challenge_method || 'S256';
  }

  return client.generateAuthUrl(authParams);
}

async function getTokensFromCode(code, codeVerifier = null) {
  const client = createOAuthClient();

  const tokenOptions = {
    code,
    redirect_uri: REDIRECT_URI
  };

  if (codeVerifier) {
    tokenOptions.codeVerifier = codeVerifier;
  }

  const { tokens } = await client.getToken(tokenOptions);
  return tokens;
}

async function refreshAccessToken(refreshToken) {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials;
}
```

---

## 🔄 Nová implementace (Microsoft Identity Platform)

### Package dependencies:
```json
{
  "@microsoft/microsoft-graph-client": "^3.0.7",  // → PŘIDAT
  "@azure/msal-node": "^2.6.0",                   // → PŘIDAT
  "isomorphic-fetch": "^3.0.0"                    // → PŘIDAT (peer dependency)
}
```

**Instalace:**
```bash
npm uninstall googleapis
npm install @microsoft/microsoft-graph-client @azure/msal-node isomorphic-fetch
```

### Environment variables (.env):
```bash
# Microsoft OAuth (nové)
MICROSOFT_CLIENT_ID=<azure-app-client-id>
MICROSOFT_CLIENT_SECRET=<azure-app-client-secret>
MICROSOFT_TENANT_ID=common  # nebo: organizations, consumers, {tenant-guid}

# Redirect URI (stejné)
REDIRECT_URI=https://alfred2-oauth-server.onrender.com/oauth/callback

# Proxy OAuth (pro ChatGPT - beze změny)
OAUTH_CLIENT_ID=mcp1-oauth-client
OAUTH_CLIENT_SECRET=<secure-secret>
```

### OAuth scopes (Microsoft Graph):
```javascript
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',  // KRITICKÉ! Bez toho nedostaneš refresh token

  // Microsoft Graph scopes (všechny musí mít prefix)
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Tasks.ReadWrite',
  'https://graph.microsoft.com/Files.ReadWrite',
  'https://graph.microsoft.com/Files.ReadWrite.All',
  'https://graph.microsoft.com/Contacts.Read',
  'https://graph.microsoft.com/Contacts.ReadWrite',
  'https://graph.microsoft.com/User.Read'
];

// NEBO kratší verze (bez URL prefix):
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',
  'Files.ReadWrite',
  'Files.ReadWrite.All',
  'Contacts.Read',
  'Contacts.ReadWrite',
  'User.Read'
];
```

### OAuth endpoints (Microsoft):
```javascript
// Tenant-specific (common = všechny typy účtů)
const TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'common';

// Authorization URL:
`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`

// Token endpoint:
`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`

// Userinfo endpoint:
`https://graph.microsoft.com/v1.0/me`
```

### Implementace (NOVÝ src/config/microsoft.js):

```javascript
import { ConfidentialClientApplication } from '@azure/msal-node';
import dotenv from 'dotenv';

dotenv.config();

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
  process.exit(1);
}

// Microsoft Graph scopes
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access', // MUST have for refresh token!
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',
  'Files.ReadWrite',
  'Files.ReadWrite.All',
  'Contacts.Read',
  'Contacts.ReadWrite',
  'User.Read'
];

// MSAL configuration
const msalConfig = {
  auth: {
    clientId: MICROSOFT_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`,
    clientSecret: MICROSOFT_CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback(loglevel, message, containsPii) {
        if (!containsPii) {
          console.log('[MSAL]', message);
        }
      },
      piiLoggingEnabled: false,
      logLevel: 'Info',
    }
  }
};

// Create MSAL client instance
let msalClient = null;

function getMsalClient() {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication(msalConfig);
  }
  return msalClient;
}

/**
 * Generate authorization URL for Microsoft OAuth
 *
 * @param {string} state - State parameter for CSRF protection
 * @param {Object} pkceParams - PKCE parameters (code_challenge, code_challenge_method)
 * @returns {Promise<string>} Authorization URL
 */
async function getAuthUrl(state, pkceParams = {}) {
  const client = getMsalClient();

  const authCodeUrlParameters = {
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    state: state || 'default_state',
    prompt: 'consent', // Force consent to ensure all scopes granted
    responseMode: 'query', // Return code as query parameter
  };

  // Add PKCE parameters if provided (RFC 7636)
  if (pkceParams.code_challenge) {
    authCodeUrlParameters.codeChallenge = pkceParams.code_challenge;
    authCodeUrlParameters.codeChallengeMethod = pkceParams.code_challenge_method || 'S256';
  }

  try {
    const authUrl = await client.getAuthCodeUrl(authCodeUrlParameters);
    return authUrl;
  } catch (error) {
    console.error('❌ [MSAL_ERROR] Failed to generate auth URL');
    console.error('Details:', error);
    throw error;
  }
}

/**
 * Exchange authorization code for tokens
 *
 * @param {string} code - Authorization code from callback
 * @param {string|null} codeVerifier - PKCE code verifier (if using PKCE)
 * @returns {Promise<Object>} Token response
 */
async function getTokensFromCode(code, codeVerifier = null) {
  try {
    const client = getMsalClient();

    const tokenRequest = {
      code,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
    };

    // Add PKCE code verifier if provided
    if (codeVerifier) {
      tokenRequest.codeVerifier = codeVerifier;
    }

    const response = await client.acquireTokenByCode(tokenRequest);

    // MSAL response structure:
    // {
    //   accessToken: "...",
    //   idToken: "...",
    //   account: { ... },
    //   expiresOn: Date,
    //   extExpiresOn: Date,
    //   ...
    // }

    // Note: MSAL doesn't explicitly return refresh_token in response
    // It's stored internally and used automatically with acquireTokenSilent()
    // For our database storage, we need to extract it differently

    // Convert to Google-like format for compatibility
    return {
      access_token: response.accessToken,
      id_token: response.idToken,
      expires_in: Math.floor((response.expiresOn.getTime() - Date.now()) / 1000),
      token_type: 'Bearer',
      scope: response.scopes.join(' '),
      // Note: refresh_token handling will be different - see below
      account: response.account, // Microsoft-specific: user account info
    };

  } catch (error) {
    console.error('❌ [MSAL_ERROR] Failed to exchange authorization code for tokens');
    console.error('Details:', {
      errorMessage: error.message,
      errorCode: error.errorCode,
      errorMessage: error.errorMessage,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 *
 * NOTE: MSAL handles refresh tokens differently than googleapis
 * It uses token cache and acquireTokenSilent() method
 *
 * @param {string} refreshToken - Refresh token (not used directly by MSAL)
 * @param {Object} account - Microsoft account object (from initial auth)
 * @returns {Promise<Object>} New token response
 */
async function refreshAccessToken(account) {
  try {
    const client = getMsalClient();

    // MSAL uses silent token acquisition with cached refresh token
    const silentRequest = {
      account: account, // Pass account object from initial auth
      scopes: SCOPES,
      forceRefresh: true, // Force refresh even if cached token is valid
    };

    const response = await client.acquireTokenSilent(silentRequest);

    console.log('✅ Access token refreshed successfully');

    return {
      access_token: response.accessToken,
      id_token: response.idToken,
      expires_in: Math.floor((response.expiresOn.getTime() - Date.now()) / 1000),
      token_type: 'Bearer',
      scope: response.scopes.join(' '),
    };

  } catch (error) {
    console.error('❌ [MSAL_ERROR] Failed to refresh access token');
    console.error('Details:', {
      errorMessage: error.message,
      errorCode: error.errorCode,
      timestamp: new Date().toISOString()
    });

    // If silent refresh fails, user needs to re-authenticate
    if (error.errorCode === 'interaction_required') {
      console.error('🔐 Interaction required - user must re-authenticate');
    }

    throw error;
  }
}

/**
 * Alternative: Manual refresh token handling (without MSAL cache)
 * Use this if you want explicit control over refresh tokens
 */
async function refreshAccessTokenManual(refreshToken) {
  try {
    const tokenEndpoint = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES.join(' '),
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Token refresh failed: ${error.error_description || error.error}`);
    }

    const tokens = await response.json();

    console.log('✅ Access token refreshed successfully (manual)');

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token, // New refresh token (rotation)
      id_token: tokens.id_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope,
    };

  } catch (error) {
    console.error('❌ [TOKEN_REFRESH_ERROR] Failed to refresh access token (manual)');
    console.error('Details:', error);
    throw error;
  }
}

/**
 * Get user info from Microsoft Graph
 * (Equivalent to Google's oauth2.userinfo.get())
 */
async function getUserInfo(accessToken) {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${response.statusText}`);
    }

    const userInfo = await response.json();

    // Microsoft Graph /me response:
    // {
    //   id: "...",  // Microsoft user ID (use this as google_sub equivalent)
    //   userPrincipalName: "user@outlook.com",
    //   mail: "user@outlook.com",
    //   displayName: "John Doe",
    //   givenName: "John",
    //   surname: "Doe",
    //   ...
    // }

    // Convert to Google-like format for compatibility
    return {
      id: userInfo.id, // Use as 'sub' or 'google_sub' equivalent
      email: userInfo.mail || userInfo.userPrincipalName,
      verified_email: true, // Microsoft accounts are verified
      name: userInfo.displayName,
      given_name: userInfo.givenName,
      family_name: userInfo.surname,
      picture: null, // Can fetch from /me/photo if needed
    };

  } catch (error) {
    console.error('❌ Failed to get user info');
    console.error('Details:', error);
    throw error;
  }
}

export {
  getMsalClient,
  getAuthUrl,
  getTokensFromCode,
  refreshAccessToken,
  refreshAccessTokenManual,
  getUserInfo,
  SCOPES
};
```

---

## 🔑 Klíčové rozdíly

### 1. **Tenant koncept**

**Google:**
- Žádný tenant, všichni uživatelé jsou na stejném identity provideru
- Authorization URL: `https://accounts.google.com/o/oauth2/v2/auth`

**Microsoft:**
- Podporuje multi-tenancy
- Authorization URL: `https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/authorize`

**Možnosti TENANT ID:**
- `common` - Osobní Microsoft účty (Outlook.com) + Work/School účty (Azure AD)
- `organizations` - Pouze Work/School účty (Azure AD)
- `consumers` - Pouze osobní Microsoft účty (Outlook.com, Hotmail, Live)
- `{tenant-guid}` - Specifický Azure AD tenant

**Doporučení pro alfred2:** Použít `common` pro maximální kompatibilitu.

---

### 2. **Refresh token handling**

**Google (googleapis):**
```javascript
// Explicitní refresh_token v response
const { tokens } = await client.getToken(code);
// tokens.access_token
// tokens.refresh_token  ✅ Dostaneš ho přímo

// Refresh je také explicitní
client.setCredentials({ refresh_token: refreshToken });
const { credentials } = await client.refreshAccessToken();
// credentials.access_token
// credentials.refresh_token  ✅ (může být nový - rotation)
```

**Microsoft (MSAL):**
```javascript
// refresh_token není přímo v response!
const response = await client.acquireTokenByCode(tokenRequest);
// response.accessToken  ✅
// response.refreshToken  ❌ NENÍ! MSAL ho ukládá do cache

// Refresh používá cache a account object
const response = await client.acquireTokenSilent({
  account: account,  // Musíš uložit account object z initial auth!
  scopes: SCOPES,
  forceRefresh: true
});
```

**PROBLÉM pro alfred2:**
- Aktuální databázový model ukládá `encrypted_refresh_token`
- MSAL refresh token ukládá do vlastní cache, ne do response
- **Řešení:** Použít manuální refresh (viz `refreshAccessTokenManual()` výše) NEBO přepracovat token storage

**Doporučení:**
1. **Option A:** Použít MSAL cache - vyžaduje změnu DB schema (ukládat `account` objekt místo refresh_token)
2. **Option B:** Použít manuální refresh - minimální změny DB (pokračovat s refresh_token storage)

**Doporučuji Option B** pro rychlejší migraci.

---

### 3. **Scope format**

**Google:**
```javascript
'https://mail.google.com/'  // Plné URL
'https://www.googleapis.com/auth/calendar'
'openid'  // Bez URL
```

**Microsoft:**
```javascript
// Můžeš použít buď:
'https://graph.microsoft.com/Mail.Read'  // Plné URL

// NEBO:
'Mail.Read'  // Krátký format (doporučeno)

// OpenID scopes NEMAJÍ prefix:
'openid'
'profile'
'email'
'offline_access'  // ⚠️ KRITICKÉ pro refresh token!
```

**⚠️ POZOR:** `offline_access` je POVINNÝ pro získání refresh tokenu!

---

### 4. **User identification**

**Google:**
```javascript
const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
const userInfo = await oauth2.userinfo.get();
// userInfo.data.id  → použít jako google_sub
// userInfo.data.email
```

**Microsoft:**
```javascript
const response = await fetch('https://graph.microsoft.com/v1.0/me', {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
const userInfo = await response.json();
// userInfo.id  → použít jako google_sub equivalent
// userInfo.mail nebo userInfo.userPrincipalName
```

**DB změny:**
- Přejmenovat `google_sub` → `user_id` nebo `provider_user_id`
- Nebo ponechat `google_sub` a uložit Microsoft ID tam (jednodušší)

---

### 5. **Token expiration**

**Google:**
```javascript
tokens.expiry_date  // Timestamp kdy vyprší (milliseconds)
```

**Microsoft:**
```javascript
response.expiresOn  // Date object
// Konverze:
const expiryDate = response.expiresOn.getTime(); // milliseconds
```

---

### 6. **Error handling**

**Google:**
```javascript
try {
  await client.refreshAccessToken();
} catch (error) {
  console.error(error.message);
  console.error(error.code); // HTTP status code
}
```

**Microsoft (MSAL):**
```javascript
try {
  await client.acquireTokenSilent(...);
} catch (error) {
  console.error(error.errorCode);  // e.g., "interaction_required"
  console.error(error.errorMessage);
  console.error(error.subError);
}
```

**Specifické error codes (Microsoft):**
- `interaction_required` - Uživatel musí znovu autentizovat
- `invalid_grant` - Refresh token expired nebo revoked
- `consent_required` - Scopes changed, nutný nový consent

---

## 📦 Database Schema změny

### Současný schema:
```javascript
{
  google_sub: String,  // Google user ID
  email: String,
  encrypted_access_token: String,
  access_token_iv: String,
  access_token_auth_tag: String,
  encrypted_refresh_token: String,
  refresh_token_iv: String,
  refresh_token_auth_tag: String,
  token_expiry: Date,
  created_at: Date,
  updated_at: Date,
  last_used: Date,
  refresh_token_revoked: Boolean
}
```

### Option A: Minimální změny (doporučeno pro rychlou migraci)
```javascript
{
  user_id: String,  // Přejmenovat z google_sub (nebo ponechat google_sub)
  email: String,
  provider: String,  // 'google' nebo 'microsoft' (pokud dual-mode)

  // Token storage - beze změny
  encrypted_access_token: String,
  access_token_iv: String,
  access_token_auth_tag: String,
  encrypted_refresh_token: String,  // Používat manual refresh
  refresh_token_iv: String,
  refresh_token_auth_tag: String,
  token_expiry: Date,

  // Metadata - beze změny
  created_at: Date,
  updated_at: Date,
  last_used: Date,
  refresh_token_revoked: Boolean
}
```

### Option B: MSAL-optimized schema (pokud chceš použít MSAL cache)
```javascript
{
  user_id: String,
  email: String,
  provider: String,

  // Token storage
  encrypted_access_token: String,
  access_token_iv: String,
  access_token_auth_tag: String,

  // Microsoft-specific: Store account object instead of refresh_token
  encrypted_account_object: String,  // Serialized MSAL account object
  account_object_iv: String,
  account_object_auth_tag: String,

  token_expiry: Date,
  created_at: Date,
  updated_at: Date,
  last_used: Date,
  refresh_token_revoked: Boolean
}
```

**Doporučení:** Použít **Option A** s manuálním refresh tokenem pro minimální změny.

---

## 🛠️ Konkrétní změny v souborech

### 1. `src/config/oauth.js` → **NAHRADIT** `src/config/microsoft.js`
- Kompletně nový soubor (viz výše)
- Použít MSAL místo googleapis

### 2. `src/controllers/authController.js`
**Změny:**
```javascript
// PŘED:
import { getAuthUrl, getTokensFromCode } from '../config/oauth.js';
import { google } from 'googleapis';
import { createOAuthClient } from '../config/oauth.js';

const oauth2Client = createOAuthClient();
oauth2Client.setCredentials(tokens);
const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
const userInfoResponse = await oauth2.userinfo.get();
const userInfo = userInfoResponse.data;

// PO:
import { getAuthUrl, getTokensFromCode, getUserInfo } from '../config/microsoft.js';

const userInfo = await getUserInfo(tokens.access_token);
```

### 3. `src/controllers/oauthProxyController.js`
**Změny:**
```javascript
// PŘED:
import { getAuthUrl, getTokensFromCode } from '../config/oauth.js';

// PO:
import { getAuthUrl, getTokensFromCode } from '../config/microsoft.js';

// Minimální změny - většina logiky zůstává stejná
```

### 4. `src/services/databaseService.js`
**Změny:**
- `google_sub` → `user_id` (nebo ponechat google_sub a uložit Microsoft ID)
- Případně přidat `provider` field

### 5. `src/services/backgroundRefreshService.js`
**Změny:**
```javascript
// PŘED:
import { refreshAccessToken } from '../config/oauth.js';

// PO:
import { refreshAccessTokenManual } from '../config/microsoft.js';

// Použít manuální refresh místo MSAL cache
const newTokens = await refreshAccessTokenManual(user.refresh_token);
```

### 6. `package.json`
**Změny:**
```json
{
  "dependencies": {
    // ODSTRANIT:
    // "googleapis": "^128.0.0",

    // PŘIDAT:
    "@microsoft/microsoft-graph-client": "^3.0.7",
    "@azure/msal-node": "^2.6.0",
    "isomorphic-fetch": "^3.0.0"
  }
}
```

---

## ✅ Checklist pro migraci OAuth

- [ ] **Vytvořit Azure AD App Registration**
  - [ ] Získat Client ID a Client Secret
  - [ ] Nakonfigurovat Redirect URI
  - [ ] Přidat API permissions (scopes)
  - [ ] Grant admin consent (pokud potřeba)

- [ ] **Update .env soubor**
  - [ ] Přidat `MICROSOFT_CLIENT_ID`
  - [ ] Přidat `MICROSOFT_CLIENT_SECRET`
  - [ ] Přidat `MICROSOFT_TENANT_ID=common`

- [ ] **Update package.json**
  - [ ] Odinstalovat `googleapis`
  - [ ] Nainstalovat `@microsoft/microsoft-graph-client`
  - [ ] Nainstalovat `@azure/msal-node`
  - [ ] Nainstalovat `isomorphic-fetch`

- [ ] **Vytvořit nový src/config/microsoft.js**
  - [ ] Implementovat `getMsalClient()`
  - [ ] Implementovat `getAuthUrl()`
  - [ ] Implementovat `getTokensFromCode()`
  - [ ] Implementovat `refreshAccessTokenManual()`
  - [ ] Implementovat `getUserInfo()`

- [ ] **Update src/controllers/authController.js**
  - [ ] Změnit imports na microsoft.js
  - [ ] Update getUserInfo() call

- [ ] **Update src/controllers/oauthProxyController.js**
  - [ ] Změnit imports na microsoft.js

- [ ] **Update src/services/databaseService.js**
  - [ ] Přejmenovat google_sub → user_id (optional)
  - [ ] Update saveUser() function

- [ ] **Update src/services/backgroundRefreshService.js**
  - [ ] Změnit import na refreshAccessTokenManual
  - [ ] Update refresh logic

- [ ] **Testing**
  - [ ] Test OAuth flow (authorize → callback → tokens)
  - [ ] Test user info retrieval
  - [ ] Test token refresh
  - [ ] Test error handling

---

## 🎯 Shrnutí

### Co se NEMĚNÍ:
✅ Redirect URI structure (stejná)
✅ State parameter handling (stejný CSRF protection)
✅ PKCE flow (stejný, jen jiné API calls)
✅ ChatGPT OAuth proxy logika (stejná)
✅ Database encryption (stejná)
✅ Express routes structure (stejná)

### Co se MĚNÍ:
❌ OAuth library: googleapis → @azure/msal-node
❌ Authorization endpoint: Google → Microsoft
❌ Token endpoint: Google → Microsoft
❌ Userinfo endpoint: Google OAuth2 → Microsoft Graph /me
❌ Refresh token handling: Explicitní → MSAL cache nebo manuální
❌ Scopes format: Google URLs → Microsoft Graph scopes
❌ Tenant koncept: Žádný → Multi-tenant support

### Doporučený postup:
1. ✅ Vytvořit Azure AD app
2. ✅ Vytvořit nový microsoft.js config
3. ✅ Update controllers (minimální změny)
4. ✅ Testovat OAuth flow izolovaně
5. ✅ Až funguje OAuth, pokračovat na Graph API service layer

**Časový odhad:** 1-2 týdny pro kompletní OAuth migraci včetně testování.
