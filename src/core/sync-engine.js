'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { CloudApiError, DEFAULT_SERVER_URL, migrateLegacyServerUrl } = require('./cloud-api');

const SYNC_STATUS = {
  SIGNED_OUT: 'signed-out',
  SYNCED: 'synced',
  PENDING: 'pending',
  OFFLINE: 'offline',
  CONFLICT: 'conflict',
  ERROR: 'error',
};

const TRASH_RETENTION_DAYS = 30;
const PUSH_LIMIT = 200;
const PULL_LIMIT = 500;

const RETRY_DELAYS_MS = [5000, 15000, 45000, 120000, 300000, 900000];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return clone(fallback);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed ?? clone(fallback);
  } catch (_) {
    return clone(fallback);
  }
}

function writeJsonFile(filePath, value) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempFile, filePath);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {
      // Best-effort cleanup only.
    }
    console.error('[SyncEngine] Failed to persist:', error);
    return false;
  }
}

function eventTypeName(event) {
  if (event.isDeadline) return 'deadline';
  if (event.isRecurring) return 'recurring';
  if (event.targetDurationMinutes) return 'timed';
  return 'normal';
}

function sanitizeQueueEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const eventId = String(value.eventId || '');
  const operationId = String(value.operationId || '');
  if (!eventId || !operationId) return null;
  const op = value.op === 'delete' ? 'delete' : 'upsert';
  return {
    eventId,
    operationId,
    op,
    data: op === 'delete' ? null : value.data && typeof value.data === 'object' ? value.data : null,
    version: Number(value.version) || 1,
    baseVersion: Number(value.baseVersion) || 0,
    attempts: Math.max(0, Number(value.attempts) || 0),
    nextRetryAt: Number(value.nextRetryAt) || 0,
  };
}

class SyncEngine {
  constructor(options = {}) {
    this.eventStore = options.eventStore;
    this.api = options.api;
    this.dataDir = options.dataDir;
    this.stateFile = options.stateFile || path.join(this.dataDir, 'sync-state.json');
    this.queueFile = options.queueFile || path.join(this.dataDir, 'sync-queue.json');
    this.credentialStore = options.credentialStore || {
      getRefreshToken: async () => null,
      setRefreshToken: async () => {},
      clearRefreshToken: async () => {},
    };
    this.deviceName = options.deviceName || '未知设备';
    this.onStateChange = options.onStateChange || (() => {});
    this.onAccountChange = options.onAccountChange || (() => {});
    this.onMigrationSummary = options.onMigrationSummary || (() => {});
    this.isOnline = options.isOnline || (() => true);
    this.state = readJsonFile(this.stateFile, {
      serverUrl: options.serverUrl || DEFAULT_SERVER_URL,
      cursor: 0,
      lastSyncAt: null,
      lastError: null,
      account: null,
      conflicts: [],
      migrationSummary: null,
      migrationDone: false,
    });
    this.state.serverUrl = migrateLegacyServerUrl(this.state.serverUrl);
    if (this.api) this.api.baseUrl = this.state.serverUrl;
    this.queue = this.loadQueue();
    this.account = this.state.account || null;
    this.flushTimer = null;
    this.heartbeatTimer = null;
    this.syncing = false;
    this.cyclePromise = null;
    this.lastPullAt = 0;
    this.dataRevision = 0;
    this.agentSessionId = typeof this.state.agentSessionId === 'string'
      && this.state.agentSessionId.length > 0
      ? this.state.agentSessionId
      : randomUUID();
    this.state.agentSessionId = this.agentSessionId;
    this.agentReceipts = [];
    this.lastAgentPlan = null;
  }

  persistState() {
    writeJsonFile(this.stateFile, this.state);
  }

