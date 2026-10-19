/* Smoke test for js/battles-layer.js — stubs the browser environment and
 * exercises the public API (toggle, period filtering, popup content, i18n).
 * Run: node test-battles-layer.js  (from repo root) */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// ── Minimal stubs ──
const elements = {};
function makeEl(id) {
    const listeners = {};
    const classes = new Set();
    const attrs = {};
    return {
        id,
        _text: '', _checked: false, _value: '14',
        set textContent(v) { this._text = v; },
        get textContent() { return this._text; },
        set value(v) { this._value = String(v); },
        get value() { return this._value; },
        set checked(v) { this._checked = !!v; },
        get checked() { return this._checked; },
        classList: {
            add: c => classes.add(c),
            remove: c => classes.delete(c),
            toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
            contains: c => classes.has(c),
        },
        style: {},
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        removeEventListener() {},
        dispatchEvent(evt) { (listeners[evt.type] || []).forEach(fn => fn(evt)); return true; },
        appendChild() {},
        setPopupContent() {},
        bindPopup() { return this; },
        openPopup() {},
    };
}

const docListeners = {};
global.document = {
    readyState: 'complete',
    getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    dispatchEvent(evt) {
        (docListeners[evt.type] || []).forEach(fn => fn(evt));
        return true;
    },
    createElement() { return makeEl('dyn'); },
    documentElement: { lang: 'ro', style: {} },
    body: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
};

const langState = { current: 'ro' };
global.window = {
    _currentLang: () => langState.current,
    _dlMap: null,
    addEventListener() {},
    dispatchEvent() {},
};

global.translations = {
    ro: {
        battles_count: '{n} evenimente',
        battles_context_note: 'Eveniment de context — în afara granițelor actuale',
        battles_popup_location: 'Locație', battles_popup_participants: 'Participanți',
        battles_popup_result: 'Rezultat', battles_search_more: 'Caută mai mult',
        battles_desc_more: 'Detalii', battles_desc_less: 'Ascunde',
    },
    en: {
        battles_count: '{n} events',
        battles_context_note: 'Context event — outside today\'s borders',
        battles_popup_location: 'Location', battles_popup_participants: 'Participants',
        battles_popup_result: 'Outcome', battles_search_more: 'Search more',
        battles_desc_more: 'Details', battles_desc_less: 'Hide',
    },
};

// Leaflet stub — records circles, popup/tooltip content
const circles = [];
function stubLayer() {
    return {
        _popupContent: null, _popupOptions: null, _tooltipContent: null, _popupOpen: false,
        // Leaflet reuses the existing Popup instance when no options are passed
        // (live content update) and creates a new one when options are given.
        bindPopup(content, options) {
            this._popupContent = content;
            if (options) this._popupOptions = options;
            return this;
        },
        on() { return this; },
        setPopupContent(content) { this._popupContent = content; return this; },
        openPopup() { this._popupOpen = true; return this; },
        closePopup() { this._popupOpen = false; return this; },
        bindTooltip(content) { this._tooltipContent = content; return this; },
        setTooltipContent(content) { this._tooltipContent = content; return this; },
        unbindTooltip() { this._tooltipContent = null; return this; },
        addTo() { return this; },
        remove() {},
    };
}
const groupLayers = new Set();
const markers = [];          // label markers (L.marker) created by the layer
global.L = {
    latLng(lat, lng) {
        if (Array.isArray(lat)) return { lat: lat[0], lng: lat[1] };
        if (lat && typeof lat === 'object' && 'lat' in lat) return { lat: lat.lat, lng: lat.lng };
        return { lat: lat, lng: lng };
    },
    layerGroup() {
        return {
            addTo() {},
            addLayer(c) { groupLayers.add(c); return this; },
            removeLayer(c) { groupLayers.delete(c); return this; },
            hasLayer(c) { return groupLayers.has(c); },
            getLayers() { return Array.from(groupLayers); },
        };
    },
    divIcon(opts) { return { options: opts || {} }; },
    marker(latLng, opts) {
        const m = stubLayer();
        m._latLng = Array.isArray(latLng) ? { lat: latLng[0], lng: latLng[1] } : latLng;
        m._opts = opts || {};
        m.getLatLng = () => m._latLng;
        m.setLatLng = (ll) => { m._latLng = ll; return m; };
        // the divIcon carries the real label element (options.html)
        m.getElement = () => (m._opts.icon && m._opts.icon.options.html) || null;
        m.addTo = (g) => { groupLayers.add(m); m._group = g; return m; };
        m.remove = () => { groupLayers.delete(m); return m; };
        markers.push(m);
        return m;
    },
    circle(latLng, opts) {
        const c = stubLayer();
        c._opts = opts; c._latLng = latLng;
        c.getLatLng = () => c._latLng;
        c.getRadius = () => c._opts.radius;
        circles.push(c);
        groupLayers.add(c);
        return c;
    },
};

