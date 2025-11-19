/**
 * Test: Invalid Grant Error Handling
 *
 * Critical scenario: User changes Google password → refresh token revoked
 * Expected behavior: Mark user for re-auth, stop background refresh
 */

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

describe('Invalid Grant Error Handling (Token Revocation)', () => {
  let mockDb;
  let updateCalls = [];

  beforeEach(() => {
    updateCalls = [];

    mockDb = {
      collection: (name) => {
        if (name === 'users') {
          return {
            updateOne: async (filter, update) => {
              updateCalls.push({ filter, update });
              return { modifiedCount: 1 };
            },
            findOne: async ({ microsoft_id }) => ({
              microsoft_id,
              email: 'test@example.com',
              encrypted_refresh_token: 'encrypted_xxx',
              refresh_token_iv: 'iv_xxx',
              refresh_token_auth_tag: 'tag_xxx',
              token_expiry: new Date(Date.now() - 1000), // Expired
              refresh_token_revoked: false
            })
          };
        }
      }
    };

    // Mock database service
    globalThis.__facadeMocks = {
      database: mockDb,
      databaseService: {
        getUserByGoogleSub: async (microsoftId) => ({
          microsoftId,
          email: 'test@example.com',
          refreshToken: 'refresh_token_that_will_fail',
          tokenExpiry: new Date(Date.now() - 1000)
        })
      },
      oauth: {
        refreshAccessToken: async () => {
          // Simulate Google returning invalid_grant error
          const error = new Error('invalid_grant');
          error.response = {
            status: 400,
            data: { error: 'invalid_grant' }
          };
          throw error;
        }
      }
    };
  });

  afterEach(() => {
    delete globalThis.__facadeMocks;
  });

  it('should mark refresh_token_revoked = true on invalid_grant', async () => {
    // Import after mock setup
    const { refreshSingleUser } = await import('../../src/services/backgroundRefreshService.js');

    const rawUserDoc = {
      microsoft_id: 'test_user_123',
      email: 'test@example.com',
      refresh_token_revoked: false
    };

    const result = await refreshSingleUser(rawUserDoc);

    // Verify result
    assert.strictEqual(result.status, 'failed', 'Refresh should fail');
    assert.strictEqual(result.errorCode, 'invalid_grant', 'Error code should be invalid_grant');

    // Verify database update
    const revokedUpdate = updateCalls.find(call =>
      call.update.$set?.refresh_token_revoked === true
    );

    assert.ok(revokedUpdate, 'Should mark refresh_token_revoked = true');
    assert.strictEqual(
      revokedUpdate.filter.microsoft_id,
      'test_user_123',
      'Should update correct user'
    );
  });

  it('should store refresh_error metadata with timestamp', async () => {
    const { refreshSingleUser } = await import('../../src/services/backgroundRefreshService.js');

    const rawUserDoc = {
      microsoft_id: 'test_user_456',
      email: 'test2@example.com',
      refresh_token_revoked: false
    };

    await refreshSingleUser(rawUserDoc);

    // Find update with refresh_error
    const errorUpdate = updateCalls.find(call =>
      call.update.$set?.refresh_error
    );

    assert.ok(errorUpdate, 'Should store refresh_error');

    const errorInfo = errorUpdate.update.$set.refresh_error;
    assert.strictEqual(errorInfo.errorCode, 'invalid_grant', 'Error code stored');
    assert.ok(errorInfo.at instanceof Date, 'Timestamp stored');
    assert.strictEqual(errorInfo.status, 400, 'HTTP status stored');
  });

  it('should skip users already marked as revoked', async () => {
    const { refreshSingleUser } = await import('../../src/services/backgroundRefreshService.js');

    const rawUserDoc = {
      microsoft_id: 'already_revoked_user',
      email: 'revoked@example.com',
      refresh_token_revoked: true // Already marked
    };

    const result = await refreshSingleUser(rawUserDoc);

    assert.strictEqual(result.status, 'skipped', 'Should skip');
    assert.strictEqual(result.reason, 'refresh_token_revoked', 'Correct skip reason');

    // No database updates should happen
    assert.strictEqual(updateCalls.length, 0, 'No DB updates for skipped user');
  });
});
