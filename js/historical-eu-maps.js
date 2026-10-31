/* =====================================================================
 * historical-eu-maps.js — Hărți Istorice Europene (CENAGIS / IH PAN)
 * ---------------------------------------------------------------------
 * Colecție completă de hărți istorice, topografice și planuri urbane
 * georeferențiate, găzduite pe infrastructura CENAGIS (Politechnika Warszawska)
 * și dezvoltate în colaborare cu Instytut Historii PAN (Atlas Fontium / PastMaps).
 *
 * Rândurile sunt listate PLAT în grupul „Hărți istorice / Historical Maps”
 * (index.html #histPremiumSubLayers): fără subcategorie proprie, fără titlu
 * de tip „Hărți europene · CENAGIS / IH PAN” deasupra listei.
 *
 * Categorisire pe fiecare țară europeană intersectată/suprapusă:
 *   • Polonia (PL), Germania (DE), Ucraina (UA), Belarus (BY), Lituania (LT),
 *     Letonia (LV), Cehia (CZ), Slovacia (SK), Austria (AT), Ungaria (HU),
 *     Rusia / Kaliningrad (RU), Moldova (MD), România (RO), Franța (FR),
 *     Belgia & Luxemburg (BE-LU), Țările de Jos (NL), Danemarca (DK),
 *     Estonia (EE), Elveția (CH).
 * ===================================================================== */
