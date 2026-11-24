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
    var api = factory(deps.core, deps.raster, deps.sites, deps.prov, root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmPipeline = api;
})(typeof self !== 'undefined' ? self : this, function (core, raster, sites, prov, root) {
    'use strict';

    var BUFFER_M = 3000;          // context beyond the search circle (water decay band, Horn edges)
    var TRAIN_AREA_KM = 50;
    var BG_EXCLUDE_M = 500;       // no background point within 500 m of a site
    var TRAIN_ROBUST_CONFIG = core.robustTrainConfig;
    var CANCELLED = 'cancelled';

    function cancelledError() { var e = new Error('Cancelled'); e.code = CANCELLED; return e; }
    function isCancelled(e) { return e && e.code === CANCELLED; }

    /** Both prediction modes must pass through the same protection mask.
     * `analysis._exclusionResult`, when present, is an already-settled { mask, stats }
     * that the caller started fetching in parallel with the DEM/water requests
     * (the UAT exclusion mask does not depend on either, so there is no reason to
     * wait for them before starting it — see runManual/runTrain). When absent,
     * the mask is requested here exactly as before (used directly by callers/tests
     * that have not pre-started it). */
    function setPredictionAnalysis(session, analysis, params, warnings) {
        checkToken(params.token);
        var exclusionPromise;
        if (analysis._exclusionResult) {
            exclusionPromise = Promise.resolve(analysis._exclusionResult);
        } else if (typeof root.computeArcheoExclusionMask !== 'function') {
            exclusionPromise = Promise.reject(new Error('Spatial exclusion service is unavailable. Please reload and try again.'));
        } else {
            exclusionPromise = root.computeArcheoExclusionMask(analysis.grid, analysis.circle.lat, analysis.circle.lon,
                analysis.circle.radiusM, { isCancelled: function () { return !!(params.token && params.token.cancelled); },
                    siteRecords: params.records ? (params.records._protectionRecords || params.records) : undefined });
        }
        return exclusionPromise
            .then(function (result) {
                checkToken(params.token);
                if (!result || !result.mask || result.mask.length !== analysis.grid.w * analysis.grid.h) {
                    throw new Error('Invalid spatial exclusion mask');
                }
                analysis.exclusionMask = result.mask;
                session.exclusionStats = result.stats;
                if (result.stats.unknown) warnings.push(core.msg('warn.exclusionUnknown', { n: result.stats.unknown },
                    'Cells with unavailable UAT exclusion data were left unscored.'));
                return session.worker.call('setAnalysis', analysis).then(function (prepared) {
                    if (prepared.stats && prepared.stats.valid === 0) {
                        var unknown = result.stats.unknown > 0;
                        throw core.keyedError(unknown ? 'err.noPredictionUat' : 'err.noPredictionCells', {},
                            unknown ? 'No prediction cells could be verified. Built-up area data may be unavailable; retry when it is accessible.' :
                                'No valid prediction cells remain after terrain and spatial exclusions.');
                    }
                    return prepared;
                });
            });
    }

    /** Starts the UAT protection-mask request right away, exactly as setPredictionAnalysis
     * would, so the caller can run it alongside the DEM/water fetches instead of after them. */
    function startExclusionMask(grid, lat, lon, radiusM, params) {
        if (typeof root.computeArcheoExclusionMask !== 'function') {
            return Promise.reject(new Error('Spatial exclusion service is unavailable. Please reload and try again.'));
        }
        return root.computeArcheoExclusionMask(grid, lat, lon, radiusM,
            { isCancelled: function () { return !!(params.token && params.token.cancelled); },
                siteRecords: params.records ? (params.records._protectionRecords || params.records) : undefined });
    }

    function requireScores(res) {
        if (res.scoreStats && res.scoreStats.cells === 0) throw core.keyedError('err.noScores', {},
            'The model could not score any prediction cells. Try another area or training dataset.');
        return res;
    }

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
     * All usable candidates are probed at the same time with small 300 m windows; the
     * first success in preference order wins. Probing in parallel is what keeps a dead
     * or stalled EEA endpoint from parking the run on "Choosing elevation source…":
     * the Terrarium probe is already in flight and every request has a deadline.
     * Resolves { provider, decision }. Warnings (fallbacks, Terrarium, older version)
     * are pushed into `warnings` as keyed messages.
     */
    function pickDemProvider(centre, token, warnings) {
        var plan = prov.demPlan(centre.lat, centre.lon);
        var bb = core.circleBBox(centre.lat, centre.lon, 300);
        var results = new Array(plan.length);
        var probes = new Array(plan.length);
        // A cancellation observed by any probe ends the wait at once; it must not sit behind
        // a sibling probe that is still running down its deadline.
        var rejectCancelled;
        var cancelledWait = new Promise(function (_, reject) { rejectCancelled = reject; });
        cancelledWait.catch(function () { /* handled by the chain below when it is waiting */ });
        // The token is a plain flag that long steps check between operations; poll it here so
        // Cancel is honoured within a tenth of a second even while every probe is stalled.
        var pollTimer = (token && typeof setInterval === 'function')
            ? setInterval(function () { if (token.cancelled) rejectCancelled(cancelledError()); }, 100) : null;
        function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

        plan.forEach(function (item, idx) {
            if (!item.use) return;
            var g = raster.gridForBBox(bb, item.provider.nominalResM);
            var t0 = Date.now();
            probes[idx] = Promise.resolve().then(function () {
                checkToken(token);
                return item.provider.fetchBlock(g, { probe: true, timeoutMs: prov.CONFIG.demProbeTimeoutMs });
            }).then(function (elev) {
                var f = validFraction(elev);
                if (f < 0.5) throw prov.failure('reason.noData', {}, 'mostly no-data at this location');
                results[idx] = { ok: true, ms: Date.now() - t0 };
            }).catch(function (e) {
                if (isCancelled(e)) {
                    results[idx] = { ok: false, cancelled: true, ms: Date.now() - t0 };
                    rejectCancelled(e);
                    return;
                }
                results[idx] = { ok: false, reason: (e && e.reason) || M('reason.error', { msg: e && e.message }, String(e && e.message)), ms: Date.now() - t0 };
            });
        });

        // Wait in preference order. A candidate that already answered (or already failed)
        // resolves immediately; a higher-preference candidate gets its full deadline
        // before the chain moves on to the next one.
        var chosenIdx = -1;
        var chain = Promise.resolve();
        plan.forEach(function (item, idx) {
            if (!item.use) return;
            chain = chain.then(function () {
                if (chosenIdx >= 0) return;
                return Promise.race([probes[idx], cancelledWait]).then(function () {
                    if (results[idx] && results[idx].ok) chosenIdx = idx;
                });
            });
        });

        return chain.then(function () {
            stopPoll();
            checkToken(token);
            var attempts = plan.map(function (item, idx) {
                if (!item.use) return stepRecord('dem', item, 'skipped', item.skipReason);
                var r = results[idx] || {};
                if (idx === chosenIdx) return stepRecord('dem', item, 'used', null, r.ms);
                if (r.cancelled) return stepRecord('dem', item, 'skipped', M('skip.cancelled', {}, 'cancelled'));
                if (chosenIdx >= 0 && idx > chosenIdx) return stepRecord('dem', item, 'skipped', M('skip.earlierUsed', {}, 'an earlier source was used'));
                if (r.ok) return stepRecord('dem', item, 'skipped', M('skip.earlierUsed', {}, 'an earlier source was used'));
                return stepRecord('dem', item, 'failed', r.reason || M('reason.error', {}, 'no result'), r.ms);
            });

            if (chosenIdx < 0) {
                var tried = attempts.filter(function (a) { return a.outcome === 'failed'; })
                    .map(function (a) { return a.label + ' (' + a.reason.key + ')'; }).join('; ') || 'none';
                throw core.keyedError('err.noDem', { tried: tried },
                    'No elevation source responded for this location. Tried: ' + tried + '.');
            }
            var dem = plan[chosenIdx].provider;
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
        }, function (e) {
            stopPoll();
            throw e;
        });
    }

    /** Water options passed to every water provider (Strahler map, drainage switch, artificial waterways). */
    function waterOptions(params) {
        var wc = params.waterClasses || [];
        return {
            strahlerMap: params.strahlerMap || prov.defaultStrahlerMap(),
            includeDrainage: !!params.includeDrainage,
            includeArtificial: wc.indexOf('artificial') >= 0
        };
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
                nominalResM: dem.nominalResM, cellM: Math.round(resM * 10) / 10, endpoint: dem.endpoint || null,
                resampledForPrediction: resM > dem.nominalResM * 1.05,
                predictionCells: grid.w * grid.h
            },
            demDecision: decision || null,
            water: waterProvider ? { id: waterProvider.id, label: waterProvider.label, source: waterProvider.source, endpoint: waterProvider.endpoint || null } : null
        };
    }

    /** Prediction grid at the DEM resolution, coarsened only when the window is
     * too large to score safely. TRAIN's fixed 50 km window otherwise needs
     * ~18 million 25 m cells and crashes the worker at the heatmap step. */
    function predictionGridFor(bbox, dem, warnings) {
        var nominal = raster.gridForBBox(bbox, dem.nominalResM);
        var grid = raster.boundedGridForBBox(bbox, dem.nominalResM, raster.MAX_PREDICTION_CELLS);
        // A few percent of coarsening at MANUAL's largest radius is not a
        // meaningful resolution change; only report a real trade-off.
        if (grid.w * grid.h < nominal.w * nominal.h && prov.gridResM(grid) > dem.nominalResM * 1.25) {
            warnings.push(M('info.coarsePrediction', { res: Math.round(prov.gridResM(grid)), native: dem.nominalResM },
                'Large prediction window: scored at about ' + Math.round(prov.gridResM(grid)) +
                ' m cells instead of the ' + dem.nominalResM + ' m DEM resolution to keep the heatmap responsive.'));
        }
        return grid;
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
                    var grid = predictionGridFor(bbox, dem, warnings);
                    progress('prog.downloadDem', 15, { label: dem.label });
                    // The DEM raster, the water geometry and the UAT protection mask are
                    // three independent network fetches — none needs another's result —
                    // so they run together instead of one after another. That is what
                    // keeps MANUAL/TRAIN from feeling like they "load forever": fetching
                    // them in sequence added their times instead of taking the longest.
                    var demP = prov.loadDemGrid(dem, grid, dem.tilePx || 1000);
                    var waterP = fetchWaterChain(params.centre, bbox, params.token, warnings, waterOptions(params));
                    var exclusionP = startExclusionMask(grid, params.centre.lat, params.centre.lon, radiusM, params);
                    return Promise.all([demP, waterP, exclusionP]).then(function (r) {
                        var elev = r[0], wr = r[1], exclusionResult = r[2];
                        checkToken(params.token);
                        progress('prog.terrain', 60);
                        var masks = rasteriseWater(wr.water, grid);
                        if (session.worker) session.worker.terminate();
                        session.worker = createWorkerClient(params.workerUrl);
                        session.analysisKey = null;
                        return setPredictionAnalysis(session, {
                            grid: grid, elev: elev, smooth: !!params.smoothDem, nodata: undefined,
                            circle: { lat: params.centre.lat, lon: params.centre.lon, radiusM: radiusM },
                            waterMasks: masks, altRef: null, soilRef: null, _exclusionResult: exclusionResult
                        }, params, warnings).then(function (res) {
                            session.analysisKey = session.exclusionStats.unknown ? null : key;
                            session.provenance = provenanceFor(dem, grid, wr.water, wr.provider, pick.decision);
                            session.stats = res.stats;
                            session.waterClasses = Object.keys(masks);
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
                smoothIters: 1,
                forReport: !!params.forReport
            }).then(function (res) {
                requireScores(res);
                progress('prog.done', 100);
                return {
                    geojson: res.geojson,
                    heatmap: res.heatmap,
                    reportRaster: res.reportRaster || null,
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
    function sampleBackground(centre, radiusM, count, siteList, excludeM, rnd, allowed) {
        rnd = rnd || Math.random;
        var out = [], tries = 0, mpd = core.metresPerDegree(centre.lat);
        var maxTries = count * 20;
        while (out.length < count && tries < maxTries) {
            tries++;
            var r = radiusM * Math.sqrt(rnd()), th = rnd() * 2 * Math.PI;
            var x = r * Math.cos(th), y = r * Math.sin(th);
            var lat = centre.lat + y / mpd.lat, lon = centre.lon + x / mpd.lon;
            var ok = !allowed || allowed(lat, lon);
            for (var s = 0; ok && s < siteList.length; s++) {
                if (core.haversineM(lat, lon, siteList[s].lat, siteList[s].lon) < excludeM) { ok = false; break; }
            }
            if (ok) out.push({ lat: lat, lon: lon, x: x, y: y });
        }
        return out;
    }

    function pointInRing(lon, lat, ring) {
        var inside = false;
        for (var i=0,j=ring.length-1;i<ring.length;j=i++) {
            var a=ring[i],b=ring[j];
            if (((a[1]>lat)!==(b[1]>lat)) && lon < (b[0]-a[0])*(lat-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
        }
        return inside;
    }
    function polygonAreaM2(rings, atLat) {
        if (!rings || !rings.length || !rings[0].length) return 0;
        var sx=111320*Math.cos((atLat||0)*Math.PI/180), sy=110574, ring=rings[0],sum=0;
        for(var i=0;i<ring.length;i++){var a=ring[i],b=ring[(i+1)%ring.length];sum+=(a[0]*sx)*(b[1]*sy)-(b[0]*sx)*(a[1]*sy);}
        return Math.abs(sum/2);
    }
    function waterReason(lon,lat,water,cfg) {
        for(var i=0;i<(water.polygons||[]).length;i++){
            var p=water.polygons[i],rings=p.rings||[],label=String(p.name||'')+' '+String(p.type||'')+' '+String(p.water||'');
            var explicitlyWater=/water|lake|sea|ocean/i.test(label);
            if(!explicitlyWater&&polygonAreaM2(rings,lat)<cfg.waterPolygonMinAreaM2)continue;
            if(!rings.length||!pointInRing(lon,lat,rings[0]))continue;
            var inHole=false;for(var h=1;h<rings.length;h++)if(pointInRing(lon,lat,rings[h])){inHole=true;break;}
            if(inHole)continue;
            var marine=/sea|ocean|marine/i.test(String(p.name||p.type||p.water||''));
            return marine?'sea':'large-water-polygon';
        }
        return null;
    }
    function filterTrainingSites(pts, water, grid, cfg) {
        cfg=Object.assign({},TRAIN_ROBUST_CONFIG,cfg||{});
        var seen=Object.create(null),kept=[],excluded={sea:0,largeWaterPolygon:0,outsideDem:0,noData:0,duplicate:0},details=[];
        (pts||[]).forEach(function(p){
            if(!p.isSite){kept.push(p);return;}
            var reason=null,cell=raster.cellOf(grid,p.lon,p.lat);
            if(cell<0)reason='outside-dem';
            else {
                var wr=waterReason(p.lon,p.lat,water||{},cfg);
                if(wr)reason=wr;
                else if(!p.valid)reason='no-data';
                else {var key=Number(p.lat).toFixed(8)+','+Number(p.lon).toFixed(8)+'|'+String(p.name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();if(seen[key])reason='duplicate';else seen[key]=true;}
            }
            if(!reason){kept.push(p);return;}
            var k=reason==='outside-dem'?'outsideDem':reason==='no-data'?'noData':reason==='large-water-polygon'?'largeWaterPolygon':reason;
            excluded[k]++;details.push({id:p.id||null,lat:p.lat,lon:p.lon,reason:reason});
        });
        return {points:kept,excluded:excluded,details:details,total:Object.keys(excluded).reduce(function(a,k){return a+excluded[k];},0)};
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
        return { S: S, samples: keep, altRef: altRef, soilRef: soilRef, waterClasses: waterClasses.slice(), counts: { sites: sitesN, background: n - sitesN } };
    }

    /* ── TRAIN ─────────────────────────────────────────────────────────────── */
    /**
     * Settlement pool for a centre: filters positions and types, retaining individual occupation phases.
     * Returns { pool, periods, dropped } — periods are offered to the user.
     */
    function sitePool(records, centre) {
        var pool = sites.filterSites(records, { center: centre, radiusKm: TRAIN_AREA_KM, period: null, dedupeM: records._meta && !records._meta.outsideRomania ? -1 : 50 });
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

    function mapTilesConcurrent(keys, concurrency, fn) {
        var len = keys.length;
        if (!len) return Promise.resolve();
        var limit = Math.max(1, Math.min(concurrency || 1, len));
        var next = 0;
        function worker() {
            if (next >= len) return Promise.resolve();
            var k = keys[next++];
            return Promise.resolve().then(function () { return fn(k); }).then(worker);
        }
        var runners = [];
        for (var i = 0; i < limit; i++) runners.push(worker());
        return Promise.all(runners).then(function () { return undefined; });
    }

    function siteCoordKey(lat, lon) {
        return Number(lat).toFixed(7) + ',' + Number(lon).toFixed(7);
    }

    /**
     * params: { centre, records, period:{key,label,start,end}|null, radiusKm, curves?, waterClasses,
     *           bgCount=5000, minSlopeDeg, smoothDem, thresholds? , minAreaM2, minSites=10, warnSites=30,
     *           onProgress, token, workerUrl, rnd, forReport }
     */
    function runTrain(session, params) {
        var warnings = [];
        var progress = params.onProgress || function () {};
        var centre = params.centre;
        var siteMeta = params.records && params.records._meta;
        if (siteMeta && siteMeta.areaCrossesBorder) warnings.push(M('warn.romaniaBorder', {}, 'The 50 km training area crosses Romania’s border; background samples are restricted to Romania and sites outside the dataset are unavailable.'));
        if (siteMeta && siteMeta.truncated) warnings.push(M('train.truncated', {}, 'The server returned a truncated site subset.'));
        if (siteMeta && siteMeta.includeEmptyCoord) warnings.push(M('train.emptyIncluded', {}, 'Unknown-position records are opted in.'));
        var radiusM = params.radiusKm * 1000;
        var areaM = TRAIN_AREA_KM * 1000;
        var sel = sites.filterSites(params.records, { center: centre, radiusKm: TRAIN_AREA_KM, period: params.period, dedupeM: -1 });
        var nSites = sel.sites.length;
        var minSites = params.minSites || 10, warnSites = params.warnSites || 30;
        if (trainSiteStatus(nSites, minSites, warnSites).status === 'block') {
            var err = core.keyedError('err.tooFewSites', { n: nSites, min: minSites },
                'Only ' + nSites + ' usable known sites for this period (minimum ' + minSites + ').');
            err.code = 'too_few_sites';
            return Promise.reject(err);
        }
        if (nSites < warnSites) warnings.push(M('warn.fewSites', { n: nSites, rec: warnSites }, 'Only ' + nSites + ' sites.'));

        var canUseSessionCache = !params.rnd;
        var envKey = [
            centre.lat.toFixed(5), centre.lon.toFixed(5),
            params.records ? params.records.length : 0,
            params.bgCount || 5000,
            params.smoothDem ? 's' : 'r',
            params.includeDrainage ? 'd' : '-',
            (params.waterClasses || []).indexOf('artificial') >= 0 ? 'a' : '-',
            JSON.stringify(params.strahlerMap || null)
        ].join('|');
        var modelKey = [
            envKey,
            params.period ? params.period.key : '__all__',
            params.minSlopeDeg == null ? 0.5 : params.minSlopeDeg,
            (params.waterClasses || []).slice().sort().join(','),
            params.forReport ? 'rep' : 'ui'
        ].join('|');

        var mpd = core.metresPerDegree(centre.lat);
        var bbox = core.circleBBox(centre.lat, centre.lon, areaM + 1000);

        function ensureWorker() {
            if (!session.worker) {
                session.worker = createWorkerClient(params.workerUrl);
                session.analysisKey = null;
                session._predWindowKey = null;
                session._waterKey = null;
            }
            return session.worker;
        }

        function samplePointsOnGrid(pts, dem, grid) {
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
            var spacing = raster.gridSpacingM(grid);
            var pad = Math.max(1, Math.ceil(TRAIN_ROBUST_CONFIG.positionRadiusM / Math.min(spacing.dx, spacing.dy)));
            progress('prog.sampling', 15, { pct: 0 });
            return mapTilesConcurrent(keys, 4, function (key) {
                checkToken(params.token);
                var parts = key.split(',').map(Number);
                var j0 = parts[0] * tilePx, i0 = parts[1] * tilePx;
                var cw = Math.min(grid.w - i0, tilePx), ch = Math.min(grid.h - j0, tilePx);
                var hg = prov.subGrid(grid, i0 - pad, j0 - pad, cw + 2 * pad, ch + 2 * pad);
                return dem.fetchBlock(hg).then(function (elev) {
                    checkToken(params.token);
                    var idxs = tileOf.get(key);
                    var flat = new Float64Array(idxs.length * 2), siteMask = new Uint8Array(idxs.length);
                    idxs.forEach(function (pi, k) {
                        flat[2 * k] = pts[pi].lon;
                        flat[2 * k + 1] = pts[pi].lat;
                        siteMask[k] = pts[pi].isSite ? 1 : 0;
                    });
                    return session.worker.call('sampleTile', {
                        elev: elev, w: hg.w, h: hg.h, dxM: spacing.dx, dyM: spacing.dy,
                        positionRadiusM: TRAIN_ROBUST_CONFIG.positionRadiusM, siteMask: siteMask,
                        tile: { west: hg.west, north: hg.north, dLon: hg.dLon, dLat: hg.dLat },
                        smooth: !!params.smoothDem, nodata: undefined, points: flat
                    }).then(function (r) {
                        idxs.forEach(function (pi, k) {
                            var o = k * 5;
                            var wmap = {};
                            r.classes.forEach(function (c) { wmap[c] = r.water[c][k]; });
                            results[pi] = {
                                elev: r.values[o], slope: r.values[o + 1], aspect: r.values[o + 2],
                                curv: r.values[o + 3], valid: r.inside[k] && r.values[o + 4] === 1, water: wmap
                            };
                        });
                        done += idxs.length;
                        progress('prog.sampling', 15 + Math.round(45 * done / pts.length), { pct: Math.round(100 * done / pts.length) });
                    });
                });
            }).then(function () { return results; });
        }

        function prepareEnvironment() {
            if (canUseSessionCache && session._trainEnvCache && session._trainEnvCache.key === envKey && session.worker) {
                var cachedEnv = session._trainEnvCache;
                cachedEnv.envWarnings.forEach(function (w) { warnings.push(w); });
                return Promise.resolve(cachedEnv);
            }
            ensureWorker();
            progress('prog.chooseDem', 5);
            var demWarnings = [], waterWarnings = [];
            var demP = pickDemProvider(centre, params.token, demWarnings);
            var waterP = fetchWaterChain(centre, bbox, params.token, waterWarnings, waterOptions(params));
            return Promise.all([demP, waterP]).then(function (pair) {
                checkToken(params.token);
                var pick = pair[0], wr = pair[1];
                var envWarnings = demWarnings.concat(waterWarnings);
                envWarnings.forEach(function (w) { warnings.push(w); });
                var dem = pick.provider;
                var grid = raster.boundedGridForBBox(bbox, dem.nominalResM, raster.MAX_SAMPLING_CELLS);
                var segs = waterSegments(wr.water);
                var classes = Object.keys(segs);
                return session.worker.call('setWater', { classes: segs }).then(function () {
                    session._waterKey = envKey;
                    // When session caching is enabled, sample all unique site coordinates in the 50 km
                    // pool + background points once so period switches reuse the sampled features instantly.
                    var poolSites = canUseSessionCache
                        ? sites.filterSites(params.records, { center: centre, radiusKm: TRAIN_AREA_KM, period: null, dedupeM: -1 }).sites
                        : sel.sites;
                    var uniqSiteCoords = [];
                    var seenCoords = Object.create(null);
                    poolSites.forEach(function (s) {
                        var ck = siteCoordKey(s.lat, s.lon);
                        if (seenCoords[ck]) return;
                        seenCoords[ck] = true;
                        uniqSiteCoords.push({
                            coordKey: ck, lat: s.lat, lon: s.lon,
                            x: (s.lon - centre.lon) * mpd.lon, y: (s.lat - centre.lat) * mpd.lat, isSite: true
                        });
                    });
                    var bg = sampleBackground(centre, areaM, params.bgCount || 5000,
                        canUseSessionCache ? poolSites : sel.sites, BG_EXCLUDE_M, params.rnd, params.backgroundAllowed);
                    var sampleTargets = uniqSiteCoords.concat(bg.map(function (b) {
                        return { lat: b.lat, lon: b.lon, x: b.x, y: b.y, isSite: false };
                    }));
                    return samplePointsOnGrid(sampleTargets, dem, grid).then(function (sampled) {
                        var byCoord = new Map();
                        for (var si = 0; si < uniqSiteCoords.length; si++) {
                            byCoord.set(uniqSiteCoords[si].coordKey, sampled[si] || { valid: false });
                        }
                        var bgSampled = [];
                        for (var bi = uniqSiteCoords.length; bi < sampleTargets.length; bi++) {
                            bgSampled.push(Object.assign({}, sampleTargets[bi], sampled[bi] || { valid: false }));
                        }
                        var envObj = {
                            key: envKey,
                            dem: dem,
                            demDecision: pick.decision,
                            grid: grid,
                            water: wr,
                            classes: classes,
                            byCoord: byCoord,
                            bgSampled: bgSampled,
                            envWarnings: envWarnings
                        };
                        if (canUseSessionCache) {
                            session._trainEnvCache = envObj;
                            session._trainedModelCache = new Map();
                        }
                        return envObj;
                    });
                });
            });
        }

        return prepareEnvironment().then(function (env) {
            checkToken(params.token);
            if (canUseSessionCache && session._trainedModelCache && session._trainedModelCache.has(modelKey)) {
                return { env: env, fit: session._trainedModelCache.get(modelKey) };
            }
            var mergedSites = sel.sites.map(function (s) {
                var r = env.byCoord.get(siteCoordKey(s.lat, s.lon)) || { valid: false };
                return Object.assign({
                    id: s.id, name: s.name, lat: s.lat, lon: s.lon,
                    x: (s.lon - centre.lon) * mpd.lon, y: (s.lat - centre.lat) * mpd.lat, isSite: true
                }, r);
            });
            var merged = mergedSites.concat(env.bgSampled);
            var hard = filterTrainingSites(merged, env.water.water, env.grid, TRAIN_ROBUST_CONFIG);
            var built = buildSampleSet(hard.points, {
                minSlopeDeg: params.minSlopeDeg, radiusM: areaM, folds: 5,
                waterClasses: params.waterClasses.filter(function (c) { return env.classes.indexOf(c) >= 0; })
            });
            if (built.counts.sites < minSites) {
                var e2 = core.keyedError('err.tooFewTerrain', { n: built.counts.sites, min: minSites },
                    'After terrain sampling only ' + built.counts.sites + ' sites had valid terrain (minimum ' + minSites + ').');
                e2.code = 'too_few_sites';
                throw e2;
            }
            progress('prog.train', 65);
            return session.worker.call('train', {
                S: built.S, waterClasses: built.waterClasses,
                minSlopeDeg: params.minSlopeDeg, folds: 5,
                robustConfig: TRAIN_ROBUST_CONFIG,
                skipDiagnosticCV: !!params.forReport
            }).then(function (tr) {
                var fitObj = { train: tr.result, built: built, hardExcluded: hard };
                if (canUseSessionCache && session._trainedModelCache) {
                    session._trainedModelCache.set(modelKey, fitObj);
                }
                return { env: env, fit: fitObj };
            });
        }).then(function (bundle) {
            checkToken(params.token);
            var env = bundle.env, t = bundle.fit;
            var predKey = envKey + '|r=' + params.radiusKm;
            if (canUseSessionCache && session._predWindowKey === predKey && session.worker &&
                session.exclusionStats && !session.exclusionStats.unknown) {
                if (session._predWarnings && session._predWarnings.length) {
                    session._predWarnings.forEach(function (w) { warnings.push(w); });
                }
                if (params.siteSource && session.provenance) session.provenance.sites = params.siteSource;
                return t;
            }
            progress('prog.window', 80);
            var wb = core.circleBBox(centre.lat, centre.lon, radiusM + BUFFER_M);
            var predWarnings = [];
            var wgrid = predictionGridFor(wb, env.dem, predWarnings);
            var demP = prov.loadDemGrid(env.dem, wgrid, env.dem.tilePx || 1000);
            var exclusionP = startExclusionMask(wgrid, centre.lat, centre.lon, radiusM, params);
            return Promise.all([demP, exclusionP]).then(function (r) {
                var elev = r[0], exclusionResult = r[1];
                var masks = rasteriseWater(env.water.water, wgrid);
                return setPredictionAnalysis(session, {
                    grid: wgrid, elev: elev, smooth: !!params.smoothDem, nodata: undefined,
                    circle: { lat: centre.lat, lon: centre.lon, radiusM: radiusM },
                    waterMasks: masks,
                    altRef: t.built.altRef, soilRef: t.built.soilRef, _exclusionResult: exclusionResult
                }, params, predWarnings).then(function (res) {
                    predWarnings.forEach(function (w) { warnings.push(w); });
                    session.analysisKey = null;
                    session._predWindowKey = (session.exclusionStats && session.exclusionStats.unknown) ? null : predKey;
                    session._predWarnings = predWarnings;
                    session.provenance = provenanceFor(env.dem, wgrid, env.water.water, env.water.provider, env.demDecision);
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
            if(tr.robust.skipped)warnings.push(M('warn.robustSkipped',{n:tr.robust.siteCount,min:TRAIN_ROBUST_CONFIG.minSites},'Robust fitting was skipped: too few sites.'));
            if(tr.robust.possibleSecondPattern.length)warnings.push(M('warn.secondPattern',{n:tr.robust.possibleSecondPattern.length},'A coherent alternate site pattern was preserved, not down-weighted.'));
            if(tr.robust.weightChange>=TRAIN_ROBUST_CONFIG.weightChangeWarning)warnings.push(M('warn.weightShift',{v:(100*tr.robust.weightChange).toFixed(0)},'Robust fitting materially changed the learned variable weights.'));
            var robustSites=tr.robust.flagged.map(function(x){var p=t.built.samples[x.index]||{};return {id:p.id||null,sampleIndex:x.index,lat:p.lat,lon:p.lon,weight:x.weight,reason:x.reason};});
            return session.worker.call('score', {
                mode: 'train', model: tr.model, waterClasses: t.built.waterClasses,
                thresholds: thr, minAreaM2: params.minAreaM2, smoothIters: 1,
                forReport: !!params.forReport
            }).then(function (res) {
                requireScores(res);
                progress('prog.done', 100);
                var periodCount = sel.sites.length;
                var output = {
                    mode: 'train',
                    geojson: res.geojson,
                    heatmap: res.heatmap,
                    reportRaster: res.reportRaster || null,
                    thresholds: res.thresholds,
                    areaKm2: res.areaKm2,
                    scoreStats: res.scoreStats,
                    provenance: session.provenance,
                    warnings: warnings.slice(),
                    diagnostics: {
                        siteData: siteMeta || null,
                        sitesUsed: t.built.counts.sites,
                        sitesInAreaBeforeExclusions: periodCount,
                        hardExcluded: t.hardExcluded.excluded,
                        hardExcludedTotal: t.hardExcluded.total,
                        positionMedianRadiusM: TRAIN_ROBUST_CONFIG.positionRadiusM,
                        hardExcludedDetails: t.hardExcluded.details,
                        downweightedSites: robustSites,
                        robustSkipped: tr.robust.skipped,
                        possibleSecondPattern: tr.robust.possibleSecondPattern.map(function(i){var p=t.built.samples[i]||{};return {id:p.id||null,lat:p.lat,lon:p.lon};}),
                        robustIterations: tr.robust.iterations,
                        weightChange: tr.robust.weightChange,
                        sitesInSample: t.built.counts.sites,
                        backgroundUsed: t.built.counts.background,
                        dropped: sel.dropped,
                        weights: tr.model.weights,
                        curves: tr.model.curves,
                        cv: tr.cv,
                        cvRobust: tr.cv,
                        cvPlain: tr.cvPlain,
                        soilSlopeR: tr.soilSlopeR,
                        excluded: tr.excluded,
                        variables: tr.variables,
                        confidence: tr.confidence,
                        thresholds: thr,
                        noSignal: tr.model.noSignal
                    }
                };
                session.trainCache = {
                    S: t.built.S,
                    built: t.built,
                    waterClasses: t.built.waterClasses,
                    minSlopeDeg: params.minSlopeDeg,
                    minAreaM2: params.minAreaM2,
                    robustConfig: TRAIN_ROBUST_CONFIG,
                    restoredIndices: [],
                    output: output
                };
                return output;
            });
        });
    }

    function rerunTrain(session, restoredIndices) {
        var cache=session&&session.trainCache;if(!cache||!cache.output||!session.worker) return Promise.reject(new Error('TRAIN cached samples are unavailable; run TRAIN again first.'));
        cache.restoredIndices=Array.from(new Set((restoredIndices||[]).map(Number)));
        var config=Object.assign({},cache.robustConfig,{restoredIndices:cache.restoredIndices});
        return session.worker.call('train',{S:cache.S,waterClasses:cache.waterClasses,minSlopeDeg:cache.minSlopeDeg,folds:5,robustConfig:config}).then(function(reply){
            var tr=reply.result;
            return session.worker.call('score',{mode:'train',model:tr.model,waterClasses:cache.waterClasses,thresholds:tr.thresholds,minAreaM2:cache.minAreaM2,smoothIters:1}).then(function(scored){
                requireScores(scored);
                var out=Object.assign({},cache.output),d=Object.assign({},out.diagnostics),robustSites=tr.robust.flagged.map(function(x){var p=cache.built.samples[x.index]||{};return {id:p.id||null,sampleIndex:x.index,lat:p.lat,lon:p.lon,weight:x.weight,reason:x.reason};});
                d.weights=tr.model.weights;d.curves=tr.model.curves;d.cv=tr.cv;d.cvRobust=tr.cv;d.cvPlain=tr.cvPlain;d.downweightedSites=robustSites;d.robustSkipped=tr.robust.skipped;d.possibleSecondPattern=tr.robust.possibleSecondPattern.map(function(i){var p=cache.built.samples[i]||{};return {id:p.id||null,sampleIndex:i,lat:p.lat,lon:p.lon};});d.robustIterations=tr.robust.iterations;d.weightChange=tr.robust.weightChange;d.thresholds=tr.thresholds;d.confidence=tr.confidence;
                out.geojson=scored.geojson;out.heatmap=scored.heatmap;out.thresholds=scored.thresholds;out.areaKm2=scored.areaKm2;out.scoreStats=scored.scoreStats;out.diagnostics=d;
                out.warnings=(out.warnings||[]).filter(function(w){return !w||!['warn.robustSkipped','warn.secondPattern','warn.weightShift'].includes(w.key);});
                if(tr.robust.skipped)out.warnings.push(core.msg('warn.robustSkipped',{n:tr.robust.siteCount,min:TRAIN_ROBUST_CONFIG.minSites},'Robust outlier handling was skipped.'));
                if(tr.robust.possibleSecondPattern.length)out.warnings.push(core.msg('warn.secondPattern',{n:tr.robust.possibleSecondPattern.length},'A possible second pattern was preserved.'));
                if(tr.robust.weightChange>=TRAIN_ROBUST_CONFIG.weightChangeWarning)out.warnings.push(core.msg('warn.weightShift',{v:(100*tr.robust.weightChange).toFixed(0)},'Robust fitting materially changed weights.'));
                cache.output=out;return out;
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
        filterTrainingSites: filterTrainingSites,
        trainRobustConfig: TRAIN_ROBUST_CONFIG,
        buildSampleSet: buildSampleSet,
        sitePool: sitePool,
        trainSiteStatus: trainSiteStatus,
        runManual: runManual,
        runTrain: runTrain,
        rerunTrain: rerunTrain,
        pickDemProvider: pickDemProvider,
        fetchWaterChain: fetchWaterChain,
        waterOptions: waterOptions
    };
});
