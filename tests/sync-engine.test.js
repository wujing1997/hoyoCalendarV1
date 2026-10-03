'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/core/event-store');
const { SyncEngine, SYNC_STATUS } = require('../src/core/sync-engine');

function createEngine(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-sync-test-'));
  const store = new EventStore({ dataDir });
  const api = new FakeCloudApi();
  const engine = new SyncEngine({
    eventStore: store,
    api,
    dataDir,
    deviceName: '测试机',
    isOnline: () => options.online !== false,
    credentialStore: {
      getRefreshToken: async () => options.refreshToken || null,
      setRefreshToken: async () => {},
      clearRefreshToken: async () => {},
    },
  });
  engine.__store = store;
  engine.__api = api;
  engine.__dataDir = dataDir;
  return engine;
}

class FakeCloudApi {
  constructor() {
    this.users = new Map();
    this.events = new Map();
    this.seq = 0;
    this.conflicts = new Map();
    this.pushResponses = [];
    this.failNext = null;
    this.failRefresh = null;
    this.refreshToken = 'test-refresh-token';
    this.authenticated = true;
    this.bearerToken = 'at-initial';
  }

  setTokens(tokens) {
    if (tokens) {
      this.bearerToken = tokens.access_token || 'at-refreshed';
      this.refreshToken = tokens.refresh_token || this.refreshToken;
    } else {
      this.bearerToken = null;
    }
  }

  getAuthenticated() {
    return Boolean(this.bearerToken);
  }

  async me() {
    return { id: 'user-1', email: 'a@b.c', status: 'active' };
  }

  async refreshSession() {
    if (this.failRefresh === 'invalid') return { ok: false, invalid: true, status: 401, message: '登录已失效' };
    if (this.failRefresh === 'network') return { ok: false, invalid: false, error: new Error('ECONNRESET') };
    if (!this.authenticated) return { ok: false, invalid: true, status: 401 };
    this.bearerToken = 'at-refreshed';
    return { ok: true, invalid: false };
  }

  async login() {
    return { access_token: 'a', refresh_token: 'r', expires_in: 900, device_id: 'd-1' };
  }

  async register() {
    return { access_token: 'a', refresh_token: 'r', expires_in: 900, device_id: 'd-1' };
  }

  async logout() {}

  seedServerEvent(eventId, data, version = 1, operationId = `op-${eventId}`, deleted = false) {
    this.seq += 1;
    this.events.set(eventId, {
      eventId,
      version,
      operationId,
      seq: this.seq,
      deleted,
      trashUntil: deleted ? '2099-12-31' : null,
      data,
    });
  }

  async pull(cursor, limit = 500) {
    if (this.failNext === 'pull') {
      this.failNext = null;
      throw new Error('ECONNREFUSED');
    }
    const all = [...this.events.values()].sort((a, b) => a.seq - b.seq);
    const remaining = all.filter((event) => event.seq > (cursor || 0));
    const events = remaining.slice(0, limit);
    return { cursor: events.length ? events[events.length - 1].seq : cursor || 0, hasMore: remaining.length > limit, reconcileRequired: false, events };
  }

  async snapshot() {
    return { cursor: this.seq, events: [...this.events.values()].sort((a, b) => a.seq - b.seq) };
  }

  async push(changes) {
    if (this.failNext === 'push') {
      this.failNext = null;
      throw new Error('ECONNREFUSED');
    }
    if (this.pushResponses.length) return this.pushResponses.shift();
    const results = [];
    for (const change of changes) {
      const server = this.events.get(change.eventId);
      if (server && server.version > change.baseVersion && server.operationId !== change.operationId) {
        results.push({
          eventId: change.eventId,
          status: 'conflict',
          version: server.version,
          serverVersion: server.version,
          data: change.data,
          serverData: server.data,
          deleted: server.deleted,
          message: '版本冲突',
        });
        continue;
      }
      this.seq += 1;
      const nextVersion = Math.max(change.baseVersion, server?.version || 0) + 1;
      this.events.set(change.eventId, {
        eventId: change.eventId,
        version: nextVersion,
        operationId: change.operationId,
        seq: this.seq,
        deleted: change.op === 'delete',
        trashUntil: change.op === 'delete' ? '2099-12-31' : null,
        data: change.op === 'delete' ? null : change.data,
      });
      results.push({ eventId: change.eventId, status: 'applied', version: nextVersion, serverVersion: nextVersion });
    }
    return { results, cursor: this.seq };
  }

  async trash() {
    return {
      items: [...this.events.values()]
        .filter((event) => event.deleted && event.data)
        .map((event) => ({
          eventId: event.eventId,
          version: event.version,
          deletedAt: '2026-08-01T00:00:00Z',
          trashUntil: event.trashUntil,
          data: event.data,
        })),
    };
  }

  async restore(eventId) {
    const event = this.events.get(eventId);
    if (!event || !event.deleted) throw new Error('not trashed');
    this.seq += 1;
    event.deleted = false;
    event.trashUntil = null;
    event.version += 1;
    event.operationId = `op-restore-${eventId}`;
    event.seq = this.seq;
    return { ...event };
  }

  async agentPlan() {
    return { message: 'ok', actions: [], usage: { model: 'x' }, budget: {} };
  }
}

test('a push cannot skip another device change committed between pull and push', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    engine.state.calibrated = true;
    const event = engine.__store.addEvent({ event: '电脑新增', date: '2026-10-03' });
    engine.noteLocalChange(event.id, 'upsert');
    const push = engine.__api.push.bind(engine.__api);
    engine.__api.push = async (changes) => {
      engine.__api.seedServerEvent('phone-event', { event: '手机新增', date: '2026-10-03' });
      return push(changes);
    };
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.__store.loadEvents().length, 2);
    assert.equal(engine.state.verifiedCursor, engine.__api.seq);
    assert.ok(engine.state.verifiedHash);
  });
});

