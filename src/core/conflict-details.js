'use strict';

const labels = {
  event: '任务名称', date: '日期', time: '时间', calendar: '所属日历',
  location: '地点', note: '备注', urgency: '优先级', startDate: '开始日期',
  endDate: '重复结束日期', deadlineDate: '截止日期', activeStartDate: '有效开始日期',
  activeEndDate: '有效结束日期', recurringType: '重复方式', recurringDays: '每周重复日期',
  recurringMonthDays: '每月重复日期', isCompleted: '完成状态', completedDate: '完成日期',
  isDeadlineCompleted: '截止任务完成状态', deadlineCompletedDate: '截止任务完成日期',
  completedDates: '已完成的重复日期', targetDurationSeconds: '目标时长（秒）',
  targetDurationMinutes: '目标时长（分钟）', focusTotalSeconds: '累计专注时长（秒）',
  focusRunningSince: '当前计时开始时间', timerRecords: '每日计时记录',
  createdAt: '创建时间', updatedAt: '修改时间', completedAt: '完成时间',
};

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function describe(key, value) {
  if (key === 'time' && value === '') return '全天';
  if (value === undefined) return '未设置（字段缺失）';
  if (value === null) return '未设置（空值）';
  if (value === '') return '空白';
  if (key === 'urgency') return value === 'high' ? '高' : '普通';
  if (key === 'recurringType') return ({ daily: '每天', weekly: '每周', monthly: '每月' })[value] || String(value);
  if (key === 'recurringDays' && Array.isArray(value)) return value.length ? value.map((day) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day] || day).join('、') : '未设置';
  if (key === 'recurringMonthDays' && Array.isArray(value)) return value.length ? value.map((day) => `${day} 日`).join('、') : '未设置';
  if (key === 'isCompleted' || key === 'isDeadlineCompleted') return value ? '已完成' : '未完成';
  if (key === 'timerRecords' && typeof value === 'object') {
    return Object.keys(value).sort().map((date) => `${date}：累计 ${value[date]?.elapsedSeconds || 0} 秒${value[date]?.runningSince ? `，计时中（${value[date].runningSince}）` : '，已暂停'}`).join('\n') || '无计时记录';
  }
  if (Array.isArray(value)) return value.join('、') || '无';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function conflictDetails(conflict) {
  const local = conflict.local || {};
  const server = conflict.server || {};
  const type = (event) => event.isLongTerm ? '长期任务' : event.isDeadline ? '截止任务' : event.isRecurring ? '重复任务' : '单日任务';
  const rows = [{ key: 'existence', label: '记录状态', local: conflict.localDeleted || !conflict.local ? '已删除' : '保留', server: !conflict.server ? '已删除' : '保留' },
    { key: 'type', label: '日程类型', local: conflict.local ? type(local) : '—', server: conflict.server ? type(server) : '—' }];
  rows.forEach((row) => { row.different = row.local !== row.server; });
  const keys = new Set([...Object.keys(labels).filter((key) => key in local || key in server), ...Object.keys(local), ...Object.keys(server)]);
  for (const key of keys) {
    if (key.startsWith('_') || ['id', 'isLongTerm', 'isDeadline', 'isRecurring'].includes(key)) continue;
    let left = local[key];
    let right = server[key];
    if (['recurringDays', 'recurringMonthDays', 'completedDates'].includes(key)) {
      left = Array.isArray(left) ? [...left].sort() : left;
      right = Array.isArray(right) ? [...right].sort() : right;
    }
    rows.push({ key, label: labels[key] || `其他字段：${key}`, local: describe(key, left), server: describe(key, right), different: canonical(left) !== canonical(right), metadata: ['createdAt', 'updatedAt'].includes(key) });
  }
  const differences = rows.filter((row) => row.different && !row.metadata);
  return { rows, differenceCount: differences.length, changedLabels: differences.map((row) => row.label) };
}

module.exports = { conflictDetails };
