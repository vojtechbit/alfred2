import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/oauth';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-db';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.BASE_URL = process.env.BASE_URL || 'https://example.com';
process.env.NODE_ENV = 'test';

const searchEmailsMock = mock.fn();
const readEmailMock = mock.fn();
const getEmailPreviewMock = mock.fn();

const facadeModule = await import('../src/services/facadeService.js');
const { inboxSnippets } = facadeModule;

beforeEach(() => {
  searchEmailsMock.mock.resetCalls();
  readEmailMock.mock.resetCalls();
  getEmailPreviewMock.mock.resetCalls();

  globalThis.__facadeMocks = {
    gmailService: {
      searchEmails: (...args) => searchEmailsMock(...args),
      readEmail: (...args) => readEmailMock(...args),
      getEmailPreview: (...args) => getEmailPreviewMock(...args)
    },
    databaseService: {
      async getUserByGoogleSub(microsoftId) {
        return {
          _id: 'user-test',
          google: {
            sub: microsoftId,
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token'
          }
        };
      }
    }
  };
});

after(() => {
  delete globalThis.__facadeMocks;
  mock.restoreAll();
});

describe('inboxSnippets attachment handling', () => {
  it('filters blocked attachments while returning warnings and URLs for allowed ones', async () => {
    searchEmailsMock.mock.mockImplementation(async () => ({
      messages: [{ id: 'msg-1' }],
      nextPageToken: null
    }));

    readEmailMock.mock.mockImplementation(async () => ({
      id: 'msg-1',
      from: 'Tester <tester@example.com>',
      subject: 'Mixed attachments',
      date: '2024-01-01T00:00:00Z',
      labelIds: ['INBOX'],
      snippet: 'metadata snippet',
      threadId: 'thr-1'
    }));

    getEmailPreviewMock.mock.mockImplementation(async () => ({
      snippet: 'Preview body snippet',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'att-1', size: 4096 }
          },
          {
            filename: 'malware.exe',
            mimeType: 'application/octet-stream',
            body: { attachmentId: 'att-2', size: 4096 }
          }
        ]
      }
    }));

    const result = await inboxSnippets('test-google-sub', {});

    assert.equal(result.items.length, 1);
    const item = result.items[0];

    assert.deepEqual(item.attachmentUrls.length, 1);
    assert.match(item.attachmentUrls[0], /\/msg-1\/att-1\/download/);

    assert.deepEqual(item.links, {
      thread: 'https://mail.google.com/mail/u/0/#inbox/thr-1',
      message: 'https://mail.google.com/mail/u/0/#inbox/thr-1?projector=1&messageId=msg-1'
    });

    assert.ok(Array.isArray(item.attachmentSecurityWarnings));
    assert.equal(item.attachmentSecurityWarnings.length, 2);
    assert.match(item.attachmentSecurityWarnings[0], /does not guarantee file safety/);
    assert.equal(
      item.attachmentSecurityWarnings[1],
      '1 file(s) blocked by security policy: malware.exe'
    );
  });

  it('propagates a 451 error when the only attachment is blocked', async () => {
    searchEmailsMock.mock.mockImplementation(async () => ({
      messages: [{ id: 'msg-danger' }],
      nextPageToken: null
    }));

    readEmailMock.mock.mockImplementation(async () => ({
      id: 'msg-danger',
      from: 'Alert <alert@example.com>',
      subject: 'Dangerous attachment',
      date: '2024-01-02T00:00:00Z',
      labelIds: ['INBOX'],
      snippet: 'metadata snippet',
      threadId: 'thr-danger'
    }));

    getEmailPreviewMock.mock.mockImplementation(async () => ({
      snippet: 'Dangerous preview',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            filename: 'exploit.exe',
            mimeType: 'application/octet-stream',
            body: { attachmentId: 'att-danger', size: 4096 }
          }
        ]
      }
    }));

    await assert.rejects(
      () => inboxSnippets('test-google-sub', {}),
      (error) => error?.statusCode === 451,
      'Expected 451 error to be propagated'
    );
  });
});
