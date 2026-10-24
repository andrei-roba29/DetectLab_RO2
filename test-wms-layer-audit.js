// Regression suite for tools/audit-wms-layers.mjs — the offline audit of every
// WMS / WMTS layer the site can draw.
//
// The audit tool is the thing that answers “check all WMS/WMTS layers”: it
// rebuilds each layer's real request with the same code the map uses
// (js/layer-registry.js plus the country LiDAR modules) and verifies it against
// the service's documented contract. This suite makes sure that answer stays
// green and that the guard covers every third-party endpoint, so a new layer
// cannot be added without either being watched or failing this test.
//
// Usage: node test-wms-layer-audit.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

console.log('[Test] WMS / WMTS layer audit (registry → real requests)...');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ══════════════════════════════════════════════════════════════
// 1. The tool runs, and finds no hard error
// ══════════════════════════════════════════════════════════════
let report;
const auditJson = path.join(os.tmpdir(), 'detectlab-wms-audit-' + process.pid + '.json');
try {
    execFileSync(process.execPath, [path.join('tools', 'audit-wms-layers.mjs'), '--json-file=' + auditJson],
        { cwd: root, encoding: 'utf8' });
    report = JSON.parse(fs.readFileSync(auditJson, 'utf8'));
    fs.unlinkSync(auditJson);
} catch (err) {
    // A non-zero exit still prints the JSON report on stdout — show why.
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch (e) { parsed = null; }
    const detail = parsed ? parsed.errors.map((e) => e.id + ' [' + e.code + '] ' + e.message).join('\n')
        : (err.stdout || '') + (err.stderr || '');
    assert.fail('tools/audit-wms-layers.mjs exits non-zero — fix these layers:\n' + detail);
}
assert(report && Array.isArray(report.layers), 'the audit returns a machine-readable report');
assert.strictEqual(report.errors.length, 0,
    'no WMS/WMTS layer breaks a hard invariant: ' +
    report.errors.map((e) => e.id + ' [' + e.code + '] ' + e.message).join('; '));
assert(report.totals.layers >= 70, 'the audit covers the whole catalogue (got ' + report.totals.layers + ')');
console.log('  ✓ ' + report.totals.layers + ' WMS/WMTS/dynamic layers audited, no errors');

// ══════════════════════════════════════════════════════════════
// 2. Every third-party endpoint is watched by the availability guard
// ══════════════════════════════════════════════════════════════
const remote = report.layers.filter((l) => l.guardPath === 'probe' || l.guardPath === 'watch');
const unwatched = report.layers.filter((l) => l.guardPath === 'none');
assert.strictEqual(unwatched.length, 0,
    'no third-party layer is left silent: ' + unwatched.map((l) => l.id + ' → ' + l.endpoint).join(', '));
assert(remote.length >= 60, 'the guard covers the catalogue (got ' + remote.length + ')');
console.log('  ✓ ' + remote.length + ' third-party layers guarded (probe or watch), 0 unwatched');

// Spot checks: the hosts that matter, with the provider name the notice shows.
const byId = new Map(report.layers.map((l) => [l.id, l]));
const expect = function (id, guardPath, provider) {
    const l = byId.get(id);
    assert(l, 'layer ' + id + ' is part of the audit (rename it in both places)');
    assert.strictEqual(l.guardPath, guardPath, id + ' must be guarded via ' + guardPath + ', got ' + l.guardPath);
    if (provider) {
        assert(l.provider.indexOf(provider) !== -1,
            id + ' must name its provider (' + provider + '), got ' + l.provider);
    }
};
expect('cenagis.ukvme', 'probe', 'CENAGIS');
expect('premium.mitteleuropa', 'probe', 'CENAGIS');
expect('hist.austrian', 'probe', 'geo-spatial.org');
expect('lidar.fr-mnh', 'probe', 'IGN France');
expect('sat.vhr-2018', 'probe', 'Copernicus');
expect('sat.corona-60s', 'watch', 'CAST');
expect('vegfp.ppi', 'watch', 'VITO');
['lidar.nl-ahn', 'lidar.no-hoydedata', 'lidar.pl-nmt', 'lidar.es-mdt',
    'lidar.ch-swisstopo', 'lidar.uk-ea'].forEach((id) => {
    const l = byId.get(id);
    assert(l && l.guardPath === 'watch' && l.provider,
        id + ' must be watched with a named provider (got ' + (l && l.guardPath) + ')');
});
console.log('  ✓ every family names its provider (CENAGIS, eHarta, IGN, Copernicus, CAST, VITO, …)');

