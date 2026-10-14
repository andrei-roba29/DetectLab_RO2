/*
 * dataforsyningen-dhm-layer.js
 * ───────────────────────────────────────────────────────────────────────────
 * Denmark — hillshade of Danmarks Højdemodel ("skyggekort", the LiDAR-derived
 * national elevation model), streamed live from Dataforsyningen's **WMTS** as
 * the user pans and zooms. Nothing is downloaded or pre-generated.
 *
 *   https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF   (terræn)
 *   https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF (overflade)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PROBLEM, AND HOW THIS MODULE SOLVES IT
 *
 * The service publishes exactly ONE TileMatrixSet, "View1", and it is NOT the
 * Web-Mercator/XYZ grid every slippy map uses:
 *
 *     CRS            urn:ogc:def:crs:EPSG:6.3:25832  (ETRS89 / UTM zone 32N)
 *     grid extent    120000 5900000 → 1000000 6500000   (metres, not degrees)
 *     TopLeftCorner  120000 6500000                     (same at every level)
 *     tile size      256 × 256
 *     levels         0 … 13, resolutions 1638.4 → 0.2 m/px (clean /2 ladder)
 *     format         image/jpeg ONLY  ⇒ no alpha channel
 *
 * So tile indices are nothing like XYZ — hence the brief's own examples,
 * z10/col 1027 (XYZ only goes to 1023 at z10) and z4/col 15 row 13 (XYZ would
 * be col 8 row 5 for the same place).
 *
 * The obvious Leaflet answer, Proj4Leaflet, is the wrong one: it switches the
 * WHOLE map to EPSG:25832, so OpenStreetMap and the eight other national
 * LiDAR layers in DetectLab would no longer line up. Instead this module
 * keeps the map in EPSG:3857 and REPROJECTS THE TILES IN THE BROWSER:
 *
 *   L.GridLayer → <canvas> tile
 *     1. take the destination tile's EPSG:3857 bounds;
 *     2. lay an 8×8 mesh over it and convert every node to EPSG:25832
 *        (inverse spherical Mercator → ETRS89 lat/lon → UTM 32N, below);
 *     3. pick the View1 level whose resolution matches, work out which
 *        View1 tiles the mesh covers, fetch them, mosaic them;
 *     4. draw the mosaic into the destination canvas one mesh cell at a time
 *        through the cell's own affine transform — a piecewise-affine warp.
 *
 * Accuracy of that warp, measured against the exact projection at Copenhagen,
 * Skagen, Esbjerg and Bornholm for z7/z10/z13/z16 (worst case of all 16):
 *
 *     mesh 1 ..... 10.6 px     mesh 4 ..... 0.67 px     mesh 16 .... 0.04 px
 *     mesh 2 ..... 2.66 px     mesh 8 ..... 0.17 px  ← CONFIG.WARP_MESH
 *
 * 0.17 px is invisible, so the hillshade sits on the coastline exactly. The
 * cost is one canvas and a handful of drawImage() calls per tile.
 *
 * Trade-off versus the alternative (the WMS dhm_DAF, which does advertise
 * EPSG:3857 and would need no client maths): the WMS reprojects and renders
 * every request on demand — slower, never a cache hit, and more work for a
 * public agency's server. The WMTS serves pre-rendered tiles straight from
 * its cache, so we move the cheap part (an affine warp) to the client and
 * leave the expensive part out of the agency's budget.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * VERIFIED LIVE (token-free GetCapabilities, 2026-10-07 — full report in
 * DENMARK_LIDAR_DATAFORSYNINGEN.md):
 *   • Layer dhm_terraen_skyggekort, Format image/jpeg only, TileMatrixSet
 *     View1 only — there is NO EPSG:3857 WMTS grid for this product.
 *   • dhm_overflade_skyggekort_DAF publishes the identical View1 grid, so the
 *     terrain/surface switch below reuses every number.
 *   • The 14 scale denominators and all 14 MatrixWidth×MatrixHeight pairs
 *     reproduce exactly from RES0 = 1638.4 and the 880 km × 600 km extent.
 *   • Transforming the View1 extent with the UTM code below reproduces the
 *     service's own published WGS84BoundingBox (2.47842 53.015 → 17.5578
 *     58.6403) to 3 m — i.e. the projection in this file is the right one.
 *   • Brief's example tiles decode to 56.3555 N 9.6613 E (central Jutland)
 *     and 55.4604 N 9.4163 E (Kolding/Vejle) — both inside Denmark.
 *   • GetTile without a token → OGC ExceptionReport "User not authorized"
 *     (an XML body, not necessarily a 401) ⇒ a token is mandatory, and the
 *     proxy sniffs the body as well as the status.
 *   • STYLE=default and a BARE INTEGER TileMatrix are what this server wants
 *     (Dataforsyningen's migration FAQ: "tidligere var der L0 foran numre
 *     f.eks. L07 – nu 7"). Both are configurable below just in case.
 *
 * NOT verifiable from here: the HTTP status / Content-Type of a real tile and
 * the CORS response headers, because no token exists in this environment.
 * See the manual checklist in DENMARK_LIDAR_DATAFORSYNINGEN.md.
 *
 * CORS: this module only ever drawImage()s the source tiles — it never calls
 * getImageData() or toDataURL() — so a tainted canvas is harmless and NO CORS
 * header is required. crossOrigin is therefore left unset by default.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TOKEN — never in this file, never in the repository
 *   Default (recommended): tiles are requested from THIS site's own backend
 *   proxy (CONFIG.PROXY_PATH), which adds the token server-side as the
 *   "token" HTTP header and caches the answer for 7 days. The browser never
 *   sees a token and every request in DevTools goes to our own domain.
 *   Fallback (INSECURE, static hosting with no backend): set
 *   window.DETECTLAB_DK_TOKEN before the map initialises and the module talks
 *   to api.dataforsyningen.dk directly with ?token=… — visible to every
 *   visitor. Use a dedicated, disposable token if you do this.
 *
 * Exposes `window.DataforsyningenDHM` — see the bottom of the file.
 * No build step, no dependencies beyond Leaflet 1.x.
 */
