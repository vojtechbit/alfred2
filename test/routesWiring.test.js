import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const createHandlers = (names) => names.reduce((acc, name) => {
  const fn = (req, res, next) => { if (next) next(); };
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  acc[name] = fn;
  return acc;
}, {});

function verifyToken(req, res, next) { if (next) next(); }
function idempotencyMiddleware(req, res, next) { if (next) next(); }

mock.module(new URL('../src/middleware/authMiddleware.js', import.meta.url).href, { namedExports: { verifyToken } });
mock.module(new URL('../src/middleware/idempotencyMiddleware.js', import.meta.url).href, { namedExports: { idempotencyMiddleware } });
mock.module(new URL('../src/controllers/authController.js', import.meta.url).href, { namedExports: createHandlers(['initiateOAuth', 'handleCallback', 'checkStatus']) });
mock.module(new URL('../src/controllers/gmailController.js', import.meta.url).href, { namedExports: createHandlers([
  'sendEmail', 'replyToEmail', 'readEmail', 'batchPreview', 'batchRead', 'getEmailSnippet', 'searchEmails', 'listFollowupCandidates',
  'createDraft', 'deleteEmail', 'toggleStar', 'markAsRead', 'listLabels', 'modifyMessageLabels', 'modifyThreadLabels', 'getThread',
  'setThreadRead', 'replyToThread', 'getAttachmentMeta', 'previewAttachmentText', 'previewAttachmentTable', 'downloadAttachment'
]) });
mock.module(new URL('../src/controllers/calendarController.js', import.meta.url).href, { namedExports: createHandlers(['createEvent', 'getEvent', 'listEvents', 'updateEvent', 'deleteEvent']) });
mock.module(new URL('../src/controllers/contactsController.js', import.meta.url).href, { namedExports: createHandlers([
  'getAddressSuggestions', 'searchContacts', 'listContacts', 'bulkUpsertContacts', 'bulkDeleteContacts', 'addContact', 'updateContact', 'deleteContact'
]) });
mock.module(new URL('../src/controllers/tasksController.js', import.meta.url).href, { namedExports: createHandlers(['listTasks', 'createTask', 'updateTask', 'deleteTask']) });
mock.module(new URL('../src/controllers/authStatusController.js', import.meta.url).href, { namedExports: { getAuthStatus: function getAuthStatus(req, res) { if (res) res.end?.(); } } });
mock.module(new URL('../src/controllers/oauthProxyController.js', import.meta.url).href, { namedExports: { authorize: function authorize() {}, callback: function callback() {}, token: function token() {} } });
mock.module(new URL('../src/services/databaseService.js', import.meta.url).href, { namedExports: { getUserByGoogleSub: async () => ({}) } });
mock.module(new URL('../src/utils/advancedDebugging.js', import.meta.url).href, { namedExports: { getAdvancedDebugState: () => ({ enabled: true }) } });
mock.module(new URL('../src/services/microsoftGraphService.js', import.meta.url).href, { namedExports: { getDebugDiagnostics: () => ({ cleared: {} }), flushDebugCaches: () => ({ cleared: {} }) } });
mock.module(new URL('../src/utils/snapshotStore.js', import.meta.url).href, { namedExports: { getSnapshotDiagnostics: () => ({ active: 0 }), clearSnapshots: () => 0 } });
mock.module(new URL('../src/utils/redact.js', import.meta.url).href, { namedExports: { sanitizeForLog: () => ({}) } });
mock.module('dotenv', { defaultExport: { config: () => ({}) } });

const authRoutes = (await import(new URL('../src/routes/authRoutes.js', import.meta.url).href)).default;
const apiRoutes = (await import(new URL('../src/routes/apiRoutes.js', import.meta.url).href)).default;
const oauthProxyRoutes = (await import(new URL('../src/routes/oauthProxyRoutes.js', import.meta.url).href)).default;
const debugRoutes = (await import(new URL('../src/routes/debugRoutes.js', import.meta.url).href)).default;
const privacyRoutes = (await import(new URL('../src/routes/privacyRoutes.js', import.meta.url).href)).default;

test('authRoutes expose OAuth flow endpoints with auth protection', () => {
  const routes = authRoutes.stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods), handlers: layer.route.stack.map(handler => handler.handle) }));
  const paths = routes.map(route => route.path);
  assert.ok(paths.includes('/google'));
  assert.ok(paths.includes('/google/callback'));
  const statusRoute = routes.find(route => route.path === '/status');
  assert.ok(statusRoute);
  assert.ok(statusRoute.methods.includes('get'));
  assert.equal(statusRoute.handlers[0].name, 'verifyToken');
});

test('apiRoutes mount authentication and expose core resources', () => {
  const stack = apiRoutes.stack;
  const middlewareNames = stack.filter(layer => !layer.route).slice(0, 2).map(layer => layer.handle.name);
  assert.deepEqual(middlewareNames, ['verifyToken', 'idempotencyMiddleware']);
  const routes = stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
  const includesRoute = (path, method) => routes.some(route => route.path === path && route.methods.includes(method));
  assert.ok(includesRoute('/gmail/send', 'post'));
  assert.ok(includesRoute('/calendar/events', 'post'));
  assert.ok(includesRoute('/contacts', 'get'));
  assert.ok(includesRoute('/tasks', 'get'));
});

test('oauthProxyRoutes define authorize, callback, and token endpoints', () => {
  const routes = oauthProxyRoutes.stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
  const includesRoute = (path, method) => routes.some(route => route.path === path && route.methods.includes(method));
  assert.ok(includesRoute('/authorize', 'get'));
  assert.ok(includesRoute('/callback', 'get'));
  assert.ok(includesRoute('/token', 'post'));
});

test('debugRoutes require authentication and provide diagnostics', () => {
  const stack = debugRoutes.stack;
  assert.equal(stack[0].handle.name, 'verifyToken');
  const paths = stack.filter(layer => layer.route).map(layer => layer.route.path);
  assert.ok(paths.includes('/status'));
  assert.ok(paths.includes('/caches'));
  assert.ok(paths.includes('/token-status'));
});

test('privacyRoutes serve privacy policy page', () => {
  const routes = privacyRoutes.stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods), handler: layer.route.stack[0].handle }));
  const privacyRoute = routes.find(route => route.path === '/privacy-policy');
  assert.ok(privacyRoute);
  assert.ok(privacyRoute.methods.includes('get'));
  const req = {};
  let body = '';
  const res = { send(content) { body = content; } };
  privacyRoute.handler(req, res);
  assert.ok(body.includes('Privacy Policy'));
});
