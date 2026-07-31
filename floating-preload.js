'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the small always-on-top countdown window.
contextBridge.exposeInMainWorld('floatApi', {
  onState: (cb) => ipcRenderer.on('timer:state', (_evt, state) => cb(state)),
  control: (action) => ipcRenderer.send('floating:control', action)
});
