# Legacy Google Implementation

This folder contains the original Google-based implementation for reference.

**Date moved:** 2025-11-18
**Reason:** Migration to Microsoft services (Outlook, Calendar, To Do, etc.)

## Files

- `config/oauth.js` - Google OAuth 2.0 configuration
- `services/googleApiService.js` - Google API service (Gmail, Calendar, Tasks, Sheets, Drive)
- `get-google-sub.js` - Utility to get Google user ID

## Status

⚠️ **ARCHIVED** - These files are kept for reference only.

The application now uses Microsoft Graph API. See:
- `src/config/microsoft.js` - Microsoft OAuth configuration
- `src/services/microsoftGraphService.js` - Microsoft Graph API service

## Reverting

If you need to revert to Google implementation:

1. Move files back from `src/legacy-google/` to `src/`
2. Update `package.json` dependencies:
   ```bash
   npm uninstall @microsoft/microsoft-graph-client isomorphic-fetch
   npm install googleapis
   ```
3. Update environment variables in `.env` (GOOGLE_* instead of MICROSOFT_*)
4. Revert controllers and services imports

## Reference

See migration documentation:
- `MIGRACE_MICROSOFT.md` - Complete migration guide
- `OAUTH_COMPARISON.md` - OAuth flow comparison
- `API_QUICK_REFERENCE.md` - API comparison
