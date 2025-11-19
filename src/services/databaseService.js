import { getDatabase } from '../config/database.js';
import { encryptToken, decryptToken } from './tokenService.js';
import {
  cacheAccessTokenIdentity,
  purgeIdentitiesForMicrosoftId
} from './tokenIdentityService.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';

/**
 * Retry wrapper for database operations
 */
async function withDbRetry(operation, operationName = 'db operation', maxAttempts = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation();
      return result;
    } catch (error) {
      lastError = error;
      
      if (
        error.message?.includes('collection') || 
        error.message?.includes('not a function') ||
        error.message?.includes('not initialized')
      ) {
        if (attempt < maxAttempts) {
          console.warn(`⏳ ${operationName} attempt ${attempt}/${maxAttempts} failed, retrying in 300ms...`);
          await new Promise(resolve => setTimeout(resolve, 300));
          continue;
        }
      }
      
      console.error(`[ERROR] ${operationName} all attempts failed. Final error:`, error.message);
      throw error;
    }
  }
  
  throw lastError;
}

/**
 * Save or update user with encrypted tokens
 */
async function saveUser(userData) {
  try {
    const result = await withDbRetry(async () => {
      const db = await getDatabase();
      const users = db.collection('users');

    const { microsoftId, email, accessToken, refreshToken, expiryDate } = userData;

    const encryptedAccess = encryptToken(accessToken);
    const encryptedRefresh = encryptToken(refreshToken);

    const userDoc = {
      microsoft_id: microsoftId,
      email: email,
      encrypted_access_token: encryptedAccess.encryptedToken,
      access_token_iv: encryptedAccess.iv,
      access_token_auth_tag: encryptedAccess.authTag,
      encrypted_refresh_token: encryptedRefresh.encryptedToken,
      refresh_token_iv: encryptedRefresh.iv,
      refresh_token_auth_tag: encryptedRefresh.authTag,
      token_expiry: expiryDate,
      updated_at: new Date(),
      last_used: new Date(),
      refresh_token_revoked: false
    };

      return await users.updateOne(
        { microsoft_id: microsoftId },
        {
          $set: userDoc,
          $setOnInsert: { created_at: new Date() },
          $unset: { refresh_error: '' }
        },
        { upsert: true }
      );
    }, 'saveUser');

    try {
      await cacheAccessTokenIdentity({
        accessToken,
        microsoftId,
        email,
        expiryDate,
        source: 'saveUser'
      });
    } catch (cacheError) {
      console.warn('⚠️  Failed to cache initial access token identity:', cacheError.message);
    }

    console.log('✅ User saved to database:', userData.email);
    return result;
  } catch (error) {
    console.error('❌ [DATABASE_ERROR] Failed to save user');
    console.error('Details:', {
      email: userData.email,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Get user by Google Sub (user ID)
 */
async function getUserByMicrosoftId(microsoftId) {
  try {
    const user = await withDbRetry(async () => {
      const db = await getDatabase();
      const users = db.collection('users');
      return await users.findOne({ microsoft_id: microsoftId });
    }, 'getUserByMicrosoftId');

    if (!user) {
      console.log('⚠️  User not found:', microsoftId);
      return null;
    }

    try {
      const accessToken = decryptToken(
        user.encrypted_access_token,
        user.access_token_iv,
        user.access_token_auth_tag
      );

      const refreshToken = decryptToken(
        user.encrypted_refresh_token,
        user.refresh_token_iv,
        user.refresh_token_auth_tag
      );

      return {
        microsoftId: user.microsoft_id,
        email: user.email,
        accessToken,
        refreshToken,
        tokenExpiry: user.token_expiry,
        createdAt: user.created_at,
        lastUsed: user.last_used,
        refreshTokenRevoked: user.refresh_token_revoked || false
      };
    } catch (decryptError) {
      console.error('❌ Token decryption failed:', decryptError.message);
      throw decryptError;
    }
  } catch (error) {
    console.error('❌ [DATABASE_ERROR] Failed to get user');
    console.error('Details:', {
      microsoftId,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Update user tokens after refresh
 */
async function updateTokens(microsoftId, tokens) {
  try {
    await withDbRetry(async () => {
      const db = await getDatabase();
      const users = db.collection('users');

      const encryptedAccess = encryptToken(tokens.accessToken);

      const updateDoc = {
        encrypted_access_token: encryptedAccess.encryptedToken,
        access_token_iv: encryptedAccess.iv,
        access_token_auth_tag: encryptedAccess.authTag,
        token_expiry: tokens.expiryDate,
        updated_at: new Date(),
        last_used: new Date(),
        refresh_token_revoked: false
      };

      if (tokens.refreshToken) {
        const encryptedRefresh = encryptToken(tokens.refreshToken);
        updateDoc.encrypted_refresh_token = encryptedRefresh.encryptedToken;
        updateDoc.refresh_token_iv = encryptedRefresh.iv;
        updateDoc.refresh_token_auth_tag = encryptedRefresh.authTag;
      }

      return await users.updateOne(
        { microsoft_id: microsoftId },
        {
          $set: updateDoc,
          $unset: { refresh_error: '' }
        }
      );
    }, 'updateTokens');

    let cacheEmail = tokens.email || null;

    if (!cacheEmail) {
      try {
        const db = await getDatabase();
        const userDoc = await db.collection('users').findOne(
          { microsoft_id: microsoftId },
          { projection: { email: 1 } }
        );
        cacheEmail = userDoc?.email || null;
      } catch (lookupError) {
        console.warn('⚠️  Failed to resolve email for cached identity:', lookupError.message);
      }
    }

    try {
      await cacheAccessTokenIdentity({
        accessToken: tokens.accessToken,
        microsoftId,
        email: cacheEmail,
        expiryDate: tokens.expiryDate,
        source: tokens.source || 'updateTokens'
      });
    } catch (cacheError) {
      console.warn('⚠️  Failed to cache refreshed access token identity:', cacheError.message);
    }

    console.log('✅ Tokens updated for user:', microsoftId);
  } catch (error) {
    console.error('❌ [DATABASE_ERROR] Failed to update tokens');
    console.error('Details:', {
      microsoftId,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Delete user (GDPR compliance)
 */
async function deleteUser(microsoftId) {
  try {
    const result = await withDbRetry(async () => {
      const db = await getDatabase();
      const users = db.collection('users');
      return await users.deleteOne({ microsoft_id: microsoftId });
    }, 'deleteUser');

    try {
      await purgeIdentitiesForMicrosoftId(microsoftId);
    } catch (purgeError) {
      console.warn('⚠️  Failed to purge cached token identities for user:', purgeError.message);
    }

    if (result.deletedCount > 0) {
      console.log('✅ User deleted:', microsoftId);
    } else {
      console.log('⚠️  User not found for deletion:', microsoftId);
    }

    return result;
  } catch (error) {
    console.error('❌ [DATABASE_ERROR] Failed to delete user');
    console.error('Details:', {
      microsoftId,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Update last used timestamp
 */
async function updateLastUsed(microsoftId) {
  try {
    await withDbRetry(async () => {
      const db = await getDatabase();
      const users = db.collection('users');
      return await users.updateOne(
        { microsoft_id: microsoftId },
        { $set: { last_used: new Date() } }
      );
    }, 'updateLastUsed', 2); // Only 2 attempts for this non-critical operation
  } catch (error) {
    console.error('⚠️  Failed to update last_used:', error.message);
  }
}

const traced = wrapModuleFunctions('services.databaseService', {
  saveUser,
  getUserByMicrosoftId,
  updateTokens,
  deleteUser,
  updateLastUsed,
});

const {
  saveUser: tracedSaveUser,
  getUserByMicrosoftId: tracedGetUserByMicrosoftId,
  updateTokens: tracedUpdateTokens,
  deleteUser: tracedDeleteUser,
  updateLastUsed: tracedUpdateLastUsed,
} = traced;

export {
  tracedSaveUser as saveUser,
  tracedGetUserByMicrosoftId as getUserByMicrosoftId,
  tracedUpdateTokens as updateTokens,
  tracedDeleteUser as deleteUser,
  tracedUpdateLastUsed as updateLastUsed,
};
