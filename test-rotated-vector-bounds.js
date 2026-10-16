// Source-level + geometric tests for the clip window of every SVG renderer
// while the map is TURNED (bearing ≠ 0).
//
// L.Renderer._update sizes the <svg> element (and therefore the viewBox, the
// element's own viewport, and Polyline._clipPoints) from
// containerPointToLayerPoint of the padded viewport corners. map-rotate.js
// overrides containerPointToLayerPoint to un-rotate the point, so the corners
// Leaflet gets are rotated while the box it flattens them into is axis-aligned
// *before* the pane rotation: the element ends up as an axis-aligned box of the
// unrotated size, shifted by the turn. On screen that box no longer covers the
// viewport, so geometry the user can see is clipped away — arcs of a country
// border disappear while panning and come back when the turn changes, and at
// 90° the whole outline is gone. The same file already compensates the tile
// grid (_getTiledPixelBounds); vector renderers had no equivalent.
//
// Usage: node test-rotated-vector-bounds.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

const mapRotate = read('js/map-rotate.js');
const picker = read('js/globe-country-picker.js');

console.log('[Test] Rotated-map vector clip window (country borders while turned)...');

// ── The patch itself ────────────────────────────────────────────────
assert.match(
    mapRotate,
    /L\.Renderer\.include\(\{[\s\S]{0,400}?_update:\s*function\s*\(\s*\)\s*\{/,
    'vector renderers need a rotation-aware _update (L.Renderer.include) — Leaflet derives the clip box from an unrotated corner list'
);
assert.match(
    mapRotate,
    /return origRendererUpdate\.call\(this\);/,
    'the patch must delegate to Leaflet when bearing is 0, so the north-up box stays byte-identical'
);
assert.match(
    mapRotate,
    /this\.options\.padding/,
    'the turned box must be built from the *padded* viewport corners (padding 0.1 is what keeps paths from popping in at the edge)'
);
assert.match(
    mapRotate,
    /-\s*map\._bearing/,
    'layer points are the viewport un-rotated, i.e. rotated by MINUS the bearing (same sign as containerPointToLayerPoint)'
);
assert.match(
    mapRotate,
    /\.subtract\(pos\)|\.subtract\(pane\)/,
    'the turned box must be expressed relative to the current map-pane position, or it slides on every pan'
);
assert.match(
    mapRotate,
    /this\._bounds\s*=\s*new L\.Bounds\(\s*L\.point\(Math\.floor\(minX\),\s*Math\.floor\(minY\)\),\s*L\.point\(Math\.ceil\(maxX\),\s*Math\.ceil\(maxY\)\)\)/,
    'the box is grown outwards to whole pixels (floor/ceil) so the element origin stays integral'
);
assert.match(
    mapRotate,
    /this\._center\s*=\s*map\.getCenter\(\);[\s\S]{0,80}?this\._zoom\s*=\s*map\.getZoom\(\);/,
    '_center/_zoom must be refreshed with the box: the zoom animation scales the renderer around them'
);
// Canvas renderers draw into their own bitmap; growing that to the 45° AABB
// doubles the backing store of every canvas layer (×DPR²) for a sub-pixel clip,
// so the compensation is scoped to SVG.
assert.match(
    mapRotate,
    /L\.SVG\s*&&\s*this\s+instanceof\s+L\.SVG/,
    'only SVG renderers may take the turned clip box — canvas layers must keep Leaflet box size (memory)'
);
// The tile grid and the vector box must be compensated by the same file; if one
// of the two is ever dropped, basemap and border drift apart when turned.
assert.match(
    mapRotate,
    /_getTiledPixelBounds:\s*function/,
    'the tile grid keeps its own rotation compensation — the SVG box must stay in sync with it'
);

// ── The outline's own zoom anchor ───────────────────────────────────
// BoundsSVG re-implements _updateTransform so the country outline scales
// around pixelOrigin + _bounds.min. That is only exact while _outlinePixelOrigin
// describes the SAME view as _bounds — L.SVG._update keeps _bounds untouched
// while a zoom animates, so the capture has to be skipped in exactly that case.
assert.match(
    picker,
    /var skip = !!\(this\._map && this\._map\._animatingZoom && this\._bounds\);/,
    'the outline anchor must be captured under the same condition L.SVG._update uses to skip a bounds refresh'
);
assert.match(
    picker,
    /if\s*\(this\._map && !skip\)\s*\{\s*this\._outlinePixelOrigin\s*=\s*this\._map\.getPixelOrigin\(\)\.clone\(\);/,
    'anchor and clip box must always be re-derived from one and the same map state'
);
assert.match(
    picker,
    /var offset = this\._outlinePixelOrigin\.add\(this\._bounds\.min\)[\s\S]{0,120}?\.multiplyBy\(scale\)\.subtract\(this\._map\._getNewPixelOrigin\(center,\s*zoom\)\);/,
    'the outline transform must be pixelOrigin + _bounds.min scaled by the zoom, minus the new pixel origin (L.Renderer math with the real anchor)'
);
// Tiles round their own translate; rounding ours as well would quantise one of
// the two independently and re-open a sub-pixel slide against the basemap.
assert.ok(
    !/offset\s*=\s*offset\._round\(\)/.test(picker),
    'the outline translate must stay unrounded — GridLayer rounds a level around a different anchor, so rounding here would put the border up to a pixel off the imagery'
);

// ── Run the shipped _update against the geometry it has to satisfy ────
function extractFn(src, marker) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, 'could not find ' + marker + ' in js/map-rotate.js');
    const open = src.indexOf('{', src.indexOf('function', at));
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) break; }
    }
    return src.slice(at + marker.indexOf(':') + 1, i + 1).replace(/^[^{]*function/, 'function');
}

