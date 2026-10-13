/* ══════════════════════════════════════════════════════════════
   DetectLab — WMS availability guard for third-party map services
   ──────────────────────────────────────────────────────────────
   The CENAGIS / IH PAN historical maps (js/map-app.js premium rows and
   js/historical-eu-maps.js catalogue) are streamed as WMS GetMap tiles from
   https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms.

   When that server cannot render a layer it still answers **HTTP 200** — the
   body is a plain-text/XML error instead of an image, so the browser cannot
   decode a single tile: the layer stays empty, DevTools shows hundreds of
   “200 OK” image requests whose Preview pane says “Nothing to preview”, and
   the app gives the user no explanation at all.

   That is exactly what happened on 2026-10-13: every GetMap for the ECW
   mosaics came back with

       java.lang.RuntimeException: Unable to create a valid ImageInputStream
       for the provided input:
       /opt/geoserver/data_dir/cartomatic/UKvME/mosaick/ukvme_3857_transparent.ecw

   (the same for kdr, chrzanowski, reymann, m25k, gdansk… — i.e. the whole
   raster catalogue; only the server operator can fix it).

   This module turns that silent failure into a bounded, visible one:

     • a guarded layer probes ONE GetMap URL before it is added — the exact
       URL Leaflet would request for the first visible tile;
     • a non-image answer (or a timeout) marks that layer down for a cooldown,
       so re-toggling it inside the cooldown makes no request at all;
     • the layer's row is marked unavailable, its switch is switched back off
       (remembered, so Retry only re-enables what the guard turned off) and a
       dismissible notice explains that the provider's server is at fault;
     • tiles that start failing after the layer was accepted (a mid-session
       outage) trip the same path;
     • “Retry” clears the verdicts and flips those switches back on, which
       runs the app's own toggle handlers again;
     • when the user is offline nothing is blamed on the server and no
       cooldown is remembered.

   Only the hosts listed in HOSTS are guarded; every other WMS service in the
   app keeps its own behaviour. See CENAGIS_WMS_HEALTH.md.
   ══════════════════════════════════════════════════════════════ */
