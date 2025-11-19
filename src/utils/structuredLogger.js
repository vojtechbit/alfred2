/**
 * Structured Logging Utility
 *
 * Provides structured, parseable logging without external dependencies
 * Compatible with log aggregation tools (Datadog, Splunk, CloudWatch)
 */

/**
 * Log levels
 */
const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Current log level (from environment)
 */
const CURRENT_LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const LOG_LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4
};

/**
 * Check if message should be logged based on level
 */
function shouldLog(level) {
  const currentPriority = LOG_LEVEL_PRIORITY[CURRENT_LOG_LEVEL] || 1;
  const messagePriority = LOG_LEVEL_PRIORITY[level] || 1;

  return messagePriority >= currentPriority;
}

/**
 * Format log entry as JSON
 */
function formatLogEntry(level, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...context
  };

  // Add request context if available (from async context or global)
  if (globalThis.__requestContext) {
    entry.requestId = globalThis.__requestContext.requestId;
    entry.userId = globalThis.__requestContext.userId;
  }

  return JSON.stringify(entry);
}

/**
 * Structured logger class
 */
class StructuredLogger {
  constructor(moduleName = 'app') {
    this.moduleName = moduleName;
  }

  debug(message, context = {}) {
    if (!shouldLog(LogLevel.DEBUG)) return;

    console.log(formatLogEntry(LogLevel.DEBUG, message, {
      ...context,
      module: this.moduleName
    }));
  }

  info(message, context = {}) {
    if (!shouldLog(LogLevel.INFO)) return;

    console.log(formatLogEntry(LogLevel.INFO, message, {
      ...context,
      module: this.moduleName
    }));
  }

  warn(message, context = {}) {
    if (!shouldLog(LogLevel.WARN)) return;

    console.warn(formatLogEntry(LogLevel.WARN, message, {
      ...context,
      module: this.moduleName
    }));
  }

  error(message, context = {}) {
    if (!shouldLog(LogLevel.ERROR)) return;

    // Include stack trace if error object provided
    const errorContext = {
      ...context,
      module: this.moduleName
    };

    if (context.error instanceof Error) {
      errorContext.error = {
        name: context.error.name,
        message: context.error.message,
        stack: context.error.stack
      };
    }

    console.error(formatLogEntry(LogLevel.ERROR, message, errorContext));
  }

  critical(message, context = {}) {
    if (!shouldLog(LogLevel.CRITICAL)) return;

    const criticalContext = {
      ...context,
      module: this.moduleName,
      severity: 'CRITICAL'
    };

    if (context.error instanceof Error) {
      criticalContext.error = {
        name: context.error.name,
        message: context.error.message,
        stack: context.error.stack
      };
    }

    console.error(formatLogEntry(LogLevel.CRITICAL, message, criticalContext));
  }

  /**
   * Log with custom metadata
   */
  log(level, message, context = {}) {
    const logMethod = this[level.toLowerCase()];
    if (logMethod) {
      logMethod.call(this, message, context);
    } else {
      this.info(message, { ...context, originalLevel: level });
    }
  }
}

/**
 * Create logger instance for a module
 */
function createLogger(moduleName) {
  return new StructuredLogger(moduleName);
}

/**
 * Express middleware to add request context
 */
function requestContextMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();

  // Store in request
  req.requestId = requestId;

  // Add to response headers
  res.setHeader('X-Request-ID', requestId);

  // Store in global context (async-safe with AsyncLocalStorage would be better)
  globalThis.__requestContext = {
    requestId,
    userId: req.user?.microsoftId,
    path: req.path,
    method: req.method
  };

  // Cleanup after response
  res.on('finish', () => {
    delete globalThis.__requestContext;
  });

  next();
}

import crypto from 'crypto';

export {
  createLogger,
  StructuredLogger,
  LogLevel,
  requestContextMiddleware
};
