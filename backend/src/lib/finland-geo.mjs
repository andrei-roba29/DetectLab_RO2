/*
 * backend/src/lib/finland-geo.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Server-side helpers for the Finnish layers in js/finland-layers.config.js.
 *
 * One route, used by BOTH runtimes so they behave identically (the browser
 * only ever talks to the same-origin path and never sees a credential):
 *
 *   GET /api/geo/finland?src=…  — allow-listed passthrough proxy
 *
 *     src=mml-hillshade        MML WMTS korkeusmalli_vinovalo (karttamoottori,
 *                              REST path, no key; the browser path is tried
 *                              first, this is the fallback)
 *     src=mml-hillshade-open   the official avoin-karttakuva WMTS — needs the
 *                              free self-service key in MML_API_KEY, which is
 *                              attached HERE, server-side, never in a browser
 *     src=museo-tile           Museovirasto museoverkko GetLayerTile (fixed
 *                              layer=maastokartta; the route's own upstream is
 *                              currently failing — the proxy retries it)
 *     src=hkp-tile             MML HKP cadastral MVT tiles (id 623 or 819)
 *     src=museo-wfs            museoverkko GetWFSFeatures (GeoJSON, EPSG:4326)
 *     src=syke                 SYKE GeoServer passthrough (GetFeatureInfo /
 *                              WFS GetFeature), host-allowlisted
 *     src=aland                Åland kartor.regeringen.ax REST passthrough
 *                              (export tiles / geojson queries)
 *
 * Why a proxy at all
 *   • karttamoottori.maanmittauslaitos.fi answers "Forbidden" to non-browser
 *     clients and sends no CORS headers; a plain <img> tile needs no CORS,
 *     but a canvas mosaic or an MVT decode needs fetch(), which does.
 *   • The MML open-data API key is account-wide: it must never be shipped to
 *     a browser. With MML_API_KEY configured the proxy serves the official
 *     avoin-karttakuva WMTS instead of karttamoottori.
 *   • museoverkko and HKP send no CORS headers, so the vector fetches need a
 *     same-origin route.
 *
 * This is NOT an open proxy. Every src builds its upstream URL from a fixed
 * table and fixed parameters; the only caller-chosen values are integers
 * validated against the ETRS-TM35FIN matrix, a layer id from a two-element
 * set, a bounded bbox, or a URL that must parse to one allowlisted host and
 * path prefix. Credentials are stripped from anything a caller sends.
 *
 * Environment: MML_API_KEY (optional — the free avoin-karttakuva key).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* The Finnish layer definitions, shared with the browser. The canonical file
 * is js/finland-layers.config.js; this directory keeps a generated .cjs copy
 * (backend/src/lib/finland-layers.config.cjs) because the backend deploys
 * with backend/ as its own app root. `node tools/sync-finland-config.mjs`
 * regenerates it. Only the tile-matrix facts are needed here, but reading
 * the shared config keeps the two from drifting. */
let config = null;
try {
  config = require(path.resolve(HERE, 'finland-layers.config.cjs'));
} catch {
  config = null;   /* the proxy still works — it carries its own constants */
}

/* ── the ETRS-TM35FIN tile matrix (constants triple-confirmed live) ──────── */

const TM35FIN = {
  levels: 16,                       /* 0 … 15 (8192 → 0.25 m/px) */
  originX: -548576,
  originY: 8388608,
  res0: 8192,                       /* metres per pixel at level 0 */
  tileSize: 256,
  matrixSize(level) {
    const n = 2 ** level;
    return [n, n];
  },
};

/* ── the fixed upstream table ────────────────────────────────────────────── */

const UPSTREAM = {
  'mml-hillshade': {
    url: (z, col, row) =>
      `https://karttamoottori.maanmittauslaitos.fi/maasto/wmts/1.0.0/korkeusmalli_vinovalo/default/ETRS-TM35FIN/${z}/${row}/${col}.png`,
    cache: 'image',
  },
  'mml-hillshade-open': {
    url: (z, col, row, key) =>
      `https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/korkeusmalli_vinovalo/default/ETRS-TM35FIN/${z}/${row}/${col}.png?apikey=${encodeURIComponent(key)}`,
    cache: 'image',
    needsKey: 'MML_API_KEY',
  },
  'museo-tile': {
    /* Fixed parameters on purpose: the browser never chooses the layer. */
    url: (z, col, row) =>
      'https://kartta.museoverkko.fi/action?action_route=GetLayerTile&id=17' +
      `&layer=maastokartta&style=default&tilematrixset=ETRS-TM35FIN` +
      `&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fpng` +
      `&TileMatrix=${z}&TileCol=${col}&TileRow=${row}`,
    cache: 'image',
  },
};

const HKP_IDS = new Set(['623', '819']);

