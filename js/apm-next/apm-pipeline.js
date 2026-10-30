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

    /** Keyed message helper (translated by the UI; `text` is the English fallback). */
    var M = core.msg;

    /** Build a step-log record for a source decision and write it to the diagnostics log. */
    function stepRecord(step, item, outcome, reason, ms) {
        var rec = {
            step: step, provider: item.provider.id, label: item.provider.label,
            endpoint: item.provider.endpoint || null, outcome: outcome,
            reason: reason || null, ms: ms == null ? null : ms
        };
        if (item.provider.version) rec.version = item.provider.version;
        prov.logStep(rec);
        return rec;
    }

    /**
     * Pick the first DEM provider in the plan that returns real terrain at the centre.
     * Probes a small window so an unavailable service fails fast. Resolves { provider, decision }.
     * Warnings (fallbacks, Terrarium, older version) are pushed into `warnings` as keyed messages.
     */
    function pickDemProvider(centre, token, warnings) {
        var plan = prov.demPlan(centre.lat, centre.lon);
        var attempts = [];
        return plan.reduce(function (p, item) {
            return p.then(function (found) {
                if (found) { attempts.push(stepRecord('dem', item, 'skipped', M('skip.earlierUsed', {}, 'an earlier source was used'))); return found; }
                if (!item.use) { attempts.push(stepRecord('dem', item, 'skipped', item.skipReason)); return null; }
                checkToken(token);
                var bb = core.circleBBox(centre.lat, centre.lon, 300);
                var g = raster.gridForBBox(bb, item.provider.nominalResM);
                var t0 = Date.now();
                return item.provider.fetchBlock(g).then(function (elev) {
                    var f = validFraction(elev);
                    if (f < 0.5) throw prov.failure('reason.noData', {}, 'mostly no-data at this location');
                    attempts.push(stepRecord('dem', item, 'used', null, Date.now() - t0));
                    return { provider: item.provider };
                }).catch(function (e) {
                    if (isCancelled(e)) throw e;
                    var reason = (e && e.reason) || M('reason.error', { msg: e && e.message }, String(e && e.message));
                    attempts.push(stepRecord('dem', item, 'failed', reason, Date.now() - t0));
                    return null;
                });
            });
        }, Promise.resolve(null)).then(function (found) {
            if (!found) {
                var tried = attempts.filter(function (a) { return a.outcome === 'failed'; })
                    .map(function (a) { return a.label + ' (' + a.reason.key + ')'; }).join('; ') || 'none';
                throw core.keyedError('err.noDem', { tried: tried },
                    'No elevation source responded for this location. Tried: ' + tried + '.');
            }
            var dem = found.provider;
            var failed = attempts.filter(function (a) { return a.outcome === 'failed'; });
            var decision = { chosen: { id: dem.id, label: dem.label, version: dem.version || null, tier: dem.tier, resM: dem.nominalResM, endpoint: dem.endpoint }, attempts: attempts };
            if (failed.length) {
                // Name the first failed source, its reason, and what was used instead.
                var first = failed[0];
                warnings.push(M('warn.demFallback', { from: first.label, reason: first.reason, to: dem.label },
                    'Elevation source "' + first.label + '" failed; used ' + dem.label + ' instead.'));
            }
            if (dem.tier === 'fallback') {
                // Terrarium as the only possible source (outside EU-DEM coverage) is information, not a warning.
                // Terrarium after an EU-DEM candidate failed inside Europe is still a warning.
                var euDemPossible = plan.some(function (x) { return x.use && x.provider.id !== 'terrarium'; });
                if (euDemPossible) warnings.push(M('warn.demTerrarium', { res: dem.nominalResM }, 'Elevation is Terrarium.'));
                else warnings.push(M('info.demTerrariumOnly', { res: dem.nominalResM }, 'Terrarium is the only elevation source here.'));
            }
            if (dem.version === '1.0') warnings.push(M('warn.demOlder', {}, 'Elevation is EU-DEM v1.0.'));
            return { provider: dem, decision: decision };
        });
    }

    /** Water options passed to every water provider (Strahler map, drainage switch). */
    function waterOptions(params) {
        return { strahlerMap: params.strahlerMap || prov.defaultStrahlerMap(), includeDrainage: !!params.includeDrainage };
    }

    /**
     * Water for a bbox: first available provider in the plan. A failure is non-fatal: the next provider is
     * tried and the failures are reported as warnings. Resolves { water, provider, attempts }.
     */
    function fetchWaterChain(centre, bbox, token, warnings, opts) {
        var plan = prov.waterPlan(centre.lat, centre.lon);
        var attempts = [], failed = [];
        return plan.reduce(function (p, item) {
            return p.then(function (found) {
                if (found) { attempts.push(stepRecord('water', item, 'skipped', M('skip.earlierUsed', {}, 'an earlier source was used'))); return found; }
                if (!item.use) { attempts.push(stepRecord('water', item, 'skipped', item.skipReason)); return null; }
                checkToken(token);
                var t0 = Date.now();
                return item.provider.fetchWater(bbox, opts).then(function (res) {
                    attempts.push(stepRecord('water', item, 'used', null, Date.now() - t0));
                    return { water: res, provider: item.provider };
                }).catch(function (e) {
                    if (isCancelled(e)) throw e;
                    var reason = (e && e.reason) || M('reason.error', { msg: e && e.message }, String(e && e.message));
                    attempts.push(stepRecord('water', item, 'failed', reason, Date.now() - t0));
                    failed.push({ label: item.provider.label, reason: reason });
                    return null;
                });
            });
        }, Promise.resolve(null)).then(function (found) {
            if (!found) {
                failed.forEach(function (f) { warnings.push(M('warn.waterUnavailable', { src: f.label, reason: f.reason }, 'Water source unavailable.')); });
                warnings.push(M('warn.noWater', {}, 'No water data: the water weight has no effect.'));
                return { water: { lines: [], polygons: [] }, provider: null, attempts: attempts };
            }
            if (failed.length) {
                warnings.push(M('warn.waterFallback', { from: failed[0].label, reason: failed[0].reason, to: found.provider.label }, 'Water source fallback.'));
            }
            if (found.water.meta && found.water.meta.drainage) warnings.push(M('warn.drainageIncluded', {}, 'Drainage network included.'));
            found.attempts = attempts;
            return found;
        });
    }

    function provenanceFor(dem, grid, water, waterProvider, decision) {
        var resM = prov.gridResM(grid);
        return {
            dem: {
                id: dem.id, label: dem.label, source: dem.source, version: dem.version || null, tier: dem.tier,
                nominalResM: dem.nominalResM, cellM: Math.round(resM * 10) / 10, endpoint: dem.endpoint || null
            },
            demDecision: decision || null,
            water: waterProvider ? { id: waterProvider.id, label: waterProvider.label, source: waterProvider.source, endpoint: waterProvider.endpoint || null } : null
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
        var key = [params.centre.lat.toFixed(5), params.centre.lon.toFixed(5), params.radiusKm, params.smoothDem ? 's' : 'r',
            params.includeDrainage ? 'd' : '-', JSON.stringify(params.strahlerMap || null)].join('|');
        var progress = params.onProgress || function () {};
        var prepare = Promise.resolve();

        if (session.analysisKey !== key || !session.worker) {
            prepare = (function () {
                progress('prog.chooseDem', 5);
                return pickDemProvider(params.centre, params.token, warnings).then(function (pick) {
                    var dem = pick.provider;
                    checkToken(params.token);
                    var bbox = core.circleBBox(params.centre.lat, params.centre.lon, radiusM + BUFFER_M);
                    var grid = raster.gridForBBox(bbox, dem.nominalResM);
                    progress('prog.downloadDem', 15, { label: dem.label });
                    return prov.loadDemGrid(dem, grid, dem.tilePx || 1000).then(function (elev) {
                        checkToken(params.token);
                        progress('prog.water', 40);
                        return fetchWaterChain(params.centre, bbox, params.token, warnings, waterOptions(params)).then(function (wr) {
                            checkToken(params.token);
                            progress('prog.terrain', 60);
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
                                session.provenance = provenanceFor(dem, grid, wr.water, wr.provider, pick.decision);
                                session.stats = res.stats;
                                session.waterClasses = Object.keys(masks);
                            });
                        });
                    });
                });
            })();
        }

        return prepare.then(function () {
            checkToken(params.token);
            progress('prog.scoring', 85);
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
                progress('prog.done', 100);
                return {
                    geojson: res.geojson,
                    heatmap: res.heatmap,
                    thresholds: res.thresholds,
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
     * Settlement pool for a centre: filters positions and types, retaining individual occupation phases.
     * Returns { pool, periods, dropped } — periods are offered to the user.
     */
    function sitePool(records, centre) {
        var pool = sites.filterSites(records, { center: centre, radiusKm: TRAIN_AREA_KM, period: null });
        return { pool: pool.sites, periods: sites.groupPeriods(pool.sites), dropped: pool.dropped };
    }

    /**
     * Site-count status for TRAIN: 'block' below minSites (run refused), 'warn' below warnSites, else 'ok'.
     * Shared by the UI and the tests so the thresholds live in one place.
     */
    function trainSiteStatus(n, minSites, warnSites) {
        minSites = minSites == null ? 10 : minSites;
        warnSites = warnSites == null ? 30 : warnSites;
        if (!(n >= minSites)) return { status: 'block', n: n, min: minSites, rec: warnSites };
        if (n < warnSites) return { status: 'warn', n: n, min: minSites, rec: warnSites };
        return { status: 'ok', n: n, min: minSites, rec: warnSites };
    }

    /**
     * params: { centre, records, period:{key,label,start,end}|null, radiusKm, curves?, waterClasses,
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
        if (trainSiteStatus(nSites, minSites, warnSites).status === 'block') {
            var err = core.keyedError('err.tooFewSites', { n: nSites, min: minSites },
                'Only ' + nSites + ' usable known sites for this period (minimum ' + minSites + ').');
            err.code = 'too_few_sites';
            return Promise.reject(err);
        }
        var unknownAccuracy = sel.sites.filter(function (s) { return s.source === 'ariadne' && s.positionAccuracy == null; }).length;
        if (unknownAccuracy) warnings.push(M('warn.ariadneAccuracy', { n: unknownAccuracy }, 'ARIADNE points have unverified position accuracy.'));
        if (nSites < warnSites) warnings.push(M('warn.fewSites', { n: nSites, rec: warnSites }, 'Only ' + nSites + ' sites.'));

        var bg = sampleBackground(centre, areaM, params.bgCount || 5000, sel.sites, BG_EXCLUDE_M, params.rnd);
        var pts = sel.sites.map(function (s) {
            var mpd = core.metresPerDegree(centre.lat);
            return { lat: s.lat, lon: s.lon, x: (s.lon - centre.lon) * mpd.lon, y: (s.lat - centre.lat) * mpd.lat, isSite: true };
        }).concat(bg.map(function (b) { return { lat: b.lat, lon: b.lon, x: b.x, y: b.y, isSite: false }; }));

        var bbox = core.circleBBox(centre.lat, centre.lon, areaM + 1000);
        var dem, demDecision = null, grid, water = { water: null, provider: null }, classes = [];
        return pickDemProvider(centre, params.token, warnings).then(function (pick) {
            dem = pick.provider;
            demDecision = pick.decision;
            grid = raster.gridForBBox(bbox, dem.nominalResM);
            progress('prog.waterTrain', 8);
            return fetchWaterChain(centre, bbox, params.token, warnings, waterOptions(params));
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
            progress('prog.sampling', 15, { pct: 0 });
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
                            progress('prog.sampling', 15 + Math.round(45 * done / pts.length), { pct: Math.round(100 * done / pts.length) });
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
                    var e2 = core.keyedError('err.tooFewTerrain', { n: built.counts.sites, min: minSites },
                        'After terrain sampling only ' + built.counts.sites + ' sites had valid terrain (minimum ' + minSites + ').');
                    e2.code = 'too_few_sites';
                    throw e2;
                }
                checkToken(params.token);
                progress('prog.train', 65);
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
            progress('prog.window', 80);
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
                    session.provenance = provenanceFor(dem, wgrid, water.water, water.provider, demDecision);
                    if (params.siteSource) session.provenance.sites = params.siteSource;
                    session.stats = res.stats;
                    session.waterClasses = Object.keys(masks);
                    return t;
                });
            });
        }).then(function (t) {
            checkToken(params.token);
            progress('prog.scoring', 90);
            var tr = t.train;
            var thr = tr.thresholds;
            return session.worker.call('score', {
                mode: 'train', model: tr.model, waterClasses: t.built.waterClasses,
                thresholds: thr, minAreaM2: params.minAreaM2, smoothIters: 1
            }).then(function (res) {
                progress('prog.done', 100);
                var periodCount = sel.sites.length;
                return {
                    mode: 'train',
                    geojson: res.geojson,
                    heatmap: res.heatmap,
                    thresholds: res.thresholds,
                    areaKm2: res.areaKm2,
                    scoreStats: res.scoreStats,
                    provenance: session.provenance,
                    warnings: t.warnings.concat(warnings),
                    diagnostics: {
                        sitesUsed: periodCount,
                        sitesWithUnknownAccuracy: unknownAccuracy,
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
        trainSiteStatus: trainSiteStatus,
        runManual: runManual,
        runTrain: runTrain,
        pickDemProvider: pickDemProvider,
        fetchWaterChain: fetchWaterChain,
        waterOptions: waterOptions
    };
});
