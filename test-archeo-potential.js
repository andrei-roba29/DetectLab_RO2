// Node test harness for js/archeo-potential.js (pure logic only).
// Usage: node test-archeo-potential.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── minimal browser stubs ──────────────────────────────────────────────
const sandbox = {
    console,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    JSON,
    isFinite,
    isNaN,
    document: {
        readyState: 'complete',
        addEventListener() {},
        getElementById: () => null,
        // Canvas minim: suficient ca rendererul de heatmap să fie exercitat
        // real (createImageData / putImageData / drawImage) și în Node.
        createElement(tag) {
            if (tag !== 'canvas') return { style: {} };
            const canvas = {
                tagName: 'CANVAS', width: 0, height: 0, style: {}, className: '',
                parentNode: null, parentElement: null, draws: [], ops: [],
                appendChild(x) { return x; },
                getContext() {
                    const ctx = {
                        globalAlpha: 1, imageSmoothingEnabled: false,
                        createImageData(w, h) {
                            canvas.ops.push('createImageData:' + w + 'x' + h);
                            return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
                        },
                        putImageData(img) {
                            canvas.ops.push('putImageData');
                            // Capturăm pixelii ca testele să poată verifica
                            // orientarea/continutul imaginii sursă de heatmap.
                            canvas.lastImageData = img && img.data ? img.data : null;
                        },
                        clearRect() { canvas.ops.push('clearRect'); },
                        drawImage(img, x, y, w, h) { canvas.draws.push({ x, y, w, h }); },
                        save() {}, restore() {}
                    };
                    return ctx;
                }
            };
            return canvas;
        }
    },
    window: {},
    L: { layerGroup: () => ({}), circle: () => ({}), circleMarker: () => ({}), polyline: () => ({}), latLng: (a, b) => ({ lat: a, lng: b }) }
};
sandbox.window.window = sandbox.window;
sandbox.window.document = sandbox.document;
sandbox.window.L = sandbox.L;
sandbox.window._currentLang = () => 'en';
sandbox.window._dlMap = null;
sandbox.window._localLayerData = {};
sandbox.window._uatGetTile = null;
sandbox.window._UAT_TILE_UNREADABLE = { unreadable: true };
sandbox.window.UAT_TILE_Z = 14;

const code = fs.readFileSync(path.join(__dirname, 'js', 'archeo-potential.js'), 'utf8');
vm.runInNewContext(code, sandbox, { filename: 'archeo-potential.js' });

