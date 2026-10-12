'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { conflictDetails } = require('../src/core/conflict-details');

test('conflict UI renders differing values, full information and both batch choices safely', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
  const start = source.indexOf('  function renderConflicts()');
  const end = source.indexOf('  let pendingConflictBatch', start);
  const conflict = { eventId: 'id', local: { event: '<img onerror=bad()>', note: '本地备注', isCompleted: false }, server: { event: '云端名称', note: '云端备注', isCompleted: true }, localVersion: 2, serverVersion: 3, at: '2026-10-03' };
  conflict.details = conflictDetails(conflict);
  const container = { innerHTML: '' };
  const context = { window: { cloudAPI: { getConflicts: () => [conflict] } }, $: () => container, refreshIcons: () => {}, safeFormatDate: (value) => value,
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') };
  vm.runInNewContext(`${source.slice(start, end)}\nrenderConflicts();`, context);
  assert.match(container.innerHTML, /全部以本地为准/);
  assert.match(container.innerHTML, /全部以云端为准/);
  assert.match(container.innerHTML, /查看完整日程信息/);
  assert.match(container.innerHTML, /本地备注/);
  assert.match(container.innerHTML, /云端备注/);
  assert.match(container.innerHTML, /已完成/);
  assert.match(container.innerHTML, /未完成/);
  assert.match(container.innerHTML, /conflict-different/);
  assert.doesNotMatch(container.innerHTML, /<img onerror/);
});
