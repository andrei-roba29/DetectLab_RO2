/*!
 * DetectLab — Next-Gen APM · data providers (browser, main thread).
 *
 * Interfaces (swap any of them without touching the pipeline):
 *   DemProvider   { id, label, source, nominalResM, coversLonLat(lat,lon), fetchBlock(grid) → Float32Array(h·w) }
 *   WaterProvider { id, label, source, fetchWater(bbox, {simplifyDeg}) → { lines:[{cls,coords}], polygons:[{cls,rings}], meta } }
 *   SiteProvider  { id, label, source, getSites(centre, radiusKm) → Promise<Record[]> }   (record: see apm-sites.js)
 *   SoilProvider  (reserved)  — external soil raster; the built-in soil proxy is DEM-derived (apm-raster.js)
 *
 * Every endpoint below is an UNVERIFIED default unless the file says otherwise. Where a service
 * exposes its own catalogue (GetCapabilities, layer JSON) the code discovers names/ids at runtime
 * instead of hard-coding them. See NEXT_GEN_APM.md → "Verification status".
 */
(function (root, factory) {
    var deps = typeof module === 'object' && module.exports
        ? { core: require('./apm-core.js'), raster: require('./apm-raster.js'), sites: require('./apm-sites.js') }
        : { core: root.DetectLabApmCore, raster: root.DetectLabApmRaster, sites: root.DetectLabApmSites };
    var api = factory(deps.core, deps.raster, deps.sites, typeof fetch === 'function' ? fetch : null,
        typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmProviders = api;
})(typeof self !== 'undefined' ? self : this, function (core, raster, sites, fetchImpl, idb) {
    'use strict';

    /* ── Configuration (edit here; nothing else needs changing to swap a source) ─ */
    var APP_VERSION = 'apm-next settlement periods TRAIN (2026-10-30)';

    var CONFIG = {
        // DEM candidates in preference order. EU-DEM WCS is primary; Terrarium (last, in code) is the
        // only fallback. Each candidate's GetCapabilities is read at runtime (coverage id, formats, CRS,
        // advertised request limits). None of these endpoints is verified from the sandbox: check the
        // log in debug mode.
        euDem: {
            candidates: [
                {
                    id: 'eudem-v11', version: '1.1', tier: 'primary',
                    endpoint: 'https://image.discomap.eea.europa.eu/arcgis/services/Elevation/EUElev_DEM_V11/MapServer/WCSServer'
                },
                {
                    id: 'eudem-v10', version: '1.0', tier: 'secondary',
                    endpoint: 'https://image.discomap.eea.europa.eu/arcgis/services/GioLandPublic/DEM/MapServer/WCSServer'
                }
            ],
            coverageMatch: /dem/i,      // coverage id is discovered from GetCapabilities, not guessed
            nominalResM: 25,
            tilePx: 1000
        },
        euHydro: {
            base: 'https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer',
            maxRecordsPerQuery: 1000,           // service cap quoted in the brief; paging/quadtree handles overflow
            maxQuadDepth: 6
        },
        // Strahler order → size class. Defaults are UNTESTED ASSUMPTIONS (see NEXT_GEN_APM.md).
        water: {
            defaultStrahlerMap: { small: [1, 2], medium: [3, 4], large: [5, 6, 7, 8, 9] },
            drainageDefault: false              // EU-Hydro Drainage Network is off unless the user enables it
        },
        terrarium: {
            urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
            maxZoom: 15,
            nominalResM: 30                     // typical at mid-latitudes; reported per request
        },
        overpass: {
            url: 'https://overpass-api.de/api/interpreter',
            timeoutS: 60
        },
        // CORS proxy switch. DISABLED. Requests to these hosts go direct unless `enabled` is set.
        // The proxy itself is not built; see LIVE_TEST.md / NEXT_GEN_APM.md for the design.
        proxy: {
            enabled: false,
            prefix: '/.netlify/functions/apm-proxy?url=',
            hosts: ['image.discomap.eea.europa.eu', 'overpass-api.de', 's3.amazonaws.com']
        }
    };

    /* ── Europe (EEA39), coarse approximation — used only to choose the first DEM/hydro source ─ */
    function inEea39Approx(lat, lon) {
        if (lat < 34.5 || lat > 72.5 || lon < -26 || lon > 45) return false;
        if (lon < -10 && lat < 35) return false;         // Atlantic south-west
        if (lon > 12 && lat < 36) return false;          // Eastern Mediterranean / Levant
        return true;
    }

    /* ── Small infrastructure: rate limiting, IndexedDB cache ───────────────── */
    var queues = {};
    /** Per-host concurrency + minimum interval. Keeps bulk queries polite. */
    function schedule(host, fn, opts) {
        opts = opts || {};
        var q = queues[host] || (queues[host] = { active: 0, last: 0, waiting: [] });
        var maxC = opts.concurrency || 2, minGap = opts.minIntervalMs || 150;
        return new Promise(function (resolve, reject) {
            q.waiting.push({ fn: fn, resolve: resolve, reject: reject });
            pump();
        });
        function pump() {
            if (q.active >= maxC || !q.waiting.length) return;
            var job = q.waiting.shift();
            q.active++;
            var wait = Math.max(0, q.last + minGap - Date.now());
            setTimeout(function () {
                q.last = Date.now();
                Promise.resolve().then(job.fn).then(job.resolve, job.reject).then(function () {
                    q.active--; pump();
                });
            }, wait);
            pump();
        }
    }

    var memCache = new Map();
    var DB_NAME = 'detectlab-apm-next', STORE = 'kv';
    var dbPromise = null;
    function openDb() {
        if (!idb) return Promise.resolve(null);
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve) {
            try {
                var req = idb.open(DB_NAME, 1);
                req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { resolve(null); };
            } catch (e) { resolve(null); }
        });
        return dbPromise;
    }
    /** Returns cached value (or undefined). TTL in ms. */
    function cacheGet(key) {
        return openDb().then(function (db) {
            if (!db) return memCache.has(key) ? memCache.get(key) : undefined;
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE, 'readonly');
                var r = tx.objectStore(STORE).get(key);
                r.onsuccess = function () {
                    var rec = r.result;
                    if (!rec) return resolve(undefined);
                    if (rec.expires && rec.expires < Date.now()) return resolve(undefined);
                    resolve(rec.value);
                };
                r.onerror = function () { resolve(undefined); };
            });
        });
    }
    function cacheSet(key, value, ttlMs) {
        var rec = { value: value, expires: ttlMs ? Date.now() + ttlMs : 0 };
        memCache.set(key, value);
        return openDb().then(function (db) {
            if (!db) return;
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(rec, key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { resolve(); };
            });
        }).catch(function () {});
    }

    /* ── Diagnostics log: one record per request and one per source decision ─
     * Records are always kept (bounded). The console output and the visible panel depend on debug mode.
     * Debug is switched on with ?apmDebug=1 in the page URL or localStorage.apmDebug = '1'. */
    var debugOn = false, debugLog = [], debugListeners = [];
    var DEBUG_LOG_MAX = 500;
    function setDebug(on) { debugOn = !!on; return debugOn; }
    function isDebug() { return debugOn; }
    function onDebug(fn) { if (typeof fn === 'function') debugListeners.push(fn); }
    function getDebugLog() { return debugLog.slice(); }
    function clearDebugLog() { debugLog = []; }
    function logRecord(rec) {
        rec.time = rec.time || new Date().toISOString();
        debugLog.push(rec);
        if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
        if (debugOn && typeof console !== 'undefined' && console.debug) {
            console.debug('[APM] ' + JSON.stringify(rec));
        }
        debugListeners.forEach(function (fn) { try { fn(rec); } catch (e) { /* listener errors must not break fetches */ } });
    }
    /** Source decision for one step: outcome 'used' | 'failed' | 'skipped', with the reason. */
    function logStep(rec) { rec.kind = 'step'; logRecord(rec); }
    try {
        if (typeof location !== 'undefined' && /[?&]apmDebug=1\b/.test(location.search)) debugOn = true;
        if (typeof localStorage !== 'undefined' && localStorage.getItem('apmDebug') === '1') debugOn = true;
    } catch (e) { /* storage may be blocked */ }

    function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    function hostOf(url) { try { return new URL(url).host; } catch (e) { return 'local'; } }

    /** Error with a keyed reason (`e.reason` = { key, vars, text }) for the UI and the log. */
    function failure(key, vars, text) {
        var e = new Error(text);
        e.reason = core.msg(key, vars, text);
        return e;
    }
    /** Record the response body size on the request record of a fetched response. */
    function noteBytes(res, n) { if (res && res.__apmRec) res.__apmRec.bytes = n; }

    /** Cached, rate-limited GET/POST. Resolves the Response; rejects with a keyed `reason` on failure. */
    function httpFetch(url, init, opts) {
        opts = opts || {};
        var method = (init && init.method) || 'GET';
        var host = hostOf(url);
        var viaProxy = CONFIG.proxy.enabled && (opts.viaProxy || CONFIG.proxy.hosts.indexOf(host) >= 0);
        var target = viaProxy ? CONFIG.proxy.prefix + encodeURIComponent(url) : url;
        return schedule(host, function () {
            if (!fetchImpl) throw failure('reason.error', { msg: 'fetch unavailable' }, 'fetch is not available in this environment.');
            var t0 = nowMs();
            var rec = { kind: 'request', step: opts.step || null, method: method, url: target, endpoint: opts.endpoint || null,
                proxied: !!viaProxy, status: null, ok: null, ms: null, contentType: null, bytes: null };
            return fetchImpl(target, init).then(function (res) {
                rec.ms = Math.round(nowMs() - t0);
                rec.status = res.status;
                rec.ok = res.ok;
                rec.contentType = res.headers && res.headers.get ? res.headers.get('content-type') : null;
                logRecord(rec);
                if (!res.ok) {
                    var e = failure('reason.http', { status: res.status }, 'HTTP ' + res.status + ' from ' + host);
                    e.httpStatus = res.status;
                    throw e;
                }
                res.__apmRec = rec;
                return res;
            }, function (err) {
                // Browsers report CORS failures and network errors as a bare TypeError with no detail.
                rec.ms = Math.round(nowMs() - t0);
                rec.error = (err && err.name) + ': ' + (err && err.message);
                rec.reason = core.msg('reason.network', {}, 'no HTTP response (network failure or CORS block)');
                rec.hint = 'no HTTP response: network failure or CORS block (see the browser Network tab)';
                logRecord(rec);
                var e = failure('reason.network', {}, 'no HTTP response (network failure or CORS block)');
                e.cause = err;
                throw e;
            });
        }, opts.rate);
    }

    /* ── DEM: shared helpers ─────────────────────────────────────────────── */
    /** Sub-grid of `grid` starting at (i0,j0) with size cw×ch (may extend outside by negative offsets). */
    function subGrid(grid, i0, j0, cw, ch) {
        return {
            w: cw, h: ch,
            west: grid.west + i0 * grid.dLon,
            north: grid.north - j0 * grid.dLat,
            dLon: grid.dLon, dLat: grid.dLat
        };
    }

    /** Ground resolution (m) of a grid at its centre. */
    function gridResM(grid) {
        var sp = raster.gridSpacingM(grid);
        return Math.max(sp.dx, sp.dy);
    }

    /**
     * Visit a grid in core tiles of `tilePx` cells, each returned with a 1-cell halo for Horn.
     * cb(tile) where tile = { elev (Float32Array of tile grid incl. halo), grid (tile grid incl. halo),
     *                         core: {i0,j0,i1,j1} indices into the full grid }.
     * Optional filter(tile) → boolean skips tiles that are not needed.
     * Sequential by design: one tile in memory at a time.
     */
    function forEachDemTile(provider, grid, tilePx, cb, filter) {
        var tiles = [];
        for (var j0 = 0; j0 < grid.h; j0 += tilePx) {
            for (var i0 = 0; i0 < grid.w; i0 += tilePx) {
                var t = { i0: i0, j0: j0, i1: Math.min(grid.w, i0 + tilePx), j1: Math.min(grid.h, j0 + tilePx) };
                if (!filter || filter(t)) tiles.push(t);
            }
        }
        return tiles.reduce(function (p, t) {
            return p.then(function () {
                var hg = subGrid(grid, t.i0 - 1, t.j0 - 1, (t.i1 - t.i0) + 2, (t.j1 - t.j0) + 2);
                return provider.fetchBlock(hg).then(function (elev) {
                    return cb({ elev: elev, grid: hg, core: t });
                });
            });
        }, Promise.resolve());
    }

    /** Assemble a full grid from tiles (no halo) — used for the prediction window. */
    function loadDemGrid(provider, grid, tilePx) {
        var out = new Float32Array(grid.w * grid.h);
        return forEachDemTile(provider, grid, tilePx || 1000, function (t) {
            var hw = t.grid.w;
            for (var j = t.core.j0; j < t.core.j1; j++) {
                var srcRow = (j - t.core.j0 + 1) * hw + 1;
                for (var i = t.core.i0; i < t.core.i1; i++) {
                    out[j * grid.w + i] = t.elev[srcRow + (i - t.core.i0)];
                }
            }
        }).then(function () { return out; });
    }

    /* ── DEM: EU-DEM via WCS (one provider per candidate, capabilities read at runtime) ── */
    /** Parse a WCS GetCapabilities document. Pure. Regex-based so it runs in Node and in browsers. */
    function parseWcsCapabilities(xmlText) {
        var xml = String(xmlText || '');
        var caps = { coverageIds: [], formats: [], crs: [], maxRequestSize: null, exception: null };
        if (/<(?:\w+:)?ExceptionReport\b/.test(xml)) {
            var ex = /<(?:\w+:)?ExceptionText>([^<]*)</.exec(xml);
            caps.exception = ex ? ex[1].trim() : 'ExceptionReport';
        }
        caps.coverageIds = parseWcsCoverageIds(xml);
        function all(re) {
            var out = [], m;
            while ((m = re.exec(xml))) { var v = m[1].trim(); if (v && out.indexOf(v) < 0) out.push(v); }
            return out;
        }
        caps.formats = all(/<(?:\w+:)?formatSupported>([^<]+)</g);
        caps.crs = all(/<(?:\w+:)?(?:crsSupported|SupportedCRS)>([^<]+)</g);
        var mr = /<((?:\w+:)?[A-Za-z]*(?:MaxSize|MaxRequest|MaximumSize|MaxPixels|MaxRecords)[A-Za-z]*)>([^<]+)</i.exec(xml);
        if (mr) caps.maxRequestSize = { element: mr[1].replace(/^\w+:/, ''), value: mr[2].trim() };
        return caps;
    }

    /** Pixel cap from the advertised limit, when the element is clearly a pixel count. */
    function maxPixelsFrom(maxRequestSize) {
        if (!maxRequestSize || !/pixel/i.test(maxRequestSize.element)) return null;
        var n = parseInt(maxRequestSize.value, 10);
        return isFinite(n) && n > 0 ? n : null;
    }

    function parseWcsCoverageIds(xmlText) {
        var ids = [];
        var xml = String(xmlText || '');
        var re = /<(?:\w+:)?CoverageId>([^<]+)<\/(?:\w+:)?CoverageId>/g, m;
        while ((m = re.exec(xml))) ids.push(m[1].trim());
        if (!ids.length) {
            var re2 = /<(?:\w+:)?CoverageOfferingBrief[\s\S]*?<(?:\w+:)?name>([^<]+)<\/(?:\w+:)?name>/g;
            while ((m = re2.exec(xml))) ids.push(m[1].trim());
        }
        return ids;
    }

    /** Cached capabilities per endpoint (only successful reads are cached). */
    var demCaps = {};

    /** One EU-DEM WCS candidate. Discovers coverage/format/CRS/limits from GetCapabilities. */
    function createEuDemProvider(cand) {
        var p = {
            id: cand.id,
            version: cand.version,
            tier: cand.tier,
            label: 'EU-DEM v' + cand.version + ' (EEA, 25 m' + (cand.tier === 'secondary' ? ', older, lower quality' : '') + ')',
            source: 'Copernicus Land Monitoring Service / EEA — EU-DEM v' + cand.version,
            endpoint: cand.endpoint,
            nominalResM: CONFIG.euDem.nominalResM,
            coversLonLat: inEea39Approx,
            get tilePx() {
                var c = demCaps[cand.endpoint];
                var px = c ? maxPixelsFrom(c.maxRequestSize) : null;
                return px ? Math.max(64, Math.min(CONFIG.euDem.tilePx, Math.floor(Math.sqrt(px)))) : CONFIG.euDem.tilePx;
            },
            discover: function () {
                if (demCaps[cand.endpoint]) return Promise.resolve(demCaps[cand.endpoint]);
                var url = cand.endpoint + '?service=WCS&version=2.0.1&request=GetCapabilities';
                return httpFetch(url, {}, { rate: { concurrency: 1, minIntervalMs: 500 }, step: 'dem', endpoint: cand.endpoint })
                    .then(function (r) {
                        return r.text().then(function (text) {
                            noteBytes(r, text.length);
                            var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
                            if (!text.trim()) throw failure('reason.emptyBody', {}, 'empty response body');
                            if (!/xml/i.test(ct) && text.trim().charAt(0) !== '<') {
                                throw failure('reason.wrongFormat', { got: ct || 'unknown', expected: 'WCS XML' }, 'wrong format');
                            }
                            var caps = parseWcsCapabilities(text);
                            if (caps.exception) throw failure('reason.error', { msg: caps.exception }, 'server exception: ' + caps.exception);
                            var ids = caps.coverageIds.filter(function (id) { return CONFIG.euDem.coverageMatch.test(id); });
                            if (!ids.length) {
                                throw failure('reason.noCoverage', { found: caps.coverageIds.slice(0, 5).join(', ') || 'none' },
                                    'no EU-DEM coverage in GetCapabilities');
                            }
                            if (caps.formats.length && !caps.formats.some(function (f) { return /tiff/i.test(f); })) {
                                throw failure('reason.wrongFormat', { got: caps.formats.join(', '), expected: 'image/tiff' },
                                    'no GeoTIFF output format');
                            }
                            var found = {
                                id: ids[0], all: ids, endpoint: cand.endpoint, version: cand.version,
                                formats: caps.formats, crs: caps.crs, maxRequestSize: caps.maxRequestSize,
                                maxPx: maxPixelsFrom(caps.maxRequestSize)
                            };
                            demCaps[cand.endpoint] = found;
                            logRecord({ kind: 'caps', step: 'dem', endpoint: cand.endpoint, coverageId: found.id,
                                coverages: ids, formats: caps.formats, crs: caps.crs, maxRequestSize: caps.maxRequestSize });
                            return found;
                        });
                    });
            },
            fetchBlock: function (grid) {
                return p.discover().then(function (cov) {
                    var n = grid.north, s = grid.north - grid.h * grid.dLat;
                    var w = grid.west, e = grid.west + grid.w * grid.dLon;
                    var q = [
                        'service=WCS', 'version=2.0.1', 'request=GetCoverage',
                        'coverageId=' + encodeURIComponent(cov.id),
                        'format=' + encodeURIComponent('image/tiff'),
                        'subsettingCRS=' + encodeURIComponent('http://www.opengis.net/def/crs/EPSG/0/4326'),
                        'outputCRS=' + encodeURIComponent('http://www.opengis.net/def/crs/EPSG/0/4326'),
                        'subset=' + encodeURIComponent('Lat(' + s + ',' + n + ')'),
                        'subset=' + encodeURIComponent('Long(' + w + ',' + e + ')'),
                        'scalesize=' + encodeURIComponent('i(' + grid.w + '),j(' + grid.h + ')')
                    ];
                    return httpFetch(cov.endpoint + '?' + q.join('&'), {},
                        { rate: { concurrency: 2, minIntervalMs: 300 }, step: 'dem', endpoint: cov.endpoint })
                        .then(function (r) {
                            return r.arrayBuffer().then(function (buf) {
                                noteBytes(r, buf.byteLength);
                                var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
                                if (!buf.byteLength) throw failure('reason.emptyBody', {}, 'empty response body');
                                if (ct && !/tiff|octet-stream|image\//i.test(ct)) {
                                    throw failure('reason.wrongFormat', { got: ct, expected: 'image/tiff' }, 'wrong format');
                                }
                                return decodeGeoTiffFloat(buf).catch(function (err) {
                                    if (/geotiff\.js/.test(String(err && err.message))) throw err;
                                    throw failure('reason.wrongFormat', { got: 'undecodable body', expected: 'image/tiff' }, 'undecodable GeoTIFF');
                                });
                            });
                        });
                });
            }
        };
        return p;
    }

    /** Decode a single-band GeoTIFF into Float32Array (uses vendored geotiff.js global). */
    function decodeGeoTiffFloat(buf) {
        if (typeof GeoTIFF === 'undefined') return Promise.reject(new Error('geotiff.js is not loaded (setup problem).'));
        return GeoTIFF.fromArrayBuffer(buf).then(function (tiff) {
            return tiff.getImage().then(function (img) {
                return img.readRasters({ interleave: true }).then(function (rasters) {
                    var w = img.getWidth(), h = img.getHeight();
                    var out = new Float32Array(w * h);
                    var nodata = img.getGDALNoData ? img.getGDALNoData() : null;
                    for (var i = 0; i < w * h; i++) {
                        var v = rasters[i];
                        out[i] = (nodata != null && v === nodata) ? NaN : v;
                    }
                    return { data: out, width: w, height: h };
                });
            });
        }).then(function (r) { return r.data; });
    }

    /* ── DEM: Terrarium (global fallback, AWS open elevation tiles) ───────── */
    function lonLatToWorldPx(lat, lon, z) {
        var n = 256 * Math.pow(2, z);
        var x = (lon + 180) / 360 * n;
        var s = Math.sin(lat * Math.PI / 180);
        var y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
        return { x: x, y: y };
    }

    function terrariumZoomFor(lat, targetResM) {
        var mPerPxEq = 156543.03392 * Math.cos(lat * Math.PI / 180);
        var z = Math.round(Math.log2(mPerPxEq / targetResM));
        return Math.max(0, Math.min(CONFIG.terrarium.maxZoom, z));
    }

    /** Decode a Terrarium PNG blob to a Uint8ClampedArray RGBA (browser only). */
    function decodePng(blob) {
        if (typeof createImageBitmap !== 'function') return Promise.reject(new Error('createImageBitmap unavailable.'));
        return createImageBitmap(blob).then(function (bmp) {
            var canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height)
                : (function () { var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; return c; })();
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bmp, 0, 0);
            return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        });
    }

    function terrariumHeight(rgba, idx) {
        return rgba[idx] * 256 + rgba[idx + 1] + rgba[idx + 2] / 256 - 32768;
    }

    function createTerrariumProvider() {
        var tileCache = new Map();
        return {
            id: 'terrarium',
            tier: 'fallback',
            version: null,
            endpoint: CONFIG.terrarium.urlTemplate,
            label: 'Terrarium elevation tiles (global, mixed sources)',
            source: 'Mapzen / AWS Open Data elevation tiles (Terrarium); underlying SRTM, NED, ETOPO, etc.',
            nominalResM: CONFIG.terrarium.nominalResM,
            coversLonLat: function () { return true; },
            zoomFor: terrariumZoomFor,
            fetchBlock: function (grid) {
                var midLat = grid.north - grid.h / 2 * grid.dLat;
                var midLon = grid.west + grid.w / 2 * grid.dLon;
                var sp = raster.gridSpacingM(grid);
                var z = terrariumZoomFor(midLat, Math.max(sp.dx, sp.dy));
                var out = new Float32Array(grid.w * grid.h);
                var need = {};
                var cells = [];
                for (var j = 0; j < grid.h; j++) {
                    var lat = raster.cellLat(grid, j);
                    for (var i = 0; i < grid.w; i++) {
                        var p = lonLatToWorldPx(lat, raster.cellLon(grid, i), z);
                        var tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
                        var key = z + '/' + tx + '/' + ty;
                        need[key] = { z: z, x: tx, y: ty };
                        cells.push(j * grid.w + i, p.x - tx * 256, p.y - ty * 256, key);
                    }
                }
                var keys = Object.keys(need);
                var pix = new Map();
                return keys.reduce(function (pr, key) {
                    return pr.then(function () {
                        var t = need[key];
                        var url = CONFIG.terrarium.urlTemplate.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
                        if (tileCache.has(key)) { pix.set(key, tileCache.get(key)); return; }
                        return cacheGet('terrarium|' + key).then(function (cachedBuf) {
                            if (cachedBuf) return decodePng(new Blob([cachedBuf], { type: 'image/png' }));
                            return httpFetch(url, {}, { rate: { concurrency: 4, minIntervalMs: 20 }, step: 'dem', endpoint: 'terrarium' })
                                .then(function (r) { return r.arrayBuffer().then(function (ab) { return cacheSet('terrarium|' + key, ab).then(function () { return decodePng(new Blob([ab], { type: 'image/png' })); }); }); });
                        }).then(function (rgba) { tileCache.set(key, rgba); pix.set(key, rgba); });
                    });
                }, Promise.resolve()).then(function () {
                    for (var c = 0; c < cells.length; c += 4) {
                        var rgba = pix.get(cells[c + 3]);
                        var px = Math.min(255, Math.floor(cells[c + 1])), py = Math.min(255, Math.floor(cells[c + 2]));
                        out[cells[c]] = terrariumHeight(rgba, (py * 256 + px) * 4);
                    }
                    return out;
                });
            }
        };
    }

    /* ── Water: EU-Hydro (ArcGIS REST, /query with envelope + GeoJSON) ───── */
    /** Default Strahler → class mapping (copied, so callers cannot change the defaults). */
    function defaultStrahlerMap() {
        var d = CONFIG.water.defaultStrahlerMap;
        return { small: d.small.slice(), medium: d.medium.slice(), large: d.large.slice() };
    }

    /** Map a Strahler order to a size class with a configurable map. Unlisted orders → null (skipped). */
    function strahlerToClass(order, map) {
        if (order == null || !isFinite(order)) return null;
        var m = map || CONFIG.water.defaultStrahlerMap;
        var classes = ['small', 'medium', 'large'];
        for (var c = 0; c < classes.length; c++) {
            if ((m[classes[c]] || []).indexOf(Number(order)) >= 0) return classes[c];
        }
        return null;
    }

    /**
     * Resolve EU-Hydro leaf layers from the service JSON (names and ids are read, not guessed).
     * Returns [{ id, name, role, order, cls }]; role = 'lines' | 'polygon' | 'inland' | 'drainage'.
     * `cls` is the default-map class; fetchWater re-maps Strahler layers with the user's map.
     */
    function resolveEuHydroLayers(serviceJson) {
        var layers = ((serviceJson && serviceJson.layers) || []).slice().sort(function (a, b) { return a.id - b.id; });
        var out = [], seen = {};
        layers.forEach(function (l) {
            var name = String(l.name || '');
            var subs = l.subLayerIds || [];
            if (subs.length) return;                                    // group layer: its leaves are handled below
            // EU-Hydro publishes the same names at two scale ranges (e.g. "Strahler 6" as ids 10 and 15,
            // "InlandWater" as ids 2 and 3). Querying both would double-count, so keep the lowest id per name.
            var isDrain = /drain/i.test(name);
            var key = (isDrain ? 'drainage|' : 'main|') + name.toLowerCase();
            if (seen[key]) return;
            var order = (name.match(/strahler\D*(\d+)/i) || [])[1];
            if (order != null) {
                seen[key] = true;
                out.push({ id: l.id, name: name, order: Number(order), cls: strahlerToClass(Number(order)),
                    role: isDrain ? 'drainage' : 'lines' });
            } else if (isDrain) {
                // A drainage leaf without a Strahler order cannot be classed; it is logged and left out.
                seen[key] = true;
                out.push({ id: l.id, name: name, order: null, cls: null, role: 'drainage' });
            } else if (/^river_?net_?polygon$/i.test(name)) {
                seen[key] = true;
                out.push({ id: l.id, name: name, order: null, cls: 'large', role: 'polygon' });
            } else if (/^inlandwater$/i.test(name)) {
                seen[key] = true;
                out.push({ id: l.id, name: name, order: null, cls: 'large', role: 'inland' });
            }
            // Coastal_polygon (sea) and Transit_polygon (transitional waters) are not inland-water inputs.
        });
        return out;
    }

    /** Build the ArcGIS /query URL for an envelope (degrees). Pure. */
    function buildEsriQuery(base, layerId, bbox, opts) {
        opts = opts || {};
        var env = [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
        var p = {
            where: '1=1',
            geometry: env,
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: opts.outFields || '*',
            returnGeometry: 'true',
            outSR: '4326',
            f: 'geojson'
        };
        if (opts.maxAllowableOffsetDeg) p.maxAllowableOffset = String(opts.maxAllowableOffsetDeg);
        if (opts.resultOffset) p.resultOffset = String(opts.resultOffset);
        if (opts.resultRecordCount) p.resultRecordCount = String(opts.resultRecordCount);
        var qs = Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
        return base.replace(/\/$/, '') + '/' + layerId + '/query?' + qs;
    }

    /** Convert an ArcGIS GeoJSON response into { lines | rings } arrays. Pure. */
    function parseEsriGeoJson(json) {
        var feats = (json && json.features) || [];
        var lines = [], rings = [];
        feats.forEach(function (f) {
            var g = f.geometry;
            if (!g) return;
            if (g.type === 'LineString') lines.push(g.coordinates);
            else if (g.type === 'MultiLineString') g.coordinates.forEach(function (c) { lines.push(c); });
            else if (g.type === 'Polygon') g.coordinates.forEach(function (r) { rings.push(r); });
            else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (poly) { poly.forEach(function (r) { rings.push(r); }); });
        });
        var exceeded = !!(json && (json.exceededTransferLimit || (json.properties && json.properties.exceededTransferLimit)));
        return { lines: lines, rings: rings, exceeded: exceeded, count: feats.length };
    }

    function quadSplit(b) {
        var mx = (b.west + b.east) / 2, my = (b.south + b.north) / 2;
        return [
            { west: b.west, east: mx, south: my, north: b.north },
            { west: mx, east: b.east, south: my, north: b.north },
            { west: b.west, east: mx, south: b.south, north: my },
            { west: mx, east: b.east, south: b.south, north: my }
        ];
    }

    /** Query one layer over bbox. Pages with resultOffset when allowed, otherwise subdivides. */
    function queryLayerAll(base, layer, bbox, depth, acc, simplifyDeg) {
        var url = buildEsriQuery(base, layer.id, bbox, { maxAllowableOffsetDeg: simplifyDeg });
        return httpFetch(url, {}, { rate: { concurrency: 2, minIntervalMs: 250 }, step: 'water', endpoint: 'eu-hydro' })
            .then(function (r) { return r.json(); })
            .then(function (json) {
                if (json.error) throw new Error('EU-Hydro query error: ' + (json.error.message || json.error.code));
                var parsed = parseEsriGeoJson(json);
                if (parsed.exceeded && depth >= CONFIG.euHydro.maxQuadDepth) acc.incomplete = (acc.incomplete || 0) + 1;
                if (parsed.exceeded && depth < CONFIG.euHydro.maxQuadDepth) {
                    return Promise.all(quadSplit(bbox).map(function (sub) {
                        return queryLayerAll(base, layer, sub, depth + 1, acc, simplifyDeg);
                    }));
                }
                acc.lines.push.apply(acc.lines, parsed.lines.map(function (c) { return { cls: layer.cls, coords: c }; }));
                acc.rings.push.apply(acc.rings, parsed.rings.map(function (c) { return { cls: layer.cls, rings: [c] }; }));
                return null;
            });
    }

    function createEuHydroProvider() {
        var layersPromise = null;
        function layers() {
            if (!layersPromise) {
                layersPromise = httpFetch(CONFIG.euHydro.base + '?f=json', {}, { rate: { concurrency: 1, minIntervalMs: 500 }, step: 'water', endpoint: 'eu-hydro layers' })
                    .then(function (r) { return r.text(); })
                    .then(function (text) {
                        var j;
                        try { j = JSON.parse(text); } catch (e) { throw failure('reason.wrongFormat', { got: 'non-JSON', expected: 'ArcGIS JSON' }, 'wrong format'); }
                        var ls = resolveEuHydroLayers(j);
                        logRecord({ kind: 'caps', step: 'water', endpoint: CONFIG.euHydro.base,
                            layers: ls.map(function (l) { return l.name + '#' + l.id + ' (' + l.role + (l.cls ? ', ' + l.cls : '') + ')'; }) });
                        if (!ls.length) throw failure('reason.noCoverage', { found: 'no River_Net / InlandWater layers' }, 'no EU-Hydro river layers in service JSON');
                        return ls;
                    })
                    .catch(function (e) { layersPromise = null; throw e; });
            }
            return layersPromise;
        }
        return {
            id: 'eu-hydro',
            tier: 'primary',
            label: 'EU-Hydro (EEA)',
            source: 'EEA — EU-Hydro River Network Database (EEA39)',
            endpoint: CONFIG.euHydro.base,
            coversLonLat: inEea39Approx,
            layers: layers,
            fetchWater: function (bbox, opts) {
                opts = opts || {};
                var simplify = opts.simplifyDeg == null ? 0.0001 : opts.simplifyDeg;
                var map = opts.strahlerMap || CONFIG.water.defaultStrahlerMap;
                var includeDrainage = !!opts.includeDrainage;
                return layers().then(function (ls) {
                    var acc = { lines: [], rings: [] };
                    var skipped = [];
                    var use = [];
                    ls.forEach(function (l) {
                        if (l.role === 'drainage' && !includeDrainage) return;
                        var cls = l.order != null ? strahlerToClass(l.order, map) : l.cls;
                        if (!cls) { skipped.push(l.name + ' (no size class in the map)'); return; }
                        use.push({ id: l.id, name: l.name, role: l.role, cls: cls });
                    });
                    return use.reduce(function (p, layer) {
                        return p.then(function () { return queryLayerAll(CONFIG.euHydro.base, layer, bbox, 0, acc, simplify); });
                    }, Promise.resolve()).then(function () {
                        return {
                            lines: acc.lines, polygons: acc.rings,
                            meta: { provider: 'eu-hydro', layers: use.map(function (l) { return l.name; }),
                                drainage: includeDrainage, skippedLayers: skipped, incompleteTiles: acc.incomplete || 0 }
                        };
                    });
                });
            }
        };
    }

    /* ── Water: OpenStreetMap via Overpass (global fallback) ─────────────── */
    var OSM_CLASS = {
        river: 'medium', stream: 'small', brook: 'small', riverbank: 'large',
        canal: 'artificial', drain: 'artificial', ditch: 'artificial'
    };

    /** Overpass QL for waterways + water polygons inside bbox. Pure. */
    function buildOverpassQuery(bbox, timeoutS) {
        var b = [bbox.south, bbox.west, bbox.north, bbox.east].join(',');
        return '[out:json][timeout:' + (timeoutS || 60) + '];(' +
            'way["waterway"~"^(river|stream|brook|riverbank|canal|drain|ditch)$"](' + b + ');' +
            'way["natural"="water"](' + b + ');' +
            'relation["natural"="water"]["type"="multipolygon"](' + b + ');' +
            ');out geom;';
    }

    /** Parse Overpass JSON → { lines, polygons }. Pure. */
    function parseOverpass(json) {
        var lines = [], polygons = [];
        (json.elements || []).forEach(function (el) {
            if (el.type === 'way' && el.geometry) {
                var coords = el.geometry.map(function (p) { return [p.lon, p.lat]; });
                var tags = el.tags || {};
                var closed = coords.length > 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
                if (tags.natural === 'water' && closed) { polygons.push({ cls: 'large', rings: [coords] }); return; }
                var wt = tags.waterway;
                var cls = OSM_CLASS[wt];
                if (cls) lines.push({ cls: cls, coords: coords, name: tags.name || null });
            } else if (el.type === 'relation' && el.members) {
                var rings = [];
                el.members.forEach(function (m) {
                    if (m.type === 'way' && m.role === 'outer' && m.geometry) rings.push(m.geometry.map(function (p) { return [p.lon, p.lat]; }));
                });
                if (rings.length) polygons.push({ cls: 'large', rings: rings });
            }
        });
        return { lines: lines, polygons: polygons };
    }

    function createOverpassWaterProvider() {
        return {
            id: 'osm-overpass',
            tier: 'fallback',
            endpoint: CONFIG.overpass.url,
            label: 'OpenStreetMap waterways (Overpass)',
            source: '© OpenStreetMap contributors (ODbL)',
            coversLonLat: function () { return true; },
            fetchWater: function (bbox, opts) {
                var q = buildOverpassQuery(bbox, CONFIG.overpass.timeoutS);
                var body = 'data=' + encodeURIComponent(q);
                return cacheGet('overpass|' + q).then(function (cached) {
                    if (cached) return cached;
                    return httpFetch(CONFIG.overpass.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body
                    }, { rate: { concurrency: 1, minIntervalMs: 1500 }, step: 'water', endpoint: 'overpass' })
                        .then(function (r) { return r.json(); })
                        .then(function (json) {
                            var parsed = parseOverpass(json);
                            var res = { lines: parsed.lines, polygons: parsed.polygons, meta: { provider: 'osm-overpass' } };
                            return cacheSet('overpass|' + q, res, 7 * 24 * 3600 * 1000).then(function () { return res; });
                        });
                });
            }
        };
    }

    /* ── Site providers ──────────────────────────────────────────────────── */
    /** In-memory CSV provider — records come from an uploaded file (see apm-sites.js). */
    function createCsvSiteProvider(records, label) {
        return {
            id: 'csv',
            label: label || 'Uploaded CSV',
            source: 'User-supplied CSV (licence and provenance are the uploader’s responsibility)',
            getSites: function (centre, radiusKm) {
                var r = radiusKm * 1000;
                return Promise.resolve(records.filter(function (s) {
                    return core.haversineM(centre.lat, centre.lon, s.lat, s.lon) <= r;
                }));
            }
        };
    }

    /** Uses the Browse / Where bbox contract, but pages only subject-filtered settlement hits.
     * Parent inhabited-place and small-community settlement queries are unioned, never broadened to all sites.
     * `mapq` is intentionally absent: that mode returns heatmap aggregations above 500 hits.
     * Contract: github.com/ARIADNE-Infrastructure/portal server/classes/Elastic/{Query,QuerySettings}.php
     */
    function createAriadneSiteProvider() {
        return {
            id: 'ariadne', label: 'ARIADNE Portal — settlements',
            source: 'https://ariadne-portal.d4science.org/browse/where', available: true,
            getSites: function (centre, radiusKm, options) {
                options = options || {};
                var bbox = core.circleBBox(centre.lat, centre.lon, radiusKm * 1000);
                var records = [], seen = Object.create(null), emitted = Object.create(null), page = 1, count = 0, queryIndex = 0;
                function check() {
                    if (options.token && options.token.cancelled) throw new Error('cancelled');
                }
                function next() {
                    check();
                    var url = new URL('https://ariadne-portal.d4science.org/api/search');
                    // Portal order: top-left latitude, longitude, bottom-right latitude, longitude.
                    url.search = new URLSearchParams({ q: '', bbox: [bbox.north, bbox.west, bbox.south, bbox.east].join(','),
                        resourceType: 'Site/monument', derivedSubject: sites.ARIADNE_SETTLEMENT_FILTERS[queryIndex], size: '50', page: String(page), sort: 'issued', order: 'asc' }).toString();
                    var controller = new AbortController();
                    var timer = setTimeout(function () { controller.abort(); }, 20000);
                    return fetchImpl(url.href, { signal: controller.signal }).then(function (r) {
                        if (!r.ok) throw new Error('ARIADNE HTTP ' + r.status);
                        return r.json();
                    }).finally(function () { clearTimeout(timer); }).then(function (data) {
                        check();
                        if (!data || data.error || !Array.isArray(data.hits)) throw new Error('ARIADNE: invalid search response');
                        var total = typeof data.total === 'object' && data.total ? data.total.value : data.total;
                        if (!Number.isFinite(total) || total < 0) throw new Error('ARIADNE: missing result count');
                        // Never silently train on the first page or a truncated result window.
                        if (total > 10000 || (data.total && data.total.relation === 'gte')) throw new Error('ARIADNE: too many sites in this area (maximum 10,000).');
                        var fresh = data.hits.filter(function (hit) {
                            if (!hit || !hit.id || seen[hit.id]) return false;
                            seen[hit.id] = true; return true;
                        });
                        if (!fresh.length && count < total) throw new Error('ARIADNE: incomplete search results');
                        count += fresh.length;
                        records = records.concat(sites.parseAriadneHits(fresh.filter(function (hit) {
                            if (emitted[hit.id]) return false;
                            emitted[hit.id] = true; return true;
                        })));
                        if (options.onProgress) options.onProgress(count, total);
                        if (count < total) {
                            if (page >= 200) throw new Error('ARIADNE: incomplete search results');
                            page++; return next();
                        }
                        if (++queryIndex < sites.ARIADNE_SETTLEMENT_FILTERS.length) {
                            page = 1; count = 0; seen = Object.create(null); return next();
                        }
                        return records.filter(function (r) { return core.haversineM(centre.lat, centre.lon, r.lat, r.lon) <= radiusKm * 1000; });
                    });
                }
                return Promise.resolve().then(next);
            }
        };
    }

    /* ── Provider chooser ────────────────────────────────────────────────── */
    /**
     * DEM plan for a centre: every candidate in order, with `use` and the reason it is skipped.
     * Terrarium is always last and is the only fallback after the EU-DEM candidates.
     */
    function demPlan(lat, lon) {
        var plan = CONFIG.euDem.candidates.map(function (c) {
            var p = createEuDemProvider(c);
            var ok = p.coversLonLat(lat, lon);
            return { provider: p, use: ok, skipReason: ok ? null : core.msg('skip.outsideEea', {}, 'outside EEA-39 coverage (approximate test)') };
        });
        plan.push({ provider: createTerrariumProvider(), use: true, skipReason: null });
        return plan;
    }

    /** Water plan: EU-Hydro (EEA-39 only) then Overpass. */
    function waterPlan(lat, lon) {
        var eh = createEuHydroProvider();
        var ok = inEea39Approx(lat, lon);
        return [
            { provider: eh, use: ok, skipReason: ok ? null : core.msg('skip.outsideEea', {}, 'outside EEA-39 coverage (approximate test)') },
            { provider: createOverpassWaterProvider(), use: true, skipReason: null }
        ];
    }

    /** DEM providers in preference order for a centre (skipped candidates omitted). */
    function demChain(lat, lon) {
        return demPlan(lat, lon).filter(function (x) { return x.use; }).map(function (x) { return x.provider; });
    }

    function waterChain(lat, lon) {
        return waterPlan(lat, lon).filter(function (x) { return x.use; }).map(function (x) { return x.provider; });
    }

    return {
        CONFIG: CONFIG,
        setFetch: function (fn) { fetchImpl = fn; },
        APP_VERSION: APP_VERSION,
        setDebug: setDebug,
        logStep: logStep,
        defaultStrahlerMap: defaultStrahlerMap,
        maxPixelsFrom: maxPixelsFrom,
        demPlan: demPlan,
        waterPlan: waterPlan,
        isDebug: isDebug,
        onDebug: onDebug,
        getDebugLog: getDebugLog,
        clearDebugLog: clearDebugLog,
        getDemCapabilities: function () { return Object.keys(demCaps).map(function (k) { return demCaps[k]; }); },
        inEea39Approx: inEea39Approx,
        cacheGet: cacheGet,
        cacheSet: cacheSet,
        schedule: schedule,
        subGrid: subGrid,
        gridResM: gridResM,
        forEachDemTile: forEachDemTile,
        loadDemGrid: loadDemGrid,
        parseWcsCoverageIds: parseWcsCoverageIds,
        lonLatToWorldPx: lonLatToWorldPx,
        terrariumZoomFor: terrariumZoomFor,
        terrariumHeight: terrariumHeight,
        strahlerToClass: strahlerToClass,
        failure: failure,
        resolveEuHydroLayers: resolveEuHydroLayers,
        buildEsriQuery: buildEsriQuery,
        parseEsriGeoJson: parseEsriGeoJson,
        buildOverpassQuery: buildOverpassQuery,
        parseOverpass: parseOverpass,
        createEuDemProvider: createEuDemProvider,
        parseWcsCapabilities: parseWcsCapabilities,
        createTerrariumProvider: createTerrariumProvider,
        createEuHydroProvider: createEuHydroProvider,
        createOverpassWaterProvider: createOverpassWaterProvider,
        createCsvSiteProvider: createCsvSiteProvider,
        createAriadneSiteProvider: createAriadneSiteProvider,
        demChain: demChain,
        waterChain: waterChain
    };
});