// ASIG's 18 statically-named WMS layers (14 orthophotos + the four Heritage
// parts) stay attributed to Albania in the registry. The three WMTS-only
// layers and the resolve-by-title entries have no static WMS GetMap, so the
// registry/proxy audit deliberately excludes them (the 2D panel loads those
// directly from ASIG). This is an offline URL audit only; production status
// is established by the probe.
const ASIG_NAMES = [
    'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
    'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
    'akzm:zonat_mbrojtura_081124',
    'akzm:monumentet_natyrore_07032023',
    'Orthophoto:Ortofoto_76_86_25k', 'Orthophoto:ortofoto_94',
    'orthophoto_2007:OrthoImagery', 'orthophoto_2015:OrthoImagery',
    'orthophoto_2015:OrthoImagery_20cm', 'orthophoto_2015:OrthoImagery_8cm',
    'Orthophoto_cir:Orthophoto_CIR', 'Orthophoto_cir:Orthophoto_CIR_8cm',
    'ortofoto_2018:Ortofoto_2018', 'Orthophoto:Ortofoto_2001',
    'Orthophoto:Ortofoto_1999', 'Orthophoto:Ortofoto_1957',
    'Orthophoto:Orthofoto_1976_1980', 'Orthophoto:Fragment_Durres_1986'
];
const asig = report.layers.filter((l) => l.id.startsWith('albania.'));
const layerRegistry = require('./js/layer-registry.js');
assert.strictEqual(asig.length, 18, 'the audit contains all 18 static ASIG registry rows');
assert.deepStrictEqual(asig.map((l) => l.layer).sort(), ASIG_NAMES.slice().sort(), 'ASIG WMS Names remain exact');
assert(!asig.some((l) => ['DSM:Dsm_Hill_Group', 'Dtm_2015:Hillshade_2015_group', 'hartat_historike:italiane_100k'].includes(l.layer)),
    'WMTS-only layers are not audited as WMS (ASIG answers LayerNotDefined)');
assert(asig.every((l) => { const def = layerRegistry.get(l.id); return def && JSON.stringify(def.countries) === JSON.stringify(['AL']) && def.selfGuarded === true && def.guard === false && def.selfGuardedReason; }),
    'all ASIG registry rows are attributed to Albania alone and stay self-guarded');
assert(asig.every((l) => l.sampleTile === '12/2273/1530 (Tirana)'), 'ASIG offline samples use Tirana tile 12/2273/1530');
assert(asig.every((l) => l.sample2d.includes('STYLES=&') && /[?&]VERSION=1\.1\.1(?:&|$)/.test(l.sample2d) && /[?&]SRS=EPSG%3A3857(?:&|$)/i.test(l.sample2d)),
    'offline 2D URL construction uses the panel shape: WMS 1.1.1, SRS=EPSG:3857, empty style');
assert(asig.every((l) => /^\/api\/map3d\/tile\?layer=albania\./.test(l.sample3d) && /z=12&x=2273&y=1530/.test(l.sample3d)),
    'the audit maps each ASIG registry ID to the same-origin tile proxy at Tirana');
assert(!layerRegistry.GROUPS['albania-raster'] && !layerRegistry.GROUPS['albania-overlay'], 'no Albania-wide registry group remains');
assert(report.warnings.length === 0 && report.errors.length === 0, 'offline audit remains clean: 0 errors, 0 warnings');
assert(/offline URL construction does not verify production acceptance/.test(asig[0].findings.map((f) => f.message).join(' ')),
    'audit explicitly distinguishes URL construction from live verification');
console.log('  ✓ 18 exact ASIG Names, Tirana sample, thematic groups and proxy/self-guard invariants');

