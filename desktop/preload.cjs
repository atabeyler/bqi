const { contextBridge, ipcRenderer } = require('electron');

// CommonJS (not ESM, despite the root package.json's "type": "module") and
// a .cjs extension so Node's module-type resolution can't override that --
// Electron's sandboxed preload loader (sandbox: true in main.js) runs
// preload scripts through its own bundle that only understands CommonJS,
// regardless of the nearest package.json's "type" field; an ESM preload.js
// here fails at runtime with "Cannot use import statement outside a
// module" and the renderer silently gets no contextBridge API at all.
//
// Same default/override as main.js's CLOUD_URL -- duplicated rather than
// imported because the preload script runs in its own isolated context
// (see contextIsolation below) and doesn't share module state with main.js.
const CLOUD_URL = process.env.BQI_CLOUD_URL || 'https://bqi.onrender.com';

// contextIsolation is on and nodeIntegration is off (see main.js) — this is
// the *only* surface the renderer (the ordinary client/ React app) gets
// into the main process. Every call is a thin ipcRenderer.invoke wrapper;
// there is no direct filesystem/Node/db access from renderer code.
contextBridge.exposeInMainWorld('bqiDesktop', {
  isDesktop: true,
  platform: process.platform,
  // The window loads client/dist from a local static server (see
  // staticServer.js), not the real backend origin -- api.js reads this to
  // know where actual /api/* calls need to go instead of a same-origin
  // relative fetch that would hit nothing.
  cloudUrl: CLOUD_URL,

  auth: {
    establishOnlineSession: (jwt, password) => ipcRenderer.invoke('auth:establishOnlineSession', jwt, password),
    verifyOfflineLogin: (userCode, password) => ipcRenderer.invoke('auth:verifyOfflineLogin', userCode, password),
    getSession: () => ipcRenderer.invoke('auth:getSession'),
    getDeviceId: () => ipcRenderer.invoke('auth:getDeviceId'),
    isOfflineLoginAllowed: (userCode) => ipcRenderer.invoke('auth:isOfflineLoginAllowed', userCode),
    needsReauth: () => ipcRenderer.invoke('auth:needsReauth'),
    onReauthRequired: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('auth:reauthRequired', listener);
      return () => ipcRenderer.removeListener('auth:reauthRequired', listener);
    },
    logoutSession: () => ipcRenderer.invoke('auth:logoutSession'),
    forgetDevice: () => ipcRenderer.invoke('auth:forgetDevice'),
  },

  appMode: {
    get: () => ipcRenderer.invoke('appMode:get'),
    set: (mode) => ipcRenderer.invoke('appMode:set', mode),
    onChange: (cb) => {
      const l = (_e, mode) => cb(mode);
      ipcRenderer.on('appMode:changed', l);
      return () => ipcRenderer.removeListener('appMode:changed', l);
    },
  },

  analyses: {
    list: () => ipcRenderer.invoke('analyses:list'),
    get: (id) => ipcRenderer.invoke('analyses:get', id),
    create: (data) => ipcRenderer.invoke('analyses:create', data),
    update: (id, data) => ipcRenderer.invoke('analyses:update', id, data),
    remove: (id) => ipcRenderer.invoke('analyses:remove', id),
  },

  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    forceSync: () => ipcRenderer.invoke('sync:forceSync'),
    listConflicts: () => ipcRenderer.invoke('sync:listConflicts'),
    resolveConflict: (conflictId, resolution) => ipcRenderer.invoke('sync:resolveConflict', conflictId, resolution),
  },

  ai: {
    query: (request) => ipcRenderer.invoke('ai:query', request),
    modelStatus: () => ipcRenderer.invoke('ai:modelStatus'),
    modelDownload: () => ipcRenderer.invoke('ai:modelDownload'),
    modelDownloadCancel: (options) => ipcRenderer.invoke('ai:modelDownloadCancel', options),
    modelRemove: () => ipcRenderer.invoke('ai:modelRemove'),
    modelTiers: () => ipcRenderer.invoke('ai:modelTiers'),
    modelSelectTier: (tier) => ipcRenderer.invoke('ai:modelSelectTier', tier),
    onModelDownloadProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('ai:modelDownloadProgress', listener);
      return () => ipcRenderer.removeListener('ai:modelDownloadProgress', listener);
    },
  },

  connectivity: {
    getState: () => ipcRenderer.invoke('connectivity:getState'),
    onChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('connectivity:change', listener);
      return () => ipcRenderer.removeListener('connectivity:change', listener);
    },
  },

  update: {
    // Fires at most once per app launch, if the server-side version check
    // (see main.js's checkAppUpdate) found something newer than app.getVersion().
    onAvailable: (callback) => {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('update:available', listener);
      return () => ipcRenderer.removeListener('update:available', listener);
    },
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
    getAvailable: () => ipcRenderer.invoke('update:getAvailable'),
    approve: () => ipcRenderer.invoke('update:approve'),
    install: () => ipcRenderer.invoke('update:install'),
  },
});
