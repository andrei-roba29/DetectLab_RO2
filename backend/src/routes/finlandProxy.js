/*
 * finlandProxy.js — the same-origin proxy for the Finnish layers.
 * ───────────────────────────────────────────────────────────────────────────
 * Route:  GET /api/geo/finland?src=…
 *
 * The routing logic lives once, in backend/src/lib/finland-geo.mjs, and both
 * runtimes call it (this Express app and the Netlify function
 * netlify/functions/finland-geo.mjs) so the browser sees identical behaviour.
 * The allow-lists, the MML key handling and the cache policy are documented
 * in that library; see FINLAND_LAYERS.md for the per-layer story.
 *
 * Environment: MML_API_KEY (optional — the free avoin-karttakuva WMTS key,
 * attached server-side only, never shipped to a browser).
 */
import express from 'express';
import { finlandGeoResponse } from '../lib/finland-geo.mjs';
import { logger } from '../logger.js';

const router = express.Router();

/** Express ⇄ Web Response bridge (the danish route's pattern). */
async function sendWebResponse(res, webResponse) {
  res.status(webResponse.status);
  webResponse.headers.forEach((value, key) => res.set(key, value));
  const body = Buffer.from(await webResponse.arrayBuffer());
  return res.send(body);
}

/** Minimal Request for the shared handler, from an Express request. */
function webRequest(req) {
  const query = new URLSearchParams(req.query).toString();
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('host') || 'localhost';
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const headers = {};
  if (origin) headers.origin = origin;
  if (fetchSite) headers['sec-fetch-site'] = fetchSite;
  return new Request(`${protocol}://${host}/api/geo/finland${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers,
  });
}

router.get('/geo/finland', async (req, res) => {
  try {
    const response = await finlandGeoResponse(webRequest(req));
    if (req.method === 'HEAD') {
      res.status(response.status);
      response.headers.forEach((value, key) => res.set(key, value));
      return res.end();
    }
    return await sendWebResponse(res, response);
  } catch (err) {
    logger.error({ err }, 'finland proxy error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
