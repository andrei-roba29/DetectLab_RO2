/* DetectLab map rotation + compass with tap rotation lock
 *
 * Leaflet 1.9 has no built-in bearing. This module:
 *  - rotates the map pane around the viewport centre
 *  - keeps click / pan / pinch coordinates correct
 *  - lets the user twist the map with two fingers (touch)
 *    or Alt/Option-drag / Ctrl-wheel (desktop) with stable deadband
 *  - shows a bottom-left column of three 38x38 map buttons:
 *      * compass (tap -> resets orientation to true north)
 *      * rotation lock (tap -> toggles screen-turning lock)
 *      * Detect toggle (tap -> toggles activity detection; PWA only,
 *        hidden on desktop via CSS - desktop keeps the .map-controls switch)
 */
(function (L) {
    'use strict';
    if (!L || !L.Map) return;

    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;
    var SNAP = 3.0; // Snap to north when within 3 degrees
    var TOUCH_ROTATE_THRESHOLD = 9.0; // Intentional twist threshold in degrees
    var MIN_TOUCH_DISTANCE = 35; // Minimum pixel distance between fingers for angular stability
    var STORAGE_LOCK_KEY = 'detectlab_rotation_locked';

    function wrapDeg(deg) {
        deg = deg % 360;
        if (deg > 180) deg -= 360;
        if (deg <= -180) deg += 360;
        return deg;
    }

    function rotatePoint(point, deg, origin) {
        if (!deg) return point.clone ? point.clone() : L.point(point);
        var rad = deg * DEG;
        var cos = Math.cos(rad);
        var sin = Math.sin(rad);
        var x = point.x - origin.x;
        var y = point.y - origin.y;
        return L.point(x * cos - y * sin + origin.x, x * sin + y * cos + origin.y);
    }

    function angleBetween(a, b) {
        return Math.atan2(b.y - a.y, b.x - a.x) * RAD;
    }

    var origSetPosition = L.DomUtil.setPosition;
    var origGetBounds = L.Map.prototype.getBounds;
    var origContainerToLayer = L.Map.prototype.containerPointToLayerPoint;
    var origLayerToContainer = L.Map.prototype.layerPointToContainerPoint;
    var origGetTiledPixelBounds = L.GridLayer && L.GridLayer.prototype._getTiledPixelBounds;

    L.DomUtil.setPosition = function (el, point) {
        origSetPosition.call(this, el, point);
        if (el && el._dlRotateMap) el._dlRotateMap._applyRotateTransform();
    };

    L.Map.mergeOptions({
        rotate: false,
        touchRotate: true,
        keyRotate: true,
        rotateLocked: false,
        bearing: 0
    });

    L.Map.include({
        getBearing: function () {
            return this._bearing || 0;
        },

        isRotateLocked: function () {
            return !!this._rotateLocked;
        },

        setRotateLocked: function (locked, options) {
            locked = !!locked;
            if (this._rotateLocked === locked) return this;
            this._rotateLocked = locked;
            try {
                localStorage.setItem(STORAGE_LOCK_KEY, locked ? 'true' : 'false');
            } catch (err) {}
            if (this._container) {
                this._container.classList.toggle('is-rotation-locked', locked);
            }
            if (this.compassControl && (!options || !options.fromCompass)) {
                this.compassControl.setLocked(locked, { fromMap: true });
            }
            this.fire('rotatelockchange', { locked: locked });
            return this;
        },

        setBearing: function (deg, options) {
            if (!this._rotate) return this;
            options = options || {};
            if (this._rotateLocked && !options.force && !options.noLockCheck) {
                return this;
            }
            var next = wrapDeg(deg);
            if (Math.abs(next) < SNAP) next = 0;
            if (next === this._bearing) {
                this._applyRotateTransform();
                this.fire('rotate', { bearing: next });
                return this;
            }
            this._bearing = next;
            this._applyRotateTransform();
            if (this._container) {
                this._container.classList.toggle('is-map-rotated', next !== 0);
            }
            this.fire('rotate', { bearing: next });
            if (!options.noMove) {
                this.fire('move');
            }
            return this;
        },

        resetBearing: function () {
            if (!this._rotate || !this._bearing) return this;
            var map = this;
            var from = this._bearing;
            if (Math.abs(from) < 1) return this.setBearing(0, { force: true });
            var start = null;
            var duration = 280;
            function step(ts) {
                if (start === null) start = ts;
                var t = Math.min(1, (ts - start) / duration);
                var eased = 1 - Math.pow(1 - t, 3);
                map.setBearing(from * (1 - eased), { noMove: t < 1, force: true });
                if (t < 1) L.Util.requestAnimFrame(step);
                else map.fire('moveend');
            }
            L.Util.requestAnimFrame(step);
            return this;
        },

        _pivot: function () {
            return this.getSize()._divideBy(2);
        },

        _applyRotateTransform: function () {
            var pane = this._mapPane;
            if (!pane) return;
            var pos = L.DomUtil.getPosition(pane) || L.point(0, 0);
            var bearing = this._bearing || 0;
            // Leaflet's zoom animation (tiles, SVG/canvas paths, markers,
            // tooltips) assumes the map pane's transform-origin is 0 0 —
            // see .leaflet-zoom-animated in leaflet.css. Pinning the origin
            // to the viewport centre while bearing is 0 made every overlay
            // scale around the wrong point, so heritage dots, LIDAR rings
            // and archeo candidates slid off their sites during zoom.
            if (!bearing) {
                pane.style.transformOrigin = '0px 0px';
                pane.style[L.DomUtil.TRANSFORM] = L.Browser.any3d
                    ? 'translate3d(' + pos.x + 'px,' + pos.y + 'px,0)'
                    : 'translate(' + pos.x + 'px,' + pos.y + 'px)';
                return;
            }
            // Keep the origin stable for the duration of a CSS zoom so
            // child zoomanim transforms are not composed against a moving
            // pivot. Recompute once the animation ends.
            if (!this._animatingZoom) {
                var pivot = this._pivot();
                pane.style.transformOrigin = (pivot.x - pos.x) + 'px ' + (pivot.y - pos.y) + 'px';
            }
            pane.style[L.DomUtil.TRANSFORM] =
                'translate3d(' + pos.x + 'px,' + pos.y + 'px,0) rotate(' + bearing + 'deg)';
        },

        containerPointToLayerPoint: function (point) {
            if (!this._rotate || !this._bearing) {
                return origContainerToLayer.call(this, point);
            }
            var unrotated = rotatePoint(L.point(point), -this._bearing, this._pivot());
            return unrotated.subtract(this._getMapPanePos());
        },

        layerPointToContainerPoint: function (point) {
            if (!this._rotate || !this._bearing) {
                return origLayerToContainer.call(this, point);
            }
            return rotatePoint(L.point(point).add(this._getMapPanePos()), this._bearing, this._pivot());
        },

        getBounds: function () {
            if (!this._rotate || !this._bearing) {
                return origGetBounds.call(this);
            }
            var size = this.getSize();
            return L.latLngBounds([
                this.containerPointToLatLng([0, 0]),
                this.containerPointToLatLng([size.x, 0]),
                this.containerPointToLatLng([size.x, size.y]),
                this.containerPointToLatLng([0, size.y])
            ]);
        }
    });

    if (origGetTiledPixelBounds) {
        L.GridLayer.include({
            _getTiledPixelBounds: function (center) {
                var bounds = origGetTiledPixelBounds.call(this, center);
                var map = this._map;
                if (!map || !map._rotate || !map._bearing) return bounds;
                var rad = Math.abs(map._bearing) * DEG;
                var size = map.getSize();
                var extraX = (size.x * Math.abs(Math.cos(rad)) + size.y * Math.abs(Math.sin(rad)) - size.x) / 2;
                var extraY = (size.x * Math.abs(Math.sin(rad)) + size.y * Math.abs(Math.cos(rad)) - size.y) / 2;
                var pad = L.point(Math.ceil(Math.max(0, extraX)), Math.ceil(Math.max(0, extraY)));
                return new L.Bounds(bounds.min.subtract(pad), bounds.max.add(pad));
            }
        });
    }

    /* Vector layers (the country outline, heritage polygons, archeo rings,
     * measure, cluster spiderwebs…) are placed *and clipped* inside the box
     * L.Renderer._update derives for their SVG/canvas element. That box comes
     * from containerPointToLayerPoint — the very method this plugin rotates —
     * so a turned view hands the renderer one turned corner with an
     * axis-aligned size instead of the box of the turned viewport. Whatever the
     * turn pushes outside that box is then thrown away twice (Polyline
     * ._clipPoints and the element's own viewport), and because the box travels
     * with the pane position and the viewport size, whole arcs of the border
     * disappear and reappear while the user zooms or drags — at 90° the country
     * outline vanishes completely. Take the four padded view corners through the
     * same rotation and use their bounding box, the compensation
     * _getTiledPixelBounds below already gives the tile grid. */
    if (L.Renderer && typeof L.Renderer.prototype._update === 'function') {
        var origRendererUpdate = L.Renderer.prototype._update;
        L.Renderer.include({
            _update: function () {
                var map = this._map;
                // North-up (or a map without rotation) must keep Leaflet's own
                // path untouched, down to the pixel. SVG only: a <path> that
                // falls outside the element box is *gone*, so vector layers need
                // the corrected window, while a canvas renderer merely keeps
                // drawing into its own bitmap — growing that to the 45° bounding
                // box would double the backing store of every canvas layer (×DPR²,
                // and this app has four of them) for a sub-pixel clip. The
                // heritage/LiDAR canvases are glued to their anchor separately
                // (see _updateCanvasTransform in map-app.js).
                if (!map || !map._rotate || !map._bearing || typeof map._pivot !== 'function' ||
                    !(L.SVG && this instanceof L.SVG)) {
                    return origRendererUpdate.call(this);
                }
                var pad = this.options.padding || 0,
                    size = map.getSize(),
                    x0 = -size.x * pad, y0 = -size.y * pad,
                    x1 = size.x * (1 + pad), y1 = size.y * (1 + pad),
                    pivot = map._pivot(),
                    pos = map._getMapPanePos(),
                    minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(function (c) {
                    var p = rotatePoint(L.point(c[0], c[1]), -map._bearing, pivot).subtract(pos);
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                });
                // Grow outwards to whole pixels: never smaller than the turned
                // view, never fractional (a fractional element origin would put
                // vector edges and the tile grid on different pixel rows).
                this._bounds = new L.Bounds(
                    L.point(Math.floor(minX), Math.floor(minY)),
                    L.point(Math.ceil(maxX), Math.ceil(maxY)));
                this._center = map.getCenter();
                this._zoom = map.getZoom();
            }
        });
    }

    // Two-finger twist with intentional threshold and distance guard.
    // Pinch-zoom stays with Leaflet's own TouchZoom.
    L.Map.TouchRotate = L.Handler.extend({
        addHooks: function () {
            L.DomEvent.on(this._map._container, 'touchstart', this._onStart, this);
            // iOS Safari exposes a dedicated rotation delta on gesture events.
            this._onGestureStart = this._onGestureStart.bind(this);
            this._onGestureChange = this._onGestureChange.bind(this);
            this._onGestureEnd = this._onGestureEnd.bind(this);
            this._map._container.addEventListener('gesturestart', this._onGestureStart, { passive: false });
            this._map._container.addEventListener('gesturechange', this._onGestureChange, { passive: false });
            this._map._container.addEventListener('gestureend', this._onGestureEnd, { passive: false });
        },
        removeHooks: function () {
            L.DomEvent.off(this._map._container, 'touchstart', this._onStart, this);
            this._map._container.removeEventListener('gesturestart', this._onGestureStart);
            this._map._container.removeEventListener('gesturechange', this._onGestureChange);
            this._map._container.removeEventListener('gestureend', this._onGestureEnd);
            L.DomEvent.off(document, 'touchmove', this._onMove, this);
            L.DomEvent.off(document, 'touchend touchcancel', this._onEnd, this);
        },
        _onGestureStart: function (e) {
            if (!this._map._rotate || this._map.isRotateLocked()) return;
            this._usingGesture = true;
            this._gestureBearing = this._map.getBearing();
            this._gestureMoved = false;
            e.preventDefault();
        },
        _onGestureChange: function (e) {
            if (!this._map._rotate || this._map.isRotateLocked() || typeof e.rotation !== 'number') return;
            var rot = e.rotation;
            if (!this._gestureMoved) {
                if (Math.abs(rot) < TOUCH_ROTATE_THRESHOLD) return;
                this._gestureMoved = true;
            }
            // Smoothly subtract deadband so rotation begins gently without sudden jumps
            var smoothRot = rot > 0 ? (rot - TOUCH_ROTATE_THRESHOLD) : (rot + TOUCH_ROTATE_THRESHOLD);
            this._map.setBearing(this._gestureBearing + smoothRot, { noMove: true });
            e.preventDefault();
        },
        _onGestureEnd: function () {
            if (this._gestureMoved) this._map.fire('moveend');
            this._gestureMoved = false;
            this._usingGesture = false;
        },
        _onStart: function (e) {
            if (this._usingGesture) return;
            if (!e.touches || e.touches.length !== 2 || !this._map._rotate || this._map.isRotateLocked()) return;
            var a = this._map.mouseEventToContainerPoint(e.touches[0]);
            var b = this._map.mouseEventToContainerPoint(e.touches[1]);
            if (a.distanceTo(b) < MIN_TOUCH_DISTANCE) return;
            this._startAngle = angleBetween(a, b);
            this._startBearing = this._map.getBearing();
            this._moved = false;
            L.DomEvent.on(document, 'touchmove', this._onMove, this);
            L.DomEvent.on(document, 'touchend touchcancel', this._onEnd, this);
        },
        _onMove: function (e) {
            if (this._usingGesture) return;
            if (!e.touches || e.touches.length !== 2 || this._map.isRotateLocked()) return;
            var a = this._map.mouseEventToContainerPoint(e.touches[0]);
            var b = this._map.mouseEventToContainerPoint(e.touches[1]);
            if (a.distanceTo(b) < MIN_TOUCH_DISTANCE) return;
            var angle = angleBetween(a, b);
            var delta = wrapDeg(angle - this._startAngle);
            if (!this._moved) {
                if (Math.abs(delta) < TOUCH_ROTATE_THRESHOLD) return;
                this._moved = true;
            }
            // Smoothly subtract deadband so rotation starts smoothly
            var smoothDelta = delta > 0 ? (delta - TOUCH_ROTATE_THRESHOLD) : (delta + TOUCH_ROTATE_THRESHOLD);
            this._map.setBearing(this._startBearing + smoothDelta, { noMove: true });
            L.DomEvent.preventDefault(e);
        },
        _onEnd: function () {
            L.DomEvent.off(document, 'touchmove', this._onMove, this);
            L.DomEvent.off(document, 'touchend touchcancel', this._onEnd, this);
            if (this._moved) this._map.fire('moveend');
            this._moved = false;
        }
    });

    // Desktop: Alt/Option-drag rotates; Ctrl/Cmd + wheel nudges the bearing.
    L.Map.KeyRotate = L.Handler.extend({
        addHooks: function () {
            this._onDown = this._onDown.bind(this);
            this._onWheel = this._onWheel.bind(this);
            this._map._container.addEventListener('mousedown', this._onDown, true);
            this._map._container.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
        },
        removeHooks: function () {
            this._map._container.removeEventListener('mousedown', this._onDown, true);
            this._map._container.removeEventListener('wheel', this._onWheel, true);
            L.DomEvent.off(document, 'mousemove', this._onMove, this);
            L.DomEvent.off(document, 'mouseup', this._onUp, this);
        },
        _isRotateMod: function (e) {
            return !!(e.altKey && e.button === 0);
        },
        _onDown: function (e) {
            if (!this._map._rotate || this._map.isRotateLocked() || !this._isRotateMod(e)) return;
            this._startX = e.clientX;
            this._startBearing = this._map.getBearing();
            this._moved = false;
            this._dragWasEnabled = this._map.dragging && this._map.dragging.enabled();
            if (this._dragWasEnabled) this._map.dragging.disable();
            L.DomUtil.disableTextSelection();
            L.DomEvent.on(document, 'mousemove', this._onMove, this);
            L.DomEvent.on(document, 'mouseup', this._onUp, this);
            L.DomEvent.preventDefault(e);
            L.DomEvent.stopPropagation(e);
        },
        _onMove: function (e) {
            if (this._map.isRotateLocked()) return;
            var rawDelta = (e.clientX - this._startX) * 0.35;
            if (!this._moved) {
                if (Math.abs(rawDelta) < 2.5) return;
                this._moved = true;
            }
            var delta = rawDelta > 0 ? (rawDelta - 2.5) : (rawDelta + 2.5);
            this._map.setBearing(this._startBearing + delta, { noMove: true });
            L.DomEvent.preventDefault(e);
        },
        _onUp: function () {
            L.DomUtil.enableTextSelection();
            L.DomEvent.off(document, 'mousemove', this._onMove, this);
            L.DomEvent.off(document, 'mouseup', this._onUp, this);
            if (this._dragWasEnabled && this._map.dragging) this._map.dragging.enable();
            this._dragWasEnabled = false;
            if (this._moved) this._map.fire('moveend');
            this._moved = false;
        },
        _onWheel: function (e) {
            if (!this._map._rotate || this._map.isRotateLocked() || !(e.altKey || (e.ctrlKey && e.shiftKey))) return;
            var delta = e.deltaY || e.wheelDelta || 0;
            this._map.setBearing(this._map.getBearing() + (delta > 0 ? 5 : -5));
            e.preventDefault();
            e.stopPropagation();
        }
    });

    L.Control.Compass = L.Control.extend({
        options: {
            position: 'bottomleft'
        },
        onAdd: function (map) {
            var self = this;
            this._map = map;
            this._isLocked = map.isRotateLocked ? map.isRotateLocked() : false;

            var wrap = this._container = L.DomUtil.create('div', 'leaflet-control detectlab-compass');
            var col = this._track = L.DomUtil.create('div', 'detectlab-compass-col', wrap);
            col.id = 'compassCol';

            // 1. Compass rose (tap -> reset to true north).
            var btn = this._btn = L.DomUtil.create('button', 'detectlab-compass-btn', col);
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Reset north');
            btn.title = 'Reseteaza nordul / Reset north';
            btn.innerHTML =
                '<span class="detectlab-compass-rose" aria-hidden="true">' +
                    '<svg viewBox="0 0 48 48">' +
                        '<circle class="dl-compass-ring" cx="24" cy="24" r="21.5"/>' +
                        '<path class="dl-compass-needle-n" d="M24 7 L28.2 24 L24 21.4 L19.8 24 Z"/>' +
                        '<path class="dl-compass-needle-s" d="M24 41 L28.2 24 L24 26.6 L19.8 24 Z"/>' +
                        '<circle class="dl-compass-hub" cx="24" cy="24" r="3"/>' +
                        '<text class="dl-compass-n" x="24" y="16" text-anchor="middle">N</text>' +
                    '</svg>' +
                '</span>';
            this._rose = btn.querySelector('.detectlab-compass-rose');

            // 2. Rotation lock toggle (tap -> lock / unlock screen turning).
            var lock = this._dock = L.DomUtil.create('button', 'detectlab-compass-lock', col);
            lock.type = 'button';
            lock.id = 'compassLockBtn';
            lock.setAttribute('aria-label', 'Toggle rotation lock');
            lock.innerHTML =
                '<svg class="dl-lock-icon-unlocked" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
                    '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>' +
                '</svg>' +
                '<svg class="dl-lock-icon-locked" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
                    '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
                '</svg>';

            // 3. Activity-detection toggle (PWA only, hidden on desktop via CSS).
            var det = this._detectBtn = L.DomUtil.create('button', 'compass-detect-btn', col);
            det.type = 'button';
            det.id = 'pwaDetectBtn';
            det.setAttribute('aria-label', 'Toggle activity detection');
            det.setAttribute('aria-pressed', 'false');
            det.title = 'Detectare activitate / Activity detection';
            det.innerHTML =
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<line x1="5" y1="3" x2="9" y2="7"/>' +
                    '<path d="M5 3 Q3 3 3 5 Q3 7 5 7 L9 7"/>' +
                    '<line x1="9" y1="7" x2="17" y2="18"/>' +
                    '<ellipse cx="18.5" cy="19.5" rx="3.5" ry="1.8" transform="rotate(-30 18.5 19.5)"/>' +
                '</svg>';

            L.DomEvent.disableClickPropagation(wrap);
            L.DomEvent.disableScrollPropagation(wrap);

            this._onCompassTap = function (e) {
                L.DomEvent.stop(e);
                if (self._map) self._map.resetBearing();
            };
            this._onLockTap = function (e) {
                L.DomEvent.stop(e);
                self.setLocked(!self._isLocked);
            };
            this._onDetectTap = function (e) {
                L.DomEvent.stop(e);
                if (typeof window.togglePwaDetection === 'function') window.togglePwaDetection();
            };
            btn.addEventListener('click', this._onCompassTap);
            lock.addEventListener('click', this._onLockTap);
            det.addEventListener('click', this._onDetectTap);

            this._onRotate = L.bind(this._update, this);
            this._onLockChange = L.bind(this._updateLock, this);
            map.on('rotate', this._onRotate);
            map.on('rotatelockchange', this._onLockChange);

            this.setLocked(this._isLocked, { fromMap: true });
            this._update();
            return wrap;
        },
        onRemove: function (map) {
            map.off('rotate', this._onRotate);
            map.off('rotatelockchange', this._onLockChange);
            if (this._btn && this._onCompassTap) this._btn.removeEventListener('click', this._onCompassTap);
            if (this._dock && this._onLockTap) this._dock.removeEventListener('click', this._onLockTap);
            if (this._detectBtn && this._onDetectTap) this._detectBtn.removeEventListener('click', this._onDetectTap);
        },
        setLocked: function (locked, options) {
            locked = !!locked;
            this._isLocked = locked;
            if (this._dock) {
                if (locked) {
                    this._dock.setAttribute('aria-label', 'Screen rotation locked. Tap to unlock.');
                    this._dock.title = 'Rotirea ecranului este blocata / Screen rotation locked. Atinge pentru a debloca / Tap to unlock.';
                } else {
                    this._dock.setAttribute('aria-label', 'Screen rotation unlocked. Tap to lock.');
                    this._dock.title = 'Atinge pentru a bloca rotirea / Tap to lock rotation.';
                }
            }
            if (this._track) {
                this._track.classList.toggle('is-locked', locked);
            }
            if (this._map && (!options || !options.fromMap)) {
                this._map.setRotateLocked(locked, { fromCompass: true });
            }
            this._update();
        },
        _updateLock: function (e) {
            if (e && e.locked !== undefined && e.locked !== this._isLocked) {
                this.setLocked(e.locked, { fromMap: true });
            }
        },
        _update: function () {
            var bearing = this._map ? this._map.getBearing() : 0;
            if (this._rose) {
                this._rose.style.transform = 'rotate(' + (-bearing) + 'deg)';
            }
            if (this._btn) {
                this._btn.classList.toggle('is-rotated', Math.abs(bearing) >= SNAP);
            }
        }
    });

    L.control.compass = function (options) {
        return new L.Control.Compass(options);
    };

    L.Map.addInitHook(function () {
        if (!this.options.rotate) return;
        this._rotate = true;
        this._bearing = wrapDeg(this.options.bearing || 0);

        var initialLocked = false;
        try {
            initialLocked = localStorage.getItem(STORAGE_LOCK_KEY) === 'true';
        } catch (e) {}
        this._rotateLocked = !!(this.options.rotateLocked || initialLocked);

        if (this._mapPane) this._mapPane._dlRotateMap = this;

        this.addHandler('touchRotate', L.Map.TouchRotate);
        this.addHandler('keyRotate', L.Map.KeyRotate);

        this.whenReady(function () {
            if (!this.compassControl) {
                this.compassControl = L.control.compass({ position: 'bottomleft' });
                this.compassControl.addTo(this);
            }
            if (this._rotateLocked) {
                this.compassControl.setLocked(true, { fromMap: true });
                if (this._container) this._container.classList.add('is-rotation-locked');
            }
            this._applyRotateTransform();
            if (this._bearing) this.fire('rotate', { bearing: this._bearing });
        });

        this.on('move zoom viewreset resize', this._applyRotateTransform, this);

        // Compensate one-finger drag so the map follows the finger while rotated.
        var map = this;
        var origEnable = this.dragging && this.dragging.enable;
        if (origEnable) {
            this.whenReady(function () {
                var draggable = map.dragging && map.dragging._draggable;
                if (!draggable || draggable._dlRotatePatched) return;
                draggable._dlRotatePatched = true;
                var protoMove = draggable._onMove;
                draggable._onMove = function (t) {
                    if (!map._bearing) return protoMove.call(this, t);
                    var ev = t.touches && t.touches.length === 1 ? t.touches[0] : t;
                    var cur = new L.Point(ev.clientX, ev.clientY);
                    var delta = cur._subtract(this._startPoint);
                    if (!delta.x && !delta.y) return;
                    if (Math.abs(delta.x) + Math.abs(delta.y) < this.options.clickTolerance) return;
                    var parent = this._parentScale || { x: 1, y: 1 };
                    delta.x /= parent.x;
                    delta.y /= parent.y;
                    delta = rotatePoint(delta, -map._bearing, L.point(0, 0));
                    L.DomEvent.preventDefault(t);
                    if (!this._moved) {
                        this.fire('dragstart');
                        this._moved = true;
                        L.DomUtil.addClass(document.body, 'leaflet-dragging');
                        this._lastTarget = t.target || t.srcElement;
                        L.DomUtil.addClass(this._lastTarget, 'leaflet-drag-target');
                    }
                    this._newPos = this._startPos.add(delta);
                    this._moving = true;
                    this._lastEvent = t;
                    this._updatePosition();
                };
            });
        }
    });
})(window.L);
