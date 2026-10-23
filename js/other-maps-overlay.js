/* =====================================================================
 * other-maps-overlay.js — free-transform image overlays (Adobe-style)
 * ---------------------------------------------------------------------
 * A non-georeferenced sheet has no footprint on the ground, so it cannot be
 * a Leaflet layer: Leaflet positions layers geographically and its panes are
 * rewritten on every pan.  These overlays therefore keep their OWN transform
 * state (anchor + metres-per-pixel + rotation + opacity) and are painted as a
 * plain DOM element inside a dedicated pane:
 *
 *     translate3d(anchorLayerPoint) · rotate(θ) · scale(k) · translate(-size/2)
 *
 * Because the anchor is a real LatLng and the size is derived from metres per
 * image pixel, the sheet behaves like a map layer when the basemap moves —
 * while the user stays in full control of where, how big and how rotated it
 * sits, exactly like dragging one image over another in Photoshop.
 *
 * Public API: window.DetectLabOtherMapsOverlay.createManager(map, opts) →
 *   add(record, state) / remove(id) / get(id) / list() / setActive(id)
 *   setAlignMode(on) / isAlignMode() / setOpacity(id, v) / setState(id, patch)
 *   centerOn(id) / fitToView(id) / clear() / setVisible(on)
 *   onStateChange(fn) / destroy()
 * ===================================================================== */