(function (root) {
    'use strict';

    var L = root.L;
    if (!L) {
        console.error('[DataforsyningenDHM] Leaflet is not loaded — dataforsyningen-dhm-layer.js must load after leaflet.js');
        return;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  CONFIG — everything tunable lives here and nowhere else.
     *  THE TOKEN IS NOT PART OF THIS BLOCK: it is injected by the server-side
     *  proxy, or (insecure fallback) read from window.DETECTLAB_DK_TOKEN.
     * ═══════════════════════════════════════════════════════════════════════ */
    var CONFIG = {
        /* ── service ─────────────────────────────────────────────────────── */

        // Same-origin proxy that adds the token server-side and caches tiles.
        // Implementations: backend/src/routes/geoProxy.js (Express),
        // netlify/functions/dk-dhm.mjs, plus Cloudflare Worker / PHP / Nginx
        // variants in DENMARK_LIDAR_DATAFORSYNINGEN.md.
        PROXY_PATH: '/api/geo/dk-dhm',

        // Host used only by the insecure client-token fallback. Each product
        // is its own endpoint; MODES below holds the service name.
        DIRECT_HOST: 'https://api.dataforsyningen.dk/',

        WMTS_VERSION: '1.0.0',
        FORMAT: 'image/jpeg',       // the ONLY format this service publishes
        STYLE: 'default',           // per Dataforsyningen's own example URLs
        TILEMATRIXSET: 'View1',

        // TileMatrix identifier format. api.dataforsyningen.dk wants a bare
        // integer ("7"). The Layer's TileMatrixSetLimits in the capabilities
        // confusingly spell them "View1:7"; if the service ever starts
        // rejecting bare integers, set this to 'View1:'.
        TILEMATRIX_PREFIX: '',

        /* ── the View1 grid, read from GetCapabilities ────────────────────── */

        SOURCE_EPSG: 25832,                         // ETRS89 / UTM zone 32N
        GRID_ORIGIN_X: 120000,                      // TopLeftCorner easting
        GRID_ORIGIN_Y: 6500000,                     // TopLeftCorner northing
        GRID_EXTENT: [120000, 5900000, 1000000, 6500000],
        SOURCE_TILE_SIZE: 256,
        // Level 0 resolution = ScaleDenominator 5851428.571428571 × 0.00028.
        // Every deeper level is exactly half of the one above it.
        SOURCE_RES0: 1638.4,
        SOURCE_LEVELS: 14,                          // 0 … 13 (0.2 m/px)

        /* ── reprojection ────────────────────────────────────────────────── */

        // Mesh used for the piecewise-affine warp. 8 keeps the error under
        // 0.2 px everywhere in Denmark; 4 is ~0.7 px; 1 is 10 px and visibly
        // wrong at low zoom. Cost grows with the square, so 8 is the sweet
        // spot. See the measurement table at the top of this file.
        WARP_MESH: 8,

        // Nudges the chosen View1 level. 0 = nearest resolution, +1 = always
        // one level sharper (crisper, 4× the tiles), -1 = one level softer.
        SOURCE_LEVEL_BIAS: 0,

        // Hard ceiling on View1 tiles per destination tile. A 256 px tile
        // normally needs 1–4; anything more means something is wrong, so we
        // step down a level instead of hammering the agency.
        MAX_SOURCE_TILES: 12,

        // Decoded source tiles kept in memory so neighbouring destination
        // tiles (and the zoom the user just left) reuse them instead of
        // re-requesting. Pure win for a public server.
        SOURCE_CACHE_SIZE: 96,

        /* ── presentation ────────────────────────────────────────────────── */

        TILE_SIZE: 256,
        DEFAULT_MODE: 'terrain',

        // JPEG has no alpha, so at opacity 1 the hillshade would completely
        // hide the basemap. 0.6 is the default the UI starts at.
        OPACITY: 0.6,

        MIN_ZOOM: 6,            // View1 level 0 is 1638 m/px — below z6 it is pointless
        MAX_ZOOM: 20,
        MAX_NATIVE_ZOOM: 19,    // 0.2 m/px runs out at about z18.7; Leaflet upscales past this
        KEEP_BUFFER: 1,         // public agency server: barely any preloading

        // Never set unless you intend to read pixels back out of the canvas.
        // We only drawImage(), so a tainted canvas costs nothing and we avoid
        // depending on the gateway's CORS behaviour. 'anonymous' works
        // through the proxy (same origin) if you ever need getImageData().
        CROSS_ORIGIN: null,

        /* ── coverage ────────────────────────────────────────────────────── */

        // The View1 grid envelope (2.48 E 53.0 N → 17.56 E 58.64 N) is the
        // whole projection box, far bigger than the data. These are the real
        // coverage bounds of the skyggekort layers, taken from the WMS
        // capabilities of the same products: 7.99125 54.4265 → 15.5995
        // 57.7781. Outside them no request is made at all.
        BOUNDS: [[54.4265, 7.99125], [57.7781, 15.5995]],

        /* ── attribution & messages ──────────────────────────────────────── */

        // Free geographic data under CC BY 4.0; the data owner is
        // Klimadatastyrelsen (the Danish Climate Data Agency, ex-SDFI).
        ATTRIBUTION: 'Indeholder data fra <a href="https://dataforsyningen.dk/" ' +
            'target="_blank" rel="noopener">Klimadatastyrelsen</a>, Danmarks Højdemodel ' +
            '(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" ' +
            'rel="noopener">CC BY 4.0</a>)',

        // Shown once, non-blocking, when the service answers 401/403 (or the
        // OGC "User not authorized" exception body).
        AUTH_MESSAGE: 'Invalid or missing Dataforsyningen token',

        // Shown once when the SAME-ORIGIN PROXY answers
        // {"error":"dataforsyningen_token_missing"} — i.e. this deployment has
        // no DATAFORSYNINGEN_TOKEN at all. That is not a token the visitor can
        // fix (nor a server outage), so the message says what is missing and
        // who can enable it, instead of the bare "Invalid or missing token"
        // that reads like a browser problem. See DENMARK_LIDAR_DATAFORSYNINGEN.md.
        TOKEN_MISSING_MESSAGE: 'The Denmark LiDAR layer is not configured on this deployment: the tile proxy ' +
            '(/api/geo/dk-dhm) has no DATAFORSYNINGEN_TOKEN, so no tile can be requested. An administrator can ' +
            'enable Danmarks Højdemodel by setting that variable (see DENMARK_LIDAR_DATAFORSYNINGEN.md).',

        // Shown once when the same-origin proxy route itself is absent (HTTP
        // 404 in proxy mode): the deployment in front of the site predates
        // netlify/functions/dk-dhm.mjs (or the Express geoProxy route is not
        // mounted), so no tile request can ever reach Dataforsyningen. Seen
        // live on detectlab.eu while production still served the v161 shell,
        // whose deploy had no /api/geo/dk-dhm function — the layer stayed
        // silently blank. A visible notice turns that into a one-glance
        // diagnosis instead.
        PROXY_MISSING_MESSAGE: 'Denmark LiDAR proxy (/api/geo/dk-dhm) is not deployed on this server — redeploy the site with its Netlify functions (or the Express backend) to enable Danmarks Højdemodel',

        // The panel switch this layer belongs to (js/map-app.js). Used only to
        // stop the row looking “on” once the service has said it cannot serve
        // a single tile, and as the fallback when the shared guard is absent.
        TOGGLE_ID: 'lidarDkLidarToggle',

        /* ── products ────────────────────────────────────────────────────── */

        // Both WMTS endpoints publish the identical View1 grid, so switching
        // product changes nothing but two strings.
        // NOTE: the contour products (dhm_kurve_*) exist only on the WMS
        // dhm_DAF, never on the WMTS, so they are not offered here. See
        // "Known limitations" in DENMARK_LIDAR_DATAFORSYNINGEN.md.
        MODES: {
            terrain: {
                label: 'DHM Terræn · hillshade (bare earth)',
                service: 'dhm_terraen_skyggekort_DAF',
                layer: 'dhm_terraen_skyggekort'
            },
            surface: {
                label: 'DHM Overflade · hillshade (surface)',
                service: 'dhm_overflade_skyggekort_DAF',
                layer: 'dhm_overflade_skyggekort'
            }
        }
    };
    /* ════════════════════════ end of configuration ═══════════════════════ */

    // Transparent 1×1 PNG: the "no data" fallback, never a broken-image icon.
    var BLANK_TILE = 'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    function mode(key) {
        return CONFIG.MODES[key] || CONFIG.MODES[CONFIG.DEFAULT_MODE];
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  1. PROJECTIONS
     *  Self-contained so the maths can be unit-tested in Node without a DOM.
     * ═══════════════════════════════════════════════════════════════════════ */

    var DEG = Math.PI / 180, RAD = 180 / Math.PI;

    /* ── spherical Mercator, identical to L.CRS.EPSG3857 ─────────────────── */

    var MERC_R = 6378137,
        MERC_HALF = Math.PI * MERC_R;          // 20037508.342789244

    function mercatorX(lon) { return MERC_R * lon * DEG; }
    function mercatorY(lat) { return MERC_R * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)); }
    function mercatorLon(x) { return (x / MERC_R) * RAD; }
    function mercatorLat(y) { return (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * RAD; }

    /** Metres per pixel of the EPSG:3857 XYZ grid at a zoom level. */
    function webMercatorResolution(zoom, tileSize) {
        return (2 * MERC_HALF) / ((tileSize || 256) * Math.pow(2, zoom));
    }

    /* ── ETRS89 / UTM zone 32N (EPSG:25832) ──────────────────────────────────
     * Krüger series on GRS80, the same formulation PROJ uses. Fourth order,
     * which is accurate to well under a millimetre over a UTM zone — and the
     * repository carries no proj4, so this is ~40 lines instead of a 160 kB
     * vendored dependency. Validated two ways: the round trip is exact to
     * 2 µm over Denmark, and transforming the View1 extent reproduces the
     * service's own published WGS84BoundingBox to 3 m.
     */
    var UTM = (function () {
        var a = 6378137.0,                       // GRS80 semi-major axis
            f = 1 / 298.257222101,               // GRS80 flattening
            k0 = 0.9996,                         // UTM scale factor
            lon0 = 9 * DEG,                      // zone 32 central meridian
            FE = 500000, FN = 0,                 // false easting / northing
            n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n,
            A = a / (1 + n) * (1 + n2 / 4 + n4 / 64),
            // forward (geodetic → TM), inverse (TM → conformal), conformal → geodetic
            al = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180,
                  13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440,
                  61 * n3 / 240 - 103 * n4 / 140,
                  49561 * n4 / 161280],
            be = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360,
                  n2 / 48 + n3 / 15 - 437 * n4 / 1440,
                  17 * n3 / 480 - 37 * n4 / 840,
                  4397 * n4 / 161280],
            de = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45,
                  7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45,
                  56 * n3 / 15 - 136 * n4 / 35,
                  4279 * n4 / 630];

        function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }

        /** lat/lon (degrees, ETRS89) → [easting, northing] in EPSG:25832. */
        function forward(lat, lon) {
            var la = lat * DEG, dl = lon * DEG - lon0,
                s = Math.sin(la), q = 2 * Math.sqrt(n) / (1 + n),
                t = Math.sinh(atanh(s) - q * atanh(q * s)),
                xi = Math.atan2(t, Math.cos(dl)),
                eta = atanh(Math.sin(dl) / Math.sqrt(1 + t * t)),
                X = eta, Y = xi, j, c;
            for (j = 1; j <= 4; j++) {
                c = al[j - 1];
                X += c * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
                Y += c * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
            }
            return [FE + k0 * A * X, FN + k0 * A * Y];
        }

        /** [easting, northing] in EPSG:25832 → [lat, lon] in degrees. */
        function inverse(easting, northing) {
            var xi = (northing - FN) / (k0 * A),
                eta = (easting - FE) / (k0 * A),
                xi2 = xi, eta2 = eta, j, c;
            for (j = 1; j <= 4; j++) {
                c = be[j - 1];
                xi2 -= c * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
                eta2 -= c * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
            }
            var r = Math.sin(xi2) / Math.cosh(eta2);
            var chi = Math.asin(r > 1 ? 1 : (r < -1 ? -1 : r)), la = chi;
            for (j = 1; j <= 4; j++) la += de[j - 1] * Math.sin(2 * j * chi);
            return [la * RAD, (lon0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2))) * RAD];
        }

        return { forward: forward, inverse: inverse };
    })();

    /* ═══════════════════════════════════════════════════════════════════════
     *  2. THE View1 TILE GRID
     * ═══════════════════════════════════════════════════════════════════════ */

    var GRID = {
        /** Metres per pixel at a View1 level. */
        resolution: function (level) {
            return CONFIG.SOURCE_RES0 / Math.pow(2, level);
        },

        /** Ground span of one 256 px View1 tile, in metres. */
        tileSpan: function (level) {
            return CONFIG.SOURCE_TILE_SIZE * GRID.resolution(level);
        },

        /**
         * MatrixWidth × MatrixHeight. Derived rather than hard-coded — every
         * one of the 14 pairs in the live capabilities reproduces exactly
         * (3×2, 5×3, 9×6, 17×12, 34×23, 68×46, 135×92, 269×184, 538×367,
         * 1075×733, 2149×1465, 4297×2930, 8594×5860, 17188×11719).
         */
        matrixSize: function (level) {
            var span = GRID.tileSpan(level), e = CONFIG.GRID_EXTENT;
            return [Math.ceil((e[2] - e[0]) / span), Math.ceil((e[3] - e[1]) / span)];
        },

        /** [minX, minY, maxX, maxY] of one tile, in EPSG:25832 metres. */
        tileBounds: function (level, col, row) {
            var span = GRID.tileSpan(level),
                minX = CONFIG.GRID_ORIGIN_X + col * span,
                maxY = CONFIG.GRID_ORIGIN_Y - row * span;
            return [minX, maxY - span, minX + span, maxY];
        },

        /** Geographic bbox of one tile: [south, west, north, east] degrees. */
        tileLatLngBounds: function (level, col, row) {
            var b = GRID.tileBounds(level, col, row),
                sw = UTM.inverse(b[0], b[1]), se = UTM.inverse(b[2], b[1]),
                nw = UTM.inverse(b[0], b[3]), ne = UTM.inverse(b[2], b[3]);
            return [Math.min(sw[0], se[0]), Math.min(sw[1], nw[1]),
                    Math.max(nw[0], ne[0]), Math.max(se[1], ne[1])];
        },

        /** The View1 level whose resolution best matches `res` metres/pixel. */
        levelForResolution: function (res) {
            if (!(res > 0)) return CONFIG.SOURCE_LEVELS - 1;
            var level = Math.round(Math.log(CONFIG.SOURCE_RES0 / res) / Math.LN2) +
                CONFIG.SOURCE_LEVEL_BIAS;
            return Math.max(0, Math.min(CONFIG.SOURCE_LEVELS - 1, level));
        },

        /** True when col/row exist at that level (the TileMatrixSetLimits). */
        isValidTile: function (level, col, row) {
            if (level < 0 || level >= CONFIG.SOURCE_LEVELS) return false;
            var m = GRID.matrixSize(level);
            return col >= 0 && row >= 0 && col < m[0] && row < m[1];
        }
    };

    /* ═══════════════════════════════════════════════════════════════════════
     *  3. URLS
     * ═══════════════════════════════════════════════════════════════════════ */

    /** The token, if the deployment chose the insecure client-side fallback. */
    function clientToken() {
        return root.DETECTLAB_DK_TOKEN || '';
    }

    /** True when tiles go through our own backend (no token in the browser). */
    function isProxied() {
        return !clientToken();
    }

    /** Where tiles for this product come from. */
    function source(key) {
        return isProxied() ? CONFIG.PROXY_PATH : (CONFIG.DIRECT_HOST + mode(key).service);
    }

    /** Back-compat alias used by map-app.js and the tests. */
    function endpoint() {
        return source(CONFIG.DEFAULT_MODE);
    }

    /**
     * WMTS 1.0.0 KVP GetTile URL for one View1 tile.
     *
     * In proxy mode the base is our own path and no token is attached — the
     * backend resolves `layer` to the right upstream service and adds the
     * token as an HTTP header. In direct mode the base is the product's own
     * api.dataforsyningen.dk endpoint and ?token= is appended.
     */
    function tileUrl(key, level, col, row, token) {
        var m = mode(key),
            base = token ? (CONFIG.DIRECT_HOST + m.service) : CONFIG.PROXY_PATH,
            url = base + (base.indexOf('?') === -1 ? '?' : '&') +
                'service=WMTS' +
                '&request=GetTile' +
                '&version=' + CONFIG.WMTS_VERSION +
                '&layer=' + m.layer +
                '&style=' + CONFIG.STYLE +
                '&tilematrixset=' + CONFIG.TILEMATRIXSET +
                '&format=' + encodeURIComponent(CONFIG.FORMAT) +
                '&TileMatrix=' + CONFIG.TILEMATRIX_PREFIX + level +
                '&TileCol=' + col +
                '&TileRow=' + row;
        if (token) url += '&token=' + encodeURIComponent(token);
        return url;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  4. SOURCE-TILE LOADER  (small LRU + in-flight de-duplication)
     * ═══════════════════════════════════════════════════════════════════════ */

    var sourceCache = new Map();   // url → Promise<HTMLImageElement|null>

    function loadSourceTile(url) {
        var hit = sourceCache.get(url);
        if (hit) {                                   // refresh recency
            sourceCache.delete(url);
            sourceCache.set(url, hit);
            return hit;
        }
        var promise = new Promise(function (resolve) {
            var img = new Image();
            if (CONFIG.CROSS_ORIGIN) img.crossOrigin = CONFIG.CROSS_ORIGIN;
            img.onload = function () { resolve(img); };
            // A missing tile is normal at the edge of the coverage. Resolve
            // with null rather than rejecting: no console spam, no unhandled
            // rejection, and the caller simply leaves that area transparent.
            img.onerror = function () { sourceCache.delete(url); resolve(null); };
            img.src = url;
        });
        if (sourceCache.size >= CONFIG.SOURCE_CACHE_SIZE) {
            sourceCache.delete(sourceCache.keys().next().value);
        }
        sourceCache.set(url, promise);
        return promise;
    }

    function clearSourceCache() { sourceCache.clear(); }

    /* ═══════════════════════════════════════════════════════════════════════
     *  5. THE WARP
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * Invert the destination→source affine so canvas can go source→dest.
     *
     * forward:  sx = a·dx + c·dy + e ,  sy = b·dx + d·dy + f
     * returns   [A, B, C, D, E, F] for ctx.setTransform(), i.e.
     *           dx = A·sx + C·sy + E ,  dy = B·sx + D·sy + F
     * or null when the cell is degenerate (zero area).
     */
    function invertAffine(a, b, c, d, e, f) {
        var det = a * d - c * b;
        if (!det || !isFinite(det)) return null;
        var A = d / det, B = -b / det, C = -c / det, D = a / det;
        return [A, B, C, D, -(A * e + C * f), -(B * e + D * f)];
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  6. A SMALL, NON-BLOCKING NOTICE FOR 401/403
     * ═══════════════════════════════════════════════════════════════════════ */

    var noticeShown = false;
    function showAuthNotice(message) {
        if (noticeShown) return;
        noticeShown = true;
        if (typeof document === 'undefined' || !document.body) {
            console.warn('[DataforsyningenDHM] ' + message);
            return;
        }        var box = document.createElement('div');
        box.id = 'dkDhmTokenNotice';
        box.setAttribute('role', 'status');
        box.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
            'z-index:12000;background:rgba(20,18,16,0.92);color:#f5f0eb;border:1px solid rgba(245,240,235,0.25);' +
            'border-radius:8px;padding:8px 12px;font-size:0.8rem;max-width:min(92vw,420px);' +
            'box-shadow:0 4px 18px rgba(0,0,0,0.45);display:flex;align-items:center;gap:10px;';
        var text = document.createElement('span');
        text.textContent = message;
        var close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.setAttribute('aria-label', 'Dismiss');
        close.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;font-size:0.9rem;';
        close.onclick = function () { if (box.parentNode) box.parentNode.removeChild(box); };
        box.appendChild(text);
        box.appendChild(close);
        document.body.appendChild(box);
        setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 12000);
    }

    /* A layer that cannot be served at all (no token on this deployment, a
       rejected token, a route that was never deployed) is switched off and
       its row is dimmed, not left looking “on but empty”. The shared guard
       (js/wms-health.js) owns that UI: it knows the row/switch from the layer
       registry, it dims the row with the message as its tooltip and it can put
       the switch back with its Retry button. Without the guard (a page that
       loads this module alone) the row is switched off directly. */
    function reportUnavailable(layer, message) {
        showAuthNotice(message);
        var guard = null;
        try { guard = root.DetectLabWmsHealth; } catch (e) { guard = null; }
        if (guard && typeof guard.markUnavailable === 'function' && layer) {
            try { guard.markUnavailable(layer, message, { provider: 'Dataforsyningen (Denmark)' }); return; } catch (e) {}
        }
        try {
            if (typeof document === 'undefined') return;
            var toggle = document.getElementById(CONFIG.TOGGLE_ID);
            if (toggle && toggle.checked) {
                toggle.checked = false;
                if (typeof toggle.onchange === 'function') toggle.onchange.call(toggle, { target: toggle });
            }
            if (layer && layer._map && typeof layer._map.removeLayer === 'function') layer._map.removeLayer(layer);
        } catch (e) {}
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  7. THE LAYER
     * ═══════════════════════════════════════════════════════════════════════ */

    var DataforsyningenDHMLayer = L.GridLayer.extend({
        options: {
            mode: CONFIG.DEFAULT_MODE,
            tileSize: CONFIG.TILE_SIZE,
            minZoom: CONFIG.MIN_ZOOM,
            maxZoom: CONFIG.MAX_ZOOM,
            maxNativeZoom: CONFIG.MAX_NATIVE_ZOOM,
            keepBuffer: CONFIG.KEEP_BUFFER,
            opacity: CONFIG.OPACITY,
            attribution: CONFIG.ATTRIBUTION,
            // Public agency server: render only what the user is actually
            // looking at, and never prefetch beyond the viewport.
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true
        },

        initialize: function (options) {
            L.setOptions(this, options || {});
            // Clip to Denmark so no request ever leaves the covered area.
            if (!this.options.bounds) {
                this.options.bounds = L.latLngBounds(CONFIG.BOUNDS);
            }
            this._warned = false;
            this._authChecked = false;
            this._crsWarned = false;
            L.GridLayer.prototype.initialize.call(this, this.options);
        },

        onAdd: function (map) {
            L.GridLayer.prototype.onAdd.call(this, map);
            this.on('tileunload', this._onTileUnload, this);
        },

        onRemove: function (map) {
            this.off('tileunload', this._onTileUnload, this);
            L.GridLayer.prototype.onRemove.call(this, map);
        },

        // A tile that scrolled away before its sources arrived must not draw.
        _onTileUnload: function (e) {
            if (e && e.tile) e.tile._dlCancelled = true;
        },

        /* ── Leaflet entry point ─────────────────────────────────────────── */

        createTile: function (coords, done) {
            var size = this.getTileSize(),
                canvas = document.createElement('canvas');
            canvas.width = size.x;
            canvas.height = size.y;
            // Transparent until something is drawn — that IS the graceful
            // fallback: no broken-image icon, no opaque grey square.
            canvas.setAttribute('role', 'presentation');

            var self = this;
            this._renderTile(canvas, coords, size).then(function (drewSomething) {
                if (canvas._dlCancelled) return;
                if (!drewSomething) self._noteFailure();
                // Always report success: a blank tile is a valid "no data
                // here" answer and must not make Leaflet retry or log.
                done(null, canvas);
            })['catch'](function (err) {
                if (canvas._dlCancelled) return;
                self._noteFailure(err);
                done(null, canvas);
            });

            return canvas;
        },

        /* ── the reprojection itself ─────────────────────────────────────── */

        _renderTile: function (canvas, coords, size) {
            var self = this,
                mesh = Math.max(1, CONFIG.WARP_MESH | 0),
                tileSize = size.x;

            this._checkMapCrs();

            // (a) The destination tile's EPSG:3857 bounds. Web Mercator is
            //     linear in pixel space, so interior pixels interpolate.
            var res = webMercatorResolution(coords.z, tileSize),
                x0 = -MERC_HALF + coords.x * tileSize * res,
                y0 = MERC_HALF - coords.y * tileSize * res;

            // (b) Mesh nodes, converted to EPSG:25832.
            var nodes = new Array((mesh + 1) * (mesh + 1)),
                minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity,
                i, j, px, py, en;
            for (j = 0; j <= mesh; j++) {
                for (i = 0; i <= mesh; i++) {
                    px = (i / mesh) * tileSize;
                    py = (j / mesh) * tileSize;
                    en = UTM.forward(mercatorLat(y0 - py * res), mercatorLon(x0 + px * res));
                    nodes[j * (mesh + 1) + i] = en;
                    if (en[0] < minX) minX = en[0];
                    if (en[0] > maxX) maxX = en[0];
                    if (en[1] < minY) minY = en[1];
                    if (en[1] > maxY) maxY = en[1];
                }
            }
            if (!isFinite(minX) || !isFinite(minY)) return Promise.resolve(false);

            // (c) Required source resolution: the narrower of the tile's two
            //     ground spans, so we never under-sample.
            var mid = Math.floor(mesh / 2),
                left = nodes[mid * (mesh + 1)], right = nodes[mid * (mesh + 1) + mesh],
                top = nodes[mid], bottom = nodes[mesh * (mesh + 1) + mid],
                spanX = Math.hypot(right[0] - left[0], right[1] - left[1]),
                spanY = Math.hypot(bottom[0] - top[0], bottom[1] - top[1]),
                needed = Math.min(spanX, spanY) / tileSize;

            // (d) Pick a level, stepping coarser if the tile count explodes.
            var level = GRID.levelForResolution(needed), srcRes, span, c0, c1, r0, r1, count;
            for (;;) {
                srcRes = GRID.resolution(level);
                span = GRID.tileSpan(level);
                c0 = Math.floor((minX - CONFIG.GRID_ORIGIN_X) / span);
                c1 = Math.floor((maxX - CONFIG.GRID_ORIGIN_X) / span);
                r0 = Math.floor((CONFIG.GRID_ORIGIN_Y - maxY) / span);
                r1 = Math.floor((CONFIG.GRID_ORIGIN_Y - minY) / span);
                count = (c1 - c0 + 1) * (r1 - r0 + 1);
                if (count <= CONFIG.MAX_SOURCE_TILES || level === 0) break;
                level--;
            }

            // (e) Clamp to the matrix — never request a tile that cannot exist.
            var m = GRID.matrixSize(level);
            c0 = Math.max(0, c0); r0 = Math.max(0, r0);
            c1 = Math.min(m[0] - 1, c1); r1 = Math.min(m[1] - 1, r1);
            if (c1 < c0 || r1 < r0) return Promise.resolve(false);

            // (f) Fetch the source tiles and mosaic them.
            var cols = c1 - c0 + 1, rows = r1 - r0 + 1,
                originX = CONFIG.GRID_ORIGIN_X + c0 * span,   // mosaic top-left…
                originY = CONFIG.GRID_ORIGIN_Y - r0 * span,   // …in EPSG:25832
                token = clientToken(),
                jobs = [], col, rw;

            for (rw = r0; rw <= r1; rw++) {
                for (col = c0; col <= c1; col++) {
                    jobs.push({
                        col: col, row: rw,
                        promise: loadSourceTile(tileUrl(self.options.mode, level, col, rw, token))
                    });
                }
            }

            return Promise.all(jobs.map(function (t) { return t.promise; }))
                .then(function (images) {
                    if (canvas._dlCancelled) return false;
                    if (!images.some(Boolean)) return false;

                    var st = CONFIG.SOURCE_TILE_SIZE,
                        mosaic = document.createElement('canvas');
                    mosaic.width = cols * st;
                    mosaic.height = rows * st;
                    var mctx = mosaic.getContext('2d');
                    images.forEach(function (img, k) {
                        if (!img) return;                    // leave that square empty
                        mctx.drawImage(img,
                            (jobs[k].col - c0) * st,
                            (jobs[k].row - r0) * st);
                    });

                    self._warpMesh(canvas, mosaic, nodes, mesh, tileSize,
                        originX, originY, srcRes);
                    return true;
                });
        },

        /**
         * Piecewise-affine warp: draw the EPSG:25832 mosaic into the
         * EPSG:3857 destination canvas, one mesh cell at a time.
         */
        _warpMesh: function (canvas, mosaic, nodes, mesh, tileSize, originX, originY, srcRes) {
            var ctx = canvas.getContext('2d'),
                cell = tileSize / mesh,
                i, j;

            ctx.imageSmoothingEnabled = true;
            if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

            function sourcePx(node) {
                return [(node[0] - originX) / srcRes, (originY - node[1]) / srcRes];
            }

            for (j = 0; j < mesh; j++) {
                for (i = 0; i < mesh; i++) {
                    var s00 = sourcePx(nodes[j * (mesh + 1) + i]),
                        s10 = sourcePx(nodes[j * (mesh + 1) + i + 1]),
                        s01 = sourcePx(nodes[(j + 1) * (mesh + 1) + i]),
                        dx0 = i * cell, dy0 = j * cell;

                    // destination → source, affine over this cell
                    var a = (s10[0] - s00[0]) / cell, c = (s01[0] - s00[0]) / cell,
                        b = (s10[1] - s00[1]) / cell, d = (s01[1] - s00[1]) / cell,
                        e = s00[0] - a * dx0 - c * dy0,
                        f = s00[1] - b * dx0 - d * dy0,
                        t = invertAffine(a, b, c, d, e, f);
                    if (!t) continue;

                    ctx.save();
                    // Overlap neighbouring cells by half a pixel so the
                    // slightly different transforms leave no hairline seam.
                    ctx.beginPath();
                    ctx.rect(dx0 - 0.5, dy0 - 0.5, cell + 1, cell + 1);
                    ctx.clip();
                    ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
                    ctx.drawImage(mosaic, 0, 0);
                    ctx.restore();
                }
            }
        },

        /* ── diagnostics ─────────────────────────────────────────────────── */

        _checkMapCrs: function () {
            if (this._crsWarned || !this._map) return;
            var code = this._map.options.crs && this._map.options.crs.code;
            if (code && code !== 'EPSG:3857' && code !== 'EPSG:900913') {
                this._crsWarned = true;
                console.warn('[DataforsyningenDHM] the map CRS is ' + code +
                    ' — this layer reprojects View1 into EPSG:3857 and will be misplaced');
            }
        },

        // One warning per layer, never one per tile. The first failure also
        // triggers a single probe that tells a token problem apart from an
        // ordinary gap in the data.
        _noteFailure: function (err) {
            if (!this._warned) {
                this._warned = true;
                console.warn('[DataforsyningenDHM] some ' + mode(this.options.mode).layer +
                    ' tiles are unavailable; further failures are silent' +
                    (err ? ' (' + err.message + ')' : ''));
            }
            this._probeAuthOnce();
        },

        _probeAuthOnce: function () {
            if (this._authChecked || typeof fetch !== 'function') return;
            this._authChecked = true;
            // One small tile over Denmark, not a full tile run. Level 2
            // col 4 row 2 sits over Jutland and always exists.
            var url = tileUrl(this.options.mode, 2, 4, 2, clientToken());
            var self = this;
            fetch(url, { method: 'GET', cache: 'no-store' }).then(function (res) {
                if (res.status === 401 || res.status === 403) {
                    // Proxy mode answers 401 only when the deployment has no
                    // token at all (see reportTokenError below); a direct-mode
                    // 401/403 is Dataforsyningen rejecting the token.
                    reportUnavailable(self, clientToken() ? CONFIG.AUTH_MESSAGE : CONFIG.TOKEN_MISSING_MESSAGE);
                    return;
                }
                if (res.status === 404 && !clientToken()) {
                    // Proxy mode only: api.dataforsyningen.dk never answers
                    // 404 for this always-present Jutland tile, so a 404 can
                    // only mean the same-origin /api/geo/dk-dhm route itself
                    // is missing from the deployment.
                    showAuthNotice(CONFIG.PROXY_MISSING_MESSAGE);
                    return;
                }
                var type = res.headers && res.headers.get && res.headers.get('content-type');
                if (type && type.indexOf('xml') !== -1) {
                    // Direct mode: the service answers 200 + an OGC
                    // ExceptionReport saying "User not authorized".
                    return res.text().then(function (body) {
                        if (/not authorized|unauthorized|token/i.test(body)) {
                            reportUnavailable(self, CONFIG.AUTH_MESSAGE);
                        }
                    });
                }
                if (type && type.indexOf('json') !== -1) {
                    // Proxy mode: {"error":"dataforsyningen_token_missing"} is
                    // a deployment without the variable — a configuration
                    // problem, not an invalid token the visitor could fix.
                    return res.json().then(function (body) {
                        var code = String((body && body.error) || '');
                        if (code.indexOf('token_missing') !== -1) {
                            reportUnavailable(self, CONFIG.TOKEN_MISSING_MESSAGE);
                        } else if (/token|auth/i.test(code)) {
                            reportUnavailable(self, CONFIG.AUTH_MESSAGE);
                        }
                    });
                }
                return null;
            })['catch'](function () {
                // Network/CORS failure: say nothing rather than guess.
            });
        },

        /* ── public helpers ──────────────────────────────────────────────── */

        /** Switch product in place. Both share the View1 grid. */
        setMode: function (key) {
            if (!CONFIG.MODES[key] || key === this.options.mode) return this;
            this.options.mode = key;
            this._warned = false;
            if (this._map) this.redraw();
            return this;
        },

        getMode: function () { return this.options.mode; }
    });

    function createLayer(options) {
        return new DataforsyningenDHMLayer(options || {});
    }

    root.DataforsyningenDHM = {
        CONFIG: CONFIG,
        MODES: CONFIG.MODES,
        BLANK_TILE: BLANK_TILE,
        Layer: DataforsyningenDHMLayer,

        // projections & grid — exported so the test suite can check them
        UTM: UTM,
        GRID: GRID,
        webMercator: {
            x: mercatorX, y: mercatorY, lon: mercatorLon, lat: mercatorLat,
            resolution: webMercatorResolution, HALF: MERC_HALF, R: MERC_R
        },
        invertAffine: invertAffine,

        endpoint: endpoint,
        source: source,
        isProxied: isProxied,
        tileUrl: tileUrl,
        createLayer: createLayer,
        showAuthNotice: showAuthNotice,
        reportUnavailable: reportUnavailable,
        clearSourceCache: clearSourceCache,
        modeKeys: function () { return Object.keys(CONFIG.MODES); }
    };
})(typeof window !== 'undefined' ? window : this);
