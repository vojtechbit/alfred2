import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import { getUserByMicrosoftId, updateTokens, updateLastUsed } from './databaseService.js';
import { refreshAccessToken } from '../config/microsoft.js';
import { determineExpiryDate, isTokenExpired } from '../utils/tokenExpiry.js';
import dotenv from 'dotenv';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { mapGoogleApiError, throwServiceError } from './serviceErrors.js';

dotenv.config();

/**
 * Microsoft To Do Service
 * Handles task management via Microsoft Graph To Do API
 *
 * Replaces Google Tasks with Microsoft To Do
 */

/**
 * Get valid access token (auto-refresh if expired)
 */
async function getValidAccessToken(microsoftId) {
  try {
    const user = await getUserByMicrosoftId(microsoftId);

    if (!user) {
      throwServiceError('User not found in database', {
        statusCode: 401,
        code: 'TASKS_USER_NOT_FOUND',
        requiresReauth: true
      });
    }

    updateLastUsed(microsoftId).catch(err =>
      console.error('Failed to update last_used:', err.message)
    );

    const needsRefresh = isTokenExpired(user.tokenExpiry);

    if (needsRefresh) {
      console.log('🔄 Access token expired, refreshing...');

      try {
        const newTokens = await refreshAccessToken(user.refreshToken);
        const expiryDate = determineExpiryDate(newTokens.expires_in);

        await updateTokens(microsoftId, {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token || user.refreshToken,
          expiryDate,
          email: user.email,
          source: 'refresh:tasksService'
        });

        console.log('✅ Access token refreshed successfully');
        return newTokens.access_token;
      } catch (refreshError) {
        console.error('❌ Token refresh failed - user needs to re-authenticate');
        throwServiceError('Authentication required - please log in again', {
          statusCode: 401,
          code: 'MICROSOFT_UNAUTHORIZED',
          requiresReauth: true,
          cause: refreshError
        });
      }
    }

    return user.accessToken;
  } catch (error) {
    console.error('❌ [TOKEN_ERROR] Failed to get valid access token');
    console.error('Details:', {
      microsoftId,
      errorMessage: error.message,
      errorCode: error.code,
      timestamp: new Date().toISOString()
    });
    throw mapGoogleApiError(error, {
      message: 'Failed to get valid access token',
      details: { microsoftId },
      cause: error
    });
  }
}

/**
 * Get authenticated Microsoft Graph client
 */