test('a new local edit during upload survives acknowledgement and is uploaded next', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    const event = engine.__store.addEvent({ event: '第一版', date: '2026-10-03' });
    engine.noteLocalChange(event.id, 'upsert');
    const push = engine.__api.push.bind(engine.__api);
    let edited = false;
    engine.__api.push = async (changes) => {
      if (!edited) {
        edited = true;
        engine.__store.updateEvent(event.id, { event: '第二版' });
        engine.noteLocalChange(event.id, 'upsert');
      }
      return push(changes);
    };
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.__api.events.get(event._uuid).data.event, '第二版');
    assert.equal(engine.__store.getEvent(event.id).event, '第二版');
    assert.equal(engine.queue.length, 0);
  });
});

test('snapshot calibration repairs a persisted cursor that already skipped records', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    engine.__api.seedServerEvent('missed', { event: '过去漏掉的任务', date: '2026-10-03', isLongTerm: true });
    engine.state.cursor = 999;
    engine.__store.addEvent({ event: '本机独有', date: '2026-10-03' });
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.__store.loadEvents().length, 2);
    assert.ok(fs.existsSync(engine.state.syncRepairBackup));
    assert.equal(engine.state.cursor, engine.__api.seq);
  });
});

test('manual and background synchronization share one in-flight cycle', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    let calls = 0;
    const snapshot = engine.__api.snapshot.bind(engine.__api);
    engine.__api.snapshot = async () => { calls += 1; return snapshot(); };
    const first = engine.syncNow();
    assert.equal(first, engine.syncNow());
    assert.equal(await first, true);
    assert.equal(calls, 2);
  });
});

test('failed pulls and failed disk writes never report verified success', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    engine.state.calibrated = true;
    engine.__api.failNext = 'pull';
    assert.equal(await engine.syncNow(), false);
    assert.equal(engine.state.verifiedAt, null);
    const save = engine.__store.saveEvents;
    engine.__store.saveEvents = () => false;
    assert.equal(await engine.syncNow(), false);
    assert.match(engine.state.lastError, /写入失败/);
    engine.__store.saveEvents = save;
  });
});

test('equal versions with differing content require an explicit conflict choice', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    engine.__api.seedServerEvent('same', { event: '云端', date: '2026-10-03' });
    const local = engine.__store.applyRemoteEvent('same', { event: '本机', date: '2026-10-03' }, 1, 'op-local');
    assert.equal(await engine.syncNow(), false);
    assert.equal(engine.__store.getEvent(local.id).event, '本机');
    assert.equal(engine.state.conflicts.length, 1);
    await engine.resolveConflict('same', 'server');
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.__store.getEvent(local.id).event, '云端');
  });
});

test('snapshot propagates deleted records even with a previously advanced cursor', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    const local = engine.__store.applyRemoteEvent('removed', { event: '已删除', date: '2026-10-03' }, 1, 'op-old');
    engine.__api.seedServerEvent('removed', null, 2, 'op-delete', true);
    engine.state.cursor = 99;
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.__store.getEvent(local.id), null);
    assert.equal(engine.__store.listTrash().length, 1);
  });
});

test('hashes ignore device IDs and field ordering but include task contents', async () => {
  await withEngine({}, async (engine) => {
    const a = { id: 1, event: '任务', date: '2026-10-03', note: '备注' };
    const b = { date: '2026-10-03', note: '备注', event: '任务', id: 999 };
    assert.equal(engine.contentHash(a), engine.contentHash(b));
    assert.notEqual(engine.contentHash(a), engine.contentHash({ ...b, time: '10:00' }));
  });
});

test('two devices converge after concurrent additions and more than one upload batch', async () => {
  const a = createEngine();
  const b = createEngine();
  b.api = a.api;
  try {
    a.account = b.account = { userId: 'user-1' };
    for (let index = 0; index < 205; index += 1) {
      const event = a.__store.addEvent({ event: `电脑 ${index}`, date: '2026-10-03' });
      a.noteLocalChange(event.id, 'upsert');
    }
    const phone = b.__store.addEvent({ event: '手机任务', date: '2026-10-03', isRecurring: true, startDate: '2026-10-03' });
    b.noteLocalChange(phone.id, 'upsert');
    await Promise.all([a.syncNow(), b.syncNow()]);
    assert.equal(await a.syncNow(), true);
    assert.equal(await b.syncNow(), true);
    assert.equal(a.__store.loadEvents().length, 206);
    assert.equal(b.__store.loadEvents().length, 206);
    assert.equal(a.state.verifiedHash, b.state.verifiedHash);
    assert.equal(a.state.verifiedCursor, b.state.verifiedCursor);
  } finally {
    drainTimers(a); drainTimers(b);
    fs.rmSync(a.__dataDir, { recursive: true, force: true });
    fs.rmSync(b.__dataDir, { recursive: true, force: true });
  }
});

test('new cloud versions remove old fields rather than overlaying them', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'user-1' };
    const old = engine.__store.applyRemoteEvent('converted', { event: '旧任务', date: '2026-10-03', customOldField: 'remove' }, 1, 'old-op');
    engine.__api.seedServerEvent('converted', { event: '新任务', date: '2026-10-03' }, 2, 'new-op');
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.__store.getEvent(old.id).customOldField, undefined);
  });
});

test('incremental pulls consume every page and checkpoint only successful disk writes', async () => {
  await withEngine({}, async (engine) => {
    for (let index = 0; index < 503; index += 1) engine.__api.seedServerEvent(`event-${index}`, { event: `任务 ${index}` });
    const events = await engine.collectPull(0, 500);
    assert.equal(events.length, 503);
    engine.__store.saveEvents = () => false;
    await assert.rejects(engine.pullAll(), /写入本地失败/);
    assert.equal(engine.state.cursor, 0);
  });
});

