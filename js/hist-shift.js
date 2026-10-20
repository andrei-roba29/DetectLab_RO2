/* ============================================================================
 * hist-shift.js — mutarea hărților istorice peste harta de bază
 * ----------------------------------------------------------------------------
 * TOATE hărțile istorice (gratuite + premium) sunt layere raster Leaflet în
 * pane-uri proprii, construite dintr-o singură sursă: registrul
 * (js/layer-registry.js, grupurile `hist-free` / `hist-premium` / `hist-sat`,
 * inclusiv catalogul CENAGIS). Modulul de față NU reimplementează niciun
 * strat: descoperă layerele istorice ACTIVE pe harta live (prin registrul
 * potrivit pe URL/LAYERS + pane-urile speciale Josephine / iosfree) și le
 * mută prin transformare CSS pe pane-ul lor — deci funcționează identic
 * pentru WMS, WMTS, XYZ, ArcGIS și image-overlay, gratuit sau premium.
 *
 * GESTUL (cerința utilizatorului):
 *   1. ții apăsat (~550 ms) oriunde pe hartă → apare un panou cu un switch;
 *   2. switch ON → „modul mutare": drag-ul pe ecran mișcă HARTA ISTORICĂ
 *      (harta de bază e blocată), cu o limită maximă de deplasare
 *      (MAX_OFFSET_M, ca să nu poți „pierde" harta istorică);
 *   3. ții apăsat din nou (sau oprești switch-ul) → LOCK: poziția actuală
 *      rămâne, salvată în localStorage, iar drag-ul mișcă din nou baza.
 *
 * Deplasarea e păstrată în metri proiectați (EPSG:3857), nu în pixeli, ca să
 * rămână aceeași poziție geografică la orice zoom.
 *
 * Expune window.DetectLabHistShift:
 *   .attach(map) .activeTargets() .setEnabled(on) .isEnabled()
 *   .getOffset(pane) .setOffset(pane, dxM, dyM) .reset(pane) .showPanel()
 * ========================================================================== */
