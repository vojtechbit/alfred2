# Microsoft Graph API - Technické detaily a náležitosti

**Datum:** 18.11.2025
**Účel:** Klíčové technické detaily pro implementaci migrace alfred2

---

## 📋 Obsah

1. [Rate Limiting a Throttling](#rate-limiting-a-throttling)
2. [Error Handling a Retry Strategie](#error-handling-a-retry-strategie)
3. [Token Management](#token-management)
4. [Timezone Handling](#timezone-handling)
5. [Batch Requests](#batch-requests)
6. [Message Structure](#message-structure)
7. [Calendar Recurrence](#calendar-recurrence)
8. [MSAL Node Konfigurace](#msal-node-konfigurace)

---

## 🚦 Rate Limiting a Throttling

### Základní limity (2025)

| Služba | Limit | Okno | Scope |
|--------|-------|------|-------|
| **Mail/Outlook** | 10,000 requests | 10 minut | Per user, per app |
| **Calendar** | 10,000 requests | 10 minut | Per user, per app |
| **Calendar (burst)** | 4 requests/sec | - | Per app, per mailbox |
| **To Do** | Throttled | Based on tenant | - |

### ⚠️ DŮLEŽITÁ ZMĚNA od 30.9.2025

**Nový limit:** Per-app/per-user/per-tenant limit bude **snížen na polovinu** celkového per-tenant limitu.

**Důvod:** Zabránit jednomu uživateli nebo aplikaci konzumovat celou kvótu v tenantu.

### Throttling Response

**HTTP Status Code:** `429 Too Many Requests`

**Response Headers:**
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 120
```

**Response Body:**
```json
{
  "error": {
    "code": "TooManyRequests",
    "message": "Too many requests",
    "innerError": {
      "date": "2025-11-18T10:30:00",
      "request-id": "...",
      "client-request-id": "..."
    }
  }
}
```

### Best Practices

1. ✅ **VŽDY respektovat `Retry-After` header** - nejrychlejší cesta k recovery
2. ✅ **Implementovat exponential backoff** - pokud `Retry-After` chybí (zejména Intune endpoints)
3. ✅ **Redukovat frekvenci callů** - batch requests kde možné
4. ✅ **Neretryovat okamžitě** - všechny requesty se počítají do usage limits
5. ✅ **Logovat throttling events** - pro monitoring a optimalizaci

### Implementace pro alfred2

```javascript
// src/utils/graphRetry.js
export async function executeWithRetry(apiCall, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      // Throttling errors
      if (error.statusCode === 429 || error.statusCode === 503 || error.statusCode === 504) {

        // Respektovat Retry-After header
        const retryAfter = error.headers?.['retry-after'];
        if (retryAfter) {
          const delay = parseInt(retryAfter) * 1000; // Convert to ms
          console.log(`⏸️ Throttled. Waiting ${retryAfter}s as per Retry-After header`);
          await sleep(delay);
          continue;
        }

        // Fallback: Exponential backoff
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          const jitter = Math.random() * 1000; // 0-1s random jitter
          console.log(`⏸️ Throttled. Exponential backoff: ${delay + jitter}ms`);
          await sleep(delay + jitter);
          continue;
        }
      }

      // Pro jiné errors - throw
      throw error;
    }
  }

  throw new Error('Max retries exceeded');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## 🔧 Error Handling a Retry Strategie

### Klíčové Error Codes

| Code | Kdy nastává | Action |
|------|-------------|--------|
| **429** | Too Many Requests (throttling) | Retry s Retry-After nebo exponential backoff |
| **503** | Service Unavailable | Retry s exponential backoff |
| **504** | Gateway Timeout | Retry s exponential backoff |
| **401** | Unauthorized (token expired) | Refresh token a retry |
| **403** | Forbidden (permission denied) | Neretryovat - chyba konfigurace |
| **404** | Not Found | Neretryovat - resource neexistuje |
| **400** | Bad Request | Neretryovat - chyba v requestu |

### Microsoft Graph SDK - Auto-retry

**DOBRÉ ZPRÁVY:** Microsoft Graph SDK již obsahuje built-in retry handler!

```javascript
import { Client } from '@microsoft/microsoft-graph-client';

const client = Client.init({
  authProvider: (done) => {
    done(null, accessToken);
  }
});

// SDK automaticky handluje:
// - Retry-After header
// - Exponential backoff pro 429, 503, 504
// - Default: 3 retries
```

### Custom Retry Logic (pokud potřeba)

```javascript
const customMiddleware = {
  execute: async function (context, next) {
    try {
      await next();
    } catch (error) {
      if (error.statusCode === 429) {
        const retryAfter = error.headers?.['retry-after'] || 5;
        console.log(`Waiting ${retryAfter}s before retry`);
        await sleep(retryAfter * 1000);
        await next(); // Retry
      } else {
        throw error;
      }
    }
  }
};

const client = Client.initWithMiddleware({
  authProvider: ...,
  middleware: [customMiddleware]
});
```

### Error Response Structure

```json
{
  "error": {
    "code": "ErrorCode",
    "message": "Human-readable error message",
    "innerError": {
      "date": "2025-11-18T10:30:00",
      "request-id": "unique-request-id",
      "client-request-id": "client-provided-id"
    }
  }
}
```

### Best Practices

1. ✅ **Logovat všechny error details** (code, message, request-id)
2. ✅ **Používat request-id pro debugging** s Microsoft supportem
3. ✅ **Neretryovat 4xx errors** (kromě 429) - fix application logic
4. ✅ **Retry pouze 5xx a 429** errors
5. ✅ **Implementovat circuit breaker** pro opakované failures

---

## 🔑 Token Management

### Token Lifetimes

| Token Type | Default Lifetime | Notes |
|------------|------------------|-------|
| **Access Token** | 1 hodina | Nelze prodloužit |
| **Refresh Token (non-SPA)** | 90 dní | Může být delší s conditions |
| **Refresh Token (SPA)** | 24 hodin | Krátká doba pro security |
| **ID Token** | 1 hodina | Stejné jako access token |

### Refresh Token Expiration

**⚠️ KRITICKÉ: Inactivity Expiration**

Refresh token **vyprší po 24 hodinách nečinnosti**, i když má delší lifetime!

**Příklad:**
- Refresh token lifetime: 90 dní
- Uživatel se nepřihlásí 25 hodin
- → Refresh token **NEPLATNÝ**
- → Uživatel musí znovu autentizovat

### Token Rotation

**Microsoft NE-revokuje staré refresh tokeny!**

Při refresh operaci:
1. Získáš nový access token
2. Získáš nový refresh token
3. **Starý refresh token zůstává platný** (do expiration)

**Pro alfred2:** Vždy ukládat **nový** refresh token z response.

### MSAL Token Cache

MSAL používá **interní cache** pro tokeny:

```javascript
import { ConfidentialClientApplication } from '@azure/msal-node';

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${tenant}`,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET
  }
};

const pca = new ConfidentialClientApplication(msalConfig);

// MSAL cache handling (automatické):
// 1. acquireTokenByCode() - uloží tokeny do cache
// 2. acquireTokenSilent() - použije cache, auto-refresh pokud expired

// Silent token acquisition:
const account = {
  homeAccountId: 'user-id',
  environment: 'login.microsoftonline.com',
  tenantId: 'tenant-id',
  username: 'user@example.com'
};

const silentRequest = {
  account: account,
  scopes: SCOPES,
  forceRefresh: false // true = force refresh i když cached token valid
};

try {
  const response = await pca.acquireTokenSilent(silentRequest);
  // response.accessToken
  // response.idToken
  // response.expiresOn (Date object)
} catch (error) {
  if (error.errorCode === 'interaction_required') {
    // User must re-authenticate
    console.error('User needs to re-authenticate');
  }
}
```

### ⚠️ PROBLÉM pro alfred2 Database Storage

**Současný alfred2 model:**
```javascript
{
  encrypted_refresh_token: String,
  token_expiry: Date
}
```

**MSAL cache:**
- MSAL ukládá refresh token do **vlastní cache** (ne do response!)
- Pro přístup k refresh tokenu musíš použít `acquireTokenSilent()` s **account object**

**ŘEŠENÍ A: Manuální token management** (doporučeno pro alfred2)

```javascript
// Nepoužívat MSAL cache - direct HTTP calls
async function refreshAccessTokenManual(refreshToken) {
  const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' ')
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const tokens = await response.json();

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token, // ✅ Nový refresh token!
    expires_in: tokens.expires_in
  };
}
```

**ŘEŠENÍ B: MSAL cache + Store account object**

```javascript
// DB schema změna:
{
  encrypted_account_object: String, // Serialized MSAL account
  account_iv: String,
  account_auth_tag: String,
  token_expiry: Date
}

// Usage:
const account = JSON.parse(decryptedAccountObject);
const response = await pca.acquireTokenSilent({ account, scopes });
```

**Doporučení:** Použít **Řešení A** (manuální) pro minimální změny v alfred2.

### Token Refresh v alfred2

**Současný flow:**
```javascript
// src/services/backgroundRefreshService.js
import { refreshAccessToken } from '../config/oauth.js';

// Každých 30 minut:
const newTokens = await refreshAccessToken(user.refresh_token);
await updateUserTokens(userId, newTokens);
```

**Nový flow (Microsoft):**
```javascript
import { refreshAccessTokenManual } from '../config/microsoft.js';

const newTokens = await refreshAccessTokenManual(user.refresh_token);

// ⚠️ DŮLEŽITÉ: Uložit NOVÝ refresh token!
await updateUserTokens(userId, {
  access_token: newTokens.access_token,
  refresh_token: newTokens.refresh_token, // ← NOVÝ token!
  token_expiry: calculateExpiry(newTokens.expires_in)
});
```

---

## 🌍 Timezone Handling

### IANA vs Windows Timezone Names

**Problém:** Google používá IANA names, Microsoft používá Windows names.

| IANA (Google) | Windows (Microsoft) |
|---------------|---------------------|
| `Europe/Prague` | `Central Europe Standard Time` |
| `UTC` | `UTC` |
| `America/New_York` | `Eastern Standard Time` |
| `America/Los_Angeles` | `Pacific Standard Time` |
| `America/Chicago` | `Central Standard Time` |
| `Europe/London` | `GMT Standard Time` |
| `Europe/Paris` | `Romance Standard Time` |
| `Europe/Berlin` | `W. Europe Standard Time` |
| `Asia/Tokyo` | `Tokyo Standard Time` |
| `Asia/Shanghai` | `China Standard Time` |
| `Australia/Sydney` | `AUS Eastern Standard Time` |
| `Pacific/Auckland` | `New Zealand Standard Time` |

### Oficiální Zdroj: CLDR windowsZones.xml

**URL:** https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml

Tento soubor je **oficiální mapping** používaný Windows, .NET, ICU a většinou knihoven.

### DST (Daylight Saving Time)

**Windows timezone names již zahrnují DST handling!**

Příklad:
- `Central Europe Standard Time` automaticky přepíná mezi CET (UTC+1) a CEST (UTC+2)
- Nemusíš explicitně specifikovat DST offset

### Implementace Timezone Converter

```javascript
// src/utils/timezoneConverter.js

/**
 * Complete mapping based on CLDR windowsZones.xml
 */
const ianaToWindowsMap = {
  // Europe
  'Europe/Prague': 'Central Europe Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Europe/Paris': 'Romance Standard Time',
  'Europe/Rome': 'W. Europe Standard Time',
  'Europe/London': 'GMT Standard Time',
  'Europe/Amsterdam': 'W. Europe Standard Time',
  'Europe/Brussels': 'Romance Standard Time',
  'Europe/Vienna': 'W. Europe Standard Time',
  'Europe/Warsaw': 'Central European Standard Time',
  'Europe/Budapest': 'Central Europe Standard Time',
  'Europe/Athens': 'GTB Standard Time',
  'Europe/Istanbul': 'Turkey Standard Time',
  'Europe/Moscow': 'Russian Standard Time',

  // Americas
  'America/New_York': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Phoenix': 'US Mountain Standard Time',
  'America/Anchorage': 'Alaskan Standard Time',
  'America/Honolulu': 'Hawaiian Standard Time',
  'America/Toronto': 'Eastern Standard Time',
  'America/Vancouver': 'Pacific Standard Time',
  'America/Mexico_City': 'Central Standard Time (Mexico)',
  'America/Sao_Paulo': 'E. South America Standard Time',
  'America/Buenos_Aires': 'Argentina Standard Time',

  // Asia
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Hong_Kong': 'China Standard Time',
  'Asia/Singapore': 'Singapore Standard Time',
  'Asia/Seoul': 'Korea Standard Time',
  'Asia/Taipei': 'Taipei Standard Time',
  'Asia/Bangkok': 'SE Asia Standard Time',
  'Asia/Dubai': 'Arabian Standard Time',
  'Asia/Kolkata': 'India Standard Time',

  // Pacific
  'Australia/Sydney': 'AUS Eastern Standard Time',
  'Australia/Melbourne': 'AUS Eastern Standard Time',
  'Australia/Perth': 'W. Australia Standard Time',
  'Pacific/Auckland': 'New Zealand Standard Time',

  // UTC
  'UTC': 'UTC',
  'Etc/UTC': 'UTC',
  'Etc/GMT': 'UTC'
};

/**
 * Konvertuje IANA timezone na Windows timezone
 */
export function convertIANAToWindows(ianaTimezone) {
  const windowsTimezone = ianaToWindowsMap[ianaTimezone];

  if (!windowsTimezone) {
    console.warn(`⚠️ Unknown IANA timezone: ${ianaTimezone}, using UTC`);
    return 'UTC';
  }

  return windowsTimezone;
}

/**
 * Konvertuje Windows timezone na IANA timezone
 */
export function convertWindowsToIANA(windowsTimezone) {
  // Reverse mapping
  const reverseMap = Object.fromEntries(
    Object.entries(ianaToWindowsMap).map(([iana, windows]) => [windows, iana])
  );

  const ianaTimezone = reverseMap[windowsTimezone];

  if (!ianaTimezone) {
    console.warn(`⚠️ Unknown Windows timezone: ${windowsTimezone}, using UTC`);
    return 'UTC';
  }

  return ianaTimezone;
}

/**
 * Validuje timezone name
 */
export function isValidIANATimezone(timezone) {
  return timezone in ianaToWindowsMap;
}

export function isValidWindowsTimezone(timezone) {
  return Object.values(ianaToWindowsMap).includes(timezone);
}
```

### Použití v Calendar API

```javascript
// Google Calendar - IANA timezone:
const googleEvent = {
  start: {
    dateTime: '2025-11-20T10:00:00',
    timeZone: 'Europe/Prague' // IANA
  }
};

// Microsoft Graph Calendar - Windows timezone:
import { convertIANAToWindows } from './utils/timezoneConverter.js';

const microsoftEvent = {
  start: {
    dateTime: '2025-11-20T10:00:00',
    timeZone: convertIANAToWindows('Europe/Prague') // 'Central Europe Standard Time'
  }
};
```

### Edge Cases

**1. Více IANA timezone → Jeden Windows timezone:**

Příklad: `America/New_York`, `America/Detroit`, `America/Indiana/Indianapolis` → všechny mapují na `Eastern Standard Time`

**Řešení:** Při konverzi zpět (Windows → IANA) vybrat **primary timezone** (např. `America/New_York`).

**2. Neznámý timezone:**

```javascript
const timezone = 'Unknown/Timezone';
const windowsTz = convertIANAToWindows(timezone); // → 'UTC' (fallback)
```

**3. DST Transitions:**

Windows timezone names automaticky handlují DST - nemusíš dělat nic speciálního.

---

## 📦 Batch Requests

### Základní Info

**Endpoint:** `https://graph.microsoft.com/v1.0/$batch`

**Method:** `POST`

**Max requests per batch:** 20

**Content-Type:** `application/json`

### Request Structure

```json
{
  "requests": [
    {
      "id": "1",
      "method": "GET",
      "url": "/me/messages?$top=10"
    },
    {
      "id": "2",
      "method": "GET",
      "url": "/me/calendar/events?$top=10"
    },
    {
      "id": "3",
      "method": "POST",
      "url": "/me/messages",
      "headers": {
        "Content-Type": "application/json"
      },
      "body": {
        "subject": "Test",
        "toRecipients": [
          { "emailAddress": { "address": "test@example.com" } }
        ],
        "body": {
          "contentType": "Text",
          "content": "Test message"
        }
      }
    }
  ]
}
```

### Response Structure

```json
{
  "responses": [
    {
      "id": "1",
      "status": 200,
      "headers": { ... },
      "body": { ... }
    },
    {
      "id": "2",
      "status": 200,
      "headers": { ... },
      "body": { ... }
    },
    {
      "id": "3",
      "status": 201,
      "headers": { ... },
      "body": { ... }
    }
  ]
}
```

### Dependencies

Můžeš specifikovat závislosti mezi requesty:

```json
{
  "requests": [
    {
      "id": "1",
      "method": "POST",
      "url": "/me/contacts",
      "body": { ... }
    },
    {
      "id": "2",
      "method": "PATCH",
      "url": "/me/contacts/{contactId}",
      "dependsOn": ["1"], // ← Počká na dokončení request #1
      "body": { ... }
    }
  ]
}
```

### ⚠️ DŮLEŽITÉ

**Batch response status 200 ≠ všechny requests uspěly!**

Musíš zkontrolovat **každý individual response status**:

```javascript
const batchResponse = await graphClient.api('/$batch').post(batchRequest);

for (const response of batchResponse.responses) {
  if (response.status >= 400) {
    console.error(`Request ${response.id} failed:`, response.body);
  } else {
    console.log(`Request ${response.id} succeeded`);
  }
}
```

### Použití v alfred2

**Příklad: Batch read emailů**

```javascript
// Místo 10 samostatných GET requests:
const messageIds = ['id1', 'id2', 'id3', ...]; // 10 IDs

// Batch request:
const batchRequest = {
  requests: messageIds.map((id, index) => ({
    id: String(index + 1),
    method: 'GET',
    url: `/me/messages/${id}`
  }))
};

const response = await graphClient.api('/$batch').post(batchRequest);

// Parse responses:
const messages = response.responses
  .filter(r => r.status === 200)
  .map(r => r.body);
```

**Výhoda:**
- 1 HTTP request místo 10
- Rychlejší overall response time
- Méně network overhead

### Limity

- Max 20 requests per batch
- Max request size: 4 MB
- Některé operations nejsou podporovány v batch (např. media upload)

---

## 📧 Message Structure

### JSON Format (vs Gmail MIME)

**Google Gmail:**
- Používá **raw MIME message** (base64url encoded)
- Musíš parsovat MIME parts pro attachments, body, headers

**Microsoft Graph:**
- Používá **čistý JSON** formát
- Strukturované objekty pro všechno

### Kompletní Message Object

```json
{
  "id": "AAMkAGI2...",
  "createdDateTime": "2025-11-18T10:00:00Z",
  "lastModifiedDateTime": "2025-11-18T10:00:00Z",
  "receivedDateTime": "2025-11-18T10:00:00Z",
  "sentDateTime": "2025-11-18T09:55:00Z",

  "subject": "Meeting tomorrow",

  "body": {
    "contentType": "HTML",  // nebo "Text"
    "content": "<html><body>Let's meet at 10am</body></html>"
  },

  "bodyPreview": "Let's meet at 10am",

  "from": {
    "emailAddress": {
      "name": "John Doe",
      "address": "john@example.com"
    }
  },

  "toRecipients": [
    {
      "emailAddress": {
        "name": "Jane Smith",
        "address": "jane@example.com"
      }
    }
  ],

  "ccRecipients": [],
  "bccRecipients": [],

  "replyTo": [],

  "conversationId": "AAQkAGI2...",
  "conversationIndex": "AQHb...",

  "isRead": false,
  "isDraft": false,
  "isDeliveryReceiptRequested": false,
  "isReadReceiptRequested": false,

  "hasAttachments": true,

  "importance": "normal",  // "low", "normal", "high"

  "internetMessageId": "<message-id@example.com>",

  "categories": ["Red category"],

  "flag": {
    "flagStatus": "notFlagged"
  },

  "attachments": [
    {
      "id": "AAMkAGI2...",
      "@odata.type": "#microsoft.graph.fileAttachment",
      "name": "document.pdf",
      "contentType": "application/pdf",
      "size": 123456,
      "isInline": false,
      "contentId": null,
      "contentLocation": null,
      "contentBytes": "JVBERi0xLjQKJ..." // base64
    }
  ]
}
```

### Odeslání zprávy s přílohami

```javascript
const message = {
  subject: "Project Update",
  body: {
    contentType: "HTML",
    content: "<h1>Update</h1><p>Please review the attached document.</p>"
  },
  toRecipients: [
    {
      emailAddress: {
        address: "recipient@example.com"
      }
    }
  ],
  attachments: [
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      "name": "report.pdf",
      "contentType": "application/pdf",
      "contentBytes": base64EncodedContent  // Base64 string
    }
  ]
};

await graphClient.api('/me/sendMail').post({
  message: message,
  saveToSentItems: true
});
```

### Categories vs Gmail Labels

**Gmail:**
- System labels: `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `UNREAD`
- Custom labels: User-created
- Categories: `primary`, `social`, `promotions`, `updates`, `forums`

**Microsoft:**
- **Folders** (ekvivalent Gmail system labels): `inbox`, `sentitems`, `deleteditems`, `drafts`, `junkemail`
- **Categories** (string pole): `["Red category", "Blue category"]`
- **Focused Inbox:** `inferenceClassification` property

**Mapování:**
```javascript
// Gmail label → Microsoft folder
const labelToFolder = {
  'INBOX': 'inbox',
  'SENT': 'sentitems',
  'DRAFT': 'drafts',
  'SPAM': 'junkemail',
  'TRASH': 'deleteditems'
};
```

---

## 📅 Calendar Recurrence

### Google Calendar - RFC 5545 RRULE

```javascript
// Google používá RFC 5545 RRULE:
{
  "recurrence": [
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20251231T235959Z"
  ]
}
```

### Microsoft Graph - Vlastní JSON Format

```javascript
// Microsoft používá JSON object:
{
  "recurrence": {
    "pattern": {
      "type": "weekly",           // daily, weekly, absoluteMonthly, relativeMonthly, absoluteYearly, relativeYearly
      "interval": 1,              // Každý 1. týden
      "daysOfWeek": ["monday", "wednesday", "friday"],
      "firstDayOfWeek": "sunday"
    },
    "range": {
      "type": "endDate",          // endDate, noEnd, numbered
      "startDate": "2025-11-18",
      "endDate": "2025-12-31"
    }
  }
}
```

### Pattern Types

**Daily:**
```json
{
  "pattern": {
    "type": "daily",
    "interval": 2  // Každý 2. den
  }
}
```

**Weekly:**
```json
{
  "pattern": {
    "type": "weekly",
    "interval": 1,
    "daysOfWeek": ["monday", "wednesday", "friday"]
  }
}
```

**Absolute Monthly (např. každý 15. den v měsíci):**
```json
{
  "pattern": {
    "type": "absoluteMonthly",
    "interval": 1,
    "dayOfMonth": 15
  }
}
```

**Relative Monthly (např. každý 3. pátek v měsíci):**
```json
{
  "pattern": {
    "type": "relativeMonthly",
    "interval": 1,
    "daysOfWeek": ["friday"],
    "index": "third"  // first, second, third, fourth, last
  }
}
```

### Range Types

**End Date:**
```json
{
  "range": {
    "type": "endDate",
    "startDate": "2025-11-18",
    "endDate": "2025-12-31"
  }
}
```

**No End:**
```json
{
  "range": {
    "type": "noEnd",
    "startDate": "2025-11-18"
  }
}
```

**Numbered (např. 10 opakování):**
```json
{
  "range": {
    "type": "numbered",
    "startDate": "2025-11-18",
    "numberOfOccurrences": 10
  }
}
```

### Konverze RRULE → Microsoft Format

**Potřebná knihovna:** `rrule` nebo vlastní parser

```javascript
// Příklad RRULE:
// RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10

// Konverze na Microsoft:
{
  "pattern": {
    "type": "weekly",
    "interval": 2,
    "daysOfWeek": ["monday", "wednesday"]
  },
  "range": {
    "type": "numbered",
    "startDate": "2025-11-18",
    "numberOfOccurrences": 10
  }
}
```

**⚠️ POZOR:** Ne všechny RRULE varianty mají přesný ekvivalent v Microsoft formátu!

---

## 🔐 MSAL Node Konfigurace

### Instalace

```bash
npm install @azure/msal-node isomorphic-fetch
```

### Basic Setup

```javascript
import { ConfidentialClientApplication } from '@azure/msal-node';

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET
  },
  system: {
    loggerOptions: {
      loggerCallback(loglevel, message, containsPii) {
        if (!containsPii) {
          console.log(`[MSAL] ${message}`);
        }
      },
      piiLoggingEnabled: false,
      logLevel: 'Info'  // 'Error', 'Warning', 'Info', 'Verbose'
    }
  }
};