function drainTimers(engine) {
  if (engine.flushTimer) clearTimeout(engine.flushTimer);
  engine.flushTimer = null;
  if (engine.heartbeatTimer) clearInterval(engine.heartbeatTimer);
  engine.heartbeatTimer = null;
}

async function withEngine(options, callback) {
  const engine = createEngine(options);
  try {
    await callback(engine);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
}

test('migration assigns stable UUIDs and creates a backup once', () => {
  withEngine({}, (engine) => {
    const legacy = [
      { id: 1730000000001, event: '旧任务', date: '2026-08-01', time: '09:00', calendar: '个人' },
      { id: 1730000000002, event: '旧Deadline', date: '2026-08-01', startDate: '2026-08-01', deadlineDate: '2026-08-05', isDeadline: true },
    ];
    fs.writeFileSync(path.join(engine.__dataDir, 'events.json'), JSON.stringify(legacy), 'utf8');
    const first = engine.migrateLocalEvents();
    assert.equal(first.assignedUuids, 2);
    assert.ok(first.backupFile && fs.existsSync(first.backupFile));

    const stored = engine.__store.getAnyEvent(legacy[0].id);
    assert.ok(stored._uuid);
    assert.equal(stored._version, 1);
    assert.equal(stored.event, '旧任务');
    const second = engine.migrateLocalEvents();
    assert.equal(second.assignedUuids, 0);
    assert.equal(engine.__store.getAnyEvent(legacy[0].id)._uuid, stored._uuid);
  });
});

test('local changes enter the queue and status becomes pending', () => {
  withEngine({}, (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '任务', date: '2026-08-01' });
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].eventId, created._uuid);
    assert.equal(engine.queue[0].op, 'upsert');
    assert.equal(engine.getStatus(), SYNC_STATUS.PENDING);
    assert.ok(!engine.queue[0].data._uuid);
  });
});

test('push applies changes, drains queue and acks versions locally', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '同步任务', date: '2026-08-01' });
    engine.noteLocalChange(created.id, 'upsert');
    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    const stored = engine.__store.getAnyEvent(created.id);
    assert.equal(stored._version, 1);
    assert.equal(stored._baseVersion, 1);
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.getStatus(), SYNC_STATUS.SYNCED);
    assert.equal(engine.__api.events.get(created._uuid).data.event, '同步任务');
  });
});

test('push conflict keeps both versions and sets conflict status', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '本机版本', date: '2026-08-01' });
    engine.__api.seedServerEvent(created._uuid, { event: '云端版本', date: '2026-08-01' }, 3, 'op-remote');
    engine.noteLocalChange(created.id, 'upsert');
    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.state.conflicts.length, 1);
    assert.equal(engine.getStatus(), SYNC_STATUS.CONFLICT);
    const conflict = engine.state.conflicts[0];
    assert.equal(conflict.local.event, '本机版本');
    assert.equal(conflict.server.event, '云端版本');
    assert.equal(conflict.serverVersion, 3);
  });
});

test('resolving conflict with local wins writes a new explicit change', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '本机版本', date: '2026-08-01' });
    engine.__api.seedServerEvent(created._uuid, { event: '云端版本', date: '2026-08-01' }, 3, 'op-remote');
    engine.noteLocalChange(created.id, 'upsert');
    await engine.flushPush();
    await engine.resolveConflict(created._uuid, 'local');
    assert.equal(engine.state.conflicts.length, 0);
    assert.equal(engine.queue.length, 1);
    const entry = engine.queue[0];
    assert.equal(entry.baseVersion, 3);
    assert.equal(entry.version, 4);
    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.__api.events.get(created._uuid).data.event, '本机版本');
    assert.equal(engine.__api.events.get(created._uuid).version, 4);
  });
});

test('resolving conflict with server adopts the cloud version', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '本机版本', date: '2026-08-01' });
    engine.__api.seedServerEvent(created._uuid, { event: '云端版本', date: '2026-08-01' }, 3, 'op-remote');
    engine.noteLocalChange(created.id, 'upsert');
    await engine.flushPush();
    await engine.resolveConflict(created._uuid, 'server');
    assert.equal(engine.state.conflicts.length, 0);
    assert.equal(engine.queue.length, 0);
    const stored = engine.__store.getAnyEvent(created.id);
    assert.equal(stored.event, '云端版本');
    assert.equal(stored._version, 3);
  });
});

test('pull downloads remote events and tracks the cursor', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    engine.__api.seedServerEvent('11111111-1111-4111-8111-111111111111', { event: '远端任务', date: '2026-08-02' }, 1, 'op-1');
    engine.__api.seedServerEvent('22222222-2222-4222-8222-222222222222', { event: '远端任务2', date: '2026-08-03' }, 1, 'op-2');
    await engine.pullAll();
    assert.equal(engine.__store.loadEvents().length, 2);
    assert.equal(engine.state.cursor, 2);
    assert.equal(engine.getSnapshot().dataRevision, 1);
    const stored = engine.__store.findEventByUuid('11111111-1111-4111-8111-111111111111');
    assert.equal(stored._version, 1);
    assert.equal(stored.event, '远端任务');
    await engine.pullAll();
    assert.equal(engine.getSnapshot().dataRevision, 1);
  });
});

test('remote delete moves the event into local trash', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '将被删除', date: '2026-08-01' });
    engine.__api.seedServerEvent(created._uuid, { event: '将被删除', date: '2026-08-01' }, 2, 'op-del', true);
    await engine.pullAll();
    assert.equal(engine.__store.loadEvents().length, 0);
    assert.equal(engine.__store.listTrash().length, 1);
  });
});

