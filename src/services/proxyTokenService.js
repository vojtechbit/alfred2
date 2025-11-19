import crypto from 'crypto';
import { getDatabase } from '../config/database.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { summarizeSecret } from '../utils/redact.js';

const primarySecret = process.env.PROXY_TOKEN_SECRET || process.env.ENCRYPTION_KEY;

if (!primarySecret) {
  console.error('❌ PROXY_TOKEN_SECRET (or ENCRYPTION_KEY fallback) must be configured');
  process.exit(1);
}

const additionalSecrets = (process.env.PROXY_TOKEN_ADDITIONAL_SECRETS || '')
  .split(',')
  .map(secret => secret.trim())
  .filter(Boolean);

function secretToBuffer(secret, label) {
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    return Buffer.from(secret, 'hex');
  }

  if (secret.length < 16) {
    console.warn(`⚠️  Proxy token secret "${label}" is short; consider using a 32-byte hex string.`);
  }

  return Buffer.from(secret, 'utf8');
}

const proxyTokenSecrets = [primarySecret, ...additionalSecrets].map((secret, index) => ({
  id: index === 0 ? 'primary' : `fallback_${index}`,
  buffer: secretToBuffer(secret, index === 0 ? 'primary' : `fallback_${index}`)
}));

const HASH_ALGORITHM = 'sha512';

function hashProxyToken(token, secretBuffer) {
  return crypto.createHmac(HASH_ALGORITHM, secretBuffer).update(token).digest('hex');
}

function buildHashCandidates(token) {
  return proxyTokenSecrets.map(secret => ({
    hash: hashProxyToken(token, secret.buffer),
    secretId: secret.id
  }));
}

/**
 * Generate random authorization code for ChatGPT OAuth flow
 * Single use, expires in 10 minutes
 */
function generateAuthCode() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate random proxy token for ChatGPT API calls
 * Long-lived, used for all subsequent requests
 */
function generateProxyToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Save authorization code to database
 * Used during OAuth flow to exchange for access token
 */
