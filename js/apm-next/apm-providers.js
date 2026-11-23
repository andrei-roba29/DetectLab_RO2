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
    var APP_VERSION = 'apm-next settlement periods TRAIN (2026-11-23)';

    var CONFIG = {
        // A stalled endpoint must never park the whole run on "Choosing elevation source…". Every
        // request has a deadline; a timed-out source is recorded as failed and the chain moves on.
        requestTimeoutMs: 30000,          // default for capabilities / water / metadata requests
        demProbeTimeoutMs: 12000,         // 300 m DEM probe: GetCapabilities + one small GetCoverage
        demBlockTimeoutMs: 45000,         // one DEM block (up to 1000×1000 cells)
        demProbeMaxBytes: 4 * 1024 * 1024,
        demMaxBlockBytes: 32 * 1024 * 1024,
        cacheTimeoutMs: 1500,             // a blocked IndexedDB must not block the fallback either
        // DEM candidates in preference order. EU-DEM WCS is primary; Terrarium (last, in code) is the
        // only fallback. Each candidate's GetCapabilities is read at runtime (coverage id, formats, CRS,
        // advertised request limits). None of these endpoints is verified from the sandbox: check the
        // log in debug mode.
        euDem: {
            candidates: [
                {
                    id: 'eudem-v11', version: '1.1', tier: 'primary',
                    // The EEA retired EU-DEM from the CLMS download site in 2024. The ArcGIS
                    // service is published on both discomap hosts; the Copernicus host is the
                    // one the EEA infrastructure overview lists for Copernicus services, so it
                    // is tried first. Both are reached through the same deadline logic.
                    endpoint: 'https://copernicus.discomap.eea.europa.eu/arcgis/services/Elevation/EUElev_DEM_V11/MapServer/WCSServer'
                },
                {
                    id: 'eudem-v10', version: '1.0', tier: 'secondary',
                    endpoint: 'https://image.discomap.eea.europa.eu/arcgis/services/GioLandPublic/DEM/MapServer/WCSServer'
                }
            ],
            // ArcGIS publishes the coverage id as a bare layer number ("1"), not "DEM…", so the
            // match looks at the whole CoverageSummary (id + title + abstract) as well.
            coverageMatch: /dem|elev|dtm|dsm|height/i,
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
            nominalResM: 30,                    // typical at mid-latitudes; reported per request
            timeoutMs: 20000
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
            hosts: ['image.discomap.eea.europa.eu', 'copernicus.discomap.eea.europa.eu', 'overpass-api.de', 's3.amazonaws.com']
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
                // Another tab can hold the only connection while a version change is pending;
                // without onblocked the open would wait forever and so would the DEM fallback.
                req.onblocked = function () { resolve(null); };
            } catch (e) { resolve(null); }
        });
        return dbPromise;
    }
    /** Race a promise against a deadline; resolves `fallback` instead of rejecting when it expires. */
    function withTimeout(promise, ms, fallback) {
        if (!ms || ms <= 0) return promise;
        return new Promise(function (resolve, reject) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                resolve(fallback);
            }, ms);
            Promise.resolve(promise).then(function (v) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(v);
            }, function (e) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(e);
            });
        });
    }
    /** Race a promise against a deadline; rejects with `reason.timeout` when it expires. */
    var TIMED_OUT = {};
    function withDeadline(promise, ms) {
        if (!ms || ms <= 0) return Promise.resolve(promise);
        return withTimeout(promise, ms, TIMED_OUT).then(function (v) {
            if (v === TIMED_OUT) throw timeoutFailure(ms);
            return v;
        });
    }
    /** Returns cached value (or undefined). TTL in ms. Never blocks longer than cacheTimeoutMs. */
    function cacheGet(key) {
        return withTimeout(openDb().then(function (db) {
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
        }), CONFIG.cacheTimeoutMs, undefined);
    }
    function cacheSet(key, value, ttlMs) {
        var rec = { value: value, expires: ttlMs ? Date.now() + ttlMs : 0 };
        memCache.set(key, value);
        return withTimeout(openDb().then(function (db) {
            if (!db) return;
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(rec, key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { resolve(); };
            });
        }), CONFIG.cacheTimeoutMs, undefined).catch(function () {});
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

    /** Keyed error for a request that did not answer within its deadline. */
    function timeoutFailure(ms) {
        var s = Math.max(1, Math.round(ms / 1000));
        return failure('reason.timeout', { s: s }, 'no response within ' + s + ' s');
    }

    /** Keyed error for a response body that is far larger than the requested raster. */
    function tooLargeFailure(maxBytes) {
        var mb = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
        return failure('reason.tooLarge', { mb: mb }, 'response larger than ' + mb + ' MB');
    }

    /**
     * fetch() with a hard deadline. The deadline starts when the request actually leaves the
     * per-host queue, not when it is enqueued. A server that accepts the TCP connection and then
     * stalls is exactly the failure that used to leave APM stuck on "Choosing elevation source…".
     */
    function fetchWithTimeout(url, init, timeoutMs, outerSignal) {
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var requestInit = {};
        if (init) Object.keys(init).forEach(function (k) { requestInit[k] = init[k]; });
        if (ctrl) requestInit.signal = ctrl.signal;
        if (ctrl && outerSignal) {
            if (outerSignal.aborted) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
            else if (typeof outerSignal.addEventListener === 'function') {
                outerSignal.addEventListener('abort', function () {
                    try { ctrl.abort(); } catch (e) { /* ignore */ }
                }, { once: true });
            }
        }
        var request = Promise.resolve().then(function () { return fetchImpl(url, requestInit); });
        if (!timeoutMs || timeoutMs <= 0) return request;
        var timer = null;
        var deadline = new Promise(function (resolve, reject) {
            timer = setTimeout(function () {
                if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
                reject(timeoutFailure(timeoutMs));
            }, timeoutMs);
        });
        return Promise.race([
            request.then(function (res) { if (timer) clearTimeout(timer); return res; },
                function (err) { if (timer) clearTimeout(timer); throw err; }),
            deadline
        ]);
    }

    /** Read a response body as an ArrayBuffer, refusing a body over `maxBytes`. */
    function readBodyBuffer(res, maxBytes, timeoutMs) {
        var lenHeader = res.headers && res.headers.get ? parseInt(res.headers.get('content-length'), 10) : NaN;
        if (maxBytes && isFinite(lenHeader) && lenHeader > maxBytes) {
            return Promise.reject(tooLargeFailure(maxBytes));
        }
        var body = res.body;
        if (!body || typeof body.getReader !== 'function') {
            if (typeof res.arrayBuffer !== 'function') return Promise.reject(new Error('response has no body'));
            return withDeadline(res.arrayBuffer(), timeoutMs || CONFIG.requestTimeoutMs).then(function (buf) {
                if (maxBytes && buf.byteLength > maxBytes) throw tooLargeFailure(maxBytes);
                return buf;
            });
        }
        var reader = body.getReader();
        var chunks = [], total = 0;
        function pump() {
            return reader.read().then(function (part) {
                if (part.done) {
                    var out = new Uint8Array(total), off = 0;
                    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
                    return out.buffer;
                }
                total += part.value.length;
                if (maxBytes && total > maxBytes) {
                    try { reader.cancel(); } catch (e) { /* ignore */ }
                    throw tooLargeFailure(maxBytes);
                }
                chunks.push(part.value);
                return pump();
            });
        }
        return withDeadline(pump(), timeoutMs || CONFIG.requestTimeoutMs);
    }

    /** Read a response body as text, refusing an oversized capabilities document. */
    function readBodyText(res, maxBytes, timeoutMs) {
        return withDeadline(Promise.resolve().then(function () { return res.text(); }),
            timeoutMs || CONFIG.requestTimeoutMs).then(function (text) {
            if (maxBytes && text.length > maxBytes) throw tooLargeFailure(maxBytes);
            return text;
        });
    }

    /** Read a response body as JSON, with the same deadline as the request itself. */
    function readBodyJson(res, timeoutMs) {
        return withDeadline(Promise.resolve().then(function () { return res.json(); }),
            timeoutMs || CONFIG.requestTimeoutMs);
    }

    /** Cached, rate-limited GET/POST. Resolves the Response; rejects with a keyed `reason` on failure. */
    function httpFetch(url, init, opts) {
        opts = opts || {};
        var method = (init && init.method) || 'GET';
        var host = hostOf(url);
        var viaProxy = CONFIG.proxy.enabled && (opts.viaProxy || CONFIG.proxy.hosts.indexOf(host) >= 0);
        var target = viaProxy ? CONFIG.proxy.prefix + encodeURIComponent(url) : url;
        var timeoutMs = opts.timeoutMs == null ? CONFIG.requestTimeoutMs : opts.timeoutMs;
        return schedule(host, function () {
            if (!fetchImpl) throw failure('reason.error', { msg: 'fetch unavailable' }, 'fetch is not available in this environment.');
            var t0 = nowMs();
            var rec = { kind: 'request', step: opts.step || null, method: method, url: target, endpoint: opts.endpoint || null,
                proxied: !!viaProxy, status: null, ok: null, ms: null, contentType: null, bytes: null, timeoutMs: timeoutMs || null };
            return fetchWithTimeout(target, init, timeoutMs, opts.signal).then(function (res) {
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
                if (err && err.reason && err.reason.key === 'reason.timeout') {
                    rec.reason = err.reason;
                    rec.hint = 'no response within the request deadline';
                } else {
                    rec.reason = (err && err.reason) || core.msg('reason.network', {}, 'no HTTP response (network failure or CORS block)');
                    rec.hint = 'no HTTP response: network failure or CORS block (see the browser Network tab)';
                }
                logRecord(rec);
                throw err && err.reason ? err : failure('reason.network', {}, 'no HTTP response (network failure or CORS block)');
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

    /**
     * Coverage summaries from a WCS 2.0.1 GetCapabilities document.
     * Returns [{ id, text }] where `text` is the flattened CoverageSummary (title, abstract,
     * keywords). ArcGIS publishes the coverage id as a bare layer number, so callers that
     * need to recognise "a DEM" must look at the whole block, not only at the id.
     */
    function parseWcsCoverageSummaries(xmlText) {
        var xml = String(xmlText || '');
        var out = [], m;
        var re = /<(?:\w+:)?CoverageSummary\b[^>]*>([\s\S]*?)<\/(?:\w+:)?CoverageSummary>/g;
        while ((m = re.exec(xml))) {
            var block = m[1];
            var idm = /<(?:\w+:)?CoverageId>([^<]+)<\//.exec(block);
            if (!idm) {
                var nm = /<(?:\w+:)?(?:name|Title|label)>([^<]+)<\//i.exec(block);
                if (nm) idm = nm;
            }
            if (idm) {
                out.push({ id: idm[1].trim(), text: block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
            }
        }
        if (!out.length) {
            // WCS 1.0 CoverageOfferingBrief documents.
            var re2 = /<(?:\w+:)?CoverageOfferingBrief\b[^>]*>([\s\S]*?)<\/(?:\w+:)?CoverageOfferingBrief>/g;
            while ((m = re2.exec(xml))) {
                var nm2 = /<(?:\w+:)?name>([^<]+)<\//.exec(m[1]);
                if (nm2) out.push({ id: nm2[1].trim(), text: m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
            }
        }
        return out;
    }

    function parseWcsCoverageIds(xmlText) {
        return parseWcsCoverageSummaries(xmlText).map(function (s) { return s.id; });
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
            discover: function (timeoutMs) {
                if (demCaps[cand.endpoint]) return Promise.resolve(demCaps[cand.endpoint]);
                var deadline = timeoutMs || CONFIG.demProbeTimeoutMs;
                var url = cand.endpoint + '?service=WCS&version=2.0.1&request=GetCapabilities';
                return httpFetch(url, {}, { rate: { concurrency: 1, minIntervalMs: 500 }, step: 'dem', endpoint: cand.endpoint,
                    timeoutMs: deadline, maxBytes: 8 * 1024 * 1024 })
                    .then(function (r) {
                        return readBodyText(r, 8 * 1024 * 1024, deadline).then(function (text) {
                            noteBytes(r, text.length);
                            var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
                            if (!text.trim()) throw failure('reason.emptyBody', {}, 'empty response body');
                            if (!/xml/i.test(ct) && text.trim().charAt(0) !== '<') {
                                throw failure('reason.wrongFormat', { got: ct || 'unknown', expected: 'WCS XML' }, 'wrong format');
                            }
                            var caps = parseWcsCapabilities(text);
                            if (caps.exception) throw failure('reason.error', { msg: caps.exception }, 'server exception: ' + caps.exception);
                            var summaries = parseWcsCoverageSummaries(text);
                            var ids = summaries.map(function (s) { return s.id; });
                            var matchRe = CONFIG.euDem.coverageMatch;
                            var matched = summaries.filter(function (s) { return matchRe.test(s.id) || matchRe.test(s.text); });
                            // A service with a single coverage is unambiguous even when ArcGIS
                            // publishes its id as a bare layer number — but never accept a
                            // coverage that names an obviously different product.
                            var notDem = /land\s*cover|corine|water|hydro|road|built|forest|impervious|soil|geology|hillshade/i;
                            if (!matched.length && summaries.length === 1 &&
                                !notDem.test(summaries[0].id + ' ' + summaries[0].text)) matched = summaries;
                            if (!matched.length) {
                                throw failure('reason.noCoverage', { found: ids.slice(0, 5).join(', ') || 'none' },
                                    'no EU-DEM coverage in GetCapabilities');
                            }
                            if (caps.formats.length && !caps.formats.some(function (f) { return /tiff/i.test(f); })) {
                                throw failure('reason.wrongFormat', { got: caps.formats.join(', '), expected: 'image/tiff' },
                                    'no GeoTIFF output format');
                            }
                            var found = {
                                id: matched[0].id, all: ids, endpoint: cand.endpoint, version: cand.version,
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
            fetchBlock: function (grid, opts) {
                opts = opts || {};
                var probe = !!opts.probe;
                var timeoutMs = opts.timeoutMs || (probe ? CONFIG.demProbeTimeoutMs : CONFIG.demBlockTimeoutMs);
                var maxBytes = opts.maxBytes || (probe ? CONFIG.demProbeMaxBytes : CONFIG.demMaxBlockBytes);
                return p.discover(timeoutMs).then(function (cov) {
                    var urls = wcsCoverageUrls(cov, grid);
                    var attempt = 0;
                    function tryNext() {
                        var url = urls[attempt++];
                        return httpFetch(url, {}, {
                            rate: { concurrency: 2, minIntervalMs: 300 }, step: 'dem', endpoint: cov.endpoint,
                            timeoutMs: timeoutMs, maxBytes: maxBytes
                        }).then(function (r) {
                            var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
                            if (ct && !/tiff|octet-stream|image\//i.test(ct)) {
                                throw failure('reason.wrongFormat', { got: ct, expected: 'image/tiff' }, 'wrong format');
                            }
                            return readBodyBuffer(r, maxBytes, timeoutMs).then(function (buf) {
                                noteBytes(r, buf.byteLength);
                                if (!buf.byteLength) throw failure('reason.emptyBody', {}, 'empty response body');
                                return decodeGeoTiffRaster(buf).then(function (raster) {
                                    return resampleRaster(raster, grid);
                                });
                            });
                        }).catch(function (err) {
                            // A server that rejects one KVP dialect (ArcGIS axis labels vs the
                            // WCS-core form) gets the other. Network, HTTP and timeout failures
                            // are final: retrying the same host would only waste the deadline.
                            if (attempt < urls.length && err && err.reason &&
                                (err.reason.key === 'reason.wrongFormat' || err.reason.key === 'reason.error')) {
                                return tryNext();
                            }
                            if (err && /geotiff\.js/.test(String(err.message))) throw err;
                            if (err && err.reason) throw err;
                            throw failure('reason.wrongFormat', { got: 'undecodable body', expected: 'image/tiff' }, 'undecodable GeoTIFF');
                        });
                    }
                    return tryNext();
                });
            }
        };
        return p;
    }

    /**
     * GetCoverage URL variants for one grid. ArcGIS Server documents the axis label and the
     * CRS inside the subset value (`subset=x,http://…/4326(west,east)`); WCS-core servers use
     * `subsettingCRS` plus `Long(...)`/`Lat(...)` and a scaling extension. Both are tried.
     */
    function wcsCoverageUrls(cov, grid) {
        var n = grid.north, s = grid.north - grid.h * grid.dLat;
        var w = grid.west, e = grid.west + grid.w * grid.dLon;
        var crs = 'http://www.opengis.net/def/crs/EPSG/0/4326';
        var common = [
            'service=WCS', 'version=2.0.1', 'request=GetCoverage',
            'coverageId=' + encodeURIComponent(cov.id),
            'format=' + encodeURIComponent('image/tiff')
        ];
        var arcgis = common.concat([
            'subset=' + encodeURIComponent('x,' + crs + '(' + w + ',' + e + ')'),
            'subset=' + encodeURIComponent('y,' + crs + '(' + s + ',' + n + ')')
        ]);
        var standard = common.concat([
            'subsettingCRS=' + encodeURIComponent(crs),
            'outputCRS=' + encodeURIComponent(crs),
            'subset=' + encodeURIComponent('Long(' + w + ',' + e + ')'),
            'subset=' + encodeURIComponent('Lat(' + s + ',' + n + ')'),
            'scalesize=' + encodeURIComponent('x(' + grid.w + '),y(' + grid.h + ')')
        ]);
        return [cov.endpoint + '?' + arcgis.join('&'), cov.endpoint + '?' + standard.join('&')];
    }

    /** Decode a single-band GeoTIFF into { data, width, height } (uses vendored geotiff.js). */
    function decodeGeoTiffRaster(buf) {
        if (typeof GeoTIFF === 'undefined') return Promise.reject(new Error('geotiff.js is not loaded (setup problem).'));
        return GeoTIFF.fromArrayBuffer(buf).then(function (tiff) {
            return tiff.getImage().then(function (img) {
                return img.readRasters({ samples: [1], interleave: true }).then(function (rasters) {
                    var w = img.getWidth(), h = img.getHeight();
                    var data = rasters;
                    // Some decoders return an array of bands even with `samples`; take band 1.
                    if (typeof data === 'object' && !ArrayBuffer.isView(data) && data.length) data = data[0];
                    if (!data || data.length < w * h) throw new Error('geotiff.js returned fewer samples than pixels');
                    var out = new Float32Array(w * h);
                    var nodata = img.getGDALNoData ? img.getGDALNoData() : null;
                    for (var i = 0; i < w * h; i++) {
                        var v = data[i];
                        out[i] = (nodata != null && v === nodata) ? NaN : v;
                    }
                    return { data: out, width: w, height: h };
                });
            });
        });
    }

    /** Nearest-neighbour resample of a decoded raster onto the requested grid (row 0 = north). */
    function resampleRaster(raster, grid) {
        var w = grid.w, h = grid.h;
        if (raster.width === w && raster.height === h) return raster.data;
        var out = new Float32Array(w * h);
        var sx = raster.width / w, sy = raster.height / h;
        for (var j = 0; j < h; j++) {
            var sy0 = Math.min(raster.height - 1, Math.max(0, Math.floor((j + 0.5) * sy - 0.5)));
            for (var i = 0; i < w; i++) {
                var sx0 = Math.min(raster.width - 1, Math.max(0, Math.floor((i + 0.5) * sx - 0.5)));
                out[j * w + i] = raster.data[sy0 * raster.width + sx0];
            }
        }
        return out;
    }

    /** Backwards-compatible helper: decode and flatten to the grid's cell order. */
    function decodeGeoTiffFloat(buf, grid) {
        return decodeGeoTiffRaster(buf).then(function (raster) {
            return grid ? resampleRaster(raster, grid) : raster.data;
        });
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
            fetchBlock: function (grid, opts) {
                opts = opts || {};
                var timeoutMs = opts.timeoutMs || CONFIG.terrarium.timeoutMs;
                var maxBytes = opts.maxBytes || 4 * 1024 * 1024;
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
                            return httpFetch(url, {}, { rate: { concurrency: 4, minIntervalMs: 20 }, step: 'dem', endpoint: 'terrarium',
                                timeoutMs: timeoutMs, maxBytes: maxBytes })
                                .then(function (r) {
                                    return readBodyBuffer(r, maxBytes, timeoutMs).then(function (ab) {
                                        return cacheSet('terrarium|' + key, ab).then(function () {
                                            return decodePng(new Blob([ab], { type: 'image/png' }));
                                        });
                                    });
                                });
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
            .then(function (r) { return readBodyJson(r); })
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
                    .then(function (r) { return readBodyText(r, 8 * 1024 * 1024); })
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
            'way["natural"="sea"](' + b + ');' +
            'relation["natural"~"^(water|sea)$"]["type"="multipolygon"](' + b + ');' +
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
                if ((tags.natural === 'water' || tags.natural === 'sea') && closed) { polygons.push({ cls: 'large', name: tags.name || null, type: tags.natural, water: tags.water || null, rings: [coords] }); return; }
                var wt = tags.waterway;
                var cls = OSM_CLASS[wt];
                if (cls) lines.push({ cls: cls, coords: coords, name: tags.name || null });
            } else if (el.type === 'relation' && el.members) {
                var rings = [];
                el.members.forEach(function (m) {
                    if (m.type === 'way' && m.role === 'outer' && m.geometry) rings.push(m.geometry.map(function (p) { return [p.lon, p.lat]; }));
                });
                if (rings.length) { var rt=el.tags||{};polygons.push({ cls: 'large', name: rt.name||null, type: rt.natural||null, water: rt.water||null, rings: rings }); }
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
                    }, { rate: { concurrency: 1, minIntervalMs: 1500 }, step: 'water', endpoint: 'overpass',
                        timeoutMs: (CONFIG.overpass.timeoutS + 15) * 1000 })
                        .then(function (r) { return readBodyJson(r, (CONFIG.overpass.timeoutS + 15) * 1000); })
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
        parseWcsCoverageSummaries: parseWcsCoverageSummaries,
        wcsCoverageUrls: wcsCoverageUrls,
        decodeGeoTiffRaster: decodeGeoTiffRaster,
        decodeGeoTiffFloat: decodeGeoTiffFloat,
        resampleRaster: resampleRaster,
        withTimeout: withTimeout,
        withDeadline: withDeadline,
        fetchWithTimeout: fetchWithTimeout,
        httpFetch: httpFetch,
        readBodyBuffer: readBodyBuffer,
        timeoutFailure: timeoutFailure,
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
        demChain: demChain,
        waterChain: waterChain
    };
});