async function getGraphClient(microsoftId) {
  try {
    const accessToken = await getValidAccessToken(microsoftId);

    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });

  } catch (error) {
    console.error('❌ [TASKS_ERROR] Failed to get Graph client');
    console.error('Details:', {
      microsoftId,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw mapGoogleApiError(error, {
      message: 'Failed to get Graph client',
      details: { microsoftId },
      cause: error
    });
  }
}

/**
 * List tasks with pagination support
 * @param {string} microsoftId - User's Microsoft ID
 * @param {object} options - { tasklistId?, maxResults?, pageToken?, showCompleted? }
 * @returns {object} { items, nextPageToken }
 */
async function listTasks(microsoftId, options = {}) {
  try {
    const client = await getGraphClient(microsoftId);

    // Get task list ID (default if not provided)
    let tasklistId = options.tasklistId;

    if (!tasklistId) {
      const listResponse = await client.api('/me/todo/lists')
        .top(1)
        .get();

      const taskLists = listResponse.value || [];

      if (taskLists.length === 0) {
        return { items: [], nextPageToken: null };
      }

      tasklistId = taskLists[0].id;
    }

    // List tasks with pagination
    let request = client.api(`/me/todo/lists/${tasklistId}/tasks`)
      .top(options.maxResults || 20);

    // Filter completed tasks if needed
    if (options.showCompleted === false) {
      request = request.filter("status ne 'completed'");
    }

    if (options.pageToken) {
      request = request.skiptoken(options.pageToken);
    }

    const response = await request.get();

    const items = (response.value || []).map(task => ({
      id: task.id,
      title: task.title,
      notes: task.body?.content || '',
      due: task.dueDateTime?.dateTime || null,
      status: task.status === 'completed' ? 'completed' : 'needsAction',
      taskListId: tasklistId
    }));

    // Extract next page token from @odata.nextLink
    let nextPageToken = null;
    if (response['@odata.nextLink']) {
      try {
        const url = new URL(response['@odata.nextLink']);
        nextPageToken = url.searchParams.get('$skiptoken');
      } catch (e) {
        console.warn('Failed to extract skiptoken:', e.message);
      }
    }

    return {
      items,
      nextPageToken
    };

  } catch (error) {
    console.error('❌ [TASKS_ERROR] Failed to list tasks');
    console.error('Details:', {
      errorMessage: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString()
    });
    throw mapGoogleApiError(error, {
      message: 'Failed to list tasks',
      details: {
        microsoftId,
        tasklistId: options.tasklistId,
        maxResults: options.maxResults,
        showCompleted: options.showCompleted,
        pageToken: options.pageToken ? 'present' : undefined
      },
      cause: error
    });
  }
}

/**
 * List all tasks from all task lists (legacy - for backward compatibility)
 */
async function listAllTasks(microsoftId) {
  let taskLists = [];
  try {
    const client = await getGraphClient(microsoftId);

    // First, get all task lists
    const listResponse = await client.api('/me/todo/lists')
      .top(100)
      .get();

    taskLists = listResponse.value || [];

    if (taskLists.length === 0) {
      console.log('⚠️  No task lists found');
      return [];
    }

    // Get tasks from each list
    const allTasks = [];

    for (const taskList of taskLists) {
      try {
        const tasksResponse = await client.api(`/me/todo/lists/${taskList.id}/tasks`)
          .filter("status ne 'completed'") // Only show incomplete tasks
          .get();

        const listTasks = tasksResponse.value || [];

        // Add task list name to each task
        listTasks.forEach(task => {
          allTasks.push({
            id: task.id,
            title: task.title,
            notes: task.body?.content || '',
            due: task.dueDateTime?.dateTime || null,
            status: task.status === 'completed' ? 'completed' : 'needsAction',
            taskList: taskList.displayName,
            taskListId: taskList.id
          });
        });
      } catch (listError) {
        console.error(`⚠️  Failed to get tasks from list ${taskList.displayName}:`, listError.message);
        // Continue with other lists
      }
    }

    console.log(`✅ Found ${allTasks.length} tasks across ${taskLists.length} lists`);
    return allTasks;

  } catch (error) {
    console.error('❌ [TASKS_ERROR] Failed to list tasks');
    console.error('Details:', {
      errorMessage: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString()
    });
    throw mapGoogleApiError(error, {
      message: 'Failed to list all tasks',
      details: {
        microsoftId,
        taskListsAttempted: taskLists.map(list => list?.id).filter(Boolean),
        taskListCount: taskLists.length
      },
      cause: error
    });
  }
}

/**
 * Create a new task
 */
async function createTask(microsoftId, taskData) {
  try {
    const client = await getGraphClient(microsoftId);

    console.log('🔍 Looking for default task list...');

    // Get default task list
    const listResponse = await client.api('/me/todo/lists')
      .top(1)
      .get();

    const taskLists = listResponse.value || [];

    if (taskLists.length === 0) {
      throwServiceError('No task lists found. Please create a task list in Microsoft To Do first.', {
        statusCode: 404,
        code: 'TASK_LISTS_NOT_FOUND',
        details: { microsoftId }
      });
    }

    const defaultTaskListId = taskLists[0].id;
    console.log(`✅ Using task list: ${taskLists[0].displayName} (${defaultTaskListId})`);

    // Prepare request body
    const requestBody = {
      title: taskData.title
    };

    // Add optional fields only if provided
    if (taskData.notes) {
      requestBody.body = {
        content: taskData.notes,
        contentType: 'text'
      };
    }

    if (taskData.due) {
      // Convert due date to Microsoft format
      let dueDate = taskData.due;

      // If just date (YYYY-MM-DD), convert to ISO 8601 datetime
      if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        dueDate = `${dueDate}T00:00:00`;
      }
      // Remove Z if present (Microsoft To Do expects local time)
      else if (dueDate.endsWith('Z')) {
        dueDate = dueDate.slice(0, -1);
      }

      requestBody.dueDateTime = {
        dateTime: dueDate,
        timeZone: 'UTC'
      };
      console.log(`📅 Due date converted to Microsoft format: ${dueDate}`);
    }

    console.log('📝 Creating task with data:', requestBody);

    // Create task
    const response = await client.api(`/me/todo/lists/${defaultTaskListId}/tasks`)
      .post(requestBody);

    console.log('✅ Task created successfully:', response.id);

    return {
      id: response.id,
      title: response.title,
      notes: response.body?.content || '',
      due: response.dueDateTime?.dateTime || null,
      status: response.status === 'completed' ? 'completed' : 'needsAction',
      taskList: taskLists[0].displayName,
      taskListId: defaultTaskListId
    };

  } catch (error) {
    console.error('❌ [TASKS_ERROR] Failed to create task');
    console.error('Details:', {
      title: taskData.title,
      errorMessage: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString()
    });
    throw mapGoogleApiError(error, {
      message: 'Failed to create task',
      details: {
        microsoftId,
        title: taskData?.title
      },
      cause: error
    });
  }
}

