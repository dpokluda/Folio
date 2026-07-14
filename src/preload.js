// Bridges the isolated preload world to the renderer (main world) over IPC.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  ipcRenderer.on(channel, (_event, payload) => cb(payload));
};

contextBridge.exposeInMainWorld('folioAPI', {
  // main -> renderer events
  onCommand: (cb) => listen('command', cb),
  onLoadDocument: (cb) => listen('load-document', cb),
  onOpenFolder: (cb) => listen('open-folder', cb),
  onSetTheme: (cb) => listen('set-theme', cb),
  onSaved: (cb) => listen('saved', cb),
  onDocumentPathChanged: (cb) => listen('document-path-changed', cb),

  // renderer -> main
  getInit: () => ipcRenderer.invoke('get-init'),
  navigate: (payload) => ipcRenderer.invoke('navigate', payload),
  setDirty: (value) => ipcRenderer.send('dirty-changed', value),
  setState: (state) => ipcRenderer.send('state-changed', state),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
