/*
 * backend/src/lib/danish-layers.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Server-side helpers for the Danish layers in js/danish-layers.config.js.
 *
 * Three routes share this file, so the Netlify functions and the Express
 * backend behave identically (the browser only ever talks to the same-origin
 * paths, and never sees a credential):
 *
 *   GET /api/geo/dk-dtk25      Dataforsyningen WMS allow-list (DTK25, LiDAR,
 *                              historic maps and summer orthophotos) → token query
 *   GET /api/geo/dk-orto       Datafordeler GeoDanmark spring orthophoto years
 *                              → service-user username/password query
 *   GET /api/geo/dk-heritage   Slots- og Kulturstyrelsen "Fund og Fortidsminder"
 *                              WFS 1.0.0 → GeoJSON, reprojected to EPSG:4326
 *
 * Why a proxy at all
 *   • api.dataforsyningen.dk cannot restrict a token to a domain or an IP, so
 *     shipping it to a browser hands it to every visitor (and to their
 *     DevTools, history, Referer headers and any scraper). The WMS proxy
 *     attaches it as the requested `token` KVP only on the server-side URL.
 *   • Datafordeleren only serves the orthophoto to an identified service user;
 *     the credentials must not exist client-side either.
 *   • The heritage WFS speaks EPSG:25832 (UTM 32N) and answers an EPSG:4326
 *     bbox with an EMPTY feature collection instead of an error — a trap. The
 *     proxy converts the view bbox into the service's own CRS and reprojects
 *     the answer back, so Leaflet can draw it without a projection plugin.
 *
 * Every route is an allow-list, not an open proxy: the upstream URL, the LAYERS
 * value and the query parameters are rebuilt from js/danish-layers.config.js,
 * the only params that travel are the ones a WMS/WFS needs, and credentials are
 * stripped from anything a caller sends.
 */
import danishLayerConfig from './danish-layers.config.cjs';

/* The layer config, shared with the browser: the canonical file is
 * js/danish-layers.config.js and this directory keeps a generated copy of it
 * (backend/src/lib/danish-layers.config.cjs — .cjs on purpose: this package is
 * "type": "module", so a .js copy would be interpreted as ESM). The backend is
 * deployed with backend/ as its own app root and may not import anything outside
 * it.
 *
 * Keep this as a static import. Netlify's function bundler cannot trace a
 * createRequire(path.resolve(...)) lookup: it used to leave the config out of
 * dk-dtk25/dk-orto/dk-heritage and every request failed before reaching the
 * proxy. A static import is bundled by Netlify and also works unchanged on
 * Railway.
 * `node tools/sync-danish-config.mjs` regenerates the copy and
 * `--check` — run by the test suite — fails on any drift. */
export const config = danishLayerConfig;

/* ── KVP handling ─────────────────────────────────────────────────────────── */

/** Case-insensitive read of an OGC KVP parameter from a URLSearchParams. */
export function param(searchParams, name) {
    for (const [key, value] of searchParams) {
        if (key.toLowerCase() === name.toLowerCase()) return value;
    }
    return '';
}

/** Parameters a caller may pass through. Everything else is dropped. */
const PASSTHROUGH = new Set([
    'service', 'request', 'version', 'layers', 'styles', 'format', 'transparent',
    'tiled', 'width', 'height', 'srs', 'crs', 'bbox', 'exceptions', 'bgcolor',
    'typename', 'typenames', 'filter', 'maxfeatures', 'outputformat',
    'srsname', 'propertyname', 'featureid', 'viewparams', 'cql_filter'
]);
/* Never forwarded — a caller must not be able to inject credentials, and a
 * token must never be reflected back. */
const STRIPPED = new Set(['token', 'apikey', 'api_key', 'username', 'password', 'user', 'passwd']);

/**
 * Copy a caller's query string into the upstream request, keeping only the
 * parameters of the allow-list and normalising the CRS parameter so a service
 * that wants `srs` (1.1.x) or `crs` (1.3.0) always gets the right one.
 */
