#!/usr/bin/env node
/*
 * tools/build-asig-catalogue.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Regenerates data/asig-catalogue.json — the interchange copy of the ASIG
 * (geoportal.asig.gov.al) layer catalogue — from the single source of truth,
 * js/asig-albania-layers.config.js.
 *
 * The site itself never reads the JSON (the panel is built from the JS
 * config); the JSON exists so the catalogue can be diffed, handed to
 * tools/resolve_layers.py, or compared against the owner's asig-layers.json
 * export without executing site code.
 *
 * Usage:
 *   node tools/build-asig-catalogue.mjs           # write data/asig-catalogue.json
 *   node tools/build-asig-catalogue.mjs --check   # exit 1 if the file is stale
 *   node tools/build-asig-catalogue.mjs --out=path/to/file.json
 *
 * No network access: this only reshapes repository data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CONFIG = require(path.join(repoRoot, 'js/asig-albania-layers.config.js'));

const checkOnly = process.argv.includes('--check');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg
    ? path.resolve(outArg.slice('--out='.length))
    : path.join(repoRoot, 'data', 'asig-catalogue.json');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

const panelEntries = CONFIG.panelOrder().map((entry) => {
    if (entry.kind === 'group') {
        return {
            id: entry.id,
            kind: 'group',
            section: entry.section,
            title: clone(entry.title),
            partIds: clone(entry.partIds),
            keyword: CONFIG.heritage.keyword,
            note: 'ONE panel toggle; its WMS parts are the layers[] entries with heritagePart:true ' +
                'plus every capabilities layer matching the keyword at runtime. Parts are never panel rows.'
        };
    }
    return {
        id: entry.id,
        kind: entry.kind,
        section: entry.section,
        title: clone(entry.title),
        layers: entry.layers || null,
        resolveTitle: entry.resolveTitle || null
    };
});

const catalogue = {
    generatedBy: 'node tools/build-asig-catalogue.mjs',
    sourceOfTruth: 'js/asig-albania-layers.config.js',
    doNotEditByHand: 'Regenerate this file; edit the JS config instead.',
    version: CONFIG.version,
    provider: CONFIG.provider,
    country: CONFIG.country,
    countryBounds: clone(CONFIG.countryBounds),
    attribution: CONFIG.attribution,
    licence: CONFIG.licence,
    endpoints: clone(CONFIG.endpoints),
    wms: clone(CONFIG.wms),
    wmts: clone(CONFIG.wmts),
    discovery: clone(CONFIG.discovery),
    sections: clone(CONFIG.sections),
    countsBySection: CONFIG.countsBySection(),
    totals: {
        panelEntries: panelEntries.length,
        panelTileRows: CONFIG.panelLayers().length,
        tileDefinitions: CONFIG.layers.length,
        staticWmsNames: CONFIG.layers.filter((l) => l.kind === 'wms' && l.layers).length,
        wmtsOnly: CONFIG.layers.filter((l) => l.kind === 'wmts').map((l) => l.layers),
        resolveByTitle: CONFIG.layers.filter((l) => !l.layers && l.resolveTitle).map((l) => l.resolveTitle)
    },
    heritage: {
        id: CONFIG.heritage.id,
        title: clone(CONFIG.heritage.title),
        partIds: clone(CONFIG.heritage.partIds),
        keyword: CONFIG.heritage.keyword,
        staticDiscovered: clone(CONFIG.heritage.staticDiscovered),
        opacity: CONFIG.heritage.opacity,
        description: CONFIG.heritage.description
    },
    panelEntries,
    layers: clone(CONFIG.layers)
};

const rendered = JSON.stringify(catalogue, null, 2) + '\n';

if (checkOnly) {
    let current = '';
    try { current = fs.readFileSync(outPath, 'utf8'); } catch (e) { /* missing = stale */ }
    if (current !== rendered) {
        console.error('STALE: ' + path.relative(repoRoot, outPath) +
            ' — regenerate with: node tools/build-asig-catalogue.mjs');
        process.exit(1);
    }
    console.log('up to date: ' + path.relative(repoRoot, outPath));
} else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, rendered, 'utf8');
    console.log('wrote ' + path.relative(repoRoot, outPath) +
        ' (' + catalogue.totals.panelEntries + ' panel entries, ' +
        catalogue.totals.tileDefinitions + ' tile definitions, ' +
        catalogue.totals.staticWmsNames + ' static WMS names, ' +
        catalogue.totals.wmtsOnly.length + ' WMTS-only, ' +
        catalogue.totals.resolveByTitle.length + ' resolve-by-title)');
}
