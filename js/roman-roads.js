/* ============================================================================
 * roman-roads.js — the Roman-road canvas layer
 * ----------------------------------------------------------------------------
 * WHY (the report this module answers: "Roman roads load really slow, the PWA
 * sits at 4 %, and the page crashes — desktop and PWA alike")
 *   1. Every NDJSON record used to become an `L.polyline`, i.e. one SVG
 *      <path> per road segment. A continental network is tens of thousands of
 *      paths; the tab dies long before the file is read.
 *   2. Parsing, geometry building and DOM insertion ran on the main thread,
 *      in the same task that pumps the HTTP stream — so the download itself
 *      crawled and the byte counter seemed frozen at 4 %.
 *   3. Nothing was culled or simplified per zoom: the whole dataset was
 *      decoded, kept and re-clipped on every gesture.
 *
 * WHAT
 *   One `L.GridLayer` whose tiles are small canvases. All ingest happens in
 *   `js/roman-roads-worker.js` (see `js/roman-roads-parser.js` for the binary
 *   format); the main thread only appends finished typed arrays and paints
 *   the tiles the viewport actually shows:
 *
 *     • spatial grid per batch → a tile visits only the segments inside it;
 *     • sub-pixel segments are drawn as dots, long ones through a decimated
 *       vertex loop, everything in ONE canvas path per tile;
 *     • a per-tile item budget plus uniform stride sampling keeps the work
 *       bounded no matter how big the network is;
 *     • painting is scheduled in animation frames with a millisecond budget,
 *       so a burst of new data can never block the UI;
 *     • the 3D mirror keeps its roads: `_dl3dFeatures()` hands MapLibre a
 *       bounded GeoJSON view of the same geometry (see MAP_3D_TERRAIN.md §6).
 *
 *   Leaflet keeps doing what it is good at (tiles, zoom animation, rotation,
 *   retention), so the layer behaves like every other layer of the app —
 *   including `js/tile-perf.js`, whose gesture-safe defaults are inherited.
 *
 * Exposes `window.DetectLabRomanRoads`:
 *   .createLayer({opacity, color, ...})  → an L.GridLayer for the roads
 *   .load(url, {onProgress, onBatch, onDone, onError}) → {cancel()}
 *   .configForDevice()                   → parser budgets for this device
 * ========================================================================== */
