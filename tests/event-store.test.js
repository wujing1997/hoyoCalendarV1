'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/core/event-store');
const { CommandRouter } = require('../src/core/command-router');

function withStore(callback) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-v3-test-'));
  const store = new EventStore({ dataDir });
  try {
    callback(store);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('normal tasks stay visible after completion and can be restored', () => {
  withStore((store) => {
    const event = store.addEvent({ event: '项目周会', date: '2026-07-30', time: '09:00' });
    let instance = store.toggleComplete(event.id, '2026-07-30');
    assert.equal(instance.isCompleted, true);
    assert.equal(store.getEventsByDate('2026-07-30')[0].isCompleted, true);

    instance = store.toggleComplete(event.id, '2026-07-30');
    assert.equal(instance.isCompleted, false);
    assert.equal(store.getEventsByDate('2026-07-30')[0].isCompleted, false);
  });
});

test('overdue normal tasks stay in the completion section on the day they are finished', () => {
  withStore((store) => {
    const event = store.addEvent({ event: '补交周报', date: '2026-07-29', time: '17:00' });
    assert.equal(store.getEventsByDate('2026-07-31')[0].isOverdue, true);

    store.toggleComplete(event.id, '2026-07-31');
    const completed = store.getEventsByDate('2026-07-31');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].isCompleted, true);
    assert.equal(store.getEventsByDate('2026-08-01').length, 0);

    store.toggleComplete(event.id, '2026-07-31');
    const restored = store.getEventsByDate('2026-07-31');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].isOverdue, true);
  });
});

test('deadline completion remains restorable even when completed late', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '提交论文',
      date: '2026-07-30',
      startDate: '2026-07-30',
      deadlineDate: '2026-08-01',
      isDeadline: true,
    });

    const overdue = store.getEventsByDate('2026-08-05')[0];
    assert.equal(overdue.isOverdue, true);
    store.toggleComplete(event.id, '2026-08-05');

    const completed = store.getEventsByDate('2026-08-05');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].isCompleted, true);
    assert.equal(store.getEventsByDate('2026-08-06').length, 0);

    store.toggleComplete(event.id, '2026-08-05');
    const restored = store.getEventsByDate('2026-08-05');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].isCompleted, false);
    assert.equal(restored[0].isOverdue, true);
  });
});

test('recurring completion only affects the selected date', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '晚间复盘',
      date: '2026-07-30',
      startDate: '2026-07-30',
      endDate: '2026-08-03',
      isRecurring: true,
      recurringType: 'daily',
    });
    store.toggleComplete(event.id, '2026-07-31');
    assert.equal(store.getEventsByDate('2026-07-31')[0].isCompleted, true);
    assert.equal(store.getEventsByDate('2026-08-01')[0].isCompleted, false);
  });
});

test('monthly recurring events occur on the selected day numbers only', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '账单日',
      date: '2026-08-01',
      startDate: '2026-08-01',
      endDate: '2026-10-31',
      isRecurring: true,
      recurringType: 'monthly',
      recurringMonthDays: [1, 15],
    });
    for (const day of ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15', '2026-10-01', '2026-10-15']) {
      const instances = store.getEventsByDate(day);
      assert.equal(instances.length, 1, `${day} should have one instance`);
      assert.equal(instances[0].isRecurringInstance, true);
    }
    assert.equal(store.getEventsByDate('2026-08-02').length, 0);
    assert.equal(store.getEventsByDate('2026-09-16').length, 0);
  });
});

test('monthly recurring events skip non-existent days in short months', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '月末结账',
      date: '2026-08-29',
      startDate: '2026-08-29',
      endDate: '2027-04-30',
      isRecurring: true,
      recurringType: 'monthly',
      recurringMonthDays: [29, 30, 31],
    });
    assert.equal(store.getEventsByDate('2027-01-29').length, 1);
    assert.equal(store.getEventsByDate('2027-01-30').length, 1);
    assert.equal(store.getEventsByDate('2027-01-31').length, 1);
    assert.equal(store.getEventsByDate('2027-02-28').length, 0);
    assert.equal(store.getEventsByDate('2027-03-01').length, 0);
    assert.equal(store.getEventsByDate('2027-03-29').length, 1);
    assert.equal(store.getEventsByDate('2027-03-31').length, 1);
  });
});

