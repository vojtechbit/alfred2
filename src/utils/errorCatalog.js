const errorCatalog = {
  ACCESS_TOKEN_CACHE_PARAMS_MISSING: {
    status: 400,
    description: 'Required cache parameters (accessToken, microsoftId) were missing when caching token identity.'
  },
  AMBIGUOUS_DELETE: {
    status: 409,
    description: 'Multiple contacts matched the delete request; caller must disambiguate the intended target.'
  },
  ATTACHMENT_BLOCKED: {
    status: 451,
    description: 'Attachment download blocked by data loss prevention or workspace policy.'
  },
  ATTACHMENT_DOWNLOAD_FAILED: {
    status: 502,
    description: 'Failed to download attachment contents from Gmail.'
  },
  ATTACHMENT_META_FAILED: {
    status: 502,
    description: 'Failed to load attachment metadata from Gmail.'
  },
  ATTACHMENT_NOT_FOUND: {
    status: 404,
    description: 'Requested Gmail attachment could not be located.'
  },
  ATTACHMENT_TABLE_PREVIEW_FAILED: {
    status: 502,
    description: 'Failed to render a table preview for the requested attachment.'
  },
  ATTACHMENT_TEXT_PREVIEW_FAILED: {
    status: 502,
    description: 'Failed to render a text preview for the requested attachment.'
  },
  AUTH_REQUIRED: {
    status: 401,
    description: 'User session is missing or expired and must be refreshed.'
  },
  AUTH_STATUS_FAILED: {
    status: 500,
    description: 'Server failed to determine current authentication status.'
  },
  BATCH_PREVIEW_FAILED: {
    status: 502,
    description: 'Failed to prepare Gmail batch preview payload.'
  },
  BATCH_READ_FAILED: {
    status: 502,
    description: 'Failed to fetch the requested set of Gmail messages.'
  },
  CALENDAR_EVENT_CREATE_FAILED: {
    status: 502,
    description: 'Google Calendar refused or failed to create the requested event.'
  },
  CALENDAR_EVENT_DELETE_FAILED: {
    status: 502,
    description: 'Google Calendar refused or failed to delete the requested event.'
  },
  CALENDAR_EVENT_GET_FAILED: {
    status: 502,
    description: 'Google Calendar refused or failed to return the requested event.'
  },
  CALENDAR_EVENT_LIST_FAILED: {
    status: 502,
    description: 'Google Calendar refused or failed to list events for the requested range.'
  },
  CALENDAR_EVENT_TIME_REQUIRED: {
    status: 400,
    description: 'Calendar event payload is missing start or end time information.'
  },
  CALENDAR_EVENT_TIME_UNSUPPORTED: {
    status: 400,
    description: 'Calendar event payload supplied an unsupported time representation.'
  },
  CALENDAR_EVENT_UPDATE_FAILED: {
    status: 502,
    description: 'Google Calendar refused or failed to update the requested event.'
  },
  CALENDAR_PROPOSALS_CONFLICT: {
    status: 409,
    description: 'All proposed calendar time slots conflict with existing events.'
  },
  CONFIRMATION_CANCEL_FAILED: {
    status: 500,
    description: 'Server failed to cancel the requested confirmation flow.'
  },
  CONFIRMATION_EXPIRED: {
    status: 400,
    description: 'Confirmation token has expired or is no longer valid.'
  },
  CONFIRMATION_FAILED: {
    status: 500,
    description: 'Server failed to complete the requested confirmation action.'
  },
  CONFIRMATION_NOT_FOUND: {
    status: 404,
    description: 'Requested confirmation token does not exist.'
  },
  CONFIRMATION_PREVIEW_FAILED: {
    status: 500,
    description: 'Server failed to build a confirmation preview.'
  },
  CONFIRMATION_TYPE_INVALID: {
    status: 400,
    description: 'Provided confirmation type is not supported.'
  },
  CONFIRM_SELF_SEND_REQUIRED: {
    status: 400,
    description: 'Self-send operations require the confirmSelfSend flag.'
  },
  CONFLICT: {
    status: 409,
    description: 'Request conflicts with the current resource state.'
  },
  CONTACTS_RPC_MUTATION_DISABLED: {
    status: 410,
    description: 'Legacy contacts RPC mutation has been removed; clients must call dedicated endpoints.'
  },
  CONTACTS_SHEET_MISMATCH: {
    status: 409,
    description: 'Contacts spreadsheet is missing or does not match the expected schema.'
  },
  CONTACT_ADDRESS_SUGGEST_FAILED: {
    status: 502,
    description: 'Failed to suggest addresses for the provided contact payload.'
  },
  CONTACT_ADD_FAILED: {
    status: 502,
    description: 'Failed to add a contact to Google Workspace storage.'
  },
  CONTACT_BULK_DELETE_FAILED: {
    status: 502,
    description: 'Failed to delete one or more contacts in bulk.'
  },
  CONTACT_BULK_TARGET_REQUIRED: {
    status: 400,
    description: 'Bulk contact operations require at least one target identifier.'
  },
  CONTACT_BULK_UPSERT_FAILED: {
    status: 502,
    description: 'Failed to upsert the provided set of contacts.'
  },
  CONTACT_DELETE_FAILED: {
    status: 502,
    description: 'Failed to delete the requested contact.'
  },
  CONTACT_IDENTIFIER_REQUIRED: {
    status: 400,
    description: 'Contact operations require an email address or name.'
  },
  CONTACT_LIST_FAILED: {
    status: 502,
    description: 'Failed to retrieve the contact list.'
  },
  CONTACT_MODIFY_FAILED: {
    status: 502,
    description: 'Failed to modify the requested contact.'
  },
  CONTACT_NAME_AND_EMAIL_REQUIRED: {
    status: 400,
    description: 'Both name and email are required to create a contact.'
  },
  CONTACT_NOT_FOUND: {
    status: 404,
    description: 'Requested contact could not be located.'
  },
  CONTACT_SEARCH_FAILED: {
    status: 502,
    description: 'Failed to search contacts.'
  },
  CONTACT_UPDATE_FAILED: {
    status: 502,
    description: 'Failed to update the requested contact.'
  },
  DEDUPE_STRATEGY_UNSUPPORTED: {
    status: 400,
    description: 'Provided deduplication strategy is not supported.'
  },
  DRAFT_CREATE_FAILED: {
    status: 502,
    description: 'Failed to create the requested Gmail draft.'
  },
  DRAFT_ID_REQUIRED: {
    status: 400,
    description: 'Draft identifier must be supplied.'
  },
  DRAFT_RECIPIENT_REQUIRED: {
    status: 400,
    description: 'Draft recipient must be supplied.'
  },
  DRAFT_SUBJECT_REQUIRED: {
    status: 400,
    description: 'Draft subject must be supplied.'
  },
  E401: {
    status: 401,
    description: 'Upstream service responded with HTTP 401 (unauthorized).'
  },
  EMAIL_DELETE_FAILED: {
    status: 502,
    description: 'Failed to delete the requested Gmail message.'
  },
  EMAIL_MESSAGE_IDS_MISSING: {
    status: 400,
    description: 'Request is missing Gmail message identifiers.'
  },
  EMAIL_QUICK_READ_FORMAT_INVALID: {
    status: 400,
    description: 'Requested quick-read format is not supported.'
  },
  EMAIL_READ_FAILED: {
    status: 502,
    description: 'Failed to retrieve the requested Gmail message.'
  },
  EMAIL_REPLY_FAILED: {
    status: 502,
    description: 'Failed to send the requested Gmail reply.'
  },
  EMAIL_SEARCH_FAILED: {
    status: 502,
    description: 'Failed to execute the Gmail search request.'
  },
  EMAIL_SEARCH_NO_RESULTS: {
    status: 404,
    description: 'Gmail search query returned no matching messages.'
  },
  EMAIL_THREAD_NOT_FOUND: {
    status: 404,
    description: 'Gmail thread not found or is empty.'
  },
  EMAIL_THREAD_LOAD_FAILED: {
    status: 502,
    description: 'Failed to load Gmail thread.'
  },
  EMAIL_SEND_FAILED: {
    status: 502,
    description: 'Failed to send the requested Gmail message.'
  },
  EMAIL_SNIPPET_FAILED: {
    status: 502,
    description: 'Failed to fetch Gmail message snippet preview.'
  },
  ERR_MODULE_NOT_FOUND: {
    status: 500,
    description: 'The runtime could not locate a required module.'
  },
  FOLLOWUP_LIST_FAILED: {
    status: 502,
    description: 'Failed to list follow-up candidates from Gmail.'
  },
  GMAIL_DRAFT_INVALID: {
    status: 502,
    description: 'Gmail returned an invalid draft payload (missing or malformed data).'
  },
  GOOGLE_UNAUTHORIZED: {
    status: 401,
    description: 'Google rejected the request or refresh token; caller must reauthenticate.'
  },
  GOOGLE_USER_NOT_FOUND: {
    status: 401,
    description: 'Google account mapping was not found; caller must reauthenticate.'
  },
  IDEMPOTENCY_KEY_REUSE_MISMATCH: {
    status: 409,
    description: 'Idempotency key has already been used for a different request payload.'
  },
  INVALID_FOLLOWUP_WINDOW: {
    status: 400,
    description: 'Requested follow-up window is invalid or contradictory.'
  },
  INVALID_IDENTIFIER: {
    status: 400,
    description: 'Provided contact identifier is invalid.'
  },
  INVALID_PARAM: {
    status: 400,
    description: 'Request payload is missing or contains invalid parameters.'
  },
  INVALID_SIGNATURE: {
    status: 403,
    description: 'Signed URL signature verification failed.'
  },
  INVALID_TIME_FORMAT: {
    status: 400,
    description: 'Provided time format does not match the expected RFC3339 representation.'
  },
  LABEL_LIST_FAILED: {
    status: 502,
    description: 'Failed to list Gmail labels.'
  },
  LABEL_MODIFY_FAILED: {
    status: 502,
    description: 'Failed to modify Gmail labels.'
  },
  LABEL_MUTATION_VERIFICATION_FAILED: {
    status: 502,
    description: 'Gmail failed to verify label mutations after execution.'
  },
  LABEL_NAME_REQUIRED: {
    status: 400,
    description: 'Request to create or rename a label must include a name.'
  },
  LABEL_RESOLUTION_FAILED: {
    status: 400,
    description: 'Requested Gmail labels could not be resolved or matched.'
  },
  MARK_READ_FAILED: {
    status: 502,
    description: 'Failed to mark Gmail messages as read/unread.'
  },
  NOT_IMPLEMENTED: {
    status: 501,
    description: 'Endpoint or operation has not been implemented yet.'
  },
  OAUTH_INIT_FAILED: {
    status: 500,
    description: 'OAuth flow could not be initiated.'
  },
  REAUTH_REQUIRED: {
    status: 401,
    description: 'User must reauthenticate to continue.'
  },
  SERVER_ERROR: {
    status: 500,
    description: 'Generic internal server error.'
  },
  STAR_TOGGLE_FAILED: {
    status: 502,
    description: 'Failed to toggle Gmail star/flag state.'
  },
  TASKS_LIST_FAILED: {
    status: 502,
    description: 'Failed to list tasks for the requested task list.'
  },
  TASKS_RATE_LIMIT: {
    status: 429,
    description: 'Google Tasks API rejected the request due to rate limiting or quota exhaustion.'
  },
  TASKS_RPC_MUTATION_DISABLED: {
    status: 410,
    description: 'Legacy tasks RPC mutation has been removed; clients must call dedicated endpoints.'
  },
  TASKS_USER_NOT_FOUND: {
    status: 401,
    description: 'No Google Tasks user record exists for the provided microsoftId.'
  },
  TASK_CREATE_FAILED: {
    status: 502,
    description: 'Failed to create the requested task.'
  },
  TASK_DELETE_FAILED: {
    status: 502,
    description: 'Failed to delete the requested task.'
  },
  TASK_IDENTIFIERS_REQUIRED: {
    status: 400,
    description: 'Task identifier parameters are required for this operation.'
  },
  TASK_LISTS_NOT_FOUND: {
    status: 404,
    description: 'No Google Tasks list is available for the account.'
  },
  TASK_MODIFY_FAILED: {
    status: 502,
    description: 'Failed to modify the requested task.'
  },
  TASK_TITLE_REQUIRED: {
    status: 400,
    description: 'Task title must be supplied.'
  },
  TASK_UPDATE_FAILED: {
    status: 502,
    description: 'Failed to update the requested task.'
  },
  TASK_UPDATE_FIELDS_REQUIRED: {
    status: 400,
    description: 'Task update requires at least one updatable field.'
  },
  THREAD_GET_FAILED: {
    status: 502,
    description: 'Failed to retrieve the requested Gmail thread.'
  },
  THREAD_LABEL_MODIFY_FAILED: {
    status: 502,
    description: 'Failed to modify labels on the requested Gmail thread.'
  },
  THREAD_READ_STATUS_FAILED: {
    status: 502,
    description: 'Failed to toggle Gmail thread read status.'
  },
  THREAD_REPLY_FAILED: {
    status: 502,
    description: 'Failed to send the requested Gmail thread reply.'
  },
  TOKEN_DECRYPTION_FAILED: {
    status: 500,
    description: 'Internal failure while decrypting an OAuth token.'
  },
  TOKEN_ENCRYPTION_FAILED: {
    status: 500,
    description: 'Internal failure while encrypting an OAuth token.'
  },
  URL_EXPIRED: {
    status: 410,
    description: 'Signed URL has expired and must be regenerated.'
  }
};

function getErrorMetadata(code) {
  if (!code) {
    return undefined;
  }
  return errorCatalog[code];
}

function getDefaultStatus(code) {
  return getErrorMetadata(code)?.status;
}

export { errorCatalog, getDefaultStatus, getErrorMetadata };
