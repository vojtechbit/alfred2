import express from 'express';
import os from 'os';
import { getUserByGoogleSub } from '../services/databaseService.js';
import { verifyToken } from '../middleware/authMiddleware.js';
import { getAdvancedDebugState } from '../utils/advancedDebugging.js';
import {
  getDebugDiagnostics as getGoogleServiceDebugDiagnostics,
  flushDebugCaches as flushGoogleServiceDebugCaches
} from '../services/googleApiService.js';
import { getSnapshotDiagnostics, clearSnapshots } from '../utils/snapshotStore.js';

const router = express.Router();

function ensureAdvancedDebugEnabled(req, res, next) {
  const state = getAdvancedDebugState();

  if (!state.enabled) {
    return res.status(403).json({
      error: 'Advanced debug tooling is disabled in this environment',
      debug: state
    });
  }

  req.advancedDebugState = state;
  return next();
}

router.use(verifyToken);
router.use(ensureAdvancedDebugEnabled);

function buildServerMetrics() {
  const memoryUsage = process.memoryUsage();

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    nodeVersion: process.versions.node,
    platform: process.platform,
    pid: process.pid,
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg().map(value => Number(value.toFixed(2))),
    memory: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external
    }
  };
}

router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    server: buildServerMetrics(),
    debug: {
      advanced: req.advancedDebugState || getAdvancedDebugState(),
      environment: {
        nodeEnv: process.env.NODE_ENV || 'development',
        advancedDebugRaw: process.env.ADVANCED_DEBUG || null
      }
    },
    caches: getGoogleServiceDebugDiagnostics(),
    snapshots: getSnapshotDiagnostics()
  });
});

router.get('/caches', (req, res) => {
  res.json({
    status: 'ok',
    caches: getGoogleServiceDebugDiagnostics(),
    snapshots: getSnapshotDiagnostics()
  });
});

router.post('/caches/flush', (req, res) => {
  const payload = req.body || {};
  const targets = Array.isArray(payload.targets)
    ? payload.targets
    : (typeof payload.targets === 'string' ? [payload.targets] : []);

  const normalizedTargets = new Set(
    targets
      .map(target => (typeof target === 'string' ? target.trim().toLowerCase() : ''))
      .filter(Boolean)
  );

  if (normalizedTargets.size === 0) {
    normalizedTargets.add('labels');
    normalizedTargets.add('addresses');
    normalizedTargets.add('snapshots');
  }

  const serviceTargets = Array.from(normalizedTargets)
    .filter(target => target === 'labels' || target === 'addresses');

  const flushResult = flushGoogleServiceDebugCaches({ targets: serviceTargets });

  let snapshotsCleared = 0;
  if (normalizedTargets.has('snapshots')) {
    snapshotsCleared = clearSnapshots();
  }

  res.json({
    status: 'ok',
    cleared: {
      ...flushResult.cleared,
      snapshots: snapshotsCleared
    },
    targets: Array.from(normalizedTargets),
    caches: getGoogleServiceDebugDiagnostics(),
    snapshots: getSnapshotDiagnostics()
  });
});

/**
 * Debug endpoint - Check token status
 * GET /api/debug/token-status
 */
router.get('/token-status', async (req, res) => {
  try {
    const user = await getUserByGoogleSub(req.user.microsoftId);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        microsoftId: req.user.microsoftId
      });
    }

    const now = new Date();
    const expiry = new Date(user.tokenExpiry);
    const timeUntilExpiry = expiry.getTime() - now.getTime();
    const isExpired = timeUntilExpiry <= 0;
    const bufferTime = 5 * 60 * 1000; // 5 minutes
    const needsRefresh = timeUntilExpiry <= bufferTime;

    res.json({
      status: 'ok',
      user: {
        email: user.email,
        microsoftId: user.microsoftId
      },
      token: {
        hasAccessToken: Boolean(user.accessToken),
        hasRefreshToken: Boolean(user.refreshToken),
        expiry: user.tokenExpiry,
        expiryDate: expiry.toISOString(),
        currentTime: now.toISOString(),
        secondsUntilExpiry: Math.floor(timeUntilExpiry / 1000),
        isExpired,
        needsRefresh: needsRefresh && !isExpired,
        status: isExpired ? '❌ EXPIRED' : needsRefresh ? '⚠️ NEEDS REFRESH' : '✅ VALID'
      },
      lastUsed: user.lastUsed,
      createdAt: user.createdAt,
      debug: {
        advanced: req.advancedDebugState || getAdvancedDebugState()
      },
      caches: getGoogleServiceDebugDiagnostics(),
      snapshots: getSnapshotDiagnostics(),
      server: buildServerMetrics()
    });

  } catch (error) {
    console.error('❌ Failed to get token status');
    console.error('Error:', {
      message: error.message,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Failed to get token status',
      message: error.message
    });
  }
});

export default router;
