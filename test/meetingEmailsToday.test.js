import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.REDIRECT_URI = process.env.REDIRECT_URI || 'https://example.com/oauth';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.BASE_URL = process.env.BASE_URL || 'https://example.com';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete globalThis.__facadeMocks;
  mock.restoreAll();
});

afterEach(() => {
  if (ORIGINAL_NODE_ENV) {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  } else {
    delete process.env.NODE_ENV;
  }
  delete globalThis.__facadeMocks;
  mock.restoreAll();
});

describe('meetingEmailsToday briefing macro', () => {
  it('merges attendee and keyword searches into a consolidated briefing', async () => {
    const listCalendarEvents = mock.fn(async () => ({
      items: [
        {
          id: 'evt-1',
          summary: 'Project Atlas Kickoff',
          start: { dateTime: '2025-03-18T08:00:00+01:00' },
          end: { dateTime: '2025-03-18T09:00:00+01:00' },
          attendees: [
            { email: 'alice@example.com' },
            { email: 'bob@example.com' }
          ]
        }
      ]
    }));

    const searchEmails = mock.fn(async (_microsoftId, { query }) => {
      if (query.includes('from:alice@example.com')) {
        return {
          resultSizeEstimate: 1,
          messages: [{ id: 'msg-1', threadId: 'thr-1' }]
        };
      }
      if (query.includes('Project Atlas Kickoff')) {
        return {
          resultSizeEstimate: 1,
          messages: [{ id: 'msg-1', threadId: 'thr-1' }]
        };
      }
      if (query.includes('"Atlas"')) {
        return {
          resultSizeEstimate: 0,
          messages: []
        };
      }
      return { resultSizeEstimate: 0, messages: [] };
    });

    const readEmail = mock.fn(async () => ({
      id: 'msg-1',
      threadId: 'thr-1',
      subject: 'Re: Project Atlas Kickoff',
      fromName: 'Alice Example',
      fromEmail: 'alice@example.com',
      date: '2025-03-17T08:30:00+01:00',
      links: {
        thread: 'https://mail.google.com/t/thr-1',
        message: 'https://mail.google.com/m/msg-1'
      }
    }));

    globalThis.__facadeMocks = {
      calendarService: { listCalendarEvents },
      gmailService: { searchEmails, readEmail }
    };

    const { meetingEmailsToday } = await import('../src/services/facadeService.js');

    const result = await meetingEmailsToday('user-123', {
      date: '2025-03-18',
      lookbackDays: 10,
      calendarId: 'primary',
      globalKeywordHints: ['Atlas']
    });

    assert.equal(listCalendarEvents.mock.calls.length, 1);
    const calendarArgs = listCalendarEvents.mock.calls[0].arguments[1];
    assert.equal(calendarArgs.calendarId, 'primary');
    assert.equal(calendarArgs.timeMin, '2025-03-17T23:00:00.000Z');
    assert.equal(calendarArgs.timeMax, '2025-03-18T23:00:00.000Z');

    assert.ok(searchEmails.mock.calls.length >= 2);

    assert.equal(result.date, '2025-03-18');
    assert.equal(result.lookbackDays, 10);
    assert.deepEqual(result.globalKeywordHintsUsed, ['Atlas']);
    assert.equal(result.events.length, 1);

    const [event] = result.events;
    assert.equal(event.eventId, 'evt-1');
    assert.equal(event.attendeesUsed.length, 2);
    assert.ok(event.keywordSources.auto.includes('Project Atlas Kickoff'));

    const relevant = event.relevantEmails;
    assert.equal(relevant.length, 1);
    const [email] = relevant;
    assert.equal(email.messageId, 'msg-1');
    assert.equal(email.from.email, 'alice@example.com');
    assert.ok(email.reason.includes('attendeeMatch:alice@example.com'));
    assert.ok(email.reason.includes('keyword+attendee:Project Atlas Kickoff'));

    assert.deepEqual(event.possibleMatches, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.subset, false);
  });

  it('rejects invalid lookback windows', async () => {
    globalThis.__facadeMocks = {
      calendarService: {
        listCalendarEvents: mock.fn(async () => ({ items: [] }))
      },
      gmailService: {
        searchEmails: mock.fn(async () => ({ resultSizeEstimate: 0, messages: [] })),
        readEmail: mock.fn(async () => ({}))
      }
    };

    const { meetingEmailsToday } = await import(`../src/services/facadeService.js?case=${Date.now()}`);

    await assert.rejects(
      () => meetingEmailsToday('user-456', { lookbackDays: 0 }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'INVALID_PARAM');
        return true;
      }
    );
  });
});
