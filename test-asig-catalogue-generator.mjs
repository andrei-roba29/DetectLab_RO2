#!/usr/bin/env node
/*
 * Offline regression for tools/build-asig-catalogue.mjs — the generator that
 * turns the prototype's asig-layers.json export into data/asig-layers.json and
 * its browser mirror data/asig-layers.data.js.
 *
 * No network: the export is synthesised from the curated spec, which is exactly
 * the shape the prototype's "Export layer list (JSON)" button produces.
 *
 * Covered:
 *   • sections, order, counts and the three tile-only rows;
 *   • every row of a complete export is resolved by title;
 *   • a curated name is authoritative when the export has no row for the title,
 *     the export wins when a row is marked `resolve`;
 *   • the archaeology keyword rule appends parts to Heritage, once each;
 *   • a missing title stops a strict build and becomes `resolveByTitle` only
 *     with --allow-unresolved;
 *   • both output files come from the same object, and the committed pair is
 *     up to date (what `--check` verifies in CI).
 *
 * Usage: node test-asig-catalogue-generator.mjs
 */
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    CATALOGUE_SPEC, HERITAGE_SPEC, SERVICE, ZOOM,
    buildCatalogue, normalizeTitle, renderJsModule, writeFiles
} from './tools/build-asig-catalogue.mjs';

console.log('[ASIG] catalogue generator · title resolution · keyword rule · strict builds');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

/* ── 1. every layer the spec declares, flattened ──────────────────────────── */
const SPEC_ROWS = CATALOGUE_SPEC.reduce((rows, section) => rows.concat(section.layers), []);
check(SPEC_ROWS.length === 29, '29 rows are curated (28 catalogue + the retained 1:50k sheet)');
check(SPEC_ROWS.filter((row) => row.kind === 'wmts').length === 3, 'three rows are tile-only');
check(new Set(SPEC_ROWS.map((row) => row.id)).size === SPEC_ROWS.length, 'every row id is unique');
check(CATALOGUE_SPEC.map((section) => section.title).join(',') ===
    'Orthophotos,Terrain,Cadastre,Maps,Environment,Planning & mining',
    'section order is the owner’s order');

/* Titles are the portal's own — the misspelt one included. */
check(SPEC_ROWS.some((row) => row.title === 'Mineral Resouces'),
    'the portal’s misspelt “Mineral Resouces” is kept verbatim');
check(SPEC_ROWS.some((row) => row.title === '25k_krgjsh_1'),
    'the sheet whose title carries the raw name is kept verbatim');

/* ── 2. title folding used to match the export ────────────────────────────── */
check(normalizeTitle('Ortofoto  Durrës 1986') === normalizeTitle('ortofoto durres 1986'),
    'accented and unaccented titles fold to the same key');
check(normalizeTitle('Planning & mining') === 'planning and mining', 'ampersands fold to “and”');
check(normalizeTitle('  Mineral   Resouces ') === 'mineral resouces', 'spacing is folded');

/* ── 3. a synthetic export shaped like the prototype's ────────────────────── */
function synthExport(options) {
    options = options || {};
    const skip = new Set(options.skip || []);
    const groups = CATALOGUE_SPEC.map((section) => ({
        title: section.title,
        layers: section.layers
            .filter((row) => !skip.has(row.title))
            .map((row) => {
                const name = row.name || ('ws_' + row.id + ':' + row.id.replace(/_/g, ''));
                return {
                    title: row.title,
                    name: name,
                    kind: row.kind === 'wmts' ? 'wmts' : 'wms',
                    url: row.kind === 'wmts' ? SERVICE.wmts : SERVICE.root + name.split(':')[0] + '/wms',
                    fallbackUrl: row.kind === 'wmts' ? undefined : SERVICE.wms
                };
            })
    }));
    const heritage = {
        title: 'Heritage',
        parts: HERITAGE_SPEC.parts.map((part) => ({
            title: part.title,
            name: part.name,
            url: SERVICE.root + String(part.name).split(':')[0] + '/wms'
        })).concat(options.extraHeritage || [])
    };
    return { generatedAt: '2026-10-24T00:00:00.000Z', groups, heritage, notFound: [] };
}