export function forwardParams(incoming, extra) {
    const out = new URLSearchParams();
    /* Keys the server decides (LAYERS, credentials, the CRS normalisation). KVP
     * parameter names are case-insensitive, so an incoming `LAYERS=…` must not
     * survive next to the config's `layers=…`: the service would read the first
     * one it meets, and a caller could point the request at another layer. */
    const override = new Set(Object.keys(extra || {}).map((key) => key.toLowerCase()));
    const seen = new Set();
    const spelling = new Map();          /* lowercase name → the case the caller used */
    for (const [key, value] of incoming) {
        const lower = key.toLowerCase();
        if (STRIPPED.has(lower) || !PASSTHROUGH.has(lower)) continue;
        spelling.set(lower, key);
        if (override.has(lower) || seen.has(lower)) continue;
        seen.add(lower);
        out.set(key, value);
    }
    for (const [key, value] of Object.entries(extra || {})) {
        /* Keep the caller's spelling of a parameter the server decides the value
         * of, so a WMS 1.3.0 request stays uppercase all the way upstream. */
        out.set(spelling.get(key.toLowerCase()) || key, value);
    }
    return out;
}

export function jsonProblem(status, error, extra) {
    return new Response(JSON.stringify(Object.assign({ error }, extra || {})), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}

export function missingCredentials(layer, variables) {
    // Keep deployment variable names in server logs only. The public response
    // is deliberately generic so it does not disclose configuration details.
    console.warn('[danish-proxy] Missing server credential', {
        layer: layer.id,
        variables,
    });
    return jsonProblem(503, 'service_unavailable');
}

/** Add the configured auth parameters to a fixed upstream request. Secrets are
 * only added server-side; the browser's query is stripped by forwardParams(). */
export function appendLayerAuth(layer, params) {
    const out = params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams();
    let providerUrl;
    try { providerUrl = new URL(layer.upstream); } catch { return { params: out, missing: [], error: 'invalid_upstream' }; }
    const host = providerUrl.hostname.toLowerCase();
    if (layer.auth === 'token') {
        if (providerUrl.protocol !== 'https:' || host !== 'api.dataforsyningen.dk') return { params: out, missing: [], error: 'credential_provider_mismatch' };
        const token = process.env.DATAFORSYNINGEN_TOKEN;
        if (!token) return { params: out, missing: layer.requiresCredentials || ['DATAFORSYNINGEN_TOKEN'] };
        out.set('token', token);
    } else if (layer.auth === 'basic') {
        if (providerUrl.protocol !== 'https:' || host !== 'services.datafordeler.dk') return { params: out, missing: [], error: 'credential_provider_mismatch' };
        const username = process.env.DATAFORDELER_USERNAME || process.env.DATAFORDELER_USER;
        const password = process.env.DATAFORDELER_PASSWORD;
        const missing = [];
        if (!username) missing.push('DATAFORDELER_USERNAME');
        if (!password) missing.push('DATAFORDELER_PASSWORD');
        if (missing.length) return { params: out, missing };
        out.set('username', username);
        out.set('password', password);
    }
    return { params: out, missing: [] };
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

function danishProxyAllowedOrigins() {
    return new Set(String(process.env.DANISH_PROXY_ALLOWED_ORIGINS || '')
        .split(',')
        .map((entry) => normalizedOrigin(entry.trim()))
        .filter(Boolean));
}

function sameOriginOrNoOrigin(request) {
    const headers = request.headers;
    const fetchSite = headers && headers.get && headers.get('sec-fetch-site');
    if (fetchSite && fetchSite.toLowerCase() === 'cross-site') return false;
    const originHeader = headers && headers.get && headers.get('origin');
    if (!originHeader) return true; // same-origin tile/image requests may omit Origin

    const origin = normalizedOrigin(originHeader);
    if (!origin) return false;
    try {
        if (origin === new URL(request.url).origin) return true;
    } catch {
        return false;
    }
    return danishProxyAllowedOrigins().has(origin);
}

/** The layer config entry for a route, or null. */
export function danishLayer(id) {
    return config.byId(id);
}

/* ── EPSG:25832 (ETRS89 / UTM zone 32N) ─────────────────────────────────────
 * Denmark's national WMS/WFS services publish in this grid, not in Web
 * Mercator. Gauss-Krüger (transverse Mercator) on GRS80 — the same Snyder
 * series the 3D tile proxy already uses for EPSG:2180, with the UTM
 * parameters: k0 = 0.9996, central meridian 9°E, false easting 500 000,
 * false northing 0. Accurate to well under a metre over Denmark.
 */
const GRS80_A = 6378137;
const GRS80_F = 1 / 298.257222101;

export function lonLatToEpsg25832(lonDeg, latDeg) {
    const a = GRS80_A;
    const f = GRS80_F;
    const b = a * (1 - f);
    const e2 = (a * a - b * b) / (a * a);
    const ep2 = (a * a - b * b) / (b * b);
    const k0 = 0.9996;
    const lon0 = 9 * Math.PI / 180;
    const falseEasting = 500000;
    const falseNorthing = 0;

    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
    const T = Math.tan(lat) * Math.tan(lat);
    const C = ep2 * Math.cos(lat) * Math.cos(lat);
    const A = (lon - lon0) * Math.cos(lat);
    const M = a * (
        (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * lat
        - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * lat)
        + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * lat)
        - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * lat)
    );
    const x = falseEasting + k0 * N * (
        A + (1 - T + C) * Math.pow(A, 3) / 6
        + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
    );
    const y = falseNorthing + k0 * (
        M + N * Math.tan(lat) * (
            A * A / 2
            + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
            + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
        )
    );
    return [x, y];
}

