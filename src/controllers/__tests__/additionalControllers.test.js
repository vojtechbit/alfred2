import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const serverPath = new URL('../../server.js', import.meta.url).href;
const oauthConfigPath = new URL('../../config/oauth.js', import.meta.url).href;
const databaseServicePath = new URL('../../services/databaseService.js', import.meta.url).href;
const contactsServicePath = new URL('../../services/contactsService.js', import.meta.url).href;
const gmailServicePath = new URL('../../services/microsoftGraphService.js', import.meta.url).href;
const tasksServicePath = new URL('../../services/tasksService.js', import.meta.url).href;
const snapshotStorePath = new URL('../../utils/snapshotStore.js', import.meta.url).href;
const proxyTokenServicePath = new URL('../../services/proxyTokenService.js', import.meta.url).href;

mock.module(serverPath, {
  namedExports: {
    heavyLimiter: (req, res, next) => next && next()
  }
});

const getAuthUrlMock = mock.fn(() => 'https://example.com/auth');
mock.module(oauthConfigPath, {
  namedExports: {
    getAuthUrl: getAuthUrlMock,
    getTokensFromCode: mock.fn(async () => ({ access_token: 'token', refresh_token: 'refresh' })),
    createOAuthClient: () => ({ setCredentials: () => {} }),
    refreshAccessToken: mock.fn(async () => ({ access_token: 'a', refresh_token: 'b' }))
  }
});

mock.module(databaseServicePath, {
  namedExports: {
    saveUser: mock.fn(async () => {}),
    getUserByGoogleSub: mock.fn(async () => ({ email: 'user@example.com', microsoftId: 'sub', refreshToken: 'refresh' })),
    updateTokens: mock.fn(async () => {}),
    getUserByProxyToken: mock.fn(async () => null)
  }
});

mock.module(contactsServicePath, {
  namedExports: {
    searchContacts: mock.fn(async () => ({ contacts: [], spreadsheetId: 'test-id' })),
    getAddressSuggestions: mock.fn(async () => []),
    listAllContacts: mock.fn(async () => ({ contacts: [], spreadsheetId: 'test-id' })),
    addContact: mock.fn(async () => ({ success: true }))
  }
});

mock.module(gmailServicePath, {
  namedExports: {
    sendEmail: mock.fn(async () => ({ id: '1', threadId: 't1' })),
    replyToEmail: mock.fn(async () => ({ id: '2', threadId: 't2' })),
    readEmail: mock.fn(async () => ({ id: '3' }))
  }
});

mock.module(tasksServicePath, {
  namedExports: {
    listTasks: mock.fn(async () => ({ items: [], nextPageToken: null }))
  }
});

mock.module(snapshotStorePath, {
  namedExports: {
    createSnapshot: () => 'snapshot-token',
    getSnapshot: () => null
  }
});

mock.module(proxyTokenServicePath, {
  namedExports: {
    generateAuthCode: () => 'auth-code',
    generateProxyToken: () => 'proxy-token',
    saveAuthCode: mock.fn(async () => {}),
    validateAndConsumeAuthCode: mock.fn(async () => null),
    saveProxyToken: mock.fn(async () => {})
  }
});

mock.module('dotenv', { defaultExport: { config: () => ({}) } });

const authControllerModulePath = new URL('../authController.js', import.meta.url).href;
const calendarControllerModulePath = new URL('../calendarController.js', import.meta.url).href;
const contactsControllerModulePath = new URL('../contactsController.js', import.meta.url).href;
const gmailControllerModulePath = new URL('../gmailController.js', import.meta.url).href;
const tasksControllerModulePath = new URL('../tasksController.js', import.meta.url).href;
const authStatusControllerModulePath = new URL('../authStatusController.js', import.meta.url).href;
const oauthProxyControllerModulePath = new URL('../oauthProxyController.js', import.meta.url).href;

const authController = await import(authControllerModulePath);
const calendarController = await import(calendarControllerModulePath);
const contactsController = await import(contactsControllerModulePath);
const gmailController = await import(gmailControllerModulePath);
const tasksController = await import(tasksControllerModulePath);
const authStatusController = await import(authStatusControllerModulePath);
const oauthProxyController = await import(oauthProxyControllerModulePath);

test('authController.initiateOAuth redirects to generated URL', async () => {
  const res = { redirectedTo: null, redirect(url) { this.redirectedTo = url; } };
  await authController.initiateOAuth({}, res);
  assert.equal(res.redirectedTo, 'https://example.com/auth');
  assert.equal(getAuthUrlMock.mock.calls.length, 1);
});

test('authController.checkStatus returns user payload', async () => {
  const jsonPayload = {};
  const res = { json(data) { Object.assign(jsonPayload, data); } };
  await authController.checkStatus({ user: { email: 'test@example.com', microsoftId: 'sub', name: 'Test' } }, res);
  assert.equal(jsonPayload.authenticated, true);
  assert.equal(jsonPayload.user.email, 'test@example.com');
});

test('authController.handleCallback handles user denial', async () => {
  const res = { statusCode: null, sent: null, status(code) { this.statusCode = code; return this; }, send(payload) { this.sent = payload; return this; } };
  await authController.handleCallback({ query: { error: 'access_denied' } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(String(res.sent).includes('Authentication Failed'));
});

test('calendarController.createEvent validates required fields', async () => {
  const res = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(data) { this.payload = data; return this; } };
  await calendarController.createEvent({ body: { summary: '', start: null, end: null }, user: { microsoftId: 'sub' } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.payload.message.includes('summary'));
});

test('contactsController.searchContacts requires query parameter', async () => {
  const res = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(data) { this.payload = data; return this; } };
  await contactsController.searchContacts({ query: {}, user: { accessToken: 'token' }, headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.payload.message.includes('query'));
});

test('gmailController.sendEmail enforces body validation', async () => {
  const res = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(data) { this.payload = data; return this; } };
  await gmailController.sendEmail({ body: { to: '', subject: '', body: '' }, user: { microsoftId: 'sub', email: 'test@example.com' } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.payload.message.includes('Missing required fields'));
});

test('tasksController.listTasks rejects expired snapshot token', async () => {
  const res = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(data) { this.payload = data; return this; } };
  await tasksController.listTasks({ query: { aggregate: 'true', snapshotToken: 'invalid' }, user: { microsoftId: 'sub' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Invalid or expired snapshot token');
});

test('authStatusController.getAuthStatus returns localized success message', async () => {
  const res = { payload: null, json(data) { this.payload = data; } };
  await authStatusController.getAuthStatus({ user: { email: 'user@example.com', microsoftId: 'sub' } }, res);
  assert.equal(res.payload.authenticated, true);
  assert.ok(res.payload.message.includes('Přihlášen'));
});

test('oauthProxyController.authorize validates redirect uri and state', async () => {
  const res = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(data) { this.payload = data; return this; } };
  await oauthProxyController.authorize({ query: { client_id: 'wrong', redirect_uri: 'https://invalid', state: '' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'invalid_client');
});

test('oauthProxyController.callback fails on invalid state encoding', async () => {
  const res = { statusCode: null, sent: null, status(code) { this.statusCode = code; return this; }, send(payload) { this.sent = payload; return this; } };
  await oauthProxyController.callback({ query: { code: 'abc', state: '!!!' } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(String(res.sent).includes('Invalid State'));
});
