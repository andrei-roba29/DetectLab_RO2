/*
 * geoProxy.js — credential-adding, caching proxy for national LiDAR services.
 * ───────────────────────────────────────────────────────────────────────────
 * Two routes live here:
 *   /api/geo/dk-dhm        Denmark  · Dataforsyningen  (WMTS, token header)
 *   /api/geo/se-hojdmodell Sweden   · Lantmäteriet     (WMS, Basic or Bearer)
 * Both follow the same rules: a fixed upstream host, an allowlist of layers,
 * formats and request types, a size cap, a 7-day cache, and a secret that
 * never leaves this process.
 * ───────────────────────────────────────────────────────────────────────────
 * Dataforsyningen requires a token on every request. A token in client-side
 * JavaScript is visible to every visitor, so the browser instead asks THIS
 * server for tiles and the token is added here, server-side, as the "token"
 * HTTP header (the method Dataforsyningen's own documentation recommends
 * over the query parameter, because it keeps the secret out of access logs,
 * Referer headers and browser history).
 *
 *   browser → GET /api/geo/dk-dhm?service=WMTS&request=GetTile&…    (no token)
 *   server  → GET https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF?…
 *                                                           + header token:…
 *
 * The client never names an upstream host. It sends the WMTS layer, and the
 * LAYER_UPSTREAM table below decides which api.dataforsyningen.dk service
 * that maps to — so the route can never be turned into an open proxy.
 *
 * Configuration (never committed):
 *   DATAFORSYNINGEN_TOKEN=<your 32-character token>    # backend/.env
 *
 * The token is never logged and never echoed back in a response or an error.
 *
 * Safety: this is NOT an open proxy. Only GetTile/GetCapabilities are
 * forwarded, only to a host and service chosen from a fixed table, and only
 * for an allowlisted layer, format, tile-matrix-set and tile index.
 *
 * Caching: successful tiles are kept in a small in-process LRU for 7 days and
 * are returned with "Cache-Control: public, max-age=604800, immutable" so any
 * CDN or browser in front of this server caches them too. For serious traffic
 * put a real CDN (or the Nginx / Cloudflare Worker variants described in
 * DENMARK_LIDAR_DATAFORSYNINGEN.md) in front of this route.
 */
import express from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { logger } from '../logger.js';
import {
  dtk25Response,
  ortoResponse,
  heritageResponse,
} from '../../../netlify/lib/danish-layers.mjs';

const require = createRequire(import.meta.url);
/* The Danish layer definitions are shared verbatim with the browser and with
 * the Netlify functions — one description of every Danish layer. */
const danishLayers = require(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../js/danish-layers.config.js',
));

/**
 * Express ⇄ Web Response bridge: the routing logic lives once, in
 * netlify/lib/danish-layers.mjs, and both runtimes call it. `fetch` is Node's
 * global fetch, available in the Express process too.
 */
async function sendWebResponse(res, webResponse) {
  res.status(webResponse.status);
  webResponse.headers.forEach((value, key) => res.set(key, value));
  const body = Buffer.from(await webResponse.arrayBuffer());
  return res.send(body);
}

/** Minimal Request for the shared handlers, from an Express request. */
function webRequest(req, basePath) {
  const query = new URLSearchParams(req.query).toString();
  return new Request(`http://localhost${basePath}${query ? `?${query}` : ''}`, { method: 'GET' });
}

const router = express.Router();

/* ── configuration ──────────────────────────────────────────────────────── */

// WMTS layer → the api.dataforsyningen.dk service that publishes it. This
// table is the ONLY way an upstream URL can be chosen, which is what stops
// the route from becoming an open proxy.
const LAYER_UPSTREAM = new Map([
  ['dhm_terraen_skyggekort', 'https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF'],
  ['dhm_overflade_skyggekort', 'https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF'],
]);

const DEFAULT_UPSTREAM = LAYER_UPSTREAM.get('dhm_terraen_skyggekort');

// image/jpeg is the only format the DHM skyggekort WMTS publishes.
const ALLOWED_FORMATS = new Set(['image/jpeg']);
const ALLOWED_REQUESTS = new Set(['gettile', 'getcapabilities']);
const ALLOWED_TILEMATRIXSETS = new Set(['view1']);

