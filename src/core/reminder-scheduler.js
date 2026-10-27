'use strict';

const fs = require('fs');
const path = require('path');
const { formatDate } = require('./date-utils');

class ReminderScheduler {
  constructor({ store, stateFile, now = () => new Date(), onChange = () => {} }) {
    Object.assign(this, { store, stateFile, now, onChange });
    this.confirmed = new Set();
    this.queue = [];
    this.signature = '';
    try { this.confirmed = new Set(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); }
    catch (_) { /* First run has no confirmations. */ }
  }

  tick() {
    const now = this.now();
    const today = formatDate(now);
    const minute = now.getHours() * 60 + now.getMinutes();
    this.dueReminders = this.store.loadEvents().flatMap((source) => {
      if (this.store.isSkippedOn(source, today)) return [];
      const event = this.store.occurrenceView(source, today);
      if (!/^\d{2}:\d{2}$/.test(event.time || '')) return [];
      const [hour, minutes] = event.time.split(':').map(Number);
      if (hour > 23 || minutes > 59 || hour * 60 + minutes > minute) return [];
      if (!this.store.isWithinActiveBounds(event, today)) return [];
      if (event.isDeadline ? event.isDeadlineCompleted : this.store.isCompletedOnDate(event, today)) return [];
      const occurs = event.isDeadline ? event.deadlineDate === today
        : event.isRecurring ? this.store.isRecurringOnDate(event, today)
          : event.isLongTerm ? event.startDate === today : event.date === today;
      if (!occurs) return [];
      const key = JSON.stringify([event._uuid || String(event.id), today, event.time]);
      return [{ key, title: event.event, time: event.time, date: today, calendar: event.calendar || '个人' }];
    }).sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key));
    this.queue = this.dueReminders.filter((reminder) => !this.confirmed.has(reminder.key));
    const signature = JSON.stringify(this.queue);
    if (signature !== this.signature) {
      this.signature = signature;
      this.onChange(this.snapshot());
    }
  }

  snapshot() { return { reminder: this.queue[0] || null, remaining: Math.max(0, this.queue.length - 1) }; }

  acknowledge(key) {
    if (this.queue[0]?.key !== key) return false;
    this.confirmed.add(key);
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const temp = `${this.stateFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify([...this.confirmed]), 'utf8');
      fs.renameSync(temp, this.stateFile);
    } catch (error) {
      this.confirmed.delete(key);
      throw error;
    }
    this.tick();
    return true;
  }
}

module.exports = { ReminderScheduler };
