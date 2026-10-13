/*
 * netlify/lib/map3d-tile.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Shared core of the 3D terrain tile proxy.
 *
 * WHY IT EXISTS
 *   MapLibre GL JS loads every raster tile through `new Image()` with
 *   `crossOrigin = "anonymous"` (dist/maplibre-gl.js, image loader). A host
 *   that does not answer `Access-Control-Allow-Origin` therefore yields NO
 *   tile at all — unlike the 2D Leaflet layers, which are plain <img> tiles and
 *   never needed CORS. Three of the site's raster families are in that
 *   situation, plus two historical sheets that only exist in EPSG:2180:
 *
 *     • CENAGIS / IH PAN GeoServer (pastmaps.cenagis.edu.pl)  – no CORS
 *     • geo-spatial.org eharta GeoServer (services.geo-spatial.org) – no CORS
 *     • CAST CORONA GeoWebCache (geoserve.cast.uark.edu)      – documented no CORS
 *     • EEA discomap Copernicus VHR WMS                       – not guaranteed (SATELLITE_COPERNICUS_VHR.md)
 *     • ihpan:warszawaOKI_2180 / ihpan:rauch_2180            – EPSG:2180 only
 *
 * WHAT IT DOES
 *   GET /api/map3d/tile?layer=<registry id>&z=&x=&y=[&t=<time>][&m=<mode>][&p=<product>]
 *
 *   1. Looks the layer up in the SHARED REGISTRY (js/layer-registry.js).
 *      Unknown ids are rejected, so this is not an open proxy: the only URLs
 *      it can ever fetch are the ones the site itself defines.
 *   2. Rebuilds the upstream request for exactly that tile:
 *        – WMS  → GetMap with the tile bbox in EPSG:3857, or, when the layer
 *          declares another CRS (EPSG:2180 / EPSG:4326), the bbox transformed
 *          into that CRS and padded so the returned image fully covers the
 *          Web-Mercator tile.
 *        – WMTS → KVP GetTile (time dimension carried through).
 *        – XYZ / ArcGIS tiles → the very same template, resolved on the server.
 *        – module-backed country LiDAR (js/ahn-layer.js, js/ign-mdt-layer.js,
 *          js/geoportal-nmt-layer.js, js/lantmateriet-hojdmodell-layer.js, …)
 *          → the module itself is called for that tile box, so a layer whose
 *          URL builder needs a bbox is still served (mode dropdown included).
 *   3. Caches the result (warm-container memory + CDN headers) and answers
 *      same-origin, so the browser sees no CORS at all.
 *   4. Returns a transparent 1×1 PNG for upstream failures instead of a 4xx/5xx
 *      storm, tagging the response with X-Map3D-Upstream(-Status) so the 3D
 *      status panel can explain what happened.
 *
 * Used by:
 *   • netlify/functions/map3d-tile.mjs  (production, routed in netlify.toml)
 *   • tools/map3d-dev-server.mjs        (local/preview dev server)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { countryModuleScope } from './map3d-country-modules.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(HERE, '../../js/layer-registry.js');

/* The registry is shared verbatim with the browser. */
export const registry = require(REGISTRY_PATH);

const MEMORY_TTL_MS = 6 * 60 * 60 * 1000;   // 6 h inside a warm container
const MEMORY_MAX_TILES = 256;               // ~256 × 40 kB worst case
const memoryTiles = new Map();              // key → { at, body: Buffer, type }

/* A 1×1 transparent PNG — the “nothing to draw here” answer. */
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAcCBlCwAAAABJRU5ErkJggg==',
    'base64'
);

/* ── Web-Mercator tile maths (EPSG:3857 = the 3D grid) ────────────────────── */
export const MERCATOR_R = 6378137;
export const MERCATOR_HALF = Math.PI * MERCATOR_R;

export function tileBounds3857(z, x, y) {
    const n = Math.pow(2, z);
    const size = (2 * MERCATOR_HALF) / n;
    const minX = -MERCATOR_HALF + x * size;
    const maxY = MERCATOR_HALF - y * size;
    return [minX, maxY - size, minX + size, maxY];   // [minX, minY, maxX, maxY]
}

export function lonLatTo3857(lon, lat) {
    return [
        MERCATOR_R * lon * Math.PI / 180,
        MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2))
    ];
}

export function mercatorToLonLat(x, y) {
    return [
        (x / MERCATOR_R) * 180 / Math.PI,
        (2 * Math.atan(Math.exp(y / MERCATOR_R)) - Math.PI / 2) * 180 / Math.PI
    ];
}

/* ── EPSG:2180 (PL-1992) — the only non-3857 CRS a layer declares today ────
 * Gauss-Krüger (Transverse Mercator) on GRS80:
 *    a = 6378137, 1/f = 298.257222101, k0 = 0.9993, lon0 = 19°E,
 *    false easting 500 000, false northing −5 300 000.
 * Snyder's series — accurate to millimetres within the country. */