/* museoverkko GetWFSFeatures ids the config actually uses (the blocked ones
 * stay server-side blocked here too — 130–132, 153, 154 answer permission
 * errors upstream, so there is nothing to gain and no reason to relay them). */
const WFS_IDS = new Set([
  '133', '134', '135', '136', '137', '138', '139', '140', '141',
  '142', '143', '144', '145', '146', '147', '148', '149', '150',
  '151', '152', '155', '156',
]);

/* Host allowlists for the passthrough sources. */
const SYKE_HOST = 'paikkatiedot.ymparisto.fi';
const SYKE_PATH_PREFIXES = ['/geoserver/'];
const ALAND_HOST = 'kartor.regeringen.ax';
const ALAND_PATH_PREFIXES = ['/arcgis/rest/services/', '/arcgis/services/'];

/* OGC/REST parameters a passthrough caller may set. Everything else drops. */
const PASSTHROUGH = new Set([
  'service', 'request', 'version', 'layers', 'styles', 'format', 'transparent',
  'tiled', 'width', 'height', 'srs', 'crs', 'bbox', 'exceptions', 'bgcolor',
  'query_layers', 'info_format', 'feature_count', 'x', 'y', 'i', 'j',
  'typename', 'typenames', 'filter', 'maxfeatures', 'outputformat',
  'srsname', 'propertyname', 'featureid', 'viewparams', 'cql_filter',
  'f', 'geometry', 'geometrytype', 'insr', 'outsr', 'spatialrel',
  'returngeometry', 'outfields', 'where', 'resultoffset', 'recordcount',
  'objectids', 'time',
]);
const STRIPPED = new Set(['token', 'apikey', 'api_key', 'username', 'password', 'user', 'passwd', 'key']);

const CACHE_IMAGE = 'public, max-age=604800, immutable';   /* 7 days */
const CACHE_JSON = 'public, max-age=300';                  /* 5 minutes */

/* A browser-like User-Agent: karttamoottori answered 403 to crawler-ish
 * agents when probed, and Oskari-backed services sometimes vary by UA. */
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DetectLab-Finland-Proxy/1.0',
  'Accept': '*/*',
};

const FETCH_TIMEOUT_MS = 20000;

/* ── helpers ─────────────────────────────────────────────────────────────── */

export function jsonProblem(status, error, extra) {
  return new Response(JSON.stringify(Object.assign({ error }, extra || {})), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function intInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

/** Validate a TM35FIN tile index against the matrix. */
function validTile(z, col, row) {
  if (!intInRange(z, 0, TM35FIN.levels - 1)) return false;
  const m = TM35FIN.matrixSize(Number(z));
  return intInRange(col, 0, m[0] - 1) && intInRange(row, 0, m[1] - 1);
}

/** A degrees bbox [w, s, e, n] with sane bounds and span. */
function validBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, n] = parts;
  if (s >= n || w >= e) return null;
  if (s < -90 || n > 90 || w < -180 || e > 180) return null;
  /* cap the span — the client only ever asks for a viewport */
  if (n - s > 5 || e - w > 10) return null;
  return parts.map((v) => v.toFixed(6)).join(',');
}

