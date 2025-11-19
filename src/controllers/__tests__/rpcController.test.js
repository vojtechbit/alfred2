import { test } from 'node:test';
import assert from 'node:assert/strict';

// Provide dummy OAuth env vars so importing services does not exit the process.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost/callback';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const bulkDeleteCalls = [];
const listTaskCalls = [];
const createDraftCalls = [];
const updateDraftCalls = [];
const listDraftCalls = [];
const getDraftCalls = [];
const searchEmailCalls = [];

globalThis.__RPC_TEST_OVERRIDES = {
  gmailService: {
    searchEmails: async (sub, params) => {
      searchEmailCalls.push({ sub, params });
      return {
        messages: [
          {
            id: 'msg-123',
            threadId: 'thr-789',
            links: {
              thread: 'https://mail.google.com/mail/u/0/#inbox/thr-789',
              message: 'https://mail.google.com/mail/u/0/#inbox/thr-789?projector=1&messageId=msg-123'
            }
          },
          {
            id: 'msg-456',
            threadId: 'thr-000'
          }
        ],
        nextPageToken: 'next-token',
        resultSizeEstimate: 2
      };
    },
    createDraft: async (sub, payload) => {
      createDraftCalls.push({ sub, payload });
      return { id: 'draft-123', message: { id: 'msg-456' } };
    },
    updateDraft: async (sub, draftId, payload) => {
      updateDraftCalls.push({ sub, draftId, payload });
      return { id: draftId, message: { id: 'msg-updated' } };
    },
    listDrafts: async (sub, payload) => {
      listDraftCalls.push({ sub, payload });
      return { drafts: [{ id: 'draft-1' }], nextPageToken: null };
    },
    getDraft: async (sub, draftId, options) => {
      getDraftCalls.push({ sub, draftId, options });
      return { id: draftId, message: { id: 'msg-789' }, payload: { headers: [] } };
    }
  },
  contactsService: {
    bulkDelete: async (token, payload) => {
      bulkDeleteCalls.push({ token, payload });
      return { removed: (payload.rowIds || []).length, emails: payload.emails };
    }
  },
  tasksService: {
    listTasks: async (sub, params) => {
      listTaskCalls.push({ sub, params });
      return { items: [{ id: 'task-1' }], nextPageToken: null };
    }
  }
};

const { contactsRpc, tasksRpc, mailRpc } = await import('../rpcController.js');
delete globalThis.__RPC_TEST_OVERRIDES;

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.body = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(payload) {
    this.body = payload;
    return this;
  }
}

test('contactsRpc bulkDelete now returns migration error', async () => {
  bulkDeleteCalls.length = 0;
  const request = {
    body: {
      op: 'bulkDelete',
      params: { rowIds: [3, 5] }
    },
    user: { accessToken: 'token-123' }
  };
  const response = new MockResponse();

  await contactsRpc(request, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'CONTACTS_RPC_MUTATION_DISABLED');
  assert.deepEqual(response.body.endpoints, {
    update: '/api/contacts/actions/modify',
    delete: '/api/contacts/actions/delete',
    bulkDelete: '/api/contacts/actions/bulkDelete'
  });
  assert.equal(bulkDeleteCalls.length, 0);
});

test('contactsRpc bulkDelete root-level payload also returns migration error', async () => {
  bulkDeleteCalls.length = 0;
  const request = {
    body: {
      op: 'bulkDelete',
      rowIds: [7]
    },
    user: { accessToken: 'token-456' }
  };
  const response = new MockResponse();

  await contactsRpc(request, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'CONTACTS_RPC_MUTATION_DISABLED');
  assert.equal(bulkDeleteCalls.length, 0);
});

test('tasksRpc list delegates to tasksService listTasks', async () => {
  listTaskCalls.length = 0;
  const request = {
    body: {
      op: 'list',
      params: { maxResults: 5 }
    },
    user: { microsoftId: 'user-42' }
  };
  const response = new MockResponse();

  await tasksRpc(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: { items: [{ id: 'task-1' }], nextPageToken: null }
  });
  assert.deepEqual(listTaskCalls, [
    {
      sub: 'user-42',
      params: { maxResults: 5 }
    }
  ]);
});

test('tasksRpc complete now returns migration error with hints', async () => {
  const request = {
    body: {
      op: 'complete',
      params: { taskListId: 'list-1', taskId: 'task-9' }
    },
    user: { microsoftId: 'user-42' }
  };
  const response = new MockResponse();

  await tasksRpc(request, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'TASKS_RPC_MUTATION_DISABLED');
  assert.equal(response.body.hint.includes('status: "completed"'), true);
  assert.deepEqual(response.body.endpoints, {
    create: '/api/tasks/actions/create',
    modify: '/api/tasks/actions/modify',
    delete: '/api/tasks/actions/delete'
  });
});

test('tasksRpc create returns migration error using root level payloads', async () => {
  const request = {
    body: {
      op: 'create',
      title: 'New task'
    },
    user: { microsoftId: 'user-77' }
  };
  const response = new MockResponse();

  await tasksRpc(request, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.code, 'TASKS_RPC_MUTATION_DISABLED');
  assert.equal(response.body.hint.includes('/tasks/actions/create'), true);
  assert.equal(listTaskCalls.length, 1); // unchanged from list test above
});

