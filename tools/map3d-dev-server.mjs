#!/usr/bin/env node
/*
 * tools/map3d-dev-server.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Local development / preview server for the site WITH the 3D tile proxy.
 *
 * Why it is needed: the site is static, but the 3D view leans on two server
 * routes that only exist on Netlify — /api/map3d/tile (this repo, CORS +
 * reprojection) and the two pre-existing credential functions. This server
 * provides the same paths locally, backed by exactly the same shared code the
 * Netlify function uses (netlify/lib/map3d-tile.mjs), so what you see locally
 * is what production does.
 *
 * Usage:
 *     node tools/map3d-dev-server.mjs                 # http://localhost:4173
 *     node tools/map3d-dev-server.mjs --port 8080     # any port
 *     node tools/map3d-dev-server.mjs --host 0.0.0.0  # default: 0.0.0.0
 *
 * Then open http://localhost:4173/ and press the “3D” button on the map.
 *
 * Routes:
 *     /*                 → static files from the repository root
 *     /api/map3d/tile    → registry-backed tile proxy (see netlify/lib/map3d-tile.mjs)
 *     /api/map3d/status  → JSON diagnostics (registry + proxy report)
 *     /api/corona/rasters, /api/geo/*  → proxied to Netlify in dev, or answered
 *                          with a short explanation when no upstream is set
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTileRequest, proxyReport, registry } from '../netlify/lib/map3d-tile.mjs';
import { ROUTES as DANISH_ROUTES } from '../netlify/lib/danish-layers.mjs';
import { countryModuleScope } from '../netlify/lib/map3d-country-modules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
    const index = process.argv.indexOf('--' + name);
    return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 4173));
const HOST = arg('host', '0.0.0.0');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.wasm': 'application/wasm'
};

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        ...headers
    });
    if (body === null) res.end();
    else res.end(body);
}

function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            return send(res, 404, 'Not found: ' + rel, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        const ext = path.extname(filePath).toLowerCase();
        const headers = {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size
        };
        if (ext === '.js' || ext === '.mjs' || ext === '.css') {
            headers['Cache-Control'] = 'no-cache';
        }
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(filePath).pipe(res);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    /* ── the 3D tile proxy: identical code path to the Netlify function ── */
    if (url.pathname === '/api/map3d/tile') {
        try {
            const response = await handleTileRequest(new Request(url.toString(), { method: req.method }));
            const headers = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            headers['X-Map3D-Proxy'] = 'dev-server';
            const body = req.method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer());
            res.writeHead(response.status, headers);
            return res.end(body);
        } catch (err) {
            return send(res, 502, JSON.stringify({ error: String(err && err.message || err) }), {
                'Content-Type': 'application/json'
            });
        }
    }

    /* ── the Danish layers (js/danish-layers.config.js) ──
     * Exactly the code the Netlify functions run, so a local run shows what the
     * deployment does: /api/geo/dk-dtk25 adds DATAFORSYNINGEN_TOKEN, /api/geo/dk-orto
     * adds the Datafordeler service user, /api/geo/dk-heritage returns
     * Fund og Fortidsminder as EPSG:4326 GeoJSON. */
    if (DANISH_ROUTES[url.pathname]) {
        try {
            const response = await DANISH_ROUTES[url.pathname](new Request(url.toString(), { method: req.method }));
            const headers = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            headers['X-Danish-Proxy'] = 'dev-server';
            const body = req.method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer());
            res.writeHead(response.status, headers);
            return res.end(body);
        } catch (err) {
            return send(res, 502, JSON.stringify({ error: String(err && err.message || err) }), {
                'Content-Type': 'application/json'
            });
        }
    }

    /* ── diagnostics: what the 3D view will build, per layer ── */
    if (url.pathname === '/api/map3d/status') {
        const report = proxyReport();
        const body = JSON.stringify({
            registryVersion: registry.VERSION,
            terrain: registry.terrainSource(),
            /* The country LiDAR modules are evaluated in the same sandbox the
             * proxy uses, so the report is the browser's truth, not a guess. */
            layers: registry.diagnostics({ modules: countryModuleScope() }),
            proxy: report
        }, null, 2);
        return send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' });
    }

    /* ── routes that only exist on Netlify: say so instead of a bare 404 ── */
    if (url.pathname.startsWith('/api/')) {
        const upstream = process.env.MAP3D_DEV_UPSTREAM || arg('upstream', '');
        if (!upstream) {
            return send(res, 503, JSON.stringify({
                error: 'not-available-in-dev',
                path: url.pathname,
                hint: 'This endpoint is a Netlify function. Run `netlify dev` (which proxies the ' +
                      'functions in netlify/functions/) or pass --upstream https://detectlab.ro so the ' +
                      'dev server can forward /api/* there.'
            }), { 'Content-Type': 'application/json; charset=utf-8' });
        }
        try {
            const target = upstream.replace(/\/$/, '') + url.pathname + url.search;
            const upstreamResponse = await fetch(target);
            const headers = {};
            upstreamResponse.headers.forEach((value, key) => {
                if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) headers[key] = value;
            });
            const body = Buffer.from(await upstreamResponse.arrayBuffer());
            res.writeHead(upstreamResponse.status, headers);
            return res.end(body);
        } catch (err) {
            return send(res, 502, JSON.stringify({ error: String(err && err.message || err) }), {
                'Content-Type': 'application/json'
            });
        }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    /* A local-only convenience: when DATAFORSYNINGEN_TOKEN is exported for this
     * server, index.html is served with a one-line bootstrap that hands the
     * token to the page as window.DETECTLAB_DK_TOKEN. That is the documented
     * INSECURE local fallback (DENMARK_LIDAR_DATAFORSYNINGEN.md §5.3) — it lets
     * a workstation with no /api proxy see DTK25 from the source directly. The
     * token lives only in this process and in the HTML this dev server writes;
     * nothing is written to disk and no deployment ever serves it. */
    if ((url.pathname === '/' || url.pathname === '/index.html') && process.env.DATAFORSYNINGEN_TOKEN) {
        const file = path.join(ROOT, 'index.html');
        const html = fs.readFileSync(file, 'utf8').replace(
            '<head>',
            '<head>\n    <script>window.DETECTLAB_DK_TOKEN=' +
                JSON.stringify(process.env.DATAFORSYNINGEN_TOKEN) + ';' +
                'window.DETECTLAB_DK_LOCAL_PREVIEW=true;</script>'
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
    }

    serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
    const terrain = registry.terrainSource();
    console.log('[map3d-dev-server] DetectLab running on http://' + HOST + ':' + PORT + '/');
    console.log('[map3d-dev-server] registry ' + registry.VERSION + ' — ' + registry.list().length + ' layers');
    console.log('[map3d-dev-server] terrain: ' + terrain.label + ' · ' + terrain.encoding +
        ' · ' + terrain.tiles[0]);
    console.log('[map3d-dev-server] tile proxy: /api/map3d/tile (same code as the Netlify function)');
    console.log('[map3d-dev-server] diagnostics: /api/map3d/status');
    console.log('[map3d-dev-server] Danish layers: /api/geo/dk-dtk25 (token: ' +
        (process.env.DATAFORSYNINGEN_TOKEN ? 'set' : 'MISSING') + '), /api/geo/dk-orto (credentials: ' +
        (process.env.DATAFORDELER_USER && process.env.DATAFORDELER_PASSWORD ? 'set' : 'MISSING') +
        '), /api/geo/dk-heritage (public)');
});
