/*
 * DetectLab — optional ArcGIS SceneView renderer for the country gate.
 *
 * This file is local and lightweight. The ArcGIS Maps SDK itself (4.31) and
 * its theme are requested only when the gate opens. The existing canvas gate
 * remains owned by globe-country-picker.js and is the network/WebGL fallback.
 * The renderer receives the same atlas / Natural Earth geometry that the
 * canvas gate builds; it never owns selection persistence or the Leaflet map.
 */
(function (window, document) {
    'use strict';
    if (!window || !document) return;

    var SDK_ROOT = 'https://js.arcgis.com/4.31/';
    var SDK_CSS = SDK_ROOT + 'esri/themes/dark/main.css';
    var SDK_TIMEOUT_MS = 18000;
    var VIEW_TIMEOUT_MS = 18000;
    var WORLD_IMAGERY_SERVICE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
    var KEYED_WORLD_IMAGERY_SERVICE = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer';
    var BACKGROUND = '#030916';
    var NEON = [57, 255, 20];
    var VIOLET = [107, 95, 130];
    var TEXT_COLOR = [234, 255, 221];
    var ATTRIBUTION = 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community';
    var MICRO_ISO = { AD: true, LI: true, LU: true, MC: true, MT: true, SM: true, VA: true };

    var sdkPromise = null;
    var cssPromise = null;
    var current = null;
    var generation = 0;

    function rejectAfter(promise, ms, message) {
        var timer;
        return Promise.race([
            Promise.resolve(promise),
            new Promise(function (_, reject) {
                timer = window.setTimeout(function () { reject(new Error(message)); }, ms);
            })
        ]).then(function (value) {
            window.clearTimeout(timer);
            return value;
        }, function (error) {
            window.clearTimeout(timer);
            throw error;
        });
    }

    function loadTheme() {
        if (cssPromise) return cssPromise;
        cssPromise = new Promise(function (resolve, reject) {
            var existing = document.getElementById('detectlabArcGisTheme');
            if (existing && existing.sheet) { resolve(); return; }
            var link = existing || document.createElement('link');
            var timer;
            link.id = 'detectlabArcGisTheme';
            link.rel = 'stylesheet';
            link.href = SDK_CSS;
            link.onload = function () { window.clearTimeout(timer); resolve(); };
            link.onerror = function () {
                window.clearTimeout(timer);
                cssPromise = null;
                try { if (link.parentNode) link.parentNode.removeChild(link); } catch (e) {}
                reject(new Error('ArcGIS theme could not be loaded'));
            };
            timer = window.setTimeout(function () {
                cssPromise = null;
                try { if (link.parentNode) link.parentNode.removeChild(link); } catch (e) {}
                reject(new Error('Timed out loading ArcGIS theme'));
            }, SDK_TIMEOUT_MS);
            if (!existing) (document.head || document.documentElement).appendChild(link);
        });
        return cssPromise;
    }

    function arcgisRequire() {
        return window.require && typeof window.require === 'function' ? window.require : null;
    }

    function loadModules() {
        var req = arcgisRequire();
        if (!req) return Promise.reject(new Error('ArcGIS AMD loader is unavailable'));
        return new Promise(function (resolve, reject) {
            try {
                req([
                    'esri/config',
                    'esri/Map',
                    'esri/Basemap',
                    'esri/views/SceneView',
                    'esri/layers/TileLayer',
                    'esri/layers/GraphicsLayer',
                    'esri/Graphic',
                    'esri/geometry/Polygon',
                    'esri/geometry/Point'
                ], function (esriConfig, Map, Basemap, SceneView, TileLayer, GraphicsLayer, Graphic, Polygon, Point) {
                    resolve({
                        esriConfig: esriConfig,
                        Map: Map,
                        Basemap: Basemap,
                        SceneView: SceneView,
                        TileLayer: TileLayer,
                        GraphicsLayer: GraphicsLayer,
                        Graphic: Graphic,
                        Polygon: Polygon,
                        Point: Point
                    });
                }, reject);
            } catch (error) { reject(error); }
        });
    }

    function loadSdkScript() {
        if (sdkPromise) return sdkPromise;
        sdkPromise = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            var timer = window.setTimeout(function () {
                sdkPromise = null;
                reject(new Error('Timed out loading ArcGIS Maps SDK 4.31'));
            }, SDK_TIMEOUT_MS);
            script.src = SDK_ROOT;
            script.async = true;
            script.onload = function () {
                loadModules().then(function (modules) {
                    window.clearTimeout(timer);
                    resolve(modules);
                }, function (error) {
                    window.clearTimeout(timer);
                    sdkPromise = null;
                    reject(error);
                });
            };
            script.onerror = function () {
                window.clearTimeout(timer);
                sdkPromise = null;
                reject(new Error('ArcGIS Maps SDK 4.31 could not be loaded'));
            };
            (document.head || document.documentElement).appendChild(script);
        });
        return sdkPromise;
    }

    function loadSdk() {
        return loadTheme().then(function () {
            // If another page feature already loaded the 4.x AMD runtime, reuse
            // it. In this app no ArcGIS SDK is loaded before the gate is opened.
            if (arcgisRequire()) {
                return rejectAfter(loadModules(), SDK_TIMEOUT_MS, 'Timed out loading ArcGIS modules');
            }
            return loadSdkScript();
        });
    }

    function getApiKey() {
        try {
            return String(window.DETECTLAB_ARCGIS_API_KEY ||
                (window.DetectLabConfig && window.DetectLabConfig.arcgisApiKey) || '').trim();
        } catch (e) { return ''; }
    }

    function signedArea(ring) {
        var area = 0;
        for (var i = 0; i < ring.length - 1; i++) {
            area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        return area / 2;
    }

    // Esri Polygon rings use clockwise exteriors and counter-clockwise holes.
    // The picker geometry is GeoJSON-like, so normalize ring winding on the
    // client without changing the source feature used by the canvas fallback.
    function orientRing(source, clockwise) {
        if (!Array.isArray(source) || source.length < 3) return null;
        var ring = source.map(function (point) { return [Number(point[0]), Number(point[1])]; });
        var first = ring[0];
        var last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
        var area = signedArea(ring);
        if (!area || !isFinite(area)) return ring;
        var isClockwise = area < 0;
        if (isClockwise !== !!clockwise) {
            var open = ring.slice(0, -1).reverse();
            open.push([open[0][0], open[0][1]]);
            ring = open;
        }
        return ring;
    }

    function geometryRings(feature) {
        var geometry = feature && feature.geometry;
        if (!geometry) return [];
        var polygons = geometry.type === 'Polygon' ? [geometry.coordinates] :
            geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        var rings = [];
        polygons.forEach(function (polygon) {
            if (!Array.isArray(polygon)) return;
            polygon.forEach(function (ring, index) {
                var oriented = orientRing(ring, index === 0);
                if (oriented) rings.push(oriented);
            });
        });
        return rings;
    }

    function makeCountryGeometry(modules, entry) {
        var rings = geometryRings(entry && entry.feature);
        if (!rings.length) return null;
        try { return new modules.Polygon({ rings: rings, spatialReference: { wkid: 4326 } }); }
        catch (e) { return null; }
    }

    function isMicroState(entry) {
        return !!(entry && (MICRO_ISO[entry.iso] || (Number(entry.size) > 0 && Number(entry.size) < 0.45)));
    }

    function transparentOutline(color, width) {
        return {
            type: 'simple-fill',
            color: [0, 0, 0, 0],
            outline: { color: color, width: width }
        };
    }

    function filledCountry(color, alpha, outlineColor, outlineWidth) {
        return {
            type: 'simple-fill',
            color: [color[0], color[1], color[2], alpha],
            outline: { color: outlineColor, width: outlineWidth }
        };
    }

    function makeLayer(modules, id) {
        return new modules.GraphicsLayer({ id: id, listMode: 'hide', title: 'DetectLab country selection' });
    }

    function makeLayers(modules) {
        return {
            casing: makeLayer(modules, 'detectlab-country-casing'),
            countries: makeLayer(modules, 'detectlab-country-polygons'),
            micro: makeLayer(modules, 'detectlab-country-microstates'),
            focusCasing: makeLayer(modules, 'detectlab-country-focus-casing'),
            focus: makeLayer(modules, 'detectlab-country-focus'),
            microFocusCasing: makeLayer(modules, 'detectlab-country-micro-focus-casing'),
            microFocus: makeLayer(modules, 'detectlab-country-micro-focus'),
            labels: makeLayer(modules, 'detectlab-country-labels')
        };
    }

    function attrs(entry) {
        return { detectlabCountryISO: entry.iso, detectlabCountryName: entry.name || entry.iso };
    }

    function graphic(modules, geometry, symbol, entry) {
        return new modules.Graphic({ geometry: geometry, symbol: symbol, attributes: attrs(entry) });
    }

    function pointFor(modules, entry) {
        return new modules.Point({
            longitude: Number(entry.lng),
            latitude: Number(entry.lat),
            spatialReference: { wkid: 4326 }
        });
    }

    function clearLayers(layers) {
        Object.keys(layers).forEach(function (key) {
            if (layers[key] && typeof layers[key].removeAll === 'function') layers[key].removeAll();
        });
    }

    function localizedName(entry, hooks) {
        if (hooks && typeof hooks.nameOf === 'function') {
            try { return hooks.nameOf(entry.iso) || entry.name || entry.iso; } catch (e) {}
        }
        return entry.name || entry.iso;
    }

    function drawCountries(instance, countries) {
        clearLayers(instance.layers);
        instance.entries = {};
        (countries || []).forEach(function (entry) {
            if (!entry || !entry.iso || !entry.feature) return;
            var geometry = makeCountryGeometry(instance.modules, entry);
            if (!geometry) return;
            var entryCopy = entry;
            instance.entries[entry.iso] = { entry: entryCopy, geometry: geometry, micro: isMicroState(entryCopy) };
            var info = attrs(entryCopy);
            instance.layers.casing.add(new instance.modules.Graphic({
                geometry: geometry,
                symbol: transparentOutline([255, 255, 255, 0.65], 1.35), // 1.8 px × 0.75 pt/px
                attributes: info
            }));
            instance.layers.countries.add(new instance.modules.Graphic({
                geometry: geometry,
                symbol: filledCountry(VIOLET, 0.34, [0, 0, 0, 0.95], 0.675), // 0.9 px × 0.75 pt/px
                attributes: info
            }));
            if (instance.entries[entry.iso].micro) {
                instance.layers.micro.add(new instance.modules.Graphic({
                    geometry: pointFor(instance.modules, entryCopy),
                    symbol: {
                        type: 'simple-marker', style: 'circle', size: 5.25, // 7 px × 0.75 pt/px
                        color: [VIOLET[0], VIOLET[1], VIOLET[2], 0.34],
                        outline: { color: [255, 255, 255, 0.65], width: 1.35 }
                    },
                    attributes: info
                }));
            }
        });
        drawFocus(instance);
    }

    function countryCenter(entry) {
        var bbox = entry && entry.bboxEU;
        if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(function (value) { return isFinite(Number(value)); })) {
            return [(Number(bbox[0]) + Number(bbox[2])) / 2, (Number(bbox[1]) + Number(bbox[3])) / 2];
        }
        return [Number(entry && entry.lng) || 14, Number(entry && entry.lat) || 40];
    }

    function nameAnchor(instance, entry) {
        // The full Russia display geometry is in Asia, but its app selection is
        // deliberately the European bbox. Anchor its label there too.
        if (entry.iso === 'RU') return countryCenter(entry);
        return [Number(entry.lng), Number(entry.lat)];
    }

    function drawFocus(instance) {
        if (!instance || !instance.layers) return;
        instance.layers.focusCasing.removeAll();
        instance.layers.focus.removeAll();
        instance.layers.microFocusCasing.removeAll();
        instance.layers.microFocus.removeAll();
        instance.layers.labels.removeAll();

        var iso = instance.hoveredIso || instance.selectedIso;
        if (!iso || !instance.entries[iso]) return;
        var info = instance.entries[iso];
        var entry = info.entry;
        var isHover = !!instance.hoveredIso;
        var casingWidth = isHover ? 3.375 : 3.75; // 4.5 / 5 px × 0.75 pt/px
        var edgeWidth = isHover ? 1.5 : 1.8;       // 2 / 2.4 px × 0.75 pt/px
        var alpha = isHover ? 0.42 : 0.50;
        var outline = [NEON[0], NEON[1], NEON[2], 1];
        var blackCasing = [0, 0, 0, 0.60];
        var attrsForCountry = attrs(entry);
        instance.layers.focusCasing.add(new instance.modules.Graphic({
            geometry: info.geometry,
            symbol: transparentOutline(blackCasing, casingWidth),
            attributes: attrsForCountry
        }));
        instance.layers.focus.add(new instance.modules.Graphic({
            geometry: info.geometry,
            symbol: filledCountry(NEON, alpha, outline, edgeWidth),
            attributes: attrsForCountry
        }));

        var anchor = nameAnchor(instance, entry);
        var point = new instance.modules.Point({ longitude: anchor[0], latitude: anchor[1], spatialReference: { wkid: 4326 } });
        var label = localizedName(entry, instance.hooks);
        instance.layers.labels.add(new instance.modules.Graphic({
            geometry: point,
            symbol: {
                type: 'text',
                text: label,
                color: TEXT_COLOR,
                haloColor: [0, 0, 0, 0.90],
                haloSize: 3, // 4 px canvas label casing × 0.75 pt/px
                font: { family: 'system-ui', size: 9, weight: '600' }, // 12 px canvas label × 0.75 pt/px
                horizontalAlignment: 'center',
                verticalAlignment: 'middle'
            },
            attributes: attrsForCountry
        }));

        if (info.micro) {
            var microPoint = pointFor(instance.modules, entry);
            var markerSize = 13.5; // 18 px canvas ring diameter × 0.75 pt/px
            instance.layers.microFocusCasing.add(new instance.modules.Graphic({
                geometry: microPoint,
                symbol: {
                    type: 'simple-marker', style: 'circle', size: markerSize,
                    color: [0, 0, 0, 0],
                    outline: { color: blackCasing, width: casingWidth }
                },
                attributes: attrsForCountry
            }));
            instance.layers.microFocus.add(new instance.modules.Graphic({
                geometry: microPoint,
                symbol: {
                    type: 'simple-marker', style: 'circle', size: markerSize,
                    color: [0, 0, 0, 0],
                    outline: { color: outline, width: isHover ? 1.5 : 1.875 }
                },
                attributes: attrsForCountry
            }));
        }
    }

    function angularDistanceDegrees(lonA, latA, lonB, latB) {
        var rad = Math.PI / 180;
        var la1 = latA * rad, la2 = latB * rad;
        var dLat = (latB - latA) * rad, dLon = (lonB - lonA) * rad;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) / rad;
    }

    function visibleAtViewCenter(instance, entry) {
        var center = instance.view && instance.view.center;
        if (!center) return true;
        var lon = (typeof center.longitude === 'number') ? center.longitude : center.x;
        var lat = (typeof center.latitude === 'number') ? center.latitude : center.y;
        if (!isFinite(lon) || !isFinite(lat)) return true;
        var anchor = nameAnchor(instance, entry);
        return angularDistanceDegrees(lon, lat, anchor[0], anchor[1]) <= 91;
    }

    // Polygon hit-testing can miss a micro-state whose border is under a
    // screen pixel. Snap to its visible centre within 12 CSS pixels instead.
    function nearestMicro(instance, event) {
        if (!instance || !instance.view || !event) return null;
        var x = Number(event.x), y = Number(event.y);
        if (!isFinite(x) || !isFinite(y)) return null;
        var closest = null, distance = 12;
        Object.keys(instance.entries).forEach(function (iso) {
            var info = instance.entries[iso];
            if (!info.micro || !visibleAtViewCenter(instance, info.entry)) return;
            var screen;
            try { screen = instance.view.toScreen(pointFor(instance.modules, info.entry)); } catch (e) { return; }
            if (!screen || !isFinite(screen.x) || !isFinite(screen.y)) return;
            var d = Math.hypot(screen.x - x, screen.y - y);
            if (d <= distance) { distance = d; closest = info.entry; }
        });
        return closest;
    }

    function hitCountry(instance, response, event) {
        var results = response && response.results || [];
        for (var i = 0; i < results.length; i++) {
            var graphicResult = results[i] && results[i].graphic;
            var iso = graphicResult && graphicResult.attributes && graphicResult.attributes.detectlabCountryISO;
            if (iso && instance.entries[iso]) return instance.entries[iso].entry;
        }
        return nearestMicro(instance, event);
    }

    function emitHover(instance, entry) {
        var iso = entry ? entry.iso : null;
        if (instance.hoveredIso === iso) return;
        instance.hoveredIso = iso;
        drawFocus(instance);
        if (instance.container && instance.container.style) instance.container.style.cursor = entry ? 'pointer' : 'grab';
        if (instance.hooks && typeof instance.hooks.onHover === 'function') {
            try { instance.hooks.onHover(iso, entry || null); } catch (e) {}
        }
    }

    function bindView(instance) {
        var view = instance.view;
        var pointerSequence = 0;
        if (typeof view.on !== 'function') return;
        instance.handles.push(view.on('pointer-move', function (event) {
            var sequence = ++pointerSequence;
            view.hitTest(event).then(function (response) {
                if (current !== instance || sequence !== pointerSequence) return;
                emitHover(instance, hitCountry(instance, response, event));
            }).catch(function () {});
        }));
        if (instance.container && typeof instance.container.addEventListener === 'function') {
            var leave = function () {
                pointerSequence++;
                if (current === instance) emitHover(instance, null);
            };
            instance.container.addEventListener('pointerleave', leave);
            instance.handles.push({ remove: function () {
                instance.container.removeEventListener('pointerleave', leave);
            } });
        }
        instance.handles.push(view.on('click', function (event) {
            view.hitTest(event).then(function (response) {
                if (current !== instance) return;
                var entry = hitCountry(instance, response, event);
                if (!entry || !instance.hooks || typeof instance.hooks.onSelect !== 'function') return;
                try { instance.hooks.onSelect(entry.iso, entry); } catch (e) {}
            }).catch(function () {});
        }));
    }

    function zoomFor(entry) {
        var bbox = entry && entry.bboxEU;
        var span = 0.5;
        if (Array.isArray(bbox) && bbox.length === 4) {
            var width = Math.abs(Number(bbox[2]) - Number(bbox[0]));
            var height = Math.abs(Number(bbox[3]) - Number(bbox[1]));
            span = Math.max(width, height * 1.55, 0.35);
        } else if (entry && Number(entry.size) > 0) {
            span = Math.max(Number(entry.size) * 1.7, 0.35);
        }
        var zoom = Math.log(360 / span) / Math.LN2 - 0.35;
        return Math.max(1.8, Math.min(9.2, zoom));
    }

    function countryGoToTarget(entry) {
        var center = countryCenter(entry);
        return { center: center, zoom: zoomFor(entry), heading: 0, tilt: 0 };
    }

    function createView(modules, container, hooks, countries) {
        var apiKey = getApiKey();
        if (apiKey && modules.esriConfig) modules.esriConfig.apiKey = apiKey;
        var imageryProperties = {
            url: apiKey ? KEYED_WORLD_IMAGERY_SERVICE : WORLD_IMAGERY_SERVICE,
            title: 'Esri World Imagery',
            copyright: ATTRIBUTION,
            listMode: 'hide'
        };
        // New Esri basemap-layer endpoints require a token. The optional
        // referrer-restricted key is supplied through esriConfig; with no key
        // we use the same legacy imagery URL as the existing working map.
        var imagery = new modules.TileLayer(imageryProperties);
        var basemap = new modules.Basemap({ title: 'Esri World Imagery', baseLayers: [imagery] });
        var layers = makeLayers(modules);
        var map = new modules.Map({
            basemap: basemap,
            // An empty Ground keeps the ellipsoid flat: no World Elevation / 3D terrain.
            ground: { layers: [] },
            layers: [
                layers.casing,
                layers.countries,
                layers.micro,
                layers.focusCasing,
                layers.focus,
                layers.microFocusCasing,
                layers.microFocus,
                layers.labels
            ]
        });
        var view = new modules.SceneView({
            container: container,
            map: map,
            viewingMode: 'global',
            center: [14, 40],
            zoom: 2.35,
            environment: {
                background: { type: 'color', color: [3, 9, 22, 1] },
                starsEnabled: false,
                atmosphereEnabled: false,
                lighting: { type: 'virtual', directShadowsEnabled: false, ambientOcclusionEnabled: false }
            },
            ui: { components: [] }
        });
        return { map: map, view: view, imagery: imagery, layers: layers };
    }

    /* ── Drawable-surface guard ──────────────────────────────────────────
       A SceneView can report itself ready while its surface has no height at
       all (e.g. a stylesheet overrides the container's `display: flex`, which
       is what stretches the SDK's view root and surface). In that state the
       SDK keeps its 300×150 fallback canvas, renders nothing, and the gate
       would be a black panel with no usable globe. So the adapter measures
       the surface before it reports the globe as usable: it restores
       the documented layout once, and if the surface is still collapsed it
       rejects — js/globe-country-picker.js then opens the canvas globe
       instead of leaving the visitor on a black screen. */
    function surfaceElement(instance) {
        var container = instance && instance.container;
        if (!container || typeof container.querySelector !== 'function') return null;
        return container.querySelector('.esri-view-surface') || container.querySelector('canvas');
    }

    function elementRect(element) {
        if (!element || typeof element.getBoundingClientRect !== 'function') return null;
        try { return element.getBoundingClientRect(); } catch (e) { return null; }
    }

    // true = surface fills the host, false = collapsed, null = not measurable
    // (layout APIs unavailable, or the host itself is hidden so there is
    // nothing to compare against).
    function surfaceCoversHost(instance) {
        var host = elementRect(instance && instance.container);
        var surface = elementRect(surfaceElement(instance));
        if (!host || !surface) return null;
        if (host.width < 2 || host.height < 2) return null;
        return surface.height >= host.height * 0.5 && surface.width >= host.width * 0.5;
    }

    // Waits for the browser to lay the new view out. Two frames normally; the
    // timeout is the guarantee that a throttled rAF (hidden tab, background
    // iframe) can never leave the gate waiting on this check.
    function afterLayout() {
        return new Promise(function (resolve) {
            var done = false;
            var finish = function () { if (done) return; done = true; resolve(); };
            window.setTimeout(finish, 400);
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(function () {
                    window.requestAnimationFrame(finish);
                });
            }
        });
    }

    function restoreContainerLayout(instance) {
        // The SDK documents `display: flex` on its view container; re-assert it
        // (and resize) when something else collapsed the surface. Cleared again
        // by destroyInstance(), and `.globe-gate.is-canvas .globe-gate-arcgis`
        // keeps `display: none !important` so the canvas fallback stays clean.
        if (!instance || !instance.container || !instance.container.style) return false;
        instance.container.style.display = 'flex';
        try {
            if (instance.view && typeof instance.view.resize === 'function') instance.view.resize();
        } catch (e) {}
        return true;
    }

    function ensureDrawableSurface(instance, label) {
        return afterLayout().then(function () {
            if (surfaceCoversHost(instance) !== false) return true;
            if (!restoreContainerLayout(instance)) throw new Error(label);
            return afterLayout().then(function () {
                if (surfaceCoversHost(instance) !== false) return true;
                throw new Error(label);
            });
        });
    }

    function destroyInstance(instance) {
        if (!instance) return;
        if (instance.container && instance.container.style) instance.container.style.display = '';
        (instance.handles || []).forEach(function (handle) {
            try { if (handle && typeof handle.remove === 'function') handle.remove(); } catch (e) {}
        });
        if (instance.view) {
            try { instance.view.container = null; } catch (e) {}
            try { if (typeof instance.view.destroy === 'function') instance.view.destroy(); } catch (e) {}
        }
        if (instance.map) {
            try { if (typeof instance.map.destroy === 'function') instance.map.destroy(); } catch (e) {}
        }
    }

    function open(container, countries, hooks) {
        close();
        hooks = hooks || {};
        if (!container) return Promise.reject(new Error('ArcGIS globe container is missing'));
        var myGeneration = ++generation;
        return loadSdk().then(function (modules) {
            if (myGeneration !== generation) throw new Error('ArcGIS globe open was cancelled');
            var created = createView(modules, container, hooks, countries);
            current = {
                modules: modules,
                container: container,
                hooks: hooks,
                view: created.view,
                map: created.map,
                imagery: created.imagery,
                layers: created.layers,
                entries: {},
                handles: [],
                selectedIso: hooks.selectedIso || null,
                hoveredIso: null
            };
            var instance = current;
            bindView(instance);
            drawCountries(instance, countries || []);
            var viewReady = instance.view && typeof instance.view.when === 'function' ? instance.view.when() : Promise.resolve(instance.view);
            var imageryReady = instance.imagery && typeof instance.imagery.when === 'function' ? instance.imagery.when() : Promise.resolve(instance.imagery);
            return rejectAfter(Promise.all([viewReady, imageryReady]), VIEW_TIMEOUT_MS, 'Timed out preparing the ArcGIS SceneView').then(function () {
                if (current !== instance || myGeneration !== generation) throw new Error('ArcGIS globe open was cancelled');
                // The first camera is always the agreed European overview;
                // a stored country is highlighted but does not recenter re-entry.
                var start = { center: [14, 40], zoom: 2.35, heading: 0, tilt: 0 };
                return Promise.resolve(instance.view.goTo(start, { animate: false })).catch(function () {}).then(function () {
                    if (current !== instance || myGeneration !== generation) throw new Error('ArcGIS globe open was cancelled');
                    // Never hand a black, drawable-less globe back to the gate.
                    return ensureDrawableSurface(instance, 'ArcGIS SceneView surface has no size inside the gate');
                }).then(function () {
                    if (current !== instance || myGeneration !== generation) throw new Error('ArcGIS globe open was cancelled');
                    drawFocus(instance);
                    return true;
                });
            }).catch(function (error) {
                if (current === instance) {
                    current = null;
                    destroyInstance(instance);
                }
                throw error;
            });
        });
    }

    function close() {
        generation++;
        var instance = current;
        current = null;
        destroyInstance(instance);
    }

    function setCountries(countries) {
        if (!current) return false;
        drawCountries(current, countries || []);
        return true;
    }

    function setHovered(iso) {
        if (!current) return false;
        current.hoveredIso = iso && current.entries[iso] ? iso : null;
        drawFocus(current);
        return true;
    }

    function setSelected(iso) {
        if (!current) return false;
        current.selectedIso = iso && current.entries[iso] ? iso : null;
        drawFocus(current);
        return true;
    }

    function refreshLabels() {
        if (!current) return false;
        drawFocus(current);
        return true;
    }

    function goToCountry(iso) {
        if (!current || !current.entries[iso]) return Promise.reject(new Error('Country geometry unavailable: ' + iso));
        var instance = current;
        instance.selectedIso = iso;
        instance.hoveredIso = null;
        drawFocus(instance);
        return Promise.resolve(instance.view.goTo(countryGoToTarget(instance.entries[iso].entry), {
            duration: 850,
            easing: 'ease-in-out'
        }));
    }

    function zoomBy(amount) {
        if (!current || !current.view) return Promise.resolve(false);
        var zoom = Number(current.view.zoom);
        if (!isFinite(zoom)) zoom = 2.35;
        zoom = Math.max(1.5, Math.min(9.5, zoom + Number(amount || 0)));
        return Promise.resolve(current.view.goTo({ zoom: zoom }, { duration: 180 })).then(function () { return true; });
    }

    window.DetectLabArcGISGate = {
        open: open,
        close: close,
        isActive: function () { return !!(current && current.view); },
        setCountries: setCountries,
        setHovered: setHovered,
        setSelected: setSelected,
        refreshLabels: refreshLabels,
        goToCountry: goToCountry,
        zoomBy: zoomBy,
        constants: {
            sdkRoot: SDK_ROOT,
            sdkCss: SDK_CSS,
            background: BACKGROUND,
            imageryService: WORLD_IMAGERY_SERVICE,
            keyedImageryService: KEYED_WORLD_IMAGERY_SERVICE,
            attribution: ATTRIBUTION
        },
        _test: {
            signedArea: signedArea,
            orientRing: orientRing,
            geometryRings: geometryRings,
            isMicroState: isMicroState,
            zoomFor: zoomFor,
            countryGoToTarget: countryGoToTarget,
            surfaceCoversHost: surfaceCoversHost,
            restoreContainerLayout: restoreContainerLayout,
            ensureDrawableSurface: ensureDrawableSurface,
            getCurrent: function () { return current; },
            loadSdk: loadSdk,
            reset: function () { close(); sdkPromise = null; cssPromise = null; }
        }
    };
})(window, document);
