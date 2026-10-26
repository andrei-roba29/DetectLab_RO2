/* =====================================================================
 * other-maps-nls.js — National Library of Scotland source for
 * “Alte hărți / Other maps” (non-georeferenced historic sheets)
 * ---------------------------------------------------------------------
 * The NLS Map Finder (https://maps.nls.uk/geo/find/) indexes roughly
 * 200 000 scanned historic maps.  Only a fraction of them is georeferenced;
 * the rest are plain zoomable scans that carry a place name and a sheet
 * footprint but no on-map alignment — exactly the kind of sheet the Other
 * maps sub-layer exists for.
 *
 * Two NLS services are used, both public and CORS-enabled:
 *
 *   1. GeoServer WFS — the same point/bbox query the Map Finder itself fires
 *      (https://geoserver.nls.uk/geoserver/wfs).  Every feature describes a
 *      sheet: IMAGE (the viewer numeric id), SHEET / DATES / YEAR and the
 *      footprint polygon.  queryBBox() turns those features into the same
 *      record shape the Other maps catalogue uses.
 *
 *   2. The IIIF Image API on map-view.nls.uk — the scan pyramid behind the
 *      Map Images viewer.  For viewer id 102345214 the image service is
 *      https://map-view.nls.uk/iiif/2/10234%2F102345214/info.json (the
 *      prefix is the first five digits of the viewer id).  Tiles are plain
 *      IIIF region requests, so none of the Hungaricana hash machinery is
 *      needed: the adapter maps the overlay's (x, y, level) grid onto
 *      {x},{y},{w},{h}/{tw},{th}/0/default.jpg requests.
 *
 * The module registers itself as the 'nls' source of the tile dispatcher in
 * js/other-maps-tiles.js, which keeps the Hungaricana path byte-identical.
 *
 * Public API: window.DetectLabOtherMapsNls —
 *   SOURCE / IIIF_BASE / VIEW_BASE / WFS_BASE / FIND_LAYERS / COVERAGE
 *   iiifPath(imageId) / iiifBase(record) / imageIdOf(record)
 *   thumbUrl(record) / recordUrl(record)
 *   tileUrl(record, x, y, z)      → Promise<string>
 *   resolve(record, hint)         → Promise<{w, h, maxZoom, probed}>
 *   wfsBBoxUrl(bbox) / featureToRecord(feature) / queryBBox(bbox)
 *   findUrl(lat, lng) / inCoverage(lat, lng) / intersectsCoverage(bbox)
 *   stripHtml(text) / maxZoomFor(w, h)
 * ===================================================================== */
