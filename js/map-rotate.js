/* DetectLab map rotation + Google-Earth-style compass
 *
 * Leaflet 1.9 has no built-in bearing. This module:
 *  - rotates the map pane around the viewport centre
 *  - keeps click / pan / pinch coordinates correct
 *  - lets the user twist the map with two fingers (touch)
 *    or Alt/Option-drag / Ctrl-wheel (desktop). The two-finger twist has a
 *    Google-Earth-style deadband: the fingers must travel ~34 px along the
 *    arc of the rotation before anything turns (never under 8°, however wide
 *    the fingers), and a pinch-zoom never turns the map at all — as soon as
 *    the finger spread changes, the gesture is a zoom and stays one.
 *  - shows a bottom-left column of 38x38 map buttons:
 *      * compass — the rose follows the camera continuously, a tap eases
 *        the view back to true north, a horizontal drag on the rose turns
 *        the view (the same two gestures as Google Earth's compass).
 *        There is intentionally no rotation lock: rotation is always
 *        available, exactly as in Google Earth.
 *      * Detect toggle (tap -> toggles activity detection; PWA only,
 *        hidden on desktop via CSS - desktop keeps the .map-controls switch)
 */
(function (L) {
    'use strict';
    if (!L || !L.Map) return;

    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;
    var SNAP = 3.0; // Snap to north when within 3 degrees
    /* Two-finger twist deadband — Google-Earth style.
     *
     * A fixed angle threshold (the old 9°) is wrong for touch: the same 9°
     * is a wide, deliberate sweep when the fingers are 300 px apart and a
     * 5 px twitch when they are close together, which is exactly what a
     * pinch-zoom produces. Google Earth gates a twist on how far the fingers
     * actually travel along the arc of their rotation, so the threshold is
     * expressed in pixels of arc at the CURRENT finger spacing, with a
     * degree floor so a very wide two-finger hand cannot rotate on a couple
     * of degrees. */
    var TOUCH_ROTATE_ARC = 34;      // px of tangential finger travel before a twist counts
    var TOUCH_ROTATE_ANGLE_MIN = 8; // …but never below this many degrees, however wide the fingers
    var TOUCH_ROTATE_ANGLE_MAX = 45; // …and never above this, however close together
    var MIN_TOUCH_DISTANCE = 64;   // px between fingers; closer than this the angle is pure noise
    /* Pinch arbitration: a two-finger zoom must never turn the map. If the
     * spread between the fingers changes by more than a few percent, the
     * gesture is a pinch, not a twist — Google Earth likewise keeps a pinch
     * purely radial. An already-engaged twist is cancelled (and locked out
     * for the rest of the gesture) as soon as it turns into a real pinch. */
    var TOUCH_PINCH_SLOP = 0.06;   // >6 % spread change before any twist engages → it is a pinch
    var TOUCH_PINCH_ABORT = 0.18;  // >18 % spread change cancels an already engaged twist
    /* iOS Safari's gesture events carry rotation in degrees but no finger
     * spacing, so they get their own (wider) degree deadband instead of the
     * arc test. */
    var TOUCH_GESTURE_MIN_ANGLE = 12;
    var COMPASS_DRAG_THRESHOLD = 3; // px of horizontal travel before a press becomes a drag
    var COMPASS_DRAG_SENSITIVITY = 0.55; // degrees of bearing per dragged pixel
    var RESET_DURATION = 320; // ms — Google Earth's ease back to north

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

    function rotatedViewportHalfSize(map) {
        var size = map.getSize();
        if (!map || !map._rotate || !map._bearing) {
            return size.divideBy(2);
        }
        var rad = Math.abs(map._bearing) * DEG;
        var cos = Math.abs(Math.cos(rad));
        var sin = Math.abs(Math.sin(rad));
        return L.point(
            (size.x * cos + size.y * sin) / 2,
            (size.x * sin + size.y * cos) / 2
        );
    }

    function fireRotationMoveEnd(map) {
        if (!map) return;
        map._dlRotationMoveEnd = true;
        try {
            map.fire('moveend');
        } finally {
            map._dlRotationMoveEnd = false;
        }
    }

    var origSetPosition = L.DomUtil.setPosition;
    var origGetBounds = L.Map.prototype.getBounds;
    var origContainerToLayer = L.Map.prototype.containerPointToLayerPoint;
    var origLayerToContainer = L.Map.prototype.layerPointToContainerPoint;
    var origLimitCenter = L.Map.prototype._limitCenter;
    var origLimitOffset = L.Map.prototype._limitOffset;
    var origPanInsideMaxBounds = L.Map.prototype._panInsideMaxBounds;
    var origGetTiledPixelBounds = L.GridLayer && L.GridLayer.prototype._getTiledPixelBounds;

    L.DomUtil.setPosition = function (el, point) {
        origSetPosition.call(this, el, point);
        if (el && el._dlRotateMap) el._dlRotateMap._applyRotateTransform();
    };

    L.Map.mergeOptions({
        rotate: false,
        touchRotate: true,
        keyRotate: true,
        bearing: 0
    });

    L.Map.include({
        getBearing: function () {
            return this._bearing || 0;
        },

        setBearing: function (deg, options) {
            if (!this._rotate) return this;
            options = options || {};
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
            if (Math.abs(from) < 1) return this.setBearing(0);
            var reduceMotion = false;
            try {
                reduceMotion = !!(window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            } catch (err) {}
            if (reduceMotion) {
                this.setBearing(0);
                fireRotationMoveEnd(this);
                return this;
            }
            var start = null;
            function step(ts) {
                if (start === null) start = ts;
                var t = Math.min(1, (ts - start) / RESET_DURATION);
                var eased = 1 - Math.pow(1 - t, 3);
                map.setBearing(from * (1 - eased), { noMove: t < 1 });
                if (t < 1) L.Util.requestAnimFrame(step);
                else fireRotationMoveEnd(map);
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
            } else if (!pane.style.transformOrigin || pane.style.transformOrigin === '0px 0px') {
                var animPivot = this._pivot();
                pane.style.transformOrigin = (animPivot.x - pos.x) + 'px ' + (animPivot.y - pos.y) + 'px';
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

    if (typeof origPanInsideMaxBounds === 'function') {
        L.Map.include({
            _panInsideMaxBounds: function () {
                // Turning the view in place (compass / twist / Alt-drag) fires
                // moveend only so tile layers refresh their rotated corners;
                // it must never re-centre or pan the camera away from the place
                // the user is inspecting.
                if (this._dlRotationMoveEnd) return this;
                return origPanInsideMaxBounds.apply(this, arguments);
            }
        });
    }

    if (typeof origLimitCenter === 'function') {
        L.Map.include({
            _limitCenter: function (center, zoom, bounds) {
                if (!this._rotate || !this._bearing || !bounds) {
                    return origLimitCenter.apply(this, arguments);
                }
                var target = L.latLng(center);
                var centerPoint = this.project(target, zoom);
                var half = rotatedViewportHalfSize(this);
                var viewBounds = L.bounds(centerPoint.subtract(half), centerPoint.add(half));
                var offset = this._getBoundsOffset(viewBounds, bounds, zoom);
                if (Math.abs(offset.x) <= 1 && Math.abs(offset.y) <= 1) {
                    return target;
                }
                return this.unproject(centerPoint.add(offset), zoom);
            }
        });
    }

    if (typeof origLimitOffset === 'function') {
        L.Map.include({
            _limitOffset: function (offset, bounds) {
                if (!this._rotate || !this._bearing || !bounds) {
                    return origLimitOffset.apply(this, arguments);
                }
                var centerPoint = this.project(this.getCenter(), this.getZoom());
                var half = rotatedViewportHalfSize(this);
                var viewBounds = L.bounds(
                    centerPoint.subtract(half).add(offset),
                    centerPoint.add(half).add(offset)
                );
                return offset.add(this._getBoundsOffset(viewBounds, bounds));
            }
        });
    }

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

    // Two-finger twist with a Google-Earth-style arc deadband and pinch
    // arbitration. Pinch-zoom stays with Leaflet's own TouchZoom and must
    // never turn the map: only a deliberate twist — the fingers travelling
    // tangentially around each other, not away from each other — rotates.
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

        /* How far the twist must go before it counts, for this finger spacing:
         * enough tangential travel along the arc of the rotation (px), clamped
         * to a sensible degree range. Close fingers therefore demand a big,
         * obvious angle; wide fingers demand real travel — never a twitch. */
        _angleThreshold: function (distance) {
            var deg = (TOUCH_ROTATE_ARC / Math.max(distance, 1)) * RAD;
            return Math.min(TOUCH_ROTATE_ANGLE_MAX, Math.max(TOUCH_ROTATE_ANGLE_MIN, deg));
        },

        /* The two-finger pair as { angle, distance }, or null when the angle
         * cannot be trusted (not two fingers, or fingers too close together). */
        _pair: function (e) {
            if (!e.touches || e.touches.length !== 2) return null;
            var a = this._map.mouseEventToContainerPoint(e.touches[0]);
            var b = this._map.mouseEventToContainerPoint(e.touches[1]);
            var distance = a.distanceTo(b);
            if (distance < MIN_TOUCH_DISTANCE) return null;
            return { angle: angleBetween(a, b), distance: distance };
        },

        /* (Re)start the gesture's reference frame at the current finger pair.
         * Used at touchstart and again whenever the fingers were too close to
         * read and have just spread far enough apart. */
        _rebase: function (e) {
            var g = this._gesture;
            var pair = this._pair(e);
            if (!g || !pair || g.engaged || g.pinching) return;
            g.startAngle = pair.angle;
            g.startBearing = this._map.getBearing();
            g.startDistance = pair.distance;
            g.engagedDistance = pair.distance;
            g.pending = false;
        },

        _onStart: function (e) {
            if (this._usingGesture) return;
            if (!e.touches || e.touches.length !== 2 || !this._map._rotate) return;
            this._gesture = {
                pending: true,   // no trustworthy angle yet — baselined below
                engaged: false,
                pinching: false,
                offset: 0
            };
            L.DomEvent.on(document, 'touchmove', this._onMove, this);
            L.DomEvent.on(document, 'touchend touchcancel', this._onEnd, this);
            this._rebase(e);
        },

        _onMove: function (e) {
            if (this._usingGesture || !this._gesture) return;
            if (!e.touches || e.touches.length !== 2) return;
            var g = this._gesture;
            var pair = this._pair(e);
            if (!pair) {
                // Fingers converged below a readable spacing mid-twist: the
                // angle is noise now — stop turning and lock the gesture out.
                if (g.engaged) {
                    g.pinching = true;
                    g.engaged = false;
                    fireRotationMoveEnd(this._map);
                }
                return;
            }
            if (g.pinching) return;
            if (g.pending) {
                this._rebase(e);
                if (g.pending) return;
            }
            var twist = wrapDeg(pair.angle - g.startAngle);
            if (!g.engaged) {
                // Engagement is checked BEFORE the pinch gate: a deliberate
                // twist with a little spread drift must never be swallowed by
                // the zoom rule — it must turn the map.
                if (Math.abs(twist) >= this._angleThreshold(pair.distance)) {
                    g.engaged = true;
                    g.engagedDistance = pair.distance;
                    g.offset = twist; // the turn starts from 0° — no jump at engage
                    var tz = this._map.touchZoom;
                    if (tz && tz._zooming) {
                        if (tz._animRequest) {
                            L.Util.cancelAnimFrame(tz._animRequest);
                            tz._animRequest = null;
                        }
                        tz._center = this._map.getCenter();
                        tz._zoom = this._map.getZoom();
                        tz._moved = false;
                    }
                } else {
                    var spread = (pair.distance - g.startDistance) / g.startDistance;
                    if (Math.abs(spread) > TOUCH_PINCH_SLOP) {
                        // The fingers are moving apart/together: a two-finger zoom,
                        // not a request to turn. Google Earth keeps a pinch purely
                        // radial and so must we.
                        g.pinching = true;
                    }
                    return;
                }
            } else {
                var engagedSpread = (pair.distance - g.engagedDistance) / g.engagedDistance;
                if (Math.abs(engagedSpread) > TOUCH_PINCH_ABORT) {
                    // A real pinch grew out of the twist: stop turning and do
                    // not resume for the rest of the gesture.
                    g.pinching = true;
                    g.engaged = false;
                    fireRotationMoveEnd(this._map);
                    return;
                }
            }
            this._map.setBearing(g.startBearing + (twist - g.offset), { noMove: true });
            L.DomEvent.preventDefault(e);
        },

        _onEnd: function () {
            L.DomEvent.off(document, 'touchmove', this._onMove, this);
            L.DomEvent.off(document, 'touchend touchcancel', this._onEnd, this);
            if (this._gesture && this._gesture.engaged) fireRotationMoveEnd(this._map);
            this._gesture = null;
        },

        // iOS Safari gesture events: rotation in degrees, no finger spacing —
        // same pinch arbitration, with a degree deadband instead of the arc test.
        _onGestureStart: function (e) {
            if (!this._map._rotate) return;
            this._usingGesture = true;
            this._gesturePinch = false;
            this._gestureEngaged = false;
            this._gestureRotation = 0;
            this._gestureScale = (typeof e.scale === 'number' && e.scale) || 1;
            this._gestureBearing = this._map.getBearing();
            e.preventDefault();
        },
        _onGestureChange: function (e) {
            if (!this._map._rotate || typeof e.rotation !== 'number') return;
            e.preventDefault();
            if (this._gesturePinch) return;
            var scale = (typeof e.scale === 'number' && e.scale) || this._gestureScale;
            var rot = e.rotation;
            if (!this._gestureEngaged) {
                // Engagement is checked BEFORE the pinch gate — same rule as
                // the touch path: a deliberate turn must never be swallowed by
                // a few percent of natural scale drift.
                if (Math.abs(rot) < TOUCH_GESTURE_MIN_ANGLE) {
                    if (Math.abs(scale / this._gestureScale - 1) > TOUCH_PINCH_SLOP) {
                        // The scale is changing and the rotation is light: a
                        // zoom. Its rotation delta is finger noise, not a turn.
                        this._gesturePinch = true;
                    }
                    return;
                }
                this._gestureEngaged = true;
                this._gestureRotation = rot;      // the turn starts from 0°
                this._gestureBearing = this._map.getBearing();
            } else if (Math.abs(scale / this._gestureScale - 1) > TOUCH_PINCH_ABORT) {
                // An engaged twist that turns into a pinch stops dead.
                this._gesturePinch = true;
                this._gestureEngaged = false;
                fireRotationMoveEnd(this._map);
                return;
            }
            this._map.setBearing(this._gestureBearing + (rot - this._gestureRotation), { noMove: true });
        },
        _onGestureEnd: function () {
            if (this._gestureEngaged) fireRotationMoveEnd(this._map);
            this._gestureEngaged = false;
            this._gesturePinch = false;
            this._usingGesture = false;
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
            if (!this._map._rotate || !this._isRotateMod(e)) return;
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
            if (this._moved) fireRotationMoveEnd(this._map);
            this._moved = false;
        },
        _onWheel: function (e) {
            if (!this._map._rotate || !(e.altKey || (e.ctrlKey && e.shiftKey))) return;
            var delta = e.deltaY || e.wheelDelta || 0;
            this._map.setBearing(this._map.getBearing() + (delta > 0 ? 5 : -5));
            e.preventDefault();
            e.stopPropagation();
        }
    });

    /* Google-Earth-style compass.
     *
     * Movement: the rose is driven straight off the map's own `rotate` event,
     * so it tracks the camera frame by frame — during a two-finger twist, an
     * Alt-drag or a drag on the rose itself — and it never lags behind the
     * imagery.
     *
     * Function: a tap eases the view back to true north (320 ms, cubic
     * ease-out, the same gesture Google Earth binds to its compass), and a
     * horizontal drag on the rose turns the view. Rotation is always
     * available: there is no lock to release first.
     */
    L.Control.Compass = L.Control.extend({
        options: {
            position: 'bottomleft'
        },
        onAdd: function (map) {
            var self = this;
            this._map = map;
            this._drag = null;
            this._suppressClick = false;

            var wrap = this._container = L.DomUtil.create('div', 'leaflet-control detectlab-compass');
            var col = this._track = L.DomUtil.create('div', 'detectlab-compass-col', wrap);
            col.id = 'compassCol';

            // 1. Compass rose (tap -> face north; horizontal drag -> turn).
            var btn = this._btn = L.DomUtil.create('button', 'detectlab-compass-btn', col);
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Compass — drag to rotate, press Enter to face north');
            btn.title = 'Busola — trage pentru rotire, atinge pentru nord / Drag to rotate, tap for north';
            btn.innerHTML =
                '<span class="detectlab-compass-rose" aria-hidden="true">' +
                    '<svg viewBox="0 0 40 40" focusable="false">' +
                        '<circle class="dl-c-ring" cx="20" cy="20" r="17.4"/>' +
                        '<path class="dl-c-needle-n" d="M20 5.4 L23.2 20 L20 18.3 L16.8 20 Z"/>' +
                        '<path class="dl-c-needle-s" d="M20 34.6 L23.2 20 L20 21.7 L16.8 20 Z"/>' +
                        '<circle class="dl-c-hub" cx="20" cy="20" r="1.5"/>' +
                    '</svg>' +
                '</span>';
            this._rose = btn.querySelector('.detectlab-compass-rose');

            // 2. Activity-detection toggle (PWA only, hidden on desktop via CSS).
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

            this._onCompassClick = function (e) {
                L.DomEvent.stop(e);
                // A press that turned the view ends with a click on the same
                // button; that click must not also snap back to north.
                if (self._suppressClick) {
                    self._suppressClick = false;
                    return;
                }
                if (self._map) self._map.resetBearing();
            };

            this._onPointerDown = function (e) {
                if (!self._map) return;
                if (e.button !== undefined && e.button > 0) return;
                if (typeof e.clientX !== 'number') return;
                self._drag = {
                    startX: e.clientX,
                    bearing: self._map.getBearing(),
                    moved: false
                };
                btn.classList.add('is-dragging');
                // Propagation only: preventing the default here would also eat
                // the click that a plain tap needs in order to face north.
                L.DomEvent.stopPropagation(e);
            };

            this._onPointerMove = function (e) {
                var drag = self._drag;
                if (!drag || !self._map || typeof e.clientX !== 'number') return;
                var dx = e.clientX - drag.startX;
                if (!drag.moved) {
                    if (Math.abs(dx) < COMPASS_DRAG_THRESHOLD) return;
                    drag.moved = true;
                    self._suppressClick = true;
                }
                self._map.setBearing(drag.bearing + dx * COMPASS_DRAG_SENSITIVITY, { noMove: true });
                L.DomEvent.preventDefault(e);
            };

            this._onPointerUp = function (e) {
                var drag = self._drag;
                if (!drag) return;
                self._drag = null;
                btn.classList.remove('is-dragging');
                if (drag.moved && self._map) fireRotationMoveEnd(self._map);
                if (self._suppressClick) {
                    // pointerup is followed by click in the same interaction;
                    // clear the flag right after it so the next tap works.
                    setTimeout(function () { self._suppressClick = false; }, 0);
                }
                if (e) L.DomEvent.stopPropagation(e);
            };

            this._onCompassKeyDown = function (e) {
                if (!self._map) return;
                var step = e.shiftKey ? 15 : 5;
                if (e.key === 'ArrowLeft') {
                    self._map.setBearing(self._map.getBearing() - step);
                } else if (e.key === 'ArrowRight') {
                    self._map.setBearing(self._map.getBearing() + step);
                } else if (e.key === 'Home') {
                    self._map.resetBearing();
                } else {
                    return;
                }
                L.DomEvent.stop(e);
            };

            this._onDetectTap = function (e) {
                L.DomEvent.stop(e);
                if (typeof window.togglePwaDetection === 'function') window.togglePwaDetection();
            };

            btn.addEventListener('click', this._onCompassClick);
            btn.addEventListener('pointerdown', this._onPointerDown);
            btn.addEventListener('keydown', this._onCompassKeyDown);
            det.addEventListener('click', this._onDetectTap);
            document.addEventListener('pointermove', this._onPointerMove, { passive: false });
            document.addEventListener('pointerup', this._onPointerUp);
            document.addEventListener('pointercancel', this._onPointerUp);

            this._onRotate = L.bind(this._update, this);
            map.on('rotate', this._onRotate);

            this._update();
            return wrap;
        },
        onRemove: function (map) {
            map.off('rotate', this._onRotate);
            if (this._btn) {
                this._btn.removeEventListener('click', this._onCompassClick);
                this._btn.removeEventListener('pointerdown', this._onPointerDown);
                this._btn.removeEventListener('keydown', this._onCompassKeyDown);
            }
            if (this._detectBtn && this._onDetectTap) this._detectBtn.removeEventListener('click', this._onDetectTap);
            document.removeEventListener('pointermove', this._onPointerMove);
            document.removeEventListener('pointerup', this._onPointerUp);
            document.removeEventListener('pointercancel', this._onPointerUp);
        },
        _update: function () {
            var bearing = this._map ? this._map.getBearing() : 0;
            if (this._rose) {
                this._rose.style.transform = 'rotate(' + (-bearing) + 'deg)';
            }
            if (this._btn) {
                var offNorth = Math.abs(bearing) >= SNAP;
                this._btn.classList.toggle('is-rotated', offNorth);
                this._btn.setAttribute('aria-label', offNorth
                    ? 'Compass — ' + Math.round(Math.abs(bearing)) + '° from north. Drag to rotate, press Enter to face north.'
                    : 'Compass — facing north. Drag to rotate.');
            }
        }
    });

    L.control.compass = function (options) {
        return new L.Control.Compass(options);
    };

    /* Map.Drag._onDragStart computes _offsetLimit from latLngToContainerPoint(NW)
     * and latLngToContainerPoint(SE), which are rotated screen coordinates, while
     * _onPreDragLimit clamps (_draggable._newPos - _startPos) in unrotated
     * _mapPane layer coordinates. Near asymmetric border regions (e.g. Ramna in
     * Caraș-Severin under Romania's maxBounds with viscosity 1), rotating the
     * compass puts both NW and SE on the same side of the container origin so 0
     * lies outside _offsetLimit — the very first pointer move then snaps the map
     * hundreds of kilometres away. Compute _offsetLimit in unrotated world/pane
     * pixel space from the rotated viewport footprint, always containing 0. */
    if (L.Map.Drag && typeof L.Map.Drag.prototype._onDragStart === 'function') {
        var origDragStart = L.Map.Drag.prototype._onDragStart;
        L.Map.Drag.include({
            _onDragStart: function () {
                origDragStart.apply(this, arguments);
                var map = this._map;
                if (!map || !map._rotate || !map._bearing || !this._offsetLimit || !map.options.maxBounds) {
                    return;
                }
                var maxBounds = L.latLngBounds(map.options.maxBounds);
                if (!maxBounds.isValid()) return;
                var zoom = map.getZoom();
                var centerPx = map.project(map.getCenter(), zoom);
                var maxPx = L.bounds(
                    map.project(maxBounds.getNorthWest(), zoom),
                    map.project(maxBounds.getSouthEast(), zoom)
                );
                var half = rotatedViewportHalfSize(map);
                var spanX = maxPx.max.x - maxPx.min.x;
                var spanY = maxPx.max.y - maxPx.min.y;
                var minCenterX = spanX > 2 * half.x ? maxPx.min.x + half.x : (maxPx.min.x + maxPx.max.x) / 2;
                var maxCenterX = spanX > 2 * half.x ? maxPx.max.x - half.x : minCenterX;
                var minCenterY = spanY > 2 * half.y ? maxPx.min.y + half.y : (maxPx.min.y + maxPx.max.y) / 2;
                var maxCenterY = spanY > 2 * half.y ? maxPx.max.y - half.y : minCenterY;
                var minOffX = Math.min(0, centerPx.x - maxCenterX);
                var maxOffX = Math.max(0, centerPx.x - minCenterX);
                var minOffY = Math.min(0, centerPx.y - maxCenterY);
                var maxOffY = Math.max(0, centerPx.y - minCenterY);
                this._offsetLimit = L.bounds(
                    L.point(minOffX, minOffY),
                    L.point(maxOffX, maxOffY)
                );
            }
        });
    }

    /* Map.TouchZoom._onTouchMove subtracts the finger-midpoint offset `mid - center`
     * (in rotated container pixels) directly from project(_pinchStartLatLng) (in
     * unrotated world pixels), which teleports the view whenever the user pinches
     * in or out off-centre while rotated. Rotate that offset by -bearing into
     * world pixel space, and keep TouchZoom passive while an engaged two-finger
     * twist owns the gesture. */
    if (L.Map.TouchZoom && typeof L.Map.TouchZoom.prototype._onTouchMove === 'function') {
        var origTouchZoomStart = L.Map.TouchZoom.prototype._onTouchStart;
        var origTouchZoomMove = L.Map.TouchZoom.prototype._onTouchMove;
        L.Map.TouchZoom.include({
            _onTouchStart: function (e) {
                origTouchZoomStart.apply(this, arguments);
                if (this._zooming && e && e.touches && e.touches.length === 2 && this._map) {
                    var p1 = this._map.mouseEventToContainerPoint(e.touches[0]);
                    var p2 = this._map.mouseEventToContainerPoint(e.touches[1]);
                    this._dlStartMidpoint = p1.add(p2)._divideBy(2);
                }
            },
            _onTouchMove: function (e) {
                var map = this._map;
                if (!map || !map._rotate) {
                    return origTouchZoomMove.apply(this, arguments);
                }
                if (!e.touches || e.touches.length !== 2 || !this._zooming) return;
                var p1 = map.mouseEventToContainerPoint(e.touches[0]);
                var p2 = map.mouseEventToContainerPoint(e.touches[1]);
                var mid = p1.add(p2)._divideBy(2);
                var dist = p1.distanceTo(p2);
                var tr = map.touchRotate;
                if (tr && tr._gesture && tr._gesture.engaged) {
                    this._centerPoint = map.getSize()._divideBy(2);
                    this._startLatLng = map.containerPointToLatLng(this._centerPoint);
                    if (map.options.touchZoom !== 'center') {
                        this._pinchStartLatLng = map.containerPointToLatLng(mid);
                    }
                    this._startDist = dist || 1;
                    this._startZoom = map.getZoom();
                    this._dlStartMidpoint = mid.clone();
                    this._center = map.getCenter();
                    this._zoom = this._startZoom;
                    return;
                }
                if (!map._bearing) {
                    return origTouchZoomMove.apply(this, arguments);
                }
                var scale = dist / this._startDist;
                this._zoom = map.getScaleZoom(scale, this._startZoom);
                if (!map.options.bounceAtZoomLimits && (
                    (this._zoom < map.getMinZoom() && scale < 1) ||
                    (this._zoom > map.getMaxZoom() && scale > 1)
                )) {
                    this._zoom = map._limitZoom(this._zoom);
                }
                if (map.options.touchZoom === 'center') {
                    this._center = this._startLatLng;
                    if (scale === 1) return;
                } else {
                    var delta = mid.subtract(this._centerPoint);
                    if (scale === 1 && (
                        (delta.x === 0 && delta.y === 0) ||
                        (this._dlStartMidpoint && mid.equals(this._dlStartMidpoint))
                    )) {
                        return;
                    }
                    var unrotatedDelta = rotatePoint(delta, -map._bearing, L.point(0, 0));
                    this._center = map.unproject(
                        map.project(this._pinchStartLatLng, this._zoom).subtract(unrotatedDelta),
                        this._zoom
                    );
                }
                if (!this._moved) {
                    map._moveStart(true, false);
                    this._moved = true;
                }
                L.Util.cancelAnimFrame(this._animRequest);
                var moveFn = L.bind(map._move, map, this._center, this._zoom, { pinch: true, round: false }, undefined);
                this._animRequest = L.Util.requestAnimFrame(moveFn, this, true);
                L.DomEvent.preventDefault(e);
            }
        });
    }

    /* Keyboard arrow pan: rotate screen-direction pan vectors into mapPane space. */
    if (L.Map.Keyboard && typeof L.Map.Keyboard.prototype._onKeyDown === 'function') {
        var origKeyDown = L.Map.Keyboard.prototype._onKeyDown;
        L.Map.Keyboard.include({
            _onKeyDown: function (e) {
                var map = this._map;
                if (!map || !map._rotate || !map._bearing || e.altKey || e.ctrlKey || e.metaKey ||
                    !(e.keyCode in (this._panKeys || {}))) {
                    return origKeyDown.apply(this, arguments);
                }
                if (map._panAnim && map._panAnim._inProgress) {
                    L.DomEvent.stop(e);
                    return;
                }
                var offset = L.point(this._panKeys[e.keyCode]);
                if (e.shiftKey) offset = offset.multiplyBy(3);
                offset = rotatePoint(offset, -map._bearing, L.point(0, 0)).round();
                if (map.options.maxBounds) {
                    offset = map._limitOffset(offset, map.options.maxBounds);
                }
                if (map.options.worldCopyJump) {
                    var newLatLng = map.wrapLatLng(map.unproject(map.project(map.getCenter()).add(offset)));
                    map.panTo(newLatLng);
                } else {
                    map.panBy(offset);
                }
                L.DomEvent.stop(e);
            }
        });
    }

    /* Shift-drag BoxZoom: build LatLngBounds from all 4 rotated screen corners. */
    if (L.Map.BoxZoom && typeof L.Map.BoxZoom.prototype._onMouseUp === 'function') {
        var origBoxZoomUp = L.Map.BoxZoom.prototype._onMouseUp;
        L.Map.BoxZoom.include({
            _onMouseUp: function (e) {
                var map = this._map;
                if (!map || !map._rotate || !map._bearing) {
                    return origBoxZoomUp.apply(this, arguments);
                }
                if (e.which !== 1 && e.button !== 1) return;
                this._finish();
                if (!this._moved) return;
                this._clearDeferredResetState();
                this._resetStateTimeout = setTimeout(L.bind(this._resetState, this), 0);
                var p0 = this._startPoint;
                var p1 = this._point;
                var bounds = L.latLngBounds([
                    map.containerPointToLatLng(p0),
                    map.containerPointToLatLng(L.point(p1.x, p0.y)),
                    map.containerPointToLatLng(p1),
                    map.containerPointToLatLng(L.point(p0.x, p1.y))
                ]);
                map.fitBounds(bounds).fire('boxzoomend', { boxZoomBounds: bounds });
            }
        });
    }

    L.Map.addInitHook(function () {
        if (!this.options.rotate) return;
        this._rotate = true;
        this._bearing = wrapDeg(this.options.bearing || 0);

        // Older builds persisted a rotation lock; drop the stale key so the
        // removed lock cannot keep a returning visitor's map pinned.
        try {
            localStorage.removeItem('detectlab_rotation_locked');
        } catch (e) {}

        if (this._mapPane) this._mapPane._dlRotateMap = this;

        this.addHandler('touchRotate', L.Map.TouchRotate);
        this.addHandler('keyRotate', L.Map.KeyRotate);

        this.whenReady(function () {
            if (!this.compassControl) {
                this.compassControl = L.control.compass({ position: 'bottomleft' });
                this.compassControl.addTo(this);
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