test('monthly recurring events without explicit days fall back to the start day', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '月度总结',
      date: '2026-08-10',
      startDate: '2026-08-10',
      endDate: '2026-10-31',
      isRecurring: true,
      recurringType: 'monthly',
    });
    assert.equal(store.getEventsByDate('2026-08-10').length, 1);
    assert.equal(store.getEventsByDate('2026-09-10').length, 1);
    assert.equal(store.getEventsByDate('2026-09-11').length, 0);
  });
});

test('recurringMonthDays are normalized, deduped and clamped to 1-31', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '多日期任务',
      date: '2026-08-05',
      startDate: '2026-08-05',
      endDate: '2026-12-31',
      isRecurring: true,
      recurringType: 'monthly',
      recurringMonthDays: [5, 5, 20, 0, 32, 15],
    });
    assert.deepEqual(event.recurringMonthDays, [5, 20, 15]);
    const weekly = store.addEvent({
      event: '周任务',
      date: '2026-08-05',
      startDate: '2026-08-05',
      endDate: '2026-12-31',
      isRecurring: true,
      recurringType: 'weekly',
      recurringMonthDays: [5, 20],
    });
    assert.equal(weekly.recurringMonthDays, undefined);
  });
});

// ------------------------------------------------------------------ long-term tasks

test('long-term tasks appear every day from start until completion, same id', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '备考',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
    });
    assert.equal(event.isLongTerm, true);
    for (const day of ['2026-08-10', '2026-08-11', '2026-09-01', '2026-12-31']) {
      const instances = store.getEventsByDate(day);
      assert.equal(instances.length, 1, `${day} should show the long-term task`);
      assert.equal(instances[0].id, event.id);
      assert.equal(instances[0].isLongTermInstance, undefined);
    }
    assert.equal(store.getEventsByDate('2026-08-09').length, 0);
  });
});

test('completed long-term tasks stay on the completion day and vanish from future dates', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '备考',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
    });
    store.toggleComplete(event.id, '2026-08-20');
    const completed = store.getEventsByDate('2026-08-20');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].isCompleted, true);
    assert.equal(store.getEventsByDate('2026-08-21').length, 0);
    assert.equal(store.getEventsByDate('2026-08-19').length, 1);
    const restored = store.toggleComplete(event.id, '2026-08-20');
    assert.equal(restored.isCompleted, false);
    assert.equal(store.getEventsByDate('2026-08-21').length, 1);
  });
});

test('long-term flag is mutually exclusive with deadline and recurring fields', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '长期项目',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
      isDeadline: true,
      deadlineDate: '2026-09-01',
      isRecurring: true,
      recurringType: 'daily',
      recurringDays: [1],
      recurringMonthDays: [5],
      completedDates: ['2026-08-11'],
      focusTotalSeconds: 3600,
      focusRunningSince: '2026-08-15T10:00:00.000Z',
    });
    assert.equal(event.isLongTerm, true);
    assert.equal(event.isDeadline, undefined);
    assert.equal(event.isRecurring, undefined);
    assert.equal(event.recurringDays, undefined);
    assert.equal(event.recurringMonthDays, undefined);
    assert.equal(event.completedDates, undefined);
    assert.equal(event.focusTotalSeconds, 3600);
    assert.equal(event.focusRunningSince, '2026-08-15T10:00:00.000Z');

    const normal = store.addEvent({
      event: '普通任务',
      date: '2026-08-10',
      isLongTerm: false,
      focusTotalSeconds: 120,
      focusRunningSince: 'bad-date',
      isCompleted: false,
    });
    assert.equal(normal.isLongTerm, undefined);
    assert.equal(normal.focusTotalSeconds, undefined);
    assert.equal(normal.focusRunningSince, undefined);
  });
});

test('focus fields are sanitized and target duration derives minutes from seconds', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '健身',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
      targetDurationSeconds: 5430,
      focusTotalSeconds: -5,
      focusRunningSince: 'not-a-date',
    });
    assert.equal(event.targetDurationSeconds, 5430);
    assert.equal(event.targetDurationMinutes, 91);
    assert.equal(event.focusTotalSeconds, 0);
    assert.equal(event.focusRunningSince, null);

    const legacy = store.addEvent({
      event: '旧任务',
      date: '2026-08-10',
      targetDurationMinutes: 30,
    });
    assert.equal(legacy.targetDurationMinutes, 30);
    assert.equal(legacy.targetDurationSeconds, undefined);
  });
});

