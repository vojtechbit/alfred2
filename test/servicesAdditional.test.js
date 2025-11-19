import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ACCESS_TOKEN_HASH_SECRET = 'identity-secret';
process.env.PROXY_TOKEN_SECRET = 'b'.repeat(64);
process.env.MONGODB_URI = 'mongodb://localhost/test';

const databaseModulePath = new URL('../src/config/database.js', import.meta.url).href;
const databaseServiceModulePath = new URL('../src/services/databaseService.js', import.meta.url).href;
const oauthConfigModulePath = new URL('../src/config/oauth.js', import.meta.url).href;

const databaseState = new Map();

mock.module(databaseModulePath, {
  namedExports: {
    getDatabase: async () => ({
      collection: (name) => {
        if (!databaseState.has(name)) {
          throw new Error(`Collection not stubbed: ${name}`);
        }
        return databaseState.get(name);
      }
    })
  }
});

const getUserByGoogleSubMock = mock.fn(async (microsoftId) => ({ microsoftId, email: `${microsoftId}@example.com`, refreshToken: 'refresh-token' }));
const updateTokensMock = mock.fn(async () => {});
mock.module(databaseServiceModulePath, {
  namedExports: {
    getUserByGoogleSub: getUserByGoogleSubMock,
    updateTokens: updateTokensMock
  }
});

const refreshAccessTokenMock = mock.fn(async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }));
mock.module(oauthConfigModulePath, {
  namedExports: {
    refreshAccessToken: refreshAccessTokenMock,
    getAuthUrl: () => 'https://example.com',
    getTokensFromCode: async () => ({ access_token: 'token', refresh_token: 'refresh' }),
    createOAuthClient: () => ({ setCredentials: () => {} })
  }
});

mock.module('dotenv', { defaultExport: { config: () => ({}) } });

const tokenService = await import(new URL('../src/services/tokenService.js', import.meta.url).href);
const tokenIdentityService = await import(new URL('../src/services/tokenIdentityService.js', import.meta.url).href);
const proxyTokenService = await import(new URL('../src/services/proxyTokenService.js', import.meta.url).href);
const backgroundRefreshService = await import(new URL('../src/services/backgroundRefreshService.js', import.meta.url).href);

test('tokenService encrypts and decrypts tokens symmetrically', () => {
  const token = 'super-secret-token';
  const encrypted = tokenService.encryptToken(token);
  const decrypted = tokenService.decryptToken(encrypted.encryptedToken, encrypted.iv, encrypted.authTag);
  assert.equal(decrypted, token);
});

test('cacheAccessTokenIdentity stores hashed token with expiry metadata', async () => {
  const updateOneMock = mock.fn(async () => {});
  const collection = {
    createIndex: mock.fn(async () => {}),
    updateOne: updateOneMock
  };
  databaseState.set('access_token_identity_cache', collection);
  await tokenIdentityService.cacheAccessTokenIdentity({ accessToken: 'token-123', microsoftId: 'sub1', email: 'user@example.com' });
  assert.equal(collection.createIndex.mock.calls.length, 3);
  const expectedHash = crypto.createHmac('sha256', 'identity-secret').update('token-123').digest('hex');
  const [filter, update] = updateOneMock.mock.calls[0].arguments;
  assert.equal(filter.token_hash, expectedHash);
  const setDoc = update.$set;
  assert.equal(setDoc.microsoft_id, 'sub1');
  assert.ok(setDoc.expires_at instanceof Date);
});

test('getCachedIdentityForAccessToken returns hydrated identity', async () => {
  const tokenHash = crypto.createHmac('sha256', 'identity-secret').update('token-abc').digest('hex');
  const updateOneMock = mock.fn(async () => {});
  const collection = {
    findOne: mock.fn(async () => ({ _id: 1, token_hash: tokenHash, microsoft_id: 'subX', email: 'cached@example.com', expires_at: new Date(Date.now() + 60000) })),
    updateOne: updateOneMock,
    deleteOne: mock.fn(async () => {})
  };
  databaseState.set('access_token_identity_cache', collection);
  const result = await tokenIdentityService.getCachedIdentityForAccessToken('token-abc');
  assert.equal(result.microsoftId, 'subX');
  assert.equal(result.email, 'cached@example.com');
  assert.equal(updateOneMock.mock.calls.length, 1);
});

test('getCachedIdentityForAccessToken purges expired entries', async () => {
  const tokenHash = crypto.createHmac('sha256', 'identity-secret').update('token-expired').digest('hex');
  const deleteOneMock = mock.fn(async () => {});
  const collection = {
    findOne: mock.fn(async () => ({ _id: 2, token_hash: tokenHash, microsoft_id: 'subZ', email: 'old@example.com', expires_at: new Date(Date.now() - 1000) })),
    updateOne: mock.fn(async () => {}),
    deleteOne: deleteOneMock
  };
  databaseState.set('access_token_identity_cache', collection);
  const result = await tokenIdentityService.getCachedIdentityForAccessToken('token-expired');
  assert.equal(result, null);
  assert.equal(deleteOneMock.mock.calls.length, 1);
});