const GRS80_A = 6378137;
const GRS80_F = 1 / 298.257222101;

export function lonLatToEpsg2180(lonDeg, latDeg) {
    const a = GRS80_A;
    const f = GRS80_F;
    const b = a * (1 - f);
    const e2 = (a * a - b * b) / (a * a);
    const ep2 = (a * a - b * b) / (b * b);
    const k0 = 0.9993;
    const lon0 = 19 * Math.PI / 180;
    const falseEasting = 500000;
    const falseNorthing = -5300000;

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

/**
 * Tile bbox expressed in the CRS the service wants.
 * Returns { bbox: [minX, minY, maxX, maxY], flipAxis: boolean }.
 */
export function tileBboxInCrs(z, x, y, crs) {
    const box = tileBounds3857(z, x, y);
    const corners = [
        [box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]],
        [(box[0] + box[2]) / 2, box[1]], [(box[0] + box[2]) / 2, box[3]],
        [box[0], (box[1] + box[3]) / 2], [box[2], (box[1] + box[3]) / 2]
    ];
    const target = String(crs || 'EPSG:3857').toUpperCase();

    if (target === 'EPSG:3857' || target === 'EPSG:900913') {
        return { bbox: box, flipAxis: false };
    }
    if (target === 'EPSG:4326' || target === 'CRS:84' || target === 'EPSG:4258') {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        corners.forEach(([cx, cy]) => {
            const [lon, lat] = mercatorToLonLat(cx, cy);
            minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        });
        return {
            bbox: [minLon, minLat, maxLon, maxLat],
            flipAxis: target !== 'CRS:84'      /* EPSG:4326 in WMS ≥1.3.0 is lat,lon */
        };
    }
    if (target === 'EPSG:2180') {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        corners.forEach(([cx, cy]) => {
            const [lon, lat] = mercatorToLonLat(cx, cy);
            const [ex, ny] = lonLatToEpsg2180(lon, lat);
            minX = Math.min(minX, ex); maxX = Math.max(maxX, ex);
            minY = Math.min(minY, ny); maxY = Math.max(maxY, ny);
        });
        /* Transverse Mercator is not affine: the exact bbox of the transformed
         * square bulges, so pad by 8 % to guarantee full coverage of the tile
         * (the sheet is a city plan, the padding is a few hundred metres). */
        const padX = (maxX - minX) * 0.08 || 100;
        const padY = (maxY - minY) * 0.08 || 100;
        return {
            bbox: [minX - padX, minY - padY, maxX + padX, maxY + padY],
            flipAxis: false,
            approximate: true,
            padMeters: [padX, padY]
        };
    }
    return null;    /* unsupported CRS → documented rather than silently wrong */
}

/* ── registry-backed upstream URLs ───────────────────────────────────────── */
export function layerById(id) {
    return registry.get(id);
}

