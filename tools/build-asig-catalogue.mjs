#!/usr/bin/env node
/*
 * ASIG catalogue generator — turns the prototype's layer export into
 * data/asig-layers.json (and its browser mirror data/asig-layers.data.js).
 *
 * The Albanian catalogue is not written by hand because ASIG keeps publishing
 * new layers (each archaeological zoning decision is a new WMS layer) and
 * because a WMS name must never be guessed: `workspace:layer` is exactly what
 * the service answers, and a typo produces a silent, blank map.
 *
 * INPUT
 *   asig-layers.json — the export of the prototype viewer
 *   (its "Export layer list (JSON)" button). Shape:
 *     { groups: [{ title, layers: [{ title, name, url?, fallbackUrl?, kind? }] }],
 *       heritage: { parts: [ { title, name, url?, fallbackUrl? } ] }, notFound: [] }
 *   The export is the source of truth for display titles and for the WMS name
 *   of every layer whose name was resolved there (the portal's GetCapabilities
 *   is not reachable from every network: ASIG blacklists some cloud ranges).
 *
 * OUTPUT
 *   data/asig-layers.json      — the catalogue (sections, order, names, endpoints,
 *                                Heritage parts, licence notice).
 *   data/asig-layers.data.js   — the same object as a plain <script> with a
 *                                CommonJS branch, so the browser, the Node tests
 *                                and the audit tools read one source.
 *
 * USAGE
 *   node tools/build-asig-catalogue.mjs --export=asig-layers.json
 *   node tools/build-asig-catalogue.mjs --check          # verify the committed files
 *   node tools/build-asig-catalogue.mjs --allow-unresolved
 *        Bootstrap only: rows that the export does not name are written with
 *        `"name": null` and `resolveByTitle`, and the browser fills them in from
 *        the service's GetCapabilities at run time. Without this flag an
 *        unmatched title stops the build — a catalogue must not ship a layer
 *        name nobody verified.
 *
 * The curated part (which sections exist, in which order, under which title,
 * which rows are tile-only, the Heritage rule, the defaults) lives below in
 * CATALOGUE_SPEC / HERITAGE_SPEC. Names, endpoints and the archaeological parts
 * come from the export.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_JSON = path.join(ROOT, 'data', 'asig-layers.json');
const OUT_JS = path.join(ROOT, 'data', 'asig-layers.data.js');

/* ══════════════════════════════════════════════════════════════════════════
   ASIG endpoints
   ══════════════════════════════════════════════════════════════════════════
   The geoportal publishes one WMS per workspace (/service/<workspace>/wms) and
   a global WMS (/service/wms) that also answers workspace-qualified names —
   the prototype asks the workspace route first and retries the global one.
   The WMTS is a GeoWebCache with two matrix sets (EPSG:6870, EPSG:4326) and no
   Web-Mercator grid, which is why the three tile-only layers are reprojected
   in the browser instead of being drawn by Leaflet directly. */
const SERVICE = {
    root: 'https://geoportal.asig.gov.al/service/',
    wms: 'https://geoportal.asig.gov.al/service/wms',
    wmts: 'https://geoportal.asig.gov.al/service/wmts',
    wmtsMatrixSet: 'EPSG:4326',
    attribution: 'Data: ASIG, Albanian State Authority for Geospatial Information (geoportal.asig.gov.al)'
};

/* The portal's own licence page states nothing about reuse of the tiles. Kind
 * of a placeholder: the UI shows it, the report flags it, and nobody has to
 * guess a licence. Confirm with ASIG before commercial use. */
const LICENCE = {
    state: 'unverified',
    holder: 'ASIG — Autoriteti Shtetëror për Informacionin Gjeohapësinor',
    url: 'https://geoportal.asig.gov.al',
    note: 'ASIG has not published reuse terms for this service. Treat the tiles as © ASIG, all rights reserved, until confirmed in writing.'
};

