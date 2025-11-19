/**
 * Facade Controller - Handles macro endpoints
 */
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';


import * as facadeService from '../services/facadeService.js';

// ==================== INBOX MACROS ====================

async function macroInboxOverview(req, res) {
  try {
    const result = await facadeService.inboxOverview(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro inbox overview failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        error: 'Invalid request parameters',
        message: error.message,
        code: 'INVALID_PARAM'
      });
    }

    res.status(500).json({
      error: 'Inbox overview failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

async function macroInboxSnippets(req, res) {
  try {
    const result = await facadeService.inboxSnippets(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro inbox snippets failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        error: 'Invalid request parameters',
        message: error.message,
        code: 'INVALID_PARAM'
      });
    }

    res.status(500).json({
      error: 'Inbox snippets failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

async function macroInboxUserUnanswered(req, res) {
  try {
    const result = await facadeService.inboxUserUnansweredRequests(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro inbox user unanswered requests failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        error: 'Bad request',
        message: error.message,
        code: 'INVALID_PARAM'
      });
    }

    res.status(500).json({
      error: 'Inbox user unanswered requests failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

async function macroEmailQuickRead(req, res) {
  try {
    const result = await facadeService.emailQuickRead(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro email quick read failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    if (error.message.includes('No message IDs')) {
      return res.status(400).json({
        error: 'Bad request',
        message: error.message,
        code: 'INVALID_PARAM'
      });
    }

    res.status(500).json({
      error: 'Email quick read failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

// ==================== BRIEFING MACROS ====================

async function macroBriefingsMeetingEmailsToday(req, res) {
  try {
    const result = await facadeService.meetingEmailsToday(req.user.microsoftId, req.body || {});
    res.json(result);
  } catch (error) {
    console.error('❌ Macro briefing meeting emails today failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    if (error.statusCode === 400) {
      return res.status(400).json({
        error: 'Bad request',
        message: error.message,
        code: error.code || 'INVALID_PARAM'
      });
    }

    res.status(500).json({
      error: 'Meeting email briefing failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

// ==================== CALENDAR MACROS ====================

async function macroCalendarPlan(req, res) {
  try {
    const result = await facadeService.calendarPlan(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro calendar plan failed:', error.message);
    
    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }
    
    res.status(500).json({
      error: 'Calendar plan failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

async function macroCalendarSchedule(req, res) {
  try {
    const result = await facadeService.calendarSchedule(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro calendar schedule failed:', error.message);
    
    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }
    
    if (error.statusCode === 400) {
      return res.status(400).json({
        error: 'Bad request',
        message: error.message,
        code: error.code || 'INVALID_PARAM'
      });
    }

    if (error.statusCode === 409) {
      return res.status(409).json({
        error: 'Conflict',
        message: error.message,
        code: 'CONFLICT',
        alternatives: error.alternatives || []
      });
    }
    
    res.status(500).json({
      error: 'Calendar schedule failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

async function macroCalendarReminderDrafts(req, res) {
  try {
    const result = await facadeService.calendarReminderDrafts(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro calendar reminder drafts failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    res.status(500).json({
      error: 'Calendar reminder drafts failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

async function macroCalendarListCalendars(req, res) {
  try {
    const result = await facadeService.calendarListCalendars(req.user.microsoftId);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro calendar list calendars failed:', error.message);

    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }

    res.status(500).json({
      error: 'Calendar list calendars failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

// ==================== CONTACTS MACROS ====================

async function macroContactsSafeAdd(req, res) {
  try {
    const result = await facadeService.contactsSafeAdd(req.user.accessToken, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro contacts safe add failed:', error.message);
    
    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }
    
    res.status(500).json({
      error: 'Contacts safe add failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

// ==================== TASKS MACROS ====================

async function macroTasksOverview(req, res) {
  try {
    const result = await facadeService.tasksOverview(req.user.microsoftId, req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ Macro tasks overview failed:', error.message);
    
    if (error.statusCode === 401) {
      return res.status(401).json({
        error: 'Authentication required',
        message: error.message,
        code: 'REAUTH_REQUIRED'
      });
    }
    
    res.status(500).json({
      error: 'Tasks overview failed',
      message: error.message,
      code: 'SERVER_ERROR'
    });
  }
}

const traced = wrapModuleFunctions('controllers.facadeController', {
  macroInboxOverview,
  macroInboxSnippets,
  macroInboxUserUnanswered,
  macroEmailQuickRead,
  macroBriefingsMeetingEmailsToday,
  macroCalendarPlan,
  macroCalendarSchedule,
  macroCalendarReminderDrafts,
  macroCalendarListCalendars,
  macroContactsSafeAdd,
  macroTasksOverview,
});

const {
  macroInboxOverview: tracedMacroInboxOverview,
  macroInboxSnippets: tracedMacroInboxSnippets,
  macroInboxUserUnanswered: tracedMacroInboxUserUnanswered,
  macroEmailQuickRead: tracedMacroEmailQuickRead,
  macroBriefingsMeetingEmailsToday: tracedMacroBriefingsMeetingEmailsToday,
  macroCalendarPlan: tracedMacroCalendarPlan,
  macroCalendarSchedule: tracedMacroCalendarSchedule,
  macroCalendarReminderDrafts: tracedMacroCalendarReminderDrafts,
  macroCalendarListCalendars: tracedMacroCalendarListCalendars,
  macroContactsSafeAdd: tracedMacroContactsSafeAdd,
  macroTasksOverview: tracedMacroTasksOverview,
} = traced;

export {
  tracedMacroInboxOverview as macroInboxOverview,
  tracedMacroInboxSnippets as macroInboxSnippets,
  tracedMacroInboxUserUnanswered as macroInboxUserUnanswered,
  tracedMacroEmailQuickRead as macroEmailQuickRead,
  tracedMacroBriefingsMeetingEmailsToday as macroBriefingsMeetingEmailsToday,
  tracedMacroCalendarPlan as macroCalendarPlan,
  tracedMacroCalendarSchedule as macroCalendarSchedule,
  tracedMacroCalendarReminderDrafts as macroCalendarReminderDrafts,
  tracedMacroCalendarListCalendars as macroCalendarListCalendars,
  tracedMacroContactsSafeAdd as macroContactsSafeAdd,
  tracedMacroTasksOverview as macroTasksOverview,
};