(function (root) {
    'use strict';
    if (!root || !root.document) return;

    var VERSION = '20261015-roman-roads-v1';

    function parser() { return root.DetectLabRomanRoadsParser; }

    function now() {
        return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    }

    /* ── budgets ───────────────────────────────────────────────────────────
       Geometry is typed arrays: ~36 B per segment + 8 B per vertex. A phone
       gets a smaller allowance than a desktop, and the collector samples
       (uniform stride, long roads always kept) once the allowance is spent
       instead of growing until the renderer kills the tab. */
    function configForDevice() {
        var ua = String(root.navigator && root.navigator.userAgent || '');
        var coarse = !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches);
        var small = Math.min(root.innerWidth || 1024, root.innerHeight || 768) <= 820;
        var phone = coarse && small || /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
        var maxBytes = phone ? 40 * 1024 * 1024 : 96 * 1024 * 1024;
        return {
            maxBytes: maxBytes,
            maxSegments: phone ? 350000 : 900000,
            maxVertices: phone ? 3000000 : 9000000,
            maxBatchSegments: phone ? 4000 : 6000
        };
    }

    /* The worker is versioned exactly like the script that created it, so a
     * PWA never runs a stale worker against a fresh parser (or vice versa). */
    function workerUrl() {
        if (root.DetectLabRomanRoadsWorkerUrl) return root.DetectLabRomanRoadsWorkerUrl;
        var src = 'js/roman-roads-worker.js';
        try {
            var tags = root.document.querySelectorAll('script[src*="roman-roads.js"]');
            var tag = tags && tags.length ? tags[tags.length - 1] : null;
            if (tag) {
                var abs = tag.src || tag.getAttribute('src') || '';
                var query = '';
                var qi = abs.indexOf('?');
                if (qi !== -1) { query = abs.slice(qi); abs = abs.slice(0, qi); }
                src = abs.replace(/roman-roads\.js$/, 'roman-roads-worker.js') + query;
            }
        } catch (e) { /* keep the default */ }
        return src;
    }

    /* ── the loader ────────────────────────────────────────────────────────
       `onBatch(payload, stats)` receives binary geometry; `onProgress` is
       called often enough for a live status line but never per line. */
    function load(url, opts) {
        opts = opts || {};
        var P = parser();
        var cfg = opts.config || configForDevice();
        var state = { cancelled: false, worker: null, done: false };
        /* Once the worker has handed over geometry, restarting the ingest on
         * the main thread would append the same roads a second time. */
        var delivered = 0;

        function emitDone(stats) {
            if (state.cancelled || state.done) return;
            state.done = true;
            if (opts.onDone) { try { opts.onDone(stats || {}); } catch (e) { report(e); } }
        }
        function emitError(message) {
            if (state.cancelled) return;
            if (opts.onError) { try { opts.onError(message); } catch (e) { report(e); } }
        }
        function report(e) {
            if (root.console && console.warn) console.warn('[RomanRoads]', e && e.message ? e.message : e);
        }

        if (!P) {
            emitError('roads parser not loaded');
            return { cancel: function () {} };
        }

        /* Worker first: nothing of the ingest belongs on the main thread. */
        if (!opts.noWorker && root.Worker) {
            var w = null;
            try { w = new root.Worker(workerUrl()); } catch (e) { w = null; }
            if (w) {
                state.worker = w;
                w.onmessage = function (event) {
                    var msg = event.data || {};
                    if (state.cancelled) return;
                    if (msg.type === 'batch') {
                        delivered++;
                        if (opts.onBatch) {
                            try { opts.onBatch(msg.payload, msg.stats); } catch (err) { report(err); }
                        }
                        /* Ack = backpressure: the worker keeps at most four
                         * un-consumed payloads in flight. */
                        try { w.postMessage({ cmd: 'ack' }); } catch (e2) {}
                    } else if (msg.type === 'progress') {
                        if (opts.onProgress) { try { opts.onProgress(msg); } catch (e3) { report(e3); } }
                    } else if (msg.type === 'done') {
                        emitDone(msg.stats);
                    } else if (msg.type === 'error') {
                        emitError(msg.message);
                    }
                };
                w.onerror = function () {
                    /* The worker itself could not run (CSP, blocked blob, ...):
                     * fall back to the same pipeline on the main thread — but
                     * only while nothing has been handed over yet, otherwise
                     * the geometry would arrive twice. */
                    if (!state.cancelled && !state.done) {
                        try { w.terminate(); } catch (e4) {}
                        state.worker = null;
                        if (delivered) { emitError('roads stream stopped mid-way'); return; }
                        mainThread(url, opts, cfg, state, emitDone, emitError, report);
                    }
                };
                try {
                    w.postMessage({ cmd: 'start', url: url, config: cfg });
                } catch (e5) {
                    try { w.terminate(); } catch (e6) {}
                    state.worker = null;
                    mainThread(url, opts, cfg, state, emitDone, emitError, report);
                }
                return {
                    cancel: function () {
                        state.cancelled = true;
                        if (state.worker) {
                            try { state.worker.postMessage({ cmd: 'cancel' }); } catch (e7) {}
                            try { state.worker.terminate(); } catch (e8) {}
                        }
                    },
                    isWorker: true
                };
            }
        }
        mainThread(url, opts, cfg, state, emitDone, emitError, report);
        return { cancel: function () { state.cancelled = true; }, isWorker: false };
    }

    /* Same parser, same binary format — just without a worker (no separate
     * thread available). The chunk loop yields between chunks so the page
     * stays responsive even here. */
        function mainThread(url, opts, cfg, state, emitDone, emitError, report) {
        var P = parser();
        var collector = P.createCollector(cfg);
        var lines = 0, bytes = 0, total = 0, lastProgress = 0, started = now();
        /* The collector thins arrivals by `estimated total / budget`; the only
         * place that knows the total is this side of the socket. */
        function noteChunk(len) {
            bytes += len;
            if (total) collector.setSourceTotal(total);
            if (collector.noteSourceBytes) collector.noteSourceBytes(len);
        }

        function progress(force) {
            var t = now();
            if (!force && t - lastProgress < 250) return;
            lastProgress = t;
            var s = collector.stats();
            if (opts.onProgress) {
                try {
                    opts.onProgress({ bytes: bytes, total: total, lines: lines, segments: s.segments,
                        vertices: s.vertices, seen: s.seen, sampled: s.sampled, stride: s.stride,
                        elapsed: Math.round(t - started) });
                } catch (e) { report(e); }
            }
        }
        function flush(force) {
            if (!collector.stats().segments) return;
            if (!force && !collector.shouldFlush()) return;
            var framed = collector.flush();
            if (!framed) return;
            if (opts.onBatch) {
                try { opts.onBatch(framed.payload, framed.payload.stats); } catch (e) { report(e); }
            }
        }
        function handleLine(line) {
            lines++;
            var rec;
            if (line.charCodeAt(0) === 123) {
                try { rec = JSON.parse(line); } catch (e) { return; }
            } else if (/^(LINESTRING|MULTILINESTRING|\[)/i.test(line)) {
                rec = line;
            } else return;
            collector.addRecord(rec);
        }
        function yieldToPage() {
            return new Promise(function (resolve) { root.setTimeout(resolve, 0); });
        }

        if (typeof root.fetch !== 'function' || typeof root.TextDecoder !== 'function') {
            emitError('streaming fetch unavailable');
            return;
        }

        root.fetch(url, { credentials: 'omit' })
            .then(function (resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                total = +resp.headers.get('content-length') || 0;
                progress(true);
                collector.setSourceTotal && collector.setSourceTotal(total);
                if (!resp.body || !resp.body.getReader) {
                    return resp.text().then(function (text) {
                        text.split('\n').forEach(function (l) { if (l.trim()) handleLine(l.trim()); });
                    });
                }
                var reader = resp.body.getReader();
                var decoder = new root.TextDecoder();
                var buf = '';
                function pump() {
                    return reader.read().then(function (res) {
                        if (state.cancelled) { try { reader.cancel(); } catch (e) {} return; }
                        if (res.done) {
                            buf += decoder.decode();
                            if (buf.trim()) handleLine(buf.trim());
                            return;
                        }
                        noteChunk(res.value.length);
                        buf += decoder.decode(res.value, { stream: true });
                        var i, start = 0;
                        while ((i = buf.indexOf('\n', start)) >= 0) {
                            var line = buf.slice(start, i).trim();
                            start = i + 1;
                            if (line) handleLine(line);
                        }
                        buf = buf.slice(start);
                        flush(false);
                        progress(false);
                        /* A yield keeps the main thread free for the map even
                         * in the no-worker fallback. */
                        return yieldToPage().then(pump);
                    });
                }
                return pump();
            })
            .then(function () {
                if (state.cancelled) return;
                flush(true);
                progress(true);
                emitDone(collector.stats());
            })
            .catch(function (err) { emitError(String((err && err.message) || err)); });
    }

    /* ── the canvas layer ──────────────────────────────────────────────────── */

    var RoadsLayer = null;

    function ensureLayerClass() {
        var L = root.L;
        if (RoadsLayer || !L || !L.GridLayer || !L.GridLayer.extend) return RoadsLayer;

        RoadsLayer = L.GridLayer.extend({
            options: {
                pane: 'pane_roman',
                name: 'Roman roads',
                attribution: '© AWMC / DARMC',
                color: '#FF5A36',
                weight: 1.8,
                opacity: 0.7,
                tileSize: 256,
                /* Gesture safety, inherited semantics of MAP_LAYER_PERFORMANCE.md:
                 * no tile churn while a zoom animates, work merged per gesture. */
                updateWhenZooming: false,
                updateWhenIdle: true,
                keepBuffer: 1,
                /* Painting */
                maxItemsPerTile: 16000,
                minPixelStep: 0.45,
                dotMaxZoom: 7,
                dotPixelSize: 2,
                frameMsBudget: 6,
                tileMsBudget: 26,
                gridUseZoom: 9,
                max3dFeatures: 25000,
                interactive: false
            },

            initialize: function (options) {
                L.Util.setOptions(this, options);
                this._pages = [];
                this._segments = 0;
                this._vertices = 0;
                this._version = 0;
                this._paintQueue = [];
                this._paintScheduled = false;
                this._dirty = null;
                this._itemBudget = this.options.maxItemsPerTile;
                this._3dCache = null;
                this._stats = {
                    pages: 0, segments: 0, vertices: 0, skipped: 0, sampled: 0, stride: 1,
                    paintedTiles: 0, lastPaintMs: 0, budgetItems: this._itemBudget, bytes: 0
                };
            },

            onAdd: function (map) {
                L.GridLayer.prototype.onAdd.call(this, map);
                if (this._updateOpacity) this._updateOpacity();
                this._schedulePaint();
            },

            onRemove: function (map) {
                this._paintQueue.length = 0;
                L.GridLayer.prototype.onRemove.call(this, map);
            },

            /* createTile is deliberately a ONE-argument function: Leaflet then
             * marks the tile ready on the next frame by itself (it checks
             * `createTile.length < 2`), and we never have to hand out a
             * half-painted canvas synchronously. Painting itself is queued and
             * time-sliced, so a burst of tiles cannot block a frame. */
            createTile: function (coords) {
                var size = this.getTileSize().x;
                var dpr = this._dprFor();
                var canvas = root.document.createElement('canvas');
                canvas.width = Math.round(size * dpr);
                canvas.height = Math.round(size * dpr);
                canvas.className = 'leaflet-tile dl-roman-roads-tile';
                /* The roads are decoration: never swallow a map gesture, a
                 * pin tap or a popup click (pane_roman is pointer-events:auto
                 * for the DARE/AWMC layers that do need the pointer). */
                canvas.style.pointerEvents = 'none';
                var entry = {
                    key: this._tileKey(coords),
                    coords: coords,
                    el: canvas,
                    ctx: canvas.getContext('2d'),
                    dpr: dpr,
                    version: -1,
                    queued: false,
                    painted: false
                };
                canvas._dlRomanEntry = entry;
                this._queuePaint(entry);
                return canvas;
            },

            /* ── data in ─────────────────────────────────────────────────── */

            addBatch: function (payload) {
                if (!payload || !payload.n) return this;
                var page = payload;
                this._pages.push(page);
                this._segments += payload.n;
                this._vertices += payload.vertices || 0;
                this._version++;
                this._stats.pages = this._pages.length;
                this._stats.segments = this._segments;
                this._stats.vertices = this._vertices;
                this._stats.bytes = this._geometryBytes();
                var s = payload.stats || {};
                this._stats.skipped += s.skipped || 0;
                this._stats.sampled = Math.max(this._stats.sampled, s.sampled || 0);
                if (s.stride) this._stats.stride = s.stride;
                this._markDirty(payload.extent);
                this._3dCache = null;
                this._schedulePaint();
                return this;
            },

            clearData: function () {
                this._pages.length = 0;
                this._segments = 0;
                this._vertices = 0;
                this._version++;
                this._3dCache = null;
                this._stats.segments = 0;
                this._stats.vertices = 0;
                this._stats.pages = 0;
                this._stats.bytes = 0;
                this._dirty = null;
                if (this._map) this.redraw();
                return this;
            },

            _geometryBytes: function () {
                var b = 0;
                for (var i = 0; i < this._pages.length; i++) {
                    var p = this._pages[i];
                    b += p.n * 36 + (p.vertices || 0) * 8;
                }
                return b;
            },

            getStats: function () {
                var s = {};
                for (var k in this._stats) if (Object.prototype.hasOwnProperty.call(this._stats, k)) s[k] = this._stats[k];
                s.budgetItems = Math.round(this._itemBudget);
                s.version = VERSION;
                return s;
            },

            /* ── opacity / style ────────────────────────────────────────── */

            setOpacity: function (opacity) {
                this.options.opacity = opacity;
                /* Leaflet's own bookkeeping puts the layer opacity on the tile
                 * CONTAINER when the map is not fade-animated (which is the
                 * case on the governed map, see js/tile-perf.js) — so the
                 * slider never needs a repaint of thousands of tiles. */
                if (this._map && this._updateOpacity) this._updateOpacity();
                return this;
            },

            setColor: function (color) {
                this.options.color = color;
                this._3dCache = null;
                this._repaintAll();
                return this;
            },

            /* ── painting ───────────────────────────────────────────────── */

            _dprFor: function () {
                var dpr = root.devicePixelRatio || 1;
                return dpr > 2 ? 2 : dpr;           /* bound the tile memory */
            },

            _tileKey: function (coords) {
                if (this._tileCoordsToKey) return this._tileCoordsToKey(coords);
                return coords.x + ':' + coords.y + ':' + coords.z;
            },

            /* Mercator extent of one tile, written into `out`. */
            _tileRect: function (coords, out) {
                var P = parser();
                var size = this.getTileSize().x;
                var scale = 256 * Math.pow(2, coords.z);
                var k = P.PX_A * scale;
                var gx0 = coords.x * size, gy1 = (coords.y + 1) * size;
                out.minX = (gx0 - 0.5 * scale) / k;
                out.maxX = (gx0 + size - 0.5 * scale) / k;
                out.minY = (0.5 * scale - gy1) / k;
                out.maxY = (0.5 * scale - coords.y * size) / k;
                return out;
            },

            _markDirty: function (extent) {
                if (!extent) { this._dirty = 'all'; return; }
                if (this._dirty === 'all') return;
                if (!this._dirty) {
                    this._dirty = { minX: extent[0], minY: extent[1], maxX: extent[2], maxY: extent[3] };
                    return;
                }
                var d = this._dirty;
                if (extent[0] < d.minX) d.minX = extent[0];
                if (extent[1] < d.minY) d.minY = extent[1];
                if (extent[2] > d.maxX) d.maxX = extent[2];
                if (extent[3] > d.maxY) d.maxY = extent[3];
            },

            _queuePaint: function (entry) {
                if (!entry || entry.queued) return;
                entry.queued = true;
                this._paintQueue.push(entry);
                this._schedulePaint();
            },

            _schedulePaint: function () {
                if (this._paintScheduled || !this._map) return;
                this._paintScheduled = true;
                var self = this;
                var raf = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
                raf(function () {
                    self._paintScheduled = false;
                    self._drainPaintQueue();
                });
            },

            /* Turn the dirty rect into a concrete list of tiles to repaint. */
            _flushDirty: function () {
                var dirty = this._dirty;
                this._dirty = null;
                if (!dirty || !this._tiles) return;
                var rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                for (var key in this._tiles) {
                    var record = this._tiles[key];
                    var entry = record && record.el && record.el._dlRomanEntry;
                    if (!entry) continue;
                    if (dirty !== 'all') {
                        this._tileRect(entry.coords, rect);
                        if (rect.maxX < dirty.minX || rect.minX > dirty.maxX ||
                            rect.maxY < dirty.minY || rect.minY > dirty.maxY) continue;
                    }
                    this._queuePaint(entry);
                }
            },

            _drainPaintQueue: function () {
                if (!this._map) { this._paintQueue.length = 0; return; }
                this._flushDirty();
                var budget = this.options.frameMsBudget;
                var start = now();
                while (this._paintQueue.length) {
                    var entry = this._paintQueue.shift();
                    entry.queued = false;
                    if (!entry.el || !entry.el.parentNode) continue;      /* pruned */
                    if (entry.version === this._version) continue;        /* up to date */
                    this._paintEntry(entry);
                    if (now() - start >= budget) break;
                }
                if (this._paintQueue.length) this._schedulePaint();
            },

            _repaintAll: function () {
                this._version++;
                this._dirty = 'all';
                if (this._map) this._schedulePaint();
                return this;
            },

            _paintEntry: function (entry) {
                var P = parser();
                var t0 = now();
                var size = this.getTileSize().x;
                var dpr = entry.dpr || 1;
                var canvas = entry.el, ctx = entry.ctx, opts = this.options;
                var px = Math.round(size * dpr);
                if (canvas.width !== px || canvas.height !== px) {
                    canvas.width = px;
                    canvas.height = px;
                }
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, size, size);
                entry.version = this._version;
                entry.painted = true;
                if (!this._pages.length) { entry.blank = true; return; }

                var z = entry.coords.z;
                var scale = 256 * Math.pow(2, z);
                var k = P.PX_A * scale;
                var gx0 = entry.coords.x * size, gy0 = entry.coords.y * size;
                var ox = 0.5 * scale - gx0;
                var oy = 0.5 * scale - gy0;
                var halfLine = opts.weight / 2 / k;      /* metres, for the bbox pad */
                var q = {
                    minX: (gx0 - 0.5 * scale) / k - halfLine,
                    maxX: (gx0 + size - 0.5 * scale) / k + halfLine,
                    minY: (0.5 * scale - gy0 - size) / k - halfLine,
                    maxY: (0.5 * scale - gy0) / k + halfLine
                };

                var dotMode = z <= opts.dotMaxZoom;
                var minPx = opts.minPixelStep;
                var stride = z < opts.gridUseZoom
                    ? Math.max(1, Math.round(this._segments / Math.max(1, this._itemBudget)))
                    : 1;
                var itemBudget = this._itemBudget;
                var drawn = 0;
                var capped = false;
                var self = this;

                ctx.save();
                ctx.beginPath();
                ctx.rect(0, 0, size, size);
                ctx.clip();
                ctx.strokeStyle = opts.color;
                ctx.fillStyle = opts.color;
                ctx.lineWidth = opts.weight;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                /* One path for every line of the tile: a single stroke() is
                 * what makes this fast — thousands of strokes is what made
                 * the old layer (and its thousands of SVG paths) crawl. */
                ctx.beginPath();

                var pass = function (draw) {
                    for (var p = 0; p < self._pages.length; p++) {
                        var page = self._pages[p];
                        if (!page.extent) continue;
                        if (page.extent[2] < q.minX || page.extent[0] > q.maxX ||
                            page.extent[3] < q.minY || page.extent[1] > q.maxY) continue;
                        var seen = 0;
                        self._forEachPageRange(z, page, q, function (from, to, items) {
                            var bounds = page.bounds;
                            for (var s = from; s < to; s++) {
                                var i = items[s];
                                if (stride > 1 && (seen++ % stride) !== 0) continue;
                                var b0 = i * 4;
                                var loX = bounds[b0], loY = bounds[b0 + 1];
                                var hiX = bounds[b0 + 2], hiY = bounds[b0 + 3];
                                if (hiX < q.minX || loX > q.maxX || hiY < q.minY || loY > q.maxY) continue;
                                if (draw) {
                                    if (drawn >= itemBudget) { capped = true; continue; }
                                    drawn++;
                                    self._drawSegment(ctx, page, i, k, ox, oy, minPx, dotMode, opts);
                                } else {
                                    drawn++;
                                }
                            }
                        });
                    }
                };

                /* Pass 1 sizes the work (so the per-tile budget can sample it
                 * uniformly), pass 2 draws. When the global stride already
                 * caps the work at low zoom, one pass is enough. */
                if (stride > 1) {
                    pass(true);
                } else {
                    drawn = 0;
                    pass(false);
                    if (drawn > itemBudget) {
                        stride = Math.ceil(drawn / itemBudget);
                        drawn = 0;
                    } else {
                        drawn = 0;
                    }
                    pass(true);
                }
                ctx.stroke();
                ctx.restore();

                var elapsed = now() - t0;
                this._stats.paintedTiles++;
                this._stats.lastPaintMs = Math.round(elapsed * 10) / 10;
                this._stats.cappedTiles = (this._stats.cappedTiles || 0) + (capped ? 1 : 0);
                this._adaptBudget(elapsed);
            },

            /* Self-tuning: keep a tile around a few milliseconds on THIS
             * device instead of a number guessed here. */
            _adaptBudget: function (elapsed) {
                var max = this.options.maxItemsPerTile;
                if (elapsed > this.options.tileMsBudget && this._itemBudget > 1500) {
                    this._itemBudget = Math.max(1500, Math.floor(this._itemBudget * 0.7));
                } else if (elapsed < 6 && this._itemBudget < max) {
                    this._itemBudget = Math.min(max, Math.ceil(this._itemBudget * 1.15));
                }
            },

            /* Sub-pixel segments are drawn as a dot (the old SVG cloud was
             * nothing but specks at that zoom); everything else through a
             * screen-space decimated vertex loop — one path, no per-vertex
             * object, no trigonometry. */
            _drawSegment: function (ctx, page, i, k, ox, oy, minPx, dotMode, opts) {
                var bounds = page.bounds;
                var b0 = i * 4;
                var loX = bounds[b0], loY = bounds[b0 + 1], hiX = bounds[b0 + 2], hiY = bounds[b0 + 3];
                var wPx = (hiX - loX) * k, hPx = (hiY - loY) * k;
                var start = page.starts[i], end = page.starts[i + 1];
                var px = page.origins[i * 2], py = page.origins[i * 2 + 1];
                var dotSize = opts.dotPixelSize;

                if (end - start < 2) {
                    var mx0 = (loX + hiX) * 0.5, my0 = (loY + hiY) * 0.5;
                    var sx0 = mx0 * k + ox, sy0 = -my0 * k + oy;
                    ctx.fillRect(sx0 - dotSize / 2, sy0 - dotSize / 2, dotSize, dotSize);
                    return;
                }

                if (dotMode && (wPx + hPx) < dotSize + 0.5) {
                    var cx = (loX + hiX) * 0.5, cy = (loY + hiY) * 0.5;
                    var dx = cx * k + ox, dy = -cy * k + oy;
                    ctx.fillRect(dx - dotSize / 2, dy - dotSize / 2, dotSize, dotSize);
                    return;
                }

                var deltas = page.deltas;
                var v = start * 2;
                var ax = deltas[v] + px, ay = deltas[v + 1] + py;
                ctx.moveTo(ax * k + ox, -ay * k + oy);

                if (wPx < minPx && hPx < minPx) {
                    /* Still long enough to be a line at this zoom, but its
                     * whole extent is sub-pixel: two points are enough. */
                    var lv = (end - 1) * 2;
                    var bx = deltas[lv] + px, by = deltas[lv + 1] + py;
                    ctx.lineTo(bx * k + ox, -by * k + oy);
                    return;
                }

                var lastX = ax * k + ox, lastY = -ay * k + oy;
                for (var j = start + 1; j < end; j++) {
                    var vv = j * 2;
                    var mx = deltas[vv] + px, my = deltas[vv + 1] + py;
                    var sx = mx * k + ox, sy = -my * k + oy;
                    /* L1 distance: good enough for a sub-pixel step and much
                     * cheaper than a square root per vertex. */
                    if (Math.abs(sx - lastX) + Math.abs(sy - lastY) >= minPx) {
                        ctx.lineTo(sx, sy);
                        lastX = sx; lastY = sy;
                    }
                }
                var vl = (end - 1) * 2;
                var ex = deltas[vl] + px, ey = deltas[vl + 1] + py;
                var exs = ex * k + ox, eys = -ey * k + oy;
                if (exs !== lastX || eys !== lastY) ctx.lineTo(exs, eys);
            },

            /* ── spatial lookup ──────────────────────────────────────────
               Per batch, `cellItems` is grouped by grid cell and `cellKeys`
             *   is sorted. A tile (or a query rect) therefore resolves to a
             *   handful of contiguous ranges — above `gridUseZoom` a tile is
             *   smaller than a cell and thousands of segments never come into
             *   play at all. Below it, the query spans the world anyway and
             *   everything is a candidate; the item budget caps the drawing. */
            _forEachPageRange: function (z, page, q, fn) {
                var P = parser();
                var cellSize = page.cellSize || (P.WORLD / Math.pow(2, page.cellZoom || 11));
                var gridN = Math.pow(2, page.cellZoom || 11);
                if (page.spanItems && page.spanItems.length) {
                    /* Long roads: always bbox-tested individually. */
                    var spans = page.spanItems, bounds = page.bounds;
                    var list = [];
                    for (var si = 0; si < spans.length; si++) {
                        var i = spans[si], b0 = i * 4;
                        if (bounds[b0 + 2] < q.minX || bounds[b0] > q.maxX ||
                            bounds[b0 + 3] < q.minY || bounds[b0 + 1] > q.maxY) continue;
                        list.push(i);
                    }
                    if (list.length) {
                        page._spanRange = page._spanRange || new Uint32Array(page.n);
                        if (list.length <= page._spanRange.length) {
                            for (var li = 0; li < list.length; li++) page._spanRange[li] = list[li];
                            fn(0, list.length, page._spanRange);
                        }
                    }
                }
                if (!page.cellItems || !page.cellKeys) return;
                if (z < (this.options.gridUseZoom || 9)) {
                    /* Low zoom: the padded query covers the whole batch. */
                    fn(0, page.cellItems.length, page.cellItems);
                    return;
                }
                var pad = cellSize * 0.5 + 1;      /* see `spanRatio` in the parser */
                var minCy = Math.floor((q.minY - pad + P.WORLD / 2) / cellSize);
                var maxCy = Math.floor((q.maxY + pad + P.WORLD / 2) / cellSize);
                var minCx = Math.floor((q.minX - pad + P.WORLD / 2) / cellSize);
                var maxCx = Math.floor((q.maxX + pad + P.WORLD / 2) / cellSize);
                if (minCy < 0) minCy = 0;
                if (minCx < 0) minCx = 0;
                if (maxCy > gridN - 1) maxCy = gridN - 1;
                if (maxCx > gridN - 1) maxCx = gridN - 1;
                var keys = page.cellKeys, start = page.cellStart;
                for (var cy = minCy; cy <= maxCy; cy++) {
                    var rowBase = cy * gridN;
                    var lo = this._lowerBound(keys, rowBase + minCx);
                    var hi = this._upperBound(keys, rowBase + maxCx);
                    if (hi > lo) fn(start[lo], start[hi], page.cellItems);
                }
            },

            _lowerBound: function (arr, value) {
                var lo = 0, hi = arr.length;
                while (lo < hi) {
                    var mid = (lo + hi) >> 1;
                    if (arr[mid] < value) lo = mid + 1; else hi = mid;
                }
                return lo;
            },

            _upperBound: function (arr, value) {
                var lo = 0, hi = arr.length;
                while (lo < hi) {
                    var mid = (lo + hi) >> 1;
                    if (arr[mid] <= value) lo = mid + 1; else hi = mid;
                }
                return lo;
            },

            /* ── 3D ──────────────────────────────────────────────────────
               The mirror (js/map3d-mirror.js) prefers `_dl3dFeatures` over
               anything else it could guess about this layer, so the roads
               keep appearing in the 3D view as real vector lines instead of
               being a canvas it cannot read. Bounded on purpose: the mirror
               merges siblings, not 400 000 of them. */
            _dl3dFeatures: function () {
                var P = parser();
                var stamp = this._version + '|' + this.options.opacity + '|' + this.options.color + '|' + this._segments;
                if (this._3dCache && this._3dCache.stamp === stamp) return this._3dCache.value;
                var cap = this.options.max3dFeatures || 25000;
                var stride = Math.max(1, Math.ceil(this._segments / cap));
                var features = [];
                var total = 0;
                for (var p = 0; p < this._pages.length && total < cap; p++) {
                    var page = this._pages[p];
                    if (!page || !page.n) continue;
                    var bounds = page.bounds, origins = page.origins, starts = page.starts, deltas = page.deltas;
                    for (var i = 0; i < page.n && total < cap; i += stride) {
                        var s0 = starts[i], s1 = starts[i + 1];
                        if (s1 - s0 < 2) continue;
                        var ox = origins[i * 2], oy = origins[i * 2 + 1];
                        var coords = [];
                        for (var v = s0; v < s1; v++) {
                            var mx = deltas[v * 2] + ox, my = deltas[v * 2 + 1] + oy;
                            coords.push([Math.round(P.invMercX(mx) * 1e6) / 1e6,
                                Math.round(P.invMercY(my) * 1e6) / 1e6]);
                        }
                        features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
                        total++;
                    }
                }
                var value = {
                    geojson: { type: 'FeatureCollection', features: features },
                    stamp: stamp,
                    label: this.options.name || 'Roman roads',
                    paints: {
                        line: {
                            'line-color': this.options.color,
                            'line-width': this.options.weight,
                            'line-opacity': this.options.opacity
                        },
                        fill: { 'fill-color': this.options.color, 'fill-opacity': 0 },
                        circle: { 'circle-radius': 3, 'circle-color': this.options.color, 'circle-opacity': 0 },
                        layout: { 'line-cap': 'round', 'line-join': 'round' }
                    }
                };
                this._3dCache = { stamp: stamp, value: value };
                return value;
            },

            /* How many loaded road segments touch a lat/lng box — the number
             * the analysis report prints. */
            roadSegmentsInBounds: function (south, west, north, east) {
                var P = parser();
                if (!this._segments) return 0;
                var q = {
                    minX: P.mercX(west), maxX: P.mercX(east),
                    minY: P.mercY(south), maxY: P.mercY(north)
                };
                var count = 0;
                for (var p = 0; p < this._pages.length; p++) {
                    var page = this._pages[p];
                    if (!page.extent) continue;
                    if (page.extent[2] < q.minX || page.extent[0] > q.maxX ||
                        page.extent[3] < q.minY || page.extent[1] > q.maxY) continue;
                    this._forEachPageRange(12, page, q, function (from, to, items) {
                        var bounds = page.bounds;
                        for (var s = from; s < to; s++) {
                            var i = items[s], b0 = i * 4;
                            if (bounds[b0 + 2] < q.minX || bounds[b0] > q.maxX) continue;
                            if (bounds[b0 + 3] < q.minY || bounds[b0 + 1] > q.maxY) continue;
                            count++;
                        }
                    });
                }
                return count;
            },

            /* Distance (ground metres) from a point to the nearest loaded
             * road, or null. `js/archeo-report.js` uses this when the layer is
             * already loaded instead of downloading a 25 MB GeoJSON of the
             * same roads again. */
            nearestRoadMeters: function (lat, lng, maxM) {
                var P = parser();
                if (!this._segments) return null;
                var mx = P.mercX(lng), my = P.mercY(lat);
                var cos = Math.max(Math.cos(lat * Math.PI / 180), 0.2);
                var radiusMerc = maxM / cos;
                var q = { minX: mx - radiusMerc, maxX: mx + radiusMerc, minY: my - radiusMerc, maxY: my + radiusMerc };
                var best2 = Infinity;
                var self = this;
                for (var p = 0; p < this._pages.length; p++) {
                    var page = this._pages[p];
                    if (!page.extent) continue;
                    if (page.extent[2] < q.minX || page.extent[0] > q.maxX ||
                        page.extent[3] < q.minY || page.extent[1] > q.maxY) continue;
                    this._forEachPageRange(12, page, q, function (from, to, items) {
                        var bounds = page.bounds, origins = page.origins, starts = page.starts, deltas = page.deltas;
                        for (var s = from; s < to; s++) {
                            var i = items[s], b0 = i * 4;
                            if (bounds[b0 + 2] < q.minX - 0.1 || bounds[b0] > q.maxX + 0.1) continue;
                            if (bounds[b0 + 3] < q.minY - 0.1 || bounds[b0 + 1] > q.maxY + 0.1) continue;
                            var ox = origins[i * 2], oy = origins[i * 2 + 1];
                            var s0 = starts[i], s1 = starts[i + 1];
                            var px = 0, py = 0;
                            for (var v = s0; v < s1; v++) {
                                var ax = deltas[v * 2] + ox, ay = deltas[v * 2 + 1] + oy;
                                if (v > s0) {
                                    var dx = ax - px, dy = ay - py;
                                    var len2 = dx * dx + dy * dy;
                                    var t = len2 ? ((mx - px) * dx + (my - py) * dy) / len2 : 0;
                                    if (t < 0) t = 0; else if (t > 1) t = 1;
                                    var qx = px + t * dx - mx, qy = py + t * dy - my;
                                    var d2 = qx * qx + qy * qy;
                                    if (d2 < best2) best2 = d2;
                                }
                                px = ax; py = ay;
                            }
                        }
                    });
                }
                if (best2 === Infinity) return null;
                var meters = Math.sqrt(best2) * cos;
                return meters <= maxM ? meters : null;
            }
        });

        return RoadsLayer;
    }

    function createLayer(options) {
        var Cls = ensureLayerClass();
        if (!Cls) return null;
        return new Cls(options || {});
    }

    root.DetectLabRomanRoads = {
        version: VERSION,
        createLayer: createLayer,
        load: load,
        workerUrl: workerUrl,
        configForDevice: configForDevice,
        DEFAULTS: (parser() && parser().DEFAULTS) || null
    };
})(typeof window !== 'undefined' ? window : this);
