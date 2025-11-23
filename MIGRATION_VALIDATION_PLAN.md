# Robustní Plán pro Analýzu Migrace mezi Platformami

**Datum vytvoření:** 2025-11-23
**Verze:** 1.0
**Účel:** Systematický postup pro validaci migrace z Google na Microsoft (nebo podobných přechodů)

---

## 📋 Obsah

1. [Úvod - Lekce z Google → Microsoft migrace](#úvod)
2. [Fáze 1: Mapování API a funkcionalit](#fáze-1-mapování-api-a-funkcionalit)
3. [Fáze 2: Kritické body kontroly](#fáze-2-kritické-body-kontroly)
4. [Fáze 3: Testování integrity dat](#fáze-3-testování-integrity-dat)
5. [Fáze 4: Performance a limity](#fáze-4-performance-a-limity)
6. [Fáze 5: Bezpečnost a autentizace](#fáze-5-bezpečnost-a-autentizace)
7. [Fáze 6: Edge cases a chybové stavy](#fáze-6-edge-cases-a-chybové-stavy)
8. [Fáze 7: Zpětná kompatibilita](#fáze-7-zpětná-kompatibilita)
9. [Checklist pro budoucí migrace](#checklist-pro-budoucí-migrace)
10. [Automatizované testy](#automatizované-testy)

---

## Úvod

### Kontext současné migrace (Google → Microsoft)

V tomto repozitáři proběhla migrace:
- **54 souborů změněno**
- **~8,700 řádků přidáno**, ~1,300 odstraněno
- **5 hlavních služeb**: Mail, Calendar, Tasks, Contacts, Drive
- **Stav:** Označeno jako 100% kompletní

### Co se může pokazit při podobných migracích

1. **Neúplné mapování API** - Některé funkce zdánlivě fungují, ale chybí edge cases
2. **Sémantické rozdíly** - API vypadá podobně, ale chová se jinak
3. **Skryté závislosti** - Kód spoléhá na specifické chování starého API
4. **Chybějící error handling** - Nové API vrací jiné chyby
5. **Performance regression** - Nové API je pomalejší/má jiné limity
6. **Datové ztráty** - Konverze mezi formáty ztrácí informace
7. **Bezpečnostní díry** - Nové oprávnění nejsou správně nastavena
8. **Token management** - Rozdíly v životnosti/refreshi tokenů
9. **Timezone handling** - Různé formáty (IANA vs Windows)
10. **Encoding/charset issues** - Různé kódování dat

---

## Fáze 1: Mapování API a funkcionalit

### 1.1 Kompletní inventarizace starého API

**Cíl:** Zjistit VŠECHNY funkce, které stará implementace používala

#### Krok 1: Statická analýza

```bash
# Najít všechny volání starého API (příklad pro Google)
grep -r "gmail\." src/legacy-google --include="*.js" | cut -d: -f2 | sort | uniq > api_calls_old.txt
grep -r "calendar\." src/legacy-google --include="*.js" | cut -d: -f2 | sort | uniq >> api_calls_old.txt

# Najít všechny importy
grep -r "from 'googleapis'" src/legacy-google --include="*.js"

# Najít všechny konfigurace
grep -r "GOOGLE_" .env.example
```

#### Krok 2: Dynamická analýza

```javascript
// Přidat logging wrapper do starého API (před migrací)
const originalApi = googleApiService;
const loggedApi = new Proxy(originalApi, {
  get(target, prop) {
    return function(...args) {
      console.log(`[API_USAGE] ${prop}`, { args: args.map(a => typeof a) });
      return target[prop](...args);
    }
  }
});
```

#### Krok 3: Dokumentace funkcí

| Stará funkce | Parametry | Návratová hodnota | Použití (počet callsites) | Kritičnost |
|--------------|-----------|-------------------|---------------------------|------------|
| `searchEmails(query)` | `string` | `Array<Email>` | 15 míst | KRITICKÁ |
| `sendEmail(to, subject, body)` | `string, string, string` | `{id, threadId}` | 8 míst | KRITICKÁ |
| ... | ... | ... | ... | ... |

**⚠️ Vytvořit CSV s úplným seznamem funkcí:**
```bash
# Export všech funkcí do tabulky
node scripts/extract-api-usage.js > api_inventory.csv
```

---

### 1.2 Mapování na nové API

**Cíl:** Pro KAŽDOU starou funkci najít ekvivalent v novém API

#### Validační checklist:

- [ ] **1:1 mapování** - Existuje přímý ekvivalent?
- [ ] **Parametry** - Bere nový endpoint stejné parametry?
- [ ] **Návratový formát** - Vrací stejnou strukturu dat?
- [ ] **Chybové kódy** - Jaké chyby nové API vrací?
- [ ] **Performance** - Je nové API stejně rychlé?
- [ ] **Rate limity** - Má stejné/přísnější limity?
- [ ] **Autorizace** - Vyžaduje stejná/jiná oprávnění?

#### Příklad mapování:

```markdown
## Gmail API → Outlook Mail API

### searchEmails(query, maxResults)

**Stará implementace (Google):**
```javascript
GET /gmail/v1/users/me/messages?q={query}&maxResults={maxResults}
Query syntax: "from:john@example.com is:unread"
Response: { messages: [{id, threadId}], nextPageToken }
Rate limit: 250 quota units per query
```

**Nová implementace (Microsoft):**
```javascript
GET /me/messages?$filter={odata_filter}&$top={maxResults}
Query syntax: "from/emailAddress/address eq 'john@example.com' and isRead eq false"
Response: { value: [{id, conversationId}], @odata.nextLink }
Rate limit: 10,000 requests per 10 minutes
```

**Kritické rozdíly:**
1. ❌ Query syntax NENÍ kompatibilní - vyžaduje parsing a konverzi
2. ✅ Pagination funguje podobně (nextPageToken vs @odata.nextLink)
3. ⚠️ Rate limity jsou jiné - může vyžadovat adjustaci
4. ❌ Response format je odlišný - vyžaduje mapping layer

**Mitigace:**
- Implementovat query parser: `convertGmailQueryToOData(gmailQuery)`
- Implementovat response mapper: `mapOutlookMessageToGmail(outlookMsg)`
- Adjustovat rate limiting middleware
```

---

### 1.3 Identifikace chybějících funkcí

**Cíl:** Najít funkce, které nové API NEPODPORUJE

#### Template pro dokumentaci:

```markdown
### Chybějící funkce: {Název funkce}

**Stará implementace:**
- Popis co dělala
- Kde se používala (file:line)
- Jak často (denně/týdně)

**Důvod chybění:**
- [ ] Nové API to nepodporuje vůbec
- [ ] Existuje alternativní způsob
- [ ] Vyžaduje workaround

**Dopad:**
- [ ] KRITICKÝ - aplikace nefunguje bez toho
- [ ] VYSOKÝ - zásadní feature nefunguje
- [ ] STŘEDNÍ - méně důležitá funkce
- [ ] NÍZKÝ - edge case

**Plánované řešení:**
1. Popis řešení
2. Časový odhad
3. Rizika
```

---

## Fáze 2: Kritické body kontroly

### 2.1 Datové struktury a konverze

**Co kontrolovat:**

#### 2.1.1 Message/Email struktura

```javascript
// CHECKLIST pro email konverzi
const emailValidation = {
  // Základní pole
  id: { old: 'string', new: 'string', status: '✅' },
  subject: { old: 'string', new: 'string', status: '✅' },

  // Složité konverze
  body: {
    old: 'base64url encoded MIME',
    new: 'JSON { contentType, content }',
    status: '⚠️ VYŽADUJE KONVERZI',
    converter: 'parseGmailMime() → buildOutlookBody()'
  },

  // Metadata
  labels: {
    old: 'Array<string> ["INBOX", "UNREAD"]',
    new: 'Folder + isRead property',
    status: '⚠️ SÉMANTICKÝ ROZDÍL',
    notes: 'Gmail má labels (many-to-many), Outlook má folders (one-to-many)'
  },

  // Přílohy
  attachments: {
    old: 'Part of MIME message',
    new: 'Separate /attachments endpoint',
    status: '⚠️ VYŽADUJE EXTRA REQUEST',
    performance: 'Může zpomalit načítání emailů s přílohami'
  }
};

// Pro KAŽDÉ pole vytvořit test
describe('Email structure conversion', () => {
  it('converts Gmail message to Outlook format', () => {
    const gmailMsg = loadFixture('gmail-message-full.json');
    const outlookMsg = convertToOutlook(gmailMsg);

    expect(outlookMsg).toMatchSnapshot();
    expect(outlookMsg.subject).toBe(gmailMsg.subject);
    // ... všechna pole
  });

  it('preserves attachments', () => {
    const gmailMsg = loadFixture('gmail-with-attachments.json');
    const outlookMsg = convertToOutlook(gmailMsg);

    expect(outlookMsg.attachments.length).toBe(gmailMsg.payload.parts.length);
  });
});
```

#### 2.1.2 Calendar Event struktura

```javascript
const calendarEventValidation = {
  // Časová pásma - KRITICKÉ!
  timeZone: {
    old: 'IANA timezone (Europe/Prague)',
    new: 'Windows timezone (Central Europe Standard Time)',
    status: '❌ NEKOMPATIBILNÍ',
    converter: 'convertIANAToWindows()',
    edgeCases: [
      'DST transitions',
      'Deprecated timezone names',
      'Non-standard timezones'
    ]
  },

  // Opakování
  recurrence: {
    old: 'RFC 5545 RRULE',
    new: 'Microsoft Graph recurrence pattern object',
    status: '❌ VYŽADUJE PARSER',
    examples: [
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=15'
    ]
  },

  // Účastníci
  attendees: {
    old: '[{email: "john@example.com"}]',
    new: '[{emailAddress: {address: "john@example.com"}, type: "required"}]',
    status: '⚠️ STRUKTURA SE LIŠÍ'
  }
};
```

#### 2.1.3 Validační testy

```javascript
// Test že konverze je symetrická (roundtrip)
describe('Roundtrip conversion', () => {
  it('Gmail → Outlook → Gmail preserves data', () => {
    const original = loadFixture('gmail-message.json');
    const outlook = convertToOutlook(original);
    const backToGmail = convertToGmail(outlook);

    expect(backToGmail).toEqual(original);
  });
});

// Test edge cases
describe('Edge cases', () => {
  it('handles empty body', () => {
    const msg = { subject: 'Test', body: '' };
    expect(() => convertToOutlook(msg)).not.toThrow();
  });

  it('handles missing fields', () => {
    const msg = { id: '123' }; // minimální zpráva
    const converted = convertToOutlook(msg);
    expect(converted).toBeDefined();
  });

  it('handles very large emails', () => {
    const largeBody = 'x'.repeat(10_000_000); // 10MB
    const msg = { subject: 'Large', body: largeBody };
    // Mělo by failnout gracefully nebo oříznout
    expect(() => convertToOutlook(msg)).not.toThrow();
  });
});
```

---

### 2.2 Token Management

**Kritické kontroly:**

#### 2.2.1 TokenLifeCycle

```markdown
| Aspekt | Google OAuth | Microsoft OAuth | Potenciální problém |
|--------|--------------|-----------------|---------------------|
| **Access token expiry** | 3600s (1h) | 3600s (1h) | ✅ Stejné |
| **Refresh token expiry** | ~6 měsíců | 90 dní (default) | ⚠️ Kratší u Microsoft! |
| **Token rotation** | Refresh token se nemění | **Může se změnit!** | ❌ KRITICKÉ - musíme uložit nový |
| **Offline access** | Implicitní s refresh_token | **Vyžaduje scope "offline_access"** | ❌ MUSÍ být v scopes! |
| **Token revocation** | /revoke endpoint | /logout endpoint | ⚠️ Jiný endpoint |
```

#### 2.2.2 Testy token managementu

```javascript
// Test refresh token rotace
describe('Token refresh (Microsoft)', () => {
  it('saves new refresh token when rotated', async () => {
    const oldRefreshToken = 'old_token_abc';
    const newRefreshToken = 'new_token_xyz';

    mockMicrosoftTokenEndpoint({
      access_token: 'new_access',
      refresh_token: newRefreshToken, // Microsoft může poslat nový!
      expires_in: 3600
    });

    await refreshAccessToken(oldRefreshToken);

    // Ověřit že nový refresh token je uložený
    const user = await getUserByMicrosoftId('user123');
    expect(user.refreshToken).toBe(newRefreshToken);
  });

  it('handles refresh token expiry gracefully', async () => {
    mockMicrosoftTokenEndpoint({
      error: 'invalid_grant',
      error_description: 'AADSTS70000: Refresh token has expired'
    });

    const result = await refreshAccessToken('expired_token');

    // Mělo by vrátit error, ne crashnout
    expect(result.success).toBe(false);
    expect(result.requiresReauth).toBe(true);
  });
});
```

---

### 2.3 Error Handling

**Co kontrolovat:**

#### 2.3.1 Mapování chybových kódů

```javascript
// Kompletní tabulka error kódů
const errorCodeMapping = {
  // Autentizace
  'GOOGLE: 401 Unauthorized': {
    microsoft: '401 Unauthorized',
    graphCode: 'InvalidAuthenticationToken',
    handling: 'Refresh access token',
    test: 'should trigger token refresh'
  },

  'GOOGLE: invalid_grant (refresh failed)': {
    microsoft: 'AADSTS70000',
    description: 'Refresh token expired/revoked',
    handling: 'Redirect to re-auth',
    test: 'should require user re-authentication'
  },

  // Rate limiting
  'GOOGLE: 429 Too Many Requests': {
    microsoft: '429 Too Many Requests',
    graphCode: 'TooManyRequests',
    handling: 'Exponential backoff with Retry-After header',
    test: 'should retry with increasing delays'
  },

  // Not found
  'GOOGLE: 404 Not Found': {
    microsoft: '404 Not Found',
    graphCode: 'ResourceNotFound / ItemNotFound',
    handling: 'Return null or error to client',
    test: 'should return appropriate error'
  },

  // Permission denied
  'GOOGLE: 403 Forbidden (insufficient permissions)': {
    microsoft: '403 Forbidden',
    graphCode: 'AccessDenied',
    handling: 'Check required scopes',
    test: 'should indicate missing permissions'
  }
};

// Generovat testy z tabulky
Object.entries(errorCodeMapping).forEach(([oldError, mapping]) => {
  describe(`Error handling: ${oldError}`, () => {
    it(mapping.test, async () => {
      mockMicrosoftError(mapping.microsoft, mapping.graphCode);

      const result = await microsoftGraphService.someOperation();

      // Verifikovat správné zpracování
      expect(result.error).toBeDefined();
      // ... další assertions
    });
  });
});
```

#### 2.3.2 Network failures

```javascript
describe('Network resilience', () => {
  it('retries on network timeout', async () => {
    let attempts = 0;
    mockMicrosoftApi(() => {
      attempts++;
      if (attempts < 3) throw new Error('ETIMEDOUT');
      return { value: [] };
    });

    const result = await microsoftGraphService.listMessages();

    expect(attempts).toBe(3);
    expect(result).toBeDefined();
  });

  it('fails gracefully after max retries', async () => {
    mockMicrosoftApi(() => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      microsoftGraphService.listMessages()
    ).rejects.toThrow('Service unavailable');
  });
});
```

---

## Fáze 3: Testování integrity dat

### 3.1 Comparative Testing (Google vs Microsoft)

**Přístup:** Paralelní běh obou implementací a porovnání výsledků

```javascript
// Dual-mode test framework
describe('Comparative API testing', () => {
  let googleService;
  let microsoftService;

  beforeAll(() => {
    googleService = createGoogleService(testToken);
    microsoftService = createMicrosoftService(testToken);
  });

  it('lists same emails from both providers', async () => {
    const [googleEmails, microsoftEmails] = await Promise.all([
      googleService.listMessages({ maxResults: 50 }),
      microsoftService.listMessages({ maxResults: 50 })
    ]);

    // Normalizovat formáty
    const googleNormalized = normalizeGmailResponse(googleEmails);
    const microsoftNormalized = normalizeOutlookResponse(microsoftEmails);

    // Porovnat
    expect(googleNormalized.length).toBe(microsoftNormalized.length);

    googleNormalized.forEach((gMsg, i) => {
      const mMsg = microsoftNormalized[i];
      expect(mMsg.subject).toBe(gMsg.subject);
      expect(mMsg.from).toBe(gMsg.from);
      // ... další pole
    });
  });

  it('sends email with same result', async () => {
    const testEmail = {
      to: ['test@example.com'],
      subject: 'Test migration',
      body: 'Testing both APIs'
    };

    const [googleResult, microsoftResult] = await Promise.all([
      googleService.sendMessage(testEmail),
      microsoftService.sendMessage(testEmail)
    ]);

    // Obě by měly uspět
    expect(googleResult.success).toBe(true);
    expect(microsoftResult.success).toBe(true);

    // Cleanup
    await googleService.deleteMessage(googleResult.id);
    await microsoftService.deleteMessage(microsoftResult.id);
  });
});
```

### 3.2 Data consistency checks

```javascript
// Kontrola konzistence po migraci
describe('Post-migration data integrity', () => {
  it('preserves all user data', async () => {
    // Před migrací: export dat
    const beforeMigration = await exportAllUserData('user123', 'google');

    // Po migraci: export dat
    const afterMigration = await exportAllUserData('user123', 'microsoft');

    // Porovnat
    expect(afterMigration.emails.count).toBe(beforeMigration.emails.count);
    expect(afterMigration.events.count).toBe(beforeMigration.events.count);
    expect(afterMigration.tasks.count).toBe(beforeMigration.tasks.count);
    expect(afterMigration.contacts.count).toBe(beforeMigration.contacts.count);
  });

  it('migrates all labels/folders', async () => {
    const googleLabels = await googleService.listLabels();
    const outlookFolders = await microsoftService.listFolders();

    // Mapovat a porovnat
    const mappedLabels = googleLabels.map(mapLabelToFolder);
    expect(outlookFolders).toEqual(expect.arrayContaining(mappedLabels));
  });
});
```

---

## Fáze 4: Performance a limity

### 4.1 Rate Limiting

**Porovnání limitů:**

```markdown
| Operace | Google API | Microsoft Graph | Akce |
|---------|-----------|-----------------|------|
| **List messages** | 250 quota/request | 10k requests/10min | ✅ Microsoft je benevolentnější |
| **Send email** | 100 quota/request | 10k requests/10min | ✅ OK |
| **Batch requests** | 100 requests/batch | 20 requests/batch | ⚠️ Microsoft má nižší limit! |
| **Attachment size** | 35 MB | 3 MB (per request) | ❌ KRITICKÉ - Microsoft má limit! |
```

#### 4.1.1 Test rate limiting

```javascript
describe('Rate limit handling', () => {
  it('respects Retry-After header', async () => {
    mockMicrosoftApi({
      status: 429,
      headers: { 'Retry-After': '5' } // 5 sekund
    });

    const startTime = Date.now();
    await microsoftService.listMessages();
    const duration = Date.now() - startTime;

    // Mělo by počkat alespoň 5 sekund
    expect(duration).toBeGreaterThanOrEqual(5000);
  });

  it('handles burst of requests', async () => {
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(microsoftService.getMessage(`msg-${i}`));
    }

    // Nemělo by failnout, mělo by throttlovat
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled');

    expect(successful.length).toBeGreaterThan(0);
  });
});
```

### 4.2 Performance benchmarking

```javascript
// Benchmark suite
describe('Performance comparison', () => {
  it('measures email listing speed', async () => {
    const iterations = 10;

    // Google API
    const googleStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await googleService.listMessages({ maxResults: 50 });
    }
    const googleDuration = performance.now() - googleStart;

    // Microsoft API
    const msStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await microsoftService.listMessages({ maxResults: 50 });
    }
    const msDuration = performance.now() - msStart;

    console.log({
      google: `${googleDuration}ms (avg: ${googleDuration/iterations}ms)`,
      microsoft: `${msDuration}ms (avg: ${msDuration/iterations}ms)`,
      ratio: (msDuration / googleDuration).toFixed(2)
    });

    // Alert pokud je Microsoft >2x pomalejší
    if (msDuration > googleDuration * 2) {
      console.warn('⚠️ Microsoft API is significantly slower!');
    }
  });

  it('measures batch operation performance', async () => {
    const operations = Array(50).fill(0).map((_, i) => ({
      id: `msg-${i}`,
      operation: 'markAsRead'
    }));

    // Měřit čas batch operace
    const start = performance.now();
    await microsoftService.batchModify(operations);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(5000); // <5s pro 50 operací
  });
});
```

---

## Fáze 5: Bezpečnost a autentizace

### 5.1 OAuth Scopes Audit

**Checklist:**

```markdown
## Audit oprávnění

### Stará oprávnění (Google)
- ✅ `https://mail.google.com/` - Full email access
- ✅ `https://www.googleapis.com/auth/calendar` - Calendar read/write
- ✅ `https://www.googleapis.com/auth/tasks` - Tasks read/write
- ✅ `https://www.googleapis.com/auth/spreadsheets` - Sheets read/write
- ✅ `https://www.googleapis.com/auth/drive.file` - Drive access to app-created files

### Nová oprávnění (Microsoft)
- ✅ `Mail.Read` - Read email
- ✅ `Mail.ReadWrite` - Read/write email
- ✅ `Mail.Send` - Send email
- ✅ `Calendars.Read` - Read calendars
- ✅ `Calendars.ReadWrite` - Read/write calendars
- ✅ `Tasks.ReadWrite` - Read/write tasks
- ✅ `Files.ReadWrite` - OneDrive read/write
- ✅ `Files.ReadWrite.All` - **POZOR: širší než Google!**
- ✅ `Contacts.Read` - Read contacts
- ✅ `Contacts.ReadWrite` - Read/write contacts
- ⚠️ `offline_access` - **KRITICKÉ: Zapomenuto?**

### Kontrola:
- [ ] Jsou všechna nová oprávnění skutečně potřebná?
- [ ] Není některé oprávnění příliš široké?
- [ ] Je `offline_access` v seznamu? (MUSÍ být pro refresh token!)
- [ ] Vyžadují nějaká oprávnění admin consent?
```

### 5.2 Security tests

```javascript
describe('Security validation', () => {
  it('rejects requests without valid token', async () => {
    const invalidService = createMicrosoftService('invalid-token');

    await expect(
      invalidService.listMessages()
    ).rejects.toThrow('Unauthorized');
  });

  it('does not expose tokens in logs', async () => {
    const logSpy = jest.spyOn(console, 'log');

    await microsoftService.listMessages();

    const logs = logSpy.mock.calls.map(call => call.join(' '));
    logs.forEach(log => {
      expect(log).not.toMatch(/Bearer\s+[A-Za-z0-9_-]+/);
      expect(log).not.toMatch(/access_token/);
    });
  });

  it('encrypts tokens in database', async () => {
    const user = await getUserByMicrosoftId('user123');

    // Token v DB by měl být encrypted
    expect(user.accessToken).not.toMatch(/^ey/); // JWT začíná "ey"
    expect(user.refreshToken).not.toMatch(/^[A-Za-z0-9_-]{100,}$/);

    // Měl by obsahovat encrypted prefix
    expect(user.accessToken).toMatch(/^enc:/);
  });
});
```

---

## Fáze 6: Edge Cases a chybové stavy

### 6.1 Edge case catalog

**Systematický seznam edge cases k otestování:**

```markdown
## Email edge cases

### Velikost a formát
- [ ] Prázdný email (pouze subject, žádné body)
- [ ] Velmi dlouhý subject (>1000 znaků)
- [ ] Email s pouze HTML (žádný text)
- [ ] Email s pouze plaintext (žádné HTML)
- [ ] Email větší než 25 MB
- [ ] Email s 100+ přílohy
- [ ] Příloha větší než 35 MB (Google) / 3 MB (Microsoft)
- [ ] Příloha s nebezpečným typem (exe, bat, ...)

### Encoding
- [ ] Email s emoji v subject 🎉📧
- [ ] Email s CJK znaky (中文, 日本語, 한국어)
- [ ] Email s RTL textem (عربي, עברית)
- [ ] Email s různými charsets (UTF-8, ISO-8859-1, ...)

### Struktura
- [ ] Email bez thread ID
- [ ] Email v threadu s >100 zprávami
- [ ] Email s inline images
- [ ] Email s PGP/SMIME encryption
- [ ] Email s DKIM/SPF/DMARC headers

### Speciální případy
- [ ] Draft bez subject ani body
- [ ] Email s nedostupnou přílohou
- [ ] Email s inline forward
- [ ] Email s calendar invite
- [ ] Auto-reply / Out of office
```

### 6.2 Calendar edge cases

```markdown
## Calendar edge cases

### Časová pásma
- [ ] Event při DST transition (jaro/podzim)
- [ ] Event v timezone, které už neexistuje
- [ ] All-day event
- [ ] Multi-day event (3+ dny)
- [ ] Event spanning midnight
- [ ] Event s různými timezones (start vs end)

### Opakování
- [ ] Daily recurrence (každý den)
- [ ] Weekly on multiple days (Po, St, Pá)
- [ ] Monthly by date (každé 15.)
- [ ] Monthly by day (druhé úterý v měsíci)
- [ ] Yearly event
- [ ] Custom recurrence (každé 3 týdny)
- [ ] Recurrence s exceptions (smazaný instance)
- [ ] Recurrence s modifications (změněný instance)

### Účastníci
- [ ] Event bez účastníků
- [ ] Event s 100+ účastníky
- [ ] Event s external účastníky (jiná doména)
- [ ] Event s resource (meeting room)
- [ ] Event s optional attendees
```

### 6.3 Edge case tests

```javascript
describe('Edge cases - Email', () => {
  it('handles empty email body', async () => {
    const email = {
      to: ['test@example.com'],
      subject: 'Empty body test',
      body: ''
    };

    const result = await microsoftService.sendMessage(email);
    expect(result.success).toBe(true);
  });

  it('handles emoji in subject', async () => {
    const email = {
      to: ['test@example.com'],
      subject: 'Test 🎉 with emoji 📧',
      body: 'Body'
    };

    const sent = await microsoftService.sendMessage(email);
    const received = await microsoftService.getMessage(sent.id);

    expect(received.subject).toBe(email.subject);
  });

  it('handles large attachment (>3MB)', async () => {
    const largeFile = Buffer.alloc(5 * 1024 * 1024); // 5 MB

    const email = {
      to: ['test@example.com'],
      subject: 'Large attachment',
      body: 'See attachment',
      attachments: [{
        filename: 'large.bin',
        data: largeFile.toString('base64'),
        mimeType: 'application/octet-stream'
      }]
    };

    // Microsoft má limit 3 MB - mělo by failnout nebo použít OneDrive
    await expect(
      microsoftService.sendMessage(email)
    ).rejects.toThrow(/too large|size limit/i);
  });
});

describe('Edge cases - Calendar', () => {
  it('handles DST transition', async () => {
    // Event přes DST switch (Europe/Prague: 31.3.2024 2:00 → 3:00)
    const event = {
      summary: 'DST test',
      start: {
        dateTime: '2024-03-31T01:00:00',
        timeZone: 'Europe/Prague'
      },
      end: {
        dateTime: '2024-03-31T04:00:00',
        timeZone: 'Europe/Prague'
      }
    };

    const created = await microsoftService.createCalendarEvent(event);
    expect(created.id).toBeDefined();

    // Verifikovat že duration je 2 hodiny (ne 3)
    const duration = new Date(created.end.dateTime) - new Date(created.start.dateTime);
    expect(duration).toBe(2 * 60 * 60 * 1000);
  });

  it('handles all-day event', async () => {
    const event = {
      summary: 'All day',
      start: { date: '2024-12-25' },
      end: { date: '2024-12-26' }
    };

    const created = await microsoftService.createCalendarEvent(event);
    expect(created.isAllDay).toBe(true);
  });
});
```

---

## Fáze 7: Zpětná kompatibilita

### 7.1 API Contract verification

```javascript
// Verifikovat že nová implementace respektuje stejný kontrakt
describe('API Contract - Backward compatibility', () => {
  it('returns same structure for listMessages', async () => {
    const result = await microsoftService.listMessages({ maxResults: 10 });

    // Mělo by mít stejnou strukturu jako Google API
    expect(result).toHaveProperty('messages');
    expect(result).toHaveProperty('nextPageToken');
    expect(Array.isArray(result.messages)).toBe(true);

    if (result.messages.length > 0) {
      const msg = result.messages[0];
      expect(msg).toHaveProperty('id');
      expect(msg).toHaveProperty('threadId');
      expect(msg).toHaveProperty('labelIds');
      expect(msg).toHaveProperty('snippet');
    }
  });

  it('returns same structure for getMessage', async () => {
    const result = await microsoftService.getMessage('some-id');

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('threadId');
    expect(result).toHaveProperty('payload');
    expect(result.payload).toHaveProperty('headers');
    expect(result.payload).toHaveProperty('body');
  });
});
```

### 7.2 Migration path testing

```javascript
// Test migrace existujících uživatelů
describe('User migration', () => {
  it('migrates user from Google to Microsoft', async () => {
    // Simulovat uživatele s Google účtem
    const googleUser = {
      google_sub: 'google-user-123',
      accessToken: 'google-access-token',
      refreshToken: 'google-refresh-token',
      email: 'user@example.com'
    };

    await saveUser(googleUser);

    // Spustit migraci
    await migrateUserToMicrosoft(googleUser.google_sub);

    // Verifikovat že user má nyní Microsoft credentials
    const migratedUser = await getUserByEmail(googleUser.email);
    expect(migratedUser).toHaveProperty('microsoft_id');
    expect(migratedUser).not.toHaveProperty('google_sub');
    expect(migratedUser.accessToken).not.toBe(googleUser.accessToken);
  });

  it('preserves user data during migration', async () => {
    const googleUser = await getUserByGoogleSub('google-user-123');
    const beforeData = {
      emails: await googleService.listMessages({ maxResults: 100 }),
      events: await googleService.listCalendarEvents(),
      tasks: await googleService.listTasks()
    };

    await migrateUserToMicrosoft(googleUser.google_sub);

    const microsoftUser = await getUserByEmail(googleUser.email);
    const afterData = {
      emails: await microsoftService.listMessages({ maxResults: 100 }),
      events: await microsoftService.listCalendarEvents(),
      tasks: await microsoftService.listTasks()
    };

    expect(afterData.emails.length).toBe(beforeData.emails.length);
    expect(afterData.events.length).toBe(beforeData.events.length);
    expect(afterData.tasks.length).toBe(beforeData.tasks.length);
  });
});
```

---

## Fáze 8: Monitoring a observability

### 8.1 Metriky k sledování

```javascript
// Implementovat metriky pro srovnání
const metrics = {
  // Latence
  'api.latency.google.list_messages': histogram,
  'api.latency.microsoft.list_messages': histogram,

  // Success rate
  'api.success_rate.google': gauge,
  'api.success_rate.microsoft': gauge,

  // Error rate
  'api.errors.google.rate_limit': counter,
  'api.errors.microsoft.rate_limit': counter,

  // Token refresh
  'auth.token_refresh.google.success': counter,
  'auth.token_refresh.microsoft.success': counter,
  'auth.token_refresh.google.failure': counter,
  'auth.token_refresh.microsoft.failure': counter,

  // Data integrity
  'migration.data_loss.emails': gauge,
  'migration.data_loss.events': gauge
};
```

### 8.2 Alerting rules

```yaml
# Alert pokud Microsoft API má >2x error rate než Google mělo
- alert: MicrosoftHighErrorRate
  expr: rate(api_errors_microsoft_total[5m]) > 2 * rate(api_errors_google_total[5m])
  for: 10m
  annotations:
    summary: Microsoft API error rate significantly higher than Google

# Alert pokud token refresh selhává
- alert: TokenRefreshFailures
  expr: rate(auth_token_refresh_microsoft_failure[5m]) > 0.1
  for: 5m
  annotations:
    summary: High rate of Microsoft token refresh failures

# Alert pokud latence je >3x větší
- alert: MicrosoftSlowAPI
  expr: histogram_quantile(0.95, rate(api_latency_microsoft_list_messages_bucket[5m])) >
        3 * histogram_quantile(0.95, rate(api_latency_google_list_messages_bucket[5m]))
  for: 15m
  annotations:
    summary: Microsoft API is significantly slower than Google was
```

---

## Checklist pro budoucí migrace

### Pre-Migration Checklist

```markdown
## Před začátkem migrace

### 1. Dokumentace současného stavu
- [ ] Exportovat kompletní API usage statistics
- [ ] Zdokumentovat všechny používané endpointy
- [ ] Zmapovat všechny datové struktury
- [ ] Identifikovat všechny edge cases v produkci
- [ ] Změřit baseline performance metriky
- [ ] Exportovat error statistics (jaké chyby se vyskytují)

### 2. Analýza nového API
- [ ] Přečíst kompletní dokumentaci nového API
- [ ] Identifikovat breaking changes
- [ ] Zmapovat všechny endpointy (old → new)
- [ ] Identifikovat chybějící funkce
- [ ] Zkontrolovat rate limity a kvóty
- [ ] Prostudovat OAuth/autentizaci
- [ ] Najít migration guides od providera

### 3. Proof of Concept
- [ ] Implementovat 1-2 základní operace
- [ ] Otestovat na real datech
- [ ] Změřit performance
- [ ] Otestovat error handling
- [ ] Validovat data integrity

### 4. Plán migrace
- [ ] Definovat milestones
- [ ] Odhadnout časovou náročnost
- [ ] Identifikovat rizika
- [ ] Připravit rollback plán
- [ ] Definovat success criteria
```

### During Migration Checklist

```markdown
## Během migrace

### 1. Implementace
- [ ] Vytvořit legacy kopii starého kódu
- [ ] Implementovat nové API postupně (service by service)
- [ ] Psát testy paralelně s implementací
- [ ] Dokumentovat všechny změny
- [ ] Code review pro každý PR

### 2. Testing
- [ ] Unit testy pro každou funkci
- [ ] Integration testy
- [ ] Edge case testy
- [ ] Performance benchmarks
- [ ] Security audit
- [ ] Comparative testing (old vs new)

### 3. Data Migration
- [ ] Vytvořit data migration script
- [ ] Otestovat na test accountu
- [ ] Verifikovat data integrity
- [ ] Rollback test
```

### Post-Migration Checklist

```markdown
## Po migraci

### 1. Validace
- [ ] Smoke tests v produkci
- [ ] Monitoring metrik po dobu 7 dní
- [ ] User acceptance testing
- [ ] Performance regression check
- [ ] Error rate monitoring

### 2. Dokumentace
- [ ] Update README
- [ ] Update API dokumentace
- [ ] Migration guide pro uživatele
- [ ] Lessons learned dokument
- [ ] Update environment variables guide

### 3. Cleanup
- [ ] Odstranit starý kód (po 30 dnech bez incidentů)
- [ ] Odstranit staré dependencies
- [ ] Revoke staré API credentials
- [ ] Archive dokumentace starého API
```

---

## Automatizované testy

### Test suite template

```javascript
// tests/migration-validation.test.js
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

/**
 * KOMPLETNÍ TEST SUITE PRO VALIDACI MIGRACE
 *
 * Tento template použít pro jakoukoliv budoucí migraci mezi platformami.
 */

describe('Migration Validation Suite', () => {
  let oldService;
  let newService;
  let testUser;

  beforeAll(async () => {
    // Setup obou služeb
    oldService = await createOldService();
    newService = await createNewService();
    testUser = await createTestUser();
  });

  afterAll(async () => {
    // Cleanup
    await cleanupTestUser(testUser);
  });

  describe('1. API Parity', () => {
    it('all old API methods have new equivalents', () => {
      const oldMethods = Object.keys(oldService);
      const newMethods = Object.keys(newService);

      oldMethods.forEach(method => {
        expect(newMethods).toContain(method);
      });
    });
  });

  describe('2. Data Structure Compatibility', () => {
    it('returns same structure for list operations', async () => {
      const oldResult = await oldService.listItems();
      const newResult = await newService.listItems();

      expect(Object.keys(newResult)).toEqual(
        expect.arrayContaining(Object.keys(oldResult))
      );
    });

    it('preserves all data fields', async () => {
      const oldItem = await oldService.getItem('test-id');
      const newItem = await newService.getItem('test-id');

      const oldFields = extractFields(oldItem);
      const newFields = extractFields(newItem);

      oldFields.forEach(field => {
        expect(newFields).toContain(field);
      });
    });
  });

  describe('3. Functional Equivalence', () => {
    it('CRUD operations produce same results', async () => {
      // Create
      const created = await newService.createItem(testData);
      expect(created.id).toBeDefined();

      // Read
      const read = await newService.getItem(created.id);
      expect(read).toMatchObject(testData);

      // Update
      const updated = await newService.updateItem(created.id, updateData);
      expect(updated).toMatchObject(updateData);

      // Delete
      await newService.deleteItem(created.id);
      await expect(
        newService.getItem(created.id)
      ).rejects.toThrow();
    });
  });

  describe('4. Error Handling', () => {
    it('handles authentication errors', async () => {
      const invalidService = createNewService('invalid-token');

      await expect(
        invalidService.listItems()
      ).rejects.toThrow(/auth|unauthorized/i);
    });

    it('handles rate limiting', async () => {
      // Trigger rate limit
      const promises = Array(1000).fill(0).map(() =>
        newService.listItems()
      );

      // Nemělo by crashnout
      await expect(
        Promise.allSettled(promises)
      ).resolves.toBeDefined();
    });

    it('handles not found errors', async () => {
      await expect(
        newService.getItem('non-existent-id')
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('5. Performance', () => {
    it('is not significantly slower than old API', async () => {
      const iterations = 10;

      const oldTime = await measureTime(() =>
        oldService.listItems(), iterations
      );

      const newTime = await measureTime(() =>
        newService.listItems(), iterations
      );

      const slowdownRatio = newTime / oldTime;

      console.log(`Performance ratio: ${slowdownRatio.toFixed(2)}x`);

      // Mělo by být max 2x pomalejší
      expect(slowdownRatio).toBeLessThan(2);
    });
  });

  describe('6. Data Integrity', () => {
    it('roundtrip conversion preserves data', async () => {
      const original = generateTestData();
      const newFormat = convertToNewFormat(original);
      const backToOld = convertToOldFormat(newFormat);

      expect(backToOld).toEqual(original);
    });

    it('handles all character encodings', async () => {
      const testCases = [
        'Hello world',
        'Příliš žluťoučký kůň',
        '你好世界',
        '🎉📧✨'
      ];

      for (const testCase of testCases) {
        const created = await newService.createItem({ text: testCase });
        const retrieved = await newService.getItem(created.id);

        expect(retrieved.text).toBe(testCase);
      }
    });
  });

  describe('7. Edge Cases', () => {
    it('handles empty values', async () => {
      const empty = { text: '', number: 0, array: [] };
      const created = await newService.createItem(empty);
      const retrieved = await newService.getItem(created.id);

      expect(retrieved).toMatchObject(empty);
    });

    it('handles very large payloads', async () => {
      const large = { text: 'x'.repeat(1_000_000) };

      await expect(
        newService.createItem(large)
      ).resolves.toBeDefined();
    });

    it('handles concurrent operations', async () => {
      const promises = Array(50).fill(0).map((_, i) =>
        newService.createItem({ index: i })
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(50);
      expect(new Set(results.map(r => r.id)).size).toBe(50);
    });
  });
});

// Helper functions
async function measureTime(fn, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  return performance.now() - start;
}

function extractFields(obj, prefix = '') {
  const fields = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      fields.push(...extractFields(value, fullKey));
    } else {
      fields.push(fullKey);
    }
  }
  return fields;
}
```

---

## Specifické kontroly pro alfred2 (Google → Microsoft)

### Co zkontrolovat V TOMTO REPO:

```markdown
## 1. Timezone Conversion
- [ ] Otestovat všechny timezone v `timezoneConverter.js` (358 řádků)
- [ ] Verifikovat DST handling
- [ ] Test s deprecated/renamed timezones

## 2. Graph Retry Logic
- [ ] Otestovat exponential backoff v `graphRetry.js`
- [ ] Verifikovat Retry-After header handling
- [ ] Test s různými error codes (429, 503, 504)

## 3. Gmail → Outlook Mapování
- [ ] Otestovat `GMAIL_TO_OUTLOOK_FOLDER_MAP`
- [ ] Verifikovat že UNREAD/STARRED se mapují na properties
- [ ] Test custom labels vs folders

## 4. Kontakty (Sheets → Excel)
- [ ] Verifikovat že `contactsService.js` správně používá Excel API
- [ ] Test CRUD operací
- [ ] Verifikovat že schema je zachováno (Name, Email, Phone, RealEstate, Notes)

## 5. Tasks (Google Tasks → Microsoft To Do)
- [ ] Test mapování statusu: needsAction ↔ notStarted
- [ ] Verifikovat date format conversion
- [ ] Test že default task list se správně zjišťuje

## 6. Token Management
- [ ] Verifikovat že refresh token rotation funguje
- [ ] Test že `offline_access` scope je použitý
- [ ] Verifikovat encryption tokenů v DB

## 7. Zbylé Google reference
```

```bash
# Najít všechny zbylé reference na Google (mimo legacy)
grep -r "google" src --include="*.js" | grep -v legacy | grep -v "// Google"

# Mělo by vrátit 0 mimo komentáře a konstanty jako "gmailColorPalette"
```

```markdown
## 8. Test Suite Kompletnost
```

```bash
# Ověřit že existují testy pro všechny kritické části
ls -la test/*.test.js

# Mělo by zahrnovat:
# - calendarSchedule.test.js ✅
# - emailQuickReadSchema.test.js ✅
# - facadeServiceIsolation.test.js ✅
# - tasksController.integration.test.js ✅
# - tokenLifecycle/concurrentRefresh.test.js ✅
# - tokenLifecycle/invalidGrant.test.js ✅
```

```markdown
## 9. Environment Variables
- [ ] Verifikovat že `.env.example` má všechny MICROSOFT_* variables
- [ ] Zkontrolovat že žádné GOOGLE_* variables nejsou required
- [ ] Dokumentace v README je updated

## 10. Error Catalog
- [ ] Zkontrolovat `errorCatalog.js` - má Microsoft error codes?
- [ ] Verifikovat že `serviceErrors.js` mapuje Google → Microsoft errors

## 11. Dependency Audit
```

```bash
# Verify package.json
cat package.json | grep -E "(googleapis|@microsoft)"

# Mělo by vrátit:
# ❌ ŽÁDNÉ "googleapis"
# ✅ "@microsoft/microsoft-graph-client"
```

---

## Závěr

Tento dokument poskytuje **systematický přístup k validaci migrace** mezi platformami. Použijte jej jako:

1. **Checklist** před začátkem migrace
2. **Průvodce** během implementace
3. **Validační nástroj** po dokončení
4. **Template** pro budoucí migrace

### Klíčové principy:

- ✅ **Nikdy nepředpokládat** - vždy testovat
- ✅ **Dokumentovat vše** - budoucí já vás poděkuje
- ✅ **Automatizovat testy** - ruční testování je nespolehlivé
- ✅ **Měřit vše** - metriky odhalí problémy dřív než uživatelé
- ✅ **Plánovat rollback** - vždy mít escape hatch

### Pro alfred2 konkrétně:

Doporučuji **OKAMŽITĚ SPUSTIT** následující validace:

```bash
# 1. Najít zbylé Google reference
grep -r "googleSub\|google_sub" src --include="*.js" | grep -v legacy

# 2. Verifikovat že testy procházejí
npm test

# 3. Otestovat skutečné Microsoft API volání
node test/manual/microsoft-integration-test.js

# 4. Ověřit token refresh
node test/manual/token-refresh-test.js
```

**Status migrace:** Označeno jako 100% ✅, ale **vyžaduje důkladnou validaci** podle tohoto plánu.
