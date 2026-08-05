'use strict';

const { app, BrowserWindow, ipcMain, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// Chromium aggressively throttles (and eventually freezes) timers in renderers
// that are hidden, unfocused or occluded — which is precisely the situation a
// desktop countdown runs in. The authoritative clock therefore lives in this
// process, which is plain Node and never throttled. These switches additionally
// keep the renderers awake enough to paint the updates promptly.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ---------------------------------------------------------------------------
// Persistence: a single JSON file in the OS userData dir keeps everything
// offline and local. No network, no external services.
// ---------------------------------------------------------------------------
const dataFile = path.join(app.getPath('userData'), 'priobox-data.json');

function loadState() {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // First run (or unreadable file): start empty.
    return { tasks: [], done: [], doneCount: 0 };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save state:', err);
    return false;
  }
}

let mainWindow = null;
let floatingWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 480,
    title: 'PrioBox',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// The small always-on-top countdown that lives on the desktop.
function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    return floatingWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { width: sw } = display.workAreaSize;
  const winW = 240;
  const winH = 132;

  floatingWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: sw - winW - 24,
    y: 48,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'floating-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // Keep it above normal windows even when other apps are focused, and let it
  // show on every Space / over full-screen apps.
  floatingWindow.setAlwaysOnTop(true, 'screen-saver');
  floatingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  floatingWindow.loadFile(path.join(__dirname, 'floating.html'));

  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });

  return floatingWindow;
}

// ---------------------------------------------------------------------------
// Countdown timer — authoritative, wall-clock based.
//
// Elapsed time is derived from Date.now() deltas rather than counted ticks, so
// a delayed, coalesced or missed interval (throttling, system sleep, heavy
// load) self-corrects on the next tick instead of losing time.
// ---------------------------------------------------------------------------
const TICK_MS = 250;
const FINISHED_LINGER_MS = 6000;

let timer = null;
let hideTimeout = null;

function timerPayload(extra) {
  return Object.assign(
    {
      taskId: timer.taskId,
      title: timer.title,
      color: timer.color,
      remaining: Math.ceil(timer.remainingMs / 1000),
      total: Math.round(timer.totalMs / 1000),
      spentMs: timer.spentMs,
      running: timer.running
    },
    extra || {}
  );
}

function broadcastTimer(extra) {
  if (!timer) return;
  const payload = timerPayload(extra);
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('timer:state', payload);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:state', payload);
  }
}

// Fold the real time that has passed since the last accounting into the timer.
function applyElapsed() {
  const now = Date.now();
  const delta = now - timer.lastAt;
  timer.lastAt = now;
  if (!timer.running || delta <= 0) return;
  // Never bank more "time spent" than the countdown actually had left, so a
  // laptop sleeping through the timer just completes it rather than inflating
  // the tracked minutes.
  const applied = Math.min(delta, timer.remainingMs);
  timer.remainingMs -= applied;
  timer.spentMs += applied;
}

function tick() {
  if (!timer) return;
  applyElapsed();
  if (timer.remainingMs <= 0) finishTimer();
  else broadcastTimer();
}

function finishTimer() {
  const title = timer.title;
  timer.running = false;
  timer.remainingMs = 0;
  if (timer.intervalId) {
    clearInterval(timer.intervalId);
    timer.intervalId = null;
  }
  broadcastTimer({ finished: true });

  try {
    new Notification({
      title: 'PrioBox',
      body: title ? `“${title}” — time's up!` : "Time's up!"
    }).show();
  } catch (err) {
    // Notifications may be unavailable; the widget still shows 00:00.
  }

  // Leave the widget up briefly as a visual cue, then tuck it away.
  clearTimeout(hideTimeout);
  hideTimeout = setTimeout(hideFloating, FINISHED_LINGER_MS);
}

function hideFloating() {
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.hide();
}

function stopTimer() {
  if (timer && timer.intervalId) clearInterval(timer.intervalId);
  timer = null;
  clearTimeout(hideTimeout);
  hideFloating();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:stopped');
  }
}

function pauseTimer() {
  if (!timer || !timer.running) return;
  applyElapsed();
  timer.running = false;
  broadcastTimer();
}

function resumeTimer() {
  if (!timer || timer.running) return;
  timer.lastAt = Date.now();
  timer.running = true;
  broadcastTimer();
}

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------
ipcMain.handle('store:load', () => loadState());
ipcMain.handle('store:save', (_evt, state) => saveState(state));

ipcMain.on('timer:start', (_evt, { taskId, title, color, seconds }) => {
  if (timer && timer.intervalId) clearInterval(timer.intervalId);
  clearTimeout(hideTimeout);

  const ms = Math.max(1, Number(seconds) || 0) * 1000;
  timer = {
    taskId,
    title,
    color,
    totalMs: ms,
    remainingMs: ms,
    spentMs: 0,
    running: true,
    lastAt: Date.now(),
    intervalId: setInterval(tick, TICK_MS)
  };

  const win = createFloatingWindow();
  const reveal = () => {
    broadcastTimer();
    win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
  else reveal();
});

ipcMain.on('timer:pause', pauseTimer);
ipcMain.on('timer:resume', resumeTimer);
ipcMain.on('timer:stop', stopTimer);

// Controls pressed on the floating widget act on the same authoritative timer.
ipcMain.on('floating:control', (_evt, action) => {
  if (action === 'pause') pauseTimer();
  else if (action === 'resume') resumeTimer();
  else if (action === 'stop') stopTimer();
});

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
