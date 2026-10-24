/* =====================================================================
 * other-maps.js — “Alte hărți / Other maps” (sub-layer of Hărți istorice)
 * ---------------------------------------------------------------------
 * The portal maps.hungaricana.hu publishes tens of thousands of historical
 * sheets; only a small part of them is georeferenced (the “Geocoded data”
 * vector layer).  The rest — cadastral plans, county maps, road surveys —
 * carries a place name but no footprint, so on the portal itself it is
 * invisible on the map.
 *
 * This module brings those sheets onto the DetectLab map as a sub-layer of
 * the premium “Hărți istorice / Historical Maps” group:
 *
 *   1. every place that owns at least one sheet is painted as a
 *      semi-transparent green dot;
 *   2. the dots are grouped with EXACTLY the same physical-distance rules as
 *      the Patrimoniu sites (js/patrimoniu-clustering.js — 5 km at z6 down to
 *      1 km at z10, single pins from z11 up), so the two layers behave alike;
 *   3. tapping a dot opens the list of sheets recorded for that place;
 *   4. a sheet added to the map becomes a free-transform overlay
 *      (js/other-maps-overlay.js): drag to move it over the basemap, corner
 *      handles to scale it, a rotation handle to turn it — like placing one
 *      image over another in Photoshop.  The alignment is kept per browser in
 *      localStorage.
 *
 * Public API: window.DetectLabOtherMaps — attach / setEnabled / isEnabled /
 * setOpacity / getOpacity / records / showPanel / hidePanel, plus the panel
 * row callbacks window.toggleOtherMaps(on) and window.setOtherMapsOpacity(v).
 * ===================================================================== */