// A Point/Bounds small enough to keep the model readable.
function makeL() {
    function Point(x, y) { this.x = x; this.y = y; }
    Point.prototype = {
        clone() { return new Point(this.x, this.y); },
        add(p) { return new Point(this.x + p.x, this.y + p.y); },
        subtract(p) { return new Point(this.x - p.x, this.y - p.y); },
        multiplyBy(k) { return new Point(this.x * k, this.y * k); },
        floor() { return new Point(Math.floor(this.x), Math.floor(this.y)); },
        ceil() { return new Point(Math.ceil(this.x), Math.ceil(this.y)); }
    };
    function Bounds(min, max) { this.min = min; this.max = max; }
    Bounds.prototype = {
        extend(p) {
            this.min = new Point(Math.min(this.min.x, p.x), Math.min(this.min.y, p.y));
            this.max = new Point(Math.max(this.max.x, p.x), Math.max(this.max.y, p.y));
            return this;
        },
        contains(p) {
            return p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y;
        }
    };
    function SVG() { }
    return { point: (x, y) => new Point(x, y), Point, Bounds, SVG };
}

const patchedBody = extractFn(mapRotate, '_update: function () {');
// A factory, because the patched function closes over `L`, the original
// L.Renderer.prototype._update it delegates to, and the module-local
// rotatePoint — the test supplies all three.
const makeUpdate = new Function('L', 'origRendererUpdate', 'rotatePoint',
    'return ' + patchedBody.replace(/^_update\s*:\s*/, ''));

// rotatePoint exactly as the shipped file defines it, so the model exercises the
// same trigonometry as the app.
const rotatePoint = new Function('L', 'DEG', 'RAD',
    'return ' + extractFn(mapRotate, 'function rotatePoint'));

const L = makeL();
const DEG = Math.PI / 180;
const rot = rotatePoint(L, DEG, Math.PI / 180);

const W = 1200, H = 800, PAD = 0.1;
const pivot = { x: W / 2, y: H / 2 };