/** Inverse series (Snyder, eq. 8-17 … 8-25) — metre-accurate near Denmark. */
export function epsg25832ToLonLat(easting, northing) {
    const a = GRS80_A;
    const f = GRS80_F;
    const b = a * (1 - f);
    const e2 = (a * a - b * b) / (a * a);
    const ep2 = (a * a - b * b) / (b * b);
    const k0 = 0.9996;
    const lon0 = 9 * Math.PI / 180;
    const falseEasting = 500000;
    const falseNorthing = 0;

    const M = (northing - falseNorthing) / k0;
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    const phi1 = mu
        + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
        + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
        + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
        + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);

    const sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1), tanPhi1 = Math.tan(phi1);
    const C1 = ep2 * cosPhi1 * cosPhi1;
    const T1 = tanPhi1 * tanPhi1;
    const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
    const D = (easting - falseEasting) / (N1 * k0);

    const lat = phi1 - (N1 * tanPhi1 / R1) * (
        D * D / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720
    );
    const lon = lon0 + (
        D
        - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120
    ) / cosPhi1;
    return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

/** [west, south, east, north] in degrees → the same box in EPSG:25832 metres. */
export function bboxDegreesToEpsg25832(bbox) {
    const [w, s, e, n] = bbox;
    const corners = [
        [w, s], [e, s], [e, n], [w, n],
        [(w + e) / 2, s], [(w + e) / 2, n], [w, (s + n) / 2], [e, (s + n) / 2]
    ].map(([lon, lat]) => lonLatToEpsg25832(lon, lat));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    /* The transform is not affine, so use the extremes of all sampled corners
     * (a plain corner-to-corner box would clip the middle of the tile edge). */
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/* ── GeoJSON geometry reprojection ────────────────────────────────────────── */

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}

function reprojectCoords(coords, depth) {
    if (depth === 0) {
        const [lon, lat] = epsg25832ToLonLat(coords[0], coords[1]);
        return [round6(lon), round6(lat)];
    }
    return coords.map((c) => reprojectCoords(c, depth - 1));
}

/** Geometry depth for a GeoJSON type: Point 0, LineString 1, Polygon 2 … */
function depthFor(type) {
    switch (type) {
        case 'Point': return 0;
        case 'MultiPoint':
        case 'LineString': return 1;
        case 'MultiLineString':
        case 'Polygon': return 2;
        case 'MultiPolygon': return 3;
        default: return -1;
    }
}

/** One geometry from EPSG:25832 metres to EPSG:4326 degrees (in place → copy). */
export function reprojectGeometry(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return geometry;
    const depth = depthFor(geometry.type);
    if (depth < 0) return geometry;
    return Object.assign({}, geometry, { coordinates: reprojectCoords(geometry.coordinates, depth) });
}

/** A GeoJSON FeatureCollection with every geometry moved to EPSG:4326. */
export function reprojectFeatureCollection(collection) {
    const features = Array.isArray(collection && collection.features) ? collection.features : [];
    return {
        type: 'FeatureCollection',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
        features: features.map((f) => (f && f.geometry
            ? Object.assign({}, f, { geometry: reprojectGeometry(f.geometry) })
            : f))
    };
}