const ZOOM = { min: 7, wmsMaxNative: 19, orthoMaxNative: 18, wmtsMaxNative: 20, max: 22 };

/* ══════════════════════════════════════════════════════════════════════════
   THE CURATED SPEC
   ══════════════════════════════════════════════════════════════════════════
   `name` is filled in from the export when it is omitted; `name` written here is
   authoritative (the export can only supply the endpoints for it). `resolve`
   marks a row whose WMS name the export did not resolve yet: it gets
   `resolveByTitle` and is filled in at run time. Titles are the portal's own,
   verbatim — including the misspelt "Mineral Resouces". */
const CATALOGUE_SPEC = [
    {
        id: 'orthophotos',
        title: 'Orthophotos',
        note: 'Aerial imagery by survey year. Older flights are the ones metal detecting reports are usually drawn on.',
        registry: { group: 'sat-hist', z: 400 },
        layers: [
            /* Only the two names the site already served are baked. Every
             * other flight waits for the export (or the browser resolver):
             * `Orthophoto:Ortofoto_1999` and `Orthophoto:Ortofoto_2015` look
             * alike, and one wrong guess is a blank map with no error. */
            { id: 'ortho_76_86_25k', title: 'Ortofoto 76 86 25k', resolve: true, opacity: 1 },
            { id: 'orto_94', title: 'Ortofoto 94', resolve: true, opacity: 1 },
            { id: 'ortho_2007', title: 'Ortofoto 2007', resolve: true, opacity: 1 },
            { id: 'ortho_2015', title: 'Ortofoto 2015', resolve: true, opacity: 1 },
            { id: 'ortho_2015_20cm', title: 'Ortofoto 2015 (20 cm)', name: 'orthophoto_2015:OrthoImagery_20cm', opacity: 1 },
            { id: 'ortho_2015_8cm', title: 'Ortofoto 2015 (8 cm)', resolve: true, opacity: 1 },
            { id: 'ortho_cir', title: 'Ortofoto CIR', resolve: true, opacity: 1 },
            { id: 'ortho_cir_8cm', title: 'Ortofoto CIR (8 cm)', resolve: true, opacity: 1 },
            { id: 'ortho_2018', title: 'Ortofoto 2018', resolve: true, opacity: 1 },
            { id: 'ortho_2001', title: 'Ortofoto 2001', resolve: true, opacity: 1 },
            { id: 'ortho_1999', title: 'Ortofoto 1999', name: 'Orthophoto:Ortofoto_1999', opacity: 1 },
            { id: 'ortho_1957', title: 'Ortofoto 1957', resolve: true, opacity: 1 },
            { id: 'ortho_1976_1980', title: 'Ortofoto 1976–1980', resolve: true, opacity: 1 },
            { id: 'ortho_durres_1986', title: 'Ortofoto Durrës 1986', resolve: true, opacity: 1 }
        ]
    },
    {
        id: 'terrain',
        title: 'Terrain',
        note: 'Hillshade and surface model. Both are published as WMTS tiles only.',
        registry: { group: 'lidar', z: 610 },
        layers: [
            { id: 'hillshade_2015', title: 'Hillshade 2015', kind: 'wmts', name: 'Dtm_2015:Hillshade_2015_group', opacity: 0.5 },
            { id: 'dsm_hill', title: 'Dsm Hill Group', kind: 'wmts', name: 'DSM:Dsm_Hill_Group', opacity: 0.6 }
        ]
    },
    {
        id: 'cadastre',
        title: 'Cadastre',
        note: 'Cadastral zones and parcels. Exact WMS names are read from the export.',
        registry: { group: 'uat', z: 402 },
        layers: [
            { id: 'cadastral_zone', title: 'Cadastral Zone', resolve: true, opacity: 0.85 },
            { id: 'cadastral_parcels', title: 'Cadastral Parcels', resolve: true, opacity: 0.85 },
            { id: 'cadastral_parcels_ashk', title: 'Cadastral Parcels (ASHK)', resolve: true, opacity: 0.85 }
        ]
    },
    {
        id: 'maps',
        title: 'Maps',
        note: 'Historical maps and the topographic series.',
        registry: { group: 'hist-free', z: 640 },
        layers: [
            { id: 'italiane_100k', title: 'italiane 100k', kind: 'wmts', name: 'hartat_historike:italiane_100k', opacity: 1 },
            { id: 'krgjsh_25k', title: '25k_krgjsh_1', resolve: true, opacity: 0.85 },
            /* Not one of the geoportal's 28: it shipped with the first Albanian
             * block of this site. Kept so removing the catalogue cannot remove a
             * layer somebody already uses; delete this row to drop it. */
            { id: 'topo50k', title: 'Topographic map 1:50k', name: 'Topografike:50K_Topografike', opacity: 1, retained: true }
        ]
    },
    {
        id: 'environment',
        title: 'Environment',
        note: 'Water courses and water bodies.',
        registry: { group: 'asig-env', z: 618 },
        layers: [
            { id: 'water_course', title: 'Water course link', resolve: true, opacity: 0.9 }
        ]
    },
    {
        id: 'planning',
        title: 'Planning & mining',
        note: 'Mining hazard and planning areas by Council of Ministers decision (DCM / VKM).',
        registry: { group: 'asig-plan', z: 646 },
        layers: [
            { id: 'planned_areas_dcm347', title: 'Areas Planned by (DCM 347)', resolve: true, opacity: 0.85 },
            { id: 'mining_hazard_dcm726', title: 'Mining Hazardous Areas (DCM 726)', resolve: true, opacity: 0.85 },
            { id: 'mining_hazard_dcm347', title: 'Mining Hazardous Areas (DCM 347)', resolve: true, opacity: 0.85 },
            { id: 'old_mining_areas', title: 'Old Mining Areas', resolve: true, opacity: 0.85 },
            { id: 'mineral_resources', title: 'Mineral Resouces', resolve: true, opacity: 0.85 },
            { id: 'mining_permits', title: 'Mining exploitation permits', resolve: true, opacity: 0.85 }
        ]
    }
];