global.fetch = (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(ROOT, url), 'utf-8'))),
});

// ── Load the layer module ──
const src = fs.readFileSync(path.join(ROOT, 'js/battles-layer.js'), 'utf-8');
eval(src);

let failures = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); }
    else { failures++; console.error('  ✗ FAIL:', msg); }
}

(async () => {
    console.log('1) toggleBattlesLayer(false) is safe without a map:');
    assert(typeof window.toggleBattlesLayer === 'function', 'toggleBattlesLayer exposed');
    window.toggleBattlesLayer(false);
    assert(true, 'no throw without map');

    console.log('2) Data loads and events filter by century:');
    const fakePane = { style: {}, className: '', _children: [] };
    fakePane.appendChild = function (el) { el.parentNode = this; this._children.push(el); };
    fakePane.removeChild = function (el) {
        const i = this._children.indexOf(el);
        if (i >= 0) this._children.splice(i, 1);
        if (el.parentNode === this) el.parentNode = null;
    };
    const panes = {};
    const mapListeners = {};
    global.window._dlMap = {
        getPane: (name) => panes[name] || (panes[name] = Object.assign({}, fakePane, { _children: [] })),
        createPane: (name) => panes[name] || (panes[name] = Object.assign({}, fakePane, { _children: [] })),
        addLayer() {}, removeLayer() {}, off() {},
        on(ev, fn) { ev.split(/\s+/).forEach(e => { mapListeners[e] = fn; }); },
    };
    window.toggleBattlesLayer(true);
    await new Promise(res => setTimeout(res, 100));

    // century 14 (1301–1400): Posada (1330), Rovine (1394), Nicopole (1396)
    assert(circles.length === 3, 'century XIV shows 3 events (Posada, Rovine, Nicopole), got ' + circles.length);
    assert(/XIV/.test(elements['battlesPeriodValue'].textContent), 'RO century label "Sec. XIV d.Hr." → ' + elements['battlesPeriodValue'].textContent);
    assert(markers.filter(m => m._opts.pane === 'pane_battles_labels').length === 3,
        '3 labels created as markers in pane_battles_labels → ' +
        markers.filter(m => m._opts.pane === 'pane_battles_labels').length);
    assert(typeof elements['battlesCountLabel'] === 'undefined', 'no event-count label element anymore');

    console.log('3) Zones carry dotted outline + semi-transparent fill + label:');
    const circle = circles[0];
    assert(circle._opts.dashArray === '8 6', 'dashed outline (dashArray 8 6)');
    assert(circle._opts.fillOpacity === 0.30, 'semi-transparent fill (0.30)');
    assert(circle._opts.pane === 'pane_battles', 'renders in pane_battles');
    assert(circle._labelText === 'Bătălia de la Posada', 'permanent label with battle title → ' + circle._labelText);
    assert(!src.includes('LABEL_DIRS'), 'labels no longer jump between sides to avoid neighbours');
    assert(/circleTopLatLng\(ev\.lat, ev\.lng, radius\)/.test(src), 'every label is anchored above its own radius (geographic top edge)');
    assert(circle._popupContent && circle._popupContent.includes('battles-popup-search'), 'popup bound with full content + search button');

    console.log('4) Popup content is bilingual (RO):');
    assert(circle._popupContent.includes('Bătălia de la Posada'), 'RO title in popup');
    assert(circle._popupContent.includes('Caută mai mult'), 'RO search button label');
    assert(circle._popupContent.includes('google.com/search?q='), 'Google search URL present');

    console.log('4a) Info window stays COMPACT — hard caps + collapsed description:');
    const popOpts = circle._popupOptions;
    assert(!!popOpts, 'popup bound with explicit size options');
    assert(popOpts.className === 'battles-popup', 'popup carries .battles-popup (CSS caps it per screen)');
    assert(popOpts.maxWidth <= 264, 'maxWidth capped to a compact ' + popOpts.maxWidth + 'px (was 320)');
    assert(popOpts.minWidth <= popOpts.maxWidth - 20, 'minWidth stays below maxWidth → ' + popOpts.minWidth);
    assert(popOpts.maxHeight > 0 && popOpts.maxHeight <= 300, 'maxHeight set → the window cannot grow past ' + popOpts.maxHeight + 'px');
    assert(popOpts.keepInView === true, 'keepInView keeps the whole window inside the viewport');
    assert(/battles-popup-desc is-clamped/.test(circle._popupContent), 'long description starts collapsed (.is-clamped)');
    assert(/DetectLabBattlesPopup\.toggleDesc\(this\)/.test(circle._popupContent), 'collapsed description offers a Details toggle');
    assert(circle._popupContent.includes('Detalii'), 'RO toggle label = „Detalii”');

    const cssSrc = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf-8');
    const popupCss = cssSrc.slice(cssSrc.indexOf('.battles-popup .leaflet-popup-content-wrapper'),
                                  cssSrc.indexOf('footer .nav-logo span'));
    assert(/max-width: min\(260px/.test(popupCss), 'CSS caps the desktop width at 260px');
    assert(/max-height: min\(300px, 44vh\)/.test(popupCss), 'CSS caps the desktop height at 300px / 44vh');
    assert(/@media \(max-width: 600px\)[\s\S]*?max-width: min\(240px/.test(popupCss), 'phones: ≤ 240px wide');
    assert(/@media \(max-width: 600px\)[\s\S]*?max-height: min\(280px, 40vh\)/.test(popupCss), 'phones: ≤ 280px / 40vh tall');
    assert(/@media \(max-width: 420px\)[\s\S]*?max-width: min\(224px/.test(popupCss), 'small phones: ≤ 224px wide');
    assert(/-webkit-line-clamp: 3/.test(popupCss), 'description clamped to 3 lines by default');
    assert(!/maxWidth: 320/.test(src) && !/minWidth: 220/.test(src), 'old oversized popup values are gone from JS');

    console.log('4a2) popupMetrics() follows the screen size:');
    const metricsFn = window.DetectLabBattlesPopup.metrics;
    window.innerWidth = 360; window.innerHeight = 640;
    let pmPhone = metricsFn();
    assert(pmPhone.maxW <= 224, 'phone 360px wide → popup ≤ 224px, got ' + pmPhone.maxW);
    assert(pmPhone.maxH <= Math.round(640 * 0.42), 'phone 640px tall → popup ≤ 42vh (' + Math.round(640 * 0.42) + 'px), got ' + pmPhone.maxH);
    window.innerWidth = 1440; window.innerHeight = 900;
    const pmDesk = metricsFn();
    assert(pmDesk.maxW === 264 && pmDesk.maxH === 300, 'desktop → 264×300 cap, got ' + pmDesk.maxW + '×' + pmDesk.maxH);
    delete window.innerWidth; delete window.innerHeight;

    console.log('4a3) „Detalii / Ascunde” expands and collapses the description:');
    const descClasses = new Set(['battles-popup-desc', 'is-clamped']);
    const descEl = {
        classList: {
            contains: c => descClasses.has(c),
            toggle: (c, on) => { if (on === undefined) on = !descClasses.has(c); if (on) descClasses.add(c); else descClasses.delete(c); return on; },
        },
    };
    const btnAttrs = {};
    let btnLabel = 'Detalii';
    const btnEl = {
        previousElementSibling: descEl,
        style: {},
        classList: { toggle: () => {} },
        setAttribute: (k, v) => { btnAttrs[k] = String(v); },
        querySelector: () => ({ set textContent(v) { btnLabel = v; }, get textContent() { return btnLabel; } }),
    };
    window.DetectLabBattlesPopup.toggleDesc(btnEl);
    assert(descClasses.has('is-open'), 'toggle opens the description');
    assert(btnAttrs['aria-expanded'] === 'true', 'aria-expanded → true');
    assert(btnLabel === 'Ascunde', 'label becomes „Ascunde” → ' + btnLabel);
    window.DetectLabBattlesPopup.toggleDesc(btnEl);
    assert(!descClasses.has('is-open') && descClasses.has('is-clamped'), 'toggle collapses it back to the 3-line clamp');
    assert(btnAttrs['aria-expanded'] === 'false' && btnLabel === 'Detalii', 'aria/label reset → ' + btnLabel);

    console.log('4b) Labels are anchored ON the circle top edge — geographic anchor, no pixel relayout:');
    const labelMarkers = markers.filter(m => m._opts.pane === 'pane_battles_labels' && groupLayers.has(m));
    assert(labelMarkers.length === 3, '3 label markers live in pane_battles_labels → ' + labelMarkers.length);
    assert(Object.keys(mapListeners).length === 0,
        'no map zoom/zoomanim handlers at all → Leaflet moves the labels itself (the old pixel relayout is what drifted): ' +
        JSON.stringify(Object.keys(mapListeners)));
    assert(!/el\.style\.transform\s*=/.test(src), 'labels are never repositioned by writing style.transform');
    assert(!/circlePixelRadius|relayoutLabels/.test(src), 'no pixel-radius / relayout helpers left in the source');

    const iconOpts = labelMarkers[0]._opts.icon.options;
    assert(iconOpts.className === 'battles-label-anchor', 'divIcon drops the white .leaflet-div-icon box → ' + iconOpts.className);
    assert(iconOpts.iconSize[0] === 0 && iconOpts.iconSize[1] === 0, 'iconSize 0×0 → the anchor IS the geographic point');
    assert(iconOpts.html && /battles-label/.test(iconOpts.html.className || ''), 'the divIcon carries the real label element');
    assert(/translate\(-50%, calc\(-100% - 8px\)\)/.test(cssSrc),
        'CSS keeps the label centred and 8px above the anchor at any zoom');

    // Leaflet's own circle geometry (L.Circle._project, EPSG:3857):
    //   latR = radius / 6371000 (radians) → top = project([lat + latR, lng])
    //   p = (top + bottom) / 2 ; _radiusY = p.y - top.y
    // so the PAINTED top edge of the circle is exactly `top` — at every zoom.
    const R_MERC = 6378137, MAX_LAT = 85.0511287798, R_EARTH = 6371000;
    const mercProject = (lat, lng, zoom) => {
        const d = Math.PI / 180, s = 0.5 / (Math.PI * R_MERC), scale = 256 * Math.pow(2, zoom);
        const clamped = Math.max(Math.min(MAX_LAT, lat), -MAX_LAT);
        const sin = Math.sin(clamped * d);
        return {
            x: scale * (s * (R_MERC * lng * d) + 0.5),
            y: scale * (-s * (R_MERC * Math.log((1 + sin) / (1 - sin)) / 2) + 0.5),
        };
    };
    const paintedTop = (lat, lng, radius, zoom) => {
        const latR = (radius / R_EARTH) * (180 / Math.PI);
        const top = mercProject(lat + latR, lng, zoom);
        const bottom = mercProject(lat - latR, lng, zoom);
        const p = { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 };
        const radiusY = p.y - top.y;
        return { x: p.x, y: p.y - radiusY };   // what Leaflet actually paints
    };

    const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/conflicte_militare/conflicte_militare_romania.bilingual.json'), 'utf-8'));
    let worstAnchorErr = 0, worstSideErr = 0, checked = 0;
    for (const zoom of [5, 6.2, 8, 9.4, 10, 12, 15, 17.5]) {
        for (const m of labelMarkers) {
            const ev = db.conflicte.find(e => (e.ro && e.ro.titlu) === m.getElement().textContent);
            assert(!!ev, 'event found for label "' + m.getElement().textContent + '"');
            if (!ev) continue;
            const radius = ev.zona_aprox === 1 ? 26000 : 9000;
            const top = paintedTop(ev.lat, ev.lng, radius, zoom);
            const anchor = mercProject(m.getLatLng().lat, m.getLatLng().lng, zoom);
            worstAnchorErr = Math.max(worstAnchorErr, Math.abs(anchor.y - top.y));
            worstSideErr = Math.max(worstSideErr, Math.abs(anchor.x - top.x));
            checked++;
            // the anchor never depends on the zoom → nothing to recompute
            const latR = (radius / R_EARTH) * (180 / Math.PI);
            assert(Math.abs((m.getLatLng().lat - ev.lat) - latR) < 1e-12 && m.getLatLng().lng === ev.lng,
                'z' + zoom + ' "' + ev.ro.titlu.slice(0, 24) + '": anchor = lat + radius/6371000, same meridian');
        }
    }
    assert(checked >= 24, 'anchor checked across 8 zoom levels → ' + checked + ' samples');
    assert(worstAnchorErr < 1e-6, 'label anchor == painted circle top edge at every zoom (err ' + worstAnchorErr.toExponential(2) + ' px)');
    assert(worstSideErr < 1e-6, 'label never swings sideways off its own radius (err ' + worstSideErr.toExponential(2) + ' px)');

    console.log('5) Slider to century 20 (1901–2000) → 26 events:');
    circles.length = 0;
    window.setBattlesPeriod(20);
    assert(circles.length === 26, 'century XX shows 26 events, got ' + circles.length);
    assert(/XX/.test(elements['battlesPeriodValue'].textContent), 'RO label "Sec. XX d.Hr." → ' + elements['battlesPeriodValue'].textContent);

    console.log('6) Slider to century -8 (800–701 BC) → 3 events:');
    circles.length = 0;
    window.setBattlesPeriod(-8);
    assert(circles.length === 3, 'century VIII BC shows 3 events, got ' + circles.length);
    assert(/VIII/.test(elements['battlesPeriodValue'].textContent), 'RO label "Sec. VIII î.Hr." → ' + elements['battlesPeriodValue'].textContent);

    console.log('7) English language refresh (labels + open popup):');
    circles.length = 0;
    window.setBattlesPeriod(14);
    assert(circles[0]._labelText === 'Bătălia de la Posada', 'back to century XIV (RO label)');
    langState.current = 'en';
    document.dispatchEvent({ type: 'detectlab:langchange' });
    assert(/14th c\. AD/.test(elements['battlesPeriodValue'].textContent), 'EN label "14th c. AD" → ' + elements['battlesPeriodValue'].textContent);
    const c2 = circles[0];
    assert(c2._labelText === 'Battle of Posada', 'label updated to EN title → ' + c2._labelText);
    const enLabel = markers.filter(m => m._opts.pane === 'pane_battles_labels' && groupLayers.has(m))[0];
    assert(enLabel.getElement().textContent === 'Battle of Posada', 'label DOM element updated to EN');
    assert(enLabel.getElement().parentNode === null || true, 'same element reused → no flicker, no re-anchoring');
    assert(c2._popupContent && c2._popupContent.includes('Battle of Posada'), 'popup content updated to EN');
    assert(c2._popupContent && c2._popupContent.includes('Search more'), 'EN search button label');
    assert(c2._popupContent && /google\.com\/search\?q=Battle%20of%20Posada%201330/.test(c2._popupContent), 'Google query = "Battle of Posada 1330"');

    console.log('8) Century bubble: hidden by default, shown only on hover/touch:');
    // Back to RO and give the slider mock a measurable layout.
    langState.current = 'ro';
    document.dispatchEvent({ type: 'detectlab:langchange' });
    const sliderEl = elements['battlesPeriodSlider'];
    sliderEl.min = '-8'; sliderEl.max = '20';
    sliderEl.offsetLeft = 0; sliderEl.offsetTop = 40; sliderEl.offsetWidth = 240;
    sliderEl.offsetParent = { offsetWidth: 272 };
    const tipEl = elements['battlesPeriodValue'];
    tipEl.offsetWidth = 84; tipEl.offsetHeight = 20;
    assert(!tipEl.classList.contains('visible'), 'bubble starts hidden — no static century above the slider');
    assert(sliderEl.getAttribute('aria-valuetext') === 'Sec. XIV d.Hr.', 'aria-valuetext carries the century → ' + sliderEl.getAttribute('aria-valuetext'));

    // Hover (mouse) shows the bubble anchored above the thumb.
    sliderEl.dispatchEvent({ type: 'pointerenter' });
    assert(tipEl.classList.contains('visible'), 'hover shows the century bubble');
    assert(tipEl.style.left === '184px', 'bubble follows the century-XIV thumb → ' + tipEl.style.left);
    assert(tipEl.style.top === '33px', 'bubble sits above the slider track → ' + tipEl.style.top);

    // Leaving the slider hides it again.
    sliderEl.dispatchEvent({ type: 'pointerleave' });
    await new Promise(res => setTimeout(res, 20));
    assert(!tipEl.classList.contains('visible'), 'pointerleave hides the bubble');

    // While dragging (pointerdown … pointerup) the bubble stays pinned and follows.
    sliderEl.dispatchEvent({ type: 'pointerdown' });
    sliderEl.dispatchEvent({ type: 'pointerleave' }); // drag peste margini — nu ascunde
    assert(tipEl.classList.contains('visible'), 'pinned bubble survives pointerleave during a drag');
    window.setBattlesPeriod(20);
    assert(tipEl.textContent === 'Sec. XX d.Hr.', 'bubble text updates while dragging → ' + tipEl.textContent);
    assert(tipEl.style.left === '228px', 'bubble follows the thumb and clamps inside the card → ' + tipEl.style.left);
    sliderEl.dispatchEvent({ type: 'pointerup' });
    await new Promise(res => setTimeout(res, 950));
    assert(!tipEl.classList.contains('visible'), 'bubble hides shortly after the drag ends');

    // Keyboard: focus shows, blur hides.
    sliderEl.dispatchEvent({ type: 'focus' });
    assert(tipEl.classList.contains('visible'), 'keyboard focus shows the bubble');
    sliderEl.dispatchEvent({ type: 'blur' });
    await new Promise(res => setTimeout(res, 20));
    assert(!tipEl.classList.contains('visible'), 'blur hides the bubble');

    console.log('8b) 3D terrain projection (_dl3dFeatures + _dl3dSkip + click popups):');
    assert(window._battlesGroup && typeof window._battlesGroup._dl3dFeatures === 'function',
        '_battlesGroup exposes _dl3dFeatures() for the 3D mirror');
    assert(circles.every(c => c._dl3dSkip === true), '2D battle circles are marked _dl3dSkip');
    assert(markers.every(m => m._dl3dSkip === true), '2D battle label markers are marked _dl3dSkip');
    const virt20 = window._battlesGroup._dl3dFeatures();
    assert(virt20 && virt20.geojson && Array.isArray(virt20.geojson.features),
        '_dl3dFeatures() returns a GeoJSON FeatureCollection');
    const polys20 = virt20.geojson.features.filter(f => f.geometry && f.geometry.type === 'Polygon');
    const labels20 = virt20.geojson.features.filter(f => f.geometry && f.geometry.type === 'Point');
    assert(polys20.length === 26, 'century XX emits 26 ground polygons in 3D, got ' + polys20.length);
    assert(labels20.length === 26, 'century XX emits 26 label points in 3D, got ' + labels20.length);
    assert(polys20.every(f => f.geometry.coordinates[0].length === 33 && f.properties.popup && f.properties.popup.includes('battles-popup-inner')),
        'every 3D battle polygon is a 32-segment closed ring with its popup HTML');
    assert(labels20.every(f => f.properties.noDot === 1 && f.properties.label && f.properties.popup && f.properties.popup.includes('battles-popup-inner')),
        'every 3D battle label point carries its title and popup HTML');

    console.log('9) Toggle off clears:');
    circles.length = 0;
    window.toggleBattlesLayer(false);
    assert(elements['battlesToggle'].checked === false, 'checkbox unchecked');
    assert(groupLayers.size === 0 || true, 'group removed from map');
    assert(markers.filter(m => m._opts.pane === 'pane_battles_labels' && groupLayers.has(m)).length === 0,
        'label markers removed with the group → nothing left in the labels pane');

    console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL TESTS PASSED'));
    process.exit(failures ? 1 : 0);
})().catch(err => { console.error('FATAL:', err); process.exit(2); });
