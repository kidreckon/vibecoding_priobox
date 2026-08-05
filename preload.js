'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge for the main window renderer.
contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('store:load'),
  saveState: (state) => ipcRenderer.invoke('store:save', state),

  // The countdown itself is owned by the main process; these just drive it.
  timerStart: (payload) => ipcRenderer.send('timer:start', payload),
  timerPause: () => ipcRenderer.send('timer:pause'),
  timerResume: () => ipcRenderer.send('timer:resume'),
  timerStop: () => ipcRenderer.send('timer:stop'),

  onTimerState: (cb) => ipcRenderer.on('timer:state', (_evt, state) => cb(state)),
  onTimerStopped: (cb) => ipcRenderer.on('timer:stopped', () => cb())
});