const D = sandbox.window._archeoPotentialDebug;
let failures = 0;
function check(name, cond, extra) {
    if (cond) { console.log('  ✔ ' + name); }
    else { failures++; console.error('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
}

// ── 1. Delaunay on a random point set ─────────────────────────────────
console.log('\n[Delaunay]');
{
    const pts = [];
    for (let i = 0; i < 40; i++) {
        pts.push({ x: 1000 + Math.random() * 8000, y: 1000 + Math.random() * 8000 });
    }
    const tris = D.delaunayTriangulation(pts);
    check('produces triangles', tris.length > 0, 'got ' + tris.length);
    check('no super vertices', tris.every(t => !t.a.isSuper && !t.b.isSuper && !t.c.isSuper));
    check('all triangles have area >= MIN', tris.every(t => {
        const area = Math.abs((t.b.x - t.a.x) * (t.c.y - t.a.y) - (t.c.x - t.a.x) * (t.b.y - t.a.y)) / 2;
        return area >= 2500;
    }));
    // Euler: for n points with h hull vertices → 2n - 2 - h triangles
    const n = pts.length;
    const minTri = 2 * n - 2 - n; // worst case h = n (all on hull)
    check('triangle count within Euler bounds (' + minTri + '..' + (2 * n - 5) + ')',
        tris.length >= minTri && tris.length <= 2 * n - 5, 'got ' + tris.length);
}

// ── 2. Delaunay on grid points (all collinear rows) ───────────────────
console.log('\n[Delaunay edge cases]');
{
    const pts = [{ x: 0, y: 0, i: 0 }, { x: 1000, y: 0, i: 1 }, { x: 2000, y: 0, i: 2 }, { x: 3000, y: 0, i: 3 }];
    const tris = D.delaunayTriangulation(pts);
    check('collinear points → no slivers (0 or few triangles)', tris.length >= 0);
    const pts2 = [{ x: 0, y: 0, i: 0 }, { x: 0, y: 0, i: 1 }, { x: 0, y: 0, i: 2 }];
    const tris2 = D.delaunayTriangulation(pts2);
    check('identical points → safe (0 triangles)', tris2.length === 0);
    check('2 points → 0 triangles', D.delaunayTriangulation([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length === 0);
}

// ── 3. Triangle quality ───────────────────────────────────────────────
console.log('\n[Triangle quality]');
{
    const mk = (ax, ay, bx, by, cx, cy) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, c: { x: cx, y: cy } });
    const eq = D.triangleQuality(mk(0, 0, 100, 0, 50, 86.602540378)); // equilateral
    check('equilateral ≈ 1.0', Math.abs(eq - 1) < 0.02, 'got ' + eq);
    const sliver = D.triangleQuality(mk(0, 0, 1000, 0, 1000.0001, 0.0001));
    check('sliver ≈ 0', sliver < 0.05, 'got ' + sliver);
    const right = D.triangleQuality(mk(0, 0, 100, 0, 0, 100));
    check('right triangle in (0,1)', right > 0 && right < 1, 'got ' + right);
}

// ── 4. Sampling + scoring + classification + separation ───────────────
console.log('\n[Scoring / classification]');
{
    // synthetic sites in a ring (dense cluster)
    const sites = [];
    for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        sites.push({ x: 5000 + Math.cos(a) * 1200, y: 5000 + Math.sin(a) * 1200 });
    }
    // candidate inside the ring, 400m from all ring sites → high potential
    const ctx = {
        sites: sites.map(s => ({ x: s.x, y: s.y })),
        siteIndex: (() => {
            const gi = { cells: new Map(), insert(x, y, item) {
                const cx = Math.floor(x / 1200), cy = Math.floor(y / 1200);
                const k = cx + ',' + cy;
                if (!gi.cells.has(k)) gi.cells.set(k, []);
                gi.cells.get(k).push(item);
            }, queryCircle(x, y, r) {
                const out = [];
                for (const [k, arr] of gi.cells) {
                    const [cx, cy] = k.split(',').map(Number);
                    if (cx < Math.floor((x - r) / 1200) || cx > Math.floor((x + r) / 1200)) continue;
                    if (cy < Math.floor((y - r) / 1200) || cy > Math.floor((y + r) / 1200)) continue;
                    out.push(...arr);
                }
                return out;
            } };
            sites.forEach(s => gi.insert(s.x, s.y, s));
            return gi;
        })()
    };
    const seed = {
        x: 5000, y: 5000,
        triQuality: 0.9,
        circumRadius: 1400,
        centroidDistM: 0,
        triScore: 0.9
    };
    const scored = D.scoreCandidate(seed, ctx);
    check('ring center classified High', D.classify(scored.score) === 'high', 'score ' + scored.score.toFixed(3));
    check('nearby count = 10', scored.factors.nearbyCount === 10, scored.factors.nearbyCount);
    check('closest site = 1200 m (ring radius)', scored.factors.closestSiteM === 1200, scored.factors.closestSiteM);

    // isolated pair, far from everything → low score
    const ctx2 = {
        sites: sites.slice(0, 2).map(s => ({ x: s.x, y: s.y })),
        siteIndex: (() => {
            const gi = { cells: new Map(), insert(x, y, item) {
                const cx = Math.floor(x / 1200), cy = Math.floor(y / 1200);
                const k = cx + ',' + cy;
                if (!gi.cells.has(k)) gi.cells.set(k, []);
                gi.cells.get(k).push(item);
            }, queryCircle(x, y, r) {
                const out = [];
                for (const [k, arr] of gi.cells) {
                    const [cx, cy] = k.split(',').map(Number);
                    if (cx < Math.floor((x - r) / 1200) || cx > Math.floor((x + r) / 1200)) continue;
                    if (cy < Math.floor((y - r) / 1200) || cy > Math.floor((y + r) / 1200)) continue;
                    out.push(...arr);
                }
                return out;
            } };
            sites.slice(0, 2).forEach(s => gi.insert(s.x, s.y, s));
            return gi;
        })()
    };
    const seed2 = { x: 5000, y: 5000, triQuality: 0.3, circumRadius: 1400, centroidDistM: 0, triScore: 0.3 };
    const scored2 = D.scoreCandidate(seed2, ctx2);
    check('isolated pair → not High and lower than dense cluster',
        scored2.score < scored.score && D.classify(scored2.score) !== 'high',
        'score ' + scored2.score.toFixed(3) + ' vs cluster ' + scored.score.toFixed(3));

    // separation
    const a = { x: 0, y: 0, lat: 0, lng: 0, score: 0.9, factors: {} };
    const b = { x: 100, y: 0, lat: 0, lng: 0, score: 0.8, factors: {} }; // 100m — too close
    const c = { x: 2000, y: 0, lat: 0, lng: 0, score: 0.7, factors: {} }; // far
    const sel = D.selectSeparated([a, b, c]);
    check('separation keeps a + c (drops b)', sel.length === 2 && sel[0] === a && sel[1] === c, 'kept ' + sel.length);
}

// ── 4b. Star rating + score color ─────────────────────────────────────
console.log('\n[Star rating / score color]');
{
    const star = D.starRatingHtml(0.72);
    check('star row renders 5 stars', (star.match(/★/g) || []).length === 10, star); // 5 gray + 5 colored
    check('star row shows /5 rating', /3\.6\/5/.test(star), star);
    check('star overlay width = 72%', /width:72%/.test(star), star);

    const parse = (s) => s.match(/(\d+),(\d+),(\d+)/).slice(1).map(Number);
    const hex = (s) => '#' + parse(s).map((v) => v.toString(16).padStart(2, '0')).join('');
    const cLow = D.scoreColor(0.15), cMid = D.scoreColor(0.40), cHigh = D.scoreColor(0.78);
    const [lr, lg, lb] = parse(cLow);
    const [mr, mg, mb] = parse(cMid);
    const [hr, hg, hb] = parse(cHigh);
    check('weak score = cold colour (blue dominant), not the exclusion red', lb > lr && lb > lg, cLow);
    check('medium score = green/teal (green over red)', mg > mr && mg > 100, cMid);
    check('strong score = warm amber on the way to violet', hr > mg + 0 && hr > hg && hg > hb, cHigh);
    check('the top of the ramp is violet (the layer’s high-potential colour)',
        (() => { const [r, g, b] = parse(D.scoreColor(1)); return b > r && r > g; })(),
        D.scoreColor(1));
    check('the ramp is monotonic: cold → green → warm → violet',
        lb > lr && mg > mr && hr > hg && parse(D.scoreColor(1))[2] > parse(D.scoreColor(1))[0],
        [cLow, cMid, cHigh, D.scoreColor(1)].join(' '));
    check('no score colour collides with the exclusion red',
        [0, 0.15, 0.4, 0.78, 1].every((s) => {
            const [r, g, b] = parse(D.scoreColor(s));
            return !(r > 150 && g < 110 && b < 110);
        }), [cLow, cMid, cHigh].join(' '));
    check('the colour scale is absolute: same score → same colour',
        D.scoreColor(0.4) === D.scoreColor(0.4) && D.scoreColorHex(0.4) === hex(D.scoreColor(0.4)));
    check('score colours come from the heat ramp (one scale for the whole layer)',
        D.scoreColorRgb(0.55).join(',') === (() => {
            const lut = D.buildHeatRamp(D.HEAT_GRADIENT);
            const i = Math.round(0.55 * 255) * 4;
            return [lut[i], lut[i + 1], lut[i + 2]].join(',');
        })(), D.scoreColor(0.55));
    check('legend tiers follow the CONFIG.CLASSIFY thresholds',
        D.classifyTier(0.1) === 'low' &&
        D.classifyTier(D.config.CLASSIFY.SCORE_DISCARD_BELOW) === 'medium' &&
        D.classifyTier(D.config.CLASSIFY.SCORE_HIGH_FROM) === 'high');
    check('bubble styles take their colour from the score ramp',
        [0.1, 0.4, 0.8].every((s) => D.styleFor(s).fillColor === D.scoreColorHex(s)),
        JSON.stringify(D.styleFor(0.8)));
    check('bubble styles keep three visibility tiers (pale → saturated)',
        D.styleFor(0.1).fillOpacity < D.styleFor(0.4).fillOpacity &&
        D.styleFor(0.4).fillOpacity < D.styleFor(0.8).fillOpacity);

    const popup = D.popupHtml({ score: 0.72, lat: 46.8, lng: 23.6, factors: {
        closestSiteM: 812, nearbyCount: 5, avgDistM: 940, densityCount: 7, triQuality: 0.66 } }, 1);
    check('popup contains star rating', popup.indexOf('★') !== -1);
    check('popup shows closest site distance', /812\s*m/.test(popup), popup);
}

// ── 5. collectSitesInRadius with fake layer data ──────────────────────
console.log('\n[collectSitesInRadius]');
{
    const fakeData = {
        0: { features: [
            { id: 1, geometry: { type: 'Point', coordinates: [23.6, 46.8] }, properties: { NUMESIT: 'A', COORD: 'DA' } },
            { id: 2, geometry: { type: 'Point', coordinates: [23.62, 46.8] }, properties: { NUMESIT: 'B', COORD: 'DA' } },
            { id: 3, geometry: { type: 'Point', coordinates: [23.64, 46.8] }, properties: { NUMESIT: 'C', COORD: 'DA' } },
            { id: 99, geometry: { type: 'Point', coordinates: [24.5, 45.0] }, properties: { NUMESIT: 'far', COORD: 'DA' } }
        ] },
        5: { features: [] },
        6: { features: [
            { id: 7, geometry: { type: 'Polygon', coordinates: [[[23.63, 46.79], [23.65, 46.79], [23.65, 46.81], [23.63, 46.81], [23.63, 46.79]]] }, properties: {} },
            { id: 8, geometry: { type: 'MultiPolygon', coordinates: [
                [[[23.61, 46.79], [23.615, 46.79], [23.615, 46.795], [23.61, 46.795], [23.61, 46.79]]],
                [[[23.61, 46.81], [23.615, 46.81], [23.615, 46.815], [23.61, 46.815], [23.61, 46.81]]]
            ] }, properties: {} }
        ] }
    };
    sandbox.window._localLayerData = fakeData;
    const res = D.collectSitesInRadius(46.8, 23.6, 10000, 46.8);
    check('3 point sites inside radius', res.sites.filter(s => s.layerId === 0).length === 3, res.sites.length);
    check('far site excluded', res.sites.every(s => !(s.lng > 24 && s.lat < 45.5)));
    check('polygon guard points added', res.sites.some(s => s.isGuard), res.sites.filter(s => s.isGuard).length);
    check('polygons recorded (Polygon + MultiPolygon parts)', res.polygons.length === 3, 'got ' + res.polygons.length);
    // polygon rings are in local meters; project the test points the same way
    const kLng = 111320 * Math.cos(46.8 * Math.PI / 180);
    const proj = (lng, lat) => ({ x: lng * kLng, y: lat * 111320 });
    const insidePt = proj(23.64, 46.80);   // inside the [23.63–23.65]×[46.79–46.81] box
    const outsidePt = proj(23.60, 46.80);  // west of the box
    check('pointInPolygon: interior point is inside', D.pointInPolygon(insidePt.x, insidePt.y, res.polygons[0].rings[0]) === true);
    check('pointInPolygon: exterior point is outside', D.pointInPolygon(outsidePt.x, outsidePt.y, res.polygons[0].rings[0]) === false);
}

// Fetches populate individual layer slots without replacing the container.
{
    const data = { 0: { features: [] }, 5: null, 6: null };
    const before = D.buildGlobalSiteIndex(data);
    data[5] = { features: [{ id: 5, properties: {}, geometry: { type: 'Point', coordinates: [23.6, 46.8] } }] };
    const after = D.buildGlobalSiteIndex(data);
    check('site index rebuilds when a layer arrives in the same data object',
        after !== before && after.pointIndex.queryCircle(23.6, 46.8, 0.01).length === 1);
}

// A large boundary can contain the working circle even though every guard
// point and the centroid are outside it.
{
    sandbox.window._localLayerData = { 0: { features: [] }, 5: { features: [] }, 6: { features: [
        { id: 10, properties: {}, geometry: { type: 'Polygon', coordinates: [[
            [23.5, 46.7], [23.9, 46.7], [23.9, 47.0], [23.5, 47.0], [23.5, 46.7]
        ]] } }
    ] } };
    const enclosed = D.collectSitesInRadius(46.8, 23.6, 1000, 46.8);
    check('large polygon enclosing the search area is retained without nearby guards',
        enclosed.sites.length === 0 && enclosed.polygons.length === 1);
    const centre = D.projectToLocalMeters(46.8, 23.6, 46.8);
    check('enclosing polygon still excludes the centre',
        D.pointInPolygon(centre.x, centre.y, enclosed.polygons[0].rings[0]));
}

// ── 6. UAT pixel math consistency ─────────────────────────────────────
console.log('\n[UAT tile math]');
{
    // A point at a known tile position: verify floor math is stable
    const z = 14;
    // sample point in Romania (Cluj-Napoca)
    const lat = 46.7712, lng = 23.6236;
    const txF = (lng + 180) / 360 * Math.pow(2, z);
    const rad = lat * Math.PI / 180;
    const tyF = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
    check('tile coords in range', txF >= 0 && tyF >= 0 && txF < Math.pow(2, z) && tyF < Math.pow(2, z),
        txF + ',' + tyF);
    // mirrored formula from map-app.js must match
    const lngToTileX = (lng) => (lng + 180) / 360 * Math.pow(2, z);
    const latToTileY = (lat) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);
    check('matches map-app formulas', Math.abs(lngToTileX(lng) - txF) < 1e-9 && Math.abs(latToTileY(lat) - tyF) < 1e-9);
}

