'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BarkPush, validateEndpoint } = require('../src/core/bark-push');
const { ReminderScheduler } = require('../src/core/reminder-scheduler');
const { EventStore } = require('../src/core/event-store');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-bark-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = new Date(2026, 9, 19, 12, 0).getTime();
  let config = { enabled: true, endpoint: 'https://api.day.app/test-key', enabledAt: clock - 60000 };
  const sent = [];
  const options = { stateFile: path.join(dir, 'sent.json'), getConfig: () => config, now: () => clock,
    send: async (_config, reminder) => { sent.push(reminder.key); }, ...overrides };
  return { dir, sent, options, push: new BarkPush(options), setTime: (value) => { clock = value; }, setConfig: (value) => { config = value; } };
}
const reminder = (key, time = '12:00') => ({ key, date: '2026-10-19', time, title: `测试 ${key}`, calendar: '测试' });

test('Bark settings reject non-HTTPS, credentials, query strings and invalid endpoints', () => {
  assert.equal(validateEndpoint('https://api.day.app/test-key/'), 'https://api.day.app/test-key');
  for (const value of ['http://api.day.app/key', 'https://other.example/key', 'https://a:b@api.day.app/key', 'https://api.day.app/key?a=b', 'https://api.day.app/key/extra', '']) assert.throws(() => validateEndpoint(value));
});

test('all simultaneous reminders send once across ticks and restarts; rescheduling sends again', async (t) => {
  const f = fixture(t);
  await Promise.all([f.push.tick([reminder('a'), reminder('b')]), f.push.tick([reminder('a'), reminder('b')])]);
  await f.push.tick([reminder('a'), reminder('b')]);
  assert.deepEqual(f.sent, ['a', 'b']);
  await new BarkPush(f.options).tick([reminder('a'), reminder('b')]);
  assert.equal(f.sent.length, 2);
  await f.push.tick([reminder('rescheduled', '12:01')]);
  assert.equal(f.sent.length, 3);
  assert.equal(fs.readFileSync(f.options.stateFile, 'utf8').includes('test-key'), false);
});

test('disabled configuration and tasks predating first enable do not send', async (t) => {
  const f = fixture(t);
  await f.push.tick([reminder('old', '10:00')]);
  assert.equal(f.sent.length, 0);
  f.setConfig({ enabled: false });
  await f.push.tick([reminder('a')]);
  assert.equal(f.sent.length, 0);
});

test('failed sends back off and cancelled reminders stop retrying', async (t) => {
  let attempts = 0;
  const f = fixture(t, { send: async () => { if (++attempts === 1) throw new Error('offline'); } });
  await f.push.tick([reminder('a')]);
  await f.push.tick([reminder('a')]);
  assert.equal(attempts, 1);
  f.setTime(new Date(2026, 9, 19, 12, 1).getTime());
  await f.push.tick([]);
  assert.equal(attempts, 1);
  await f.push.tick([reminder('a')]);
  await f.push.tick([reminder('a')]);
  assert.equal(attempts, 2);
});

test('invalid keys stop retrying instead of spamming the provider', async (t) => {
  let attempts = 0;
  const f = fixture(t, { send: async () => { attempts++; throw Object.assign(new Error('invalid'), { permanent: true }); } });
  await f.push.tick([reminder('a')]);
  f.setTime(new Date(2026, 9, 19, 13).getTime());
  await f.push.tick([reminder('a')]);
  assert.equal(attempts, 1);
});

test('acknowledging the desktop reminder does not suppress phone delivery', async (t) => {
  const f = fixture(t);
  const store = new EventStore({ dataDir: f.dir });
  store.addEvent({ event: '定时任务', date: '2026-10-19', time: '12:00' });
  const scheduler = new ReminderScheduler({ store, stateFile: path.join(f.dir, 'confirmed.json'), now: () => new Date(2026, 9, 19, 12) });
  scheduler.tick();
  scheduler.acknowledge(scheduler.snapshot().reminder.key);
  assert.equal(scheduler.queue.length, 0);
  await f.push.tick(scheduler.dueReminders);
  assert.equal(f.sent.length, 1);
  assert.equal(store.loadEvents()[0].isCompleted, false);
});
