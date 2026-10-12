'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { conflictDetails } = require('../src/core/conflict-details');

test('comparison identifies completion, recurrence, duration, calendar and timer differences', () => {
  const result = conflictDetails({
    local: { event: '相同标题', isRecurring: true, recurringType: 'weekly', recurringDays: [1, 3], calendar: '工作', completedDates: ['2026-10-01'], targetDurationSeconds: 1800, timerRecords: { '2026-10-01': { elapsedSeconds: 120, runningSince: null } } },
    server: { event: '相同标题', isRecurring: true, recurringType: 'weekly', recurringDays: [1, 5], calendar: '个人', completedDates: [], targetDurationSeconds: 3600, timerRecords: { '2026-10-01': { elapsedSeconds: 60, runningSince: null } } },
  });
  assert.equal(result.differenceCount, 5);
  assert.equal(result.rows.find((row) => row.key === 'event').different, false);
  assert.match(result.rows.find((row) => row.key === 'recurringDays').local, /周三/);
  assert.match(result.rows.find((row) => row.key === 'timerRecords').local, /120 秒/);
});

test('comparison distinguishes deletion, shows unknown fields and ignores object-key order', () => {
  const result = conflictDetails({ localDeleted: true, local: { event: '标题', extra: 'one' }, server: { event: '标题', extra: 'two' } });
  assert.equal(result.rows[0].local, '已删除');
  assert.equal(result.rows[0].different, true);
  assert.ok(result.changedLabels.includes('其他字段：extra'));
  const equal = conflictDetails({ local: { completedDates: ['b', 'a'], timerRecords: { b: {}, a: {} } }, server: { completedDates: ['a', 'b'], timerRecords: { a: {}, b: {} } } });
  assert.equal(equal.differenceCount, 0);
  const deleted = conflictDetails({ local: { event: '任务' }, server: null });
  assert.equal(deleted.rows[0].server, '已删除');
});

test('metadata-only conflicts remain explained without inflating content difference count', () => {
  const result = conflictDetails({ local: { event: '标题', updatedAt: '2026-10-01' }, server: { event: '标题', updatedAt: '2026-10-02' } });
  assert.equal(result.differenceCount, 0);
  assert.equal(result.rows.find((row) => row.key === 'updatedAt').different, true);
});