test('long-term focus timer accumulates across days without touching per-day records', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '备考',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
    });
    const start = Date.now();
    store.updateTimer(event.id, '2026-08-10', true);
    store.updateTimer(event.id, '2026-08-10', false);
    const first = store.getTimerRecord(event.id, '2026-08-10');
    assert.ok(first.elapsedSeconds >= 0);
    assert.equal(first.runningSince, null);

    store.updateTimer(event.id, '2026-08-12', true);
    store.updateTimer(event.id, '2026-08-12', false);
    const second = store.getTimerRecord(event.id, '2026-08-12');
    assert.ok(second.elapsedSeconds >= first.elapsedSeconds);
    assert.equal(store.getTimerRecord(event.id, '2026-08-11').elapsedSeconds, second.elapsedSeconds);
    const persisted = store.getEvent(event.id);
    assert.ok(persisted.focusTotalSeconds >= 0);
    assert.equal(persisted.focusRunningSince, null);
    assert.deepEqual(persisted.timerRecords || {}, {});
    assert.ok(Date.now() - start < 100000);
  });
});

test('normal tasks keep per-day timer behavior', () => {
  withStore((store) => {
    const event = store.addEvent({ event: '会议', date: '2026-08-10', targetDurationMinutes: 30 });
    store.updateTimer(event.id, '2026-08-10', true);
    store.updateTimer(event.id, '2026-08-10', false);
    assert.ok(store.getTimerRecord(event.id, '2026-08-10').elapsedSeconds >= 0);
    assert.equal(store.getTimerRecord(event.id, '2026-08-11').elapsedSeconds, 0);
    const persisted = store.getEvent(event.id);
    assert.ok(persisted.timerRecords?.['2026-08-10']);
    assert.equal(persisted.focusTotalSeconds, undefined);
  });
});

