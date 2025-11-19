import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost/callback';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const calls = {
  create: [],
  update: [],
  delete: []
};

globalThis.__TASKS_ACTIONS_TEST_OVERRIDES = {
  tasksService: {
    createTask: async (sub, payload) => {
      calls.create.push({ sub, payload });
      return { id: 'task-new', ...payload, status: 'needsAction' };
    },
    updateTask: async (sub, taskListId, taskId, updates) => {
      calls.update.push({ sub, taskListId, taskId, updates });
      return { id: taskId, taskListId, ...updates };
    },
    deleteTask: async (sub, taskListId, taskId) => {
      calls.delete.push({ sub, taskListId, taskId });
      return { success: true };
    }
  }
};

const {
  createTask,
  modifyTask,
  deleteTask
} = await import('../tasksActionsController.js');
delete globalThis.__TASKS_ACTIONS_TEST_OVERRIDES;

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

test('createTask validates input and normalizes due date', async () => {
  calls.create.length = 0;

  const request = {
    body: {
      title: 'Prepare agenda',
      due: '2025-02-01',
      notes: 'Sync with team'
    },
    user: { microsoftId: 'sub-123' }
  };
  const response = new MockResponse();

  await createTask(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(calls.create, [
    {
      sub: 'sub-123',
      payload: {
        title: 'Prepare agenda',
        notes: 'Sync with team',
        due: '2025-02-01T00:00:00.000Z'
      }
    }
  ]);
});

test('createTask enforces title requirement', async () => {
  const request = {
    body: { notes: 'missing title' },
    user: { microsoftId: 'sub-123' }
  };
  const response = new MockResponse();

  await createTask(request, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'TASK_TITLE_REQUIRED');
  assert.equal(calls.create.length, 1);
});

test('modifyTask merges updates from root and nested payload', async () => {
  calls.update.length = 0;

  const request = {
    body: {
      taskListId: 'list-1',
      taskId: 'task-1',
      notes: 'Updated notes',
      due: '2025-02-02',
      updates: { status: 'completed' }
    },
    user: { microsoftId: 'sub-789' }
  };
  const response = new MockResponse();

  await modifyTask(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(calls.update, [
    {
      sub: 'sub-789',
      taskListId: 'list-1',
      taskId: 'task-1',
      updates: {
        status: 'completed',
        notes: 'Updated notes',
        due: '2025-02-02T00:00:00.000Z'
      }
    }
  ]);
});

test('modifyTask requires identifiers and at least one field', async () => {
  const requestMissingIds = {
    body: {
      status: 'completed'
    },
    user: { microsoftId: 'sub-789' }
  };
  const responseMissingIds = new MockResponse();
  await modifyTask(requestMissingIds, responseMissingIds);
  assert.equal(responseMissingIds.statusCode, 400);
  assert.equal(responseMissingIds.body.code, 'TASK_IDENTIFIERS_REQUIRED');

  const requestMissingUpdates = {
    body: {
      taskListId: 'list-1',
      taskId: 'task-1'
    },
    user: { microsoftId: 'sub-789' }
  };
  const responseMissingUpdates = new MockResponse();
  await modifyTask(requestMissingUpdates, responseMissingUpdates);
  assert.equal(responseMissingUpdates.statusCode, 400);
  assert.equal(responseMissingUpdates.body.code, 'TASK_UPDATE_FIELDS_REQUIRED');
  assert.equal(calls.update.length, 1);
});

test('deleteTask validates identifiers and delegates to service', async () => {
  calls.delete.length = 0;

  const request = {
    body: {
      taskListId: 'list-1',
      taskId: 'task-9'
    },
    user: { microsoftId: 'sub-del' }
  };
  const response = new MockResponse();

  await deleteTask(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(calls.delete, [
    {
      sub: 'sub-del',
      taskListId: 'list-1',
      taskId: 'task-9'
    }
  ]);
});

test('deleteTask enforces identifiers', async () => {
  const request = {
    body: {
      taskListId: 'list-1'
    },
    user: { microsoftId: 'sub-del' }
  };
  const response = new MockResponse();

  await deleteTask(request, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'TASK_IDENTIFIERS_REQUIRED');
  assert.equal(calls.delete.length, 1);
});