test('remote tombstone without data removes the local event', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '将被清除', date: '2026-08-01' });
    engine.seq = 0;
    engine.__api.events.set(created._uuid, {
      eventId: created._uuid,
      version: 5,
      operationId: 'op-tomb',
      seq: 1,
      deleted: true,
      trashUntil: null,
      data: null,
    });
    await engine.pullAll();
    assert.equal(engine.__store.loadAllEvents().length, 0);
  });
});

test('local delete moves to trash, restore re-enqueues an upsert', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '删除测试', date: '2026-08-01' });
    engine.__store.deleteEvent(created.id);
    assert.equal(engine.__store.loadEvents().length, 0);
    assert.equal(engine.__store.listTrash().length, 1);
    engine.noteLocalChange(created.id, 'delete');
    assert.equal(engine.queue[0].op, 'delete');

    const restored = await engine.restoreFromTrash(created.id, created._uuid);
    assert.equal(restored.ok, true);
    assert.equal(engine.__store.loadEvents().length, 1);
    assert.ok(engine.queue.some((entry) => entry.op === 'upsert'));
  });
});

test('purge removes trash entries older than the retention window', () => {
  withEngine({}, (engine) => {
    const created = engine.__store.addEvent({ event: '过期回收', date: '2026-08-01' });
    engine.__store.deleteEvent(created.id);
    assert.equal(engine.__store.listTrash().length, 1);
    const future = new Date();
    future.setDate(future.getDate() + 40);
    assert.equal(engine.__store.purgeTrash(future), 1);
    assert.equal(engine.__store.listTrash().length, 0);
  });
});

test('firstMerge uploads local-only events when server is empty', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const a = engine.__store.addEvent({ event: '本地一', date: '2026-08-01' });
    const b = engine.__store.addEvent({ event: '本地二', date: '2026-08-02' });
    engine.__store.ensureSyncMetadata();
    const summary = await engine.firstMerge();
    assert.equal(summary.uploaded, 2);
    assert.equal(summary.downloaded, 0);
    assert.equal(engine.queue.length, 2);
    assert.equal(engine.__store.findEventByUuid(a._uuid).event, '本地一');
    assert.equal(engine.__store.findEventByUuid(b._uuid).event, '本地二');
  });
});

test('firstMerge downloads remote events when local is empty', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    engine.__api.seedServerEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { event: '远端', date: '2026-08-05' }, 1, 'op-x');
    const summary = await engine.firstMerge();
    assert.equal(summary.uploaded, 0);
    assert.equal(summary.downloaded, 1);
    assert.equal(engine.__store.loadEvents().length, 1);
  });
});

test('offline keeps local edits queued and reports offline status', () => {
  withEngine({ online: false }, (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '离线编辑', date: '2026-08-01' });
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.getStatus(), SYNC_STATUS.OFFLINE);
    assert.equal(engine.queue.length, 1);
  });
});

test('signed-out users keep local data untouched', async () => {
  await withEngine({}, async (engine) => {
    const created = engine.__store.addEvent({ event: '本地任务', date: '2026-08-01' });
    assert.equal(engine.getStatus(), SYNC_STATUS.SIGNED_OUT);
    assert.equal(engine.__store.getEvent(created.id).event, '本地任务');
    assert.equal(engine.queue.length, 0);
  });
});

test('agentPlan forwards the sanitized snapshot and returns the plan', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    engine.__store.addEvent({ event: '快照任务', date: '2026-08-01', note: '备注' });
    const calls = [];
    engine.__api.agentPlan = async (body) => {
      calls.push(body);
      assert.ok(Array.isArray(body.snapshot));
      assert.equal(body.snapshot[0].event, '快照任务');
      assert.equal(body.snapshot[0]._uuid, undefined);
      const suffix = calls.length;
      return { plan_id: `plan-${suffix}`, message: '已规划', actions: [{ type: 'create', draft_id: `draft-${suffix}`, event: { event: '新任务', date: '2026-08-02' } }], usage: {}, budget: {} };
    };
    const plan = await engine.agentPlan('帮我创建新任务', '2026-08-01');
    assert.equal(plan.actions.length, 1);
    const sessionId = calls[0].sessionId;
    assert.ok(sessionId);
    assert.equal(calls[0].continuePlanning, true);
    const current = engine.approveActions(plan.actions, new Set([0]), plan.plan_id);
    assert.equal(current[0].success, true);
    const duplicate = engine.approveActions(plan.actions, new Set([0]), plan.plan_id);
    assert.equal(duplicate[0].type, 'stale');
    await engine.agentPlan('继续', '2026-08-01');
    assert.equal(calls[1].sessionId, sessionId);
    assert.equal(engine.__store.loadEvents().length, 2);
    assert.equal(engine.queue.length, 1);
    assert.deepEqual(calls[1].receipts[0], {
      plan_id: 'plan-1', draft_id: 'draft-1', status: 'approved',
      event_id: current[0].event._uuid,
    });
    assert.deepEqual(engine.agentReceipts, []);
  });
});

test('agent session reset changes id and clears pending receipts', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const first = engine.agentSessionId;
    engine.agentReceipts.push({ plan_id: 'p', draft_id: 'd', status: 'rejected' });
    const second = engine.resetAgentSession();
    assert.notEqual(second, first);
    assert.deepEqual(engine.agentReceipts, []);
  });
});

