/*
 * js/uk-heritage-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * DetectLab · the United Kingdom heritage registers (England + Wales)
 *
 * What this file does
 *   Historic England's National Heritage List for England (NHLE) and the four
 *   national registers published by the Royal Commission / Heneb / Cadw for
 *   Wales are drawn as ordinary FREE panel sublayers — the same rows Romania's
 *   sublayers, the Danish and the Finnish catalogues use:
 *
 *     ┌ ● National Heritage List for England   Historic England  [pill] ┐
 *     │ Opacity                                        ⓘ    [ 80% ]   │
 *     │ ─────────────────●──────────────── (opacity slider)            │
 *     │ (status: “1 284 features” / zoom hint / a failure)             │
 *     └───────────────────────────────────────────────────────────────┘
 *
 *   • every source owns its ON/OFF switch (`.apm-toggle-switch`), its own
 *     opacity slider (`.transp-slider`), its own percentage badge (`.pct`)
 *     and its OWN ⓘ — licence, coverage, provider and zoom limit are that
 *     source's, never the group's generalities;
 *   • the group itself is one Romania-style `.transp-layer-row` — a title, an
 *     ⓘ for the whole family, an expand chevron and a master switch — over a
 *     left-bordered `#ukHeritageSubLayers` column, exactly like the “Hărți
 *     istorice” / “Roman Empire” / Finnish sections.
 *
 * Free tab only
 *   The whole group and every row it builds is `data-category="free"`. The
 *   previous version was a bare `.country-section-list` whose children were
 *   plain rows without a category: the Free/Premium tabs gate
 *   `.transp-layer-row[data-category]` and `.country-section-list` is
 *   `display:contents`, so the UK registers leaked into the Premium tab and
 *   were listed twice (once as a free layer, once as a premium one). The group
 *   is now a real `.transp-layer-row[data-category="free"]` — gated by the
 *   same CSS rule as every other free row — and so is each source row, so the
 *   registers can never appear in the Premium tab, whatever the panel does to
 *   its containers. `js/map-app.js`'s switchLayerTab() keeps the tab `.active`
 *   marker on both levels.
 *
 * Coverage
 *   The group is shown only for the United Kingdom (`detectlab:country-selected`
 *   with GB / GBR / UK). The two Welsh commissions and Cadw publish their own
 *   FeatureServers, so each register is its own switch — leaving RCAHMW off
 *   does not stop the NHLE from drawing.
 *
 * Laziness and failures
 *   Nothing is requested until a row is switched on. A source only queries the
 *   current viewport (`esriGeometryEnvelope` + `esriSpatialRelIntersects`),
 *   re-queries on `moveend`/`zoomend` with a short debounce, aborts the
 *   in-flight request when it is switched off, and stays silent below its own
 *   minimum zoom. The row's status line reports the feature count, the zoom
 *   hint or “temporarily unavailable” — never a stack trace. FeatureServer
 *   metadata is discovered once for services published as a root (the NHLE
 *   exposes several public sublayers), so an upstream reshuffle does not make
 *   records disappear silently.
 *
 * Public API — `window.DetectLabUkHeritage`
 *   sources, source, isActive, setSource, toggle (alias), setSourceOpacity,
 *   setGroupOpacity, setExpanded, groupInfo, sourceInfo, filterForCountry.
 *   The inline handlers in index.html (`toggleUkHeritageLayers`,
 *   `setUkHeritageOpacity`, `toggleUkHeritageSubLayers`,
 *   `showUkHeritageGroupInfo`) are the same functions.
 */
