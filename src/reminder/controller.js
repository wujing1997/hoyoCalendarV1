'use strict';
const { BrowserWindow, Tray, Menu, screen, powerMonitor, ipcMain } = require('electron');
const path = require('path');
const { EventStore } = require('../core/event-store');
const { ReminderScheduler } = require('../core/reminder-scheduler');
const { LocalConfig } = require('../core/local-config');
const { BarkPush } = require('../core/bark-push');

function startReminders({ app, getMainWindow, showCalendar, onError }) {
  let theme = 'light';
  let ready = false;
  const tray = new Tray(path.join(__dirname, '../../assets/app-icon.ico'));
  tray.setToolTip('HoYoCalendar · 到时提醒运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开日历', click: showCalendar },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showCalendar);
  const window = new BrowserWindow({
    width: 340, height: 190, frame: false, transparent: false, show: false,
    backgroundColor: '#ffffff', roundedCorners: true,
    resizable: false, movable: false, focusable: true, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  function position() {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(340, area.width - 32);
    window.setBounds({ x: area.x + area.width - width - 16, y: area.y + 16, width, height: 190 });
  }
  position();
  function publish() {
    if (!ready || window.isDestroyed()) return;
    const snapshot = scheduler.snapshot();
    window.webContents.send('reminder-state', { ...snapshot, theme });
    if (snapshot.reminder) {
      if (!window.isVisible()) {
        window.showInactive();
      }
    } else window.hide();
  }
  const dataDir = path.join(process.env.APPDATA || process.env.HOME, 'HoyoCalendar');
  const scheduler = new ReminderScheduler({ store: new EventStore({ dataDir }), stateFile: path.join(dataDir, 'reminder-confirmations.json'), onChange: publish });
  const config = new LocalConfig(path.join(dataDir, 'config.json'));
  const mobilePush = new BarkPush({ stateFile: path.join(dataDir, 'bark-deliveries.json'), getConfig: () => config.load().notifications?.bark, onError });
  const handlers = {
    'reminder-ready': (event) => {
      if (event.sender !== window.webContents) return;
      ready = true;
      publish();
    },
    'reminder-theme': (event, value) => {
      if (event.sender !== getMainWindow()?.webContents) return;
      theme = value === 'dark' ? 'dark' : 'light';
      window.setBackgroundColor(theme === 'dark' ? '#181b20' : '#ffffff');
      publish();
    },
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.on(channel, handler);
  ipcMain.handle('reminder-acknowledge', (event, key) => {
    if (event.sender !== window.webContents) return false;
    return scheduler.acknowledge(key);
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  const tick = () => { try { scheduler.tick(); mobilePush.tick(scheduler.dueReminders || []); } catch (error) { onError(error); } };
  tick();
  const timer = setInterval(tick, 1000);
  powerMonitor.on('resume', tick);
  powerMonitor.on('unlock-screen', tick);
  const displayEvents = ['display-metrics-changed', 'display-added', 'display-removed'];
  displayEvents.forEach((event) => screen.on(event, position));
  return {
    dispose() {
      clearInterval(timer);
      mobilePush.dispose();
      powerMonitor.removeListener('resume', tick);
      powerMonitor.removeListener('unlock-screen', tick);
      displayEvents.forEach((event) => screen.removeListener(event, position));
      for (const [channel, handler] of Object.entries(handlers)) ipcMain.removeListener(channel, handler);
      ipcMain.removeHandler('reminder-acknowledge');
      tray.destroy();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
module.exports = { startReminders };
