# Migrace Alfred2 z Google na Microsoft

**Datum:** 18.11.2025
**Verze:** 1.0
**Autor:** Claude - Analýza pro migraci alfred2 repository

---

## 📋 Obsah

1. [Současný stav - Google služby](#současný-stav---google-služby)
2. [Mapování na Microsoft služby](#mapování-na-microsoft-služby)
3. [Detailní srovnání API](#detailní-srovnání-api)
4. [OAuth a autentizace](#oauth-a-autentizace)
5. [Konkrétní API endpointy](#konkrétní-api-endpointy)
6. [Klíčové rozdíly a výzvy](#klíčové-rozdíly-a-výzvy)
7. [Migrační strategie](#migrační-strategie)
8. [Implementační kroky](#implementační-kroky)
9. [Časový odhad](#časový-odhad)

---

## 🔍 Současný stav - Google služby

Alfred2 je OAuth proxy server pro ChatGPT Custom GPT, který integruje **5 Google služeb**:

### Aktuálně používané Google služby:

| Služba | API | Účel | Rozsah použití |
|--------|-----|------|----------------|
| **Gmail** | Gmail API v1 | Správa emailů, odesílání, čtení, vyhledávání | 39+ API call sites |
| **Google Calendar** | Calendar API v3 | Správa událostí, kalendáře | Středně používáno |
| **Google Tasks** | Tasks API v1 | Správa úkolů a todo seznamů | Méně používáno |
| **Google Sheets** | Sheets API v4 | Ukládání kontaktů (spreadsheet "Alfred Kontakty") | Specifické použití |
| **Google Drive** | Drive API v3 | Vyhledávání kontaktního spreadsheetu | Podpůrná funkce |

### OAuth Scopes (Google):
```
https://mail.google.com/
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive.file
openid, email, profile
```

---

## 🔄 Mapování na Microsoft služby

### Kompletní mapování služeb:

| Google služba | Microsoft ekvivalent | API | Status |
|---------------|---------------------|-----|--------|
| **Gmail** | **Outlook Mail** | Microsoft Graph Mail API | ✅ Plně podporováno |
| **Google Calendar** | **Outlook Calendar** | Microsoft Graph Calendar API | ✅ Plně podporováno |
| **Google Tasks** | **Microsoft To Do** | Microsoft Graph To Do API | ✅ GA (General Availability) |
| **Google Sheets** | **Excel Online** | Microsoft Graph Excel API | ✅ Plně podporováno |
| **Google Drive** | **OneDrive/SharePoint** | Microsoft Graph Drive API | ✅ Plně podporováno |

### ⚠️ DŮLEŽITÉ: Outlook Tasks je DEPRECATED!
- **Outlook Tasks API** přestalo vracet data **20. srpna 2022**
- **Nahrazeno:** Microsoft To Do API
- **Doporučení:** Používat pouze To Do API pro úkoly

---

## 📊 Detailní srovnání API

### Microsoft Graph API - Jednotné rozhraní

Na rozdíl od Google, kde každá služba má vlastní API, Microsoft nabízí **Microsoft Graph API** - **jednotné REST API** pro všechny Microsoft 365 služby.

**Base URL:**
```
https://graph.microsoft.com/v1.0
https://graph.microsoft.com/beta  (neprodukční)
```

### Výhody Microsoft Graph:
1. **Jednotné autentizační flow** pro všechny služby
2. **Konzistentní API design** napříč službami
3. **OData protokol** - standardizované dotazování
4. **Delta queries** - efektivní synchronizace změn
5. **Webhooks** - real-time notifikace
6. **Batch requests** - více operací v jednom requestu

### Nevýhody:
1. **Rozsáhlé API** - může být složité na naučení
2. **Časté změny** - beta endpointy se mohou měnit
3. **Admin consent** - některé scopes vyžadují schválení adminem

---

## 🔐 OAuth a autentizace

### Google OAuth 2.0 vs Microsoft Identity Platform

| Aspekt | Google | Microsoft |
|--------|--------|-----------|
| **OAuth verze** | OAuth 2.0 | OAuth 2.0 / OpenID Connect |
| **Authorization endpoint** | `https://accounts.google.com/o/oauth2/v2/auth` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` |
| **Token endpoint** | `https://oauth2.googleapis.com/token` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` |
| **Tenant koncept** | ❌ Ne | ✅ Ano (`common`, `organizations`, `consumers`, nebo ID) |
| **PKCE podpora** | ✅ Ano | ✅ Ano (doporučeno) |
| **Refresh tokens** | ✅ Ano, expirace ~6 měsíců | ✅ Ano, různá expirace (90 dní default) |

### Microsoft OAuth Scopes (Delegated permissions):

```javascript
// Místo Google scopes:
const microsoftScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',              // Nutné pro refresh token!
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',             // Microsoft To Do
  'Files.ReadWrite',             // OneDrive
  'Files.ReadWrite.All',         // Pro Excel soubory
  'User.Read'
];
```

### ⚠️ Kritický rozdíl - Tenant ID:

Microsoft vyžaduje **tenant ID** nebo použití speciálních hodnot:
- `common` - multi-tenant aplikace (osobní i work účty)
- `organizations` - pouze work/school účty
- `consumers` - pouze osobní Microsoft účty (Outlook.com, Hotmail)
- `{tenant-id}` - specifický Azure AD tenant

**Doporučení pro alfred2:** Použít `common` pro podporu všech typů účtů.

### Environment variables - Změny:

```javascript
// Staré (Google):
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

// Nové (Microsoft):
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=common  // nebo organizations/consumers
```

---

## 🔌 Konkrétní API endpointy

### 1. EMAIL / MAIL API

#### **Google Gmail API vs Microsoft Graph Mail API**

| Operace | Google Gmail API | Microsoft Graph API |
|---------|------------------|---------------------|
| **Seznam emailů** | `GET /gmail/v1/users/me/messages` | `GET /me/messages` |
| **Čtení emailu** | `GET /gmail/v1/users/me/messages/{id}` | `GET /me/messages/{id}` |
| **Odeslání emailu** | `POST /gmail/v1/users/me/messages/send` | `POST /me/sendMail` |
| **Odpověď na email** | `POST /gmail/v1/users/me/messages/{id}/send` (create draft + send) | `POST /me/messages/{id}/reply` |
| **Smazání** | `DELETE /gmail/v1/users/me/messages/{id}` | `DELETE /me/messages/{id}` |
| **Hledání** | Query param `q` s Gmail syntax | OData `$filter` a `$search` |
| **Složky/Labely** | Labels: `GET .../labels` | Folders: `GET /me/mailFolders` |
| **Přílohy** | Part of message object | `GET /me/messages/{id}/attachments` |

#### **Klíčové rozdíly:**

**A) Struktura zprávy:**
- **Gmail:** Base64url encoded raw MIME message
- **Microsoft:** JSON strukturované objekty (subject, body, from, to...)

**B) Vyhledávání:**
```javascript
// Google Gmail search:
q: "from:john@example.com is:unread"

// Microsoft Graph search:
$filter=from/emailAddress/address eq 'john@example.com' and isRead eq false
// NEBO:
$search="from:john@example.com"
```

**C) Kategorizace:**
- **Gmail:** Labels (system + custom), kategorie (primary, social, promotions)
- **Microsoft:** Folders (Inbox, Sent Items...), Categories (string pole)

**D) Konverzace/Thready:**
- **Gmail:** `threads` endpoint explicitly
- **Microsoft:** `conversationId` property na message objektu

#### **Příklad - Odeslání emailu:**

```javascript
// Google Gmail:
const raw = createMimeMessage(to, subject, body);
await gmail.users.messages.send({
  userId: 'me',
  requestBody: {
    raw: base64url(raw)
  }
});

// Microsoft Graph:
await graphClient.api('/me/sendMail').post({
  message: {
    subject: subject,
    body: {
      contentType: 'HTML',
      content: body
    },
    toRecipients: [{
      emailAddress: {
        address: to
      }
    }]
  }
});
```

---

### 2. KALENDÁŘ / CALENDAR API

| Operace | Google Calendar API | Microsoft Graph Calendar API |
|---------|---------------------|------------------------------|
| **Seznam událostí** | `GET /calendar/v3/calendars/primary/events` | `GET /me/calendar/events` |
| **Vytvoření události** | `POST /calendar/v3/calendars/primary/events` | `POST /me/calendar/events` |
| **Aktualizace** | `PUT /calendar/v3/calendars/primary/events/{id}` | `PATCH /me/calendar/events/{id}` |
| **Smazání** | `DELETE /calendar/v3/calendars/primary/events/{id}` | `DELETE /me/calendar/events/{id}` |
| **Vícero kalendářů** | `GET /calendar/v3/users/me/calendarList` | `GET /me/calendars` |

#### **Klíčové rozdíly:**

**A) Časová pásma:**
- **Google:** `timeZone` na úrovni kalendáře + události
- **Microsoft:** `timeZone` property v `dateTime` objektech (Windows timezone names!)

**B) Opakování:**
- **Google:** RFC 5545 RRULE
- **Microsoft:** `recurrence` objekt s pattern a range (jiná struktura)

**C) Účastníci:**
```javascript
// Google:
attendees: [{ email: 'john@example.com' }]

// Microsoft:
attendees: [{
  emailAddress: {
    address: 'john@example.com',
    name: 'John Doe'
  },
  type: 'required' // nebo 'optional', 'resource'
}]
```

---

### 3. ÚKOLY / TASKS API

| Operace | Google Tasks API | Microsoft To Do API |
|---------|------------------|---------------------|
| **Seznam úkolových listů** | `GET /tasks/v1/users/@me/lists` | `GET /me/todo/lists` |
| **Úkoly v listu** | `GET /tasks/v1/lists/{listId}/tasks` | `GET /me/todo/lists/{listId}/tasks` |
| **Vytvoření úkolu** | `POST /tasks/v1/lists/{listId}/tasks` | `POST /me/todo/lists/{listId}/tasks` |
| **Aktualizace** | `PATCH /tasks/v1/lists/{listId}/tasks/{id}` | `PATCH /me/todo/lists/{listId}/tasks/{id}` |
| **Smazání** | `DELETE /tasks/v1/lists/{listId}/tasks/{id}` | `DELETE /me/todo/lists/{listId}/tasks/{id}` |
| **Označit hotové** | `PATCH ...tasks/{id}` with `status: 'completed'` | `PATCH ...tasks/{id}` with `status: 'completed'` |

#### **Klíčové rozdíly:**

**A) Struktura úkolu:**
```javascript
// Google Tasks:
{
  "title": "Buy milk",
  "notes": "2% milk",
  "due": "2025-11-20T00:00:00.000Z",
  "status": "needsAction" // nebo "completed"
}

// Microsoft To Do:
{
  "title": "Buy milk",
  "body": {
    "content": "2% milk",
    "contentType": "text"
  },
  "dueDateTime": {
    "dateTime": "2025-11-20T00:00:00",
    "timeZone": "UTC"
  },
  "status": "notStarted" // nebo "completed"
}
```

**B) Rozšířené funkce v Microsoft To Do:**
- **Importance:** `low`, `normal`, `high`
- **LinkedResources:** Propojení s externími aplikacemi
- **ChecklistItems:** Sub-úkoly (Google nemá!)
- **Recurrence:** Opakující se úkoly