(function (root) {
    'use strict';

    var L = root.L;
    var Tiles = root.DetectLabOtherMapsTiles;
    var TILE = 512;

    /* Metres per image pixel — the slowest and the fastest sensible scale.
     * 0.02 m/px is a cadastral plan at field level, 400 m/px is a wall map of
     * a whole region; nothing useful lives outside that window. */
    var MPP_MIN = 0.02;
    var MPP_MAX = 400;
    var DEFAULT_GROUND_WIDTH_M = 4000;   // used when a sheet is added fresh
    var SNAP_DEG = 1.5;                  // rotation snaps near 0/90/180/270

    var UI_SELECTOR = 'button, a, input, select, textarea, label, .leaflet-control, ' +
        '.leaflet-popup, .om-panel, .om-modal, .om-handle, .leaflet-marker-icon';

    function clamp(value, min, max) { return value < min ? min : (value > max ? max : value); }

    function normalizeDegrees(deg) {
        var value = (Number(deg) || 0) % 360;
        if (value > 180) value -= 360;
        if (value < -180) value += 360;
        return value;
    }

    function snapDegrees(deg) {
        var nearest = Math.round(deg / 90) * 90;
        return Math.abs(deg - nearest) <= SNAP_DEG ? normalizeDegrees(nearest) : deg;
    }

    /* Metres covered by one CSS pixel at `lat` for the given zoom. */
    function resolutionAt(lat, zoom) {
        return 156543.03392804097 * Math.cos((Number(lat) || 0) * Math.PI / 180) /
            Math.pow(2, Number(zoom) || 0);
    }

    function resolution(map, lat) {
        return resolutionAt(lat, map.getZoom());
    }

    /**
     * Everything the painter needs for one frame, as pure maths.
     * `mpp` is metres per NATURAL image pixel; the pyramid level is chosen so
     * that one level pixel lands as close as possible to one screen pixel.
     */
    function planGeometry(o) {
        var res = resolutionAt(o.lat, o.zoom);
        var dW = o.w * o.mpp / res;
        var dH = o.h * o.mpp / res;
        var level = Math.round(o.maxZoom + Math.log(o.mpp / res) / Math.LN2);
        level = clamp(level, 0, o.maxZoom);
        var factor = Math.pow(2, level - o.maxZoom);
        var wL = Math.max(1, Math.round(o.w * factor));
        var hL = Math.max(1, Math.round(o.h * factor));
        return {
            res: res,
            dW: dW,
            dH: dH,
            level: level,
            wL: wL,
            hL: hL,
            k: dW / wL,
            cols: Math.max(1, Math.ceil(wL / TILE)),
            rows: Math.max(1, Math.ceil(hL / TILE))
        };
    }

    /**
     * Tile window of `geom` needed to cover the viewport rectangle, in the
     * element's own (level-pixel) coordinates.  This is the inverse of
     * translate(anchor) → rotate(θ) → scale(k) → translate(-size/2).
     */
    function visibleTileRange(geom, anchor, rotationDeg, topLeft, bottomRight) {
        var theta = (Number(rotationDeg) || 0) * Math.PI / 180;
        var cos = Math.cos(theta);
        var sin = Math.sin(theta);
        var corners = [
            { x: topLeft.x, y: topLeft.y },
            { x: bottomRight.x, y: topLeft.y },
            { x: bottomRight.x, y: bottomRight.y },
            { x: topLeft.x, y: bottomRight.y }
        ];
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < corners.length; i++) {
            var dx = corners[i].x - anchor.x;
            var dy = corners[i].y - anchor.y;
            var lx = (cos * dx + sin * dy) / geom.k + geom.wL / 2;
            var ly = (-sin * dx + cos * dy) / geom.k + geom.hL / 2;
            if (lx < minX) minX = lx;
            if (lx > maxX) maxX = lx;
            if (ly < minY) minY = ly;
            if (ly > maxY) maxY = ly;
        }
        return {
            x0: clamp(Math.floor(minX / TILE) - 1, 0, geom.cols - 1),
            x1: clamp(Math.floor(maxX / TILE) + 1, 0, geom.cols - 1),
            y0: clamp(Math.floor(minY / TILE) - 1, 0, geom.rows - 1),
            y1: clamp(Math.floor(maxY / TILE) + 1, 0, geom.rows - 1)
        };
    }

    function pointDistance(a, b) {
        var dx = a.x - b.x, dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function pointAngle(a, b) {
        return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    }

    /* ── manager ──────────────────────────────────────────────────────── */
    function createManager(map, options) {
        options = options || {};
        var paneName = options.pane || 'pane_other_maps_overlay';
        var pane = map.getPane(paneName) || map.createPane(paneName);
        if (options.zIndex) pane.style.zIndex = String(options.zIndex);
        pane.style.pointerEvents = 'none';

        var container = map.getContainer();
        var overlays = Object.create(null);
        var order = [];
        var activeId = null;
        var alignMode = false;
        var visible = true;
        var listeners = [];

        var state = {
            align: false,
            activeId: null
        };

        /* ── overlay construction ─────────────────────────────────────── */
        function build(record) {
            var root_ = document.createElement('div');
            root_.className = 'om-overlay';
            root_.style.position = 'absolute';
            root_.style.left = '0';
            root_.style.top = '0';
            root_.style.width = '0';
            root_.style.height = '0';
            root_.style.transformOrigin = '0 0';
            root_.style.willChange = 'transform';
            root_.style.pointerEvents = 'none';

            var rotEl = document.createElement('div');
            rotEl.className = 'om-rot';
            rotEl.style.position = 'absolute';
            rotEl.style.left = '0';
            rotEl.style.top = '0';
            rotEl.style.transformOrigin = '0 0';
            root_.appendChild(rotEl);

            var gridEl = document.createElement('div');
            gridEl.className = 'om-grid';
            gridEl.style.position = 'absolute';
            gridEl.style.left = '0';
            gridEl.style.top = '0';
            gridEl.style.transformOrigin = '0 0';
            rotEl.appendChild(gridEl);

            var frameEl = document.createElement('div');
            frameEl.className = 'om-frame';
            frameEl.style.position = 'absolute';
            frameEl.style.left = '0';
            frameEl.style.top = '0';
            frameEl.style.transformOrigin = '0 0';
            frameEl.style.pointerEvents = 'none';
            frameEl.style.display = 'none';
            root_.appendChild(frameEl);

            var boxEl = document.createElement('div');
            boxEl.className = 'om-box';
            boxEl.style.position = 'absolute';
            frameEl.appendChild(boxEl);

            var handles = {};
            ['nw', 'ne', 'se', 'sw'].forEach(function (corner) {
                var handle = document.createElement('div');
                handle.className = 'om-handle om-handle-' + corner;
                handle.setAttribute('data-om-handle', corner);
                handle.style.pointerEvents = 'auto';
                boxEl.appendChild(handle);
                handles[corner] = handle;
            });
            var rotHandle = document.createElement('div');
            rotHandle.className = 'om-handle om-handle-rot';
            rotHandle.setAttribute('data-om-handle', 'rot');
            rotHandle.style.pointerEvents = 'auto';
            boxEl.appendChild(rotHandle);
            handles.rot = rotHandle;

            var line = document.createElement('div');
            line.className = 'om-rot-line';
            boxEl.appendChild(line);

            var ov = {
                id: record.id,
                record: record,
                root: root_,
                rotEl: rotEl,
                gridEl: gridEl,
                frameEl: frameEl,
                boxEl: boxEl,
                handles: handles,
                tiles: Object.create(null),
                meta: null,
                geom: null,
                token: 0,
                state: {
                    lat: Number(record.lat),
                    lng: Number(record.lng),
                    mpp: null,          // set once the pyramid size is known
                    rotation: 0,
                    opacity: options.opacity == null ? 0.8 : Number(options.opacity)
                }
            };
            return ov;
        }

        /* ── geometry ─────────────────────────────────────────────────── */
        function geometryFor(ov) {
            return planGeometry({
                lat: ov.state.lat,
                zoom: map.getZoom(),
                w: ov.meta.w,
                h: ov.meta.h,
                mpp: ov.state.mpp,
                maxZoom: ov.meta.maxZoom
            });
        }

        function anchorPoint(ov) {
            return map.latLngToLayerPoint(L.latLng(ov.state.lat, ov.state.lng));
        }

        /* ── tiles ────────────────────────────────────────────────────── */
        function syncTiles(ov) {
            var g = ov.geom;
            if (!g) return;
            var size = map.getSize();
            var topLeft = map.containerPointToLayerPoint(L.point(0, 0));
            var bottomRight = map.containerPointToLayerPoint(size);
            var range = visibleTileRange(g, ov.anchor, ov.state.rotation, topLeft, bottomRight);
            var x0 = range.x0, x1 = range.x1, y0 = range.y0, y1 = range.y1;

            var wanted = Object.create(null);
            var token = ov.token;
            for (var x = x0; x <= x1; x++) {
                for (var y = y0; y <= y1; y++) {
                    var key = g.level + ':' + x + ':' + y;
                    wanted[key] = true;
                    if (ov.tiles[key]) continue;
                    addTile(ov, key, x, y, g.level, token);
                }
            }
            Object.keys(ov.tiles).forEach(function (key) {
                if (wanted[key]) return;
                var img = ov.tiles[key];
                delete ov.tiles[key];
                if (img && img.parentNode) img.parentNode.removeChild(img);
            });
        }

        function addTile(ov, key, x, y, level, token) {
            var img = document.createElement('img');
            img.className = 'om-tile';
            img.style.position = 'absolute';
            img.style.left = (x * TILE) + 'px';
            img.style.top = (y * TILE) + 'px';
            img.style.width = (TILE + 0.6) + 'px';
            img.style.height = (TILE + 0.6) + 'px';
            img.draggable = false;
            img.alt = '';
            ov.tiles[key] = img;
            ov.gridEl.appendChild(img);
            if (!Tiles || typeof Tiles.tileUrl !== 'function') return;
            function stale() { return ov.token !== token || !img.parentNode; }
            function fallback() {
                // The two readings of the portal's hash scheme (see
                // js/other-maps-tiles.js) — one retry with the other order.
                if (stale() || typeof Tiles.tileUrlAlt !== 'function') return;
                Tiles.tileUrlAlt(ov.record.path, x, y, level).then(function (altUrl) {
                    if (stale()) return;
                    img.addEventListener('load', function () { Tiles.noteOrder(Tiles.alternateOrder()); });
                    img.src = altUrl;
                }).catch(function () { /* a missing tile stays transparent */ });
            }
            Tiles.tileUrl(ov.record.path, x, y, level).then(function (url) {
                // The view may already have switched level while the hash was
                // being computed — never paint a stale tile.
                if (stale()) return;
                img.addEventListener('error', fallback, { once: true });
                img.src = url;
            }).catch(fallback);
        }

        function clearTiles(ov) {
            Object.keys(ov.tiles).forEach(function (key) {
                var img = ov.tiles[key];
                if (img && img.parentNode) img.parentNode.removeChild(img);
            });
            ov.tiles = Object.create(null);
            ov.token++;
        }

        /* ── painting ─────────────────────────────────────────────────── */
        function render(ov) {
            if (!ov || !ov.meta || !ov.root.parentNode) return;
            var g = geometryFor(ov);
            var a = anchorPoint(ov);
            var levelChanged = !ov.geom || ov.geom.level !== g.level;
            ov.geom = g;
            ov.anchor = a;

            ov.root.style.transform = 'translate3d(' + a.x + 'px,' + a.y + 'px,0)';
            ov.root.style.opacity = String(ov.state.opacity);
            ov.rotEl.style.transform = 'rotate(' + ov.state.rotation + 'deg)';
            ov.gridEl.style.width = g.wL + 'px';
            ov.gridEl.style.height = g.hL + 'px';
            ov.gridEl.style.transform = 'scale(' + g.k + ') translate(' +
                (-g.wL / 2) + 'px,' + (-g.hL / 2) + 'px)';

            if (levelChanged) clearTiles(ov);

            if (ov.frameEl.style.display !== 'none') {
                ov.frameEl.style.transform = 'rotate(' + ov.state.rotation + 'deg)';
                ov.boxEl.style.width = g.dW + 'px';
                ov.boxEl.style.height = g.dH + 'px';
                ov.boxEl.style.left = (-g.dW / 2) + 'px';
                ov.boxEl.style.top = (-g.dH / 2) + 'px';
            }
            syncTiles(ov);
        }

        function renderAll() {
            if (map._animatingZoom) return;
            order.forEach(function (id) { render(overlays[id]); });
        }

        /* ── lifecycle ────────────────────────────────────────────────── */
        function add(record, savedState) {
            if (!record || !record.path) return Promise.resolve(null);
            var existing = overlays[record.id];
            if (existing) {
                if (savedState) applyState(existing, savedState);
                setActive(record.id);
                return Promise.resolve(existing);
            }
            var ov = build(record);
            overlays[record.id] = ov;
            order.push(record.id);
            pane.appendChild(ov.root);
            if (savedState) applyState(ov, savedState);

            var hint = { w: record.w, h: record.h };
            return Tiles.resolve(record.path, hint).then(function (meta) {
                ov.meta = meta;
                if (ov.state.mpp == null || !isFinite(ov.state.mpp)) {
                    // Fresh sheet: make it cover ~4 km on the ground, then let
                    // the user dial it in.
                    ov.state.mpp = clamp(DEFAULT_GROUND_WIDTH_M / Math.max(meta.w, meta.h), MPP_MIN, MPP_MAX);
                }
                render(ov);
                emitChange(ov);
                setActive(record.id);
                return ov;
            }).catch(function (err) {
                console.warn('[OtherMaps] cannot read pyramid for', record.id, err);
                ov.meta = { w: 4000, h: 3000, maxZoom: 4 };
                if (ov.state.mpp == null) ov.state.mpp = 1;
                render(ov);
                return ov;
            });
        }

        function remove(id) {
            var ov = overlays[id];
            if (!ov) return;
            clearTiles(ov);
            if (ov.root.parentNode) ov.root.parentNode.removeChild(ov.root);
            delete overlays[id];
            order = order.filter(function (item) { return item !== id; });
            if (activeId === id) {
                activeId = order.length ? order[order.length - 1] : null;
                if (!activeId) setAlignMode(false);
            }
            paintFrames();
            emitChange(null);
        }

        function clear() {
            order.slice().forEach(remove);
        }

        function applyState(ov, patch) {
            if (!ov || !patch) return;
            if (isFinite(patch.lat)) ov.state.lat = Number(patch.lat);
            if (isFinite(patch.lng)) ov.state.lng = Number(patch.lng);
            if (isFinite(patch.mpp)) ov.state.mpp = clamp(Number(patch.mpp), MPP_MIN, MPP_MAX);
            if (isFinite(patch.rotation)) ov.state.rotation = normalizeDegrees(Number(patch.rotation));
            if (isFinite(patch.opacity)) ov.state.opacity = clamp(Number(patch.opacity), 0, 1);
        }

        function setState(id, patch, options) {
            var ov = overlays[id];
            if (!ov) return null;
            applyState(ov, patch);
            render(ov);
            if (!options || options.silent !== true) emitChange(ov);
            return ov.state;
        }

        function setOpacity(id, value) {
            return setState(id, { opacity: value });
        }

        function setActive(id) {
            if (activeId === id) { paintFrames(); return; }
            activeId = overlays[id] ? id : null;
            paintFrames();
            if (options.onActiveChange) options.onActiveChange(activeId);
        }

        function active() { return activeId ? overlays[activeId] : null; }

        function paintFrames() {
            order.forEach(function (id) {
                var ov = overlays[id];
                var show = alignMode && id === activeId;
                ov.frameEl.style.display = show ? '' : 'none';
                ov.root.classList.toggle('om-active', show);
            });
        }

        function setAlignMode(on) {
            var wanted = !!on && !!active();
            if (wanted === alignMode) { paintFrames(); return alignMode; }
            alignMode = wanted;
            state.align = wanted;
            try {
                if (alignMode) {
                    if (map.dragging && map.dragging.enabled()) map.dragging.disable();
                    if (map.doubleClickZoom && map.doubleClickZoom.enabled()) map.doubleClickZoom.disable();
                    if (map.scrollWheelZoom && map.scrollWheelZoom.enabled()) map.scrollWheelZoom.disable();
                    if (map.touchZoom && map.touchZoom.enabled()) map.touchZoom.disable();
                    if (map.boxZoom && map.boxZoom.enabled()) map.boxZoom.disable();
                } else {
                    if (map.dragging && !map.dragging.enabled()) map.dragging.enable();
                    if (map.doubleClickZoom && !map.doubleClickZoom.enabled()) map.doubleClickZoom.enable();
                    if (map.scrollWheelZoom && !map.scrollWheelZoom.enabled()) map.scrollWheelZoom.enable();
                    if (map.touchZoom && !map.touchZoom.enabled()) map.touchZoom.enable();
                    if (map.boxZoom && !map.boxZoom.enabled()) map.boxZoom.enable();
                }
            } catch (e) { /* handler state is best-effort */ }
            container.classList.toggle('om-align-active', alignMode);
            paintFrames();
            if (options.onAlignChange) options.onAlignChange(alignMode);
            return alignMode;
        }

        function setVisible(on) {
            visible = !!on;
            pane.style.display = visible ? '' : 'none';
            if (!visible) setAlignMode(false);
            else renderAll();
        }

        function centerOn(id) {
            var ov = overlays[id];
            if (!ov) return;
            var center = map.getCenter();
            setState(id, { lat: center.lat, lng: center.lng });
        }

        function fitToView(id) {
            var ov = overlays[id];
            if (!ov || !ov.meta) return;
            var size = map.getSize();
            var res = resolution(map, ov.state.lat);
            // 70% of the smaller viewport edge.
            var targetPx = Math.min(size.x, size.y) * 0.7;
            var longestSide = Math.max(ov.meta.w, ov.meta.h);
            var mpp = targetPx * res / longestSide;
            return setState(id, { mpp: clamp(mpp, MPP_MIN, MPP_MAX) });
        }

        function groundWidth(id) {
            var ov = overlays[id];
            if (!ov || !ov.meta) return 0;
            return ov.meta.w * ov.state.mpp;
        }

        /* Back to the day it was added: the sheet's own coordinates, no
         * rotation and the default “about four kilometres wide”. */
        function reset(id) {
            var ov = overlays[id];
            if (!ov) return null;
            var base = ov.meta ? Math.max(ov.meta.w, ov.meta.h) : 4000;
            ov.state.lat = Number(ov.record.lat);
            ov.state.lng = Number(ov.record.lng);
            ov.state.rotation = 0;
            ov.state.mpp = clamp(DEFAULT_GROUND_WIDTH_M / base, MPP_MIN, MPP_MAX);
            render(ov);
            emitChange(ov);
            return ov.state;
        }

        function emitChange(ov) {
            var payload = ov ? publicState(ov) : null;
            listeners.forEach(function (fn) {
                try { fn(payload, snapshot()); } catch (e) { console.warn(e); }
            });
        }

        function publicState(ov) {
            return {
                id: ov.id,
                path: ov.record.path,
                lat: ov.state.lat,
                lng: ov.state.lng,
                mpp: ov.state.mpp,
                rotation: ov.state.rotation,
                opacity: ov.state.opacity
            };
        }

        function snapshot() {
            return {
                activeId: activeId,
                align: alignMode,
                overlays: order.map(function (id) { return publicState(overlays[id]); })
            };
        }

        function onStateChange(fn) {
            if (typeof fn === 'function') listeners.push(fn);
            return function () { listeners = listeners.filter(function (item) { return item !== fn; }); };
        }

        /* ── gestures ─────────────────────────────────────────────────── */
        var pointers = Object.create(null);
        var pointerCount = 0;
        var gesture = null;

        function isUiTarget(target) {
            var node = target;
            while (node && node !== container) {
                if (node.nodeType === 1 && node.matches && node.matches(UI_SELECTOR)) return true;
                node = node.parentNode;
            }
            return node !== container;
        }

        function containerPoint(event) {
            var rect = container.getBoundingClientRect();
            return L.point(event.clientX - rect.left, event.clientY - rect.top);
        }

        function beginGesture(kind, pointerId, event) {
            var ov = active();
            if (!ov) return;
            var point = containerPoint(event);
            var center = map.latLngToContainerPoint(L.latLng(ov.state.lat, ov.state.lng));
            gesture = {
                kind: kind,
                ov: ov,
                start: {
                    lat: ov.state.lat,
                    lng: ov.state.lng,
                    mpp: ov.state.mpp,
                    rotation: ov.state.rotation
                },
                origin: point,
                center: center,
                distance: pointDistance(center, point),
                angle: pointAngle(center, point)
            };
        }

        function beginPinch() {
            var ov = active();
            if (!ov) return;
            var ids = Object.keys(pointers);
            if (ids.length < 2) return;
            var a = pointers[ids[0]];
            var b = pointers[ids[1]];
            var center = map.latLngToContainerPoint(L.latLng(ov.state.lat, ov.state.lng));
            gesture = {
                kind: 'pinch',
                ov: ov,
                start: {
                    lat: ov.state.lat,
                    lng: ov.state.lng,
                    mpp: ov.state.mpp,
                    rotation: ov.state.rotation
                },
                origin: L.point((a.x + b.x) / 2, (a.y + b.y) / 2),
                center: center,
                distance: Math.max(1, pointDistance(a, b)),
                angle: pointAngle(a, b)
            };
        }

        function applyMove(ov, delta) {
            var target = map.containerPointToLatLng(L.point(gesture.origin.x + delta.x, gesture.origin.y + delta.y));
            ov.state.lat = target.lat;
            ov.state.lng = target.lng;
        }

        function onPointerDown(event) {
            if (!alignMode || !active()) return;
            var handleKind = event.target && event.target.getAttribute
                ? event.target.getAttribute('data-om-handle') : null;
            pointers[event.pointerId] = containerPoint(event);
            pointerCount++;
            if (handleKind) {
                beginGesture(handleKind === 'rot' ? 'rotate' : 'scale', event.pointerId, event);
                try { event.target.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (isUiTarget(event.target)) { delete pointers[event.pointerId]; pointerCount--; return; }
            if (pointerCount === 1) {
                beginGesture('move', event.pointerId, event);
                try { container.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
                event.preventDefault();
                event.stopPropagation();
            } else if (pointerCount === 2) {
                beginPinch();
            }
        }

        function onPointerMove(event) {
            if (!gesture) return;
            if (pointers[event.pointerId]) pointers[event.pointerId] = containerPoint(event);
            var ov = gesture.ov;
            if (!ov) return;

            if (gesture.kind === 'pinch' && pointerCount >= 2) {
                var ids = Object.keys(pointers);
                var a = pointers[ids[0]];
                var b = pointers[ids[1]];
                var distance = Math.max(1, pointDistance(a, b));
                var angle = pointAngle(a, b);
                var mid = L.point((a.x + b.x) / 2, (a.y + b.y) / 2);
                ov.state.mpp = clamp(gesture.start.mpp * (distance / gesture.distance), MPP_MIN, MPP_MAX);
                ov.state.rotation = snapDegrees(normalizeDegrees(
                    gesture.start.rotation + (angle - gesture.angle)));
                applyMove(ov, L.point(mid.x - gesture.origin.x, mid.y - gesture.origin.y));
            } else if (gesture.kind === 'move') {
                var point = containerPoint(event);
                applyMove(ov, L.point(point.x - gesture.origin.x, point.y - gesture.origin.y));
            } else if (gesture.kind === 'scale') {
                var p = containerPoint(event);
                var radius = Math.max(8, pointDistance(gesture.center, p));
                ov.state.mpp = clamp(gesture.start.mpp * (radius / Math.max(8, gesture.distance)), MPP_MIN, MPP_MAX);
            } else if (gesture.kind === 'rotate') {
                var rp = containerPoint(event);
                var angleNow = pointAngle(gesture.center, rp);
                ov.state.rotation = snapDegrees(normalizeDegrees(
                    gesture.start.rotation + (angleNow - gesture.angle)));
            } else {
                return;
            }
            render(ov);
            if (options.onTransform) options.onTransform(publicState(ov));
        }

        function onPointerUp(event) {
            delete pointers[event.pointerId];
            pointerCount = Math.max(0, pointerCount - 1);
            if (pointerCount === 0) {
                if (gesture) {
                    emitChange(gesture.ov);
                    gesture = null;
                }
            } else if (pointerCount === 1 && gesture && gesture.kind === 'pinch') {
                // One finger left: continue as a plain move without a jump.
                var ov = gesture.ov;
                var remaining = Object.keys(pointers)[0];
                gesture = {
                    kind: 'move',
                    ov: ov,
                    start: { lat: ov.state.lat, lng: ov.state.lng, mpp: ov.state.mpp, rotation: ov.state.rotation },
                    origin: pointers[remaining],
                    center: gesture.center,
                    distance: 0,
                    angle: 0
                };
            }
        }

        function onWheel(event) {
            if (!alignMode) return;
            var ov = active();
            if (!ov) return;
            event.preventDefault();
            if (event.shiftKey) {
                ov.state.rotation = snapDegrees(normalizeDegrees(ov.state.rotation + event.deltaY * 0.12));
            } else {
                var factor = Math.exp(-event.deltaY * 0.0015);
                ov.state.mpp = clamp(ov.state.mpp * factor, MPP_MIN, MPP_MAX);
            }
            render(ov);
            emitChange(ov);
        }

        /* ── map wiring ───────────────────────────────────────────────── */
        function onMove() { renderAll(); }

        function onZoomStart() { /* the pane is CSS-scaled while animating */ }

        function onResize() { renderAll(); }

        map.on('move', onMove);
        map.on('moveend', onMove);
        map.on('zoomend', onMove);
        map.on('viewreset', onMove);
        map.on('resize', onResize);
        map.on('zoomstart', onZoomStart);

        container.addEventListener('pointerdown', onPointerDown, true);
        root.addEventListener('pointermove', onPointerMove, { passive: true });
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);
        container.addEventListener('wheel', onWheel, { passive: false });

        function destroy() {
            setAlignMode(false);
            map.off('move', onMove);
            map.off('moveend', onMove);
            map.off('zoomend', onMove);
            map.off('viewreset', onMove);
            map.off('resize', onResize);
            map.off('zoomstart', onZoomStart);
            container.removeEventListener('pointerdown', onPointerDown, true);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('pointerup', onPointerUp);
            root.removeEventListener('pointercancel', onPointerUp);
            container.removeEventListener('wheel', onWheel);
            clear();
        }

        return {
            pane: pane,
            add: add,
            remove: remove,
            clear: clear,
            get: function (id) { return overlays[id] || null; },
            has: function (id) { return !!overlays[id]; },
            list: function () { return order.map(function (id) { return overlays[id]; }); },
            state: function (id) { return overlays[id] ? publicState(overlays[id]) : null; },
            setActive: setActive,
            getActiveId: function () { return activeId; },
            setAlignMode: setAlignMode,
            isAlignMode: function () { return alignMode; },
            setOpacity: setOpacity,
            setState: setState,
            setVisible: setVisible,
            centerOn: centerOn,
            fitToView: fitToView,
            reset: reset,
            groundWidth: groundWidth,
            groundHeight: function (id) {
                var ov = overlays[id];
                return ov && ov.meta ? ov.meta.h * ov.state.mpp : 0;
            },
            onStateChange: onStateChange,
            snapshot: snapshot,
            renderAll: renderAll,
            destroy: destroy,
            limits: { mppMin: MPP_MIN, mppMax: MPP_MAX }
        };
    }

    root.DetectLabOtherMapsOverlay = {
        createManager: createManager,
        resolution: resolution,
        resolutionAt: resolutionAt,
        planGeometry: planGeometry,
        visibleTileRange: visibleTileRange,
        normalizeDegrees: normalizeDegrees,
        snapDegrees: snapDegrees,
        tileSize: TILE,
        limits: { mppMin: MPP_MIN, mppMax: MPP_MAX }
    };
}(typeof window !== 'undefined' ? window : this));
