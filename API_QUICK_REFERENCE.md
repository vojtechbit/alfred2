# API Quick Reference: Google vs Microsoft

**Rychlý přehled API volání pro migraci alfred2**

---

## 📧 EMAIL API

### Seznam emailů
```javascript
// GOOGLE GMAIL
const response = await gmail.users.messages.list({
  userId: 'me',
  maxResults: 50,
  pageToken: nextPageToken,
  q: 'from:john@example.com is:unread'
});
// response.data.messages[]
// response.data.nextPageToken

// MICROSOFT GRAPH
const response = await graphClient
  .api('/me/messages')
  .top(50)
  .skip(skipCount)
  .filter("from/emailAddress/address eq 'john@example.com' and isRead eq false")
  .select('id,subject,from,receivedDateTime,isRead,bodyPreview')
  .get();
// response.value[]
// response['@odata.nextLink']
```

### Přečíst email
```javascript
// GOOGLE GMAIL
const response = await gmail.users.messages.get({
  userId: 'me',
  id: messageId,
  format: 'full'  // nebo 'metadata', 'minimal', 'raw'
});
// response.data (MIME encoded)

// MICROSOFT GRAPH
const message = await graphClient
  .api(`/me/messages/${messageId}`)
  .select('*')
  .expand('attachments')
  .get();
// message (JSON object)
```

### Odeslat email
```javascript
// GOOGLE GMAIL
const raw = createMimeMessage(to, subject, body);
await gmail.users.messages.send({
  userId: 'me',
  requestBody: {
    raw: base64url(raw),
    threadId: threadId  // optional
  }
});

// MICROSOFT GRAPH
await graphClient
  .api('/me/sendMail')
  .post({
    message: {
      subject: subject,
      body: {
        contentType: 'HTML',  // nebo 'Text'
        content: body
      },
      toRecipients: [
        { emailAddress: { address: to } }
      ],
      ccRecipients: [
        { emailAddress: { address: cc } }
      ]
    },
    saveToSentItems: true
  });
```

### Odpovědět na email
```javascript
// GOOGLE GMAIL
// 2 kroky: Create reply + Send
const raw = createReplyMimeMessage(originalMessage, replyBody);
await gmail.users.messages.send({
  userId: 'me',
  requestBody: {
    raw: base64url(raw),
    threadId: threadId
  }
});

// MICROSOFT GRAPH
// 1 krok
await graphClient
  .api(`/me/messages/${messageId}/reply`)
  .post({
    comment: replyBody  // HTML nebo Text
  });
```

### Smazat / Trash
```javascript
// GOOGLE GMAIL
await gmail.users.messages.trash({
  userId: 'me',
  id: messageId
});

// MICROSOFT GRAPH
await graphClient
  .api(`/me/messages/${messageId}`)
  .delete();
// NEBO přesunout do Deleted Items:
await graphClient
  .api(`/me/messages/${messageId}/move`)
  .post({
    destinationId: 'deleteditems'
  });
```

### Upravit (read/unread, labely/složky)
```javascript
// GOOGLE GMAIL
await gmail.users.messages.modify({
  userId: 'me',
  id: messageId,
  requestBody: {
    addLabelIds: ['UNREAD', 'INBOX'],
    removeLabelIds: ['SPAM']
  }
});

// MICROSOFT GRAPH
await graphClient
  .api(`/me/messages/${messageId}`)
  .patch({
    isRead: false,
    // Nebo přesunout složku:
  });
// Move to folder:
await graphClient
  .api(`/me/messages/${messageId}/move`)
  .post({
    destinationId: folderIdOrWellKnownName
  });
```

### Přílohy
```javascript
// GOOGLE GMAIL
// Přílohy jsou part of message body
const message = await gmail.users.messages.get({
  userId: 'me',
  id: messageId,
  format: 'full'
});
// Parse parts[] for attachments

// MICROSOFT GRAPH
const attachments = await graphClient
  .api(`/me/messages/${messageId}/attachments`)
  .get();
// attachments.value[]

// Get single attachment:
const attachment = await graphClient
  .api(`/me/messages/${messageId}/attachments/${attachmentId}`)
  .get();
// attachment.contentBytes (base64)
```

### Vyhledávání
```javascript
// GOOGLE GMAIL - pokročilá syntax
q: "from:john@example.com subject:invoice after:2025/11/01 has:attachment"

// MICROSOFT GRAPH - OData filter
$filter=from/emailAddress/address eq 'john@example.com' and receivedDateTime ge 2025-11-01T00:00:00Z and hasAttachments eq true
$search="subject:invoice"
```

---