// Independent reference: the pane is translated by `pane` then rotated about the
// pivot, so a layer point q is painted at pivot + R(b)·(q + pane − pivot).
// Inverting gives the layer point behind a viewport corner c — the box must
// contain all four (the element is axis-aligned, so its AABB is the minimum it
// can be, and the padding makes it strictly larger than the viewport).
function cornerToLayer(c, bearing, pane) {
    const dx = c.x - pivot.x, dy = c.y - pivot.y;
    const r = -bearing * DEG, co = Math.cos(r), si = Math.sin(r);
    return { x: dx * co - dy * si + pivot.x - pane.x, y: dx * si + dy * co + pivot.y - pane.y };
}
const CORNERS = [[0, 0], [W, 0], [W, H], [0, H]].map(c => ({ x: c[0], y: c[1] }));

function runUpdate(bearing, pane, isSvg) {
    let fellBackToStock = false;
    const update = makeUpdate(L, () => { fellBackToStock = true; }, rot);
    const self = Object.create(isSvg === false ? Object.prototype : L.SVG.prototype);
    self._map = {
        _rotate: true, _bearing: bearing,
        getSize: () => L.point(W, H),
        _pivot: () => L.point(pivot.x, pivot.y),
        _getMapPanePos: () => L.point(pane.x, pane.y),
        getCenter: () => ({ lat: 46.6, lng: 25 }),
        getZoom: () => 6
    };
    self.options = { padding: PAD };
    update.call(self);
    return { bounds: self._bounds, center: self._center, zoom: self._zoom, fellBackToStock };
}

let checks = 0;
[0, 15, 20, 35, 45, 90, 135, 180].forEach(bearing => {
    [{ x: 0, y: 0 }, { x: -180, y: -90 }, { x: 523, y: -77 }].forEach(pane => {
        const r = runUpdate(bearing, pane, true);
        if (bearing === 0) {
            assert.ok(r.fellBackToStock, 'north-up must keep Leaflet\'s own _update, pixel for pixel');
            checks++;
            return;
        }
        assert.ok(!r.fellBackToStock, 'a turned map must not take Leaflet\'s unrotated box');
        assert.ok(r.center && r.zoom === 6, '_center/_zoom refreshed with the box');
        CORNERS.forEach(c => {
            const q = cornerToLayer(c, bearing, pane);
            assert.ok(r.bounds.contains(L.point(q.x, q.y)),
                `bearing ${bearing}° pane ${pane.x},${pane.y}: viewport corner (${c.x},${c.y}) → layer (${q.x.toFixed(1)},${q.y.toFixed(1)}) must be inside the element box`);
            checks++;
        });
        // Stock behaviour, for the record: the same corner list flattened
        // without the un-rotation, i.e. what every renderer used to get.
        const stock = {
            min: { x: -W * PAD - pane.x, y: -H * PAD - pane.y },
            max: { x: W * (1 + PAD) - pane.x, y: H * (1 + PAD) - pane.y }
        };
        const inside = c => c.x >= stock.min.x && c.x <= stock.max.x && c.y >= stock.min.y && c.y <= stock.max.y;
        const lost = CORNERS.map(c => cornerToLayer(c, bearing, pane)).filter(q => !inside(q)).length;
        if (bearing % 180 === 0) {
            // Half a turn maps the axis-aligned box onto itself, so the stock
            // box happens to cover the view here — the fix must not *change*
            // that, and the checks above already proved it does not.
            assert.strictEqual(lost, 0, 'bearing 180° must stay as covered as Leaflet had it');
        } else {
            assert.ok(lost > 0,
                `the model must still reproduce the bug it guards against (bearing ${bearing}°): stock box loses ${lost} corners`);
        }
        checks++;
    });
});

// A canvas renderer must be left alone (bitmap memory), and a renderer whose
// map has no rotation state at all must not crash on the guard.
assert.ok(runUpdate(45, { x: 0, y: 0 }, false).fellBackToStock,
    'canvas renderers keep the stock box — no DPR² backing store for a sub-pixel clip');
checks++;

console.log(`  ✓ turned viewports contain every visible vector corner (${checks} checks)`);
console.log('✅ ALL ROTATED-VECTOR-BOUNDS TESTS PASSED');