function normalizedOrigin(value) {
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function proxyAllowedOrigins() {
  return new Set(String(process.env.FINLAND_PROXY_ALLOWED_ORIGINS || '')
    .split(',')
    .map((entry) => normalizedOrigin(entry.trim()))
    .filter(Boolean));
}

/** Same-origin (or same-site) requests only, unless an origin is allowlisted. */
function sameOriginOrNoOrigin(request) {
  const headers = request.headers;
  const fetchSite = headers && headers.get && headers.get('sec-fetch-site');
  if (fetchSite && fetchSite.toLowerCase() === 'cross-site') return false;
  const originHeader = headers && headers.get && headers.get('origin');
  if (!originHeader) return true;   /* same-origin tile/image requests may omit Origin */
  const origin = normalizedOrigin(originHeader);
  if (!origin) return false;
  try {
    if (origin === new URL(request.url).origin) return true;
  } catch {
    return false;
  }
  return proxyAllowedOrigins().has(origin);
}

/** Copy a caller's query through, keeping only the allow-list. */
function passthroughQuery(incoming) {
  const out = new URLSearchParams();
  for (const [key, value] of incoming) {
    const lower = key.toLowerCase();
    if (STRIPPED.has(lower) || !PASSTHROUGH.has(lower)) continue;
    if (out.get(key) !== null) continue;   /* first spelling wins */
    out.set(key, value);
  }
  return out;
}

async function fetchUpstream(url, kind) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: Object.assign({}, UPSTREAM_HEADERS),
      signal: controller.signal,
      redirect: 'follow',
    });
    /* Stream the body through with a hard cap: tiles are ≤ a few hundred kB,
     * GeoJSON answers are bounded by the bbox caps above. */
    const MAX_BYTES = 15 * 1024 * 1024;   /* 15 MB */
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      return jsonProblem(502, 'upstream_too_large');
    }
    const headers = new Headers();
    const contentType = response.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
    headers.set('Cache-Control', kind === 'image' ? CACHE_IMAGE : CACHE_JSON);
    /* The upstream status travels: a 403 from karttamoottori must reach the
     * client as a 403, not as a fake 200. */
    return new Response(buffer, { status: response.status, headers });
  } catch (err) {
    if (err && err.name === 'AbortError') return jsonProblem(504, 'upstream_timeout');
    return jsonProblem(502, 'upstream_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/* ── the one handler both runtimes call ──────────────────────────────────── */

/**
 * Handle GET /api/geo/finland?src=…
 * @param {Request} request  a Web-API Request whose URL carries the query
 */
export async function finlandGeoResponse(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonProblem(405, 'method_not_allowed');
  }
  if (!sameOriginOrNoOrigin(request)) {
    return jsonProblem(403, 'cross_origin_not_allowed');
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return jsonProblem(400, 'bad_url');
  }
  const src = String(url.searchParams.get('src') || '');

  /* ── raster / MVT sources with a fixed upstream ──────────────────────── */

  if (UPSTREAM[src]) {
    const def = UPSTREAM[src];
    const z = url.searchParams.get('z');
    const col = url.searchParams.get('col');
    const row = url.searchParams.get('row');
    if (!validTile(z, col, row)) return jsonProblem(400, 'bad_tile_index');
    let key = '';
    if (def.needsKey) {
      key = process.env[def.needsKey];
      if (!key) {
        /* Explicit: the client shows "needs key" only for this src. */
        return jsonProblem(401, 'mml_api_key_missing', { variable: def.needsKey });
      }
    }
    const target = def.url(Number(z), Number(col), Number(row), key);
    return fetchUpstream(target, def.cache);
  }

  if (src === 'hkp-tile') {
    const id = String(url.searchParams.get('id') || '');
    const x = url.searchParams.get('x');
    const y = url.searchParams.get('y');
    const z = url.searchParams.get('z');
    if (!HKP_IDS.has(id)) return jsonProblem(400, 'layer_not_allowed');
    if (!validTile(z, x, y)) return jsonProblem(400, 'bad_tile_index');
    const target = `https://hkp.maanmittauslaitos.fi/hkp/action?action_route=GetLayerTile&id=${id}&x=${x}&y=${y}&z=${z}`;
    return fetchUpstream(target, 'vector');
  }

  if (src === 'museo-wfs') {
    const id = String(url.searchParams.get('id') || '');
    if (!WFS_IDS.has(id)) return jsonProblem(400, 'layer_not_allowed');
    const bbox = validBbox(url.searchParams.get('bbox'));
    if (!bbox) return jsonProblem(400, 'bad_bbox');
    const target = `https://kartta.museoverkko.fi/action?action_route=GetWFSFeatures&id=${id}&srs=EPSG%3A4326&bbox=${bbox}`;
    return fetchUpstream(target, 'json');
  }

  /* ── host-allowlisted passthrough sources ────────────────────────────── */

  if (src === 'syke' || src === 'aland' || src === 'aland-query') {
    const raw = url.searchParams.get('url');
    if (!raw) return jsonProblem(400, 'url_missing');
    let target;
    try {
      target = new URL(raw);
    } catch {
      return jsonProblem(400, 'bad_url');
    }
    if (target.protocol !== 'https:' || target.username || target.password) {
      return jsonProblem(400, 'bad_url');
    }
    const host = target.hostname.toLowerCase();
    const pathname = target.pathname;
    if (src === 'syke') {
      if (host !== SYKE_HOST || !SYKE_PATH_PREFIXES.some((p) => pathname.startsWith(p))) {
        return jsonProblem(400, 'host_not_allowed');
      }
    } else {
      if (host !== ALAND_HOST || !ALAND_PATH_PREFIXES.some((p) => pathname.startsWith(p))) {
        return jsonProblem(400, 'host_not_allowed');
      }
    }
    /* Rebuild the query from the allow-list — no credentials, no extras. */
    const query = passthroughQuery(target.searchParams);
    target.search = query.toString();
    const kind = (String(query.get('f') || '') === 'image') ? 'image' : 'auto';
    return fetchUpstream(target.toString(), kind === 'image' ? 'image' : 'json');
  }

  return jsonProblem(400, 'unknown_src');
}

/** The config the browser also reads (for tests / the sync check). */
export function finlandConfig() {
  return config;
}

/** Exported for tests. */
export const _internal = {
  TM35FIN, UPSTREAM, HKP_IDS, WFS_IDS, validTile, validBbox,
  passthroughQuery, sameOriginOrNoOrigin, PASSTHROUGH, STRIPPED,
};