## 📅 CALENDAR API

### Seznam událostí
```javascript
// GOOGLE CALENDAR
const response = await calendar.events.list({
  calendarId: 'primary',
  timeMin: '2025-11-01T00:00:00Z',
  timeMax: '2025-11-30T23:59:59Z',
  maxResults: 50,
  singleEvents: true,
  orderBy: 'startTime'
});
// response.data.items[]

// MICROSOFT GRAPH
const events = await graphClient
  .api('/me/calendar/events')
  .filter(`start/dateTime ge '2025-11-01T00:00:00' and end/dateTime le '2025-11-30T23:59:59'`)
  .top(50)
  .orderby('start/dateTime')
  .select('id,subject,start,end,location,attendees')
  .get();
// events.value[]
```

### Vytvořit událost
```javascript
// GOOGLE CALENDAR
const event = {
  summary: 'Meeting with John',
  description: 'Discuss Q4 results',
  start: {
    dateTime: '2025-11-20T10:00:00',
    timeZone: 'Europe/Prague'
  },
  end: {
    dateTime: '2025-11-20T11:00:00',
    timeZone: 'Europe/Prague'
  },
  attendees: [
    { email: 'john@example.com' }
  ],
  location: 'Conference Room A'
};

await calendar.events.insert({
  calendarId: 'primary',
  requestBody: event
});

// MICROSOFT GRAPH
const event = {
  subject: 'Meeting with John',
  body: {
    contentType: 'Text',
    content: 'Discuss Q4 results'
  },
  start: {
    dateTime: '2025-11-20T10:00:00',
    timeZone: 'Central Europe Standard Time'  // Windows timezone!
  },
  end: {
    dateTime: '2025-11-20T11:00:00',
    timeZone: 'Central Europe Standard Time'
  },
  location: {
    displayName: 'Conference Room A'
  },
  attendees: [
    {
      emailAddress: { address: 'john@example.com' },
      type: 'required'  // nebo 'optional', 'resource'
    }
  ]
};

await graphClient
  .api('/me/calendar/events')
  .post(event);
```

### Aktualizovat událost
```javascript
// GOOGLE CALENDAR
await calendar.events.update({
  calendarId: 'primary',
  eventId: eventId,
  requestBody: {
    summary: 'Updated title',
    start: { dateTime: '2025-11-20T11:00:00', timeZone: 'Europe/Prague' }
  }
});

// MICROSOFT GRAPH
await graphClient
  .api(`/me/calendar/events/${eventId}`)
  .patch({
    subject: 'Updated title',
    start: { dateTime: '2025-11-20T11:00:00', timeZone: 'Central Europe Standard Time' }
  });
```

### Smazat událost
```javascript
// GOOGLE CALENDAR
await calendar.events.delete({
  calendarId: 'primary',
  eventId: eventId
});

// MICROSOFT GRAPH
await graphClient
  .api(`/me/calendar/events/${eventId}`)
  .delete();
```

### Vícero kalendářů
```javascript
// GOOGLE CALENDAR
const calendars = await calendar.calendarList.list();
// calendars.data.items[]

// MICROSOFT GRAPH
const calendars = await graphClient
  .api('/me/calendars')
  .get();
// calendars.value[]
```

---

## ✅ TASKS / TO DO API

### Seznam úkolových listů
```javascript
// GOOGLE TASKS
const taskLists = await tasks.tasklists.list();
// taskLists.data.items[]

// MICROSOFT TO DO
const taskLists = await graphClient
  .api('/me/todo/lists')
  .get();
// taskLists.value[]
```

### Seznam úkolů
```javascript
// GOOGLE TASKS
const tasks = await tasks.tasks.list({
  tasklist: taskListId,
  showCompleted: true,
  maxResults: 100
});
// tasks.data.items[]

// MICROSOFT TO DO
const tasks = await graphClient
  .api(`/me/todo/lists/${listId}/tasks`)
  .filter("status ne 'completed'")  // pokud showCompleted: false
  .get();
// tasks.value[]
```

### Vytvořit úkol
```javascript
// GOOGLE TASKS
await tasks.tasks.insert({
  tasklist: taskListId,
  requestBody: {
    title: 'Buy milk',
    notes: '2% milk',
    due: '2025-11-20T00:00:00.000Z',
    status: 'needsAction'
  }
});

// MICROSOFT TO DO
await graphClient
  .api(`/me/todo/lists/${listId}/tasks`)
  .post({
    title: 'Buy milk',
    body: {
      content: '2% milk',
      contentType: 'text'
    },
    dueDateTime: {
      dateTime: '2025-11-20T00:00:00',
      timeZone: 'UTC'
    },
    importance: 'normal'  // 'low', 'normal', 'high'
  });
```

