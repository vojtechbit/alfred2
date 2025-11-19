/**
 * Microsoft Graph API Retry Utility
 *
 * Implements retry logic with exponential backoff for handling:
 * - Rate limiting (HTTP 429)
 * - Service unavailability (HTTP 503, 504)
 * - Transient errors
 *
 * Respects Retry-After header and implements exponential backoff with jitter.
 *
 * @module graphRetry
 */

/**
 * Sleep for specified milliseconds
 * @private
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Default retry configuration
 */
const DEFAULT_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 32000, // 32 seconds
  jitterMax: 1000, // Max random jitter: 1 second
  retryableStatusCodes: [429, 503, 504],
  retryableErrorCodes: [
    'TooManyRequests',
    'ServiceUnavailable',
    'GatewayTimeout',
    'InternalServerError'
  ]
};

/**
 * Checks if error is retryable
 *
 * @private
 * @param {Error} error - Error object
 * @param {number[]} retryableStatusCodes - Status codes to retry
 * @param {string[]} retryableErrorCodes - Error codes to retry
 * @returns {boolean} True if error should be retried
 */
function isRetryableError(error, retryableStatusCodes, retryableErrorCodes) {
  // Check HTTP status code
  if (error.statusCode && retryableStatusCodes.includes(error.statusCode)) {
    return true;
  }

  // Check Microsoft Graph error code
  if (error.code && retryableErrorCodes.includes(error.code)) {
    return true;
  }

  // Check nested error code (Microsoft Graph format)
  if (error.body?.error?.code && retryableErrorCodes.includes(error.body.error.code)) {
    return true;
  }

  return false;
}

/**
 * Extracts Retry-After value from error response
 *
 * @private
 * @param {Error} error - Error object
 * @returns {number|null} Retry-After value in seconds, or null if not found
 */
function getRetryAfterSeconds(error) {
  // Try to get Retry-After from headers
  const retryAfter = error.headers?.['retry-after'] || error.response?.headers?.['retry-after'];

  if (!retryAfter) {
    return null;
  }

  // Retry-After can be either seconds or HTTP date
  const retryAfterNum = parseInt(retryAfter, 10);

  if (!isNaN(retryAfterNum)) {
    // It's a number of seconds
    return retryAfterNum;
  }

  // It's an HTTP date - calculate seconds until that time
  const retryAfterDate = new Date(retryAfter);
  if (!isNaN(retryAfterDate.getTime())) {
    const secondsUntil = Math.ceil((retryAfterDate.getTime() - Date.now()) / 1000);
    return Math.max(0, secondsUntil);
  }

  return null;
}

/**
 * Calculates delay for exponential backoff
 *
 * @private
 * @param {number} attempt - Current attempt number (1-indexed)
 * @param {number} baseDelay - Base delay in milliseconds
 * @param {number} maxDelay - Maximum delay in milliseconds
 * @param {number} jitterMax - Maximum jitter in milliseconds
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attempt, baseDelay, maxDelay, jitterMax) {
  // Exponential backoff: baseDelay * 2^(attempt-1)
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);

  // Add random jitter to avoid thundering herd
  const jitter = Math.random() * jitterMax;

  return cappedDelay + jitter;
}

/**
 * Executes a function with automatic retry logic
 *
 * Handles rate limiting (429) and transient errors (503, 504) with:
 * - Respecting Retry-After header
 * - Exponential backoff with jitter
 * - Configurable max retries
 *
 * @param {Function} apiCall - Async function to execute (should return a Promise)
 * @param {Object} [config] - Configuration options
 * @param {number} [config.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [config.baseDelay=1000] - Base delay in ms for exponential backoff
 * @param {number} [config.maxDelay=32000] - Maximum delay in ms
 * @param {number} [config.jitterMax=1000] - Maximum random jitter in ms
 * @param {number[]} [config.retryableStatusCodes] - HTTP status codes to retry
 * @param {string[]} [config.retryableErrorCodes] - Microsoft Graph error codes to retry
 * @param {Function} [config.onRetry] - Callback called before each retry (receives attempt, error, delay)
 * @returns {Promise<*>} Result of apiCall
 * @throws {Error} If all retries are exhausted or error is not retryable
 *
 * @example
 * const result = await executeWithRetry(
 *   () => graphClient.api('/me/messages').get(),
 *   { maxRetries: 5 }
 * );
 *
 * @example
 * // With custom retry callback
 * const result = await executeWithRetry(
 *   () => sendEmail(message),
 *   {
 *     maxRetries: 3,
 *     onRetry: (attempt, error, delay) => {
 *       console.log(`Retry ${attempt} after ${delay}ms due to: ${error.message}`);
 *     }
 *   }
 * );
 */
