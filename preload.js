'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { EventStore } = require('./src/core/event-store');
const { CommandRouter } = require('./src/core/command-router');
const { CloudApi, CloudApiError, DEFAULT_SERVER_URL, migrateLegacyServerUrl } = require('./src/core/cloud-api');
const { SyncEngine } = require('./src/core/sync-engine');

let Lunar;
let Solar;
let HolidayUtil;
try {
  const lunar = require('lunar-javascript');
  Lunar = lunar.Lunar;
  Solar = lunar.Solar;
  HolidayUtil = lunar.HolidayUtil;
} catch (error) {
  console.warn('[Preload] Lunar calendar support unavailable:', error.message);
}

const dataDir = path.join(process.env.APPDATA || process.env.HOME, 'HoyoCalendar');
const eventStore = new EventStore({ dataDir });
const commandRouter = new CommandRouter(eventStore, {
  onLocalChange: (id, op) => notifyLocalChange(id, op),
});

function friendlyCloudError(error) {
  if (error instanceof CloudApiError) {
    if (error.status === 401 || error.status === 403) return error.message || '请重新登录';
    return error.message || '云端服务请求失败';
  }
  const code = String(error?.code || error?.message || '');
  if (/ECONNREFUSED|request_timeout|ETIMEDOUT|ENOTFOUND/.test(code)) {
    return '无法连接云端服务，请检查服务器地址或网络后重试。';
  }
  return '云端服务请求失败，请稍后重试。';
}

const credentialStore = {
  getRefreshToken: () => ipcRenderer.invoke('cloud-credential-get-refresh-token'),
  setRefreshToken: async (token) => {
    const stored = await ipcRenderer.invoke('cloud-credential-set-refresh-token', token);
    if (!stored) throw new Error('无法安全保存登录凭据');
    return true;
  },
  clearRefreshToken: () => ipcRenderer.invoke('cloud-credential-clear'),
};

const cloudApi = new CloudApi({
  baseUrl: DEFAULT_SERVER_URL,
  timeoutMs: 45000,
  onRefreshToken: (token) => credentialStore.setRefreshToken(token),
});

const syncEngine = new SyncEngine({
  eventStore,
  api: cloudApi,
  dataDir,
  credentialStore,
  isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true),
  onStateChange: (snapshot) => {
    if (typeof window !== 'undefined' && window.cloudStateSubscribers) {
      window.cloudStateSubscribers.forEach((callback) => {
        try {
          callback(snapshot);
        } catch (_) {
          // Subscriber errors must not break the bridge.
        }
      });
    }
  },
  onAccountChange: (account) => {
    if (typeof window !== 'undefined' && window.accountSubscribers) {
      window.accountSubscribers.forEach((callback) => {
        try {
          callback(account);
        } catch (_) {
          // Subscriber errors must not break the bridge.
        }
      });
    }
  },
  onMigrationSummary: (summary) => {
    if (typeof window !== 'undefined' && window.migrationSubscribers) {
      window.migrationSubscribers.forEach((callback) => {
        try {
          callback(summary);
        } catch (_) {
          // Subscriber errors must not break the bridge.
        }
      });
    }
  },
});

async function loadCloudConfig() {
  try {
    const config = await ipcRenderer.invoke('config-load');
    if (config?.cloud?.serverUrl) {
      const migrated = migrateLegacyServerUrl(config.cloud.serverUrl);
      if (migrated !== config.cloud.serverUrl) {
        config.cloud.serverUrl = migrated;
        await ipcRenderer.invoke('config-save', config);
      }
      syncEngine.setServerUrl(migrated);
    }
  } catch (_) {
    // 本地配置不可用不影响云端功能
  }
}

async function saveCloudConfig() {
  try {
    const config = await ipcRenderer.invoke('config-load');
    config.cloud ||= {};
    config.cloud.serverUrl = syncEngine.getSnapshot().serverUrl;
    await ipcRenderer.invoke('config-save', config);
  } catch (_) {
    // 配置保存失败仅影响下次启动的默认地址
  }
}

async function initCloud() {
  syncEngine.migrateLocalEvents();
  await loadCloudConfig();
  const restored = await syncEngine.restoreSession();
  const deviceName = await ipcRenderer.invoke('cloud-device-name').catch(() => '未知设备');
  syncEngine.deviceName = deviceName;
  if (!restored) syncEngine.notify();
}

initCloud();

contextBridge.exposeInMainWorld('electronAPI', {
  setReminderTheme: (theme) => ipcRenderer.send('reminder-theme', theme),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  togglePin: () => ipcRenderer.send('window-toggle-pin'),
  setWindowMode: (mode) => ipcRenderer.send('window-set-mode', mode),
  getWindowState: () => ipcRenderer.invoke('get-window-state'),
  onWindowStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window-state-changed', listener);
    return () => ipcRenderer.removeListener('window-state-changed', listener);
  },
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', Boolean(enabled)),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
});

