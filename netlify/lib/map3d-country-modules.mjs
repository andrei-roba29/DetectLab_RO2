/*
 * netlify/lib/map3d-country-modules.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Loads the country-LiDAR browser modules (js/ahn-layer.js, js/ign-mdt-layer.js,
 * …) inside a tiny sandbox so the tile proxy can ask them for the URL of ONE
 * tile.
 *
 * WHY
 *   Five of the nine country layers build their URL from the tile bbox (WMS
 *   GetMap / ArcGIS exportImage) instead of z/x/y, so no `{z}/{x}/{y}` template
 *   exists for them — the modules are called per tile
 *   (see registry.tileUrlAt and js/map3d-terrain.js `dl3d://`). In the browser
 *   that is trivial; on the server the module needs a Leaflet-shaped `L`, a
 *   minimal `document` and a `window` to attach itself to. That is all this
 *   file provides — no DOM, no network: everything happens inside `node:vm`.
 *
 * Nothing is duplicated: the modules stay the single owner of their URLs, and
 * a module that fails to evaluate simply leaves its layer reported as
 * "module not loaded" (the proxy answers with the labelled blank tile).
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.resolve(HERE, '../../js');

/** The modules whose URL builders the 3D view may need per tile. */
export const COUNTRY_MODULES = [
    'js/ahn-layer.js',
    'js/hoydedata-layer.js',
    'js/geoportal-nmt-layer.js',
    'js/ign-mdt-layer.js',
    'js/swisstopo-relief-layer.js',
    'js/ea-lidar-wmts-layer.js',
    'js/dataforsyningen-dhm-layer.js',
    'js/lantmateriet-hojdmodell-layer.js'
];

/* ── the smallest Leaflet that lets a layer module define itself ──────────── */
function leafletStub() {
    function Layer() {}
    Layer.extend = function () { return Layer; };
    Layer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
    Layer.prototype.onAdd = function () {};
    Layer.prototype.onRemove = function () {};
    const CRS3857 = {
        project: function (latlng) {
            const R = 6378137;
            const lng = latlng.lng || 0, lat = latlng.lat || 0;
            return {
                x: R * lng * Math.PI / 180,
                y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2))
            };
        },
        unproject: function () { return { lat: 0, lng: 0 }; }
    };
    return {
        GridLayer: Layer,
        TileLayer: Layer,
        ImageOverlay: Layer,
        Layer: Layer,
        CRS: { EPSG3857: CRS3857, EPSG4326: { project: (ll) => ll, unproject: () => ({ lat: 0, lng: 0 }) } },
        extend: function (base, props) { return Object.assign({}, base || {}, props || {}); },
        setOptions: function (target, options) { Object.assign(target || {}, options || {}); return target; },
        bind: function (fn, ctx) { return fn.bind(ctx); },
        latLngBounds: function (bounds) {
            const box = bounds || [[0, 0], [0, 0]];
            return {
                getSouthWest: () => ({ lat: box[0][0], lng: box[0][1] }),
                getNorthEast: () => ({ lat: box[1][0], lng: box[1][1] }),
                isValid: () => true
            };
        },
        DomUtil: {
            create: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
            addClass() {}, removeClass() {}, setTransform() {}
        },
        Util: {
            setOptions: function (target, options) { Object.assign(target || {}, options || {}); return target; },
            template: (str) => str,
            isArray: Array.isArray
        },
        point: (x, y) => ({ x, y }),
        control: () => ({ addTo() {} }),
        Control: { extend: () => Layer },
        Evented: { extend: () => Layer }
    };
}

/* ── minimal document for the few lookups the modules do ─────────────────── */
function documentStub() {
    const noop = () => {};
    return {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
            setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop
        }),
        addEventListener: noop,
        removeEventListener: noop,
        documentElement: { style: {}, lang: 'ro' },
        head: { appendChild: noop },
        body: { appendChild: noop, classList: { add: noop, remove: noop } }
    };
}

let sandbox = null;                 /* { window, moduleName → module } */
let loaded = false;

/**
 * Evaluate every country module once and return the object they attached
 * themselves to (`window` inside the sandbox): `{ AhnLidar: {…}, … }`.
 * Never throws — a module that cannot be evaluated is simply absent, and the
 * layers that depend on it stay visible as "module not loaded".
 */
export function countryModuleScope() {
    if (loaded) return sandbox;
    loaded = true;
    const win = {};
    const context = {
        window: win,
        document: documentStub(),
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch: () => Promise.reject(new Error('offline')),
        URL,
        Image: function ImageStub() {},
        L: leafletStub()
    };
    context.self = context;
    context.globalThis = context;
    win.document = context.document;
    win.L = context.L;
    win.location = { href: 'https://detectlab-4i1.pages.dev/', protocol: 'https:', hostname: 'detectlab-4i1.pages.dev' };
    win.navigator = { onLine: true, userAgent: 'netlify-function' };
    try {
        vm.createContext(context);
    } catch (e) {
        sandbox = win;
        return sandbox;
    }
    for (const file of COUNTRY_MODULES) {
        const full = path.resolve(JS_DIR, '..', file);
        try {
            const source = fs.readFileSync(full, 'utf8');
            vm.runInContext(source, context, { filename: file, timeout: 2000 });
        } catch (e) {
            console.warn('[map3d-tile] country module not evaluated: ' + file + ' — ' + e.message);
        }
    }
    sandbox = win;
    return sandbox;
}
