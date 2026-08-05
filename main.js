'use strict';

const {
  app, BrowserWindow, ipcMain, screen, Notification,
  powerSaveBlocker, powerMonitor
} = require('electron');
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
app.commandLine.appendSwitch(
  'disable-features',
  'TimerThrottlingForBackgroundTabs,IntensiveWakeUpThrottling,' +
    'ExpensiveBackgroundTimerThrottling'
);
// The widget's App Nap keep-alive tone must be able to start on its own.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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

  // Anything that means the board is visible again: catch the timer up and
  // push the current state, so a window reopened mid-countdown adopts it.
  mainWindow.webContents.on('did-finish-load', refreshTimer);
  mainWindow.on('restore', refreshTimer);
  mainWindow.on('show', refreshTimer);
  mainWindow.on('focus', refreshTimer);

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
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
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
let blockerId = null;

// macOS App Nap suspends an entire app once it has no visible windows —
// minimising the board froze this process and with it the countdown. Holding a
// power-save blocker for the life of a timer keeps the app scheduled. It only
// prevents *app* suspension, so the display is still free to sleep.
function holdAwake() {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return;
  try {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
  } catch (err) {
    blockerId = null;
  }
}

function releaseAwake() {
  try {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId);
    }
  } catch (err) {
    // Nothing to release.
  }
  blockerId = null;
}

function timerPayload(extra) {
  return Object.assign(
    {
      taskId: timer.taskId,
      title: timer.title,
      color: timer.color,
      totalMs: timer.totalMs,
      // Authoritative at the moment of broadcast. While running, endsAt lets a
      // client extrapolate the true value itself instead of trusting that ticks
      // keep arriving — the whole point of the deadline model.
      remainingMs: timer.remainingMs,
      endsAt: timer.endsAt,
      baseSpent: timer.baseSpent,
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

// Remaining time is a pure function of the wall clock and the deadline, never
// an accumulation of ticks. A tick that is late, coalesced, dropped entirely or
// missed because the process was suspended therefore costs nothing: the next
// read of the clock is still exactly right.
function syncFromClock() {
  if (!timer || !timer.running) return;
  timer.remainingMs = Math.max(0, timer.endsAt - Date.now());
}

function tick() {
  if (!timer) return;
  syncFromClock();
  if (timer.running && timer.remainingMs <= 0) finishTimer();
  else broadcastTimer();
}

// Force the timer to catch up and repaint. Called from every path that means
// "the app just woke up or became visible again", so even if the process was
// suspended the countdown snaps to the true time instead of showing a stale
// value or appearing to resume from where it froze.
function refreshTimer() {
  if (!timer) return;
  if (timer.running) tick();
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
  releaseAwake();

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
  releaseAwake();
  clearTimeout(hideTimeout);
  hideFloating();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:stopped');
  }
}

function pauseTimer() {
  if (!timer || !timer.running) return;
  syncFromClock();
  timer.running = false;
  timer.endsAt = 0;
  broadcastTimer();
}

function resumeTimer() {
  if (!timer || timer.running) return;
  timer.endsAt = Date.now() + timer.remainingMs;
  timer.running = true;
  broadcastTimer();
}

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------
ipcMain.handle('store:load', () => loadState());
ipcMain.handle('store:save', (_evt, state) => saveState(state));

ipcMain.on('timer:start', (_evt, { taskId, title, color, seconds, baseSpent }) => {
  if (timer && timer.intervalId) clearInterval(timer.intervalId);
  clearTimeout(hideTimeout);

  const ms = Math.max(1, Number(seconds) || 0) * 1000;
  timer = {
    taskId,
    title,
    color,
    totalMs: ms,
    remainingMs: ms,
    endsAt: Date.now() + ms,
    // The task's tracked seconds before this run, echoed back on every update
    // so the board can recompute its total without keeping its own tally.
    baseSpent: Number(baseSpent) || 0,
    running: true,
    intervalId: setInterval(tick, TICK_MS)
  };
  holdAwake();

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
ipcMain.on('timer:refresh', refreshTimer);

// Controls pressed on the floating widget act on the same authoritative timer.
ipcMain.on('floating:control', (_evt, action) => {
  if (action === 'pause') pauseTimer();
  else if (action === 'resume') resumeTimer();
  else if (action === 'stop') stopTimer();
  else if (action === 'expired') {
    // The widget is always on screen, so its clock is the least likely to be
    // starved. If it sees the deadline pass before this process notices, take
    // its word for it rather than letting the timer hang at 00:00.
    syncFromClock();
    if (timer && timer.running && timer.remainingMs <= 0) finishTimer();
  } else if (action === 'refresh') {
    refreshTimer();
  }
});

// ---------------------------------------------------------------------------
// Belt and braces: NSAppSleepDisabled is the documented macOS opt-out from App
// Nap, read at launch, so this takes effect from the next start onwards. Only
// applied to the packaged app — a dev run would otherwise write it into
// Electron's own shared defaults domain, affecting unrelated apps.
function disableAppNapPermanently() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    const { systemPreferences } = require('electron');
    if (systemPreferences.getUserDefault('NSAppSleepDisabled', 'boolean') === true) {
      return;
    }
    systemPreferences.setUserDefault('NSAppSleepDisabled', 'boolean', true);
  } catch (err) {
    // Best effort; the widget's keep-alive tone is the primary defence.
  }
}

app.whenReady().then(() => {
  disableAppNapPermanently();
  createMainWindow();

  // Waking from system sleep, or the app being brought back to the front, are
  // the other moments a suspended timer needs to catch up.
  powerMonitor.on('resume', refreshTimer);
  powerMonitor.on('unlock-screen', refreshTimer);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      refreshTimer();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