/* ── the three routes ─────────────────────────────────────────────────────── */

const CACHE_TILE = 'public, max-age=604800, immutable';
const CACHE_CDN = 'public, s-maxage=604800, stale-while-revalidate=86400';

/** Config-selected Dataforsyningen WMS — append the token server-side. */
export async function dtk25Response(request) {
    const incoming = new URL(request.url).searchParams;
    const layerId = param(incoming, 'layer') || param(incoming, 'dklayer') || 'dtk25';
    const layer = danishLayer(layerId);
    if (!layer || layer.type !== 'wms' || layer.auth !== 'token') {
        return jsonProblem(400, 'layer_not_allowed');
    }
    if (!sameOriginOrNoOrigin(request)) return jsonProblem(403, 'origin_not_allowed');

    const request_ = param(incoming, 'request').toLowerCase();
    if (request_ !== 'getmap' && request_ !== 'getcapabilities') {
        return jsonProblem(400, 'unsupported_request');
    }
    const upstream = new URL(layer.upstream);
    const upstreamParams = forwardParams(incoming, { layers: layer.layers });
    const auth = appendLayerAuth(layer, upstreamParams);
    if (auth.error) return jsonProblem(400, auth.error);
    if (auth.missing.length) return missingCredentials(layer, auth.missing);
    upstream.search = auth.params.toString();

    let res;
    try {
        res = await fetch(upstream.toString());
    } catch {
        return jsonProblem(502, 'upstream_unreachable');
    }
    const type = res.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await res.arrayBuffer());
    const head = body.toString('utf8', 0, 2000);
    const capabilities = request_ === 'getcapabilities' && res.ok && /xml/i.test(type) &&
        /WMS_Capabilities|WMT_MS_Capabilities/i.test(head);
    if (!res.ok || (!capabilities && /xml|html|json/i.test(type))) {
        const unauthorized = res.status === 401 || res.status === 403 ||
            /not authori[sz]ed|unauthorized|invalid token/i.test(head);
        return jsonProblem(unauthorized ? 401 : 502,
            unauthorized ? 'dataforsyningen_token_invalid' : 'upstream_error',
            { layer: layer.id });
    }
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': type,
            'Cache-Control': capabilities ? 'no-store' : CACHE_TILE,
            'Netlify-CDN-Cache-Control': capabilities ? 'no-store' : CACHE_CDN
        }
    });
}

/** Config-selected GeoDanmark spring WMS — identified service user required. */
export async function ortoResponse(request) {
    const incoming = new URL(request.url).searchParams;
    const layerId = param(incoming, 'layer') || param(incoming, 'dklayer') || 'orto';
    const layer = danishLayer(layerId);
    if (!layer || layer.type !== 'wms' || layer.auth !== 'basic') {
        return jsonProblem(400, 'layer_not_allowed');
    }
    if (!sameOriginOrNoOrigin(request)) return jsonProblem(403, 'origin_not_allowed');

    const request_ = param(incoming, 'request').toLowerCase();
    if (request_ !== 'getmap' && request_ !== 'getcapabilities') {
        return jsonProblem(400, 'unsupported_request');
    }
    const upstream = new URL(layer.upstream);
    /* Datafordeleren documents the service user as URL credentials
     * (?username=…&password=…). They are added here, server-side, and a caller's
     * own username/password are stripped, so a visitor can never borrow or
     * override the deployment's identity. */
    const auth = appendLayerAuth(layer, forwardParams(incoming, { layers: layer.layers }));
    if (auth.error) return jsonProblem(400, auth.error);
    if (auth.missing.length) return missingCredentials(layer, auth.missing);
    upstream.search = auth.params.toString();

    let res;
    try {
        res = await fetch(upstream.toString());
    } catch {
        return jsonProblem(502, 'upstream_unreachable');
    }
    const type = res.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await res.arrayBuffer());
    const head = body.toString('utf8', 0, 2000);
    const capabilities = request_ === 'getcapabilities' && res.ok && /xml/i.test(type) &&
        /WMS_Capabilities|WMT_MS_Capabilities/i.test(head);
    if (!res.ok || (!capabilities && /xml|html|json/i.test(type))) {
        const unauthorized = res.status === 401 || res.status === 403 ||
            /unauthorized|not authori[sz]ed|invalid (user|credential)/i.test(head);
        return jsonProblem(unauthorized ? 401 : 502,
            unauthorized ? 'datafordeler_credentials_invalid' : 'upstream_error',
            { layer: layer.id });
    }
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': type,
            'Cache-Control': capabilities ? 'no-store' : CACHE_TILE,
            'Netlify-CDN-Cache-Control': capabilities ? 'no-store' : CACHE_CDN
        }
    });
}

