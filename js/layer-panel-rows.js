/* =====================================================================
 * layer-panel-rows.js — the rows inside the layers window
 * ---------------------------------------------------------------------
 * The window (#transpPanel) is one glass pane since the 2026-10-25 release
 * and so are its rows. Two jobs live here, because both of them need to
 * know which *layer* a row belongs to and neither can be expressed in CSS:
 *
 *   1. GLASS — every nested row the catalogue renders inside a
 *      `*SubLayers` accordion is tagged `.dl-sublayer-row`, so it takes the
 *      same translucent violet box as a top-level `.transp-layer-row` and as
 *      the map controls (`--ctl-*`, css/styles.css § Layer rows). The
 *      CENAGIS catalogue rows are tagged the same way; their generator
 *      (js/historical-eu-maps.js) still writes its own dark inline box, which
 *      is removed here instead of being fought with `!important`.
 *
 *   2. TILE PHOTO — every historical-map sublayer row carries a photo of one
 *      of its OWN tiles as the row background, mean-ed out under a violet
 *      wash so the switch, the slider, the info button and the labels stay
 *      readable on top of it. The URL comes from the layer's own definition
 *      in js/layer-registry.js — its tile template for XYZ / ArcGIS
 *      pyramids, a GetMap window for WMS mosaics — never from a second copy
 *      of the endpoints. The row is only given the photo once the image has
 *      actually loaded, so a service that is down leaves a plain glass row
 *      instead of an empty frame (and never retries on every sweep).
 *
 *  Rows opt in with `data-preview-layer="<registry id>"`; the CENAGIS
 *  catalogue rows carry `data-map-id="<catalogue key>"` instead, and are
 *  resolved as `cenagis.<key>`.
 * ===================================================================== */