/* ══════════════════════════════════════════════════════════════════════════
   HERITAGE — ONE toggle, several layers
   ══════════════════════════════════════════════════════════════════════════
   The parts are switched on together and never appear as rows. Four of them are
   known by name; the Council of Ministers archaeological zoning decisions are
   discovered by title/name keyword, because ASIG adds a layer for every new
   decision (Kruja, Elbasan, Shkodra, Vlora, Saranda/Lëkurës, Pogradec,
   Gradishta Selcë, the Lin underwater zone, …). */
const HERITAGE_SPEC = {
    id: 'heritage',
    title: 'Heritage',
    note: 'Protected areas, natural monuments, protected cultural sites and every archaeological zone published by ASIG.',
    opacity: 0.85,
    keyword: 'archaeolog|archeolog|arkeolog',
    parts: [
        { title: 'Natural Protected Areas', name: 'akzm:zonat_mbrojtura_081124' },
        { title: 'Natural monument', name: 'akzm:monumentet_natyrore_07032023' },
        /* Protected cultural sites. The names carry their publication date and
         * change with every re-publish, so the export overrides them; the values
         * below are the ones recorded from the service's own capabilities. */
        {
            title: 'Cultural protected sites (point)', resolve: true,
            name: 'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026', nameSource: 'repo'
        },
        {
            title: 'Cultural protected sites (polygon)', resolve: true,
            name: 'iktk:zonatembrojturatetrashegimisekulturore22_07_2026', nameSource: 'repo'
        }
    ]
};

/* ══════════════════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════════════════ */

