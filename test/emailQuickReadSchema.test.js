import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import './helpers/cleanupFacadeMocks.js';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/oauth';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-db';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.BASE_URL = process.env.BASE_URL || 'https://example.com';
process.env.NODE_ENV = 'test';

const openApiModule = await import('../openapi-facade-final.json', { with: { type: 'json' } });
const openApiDocument = openApiModule.default ?? openApiModule;

let readEmailMock;
let searchEmailsMock;

const facadeModule = await import('../src/services/facadeService.js');
const { emailQuickRead, EMAIL_QUICK_READ_FORMATS } = facadeModule;

beforeEach(() => {
  readEmailMock = mock.fn(async (microsoftId, messageId, options = {}) => ({
    id: messageId,
    threadId: `thread-${messageId}`,
    from: 'Mock Sender <sender@example.com>',
    subject: `Mock subject (${options.format || 'full'})`,
    internalDate: String(Date.now()),
    labelIds: ['INBOX'],
    snippet: 'This is a mock snippet',
    body: 'This is a mock body',
    payload: { parts: [] },
    contentMetadata: {
      format: options.format || 'full'
    }
  }));

  searchEmailsMock = mock.fn(async () => ({
    messages: [],
    nextPageToken: null
  }));

  globalThis.__facadeMocks = {
    gmailService: {
      readEmail: readEmailMock,
      searchEmails: searchEmailsMock
    }
  };
});

describe('emailQuickRead OpenAPI schema alignment', () => {
  it('keeps EMAIL_QUICK_READ_FORMATS in sync with OpenAPI enum', () => {
    const schemaFormats = openApiDocument
      ?.paths?.['/macros/email/quickRead']
      ?.post?.requestBody?.content?.['application/json']?.schema?.properties?.format?.enum ?? [];

    assert.ok(Array.isArray(schemaFormats), 'Schema enum must be an array');
    const sortedSchema = [...schemaFormats].sort();
    const sortedConstant = [...EMAIL_QUICK_READ_FORMATS].sort();

    assert.deepEqual(sortedConstant, sortedSchema, 'Schema enum and service constant must match');
  });

  it('allows calling emailQuickRead with every documented format', async () => {
    for (const format of EMAIL_QUICK_READ_FORMATS) {
      await assert.doesNotReject(() => emailQuickRead('test-google-sub', {
        ids: ['mock-message-id'],
        format
      }), `Format ${format} should not throw validation error`);
    }

    assert.equal(
      readEmailMock.mock.callCount(),
      EMAIL_QUICK_READ_FORMATS.length,
      'readEmail should be invoked once per format'
    );
  });
});
