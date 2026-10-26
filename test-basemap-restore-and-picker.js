/*
 * test-basemap-restore-and-picker.js
 * ──────────────────────────────────────────────────────────────────────────
 * “When LiDAR is loaded in 3D the base map automatically changes but it
 *  still appears to be in terrain mode. When trying to change the basemap
 *  nothing happens.”
 *
 * The field report behind this fix, and the three defects it stands on:
 *
 *   1. RELOAD FORGETS THE MAP, NOT THE SELECTOR. map-app.js restores
 *      `detectlab_arcgis_basemap_v1` into `_arcgisCurrentBasemap` but never
 *      applied it to the Leaflet stack — every boot shows satellite imagery
 *      while the control caption and the 3D select report the stored key
 *      (e.g. “terrain”). The state/map divergence made every picker attempt
 *      read as “nothing happens” (picking the already-visible sheet is a
 *      layer no-op) and made the 3D view claim terrain forever. The stored
 *      choice is now re-applied at the end of the setter block.
 *
 *   2. THE 2D SETTER COULD THROW MID-SWAP. `setArcgisBasemap` moved the
 *      sheets and synced the control outside any try — a throw propagated to
 *      the 3D select's catch, which snapped the value back (“reverts”) and
 *      left half a basemap behind. Every layer op and the control sync are
 *      now guarded and the setter always returns the key it applied.
 *
 *   3. ONE FAILED 3D SYNC FREEZE THE DECK. The 1.5 s signature poll marked
 *      the new signature BEFORE calling syncLayers(): a throw anywhere
 *      unwrapped (collect/plan/applyDeck) meant the poll considered the deck
 *      up to date and never retried — while the 2D map kept switching under
 *      a 3D view stuck on the old plan. sync passes are now guarded,
 *      reported, and the signature only commits on a pass that really ran.
 *
 * Part A runs the REAL map-app basemap block (slice of js/map-app.js) in a
 * sandbox; Parts B/C assert the viewer's retry wiring and the version tags.
 *
 * Run:  node test-basemap-restore-and-picker.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] ArcGIS basemap restore + the 3D picker sync path...');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const mapApp = read('js/map-app.js');
const viewer = read('js/map3d-terrain.js');
const indexHtml = read('index.html');
const swJs = read('sw.js');

const TAG = '20261026-lidar-whole-or-disc';

/* ══════════════════════════════════════════════════════════════════════════
 * A. The real basemap block, run end to end
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const start = mapApp.indexOf('var SATELLITE_LAST_NATIVE_Z');
    const end = mapApp.indexOf('(function addArcgisBasemapControl()');
    assert(start > 0 && end > start, 'the ArcGIS basemap block is where it was');
    const block = mapApp.slice(start, end);
    assert(/_arcgisCurrentBasemap !== 'imagery'/.test(block) &&
        /window\.setArcgisBasemap\(_arcgisCurrentBasemap\)/.test(block),
        'the stored basemap is re-applied to the map at boot');

    function boot(stored) {
        const layers = [];            /* every L.tileLayer the block creates */
        const onMap = new Set();
        const storage = { getItem: (k) => (k === 'detectlab_arcgis_basemap_v1' ? stored : null), setItem: () => {} };
        let controlThrows = false;
        const sandbox = {
            console: { log: console.log, warn() { /* expected in the failure tests */ }, error() {} },
            localStorage: storage,
            document: {
                getElementById() {
                    if (controlThrows) throw new Error('control sync exploded');
                    return null;      /* no control yet → sync early-returns */
                },
                querySelector: () => null,
                addEventListener: () => {}
            },
            L: {
                tileLayer(url, options) {
                    const layer = {
                        _url: String(url),
                        options: options || {},
                        failAdd: false,
                        addTo(map) {
                            if (layer.failAdd) throw new Error('sheet refused to load');
                            map.addLayer(layer);
                            return layer;
                        }
                    };
                    layers.push(layer);
                    return layer;
                }
            },
            map: {
                createPane(name) { this[name] = { style: {} }; },
                getPane(name) { return this[name] || null; },
                hasLayer(layer) { return onMap.has(layer); },
                addLayer(layer) { onMap.add(layer); },
                removeLayer(layer) { onMap.delete(layer); }
            }
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(block, sandbox, { filename: 'js/map-app.js#arcgis-block' });
        const byService = (needle) => layers.find((l) => l._url.indexOf(needle) !== -1);
        return {
            sandbox, layers, onMap,
            imagery: () => byService('World_Imagery'),
            topo: () => byService('World_Topo_Map'),
            terrainBase: () => byService('World_Terrain_Base'),
            terrainRelief: () => byService('World_Terrain_Shaded_Relief'),
            failControl() { controlThrows = true; }
        };
    }

    /* 1. The stored choice is applied: terrain in storage = terrain on the
     *    map, not satellite with a caption that lies. */
    {
        const env = boot('terrain');
        assert.strictEqual(env.sandbox.getArcgisBasemap(), 'terrain');
        assert(env.onMap.has(env.terrainBase()) && env.onMap.has(env.terrainRelief()),
            'stored terrain sheets are on the map after boot');
        assert(!env.onMap.has(env.imagery()), 'satellite is off once terrain is applied');
        assert(!env.onMap.has(env.topo()), 'topographic stays off');
    }

    /* 2. Fresh visitor boots on imagery, exactly as before. */
    {
        const env = boot(null);
        assert.strictEqual(env.sandbox.getArcgisBasemap(), 'imagery');
        assert(env.onMap.has(env.imagery()) && !env.onMap.has(env.terrainBase()));
    }

    /* 3. The picker path itself: a clean swap round trip. */
    {
        const env = boot(null);
        assert.strictEqual(env.sandbox.setArcgisBasemap('topographic'), 'topographic');
        assert(env.onMap.has(env.topo()) && !env.onMap.has(env.imagery()), 'topographic swapped in');
        assert.strictEqual(env.sandbox.getArcgisBasemap(), 'topographic');
        assert.strictEqual(env.sandbox.setArcgisBasemap('imagery'), 'imagery');
        assert(env.onMap.has(env.imagery()) && !env.onMap.has(env.topo()), 'imagery swapped back');
    }

    /* 4. A sheet that refuses to load must not abort the swap or flip the
     *    state back — the 3D select's catch used to be that abort. */
    {
        const env = boot(null);
        env.terrainBase().failAdd = true;
        assert.doesNotThrow(() => env.sandbox.setArcgisBasemap('terrain'),
            'the setter never propagates a layer failure');
        assert.strictEqual(env.sandbox.setArcgisBasemap('terrain'), 'terrain',
            'the setter still returns the key it applied');
        assert.strictEqual(env.sandbox.getArcgisBasemap(), 'terrain');
        assert(env.onMap.has(env.terrainRelief()), 'the healthy sheet still moved');
        assert(!env.onMap.has(env.imagery()), 'the old sheet is still removed');
        /* Recovery: the next pick works even after the failure. */
        assert.strictEqual(env.sandbox.setArcgisBasemap('imagery'), 'imagery');
        assert(env.onMap.has(env.imagery()));
    }

    /* 5. A control caption sync that throws cannot reach the caller. */
    {
        const env = boot(null);
        env.failControl();
        assert.doesNotThrow(() => env.sandbox.setArcgisBasemap('terrain'));
        assert.strictEqual(env.sandbox.getArcgisBasemap(), 'terrain');
        assert(env.onMap.has(env.terrainBase()), 'layers swapped even when the caption sync dies');
    }

    /* 6. The stored key is validated: garbage in storage boots imagery. */
    {
        const env = boot('not-a-basemap');
        assert.strictEqual(env.sandbox.getArcgisBasemap(), 'imagery');
        assert(env.onMap.has(env.imagery()));
    }

    console.log('  ✓ the stored basemap is applied at boot and the setter cannot throw');
}

