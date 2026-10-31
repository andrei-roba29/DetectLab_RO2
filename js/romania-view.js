/* Romania is the only working-map region. The rectangular navigation limits
 * include a small margin so border areas remain accessible at every zoom. */
(function (root) {
    'use strict';
    var bbox = [20.26, 43.62, 29.70, 48.27]; // west, south, east, north
    var padX = (bbox[2] - bbox[0]) * 0.1;
    var padY = (bbox[3] - bbox[1]) * 0.1;
    var limits = [[bbox[1] - padY, bbox[0] - padX], [bbox[3] + padY, bbox[2] + padX]];

    // Layer filters and search use this shared state, irrespective of any
    // country selection saved by an older version of the application.
    root._detectlabSelectedCountry = 'RO';
    root._detectlabSelectedCountryName = 'România';
    root._detectlabCountryBounds = bbox.slice();
    root._detectlabCountryLayer = null;

    function attach(map) {
        var bounds = root.L.latLngBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
        var lockedBounds = root.L.latLngBounds(limits);
        var fitted = false;
        // Preserve valid shared map links, but never restore an old link to a
        // different country. Leaflet Hash will still clamp later hash changes.
        var hash = root.location && root.location.hash;
        var parsed = root.L.Hash && root.L.Hash.parseHash && root.L.Hash.parseHash(hash || '');
        var hasLocalHash = parsed && root.DetectLabRomaniaView.contains(parsed.center.lat, parsed.center.lng);
        map.options.maxBoundsViscosity = 1;
        map.setMaxBounds(lockedBounds);

        function updateZoomFloor() {
            var size = map.getSize();
            if (!size.x || !size.y) return;
            // Measure independently of the previous floor, without triggering a
            // zoom or losing the user's current position during a resize.
            var oldMin = map.options.minZoom;
            var fitZoom;
            map.options.minZoom = 2;
            try { fitZoom = map.getBoundsZoom(bounds, false, [48, 48]); }
            finally { map.options.minZoom = oldMin; }
            if (!isFinite(fitZoom)) return;
            fitZoom = Math.max(2, Math.min(20, fitZoom));
            map.setMinZoom(Math.max(2, fitZoom - 1));
            if (!fitted) {
                fitted = true;
                if (!hasLocalHash) map.fitBounds(bounds, { padding: [24, 24], maxZoom: fitZoom, animate: false });
            }
        }
        updateZoomFloor();
        map.on('resize', updateZoomFloor);
    }

    root.DetectLabRomaniaView = {
        attach: attach,
        contains: function (lat, lon) {
            return lat >= limits[0][0] && lat <= limits[1][0] &&
                lon >= limits[0][1] && lon <= limits[1][1];
        },
        mapLibreBounds: function () {
            return [[limits[0][1], limits[0][0]], [limits[1][1], limits[1][0]]];
        }
    };
})(window);