test('long-term focus state survives a store restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-longterm-'));
  try {
    const first = new EventStore({ dataDir });
    const event = first.addEvent({
      event: '备考',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
      targetDurationSeconds: 7200,
    });
    first.updateTimer(event.id, '2026-08-10', true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    first.updateTimer(event.id, '2026-08-10', false);

    const second = new EventStore({ dataDir });
    const reloaded = second.getEvent(event.id);
    assert.equal(reloaded.isLongTerm, true);
    assert.equal(reloaded.targetDurationSeconds, 7200);
    assert.ok(reloaded.focusTotalSeconds > 0);
    assert.equal(second.getEventsByDate('2026-08-11').length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('command router executes common creation and query locally', () => {
  withStore((store) => {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const router = new CommandRouter(store);
    const created = router.execute('明天前写完论文', todayKey);
    assert.equal(created.route, 'local-create');
    assert.equal(created.success, true);
    const query = router.execute('今天有什么安排吗', todayKey);
    assert.equal(query.route, 'local-query');
    assert.equal(query.events.length, 1);
  });
});

test('agent actions are applied in one local transaction', () => {
  withStore((store) => {
    const first = store.addEvent({ event: '旧任务', date: '2026-07-30' });
    const results = store.applyActions([
      { type: 'update', id: first.id, scope: 'all', updates: { event: '新标题' } },
      { type: 'create', event: { event: '新增任务', date: '2026-07-31' } },
    ]);
    assert.equal(results.filter((result) => result.success).length, 2);
    assert.equal(store.getEvent(first.id).event, '新标题');
    assert.equal(store.loadEvents().length, 2);
  });
});

test('future recurring update splits at effective date and preserves unbounded history', () => {
  withStore((store) => {
    const series = store.addEvent({
      event: '健身', date: '2026-08-01', startDate: '2026-08-01',
      isRecurring: true, recurringType: 'daily',
    });
    assert.equal(store.getEvent(series.id).endDate, undefined);
    const [result] = store.applyActions([{
      type: 'update', id: series.id, scope: 'future', effective_date: '2026-08-20',
      updates: { event: '晨练', recurringType: 'daily', recurringDays: [] },
    }]);
    assert.equal(result.success, true);
    assert.equal(result.split, true);
    assert.equal(result.syncChanges.length, 2);
    assert.equal(store.getEventsByDate('2026-08-19', { includeOverdue: false })[0].event, '健身');
    assert.equal(store.getEventsByDate('2026-08-20', { includeOverdue: false })[0].event, '晨练');
    assert.equal(store.getEventsByDate('2027-08-20', { includeOverdue: false })[0].event, '晨练');
  });
});

test('future delete truncates long-term and deadline display without deleting history', () => {
  withStore((store) => {
    const longTerm = store.addEvent({
      event: '备考', date: '2026-08-01', startDate: '2026-08-01', isLongTerm: true,
    });
    const deadline = store.addEvent({
      event: '论文', date: '2026-08-01', startDate: '2026-08-01',
      isDeadline: true, deadlineDate: '2026-09-01',
    });
    const results = store.applyActions([
      { type: 'delete', id: longTerm.id, effective_date: '2026-08-20' },
      { type: 'delete', id: deadline.id, scope: 'future', effective_date: '2026-08-20' },
    ]);
    assert.equal(results.every((result) => result.success && result.truncated), true);
    assert.equal(store.getEventsByDate('2026-08-19', { includeOverdue: false }).length, 2);
    assert.equal(store.getEventsByDate('2026-08-20').length, 0);
    assert.equal(store.getEventsByDate('2026-09-02').length, 0);
    assert.equal(store.listTrash().length, 0);
  });
});

test('future delete can stop an overdue deadline while retaining earlier display', () => {
  withStore((store) => {
    const deadline = store.addEvent({
      event: '逾期报告', date: '2026-08-01', startDate: '2026-08-01',
      isDeadline: true, deadlineDate: '2026-08-10',
    });
    assert.equal(store.getEventsByDate('2026-08-19')[0].isOverdue, true);
    const [result] = store.applyActions([{
      type: 'delete', id: deadline.id, effective_date: '2026-08-20',
    }]);
    assert.equal(result.success, true);
    assert.equal(result.truncated, true);
    assert.equal(store.getEventsByDate('2026-08-19').length, 1);
    assert.equal(store.getEventsByDate('2026-08-20').length, 0);
  });
});

test('future scope rejects a historical one-off while explicit all can update it', () => {
  withStore((store) => {
    const event = store.addEvent({ event: '旧会议', date: '2026-08-01' });
    const [blocked] = store.applyActions([{
      type: 'update', id: event.id, effective_date: '2026-08-20', updates: { event: '不应修改' },
    }]);
    assert.equal(blocked.success, false);
    assert.equal(store.getEvent(event.id).event, '旧会议');
    const [updated] = store.applyActions([{
      type: 'update', id: event.id, scope: 'all', effective_date: '2026-08-20',
      updates: { event: '历史更正' },
    }]);
    assert.equal(updated.success, true);
    assert.equal(store.getEvent(event.id).event, '历史更正');
  });
});

test('future scope cannot move a future one-off into history', () => {
  withStore((store) => {
    const event = store.addEvent({ event: '未来会议', date: '2026-08-25' });
    const [result] = store.applyActions([{
      type: 'update', id: event.id, effective_date: '2026-08-20',
      updates: { date: '2026-08-01' },
    }]);
    assert.equal(result.success, false);
    assert.equal(result.error, 'updated_range_outside_scope');
    assert.equal(store.getEvent(event.id).date, '2026-08-25');
  });
});

test('past delete removes history side and preserves future side of a long-term task', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '长期计划', date: '2026-08-01', startDate: '2026-08-01', isLongTerm: true,
    });
    const [result] = store.applyActions([{
      type: 'delete', id: event.id, scope: 'past', effective_date: '2026-08-20',
    }]);
    assert.equal(result.success, true);
    assert.equal(result.truncated, true);
    assert.equal(store.getEventsByDate('2026-08-20').length, 0);
    assert.equal(store.getEventsByDate('2026-08-21').length, 1);
  });
});

