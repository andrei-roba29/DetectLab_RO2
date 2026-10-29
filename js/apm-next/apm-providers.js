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
        ? { core: require('./apm-core.js'), raster: require('./apm-raster.js') }
        : { core: root.DetectLabApmCore, raster: root.DetectLabApmRaster };
    var api = factory(deps.core, deps.raster, typeof fetch === 'function' ? fetch : null,
        typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmProviders = api;
})(typeof self !== 'undefined' ? self : this, function (core, raster, fetchImpl, idb) {
    'use strict';

    /* ── Configuration (edit here; nothing else needs changing to swap a source) ─ */
    var CONFIG = {
        euDem: {
            // Service root as given in the brief. ArcGIS publishes WCS under <service>/WCSServer.
            // Candidate, not verified: https://image.discomap.eea.europa.eu/arcgis/services/GioLandPublic/DEM/MapServer/WCSServer
            wcsEndpoint: 'https://image.discomap.eea.europa.eu/arcgis/services/GioLandPublic/DEM/MapServer/WCSServer',
            coverageMatch: /dem/i,      // coverage id is discovered from GetCapabilities, not guessed
            nominalResM: 25,
            tilePx: 1000
        },
        euHydro: {
            base: 'https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer',
            maxRecordsPerQuery: 1000,           // service cap quoted in the brief; paging/quadtree handles overflow
            maxQuadDepth: 6
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
        // Optional same-origin proxy prefix for CORS-blocked sources (empty = direct requests only).
        proxyPrefix: ''
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

    /** Cached, rate-limited GET/POST. Returns Response-like result; throws on HTTP error. */
    function httpFetch(url, init, opts) {
        opts = opts || {};
        var host = (function () { try { return new URL(url).host; } catch (e) { return 'local'; } })();
        var target = CONFIG.proxyPrefix && opts.viaProxy ? CONFIG.proxyPrefix + encodeURIComponent(url) : url;
        return schedule(host, function () {
            if (!fetchImpl) throw new Error('fetch is not available in this environment.');
            return fetchImpl(target, init).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + host);
                return res;
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

    /* ── DEM: EU-DEM v1.1 via WCS (coverage discovered at runtime) ───────── */
    var euDemCoverage = null;

    function parseWcsCoverageIds(xmlText) {
        var ids = [];
        var doc = typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(xmlText, 'text/xml') : null;
        if (doc) {
            var nodes = doc.getElementsByTagNameNS('*', 'CoverageId');
            for (var i = 0; i < nodes.length; i++) ids.push(nodes[i].textContent.trim());
            if (!ids.length) {
                var offs = doc.getElementsByTagNameNS('*', 'CoverageOfferingBrief');
                for (i = 0; i < offs.length; i++) {
                    var nm = offs[i].getElementsByTagNameNS('*', 'name')[0];
                    if (nm) ids.push(nm.textContent.trim());
                }
            }
        } else {
            var re = /<(?:\w+:)?CoverageId>([^<]+)<\/(?:\w+:)?CoverageId>/g, m;
            while ((m = re.exec(xmlText))) ids.push(m[1].trim());
        }
        return ids;
    }

    function createEuDemProvider() {
        return {
            id: 'eu-dem',
            label: 'EU-DEM v1.1 (EEA, 25 m)',
            source: 'Copernicus Land Monitoring Service / EEA — EU-DEM v1.1',
            nominalResM: CONFIG.euDem.nominalResM,
            coversLonLat: inEea39Approx,
            discover: function () {
                if (euDemCoverage) return Promise.resolve(euDemCoverage);
                var url = CONFIG.euDem.wcsEndpoint + '?service=WCS&version=2.0.1&request=GetCapabilities';
                return httpFetch(url, {}, { rate: { concurrency: 1, minIntervalMs: 500 } })
                    .then(function (r) { return r.text(); })
                    .then(function (xml) {
                        var ids = parseWcsCoverageIds(xml).filter(function (id) { return CONFIG.euDem.coverageMatch.test(id); });
                        if (!ids.length) throw new Error('EU-DEM coverage not found in WCS GetCapabilities.');
                        euDemCoverage = { id: ids[0], all: ids };
                        return euDemCoverage;
                    });
            },
            fetchBlock: function (grid) {
                var self = this;
                return self.discover().then(function (cov) {
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
                    return httpFetch(CONFIG.euDem.wcsEndpoint + '?' + q.join('&'), {}, { rate: { concurrency: 2, minIntervalMs: 300 } })
                        .then(function (r) { return r.arrayBuffer(); })
                        .then(decodeGeoTiffFloat);
                });
            }
        };
    }

    /** Decode a single-band GeoTIFF into Float32Array (uses vendored geotiff.js global). */
    function decodeGeoTiffFloat(buf) {
        if (typeof GeoTIFF === 'undefined') return Promise.reject(new Error('geotiff.js is not loaded.'));
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
                            return httpFetch(url, {}, { rate: { concurrency: 4, minIntervalMs: 20 } })
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
    /** Map Strahler order to a size class (see apm-core WATER_CLASSES). */
    function strahlerToClass(order) {
        if (order == null || !isFinite(order)) return null;
        if (order <= 2) return 'small';
        if (order <= 4) return 'medium';
        return 'large';
    }

    /**
     * Resolve EU-Hydro leaf layers from the service JSON (names and ids are read, not guessed).
     * Returns [{ id, name, cls, role }]; role = 'lines' | 'polygon' | 'inland' | 'drainage'.
     */
    function resolveEuHydroLayers(serviceJson) {
        var layers = (serviceJson && serviceJson.layers) || [];
        var out = [];
        layers.forEach(function (l) {
            var name = String(l.name || '');
            var subs = l.subLayerIds || [];
            if (/drainage/i.test(name)) { out.push({ id: l.id, name: name, cls: null, role: 'drainage', group: subs.length > 0 }); return; }
            if (subs.length) return;                                    // group layer: its leaves are handled below
            var order = (name.match(/strahler\D*(\d+)/i) || [])[1];
            if (/river_?net_?lines?/i.test(name) || (l.parentLayerId >= 0 && /strahler/i.test(name))) {
                out.push({ id: l.id, name: name, cls: strahlerToClass(order ? Number(order) : null), order: order ? Number(order) : null, role: 'lines' });
            } else if (/river_?net_?polygon/i.test(name)) {
                out.push({ id: l.id, name: name, cls: 'large', role: 'polygon' });
            } else if (/inland.?water/i.test(name)) {
                out.push({ id: l.id, name: name, cls: 'large', role: 'inland' });
            }
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
        return httpFetch(url, {}, { rate: { concurrency: 2, minIntervalMs: 250 } })
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
                layersPromise = httpFetch(CONFIG.euHydro.base + '?f=json', {}, { rate: { concurrency: 1, minIntervalMs: 500 } })
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        var ls = resolveEuHydroLayers(j);
                        if (!ls.length) throw new Error('No River_Net / InlandWater layers found in EU-Hydro service JSON.');
                        return ls;
                    })
                    .catch(function (e) { layersPromise = null; throw e; });
            }
            return layersPromise;
        }
        return {
            id: 'eu-hydro',
            label: 'EU-Hydro (EEA)',
            source: 'EEA — EU-Hydro River Network Database (EEA39)',
            coversLonLat: inEea39Approx,
            layers: layers,
            fetchWater: function (bbox, opts) {
                opts = opts || {};
                var simplify = opts.simplifyDeg == null ? 0.0001 : opts.simplifyDeg;
                return layers().then(function (ls) {
                    var acc = { lines: [], rings: [] };
                    var use = ls.filter(function (l) { return l.role !== 'drainage' || opts.includeDrainage; });
                    return use.reduce(function (p, layer) {
                        return p.then(function () { return queryLayerAll(CONFIG.euHydro.base, layer, bbox, 0, acc, simplify); });
                    }, Promise.resolve()).then(function () {
                        return {
                            lines: acc.lines, polygons: acc.rings,
                            meta: { provider: 'eu-hydro', layers: use.map(function (l) { return l.name; }), incompleteTiles: acc.incomplete || 0 }
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
                    }, { rate: { concurrency: 1, minIntervalMs: 1500 } })
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

    /** Placeholder for the Ariadne provider (Phase 3). Deliberately unavailable until a documented API is verified. */
    function createAriadneSiteProvider() {
        return {
            id: 'ariadne',
            label: 'Ariadne (not available yet)',
            source: 'ARIADNE Portal — access method not yet verified',
            available: false,
            getSites: function () {
                return Promise.reject(new Error('The Ariadne provider is not enabled: no verified public API has been confirmed. Use CSV upload.'));
            }
        };
    }

    /* ── Provider chooser ────────────────────────────────────────────────── */
    /** DEM providers in preference order for a centre; the pipeline falls through on failure. */
    function demChain(lat, lon) {
        var chain = [];
        var eu = createEuDemProvider();
        if (eu.coversLonLat(lat, lon)) chain.push(eu);
        chain.push(createTerrariumProvider());
        return chain;
    }

    function waterChain(lat, lon) {
        var chain = [];
        if (inEea39Approx(lat, lon)) chain.push(createEuHydroProvider());
        chain.push(createOverpassWaterProvider());
        return chain;
    }

    return {
        CONFIG: CONFIG,
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
        resolveEuHydroLayers: resolveEuHydroLayers,
        buildEsriQuery: buildEsriQuery,
        parseEsriGeoJson: parseEsriGeoJson,
        buildOverpassQuery: buildOverpassQuery,
        parseOverpass: parseOverpass,
        createEuDemProvider: createEuDemProvider,
        createTerrariumProvider: createTerrariumProvider,
        createEuHydroProvider: createEuHydroProvider,
        createOverpassWaterProvider: createOverpassWaterProvider,
        createCsvSiteProvider: createCsvSiteProvider,
        createAriadneSiteProvider: createAriadneSiteProvider,
        demChain: demChain,
        waterChain: waterChain
    };
});
