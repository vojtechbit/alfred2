import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/oauth';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-db';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.BASE_URL = process.env.BASE_URL || 'https://example.com';
process.env.NODE_ENV = 'test';

const facadeModule = await import('../src/services/facadeService.js');
const { calendarSchedule } = facadeModule;

afterEach(() => {
  delete globalThis.__facadeMocks;
  mock.restoreAll();
});

describe('calendarSchedule macro', () => {
  it('throws 409 with alternatives when every proposal conflicts', async () => {
    const proposals = [
      { start: '2025-03-01T09:00:00Z', end: '2025-03-01T10:00:00Z' },
      { start: '2025-03-01T11:00:00Z', end: '2025-03-01T12:00:00Z' }
    ];

    const checkConflicts = mock.fn(async (microsoftId, { start }) => [{ id: `conflict-${start}` }]);

    globalThis.__facadeMocks = {
      calendarService: { checkConflicts }
    };

    await assert.rejects(
      () => calendarSchedule('user-sub', {
        title: 'Conflict heavy sync',
        when: { proposals },
        attendees: [],
        reminders: []
      }),
      (error) => {
        assert.equal(error.statusCode, 409, 'should expose HTTP 409 status');
        assert.ok(Array.isArray(error.alternatives), 'alternatives should be array');
        assert.equal(error.alternatives.length, proposals.length, 'all proposals should be represented');

        error.alternatives.forEach((alternative, index) => {
          assert.deepEqual(alternative.proposal, proposals[index], 'proposal preserved');
          assert.deepEqual(
            alternative.conflicts,
            [{ id: `conflict-${proposals[index].start}` }],
            'conflicts listed for each proposal'
          );
        });

        return true;
      }
    );

    assert.equal(checkConflicts.mock.callCount(), proposals.length, 'should check each proposal');
  });

  it('returns a confirmation when contact enrichment asks the user', async () => {
    const searchContacts = mock.fn(async () => ({
      connections: [
        {
          resourceName: 'people/123',
          names: [{ displayName: 'Alice Example' }],
          phoneNumbers: [{ value: '+123456789' }]
        }
      ]
    }));

    const createPendingConfirmation = mock.fn(async () => ({
      confirmToken: 'confirm-token-123',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    }));

    const createCalendarEvent = mock.fn(async () => {
      throw new Error('createCalendarEvent should not be invoked before confirmation');
    });

    globalThis.__facadeMocks = {
      calendarService: {
        createCalendarEvent,
        checkConflicts: mock.fn(async () => [])
      },
      contactsService: { searchContacts },
      confirmationStore: { createPendingConfirmation }
    };

    const result = await calendarSchedule('user-sub', {
      title: 'Intro call',
      when: {
        fixed: { start: '2025-04-10T09:00:00Z', end: '2025-04-10T09:30:00Z' }
      },
      attendees: [{ email: 'alice@example.com' }],
      enrichFromContacts: 'ask',
      reminders: []
    });

    assert.equal(searchContacts.mock.callCount(), 1, 'should look up contacts');
    assert.equal(createPendingConfirmation.mock.callCount(), 1, 'should open a confirmation');
    assert.equal(createCalendarEvent.mock.callCount(), 0, 'no calendar event before confirmation');

    assert.equal(result.event, null, 'event should be pending');
    assert.equal(result.confirmToken, 'confirm-token-123', 'confirm token should come from store');
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, 'should inform user via warnings');
  });

  it('creates an event without conflicts and maps the response structure', async () => {
    const proposals = [
      { start: '2025-05-01T13:00:00Z', end: '2025-05-01T14:00:00Z' }
    ];

    const checkConflicts = mock.fn(async () => []);

    let capturedEventData;
    const createCalendarEvent = mock.fn(async (microsoftId, eventData) => {
      capturedEventData = eventData;
      return {
        id: 'evt-789',
        summary: 'Team Sync',
        start: { dateTime: '2025-05-01T15:00:00+02:00' },
        end: { dateTime: '2025-05-01T16:00:00+02:00' },
        attendees: [
          { email: 'alice@example.com', displayName: 'Alice' },
          { email: 'bob@example.com' }
        ],
        location: 'HQ Meeting Room'
      };
    });

    globalThis.__facadeMocks = {
      calendarService: { checkConflicts, createCalendarEvent }
    };

    const result = await calendarSchedule('user-sub', {
      title: 'Team Sync',
      when: { proposals },
      attendees: [
        { email: 'alice@example.com', name: 'Alice' },
        { email: 'bob@example.com' }
      ],
      reminders: ['30', '10'],
      enrichFromContacts: 'off',
      location: 'HQ Meeting Room'
    });

    assert.equal(checkConflicts.mock.callCount(), 1, 'should evaluate conflicts once');
    assert.equal(createCalendarEvent.mock.callCount(), 1, 'should create the calendar event');

    assert.ok(capturedEventData, 'event payload should be provided');
    assert.deepEqual(
      capturedEventData.start,
      { dateTime: '2025-05-01T13:00:00', timeZone: 'Europe/Prague' },
      'start time normalized to Prague wall clock'
    );
    assert.deepEqual(
      capturedEventData.end,
      { dateTime: '2025-05-01T14:00:00', timeZone: 'Europe/Prague' },
      'end time normalized to Prague wall clock'
    );
    assert.deepEqual(
      capturedEventData.attendees,
      [
        { email: 'alice@example.com', displayName: 'Alice' },
        { email: 'bob@example.com' }
      ],
      'attendees forwarded to Google API'
    );
    assert.deepEqual(
      capturedEventData.reminders,
      {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'popup', minutes: 10 }
        ]
      },
      'reminders converted to overrides'
    );

    assert.equal(result.event.eventId, 'evt-789', 'event identifier should match stubbed response');
    assert.equal(result.event.title, 'Team Sync', 'title should bubble through');
    assert.equal(
      result.event.start,
      '2025-05-01T15:00:00+02:00',
      'start time sourced from Google response'
    );
    assert.equal(
      result.event.end,
      '2025-05-01T16:00:00+02:00',
      'end time sourced from Google response'
    );
    assert.equal(result.event.status, 'upcoming', 'status normalized');
    assert.equal(result.event.locationText, 'HQ Meeting Room', 'location propagated');
    assert.ok(
      typeof result.event.mapUrl === 'string' &&
        result.event.mapUrl.includes('HQ%20Meeting%20Room'),
      'map URL should be generated for the provided location'
    );
    assert.deepEqual(
      result.event.attendees,
      [
        { name: 'Alice', email: 'alice@example.com' },
        { name: null, email: 'bob@example.com' }
      ],
      'response event attendees normalized'
    );
    assert.equal(result.confirmToken, null, 'no confirmation necessary');
    assert.deepEqual(result.warnings, [], 'no enrichment warnings expected');
  });

  it('normalizes GPT-provided DST offsets before creating the event', async () => {
    const createCalendarEvent = mock.fn(async () => ({
      id: 'evt-dst-fix',
      summary: 'DST Check',
      start: { dateTime: '2025-10-28T13:00:00+01:00' },
      end: { dateTime: '2025-10-28T13:30:00+01:00' },
      attendees: []
    }));

    globalThis.__facadeMocks = {
      calendarService: {
        checkConflicts: mock.fn(async () => []),
        createCalendarEvent
      }
    };

    await calendarSchedule('user-sub', {
      title: 'DST Fix',
      when: {
        fixed: {
          start: '2025-10-28T13:00:00+02:00',
          end: '2025-10-28T13:30:00+02:00'
        }
      },
      attendees: [],
      reminders: [],
      enrichFromContacts: 'off'
    });

    assert.equal(createCalendarEvent.mock.callCount(), 1, 'event should be created once');
    const [, eventData] = createCalendarEvent.mock.calls[0].arguments;

    assert.deepEqual(
      eventData.start,
      { dateTime: '2025-10-28T13:00:00', timeZone: 'Europe/Prague' },
      'start time should keep Prague wall clock regardless of provided offset'
    );
    assert.deepEqual(
      eventData.end,
      { dateTime: '2025-10-28T13:30:00', timeZone: 'Europe/Prague' },
      'end time should keep Prague wall clock regardless of provided offset'
    );
  });
});