export async function executeWithRetry(apiCall, config = {}) {
  const {
    maxRetries = DEFAULT_CONFIG.maxRetries,
    baseDelay = DEFAULT_CONFIG.baseDelay,
    maxDelay = DEFAULT_CONFIG.maxDelay,
    jitterMax = DEFAULT_CONFIG.jitterMax,
    retryableStatusCodes = DEFAULT_CONFIG.retryableStatusCodes,
    retryableErrorCodes = DEFAULT_CONFIG.retryableErrorCodes,
    onRetry = null
  } = config;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      // Execute the API call
      const result = await apiCall();
      return result;

    } catch (error) {
      lastError = error;

      // Check if this is the last attempt
      if (attempt > maxRetries) {
        console.error(`❌ Max retries (${maxRetries}) exceeded`);
        throw error;
      }

      // Check if error is retryable
      if (!isRetryableError(error, retryableStatusCodes, retryableErrorCodes)) {
        console.error(`❌ Non-retryable error: ${error.message || error.code}`);
        throw error;
      }

      // Calculate delay
      let delay;
      const retryAfter = getRetryAfterSeconds(error);

      if (retryAfter !== null) {
        // Use Retry-After header (preferred)
        delay = retryAfter * 1000;
        console.log(`⏸️  Rate limited (attempt ${attempt}/${maxRetries}). Retry-After: ${retryAfter}s`);
      } else {
        // Use exponential backoff
        delay = calculateBackoffDelay(attempt, baseDelay, maxDelay, jitterMax);
        console.log(`⏸️  Retryable error (attempt ${attempt}/${maxRetries}). Exponential backoff: ${Math.round(delay)}ms`);
      }

      // Call retry callback if provided
      if (onRetry) {
        try {
          onRetry(attempt, error, delay);
        } catch (callbackError) {
          console.error('⚠️ Error in onRetry callback:', callbackError);
        }
      }

      // Log error details
      console.log(`Error details:`, {
        statusCode: error.statusCode,
        code: error.code || error.body?.error?.code,
        message: error.message || error.body?.error?.message
      });

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should never reach here, but just in case
  throw lastError;
}

/**
 * Creates a retry wrapper for Microsoft Graph Client
 *
 * Returns a wrapper object that automatically retries Graph API calls.
 *
 * @param {Object} graphClient - Microsoft Graph Client instance
 * @param {Object} [config] - Retry configuration (same as executeWithRetry)
 * @returns {Object} Wrapped client with retry logic
 *
 * @example
 * import { Client } from '@microsoft/microsoft-graph-client';
 * import { createRetryWrapper } from './utils/graphRetry.js';
 *
 * const client = Client.init({ authProvider: ... });
 * const retryClient = createRetryWrapper(client, { maxRetries: 5 });
 *
 * // All API calls will automatically retry on throttling
 * const messages = await retryClient.api('/me/messages').get();
 */
export function createRetryWrapper(graphClient, config = {}) {
  return {
    api: (url) => {
      const request = graphClient.api(url);

      // Wrap all request methods (get, post, patch, put, delete)
      const wrappedRequest = {
        // Preserve chainable methods
        select: (...args) => { request.select(...args); return wrappedRequest; },
        filter: (...args) => { request.filter(...args); return wrappedRequest; },
        search: (...args) => { request.search(...args); return wrappedRequest; },
        orderby: (...args) => { request.orderby(...args); return wrappedRequest; },
        top: (...args) => { request.top(...args); return wrappedRequest; },
        skip: (...args) => { request.skip(...args); return wrappedRequest; },
        skipToken: (...args) => { request.skipToken(...args); return wrappedRequest; },
        expand: (...args) => { request.expand(...args); return wrappedRequest; },
        header: (...args) => { request.header(...args); return wrappedRequest; },
        headers: (...args) => { request.headers(...args); return wrappedRequest; },

        // Wrap execution methods with retry logic
        get: () => executeWithRetry(() => request.get(), config),
        post: (content) => executeWithRetry(() => request.post(content), config),
        patch: (content) => executeWithRetry(() => request.patch(content), config),
        put: (content) => executeWithRetry(() => request.put(content), config),
        delete: () => executeWithRetry(() => request.delete(), config),
      };

      return wrappedRequest;
    }
  };
}

/**
 * Default export object with all utilities
 */
export default {
  executeWithRetry,
  createRetryWrapper
};