---

### 4. KONTAKTY / SPREADSHEET API

**ZÁSADNÍ ZMĚNA:** Google Sheets → Excel Online (OneDrive)

| Operace | Google Sheets API | Microsoft Graph Excel API |
|---------|-------------------|---------------------------|
| **Hledání souboru** | Drive API: search by name | `GET /me/drive/root/search(q='Alfred Kontakty')` |
| **Čtení buněk** | `GET /v4/spreadsheets/{id}/values/{range}` | `GET /me/drive/items/{id}/workbook/worksheets/{sheet}/range(address='{range}')` |
| **Zápis buněk** | `PUT /v4/spreadsheets/{id}/values/{range}` | `PATCH /me/drive/items/{id}/workbook/worksheets/{sheet}/range(address='{range}')` |
| **Vytvoření souboru** | `POST /v4/spreadsheets` | Složitější - upload prázdného .xlsx do OneDrive |

#### **Kritický rozdíl - Vytvoření souboru:**

```javascript
// Google: Jednoduché
const response = await sheets.spreadsheets.create({
  properties: { title: 'Alfred Kontakty' }
});

// Microsoft: Složitější - 2 kroky
// 1. Vytvořit prázdný Excel soubor a uploadnout
const workbook = createEmptyExcelWorkbook(); // Buffer
const uploadResponse = await graphClient
  .api('/me/drive/root:/Alfred Kontakty.xlsx:/content')
  .put(workbook);

// 2. Pak teprve zapisovat data
```

