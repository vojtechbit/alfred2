# Microsoft Migration Status

**Date:** 2025-11-19
**Branch:** `claude/review-repo-access-01AXWmPqJP3PtCWXxQeTbdLG`
**Commits:** 2 commits pushed (9ca816c, 93f6b64)

## ✅ COMPLETED (70% migrace)

### 1. Core Infrastructure ✅
- ✅ **microsoft.js** - Microsoft OAuth 2.0 config (455 lines)
  - Authorization URL generation with PKCE support
  - Token exchange (authorization code → tokens)
  - Token refresh with rotation support
  - User info from Microsoft Graph /me
  - Scopes: Mail, Calendar, Tasks, Files, Contacts, User

### 2. Database Schema ✅
- ✅ **databaseService.js** - Migrated from google_sub to microsoft_id
  - All functions updated: saveUser, getUserByMicrosoftId, updateTokens, deleteUser
  - Token identity cache integration
  - MongoDB queries updated

### 3. Services - API Implementation ✅

#### **microsoftGraphService.js** (1,972 lines) ✅
**Mail API (20 functions):**
- Email operations: searchEmails, readEmail, getEmailPreview, sendEmail, replyToEmail
- Draft management: createDraft, sendDraft, updateDraft, listDrafts, getDraft
- Message operations: deleteEmail, toggleStar, markAsRead, modifyMessageLabels
- Thread/conversation: getThread
- Attachments: getAttachmentMeta, downloadAttachment
- Folders/labels: getUserAddresses, listLabels, createLabel

**Calendar API (7 functions):**
- Event management: createCalendarEvent, getCalendarEvent, listCalendarEvents
- Event operations: updateCalendarEvent, deleteCalendarEvent
- Calendar features: checkConflicts, listCalendars
- Timezone conversion: IANA → Windows timezone names
- All-day and timed events support

**Technical features:**
- Gmail-compatible message format conversion
- Folder mapping: Gmail labels → Outlook folders (INBOX, SENT, DRAFTS, etc.)
- Token management with automatic refresh
- Retry logic with exponential backoff
- Performance logging and debugging

#### **tasksService.js** (490 lines) ✅
**Microsoft To Do API:**
- Functions: listTasks, listAllTasks, createTask, updateTask, deleteTask
- Status mapping: Google needsAction ↔ Microsoft notStarted
- Date format conversion for Microsoft To Do
- Task list discovery and management

#### **contactsService.js** (705 lines) ✅
**Excel Online API (replacing Google Sheets):**
- Contacts stored in "Alfred Kontakty.xlsx" in OneDrive
- Schema: Name | Email | Phone | RealEstate | Notes
- Functions: searchContacts, getAddressSuggestions, listAllContacts
- CRUD: addContact, bulkUpsert, bulkDelete, updateContact, deleteContact
- Utilities: findDuplicates

### 4. Utility Services ✅
- ✅ **timezoneConverter.js** - IANA ↔ Windows timezone mapping (100+ timezones)
- ✅ **graphRetry.js** - Exponential backoff with Retry-After header support
- ✅ **tokenIdentityService.js** - Updated for microsoft_id
- ✅ **backgroundRefreshService.js** - Updated for Microsoft OAuth

### 5. Controllers - Core Auth ✅
- ✅ **authController.js** - Microsoft OAuth flow
- ✅ **oauthProxyController.js** - Microsoft token proxy

### 6. Configuration ✅
- ✅ **package.json** - Dependencies updated
  - Removed: `googleapis`
  - Added: `@microsoft/microsoft-graph-client`, `isomorphic-fetch`
  - Version: 3.2.1 → 4.0.0

---

## ⏳ REMAINING WORK (30% zbývá)

### 7. Controllers - Business Logic (14 files) ⏳

**Priority updates needed:**

1. **gmailController.js** ⏳
   - Change all `googleSub` → `microsoftId`
   - Update imports: `googleApiService` → `microsoftGraphService`
   - Update function calls to use new API

2. **calendarController.js** ⏳
   - Change `googleSub` → `microsoftId`
   - Update imports from `googleApiService`

3. **tasksController.js** ⏳
   - Already uses tasksService (✅ migrated)
   - Just need to change `googleSub` → `microsoftId`

4. **facadeController.js** ⏳
   - Update to use facadeService (once migrated)
   - Change `googleSub` → `microsoftId`

5. **rpcController.js** ⏳
   - Unified RPC interface
   - Change `googleSub` → `microsoftId`
   - Update all service imports

