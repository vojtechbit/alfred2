import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/oauth';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-db';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.BASE_URL = process.env.BASE_URL || 'https://example.com';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreNodeEnv() {
  if (typeof ORIGINAL_NODE_ENV === 'string') {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  } else {
    delete process.env.NODE_ENV;
  }
}

afterEach(() => {
  restoreNodeEnv();
  delete globalThis.__facadeMocks;
  mock.restoreAll();
});

describe('facadeService test double isolation', () => {
  it('returns real services when NODE_ENV is not "test"', async () => {
    process.env.NODE_ENV = 'production';

    const calendarMock = {
      checkConflicts: mock.fn(async () => []),
      createCalendarEvent: mock.fn(async () => ({ id: 'mock-evt' }))
    };
    const contactsMock = {
      searchContacts: mock.fn(async () => ({ connections: [] }))
    };
    const confirmationMock = {
      createPendingConfirmation: mock.fn(async () => ({ confirmToken: 'mock-token' }))
    };

    globalThis.__facadeMocks = {
      calendarService: calendarMock,
      contactsService: contactsMock,
      confirmationStore: confirmationMock
    };

    const [calendarModule, contactsModule, confirmationModule] = await Promise.all([
      import('../src/services/microsoftGraphService.js'),
      import('../src/services/contactsService.js'),
      import('../src/utils/confirmationStore.js')
    ]);

    const facadeModule = await import(`../src/services/facadeService.js?isolation=${Date.now()}`);
    const { __facadeTestUtils } = facadeModule;

    const resolvedCalendar = __facadeTestUtils.resolveCalendarService();
    const resolvedContacts = __facadeTestUtils.resolveContactsService();
    const resolvedConfirmation = __facadeTestUtils.resolveCreatePendingConfirmation();

    assert.strictEqual(
      resolvedCalendar.checkConflicts,
      calendarModule.checkConflicts,
      'calendar resolver should expose real implementation'
    );
    assert.notStrictEqual(
      resolvedCalendar.checkConflicts,
      calendarMock.checkConflicts,
      'calendar resolver must ignore test double outside tests'
    );

    assert.strictEqual(
      resolvedContacts.searchContacts,
      contactsModule.searchContacts,
      'contacts resolver should expose real implementation'
    );
    assert.notStrictEqual(
      resolvedContacts.searchContacts,
      contactsMock.searchContacts,
      'contacts resolver must ignore test double outside tests'
    );

    assert.strictEqual(
      resolvedConfirmation,
      confirmationModule.createPendingConfirmation,
      'confirmation resolver should return real store helper'
    );
  });
});
