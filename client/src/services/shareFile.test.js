import { describe, it, expect, vi, beforeEach } from 'vitest';

// @capacitor/* plugin proxies have no own/reflectable properties in a plain
// jsdom test environment (vi.spyOn can't attach to them -- "property not
// defined on the object") -- mocked as plain objects instead, which also
// keeps these tests decoupled from Capacitor's actual web-fallback
// implementations (irrelevant here; only the *native* branch is under test).
const isNativePlatform = vi.fn(() => true);
const writeFile = vi.fn().mockResolvedValue(undefined);
const getUri = vi.fn().mockResolvedValue({ uri: 'file:///cache/report.pdf' });
const fileOpenerOpen = vi.fn().mockResolvedValue(undefined);
const shareShare = vi.fn().mockResolvedValue(undefined);

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform } }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile, getUri }, Directory: { Cache: 'CACHE' } }));
vi.mock('@capacitor-community/file-opener', () => ({ FileOpener: { open: fileOpenerOpen } }));
vi.mock('@capacitor/share', () => ({ Share: { share: shareShare } }));

const { shareOrDownloadBlob, downloadBlob, canShareFiles, base64ToBlob } = await import('./shareFile.js');

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
  isNativePlatform.mockReturnValue(false);
  writeFile.mockClear().mockResolvedValue(undefined);
  getUri.mockClear().mockResolvedValue({ uri: 'file:///cache/report.pdf' });
  fileOpenerOpen.mockClear().mockResolvedValue(undefined);
  shareShare.mockClear().mockResolvedValue(undefined);
});

describe('base64ToBlob', () => {
  it('decodes a base64 string into a Blob of the given mime type', () => {
    const blob = base64ToBlob(btoa('hello'), 'text/plain');
    expect(blob.type).toBe('text/plain');
    expect(blob.size).toBe(5);
  });
});

describe('canShareFiles', () => {
  it('is true when both canShare and share exist on navigator', () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: vi.fn() });
    expect(canShareFiles()).toBe(true);
  });

  it('is false when the platform has no file-share support', () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, share: undefined });
    expect(canShareFiles()).toBe(false);
  });
});

describe('shareOrDownloadBlob', () => {
  it('calls navigator.share with the file when the platform supports it', async () => {
    const shareMock = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: shareMock });

    await shareOrDownloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf', 'BQI Raporu');

    expect(shareMock).toHaveBeenCalledTimes(1);
    const arg = shareMock.mock.calls[0][0];
    expect(arg.title).toBe('BQI Raporu');
    expect(arg.files[0].name).toBe('report.pdf');
  });

  it('falls back to a download when the platform has no file-share support', async () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, share: undefined });
    const clickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    await shareOrDownloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf', 'title');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalled();
    document.createElement.mockRestore();
  });

  it('silently does nothing when the user dismisses the share sheet (AbortError)', async () => {
    const shareMock = vi.fn(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); });
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: shareMock });
    const clickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    await shareOrDownloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf', 'title');

    expect(shareMock).toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled(); // no fallback download on a user cancel
    document.createElement.mockRestore();
  });

  it('falls back to a download when navigator.share rejects for a reason other than AbortError', async () => {
    const shareMock = vi.fn(async () => { throw new Error('some other failure'); });
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: shareMock });
    const clickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    await shareOrDownloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf', 'title');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    document.createElement.mockRestore();
  });
});

// Capacitor's Android WebView has no working <a download> click() or
// navigator.share -- these cover the native-only path that replaces both
// (mobileBridge.js's mobileUpdate.approve() write-to-cache + FileOpener.open
// pattern, generalized here, plus @capacitor/share for the actual share
// sheet). See shareFile.js's top-of-file comment for why this exists.
describe('native platform (Capacitor Android)', () => {
  beforeEach(() => {
    isNativePlatform.mockReturnValue(true);
    // FileReader (used to base64-encode the blob for Filesystem.writeFile)
    // isn't driven by jsdom's real async event loop reliably in this
    // environment -- stub it to resolve synchronously via onloadend.
    vi.stubGlobal('FileReader', class {
      readAsDataURL() { this.result = 'data:application/pdf;base64,eA=='; this.onloadend?.(); }
    });
  });

  it('canShareFiles is true on native regardless of navigator support', () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, share: undefined });
    expect(canShareFiles()).toBe(true);
  });

  it('downloadBlob writes to cache and opens the file instead of clicking an <a> tag', async () => {
    const clickSpy = vi.fn();
    vi.spyOn(document, 'createElement').mockImplementation(() => ({ click: clickSpy }));

    await downloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf');

    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'report.pdf' }));
    expect(fileOpenerOpen).toHaveBeenCalledWith({ filePath: 'file:///cache/report.pdf', contentType: 'application/pdf' });
    expect(clickSpy).not.toHaveBeenCalled();
    document.createElement.mockRestore();
  });

  it('shareOrDownloadBlob uses Share.share with the cached file URI, not navigator.share', async () => {
    const navShare = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share: navShare });

    await shareOrDownloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf', 'BQI Raporu');

    expect(shareShare).toHaveBeenCalledWith(expect.objectContaining({ url: 'file:///cache/report.pdf', title: 'BQI Raporu' }));
    expect(navShare).not.toHaveBeenCalled();
  });

  it('shareOrDownloadBlob falls back to FileOpener.open when the native share sheet fails', async () => {
    shareShare.mockRejectedValueOnce(new Error('share failed'));

    await shareOrDownloadBlob(new Blob(['x']), 'report.pdf', 'application/pdf', 'title');

    expect(fileOpenerOpen).toHaveBeenCalled();
  });
});
