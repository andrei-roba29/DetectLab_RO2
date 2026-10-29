/*!
 * DetectLab — Next-Gen APM · orchestration (main thread; heavy maths in the worker).
 *
 *   MANUAL  search window → DEM (provider chain) → water (provider chain) → worker.setAnalysis → worker.score
 *   TRAIN   known sites (50 km) → period filter → background sample → DEM tiles → worker.sampleTile
 *           → buildSampleSet → worker.train → prediction window → worker.score (TRAIN thresholds)
 *
 * Re-scoring with new weights/curves reuses the analysis already loaded in the worker
 * (no refetch, no terrain recompute): see `session.analysisKey`.
 */
(function (root, factory) {
    var deps = typeof module === 'object' && module.exports
        ? { core: require('./apm-core.js'), raster: require('./apm-raster.js'), sites: require('./apm-sites.js'), prov: require('./apm-providers.js') }
        : { core: root.DetectLabApmCore, raster: root.DetectLabApmRaster, sites: root.DetectLabApmSites, prov: root.DetectLabApmProviders };
    var api = factory(deps.core, deps.raster, deps.sites, deps.prov);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmPipeline = api;
})(typeof self !== 'undefined' ? self : this, function (core, raster, sites, prov) {
    'use strict';

    var BUFFER_M = 3000;          // context beyond the search circle (water decay band, Horn edges)
    var TRAIN_AREA_KM = 50;
    var BG_EXCLUDE_M = 500;       // no background point within 500 m of a site
    var CANCELLED = 'cancelled';

    function cancelledError() { var e = new Error('Cancelled'); e.code = CANCELLED; return e; }
    function isCancelled(e) { return e && e.code === CANCELLED; }

    /* ── Worker client ─────────────────────────────────────────────────────── */
    /**
     * @param url  worker script URL. Each call resolves with the worker reply (ok === true) or rejects.
     */
    function createWorkerClient(url) {
        var worker = new Worker(url);
        var seq = 0, pending = {};
        worker.onmessage = function (ev) {
            var m = ev.data || {};
            var p = pending[m.id];
            if (!p) return;
            delete pending[m.id];
            if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'Worker error'));
        };
        worker.onerror = function (ev) {
            Object.keys(pending).forEach(function (k) { pending[k].reject(new Error('Worker failed: ' + (ev.message || 'unknown'))); delete pending[k]; });
        };
        return {
            call: function (op, payload, transfer) {
                var id = ++seq;
                return new Promise(function (resolve, reject) {
                    pending[id] = { resolve: resolve, reject: reject };
                    var msg = Object.assign({ op: op, id: id }, payload);
                    worker.postMessage(msg, transfer || []);
                });
            },
            terminate: function () {
                worker.terminate();
                Object.keys(pending).forEach(function (k) { pending[k].reject(cancelledError()); delete pending[k]; });
            }
        };
    }

    /* ── Helpers ───────────────────────────────────────────────────────────── */
    function checkToken(token) { if (token && token.cancelled) throw cancelledError(); }

    /** Rasterise provider water (lines + polygons) into per-class masks on a grid. */
    function rasteriseWater(water, grid) {
        var masks = {};
        function mask(c) { return masks[c] || (masks[c] = new Uint8Array(grid.w * grid.h)); }
        (water.lines || []).forEach(function (l) { raster.rasteriseLines([l.coords], grid, mask(l.cls)); });
        (water.polygons || []).forEach(function (p) { raster.rasterisePolygons(p.rings, grid, mask(p.cls)); });
        return masks;
    }

    /** Flat [lon1,lat1,lon2,lat2,…] segments per class, for the worker's rbush index (TRAIN). */
    function waterSegments(water) {
        var out = {};
        function push(c, a, b) {
            var arr = out[c] || (out[c] = []);
            arr.push(a[0], a[1], b[0], b[1]);
        }
        (water.lines || []).forEach(function (l) {
            for (var i = 0; i + 1 < l.coords.length; i++) push(l.cls, l.coords[i], l.coords[i + 1]);
        });
        (water.polygons || []).forEach(function (p) {
            p.rings.forEach(function (ring) {
                for (var i = 0; i + 1 < ring.length; i++) push(p.cls, ring[i], ring[i + 1]);
            });
        });
        Object.keys(out).forEach(function (c) { out[c] = Float64Array.from(out[c]); });
        return out;
    }

    /** Fraction of valid DEM cells, to reject all-nodata responses (e.g. open sea). */
    function validFraction(elev) {
        var n = 0;
        for (var i = 0; i < elev.length; i++) if (raster.isValidElev(elev[i])) n++;
        return elev.length ? n / elev.length : 0;
    }

    /**
     * Pick the first DEM provider in the chain that returns real terrain at the centre.
     * Probes a small window so an unavailable service fails fast.
     */
    function pickDemProvider(centre, token) {
        var chain = prov.demChain(centre.lat, centre.lon);
        var attempts = [];
        return chain.reduce(function (p, dem) {
            return p.then(function (found) {
                if (found) return found;
                checkToken(token);
                var probeM = 300;
                var bb = core.circleBBox(centre.lat, centre.lon, probeM);
                var g = raster.gridForBBox(bb, dem.nominalResM);
                return dem.fetchBlock(g).then(function (elev) {
                    var f = validFraction(elev);
                    if (f < 0.5) throw new Error('mostly no-data');
                    return { provider: dem };
                }).catch(function (e) {
                    attempts.push(dem.id + ': ' + (e && e.message));
                    return null;
                });
            });
        }, Promise.resolve(null)).then(function (found) {
            if (!found) throw new Error('No elevation source responded for this location. Tried ' + attempts.join('; ') + '.');
            return found.provider;
        });
    }

    /** Water for a bbox: first available provider; failure is non-fatal (returns empty + warning). */
    function fetchWaterChain(centre, bbox, token, warnings) {
        var chain = prov.waterChain(centre.lat, centre.lon);
        return chain.reduce(function (p, wp) {
            return p.then(function (found) {
                if (found) return found;
                checkToken(token);
                return wp.fetchWater(bbox, {}).then(function (res) {
                    return { water: res, provider: wp };
                }).catch(function (e) {
                    warnings.push('Water source "' + wp.label + '" unavailable: ' + (e && e.message) + '. Water is excluded from this result.');
                    return null;
                });
            });
        }, Promise.resolve(null)).then(function (found) {
            if (!found) return { water: { lines: [], polygons: [] }, provider: null };
            return found;
        });
    }

    function provenanceFor(dem, grid, water, waterProvider) {
        var resM = prov.gridResM(grid);
        return {
            dem: { id: dem.id, label: dem.label, source: dem.source, cellM: Math.round(resM * 10) / 10 },
            water: waterProvider ? { id: waterProvider.id, label: waterProvider.label, source: waterProvider.source } : null
        };
    }

    /* ── MANUAL ────────────────────────────────────────────────────────────── */
    /**
     * session: { worker, analysisKey, dem, water (rasters) } — kept between runs.
     * params:  { centre, radiusKm, curves, weights, minSlopeDeg, smoothDem, waterClasses,
     *            thresholds, minAreaM2, onProgress, token }
     */
    function runManual(session, params) {
        var warnings = [];
        var radiusM = params.radiusKm * 1000;
        var key = [params.centre.lat.toFixed(5), params.centre.lon.toFixed(5), params.radiusKm, params.smoothDem ? 's' : 'r'].join('|');
        var progress = params.onProgress || function () {};
        var prepare = Promise.resolve();

        if (session.analysisKey !== key || !session.worker) {
            prepare = (function () {
                progress('Choosing elevation source…', 5);
                return pickDemProvider(params.centre, params.token).then(function (dem) {
                    checkToken(params.token);
                    var bbox = core.circleBBox(params.centre.lat, params.centre.lon, radiusM + BUFFER_M);
                    var grid = raster.gridForBBox(bbox, dem.nominalResM);
                    progress('Downloading elevation (' + dem.label + ')…', 15);
                    return prov.loadDemGrid(dem, grid, dem.tilePx || 1000).then(function (elev) {
                        checkToken(params.token);
                        progress('Downloading water features…', 40);
                        return fetchWaterChain(params.centre, bbox, params.token, warnings).then(function (wr) {
                            checkToken(params.token);
                            progress('Computing terrain and water distance…', 60);
                            var masks = rasteriseWater(wr.water, grid);
                            if (session.worker) session.worker.terminate();
                            session.worker = createWorkerClient(params.workerUrl);
                            session.analysisKey = null;
                            return session.worker.call('setAnalysis', {
                                grid: grid, elev: elev, smooth: !!params.smoothDem, nodata: undefined,
                                circle: { lat: params.centre.lat, lon: params.centre.lon, radiusM: radiusM },
                                waterMasks: masks, altRef: null, soilRef: null
                            }).then(function (res) {
                                session.analysisKey = key;
                                session.provenance = provenanceFor(dem, grid, wr.water, wr.provider);
                                session.stats = res.stats;
                                session.waterClasses = Object.keys(masks);
                                if (!wr.provider) warnings.push('No water data: water weight has no effect.');
                            });
                        });
                    });
                });
            })();
        }

        return prepare.then(function () {
            checkToken(params.token);
            progress('Scoring…', 85);
            var enabled = params.waterClasses.filter(function (c) { return session.waterClasses.indexOf(c) >= 0; });
            return session.worker.call('score', {
                mode: 'manual',
                curves: params.curves,
                weights: params.weights,
                minSlopeDeg: params.minSlopeDeg,
                preferredAspectDeg: core.preferredAspectDeg(params.centre.lat),
                waterClasses: enabled,
                thresholds: params.thresholds,
                minAreaM2: params.minAreaM2,
                smoothIters: 1
            }).then(function (res) {
                progress('Done', 100);
                return {
                    geojson: res.geojson,
                    areaKm2: res.areaKm2,
                    scoreStats: res.scoreStats,
                    provenance: session.provenance,
                    warnings: warnings.slice(),
                    mode: 'manual'
                };
            });
        });
    }

    /* ── TRAIN: background sampling and sample-set assembly (pure) ────────── */
    /** Uniform random points in a disc (metres), excluding a buffer around the given sites. */
    function sampleBackground(centre, radiusM, count, siteList, excludeM, rnd) {
        rnd = rnd || Math.random;
        var out = [], tries = 0, mpd = core.metresPerDegree(centre.lat);
        var maxTries = count * 20;
        while (out.length < count && tries < maxTries) {
            tries++;
            var r = radiusM * Math.sqrt(rnd()), th = rnd() * 2 * Math.PI;
            var x = r * Math.cos(th), y = r * Math.sin(th);
            var lat = centre.lat + y / mpd.lat, lon = centre.lon + x / mpd.lon;
            var ok = true;
            for (var s = 0; s < siteList.length; s++) {
                if (core.haversineM(lat, lon, siteList[s].lat, siteList[s].lon) < excludeM) { ok = false; break; }
            }
            if (ok) out.push({ lat: lat, lon: lon, x: x, y: y });
        }
        return out;
    }

    /**
     * Assemble the sample set used by core.trainModelFromSamples.
     * pts: [{ lat, lon, x, y, isSite, elev, slope, aspect, curv, valid, water:{class: metres} }]
     * Altitude and soil become percentiles relative to the BACKGROUND distribution (reference window).
     */
    function buildSampleSet(pts, opts) {
        var minSlope = opts.minSlopeDeg == null ? 0.5 : opts.minSlopeDeg;
        var waterClasses = opts.waterClasses || [];
        var keep = pts.filter(function (p) {
            return p.valid && isFinite(p.elev) && isFinite(p.slope) && isFinite(p.curv);
        });
        var bg = keep.filter(function (p) { return !p.isSite; });
        var altRef = raster.sortedFinite(bg.map(function (p) { return p.elev; }));
        var soilRef = raster.sortedFinite(bg.map(function (p) { return p.curv; }));
        var n = keep.length;
        var S = { n: n, y: new Uint8Array(n), fold: new Uint8Array(n), vals: {} };
        ['altitude', 'slope', 'aspect', 'soil'].forEach(function (k) { S.vals[k] = new Float64Array(n); });
        waterClasses.forEach(function (c) { S.vals['water_' + c] = new Float64Array(n); });
        for (var i = 0; i < n; i++) {
            var p = keep[i];
            S.y[i] = p.isSite ? 1 : 0;
            S.fold[i] = core.spatialFold(p.x, p.y, opts.radiusM, opts.folds || 5, 4);
            S.vals.altitude[i] = raster.percentileOf(altRef, p.elev);
            S.vals.slope[i] = p.slope;
            S.vals.aspect[i] = p.slope >= minSlope ? p.aspect : NaN;   // aspect undefined on flat ground
            S.vals.soil[i] = raster.percentileOf(soilRef, p.curv);
            waterClasses.forEach(function (c) {
                var d = p.water ? p.water[c] : NaN;
                S.vals['water_' + c][i] = d == null ? NaN : d;
            });
        }
        var sitesN = 0;
        for (i = 0; i < n; i++) if (S.y[i]) sitesN++;
        return { S: S, altRef: altRef, soilRef: soilRef, waterClasses: waterClasses.slice(), counts: { sites: sitesN, background: n - sitesN } };
    }

    /* ── TRAIN ─────────────────────────────────────────────────────────────── */
    /**
     * Known-site pool for a centre: filters out coarse positions and non-settlement types.
     * Returns { pool, periods, dropped } — periods are offered to the user.
     */
    function sitePool(records, centre) {
        var pool = sites.filterSites(records, { center: centre, radiusKm: TRAIN_AREA_KM, period: null });
        return { pool: pool.sites, periods: sites.groupPeriods(pool.sites), dropped: pool.dropped };
    }

    /**
     * params: { centre, records, period:{start,end}, radiusKm, curves?, waterClasses,
     *           bgCount=5000, minSlopeDeg, smoothDem, thresholds? , minAreaM2, minSites=10, warnSites=30,
     *           onProgress, token, workerUrl, rnd }
     */
    function runTrain(session, params) {
        var warnings = [];
        var progress = params.onProgress || function () {};
        var centre = params.centre;
        var radiusM = params.radiusKm * 1000;
        var areaM = TRAIN_AREA_KM * 1000;
        var sel = sites.filterSites(params.records, { center: centre, radiusKm: TRAIN_AREA_KM, period: params.period });
        var nSites = sel.sites.length;
        var minSites = params.minSites || 10, warnSites = params.warnSites || 30;
        if (nSites < minSites) {
            var err = new Error('Only ' + nSites + ' usable known sites for this period (minimum ' + minSites + '). Choose a different period, upload more sites, or use MANUAL mode.');
            err.code = 'too_few_sites';
            return Promise.reject(err);
        }
        if (nSites < warnSites) warnings.push('Only ' + nSites + ' sites: the model is unreliable (recommended ≥ ' + warnSites + ').');

        var bg = sampleBackground(centre, areaM, params.bgCount || 5000, sel.sites, BG_EXCLUDE_M, params.rnd);
        var pts = sel.sites.map(function (s) {
            var mpd = core.metresPerDegree(centre.lat);
            return { lat: s.lat, lon: s.lon, x: (s.lon - centre.lon) * mpd.lon, y: (s.lat - centre.lat) * mpd.lat, isSite: true };
        }).concat(bg.map(function (b) { return { lat: b.lat, lon: b.lon, x: b.x, y: b.y, isSite: false }; }));

        var bbox = core.circleBBox(centre.lat, centre.lon, areaM + 1000);
        var dem, grid, water = { water: null, provider: null }, classes = [];
        return pickDemProvider(centre, params.token).then(function (d) {
            dem = d;
            grid = raster.gridForBBox(bbox, dem.nominalResM);
            progress('Downloading water features (50 km)…', 8);
            return fetchWaterChain(centre, bbox, params.token, warnings);
        }).then(function (wr) {
            water = wr;
            var segs = waterSegments(wr.water);
            classes = Object.keys(segs);
            if (session.worker) session.worker.terminate();
            session.worker = createWorkerClient(params.workerUrl);
            session.analysisKey = null;
            return session.worker.call('setWater', { classes: segs });
        }).then(function () {
            // Map every point to its DEM tile (1000 px cores), then sample tile by tile.
            var tilePx = dem.tilePx || 1000;
            var tileOf = new Map();
            pts.forEach(function (p, idx) {
                var c = raster.cellOf(grid, p.lon, p.lat);
                if (c < 0) return;
                var i = c % grid.w, j = Math.floor(c / grid.w);
                var key = Math.floor(j / tilePx) + ',' + Math.floor(i / tilePx);
                if (!tileOf.has(key)) tileOf.set(key, []);
                tileOf.get(key).push(idx);
            });
            var results = new Array(pts.length);
            var keys = Array.from(tileOf.keys());
            var done = 0;
            progress('Sampling elevation tiles…', 15);
            return keys.reduce(function (pr, key) {
                return pr.then(function () {
                    checkToken(params.token);
                    var parts = key.split(',').map(Number);
                    var j0 = parts[0] * tilePx, i0 = parts[1] * tilePx;
                    var cw = Math.min(grid.w - i0, tilePx), ch = Math.min(grid.h - j0, tilePx);
                    var hg = prov.subGrid(grid, i0 - 1, j0 - 1, cw + 2, ch + 2);
                    return dem.fetchBlock(hg).then(function (elev) {
                        var idxs = tileOf.get(key);
                        var flat = new Float64Array(idxs.length * 2);
                        idxs.forEach(function (pi, k) { flat[2 * k] = pts[pi].lon; flat[2 * k + 1] = pts[pi].lat; });
                        return session.worker.call('sampleTile', {
                            elev: elev, w: hg.w, h: hg.h, dxM: raster.gridSpacingM(grid).dx, dyM: raster.gridSpacingM(grid).dy,
                            tile: { west: hg.west, north: hg.north, dLon: hg.dLon, dLat: hg.dLat },
                            smooth: !!params.smoothDem, nodata: undefined, points: flat
                        }).then(function (r) {
                            idxs.forEach(function (pi, k) {
                                var o = k * 5;
                                var water = {};
                                r.classes.forEach(function (c) { water[c] = r.water[c][k]; });
                                results[pi] = {
                                    elev: r.values[o], slope: r.values[o + 1], aspect: r.values[o + 2],
                                    curv: r.values[o + 3], valid: r.inside[k] && r.values[o + 4] === 1, water: water
                                };
                            });
                            done += idxs.length;
                            progress('Sampling elevation tiles… (' + Math.round(100 * done / pts.length) + '%)', 15 + Math.round(45 * done / pts.length));
                        });
                    });
                });
            }, Promise.resolve()).then(function () {
                var merged = pts.map(function (p, i) {
                    var r = results[i] || { valid: false };
                    return Object.assign({}, p, r);
                });
                var built = buildSampleSet(merged, {
                    minSlopeDeg: params.minSlopeDeg, radiusM: areaM, folds: 5, waterClasses: params.waterClasses.filter(function (c) { return classes.indexOf(c) >= 0; })
                });
                if (built.counts.sites < minSites) {
                    var e2 = new Error('After terrain sampling only ' + built.counts.sites + ' sites had valid terrain (minimum ' + minSites + ').');
                    e2.code = 'too_few_sites';
                    throw e2;
                }
                checkToken(params.token);
                progress('Training model (cross-validation)…', 65);
                return session.worker.call('train', {
                    S: built.S, waterClasses: built.waterClasses,
                    minSlopeDeg: params.minSlopeDeg, folds: 5
                }).then(function (tr) {
                    return { train: tr.result, built: built, warnings: warnings };
                });
            });
        }).then(function (t) {
            checkToken(params.token);
            // Prediction window (search circle + buffer) with the same DEM provider.
            progress('Loading prediction window…', 80);
            var wb = core.circleBBox(centre.lat, centre.lon, radiusM + BUFFER_M);
            var wgrid = raster.gridForBBox(wb, dem.nominalResM);
            return prov.loadDemGrid(dem, wgrid, dem.tilePx || 1000).then(function (elev) {
                var masks = rasteriseWater(water.water, wgrid);
                return session.worker.call('setAnalysis', {
                    grid: wgrid, elev: elev, smooth: !!params.smoothDem, nodata: undefined,
                    circle: { lat: centre.lat, lon: centre.lon, radiusM: radiusM },
                    waterMasks: masks,
                    altRef: t.built.altRef, soilRef: t.built.soilRef
                }).then(function (res) {
                    session.analysisKey = null;
                    session.provenance = provenanceFor(dem, wgrid, water.water, water.provider);
                    session.stats = res.stats;
                    session.waterClasses = Object.keys(masks);
                    return t;
                });
            });
        }).then(function (t) {
            checkToken(params.token);
            progress('Scoring…', 90);
            var tr = t.train;
            var thr = tr.thresholds;
            return session.worker.call('score', {
                mode: 'train', model: tr.model, waterClasses: t.built.waterClasses,
                thresholds: thr, minAreaM2: params.minAreaM2, smoothIters: 1
            }).then(function (res) {
                progress('Done', 100);
                var periodCount = sel.sites.length;
                return {
                    mode: 'train',
                    geojson: res.geojson,
                    areaKm2: res.areaKm2,
                    scoreStats: res.scoreStats,
                    provenance: session.provenance,
                    warnings: t.warnings.concat(warnings),
                    diagnostics: {
                        sitesUsed: periodCount,
                        sitesInSample: t.built.counts.sites,
                        backgroundUsed: t.built.counts.background,
                        dropped: sel.dropped,
                        weights: tr.model.weights,
                        curves: tr.model.curves,
                        cv: tr.cv,
                        soilSlopeR: tr.soilSlopeR,
                        excluded: tr.excluded,
                        variables: tr.variables,
                        confidence: tr.confidence,
                        thresholds: thr,
                        noSignal: tr.model.noSignal
                    }
                };
            });
        });
    }

    return {
        BUFFER_M: BUFFER_M,
        TRAIN_AREA_KM: TRAIN_AREA_KM,
        createWorkerClient: createWorkerClient,
        isCancelled: isCancelled,
        cancelledError: cancelledError,
        rasteriseWater: rasteriseWater,
        waterSegments: waterSegments,
        sampleBackground: sampleBackground,
        buildSampleSet: buildSampleSet,
        sitePool: sitePool,
        runManual: runManual,
        runTrain: runTrain,
        pickDemProvider: pickDemProvider
    };
});