(function (root) {
    'use strict';

    var Tiles = root.DetectLabOtherMapsTiles;

    var SOURCE = 'nls';
    var IIIF_BASE = 'https://map-view.nls.uk/iiif/2/';
    var VIEW_BASE = 'https://maps.nls.uk/view/';
    var WFS_BASE = 'https://geoserver.nls.uk/geoserver/wfs';
    var FIND_BASE = 'https://maps.nls.uk/geo/find/';

    var TILE_SIZE = 512;
    var MAX_LEVEL = 12;
    var PYRAMID_CACHE_KEY = 'dlOtherMaps.nls.pyramid.v1';
    var FETCH_TIMEOUT_MS = 15000;
    var MAX_FEATURES = 300;

    /* The finder index covers Great Britain, Ireland and the nearby shelf.
     * Queries outside this box would come back empty, so they are not sent. */
    var COVERAGE = { north: 61, south: 49.1, west: -12.9, east: 1.8 };

    /* The WFS feature types behind the Map Finder, and the labels the sheet
     * window shows for them.  The layer list is the one the live finder
     * queries (GetFeature, typeName=nls:<layer>, INTERSECTS on the_geom). */
    var FIND_LAYERS = [
        'OS_6inch_all_find',
        'OS_one_inch_combined',
        'OS_National_Grid_all_find',
        'OS_25000_uk',
        'OS_25inch_all_find',
        'OS_Town_Plans',
        'os_quarter_inch',
        'os_half_inch',
        'bart_half_combined',
        'towns',
        'International_Map_of_the_World',
        'German_naval_charts'
    ];

    var LAYER_LABELS = {
        OS_6inch_all_find: 'Ordnance Survey six-inch maps',
        OS_one_inch_combined: 'Ordnance Survey one-inch maps',
        OS_National_Grid_all_find: 'Ordnance Survey National Grid maps',
        OS_25000_uk: 'Ordnance Survey 1:25,000 maps',
        OS_25inch_all_find: 'Ordnance Survey 25-inch maps',
        OS_Town_Plans: 'Ordnance Survey town plans',
        OS_Town_Plans_Eng_non500_WFS: 'Ordnance Survey town plans (England)',
        os_quarter_inch: 'Ordnance Survey quarter-inch maps',
        os_half_inch: 'Ordnance Survey half-inch maps',
        bart_half_combined: 'Bartholomew half-inch maps',
        towns: 'Town plans',
        International_Map_of_the_World: 'International Map of the World',
        German_naval_charts: 'German naval charts'
    };

    var _metaCache = Object.create(null);
    var _inflight = Object.create(null);

    /* ── tiny helpers ─────────────────────────────────────────────────── */
    function stripHtml(value) {
        return String(value == null ? '' : value)
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&[a-z]+;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function readStore() {
        try {
            var raw = root.localStorage && root.localStorage.getItem(PYRAMID_CACHE_KEY);
            return raw ? JSON.parse(raw) || {} : {};
        } catch (e) { return {}; }
    }

    function writeStore(store) {
        try {
            if (root.localStorage) root.localStorage.setItem(PYRAMID_CACHE_KEY, JSON.stringify(store));
        } catch (e) { /* private mode / quota — the info request simply re-runs */ }
    }

    function cachedMeta(path) {
        if (_metaCache[path]) return _metaCache[path];
        var store = readStore();
        var entry = store[path];
        if (entry && entry.w && entry.h && isFinite(entry.maxZoom)) {
            _metaCache[path] = { w: entry.w, h: entry.h, maxZoom: entry.maxZoom, cached: true };
            return _metaCache[path];
        }
        return null;
    }

    function rememberMeta(path, meta) {
        _metaCache[path] = meta;
        try {
            var store = readStore();
            store[path] = { w: meta.w, h: meta.h, maxZoom: meta.maxZoom };
            writeStore(store);
        } catch (e) { /* ignore */ }
    }

    /* ── identifiers ──────────────────────────────────────────────────── */
    /* Records are addressed in the catalogue as nls/<viewerId>; the IIIF
     * identifier used by map-view.nls.uk is <first five digits>/<viewerId>
     * (e.g. 102345214 → 10234/102345214 → iiif/2/10234%2F102345214). */
    function imageIdOf(record) {
        if (record == null) return '';
        if (typeof record === 'number') return String(record);
        if (typeof record === 'string') {
            return record.indexOf(SOURCE + '/') === 0 ? record.slice(SOURCE.length + 1) : record;
        }
        if (record.nlsId) return String(record.nlsId);
        var id = String(record.id || '');
        return id.indexOf(SOURCE + '/') === 0 ? id.slice(SOURCE.length + 1) : id;
    }

    function iiifPath(imageId) {
        var id = String(imageId);
        return id.slice(0, 5) + '/' + id;
    }

    function iiifBase(record) {
        var idPath = record && record.path
            ? record.path
            : iiifPath(imageIdOf(record));
        return IIIF_BASE + encodeURIComponent(idPath);
    }

    /* Older scans were published under the unversioned or /iiif/1/ service
     * path (Image API 1.1); every current viewer id lives under /iiif/2/.
     * Try the current service first and walk back to the legacy forms only
     * if it does not answer, so a re-homed scan still resolves. */
    function iiifBaseCandidates(record) {
        var idPath = record && record.path
            ? record.path
            : iiifPath(imageIdOf(record));
        var encoded = encodeURIComponent(idPath);
        return [
            'https://map-view.nls.uk/iiif/2/' + encoded,
            'https://map-view.nls.uk/iiif/' + encoded,
            'https://map-view.nls.uk/iiif/1/' + encoded
        ];
    }

    function recordUrl(record) {
        var id = imageIdOf(record);
        return id ? VIEW_BASE + id : FIND_BASE;
    }

    function thumbUrl(record) {
        var id = imageIdOf(record);
        if (!id) return '';
        /* width-only size keeps the sheet's aspect ratio, no hash needed. */
        return iiifBase(record) + '/full/256,/0/default.jpg';
    }

    /* ── pyramid maths ────────────────────────────────────────────────── */
    function maxZoomFor(width, height) {
        var longest = Math.max(Number(width) || 0, Number(height) || 0);
        var zoom = 0;
        var covered = TILE_SIZE;
        while (covered < longest && zoom < MAX_LEVEL) { covered *= 2; zoom++; }
        return zoom;
    }

    /* The deepest level the service actually publishes.  IIIF scale factors
     * are powers of two counted from the native image (1 = native), and the
     * overlay's level 0 is the smallest derivative — so the number of factors
     * minus one is exactly the overlay's maxZoom. */
    function maxZoomFromFactors(scaleFactors, width, height) {
        if (Array.isArray(scaleFactors) && scaleFactors.length) {
            var sorted = scaleFactors.slice().sort(function (a, b) { return a - b; });
            var powerOfTwo = sorted.every(function (f, i) { return f === Math.pow(2, i); });
            if (powerOfTwo) return sorted.length - 1;
        }
        return maxZoomFor(width, height);
    }

    function parseInfo(json) {
        var w = Number(json.width) || 0;
        var h = Number(json.height) || 0;
        if (!w || !h) return null;
        var factors = null;
        if (Array.isArray(json.tiles) && json.tiles.length) {
            factors = json.tiles[0].scaleFactors;
        } else if (Array.isArray(json.scale_factors)) {
            /* IIIF Image API 1.1 info responses (tile_width / scale_factors). */
            factors = json.scale_factors;
        }
        return { w: w, h: h, maxZoom: maxZoomFromFactors(factors, w, h), probed: false };
    }

    function fetchInfo(record) {
        if (typeof root.fetch !== 'function') return Promise.resolve(null);
        var candidates = iiifBaseCandidates(record);
        function attempt(index) {
            if (index >= candidates.length) return null;
            var controller = ('AbortController' in root) ? new root.AbortController() : null;
            var timer = controller
                ? root.setTimeout(function () { try { controller.abort(); } catch (e) { /* ignore */ } }, FETCH_TIMEOUT_MS)
                : null;
            return root.fetch(candidates[index] + '/info.json', {
                mode: 'cors',
                cache: 'force-cache',
                signal: controller ? controller.signal : undefined
            }).then(function (response) {
                if (timer) root.clearTimeout(timer);
                if (!response || !response.ok) return attempt(index + 1);
                return response.json();
            }).then(function (json) {
                if (json) return parseInfo(json);
                return attempt(index + 1);
            }).catch(function () {
                if (timer) root.clearTimeout(timer);
                return attempt(index + 1);
            });
        }
        return attempt(0);
    }

    /**
     * Resolve the natural pixel size of an NLS sheet.
     * @param {object|string} record catalogue record (or an IIIF path string)
     * @param {{w?:number,h?:number}} [hint] size already known (catalogue row)
     */
    function resolve(record, hint) {
        var path = record && record.path ? record.path : String(record || '');
        if (!path) return Promise.reject(new Error('missing NLS sheet path'));
        var cached = cachedMeta(path);
        if (cached) return Promise.resolve(cached);
        if (_inflight[path]) return _inflight[path];

        var task;
        if (hint && hint.w && hint.h) {
            var sized = {
                w: Number(hint.w),
                h: Number(hint.h),
                maxZoom: maxZoomFor(hint.w, hint.h),
                probed: false
            };
            rememberMeta(path, sized);
            task = Promise.resolve(sized);
        } else {
            task = fetchInfo(record).then(function (meta) {
                if (!meta) {
                    /* The info document is unreachable from this browser.
                     * The overlay can still frame the sheet from a guessed
                     * size; its tiles simply stay transparent until the
                     * service answers again. */
                    throw new Error('NLS info.json unavailable for ' + path);
                }
                rememberMeta(path, meta);
                return meta;
            });
        }
        _inflight[path] = task;
        task.then(function () { delete _inflight[path]; },
            function () { delete _inflight[path]; });
        return task;
    }

    /**
     * IIIF region URL for one tile of the overlay's pyramid.
     *
     * Overlay level L uses scale factor s = 2^(maxZoom-L): the level image is
     * w/s × h/s level pixels, split into 512 px tiles.  Tile (x, y) therefore
     * covers the natural-pixel region (x·512·s, y·512·s, 512·s, 512·s),
     * clamped to the image edge, and is requested at its level-pixel size.
     */
    function tileUrl(record, x, y, level) {
        return resolve(record).then(function (meta) {
            var s = Math.pow(2, meta.maxZoom - level);
            var wL = Math.max(1, Math.round(meta.w / s));
            var hL = Math.max(1, Math.round(meta.h / s));
            var rx = x * TILE_SIZE * s;
            var ry = y * TILE_SIZE * s;
            var rw = Math.min(TILE_SIZE * s, meta.w - rx);
            var rh = Math.min(TILE_SIZE * s, meta.h - ry);
            var tw = Math.min(TILE_SIZE, wL - x * TILE_SIZE);
            var th = Math.min(TILE_SIZE, hL - y * TILE_SIZE);
            if (rw <= 0 || rh <= 0 || tw <= 0 || th <= 0) return '';
            return iiifBase(record) + '/' +
                rx + ',' + ry + ',' + rw + ',' + rh + '/' +
                tw + ',' + th + '/0/default.jpg';
        });
    }

    /* ── Map Finder WFS ───────────────────────────────────────────────── */
    function layerName(featureId) {
        return String((featureId || '').split('.')[0] || '');
    }

    function bboxOfGeometry(geometry) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        function eatRing(ring) {
            for (var i = 0; i < ring.length; i++) {
                var x = ring[i][0], y = ring[i][1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        function eatPolygon(polygon) {
            for (var r = 0; r < polygon.length; r++) eatRing(polygon[r]);
        }
        if (geometry && geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
            eatPolygon(geometry.coordinates);
        } else if (geometry && geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
            geometry.coordinates.forEach(eatPolygon);
        }
        if (!isFinite(minX)) return null;
        return { west: minX, south: minY, east: maxX, north: maxY };
    }

    function yearFrom(properties, title) {
        var year = parseInt(properties && properties.YEAR, 10);
        if (isFinite(year) && year > 1500 && year < 2100) return year;
        var match = String(properties && (properties.DATES || '') + ' ' + (title || '')).match(/(1[5-9]\d\d|20\d\d)/);
        return match ? parseInt(match[1], 10) : null;
    }

    /* One WFS feature → the catalogue record shape used across Other maps. */
    function featureToRecord(feature) {
        if (!feature || !feature.properties) return null;
        var p = feature.properties;
        var image = String(p.IMAGE == null ? '' : p.IMAGE);
        if (!/^\d+$/.test(image)) return null;
        var type = layerName(feature.id);
        var title = stripHtml(p.SHEET || p.WFS_TITLE || ('NLS sheet ' + image));
        if (!title) return null;
        var place = title.split(' - ')[0].trim() || title;
        var bbox = bboxOfGeometry(feature.geometry);
        if (!bbox) return null;
        return {
            id: SOURCE + '/' + image,
            nlsId: image,
            source: SOURCE,
            path: iiifPath(image),
            title: title,
            subject: stripHtml(p.DATES) || null,
            place: place,
            lat: (bbox.north + bbox.south) / 2,
            lng: (bbox.east + bbox.west) / 2,
            bbox: bbox,
            year: yearFrom(p, title),
            provider: 'National Library of Scotland',
            collection: LAYER_LABELS[type] || type || 'National Library of Scotland maps',
            precision: 'settlement'
        };
    }

    /* The exact GetFeature request the Map Finder fires for a viewport: one
     * INTERSECTS polygon per feature type, joined with ';', the same way the
     * finder's own client repeats propertyName/CQL_FILTER per typeName. */
    function wfsBBoxUrl(bbox) {
        var west = Number(bbox.west), south = Number(bbox.south);
        var east = Number(bbox.east), north = Number(bbox.north);
        var polygon = 'POLYGON((' +
            west + ' ' + south + ',' + east + ' ' + south + ',' +
            east + ' ' + north + ',' + west + ' ' + north + ',' +
            west + ' ' + south + '))';
        var params = new root.URLSearchParams({
            service: 'WFS',
            version: '1.1.0',
            request: 'GetFeature',
            outputFormat: 'application/json',
            typeName: FIND_LAYERS.map(function (layer) { return 'nls:' + layer; }).join(','),
            /* the_geom is listed explicitly: with a propertyName filter
             * GeoServer would otherwise omit the footprint and the sheet
             * could not be placed on the map. */
            propertyName: FIND_LAYERS.map(function () { return '(the_geom,IMAGE,SHEET,DATES,YEAR)'; }).join(''),
            CQL_FILTER: FIND_LAYERS.map(function () {
                return 'INTERSECTS(the_geom,SRID=4326;' + polygon + ')';
            }).join(';'),
            maxFeatures: String(MAX_FEATURES)
        });
        return WFS_BASE + '?' + params.toString();
    }

    function queryBBox(bbox) {
        if (!bbox || !isFinite(bbox.west) || typeof root.fetch !== 'function') {
            return Promise.resolve([]);
        }
        var controller = ('AbortController' in root) ? new root.AbortController() : null;
        var timer = controller
            ? root.setTimeout(function () { try { controller.abort(); } catch (e) { /* ignore */ } }, FETCH_TIMEOUT_MS)
            : null;
        return root.fetch(wfsBBoxUrl(bbox), { signal: controller ? controller.signal : undefined })
            .then(function (response) {
                if (timer) root.clearTimeout(timer);
                if (!response || !response.ok) throw new Error('NLS WFS HTTP ' + (response && response.status));
                return response.json();
            })
            .then(function (json) {
                var seen = Object.create(null);
                var records = [];
                (json && Array.isArray(json.features) ? json.features : []).forEach(function (feature) {
                    var record = featureToRecord(feature);
                    if (record && !seen[record.id]) {
                        seen[record.id] = true;
                        records.push(record);
                    }
                });
                records.sort(function (a, b) {
                    return (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title);
                });
                return records;
            })
            .catch(function (err) {
                if (timer) root.clearTimeout(timer);
                console.warn('[OtherMaps:NLS] finder query failed', err);
                return [];
            });
    }

    /* ── coverage + deep links ────────────────────────────────────────── */
    function inCoverage(lat, lng) {
        lat = Number(lat); lng = Number(lng);
        return isFinite(lat) && isFinite(lng) &&
            lat >= COVERAGE.south && lat <= COVERAGE.north &&
            lng >= COVERAGE.west && lng <= COVERAGE.east;
    }

    function intersectsCoverage(bbox) {
        if (!bbox) return false;
        return !(Number(bbox.east) < COVERAGE.west ||
            Number(bbox.west) > COVERAGE.east ||
            Number(bbox.north) < COVERAGE.south ||
            Number(bbox.south) > COVERAGE.north);
    }

    /* The finder reads its marker from the #point=lat,lon hash fragment. */
    function findUrl(lat, lng) {
        return FIND_BASE + '#zoom=15&lat=' + Number(lat).toFixed(5) +
            '&lon=' + Number(lng).toFixed(5) +
            '&layers=102&b=1&z=0&point=' +
            Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
    }

    var adapter = {
        SOURCE: SOURCE,
        IIIF_BASE: IIIF_BASE,
        VIEW_BASE: VIEW_BASE,
        WFS_BASE: WFS_BASE,
        FIND_BASE: FIND_BASE,
        TILE_SIZE: TILE_SIZE,
        MAX_LEVEL: MAX_LEVEL,
        MAX_FEATURES: MAX_FEATURES,
        COVERAGE: COVERAGE,
        FIND_LAYERS: FIND_LAYERS,
        LAYER_LABELS: LAYER_LABELS,
        imageIdOf: imageIdOf,
        iiifPath: iiifPath,
        iiifBase: iiifBase,
        iiifBaseCandidates: iiifBaseCandidates,
        recordUrl: recordUrl,
        thumbUrl: thumbUrl,
        tileUrl: tileUrl,
        resolve: resolve,
        parseInfo: parseInfo,
        maxZoomFor: maxZoomFor,
        wfsBBoxUrl: wfsBBoxUrl,
        featureToRecord: featureToRecord,
        bboxOfGeometry: bboxOfGeometry,
        queryBBox: queryBBox,
        findUrl: findUrl,
        inCoverage: inCoverage,
        intersectsCoverage: intersectsCoverage,
        stripHtml: stripHtml
    };

    if (Tiles && typeof Tiles.registerSource === 'function') {
        Tiles.registerSource(SOURCE, adapter);
    }

    root.DetectLabOtherMapsNls = adapter;
}(typeof window !== 'undefined' ? window : this));
