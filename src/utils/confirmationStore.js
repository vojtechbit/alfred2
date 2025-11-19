/**
 * FILE: src/utils/confirmationStore.js
 * 
 * Handles pendingConfirmations in MongoDB
 * Used by:
 * - calendar.schedule (enrichment workflow)
 * - contacts.safeAdd (deduplication workflow)
 */

import crypto from 'crypto';
import { getDatabase } from '../config/database.js';

const COLLECTION_NAME = 'pendingConfirmations';
const CONFIRMATION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Initialize MongoDB indexes for confirmations collection
 * Call this on server startup
 */
export async function initializeConfirmationStore() {
  try {
    const db = await getDatabase();
    const collection = db.collection(COLLECTION_NAME);
    
    // Create TTL index to auto-delete expired confirmations after 15 min
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    
    // Index for quick lookup by confirmToken
    await collection.createIndex({ confirmToken: 1 }, { unique: true });
    
    // Index for lookup by microsoftId (user's data)
    await collection.createIndex({ microsoftId: 1 });
    
    console.log('✅ Confirmation store initialized');
  } catch (error) {
    console.error('❌ Failed to initialize confirmation store:', error.message);
    throw error;
  }
}

/**
 * Generate a secure confirmToken
 * @returns {string} 32-char hex token
 */
export function generateConfirmToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create a pending confirmation
 * 
 * @param {string} microsoftId - User's Google sub
 * @param {string} type - 'enrichment' | 'deduplication'
 * @param {object} data - Type-specific data
 * @returns {Promise<{confirmToken, expiresAt}>}
 */
export async function createPendingConfirmation(microsoftId, type, data) {
  if (!['enrichment', 'deduplication'].includes(type)) {
    throw new Error('Invalid confirmation type');
  }
  
  const confirmToken = generateConfirmToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONFIRMATION_TIMEOUT_MS);
  
  const confirmation = {
    confirmToken,
    microsoftId,
    type,
    data,
    status: 'pending',
    createdAt: now,
    expiresAt,
    confirmedAt: null,
    action: null
  };

  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  
  await collection.insertOne(confirmation);
  
  console.log(`📌 Created ${type} confirmation: ${confirmToken}`);
  
  return {
    confirmToken,
    expiresAt: expiresAt.toISOString()
  };
}

/**
 * Get a pending confirmation
 * @param {string} confirmToken - Token from user
 * @returns {Promise<object|null>} Confirmation data or null if expired/not found
 */
export async function getPendingConfirmation(confirmToken) {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  
  const confirmation = await collection.findOne({ 
    confirmToken,
    status: 'pending'
  });
  
  if (!confirmation) {
    return null;
  }
  
  // Check if expired
  if (new Date() > confirmation.expiresAt) {
    // Mark as expired
    await collection.updateOne(
      { confirmToken },
      { $set: { status: 'expired' } }
    );
    return null;
  }
  
  return confirmation;
}

/**
 * Confirm a pending confirmation
 * @param {string} confirmToken - Token
 * @param {string} action - User's action
 * @returns {Promise<object>} Updated confirmation with action applied
 */
export async function confirmPendingConfirmation(confirmToken, action) {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  
  const confirmation = await getPendingConfirmation(confirmToken);
  
  if (!confirmation) {
    throw new Error('Confirmation expired or not found');
  }
  
  const now = new Date();
  
  const updated = await collection.findOneAndUpdate(
    { confirmToken },
    {
      $set: {
        status: 'confirmed',
        confirmedAt: now,
        action
      }
    },
    { returnDocument: 'after' }
  );
  
  console.log(`✅ Confirmed ${confirmation.type}: ${confirmToken}, action: ${action}`);
  
  return updated.value;
}

/**
 * Complete a confirmation (mark it done)
 * @param {string} confirmToken
 */
export async function completePendingConfirmation(confirmToken) {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  
  await collection.updateOne(
    { confirmToken },
    { $set: { status: 'completed', completedAt: new Date() } }
  );
}

/**
 * Cancel a pending confirmation (user cancelled)
 * @param {string} confirmToken
 */
export async function cancelPendingConfirmation(confirmToken) {
  const db = await getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  
  await collection.updateOne(
    { confirmToken },
    { $set: { status: 'cancelled', cancelledAt: new Date() } }
  );
}

/**
 * Get all pending confirmations for a user (useful for debugging)
 * @param {string} microsoftId
 * @returns {Promise<array>}
 */
export async function getUserPendingConfirmations(microsoftId) {
  const db = getDatabase();
  const collection = db.collection(COLLECTION_NAME);
  
  const confirmations = await collection
    .find({ microsoftId, status: 'pending' })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  
  return confirmations;
}
