/* =====================================================================
 * other-maps-tiles.js — Hungaricana ECW pyramid reader (no georeference)
 * ---------------------------------------------------------------------
 * The non-georeferenced sheets on maps.hungaricana.hu are served as an ECW
 * tile pyramid from static-cdn.hungaricana.hu.  A tile is addressed by a
 * 32-character hash rather than by /z/x/y:
 *
 *     https://static-cdn.hungaricana.hu/tile/image/<path>/<hash>
 *
 * where <path> is the ECW path of the sheet (e.g.
 * maps/mol/s011/s11_0647/s11_0647.ecw) and
 *
 *     hash = AES-128-CBC(key "dGhpcyBpcyBubyBr", iv 0) of
 *            `${sumAscii(path) % 100}|${z}|${x}|${y}` padded with '*' to
 *            16 bytes, first 16 ciphertext bytes, hex.
 *
 * (The scheme was reverse-engineered by dezoomify — lovasoa/dezoomify,
 * issue #346 — and is re-implemented here with the WebCrypto API so the
 * app can paint these sheets itself, at any rotation, without a plugin.)
 *
 * The pyramid's natural size is published by a sibling endpoint
 * (`/tile/imagesize/<path>` → {width, height}).  That endpoint is not
 * guaranteed to be readable from a browser (CORS), so the module also has a
 * probe fallback: it asks for tile (0,0,z) with growing z to find the
 * deepest level, then walks the top row / left column to count tiles.  Both
 * results are cached in localStorage so a sheet is probed once, not on
 * every visit.
 *
 * Public API: window.DetectLabOtherMapsTiles —
 *   thumbUrl(path)              → small preview (no hash needed)
 *   recordUrl(id)               → human-readable Hungaricana page
 *   tileUrl(path, x, y, z)      → Promise<string>
 *   resolve(path, hint)         → Promise<{w, h, maxZoom, probed}>
 *   clearCache()
 * ===================================================================== */
