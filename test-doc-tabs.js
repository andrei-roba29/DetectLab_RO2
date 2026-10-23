#!/usr/bin/env node
'use strict';

// Contract test for the “Tehnologie / Technology” and “Proces / Process” tabs.
//
// The two homepage sections (#what · Technology and #how · Process) were
// removed from index.html and moved to their own RO/EN page pair:
//
//   tehnologie.html  ⇄  technology.html      (the instruments)
//   proces.html      ⇄  process.html         (the workflow, step by step)
//
// The test checks the four pages, their hreflang/canonical pairing, the
// structural parity between RO and EN, the four mandated topics (Library of
// Babel sources + epoch percentages in the header, potential-zone
// triangulation, LiDAR ML detections filtered in the database, the
// archaeological report and its epoch placement), the index.html wiring, the
// i18n keys, the SW precache and the Babel epoch-percentage implementation.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const RO_TECH = 'tehnologie.html';
const EN_TECH = 'technology.html';
const RO_PROC = 'proces.html';
const EN_PROC = 'process.html';

const pages = {
    [RO_TECH]: read(RO_TECH),
    [EN_TECH]: read(EN_TECH),
    [RO_PROC]: read(RO_PROC),
    [EN_PROC]: read(EN_PROC)
};

/* ── helper: the epoch bars of a page, as numbers ─────────────────────── */
function epochPcts(html) {
    return [...html.matchAll(/class="doc-epoch-pct">(\d+)%</g)].map((m) => Number(m[1]));
}

/* ── helper: section anchors of a page ────────────────────────────────── */
function sectionIds(html) {
    return [...html.matchAll(/class="doc-section" id="([^"]+)"/g)].map((m) => m[1]).sort();
}

/* ── 1. the four pages exist and are bilingual ────────────────────────── */
assert.ok(fs.existsSync(path.join(root, 'css/documentation.css')), 'css/documentation.css exists');
for (const [file, html] of Object.entries(pages)) {
    assert.ok(/^<!DOCTYPE html>/i.test(html), `${file}: is a full HTML document`);
    assert.ok(html.includes('css/documentation.css'), `${file}: loads the documentation stylesheet`);
    assert.ok(/class="doc-nav"/.test(html), `${file}: has the documentation navigation`);
    assert.ok(/class="doc-tab[ "]/.test(html), `${file}: has the tab bar`);
}
assert.ok(/<html lang="ro">/.test(pages[RO_TECH]) && /<html lang="ro">/.test(pages[RO_PROC]), 'RO pages declare lang="ro"');
assert.ok(/<html lang="en">/.test(pages[EN_TECH]) && /<html lang="en">/.test(pages[EN_PROC]), 'EN pages declare lang="en"');

/* ── 2. canonical + hreflang pairing ──────────────────────────────────── */
const pairs = [
    [RO_TECH, `https://detectlab.ro/${RO_TECH}`, `https://detectlab.eu/${EN_TECH}`],
    [EN_TECH, `https://detectlab.ro/${RO_TECH}`, `https://detectlab.eu/${EN_TECH}`],
    [RO_PROC, `https://detectlab.ro/${RO_PROC}`, `https://detectlab.eu/${EN_PROC}`],
    [EN_PROC, `https://detectlab.ro/${RO_PROC}`, `https://detectlab.eu/${EN_PROC}`]
];
for (const [file, ro, en] of pairs) {
    const html = pages[file];
    const canonical = file === RO_TECH || file === RO_PROC ? ro : en;
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`), `${file}: canonical points at its market domain`);
    assert.ok(html.includes(`<link rel="alternate" hreflang="ro" href="${ro}">`), `${file}: hreflang=ro → ${ro}`);
    assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="${en}">`), `${file}: hreflang=en → ${en}`);
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${en}">`), `${file}: x-default → the European page`);
}
/* the language switcher of each page points at its counterpart/domain */
assert.ok(pages[RO_TECH].includes(`href="https://detectlab.eu/${EN_TECH}" hreflang="en"`), 'RO tech page links to the EN page');
assert.ok(pages[EN_TECH].includes(`href="https://detectlab.ro/${RO_TECH}" hreflang="ro"`), 'EN tech page links to the RO page');
assert.ok(pages[RO_PROC].includes(`href="https://detectlab.eu/${EN_PROC}" hreflang="en"`), 'RO process page links to the EN page');
assert.ok(pages[EN_PROC].includes(`href="https://detectlab.ro/${RO_PROC}" hreflang="ro"`), 'EN process page links to the RO page');

