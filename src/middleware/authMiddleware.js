import { google } from 'googleapis';
import dotenv from 'dotenv';
import { findUserByProxyToken } from '../services/proxyTokenService.js';
import {
  cacheAccessTokenIdentity,
  getCachedIdentityForAccessToken,
  invalidateCachedIdentity
} from '../services/tokenIdentityService.js';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { logDuration, startTimer } from '../utils/performanceLogger.js';

dotenv.config();

/**
 * Middleware to verify ChatGPT user token and identify user
 * 
 * Flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Validate token with Google userinfo endpoint
 * 3. Extract google_sub (user ID)
 * 4. Attach user info to req.user
 * 5. Continue to next middleware/controller
 */
async function verifyToken(req, res, next) {
  const overallTimer = startTimer();
  let verificationMethod = 'unverified';
  let status = 'success';
  let errorCode;
  let errorMessage;
  const logMetadata = {};

  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      status = 'error';
      verificationMethod = 'none';
      errorCode = 'missing-authorization-header';
      errorMessage = 'Missing or invalid Authorization header';
      console.error('❌ [AUTH_ERROR] Missing or invalid Authorization header');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization token'
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      status = 'error';
      verificationMethod = 'none';
      errorCode = 'missing-token';
      errorMessage = 'Token not found in Authorization header';
      console.error('❌ [AUTH_ERROR] Token not found in Authorization header');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization token is required'
      });
    }

    // STRATEGY 1: Try to find user by proxy token (ChatGPT flow)
    const microsoftIdFromProxy = await findUserByProxyToken(token);

    if (microsoftIdFromProxy) {
      // Token is a valid proxy token - get user info from database
      verificationMethod = 'proxy';
      logMetadata.proxyGoogleSub = microsoftIdFromProxy;

      const { getUserByGoogleSub } = await import('../services/databaseService.js');
      const user = await getUserByGoogleSub(microsoftIdFromProxy);

      if (!user) {
        status = 'error';
        errorCode = 'proxy-user-missing';
        errorMessage = 'User not found in database for proxy token';
        console.error('❌ [AUTH_ERROR] User not found in database for proxy token');
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User not found'
        });
      }
      
      // Attach user info to request
      req.user = {
        microsoftId: user.microsoftId,
        email: user.email,
        name: user.email.split('@')[0],
        picture: null,
        accessToken: user.accessToken,
        refreshToken: user.refreshToken,
        tokenType: 'proxy'
      };

      logMetadata.userEmail = user.email;
      logMetadata.microsoftId = user.microsoftId;
      return next();
    }

    // STRATEGY 2: Try cached access token identity (non-proxy flow)
    const cachedIdentity = await getCachedIdentityForAccessToken(token);

    if (cachedIdentity) {
      verificationMethod = 'google-cache';
      logMetadata.cacheSource = cachedIdentity.source || 'memory';
      logMetadata.microsoftId = cachedIdentity.microsoftId;

      let email = cachedIdentity.email;
      let dbUser = null;

      if (!email) {
        const { getUserByGoogleSub } = await import('../services/databaseService.js');
        dbUser = await getUserByGoogleSub(cachedIdentity.microsoftId);
        email = dbUser?.email || null;
      }

      req.user = {
        microsoftId: cachedIdentity.microsoftId,
        email,
        name: email ? email.split('@')[0] : cachedIdentity.microsoftId,
        picture: null,
        accessToken: token,
        tokenType: 'google-cache'
      };

      if (dbUser?.refreshToken) {
        req.user.refreshToken = dbUser.refreshToken;
      }

      if (!logMetadata.userEmail && email) {
        logMetadata.userEmail = email;
      }

      return next();
    }

    // STRATEGY 3: Fallback to Google token validation (direct access flow)
    verificationMethod = 'google';

    // Create OAuth2 client with the access token
    const { OAuth2 } = google.auth;
    const oauth2Client = new OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    
    // Set the access token
    oauth2Client.setCredentials({ access_token: token });
    
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    
    let userInfo;
    try {
      const response = await oauth2.userinfo.get();
      userInfo = response.data;
    } catch (error) {
      status = 'error';
      errorCode = error.response?.status === 401 ? 'google-token-expired' : 'google-token-validation-failed';
      errorMessage = error.message;
      console.error('❌ [AUTH_ERROR] Token validation failed');
      console.error('Details:', {
        errorMessage: error.message,
        statusCode: error.response?.status,
        timestamp: new Date().toISOString()
      });

      // Check for specific error types
      if (error.response?.status === 401) {
        await invalidateCachedIdentity(token).catch(cacheError =>
          console.warn('⚠️  Failed to invalidate cached identity after 401:', cacheError.message)
        );
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or expired token'
        });
      }

      return res.status(500).json({
        error: 'Authentication failed',
        message: 'Unable to verify token'
      });
    }

    // Extract user identification
    const microsoftId = userInfo.id;
    const email = userInfo.email;

    if (!microsoftId) {
      console.error('❌ [AUTH_ERROR] Google sub not found in token');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token format'
      });
    }

    // Attach user info to request
    req.user = {
      microsoftId,
      email,
      name: userInfo.name,
      picture: userInfo.picture,
      accessToken: token,
      tokenType: 'google'
    };

    logMetadata.microsoftId = microsoftId;
    logMetadata.userEmail = email;

    await cacheAccessTokenIdentity({
      accessToken: token,
      microsoftId,
      email,
      source: 'google-userinfo'
    }).catch(cacheError =>
      console.warn('⚠️  Failed to cache access token identity:', cacheError.message)
    );
    
    // Continue to next middleware/controller
    next();

  } catch (error) {
    status = 'error';
    verificationMethod = verificationMethod === 'unverified' ? 'unknown' : verificationMethod;
    errorCode = errorCode || error.code || error.statusCode || 'unexpected-error';
    errorMessage = errorMessage || error.message;
    console.error('❌ [AUTH_ERROR] Unexpected error in authentication');
    console.error('Details:', {
      errorMessage: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({
      error: 'Internal server error',
      message: 'Authentication failed'
    });
  } finally {
    if (!logMetadata.microsoftId && req.user?.microsoftId) {
      logMetadata.microsoftId = req.user.microsoftId;
    }

    if (!logMetadata.userEmail && req.user?.email) {
      logMetadata.userEmail = req.user.email;
    }

    if (status === 'error' && errorMessage) {
      logMetadata.errorDetail = errorMessage;
    }

    logDuration('auth.verifyToken', overallTimer, {
      status,
      verificationMethod,
      publicFields: ['verificationMethod'],
      error: errorCode || errorMessage,
      ...logMetadata
    });
  }
}

/**
 * Optional middleware to check if user exists in database
 * Use this after verifyToken for endpoints that require prior OAuth setup
 */
async function requireDatabaseUser(req, res, next) {
  try {
    const { getUserByGoogleSub } = await import('../services/databaseService.js');
    
    const user = await getUserByGoogleSub(req.user.microsoftId);

    if (!user) {
      console.log('⚠️  User not found in database:', req.user.email);
      return res.status(403).json({
        error: 'Forbidden',
        message: 'User not authenticated with Google. Please complete OAuth flow first.',
        action: 'redirect_to_oauth'
      });
    }

    // User exists in database
    req.user.dbExists = true;
    next();

  } catch (error) {
    console.error('❌ [AUTH_ERROR] Database check failed');
    console.error('Details:', {
      microsoftId: req.user.microsoftId,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({
      error: 'Internal server error',
      message: 'Unable to verify user status'
    });
  }
}

const traced = wrapModuleFunctions('middleware.authMiddleware', {
  verifyToken,
  requireDatabaseUser,
});

const {
  verifyToken: tracedVerifyToken,
  requireDatabaseUser: tracedRequireDatabaseUser,
} = traced;

export {
  tracedVerifyToken as verifyToken,
  tracedRequireDatabaseUser as requireDatabaseUser,
};
