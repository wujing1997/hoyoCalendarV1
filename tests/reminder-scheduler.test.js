'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventStore } = require('../src/core/event-store');
const { ReminderScheduler } = require('../src/core/reminder-scheduler');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new EventStore({ dataDir: dir });
  let events = [];
  store.loadEvents = () => events;
  let clock = new Date(2026, 8, 5, 9, 0);
  let changes = 0;
  const options = { store, stateFile: path.join(dir, 'confirmed.json'), now: () => clock, onChange: () => changes++ };
  const scheduler = new ReminderScheduler(options);
  return { scheduler, options, setEvents: (v) => { events = v; }, setTime: (v) => { clock = v; }, changes: () => changes };
}
const event = (id, extra = {}) => ({ id, event: `任务 ${id}`, date: '2026-09-05', time: '09:00', ...extra });

test('due tasks queue chronologically, exclude all-day/future/completed, and do not duplicate', (t) => {
  const f = fixture(t);
  f.setEvents([event(1), event(2, { time: '08:00' }), event(3, { time: '' }), event(4, { time: '10:00' }), event(5, { isCompleted: true })]);
  f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().reminder.title, '任务 2');
  assert.equal(f.scheduler.snapshot().remaining, 1);
  f.scheduler.tick();
  assert.equal(f.changes(), 1);
  f.scheduler.acknowledge(f.scheduler.snapshot().reminder.key);
  assert.equal(f.scheduler.snapshot().reminder.title, '任务 1');
  const restarted = new ReminderScheduler(f.options);
  restarted.tick();
  assert.equal(restarted.snapshot().remaining, 0);
});

test('recurrence, deadlines and long-term dates obey their own rules and active bounds', (t) => {
  const f = fixture(t);
  f.setEvents([
    event(1, { isRecurring: true, startDate: '2026-09-01', recurringType: 'weekly', recurringDays: [6] }),
    event(2, { isDeadline: true, deadlineDate: '2026-09-05' }),
    event(3, { isLongTerm: true, startDate: '2026-09-05' }),
    event(4, { isLongTerm: true, startDate: '2026-09-04' }),
    event(5, { isDeadline: true, deadlineDate: '2026-09-06' }),
    event(6, { isRecurring: true, startDate: '2026-09-01', recurringType: 'daily', completedDates: ['2026-09-05'] }),
    event(7, { activeEndDate: '2026-09-04' }),
    event(8, { isDeadline: true, deadlineDate: '2026-09-05', isDeadlineCompleted: true }),
  ]);
  f.scheduler.tick();
  assert.deepEqual(f.scheduler.queue.map((r) => r.title), ['任务 1', '任务 2', '任务 3']);
});

test('reschedule, delete and completion withdraw stale reminders; stale clicks cannot dismiss the next one', (t) => {
  const f = fixture(t);
  f.setEvents([event(1), event(2)]);
  f.scheduler.tick();
  const old = f.scheduler.snapshot().reminder.key;
  f.setEvents([event(1, { time: '10:00' }), event(2)]);
  f.scheduler.tick();
  assert.equal(f.scheduler.acknowledge(old), false);
  assert.equal(f.scheduler.snapshot().reminder.title, '任务 2');
  f.setEvents([event(1, { time: '10:00' }), event(2, { isCompleted: true })]);
  f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().reminder, null);
  f.setTime(new Date(2026, 8, 5, 10, 0));
  f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().reminder.title, '任务 1');
  f.setEvents([]);
  f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().reminder, null);
});

test('wake catches up today only and a recurring task reminds again the next day', (t) => {
  const f = fixture(t);
  f.setEvents([event(1, { isRecurring: true, recurringType: 'daily', startDate: '2026-09-01' }), event(2, { date: '2026-09-04' })]);
  f.setTime(new Date(2026, 8, 5, 18, 0));
  f.scheduler.tick();
  assert.equal(f.scheduler.queue.length, 1);
  f.scheduler.acknowledge(f.scheduler.snapshot().reminder.key);
  f.setTime(new Date(2026, 8, 6, 9, 0));
  f.scheduler.tick();
  assert.equal(f.scheduler.queue.length, 1);
  assert.equal(f.scheduler.snapshot().reminder.date, '2026-09-06');
});

test('reminders use the occurrence override time and skip skipped days', (t) => {
  const f = fixture(t);
  const daily = { isRecurring: true, recurringType: 'daily', startDate: '2026-09-01', date: '2026-09-01' };
  f.setEvents([
    event('moved', { ...daily, time: '08:00', occurrenceOverrides: { '2026-09-05': { time: '10:00', event: '晚点上班' } } }),
    event('skipped', { ...daily, time: '08:30', skippedDates: ['2026-09-05'] }),
  ]);
  f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().reminder, null);
  f.setTime(new Date(2026, 8, 5, 10, 0));
  f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().reminder.title, '晚点上班');
  assert.equal(f.scheduler.snapshot().reminder.time, '10:00');
  assert.equal(f.scheduler.snapshot().remaining, 0);
});