/* ══════════════════════════════════════════════════════════════════════════
 * B. The 3D sync pass retries instead of freezing
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* The poll commits the signature ONLY after a pass that really ran. */
    assert(/if \(runSync\('poll'\)\) state\.signature = signature;/.test(viewer),
        'the signature poll retries a failed pass on the next tick');
    /* Both event-driven entry points go through the guarded pass. */
    assert(/runSync\('scheduled'\)/.test(viewer), 'the 120 ms timer runs a guarded pass');
    assert(/function runSync\(reason\)/.test(viewer) &&
        /return syncLayers\(\) !== false;/.test(viewer),
        'runSync reports pass failure instead of letting it escape');
    /* The pass guards each phase and returns a status. */
    assert(/function syncLayers\(\) \{\s*\n\s*if \(!map \|\| !state\.open\) return false;/.test(viewer),
        'syncLayers reports its status');
    assert(/try \{ collectMirror\(\); \} catch/.test(viewer) &&
        /try \{ ensureBaseFallback\(\); \} catch/.test(viewer) &&
        /try \{ p = plan\(\); \} catch/.test(viewer) &&
        /try \{ applyDeck\(p\); \} catch/.test(viewer),
        'mirror, fallback, plan and ordering are individually guarded');
    /* The 3D picker schedules its own pass right after the swap. */
    assert(/syncBasemapSelect\(root\.setArcgisBasemap\(basemapSelect\.value\)\);[\s\S]{0,400}scheduleSync\(\);/.test(viewer),
        'a picker choice schedules a deck sync of its own');
    /* Failures are surfaced, not swallowed silently. */
    assert(/pushError\('sync' \+ \(reason \? ' \[' \+ reason \+ '\]' : ''\) \+ ': ' \+ msg\)/.test(viewer),
        'a failed pass is reported in status().errors');
    console.log('  ✓ every sync pass is guarded, reported and retried');
}

/* ══════════════════════════════════════════════════════════════════════════
 * C. Cache wiring — the contract for anything touching these files
 * ══════════════════════════════════════════════════════════════════════════ */
{
    ['js/map-app.js', 'js/map3d-terrain.js'].forEach((file) => {
        const url = file + '?v=' + TAG;
        assert(indexHtml.includes(url), 'index.html loads ' + url);
        assert(swJs.includes("'" + url + "'"), 'sw.js precaches ' + url);
    });
    const version = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    assert(version >= 267, 'the shell cache moved to v267 (found v' + version + ')');
    assert(/Re-tags js\/map-app\.js and js\/map3d-terrain\.js\./.test(swJs),
        'sw.js logs the re-tag');
    /* Assets this fix did NOT touch keep their own tags. */
    assert(indexHtml.includes('css/map3d-terrain.css?v=20261026-lidar-whole-or-disc') &&
        indexHtml.includes('js/layer-registry.js?v=20261024-uk-historical-maps'),
        'untagged assets keep the tag of whatever last changed them');
    console.log('  ✓ cache wiring: ?v=' + TAG + ', shell v' + version);
}

console.log('OK: the stored basemap is applied, the setter cannot throw, and a failed 3D sync retries.');