test('agent session id survives an app restart', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-agent-session-'));
  try {
    const first = new SyncEngine({
      eventStore: new EventStore({ dataDir }), api: new FakeCloudApi(), dataDir,
    });
    first.persistState();
    const second = new SyncEngine({
      eventStore: new EventStore({ dataDir }), api: new FakeCloudApi(), dataDir,
    });
    assert.equal(second.agentSessionId, first.agentSessionId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('approval receipts are sent once and rejection is recorded', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const calls = [];
    engine.__api.agentPlan = async (body) => {
      calls.push(body);
      return {
        plan_id: `plan-${calls.length}`,
        message: 'ok',
        actions: [{ type: 'create', draft_id: `draft-${calls.length}`, event: { event: 'x', date: '2026-08-02' } }],
      };
    };
    const first = await engine.agentPlan('第一轮', '2026-08-01');
    engine.approveActions(first.actions, new Set(), first.plan_id);
    assert.equal(engine.agentReceipts[0].status, 'rejected');
    await engine.agentPlan('继续', '2026-08-01');
    assert.deepEqual(calls[1].receipts, [{
      plan_id: 'plan-1', draft_id: 'draft-1', status: 'rejected', event_id: null,
    }]);
    assert.deepEqual(engine.agentReceipts, []);
    await engine.agentPlan('再继续', '2026-08-01');
    assert.deepEqual(calls[2].receipts, []);
  });
});

test('receipt-only flush sends no prompt and retries after failure', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    engine.agentReceipts.push({
      plan_id: 'plan-1', draft_id: 'draft-1', status: 'approved', event_id: 'event-1',
    });
    const calls = [];
    engine.__api.agentPlan = async (body) => {
      calls.push(body);
      if (calls.length === 1) throw new Error('temporary failure');
      return { plan_id: 'plan-1', message: '操作结果已记录。', actions: [] };
    };

    assert.equal(await engine.flushAgentReceipts(), false);
    assert.equal(engine.agentReceipts.length, 1);
    assert.equal(await engine.flushAgentReceipts(), true);
    assert.deepEqual(engine.agentReceipts, []);
    assert.equal(calls[1].message, '');
    assert.equal(calls[1].continuePlanning, false);
    assert.deepEqual(calls[1].snapshot, []);
    assert.equal(calls[1].sessionId, engine.agentSessionId);
  });
});

test('sign out resets the agent session', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const before = engine.agentSessionId;
    await engine.signOut();
    assert.notEqual(engine.agentSessionId, before);
  });
});

test('switching accounts resets the agent session', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const before = engine.agentSessionId;
    engine.__api.me = async () => ({ id: 'u2', email: 'other@b.c', status: 'active' });
    const activated = await engine.activateSession({ sync: false, notify: false });
    assert.equal(activated, true);
    assert.notEqual(engine.agentSessionId, before);
  });
});

test('partial approval only applies selected actions', () => {
  withEngine({}, (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const existing = engine.__store.addEvent({ event: '待改', date: '2026-08-01' });
    engine.__store.ensureSyncMetadata();
    const actions = [
      { type: 'create', event: { event: '同意的新任务', date: '2026-08-03' } },
      { type: 'update', id: existing.id, updates: { event: '被拒绝的修改' } },
    ];
    const results = engine.approveActions(actions, new Set([0]));
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'create');
    assert.equal(engine.__store.loadEvents().length, 2);
    assert.equal(engine.__store.getEvent(existing.id).event, '待改');
  });
});

test('approval maps snapshot UUID ids back to local ids', () => {
  withEngine({}, (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const existing = engine.__store.addEvent({ event: '待改', date: '2026-08-01' });
    const actions = [
      { type: 'update', id: existing._uuid, scope: 'all', updates: { event: '已改' } },
    ];
    const results = engine.approveActions(actions, new Set([0]));
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(engine.__store.getEvent(existing.id).event, '已改');
    assert.equal(engine.queue.length, 1);
  });
});

test('future scoped approval queues both halves of a split series as upserts', () => {
  withEngine({}, (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const existing = engine.__store.addEvent({
      event: '健身', date: '2026-08-01', startDate: '2026-08-01',
      isRecurring: true, recurringType: 'daily',
    });
    const [result] = engine.approveActions([{
      type: 'update', id: existing._uuid, scope: 'future', effective_date: '2026-08-20',
      updates: { event: '晨练' },
    }], new Set([0]));
    assert.equal(result.success, true);
    assert.equal(result.split, true);
    assert.equal(engine.queue.length, 2);
    assert.deepEqual(engine.queue.map((entry) => entry.op), ['upsert', 'upsert']);
    assert.equal(new Set(engine.queue.map((entry) => entry.eventId)).size, 2);
  });
});

test('sync engine defaults to the public HTTPS server url', () => {
  const { DEFAULT_SERVER_URL } = require('../src/core/cloud-api');
  withEngine({}, (engine) => {
    assert.equal(engine.getSnapshot().serverUrl, DEFAULT_SERVER_URL);
    assert.equal(engine.api.baseUrl, DEFAULT_SERVER_URL);
  });
});

test('sync engine migrates a persisted legacy default url at load', () => {
  const { DEFAULT_SERVER_URL } = require('../src/core/cloud-api');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-sync-legacy-'));
  fs.writeFileSync(path.join(dataDir, 'sync-state.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:8000', cursor: 0, account: null, conflicts: [], migrationDone: false }), 'utf8');
  const store = new EventStore({ dataDir });
  const engine = new SyncEngine({ eventStore: store, api: new FakeCloudApi(), dataDir, isOnline: () => true });
  assert.equal(engine.getSnapshot().serverUrl, DEFAULT_SERVER_URL);
  assert.equal(engine.api.baseUrl, DEFAULT_SERVER_URL);
});

test('sync engine preserves a custom persisted server url at load', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-sync-custom-'));
  fs.writeFileSync(path.join(dataDir, 'sync-state.json'), JSON.stringify({ serverUrl: 'https://custom.example.com', cursor: 0, account: null, conflicts: [], migrationDone: false }), 'utf8');
  const store = new EventStore({ dataDir });
  const engine = new SyncEngine({ eventStore: store, api: new FakeCloudApi(), dataDir, isOnline: () => true });
  assert.equal(engine.getSnapshot().serverUrl, 'https://custom.example.com');
  assert.equal(engine.api.baseUrl, 'https://custom.example.com');
});