const pca = new ConfidentialClientApplication(msalConfig);
```

### Authorization Code Flow

```javascript
// 1. Get authorization URL
const authCodeUrlParameters = {
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'Mail.Read',
    'Mail.ReadWrite',
    'Mail.Send',
    'Calendars.Read',
    'Calendars.ReadWrite',
    'Tasks.ReadWrite'
  ],
  redirectUri: process.env.REDIRECT_URI,
  state: 'random-state-string',
  prompt: 'consent'  // Force consent screen
};

const authUrl = await pca.getAuthCodeUrl(authCodeUrlParameters);

// 2. User visits authUrl, authorizes, gets redirected with code

// 3. Exchange code for tokens
const tokenRequest = {
  code: authorizationCode,
  scopes: authCodeUrlParameters.scopes,
  redirectUri: process.env.REDIRECT_URI
};

const response = await pca.acquireTokenByCode(tokenRequest);

// response:
// {
//   accessToken: "...",
//   idToken: "...",
//   account: { ... },
//   expiresOn: Date,
//   scopes: [...]
// }
```

### PKCE Support

```javascript
// Generate PKCE challenge
import crypto from 'crypto';

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');

  return {
    codeVerifier: verifier,
    codeChallenge: challenge
  };
}

// Use in auth flow:
const pkce = generatePKCE();

