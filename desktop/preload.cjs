const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('hostSetup', {
    state: () => ipcRenderer.invoke('setup:state'),
    start: ip => ipcRenderer.invoke('setup:start', ip),
  });
}
