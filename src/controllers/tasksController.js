import * as tasksService from '../services/tasksService.js';
import { heavyLimiter } from '../server.js';
import { computeETag, checkETagMatch } from '../utils/helpers.js';
import { createSnapshot, getSnapshot } from '../utils/snapshotStore.js';
import { handleControllerError } from '../utils/errors.js';
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  AGGREGATE_CAP_TASKS
} from '../config/limits.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


/**
 * Tasks Controller
 * Manages Google Tasks with aggregate + snapshot support
 */

/**
 * List tasks
 * GET /api/tasks?maxResults=10&pageToken=...&aggregate=true&snapshotToken=...&ignoreSnapshot=true
 * 
 * Features:
 * - Pagination with nextPageToken (Google Tasks API native)
 * - aggregate=true: paginate internally until AGGREGATE_CAP_TASKS
 * - snapshotToken: stable iteration with TTL ~2 min
 * - ignoreSnapshot=true: force fresh data even with snapshot
 * - ETag support for caching
 */
async function listTasks(req, res) {
  const runList = async (req, res) => {
    try {
      let {
        maxResults,
        pageToken,
        aggregate,
        snapshotToken,
        ignoreSnapshot,
        showCompleted
      } = req.query;

      // Handle snapshot token
      let snapshot = null;
      if (snapshotToken && ignoreSnapshot !== 'true') {
        snapshot = getSnapshot(snapshotToken);
        if (!snapshot) {
          return res.status(400).json({
            error: 'Invalid or expired snapshot token',
            message: 'Please start a new query'
          });
        }
      }

      const aggregateMode = aggregate === 'true';

      console.log(`📋 Listing tasks (aggregate: ${aggregateMode}, snapshot: ${!!snapshot})`);

      if (aggregateMode) {
        // Aggregate mode: paginate internally
        let allItems = [];
        let currentPageToken = pageToken;
        let pagesConsumed = 0;
        let hasMore = false;
        let partial = false;
        let truncated = false;

        while (true) {
          const result = await tasksService.listTasks(req.user.microsoftId, {
            maxResults: PAGE_SIZE_DEFAULT,
            pageToken: currentPageToken,
            showCompleted: showCompleted === 'true'
          });

          const items = result.items || [];
          allItems = allItems.concat(items);
          pagesConsumed++;

          const nextPageToken = result.nextPageToken;
          const hasNextPage = Boolean(nextPageToken);
          const exceededCap = allItems.length > AGGREGATE_CAP_TASKS;
          const reachedCap = allItems.length >= AGGREGATE_CAP_TASKS;

          // Check if we hit the cap
          if (reachedCap) {
            const hasAdditionalResults = hasNextPage;
            if (exceededCap) {
              allItems = allItems.slice(0, AGGREGATE_CAP_TASKS);
              truncated = true;
            }
            hasMore = hasAdditionalResults;
            partial = hasAdditionalResults;
            truncated = truncated || hasAdditionalResults;
            break;
          }

          // Check if there are more pages
          if (hasNextPage) {
            currentPageToken = nextPageToken;
          } else {
            hasMore = false;
            break;
          }
        }

        // Create snapshot token
        const newSnapshotToken = createSnapshot(
          JSON.stringify({ showCompleted }),
          { aggregate: true }
        );

        const response = {
          success: true,
          items: allItems,
          totalExact: allItems.length,
          pagesConsumed,
          hasMore,
          partial,
          truncated,
          snapshotToken: newSnapshotToken
        };

        // ETag support
        const etag = computeETag(response);
        if (checkETagMatch(req.headers['if-none-match'], etag)) {
          return res.status(304).end();
        }

        res.setHeader('ETag', etag);
        return res.json(response);

      } else {
        // Normal mode: single page
        const pageSize = Math.min(
          parseInt(maxResults) || PAGE_SIZE_DEFAULT,
          PAGE_SIZE_MAX
        );

        const result = await tasksService.listTasks(req.user.microsoftId, {
          maxResults: pageSize,
          pageToken,
          showCompleted: showCompleted === 'true'
        });

        const items = result.items || [];
        const hasMore = !!result.nextPageToken;
        const nextPageToken = result.nextPageToken;

        const response = {
          success: true,
          items,
          hasMore,
          nextPageToken
        };

        // ETag support
        const etag = computeETag(response);
        if (checkETagMatch(req.headers['if-none-match'], etag)) {
          return res.status(304).end();
        }

        res.setHeader('ETag', etag);
        return res.json(response);
      }

    } catch (error) {
      return handleControllerError(res, error, {
        context: 'tasks.listTasks',
        defaultMessage: 'Tasks list failed',
        defaultCode: 'TASKS_LIST_FAILED'
      });
    }
  };

  // Apply heavy limiter if aggregate mode
  if (req.query.aggregate === 'true') {
    heavyLimiter(req, res, () => runList(req, res));
  } else {
    runList(req, res);
  }
}

/**
 * Create new task
 * POST /api/tasks
 * Body: { title, notes?, due? }
 * Header: Idempotency-Key (optional)
 */
async function createTask(req, res) {
  try {
    const { title, notes, due } = req.body;

    if (!title) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required field: title'
      });
    }

    console.log(`➕ Creating task: ${title}`);

    const task = await tasksService.createTask(req.user.microsoftId, {
      title,
      notes,
      due
    });

    res.json({
      success: true,
      message: 'Task created successfully',
      task: task
    });

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'tasks.createTask',
      defaultMessage: 'Task creation failed',
      defaultCode: 'TASK_CREATE_FAILED'
    });
  }
}

/**
 * Update task (mark as completed or modify)
 * PATCH /api/tasks/:taskListId/:taskId
 * Body: { status?, title?, notes?, due? }
 * Header: Idempotency-Key (optional)
 */
async function updateTask(req, res) {
  try {
    const { taskListId, taskId } = req.params;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No update fields provided'
      });
    }

    console.log(`✏️  Updating task ${taskId} in list ${taskListId}`);

    const task = await tasksService.updateTask(
      req.user.microsoftId,
      taskListId,
      taskId,
      updates
    );

    res.json({
      success: true,
      message: 'Task updated successfully',
      task: task
    });

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'tasks.updateTask',
      defaultMessage: 'Task update failed',
      defaultCode: 'TASK_UPDATE_FAILED'
    });
  }
}

/**
 * Delete task
 * DELETE /api/tasks/:taskListId/:taskId
 * Header: Idempotency-Key (optional)
 */
async function deleteTask(req, res) {
  try {
    const { taskListId, taskId } = req.params;

    console.log(`🗑️  Deleting task ${taskId} from list ${taskListId}`);

    await tasksService.deleteTask(req.user.microsoftId, taskListId, taskId);

    res.json({
      success: true,
      message: 'Task deleted successfully'
    });

  } catch (error) {
    return handleControllerError(res, error, {
      context: 'tasks.deleteTask',
      defaultMessage: 'Task deletion failed',
      defaultCode: 'TASK_DELETE_FAILED'
    });
  }
}

const traced = wrapModuleFunctions('controllers.tasksController', {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
});

const {
  listTasks: tracedListTasks,
  createTask: tracedCreateTask,
  updateTask: tracedUpdateTask,
  deleteTask: tracedDeleteTask,
} = traced;

export {
  tracedListTasks as listTasks,
  tracedCreateTask as createTask,
  tracedUpdateTask as updateTask,
  tracedDeleteTask as deleteTask,
};
