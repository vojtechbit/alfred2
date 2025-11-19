import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const serverModulePath = new URL('../src/server.js', import.meta.url).href;
const advancedDebuggingModulePath = new URL('../src/utils/advancedDebugging.js', import.meta.url).href;
const tasksServiceModulePath = new URL('../src/services/tasksService.js', import.meta.url).href;
const errorsModulePath = new URL('../src/utils/errors.js', import.meta.url).href;

test('tasks.createTask responds with JSON payloads over HTTP', async () => {
  const { ApiError } = await import(errorsModulePath);

  mock.module(serverModulePath, {
    namedExports: {
      heavyLimiter: (req, res, next) => next()
    }
  });

  mock.module(advancedDebuggingModulePath, {
    namedExports: {
      wrapModuleFunctions: (label, fns) => fns
    }
  });

  const createTaskMock = mock.fn(async (microsoftId, payload) => {
    if (payload.title === 'Fail from service') {
      throw new ApiError('Service temporarily unavailable', {
        statusCode: 503,
        code: 'TASK_CREATE_FAILED',
        details: { retryAfter: 30 }
      });
    }

    return {
      id: 'task-42',
      ...payload
    };
  });

  mock.module(tasksServiceModulePath, {
    namedExports: {
      createTask: createTaskMock
    }
  });

  const { createTask } = await import(new URL('../src/controllers/tasksController.js', import.meta.url).href);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { microsoftId: 'user-123' };
    next();
  });
  app.post('/api/tasks', createTask);

  const server = app.listen(0);

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const successResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Integration task', notes: 'verify response' })
    });

    assert.equal(successResponse.status, 200);
    const successBody = await successResponse.json();
    assert.deepEqual(successBody, {
      success: true,
      message: 'Task created successfully',
      task: {
        id: 'task-42',
        title: 'Integration task',
        notes: 'verify response'
      }
    });

    const failureResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fail from service' })
    });

    assert.equal(failureResponse.status, 503);
    const failureBody = await failureResponse.json();
    assert.equal(failureBody.error, 'Service Unavailable');
    assert.equal(failureBody.code, 'TASK_CREATE_FAILED');
    assert.deepEqual(failureBody.details, { retryAfter: 30 });
    assert.equal(failureBody.message, 'Task creation failed');

    assert.equal(createTaskMock.mock.calls.length, 2);
    assert.equal(createTaskMock.mock.calls[0].arguments[0], 'user-123');
    assert.deepEqual(createTaskMock.mock.calls[0].arguments[1], {
      title: 'Integration task',
      notes: 'verify response',
      due: undefined
    });
  } finally {
    server.close();
  }
});
