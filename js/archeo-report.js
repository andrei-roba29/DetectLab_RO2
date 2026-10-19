/* ─────────────────────────────────────────────────────────────────────────────
 * DetectLab — PREMIUM "Archeological Report" / "Raport arheologic"
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES
 *   The user enables the layer, clicks one point on the map and presses
 *   "Generate report". The engine analyses a circular radius (1–10 km, same
 *   slider pattern as the LIDAR Scanner) around that point, cross-referencing
 *   THREE premium data sources:
 *
 *     1. APM 2.0                 — the prediction raster (score colour)
 *     2. Archeological Potential — the "zone cu potențial arheologic" bubbles
 *        Sites (triangulation)     produced by js/archeo-potential.js
 *     3. LIDAR Scanner           — annotated anomalies from the scanner CSV
 *
 *   …returns up to 3 ranked candidates (blue circular rings + labels on the map)
 *   and a downloadable, printable PDF explaining every score.
 *
 * MANDATORY EXCLUSIONS (a candidate failing any of these never appears)
 *   A. UAT — the point must sit on the UAT layer's RED area AND be at least
 *      UAT.CLEARANCE_M (500 m) from the nearest NON-red pixel. In this dataset
 *      "red" = outside the built-up area, transparent = inside the settlement,
 *      so the rule matches the product spec: nothing inside a UAT and nothing
 *      within 500 m of one. Missing/unreadable tiles FAIL CLOSED (treated as
 *      non-red) — the same policy map-app.js and archeo-potential.js use.
 *   B. Site radii — nothing inside a known site's protection radius. Point
 *      sites: distance > SITE.RADIUS_M + SITE.BUFFER_M. Polygon sites (layer 6):
 *      never inside the polygon, and the same clearance measured from guard
 *      points placed along the perimeter every POLYGON_GUARD_STEP_M plus the
 *      polygon centroid — i.e. exactly how the app builds those radii.
 *   C. APM 2.0 — the pixel must be at least NEUTRAL: blue (5), green (4.5) or
 *      yellow (4). Khaki/olive (3), magenta (2) and red (1) are rejected —
 *      UNLESS the point is annotated on the LIDAR Scanner, which waives the
 *      APM condition (an annotated anomaly is returned automatically).
 *
 * WEIGHTED SCORE (CONFIG.SCORING — every weight is live-tunable)
 *   score = W_APM · APM  +  W_POTENTIAL · PotentialZone  +  W_LIDAR · LIDAR
 *   • APM            colour class → 1.00 blue / 0.85 green / 0.62 yellow
 *   • PotentialZone  inside a bubble → that bubble's own score; near a bubble →
 *                    bubble score × (1 − d/PROXIMITY_M); no bubble → 0
 *   • LIDAR          is an optional modifier, not a penalty for missing data:
 *                    annotated → 1.0; near an anomaly → 1 − d/PROXIMITY_M;
 *                    when no scanner point is within PROXIMITY_M its weight is
 *                    removed and the APM + potential score is renormalised.
 *                    Thus candidates close to scanner points can receive a
 *                    bonus, while candidates farther away are scored lower
 *                    relative to those nearby candidates.
 *   • Roman roads    optional bonus only: if a mapped Roman road is within
 *                    ROMAN_ROADS.PROXIMITY_M, add W_ROMAN_ROADS × (1 − d/R).
 *                    If no road is nearby, the score is unchanged (no penalty).
 *
 * WHY THE PDF IS IMAGE-BASED — see js/pdf-writer.js (short version: the PDF
 * standard fonts cannot render ă/ș/ț without embedding a TrueType subset).
 *
 * LOAD ORDER (index.html): leaflet → map-app.js → archeo-potential.js →
 *   lidar-scanner.js → pdf-writer.js → archeo-report-pdf.js → archeo-report.js
 * ───────────────────────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    /* ═══════════════════════════════════════════════════════════════════════
     * 1. CONFIGURATION  (live-tunable: window.ARCH_REPORT_CONFIG.X = …)
     * ═══════════════════════════════════════════════════════════════════════ */
    var CONFIG = {
        // Analysis area — a circular radius around the picked point, 1–10 km
        // (same slider interaction as the LIDAR Scanner). Default 3 km.
        RADIUS_KM_MIN: 1,
        RADIUS_KM_MAX: 10,
        RADIUS_KM_DEFAULT: 3,
        MAX_RESULTS: 3,               // "Cele 3 rezultate"
        RESULT_RADIUS_M: 180,         // radius of the circular result ring
        RESULT_MIN_SEPARATION_M: 350, // two results may not be closer than this
        SEED_GRID_M: 100,             // baseline seed spacing (grows with radius)
        RESULT_CIRCLE_VERTS: 32,      // circular footprint for PDF / geometry

        // Shared dense field / variable-radius bubbles ("zone cu potențial arheologic")
        POTENTIAL: {
            SEARCH_RADIUS_M: 10000,   // minimum site-guard context; field uses selected radius
            PROXIMITY_M: 1500         // "aproape de o zonă cu potențial" threshold
        },

        // UAT raster
        UAT: {
            CELL_M: 10,               // grid resolution for the clearance test
            CLEARANCE_M: 500          // minimum distance to a non-red (UAT) pixel
        },

        // APM 2.0 raster
        APM: {
            Z: 14,                    // sampling zoom (the layer's maxZoom is 15)
            CELL_M: 12,
            MAX_CLASS_DIST: 150,      // max RGB distance to a legend colour
            ALLOWED: [5, 4.5, 4],     // "cel puțin în zona neutră"
            // The PDF figure does NOT re-fetch the tiles (the 30% raster wash
            // was invisible on satellite): it polygonizes the classified grid,
            // the way the "Search Help" tool does, and fills each outline with
            // its legend colour over the satellite base.
            FIGURE: {
                OPACITY: 0.45,        // fill opacity of the APM figure polygons
                MIN_CLUSTER_CELLS: 8  // drop connected patches smaller than this
            }
        },

        // LIDAR Scanner
        LIDAR: {
            HIT_M: 1,                 // coordinate tolerance; proximity is NOT an annotation
            EXCLUSION_M: 100,         // scanner result-ring radius when ignoring annotations
            PROXIMITY_M: 600          // "în proximitatea unui rezultat LIDAR"
        },

        // Roman roads (AWMC GeoJSON — same URL as the map layer). Bonus only:
        // proximity can raise the score; absence never lowers it.
        ROMAN_ROADS: {
            PROXIMITY_M: 1500,
            URL: 'https://raw.githubusercontent.com/andrei-roba29/geo_data/d81cd21/Cultural-Data/roads/roman_routes_under25mb.geojson'
        },

        SCORING: {
            W_APM: 0.40,
            W_POTENTIAL: 0.30,
            W_LIDAR: 0.30,
            W_ROMAN_ROADS: 0.12,      // optional bonus, not part of the 1.0 mix
            APM_CLASS_SCORE: { '5': 1.00, '4.5': 0.85, '4': 0.62 },
            APM_UNKNOWN: 0.30,        // unreadable pixel, LIDAR-waived candidate
            POTENTIAL_NONE: 0,        // no bubble = no supporting potential evidence
            // Kept as named configuration values for backwards-compatible
            // consumers; missing/far LIDAR is no longer inserted as a score.
            LIDAR_NO_DATA: 0.20,
            LIDAR_FAR: 0.10,
            LIDAR_ANNOTATION_BONUS: 0.45  // "se returnează automat"
        },

        CLASSIFY: { HIGH_FROM: 0.75, MEDIUM_FROM: 0.50 },

        // Site protection radii — overwritten with archeo-potential.js' own
        // values at run time (syncSiteConfig) so the two features never drift.
        SITE: { RADIUS_M: 600, BUFFER_M: 100, POLYGON_GUARD_STEP_M: 400 },

        RENDER: {
            PANE_SHAPES: 'pane_arch_report_shapes',
            PANE_TAGS: 'pane_arch_report_tags',
            Z_SHAPES: 672,            // above the LIDAR scanner tags (665)
            Z_TAGS: 674,
            COLOR: '#66c8ff',
            FILL: '#29b6f6'
        },

        SCREENSHOT: {
            SIZE_PX: 900,
            MARGIN_M: 480,            // padding drawn around the search circle
            JPEG_QUALITY: 0.85,
            TIMEOUT_MS: 25000
        },

        NEAREST_SITES: 5,             // sites listed per result in the PDF
        PERIOD_SITES: 3,              // sites used to estimate the period
        SITES_DATA_POLL_MS: 200,
        SITES_DATA_TIMEOUT_MS: 20000
    };
    window.ARCH_REPORT_CONFIG = CONFIG;

    // Keep the site radii in sync with archeo-potential.js when it is loaded.
    function syncSiteConfig() {
        var pot = window.ARCH_POTENTIAL_CONFIG;
        if (!pot) return;
        if (typeof pot.SITE_RADIUS_M === 'number') CONFIG.SITE.RADIUS_M = pot.SITE_RADIUS_M;
        if (typeof pot.SITE_BUFFER_M === 'number') CONFIG.SITE.BUFFER_M = pot.SITE_BUFFER_M;
        if (typeof pot.POLYGON_GUARD_STEP_M === 'number') CONFIG.SITE.POLYGON_GUARD_STEP_M = pot.POLYGON_GUARD_STEP_M;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 2. i18n — every user-facing string lives in js/translations.js under an
     *    `arch_report_*` key (RO + EN). The built-in English fallback keeps the
     *    PDF usable even if a key is ever missing.
     * ═══════════════════════════════════════════════════════════════════════ */
    var FALLBACK_EN = {
        arch_report_title: 'Archaeological Report',
        arch_report_result: 'Result',
        arch_report_score: 'Score',
        arch_report_site_unknown: 'Unnamed site'
    };

    function lang() {
        return (typeof window._currentLang === 'function' && window._currentLang()) || 'en';
    }

    // A translator bound to one language. The PDF can be generated in a
    // language the user picks independently of the site language, so every
    // PDF string (pages AND figure titles/badges) must go through the same
    // bound translator — passing `lang` alone changes almost nothing in the
    // Painter, which uses its `tr` for every string.
    function makeTr(langCode) {
        var code = (langCode === 'ro') ? 'ro' : 'en';
        return function (key, vars) {
            var dict = null;
            if (typeof translations !== 'undefined' && translations && translations[code]) {
                dict = translations[code];
            }
            var s = (dict && dict[key] !== undefined) ? dict[key]
                : (FALLBACK_EN[key] !== undefined ? FALLBACK_EN[key] : key);
            if (vars) {
                Object.keys(vars).forEach(function (k) {
                    s = String(s).split('{' + k + '}').join(vars[k]);
                });
            }
            return s;
        };
    }

    function tr(key, vars) { return makeTr(lang())(key, vars); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 3. GEO / MATH HELPERS
     * ═══════════════════════════════════════════════════════════════════════
     * Same local-meters convention as archeo-potential.js (equirectangular
     * projection around the analysis latitude) so both features share
     * coordinates without re-projection. */

    function projectToLocalMeters(lat, lng, lat0) {
        var kLng = 111320 * Math.cos(lat0 * Math.PI / 180);
        return { x: lng * kLng, y: lat * 111320 };
    }

    function localMetersToLatLng(x, y, lat0) {
        var kLng = 111320 * Math.cos(lat0 * Math.PI / 180);
        return { lat: y / 111320, lng: x / kLng };
    }

    function haversineM(aLat, aLng, bLat, bLng) {
        var R = 6371000;
        var dLat = (bLat - aLat) * Math.PI / 180;
        var dLng = (bLng - aLng) * Math.PI / 180;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    function pointInPolygon(px, py, poly) {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    function currentRadiusKm() {
        var slider = el('archReportDistance');
        if (slider) {
            var v = parseInt(slider.value, 10);
            if (isFinite(v)) {
                return Math.max(CONFIG.RADIUS_KM_MIN, Math.min(CONFIG.RADIUS_KM_MAX, v));
            }
        }
        return CONFIG.RADIUS_KM_DEFAULT;
    }

    function currentRadiusM() { return currentRadiusKm() * 1000; }

    // Circular analysis area in local meters, centred on the picked point.
    // min/max describe the axis-aligned bbox (used by rasters / roads);
    // inCircle() is the actual membership test.
    function analysisArea(centerLat, centerLng, radiusM) {
        var r = (radiusM && isFinite(radiusM)) ? radiusM : currentRadiusM();
        var c = projectToLocalMeters(centerLat, centerLng, centerLat);
        return {
            radiusM: r,
            areaKm2: Math.PI * r * r / 1e6,
            sideM: r * 2,
            cx: c.x, cy: c.y,
            minX: c.x - r, maxX: c.x + r,
            minY: c.y - r, maxY: c.y + r
        };
    }

    function areaSquare(centerLat, centerLng, areaKm2) {
        var radiusM = Math.sqrt((areaKm2 || 0) * 1e6 / Math.PI);
        return analysisArea(centerLat, centerLng, radiusM);
    }

    function inSquare(square, x, y) {
        return x >= square.minX && x <= square.maxX && y >= square.minY && y <= square.maxY;
    }

    function inCircle(area, x, y) {
        var dx = x - area.cx, dy = y - area.cy;
        return dx * dx + dy * dy <= area.radiusM * area.radiusM;
    }

    function seedGridM(radiusM) {
        var r = radiusM || currentRadiusM();
        return Math.max(CONFIG.SEED_GRID_M, Math.round(r / 25));
    }

    function uatCellM(radiusM) {
        var span = ((radiusM || currentRadiusM()) + CONFIG.UAT.CLEARANCE_M) * 2;
        return Math.max(CONFIG.UAT.CELL_M, Math.round(span / 400));
    }

    function apmCellM(radiusM) {
        var span = ((radiusM || currentRadiusM()) + CONFIG.UAT.CLEARANCE_M) * 2;
        return Math.max(CONFIG.APM.CELL_M, Math.round(span / 360));
    }

    /* ── Web Mercator tile math (XYZ, slippy map) ───────────────────────── */
    function lngToTileXF(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
    function latToTileYF(lat, z) {
        var rad = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
    }
    function tileRangeFor(latMin, latMax, lngMin, lngMax, z) {
        var max = Math.pow(2, z);
        var x0 = Math.max(0, Math.floor(lngToTileXF(lngMin, z)));
        var x1 = Math.min(max - 1, Math.floor(lngToTileXF(lngMax, z)));
        var y0 = Math.max(0, Math.floor(latToTileYF(latMax, z)));
        var y1 = Math.min(max - 1, Math.floor(latToTileYF(latMin, z)));
        var out = [];
        for (var tx = x0; tx <= x1; tx++) for (var ty = y0; ty <= y1; ty++) out.push({ x: tx, y: ty });
        return out;
    }
    function zoomForSpan(spanM, lat, sizePx) {
        var mpp = 156543.03392 * Math.cos(lat * Math.PI / 180);
        var z = Math.log(mpp * sizePx / spanM) / Math.LN2;
        return Math.max(2, Math.min(19, Math.floor(z)));
    }

    function yieldToUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

    function fmtM(m) {
        if (m === null || m === undefined || !isFinite(m)) return '—';
        return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
    }

    function distPointToSegment(px, py, ax, ay, bx, by) {
        var dx = bx - ax, dy = by - ay;
        var len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) {
            var ddx = px - ax, ddy = py - ay;
            return Math.sqrt(ddx * ddx + ddy * ddy);
        }
        var t = ((px - ax) * dx + (py - ay) * dy) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        var qx = ax + t * dx, qy = ay + t * dy;
        var rx = px - qx, ry = py - qy;
        return Math.sqrt(rx * rx + ry * ry);
    }

    function flattenLineCoords(geom, out) {
        if (!geom) return;
        var t = geom.type, c = geom.coordinates;
        if (t === 'LineString') out.push(c);
        else if (t === 'MultiLineString') {
            for (var i = 0; i < (c || []).length; i++) out.push(c[i]);
        } else if (t === 'GeometryCollection' && geom.geometries) {
            for (var j = 0; j < geom.geometries.length; j++) flattenLineCoords(geom.geometries[j], out);
        }
    }

    function nearestRomanRoadM(x, y, segs) {
        if (!segs || !segs.length) return null;
        var best = Infinity;
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            var d = distPointToSegment(x, y, s.ax, s.ay, s.bx, s.by);
            if (d < best) best = d;
        }
        return best === Infinity ? null : best;
    }

    var _romanRoadsCache = null;
    var _romanRoadsPromise = null;

    function loadRomanRoadsGeojson() {
        if (_romanRoadsCache) return Promise.resolve(_romanRoadsCache);
        if (_romanRoadsPromise) return _romanRoadsPromise;
        if (typeof fetch !== 'function') {
            _romanRoadsCache = { type: 'FeatureCollection', features: [] };
            return Promise.resolve(_romanRoadsCache);
        }
        _romanRoadsPromise = fetch(CONFIG.ROMAN_ROADS.URL)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) { _romanRoadsCache = data; return data; })
            .catch(function (err) {
                console.warn('[ArcheoReport] Roman roads GeoJSON unavailable:', err && err.message);
                _romanRoadsCache = { type: 'FeatureCollection', features: [] };
                return _romanRoadsCache;
            });
        return _romanRoadsPromise;
    }

    /* The map's own Roman-roads layer (js/roman-roads.js), when „Drumuri
     * romane” is on and its geometry has arrived: measuring in it replaces the
     * download + parse + flatten of the reference GeoJSON below. js/map-app.js
     * exposes the layer as window._romanRoadsLayer. */
    function mapRomanRoadsLayer() {
        try {
            var host = (typeof window !== 'undefined') ? window : null;
            var layer = host && host._romanRoadsLayer;
            if (!layer || typeof layer.nearestRoadMeters !== 'function') return null;
            if (typeof layer.getStats === 'function' && !layer.getStats().segments) return null;
            return layer;
        } catch (e) { return null; }
    }

    function romanRoadSegmentsInSquare(geojson, square, lat0, padM) {
        var segs = [];
        var pad = padM == null ? CONFIG.ROMAN_ROADS.PROXIMITY_M : padM;
        var minX = square.minX - pad, maxX = square.maxX + pad;
        var minY = square.minY - pad, maxY = square.maxY + pad;
        var feats = (geojson && geojson.features) ? geojson.features : [];
        for (var i = 0; i < feats.length; i++) {
            var lines = [];
            flattenLineCoords(feats[i].geometry, lines);
            for (var li = 0; li < lines.length; li++) {
                var coords = lines[li] || [];
                var pts = [];
                for (var ci = 0; ci < coords.length; ci++) {
                    var c = coords[ci];
                    if (!c || c.length < 2) continue;
                    pts.push(projectToLocalMeters(c[1], c[0], lat0));
                }
                for (var k = 1; k < pts.length; k++) {
                    var a = pts[k - 1], b = pts[k];
                    if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX) continue;
                    if (Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
                    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
                }
            }
        }
        return segs;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 4. SITE GEOMETRY — shared with the potential layer
     * ═══════════════════════════════════════════════════════════════════════ */

    // Collect every known site around the point with archeo-potential.js' own
    // collector, so the radii (including polygon guard points) are built exactly
    // the same way as in that layer.
    function collectSites(centerLat, centerLng, radiusM, lat0) {
        var dbg = window._archeoPotentialDebug;
        if (dbg && typeof dbg.collectSitesInRadius === 'function') {
            return dbg.collectSitesInRadius(centerLat, centerLng, radiusM, lat0);
        }
        return { sites: [], polygons: [] };
    }

    // Fold the flat point list (point sites + polygon guard points) back into
    // one record per real site, so the report can say "Neolithic settlement,
    // 840 m" instead of listing 30 perimeter samples of the same polygon.
    function buildSiteRecords(sites) {
        var byKey = {}, order = [];
        sites.forEach(function (s) {
            var key = s.layerId + ':' + s.oid;
            if (!byKey[key]) {
                byKey[key] = {
                    key: key, layerId: s.layerId, oid: s.oid,
                    props: s.props || {}, points: [], isPolygon: false
                };
                order.push(key);
            }
            var rec = byKey[key];
            rec.points.push({ x: s.x, y: s.y });
            if (s.isGuard) rec.isPolygon = true;
        });
        return order.map(function (k) {
            var rec = byKey[k];
            // points[0] is the site itself for point features and the polygon
            // centroid for polygon features (collectSitesInRadius pushes the
            // centroid first) — a good representative for both.
            rec.ref = rec.points[0];
            rec.lat = rec.ref.lat;
            rec.lng = rec.ref.lng;
            return rec;
        });
    }

    // Distance (m) from a local-meters point to a site record's geometry.
    function distanceToSite(px, py, rec) {
        var best = Infinity;
        for (var i = 0; i < rec.points.length; i++) {
            var dx = px - rec.points[i].x, dy = py - rec.points[i].y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < best) best = d;
        }
        return best;
    }

    /* ── Site property readers (ArcGIS attribute names vary per layer) ──── */
    function pickProp(props, names) {
        if (!props) return null;
        for (var i = 0; i < names.length; i++) {
            var v = props[names[i]];
            if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
        }
        var lower = names.map(function (n) { return n.toLowerCase(); });
        for (var key in props) {
            if (lower.indexOf(String(key).toLowerCase()) !== -1) {
                var val = props[key];
                if (val !== undefined && val !== null && String(val).trim() !== '') return String(val).trim();
            }
        }
        return null;
    }

    var PROP_NAMES = {
        name: ['NUMESIT', 'Denumire', 'DENUMIRE', 'Nume', 'Eticheta', 'Toponim', 'Name', 'NAME'],
        ran: ['CODSIT', 'CodRAN', 'CODRAN', 'Cod_RAN', 'COD_RAN', 'RAN'],
        // The production GeoJSON endpoints (/api/layers/0, /5/, /6/) were
        // verified: NONE of the layers has a dedicated dating property.
        // Layer 0 → NUMESIT/CODSIT/SIRUTA/COORD, layer 5 → Tip/Judet/Comuna/
        // Eticheta, layer 6 → Nume/CodRAN/Localitate/Judet/Observatii/Sursa.
        // The dating therefore lives in the site NAME itself ("Așezarea
        // hallstattiană…", "Necropola de incinerație din epoca fierului…"),
        // which siteInfo() falls back to. These keys stay listed so a dating
        // field is picked up automatically the day the backend adds one.
        period: ['EPOCA', 'Epoca', 'CRONOLOGIE', 'Cronologie', 'PERIOADA', 'Perioada', 'DATARE', 'Datare',
                 'Observatii', 'OBSERVATII', 'Descriere', 'DESCRIERE'],
        type: ['TIPSIT', 'Tip', 'TIP', 'TipSit', 'Categorie', 'Tipobiect'],
        locality: ['LOCALITATE', 'Localitate', 'Sat', 'SAT', 'Punct'],
        county: ['JUDET', 'Judet', 'Judet_1', 'COUNTY', 'County'],
        commune: ['COMUNA', 'Comuna', 'UAT', 'Comuna_1']
    };

    function siteInfo(rec) {
        var p = rec.props || {};
        var ran = pickProp(p, PROP_NAMES.ran);
        var rawName = pickProp(p, PROP_NAMES.name);
        var name = rawName || (ran ? 'RAN ' + ran : null);
        // The production dataset has no dating field: the era is stated in the
        // site name ("Cetatea medievală…", "Așezarea hallstattiană…", "Castrul
        // militar auxiliar…"). A dating property wins when one exists; otherwise
        // the name is the dating evidence.
        var period = pickProp(p, PROP_NAMES.period);
        var periodFromProperty = periodKey(period);
        var periodFromName = rawName ? periodKey(rawName) : null;
        return {
            layerId: rec.layerId,
            oid: rec.oid,
            isPolygon: rec.isPolygon,
            name: name || tr('arch_report_site_unknown'),
            ran: ran,
            period: period,
            periodKey: periodFromProperty || periodFromName || null,
            datingFromName: !periodFromProperty && !!periodFromName,
            type: pickProp(p, PROP_NAMES.type),
            locality: pickProp(p, PROP_NAMES.locality),
            commune: pickProp(p, PROP_NAMES.commune),
            county: pickProp(p, PROP_NAMES.county),
            lat: rec.lat,
            lng: rec.lng,
            url: ran
                ? 'https://ran.cimec.ro/sel.asp?codran=' + encodeURIComponent(ran)
                : (name ? 'https://ran.cimec.ro/sel.asp?descript=' + encodeURIComponent(name) : null)
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 5. UAT RASTER — "red zone" + 500 m clearance grid
     * ═══════════════════════════════════════════════════════════════════════
     * map-app.js renders UAT from PNG tiles on R2 where an OPAQUE DARK pixel is
     * drawn red (= outside the built-up area) and a TRANSPARENT pixel is the
     * settlement itself. We therefore require: red under the candidate AND no
     * non-red pixel within CLEARANCE_M.
     * Missing (404) or unreadable (CORS) tiles count as NON-red, i.e. the test
     * fails closed — identical to uatHasBuildingNear() in map-app.js. */

    function uatZ() { return (window.UAT_TILE_Z !== undefined) ? window.UAT_TILE_Z : 14; }

    function isRedUatPixel(r, g, b, a) {
        if (a === undefined || a <= 128) return false;   // transparent = settlement
        return ((r + g + b) / 3) < 128;                  // dark + opaque = red on map
    }

    function buildUatGrid(bbox, cellM) {
        var z = uatZ();
        var cols = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellM));
        var rows = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellM));
        var red = new Uint8Array(cols * rows);
        var grid = {
            x0: bbox.minX, y0: bbox.minY, cols: cols, rows: rows, cellM: cellM,
            red: red, available: false, cells: cols * rows, unreadable: 0
        };

        if (typeof window._uatGetTile !== 'function') return Promise.resolve(grid);

        var tiles = tileRangeFor(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, z);
        var loaded = {};
        return Promise.all(tiles.map(function (t) {
            return window._uatGetTile(z, t.x, t.y).then(function (data) {
                loaded[t.x + ',' + t.y] = data;
            });
        })).then(function () {
            var unreadableToken = window._UAT_TILE_UNREADABLE;
            for (var cy = 0; cy < rows; cy++) {
                for (var cx = 0; cx < cols; cx++) {
                    var x = bbox.minX + (cx + 0.5) * cellM;
                    var y = bbox.minY + (cy + 0.5) * cellM;
                    var ll = localMetersToLatLng(x, y, bbox.lat0);
                    var txF = lngToTileXF(ll.lng, z), tyF = latToTileYF(ll.lat, z);
                    var tx = Math.floor(txF), ty = Math.floor(tyF);
                    var tile = loaded[tx + ',' + ty];
                    if (!tile || tile === unreadableToken) {
                        if (tile === unreadableToken) grid.unreadable++;
                        red[cy * cols + cx] = 0;        // fail closed
                        continue;
                    }
                    grid.available = true;
                    var size = tile.size || 256;
                    var px = Math.floor((txF - tx) * size), py = Math.floor((tyF - ty) * size);
                    if (px < 0 || py < 0 || px >= size || py >= size) { red[cy * cols + cx] = 0; continue; }
                    var idx = (py * size + px) * 4;
                    red[cy * cols + cx] = isRedUatPixel(
                        tile.data[idx], tile.data[idx + 1], tile.data[idx + 2], tile.data[idx + 3]
                    ) ? 1 : 0;
                }
            }
            return grid;
        });
    }

    /**
     * UAT verdict for one candidate.
     * @returns {{red:boolean, clearanceM:number}} clearanceM = distance to the
     *          nearest non-red pixel (Infinity when the whole disc is red).
     */
    function uatVerdict(grid, x, y, maxM) {
        var cx = Math.floor((x - grid.x0) / grid.cellM);
        var cy = Math.floor((y - grid.y0) / grid.cellM);
        if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return { red: false, clearanceM: 0 };
        if (!grid.red[cy * grid.cols + cx]) return { red: false, clearanceM: 0 };
        var rCells = Math.ceil(maxM / grid.cellM);
        var best = Infinity;
        for (var dy = -rCells; dy <= rCells; dy++) {
            var gy = cy + dy;
            if (gy < 0 || gy >= grid.rows) continue;
            for (var dx = -rCells; dx <= rCells; dx++) {
                var gx = cx + dx;
                if (gx < 0 || gx >= grid.cols) continue;
                if (grid.red[gy * grid.cols + gx]) continue;
                var d = Math.sqrt(dx * dx + dy * dy) * grid.cellM;
                if (d < best) best = d;
            }
        }
        return { red: true, clearanceM: isFinite(best) ? best : Infinity };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 6. APM 2.0 RASTER — colour class per cell
     * ═══════════════════════════════════════════════════════════════════════
     * The three APM 2.0 tile sets (main + NORD + SUD) are sampled in the same
     * stacking order the map uses, and every pixel is matched to the nearest
     * colour of the layer's own 6-entry legend. Nearest-neighbour (instead of
     * the hand-tuned thresholds used by the "Search Help" tool) is deliberate:
     * the report must tell khaki/olive (score 3) apart from light yellow
     * (score 4) — the spec forbids the first and allows the second, yet both
     * are "R+G high, B low". */

    var APM_LEGEND = [
        { cls: 5, rgb: [0, 0, 255], key: 'blue' },
        { cls: 4.5, rgb: [0, 204, 0], key: 'green' },
        { cls: 4, rgb: [255, 255, 153], key: 'yellow' },
        { cls: 3, rgb: [128, 128, 0], key: 'olive' },
        { cls: 2, rgb: [255, 0, 255], key: 'magenta' },
        { cls: 1, rgb: [255, 0, 0], key: 'red' }
    ];
    window.ARCH_REPORT_APM_LEGEND = APM_LEGEND;

    function classifyApmPixel(r, g, b) {
        // Near-white / cream = the tiles' empty background → no data.
        if (r > 226 && g > 226 && b > 212) return { cls: 0, dist: 0 };
        var best = null, bestD = Infinity;
        for (var i = 0; i < APM_LEGEND.length; i++) {
            var c = APM_LEGEND[i].rgb;
            var dr = r - c[0], dg = g - c[1], db = b - c[2];
            var d = Math.sqrt(dr * dr + dg * dg + db * db);
            if (d < bestD) { bestD = d; best = APM_LEGEND[i]; }
        }
        if (!best || bestD > CONFIG.APM.MAX_CLASS_DIST) return { cls: 0, dist: bestD };
        return { cls: best.cls, dist: bestD };
    }

    function apmTileTemplates() {
        function urlOf(layer, fallback) { return (layer && layer._url) ? layer._url : fallback; }
        var R2 = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev';
        return [
            { key: 'main', url: urlOf(window._apm20Layer, R2 + '/{z}/{x}/{y}.jpg') },
            { key: 'north', url: urlOf(window._apm20NorthLayer, R2 + '/NORD/{z}/{x}/{y}.jpg') },
            { key: 'south', url: urlOf(window._apm20SouthLayer, R2 + '/SUD/{z}/{x}/{y}.jpg') }
        ];
    }

    var _apmTileCache = {};
    var APM_TILE_UNREADABLE = { unreadable: true };

    function loadImage(url, useCors) {
        return new Promise(function (resolve) {
            if (typeof Image === 'undefined') return resolve(null);
            var img = new Image();
            if (useCors !== false) img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { resolve(null); };
            img.src = url;
        });
    }

    // Reads one APM tile into {data,size}. Cached per tile + source.
    function loadApmTileData(tmplKey, url, z, x, y) {
        var key = tmplKey + '|' + z + '/' + x + '/' + y;
        if (_apmTileCache[key]) return _apmTileCache[key];
        var filled = url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        var p = loadImage(filled, true).then(function (img) {
            if (!img) return null;
            try {
                var c = document.createElement('canvas');
                c.width = img.width || 256; c.height = img.height || 256;
                var cx2 = c.getContext('2d', { willReadFrequently: true });
                cx2.drawImage(img, 0, 0);
                var d = cx2.getImageData(0, 0, c.width, c.height);
                return { data: d.data, size: c.width, img: img };
            } catch (e) {
                return APM_TILE_UNREADABLE;   // CORS not configured on the bucket
            }
        });
        _apmTileCache[key] = p;
        return p;
    }

    function buildApmGrid(bbox, cellM, z) {
        var cols = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cellM));
        var rows = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cellM));
        var cls = new Float32Array(cols * rows);      // 0 = no data
        var grid = {
            x0: bbox.minX, y0: bbox.minY, cols: cols, rows: rows, cellM: cellM,
            cls: cls, available: false, unreadable: false, z: z, histogram: {}
        };

        var mergeMinZ = (typeof window._apm20MergeMinZoom === 'number') ? window._apm20MergeMinZoom : 10;
        var templates = apmTileTemplates().filter(function (t, i) { return i === 0 || z >= mergeMinZ; });
        var tiles = tileRangeFor(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, z);

        var jobs = [];
        templates.forEach(function (t) {
            tiles.forEach(function (tile) {
                jobs.push(loadApmTileData(t.key, t.url, z, tile.x, tile.y).then(function (data) {
                    return { tmpl: t.key, tile: tile, data: data };
                }));
            });
        });

        return Promise.all(jobs).then(function (loaded) {
            var byTile = {};   // "x,y" -> [{tmpl,data}] in stacking order
            loaded.forEach(function (item) {
                var k = item.tile.x + ',' + item.tile.y;
                (byTile[k] || (byTile[k] = [])).push(item);
                if (item.data === APM_TILE_UNREADABLE) grid.unreadable = true;
            });
            var order = { main: 0, north: 1, south: 2 };
            Object.keys(byTile).forEach(function (k) {
                byTile[k].sort(function (a, b) { return (order[a.tmpl] || 0) - (order[b.tmpl] || 0); });
            });

            for (var cy = 0; cy < rows; cy++) {
                for (var cx = 0; cx < cols; cx++) {
                    var x = bbox.minX + (cx + 0.5) * cellM;
                    var y = bbox.minY + (cy + 0.5) * cellM;
                    var ll = localMetersToLatLng(x, y, bbox.lat0);
                    var txF = lngToTileXF(ll.lng, z), tyF = latToTileYF(ll.lat, z);
                    var tx = Math.floor(txF), ty = Math.floor(tyF);
                    var entries = byTile[tx + ',' + ty];
                    var value = 0;
                    if (entries) {
                        for (var e = 0; e < entries.length && value === 0; e++) {
                            var tile = entries[e].data;
                            if (!tile || tile === APM_TILE_UNREADABLE) continue;
                            var size = tile.size || 256;
                            var px = Math.floor((txF - tx) * size), py = Math.floor((tyF - ty) * size);
                            if (px < 0 || py < 0 || px >= size || py >= size) continue;
                            var idx = (py * size + px) * 4;
                            value = classifyApmPixel(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]).cls;
                        }
                    }
                    cls[cy * cols + cx] = value;
                    if (value !== 0) {
                        grid.available = true;
                        grid.histogram[value] = (grid.histogram[value] || 0) + 1;
                    }
                }
            }
            return grid;
        });
    }

    function apmClassAt(grid, x, y) {
        var cx = Math.floor((x - grid.x0) / grid.cellM);
        var cy = Math.floor((y - grid.y0) / grid.cellM);
        if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return 0;
        return grid.cls[cy * grid.cols + cx];
    }

    /* ── APM figure polygons ("Search Help" style) ──────────────────────────
     * The PDF figure no longer re-fetches the APM tiles (CORS + a 30% wash
     * over dark satellite made the raster effectively invisible). Instead it
     * polygonizes the very grid the score was computed from: the allowed
     * classes (blue/green/yellow) are clustered per class, small patches are
     * dropped, and each surviving cluster is outlined with a Moore boundary
     * trace — the same algorithm map-app.js' Search Help tool uses — and
     * filled with its legend colour. The figure is a direct rendering of the
     * data that produced the score, so it can never contradict it. */

    // Moore neighborhood tracing over the cell set; returns the simplified
    // boundary as [[col,row],…] cell coordinates (null when degenerate).
    function outlineCells(cells, cols) {
        var cellSet = {};
        cells.forEach(function (idx) { cellSet[idx] = true; });
        function has(cx, cy) {
            if (cx < 0 || cy < 0) return false;
            return !!cellSet[cy * cols + cx];
        }
        // start from the top-left-most cell
        var startIdx = cells.reduce(function (best, idx) {
            var bx = best % cols, by = (best - bx) / cols;
            var ix = idx % cols, iy = (idx - ix) / cols;
            return (iy < by || (iy === by && ix < bx)) ? idx : best;
        }, cells[0]);
        var sx = startIdx % cols, sy = (startIdx - sx) / cols;

        // directions: 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
        var dx = [1, 1, 0, -1, -1, -1, 0, 1];
        var dy = [0, 1, 1, 1, 0, -1, -1, -1];
        var outline = [];
        var cx = sx, cy = sy, dir = 7;
        var maxSteps = cells.length * 4 + 8, steps = 0;
        do {
            outline.push([cx, cy]);
            var backDir = (dir + 4) % 8;
            var found = false;
            for (var d = 0; d < 8; d++) {
                var nd = (backDir + 1 + d) % 8;
                var nx = cx + dx[nd], ny = cy + dy[nd];
                if (has(nx, ny)) { cx = nx; cy = ny; dir = nd; found = true; break; }
            }
            if (!found) break;
            steps++;
        } while ((cx !== sx || cy !== sy) && steps < maxSteps);
        if (outline.length < 3) return null;

        // keep only the points where the direction changes
        var simplified = [outline[0]];
        for (var i = 1; i < outline.length - 1; i++) {
            var prev = simplified[simplified.length - 1];
            var curr = outline[i];
            var next = outline[i + 1];
            if (curr[0] - prev[0] !== next[0] - curr[0] ||
                curr[1] - prev[1] !== next[1] - curr[1]) simplified.push(curr);
        }
        simplified.push(outline[outline.length - 1]);
        return simplified;
    }

    // One polygon per connected patch of allowed classes (8-connectivity).
    // @returns [{cls, cells, hull:[[col,row],…]}]
    function apmGridPolygons(grid, minCells) {
        var out = [];
        if (!grid || !grid.cls || !grid.cols || !grid.rows) return out;
        var min = (typeof minCells === 'number') ? minCells : CONFIG.APM.FIGURE.MIN_CLUSTER_CELLS;
        var allowed = CONFIG.APM.ALLOWED;
        var seen = new Uint8Array(grid.cols * grid.rows);
        for (var c = 0; c < allowed.length; c++) {
            var cls = allowed[c];
            for (var idx = 0; idx < grid.cols * grid.rows; idx++) {
                if (grid.cls[idx] !== cls || seen[idx]) continue;
                var stack = [idx], cells = [];
                seen[idx] = 1;
                while (stack.length) {
                    var cur = stack.pop();
                    cells.push(cur);
                    var cx = cur % grid.cols, cy = (cur - cx) / grid.cols;
                    for (var dy = -1; dy <= 1; dy++) {
                        for (var dx = -1; dx <= 1; dx++) {
                            if (!dx && !dy) continue;
                            var nx = cx + dx, ny = cy + dy;
                            if (nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
                            var ni = ny * grid.cols + nx;
                            if (!seen[ni] && grid.cls[ni] === cls) { seen[ni] = 1; stack.push(ni); }
                        }
                    }
                }
                if (cells.length < min) continue;
                var hull = outlineCells(cells, grid.cols);
                if (hull && hull.length >= 3) out.push({ cls: cls, cells: cells.length, hull: hull });
            }
        }
        return out;
    }

    function apmClassColor(cls) {
        for (var i = 0; i < APM_LEGEND.length; i++) {
            if (APM_LEGEND[i].cls === cls) return APM_LEGEND[i].rgb;
        }
        return [160, 32, 240];   // never reached: only legend classes are outlined
    }

    // Paints the APM polygons over the figure canvas (satellite base below).
    function drawApmFigurePolygons(g, proj, polygons, grid, lat0) {
        polygons.forEach(function (poly) {
            var pts = poly.hull.map(function (cell) {
                var x = grid.x0 + (cell[0] + 0.5) * grid.cellM;
                var y = grid.y0 + (cell[1] + 0.5) * grid.cellM;
                var ll = localMetersToLatLng(x, y, lat0);
                return proj.latLngToPx(ll.lat, ll.lng);
            });
            if (pts.length < 3) return;
            var rgb = apmClassColor(poly.cls);
            g.save();
            g.beginPath();
            g.moveTo(pts[0].x, pts[0].y);
            for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
            g.closePath();
            g.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' +
                CONFIG.APM.FIGURE.OPACITY + ')';
            g.fill();
            g.strokeStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
            g.lineWidth = 1.6;
            g.stroke();
            g.restore();
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7. LIDAR SCANNER POINTS
     * ═══════════════════════════════════════════════════════════════════════ */

    function loadLidarPoints(ignoreLidar) {
        var api = window._lidarScannerApi;
        if (!api) {
            if (ignoreLidar) {
                return Promise.reject(new Error('LIDAR source unavailable for exclusion'));
            }
            return Promise.resolve([]);
        }
        var ready = (typeof api.ensureLoaded === 'function')
            ? api.ensureLoaded().catch(function (err) {
                // Without annotations we cannot honour an explicit exclusion.
                if (ignoreLidar) throw err;
                return null;
            })
            : Promise.resolve(null);
        return ready.then(function () {
            var pts = (typeof api.getEligiblePoints === 'function' ? api.getEligiblePoints()
                : (typeof api.getPoints === 'function' ? api.getPoints() : null)) || [];
            return pts.filter(function (p) {
                var lng = p.lon !== undefined ? p.lon : p.lng;
                return typeof p.lat === 'number' && typeof lng === 'number' &&
                    isFinite(p.lat) && isFinite(lng) && Math.abs(p.lat) <= 90 && Math.abs(lng) <= 180;
            }).map(function (p) {
                return {
                    lat: p.lat,
                    lng: (p.lon !== undefined ? p.lon : p.lng),
                    category: p.category || '',
                    name: p.name || '',
                    id: p.id
                };
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 8. CANDIDATE GENERATION, FILTERING, SCORING, SELECTION
     * ═══════════════════════════════════════════════════════════════════════ */

    function buildSeeds(ctx) {
        var seeds = [];
        var sq = ctx.square;
        var step = seedGridM(sq.radiusM);
        for (var y = sq.minY + step / 2; y < sq.maxY; y += step) {
            for (var x = sq.minX + step / 2; x < sq.maxX; x += step) {
                if (inCircle(sq, x, y)) seeds.push({ x: x, y: y, origin: 'grid' });
            }
        }
        // Every LIDAR annotation inside the area becomes a candidate of its own
        // (the spec: an annotated zone is returned automatically).
        (ctx.ignoreLidar ? [] : ctx.lidarPoints).forEach(function (p) {
            var m = projectToLocalMeters(p.lat, p.lng, ctx.lat0);
            if (inCircle(sq, m.x, m.y)) {
                seeds.push({ x: m.x, y: m.y, origin: 'lidar', lidarPoint: p });
            }
        });
        // …and so does every triangulation bubble that falls inside the area.
        ctx.bubbles.forEach(function (b) {
            if (inCircle(sq, b.x, b.y)) {
                seeds.push({ x: b.x, y: b.y, origin: 'potential', bubble: b });
            }
        });
        return seeds;
    }

    // Mandatory spatial exclusions (site radii + polygons). Mirrors
    // archeo-potential.js: same radius, same perimeter guard points.
    function passesSiteFilters(x, y, ctx) {
        for (var p = 0; p < ctx.polygons.length; p++) {
            var rings = ctx.polygons[p].rings;
            for (var r = 0; r < rings.length; r++) {
                if (pointInPolygon(x, y, rings[r])) return { ok: false, reason: 'site_polygon' };
            }
        }
        var minDist = CONFIG.SITE.RADIUS_M + CONFIG.SITE.BUFFER_M;
        for (var i = 0; i < ctx.siteRecords.length; i++) {
            if (distanceToSite(x, y, ctx.siteRecords[i]) < minDist) {
                return { ok: false, reason: 'site_radius' };
            }
        }
        return { ok: true };
    }

    function nearestBubble(x, y, ctx) {
        var best = null;
        for (var i = 0; i < ctx.bubbles.length; i++) {
            var b = ctx.bubbles[i];
            var dx = x - b.x, dy = y - b.y;
            var d = Math.sqrt(dx * dx + dy * dy);
            var radius = b.radiusM || 300;
            var hit = { bubble: b, distM: d, edgeDistM: Math.max(0, d - radius), inside: d <= radius };
            // A small nearby centre must not hide a larger containing bubble.
            if (!best || (hit.inside && !best.inside) ||
                (hit.inside === best.inside && hit.edgeDistM < best.edgeDistM)) best = hit;
        }
        return best;
    }

    function nearestLidar(x, y, ctx) {
        var best = null, bestD = Infinity;
        for (var i = 0; i < ctx.lidarPoints.length; i++) {
            var p = ctx.lidarPoints[i];
            var m = projectToLocalMeters(p.lat, p.lng, ctx.lat0);
            var dx = x - m.x, dy = y - m.y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) { bestD = d; best = p; }
        }
        if (!best) return null;
        return { point: best, distM: bestD, annotated: bestD <= CONFIG.LIDAR.HIT_M };
    }

    // Full evaluation of one seed: exclusions first, then the weighted score.
    function evaluateSeed(seed, ctx) {
        var x = seed.x, y = seed.y;

        // ── exclusion A: UAT red + 500 m clearance ──
        var uat = uatVerdict(ctx.uatGrid, x, y, CONFIG.UAT.CLEARANCE_M);
        if (!uat.red) return { ok: false, reason: 'uat_not_red' };
        if (uat.clearanceM < CONFIG.UAT.CLEARANCE_M) return { ok: false, reason: 'uat_too_close' };

        // ── exclusion B: site radii / polygons ──
        var site = passesSiteFilters(x, y, ctx);
        if (!site.ok) return { ok: false, reason: site.reason };

        // ── LIDAR context (needed for the APM waiver) ──
        var lidar = nearestLidar(x, y, ctx);
        var exclusionM = (window._lidarScannerApi && window._lidarScannerApi.resultRadiusM) || CONFIG.LIDAR.EXCLUSION_M;
        if (ctx.ignoreLidar && lidar && lidar.distM <= exclusionM) {
            return { ok: false, reason: 'lidar_ignored' };
        }
        // Do not allow a seed label or a nearby grid point to invent an annotation.
        var annotated = !ctx.ignoreLidar && !!(lidar && lidar.annotated);
        if (ctx.ignoreLidar) lidar = null;

        // ── exclusion C: APM 2.0 must be at least neutral ──
        var apmCls = apmClassAt(ctx.apmGrid, x, y);
        var apmAllowed = CONFIG.APM.ALLOWED.indexOf(apmCls) !== -1;
        if (!apmAllowed && !annotated) return { ok: false, reason: 'apm_below_average' };

        // ── weighted score ──
        var S = CONFIG.SCORING;
        var apmComp = S.APM_CLASS_SCORE[String(apmCls)];
        var apmKnown = apmComp !== undefined;
        if (!apmKnown) apmComp = S.APM_UNKNOWN;

        var pot = nearestBubble(x, y, ctx);
        var potComp;
        if (!ctx.bubbles.length) potComp = S.POTENTIAL_NONE;
        else if (pot.inside) potComp = clamp01(pot.bubble.score);
        else if (pot.distM <= CONFIG.POTENTIAL.PROXIMITY_M)
            potComp = clamp01(pot.bubble.score * (1 - pot.distM / CONFIG.POTENTIAL.PROXIMITY_M));
        else potComp = 0;

        var lidarNearby = annotated || (lidar && lidar.distM <= CONFIG.LIDAR.PROXIMITY_M);
        var lidarComp = null;
        if (lidarNearby) {
            // LIDAR is deliberately applied only when it can actually inform
            // this candidate. A point elsewhere must not reduce an otherwise
            // strong APM + triangulated-potential result.
            lidarComp = annotated ? 1 : clamp01(1 - lidar.distM / CONFIG.LIDAR.PROXIMITY_M);
        }

        // If there is no scanner evidence in the configured neighbourhood,
        // remove its weight and renormalise the remaining evidence. This is
        // important: missing LIDAR coverage is unknown, not negative evidence.
        var score;
        if (lidarNearby) {
            score = S.W_APM * apmComp + S.W_POTENTIAL * potComp + S.W_LIDAR * lidarComp;
        } else {
            var nonLidarWeight = S.W_APM + S.W_POTENTIAL;
            score = nonLidarWeight ? (S.W_APM * apmComp + S.W_POTENTIAL * potComp) / nonLidarWeight : 0;
        }
        if (annotated) score += S.LIDAR_ANNOTATION_BONUS;

        // Roman-road proximity is a bonus only: applied when a road is near,
        // otherwise the score is left unchanged (no penalty / no renormalise).
        var roadDistM;
        if (ctx.romanRoadLayer) {
            /* The map's own roads layer is loaded: measure in it (the geometry
             * is already in memory as typed arrays) instead of re-parsing the
             * 25 MB reference GeoJSON for every analysis. */
            var roadLl = localMetersToLatLng(x, y, ctx.lat0);
            roadDistM = ctx.romanRoadLayer.nearestRoadMeters(roadLl.lat, roadLl.lng, CONFIG.ROMAN_ROADS.PROXIMITY_M);
        } else {
            roadDistM = nearestRomanRoadM(x, y, ctx.romanRoadSegs);
        }
        var roadNearby = roadDistM !== null && roadDistM <= CONFIG.ROMAN_ROADS.PROXIMITY_M;
        var roadComp = null;
        if (roadNearby) {
            roadComp = clamp01(1 - roadDistM / CONFIG.ROMAN_ROADS.PROXIMITY_M);
            score += S.W_ROMAN_ROADS * roadComp;
        }
        score = clamp01(score);

        var ll = localMetersToLatLng(x, y, ctx.lat0);
        return {
            ok: true,
            x: x, y: y, lat: ll.lat, lng: ll.lng,
            origin: seed.origin,
            annotated: annotated,
            score: score,
            classification: classifyScore(score),
            parts: {
                apmCls: apmCls, apmComp: apmComp, apmKnown: apmKnown, apmWaived: !apmKnown && annotated,
                potentialComp: potComp,
                potentialInside: !!(pot && pot.inside),
                potentialDistM: pot ? Math.round(pot.distM) : null,
                potentialScore: pot ? pot.bubble.score : null,
                potentialFactors: pot ? pot.bubble.factors : null,
                bubblesInArea: (ctx.bubblesInArea || []).length,
                lidarComp: lidarComp,
                lidarApplied: !!lidarNearby,
                lidarIgnored: !!ctx.ignoreLidar,
                lidarDistM: lidar ? Math.round(lidar.distM) : null,
                lidarPoint: lidar ? lidar.point : null,
                uatClearanceM: isFinite(uat.clearanceM) ? Math.round(uat.clearanceM) : null,
                romanRoadApplied: roadNearby,
                romanRoadComp: roadComp,
                romanRoadDistM: roadDistM !== null ? Math.round(roadDistM) : null
            }
        };
    }

    function classifyScore(score) {
        if (score >= CONFIG.CLASSIFY.HIGH_FROM) return 'high';
        if (score >= CONFIG.CLASSIFY.MEDIUM_FROM) return 'medium';
        return 'low';
    }

    // LIDAR-annotated candidates are returned automatically, so they go first;
    // the rest follow by score. A minimum separation keeps the three labels
    // readable instead of stacking three polygons on the same spot.
    function selectResults(candidates, maxResults, minSeparationM) {
        var sorted = candidates.slice().sort(function (a, b) {
            if (a.annotated !== b.annotated) return a.annotated ? -1 : 1;
            return b.score - a.score;
        });
        var kept = [];
        var minSep2 = minSeparationM * minSeparationM;
        for (var i = 0; i < sorted.length && kept.length < maxResults; i++) {
            var c = sorted[i];
            var okSep = true;
            for (var j = 0; j < kept.length; j++) {
                var dx = c.x - kept[j].x, dy = c.y - kept[j].y;
                if (dx * dx + dy * dy < minSep2) { okSep = false; break; }
            }
            if (okSep) kept.push(c);
        }
        return kept;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 9. PERIOD ESTIMATION (triangulation on the nearest known sites)
     * ═══════════════════════════════════════════════════════════════════════
     * The estimated period is an inverse-distance-weighted vote over the
     * PERIOD_SITES nearest known sites' own dating fields. It is presented as
     * an approximation, always together with the sites it was derived from. */

    var PERIOD_RULES = [
        { key: 'paleolithic', re: /paleolitic|palaeolitic|paleolithic/i },
        { key: 'mesolithic', re: /mezolitic|mesolitic/i },
        // eneolithic BEFORE neolithic: "Eneolitic" also contains "neolitic".
        // RAN culture names count as dating too (Coțofeni, Petrești, Vinča,
        // Gumelnița, Hamangia, Boian, Decea are Eneolithic cultures).
        { key: 'eneolithic', re: /eneolitic|eneolithic|eneo|cucuteni|cotofeni|petre[sș]ti|gumelni[tț]a|hamangia|vin[cč]a|decea|boian/i },
        { key: 'neolithic', re: /neolitic|neolithic|star[cč]evo|\bcri[sș]\b/i },
        { key: 'bronze_age', re: /bronz|bronze/i },
        { key: 'hallstatt', re: /hallstatt/i },
        { key: 'iron_age', re: /fierului|fier\b|iron age|lat[eè]ne|latene/i },
        { key: 'dacian', re: /dacic|geto[- ]?dac|geto/i },
        // "castrul / castru" = Roman fort in the RAN naming convention.
        { key: 'roman', re: /roman|romano|romano-bizantin|castru|castrul|vicus/i },
        { key: 'migration', re: /migrat|migration|popoarelor/i },
        { key: 'medieval', re: /mediev|mediaev|feudal/i },
        { key: 'modern', re: /modern|contemporan/i },
        { key: 'prehistoric', re: /preistor/i },
        { key: 'antiquity', re: /antic|antichit/i }
    ];

    /* ── Century / millennium notation ──────────────────────────────────────
     * RAN records are frequently dated in centuries ("sec. II-III p.Chr.",
     * "secolul al IV-lea", "sec. XII-XIII") or millennia, not era names. A
     * century (or century range) is mapped onto the report's period keys so
     * the estimate can use it. Fails closed: anything that is not clearly a
     * century expression returns null. */

    var ROMAN_DIGIT_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100 };

    function romanToInt(s) {
        var total = 0, prev = 0;
        for (var i = s.length - 1; i >= 0; i--) {
            var v = ROMAN_DIGIT_VALUES[s.charAt(i).toUpperCase()];
            if (v === undefined) return NaN;
            total += (v < prev) ? -v : v;
            prev = v;
        }
        return total;
    }

    var CENTURY_NUM = '([IVXLCDM]+|\\d{1,2})';
    var CENTURY_RANGE_RE = new RegExp(
        '^\\s*(?:al\\s+)?' + CENTURY_NUM + '(?:\\s*-lea|-le)?' +
        '(?:\\s*(?:[-–—,]|până\\s+la|și|si)\\s*(?:al\\s+)?' + CENTURY_NUM + '(?:\\s*-lea|-le)?)?',
        'i'
    );
    // NB: no \\b around the Romanian era markers — ă/â/î/ș/ț are not JS word
    // characters, so \\b breaks on "î.Chr." / "d.Hr.". The (?:^|[\\s(]) prefix
    // anchors them to a token start instead.
    var CENTURY_BC_RE = /(?:^|[\s(])(?:î|i|a)\.?\s*Chr|(?:^|\s)BC(?![A-Za-z])|(?:^|[\s(])(?:î|i)\.?\s*Hr|(?:^|[\s(])(?:î|i)\.?\s*e\.?\s*n\./i;
    var CENTURY_AD_RE = /(?:^|[\s(])(?:p|d)\.?\s*Chr|(?:^|\s)AD(?![A-Za-z])|(?:^|[\s(])(?:p|d)\.?\s*Hr|(?:^|[\s(])e\.?\s*n\./i;

    // "sec. II-III p.Chr." / "secolele XII–XIII" / "mileniul I î.Chr." →
    // { from, to, bc, millennium } or null.
    // The keyword must end a word (letter lookahead, not \\b — a trailing \\b
    // fails after "sec.", where '.' and ' ' are both non-word characters).
    var CENTURY_KEYWORD_RE = /\b(sec\.?|secole?(?:ul|ele|ului)?|mileniu(?:l|le)?)(?![A-Za-z0-9\u0103\u0102\u00E2\u00C2\u00EE\u00CE\u0219\u0218\u021B\u021A])/i;

    function parseCenturyRange(text) {
        var s = String(text || '');
        var m = CENTURY_KEYWORD_RE.exec(s);
        if (!m) return null;
        var isMillennium = /milen/i.test(m[0]);
        var tail = s.slice(m.index + m[0].length);
        var rm = CENTURY_RANGE_RE.exec(tail);
        if (!rm) return null;
        var v1 = /^\d+$/.test(rm[1]) ? parseInt(rm[1], 10) : romanToInt(rm[1]);
        if (!isFinite(v1) || v1 < 1 || v1 > 40) return null;
        var v2 = v1;
        if (rm[2]) {
            var raw2 = /^\d+$/.test(rm[2]) ? parseInt(rm[2], 10) : romanToInt(rm[2]);
            if (!isFinite(raw2) || raw2 < 1 || raw2 > 40) return null;
            v2 = raw2;
        }
        var bcIdx = tail.search(CENTURY_BC_RE);
        var adIdx = tail.search(CENTURY_AD_RE);
        // Default AD (Romanian records are AD unless marked); when both markers
        // appear, the one closer to the numerals wins.
        var bc = bcIdx !== -1 && (adIdx === -1 || bcIdx < adIdx);
        return { from: v1, to: v2, bc: bc, millennium: isMillennium };
    }

    // One century (BC = negative) mapped onto the period scale, following the
    // conventions used in Romanian archaeology for Transylvania.
    function centuryPeriod(c) {
        if (c < 0) {
            if (c >= -1) return 'dacian';        // sec. I î.Chr. (Burebista)
            if (c >= -5) return 'iron_age';      // sec. II–V î.Chr. — La Tène
            if (c >= -12) return 'hallstatt';    // sec. VI–XII î.Chr. — first Iron Age
            if (c >= -30) return 'bronze_age';
            return 'prehistoric';
        }
        if (c <= 3) return 'roman';              // sec. I–III — Roman Dacia (106–271)
        if (c <= 7) return 'migration';          // sec. IV–VII
        if (c <= 18) return 'medieval';          // sec. VIII–XVIII
        return 'modern';
    }

    function periodKeyFromCenturies(from, to, bc) {
        var lo = Math.min(from, to), hi = Math.max(from, to);
        if (!isFinite(lo) || !isFinite(hi) || hi - lo > 30) return null;
        // vote per century; on a tie the bucket closest to year 0 wins
        // ("sec. II-I î.Chr." → dacian, "sec. III-IV p.Chr." → roman — the
        // more distinctive horizon on either side of the era boundary)
        var votes = {};
        for (var c = lo; c <= hi; c++) {
            var k = centuryPeriod(bc ? -c : c);
            if (!votes[k]) votes[k] = { n: 0, minAbs: Infinity };
            votes[k].n++;
            if (c < votes[k].minAbs) votes[k].minAbs = c;
        }
        var best = null, bestN = 0, bestAbs = Infinity;
        Object.keys(votes).forEach(function (k) {
            var v = votes[k];
            if (v.n > bestN || (v.n === bestN && v.minAbs < bestAbs)) {
                best = k; bestN = v.n; bestAbs = v.minAbs;
            }
        });
        return best;
    }

    function periodKeyFromMillennium(n, bc) {
        if (bc) {
            if (n <= 1) return 'iron_age';       // mileniul I î.Chr. — the Iron Age
            if (n === 2) return 'bronze_age';
            return 'prehistoric';
        }
        if (n <= 1) return 'antiquity';          // mileniul I p.Chr. — Antiquity as a whole
        return 'modern';
    }

    function periodKey(text) {
        if (!text) return null;
        for (var i = 0; i < PERIOD_RULES.length; i++) {
            if (PERIOD_RULES[i].re.test(text)) return PERIOD_RULES[i].key;
        }
        var c = parseCenturyRange(text);
        if (!c) return null;
        if (c.millennium) return periodKeyFromMillennium(c.from, c.bc);
        return periodKeyFromCenturies(c.from, c.to, c.bc);
    }

    function estimatePeriod(sites, count) {
        var used = sites.slice(0, count || CONFIG.PERIOD_SITES);
        var votes = {};
        var evidence = [];
        used.forEach(function (s, i) {
            // siteInfo() pre-computes periodKey (dating property → site name);
            // raw objects fall back to the same chain here.
            var key = (s.periodKey !== undefined) ? s.periodKey
                : (periodKey(s.period) || periodKey(s.name));
            var fromName = (s.datingFromName !== undefined) ? !!s.datingFromName
                : (!s.period && !!key);
            evidence.push({
                name: s.name, period: s.period || null, periodKey: key,
                datingFromName: fromName,
                distanceM: s.distanceM, ran: s.ran, url: s.url, index: i + 1
            });
            if (!key) return;
            var w = 1 / Math.max(s.distanceM, 200);
            votes[key] = (votes[key] || 0) + w;
        });
        var best = null, bestW = 0;
        Object.keys(votes).forEach(function (k) {
            if (votes[k] > bestW) { bestW = votes[k]; best = k; }
        });
        return {
            key: best,
            votes: votes,
            evidence: evidence,
            confidence: best ? clamp01(bestW / Math.max(1e-9, Object.keys(votes).reduce(function (a, k) { return a + votes[k]; }, 0))) : 0
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 10. RESULT MODEL (everything the PDF + the popups need)
     * ═══════════════════════════════════════════════════════════════════════ */

    function nearestSitesFor(x, y, ctx, count) {
        return ctx.siteRecords.map(function (rec) {
            return { rec: rec, distanceM: distanceToSite(x, y, rec) };
        }).sort(function (a, b) { return a.distanceM - b.distanceM; })
          .slice(0, count || CONFIG.NEAREST_SITES)
          .map(function (item) {
              var info = siteInfo(item.rec);
              info.distanceM = Math.round(item.distanceM);
              return info;
          });
    }

    function scoringWeights(applyLidar) {
        var S = CONFIG.SCORING;
        var divisor = applyLidar ? 1 : (S.W_APM + S.W_POTENTIAL);
        return {
            apm: divisor ? S.W_APM / divisor : 0,
            potential: divisor ? S.W_POTENTIAL / divisor : 0,
            lidar: applyLidar ? S.W_LIDAR : 0,
            romanRoads: S.W_ROMAN_ROADS
        };
    }

    function buildResultModel(cand, ctx, index, total) {
        var nearest = nearestSitesFor(cand.x, cand.y, ctx, CONFIG.NEAREST_SITES);
        var period = estimatePeriod(nearest, CONFIG.PERIOD_SITES);
        var ll = { lat: cand.lat, lng: cand.lng };
        return {
            index: index,
            total: total,
            label: tr('arch_report_result') + ' ' + index + '/' + total,
            lat: ll.lat,
            lng: ll.lng,
            score: cand.score,
            scorePct: Math.round(cand.score * 100),
            classification: cand.classification,
            classificationLabel: tr('arch_report_class_' + cand.classification),
            annotated: cand.annotated,
            origin: cand.origin,
            parts: cand.parts,
            weights: scoringWeights(cand.parts.lidarApplied),
            nearestSites: nearest,
            period: period,
            polygon: resultPolygon(ll.lat, ll.lng, CONFIG.RESULT_RADIUS_M, ctx.lat0)
        };
    }

    // Blue result footprint: a circle (32 vertices for PDF / geometry).
    function resultPolygon(lat, lng, radiusM, lat0) {
        var c = projectToLocalMeters(lat, lng, lat0);
        var n = CONFIG.RESULT_CIRCLE_VERTS || 32;
        var pts = [];
        for (var i = 0; i < n; i++) {
            var a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
            var p = localMetersToLatLng(c.x + radiusM * Math.cos(a), c.y + radiusM * Math.sin(a), lat0);
            pts.push([p.lat, p.lng]);
        }
        return pts;
    }

    function polygonLatLngToLocal(poly, lat0) {
        return poly.map(function (ll) { return projectToLocalMeters(ll[0], ll[1], lat0); });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 11. ANALYSIS PIPELINE
     * ═══════════════════════════════════════════════════════════════════════ */

    var _state = {
        active: false,          // layer switched on (map clicks pick the point)
        point: null,            // picked analysis centre {lat,lng}
        running: false,
        results: [],            // result models
        model: null,            // full report model
        figures: null,          // cached screenshots
        visible: true,
        version: 0,
        layerGroup: null,
        pdfLang: null           // PDF language override ('ro'|'en'); null = site language
    };

    // PDF language — the user picks RO or EN in the panel before downloading;
    // the choice defaults to the site language and is remembered for the
    // session (in-memory + sessionStorage so a reload keeps it in the tab).
    var PDF_LANG_STORAGE_KEY = 'archReportPdfLang';

    function pdfLanguage() {
        if (_state.pdfLang === 'ro' || _state.pdfLang === 'en') return _state.pdfLang;
        return lang();
    }

    function setPdfLanguage(code) {
        if (code !== 'ro' && code !== 'en') return pdfLanguage();
        _state.pdfLang = code;
        try {
            if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(PDF_LANG_STORAGE_KEY, code);
        } catch (e) { /* storage unavailable — the in-memory choice still holds */ }
        syncPdfLangUi();
        return code;
    }

    function syncPdfLangUi() {
        var active = pdfLanguage();
        ['ro', 'en'].forEach(function (code) {
            var btn = el('archReportPdfLang' + (code === 'ro' ? 'Ro' : 'En'));
            if (btn) btn.classList.toggle('is-active', code === active);
        });
    }

    (function restorePdfLang() {
        try {
            var saved = (typeof sessionStorage !== 'undefined')
                ? sessionStorage.getItem(PDF_LANG_STORAGE_KEY) : null;
            if (saved === 'ro' || saved === 'en') _state.pdfLang = saved;
        } catch (e) { /* no storage — fall back to the site language */ }
    })();

    function el(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }

    function setStatus(key, isError, vars) {
        var node = el('archReportStatus');
        if (!node) return;
        node.textContent = tr(key, vars);
        node.classList.toggle('error', !!isError);
    }

    function setSummary(text) {
        var node = el('archReportSummary');
        if (!node) return;
        node.innerHTML = text || '';
        node.style.display = text ? '' : 'none';
    }

    function setRunning(running) {
        var btn = el('archReportRunBtn');
        if (btn) {
            btn.disabled = running || !_state.point;
            btn.classList.toggle('running', running);
            btn.innerHTML = running
                ? '<span class="arch-report-spinner" aria-hidden="true"></span><span class="t" data-key="arch_report_run_running">Analyzing…</span>'
                : '<span class="t" data-key="arch_report_run_btn">Generate report</span>';
        }
        var pdfBtn = el('archReportPdfBtn');
        if (pdfBtn) pdfBtn.disabled = running;
        var ignore = el('archReportIgnoreLidar');
        if (ignore) ignore.disabled = running;
        var ov = el('archReportLoading');
        if (ov) ov.classList.toggle('visible', !!running);
    }

    // The run button only makes sense once a point has been picked.
    function updateRunButton() {
        var btn = el('archReportRunBtn');
        var show = !!_state.point;
        if (btn) {
            if (!_state.running) btn.disabled = !show;
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

    // The heritage FeatureCollections load asynchronously with the page.
    function waitForSiteData() {
        return new Promise(function (resolve) {
            var waited = 0;
            (function poll() {
                var data = window._localLayerData;
                if (data && data[0] !== undefined && data[0] !== null) return resolve(data);
                waited += CONFIG.SITES_DATA_POLL_MS;
                if (waited >= CONFIG.SITES_DATA_TIMEOUT_MS) return resolve(data || {});
                setTimeout(poll, CONFIG.SITES_DATA_POLL_MS);
            })();
        });
    }

    function buildBbox(square, padM, lat0) {
        var minX = square.minX - padM, maxX = square.maxX + padM;
        var minY = square.minY - padM, maxY = square.maxY + padM;
        var a = localMetersToLatLng(minX, minY, lat0);
        var b = localMetersToLatLng(maxX, maxY, lat0);
        return {
            minX: minX, maxX: maxX, minY: minY, maxY: maxY, lat0: lat0,
            minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat),
            minLng: Math.min(a.lng, b.lng), maxLng: Math.max(a.lng, b.lng)
        };
    }

    /**
     * Full analysis of the circular radius around `_state.point`.
     * @returns {Promise<Object|null>} the report model (null when aborted/failed)
     */
    function runReport() {
        if (_state.running) return Promise.resolve(null);
        if (!_state.point) { setStatus('arch_report_need_point', true); return Promise.resolve(null); }
        syncSiteConfig();

        _state.running = true;
        _state.version++;
        var myVersion = _state.version;
        var center = _state.point;
        var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        setRunning(true);
        setSummary('');
        clearResults();
        _state.figures = null;

        var ctx = null;

        return (async function main() {
            try {
                setStatus('arch_report_step_sites');
                await waitForSiteData();
                if (myVersion !== _state.version) return null;

                var radiusKm = currentRadiusKm();
                var radiusM = radiusKm * 1000;
                ctx = {
                    center: center,
                    lat0: center.lat,
                    radiusKm: radiusKm,
                    ignoreLidar: !!(el('archReportIgnoreLidar') && el('archReportIgnoreLidar').checked),
                    radiusM: radiusM,
                    areaKm2: Math.PI * radiusM * radiusM / 1e6,
                    square: analysisArea(center.lat, center.lng, radiusM)
                };

                // ── known sites (radii + polygons) via archeo-potential.js ──
                var collected = collectSites(center.lat, center.lng, Math.max(CONFIG.POTENTIAL.SEARCH_RADIUS_M, radiusM + CONFIG.SITE.RADIUS_M + CONFIG.SITE.BUFFER_M), ctx.lat0);
                ctx.sites = collected.sites || [];
                ctx.polygons = collected.polygons || [];
                ctx.siteRecords = buildSiteRecords(ctx.sites);

                // ── same packed bubbles as the visible potential layer ──
                setStatus('arch_report_step_potential');
                ctx.bubbles = [];
                ctx.potentialStatus = 'unavailable';
                if (typeof window.computeArcheoPotentialField === 'function') {
                    try {
                        var pot = await window.computeArcheoPotentialField(center.lat, center.lng, radiusM, {
                            mode: 'bubbles',
                            isCancelled: function () { return myVersion !== _state.version; },
                            chunkSize: 400,
                            skipDataWait: true      // waitForSiteData() ran just above
                        });
                        if (myVersion !== _state.version) return null;
                        ctx.potentialStatus = pot.status;
                        if (pot.status === 'ok' || pot.status === 'sparse_sites') ctx.bubbles = pot.bubbles || [];
                    } catch (e) {
                        console.warn('[ArcheoReport] potential layer failed:', e);
                    }
                }
                ctx.bubblesInArea = ctx.bubbles.filter(function (b) {
                    return inCircle(ctx.square, b.x, b.y);
                });

                // ── LIDAR Scanner annotations ──
                setStatus('arch_report_step_lidar');
                var allLidar = await loadLidarPoints(ctx.ignoreLidar);
                if (myVersion !== _state.version) return null;
                var margin = CONFIG.LIDAR.PROXIMITY_M + CONFIG.UAT.CLEARANCE_M;
                ctx.lidarPoints = allLidar.filter(function (p) {
                    var m = projectToLocalMeters(p.lat, p.lng, ctx.lat0);
                    return m.x >= ctx.square.minX - margin && m.x <= ctx.square.maxX + margin &&
                           m.y >= ctx.square.minY - margin && m.y <= ctx.square.maxY + margin;
                }).map(function (p) { return p; });
                ctx.lidarInArea = ctx.lidarPoints.filter(function (p) {
                    var m = projectToLocalMeters(p.lat, p.lng, ctx.lat0);
                    return inCircle(ctx.square, m.x, m.y);
                });

                setStatus('arch_report_step_roads');
                ctx.romanRoadLayer = mapRomanRoadsLayer();
                if (ctx.romanRoadLayer) {
                    /* „Drumuri romane” is on: its canvas layer already holds
                     * the network, so nothing is downloaded or parsed here. */
                    var swRoad = localMetersToLatLng(ctx.square.minX, ctx.square.minY, ctx.lat0);
                    var neRoad = localMetersToLatLng(ctx.square.maxX, ctx.square.maxY, ctx.lat0);
                    ctx.romanRoadSegs = [];
                    ctx.romanRoadsInArea = ctx.romanRoadLayer.roadSegmentsInBounds(
                        swRoad.lat, swRoad.lng, neRoad.lat, neRoad.lng);
                } else {
                    var roadsGj = await loadRomanRoadsGeojson();
                    if (myVersion !== _state.version) return null;
                    ctx.romanRoadSegs = romanRoadSegmentsInSquare(roadsGj, ctx.square, ctx.lat0, CONFIG.ROMAN_ROADS.PROXIMITY_M);
                    ctx.romanRoadsInArea = ctx.romanRoadSegs.length;
                }

                // ── rasters (UAT red zone + APM 2.0 colours) ──
                setStatus('arch_report_step_uat');
                var bbox = buildBbox(ctx.square, CONFIG.UAT.CLEARANCE_M + CONFIG.UAT.CELL_M * 2, ctx.lat0);
                ctx.bbox = bbox;
                var uatPromise = buildUatGrid(bbox, uatCellM(ctx.radiusM));
                setStatus('arch_report_step_apm');
                var apmPromise = buildApmGrid(bbox, apmCellM(ctx.radiusM), CONFIG.APM.Z);
                var grids = await Promise.all([uatPromise, apmPromise]);
                if (myVersion !== _state.version) return null;
                ctx.uatGrid = grids[0];
                ctx.apmGrid = grids[1];

                // ── seeds → exclusions → weighted score ──
                setStatus('arch_report_step_scoring');
                var seeds = buildSeeds(ctx);
                ctx.seeds = seeds;
                var candidates = [];
                var rejected = {};
                for (var i = 0; i < seeds.length; i += 60) {
                    var batch = seeds.slice(i, i + 60);
                    batch.forEach(function (seed) {
                        var res = evaluateSeed(seed, ctx);
                        if (res.ok) candidates.push(res);
                        else rejected[res.reason] = (rejected[res.reason] || 0) + 1;
                    });
                    await yieldToUI();
                    if (myVersion !== _state.version) return null;
                }
                ctx.rejected = rejected;
                ctx.candidates = candidates;

                var picked = selectResults(candidates, CONFIG.MAX_RESULTS, CONFIG.RESULT_MIN_SEPARATION_M);
                var results = picked.map(function (cand, idx) {
                    return buildResultModel(cand, ctx, idx + 1, picked.length);
                });

                _state.results = results;
                _state.ctx = ctx;   // kept for the figure overlays (sites, LIDAR)
                _state.model = {
                    // lat/lng copies for the canvas overlays (the PDF figures)
                    potentialBubbles: ctx.bubbles.map(function (b) {
                        return { lat: b.lat, lng: b.lng, score: b.score, radiusM: b.radiusM };
                    }),
                    meta: {
                        generatedAt: new Date(),
                        lang: lang(),
                        areaKm2: Math.round(ctx.areaKm2 * 100) / 100,
                        radiusKm: ctx.radiusKm,
                        radiusM: Math.round(ctx.radiusM),
                        sideM: Math.round(ctx.square.sideM),
                        center: { lat: center.lat, lng: center.lng },
                        sitesCount: ctx.siteRecords.length,
                        bubblesCount: ctx.bubbles.length,
                        bubblesInArea: ctx.bubblesInArea.length,
                        potentialStatus: ctx.potentialStatus,
                        ignoreLidar: ctx.ignoreLidar,
                        lidarCount: ctx.lidarPoints.length,
                        lidarInArea: ctx.lidarInArea.length,
                        /* Filled from the reference GeoJSON or, when the map
                         * layer is on, from the loaded canvas layer. */
                        romanRoadSegments: ctx.romanRoadsInArea || 0,
                        seeds: seeds.length,
                        candidates: candidates.length,
                        rejected: rejected,
                        uatAvailable: !!ctx.uatGrid.available,
                        apmAvailable: !!ctx.apmGrid.available,
                        apmUnreadable: !!ctx.apmGrid.unreadable,
                        ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
                    },
                    results: results,
                    weights: scoringWeights(!ctx.ignoreLidar),
                    thresholds: {
                        uatClearanceM: CONFIG.UAT.CLEARANCE_M,
                        siteRadiusM: CONFIG.SITE.RADIUS_M,
                        siteBufferM: CONFIG.SITE.BUFFER_M,
                        lidarHitM: CONFIG.LIDAR.HIT_M,
                        lidarProximityM: CONFIG.LIDAR.PROXIMITY_M,
                        potentialProximityM: CONFIG.POTENTIAL.PROXIMITY_M,
                        romanRoadProximityM: CONFIG.ROMAN_ROADS.PROXIMITY_M
                    }
                };

                renderResults(_state.model);
                updateUi();

                console.log('[ArcheoReport] ' + seeds.length + ' seeds, ' + candidates.length +
                    ' passed filters, ' + results.length + ' results — ' + _state.model.meta.ms + ' ms',
                    rejected);

                if (!results.length) setStatus('arch_report_no_results', true);
                else setStatus('arch_report_done');
                return _state.model;
            } catch (err) {
                console.error('[ArcheoReport] analysis failed:', err);
                setStatus('arch_report_error', true);
                return null;
            } finally {
                if (myVersion === _state.version) _state.running = false;
                setRunning(false);
            }
        })();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 12. MAP RENDERING — blue circular rings + "Result 1/2/3" labels
     * ═══════════════════════════════════════════════════════════════════════ */

    function ensurePanes(map) {
        if (!map || !map.createPane) return false;
        [[CONFIG.RENDER.PANE_SHAPES, CONFIG.RENDER.Z_SHAPES, 'none'],
         [CONFIG.RENDER.PANE_TAGS, CONFIG.RENDER.Z_TAGS, '']].forEach(function (def) {
            if (!map.getPane(def[0])) map.createPane(def[0]);
            var pane = map.getPane(def[0]);
            if (pane && pane.style) {
                pane.style.zIndex = def[1];
                pane.style.pointerEvents = def[2];
            }
        });
        return true;
    }

    function paneOption(name) {
        var map = window._dlMap;
        return (ensurePanes(map) && map.getPane(name)) ? name : undefined;
    }

    function assignPane(options, name) {
        var pane = paneOption(name);
        if (pane) options.pane = pane;
        return options;
    }

    function resultPopupHtml(res) {
        var pct = res.scorePct;
        var p = res.parts;
        var apmLabel = tr('arch_report_apm_class_' + (p.apmCls || 0));
        var rows = [
            ['<b>' + esc(tr('arch_report_row_apm')) + '</b>',
             esc(apmLabel) + ' · ' + pctComp(p.apmComp)],
            ['<b>' + esc(tr('arch_report_row_potential')) + '</b>',
             p.potentialInside
                ? esc(tr('arch_report_pot_inside', { score: pctComp(p.potentialScore) }))
                : (p.potentialDistM !== null && p.potentialDistM <= CONFIG.POTENTIAL.PROXIMITY_M
                    ? esc(tr('arch_report_pot_near', { dist: fmtM(p.potentialDistM), score: pctComp(p.potentialScore) }))
                    : esc(tr('arch_report_pot_none')))],
            ['<b>' + esc(tr('arch_report_row_lidar')) + '</b>',
             res.annotated
                ? esc(tr('arch_report_lidar_hit', { title: p.lidarPoint ? (p.lidarPoint.category || p.lidarPoint.name || '—') : '—' }))
                : (p.lidarDistM !== null && p.lidarDistM <= CONFIG.LIDAR.PROXIMITY_M
                    ? esc(tr('arch_report_lidar_near', { dist: fmtM(p.lidarDistM) }))
                    : esc(tr(p.lidarIgnored ? 'arch_report_ignore_lidar' : 'arch_report_lidar_none')))],
            ['<b>' + esc(tr('arch_report_row_roads')) + '</b>',
             p.romanRoadApplied
                ? esc(tr('arch_report_roads_near', { dist: fmtM(p.romanRoadDistM) }))
                : esc(tr('arch_report_roads_none'))],
            ['<b>' + esc(tr('arch_report_row_uat')) + '</b>',
             esc(tr('arch_report_uat_ok', { dist: fmtM(p.uatClearanceM) }))],
            ['<b>' + esc(tr('arch_report_row_period')) + '</b>',
             esc(res.period.key ? tr('arch_period_' + res.period.key) : tr('arch_report_period_unknown'))]
        ];
        var nearest = res.nearestSites[0];
        return '<div style="font-family:Outfit,sans-serif;min-width:230px;max-width:290px;padding:2px">' +
            '<div style="font-family:Cinzel,serif;font-size:0.86rem;color:#66c8ff;font-weight:700;margin-bottom:6px">' +
            '● ' + esc(res.label) + '</div>' +
            '<div style="font-size:0.8rem;color:rgba(245,240,235,0.95);margin-bottom:8px">' +
            '<strong>' + esc(res.classificationLabel) + '</strong> — ' + pct + '%</div>' +
            '<table style="width:100%;border-collapse:collapse;font-size:0.7rem;color:rgba(245,240,235,0.78);line-height:1.6">' +
            rows.map(function (r) {
                return '<tr><td style="padding:1px 6px 1px 0;vertical-align:top;white-space:nowrap;opacity:.85">' + r[0] + '</td>' +
                       '<td style="padding:1px 0;vertical-align:top">' + r[1] + '</td></tr>';
            }).join('') +
            '</table>' +
            '<div style="font-size:0.68rem;color:rgba(245,240,235,0.55);margin-top:8px;line-height:1.5">' +
            '📍 ' + res.lat.toFixed(5) + ', ' + res.lng.toFixed(5) +
            (nearest ? '<br>' + esc(tr('arch_report_closest_site')) + ': ' + esc(nearest.name) + ' · ' + fmtM(nearest.distanceM) : '') +
            '<br>' + esc(tr('arch_report_popup_hint')) +
            '</div>' +
            // Traseu Google Maps: destinația e centrul inelului (res.lat/res.lng),
            // indiferent de raza desenată — nu un punct de pe circumferință.
            (function () {
                var dir = (typeof window !== 'undefined' && window.DetectLabDirections && window.DetectLabDirections.buttonHtml)
                    ? window.DetectLabDirections.buttonHtml(res.lat, res.lng)
                    : '';
                return dir ? '<div style="margin-top:6px">' + dir + '</div>' : '';
            })() +
            '</div>';
    }

    var CIRCLE_SEGMENTS_3D = 32;
    var _renderSeq = 0;

    function groundRing3d(lat, lng, radiusM) {
        var ring = [];
        var latRad = lat * Math.PI / 180;
        var dLat = radiusM / 111320;
        var dLng = radiusM / (111320 * Math.max(Math.abs(latRad ? Math.cos(latRad) : 1), 0.2));
        for (var i = 0; i < CIRCLE_SEGMENTS_3D; i++) {
            var a = (i / CIRCLE_SEGMENTS_3D) * Math.PI * 2;
            ring.push([lng + Math.sin(a) * dLng, lat + Math.cos(a) * dLat]);
        }
        ring.push(ring[0].slice());
        return ring;
    }

    function feature3d(geometry, properties) {
        return { type: 'Feature', properties: properties, geometry: geometry };
    }

    function own3dFeatures(group, name, build) {
        if (!group) return;
        if (typeof group.eachLayer === 'function') {
            group.eachLayer(function (child) { child._dl3dSkip = true; });
        } else if (typeof group.getLayers === 'function') {
            (group.getLayers() || []).forEach(function (child) { if (child) child._dl3dSkip = true; });
        }
        group.options = group.options || {};
        group.options.name = name;
        var cache = { stamp: '', value: null };
        group._dl3dFeatures = function () {
            var built = build();
            if (!built) return null;
            if (cache.stamp === built.stamp && cache.value) return cache.value;
            cache = { stamp: built.stamp || '', value: built };
            return built;
        };
    }

    function sync3dIfOpen() {
        try {
            var m3d = window.DetectLabMap3D;
            if (m3d && typeof m3d.isOpen === 'function' && m3d.isOpen() && typeof m3d.syncLayers === 'function') {
                m3d.syncLayers();
            }
        } catch (e) { /* ignore */ }
    }

    function syncSearchCircle3dSkip() {
        if (!_searchCircle) return;
        var map = window._dlMap;
        var hasVisibleResults = !!(_state.visible && _state.layerGroup &&
            (!map || !map.hasLayer || map.hasLayer(_state.layerGroup)));
        _searchCircle._dl3dSkip = hasVisibleResults;
    }

    function searchAreaFeatures3d() {
        if (!_state.point || !isFinite(_state.point.lat) || !isFinite(_state.point.lng)) return null;
        var radiusM = currentRadiusM();
        var features = [
            feature3d(
                { type: 'Polygon', coordinates: [groundRing3d(_state.point.lat, _state.point.lng, radiusM)] },
                {
                    color: CIRCLE_STYLE_IDLE.color,
                    fillColor: CIRCLE_STYLE_IDLE.fillColor,
                    fillOpacity: CIRCLE_STYLE_IDLE.fillOpacity,
                    opacity: CIRCLE_STYLE_IDLE.opacity,
                    weight: CIRCLE_STYLE_IDLE.weight,
                    kind: 'radius'
                }
            ),
            feature3d(
                { type: 'Point', coordinates: [_state.point.lng, _state.point.lat] },
                {
                    color: CIRCLE_STYLE_IDLE.color,
                    fillColor: CIRCLE_STYLE_IDLE.fillColor,
                    fillOpacity: 0.9,
                    opacity: 1,
                    radius: 4,
                    kind: 'radius'
                }
            )
        ];
        return {
            geojson: { type: 'FeatureCollection', features: features },
            paints: {
                line: {
                    'line-color': CIRCLE_STYLE_IDLE.color,
                    'line-width': CIRCLE_STYLE_IDLE.weight,
                    'line-opacity': CIRCLE_STYLE_IDLE.opacity,
                    'line-dasharray': [2, 2]
                },
                fill: {
                    'line-color': CIRCLE_STYLE_IDLE.color,
                    'fill-color': CIRCLE_STYLE_IDLE.fillColor,
                    'fill-opacity': CIRCLE_STYLE_IDLE.fillOpacity
                },
                circle: {
                    'circle-radius': 4,
                    'circle-color': CIRCLE_STYLE_IDLE.fillColor,
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 1.5,
                    'circle-opacity': 0.9
                },
                layout: {}
            },
            stamp: 'arch_report_area|' + _state.point.lat.toFixed(6) + '|' + _state.point.lng.toFixed(6) + '|' + radiusM,
            label: 'Archeological Report'
        };
    }

    function reportResultsFeatures3d(model) {
        if (!model) return null;
        var features = [];
        var center = (model.meta && model.meta.center) || _state.point;
        var searchRadiusM = (model.meta && model.meta.radiusM) || currentRadiusM();
        if (center && isFinite(center.lat) && isFinite(center.lng) && isFinite(searchRadiusM) && searchRadiusM > 0) {
            features.push(feature3d(
                { type: 'Polygon', coordinates: [groundRing3d(center.lat, center.lng, searchRadiusM)] },
                {
                    color: CIRCLE_STYLE_IDLE.color,
                    fillColor: CIRCLE_STYLE_IDLE.fillColor,
                    fillOpacity: CIRCLE_STYLE_IDLE.fillOpacity,
                    opacity: CIRCLE_STYLE_IDLE.opacity,
                    weight: CIRCLE_STYLE_IDLE.weight,
                    kind: 'radius'
                }
            ));
            features.push(feature3d(
                { type: 'Point', coordinates: [center.lng, center.lat] },
                {
                    color: CIRCLE_STYLE_IDLE.color,
                    fillColor: CIRCLE_STYLE_IDLE.fillColor,
                    fillOpacity: 0.9,
                    opacity: 1,
                    radius: 4,
                    kind: 'radius'
                }
            ));
        }
        var strokeColor = CONFIG.RENDER.COLOR || '#66c8ff';
        var fillColor = CONFIG.RENDER.FILL || strokeColor;
        var ringRadiusM = CONFIG.RESULT_RADIUS_M || 180;
        var curLang = lang();
        (model.results || []).forEach(function (res) {
            if (!res || !isFinite(res.lat) || !isFinite(res.lng)) return;
            var locRes = Object.assign({}, res, {
                label: tr('arch_report_result') + ' ' + res.index + '/' + res.total,
                classificationLabel: tr('arch_report_class_' + res.classification)
            });
            var popup = resultPopupHtml(locRes);
            var tagText = locRes.label + ' · ' + res.scorePct + '%';
            features.push(feature3d(
                { type: 'Polygon', coordinates: [groundRing3d(res.lat, res.lng, ringRadiusM)] },
                {
                    index: res.index,
                    kind: 'result-ring',
                    color: strokeColor,
                    fillColor: fillColor,
                    fillOpacity: 0.22,
                    opacity: 0.98,
                    weight: 2,
                    radiusM: ringRadiusM,
                    lat: res.lat,
                    lng: res.lng,
                    score: res.score,
                    scorePct: res.scorePct,
                    label: tagText,
                    popup: popup
                }
            ));
            features.push(feature3d(
                { type: 'Point', coordinates: [res.lng, res.lat] },
                {
                    index: res.index,
                    kind: 'result-point',
                    color: '#ffffff',
                    fillColor: fillColor,
                    fillOpacity: 0.95,
                    opacity: 1,
                    radius: 7,
                    lat: res.lat,
                    lng: res.lng,
                    score: res.score,
                    scorePct: res.scorePct,
                    label: tagText,
                    tooltip: tagText,
                    popup: popup
                }
            ));
        });
        return {
            geojson: { type: 'FeatureCollection', features: features },
            paints: {
                line: {
                    'line-color': strokeColor,
                    'line-width': 2,
                    'line-opacity': 0.98,
                    'line-dasharray': [2, 2]
                },
                fill: {
                    'line-color': strokeColor,
                    'fill-color': fillColor,
                    'fill-opacity': 0.22
                },
                circle: {
                    'circle-radius': 7,
                    'circle-color': fillColor,
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                    'circle-stroke-opacity': 1,
                    'circle-opacity': 0.95
                },
                layout: {}
            },
            stamp: 'arch_report|' + _renderSeq + '|' + curLang + '|' + ((model.results && model.results.length) || 0),
            label: 'Archeological Report'
        };
    }

    function pctComp(v) {
        return (v === null || v === undefined) ? '—' : Math.round(v * 100) + '%';
    }

    function clearResults() {
        var map = window._dlMap;
        if (map && _state.layerGroup) map.removeLayer(_state.layerGroup);
        _state.layerGroup = null;
        _state.results = [];
        _state.model = null;
        syncSearchCircle3dSkip();
        sync3dIfOpen();
    }

    function renderResults(model) {
        var map = window._dlMap;
        if (!map) return;
        ensurePanes(map);
        if (_state.layerGroup) map.removeLayer(_state.layerGroup);

        var group = L.layerGroup([]);
        _state.layerGroup = group;

        // Result rings stay on Leaflet's SVG renderer (same reason as the
        // LIDAR Scanner): they are clickable, and the shapes pane is
        // pointer-events:none so a canvas surface would swallow map clicks.
        model.results.forEach(function (res) {
            var ring = L.circle([res.lat, res.lng], assignPane({
                radius: CONFIG.RESULT_RADIUS_M,
                color: CONFIG.RENDER.COLOR, weight: 2, dashArray: '3 6',
                fillColor: CONFIG.RENDER.FILL || CONFIG.RENDER.COLOR,
                fillOpacity: 0.11, opacity: 0.98, interactive: true
            }, CONFIG.RENDER.PANE_SHAPES));
            ring._dl3dSkip = true;
            ring.bindPopup(resultPopupHtml(res), { className: 'arch-report-popup', maxWidth: 320 });
            ring.bindTooltip(
                '<span class="arch-report-tag"><b>' + esc(res.label) + '</b><br>' + res.scorePct + '%</span>',
                assignPane({
                    permanent: true, direction: 'top', offset: [0, -14],
                    className: 'arch-report-tooltip', interactive: true
                }, CONFIG.RENDER.PANE_TAGS)
            );
            ring.on('tooltipopen', function (e) {
                var node = e.tooltip && e.tooltip.getElement ? e.tooltip.getElement() : null;
                if (node && !node._archReportWired) {
                    node._archReportWired = true;
                    node.addEventListener('click', function () { ring.openPopup(); });
                }
            });
            group.addLayer(ring);
        });

        _renderSeq += 1;
        own3dFeatures(group, 'Archeological Report', function () {
            return reportResultsFeatures3d(model);
        });
        if (_state.visible) group.addTo(map);
        syncSearchCircle3dSkip();
        updateUi();
        sync3dIfOpen();
    }

    function toggleResults(on) {
        _state.visible = !!on;
        var map = window._dlMap;
        if (!map || !_state.layerGroup) return;
        if (_state.visible) { if (!map.hasLayer(_state.layerGroup)) _state.layerGroup.addTo(map); }
        else if (map.hasLayer(_state.layerGroup)) map.removeLayer(_state.layerGroup);
        syncSearchCircle3dSkip();
        sync3dIfOpen();
    }

    function updateUi() {
        var model = _state.model;
        var pdfBtn = el('archReportPdfBtn');
        var pdfLangSel = el('archReportPdfLang');
        var resultsToggle = el('archReportResultsToggleWrap');
        var hasResults = !!(model && model.results.length);
        if (pdfBtn) pdfBtn.style.display = hasResults ? '' : 'none';
        if (pdfLangSel) pdfLangSel.style.display = hasResults ? 'flex' : 'none';
        if (resultsToggle) resultsToggle.style.display = hasResults ? 'flex' : 'none';
        if (!hasResults) { setSummary(''); return; }
        var chips = model.results.map(function (r) {
            return '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(41,182,246,0.14);' +
                'border:1px solid rgba(102,200,255,0.45);border-radius:4px;padding:1px 6px;margin:2px 4px 0 0">' +
                '<b style="color:#9ad8ff">' + esc(r.label) + '</b> ' + r.scorePct + '%</span>';
        }).join('');
        setSummary(chips + '<div style="margin-top:5px;opacity:.7">' +
            esc(tr('arch_report_summary_detail', {
                seeds: model.meta.seeds,
                passed: model.meta.candidates,
                bubbles: model.meta.bubblesInArea,
                lidar: model.meta.lidarInArea
            })) + '</div>');
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 13. SCREENSHOTS FOR THE PDF
     * ═══════════════════════════════════════════════════════════════════════
     * Each figure is composited from raster tiles (satellite base, LIDAR
     * hillshade) plus vector overlays drawn on top. The APM figure is special:
     * it draws the high-potential polygons produced from the report's own
     * classified grid (apmGridPolygons) instead of re-fetching the APM tiles —
     * no CORS dependency, visible on satellite, and guaranteed to agree with
     * the score. A source whose pixels cannot be read (bucket without CORS)
     * is skipped rather than drawn, because a single tainted image would make
     * the whole canvas un-exportable; the missing source is reported in the
     * caption. */

    var SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

    function makeProjector(centerLat, centerLng, spanM, sizePx, z) {
        var world = 256 * Math.pow(2, z);
        function wx(lng) { return (lng + 180) / 360 * world; }
        function wy(lat) {
            var rad = lat * Math.PI / 180;
            return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * world;
        }
        var originX = wx(centerLng) - sizePx / 2;
        var originY = wy(centerLat) - sizePx / 2;
        return {
            z: z, world: world, originX: originX, originY: originY, sizePx: sizePx,
            spanM: spanM,
            pxPerMeter: sizePx / spanM,
            latLngToPx: function (lat, lng) { return { x: wx(lng) - originX, y: wy(lat) - originY }; }
        };
    }

    function tileIsReadable(img) {
        try {
            var c = document.createElement('canvas');
            c.width = 2; c.height = 2;
            c.getContext('2d').drawImage(img, 0, 0, 2, 2);
            c.getContext('2d').getImageData(0, 0, 1, 1);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Loads every tile of one source over the figure area. Resolves with
    // { readable, tiles: [{img, px, py}] }.
    function loadSourceTiles(source, proj, lat0) {
        var spanDegLng = proj.spanM / (111320 * Math.cos(lat0 * Math.PI / 180));
        var spanDegLat = proj.spanM / 111320;
        // maxNativeZoom implicit 18: peste 18 Esri World Imagery răspunde 200 cu
        // tile-placeholder "Map data not yet available" în zonele fără acoperire
        // (vezi js/map-app.js, SATELLITE_LAST_NATIVE_Z) — figurile nu trebuie să
        // prindă astfel de tile-uri.
        var z = Math.max(source.minZoom || 0,
            Math.min(source.maxNativeZoom || 18, proj.z + (source.zOffset || 0)));
        var tiles = tileRangeFor(
            proj.centerLat - spanDegLat / 2, proj.centerLat + spanDegLat / 2,
            proj.centerLng - spanDegLng / 2, proj.centerLng + spanDegLng / 2, z
        );
        // Hard cap: a runaway range would stall the report on a slow network.
        if (tiles.length > 64) tiles = tiles.slice(0, 64);
        var out = { readable: false, tiles: [], loaded: 0 };
        return Promise.all(tiles.map(function (t) {
            var url = source.url.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y);
            return loadImage(url, true).then(function (img) {
                if (!img) return;
                out.loaded++;
                if (!out.readable && !tileIsReadable(img)) { out.tainted = true; return; }
                out.readable = true;
                out.tiles.push({
                    img: img,
                    px: t.x * 256 - proj.originX,
                    py: t.y * 256 - proj.originY
                });
            });
        })).then(function () { return out; });
    }

    function captureFigure(opts) {
        var sizePx = CONFIG.SCREENSHOT.SIZE_PX;
        var z = zoomForSpan(opts.spanM, opts.centerLat, sizePx);
        var proj = makeProjector(opts.centerLat, opts.centerLng, opts.spanM, sizePx, z);
        proj.centerLat = opts.centerLat;
        proj.centerLng = opts.centerLng;

        var canvas = document.createElement('canvas');
        canvas.width = sizePx; canvas.height = sizePx;
        var g = canvas.getContext('2d', { willReadFrequently: true });

        return Promise.all((opts.sources || []).map(function (s) {
            return loadSourceTiles(s, proj, opts.centerLat);
        })).then(function (loaded) {
            // background (never transparent — JPEG has no alpha)
            g.fillStyle = opts.background || '#e9e5dc';
            g.fillRect(0, 0, sizePx, sizePx);

            var used = [], missing = [];
            (opts.sources || []).forEach(function (s, i) {
                var res = loaded[i];
                if (!res.readable || !res.tiles.length) { missing.push(s.label || s.key || ('source ' + (i + 1))); return; }
                used.push(s.label || s.key || ('source ' + (i + 1)));
                g.globalAlpha = (s.opacity === undefined ? 1 : s.opacity);
                res.tiles.forEach(function (t) {
                    g.drawImage(t.img, t.px, t.py, 256, 256);
                });
                g.globalAlpha = 1;
            });

            if (opts.draw) opts.draw(g, proj);
            drawFigureChrome(g, sizePx, opts.title, opts.badge, proj);

            try {
                g.getImageData(0, 0, 1, 1);   // throws when tainted
            } catch (e) {
                console.warn('[ArcheoReport] figure canvas is tainted — skipping', e);
                return null;
            }
            return {
                dataUrl: canvas.toDataURL('image/jpeg', CONFIG.SCREENSHOT.JPEG_QUALITY),
                pxWidth: sizePx, pxHeight: sizePx,
                used: used, missing: missing,
                title: opts.title
            };
        }).catch(function (err) {
            console.warn('[ArcheoReport] figure failed:', err);
            return null;
        });
    }

    function drawFigureChrome(g, size, title, badge, proj) {
        // title strip
        g.fillStyle = 'rgba(20,16,24,0.78)';
        g.fillRect(0, 0, size, 34);
        g.fillStyle = '#9ad8ff';
        g.font = "600 15px 'Outfit', 'Segoe UI', Arial, sans-serif";
        g.textBaseline = 'middle';
        g.textAlign = 'left';
        g.fillText(title || '', 12, 18);
        if (badge) {
            g.fillStyle = 'rgba(255,255,255,0.72)';
            g.font = "500 11px 'Outfit', 'Segoe UI', Arial, sans-serif";
            g.textAlign = 'right';
            g.fillText(badge, size - 12, 18);
            g.textAlign = 'left';
        }

        // scale bar (bottom-left)
        var targetM = niceScaleMeters(proj.spanM / proj.pxPerMeter * 0.28);
        var px = targetM * proj.pxPerMeter;
        var x0 = 16, y0 = size - 22;
        g.strokeStyle = 'rgba(20,16,24,0.85)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x0, y0); g.lineTo(x0 + px, y0);
        g.moveTo(x0, y0 - 5); g.lineTo(x0, y0 + 5);
        g.moveTo(x0 + px, y0 - 5); g.lineTo(x0 + px, y0 + 5);
        g.stroke();
        g.fillStyle = 'rgba(20,16,24,0.9)';
        g.font = "600 11px 'Outfit', 'Segoe UI', Arial, sans-serif";
        g.fillText(targetM >= 1000 ? (targetM / 1000) + ' km' : targetM + ' m', x0 + px + 8, y0);

        // north arrow (top-right, below the title strip)
        var nx = size - 26, ny = 58;
        g.fillStyle = 'rgba(20,16,24,0.85)';
        g.beginPath();
        g.moveTo(nx, ny - 12); g.lineTo(nx + 6, ny + 8); g.lineTo(nx, ny + 3); g.lineTo(nx - 6, ny + 8);
        g.closePath(); g.fill();
        g.font = "700 10px 'Outfit', 'Segoe UI', Arial, sans-serif";
        g.textAlign = 'center';
        g.fillText('N', nx, ny + 20);
        g.textAlign = 'left';
    }

    function niceScaleMeters(m) {
        var steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
        for (var i = 0; i < steps.length; i++) if (steps[i] >= m) return steps[i];
        return 10000;
    }

    /* ── shared vector overlays ─────────────────────────────────────────── */

    function drawAnalysisSquare(g, proj, model) {
        var c = model.meta.center;
        var rM = model.meta.radiusM || ((model.meta.sideM || 0) / 2);
        var pt = proj.latLngToPx(c.lat, c.lng);
        var rPx = Math.max(4, rM * proj.pxPerMeter);
        g.save();
        g.setLineDash([7, 5]);
        g.strokeStyle = '#66c8ff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        g.restore();
    }

    function drawResultPolygons(g, proj, model, highlightIndex, trx) {
        var t = trx || tr;
        var rM = CONFIG.RESULT_RADIUS_M;
        model.results.forEach(function (res, idx) {
            var pt = proj.latLngToPx(res.lat, res.lng);
            var rPx = Math.max(4, rM * proj.pxPerMeter);
            g.save();
            g.beginPath();
            g.arc(pt.x, pt.y, rPx, 0, Math.PI * 2);
            g.fillStyle = (highlightIndex === undefined || highlightIndex === idx + 1)
                ? 'rgba(41,182,246,0.28)' : 'rgba(41,182,246,0.12)';
            g.fill();
            g.strokeStyle = '#66c8ff';
            g.lineWidth = (highlightIndex === idx + 1) ? 3 : 2;
            g.setLineDash([4, 4]);
            g.stroke();
            g.setLineDash([]);

            var text = t('arch_report_result') + ' ' + (idx + 1);
            g.font = "700 12px 'Outfit', 'Segoe UI', Arial, sans-serif";
            var w = g.measureText(text).width + 14;
            g.fillStyle = 'rgba(41,182,246,0.95)';
            roundRect(g, pt.x - w / 2, pt.y - 26, w, 19, 4);
            g.fill();
            g.fillStyle = '#041018';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(text, pt.x, pt.y - 16);
            g.textAlign = 'left';
            g.restore();
        });
    }

    function roundRect(g, x, y, w, h, r) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y);
        g.quadraticCurveTo(x + w, y, x + w, y + r);
        g.lineTo(x + w, y + h - r);
        g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        g.lineTo(x + r, y + h);
        g.quadraticCurveTo(x, y + h, x, y + h - r);
        g.lineTo(x, y + r);
        g.quadraticCurveTo(x, y, x + r, y);
        g.closePath();
    }

    function drawLidarPoints(g, proj, ctx) {
        ctx.lidarPoints.forEach(function (p) {
            var pt = proj.latLngToPx(p.lat, p.lng);
            g.beginPath();
            g.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
            g.fillStyle = 'rgba(57,255,20,0.35)';
            g.fill();
            g.strokeStyle = '#39ff14';
            g.lineWidth = 1.8;
            g.stroke();
        });
    }

    function drawBubbles(g, proj, model) {
        model.potentialBubbles.forEach(function (b) {
            var pt = proj.latLngToPx(b.lat, b.lng);
            var rPx = (b.radiusM || 300) * proj.pxPerMeter;
            g.beginPath();
            g.arc(pt.x, pt.y, Math.max(6, rPx), 0, Math.PI * 2);
            g.fillStyle = 'rgba(123,63,212,0.28)';
            g.fill();
            g.strokeStyle = '#a070e8';
            g.lineWidth = 2;
            g.setLineDash([4, 4]);
            g.stroke();
            g.setLineDash([]);
        });
    }

    function drawSites(g, proj, ctx) {
        ctx.siteRecords.forEach(function (rec) {
            var pt = proj.latLngToPx(rec.lat, rec.lng);
            g.beginPath();
            g.arc(pt.x, pt.y, rec.isPolygon ? 4.5 : 3.5, 0, Math.PI * 2);
            g.fillStyle = rec.isPolygon ? '#E60000' : '#c4a0f0';
            g.fill();
            g.strokeStyle = 'rgba(20,16,24,0.6)';
            g.lineWidth = 0.8;
            g.stroke();
        });
    }

    function lidarImageSources() {
        var out = [];
        var group = window._lidarGroup;
        if (group && typeof group.getLayers === 'function') {
            group.getLayers().forEach(function (layer) {
                if (!layer || !layer._url) return;
                var op = (layer.options && typeof layer.options.opacity === 'number') ? layer.options.opacity : 1;
                if (op <= 0) return;
                out.push({
                    key: 'lidar-' + out.length,
                    label: 'LIDAR',
                    url: layer._url,
                    opacity: Math.max(0.55, op),
                    maxNativeZoom: (layer.options && layer.options.maxNativeZoom) || 18,
                    minZoom: (layer.options && layer.options.minZoom) || 0
                });
            });
        }
        return out;
    }

    /**
     * The explanatory figures required by the spec:
     *   1. APM 2.0 high-potential polygons over the satellite   (always)
     *   2. LIDAR view of the area                               (if LIDAR objects)
     *   3. Potential zones vs. other known sites                (if ≥1 bubble)
     * `langCode` binds the figure titles/badges/labels to a language — the
     * user-chosen PDF language, not necessarily the site language.
     */
    function captureFigures(model, ctx, langCode) {
        var trx = makeTr(langCode || lang());
        var c = model.meta.center;
        var radiusM = model.meta.radiusM || Math.sqrt((model.meta.areaKm2 || 0) * 1e6 / Math.PI);
        var spanM = radiusM * 2 + CONFIG.SCREENSHOT.MARGIN_M * 2;
        var out = { apm: null, lidar: null, potential: null };
        var tasks = [];

        // The APM figure is polygonized from the report's own classified grid
        // (the same data the score came from) — see apmGridPolygons().
        var apmPolys = (ctx && ctx.apmGrid) ? apmGridPolygons(ctx.apmGrid) : [];
        tasks.push(captureFigure({
            centerLat: c.lat, centerLng: c.lng, spanM: spanM,
            sources: [{ key: 'sat', label: trx('arch_report_fig_satellite'), url: SATELLITE_URL, opacity: 1, maxNativeZoom: 18 }],
            title: trx('arch_report_fig_apm_title'),
            badge: 'APM 2.0',
            draw: function (g, proj) {
                if (apmPolys.length) drawApmFigurePolygons(g, proj, apmPolys, ctx.apmGrid, c.lat);
                drawAnalysisSquare(g, proj, model);
                drawResultPolygons(g, proj, model, undefined, trx);
            }
        }).then(function (fig) {
            if (fig) {
                fig.apmPolygonCount = apmPolys.length;
                fig.used = fig.used || [];
                fig.missing = fig.missing || [];
                if (apmPolys.length) fig.used.push(trx('arch_report_fig_apm_grid'));
                else if (ctx.apmGrid) fig.missing.push(trx('arch_report_fig_apm_grid'));
            }
            out.apm = fig;
        }));

        if (!model.meta.ignoreLidar && (model.meta.lidarInArea > 0 || model.meta.lidarCount > 0)) {
            var lidarSources = [{ key: 'sat', label: trx('arch_report_fig_satellite'), url: SATELLITE_URL, opacity: 1, maxNativeZoom: 18 }]
                .concat(lidarImageSources());
            tasks.push(captureFigure({
                centerLat: c.lat, centerLng: c.lng, spanM: spanM,
                sources: lidarSources,
                title: trx('arch_report_fig_lidar_title'),
                badge: 'LIDAR',
                draw: function (g, proj) {
                    drawLidarPoints(g, proj, ctx);
                    drawAnalysisSquare(g, proj, model);
                    drawResultPolygons(g, proj, model, undefined, trx);
                }
            }).then(function (fig) { out.lidar = fig; }));
        }

        if (model.meta.bubblesInArea > 0) {
            tasks.push(captureFigure({
                centerLat: c.lat, centerLng: c.lng, spanM: spanM,
                sources: [{ key: 'sat', label: trx('arch_report_fig_satellite'), url: SATELLITE_URL, opacity: 1, maxNativeZoom: 18 }],
                title: trx('arch_report_fig_potential_title'),
                badge: trx('arch_report_fig_potential_badge'),
                draw: function (g, proj) {
                    drawSites(g, proj, ctx);
                    drawBubbles(g, proj, model);
                    drawAnalysisSquare(g, proj, model);
                    drawResultPolygons(g, proj, model, undefined, trx);
                }
            }).then(function (fig) { out.potential = fig; }));
        }

        var timeout = new Promise(function (resolve) {
            setTimeout(function () { resolve('timeout'); }, CONFIG.SCREENSHOT.TIMEOUT_MS);
        });
        return Promise.race([Promise.all(tasks).then(function () { return out; }), timeout])
            .then(function (res) { return res === 'timeout' ? out : res; });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 14. PDF GENERATION
     * ═══════════════════════════════════════════════════════════════════════ */

    var _pdfBusy = false;

    function setPdfBusy(busy, key) {
        var btn = el('archReportPdfBtn');
        _pdfBusy = busy;
        if (!btn) return;
        btn.disabled = busy;
        btn.innerHTML = busy
            ? '<span class="arch-report-spinner" aria-hidden="true"></span><span>' + esc(tr(key || 'arch_report_pdf_building')) + '</span>'
            : '<span class="t" data-key="arch_report_pdf_btn">Download PDF</span>';
    }

    // The model's visible strings (result labels, classifications) were built
    // with the site-language translator at run time. Re-derive them in the
    // chosen PDF language so an EN PDF never leaks RO labels and vice versa.
    function localizeModel(model, trx) {
        var copy = {};
        Object.keys(model).forEach(function (k) { copy[k] = model[k]; });
        copy.results = model.results.map(function (r) {
            var c = {};
            Object.keys(r).forEach(function (k) { c[k] = r[k]; });
            c.label = trx('arch_report_result') + ' ' + r.index + '/' + r.total;
            c.classificationLabel = trx('arch_report_class_' + r.classification);
            return c;
        });
        return copy;
    }

    function generatePdf() {
        var model = _state.model;
        if (!model || !model.results.length) { setStatus('arch_report_need_results', true); return Promise.resolve(null); }
        if (_pdfBusy) return Promise.resolve(null);
        if (typeof window.DetectLabReportPdf === 'undefined') {
            console.error('[ArcheoReport] js/archeo-report-pdf.js is not loaded');
            setStatus('arch_report_error', true);
            return Promise.resolve(null);
        }
        setPdfBusy(true, 'arch_report_pdf_capturing');

        // The whole document — pages AND figures — uses the user's chosen
        // PDF language, which defaults to the site language.
        var pdfLang = pdfLanguage();
        var trx = makeTr(pdfLang);

        return captureFigures(model, _state.ctx || {}, pdfLang).then(function (figures) {
            _state.figures = figures;
            setPdfBusy(true, 'arch_report_pdf_building');
            // Wait for the webfonts (Cinzel/Outfit) before painting, otherwise
            // the canvas falls back to a generic face on the very first run.
            var fontsReady = (document.fonts && document.fonts.ready)
                ? document.fonts.ready.catch(function () { return null; })
                : Promise.resolve(null);
            return fontsReady.then(function () {
                return window.DetectLabReportPdf.build(localizeModel(model, trx), figures,
                    { tr: trx, fmtM: fmtM, lang: pdfLang });
            });
        }).then(function (pdf) {
            if (!pdf) return null;
            var d = model.meta.generatedAt;
            function p2(n) { return (n < 10 ? '0' : '') + n; }
            var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
            var name = (pdfLang === 'ro' ? 'detectlab-raport-arheologic-' : 'detectlab-archaeological-report-') + stamp + '.pdf';
            pdf.save(name);
            setStatus('arch_report_pdf_done', false, { name: name, pages: pdf.pageCount });
            console.log('[ArcheoReport] PDF ready:', name, '| pages:', pdf.pageCount, '| figures:',
                _state.figures && Object.keys(_state.figures).filter(function (k) { return _state.figures[k]; }));
            return pdf;
        }).catch(function (err) {
            console.error('[ArcheoReport] PDF failed:', err);
            setStatus('arch_report_error', true);
            return null;
        }).then(function (res) {
            setPdfBusy(false);
            return res;
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 15. UI WIRING — enable the layer, pick a point, run, download
     * ═══════════════════════════════════════════════════════════════════════ */

    var _pointMarker = null;
    var _searchCircle = null;
    var _circleRenderer = null;

    var CIRCLE_STYLE_IDLE = {
        color: '#66c8ff', weight: 1.8, dashArray: '5 6',
        fill: true, fillColor: '#29b6f6', fillOpacity: 0.05, opacity: 0.85
    };
    var CIRCLE_STYLE_DRAG = {
        color: '#66c8ff', weight: 2, dashArray: null,
        fill: false, fillColor: '#29b6f6', fillOpacity: 0, opacity: 0.95
    };

    var raf = (typeof window !== 'undefined' && window.requestAnimationFrame &&
        window.requestAnimationFrame.bind(window)) || function (fn) { return setTimeout(fn, 16); };

    function circleRendererOption() {
        var map = window._dlMap;
        if (!_circleRenderer && map && typeof L !== 'undefined' && L.canvas) {
            _circleRenderer = L.canvas(assignPane({ padding: 0.3 }, CONFIG.RENDER.PANE_SHAPES));
            _circleRenderer._dl3dSkip = true;
        }
        return _circleRenderer;
    }

    function drawSearchCircle(latlng) {
        var map = window._dlMap;
        if (!map || typeof L === 'undefined' || !L.circle) return;
        var radius = currentRadiusM();
        if (_searchCircle && _searchCircle.setLatLng && _searchCircle.setRadius) {
            _searchCircle.setLatLng(latlng);
            _searchCircle.setRadius(radius);
            if (_searchCircle.setStyle) _searchCircle.setStyle(CIRCLE_STYLE_IDLE);
            syncSearchCircle3dSkip();
            sync3dIfOpen();
            return;
        }
        if (_searchCircle && map.removeLayer) map.removeLayer(_searchCircle);
        var circleOptions = {
            radius: radius,
            color: CIRCLE_STYLE_IDLE.color,
            weight: CIRCLE_STYLE_IDLE.weight,
            dashArray: CIRCLE_STYLE_IDLE.dashArray,
            fill: CIRCLE_STYLE_IDLE.fill,
            fillColor: CIRCLE_STYLE_IDLE.fillColor,
            fillOpacity: CIRCLE_STYLE_IDLE.fillOpacity,
            opacity: CIRCLE_STYLE_IDLE.opacity,
            interactive: false
        };
        assignPane(circleOptions, CONFIG.RENDER.PANE_SHAPES);
        var renderer = circleRendererOption();
        if (renderer) circleOptions.renderer = renderer;
        _searchCircle = L.circle(latlng, circleOptions);
        own3dFeatures(_searchCircle, 'Archeological Report', searchAreaFeatures3d);
        syncSearchCircle3dSkip();
        if (_searchCircle.addTo) _searchCircle.addTo(map);
        else if (map.addLayer) map.addLayer(_searchCircle);
        sync3dIfOpen();
    }

    function clearSearchCircle() {
        var map = window._dlMap;
        if (map && _searchCircle) map.removeLayer(_searchCircle);
        _searchCircle = null;
    }

    function drawPointMarker(latlng) {
        var map = window._dlMap;
        if (!map) return;
        if (_pointMarker) map.removeLayer(_pointMarker);
        var icon = L.divIcon({
            className: 'arch-report-pin-wrapper',
            html: '<div class="arch-report-pin" title="' + esc(tr('arch_report_point_title')) + '">' +
                  '<div class="arch-report-pin-pulse"></div><div class="arch-report-pin-dot"></div></div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });
        _pointMarker = L.marker(latlng, assignPane({ icon: icon, zIndexOffset: 2100, interactive: false }, CONFIG.RENDER.PANE_TAGS));
        _pointMarker._dl3dSkip = true;
        _pointMarker.addTo(map);
        _pointMarker.bindTooltip(
            '<span class="arch-report-tag"><b>' + esc(tr('arch_report_point_title')) + '</b><br>' +
            latlng.lat.toFixed(4) + ', ' + latlng.lng.toFixed(4) + '</span>',
            assignPane({ direction: 'top', offset: [0, -14], className: 'arch-report-tooltip' }, CONFIG.RENDER.PANE_TAGS)
        );
        drawSearchCircle(latlng);
    }

    function onMapClick(e) {
        if (!_state.active || _state.running) return;
        // taps belong to the offline polygon while that is being drawn
        try { if (window._dlOfflineDrawActive) return; } catch (err) {}
        _state.point = { lat: e.latlng.lat, lng: e.latlng.lng };
        try { window._dlSearchAreaPin = { lat: e.latlng.lat, lng: e.latlng.lng }; } catch (err) {}
        drawPointMarker(e.latlng);
        setStatus('arch_report_point_set', false, {
            lat: _state.point.lat.toFixed(5), lng: _state.point.lng.toFixed(5)
        });
        updateRunButton();
    }

    /* Oglinda verticală a sliderului de rază + dock-ul de acțiune centrat jos
       sunt gestionate de vertical-opacity-control.js; aici le anunțăm când
       stratul pornește/se oprește PROGRAMATIC (din catalog, din gating-ul de
       abonament etc.), caz în care „change” pe comutator nu se declanșează. */
    function notifyDistanceMirror(on) {
        try {
            var api = window.DetectLabVerticalOpacity;
            if (!api) return;
            if (on) { if (!api.isActiveFor('archReportDistance')) api.select('archReportDistance'); }
            /* La oprire se închide DOAR oglinda acestui strat (closeFor):
               api.close() le închide pe TOATE, deci un slider de raport adăugat
               al doilea pe ecran și apoi închis stinge și sliderul stratului
               alăturat + stratul său. Fallback-ul păstrează vechiul
               comportament dacă controalele verticale vin dintr-un shell mai
               vechi, fără closeFor. */
            else if (typeof api.closeFor === 'function') api.closeFor('archReportDistance');
            else if (api.isActiveFor('archReportDistance')) api.close();
        } catch (e) {}
    }

    function setActive(on) {
        _state.active = !!on;
        var map = window._dlMap;
        var row = el('archReportRow');
        if (row) row.classList.toggle('is-on', _state.active);
        if (!map) return;
        if (!_state.active) {
            map.off('click', onMapClick);
            if (_pointMarker) { map.removeLayer(_pointMarker); _pointMarker = null; }
            clearSearchCircle();
            clearResults();
            _state.point = null;
            _state.figures = null;
            setSummary('');
            setStatus('arch_report_hint');
            updateUi();
            updateRunButton();
            notifyDistanceMirror(false);
            return;
        }
        ensurePanes(map);
        map.on('click', onMapClick);
        setStatus(_state.point ? 'arch_report_point_set' : 'arch_report_hint');
        updateUi();
        updateRunButton();
        notifyDistanceMirror(true);
    }

    function wireUI() {
        var toggle = el('archReportToggle');
        if (toggle && !toggle.dataset.archReportWired) {
            toggle.dataset.archReportWired = '1';
            toggle.addEventListener('change', function () { setActive(this.checked); });
        }
        var run = el('archReportRunBtn');
        if (run && !run.dataset.archReportWired) {
            run.dataset.archReportWired = '1';
            run.addEventListener('click', function () { runReport(); });
        }
        var pdf = el('archReportPdfBtn');
        if (pdf && !pdf.dataset.archReportWired) {
            pdf.dataset.archReportWired = '1';
            pdf.addEventListener('click', function () { generatePdf(); });
        }
        var langRo = el('archReportPdfLangRo');
        if (langRo && !langRo.dataset.archReportWired) {
            langRo.dataset.archReportWired = '1';
            langRo.addEventListener('click', function () { setPdfLanguage('ro'); });
        }
        var langEn = el('archReportPdfLangEn');
        if (langEn && !langEn.dataset.archReportWired) {
            langEn.dataset.archReportWired = '1';
            langEn.addEventListener('click', function () { setPdfLanguage('en'); });
        }
        var show = el('archReportResultsToggle');
        if (show && !show.dataset.archReportWired) {
            show.dataset.archReportWired = '1';
            show.addEventListener('change', function () { toggleResults(this.checked); });
        }
        var ignore = el('archReportIgnoreLidar');
        if (ignore && !ignore.dataset.archReportWired) {
            ignore.dataset.archReportWired = '1';
            ignore.addEventListener('change', function () {
                if (_state.point && !_state.running) runReport();
            });
        }
        var slider = el('archReportDistance');
        var valueLabel = el('archReportDistanceValue');
        if (slider && !slider.dataset.archReportWired) {
            slider.dataset.archReportWired = '1';
            wireDistanceSlider(slider, valueLabel);
        }
        if (valueLabel && slider) valueLabel.textContent = currentRadiusKm() + ' km';
        syncPdfLangUi();
        updateUi();
        updateRunButton();
    }

    function setDragClass(on) {
        var body = (typeof document !== 'undefined') && document.body;
        if (body && body.classList) body.classList.toggle('arch-distance-dragging', !!on);
    }

    function wireDistanceSlider(slider, valueLabel) {
        var pendingValue = null;
        var frameHandle = null;
        var frameScheduled = false;
        var dragging = false;
        var releaseTimer = null;

        function paint() {
            frameScheduled = false;
            frameHandle = null;
            var value = pendingValue;
            pendingValue = null;
            if (value == null) return;
            if (valueLabel) valueLabel.textContent = value + ' km';
            if (_state.point && _searchCircle && _searchCircle.setRadius) {
                _searchCircle.setRadius(value * 1000);
            }
        }

        function schedule() {
            if (frameScheduled) return;
            frameScheduled = true;
            frameHandle = raf(paint);
        }

        function beginDrag() {
            if (dragging) return;
            dragging = true;
            setDragClass(true);
            if (_searchCircle && _searchCircle.setStyle) _searchCircle.setStyle(CIRCLE_STYLE_DRAG);
        }

        function cancelFrame() {
            if (!frameScheduled) return;
            if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(frameHandle);
            else clearTimeout(frameHandle);
            frameScheduled = false;
            frameHandle = null;
        }

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            if (pendingValue !== null) {
                cancelFrame();
                paint();
            }
            if (_searchCircle && _searchCircle.setStyle) _searchCircle.setStyle(CIRCLE_STYLE_IDLE);
            setDragClass(false);
        }

        slider.addEventListener('input', function () {
            pendingValue = +this.value;
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

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireUI);
        else wireUI();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 16. PUBLIC API
     * ═══════════════════════════════════════════════════════════════════════ */
    window.showArcheoReportInfo = function () {
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(tr('layer_arch_report'), '© DetectLab 2026 · APM 2.0 + RAN CIMEC + LIDAR', tr('arch_report_hint_bottom'));
        }
    };
    window.toggleArcheoReportLayer = setActive;
    window.runArcheoReport = runReport;
    window.generateArcheoReportPdf = generatePdf;
    window._archeoReportPdfLang = pdfLanguage;
    window._archeoReportSetPdfLang = setPdfLanguage;
    window._archeoReportState = function () {
        return {
            active: _state.active,
            point: _state.point,
            running: _state.running,
            results: _state.results,
            model: _state.model,
            figures: _state.figures,
            pdfLang: pdfLanguage()
        };
    };
    // Console helpers:  _archeoReportSetPoint(46.77, 23.59) then runArcheoReport()
    window._archeoReportSetPoint = function (lat, lng) {
        _state.point = { lat: lat, lng: lng };
        drawPointMarker(L.latLng(lat, lng));
        return _state.point;
    };
    window._archeoReportDebug = {
        config: CONFIG,
        tr: tr,
        makeTr: makeTr,
        lang: lang,
        pdfLanguage: pdfLanguage,
        setPdfLanguage: setPdfLanguage,
        areaSquare: areaSquare,
        analysisArea: analysisArea,
        inCircle: inCircle,
        inSquare: inSquare,
        currentRadiusKm: currentRadiusKm,
        currentRadiusM: currentRadiusM,
        seedGridM: seedGridM,
        uatCellM: uatCellM,
        apmCellM: apmCellM,
        buildSeeds: buildSeeds,
        passesSiteFilters: passesSiteFilters,
        nearestBubble: nearestBubble,
        nearestLidar: nearestLidar,
        nearestRomanRoadM: nearestRomanRoadM,
        distPointToSegment: distPointToSegment,
        romanRoadSegmentsInSquare: romanRoadSegmentsInSquare,
        mapRomanRoadsLayer: mapRomanRoadsLayer,
        evaluateSeed: evaluateSeed,
        classifyScore: classifyScore,
        selectResults: selectResults,
        periodKey: periodKey,
        parseCenturyRange: parseCenturyRange,
        periodKeyFromCenturies: periodKeyFromCenturies,
        periodKeyFromMillennium: periodKeyFromMillennium,
        romanToInt: romanToInt,
        estimatePeriod: estimatePeriod,
        buildResultModel: buildResultModel,
        buildSiteRecords: buildSiteRecords,
        siteInfo: siteInfo,
        distanceToSite: distanceToSite,
        classifyApmPixel: classifyApmPixel,
        isRedUatPixel: isRedUatPixel,
        uatVerdict: uatVerdict,
        buildUatGrid: buildUatGrid,
        buildApmGrid: buildApmGrid,
        apmClassAt: apmClassAt,
        apmGridPolygons: apmGridPolygons,
        outlineCells: outlineCells,
        drawApmFigurePolygons: drawApmFigurePolygons,
        pointInPolygon: pointInPolygon,
        projectToLocalMeters: projectToLocalMeters,
        localMetersToLatLng: localMetersToLatLng,
        zoomForSpan: zoomForSpan,
        resultPolygon: resultPolygon,
        polygonLatLngToLocal: polygonLatLngToLocal,
        resultPopupHtml: resultPopupHtml,
        groundRing3d: groundRing3d,
        reportResultsFeatures3d: reportResultsFeatures3d,
        searchAreaFeatures3d: searchAreaFeatures3d,
        renderResults: renderResults,
        captureFigure: captureFigure,
        captureFigures: captureFigures,
        makeProjector: makeProjector,
        runReport: runReport,
        generatePdf: generatePdf,
        setActive: setActive
    };
})();
