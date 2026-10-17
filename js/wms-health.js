/* ══════════════════════════════════════════════════════════════
   DetectLab — availability guard for third-party map services
   ──────────────────────────────────────────────────────────────
   The historical maps (js/map-app.js premium rows and the
   js/historical-eu-maps.js catalogue) are streamed as WMS GetMap tiles from
   https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms — and that server is not
   the only third-party raster service this app leans on.

   When such a server cannot render a layer it very often still answers
   **HTTP 200** — the body is plain text / XML / JSON instead of an image, so
   the browser cannot decode a single tile: the layer stays empty, DevTools
   shows hundreds of “200 OK” image requests whose Preview pane says “Nothing
   to preview”, and the app gives the user no explanation at all.

   That is exactly what happened on 2026-10-13 with CENAGIS / IH PAN: every
   GetMap for the ECW mosaics came back with

       java.lang.RuntimeException: Unable to create a valid ImageInputStream
       for the provided input:
       /opt/geoserver/data_dir/cartomatic/UKvME/mosaick/ukvme_3857_transparent.ecw

   (the same for kdr, chrzanowski, reymann, m25k, gdansk… — i.e. the whole
   raster catalogue; only the server operator can fix it). The same failure
   mode exists on every other WMS/WMTS host in the app: a GeoServer that lost
   its data directory, an ArcGIS ImageServer with a stale mosaic, a
   token-less Dataforsyningen, a GUGiK/IGN/swisstopo cache reindexing.

   This module turns that silent failure into a bounded, visible one:

     • a watched layer probes ONE GetMap URL before it is added — the exact
       URL Leaflet would request for the first visible tile;
     • a non-image answer (or a timeout) marks that layer down for a cooldown,
       so re-toggling it inside the cooldown makes no request at all;
     • hosts configured as “watch” keep their probe-free behaviour: they are
       added, and only a run of failed tiles (a mid-session outage) trips them;
     • the layer's row is marked unavailable, its switch is switched back off
       (remembered, so Retry only re-enables what the guard turned off) and a
       dismissible notice names the **provider that is actually failing**;
     • tiles that start failing after the layer was accepted trip the same
       path (a mid-session outage);
     • “Retry” clears the verdicts and flips those switches back on, which
       runs the app's own toggle handlers again;
     • when the user is offline nothing is blamed on the server and no
       cooldown is remembered;
     • a layer that is unavailable for a *configuration* reason — the
       Dataforsyningen token is missing from this deployment, for instance —
       reports through the same row/notice path with its own message
       (DetectLabWmsHealth.markUnavailable()).

   Which UI element belongs to which layer comes from the shared registry
   (js/layer-registry.js `ui.toggle` / `ui.select`), so a new layer only has
   to be defined once; layers that carry `_detectlabUiKeys` /
   `_detectlabUiTitle` keep working exactly as before.

   See CENAGIS_WMS_HEALTH.md for the failure write-up and
   WMS_WMTS_LAYER_AUDIT.md for the per-layer audit this list comes from.
   ══════════════════════════════════════════════════════════════ */