const full = buildCatalogue(synthExport({
    extraHeritage: [
        { title: 'Zona arkeologjike Krujë (DCM 347)', name: 'akzm:arkeologjike_kruje', url: SERVICE.root + 'akzm/wms' },
        { title: 'Zona arkeologjike Shkodër (DCM 347)', name: 'akzm:arkeologjike_shkoder', url: SERVICE.root + 'akzm/wms' },
        { title: 'Zona arkeologjike Lin (nënujore)', name: 'akzm:arkeologjike_lin', url: SERVICE.root + 'akzm/wms' }
    ]
}), {});

check(full.sections.length === 6, 'six sections');
check(full.sections.map((section) => section.layers.length).join(',') === '14,2,3,3,1,6',
    'per-section counts: 14 / 2 / 3 / 3 / 1 / 6');
check(full.unresolved.length === 0, 'a complete export leaves nothing unresolved');
check(full.sections.every((section) => section.layers.every((row) => row.name)),
    'every row of a complete export gets its exact name');

/* A row the spec does not name is resolved from the export. */
const cadastral = full.sections[2].layers[0];
check(cadastral.name === 'ws_cadastral_zone:cadastralzone', 'a named-by-export row takes the export’s name');
check(cadastral.nameSource === 'export', 'and records where the name came from');
check(cadastral.url.endsWith('/ws_cadastral_zone/wms'), 'and keeps the per-workspace endpoint');
check(cadastral.fallbackUrl === SERVICE.wms, 'with the global WMS as its retry');

/* A name curated in the spec is only replaced where the spec says so. */
const ortho20 = full.sections[0].layers.find((row) => row.id === 'ortho_2015_20cm');
check(ortho20.name === 'orthophoto_2015:OrthoImagery_20cm' && ortho20.nameSource === 'repo',
    'a curated name is not replaced by an export row for the same title');
const renamed = buildCatalogue((() => {
    const data = synthExport();
    data.groups[0].layers.find((row) => row.title === 'Ortofoto 2015 (20 cm)').name = 'Orthophoto:Something_Else';
    return data;
})(), {});
check(renamed.sections[0].layers.find((row) => row.id === 'ortho_2015_20cm').name ===
    'orthophoto_2015:OrthoImagery_20cm', 'the curated name still wins when the export disagrees');

/* Tile-only rows point at the WMTS and never at a WMS. */
const wmtsRows = full.sections.reduce((rows, section) => rows.concat(section.layers), [])
    .filter((row) => row.kind === 'wmts');
check(wmtsRows.map((row) => row.name).join(',') ===
    'Dtm_2015:Hillshade_2015_group,DSM:Dsm_Hill_Group,hartat_historike:italiane_100k',
    'the three tile-only names are the prototype’s');
check(wmtsRows.every((row) => row.url === SERVICE.wmts && row.fallbackUrl === null),
    'tile-only rows have no WMS fallback');
check(wmtsRows.every((row) => row.maxNativeZoom === ZOOM.wmtsMaxNative), 'tile-only rows use the WMTS zoom ceiling');

/* ── 4. Heritage: one toggle, every part, each part once ──────────────────── */
check(full.heritage.id === 'heritage' && full.heritage.title === 'Heritage', 'Heritage is one entry');
check(full.heritage.keyword === 'archaeolog|archeolog|arkeolog', 'the archaeology rule is published in the catalogue');
const baked = full.heritage.parts.filter((part) => !part.dynamic);
check(baked.length === HERITAGE_SPEC.parts.length + 3, 'the three archaeological layers join the four known parts');
check(baked.filter((part) => part.keywordMatch).length === 3, 'only the keyword-matched parts are flagged');
check(new Set(baked.map((part) => part.name)).size === baked.length, 'no part is listed twice');
check(full.heritage.parts.filter((part) => part.dynamic).length === 1,
    'exactly one dynamic rule carries the parts discovered in the browser');
