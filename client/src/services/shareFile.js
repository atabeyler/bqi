import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';

// A plain <a href={blobUrl} download> click() and the Web Share API
// (navigator.share/canShare with File objects) both work on desktop
// browsers and Electron, but are unreliable-to-silently-inert inside
// Capacitor's Android WebView -- there is no OS download manager wired up
// to a WebView blob download the way a real browser has one, so the
// buttons looked like they did nothing (observed firsthand on a real
// device: DOCX/PDF/share buttons produced no visible result at all).
// mobileBridge.js's mobileUpdate.approve() already solved exactly this for
// APK downloads with the write-to-cache + FileOpener.open() pattern below;
// this mirrors that, generalized to any blob, plus @capacitor/share for
// the actual share sheet (Share.share() takes a file:// URI directly on
// Android, no separate FileProvider wiring needed beyond what
// @capacitor-community/file-opener's manifest entry already registers).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function writeToCache(blob, filename) {
  const data = await blobToBase64(blob);
  await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
  const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
  return uri;
}

// "Download" on Android WebView has no direct equivalent -- opening the
// saved file (the same thing the in-app update flow already does for a
// downloaded APK) is the closest real action: the user sees/reads it
// immediately and can still use Android's own "Save"/"Share" from whatever
// viewer app opens it.
export async function downloadBlob(blob, filename, mimeType) {
  if (Capacitor.isNativePlatform()) {
    const uri = await writeToCache(blob, filename);
    await FileOpener.open({ filePath: uri, contentType: mimeType });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Shares a Blob via the native OS share sheet (AirDrop, Messages, Mail,
// WhatsApp, Print, etc. on iOS/Android) when the platform supports file
// sharing; falls back to a normal browser download everywhere else
// (desktop browsers largely don't support navigator.share with files).
export async function shareOrDownloadBlob(blob, filename, mimeType, shareTitle) {
  if (Capacitor.isNativePlatform()) {
    try {
      const uri = await writeToCache(blob, filename);
      await Share.share({ url: uri, title: shareTitle, dialogTitle: shareTitle });
      return;
    } catch (e) {
      if (e?.message?.toLowerCase?.().includes('cancel')) return; // user dismissed the share sheet
      // Fall through to FileOpener below for any other failure.
    }
    await downloadBlob(blob, filename, mimeType);
    return;
  }

  const file = new File([blob], filename, { type: mimeType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: shareTitle });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user dismissed the share sheet
      // Fall through to a plain download for any other failure.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function canShareFiles() {
  return Capacitor.isNativePlatform() || !!(navigator.canShare && navigator.share);
}

export function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