contextBridge.exposeInMainWorld('attachmentAPI', {
  pickTextFiles: () => ipcRenderer.invoke('assistant-pick-attachments'),
});

function notifyLocalChange(id, op) {
  try {
    syncEngine.noteLocalChange(id, op);
  } catch (_) {
    // 同步失败不影响本地写入
  }
}

contextBridge.exposeInMainWorld('eventAPI', {
  loadEvents: () => eventStore.loadEvents(),
  addEvent: (event) => {
    const created = eventStore.addEvent(event);
    if (created) notifyLocalChange(created.id, 'upsert');
    return created;
  },
  updateEvent: (id, updates) => {
    const updated = eventStore.updateEvent(id, updates);
    if (updated) notifyLocalChange(id, 'upsert');
    return updated;
  },
  deleteEvent: (id) => {
    const removed = eventStore.deleteEvent(id);
    if (removed) notifyLocalChange(id, 'delete');
    return removed;
  },
  getEvent: (id) => eventStore.getEvent(id),
  getEventsByDate: (date, options) => eventStore.getEventsByDate(date, options),
  getEventsBetween: (startDate, endDate) => eventStore.getEventsBetween(startDate, endDate),
  getTaskCounts: (startDate, endDate) => eventStore.getTaskCounts(startDate, endDate),
  toggleComplete: (id, date) => {
    const result = eventStore.toggleComplete(id, date);
    if (result) notifyLocalChange(id, 'upsert');
    return result;
  },
  toggleRecurringDateComplete: (id, date) => {
    const result = eventStore.toggleComplete(id, date);
    if (result) notifyLocalChange(id, 'upsert');
    return result;
  },
  completeDeadlineEvent: (id, date) => {
    const result = eventStore.toggleComplete(id, date);
    if (result) notifyLocalChange(id, 'upsert');
    return result;
  },
  getTimerRecord: (id, date) => eventStore.getTimerRecord(id, date),
  startTimer: (id, date) => {
    const result = eventStore.updateTimer(id, date, true);
    if (result) notifyLocalChange(id, 'upsert');
    return result;
  },
  stopTimer: (id, date) => {
    const result = eventStore.updateTimer(id, date, false);
    if (result) notifyLocalChange(id, 'upsert');
    return result;
  },
  applyActions: (actions) => {
    const results = eventStore.applyActions(actions);
    for (const result of results) {
      if (!result.success) continue;
      const changes = Array.isArray(result.syncChanges)
        ? result.syncChanges
        : result.event?.id
          ? [{ event: result.event, op: result.type === 'delete' ? 'delete' : 'upsert' }]
          : [];
      for (const change of changes) {
        if (change.event?.id) notifyLocalChange(change.event.id, change.op);
      }
    }
    return results;
  },
});

contextBridge.exposeInMainWorld('commandAPI', {
  preview: (text, contextDate) => commandRouter.preview(text, contextDate),
  execute: (text, contextDate) => commandRouter.execute(text, contextDate),
});

contextBridge.exposeInMainWorld('aiAPI', {
  status: async () => {
    const snapshot = syncEngine.getSnapshot();
    if (!snapshot.account) {
      return { status: 'unavailable', configured: false, reason: 'signed_out' };
    }
    const health = await cloudApi.health();
    return {
      status: health.ok ? 'ready' : 'unavailable',
      configured: Boolean(snapshot.account),
      online: snapshot.online,
      serverUrl: snapshot.serverUrl,
    };
  },

  chat: async (message) => {
    try {
      const today = eventStore.validDate(new Date()) || undefined;
      return await syncEngine.agentPlan(message, today);
    } catch (error) {
      console.error('[Preload] Cloud agent request failed:', error.message);
      return {
        message: friendlyCloudError(error),
        actions: [],
        usage: {},
        budget: {},
        configured: false,
        error: true,
      };
    }
  },

  resetChat: async () => {
    syncEngine.resetAgentSession();
    return true;
  },
});

