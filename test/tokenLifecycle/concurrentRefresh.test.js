/**
 * Test: Concurrent Token Refresh Mutex
 *
 * Critical scenario: Multiple requests arrive simultaneously with expired token
 * Expected behavior: Only ONE refresh happens (mutex protection)
 */

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

describe('Concurrent Token Refresh (Mutex Protection)', () => {
  let refreshCallCount = 0;
  let refreshDelayMs = 100; // Simulate slow Google OAuth API

  beforeEach(() => {
    refreshCallCount = 0;

    const mockUser = {
      microsoftId: 'concurrent_test_user',
      email: 'concurrent@example.com',
      accessToken: 'expired_token',
      refreshToken: 'refresh_token_123',
      tokenExpiry: new Date(Date.now() - 1000) // Already expired
    };

    globalThis.__facadeMocks = {
      databaseService: {
        getUserByGoogleSub: async () => mockUser,
        updateTokens: async () => ({ acknowledged: true })
      },
      oauth: {
        refreshAccessToken: async (refreshToken) => {
          refreshCallCount++;

          // Simulate network delay
          await new Promise(resolve => setTimeout(resolve, refreshDelayMs));

          return {
            access_token: `new_token_${refreshCallCount}`,
            refresh_token: refreshToken,
            expires_in: 3600
          };
        }
      }
    };
  });

  it('should prevent thundering herd with mutex', async () => {
    const { getValidAccessToken } = await import('../../src/services/microsoftGraphService.js');

    // Simulate 10 concurrent requests
    const concurrentRequests = 10;
    const promises = Array(concurrentRequests).fill(null).map(() =>
      getValidAccessToken('concurrent_test_user')
    );

    const results = await Promise.all(promises);

    // All requests should get a token
    assert.strictEqual(results.length, concurrentRequests, 'All requests completed');

    // But refresh should only be called ONCE (mutex protection)
    assert.strictEqual(
      refreshCallCount,
      1,
      `Refresh should be called only once, but was called ${refreshCallCount} times`
    );

    // All should get the same new token
    const firstToken = results[0];
    const allSame = results.every(token => token === firstToken);
    assert.ok(allSame, 'All concurrent requests should get same token');
  });

  it('should release mutex after refresh completes', async () => {
    const { getValidAccessToken } = await import('../../src/services/microsoftGraphService.js');

    // First batch of concurrent requests
    const batch1 = Array(5).fill(null).map(() =>
      getValidAccessToken('concurrent_test_user')
    );

    await Promise.all(batch1);
    const firstBatchCount = refreshCallCount;

    // Reset token to expired again
    globalThis.__facadeMocks.databaseService.getUserByGoogleSub = async () => ({
      microsoftId: 'concurrent_test_user',
      email: 'concurrent@example.com',
      accessToken: 'expired_again',
      refreshToken: 'refresh_token_123',
      tokenExpiry: new Date(Date.now() - 1000)
    });

    // Second batch should trigger another refresh
    const batch2 = Array(5).fill(null).map(() =>
      getValidAccessToken('concurrent_test_user')
    );

    await Promise.all(batch2);

    // Should have refreshed twice total (once per batch)
    assert.strictEqual(
      refreshCallCount,
      2,
      'Mutex should be released, allowing second refresh'
    );
  });

  it('should handle refresh failure for all waiting requests', async () => {
    globalThis.__facadeMocks.oauth.refreshAccessToken = async () => {
      refreshCallCount++;
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate refresh failure
      const error = new Error('Refresh failed');
      error.response = { status: 500 };
      throw error;
    };

    const { getValidAccessToken } = await import('../../src/services/microsoftGraphService.js');

    const promises = Array(5).fill(null).map(() =>
      getValidAccessToken('concurrent_test_user')
    );

    // All should reject
    const results = await Promise.allSettled(promises);

    const allRejected = results.every(r => r.status === 'rejected');
    assert.ok(allRejected, 'All concurrent requests should fail if refresh fails');

    // But refresh should still only be called once
    assert.strictEqual(refreshCallCount, 1, 'Refresh called once despite multiple waiters');
  });
});