/* ── 3. the two tabs cross-link in both languages ─────────────────────── */
assert.ok(pages[RO_TECH].includes('href="proces.html"') && pages[RO_TECH].includes('href="tehnologie.html"'), 'RO tech page carries both RO tabs');
assert.ok(pages[EN_TECH].includes('href="process.html"') && pages[EN_TECH].includes('href="technology.html"'), 'EN tech page carries both EN tabs');
assert.ok(pages[RO_PROC].includes('href="tehnologie.html"') && pages[RO_PROC].includes('href="proces.html"'), 'RO process page carries both RO tabs');
assert.ok(pages[EN_PROC].includes('href="technology.html"') && pages[EN_PROC].includes('href="process.html"'), 'EN process page carries both EN tabs');

/* ── 4. RO/EN structural parity (same anchors, same tab set) ──────────── */
assert.deepStrictEqual(sectionIds(pages[EN_TECH]), sectionIds(pages[RO_TECH]),
    'technology pages expose the same sections as the Romanian ones');
assert.deepStrictEqual(sectionIds(pages[EN_PROC]), sectionIds(pages[RO_PROC]),
    'process pages expose the same sections as the Romanian ones');
for (const [ro, en] of [[RO_TECH, EN_TECH], [RO_PROC, EN_PROC]]) {
    const roIds = sectionIds(pages[ro]);
    assert.ok(roIds.length >= 8, `${ro}: substantial content (${roIds.length} sections)`);
    assert.ok(roIds.includes('babel') || roIds.includes('step5'), `${ro}: covers the Library of Babel`);
    assert.ok(roIds.includes('lidar') || roIds.includes('step7'), `${ro}: covers the LiDAR Scanner`);
    assert.ok(roIds.includes('report') || roIds.includes('step8'), `${ro}: covers the archaeological report`);
    assert.ok(roIds.includes('potential') || roIds.includes('step6'), `${ro}: covers the potential zones`);
}

/* ── 5. the four mandated topics, on BOTH pages of both languages ─────── */
const SOURCES = ['Wikipedia', 'Wikidata', 'OpenStreetMap', 'Wikimedia Commons', 'DBpedia', 'Archive.org', 'Europeana', 'ARIADNE', 'CIMEC'];
for (const [file, html] of Object.entries(pages)) {
    /* 5a. Library of Babel: the sources it uses */
    SOURCES.forEach((s) => assert.ok(html.includes(s), `${file}: names the Babel source ${s}`));
    assert.ok(/babel-epochs|doc-epochs/.test(html), `${file}: documents the epoch-percentage profile`);
    const pcts = epochPcts(html);
    assert.ok(pcts.length >= 5, `${file}: the epoch profile example lists the epochs (${pcts.join('+')})`);
    assert.strictEqual(pcts.reduce((a, b) => a + b, 0), 100, `${file}: the example percentages add up to 100`);

    /* 5b. potential zones: triangulation of the distance to nearby sites */
    assert.ok(/Delaunay/.test(html), `${file}: documents the Delaunay triangulation`);
    assert.ok(/1[,.]5 km/.test(html), `${file}: documents the 1.5 km nearby-sites radius`);
    assert.ok(/700/.test(html), `${file}: documents the 600 + 100 m site protection distance`);

    /* 5c. LiDAR: machine learning → database filtering → precise objectives */
    assert.ok(/machine learning|machine-learning/i.test(html), `${file}: states the LiDAR ML process`);
    assert.ok(/786/.test(html), `${file}: names the number of validated LiDAR objectives`);
    assert.ok(/filtrat|filter(ed|ing)/i.test(html), `${file}: documents the database filtering stage`);

    /* 5d. the archaeological report and its epoch placement */
    assert.ok(/0[,.]40/.test(html) && /0[,.]30/.test(html), `${file}: documents the weighted score (0.40 / 0.30 / 0.30)`);
    assert.ok(/0[,.]75/.test(html) || /0,75/.test(html), `${file}: documents the high-potential threshold`);
    assert.ok(/epoc/i.test(html) && /epoch/i.test(html), `${file}: documents the epoch placement`);
    assert.ok(/PDF/.test(html), `${file}: documents the report PDF`);
}