contextBridge.exposeInMainWorld('cloudAPI', {
  getState: () => syncEngine.getSnapshot(),
  subscribeState: (callback) => {
    window.cloudStateSubscribers ||= [];
    window.cloudStateSubscribers.push(callback);
    return () => {
      window.cloudStateSubscribers = (window.cloudStateSubscribers || []).filter(
        (item) => item !== callback,
      );
    };
  },
  subscribeAccount: (callback) => {
    window.accountSubscribers ||= [];
    window.accountSubscribers.push(callback);
    return () => {
      window.accountSubscribers = (window.accountSubscribers || []).filter(
        (item) => item !== callback,
      );
    };
  },
  subscribeMigration: (callback) => {
    window.migrationSubscribers ||= [];
    window.migrationSubscribers.push(callback);
    return () => {
      window.migrationSubscribers = (window.migrationSubscribers || []).filter(
        (item) => item !== callback,
      );
    };
  },

  restoreSession: () => syncEngine.restoreSession(),

  login: async (credentials) => {
    try {
      const deviceName = await ipcRenderer.invoke('cloud-device-name').catch(() => '未知设备');
      await syncEngine.login({ ...credentials, deviceName });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: friendlyCloudError(error) };
    }
  },

  register: async (credentials) => {
    try {
      const deviceName = await ipcRenderer.invoke('cloud-device-name').catch(() => '未知设备');
      await syncEngine.register({ ...credentials, deviceName });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: friendlyCloudError(error) };
    }
  },

  logout: async () => {
    await syncEngine.signOut();
    return { ok: true };
  },

  getSessions: async () => {
    try {
      return { ok: true, sessions: await cloudApi.sessions() };
    } catch (error) {
      return { ok: false, message: friendlyCloudError(error) };
    }
  },

  revokeSession: async (sessionId) => {
    try {
      await cloudApi.revokeSession(sessionId);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: friendlyCloudError(error) };
    }
  },

  setServerUrl: (url) => {
    syncEngine.setServerUrl(url);
    saveCloudConfig();
    return syncEngine.getSnapshot().serverUrl;
  },

  syncNow: async () => {
    try {
      const ok = await syncEngine.syncNow();
      const snapshot = syncEngine.getSnapshot();
      return { ok, message: snapshot.lastError || (snapshot.conflictCount ? '有同步冲突待处理' : '尚未完成同步，请检查登录和网络'), verifiedAt: snapshot.verifiedAt };
    } catch (error) {
      return { ok: false, message: friendlyCloudError(error) };
    }
  },

  getTrash: () => syncEngine.listTrash(),
  restoreFromTrash: (id, eventId) => syncEngine.restoreFromTrash(id, eventId),
  purgeTrash: () => syncEngine.purgeExpiredTrash(),

  getConflicts: () => syncEngine.listConflicts(),
  resolveConflict: async (eventId, choice) => {
    await syncEngine.resolveConflict(eventId, choice);
    return { ok: true };
  },

  agentPlan: async (message) => {
    try {
      const today = eventStore.validDate(new Date()) || undefined;
      return { ok: true, ...(await syncEngine.agentPlan(message, today)) };
    } catch (error) {
      return { ok: false, message: friendlyCloudError(error) };
    }
  },

  approveActions: async (actions, selectedIndices, planId) => {
    const results = syncEngine.approveActions(actions, selectedIndices, planId);
    await syncEngine.flushAgentReceipts();
    return results;
  },
});

contextBridge.exposeInMainWorld('configAPI', {
  load: async () => {
    try {
      const config = await ipcRenderer.invoke('config-load');
      return config && typeof config === 'object' ? config : {};
    } catch (_) {
      return {};
    }
  },
  save: async (config) => {
    try {
      const result = await ipcRenderer.invoke('config-save', config);
      return result && typeof result === 'object' ? result : { success: false };
    } catch (_) {
      return { success: false };
    }
  },
});

const { viewRange, viewRangeIncludesDate, viewRangeTitle } = require('./src/core/date-utils');

contextBridge.exposeInMainWorld('viewUtils', {
  viewRange: (view, value) => viewRange(view, value),
  viewRangeIncludesDate: (view, value, target) => viewRangeIncludesDate(view, value, target),
  viewRangeTitle: (view, value) => viewRangeTitle(view, value),
});

contextBridge.exposeInMainWorld('lunarAPI', {
  isAvailable: () => Boolean(Lunar),
  fromSolar: (year, month, day) => {
    if (!Solar) return null;
    try {
      const solar = Solar.fromYmd(year, month, day);
      const lunar = solar.getLunar();
      return {
        year: lunar.getYear(),
        month: lunar.getMonth(),
        day: lunar.getDay(),
        monthStr: `${lunar.getMonthInChinese()}月`,
        dayStr: lunar.getDayInChinese(),
        isLeapMonth: lunar.getMonth() < 0,
        yearGanZhi: lunar.getYearInGanZhi(),
        shengXiao: lunar.getYearShengXiao(),
        jieQi: lunar.getJieQi() || null,
        festivals: lunar.getFestivals() || [],
        otherFestivals: lunar.getOtherFestivals() || [],
      };
    } catch (_) {
      return null;
    }
  },
  getSolarFestivals: (year, month, day) => {
    if (!Solar) return [];
    try {
      return Solar.fromYmd(year, month, day).getFestivals() || [];
    } catch (_) {
      return [];
    }
  },
  getHoliday: (year, month, day) => {
    if (!HolidayUtil) return null;
    try {
      const holiday = HolidayUtil.getHoliday(year, month, day);
      if (!holiday) return null;
      return {
        name: holiday.getName(),
        isWork: holiday.isWork(),
        target: holiday.getTarget(),
      };
    } catch (_) {
      return null;
    }
  },
});