### Aktualizovat úkol (hotovo/nehotovo)
```javascript
// GOOGLE TASKS
await tasks.tasks.update({
  tasklist: taskListId,
  task: taskId,
  requestBody: {
    status: 'completed',  // nebo 'needsAction'
    completed: new Date().toISOString()
  }
});

// MICROSOFT TO DO
await graphClient
  .api(`/me/todo/lists/${listId}/tasks/${taskId}`)
  .patch({
    status: 'completed',  // nebo 'notStarted', 'inProgress'
    completedDateTime: {
      dateTime: new Date().toISOString(),
      timeZone: 'UTC'
    }
  });
```

### Smazat úkol
```javascript
// GOOGLE TASKS
await tasks.tasks.delete({
  tasklist: taskListId,
  task: taskId
});

// MICROSOFT TO DO
await graphClient
  .api(`/me/todo/lists/${listId}/tasks/${taskId}`)
  .delete();
```

---

## 📊 SPREADSHEET / EXCEL API

### Najít soubor
```javascript
// GOOGLE DRIVE
const response = await drive.files.list({
  q: "name='Alfred Kontakty' and mimeType='application/vnd.google-apps.spreadsheet'",
  spaces: 'drive',
  fields: 'files(id, name)'
});
// response.data.files[]

// MICROSOFT GRAPH (OneDrive)
const files = await graphClient
  .api("/me/drive/root/search(q='Alfred Kontakty')")
  .filter("name eq 'Alfred Kontakty.xlsx'")
  .get();
// files.value[]
```

### Přečíst buňky
```javascript
// GOOGLE SHEETS
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: sheetId,
  range: 'Sheet1!A1:E100',
  valueRenderOption: 'UNFORMATTED_VALUE'
});
// response.data.values[][]  (2D array)

// MICROSOFT EXCEL
const range = await graphClient
  .api(`/me/drive/items/${fileId}/workbook/worksheets/Sheet1/range(address='A1:E100')`)
  .get();
// range.values[][]  (2D array)
```

### Zapsat buňky
```javascript
// GOOGLE SHEETS
await sheets.spreadsheets.values.update({
  spreadsheetId: sheetId,
  range: 'Sheet1!A1:C2',
  valueInputOption: 'RAW',
  requestBody: {
    values: [
      ['Name', 'Email', 'Phone'],
      ['John Doe', 'john@example.com', '123-456']
    ]
  }
});

// MICROSOFT EXCEL
await graphClient
  .api(`/me/drive/items/${fileId}/workbook/worksheets/Sheet1/range(address='A1:C2')`)
  .patch({
    values: [
      ['Name', 'Email', 'Phone'],
      ['John Doe', 'john@example.com', '123-456']
    ]
  });
```

### Přidat řádky (append)
```javascript
// GOOGLE SHEETS
await sheets.spreadsheets.values.append({
  spreadsheetId: sheetId,
  range: 'Sheet1!A1',
  valueInputOption: 'RAW',
  insertDataOption: 'INSERT_ROWS',
  requestBody: {
    values: [
      ['Jane Doe', 'jane@example.com', '789-012']
    ]
  }
});

// MICROSOFT EXCEL
// Složitější - musíš najít poslední řádek a zapsat tam
// 1. Najít UsedRange:
const usedRange = await graphClient
  .api(`/me/drive/items/${fileId}/workbook/worksheets/Sheet1/usedRange`)
  .get();
const lastRow = usedRange.rowCount;

// 2. Zapsat do dalšího řádku:
await graphClient
  .api(`/me/drive/items/${fileId}/workbook/worksheets/Sheet1/range(address='A${lastRow+1}:C${lastRow+1}')`)
  .patch({
    values: [['Jane Doe', 'jane@example.com', '789-012']]
  });
```

### Vytvořit nový spreadsheet
```javascript
// GOOGLE SHEETS
const response = await sheets.spreadsheets.create({
  requestBody: {
    properties: {
      title: 'Alfred Kontakty'
    },
    sheets: [
      {
        properties: { title: 'Sheet1' }
      }
    ]
  }
});
// response.data.spreadsheetId

// MICROSOFT EXCEL
// Složitější - musíš vytvořit prázdný .xlsx soubor a nahrát
const emptyExcelBuffer = createEmptyExcelWorkbook(); // Helper funkce
const uploadedFile = await graphClient
  .api('/me/drive/root:/Alfred Kontakty.xlsx:/content')
  .put(emptyExcelBuffer);
// uploadedFile.id
```

