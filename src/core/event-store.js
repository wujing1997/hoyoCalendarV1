'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  addDays,
  daysBetween,
  formatDate,
  parseDate,
  startOfDay,
} = require('./date-utils');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isInternalField(key) {
  return key.startsWith('_');
}

// Fields a single occurrence of a recurring / long-term task may override.
const OCCURRENCE_FIELDS = ['event', 'time', 'location', 'note', 'urgency'];

class EventStore {
  constructor(options = {}) {
    const baseDir = options.dataDir
      || path.join(process.env.APPDATA || process.env.HOME || process.cwd(), 'HoyoCalendar');
    this.eventsFile = options.eventsFile || path.join(baseDir, 'events.json');
    this.dataDir = path.dirname(this.eventsFile);
    this.idCounter = 0;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  generateId() {
    this.idCounter += 1;
    return Date.now() * 1000 + this.idCounter;
  }

  generateUuid() {
    return randomUUID();
  }

  markChanged(event) {
    event._uuid = event._uuid || this.generateUuid();
    event._version = (Number(event._version) || 0) + 1;
    event._opId = this.generateUuid();
    return event;
  }

  applyRemoteMeta(event, remote) {
    if (remote.eventId) event._uuid = remote.eventId;
    if (remote.operationId) event._opId = remote.operationId;
    if (Number.isFinite(Number(remote.version))) {
      event._version = Number(remote.version);
      event._baseVersion = Number(remote.version);
    }
    return event;
  }

  sanitizeForSync(event) {
    const output = {};
    for (const [key, value] of Object.entries(event || {})) {
      if (!isInternalField(key)) output[key] = value;
    }
    return output;
  }

  normalizeEvent(input) {
    const event = clone(input || {});
    const today = formatDate(new Date());
    event.id = event.id ?? this.generateId();
    event.event = String(event.event || event.title || '未命名任务').trim() || '未命名任务';
    delete event.title;
    event.time = this.normalizeTime(event.time);
    event.location = String(event.location || '').trim();
    event.urgency = event.urgency === 'high' ? 'high' : 'normal';
    event.calendar = String(event.calendar || '个人');
    event.note = String(event.note || '');
    event.timerRecords = event.timerRecords && typeof event.timerRecords === 'object'
      ? event.timerRecords
      : {};
    const activeStartDate = this.validDate(event.activeStartDate);
    const activeEndDate = this.validDate(event.activeEndDate);
    if (activeStartDate) event.activeStartDate = activeStartDate;
    else delete event.activeStartDate;
    if (activeEndDate) event.activeEndDate = activeEndDate;
    else delete event.activeEndDate;

    const targetDuration = asPositiveNumber(event.targetDurationMinutes);
    if (targetDuration) event.targetDurationMinutes = Math.round(targetDuration);
    else delete event.targetDurationMinutes;

    this.normalizeTargetDuration(event);

    if (event.isLongTerm) {
      const startDate = this.validDate(event.startDate || event.date) || today;
      event.isLongTerm = true;
      event.date = startDate;
      event.startDate = startDate;
      event.isCompleted = Boolean(event.isCompleted || event.completed);
      if (event.isCompleted) {
        const completedAtDate = event.completedAt
          ? this.validDate(new Date(event.completedAt))
          : '';
        event.completedDate = this.validDate(event.completedDate) || completedAtDate || startDate;
      } else {
        delete event.completedAt;
        delete event.completedDate;
      }
      event.focusTotalSeconds = Math.max(0, Math.floor(Number(event.focusTotalSeconds) || 0));
      event.focusRunningSince = this.validIsoTime(event.focusRunningSince) ? event.focusRunningSince : null;
      delete event.completed;
      delete event.isDeadline;
      delete event.deadlineDate;
      delete event.isDeadlineCompleted;
      delete event.deadlineCompletedDate;
      delete event.isRecurring;
      delete event.recurringType;
      delete event.recurringDays;
      delete event.recurringMonthDays;
      delete event.completedDates;
      this.normalizeOccurrenceExceptions(event);
      return event;
    }

    if (event.isDeadline) {
      delete event.occurrenceOverrides;
      delete event.skippedDates;
      const startDate = this.validDate(event.startDate || event.date) || today;
      const deadlineDate = this.validDate(event.deadlineDate || event.endDate || event.date) || startDate;
      event.isDeadline = true;
      event.date = startDate;
      event.startDate = startDate;
      event.deadlineDate = deadlineDate < startDate ? startDate : deadlineDate;
      event.isDeadlineCompleted = Boolean(event.isDeadlineCompleted);
      if (!event.isDeadlineCompleted) {
        delete event.deadlineCompletedDate;
        delete event.completedAt;
      }
      delete event.isRecurring;
      delete event.recurringType;
      delete event.recurringDays;
      delete event.recurringMonthDays;
      delete event.endDate;
      delete event.completedDates;
      delete event.isCompleted;
      delete event.completedDate;
      delete event.isLongTerm;
      delete event.focusTotalSeconds;
      delete event.focusRunningSince;
      return event;
    }

    if (event.isRecurring) {
      const startDate = this.validDate(event.startDate || event.date) || today;
      const endDate = this.validDate(event.endDate);
      event.isRecurring = true;
      event.date = startDate;
      event.startDate = startDate;
      if (endDate) event.endDate = endDate < startDate ? startDate : endDate;
      else delete event.endDate;
      event.recurringType = ['daily', 'weekly', 'monthly'].includes(event.recurringType)
        ? event.recurringType
        : 'daily';
      event.recurringDays = Array.isArray(event.recurringDays)
        ? [...new Set(event.recurringDays.map(Number).filter((day) => day >= 0 && day <= 6))]
        : [];
      if (event.recurringType === 'monthly') {
        event.recurringMonthDays = Array.isArray(event.recurringMonthDays)
          ? [...new Set(event.recurringMonthDays.map(Number).filter((day) => day >= 1 && day <= 31))]
          : [];
      } else {
        delete event.recurringMonthDays;
      }
      event.completedDates = Array.isArray(event.completedDates)
        ? [...new Set(event.completedDates.filter((date) => this.validDate(date)))]
        : [];
      delete event.isDeadline;
      delete event.deadlineDate;
      delete event.isDeadlineCompleted;
      delete event.deadlineCompletedDate;
      delete event.isCompleted;
      delete event.completedDate;
      delete event.completedAt;
      delete event.isLongTerm;
      delete event.focusTotalSeconds;
      delete event.focusRunningSince;
      this.normalizeOccurrenceExceptions(event);
      return event;
    }

    delete event.occurrenceOverrides;
    delete event.skippedDates;

    event.date = this.validDate(event.date || event.startDate) || today;
    event.isCompleted = Boolean(event.isCompleted || event.completed);
    if (event.isCompleted) {
      const completedAtDate = event.completedAt
        ? this.validDate(new Date(event.completedAt))
        : '';
      event.completedDate = this.validDate(event.completedDate) || completedAtDate || event.date;
    } else {
      delete event.completedAt;
      delete event.completedDate;
    }
    delete event.completed;
    delete event.isDeadline;
    delete event.startDate;
    delete event.endDate;
    delete event.deadlineDate;
    delete event.isDeadlineCompleted;
    delete event.deadlineCompletedDate;
    delete event.isRecurring;
    delete event.recurringType;
    delete event.recurringDays;
    delete event.recurringMonthDays;
    delete event.completedDates;
    delete event.isLongTerm;
    delete event.focusTotalSeconds;
    delete event.focusRunningSince;
    return event;
  }

  normalizeOccurrenceExceptions(event) {
    const skipped = Array.isArray(event.skippedDates)
      ? [...new Set(event.skippedDates.map((date) => this.validDate(date)).filter(Boolean))].sort()
      : [];
    if (skipped.length) event.skippedDates = skipped;
    else delete event.skippedDates;

    const raw = event.occurrenceOverrides;
    const overrides = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const date = this.validDate(key);
        if (!date || !value || typeof value !== 'object') continue;
        const override = this.cleanOccurrenceOverride(value);
        if (Object.keys(override).length) overrides[date] = override;
      }
    }
    if (Object.keys(overrides).length) event.occurrenceOverrides = overrides;
    else delete event.occurrenceOverrides;
  }

  cleanOccurrenceOverride(raw) {
    const override = {};
    if ('event' in raw) {
      const title = String(raw.event || '').trim();
      if (title) override.event = title;
    }
    // An empty time is a real override: "no fixed time on that day".
    if ('time' in raw) override.time = this.normalizeTime(raw.time);
    if ('location' in raw) override.location = String(raw.location || '').trim();
    if ('note' in raw) override.note = String(raw.note || '');
    if ('urgency' in raw) override.urgency = raw.urgency === 'high' ? 'high' : 'normal';
    return override;
  }

  normalizeTargetDuration(event) {
    const seconds = Number(event.targetDurationSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      event.targetDurationSeconds = Math.floor(seconds);
      event.targetDurationMinutes = Math.round(event.targetDurationSeconds / 60);
    } else if (event.targetDurationSeconds !== undefined) {
      delete event.targetDurationSeconds;
      delete event.targetDurationMinutes;
    }
  }

  validIsoTime(value) {
    if (typeof value !== 'string' || !value) return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime());
  }

  normalizeTime(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  validDate(value) {
    const parsed = parseDate(value);
    return parsed ? formatDate(parsed) : '';
  }

  loadEvents() {
    try {
      if (!fs.existsSync(this.eventsFile)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.eventsFile, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((event) => this.normalizeEvent(event))
        .filter((event) => !event._deleted);
    } catch (error) {
      console.error('[EventStore] Failed to load events:', error);
      return [];
    }
  }

  loadAllEvents() {
    try {
      if (!fs.existsSync(this.eventsFile)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.eventsFile, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map((event) => this.normalizeEvent(event));
    } catch (error) {
      console.error('[EventStore] Failed to load events:', error);
      return [];
    }
  }

  saveEvents(events) {
    const normalized = (Array.isArray(events) ? events : []).map((event) => this.normalizeEvent(event));
    const tempFile = `${this.eventsFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
      fs.renameSync(tempFile, this.eventsFile);
      return true;
    } catch (error) {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {
        // Best-effort cleanup only.
      }
      console.error('[EventStore] Failed to save events:', error);
      return false;
    }
  }

  addEvent(input) {
    const events = this.loadAllEvents();
    const now = new Date().toISOString();

    if (input?.id !== undefined) {
      const trashedIndex = events.findIndex(
        (event) => String(event.id) === String(input.id) && event._deleted,
      );
      if (trashedIndex >= 0) {
        const restored = this.restoreFromTrash(input.id);
        if (restored) return clone(restored);
      }
    }

    const draft = {
      ...input,
      id: input?.id ?? this.generateId(),
      createdAt: input?.createdAt || now,
      updatedAt: now,
    };
    if (input?.id === undefined) delete draft._uuid;
    const event = this.normalizeEvent(draft);
    this.markChanged(event);
    events.push(event);
    return this.saveEvents(events) ? clone(event) : null;
  }

  updateEvent(id, updates) {
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => String(event.id) === String(id) && !event._deleted);
    if (index < 0) return null;
    const next = this.normalizeEvent({
      ...events[index],
      ...clone(updates || {}),
      id: events[index].id,
      createdAt: events[index].createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.markChanged(next);
    events[index] = next;
    return this.saveEvents(events) ? clone(next) : null;
  }

  deleteEvent(id) {
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => String(event.id) === String(id) && !event._deleted);
    if (index < 0) return null;
    const now = new Date().toISOString();
    const event = events[index];
    event._deleted = true;
    event._deletedAt = now;
    const trashUntil = new Date();
    trashUntil.setDate(trashUntil.getDate() + 30);
    event._trashUntil = formatDate(trashUntil);
    this.markChanged(event);
    events[index] = event;
    return this.saveEvents(events) ? clone(event) : null;
  }

  getEvent(id) {
    const event = this.loadEvents().find((item) => String(item.id) === String(id));
    return event ? clone(event) : null;
  }

  getAnyEvent(id) {
    const event = this.loadAllEvents().find((item) => String(item.id) === String(id));
    return event ? clone(event) : null;
  }

  findEventByUuid(uuid) {
    const event = this.loadAllEvents().find((item) => item._uuid === uuid);
    return event ? clone(event) : null;
  }

  listTrash() {
    return this.loadAllEvents()
      .filter((event) => event._deleted)
      .sort((left, right) => String(right._deletedAt || '').localeCompare(String(left._deletedAt || '')));
  }

  restoreFromTrash(id) {
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => String(event.id) === String(id) && event._deleted);
    if (index < 0) return null;
    const event = events[index];
    event._deleted = false;
    delete event._deletedAt;
    delete event._trashUntil;
    this.markChanged(event);
    events[index] = event;
    return this.saveEvents(events) ? clone(event) : null;
  }

  purgeTrash(referenceDate = new Date()) {
    const referenceKey = formatDate(referenceDate);
    const events = this.loadAllEvents();
    const kept = events.filter((event) => {
      if (!event._deleted) return true;
      return event._trashUntil && event._trashUntil >= referenceKey;
    });
    const purged = events.length - kept.length;
    if (purged > 0) this.saveEvents(kept);
    return purged;
  }

  removeEventPermanently(id) {
    const events = this.loadAllEvents();
    const kept = events.filter((event) => String(event.id) !== String(id));
    if (kept.length === events.length) return false;
    return this.saveEvents(kept);
  }

  applyRemoteEvent(eventId, data, version, operationId) {    const events = this.loadAllEvents();
    const index = events.findIndex((event) => event._uuid === eventId);
    const now = new Date().toISOString();
    if (index >= 0) {
      const next = this.normalizeEvent({
        ...clone(data || {}),
        id: events[index].id,
        createdAt: events[index].createdAt,
        updatedAt: now,
      });
      this.applyRemoteMeta(next, { eventId, version, operationId });
      next._deleted = false;
      delete next._deletedAt;
      delete next._trashUntil;
      events[index] = next;
      return this.saveEvents(events) ? clone(next) : null;
    }
    const created = this.normalizeEvent({
      ...clone(data || {}),
      id: this.generateId(),
      createdAt: now,
      updatedAt: now,
    });
    this.applyRemoteMeta(created, { eventId, version, operationId });
    created._baseVersion = Number(version) || 0;
    events.push(created);
    return this.saveEvents(events) ? clone(created) : null;
  }

  ensureSyncMetadata() {
    const events = this.loadAllEvents();
    let assigned = 0;
    let changed = false;
    for (const event of events) {
      if (!event._uuid) {
        event._uuid = this.generateUuid();
        assigned += 1;
      }
      if (!Number.isFinite(Number(event._version))) {
        event._version = 1;
        event._opId = this.generateUuid();
        event._baseVersion = 0;
        changed = true;
      }
    }
    if (changed) this.saveEvents(events);
    return { total: events.length, assignedUuids: assigned };
  }

  snapshotForAgent(limit = 500) {
    const events = this.loadEvents().slice(-limit);
    return events.map((event) => {
      const sanitized = this.sanitizeForSync(event);
      return {
        id: event._uuid,
        ...sanitized,
      };
    });
  }

  applySyncAck(eventId, version, operationId) {
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => event._uuid === eventId);
    if (index < 0) return null;
    if (operationId && events[index]._opId !== operationId) {
      events[index]._baseVersion = Number(version);
      events[index]._version = Math.max(Number(events[index]._version), Number(version) + 1);
    } else {
      this.applyRemoteMeta(events[index], { eventId, version, operationId });
    }
    return this.saveEvents(events) ? clone(events[index]) : null;
  }

  markTrashedFromRemote(eventId, trashUntil) {
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => event._uuid === eventId);
    if (index < 0) return null;
    const event = events[index];
    event._deleted = true;
    event._deletedAt = new Date().toISOString();
    event._trashUntil = trashUntil || formatDate(new Date());
    events[index] = event;
    return this.saveEvents(events) ? clone(event) : null;
  }

  isSkippedOn(event, dateStr) {
    return (event.skippedDates || []).includes(dateStr);
  }

  isRecurringOnDate(event, dateStr) {
    return this.recurringRuleMatches(event, dateStr) && !this.isSkippedOn(event, dateStr);
  }

  // Whether the task is scheduled on a date by its own rules, ignoring skippedDates.
  isScheduledIgnoringSkips(event, dateStr) {
    if (!this.isWithinActiveBounds(event, dateStr)) return false;
    if (event.isRecurring) return this.recurringRuleMatches(event, dateStr);
    if (event.isLongTerm) {
      if (dateStr < event.startDate) return false;
      return !event.isCompleted || dateStr <= event.completedDate;
    }
    if (event.isDeadline) return false;
    return (event.isCompleted ? event.completedDate : event.date) === dateStr;
  }

  occurrenceView(event, dateStr) {
    const override = event.occurrenceOverrides?.[dateStr];
    return override ? { ...event, ...override } : event;
  }

  recurringRuleMatches(event, dateStr) {
    if (!event.isRecurring || dateStr < event.startDate) return false;
    if (event.endDate && dateStr > event.endDate) return false;
    if (!this.isWithinActiveBounds(event, dateStr)) return false;
    const date = parseDate(dateStr);
    const start = parseDate(event.startDate);
    if (!date || !start) return false;
    if (event.recurringType === 'weekly') {
      return (event.recurringDays || []).includes(date.getDay());
    }
    if (event.recurringType === 'monthly') {
      if (Array.isArray(event.recurringMonthDays) && event.recurringMonthDays.length) {
        return event.recurringMonthDays.includes(date.getDate());
      }
      return date.getDate() === start.getDate();
    }
    return true;
  }

  isCompletedOnDate(event, dateStr) {
    if (event.isDeadline) {
      return Boolean(event.isDeadlineCompleted && event.deadlineCompletedDate === dateStr);
    }
    if (event.isRecurring) {
      return (event.completedDates || []).includes(dateStr);
    }
    return Boolean(event.isCompleted);
  }

  instanceForDate(event, dateStr) {
    const instance = {
      ...clone(event),
      date: dateStr,
      sourceDate: event.date,
      isCompleted: this.isCompletedOnDate(event, dateStr),
    };
    const override = event.occurrenceOverrides?.[dateStr];
    if (override) {
      Object.assign(instance, clone(override));
      instance.hasOccurrenceOverride = true;
    }

    if (event.isDeadline) {
      instance.isDeadlineInstance = true;
      instance.deadlineParentId = event.id;
      instance.daysRemaining = daysBetween(parseDate(dateStr), parseDate(event.deadlineDate));
    }

    if (event.isRecurring) {
      instance.isRecurringInstance = true;
      instance.recurringParentId = event.id;
      instance.progress = this.calculateRecurringProgress(event, dateStr);
    }

    return instance;
  }

  getEventsByDate(dateStr, options = {}) {
    const date = this.validDate(dateStr);
    if (!date) return [];
    const includeOverdue = options.includeOverdue !== false;
    return this.eventsForDate(this.loadEvents(), date, includeOverdue);
  }

  eventsForDate(events, date, includeOverdue) {
    const result = [];

    for (const event of events) {
      if (!this.isWithinActiveBounds(event, date)) continue;
      if (this.isSkippedOn(event, date)) continue;
      if (event.isLongTerm) {
        if (event.isCompleted) {
          const inHistory = date >= event.startDate && date <= event.completedDate;
          if (inHistory) result.push(this.instanceForDate(event, date));
        } else if (date >= event.startDate) {
          result.push(this.instanceForDate(event, date));
        }
        continue;
      }

      if (event.isDeadline) {
        const active = !event.isDeadlineCompleted
          && date >= event.startDate
          && date <= event.deadlineDate;
        const completedHere = event.isDeadlineCompleted && event.deadlineCompletedDate === date;
        const overdue = includeOverdue && !event.isDeadlineCompleted && date > event.deadlineDate;
        if (active || completedHere || overdue) {
          const instance = this.instanceForDate(event, date);
          instance.isOverdue = overdue;
          result.push(instance);
        }
        continue;
      }

      if (event.isRecurring) {
        if (this.isRecurringOnDate(event, date)) result.push(this.instanceForDate(event, date));
        continue;
      }

      const scheduled = !event.isCompleted && event.date === date;
      const completedHere = event.isCompleted && event.completedDate === date;
      const overdue = includeOverdue && !event.isCompleted && event.date < date;
      if (scheduled || completedHere || overdue) {
        const instance = this.instanceForDate(event, date);
        instance.isOverdue = overdue;
        result.push(instance);
      }
    }

    return result;
  }

  getEventsBetween(startDate, endDate) {
    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (!start || !end || start > end) return {};
    const result = {};
    const events = this.loadEvents();
    for (let cursor = startOfDay(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const key = formatDate(cursor);
      result[key] = this.eventsForDate(events, key, false);
    }
    return result;
  }

  getTaskCounts(startDate, endDate) {
    const range = this.getEventsBetween(startDate, endDate);
    return Object.fromEntries(
      Object.entries(range).map(([date, events]) => [
        date,
        {
          total: events.length,
          open: events.filter((event) => !event.isCompleted).length,
          completed: events.filter((event) => event.isCompleted).length,
        },
      ]),
    );
  }

  calculateRecurringProgress(event, currentDateStr) {
    let total = 0;
    const start = parseDate(event.startDate);
    const end = parseDate(event.endDate || currentDateStr);
    if (!start || !end) return { completed: 0, total: 0, percentage: 0 };
    for (let cursor = startOfDay(start); cursor <= end; cursor = addDays(cursor, 1)) {
      if (this.isRecurringOnDate(event, formatDate(cursor))) total += 1;
    }
    const completed = (event.completedDates || []).filter((date) => date <= currentDateStr).length;
    return {
      completed,
      total,
      percentage: total ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    };
  }

  toggleComplete(id, dateStr) {
    const date = this.validDate(dateStr) || formatDate(new Date());
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => String(event.id) === String(id) && !event._deleted);
    if (index < 0) return null;
    const event = events[index];
    const now = new Date().toISOString();

    if (event.isDeadline) {
      if (event.isDeadlineCompleted) {
        event.isDeadlineCompleted = false;
        delete event.deadlineCompletedDate;
        delete event.completedAt;
      } else {
        event.isDeadlineCompleted = true;
        event.deadlineCompletedDate = date;
        event.completedAt = now;
      }
    } else if (event.isRecurring) {
      const completedDates = event.completedDates || [];
      const position = completedDates.indexOf(date);
      if (position >= 0) completedDates.splice(position, 1);
      else completedDates.push(date);
      event.completedDates = completedDates;
    } else {
      event.isCompleted = !event.isCompleted;
      if (event.isCompleted) {
        event.completedDate = date;
        event.completedAt = now;
      } else {
        delete event.completedAt;
        delete event.completedDate;
      }
    }

    event.updatedAt = now;
    this.markChanged(event);
    events[index] = this.normalizeEvent(event);
    return this.saveEvents(events) ? this.instanceForDate(events[index], date) : null;
  }

  getTimerRecord(id, dateStr) {
    const event = this.getEvent(id);
    if (!event) return null;
    if (event.isLongTerm) {
      return clone({
        elapsedSeconds: Number(event.focusTotalSeconds) || 0,
        runningSince: event.focusRunningSince || null,
      });
    }
    return clone(event.timerRecords?.[dateStr] || { elapsedSeconds: 0, runningSince: null });
  }

  updateTimer(id, dateStr, shouldRun) {
    const events = this.loadAllEvents();
    const index = events.findIndex((event) => String(event.id) === String(id) && !event._deleted);
    if (index < 0) return null;
    const event = events[index];

    if (event.isLongTerm) {
      const running = Boolean(event.focusRunningSince);
      if (shouldRun && !running) {
        event.focusRunningSince = new Date().toISOString();
      } else if (!shouldRun && running) {
        const startedAt = new Date(event.focusRunningSince).getTime();
        const elapsed = Number.isFinite(startedAt)
          ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
          : 0;
        event.focusTotalSeconds = (Number(event.focusTotalSeconds) || 0) + elapsed;
        event.focusRunningSince = null;
      }
      event.updatedAt = new Date().toISOString();
      this.markChanged(event);
      events[index] = this.normalizeEvent(event);
      const record = {
        elapsedSeconds: Number(events[index].focusTotalSeconds) || 0,
        runningSince: events[index].focusRunningSince || null,
      };
      return this.saveEvents(events) ? clone(record) : null;
    }

    event.timerRecords ||= {};
    const record = event.timerRecords[dateStr] || { elapsedSeconds: 0, runningSince: null };

    if (shouldRun && !record.runningSince) {
      record.runningSince = new Date().toISOString();
    } else if (!shouldRun && record.runningSince) {
      const startedAt = new Date(record.runningSince).getTime();
      const elapsed = Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        : 0;
      record.elapsedSeconds = (Number(record.elapsedSeconds) || 0) + elapsed;
      record.runningSince = null;
    }

    event.timerRecords[dateStr] = record;
    event.updatedAt = new Date().toISOString();
    this.markChanged(event);
    events[index] = this.normalizeEvent(event);
    return this.saveEvents(events) ? clone(record) : null;
  }

  applyActions(actions) {
    const events = this.loadAllEvents();
    const results = [];
    const now = new Date().toISOString();

    for (const action of Array.isArray(actions) ? actions : []) {
      if (action.type === 'create' && action.event) {
        const created = this.normalizeEvent({
          ...action.event,
          id: this.generateId(),
          createdAt: now,
          updatedAt: now,
        });
        delete created._uuid;
        this.markChanged(created);
        events.push(created);
        results.push({
          type: 'create', success: true, event: clone(created),
          syncChanges: [{ event: clone(created), op: 'upsert' }],
        });
        continue;
      }

      const index = events.findIndex(
        (event) => String(event.id) === String(action.id) && !event._deleted,
      );
      if (index < 0) {
        results.push({ type: action.type, success: false, id: action.id });
        continue;
      }

      const scope = ['future', 'past', 'all', 'single'].includes(action.scope) ? action.scope : 'future';
      const effectiveDate = this.validDate(action.effective_date) || formatDate(new Date());

      if (scope === 'single') {
        results.push(action.type === 'update'
          ? this.applySingleUpdate(events, index, action.updates || {}, effectiveDate, now)
          : this.applySingleDelete(events, index, effectiveDate, now));
      } else if (action.type === 'update') {
        const result = this.applyScopedUpdate(events, index, action.updates || {}, scope, effectiveDate, now);
        results.push(result);
      } else if (action.type === 'delete' && scope !== 'all') {
        const result = this.applyScopedDelete(events, index, scope, effectiveDate, now);
        results.push(result);
      } else if (action.type === 'delete') {
        const target = events[index];
        target._deleted = true;
        target._deletedAt = now;
        const trashUntil = new Date();
        trashUntil.setDate(trashUntil.getDate() + 30);
        target._trashUntil = formatDate(trashUntil);
        this.markChanged(target);
        events[index] = target;
        results.push({
          type: 'delete', success: true, event: clone(target),
          syncChanges: [{ event: clone(target), op: 'delete' }],
        });
      }
    }

    if (!results.some((result) => result.success)) return results;
    if (!this.saveEvents(events)) {
      return results.map((result) => ({ ...result, success: false, error: 'save_failed' }));
    }
    return results;
  }

  isWithinActiveBounds(event, dateStr) {
    if (event.activeStartDate && dateStr < event.activeStartDate) return false;
    if (event.activeEndDate && dateStr > event.activeEndDate) return false;
    return true;
  }

  eventBounds(event) {
    const start = event.activeStartDate || event.startDate || event.date;
    let end = null;
    if (event.activeEndDate) end = event.activeEndDate;
    else if (event.isRecurring) end = event.endDate || null;
    else if (event.isDeadline) {
      end = event.isDeadlineCompleted
        ? (event.deadlineCompletedDate || event.deadlineDate)
        : null;
    }
    else if (event.isLongTerm) end = event.isCompleted ? event.completedDate : null;
    else end = event.date;
    return { start, end };
  }

  scopedSide(event, scope, effectiveDate) {
    const { start, end } = this.eventBounds(event);
    if (scope === 'future') {
      if (end && end < effectiveDate) return 'none';
      return start >= effectiveDate ? 'whole' : 'split';
    }
    if (start > effectiveDate) return 'none';
    return end && end <= effectiveDate ? 'whole' : 'split';
  }

  eventFitsScope(event, scope, effectiveDate) {
    if (scope === 'all') return true;
    const { start, end } = this.eventBounds(event);
    if (scope === 'future') return !end || end >= effectiveDate;
    return !start || start <= effectiveDate;
  }

  markDeletedForAction(event, now) {
    event._deleted = true;
    event._deletedAt = now;
    const trashUntil = new Date();
    trashUntil.setDate(trashUntil.getDate() + 30);
    event._trashUntil = formatDate(trashUntil);
    this.markChanged(event);
    return event;
  }

  splitReplacement(source, updates, scope, effectiveDate, now) {
    const replacement = clone({ ...source, ...updates });
    for (const key of Object.keys(replacement)) {
      if (key.startsWith('_')) delete replacement[key];
    }
    delete replacement.id;
    delete replacement.activeStartDate;
    delete replacement.activeEndDate;
    replacement.createdAt = now;
    replacement.updatedAt = now;
    replacement.timerRecords = Object.fromEntries(
      Object.entries(replacement.timerRecords || {}).filter(([date]) => (
        scope === 'future' ? date >= effectiveDate : date <= effectiveDate
      )),
    );
    if (replacement.isRecurring) {
      replacement.completedDates = (replacement.completedDates || []).filter((date) => (
        scope === 'future' ? date >= effectiveDate : date <= effectiveDate
      ));
    }
    const onSide = (date) => (scope === 'future' ? date >= effectiveDate : date <= effectiveDate);
    replacement.skippedDates = (replacement.skippedDates || []).filter(onSide);
    replacement.occurrenceOverrides = Object.fromEntries(
      Object.entries(replacement.occurrenceOverrides || {}).filter(([date]) => onSide(date)),
    );
    if (replacement.isLongTerm && scope === 'future') {
      replacement.focusTotalSeconds = 0;
      replacement.focusRunningSince = null;
      replacement.isCompleted = false;
      delete replacement.completedDate;
      delete replacement.completedAt;
    }
    if (replacement.isDeadline && scope === 'future') {
      replacement.isDeadlineCompleted = false;
      delete replacement.deadlineCompletedDate;
      delete replacement.completedAt;
    }
    if (scope === 'future') replacement.activeStartDate = effectiveDate;
    else replacement.activeEndDate = effectiveDate;
    const normalized = this.normalizeEvent(replacement);
    const bounds = this.eventBounds(normalized);
    if (bounds.start && bounds.end && bounds.end < bounds.start) return null;
    this.markChanged(normalized);
    return normalized;
  }

  applyScopedUpdate(events, index, updates, scope, effectiveDate, now) {
    const source = events[index];
    if (scope === 'all') {
      const updated = this.normalizeEvent({
        ...source, ...clone(updates), id: source.id,
        createdAt: source.createdAt, updatedAt: now,
      });
      this.markChanged(updated);
      events[index] = updated;
      return {
        type: 'update', success: true, event: clone(updated),
        affectedEvents: [clone(updated)], syncChanges: [{ event: clone(updated), op: 'upsert' }],
      };
    }
    const side = this.scopedSide(source, scope, effectiveDate);
    if (side === 'none') {
      return { type: 'update', success: false, id: source.id, error: 'scope_not_applicable' };
    }
    if (side === 'whole') {
      const updated = this.normalizeEvent({
        ...source, ...clone(updates), id: source.id,
        createdAt: source.createdAt, updatedAt: now,
      });
      if (!this.eventFitsScope(updated, scope, effectiveDate)) {
        return { type: 'update', success: false, id: source.id, error: 'updated_range_outside_scope' };
      }
      this.markChanged(updated);
      events[index] = updated;
      return {
        type: 'update', success: true, event: clone(updated),
        affectedEvents: [clone(updated)], syncChanges: [{ event: clone(updated), op: 'upsert' }],
      };
    }

    const replacement = this.splitReplacement(source, updates, scope, effectiveDate, now);
    if (!replacement) {
      return { type: 'update', success: false, id: source.id, error: 'invalid_scoped_range' };
    }
    if (scope === 'future') {
      source.activeEndDate = formatDate(addDays(parseDate(effectiveDate), -1));
    } else {
      source.activeStartDate = formatDate(addDays(parseDate(effectiveDate), 1));
    }
    source.updatedAt = now;
    this.markChanged(source);
    events[index] = this.normalizeEvent(source);
    events.push(replacement);
    return {
      type: 'update', success: true, event: clone(replacement),
      affectedEvents: [clone(events[index]), clone(replacement)], split: true,
      syncChanges: [
        { event: clone(events[index]), op: 'upsert' },
        { event: clone(replacement), op: 'upsert' },
      ],
    };
  }

  applyScopedDelete(events, index, scope, effectiveDate, now) {
    const source = events[index];
    const side = this.scopedSide(source, scope, effectiveDate);
    if (side === 'none') {
      return { type: 'delete', success: false, id: source.id, error: 'scope_not_applicable' };
    }
    if (side === 'whole') {
      this.markDeletedForAction(source, now);
      events[index] = source;
      return {
        type: 'delete', success: true, event: clone(source),
        affectedEvents: [clone(source)], syncChanges: [{ event: clone(source), op: 'delete' }],
      };
    }
    if (scope === 'future') {
      source.activeEndDate = formatDate(addDays(parseDate(effectiveDate), -1));
    } else {
      source.activeStartDate = formatDate(addDays(parseDate(effectiveDate), 1));
    }
    source.updatedAt = now;
    this.markChanged(source);
    events[index] = this.normalizeEvent(source);
    return {
      type: 'delete', success: true, event: clone(events[index]),
      affectedEvents: [clone(events[index])], truncated: true,
      syncChanges: [{ event: clone(events[index]), op: 'upsert' }],
    };
  }

  // scope=single: change only the occurrence on `date`. Series keep a per-day
  // override; a one-off task that falls on that day is simply updated whole.
  applySingleUpdate(events, index, updates, date, now) {
    const source = events[index];
    const fail = (error) => ({ type: 'update', success: false, id: source.id, error });
    if (source.isDeadline) return fail('single_not_supported');
    const fields = Object.keys(updates);
    if (!fields.length || fields.some((field) => !OCCURRENCE_FIELDS.includes(field))) {
      return fail('single_fields_not_supported');
    }
    if (!this.isScheduledIgnoringSkips(source, date)) return fail('not_scheduled_on_date');
    if (!source.isRecurring && !source.isLongTerm) {
      return this.applyScopedUpdate(events, index, updates, 'all', date, now);
    }

    const override = {
      ...(source.occurrenceOverrides?.[date] || {}),
      ...this.cleanOccurrenceOverride(updates),
    };
    for (const field of OCCURRENCE_FIELDS) {
      if (field in override && override[field] === source[field]) delete override[field];
    }
    const overrides = { ...(source.occurrenceOverrides || {}) };
    if (Object.keys(override).length) overrides[date] = override;
    else delete overrides[date];
    const updated = this.normalizeEvent({
      ...source,
      occurrenceOverrides: overrides,
      // Editing a skipped day brings that occurrence back.
      skippedDates: (source.skippedDates || []).filter((skipped) => skipped !== date),
      updatedAt: now,
    });
    this.markChanged(updated);
    events[index] = updated;
    return {
      type: 'update', success: true, event: clone(updated), occurrenceDate: date,
      affectedEvents: [clone(updated)], syncChanges: [{ event: clone(updated), op: 'upsert' }],
    };
  }

  applySingleDelete(events, index, date, now) {
    const source = events[index];
    const fail = (error) => ({ type: 'delete', success: false, id: source.id, error });
    if (source.isDeadline) return fail('single_not_supported');
    if (!this.isScheduledIgnoringSkips(source, date) || this.isSkippedOn(source, date)) {
      return fail('not_scheduled_on_date');
    }
    if (!source.isRecurring && !source.isLongTerm) {
      this.markDeletedForAction(source, now);
      events[index] = source;
      return {
        type: 'delete', success: true, event: clone(source),
        affectedEvents: [clone(source)], syncChanges: [{ event: clone(source), op: 'delete' }],
      };
    }

    const overrides = { ...(source.occurrenceOverrides || {}) };
    delete overrides[date];
    const updated = this.normalizeEvent({
      ...source,
      skippedDates: [...(source.skippedDates || []), date],
      occurrenceOverrides: overrides,
      completedDates: (source.completedDates || []).filter((completed) => completed !== date),
      updatedAt: now,
    });
    this.markChanged(updated);
    events[index] = updated;
    return {
      type: 'delete', success: true, event: clone(updated), skippedDate: date,
      affectedEvents: [clone(updated)], syncChanges: [{ event: clone(updated), op: 'upsert' }],
    };
  }
}

module.exports = { EventStore };
