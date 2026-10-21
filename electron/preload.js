// The only bridge between the page and the laptop: making audio and saving to the Thendral folder.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thendralNative', {
  info: () => ipcRenderer.invoke('thendral:info'),
  makeAudio: (job, onProgress) => {
    const handler = (_e, p) => { if (p.id === job.id && onProgress) onProgress(p); };
    ipcRenderer.on('thendral:progress', handler);
    return ipcRenderer.invoke('thendral:make', job).finally(() => ipcRenderer.removeListener('thendral:progress', handler));
  },
  savePage: (bundle) => ipcRenderer.invoke('thendral:save', bundle),
  saveFile: (file) => ipcRenderer.invoke('thendral:saveFile', file),
  chooseFolder: () => ipcRenderer.invoke('thendral:chooseFolder'),
  openFolder: (sub) => ipcRenderer.invoke('thendral:openFolder', sub),
});