test('all-scope update converts recurring event to deadline', () => {
  withStore((store) => {
    const event = store.addEvent({
      event: '例会', date: '2026-08-20', isRecurring: true,
      recurringType: 'weekly', recurringDays: [4], endDate: '2026-12-31',
    });
    const [result] = store.applyActions([{
      type: 'update', id: event.id, scope: 'all', updates: {
        isRecurring: false, isLongTerm: false, isDeadline: true,
        startDate: '2026-08-21', deadlineDate: '2026-08-31',
      },
    }]);
    assert.equal(result.success, true);
    const converted = store.getEvent(event.id);
    assert.equal(converted.isDeadline, true);
    assert.equal(converted.isRecurring, undefined);
    assert.equal(converted.deadlineDate, '2026-08-31');
  });
});

// ------------------------------------------------------------------ single occurrence exceptions

function addWork(store, extra = {}) {
  return store.addEvent({
    event: '去上班', date: '2026-08-01', time: '18:00',
    isRecurring: true, recurringType: 'daily', ...extra,
  });
}

test('single-scope update overrides one occurrence and leaves the series intact', () => {
  withStore((store) => {
    const work = addWork(store);
    const [result] = store.applyActions([{
      type: 'update', id: work.id, scope: 'single', effective_date: '2026-08-21',
      updates: { time: '19:00' },
    }]);

    assert.equal(result.success, true);
    assert.equal(result.occurrenceDate, '2026-08-21');
    assert.deepEqual(result.syncChanges.map((change) => change.op), ['upsert']);
    assert.equal(store.loadEvents().length, 1);
    const source = store.getEvent(work.id);
    assert.equal(source.time, '18:00');
    assert.deepEqual(source.occurrenceOverrides, { '2026-08-21': { time: '19:00' } });

    const changed = store.getEventsByDate('2026-08-21')[0];
    assert.equal(changed.time, '19:00');
    assert.equal(changed.hasOccurrenceOverride, true);
    assert.equal(store.getEventsByDate('2026-08-22')[0].time, '18:00');
    assert.equal(store.getEventsByDate('2026-08-22')[0].hasOccurrenceOverride, undefined);
  });
});

test('setting an occurrence back to the series value drops the override', () => {
  withStore((store) => {
    const work = addWork(store);
    const single = (updates) => store.applyActions([{
      type: 'update', id: work.id, scope: 'single', effective_date: '2026-08-21', updates,
    }])[0];

    single({ time: '19:00', location: '分店' });
    single({ time: '18:00' });
    assert.deepEqual(store.getEvent(work.id).occurrenceOverrides, { '2026-08-21': { location: '分店' } });
    single({ location: '' });
    assert.equal(store.getEvent(work.id).occurrenceOverrides, undefined);
  });
});

test('single-scope update rejects series fields, deadlines and days off the schedule', () => {
  withStore((store) => {
    const work = addWork(store);
    const weekly = addWork(store, { recurringType: 'weekly', recurringDays: [1] });
    const deadline = store.addEvent({
      event: '报告', date: '2026-08-20', isDeadline: true, deadlineDate: '2026-08-31',
    });
    const results = store.applyActions([
      { type: 'update', id: work.id, scope: 'single', effective_date: '2026-08-21', updates: { recurringType: 'weekly' } },
      { type: 'update', id: work.id, scope: 'single', effective_date: '2026-07-31', updates: { time: '19:00' } },
      { type: 'update', id: weekly.id, scope: 'single', effective_date: '2026-08-20', updates: { time: '19:00' } },
      { type: 'update', id: deadline.id, scope: 'single', effective_date: '2026-08-21', updates: { time: '19:00' } },
    ]);
    assert.deepEqual(results.map((result) => result.error), [
      'single_fields_not_supported', 'not_scheduled_on_date',
      'not_scheduled_on_date', 'single_not_supported',
    ]);
    assert.equal(store.getEvent(work.id).occurrenceOverrides, undefined);
  });
});