---

## 👥 CONTACTS API

**⚠️ ZMĚNA:** Google Sheets → Microsoft Graph Contacts API

### Seznam kontaktů
```javascript
// GOOGLE (vlastní implementace přes Sheets)
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: contactsSheetId,
  range: 'Sheet1!A2:E1000'
});
const contacts = response.data.values.map(row => ({
  name: row[0],
  email: row[1],
  phone: row[2],
  // ...
}));

// MICROSOFT GRAPH (nativní Contacts API)
const contacts = await graphClient
  .api('/me/contacts')
  .top(100)
  .select('id,displayName,emailAddresses,mobilePhone,homePhones,businessPhones')
  .get();
// contacts.value[]
```

### Vytvořit kontakt
```javascript
// GOOGLE (append do Sheets)
await sheets.spreadsheets.values.append({
  spreadsheetId: contactsSheetId,
  range: 'Sheet1!A1',
  valueInputOption: 'RAW',
  requestBody: {
    values: [['John Doe', 'john@example.com', '123-456', '', '']]
  }
});

// MICROSOFT GRAPH
await graphClient
  .api('/me/contacts')
  .post({
    displayName: 'John Doe',
    emailAddresses: [
      { address: 'john@example.com', name: 'John Doe' }
    ],
    mobilePhone: '123-456'
  });
```

### Aktualizovat kontakt
```javascript
// GOOGLE (najít řádek a přepsat)
// Musíš manuálně najít řádek podle emailu/jména a pak update
await sheets.spreadsheets.values.update({
  spreadsheetId: contactsSheetId,
  range: `Sheet1!A${rowNumber}:E${rowNumber}`,
  valueInputOption: 'RAW',
  requestBody: {
    values: [['Updated Name', 'updated@example.com', '999-999', '', '']]
  }
});

// MICROSOFT GRAPH
await graphClient
  .api(`/me/contacts/${contactId}`)
  .patch({
    displayName: 'Updated Name',
    emailAddresses: [{ address: 'updated@example.com' }]
  });
```

### Smazat kontakt
```javascript
// GOOGLE (smazat řádek ze Sheets)
await sheets.spreadsheets.batchUpdate({
  spreadsheetId: contactsSheetId,
  requestBody: {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: 0,
          dimension: 'ROWS',
          startIndex: rowNumber - 1,
          endIndex: rowNumber
        }
      }
    }]
  }
});

// MICROSOFT GRAPH
await graphClient
  .api(`/me/contacts/${contactId}`)
  .delete();
```

---

## 🔐 USER INFO

```javascript
// GOOGLE
const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
const response = await oauth2.userinfo.get();
const userInfo = response.data;
// {
//   id: "...",
//   email: "user@gmail.com",
//   verified_email: true,
//   name: "John Doe",
//   given_name: "John",
//   family_name: "Doe",
//   picture: "https://..."
// }

// MICROSOFT GRAPH
const userInfo = await graphClient
  .api('/me')
  .get();
// {
//   id: "...",
//   userPrincipalName: "user@outlook.com",
//   mail: "user@outlook.com",
//   displayName: "John Doe",
//   givenName: "John",
//   surname: "Doe"
// }
```

---

## 🌐 TIMEZONE MAPPING

### IANA → Windows timezone names

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
| `Australia/Sydney` | `AUS Eastern Standard Time` |

**Helper funkce:**
```javascript
const timezoneMap = {
  'Europe/Prague': 'Central Europe Standard Time',
  'UTC': 'UTC',
  // ... kompletní mapping
};

function convertIANAToWindows(ianaTimezone) {
  return timezoneMap[ianaTimezone] || 'UTC';
}

function convertWindowsToIANA(windowsTimezone) {
  const reverseMap = Object.fromEntries(
    Object.entries(timezoneMap).map(([k, v]) => [v, k])
  );
  return reverseMap[windowsTimezone] || 'UTC';
}
```

---

## 📦 NPM Packages

### Google
```json
{
  "googleapis": "^128.0.0"
}
```

### Microsoft
```json
{
  "@microsoft/microsoft-graph-client": "^3.0.7",
  "@azure/msal-node": "^2.6.0",
  "isomorphic-fetch": "^3.0.0"
}
```

---

## 🔗 Další zdroje

- **Microsoft Graph Explorer:** https://developer.microsoft.com/en-us/graph/graph-explorer
- **Microsoft Graph API Docs:** https://learn.microsoft.com/en-us/graph/api/overview
- **Timezone converter:** https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml

---

**Tip:** Použij Microsoft Graph Explorer pro testování API calls před implementací!