check(full.heritage.parts.every((part) => part.dynamic || (part.name && part.url && part.fallbackUrl)),
    'every baked part has a name and an endpoint to fall back to');

/* A part the export renames follows the export (the names embed dates). */
const heritageRenamed = buildCatalogue((() => {
    const data = synthExport();
    data.heritage.parts[0].name = 'akzm:zonat_mbrojtura_01012027';
    return data;
})(), {});
check(heritageRenamed.heritage.parts[0].name === 'akzm:zonat_mbrojtura_01012027',
    'a re-published Heritage part follows the export instead of a stale name');

/* ── 5. strict by default; unresolved only on request ─────────────────────── */
let strictError = null;
try {
    buildCatalogue(synthExport({ skip: ['Mineral Resouces', 'Water course link'] }), {});
} catch (error) {
    strictError = error;
}
check(strictError && strictError.unresolvedTitles.length === 2, 'two missing titles stop a strict build');
check(/Mineral Resouces/.test(strictError.message) && /Water course link/.test(strictError.message),
    'the error names the titles the export is missing');

const lenient = buildCatalogue(synthExport({ skip: ['Mineral Resouces'] }), { allowUnresolved: true });
const mineral = lenient.sections[5].layers.find((row) => row.title === 'Mineral Resouces');
check(mineral.name === null && mineral.nameSource === 'unresolved',
    'a lenient build writes a null name instead of a guess');
check(mineral.resolveByTitle === 'Mineral Resouces', 'and records the title to resolve at run time');
check(mineral.url === SERVICE.wms, 'an unresolved row still has the global endpoint to ask');
check(lenient.unresolved.includes('Mineral Resouces'), 'and the catalogue lists it as unresolved');

/* ── 6. one object → two artefacts, and the committed pair is current ─────── */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asig-catalogue-'));
const outputs = { json: path.join(temp, 'asig-layers.json'), js: path.join(temp, 'asig-layers.data.js') };
writeFiles(full, outputs);
const writtenJson = JSON.parse(fs.readFileSync(outputs.json, 'utf8'));
const writtenJs = fs.readFileSync(outputs.js, 'utf8');
check(writtenJs === renderJsModule(writtenJson), 'the browser mirror is generated from the same object');
check(writtenJs.includes('root.ASIG_LAYERS_CATALOGUE = data;'), 'the mirror exposes the catalogue on window');
check(writtenJs.includes('module.exports = data;'), 'and can be required from Node');
check(fs.readFileSync(outputs.json, 'utf8').trim().endsWith('}'), 'the JSON file is valid and newline-terminated');
check(writtenJson.licence.state === 'unverified', 'the licence is recorded as unverified, never guessed');
check(writtenJson.attribution.includes('ASIG'), 'the attribution names ASIG');
check(writtenJson.service.wmtsTileMatrixSet === 'EPSG:4326', 'the WMTS matrix set is the plate-carrée one');
fs.rmSync(temp, { recursive: true, force: true });

execFileSync(process.execPath, ['tools/build-asig-catalogue.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
check(true, 'the committed catalogue matches what the generator produces today');

const committed = JSON.parse(read('data/asig-layers.json'));
check(committed.sections.map((section) => section.id).join(',') ===
    CATALOGUE_SPEC.map((section) => section.id).join(','), 'the committed sections follow the curated order');
check(committed.sections.reduce((sum, section) => sum + section.layers.length, 0) === SPEC_ROWS.length,
    'the committed catalogue has every curated row');
const unresolvedRows = committed.sections.reduce((rows, section) =>
    rows.concat(section.layers.filter((row) => !row.name)), []);
check(unresolvedRows.every((row) => row.resolveByTitle && row.nameSource === 'unresolved'),
    'every row without a name carries the title the browser resolves');
check(committed.heritage.parts.every((part) => part.dynamic || part.name),
    'every committed Heritage part is named');

console.log(`[ASIG] generator: ${checks} checks passed (offline only).`);