test('single-scope delete skips one day, keeps progress honest and can be restored', () => {
  withStore((store) => {
    const work = addWork(store, { endDate: '2026-08-10' });
    store.toggleComplete(work.id, '2026-08-05');
    store.applyActions([{
      type: 'update', id: work.id, scope: 'single', effective_date: '2026-08-05', updates: { time: '19:00' },
    }]);
    const [skipped] = store.applyActions([{
      type: 'delete', id: work.id, scope: 'single', effective_date: '2026-08-05',
    }]);

    assert.equal(skipped.success, true);
    assert.equal(skipped.skippedDate, '2026-08-05');
    assert.deepEqual(skipped.syncChanges.map((change) => change.op), ['upsert']);
    const source = store.getEvent(work.id);
    assert.deepEqual(source.skippedDates, ['2026-08-05']);
    assert.equal(source.occurrenceOverrides, undefined);
    assert.deepEqual(source.completedDates, []);
    assert.equal(store.getEventsByDate('2026-08-05').length, 0);
    assert.equal(store.getEventsByDate('2026-08-06')[0].progress.total, 9);
    assert.equal(store.applyActions([{
      type: 'delete', id: work.id, scope: 'single', effective_date: '2026-08-05',
    }])[0].error, 'not_scheduled_on_date');

    store.applyActions([{
      type: 'update', id: work.id, scope: 'single', effective_date: '2026-08-05', updates: { time: '20:00' },
    }]);
    assert.equal(store.getEvent(work.id).skippedDates, undefined);
    assert.equal(store.getEventsByDate('2026-08-05')[0].time, '20:00');
  });
});

test('single scope works for long-term tasks and treats one-off tasks as the whole event', () => {
  withStore((store) => {
    const study = store.addEvent({ event: '学英语', date: '2026-08-01', isLongTerm: true });
    store.applyActions([{ type: 'delete', id: study.id, scope: 'single', effective_date: '2026-08-03' }]);
    assert.equal(store.getEventsByDate('2026-08-03').length, 0);
    assert.equal(store.getEventsByDate('2026-08-04').length, 1);

    const dinner = store.addEvent({ event: '聚餐', date: '2026-08-21', time: '18:00' });
    const [moved] = store.applyActions([{
      type: 'update', id: dinner.id, scope: 'single', effective_date: '2026-08-21', updates: { time: '19:00' },
    }]);
    assert.equal(moved.success, true);
    assert.equal(store.getEvent(dinner.id).time, '19:00');
    assert.equal(store.getEvent(dinner.id).occurrenceOverrides, undefined);
    const [deleted] = store.applyActions([{
      type: 'delete', id: dinner.id, scope: 'single', effective_date: '2026-08-21',
    }]);
    assert.deepEqual(deleted.syncChanges.map((change) => change.op), ['delete']);
    assert.equal(store.getEvent(dinner.id), null);
  });
});

test('splitting a series keeps each side its own occurrence exceptions', () => {
  withStore((store) => {
    const work = addWork(store, {
      occurrenceOverrides: { '2026-08-05': { time: '19:00' }, '2026-08-25': { time: '20:00' } },
      skippedDates: ['2026-08-06', '2026-08-26'],
    });
    const [result] = store.applyActions([{
      type: 'update', id: work.id, scope: 'future', effective_date: '2026-08-20', updates: { location: '新公司' },
    }]);

    assert.equal(result.split, true);
    const [, future] = result.affectedEvents;
    assert.deepEqual(future.occurrenceOverrides, { '2026-08-25': { time: '20:00' } });
    assert.deepEqual(future.skippedDates, ['2026-08-26']);
    assert.equal(store.getEventsByDate('2026-08-25')[0].time, '20:00');
    assert.equal(store.getEventsByDate('2026-08-26').length, 0);
    assert.equal(store.getEventsByDate('2026-08-05')[0].time, '19:00');
  });
});

test('occurrence exceptions are normalized and dropped from non-series tasks', () => {
  withStore((store) => {
    const work = addWork(store, {
      occurrenceOverrides: {
        'not-a-date': { time: '07:00' },
        '2026-08-02': { time: '25:00', urgency: 'urgent', bogus: 1 },
        '2026-08-03': {},
      },
      skippedDates: ['2026-08-09', 'bad', '2026-08-04', '2026-08-04'],
    });
    assert.deepEqual(work.occurrenceOverrides, { '2026-08-02': { time: '', urgency: 'normal' } });
    assert.deepEqual(work.skippedDates, ['2026-08-04', '2026-08-09']);

    const plain = store.addEvent({
      event: '普通', date: '2026-08-01',
      occurrenceOverrides: { '2026-08-01': { time: '09:00' } }, skippedDates: ['2026-08-01'],
    });
    assert.equal(plain.occurrenceOverrides, undefined);
    assert.equal(plain.skippedDates, undefined);
  });
});