const authCodeUrlParameters = {
  scopes: [...],
  redirectUri: process.env.REDIRECT_URI,
  codeChallenge: pkce.codeChallenge,
  codeChallengeMethod: 'S256'
};

const authUrl = await pca.getAuthCodeUrl(authCodeUrlParameters);

// Later, in token exchange:
const tokenRequest = {
  code: authorizationCode,
  scopes: [...],
  redirectUri: process.env.REDIRECT_URI,
  codeVerifier: pkce.codeVerifier  // ← Provide verifier
};
```

### Silent Token Acquisition (with cache)

```javascript
const account = {
  homeAccountId: userId,
  environment: 'login.microsoftonline.com',
  tenantId: 'tenant-id',
  username: 'user@example.com',
  localAccountId: userId
};

const silentRequest = {
  account: account,
  scopes: ['Mail.Read'],
  forceRefresh: false  // true = refresh i když cached token valid
};

try {
  const response = await pca.acquireTokenSilent(silentRequest);
  console.log('Token:', response.accessToken);
} catch (error) {
  if (error.errorCode === 'interaction_required') {
    // User must re-authenticate
    console.error('Re-authentication needed');
  } else if (error.errorCode === 'invalid_grant') {
    // Refresh token expired
    console.error('Refresh token expired');
  } else {
    throw error;
  }
}
```

### Error Handling

**Common Error Codes:**

| Error Code | Meaning | Action |
|------------|---------|--------|
| `interaction_required` | User interaction needed | Re-authenticate |
| `invalid_grant` | Refresh token invalid/expired | Re-authenticate |
| `consent_required` | Consent needed for scopes | Re-authenticate with consent |
| `invalid_client` | Wrong client credentials | Check client ID/secret |
| `unauthorized_client` | Client not authorized | Check app registration |

---

## 📚 Další zdroje

### Oficiální dokumentace

- **Microsoft Graph Overview:** https://learn.microsoft.com/en-us/graph/overview
- **Throttling Limits:** https://learn.microsoft.com/en-us/graph/throttling-limits
- **Error Handling:** https://learn.microsoft.com/en-us/graph/errors
- **Batching:** https://learn.microsoft.com/en-us/graph/json-batching
- **MSAL Node:** https://github.com/AzureAD/microsoft-authentication-library-for-js/tree/dev/lib/msal-node

### Tools

- **Graph Explorer:** https://developer.microsoft.com/en-us/graph/graph-explorer
- **CLDR windowsZones.xml:** https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml

---

## ✅ Klíčová doporučení pro alfred2

1. ✅ **Rate limiting:** Implementovat retry s Retry-After header + exponential backoff
2. ✅ **Token refresh:** Použít manuální refresh (ne MSAL cache) pro minimální DB změny
3. ✅ **Timezone:** Vytvořit converter IANA ↔ Windows s kompletním mappingem
4. ✅ **Batch requests:** Použít pro bulk operace (max 20 per batch)
5. ✅ **Error handling:** Logovat všechny errors s request-id pro debugging
6. ✅ **Message format:** JSON objects místo MIME - kompletní refactor parsing logiky
7. ✅ **Recurrence:** Vytvořit converter RFC 5545 RRULE ↔ Microsoft JSON format
8. ✅ **Testing:** Testovat na real Microsoft Graph API před deploymentem

**Časový odhad pro tyto komponenty:** 2-3 týdny

---

**Připraven na implementaci! 🚀**