(function (root, document) {
    'use strict';
    if (!root || !document) return;

    var LONG_PRESS_MS = 550;
    var MOVE_TOLERANCE_PX = 10;
    var MAX_OFFSET_M = 300;               /* „nu exagerat de tare" */
    var STORAGE_KEY = 'dlHistShift.v1';
    var HIST_GROUPS = { 'hist-free': true, 'hist-premium': true, 'hist-sat': true };
    /* Layers that are historical but whose live URL is not the registry URL
     * (Josephine switches Cloudflare ⇄ Supabase tiles; the free Josephine
     * sheet is an image overlay, not a tile service at all). */
    var EXTRA_PANES = { 'pane_josephine': true, 'iosfreePane': true };
    var M_PER_PX_Z0 = 156543.03392;       /* EPSG:3857 metres per pixel at z0 */

    var COPY = {
        ro: {
            title: 'Mută harta istorică',
            move: 'Mod mutare',
            locked: 'Blocat pe poziție',
            hintOn: 'Trage pe hartă ca să aliniezi harta istorică. Ține apăsat din nou ca să o blochezi.',
            hintOff: 'Ține apăsat pe hartă ca să reiei mutarea.',
            noLayer: 'Niciun strat istoric activ. Pornește o hartă istorică (gratuită sau premium) din panoul de straturi.',
            reset: 'Resetează poziția',
            offset: 'Deplasare'
        },
        en: {
            title: 'Move the historical map',
            move: 'Move mode',
            locked: 'Locked in place',
            hintOn: 'Drag on the map to align the historical map. Long-press again to lock it.',
            hintOff: 'Long-press the map to move it again.',
            noLayer: 'No historical layer is on. Switch on a historical map (free or premium) in the layers panel.',
            reset: 'Reset position',
            offset: 'Offset'
        }
    };
    function lang() {
        try {
            if (root._currentLang) return /^en/i.test(String(root._currentLang)) || root._currentLang === 'en' ? 'en' : 'ro';
            return /^en/i.test(document.documentElement.lang || '') ? 'en' : 'ro';
        } catch (e) { return 'ro'; }
    }
    function t(key) { return (COPY[lang()] || COPY.ro)[key] || COPY.en[key] || key; }

    var state = {
        map: null,
        enabled: false,
        offsets: loadOffsets(),       /* pane → {x, y} metres (EPSG:3857) */
        targets: {},                  /* pane → {pane, label, defId, z} */
        selectedPane: null,
        panel: null,
        drag: null,                   /* {id, startX, startY, baseX, baseY} */
        press: null,                  /* long-press bookkeeping */
        suppressContextMenu: false
    };

    function loadOffsets() {
        try {
            var raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
            var parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) { return {}; }
    }
    function saveOffsets() {
        try { if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.offsets)); }
        catch (e) { /* private mode: the offset still applies this session */ }
    }

    function registry() { return root.DetectLabLayers || null; }

    function defOf(layer) {
        var reg = registry();
        if (!reg) return null;
        var id = layer && (layer._dlDefId || (layer.options && layer.options.dlDefId));
        if (id) { try { return reg.get(id); } catch (e) { /* fall through */ } }
        if (!reg.matchDef) return null;
        try {
            return reg.matchDef({
                url: (layer && layer._url) || (layer && layer.options && layer.options.url) || '',
                layers: layer && layer.options && (layer.options.layers || layer.options.layer),
                version: layer && layer.options && layer.options.version
            });
        } catch (e) { return null; }
    }

    function defTitle(def) {
        if (!def) return '';
        if (typeof def.title === 'string') return def.title;
        return (def.title && (def.title[lang()] || def.title.en || def.title.ro)) || def.id || '';
    }

    function collectLeaves(layer, out) {
        if (!layer) return;
        if (typeof layer.eachLayer === 'function' && typeof layer.getTileUrl !== 'function' &&
            !(root.L && root.L.ImageOverlay && layer instanceof root.L.ImageOverlay)) {
            var kids = 0;
            try { layer.eachLayer(function (child) { kids += 1; collectLeaves(child, out); }); } catch (e) { /* leaf */ }
            if (kids) return;
        }
        out.push(layer);
    }

    /** Historical targets currently ON the map, one per pane, topmost first. */
    function discover() {
        var targets = {};
        var map = state.map;
        if (!map || typeof map.eachLayer !== 'function') { state.targets = targets; return targets; }
        var leaves = [];
        map.eachLayer(function (layer) { collectLeaves(layer, leaves); });
        leaves.forEach(function (layer) {
            var pane = layer && layer.options && layer.options.pane;
            if (!pane) return;
            var def = defOf(layer);
            var isHist = (def && HIST_GROUPS[def.group]) || EXTRA_PANES[pane];
            if (!isHist) return;
            var z = 0;
            try {
                var el = map.getPane(pane);
                z = el ? (parseInt(el.style.zIndex, 10) || 0) : 0;
            } catch (e) { z = 0; }
            if (!targets[pane] || (def && !targets[pane].defId)) {
                targets[pane] = {
                    pane: pane,
                    defId: def ? def.id : null,
                    label: (def && defTitle(def)) || (layer.options && layer.options.name) || pane.replace(/^pane_/, '').replace(/_/g, ' '),
                    z: z
                };
            }
        });
        state.targets = targets;
        if (!state.selectedPane || !targets[state.selectedPane]) {
            var sorted = Object.keys(targets).map(function (k) { return targets[k]; })
                .sort(function (a, b) { return b.z - a.z; });
            state.selectedPane = sorted.length ? sorted[0].pane : null;
        }
        return targets;
    }

    function activeTargets() {
        return Object.keys(discover()).map(function (k) { return state.targets[k]; })
            .sort(function (a, b) { return b.z - a.z; });
    }

    /* ── offsets ─────────────────────────────────────────────────────────── */
    function clampOffset(x, y) {
        var len = Math.sqrt(x * x + y * y);
        if (len <= MAX_OFFSET_M || len === 0) return { x: x, y: y };
        var s = MAX_OFFSET_M / len;
        return { x: x * s, y: y * s };
    }
    function getOffset(pane) {
        var o = state.offsets[pane];
        return o ? { x: Number(o.x) || 0, y: Number(o.y) || 0 } : { x: 0, y: 0 };
    }
    function metersPerPixel() {
        var map = state.map;
        var z = map && typeof map.getZoom === 'function' ? map.getZoom() : 0;
        return M_PER_PX_Z0 / Math.pow(2, z);
    }
    function applyPane(pane) {
        var map = state.map;
        if (!map || typeof map.getPane !== 'function') return;
        var el = map.getPane(pane);
        if (!el) return;
        var o = getOffset(pane);
        var mpp = metersPerPixel();
        var dx = o.x / mpp, dy = o.y / mpp;
        el.style.transform = (dx || dy)
            ? 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)' : '';
    }
    function applyAll() {
        Object.keys(state.offsets).forEach(applyPane);
        Object.keys(state.targets).forEach(applyPane);
    }
    function setOffset(pane, dxM, dyM) {
        if (!pane) return null;
        var clamped = clampOffset(Number(dxM) || 0, Number(dyM) || 0);
        state.offsets[pane] = clamped;
        saveOffsets();
        applyPane(pane);
        paintPanel();
        return clamped;
    }
    function reset(pane) { return setOffset(pane || state.selectedPane, 0, 0); }

    /* ── panel ───────────────────────────────────────────────────────────── */
    function ensurePanel() {
        if (state.panel) return state.panel;
        var map = state.map;
        var container = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
        if (!container) return null;
        var panel = document.createElement('div');
        panel.id = 'histShiftPanel';
        panel.className = 'hist-shift-panel';
        panel.style.display = 'none';
        panel.innerHTML =
            '<div class="hist-shift-head"><span class="hist-shift-title"></span>' +
            '<button type="button" class="hist-shift-close" aria-label="Close">×</button></div>' +
            '<select class="hist-shift-select" aria-label="Historical layer"></select>' +
            '<div class="hist-shift-row"><span class="hist-shift-state"></span>' +
            '<label class="apm-toggle-switch hist-shift-switch"><input type="checkbox" class="hist-shift-toggle">' +
            '<span class="apm-toggle-track"></span></label></div>' +
            '<div class="hist-shift-meta"><span class="hist-shift-offset"></span>' +
            '<button type="button" class="hist-shift-reset"></button></div>' +
            '<div class="hist-shift-hint"></div>' +
            '<div class="hist-shift-nolayer" style="display:none"></div>';
        container.appendChild(panel);
        panel.querySelector('.hist-shift-close').addEventListener('click', function () {
            if (state.enabled) setEnabled(false);      /* closing = lock in place */
            hidePanel();
        });
        panel.querySelector('.hist-shift-toggle').addEventListener('change', function (ev) {
            setEnabled(!!ev.target.checked);
        });
        panel.querySelector('.hist-shift-select').addEventListener('change', function (ev) {
            state.selectedPane = ev.target.value || null;
            paintPanel();
        });
        panel.querySelector('.hist-shift-reset').addEventListener('click', function () { reset(); });
        /* Dragging on the panel must never start a map drag / long-press. */
        panel.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
        state.panel = panel;
        return panel;
    }

    function paintPanel() {
        var panel = state.panel;
        if (!panel) return;
        var targets = activeTargets();
        panel.querySelector('.hist-shift-title').textContent = t('title');
        panel.querySelector('.hist-shift-reset').textContent = t('reset');
        var select = panel.querySelector('.hist-shift-select');
        var current = state.selectedPane;
        select.innerHTML = '';
        targets.forEach(function (target) {
            var opt = document.createElement('option');
            opt.value = target.pane;
            opt.textContent = target.label;
            select.appendChild(opt);
        });
        if (current && targets.some(function (x) { return x.pane === current; })) select.value = current;
        var hasTargets = targets.length > 0;
        select.style.display = hasTargets ? '' : 'none';
        panel.querySelector('.hist-shift-nolayer').style.display = hasTargets ? 'none' : '';
        panel.querySelector('.hist-shift-nolayer').textContent = hasTargets ? '' : t('noLayer');
        var toggle = panel.querySelector('.hist-shift-toggle');
        toggle.checked = state.enabled;
        toggle.disabled = !hasTargets;
        panel.querySelector('.hist-shift-state').textContent = state.enabled ? t('move') : t('locked');
        panel.querySelector('.hist-shift-hint').textContent = state.enabled ? t('hintOn') : t('hintOff');
        var o = current ? getOffset(current) : { x: 0, y: 0 };
        panel.querySelector('.hist-shift-offset').textContent =
            t('offset') + ': ' + Math.round(o.x) + ' m, ' + Math.round(-o.y) + ' m';
        panel.classList.toggle('is-active', state.enabled);
    }

    function showPanel() {
        var panel = ensurePanel();
        if (!panel) return;
        discover();
        paintPanel();
        panel.style.display = '';
    }
    function hidePanel() { if (state.panel) state.panel.style.display = 'none'; }

    /* ── move mode ───────────────────────────────────────────────────────── */
    function setEnabled(on) {
        var targets = activeTargets();
        state.enabled = !!on && targets.length > 0;
        var map = state.map;
        if (map) {
            try {
                if (state.enabled && map.dragging && map.dragging.enabled()) map.dragging.disable();
                else if (!state.enabled && map.dragging && !map.dragging.enabled()) map.dragging.enable();
            } catch (e) { /* handler state is best-effort */ }
            var container = typeof map.getContainer === 'function' ? map.getContainer() : null;
            if (container) container.classList.toggle('hist-shift-active', state.enabled);
        }
        paintPanel();
        return state.enabled;
    }
    function isEnabled() { return state.enabled; }

    /* ── gestures: long-press to reveal/lock, drag to shift ──────────────── */
    var UI_TARGET_SELECTOR = 'button, a, input, select, textarea, label, .leaflet-control, ' +
        '.leaflet-marker-icon, .leaflet-popup, .leaflet-bar, #histShiftPanel, ' +
        '[class*="panel"], [class*="dock"], [id*="Panel"], [id*="panel"]';

    /* O apăsare e „pe UI" doar dacă elementul interactiv e ÎN containerul
     * hărții (controale Leaflet, markere, popup-uri, propriul panou).
     * Căutarea se oprește la container: clasele de stare puse pe <body> de
     * oglinzile de pe ecranul principal — `vo-josephine-docked` (sliderul
     * Hărții Iosefine adăugat pe ecran), `layer-dock-open` (dock-ul unui
     * slider de distanță), `transp-panel-open` (panoul de straturi deschis)
     * — conțin „dock"/„panel", deci un closest() nelegat le potrivea pe
     * <body> pentru ORICE țintă din hartă și long-press-ul (și drag-ul din
     * modul mutare) nu mai pornea deloc cât timp sliderul era pe ecran.
     * Vezi HIST_SHIFT_DOCKED_SLIDER.md. */
    function isUiTarget(el) {
        if (!el) return false;
        var node = el.nodeType === 1 ? el : (el.parentElement || null);
        if (!node) return false;
        var container = null;
        try {
            container = state.map && typeof state.map.getContainer === 'function'
                ? state.map.getContainer() : null;
        } catch (e) { container = null; }
        while (node) {
            if (typeof node.matches === 'function') {
                try { if (node.matches(UI_TARGET_SELECTOR)) return true; }
                catch (e) { /* selector neacceptat de motor: continuă urcarea */ }
            }
            if (container && node === container) break;
            node = node.parentElement || null;
            /* Fără container cunoscut, closest() clasic rămâne rezerva:
             * urcarea din nod în nod s-a terminat fără potrivire. */
            if (!node && !container && typeof el.closest === 'function') {
                try { return !!el.closest(UI_TARGET_SELECTOR); } catch (e) { return false; }
            }
        }
        return false;
    }

    function cancelPress() {
        if (state.press && state.press.timer) root.clearTimeout(state.press.timer);
        state.press = null;
    }

    function onPointerDown(ev) {
        if (ev.isPrimary === false) return;
        if (state.enabled) {
            /* In move mode any drag on the map shifts the historical layer —
             * the base map dragging handler is disabled, so this is the drag. */
            if (isUiTarget(ev.target) || !state.selectedPane) return;
            var o = getOffset(state.selectedPane);
            state.drag = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, baseX: o.x, baseY: o.y };
            return;
        }
        if (isUiTarget(ev.target)) return;
        cancelPress();
        var press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, timer: null };
        press.timer = root.setTimeout(function () {
            if (!state.press || state.press.id !== press.id) return;
            state.suppressContextMenu = true;
            showPanel();               /* long-press: reveal the switch */
        }, LONG_PRESS_MS);
        state.press = press;
    }

    function onPointerMove(ev) {
        if (state.drag && ev.pointerId === state.drag.id) {
            var mpp = metersPerPixel();
            setOffset(state.selectedPane,
                state.drag.baseX + (ev.clientX - state.drag.startX) * mpp,
                state.drag.baseY + (ev.clientY - state.drag.startY) * mpp);
            return;
        }
        if (state.press && ev.pointerId === state.press.id) {
            var dx = ev.clientX - state.press.x, dy = ev.clientY - state.press.y;
            if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) cancelPress();
        }
    }

    function onPointerUp(ev) {
        if (state.drag && ev.pointerId === state.drag.id) state.drag = null;
        if (state.press && ev.pointerId === state.press.id) cancelPress();
    }

    function attach(map) {
        if (!map || state.map === map) return state.map === map;
        state.map = map;
        var container = typeof map.getContainer === 'function' ? map.getContainer() : null;
        if (!container) return false;
        container.addEventListener('pointerdown', onPointerDown);
        container.addEventListener('pointermove', onPointerMove);
        container.addEventListener('pointerup', onPointerUp);
        container.addEventListener('pointercancel', onPointerUp);
        container.addEventListener('contextmenu', function (ev) {
            if (state.suppressContextMenu) { ev.preventDefault(); state.suppressContextMenu = false; }
            else if (state.enabled) ev.preventDefault();
        });
        if (typeof map.on === 'function') {
            map.on('layeradd layerremove', function () { discover(); applyAll(); if (state.panel && state.panel.style.display !== 'none') paintPanel(); });
            /* The pixel size of a metre changes with zoom: re-assert every
             * saved offset so the layer stays on the same geographic shift. */
            map.on('zoomend moveend', applyAll);
        }
        discover();
        applyAll();
        return true;
    }

    function boot() {
        if (state.map) return;
        var map = root._dlMap || root.map || null;
        if (map && typeof map.getContainer === 'function') attach(map);
    }

    var api = {
        VERSION: '2026-10-20-hist-shift-v2',
        MAX_OFFSET_M: MAX_OFFSET_M,
        LONG_PRESS_MS: LONG_PRESS_MS,
        attach: attach,
        activeTargets: activeTargets,
        setEnabled: setEnabled,
        isEnabled: isEnabled,
        getOffset: getOffset,
        setOffset: setOffset,
        reset: reset,
        showPanel: showPanel,
        hidePanel: hidePanel,
        clampOffset: clampOffset,
        _state: state
    };
    root.DetectLabHistShift = api;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    var attempts = 0;
    var timer = root.setInterval(function () {
        attempts += 1;
        if (state.map || attempts > 60) { root.clearInterval(timer); return; }
        boot();
    }, 250);
}(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null));
