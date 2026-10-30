/*
 * test-live-location-zoom.js
 * ──────────────────────────────────────────────────────────────────────────
 * Exercises the real live-location control (the IIFE in js/map-app.js) with
 * successive GPS fixes, against a minimal fake Leaflet.
 *
 * Two contracts are pinned here:
 *
 *  1. CENTRING — only the FIRST fix of a tracking session may move the map, at
 *     max(currentZoom, 14). Later fixes never override a zoom/pan the user
 *     chose. A rejected fix does not consume that one-shot.
 *
 *  2. NO PER-FIX LAYER CHURN — the location pin and its accuracy circle are
 *     created ONCE per session and updated in place (setLatLng / setRadius).
 *     The previous implementation removed and re-created both layers on every
 *     GPS fix. Android delivers a fix about once a second, so with the 1960s
 *     satellite layer on the overlay pane was rebuilt a thousand times per
 *     quarter of an hour: the map visibly twitched, and every rebuild
 *     invalidated the composite of the whole CORONA stack above the basemap
 *     (the reported "whole map turns green / glitches between zoom levels").
 *
 * Run:  node test-live-location-zoom.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('js/map-app.js', 'utf8');
const start = src.indexOf('            (function () {', src.indexOf('// ── CUSTOM LIVE LOCATION BUTTON ──'));
const end = src.indexOf('            })();', start) + '            })();'.length;
assert(start >= 0 && end > start, 'the live-location block must be locatable');

let checks = 0;
function ok(name, cond, detail) {
    checks++;
    if (!cond) {
        console.error('  \u2717 ' + name + (detail ? ' — ' + detail : ''));
        throw new Error('check failed: ' + name);
    }
    console.log('  \u2713 ' + name);
}

/* ── fake Leaflet that records every layer operation ─────────────────────── */
let success, error, nextId = 0, zoom = 8;
const flights = [];
const added = [];       // every layer that was addTo(map)'d
const removed = [];     // every layer that was map.removeLayer'd
const presence = [];
const cleared = [];

function fakeLayer(kind) {
    const layer = {
        kind,
        latlng: null,
        radius: null,
        setLatLngCalled: 0,
        setRadiusCalled: 0,
        popupBound: 0,
        bindPopup() { this.popupBound++; return this; },
        addTo() { added.push(this); layer.latlng = layer.latlng || layer.initial || null; return this; },
        setLatLng(ll) { this.latlng = Array.from(ll); this.setLatLngCalled++; return this; },
        setRadius(r) { this.radius = r; this.setRadiusCalled++; return this; }
    };
    return layer;
}

const map = {
    getZoom: () => zoom,
    _animatingZoom: false,
    flyTo(position, level) { flights.push({ position: Array.from(position), level }); zoom = level; },
    removeLayer(layer) { removed.push(layer); },
    once(events, fn) { this._once = this._once || []; this._once.push({ events, fn }); },
    fireOnce(event) {
        const list = (this._once || []).slice();
        this._once = [];
        list.forEach(entry => {
            if (entry.events.split(' ').indexOf(event) !== -1) entry.fn();
        });
    }
};

const window = {};
let rafQueue = [];
const context = {
    window,
    map,
    navigator: {
        geolocation: {
            watchPosition(onSuccess, onError) { success = onSuccess; error = onError; return ++nextId; },
            clearWatch(id) { cleared.push(id); }
        }
    },
    document: {
        createElement: () => ({ style: {} }),
        documentElement: { classList: { contains: () => false } },
        getElementById: () => null,
        querySelector: () => null,
        body: null
    },
    setTimeout(fn) { fn(); },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    L: {
        divIcon: () => ({}),
        marker: (latlng) => {
            const m = fakeLayer('marker');
            m.latlng = latlng ? Array.from(latlng) : null;
            return m;
        },
        circle: (latlng, opts) => {
            const c = fakeLayer('circle');
            c.latlng = latlng ? Array.from(latlng) : null;
            c.radius = (opts && typeof opts.radius === 'number') ? opts.radius : null;
            return c;
        }
    },
    _detLat: null, _detLng: null, _det: { active: false },
    _presenceVisible: () => true,
    publishDetectorPresence: (...args) => presence.push(args),
    console, alert() {}
};
context.window.requestAnimationFrame = context.requestAnimationFrame;
vm.runInNewContext(src.slice(start, end), context);