#### **Čtení/Zápis dat:**

```javascript
// Google Sheets - jednoduché pole:
const values = [
  ['Name', 'Email', 'Phone'],
  ['John Doe', 'john@example.com', '123-456-7890']
];
await sheets.spreadsheets.values.update({
  spreadsheetId: id,
  range: 'Sheet1!A1:C2',
  valueInputOption: 'RAW',
  requestBody: { values }
});

// Microsoft Excel - objekt s values property:
const rangeUpdate = {
  values: [
    ['Name', 'Email', 'Phone'],
    ['John Doe', 'john@example.com', '123-456-7890']
  ]
};
await graphClient
  .api(`/me/drive/items/${id}/workbook/worksheets/Sheet1/range(address='A1:C2')`)
  .patch(rangeUpdate);
```

#### **Doporučení:**
Zvážit použití **Microsoft Graph People API** nebo **Outlook Contacts API** místo Excel souboru:
```javascript
// Alternativa - nativní kontakty:
GET /me/contacts
POST /me/contacts
PATCH /me/contacts/{id}
DELETE /me/contacts/{id}
```

---

### 5. SOUBORY / DRIVE API

| Operace | Google Drive API | Microsoft Graph OneDrive API |
|---------|------------------|------------------------------|
| **Seznam souborů** | `GET /drive/v3/files` | `GET /me/drive/root/children` |
| **Hledání** | `GET /drive/v3/files?q={query}` | `GET /me/drive/root/search(q='{query}')` |
| **Upload** | `POST /upload/drive/v3/files` | `PUT /me/drive/root:/{path}:/content` |
| **Stažení** | `GET /drive/v3/files/{id}?alt=media` | `GET /me/drive/items/{id}/content` |

---

## ⚡ Klíčové rozdíly a výzvy

### 1. **Autentizace a Tenant management**
- **Výzva:** Microsoft vyžaduje tenant ID konfiguraci
- **Řešení:** Použít `common` tenant pro universal support
- **Dopad:** Střední - vyžaduje změny v oauth konfiguraci

### 2. **API struktury - JSON vs Base64**
- **Výzva:** Gmail používá raw MIME, Outlook používá JSON objekty
- **Řešení:** Kompletně přepsat email parsing/sending logiku
- **Dopad:** Vysoký - dotýká se 39+ call sites v `googleApiService.js`

### 3. **Kontakty - Sheets vs nativní Contacts API**
- **Výzva:** Současné řešení používá Google Sheets, Excel API je složitější
- **Řešení:** Migrovat na Microsoft Graph Contacts API (doporučeno)
- **Dopad:** Střední - vyžaduje redesign `contactsService.js`

### 4. **Časová pásma**
- **Výzva:** Microsoft používá Windows timezone names vs IANA
- **Řešení:** Konverzní vrstva (např. `Europe/Prague` → `Central Europe Standard Time`)
- **Dopad:** Nízký - již máte timezone handling v `helpers.js`

### 5. **Rate limiting**
- **Výzva:** Microsoft má jiné rate limity než Google
- **Řešení:** Adjustovat `limits.js` konfiguraci
- **Dopad:** Nízký - configuration change

**Microsoft Graph rate limits:**
- **Mail API:** 10,000 requests per 10 minutes per app per mailbox
- **Calendar API:** 10,000 requests per 10 minutes
- **To Do API:** Throttled na základě tenant
- **Excel API:** Variable, může být pomalejší