/**
 * Update task (mark as completed or update details)
 */
async function updateTask(microsoftId, taskListId, taskId, updates) {
  try {
    const client = await getGraphClient(microsoftId);

    const requestBody = {};

    if (updates.status !== undefined) {
      // Map Google Tasks status to Microsoft To Do status
      requestBody.status = updates.status === 'completed' ? 'completed' : 'notStarted';
    }

    if (updates.title !== undefined) {
      requestBody.title = updates.title;
    }

    if (updates.notes !== undefined) {
      requestBody.body = {
        content: updates.notes,
        contentType: 'text'
      };
    }

    if (updates.due !== undefined) {
      let dueDate = updates.due;

      // Remove Z if present
      if (dueDate && dueDate.endsWith('Z')) {
        dueDate = dueDate.slice(0, -1);
      }

      if (dueDate) {
        requestBody.dueDateTime = {
          dateTime: dueDate,
          timeZone: 'UTC'
        };
      } else {
        requestBody.dueDateTime = null;
      }
    }

    console.log('📝 Updating task with data:', requestBody);

    const response = await client.api(`/me/todo/lists/${taskListId}/tasks/${taskId}`)
      .patch(requestBody);

    console.log('✅ Task updated successfully:', taskId);

    return {
      id: response.id,
      title: response.title,
      notes: response.body?.content || '',
      due: response.dueDateTime?.dateTime || null,
      status: response.status === 'completed' ? 'completed' : 'needsAction'
    };

  } catch (error) {
    console.error('❌ [TASKS_ERROR] Failed to update task');
    console.error('Details:', {
      taskId,
      taskListId,
      updates,
      errorMessage: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Delete a task
 */
async function deleteTask(microsoftId, taskListId, taskId) {
  try {
    const client = await getGraphClient(microsoftId);

    await client.api(`/me/todo/lists/${taskListId}/tasks/${taskId}`)
      .delete();

    console.log('✅ Task deleted successfully:', taskId);
    return { success: true };

  } catch (error) {
    console.error('❌ [TASKS_ERROR] Failed to delete task');
    console.error('Details:', {
      taskId,
      taskListId,
      errorMessage: error.message,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

const traced = wrapModuleFunctions('services.tasksService', {
  listTasks,
  listAllTasks,
  createTask,
  updateTask,
  deleteTask,
});

const {
  listTasks: tracedListTasks,
  listAllTasks: tracedListAllTasks,
  createTask: tracedCreateTask,
  updateTask: tracedUpdateTask,
  deleteTask: tracedDeleteTask,
} = traced;

export {
  tracedListTasks as listTasks,
  tracedListAllTasks as listAllTasks,
  tracedCreateTask as createTask,
  tracedUpdateTask as updateTask,
  tracedDeleteTask as deleteTask,
};
