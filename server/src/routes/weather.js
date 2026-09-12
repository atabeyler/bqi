import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { fetchCurrentWeather } from '../services/weather.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// Proxies the live-temperature lookup so the browser doesn't send each
// user's coordinates directly to a third-party API (Open-Meteo) on every
// dashboard session — the server makes that call instead.
router.get('/current', authMiddleware, async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng gerekli' });
    }
    const data = await fetchCurrentWeather(lat, lng);
    const temp = data?.current?.temperature_2m;
    res.json({ temperature: Number.isFinite(temp) ? Math.round(temp) : null });
  } catch (err) {
    logger.warn({ err }, '[Weather] current lookup failed');
    res.status(502).json({ error: 'Hava durumu alınamadı' });
  }
});

export default router;