test('sync engine setServerUrl falls back to the new default for empty input', () => {
  const { DEFAULT_SERVER_URL } = require('../src/core/cloud-api');
  withEngine({}, (engine) => {
    engine.setServerUrl('');
    assert.equal(engine.getSnapshot().serverUrl, DEFAULT_SERVER_URL);
    engine.setServerUrl('   ');
    assert.equal(engine.getSnapshot().serverUrl, DEFAULT_SERVER_URL);
  });
});

test('duplicate local change notifications do not double-enqueue the same event', () => {
  withEngine({}, (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '去开会', date: '2026-08-01' });
    engine.noteLocalChange(created.id, 'upsert');
    engine.noteLocalChange(created.id, 'upsert');
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].eventId, created._uuid);
    assert.equal(engine.queue[0].op, 'upsert');
  });
});

function validQueueEntry(eventId, operationId, overrides = {}) {
  return {
    eventId,
    operationId,
    op: 'upsert',
    data: { event: '遗留任务', date: '2026-08-01' },
    version: 1,
    baseVersion: 0,
    attempts: 0,
    nextRetryAt: 0,
    ...overrides,
  };
}

function queueBackupFiles(dataDir) {
  return fs.readdirSync(dataDir).filter((name) => name.startsWith('sync-queue.backup-'));
}

async function engineWithQueueFile(queueJson, callback) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-sync-queue-'));
  fs.writeFileSync(path.join(dataDir, 'sync-queue.json'), queueJson, 'utf8');
  const store = new EventStore({ dataDir });
  const api = new FakeCloudApi();
  const engine = new SyncEngine({ eventStore: store, api, dataDir, deviceName: '测试机', isOnline: () => true });
  engine.__store = store;
  engine.__api = api;
  try {
    return await callback(engine, dataDir);
  } finally {
    drainTimers(engine);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('legacy object sync-queue loads as empty without crashing and keeps a backup', async () => {
  await engineWithQueueFile('{}', async (engine, dataDir) => {
    assert.deepEqual(engine.queue, []);
    assert.equal(engine.getSnapshot().queueLength, 0);
    assert.equal(queueBackupFiles(dataDir).length, 1);
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    await engine.flushPush();
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.getStatus(), SYNC_STATUS.SYNCED);
  });
});

test('legacy map-format sync-queue recovers entries losslessly and pushes them', async () => {
  const legacy = {
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': validQueueEntry('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'op-legacy-1'),
  };
  await engineWithQueueFile(JSON.stringify(legacy), async (engine, dataDir) => {
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].eventId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(engine.queue[0].operationId, 'op-legacy-1');
    assert.equal(queueBackupFiles(dataDir).length, 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'sync-queue.json'), 'utf8'));
    assert.ok(Array.isArray(onDisk));
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.__api.events.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').data.event, '遗留任务');
  });
});

test('wrapper-object sync-queue recovers the nested queue array', () => {
  const entry = validQueueEntry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'op-wrapper-1');
  engineWithQueueFile(JSON.stringify({ queue: [entry], savedAt: '2026-08-01' }), (engine, dataDir) => {
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].operationId, 'op-wrapper-1');
    assert.equal(queueBackupFiles(dataDir).length, 1);
  });
});

test('flat single-entry object sync-queue is recovered losslessly and re-pushed', async () => {
  const flat = validQueueEntry('ffffffff-ffff-4fff-8fff-ffffffffffff', 'op-flat-1', { attempts: 5, nextRetryAt: 0 });
  await engineWithQueueFile(JSON.stringify(flat), async (engine, dataDir) => {
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].eventId, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    assert.equal(engine.queue[0].operationId, 'op-flat-1');
    assert.equal(engine.queue[0].data.event, '遗留任务');
    assert.equal(engine.queue[0].attempts, 5);
    assert.equal(queueBackupFiles(dataDir).length, 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'sync-queue.json'), 'utf8'));
    assert.ok(Array.isArray(onDisk));
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    assert.equal(engine.__api.events.get('ffffffff-ffff-4fff-8fff-ffffffffffff').data.event, '遗留任务');
  });
});

test('flat single-entry object with numeric legacy id fields still loads without crashing', () => {
  engineWithQueueFile(
    JSON.stringify({
      eventId: '11111111-1111-4111-8111-111111111111',
      operationId: 'op-numeric-1',
      op: 'upsert',
      version: 2,
      baseVersion: 1,
      attempts: 5,
      nextRetryAt: 1786643616183,
    }),
    (engine, dataDir) => {
      assert.equal(engine.queue.length, 1);
      assert.equal(engine.queue[0].version, 2);
      assert.equal(engine.queue[0].baseVersion, 1);
      assert.equal(engine.queue[0].attempts, 5);
      assert.equal(engine.queue[0].nextRetryAt, 1786643616183);
      assert.equal(queueBackupFiles(dataDir).length, 1);
    },
  );
});

test('sync-queue with malformed entries keeps only valid ones and backs up', () => {
  const good = validQueueEntry('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'op-good-1');
  engineWithQueueFile(JSON.stringify([good, null, 'junk', {}, { eventId: '' }]), (engine, dataDir) => {
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].eventId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    assert.equal(queueBackupFiles(dataDir).length, 1);
  });
});

test('sync-queue duplicates are deduped by event id on load', () => {
  const first = validQueueEntry('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'op-old-1', { data: { event: '旧版本', date: '2026-08-01' } });
  const second = validQueueEntry('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'op-new-1', { data: { event: '新版本', date: '2026-08-01' } });
  engineWithQueueFile(JSON.stringify([first, second]), (engine, dataDir) => {
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].operationId, 'op-new-1');
    assert.equal(engine.queue[0].data.event, '新版本');
    assert.equal(queueBackupFiles(dataDir).length, 1);
  });
});