test('invalidateCachedIdentity deletes hashed token', async () => {
  const deleteOneMock = mock.fn(async () => {});
  const collection = {
    deleteOne: deleteOneMock,
    createIndex: mock.fn(async () => {})
  };
  databaseState.set('access_token_identity_cache', collection);
  await tokenIdentityService.invalidateCachedIdentity('token-remove');
  const expectedHash = crypto.createHmac('sha256', 'identity-secret').update('token-remove').digest('hex');
  const [filter] = deleteOneMock.mock.calls[0].arguments;
  assert.equal(filter.token_hash, expectedHash);
});

test('purgeIdentitiesForGoogleSub removes all matching entries', async () => {
  const deleteManyMock = mock.fn(async () => ({ deletedCount: 2 }));
  const collection = {
    deleteMany: deleteManyMock,
    createIndex: mock.fn(async () => {})
  };
  databaseState.set('access_token_identity_cache', collection);
  await tokenIdentityService.purgeIdentitiesForGoogleSub('sub123');
  const [filter] = deleteManyMock.mock.calls[0].arguments;
  assert.equal(filter.microsoft_id, 'sub123');
});

test('saveAuthCode persists authorization flow metadata', async () => {
  const insertOneMock = mock.fn(async () => {});
  databaseState.set('oauth_flows', { insertOne: insertOneMock });
  await proxyTokenService.saveAuthCode({ authCode: 'code', microsoftId: 'sub1', state: 'state', chatgptRedirectUri: 'https://chat.openai.com/redirect' });
  assert.equal(insertOneMock.mock.calls.length, 1);
  const [doc] = insertOneMock.mock.calls[0].arguments;
  assert.equal(doc.microsoft_id, 'sub1');
  assert.ok(doc.expires_at instanceof Date);
});

test('validateAndConsumeAuthCode returns flow details on success', async () => {
  const updateOneMock = mock.fn(async () => {});
  const authFlow = { auth_code: 'code', microsoft_id: 'subA', chatgpt_redirect_uri: 'https://chat.openai.com', expires_at: new Date(Date.now() + 60000), used: false };
  databaseState.set('oauth_flows', {
    findOne: mock.fn(async () => authFlow),
    updateOne: updateOneMock
  });
  const result = await proxyTokenService.validateAndConsumeAuthCode('code');
  assert.equal(result.microsoftId, 'subA');
  assert.equal(updateOneMock.mock.calls.length, 1);
});

test('saveProxyToken stores hashed token metadata', async () => {
  const insertOneMock = mock.fn(async () => {});
  databaseState.set('proxy_tokens', { insertOne: insertOneMock });
  await proxyTokenService.saveProxyToken({ proxyToken: 'proxy-token', microsoftId: 'subP', expiresIn: 60 });
  const expectedHash = crypto.createHmac('sha512', Buffer.from('b'.repeat(64), 'hex')).update('proxy-token').digest('hex');
  const [doc] = insertOneMock.mock.calls[0].arguments;
  assert.equal(doc.proxy_token_hash, expectedHash);
  assert.equal(doc.microsoft_id, 'subP');
});

test('findUserByProxyToken validates token against stored hashes', async () => {
  const hash = crypto.createHmac('sha512', Buffer.from('b'.repeat(64), 'hex')).update('proxy-active').digest('hex');
  const updateOneMock = mock.fn(async () => {});
  const proxyCollection = {
    findOne: mock.fn(async (filter) => {
      if (filter.proxy_token_hash) {
        return { _id: 1, proxy_token_hash: hash, microsoft_id: 'subFound', expires_at: new Date(Date.now() + 60000) };
      }
      return null;
    }),
    updateOne: updateOneMock
  };
  databaseState.set('proxy_tokens', proxyCollection);
  const microsoftId = await proxyTokenService.findUserByProxyToken('proxy-active');
  assert.equal(microsoftId, 'subFound');
  assert.equal(updateOneMock.mock.calls.length, 1);
});

test('cleanupExpiredTokens removes stale auth codes and tokens', async () => {
  databaseState.set('oauth_flows', { deleteMany: mock.fn(async () => ({ deletedCount: 4 })) });
  databaseState.set('proxy_tokens', { deleteMany: mock.fn(async () => ({ deletedCount: 2 })) });
  const result = await proxyTokenService.cleanupExpiredTokens();
  assert.equal(result.authCodesDeleted, 4);
  assert.equal(result.proxyTokensDeleted, 2);
});

test('refreshAllTokensOnStartup refreshes expiring user tokens', async () => {
  const users = [
    { microsoft_id: 'sub1', email: 'user1@example.com', token_expiry: new Date(Date.now() + 1000).toISOString() },
    { microsoft_id: 'sub2', email: 'user2@example.com', token_expiry: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }
  ];
  databaseState.set('users', {
    find: () => ({ toArray: async () => users }),
    updateOne: mock.fn(async () => {})
  });
  const updateCallsBefore = updateTokensMock.mock.calls.length;
  const refreshCallsBefore = refreshAccessTokenMock.mock.calls.length;
  await backgroundRefreshService.refreshAllTokensOnStartup();
  assert.equal(refreshAccessTokenMock.mock.calls.length, refreshCallsBefore + 1);
  assert.equal(updateTokensMock.mock.calls.length, updateCallsBefore + 1);
});