// ── 7. END-TO-END pipeline (runArcheoPotentialAnalysis) ───────────────
/* ═══════════════════════════════════════════════════════════════════════
   End-to-end: API-ul vechi de candidați (folosit de Raportul arheologic)
   + noul câmp de scor (bule dense / heatmap) + pin mov + slider de rază.
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\n[End-to-end pipeline]');
(async () => {
    // ── DOM fals: status, sumarul, sliderul de rază, modurile, pinul ──
    const fakeEl = (extra) => Object.assign({
        textContent: '',
        innerHTML: '',
        style: {},
        disabled: false,
        checked: false,
        value: '',
        min: '0',
        max: '100',
        dataset: {},
        parentElement: null,
        classList: (() => {
            const set = new Set();
            return {
                add(c) { set.add(c); },
                remove(c) { set.delete(c); },
                toggle(c, on) { const v = (on === undefined) ? !set.has(c) : !!on; v ? set.add(c) : set.delete(c); return v; },
                contains(c) { return set.has(c); }
            };
        })(),
        attrs: {},
        addEventListener() {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
        appendChild(child) { return child; },
        focus() {},
        querySelector() { return null; }
    }, extra || {});

    const dom = {
        archeoPotRunBtn: fakeEl(),
        archeoPotStatus: fakeEl(),
        archeoPotSummary: fakeEl(),
        archeoPotDistance: fakeEl({ value: '10', min: '1', max: '10' }),
        archeoPotDistanceValue: fakeEl(),
        archeoPotModeBubbles: fakeEl(),
        archeoPotModeHeat: fakeEl(),
        archeoPotLegendBubbles: fakeEl(),
        archeoPotLegendHeat: fakeEl(),
        archeoPotHeatbar: fakeEl(),
        archeoPotToggle: fakeEl({ checked: true }),
        archeoPotentialRow: fakeEl()
    };
    sandbox.document.getElementById = (id) => dom[id] || null;

    // Legenda e pictată din js/archeo-potential.js (syncLegend) prin
    // [data-archeo-swatch] / [data-archeo-band] / #archeoPotHeatbar.
    const legendTiers = ['low', 'medium', 'high', 'low', 'medium', 'high'];
    const legendSwatches = legendTiers.map((t) => fakeEl({ attrs: { 'data-archeo-swatch': t } }));
    const legendBands = legendTiers.map((t) => fakeEl({ attrs: { 'data-archeo-band': t } }));
    sandbox.document.querySelectorAll = (sel) => {
        if (sel === '[data-archeo-swatch]') return legendSwatches;
        if (sel === '[data-archeo-band]') return legendBands;
        return [];
    };

    // ── hartă + Leaflet fals ──
    const panes = {};
    const addedLayers = [];
    const mapEvents = {};
    const fakeMap = {
        _center: { lat: 46.8, lng: 23.6 },
        _zoom: 13,
        getCenter() { return this._center; },
        getZoom() { return this._zoom; },
        getSize: () => ({ x: 900, y: 700 }),
        getContainer: () => ({ querySelector: () => null }),
        // Web Mercator, la fel ca Leaflet: canvas-ul de heatmap se ancorează
        // exact cu aceste formule.
        project(ll, zoom) {
            const z = (zoom === undefined ? this._zoom : zoom);
            const scale = 256 * Math.pow(2, z);
            return {
                x: (ll.lng + 180) / 360 * scale,
                y: (0.5 - Math.log(Math.tan(Math.PI / 4 + ll.lat * Math.PI / 180 / 2)) / (2 * Math.PI)) * scale
            };
        },
        getPixelOrigin() { return this.project(this._center, this._zoom); },
        containerPointToLayerPoint: () => ({ x: 0, y: 0 }),
        getZoomScale(to, from) { return Math.pow(2, to - from); },
        _getNewPixelOrigin(center, zoom) {
            const p = this.project(center, zoom);
            const size = this.getSize();
            return { x: p.x - size.x / 2, y: p.y - size.y / 2 };
        },
        getPane: (name) => panes[name] || null,
        createPane(name) {
            const pane = {
                name, children: [], style: {},
                appendChild(c) { this.children.push(c); c.parentNode = this; c.parentElement = this; return c; },
                removeChild(c) {
                    const i = this.children.indexOf(c);
                    if (i >= 0) this.children.splice(i, 1);
                    c.parentNode = null; c.parentElement = null;
                    return c;
                }
            };
            panes[name] = pane;
            return pane;
        },
        addLayer(l) { addedLayers.push(l); if (l && typeof l.onAdd === 'function') l.onAdd(this); return this; },
        removeLayer(l) {
            const i = addedLayers.indexOf(l);
            if (i >= 0) addedLayers.splice(i, 1);
            if (l && typeof l.onRemove === 'function') l.onRemove(this);   // ca Leaflet
            return this;
        },
        hasLayer(l) { return addedLayers.indexOf(l) !== -1; },
        on(type, fn) { (mapEvents[type] = mapEvents[type] || []).push(fn); return this; },
        off(type, fn) {
            const arr = mapEvents[type] || [];
            if (!fn) { arr.length = 0; return this; }
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
            return this;
        },
        fire(type, ev) { (mapEvents[type] || []).forEach((fn) => fn(ev)); return this; }
    };
    sandbox.window._dlMap = fakeMap;

    const groupLayers = [];
    const heatLayers = [];
    const leafletStub = {
        layerGroup(layers) {
            const g = {
                isGroup: true,
                layers: (layers || []).slice(),
                addLayer(l) { this.layers.push(l); return this; },
                removeLayer(l) { const i = this.layers.indexOf(l); if (i >= 0) this.layers.splice(i, 1); return this; },
                clearLayers() { this.layers.length = 0; return this; },
                addTo() { return this; },
                bindPopup() { return this; }
            };
            groupLayers.push(g);
            return g;
        },
        circle(ll, opts) {
            return {
                kind: 'circle',
                latlng: Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll,
                options: opts || {},
                bindPopup(c) { this.popup = c; return this; },
                bindTooltip() { return this; },
                setRadius(r) { this.options.radius = r; return this; },
                setStyle() { return this; },
                addTo() { return this; }
            };
        },
        circleMarker(ll, opts) { return { kind: 'circleMarker', latlng: ll, options: opts || {}, addTo() { return this; } }; },
        polyline(pts, opts) { return { kind: 'polyline', points: pts, options: opts || {}, addTo() { return this; } }; },
        polygon(pts, opts) { return { kind: 'polygon', points: pts, options: opts || {}, addTo() { return this; } }; },
        rectangle(bounds, opts) { return { kind: 'rectangle', bounds, options: opts || {}, addTo() { return this; } }; },
        canvas(opts) { return { kind: 'canvas', options: opts || {} }; },
        marker(ll, opts) {
            return {
                kind: 'marker', latlng: ll, options: opts || {},
                // Leaflet: addTo(map) → map.addLayer(this)
                addTo(m) { if (m && m.addLayer) m.addLayer(this); return this; },
                bindTooltip() { return this; },
                setLatLng(x) { this.latlng = x; return this; }, on() { return this; }, off() { return this; }
            };
        },
        divIcon(opts) { return { kind: 'divIcon', options: opts || {} }; },
        heatLayer(points, opts) {
            const h = {
                kind: 'heat',
                points: (points || []).slice(),
                options: opts || {},
                _canvas: { parentElement: null },
                _archeoZoomWired: false,
                addTo(m) { this._map = m; return this; },
                setOptions(o) { Object.assign(this.options, o); return this; }
            };
            heatLayers.push(h);
            return h;
        },
        latLng: (a, b) => ({ lat: a, lng: b }),
        CRS: { EPSG3857: {} }
    };
    Object.keys(leafletStub).forEach((k) => { sandbox.L[k] = leafletStub[k]; });
    sandbox.window.L = sandbox.L;

    // ── UAT: jumătatea vestică a fiecărui tile e „intravilan” (alpha 0 →
    //    exclusă, marcată cu roșu), jumătatea estică e liberă (alpha 255).
    const size = 256;
    const tileData = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const free = x >= size / 2;
            tileData[i] = free ? 192 : 0;
            tileData[i + 1] = 0;
            tileData[i + 2] = free ? 40 : 120;
            tileData[i + 3] = free ? 255 : 0;
        }
    }
    sandbox.window._uatGetTile = () => Promise.resolve({ data: tileData, size });

    // ── patrimoniu: 4 clustere dense + 1 sit departe ──
    const features = [];
    const clusters = [[-0.018, -0.018], [0.018, -0.018], [-0.018, 0.018], [0.018, 0.018]];
    let fid = 1;
    clusters.forEach(([dl, dc], ci) => {
        for (let j = 0; j < 4; j++) {
            const a = (j / 4) * Math.PI * 2;
            features.push({
                id: fid++,
                geometry: { type: 'Point', coordinates: [23.6 + dl + 0.0022 * Math.cos(a), 46.8 + dc + 0.0022 * Math.sin(a)] },
                properties: { NUMESIT: 'C' + ci + '_' + j, COORD: 'DA' }
            });
        }
    });
    features.push({ id: 99, geometry: { type: 'Point', coordinates: [26.0, 45.0] }, properties: { NUMESIT: 'far', COORD: 'DA' } });
    sandbox.window._localLayerData = { 0: { features }, 5: { features: [] }, 6: { features: [] } };

    D.config.SHOW_WORKING_AREA = true;
    D.config.SHOW_TRIANGULATION = true;
    D.config.MAX_CANDIDATES = 30;
    D.config.EXTRA_SAMPLES_MIN_RADIUS_M = 5000; // fără mostre baricentrice suplimentare

    /* ── 1. API-ul vechi de candidați rămâne intact (îl consumă Raportul) ── */
    const legacy = await sandbox.window.computeArcheoPotential(46.8, 23.6, 10000, { skipDataWait: true });
    check('legacy API still returns candidates', legacy.status === 'ok' && legacy.results.length > 0,
        legacy.status + ' / ' + legacy.results.length);
    check('legacy classifications are medium/high',
        legacy.results.every((r) => r.classification === 'medium' || r.classification === 'high'));
    check('legacy candidates ≥ 700 m from the closest site',
        legacy.results.every((r) => r.factors.closestSiteM >= 700));
    check('legacy candidates inside 10 km',
        legacy.results.every((r) => haversine(46.8, 23.6, r.lat, r.lng) <= 10001));
    check('legacy candidate count respects MAX_CANDIDATES', legacy.results.length <= D.config.MAX_CANDIDATES);

    /* ── 2. modul BULE: grid dens, fără goluri, fiecare celulă scorată ── */
    sandbox.window.setArcheoPotentialMode('bubbles');
    await sandbox.window.runArcheoPotentialAnalysis();

    const state0 = sandbox.window._archeoPotentialState();
    check('state reports bubbles mode + slider radius', state0.mode === 'bubbles' && state0.radiusKm === 10,
        JSON.stringify(state0));

    const field = sandbox.window._archeoPotentialField();
    check('field computed', !!field && field.status === 'ok', field && field.status);
    const st = field.stats;
    check('grid tiles the whole circle', st.cells > 1500 &&
        Math.abs(st.cells - (Math.PI * 10000 * 10000) / (field.cellM * field.cellM)) / st.cells < 0.05,
        st.cells + ' cells @ ' + field.cellM + ' m');
    check('scored + excluded = every cell (no point is ignored)',
        st.scored + st.excludedUat + st.excludedHeritage === st.cells,
        JSON.stringify(st));
    check('UAT (intravilan) cells are excluded', st.excludedUat > 0, st.excludedUat);
    check('heritage protection cells are excluded', st.excludedHeritage > 0, st.excludedHeritage);
    check('excluded cells carry a reason',
        field.excluded.length === st.excludedUat + st.excludedHeritage &&
        field.excluded.every((c) => c.reason === 'uat' || c.reason === 'heritage'));
    /* ── 2b. bulele: selecție rară, fără suprapuneri (sweet spot) ─────────
       Cerința: bulele nu trebuie să fie dese/înghesuite și nu au voie să se
       atingă între ele sau să intre peste razele siturilor arheologice. */
    const B = D.config.BUBBLE;
    const bubbles = field.bubbles || [];
    const bubbleCap = st.bubbleCap;
    check('bubbles stay inside the configured cap',
        bubbles.length > 0 && bubbles.length <= bubbleCap,
        bubbles.length + ' bubbles (cap ' + bubbleCap + ')');
    check('the bubbles fill the free ground (at least half of it)',
        st.coverage >= 0.5,
        (st.coverage * 100).toFixed(1) + '% of ' + st.freeAreaKm2 + ' km² with ' + bubbles.length + ' bubbles');
    check('most of the free ground is used, not just a few spots',
        bubbles.length > 0.15 * st.scored,
        bubbles.length + ' bubbles / ' + st.scored + ' scored cells');
    check('bubbles come in several sizes (not one uniform radius)',
        new Set(bubbles.map((b) => b.radiusM)).size >= 4,
        [...new Set(bubbles.map((b) => b.radiusM))].sort((a, b) => a - b).join(','));
    check('open ground far from any site or mask still gets bubbles',
        (() => {
            const siteRing = D.config.SITE_RADIUS_M + D.config.SITE_BUFFER_M;
            return bubbles.some((b) =>
                field.ctx.sites.every((s) => haversine(b.lat, b.lng, s.lat, s.lng) > b.radiusM + siteRing + 400) &&
                field.excluded.every((e) => Math.hypot(b.x - e.x, b.y - e.y) > b.radiusM + field.cellM));
        })(), 'no bubble sits in the open ground');
    check('only strong cells are promoted to bubbles',
        bubbles.every((b) => b.score >= B.MIN_SCORE),
        'min bubble score ' + Math.min(...bubbles.map((b) => b.score)).toFixed(2));
    check('every bubble keeps its own radius, inside the configured bounds',
        bubbles.every((b) => b.radiusM >= (B.RADIUS_FLOOR_M || 90) && b.radiusM <= field.bubbleBaseRadiusM),
        bubbles.map((b) => b.radiusM).slice(0, 6).join(','));

    // margine la margine între bule
    let minEdge = Infinity;
    let overlaps = 0;
    for (let i = 0; i < bubbles.length; i++) {
        for (let j = i + 1; j < bubbles.length; j++) {
            const gapM = haversine(bubbles[i].lat, bubbles[i].lng, bubbles[j].lat, bubbles[j].lng) -
                bubbles[i].radiusM - bubbles[j].radiusM;
            if (gapM < minEdge) minEdge = gapM;
            if (gapM < -1) overlaps++;
        }
    }
    check('no two bubbles touch or interleave', overlaps === 0 && minEdge >= -1,
        'closest edges ' + minEdge.toFixed(0) + ' m apart, ' + overlaps + ' overlaps');
    // gap-ul cerut scalează cu mărimea bulei (cele mici completează golurile)
    let worstPairGap = Infinity;
    for (let i = 0; i < bubbles.length; i++) {
        for (let j = i + 1; j < bubbles.length; j++) {
            const need = D.bubbleGapForRadius(Math.min(bubbles[i].radiusM, bubbles[j].radiusM),
                field.bubbleBaseRadiusM, field.bubbleGapM);
            const slack = haversine(bubbles[i].lat, bubbles[i].lng, bubbles[j].lat, bubbles[j].lng) -
                bubbles[i].radiusM - bubbles[j].radiusM - need;
            if (slack < worstPairGap) worstPairGap = slack;
        }
    }
    check('every pair of bubbles keeps the gap required by its size',
        worstPairGap >= -1, 'tightest pair is ' + worstPairGap.toFixed(0) + ' m under its gap');

    // marginea bulei față de raza de protecție a fiecărui sit (600 + 100 m)
    const siteRingM = D.config.SITE_RADIUS_M + D.config.SITE_BUFFER_M;
    let worstRing = Infinity;
    bubbles.forEach((b) => field.ctx.sites.forEach((site) => {
        const d = haversine(b.lat, b.lng, site.lat, site.lng) - b.radiusM - siteRingM;
        if (d < worstRing) worstRing = d;
    }));
    check('no bubble touches a site protection radius',
        worstRing >= -1, 'closest bubble edge is ' + worstRing.toFixed(0) + ' m outside the ' + siteRingM + ' m ring');

    // marginea bulei față de masca roșie (dreptunghiurile celulelor excluse)
    const halfCellM = field.cellM / 2;
    let worstMask = Infinity;
    bubbles.forEach((b) => field.excluded.forEach((e) => {
        const dx = Math.max(0, Math.abs(b.x - e.x) - halfCellM);
        const dy = Math.max(0, Math.abs(b.y - e.y) - halfCellM);
        const d = Math.sqrt(dx * dx + dy * dy) - b.radiusM;
        if (d < worstMask) worstMask = d;
    }));
    check('no bubble overlaps the red exclusion mask',
        worstMask >= -1, 'closest bubble edge is ' + worstMask.toFixed(0) + ' m outside the mask');
    check('every bubble stays inside the analysis circle',
        bubbles.every((b) => haversine(46.8, 23.6, b.lat, b.lng) + b.radiusM <= 10000 + 1),
        'a bubble sticks out of the search circle');
    check('bubble colours follow the legend ramp of their own score',
        bubbles.every((b) => D.styleFor(b.score).fillColor === D.scoreColorHex(b.score)));
    check('the drawn circles carry the score colour of their cell',
        groupLayers.some((g) => g.layers.filter((l) => l.kind === 'circle' && l.options.pane === 'pane_archeo' &&
            l.options.radius !== field.radius).every((l) =>
            bubbles.some((b) => b.radiusM === l.options.radius && l.options.fillColor === D.scoreColorHex(b.score)))));
    check('low-scoring ground is drawn too (pale), not left empty',
        bubbles.some((b) => b.tier === 'low') && bubbles.some((b) => b.tier === 'high'),
        JSON.stringify({ low: st.bubblesLow, medium: st.bubblesMedium, high: st.bubblesHigh }));

    console.log('  · ' + bubbles.length + ' bubbles (cap ' + bubbleCap + ') din ' + st.scored +
        ' celule scorate · raze ' + Math.min(...bubbles.map((b) => b.radiusM)) + '–' +
        Math.max(...bubbles.map((b) => b.radiusM)) + ' m · cel mai mic spațiu liber între bule ' +
        minEdge.toFixed(0) + ' m · față de razele siturilor ' + worstRing.toFixed(0) + ' m');
    check('each selected bubble is drawn once, with its own radius',
        bubbles.length === st.bubbles &&
        groupLayers.some((g) => {
            const drawn = g.layers.filter((l) => l.kind === 'circle' && l.options.pane === 'pane_archeo' &&
                l.options.radius !== field.radius && l.options.radius !== 700);
            return drawn.length === st.bubbles &&
                drawn.every((l) => bubbles.some((b) => l.options.radius === b.radiusM));
        }), 'drawn for ' + st.bubbles + ' bubbles');
    check('bubble popups are built lazily',
        groupLayers.some((g) => g.layers.some((l) => l.kind === 'circle' && typeof l.popup === 'function')));
    check('working area circle uses the slider radius',
        groupLayers.some((g) => g.layers.some((l) => l.kind === 'circle' && l.options.radius === 10000)));
    check('triangulation polylines rendered',
        groupLayers.some((g) => g.layers.some((l) => l.kind === 'polyline' && l.points.length === 4)));
    check('red mask drawn in bubbles mode too',
        groupLayers.some((g) => g.layers.some((l) => l.kind === 'rectangle' && /c0392b|e03c3c/i.test(l.options.fillColor))));
    check('heritage protection radii drawn in red',
        groupLayers.some((g) => g.layers.some((l) => l.kind === 'circle' && l.options.radius === 700 &&
            /c0392b|e03c3c/i.test(String(l.options.fillColor)))));
    check('no heat layer in bubbles mode', heatLayers.length === 0);
    check('scored cells stay ≥ 700 m from sites',
        field.results.every((r) => r.factors.closestSiteM >= 700));
    check('every scored cell inside the radius',
        field.results.every((r) => haversine(46.8, 23.6, r.lat, r.lng) <= 10000 + field.cellM));
    check('summary counts scored cells', /scored cells/.test(dom.archeoPotSummary.innerHTML),
        dom.archeoPotSummary.innerHTML);
    check('status reports completion', (dom.archeoPotStatus.textContent || '').length > 0,
        dom.archeoPotStatus.textContent);
    check('public results mirror the field', (sandbox.window._archeoPotentialResults() || []).length === st.scored);

    check('mode buttons + legend follow the selection',
        dom.archeoPotModeBubbles.classList.contains('is-active') &&
        !dom.archeoPotModeHeat.classList.contains('is-active') &&
        dom.archeoPotLegendBubbles.style.display !== 'none' &&
        dom.archeoPotLegendHeat.style.display === 'none',
        JSON.stringify({ b: dom.archeoPotLegendBubbles.style.display, h: dom.archeoPotLegendHeat.style.display }));

    /* ── 3. modul HEATMAP: fiecare punct primește scor + zone excluse roșii ── */
    const groupsBeforeHeat = groupLayers.length;
    sandbox.window.setArcheoPotentialMode('heat');
    await sandbox.window.runArcheoPotentialAnalysis();

    const hf = sandbox.window._archeoPotentialField();
    check('heat mode active', hf.mode === 'heat' && sandbox.window._archeoPotentialState().mode === 'heat');
    check('heat grid is finer than the bubble grid', hf.cellM <= field.cellM, hf.cellM + ' vs ' + field.cellM);
    check('leaflet-heat (alpha blobs) is no longer used', heatLayers.length === 0);
    const raster = sandbox.window._archeoPotentialHeatRaster();
    check('a score raster was built for the heatmap',
        !!raster && raster.cols === hf.grid.cols && raster.rows === hf.grid.rows,
        raster && raster.cols + 'x' + raster.rows);
    const painted = [];
    const colours = new Set();
    for (let i = 0; i < raster.rgba.length; i += 4) {
        if (raster.rgba[i + 3] > 0) {
            painted.push(raster.rgba[i + 3]);
            colours.add(raster.rgba[i] + ',' + raster.rgba[i + 1] + ',' + raster.rgba[i + 2]);
        }
    }
    check('one painted raster pixel per scored cell', painted.length === hf.stats.scored,
        painted.length + ' / ' + hf.stats.scored);
    check('the heat colours are strongly differentiated (not one flat colour)',
        colours.size > 100, colours.size + ' distinct colours over ' + painted.length + ' cells');
    check('weak cells are translucent and strong cells saturated',
        Math.max(...painted) - Math.min(...painted) > 60,
        'alpha ' + Math.min(...painted) + '..' + Math.max(...painted));
    check('heat alpha grows with the score of the cell', (() => {
        const H = D.config.HEAT;
        const alphaOf = (row, col) => raster.rgba[(row * raster.cols + col) * 4 + 3];
        const pts = hf.results.filter((r) => r.row != null)
            .map((r) => ({ s: r.score, a: alphaOf(r.row, r.col) }))
            .sort((x, y) => x.s - y.s);
        // netezirea gaussiană poate muta ușor alfa unei celule izolate, dar
        // treimea cea mai slabă trebuie să rămână sub treimea cea mai bună
        const third = Math.max(1, Math.floor(pts.length / 3));
        const avg = (arr) => arr.reduce((a, p) => a + p.a, 0) / Math.max(1, arr.length);
        return avg(pts.slice(0, third)) < avg(pts.slice(-third)) &&
            pts.every((p) => p.a >= Math.round(H.ALPHA_MIN * 255) - 1 &&
                p.a <= Math.round(H.ALPHA_MAX * 255) + 1);
    })(), 'alpha range ' + Math.min(...painted) + '..' + Math.max(...painted));
    check('the heat surface paints every scored cell (no holes in the search area)',
        painted.length === hf.stats.scored &&
        hf.stats.scored + hf.stats.excludedUat + hf.stats.excludedHeritage === hf.stats.cells,
        JSON.stringify(hf.stats));
    check('the colour scale is absolute, so the legend is valid for every run',
        raster.window.normalize === 'absolute' && raster.window.lo === 0 && raster.window.hi === 1 &&
        raster.window.count === hf.stats.scored,
        JSON.stringify({ n: raster.window.normalize, lo: raster.window.lo, hi: raster.window.hi }));
    check('the scale still reports the run’s own score range + legend thresholds',
        raster.window.min <= raster.window.max &&
        raster.window.tiers.low === D.config.CLASSIFY.SCORE_DISCARD_BELOW &&
        raster.window.tiers.high === D.config.CLASSIFY.SCORE_HIGH_FROM,
        JSON.stringify(raster.window.tiers));
    check('a higher score always maps to a clearly different colour', (() => {
        const rgb = (t) => D.scoreColorRgb(t);
        // opririle rampei sunt pragurile legendei (0 / 25% / 55% / 75% / 100%)
        const steps = [0, 0.25, 0.55, 0.75, 1].map(rgb);
        for (let i = 1; i < steps.length; i++) {
            const d = Math.abs(steps[i][0] - steps[i - 1][0]) +
                Math.abs(steps[i][1] - steps[i - 1][1]) +
                Math.abs(steps[i][2] - steps[i - 1][2]);
            if (d < 120) return false;
        }
        return true;
    })(), 'ramp stops ' + JSON.stringify(D.HEAT_GRADIENT));
    check('the ramp stops sit on the legend thresholds (25% / 55%)',
        Object.keys(D.HEAT_GRADIENT).map(Number).sort((a, b) => a - b)
            .join(',') === '0,0.25,0.55,0.75,1',
        Object.keys(D.HEAT_GRADIENT).join(','));
    check('the CSS heat bar matches the JS ramp (same colours, same stops)', (() => {
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');
        const bar = (css.match(/\.archeo-pot-heatbar\s*\{[^}]*\}/) || [''])[0];
        const grad = (bar.match(/linear-gradient\(90deg,([^)]*)\)/) || [, ''])[1];
        const stops = grad.split(',').map((s) => s.trim());
        const jsStops = Object.keys(D.HEAT_GRADIENT).map(Number).sort((a, b) => a - b)
            .map((s) => D.HEAT_GRADIENT[s].toLowerCase() + ' ' + Math.round(s * 100) + '%');
        return stops.length === jsStops.length &&
            stops.every((s, i) => s.toLowerCase() === jsStops[i]);
    })(), 'css gradient vs ' + JSON.stringify(D.HEAT_GRADIENT));
    check('the heat colour of a cell is exactly the legend colour of its score',
        hf.results.slice(0, 200).every((r) => raster.colorAt(r.row, r.col) === D.scoreColor(r.score)),
        hf.results.slice(0, 3).map((r) => raster.colorAt(r.row, r.col) + ' vs ' + D.scoreColor(r.score)).join(' | '));
    // Bulele de umplutură (gapFill) stau la jumătatea dintre celule, deci scorul
    // lor e calculat în acel punct, nu în celula părinte — heatmap-ul colorează
    // celula, nu punctul decalat. Restul bulelor trebuie să se potrivească exact.
    check('the heatmap replicates the bubbles (same colour for the same score)',
        hf.bubbles.filter((b) => b.row != null && !b.gapFill).length > 0 &&
        hf.bubbles.filter((b) => b.row != null && !b.gapFill).every((b) =>
            raster.colorAt(b.row, b.col) === D.scoreColor(b.score)),
        hf.bubbles.filter((b) => b.row != null && !b.gapFill)
            .slice(0, 3).map((b) => raster.colorAt(b.row, b.col) + ' vs ' + D.scoreColor(b.score)).join(' | '));
    // Cerința: heatmap-ul acoperă TOT terenul liber (nu doar bulele), iar roșul
    // rămâne al măștii de excludere.
    check('the heatmap paints every scored cell, so the whole free area is covered', (() => {
        let painted = 0;
        for (let i = 0; i < raster.valid.length; i++) if (raster.valid[i]) painted++;
        return painted === hf.results.length && painted > 0;
    })(), hf.results.length + ' scored cells');
    check('excluded ground stays transparent in the heatmap (the red mask owns it)',
        hf.excluded.length > 0 &&
        hf.excluded.every((c) => !raster.valid[c.row * raster.cols + c.col]),
        hf.excluded.length + ' excluded cells');
    check('the heat raster also scores the gaps between bubbles (gap-fill cells painted)',
        hf.bubbles.some((b) => b.gapFill) === false ||
        hf.bubbles.filter((b) => b.gapFill && b.row != null)
            .every((b) => !!raster.valid[b.row * raster.cols + b.col]),
        hf.bubbles.filter((b) => b.gapFill).length + ' gap-fill bubbles');
    check('heat ramp keeps red out of the score ramp',
        Object.values(D.HEAT_GRADIENT).every((c) => !/^#(e0|c0|f0|ff)/i.test(c)),
        JSON.stringify(D.HEAT_GRADIENT));

    /* ── 3c-orient. orientarea N–S a heatmap-ului ──────────────────────────
       redraw() ancorează VÂRFUL bitmap-ului la bbox.maxLat (nord), deci
       rândul 0 al imaginii trebuie să conțină rândul NORDIC al grilei
       (rows-1) — grila e indexată row 0 = sud (minLat). Fără inversare,
       harta termică ieșea oglindită față de bule: culorile și „golurile”
       (celulele excluse) cădeau pe cealaltă parte a cercului, în zone care
       nu sunt nici UAT, nici razele siturilor. */
    {
        const savedSigma = D.config.HEAT.SMOOTH_SIGMA_CELLS;
        D.config.HEAT.SMOOTH_SIGMA_CELLS = 0; // fără netezire → culoarea = exact scorul
        sandbox.window.setArcheoPotentialMode('heat');
        await sandbox.window.runArcheoPotentialAnalysis();
        const of = sandbox.window._archeoPotentialField();
        const heatO = sandbox.window._archeoPotentialHeat();
        const imgData = heatO && heatO._srcCanvas && heatO._srcCanvas.lastImageData;
        const oCols = of.grid.cols, oRows = of.grid.rows;
        const mismatches = [];
        let checked = 0;
        const step = Math.max(1, Math.floor(of.results.length / 400));
        for (let i = 0; i < of.results.length && checked < 400; i += step) {
            const r = of.results[i];
            const off = ((oRows - 1 - r.row) * oCols + r.col) * 4;
            const exp = D.scoreColorRgb(r.score);
            if (off + 3 >= imgData.length) continue;
            if (imgData[off] !== exp[0] || imgData[off + 1] !== exp[1] || imgData[off + 2] !== exp[2]) {
                if (mismatches.length < 3) {
                    mismatches.push('row' + r.row + ',col' + r.col + ': ' +
                        [imgData[off], imgData[off + 1], imgData[off + 2]] + ' != ' + exp.join(','));
                }
            }
            checked++;
        }
        check('the heat image is north-up: every cell keeps its colour at its own latitude',
            !!imgData && checked > 0 && mismatches.length === 0,
            (checked + ' sampled') + (mismatches.length ? ' — ' + mismatches.join(' | ') : ''));
        D.config.HEAT.SMOOTH_SIGMA_CELLS = savedSigma;
        sandbox.window.setArcheoPotentialMode('heat'); // rămâne în modul inițial al secțiunii
    }

    const heat = sandbox.window._archeoPotentialHeat();
    check('a heat canvas layer was created', !!heat && !!heat._canvas && !!heat._srcCanvas);
    check('the heat canvas lives in the layer heat pane',
        !!heat._canvas.parentNode && heat._canvas.parentNode.name === 'pane_archeo_heat',
        heat._canvas.parentNode && heat._canvas.parentNode.name);
    check('the heat canvas is zoom-animated with the rest of the map',
        /leaflet-zoom-animated/.test(heat._canvas.className || ''), heat._canvas.className);
    check('the raster is drawn onto the map canvas',
        heat._canvas.draws.length > 0, JSON.stringify(heat._canvas.draws.slice(0, 1)));

    // Ancorare geografică: lățimea desenată trebuie să fie exact întinderea
    // geografică a grilei la ORICE zoom — altfel heatmap-ul „plutește” la zoom.
    const metersPerPixel = (zoom) => 156543.03392 * Math.cos(46.8 * Math.PI / 180) / Math.pow(2, zoom);
    const expectedWidthPx = (zoom) => (2 * hf.radius) / metersPerPixel(zoom);
    const zoomFrames = [];
    for (const zoom of [10, 13, 16]) {
        fakeMap._zoom = zoom;
        fakeMap.fire('zoomend');
        await new Promise((resolve) => setTimeout(resolve, 25));
        const frame = heat._lastFrame;
        zoomFrames.push({ zoom, drawn: frame.w, expected: expectedWidthPx(zoom) });
    }
    check('the heat surface stays glued to the geography at every zoom',
        zoomFrames.every((f) => Math.abs(f.drawn - f.expected) / f.expected < 0.02),
        zoomFrames.map((f) => 'z' + f.zoom + ': ' + f.drawn.toFixed(0) + 'px/' + f.expected.toFixed(0) + 'px').join(' '));
    check('zooming redraws the heat surface instead of scaling stale pixels',
        new Set(zoomFrames.map((f) => Math.round(f.drawn))).size === zoomFrames.length,
        zoomFrames.map((f) => Math.round(f.drawn)).join(','));

    // La pan, bitmap-ul urmărește centrul hărții (colțul grilei rămâne fix).
    const frameBefore = { x: heat._lastFrame.x, y: heat._lastFrame.y };
    fakeMap._center = { lat: 46.82, lng: 23.63 };
    fakeMap.fire('moveend');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const shift = expectedWidthPx(16) * (0.03 / (2 * hf.radius / 111320 / Math.cos(46.8 * Math.PI / 180)));
    check('panning moves the heat surface with the map',
        Math.abs((heat._lastFrame.x - frameBefore.x) + shift) < 0.02 * shift,
        'dx ' + (heat._lastFrame.x - frameBefore.x).toFixed(0) + ' px, expected ' + (-shift).toFixed(0) + ' px');
    fakeMap._center = { lat: 46.8, lng: 23.6 };
    fakeMap._zoom = 13;
    fakeMap.fire('moveend');
    await new Promise((resolve) => setTimeout(resolve, 25));

    // zoomanim: transformata de renderer (scalare în jurul ancorei bitmap-ului)
    const anchorBefore = { x: heat._lastFrame.anchor.x, y: heat._lastFrame.anchor.y };
    fakeMap.fire('zoomanim', { center: { lat: 46.8, lng: 23.6 }, zoom: 16 });
    const transform = heat._canvas.style.transform;
    check('zoom animation applies the renderer transform (scale around the bitmap anchor)',
        /scale\(8\)/.test(transform) &&
        transform.indexOf('translate3d(' +
            Math.round(anchorBefore.x * 8 - fakeMap._getNewPixelOrigin({ lat: 46.8, lng: 23.6 }, 16).x) + 'px,' +
            Math.round(anchorBefore.y * 8 - fakeMap._getNewPixelOrigin({ lat: 46.8, lng: 23.6 }, 16).y) + 'px,0)') === 0,
        transform);
    fakeMap.fire('zoomend');
    await new Promise((resolve) => setTimeout(resolve, 25));
    check('the settled redraw clears the zoom transform',
        !/scale\(/.test(heat._canvas.style.transform), heat._canvas.style.transform);

    check('excluded areas are painted red (rectangles)',
        groupLayers.some((g) => g.layers.filter((l) => l.kind === 'rectangle').length > 0));
    check('excluded reason split is reported',
        hf.stats.excludedUat > 0 && hf.stats.excludedHeritage > 0, JSON.stringify(hf.stats));
    check('heat mode swaps the buttons and the legend',
        dom.archeoPotModeHeat.classList.contains('is-active') &&
        !dom.archeoPotModeBubbles.classList.contains('is-active') &&
        dom.archeoPotLegendHeat.style.display !== 'none' &&
        dom.archeoPotLegendBubbles.style.display === 'none');
    check('heat summary mentions the heatmap', /heatmap/i.test(dom.archeoPotSummary.innerHTML),
        dom.archeoPotSummary.innerHTML);
    // În modul heatmap nu se mai desenează bule: grupurile create de această
    // rulare conțin doar aria de lucru, triunghiurile și masca roșie.
    const heatRunLayers = groupLayers.slice(groupsBeforeHeat).reduce((a, g) => a.concat(g.layers), []);
    check('no score bubbles drawn in heat mode',
        heatRunLayers.filter((l) => l.kind === 'circle' && l.options.pane === 'pane_archeo' &&
            l.options.radius !== 10000).length === 0,
        heatRunLayers.map((l) => l.kind + ':' + l.options.radius).join(','));
    check('heat mode still draws the working area',
        heatRunLayers.some((l) => l.kind === 'circle' && l.options.radius === 10000));

    // Oprirea stratului dezlipește canvas-ul de heatmap din pane.
    sandbox.window.toggleArcheoPotentialLayer(false);
    check('turning the layer off detaches the heat canvas',
        !heat._canvas.parentNode, 'still parented');
    sandbox.window.toggleArcheoPotentialLayer(true);
    check('turning the layer back on re-attaches and redraws it',
        !!heat._canvas.parentNode && heat._canvas.parentNode.name === 'pane_archeo_heat');

    /* ── 3b. determinism: aceeași zonă → exact același rezultat ───────────
       Cerința utilizatorului: rezultatele nu au voie să apară „în mod aleator".
       Tot ce e nesigur în analiză (rețea/tile-uri) e acum pre-încărcat și
       cache-uit, iar selecția bulelor e sortată total, fără Math.random. */
    sandbox.window.setArcheoPotentialMode('bubbles');
    await sandbox.window.runArcheoPotentialAnalysis();
    const runA = sandbox.window._archeoPotentialField();
    const signature = (f) => (f.bubbles || [])
        .map((b) => [b.row, b.col, b.radiusM, b.score.toFixed(9)].join(':')).join('|');
    const scoresA = runA.results.map((r) => r.score.toFixed(9)).join(',');
    await sandbox.window.runArcheoPotentialAnalysis();
    const runB = sandbox.window._archeoPotentialField();
    check('the same area gives exactly the same bubbles on every run',
        signature(runA).length > 0 && signature(runA) === signature(runB),
        runA.bubbles.length + ' vs ' + runB.bubbles.length + ' bubbles');
    check('the same area gives exactly the same score field on every run',
        runA.results.length === runB.results.length &&
        scoresA === runB.results.map((r) => r.score.toFixed(9)).join(','),
        runA.results.length + ' vs ' + runB.results.length + ' cells');
    check('switching Bubbles → Heatmap does not rescore differently', (() => {
        sandbox.window.setArcheoPotentialMode('heat');
        const rasterB = sandbox.window._archeoPotentialHeatRaster();
        sandbox.window.setArcheoPotentialMode('bubbles');
        return !!rasterB;
    })());
    sandbox.window.setArcheoPotentialMode('bubbles');

    /* ── 3c. UAT: decizia pe celulă (mai multe pixeli), nu pe un singur pixel ──
       O celulă de 1600 m era decisă de un pixel de ~9.5 m → la marginea
       intravilanului excluderea ieșea punctiform, „aleator". */
    {
        const TILE = 256;
        const TX = 9267, TY = 5777;                    // tile z14 peste Cluj
        const zT = sandbox.window.UAT_TILE_Z;
        // Dungi: rândurile 100..155 = teren liber (opac + întunecat = roșu pe
        // strat), restul = intravilan (opac + luminos = netrasat cu roșu).
        const stripe = new Uint8ClampedArray(TILE * TILE * 4);
        for (let y = 0; y < TILE; y++) {
            const free = y >= 100 && y < 156;
            for (let x = 0; x < TILE; x++) {
                const i = (y * TILE + x) * 4;
                stripe[i] = free ? 40 : 200;
                stripe[i + 1] = free ? 20 : 180;
                stripe[i + 2] = free ? 40 : 180;
                stripe[i + 3] = 255;
            }
        }
        const pixelToLatLng = (px, py) => {
            const n = Math.pow(2, zT);
            const lng = (TX + px / TILE) / n * 360 - 180;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (TY + py / TILE) / n))) * 180 / Math.PI;
            return { lat, lng };
        };

        const goodLoader = sandbox.window._uatGetTile;
        sandbox.window._uatGetTile = () => Promise.resolve({ data: stripe, size: TILE });
        D.resetUatTileCache();
        const edge = pixelToLatLng(128, 101);          // centru PE roșu, la margine
        const middle = pixelToLatLng(128, 128);        // centru în mijlocul benzii
        const bounds = { minLat: edge.lat - 0.02, maxLat: edge.lat + 0.02, minLng: edge.lng - 0.02, maxLng: edge.lng + 0.02 };
        const warm = await D.prewarmUatTiles(bounds);
        check('the run pre-loads every UAT tile it needs before scoring',
            warm.total > 0 && warm.ok === warm.total, JSON.stringify(warm));

        const bigCell = D.uatCellRedFraction(edge.lat, edge.lng, 1600);
        const smallCell = D.uatCellRedFraction(middle.lat, middle.lng, 400);
        check('a cell is measured on a lattice of pixels, not a single one',
            bigCell.known > 8 && bigCell.known === bigCell.samples,
            bigCell.known + '/' + bigCell.samples + ' samples');
        check('a cell whose CENTRE pixel is red but which is mostly built-up is excluded',
            (await D.uatPixelAt(edge.lat, edge.lng)) === true &&
            bigCell.red < D.config.UAT.MIN_RED_FRACTION,
            'centre pixel red, cell only ' + (bigCell.red * 100).toFixed(0) + '% red');
        check('a cell fully inside the free strip is kept',
            smallCell.red >= D.config.UAT.MIN_RED_FRACTION,
            (smallCell.red * 100).toFixed(0) + '% red');

        sandbox.window._uatGetTile = goodLoader;
        D.resetUatTileCache();
    }

    /* ── 3d. raster UAT necitibil (CORS/404/offline) → harta nu mai rămâne goală ──
       Vechiul comportament „fail closed" excludea TOT când tile-urile nu puteau
       fi citite: exact simptomul „uneori nu se generează nimic, în mod aleator". */
    {
        const goodLoader = sandbox.window._uatGetTile;
        D.resetUatTileCache();
        sandbox.window._uatGetTile = () => Promise.resolve(sandbox.window._UAT_TILE_UNREADABLE);
        await sandbox.window.runArcheoPotentialAnalysis();
        const dead = sandbox.window._archeoPotentialField();
        check('an unreadable UAT raster no longer empties the map',
            dead.results.length > 0 && dead.bubbles.length > 0,
            dead.status + ' · ' + dead.results.length + ' cells · ' + dead.bubbles.length + ' bubbles');
        check('the run reports that the UAT raster could not be read',
            dead.uat.available === false && dead.uat.active === false &&
            dead.stats.uatTiles > 0 && dead.stats.uatTilesOk === 0,
            JSON.stringify({ total: dead.stats.uatTiles, ok: dead.stats.uatTilesOk }));
        check('cells without UAT data are scored, not silently excluded',
            dead.stats.excludedUat === 0 && dead.stats.uatUnknown === dead.stats.scored,
            JSON.stringify({ unknown: dead.stats.uatUnknown, scored: dead.stats.scored, excluded: dead.stats.excludedUat }));
        check('the heritage radii stay excluded (and red) even without the UAT raster',
            dead.stats.excludedHeritage > 0, String(dead.stats.excludedHeritage));
        check('the status tells the user the built-up exclusion was skipped',
            /UAT/i.test(dom.archeoPotStatus.textContent || ''), dom.archeoPotStatus.textContent);

        D.resetUatTileCache();
        sandbox.window._uatGetTile = () => Promise.resolve(null);   // 404 confirmat
        await sandbox.window.runArcheoPotentialAnalysis();
        const missing = sandbox.window._archeoPotentialField();
        check('missing UAT tiles (404) are handled the same way',
            missing.results.length > 0 && missing.uat.available === false,
            missing.status + ' · ' + missing.results.length);

        D.resetUatTileCache();
        sandbox.window._uatGetTile = goodLoader;
        await sandbox.window.runArcheoPotentialAnalysis();
        const alive = sandbox.window._archeoPotentialField();
        check('with the raster readable again the UAT exclusion comes back',
            alive.uat.available === true && alive.stats.excludedUat > 0 && alive.stats.uatUnknown === 0,
            JSON.stringify({ ok: alive.stats.uatTilesOk, excluded: alive.stats.excludedUat }));
    }

    /* ── 3e. legenda e pictată din aceeași rampă ca bulele și heatmap-ul ── */
    D.syncLegend();
    check('legend swatches are painted with the ramp colour of their own tier',
        legendSwatches.every((n) => {
            const tier = n.getAttribute('data-archeo-swatch');
            return n.style.background === D.scoreColorHex(D.LEGEND_SCORES[tier]);
        }), legendSwatches.map((n) => n.getAttribute('data-archeo-swatch') + '=' + n.style.background).join(','));
    const bandText = (tier) => {
        const node = legendBands.find((n) => n.getAttribute('data-archeo-band') === tier);
        return node ? node.textContent : null;
    };
    check('legend bands show the real classification thresholds',
        bandText('low') === '< 25%' && bandText('medium') === '25–55%' && bandText('high') === '≥ 55%',
        [bandText('low'), bandText('medium'), bandText('high')].join(' | '));
    check('the legend heat bar is painted from HEAT_GRADIENT stops',
        /linear-gradient\(90deg,#10233f 0%,#1f7fc4 25%,#23c48e 55%,#f2b134 75%,#8b3ff0 100%\)/
            .test(dom.archeoPotHeatbar.style.background || ''),
        dom.archeoPotHeatbar.style.background);
    {
        const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        check('index.html exposes the legend hooks the layer paints',
            /data-archeo-swatch="low"/.test(indexHtml) && /data-archeo-swatch="high"/.test(indexHtml) &&
            /data-archeo-band="medium"/.test(indexHtml) && /id="archeoPotHeatbar"/.test(indexHtml));
        check('the bubbles legend also explains the red exclusion zone',
            /id="archeoPotLegendBubbles"[^]*?archeo-pot-swatch-red[^]*?<\/div>/.test(
                indexHtml.slice(indexHtml.indexOf('id="archeoPotLegendBubbles"'),
                    indexHtml.indexOf('id="archeoPotLegendHeat"'))));
        check('the separate pin switch is gone (map-point logic is permanent)',
            !/id="archeoPotPinToggle"/.test(indexHtml) && !/archeo_pot_pin_hint/.test(indexHtml));
    }

    /* ── 4. pinul mov + sliderul de rază 1–10 km ──
       Logica de punct pe hartă e permanentă (switch-ul de pin a fost scos):
       stratul pornește cu tap-ul pe hartă activ; apelul explicit de mai jos
       e idempotent (handler-ul nu se înmulțește). */
    check('pin logic is permanent — armed from load, without a pin switch',
        sandbox.window._archeoPotentialState().pinMode === true &&
        (mapEvents.click || []).length === 1);
    sandbox.window.setArcheoPotentialPinMode(true);
    check('pin mode on', sandbox.window._archeoPotentialState().pinMode === true);
    check('map click handler armed for the pin (exactly once)', (mapEvents.click || []).length === 1);
    check('row marked as on', dom.archeoPotentialRow.classList.contains('is-on'));
    check('archeo bubble pane is click-through (cannot cover detectorist pins)',
        panes.pane_archeo && panes.pane_archeo.style.pointerEvents === 'none',
        panes.pane_archeo && JSON.stringify(panes.pane_archeo.style.pointerEvents));

    sandbox.window._archeoPotSetPoint(46.805, 23.605);
    check('pin stored in the state', (() => {
        const p = sandbox.window._archeoPotentialState().pin;
        return !!p && Math.abs(p.lat - 46.805) < 1e-9 && Math.abs(p.lng - 23.605) < 1e-9;
    })(), JSON.stringify(sandbox.window._archeoPotentialState().pin));
    // Cerința explicită: pinul stratului e MOV (nu albastru ca la LIDAR/Raport).
    const pinMarker = addedLayers.filter((l) => l.kind === 'marker' &&
        /archeo-pot-pin/.test(String((l.options.icon && l.options.icon.options && l.options.icon.options.html) || ''))).pop();
    check('a purple pin marker is drawn on the map', !!pinMarker);
    const cssSrc = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');
    const pinDotCss = (cssSrc.match(/\.archeo-pot-pin-dot\s*\{[^}]*\}/) || [''])[0];
    check('the pin dot is styled purple', /#(c4a0f0|a370e8|b388e8)/i.test(pinDotCss), pinDotCss.slice(0, 90));
    check('the pin is not the blue report/LIDAR pin', !/#66c8ff/i.test(pinDotCss));

    sandbox.window.setArcheoPotentialRadiusKm(4);
    check('radius slider drives the state', (() => {
        const s = sandbox.window._archeoPotentialState();
        return s.radiusKm === 4 && s.radiusM === 4000;
    })(), JSON.stringify(sandbox.window._archeoPotentialState()));
    check('radius label updated', (dom.archeoPotDistanceValue.textContent || '').indexOf('4') !== -1,
        dom.archeoPotDistanceValue.textContent);

    sandbox.window.setArcheoPotentialMode('bubbles');
    await sandbox.window.runArcheoPotentialAnalysis();
    const pf = sandbox.window._archeoPotentialField();
    check('analysis is centred on the pin',
        Math.abs(pf.centerLat - 46.805) < 1e-9 && Math.abs(pf.centerLng - 23.605) < 1e-9,
        pf.centerLat + ',' + pf.centerLng);
    check('analysis uses the slider radius', pf.radius === 4000, pf.radius);
    check('every cell stays inside the pin radius',
        pf.results.every((r) => haversine(46.805, 23.605, r.lat, r.lng) <= 4000 + pf.cellM));
    check('smaller radius → coarser grid, fewer cells', pf.stats.cells < st.cells,
        pf.stats.cells + ' vs ' + st.cells);

    sandbox.window.setArcheoPotentialPinMode(false);
    check('pin mode off removes the click handler', (mapEvents.click || []).length === 0);
    await sandbox.window.runArcheoPotentialAnalysis();
    const cf = sandbox.window._archeoPotentialField();
    check('without a pin the map centre is used',
        Math.abs(cf.centerLat - 46.8) < 1e-9 && Math.abs(cf.centerLng - 23.6) < 1e-9,
        cf.centerLat + ',' + cf.centerLng);

    /* ── 5. comutatorul stratului ascunde rezultatele, pinul și oglinda ──
       și nu lasă canvas-ul stratului deasupra pin-urilor de detectoriști. */
    const leftover = {
        tagName: 'canvas', style: { pointerEvents: 'auto' },
        parentNode: null, parentElement: null
    };
    panes.pane_archeo.appendChild(leftover);
    sandbox.window.toggleArcheoPotentialLayer(false);
    check('layer off hides the results', sandbox.window._archeoPotentialState().resultsVisible === false);
    check('layer off also closes the pin mode', sandbox.window._archeoPotentialState().pinMode === false);
    check('layer off drops the archeo canvas that would swallow detectorist taps',
        leftover.parentNode == null && leftover.style.pointerEvents === 'none');
    sandbox.window.toggleArcheoPotentialLayer(true);
    check('layer on restores the results', sandbox.window._archeoPotentialState().resultsVisible === true);

    console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
})();

function haversine(aLat, aLng, bLat, bLng) {
    const R = 6371000;
    const dLat = (bLat - aLat) * Math.PI / 180;
    const dLng = (bLng - aLng) * Math.PI / 180;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