async function saveAuthCode({ authCode, microsoftId, state, chatgptRedirectUri }) {
  try {
    const db = await getDatabase();
    const oauthFlows = db.collection('oauth_flows');

    const authFlow = {
      auth_code: authCode,
      microsoft_id: microsoftId,
      state: state,
      chatgpt_redirect_uri: chatgptRedirectUri,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      used: false
    };

    await oauthFlows.insertOne(authFlow);

    console.log('✅ Auth code saved:', summarizeSecret(authCode));
    return authCode;
  } catch (error) {
    console.error('❌ [PROXY_TOKEN_ERROR] Failed to save auth code');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Validate and consume authorization code
 * Returns auth flow details if valid, null if invalid/expired/used
 */
async function validateAndConsumeAuthCode(authCode) {
  try {
    const db = await getDatabase();
    const oauthFlows = db.collection('oauth_flows');

    const authFlow = await oauthFlows.findOne({ auth_code: authCode });

    if (!authFlow) {
      console.log('⚠️  Auth code not found:', summarizeSecret(authCode));
      return null;
    }

    // Check if already used
    if (authFlow.used) {
      console.log('⚠️  Auth code already used:', summarizeSecret(authCode));
      return null;
    }

    // Check if expired
    if (new Date() > authFlow.expires_at) {
      console.log('⚠️  Auth code expired:', summarizeSecret(authCode));
      return null;
    }

    // Mark as used
    await oauthFlows.updateOne(
      { auth_code: authCode },
      { 
        $set: { 
          used: true,
          used_at: new Date()
        } 
      }
    );

    console.log('✅ Auth code validated and consumed:', summarizeSecret(authCode));
    return {
      microsoftId: authFlow.microsoft_id,
      chatgptRedirectUri: authFlow.chatgpt_redirect_uri,
    };
  } catch (error) {
    console.error('❌ [PROXY_TOKEN_ERROR] Failed to validate auth code');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Save proxy token to database
 * Used by ChatGPT for all API calls
 */
async function saveProxyToken({ proxyToken, microsoftId, expiresIn = 2592000 }) {
  try {
    const db = await getDatabase();
    const proxyTokens = db.collection('proxy_tokens');

    const [primaryHash] = buildHashCandidates(proxyToken);

    const tokenDoc = {
      proxy_token_hash: primaryHash.hash,
      proxy_token_prefix: proxyToken.slice(0, 6),
      microsoft_id: microsoftId,
      created_at: new Date(),
      expires_at: new Date(Date.now() + expiresIn * 1000), // expiresIn is in seconds
      last_used: new Date(),
      hash_secret_id: primaryHash.secretId
    };

    await proxyTokens.insertOne(tokenDoc);

    console.log('✅ Proxy token saved for user:', microsoftId);
    return proxyToken;
  } catch (error) {
    console.error('❌ [PROXY_TOKEN_ERROR] Failed to save proxy token');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Find user by proxy token
 * Returns microsoft_id if valid, null if invalid/expired
 */
async function findUserByProxyToken(proxyToken) {
  try {
    const db = await getDatabase();
    const proxyTokens = db.collection('proxy_tokens');

    const candidates = buildHashCandidates(proxyToken);
    const tokenDoc = await proxyTokens.findOne({
      proxy_token_hash: { $in: candidates.map(candidate => candidate.hash) }
    });

    let matchedDoc = tokenDoc;
    let matchedCandidate = tokenDoc
      ? candidates.find(candidate => candidate.hash === tokenDoc.proxy_token_hash)
      : null;

    if (!matchedDoc) {
      matchedDoc = await proxyTokens.findOne({ proxy_token: proxyToken });

      if (matchedDoc) {
        const [primaryCandidate] = candidates;
        await proxyTokens.updateOne(
          { _id: matchedDoc._id },
          {
            $set: {
              proxy_token_hash: primaryCandidate.hash,
              proxy_token_prefix: proxyToken.slice(0, 6),
              hash_secret_id: primaryCandidate.secretId,
              last_used: new Date()
            },
            $unset: { proxy_token: '' }
          }
        );

        matchedDoc = {
          ...matchedDoc,
          proxy_token_hash: primaryCandidate.hash,
          proxy_token_prefix: proxyToken.slice(0, 6),
          hash_secret_id: primaryCandidate.secretId,
          last_used: new Date()
        };
        matchedCandidate = primaryCandidate;
      }
    }

    if (!matchedDoc) {
      console.log('⚠️  Proxy token not found');
      return null;
    }

    // Check if expired
    if (new Date() > matchedDoc.expires_at) {
      console.log('⚠️  Proxy token expired');
      return null;
    }

    // Update last_used timestamp and rotate hash metadata if needed
    const updateDoc = {
      last_used: new Date(),
      hash_secret_id: matchedCandidate?.secretId || matchedDoc.hash_secret_id || 'unknown'
    };

    const [primaryCandidate] = candidates;
    if (matchedCandidate && matchedCandidate.secretId !== primaryCandidate.secretId) {
      updateDoc.proxy_token_hash = primaryCandidate.hash;
      updateDoc.hash_secret_id = primaryCandidate.secretId;
    }

    await proxyTokens.updateOne(
      { _id: matchedDoc._id },
      { $set: updateDoc }
    );

    console.log('✅ Proxy token validated for user:', matchedDoc.microsoft_id);
    return matchedDoc.microsoft_id;
  } catch (error) {
    console.error('❌ [PROXY_TOKEN_ERROR] Failed to find user by proxy token');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

/**
 * Clean up expired auth codes and tokens
 * Run this periodically (e.g., daily cron job)
 */
async function cleanupExpiredTokens() {
  try {
    const db = await getDatabase();
    const now = new Date();

    // Clean up expired auth codes
    const authCodesResult = await db.collection('oauth_flows').deleteMany({
      expires_at: { $lt: now }
    });

    // Clean up expired proxy tokens
    const proxyTokensResult = await db.collection('proxy_tokens').deleteMany({
      expires_at: { $lt: now }
    });

    console.log('✅ Cleanup complete:', {
      authCodesDeleted: authCodesResult.deletedCount,
      proxyTokensDeleted: proxyTokensResult.deletedCount
    });

    return {
      authCodesDeleted: authCodesResult.deletedCount,
      proxyTokensDeleted: proxyTokensResult.deletedCount
    };
  } catch (error) {
    console.error('❌ [PROXY_TOKEN_ERROR] Failed to clean up expired tokens');
    console.error('Details:', {
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}

const traced = wrapModuleFunctions('services.proxyTokenService', {
  generateAuthCode,
  generateProxyToken,
  saveAuthCode,
  validateAndConsumeAuthCode,
  saveProxyToken,
  findUserByProxyToken,
  cleanupExpiredTokens
});

const {
  generateAuthCode: tracedGenerateAuthCode,
  generateProxyToken: tracedGenerateProxyToken,
  saveAuthCode: tracedSaveAuthCode,
  validateAndConsumeAuthCode: tracedValidateAndConsumeAuthCode,
  saveProxyToken: tracedSaveProxyToken,
  findUserByProxyToken: tracedFindUserByProxyToken,
  cleanupExpiredTokens: tracedCleanupExpiredTokens
} = traced;

export {
  tracedGenerateAuthCode as generateAuthCode,
  tracedGenerateProxyToken as generateProxyToken,
  tracedSaveAuthCode as saveAuthCode,
  tracedValidateAndConsumeAuthCode as validateAndConsumeAuthCode,
  tracedSaveProxyToken as saveProxyToken,
  tracedFindUserByProxyToken as findUserByProxyToken,
  tracedCleanupExpiredTokens as cleanupExpiredTokens
};