### 6. **Batch requests**
- **Výzva:** Microsoft má jiný batch formát než Google
- **Řešení:** Pokud používáte batch, kompletně přepsat
- **Dopad:** Závisí na použití

### 7. **Webhooks/Subscriptions**
- **Výzva:** Microsoft používá subscription model místo push notifications
- **Řešení:** Pokud potřebujete real-time updates, implementovat webhooks
- **Dopad:** Nízký - alfred2 aktuálně nepoužívá

### 8. **Admin consent**
- **Výzva:** Některé scopes vyžadují admin approval v organizacích
- **Řešení:** Navrhnout minimální scope set, dokumentovat pro adminy
- **Dopad:** Střední - může blokovat firemní uživatele

---

## 🎯 Migrační strategie

### Fáze 1: Příprava (1 týden)

1. **Azure AD App Registration**
   - Vytvořit novou aplikaci v Azure Portal
   - Nakonfigurovat redirect URIs
   - Získat Client ID a Client Secret
   - Nastavit API permissions (scopes)

2. **Development environment**
   - Vytvořit testovací Microsoft účet
   - Nastavit development tenant (volitelné)
   - Připravit testovací data (emaily, události, úkoly, kontakty)

3. **Dependency management**
   - Odstranit `googleapis` package
   - Přidat `@microsoft/microsoft-graph-client`
   - Přidat `@azure/msal-node` (pro autentizaci)
   - Update ostatních závislostí

### Fáze 2: Core autentizace (1-2 týdny)

4. **OAuth flow přepis**
   - Upravit `src/config/oauth.js` pro Microsoft endpoints
   - Změnit authorization URL na Microsoft Identity Platform
   - Update token exchange logiky
   - Implementovat tenant handling (`common`)

5. **Token management**
   - Upravit `tokenService.js` pro Microsoft token format
   - Update `databaseService.js` - struktura tokenů může být jiná
   - Testovat refresh token flow

6. **Middleware updates**
   - `authMiddleware.js` - validace Microsoft JWT tokenů
   - Update error handling pro Microsoft error formáty

### Fáze 3: Service layer (3-4 týdny)

7. **Email service (nejvíce práce)**
   - Přepsat `googleApiService.js` → `microsoftGraphService.js`
   - Implementovat všechny mail operace (list, read, send, reply, delete, modify)
   - Přepsat MIME parsing → JSON message handling
   - Update attachment handling
   - Přepsat search queries (Gmail syntax → OData)
   - Label management → Folder/Category management

8. **Calendar service**
   - Přepsat calendar operace v `microsoftGraphService.js`
   - Adjustovat timezone handling (IANA → Windows timezone names)
   - Update recurrence pattern handling
   - Implementovat multi-calendar support

9. **Tasks service**
   - Přepsat `tasksService.js` pro Microsoft To Do API
   - Mapovat Google Tasks struktura → To Do struktura
   - Implementovat extended features (importance, checklist items)

10. **Contacts service - Redesign**
    - **Doporučeno:** Migrovat z Excel na Microsoft Graph Contacts API
    - Přepsat `contactsService.js`
    - Implementovat contacts CRUD operations
    - Zachovat fuzzy search functionality
    - **Alternativa:** Implementovat Excel API (složitější)

### Fáze 4: Facade layer (1-2 týdny)

11. **Facade service updates**
    - Upravit `facadeService.js` pro nové service methods
    - Zachovat stejné makro operace (inbox overview, snippets, etc.)
    - Update email categorization logiky
    - Testovat všechny high-level operace

12. **Controllers**
    - Minimal changes - většinou volají service layer
    - Update error handling pokud potřeba
    - Testovat všechny endpoints

### Fáze 5: Testing & Deployment (1-2 týdny)

13. **Comprehensive testing**
    - Unit testy pro každou službu
    - Integration testy s real Microsoft API
    - E2E testy pro kompletní user flow
    - Performance testing (rate limits, latency)

14. **ChatGPT Custom GPT update**
    - Update OpenAPI spec (pravděpodobně minimální změny)
    - Testovat OAuth flow z ChatGPT
    - Testovat všechny makro operace

15. **Documentation**
    - Update README.md
    - Update deployment guide
    - Update environment variables dokumentace
    - Vytvořit migration guide pro uživatele

16. **Deployment**
    - Deploy na Render.com (nebo jiný hosting)
    - Update environment variables
    - Monitor logs a errors
    - Postupný rollout

---

## 📝 Implementační kroky (Krok za krokem)

### Krok 1: Azure AD Setup

```bash
# 1. Přihlásit se do Azure Portal: https://portal.azure.com
# 2. Navigace: Azure Active Directory → App registrations → New registration

Název: Alfred2 OAuth Server
Podporované typy účtů: "Accounts in any organizational directory and personal Microsoft accounts"
Redirect URI: https://alfred2-oauth-server.onrender.com/oauth/callback
```

**API Permissions přidat:**
- Microsoft Graph:
  - `Mail.Read`
  - `Mail.ReadWrite`
  - `Mail.Send`
  - `Calendars.Read`
  - `Calendars.ReadWrite`
  - `Tasks.ReadWrite`
  - `Files.ReadWrite`
  - `Files.ReadWrite.All`
  - `Contacts.Read`
  - `Contacts.ReadWrite`
  - `User.Read`
  - `offline_access`

### Krok 2: Update package.json

```bash
npm uninstall googleapis
npm install @microsoft/microsoft-graph-client @azure/msal-node isomorphic-fetch
```

### Krok 3: Environment Variables

