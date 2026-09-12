// Unifies desktopBridge.js (Electron) and mobileBridge.js (Capacitor/
// Android) behind one API, since both export the exact same shape
// (auth/analyses/sync/ai/connectivity). The UI layer (LoginPage,
// HistoryView, DashboardPage, ...) only ever needs to know "is this a
// native app or the plain web build", not which native platform.
import { isDesktop, desktopAuth, desktopAnalyses, desktopSync, desktopAI, desktopConnectivity, desktopPlatform } from './desktopBridge.js';
import { isMobileApp, mobileAuth, mobileAnalyses, mobileSync, mobileAI, mobileConnectivity, mobilePlatform } from './mobileBridge.js';

export const isNativeApp = isDesktop || isMobileApp;

export const nativeAuth = isDesktop ? desktopAuth : mobileAuth;
export const nativeAnalyses = isDesktop ? desktopAnalyses : mobileAnalyses;
export const nativeSync = isDesktop ? desktopSync : mobileSync;
export const nativeAI = isDesktop ? desktopAI : mobileAI;
export const nativeConnectivity = isDesktop ? desktopConnectivity : mobileConnectivity;
// Raw platform string reported by this native runtime (Electron's
// process.platform, or Capacitor.getPlatform()) -- used by HistoryView.jsx
// to label "this device"'s own rows without a network round-trip.
export const nativePlatform = isDesktop ? desktopPlatform : mobilePlatform;
