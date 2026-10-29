/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DetectLab — "Archeological Potential Sites" / "Zone cu potențial arheologic"
 * Premium map analysis layer.
 *
 * PURPOSE
 * ───────
 * This layer does NOT predict archaeological sites with AI. It identifies
 * candidate areas that *statistically* have a higher probability of containing
 * undiscovered sites, based purely on the spatial distribution of the already
 * known archaeological sites inside a working area.
 *
 * WORKFLOW (triggered by the "Detect / Detectează" button)
 * ────────
 *   1. Take the current map center.
 *   2. Build a search circle of `SEARCH_RADIUS_M` (default 10 km) around it.
 *   3. Load every known archaeological site intersecting that circle
 *      (from DetectLab's own API — layers 0/5/6, same source as the
 *      Patrimoniu layer) and the UAT "red" raster coverage.
 *   4. Run a Delaunay triangulation over the site coordinates.
 *   5. Generate candidate seeds near the centroids / interiors of the
 *      Delaunay triangles ("empty spaces surrounded by known sites").
 *   6. Apply the mandatory filters (see CONFIG / filters below).
 *   7. Score + classify every surviving candidate (Medium / High Potential).
 *   8. De-duplicate (spatial separation) and render 300 m purple circles.
 *
 * MANDATORY FILTERS (every candidate must pass ALL of them)
 * ─────────────────────────────────────────────────────────────
 *   A. UAT / "red zone" constraint  — the candidate must fall inside the
 *      UAT layer's red area. This app renders UAT as raster tiles on
 *      Cloudflare R2, so we read the tile pixel under the candidate:
 *      opaque pixel  → inside a UAT polygon ("red")  → keep
 *      transparent   → outside the red area          → discard
 *      tile missing / unreadable → we FAIL CLOSED (discard) — same policy
 *      the rest of the app uses for its UAT checks.
 *   B. Distance from existing sites — each known site has a protection
 *      radius (`SITE_RADIUS_M`, default 600 m, the same value the app's
 *      heritage circles use). A candidate must be at least
 *      `SITE_RADIUS_M + SITE_BUFFER_M` (600 + 100 m) away from every
 *      site's center. Polygon sites (layer 6) are covered by guard points
 *      placed along their perimeter every `POLYGON_GUARD_STEP_M` + their
 *      centroid, and candidates may not fall inside a site polygon at all.
 *   C. Search circle — candidates are only kept inside `SEARCH_RADIUS_M`.
 *   D. Candidate separation — after scoring, candidates closer than
 *      `CANDIDATE_MIN_SEPARATION_M` are merged (greedy keep-highest).
 *
 * SCORING (normalized 0..1, configurable weights)
 * ────────
 *   • nearby site count   (2 sites → low, 4 → medium, 6+ → high)
 *   • average distance to the K nearest sites (closer → higher)
 *   • Delaunay triangle quality + centroid proximity (well-formed triangles
 *     get extra weight, elongated slivers contribute less)
 *   • local site density (dense clusters → higher confidence)
 *
 * PERFORMANCE
 * ───────────
 *   • A lazy global grid index (lightweight R-tree-style culling) is built
 *     once over all loaded heritage features and cached.
 *   • UAT tile pixels are fetched through the app's existing per-tile
 *     promise cache (`window._uatGetTile`), so the 10 km area typically
 *     touches only a few hundred cached tile requests regardless of how
 *     many candidates are tested.
 *   • Analysis runs in async chunks, yielding to the UI between batches so
 *     the map stays responsive. A Web Worker is unnecessary here: the heavy
 *     parts are the (already async + cached) tile reads, and the geometry
 *     itself is O(n log n)-ish over a few hundred points.
 *
 * CONFIGURATION
 * ─────────────
 *   Everything is exposed via `window.ARCH_POTENTIAL_CONFIG` and can be
 *   tuned live from the browser console without a redeploy, e.g.:
 *       ARCH_POTENTIAL_CONFIG.CLASSIFY.SCORE_HIGH_FROM = 0.6;
 *       ARCH_POTENTIAL_CONFIG.SEARCH_RADIUS_M = 15000;
 *   Adding a new scoring criterion later = add a factor + a weight row in
 *   CONFIG.SCORING and merge it in `scoreCandidate()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
    'use strict';

    /* ═══════════════════════════════════════════════════════════════════════
     * 1. CONFIGURATION
     * ═══════════════════════════════════════════════════════════════════════ */
    var CONFIG = {
        // Working area -------------------------------------------------------
        SEARCH_RADIUS_M: 10000,      // pipeline default (also the report's radius)
        // The layer's own slider: 1–10 km around the purple pin (or around the
        // map centre when no pin has been dropped). SEARCH_RADIUS_M stays the
        // default for headless callers (js/archeo-report.js).
        RADIUS_KM_MIN: 1,
        RADIUS_KM_MAX: 10,
        RADIUS_KM_DEFAULT: 10,
        SITE_LAYERS: [0, 5, 6],      // DetectLab API layer ids used as "known sites"
                                     //   0 = RAN archaeological sites (points)
                                     //   5 = Tumuli (points)
                                     //   6 = RAN site boundaries (polygons)
        INCLUDE_APPROXIMATE_SITES: true,  // layer 0 sites with COORD !== 'DA' (locality-level precision)

        // Site protection radii (distance filter) ---------------------------
        SITE_RADIUS_M: 600,          // each known site's protection/search radius (matches app circles)
        SITE_BUFFER_M: 100,          // mandatory clearance OUTSIDE the radius: dist > radius + buffer
        POLYGON_GUARD_STEP_M: 400,   // guard-point spacing along polygon perimeters (like the app's circles)
        SITE_DEDUPE_M: 25,           // merge site points closer than this (avoid degenerate triangles)

        // Candidate generation ----------------------------------------------
        MIN_TRIANGLE_QUALITY: 0.12,  // skip Delaunay slivers below this quality (0..1)
        MIN_TRIANGLE_AREA_M2: 2500,  // skip triangles smaller than this (no room for a candidate)
        EXTRA_SAMPLES_MIN_RADIUS_M: 2000, // triangles with circumradius ≥ this get interior samples
        MAX_SAMPLES_PER_TRIANGLE: 5, // hard cap on candidate seeds per triangle

        // Candidate output (Delaunay-seed pipeline — window.computeArcheoPotential,
        // consumed by the Archeological Report; unchanged on purpose) ---------
        CANDIDATE_RADIUS_M: 300,     // rendered circle radius
        CANDIDATE_MIN_SEPARATION_M: 900, // suppress candidates closer than this (300 m circles won't overlap)
        MAX_CANDIDATES: 80,          // cap the final output for readability

        // UAT raster ("zona roșie" = teren liber, fără clădire actuală) -------
        // Citirea rasterului e singura parte cu adevărat nesigură a analizei
        // (rețea + CORS), iar vechea implementare avea două defecte care
        // produceau rezultatul „aleator" raportat:
        //   1. o celulă de 120–400 m era decisă de UN SINGUR PIXEL de ~9.5 m →
        //      la marginea intravilanului excluderea ieșea punctiform/întîmplător;
        //   2. tile lipsă (404) sau ilizibil (CORS) → FAIL CLOSED pe toată zona
        //      respectivă → „nu se generează nimic" deși zona e bună.
        // Acum: tile-urile se pre-încarcă (paralel, cu timeout + retry) înainte
        // de scorare, fiecare celulă se evaluează pe o rețea de puncte (fracția
        // de roșu), iar lipsa datelor nu mai golește harta.
        UAT: {
            SAMPLE_STEP_M: 50,            // distanța între punctele de probă dintr-o celulă
            MAX_SAMPLES_PER_AXIS: 8,      // plafon pe axă (8×8 = 64 de probe)
            MIN_RED_FRACTION: 0.5,        // celula rămâne scorable cât timp ≥ 50%
                                          // din probele citite sunt roșii (libere)
            ALPHA_THRESHOLD: 128,         // pragul de opacitate (ca în map-app.js)
            RED_IS_DARK: true,            // roșu pe hartă = pixel opac + întunecat
            LUMINANCE_THRESHOLD: 128,
            TILE_TIMEOUT_MS: 9000,        // o cerere blocată nu mai îngheață analiza
            RETRIES: 1,                   // încercări suplimentare (loader propriu)
            CONCURRENCY: 6,               // tile-uri descărcate simultan
            FAILURE_TTL_MS: 60000,        // un tile eșuat e reîncercat după acest timp
            FAIL_OPEN_WHEN_UNREADABLE: true, // fără date UAT → nu excludem nimic
            MAX_CACHED_TILES: 600         // măști „roșu" compacte (65 kB/tile), FIFO
        },

        // Score field --------------------------------------------------------
        // Both display modes read the SAME dense grid of scores covering the
        // whole search circle (no un-scored gaps):
        //   • bubbles — every scored cell is a candidate centre; circles are
        //     packed in several size tiers so the canvas gets as full as
        //     possible without any two bubbles touching each other, a heritage
        //     radius or the red UAT mask (see CONFIG.BUBBLE);
        //   • heat    — a true score raster over every scored cell (see
        //     CONFIG.HEAT), plus a red mask for the excluded areas (UAT built-up
        //     + heritage protection radii).
        // O singură grilă pentru ambele moduri: bulele au nevoie de centre dese
        // ca să umple golurile mici dintre ele, iar heatmap-ul are nevoie de
        // fiecare celulă. Comutarea Bule↔Heatmap redesenează același câmp.
        FIELD: {
            MODE: 'bubbles',              // 'bubbles' | 'heat' (UI: Bubbles / Heatmap)
            CELL_M: 120,                  // baseline cell spacing (both modes)
            MAX_CELLS: 9000,              // grows the cell size on big radii (phones)
            BUBBLE_CELL_M: 120,           // alias vechi (compatibilitate consolă)
            BUBBLE_MAX_CELLS: 9000,
            HEAT_CELL_M: 120,             // alias vechi (compatibilitate consolă)
            HEAT_MAX_CELLS: 9000,
            TRI_INDEX_CELL_M: 2500,       // triangle bucket size for point lookups
            OUTSIDE_HULL_TRI_SCORE: 0.15, // cells beyond the site convex hull
            PROGRESS_EVERY: 500,          // cells between status updates
            CHUNK_SIZE: 400               // cells per async batch
        },

        // Bubble output — „cât mai plin, fără suprapuneri" -------------------
        // Fiecare celulă scorată e un centru candidat. Bulele se pun în trepte
        // de mărime (cele mari întâi, apoi cele mici care completează golurile
        // rămase), iar o bulă e desenată doar când discul ei întreg încapă:
        //   • la ≥ gapFor(radius) de orice altă bulă (nu se ating/intercalează),
        //   • la ≥ MASK_CLEARANCE_M de masca roșie (raza de 700 m a siturilor,
        //     poligoanele de sit și dreptunghiurile de intravilan UAT),
        //   • integral în interiorul cercului de analiză,
        //   • cu scor ≥ MIN_SCORE (implicit 0 → toată zona e acoperită, iar
        //     culoarea bulei spune cât de bun e scorul — vezi HEAT_GRADIENT).
        // Numărul și dimensiunea scalează cu raza din slider.
        BUBBLE: {
            RADIUS_M: 420,            // bubble radius at the 10 km reference radius
            RADIUS_MIN_M: 150,        // preferred floor for a bubble radius
            RADIUS_FLOOR_M: 35,       // absolute floor (last tier, fills the holes)
            RADIUS_MAX_M: 520,
            GAP_M: 70,                // clear gap BETWEEN BUBBLES at 10 km
            GAP_MIN_M: 15,            // floor of the gap for the smallest bubbles
            MASK_CLEARANCE_M: 25,     // clear gap between a bubble and the red mask
            MIN_SCORE: 0,             // weak cells are drawn too (pale colour)
            TIERS: [1, 0.66, 0.44, 0.28], // size passes: big first, then gap filling
            TIER_FILL: 0.72,          // a bubble must be ≥ this fraction of its tier
            PER_KM2: 4.5,             // target bubble density per km² of the circle
            TYPICAL_RADIUS_FACTOR: 0.45, // raza „medie" folosită ca să calculăm
                                      // câte bule cere terenul liber real (la raze
                                      // mici bulele sunt mici, deci trebuie mai multe)
            MIN_BUBBLES: 26,          // floor of the cap for small radii
            MAX_BUBBLES: 1400,        // hard cap so phones stay responsive
            COVERAGE_TARGET: 0.82     // stop gap-filling once the free ground is
                                      // this covered (aria bulelor / aria liberă)
        },

        // Heatmap output ------------------------------------------------------
        // The heat surface is a raster of SCORES (not accumulated alpha), so a
        // colour always means the same thing: the score of that ground. The
        // mapping is ABSOLUTE (NORMALIZE: 'absolute') — the same score has the
        // same colour in every run, in the bubbles and in the legend, so the
        // legend is not a relative scale that changes per run.
        HEAT: {
            NORMALIZE: 'absolute',    // 'absolute' | 'percentile' (relativ la rulare)
            OPACITY: 0.82,            // whole-surface opacity over the basemap
            ALPHA_MIN: 0.52,          // alpha of the weakest cells
            ALPHA_MAX: 0.97,          // alpha of the strongest cells
            ALPHA_GAMMA: 0.6,         // alpha = MIN + (MAX-MIN)·t^GAMMA
            SMOOTH_SIGMA_CELLS: 1.0,  // gaussian smoothing, in grid cells
            LOW_PERCENTILE: 0.02,     // score window lower edge (percentile mode)
            HIGH_PERCENTILE: 0.98,    // score window upper edge (percentile mode)
            MIN_WINDOW: 0.12          // never compress the window below this span
        },

        // Rendering ----------------------------------------------------------
        PANE_Z_INDEX: 660,           // above heritage canvas (650) + markers (600), below popups (700)
        PANE_Z_HEAT: 656,            // heatmap canvas, under the bubbles
        PANE_Z_MASK: 658,            // red exclusion mask (UAT + heritage radii)
        PANE_Z_PIN: 662,             // purple analysis pin + its tooltip
        SHOW_WORKING_AREA: true,     // draw the search circle + center marker
        SHOW_TRIANGULATION: false,   // debug: draw the Delaunay triangles

        // Purple analysis pin (same anatomy as the report's blue pin) --------
        PIN: {
            COLOR: '#a070e8',
            FILL: '#c4a0f0',
            CIRCLE_IDLE: { color: '#c4a0f0', weight: 1.8, dashArray: '5 6', fill: true, fillColor: '#a070e8', fillOpacity: 0.05, opacity: 0.85 },
            CIRCLE_DRAG: { color: '#c4a0f0', weight: 2, dashArray: null, fill: false, fillColor: '#a070e8', fillOpacity: 0, opacity: 0.95 }
        },

        // Red exclusion mask -------------------------------------------------
        MASK: {
            COLOR: '#e03c3c',
            FILL: '#c0392b',
            FILL_OPACITY_UAT: 0.34,
            FILL_OPACITY_SITE: 0.20,
            OPACITY: 0.75
        },

        // Classification thresholds ------------------------------------------
        CLASSIFY: {
            SCORE_DISCARD_BELOW: 0.25,  // score < this  → discarded
            SCORE_HIGH_FROM: 0.55       // score >= this → High Potential; else Medium
        },

        // Scoring ------------------------------------------------------------
        SCORING: {
            // contribution 1: number of sites within NEARBY_RADIUS_M
            NEARBY_RADIUS_M: 1500,
            NEARBY_COUNT_REF: 6,        // 2 → 0.33 (low), 4 → 0.67 (medium), 6+ → 1.0 (high)
            // contribution 2: average distance to the K nearest sites
            K_NEAREST: 5,
            AVG_DIST_REFERENCE_M: 3000, // avg distance of this → 0 contribution; closer → higher
            // contribution 3: triangulation quality (computed per seed)
            // contribution 4: site density within DENSITY_RADIUS_M
            DENSITY_RADIUS_M: 3000,
            DENSITY_COUNT_REF: 8,
            // weights (must sum to 1)
            W_NEARBY: 0.30,
            W_AVG_DIST: 0.25,
            W_TRIANGLE: 0.25,
            W_DENSITY: 0.20
        },

        // Data source --------------------------------------------------------
        UAT_TILE_SIZE: 256,
        SITES_DATA_POLL_MS: 200,     // how often we wait for the site data to load
        SITES_DATA_TIMEOUT_MS: 20000 // give up waiting after this
    };

    // Allow live tuning from the console: window.ARCH_POTENTIAL_CONFIG.X = ...
    window.ARCH_POTENTIAL_CONFIG = CONFIG;

    /* ═══════════════════════════════════════════════════════════════════════
     * 2. MATH / GEO HELPERS
     * ═══════════════════════════════════════════════════════════════════════ */

    // Great-circle distance in meters (Haversine).
    function haversineM(aLat, aLng, bLat, bLng) {
        var R = 6371000;
        var dLat = (bLat - aLat) * Math.PI / 180;
        var dLng = (bLng - aLng) * Math.PI / 180;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }

    // Local Web Mercator-ish projection in meters, centered so that a 10 km
    // working area has negligible distortion. `lat0` is the map center latitude.
    function projectToLocalMeters(lat, lng, lat0) {
        var kLng = 111320 * Math.cos(lat0 * Math.PI / 180);
        var kLat = 111320;
        return { x: lng * kLng, y: lat * kLat };
    }

    function clamp01(v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /* ── Lightweight grid spatial index ────────────────────────────────────
     * A fixed-cell uniform grid used as an R-tree-style culling structure.
     * `cellSizeM` is in the same units as the stored coordinates (meters for
     * local grids, or equirectangular degrees for the global site cache).
     * Insert is O(1); circle queries visit only the cells overlapped by the
     * query circle, then apply an exact distance test. */
    function createGridIndex(cellSizeX, cellSizeY) {
        var cells = {}; // key "cx,cy" -> [items]
        return {
            cellSizeX: cellSizeX,
            cellSizeY: cellSizeY,
            insert: function (x, y, item) {
                var cx = Math.floor(x / cellSizeX);
                var cy = Math.floor(y / cellSizeY);
                var key = cx + ',' + cy;
                if (!cells[key]) cells[key] = [];
                cells[key].push(item);
            },
            // Return every item whose cell intersects the circle (x,y,r).
            // The caller still must verify exact distance; the grid only culls.
            queryCircle: function (x, y, r) {
                var out = [];
                var minCx = Math.floor((x - r) / cellSizeX);
                var maxCx = Math.floor((x + r) / cellSizeX);
                var minCy = Math.floor((y - r) / cellSizeY);
                var maxCy = Math.floor((y + r) / cellSizeY);
                for (var cx = minCx; cx <= maxCx; cx++) {
                    for (var cy = minCy; cy <= maxCy; cy++) {
                        var bucket = cells[cx + ',' + cy];
                        if (bucket) {
                            for (var i = 0; i < bucket.length; i++) out.push(bucket[i]);
                        }
                    }
                }
                return out;
            }
        };
    }

    // Ray-casting point-in-polygon (planar). `poly` = array of {x,y}.
    function pointInPolygon(px, py, poly) {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var xi = poly[i].x, yi = poly[i].y;
            var xj = poly[j].x, yj = poly[j].y;
            if (((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 3. SITE DATA — LOADING + GLOBAL SPATIAL CACHE
     * ═══════════════════════════════════════════════════════════════════════
     * The full heritage FeatureCollections are already fetched by map-app.js
     * into window._localLayerData (layers 0/5/6). We cache a flat, precomputed
     * point list + polygon list in a global grid index, built lazily ONCE,
     * then query the 10 km circle per analysis run. */

    var _siteIndexCache = null; // { key, pointIndex, polygons }

    // Wait until the app's layer data has been fetched (it loads on page
    // load asynchronously). Resolves with the raw layer data object.
    function waitForSiteData() {
        return new Promise(function (resolve, reject) {
            var waited = 0;
            var poll = function () {
                var data = window._localLayerData;
                if (data && data[0] !== undefined && data[0] !== null) {
                    return resolve(data);
                }
                waited += CONFIG.SITES_DATA_POLL_MS;
                if (waited >= CONFIG.SITES_DATA_TIMEOUT_MS) {
                    return resolve(data || {});
                }
                setTimeout(poll, CONFIG.SITES_DATA_POLL_MS);
            };
            poll();
        });
    }

    // Build (once) the global spatial cache over all heritage features.
    // Returns { pointIndex, polygons }.
    //
    // pointIndex is a global grid in *equirectangular degrees-ish* units so
    // that it covers all of Romania with a single built structure. The grid
    // is only a culling structure — exact distances are recomputed in local
    // meters per analysis run.
    function buildGlobalSiteIndex(data) {
        var key = CONFIG.SITE_LAYERS.join(',') + '|' + (CONFIG.INCLUDE_APPROXIMATE_SITES ? 1 : 0);
        // Rebuild when the config changes OR when the underlying layer data
        // object is replaced (e.g. a future refresh of window._localLayerData).
        if (_siteIndexCache && _siteIndexCache.key === key && _siteIndexCache.dataRef === data) {
            return _siteIndexCache;
        }

        var DEG_CELL = 0.02; // ~2.2 km cell at lat 45°
        var pointIndex = createGridIndex(DEG_CELL, DEG_CELL);
        var polygons = [];

        CONFIG.SITE_LAYERS.forEach(function (lid) {
            var fc = data[lid];
            if (!fc || !fc.features) return;
            fc.features.forEach(function (f) {
                if (!f.geometry) return;
                var props = f.properties || {};

                if (lid === 0 && !CONFIG.INCLUDE_APPROXIMATE_SITES && props.COORD !== 'DA') return;

                if (f.geometry.type === 'Point') {
                    var c = f.geometry.coordinates;
                    pointIndex.insert(c[0], c[1], {
                        lat: c[1], lng: c[0], layerId: lid, oid: f.id, props: props
                    });
                } else if (f.geometry.type === 'Polygon') {
                    // coordinates = array of rings
                    polygons.push(polygonRecord(lid, f.id, props, f.geometry.coordinates));
                } else if (f.geometry.type === 'MultiPolygon') {
                    // treat each member polygon as a separate site boundary
                    f.geometry.coordinates.forEach(function (polyCoords) {
                        polygons.push(polygonRecord(lid, f.id, props, polyCoords));
                    });
                }
            });
        });

        _siteIndexCache = { key: key, dataRef: data, pointIndex: pointIndex, polygons: polygons };
        return _siteIndexCache;
    }

    function polygonBbox(rings) {
        var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        rings.forEach(function (ring) {
            ring.forEach(function (p) {
                if (p[0] < minLng) minLng = p[0];
                if (p[0] > maxLng) maxLng = p[0];
                if (p[1] < minLat) minLat = p[1];
                if (p[1] > maxLat) maxLat = p[1];
            });
        });
        return { minLng: minLng, minLat: minLat, maxLng: maxLng, maxLat: maxLat };
    }

    function polygonRecord(layerId, oid, props, ringsArray) {
        var rings = ringsArray.map(function (ring) {
            return ring.map(function (pt) { return { lng: pt[0], lat: pt[1] }; });
        });
        return {
            layerId: layerId, oid: oid, props: props,
            rings: rings,
            bbox: polygonBbox(ringsArray)
        };
    }

    // Collect every site inside the search circle, projected into local meters.
    // Returns { sites: [{x,y,lat,lng,layerId,oid}], polygons: [{rings(local), bboxLocal}] }
    function collectSitesInRadius(centerLat, centerLng, radiusM, lat0) {
        var cache = buildGlobalSiteIndex(window._localLayerData || {});
        var c = projectToLocalMeters(centerLat, centerLng, lat0);
        var DEG_R = radiusM / 111320; // coarse degree radius for culling

        var sites = [];
        var seen = {}; // dedupe within ~SITE_DEDUPE_M

        var rawPoints = cache.pointIndex.queryCircle(centerLng, centerLat, DEG_R * 1.6);
        for (var i = 0; i < rawPoints.length; i++) {
            var p = rawPoints[i];
            var pm = projectToLocalMeters(p.lat, p.lng, lat0);
            var d = Math.sqrt((pm.x - c.x) * (pm.x - c.x) + (pm.y - c.y) * (pm.y - c.y));
            if (d > radiusM) continue;
            // dedupe: merge sites closer than SITE_DEDUPE_M (they would create
            // degenerate triangles); keep the first representative.
            var cell = Math.round(pm.x / CONFIG.SITE_DEDUPE_M) + '|' + Math.round(pm.y / CONFIG.SITE_DEDUPE_M);
            var merged = false;
            for (var k = 0; k < 9; k++) {
                var dx = (k % 3) - 1, dy = Math.floor(k / 3) - 1;
                var key = (Math.round(pm.x / CONFIG.SITE_DEDUPE_M) + dx) + '|' + (Math.round(pm.y / CONFIG.SITE_DEDUPE_M) + dy);
                if (seen[key]) { merged = true; break; }
            }
            if (merged) continue;
            seen[cell] = true;
            sites.push({ x: pm.x, y: pm.y, lat: p.lat, lng: p.lng, layerId: p.layerId, oid: p.oid, props: p.props });
        }

        // Polygons intersecting the circle → guard points + local geometry.
        var polygons = [];
        for (var pi = 0; pi < cache.polygons.length; pi++) {
            var poly = cache.polygons[pi];
            var b = poly.bbox;
            if (b.maxLng < centerLng - DEG_R || b.minLng > centerLng + DEG_R ||
                b.maxLat < centerLat - DEG_R || b.minLat > centerLat + DEG_R) continue;

            var localRings = poly.rings.map(function (ring) {
                return ring.map(function (pt) {
                    var m = projectToLocalMeters(pt.lat, pt.lng, lat0);
                    return { x: m.x, y: m.y };
                });
            });

            // centroid (area-weighted on the outer ring)
            var outer = localRings[0];
            var area2 = 0, cx = 0, cy = 0;
            for (var vi = 0; vi < outer.length - 1; vi++) {
                var cross = outer[vi].x * outer[vi + 1].y - outer[vi + 1].x * outer[vi].y;
                area2 += cross;
                cx += (outer[vi].x + outer[vi + 1].x) * cross;
                cy += (outer[vi].y + outer[vi + 1].y) * cross;
            }
            if (area2 !== 0) { cx /= 3 * area2; cy /= 3 * area2; } else { cx = outer[0].x; cy = outer[0].y; }

            // guard points along the perimeter (matches the app's 600 m circle
            // approach for polygons) + the centroid
            var guards = [{ x: cx, y: cy }];
            localRings.forEach(function (ring) {
                for (var j = 0; j < ring.length - 1; j++) {
                    var a = ring[j], b = ring[j + 1];
                    var len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
                    var steps = Math.max(1, Math.ceil(len / CONFIG.POLYGON_GUARD_STEP_M));
                    for (var s = 0; s < steps; s++) {
                        guards.push({
                            x: a.x + (b.x - a.x) * s / steps,
                            y: a.y + (b.y - a.y) * s / steps
                        });
                    }
                }
            });

            var hasGuardInside = false;
            for (var g = 0; g < guards.length; g++) {
                var gd = Math.sqrt((guards[g].x - c.x) * (guards[g].x - c.x) + (guards[g].y - c.y) * (guards[g].y - c.y));
                if (gd <= radiusM) {
                    hasGuardInside = true;
                    // dedupe guard points too (dense polygons would flood the list)
                    var gkey = Math.round(guards[g].x / CONFIG.SITE_DEDUPE_M) + '|' + Math.round(guards[g].y / CONFIG.SITE_DEDUPE_M);
                    if (!seen[gkey]) {
                        seen[gkey] = true;
                        var ll = localMetersToLatLng(guards[g].x, guards[g].y, lat0);
                        sites.push({ x: guards[g].x, y: guards[g].y, lat: ll.lat, lng: ll.lng, layerId: poly.layerId, oid: poly.oid, props: poly.props, isGuard: true });
                    }
                }
            }
            if (hasGuardInside) polygons.push({ rings: localRings, layerId: poly.layerId, oid: poly.oid });
        }

        return { sites: sites, polygons: polygons };
    }

    function localMetersToLatLng(x, y, lat0) {
        var kLng = 111320 * Math.cos(lat0 * Math.PI / 180);
        return { lat: y / 111320, lng: x / kLng };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 4. DELAUNAY TRIANGULATION (Bowyer–Watson)
     * ═══════════════════════════════════════════════════════════════════════
     * Input:  array of points {x, y} in local meters (with a stable `i` index).
     * Output: array of triangles [{a, b, c}] referencing the input points
     *         (super-triangle vertices are stripped).
     * Complexity: expected O(n log n) for reasonably distributed sites. */

    function circumcircle(t) {
        var d = 2 * (t.a.x * (t.b.y - t.c.y) + t.b.x * (t.c.y - t.a.y) + t.c.x * (t.a.y - t.b.y));
        if (Math.abs(d) < 1e-9) return null; // collinear / degenerate
        var a2 = t.a.x * t.a.x + t.a.y * t.a.y;
        var b2 = t.b.x * t.b.x + t.b.y * t.b.y;
        var c2 = t.c.x * t.c.x + t.c.y * t.c.y;
        var ux = (a2 * (t.b.y - t.c.y) + b2 * (t.c.y - t.a.y) + c2 * (t.a.y - t.b.y)) / d;
        var uy = (a2 * (t.c.x - t.b.x) + b2 * (t.a.x - t.c.x) + c2 * (t.b.x - t.a.x)) / d;
        return {
            cx: ux, cy: uy,
            r: Math.sqrt((ux - t.a.x) * (ux - t.a.x) + (uy - t.a.y) * (uy - t.a.y))
        };
    }

    function circumcircleContains(t, p) {
        var cc = circumcircle(t);
        if (!cc) return false;
        var ddx = p.x - cc.cx, ddy = p.y - cc.cy;
        return (ddx * ddx + ddy * ddy) < cc.r * cc.r;
    }

    function delaunayTriangulation(points) {
        var n = points.length;
        if (n < 3) return [];

        // Normalize: every input point needs a stable index for edge dedup.
        for (var ni = 0; ni < n; ni++) {
            if (points[ni].i === undefined) points[ni].i = ni;
        }

        // super-triangle covering the whole point set
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < n; i++) {
            if (points[i].x < minX) minX = points[i].x;
            if (points[i].x > maxX) maxX = points[i].x;
            if (points[i].y < minY) minY = points[i].y;
            if (points[i].y > maxY) maxY = points[i].y;
        }
        var dx = (maxX - minX) || 1, dy = (maxY - minY) || 1;
        var dmax = Math.max(dx, dy);
        var midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
        var superVerts = [
            { x: midX - 20 * dmax, y: midY - dmax, i: -1, isSuper: true },
            { x: midX, y: midY + 20 * dmax, i: -2, isSuper: true },
            { x: midX + 20 * dmax, y: midY - dmax, i: -3, isSuper: true }
        ];

        var triangles = [{ a: superVerts[0], b: superVerts[1], c: superVerts[2] }];

        for (var pi = 0; pi < n; pi++) {
            var p = points[pi];
            var bad = [];
            var edgeCount = {}; // key "minI|maxI" -> count

            function addEdge(u, v) {
                var key = (u.i < v.i ? u.i + '|' + v.i : v.i + '|' + u.i);
                edgeCount[key] = (edgeCount[key] || 0) + 1;
            }

            for (var ti = 0; ti < triangles.length; ti++) {
                var t = triangles[ti];
                if (circumcircleContains(t, p)) {
                    bad.push(t);
                    addEdge(t.a, t.b);
                    addEdge(t.b, t.c);
                    addEdge(t.c, t.a);
                }
            }

            if (bad.length === 0) continue;

            // cavity boundary = edges that appear exactly once
            var boundary = [];
            for (var key in edgeCount) {
                if (edgeCount[key] === 1) {
                    var parts = key.split('|');
                    boundary.push({ u: +parts[0], v: +parts[1] });
                }
            }

            // map vertex index -> vertex object (bad triangles are the only source)
            var verts = {};
            bad.forEach(function (bt) {
                verts[bt.a.i] = bt.a; verts[bt.b.i] = bt.b; verts[bt.c.i] = bt.c;
            });

            triangles = triangles.filter(function (t) { return bad.indexOf(t) === -1; });
            for (var e = 0; e < boundary.length; e++) {
                triangles.push({
                    a: verts[boundary[e].u],
                    b: verts[boundary[e].v],
                    c: p
                });
            }
        }

        // strip super-triangle vertices + degenerate slivers
        var out = [];
        for (var k = 0; k < triangles.length; k++) {
            var tr = triangles[k];
            if (tr.a.isSuper || tr.b.isSuper || tr.c.isSuper) continue;
            var area = Math.abs(
                (tr.b.x - tr.a.x) * (tr.c.y - tr.a.y) - (tr.c.x - tr.a.x) * (tr.b.y - tr.a.y)
            ) / 2;
            if (!isFinite(area) || area < CONFIG.MIN_TRIANGLE_AREA_M2) continue;
            out.push(tr);
        }
        return out;
    }

    // Triangle quality in [0,1]: 1 for equilateral, → 0 for slivers.
    // q = 16·area² / (perimeter · a·b·c)  (ratio of inradius/circumradius × 2)
    function triangleQuality(t) {
        var a = Math.sqrt((t.b.x - t.c.x) * (t.b.x - t.c.x) + (t.b.y - t.c.y) * (t.b.y - t.c.y));
        var b = Math.sqrt((t.a.x - t.c.x) * (t.a.x - t.c.x) + (t.a.y - t.c.y) * (t.a.y - t.c.y));
        var c = Math.sqrt((t.a.x - t.b.x) * (t.a.x - t.b.x) + (t.a.y - t.b.y) * (t.a.y - t.b.y));
        var s = (a + b + c) / 2;
        var area2 = s * (s - a) * (s - b) * (s - c);
        var area = area2 > 0 ? Math.sqrt(area2) : 0;
        var q = (16 * area * area) / ((a + b + c) * a * b * c);
        if (!isFinite(q) || isNaN(q)) return 0;
        return clamp01(q);
    }

    function triangleCentroid(t) {
        return { x: (t.a.x + t.b.x + t.c.x) / 3, y: (t.a.y + t.b.y + t.c.y) / 3 };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 5. CANDIDATE SEEDS FROM TRIANGLES
     * ═══════════════════════════════════════════════════════════════════════
     * Each seed = an interior point of a Delaunay triangle plus metadata used
     * by the scoring step (triangle quality, distance to centroid). */

    var BARYCENTRIC_EXTRA = [
        [0.55, 0.225, 0.225],
        [0.225, 0.55, 0.225],
        [0.225, 0.225, 0.55],
        [0.334, 0.333, 0.333]
    ];

    function sampleTriangles(triangles, lat0) {
        var seeds = [];
        for (var i = 0; i < triangles.length; i++) {
            var t = triangles[i];
            var q = triangleQuality(t);
            if (q < CONFIG.MIN_TRIANGLE_QUALITY) continue;

            var cc = circumcircle(t);
            var circR = cc ? cc.r : 0;
            var cent = triangleCentroid(t);

            var samples = [{ w: [1 / 3, 1 / 3, 1 / 3] }]; // centroid first
            if (circR >= CONFIG.EXTRA_SAMPLES_MIN_RADIUS_M) {
                for (var b = 0; b < BARYCENTRIC_EXTRA.length; b++) samples.push({ w: BARYCENTRIC_EXTRA[b] });
            }
            if (samples.length > CONFIG.MAX_SAMPLES_PER_TRIANGLE) {
                samples.length = CONFIG.MAX_SAMPLES_PER_TRIANGLE;
            }

            for (var s = 0; s < samples.length; s++) {
                var w = samples[s].w;
                var px = t.a.x * w[0] + t.b.x * w[1] + t.c.x * w[2];
                var py = t.a.y * w[0] + t.b.y * w[1] + t.c.y * w[2];
                var dCentroid = Math.sqrt((px - cent.x) * (px - cent.x) + (py - cent.y) * (py - cent.y));
                var centroidBonus = circR > 0 ? clamp01(1 - dCentroid / circR) : 1;
                var ll = localMetersToLatLng(px, py, lat0);

                seeds.push({
                    x: px, y: py,
                    lat: ll.lat, lng: ll.lng,
                    triQuality: q,
                    circumRadius: circR,
                    centroidDistM: dCentroid,
                    triScore: q * (0.5 + 0.5 * centroidBonus)
                });
            }
        }
        return seeds;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 6. UAT "RED ZONE" CHECK (raster pixels, pre-încărcat + deterministic)
     * ═══════════════════════════════════════════════════════════════════════
     * CONVENȚIA (identică cu map-app.js): pe stratul UAT, pixelii OPCI și
     * ÎNTUNECAȚI sunt cei desenați ROȘU și înseamnă teren FĂRĂ clădire actuală
     * (adică acolo unde are sens să căutăm situri). Pixelii TRANSPARENȚI sunt
     * intravilanul / zona construită — acolo nu se generează nimic, iar masca
     * stratului o desenează tot cu roșu (roșu = „exclus" în ambele moduri).
     *
     * DE CE NU MAI E „ALEATOR":
     *   1. Tile-urile necesare unei rulări se descarcă ÎNAINTE de scorare
     *      (paralel, cu timeout și o reîncercare printr-un loader propriu, ca
     *      un 404/CORS tranzitoriu să nu mai decidă soarta întregii analize);
     *   2. pixelii se citesc sincron din cache-ul rulării → aceeași zonă dă
     *      întotdeauna același rezultat (fără promisiuni care se întrec);
     *   3. o celulă nu mai e decisă de un singur pixel de ~9.5 m, ci de o
     *      rețea de probe peste toată cutia ei (fracția de roșu);
     *   4. când rasterul chiar nu poate fi citit (offline, CORS, fără acoperire)
     *      nu mai excludem tot — marcăm zona ca „necunoscută" și o scorăm, cu
     *      mesaj explicit în status. Altfel harta rămânea goală exact în zonele
     *      bune, fără nicio explicație. */

    var UAT_UNREADABLE = window._UAT_TILE_UNREADABLE;
    // Același URL ca în map-app.js (tile-uri PNG pe Cloudflare R2, schema TMS).
    var UAT_TILE_URL_FALLBACK = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/UAT/{z}/{x}/{y}.png';

    // Cache global de tile-uri decodate: "z/x/y" → { state, mask, size, at }.
    // state: 'ok' | 'missing' | 'unreadable' | 'timeout'. Eșecurile expiră după
    // FAILURE_TTL_MS ca o pană de rețea să nu rămână blocată pentru toată
    // sesiunea; tile-urile citite rămân în cache definitiv.
    var _uatTileStates = {};
    var _uatTileOrder = [];   // ordinea FIFO pentru evacuare (cache mărginit)

    function uatTileZ() {
        return (window.UAT_TILE_Z !== undefined) ? window.UAT_TILE_Z : 14;
    }

    function uatCfg() { return CONFIG.UAT || {}; }

    function uatTileUrlTemplate() {
        if (typeof window.UAT_TILE_URL === 'string' && window.UAT_TILE_URL.indexOf('{z}') !== -1) {
            return window.UAT_TILE_URL;
        }
        var layer = window._uatLayer;
        if (layer && typeof layer._url === 'string' && layer._url.indexOf('{z}') !== -1) return layer._url;
        return UAT_TILE_URL_FALLBACK;
    }

    function uatTileYForUrl(y, z) { return Math.pow(2, z) - 1 - y; }

    function uatTileUrl(z, x, y) {
        return uatTileUrlTemplate()
            .replace('{z}', z).replace('{x}', x).replace('{y}', uatTileYForUrl(y, z));
    }

    // Same math as map-app.js (UAT raster is generated with gdal2tiles, TMS
    // naming, XYZ pixel layout — only the row number in the URL is flipped).
    function uatLngToTileXF(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
    function uatLatToTileYF(lat, z) {
        var rad = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
    }

    function uatTileRange(minLat, minLng, maxLat, maxLng, z) {
        var max = Math.pow(2, z);
        var x0 = Math.max(0, Math.min(max - 1, Math.floor(uatLngToTileXF(minLng, z))));
        var x1 = Math.max(0, Math.min(max - 1, Math.floor(uatLngToTileXF(maxLng, z))));
        var y0 = Math.max(0, Math.min(max - 1, Math.floor(uatLatToTileYF(maxLat, z)))); // lat mare → y mic
        var y1 = Math.max(0, Math.min(max - 1, Math.floor(uatLatToTileYF(minLat, z))));
        var out = [];
        for (var x = x0; x <= x1; x++) {
            for (var y = y0; y <= y1; y++) out.push({ x: x, y: y });
        }
        return out;
    }

    // Un pixel e „roșu pe hartă" exact ca în map-app.js (_uatIsBuildingPixel):
    // opac + întunecat. Restul (transparent sau luminos) = intravilan/construit.
    function uatIsRedPixel(data, idx) {
        var U = uatCfg();
        var aThreshold = (typeof U.ALPHA_THRESHOLD === 'number') ? U.ALPHA_THRESHOLD : 128;
        if (data[idx + 3] <= aThreshold) return false;
        if (U.RED_IS_DARK === false) return true;
        var lumThreshold = (typeof U.LUMINANCE_THRESHOLD === 'number') ? U.LUMINANCE_THRESHOLD : 128;
        return ((data[idx] + data[idx + 1] + data[idx + 2]) / 3) < lumThreshold;
    }

    // Un tile RGBA are 256 kB; ne trebuie doar „e roșu sau nu" per pixel, adică
    // 64 kB (1 octet/pixel). La 150+ tile-uri pe o analiză de 10 km înseamnă
    // ~10 MB în loc de ~40 MB, iar mai multe rulări nu mai umflă memoria.
    function uatRedMaskFromData(data, size) {
        size = size || CONFIG.UAT_TILE_SIZE || 256;
        var mask = new Uint8Array(size * size);
        for (var i = 0, p = 0; i + 3 < data.length; i += 4, p++) {
            if (uatIsRedPixel(data, i)) mask[p] = 1;
        }
        return { mask: mask, size: size };
    }

    function uatCachePut(key, rec) {
        _uatTileStates[key] = rec;
        if (_uatTileOrder.indexOf(key) < 0) _uatTileOrder.push(key);
        var max = (typeof uatCfg().MAX_CACHED_TILES === 'number') ? uatCfg().MAX_CACHED_TILES : 600;
        while (_uatTileOrder.length > max) {
            var oldest = _uatTileOrder.shift();
            if (oldest === key) { _uatTileOrder.push(oldest); break; }
            delete _uatTileStates[oldest];   // va fi recitit la nevoie (ieftin)
        }
    }

    // Loader propriu (folosit la retry): nu depinde de cache-ul de promisiuni al
    // map-app.js, are timeout real și poate ocoli un răspuns HTTP cache-uit fără
    // header CORS (cache-buster). În Node (teste) nu există Image → 'missing'.
    function loadUatTileImage(z, x, y, attempt) {
        var U = uatCfg();
        var timeoutMs = (typeof U.TILE_TIMEOUT_MS === 'number') ? U.TILE_TIMEOUT_MS : 9000;
        var url = uatTileUrl(z, x, y);
        if (attempt > 0) url += (url.indexOf('?') === -1 ? '?' : '&') + '_dlArchRetry=' + attempt;
        return new Promise(function (resolve) {
            if (typeof Image === 'undefined') return resolve({ state: 'missing' });
            var img = new Image();
            var settled = false;
            var timer = setTimeout(function () { finish({ state: 'timeout' }); }, timeoutMs);
            function finish(state) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { img.onload = null; img.onerror = null; } catch (e) {}
                resolve(state);
            }
            try { img.crossOrigin = 'anonymous'; } catch (e) {}
            img.onload = function () {
                var w = img.width || CONFIG.UAT_TILE_SIZE || 256;
                var h = img.height || CONFIG.UAT_TILE_SIZE || 256;
                var canvas = createCanvasEl(w, h);
                var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
                if (!ctx || typeof ctx.getImageData !== 'function') return finish({ state: 'unreadable' });
                try {
                    ctx.drawImage(img, 0, 0);
                    var imgData = ctx.getImageData(0, 0, w, h);
                    finish({ state: 'ok', data: imgData.data, size: w });
                } catch (e) {
                    finish({ state: 'unreadable' }); // canvas „tainted" (CORS lipsă)
                }
            };
            img.onerror = function () { finish({ state: 'missing' }); };
            img.src = url;
        });
    }

    // Prima încercare folosește loaderul aplicației (are deja cache-ul lui și
    // logurile [UAT]); dacă răspunsul e incert/lipsă, reîncercăm singuri.
    function readUatTile(z, x, y, attempt) {
        var U = uatCfg();
        var timeoutMs = (typeof U.TILE_TIMEOUT_MS === 'number') ? U.TILE_TIMEOUT_MS : 9000;
        attempt = attempt || 0;

        if (attempt === 0 && typeof window._uatGetTile === 'function') {
            var timedOut = false;
            var timer = null;
            var timeout = new Promise(function (resolve) {
                timer = setTimeout(function () { timedOut = true; resolve({ __timeout: true }); }, timeoutMs);
            });
            return Promise.race([
                Promise.resolve()
                    .then(function () { return window._uatGetTile(z, x, y); })
                    .catch(function () { return UAT_UNREADABLE; }),
                timeout
            ]).then(function (tile) {
                clearTimeout(timer);   // altfel rămân 150+ timere vii per analiză
                if (timedOut || (tile && tile.__timeout)) return { state: 'timeout' };
                if (tile === null || tile === undefined) return { state: 'missing' };
                if (tile === UAT_UNREADABLE || !tile.data) return { state: 'unreadable' };
                return { state: 'ok', data: tile.data, size: tile.size || CONFIG.UAT_TILE_SIZE || 256 };
            });
        }
        return loadUatTileImage(z, x, y, attempt);
    }

    function uatTileKey(z, x, y) { return z + '/' + x + '/' + y; }

    function resetUatTileCache() {
        Object.keys(_uatTileStates).forEach(function (k) { delete _uatTileStates[k]; });
        _uatTileOrder = [];
    }

    function uatTileCached(z, x, y) {
        var rec = _uatTileStates[uatTileKey(z, x, y)];
        if (!rec) return null;
        if (rec.state === 'ok') return rec;
        var ttl = (typeof uatCfg().FAILURE_TTL_MS === 'number') ? uatCfg().FAILURE_TTL_MS : 60000;
        if (Date.now() - rec.at < ttl) return rec;
        return null; // eșec expirat → poate fi reîncercat
    }

    // Promise<record> — nu aruncă niciodată; un tile e întotdeauna clasificat.
    function fetchUatTile(z, x, y) {
        var max = Math.pow(2, z);
        if (x < 0 || y < 0 || x >= max || y >= max) return Promise.resolve({ state: 'missing' });
        var cached = uatTileCached(z, x, y);
        if (cached) return Promise.resolve(cached);
        var retries = Math.max(0, (typeof uatCfg().RETRIES === 'number') ? uatCfg().RETRIES : 1);

        function attempt(n) {
            return readUatTile(z, x, y, n).then(function (rec) {
                if (rec.state === 'ok' || n >= retries) return rec;
                return attempt(n + 1);
            }).catch(function () {
                return { state: 'unreadable' };
            });
        }
        return attempt(0).then(function (rec) {
            if (rec.state === 'ok' && rec.data) {
                var m = uatRedMaskFromData(rec.data, rec.size);
                rec.mask = m.mask; rec.size = m.size;
                delete rec.data;
            }
            rec.at = Date.now();
            uatCachePut(uatTileKey(z, x, y), rec);
            return rec;
        });
    }

    // Pre-încărcarea tile-urilor pentru o zonă (paralelism limitat).
    // @returns Promise<{total, ok, missing, unreadable, timeout, tiles:[...]}>
    function prewarmUatTiles(bounds, onProgress) {
        var z = uatTileZ();
        var tiles = uatTileRange(bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng, z);
        var U = uatCfg();
        var concurrency = Math.max(1, (typeof U.CONCURRENCY === 'number') ? U.CONCURRENCY : 6);
        var summary = { total: tiles.length, ok: 0, missing: 0, unreadable: 0, timeout: 0, tiles: tiles, z: z };
        if (!tiles.length) return Promise.resolve(summary);

        return new Promise(function (resolve) {
            var next = 0, done = 0;
            function worker() {
                if (next >= tiles.length) return Promise.resolve();
                var tile = tiles[next++];
                return fetchUatTile(z, tile.x, tile.y).then(function (rec) {
                    summary[rec.state] = (summary[rec.state] || 0) + 1;
                    done++;
                    if (onProgress) onProgress(done / tiles.length);
                    return worker();
                });
            }
            var workers = [];
            for (var i = 0; i < Math.min(concurrency, tiles.length); i++) workers.push(worker());
            Promise.all(workers).then(function () { resolve(summary); }, function () { resolve(summary); });
        });
    }

    // Citire sincronă (după pre-încărcare): null dacă tile-ul nu e disponibil.
    function uatTileDataSync(z, x, y) {
        var rec = _uatTileStates[uatTileKey(z, x, y)];
        return (rec && rec.state === 'ok') ? rec : null;
    }

    /**
     * Fracția de „roșu" (teren liber) dintr-o celulă de `cellM` metri.
     * Probele sunt repartizate pe o rețea k×k în cutia celulei, deci o celulă
     * mare aflată la marginea intravilanului nu mai e decisă de un singur pixel.
     * @returns {{red:number, samples:number, known:number}} red ∈ 0..1 (0 dacă
     *          nicio probă nu a putut fi citită), known = probe cu date.
     */
    function uatCellRedFraction(lat, lng, cellM) {
        var U = uatCfg();
        var z = uatTileZ();
        var step = (typeof U.SAMPLE_STEP_M === 'number') ? U.SAMPLE_STEP_M : 50;
        var maxAxis = (typeof U.MAX_SAMPLES_PER_AXIS === 'number') ? U.MAX_SAMPLES_PER_AXIS : 8;
        var half = Math.max(0, (cellM || 0)) / 2;
        var k = Math.max(1, Math.min(maxAxis, Math.ceil((cellM || step) / step)));
        var kLat = 111320;
        var kLng = Math.max(1, 111320 * Math.cos(lat * Math.PI / 180));
        var red = 0, known = 0, samples = 0;

        for (var i = 0; i < k; i++) {
            var fy = (k === 1) ? 0.5 : i / (k - 1);
            var sLat = lat + (fy * 2 - 1) * half / kLat;
            for (var j = 0; j < k; j++) {
                var fx = (k === 1) ? 0.5 : j / (k - 1);
                var sLng = lng + (fx * 2 - 1) * half / kLng;
                samples++;
                var txF = uatLngToTileXF(sLng, z), tyF = uatLatToTileYF(sLat, z);
                var tx = Math.floor(txF), ty = Math.floor(tyF);
                var tile = uatTileDataSync(z, tx, ty);
                if (!tile) continue;
                var size = tile.size || CONFIG.UAT_TILE_SIZE || 256;
                var px = Math.floor((txF - tx) * size);
                var py = Math.floor((tyF - ty) * size);
                if (px < 0 || py < 0 || px >= size || py >= size) continue;
                known++;
                if (tile.mask[py * size + px]) red++;
            }
        }
        return { red: known > 0 ? red / known : 0, samples: samples, known: known };
    }

    // Promise<boolean|null>: true = pe zona roșie (teren liber), false =
    // intravilan/zonă construită, null = fără date (incert).
    // Rămâne async pentru pipeline-ul vechi de candidați (Raportul arheologic),
    // care păstrează politica „fail closed" a aplicației pentru acel flux.
    function uatPixelAt(lat, lng) {
        if (typeof window._uatGetTile !== 'function' && typeof Image === 'undefined') {
            return Promise.resolve(null);
        }
        var z = uatTileZ();
        var txF = uatLngToTileXF(lng, z);
        var tyF = uatLatToTileYF(lat, z);
        var tx = Math.floor(txF), ty = Math.floor(tyF);
        var max = Math.pow(2, z);
        if (tx < 0 || ty < 0 || tx >= max || ty >= max) return Promise.resolve(null);

        return fetchUatTile(z, tx, ty).then(function (tile) {
            if (!tile || tile.state !== 'ok') return null;
            var size = tile.size || CONFIG.UAT_TILE_SIZE;
            var px = Math.floor((txF - tx) * size);
            var py = Math.floor((tyF - ty) * size);
            if (px < 0 || py < 0 || px >= size || py >= size) return null;
            return tile.mask[py * size + px] === 1;
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7. FILTERING + SCORING + SEPARATION
     * ═══════════════════════════════════════════════════════════════════════ */

    // Mandatory spatial filters (everything except the async UAT check).
    function passesMandatorySpatialFilters(seed, ctx) {
        // C. inside the search circle
        var dx = seed.x - ctx.center.x, dy = seed.y - ctx.center.y;
        if (dx * dx + dy * dy > ctx.radius * ctx.radius) return false;

        // B. not inside any site boundary polygon
        for (var p = 0; p < ctx.polygons.length; p++) {
            var rings = ctx.polygons[p].rings;
            for (var r = 0; r < rings.length; r++) {
                if (pointInPolygon(seed.x, seed.y, rings[r])) return false;
            }
        }

        // B. outside every site's protection radius: dist > SITE_RADIUS + SITE_BUFFER
        var minDist = ctx.siteRadius + ctx.siteBuffer;
        var nearby = ctx.siteIndex.queryCircle(seed.x, seed.y, minDist);
        for (var s = 0; s < nearby.length; s++) {
            var site = nearby[s];
            var d2x = seed.x - site.x, d2y = seed.y - site.y;
            if (d2x * d2x + d2y * d2y < minDist * minDist) return false;
        }
        return true;
    }

    function scoreCandidate(seed, ctx) {
        var S = CONFIG.SCORING;
        // NOTE: the grid index only culls by cell — exact distances are
        // verified here, otherwise counts would be inflated by sites that
        // merely share a neighbouring cell with the query circle.
        var nearbyAll = ctx.siteIndex.queryCircle(seed.x, seed.y, S.NEARBY_RADIUS_M);
        var nearby = [];
        var dists = [];
        for (var i = 0; i < nearbyAll.length; i++) {
            var dx = seed.x - nearbyAll[i].x, dy = seed.y - nearbyAll[i].y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d <= S.NEARBY_RADIUS_M) {
                nearby.push(nearbyAll[i]);
                dists.push(d);
            }
        }

        // average distance to the K nearest sites
        dists.sort(function (a, b) { return a - b; });
        var k = Math.min(S.K_NEAREST, dists.length);
        var avgDist = k > 0
            ? dists.slice(0, k).reduce(function (a, b) { return a + b; }, 0) / k
            : S.AVG_DIST_REFERENCE_M;

        var densityAll = ctx.siteIndex.queryCircle(seed.x, seed.y, S.DENSITY_RADIUS_M);
        var density = 0;
        for (var di = 0; di < densityAll.length; di++) {
            var ddx = seed.x - densityAll[di].x, ddy = seed.y - densityAll[di].y;
            if (ddx * ddx + ddy * ddy <= S.DENSITY_RADIUS_M * S.DENSITY_RADIUS_M) density++;
        }

        // Distance to the closest known site in the working area (always
        // ≥ SITE_RADIUS + SITE_BUFFER, since every candidate passed the
        // mandatory distance filter — but the exact value is useful info).
        var closestSiteM = Infinity;
        var allSites = ctx.sites || ctx.siteIndex.queryCircle(seed.x, seed.y, ctx.radius || 20000);
        for (var ci = 0; ci < allSites.length; ci++) {
            var sdx = seed.x - allSites[ci].x, sdy = seed.y - allSites[ci].y;
            var sd = Math.sqrt(sdx * sdx + sdy * sdy);
            if (sd < closestSiteM) closestSiteM = sd;
        }

        var sNearby = clamp01(nearby.length / S.NEARBY_COUNT_REF);
        var sAvgDist = 1 - clamp01(avgDist / S.AVG_DIST_REFERENCE_M);
        var sTri = clamp01(seed.triScore);
        var sDensity = clamp01(density / S.DENSITY_COUNT_REF);

        var score = S.W_NEARBY * sNearby +
            S.W_AVG_DIST * sAvgDist +
            S.W_TRIANGLE * sTri +
            S.W_DENSITY * sDensity;

        return {
            lat: seed.lat, lng: seed.lng, x: seed.x, y: seed.y,
            score: clamp01(score),
            factors: {
                nearbyCount: nearby.length,
                avgDistM: Math.round(avgDist),
                densityCount: density,
                triQuality: seed.triQuality,
                closestSiteM: isFinite(closestSiteM) ? Math.round(closestSiteM) : null,
                sNearby: sNearby, sAvgDist: sAvgDist, sTri: sTri, sDensity: sDensity
            }
        };
    }

    function classify(score) {
        if (score < CONFIG.CLASSIFY.SCORE_DISCARD_BELOW) return 'discard';
        if (score >= CONFIG.CLASSIFY.SCORE_HIGH_FROM) return 'high';
        return 'medium';
    }

    // Greedy suppression of overlapping candidates: sort by score desc, then
    // keep a candidate only if it is at least CANDIDATE_MIN_SEPARATION_M away
    // from every already-kept candidate.
    function selectSeparated(scored) {
        scored.sort(function (a, b) { return b.score - a.score; });
        var kept = [];
        var minSep2 = CONFIG.CANDIDATE_MIN_SEPARATION_M * CONFIG.CANDIDATE_MIN_SEPARATION_M;
        for (var i = 0; i < scored.length && kept.length < CONFIG.MAX_CANDIDATES; i++) {
            var c = scored[i];
            var ok = true;
            for (var j = 0; j < kept.length; j++) {
                var dx = c.x - kept[j].x, dy = c.y - kept[j].y;
                if (dx * dx + dy * dy < minSep2) { ok = false; break; }
            }
            if (ok) kept.push(c);
        }
        return kept;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7b. CÂMP DE SCOR — grilă densă peste întreaga rază de analiză
     * ═══════════════════════════════════════════════════════════════════════
     * DE CE: pipeline-ul pe semințe Delaunay produce candidați doar *în
     * interiorul* triunghiurilor rețelei de situri cunoscute, deci bulele
     * lăsau goluri mari nescorate pe hartă. Câmpul scorează FIECARE celulă a
     * unei grile regulate peste cercul de analiză, cu aceiași factori și
     * aceleași filtre obligatorii, și alimentează ambele moduri de afișare:
     *   • bule    — cercuri mici și dese care pavează toată zona (fără goluri);
     *   • heatmap — hartă termică peste celulele scorate + mască roșie peste
     *               cele excluse (intravilan UAT și razele de protecție).
     * Partea asincronă e doar citirea rasterului UAT (tile-uri cache-uite). */

    // Dimensiunea celulei astfel încât cercul să aibă cel mult `maxCells`
    // celule (crește automat pe raze mari, ca telefonul să rămână fluid),
    // rotunjită la 25 m.
    function gridCellM(radiusM, baseCellM, maxCells) {
        var area = Math.PI * radiusM * radiusM;
        var needed = Math.sqrt(area / Math.max(1, maxCells));
        var cell = Math.max(baseCellM || 250, needed);
        return Math.max(25, Math.round(cell / 25) * 25);
    }

    // Index uniform de bucket-uri peste triunghiurile Delaunay (inserare pe
    // bbox), ca o celulă a grilei să-și găsească triunghiul conținător în O(1)
    // în loc de O(număr triunghiuri).
    function buildTriangleIndex(triangles, cellM) {
        var index = createGridIndex(cellM, cellM);
        var records = [];
        for (var i = 0; i < triangles.length; i++) {
            var t = triangles[i];
            var minX = Math.min(t.a.x, t.b.x, t.c.x);
            var maxX = Math.max(t.a.x, t.b.x, t.c.x);
            var minY = Math.min(t.a.y, t.b.y, t.c.y);
            var maxY = Math.max(t.a.y, t.b.y, t.c.y);
            var cc = circumcircle(t);
            var rec = {
                t: t,
                quality: triangleQuality(t),
                circumR: cc ? cc.r : 0,
                centroid: triangleCentroid(t)
            };
            records.push(rec);
            for (var bx = Math.floor(minX / cellM); bx <= Math.floor(maxX / cellM); bx++) {
                for (var by = Math.floor(minY / cellM); by <= Math.floor(maxY / cellM); by++) {
                    index.insert(bx * cellM, by * cellM, rec);
                }
            }
        }
        return { index: index, cellM: cellM, records: records };
    }

    function triangleRecordAt(x, y, triIndex) {
        if (!triIndex) return null;
        var bucket = triIndex.index.queryCircle(x, y, 0);
        for (var i = 0; i < bucket.length; i++) {
            var t = bucket[i].t;
            if (pointInPolygon(x, y, [t.a, t.b, t.c])) return bucket[i];
        }
        return null;
    }

    // triScore pentru un punct oarecare: aceeași formulă pe care
    // sampleTriangles() o folosește pentru o sămânță (calitate × proximitate
    // față de centroid). În afara anvelopei de situri → un bază mică, ca
    // celulele îndepărtate să nu arate identic cu un gol „perfect”.
    function triScoreAt(x, y, triIndex) {
        var rec = triangleRecordAt(x, y, triIndex);
        if (!rec) return { triScore: CONFIG.FIELD.OUTSIDE_HULL_TRI_SCORE, triQuality: 0 };
        var dx = x - rec.centroid.x, dy = y - rec.centroid.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var bonus = rec.circumR > 0 ? clamp01(1 - d / rec.circumR) : 1;
        return { triScore: rec.quality * (0.5 + 0.5 * bonus), triQuality: rec.quality };
    }

    // Grila regulată de celule peste cercul de analiză (numai celulele ale
    // căror centre cad în cerc). Cellulele sunt deja în metri locali.
    function buildFieldCells(centerLat, centerLng, radiusM, cellM, lat0) {
        var kLat = 111320;
        var kLng = Math.max(1, 111320 * Math.cos(lat0 * Math.PI / 180));
        var halfLat = radiusM / kLat;
        var halfLng = radiusM / kLng;
        var cellLat = cellM / kLat;
        var cellLng = cellM / kLng;
        var rows = Math.max(1, Math.ceil(2 * halfLat / cellLat));
        var cols = Math.max(1, Math.ceil(2 * halfLng / cellLng));
        var center = projectToLocalMeters(centerLat, centerLng, lat0);
        var r2 = radiusM * radiusM;
        var cells = [];
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var lat = centerLat - halfLat + (r + 0.5) * cellLat;
                var lng = centerLng - halfLng + (c + 0.5) * cellLng;
                var p = projectToLocalMeters(lat, lng, lat0);
                var dx = p.x - center.x, dy = p.y - center.y;
                if (dx * dx + dy * dy > r2) continue;
                cells.push({ lat: lat, lng: lng, x: p.x, y: p.y, row: r, col: c });
            }
        }
        return {
            cells: cells, rows: rows, cols: cols, cellM: cellM,
            cellLat: cellLat, cellLng: cellLng,
            bbox: {
                minLat: centerLat - halfLat, maxLat: centerLat + halfLat,
                minLng: centerLng - halfLng, maxLng: centerLng + halfLng
            }
        };
    }

    // Aceleași filtre obligatorii ca la candidați, dar raportează MOTIVUL
    // excluderii, ca modul heatmap să poată picta masca roșie:
    //   'heritage' → în raza de protecție / în poligonul unui sit cunoscut
    //   'outside'  → în afara cercului de analiză
    //   null       → trece filtrele spațiale (urmează verificarea UAT)
    function exclusionReason(cell, ctx) {
        var dx = cell.x - ctx.center.x, dy = cell.y - ctx.center.y;
        if (dx * dx + dy * dy > ctx.radius * ctx.radius) return 'outside';

        for (var p = 0; p < ctx.polygons.length; p++) {
            var rings = ctx.polygons[p].rings;
            for (var r = 0; r < rings.length; r++) {
                if (pointInPolygon(cell.x, cell.y, rings[r])) return 'heritage';
            }
        }

        var minDist = ctx.siteRadius + ctx.siteBuffer;
        var minDist2 = minDist * minDist;
        var nearby = ctx.siteIndex.queryCircle(cell.x, cell.y, minDist);
        for (var s = 0; s < nearby.length; s++) {
            var ddx = cell.x - nearby[s].x, ddy = cell.y - nearby[s].y;
            if (ddx * ddx + ddy * ddy < minDist2) return 'heritage';
        }
        return null;
    }

    /**
     * Câmpul dens de scor — sursa ambelor moduri de afișare ale stratului.
     *
     * Pașii (toți deterministici: aceeași zonă + aceeași rază → același rezultat):
     *   1. siturile din cerc + poligoanele de sit (index spațial local);
     *   2. PRE-ÎNCĂRCAREA tile-urilor UAT care acoperă cercul (paralel, cu
     *      timeout + retry) — singura parte de rețea a analizei;
     *   3. grila regulată de celule peste tot cercul (o singură grilă pentru
     *      ambele moduri) + scorarea fiecărei celule: excluderi obligatorii
     *      (raza siturilor / poligoane / intravilan UAT) → factorii de scor;
     *   4. împachetarea bulelor (trepte de mărime, fără suprapuneri) și
     *      fereastra de culori a heatmap-ului.
     *
     * @param {number} centerLat  centrul analizei (pinul mov sau centrul hărții)
     * @param {number} centerLng
     * @param {number} [radiusM]  raza (default: sliderul 1–10 km)
     * @param {Object} [opts]     mode 'bubbles'|'heat', isCancelled(), onProgress(0..1),
     *                            chunkSize, skipDataWait, skipUatPrewarm
     * @returns {Promise<{status, mode, cellM, bubbleBaseRadiusM, results, bubbles,
     *                     excluded, heatPoints, heat, uat, bbox, ctx, stats}>}
     *          results  = TOATE celulele scorate [{lat,lng,x,y,row,col,score,uatRed,...}]
     *          bubbles  = cercurile împachetate (fără suprapuneri) pentru modul BULE
     *          excluded = [{lat,lng,x,y,row,col,reason:'uat'|'heritage'}]
     *          heat     = fereastra de culori folosită de heatmap + legendă
     *          uat      = { available, total, ok, failed, unknownCells, minRedFraction }
     */
    function computePotentialField(centerLat, centerLng, radiusM, opts) {
        opts = opts || {};
        var F = CONFIG.FIELD;
        var mode = (opts.mode === 'heat') ? 'heat' : 'bubbles';
        var radius = (typeof radiusM === 'number' && isFinite(radiusM))
            ? radiusM
            : (typeof currentRadiusM === 'function' ? currentRadiusM() : CONFIG.SEARCH_RADIUS_M);
        var lat0 = centerLat;
        var t0 = performance.now();
        var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
        var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
        var chunkSize = Math.max(1, opts.chunkSize || F.CHUNK_SIZE || 400);

        // Rasterul UAT nu poate fi citit deloc (offline / CORS / fără acoperire)?
        // Atunci nu mai excludem nimic — altfel întreaga hartă ieșea roșie și
        // goală, exact simptomul „uneori nu generează nimic, în mod aleator".
        var failOpen = (uatCfg().FAIL_OPEN_WHEN_UNREADABLE !== false);

        return (async function main() {
            if (!opts.skipDataWait) await waitForSiteData();

            var ctx = collectSitesInRadius(centerLat, centerLng, radius, lat0);
            ctx.center = projectToLocalMeters(centerLat, centerLng, lat0);
            ctx.centerLat = centerLat;
            ctx.centerLng = centerLng;
            ctx.radius = radius;
            ctx.siteRadius = CONFIG.SITE_RADIUS_M;
            ctx.siteBuffer = CONFIG.SITE_BUFFER_M;
            ctx.mode = mode;
            ctx.triangles = [];
            ctx.triIndex = null;

            // O SINGURĂ grilă pentru ambele moduri: bulele au nevoie de centre
            // dese (ca să umple golurile mici dintre cercuri), heatmap-ul are
            // nevoie de fiecare celulă. Dimensiunea crește automat pe raze mari.
            var cellM = gridCellM(radius, F.CELL_M || F.HEAT_CELL_M || 120,
                F.MAX_CELLS || F.HEAT_MAX_CELLS || 9000);
            var grid = buildFieldCells(centerLat, centerLng, radius, cellM, lat0);

            var field = {
                mode: mode,
                centerLat: centerLat, centerLng: centerLng, radius: radius,
                cellM: cellM,
                bubbleBaseRadiusM: bubbleBaseRadiusM(radius),
                bubbleGapM: bubbleGapM(radius),
                grid: grid, bbox: grid.bbox,
                results: [], bubbles: [], excluded: [], heatPoints: [],
                heat: null,
                uat: {
                    available: false, active: false, failOpen: failOpen,
                    total: 0, ok: 0, failed: 0,
                    unknownCells: 0, minRedFraction: uatMinRedFraction()
                },
                ctx: ctx,
                stats: {
                    sites: ctx.sites.length, cells: grid.cells.length,
                    scored: 0, excludedUat: 0, excludedHeritage: 0, uatUnknown: 0,
                    high: 0, medium: 0, low: 0,
                    bubbles: 0, bubblesHigh: 0, bubblesMedium: 0, bubblesLow: 0,
                    coverage: 0, freeAreaKm2: 0, bubbleAreaKm2: 0,
                    uatTiles: 0, uatTilesOk: 0, ms: 0
                }
            };

            function finish(status) {
                field.status = status;
                field.stats.ms = Math.round(performance.now() - t0);
                return field;
            }

            if (!ctx.sites.length) return finish('no_sites');

            ctx.siteIndex = createGridIndex(1200, 1200);
            for (var i = 0; i < ctx.sites.length; i++) {
                ctx.siteIndex.insert(ctx.sites[i].x, ctx.sites[i].y, ctx.sites[i]);
            }

            // Triangularea are nevoie de ≥ 3 situri; cu 1–2 situri câmpul se
            // scorează tot (factorii de distanță/densitate rămân valabili, iar
            // triunghiurile lipsă contribuie cu baza OUTSIDE_HULL_TRI_SCORE) —
            // altfel o zonă cu puține situri rămânea complet goală pe hartă.
            if (ctx.sites.length >= 3) {
                var points = ctx.sites.map(function (s, idx) {
                    return { x: s.x, y: s.y, lat: s.lat, lng: s.lng, i: idx };
                });
                var triangles = delaunayTriangulation(points);
                ctx.triangles = triangles.map(function (t) {
                    return {
                        a: { x: t.a.x, y: t.a.y, lat: points[t.a.i].lat, lng: points[t.a.i].lng },
                        b: { x: t.b.x, y: t.b.y, lat: points[t.b.i].lat, lng: points[t.b.i].lng },
                        c: { x: t.c.x, y: t.c.y, lat: points[t.c.i].lat, lng: points[t.c.i].lng }
                    };
                });
                ctx.triIndex = buildTriangleIndex(triangles, F.TRI_INDEX_CELL_M || 2500);
            }

            // ── UAT: pre-încărcarea tile-urilor (0–30% din progres) ──────────
            if (!opts.skipUatPrewarm) {
                var prewarm = await prewarmUatTiles(grid.bbox, function (ratio) {
                    if (onProgress) onProgress(0.3 * ratio);
                });
                field.uat.total = prewarm.total;
                field.uat.ok = prewarm.ok || 0;
                field.uat.failed = prewarm.total - (prewarm.ok || 0);
                field.uat.available = (prewarm.ok || 0) > 0;
                field.stats.uatTiles = prewarm.total;
                field.stats.uatTilesOk = prewarm.ok || 0;
                if (isCancelled()) return finish('cancelled');
            } else {
                field.uat.available = false;
            }
            var uatActive = field.uat.available || !failOpen;
            field.uat.active = uatActive;

            var cells = grid.cells;
            var processed = 0;

            for (var b = 0; b < cells.length; b += chunkSize) {
                var batch = cells.slice(b, b + chunkSize);
                for (var k = 0; k < batch.length; k++) {
                    var cell = batch[k];
                    var reason = exclusionReason(cell, ctx);

                    if (!reason && uatActive) {
                        // Celula e scorable doar dacă stă pe zona roșie (teren
                        // fără clădire actuală) — evaluată pe mai multe probe,
                        // nu pe un singur pixel.
                        var sample = uatCellRedFraction(cell.lat, cell.lng, cellM);
                        if (sample.known > 0) {
                            cell.uatRed = sample.red;
                            if (sample.red < field.uat.minRedFraction) reason = 'uat';
                        } else if (failOpen) {
                            cell.uatRed = null;      // date lipsă → nu excludem
                            field.stats.uatUnknown++;
                        } else {
                            reason = 'uat';
                        }
                    } else if (!reason) {
                        cell.uatRed = null;
                        field.stats.uatUnknown++;
                    }

                    if (reason === 'uat' || reason === 'heritage') {
                        field.excluded.push({
                            lat: cell.lat, lng: cell.lng, x: cell.x, y: cell.y,
                            row: cell.row, col: cell.col, reason: reason,
                            uatRed: cell.uatRed === undefined ? null : cell.uatRed
                        });
                        if (reason === 'uat') field.stats.excludedUat++;
                        else field.stats.excludedHeritage++;
                        continue;
                    }
                    if (reason) continue; // 'outside' — nu apare în grilă

                    var tri = triScoreAt(cell.x, cell.y, ctx.triIndex);
                    cell.triScore = tri.triScore;
                    cell.triQuality = tri.triQuality;
                    var s = scoreCandidate(cell, ctx);
                    var cls = classify(s.score);
                    field.results.push({
                        lat: s.lat, lng: s.lng, x: s.x, y: s.y,
                        row: cell.row, col: cell.col,
                        score: s.score, factors: s.factors,
                        classification: cls,
                        tier: classifyTier(s.score),
                        uatRed: cell.uatRed === undefined ? null : cell.uatRed,
                        cellM: cellM
                    });
                    field.heatPoints.push([s.lat, s.lng, Math.max(0.02, s.score)]);
                    if (cls === 'high') field.stats.high++;
                    else if (cls === 'medium') field.stats.medium++;
                    else field.stats.low++;
                    field.stats.scored++;
                }

                processed += batch.length;
                if (onProgress) onProgress(0.3 + 0.7 * Math.min(1, processed / Math.max(1, cells.length)));
                await yieldToUI();
                if (isCancelled()) return finish('cancelled');
            }

            field.uat.unknownCells = field.stats.uatUnknown;

            // Bulele = împachetarea celulelor scorate (modul BULE). Câmpul
            // scorat rămâne dens: heatmap-ul îl citește integral.
            field.bubbles = selectBubbles(field);
            field.stats.bubbles = field.bubbles.length;
            for (var bi = 0; bi < field.bubbles.length; bi++) {
                var tier = field.bubbles[bi].tier || classifyTier(field.bubbles[bi].score);
                if (tier === 'high') field.stats.bubblesHigh++;
                else if (tier === 'medium') field.stats.bubblesMedium++;
                else field.stats.bubblesLow++;
            }
            // Acoperirea: cât din terenul liber (neexclus) e umplut de bule.
            var freeAreaM2 = field.stats.scored * cellM * cellM;
            field.stats.freeAreaKm2 = Math.round(freeAreaM2 / 1e6 * 100) / 100;
            field.stats.bubbleAreaKm2 = Math.round((field.stats.coverage * freeAreaM2) / 1e6 * 100) / 100;

            // Heatmap: scala de culori (absolută, identică cu a bulelor și cu
            // legenda) + fereastra percentilică păstrată pentru modul relativ.
            field.heat = heatScoreWindow(field.results);

            if (!field.results.length) return finish('no_candidates');
            if (ctx.sites.length < 3) return finish('sparse_sites');
            return finish('ok');
        })();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7c. ÎMPACHETAREA BULELOR + RASTERUL DE SCOR PENTRU HEATMAP
     * ═══════════════════════════════════════════════════════════════════════
     * CERINȚA: bule de mărimi diferite care umplu canvas-ul cât mai mult, fără
     * să se intercaleze/intersecteze între ele, fără să intre peste razele
     * siturilor (600 + 100 m) sau peste intravilanul UAT — care rămân roșii,
     * fără niciun rezultat.
     *
     * CUM: fiecare celulă scorată e un centru candidat, cu spațiul ei liber
     * măsurat o singură dată (distanța exactă până la cea mai apropiată
     * constrângere: sit, poligon de sit, dreptunghi UAT sau marginea cercului de
     * analiză). Apoi trecem prin TREPTE de mărime — întâi bulele mari, apoi cele
     * din ce în ce mai mici, care completează golurile rămase între cele mari.
     * O bulă e pusă doar dacă discul ei întreg încapă: raza = min(raza treptei,
     * spațiu liber − clearance), cu verificarea reală a distanței față de toate
     * bulele deja puse (margine la margine, nu centru la centru).
     *
     * BUG-URI REPARATE AICI (sursa „golurilor aleatorii"):
     *   • celulele cu spațiu liber nelimitat (niciun sit și nicio mască în
     *     apropiere — adică exact zonele deschise, bune) erau ARUNCATE pentru că
     *     testul era `if (!isFinite(clearance)) continue`; acum Infinity înseamnă
     *     „fără constrângere" → rază maximă;
     *   • plafonul de bule (0.22/km² → 69 la 10 km) și pragul MIN_SCORE 0.30
     *     lăsau cea mai mare parte a zonei goală; acum bulele acoperă terenul
     *     liber, iar scorul slab e arătat prin culoare pală, nu prin gol. */

    // Raza bulelor la raza de analiză dată (referința: 10 km = BUBBLE.RADIUS_M).
    // Scala e √(rază), nu liniară: la 1 km bulele rămân citibile, la 10 km nu
    // devin puncte.
    function bubbleScale(radiusM) {
        return Math.max(0.34, Math.sqrt(Math.max(1, radiusM) / CONFIG.SEARCH_RADIUS_M));
    }

    function bubbleBaseRadiusM(radiusM) {
        var B = CONFIG.BUBBLE;
        var r = (B.RADIUS_M || 420) * bubbleScale(radiusM);
        return Math.round(Math.max(B.RADIUS_MIN_M || 150, Math.min(B.RADIUS_MAX_M || 520, r)));
    }

    function bubbleGapM(radiusM) {
        var B = CONFIG.BUBBLE;
        var g = (B.GAP_M || 110) * bubbleScale(radiusM);
        return Math.round(Math.max(B.GAP_MIN_M || 15, g));
    }

    // Spațiul liber cerut între două bule scalează cu mărimea lor: bulele mari
    // păstrează gap-ul complet, cele mici (care completează golurile) au nevoie
    // de un gap proporțional mai mic, altfel nu mai încap între cele mari.
    function bubbleGapForRadius(radiusM, baseR, gap) {
        var B = CONFIG.BUBBLE;
        var floor = (typeof B.GAP_MIN_M === 'number') ? B.GAP_MIN_M : 15;
        if (!(baseR > 0)) return gap;
        var scaled = gap * Math.max(0.2, Math.min(1, radiusM / baseR));
        return Math.max(floor, Math.round(scaled));
    }

    /**
     * Câte bule are voie să aibă o rulare. Plafonul nu mai e doar „X bule pe km²":
     * la o rază mică bulele sunt mici, deci același teren liber are nevoie de mult
     * mai multe cercuri ca să fie umplut (vechiul plafon de 69 de bule la 10 km /
     * 10 la 1 km lăsa harta goală). Când se cunoaște terenul liber real, plafonul
     * crește cât să acopere ținta de acoperire cu raza medie a treptelor.
     * Rămâne mărginit de MAX_BUBBLES, ca telefonul să nu se blocheze.
     */
    function bubbleCountCap(radiusM, freeAreaM2) {
        var B = CONFIG.BUBBLE;
        var areaKm2 = Math.PI * radiusM * radiusM / 1e6;
        var n = Math.round(areaKm2 * (B.PER_KM2 || 4.5));
        if (freeAreaM2 > 0) {
            var floorR = (typeof B.RADIUS_FLOOR_M === 'number') ? B.RADIUS_FLOOR_M : 35;
            var factor = (typeof B.TYPICAL_RADIUS_FACTOR === 'number') ? B.TYPICAL_RADIUS_FACTOR : 0.45;
            var target = (typeof B.COVERAGE_TARGET === 'number') ? B.COVERAGE_TARGET : 0.82;
            var rTypical = Math.max(floorR, bubbleBaseRadiusM(radiusM) * factor);
            var needed = Math.ceil(freeAreaM2 * target / (Math.PI * rTypical * rTypical));
            if (needed > n) n = needed;
        }
        return Math.max(B.MIN_BUBBLES || 26, Math.min(B.MAX_BUBBLES || 1400, n));
    }

    // Treapta de culoare/legendă a unui scor: low | medium | high.
    function classifyTier(score) {
        var C = CONFIG.CLASSIFY;
        if (score >= C.SCORE_HIGH_FROM) return 'high';
        if (score >= C.SCORE_DISCARD_BELOW) return 'medium';
        return 'low';
    }

    function uatMinRedFraction() {
        var U = uatCfg();
        return (typeof U.MIN_RED_FRACTION === 'number') ? U.MIN_RED_FRACTION : 0.5;
    }

    /**
     * Spațiul liber din jurul unui punct = distanța exactă până la cea mai
     * apropiată constrângere:
     *   • razele de protecție ale siturilor (SITE_RADIUS_M + SITE_BUFFER_M),
     *   • dreptunghiurile măștii roșii (celule excluse: intravilan UAT / situri),
     *   • marginea cercului de analiză (o bulă nu iese din zona scorată).
     * Infinity = nicio constrângere în apropiere → raza maximă e permisă
     * (vechiul cod arunca aceste celule, exact zonele deschise și bune).
     */
    function measureClearance(field, maskIndex, x, y, reach) {
        var ctx = field.ctx || {};
        var cellM = field.cellM;
        var halfCell = cellM / 2;
        var siteGuard = (ctx.siteRadius || CONFIG.SITE_RADIUS_M) +
            (ctx.siteBuffer || CONFIG.SITE_BUFFER_M);
        var clearance = Infinity;
        var i;

        if (ctx.siteIndex) {
            var near = ctx.siteIndex.queryCircle(x, y, reach + siteGuard);
            for (i = 0; i < near.length; i++) {
                var sdx = x - near[i].x, sdy = y - near[i].y;
                var sd = Math.sqrt(sdx * sdx + sdy * sdy) - siteGuard;
                if (sd < clearance) clearance = sd;
            }
        }
        if (maskIndex) {
            var masked = maskIndex.queryCircle(x, y, reach + cellM);
            for (i = 0; i < masked.length; i++) {
                // distanța de la punct la dreptunghiul [x±halfCell, y±halfCell]
                var mdx = Math.abs(x - masked[i].x) - halfCell;
                var mdy = Math.abs(y - masked[i].y) - halfCell;
                if (mdx < 0) mdx = 0;
                if (mdy < 0) mdy = 0;
                var md = Math.sqrt(mdx * mdx + mdy * mdy);
                if (md < clearance) clearance = md;
            }
        }
        if (ctx.center && field.radius) {
            var cdx = x - ctx.center.x, cdy = y - ctx.center.y;
            var toEdge = field.radius - Math.sqrt(cdx * cdx + cdy * cdy);
            if (toEdge < clearance) clearance = toEdge;
        }
        return clearance;
    }

    /**
     * Centre suplimentare pentru umplerea golurilor mici dintre bule: aceeași
     * grilă, decalată cu jumătate de celulă pe ambele axe. Fiecare punct e
     * evaluat complet (filtre obligatorii + fracția de roșu UAT + aceiași
     * factori de scor) exact ca o celulă a câmpului, deci bulele de umplutură au
     * aceleași culori ca heatmap-ul și respectă aceeași legendă.
     */
    function gapFillCandidates(field, maskIndex, minScore, maxRadius, maskGap, floorR) {
        var ctx = field.ctx || {};
        var cellM = field.cellM;
        var uat = field.uat || {};
        var minRed = (typeof uat.minRedFraction === 'number') ? uat.minRedFraction : uatMinRedFraction();
        var half = cellM / 2;
        var out = [];

        for (var i = 0; i < field.results.length; i++) {
            var r = field.results[i];
            var x = r.x + half, y = r.y + half;
            var point = { x: x, y: y, row: r.row, col: r.col, gapFill: true };
            if (exclusionReason(point, ctx)) continue;   // sit / poligon / afară

            var ll = localMetersToLatLng(x, y, field.centerLat);
            point.lat = ll.lat; point.lng = ll.lng;

            if (uat.active) {
                var sample = uatCellRedFraction(ll.lat, ll.lng, cellM);
                if (sample.known > 0) {
                    if (sample.red < minRed) continue;   // intravilan → rămâne roșu
                    point.uatRed = sample.red;
                } else if (!uat.failOpen) {
                    continue;
                } else {
                    point.uatRed = null;
                }
            } else {
                point.uatRed = null;
            }

            var tri = triScoreAt(x, y, ctx.triIndex);
            point.triScore = tri.triScore;
            point.triQuality = tri.triQuality;
            var s = scoreCandidate(point, ctx);
            if (s.score < minScore) continue;

            var clearance = measureClearance(field, maskIndex, x, y, maxRadius);
            var radius = Math.min(maxRadius, Math.floor(clearance - maskGap));
            if (radius < floorR) continue;

            out.push({
                cell: {
                    lat: ll.lat, lng: ll.lng, x: x, y: y,
                    row: r.row, col: r.col,
                    score: s.score, factors: s.factors,
                    classification: classify(s.score),
                    tier: classifyTier(s.score),
                    uatRed: point.uatRed, cellM: cellM, gapFill: true
                },
                clearance: clearance, radius: radius
            });
        }
        out.sort(function (a, b) {
            return (b.cell.score - a.cell.score) ||
                (a.cell.row - b.cell.row) || (a.cell.col - b.cell.col);
        });
        return out;
    }

    /**
     * Împachetarea bulelor. Deterministă: candidatele sunt sortate după scor
     * (desc), apoi după rând/coloană, iar treptele de mărime sunt parcurse de la
     * mare la mic — deci aceeași zonă produce întotdeauna același desen.
     *
     * @returns {Array<{lat,lng,x,y,row,col,score,factors,classification,tier,radiusM,cellM}>}
     */
    function selectBubbles(field) {
        var B = CONFIG.BUBBLE;
        var ctx = field.ctx || {};
        var cellM = field.cellM;
        var gap = field.bubbleGapM || bubbleGapM(field.radius);
        var baseR = field.bubbleBaseRadiusM || bubbleBaseRadiusM(field.radius);
        var freeAreaM2 = field.results.length * cellM * cellM;
        var cap = bubbleCountCap(field.radius, freeAreaM2);
        var minScore = (typeof B.MIN_SCORE === 'number') ? B.MIN_SCORE : 0;
        var maskGap = (B.MASK_CLEARANCE_M === undefined) ? 25 : B.MASK_CLEARANCE_M;
        var floorR = (typeof B.RADIUS_FLOOR_M === 'number') ? B.RADIUS_FLOOR_M : 35;
        var tiers = (B.TIERS && B.TIERS.length) ? B.TIERS : [1, 0.66, 0.44, 0.28];
        var tierFill = (typeof B.TIER_FILL === 'number') ? B.TIER_FILL : 0.72;
        var gapFloor = (typeof B.GAP_MIN_M === 'number') ? B.GAP_MIN_M : 15;
        var coverageTarget = (typeof B.COVERAGE_TARGET === 'number') ? B.COVERAGE_TARGET : 0.82;
        var i;

        // Index peste celulele excluse (adică peste masca roșie desenată).
        var maskIndex = createGridIndex(Math.max(cellM, 250), Math.max(cellM, 250));
        for (i = 0; i < field.excluded.length; i++) {
            maskIndex.insert(field.excluded[i].x, field.excluded[i].y, field.excluded[i]);
        }

        // 1) spațiul liber din jurul fiecărei celule bune (o singură dată)
        var cells = [];
        for (i = 0; i < field.results.length; i++) {
            var r = field.results[i];
            if (r.score < minScore) continue;
            cells.push({
                cell: r,
                clearance: measureClearance(field, maskIndex, r.x, r.y, baseR),
                used: false
            });
        }

        // 2) sortare totală (scor, apoi poziție) → rezultat determinist
        cells.sort(function (a, b) {
            return (b.cell.score - a.cell.score) ||
                (a.cell.row - b.cell.row) || (a.cell.col - b.cell.col);
        });

        var kept = [];
        var keptIndex = createGridIndex(baseR * 2 + gap, baseR * 2 + gap);
        var bubbleAreaM2 = 0;

        function coverage() {
            return freeAreaM2 > 0 ? bubbleAreaM2 / freeAreaM2 : 0;
        }

        function conflicts(x, y, radius, needGap) {
            var reach = radius + baseR + needGap;
            var neighbours = keptIndex.queryCircle(x, y, reach);
            for (var n = 0; n < neighbours.length; n++) {
                var ndx = x - neighbours[n].x, ndy = y - neighbours[n].y;
                // margine la margine: raza nouă + raza vecinului + gap-ul treptei
                var need = radius + neighbours[n].radiusM + needGap;
                if (ndx * ndx + ndy * ndy < need * need) return true;
            }
            return false;
        }

        function place(c, radius) {
            var bubble = {
                lat: c.lat, lng: c.lng, x: c.x, y: c.y,
                row: c.row, col: c.col,
                score: c.score, factors: c.factors,
                classification: c.classification,
                tier: c.tier || classifyTier(c.score),
                uatRed: c.uatRed === undefined ? null : c.uatRed,
                cellM: cellM, radiusM: radius, gapFill: !!c.gapFill
            };
            kept.push(bubble);
            keptIndex.insert(bubble.x, bubble.y, bubble);
            bubbleAreaM2 += Math.PI * radius * radius;
            return bubble;
        }

        // 3) treptele de mărime pe celulele câmpului: mari → mici, iar la final
        //    treapta „umplere", a cărei rază e aleasă din pasul grilei (cellM) ca
        //    două celule vecine să poată găzdui fiecare câte o bulă:
        //    raza = (cellM − gap) / 2. Fără ea, bulele mici se blocau reciproc și
        //    rămâneau goluri mari (principala sursă a „zonelor goale").
        var tierRadii = [];
        for (var t = 0; t < tiers.length; t++) {
            tierRadii.push({ r: Math.max(floorR, Math.round(baseR * tiers[t])), filler: false });
        }
        var fillerR = Math.max(floorR, Math.floor((cellM - gapFloor) / 2));
        fillerR = Math.min(fillerR, tierRadii[tierRadii.length - 1].r);
        if (tierRadii[tierRadii.length - 1].r > fillerR) tierRadii.push({ r: fillerR, filler: true });
        else tierRadii[tierRadii.length - 1].filler = true;

        for (t = 0; t < tierRadii.length && kept.length < cap; t++) {
            var tierR = tierRadii[t].r;
            var tierMin = tierRadii[t].filler ? floorR : Math.max(floorR, Math.round(tierR * tierFill));
            var tierGap = bubbleGapForRadius(tierR, baseR, gap);
            for (var k = 0; k < cells.length && kept.length < cap; k++) {
                if (cells[k].used) continue;
                var radius = Math.min(tierR, Math.floor(cells[k].clearance - maskGap));
                if (radius < tierMin) continue;
                var c = cells[k].cell;
                if (conflicts(c.x, c.y, radius, tierGap)) continue;
                place(c, radius);
                cells[k].used = true;
            }
        }

        // 4) golurile mici dintre bule: o a doua rețea de centre, decalată cu
        //    jumătate de celulă. Pornește doar dacă mai e loc (sub ținta de
        //    acoperire și sub plafon) — altfel zona ar fi deja plină.
        if (kept.length < cap && coverage() < coverageTarget) {
            var fillGap = bubbleGapForRadius(fillerR, baseR, gap);
            var fillers = gapFillCandidates(field, maskIndex, minScore, fillerR, maskGap, floorR);
            for (var f = 0; f < fillers.length && kept.length < cap; f++) {
                var fc = fillers[f];
                if (conflicts(fc.cell.x, fc.cell.y, fc.radius, fillGap)) continue;
                place(fc.cell, fc.radius);
            }
        }

        // 5) acoperirea terenului liber (cerința „cât mai plin"): aria bulelor /
        //    aria celulelor scorate. O raportează statusul, o verifică testele.
        if (field.stats) {
            field.stats.coverage = Math.round(Math.min(1, coverage()) * 1000) / 1000;
            field.stats.bubbleCap = cap;
            field.stats.gapFill = 0;
        }
        kept.sort(function (a, b) {
            return (b.score - a.score) || (a.row - b.row) || (a.col - b.col);
        });
        for (i = 0; i < kept.length; i++) if (kept[i].gapFill) field.stats.gapFill++;
        return kept;
    }

    /* ── Heatmap: fereastra de normalizare + rampa de culori ────────────────
     * simpleheat aduna ALFA peste puncte suprapuse: cu o grilă densă fiecare
     * pixel era acoperit de zeci de blob-uri, deci ajungea la 1 aproape peste
     * tot și harta ieșea aproape monocoloră. Aici culoarea e funcție de SCOR,
     * nu de numărul de vecini: fiecare celulă primește poziția ei în fereastra
     * 2..98% a rulării, iar diferența slab↔tare rămâne vizibilă oriunde. */

    function percentile(sortedAsc, p) {
        if (!sortedAsc || !sortedAsc.length) return 0;
        var idx = Math.max(0, Math.min(1, p)) * (sortedAsc.length - 1);
        var i0 = Math.floor(idx), i1 = Math.ceil(idx);
        if (i0 === i1) return sortedAsc[i0];
        return sortedAsc[i0] + (sortedAsc[i1] - sortedAsc[i0]) * (idx - i0);
    }

    function heatNormalizeMode() {
        var H = CONFIG.HEAT;
        return (H.NORMALIZE === 'percentile') ? 'percentile' : 'absolute';
    }

    /**
     * Scala de culori a rulării.
     *
     * IMPLICIT E ABSOLUTĂ (`HEAT.NORMALIZE = 'absolute'`): poziția pe rampă e
     * chiar scorul celulei, deci o culoare înseamnă întotdeauna același lucru —
     * în heatmap, pe bule, în popup și în legendă. Fereastra 2..98% veche făcea
     * scala relativă la fiecare rulare (același teren ieșea „puternic" într-o
     * zonă și „slab" în alta), iar legenda nu mai corespundea scorurilor.
     * Modul relativ rămâne disponibil din consolă, cu statistici păstrate:
     * `ARCH_POTENTIAL_CONFIG.HEAT.NORMALIZE = 'percentile'`.
     */
    function heatScoreWindow(results) {
        var H = CONFIG.HEAT;
        var loP = (typeof H.LOW_PERCENTILE === 'number') ? H.LOW_PERCENTILE : 0.02;
        var hiP = (typeof H.HIGH_PERCENTILE === 'number') ? H.HIGH_PERCENTILE : 0.98;
        var minWindow = (typeof H.MIN_WINDOW === 'number') ? H.MIN_WINDOW : 0.12;
        var scores = [];
        for (var i = 0; i < (results || []).length; i++) scores.push(results[i].score);
        var win = {
            normalize: heatNormalizeMode(),
            lo: 0, hi: 1, min: 0, max: 0, count: scores.length, stretched: false,
            // pragurile legendei (identice cu CONFIG.CLASSIFY)
            tiers: { low: CONFIG.CLASSIFY.SCORE_DISCARD_BELOW, high: CONFIG.CLASSIFY.SCORE_HIGH_FROM }
        };
        if (!scores.length) return win;
        scores.sort(function (a, b) { return a - b; });
        win.min = scores[0];
        win.max = scores[scores.length - 1];
        if (win.normalize === 'absolute') {
            win.lo = 0;
            win.hi = 1;
            return win;
        }
        var a = percentile(scores, loP);
        var b = percentile(scores, hiP);
        // Scoruri într-o bandă îngustă → întindem fereastra în jurul medianei,
        // altfel toată harta ar ieși aceeași culoare.
        if (b - a < minWindow) {
            var mid = percentile(scores, 0.5);
            a = mid - minWindow / 2;
            b = mid + minWindow / 2;
            win.stretched = true;
        }
        win.lo = a;
        win.hi = b;
        return win;
    }

    // Scor brut → poziția pe rampă (0 = cel mai slab, 1 = cel mai bun).
    function heatNormalize(score, win) {
        if (!win || win.normalize === 'absolute') return clamp01(score);
        if (!(win.hi > win.lo)) return 0.5;
        var t = (score - win.lo) / (win.hi - win.lo);
        return Math.max(0, Math.min(1, t));
    }

    function parseHexColor(hex) {
        var h = String(hex).replace('#', '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var n = parseInt(h, 16);
        if (!isFinite(n)) return [255, 255, 255];
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    // Rampă → tabel de 256 de culori (o singură dată, apoi doar indexare).
    function buildHeatRamp(stops) {
        var keys = Object.keys(stops).map(Number).sort(function (a, b) { return a - b; });
        var rgb = keys.map(function (k) { return parseHexColor(stops[k]); });
        var lut = new Uint8ClampedArray(256 * 4);
        for (var i = 0; i < 256; i++) {
            var t = i / 255;
            var k1 = keys.length - 1;
            for (var k = 1; k < keys.length; k++) {
                if (t <= keys[k]) { k1 = k; break; }
            }
            var k0 = Math.max(0, k1 - 1);
            var span = (keys[k1] - keys[k0]) || 1;
            var f = Math.max(0, Math.min(1, (t - keys[k0]) / span));
            lut[i * 4] = Math.round(rgb[k0][0] + (rgb[k1][0] - rgb[k0][0]) * f);
            lut[i * 4 + 1] = Math.round(rgb[k0][1] + (rgb[k1][1] - rgb[k0][1]) * f);
            lut[i * 4 + 2] = Math.round(rgb[k0][2] + (rgb[k1][2] - rgb[k0][2]) * f);
            lut[i * 4 + 3] = 255;
        }
        return lut;
    }

    // Netezire gaussiană separabilă, doar între celule cu scor: valorile nu se
    // scurg în zonele excluse (acelea rămân transparente, sub masca roșie).
    function smoothField(values, valid, cols, rows, sigmaCells) {
        var sigma = Number(sigmaCells) || 0;
        if (!(sigma > 0)) return values;
        var radius = Math.max(1, Math.ceil(sigma * 2));
        var kernel = [], ksum = 0, k;
        for (k = -radius; k <= radius; k++) {
            var w = Math.exp(-(k * k) / (2 * sigma * sigma));
            kernel.push(w);
            ksum += w;
        }
        for (k = 0; k < kernel.length; k++) kernel[k] /= ksum;

        var tmp = new Float32Array(values.length);
        var out = new Float32Array(values.length);
        var x, y, i;
        for (y = 0; y < rows; y++) {
            for (x = 0; x < cols; x++) {
                var acc = 0, wsum = 0;
                for (k = -radius; k <= radius; k++) {
                    var sx = x + k;
                    if (sx < 0 || sx >= cols) continue;
                    i = y * cols + sx;
                    if (!valid[i]) continue;
                    var wk = kernel[k + radius];
                    acc += values[i] * wk;
                    wsum += wk;
                }
                i = y * cols + x;
                tmp[i] = wsum > 0 ? acc / wsum : 0;
            }
        }
        for (x = 0; x < cols; x++) {
            for (y = 0; y < rows; y++) {
                var acc2 = 0, wsum2 = 0;
                for (k = -radius; k <= radius; k++) {
                    var sy = y + k;
                    if (sy < 0 || sy >= rows) continue;
                    i = sy * cols + x;
                    if (!valid[i]) continue;
                    var wk2 = kernel[k + radius];
                    acc2 += tmp[i] * wk2;
                    wsum2 += wk2;
                }
                i = y * cols + x;
                out[i] = wsum2 > 0 ? acc2 / wsum2 : 0;
            }
        }
        return out;
    }

    // Valori normalizate → RGBA. Alfa crește odată cu scorul: zonele slabe sunt
    // translucide (se citesc ca „puțin interesant”), cele bune saturate.
    function colorizeField(values, valid, cols, rows, lut, H) {
        var aMin = (typeof H.ALPHA_MIN === 'number') ? H.ALPHA_MIN : 0.52;
        var aMax = (typeof H.ALPHA_MAX === 'number') ? H.ALPHA_MAX : 0.97;
        var gamma = (typeof H.ALPHA_GAMMA === 'number') ? H.ALPHA_GAMMA : 0.6;
        var rgba = new Uint8ClampedArray(cols * rows * 4);
        for (var i = 0; i < values.length; i++) {
            if (!valid[i]) continue;
            var t = Math.max(0, Math.min(1, values[i]));
            var li = Math.round(t * 255) * 4;
            rgba[i * 4] = lut[li];
            rgba[i * 4 + 1] = lut[li + 1];
            rgba[i * 4 + 2] = lut[li + 2];
            rgba[i * 4 + 3] = Math.round((aMin + (aMax - aMin) * Math.pow(t, gamma)) * 255);
        }
        return rgba;
    }

    /**
     * Rasterul de scor al rulării: cols × rows pixeli în care fiecare celulă a
     * grilei e un pixel colorat după scorul ei normalizat.
     *
     * Indicare: `rgba`/`valid`/`values` sunt în ORDINE DE CÂMP — idx =
     * row·cols + col cu row 0 = marginea SUDICĂ (minLat) — exact ca
     * field.results. Imaginea sursă (createHeatSourceCanvas) le inversează pe
     * vertical ca bitmap-ul desenat să fie NORD în sus (redraw ancorează vârful
     * bitmap-ului la maxLat), iar colorAt() rămâne în ordine de câmp.
     * @returns {{cols,rows,rgba,values,valid,window,bbox,cellM}}
     */
    function buildHeatRaster(field) {
        var H = CONFIG.HEAT;
        var grid = field.grid;
        var cols = grid.cols, rows = grid.rows;
        var win = field.heat || heatScoreWindow(field.results);
        var base = new Float32Array(rows * cols);
        var valid = new Uint8Array(rows * cols);
        for (var i = 0; i < field.results.length; i++) {
            var r = field.results[i];
            if (r.row == null || r.col == null) continue;
            var idx = r.row * cols + r.col;
            if (idx < 0 || idx >= base.length) continue;
            base[idx] = heatNormalize(r.score, win);
            valid[idx] = 1;
        }
        // Netezirea se face doar între celulele scorate: zonele excluse (UAT +
        // razele siturilor) rămân transparente și sunt pictate cu roșu de mască.
        var smooth = smoothField(base, valid, cols, rows, H.SMOOTH_SIGMA_CELLS);
        var lut = heatRampLut();
        return {
            cols: cols, rows: rows,
            values: smooth, base: base, valid: valid,
            rgba: colorizeField(smooth, valid, cols, rows, lut, H),
            window: win, bbox: grid.bbox, cellM: grid.cellM,
            // Culoarea exactă a unei celule (înainte de netezire) — identică cu
            // scoreColor(score) și cu bucata corespunzătoare din legendă.
            colorAt: function (row, col) {
                var idx = row * cols + col;
                if (!valid[idx]) return null;
                var li = Math.round(Math.max(0, Math.min(1, base[idx])) * 255) * 4;
                return 'rgb(' + lut[li] + ',' + lut[li + 1] + ',' + lut[li + 2] + ')';
            }
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 8. RENDERING
     * ═══════════════════════════════════════════════════════════════════════ */

    var _layerGroup = null;      // bule + aria de lucru (pane_archeo)
    var _heatLayer = null;       // canvas heatmap (pane_archeo_heat)
    var _maskGroup = null;       // mască roșie: UAT + raze patrimoniu (pane_archeo_mask)
    var _bubbleRenderer = null;  // renderer canvas partajat pentru bule
    var _maskRenderer = null;    // renderer canvas al măștii (scos de pe hartă la oprire)
    var _heatRaster = null;      // rasterul de scoruri al ultimei rulări (debug)
    var _currentResults = null;  // celulele scorate la ultima rulare (API public)
    var _currentField = null;    // câmpul complet (debug / teste)
    var _renderSeq = 0;          // o rulare de randare = un nou set de forme 3D
    // Stratul pornește întotdeauna OPRIT implicit — wireUI() forțează OFF la
    // prima cablare (fără `checked` în HTML + resetarea oricărei stări
    // restaurate de browser la reload), nu doar citește comutatorul.
    var _resultsVisible = false;

    // Treptele de stil ale bulelor: grosimea și opacitatea spun cât de puternică
    // e zona (pal → saturat), iar CULOAREA vine întotdeauna din scor, prin aceeași
    // rampă ca a heatmap-ului și ca a legendei (HEAT_GRADIENT). Astfel o culoare
    // înseamnă același lucru în ambele moduri de afișare.
    var STYLE_TIERS = {
        low:    { weight: 0.8, opacity: 0.55, fillOpacity: 0.20 },
        medium: { weight: 1.2, opacity: 0.80, fillOpacity: 0.36 },
        high:   { weight: 1.7, opacity: 0.95, fillOpacity: 0.55 }
    };

    // Scorurile de referință ale celor trei bucăți din legendă (punctele din
    // interiorul fiecărei trepte Low / Medium / High).
    var LEGEND_SCORES = { low: 0.15, medium: 0.40, high: 0.78 };

    function styleFor(score) {
        var tier = classifyTier(score);
        var t = STYLE_TIERS[tier] || STYLE_TIERS.low;
        var c = scoreColorHex(score);
        return {
            tier: tier,
            color: c, weight: t.weight, opacity: t.opacity,
            fillColor: c, fillOpacity: t.fillOpacity
        };
    }

    // Paneele stratului: heatmap sub mască, masca sub bule, bulele sub pin.
    //
    // pane_archeo stă la z-index 660, DEASUPRA marker pane (600), unde trăiesc
    // pin-urile detectoriștilor. Rendererul L.canvas e UN <canvas> cât tot
    // viewport-ul, iar foaia Leaflet neutralizează pointer-events doar pentru
    // `.leaflet-pane > svg path`, niciodată pentru `<canvas>`. Cu pointer-events
    // lăsate pe auto, canvas-ul câștigă hit-test-ul pe toată harta: tap-ul nu
    // mai ajunge la pin, deci nu se deschid detaliile și nici cererea de
    // prietenie. Și rămâne așa după oprirea stratului — Leaflet nu scoate
    // rendererul de pe hartă când i se golesc path-urile (Path.onRemove face
    // doar _removePath), iar canvas-ul poartă `_leaflet_disable_events`, deci
    // înghițea click-ul și după ce bulele dispăreau vizual.
    // Aceeași regulă ca la LIDAR Scanner / patrimoniu: pane-ul e click-through.
    // Popup-ul bulelor se redeschide din click-ul hărții (vezi onMapClick),
    // pe care Leaflet îl cheamă doar dacă tap-ul n-a nimerit deja un marker.
    var PANE_DEFS = [
        ['pane_archeo_heat', function () { return CONFIG.PANE_Z_HEAT; }, 'none'],
        ['pane_archeo_mask', function () { return CONFIG.PANE_Z_MASK; }, 'none'],
        ['pane_archeo', function () { return CONFIG.PANE_Z_INDEX; }, 'none'],
        ['pane_archeo_pin', function () { return CONFIG.PANE_Z_PIN; }, '']
    ];

    function ensurePane(map) {
        if (!map || typeof map.createPane !== 'function') return false;
        for (var i = 0; i < PANE_DEFS.length; i++) {
            var name = PANE_DEFS[i][0];
            var pane = map.getPane ? map.getPane(name) : null;
            if (!pane) pane = map.createPane(name);
            if (pane && pane.style) {
                pane.style.zIndex = PANE_DEFS[i][1]();
                pane.style.pointerEvents = PANE_DEFS[i][2];
            }
        }
        return true;
    }

    function paneOption(map, name) {
        return (ensurePane(map) && map.getPane && map.getPane(name)) ? name : undefined;
    }

    function assignPane(map, options, name) {
        var pane = paneOption(map, name);
        if (pane) options.pane = pane;
        return options;
    }

    // L.canvas nu pune pointer-events:none pe element. Îl scriem noi pe
    // <canvas> în momentul în care Leaflet îl creează (evenimentul „add”,
    // după onAdd), ca să nu depindem doar de moștenirea de pe pane — un
    // canvas rămas după oprirea stratului tot n-are voie să primească tap-ul.
    function armClickThrough(renderer) {
        if (!renderer || renderer._dlClickThrough) return renderer;
        renderer._dlClickThrough = true;
        function silence() {
            var canvas = renderer._container;
            if (canvas && canvas.style) canvas.style.pointerEvents = 'none';
        }
        if (typeof renderer.on === 'function') renderer.on('add', silence);
        silence();
        return renderer;
    }

    function clickThroughCanvas(map, paneName, padding) {
        if (typeof L === 'undefined' || typeof L.canvas !== 'function') return null;
        var renderer = armClickThrough(L.canvas(assignPane(map, { padding: padding }, paneName)));
        // Rendererul e infrastructură, nu un strat: 3D nu-l numără ca „fără echivalent”.
        renderer._dl3dSkip = true;
        return renderer;
    }

    // Renderer canvas pentru bule: cu câteva sute/mii de cercuri, SVG-ul ar
    // muta un nod DOM la fiecare repaint; canvas-ul doar redesenează pixeli.
    function bubbleRendererOption(map) {
        if (!_bubbleRenderer) _bubbleRenderer = clickThroughCanvas(map, 'pane_archeo', 0.25);
        return _bubbleRenderer;
    }

    function maskRendererOption(map) {
        if (!_maskRenderer) _maskRenderer = clickThroughCanvas(map, 'pane_archeo_mask', 0.2);
        return _maskRenderer;
    }

    // ── Score → culoare: O SINGURĂ rampă pentru tot stratul ─────────────────
    // Bulele, heatmap-ul, popup-ul (stele + procent) și legenda folosesc cu toții
    // HEAT_GRADIENT aplicat pe scorul ABSOLUT: aceeași nuanță = același scor,
    // indiferent de rulare sau de modul de afișare. Roșul rămâne rezervat exclusiv
    // zonelor excluse (intravilan UAT + razele de protecție ale siturilor).
    // Rampa heatmap: indigo închis (cel mai slab) → albastru → verde →
    // chihlimbar → violet (cel mai bun). Cinci trepte de nuanță bine separate,
    // ca diferența dintre o zonă slabă și una bună să sară în ochi. Roșul e
    // rezervat exclusiv zonelor excluse (UAT / patrimoniu), ca legenda să nu
    // fie ambiguă. Aceeași rampă e în .archeo-pot-heatbar (css/styles.css).
    // Opririle rampei sunt aliniate cu pragurile de clasificare (CONFIG.CLASSIFY),
    // ca legenda să fie literalmente adevărată: 25% = trecerea Low → Medium
    // (albastru), 55% = trecerea Medium → High (verde), apoi chihlimbar și violet.
    // Aceleași procente apar și în .archeo-pot-heatbar (css/styles.css) și în
    // legenda stratului din index.html.
    var HEAT_GRADIENT = {
        0.00: '#10233f',
        0.25: '#1f7fc4',
        0.55: '#23c48e',
        0.75: '#f2b134',
        1.00: '#8b3ff0'
    };

    var _heatRampLut = null;
    function heatRampLut() {
        if (!_heatRampLut) _heatRampLut = buildHeatRamp(HEAT_GRADIENT);
        return _heatRampLut;
    }

    function scoreColorRgb(score) {
        var lut = heatRampLut();
        var i = Math.round(clamp01(score) * 255) * 4;
        return [lut[i], lut[i + 1], lut[i + 2]];
    }

    function scoreColorHex(score) {
        var c = scoreColorRgb(score);
        var out = '#';
        for (var i = 0; i < 3; i++) {
            var h = c[i].toString(16);
            out += (h.length < 2 ? '0' : '') + h;
        }
        return out;
    }

    // 'rgb(r,g,b)' — folosit în popup (stele, procent, bulă de culoare).
    function scoreColor(score) {
        var c = scoreColorRgb(score);
        return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    }

    // ── 5-star rating ───────────────────────────────────────────────────────
    // 5 gray stars with a colored overlay clipped to `score × 100%` — so the
    // number of lit stars equals the score (e.g. 0.72 → 3.6/5 stars) and the
    // color itself also reflects the score (heat scale, see scoreColor()).
    function starRatingHtml(score) {
        var pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
        var color = scoreColor(score);
        var stars = '★★★★★';
        return '<span style="display:inline-flex;align-items:center;gap:8px">' +
            '<span style="position:relative;display:inline-block;font-size:1.05rem;line-height:1;letter-spacing:2px">' +
            '<span style="color:rgba(245,240,235,0.18)">' + stars + '</span>' +
            '<span style="position:absolute;left:0;top:0;width:' + pct + '%;overflow:hidden;white-space:nowrap;color:' + color + '">' + stars + '</span>' +
            '</span>' +
            '<span style="font-size:0.8rem;font-weight:700;color:' + color + '">' + (score * 5).toFixed(1) + '/5</span>' +
            '</span>';
    }

    function popupHtml(c, idx) {
        // Trei trepte, identice cu legenda: Low (< 25%), Medium (25–55%),
        // High (≥ 55%) — iar culoarea textului/stelelor e culoarea rampei pentru
        // scorul exact al celulei (aceeași cu a bulei și cu a heatmap-ului).
        var tier = classifyTier(c.score);
        var cls = tier === 'high' ? tr('class_high') : (tier === 'medium' ? tr('class_medium') : tr('class_low'));
        var color = scoreColor(c.score);
        var pct = Math.round(c.score * 100);
        var factors = c.factors || {};
        var cellLine = c.radiusM
            ? tr('cell') + ': <strong style="color:' + color + '">' + c.radiusM + ' m</strong> ' +
              tr('radius') + '<br>'
            : (c.cellM ? tr('cell') + ': <strong style="color:' + color + '">' + c.cellM + ' m</strong><br>' : '');
        return '<div style="font-family:Outfit,sans-serif;min-width:215px;padding:2px">' +
            '<div style="font-family:Cinzel,serif;font-size:0.85rem;color:#c4a0f0;font-weight:700;margin-bottom:8px">' +
            '🔎 ' + tr('candidate') + ' #' + idx + '</div>' +
            '<div style="font-size:0.78rem;color:rgba(245,240,235,0.9);margin-bottom:7px">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + color + '"></span>' +
            '<strong>' + cls + '</strong> — ' + pct + '%</div>' +
            '<div style="margin-bottom:8px">' + starRatingHtml(c.score) + '</div>' +
            '<div style="font-size:0.72rem;color:rgba(245,240,235,0.65);line-height:1.7">' +
            '📍 ' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + '<br>' +
            cellLine +
            tr('closest_site') + ': <strong style="color:' + color + '">' + factors.closestSiteM + ' m</strong><br>' +
            tr('nearby') + ': ' + factors.nearbyCount + ' &nbsp;·&nbsp; ' +
            tr('avg_dist') + ': ' + factors.avgDistM + ' m<br>' +
            tr('density') + ': ' + factors.densityCount + ' &nbsp;·&nbsp; ' +
            tr('tri_quality') + ': ' + Number(factors.triQuality || 0).toFixed(2) + '</div>' +
            // Traseu Google Maps: destinația e centrul bulei (c.lat/c.lng) —
            // pentru raze mari (până la 10 km) traseul duce exact în mijlocul zonei.
            (function () {
                var dir = (typeof window !== 'undefined' && window.DetectLabDirections && window.DetectLabDirections.buttonHtml)
                    ? window.DetectLabDirections.buttonHtml(c.lat, c.lng)
                    : '';
                return dir ? '<div style="margin-top:6px">' + dir + '</div>' : '';
            })() +
            '</div>';
    }

    // Conținutul popup-ului ca funcție — Leaflet îl apelează doar la deschidere.
    function makePopupContent(c, idx) {
        return function () { return popupHtml(c, idx); };
    }

    /* ── curățarea rezultatelor anterioare ───────────────────────────────── */
    function clearRendered(map) {
        if (!map) return;
        if (_layerGroup) { try { map.removeLayer(_layerGroup); } catch (e) {} _layerGroup = null; }
        if (_heatLayer) {
            try { map.removeLayer(_heatLayer); } catch (e) {}
            try {
                // onRemove dezlipește canvas-ul; aici e doar plasa de siguranță
                // pentru hărțile-fantomă din teste (removeLayer fără onRemove).
                var heatCanvas = _heatLayer._canvas;
                var parent = heatCanvas && (heatCanvas.parentNode || heatCanvas.parentElement);
                if (parent && parent.removeChild) parent.removeChild(heatCanvas);
            } catch (e) {}
            _heatLayer = null;
        }
        _heatRaster = null;
        if (_maskGroup) { try { map.removeLayer(_maskGroup); } catch (e) {} _maskGroup = null; }
    }

    /* ── aria de lucru: cercul razei + punctul central ───────────────────── */
    function renderWorkingArea(map, ctx, group) {
        if (!CONFIG.SHOW_WORKING_AREA) return;
        var style = CONFIG.PIN || {};
        group.addLayer(L.circle([ctx.centerLat, ctx.centerLng], assignPane(map, {
            radius: ctx.radius,
            color: style.COLOR || '#a070e8',
            weight: 1.4,
            dashArray: '6 6',
            fillColor: style.COLOR || '#a070e8',
            fillOpacity: 0.03,
            opacity: 0.5,
            interactive: false
        }, 'pane_archeo')));

        group.addLayer(L.circleMarker([ctx.centerLat, ctx.centerLng], assignPane(map, {
            radius: 4,
            color: style.COLOR || '#a070e8',
            weight: 1.5,
            fillColor: style.FILL || '#c4a0f0',
            fillOpacity: 0.9,
            interactive: false
        }, 'pane_archeo')));

        if (CONFIG.SHOW_TRIANGULATION && ctx.triangles) {
            ctx.triangles.forEach(function (t) {
                group.addLayer(L.polyline(
                    [[t.a.lat, t.a.lng], [t.b.lat, t.b.lng], [t.c.lat, t.c.lng], [t.a.lat, t.a.lng]],
                    assignPane(map, { color: 'rgba(163,112,232,0.55)', weight: 1, interactive: false }, 'pane_archeo')
                ));
            });
        }
    }

    /* ── MODUL 1: bule rare, fără suprapuneri ────────────────────────────────
     * Se desenează doar celulele alese de selectBubbles(), fiecare cu raza ei
     * reală (deja limitată de distanța până la masca roșie). Rezultatul: bule
     * aerisite, care nu se ating între ele și nu intră peste razele siturilor. */
    function renderBubbles(map, field, group) {
        var renderer = bubbleRendererOption(map);
        var bubbles = field.bubbles || [];
        bubbles.forEach(function (c, idx) {
            var style = styleFor(c.score);
            var options = assignPane(map, {
                radius: c.radiusM,
                color: style.color,
                weight: style.weight,
                opacity: style.opacity,
                fillColor: style.fillColor,
                fillOpacity: style.fillOpacity,
                stroke: style.weight > 0.9
            }, 'pane_archeo');
            if (renderer) options.renderer = renderer;
            var circle = L.circle([c.lat, c.lng], options);
            // Popup construit leneș (funcție, nu șir): cu sute de bule, șirurile
            // eager ar aloca HTML nefolosit la fiecare rulare.
            if (circle.bindPopup) circle.bindPopup(makePopupContent(c, idx + 1));
            group.addLayer(circle);
        });
    }

    /* ── MODUL 2: heatmap = raster de scoruri ancorat în geografie ───────────
     * Canvas propriu, cu exact contractul canvas-urilor Patrimoniu din
     * map-app.js (același tip de suprafață, deja testat în
     * test-patrimoniu-canvas-transform.js):
     *   • la fiecare vedere așezată (move/moveend/zoom/zoomend/viewreset/
     *     resize) canvas-ul e pus la colțul viewport-ului în layer points, iar
     *     rasterul e desenat scalat între colțurile GEOGRAFICE ale grilei —
     *     deci nu plutește niciodată față de hartă la zoom;
     *   • în timpul animației de zoom (zoomanim / pinch) elementul primește
     *     transformata de renderer (scalare în jurul ancorei bitmap-ului), ca
     *     restul hărții, apoi e redesenat la zoom-ul final.
     * Înlocuiește leaflet-heat: acela repoziționa canvas-ul doar la moveend,
     * își repoziționa blob-urile într-o grilă de pixeli la fiecare redraw și
     * folosea o rază în pixeli trunchiată — trei surse de „alunecare” la zoom.
     * Iar culoarea nu mai e alfa acumulat, ci scorul celulei (vezi 7c). */

    var HEAT_REDRAW_EVENTS = ['move', 'moveend', 'zoom', 'zoomend', 'viewreset', 'resize'];

    // Poziția/transformata canvas-ului, scrise direct pe element. Leaflet face
    // același lucru prin L.DomUtil (translate3d, opțional scale); îl ținem
    // local ca să fie identic în browser și în testele Node.
    function setCanvasPosition(el, point) {
        if (!el || !el.style) return;
        el._leaflet_pos = point;
        el.style.transform = 'translate3d(' + point.x + 'px,' + point.y + 'px,0)';
    }

    function setCanvasTransform(el, point, scale) {
        if (!el || !el.style) return;
        el._leaflet_pos = point;
        el.style.transform = 'translate3d(' + point.x + 'px,' + point.y + 'px,0)' +
            (scale && scale !== 1 ? ' scale(' + scale + ')' : '');
    }

    function createCanvasEl(w, h) {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
        var canvas = document.createElement('canvas');
        if (!canvas || typeof canvas.getContext !== 'function') return null;
        canvas.width = w;
        canvas.height = h;
        return canvas;
    }

    // Rasterul de scoruri, ca imagine sursă de cols × rows px (redimensionată
    // de canvas la desenare — de aici aspectul neted, fără „trepte”).
    //
    // ORIENTAREA N–S (sursa vechiului „heatmap oglindit, cu zone goale care nu
    // sunt nici UAT, nici razele siturilor”): rândul 0 al rasterului e
    // marginea SUDICĂ a grilei (buildFieldCells indexează row 0 la minLat),
    // iar rândul 0 al imaginii e partea de SUS a bitmap-ului — pe care
    // redraw() o ancorează la bbox.maxLat (NORD). Rândurile se copiază
    // inversate, ca culoarea unei celule să cadă la latitudinea ei reală:
    // identic cu bulele (aceleași culori, pe aceeași poziție) și cu masca
    // roșie desenată la coordonatele corecte.
    function createHeatSourceCanvas(raster) {
        if (!raster || !raster.cols || !raster.rows || !raster.rgba) return null;
        var canvas = createCanvasEl(raster.cols, raster.rows);
        if (!canvas) return null;
        var ctx = canvas.getContext('2d');
        if (!ctx || typeof ctx.createImageData !== 'function') return null;
        var img = ctx.createImageData(raster.cols, raster.rows);
        if (!img || !img.data) return canvas;
        var rowBytes = raster.cols * 4;
        for (var r = 0; r < raster.rows; r++) {
            img.data.set(raster.rgba.subarray((raster.rows - 1 - r) * rowBytes, (raster.rows - r) * rowBytes), r * rowBytes);
        }
        if (typeof ctx.putImageData === 'function') ctx.putImageData(img, 0, 0);
        return canvas;
    }

    // Layer point FĂRĂ rotunjirea la pixel întreg a lui latLngToLayerPoint:
    // bitmap-ul e scalat CSS în timpul zoom-ului, deci o jumătate de pixel
    // înglobată în desen e înmulțită cu scara și apare ca o alunecare.
    function layerPointUnrounded(map, latlng) {
        if (typeof map.project === 'function') {
            var origin = (typeof map.getPixelOrigin === 'function' && map.getPixelOrigin()) || { x: 0, y: 0 };
            var p = map.project(latlng, map.getZoom());
            return { x: p.x - origin.x, y: p.y - origin.y };
        }
        var lp = map.latLngToLayerPoint(latlng);
        return { x: lp.x, y: lp.y };
    }

    function heatPaneEl(map) {
        var pane = (map.getPane && map.getPane('pane_archeo_heat')) || null;
        if (pane) return pane;
        var container = map.getContainer && map.getContainer();
        return (container && container.querySelector) ? container.querySelector('.leaflet-map-pane') : null;
    }

    var heatLayerProto = {
        initialize: function (raster, options) {
            this.options = options || {};
            this._raster = raster || null;
            this._srcCanvas = null;
            this._canvas = null;
            this._ctx = null;
            this._map = null;
            this._anchor = null;   // originea bitmap-ului în pixeli de proiectare
            this._zoom = null;     // zoom-ul pentru care a fost desenat
            this._frame = null;
            this._lastFrame = null;
            var self = this;
            this._handlers = {
                redraw: function () { self.scheduleRedraw(); },
                zoomanim: function (e) { self.applyZoomTransform(e); },
                pinch: function (e) {
                    if (!e || !e.pinch || !self._map) return;
                    self.applyZoomTransform({ center: self._map.getCenter(), zoom: self._map.getZoom() });
                }
            };
            this._srcCanvas = createHeatSourceCanvas(this._raster);
        },

        onAdd: function (map) {
            this._map = map;
            if (!this.ensureCanvas()) return;
            var pane = heatPaneEl(map);
            if (pane && pane.appendChild && this._canvas.parentNode !== pane) pane.appendChild(this._canvas);
            this.bindMap(map);
            this.redraw();
        },

        onRemove: function (map) {
            this.unbindMap(map);
            this._frame = null;
            var parent = this._canvas && this._canvas.parentNode;
            if (parent && parent.removeChild) parent.removeChild(this._canvas);
            this._map = null;
            this._lastFrame = null;
        },

        ensureCanvas: function () {
            if (!this._canvas) {
                this._canvas = createCanvasEl(1, 1);
                if (!this._canvas) return false;
                // leaflet-zoom-animated: transformata de zoomanim e tranziționată
                // odată cu restul hărții (regula CSS e activă doar în zoom).
                this._canvas.className = 'leaflet-heatmap-layer leaflet-zoom-animated';
                if (this._canvas.style) {
                    this._canvas.style.position = 'absolute';
                    this._canvas.style.top = '0';
                    this._canvas.style.left = '0';
                    this._canvas.style.pointerEvents = 'none';
                }
                this._ctx = this._canvas.getContext('2d');
            }
            if (!this._srcCanvas && this._raster) this._srcCanvas = createHeatSourceCanvas(this._raster);
            return !!this._ctx;
        },

        setRaster: function (raster) {
            this._raster = raster || null;
            this._srcCanvas = createHeatSourceCanvas(this._raster);
            this._anchor = null;
            this._zoom = null;
            this.redraw();
        },

        bindMap: function (map) {
            if (!map || typeof map.on !== 'function' || this._bound) return;
            this._bound = true;
            var self = this;
            HEAT_REDRAW_EVENTS.forEach(function (type) { map.on(type, self._handlers.redraw); });
            map.on('zoomanim', this._handlers.zoomanim);
            map.on('zoom', this._handlers.pinch);
        },

        unbindMap: function (map) {
            if (!map || typeof map.off !== 'function' || !this._bound) return;
            this._bound = false;
            var self = this;
            HEAT_REDRAW_EVENTS.forEach(function (type) { map.off(type, self._handlers.redraw); });
            map.off('zoomanim', this._handlers.zoomanim);
            map.off('zoom', this._handlers.pinch);
        },

        scheduleRedraw: function () {
            var self = this;
            if (this._frame !== null || !this._canvas) return;
            this._frame = raf(function () {
                self._frame = null;
                if (!self._map || !self._canvas) return;
                self.redraw();
            });
        },

        // Redesenare la vedere așezată: repoziționare în layer points + rasterul
        // desenat între colțurile geografice ale grilei.
        redraw: function () {
            var map = this._map;
            if (!map || !this._canvas || !this._ctx) return;
            // În timpul animației CSS de zoom / pinch nu redesenăm: bitmap-ul e
            // transformat de applyZoomTransform() odată cu restul hărții.
            if (map._animatingZoom) return;
            if (map.touchZoom && map.touchZoom._zooming) return;
            var size = (typeof map.getSize === 'function' && map.getSize()) || null;
            if (!size) return;
            if (this._canvas.width !== size.x) this._canvas.width = size.x;
            if (this._canvas.height !== size.y) this._canvas.height = size.y;

            var topLeft = map.containerPointToLayerPoint([0, 0]);
            setCanvasPosition(this._canvas, topLeft);   // curăță orice transform de zoom
            this._zoom = map.getZoom();
            var origin = (typeof map.getPixelOrigin === 'function' && map.getPixelOrigin()) || { x: 0, y: 0 };
            this._anchor = { x: origin.x + topLeft.x, y: origin.y + topLeft.y };

            var ctx = this._ctx;
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            if (!this._srcCanvas || !this._raster || !this._raster.bbox) return;
            var bbox = this._raster.bbox;
            var nw = layerPointUnrounded(map, { lat: bbox.maxLat, lng: bbox.minLng });
            var se = layerPointUnrounded(map, { lat: bbox.minLat, lng: bbox.maxLng });
            var x = nw.x - topLeft.x;
            var y = nw.y - topLeft.y;
            var w = se.x - nw.x;
            var h = se.y - nw.y;
            if (!(w > 0) || !(h > 0)) return;

            if (typeof ctx.save === 'function') ctx.save();
            ctx.globalAlpha = (typeof this.options.opacity === 'number') ? this.options.opacity : 0.8;
            if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
            if ('mozImageSmoothingEnabled' in ctx) ctx.mozImageSmoothingEnabled = true;
            if ('webkitImageSmoothingEnabled' in ctx) ctx.webkitImageSmoothingEnabled = true;
            ctx.drawImage(this._srcCanvas, x, y, w, h);
            if (typeof ctx.restore === 'function') ctx.restore();

            this._lastFrame = {
                topLeft: { x: topLeft.x, y: topLeft.y },
                x: x, y: y, w: w, h: h,
                zoom: this._zoom,
                anchor: { x: this._anchor.x, y: this._anchor.y },
                transform: this._canvas.style ? this._canvas.style.transform : null
            };
        },

        // Transformata de animație de zoom — aceeași formă ca
        // _updateCanvasTransform() din map-app.js: scalare în jurul ancorei
        // bitmap-ului (pixelOrigin + topLeft), nu în jurul centrului proiectat.
        applyZoomTransform: function (e) {
            var map = this._map;
            if (!map || !this._canvas || !this._anchor || this._zoom == null) return;
            if (!e || e.center == null || e.zoom == null) return;
            if (typeof map.getZoomScale !== 'function' || typeof map._getNewPixelOrigin !== 'function') return;
            var scale = map.getZoomScale(e.zoom, this._zoom);
            var npo = map._getNewPixelOrigin(e.center, e.zoom);
            setCanvasTransform(this._canvas, {
                x: Math.round(this._anchor.x * scale - npo.x),
                y: Math.round(this._anchor.y * scale - npo.y)
            }, scale);
        },

        // 3D (js/map3d-mirror.js → MapLibre image source, draped over terrain):
        // the SAME colourised raster the 2D canvas paints, as a PNG, with the
        // grid's geographic corners. _srcCanvas is already north-up, so the
        // picture needs no further flip. Encoded once per raster.
        _dl3dImage: function () {
            var raster = this._raster;
            if (!raster || !raster.bbox || !raster.cols || !raster.rows) return null;
            if (!this._srcCanvas) this._srcCanvas = createHeatSourceCanvas(raster);
            var src = this._srcCanvas;
            if (!src || typeof src.toDataURL !== 'function') return null;
            if (raster._dl3dUrl === undefined) {
                try { raster._dl3dUrl = src.toDataURL('image/png'); }
                catch (e) { raster._dl3dUrl = null; }
            }
            if (!raster._dl3dUrl) return null;
            var b = raster.bbox;
            return {
                url: raster._dl3dUrl,
                coordinates: [
                    [b.minLng, b.maxLat], [b.maxLng, b.maxLat],
                    [b.maxLng, b.minLat], [b.minLng, b.minLat]
                ]
            };
        }
    };

    var _HeatLayerClass = null;

    // În browser e un L.Layer real (map.addLayer/removeLayer, onAdd/onRemove).
    // Fără L.Layer (teste Node) e același obiect, cu un addTo minim.
    function makeHeatLayer(raster, options) {
        if (typeof L !== 'undefined' && L.Layer && typeof L.Layer.extend === 'function') {
            if (!_HeatLayerClass) _HeatLayerClass = L.Layer.extend(heatLayerProto);
            return new _HeatLayerClass(raster, options);
        }
        var inst = Object.create(heatLayerProto);
        heatLayerProto.initialize.call(inst, raster, options);
        inst.addTo = function (map) {
            if (map && typeof map.addLayer === 'function') map.addLayer(this);
            else this.onAdd(map);
            return this;
        };
        return inst;
    }

    function renderHeat(map, field) {
        if (!field || !field.results.length) return;
        var raster = buildHeatRaster(field);
        if (!raster) return;
        // gradient: aceeași rampă în 3D ca în 2D. Oportul o citește din
        // options (contractul leaflet.heat: {stop: culoare CSS}), iar MapLibre
        // îl traduce în rampă heatmap-color — fără ea, heatmap-ul 3D ar
        // desena albastru→roșu în locul albastru→verde→galben→violet.
        var layer = makeHeatLayer(raster, {
            name: 'Archeological Potential Sites — heatmap',
            opacity: CONFIG.HEAT.OPACITY,
            gradient: HEAT_GRADIENT,
            radius: Math.max(6, (raster.cellM || 180) / 2),
            max: 1
        });
        if (!layer) return;
        _heatLayer = layer;
        _heatRaster = raster;
        if (typeof layer.addTo === 'function') layer.addTo(map);
        else if (typeof map.addLayer === 'function') map.addLayer(layer);
    }

    // Celulele excluse de UAT sunt unite pe rânduri (run-length) în dreptunghiuri,
    // ca masca roșie să aibă câteva sute de forme în loc de câteva mii.
    function uatMaskRectangles(field) {
        var byRow = {};
        field.excluded.forEach(function (c) {
            if (c.reason !== 'uat') return;
            (byRow[c.row] = byRow[c.row] || []).push(c);
        });
        var rects = [];
        var halfCellLat = field.grid.cellLat / 2;
        var halfCellLng = field.grid.cellLng / 2;
        Object.keys(byRow).forEach(function (rowKey) {
            var cells = byRow[rowKey].sort(function (a, b) { return a.col - b.col; });
            var run = null;
            var flush = function () {
                if (!run) return;
                rects.push([
                    [run.minLat - halfCellLat, run.minLng - halfCellLng],
                    [run.maxLat + halfCellLat, run.maxLng + halfCellLng]
                ]);
                run = null;
            };
            cells.forEach(function (c) {
                if (run && c.col === run.lastCol + 1) {
                    run.lastCol = c.col;
                    run.minLat = Math.min(run.minLat, c.lat); run.maxLat = Math.max(run.maxLat, c.lat);
                    run.minLng = Math.min(run.minLng, c.lng); run.maxLng = Math.max(run.maxLng, c.lng);
                } else {
                    flush();
                    run = { lastCol: c.col, minLat: c.lat, maxLat: c.lat, minLng: c.lng, maxLng: c.lng };
                }
            });
            flush();
        });
        return rects;
    }

    function renderExclusionMask(map, field, ctx) {
        var M = CONFIG.MASK || {};
        var group = L.layerGroup([]);
        var renderer = maskRendererOption(map);

        // 1. intravilan UAT (celule picate pe rasterul non-roșu)
        uatMaskRectangles(field).forEach(function (bounds) {
            var options = assignPane(map, {
                color: M.COLOR || '#e03c3c',
                weight: 0.6,
                opacity: M.OPACITY === undefined ? 0.75 : M.OPACITY,
                fillColor: M.FILL || '#c0392b',
                fillOpacity: M.FILL_OPACITY_UAT === undefined ? 0.34 : M.FILL_OPACITY_UAT,
                interactive: false,
                stroke: false
            }, 'pane_archeo_mask');
            if (renderer) options.renderer = renderer;
            group.addLayer(L.rectangle(bounds, options));
        });

        // 2. razele de protecție ale siturilor cunoscute (600 m + 100 m buffer)
        var siteRadius = (ctx.siteRadius || CONFIG.SITE_RADIUS_M) + (ctx.siteBuffer || CONFIG.SITE_BUFFER_M);
        (ctx.sites || []).forEach(function (s) {
            if (s.isGuard) return; // gărzile de poligon ar umple harta cu cercuri
            var options = assignPane(map, {
                radius: siteRadius,
                color: M.COLOR || '#e03c3c',
                weight: 1,
                opacity: 0.6,
                fillColor: M.FILL || '#c0392b',
                fillOpacity: M.FILL_OPACITY_SITE === undefined ? 0.2 : M.FILL_OPACITY_SITE,
                interactive: false
            }, 'pane_archeo_mask');
            if (renderer) options.renderer = renderer;
            group.addLayer(L.circle([s.lat, s.lng], options));
        });

        // 3. contururile siturilor poligon (layer 6)
        (ctx.polygons || []).forEach(function (poly) {
            poly.rings.forEach(function (ring) {
                var latlngs = ring.map(function (p) {
                    var ll = localMetersToLatLng(p.x, p.y, ctx.centerLat);
                    return [ll.lat, ll.lng];
                });
                var options = assignPane(map, {
                    color: M.COLOR || '#e03c3c',
                    weight: 1.2,
                    opacity: 0.8,
                    fillColor: M.FILL || '#c0392b',
                    fillOpacity: 0.3,
                    interactive: false
                }, 'pane_archeo_mask');
                if (renderer) options.renderer = renderer;
                group.addLayer(L.polygon(latlngs, options));
            });
        });

        _maskGroup = group;
        if (_resultsVisible) group.addTo(map);
    }

    /* ── 3D: aceeași ieșire, ca forme la sol (js/map3d-mirror.js) ───────────
     * Bulele și masca roșie sunt L.circle / L.rectangle / L.polygon. În MapLibre,
     * `circle-radius` e în PIXELI: o bulă de 420 m ajungea în 3D ca un punct de
     * 420 px la orice zoom, iar inelele roșii de 700 m ca puncte de 700 px. Copia
     * 3D se construiește deci în METRI la sol: fiecare cerc devine un poligon cu
     * 32 de laturi (aceeași construcție ca cercurile patrimoniului de 600 m din
     * js/map-app.js, și aceeași rază pe care o citește L.circle), care se
     * drapează pe teren și se scalează odată cu harta. Culorile și opacitățile
     * vin din aceleași funcții de stil ca în 2D (styleFor, scoreColorHex).
     *
     * Copiii 2D ai grupurilor sunt marcați `_dl3dSkip`: Leaflet îi pune pe hartă
     * și individual, iar mirror-ul i-ar fi numărat a doua oară (ceea ce umplea
     * bugetul de 400 de elemente înainte de heatmap și de mască). */
    var CIRCLE_SEGMENTS_3D = 32;

    // Inelul unui cerc la sol, în ordinea GeoJSON ([lng, lat], închis). Pasul în
    // latitudine e r / 111 320 m, cel în longitudine e întins cu 1/cos(lat) —
    // exact ca L.circle, deci raza e aceeași în 2D și în 3D.
    function groundRing3d(lat, lng, radiusM) {
        var ring = [];
        var latRad = lat * Math.PI / 180;
        var dLat = radiusM / 111320;
        var dLng = radiusM / (111320 * Math.max(Math.abs(Math.cos(latRad)), 0.2));
        for (var i = 0; i < CIRCLE_SEGMENTS_3D; i++) {
            var a = (i / CIRCLE_SEGMENTS_3D) * Math.PI * 2;
            ring.push([lng + Math.sin(a) * dLng, lat + Math.cos(a) * dLat]);
        }
        ring.push(ring[0].slice());
        return ring;
    }

    // Inel dintr-un dreptunghi {[lat, lng], [lat, lng]} (colțurile SV și ND).
    function rectRing3d(bounds) {
        var s = bounds[0], n = bounds[1];
        return [
            [s[1], s[0]], [n[1], s[0]], [n[1], n[0]], [s[1], n[0]], [s[1], s[0]]
        ];
    }

    // Inel dintr-o listă de [lat, lng], închis pentru GeoJSON.
    function closedRing3d(latlngs) {
        var ring = (latlngs || []).map(function (p) { return [p[1], p[0]]; });
        if (ring.length) {
            var first = ring[0], last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first.slice());
        }
        return ring;
    }

    function feature3d(geometry, properties) {
        return { type: 'Feature', properties: properties, geometry: geometry };
    }

    // Bulele: același stil ca în 2D (culoarea din scor, aceleași trepte de
    // opacitate). Ca în 2D, o bulă fără contur (greutate ≤ 0.9) n-are linie.
    // Popup-ul e cel din 2D — stelele și procentul rămân la click și în 3D.
    function bubbleFeatures3d(bubbles) {
        return (bubbles || []).map(function (c, idx) {
            var style = styleFor(c.score);
            var stroke = style.weight > 0.9;
            return feature3d(
                { type: 'Polygon', coordinates: [groundRing3d(c.lat, c.lng, c.radiusM)] },
                {
                    fillColor: style.fillColor,
                    color: style.color,
                    fillOpacity: style.fillOpacity,
                    opacity: stroke ? style.opacity : 0,
                    popup: popupHtml(c, idx + 1)
                }
            );
        });
    }

    // Grupul de lucru: aria de căutare + centrul (+ triunghiurile, dacă e debug),
    // plus bulele când modul e „Bule”. `kind: 'radius'` = formă fără popup
    // (aceeași convenție ca cercurile patrimoniului).
    function workingAreaFeatures3d(ctx, field, drawBubbles) {
        var features = [];
        var style = CONFIG.PIN || {};
        var areaColor = style.COLOR || '#a070e8';
        if (CONFIG.SHOW_WORKING_AREA) {
            features.push(feature3d(
                { type: 'Polygon', coordinates: [groundRing3d(ctx.centerLat, ctx.centerLng, ctx.radius)] },
                { color: areaColor, fillColor: areaColor, fillOpacity: 0.03, opacity: 0.5, kind: 'radius' }
            ));
            features.push(feature3d(
                { type: 'Point', coordinates: [ctx.centerLng, ctx.centerLat] },
                { color: areaColor, fillColor: style.FILL || '#c4a0f0', fillOpacity: 0.9, opacity: 1, radius: 4, kind: 'radius' }
            ));
        }
        if (CONFIG.SHOW_TRIANGULATION && ctx.triangles) {
            ctx.triangles.forEach(function (t) {
                features.push(feature3d(
                    { type: 'LineString', coordinates: [
                        [t.a.lng, t.a.lat], [t.b.lng, t.b.lat], [t.c.lng, t.c.lat], [t.a.lng, t.a.lat]
                    ] },
                    { color: 'rgb(163,112,232)', opacity: 0.55, kind: 'radius' }
                ));
            });
        }
        if (drawBubbles) {
            bubbleFeatures3d(field.bubbles).forEach(function (f) { features.push(f); });
        }
        return {
            geojson: { type: 'FeatureCollection', features: features },
            paints: {
                line: { 'line-color': areaColor, 'line-width': 1, 'line-opacity': 1 },
                fill: { 'fill-color': areaColor, 'fill-opacity': 0.5 },
                circle: {
                    'circle-radius': 4, 'circle-color': style.FILL || '#c4a0f0',
                    'circle-stroke-color': areaColor, 'circle-stroke-width': 1.5,
                    'circle-stroke-opacity': 1, 'circle-opacity': 0.9
                },
                layout: {}
            },
            stamp: 'archeo-area|' + _renderSeq + '|' + (drawBubbles ? 'bubbles' : 'heat'),
            label: 'Archeological Potential Sites'
        };
    }

    // Masca roșie în 3D: aceleași trei familii ca în 2D — intravilanul UAT
    // (dreptunghiuri, fără contur), razele de protecție (cercuri la sol de
    // 700 m) și contururile siturilor-poligon. Nu are popup (non-interactivă).
    function exclusionFeatures3d(field, ctx) {
        var M = CONFIG.MASK || {};
        var red = M.COLOR || '#e03c3c';
        var redFill = M.FILL || '#c0392b';
        var features = [];
        uatMaskRectangles(field).forEach(function (bounds) {
            features.push(feature3d(
                { type: 'Polygon', coordinates: [rectRing3d(bounds)] },
                {
                    color: red, opacity: 0, fillColor: redFill,
                    fillOpacity: M.FILL_OPACITY_UAT === undefined ? 0.34 : M.FILL_OPACITY_UAT,
                    kind: 'exclusion'
                }
            ));
        });
        var siteRadius = (ctx.siteRadius || CONFIG.SITE_RADIUS_M) + (ctx.siteBuffer || CONFIG.SITE_BUFFER_M);
        (ctx.sites || []).forEach(function (s) {
            if (s.isGuard) return; // gărzile de poligon nu se desenează ca cercuri
            features.push(feature3d(
                { type: 'Polygon', coordinates: [groundRing3d(s.lat, s.lng, siteRadius)] },
                {
                    color: red, opacity: 0.6, fillColor: redFill,
                    fillOpacity: M.FILL_OPACITY_SITE === undefined ? 0.2 : M.FILL_OPACITY_SITE,
                    kind: 'exclusion'
                }
            ));
        });
        (ctx.polygons || []).forEach(function (poly) {
            poly.rings.forEach(function (ring) {
                var latlngs = ring.map(function (p) {
                    var ll = localMetersToLatLng(p.x, p.y, ctx.centerLat);
                    return [ll.lat, ll.lng];
                });
                features.push(feature3d(
                    { type: 'Polygon', coordinates: [closedRing3d(latlngs)] },
                    { color: red, opacity: 0.8, fillColor: redFill, fillOpacity: 0.3, kind: 'exclusion' }
                ));
            });
        });
        return {
            geojson: { type: 'FeatureCollection', features: features },
            paints: {
                line: { 'line-color': red, 'line-width': 1, 'line-opacity': 1 },
                fill: { 'fill-color': redFill, 'fill-opacity': 0.3 },
                circle: { 'circle-radius': 3, 'circle-color': redFill, 'circle-stroke-color': red, 'circle-stroke-width': 1, 'circle-opacity': 0.5 },
                layout: {}
            },
            stamp: 'archeo-mask|' + _renderSeq,
            label: 'Archeological exclusion (red)'
        };
    }

    // Grupul devine sursa 3D a propriilor forme (`_dl3dFeatures`, construit
    // leneș și păstrat până la următoarea randare), iar copiii 2D sunt săriți.
    // `name` e eticheta din panoul 3D (options.name are prioritate în mirror).
    function own3dFeatures(group, name, build) {
        if (!group) return;
        // Un grup fără eachLayer (stub, grup gol) nu trebuie să rupă randarea 2D.
        if (typeof group.eachLayer === 'function') {
            group.eachLayer(function (child) { child._dl3dSkip = true; });
        }
        group.options = group.options || {};
        group.options.name = name;
        var built = null;
        group._dl3dFeatures = function () {
            if (!built) built = build();
            return built;
        };
    }

    /* ── randarea completă a unei rulări ─────────────────────────────────── */
    function renderField(field) {
        var map = window._dlMap;
        if (!map || !field) return;
        ensurePane(map);
        clearRendered(map);
        _renderSeq += 1;

        var ctx = field.ctx;
        _layerGroup = L.layerGroup([]);
        renderWorkingArea(map, ctx, _layerGroup);

        // Modul de afișare e cel din UI, nu cel cu care a fost calculat câmpul:
        // comutarea Bule↔Heatmap redesenează imediat ultima analiză în noul mod
        // (altfel butoanele par să nu facă nimic până la următoarea „Detectează”).
        var drawBubbles = outputMode() !== 'heat';
        if (!drawBubbles) renderHeat(map, field);
        else renderBubbles(map, field, _layerGroup);

        // Masca roșie (intravilan UAT + razele de protecție + contururile
        // poligon) se desenează în AMBELE moduri: explică de ce există goluri
        // între bule și marchează zonele în care detectarea nu e permisă.
        renderExclusionMask(map, field, ctx);

        // 3D: grupul de lucru și masca primesc formele la sol; heatmap-ul se
        // trimite ca imagine prin _dl3dImage() (vezi heatLayerProto).
        own3dFeatures(_layerGroup, 'Archeological Potential Sites',
            function () { return workingAreaFeatures3d(ctx, field, drawBubbles); });
        own3dFeatures(_maskGroup, 'Archeological exclusion (red)',
            function () { return exclusionFeatures3d(field, ctx); });

        if (_resultsVisible) _layerGroup.addTo(map);
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 9. UI — status, i18n, main entry point
     * ═══════════════════════════════════════════════════════════════════════ */

    var I18N = {
        en: {
            run_btn: 'Detect',
            running_short: 'Analyzing',
            running_tiles: 'Loading the UAT raster… {p}%',
            running: 'Analyzing the {r} km area…',
            running_pin: 'Analyzing the {r} km area around the purple pin…',
            running_center: 'Analyzing the {r} km area around the map center…',
            progress: 'Analyzing… {p}%',
            ready: 'Set the radius (1–10 km) and press the button.',
            done: 'Analysis complete.',
            no_sites: 'Not enough archaeological sites in the area (need at least 3).',
            no_triangles: 'Sites are collinear / too clustered — no valid triangles.',
            no_candidates: 'No cell passed the filters (UAT built-up area / site radii). Try a different area.',
            no_bubbles: 'Every scored cell sits too close to the UAT built-up area or a heritage radius for a whole bubble to fit — switch to Heatmap to read the scores.',
            sparse_sites: 'Only {n} known site(s) in the area — the scores come from the site distances alone (no triangulation).',
            uat_unavailable: 'The UAT raster could not be read here ({n} tiles) — the built-up exclusion was skipped, so only the heritage radii stay red.',
            uat_partial: 'UAT raster missing for {n} tiles ({p}% of the area) — there the built-up exclusion was skipped.',
            error: 'Analysis failed — check the console for details.',
            cancelled: 'Analysis cancelled.',
            candidate: 'Candidate',
            cell: 'Cell',
            radius: 'radius',
            class_high: 'High Potential',
            class_medium: 'Medium Potential',
            class_low: 'Low Potential',
            nearby: 'Nearby sites',
            closest_site: 'Closest site',
            avg_dist: 'Avg. distance',
            density: 'Density',
            tri_quality: 'Triangle quality',
            summary: '{n} candidates · {h} High · {m} Medium',
            summary_field: '{n} bubbles ({h} High · {m} Medium · {l} Low) covering {c}% of the free ground · {s} scored cells · {x} excluded (red)',
            summary_heat: '{n} scored cells in the heatmap ({h} High · {m} Medium · {l} Low) · {x} excluded (red)',
            pin_set: 'Pin at {lat}, {lng} · radius {r} km — press “Detect”.',
            // Titlul + explicația afișate în fereastra de info a stratului
            // (butonul „i” din panou) — aceleași valori ca layer_archeo_potential /
            // archeo_hint din translations.js, mutate aici odată cu fereastra.
            info_title: 'Archeological Potential Sites',
            info_hint: 'Searches for locations with archaeological potential reported to the marked archaeological sites, based on a triangulation logic — colour = score, on one absolute scale shared with the bubbles and with the legend. Red = the UAT built-up area and the protection radii of the sites, where nothing is generated.'
        },
        ro: {
            run_btn: 'Detectează',
            running_short: 'Se analizează',
            running_tiles: 'Se încarcă rasterul UAT… {p}%',
            running: 'Se analizează raza de {r} km…',
            running_pin: 'Se analizează raza de {r} km din jurul pinului mov…',
            running_center: 'Se analizează raza de {r} km din jurul centrului hărții…',
            progress: 'Se analizează… {p}%',
            ready: 'Alege raza (1–10 km) și apasă butonul.',
            done: 'Analiză finalizată.',
            no_sites: 'Nu sunt suficiente situri arheologice în zonă (e nevoie de cel puțin 3).',
            no_triangles: 'Siturile sunt coliniare / prea grupate — fără triunghiuri valide.',
            no_candidates: 'Nicio celulă nu a trecut filtrele (intravilan UAT / razele siturilor). Încearcă altă zonă.',
            no_bubbles: 'Fiecare celulă cu scor e prea aproape de intravilanul UAT sau de o rază de protecție ca să încapă o bulă întreagă — treci pe Heatmap ca să vezi scorurile.',
            sparse_sites: 'Doar {n} sit(uri) cunoscute în zonă — scorurile vin numai din distanțele față de situri (fără triangulare).',
            uat_unavailable: 'Rasterul UAT nu a putut fi citit aici ({n} tile-uri) — excluderea intravilanului a fost sărită, deci rămân roșii doar razele siturilor.',
            uat_partial: 'Rasterul UAT lipsește pentru {n} tile-uri ({p}% din zonă) — acolo excluderea intravilanului a fost sărită.',
            error: 'Analiza a eșuat — vezi consola pentru detalii.',
            cancelled: 'Analiză anulată.',
            candidate: 'Candidat',
            cell: 'Celulă',
            radius: 'rază',
            class_high: 'Potențial Ridicat',
            class_medium: 'Potențial Mediu',
            class_low: 'Potențial Scăzut',
            nearby: 'Situri apropiate',
            closest_site: 'Situl cel mai apropiat',
            avg_dist: 'Distanță medie',
            density: 'Densitate',
            tri_quality: 'Calitate triunghi',
            summary: '{n} candidați · {h} Ridicat · {m} Mediu',
            summary_field: '{n} bule ({h} Ridicat · {m} Mediu · {l} Scăzut) care acoperă {c}% din terenul liber · {s} celule cu scor · {x} excluse (roșu)',
            summary_heat: '{n} celule în heatmap ({h} Ridicat · {m} Mediu · {l} Scăzut) · {x} excluse (roșu)',
            pin_set: 'Pin la {lat}, {lng} · rază {r} km — apasă „Detectează”.',
            // Titlul + explicația afișate în fereastra de info a stratului.
            info_title: 'Zone cu potențial arheologic',
            info_hint: 'Se cauta locatii cu potential arheologic raportate la siturile arheologice marcate, pe baza unei logici de triangulare — culoarea = scorul, pe o scară absolută comună cu bulele și cu legenda. Roșu = intravilanul UAT și razele de protecție ale siturilor, unde nu se generează nimic.'
        }
    };

    function tr(key) {
        var lang = (typeof window._currentLang === 'function') ? window._currentLang() : 'en';
        var dict = I18N[lang] || I18N.en;
        return dict[key] !== undefined ? dict[key] : I18N.en[key];
    }

    function el(id) { return document.getElementById(id); }

    var _lastStatus = { key: 'ready', isError: false, vars: null };

    function setStatus(key, isError, vars) {
        _lastStatus = { key: key, isError: !!isError, vars: vars || null };
        var statusEl = el('archeoPotStatus');
        if (!statusEl) return;
        var text = tr(key);
        if (vars) {
            Object.keys(vars).forEach(function (k) {
                text = String(text).split('{' + k + '}').join(vars[k]);
            });
        }
        statusEl.textContent = text;
        if (statusEl.classList && statusEl.classList.toggle) statusEl.classList.toggle('error', !!isError);
    }

    function setSummary(stats, mode) {
        var summaryEl = el('archeoPotSummary');
        if (!summaryEl) return;
        stats = stats || {};
        var n = stats.scored || 0;
        if (n > 0) {
            var excluded = (stats.excludedUat || 0) + (stats.excludedHeritage || 0);
            // Modul BULE numără bulele desenate, modul HEAT celulele scorate.
            var coverage = Math.round((stats.coverage || 0) * 100);
            var text = tr(mode === 'heat' ? 'summary_heat' : 'summary_field')
                .replace('{n}', mode === 'heat' ? n : (stats.bubbles || 0))
                .replace('{h}', mode === 'heat' ? (stats.high || 0) : (stats.bubblesHigh || 0))
                .replace('{m}', mode === 'heat' ? (stats.medium || 0) : (stats.bubblesMedium || 0))
                .replace('{l}', mode === 'heat' ? (stats.low || 0) : (stats.bubblesLow || 0))
                .replace('{c}', coverage)
                .replace('{s}', n)
                .replace('{x}', excluded);
            summaryEl.style.display = '';
            summaryEl.innerHTML = '<span style="color:#c4a0f0;font-weight:600">' + text + '</span>';
        } else {
            summaryEl.style.display = 'none';
            summaryEl.textContent = '';
        }
    }

    function setRunning(running) {
        var btn = el('archeoPotRunBtn');
        if (btn) {
            btn.disabled = running;
            btn.classList.toggle('running', running);
            // Keep a .t[data-key] span inside so future language switches
            // (window.setLang) still re-translate the button label.
            btn.innerHTML = running
                ? '<span class="archeo-spinner" aria-hidden="true"></span><span class="t" data-key="archeo_run_running">Analyzing…</span>'
                : '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="flex-shrink:0"><path d="M6.5 1.5 L10 6 L8 6 L10 11.5 L6.5 8.2 L3 11.5 L5 6 L3 6 Z" fill="#c4a0f0" /></svg><span class="t" data-key="archeo_run_btn">' + tr('run_btn') + '</span>';
        }
    }

    function updateRunButtonVisibility(show) {
        // Butonul e vizibil cât timp stratul e pornit — cu pin, analiza
        // pornește din pin; fără pin, din centrul hărții (logica de punct e
        // permanentă, deci butonul nu mai apare/dispare odată cu pinul).
        if (show === undefined) show = _resultsVisible;
        var btn = el('archeoPotRunBtn');
        if (btn) {
            if (btn.style) btn.style.display = show ? '' : 'none';
            if (btn.classList && typeof btn.classList.toggle === 'function') {
                btn.classList.toggle('is-hidden', !show);
            }
        }
        try {
            if (window.DetectLabVerticalOpacity && typeof window.DetectLabVerticalOpacity.refreshDock === 'function') {
                window.DetectLabVerticalOpacity.refreshDock();
            }
        } catch (e) {}
    }

    function yieldToUI() {
        return new Promise(function (resolve) {
            setTimeout(resolve, 0);
        });
    }

    function chunk(array, size) {
        var out = [];
        for (var i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
        return out;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 9b. PIN MOV + RAZĂ 1–10 KM + MOD DE AFIȘARE (bule / heatmap)
     * ═══════════════════════════════════════════════════════════════════════
     * Logica de punct pe hartă e PERMANENTĂ (nu mai există switch-ul de pin):
     * cât timp stratul e pornit cu comutatorul mare, un tap pe hartă pune
     * pinul mov (ca identitatea stratului) și cercul razei, iar sliderul
     * 1–10 km redimensionează cercul în timp real. Fără pin, analiza pornește
     * din centrul hărții. */

    var _pinMode = false;
    var _clickArmed = false;  // handler-ul de tap pe hartă e deja atasat
    var _pinLatLng = null;
    var _pinMarker = null;
    var _pinCircle = null;
    var _pinRenderer = null;
    var _mode = null;                 // null → CONFIG.FIELD.MODE
    var _draggingRadius = false;

    var raf = (typeof window !== 'undefined' && window.requestAnimationFrame &&
        window.requestAnimationFrame.bind(window)) || function (fn) { return setTimeout(fn, 16); };

    function outputMode() {
        if (_mode === 'heat' || _mode === 'bubbles') return _mode;
        return CONFIG.FIELD.MODE === 'heat' ? 'heat' : 'bubbles';
    }

    function radiusKm() {
        var slider = el('archeoPotDistance');
        var value = slider ? parseFloat(slider.value) : NaN;
        if (!isFinite(value)) value = CONFIG.RADIUS_KM_DEFAULT;
        return Math.max(CONFIG.RADIUS_KM_MIN, Math.min(CONFIG.RADIUS_KM_MAX, value));
    }

    function currentRadiusM() {
        return radiusKm() * 1000;
    }

    function setRadiusKm(km) {
        var slider = el('archeoPotDistance');
        var value = Math.max(CONFIG.RADIUS_KM_MIN, Math.min(CONFIG.RADIUS_KM_MAX, Number(km) || CONFIG.RADIUS_KM_DEFAULT));
        if (slider) {
            slider.value = String(value);
            if (typeof slider.dispatchEvent === 'function') {
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        updateRadiusLabel(value);
        if (_pinLatLng) drawPinCircle(_pinLatLng, false);
        return value;
    }

    function updateRadiusLabel(km) {
        var label = el('archeoPotDistanceValue');
        if (label) label.textContent = (km === undefined ? radiusKm() : km) + ' km';
    }

    /**
     * Legenda e pictată din COD, nu din CSS static: bucățile de culoare folosesc
     * exact scoreColorHex() pe scorurile de referință ale treptelor, bara de heat
     * folosește opririle HEAT_GRADIENT, iar pragurile afișate sunt cele din
     * CONFIG.CLASSIFY. Astfel legenda rămâne adevărată și dacă rampa sau pragurile
     * sunt schimbate live din consolă.
     */
    function syncLegend() {
        if (typeof document === 'undefined' || !document.querySelectorAll) return;
        var C = CONFIG.CLASSIFY;
        var lowPct = Math.round(C.SCORE_DISCARD_BELOW * 100);
        var highPct = Math.round(C.SCORE_HIGH_FROM * 100);
        var bands = {
            low: '< ' + lowPct + '%',
            medium: lowPct + '\u2013' + highPct + '%',
            high: '\u2265 ' + highPct + '%'
        };
        try {
            var swatches = document.querySelectorAll('[data-archeo-swatch]');
            for (var i = 0; i < swatches.length; i++) {
                var tier = swatches[i].getAttribute('data-archeo-swatch');
                var score = LEGEND_SCORES[tier];
                if (score === undefined) continue;
                var color = scoreColorHex(score);
                if (swatches[i].style) {
                    swatches[i].style.background = color;
                    swatches[i].style.boxShadow = '0 0 0 1px rgba(16,6,28,.65)';
                    swatches[i].setAttribute('title', tier + ' ' + bands[tier] + ' · ' + color);
                }
            }
            var bandEls = document.querySelectorAll('[data-archeo-band]');
            for (var b = 0; b < bandEls.length; b++) {
                var key = bandEls[b].getAttribute('data-archeo-band');
                if (bands[key] !== undefined) bandEls[b].textContent = bands[key];
            }
            var bar = document.getElementById('archeoPotHeatbar');
            if (bar && bar.style) {
                var stops = Object.keys(HEAT_GRADIENT).map(Number).sort(function (x, y) { return x - y; });
                bar.style.background = 'linear-gradient(90deg,' + stops.map(function (s) {
                    return HEAT_GRADIENT[s] + ' ' + Math.round(s * 100) + '%';
                }).join(',') + ')';
            }
        } catch (e) { /* teste DOM-minimale */ }
    }

    function setOutputMode(mode) {
        _mode = (mode === 'heat') ? 'heat' : 'bubbles';
        CONFIG.FIELD.MODE = _mode;
        var bubblesBtn = el('archeoPotModeBubbles');
        var heatBtn = el('archeoPotModeHeat');
        if (bubblesBtn && bubblesBtn.classList) bubblesBtn.classList.toggle('is-active', _mode === 'bubbles');
        if (heatBtn && heatBtn.classList) heatBtn.classList.toggle('is-active', _mode === 'heat');
        var legendBubbles = el('archeoPotLegendBubbles');
        var legendHeat = el('archeoPotLegendHeat');
        if (legendBubbles) legendBubbles.style.display = _mode === 'bubbles' ? 'flex' : 'none';
        if (legendHeat) legendHeat.style.display = _mode === 'heat' ? 'flex' : 'none';
        syncLegend();
        // Comutarea modului redesenează imediat ultima analiză (dacă există).
        if (_currentField) renderField(_currentField);
        return _mode;
    }

    function pinRendererOption(map) {
        if (!_pinRenderer) _pinRenderer = clickThroughCanvas(map, 'pane_archeo', 0.3);
        return _pinRenderer;
    }

    /* ── 3D: pinul + cercul lui, ca forme la sol ─────────────────────────────
     * Cercul pinului e un L.circle DE SINE STĂTĂTOR (nu copil al grupului de
     * lucru): fără punte, mirror-ul îl traducea prin toGeoJSON() — doar
     * centrul — cu raza în METRI citită ca PIXELI de MapLibre, deci un disc
     * mov de 1 000–10 000 px acoperea toată vederea 3D și bulele (mov la
     * scorurile mari) nu se mai distingeau de fundal. Puntea de mai jos îl
     * trimite în 3D ca poligon la sol pe raza curentă + punctul central, cu
     * aceleași culori ca în 2D; pinul-marker însuși e `_dl3dSkip` (e HTML
     * fără glif SVG, iar centrul e deja în punte). */
    var _pin3dCache = { stamp: '', value: null };
    function pinFeatures3d() {
        var latlng = null;
        if (_pinCircle && typeof _pinCircle.getLatLng === 'function') {
            try { latlng = _pinCircle.getLatLng(); } catch (e) { latlng = null; }
        }
        if (!latlng) latlng = _pinLatLng;
        if (!latlng || !isFinite(latlng.lat) || !isFinite(latlng.lng)) return null;
        var radiusM = currentRadiusM();
        if (_pinCircle && typeof _pinCircle.getRadius === 'function') {
            try {
                var live = Number(_pinCircle.getRadius());
                if (live > 0) radiusM = live;
            } catch (e) { /* keep the slider radius */ }
        }
        if (!(radiusM > 0)) return null;
        var idle = CONFIG.PIN.CIRCLE_IDLE;
        var stamp = 'archeo-pin|' + latlng.lat.toFixed(6) + '|' + latlng.lng.toFixed(6) + '|' + radiusM;
        if (_pin3dCache.stamp === stamp && _pin3dCache.value) return _pin3dCache.value;
        var built = {
            geojson: {
                type: 'FeatureCollection',
                features: [
                    feature3d(
                        { type: 'Polygon', coordinates: [groundRing3d(latlng.lat, latlng.lng, radiusM)] },
                        {
                            color: idle.color, fillColor: idle.fillColor,
                            fillOpacity: idle.fillOpacity, opacity: idle.opacity,
                            weight: idle.weight, kind: 'radius'
                        }
                    ),
                    feature3d(
                        { type: 'Point', coordinates: [latlng.lng, latlng.lat] },
                        {
                            color: idle.color, fillColor: CONFIG.PIN.FILL || '#c4a0f0',
                            fillOpacity: 0.9, opacity: 1, radius: 5, kind: 'radius'
                        }
                    )
                ]
            },
            paints: {
                line: {
                    'line-color': idle.color, 'line-width': idle.weight,
                    'line-opacity': idle.opacity, 'line-dasharray': [2, 2]
                },
                fill: { 'fill-color': idle.fillColor, 'fill-opacity': idle.fillOpacity },
                circle: {
                    'circle-radius': 5, 'circle-color': CONFIG.PIN.FILL || '#c4a0f0',
                    'circle-stroke-color': idle.color, 'circle-stroke-width': 1.5,
                    'circle-stroke-opacity': 1, 'circle-opacity': 0.9
                },
                layout: {}
            },
            stamp: stamp,
            label: 'Archeological Potential Sites'
        };
        _pin3dCache = { stamp: stamp, value: built };
        return built;
    }

    function attachPin3d(circle) {
        if (!circle) return;
        circle._dl3dFeatures = pinFeatures3d;
        if (circle.options) circle.options.name = 'Archeological Potential Sites';
    }

    function drawPinCircle(latlng, dragging) {
        var map = window._dlMap;
        if (!map || typeof L === 'undefined' || !L.circle) return;
        var style = dragging ? CONFIG.PIN.CIRCLE_DRAG : CONFIG.PIN.CIRCLE_IDLE;
        var radiusM = currentRadiusM();
        if (_pinCircle && _pinCircle.setLatLng && _pinCircle.setRadius) {
            _pinCircle.setLatLng(latlng);
            _pinCircle.setRadius(radiusM);
            if (_pinCircle.setStyle) _pinCircle.setStyle(style);
            return;
        }
        var options = assignPane(map, {
            radius: radiusM,
            color: style.color,
            weight: style.weight,
            dashArray: style.dashArray,
            fill: style.fill,
            fillColor: style.fillColor,
            fillOpacity: style.fillOpacity,
            opacity: style.opacity,
            interactive: false
        }, 'pane_archeo');
        var renderer = pinRendererOption(map);
        if (renderer) options.renderer = renderer;
        _pinCircle = L.circle(latlng, options);
        attachPin3d(_pinCircle);
        if (_pinCircle.addTo) _pinCircle.addTo(map);
        else if (map.addLayer) map.addLayer(_pinCircle);
    }

    function clearPinCircle() {
        var map = window._dlMap;
        if (map && _pinCircle && map.removeLayer) map.removeLayer(_pinCircle);
        _pinCircle = null;
    }

    // Pinul mov: aceeași anatomie ca pinul albastru al Raportului arheologic
    // (halou pulsant + punct central), în culoarea stratului.
    function drawPin(latlng) {
        var map = window._dlMap;
        if (!map) return;
        if (_pinMarker && map.removeLayer) map.removeLayer(_pinMarker);
        _pinLatLng = { lat: latlng.lat, lng: latlng.lng };
        try { window._dlSearchAreaPin = { lat: latlng.lat, lng: latlng.lng }; } catch (e) {}
        if (typeof L === 'undefined' || !L.marker || !L.divIcon) {
            drawPinCircle(latlng, false);
            return;
        }
        var icon = L.divIcon({
            className: 'archeo-pot-pin-wrapper',
            html: '<div class="archeo-pot-pin" title="' + tr('candidate') + '">' +
                  '<div class="archeo-pot-pin-pulse"></div><div class="archeo-pot-pin-dot"></div></div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });
        _pinMarker = L.marker(latlng, assignPane(map, { icon: icon, zIndexOffset: 2000, interactive: false }, 'pane_archeo_pin'));
        /* Centrul pinului ajunge în 3D prin puntea cercului (pinFeatures3d);
           markerul HTML singur ar deveni o etichetă fără punct. */
        _pinMarker._dl3dSkip = true;
        if (_pinMarker.addTo) _pinMarker.addTo(map);
        if (_pinMarker.bindTooltip) {
            _pinMarker.bindTooltip(
                '<span class="archeo-pot-tag"><b>' + tr('candidate') + '</b><br>' +
                latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4) + '</span>',
                assignPane(map, { direction: 'top', offset: [0, -14], className: 'archeo-pot-tooltip' }, 'pane_archeo_pin')
            );
        }
        drawPinCircle(latlng, false);
    }

    function clearPin() {
        var map = window._dlMap;
        if (map && _pinMarker && map.removeLayer) map.removeLayer(_pinMarker);
        _pinMarker = null;
        _pinLatLng = null;
        clearPinCircle();
    }

    function clickLayerPoint(map, e) {
        if (!e) return null;
        if (e.layerPoint && e.layerPoint.x != null && e.layerPoint.y != null) return e.layerPoint;
        if (e.latlng && map && typeof map.latLngToLayerPoint === 'function') {
            try { return map.latLngToLayerPoint(e.latlng); } catch (err) { return null; }
        }
        return null;
    }

    // Bulele sunt interactive (au popup), dar canvas-ul lor e click-through ca
    // să nu acopere pin-urile detectoriștilor. Leaflet cheamă click-ul hărții
    // doar dacă tap-ul n-a nimerit deja un marker, deci un pin de detectorist
    // din interiorul unei bule rămâne ținta. Aici reconstituim hit-test-ul pe
    // care rendererul nu-l mai primește: ultima bulă care conține punctul
    // (cea pictată deasupra), la fel ca Canvas._onClick.
    function bubbleUnderClick(e) {
        var map = window._dlMap;
        if (!_resultsVisible || !_layerGroup || !map) return null;
        if (typeof map.hasLayer === 'function' && !map.hasLayer(_layerGroup)) return null;
        if (typeof map._draggableMoved === 'function' && map._draggableMoved(map)) return null;
        if (typeof _layerGroup.eachLayer !== 'function') return null;
        var point = clickLayerPoint(map, e);
        if (!point) return null;
        var hit = null;
        _layerGroup.eachLayer(function (layer) {
            if (!layer || (layer.options && layer.options.interactive === false)) return;
            if (typeof layer._containsPoint !== 'function') return;
            try {
                if (layer._containsPoint(point)) hit = layer;
            } catch (err) {}
        });
        return hit;
    }

    function openArcheoBubble(layer, latlng) {
        if (!layer || typeof layer.openPopup !== 'function') return false;
        try {
            layer.openPopup(latlng);
            return true;
        } catch (err) {
            return false;
        }
    }

    function onMapClick(e) {
        if (window.dlApmPicking) return;   // APM point picking owns this map click
        if (!_pinMode || _runInFlight) return;
        // taps belong to the offline polygon while that is being drawn
        try { if (window._dlOfflineDrawActive) return; } catch (err) {}
        // Popup de bulă, nu mutare de pin: tap-ul a nimerit o zonă scorată.
        // Pin-urile detectoriștilor nu ajung aici (Leaflet nu propagă click-ul
        // de pe un marker interactiv până la hartă).
        if (openArcheoBubble(bubbleUnderClick(e), e && e.latlng)) return;
        var latlng = e && e.latlng ? e.latlng : null;
        if (!latlng) return;
        drawPin(latlng);
        setStatus('pin_set', false, {
            lat: latlng.lat.toFixed(5), lng: latlng.lng.toFixed(5), r: radiusKm()
        });
    }

    // Pornește/oprește logica de punct pe hartă. E permanentă cât timp
    // stratul e activ (comutatorul mare al stratului) — nu mai există switch
    // separat de pin. Idempotent: handler-ul de tap se atasează o singură
    // dată, deci apelurile repetate (oglinda verticală, comutatorul stratului)
    // nu-l înmulțesc și nu rescriu statusul unei analize încheiate.
    function setPinMode(on) {
        _pinMode = !!on;
        var map = window._dlMap;
        var row = el('archeoPotentialRow');
        if (row && row.classList) row.classList.toggle('is-on', _pinMode);

        if (!map || typeof map.on !== 'function') return _pinMode;

        if (_pinMode && !_clickArmed) {
            ensurePane(map);
            map.on('click', onMapClick);
            _clickArmed = true;
            if (_pinLatLng) drawPinCircle(_pinLatLng, false);
            setStatus(_pinLatLng ? 'pin_set' : 'ready', false, _pinLatLng ? {
                lat: _pinLatLng.lat.toFixed(5), lng: _pinLatLng.lng.toFixed(5), r: radiusKm()
            } : null);
        } else if (!_pinMode && _clickArmed) {
            if (typeof map.off === 'function') map.off('click', onMapClick);
            _clickArmed = false;
            clearPin();
            setStatus('ready');
        }
        return _pinMode;
    }

    // Sliderul de rază: aceeași optimizare ca la LIDAR Scanner / Raport —
    // cercul e redesenat o singură dată pe frame, cu stilul „drag” (fără fill
    // și fără dash) cât timp degetul e pe slider, apoi revine la stilul normal.
    function wireRadiusSlider(slider) {
        var pending = null;
        var scheduled = false;
        var frame = null;
        var releaseTimer = null;

        function paint() {
            scheduled = false;
            frame = null;
            var value = pending;
            pending = null;
            if (value == null) return;
            updateRadiusLabel(value);
            if (_pinLatLng && _pinCircle && _pinCircle.setRadius) _pinCircle.setRadius(value * 1000);
        }

        function schedule() {
            if (scheduled) return;
            scheduled = true;
            frame = raf(paint);
        }

        function beginDrag() {
            if (_draggingRadius) return;
            _draggingRadius = true;
            if (document.body && document.body.classList) document.body.classList.add('arch-distance-dragging');
            if (_pinCircle && _pinCircle.setStyle) _pinCircle.setStyle(CONFIG.PIN.CIRCLE_DRAG);
        }

        function endDrag() {
            if (!_draggingRadius) return;
            _draggingRadius = false;
            if (pending !== null) {
                if (scheduled && typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(frame);
                else clearTimeout(frame);
                scheduled = false;
                paint();
            }
            if (_pinCircle && _pinCircle.setStyle) _pinCircle.setStyle(CONFIG.PIN.CIRCLE_IDLE);
            if (document.body && document.body.classList) document.body.classList.remove('arch-distance-dragging');
        }

        slider.addEventListener('input', function () {
            pending = +this.value;
            beginDrag();
            schedule();
            clearTimeout(releaseTimer);
            releaseTimer = setTimeout(endDrag, 220);
        });
        ['change', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'mouseup', 'blur'].forEach(function (type) {
            slider.addEventListener(type, function () {
                clearTimeout(releaseTimer);
                endDrag();
            });
        });
    }

    var _runInFlight = false;
    var _runVersion = 0;

    /**
     * The whole analysis pipeline, WITHOUT any UI or map side effects.
     *
     * Both the layer's own button and the Premium "Archeological Report"
     * (js/archeo-report.js) run through here, so a "potential zone" bubble means
     * exactly the same thing in both features — one implementation, one set of
     * filters, one scoring table.
     *
     * @param {number} centerLat  analysis centre
     * @param {number} centerLng
     * @param {number} [radiusM]  working radius (default CONFIG.SEARCH_RADIUS_M)
     * @param {Object} [opts]
     *        isCancelled()  → truthy aborts between batches ({status:'cancelled'})
     *        chunkSize      → seeds per async batch (default 30)
     *        yieldModulo    → yield to the UI every N batches (default 4)
     * @returns {Promise<{status, results, ctx, stats}>}
     *          status ∈ ok | no_sites | no_triangles | no_candidates | cancelled
     *          results = [{lat, lng, x, y, score, factors, classification}]
     */
    function computeCandidates(centerLat, centerLng, radiusM, opts) {
        opts = opts || {};
        var radius = (typeof radiusM === 'number' && isFinite(radiusM)) ? radiusM : CONFIG.SEARCH_RADIUS_M;
        var lat0 = centerLat;
        var t0 = performance.now();
        var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
        var chunkSize = opts.chunkSize || 30;
        var yieldModulo = opts.yieldModulo === undefined ? 4 : opts.yieldModulo;

        return (async function main() {
            // Callers that already waited for window._localLayerData (e.g. the
            // Archeological Report layer) pass skipDataWait so an unreachable
            // heritage API is not waited on twice.
            if (!opts.skipDataWait) await waitForSiteData();

            var ctx = collectSitesInRadius(centerLat, centerLng, radius, lat0);
            ctx.center = projectToLocalMeters(centerLat, centerLng, lat0);
            ctx.centerLat = centerLat;
            ctx.centerLng = centerLng;
            ctx.radius = radius;
            ctx.siteRadius = CONFIG.SITE_RADIUS_M;
            ctx.siteBuffer = CONFIG.SITE_BUFFER_M;
            ctx.triangles = [];
            ctx.seeds = [];

            if (ctx.sites.length < 3) return done('no_sites');

            // local spatial index over the sites inside the radius
            ctx.siteIndex = createGridIndex(1200, 1200);
            for (var i = 0; i < ctx.sites.length; i++) {
                ctx.siteIndex.insert(ctx.sites[i].x, ctx.sites[i].y, ctx.sites[i]);
            }

            // triangulate
            var points = ctx.sites.map(function (s, idx) {
                return { x: s.x, y: s.y, lat: s.lat, lng: s.lng, i: idx };
            });
            var triangles = delaunayTriangulation(points);
            ctx.triangles = triangles.map(function (t) {
                // keep lat/lng refs for debug rendering
                return {
                    a: { x: t.a.x, y: t.a.y, lat: points[t.a.i].lat, lng: points[t.a.i].lng },
                    b: { x: t.b.x, y: t.b.y, lat: points[t.b.i].lat, lng: points[t.b.i].lng },
                    c: { x: t.c.x, y: t.c.y, lat: points[t.c.i].lat, lng: points[t.c.i].lng }
                };
            });
            if (ctx.triangles.length === 0) return done('no_triangles');

            var seeds = sampleTriangles(triangles, lat0);
            ctx.seeds = seeds;
            if (seeds.length === 0) return done('no_candidates');

            // async filtering, chunked so the UI stays responsive
            var kept = [];
            var batches = chunk(seeds, chunkSize);
            for (var b = 0; b < batches.length; b++) {
                var res = await Promise.all(batches[b].map(async function (seed) {
                    if (!passesMandatorySpatialFilters(seed, ctx)) return null;
                    var uat = await uatPixelAt(seed.lat, seed.lng);
                    if (uat !== true) return null; // fail closed: not confirmed inside red UAT area
                    return seed;
                }));
                kept = kept.concat(res.filter(function (x) { return x !== null; }));
                if (yieldModulo > 0 && b % yieldModulo === 0) await yieldToUI();
                if (isCancelled()) return done('cancelled');
            }

            var scored = kept.map(function (seed) { return scoreCandidate(seed, ctx); });
            var results = selectSeparated(scored).map(function (c) {
                return {
                    lat: c.lat, lng: c.lng, x: c.x, y: c.y,
                    score: c.score, factors: c.factors,
                    classification: classify(c.score)
                };
            });
            ctx.keptCount = kept.length;
            return done('ok', results);

            function done(status, results) {
                var out = results || [];
                var nHigh = 0, nMed = 0;
                out.forEach(function (r) { if (r.classification === 'high') nHigh++; else nMed++; });
                return {
                    status: status,
                    results: out,
                    ctx: ctx,
                    stats: {
                        sites: ctx.sites.length,
                        triangles: ctx.triangles.length,
                        seeds: seeds ? seeds.length : 0,
                        passed: ctx.keptCount || 0,
                        high: nHigh,
                        medium: nMed,
                        ms: Math.round(performance.now() - t0)
                    }
                };
            }
        })();
    }

    /**
     * Main entry point — called every time the user presses
     * "Detect / Detectează". Analizează raza din slider (1–10 km)
     * în jurul pinului mov, sau în jurul centrului hărții când modul pin e
     * oprit, și randează câmpul de scor în modul ales (bule / heatmap).
     */
    function runArcheoPotentialAnalysis() {
        if (_runInFlight) return Promise.resolve(false);
        _runInFlight = true;
        _runVersion++;
        var myVersion = _runVersion;

        var map = window._dlMap;
        if (!map) {
            setStatus('error', true);
            _runInFlight = false;
            return Promise.resolve(false);
        }

        var center = _pinLatLng ? { lat: _pinLatLng.lat, lng: _pinLatLng.lng } : map.getCenter();
        var radiusM = currentRadiusM();
        var mode = outputMode();
        setRunning(true);
        setStatus(_pinLatLng ? 'running_pin' : 'running_center', false, { r: radiusKm() });
        setSummary({ scored: 0 }, mode);

        return (async function main() {
            var field = null;
            try {
                field = await computePotentialField(center.lat, center.lng, radiusM, {
                    mode: mode,
                    isCancelled: function () { return myVersion !== _runVersion; },
                    onProgress: function (ratio) {
                        if (myVersion !== _runVersion) return;
                        // Primele 30% din progres sunt descărcarea tile-urilor UAT
                        // (singura parte de rețea) — altfel statusul pare blocat.
                        if (ratio < 0.3) setStatus('running_tiles', false, { p: Math.round(ratio / 0.3 * 100) });
                        else setStatus('progress', false, { p: Math.round((ratio - 0.3) / 0.7 * 100) });
                    }
                });

                if (myVersion !== _runVersion) return; // superseded by a newer run

                if (field.status === 'cancelled') { setStatus('cancelled'); return; }
                if (field.status === 'no_sites') {
                    setStatus('no_sites', true);
                    setSummary(field.stats, mode);
                    return;
                }

                _currentField = field;
                _currentResults = field.results;
                renderField(field);

                var st = field.stats;
                console.log('[ArcheoPotential] ' + mode + ' · ' +
                    st.sites + ' sites, ' + st.cells + ' cells (' + field.cellM + ' m), ' +
                    st.scored + ' scored, ' + st.excludedUat + ' UAT-excluded, ' +
                    st.excludedHeritage + ' heritage-excluded, ' + st.uatUnknown + ' UAT-unknown (' +
                    st.high + ' high, ' + st.medium + ' medium, ' + st.low + ' low) · ' +
                    st.bubbles + ' bubbles covering ' + Math.round((st.coverage || 0) * 100) +
                    '% of ' + st.freeAreaKm2 + ' km² free ground · UAT tiles ' +
                    st.uatTilesOk + '/' + st.uatTiles + ' — ' + st.ms + ' ms');

                // Rasterul UAT necitit (offline / CORS / fără acoperire) nu mai
                // golește harta: excluderea de intravilan e sărită și spunem asta.
                var uatFailed = field.uat && field.uat.total ? field.uat.total - field.uat.ok : 0;
                if (!field.results.length) setStatus('no_candidates', true);
                else if (mode !== 'heat' && !field.bubbles.length) setStatus('no_bubbles', true);
                else if (!field.uat.available) setStatus('uat_unavailable', true, { n: field.uat.total || 0 });
                else if (uatFailed > 0) setStatus('uat_partial', false, {
                    n: uatFailed,
                    p: Math.round(uatFailed / Math.max(1, field.uat.total) * 100)
                });
                else if (field.status === 'sparse_sites') setStatus('sparse_sites', false, { n: st.sites });
                else setStatus('done');
                setSummary(st, mode);
            } catch (err) {
                console.error('[ArcheoPotential] Analysis failed:', err);
                setStatus('error', true);
                setSummary({ scored: 0 }, mode);
            } finally {
                if (myVersion === _runVersion) _runInFlight = false;
                setRunning(false);
            }
        })();
    }

    function layerList() {
        var out = [];
        if (_layerGroup) out.push(_layerGroup);
        if (_maskGroup) out.push(_maskGroup);
        if (_heatLayer) out.push(_heatLayer);
        return out;
    }

    function detachRenderer(map, renderer) {
        if (!map || !renderer || typeof map.removeLayer !== 'function') return;
        try {
            if (typeof map.hasLayer === 'function' && !map.hasLayer(renderer)) return;
            map.removeLayer(renderer);
        } catch (e) {}
    }

    // Canvas-uri rămase în pane după ce path-urile au fost scoase. Leaflet nu
    // le dezlipește singur; cât stau deasupra markerelor, un tap pe un pin de
    // detectorist din zona analizată nu mai ajunge la pin.
    function dropLeftoverCanvases(map, paneName) {
        var pane = map && map.getPane && map.getPane(paneName);
        if (!pane) return;
        var kids = [];
        if (pane.children && pane.children.length) {
            for (var i = 0; i < pane.children.length; i++) kids.push(pane.children[i]);
        }
        for (var j = 0; j < kids.length; j++) {
            var node = kids[j];
            var tag = String((node && (node.tagName || node.nodeName)) || '').toLowerCase();
            if (tag !== 'canvas') continue;
            if (node.style) node.style.pointerEvents = 'none';
            var parent = node.parentNode || node.parentElement;
            if (parent && typeof parent.removeChild === 'function') {
                try { parent.removeChild(node); } catch (e) {}
            }
        }
    }

    function releaseArcheoCanvases(map) {
        detachRenderer(map, _bubbleRenderer);
        detachRenderer(map, _pinRenderer);
        detachRenderer(map, _maskRenderer);
        dropLeftoverCanvases(map, 'pane_archeo');
        dropLeftoverCanvases(map, 'pane_archeo_mask');
    }

    /* Oglinda verticală a sliderului de rază + dock-ul de acțiune centrat jos
       sunt gestionate de vertical-opacity-control.js; aici le anunțăm când
       stratul pornește/se oprește PROGRAMATIC (din catalog, din gating-ul de
       abonament etc.), caz în care evenimentul „change” al comutatorului nu
       se declanșează și oglinda nu ar urma starea stratului. */
    function notifyDistanceMirror(on) {
        try {
            var api = window.DetectLabVerticalOpacity;
            if (!api) return;
            if (on) { if (!api.isActiveFor('archeoPotDistance')) api.select('archeoPotDistance'); }
            /* La oprire se închide DOAR oglinda acestui strat (closeFor):
               api.close() le închide pe TOATE, deci un slider de potențial
               adăugat al doilea pe ecran și apoi închis stinge și sliderul
               stratului alăturat + stratul său. Fallback-ul păstrează vechiul
               comportament dacă controalele verticale vin dintr-un shell mai
               vechi, fără closeFor. */
            else if (typeof api.closeFor === 'function') api.closeFor('archeoPotDistance');
            else if (api.isActiveFor('archeoPotDistance')) api.close();
        } catch (e) {}
    }

    function toggleArcheoPotentialLayer(on) {
        _resultsVisible = !!on;
        // Logica de punct pe hartă urmează comutatorul mare al stratului:
        // oprit → nu mai poate fi pus pinul (și se curăță cel existent);
        // pornit → tap-ul pe hartă e din nou activ.
        setPinMode(_resultsVisible);
        var map = window._dlMap;
        if (!map) {
            updateRunButtonVisibility(_resultsVisible);
            notifyDistanceMirror(_resultsVisible);
            return;
        }
        layerList().forEach(function (layer) {
            try {
                var has = (typeof map.hasLayer === 'function') ? map.hasLayer(layer) : false;
                if (_resultsVisible) {
                    if (!has) layer.addTo(map);
                    if (layer === _heatLayer && typeof layer.ensureCanvas === 'function') layer.ensureCanvas();
                } else if (has) {
                    map.removeLayer(layer);
                }
            } catch (e) { /* DOM-only tests */ }
        });
        // După removeLayer, rendererul L.canvas rămâne pe hartă (canvas gol,
        // cât viewport-ul, deasupra pin-urilor). Îl scoatem explicit, altfel
        // dezactivarea stratului lasă pin-urile detectoriștilor neapăsabile.
        if (!_resultsVisible) releaseArcheoCanvases(map);
        updateRunButtonVisibility(_resultsVisible);
        notifyDistanceMirror(_resultsVisible);
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 10. WIRE-UP + PUBLIC API
     * ═══════════════════════════════════════════════════════════════════════ */

    function onLangChange() {
        syncLegend();
        setStatus(_lastStatus.key, _lastStatus.isError, _lastStatus.vars);
        if (_currentField) setSummary(_currentField.stats, outputMode());
        if (!_runInFlight) setRunning(false);
        // Tooltip-ul pinului și eticheta cercului urmăresc limba curentă.
        if (_pinMode && _pinLatLng) drawPin(_pinLatLng);
    }

    function wireUI() {
        var btn = el('archeoPotRunBtn');
        if (btn && !btn.dataset.archeoWired) {
            btn.dataset.archeoWired = '1';
            btn.addEventListener('click', function () { runArcheoPotentialAnalysis(); });
        }
        var toggle = el('archeoPotToggle');
        var firstToggleWire = !!(toggle && !toggle.dataset.archeoWired);
        if (firstToggleWire) {
            toggle.dataset.archeoWired = '1';
            toggle.addEventListener('change', function () {
                toggleArcheoPotentialLayer(toggle.checked);
            });
        }
        // Stratul pornește întotdeauna OPRIT implicit. NU e de ajuns că HTML-ul
        // n-are atributul `checked`: browserele restaurează starea bifată a
        // checkbox-ului la reload / back-forward (form restoration), iar vechea
        // citire `_resultsVisible = !!toggle.checked` pornea atunci stratul ON
        // fără ca utilizatorul să-l fi aprins. De aceea, la prima cablare,
        // forțăm OFF atât comutatorul, cât și starea internă (fără eveniment
        // `change`, ca să nu declanșăm listener-ul de mai sus). Excepția e
        // revenirea dintr-o achiziție premium pentru chiar acest strat
        // (js/subscriptions.js re-aplică toggle-ul cerut explicit de utilizator
        // prin `dl_pending_premium_toggle`, DUPĂ cablarea de aici — deci un OFF
        // forțat acum nu rupe fluxul acela). La o eventuală re-cablare nu mai
        // atingem starea, ca să nu stingem un strat pornit între timp.
        // Atașarea/detasarea se face prin setPinMode/updateRunButtonVisibility
        // de mai jos; nu există încă straturi de rezultate la cablare, deci nu
        // e nevoie de o parcurgere completă prin toggleArcheoPotentialLayer.
        if (toggle && firstToggleWire) {
            var keepRestoredOn = false;
            try {
                keepRestoredOn = (typeof sessionStorage !== 'undefined' &&
                    sessionStorage !== null &&
                    typeof sessionStorage.getItem === 'function' &&
                    sessionStorage.getItem('dl_pending_premium_toggle') === 'archeoPotToggle');
            } catch (e) { keepRestoredOn = false; }
            if (!keepRestoredOn) toggle.checked = false;
            _resultsVisible = !!toggle.checked;
        } else if (!toggle) {
            _resultsVisible = false;
        }
        var slider = el('archeoPotDistance');
        if (slider && !slider.dataset.archeoWired) {
            slider.dataset.archeoWired = '1';
            wireRadiusSlider(slider);
        }
        updateRadiusLabel();

        var bubblesBtn = el('archeoPotModeBubbles');
        if (bubblesBtn && !bubblesBtn.dataset.archeoWired) {
            bubblesBtn.dataset.archeoWired = '1';
            bubblesBtn.addEventListener('click', function () { setOutputMode('bubbles'); });
        }
        var heatBtn = el('archeoPotModeHeat');
        if (heatBtn && !heatBtn.dataset.archeoWired) {
            heatBtn.dataset.archeoWired = '1';
            heatBtn.addEventListener('click', function () { setOutputMode('heat'); });
        }
        setOutputMode(outputMode());

        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('detectlab:langchange', onLangChange);
        }
        // Logica de punct pe hartă e permanentă cât timp stratul e pornit (fără
        // switch separat de pin): tap-ul pe hartă urmează comutatorul mare al
        // stratului, iar fără pin analiza pornește din centrul hărții. La boot
        // stratul e OPRIT (vezi mai sus), deci pin-ul / oglinda razei / butonul
        // „Detectează” se armează numai după ce utilizatorul aprinde stratul.
        setPinMode(_resultsVisible);
        updateRunButtonVisibility(_resultsVisible);
    }

    // The panel may load before or after this script — wire on both events.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireUI);
    } else {
        wireUI();
    }

    // Public API (used by index.html handlers + console)
    window.runArcheoPotentialAnalysis = runArcheoPotentialAnalysis;
    window.toggleArcheoPotentialLayer = toggleArcheoPotentialLayer;
    // Explicația stratului (mutată din bara de sub legendă în fereastra de
    // info) — textul urmează limba curentă a interfeței la momentul clicului.
    window.showArcheoPotInfo = function () {
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(tr('info_title'), '© DetectLab 2026 · date RAN CIMEC', tr('info_hint'));
        }
    };
    window.setArcheoPotentialMode = setOutputMode;
    window.setArcheoPotentialPinMode = setPinMode;
    window.setArcheoPotentialRadiusKm = setRadiusKm;
    // Headless pipeline — used by js/archeo-report.js (the Premium
    // "Archeological Report") so that its "potential zones" are exactly the
    // bubbles this layer would return, with the same filters and scoring.
    window.computeArcheoPotential = computeCandidates;
    // Dense score field (both display modes of this layer).
    window.computeArcheoPotentialField = computePotentialField;
    window._archeoPotentialResults = function () { return _currentResults; };
    window._archeoPotentialField = function () { return _currentField; };
    // Bulele desenate (selecția rară) + suprafața de heatmap a ultimei rulări.
    window._archeoPotentialBubbles = function () { return _currentField ? _currentField.bubbles : null; };
    window._archeoPotentialHeat = function () { return _heatLayer; };
    window._archeoPotentialHeatRaster = function () { return _heatRaster; };
    window._archeoPotentialState = function () {
        return {
            pinMode: _pinMode,
            pin: _pinLatLng ? { lat: _pinLatLng.lat, lng: _pinLatLng.lng } : null,
            radiusKm: radiusKm(),
            radiusM: currentRadiusM(),
            mode: outputMode(),
            resultsVisible: _resultsVisible,
            running: _runInFlight
        };
    };
    // Console helper: _archeoPotSetPoint(46.77, 23.59) then runArcheoPotentialAnalysis()
    window._archeoPotSetPoint = function (lat, lng) {
        var latlng = (typeof L !== 'undefined' && L.latLng) ? L.latLng(lat, lng) : { lat: lat, lng: lng };
        if (!_pinMode) setPinMode(true);
        drawPin(latlng);
        return _pinLatLng;
    };
    // Resetare completă a cache-urilor: indexul de situri + tile-urile UAT
    // decodate (inclusiv cele eșuate, care altfel ar rămâne blocate FAILURE_TTL_MS).
    window._archeoPotentialResetCache = function () {
        _siteIndexCache = null;
        resetUatTileCache();
    };
    window._archeoPotentialDebug = {
        config: CONFIG,
        collectSitesInRadius: collectSitesInRadius,
        buildGlobalSiteIndex: buildGlobalSiteIndex,
        delaunayTriangulation: delaunayTriangulation,
        triangleQuality: triangleQuality,
        sampleTriangles: sampleTriangles,
        scoreCandidate: scoreCandidate,
        classify: classify,
        selectSeparated: selectSeparated,
        pointInPolygon: pointInPolygon,
        createGridIndex: createGridIndex,
        scoreColor: scoreColor,
        scoreColorHex: scoreColorHex,
        scoreColorRgb: scoreColorRgb,
        classifyTier: classifyTier,
        styleFor: styleFor,
        LEGEND_SCORES: LEGEND_SCORES,
        syncLegend: syncLegend,
        starRatingHtml: starRatingHtml,
        popupHtml: popupHtml,
        uatPixelAt: uatPixelAt,
        uatCellRedFraction: uatCellRedFraction,
        uatTileRange: uatTileRange,
        uatIsRedPixel: uatIsRedPixel,
        fetchUatTile: fetchUatTile,
        prewarmUatTiles: prewarmUatTiles,
        resetUatTileCache: resetUatTileCache,
        _uatTileStates: _uatTileStates,
        computeCandidates: computeCandidates,
        projectToLocalMeters: projectToLocalMeters,
        localMetersToLatLng: localMetersToLatLng,
        haversineM: haversineM,
        _uatTileZ: uatTileZ,
        // câmp de scor (grilă densă) + moduri de afișare
        computePotentialField: computePotentialField,
        gridCellM: gridCellM,
        buildFieldCells: buildFieldCells,
        buildTriangleIndex: buildTriangleIndex,
        triangleRecordAt: triangleRecordAt,
        triScoreAt: triScoreAt,
        exclusionReason: exclusionReason,
        uatMaskRectangles: uatMaskRectangles,
        // bule rare (sweet spot) + rasterul de scor pentru heatmap
        selectBubbles: selectBubbles,
        measureClearance: measureClearance,
        gapFillCandidates: gapFillCandidates,
        bubbleBaseRadiusM: bubbleBaseRadiusM,
        bubbleGapM: bubbleGapM,
        bubbleGapForRadius: bubbleGapForRadius,
        bubbleCountCap: bubbleCountCap,
        heatScoreWindow: heatScoreWindow,
        heatNormalize: heatNormalize,
        heatNormalizeMode: heatNormalizeMode,
        buildHeatRamp: buildHeatRamp,
        buildHeatRaster: buildHeatRaster,
        smoothField: smoothField,
        colorizeField: colorizeField,
        percentile: percentile,
        HEAT_GRADIENT: HEAT_GRADIENT,
        heatLayerProto: heatLayerProto,
        makeHeatLayer: makeHeatLayer,
        renderField: renderField,
        pinFeatures3d: pinFeatures3d,
        outputMode: outputMode,
        setOutputMode: setOutputMode,
        radiusKm: radiusKm,
        currentRadiusM: currentRadiusM,
        setPinMode: setPinMode,
        bubbleUnderClick: bubbleUnderClick,
        openArcheoBubble: openArcheoBubble,
        releaseArcheoCanvases: releaseArcheoCanvases,
        state: function () { return window._archeoPotentialState(); }
    };
})();