// View1 has levels 0…13; its largest matrix is 17188 × 11719 tiles.
const MAX_TILEMATRIX = 13;
const MAX_TILE_INDEX = 17187;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 2000;               // ≈ a few hundred MB at most
const cache = new Map();                      // key → { body, type, expires }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh recency (Map keeps insertion order ⇒ cheap LRU).
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

/* ── the route ──────────────────────────────────────────────────────────── */

router.get('/geo/dk-dhm', async (req, res) => {
  const token = process.env.DATAFORSYNINGEN_TOKEN;
  if (!token) {
    // Deliberately explicit: the client turns this into the non-blocking
    // "Invalid or missing Dataforsyningen token" notice.
    return res.status(401).json({ error: 'dataforsyningen_token_missing' });
  }

  const params = req.query || {};
  const request = String(params.request || params.REQUEST || '').toLowerCase();
  if (!ALLOWED_REQUESTS.has(request)) {
    return res.status(400).json({ error: 'unsupported_request' });
  }

  // Parameter names are case-insensitive in OGC KVP, so look them up that way.
  const pick = (name) => {
    const key = Object.keys(params).find((k) => k.toLowerCase() === name);
    if (key === undefined) return '';
    const value = params[key];
    return String(Array.isArray(value) ? value[0] : value);
  };

  let target = DEFAULT_UPSTREAM;

  if (request === 'gettile') {
    const layer = pick('layer');
    if (!LAYER_UPSTREAM.has(layer)) {
      return res.status(400).json({ error: 'layer_not_allowed' });
    }
    target = LAYER_UPSTREAM.get(layer);

    if (!ALLOWED_FORMATS.has(pick('format'))) {
      return res.status(400).json({ error: 'format_not_allowed' });
    }
    if (!ALLOWED_TILEMATRIXSETS.has(pick('tilematrixset').toLowerCase())) {
      return res.status(400).json({ error: 'tilematrixset_not_allowed' });
    }

    // "7" is what this server wants; tolerate the "View1:7" spelling used by
    // the Layer's TileMatrixSetLimits so either client works.
    const matrix = Number(pick('tilematrix').replace(/^View1:/i, ''));
    const col = Number(pick('tilecol'));
    const row = Number(pick('tilerow'));
    const whole = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
    if (!whole(matrix, MAX_TILEMATRIX) ||
        !whole(col, MAX_TILE_INDEX) ||
        !whole(row, MAX_TILE_INDEX)) {
      return res.status(400).json({ error: 'bad_tile_index' });
    }
  } else {
    // GetCapabilities: let the caller choose which of the two services, but
    // still only from the table.
    const layer = pick('layer');
    if (layer && LAYER_UPSTREAM.has(layer)) target = LAYER_UPSTREAM.get(layer);
  }

  // Rebuild the upstream query from the client's parameters. A token supplied
  // by the client is ignored on purpose — ours is the only one used.
  const upstream = new URL(target);
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase() === 'token') continue;
    upstream.searchParams.set(key, Array.isArray(value) ? value[0] : String(value));
  }

  const cacheKey = upstream.pathname + upstream.search;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.set('Content-Type', cached.type);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('X-Proxy-Cache', 'HIT');
    return res.send(cached.body);
  }

  try {
    const upstreamRes = await fetch(upstream.toString(), {
      // Header form keeps the token out of upstream access logs as well.
      headers: { token },
    });
    const type = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());

    if (!upstreamRes.ok || type.includes('xml')) {
      // The service answers 200 + an OGC ServiceException for an invalid
      // token, so sniff the body as well as the status.
      const body = buffer.toString('utf8', 0, 2000);
      const unauthorized = upstreamRes.status === 401 || upstreamRes.status === 403 ||
        /not authorized|unauthorized|token/i.test(body);
      logger.warn(
        { status: upstreamRes.status, type, unauthorized },
        'Dataforsyningen upstream refused a request',
      );
      return res
        .status(unauthorized ? 401 : 502)
        .json({ error: unauthorized ? 'dataforsyningen_token_invalid' : 'upstream_error' });
    }

    cacheSet(cacheKey, { body: buffer, type, expires: Date.now() + CACHE_TTL_MS });
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('X-Proxy-Cache', 'MISS');
    return res.send(buffer);
  } catch (err) {
    logger.error({ err: err?.message }, 'Dataforsyningen proxy request failed');
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  SWEDEN — Lantmäteriet "Markhöjdmodell Visning" (terrängskuggning)
 * ═══════════════════════════════════════════════════════════════════════════
 * Why a proxy at all: the hillshade WMS is a LICENSED, fee-based product.
 * Its real access point, https://maps.lantmateriet.se/hojdmodell/wms/v1.1,
 * answers "401 Authorization Required" without credentials. Those credentials
 * are issued per organisation through Geotorget and must never be shipped to
 * a browser, so the map asks THIS server for tiles and the Authorization
 * header is attached here.
 *
 *   browser →  GET /api/geo/se-hojdmodell?SERVICE=WMS&REQUEST=GetMap&…
 *   server  →  GET https://maps.lantmateriet.se/hojdmodell/wms/v1.1?…
 *              Authorization: Basic <base64(user:password)>
 *
 * Configuration (never committed) — backend/.env:
 *   LANTMATERIET_WMS_USER=…        # Geotorget consumer account
 *   LANTMATERIET_WMS_PASSWORD=…
 * or, if your agreement issues an OAuth2 access token instead:
 *   LANTMATERIET_WMS_TOKEN=…       # sent as "Authorization: Bearer …"
 * Optional override (e.g. to point at a different licensed endpoint):
 *   LANTMATERIET_WMS_URL=https://maps.lantmateriet.se/hojdmodell/wms/v1.1
 *
 * The credentials are never logged and never echoed back in a response.
 * See SWEDEN_LIDAR_LANTMATERIET.md for how to obtain them.
 */

const SE_UPSTREAM_DEFAULT = 'https://maps.lantmateriet.se/hojdmodell/wms/v1.1';

// Layer names exactly as published by the service's GetCapabilities.
const SE_ALLOWED_LAYERS = new Set([
  'terrangskuggning',
  'terranglutning',
  'terranglutning_brunton',
  'ursprung_kvalitet',
]);

const SE_ALLOWED_FORMATS = new Set(['image/png', 'image/jpeg', 'image/png; mode=8bit']);

/** Build the Authorization header from whichever credential style is set. */
function lantmaterietAuthHeader() {
  const token = process.env.LANTMATERIET_WMS_TOKEN;
  if (token) return `Bearer ${token}`;
  const user = process.env.LANTMATERIET_WMS_USER;
  const password = process.env.LANTMATERIET_WMS_PASSWORD;
  if (user && password) {
    return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  }
  return null;
}

router.get('/geo/se-hojdmodell', async (req, res) => {
  const authorization = lantmaterietAuthHeader();
  if (!authorization) {
    // The client turns this into the non-blocking
    // "Missing or invalid Lantmäteriet (Geotorget) credentials" notice.
    return res.status(401).json({ error: 'lantmateriet_credentials_missing' });
  }

  const params = req.query || {};
  const request = String(params.request || params.REQUEST || '').toLowerCase();
  if (!ALLOWED_REQUESTS.has(request)) {
    return res.status(400).json({ error: 'unsupported_request' });
  }

  if (request === 'getmap') {
    const layers = String(params.layers || params.LAYERS || '');
    if (!layers.split(',').every((l) => SE_ALLOWED_LAYERS.has(l.trim()))) {
      return res.status(400).json({ error: 'layer_not_allowed' });
    }
    const format = String(params.format || params.FORMAT || '');
    if (!SE_ALLOWED_FORMATS.has(format)) {
      return res.status(400).json({ error: 'format_not_allowed' });
    }
    const width = Number(params.width || params.WIDTH || 0);
    const height = Number(params.height || params.HEIGHT || 0);
    // The service advertises MaxWidth/MaxHeight = 4096; we only ever need 256.
    if (!(width > 0 && height > 0 && width <= MAX_PIXELS && height <= MAX_PIXELS)) {
      return res.status(400).json({ error: 'bad_image_size' });
    }
  }

  // Rebuild the upstream query from the client's parameters. Any credential
  // supplied by the client is dropped on purpose — ours is the only one used.
  const upstream = new URL(process.env.LANTMATERIET_WMS_URL || SE_UPSTREAM_DEFAULT);
  for (const [key, value] of Object.entries(params)) {
    const lower = key.toLowerCase();
    if (lower === 'token' || lower === 'user' || lower === 'pass' || lower === 'password') continue;
    upstream.searchParams.set(key, Array.isArray(value) ? value[0] : String(value));
  }

  const cacheKey = `se|${upstream.search}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.set('Content-Type', cached.type);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('X-Proxy-Cache', 'HIT');
    return res.send(cached.body);
  }

  try {
    const upstreamRes = await fetch(upstream.toString(), { headers: { authorization } });
    const type = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());

    if (!upstreamRes.ok || type.includes('xml') || type.includes('html')) {
      // MapServer answers 200 + an OGC ServiceException for a bad request,
      // and nginx answers 401 + HTML for bad credentials, so sniff both.
      const body = buffer.toString('utf8', 0, 2000);
      const unauthorized = upstreamRes.status === 401 || upstreamRes.status === 403 ||
        /authorization required|not authori[sz]ed|unauthorized/i.test(body);
      logger.warn(
        { status: upstreamRes.status, type, unauthorized },
        'Lantmäteriet upstream refused a request',
      );
      return res
        .status(unauthorized ? 401 : 502)
        .json({ error: unauthorized ? 'lantmateriet_credentials_invalid' : 'upstream_error' });
    }

    cacheSet(cacheKey, { body: buffer, type, expires: Date.now() + CACHE_TTL_MS });
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('X-Proxy-Cache', 'MISS');
    return res.send(buffer);
  } catch (err) {
    logger.error({ err: err?.message }, 'Lantmäteriet proxy request failed');
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
});

/* ── Danish layers (js/danish-layers.config.js) ─────────────────────────────
 * Same three routes the Netlify functions expose, same shared implementation,
 * so a self-hosted backend behaves exactly like the Netlify deployment:
 *   /api/geo/dk-dtk25      DTK25 topographic WMS       (DATAFORSYNINGEN_TOKEN)
 *   /api/geo/dk-orto       GeoDanmark Ortofoto WMS     (DATAFORDELER_USER/PASSWORD)
 *   /api/geo/dk-heritage   Fund og Fortidsminder WFS   (no credential; bbox → GeoJSON)
 * Listed in js/danish-layers.config.js; documented in DATA_SOURCES.md.
 */

router.get('/geo/dk-dtk25', async (req, res) => {
  try {
    return await sendWebResponse(res, await dtk25Response(webRequest(req, '/api/geo/dk-dtk25')));
  } catch (err) {
    logger.error({ err: err?.message }, 'DTK25 proxy request failed');
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
});

router.get('/geo/dk-orto', async (req, res) => {
  try {
    return await sendWebResponse(res, await ortoResponse(webRequest(req, '/api/geo/dk-orto')));
  } catch (err) {
    logger.error({ err: err?.message }, 'GeoDanmark Ortofoto proxy request failed');
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
});

router.get('/geo/dk-heritage', async (req, res) => {
  try {
    return await sendWebResponse(res, await heritageResponse(webRequest(req, '/api/geo/dk-heritage')));
  } catch (err) {
    logger.error({ err: err?.message }, 'Fund og Fortidsminder proxy request failed');
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
});

/* The configuration the browser needs to decide whether a Danish layer can be
 * drawn — names of the variables only, never values. */
router.get('/geo/dk-status', (req, res) => {
  const credentials = {};
  danishLayers.layers.forEach((layer) => {
    if (!layer.requiresCredentials || !layer.requiresCredentials.length) return;
    credentials[layer.id] = {
      variables: layer.requiresCredentials,
      configured: layer.requiresCredentials.every((name) => Boolean(process.env[name])),
    };
  });
  return res.json({ version: danishLayers.version, credentials });
});

export default router;