(function (root) {
    'use strict';

    var DEFAULT_BASES = {
        tile: 'https://static-cdn.hungaricana.hu/tile/image/',
        thumb: 'https://static-cdn.hungaricana.hu/tile/thumb/',
        size: 'https://static-cdn.hungaricana.hu/tile/imagesize/',
        record: 'https://maps.hungaricana.hu/en/'
    };

    var TILE_SIZE = 512;
    var MAX_LEVEL = 12;
    var AES_KEY = 'dGhpcyBpcyBubyBr';
    var CACHE_KEY = 'dlOtherMaps.pyramid.v1';

    var bases = Object.assign({}, DEFAULT_BASES);
    var _keyPromise = null;
    var _hashCache = Object.create(null);
    var _metaCache = Object.create(null);
    var _inflight = Object.create(null);

    /* ── tiny helpers ─────────────────────────────────────────────────── */
    function encodeUtf8(text) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
        var bytes = [];
        var value = String(text);
        for (var i = 0; i < value.length; i++) {
            var code = value.charCodeAt(i);
            if (code < 0x80) bytes.push(code);
            else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
        return new Uint8Array(bytes);
    }

    function toHex(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i++) {
            var hex = bytes[i].toString(16);
            out += hex.length === 1 ? '0' + hex : hex;
        }
        return out;
    }

    /* Same value dezoomify uses: the sum of the UTF-16 code units, mod 100. */
    function pathSum(path) {
        var sum = 0;
        var value = String(path || '');
        for (var i = 0; i < value.length; i++) sum += value.charCodeAt(i);
        return sum;
    }

    function readStore() {
        try {
            var raw = root.localStorage && root.localStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) || {} : {};
        } catch (e) { return {}; }
    }

    function writeStore(store) {
        try {
            if (root.localStorage) root.localStorage.setItem(CACHE_KEY, JSON.stringify(store));
        } catch (e) { /* private mode / quota — the probe simply re-runs */ }
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

    /* ── the tile hash ────────────────────────────────────────────────── */
    function aesKey() {
        if (_keyPromise) return _keyPromise;
        if (!(root.crypto && root.crypto.subtle && typeof root.crypto.subtle.importKey === 'function')) {
            _keyPromise = Promise.reject(new Error('WebCrypto unavailable (needs https or localhost)'));
        } else {
            _keyPromise = root.crypto.subtle.importKey(
                'raw', encodeUtf8(AES_KEY), { name: 'AES-CBC' }, false, ['encrypt']
            );
        }
        return _keyPromise;
    }

    /* dezoomify documents the plaintext as `sum|x|y|z` in issue #346 but the
     * implementation it shipped (legacy/dezoomers/hungaricana.js and
     * dezoomify-rs) encrypts `sum|z|x|y`.  Rather than bet on one reading of
     * a note, the module has both orders, uses the one that answered last and
     * flips over on the first failure. */
    var ORDERS = {
        zxy: function (sum, x, y, z) { return sum + '|' + z + '|' + x + '|' + y; },
        xyz: function (sum, x, y, z) { return sum + '|' + x + '|' + y + '|' + z; }
    };
    var _order = (function () {
        try { return root.localStorage && root.localStorage.getItem(CACHE_KEY + '.order') === 'xyz' ? 'xyz' : 'zxy'; }
        catch (e) { return 'zxy'; }
    })();

    function preferredOrder() { return _order; }
    function alternateOrder() { return _order === 'zxy' ? 'xyz' : 'zxy'; }

    function noteOrder(order) {
        if (!ORDERS[order] || order === _order) return;
        _order = order;
        _hashCache = Object.create(null);
        try { if (root.localStorage) root.localStorage.setItem(CACHE_KEY + '.order', order); } catch (e) { /* ignore */ }
    }

    function hashFor(path, x, y, z, order) {
        var cacheKey = (order || _order) + '|' + path + '|' + z + '|' + x + '|' + y;
        if (_hashCache[cacheKey]) return _hashCache[cacheKey];

        var plaintext = ORDERS[order || _order](pathSum(path) % 100, x, y, z);
        while (plaintext.length < 16) plaintext += '*';

        var promise = aesKey().then(function (key) {
            return root.crypto.subtle.encrypt(
                { name: 'AES-CBC', iv: new Uint8Array(16) }, key, encodeUtf8(plaintext)
            );
        }).then(function (buffer) {
            // AES-CBC appends a full pad block; the first ciphertext block is
            // the value the portal expects.
            return toHex(new Uint8Array(buffer).slice(0, 16));
        });
        _hashCache[cacheKey] = promise;
        return promise;
    }

    function tileUrlWithOrder(order) {
        return function (path, x, y, z) {
            if (!path) return Promise.resolve('');
            return hashFor(path, x, y, z, order).then(function (hash) {
                return bases.tile + path + '/' + hash;
            });
        };
    }

    function tileUrl(path, x, y, z) { return tileUrlWithOrder(_order)(path, x, y, z); }
    function tileUrlAlt(path, x, y, z) { return tileUrlWithOrder(alternateOrder())(path, x, y, z); }

    /* ── size discovery ───────────────────────────────────────────────── */
    function maxZoomFor(width, height) {
        var longest = Math.max(Number(width) || 0, Number(height) || 0);
        var zoom = 0;
        var covered = TILE_SIZE;
        while (covered < longest && zoom < MAX_LEVEL) { covered *= 2; zoom++; }
        return zoom;
    }

    function tileLoads(url) {
        return new Promise(function (resolve) {
            var img = new Image();
            var settled = false;
            function done(ok) {
                if (settled) return;
                settled = true;
                img.onload = img.onerror = null;
                resolve(ok);
            }
            img.onload = function () { done(img.naturalWidth > 0); };
            img.onerror = function () { done(false); };
            img.src = url;
            // A hung request must not freeze the probe forever.
            root.setTimeout(function () { done(false); }, 12000);
        });
    }

    /* Answers true for the first order that returns an image and switches the
     * module over to it, so the ambiguity above is settled by the server once,
     * on the first probe, instead of by guesswork. */
    function tileExists(path, x, y, z) {
        return tileUrl(path, x, y, z).then(tileLoads).then(function (ok) {
            if (ok) return true;
            return tileUrlAlt(path, x, y, z).then(tileLoads).then(function (okAlt) {
                if (okAlt) noteOrder(alternateOrder());
                return okAlt;
            });
        });
    }

    /* Walk the top row / left column of the deepest level to learn how many
     * tiles the image spans.  Only used when /tile/imagesize is unreadable. */
    function probeSpan(path, maxZoom, axis) {
        var limit = 64;
        var index = 1;
        function step() {
            if (index > limit) return Promise.resolve(index);
            var x = axis === 'x' ? index : 0;
            var y = axis === 'x' ? 0 : index;
            return tileExists(path, x, y, maxZoom).then(function (ok) {
                if (!ok) return index;
                index++;
                return step();
            });
        }
        return step();
    }

    function probePyramid(path) {
        var level = 0;
        function nextLevel() {
            if (level > MAX_LEVEL) return Promise.resolve(Math.max(0, MAX_LEVEL));
            return tileExists(path, 0, 0, level).then(function (ok) {
                if (!ok) return Math.max(0, level - 1);
                level++;
                return nextLevel();
            });
        }
        return nextLevel().then(function (maxZoom) {
            return Promise.all([
                probeSpan(path, maxZoom, 'x', 64),
                probeSpan(path, maxZoom, 'y', 64)
            ]).then(function (spans) {
                return {
                    w: Math.max(TILE_SIZE, spans[0] * TILE_SIZE),
                    h: Math.max(TILE_SIZE, spans[1] * TILE_SIZE),
                    maxZoom: maxZoom,
                    probed: true
                };
            });
        });
    }

    function fetchSize(path) {
        if (typeof root.fetch !== 'function') return Promise.resolve(null);
        return root.fetch(bases.size + path, { mode: 'cors', cache: 'force-cache' })
            .then(function (response) {
                if (!response || !response.ok) return null;
                return response.json();
            })
            .then(function (json) {
                if (!json || !json.width || !json.height) return null;
                return {
                    w: Number(json.width),
                    h: Number(json.height),
                    maxZoom: maxZoomFor(json.width, json.height),
                    probed: false
                };
            })
            .catch(function () { return null; });
    }

    /**
     * Resolve the natural pixel size of a sheet.
     * @param {string} path  ECW path of the sheet.
     * @param {{w?:number,h?:number}} [hint] size already known from the catalogue.
     */
    function resolve(path, hint) {
        if (!path) return Promise.reject(new Error('missing sheet path'));
        var cached = cachedMeta(path);
        if (cached) return Promise.resolve(cached);
        if (_inflight[path]) return _inflight[path];

        var task;
        if (hint && hint.w && hint.h) {
            var size = { w: Number(hint.w), h: Number(hint.h), maxZoom: maxZoomFor(hint.w, hint.h), probed: false };
            rememberMeta(path, size);
            task = Promise.resolve(size);
        } else {
            task = fetchSize(path).then(function (meta) {
                if (meta) return meta;
                return probePyramid(path);
            }).then(function (meta) {
                rememberMeta(path, meta);
                return meta;
            });
        }
        _inflight[path] = task;
        task.then(function () { delete _inflight[path]; },
            function () { delete _inflight[path]; });
        return task;
    }

    root.DetectLabOtherMapsTiles = {
        TILE_SIZE: TILE_SIZE,
        MAX_LEVEL: MAX_LEVEL,
        configure: function (overrides) {
            Object.assign(bases, DEFAULT_BASES, overrides || {});
        },
        bases: function () { return Object.assign({}, bases); },
        thumbUrl: function (path) { return path ? bases.thumb + path : ''; },
        recordUrl: function (id) {
            if (!id) return bases.record;
            return bases.record + id + '/view/';
        },
        tileUrl: tileUrl,
        tileUrlAlt: tileUrlAlt,
        preferredOrder: preferredOrder,
        alternateOrder: alternateOrder,
        noteOrder: noteOrder,
        maxZoomFor: maxZoomFor,
        resolve: resolve,
        clearCache: function () {
            _hashCache = Object.create(null);
            _metaCache = Object.create(null);
            try { if (root.localStorage) root.localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
        }
    };
}(typeof window !== 'undefined' ? window : this));