  loadQueue() {
    let raw = null;
    try {
      if (fs.existsSync(this.queueFile)) {
        raw = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
      }
    } catch (_) {
      raw = null;
    }

    let candidates = [];
    if (Array.isArray(raw)) {
      candidates = raw;
    } else if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.queue)) candidates = raw.queue;
      else if (Array.isArray(raw.items)) candidates = raw.items;
      else if (typeof raw.eventId === 'string' && typeof raw.operationId === 'string') {
        candidates = [raw];
      } else {
        candidates = Object.values(raw);
      }
    }

    const entries = candidates.map(sanitizeQueueEntry).filter((entry) => entry !== null);

    const byOperationId = new Map();
    for (const entry of entries) byOperationId.set(entry.operationId, entry);
    const byEventId = new Map();
    for (const entry of byOperationId.values()) byEventId.set(entry.eventId, entry);
    const deduped = [...byEventId.values()];

    const migrated = !Array.isArray(raw) || entries.length !== candidates.length || deduped.length !== entries.length;
    if (migrated && raw !== null) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFile = path.join(this.dataDir, `sync-queue.backup-${stamp}.json`);
      try {
        if (!fs.existsSync(backupFile)) fs.copyFileSync(this.queueFile, backupFile);
      } catch (_) {
        // 备份失败不阻断队列迁移
      }
      this.queue = deduped;
      this.persistQueue();
    }
    return deduped;
  }

  persistQueue() {
    if (!Array.isArray(this.queue)) {
      console.error('[SyncEngine] Refusing to persist non-array queue:', typeof this.queue);
      return false;
    }
    return writeJsonFile(this.queueFile, this.queue);
  }

  getAccount() {
    return this.account ? { ...this.account } : null;
  }

  getStatus() {
    if (!this.account) return SYNC_STATUS.SIGNED_OUT;
    if (this.state.conflicts.length > 0) return SYNC_STATUS.CONFLICT;
    if (!this.isOnline()) return SYNC_STATUS.OFFLINE;
    if (this.queue.length > 0) return SYNC_STATUS.PENDING;
    if (this.state.lastError) return SYNC_STATUS.ERROR;
    if (!this.state.verifiedAt) return SYNC_STATUS.PENDING;
    return SYNC_STATUS.SYNCED;
  }

  getSnapshot() {
    return {
      status: this.getStatus(),
      account: this.getAccount(),
      serverUrl: this.state.serverUrl,
      cursor: this.state.cursor,
      lastSyncAt: this.state.lastSyncAt,
      lastError: this.state.lastError,
      queueLength: this.queue.length,
      conflictCount: this.state.conflicts.length,
      online: this.isOnline(),
      migrationSummary: this.state.migrationSummary,
      migrationDone: this.state.migrationDone,
      dataRevision: this.dataRevision,
      verifiedAt: this.state.verifiedAt || null,
      reauthRequired: Boolean(this.state.reauthRequired),
      verifiedCursor: this.state.verifiedCursor ?? null,
    };
  }

  notify() {
    this.onStateChange(this.getSnapshot());
  }

  setServerUrl(url) {
    const next = String(url || '').trim() || DEFAULT_SERVER_URL;
    if (next !== this.state.serverUrl) {
      this.state.cursor = 0;
      this.state.verifiedAt = null;
      this.state.calibrated = false;
    }
    this.state.serverUrl = next;
    this.api.baseUrl = next;
    this.persistState();
    this.notify();
    return next;
  }

  // ------------------------------------------------------------------ auth

  async restoreSession() {
    const refreshToken = await this.credentialStore.getRefreshToken();
    if (!refreshToken) {
      if (this.account) {
        await this.expireSession();
      }
      this.notify();
      return false;
    }
    this.api.refreshToken = refreshToken;
    const refreshed = await this.api.refreshSession();
    if (refreshed && refreshed.ok) {
      return this.activateSession({ notify: false });
    }
    if (refreshed && refreshed.invalid) {
      await this.expireSession();
      return false;
    }
    this.state.lastError = '网络暂不可用，登录态已保留，恢复网络后自动同步';
    this.persistState();
    this.notify();
    return false;
  }

  async activateSession(options = {}) {
    try {
      const profile = await this.api.me();
      const previousUserId = this.account?.userId || null;
      this.account = { userId: profile.id, email: profile.email, status: profile.status };
      if (previousUserId && previousUserId !== profile.id) this.resetAgentSession();
      this.state.account = this.account;
      this.state.reauthRequired = false;
      this.state.lastError = null;
      this.persistState();
      if (options.notify !== false) this.onAccountChange(this.getAccount());
      if (options.sync !== false) {
        await this.initialSync();
      }
      if (!this.account || this.state.reauthRequired) return false;
      this.startHeartbeat();
      this.notify();
      return true;
    } catch (error) {
      if (error instanceof CloudApiError && (error.status === 401 || error.status === 403)) {
        await this.expireSession();
      }
      this.state.lastError = error.message || '登录后同步失败';
      this.persistState();
      this.notify();
      return false;
    }
  }

  async login(credentials) {
    const tokens = await this.api.login(credentials);
    await this.credentialStore.setRefreshToken(tokens.refresh_token);
    return this.activateSession();
  }

  async register(credentials) {
    const tokens = await this.api.register(credentials);
    await this.credentialStore.setRefreshToken(tokens.refresh_token);
    return this.activateSession();
  }

  async signOut() {
    const hadAccount = Boolean(this.account);
    if (this.account) {
      await this.api.logout();
    }
    await this.credentialStore.clearRefreshToken();
    this.api.setTokens(null);
    this.account = null;
    this.state.account = null;
    this.state.reauthRequired = false;
    this.state.conflicts = [];
    this.state.lastError = null;
    this.state.migrationSummary = null;
    this.resetAgentSession();
    this.persistState();
    if (hadAccount) this.onAccountChange(null);
    this.stopHeartbeat();
    this.notify();
  }

  async expireSession() {
    if (this.state.reauthRequired && !this.account && !this.api.bearerToken && !this.api.refreshToken) return;
    this.api.setTokens(null);
    await this.credentialStore.clearRefreshToken();
    this.account = null;
    this.state.account = null;
    this.state.reauthRequired = true;
    this.state.verifiedAt = null;
    this.state.lastError = '登录已失效，请重新登录；本地日程和待同步修改已保留';
    this.stopHeartbeat();
    this.persistState();
    this.onAccountChange(null);
    this.notify();
  }

  // ------------------------------------------------------------------ migration

  migrateLocalEvents() {
    const eventsFile = path.join(this.dataDir, 'events.json');
    let backupFile = this.state.migrationBackupFile || null;
    if (fs.existsSync(eventsFile) && !backupFile) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      backupFile = path.join(this.dataDir, `events.backup-${stamp}.json`);
      if (!fs.existsSync(backupFile)) {
        try {
          fs.copyFileSync(eventsFile, backupFile);
        } catch (_) {
          backupFile = null;
        }
      }
    }
    this.state.migrationBackupFile = backupFile;
    this.persistState();
    const migrated = this.eventStore.ensureSyncMetadata();
    this.eventStore.purgeTrash();
    return {
      total: migrated.total,
      assignedUuids: migrated.assignedUuids,
      backupFile,
    };
  }

  countTypes(events) {
    const types = { normal: 0, recurring: 0, deadline: 0, timed: 0 };
    for (const event of events) {
      const name = eventTypeName(event);
      if (types[name] !== undefined) types[name] += 1;
    }
    return types;
  }

  async initialSync() {
    this.state.migrationDone = true;
    this.persistState();
    try {
      const summary = await this.firstMerge();
      if (summary) {
        this.state.migrationSummary = summary;
        this.persistState();
        this.onMigrationSummary(clone(summary));
      }
      await this.syncNow({ pull: true });
    } catch (error) {
      this.state.lastError = error.message || '首次同步失败';
      this.persistState();
      this.notify();
    }
  }

  async firstMerge() {
    const serverEvents = await this.collectPull(0, PULL_LIMIT);
    const serverIds = new Set(serverEvents.map((event) => event.eventId));
    const localActive = this.eventStore.loadEvents();
    const localTrashed = this.eventStore.listTrash();
    const uploaded = [];
    const downloaded = [];
    const merged = [];
    const conflicts = [];

    for (const remote of serverEvents) {
      if (remote.deleted) {
        if (remote.data && !this.eventStore.findEventByUuid(remote.eventId)) {
          this.importRemoteTrashed(remote);
          merged.push(remote.eventId);
        }
        continue;
      }
      const local = this.eventStore.findEventByUuid(remote.eventId);
      if (!local) {
        if (remote.data) {
          this.eventStore.applyRemoteEvent(remote.eventId, remote.data, remote.version, remote.operationId);
          downloaded.push(remote.eventId);
        }
        continue;
      }
      if (String(local._opId) === String(remote.operationId)) {
        merged.push(remote.eventId);
        continue;
      }
      if (Number(remote.version) > Number(local._version || 0)) {
        if (this.queue.some((entry) => entry.eventId === remote.eventId)
          || Number(local._version || 0) > Number(local._baseVersion || 0)) {
          this.addConflict(remote.eventId, local, remote.data, remote.version);
          conflicts.push(remote.eventId);
        } else {
          this.applyCloudEvent(remote);
          merged.push(remote.eventId);
        }
      } else {
        merged.push(remote.eventId);
      }
    }

    for (const local of localActive) {
      if (!serverIds.has(local._uuid)) {
        this.enqueueChange(local._uuid, local._opId, 'upsert', local);
        uploaded.push(local._uuid);
      }
    }
    for (const local of localTrashed) {
      if (!serverIds.has(local._uuid)) {
        this.enqueueChange(local._uuid, local._opId, 'delete', null);
      }
    }

    return {
      uploaded: uploaded.length,
      downloaded: downloaded.length,
      merged: merged.length,
      conflicts: conflicts.length,
      total: localActive.length,
      types: this.countTypes(localActive),
      backupFile: this.state.migrationBackupFile || null,
    };
  }

  // ------------------------------------------------------------------ queue & push

  enqueueChange(eventId, operationId, op, event) {
    this.state.verifiedAt = null;
    const entry = {
      eventId,
      operationId,
      op,
      data: op === 'delete' ? null : this.eventStore.sanitizeForSync(event),
      version: Number(event?._version) || 1,
      baseVersion: Number(event?._baseVersion) || 0,
      attempts: 0,
      nextRetryAt: 0,
    };
    const index = this.queue.findIndex((item) => item.operationId === operationId);
    if (index >= 0) {
      this.queue[index] = entry;
    } else {
      const existing = this.queue.findIndex((item) => item.eventId === eventId);
      if (existing >= 0) this.queue.splice(existing, 1);
      this.queue.push(entry);
    }
    this.persistQueue();
    this.state.lastError = null;
    this.persistState();
    this.notify();
  }

  noteLocalChange(id, op) {
    const event = this.eventStore.getAnyEvent(id);
    if (!event || !event._uuid) return;
    this.enqueueChange(event._uuid, event._opId, op, event);
    this.schedulePush();
  }

  schedulePush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.syncNow();
    }, 3000);
  }

  flushPush(options = {}) {
    if (this.cyclePromise && !options.internal) return this.cyclePromise;
    if (this.pushPromise) return this.pushPromise;
    this.pushPromise = this.runFlushPush(options).finally(() => { this.pushPromise = null; });
    return this.pushPromise;
  }

  async runFlushPush(options = {}) {
    if (this.syncing || !this.account || !this.isOnline() || !this.api.getAuthenticated()) return;
    const now = Date.now();
    const due = this.queue.filter((entry) => options.force || entry.nextRetryAt <= now).slice(0, PUSH_LIMIT);
    if (!due.length) return;
    this.syncing = true;
    const scope = this.syncScope();
    try {
      const result = await this.api.push(due);
      this.assertSyncScope(scope);
      const doneIds = new Set();
      for (const item of result.results || []) {
        const entry = due.find((queued) => queued.eventId === item.eventId);
        if (!entry) continue;
        if (item.status === 'conflict') {
          const local = this.eventStore.findEventByUuid(item.eventId);
          this.addConflict(item.eventId, local, item.serverData, item.serverVersion);
          doneIds.add(entry.operationId);
          continue;
        }
        if (item.status === 'error') {
          const pending = this.queue.find((queued) => queued.eventId === item.eventId);
          if (pending) pending.attempts += 1;
          continue;
        }
        if (!['applied', 'idempotent'].includes(item.status)) continue;
        const ack = this.eventStore.applySyncAck(
          item.eventId,
          item.version,
          entry?.operationId || undefined,
        );
        if (!ack && this.eventStore.findEventByUuid(item.eventId)) throw new Error('本地同步确认写入失败');
        const newer = this.queue.find((queued) => queued.eventId === item.eventId && queued.operationId !== entry.operationId);
        if (newer) {
          newer.baseVersion = Number(item.version);
          newer.version = Math.max(newer.version, Number(item.version) + 1);
        }
        doneIds.add(entry.operationId);
      }
      if (doneIds.size) {
        this.queue = this.queue.filter((entry) => !doneIds.has(entry.operationId));
        if (!this.persistQueue()) throw new Error('本地同步队列写入失败');
      }
      this.state.lastError = null;
      this.state.lastSyncAt = new Date().toISOString();
      this.persistState();
      const remaining = this.queue.length;
      if (remaining) {
        for (const entry of due) {
          if (entry.nextRetryAt <= now) {
            const delayIndex = Math.min(entry.attempts, RETRY_DELAYS_MS.length - 1);
            entry.nextRetryAt = now + RETRY_DELAYS_MS[delayIndex];
          }
        }
        this.persistQueue();
      }
    } catch (error) {
      this.state.lastError = error.message || '同步失败';
      this.persistState();
      for (const entry of due) {
        entry.attempts += 1;
        const delayIndex = Math.min(entry.attempts - 1, RETRY_DELAYS_MS.length - 1);
        entry.nextRetryAt = Date.now() + RETRY_DELAYS_MS[delayIndex];
      }
      this.persistQueue();
    } finally {
      this.syncing = false;
      this.notify();
      this.scheduleNextRetry();
    }
  }

  scheduleNextRetry() {
    if (this.flushTimer) return;
    if (!this.account || this.queue.length === 0) return;
    const now = Date.now();
    const next = this.queue.reduce((earliest, entry) => Math.min(earliest, entry.nextRetryAt || now), Number.MAX_SAFE_INTEGER);
    const delay = Math.max(1000, next - now);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.syncNow();
    }, Math.min(delay, 900000));
  }

  // ------------------------------------------------------------------ pull

  async collectPull(cursor, limit) {
    const events = [];
    let next = cursor;
    for (;;) {
      const page = await this.api.pull(next, limit);
      events.push(...(page.events || []));
      const previous = next;
      next = page.cursor ?? next;
      if (page.hasMore && next <= previous) throw new Error('云端分页没有前进，同步已暂停');
      if (!page.hasMore) break;
    }
    return events;
  }

  async pullAll() {
    const scope = this.syncScope();
    const events = await this.collectPull(this.state.cursor, PULL_LIMIT);
    this.assertSyncScope(scope);
    for (const remote of events) {
      this.applyCloudEvent(remote);
    }
    this.state.cursor = events.length ? Math.max(this.state.cursor, events[events.length - 1].seq) : this.state.cursor;
    if (events.length > 0) this.dataRevision += 1;
    this.state.lastSyncAt = new Date().toISOString();
    this.persistState();
    return events;
  }

  applyCloudEvent(remote) {
    const eventId = remote.eventId;
    const local = this.eventStore.findEventByUuid(eventId);
    const pending = this.queue.some((entry) => entry.eventId === eventId);

    if (remote.deleted && !remote.data) {
      if (local) {
        if (pending && Number(remote.version) >= Number(local._version || 0)) {
          this.addConflict(eventId, local, null, remote.version);
        } else if (Number(remote.version) > Number(local._version || 0)) {
          this.eventStore.removeEventPermanently(local.id);
        }
      }
      return;
    }

    if (!local) {
      if (remote.deleted) {
        if (remote.data) this.importRemoteTrashed(remote);
        return;
      }
      if (remote.data) {
        if (!this.eventStore.applyRemoteEvent(eventId, remote.data, remote.version, remote.operationId)) throw new Error('云端日程写入本地失败');
      }
      return;
    }

    if (String(local._opId) === String(remote.operationId) && !remote.deleted) return;

    if (pending) {
      if (Number(remote.version) >= Number(local._version || 0)) {
        this.addConflict(eventId, local, remote.data, remote.version);
      }
      return;
    }

    if (remote.deleted) {
      if (Number(remote.version) > Number(local._version || 0)) {
        if (remote.data) this.eventStore.markTrashedFromRemote(eventId, remote.trashUntil);
        else this.eventStore.removeEventPermanently(local.id);
      }
      return;
    }

    if (Number(remote.version) > Number(local._version || 0)) {
      if (!this.eventStore.applyRemoteEvent(eventId, remote.data, remote.version, remote.operationId)) throw new Error('云端日程写入本地失败');
    } else if (Number(remote.version) === Number(local._version || 0)) {
      const events = this.eventStore.loadAllEvents();
      const index = events.findIndex((item) => item._uuid === eventId);
      if (index >= 0) {
        this.eventStore.applyRemoteMeta(events[index], { eventId, operationId: remote.operationId });
        if (!this.eventStore.saveEvents(events)) throw new Error('云端日程元数据写入失败');
      }
    }
  }

  importRemoteTrashed(remote) {
    const created = this.eventStore.applyRemoteEvent(remote.eventId, remote.data, remote.version, remote.operationId);
    if (created) {
      this.eventStore.markTrashedFromRemote(remote.eventId, remote.trashUntil);
    }
  }

  addConflict(eventId, local, serverData, serverVersion) {
    const existing = this.state.conflicts.findIndex((item) => item.eventId === eventId);
    const entry = {
      eventId,
      localId: local?.id || null,
      local: local ? this.eventStore.sanitizeForSync(local) : null,
      localDeleted: Boolean(local?._deleted),
      localVersion: Number(local?._version) || 0,
      server: serverData || null,
      serverVersion: Number(serverVersion) || 0,
      at: new Date().toISOString(),
    };
    if (existing >= 0) this.state.conflicts[existing] = entry;
    else this.state.conflicts.push(entry);
    this.persistState();
    this.notify();
  }

  async resolveConflict(eventId, choice) {
    if (!['local', 'server'].includes(choice)) throw new Error('请选择以本地或云端为准');
    const conflict = this.state.conflicts.find((item) => item.eventId === eventId);
    if (!conflict) return false;
    const local = this.eventStore.findEventByUuid(eventId);
    if (choice === 'local' && !local) throw new Error('本地记录已不存在，请刷新冲突信息');
    if (choice === 'server') {
      if (conflict.server) {
        if (!this.eventStore.applyRemoteEvent(
          eventId,
          conflict.server,
          conflict.serverVersion,
          this.eventStore.generateUuid(),
        )) throw new Error('冲突处理写入失败');
      } else if (local) {
        const trashUntil = new Date();
        trashUntil.setDate(trashUntil.getDate() + TRASH_RETENTION_DAYS);
        const events = this.eventStore.loadAllEvents();
        const event = events.find((item) => item._uuid === eventId);
        event._deleted = true;
        event._deletedAt = new Date().toISOString();
        event._trashUntil = trashUntil.toISOString().slice(0, 10);
        this.eventStore.applyRemoteMeta(event, { eventId, version: conflict.serverVersion });
        if (!this.eventStore.saveEvents(events)) throw new Error('冲突处理写入失败');
      }
      this.queue = this.queue.filter((entry) => entry.eventId !== eventId);
      if (!this.persistQueue()) throw new Error('冲突处理队列写入失败');
    } else if (choice === 'local' && local) {
      const next = clone(local);
      next._baseVersion = conflict.serverVersion;
      next._version = conflict.serverVersion + 1;
      next._opId = this.eventStore.generateUuid();
      const events = this.eventStore.loadAllEvents();
      const index = events.findIndex((item) => item._uuid === eventId);
      if (index >= 0) {
        events[index] = next;
        if (!this.eventStore.saveEvents(events)) throw new Error('冲突处理写入失败');
        this.enqueueChange(eventId, next._opId, next._deleted ? 'delete' : 'upsert', next);
        if (!this.persistQueue()) throw new Error('冲突处理队列写入失败');
      }
    }
    const previousConflicts = this.state.conflicts;
    this.state.conflicts = this.state.conflicts.filter((item) => item.eventId !== eventId);
    this.state.verifiedAt = null;
    if (!writeJsonFile(this.stateFile, this.state)) {
      this.state.conflicts = previousConflicts;
      throw new Error('冲突确认记录写入失败，请重试');
    }
    this.dataRevision += 1;
    this.notify();
    this.schedulePush();
    return true;
  }

  async resolveConflicts(choice, selection) {
    if (!['local', 'server'].includes(choice) || !Array.isArray(selection) || !selection.length) {
      return { ok: false, resolved: 0, message: '请选择需要处理的冲突和处理方式' };
    }
    // Wait for any current pull/push before accepting the versions the user reviewed.
    if (this.cyclePromise) await this.cyclePromise;
    const selected = new Map(selection.map((item) => [item.eventId, item]));
    const current = this.listConflicts();
    const conflicts = [...selected.values()].map((item) => current.find((entry) => entry.eventId === item.eventId));
    if (conflicts.some((entry, index) => !entry || canonical(entry) !== canonical([...selected.values()][index]))) {
      return { ok: false, resolved: 0, message: '冲突信息已更新，请查看最新差异后重试' };
    }
    const backup = path.join(this.dataDir, `conflict-resolution-backup-${Date.now()}.json`);
    if (!writeJsonFile(backup, { choice, events: this.eventStore.loadAllEvents(), queue: this.queue, state: this.state })) {
      return { ok: false, resolved: 0, message: '无法备份本地数据，未执行批量处理' };
    }
    let resolved = 0;
    try {
      for (const conflict of conflicts) {
        if (await this.resolveConflict(conflict.eventId, choice)) resolved++;
      }
      return { ok: true, resolved, remaining: this.state.conflicts.length };
    } catch (error) {
      return { ok: false, resolved, remaining: this.state.conflicts.length, message: `已处理 ${resolved} 项，其余冲突保留：${error.message}` };
    }
  }

  listConflicts() {
    return clone(this.state.conflicts.map((entry) => {
      const local = this.eventStore.findEventByUuid(entry.eventId);
      return { ...entry, local: local ? this.eventStore.sanitizeForSync(local) : null,
        localDeleted: Boolean(local?._deleted), localVersion: Number(local?._version) || 0 };
    }));
  }

  // ------------------------------------------------------------------ trash

  async listTrash() {
    const localTrash = this.eventStore.listTrash();
    let cloudItems = [];
    if (this.account && this.isOnline() && this.api.getAuthenticated()) {
      try {
        const response = await this.api.trash();
        cloudItems = response.items || [];
      } catch (_) {
        // 云端回收站不可用时仅展示本地
      }
    }
    return { local: localTrash, cloud: cloudItems };
  }

  async restoreFromTrash(id, eventId) {
    if (eventId && this.account && this.isOnline() && this.api.getAuthenticated()) {
      try {
        const restored = await this.api.restore(eventId);
        const local = this.eventStore.findEventByUuid(eventId);
        if (local) {
          this.eventStore.applyRemoteMeta(local, {
            eventId,
            version: restored.version,
            operationId: restored.operationId,
          });
          const events = this.eventStore.loadAllEvents();
          const index = events.findIndex((item) => item._uuid === eventId);
          if (index >= 0) {
            events[index] = local;
            this.eventStore.saveEvents(events);
          }
        } else if (restored.data) {
          this.eventStore.applyRemoteEvent(eventId, restored.data, restored.version, restored.operationId);
        }
        const existing = this.eventStore.findEventByUuid(eventId);
        if (existing) {
          this.eventStore.restoreFromTrash(existing.id);
        }
        this.notify();
        return { ok: true };
      } catch (_) {
        // 云端恢复失败时回退为本地恢复并排队推送
      }
    }
    const event = this.eventStore.getAnyEvent(id) || (eventId ? this.eventStore.findEventByUuid(eventId) : null);
    if (!event) return { ok: false };
    const restored = this.eventStore.restoreFromTrash(event.id);
    if (!restored) return { ok: false };
    this.enqueueChange(restored._uuid, restored._opId, 'upsert', restored);
    this.schedulePush();
    this.notify();
    return { ok: true };
  }

  purgeExpiredTrash() {
    const purged = this.eventStore.purgeTrash();
    if (purged > 0) this.notify();
    return purged;
  }

  // ------------------------------------------------------------------ agent

  resetAgentSession() {
    this.agentSessionId = randomUUID();
    this.state.agentSessionId = this.agentSessionId;
    this.agentReceipts = [];
    this.lastAgentPlan = null;
    this.persistState();
    return this.agentSessionId;
  }

  async agentPlan(message, date) {
    if (!this.account) {
      throw new CloudApiError('登录后可使用云端日程助手', 401, null, 'signed_out');
    }
    const snapshot = this.eventStore.snapshotForAgent(500);
    const receipts = this.agentReceipts.slice();
    const result = await this.api.agentPlan({
      message,
      date,
      sessionId: this.agentSessionId,
      snapshot,
      receipts,
      continuePlanning: true,
    });
    this.removeAgentReceipts(receipts);
    this.lastAgentPlan = {
      planId: result.plan_id || null,
      actions: clone(result.actions || []),
    };
    return {
      plan_id: result.plan_id || null,
      message: result.message,
      actions: result.actions || [],
      usage: result.usage || {},
      budget: result.budget || {},
      configured: result.configured !== false,
    };
  }

  receiptKey(receipt) {
    return [receipt.plan_id, receipt.draft_id, receipt.status, receipt.event_id || ''].join(':');
  }

  removeAgentReceipts(receipts) {
    const sent = new Set(receipts.map((receipt) => this.receiptKey(receipt)));
    this.agentReceipts = this.agentReceipts.filter(
      (receipt) => !sent.has(this.receiptKey(receipt)),
    );
  }

  async flushAgentReceipts() {
    if (!this.account || !this.agentReceipts.length) return true;
    const receipts = this.agentReceipts.slice();
    try {
      await this.api.agentPlan({
        message: '',
        date: null,
        sessionId: this.agentSessionId,
        snapshot: [],
        receipts,
        continuePlanning: false,
      });
      this.removeAgentReceipts(receipts);
      return true;
    } catch (_) {
      return false;
    }
  }

  approveActions(actions, selectedIndices, planId = null) {
    const activePlanId = planId || this.lastAgentPlan?.planId || null;
    if (planId && planId !== this.lastAgentPlan?.planId) {
      return [{ success: false, type: 'stale', message: '该候选操作已被后续对话替代。' }];
    }
    const selected = actions
      .map((action, index) => ({ action, index }))
      .filter(({ index }) => selectedIndices.has(index));
    const chosenGroups = new Set();
    for (const { action } of selected) {
      if (!action.choice_group_id) continue;
      if (chosenGroups.has(action.choice_group_id)) {
        return [{ success: false, type: 'invalid_choice', message: '同一组候选方案只能选择一个。' }];
      }
      chosenGroups.add(action.choice_group_id);
    }
    const approved = selected.map(({ action }) => {
        if (!action.id) return action;
        const local = this.eventStore.findEventByUuid(String(action.id));
        if (local) return { ...action, id: local.id };
        return action;
      });
    const results = approved.length ? this.eventStore.applyActions(approved) : [];
    for (const result of results) {
      if (!result.success) continue;
      const changes = Array.isArray(result.syncChanges)
        ? result.syncChanges
        : result.event?.id
          ? [{ event: result.event, op: result.type === 'delete' ? 'delete' : 'upsert' }]
          : [];
      for (const change of changes) {
        if (change.event?.id) this.noteLocalChange(change.event.id, change.op);
      }
    }
    const resultByIndex = new Map();
    selected.forEach(({ index }, resultIndex) => {
      resultByIndex.set(index, results[resultIndex] || { success: false });
    });
    const receipts = actions.flatMap((action, index) => {
      if (!action.draft_id || !activePlanId) return [];
      const result = resultByIndex.get(index);
      const status = !selectedIndices.has(index)
        ? 'rejected'
        : result?.success ? 'approved' : 'failed';
      return [{
        plan_id: activePlanId,
        draft_id: String(action.draft_id),
        status,
        event_id: result?.event?._uuid || null,
      }];
    });
    this.agentReceipts.push(...receipts);
    if (!planId || planId === this.lastAgentPlan?.planId) this.lastAgentPlan = null;
    return results;
  }

  // ------------------------------------------------------------------ lifecycle

  syncNow(options = {}) {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = Promise.resolve().then(() => this.runSyncCycle(options)).finally(() => {
      this.cyclePromise = null;
      this.notify();
    });
    return this.cyclePromise;
  }

  contentHash(event) {
    const content = this.eventStore.sanitizeForSync(this.eventStore.normalizeEvent(event));
    for (const key of ['id', 'createdAt', 'updatedAt']) delete content[key];
    return createHash('sha256').update(canonical(content)).digest('hex');
  }

  async reconcileSnapshot() {
    const scope = this.syncScope();
    const snapshot = await this.api.snapshot();
    this.assertSyncScope(scope);
    if (!Array.isArray(snapshot.events) || !Number.isSafeInteger(snapshot.cursor)) throw new Error('云端校验响应无效');
    const events = this.eventStore.loadAllEvents();
    const locals = new Map(events.map((event) => [event._uuid, event]));
    const remoteIds = new Set(snapshot.events.map((event) => event.eventId));
    if (!this.state.calibrated && fs.existsSync(this.eventStore.eventsFile)) {
      const backup = path.join(this.dataDir, `events.sync-repair-${Date.now()}.json`);
      fs.copyFileSync(this.eventStore.eventsFile, backup);
      this.state.syncRepairBackup = backup;
    }
    for (const remote of snapshot.events) {
      const local = locals.get(remote.eventId);
      const pending = this.queue.some((entry) => entry.eventId === remote.eventId);
      const dirty = local && Number(local._version || 0) > Number(local._baseVersion || 0);
      const equal = local && Boolean(local._deleted) === Boolean(remote.deleted)
        && Number(local._version) === remote.version
        && (remote.deleted || this.contentHash(local) === this.contentHash(remote.data));
      if (equal) {
        if (!pending) this.eventStore.applyRemoteMeta(local, remote);
        continue;
      }
      if ((pending || dirty) && local && remote.version <= Number(local._baseVersion || 0)) {
        if (!pending) this.enqueueChange(local._uuid, local._opId, local._deleted ? 'delete' : 'upsert', local);
        continue;
      }
      if (pending || dirty || (local && !remote.deleted && Number(local._version) >= remote.version)) {
        this.addConflict(remote.eventId, local, remote.deleted ? null : remote.data, remote.version);
        continue;
      }
      if (remote.deleted) {
        if (local) {
          local._deleted = true;
          local._trashUntil = remote.trashUntil;
          local._deletedAt = local._deletedAt || new Date().toISOString();
          this.eventStore.applyRemoteMeta(local, remote);
        }
      } else {
        const next = this.eventStore.normalizeEvent({ ...remote.data,
          id: local?.id || this.eventStore.generateId(),
          createdAt: local?.createdAt || remote.data?.createdAt || new Date().toISOString(),
        });
        this.eventStore.applyRemoteMeta(next, remote);
        if (local) events[events.indexOf(local)] = next;
        else events.push(next);
      }
    }
    for (const local of events) {
      if (remoteIds.has(local._uuid) || local._deleted || this.queue.some((entry) => entry.eventId === local._uuid)) continue;
      if (!Number(local._baseVersion || 0)) this.enqueueChange(local._uuid, local._opId, 'upsert', local);
      else this.addConflict(local._uuid, local, null, Number(local._baseVersion));
    }
    if (!this.eventStore.saveEvents(events)) throw new Error('本地日程写入失败，未确认同步完成');
    if (!this.persistQueue()) throw new Error('本地同步队列写入失败，未确认同步完成');
    this.dataRevision += 1;
    this.state.cursor = snapshot.cursor;
    this.state.calibrated = true;
    const saved = new Map(this.eventStore.loadAllEvents().map((event) => [event._uuid, event]));
    const expected = snapshot.events.map((remote) => ({ id: remote.eventId, version: remote.version,
      deleted: remote.deleted, hash: remote.deleted ? null : this.contentHash(remote.data) })).sort((a, b) => a.id.localeCompare(b.id));
    const actual = snapshot.events.map((remote) => {
      const local = saved.get(remote.eventId);
      return { id: remote.eventId, version: local?._version ?? (remote.deleted ? remote.version : -1),
        deleted: local ? Boolean(local._deleted) : remote.deleted,
        hash: local && !local._deleted ? this.contentHash(local) : null };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
    const matched = digest(expected) === digest(actual)
      && !this.queue.length && !this.state.conflicts.length;
    this.state.verifiedAt = matched ? new Date().toISOString() : null;
    this.state.verifiedCursor = matched ? snapshot.cursor : null;
    this.state.verifiedHash = matched ? digest(actual) : null;
    if (!this.persistStateChecked()) throw new Error('同步进度写入失败');
    return matched;
  }

  persistStateChecked() {
    return writeJsonFile(this.stateFile, this.state);
  }

  syncScope() {
    return `${this.state.serverUrl}:${this.account?.userId || ''}`;
  }

  assertSyncScope(scope) {
    if (scope !== this.syncScope()) throw new Error('同步期间账号或服务器已切换，请重新同步');
  }

  async runSyncCycle() {
    this.state.verifiedAt = null;
    if (!this.account || !this.api.getAuthenticated() || !this.isOnline()) {
      this.state.lastError = !this.account || !this.api.getAuthenticated() ? '请先登录后同步' : '网络暂不可用';
      this.persistState();
      return false;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.state.lastError = null;
    try {
      if (this.pushPromise) await this.pushPromise;
      if (fs.existsSync(this.eventStore.eventsFile)) {
        const stored = JSON.parse(fs.readFileSync(this.eventStore.eventsFile, 'utf8'));
        if (!Array.isArray(stored)) throw new Error('本地日程文件格式错误，请恢复备份后同步');
      }
      // Check old skipped records before uploading local-only records.
      if (!this.state.calibrated) await this.reconcileSnapshot();
      await this.pullAll();
      for (let batch = 0; batch < 100 && this.queue.length; batch += 1) {
        const operations = this.queue.map((entry) => entry.operationId).join(',');
        await this.flushPush({ internal: true, force: true });
        if (this.state.lastError) throw new Error(this.state.lastError);
        if (operations === this.queue.map((entry) => entry.operationId).join(',')) break;
      }
      await this.pullAll();
      const matched = await this.reconcileSnapshot();
      if (!matched) this.state.lastError = this.state.conflicts.length ? '有同步冲突待处理' : '仍有本机变更待上传，尚未完成同步';
      else {
        this.state.lastError = null;
        this.state.lastSyncAt = this.state.verifiedAt;
      }
      this.persistState();
      return matched;
    } catch (error) {
      this.state.lastError = error.message || '同步失败';
      this.state.verifiedAt = null;
      this.persistState();
      return false;
    } finally {
      this.scheduleNextRetry();
    }
  }

  async heartbeat() {
    if (!this.account || !this.isOnline()) {
      this.notify();
      return;
    }
    if (!this.api.getAuthenticated() && this.api.refreshToken) {
      const refreshed = await this.api.refreshSession();
      if (!refreshed || !refreshed.ok) {
        if (refreshed && refreshed.invalid) {
          await this.expireSession();
        } else {
          this.notify();
        }
        return;
      }
    }
    const now = Date.now();
    if (now - this.lastPullAt > 30000) {
      this.lastPullAt = now;
      await this.syncNow();
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, 60000);
    this.lastPullAt = Date.now();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  onNetworkChange(online) {
    if (online && this.account) {
      this.schedulePush();
      this.syncNow({ pull: true });
    } else {
      this.notify();
    }
  }
}

module.exports = { SyncEngine, SYNC_STATUS };
