import { Router } from 'express';
import { pool } from '../config/db.js';
import { logger } from '../logger.js';

const router = Router();

// Same reasoning as layers.js: data only changes once/day via the nightly
// sync, so there's no reason to re-read the whole table on every request.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = null; // { data, cachedAt }

/**
 * Serves the current live snapshot as a standard GeoJSON FeatureCollection
 * — exactly what MapLibre expects for a GeoJSON source. This always reads
 * from the "archaeological_sites" view, so it automatically reflects
 * whichever buffer table the last successful sync published, with zero
 * awareness (or dependency) on the government server at request time.
 */
router.get('/sites', async (req, res) => {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return res.json(cache.data);
  }

  try {
    const { rows } = await pool.query(
      `SELECT object_id, attributes, ST_AsGeoJSON(geom)::json AS geometry
       FROM archaeological_sites WHERE layer_id = 0`
    );

    const featureCollection = {
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        id: row.object_id,
        properties: row.attributes,
        geometry: row.geometry,
      })),
    };

    cache = { data: featureCollection, cachedAt: Date.now() };
    res.json(featureCollection);
  } catch (err) {
    logger.error({ err }, 'Failed to load sites');
    res.status(500).json({ error: 'Failed to load sites' });
  }
});

export function clearSitesCache() {
  cache = null;
}

export default router;