(function (window, document) {
    'use strict';
    if (!window || !document || !window.L) return;

    /* ── the sources ─────────────────────────────────────────────────────── */

    var ENGLAND = 'https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer';
    var WALES = 'https://services7.arcgis.com/YFaBqL5jL3y8fq7s/arcgis/rest/services/';

    /* `label` is the register's own name (the name its provider publishes),
     * `provider` the short body that keeps the register, and `info` the text
     * the row's ⓘ shows. Nothing here is shared between two rows: a visitor
     * can always tell which of the seven registers a colour belongs to. */
    var SOURCES = [
        {
            id: 'nhle',
            label: { en: 'National Heritage List for England', ro: 'Registrul național al patrimoniului Angliei (NHLE)' },
            provider: 'Historic England',
            url: ENGLAND,
            discoverLayers: true,
            minZoom: 8,
            colour: '#d9a441',
            attribution: '© Historic England · National Heritage List for England (NHLE)',
            info: {
                en: 'The statutory register of England\'s designated heritage: listed buildings, scheduled monuments, registered parks and gardens, battlefields, protected wrecks and World Heritage Sites. Live ArcGIS FeatureServer records for the visible map area, from zoom 8.',
                ro: 'Registrul legal al patrimoniului desemnat din Anglia: clădiri listate, monumente programate, parcuri și grădini înregistrate, câmpuri de luptă, epave protejate și situri din patrimoniul mondial. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 8.'
            }
        },
        {
            id: 'rcahmw',
            label: { en: 'National Monuments Records of Wales (RCAHMW)', ro: 'Registrul monumentelor din Țara Galilor (RCAHMW)' },
            provider: 'RCAHMW',
            url: WALES + 'National_Monuments_Record_of_Wales/FeatureServer/2',
            minZoom: 13,
            colour: '#65b5e8',
            attribution: '© RCAHMW · Royal Commission on the Ancient and Historical Monuments of Wales',
            info: {
                en: 'The national monuments record of Wales held by the Royal Commission (RCAHMW): archaeological sites, historic buildings and landscapes, with their NMRW identifiers. Live ArcGIS FeatureServer records for the visible map area, from zoom 13.',
                ro: 'Registrul național al monumentelor din Țara Galilor, ținut de Royal Commission (RCAHMW): situri arheologice, clădiri și peisaje istorice, cu identificatorii NMRW. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 13.'
            }
        },
        {
            id: 'heneb',
            label: { en: 'Historic Environment Record of Wales (Heneb)', ro: 'Registrul mediului istoric din Țara Galilor (Heneb)' },
            provider: 'Heneb',
            url: WALES + 'Welsh_Historic_Environment_Records/FeatureServer/0',
            minZoom: 13,
            colour: '#9b82d1',
            attribution: '© Heneb · Welsh Historic Environment Records',
            info: {
                en: 'The four regional Historic Environment Records of Wales (Heneb — formerly the Welsh Archaeological Trusts): every known archaeological site and find spot, with its PRN. Live ArcGIS FeatureServer records for the visible map area, from zoom 13.',
                ro: 'Cele patru registre regionale ale mediului istoric din Țara Galilor (Heneb — fostele Welsh Archaeological Trusts): fiecare sit arheologic și loc de descoperire cunoscut, cu PRN-ul lui. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 13.'
            }
        },
        {
            id: 'listed',
            label: { en: 'Listed buildings (Cadw)', ro: 'Clădiri listate (Cadw)' },
            provider: 'Cadw',
            url: WALES + 'Listed_Buildings/FeatureServer/0',
            minZoom: 12,
            colour: '#e7bd55',
            attribution: '© Cadw · Welsh Government historic environment service',
            info: {
                en: 'Buildings of special architectural or historic interest in Wales, listed by Cadw at grade I, II* and II, with their listing reference and the address the listing describes. Live ArcGIS FeatureServer records for the visible map area, from zoom 12.',
                ro: 'Clădiri de interes arhitectural sau istoric deosebit din Țara Galilor, listate de Cadw la gradul I, II* și II, cu referința listării și adresa descrisă. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 12.'
            }
        },
        {
            id: 'scheduled',
            label: { en: 'Scheduled monuments (Cadw)', ro: 'Monumente programate (Cadw)' },
            provider: 'Cadw',
            url: WALES + 'Scheduled_Monuments/FeatureServer/0',
            minZoom: 9,
            colour: '#e46d5f',
            attribution: '© Cadw · Welsh Government historic environment service',
            info: {
                en: 'Nationally important archaeological sites and monuments in Wales, protected under the Ancient Monuments and Archaeological Areas Act, as scheduled by Cadw. Live ArcGIS FeatureServer records for the visible map area, from zoom 9.',
                ro: 'Situri și monumente arheologice de importanță națională din Țara Galilor, protejate prin Ancient Monuments and Archaeological Areas Act și programate de Cadw. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 9.'
            }
        },
        {
            id: 'wrecks',
            label: { en: 'Designated wrecks (Cadw)', ro: 'Epave desemnate (Cadw)' },
            provider: 'Cadw',
            url: WALES + 'Designated_Wrecks/FeatureServer/0',
            minZoom: 8,
            colour: '#39aeb3',
            attribution: '© Cadw · Welsh Government historic environment service',
            info: {
                en: 'Historic wrecks in Welsh waters protected under the Protection of Wrecks Act 1973 — the designated site, its name and the licence the site requires. Live ArcGIS FeatureServer records for the visible map area, from zoom 8.',
                ro: 'Epave istorice din apele Țării Galilor, protejate prin Protection of Wrecks Act 1973 — situl desemnat, numele lui și licența necesară. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 8.'
            }
        },
        {
            id: 'parks',
            label: { en: 'Registered historical parks & gardens (Cadw)', ro: 'Parcuri și grădini istorice înregistrate (Cadw)' },
            provider: 'Cadw',
            url: WALES + 'Registered_Parks_and_Gardens/FeatureServer/0',
            minZoom: 9,
            colour: '#73b86b',
            attribution: '© Cadw · Welsh Government historic environment service',
            info: {
                en: 'The register of historic parks and gardens of special historic interest in Wales, at grade I, II* and II, as maintained by Cadw. Live ArcGIS FeatureServer records for the visible map area, from zoom 9.',
                ro: 'Registrul parcurilor și grădinilor istorice de interes istoric deosebit din Țara Galilor, la gradul I, II* și II, ținut de Cadw. Înregistrări live din ArcGIS FeatureServer, pentru zona vizibilă a hărții, de la zoom 9.'
            }
        }
    ];

    /* The few labels this module generates itself. Everything static in the
     * group markup (title, switch titles) lives in index.html with data-key
     * attributes and therefore travels through js/translations.js. */
    var TEXT = {
        toggle: { en: 'Toggle', ro: 'Comută' },
        layerInfo: { en: 'Layer info', ro: 'Informații strat' },
        opacity: { en: 'Opacity', ro: 'Opacitate' },
        expand: { en: 'Expand/Collapse the UK heritage sources', ro: 'Extinde/restânge sursele de patrimoniu din Regatul Unit' },
        loading: { en: 'Loading…', ro: 'Se încarcă…' },
        unavailable: { en: 'Temporarily unavailable', ro: 'Temporar indisponibil' },
        zoomTo: { en: 'Zoom to', ro: 'Zoom la' },
        features: { en: 'features', ro: 'elemente' },
        none: { en: 'No records in this view', ro: 'Nicio înregistrare în această zonă' },
        provider: { en: 'Provider', ro: 'Furnizor' },
        zoomLimit: { en: 'shown from zoom', ro: 'afișat de la zoom' },
        groupInfo: {
            en: 'Seven live national heritage registers for England and Wales. Every register has its own on/off switch, its own opacity slider and its own ⓘ (licence, coverage and zoom limit). Records are requested for the visible map area only.',
            ro: 'Șapte registre naționale de patrimoniu, live, pentru Anglia și Țara Galilor. Fiecare registru are propriul comutator, propriul slider de opacitate și propriul ⓘ (licență, acoperire și nivel de zoom). Înregistrările sunt cerute doar pentru zona vizibilă a hărții.'
        }
    };

    var GROUP_ID = 'ukHeritageRow';
    var MOUNT_ID = 'ukHeritageSubLayers';
    var PANE = 'ukHeritagePane';
    var PANE_Z = 621;
    var DEFAULT_OPACITY = 80;
    var DEBOUNCE_MS = 180;
    var MAX_RECORDS = 8000;

    /* ── state ───────────────────────────────────────────────────────────── */

    var state = {
        map: null,
        active: {},       /* source id → switch on */
        opacity: {},      /* source id → 0…100 */
        groupOpacity: DEFAULT_OPACITY,
        layers: {},       /* source id → L.GeoJSON */
        aborters: {},
        counts: {},
        status: {},
        statusKind: {},
        expanded: true,
        timer: null,
        rows: {}
    };

    /* ── small helpers ───────────────────────────────────────────────────── */

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function lang() {
        try {
            if (typeof window._currentLang === 'function') return String(window._currentLang() || 'en');
        } catch (e) { /* private mode / translations not loaded yet */ }
        var htmlLang = document.documentElement && document.documentElement.getAttribute('lang');
        return String(htmlLang || 'en');
    }
    function isRo() {
        return lang().toLowerCase().indexOf('ro') === 0;
    }
    function tr(pair) {
        if (!pair) return '';
        if (typeof pair === 'string') return pair;
        return isRo() ? (pair.ro || pair.en || '') : (pair.en || pair.ro || '');
    }

    function source(id) {
        for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i];
        return null;
    }
    function label(s) { return tr(s.label); }
    function clampi(value) {
        var n = Number(value);
        if (!isFinite(n)) return DEFAULT_OPACITY;
        return Math.max(0, Math.min(100, Math.round(n)));
    }
    function opacityPct(s) {
        var v = state.opacity[s.id];
        return v === undefined ? DEFAULT_OPACITY : v;
    }
    function opacityFactor(s) { return opacityPct(s) / 100; }
    function getMap() { return window._dlMap || window.map || window._map || null; }

    function showInfo(title, credits, description) {
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, credits, description);
            return true;
        }
        return false;
    }

    /* ── map geometry style (the same colour language as the rows) ───────── */

    function styleFor(s, feature) {
        var o = opacityFactor(s);
        var point = feature && feature.geometry && feature.geometry.type === 'Point';
        if (point) {
            return {
                radius: 5,
                color: '#ffffff',
                weight: 1,
                opacity: 0.9 * o,
                fillColor: s.colour,
                fillOpacity: 0.9 * o
            };
        }
        return {
            color: s.colour,
            weight: 2,
            opacity: 0.9 * o,
            fillColor: s.colour,
            fillOpacity: 0.22 * o
        };
    }

    function popup(feature, s) {
        var p = (feature && feature.properties) || {};
        var preferred = ['Name', 'NAME', 'name', 'Title', 'TITLE', 'Description', 'Reference', 'ListEntry', 'PRN'];
        var rows = [];
        preferred.forEach(function (key) {
            if (p[key] != null && p[key] !== '' && rows.length < 4) {
                rows.push('<b>' + esc(key) + ':</b> ' + esc(p[key]));
            }
        });
        return '<strong>' + esc(label(s)) + '</strong>' + (rows.length ? '<br>' + rows.join('<br>') : '');
    }

    function ensureLayer(s) {
        if (state.layers[s.id]) return state.layers[s.id];
        state.layers[s.id] = window.L.geoJSON(null, {
            pane: PANE,
            style: function (feature) { return styleFor(s, feature); },
            pointToLayer: function (feature, latlng) {
                return window.L.circleMarker(latlng, window.L.Util.extend({ pane: PANE }, styleFor(s, feature)));
            },
            onEachFeature: function (feature, layer) { layer.bindPopup(popup(feature, s)); }
        });
        return state.layers[s.id];
    }

    /* The slider repaints the existing geometry instead of re-querying it. */
    function applyOpacity(s) {
        var layer = state.layers[s.id];
        if (!layer || typeof layer.eachLayer !== 'function') return;
        layer.eachLayer(function (child) {
            if (child && typeof child.setStyle === 'function') child.setStyle(styleFor(s, child.feature));
        });
    }

    /* ── status line ─────────────────────────────────────────────────────── */

    function paintStatus(node, text, kind) {
        if (!node) return;
        node.textContent = text || '';
        node.style.display = text ? 'block' : 'none';
        node.className = 'uk-heritage-status' + (kind ? ' is-' + kind : '');
        node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }

    function setStatus(id, text, kind) {
        state.status[id] = text || '';
        state.statusKind[id] = kind || '';
        paintStatus(document.getElementById('ukHeritageStatus-' + id), text, kind);
    }

    function countStatus(id, count) {
        var s = source(id);
        if (!s) return;
        state.counts[id] = count;
        if (!count) setStatus(id, tr(TEXT.none), 'hint');
        else setStatus(id, count.toLocaleString() + ' ' + tr(TEXT.features), 'count');
    }

    /* ── fetching (viewport only, cancellable, per source) ───────────────── */

    function load(s) {
        if (!state.map || !state.active[s.id]) return;

        if (state.map.getZoom() < s.minZoom) {
            ensureLayer(s).clearLayers();
            state.counts[s.id] = 0;
            setStatus(s.id, tr(TEXT.zoomTo) + ' ' + s.minZoom + '+', 'hint');
            return;
        }

        if (state.aborters[s.id]) state.aborters[s.id].abort();
        var controller = window.AbortController ? new window.AbortController() : null;
        state.aborters[s.id] = controller;
        var requestOptions = controller ? { signal: controller.signal } : {};

        var b = state.map.getBounds();
        var params = new window.URLSearchParams({
            f: 'geojson',
            where: '1=1',
            outFields: '*',
            returnGeometry: 'true',
            geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            outSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            resultRecordCount: String(MAX_RECORDS)
        });

        setStatus(s.id, tr(TEXT.loading), 'loading');

        /* Historic England publishes the NHLE as a FeatureServer root (not a
         * single layer id), so discover its current public sublayers once —
         * additions/reordering upstream then cannot make records vanish. */
        var urlsPromise = s.discoverLayers
            ? (s._layerUrls ? Promise.resolve(s._layerUrls) : fetch(s.url + '?f=json', requestOptions).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }).then(function (meta) {
                if (meta && meta.error) throw new Error(meta.error.message || 'ArcGIS metadata error');
                s._layerUrls = ((meta && meta.layers) || []).map(function (item) { return s.url + '/' + item.id; });
                if (!s._layerUrls.length) throw new Error('No public NHLE sublayers');
                return s._layerUrls;
            }))
            : Promise.resolve([s.url]);

        urlsPromise.then(function (urls) {
            return Promise.all(urls.map(function (url) {
                return fetch(url + '/query?' + params.toString(), requestOptions).then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                });
            }));
        }).then(function (collections) {
            if (!state.active[s.id]) return;
            var features = [];
            collections.forEach(function (data) {
                if (data && data.error) throw new Error(data.error.message || 'ArcGIS error');
                features = features.concat((data && data.features) || []);
            });
            var layer = ensureLayer(s);
            layer.clearLayers();
            layer.addData({ type: 'FeatureCollection', features: features });
            countStatus(s.id, features.length);
        }).catch(function (err) {
            if (err && err.name === 'AbortError') return;
            if (!state.active[s.id]) return;
            setStatus(s.id, tr(TEXT.unavailable), 'error');
            if (window.console) window.console.warn('[UK heritage] ' + s.id, err);
        });
    }

    function refresh() {
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(function () {
            SOURCES.forEach(function (s) { if (state.active[s.id]) load(s); });
        }, DEBOUNCE_MS);
    }

    /* ── switching ───────────────────────────────────────────────────────── */

    function setSource(id, on, silent) {
        var s = source(id);
        if (!s) return;
        state.active[id] = !!on;
        if (!state.map) {
            if (!silent) syncUI();
            return;
        }
        var layer = ensureLayer(s);
        if (on) {
            if (!state.map.hasLayer(layer)) layer.addTo(state.map);
            load(s);
        } else {
            if (state.aborters[id]) state.aborters[id].abort();
            state.counts[id] = 0;
            if (state.map.hasLayer(layer)) state.map.removeLayer(layer);
            layer.clearLayers();
            setStatus(id, '');
        }
        if (!silent) syncUI();
    }

    function toggleAll(on) {
        SOURCES.forEach(function (s) { setSource(s.id, !!on, true); });
        syncUI();
    }

    function setSourceOpacity(id, value) {
        var s = source(id);
        if (!s) return;
        state.opacity[id] = clampi(value);
        applyOpacity(s);
        var pct = document.getElementById('ukHeritagePct-' + id);
        if (pct) pct.textContent = state.opacity[id] + '%';
        var slider = document.getElementById('ukHeritageOpacity-' + id);
        if (slider && String(slider.value) !== String(state.opacity[id])) slider.value = String(state.opacity[id]);
    }

    function setGroupOpacity(value) {
        state.groupOpacity = clampi(value);
        SOURCES.forEach(function (s) {
            state.opacity[s.id] = state.groupOpacity;
            applyOpacity(s);
        });
        syncUI();
    }

    /* ── the panel ───────────────────────────────────────────────────────── */

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'text') node.textContent = attrs[key];
            else if (key === 'html') node.innerHTML = attrs[key];
            else if (key === 'style') node.setAttribute('style', attrs[key]);
            else if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
        });
        (children || []).forEach(function (child) { if (child) node.appendChild(child); });
        return node;
    }

    var INFO_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />' +
        '<circle cx="12" cy="7.5" r="1.3" fill="currentColor" />' +
        '<rect x="10.8" y="10.5" width="2.4" height="7" rx="1.2" fill="currentColor" /></svg>';

    /* One row per register: title + provider on the left, the pill switch on
     * the right, then the shared “Opacity ⓘ 80%” line and the shared slider —
     * the exact shape of Romania's sublayers, the Danish rows and the Finnish
     * rows (`.dl-sublayer-row` glass box included). */
    function buildRow(s) {
        var title = label(s);
        var isOn = !!state.active[s.id];

        var input = el('input', {
            type: 'checkbox',
            id: 'ukHeritageToggle-' + s.id,
            'data-uk-heritage-input': s.id,
            'aria-label': title
        });
        input.checked = isOn;
        input.addEventListener('change', function () { setSource(s.id, input.checked); });

        var toggle = el('label', {
            class: 'apm-toggle-switch',
            title: tr(TEXT.toggle) + ' ' + title,
            style: 'transform:scale(0.85);transform-origin:right center;flex-shrink:0;'
        }, [input, el('span', { class: 'apm-toggle-track' })]);

        var head = el('div', { class: 'uk-heritage-head' }, [
            el('span', { class: 'uk-heritage-title-wrap' }, [
                el('i', { class: 'uk-heritage-dot', style: 'background:' + s.colour, 'aria-hidden': 'true' }),
                el('span', { class: 'uk-heritage-title', text: title }),
                el('span', { class: 'uk-heritage-provider', text: s.provider })
            ]),
            toggle
        ]);

        var info = el('button', {
            type: 'button',
            class: 'layer-info-btn',
            'data-uk-heritage-info': s.id,
            title: tr(TEXT.layerInfo) + ' — ' + title,
            'aria-label': tr(TEXT.layerInfo) + ' — ' + title,
            html: INFO_ICON
        });
        info.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            sourceInfo(s.id);
        });

        var pct = el('span', {
            class: 'pct uk-heritage-pct',
            id: 'ukHeritagePct-' + s.id,
            text: opacityPct(s) + '%'
        });

        var opacityLine = el('div', { class: 'transp-layer-label uk-heritage-opacity-line' }, [
            el('span', { style: 'font-size:0.72rem;opacity:0.6', text: tr(TEXT.opacity) }),
            el('span', { style: 'display:flex;align-items:center;gap:5px' }, [info, pct])
        ]);

        var slider = el('input', {
            type: 'range',
            class: 'transp-slider uk-heritage-slider',
            id: 'ukHeritageOpacity-' + s.id,
            min: '0', max: '100', step: '1',
            value: String(opacityPct(s)),
            'aria-label': tr(TEXT.opacity) + ' — ' + title
        });
        slider.addEventListener('input', function () { setSourceOpacity(s.id, slider.value); });

        var status = el('div', {
            class: 'uk-heritage-status',
            id: 'ukHeritageStatus-' + s.id,
            role: 'status',
            style: 'display:none;'
        });

        var row = el('div', {
            class: 'uk-heritage-sublayer dl-sublayer-row' + (isOn ? ' is-active' : ''),
            id: 'ukHeritageLayer-' + s.id,
            /* FREE, like every row of the free catalogues: the Free/Premium
             * tabs re-mark `.active` on this node, and the CSS gate hides it
             * outside the Free tab. */
            'data-category': 'free',
            'data-uk-heritage-source': s.id
        }, [head, opacityLine, slider, status]);

        state.rows[s.id] = { row: row, input: input, slider: slider, pct: pct, status: status };
        /* A rebuild (language switch) must not lose the row's status line: the
         * node is not in the document yet, so paint it directly. */
        if (state.status[s.id]) paintStatus(status, state.status[s.id], state.statusKind[s.id]);
        return row;
    }

    function buildPanel() {
        var mount = document.getElementById(MOUNT_ID);
        if (!mount) return;
        mount.innerHTML = '';
        state.rows = {};
        SOURCES.forEach(function (s) { mount.appendChild(buildRow(s)); });
        /* The rows the module just created carry no `.active` marker yet, and
         * switchLayerTab() only runs on a tab click / page load. Re-apply the
         * current tab immediately so a rows' tab state never depends on when
         * the panel was opened. */
        applyCurrentTab();
        syncUI();
        setExpanded(state.expanded, true);
    }

    function currentTab() {
        try {
            var btn = document.querySelector('.transp-panel-tabs button.active');
            if (btn) {
                if (btn.dataset && btn.dataset.tab) return btn.dataset.tab;
                if (btn.getAttribute) return btn.getAttribute('data-tab') || 'free';
            }
        } catch (e) { /* the tab bar is best-effort; Free is the default */ }
        return 'free';
    }

    /* The Free/Premium tabs gate every `[data-category]` node through the
     * `.active` marker js/map-app.js's switchLayerTab() keeps on it. This is
     * the same contract for the nodes this module owns (the group row and the
     * seven source rows), so the registers belong to the Free tab only. */
    function applyCurrentTab() {
        var tab = currentTab();
        var nodes = [document.getElementById(GROUP_ID)];
        SOURCES.forEach(function (s) { nodes.push(document.getElementById('ukHeritageLayer-' + s.id)); });
        nodes.forEach(function (node) {
            if (!node || !node.classList) return;
            var category = node.getAttribute ? node.getAttribute('data-category') : null;
            if (!category) return;
            node.classList.toggle('active', category === tab);
        });
    }

    function setExpanded(on, immediate) {
        state.expanded = !!on;
        var body = document.getElementById(MOUNT_ID);
        var icon = document.getElementById('ukHeritageExpandIcon');
        var button = document.getElementById('ukHeritageExpandBtn');
        if (icon) icon.style.transform = on ? 'rotate(0deg)' : 'rotate(-90deg)';
        if (button) button.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (!body) return;

        if (immediate) {
            body.style.transition = 'none';
            body.style.maxHeight = on ? 'none' : '0px';
            body.style.opacity = on ? '1' : '0';
            body.style.marginTop = on ? '8px' : '0';
            /* Force the layout here so the next animated change starts from
             * the value written above, then hand the transition back. */
            void body.offsetHeight;
            window.setTimeout(function () { body.style.transition = ''; }, 30);
            return;
        }

        if (on) {
            body.style.maxHeight = (body.scrollHeight || 6000) + 'px';
            body.style.opacity = '1';
            body.style.marginTop = '8px';
            /* Release the measured ceiling once the animation is over: a fixed
             * max-height would clip the last row after a font/locale change or
             * a browser-zoom resize (the map-app accordion bug). */
            window.setTimeout(function () {
                if (state.expanded) body.style.maxHeight = 'none';
            }, 340);
        } else {
            body.style.maxHeight = (body.scrollHeight || 6000) + 'px';
            body.style.opacity = '1';
            /* Reflow before collapsing so the transition starts from a
             * measurable value instead of `none`. */
            void body.offsetHeight;
            body.style.maxHeight = '0px';
            body.style.opacity = '0';
            body.style.marginTop = '0';
        }
    }

    /* Every control reflects one state object: the master switch (checked,
     * unchecked or indeterminate), each row's switch and slider, each
     * percentage badge and the group slider. */
    function syncUI() {
        var on = SOURCES.filter(function (s) { return !!state.active[s.id]; }).length;
        var master = document.getElementById('ukHeritageToggle');
        if (master) {
            master.checked = on === SOURCES.length && on > 0;
            master.indeterminate = on > 0 && on < SOURCES.length;
        }

        SOURCES.forEach(function (s) {
            var entry = state.rows[s.id];
            var isOn = !!state.active[s.id];
            if (entry) {
                if (entry.input) entry.input.checked = isOn;
                if (entry.row) entry.row.classList.toggle('is-active', isOn);
                if (entry.slider) entry.slider.value = String(opacityPct(s));
                if (entry.pct) entry.pct.textContent = opacityPct(s) + '%';
            } else {
                var cb = document.getElementById('ukHeritageToggle-' + s.id);
                if (cb) cb.checked = isOn;
                var row = document.getElementById('ukHeritageLayer-' + s.id);
                if (row) row.classList.toggle('is-active', isOn);
                var slider = document.getElementById('ukHeritageOpacity-' + s.id);
                if (slider) slider.value = String(opacityPct(s));
                var pct = document.getElementById('ukHeritagePct-' + s.id);
                if (pct) pct.textContent = opacityPct(s) + '%';
            }
        });

        var groupSlider = document.getElementById('ukHeritageOpacitySlider');
        if (groupSlider) groupSlider.value = String(state.groupOpacity);
        var groupPct = document.getElementById('ukHeritagePct');
        if (groupPct) groupPct.textContent = state.groupOpacity + '%';
    }

    /* ── the two ⓘ — the group's and each register's own ─────────────────── */

    function groupInfo() {
        var credits = '© Historic England · © RCAHMW · © Heneb · © Cadw';
        showInfo('United Kingdom · Heritage', credits, tr(TEXT.groupInfo));
    }

    function sourceInfo(id) {
        var s = source(id);
        if (!s) return;
        var bits = [tr(s.info)];
        bits.push(tr(TEXT.provider) + ': ' + s.provider);
        bits.push(tr(TEXT.zoomLimit) + ' ' + s.minZoom);
        var count = state.counts[s.id];
        if (count) bits.push(count.toLocaleString() + ' ' + tr(TEXT.features));
        else if (state.status[s.id]) bits.push(state.status[s.id]);
        else bits.push(tr(TEXT.none));
        showInfo(label(s), s.attribution, bits.join(' · '));
    }

    /* ── country gate (United Kingdom only) ──────────────────────────────── */

    function filter(iso) {
        var row = document.getElementById(GROUP_ID);
        if (!row) return;
        var code = String(iso || '').toUpperCase();
        var visible = !code || code === 'GB' || code === 'GBR' || code === 'UK';
        row.classList.toggle('country-layer-unavailable', !visible);
        row.setAttribute('aria-hidden', visible ? 'false' : 'true');
        SOURCES.forEach(function (s) {
            var node = document.getElementById('ukHeritageLayer-' + s.id);
            if (node) node.classList.toggle('country-layer-unavailable', !visible);
        });
        /* Switching the view away from the UK parks the layers on the map
         * (their switches keep their state) — the country view is locked
         * anyway, and coming back restores exactly what was on. */
        if (!visible && state.map) {
            SOURCES.forEach(function (s) {
                var layer = state.layers[s.id];
                if (layer && state.map.hasLayer(layer)) state.map.removeLayer(layer);
            });
        } else if (visible && state.map) {
            SOURCES.forEach(function (s) {
                if (!state.active[s.id]) return;
                var layer = ensureLayer(s);
                if (!state.map.hasLayer(layer)) layer.addTo(state.map);
                load(s);
            });
        }
    }

    /* ── attach to the map (the map is created after this file loads) ────── */

    function attach(map) {
        if (!map || state.map === map) return;
        state.map = map;
        if (typeof map.getPane === 'function' && !map.getPane(PANE)) {
            map.createPane(PANE);
            map.getPane(PANE).style.zIndex = PANE_Z;
        }
        map.on('moveend zoomend', refresh);
        SOURCES.forEach(function (s) {
            if (!state.active[s.id]) return;
            var layer = ensureLayer(s);
            if (!map.hasLayer(layer)) layer.addTo(map);
            load(s);
        });
    }

    function start() {
        buildPanel();
        filter(window._detectlabSelectedCountry || '');
        var tries = 0;
        var timer = window.setInterval(function () {
            var map = getMap();
            if (map) {
                window.clearInterval(timer);
                attach(map);
                return;
            }
            if (++tries > 240) window.clearInterval(timer);
        }, 250);
    }

    document.addEventListener('detectlab:country-selected', function (e) {
        var detail = e && e.detail;
        filter(typeof detail === 'string' ? detail : detail && (detail.iso || detail.code || detail.country));
    });
    document.addEventListener('detectlab:country-cleared', function () { filter(null); });

    /* Language switch: the static markup is translated through data-key, the
     * rows this module builds re-render their own labels (state untouched). */
    document.addEventListener('detectlab:langchange', function () {
        try { buildPanel(); } catch (err) { /* never break the panel on i18n */ }
    });

    /* ── public API + the inline handlers index.html uses ────────────────── */

    window.DetectLabUkHeritage = {
        sources: SOURCES,
        source: source,
        isActive: function (id) { return !!state.active[id]; },
        setSource: setSource,
        toggle: setSource,
        setSourceOpacity: setSourceOpacity,
        setGroupOpacity: setGroupOpacity,
        toggleAll: toggleAll,
        setExpanded: setExpanded,
        groupInfo: groupInfo,
        sourceInfo: sourceInfo,
        filterForCountry: filter,
        refresh: refresh
    };

    window.toggleUkHeritageLayers = function (on) { toggleAll(on); };
    window.setUkHeritageOpacity = function (value) { setGroupOpacity(value); };
    window.setUkHeritageSourceOpacity = function (id, value) { setSourceOpacity(id, value); };
    window.toggleUkHeritageSubLayers = function () { setExpanded(!state.expanded); };
    window.showUkHeritageGroupInfo = function () { groupInfo(); };
    window.showUkHeritageSourceInfo = function (id) { sourceInfo(id); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
}(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null));
