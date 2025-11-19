import crypto from 'crypto';
import { getDatabase } from '../config/database.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { summarizeSecret } from '../utils/redact.js';
import { throwServiceError } from './serviceErrors.js';

const HASH_SECRET = process.env.ACCESS_TOKEN_HASH_SECRET || process.env.ENCRYPTION_KEY;

if (!HASH_SECRET) {
  console.error('❌ ACCESS_TOKEN_HASH_SECRET (or ENCRYPTION_KEY fallback) must be configured');
  process.exit(1);
}

const CACHE_COLLECTION = process.env.ACCESS_TOKEN_CACHE_COLLECTION || 'access_token_identity_cache';
const CACHE_TTL_SECONDS = parseInt(process.env.ACCESS_TOKEN_CACHE_TTL_SECONDS || '900', 10);
const CACHE_MIN_TTL_MS = parseInt(process.env.ACCESS_TOKEN_CACHE_MIN_TTL_MS || '60000', 10);
const CACHE_EXPIRY_BUFFER_MS = parseInt(process.env.ACCESS_TOKEN_CACHE_EXPIRY_BUFFER_MS || '120000', 10);
const HASH_ALGORITHM = 'sha256';

let indexesEnsured = false;

async function ensureIndexes() {
  if (indexesEnsured) {
    return;
  }

  const db = await getDatabase();
  const collection = db.collection(CACHE_COLLECTION);

  await Promise.all([
    collection.createIndex({ token_hash: 1 }, { unique: true, name: 'token_hash_unique' }).catch(error => {
      if (error.codeName !== 'IndexOptionsConflict') {
        throw error;
      }
    }),
    collection.createIndex({ microsoft_id: 1 }, { name: 'microsoft_id_idx' }).catch(error => {
      if (error.codeName !== 'IndexOptionsConflict') {
        throw error;
      }
    }),
    collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'expires_at_ttl' }).catch(error => {
      if (error.codeName !== 'IndexOptionsConflict') {
        throw error;
      }
    })
  ]);

  indexesEnsured = true;
}

function hashAccessToken(token) {
  return crypto.createHmac(HASH_ALGORITHM, HASH_SECRET).update(token).digest('hex');
}

function computeExpiresAt(expiryDate) {
  const now = Date.now();
  const fallbackTtl = Math.max(CACHE_TTL_SECONDS * 1000, CACHE_MIN_TTL_MS);
  let ttlMs = fallbackTtl;

  if (expiryDate) {
    const expiryTime = new Date(expiryDate).getTime();

    if (!Number.isNaN(expiryTime)) {
      const bufferedExpiry = expiryTime - CACHE_EXPIRY_BUFFER_MS;

      if (bufferedExpiry > now) {
        ttlMs = Math.max(bufferedExpiry - now, CACHE_MIN_TTL_MS);
      } else {
        ttlMs = CACHE_MIN_TTL_MS;
      }
    }
  }

  return new Date(now + ttlMs);
}

async function cacheAccessTokenIdentity({ accessToken, microsoftId, email = null, expiryDate = null, source = 'unknown' }) {
  if (!accessToken || !microsoftId) {
    throwServiceError('accessToken and microsoftId are required to cache identity', {
      statusCode: 400,
      code: 'ACCESS_TOKEN_CACHE_PARAMS_MISSING',
      details: {
        missing: [
          ...(!accessToken ? ['accessToken'] : []),
          ...(!microsoftId ? ['microsoftId'] : [])
        ]
      }
    });
  }

  await ensureIndexes();

  const db = await getDatabase();
  const collection = db.collection(CACHE_COLLECTION);
  const tokenHash = hashAccessToken(accessToken);
  const now = new Date();
  const expiresAt = computeExpiresAt(expiryDate);

  await collection.updateOne(
    { token_hash: tokenHash },
    {
      $set: {
        token_hash: tokenHash,
        microsoft_id: microsoftId,
        email: email || null,
        expires_at: expiresAt,
        last_seen_at: now,
        source
      },
      $setOnInsert: {
        created_at: now
      }
    },
    { upsert: true }
  );

  console.log('✅ Cached identity for access token', {
    microsoftId,
    email,
    source,
    tokenHash: summarizeSecret(tokenHash)
  });

  return { microsoftId, email };
}

async function getCachedIdentityForAccessToken(accessToken) {
  if (!accessToken) {
    return null;
  }

  await ensureIndexes();

  const db = await getDatabase();
  const collection = db.collection(CACHE_COLLECTION);
  const tokenHash = hashAccessToken(accessToken);
  const doc = await collection.findOne({ token_hash: tokenHash });

  if (!doc) {
    return null;
  }

  if (doc.expires_at && doc.expires_at <= new Date()) {
    await collection.deleteOne({ _id: doc._id }).catch(() => {});
    return null;
  }

  await collection.updateOne(
    { _id: doc._id },
    { $set: { last_seen_at: new Date() } }
  );

  return {
    microsoftId: doc.microsoft_id,
    email: doc.email || null
  };
}

async function invalidateCachedIdentity(accessToken) {
  if (!accessToken) {
    return;
  }

  await ensureIndexes();

  const db = await getDatabase();
  const collection = db.collection(CACHE_COLLECTION);
  const tokenHash = hashAccessToken(accessToken);

  await collection.deleteOne({ token_hash: tokenHash });

  console.log('🧹 Invalidated cached identity for token', summarizeSecret(tokenHash));
}

async function purgeIdentitiesForMicrosoftId(microsoftId) {
  await ensureIndexes();

  const db = await getDatabase();
  const collection = db.collection(CACHE_COLLECTION);

  const result = await collection.deleteMany({ microsoft_id: microsoftId });

  if (result.deletedCount > 0) {
    console.log(`🧹 Removed ${result.deletedCount} cached access token identities for ${microsoftId}`);
  }
}

const traced = wrapModuleFunctions('services.tokenIdentityService', {
  cacheAccessTokenIdentity,
  getCachedIdentityForAccessToken,
  invalidateCachedIdentity,
  purgeIdentitiesForMicrosoftId,
});

const {
  cacheAccessTokenIdentity: tracedCacheAccessTokenIdentity,
  getCachedIdentityForAccessToken: tracedGetCachedIdentityForAccessToken,
  invalidateCachedIdentity: tracedInvalidateCachedIdentity,
  purgeIdentitiesForMicrosoftId: tracedPurgeIdentitiesForMicrosoftId,
} = traced;

export {
  tracedCacheAccessTokenIdentity as cacheAccessTokenIdentity,
  tracedGetCachedIdentityForAccessToken as getCachedIdentityForAccessToken,
  tracedInvalidateCachedIdentity as invalidateCachedIdentity,
  tracedPurgeIdentitiesForMicrosoftId as purgeIdentitiesForMicrosoftId,
};
