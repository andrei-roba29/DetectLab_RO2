/* Main-page switch between the ArcGIS SceneView atlas and legacy 2D layer map. */
(function (window, document) {
    'use strict';

    var section = document.getElementById('map-section');
    var frame = section && section.querySelector('.map-frame');
    var iframe = document.getElementById('arcgisAtlasFrame');
    var toggles = [
        document.getElementById('atlasModeToggle'),
        document.getElementById('atlasModeFloatingToggle')
    ].filter(Boolean);
    if (!section || !frame || !iframe || !toggles.length) return;

    var atlasIsPrimary = true;

    function updateToggleLabel() {
        var ro = String(document.documentElement.lang || '').toLowerCase().indexOf('ro') === 0;
        var label = atlasIsPrimary
            ? (ro ? '🗺 Hartă 2D și straturi' : '🗺 2D map & layers')
            : (ro ? '🌐 Înapoi la atlasul ArcGIS' : '🌐 Back to ArcGIS atlas');
        toggles.forEach(function (toggle) {
            toggle.textContent = label;
            toggle.setAttribute('aria-pressed', atlasIsPrimary ? 'false' : 'true');
            toggle.setAttribute('aria-label', label);
        });
    }

    function requestSceneResize() {
        try {
            if (iframe.contentWindow) {
                iframe.contentWindow.postMessage({ type: 'detectlab-atlas-resize' }, window.location.origin);
            }
        } catch (error) { /* ArcGIS also observes its container */ }
    }

    function setMode(useAtlas) {
        atlasIsPrimary = !!useAtlas;
        section.classList.toggle('atlas-primary', atlasIsPrimary);
        frame.classList.toggle('atlas-view', atlasIsPrimary);
        updateToggleLabel();
        if (atlasIsPrimary) {
            window.requestAnimationFrame(requestSceneResize);
        } else {
            window.setTimeout(function () {
                var map = window._dlMap || window.map;
                if (map && typeof map.invalidateSize === 'function') {
                    try { map.invalidateSize({ pan: false }); } catch (error) { map.invalidateSize(); }
                }
            }, 80);
        }
    }

    toggles.forEach(function (toggle) {
        toggle.addEventListener('click', function () { setMode(!atlasIsPrimary); });
    });

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (event.origin !== window.location.origin || !data) return;

        if (data.type === 'detectlab-map-mode' && data.mode === 'legacy') {
            setMode(false);
            return;
        }
        if (data.type !== 'detectlab-atlas-country-selected') return;

        var iso = String(data.iso || '').toUpperCase();
        var bounds = Array.isArray(data.bounds) && data.bounds.length === 4
            ? data.bounds.map(Number) : null;
        var hasSingleCountry = Number(data.selectionCount) === 1 && /^[A-Z]{2}$/.test(iso) &&
            bounds && bounds.every(Number.isFinite);

        if (hasSingleCountry) {
            window._detectlabSelectedCountry = iso;
            window._detectlabCountryBounds = bounds;
            document.dispatchEvent(new CustomEvent('detectlab:country-selected', {
                detail: { iso: iso, name: String(data.name || iso), bounds: bounds, source: 'arcgis-atlas' }
            }));
            if (typeof window.filterLayersForCountry === 'function') {
                try { window.filterLayersForCountry(iso); } catch (error) { console.warn('[Atlas] Could not filter legacy layers:', error); }
            }
            var map = window._dlMap || window.map;
            if (map && typeof map.fitBounds === 'function') {
                try { map.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]], { padding: [40, 40], maxZoom: 9 }); } catch (error) {}
            }
            return;
        }

        var wasSelected = !!window._detectlabSelectedCountry;
        window._detectlabSelectedCountry = '';
        window._detectlabCountryBounds = null;
        if (typeof window.unfilterLayersForCountry === 'function') {
            try { window.unfilterLayersForCountry(); } catch (error) { console.warn('[Atlas] Could not restore legacy layers:', error); }
        }
        if (wasSelected) {
            var legacyMap = window._dlMap || window.map;
            if (legacyMap && typeof legacyMap.setView === 'function') {
                try { legacyMap.setView([51, 12], 3); } catch (error) {}
            }
        }
        document.dispatchEvent(new CustomEvent('detectlab:country-cleared', { detail: { source: 'arcgis-atlas' } }));
    });

    iframe.addEventListener('load', requestSceneResize);
    updateToggleLabel();
})(window, document);
