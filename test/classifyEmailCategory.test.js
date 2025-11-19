import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Provide required environment variables before importing service modules
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/oauth';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-db';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { classifyEmailCategory } = await import('../src/services/microsoftGraphService.js');

describe('classifyEmailCategory', () => {
  it('returns trash when TRASH label is present', () => {
    const message = { labelIds: ['TRASH', 'CATEGORY_PROMOTIONS'] };
    assert.equal(classifyEmailCategory(message), 'trash');
  });

  it('returns spam when SPAM label is present', () => {
    const message = { labelIds: ['SPAM', 'INBOX'] };
    assert.equal(classifyEmailCategory(message), 'spam');
  });

  it('returns sent when SENT label is present', () => {
    const message = { labelIds: ['SENT'] };
    assert.equal(classifyEmailCategory(message), 'sent');
  });

  it('returns draft when DRAFT label is present', () => {
    const message = { labelIds: ['DRAFT', 'INBOX'] };
    assert.equal(classifyEmailCategory(message), 'draft');
  });

  it('returns archived when message lacks INBOX and other system labels', () => {
    const message = { labelIds: ['CATEGORY_SOCIAL'] };
    assert.equal(classifyEmailCategory(message), 'archived');
  });

  it('returns category labels when in inbox', () => {
    const promotions = { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] };
    assert.equal(classifyEmailCategory(promotions), 'promotions');

    const social = { labelIds: ['INBOX', 'CATEGORY_SOCIAL'] };
    assert.equal(classifyEmailCategory(social), 'social');

    const updates = { labelIds: ['INBOX', 'CATEGORY_UPDATES'] };
    assert.equal(classifyEmailCategory(updates), 'updates');

    const forums = { labelIds: ['INBOX', 'CATEGORY_FORUMS'] };
    assert.equal(classifyEmailCategory(forums), 'forums');
  });

  it('returns primary when message is marked important in inbox', () => {
    const message = { labelIds: ['INBOX', 'IMPORTANT'] };
    assert.equal(classifyEmailCategory(message), 'primary');
  });

  it('returns work when custom work label is present', () => {
    const message = { labelIds: ['INBOX', 'Label_work_projects'] };
    assert.equal(classifyEmailCategory(message), 'work');
  });

  it('returns other by default when no labels match', () => {
    const message = { labelIds: ['INBOX'] };
    assert.equal(classifyEmailCategory(message), 'other');
  });
});
