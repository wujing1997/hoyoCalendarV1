'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  safeStorage,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalConfig } = require('./src/core/local-config');
const { RememberedLogin } = require('./src/core/remembered-login');
const { startReminders } = require('./src/reminder/controller');

const allowMultipleInstances = process.env.HOYO_ALLOW_MULTIPLE_INSTANCES === '1';
const gotLock = allowMultipleInstances || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

const logDir = path.join(app.getPath('userData'), 'logs');
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`);

function serializeLogValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function log(...values) {
  const line = `[${new Date().toISOString()}] ${values.map(serializeLogValue).join(' ')}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (_) {
    // Logging must never interrupt the app.
  }
  console.log(...values);
}

function logError(...values) {
  log('[ERROR]', ...values);
}

process.on('uncaughtException', (error) => logError('uncaughtException', error));
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));

let mainWindow = null;
let persistTimer = null;
let currentMode = 'wide';
let reminders = null;

function showCalendar() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const COMPACT_WIDTH = 430;
const COMPACT_MIN_WIDTH = 360;
const WIDE_DEFAULT_WIDTH = 1180;
const WIDE_DEFAULT_HEIGHT = 760;
const WIDE_MIN_WIDTH = 720;
const WIDE_MIN_HEIGHT = 560;
const ATTACHMENT_MAX_FILES = 5;
const ATTACHMENT_MAX_BYTES = 512 * 1024;
const ATTACHMENT_MAX_TOTAL_CHARS = 60000;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ics', '.log',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts',
  '.tsx', '.jsx', '.py', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp',
  '.sql', '.sh', '.ps1', '.toml', '.ini', '.conf',
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function displayForBounds(bounds) {
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    return screen.getDisplayMatching(bounds);
  }
  return screen.getPrimaryDisplay();
}

function compactBounds(baseBounds = {}) {
  const area = displayForBounds(baseBounds).workArea;
  const width = clamp(COMPACT_WIDTH, Math.min(COMPACT_MIN_WIDTH, area.width), area.width);
  return { x: area.x + area.width - width, y: area.y, width, height: area.height };
}

function wideBounds(baseBounds = {}) {
  const area = displayForBounds(baseBounds).workArea;
  const width = Math.min(Math.max(WIDE_MIN_WIDTH, Number(baseBounds.width) || WIDE_DEFAULT_WIDTH), area.width);
  const height = Math.min(Math.max(WIDE_MIN_HEIGHT, Number(baseBounds.height) || WIDE_DEFAULT_HEIGHT), area.height);
  const x = Number.isFinite(baseBounds.x)
    ? clamp(baseBounds.x, area.x, area.x + area.width - width)
    : Math.round(area.x + (area.width - width) / 2);
  const y = Number.isFinite(baseBounds.y)
    ? clamp(baseBounds.y, area.y, area.y + area.height - height)
    : Math.round(area.y + (area.height - height) / 2);
  return { x, y, width, height };
}

function widePresetBounds(baseBounds = {}) {
  const area = displayForBounds(baseBounds).workArea;
  const width = Math.min(WIDE_DEFAULT_WIDTH, area.width);
  const height = Math.min(WIDE_DEFAULT_HEIGHT, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function boundsForMode(mode, baseBounds = {}) {
  return mode === 'compact' ? compactBounds(baseBounds) : wideBounds(baseBounds);
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    const mode = state.mode === 'compact' ? 'compact' : 'wide';
    return {
      ...boundsForMode(mode, state),
      isPinned: Boolean(state.isPinned),
      mode,
    };
  } catch (_) {
    return {
      ...wideBounds(),
      isPinned: false,
      mode: 'wide',
    };
  }
}

function saveWindowStateNow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const state = {
    ...bounds,
    isPinned: mainWindow.isAlwaysOnTop(),
    mode: currentMode,
  };
  try {
    fs.writeFileSync(windowStateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    logError('Failed to persist window state', error);
  }
}

function persistWindowState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveWindowStateNow, 250);
}

function currentWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { isPinned: false, isMaximized: false, mode: 'wide' };
  }
  return {
    isPinned: mainWindow.isAlwaysOnTop(),
    isMaximized: mainWindow.isMaximized(),
    mode: currentMode,
  };
}

function publishWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window-state-changed', currentWindowState());
  }
}

function refitCompactWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || currentMode !== 'compact') return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setBounds(compactBounds(mainWindow.getBounds()), true);
  persistWindowState();
  publishWindowState();
}

function createWindow() {
  const saved = loadWindowState();
  currentMode = saved.mode;
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: COMPACT_MIN_WIDTH,
    minHeight: 360,
    frame: false,
    transparent: false,
    backgroundColor: '#eef1f5',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    alwaysOnTop: saved.isPinned,
    resizable: true,
    show: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    publishWindowState();
  });

  mainWindow.on('resize', () => {
    persistWindowState();
    publishWindowState();
  });
  mainWindow.on('move', persistWindowState);
  mainWindow.on('maximize', publishWindowState);
  mainWindow.on('unmaximize', publishWindowState);
  mainWindow.on('always-on-top-changed', () => {
    persistWindowState();
    publishWindowState();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('close', (event) => {
    if (app.isQuitting || !reminders) return;
    event.preventDefault();
    saveWindowStateNow();
    mainWindow.hide();
  });
  mainWindow.on('unresponsive', () => logError('Renderer became unresponsive'));

  mainWindow.webContents.on('console-message', (_event, detailsOrLevel, legacyMessage) => {
    const isStructured = detailsOrLevel && typeof detailsOrLevel === 'object';
    const level = isStructured ? detailsOrLevel.level : Number(detailsOrLevel);
    const message = isStructured
      ? detailsOrLevel.message
      : String(legacyMessage || '');
    if (level === 'error' || Number(level) >= 3) logError('[Renderer]', message);
    else log('[Renderer]', message);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('Renderer process gone', details);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    logError('Page failed to load', code, description);
  });

  if (!app.isPackaged && process.env.HOYO_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  log('HoYoCalendar starting', `version=${app.getVersion()}`, `packaged=${app.isPackaged}`);
  createWindow();
  reminders = startReminders({ app, getMainWindow: () => mainWindow, showCalendar, onError: (error) => logError('Reminder check failed', error) });

  app.on('activate', () => {
    showCalendar();
  });

  screen.on('display-metrics-changed', refitCompactWindow);
  screen.on('display-added', refitCompactWindow);
  screen.on('display-removed', refitCompactWindow);
});

app.on('window-all-closed', () => {
  if (!reminders && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  reminders?.dispose();
  reminders = null;
  clearTimeout(persistTimer);
  saveWindowStateNow();
});

ipcMain.handle('get-window-state', () => currentWindowState());
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('open-logs-folder', async () => shell.openPath(logDir));
ipcMain.handle('assistant-pick-attachments', async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '选择要交给 AI 助手的文本附件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '文本与日历文件',
        extensions: [...TEXT_ATTACHMENT_EXTENSIONS].map((extension) => extension.slice(1)),
      },
    ],
  });
  if (selection.canceled) return { ok: true, files: [] };
  if (selection.filePaths.length > ATTACHMENT_MAX_FILES) {
    return { ok: false, message: `一次最多选择 ${ATTACHMENT_MAX_FILES} 个附件。` };
  }

  const files = [];
  let remainingChars = ATTACHMENT_MAX_TOTAL_CHARS;
  try {
    for (const filePath of selection.filePaths) {
      const extension = path.extname(filePath).toLowerCase();
      if (!TEXT_ATTACHMENT_EXTENSIONS.has(extension)) {
        return { ok: false, message: `“${path.basename(filePath)}”不是支持的文本文件。` };
      }
      const stats = fs.statSync(filePath);
      if (!stats.isFile() || stats.size > ATTACHMENT_MAX_BYTES) {
        return { ok: false, message: `“${path.basename(filePath)}”超过 512 KB，无法添加。` };
      }
      const buffer = fs.readFileSync(filePath);
      if (buffer.includes(0)) {
        return { ok: false, message: `“${path.basename(filePath)}”看起来是二进制文件，无法读取。` };
      }
      const decoded = buffer.toString('utf8').replace(/^\uFEFF/, '');
      const text = decoded.slice(0, Math.max(0, remainingChars));
      files.push({
        id: `${stats.mtimeMs}-${stats.size}-${path.basename(filePath)}`,
        name: path.basename(filePath),
        size: stats.size,
        text,
        truncated: text.length < decoded.length,
      });
      remainingChars -= text.length;
    }
    return { ok: true, files };
  } catch (error) {
    logError('Failed to read assistant attachments', error);
    return { ok: false, message: '读取附件失败，请确认文件仍然存在且可访问。' };
  }
});
ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-auto-launch', (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath });
  return app.getLoginItemSettings().openAtLogin;
});