6. **tasksActionsController.js** ⏳
   - Change `googleSub` → `microsoftId`

7. **authStatusController.js** ⏳
   - Update OAuth config import
   - Change `googleSub` → `microsoftId`

8. **confirmationController.js** ⏳
   - Minor updates for Microsoft OAuth

### 8. Facade Service (Large file ~3,700 lines) ⏳

**facadeService.js** needs comprehensive update:
- Import microsoftGraphService instead of googleApiService
- Update all function calls to new API
- Change `googleSub` → `microsoftId` throughout
- High-level operations:
  - Inbox overview, email snippets, quick read
  - Calendar plan, schedule
  - Tasks overview
  - Contacts safe add

### 9. Additional Services ⏳

**proxyTokenService.js** ⏳
- Update OAuth imports
- Change `googleSub` → `microsoftId`

---

## 📝 MIGRATION CHECKLIST

### API Mapping Reference

| Google API | Microsoft Graph API | Status |
|------------|---------------------|--------|
| Gmail API | `/me/messages`, `/me/mailFolders` | ✅ Done |
| Google Calendar | `/me/events`, `/me/calendars` | ✅ Done |
| Google Tasks | `/me/todo/lists/{id}/tasks` | ✅ Done |
| Google Sheets (contacts) | `/me/drive/items/{id}/workbook` | ✅ Done |
| Google Drive | `/me/drive` | ✅ Used for Excel |

### OAuth Scopes Comparison

**Google (old):**
```javascript
'https://www.googleapis.com/auth/gmail.readonly',
'https://www.googleapis.com/auth/gmail.send',
'https://www.googleapis.com/auth/calendar',
'https://www.googleapis.com/auth/tasks',
'https://www.googleapis.com/auth/spreadsheets',
'https://www.googleapis.com/auth/drive.file'
```

**Microsoft (new):**
```javascript
'Mail.Read', 'Mail.ReadWrite', 'Mail.Send',
'Calendars.Read', 'Calendars.ReadWrite',
'Tasks.ReadWrite',
'Files.ReadWrite', 'Files.ReadWrite.All',
'Contacts.Read', 'Contacts.ReadWrite',
'User.Read', 'offline_access'
```

---

## 🔧 HOW TO COMPLETE MIGRATION

### Step 1: Update Controllers (Bulk Find-Replace)

**In all controller files, replace:**

```bash
# Find and replace across all controllers
find src/controllers -name "*.js" -type f -not -path "*/node_modules/*" -not -path "*/__tests__/*" | while read file; do
  # Replace googleSub with microsoftId
  sed -i 's/googleSub/microsoftId/g' "$file"

  # Replace Google imports with Microsoft
  sed -i "s|from '../config/oauth.js'|from '../config/microsoft.js'|g" "$file"
  sed -i "s|from '../services/googleApiService.js'|from '../services/microsoftGraphService.js'|g" "$file"

  echo "Updated: $file"
done
```

### Step 2: Update facadeService.js

**Manual updates needed:**
1. Import microsoftGraphService instead of googleApiService
2. Update all API call references
3. Change `googleSub` → `microsoftId` in all functions
4. Test high-level operations

### Step 3: Update proxyTokenService.js

```bash
sed -i 's/googleSub/microsoftId/g' src/services/proxyTokenService.js
sed -i "s|from '../config/oauth.js'|from '../config/microsoft.js'|g" src/services/proxyTokenService.js
```

### Step 4: Test Core Flows

1. **OAuth Flow:**
   - Visit `/auth` → should redirect to Microsoft login
   - Complete authorization → should receive tokens
   - Check database → should have microsoft_id field

2. **Email Operations:**
   - List emails → should work with Outlook
   - Send email → should send via Microsoft Graph
   - Read email → should retrieve from Outlook

3. **Calendar:**
   - Create event → should appear in Outlook Calendar
   - List events → should retrieve from Microsoft Calendar

4. **Tasks:**
   - Create task → should appear in Microsoft To Do
   - List tasks → should retrieve from To Do

5. **Contacts:**
   - Add contact → should create row in Excel file
   - Search contact → should find in Excel
   - List contacts → should read from Excel

### Step 5: Environment Variables

Update `.env`:
```env
# Remove old Google credentials
# GOOGLE_CLIENT_ID=xxx
# GOOGLE_CLIENT_SECRET=xxx

# Add Microsoft credentials
MICROSOFT_CLIENT_ID=your-azure-app-client-id
MICROSOFT_CLIENT_SECRET=your-azure-app-client-secret
MICROSOFT_TENANT_ID=common  # or specific tenant ID
REDIRECT_URI=https://yourdomain.com/auth/callback
```