(function (root) {
    'use strict';

    var DOC = root && root.document;
    if (!DOC) return;

    /* ── Anchors for layers whose definition carries no bounding box ──────
     * A town that is well inside the sheet's own footprint: for a row
     * backdrop all that matters is that the tile really is one of that
     * sheet's tiles (never a neighbouring mosaic, never a blank ocean
     * corner). Everything with a `bounds` box uses the centre of the box
     * instead — see centreOf(). */
    var ANCHORS = {
        'hist.austrian':               { lat: 46.777, lng: 23.599 },   /* Cluj-Napoca */
        'hist.firing-plans':           { lat: 45.657, lng: 25.601 },   /* Brașov */
        'hist.soviet-1970':            { lat: 47.158, lng: 27.601 },   /* Iași */
        'premium.josephine':           { lat: 46.777, lng: 23.599 },   /* Cluj-Napoca */
        'premium.bucovina':            { lat: 49.842, lng: 24.031 },   /* Lviv */
        'premium.austro-hungarian':    { lat: 50.062, lng: 19.937 },   /* Kraków */
        'premium.moldova-1868':        { lat: 47.158, lng: 27.601 },   /* Iași */
        'premium.moldova-1771':        { lat: 47.158, lng: 27.601 },   /* Iași */
        'premium.moldova-wwii':        { lat: 47.158, lng: 27.601 },   /* Iași */
        'premium.polish-tactical-1933': { lat: 49.842, lng: 24.031 },  /* Lviv */
        'premium.ww1':                 { lat: 49.783, lng: 22.768 },   /* Przemyśl */
        'premium.ww2':                 { lat: 49.783, lng: 22.768 },   /* Przemyśl */
        'premium.banat':               { lat: 45.748, lng: 21.208 },   /* Timișoara */
        'premium.galicia-1855':        { lat: 49.842, lng: 24.031 },   /* Lviv */
        'premium.mitteleuropa':        { lat: 52.232, lng: 21.006 },   /* Warsaw */
        'premium.chrzanowski':         { lat: 50.062, lng: 19.937 },   /* Kraków */
        'premium.reymann':             { lat: 52.406, lng: 16.925 },   /* Poznań */
        'premium.kdr-100k':            { lat: 52.520, lng: 13.405 },   /* Berlin */
        'premium.kdr-gb':              { lat: 52.232, lng: 21.006 },   /* Warsaw */
        'premium.wig-100k':            { lat: 52.232, lng: 21.006 }    /* Warsaw */
    };

    var TILE_ZOOM = 13;      /* mid detail: recognisable, small, and inside
                              * every sheet's native window                  */
    var SPAN_METERS = 9000;  /* WMS preview window: roughly one town         */
    var WMS_WIDTH = 168;
    var WMS_HEIGHT = 96;
    var HISTORICAL_GROUPS = { 'hist-free': true, 'hist-premium': true };

    var READY = {};          /* url → the tile really loaded, paint it at once */
    var BROKEN = {};         /* url → it failed once, never ask again          */
    var PENDING = [];        /* in-flight Image()s — keeps them alive         */
    var QUEUE = [];          /* rows waiting for a free request slot          */
    var IN_FLIGHT = 0;
    var MAX_IN_FLIGHT = 4;   /* a whole catalogue opens at once; do not open a
                              * dozen parallel sockets per sheet host         */
    var timers = { sweep: 0, glass: 0 };

    function registry() {
        var r = root.DetectLabLayers;
        return (r && typeof r.get === 'function') ? r : null;
    }

    /* ── geometry ──────────────────────────────────────────────────────── */
    function mercator(lat, lng) {
        var world = 20037508.342789244;
        return { x: lng * world / 180, y: world * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI };
    }

    function tileX(lng, z) {
        return Math.floor((lng + 180) / 360 * Math.pow(2, z));
    }

    function tileY(lat, z) {
        var rad = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
    }

    function centreOf(def) {
        var anchor = ANCHORS[def.id];
        if (anchor) return anchor;
        var b = def.bounds;
        if (b && b.length === 2 && b[0] && b[1] &&
            typeof b[0][0] === 'number' && typeof b[1][0] === 'number') {
            return { lat: (b[0][0] + b[1][0]) / 2, lng: (b[0][1] + b[1][1]) / 2 };
        }
        return null;
    }

    function zoomOf(def) {
        var z = Math.min(def.maxNativeZoom || def.maxZoom || TILE_ZOOM, TILE_ZOOM);
        if (def.minZoom != null && z < def.minZoom) z = def.minZoom;
        if (def.maxZoom != null && z > def.maxZoom) z = def.maxZoom;
        return Math.max(0, Math.min(22, Math.round(z)));
    }

    /* ── the row photo URL ─────────────────────────────────────────────── */
    function urlFor(id) {
        var reg = registry();
        if (!reg) return null;
        var def = reg.get(id);
        if (!def || !HISTORICAL_GROUPS[def.group]) return null;
        var centre = centreOf(def);
        if (!centre || !def.url) return null;

        if (def.kind === 'xyz' || def.kind === 'arcgis-image') {
            var z = zoomOf(def);
            var x = tileX(centre.lng, z);
            var y = tileY(centre.lat, z);
            /* ArcGIS pyramids are {z}/{y}/{x}, XYZ are {z}/{x}/{y} — the
               template decides, the replacement never reorders anything. */
            return String(def.url).replace(/\{(z|x|y)\}/g, function (match, key) {
                if (key === 'z') return z;
                return key === 'x' ? x : y;
            });
        }

        if (def.kind === 'wms') {
            /* A WMS mosaic has no tiles, so a preview is a small GetMap over
               the middle of the sheet — the same request the 2D map makes,
               only 168x96 pixels of it. */
            var m = mercator(centre.lat, centre.lng);
            var half = SPAN_METERS / 2;
            var version = String(def.version || '1.1.1');
            var axis = version.indexOf('1.3') === 0 ? 'crs' : 'srs';
            var bbox = [m.x - half, m.y - half, m.x + half, m.y + half].map(function (n) {
                return n.toFixed(1);
            }).join(',');
            var params = [
                'service=WMS',
                'request=GetMap',
                'version=' + version,
                'layers=' + encodeURIComponent(def.layer || ''),
                'styles=',
                'format=' + encodeURIComponent(def.format || 'image/png'),
                'transparent=' + (def.transparent === false ? 'false' : 'true'),
                axis + '=EPSG:3857',
                'bbox=' + bbox,
                'width=' + WMS_WIDTH,
                'height=' + WMS_HEIGHT
            ];
            return String(def.url) + (String(def.url).indexOf('?') === -1 ? '?' : '&') + params.join('&');
        }

        return null;
    }

    /* ── DOM helpers ───────────────────────────────────────────────────── */
    function panel() {
        return DOC.getElementById('transpPanel');
    }

    function isVisible(row, host) {
        if (!row.getClientRects || !row.getClientRects().length) return false;
        /* A collapsed accordion is not `display:none`: its rows keep their
           layout boxes, they are only clipped by an ancestor with no height.
           Asking for a photo of a row nobody can see would fire 45 CENAGIS
           GetMaps (and 26 sheet tiles) every time the window is opened. */
        var style = root.getComputedStyle;
        if (typeof style !== 'function') return true;
        for (var node = row; node && node !== host; node = node.parentElement) {
            var cs = style.call(root, node);
            if (!cs) break;
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && parseFloat(cs.height) < 2) return false;
        }
        return true;
    }

    /* The row of a nested control is the direct child of a `*SubLayers`
       container that contains it — that is exactly the box the panel draws a
       background for. */
    function subRowFor(control, host) {
        var node = control && control.parentElement;
        while (node && node !== host) {
            var up = node.parentElement;
            if (up && up.id && /SubLayers$/.test(up.id)) return node;
            node = up;
        }
        return null;
    }

    function markGlass() {
        var host = panel();
        if (!host) return 0;
        var tagged = 0;

        var controls = host.querySelectorAll('[id$="SubLayers"] input[type="range"], [id$="SubLayers"] .apm-toggle-switch input');
        Array.prototype.forEach.call(controls, function (control) {
            var row = subRowFor(control, host);
            if (row && !row.classList.contains('dl-sublayer-row')) {
                row.classList.add('dl-sublayer-row');
                tagged++;
            }
        });

        /* CENAGIS catalogue rows: generated with their own dark inline box
           (`style="background:rgba(0,0,0,.22);border:…;border-radius:5px;padding:6px"`
           in js/historical-eu-maps.js). The whole attribute goes: a style
           parser is free to expand those shorthands into longhands, so
           removing property by property would leave half a box behind, and
           the row material wants to own all of it anyway. */
        Array.prototype.forEach.call(host.querySelectorAll('.cenagis-map-row'), function (row) {
            row.classList.add('dl-sublayer-row');
            row.removeAttribute('style');
        });

        return tagged;
    }

    function paint(row, url) {
        row.style.setProperty('--row-preview', 'url("' + url + '")');
        row.setAttribute('data-row-preview', '');
        row.setAttribute('data-row-preview-state', 'ok');
    }

    function attach(row, url) {
        /* The catalogue is re-rendered on every country change; the same sheet
           then comes back as a brand-new row. A tile that already loaded is
           painted without a second request, and a broken one is not retried. */
        if (READY[url]) {
            paint(row, url);
            return;
        }
        if (BROKEN[url]) {
            row.setAttribute('data-row-preview-state', 'failed');
            return;
        }
        row.setAttribute('data-row-preview-state', 'pending');
        QUEUE.push({ row: row, url: url });
        pump();
    }

    function pump() {
        while (IN_FLIGHT < MAX_IN_FLIGHT && QUEUE.length) load(QUEUE.shift());
    }

    function load(job) {
        var row = job.row;
        var img = new root.Image();
        var released = false;
        IN_FLIGHT++;
        function release() {
            if (released) return;
            released = true;
            IN_FLIGHT--;
            var at = PENDING.indexOf(img);
            if (at !== -1) PENDING.splice(at, 1);
            pump();
        }
        img.onload = function () {
            release();
            READY[job.url] = true;
            paint(row, job.url);
        };
        img.onerror = function () {
            release();
            BROKEN[job.url] = true;
            row.setAttribute('data-row-preview-state', 'failed');
        };
        PENDING.push(img);
        img.src = job.url;
    }

    function sweep() {
        var host = panel();
        if (!host || !host.classList.contains('open')) return 0;
        markGlass();

        var rows = host.querySelectorAll('[data-preview-layer], .cenagis-map-row[data-map-id]');
        var started = 0;
        Array.prototype.forEach.call(rows, function (row) {
            if (row.hasAttribute('data-row-preview') || row.hasAttribute('data-row-preview-state')) return;
            if (!isVisible(row, host)) return;    /* collapsed accordion / hidden tab */
            var id = row.getAttribute('data-preview-layer');
            if (!id) id = 'cenagis.' + row.getAttribute('data-map-id');
            var url = urlFor(id);
            if (!url) {
                row.setAttribute('data-row-preview-state', 'unavailable');
                return;
            }
            started++;
            attach(row, url);
        });
        return started;
    }

    function later(kind, fn, delay) {
        if (timers[kind]) root.clearTimeout(timers[kind]);
        timers[kind] = root.setTimeout(function () {
            timers[kind] = 0;
            fn();
        }, delay || 60);
    }

    function schedule() {
        later('sweep', sweep);
    }

    function observe() {
        var host = panel();
        if (!host || typeof root.MutationObserver !== 'function') return;

        /* Opening the window, switching tabs, expanding an accordion. */
        new root.MutationObserver(function () {
            later('glass', markGlass, 40);
            schedule();
        }).observe(host, { attributes: true, attributeFilter: ['class', 'style', 'open'] });

        /* The CENAGIS catalogue is re-rendered on every country change. */
        var eu = DOC.getElementById('histEuMapsSection');
        if (eu) {
            new root.MutationObserver(function () {
                later('glass', markGlass, 40);
                schedule();
            }).observe(eu, { childList: true });
        }

        host.addEventListener('click', schedule, true);
        /* Accordions expand with a transition; sweep once it settles so the
           rows that were clipped a moment ago get their photo. */
        host.addEventListener('transitionend', schedule, true);
    }

    function init() {
        markGlass();
        observe();
        if (panel() && panel().classList.contains('open')) sweep();
        DOC.addEventListener('detectlab:langchange', function () {
            later('sweep', sweep, 200);
        });
    }

    root.DetectLabPanelRows = {
        anchors: ANCHORS,
        urlFor: urlFor,
        markGlass: markGlass,
        sweep: sweep,
        tileZoom: TILE_ZOOM,
        spanMeters: SPAN_METERS
    };

    if (DOC.readyState === 'loading') {
        DOC.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}(typeof window !== 'undefined' ? window : this));