(function (root) {
    'use strict';

    /* ── Catalogul complet al hărților CENAGIS ──
     * The 45 sheets are DEFINED ONCE in js/layer-registry.js, which is shared
     * with the 3D terrain view (js/map3d-terrain.js) and with the tile proxy
     * (netlify/lib/map3d-tile.mjs). This file keeps only the country/coverage
     * view built on top of them, so a sheet can never exist in one view and be
     * missing from another. */
    var REGISTRY = root.DetectLabLayers;
    if (!REGISTRY || typeof REGISTRY.cenagisCatalog !== 'function') {
        console.error('[CENAGIS] js/layer-registry.js must load before js/historical-eu-maps.js');
        return;
    }
    var WMS_BASE_URL = REGISTRY.cenagis.url;
    var MAPS_CATALOG = REGISTRY.cenagisCatalog();

    // ── Clasificare pe Țări Europene și Acoperire (%) ──
    var COUNTRIES_DATA = [
        {
            code: 'PL',
            flag: '🇵🇱',
            name: { ro: 'Polonia', en: 'Poland', pl: 'Polska' },
            maps: [
                { id: 'wig100k', pct: 100.0 },
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'kdr_gb', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'reymann', pct: 100.0 },
                { id: 'wig500k_1947', pct: 99.9 },
                { id: 'wig300k', pct: 99.7 },
                { id: 'ahp_ziemie_polskie', pct: 99.9 },
                { id: 'ahp_drogi', pct: 99.9 },
                { id: 'ahp_koscielne', pct: 99.9 },
                { id: 'ahp_wlasnosc', pct: 99.9 },
                { id: 'm25k', pct: 97.2 },
                { id: 'kdr', pct: 95.9 },
                { id: 'wig25k', pct: 91.7 },
                { id: 'tkkp_126k', pct: 69.5 },
                { id: 'kdwr', pct: 65.8 },
                { id: 'dwuwiorstowka', pct: 64.0 },
                { id: 'gilly', pct: 57.7 },
                { id: 'schroetter', pct: 38.8 },
                { id: 'textor', pct: 22.6 },
                { id: 'kummersberg', pct: 20.3 },
                { id: 'gaul', pct: 7.8 },
                // City plans
                { id: 'city_warszawa', pct: 100.0, isCity: true },
                { id: 'city_krakow', pct: 100.0, isCity: true },
                { id: 'city_gdansk', pct: 100.0, isCity: true },
                { id: 'city_wroclaw', pct: 100.0, isCity: true },
                { id: 'city_poznan', pct: 100.0, isCity: true },
                { id: 'city_lodz', pct: 100.0, isCity: true },
                { id: 'city_katowice', pct: 100.0, isCity: true },
                { id: 'city_czestochowa', pct: 100.0, isCity: true },
                { id: 'city_bialystok', pct: 100.0, isCity: true },
                { id: 'city_bydgoszcz', pct: 100.0, isCity: true },
                { id: 'city_torun', pct: 100.0, isCity: true },
                { id: 'city_lublin', pct: 100.0, isCity: true },
                { id: 'city_kielce', pct: 100.0, isCity: true },
                { id: 'city_radom', pct: 100.0, isCity: true },
                { id: 'city_rzeszow', pct: 100.0, isCity: true },
                { id: 'city_tarnow', pct: 100.0, isCity: true },
                { id: 'city_grudziadz', pct: 100.0, isCity: true },
                { id: 'city_inowroclaw', pct: 100.0, isCity: true },
                { id: 'city_jaslo', pct: 100.0, isCity: true },
                { id: 'city_siedlce', pct: 100.0, isCity: true },
                { id: 'city_warszawa_lindley', pct: 100.0, isCity: true },
                { id: 'city_warszawa_1822', pct: 100.0, isCity: true },
                { id: 'city_praga_1796', pct: 100.0, isCity: true }
            ]
        },
        {
            code: 'DE',
            flag: '🇩🇪',
            name: { ro: 'Germania', en: 'Germany', pl: 'Niemcy' },
            maps: [
                { id: 'reymann', pct: 100.0 },
                { id: 'kdr', pct: 99.8 },
                { id: 'chrzanowski', pct: 25.3 },
                { id: 'ukvme', pct: 19.4 },
                { id: 'wig100k', pct: 13.4 },
                { id: 'kdr_gb', pct: 8.6 },
                { id: 'wig500k_1947', pct: 7.0 },
                { id: 'm25k', pct: 3.5 },
                { id: 'wig300k', pct: 1.4 },
                { id: 'ahp_ziemie_polskie', pct: 0.7 },
                { id: 'ahp_drogi', pct: 0.7 },
                { id: 'ahp_koscielne', pct: 0.7 },
                { id: 'ahp_wlasnosc', pct: 0.7 },
                { id: 'gilly', pct: 0.1 }
            ]
        },
        {
            code: 'UA',
            flag: '🇺🇦',
            name: { ro: 'Ucraina', en: 'Ukraine', pl: 'Ukraina' },
            maps: [
                { id: 'chrzanowski', pct: 87.2 },
                { id: 'ukvme', pct: 69.5 },
                { id: 'reymann', pct: 27.9 },
                { id: 'wig100k', pct: 27.0 },
                { id: 'kdr_gb', pct: 24.8 },
                { id: 'wig300k', pct: 13.1 },
                { id: 'wig25k', pct: 11.7 },
                { id: 'kummersberg', pct: 8.5 },
                { id: 'kdwr', pct: 7.4 },
                { id: 'wig500k_1947', pct: 6.5 },
                { id: 'dwuwiorstowka', pct: 5.7 },
                { id: 'ahp_ziemie_polskie', pct: 2.8 },
                { id: 'ahp_drogi', pct: 2.8 },
                { id: 'ahp_koscielne', pct: 2.8 },
                { id: 'ahp_wlasnosc', pct: 2.8 },
                { id: 'm25k', pct: 2.7 },
                { id: 'tkkp_126k', pct: 2.5 },
                { id: 'kdr', pct: 1.8 }
            ]
        },
        {
            code: 'BY',
            flag: '🇧🇾',
            name: { ro: 'Belarus', en: 'Belarus', pl: 'Białoruś' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'kdwr', pct: 75.4 },
                { id: 'dwuwiorstowka', pct: 62.8 },
                { id: 'wig100k', pct: 55.3 },
                { id: 'kdr_gb', pct: 51.5 },
                { id: 'wig300k', pct: 36.5 },
                { id: 'wig25k', pct: 32.3 },
                { id: 'reymann', pct: 26.8 },
                { id: 'wig500k_1947', pct: 13.6 },
                { id: 'tkkp_126k', pct: 9.1 },
                { id: 'ahp_ziemie_polskie', pct: 7.2 },
                { id: 'ahp_drogi', pct: 7.2 },
                { id: 'ahp_koscielne', pct: 7.2 },
                { id: 'ahp_wlasnosc', pct: 7.2 },
                { id: 'm25k', pct: 4.8 },
                { id: 'kdr', pct: 3.5 },
                { id: 'textor', pct: 2.2 }
            ]
        },
        {
            code: 'LT',
            flag: '🇱🇹',
            name: { ro: 'Lituania', en: 'Lithuania', pl: 'Litwa' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'kdwr', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'dwuwiorstowka', pct: 98.4 },
                { id: 'wig100k', pct: 92.1 },
                { id: 'kdr_gb', pct: 89.5 },
                { id: 'wig300k', pct: 83.4 },
                { id: 'm25k', pct: 74.8 },
                { id: 'kdr', pct: 64.2 },
                { id: 'wig25k', pct: 52.6 },
                { id: 'wig500k_1947', pct: 51.8 },
                { id: 'tkkp_126k', pct: 48.2 },
                { id: 'textor', pct: 46.8 },
                { id: 'reymann', pct: 43.9 },
                { id: 'schroetter', pct: 31.5 },
                { id: 'ahp_ziemie_polskie', pct: 28.6 },
                { id: 'ahp_drogi', pct: 28.6 },
                { id: 'ahp_koscielne', pct: 28.6 },
                { id: 'ahp_wlasnosc', pct: 28.6 }
            ]
        },
        {
            code: 'LV',
            flag: '🇱🇻',
            name: { ro: 'Letonia', en: 'Latvia', pl: 'Łotwa' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'kdwr', pct: 83.1 },
                { id: 'dwuwiorstowka', pct: 12.4 },
                { id: 'wig100k', pct: 11.8 }
            ]
        },
        {
            code: 'CZ',
            flag: '🇨🇿',
            name: { ro: 'Cehia', en: 'Czech Republic', pl: 'Czechy' },
            maps: [
                { id: 'reymann', pct: 100.0 },
                { id: 'kdr', pct: 88.6 },
                { id: 'kdr_gb', pct: 87.2 },
                { id: 'ukvme', pct: 86.4 },
                { id: 'wig100k', pct: 72.1 },
                { id: 'chrzanowski', pct: 68.2 },
                { id: 'wig500k_1947', pct: 62.7 },
                { id: 'm25k', pct: 46.8 },
                { id: 'wig300k', pct: 35.1 }
            ]
        },
        {
            code: 'SK',
            flag: '🇸🇰',
            name: { ro: 'Slovacia', en: 'Slovakia', pl: 'Słowacja' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'kdr_gb', pct: 98.2 },
                { id: 'reymann', pct: 97.6 },
                { id: 'wig100k', pct: 52.4 },
                { id: 'wig500k_1947', pct: 38.5 },
                { id: 'wig300k', pct: 24.3 },
                { id: 'm25k', pct: 11.2 },
                { id: 'kdr', pct: 9.4 }
            ]
        },
        {
            code: 'AT',
            flag: '🇦🇹',
            name: { ro: 'Austria', en: 'Austria', pl: 'Austria' },
            maps: [
                { id: 'kdr', pct: 87.4 },
                { id: 'ukvme', pct: 81.6 },
                { id: 'reymann', pct: 75.8 },
                { id: 'chrzanowski', pct: 38.9 },
                { id: 'kdr_gb', pct: 31.7 }
            ]
        },
        {
            code: 'HU',
            flag: '🇭🇺',
            name: { ro: 'Ungaria', en: 'Hungary', pl: 'Węgry' },
            maps: [
                { id: 'chrzanowski', pct: 84.5 },
                { id: 'ukvme', pct: 83.7 },
                { id: 'reymann', pct: 52.8 },
                { id: 'kdr', pct: 33.2 },
                { id: 'kdr_gb', pct: 9.5 },
                { id: 'wig100k', pct: 8.4 }
            ]
        },
        {
            code: 'RU',
            flag: '🇷🇺',
            name: { ro: 'Rusia / Kaliningrad', en: 'Russia / Kaliningrad', pl: 'Rosja / Kaliningrad' },
            maps: [
                { id: 'wig100k', pct: 100.0 },
                { id: 'wig300k', pct: 100.0 },
                { id: 'tkkp_126k', pct: 100.0 },
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'schroetter', pct: 100.0 },
                { id: 'm25k', pct: 100.0 },
                { id: 'kdr', pct: 100.0 },
                { id: 'kdr_gb', pct: 100.0 },
                { id: 'kdwr', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'reymann', pct: 100.0 },
                { id: 'dwuwiorstowka', pct: 100.0 },
                { id: 'wig25k', pct: 95.3 },
                { id: 'wig500k_1947', pct: 94.6 },
                { id: 'textor', pct: 91.8 },
                { id: 'ahp_ziemie_polskie', pct: 91.2 },
                { id: 'ahp_drogi', pct: 91.2 },
                { id: 'ahp_koscielne', pct: 91.2 },
                { id: 'ahp_wlasnosc', pct: 91.2 }
            ]
        },
        {
            code: 'MD',
            flag: '🇲🇩',
            name: { ro: 'Republica Moldova', en: 'Moldova', pl: 'Mołdawia' },
            maps: [
                { id: 'ukvme', pct: 76.5 },
                { id: 'chrzanowski', pct: 70.7 },
                { id: 'reymann', pct: 40.1 },
                { id: 'wig100k', pct: 21.3 },
                { id: 'kdr_gb', pct: 17.1 }
            ]
        },
        {
            code: 'RO',
            flag: '🇷🇴',
            name: { ro: 'România', en: 'Romania', pl: 'Rumunia' },
            maps: [
                { id: 'ukvme', pct: 26.4 },
                { id: 'chrzanowski', pct: 24.7 },
                { id: 'reymann', pct: 20.2 },
                { id: 'kdr', pct: 1.6 },
                { id: 'kdr_gb', pct: 1.4 },
                { id: 'wig100k', pct: 1.2 }
            ]
        },
        {
            code: 'FR',
            flag: '🇫🇷',
            name: { ro: 'Franța', en: 'France', pl: 'Francja' },
            maps: [
                { id: 'reymann', pct: 13.1 },
                { id: 'kdr', pct: 9.4 }
            ]
        },
        {
            code: 'BE-LU',
            flag: '🇧🇪',
            name: { ro: 'Belgia & Luxemburg', en: 'Belgium & Luxembourg', pl: 'Belgia i Luksemburg' },
            maps: [
                { id: 'reymann', pct: 33.1 },
                { id: 'kdr', pct: 17.4 }
            ]
        },
        {
            code: 'NL',
            flag: '🇳🇱',
            name: { ro: 'Țările de Jos', en: 'Netherlands', pl: 'Holandia' },
            maps: [
                { id: 'reymann', pct: 52.2 },
                { id: 'kdr', pct: 36.0 }
            ]
        },
        {
            code: 'DK',
            flag: '🇩🇰',
            name: { ro: 'Danemarca', en: 'Denmark', pl: 'Dania' },
            maps: [
                { id: 'kdr', pct: 52.7 },
                { id: 'reymann', pct: 50.8 },
                { id: 'chrzanowski', pct: 14.0 },
                { id: 'ukvme', pct: 8.0 }
            ]
        },
        {
            code: 'EE',
            flag: '🇪🇪',
            name: { ro: 'Estonia', en: 'Estonia', pl: 'Estonia' },
            maps: [
                { id: 'ukvme', pct: 86.8 },
                { id: 'kdwr', pct: 11.3 },
                { id: 'chrzanowski', pct: 10.3 }
            ]
        },
        {
            code: 'CH',
            flag: '🇨🇭',
            name: { ro: 'Elveția', en: 'Switzerland', pl: 'Szwajcaria' },
            maps: [
                { id: 'reymann', pct: 52.2 },
                { id: 'kdr', pct: 20.6 }
            ]
        }
    ];

    // ── Instanțe de straturi Leaflet ──
    // Hărțile CENAGIS care au deja un rând premium dedicat în index.html
    // folosesc acel rând, nu sunt duplicate în catalogul de mai jos.
    var SHARED_PREMIUM_MAP_KEYS = {
        ukvme: true, chrzanowski: true, reymann: true,
        kdr: true, kdr_gb: true, wig100k: true, kummersberg: true
    };
    var _leafletLayers = Object.create(null);
    var _leafletOpacity = Object.create(null);
    var _activeMap = null;
    var _selectedCountryCode = null;
    var _selectedCountryBounds = null;
    var _availableMapCount = 0;

    function getLang() {
        try {
            var docLang = document.documentElement && document.documentElement.lang;
            if (docLang === 'en' || docLang === 'ro' || docLang === 'pl') return docLang;
            var stored = root.localStorage && root.localStorage.getItem('detectlab_lang');
            if (stored === 'en' || stored === 'ro' || stored === 'pl') return stored;
            if (root.DetectLabSite && root.DetectLabSite.defaultLanguage) return root.DetectLabSite.defaultLanguage;
        } catch (e) {}
        return 'ro';
    }

    function getMapInstance() {
        return _activeMap || root._dlMap || root.map || null;
    }

    function normalizeBounds(bounds) {
        if (!bounds) return null;
        if (Array.isArray(bounds)) {
            if (bounds.length === 4 && bounds.every(function (v) { return isFinite(Number(v)); })) {
                return [Number(bounds[0]), Number(bounds[1]), Number(bounds[2]), Number(bounds[3])];
            }
            if (bounds.length >= 2 && Array.isArray(bounds[0]) && Array.isArray(bounds[1])) {
                // Leaflet lat/lng corner pairs: [[south, west], [north, east]].
                return [
                    Math.min(Number(bounds[0][1]), Number(bounds[1][1])),
                    Math.min(Number(bounds[0][0]), Number(bounds[1][0])),
                    Math.max(Number(bounds[0][1]), Number(bounds[1][1])),
                    Math.max(Number(bounds[0][0]), Number(bounds[1][0]))
                ];
            }
        }
        if (typeof bounds === 'object') {
            var west = typeof bounds.getWest === 'function' ? bounds.getWest() : bounds.west;
            var south = typeof bounds.getSouth === 'function' ? bounds.getSouth() : bounds.south;
            var east = typeof bounds.getEast === 'function' ? bounds.getEast() : bounds.east;
            var north = typeof bounds.getNorth === 'function' ? bounds.getNorth() : bounds.north;
            if ([west, south, east, north].every(function (v) { return isFinite(Number(v)); })) {
                return [Number(west), Number(south), Number(east), Number(north)];
            }
        }
        return null;
    }

    function mapBoundsArray(mapMeta) {
        var b = mapMeta && mapMeta.bounds;
        if (!Array.isArray(b) || b.length < 2 || !Array.isArray(b[0]) || !Array.isArray(b[1])) return null;
        // Catalog coordinates use [[south, west], [north, east]].
        return [Number(b[0][1]), Number(b[0][0]), Number(b[1][1]), Number(b[1][0])];
    }

    function boundsOverlap(a, b) {
        return !!(a && b && b[2] >= a[0] && b[0] <= a[2] && b[3] >= a[1] && b[1] <= a[3]);
    }

    function boxArea(b) {
        return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    }

    function overlapAreaBoxes(a, b) {
        var w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        var h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        return (w > 0 && h > 0) ? w * h : 0;
    }

    // Rectangle intersection alone lets neighbouring countries' sheets leak
    // into the window where catalog extents merely graze the country's bbox
    // (a Polish WIG box clipping Denmark's bbox has ZERO data for Denmark).
    // For countries outside the curated analysis demand a substantial
    // overlap: at least 5% of the country's box OR at least 5% of the sheet.
    function substantialCountryCoverage(countryB, extentB) {
        if (!countryB || !extentB) return false;
        var o = overlapAreaBoxes(countryB, extentB);
        if (!(o > 0)) return false;
        return o >= 0.05 * boxArea(countryB) || o >= 0.05 * boxArea(extentB);
    }

    function isSharedPremiumMap(mapKey) {
        return !!SHARED_PREMIUM_MAP_KEYS[mapKey];
    }

    function getMapsOverlappingBounds(bounds, includeShared) {
        var countryBounds = normalizeBounds(bounds);
        return Object.keys(MAPS_CATALOG).filter(function (mapKey) {
            if (!includeShared && isSharedPremiumMap(mapKey)) return false;
            var extent = mapBoundsArray(MAPS_CATALOG[mapKey]);
            return !countryBounds || boundsOverlap(countryBounds, extent);
        }).map(function (mapKey) { return mapKey; });
    }

    function findCountry(countryCode) {
        var code = String(countryCode || '').toUpperCase();
        return COUNTRIES_DATA.find(function (country) {
            return country.code === code || (country.code === 'BE-LU' && (code === 'BE' || code === 'LU'));
        }) || null;
    }

    function createLeafletLayer(mapKey) {
        if (_leafletLayers[mapKey]) return _leafletLayers[mapKey];
        var mapMeta = MAPS_CATALOG[mapKey];
        if (!mapMeta) return null;

        var paneName = 'pane_cenagis_' + mapKey;
        var mapInst = getMapInstance();
        if (mapInst && typeof mapInst.createPane === 'function' && !mapInst.getPane(paneName)) {
            mapInst.createPane(paneName);
            var pane = mapInst.getPane(paneName);
            if (pane) {
                pane.style.zIndex = 635;
                pane.style.pointerEvents = 'none';
            }
        }

        /* LAYERS / FORMAT / TRANSPARENT / VERSION come from the shared registry
         * entry (`cenagis.<key>`), which is the same object the 3D view builds
         * its raster source from. Only the view wiring (pane, bounds, live
         * opacity) is local. The workspace prefix must be `ihpan`, not the
         * stock GeoServer `topp`: the registry holds the qualified name. */
        var options = REGISTRY.wms2dOptions('cenagis.' + mapKey, {
            crs: L.CRS.EPSG3857,
            pane: paneName,
            opacity: _leafletOpacity[mapKey] == null ? 0.80 : _leafletOpacity[mapKey]
        });
        // Ask the WMS for pixels only where the map sheet has a footprint.
        if (mapMeta.bounds && typeof L.latLngBounds === 'function') {
            options.bounds = L.latLngBounds(mapMeta.bounds);
        }

        var layer = L.tileLayer.wms(WMS_BASE_URL, options);
        // For the WMS health guard (js/wms-health.js): which row + switch this
        // layer belongs to (.cenagis-map-row[data-map-id] / .cenagis-toggle),
        // and the title to name it in the “server is down” notice.
        layer._detectlabUiKeys = [mapKey];
        var lang = getLang();
        layer._detectlabUiTitle = mapMeta.title[lang] || mapMeta.title.en || mapMeta.title.ro || mapKey;
        _leafletLayers[mapKey] = layer;
        return layer;
    }

    function toggleCenagisLayer(mapKey, on) {
        var mapInst = getMapInstance();
        if (!mapInst) return;
        var layer = createLeafletLayer(mapKey);
        if (!layer) return;

        if (on) {
            var masterToggle = document.getElementById('histPremiumToggle');
            if (masterToggle && !masterToggle.checked) masterToggle.checked = true;
            if (!mapInst.hasLayer(layer)) layer.addTo(mapInst);
        } else if (mapInst.hasLayer(layer)) {
            mapInst.removeLayer(layer);
        }

        // There is one checkbox per catalog map; this also remains safe if a
        // future country view renders the same map in more than one section.
        var checkboxes = document.querySelectorAll('.cenagis-toggle[data-map-key="' + mapKey + '"]');
        checkboxes.forEach(function (cb) {
            if (cb.checked !== on) cb.checked = on;
        });

        if (typeof root.updatePremiumMapCoverageVisibility === 'function') {
            root.updatePremiumMapCoverageVisibility();
        }
    }

    function setCenagisLayerOpacity(mapKey, val) {
        var layer = createLeafletLayer(mapKey);
        var opacity = val / 100;
        _leafletOpacity[mapKey] = opacity;
        if (layer && typeof layer.setOpacity === 'function') layer.setOpacity(opacity);

        var sliders = document.querySelectorAll('.cenagis-opacity-slider[data-map-key="' + mapKey + '"]');
        sliders.forEach(function (slider) {
            if (slider.value !== String(val)) slider.value = String(val);
        });
        var pctLabels = document.querySelectorAll('.cenagis-pct[data-map-key="' + mapKey + '"]');
        pctLabels.forEach(function (label) { label.textContent = val + '%'; });
    }

    // The old European-only master switch is now an alias for the combined
    // Historical Maps group. Turning that parent OFF clears these WMS layers.
    function toggleHistEuLayer(on) {
        var masterToggle = document.getElementById('histPremiumToggle');
        if (on) {
            if (masterToggle) masterToggle.checked = true;
            return;
        }
        var mapInst = getMapInstance();
        Object.keys(_leafletLayers).forEach(function (key) {
            var layer = _leafletLayers[key];
            if (mapInst && layer && mapInst.hasLayer(layer)) mapInst.removeLayer(layer);
        });
        document.querySelectorAll('.cenagis-toggle').forEach(function (cb) { cb.checked = false; });
    }

    function filterForCountry(countryCode, bounds) {
        var code = countryCode && String(countryCode).toUpperCase() !== 'ALL'
            ? String(countryCode).toUpperCase() : null;
        var normalizedBounds = normalizeBounds(bounds);
        if (!normalizedBounds && code && root._detectlabSelectedCountry === code) {
            normalizedBounds = normalizeBounds(root._detectlabCountryBounds);
        }

        _selectedCountryCode = code;
        _selectedCountryBounds = normalizedBounds;

        var availableIds;
        var country = code ? findCountry(code) : null;
        if (!code) {
            availableIds = getMapsOverlappingBounds(null, false);
        } else if (country) {
            // The curated coverage list (COUNTRIES_DATA, pct > 0) is the
            // source of truth for the analyzed countries: rectangle overlap
            // alone leaks neighbouring countries' sheets into the window —
            // a Polish WIG sheet whose box clips Denmark's bbox is not a map
            // of Denmark. Shared premium sheets are hosted on their premium
            // rows in index.html and are not duplicated in this catalog.
            availableIds = country.maps.map(function (entry) { return entry.id; })
                .filter(function (id) { return !isSharedPremiumMap(id); });
        } else if (normalizedBounds) {
            // Country outside the curated analysis (Italy, Norway…): fall
            // back to the sheets' own extents, but only where the sheet
            // substantially covers the country — a box that merely grazes
            // the country's bbox is not a map of this country.
            availableIds = getMapsOverlappingBounds(normalizedBounds, false).filter(function (id) {
                return substantialCountryCoverage(normalizedBounds, mapBoundsArray(MAPS_CATALOG[id]));
            });
        } else {
            // An unknown ISO without geometry must not accidentally see the
            // whole catalog.
            availableIds = [];
        }

        var available = Object.create(null);
        availableIds.forEach(function (id) { available[id] = true; });
        var rows = document.querySelectorAll('.cenagis-map-row');
        var rowCount = 0;
        rows.forEach(function (row) {
            var id = row.getAttribute('data-map-id');
            var isAvailable = !code || !!available[id];
            row.classList.toggle('country-layer-unavailable', !isAvailable);
            row.setAttribute('aria-hidden', isAvailable ? 'false' : 'true');
            row.style.display = isAvailable ? '' : 'none';
            if (isAvailable) rowCount++;
        });
        _availableMapCount = rowCount;

        var section = document.getElementById('histEuMapsSection');
        if (section) {
            // Keep the country-filter hint visible even when this country has
            // no CENAGIS rows; the matching legacy premium sheets (if any)
            // still live alongside them in the same accordion.
            section.classList.remove('country-layer-unavailable');
            section.setAttribute('aria-hidden', 'false');
        }
        var empty = document.getElementById('cenagisNoMaps');
        if (empty) empty.style.display = code && rowCount === 0 ? 'block' : 'none';
        var status = document.getElementById('histEuFilterStatus');
        if (status) {
            var country = code ? findCountry(code) : null;
            var name = country && (country.name[getLang()] || country.name.en || country.name.ro);
            if (!name && code && root._detectlabSelectedCountryName) name = root._detectlabSelectedCountryName;
            if (!name) name = code || (getLang() === 'ro' ? 'toate țările' : 'all countries');
            status.textContent = code
                ? (getLang() === 'ro'
                    ? rowCount + ' hărți cu acoperire parțială sau totală pentru ' + name + '.'
                    : rowCount + ' maps overlap ' + name + ' partially or completely.')
                : (getLang() === 'ro'
                    ? 'Selectează o țară pe glob pentru a vedea hărțile care o intersectează.'
                    : 'Choose a country on the globe to see maps that overlap it.');
        }
        return rowCount;
    }

    function filterCountry(countryCode) {
        return filterForCountry(countryCode, null);
    }

    function hasAvailableMaps() {
        return _availableMapCount > 0;
    }

    function showMapInfo(mapKey) {
        var meta = MAPS_CATALOG[mapKey];
        if (!meta) return;
        var lang = getLang();
        var title = meta.title[lang] || meta.title.en || meta.title.ro;
        var desc = (lang === 'ro')
            ? ('Scară: ' + meta.scale + '\nPerioadă / Ani: ' + meta.years + '\nSursă / Institut: ' + meta.provider + '\nEndpoint: ' + WMS_BASE_URL + '\nStrat WMS: ihpan:' + meta.wms_layer)
            : ('Scale: ' + meta.scale + '\nPeriod / Years: ' + meta.years + '\nSource / Institute: ' + meta.provider + '\nEndpoint: ' + WMS_BASE_URL + '\nWMS Layer: ihpan:' + meta.wms_layer);

        if (typeof root.showLayerInfo === 'function') {
            root.showLayerInfo(title, desc);
        } else {
            alert(title + '\n\n' + desc);
        }
    }

    // ── Generare a catalogului plat în interiorul grupului premium unic ──
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function renderUi() {
        var container = document.getElementById('histEuMapsSection');
        if (!container) return;

        var lang = getLang();
        var mapKeys = Object.keys(MAPS_CATALOG).filter(function (key) {
            return !isSharedPremiumMap(key);
        });
        mapKeys.sort(function (a, b) {
            var aTitle = MAPS_CATALOG[a].title[lang] || MAPS_CATALOG[a].title.en || MAPS_CATALOG[a].title.ro;
            var bTitle = MAPS_CATALOG[b].title[lang] || MAPS_CATALOG[b].title.en || MAPS_CATALOG[b].title.ro;
            return aTitle.localeCompare(bTitle, lang);
        });

        // These sheets are listed flat inside the single “Historical Maps”
        // group — there is no “European maps · CENAGIS / IH PAN” subcategory
        // heading (nor any replacement one) above them.
        var emptyText = (lang === 'ro') ? 'Nu există alte hărți CENAGIS pentru țara selectată.' : 'No other CENAGIS maps cover the selected country.';
        var html = [];
        html.push('<div id="histEuFilterStatus" aria-live="polite" style="font-size:0.66rem;color:rgba(245,240,235,0.55);line-height:1.35;">' + (lang === 'ro' ? 'Selectează o țară pe glob pentru a vedea hărțile care o intersectează.' : 'Choose a country on the globe to see maps that overlap it.') + '</div>');
        html.push('<div id="cenagisNoMaps" style="display:none;font-size:0.68rem;color:rgba(245,240,235,0.55);">' + emptyText + '</div>');
        html.push('<div class="cenagis-map-list" style="display:flex;flex-direction:column;gap:7px;">');

        mapKeys.forEach(function (mapKey) {
            var mapMeta = MAPS_CATALOG[mapKey];
            var title = mapMeta.title[lang] || mapMeta.title.en || mapMeta.title.ro;
            var safeKey = mapKey.replace(/[^a-z0-9_-]/gi, '_');
            var activeMap = getMapInstance();
            var leafletLayer = _leafletLayers[mapKey];
            var isOnMap = !!(activeMap && leafletLayer && activeMap.hasLayer && activeMap.hasLayer(leafletLayer));
            var opacityPercent = Math.round((_leafletOpacity[mapKey] == null ? 0.80 : _leafletOpacity[mapKey]) * 100);
            html.push('<div id="cenagisMapRow_' + safeKey + '" class="cenagis-map-row hist-eu-map-row" data-map-id="' + escapeHtml(mapKey) + '" style="background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.06);border-radius:5px;padding:6px;">');
            html.push('  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:4px;">');
            html.push('    <div style="min-width:0;flex:1;">');
            html.push('      <div style="font-size:0.74rem;color:#f5f0eb;font-weight:500;line-height:1.25;word-break:break-word;">' + escapeHtml(title) + '</div>');
            html.push('      <div style="font-size:0.62rem;color:rgba(245,240,235,0.6);margin-top:2px;">' + escapeHtml(mapMeta.scale) + ' · ' + escapeHtml(mapMeta.years) + '</div>');
            html.push('    </div>');
            html.push('    <label class="apm-toggle-switch" style="transform:scale(0.8);transform-origin:right top;flex-shrink:0;" title="Toggle ' + escapeHtml(title) + '">');
            html.push('      <input type="checkbox" class="cenagis-toggle" data-map-key="' + escapeHtml(mapKey) + '"' + (isOnMap ? ' checked' : '') + ' onchange="DetectLabEuMaps.toggleCenagisLayer(\'' + escapeHtml(mapKey) + '\', this.checked)">');
            html.push('      <span class="apm-toggle-track"></span>');
            html.push('    </label>');
            html.push('  </div>');
            html.push('  <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">');
            html.push('    <span style="font-size:0.66rem;color:rgba(245,240,235,0.45);">Opacity</span>');
            html.push('    <input type="range" class="transp-slider cenagis-opacity-slider" data-map-key="' + escapeHtml(mapKey) + '" min="0" max="100" value="' + opacityPercent + '" style="flex:1;height:4px;margin:0 4px;" oninput="DetectLabEuMaps.setCenagisLayerOpacity(\'' + escapeHtml(mapKey) + '\', this.value)">');
            html.push('    <span style="display:flex;align-items:center;gap:4px;">');
            html.push('      <span class="pct cenagis-pct" data-map-key="' + escapeHtml(mapKey) + '" style="font-size:0.66rem;color:rgba(245,240,235,0.7);min-width:24px;text-align:right;">' + opacityPercent + '%</span>');
            html.push('      <button type="button" class="layer-info-btn" onclick="event.stopPropagation();DetectLabEuMaps.showMapInfo(\'' + escapeHtml(mapKey) + '\')" title="Layer info" style="background:none;border:none;cursor:pointer;color:rgba(200,169,110,0.8);padding:1px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor"/><rect x="10.8" y="10.5" width="2.4" height="7" rx="1.2" fill="currentColor"/></svg></button>');
            html.push('    </span>');
            html.push('  </div>');
            html.push('</div>');
        });
        html.push('</div>');

        container.innerHTML = html.join('\n');
        filterForCountry(_selectedCountryCode, _selectedCountryBounds);
    }

    // ── Export public ──
    var DetectLabEuMaps = {
        catalog: MAPS_CATALOG,
        countries: COUNTRIES_DATA,
        sharedPremiumMapKeys: SHARED_PREMIUM_MAP_KEYS,
        toggleCenagisLayer: toggleCenagisLayer,
        setCenagisLayerOpacity: setCenagisLayerOpacity,
        toggleHistEuLayer: toggleHistEuLayer,
        filterCountry: filterCountry,
        filterForCountry: filterForCountry,
        getMapsOverlappingBounds: getMapsOverlappingBounds,
        hasAvailableMaps: hasAvailableMaps,
        showMapInfo: showMapInfo,
        renderUi: renderUi,
        init: function (leafletMap) {
            if (leafletMap) _activeMap = leafletMap;
            if (root._detectlabSelectedCountry) {
                filterForCountry(root._detectlabSelectedCountry, root._detectlabCountryBounds);
            }
            renderUi();
            // map-app.js may have run the first country filter before this
            // catalog script finished rendering its dynamic map rows. Re-run
            // once so the combined parent group is evaluated with real matches.
            if (root._detectlabSelectedCountry && typeof root.filterLayersForCountry === 'function') {
                root.filterLayersForCountry(root._detectlabSelectedCountry);
            }
            document.addEventListener('detectlab:langchange', function () {
                renderUi();
            });
        }
    };

    root.DetectLabEuMaps = DetectLabEuMaps;
    // Compatibility alias for existing integrations; there is no longer a
    // second European Historical Maps parent group in the layer panel.
    root.toggleHistEuLayer = toggleHistEuLayer;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            DetectLabEuMaps.init();
        });
    } else {
        DetectLabEuMaps.init();
    }

}(window));
