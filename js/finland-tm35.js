/*
 * js/finland-tm35.js
 * ───────────────────────────────────────────────────────────────────────────
 * DetectLab · Finland — the EPSG:3067 (ETRS-TM35FIN) maths and the Mapbox
 * Vector Tile decoder, as pure functions with no DOM and no dependencies.
 *
 * Everything Finnish on this map is published in ETRS-TM35FIN (EPSG:3067):
 *   • Maanmittauslaitos' WMTS rasters (hillshade, topographic map) on the
 *     "ETRS-TM35FIN" TileMatrixSet — NOT the Web-Mercator/XYZ grid;
 *   • Maanmittauslaitos' HKP cadastral service, whose GetLayerTile returns
 *     Mapbox Vector Tiles on the same TM35FIN grid;
 *   • Museovirasto's GetWFSFeatures route, which speaks TM35FIN metres by
 *     default (it also accepts srs=EPSG:4326, which the WFS layers use).
 *
 * This map is EPSG:3857 (like every other national layer here), so the
 * module provides the two bridges that make TM35FIN sources fit it:
 *
 *   forward(lat, lon)        → [easting, northing]   EPSG:3067
 *   inverse(easting, north)  → [lat, lon]            WGS84 degrees
 *   grid                     → the ETRS-TM35FIN TileMatrixSet
 *                              (origin, resolutions, tile spans, col/row
 *                              maths for TileMatrix/TileRow/TileCol)
 *
 * The projection is the same Krüger series on GRS80 that
 * js/dataforsyningen-dhm-layer.js uses for Denmark's EPSG:25832 — only the
 * central meridian differs (27°E instead of 9°E). EPSG:3067 is literally
 * ETRS89 / UTM zone 35N. Validated below the same two ways: the round trip
 * is exact to ~1 µm over Finland, and known control points reproduce the
 * official ETRS-TM35FIN values to a few centimetres (see the self-test at
 * the bottom and tools/verify-finland-layers.mjs).
 *
 * The MVT decoder implements the vector-tile 2.1 spec (fields 1–15, command
 * geometries with zig-zag deltas) in ~150 lines so the HKP cadastral tiles
 * can be decoded without vendoring a protobuf stack. It is pure: bytes in,
 * plain objects out.
 *
 * Exposed as window.FinlandTM35 (browser) / module.exports (Node, tests).
 * No build step, no dependencies.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.FinlandTM35 = api;
}(typeof window !== 'undefined' ? window
    : typeof self !== 'undefined' ? self
        : typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var DEG = Math.PI / 180, RAD = 180 / Math.PI;

    /* ── spherical Mercator, identical to L.CRS.EPSG3857 ─────────────────── */

    var MERC_R = 6378137,
        MERC_HALF = Math.PI * MERC_R;          // 20037508.342789244

    function mercatorX(lon) { return MERC_R * lon * DEG; }
    function mercatorY(lat) { return MERC_R * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)); }
    function mercatorLon(x) { return (x / MERC_R) * RAD; }
    function mercatorLat(y) { return (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * RAD; }

    /** Metres per pixel of the EPSG:3857 XYZ grid at a zoom level. */
    function webMercatorResolution(zoom, tileSize) {
        return (2 * MERC_HALF) / ((tileSize || 256) * Math.pow(2, zoom));
    }

    /* ── ETRS89 / UTM zone 35N (EPSG:3067) ───────────────────────────────────
     * Krüger series on GRS80, fourth order — the same formulation PROJ uses.
     * EPSG:3067 = ETRS89 / UTM 35N: k0 = 0.9996, central meridian 27°E,
     * false easting 500 000 m, no false northing.                            */

    var UTM35 = (function () {
        var a = 6378137.0,                       // GRS80 semi-major axis
            f = 1 / 298.257222101,               // GRS80 flattening
            k0 = 0.9996,
            lon0 = 27 * DEG,                     // zone 35 central meridian
            FE = 500000, FN = 0,
            n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n,
            A = a / (1 + n) * (1 + n2 / 4 + n4 / 64),
            al = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180,
                  13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440,
                  61 * n3 / 240 - 103 * n4 / 140,
                  49561 * n4 / 161280],
            be = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360,
                  n2 / 48 + n3 / 15 - 437 * n4 / 1440,
                  17 * n3 / 480 - 37 * n4 / 840,
                  4397 * n4 / 161280],
            de = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45,
                  7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45,
                  56 * n3 / 15 - 136 * n4 / 35,
                  4279 * n4 / 630];

        function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }

        /** lat/lon (degrees, ETRS89) → [easting, northing] in EPSG:3067. */
        function forward(lat, lon) {
            var la = lat * DEG, dl = lon * DEG - lon0,
                s = Math.sin(la), q = 2 * Math.sqrt(n) / (1 + n),
                t = Math.sinh(atanh(s) - q * atanh(q * s)),
                xi = Math.atan2(t, Math.cos(dl)),
                eta = atanh(Math.sin(dl) / Math.sqrt(1 + t * t)),
                xiR = xi, etaR = eta, i;
            for (i = 0; i < 4; i++) {
                xiR += al[i] * Math.sin(2 * (i + 1) * xi) * Math.cosh(2 * (i + 1) * eta);
                etaR += al[i] * Math.cos(2 * (i + 1) * xi) * Math.sinh(2 * (i + 1) * eta);
            }
            var E = FE + k0 * A * etaR,
                N = FN + k0 * A * xiR;
            return [E, N];
        }

        /** [easting, northing] in EPSG:3067 → [lat, lon] in degrees. */
        function inverse(E, N) {
            var xi = (N - FN) / (k0 * A),
                eta = (E - FE) / (k0 * A),
                xi2 = xi, eta2 = eta, j, c;
            for (j = 1; j <= 4; j++) {
                c = be[j - 1];
                xi2 -= c * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
                eta2 -= c * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
            }
            var r = Math.sin(xi2) / Math.cosh(eta2);
            var chi = Math.asin(r > 1 ? 1 : (r < -1 ? -1 : r)), la = chi;
            for (j = 1; j <= 4; j++) la += de[j - 1] * Math.sin(2 * j * chi);
            return [la * RAD, (lon0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2))) * RAD];
        }

        return { forward: forward, inverse: inverse };
    }());

    /* ── the ETRS-TM35FIN TileMatrixSet ──────────────────────────────────────
     * Read from Maanmittauslaitos' WMTS (and confirmed against the brief's
     * own sample tiles — see FINLAND_LAYERS.md §verification):
     *   TopLeftCorner   -548576, 8388608   (metres, every level)
     *   tile size       256 × 256 px
     *   resolutions     8192 / 2^level  m/px   (level 0 … 15)
     *   tile span       2 097 152 / 2^level m
     * WMTS order in the URL is TileMatrix/TileRow/TileCol — rows count
     * SOUTHWARD from the top edge, columns eastward from the left edge.
     * The HKP service spells the same grid ?x=col&y=row&z=level and
     * Museovirasto's tile route TileMatrix/TileCol/TileRow (col first!) —
     * the wrappers below keep that straight.                                  */

    var GRID = {
        EPSG: 3067,
        ORIGIN_X: -548576,
        ORIGIN_Y: 8388608,
        RES0: 8192,                 // metres per pixel at level 0
        TILE_SIZE: 256,
        LEVELS: 16,                 // 0 … 15 (8192 → 0.25 m/px)
        /* Whole-Finland envelope of the grid, in metres. */
        EXTENT: [-548576, 6291456, 1548576, 8388608]
    };

    /* Convenience surface over the constants — the tile layers in
     * js/finland-layers.js use these spellings. */
    GRID.origin = [GRID.ORIGIN_X, GRID.ORIGIN_Y];
    /** Resolution (m/px) of a TM35FIN level. */
    GRID.resolution = levelResolution;
    /** Ground span (m) of one 256 px tile at a level. */
    GRID.tileSpan = levelTileSpan;
    /** Matrix dimensions of a level: [cols, rows] — the full envelope is
     * exactly 2^level × 2^level tiles at every level (1×1 at L0 up to
     * 32768×32768 at L15, the dimensions the WMTS capabilities publish). */
    GRID.matrixSize = function (level) {
        var n = Math.round(Math.pow(2, level));
        return [n, n];
    };
    GRID.matrixWidth = function (level) { return GRID.matrixSize(level)[0]; };

    /** Resolution (m/px) of a TM35FIN level. */
    function levelResolution(level) {
        return GRID.RES0 / Math.pow(2, level);
    }

    /** Tile span in metres at a TM35FIN level. */
    function levelTileSpan(level) {
        return GRID.RES0 * GRID.TILE_SIZE / Math.pow(2, level);
    }

    /** The TM35FIN level whose resolution best matches `res` metres/pixel. */
    function levelForResolution(res) {
        if (!(res > 0)) return GRID.LEVELS - 1;
        var level = Math.round(Math.log(GRID.RES0 / res) / Math.LN2);
        return Math.max(0, Math.min(GRID.LEVELS - 1, level));
    }

    /** Clamp a mercator zoom to the deepest TM35FIN level (15). */
    function maxLevel() { return GRID.LEVELS - 1; }

    /**
     * The TM35FIN level whose resolution best matches the map's current one
     * (at the given latitude, because Web Mercator's metres-per-px shrinks
     * towards the poles). bias shifts the pick sharper (+1) / softer (−1).
     */
    function levelForZoom(zoom, lat, bias, tileSize) {
        var target = webMercatorResolution(zoom, tileSize) / Math.max(0.1, Math.cos((lat || 63) * DEG));
        var best = 0, err = Infinity, l, res, d;
        for (l = 0; l < GRID.LEVELS; l++) {
            res = levelResolution(l);
            d = Math.abs(res - target);
            if (d < err) { err = d; best = l; }
        }
        best += (bias || 0);
        return Math.max(0, Math.min(maxLevel(), best));
    }

    /** Tile column of an easting at a level. */
    function tileCol(level, easting) {
        return Math.floor((easting - GRID.ORIGIN_X) / levelTileSpan(level));
    }

    /** Tile row (southward from the top edge) of a northing at a level. */
    function tileRow(level, northing) {
        return Math.floor((GRID.ORIGIN_Y - northing) / levelTileSpan(level));
    }

    /** [west, south, east, north] metre bounds of a TM35FIN tile. */
    function tileBounds(level, col, row) {
        var span = levelTileSpan(level);
        var west = GRID.ORIGIN_X + col * span;
        var north = GRID.ORIGIN_Y - row * span;
        return [west, north - span, west + span, north];
    }

    /** Every TM35FIN tile that intersects a metre bbox, as [col, row]. */
    function tilesInBBox(level, bbox) {
        var c0 = tileCol(level, bbox[0]), c1 = tileCol(level, bbox[2]);
        var r0 = tileRow(level, bbox[3]), r1 = tileRow(level, bbox[1]);
        var out = [], c, r;
        for (r = r0; r <= r1; r++) {
            for (c = c0; c <= c1; c++) {
                if (c < 0 || r < 0) continue;
                out.push([c, r]);
            }
        }
        return out;
    }

    /** Approximate the Web-Mercator zoom that matches a TM35FIN level. */
    function zoomForLevel(level, lat) {
        var target = levelResolution(level);                    // m/px
        var merc = target * Math.max(0.1, Math.cos((lat || 63) * DEG));
        // webMercatorResolution(z) = 2πR / (256·2^z)
        return Math.round(Math.log2((2 * MERC_HALF) / (GRID.TILE_SIZE * merc)));
    }

    /* ── Mapbox Vector Tile decoder (spec 2.1) ──────────────────────────────
     * Tile  { layers: [Layer] }
     * Layer { name, extent, features: [Feature] }
     * Feature { type: 1|2|3, tags: {key: value}, parts: [ [[x, y], …], … ] }
     * Geometry coordinates are integers in tile units (0 … extent).           */

    var MVT = (function () {

        /* protobuf wire reader */
        function Reader(buf) {
            this.buf = buf;
            this.pos = 0;
            this.len = buf.length || buf.byteLength;
        }        Reader.prototype.varint = function () {
            var result = 0, shift = 0, b;
            do {
                b = this.buf[this.pos++];
                result += (b & 0x7f) * Math.pow(2, shift);
                shift += 7;
            } while (b >= 0x80);
            return result;
        };
        Reader.prototype.svarint = function () {
            var v = this.varint();
            return (v % 2 === 1) ? -(v + 1) / 2 : v / 2;
        };
        Reader.prototype.bytes = function () {
            var length = this.varint();
            var end = this.pos + length;
            var out = this.buf.subarray ? this.buf.subarray(this.pos, end)
                : this.buf.slice(this.pos, end);
            this.pos = end;
            return out;
        };
        Reader.prototype.string = function () {
            var bytes = this.bytes();
            var out = '', i;
            for (i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
            try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
        };
        Reader.prototype.skip = function (wire) {
            if (wire === 0) this.varint();
            else if (wire === 1) this.pos += 8;
            else if (wire === 2) this.pos += this.varint();
            else if (wire === 5) this.pos += 4;
            else throw new Error('unsupported wire type ' + wire);
        };

        function f32(bytes) {
            var buf = new ArrayBuffer(4), u8 = new Uint8Array(buf);
            u8[0] = bytes[0]; u8[1] = bytes[1]; u8[2] = bytes[2]; u8[3] = bytes[3];
            return new Float32Array(buf)[0];
        }

        function f64(bytes) {
            var buf = new ArrayBuffer(8), u8 = new Uint8Array(buf), i;
            for (i = 0; i < 8; i++) u8[i] = bytes[i];
            return new Float64Array(buf)[0];
        }

        /* A Value is itself a message: string_value(1), float_value(2),
         * double_value(3), int_value(4), uint_value(5), sint_value(6),
         * bool_value(7). The first present field wins. */
        function readValue(reader) {
            var bytes = reader.bytes();
            var sub = new Reader(bytes);
            while (sub.pos < sub.len) {
                var key = sub.varint(), field = key >> 3, wire = key & 7;
                if (field === 1 && wire === 2) return sub.string();
                if (field === 2 && wire === 5) return f32(sub.bytes());
                if (field === 3 && wire === 1) return f64(sub.bytes());
                if (field === 4 && wire === 0) return sub.varint();
                if (field === 5 && wire === 0) return sub.varint();
                if (field === 6 && wire === 0) return sub.svarint();
                if (field === 7 && wire === 0) return !!sub.varint();
                sub.skip(wire);
            }
            return null;
        }

        function readFeature(reader, keys, values) {
            var feature = { id: null, type: 0, tags: {}, parts: [] };
            var commands = null;
            while (reader.pos < reader.len) {
                var key = reader.varint(), field = key >> 3, wire = key & 7;
                if (field === 1 && wire === 0) feature.id = reader.varint();
                else if (field === 2 && wire === 2) {
                    /* packed tag indexes: k1, v1, k2, v2, … */
                    var b = reader.bytes(), i, packed = [];
                    for (i = 0; i < b.length;) {
                        var v = 0, shift = 0, by;
                        do {
                            by = b[i++];
                            v += (by & 0x7f) * Math.pow(2, shift);
                            shift += 7;
                        } while (by >= 0x80);
                        packed.push(v);
                    }
                    for (i = 0; i + 1 < packed.length; i += 2) {
                        var k = keys[packed[i]], val = values[packed[i + 1]];
                        if (k) feature.tags[k] = val;
                    }
                }
                else if (field === 3 && wire === 0) feature.type = reader.varint();
                else if (field === 4 && wire === 2) {
                    var gb = reader.bytes(), g = [], gi;
                    for (gi = 0; gi < gb.length;) {
                        var gv = 0, gs = 0, gb2;
                        do {
                            gb2 = gb[gi++];
                            gv += (gb2 & 0x7f) * Math.pow(2, gs);
                            gs += 7;
                        } while (gb2 >= 0x80);
                        g.push(gv);
                    }
                    commands = g;
                }
                else reader.skip(wire);
            }
            if (commands) feature.parts = decodeGeometry(commands, feature.type);
            return feature;
        }

        function decodeGeometry(commands, type) {
            var parts = [], current = null, x = 0, y = 0;
            var i = 0;
            while (i < commands.length) {
                var command = commands[i++],
                    id = command & 0x7,
                    count = command >> 3,
                    j;
                if (id === 1) {                       // MoveTo (points / rings)
                    for (j = 0; j < count && i + 1 < commands.length; j++) {
                        x += zigzag(commands[i++]);
                        y += zigzag(commands[i++]);
                        if (type === 1) {
                            current = [[x, y]];
                            parts.push(current);
                        } else {
                            current = [[x, y]];
                            parts.push(current);
                        }
                    }
                } else if (id === 2) {                // LineTo
                    for (j = 0; j < count && i + 1 < commands.length; j++) {
                        x += zigzag(commands[i++]);
                        y += zigzag(commands[i++]);
                        if (current) current.push([x, y]);
                    }
                } else if (id === 7) {                // ClosePath
                    if (current && current.length > 1) {
                        current.push([current[0][0], current[0][1]]);
                    }
                }
            }
            return parts;
        }

        function zigzag(v) { return (v % 2 === 1) ? -(v + 1) / 2 : v / 2; }

        function readLayer(reader) {
            /* MVT Layer: name=1 (string), features=2, keys=3, values=4,
             * extent=5 (varint), version=15 (varint). encoders differ in the
             * order they write these (vt-pbf puts features before the key and
             * value tables), so raw features are collected first and decoded
             * in a second pass, once the tables are complete. */
            var layer = { name: '', extent: 4096, version: 1, features: [] };
            var keys = [], values = [], raw = [];
            while (reader.pos < reader.len) {
                var key = reader.varint(), field = key >> 3, wire = key & 7;
                if (field === 1 && wire === 2) layer.name = reader.string();
                else if (field === 15 && wire === 0) layer.version = reader.varint();
                else if (field === 2 && wire === 2) raw.push(reader.bytes());
                else if (field === 3 && wire === 2) keys.push(reader.string());
                else if (field === 4 && wire === 2) values.push(readValue(reader));
                else if (field === 5 && wire === 0) layer.extent = reader.varint();
                else reader.skip(wire);
            }
            layer.features = raw.map(function (bytes) {
                return readFeature(new Reader(bytes), keys, values);
            });
            return layer;
        }


        /**
         * Decode an MVT buffer (ArrayBuffer / Uint8Array).
         * @returns {{layers: Array}} decoded tile
         */
        function decode(buffer) {
            var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            var reader = new Reader(bytes);
            var tile = { layers: [] };
            while (reader.pos < reader.len) {
                var key = reader.varint(), field = key >> 3, wire = key & 7;
                if (field === 3 && wire === 2) {
                    var bytes2 = reader.bytes();
                    var sub = new Reader(bytes2);
                    tile.layers.push(readLayer(sub));
                } else {
                    reader.skip(wire);
                }
            }
            return tile;
        }

        return { decode: decode };
    }());

    /* ── self-test (runs in Node; see tools/verify-finland-layers.mjs) ──────
     * Helsinki (60.171 N, 24.937 E) is E 385537.48, N 6672243.27 in
     * EPSG:3067 — cross-validated against proj4's EPSG:3067 definition
     * (+proj=utm +zone=35 +ellps=GRS80) to the last printed digit. The
     * round trip must be exact to ~1 µm, and the hand-encoded MVT must
     * decode.                                                              */

    function selfTest() {
        var results = { roundTripMaxErrorM: 0, helsinkiErrorM: null, mvt: null };
        var probes = [[60.171, 24.937], [70.00, 20.00], [59.8, 28.5], [68.1, 27.9], [60.4, 22.2]];
        var i, en, back;
        for (i = 0; i < probes.length; i++) {
            en = UTM35.forward(probes[i][0], probes[i][1]);
            back = UTM35.inverse(en[0], en[1]);
            results.roundTripMaxErrorM = Math.max(
                results.roundTripMaxErrorM,
                Math.abs(back[0] - probes[i][0]) * 111320,
                Math.abs(back[1] - probes[i][1]) * 111320 * 0.5
            );
        }
        var hel = UTM35.forward(60.171, 24.937);
        results.helsinkiErrorM = Math.max(
            Math.abs(hel[0] - 385537.48), Math.abs(hel[1] - 6672243.27));
        /* A minimal MVT with one layer ("test", extent 4096) holding one
         * linestring feature, hand-encoded so the decoder can be tested
         * without a fixture file. */
        var mvtBytes = new Uint8Array([
            0x1a, 0x12,                         // field 3 (layers), len 18
            0x0a, 0x04, 0x74, 0x65, 0x73, 0x74, // layer name "test"
            0x28, 0x80, 0x20,                   // extent 4096 (field 5)
            0x12, 0x07,                         // feature (field 2), len 7
            0x18, 0x02,                         //   type 2 (linestring)
            0x22, 0x03,                         //   geometry (field 4), len 3
            0x09, 0x02, 0x02                    //   MoveTo×1 → (+1,+1)
        ]);

        try {
            var tile = MVT.decode(mvtBytes);
            results.mvt = !!(tile.layers && tile.layers.length === 1 &&
                tile.layers[0].name === 'test' && tile.layers[0].extent === 4096 &&
                tile.layers[0].features.length === 1 &&
                tile.layers[0].features[0].parts.length === 1);
        } catch (e) {
            results.mvt = false;
        }
        results.ok = results.roundTripMaxErrorM < 0.001 &&
            results.helsinkiErrorM !== null && results.helsinkiErrorM < 0.05 &&
            results.mvt === true;
        return results;
    }

    return {
        UTM35: UTM35,
        GRID: GRID,
        mercatorX: mercatorX, mercatorY: mercatorY,
        mercatorLon: mercatorLon, mercatorLat: mercatorLat,
        webMercatorResolution: webMercatorResolution,
        levelResolution: levelResolution,
        levelTileSpan: levelTileSpan,
        levelForZoom: levelForZoom,
        levelForResolution: levelForResolution,
        tileCol: tileCol, tileRow: tileRow,
        tileBounds: tileBounds, tilesInBBox: tilesInBBox,
        zoomForLevel: zoomForLevel,
        maxLevel: maxLevel,
        mvtDecode: MVT.decode,
        selfTest: selfTest
    };
}));
