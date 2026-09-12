import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

function fakeRelease(overrides = {}) {
  return {
    tag_name: 'v2.1.140',
    published_at: '2026-08-14T00:00:00Z',
    body: 'Some notes',
    assets: [
      { name: 'BQI-2.1.140.apk', browser_download_url: 'https://x/apk', size: 100 },
      { name: 'BQI-Setup-2.1.140.exe', browser_download_url: 'https://x/exe', size: 200 },
      { name: 'BQI-Setup-2.1.140.exe.blockmap', browser_download_url: 'https://x/blockmap', size: 5 },
      { name: 'BQI-2.1.140.dmg', browser_download_url: 'https://x/dmg', size: 300 },
      { name: 'BQI-2.1.140.AppImage', browser_download_url: 'https://x/appimage', size: 400 },
      { name: 'latest.yml', browser_download_url: 'https://x/yml', size: 1 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getLatestVersionInfo', () => {
  it('strips the leading v and picks the .apk/.exe/.dmg/.AppImage assets, ignoring blockmap/yml', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [fakeRelease()] }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestVersionInfo } = await import('./releaseVersion.js');

    const info = await getLatestVersionInfo();

    expect(info.version).toBe('2.1.140');
    expect(info.assets.androidApk).toEqual({ url: 'https://x/apk', name: 'BQI-2.1.140.apk', size: 100, sha256: null });
    expect(info.assets.desktopWin).toEqual({ url: 'https://x/exe', name: 'BQI-Setup-2.1.140.exe', size: 200, sha256: null });
    expect(info.assets.desktopMac).toEqual({ url: 'https://x/dmg', name: 'BQI-2.1.140.dmg', size: 300, sha256: null });
    expect(info.assets.desktopLinux).toEqual({ url: 'https://x/appimage', name: 'BQI-2.1.140.AppImage', size: 400, sha256: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces GitHub-computed SHA-256 asset digests (BQI-003 update integrity)', async () => {
    const release = fakeRelease();
    release.assets[1].digest = `sha256:${'a'.repeat(64)}`;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [release] }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestVersionInfo } = await import('./releaseVersion.js');

    const info = await getLatestVersionInfo();

    expect(info.assets.desktopWin.sha256).toBe('a'.repeat(64));
    expect(info.assets.desktopMac.sha256).toBeNull();
  });

  it('ignores a malformed digest rather than passing it through as a hash', async () => {
    const release = fakeRelease();
    release.assets[1].digest = 'not-a-real-digest';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [release] }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestVersionInfo } = await import('./releaseVersion.js');

    const info = await getLatestVersionInfo();

    expect(info.assets.desktopWin.sha256).toBeNull();
  });

  it('fetches fresh release data on every call', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [fakeRelease()] }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestVersionInfo } = await import('./releaseVersion.js');

    await getLatestVersionInfo();
    await getLatestVersionInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the GitHub lookup itself fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestVersionInfo } = await import('./releaseVersion.js');

    await expect(getLatestVersionInfo()).rejects.toThrow('HTTP 403');
  });

  it('getLatestReleaseAssets returns the raw asset list, including blockmap/yml (unlike getLatestVersionInfo)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [fakeRelease()] }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestReleaseAssets } = await import('./releaseVersion.js');

    const assets = await getLatestReleaseAssets();

    expect(assets.map((a) => a.name)).toEqual([
      'BQI-2.1.140.apk',
      'BQI-Setup-2.1.140.exe',
      'BQI-Setup-2.1.140.exe.blockmap',
      'BQI-2.1.140.dmg',
      'BQI-2.1.140.AppImage',
      'latest.yml',
    ]);
  });

  it('skips drafts and uses the newest published release', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        fakeRelease({ tag_name: 'v2.1.999', draft: true }),
        fakeRelease({ tag_name: 'v2.1.206', draft: false }),
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLatestVersionInfo } = await import('./releaseVersion.js');

    const info = await getLatestVersionInfo();

    expect(info.version).toBe('2.1.206');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('findReleaseAssetByFilename', () => {
  it('finds an asset that only exists on an older release, not just the latest one', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        fakeRelease({ tag_name: 'v2.1.140' }),
        fakeRelease({
          tag_name: 'v2.1.139',
          published_at: '2026-08-10T00:00:00Z',
          assets: [{ name: 'BQI-Setup-2.1.139.exe.blockmap', browser_download_url: 'https://x/old-blockmap', size: 5 }],
        }),
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { findReleaseAssetByFilename } = await import('./releaseVersion.js');

    const asset = await findReleaseAssetByFilename('BQI-Setup-2.1.139.exe.blockmap');

    expect(asset).toEqual(expect.objectContaining({ name: 'BQI-Setup-2.1.139.exe.blockmap' }));
  });

  it('returns null when no recent release published that filename', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [fakeRelease()] }));
    vi.stubGlobal('fetch', fetchMock);
    const { findReleaseAssetByFilename } = await import('./releaseVersion.js');

    const asset = await findReleaseAssetByFilename('does-not-exist.exe');

    expect(asset).toBeNull();
  });
});

describe('fetchAssetBinary', () => {
  it('forwards a client Range header to GitHub so differential downloads get partial content', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 206, headers: new Map(), body: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchAssetBinary } = await import('./releaseVersion.js');

    await fetchAssetBinary(42, 'bytes=100-199');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/atabeyler/bqi/releases/assets/42',
      expect.objectContaining({ headers: expect.objectContaining({ Range: 'bytes=100-199' }) }),
    );
  });

  it('omits the Range header entirely when none is given (full download)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), body: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchAssetBinary } = await import('./releaseVersion.js');

    await fetchAssetBinary(42);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Range).toBeUndefined();
  });
});
