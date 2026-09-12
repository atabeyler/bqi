import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Generated once per install and persisted alongside the local database —
// BQI-WIN-XXXXXXXX / BQI-MAC-XXXXXXXX / BQI-LINUX-XXXXXXXX depending on the
// host OS (see server/src/routes/devices.js's DEVICE_ID_RE, which is
// deliberately loose to accept all three). Deliberately just an identifier
// (no secret material) so it's fine to log/display and to send to the
// server on every sync call.
const PLATFORM_TAG = { win32: 'WIN', darwin: 'MAC', linux: 'LINUX' };

export function getOrCreateDeviceId(userDataDir, platform = process.platform) {
  const file = path.join(userDataDir, 'device.json');
  fs.mkdirSync(userDataDir, { recursive: true });

  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.deviceId) return data.deviceId;
    } catch {
      // Corrupt device.json -- fall through and mint a new id rather than
      // crash the app over a file that only ever holds a non-secret label.
    }
  }

  const tag = PLATFORM_TAG[platform] || 'DESKTOP';
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const deviceId = `BQI-${tag}-${suffix}`;
  fs.writeFileSync(file, JSON.stringify({ deviceId, createdAt: new Date().toISOString() }, null, 2));
  return deviceId;
}