/** Comparison form of a display title: case, punctuation and spacing folded. */
function normalizeTitle(value) {
    let text = String(value == null ? '' : value).toLowerCase();
    /* Fold diacritics: the export and the portal do not always spell "Durrës"
     * or "Shkodër" the same way, and a title match must not depend on that. */
    if (text.normalize) text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return text
        .replace(/[’'`´]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function workspaceOf(name) {
    const match = /^([^:]+):/.exec(String(name || ''));
    return match ? match[1] : null;
}

function wmsUrlFor(name, fallback) {
    if (fallback) return fallback;
    const workspace = workspaceOf(name);
    return workspace ? SERVICE.root + workspace + '/wms' : SERVICE.wms;
}

/** Every layer record the export contains, groups and Heritage parts alike. */
function poolOf(exportData) {
    const pool = [];
    const seen = new Set();
    const push = (record) => {
        if (!record || !record.name) return;
        const key = normalizeTitle(record.name);
        if (seen.has(key)) return;
        seen.add(key);
        pool.push({
            title: String(record.title || record.name),
            name: String(record.name),
            kind: record.kind === 'wmts' || record.type === 'wmts' ? 'wmts' : 'wms',
            url: record.url || (record.kind === 'wmts' ? SERVICE.wmts : wmsUrlFor(record.name)),
            fallbackUrl: record.fallbackUrl || (record.kind === 'wmts' ? null : SERVICE.wms)
        });
    };
    ((exportData && exportData.groups) || []).forEach((group) => {
        ((group && group.layers) || []).forEach(push);
    });
    ((exportData && exportData.heritage && exportData.heritage.parts) || []).forEach(push);
    return pool;
}

/** The export record for a curated row: by title first, then by name. */
function matchRecord(pool, spec, used) {
    const title = normalizeTitle(spec.title);
    const byTitle = pool.find((record) => !used.has(record.name) && normalizeTitle(record.title) === title);
    if (byTitle) return byTitle;
    if (spec.name) {
        const target = String(spec.name).toLowerCase();
        const byName = pool.find((record) => !used.has(record.name) && record.name.toLowerCase() === target);
        if (byName) return byName;
        /* "Ortofoto 94" vs "Orthophoto:Ortho_94": the last segment is often the
         * only human-readable part of a name, so compare it too. */
        const segment = target.split(':').pop();
        return pool.find((record) => !used.has(record.name) &&
            record.name.toLowerCase().split(':').pop() === segment) || null;
    }
    return null;
}

/**
 * Build the catalogue object.
 * @param {object} exportData   parsed asig-layers.json (may be null)
 * @param {{allowUnresolved?: boolean}} options
 */
function buildCatalogue(exportData, options) {
    options = options || {};
    const pool = poolOf(exportData);
    const used = new Set();
    const unresolved = [];
    const sections = [];
    const byTitleMissing = [];

    CATALOGUE_SPEC.forEach((sectionSpec) => {
        const layers = [];
        sectionSpec.layers.forEach((spec) => {
            const kind = spec.kind === 'wmts' ? 'wmts' : 'wms';
            const record = matchRecord(pool, spec, used);
            let name = spec.name || null;
            let nameSource = spec.name ? (spec.nameSource || 'repo') : null;
            if (record) {
                used.add(record.name);
                /* The export wins over a name recorded in the repo, because it
                 * was read from the live service; a name curated here stays
                 * authoritative only when the export has no row for the title. */
                if (!spec.name || spec.resolve) {
                    name = record.name;
                    nameSource = 'export';
                }
                if (!spec.name) nameSource = 'export';
            }
            if (!name) {
                if (!options.allowUnresolved) byTitleMissing.push(spec.title);
                else unresolved.push(spec.title);
            }
            const resolved = Boolean(name);
            const url = kind === 'wmts'
                ? SERVICE.wmts
                : (record && record.url) || (resolved ? wmsUrlFor(name) : SERVICE.wms);
            const layer = {
                id: spec.id,
                title: spec.title,
                kind: kind,
                name: resolved ? name : null,
                nameSource: resolved ? (nameSource || 'export') : 'unresolved',
                url: url,
                fallbackUrl: kind === 'wmts' ? null : ((record && record.fallbackUrl) || SERVICE.wms),
                format: kind === 'wmts' ? 'image/png' : 'image/png',
                transparent: kind === 'wmts' ? true : true,
                opacity: typeof spec.opacity === 'number' ? spec.opacity : 1,
                minZoom: ZOOM.min,
                maxNativeZoom: kind === 'wmts' ? ZOOM.wmtsMaxNative
                    : (sectionSpec.id === 'orthophotos' ? ZOOM.orthoMaxNative : ZOOM.wmsMaxNative)
            };
            if (!resolved) layer.resolveByTitle = spec.title;
            if (spec.retained) layer.retained = true;
            layers.push(layer);
        });
        sections.push({
            id: sectionSpec.id,
            title: sectionSpec.title,
            note: sectionSpec.note,
            registry: sectionSpec.registry,
            layers
        });
    });

    if (byTitleMissing.length) {
        const error = new Error('unresolved layer titles: ' + byTitleMissing.join(' | '));
        error.unresolvedTitles = byTitleMissing;
        error.catalogue = { sections, unresolved };
        throw error;
    }

    /* Heritage parts: the four known ones, then every layer of the export whose
     * title or name matches the archaeology keyword. */
    const keyword = new RegExp(HERITAGE_SPEC.keyword, 'i');
    const parts = [];
    const partKeys = new Set();
    HERITAGE_SPEC.parts.forEach((spec) => {
        const record = matchRecord(pool, spec, used);
        const name = (record && record.name) || spec.name || null;
        if (record) used.add(record.name);
        const entry = {
            id: spec.id || ('heritage_' + normalizeTitle(spec.title).replace(/ /g, '_')),
            title: spec.title,
            name: name,
            nameSource: name ? ((record && 'export') || spec.nameSource || 'repo') : 'unresolved',
            url: (record && record.url) || (name ? wmsUrlFor(name) : SERVICE.wms),
            fallbackUrl: (record && record.fallbackUrl) || SERVICE.wms,
            dynamic: false
        };
        if (!name) {
            if (!options.allowUnresolved) byTitleMissing.push(spec.title);
            else unresolved.push(spec.title);
            entry.resolveByTitle = spec.title;
        }
        parts.push(entry);
        if (entry.name) partKeys.add(entry.name.toLowerCase());
    });

    pool.filter((record) => keyword.test(record.title) || keyword.test(record.name))
        .sort((a, b) => a.title.localeCompare(b.title))
        .forEach((record) => {
            if (partKeys.has(record.name.toLowerCase())) return;
            partKeys.add(record.name.toLowerCase());
            parts.push({
                id: 'heritage_' + record.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
                title: record.title,
                name: record.name,
                nameSource: 'export',
                url: record.url,
                fallbackUrl: record.fallbackUrl,
                dynamic: false,
                keywordMatch: true
            });
        });

    /* One dynamic rule: whatever the export does not know yet, the browser adds
     * from the service's capabilities (see CONFIG.resolver). */
    parts.push({
        id: 'heritage_dynamic',
        title: 'Automatically detected archaeological layers',
        name: null,
        nameSource: 'resolver',
        url: SERVICE.wms,
        fallbackUrl: SERVICE.wms,
        dynamic: true,
        keywordMatch: true
    });

    if (byTitleMissing.length) {
        const error = new Error('unresolved layer titles: ' + byTitleMissing.join(' | '));
        error.unresolvedTitles = byTitleMissing;
        error.catalogue = { sections, unresolved };
        throw error;
    }

    return {
        schema: 1,
        generatedBy: 'tools/build-asig-catalogue.mjs',
        source: exportData && exportData.generatedAt ? 'prototype export ' + exportData.generatedAt : 'curated spec (no export)',
        attribution: SERVICE.attribution,
        licence: LICENCE,
        service: {
            root: SERVICE.root,
            wms: SERVICE.wms,
            wmts: SERVICE.wmts,
            /* WMS advertises EPSG:6870 (Albania TM), EPSG:4326/EPSG:900913 and
             * CRS:84; the site asks Web Mercator first, 4326 after a burst. */
            nativeCrs: 'EPSG:6870',
            wmtsVersion: '1.0.0',
            wmtsStyle: 'default',
            wmtsTileMatrixSet: SERVICE.wmtsMatrixSet,
            wmtsTileMatrixPrefix: SERVICE.wmtsMatrixSet + ':',
            wmtsFormat: 'image/png'
        },
        /* WGS84 clip of the national coverage (south-west / north-east). */
        bounds: [[39.538, 18.773], [42.758, 21.179]],
        sectionLabels: CATALOGUE_SPEC.reduce((labels, section) => {
            labels[section.id] = { ro: section.title, en: section.title };
            return labels;
        }, {}),
        zoom: ZOOM,
        heritage: {
            id: HERITAGE_SPEC.id,
            title: HERITAGE_SPEC.title,
            note: HERITAGE_SPEC.note,
            opacity: HERITAGE_SPEC.opacity,
            keyword: HERITAGE_SPEC.keyword,
            parts: parts
        },
        sections: sections,
        unresolved: unresolved
    };
}

/** The browser mirror: one file, a plain script, also requireable from Node. */
function renderJsModule(catalogue) {
    const json = JSON.stringify(catalogue, null, 2).replace(/\n/g, '\n  ');
    return `/* ============================================================
   DetectLab — ASIG (Albania) layer catalogue — GENERATED FILE
   Do not edit: run \`node tools/build-asig-catalogue.mjs\`
   (source: ${String(catalogue.source).replace(/\*\//g, '* /')}).
   Sections, order, display titles, exact WMS/WMTS names, endpoints
   and the Heritage parts. js/asig-albania-layers.config.js adds the
   request rules; js/asig-albania-layers.js draws the panel.
   ============================================================ */
(function (root, factory) {
    'use strict';
    var data = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = data;
    if (root) root.ASIG_LAYERS_CATALOGUE = data;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';
    return ${json};
}));
`;
}

function writeFiles(catalogue, outputs) {
    outputs = outputs || { json: OUT_JSON, js: OUT_JS };
    fs.mkdirSync(path.dirname(outputs.json), { recursive: true });
    fs.writeFileSync(outputs.json, JSON.stringify(catalogue, null, 2) + '\n');
    fs.writeFileSync(outputs.js, renderJsModule(catalogue));
}

function readExport(file) {
    if (!file) return null;
    const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

/** `--check`: the committed files must equal what the export would produce. */
function checkCommitted(catalogue) {
    const problems = [];
    const expectedJson = JSON.stringify(catalogue, null, 2) + '\n';
    const expectedJs = renderJsModule(catalogue);
    if (!fs.existsSync(OUT_JSON)) problems.push('missing data/asig-layers.json');
    else if (fs.readFileSync(OUT_JSON, 'utf8') !== expectedJson) problems.push('data/asig-layers.json is stale');
    if (!fs.existsSync(OUT_JS)) problems.push('missing data/asig-layers.data.js');
    else if (fs.readFileSync(OUT_JS, 'utf8') !== expectedJs) problems.push('data/asig-layers.data.js is stale');
    return problems;
}

function summarize(catalogue) {
    const rows = catalogue.sections.reduce((sum, section) => sum + section.layers.length, 0);
    const wmts = catalogue.sections.reduce((sum, section) => sum + section.layers.filter((layer) => layer.kind === 'wmts').length, 0);
    const unresolvedRows = catalogue.sections.reduce((sum, section) => sum + section.layers.filter((layer) => !layer.name).length, 0);
    const parts = catalogue.heritage.parts;
    return [
        '  sections: ' + catalogue.sections.map((section) => section.title + ' ' + section.layers.length).join(' · '),
        '  rows: ' + rows + ' (' + (rows - wmts) + ' WMS + ' + wmts + ' WMTS), Heritage parts: ' +
            parts.filter((part) => !part.dynamic).length + ' + 1 dynamic rule',
        '  unresolved: ' + (unresolvedRows ? unresolvedRows + ' row(s) and ' +
            parts.filter((part) => !part.name && !part.dynamic).length + ' Heritage part(s) will resolve in the browser' : 'none')
    ].join('\n');
}

function parseArgs(argv) {
    const args = { export: 'asig-layers.json', allowUnresolved: false, check: false, quiet: false };
    argv.forEach((arg) => {
        if (arg === '--allow-unresolved') args.allowUnresolved = true;
        else if (arg === '--check') args.check = true;
        else if (arg === '--quiet') args.quiet = true;
        else if (arg.startsWith('--export=')) args.export = arg.slice('--export='.length);
        else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
        else if (arg.startsWith('--out-js=')) args.outJs = arg.slice('--out-js='.length);
        else if (arg === '--help' || arg === '-h') args.help = true;
    });
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write([
            'Usage: node tools/build-asig-catalogue.mjs [--export=asig-layers.json] [--allow-unresolved] [--check]',
            '',
            '  --export=<file>      prototype layer export (default: asig-layers.json in the repo root)',
            '  --allow-unresolved   write rows the export does not name (bootstrap only)',
            '  --check              verify data/asig-layers.json + .data.js are up to date',
            '  --out=<file> / --out-js=<file>   write elsewhere (used by the tests)',
            ''
        ].join('\n'));
        return 0;
    }
    /* A missing export is not fatal: the curated names still describe most of
     * the catalogue. The rows it cannot name fail the build unless the caller
     * explicitly asks for run-time resolution. */
    let exportData = null;
    const exportPath = path.isAbsolute(args.export) ? args.export : path.join(ROOT, args.export);
    if (fs.existsSync(exportPath)) {
        exportData = readExport(exportPath);
    } else if (!args.quiet) {
        process.stdout.write('· no export at ' + args.export + ' — building from the curated spec\n');
    }

    let catalogue;
    try {
        catalogue = buildCatalogue(exportData, { allowUnresolved: args.allowUnresolved || args.check });
    } catch (error) {
        if (!error.unresolvedTitles) throw error;
        process.stderr.write('✗ ' + error.message + '\n');
        process.stderr.write('  Fill in these names in ' + args.export + ', or pass --allow-unresolved\n' +
            '  to let the browser resolve them from the service capabilities.\n');
        return 1;
    }

    if (args.check) {
        const problems = checkCommitted(catalogue);
        if (problems.length) {
            process.stderr.write('✗ ' + problems.join('\n  ') + '\n');
            return 1;
        }
        process.stdout.write('✓ catalogue is up to date (' +
            catalogue.sections.reduce((sum, section) => sum + section.layers.length, 0) + ' rows)\n');
        return 0;
    }

    writeFiles(catalogue, args.out || args.outJs ? {
        json: args.out ? (path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out)) : OUT_JSON,
        js: args.outJs ? (path.isAbsolute(args.outJs) ? args.outJs : path.join(ROOT, args.outJs)) : OUT_JS
    } : null);

    if (!args.quiet) {
        process.stdout.write('✓ wrote data/asig-layers.json + data/asig-layers.data.js\n' + summarize(catalogue) + '\n');
    }
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main();
}

export {
    CATALOGUE_SPEC,
    HERITAGE_SPEC,
    LICENCE,
    SERVICE,
    ZOOM,
    buildCatalogue,
    normalizeTitle,
    renderJsModule,
    summarize,
    writeFiles
};