const credentialFile = path.join(app.getPath('userData'), 'cloud-credentials.bin');
const rememberedLogin = new RememberedLogin(path.join(app.getPath('userData'), 'remembered-login.bin'), safeStorage);
ipcMain.handle('cloud-remembered-login-get', (_event, serverUrl) => rememberedLogin.get(serverUrl));
ipcMain.handle('cloud-remembered-login-save', (_event, { serverUrl, email, password }) => {
  try { rememberedLogin.save(serverUrl, email, password); return { ok: true }; }
  catch (_) { return { ok: false, message: '无法加密保存密码，登录成功但未记住密码' }; }
});
ipcMain.handle('cloud-remembered-login-clear', () => { rememberedLogin.clear(); return true; });

function credentialStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

ipcMain.handle('cloud-credential-get-refresh-token', async () => {
  try {
    if (!fs.existsSync(credentialFile)) return null;
    const raw = fs.readFileSync(credentialFile);
    if (credentialStorageAvailable()) {
      return safeStorage.decryptString(raw);
    }
    return raw.toString('utf8');
  } catch (error) {
    logError('Failed to read cloud credentials', error);
    return null;
  }
});

ipcMain.handle('cloud-credential-set-refresh-token', async (_event, token) => {
  try {
    if (!token) {
      if (fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
      return true;
    }
    let payload;
    if (credentialStorageAvailable()) {
      payload = safeStorage.encryptString(String(token));
    } else {
      payload = Buffer.from(String(token), 'utf8');
      log('safeStorage unavailable, cloud refresh token stored with OS file permissions only');
    }
    fs.writeFileSync(credentialFile, payload, { mode: 0o600 });
    return true;
  } catch (error) {
    logError('Failed to store cloud credentials', error);
    return false;
  }
});

ipcMain.handle('cloud-credential-clear', async () => {
  try {
    if (fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
    return true;
  } catch (error) {
    logError('Failed to clear cloud credentials', error);
    return false;
  }
});

ipcMain.handle('cloud-device-name', () => os.hostname() || '未知设备');

const localConfig = new LocalConfig(
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'HoyoCalendar', 'config.json'),
);

ipcMain.handle('config-load', () => localConfig.load());

ipcMain.handle('config-save', (_event, updates) => {
  try {
    return { success: true, config: localConfig.save(updates) };
  } catch (error) {
    logError('Failed to save local config', error);
    return { success: false };
  }
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-toggle-pin', () => {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop());
});
ipcMain.on('window-set-mode', (_event, mode) => {
  if (!mainWindow) return;
  currentMode = mode === 'compact' ? 'compact' : 'wide';
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  const currentBounds = mainWindow.getBounds();
  const nextBounds = currentMode === 'compact'
    ? compactBounds(currentBounds)
    : widePresetBounds(currentBounds);
  mainWindow.setBounds(nextBounds, true);
  persistWindowState();
  publishWindowState();
});
