/* DetectLab — premium LIDAR Scanner
 * Reads data/lidar_scanner_points.csv as WGS 84 / EPSG:4326 latitude and
 * longitude. English and Romanian CSV headers are normalized while loading;
 * legacy EPSG:4936 ECEF X/Y/Z files remain supported by lidar-geo.js.
 */
(function () {
    'use strict';
    var DATA_URL = 'data/lidar_scanner_points.csv?v=20261002-remove-five-points';
    var HERITAGE_RADIUS_M = 600;

    /* Coordonate retrase explicit din catalogul LIDAR Scanner. Filtrul rămâne
       lângă pipeline-ul de încărcare chiar dacă rândurile nu mai există în CSV:
       astfel nici o copie veche/cache-uită sau o regenerare ulterioară a
       fișierului nu le poate readuce pe hartă. Toleranța acoperă precizia de
       cinci zecimale cu care au fost raportate punctele (~1 m). */
    var REMOVED_SCANNER_POINTS = [
        [46.09811, 23.55539],
        [46.09201, 23.54846],
        [46.09234, 23.54366],
        [46.12036, 23.52000],
        [46.01570, 23.49656]
    ];
    var REMOVED_POINT_TOLERANCE_DEG = 0.00001;

    function isRemovedScannerPoint(record) {
        if (!record || !isFinite(record.lat) || !isFinite(record.lon)) return false;
        for (var i = 0; i < REMOVED_SCANNER_POINTS.length; i++) {
            var removed = REMOVED_SCANNER_POINTS[i];
            if (Math.abs(record.lat - removed[0]) <= REMOVED_POINT_TOLERANCE_DEG &&
                Math.abs(record.lon - removed[1]) <= REMOVED_POINT_TOLERANCE_DEG) {
                return true;
            }
        }
        return false;
    }
    var map = null, resultsLayer = null, selectedMarker = null, selectionCircle = null;
    var points = [], selected = null, active = false, scanning = false, pointsPromise = null;
    /* The points of the last completed scan, in the order they were drawn.
       This is the data the 3D bridge below hands to the mirror: the 2D
       result rings are L.circle objects, whose toGeoJSON() is only the
       centre point, so without the bridge the 3D view drew every result
       as a 100-PIXEL dot (the metre radius read as screen pixels) and the
       search circle as a disc thousands of pixels wide. */
    var resultPoints = [];

    // ── Selection circle styling ──────────────────────────────────────────
    // Two styles, because redrawing the search circle is the single most
    // expensive thing this layer does on a phone. At high zoom a 50 km radius
    // is over a million CSS pixels across, so every repaint has to rasterize a
    // giant dashed arc AND composite a translucent fill over the whole map —
    // and in the installed PWA that fill also sits under the layer panel's
    // backdrop-filter, forcing the blur to be recomputed as well. While the
    // user is dragging the distance slider we therefore draw the circle as a
    // plain outline (no dash pattern, no fill) and only restore the full
    // decoration once the drag ends.
    var CIRCLE_STYLE_IDLE = {
        color: '#8cff66', weight: 1.8, dashArray: '5 6',
        fill: true, fillColor: '#39ff14', fillOpacity: 0.05, opacity: 0.85
    };
    var CIRCLE_STYLE_DRAG = {
        color: '#8cff66', weight: 2, dashArray: null,
        fill: false, fillColor: '#39ff14', fillOpacity: 0, opacity: 0.95
    };

    // ── Scanner panes: everything the scanner draws sits above the LIDAR ──
    // The LIDAR imagery lives on `pane_lidar` (z-index 610, created in
    // map-app.js). Leaflet's stock panes are all *below* that: overlays (where
    // circles are drawn) are 400 and markers are 600, so with a LIDAR sub-layer
    // switched on, the search pin and the scan results were painted underneath
    // the terrain tiles and effectively disappeared — exactly what the operator
    // needs to see while reading a hillshade.
    //
    // Three dedicated panes are used instead, stacked above every LIDAR layer
    // (and above the other historical rasters at 615-651) but still below the
    // measurement pane (700) and the iOS overlay (1000):
    //
    //   655  circles  — search radius + result rings
    //   660  pin      — the search point marker
    //   665  tags     — permanent category labels and the pin's own tooltip
    //
    // Labels sit above the pin so a tag is never clipped by the pulsing dot.
    var PANE_CIRCLES = 'pane_lidar_scanner_shapes';
    var PANE_PIN = 'pane_lidar_search_pin';
    var PANE_TAGS = 'pane_lidar_scanner_tags';

    // pointerEvents is deliberate on the circles pane. Its canvas renderer is a
    // single element the size of the viewport, and Leaflet's stylesheet only
    // neutralises pointer events for `.leaflet-pane > svg path`, never for
    // `.leaflet-pane > canvas`. Sitting at 655 the canvas would therefore
    // intercept every click over the whole map and starve the interactive
    // layers underneath it (pane_patrimoniu 620, pane_uat 402, the markers at
    // 600 …) — the same reason map-app.js sets pointerEvents='none' on its own
    // raster panes. The interactive result rings are unaffected: pointer-events
    // is re-enabled per element, and Leaflet's stylesheet already does that for
    // `.leaflet-pane > svg path.leaflet-interactive`, which is exactly why
    // makeResult keeps the rings on the SVG renderer. The pin and tag panes
    // keep normal pointer handling: they are small DOM elements, not
    // full-viewport surfaces.
    var SCANNER_PANES = [
        [PANE_CIRCLES, 655, 'none'],
        [PANE_PIN, 660, ''],
        [PANE_TAGS, 665, '']
    ];

    function ensureScannerPanes() {
        if (!map || !map.createPane) return false;
        for (var i = 0; i < SCANNER_PANES.length; i++) {
            var name = SCANNER_PANES[i][0];
            if (!map.getPane(name)) map.createPane(name);
            var pane = map.getPane(name);
            if (pane && pane.style) {
                pane.style.zIndex = SCANNER_PANES[i][1];
                pane.style.pointerEvents = SCANNER_PANES[i][2];
            }
        }
        return true;
    }

    // Returns a pane name only when the pane really exists, so a failure to
    // create one degrades to Leaflet's default pane instead of throwing.
    function paneOption(name) {
        return ensureScannerPanes() && map.getPane(name) ? name : undefined;
    }

    function assignPane(options, name) {
        var pane = paneOption(name);
        if (pane) options.pane = pane;
        return options;
    }

    // A canvas renderer for the search circle. Leaflet's default SVG renderer
    // mutates a DOM path on every setRadius() call, which forces style/layout
    // work in the page on each frame of the drag; canvas just repaints pixels.
    // The renderer is pinned to the scanner's own pane so the canvas itself is
    // composited above the LIDAR tiles.
    var circleRenderer = null;
    function circleRendererOption() {
        if (!circleRenderer && typeof L !== 'undefined' && L.canvas) {
            circleRenderer = L.canvas(assignPane({ padding: 0.3 }, PANE_CIRCLES));
        }
        return circleRenderer;
    }

    var raf = (typeof window !== 'undefined' && window.requestAnimationFrame &&
        window.requestAnimationFrame.bind(window)) || function (fn) { return setTimeout(fn, 16); };
    function distance(a, b) {
        var R = 6371000, p = Math.PI / 180, dLat = (b.lat-a.lat)*p, dLng = (b.lng-a.lng)*p;
        var x = Math.sin(dLat/2) ** 2 + Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLng/2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function normalizeHeader(value) {
        var key = String(value == null ? '' : value).replace(/^\uFEFF/, '').trim().toLowerCase();
        if (key.normalize) key = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        var aliases = {
            lat: 'lat', latitude: 'lat', latitudine: 'lat',
            lon: 'lon', lng: 'lon', longitude: 'lon', longitudine: 'lon',
            category: 'category', categorie: 'category', categoria: 'category',
            descriere: 'category', description: 'category',
            name: 'name', nume: 'name', denumire: 'name',
            id: 'id', fid: 'id', x: 'X', y: 'Y', z: 'Z'
        };
        return aliases[key] || String(value == null ? '' : value).trim();
    }
    function csvNumber(value) {
        return parseFloat(String(value == null ? '' : value).trim().replace(',', '.'));
    }
    function parseCsv(text) {
        var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (line) {
            return line.trim();
        });
        if (!lines.length) return [];

        var sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
        function row(line) {
            var out = [], current = '', quoted = false;
            for (var i = 0; i < line.length; i++) {
                var character = line[i];
                if (character === '"') {
                    if (quoted && line[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        quoted = !quoted;
                    }
                } else if (character === sep && !quoted) {
                    out.push(current.trim());
                    current = '';
                } else {
                    current += character;
                }
            }
            out.push(current.trim());
            return out;
        }

        var headers = row(lines[0]).map(normalizeHeader);
        return lines.slice(1).map(function (line, index) {
            var values = row(line);
            var record = {};
            headers.forEach(function (header, column) {
                record[header] = values[column] == null ? '' : values[column];
            });
            record.category = record.category || 'Uncategorized';
            record.name = record.name || '';
            record.id = record.id || String(index + 1);
            ['lat', 'lon', 'X', 'Y', 'Z'].forEach(function (key) {
                if (record[key] !== undefined) record[key] = csvNumber(record[key]);
            });
            return record;
        });
    }
    // ── Heritage exclusion index ──────────────────────────────────────────
    // Scan results are filtered against every known heritage geometry (layers
    // 0/5/6 — tens of thousands of features nationwide). The original code
    // rebuilt that whole flat geometry list *inside* the per-result filter and
    // then walked every ring of every feature, so the cost was
    // results × features × vertices. At a 10 km radius that is slow but
    // survivable; at 50 km the result count grows roughly with the square of
    // the distance, and on a phone the main thread simply stopped responding.
    //
    // Instead the geometries are flattened once, given a bounding box padded
    // by the exclusion radius, and dropped into a coarse lat/lng grid. A
    // result then only tests the handful of geometries in its own cell.
    var GRID_DEG = 0.05; // ~5.5 km cells — comfortably larger than HERITAGE_RADIUS_M
    var heritageIndex = null;

    function cellKey(lat, lng) {
        return Math.floor(lat / GRID_DEG) + ':' + Math.floor(lng / GRID_DEG);
    }

    function eachCoordinate(geometry, visit) {
        var coords = geometry.coordinates;
        if (!coords) return;
        if (geometry.type === 'Point') { visit(coords); return; }
        if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') { coords.forEach(visit); return; }
        if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
            coords.forEach(function (ring) { (ring || []).forEach(visit); });
            return;
        }
        if (geometry.type === 'MultiPolygon') {
            coords.forEach(function (polygon) {
                (polygon || []).forEach(function (ring) { (ring || []).forEach(visit); });
            });
        }
    }

    function heritageEntry(geometry) {
        var minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity, count = 0;
        eachCoordinate(geometry, function (c) {
            if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
            count++;
            if (c[1] < minLat) minLat = c[1];
            if (c[1] > maxLat) maxLat = c[1];
            if (c[0] < minLng) minLng = c[0];
            if (c[0] > maxLng) maxLng = c[0];
        });
        if (!count) return null;

        // Rings, pre-flattened once so the point-in-polygon test never has to
        // rebuild them per candidate result.
        var rings = [];
        if (geometry.type === 'Polygon') rings = geometry.coordinates || [];
        else if (geometry.type === 'MultiPolygon') {
            (geometry.coordinates || []).forEach(function (polygon) {
                rings = rings.concat(polygon || []);
            });
        }
        return {
            type: geometry.type,
            coordinates: geometry.coordinates,
            rings: rings,
            minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng
        };
    }

    function buildHeritageIndex() {
        var data = window._localLayerData || {};
        // Rebuild only when the underlying layer objects change (they are
        // replaced wholesale when map-app.js finishes loading them).
        if (heritageIndex && heritageIndex.refs[0] === data[0] &&
            heritageIndex.refs[5] === data[5] && heritageIndex.refs[6] === data[6]) {
            return heritageIndex;
        }

        var cells = Object.create(null);
        // Pad the bbox by the exclusion radius so a result just outside a
        // geometry still lands in a cell that contains it.
        var padLat = HERITAGE_RADIUS_M / 111320 + 1e-9;

        [0, 5, 6].forEach(function (id) {
            var features = (data[id] && data[id].features) || [];
            for (var i = 0; i < features.length; i++) {
                var geometry = features[i] && features[i].geometry;
                if (!geometry) continue;
                var entry = heritageEntry(geometry);
                if (!entry) continue;

                var padLng = padLat / Math.max(Math.cos(((entry.minLat + entry.maxLat) / 2) * Math.PI / 180), 0.2);
                var latFrom = Math.floor((entry.minLat - padLat) / GRID_DEG);
                var latTo = Math.floor((entry.maxLat + padLat) / GRID_DEG);
                var lngFrom = Math.floor((entry.minLng - padLng) / GRID_DEG);
                var lngTo = Math.floor((entry.maxLng + padLng) / GRID_DEG);

                // Guard against a malformed nationwide geometry carpeting the
                // whole grid; such a feature is kept in a global bucket.
                if ((latTo - latFrom + 1) * (lngTo - lngFrom + 1) > 4096) {
                    (cells['*'] || (cells['*'] = [])).push(entry);
                    continue;
                }
                for (var la = latFrom; la <= latTo; la++) {
                    for (var ln = lngFrom; ln <= lngTo; ln++) {
                        var key = la + ':' + ln;
                        (cells[key] || (cells[key] = [])).push(entry);
                    }
                }
            }
        });

        heritageIndex = { cells: cells, refs: { 0: data[0], 5: data[5], 6: data[6] } };
        return heritageIndex;
    }

    function pointInRing(p, ring) { var inside=false; for(var i=0,j=ring.length-1;i<ring.length;j=i++){var a=ring[i],b=ring[j], yi=a[1],yj=b[1], xi=a[0],xj=b[0]; if(((yi>p.lat)!==(yj>p.lat))&&p.lng<(xj-xi)*(p.lat-yi)/(yj-yi)+xi)inside=!inside;} return inside; }

    function entryExcludes(p, entry) {
        // Cheap bbox reject before any trigonometry.
        var padLat = HERITAGE_RADIUS_M / 111320;
        var padLng = padLat / Math.max(Math.cos(p.lat * Math.PI / 180), 0.2);
        if (p.lat < entry.minLat - padLat || p.lat > entry.maxLat + padLat ||
            p.lng < entry.minLng - padLng || p.lng > entry.maxLng + padLng) {
            return false;
        }
        if (entry.type === 'Point') {
            var c = entry.coordinates;
            return distance(p, { lat: c[1], lng: c[0] }) <= HERITAGE_RADIUS_M;
        }
        if (entry.type === 'MultiPoint') {
            return (entry.coordinates || []).some(function (mc) {
                return distance(p, { lat: mc[1], lng: mc[0] }) <= HERITAGE_RADIUS_M;
            });
        }
        var rings = entry.rings;
        for (var i = 0; i < rings.length; i++) {
            if (pointInRing(p, rings[i])) return true;
        }
        for (var r = 0; r < rings.length; r++) {
            var ring = rings[r] || [];
            for (var v = 0; v < ring.length; v++) {
                if (distance(p, { lat: ring[v][1], lng: ring[v][0] }) <= HERITAGE_RADIUS_M) return true;
            }
        }
        return false;
    }

    function isNearHeritage(p) {
        var index = buildHeritageIndex();
        var candidates = index.cells[cellKey(p.lat, p.lng)];
        if (candidates) {
            for (var i = 0; i < candidates.length; i++) {
                if (entryExcludes(p, candidates[i])) return true;
            }
        }
        var global = index.cells['*'];
        if (global) {
            for (var g = 0; g < global.length; g++) {
                if (entryExcludes(p, global[g])) return true;
            }
        }
        return false;
    }
    // Result label offset, in pixels above the site.
    //
    // This MUST stay small and constant. A tooltip offset is measured in screen
    // pixels, while the result circle is measured in metres, so the two scale
    // differently: the circle doubles on screen with every zoom level, a pixel
    // offset never changes. The old -98 px offset therefore drifted against the
    // site it labels — at z12 it floated ~2.6 km (94 px) above the circle, and
    // past z17 it sank inside it. Anchoring the label a few pixels above the
    // centre keeps it locked onto its site at every zoom level.
    var RESULT_RADIUS_M = 100;
    var RESULT_LABEL_OFFSET = [0, -14];

    /* ── 3D bridge (js/map3d-mirror.js → js/map3d-terrain.js) ──────────────
     * Same pattern as the Archeological Report: the scanner's groups offer
     * their geometry as ground shapes through `_dl3dFeatures()` and their
     * 2D children are marked `_dl3dSkip`, so the mirror carries each result
     * exactly once, as a 100 m ground ring (32-segment polygon, the same
     * construction the other analysis layers use) plus a centre point
     * carrying the label and the popup. The search selection gets the same
     * treatment: a ground polygon for the chosen radius plus the centre
     * point, instead of a pixel disc that covered the whole 3D view. */
    var CIRCLE_SEGMENTS_3D = 32;

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

    function feature3d(geometry, properties) {
        return { type: 'Feature', properties: properties, geometry: geometry };
    }

    function resultPopupHtml(p) {
        // Traseu Google Maps: destinația e ÎNTOTDEAUNA centrul inelului de
        // rezultat (p.lat/p.lng), nu marginea lui — cererea „în cadrul
        // razelor mai mari, traseul va fi către centrul lor”.
        var gmapsBtn = (window.DetectLabDirections && window.DetectLabDirections.buttonHtml)
            ? window.DetectLabDirections.buttonHtml(p.lat, p.lng)
            : '';
        return '<strong>' + esc(p.category) + '</strong>' + (p.name ? '<br>' + esc(p.name) : '') +
            '<br><small>' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</small>' +
            (gmapsBtn ? '<div style="margin-top:4px">' + gmapsBtn + '</div>' : '');
    }

    function syncScanner3d() {
        try {
            var m3d = window.DetectLabMap3D;
            if (m3d && typeof m3d.isOpen === 'function' && m3d.isOpen() && typeof m3d.syncLayers === 'function') {
                m3d.syncLayers();
            }
        } catch (e) { /* ignore */ }
    }

    /* Stamp-cached bridge result, so the 1.5 s mirror poll re-uploads the
       GeoJSON only when the drawn geometry actually changed. */
    function cachedBridge(cache, stamp, build) {
        if (cache.stamp === stamp && cache.value) return cache.value;
        var value = build();
        cache.stamp = stamp;
        cache.value = value;
        return value;
    }

    var _results3dCache = { stamp: '', value: null };
    function scannerResultsFeatures3d() {
        if (!resultPoints.length) return null;
        var stamp = 'lidar-scanner-results|' + resultPoints.map(function (p) {
            return p.lat.toFixed(6) + ',' + p.lng.toFixed(6) + ',' + (p.category || '');
        }).join(';');
        return cachedBridge(_results3dCache, stamp, function () {
            var features = [];
            resultPoints.forEach(function (p) {
                var popup = resultPopupHtml(p);
                features.push(feature3d(
                    { type: 'Polygon', coordinates: [groundRing3d(p.lat, p.lng, RESULT_RADIUS_M)] },
                    {
                        kind: 'lidar-result', color: '#8cff66', fillColor: '#39ff14',
                        fillOpacity: 0.11, opacity: 0.98, weight: 2,
                        lat: p.lat, lng: p.lng, popup: popup
                    }
                ));
                features.push(feature3d(
                    { type: 'Point', coordinates: [p.lng, p.lat] },
                    {
                        kind: 'lidar-result-point', color: '#8cff66', fillColor: '#39ff14',
                        fillOpacity: 0.95, opacity: 1, radius: 5,
                        lat: p.lat, lng: p.lng, label: String(p.category || ''), popup: popup
                    }
                ));
            });
            return {
                geojson: { type: 'FeatureCollection', features: features },
                paints: {
                    line: { 'line-color': '#8cff66', 'line-width': 2, 'line-opacity': 0.98, 'line-dasharray': [1, 2] },
                    fill: { 'fill-color': '#39ff14', 'fill-opacity': 0.11 },
                    circle: {
                        'circle-radius': 5, 'circle-color': '#39ff14',
                        'circle-stroke-color': '#8cff66', 'circle-stroke-width': 1.5,
                        'circle-stroke-opacity': 0.98, 'circle-opacity': 0.95
                    },
                    layout: {}
                },
                stamp: stamp,
                label: 'LiDAR Scanner'
            };
        });
    }

    var _selection3dCache = { stamp: '', value: null };
    function scannerSelectionFeatures3d() {
        if (!selected || !isFinite(selected.lat) || !isFinite(selected.lng)) return null;
        var radiusM = NaN;
        if (selectionCircle && typeof selectionCircle.getRadius === 'function') {
            try { radiusM = Number(selectionCircle.getRadius()); } catch (e) { radiusM = NaN; }
        }
        if (!(radiusM > 0)) {
            var slider = document.getElementById('lidarScannerDistance');
            radiusM = slider ? parseInt(slider.value, 10) * 1000 : NaN;
        }
        if (!(radiusM > 0)) return null;
        var stamp = 'lidar-scanner-selection|' + selected.lat.toFixed(6) + '|' + selected.lng.toFixed(6) + '|' + radiusM;
        return cachedBridge(_selection3dCache, stamp, function () {
            var features = [
                feature3d(
                    { type: 'Polygon', coordinates: [groundRing3d(selected.lat, selected.lng, radiusM)] },
                    {
                        kind: 'radius', color: CIRCLE_STYLE_IDLE.color,
                        fillColor: CIRCLE_STYLE_IDLE.fillColor,
                        fillOpacity: CIRCLE_STYLE_IDLE.fillOpacity,
                        opacity: CIRCLE_STYLE_IDLE.opacity, weight: CIRCLE_STYLE_IDLE.weight
                    }
                ),
                feature3d(
                    { type: 'Point', coordinates: [selected.lng, selected.lat] },
                    {
                        kind: 'lidar-search-point', color: '#ffffff', fillColor: '#39ff14',
                        fillOpacity: 0.95, opacity: 1, radius: 6,
                        label: selected.lat.toFixed(4) + ', ' + selected.lng.toFixed(4)
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
                    fill: { 'fill-color': CIRCLE_STYLE_IDLE.fillColor, 'fill-opacity': CIRCLE_STYLE_IDLE.fillOpacity },
                    circle: {
                        'circle-radius': 6, 'circle-color': '#39ff14',
                        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
                        'circle-stroke-opacity': 1, 'circle-opacity': 0.95
                    },
                    layout: {}
                },
                stamp: stamp,
                label: 'LiDAR Scanner'
            };
        });
    }

    function attachResults3d(group) {
        if (!group || group._dl3dFeatures) return;
        group.options = group.options || {};
        group.options.name = 'LiDAR Scanner';
        group._dl3dFeatures = scannerResultsFeatures3d;
    }

    function makeResult(p) {
        // Result rings stay on Leaflet's SVG renderer on purpose. They are
        // clickable (they carry a popup), and the circles pane is
        // pointer-events:none so its full-viewport canvas cannot steal clicks
        // from the layers below. Leaflet's own stylesheet re-enables hits for
        // `.leaflet-pane > svg path.leaflet-interactive`, so an SVG ring is
        // still clickable inside that pane while a canvas-drawn one would not
        // be — canvas has no such rule and cannot opt back in per shape.
        // A scan returns at most a few dozen rings, so the DOM cost is small;
        // the perf-critical shape is the search circle resized on every frame
        // of the distance drag, and that one keeps the canvas renderer.
        var resultOptions = assignPane({radius:RESULT_RADIUS_M,color:'#8cff66',weight:2,dashArray:'3 6',fillColor:'#39ff14',fillOpacity:.11,opacity:.98,interactive:true}, PANE_CIRCLES);
        var circle=L.circle([p.lat,p.lng],resultOptions);
        /* The ring reaches 3D only through the results group's ground
           bridge (scannerResultsFeatures3d): mirrored on its own, an
           L.circle is just its centre point with the metre radius read as
           pixels, and Leaflet also lists group children individually, so
           the ring would be carried twice. */
        circle._dl3dSkip = true;
        circle.bindTooltip('<span class="lidar-result-tag"><b>Category / Categoria</b><br>'+esc(p.category)+'</span>',assignPane({permanent:true,direction:'top',offset:RESULT_LABEL_OFFSET,className:'lidar-result-tooltip'}, PANE_TAGS));
        circle.bindPopup(resultPopupHtml(p)); return circle;
    }
    function setStatus(s) { var e=document.getElementById('lidarScannerStatus'); if(e)e.textContent=s; }
    function updateRunButtonVisibility(show) {
        if (show === undefined) show = !!selected;
        var btn = document.getElementById('lidarScannerRun');
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
    function drawSelection(ll) {
        selected = ll;
        try { window._dlSearchAreaPin = { lat: ll.lat, lng: ll.lng }; } catch (e) {}
        updateRunButtonVisibility(true);
        if (selectedMarker) map.removeLayer(selectedMarker);
        if (selectionCircle) map.removeLayer(selectionCircle);
        var searchIcon = L.divIcon({
            className: 'lidar-search-marker-wrapper',
            html: '<div class="lidar-search-marker" title="Search Point / Punct Căutare"><div class="lidar-search-pulse"></div><div class="lidar-search-dot"></div></div>',
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });
        selectedMarker = L.marker(ll, assignPane({
            icon: searchIcon,
            zIndexOffset: 2000,
            interactive: true
        }, PANE_PIN)).addTo(map);
        /* The pulsing pin is HTML with no SVG glyph: mirrored on its own it
           degrades to a text label with no dot. The selection circle's 3D
           bridge already carries the centre point, so the marker itself
           stays 2D-only. */
        selectedMarker._dl3dSkip = true;
        selectedMarker.bindTooltip('<span class="lidar-result-tag"><b>Search Point / Punct căutare</b><br>' + ll.lat.toFixed(4) + ', ' + ll.lng.toFixed(4) + '</span>', assignPane({
            direction: 'top',
            offset: [0, -14],
            className: 'lidar-result-tooltip'
        }, PANE_TAGS));
        var circleOptions = {
            radius: parseInt(document.getElementById('lidarScannerDistance').value, 10) * 1000,
            color: CIRCLE_STYLE_IDLE.color,
            weight: CIRCLE_STYLE_IDLE.weight,
            dashArray: CIRCLE_STYLE_IDLE.dashArray,
            fill: CIRCLE_STYLE_IDLE.fill,
            fillColor: CIRCLE_STYLE_IDLE.fillColor,
            fillOpacity: CIRCLE_STYLE_IDLE.fillOpacity,
            opacity: CIRCLE_STYLE_IDLE.opacity,
            interactive: false
        };
        assignPane(circleOptions, PANE_CIRCLES);
        var renderer = circleRendererOption();
        if (renderer) circleOptions.renderer = renderer;
        selectionCircle = L.circle(ll, circleOptions).addTo(map);
        /* 3D: the selection reaches MapLibre as a ground polygon of the
           chosen radius plus its centre point (scannerSelectionFeatures3d),
           never as the raw L.circle — that mirrored as a point with a
           several-thousand-pixel radius and painted over everything. */
        selectionCircle._dl3dFeatures = scannerSelectionFeatures3d;
        if (selectionCircle.options) selectionCircle.options.name = 'LiDAR Scanner';
        setStatus(ll.lat.toFixed(4) + ', ' + ll.lng.toFixed(4));
        syncScanner3d();
    }
    function run() {
        if (!selected || scanning) return;
        scanning = true;
        var overlay = document.getElementById('lidarScannerLoading');
        if (overlay) overlay.classList.add('visible');
        var radius = +document.getElementById('lidarScannerDistance').value * 1000;

        // Wait for the CSV before scanning. This also covers a quick click on
        // Scan immediately after the layer has been enabled.
        load().then(function () {
            setTimeout(function () {
                var out = LidarGeo.scan(points, selected.lat, selected.lng, radius).filter(function (point) {
                    return !isNearHeritage(point);
                });
                if (resultsLayer) resultsLayer.clearLayers();
                else resultsLayer = L.layerGroup();
                resultPoints = out.slice();
                attachResults3d(resultsLayer);
                out.forEach(function (point) { resultsLayer.addLayer(makeResult(point)); });
                resultsLayer.addTo(map);
                syncScanner3d();
                if (out.length) {
                    var bounds = L.latLngBounds(out.map(function (point) { return [point.lat, point.lon]; }));
                    map.fitBounds(bounds.pad(.18), { maxZoom: 14 });
                    setStatus(out.length + ' result' + (out.length === 1 ? '' : 's') + ' / rezultate');
                } else {
                    setStatus('No results / Niciun rezultat');
                }
                if (overlay) overlay.classList.remove('visible');
                scanning = false;
            }, 5000);
        }).catch(function () {
            if (overlay) overlay.classList.remove('visible');
            scanning = false;
        });
    }
    /* Oglinda verticală a sliderului de distanță + dock-ul de acțiune centrat
       jos sunt gestionate de vertical-opacity-control.js; aici doar le spunem
       când stratul pornește/se oprește PROGRAMATIC (din catalog, din gating-ul
       de abonament etc.), caz în care evenimentul „change” al comutatorului nu
       se declanșează. */
    function notifyDistanceMirror(on) {
        try {
            var api = window.DetectLabVerticalOpacity;
            if (!api) return;
            if (on) { if (!api.isActiveFor('lidarScannerDistance')) api.select('lidarScannerDistance'); }
            /* La oprire se închide DOAR oglinda acestui strat (closeFor):
               api.close() le închide pe TOATE, deci un slider LIDAR adăugat al
               doilea pe ecran și apoi închis stinge și sliderul stratului
               alăturat + stratul său. Fallback-ul păstrează vechiul
               comportament dacă controalele verticale vin dintr-un shell mai
               vechi, fără closeFor. */
            else if (typeof api.closeFor === 'function') api.closeFor('lidarScannerDistance');
            else if (api.isActiveFor('lidarScannerDistance')) api.close();
        } catch (e) {}
    }

    function setActive(on) {
        active = on;
        if (!map) return;
        var row = document.getElementById('lidarScannerRow');
        if (row) row.classList.toggle('is-on', on);
        if (!on) {
            if (selectedMarker) map.removeLayer(selectedMarker);
            if (selectionCircle) map.removeLayer(selectionCircle);
            if (resultsLayer) resultsLayer.clearLayers();
            resultPoints = [];
            selected = null;
            map.off('click', onMapClick);
            setStatus('Choose a point on the map / Alege un punct pe harta');
            updateRunButtonVisibility(false);
        } else {
            map.on('click', onMapClick);
            updateRunButtonVisibility(!!selected);
            // load() reports the useful status and warning itself. Consume the
            // rejection here so an invalid file does not become an uncaught
            // promise in the browser console.
            load().catch(function () {});
        }
        notifyDistanceMirror(on);
    }
    /* Unghiul de desenare al hărții offline are prioritate: în acel mod un tap
       nu trebuie să lase și un pin cu cerc de rază pe hartă (vezi
       js/offline-maps.js → window._dlOfflineDrawActive). Același lucru pentru
       alegerea centrului zonei LiDAR de 3D (js/lidar-3d-focus.js →
       window._dlLidarFocusPicking): acolo tap-ul aparține dialogului. */
    function offlineDrawing(){ try { return !!window._dlOfflineDrawActive; } catch (e) { return false; } }
    function lidarFocusPicking(){ try { return !!window._dlLidarFocusPicking; } catch (e) { return false; } }
    function onMapClick(e){ if(window.dlApmPicking) return; if(active&&!scanning&&!offlineDrawing()&&!lidarFocusPicking())drawSelection(e.latlng); }
    function load() {
        if (pointsPromise) return pointsPromise;
        setStatus('Loading points / Se încarcă punctele…');
        pointsPromise = fetch(DATA_URL, { cache: 'no-cache' }).then(function (response) {
            if (!response.ok) throw Error('CSV HTTP ' + response.status);
            return response.text();
        }).then(function (text) {
            var records = parseCsv(text).filter(function (record) {
                return !isRemovedScannerPoint(record);
            });
            points = LidarGeo.load_points(records);
            setStatus(points.length + ' points loaded / puncte încărcate — choose a point on the map');
            return points;
        }).catch(function (error) {
            pointsPromise = null;
            console.warn('[LIDAR Scanner]', error);
            setStatus('Could not load scanner CSV / CSV-ul scannerului nu a putut fi încărcat');
            throw error;
        });
        return pointsPromise;
    }
    // ── Distance slider ───────────────────────────────────────────────────
    // A range input fires `input` on every touch move — up to ~120 times a
    // second on a modern phone. The old handler did a synchronous DOM text
    // write plus a full circle redraw inside each of those events, so on the
    // installed PWA (where the map, the frosted layer panel and the circle all
    // composite together) the events queued up faster than the device could
    // paint and the slider crawled behind the finger.
    //
    // Now every `input` only records the new value; the actual DOM/map work is
    // coalesced into a single requestAnimationFrame callback, so at most one
    // update happens per displayed frame no matter how fast the events arrive.
    // The heavy dashed-and-filled circle style is swapped for a cheap outline
    // for the duration of the drag and restored on release.

    // Marks the document while the distance slider is being dragged so CSS can
    // drop the layer panel's backdrop blur and other per-frame effects.
    function setDragClass(on) {
        var body = (typeof document !== 'undefined') && document.body;
        if (body && body.classList) body.classList.toggle('lidar-distance-dragging', !!on);
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
            if (selected && selectionCircle) selectionCircle.setRadius(value * 1000);
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
            if (selected && selectionCircle) selectionCircle.setStyle(CIRCLE_STYLE_DRAG);
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
            // Flush the last value first so the restored circle uses the
            // distance the user actually released on.
            if (pendingValue !== null) {
                cancelFrame();
                paint();
            }
            if (selected && selectionCircle) selectionCircle.setStyle(CIRCLE_STYLE_IDLE);
            setDragClass(false);
            /* The 3D selection polygon is sized by stamp (centre + radius):
               tell an open 3D view once, at the end of the drag, instead of
               on every coalesced repaint. */
            syncScanner3d();
        }

        slider.addEventListener('input', function () {
            pendingValue = +this.value;
            beginDrag();
            schedule();
            // Safety net: `change`/`pointerup` are the normal way out of a
            // drag, but a cancelled touch (notification, call, palm reject)
            // can swallow them. Restoring after a short idle period means the
            // circle can never get stuck in its stripped-down drag style.
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

    function wire() {
        map = window._dlMap;
        if (!map) { setTimeout(wire, 200); return; }
        document.getElementById('lidarScannerToggle').addEventListener('change', function () { setActive(this.checked); });
        wireDistanceSlider(
            document.getElementById('lidarScannerDistance'),
            document.getElementById('lidarScannerDistanceValue')
        );
        document.getElementById('lidarScannerRun').addEventListener('click', run);
        updateRunButtonVisibility(!!selected);
        setStatus('Choose a point on the map / Alege un punct pe harta');
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
    window.toggleLidarScannerLayer=setActive;

    // ── Public API for the other premium features ────────────────────────
    // js/archeo-report.js ("Raport arheologic") reads the very same annotation
    // set the scanner works with, so "adnotat pe LIDAR Scanner" means exactly
    // the same thing in both features (one CSV, one loader, one cache).
    // `ensureLoaded()` reuses the scanner's own promise cache, so a report
    // never triggers a second CSV download.
    window._lidarScannerApi = {
        getPoints: function () { return points; },
        /* The drawn results of the last scan (the 3D bridge's data). */
        getResultPoints: function () { return resultPoints.slice(); },
        resultsFeatures3d: scannerResultsFeatures3d,
        selectionFeatures3d: scannerSelectionFeatures3d,
        // Same heritage exclusions as run(); never expose hidden annotations
        // as automatic report results. Re-evaluate as heritage data loads.
        getEligiblePoints: function () { return points.filter(function (p) { return !isNearHeritage(p); }); },
        resultRadiusM: RESULT_RADIUS_M,
        ensureLoaded: function () { return load(); },
        isActive: function () { return active; },
        getSelected: function () { return selected; },
        updateRunButtonVisibility: updateRunButtonVisibility
    };
})();