// ══════════════════════════════════════════════════════════════
// 3. The sample requests are real requests
// ══════════════════════════════════════════════════════════════
report.layers.forEach(function (l) {
    if (l.kind !== 'wms') return;
    const url = l.sample2d || '';
    assert(/^https:\/\//.test(url), l.id + ': the 2D GetMap URL is https (' + url.slice(0, 60) + ')');
    assert(/service=WMS/i.test(url) && /request=GetMap/i.test(url), l.id + ': GetMap KVP present');
    assert(new RegExp('layers=' + encodeURIComponent(l.layer).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(url),
        l.id + ': the URL asks for its own LAYERS');
    assert(/[?&]bbox=[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+/i.test(url), l.id + ': a real bbox is requested');
    const versionedCrs = /version=1\.1\.(0|1)/i.test(url) ? /[?&]srs=EPSG%3A3857/i.test(url)
        : /[?&]crs=EPSG%3A3857/i.test(url);
    const wgs84 = /(srs|crs)=EPSG%3A4326/i.test(url);
    assert(versionedCrs || wgs84, l.id + ': the version/CRS pair matches the WMS spec');
    // Values, not the whole string: “poznan_3857” contains “nan” and a
    // substring check would flag a perfectly good layer.
    const bboxNums = ((url.match(/[?&]bbox=([^&]+)/i) || [])[1] || '').split(',').map(Number);
    assert.strictEqual(bboxNums.length, 4, l.id + ': the bbox has four numbers');
    assert(bboxNums.every((n) => Number.isFinite(n)) && bboxNums[2] > bboxNums[0] && bboxNums[3] > bboxNums[1],
        l.id + ': the bbox is finite and increasing');
    url.split(/[?&]/).slice(1).forEach(function (kv) {
        const value = kv.slice(kv.indexOf('=') + 1);
        assert(!/^(undefined|null|nan|infinity)$/i.test(value),
            l.id + ': parameter ' + kv.split('=')[0] + ' leaked a placeholder (' + value + ')');
    });
});
report.layers.filter((l) => l.kind === 'wmts').forEach(function (l) {
    const url = l.sample2d || '';
    ['SERVICE=WMTS', 'REQUEST=GetTile', 'TILEMATRIXSET=', 'TILEMATRIX=', 'TILEROW=', 'TILECOL=']
        .forEach((needle) => assert(url.indexOf(needle) !== -1, l.id + ': WMTS KVP carries ' + needle));
    assert(!/\{z\}|\{x\}|\{y\}/.test(url), l.id + ': the sample resolves the tile placeholders');
});
console.log('  ✓ every sample request is KVP-correct and fully resolved');

// ══════════════════════════════════════════════════════════════
// 4. The country modules really build URLs in Node
// ══════════════════════════════════════════════════════════════
Object.keys(report.modules).forEach(function (name) {
    const m = report.modules[name];
    assert(m.present, 'js module for ' + name + ' exists (' + m.file + ')');
    assert(m.loaded, name + ' loads in the audit sandbox (' + (m.error || 'ok') + ')');
});
report.layers.filter((l) => l.kind === 'dynamic' && !l.runtime && l.endpoint && l.endpoint.indexOf('/') !== 0)
    .forEach(function (l) {
        assert(l.sample2d && l.sample2d.indexOf('http') === 0,
            l.id + ' returns a concrete tile URL (' + l.sample2d + ')');
    });
console.log('  ✓ ' + Object.keys(report.modules).length +
    ' country modules load and build their tile URLs');

// ══════════════════════════════════════════════════════════════
// 5. The generated report matches the registry (no doc drift)
// ══════════════════════════════════════════════════════════════
const doc = read('WMS_WMTS_LAYER_AUDIT.md');
report.layers.forEach(function (l) {
    assert(doc.indexOf('`' + l.id + '`') !== -1,
        'WMS_WMTS_LAYER_AUDIT.md documents ' + l.id +
        ' — regenerate it with: node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md');
});
assert(/node tools\/audit-wms-layers\.mjs --write=WMS_WMTS_LAYER_AUDIT\.md/.test(doc),
    'the report says how to regenerate itself');
const guardSource = read('js/wms-health.js');
report.guardHosts.forEach(function (host) {
    assert(doc.indexOf(host) !== -1 || guardSource.indexOf(host) !== -1,
        'host ' + host + ' is documented in the guard or the report');
});
console.log('  ✓ the report lists every audited layer and host');

// ══════════════════════════════════════════════════════════════
// 6. The provider list is the one the guard uses
// ══════════════════════════════════════════════════════════════
report.guardHosts.forEach(function (host) {
    assert(guardSource.indexOf("'" + host + "'") !== -1,
        host + ' is declared in js/wms-health.js HOSTS');
});
assert(report.guardHosts.length >= 12, 'the guard watches every third-party family (got ' +
    report.guardHosts.length + ')');
console.log('  ✓ ' + report.guardHosts.length + ' guarded hosts cross-checked against js/wms-health.js');

// ══════════════════════════════════════════════════════════════
// 7. The report answers the questions the audit exists for
// ══════════════════════════════════════════════════════════════
['## The three errors that started this audit',
 '## What is checked',
 '### Small print',
 '## The layers',
 '## What a failure looks like, per provider',
 '## Deployment requirements (server side)',
 '## Sample request URLs',
 '## What to do when one of them breaks'].forEach(function (heading) {
    assert(doc.indexOf(heading) !== -1, 'WMS_WMTS_LAYER_AUDIT.md has the "' + heading + '" section');
});
// The three reported errors are all accounted for, with owner attribution.
assert(/ukvme_3857/.test(doc) && /kdr_3857/.test(doc),
    'the CENAGIS 200-with-a-Java-exception failure is documented with its layers');
assert(/ImageInputStream/.test(doc), 'the ECW/ImageInputStream root cause is quoted');
assert(/dataforsyningen_token_missing/.test(doc),
    'the Dataforsyningen token failure and the proxy’s 401 body are documented');
assert(/external/.test(doc), 'the report says which failures are out of our control');

// ══════════════════════════════════════════════════════════════
// 8. Every module that hides a tile failure still reports it
// ══════════════════════════════════════════════════════════════
Object.keys(report.modules).forEach(function (name) {
    const m = report.modules[name];
    if (!m.present) return;
    const src = read(m.file);
    if (!/done\(null\s*,\s*(tile|canvas)\)/.test(src)) return;
    // `noteLayerFailure` is the ASIG module's own visible path: its layers opt
    // out of the guard (_detectlabNoGuard) and persistent failures land as a
    // status on the catalogue row instead of flipping the switch.
    const hasOwnPath = /showAuthNotice|reportUnavailable|TOKEN_MISSING_MESSAGE|noteFailure|noteLayerFailure/.test(src);
    assert(hasOwnPath,
        m.file + ' hides a failed tile from Leaflet but neither reports it to the guard ' +
        '(DetectLabWmsHealth.noteFailure) nor shows its own notice');
});
const guardSrc = read('js/wms-health.js');
assert(/noteFailure: noteFailure/.test(guardSrc),
    'DetectLabWmsHealth exposes noteFailure() for the modules that swallow tile errors');
['js/ahn-layer.js', 'js/hoydedata-layer.js'].forEach(function (file) {
    assert(read(file).indexOf('noteFailure') !== -1,
        file + ' reports its swallowed tile failures to the guard');
    assert(read(file).indexOf('reportTileFailure') !== -1, file + ' has the reporting helper');
});
console.log('  ✓ modules that hide tile failures still report them to the guard');

// ══════════════════════════════════════════════════════════════
// 9. The CENAGIS repoint stays put (2026-10-15)
// ══════════════════════════════════════════════════════════════
// The Web-Mercator mosaic of two IH PAN sheets cannot be read by the
// provider's GeoServer at all (a 200 with a Java ECW exception as the body),
// which is what put “This map cannot be loaded” on two panel rows. Both rows
// — and the premium row that shows the same sheet — must ask for the readable
// EPSG:2180 twin instead, and this test fails if a refactor sends them back.
const REPOINTED = {
    'cenagis.ukvme': { layer: 'ihpan:ukvme_2180', dead: 'ihpan:ukvme_3857', twin: 'premium.mitteleuropa' },
    'cenagis.kdr': { layer: 'ihpan:kdr_2180', dead: 'ihpan:kdr_3857', twin: 'premium.kdr-100k' }
};
Object.keys(REPOINTED).forEach(function (id) {
    const spec = REPOINTED[id];
    const row = byId.get(id);
    assert(row, id + ' is still in the registry');
    assert(row.layer === spec.layer,
        id + ' must ask for ' + spec.layer + ' (the readable mosaic), not ' + row.layer);
    assert(row.layer !== spec.dead, id + ' must not ask for the unreadable ' + spec.dead);
    assert(row.findings.some(function (f) { return f.code === 'REPOINTED'; }),
        id + ' carries a REPOINTED finding so the audit shows why it is not on the _3857 twin');
    assert(row.findings.every(function (f) { return f.code !== 'W_DEAD_MOSAIC'; }),
        id + ' must not trip W_DEAD_MOSAIC');
    // 3D: the proxy asks the sheet in its own CRS (the catalogued 2180-only path)
    assert(row.sample3d.indexOf('/api/map3d/tile?layer=' + id) === 0,
        id + ' goes through the same-origin 3D proxy');
    // 2D: the map asks the service for EPSG:3857 tiles, which the GeoServer
    // re-projects on the fly for these twins.
    const twin = byId.get(spec.twin);
    assert(twin, spec.twin + ' (the panel row users see) is still in the registry');
    assert(twin.layer === spec.layer,
        spec.twin + ' must name the same mosaic as ' + id + ' — they had drifted apart');
    assert(/srs=EPSG%3A3857/.test(twin.sample2d) && /layers=ihpan%3A/.test(twin.sample2d),
        spec.twin + ' asks the WMS for EPSG:3857 tiles');
});
assert(!report.layers.some(function (l) { return l.layer === 'ihpan:ukvme_3857'; }),
    'no registry row asks for the unreadable ihpan:ukvme_3857 mosaic');
assert(!report.layers.some(function (l) { return l.layer === 'ihpan:kdr_3857'; }),
    'no registry row asks for the unreadable ihpan:kdr_3857 mosaic');
const healthDoc = read('CENAGIS_WMS_HEALTH.md');
assert(healthDoc.indexOf('## When the sheet') !== -1 && /_2180/.test(healthDoc),
    'CENAGIS_WMS_HEALTH.md documents the repoint and how to revert it');
assert(doc.indexOf('## The CENAGIS repoint (2026-10-15)') !== -1,
    'the generated audit has a §CENAGIS repoint section');
console.log('  ✓ the two IH PAN sheets stay on their readable 2180 mosaic (2D 3857 · 3D proxy 2180)');

console.log('\n✅ test-wms-layer-audit.js passed all checks successfully.');