function flushRaf() {
    const list = rafQueue;
    rafQueue = [];
    list.forEach(fn => fn());
}
const fix = (lat, lng, accuracy) => {
    success({ coords: { latitude: lat, longitude: lng, accuracy: accuracy === undefined ? 10 : accuracy } });
    flushRaf();
    // A centring flyTo ends with moveend — the pin waits for it.
    map.fireOnce('moveend');
    flushRaf();
};
const markers = () => added.filter(l => l.kind === 'marker');
const circles = () => added.filter(l => l.kind === 'circle');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Centring: once per session, close zoom preserved
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] The map is centred once per session');
window._startLiveLocation();
fix(51, 0);
ok('the first fix centres the map', flights.length === 1, String(flights.length));
ok('…at least z14', flights[0].level === 14, String(flights[0].level));

zoom = 9;
fix(52, 1);
ok('later fixes never recentre', flights.length === 1, String(flights.length));
ok('…and never change the zoom', zoom === 9, String(zoom));
ok('…but the pin follows the user', markers()[0].latlng.join(',') === '52,1',
    JSON.stringify(markers()[0].latlng));

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The pin and circle are REUSED, never rebuilt
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] One marker + one circle per session (no per-fix churn)');
ok('exactly one marker was ever created', markers().length === 1);
ok('exactly one accuracy circle was ever created', circles().length === 1);
ok('no layer was removed while tracking', removed.length === 0, String(removed.length));
ok('the marker was moved with setLatLng', markers()[0].setLatLngCalled >= 1);
ok('the popup was bound once', markers()[0].popupBound === 1, String(markers()[0].popupBound));

const circle = circles()[0];
const radiusAfterTwo = circle.radius;
ok('the accuracy circle sits at the current fix', !!circle.latlng);
ok('a 10 m accuracy circle is drawn at 10 m', radiusAfterTwo === 10, String(radiusAfterTwo));

// A wobble smaller than the redraw threshold must not re-project the circle.
const radiusCallsBefore = circle.setRadiusCalled;
fix(52.00001, 1.00001, 12);
ok('a small accuracy wobble does not rewrite the radius',
    circle.setRadiusCalled === radiusCallsBefore,
    String(circle.setRadiusCalled - radiusCallsBefore));

// A real change does update it.
fix(52.00002, 1.00002, 40);
ok('a real accuracy change rewrites the radius', circle.radius === 40, String(circle.radius));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. Implausible fixes are dropped (Android "no fix yet" records)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] (0,0) / NaN records are ignored');
const presenceBefore = presence.length;
const latBefore = markers()[0].latlng.slice();
fix(0, 0, 0);
ok('a (0,0) record does not move the pin',
    markers()[0].latlng.join(',') === latBefore.join(','), JSON.stringify(markers()[0].latlng));
ok('a (0,0) record is never published as presence', presence.length === presenceBefore);
fix(NaN, 5, 10);
ok('a NaN latitude does not move the pin',
    markers()[0].latlng.join(',') === latBefore.join(','));
fix(0.5, 0.5, 99999);
ok('a 100 km accuracy is not drawn as a huge circle',
    circle.radius <= 3000, String(circle.radius));

/* ══════════════════════════════════════════════════════════════════════════
 * 4. A new session centres again; stopping clears everything
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] Sessions');
window._stopLiveLocation();
ok('stopping clears watch', cleared.length === 1, JSON.stringify(cleared));
ok('stopping removes the marker', removed.filter(l => l.kind === 'marker').length === 1);
ok('stopping removes the circle', removed.filter(l => l.kind === 'circle').length === 1);

window._startLiveLocation();
fix(53, 2);
ok('a new session centres once again', flights.length === 2, String(flights.length));
ok('…at z14', flights[1].level === 14, String(flights[1].level));

zoom = 17;
window._stopLiveLocation();
window._startLiveLocation();
fix(54, 3);
ok('initial centring preserves a closer zoom', flights[2].level === 17, String(flights[2].level));

/* ══════════════════════════════════════════════════════════════════════════
 * 5. No overlay writes during a zoom animation
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[5] A fix that lands mid-zoom is applied once the zoom ends');
const before = markers()[markers().length - 1];
const movesBefore = before.setLatLngCalled;
map._animatingZoom = true;
fix(55, 4);
ok('the pin is not repainted during the animation',
    before.setLatLngCalled === movesBefore, String(before.setLatLngCalled - movesBefore));
map._animatingZoom = false;
map.fireOnce('zoomend');
flushRaf();
ok('…and is painted when the map settles',
    before.setLatLngCalled === movesBefore + 1, String(before.setLatLngCalled - movesBefore));

/* ══════════════════════════════════════════════════════════════════════════
 * 6. The GPS error path still fails fast
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Errors');
error({ message: 'denied' });
ok('a geo error stops tracking', window._isLiveLocationActive() === false);

console.log('\n' + checks + '/' + checks + ' checks passed');
console.log('Live location zoom/pin regression tests passed');
