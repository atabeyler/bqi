// Bridges the renderer to the Electron desktop shell's preload API
// (desktop/preload.cjs's contextBridge surface). On the web build
// `window.bqiDesktop` is simply undefined, so `isDesktop` is false and
// every export here is inert — nothing about the web app's behavior
// changes by importing this module.
export const isDesktop = typeof window !== 'undefined' && !!window.bqiDesktop;

const bridge = isDesktop ? window.bqiDesktop : null;

// Static for the life of the app (Electron's process.platform never
// changes mid-session) -- used by HistoryView.jsx's device label, mirrors
// mobileBridge.js's mobilePlatform.
export const desktopPlatform = bridge?.platform || null;

export const desktopAuth = {
  establishOnlineSession: (jwt, password) => bridge?.auth.establishOnlineSession(jwt, password),
  verifyOfflineLogin: (userCode, password) => bridge?.auth.verifyOfflineLogin(userCode, password),
  getSession: () => bridge?.auth.getSession(),
  getDeviceId: () => bridge?.auth.getDeviceId(),
  isOfflineLoginAllowed: (userCode) => bridge?.auth.isOfflineLoginAllowed(userCode),
  needsReauth: () => bridge?.auth.needsReauth(),
  onReauthRequired: (callback) => bridge?.auth.onReauthRequired(callback) || (() => {}),
  logoutSession: () => bridge?.auth.logoutSession(),
  forgetDevice: () => bridge?.auth.forgetDevice(),
};

// Renderer -> main IPC bridge for the desktop "Offline Mode" toggle
// (Settings > Bağlantı) -- see desktop/appMode.js. Desktop-only: mobile
// has none of this since main and the renderer share the same JS process
// there (see mobileBridge.js).
export const desktopAppMode = {
  get: () => bridge?.appMode.get(),
  set: (mode) => bridge?.appMode.set(mode),
  onChange: (cb) => bridge?.appMode.onChange(cb) || (() => {}),
};

export const desktopAnalyses = {
  list: () => bridge?.analyses.list(),
  get: (id) => bridge?.analyses.get(id),
  create: (data) => bridge?.analyses.create(data),
  update: (id, data) => bridge?.analyses.update(id, data),
  remove: (id) => bridge?.analyses.remove(id),
};

export const desktopSync = {
  status: () => bridge?.sync.status(),
  forceSync: () => bridge?.sync.forceSync(),
  listConflicts: () => bridge?.sync.listConflicts(),
  resolveConflict: (conflictId, resolution) => bridge?.sync.resolveConflict(conflictId, resolution),
};

export const desktopAI = {
  query: (request) => bridge?.ai.query(request),
  // Model Manager surface (task: Local Model Manager) -- wired into
  // Settings > Local AI, see components/LocalAIPanel.jsx.
  modelStatus: () => bridge?.ai.modelStatus(),
  modelDownload: () => bridge?.ai.modelDownload(),
  modelDownloadCancel: (options) => bridge?.ai.modelDownloadCancel?.(options),
  modelRemove: () => bridge?.ai.modelRemove(),
  modelTiers: () => bridge?.ai.modelTiers?.(),
  modelSelectTier: (tier) => bridge?.ai.modelSelectTier?.(tier),
  onModelDownloadProgress: (callback) => bridge?.ai.onModelDownloadProgress(callback) || (() => {}),
};

export const desktopConnectivity = {
  getState: () => bridge?.connectivity.getState(),
  onChange: (callback) => bridge?.connectivity.onChange(callback) || (() => {}),
};

export const desktopUpdate = {
  onAvailable: (callback) => bridge?.update.onAvailable(callback) || (() => {}),
  onProgress: (callback) => bridge?.update.onProgress(callback) || (() => {}),
  getAvailable: () => bridge?.update.getAvailable?.(),
  approve: () => bridge?.update.approve(),
  install: () => bridge?.update.install(),
};
