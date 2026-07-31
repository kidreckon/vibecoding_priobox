'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

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
    return { tasks: [], doneCount: 0 };
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
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

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
      nodeIntegration: false
    }
  });

  // Keep it above normal windows even when other apps are focused, and let it
  // show on every Space / over full-screen apps.
  floatingWindow.setAlwaysOnTop(true, 'screen-saver');
  floatingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  floatingWindow.loadFile('floating.html');

  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });

  return floatingWindow;
}

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------
ipcMain.handle('store:load', () => loadState());
ipcMain.handle('store:save', (_evt, state) => saveState(state));

// Main renderer owns the ticking clock and the source of truth. These messages
// just mirror the current timer into the floating desktop window.
ipcMain.on('timer:start', (_evt, payload) => {
  const win = createFloatingWindow();
  const send = () => win.webContents.send('timer:state', payload);
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      send();
      win.showInactive();
    });
  } else {
    send();
    win.showInactive();
  }
});

ipcMain.on('timer:update', (_evt, payload) => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('timer:state', payload);
  }
});

ipcMain.on('timer:stop', () => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.hide();
  }
});

// Controls pressed on the floating window are relayed back to the main renderer.
ipcMain.on('floating:control', (_evt, action) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('floating:control', action);
  }
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
