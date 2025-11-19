import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_CLIENT_ID ||= 'dummy-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'dummy-client-secret';
process.env.REDIRECT_URI ||= 'https://dummy.example/oauth';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const databaseModulePath = new URL('../src/services/databaseService.js', import.meta.url).href;
const oauthModulePath = new URL('../src/config/oauth.js', import.meta.url).href;

const getUserByGoogleSub = mock.fn(async () => ({
  microsoftId: 'user-1',
  email: 'user@example.com',
  accessToken: 'cached-access-token',
  refreshToken: 'refresh-token',
  tokenExpiry: new Date(Date.now() + 60 * 60 * 1000).toISOString()
}));

mock.module(databaseModulePath, {
  namedExports: {
    getUserByGoogleSub,
    updateTokens: mock.fn(async () => {}),
    updateLastUsed: mock.fn(async () => {})
  }
});

mock.module(oauthModulePath, {
  namedExports: {
    refreshAccessToken: mock.fn(async () => ({ access_token: 'refreshed' })),
    getAuthUrl: () => 'https://example.com',
    getTokensFromCode: async () => ({ access_token: 'code-token', refresh_token: 'code-refresh' }),
    createOAuthClient: () => ({ setCredentials: () => {} })
  }
});

const listCalls = [];

mock.module('googleapis', {
  namedExports: {
    google: {
      auth: {
        OAuth2: class {
          constructor() {}
          setCredentials() {}
        }
      },
      gmail: () => ({
        users: {
          messages: {
            list: async (params) => {
              listCalls.push(params);
              return {
                data: {
                  messages: [
                    { id: 'msg-1', threadId: 'thr-1' },
                    { id: 'msg-2', threadId: 'thr-2', links: { thread: 'https://custom/thread', message: null } }
                  ],
                  threads: [
                    {
                      id: 'thr-aggregate',
                      messages: [
                        { id: 'msg-thread', threadId: 'thr-aggregate' }
                      ]
                    }
                  ],
                  nextPageToken: 'next'
                }
              };
            }
          }
        }
      })
    }
  }
});

const { searchEmails } = await import('../src/services/microsoftGraphService.js');

const { messages, threads, nextPageToken } = await searchEmails('user-1', { query: 'subject:test', maxResults: 5 });

test('searchEmails decorates Gmail results with links', () => {
  assert.equal(Array.isArray(messages), true);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].links, {
    thread: 'https://mail.google.com/mail/u/0/#inbox/thr-1',
    message: 'https://mail.google.com/mail/u/0/#inbox/thr-1?projector=1&messageId=msg-1'
  });
  assert.deepEqual(messages[1].links, { thread: 'https://custom/thread', message: null });
  assert.equal(Array.isArray(threads), true);
  assert.deepEqual(threads[0].links, {
    thread: 'https://mail.google.com/mail/u/0/#inbox/thr-aggregate',
    message: 'https://mail.google.com/mail/u/0/#inbox/thr-aggregate?projector=1&messageId=msg-thread'
  });
  assert.equal(Array.isArray(threads[0].messages), true);
  assert.deepEqual(threads[0].messages[0].links, {
    thread: 'https://mail.google.com/mail/u/0/#inbox/thr-aggregate',
    message: 'https://mail.google.com/mail/u/0/#inbox/thr-aggregate?projector=1&messageId=msg-thread'
  });
  assert.equal(nextPageToken, 'next');
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].q, 'subject:test');
  assert.equal(listCalls[0].maxResults, 5);
  mock.restoreAll();
});