export function buildUpstreamUrl(def, { z, x, y, time, product, mode }) {
    const resolved = registry.resolve(def) || def;
    const size = resolved.tileSize || 256;
    const timeValue = time != null && time !== '' ? time : (def.time ? def.time.value : '');

    /* Country LiDAR layers whose URL builder needs the tile bbox instead of
     * z/x/y (WMS GetMap, ArcGIS exportImage): the module that the 2D map uses
     * is evaluated in a sandbox and asked for exactly this tile. */
    if (def.kind === 'dynamic' && def.builder && def.builder.module) {
        const url = registry.tileUrlAt(def, z, x, y, { modules: countryModuleScope(), mode: mode || '' });
        if (!url) return { error: 'per-tile-builder-unavailable', module: def.builder.fn };
        return { url, crs: def.crs || 'EPSG:3857', perTile: true };
    }

    if (resolved.kind === 'wms') {
        const crs = resolved.crs || 'EPSG:3857';
        const inCrs = tileBboxInCrs(z, x, y, crs);
        if (!inCrs) return { error: 'unsupported-crs', crs };
        const version = String(resolved.version || '1.3.0');
        const bbox = inCrs.flipAxis
            ? [inCrs.bbox[1], inCrs.bbox[0], inCrs.bbox[3], inCrs.bbox[2]]
            : inCrs.bbox;
        const params = new URLSearchParams();
        params.set('service', 'WMS');
        params.set('request', 'GetMap');
        params.set('version', version);
        /* Mode-switched WMS (France LiDAR HD) uses the layer of the requested
         * product; every other definition keeps its single layer string. */
        params.set('layers', registry.layerOf(def, { mode: mode || '' }));
        params.set('styles', '');
        params.set('format', resolved.format || 'image/png');
        params.set('transparent', resolved.transparent ? 'true' : 'false');
        params.set(version >= '1.3.0' ? 'crs' : 'srs', crs);
        params.set('width', String(size));
        params.set('height', String(size));
        params.set('bbox', bbox.map(v => v.toFixed(4)).join(','));
        Object.keys(resolved.params || {}).forEach(key => {
            const value = resolved.params[key];
            if (value !== '' && value != null) params.set(key, String(value));
        });
        if (def.time && timeValue) params.set(def.time.param || 'TIME', String(timeValue));
        const url = resolved.url + (resolved.url.includes('?') ? '&' : '?') + params.toString();
        return { url, crs, approximate: !!inCrs.approximate };
    }

    if (resolved.kind === 'dynamic') {
        /* CORONA: one product per request. The client passes the product name
         * (from the same catalogue the 2D layer uses). */
        if (!product || !/^[A-Za-z0-9_.\-]+$/.test(product)) return { error: 'missing-product' };
        const params = new URLSearchParams();
        params.set('service', 'WMS');
        params.set('request', 'GetMap');
        params.set('version', resolved.version || '1.1.1');
        params.set('layers', 'corona:' + product);
        params.set('styles', '');
        params.set('format', resolved.format || 'image/png');
        params.set('transparent', 'true');
        params.set('srs', resolved.crs || 'EPSG:900913');
        params.set('width', String(size));
        params.set('height', String(size));
        params.set('bbox', tileBounds3857(z, x, y).map(v => v.toFixed(4)).join(','));
        Object.keys(resolved.params || {}).forEach(key => params.set(key, String(resolved.params[key])));
        return { url: resolved.url + '?' + params.toString(), crs: resolved.crs || 'EPSG:900913' };
    }

    if (resolved.kind === 'wmts') {
        const params = new URLSearchParams();
        params.set('SERVICE', 'WMTS');
        params.set('REQUEST', 'GetTile');
        params.set('VERSION', resolved.version || '1.0.0');
        params.set('LAYER', resolved.layer || '');
        params.set('STYLE', '');
        params.set('FORMAT', resolved.format || 'image/png');
        params.set('TILEMATRIXSET', resolved.crs || 'EPSG:3857');
        params.set('TILEMATRIX', (resolved.crs || 'EPSG:3857') + ':' + z);
        params.set('TILEROW', String(y));
        params.set('TILECOL', String(x));
        if (def.time && timeValue) params.set(def.time.param || 'TIME', String(timeValue));
        return { url: resolved.url + (resolved.url.includes('?') ? '&' : '?') + params.toString(), crs: resolved.crs || 'EPSG:3857' };
    }

    /* xyz / arcgis-image: template substitution only — the service is already
     * on the Web-Mercator grid. */
    const template = resolved.url || resolved.template || '';
    if (!template) return { error: 'no-template' };
    return {
        url: template
            .replace(/\{z\}/g, String(z))
            .replace(/\{x\}/g, String(x))
            .replace(/\{y\}/g, String(y))
            .replace(/\{-y\}/g, String(Math.pow(2, z) - 1 - y)),
        crs: 'EPSG:3857'
    };
}

/* ── validation (this is what keeps the proxy from being an open relay) ──── */
export function validateTileRequest(url) {
    const layerId = url.searchParams.get('layer') || '';
    const def = layerById(layerId);
    if (!def) return { ok: false, status: 404, reason: 'unknown-layer' };
    const z = Number(url.searchParams.get('z'));
    const x = Number(url.searchParams.get('x'));
    const y = Number(url.searchParams.get('y'));
    if (!Number.isInteger(z) || z < 0 || z > 22) return { ok: false, status: 400, reason: 'bad-z' };
    const n = Math.pow(2, z);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
        return { ok: false, status: 400, reason: 'bad-xy' };
    }
    const time = url.searchParams.get('t') || '';
    if (time && !/^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$/.test(time)) {
        return { ok: false, status: 400, reason: 'bad-time' };
    }
    const product = url.searchParams.get('p') || '';
    if (product && !/^[A-Za-z0-9_.\-]{4,64}$/.test(product)) {
        return { ok: false, status: 400, reason: 'bad-product' };
    }
    /* Renderer mode of a module-backed layer (country LiDAR dropdown). */
    const mode = url.searchParams.get('m') || '';
    if (mode && !/^[A-Za-z0-9_.\-]{1,40}$/.test(mode)) {
        return { ok: false, status: 400, reason: 'bad-mode' };
    }
    return { ok: true, def, z, x, y, time, product, mode };
}

/* ── fetching + caching ───────────────────────────────────────────────────── */
function blankResponse(status, headers = {}) {
    return new Response(BLANK_PNG, {
        status: 200,
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=60',
            'X-Map3D-Tile': 'blank',
            ...headers
        }
    });
}

