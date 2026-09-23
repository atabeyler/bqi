// Looks up the latest published GitHub Release so the Android/desktop
// clients never have to talk to GitHub at all -- an institutional
// deployment constraint, client devices only ever talk to this server.
// Both the version-check metadata *and* the actual installer/APK download
// are proxied through here (see routes/version.js's /download/:platform,
// which streams the browser_download_url this returns) -- the client
// never sees a github.com address anywhere in the update flow.
const REPO = 'atabeyler/bqi';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

// GitHub computes and serves a SHA-256 digest for every release asset
// itself (the `digest` field, e.g. "sha256:abcd...") -- surfacing it here
// in /api/version/latest lets a client verify a downloaded asset's
// integrity before executing it, without this server or the release
// workflow having to separately generate/publish checksums. The desktop
// installer no longer needs this (electron-updater verifies its own
// generic-feed downloads against the sha512 in latest.yml instead -- see
// routes/version.js's /generic/* endpoints), but this stays for Android,
// which still downloads its APK straight from this endpoint's response.
function extractSha256(digest) {
  if (!digest) return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  return m ? m[1].toLowerCase() : null;
}

function pickAsset(assets, suffix) {
  const asset = (assets || []).find((a) => a.name?.endsWith(suffix));
  return asset ? { id: asset.id, url: asset.browser_download_url, name: asset.name, size: asset.size, sha256: extractSha256(asset.digest) } : null;
}

// Newest-published-first, drafts excluded. Shared by fetchLatestReleaseRaw
// (which just takes [0]) and findReleaseAssetByFilename below, which needs
// to look past the latest release too -- see that function's comment.
async function fetchPublishedReleases() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'bqi-server' };
  // Unauthenticated GitHub API calls only see releases on a public repo --
  // this lets the lookup keep working if the repo is ever made private.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(RELEASES_URL, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`GitHub releases lookup failed (HTTP ${r.status})`);
  const releases = await r.json();
  // GitHub's /releases response is normally created_at-descending, but that
  // ordering isn't a documented contract -- sorting explicitly by
  // published_at means a future change to release/tag creation order (or
  // GitHub's own API behavior) can't silently pick a stale release as
  // "latest".
  const candidates = Array.isArray(releases) ? releases.filter((item) => item && !item.draft) : (releases ? [releases] : []);
  return candidates.sort(
    (a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime()
  );
}

// GitHub's list endpoint (fetchPublishedReleases above) has been observed
// to keep serving a just-created release with a stale/empty `assets` array
// for many minutes after publish, even though the release itself (and its
// assets) are already fully there -- confirmed by comparing it against
// this dedicated single-release endpoint, which reflects the same release
// correctly and immediately. This is the same GitHub API flakiness
// desktop-release.yml's own top comment documents for the "list releases"
// endpoint vs. "get release by tag". Only returns null on a genuine 404
// (no published releases exist yet at all) rather than throwing, so the
// caller can fall back to the list-based lookup for that edge case.
async function fetchLatestReleaseViaLatestEndpoint() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'bqi-server' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub latest-release lookup failed (HTTP ${r.status})`);
  return r.json();
}

async function fetchLatestReleaseRaw() {
  const viaLatest = await fetchLatestReleaseViaLatestEndpoint();
  if (viaLatest) return viaLatest;
  const [release] = await fetchPublishedReleases();
  if (!release) throw new Error('GitHub releases lookup returned no published release');
  return release;
}

async function fetchLatestRelease() {
  const release = await fetchLatestReleaseRaw();
  return {
    version: (release.tag_name || '').replace(/^v/, ''),
    publishedAt: release.published_at,
    notes: release.body || '',
    assets: {
      androidApk: pickAsset(release.assets, '.apk'),
      desktopWin: pickAsset(release.assets, '.exe'),
      desktopMac: pickAsset(release.assets, '.dmg'),
      desktopLinux: pickAsset(release.assets, '.AppImage'),
    },
  };
}

export async function getLatestVersionInfo() {
  return fetchLatestRelease();
}

// Raw GitHub asset list (id/name/size, not the picked-by-suffix subset
// getLatestVersionInfo returns) -- used by the /generic/* differential
// update feed (routes/version.js) to look up exact-name assets that
// electron-builder publishes alongside the installer: latest.yml,
// latest-mac.yml, latest-linux.yml, and each installer's .blockmap.
export async function getLatestReleaseAssets() {
  const release = await fetchLatestReleaseRaw();
  return release.assets || [];
}

// electron-updater's differential downloader diffs the new installer
// against the *previous* version's blockmap/exe, by substituting the
// running app's own version into the feed URL -- so it requests a
// filename (e.g. "BQI-Setup-3.0.59.exe.blockmap") that belongs to
// an OLDER GitHub release, not the latest one. getLatestReleaseAssets()
// above only ever sees the newest release, so that request 404's and
// electron-updater falls back to a full download -- every single time,
// permanently, regardless of how many versions have shipped. Searching a
// handful of recent releases (newest first, so the common "just one
// version behind" case costs a single extra lookup) is what makes
// differential updates actually reachable.
const RELEASES_TO_SEARCH_FOR_ASSET = 10;

export async function findReleaseAssetByFilename(filename) {
  // Checked first, via the reliable single-release endpoint (see
  // fetchLatestReleaseViaLatestEndpoint's comment) -- this is what makes
  // latest.yml/latest-mac.yml/latest-linux.yml (always looked up on the
  // newest release, right after it's built) resolve immediately instead of
  // silently falling through to a stale older release below for several
  // minutes after every publish.
  const latest = await fetchLatestReleaseViaLatestEndpoint();
  const latestAsset = (latest?.assets || []).find((a) => a.name === filename);
  if (latestAsset) return latestAsset;

  const releases = await fetchPublishedReleases();
  for (const release of releases.slice(0, RELEASES_TO_SEARCH_FOR_ASSET)) {
    if (latest && release.id === latest.id) continue; // already checked above
    const asset = (release.assets || []).find((a) => a.name === filename);
    if (asset) return asset;
  }
  return null;
}

// A release asset's plain browser_download_url 404s unauthenticated once
// this repo is private -- GitHub only honors auth on the asset *API*
// endpoint (and only when it's asked for raw bytes via this Accept
// header), not on the public-facing download URL. Used by
// routes/version.js's /download/:platform (and /generic/*) to proxy the
// bytes through this server instead of ever handing a client a github.com
// URL directly.
//
// rangeHeader (optional) is forwarded as-is to GitHub's asset API so a
// client's own Range request -- electron-updater's differential update
// downloader issues these to fetch only the byte ranges that changed
// between the previously-installed installer and the new one -- reaches
// GitHub's storage instead of silently downgrading to a full download.
export async function fetchAssetBinary(assetId, rangeHeader = null) {
  const headers = { Accept: 'application/octet-stream', 'User-Agent': 'bqi-server' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (rangeHeader) headers.Range = rangeHeader;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${assetId}`, { headers });
  if (!r.ok) throw new Error(`GitHub asset download failed (HTTP ${r.status})`);
  return r;
}

export const _internal = { pickAsset, extractSha256 };