test('valid-array sync-queue loads unchanged without creating a backup', () => {
  const entry = validQueueEntry('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'op-valid-1');
  engineWithQueueFile(JSON.stringify([entry]), (engine, dataDir) => {
    assert.equal(engine.queue.length, 1);
    assert.deepEqual(engine.queue[0], entry);
    assert.equal(queueBackupFiles(dataDir).length, 0);
  });
});

test('malformed sync-queue json falls back to an empty queue without crashing', async () => {
  await engineWithQueueFile('{"queue": [', async (engine, dataDir) => {
    assert.deepEqual(engine.queue, []);
    assert.equal(queueBackupFiles(dataDir).length, 0);
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    await engine.flushPush();
    assert.equal(await engine.syncNow(), true);
    assert.equal(engine.getStatus(), SYNC_STATUS.SYNCED);
  });
});

// ------------------------------------------------------------------ login persistence

function engineWithCredential(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-auth-'));
  if (options.stateFile) {
    fs.writeFileSync(path.join(dataDir, 'sync-state.json'), JSON.stringify(options.stateFile), 'utf8');
  }
  const store = new EventStore({ dataDir });
  const api = new FakeCloudApi();
  if (options.failRefresh) api.failRefresh = options.failRefresh;
  const cleared = [];
  const engine = new SyncEngine({
    eventStore: store,
    api,
    dataDir,
    isOnline: () => options.online !== false,
    credentialStore: {
      getRefreshToken: async () => options.refreshToken || null,
      setRefreshToken: async () => {},
      clearRefreshToken: async () => {
        cleared.push(true);
      },
    },
  });
  engine.__store = store;
  engine.__api = api;
  engine.__cleared = cleared;
  engine.__dataDir = dataDir;
  return engine;
}

test('restart restores the session and keeps the account logged in', async () => {
  const engine = engineWithCredential({
    refreshToken: 'rt-kept',
    stateFile: { serverUrl: 'https://api.example.com', cursor: 3, account: { userId: 'u1', email: 'a@b.c', status: 'active' }, conflicts: [], migrationDone: true },
  });
  try {
    const restored = await engine.restoreSession();
    assert.equal(restored, true);
    assert.equal(engine.account.email, 'a@b.c');
    assert.equal(engine.__api.bearerToken, 'at-refreshed');
    assert.equal(engine.__cleared.length, 0);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

test('transient refresh failure keeps credentials and account (offline startup)', async () => {
  const engine = engineWithCredential({
    refreshToken: 'rt-kept',
    failRefresh: 'network',
    stateFile: { serverUrl: 'https://api.example.com', cursor: 3, account: { userId: 'u1', email: 'a@b.c', status: 'active' }, conflicts: [], migrationDone: true },
  });
  try {
    const restored = await engine.restoreSession();
    assert.equal(restored, false);
    assert.equal(engine.account.email, 'a@b.c');
    assert.equal(engine.__cleared.length, 0);
    assert.ok(engine.state.lastError.includes('网络暂不可用'));
    const pushCallsBefore = engine.__api.events.size;
    await engine.flushPush();
    assert.equal(engine.__api.events.size, pushCallsBefore);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

test('server-rejected refresh clears credentials and signs out', async () => {
  const engine = engineWithCredential({
    refreshToken: 'rt-dead',
    failRefresh: 'invalid',
    stateFile: { serverUrl: 'https://api.example.com', cursor: 3, account: { userId: 'u1', email: 'a@b.c', status: 'active' }, conflicts: [], migrationDone: true },
  });
  try {
    const restored = await engine.restoreSession();
    assert.equal(restored, false);
    assert.equal(engine.account, null);
    assert.equal(engine.__cleared.length, 1);
    assert.ok(engine.state.lastError.includes('登录已失效'));
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

test('missing local credential without persisted account stays signed out', async () => {
  const engine = engineWithCredential({
    refreshToken: null,
    stateFile: { serverUrl: 'https://api.example.com', cursor: 0, account: null, conflicts: [], migrationDone: false },
  });
  try {
    const restored = await engine.restoreSession();
    assert.equal(restored, false);
    assert.equal(engine.account, null);
    assert.equal(engine.getStatus(), SYNC_STATUS.SIGNED_OUT);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

test('persisted account without local credential is treated as signed out', async () => {
  const engine = engineWithCredential({
    refreshToken: null,
    stateFile: { serverUrl: 'https://api.example.com', cursor: 0, account: { userId: 'u1', email: 'a@b.c', status: 'active' }, conflicts: [], migrationDone: false },
  });
  try {
    const restored = await engine.restoreSession();
    assert.equal(restored, false);
    assert.equal(engine.account, null);
    assert.equal(engine.getStatus(), SYNC_STATUS.SIGNED_OUT);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

test('explicit logout clears credentials, tokens and stops the session', async () => {
  const engine = engineWithCredential({
    refreshToken: 'rt-kept',
    stateFile: { serverUrl: 'https://api.example.com', cursor: 3, account: { userId: 'u1', email: 'a@b.c', status: 'active' }, conflicts: [], migrationDone: true },
  });
  try {
    await engine.restoreSession();
    assert.equal(engine.account.email, 'a@b.c');
    await engine.signOut();
    assert.equal(engine.account, null);
    assert.equal(engine.__cleared.length, 1);
    assert.equal(engine.__api.bearerToken, null);
    assert.equal(engine.getStatus(), SYNC_STATUS.SIGNED_OUT);
    await engine.flushPush();
    assert.equal(engine.__api.events.size, 0);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

test('sync is skipped entirely when not authenticated (no unauthenticated requests)', async () => {
  const engine = engineWithCredential({ refreshToken: null });
  try {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    engine.__api.bearerToken = null;
    const created = engine.__store.addEvent({ event: '离线任务', date: '2026-08-01' });
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.queue.length, 1);
    await engine.flushPush();
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.__api.events.size, 0);
    const synced = await engine.syncNow();
    assert.equal(synced, false);
    assert.equal(engine.queue.length, 1);
  } finally {
    drainTimers(engine);
    fs.rmSync(engine.__dataDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ recurring rule editing

test('editing a recurring rule updates the series record once and re-queues with new weekdays', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({
      event: '每周训练',
      date: '2026-08-01',
      isRecurring: true,
      recurringType: 'weekly',
      recurringDays: [0, 3, 4, 5, 6],
      endDate: '2026-09-30',
    });
    engine.__store.ensureSyncMetadata();
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.queue.length, 1);

    const updated = engine.__store.updateEvent(created.id, {
      recurringDays: [3, 4, 5],
      recurringType: 'weekly',
    });
    assert.ok(updated);
    const records = engine.__store.loadAllEvents();
    const sameUuid = records.filter((event) => event._uuid === updated._uuid);
    assert.equal(sameUuid.length, 1);
    assert.deepEqual(updated.recurringDays, [3, 4, 5]);
    assert.equal(updated.event, '每周训练');

    engine.noteLocalChange(updated.id, 'upsert');
    assert.equal(engine.queue.length, 1);
    assert.deepEqual(engine.queue[0].data.recurringDays, [3, 4, 5]);
    assert.equal(engine.queue[0].operationId, updated._opId);
    assert.equal(engine.queue[0].data.endDate, '2026-09-30');

    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    const serverEvent = engine.__api.events.get(updated._uuid);
    assert.deepEqual(serverEvent.data.recurringDays, [3, 4, 5]);
    assert.equal(serverEvent.data.event, '每周训练');
  });
});

test('long-term tasks sync their global focus fields and target seconds', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({
      event: '备考',
      date: '2026-08-10',
      startDate: '2026-08-10',
      isLongTerm: true,
      targetDurationSeconds: 7200,
      focusTotalSeconds: 3661,
    });
    engine.__store.ensureSyncMetadata();
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.queue.length, 1);
    assert.equal(engine.queue[0].data.isLongTerm, true);
    assert.equal(engine.queue[0].data.targetDurationSeconds, 7200);
    assert.equal(engine.queue[0].data.targetDurationMinutes, 120);
    assert.equal(engine.queue[0].data.focusTotalSeconds, 3661);

    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    const serverEvent = engine.__api.events.get(created._uuid);
    assert.equal(serverEvent.data.isLongTerm, true);
    assert.equal(serverEvent.data.focusTotalSeconds, 3661);
    assert.equal(serverEvent.data.targetDurationSeconds, 7200);
  });
});

test('legacy minute-only events keep per-day timer behavior and sync unchanged', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({ event: '旧任务', date: '2026-08-10', targetDurationMinutes: 30 });
    engine.__store.ensureSyncMetadata();
    engine.noteLocalChange(created.id, 'upsert');
    assert.equal(engine.queue[0].data.targetDurationMinutes, 30);
    assert.equal(engine.queue[0].data.targetDurationSeconds, undefined);
    assert.equal(engine.queue[0].data.isLongTerm, undefined);

    engine.__store.updateTimer(created.id, '2026-08-10', true);
    engine.__store.updateTimer(created.id, '2026-08-10', false);
    assert.ok(engine.__store.getTimerRecord(created.id, '2026-08-10').elapsedSeconds >= 0);
    const stored = engine.__store.getEvent(created.id);
    assert.ok(stored.timerRecords?.['2026-08-10']);
    assert.equal(stored.focusTotalSeconds, undefined);
  });
});

test('editing monthly day numbers updates one series record, sync payload and survives reload', async () => {
  await withEngine({}, async (engine) => {
    engine.account = { userId: 'u1', email: 'a@b.c' };
    engine.state.account = engine.account;
    const created = engine.__store.addEvent({
      event: '每月账单',
      date: '2026-08-01',
      isRecurring: true,
      recurringType: 'monthly',
      recurringMonthDays: [1, 15],
      endDate: '2026-12-31',
    });
    engine.__store.ensureSyncMetadata();
    engine.noteLocalChange(created.id, 'upsert');

    const updated = engine.__store.updateEvent(created.id, {
      recurringMonthDays: [5, 20],
      recurringType: 'monthly',
    });
    assert.ok(updated);
    assert.deepEqual(updated.recurringMonthDays, [5, 20]);

    const records = engine.__store.loadAllEvents();
    assert.equal(records.filter((event) => event._uuid === updated._uuid).length, 1);
    assert.equal(records.filter((event) => event.event === '每月账单').length, 1);

    engine.noteLocalChange(updated.id, 'upsert');
    assert.equal(engine.queue.length, 1);
    assert.deepEqual(engine.queue[0].data.recurringMonthDays, [5, 20]);
    assert.equal(engine.queue[0].data.event, '每月账单');

    await engine.flushPush();
    assert.equal(engine.queue.length, 0);
    const serverEvent = engine.__api.events.get(updated._uuid);
    assert.deepEqual(serverEvent.data.recurringMonthDays, [5, 20]);

    const reloaded = new EventStore({ dataDir: engine.__dataDir });
    const persisted = reloaded.getEvent(updated.id);
    assert.deepEqual(persisted.recurringMonthDays, [5, 20]);
    assert.equal(reloaded.loadEvents().filter((event) => event.event === '每月账单').length, 1);
    assert.equal(reloaded.getEventsByDate('2026-08-05').length, 1);
    assert.equal(reloaded.getEventsByDate('2026-08-06').length, 0);
  });
});