export async function handleTileRequest(request, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const cacheSeconds = options.cacheSeconds || 86400;
    const url = new URL(request.url);
    const check = validateTileRequest(url);
    if (!check.ok) {
        return new Response(JSON.stringify({ error: check.reason }), {
            status: check.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const { def, z, x, y, time, product, mode } = check;
    const built = buildUpstreamUrl(def, { z, x, y, time, product, mode });
    if (built.error) {
        return blankResponse(200, { 'X-Map3D-Upstream': 'unavailable', 'X-Map3D-Reason': built.error });
    }

    const cacheKey = `${def.id}|${z}|${x}|${y}|${time}|${product}|${mode}`;
    const hit = memoryTiles.get(cacheKey);
    if (hit && Date.now() - hit.at < MEMORY_TTL_MS) {
        memoryTiles.delete(cacheKey);
        memoryTiles.set(cacheKey, hit);      // LRU refresh
        return new Response(hit.body, {
            status: 200,
            headers: {
                'Content-Type': hit.type,
                'Cache-Control': `public, max-age=${cacheSeconds}`,
                'X-Map3D-Cache': 'memory'
            }
        });
    }

    let upstream;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        upstream = await fetch(built.url, {
            signal: controller.signal,
            headers: {
                /* Some government services (not the ones proxied today) prefer
                 * a browser-ish UA; harmless everywhere else. */
                'User-Agent': 'DetectLab-map3d-tile/1.0 (+https://detectlab.ro)',
                'Accept': 'image/png,image/jpeg,image/webp,image/*;q=0.8'
            }
        });
        clearTimeout(timer);
    } catch (err) {
        return blankResponse(200, {
            'X-Map3D-Upstream': 'error',
            'X-Map3D-Reason': String((err && err.message) || err).slice(0, 120)
        });
    }

    if (!upstream.ok) {
        return blankResponse(200, {
            'X-Map3D-Upstream': 'http-' + upstream.status,
            'X-Map3D-Layer': def.id
        });
    }

    const type = upstream.headers.get('content-type') || 'image/png';
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!/^image\//i.test(type) || body.length < 32) {
        /* A GeoServer that answers 200 with a Java stack trace is the classic
         * CENAGIS failure mode (CENAGIS_WMS_HEALTH.md): never hand that to the
         * renderer. */
        return blankResponse(200, {
            'X-Map3D-Upstream': 'not-an-image',
            'X-Map3D-Layer': def.id,
            'X-Map3D-Upstream-Type': type.slice(0, 60)
        });
    }

    memoryTiles.set(cacheKey, { at: Date.now(), body, type });
    while (memoryTiles.size > MEMORY_MAX_TILES) {
        memoryTiles.delete(memoryTiles.keys().next().value);
    }

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': type,
            'Cache-Control': `public, max-age=${cacheSeconds}, stale-while-revalidate=86400`,
            'Netlify-CDN-Cache-Control': `public, s-maxage=${Math.max(cacheSeconds, 604800)}, stale-while-revalidate=86400`,
            'X-Map3D-Cache': 'upstream',
            'X-Map3D-Layer': def.id,
            'X-Map3D-CRS': built.crs || ''
        }
    });
}

/** Human-readable proxy report (used by the 3D status panel and the tests). */
/* Mirrors the viewer's decision (see needsProxy() in js/layer-registry.js):
 *   'always' → always through this proxy;  'never' → never;  otherwise the
 *   layer goes through the proxy only when its host is a known CORS problem or
 *   has not proven CORS-safe yet. Every layer lands in exactly one bucket. */
export function proxyMode(def) {
    if (def.proxy === 'never') return 'direct';
    if (def.proxy === 'always' || def.reproject) return 'proxied';
    return def.cors === 'yes' ? 'direct' : 'auto';
}

export function proxyReport() {
    const layers = registry.list().map(def => ({
        id: def.id,
        title: def.title && (def.title.en || def.title.ro) || def.id,
        url: def.url,
        crs: def.crs || 'EPSG:3857',
        proxy: def.proxy || 'auto',
        cors: def.cors || 'unknown',
        reproject: !!def.reproject,
        mode: proxyMode(def),
        /* built per tile by the layer's own module (country LiDAR) */
        moduleBuilt: !!(def.kind === 'dynamic' && def.builder && def.builder.module)
    }));
    return {
        /* layers whose tile URLs come from their own country module */
        moduleBuilt: layers.filter(l => l.moduleBuilt).length,
        proxied: layers.filter(l => l.mode === 'proxied'),
        auto: layers.filter(l => l.mode === 'auto'),
        direct: layers.filter(l => l.mode === 'direct'),
        total: layers.length,
        layers
    };
}