/* ── 6. index.html: sections removed, tabs wired ──────────────────────── */
const index = read('index.html');
assert.ok(!/data-key="hero_desc"/.test(index), 'the homepage no longer displays the long hero description');
assert.ok(/class="hero-tech">\s*<a href="tehnologie.html" class="btn-secondary t" data-key="nav_tech" data-doc-link="technology">Tehnologie<\/a>/.test(index),
    'the hero has a styled, language-aware button linking directly to Technology');
assert.ok(!/id="what"/.test(index), 'index.html no longer carries the Technology section (#what)');
assert.ok(!/id="how"/.test(index), 'index.html no longer carries the Process section (#how)');
assert.ok(!/href="#what"/.test(index) && !/href="#how"/.test(index), 'no navigation entry still targets the removed anchors');
assert.ok(!/body\.is-pwa #what/.test(index) && !/body\.is-pwa #how/.test(index), 'the PWA hidden-section list no longer mentions the removed sections');
assert.ok(/data-key="nav_tech"/.test(index) && /data-doc-link="technology"/.test(index), 'the nav links to the Technology tab');
assert.ok(/data-key="nav_process"/.test(index) && /data-doc-link="process"/.test(index), 'the nav links to the Process tab');
assert.ok(index.includes('tehnologie.html') && index.includes('proces.html'), 'the homepage links to both RO documentation pages');

/* ── 7. i18n: labels + language-aware hrefs ───────────────────────────── */
const translations = read('js/translations.js');
assert.ok(/nav_tech: 'Technology', nav_process: 'Process'/.test(translations), 'EN dictionary carries both tab labels');
assert.ok(/nav_tech: 'Tehnologie', nav_process: 'Proces'/.test(translations), 'RO dictionary carries both tab labels');
assert.ok(/\[data-doc-link\]/.test(translations), 'setLang rewrites the data-doc-link entries');
assert.ok(translations.includes("ro: 'tehnologie.html', en: 'technology.html'"), 'the technology pair is language-mapped');
assert.ok(translations.includes("ro: 'proces.html', en: 'process.html'"), 'the process pair is language-mapped');

/* ── 8. service worker: the pages survive offline + cache bump ────────── */
const sw = read('sw.js');
const cacheName = (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1] || '';
assert.ok(/v9\d|v\d{3}/.test(cacheName) && cacheName !== 'detectlab-v98-pwa-panel-offline-exit', `CACHE_NAME bumped (got: ${cacheName})`);
[RO_TECH, EN_TECH, RO_PROC, EN_PROC, 'css/documentation.css', 'css/documentation.css?v=20260917-doc-tabs'].forEach((url) => {
    assert.ok(sw.includes(`'${url}'`), `sw.js precaches ${url}`);
});
assert.ok(sw.includes('css/library-of-babel.css?v=20260917-babel-epochs'), 'the new Babel stylesheet version is precached');

/* ── 9. Library of Babel: the header epoch profile is real ────────────── */
const babel = read('js/library-of-babel.js');
assert.ok(/babel-epochs/.test(babel), 'the results header renders the epoch profile');
assert.ok(/epochProfile:/.test(babel), 'the profile label is translated');
assert.ok(/--babel-share:/.test(babel), 'each share carries its bar width');
assert.ok(/querySelectorAll\('\.babel-timeline-strip button, \.babel-epochs button'\)/.test(babel),
    'the epoch shares are clickable period filters');
assert.ok(/largest-remainder|Math\.max\(0, 100 - used\)/.test(babel), 'the percentages are rounded to a 100 % total');
assert.ok(/epochProfile: 'Epoci'/.test(babel) && /epochProfile: 'Epochs'/.test(babel), 'the profile is labelled in RO and EN');

console.log('✓ Documentation tabs: RO/EN pages, hreflang pairing and structural parity');
console.log('✓ Library of Babel sources + epoch percentages, site triangulation, LiDAR ML + DB filtering, report scoring');
console.log('✓ index.html sections removed, tabs wired, i18n + SW precache updated');
console.log('OK — the “Tehnologie / Technology” and “Proces / Process” tabs are complete.');