(function (window, document) {
    'use strict';
    if (!window || !document) return;

    // Third-party WMS hosts whose failures are worth reporting this way.
    var HOSTS = ['pastmaps.cenagis.edu.pl'];
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
        var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
        return m ? m[1].toLowerCase() : '';
    }
    function isGuardedUrl(url) {
        return HOSTS.indexOf(hostOf(url)) !== -1;
    }

    // One verdict per host + layer name: layers of the same server fail and
    // recover independently (the vectors on that server are not rasters).
    function verdictKey(layer) {
        var host = hostOf(layer && layer._url);
        var name = (layer && layer.options && layer.options.layers) || '-';
        return host + '|' + name;
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
    function fireChange(el) {
        try {
            if (typeof window.Event === 'function') {
                el.dispatchEvent(new window.Event('change', { bubbles: true }));
            } else if (document.createEvent) {
                var ev = document.createEvent('HTMLEvents');
                ev.initEvent('change', true, false);
                el.dispatchEvent(ev);
            }
        } catch (e) { /* the switch stays as set */ }
    }

    function markRows(key, down, title) {
        rowEls(key).forEach(function (row) {
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

    /* Tiles of an accepted layer: a mid-session outage trips the same path. */
    function watchTiles(layer, state) {
        if (state.watching) return;
        state.watching = true;
        var fails = 0, oks = 0;
        state.onTileLoad = function () { oks++; fails = 0; };
        state.onTileError = function () {
            fails++;
            if (!((fails >= MIN_TILE_FAILURES && oks === 0) || fails >= HARD_TILE_FAILURES)) return;
            state.watching = false;
            try {
                layer.off('tileload', state.onTileLoad);
                layer.off('tileerror', state.onTileError);
            } catch (e) {}
            var offline = navigator && navigator.onLine === false;
            if (!offline) setVerdict(verdictKey(layer), 'down', 'tiles');
            removeQuietly(layer);
            trip(layer, offline ? 'offline' : 'tiles');
        };
        layer.on('tileload', state.onTileLoad);
        layer.on('tileerror', state.onTileError);
    }

    /* The layer is not served: switch it off, mark its row and say why. */
    function trip(layer, reason) {
        var keys = keysFor(layer);
        var title = ro()
            ? 'Serverul CENAGIS / IH PAN nu poate livra această hartă acum'
            : 'The CENAGIS / IH PAN server cannot serve this map right now';
        keys.forEach(function (key) {
            toggleEls(key).forEach(function (el) {
                if (el.checked) { el.checked = false; blocked[key] = true; }
            });
            markRows(key, true, title);
        });
        showNotice(layerNames(layer, keys), reason);
    }

    /* Human name for a key: the layer's own title when it has one, else the
       first leaf element of its row with visible text (the premium rows use
       <span data-key>, the country catalogue rows a plain <div>). */
    function nameFor(layer, key) {
        var keys = keysFor(layer);
        if (layer && layer._detectlabUiTitle && keys.length === 1 && keys[0] === key) {
            return layer._detectlabUiTitle;
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
        return keys.map(function (key) { return nameFor(layer, key); });
    }

    /* ── The notice ─────────────────────────────────────────────────── */
    function el(tag, id, cssText) {
        var node = document.createElement(tag);
        node.id = id;
        if (cssText) node.style.cssText = cssText;
        return node;
    }

    /* Built node by node (no innerHTML) so the markup is explicit, the CSP
       story stays clean and the harness can drive it without a DOM parser. */
    var noticeNodes = null;
    function showNotice(names, reason) {
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
        noticeNodes.title.textContent = offline
            ? (ro() ? 'Ești offline' : 'You are offline')
            : (ro() ? 'Harta nu poate fi încărcată' : 'This map cannot be loaded');
        var list = names.filter(function (n, i) { return names.indexOf(n) === i; }).slice(0, 3).join(', ');
        noticeNodes.body.textContent = offline
            ? (ro()
                ? 'Conexiunea la internet pare întreruptă, deci „' + list + '” nu poate fi descărcată acum. Reîncearcă după ce revii online.'
                : 'Your internet connection appears to be down, so “' + list + '” cannot be downloaded right now. Retry once you are back online.')
            : (ro()
                ? 'Serverul de hărți al furnizorului (CENAGIS / IH PAN) răspunde cu o eroare în loc de imagine, deci „' + list
                    + '” nu se poate afișa. Este o problemă la sursă, nu la conexiunea sau browserul tău — restul hărții funcționează normal.'
                : 'The map provider’s server (CENAGIS / IH PAN) answers with an error instead of an image, so “' + list
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
       is skipped too — Leaflet sees a balanced add/remove pair either way. */
    function guard(layer) {
        if (!layer || layer._detectlabWmsGuard) return layer;
        if (!isGuardedUrl(layer._url)) return layer;
        layer._detectlabWmsGuard = true;
        var originalAdd = layer.onAdd;
        var originalRemove = layer.onRemove;
        var state = { token: 0, pending: false, watching: false };

        layer.onAdd = function (map) {
            var self = this;
            var token = ++state.token;
            if (isDown(self)) {
                state.pending = true;          // balanced by onRemove below
                removeQuietly(self);
                trip(self, 'cooldown');
                return;
            }
            var sample = sampleUrl(self, map);
            if (!sample) {                     // cannot ask → never block
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
                trip(self, offline ? 'offline' : 'probe');
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

    /* Retry: forget the verdicts and switch back on exactly the rows the
       guard switched off (never a layer the user never asked for). Running
       the app's own change handler re-adds the layer through the guard. */
    function retry() {
        Object.keys(verdicts).forEach(function (k) { delete verdicts[k]; });
        var keys = Object.keys(blocked);
        Object.keys(blocked).forEach(function (k) { delete blocked[k]; });
        keys.forEach(function (key) {
            markRows(key, false);
            toggleEls(key).forEach(function (el) {
                if (!el.checked) { el.checked = true; fireChange(el); }
            });
        });
        var box = document.getElementById(NOTICE_ID);
        if (box) box.style.display = 'none';
        return keys;
    }

    /* ── Auto-guard the CENAGIS layers ──────────────────────────────
       Every WMS layer built for a guarded host goes through guard() — the
       ones js/map-app.js and js/historical-eu-maps.js create later included.
       The panel keys cannot travel in the layer options (Leaflet copies every
       unknown option into the WMS query string), so the two modules attach
       `layer._detectlabUiKeys` right after creating each layer. */
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
        COOLDOWN_MS: COOLDOWN_MS,
        guard: guard,
        retry: retry,
        isGuardedUrl: isGuardedUrl,
        isDownFor: function (layer) { return isDown(layer); },
        verdictFor: function (layer) { return verdicts[verdictKey(layer)] || null; },
        noticeShown: function () { return noticeShown; },
        sampleUrl: sampleUrl,
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
            markRows: markRows,
            setVerdict: setVerdict,
            verdictKey: verdictKey,
            hostOf: hostOf,
            showNotice: showNotice,
            wrapFactory: wrapFactory
        }
    };

    wrapFactory();
    // js/leaflet.js is loaded before this file; re-check once the document is
    // parsed in case a page defers Leaflet.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wrapFactory);
    }
})(window, document);