Vytvořit/upravit `.env`:
```bash
# Microsoft OAuth
MICROSOFT_CLIENT_ID=<your-azure-app-client-id>
MICROSOFT_CLIENT_SECRET=<your-azure-app-client-secret>
MICROSOFT_TENANT_ID=common

# Microsoft Graph API
GRAPH_API_ENDPOINT=https://graph.microsoft.com/v1.0
GRAPH_API_SCOPES=openid profile email offline_access Mail.Read Mail.ReadWrite Mail.Send Calendars.Read Calendars.ReadWrite Tasks.ReadWrite Files.ReadWrite Files.ReadWrite.All Contacts.Read Contacts.ReadWrite User.Read

# Keep existing
MONGODB_URI=...
ENCRYPTION_KEY=...
PROXY_TOKEN_SECRET=...
REDIRECT_URI=https://alfred2-oauth-server.onrender.com/oauth/callback
OAUTH_CLIENT_ID=...  # ChatGPT OAuth credentials
OAUTH_CLIENT_SECRET=...
PORT=3000
NODE_ENV=production
BASE_URL=https://alfred2-oauth-server.onrender.com
```

### Krok 4: Vytvořit nový `src/config/microsoft.js`

```javascript
import 'dotenv/config';

export const microsoftConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
    authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`,
  },

  endpoints: {
    authorize: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    userInfo: 'https://graph.microsoft.com/v1.0/me',
  },

  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
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
    'https://graph.microsoft.com/User.Read',
  ],

  redirectUri: process.env.REDIRECT_URI,
};
```

### Krok 5: Vytvořit Microsoft Graph klienta helper

`src/utils/graphClient.js`:
```javascript
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';

/**
 * Vytvoří Microsoft Graph klienta s access tokenem
 */
export function createGraphClient(accessToken) {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

/**
 * Execute request s retry logikou
 */
export async function executeGraphRequest(graphClient, requestBuilder, options = {}) {
  const { maxRetries = 3, retryDelay = 1000 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestBuilder;
    } catch (error) {
      if (attempt === maxRetries) throw error;

      // Retry na throttling (429) nebo server errors (5xx)
      if (error.statusCode === 429 || error.statusCode >= 500) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        continue;
      }

      throw error;
    }
  }
}
```

### Krok 6: Přepsat OAuth controller

Upravit `src/controllers/authController.js` a `oauthProxyController.js`:

**Klíčové změny:**
- Authorization URL → Microsoft endpoint
- Token exchange → Microsoft token endpoint
- User info → Microsoft Graph `/me` endpoint
- Ukládat Microsoft-specific token fields

### Krok 7: Vytvořit nový `src/services/microsoftGraphService.js`

Začít s základními operacemi:

```javascript
import { createGraphClient, executeGraphRequest } from '../utils/graphClient.js';

export class MicrosoftGraphService {
  constructor(accessToken) {
    this.client = createGraphClient(accessToken);
  }

  // ==================== MAIL API ====================

  /**
   * Seznam zpráv (ekvivalent Gmail.list)
   */
  async listMessages(options = {}) {
    const {
      maxResults = 50,
      pageToken,
      query,
      labelIds, // mapovat na folderIds
    } = options;

    let request = this.client.api('/me/messages')
      .top(maxResults)
      .select('id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview');

    // Pagination
    if (pageToken) {
      request = request.skipToken(pageToken);
    }

    // Filtering
    if (query) {
      // Konvertovat Gmail query syntax na OData filter
      const filter = this._convertGmailQueryToOData(query);
      request = request.filter(filter);
    }

    // Folder filtering (ekvivalent labelIds)
    if (labelIds && labelIds.length > 0) {
      // TODO: Implementovat folder filtering
    }

    const response = await executeGraphRequest(this.client, request.get());

    return {
      messages: response.value.map(msg => ({
        id: msg.id,
        threadId: msg.conversationId,
        // TODO: Mapovat na Gmail-like format
      })),
      nextPageToken: response['@odata.nextLink'] ? this._extractSkipToken(response['@odata.nextLink']) : null,
    };
  }

  /**
   * Přečíst zprávu (ekvivalent Gmail.get)
   */
  async getMessage(messageId, format = 'full') {
    let request = this.client.api(`/me/messages/${messageId}`);

    if (format === 'full') {
      request = request.select('*').expand('attachments');
    } else if (format === 'metadata') {
      request = request.select('id,subject,from,toRecipients,receivedDateTime,isRead,internetMessageHeaders');
    }

    const message = await executeGraphRequest(this.client, request.get());

    // TODO: Mapovat na Gmail-like format
    return this._mapMessageToGmailFormat(message);
  }