test('mailRpc createDraft creates draft via Gmail service', async () => {
  createDraftCalls.length = 0;
  updateDraftCalls.length = 0;
  const request = {
    body: {
      op: 'createDraft',
      params: {
        to: ' coworker@example.com ',
        subject: ' Weekly status ',
        body: 'Čau, posílám koncept meetingu.',
        cc: ' cc@example.com ',
        bcc: 'bcc@example.com'
      }
    },
    user: { microsoftId: 'user-sub-1' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: { id: 'draft-123', message: { id: 'msg-456' } }
  });
  assert.deepEqual(createDraftCalls, [
    {
      sub: 'user-sub-1',
      payload: {
        to: 'coworker@example.com',
        subject: 'Weekly status',
        body: 'Čau, posílám koncept meetingu.',
        cc: ' cc@example.com ',
        bcc: 'bcc@example.com'
      }
    }
  ]);
});

test('mailRpc search normalizes Gmail links', async () => {
  searchEmailCalls.length = 0;
  const request = {
    body: {
      op: 'search',
      params: { query: 'from:boss@example.com' }
    },
    user: { microsoftId: 'user-search' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(Array.isArray(response.body.data.messages), true);
  assert.equal(response.body.data.messages.length, 2);
  assert.deepEqual(response.body.data.messages[0].links, {
    thread: 'https://mail.google.com/mail/u/0/#inbox/thr-789',
    message: 'https://mail.google.com/mail/u/0/#inbox/thr-789?projector=1&messageId=msg-123'
  });
  assert.equal(response.body.data.messages[1].links, null);
  assert.equal(response.body.data.nextPageToken, 'next-token');
  assert.deepEqual(searchEmailCalls, [
    {
      sub: 'user-search',
      params: { query: 'from:boss@example.com' }
    }
  ]);
});

test('mailRpc createDraft rejects missing subject', async () => {
  createDraftCalls.length = 0;
  const request = {
    body: {
      op: 'createDraft',
      params: {
        to: 'coworker@example.com',
        body: 'Návrh zprávy'
      }
    },
    user: { microsoftId: 'user-sub-2' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_PARAM');
  assert.match(response.body.message, /subject/);
  assert.equal(createDraftCalls.length, 0);
});

test('mailRpc updateDraft delegates to Gmail service', async () => {
  updateDraftCalls.length = 0;
  const request = {
    body: {
      op: 'updateDraft',
      params: {
        draftId: ' draft-321 ',
        to: ' contact@example.com ',
        subject: ' Re: Dotaz ',
        body: 'Díky za info.',
        threadId: 'thread-123'
      }
    },
    user: { microsoftId: 'user-sub-3' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: { id: 'draft-321', message: { id: 'msg-updated' } }
  });
  assert.deepEqual(updateDraftCalls, [
    {
      sub: 'user-sub-3',
      draftId: 'draft-321',
      payload: {
        to: 'contact@example.com',
        subject: 'Re: Dotaz',
        body: 'Díky za info.',
        threadId: 'thread-123'
      }
    }
  ]);
});

test('mailRpc updateDraft validates required fields', async () => {
  updateDraftCalls.length = 0;
  const request = {
    body: {
      op: 'updateDraft',
      params: {
        draftId: '',
        to: ' ',
        subject: '',
        body: 42
      }
    },
    user: { microsoftId: 'user-sub-4' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_PARAM');
  assert.match(response.body.message, /draftId/);
  assert.equal(updateDraftCalls.length, 0);
});

test('mailRpc listDrafts forwards request to Gmail service', async () => {
  listDraftCalls.length = 0;
  const request = {
    body: {
      op: 'listDrafts',
      params: { maxResults: 5, pageToken: ' token ' }
    },
    user: { microsoftId: 'user-sub-5' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: { drafts: [{ id: 'draft-1' }], nextPageToken: null }
  });
  assert.deepEqual(listDraftCalls, [
    {
      sub: 'user-sub-5',
      payload: { maxResults: 5, pageToken: ' token ' }
    }
  ]);
});

test('mailRpc getDraft requires draftId', async () => {
  getDraftCalls.length = 0;
  const request = {
    body: {
      op: 'getDraft',
      params: { format: 'full' }
    },
    user: { microsoftId: 'user-sub-6' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'INVALID_PARAM');
  assert.equal(getDraftCalls.length, 0);
});

test('mailRpc getDraft delegates to Gmail service', async () => {
  getDraftCalls.length = 0;
  const request = {
    body: {
      op: 'getDraft',
      params: { draftId: ' draft-555 ', format: 'metadata' }
    },
    user: { microsoftId: 'user-sub-7' }
  };
  const response = new MockResponse();

  await mailRpc(request, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: { id: 'draft-555', message: { id: 'msg-789' }, payload: { headers: [] } }
  });
  assert.deepEqual(getDraftCalls, [
    {
      sub: 'user-sub-7',
      draftId: 'draft-555',
      options: { format: 'metadata' }
    }
  ]);
});