/**
 * Fund og Fortidsminder — WFS 1.0.0 → GeoJSON in EPSG:4326.
 *
 * GET /api/geo/dk-heritage?bbox=west,south,east,north       (degrees)
 *                         [&layer=fortidsminder]             (config entry)
 *                         [&maxFeatures=400]
 *
 * The bbox is converted to EPSG:25832 (the service's own grid) for the query
 * and every returned geometry is converted back, so the browser receives plain
 * WGS84 GeoJSON. Feature count is capped, the answer is cached, and the only
 * upstream that can be reached is the one in the config.
 */
export async function heritageResponse(request) {
    const layer = danishLayer(param(new URL(request.url).searchParams, 'layer') || 'fortidsminder');
    if (!layer || layer.type !== 'wfs') return jsonProblem(400, 'layer_not_allowed');

    const incoming = new URL(request.url).searchParams;
    const raw = param(incoming, 'bbox');
    const parts = String(raw).split(',').map(Number);
    if (parts.length !== 4 || !parts.every((v) => Number.isFinite(v))) {
        return jsonProblem(400, 'bbox_required');
    }
    const [w, s, e, n] = parts;
    if (w >= e || s >= n) return jsonProblem(400, 'bbox_invalid');
    /* Denmark plus a margin — the service is national, and this keeps the route
     * from being used to scrape arbitrary parts of the dataset. */
    if (w < 2 || e > 22 || s < 53 || n > 59) return jsonProblem(400, 'bbox_outside_coverage');

    const style = layer.wfs || {};
    const maxFeatures = Math.min(
        Math.max(1, Number(param(incoming, 'maxFeatures')) || style.maxFeatures || 400),
        style.maxFeatures || 400
    );

    const bbox25832 = bboxDegreesToEpsg25832([w, s, e, n]);
    const upstream = new URL(layer.upstream);
    const params = new URLSearchParams({
        service: 'WFS',
        version: layer.version || '1.0.0',
        request: 'GetFeature',
        typeName: style.typeName || layer.layers,
        outputFormat: 'json',
        srsName: 'EPSG:25832',
        bbox: bbox25832.map((v) => Math.round(v * 100) / 100).join(',') + ',EPSG:25832',
        maxFeatures: String(maxFeatures)
    });
    upstream.search = params.toString();

    let res;
    try {
        res = await fetch(upstream.toString(), { headers: { Accept: 'application/json' } });
    } catch {
        return jsonProblem(502, 'upstream_unreachable');
    }
    if (!res.ok) return jsonProblem(502, 'upstream_error', { status: res.status });

    let collection;
    try {
        collection = JSON.parse(await res.text());
    } catch {
        return jsonProblem(502, 'upstream_not_geojson');
    }
    const projected = reprojectFeatureCollection(collection);
    projected.totalFeatures = typeof collection.totalFeatures === 'number'
        ? collection.totalFeatures
        : projected.features.length;
    projected.numberReturned = projected.features.length;
    projected.truncated = projected.totalFeatures > projected.features.length;
    projected.layer = layer.id;

    return new Response(JSON.stringify(projected), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            /* Features change slowly (daily at most) — a short cache keeps the
             * pan/zoom interaction cheap without ever serving stale-by-a-day
             * data in an archaeological report. */
            'Cache-Control': 'public, max-age=300',
            'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400'
        }
    });
}

/** Route table shared by the Netlify functions, the dev server and the tests. */
export const dataforsyningenWmsResponse = dtk25Response;
export const datafordelerWmsResponse = ortoResponse;

export const ROUTES = {
    '/api/geo/dk-dtk25': dtk25Response,
    '/api/geo/dk-orto': ortoResponse,
    '/api/geo/dk-heritage': heritageResponse
};