  /**
   * Odeslat email (ekvivalent Gmail.send)
   */
  async sendMessage(messageData) {
    const { to, cc, bcc, subject, body, attachments, isHtml } = messageData;

    const message = {
      subject,
      body: {
        contentType: isHtml ? 'HTML' : 'Text',
        content: body,
      },
      toRecipients: to.map(email => ({ emailAddress: { address: email } })),
    };

    if (cc && cc.length > 0) {
      message.ccRecipients = cc.map(email => ({ emailAddress: { address: email } }));
    }

    if (bcc && bcc.length > 0) {
      message.bccRecipients = bcc.map(email => ({ emailAddress: { address: email } }));
    }

    if (attachments && attachments.length > 0) {
      message.attachments = attachments.map(att => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: att.filename,
        contentType: att.mimeType,
        contentBytes: att.data, // base64
      }));
    }

    await executeGraphRequest(
      this.client,
      this.client.api('/me/sendMail').post({ message })
    );

    return { success: true };
  }

  /**
   * Odpovědět na email (ekvivalent Gmail reply)
   */
  async replyToMessage(messageId, replyData) {
    const { body, isHtml } = replyData;

    await executeGraphRequest(
      this.client,
      this.client.api(`/me/messages/${messageId}/reply`).post({
        comment: body,
      })
    );

    return { success: true };
  }

  /**
   * Smazat zprávu (ekvivalent Gmail.delete/trash)
   */
  async deleteMessage(messageId) {
    await executeGraphRequest(
      this.client,
      this.client.api(`/me/messages/${messageId}`).delete()
    );

    return { success: true };
  }

  /**
   * Upravit zprávu (ekvivalent Gmail.modify - read/unread, move folders)
   */
  async modifyMessage(messageId, modifications) {
    const { addLabelIds, removeLabelIds, isRead } = modifications;

    const updateData = {};

    if (typeof isRead !== 'undefined') {
      updateData.isRead = isRead;
    }

    // TODO: Implementovat folder/category changes

    await executeGraphRequest(
      this.client,
      this.client.api(`/me/messages/${messageId}`).patch(updateData)
    );

    return { success: true };
  }

  // ==================== CALENDAR API ====================

  /**
   * Seznam událostí (ekvivalent Calendar.events.list)
   */
  async listCalendarEvents(options = {}) {
    const {
      timeMin,
      timeMax,
      maxResults = 50,
      pageToken,
    } = options;

    let request = this.client.api('/me/calendar/events')
      .top(maxResults)
      .select('id,subject,start,end,location,attendees,isAllDay,recurrence');

    // Time filtering
    if (timeMin && timeMax) {
      const startDateTime = new Date(timeMin).toISOString();
      const endDateTime = new Date(timeMax).toISOString();
      request = request.filter(`start/dateTime ge '${startDateTime}' and end/dateTime le '${endDateTime}'`);
    }

    // Pagination
    if (pageToken) {
      request = request.skipToken(pageToken);
    }

    const response = await executeGraphRequest(this.client, request.get());

    return {
      events: response.value.map(evt => this._mapEventToGoogleFormat(evt)),
      nextPageToken: response['@odata.nextLink'] ? this._extractSkipToken(response['@odata.nextLink']) : null,
    };
  }

  /**
   * Vytvořit událost (ekvivalent Calendar.events.insert)
   */
  async createCalendarEvent(eventData) {
    const {
      summary,
      description,
      start,
      end,
      location,
      attendees,
      timeZone = 'UTC',
    } = eventData;

    const event = {
      subject: summary,
      body: {
        contentType: 'Text',
        content: description || '',
      },
      start: {
        dateTime: start.dateTime,
        timeZone: this._convertIANAToWindowsTimezone(timeZone),
      },
      end: {
        dateTime: end.dateTime,
        timeZone: this._convertIANAToWindowsTimezone(timeZone),
      },
    };

    if (location) {
      event.location = {
        displayName: location,
      };
    }

    if (attendees && attendees.length > 0) {
      event.attendees = attendees.map(att => ({
        emailAddress: {
          address: att.email,
          name: att.displayName || att.email,
        },
        type: 'required',
      }));
    }

    const created = await executeGraphRequest(
      this.client,
      this.client.api('/me/calendar/events').post(event)
    );

    return this._mapEventToGoogleFormat(created);
  }

  /**
   * Aktualizovat událost (ekvivalent Calendar.events.update)
   */
  async updateCalendarEvent(eventId, eventData) {
    // Podobné jako createCalendarEvent, ale PATCH
    const updates = {};

    if (eventData.summary) updates.subject = eventData.summary;
    if (eventData.description) updates.body = { contentType: 'Text', content: eventData.description };
    // ... další fields

    const updated = await executeGraphRequest(
      this.client,
      this.client.api(`/me/calendar/events/${eventId}`).patch(updates)
    );

    return this._mapEventToGoogleFormat(updated);
  }

  /**
   * Smazat událost (ekvivalent Calendar.events.delete)
   */
  async deleteCalendarEvent(eventId) {
    await executeGraphRequest(
      this.client,
      this.client.api(`/me/calendar/events/${eventId}`).delete()
    );

    return { success: true };
  }

  // ==================== TO DO API ====================

  /**
   * Seznam úkolových listů (ekvivalent Tasks.tasklists.list)
   */
  async listTaskLists() {
    const response = await executeGraphRequest(
      this.client,
      this.client.api('/me/todo/lists').get()
    );

    return response.value.map(list => ({
      id: list.id,
      title: list.displayName,
    }));
  }

  /**
   * Seznam úkolů (ekvivalent Tasks.tasks.list)
   */
  async listTasks(taskListId, options = {}) {
    const { showCompleted = true } = options;

    let request = this.client.api(`/me/todo/lists/${taskListId}/tasks`)
      .select('id,title,body,status,importance,dueDateTime,createdDateTime');

    if (!showCompleted) {
      request = request.filter("status ne 'completed'");
    }

    const response = await executeGraphRequest(this.client, request.get());

    return response.value.map(task => this._mapTaskToGoogleFormat(task));
  }

  /**
   * Vytvořit úkol (ekvivalent Tasks.tasks.insert)
   */
  async createTask(taskListId, taskData) {
    const { title, notes, due } = taskData;

    const task = {
      title,
    };

    if (notes) {
      task.body = {
        content: notes,
        contentType: 'text',
      };
    }

    if (due) {
      task.dueDateTime = {
        dateTime: due,
        timeZone: 'UTC',
      };
    }

    const created = await executeGraphRequest(
      this.client,
      this.client.api(`/me/todo/lists/${taskListId}/tasks`).post(task)
    );

    return this._mapTaskToGoogleFormat(created);
  }

  /**
   * Aktualizovat úkol (ekvivalent Tasks.tasks.update)
   */
  async updateTask(taskListId, taskId, updates) {
    const patchData = {};

    if (updates.title) patchData.title = updates.title;
    if (updates.status) patchData.status = updates.status; // 'notStarted', 'inProgress', 'completed'
    // ... další fields

    const updated = await executeGraphRequest(
      this.client,
      this.client.api(`/me/todo/lists/${taskListId}/tasks/${taskId}`).patch(patchData)
    );

    return this._mapTaskToGoogleFormat(updated);
  }

  /**
   * Smazat úkol (ekvivalent Tasks.tasks.delete)
   */
  async deleteTask(taskListId, taskId) {
    await executeGraphRequest(
      this.client,
      this.client.api(`/me/todo/lists/${taskListId}/tasks/${taskId}`).delete()
    );

    return { success: true };
  }

  // ==================== CONTACTS API ====================

  /**
   * Seznam kontaktů (nová funkce - nahrazuje Sheets)
   */
  async listContacts(options = {}) {
    const { maxResults = 100 } = options;

    const response = await executeGraphRequest(
      this.client,
      this.client.api('/me/contacts')
        .top(maxResults)
        .select('id,displayName,emailAddresses,mobilePhone,homePhones,businessPhones')
        .get()
    );

    return response.value.map(contact => ({
      id: contact.id,
      name: contact.displayName,
      email: contact.emailAddresses?.[0]?.address || '',
      phone: contact.mobilePhone || contact.homePhones?.[0] || contact.businessPhones?.[0] || '',
    }));
  }

  /**
   * Vytvořit kontakt
   */
  async createContact(contactData) {
    const { name, email, phone } = contactData;

    const contact = {
      displayName: name,
    };

    if (email) {
      contact.emailAddresses = [{
        address: email,
        name: name,
      }];
    }

    if (phone) {
      contact.mobilePhone = phone;
    }

    const created = await executeGraphRequest(
      this.client,
      this.client.api('/me/contacts').post(contact)
    );

    return {
      id: created.id,
      name: created.displayName,
      email: created.emailAddresses?.[0]?.address || '',
      phone: created.mobilePhone || '',
    };
  }

  /**
   * Aktualizovat kontakt
   */
  async updateContact(contactId, updates) {
    const patchData = {};

    if (updates.name) patchData.displayName = updates.name;
    if (updates.email) patchData.emailAddresses = [{ address: updates.email }];
    if (updates.phone) patchData.mobilePhone = updates.phone;

    await executeGraphRequest(
      this.client,
      this.client.api(`/me/contacts/${contactId}`).patch(patchData)
    );

    return { success: true };
  }

  /**
   * Smazat kontakt
   */
  async deleteContact(contactId) {
    await executeGraphRequest(
      this.client,
      this.client.api(`/me/contacts/${contactId}`).delete()
    );

    return { success: true };
  }

  // ==================== HELPER METHODS ====================

  /**
   * Konverze Gmail query syntax na OData filter
   */
  _convertGmailQueryToOData(gmailQuery) {
    // Příklad: "from:john@example.com is:unread"
    // → "from/emailAddress/address eq 'john@example.com' and isRead eq false"

    // TODO: Implementovat kompletní parser
    // Toto bude složité - Gmail má velmi bohatou query syntax

    let filter = '';

    // Základní parsování (rozšířit podle potřeby):
    if (gmailQuery.includes('is:unread')) {
      filter += 'isRead eq false';
    }

    const fromMatch = gmailQuery.match(/from:(\S+)/);
    if (fromMatch) {
      const emailFilter = `from/emailAddress/address eq '${fromMatch[1]}'`;
      filter = filter ? `${filter} and ${emailFilter}` : emailFilter;
    }

    // ... další parsování

    return filter || undefined;
  }

  /**
   * Konverze IANA timezone na Windows timezone
   */
  _convertIANAToWindowsTimezone(ianaTimezone) {
    const timezoneMap = {
      'Europe/Prague': 'Central Europe Standard Time',
      'UTC': 'UTC',
      'America/New_York': 'Eastern Standard Time',
      'America/Los_Angeles': 'Pacific Standard Time',
      // ... kompletní mapping
    };

    return timezoneMap[ianaTimezone] || 'UTC';
  }

  /**
   * Extrakce skip token z @odata.nextLink
   */
  _extractSkipToken(nextLink) {
    const match = nextLink.match(/\$skiptoken=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Mapování Microsoft message na Gmail-like format
   */
  _mapMessageToGmailFormat(message) {
    // TODO: Implementovat kompletní mapping
    return {
      id: message.id,
      threadId: message.conversationId,
      labelIds: [], // TODO: Mapovat z folders/categories
      snippet: message.bodyPreview,
      // ... další fields
    };
  }

  /**
   * Mapování Microsoft event na Google Calendar format
   */
  _mapEventToGoogleFormat(event) {
    return {
      id: event.id,
      summary: event.subject,
      description: event.body?.content || '',
      start: {
        dateTime: event.start.dateTime,
        timeZone: this._convertWindowsToIANATimezone(event.start.timeZone),
      },
      end: {
        dateTime: event.end.dateTime,
        timeZone: this._convertWindowsToIANATimezone(event.end.timeZone),
      },
      // ... další fields
    };
  }

  /**
   * Mapování Microsoft task na Google Tasks format
   */
  _mapTaskToGoogleFormat(task) {
    return {
      id: task.id,
      title: task.title,
      notes: task.body?.content || '',
      due: task.dueDateTime?.dateTime || null,
      status: task.status === 'completed' ? 'completed' : 'needsAction',
    };
  }

  /**
   * Konverze Windows timezone na IANA timezone
   */
  _convertWindowsToIANATimezone(windowsTimezone) {
    const timezoneMap = {
      'Central Europe Standard Time': 'Europe/Prague',
      'UTC': 'UTC',
      'Eastern Standard Time': 'America/New_York',
      'Pacific Standard Time': 'America/Los_Angeles',
      // ... kompletní mapping
    };

    return timezoneMap[windowsTimezone] || 'UTC';
  }
}
```

### Krok 8: Refaktorovat existing services

Postupně nahradit všechny volání `googleApiService` → `microsoftGraphService`:

- `src/services/facadeService.js`
- `src/services/contactsService.js` (kompletní rewrite)
- `src/services/tasksService.js` (adapter pattern)

### Krok 9: Update Controllers

Minimální změny - většinou jen update import statements a error handling.

### Krok 10: Testing

Vytvořit comprehensive test suite:

```javascript
// tests/microsoftGraphService.test.js
import { MicrosoftGraphService } from '../src/services/microsoftGraphService.js';

describe('MicrosoftGraphService - Mail API', () => {
  test('should list messages', async () => {
    const service = new MicrosoftGraphService(testAccessToken);
    const result = await service.listMessages({ maxResults: 10 });
    expect(result.messages).toBeInstanceOf(Array);
  });

  test('should send email', async () => {
    const service = new MicrosoftGraphService(testAccessToken);
    const result = await service.sendMessage({
      to: ['test@example.com'],
      subject: 'Test',
      body: 'Test message',
      isHtml: false,
    });
    expect(result.success).toBe(true);
  });

  // ... další testy
});
```

---

## ⏱️ Časový odhad

### Celkový čas: **7-11 týdnů** (full-time vývojář)

| Fáze | Trvání | Náročnost |
|------|--------|-----------|
| **Fáze 1: Příprava** | 1 týden | Nízká |
| **Fáze 2: Core autentizace** | 1-2 týdny | Střední |
| **Fáze 3: Service layer** | 3-4 týdny | **Vysoká** |
| **Fáze 4: Facade layer** | 1-2 týdny | Střední |
| **Fáze 5: Testing & Deployment** | 1-2 týdny | Střední |

### Kritická cesta:
1. **Email service** (nejvíce práce) - 2 týdny
2. **Contacts redesign** - 1 týden
3. **OAuth flow** - 1 týden
4. **Comprehensive testing** - 1 týden

### Risk factors:
- **Gmail query syntax conversion** - složité, může trvat déle
- **MIME → JSON konverze** - edge cases s attachmenty
- **Rate limiting issues** - může vyžadovat optimalizaci
- **Timezone handling** - edge cases s DST

---

## 🎓 Doporučené zdroje

### Official Microsoft dokumentace:
1. **Microsoft Graph API Overview:** https://learn.microsoft.com/en-us/graph/overview
2. **Mail API:** https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview
3. **Calendar API:** https://learn.microsoft.com/en-us/graph/outlook-calendar-concept-overview
4. **To Do API:** https://learn.microsoft.com/en-us/graph/todo-concept-overview
5. **Contacts API:** https://learn.microsoft.com/en-us/graph/api/resources/contact
6. **OAuth dokumentace:** https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow

### Tools a libraries:
- **Microsoft Graph JavaScript Client:** https://github.com/microsoftgraph/msgraph-sdk-javascript
- **MSAL Node:** https://github.com/AzureAD/microsoft-authentication-library-for-js/tree/dev/lib/msal-node
- **Graph Explorer:** https://developer.microsoft.com/en-us/graph/graph-explorer (testování API)

---

## 📌 Závěr a doporučení

### Klíčová zjištění:

1. **Migrace je proveditelná** - Microsoft Graph API pokrývá všechny Google služby
2. **Nejvíce práce:** Email service (Gmail → Outlook Mail)
3. **Doporučená změna:** Kontakty z Excel → nativní Contacts API
4. **Časový odhad:** 7-11 týdnů full-time práce
5. **Riziko:** Střední - hlavně kvůli složitosti Gmail query syntax konverze

### Doporučený přístup:

1. **Začít s OAuth flow** - základní infrastruktura
2. **Implementovat jednu službu po druhé** - iterativně
3. **Začít s Tasks API** - nejjednodušší, rychlé wins
4. **Pak Calendar** - středně složité
5. **Nakonec Mail** - nejvíce práce, ale nejdůležitější
6. **Contacts redesign** - paralelně s ostatním

### Alternativní strategie:

**Dual-mode server:**
- Podporovat OBOJÍ Google i Microsoft
- Detekovat typ účtu při OAuth
- Použít adapter pattern pro jednotné rozhraní
- **Výhoda:** Flexibilita pro uživatele
- **Nevýhoda:** 2x údržba, 2x complexity

---

**Připraven odpovědět na další dotazy a začít s implementací! 🚀**