(function (window, document) {
    'use strict';
    if (!window || !document) return;

    /* ── Hosts whose failures are worth reporting this way ───────────────
       host → the provider name shown to the user. Every host here is a
       third-party raster service the app requests through the WMS/ArcGIS
       GetMap path, i.e. a service that can answer “200 OK + an error body”
       where a tile was expected. Each entry was checked against the layer
       audit (node tools/audit-wms-layers.mjs --urls). */
    var HOSTS = {
        'pastmaps.cenagis.edu.pl': 'CENAGIS / IH PAN',
        'services.geo-spatial.org': 'geo-spatial.org (eHarta)',
        'data.geopf.fr': 'IGN France / Géoplateforme',
        'copernicus.discomap.eea.europa.eu': 'Copernicus Land / EEA discomap',
        'image.discomap.eea.europa.eu': 'Copernicus Land / EEA discomap',
        'wms-mapa-lidar.idee.es': 'IGN España / IDEE',
        'mapy.geoportal.gov.pl': 'GUGiK / geoportal.gov.pl',
        'geoserve.cast.uark.edu': 'CAST / University of Arkansas (CORONA)',
        'wmts.geo.admin.ch': 'swisstopo',
        'environment.data.gov.uk': 'Environment Agency (England)',
        'hoydedata.no': 'Kartverket (høydedata.no)',
        'ahn.arcgisonline.nl': 'AHN / Esri Nederland',
        'phenology.hrvpp2.vgt.vito.be': 'VITO / Copernicus HR-VPP',
        /* The Danish protected-nature overlay (js/danish-layers.config.js) reads
         * this GeoServer directly: it is public, tokenless and its raster tiles
         * need no CORS. Listed here so the provider is named if it stops
         * answering, per the rule that every third-party endpoint of the
         * registry appears in this map. The layer itself opts out of the guard
         * with _detectlabNoGuard (js/danish-layers.js owns its row: a status
         * line under the switch instead of a flipped switch). */
        'arealeditering-dist-geo.miljoeportal.dk': 'Danmarks Miljøportal',
        /* The Albanian ASIG layers (js/asig-albania-layers.config.js) read
         * this state GeoServer directly: it is public, tokenless and its
         * raster tiles need no CORS. Listed here so the provider is named if
         * it stops answering, per the rule that every third-party endpoint of
         * the registry appears in this map. The layers themselves opt out of
         * the guard with _detectlabNoGuard (js/asig-albania-layers.js owns
         * its rows: per-tile EPSG:4326 fallback after repeated tile errors
         * and a status line under the switch instead of a flipped switch). */
        'geoportal.asig.gov.al': 'ASIG / geoportal.asig.gov.al',
        /* The Finnish layers (js/finland-layers.config.js) read these hosts
         * directly — the SYKE GeoServer and the Åland ArcGIS server answer
         * plain <img> tiles that need no CORS, and karttamoottori serves the
         * hillshade <img> mosaics. Listed here so the provider is named if
         * one stops answering, per the rule that every third-party endpoint
         * of the registry appears in this map. The layers themselves opt out
         * of the guard with _detectlabNoGuard (js/finland-layers.js owns its
         * rows: direct→proxy fallback after repeated failures, a transparent
         * pixel per failed tile and a status line with Retry under the
         * switch instead of a flipped switch). */
        'paikkatiedot.ymparisto.fi': 'SYKE / paikkatiedot.ymparisto.fi',
        'kartor.regeringen.ax': 'Ålands landskapsregering (kartor.regeringen.ax)',
        'karttamoottori.maanmittauslaitos.fi': 'Maanmittauslaitos (karttamoottori)',
        'kartta.museoverkko.fi': 'Museovirasto (museoverkko)',
        'hkp.maanmittauslaitos.fi': 'Maanmittauslaitos (kiinteistötietojen karttapalvelu)'
    };

    /* A re-pointed CENAGIS catalogue (window.DETECTLAB_CENAGIS_WMS, read by
       js/layer-registry.js) is guarded exactly like the original service: a
       mirror is a third-party raster server too, and it must not be able to
       fail silently just because nobody added its hostname here. */
    (function () {
        try {
            var mirror = window.DETECTLAB_CENAGIS_WMS;
            var host = mirror && String(mirror).match(/^https?:\/\/([^\/?#]+)/i);
            if (host && !HOSTS[host[1].toLowerCase()]) HOSTS[host[1].toLowerCase()] = 'CENAGIS / IH PAN (mirror)';
        } catch (e) {}
    })();

    /* Hosts that must never pay for a probe and must never have their switch
       flipped by the guard: services that publish dozens of layers per
       product (CORONA adds one tile layer per pass), where a single failed
       product does not mean the row is dead. They are still watched for
       tile errors, so a real outage is explained instead of left blank. */
    var WATCH_ONLY_HOSTS = ['geoserve.cast.uark.edu'];

    var COOLDOWN_MS = 60000;        // a down verdict is trusted this long
    var PROBE_TIMEOUT_MS = 9000;    // no answer → treated as unavailable
    var MIN_TILE_FAILURES = 3;      // tile failures that trip a healthy layer…
    var HARD_TILE_FAILURES = 8;     // …and the count that trips even with hits
    var NOTICE_ID = 'detectlabWmsNotice';

    var verdicts = {};   // '<host>|<layers>' → { state:'ok'|'down', at, reason }
    var blocked = {};    // ui key → true when the guard switched it off
    var peers = [];      // guarded layers, for Retry
    var noticeShown = false;

    function lang() {
        try {
            if (typeof window._currentLang === 'function') return window._currentLang() || 'ro';
            return (document.documentElement && document.documentElement.lang) || 'ro';
        } catch (e) { return 'ro'; }
    }
    function ro() { return lang() === 'ro'; }

    function hostOf(url) {
        var m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
        return m ? m[1].toLowerCase() : '';
    }
    function isGuardedUrl(url) {
        return Object.prototype.hasOwnProperty.call(HOSTS, hostOf(url));
    }
    /* Provider shown to the user for a URL; calls without a known host fall
       back to the hostname itself so the notice is never vague. */
    function providerFor(url, fallback) {
        var host = hostOf(url);
        if (Object.prototype.hasOwnProperty.call(HOSTS, host)) return HOSTS[host];
        return fallback || host || '';
    }
    function modeForUrl(url) {
        return WATCH_ONLY_HOSTS.indexOf(hostOf(url)) !== -1 ? 'watch' : 'probe';
    }

    /* One verdict per host + layer name: layers of the same server fail and
       recover independently (the rasters of a GeoServer are not its vectors). */
    function verdictKey(layer) {
        var host = hostOf(layer && layer._url);
        var name = (layer && layer.options && layer.options.layers) || '-';
        return host + '|' + name;
    }

    /* ── Which panel row does a layer belong to? ─────────────────────────
       Preferred source: the shared registry definition (matched by the id the
       app tagged it with, or by endpoint + LAYERS). It carries the panel
       element (`ui.toggle` / `ui.select`), the localized title and, when the
       app keeps the layer on `window`, the variable that holds it. */
    function registry() {
        try { return window.DetectLabLayers || null; } catch (e) { return null; }
    }

    function defForLayer(layer) {
        var R = registry();
        if (!R || !layer) return null;
        try {
            if (layer._dlDefId && typeof R.get === 'function') {
                var byId = R.get(layer._dlDefId);
                if (byId) return byId;
            }
            if (typeof R.matchDef !== 'function') return null;
            var options = layer.options || {};
            return R.matchDef({
                url: layer._url,
                layers: options.layers || (layer.wmsParams && layer.wmsParams.layers),
                version: options.version || (layer.wmsParams && layer.wmsParams.version)
            });
        } catch (e) { return null; }
    }

    function defTitle(def) {
        if (!def || !def.title) return '';
        var l = lang();
        return def.title[l] || def.title.en || def.title.ro || '';
    }

    /* The element a row starts at: the switch itself when the registry names
       one, else the map's own element. */
    function rowAncestor(el) {
        var node = el;
        var guard = 0;
        while (node && node !== document.body && guard++ < 8) {
            var id = node.id || '';
            var cls = (typeof node.className === 'string' ? node.className : '') || '';
            if (/row$/i.test(id) || /(^|\s)(lidar-country-row|cenagis-map-row|premium-map-row|transp-row)(\s|$)/.test(cls)
                    || node.getAttribute && node.getAttribute('data-map-id')) {
                return node;
            }
            node = node.parentElement;
        }
        return el;
    }

    /* Panel keys a layer belongs to. Callers set `_detectlabUiKeys`; without
       it we fall back to the layer name (“ukvme_3857” → “ukvme”), which is
       the catalogue key js/historical-eu-maps.js uses. */
    function keysFor(layer) {
        if (layer && layer._detectlabUiKeys && layer._detectlabUiKeys.length) {
            return layer._detectlabUiKeys.slice();
        }
        var name = (layer && layer.options && layer.options.layers) || '';
        name = String(name).split(':').pop();
        return name ? [name.replace(/_(3857|4326|2180|transparent)$/g, '')] : [];
    }

    /* The app names the rows/switches of the premium panel
       (#mitteleuropaMapToggle / #mitteleuropaRow) and the country catalogue
       (.cenagis-toggle / .cenagis-map-row[data-map-id]); the guard accepts
       either shape so it does not need to know which panel it is in. */
    function toggleEls(key) {
        var out = [];
        var byId = document.getElementById(key + 'MapToggle');
        if (byId) out.push(byId);
        var list = document.querySelectorAll('.cenagis-toggle[data-map-key="' + key + '"]');
        for (var i = 0; i < list.length; i++) out.push(list[i]);
        return out;
    }
    function rowEls(key) {
        var out = [];
        var byId = document.getElementById(key + 'Row') || document.getElementById(key + 'row');
        if (byId) out.push(byId);
        var list = document.querySelectorAll('.cenagis-map-row[data-map-id="' + key + '"]');
        for (var i = 0; i < list.length; i++) out.push(list[i]);
        return out;
    }

    /* ── Targets: the UI a tripped layer should mark ─────────────────────
       One entry per row the layer belongs to:
         { key, name, provider, toggles:[], rows:[], selects:[], restore:fn }
       `restore` replays whatever the app does when the user switches the row
       back on (a checkbox `change`, or the select that drives the layer). */
    function targetsFor(layer, opts) {
        opts = opts || {};
        var provider = opts.provider || providerFor(layer && layer._url);
        var out = [];
        var def = opts.def !== undefined ? opts.def : defForLayer(layer);
        var ui = (def && def.ui) || null;

        if (ui && (ui.toggle || ui.select || ui.selector)) {
            var toggle = null;
            if (ui.toggle) toggle = document.getElementById(ui.toggle);
            else if (ui.selector) toggle = document.querySelector(ui.selector);
            var select = ui.select ? document.getElementById(ui.select) : null;
            var rows = [];
            if (toggle) rows.push(rowAncestor(toggle));
            else if (def.cenagisKey) {
                rows = rowEls(def.cenagisKey);
                toggle = toggleEls(def.cenagisKey)[0] || null;
            } else {
                var legacyKeys = keysFor(layer);
                for (var i = 0; i < legacyKeys.length; i++) {
                    var r = rowEls(legacyKeys[i])[0];
                    if (r) rows.push(r);
                    if (!toggle) toggle = toggleEls(legacyKeys[i])[0] || null;
                }
            }
            out.push({
                key: def.id,
                name: defTitle(def) || (opts.title || ''),
                provider: provider,
                toggles: toggle ? [toggle] : [],
                rows: rows,
                selects: select ? [select] : []
            });
            return out;
        }

        var keys = (opts.keys && opts.keys.length) ? opts.keys.slice() : keysFor(layer);
        for (var k = 0; k < keys.length; k++) {
            out.push({
                key: keys[k],
                name: opts.title || '',
                provider: provider,
                toggles: toggleEls(keys[k]),
                rows: rowEls(keys[k]),
                selects: []
            });
        }
        return out;
    }

    function fireChange(el) {
        try {
            if (!el) return;
            if (typeof el.onchange === 'function') { el.onchange.call(el, { target: el }); return; }
            if (typeof window.Event === 'function') {
                el.dispatchEvent(new window.Event('change', { bubbles: true }));
            } else if (document.createEvent) {
                var ev = document.createEvent('HTMLEvents');
                ev.initEvent('change', true, false);
                el.dispatchEvent(ev);
            }
        } catch (e) { /* the switch stays as set */ }
    }

    function markRows(rows, down, title) {
        (rows || []).forEach(function (row) {
            if (!row) return;
            if (down) {
                row.setAttribute('data-wms-state', 'down');
                row.style.opacity = '0.55';
                if (title) row.setAttribute('title', title);
            } else {
                row.removeAttribute('data-wms-state');
                row.style.opacity = '';
                row.removeAttribute('title');
            }
        });
    }

    /* ── One-tile probe ───────────────────────────────────────────────
       Builds the GetMap URL Leaflet would request for the tile under the
       current view centre, so the probe asks the server exactly what the
       first visible tile would ask. Mirrors L.TileLayer.WMS.getTileUrl()
       (1.9.4): the bbox comes from the NW/SE corners of a 256 px tile and
       the projection parameter is `srs` for 1.1.1 / `crs` for 1.3.0. */
    function sampleUrl(layer, map) {
        var L = window.L;
        if (!L || !map || !layer || typeof map.project !== 'function') return null;
        var opts = layer.options || {};
        var params = layer.wmsParams || {};
        var url = String(layer._url || '');
        if (!url) return null;
        var version = parseFloat(params.version || 1.1);
        var tileSize = 256;
        try { if (typeof layer.getTileSize === 'function') tileSize = layer.getTileSize().x || 256; } catch (e) {}
        var crs = opts.crs || (map.options && map.options.crs) || L.CRS.EPSG3857;
        var zoom = Math.round(typeof map.getZoom === 'function' ? map.getZoom() : 3);
        if (typeof opts.maxZoom === 'number' && zoom > opts.maxZoom) zoom = opts.maxZoom;
        if (typeof opts.minZoom === 'number' && zoom < opts.minZoom) zoom = opts.minZoom;
        // Probe the tile under the view centre — the one the user is actually
        // looking at. If the centre falls outside the layer's own bounds (a
        // sheet that covers a corner of the current view only), probe the
        // middle of its coverage instead: the visible tile may legitimately
        // lie outside `bounds`, and Leaflet would not request it at all.
        var target = map.getCenter();
        if (opts.bounds && typeof opts.bounds.contains === 'function' && typeof opts.bounds.getCenter === 'function'
                && !opts.bounds.contains(target)) {
            target = opts.bounds.getCenter();
        }
        var centre = map.project(target, zoom);
        var nwPixel = centre.divideBy(tileSize).floor().multiplyBy(tileSize);
        var sePixel = nwPixel.add([tileSize, tileSize]);
        var nw = map.unproject(nwPixel, zoom);
        var se = map.unproject(sePixel, zoom);
        var b = L.bounds(crs.project(nw), crs.project(se));
        var min = b.min, max = b.max;
        var bbox = (version >= 1.3 && crs === L.CRS.EPSG4326)
            ? [min.y, min.x, max.y, max.x]
            : [min.x, min.y, max.x, max.y];
        var out = {};
        for (var k in params) out[k] = params[k];
        out.width = tileSize;
        out.height = tileSize;
        if (version >= 1.3) out.crs = crs.code; else out.srs = crs.code;
        return url + L.Util.getParamString(out, url, opts.uppercase)
            + (opts.uppercase ? '&BBOX=' : '&bbox=') + bbox.join(',');
    }

    /* ── Probe URL for a layer the WMS factory never built ───────────────
       The country modules own their URL builders, and the registry names
       them (`def.builder`), so the very same call the map makes for a tile
       can be made once as a probe: e.g. AhnLidar.exportImageUrl(mode, bbox,
       256), GeoportalNMT.tileUrl(mode, bbox, 256), SwisstopoRelief.tileUrl(
       mode, z, x, y). The tile is chosen under the view centre, or under the
       layer's own coverage centre when the view is somewhere else entirely
       (the same rule the WMS sampler uses). Layers whose module already
       reports its own failures (the token-gated ones) opt out with
       `def.guard === 'watch'`. */
    function probeUrlFor(layer, map) {
        if (layer && layer.wmsParams) return sampleUrl(layer, map);   // WMS: exact Leaflet URL
        var L = window.L;
        var R = registry();
        if (!L || !R || !map || !layer || typeof map.project !== 'function') return null;
        var def = defForLayer(layer);
        if (!def || !def.builder || def.guard === 'watch') return null;
        var tileSize = 256;
        var minimum = 0, maximum = 22, zoomish = 12;
        try {
            zoomish = Math.round(typeof map.getZoom === 'function' ? map.getZoom() : 12);
            if (def.maxNativeZoom != null) maximum = def.maxNativeZoom;
            else if (def.maxZoom != null) maximum = def.maxZoom;
            if (def.minZoom != null) minimum = def.minZoom;
            if (zoomish > maximum) zoomish = maximum;
            if (zoomish < minimum) zoomish = minimum;
        } catch (e) {}
        var target = map.getCenter();
        var opts = layer.options || {};
        var bounds = def.bounds || opts.bounds;
        if (bounds && typeof bounds.contains === 'function' && typeof bounds.getCenter === 'function'
                && !bounds.contains(target)) {
            target = bounds.getCenter();
        }
        var coords;
        try {
            coords = map.project(target, zoomish).divideBy(tileSize).floor();
            var url = R.tileUrlAt(def, zoomish, coords.x, coords.y);
            return url ? String(url) : null;
        } catch (e) { return null; }
    }

    function probe(url) {
        return new Promise(function (resolve) {
            if (typeof window.Image !== 'function') { resolve(true); return; }   // fail open
            var img = new window.Image();
            var settled = false;
            var timer = window.setTimeout(function () { finish(false); }, PROBE_TIMEOUT_MS);
            function finish(ok) {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                resolve(ok);
            }
            img.onload = function () {
                // A decoded image with no intrinsic size is not a map tile
                // either — same failure, reported the same way.
                finish((img.naturalWidth || img.width || 0) > 0 && (img.naturalHeight || 0) > 0);
            };
            img.onerror = function () { finish(false); };
            img.src = url;
        });
    }

    function setVerdict(key, state, reason) {
        verdicts[key] = { state: state, at: Date.now(), reason: reason || '' };
    }
    function isDown(layer) {
        var v = verdicts[verdictKey(layer)];
        return !!(v && v.state === 'down' && (Date.now() - v.at) < COOLDOWN_MS);
    }

    function removeQuietly(layer) {
        var map = layer && layer._map;
        if (!map || typeof map.removeLayer !== 'function') return;
        try { if (map.hasLayer(layer)) map.removeLayer(layer); } catch (e) {}
    }

    function detachTileWatcher(layer, state) {
        try {
            if (state.onTileLoad) layer.off('tileload', state.onTileLoad);
            if (state.onTileError) layer.off('tileerror', state.onTileError);
        } catch (e) {}
    }

    /* One failed tile fetch. `MIN_TILE_FAILURES` failures with no success at
       all, or `HARD_TILE_FAILURES` in a row, mean the service stopped serving
       this layer: the layer is removed and the notice explains it. Both the
       Leaflet `tileerror` watcher below and the country modules that swallow
       the error themselves (js/ahn-layer.js, js/hoydedata-layer.js paint a
       transparent tile instead of firing `tileerror` — they call
       DetectLabWmsHealth.noteFailure) feed this same counter. */
    function countTileFailure(layer, state) {
        state.fails = (state.fails || 0) + 1;
        if (!((state.fails >= MIN_TILE_FAILURES && !state.oks) || state.fails >= HARD_TILE_FAILURES)) return;
        if (!state.watching) return;
        state.watching = false;
        detachTileWatcher(layer, state);
        var offline = navigator && navigator.onLine === false;
        if (!offline) setVerdict(verdictKey(layer), 'down', 'tiles');
        removeQuietly(layer);
        trip(layer, offline ? 'offline' : 'tiles', state.opts || {});
    }

    /* Tiles of an accepted layer: a mid-session outage trips the same path. */
    function watchTiles(layer, state) {
        if (state.watching) return;
        state.watching = true;
        state.fails = 0;
        state.oks = 0;
        state.onTileLoad = function () { state.oks++; state.fails = 0; };
        state.onTileError = function () { countTileFailure(layer, state); };
        layer.on('tileload', state.onTileLoad);
        layer.on('tileerror', state.onTileError);
    }

    /* Public: “this layer just failed to fetch a tile” for layers whose own
       createTile() hides the error from Leaflet. Returns false when the layer
       is not watched (or was already caught), so a caller can leave its own
       fallback in place. */
    function noteFailure(layer) {
        var state = layer && layer._detectlabGuardState;
        if (!state || !state.watching) return false;
        countTileFailure(layer, state);
        return true;
    }

    /* The layer is not served: switch it off, mark its row and say why. */
    function trip(layer, reason, opts) {
        opts = opts || {};
        var targets = targetsFor(layer, opts);
        var names = [];
        var provider = '';
        targets.forEach(function (t) {
            if (t.name) names.push(t.name);
            if (t.provider) provider = t.provider;
            if (opts.switchOff !== false) {
                t.toggles.forEach(function (el) {
                    if (el.checked) { el.checked = false; blocked[t.key] = true; }
                });
            }
            var title = reason === 'offline'
                ? (ro() ? 'Ești offline' : 'You are offline')
                : (ro() ? 'Serverul ' + (t.provider || 'furnizorului') + ' nu poate livra această hartă acum'
                    : 'The ' + (t.provider || 'provider') + ' server cannot serve this map right now');
            markRows(t.rows, true, title);
        });
        if (!names.length) names = layerNames(layer, keysFor(layer));
        showNotice(names, reason, provider);
    }

    /* Human name for a key: the layer's own title, the registry title, the
       first leaf element of its row with visible text (the premium rows use
       <span data-key>, the country catalogue rows a plain <div>), or the key
       itself as the last resort. */
    function nameFor(layer, key) {
        var keys = keysFor(layer);
        if (layer && layer._detectlabUiTitle && keys.length === 1 && keys[0] === key) {
            return layer._detectlabUiTitle;
        }
        var def = defForLayer(layer);
        if (def && (!key || def.id === key)) {
            var title = defTitle(def);
            if (title) return title;
        }
        var row = rowEls(key)[0];
        if (row) {
            var el = row.querySelector('[data-key]');
            if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
            var cands = row.querySelectorAll('div, span');
            for (var i = 0; i < cands.length; i++) {
                if (cands[i].querySelector('div, span, input, svg')) continue;
                var t = cands[i].textContent ? cands[i].textContent.trim() : '';
                if (t) return t;
            }
        }
        return key;
    }

    function layerNames(layer, keys) {
        return (keys || []).map(function (key) { return nameFor(layer, key); });
    }

    function el(tag, id, cssText) {
        var node = document.createElement(tag);
        node.id = id;
        if (cssText) node.style.cssText = cssText;
        return node;
    }

    /* ── The notice ─────────────────────────────────────────────────── */
    /* Built node by node (no innerHTML) so the markup is explicit, the CSP
       story stays clean and the harness can drive it without a DOM parser. */
    var noticeNodes = null;
    function showNotice(names, reason, provider, customMessage) {
        var box = document.getElementById(NOTICE_ID);
        if (!box) {
            box = el('div', NOTICE_ID, 'position:fixed;left:14px;bottom:14px;z-index:10800;'
                + 'max-width:min(380px,calc(100vw - 28px));background:rgba(8,10,22,0.94);'
                + 'border:1px solid rgba(255,200,50,0.45);border-radius:10px;padding:10px 12px;'
                + 'color:#f5f0eb;font:400 12.5px/1.45 system-ui,sans-serif;'
                + 'box-shadow:0 8px 24px rgba(0,0,0,0.45);display:none');
            box.setAttribute('role', 'status');
            box.setAttribute('aria-live', 'polite');

            var title = el('div', NOTICE_ID + 'Title', 'font-weight:700;color:#ffc832;margin-bottom:4px');
            var body = el('div', NOTICE_ID + 'Body');
            var row = el('div', NOTICE_ID + 'Actions', 'display:flex;gap:8px;margin-top:8px');
            var retryBtn = el('button', NOTICE_ID + 'Retry', 'flex:1;border-radius:6px;'
                + 'border:1px solid rgba(255,200,50,0.5);background:rgba(255,200,50,0.14);color:#ffc832;'
                + 'font:600 12px system-ui,sans-serif;padding:6px 10px;cursor:pointer');
            retryBtn.type = 'button';
            var closeBtn = el('button', NOTICE_ID + 'Close', 'border-radius:6px;'
                + 'border:1px solid rgba(245,240,235,0.25);background:none;color:#f5f0eb;'
                + 'font:600 12px system-ui,sans-serif;padding:6px 10px;cursor:pointer');
            closeBtn.type = 'button';
            row.appendChild(retryBtn);
            row.appendChild(closeBtn);
            box.appendChild(title);
            box.appendChild(body);
            box.appendChild(row);
            document.body.appendChild(box);
            retryBtn.addEventListener('click', function () { retry(); });
            closeBtn.addEventListener('click', function () { box.style.display = 'none'; });
            noticeNodes = { box: box, title: title, body: body, retry: retryBtn, close: closeBtn };
        }

        var offline = reason === 'offline';
        var who = provider || 'CENAGIS / IH PAN';
        noticeNodes.title.textContent = offline
            ? (ro() ? 'Ești offline' : 'You are offline')
            : (customMessage ? (ro() ? 'Hartă indisponibilă' : 'Map unavailable')
                : (ro() ? 'Harta nu poate fi încărcată' : 'This map cannot be loaded'));
        var list = (names || []).filter(function (n, i) { return n && (names || []).indexOf(n) === i; })
            .slice(0, 3).join(', ');
        noticeNodes.body.textContent = customMessage
            ? customMessage
            : offline
                ? (ro()
                    ? 'Conexiunea la internet pare întreruptă, deci „' + list + '” nu poate fi descărcată acum. Reîncearcă după ce revii online.'
                    : 'Your internet connection appears to be down, so “' + list + '” cannot be downloaded right now. Retry once you are back online.')
                : (ro()
                    ? 'Serverul de hărți al furnizorului (' + who + ') răspunde cu o eroare în loc de imagine, deci „' + list
                        + '” nu se poate afișa. Este o problemă la sursă, nu la conexiunea sau browserul tău — restul hărții funcționează normal.'
                    : 'The map provider’s server (' + who + ') answers with an error instead of an image, so “' + list
                        + '” cannot be displayed. This is a problem at the source, not your connection or browser — the rest of the map keeps working.');
        noticeNodes.retry.textContent = ro() ? 'Reîncearcă' : 'Retry';
        noticeNodes.close.textContent = ro() ? 'Închide' : 'Close';
        noticeNodes.box.style.display = 'block';
        noticeShown = true;
    }

    /* ── Guarding a layer ───────────────────────────────────────────
       Layer.onAdd() is delayed by one probe (and skipped entirely when the
       layer is known to be down), so a broken service never receives more
       than that single request. onRemove() stays consistent: while a probe
       is pending the original onAdd has not run, so the original onRemove
       is skipped too — Leaflet sees a balanced add/remove pair either way.
       `mode: 'watch'` skips the probe: the layer is added as before and only
       a run of failed tiles can trip it. */
    function guard(layer, opts) {
        opts = opts || {};
        if (!layer || layer._detectlabWmsGuard) return layer;
        var explicit = opts.explicit === true;
        if (!explicit && !isGuardedUrl(layer._url)) return layer;
        var mode = opts.mode || (layer._detectlabWatchOnly ? 'watch' : modeForUrl(layer._url));
        layer._detectlabWmsGuard = true;
        layer._detectlabGuardMode = mode;
        var originalAdd = layer.onAdd;
        var originalRemove = layer.onRemove;
        var state = { token: 0, pending: false, watching: false, opts: opts, fails: 0, oks: 0 };
        layer._detectlabGuardState = state;

        layer.onAdd = function (map) {
            var self = this;
            var token = ++state.token;
            if (isDown(self)) {
                state.pending = true;          // balanced by onRemove below
                removeQuietly(self);
                trip(self, 'cooldown', opts);
                return;
            }
            var sample = mode === 'watch' ? null : probeUrlFor(self, map);
            if (!sample) {                     // cannot ask (or not asked) → never block
                originalAdd.call(self, map);
                watchTiles(self, state);
                return;
            }
            state.pending = true;
            probe(sample).then(function (ok) {
                if (token !== state.token) return;       // removed while probing
                if (ok) {
                    state.pending = false;
                    setVerdict(verdictKey(self), 'ok', 'probe');
                    originalAdd.call(self, map);
                    watchTiles(self, state);
                    return;
                }
                var offline = navigator && navigator.onLine === false;
                if (!offline) setVerdict(verdictKey(self), 'down', 'probe');
                removeQuietly(self);                      // onRemove sees pending
                trip(self, offline ? 'offline' : 'probe', opts);
            });
        };

        layer.onRemove = function (map) {
            state.token++;                     // a pending probe no longer counts
            if (state.pending) {
                state.pending = false;         // original onAdd never ran
                return;
            }
            originalRemove.call(this, map);
        };

        peers.push(layer);
        return layer;
    }

    /* Explicit registration for layers the WMS factory never sees: WMTS /
       ArcGIS caches built by the country modules (js/swisstopo-relief-layer.js,
       js/ea-lidar-wmts-layer.js, js/dataforsyningen-dhm-layer.js, …) and any
       layer whose host is not in HOSTS but whose failures should still be
       bounded and explained. */
    function register(layer, opts) {
        opts = opts || {};
        if (!layer) return layer;
        if (opts.provider) layer._detectlabProvider = opts.provider;
        if (opts.keys) layer._detectlabUiKeys = opts.keys.slice();
        if (opts.title) layer._detectlabUiTitle = opts.title;
        if (opts.mode === 'watch') layer._detectlabWatchOnly = true;
        return guard(layer, { explicit: true, mode: opts.mode, keys: opts.keys, title: opts.title, provider: opts.provider });
    }

    /* A layer that cannot work for a configuration reason (not a server
       outage): mark its row, switch it off and say what is wrong — in its own
       words, without blaming a provider that never saw a request. */
    function markUnavailable(layer, message, opts) {
        opts = opts || {};
        var targets = targetsFor(layer, opts);
        targets.forEach(function (t) {
            if (opts.switchOff !== false) {
                t.toggles.forEach(function (el) {
                    if (el.checked) { el.checked = false; blocked[t.key] = true; }
                });
            }
            markRows(t.rows, true, message);
        });
        var names = targets.map(function (t) { return t.name; }).filter(Boolean);
        if (!names.length) names = layerNames(layer, keysFor(layer));
        showNotice(names, 'config', opts.provider || providerFor(layer && layer._url),
            message || (ro() ? 'Această hartă nu este configurată pe acest server.' : 'This map is not configured on this deployment.'));
        return targets;
    }

    /* Retry: forget the verdicts and switch back on exactly the rows the
       guard switched off (never a layer the user never asked for). Running
       the app's own change handler re-adds the layer through the guard. */
    function retry() {
        Object.keys(verdicts).forEach(function (k) { delete verdicts[k]; });
        var keys = Object.keys(blocked);
        Object.keys(blocked).forEach(function (k) { delete blocked[k]; });
        keys.forEach(function (key) {
            var rows = rowEls(key);
            var toggles = toggleEls(key);
            /* Registry-defined layers: the row is reached through its switch,
               which the app named in `ui.toggle` (country rows and selection
               dropdowns, whose ids do not follow the `<key>Row` convention). */
            peers.forEach(function (layer) {
                var targets = targetsFor(layer, { def: undefined });
                targets.forEach(function (t) {
                    if (t.key !== key) return;
                    rows = rows.concat(t.rows);
                    toggles = toggles.concat(t.toggles);
                    if (!toggles.length && t.selects.length) toggles = t.selects;
                });
            });
            markRows(rows, false);
            toggles.forEach(function (el) {
                if (!el.checked) { el.checked = true; fireChange(el); }
            });
        });
        var box = document.getElementById(NOTICE_ID);
        if (box) box.style.display = 'none';
        return keys;
    }

    /* ── Adopting the layers the WMS factory never sees ──────────────
       The country modules build their own TileLayer/GridLayer subclasses
       (Switzerland, England, Spain, Poland, Norway, the Netherlands, Denmark,
       Sweden, the vegetation WMTS), so no factory call tells the guard about
       them. The live map does: every add fires `layeradd`, and a layer whose
       endpoint — or whose registry definition — belongs to a watched host is
       adopted as watch-only. Already on the map means “it drew tiles before”,
       so a probe would be waste; the tile counters take over from there. */
    function adopt(layer) {
        if (!layer || layer._detectlabWmsGuard || layer._detectlabNoGuard) return null;
        var url = layer._url || (layer.options && (layer.options.url || layer.options.template)) || '';
        var guardedUrl = isGuardedUrl(url);
        /* The registry lookup costs a scan, so it only runs for the layers the
           URL test cannot classify: the country modules build their tile URL
           after the fact (ArcGIS exportImage / WMTS), so `_url` is empty. */
        var def = (!url || !guardedUrl) ? defForLayer(layer) : null;
        if (!guardedUrl && !(def && isGuardedUrl(def.url))) return null;
        if (def && def.guard === false) return null;
        return guard(layer, {
            explicit: true, mode: 'watch', def: def,
            provider: providerFor(url || (def && def.url))
        });
    }

    function installMapWatch() {
        var L = window.L;
        if (L && L.Map && L.Map.prototype && typeof L.Map.prototype.addLayer === 'function'
                && !L.Map.prototype.addLayer._detectlabWrapped) {
            /* Adoption happens *before* the add, so the very first time a
               country module puts a layer on the map it already goes through
               the guard (probe or watch), and not only on the second toggle. */
            var originalAddLayer = L.Map.prototype.addLayer;
            var wrappedAddLayer = function (layer) {
                try { adopt(layer); } catch (e) {}
                return originalAddLayer.call(this, layer);
            };
            wrappedAddLayer._detectlabWrapped = true;
            L.Map.prototype.addLayer = wrappedAddLayer;
        }
        var map = window._dlMap;
        if (map && typeof map.eachLayer === 'function') {
            try { map.eachLayer(function (l) { try { adopt(l); } catch (e) {} }); } catch (e) {}
        }
        return true;
    }

    /* ── Auto-guard every WMS layer of a listed host ──────────────────
       L.tileLayer.wms() is wrapped, so the CENAGIS catalogue, the premium
       rows, the eHarta historics, the Copernicus VHR mosaics, the French
       LiDAR HD WMS and the CORONA deck all go through guard() — the ones
       js/map-app.js, js/historical-eu-maps.js and js/corona-wms-layer.js
       create later included. Studio keys cannot travel inside the layer
       options (Leaflet copies every unknown option into the WMS query
       string), so the two modules attach `layer._detectlabUiKeys` right
       after creating each layer and everything else is resolved from the
       shared registry. */
    function wrapFactory() {
        var L = window.L;
        if (!L || !L.tileLayer || typeof L.tileLayer.wms !== 'function' || L.tileLayer.wms._detectlabWrapped) return;
        var original = L.tileLayer.wms;
        var wrapped = function (url, options) {
            var layer = original.call(this, url, options);
            return guard(layer);
        };
        wrapped._detectlabWrapped = true;
        L.tileLayer.wms = wrapped;
    }

    window.DetectLabWmsHealth = {
        HOSTS: HOSTS,
        WATCH_ONLY_HOSTS: WATCH_ONLY_HOSTS,
        COOLDOWN_MS: COOLDOWN_MS,
        guard: guard,
        register: register,
        markUnavailable: markUnavailable,
        retry: retry,
        isGuardedUrl: isGuardedUrl,
        noteFailure: noteFailure,
        providerFor: providerFor,
        adopt: adopt,
        installMapWatch: installMapWatch,
        isDownFor: function (layer) { return isDown(layer); },
        verdictFor: function (layer) { return verdicts[verdictKey(layer)] || null; },
        noticeShown: function () { return noticeShown; },
        defForLayer: defForLayer,
        targetsFor: targetsFor,
        sampleUrl: sampleUrl,
        probeUrlFor: probeUrlFor,
        _test: {
            verdicts: verdicts,
            blocked: blocked,
            peers: peers,
            keysFor: keysFor,
            nameFor: nameFor,
            toggleEls: toggleEls,
            rowEls: rowEls,
            probe: probe,
            trip: trip,
            noticeNodes: function () { return noticeNodes; },
            watchTiles: watchTiles,
            noteFailure: noteFailure,
            markRows: markRows,
            setVerdict: setVerdict,
            verdictKey: verdictKey,
            hostOf: hostOf,
            showNotice: showNotice,
            wrapFactory: wrapFactory,
            installMapWatch: installMapWatch,
            adopt: adopt,
            targetsFor: targetsFor,
            defForLayer: defForLayer,
            providerFor: providerFor,
            markUnavailable: markUnavailable,
            probeUrlFor: probeUrlFor
        }
    };

    wrapFactory();
    // js/leaflet.js is loaded before this file; re-check once the document is
    // parsed in case a page defers Leaflet.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            wrapFactory();
            installMapWatch();
        });
    }
    /* The 2D map itself is created by js/map-app.js, later than this file, so
       the guard hooks the map class and re-checks at load: installMapWatch()
       is idempotent. */
    installMapWatch();
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('load', function () { installMapWatch(); });
    }
})(window, document);