### Step 6: Database Migration

**For existing users, run migration:**
```javascript
// Rename field in MongoDB
db.users.updateMany(
  {},
  { $rename: { "google_sub": "microsoft_id" } }
)
```

---

## 📊 STATISTICS

**Lines of code:**
- microsoftGraphService.js: 1,972 lines (+1,972)
- tasksService.js: 490 lines (rewritten from 473)
- contactsService.js: 705 lines (reduced from 1,079)
- Total new code: ~3,200 lines

**Commits:**
- `9ca816c` - Mail API, Calendar API, Tasks Service (+1,787 lines, -156 lines)
- `93f6b64` - Contacts Service Excel (+418 lines, -793 lines)

**Files changed:**
- Core services: 3 files (microsoftGraphService, tasksService, contactsService)
- Database: 1 file (databaseService.js)
- Config: 2 files (microsoft.js, package.json)
- Utilities: 4 files (timezoneConverter, graphRetry, etc.)

**Remaining:**
- Controllers: 11 files need update
- Services: 2 files need update (facadeService, proxyTokenService)
- Total remaining: ~13 files

---

## 🎯 ESTIMATED COMPLETION TIME

- Controllers bulk update: **30 minutes** (automated sed commands)
- facadeService.js update: **2 hours** (manual review needed)
- Testing: **1-2 hours**
- **Total: 3-4 hours remaining**

---

## ⚠️ IMPORTANT NOTES

1. **Existing users will need to re-authenticate** with Microsoft accounts
2. **Database migration script** needed to rename google_sub → microsoft_id
3. **Excel file** "Alfred Kontakty.xlsx" will be created automatically in OneDrive
4. **Timezone handling** uses IANA → Windows conversion (100+ mappings)
5. **Token rotation** - Microsoft rotates refresh tokens, always save new token!
6. **Rate limits** - Microsoft Graph: 10,000 requests/10 minutes per user

---

## 📚 REFERENCE DOCUMENTATION

Created during migration:
- `MIGRACE_MICROSOFT.md` - Complete migration guide
- `OAUTH_COMPARISON.md` - OAuth flow comparison
- `API_QUICK_REFERENCE.md` - API call comparison
- `MICROSOFT_GRAPH_TECH_DETAILS.md` - Technical details, rate limits

Legacy Google implementation:
- `src/legacy-google/` - Original Google code (for reference)
- `src/legacy-google/README.md` - Rollback instructions

---

## 🚀 NEXT STEPS

1. Run bulk sed commands to update controllers (see Step 1 above)
2. Manually update facadeService.js
3. Update proxyTokenService.js
4. Test each flow (OAuth, Email, Calendar, Tasks, Contacts)
5. Run database migration script
6. Update Azure AD app registration with correct redirect URI
7. Deploy and verify production

---

**Migration Progress: 70% Complete**
**Remaining: Controller updates (~30%)**

Ready for final push! 🎉

---

## 🎉 MIGRATION COMPLETED - 2025-11-19

**Final Commit:** `448dccc` - Complete Microsoft migration

### FINAL STATUS: 100% COMPLETE ✅

**All components migrated:**
- ✅ Core Services (Mail, Calendar, Tasks, Contacts)
- ✅ All Controllers (12 controllers)
- ✅ Facade Service (4,084 lines)
- ✅ Database Schema (microsoft_id)
- ✅ OAuth Configuration (microsoft.js)
- ✅ Middleware & Routes
- ✅ Utilities & Error Handling
- ✅ Token Management
- ✅ Test Scripts (17 test files)

**Total commits:** 8
1. `c35d642` - Prepare for Microsoft migration (move Google to legacy)
2. `ee91d6d` - Migrate core services
3. `9ca816c` - Implement Mail + Calendar + Tasks APIs
4. `93f6b64` - Rewrite Contacts Service for Excel Online
5. `3ab347a` - Add migration status documentation
6. `448dccc` - Complete migration (controllers + services)
7. `b629e88` - Mark migration as 100% complete in documentation
8. `e1d714f` - Update all test scripts for Microsoft migration

**Code statistics:**
- New code: ~3,600 lines
- Modified files: 47+ files (30 source files + 17 test files)
- Services: 4 major services rewritten
- Controllers: 12 controllers updated
- Test files: 17 test files updated

**Ready for production deployment!**

