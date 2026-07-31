'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge for the main window renderer.
contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('store:load'),
  saveState: (state) => ipcRenderer.invoke('store:save', state),

  // Timer mirroring to the floating desktop window.
  timerStart: (payload) => ipcRenderer.send('timer:start', payload),
  timerUpdate: (payload) => ipcRenderer.send('timer:update', payload),
  timerStop: () => ipcRenderer.send('timer:stop'),

  // Controls coming back from the floating window.
  onFloatingControl: (cb) =>
    ipcRenderer.on('floating:control', (_evt, action) => cb(action))
});