(function (root) {
    'use strict';

    var L = root.L;
    var Tiles = root.DetectLabOtherMapsTiles;
    var Overlays = root.DetectLabOtherMapsOverlay;

    var CATALOG_URL = 'data/other-maps-catalog.json';
    var POINTS_PANE = 'pane_other_maps_points';
    var OVERLAY_PANE = 'pane_other_maps_overlay';
    var STORE_KEY = 'dlOtherMaps.v1';

    var DOT_FILL = 'rgba(46, 204, 113, 0.35)';
    var DOT_STROKE = 'rgba(46, 204, 113, 0.9)';
    var CLUSTER_FILL = 'rgba(14, 64, 38, 0.88)';
    var CLUSTER_STROKE = '#2ecc71';

    var STRINGS = {
        ro: {
            layer_other_maps: 'Alte hărți',
            om_available: 'Hărți disponibile',
            om_maps_count: '{n} hărți',
            om_map_count: '1 hartă',
            om_add: 'Adaugă pe hartă',
            om_added: 'Pe hartă',
            om_source: 'Deschide pe Hungaricana',
            om_none: 'Nicio hartă înregistrată pentru acest loc.',
            om_loading: 'Se încarcă harta…',
            om_align: 'Mod aliniere',
            om_align_hint: 'Trage harta ca s-o muți · roata = scală · Shift + roata = rotație · mânerele de colț = mărire',
            om_locked_hint: 'Alinierea e blocată. Pornește „Mod aliniere” ca să muți harta.',
            om_opacity: 'Opacitate',
            om_rotation: 'Rotație',
            om_scale: 'Scară',
            om_width: 'Lățime pe teren',
            om_center: 'Centrează',
            om_fit: 'Încadrează',
            om_reset: 'Resetează',
            om_delete: 'Șterge',
            om_panel_title: 'Suprapune harta',
            om_empty: 'Nicio hartă adăugată. Atinge un punct verde de pe hartă.',
            om_added_toast: 'Harta a fost adăugată. Folosește panoul ca s-o potrivești.',
            om_failed: 'Harta nu a putut fi încărcată.'
        },
        en: {
            layer_other_maps: 'Other maps',
            om_available: 'Available maps',
            om_maps_count: '{n} maps',
            om_map_count: '1 map',
            om_add: 'Add to map',
            om_added: 'On map',
            om_source: 'Open on Hungaricana',
            om_none: 'No map recorded for this place.',
            om_loading: 'Loading the sheet…',
            om_align: 'Align mode',
            om_align_hint: 'Drag the sheet to move it · wheel = scale · Shift + wheel = rotate · corner handles = resize',
            om_locked_hint: 'Alignment is locked. Turn “Align mode” on to move the sheet.',
            om_opacity: 'Opacity',
            om_rotation: 'Rotation',
            om_scale: 'Scale',
            om_width: 'Ground width',
            om_center: 'Center',
            om_fit: 'Fit',
            om_reset: 'Reset',
            om_delete: 'Remove',
            om_panel_title: 'Overlay the map',
            om_empty: 'No map added yet. Tap a green point on the map.',
            om_added_toast: 'Map added — use the panel to fit it.',
            om_failed: 'The sheet could not be loaded.'
        },
        hu: {
            layer_other_maps: 'Egyéb térképek',
            om_available: 'Elérhető térképek',
            om_maps_count: '{n} térkép',
            om_map_count: '1 térkép',
            om_add: 'Hozzáadás a térképhez',
            om_added: 'A térképen',
            om_source: 'Megnyitás a Hungaricanán',
            om_none: 'Ehhez a helyhez nincs térkép.',
            om_loading: 'A térkép betöltése…',
            om_align: 'Illesztés mód',
            om_align_hint: 'Húzd a mozgatáshoz · görgő = méret · Shift + görgő = forgatás · sarokpontok = átméretezés',
            om_locked_hint: 'Az illesztés zárolva van. Kapcsold be az „Illesztés mód”-ot.',
            om_opacity: 'Átlátszóság',
            om_rotation: 'Forgatás',
            om_scale: 'Méretarány',
            om_width: 'Szélesség a terepen',
            om_center: 'Középre',
            om_fit: 'Illesztés',
            om_reset: 'Visszaállítás',
            om_delete: 'Törlés',
            om_panel_title: 'Térkép ráhelyezése',
            om_empty: 'Még nincs térkép. Érints egy zöld pontot a térképen.',
            om_added_toast: 'Térkép hozzáadva — a panelen illesztheted.',
            om_failed: 'A térkép nem tölthető be.'
        }
    };

    var state = {
        map: null,
        manager: null,
        enabled: false,
        opacity: 0.8,
        catalog: null,
        records: [],
        locations: [],
        index: null,
        hits: [],
        canvas: null,
        ctx: null,
        modal: null,
        panel: null,
        loading: null,
        lang: 'en',
        /* The settled frame the canvas was last painted for — the zoom
         * animation transform (applyZoomTransform) scales around exactly this
         * anchor, the same contract the Patrimoniu canvases use in
         * map-app.js (_canvasAnchor / _updateCanvasTransform). */
        lastCenter: null,
        lastZoom: null,
        lastAnchor: null
    };

    /* ── i18n ─────────────────────────────────────────────────────────── */
    function detectLang() {
        var docLang = document.documentElement && document.documentElement.lang;
        var stored = null;
        try { stored = root.localStorage && root.localStorage.getItem('detectlab_lang'); } catch (e) { /* ignore */ }
        var lang = String(stored || docLang || 'en').slice(0, 2).toLowerCase();
        return STRINGS[lang] ? lang : 'en';
    }

    function t(key, fallback) {
        var table = STRINGS[state.lang] || STRINGS.en;
        if (table[key]) return table[key];
        if (STRINGS.en[key]) return STRINGS.en[key];
        return fallback == null ? key : fallback;
    }

    function tCount(key, n) {
        var value = n === 1 ? t(key === 'om_maps_count' ? 'om_map_count' : key) : t(key);
        return String(value).replace('{n}', n);
    }

    /* ── storage ──────────────────────────────────────────────────────── */
    function readStore() {
        try {
            var raw = root.localStorage && root.localStorage.getItem(STORE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function writeStore() {
        if (!state.manager) return;
        try {
            var snapshot = state.manager.snapshot();
            root.localStorage.setItem(STORE_KEY, JSON.stringify({
                version: 1,
                enabled: state.enabled,
                opacity: state.opacity,
                activeId: snapshot.activeId,
                overlays: snapshot.overlays
            }));
        } catch (e) { /* private mode — alignment simply is not persisted */ }
    }

    /* ── catalogue ────────────────────────────────────────────────────── */
    function loadCatalog() {
        if (state.catalog) return Promise.resolve(state.catalog);
        if (state.loading) return state.loading;
        state.loading = fetch(CATALOG_URL, { cache: 'force-cache' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (json) {
                state.catalog = json;
                if (Tiles && json) {
                    Tiles.configure({
                        tile: json.tileBase,
                        thumb: json.thumbBase,
                        size: json.sizeBase,
                        record: json.recordBase
                    });
                }
                buildIndex(json);
                return json;
            })
            .catch(function (err) {
                console.error('[OtherMaps] catalog failed to load', err);
                state.loading = null;
                throw err;
            });
        return state.loading;
    }

    function buildIndex(catalog) {
        var clusterer = root.DetectLabPatrimoniuClustering;
        var records = [];
        var seen = Object.create(null);
        (catalog && catalog.maps ? catalog.maps : []).forEach(function (entry) {
            var lat = Number(entry.lat);
            var lng = Number(entry.lng);
            if (!isFinite(lat) || !isFinite(lng) || !entry.path) return;
            var key = entry.id || (entry.path + '|' + lat + '|' + lng);
            if (seen[key]) return;
            seen[key] = true;
            records.push({
                id: entry.id,
                title: entry.title,
                subject: entry.subject,
                place: entry.place,
                lat: lat,
                lng: lng,
                latlng: L.latLng(lat, lng),
                year: entry.year,
                provider: entry.provider,
                collection: entry.collection,
                path: entry.path,
                precision: entry.precision,
                w: entry.w,
                h: entry.h,
                radius: 7
            });
        });
        state.records = records;
        buildLocations(records);
        return records;
    }

    /* One dot per PLACE, not per sheet: the portal stores a single point for
     * a place, so every sheet recorded there shares it and painting them
     * separately would only stack identical dots. Those places are what the
     * physical-distance clustering then groups, exactly like the Patrimoniu
     * sites — one dot for several close places at country scale, individual
     * pins from z11 up. */
    function locationKey(record) {
        return record.place + '|' + record.lat.toFixed(4) + '|' + record.lng.toFixed(4);
    }

    function groupByPlace(records) {
        var groups = Object.create(null);
        var order = [];
        (records || []).forEach(function (record) {
            var key = locationKey(record);
            var group = groups[key];
            if (!group) {
                group = groups[key] = {
                    key: key,
                    place: record.place,
                    lat: record.lat,
                    lng: record.lng,
                    latlng: record.latlng || { lat: record.lat, lng: record.lng },
                    sheets: [],
                    count: 0
                };
                order.push(group);
            }
            group.sheets.push(record);
            group.count = group.sheets.length;
        });
        return order;
    }

    function buildLocations(records) {
        var clusterer = root.DetectLabPatrimoniuClustering;
        var order = groupByPlace(records);
        state.locations = order;
        if (clusterer) {
            state.index = new clusterer.SpatialIndex(clusterer.CONFIG.indexCellSizeM);
            order.forEach(function (location) { state.index.add(location); });
        } else {
            state.index = null;
        }
        return order;
    }

    function clusterConfig() {
        var clusterer = root.DetectLabPatrimoniuClustering;
        return clusterer ? clusterer.CONFIG : {
            minZoom: 6,
            disableClusteringAtZoom: 11,
            distanceKmByZoom: { 6: 5, 7: 4, 8: 3, 9: 2, 10: 1 },
            defaultDistanceKm: 5,
            indexCellSizeM: 2500
        };
    }

    /* ── the green dots ───────────────────────────────────────────────── */
    function ensureCanvas() {
        var map = state.map;
        var pane = map.getPane(POINTS_PANE) || map.createPane(POINTS_PANE);
        pane.style.zIndex = '617';
        pane.style.pointerEvents = 'none';
        if (!state.canvas) {
            state.canvas = document.createElement('canvas');
            /* leaflet-zoom-animated: while the map pane carries
             * .leaflet-zoom-anim, css/leaflet.css gives the element the same
             * 250 ms transform transition (and 0 0 transform-origin) as the
             * tile containers — applyZoomTransform below rides it, so the dots
             * glide exactly with the tiles during a zoom animation. */
            state.canvas.className = 'other-maps-canvas leaflet-zoom-animated';
            state.canvas.style.position = 'absolute';
            state.canvas.style.left = '0';
            state.canvas.style.top = '0';
            state.canvas.style.pointerEvents = 'none';
            pane.appendChild(state.canvas);
            state.ctx = state.canvas.getContext('2d');
        }
        return state.canvas;
    }

    function layerPointUnrounded(latlng) {
        return state.map.project(latlng, state.map.getZoom()).subtract(state.map.getPixelOrigin());
    }

    function redraw() {
        var map = state.map;
        var canvas = state.canvas;
        var ctx = state.ctx;
        if (!canvas || !ctx) return;
        if (!state.enabled || !state.locations.length) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            state.hits = [];
            return;
        }
        var size = map.getSize();
        if (canvas.width !== size.x) canvas.width = size.x;
        if (canvas.height !== size.y) canvas.height = size.y;

        var clusterer = root.DetectLabPatrimoniuClustering;
        var config = clusterConfig();
        var zoom = map.getZoom();
        var distanceKm = clusterer ? clusterer.getDistanceKm(zoom, config) : (zoom >= 11 ? 0 : 5);
        var bounds = map.getBounds();
        var padM = distanceKm * 1000 + 1000;
        var sw = clusterer ? clusterer.project(bounds.getSouth(), bounds.getWest())
            : { x: bounds.getWest(), y: bounds.getSouth() };
        var ne = clusterer ? clusterer.project(bounds.getNorth(), bounds.getEast())
            : { x: bounds.getEast(), y: bounds.getNorth() };
        var minX = Math.min(sw.x, ne.x) - padM;
        var maxX = Math.max(sw.x, ne.x) + padM;
        var minY = Math.min(sw.y, ne.y) - padM;
        var maxY = Math.max(sw.y, ne.y) + padM;

        var candidates = state.index
            ? state.index.queryBBox(minX, minY, maxX, maxY)
            : state.locations.filter(function (location) {
                ensureProjected(location, clusterer);
                return location._clusterX >= minX && location._clusterX <= maxX &&
                    location._clusterY >= minY && location._clusterY <= maxY;
            });

        var clusters = clusterer
            ? clusterer.clusterRecords(candidates, zoom, state.index, config)
            : candidates.map(function (location) {
                return {
                    isCluster: false, count: 1, members: [location], latlng: location.latlng,
                    minX: location._clusterX, maxX: location._clusterX,
                    minY: location._clusterY, maxY: location._clusterY
                };
            });

        var topLeft = map.containerPointToLayerPoint(L.point(0, 0));
        ctx.clearRect(0, 0, size.x, size.y);
        ctx.save();
        ctx.translate(-topLeft.x, -topLeft.y);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = state.opacity;
        state.hits = [];

        for (var i = 0; i < clusters.length; i++) {
            var cluster = clusters[i];
            if (cluster.maxX < minX || cluster.minX > maxX ||
                cluster.maxY < minY || cluster.minY > maxY) continue;
            var ll = cluster.latlng || (cluster.members[0] && cluster.members[0].latlng);
            if (!ll) continue;
            var point = layerPointUnrounded(ll);
            var radius;
            var sheets = 0;
            for (var m = 0; m < cluster.members.length; m++) {
                sheets += cluster.members[m].count || 1;
            }
            if (cluster.members.length > 1) {
                // A geographic group of several places: one bigger bubble that
                // says how many sheets live behind it.
                radius = Math.min(22, 11 + Math.log(sheets) * 2);
                ctx.beginPath();
                ctx.fillStyle = CLUSTER_FILL;
                ctx.strokeStyle = CLUSTER_STROKE;
                ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#EAFBF1';
                ctx.font = '600 ' + (sheets > 99 ? '9px' : '10px') + ' Outfit, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(sheets > 999 ? '999+' : String(sheets), point.x, point.y);
            } else {
                // One place: a semi-transparent green dot, slightly larger the
                // more sheets it holds, with the count from two sheets upwards.
                radius = Math.min(13, 7 + Math.log(sheets) * 2.4);
                ctx.beginPath();
                ctx.fillStyle = DOT_FILL;
                ctx.strokeStyle = DOT_STROKE;
                ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                if (sheets > 1) {
                    ctx.fillStyle = '#EAFBF1';
                    ctx.font = '600 8px Outfit, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(sheets), point.x, point.y);
                }
            }
            state.hits.push({
                latlng: ll,
                point: point,
                radius: Math.max(radius + 4, 10),
                cluster: cluster
            });
        }
        ctx.restore();
        ctx.globalAlpha = 1;

        /* Remember exactly what was painted: the project-space coordinate of
         * bitmap pixel (0,0) is pixelOrigin + topLeft, because the context
         * was translated by -topLeft.  applyZoomTransform() may only scale
         * around this anchor — mirroring the Patrimoniu canvases. */
        state.lastCenter = map.getCenter();
        state.lastZoom = map.getZoom();
        state.lastAnchor = L.point(map.getPixelOrigin()).add(topLeft);
    }

    /* Keep the dots locked to the tiles during a zoom animation.  While
     * Leaflet animates a zoom it leaves the map pane stationary for 250 ms
     * and CSS-scales the tile containers; a canvas that is a child of the
     * pane but has no zoomanim transform of its own sits still — the dots
     * appear to slide away from their places and snap back at zoomend (the
     * “se mișcă sacadat” glitch).  This applies the same transform the
     * Patrimoniu canvases use (map-app.js _updateCanvasTransform):
     *     translate(scale·anchor − newPixelOrigin) · scale
     * which, in Web Mercator project space (linear in zoom), lands every
     * painted pixel at its exact target-zoom layer position.  The 250 ms
     * glide comes from `.leaflet-zoom-anim .leaflet-zoom-animated`
     * (css/leaflet.css).  A settled redraw (onMapMoved) replaces the
     * transform with a plain setPosition, so it never lingers. */
    function applyZoomTransform(center, zoom) {
        if (!state.enabled || !state.canvas || !state.lastAnchor || state.lastZoom == null) return;
        if (zoom == null || typeof state.map._getNewPixelOrigin !== 'function') return;
        var scale = state.map.getZoomScale(zoom, state.lastZoom);
        var topLeftOffset = L.point(state.lastAnchor).multiplyBy(scale)
            .subtract(state.map._getNewPixelOrigin(center, zoom))._round();
        if (L.DomUtil && typeof L.DomUtil.setTransform === 'function') {
            L.DomUtil.setTransform(state.canvas, topLeftOffset, scale);
        }
    }

    /* The clustering helper projects every record it indexes. This is only
     * needed for the safety path below, where that helper is unavailable and
     * the canvas works in plain degrees instead of metres. */
    function ensureProjected(record, clusterer) {
        if (isFinite(record._clusterX) && isFinite(record._clusterY)) return record;
        var ll = record.latlng || record;
        if (clusterer) {
            var p = clusterer.project(ll.lat, ll.lng);
            record._clusterX = p.x;
            record._clusterY = p.y;
        } else {
            record._clusterX = Number(ll.lng) || 0;
            record._clusterY = Number(ll.lat) || 0;
        }
        return record;
    }

    function onMapMoved() {
        if (!state.enabled) return;
        /* Both transient states are handled by applyZoomTransform instead:
         * during _animatingZoom the pixels are CSS-scaled from the last
         * settled frame, and during a pinch they are rescaled from it on
         * every 'zoom' event.  Redrawing now would jump the dots to the
         * final pixels (or fight the transform) — the same reason the
         * Patrimoniu canvases skip it. */
        if (state.map._animatingZoom) return;
        if (state.map.touchZoom && state.map.touchZoom._zooming) return;
        var canvas = state.canvas;
        if (!canvas) return;
        L.DomUtil.setPosition(canvas, state.map.containerPointToLayerPoint(L.point(0, 0)));
        redraw();
    }

    /* ── clicking a dot ───────────────────────────────────────────────── */
    /* A cluster is a *place* when it holds a single location: several sheets
     * of one place are merged into that location when the catalogue is read,
     * so anything with more than one member is a geographic group and the tap
     * should zoom in instead of opening the list. */
    function clusterSpreadMeters(cluster) {
        if (!cluster || !isFinite(cluster.maxX) || !isFinite(cluster.minX)) return 0;
        return Math.max(cluster.maxX - cluster.minX, cluster.maxY - cluster.minY);
    }

    function isLocationCluster(cluster) {
        if (!cluster || !Array.isArray(cluster.members)) return true;
        return cluster.members.length <= 1;
    }

    function onMapClick(e) {
        if (!state.enabled || !e.latlng || !e.containerPoint) return;
        if (typeof state.map._draggableMoved === 'function' && state.map._draggableMoved(state.map)) return;
        var point = e.layerPoint || state.map.containerPointToLayerPoint(e.containerPoint);
        for (var i = state.hits.length - 1; i >= 0; i--) {
            var hit = state.hits[i];
            var dx = point.x - hit.point.x;
            var dy = point.y - hit.point.y;
            if (dx * dx + dy * dy > hit.radius * hit.radius) continue;
            var cluster = hit.cluster;
            // One place → its sheets. Several places grouped by distance →
            // zoom in until they split apart, the same gesture the Patrimoniu
            // layer uses.
            if (!isLocationCluster(cluster)) {
                var bounds = L.latLngBounds(cluster.members.map(function (member) { return member.latlng; }));
                if (bounds.isValid()) {
                    state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: Math.min(14, state.map.getMaxZoom()) });
                }
                return;
            }
            var location = cluster.members[0];
            openModal(location.sheets || [location], hit.latlng, location.place);
            return;
        }
    }

    /* ── the “available maps” window ──────────────────────────────────── */
    function ensureModal() {
        if (state.modal) return state.modal;
        var modal = document.createElement('div');
        modal.className = 'om-modal';
        modal.innerHTML =
            '<div class="om-modal-card" role="dialog" aria-modal="true">' +
            '<button type="button" class="om-modal-close" aria-label="Close">×</button>' +
            '<h3 class="om-modal-title"></h3>' +
            '<div class="om-modal-sub"></div>' +
            '<div class="om-modal-list"></div>' +
            '<div class="om-modal-foot"></div>' +
            '</div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function (event) {
            if (event.target === modal) closeModal();
        });
        modal.querySelector('.om-modal-close').addEventListener('click', closeModal);
        root.document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && state.modal && state.modal.classList.contains('show')) {
                closeModal();
            }
        });
        state.modal = modal;
        return modal;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function openModal(sheets, latlng, place) {
        var modal = ensureModal();
        var list = modal.querySelector('.om-modal-list');
        var members = sheets || [];
        if (!place && members.length) place = members[0].place;
        modal.querySelector('.om-modal-title').textContent = t('om_available');
        modal.querySelector('.om-modal-sub').textContent =
            (place ? place + ' · ' : '') + tCount('om_maps_count', members.length);
        modal.querySelector('.om-modal-foot').textContent =
            state.catalog && state.catalog.source ? state.catalog.source.attribution : '';

        list.innerHTML = members.map(function (record) {
            var thumb = Tiles ? Tiles.thumbUrl(record.path) : '';
            var recordUrl = Tiles ? Tiles.recordUrl(record.id) : '#';
            var meta = [record.year, record.collection, record.provider].filter(Boolean).join(' · ');
            return '<div class="om-card" data-om-id="' + escapeHtml(record.id) + '">' +
                '<a class="om-thumb" href="' + escapeHtml(recordUrl) + '" target="_blank" rel="noopener">' +
                (thumb ? '<img src="' + escapeHtml(thumb) + '" alt="" loading="lazy">' : '') +
                '</a>' +
                '<div class="om-card-body">' +
                '<div class="om-card-title">' + escapeHtml(record.title) + '</div>' +
                (record.subject ? '<div class="om-card-subject">' + escapeHtml(record.subject) + '</div>' : '') +
                (meta ? '<div class="om-card-meta">' + escapeHtml(meta) + '</div>' : '') +
                '<div class="om-card-actions">' +
                '<button type="button" class="om-btn om-btn-add" data-om-add="' + escapeHtml(record.id) + '">' +
                escapeHtml(t('om_add')) + '</button>' +
                '<a class="om-btn om-btn-ghost" href="' + escapeHtml(recordUrl) +
                '" target="_blank" rel="noopener">' + escapeHtml(t('om_source')) + '</a>' +
                '</div></div></div>';
        }).join('');

        Array.prototype.forEach.call(list.querySelectorAll('[data-om-add]'), function (button) {
            button.addEventListener('click', function () {
                addMapById(button.getAttribute('data-om-add'), latlng);
            });
        });

        refreshModalState();
        modal.classList.add('show');
    }

    function refreshModalState() {
        if (!state.modal || !state.manager) return;
        Array.prototype.forEach.call(state.modal.querySelectorAll('[data-om-add]'), function (button) {
            var id = button.getAttribute('data-om-add');
            var added = state.manager.has(id);
            button.textContent = added ? t('om_added') : t('om_add');
            button.classList.toggle('is-on', added);
            button.disabled = added;
        });
    }

    function closeModal() {
        if (state.modal) state.modal.classList.remove('show');
    }

    function findRecord(id) {
        for (var i = 0; i < state.records.length; i++) {
            if (state.records[i].id === id) return state.records[i];
        }
        return null;
    }

    function addMapById(id, latlng) {
        var record = findRecord(id);
        if (!record) return;
        var button = state.modal && state.modal.querySelector('[data-om-add="' + id + '"]');
        if (button) {
            button.disabled = true;
            button.textContent = t('om_loading');
        }
        state.manager.add(record).then(function (ov) {
            if (!ov) return;
            state.manager.setOpacity(record.id, state.opacity);
            state.manager.setActive(record.id);
            state.manager.setAlignMode(true);
            showPanel();
            closeModal();
            writeStore();
            if (latlng) {
                // Nudge the view so the fresh sheet is in front of the user.
                try { state.map.panTo(latlng, { animate: true }); } catch (e) { /* ignore */ }
            }
        }).catch(function (err) {
            console.warn('[OtherMaps] add failed', err);
            if (button) { button.disabled = false; button.textContent = t('om_failed'); }
        });
    }

    /* ── the alignment panel ──────────────────────────────────────────── */
    function ensurePanel() {
        if (state.panel) return state.panel;
        var panel = document.createElement('div');
        panel.className = 'om-panel';
        panel.innerHTML =
            '<div class="om-panel-head">' +
            '<span class="om-panel-title"></span>' +
            '<button type="button" class="om-panel-close" aria-label="Close">×</button>' +
            '</div>' +
            '<select class="om-panel-select" aria-label="Map"></select>' +
            '<div class="om-panel-empty"></div>' +
            '<div class="om-panel-row">' +
            '<span class="om-panel-label"></span>' +
            '<label class="apm-toggle-switch om-panel-switch">' +
            '<input type="checkbox" class="om-panel-align"><span class="apm-toggle-track"></span>' +
            '</label></div>' +
            '<div class="om-panel-hint"></div>' +
            '<label class="om-slider"><span class="om-slider-name om-t-opacity"></span>' +
            '<span class="om-slider-value om-v-opacity"></span>' +
            '<input type="range" class="om-range om-r-opacity" min="0" max="100" step="1"></label>' +
            '<label class="om-slider"><span class="om-slider-name om-t-rotation"></span>' +
            '<span class="om-slider-value om-v-rotation"></span>' +
            '<input type="range" class="om-range om-r-rotation" min="-180" max="180" step="0.5"></label>' +
            '<label class="om-slider"><span class="om-slider-name om-t-scale"></span>' +
            '<span class="om-slider-value om-v-scale"></span>' +
            '<input type="range" class="om-range om-r-scale" min="0" max="1000" step="1"></label>' +
            '<div class="om-panel-actions">' +
            '<button type="button" class="om-btn om-btn-ghost om-a-center"></button>' +
            '<button type="button" class="om-btn om-btn-ghost om-a-fit"></button>' +
            '<button type="button" class="om-btn om-btn-ghost om-a-reset"></button>' +
            '<button type="button" class="om-btn om-btn-danger om-a-delete"></button>' +
            '</div>';
        var container = (state.map && state.map.getContainer()) || document.body;
        container.appendChild(panel);

        panel.querySelector('.om-panel-close').addEventListener('click', function () {
            state.manager.setAlignMode(false);
            hidePanel();
        });
        panel.querySelector('.om-panel-select').addEventListener('change', function (event) {
            state.manager.setActive(event.target.value);
            paintPanel();
        });
        panel.querySelector('.om-panel-align').addEventListener('change', function (event) {
            state.manager.setAlignMode(event.target.checked);
            paintPanel();
        });
        panel.querySelector('.om-r-opacity').addEventListener('input', function (event) {
            var id = state.manager.getActiveId();
            if (!id) return;
            state.manager.setOpacity(id, Number(event.target.value) / 100);
            paintValues();
        });
        panel.querySelector('.om-r-rotation').addEventListener('input', function (event) {
            var id = state.manager.getActiveId();
            if (!id) return;
            state.manager.setState(id, { rotation: Number(event.target.value) });
            paintValues();
        });
        panel.querySelector('.om-r-scale').addEventListener('input', function (event) {
            var id = state.manager.getActiveId();
            if (!id) return;
            state.manager.setState(id, { mpp: mppFromSlider(Number(event.target.value)) });
            paintValues();
        });
        panel.querySelector('.om-a-center').addEventListener('click', function () {
            var id = state.manager.getActiveId();
            if (id) state.manager.centerOn(id);
        });
        panel.querySelector('.om-a-fit').addEventListener('click', function () {
            var id = state.manager.getActiveId();
            if (id) { state.manager.fitToView(id); paintValues(); }
        });
        panel.querySelector('.om-a-reset').addEventListener('click', function () {
            var id = state.manager.getActiveId();
            if (id && state.manager.reset(id)) paintValues();
        });
        panel.querySelector('.om-a-delete').addEventListener('click', function () {
            var id = state.manager.getActiveId();
            if (!id) return;
            state.manager.remove(id);
            writeStore();
            paintPanel();
        });
        panel.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
        state.panel = panel;
        return panel;
    }

    function clampMpp(value) {
        var limits = state.manager && state.manager.limits ? state.manager.limits : { mppMin: 0.02, mppMax: 400 };
        return Math.max(limits.mppMin, Math.min(limits.mppMax, Number(value) || limits.mppMin));
    }

    function sliderFromMpp(mpp) {
        var limits = state.manager && state.manager.limits ? state.manager.limits : { mppMin: 0.02, mppMax: 400 };
        var ratio = (clampMpp(mpp) - limits.mppMin) / (limits.mppMax - limits.mppMin);
        return Math.round(Math.max(0, Math.min(1, ratio)) * 1000);
    }

    function mppFromSlider(value) {
        var limits = state.manager && state.manager.limits ? state.manager.limits : { mppMin: 0.02, mppMax: 400 };
        var ratio = Math.max(0, Math.min(1, Number(value) / 1000));
        return clampMpp(limits.mppMin + ratio * (limits.mppMax - limits.mppMin));
    }

    function showPanel() {
        var panel = ensurePanel();
        paintPanel();
        panel.classList.add('show');
    }

    function hidePanel() {
        if (state.panel) state.panel.classList.remove('show');
    }

    function paintPanel() {
        var panel = state.panel;
        if (!panel || !state.manager) return;
        panel.querySelector('.om-panel-title').textContent = t('om_panel_title');
        panel.querySelector('.om-t-opacity').textContent = t('om_opacity');
        panel.querySelector('.om-t-rotation').textContent = t('om_rotation');
        panel.querySelector('.om-t-scale').textContent = t('om_scale');
        panel.querySelector('.om-a-center').textContent = t('om_center');
        panel.querySelector('.om-a-fit').textContent = t('om_fit');
        panel.querySelector('.om-a-reset').textContent = t('om_reset');
        panel.querySelector('.om-a-delete').textContent = t('om_delete');

        var list = state.manager.list();
        var select = panel.querySelector('.om-panel-select');
        var activeId = state.manager.getActiveId();
        select.innerHTML = list.map(function (ov) {
            var record = ov.record;
            var label = record.title || record.id;
            if (label.length > 60) label = label.slice(0, 58) + '…';
            return '<option value="' + escapeHtml(ov.id) + '">' + escapeHtml(label) + '</option>';
        }).join('');
        var empty = list.length === 0;
        select.style.display = empty ? 'none' : '';
        panel.querySelector('.om-panel-empty').textContent = empty ? t('om_empty') : '';
        panel.querySelector('.om-panel-empty').style.display = empty ? '' : 'none';
        if (!empty && activeId) select.value = activeId;

        var align = state.manager.isAlignMode();
        panel.querySelector('.om-panel-align').checked = align;
        panel.querySelector('.om-panel-align').disabled = empty;
        panel.querySelector('.om-panel-hint').textContent = align ? t('om_align_hint') : t('om_locked_hint');
        panel.classList.toggle('is-align', align);
        paintValues();
    }

    function paintValues() {
        var panel = state.panel;
        if (!panel || !state.manager) return;
        var id = state.manager.getActiveId();
        var current = id ? state.manager.state(id) : null;
        if (!current) return;
        panel.querySelector('.om-v-opacity').textContent = Math.round(current.opacity * 100) + '%';
        panel.querySelector('.om-v-rotation').textContent = Math.round(current.rotation) + '°';
        panel.querySelector('.om-r-opacity').value = String(Math.round(current.opacity * 100));
        panel.querySelector('.om-r-rotation').value = String(current.rotation);
        panel.querySelector('.om-r-scale').value = String(sliderFromMpp(current.mpp));
        var width = state.manager.groundWidth(id);
        var height = state.manager.groundHeight(id);
        panel.querySelector('.om-v-scale').textContent = formatMeters(width) + ' × ' + formatMeters(height);
    }

    function formatMeters(meters) {
        var value = Number(meters) || 0;
        if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 2) + ' km';
        if (value >= 1) return value.toFixed(value >= 100 ? 0 : 1) + ' m';
        return value.toFixed(2) + ' m';
    }

    /* ── enable / disable ─────────────────────────────────────────────── */
    function setEnabled(on) {
        if (!state.map) return false;      // the live map is not built yet
        state.enabled = !!on;
        var toggle = document.getElementById('otherMapsToggle');
        if (toggle) toggle.checked = state.enabled;
        var row = document.getElementById('otherMapsRow');
        if (row) row.style.opacity = state.enabled ? '1' : '0.45';

        if (state.enabled) {
            var parent = document.getElementById('histPremiumToggle');
            if (parent && !parent.checked) {
                parent.checked = true;
                if (typeof root.toggleHistPremiumLayer === 'function') root.toggleHistPremiumLayer(true);
            }
            loadCatalog().then(function () {
                if (!state.enabled) return;
                ensureCanvas();
                if (state.manager) {
                    state.manager.setVisible(true);
                    restoreOverlays();
                }
                onMapMoved();
                redraw();
            }).catch(function () {
                state.enabled = false;
                if (toggle) toggle.checked = false;
            });
        } else {
            if (state.manager) {
                state.manager.setAlignMode(false);
                state.manager.setVisible(false);
            }
            if (state.ctx && state.canvas) state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
            state.hits = [];
            hidePanel();
        }
        writeStore();
        return state.enabled;
    }

    function restoreOverlays() {
        if (!state.manager) return;
        var stored = readStore();
        if (!stored || !Array.isArray(stored.overlays) || !stored.overlays.length) return;
        stored.overlays.forEach(function (saved) {
            var record = findRecord(saved.id);
            if (!record) return;
            state.manager.add(record, saved).then(function (ov) {
                if (ov && saved.id === stored.activeId) state.manager.setActive(saved.id);
                writeStore();
            }).catch(function () { /* a sheet that no longer resolves is skipped */ });
        });
    }

    function setOpacity(value) {
        var pct = Math.max(0, Math.min(100, Number(value)));
        state.opacity = pct / 100;
        var pctLabel = document.getElementById('otherMapsPct');
        if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';
        // The dots follow the slider; every overlay added from here on starts
        // at the same opacity.
        redraw();
        if (state.manager && state.manager.getActiveId()) {
            state.manager.setOpacity(state.manager.getActiveId(), state.opacity);
            paintValues();
        }
        writeStore();
        return state.opacity;
    }

    /* ── wiring ───────────────────────────────────────────────────────── */
    function attach(map) {
        if (state.map) return state;
        state.map = map;
        state.lang = detectLang();
        map.createPane(OVERLAY_PANE).style.zIndex = '611';
        state.manager = Overlays.createManager(map, {
            pane: OVERLAY_PANE,
            zIndex: 611,
            opacity: state.opacity,
            onAlignChange: function () { paintPanel(); },
            onActiveChange: function () { paintPanel(); }
        });
        state.manager.onStateChange(function () {
            writeStore();
            if (state.panel) paintPanel();
        });

        var stored = readStore();
        if (stored && isFinite(stored.opacity)) state.opacity = Number(stored.opacity);

        map.on('move', onMapMoved);
        map.on('moveend', onMapMoved);
        map.on('zoomend', onMapMoved);
        map.on('viewreset', onMapMoved);
        map.on('resize', onMapMoved);
        map.on('click', onMapClick);
        /* Zoom animations: button / double-tap / wheel come in as zoomanim,
         * touch pinch as 'zoom' with e.pinch — the same split the Patrimoniu
         * canvases in map-app.js use.  onMapMoved (move/zoomend) redraws and
         * resets the transform once the view has settled. */
        map.on('zoomanim', function (e) {
            if (e && e.center != null && e.zoom != null) applyZoomTransform(e.center, e.zoom);
        });
        map.on('zoom', function (e) {
            if (e && e.pinch) applyZoomTransform(state.map.getCenter(), state.map.getZoom());
        });

        root.toggleOtherMaps = function (on) { return setEnabled(on); };
        root.setOtherMapsOpacity = function (value) { return setOpacity(value); };

        if (stored && stored.enabled) setEnabled(true);
        return state;
    }

    /* ── auto-attach ────────────────────────────────────────────────────
     * map-app.js publishes the live map as window._dlMap while it runs, and
     * this file is loaded right after it — but the map object can also be
     * built a tick later, so the boot retries for a few seconds. */
    function tryAttach() {
        var map = root._dlMap || root.map || null;
        if (map && typeof map.getContainer === 'function') { attach(map); return true; }
        return false;
    }

    function boot() {
        if (tryAttach()) return;
        var tries = 0;
        var timer = root.setInterval(function () {
            if (tryAttach() || ++tries > 40) root.clearInterval(timer);
        }, 250);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    /* The panel row talks to the module through these two names. They exist
     * from the moment the file is parsed: a slider dragged before the map is
     * built must not throw just because attach() has not run yet. */
    root.toggleOtherMaps = function (on) { return setEnabled(on); };
    root.setOtherMapsOpacity = function (value) { return setOpacity(value); };

    root.DetectLabOtherMaps = {
        attach: attach,
        setEnabled: setEnabled,
        isEnabled: function () { return state.enabled; },
        setOpacity: setOpacity,
        getOpacity: function () { return state.opacity; },
        records: function () { return state.records.slice(); },
        catalog: function () { return state.catalog; },
        redraw: onMapMoved,
        showPanel: showPanel,
        hidePanel: hidePanel,
        strings: STRINGS,
        t: t,
        isLocationCluster: isLocationCluster,
        clusterSpreadMeters: clusterSpreadMeters,
        groupByPlace: groupByPlace,
        formatMeters: formatMeters,
        sliderFromMppLimits: function (mpp, limits) {
            var ratio = (Math.max(limits.mppMin, Math.min(limits.mppMax, mpp)) - limits.mppMin) /
                (limits.mppMax - limits.mppMin);
            return Math.round(Math.max(0, Math.min(1, ratio)) * 1000);
        },
        state: state
    };
}(typeof window !== 'undefined' ? window : this));
