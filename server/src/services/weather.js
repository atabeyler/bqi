const WEATHER_CODE_TR = {
  0: 'Acik',
  1: 'Cogunlukla acik',
  2: 'Parcali bulutlu',
  3: 'Bulutlu',
  45: 'Sisli',
  48: 'Kiragi sisli',
  51: 'Hafif cisenti',
  53: 'Orta cisenti',
  55: 'Yogun cisenti',
  56: 'Hafif donan cisenti',
  57: 'Yogun donan cisenti',
  61: 'Hafif yagmur',
  63: 'Orta yagmur',
  65: 'Kuvvetli yagmur',
  66: 'Hafif donan yagmur',
  67: 'Yogun donan yagmur',
  71: 'Hafif kar',
  73: 'Orta kar',
  75: 'Yogun kar',
  77: 'Kar taneleri',
  80: 'Hafif saganak',
  81: 'Orta saganak',
  82: 'Kuvvetli saganak',
  85: 'Hafif kar saganagi',
  86: 'Yogun kar saganagi',
  95: 'Gok gurultulu firtina',
  96: 'Dolu olasilikli firtina',
  99: 'Yogun dolulu firtina',
};

function foldTr(s = '') {
  return s
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');
}

function extractLocation(message) {
  const raw = (message || '').trim();
  if (!raw) return null;
  const normalized = foldTr(raw);

  const prefixes = ['hava durumu', 'weather', 'temperature', 'sicaklik'];
  for (const prefix of prefixes) {
    if (normalized.startsWith(`${prefix} `)) {
      return raw.slice(prefix.length).trim() || null;
    }
  }

  const m1 = raw.match(/([\p{L}\s.-]+)\s+hava durumu/iu);
  if (m1?.[1]) return m1[1].trim();

  const m2 = raw.match(/hava durumu\s*(?:nedir|bugun|yarin|icin)?\s*([\p{L}\s.-]+)?/iu);
  if (m2?.[1]) return m2[1].trim();

  return null;
}

async function geocodeCity(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=tr&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Geocoding HTTP ${r.status}`);
  const j = await r.json();
  const first = j?.results?.[0];
  if (!first) return null;
  return {
    name: first.name,
    country: first.country,
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone,
  };
}

export async function fetchCurrentWeather(lat, lon, timezone = 'auto') {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(timezone)}&forecast_days=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Weather HTTP ${r.status}`);
  return r.json();
}

export async function getLiveWeatherReply(message) {
  const location = extractLocation(message) || 'Izmir';
  const place = await geocodeCity(location);
  if (!place) {
    return `"${location}" icin konum bulunamadi. Sehir adini tekrar yazabilir misiniz?`;
  }

  const w = await fetchCurrentWeather(place.latitude, place.longitude, place.timezone || 'auto');
  const now = w?.current || {};
  const max = w?.daily?.temperature_2m_max?.[0];
  const min = w?.daily?.temperature_2m_min?.[0];
  const code = Number(now.weather_code);
  const desc = WEATHER_CODE_TR[code] || 'Bilinmiyor';

  return [
    `**${place.name}${place.country ? `, ${place.country}` : ''} Hava Durumu (Anlik)**`,
    '',
    `- Durum: ${desc}`,
    `- Sicaklik: ${now.temperature_2m ?? '-'}°C`,
    `- Nem: ${now.relative_humidity_2m ?? '-'}%`,
    `- Ruzgar: ${now.wind_speed_10m ?? '-'} km/sa`,
    `- Gunluk Min/Max: ${min ?? '-'}°C / ${max ?? '-'}°C`,
    '',
    '_Kaynak: Open-Meteo (canli veri)_',
  ].join('\n');
}

export function isWeatherQuery(message) {
  const m = foldTr(message || '');
  return /hava durumu|weather|sicaklik|temperature|forecast|meteoroloji/.test(m);
}
