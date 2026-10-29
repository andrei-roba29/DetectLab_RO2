// Regression test for the "?" map tutorial (js/tutorial.js). Static, no DOM:
// the walkthrough must track the real UI (IDs that exist), every slide must be
// bilingual, the Friends slide must open/close the real panel without ever
// popping the auth modal over the guide, and the shipped file must be
// cache-busted + pre-cached.
//
// Run: node test-tutorial.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TUT_SRC = fs.readFileSync(path.join(ROOT, 'js/tutorial.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const UI_SRC = ['index.html', 'js/friends.js', 'js/map-app.js', 'js/map-rotate.js', 'js/events.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

let passed = 0;
function check(name, cond, extra) {
    if (!cond) {
        console.error('✗ ' + name + (extra ? '\n    ' + extra : ''));
        process.exitCode = 1;
        return;
    }
    passed++;
    console.log('✓ ' + name);
}

/* ── 1. Slide deck ─────────────────────────────────────────────────────── */
const stepIds = [...TUT_SRC.matchAll(/\{\s*\n\s*id: '(\w+)',/g)].map(m => m[1]);
check('the walkthrough has 6 slides in order (left, bottom, friends, layers, catalog, performance)',
    JSON.stringify(stepIds) === JSON.stringify(['left', 'bottom', 'friends', 'layers', 'catalog', 'performance']),
    JSON.stringify(stepIds));
check('the header comment describes the 6-slide walkthrough incl. Friends',
    /opens a 6-slide/.test(TUT_SRC) && /the Friends panel: unified people search/.test(TUT_SRC));

/* ── 2. Every arrow target resolves to a real control ──────────────────── */
// Collect every #id the tutorial points at and require it to exist in the
// shipped UI (markup or JS-rendered). Catches stranded selectors left behind
// by UI refactors (e.g. the removed PWA bottom bar).
const selLines = TUT_SRC.split('\n').filter(l => /^\s*sel: /.test(l));
const ids = new Set();
selLines.forEach(l => {
    const m = l.match(/#[A-Za-z][\w-]*/g) || [];
    m.forEach(id => ids.add(id));
});
check('the tutorial points at ' + ids.size + ' control ids', ids.size >= 10, [...ids].join(' '));
const missing = [...ids].filter(id => UI_SRC.indexOf(id.slice(1)) === -1);
check('every targeted id exists in the shipped UI', missing.length === 0, 'missing: ' + missing.join(' '));

/* ── 3. No stranded references to removed UI ───────────────────────────── */
['pwaBottomBar', 'pwa-bottom-bar', 'detectlab-compass-track', 'detectlab-compass-lock-dock',
 'SLIDE_MAX', 'Glisează busola', 'slide the compass'].forEach(function (stale) {
    check('no stranded reference to "' + stale + '"', TUT_SRC.indexOf(stale) === -1);
});

/* ── 4. Copy tracks the latest UI ──────────────────────────────────────── */
['＋ Adaugă prieten', '＋ Add friend', 'muresan', 'Mureșan', 'ana cluj',
 'sub busolă', 'under the compass',
 'butonul cu lupă', 'magnifier button', 'Stocare (pin-uri', 'Storage (pins'].forEach(function (snippet) {
    check('tutorial copy mentions "' + snippet + '"', TUT_SRC.indexOf(snippet) !== -1);
});

/* The installed PWA has separate bottom-right GPS and account controls. */
['în dreapta-jos', 'at the bottom-right'].forEach(function (snippet) {
    check('the live-location slide documents "' + snippet + '"', TUT_SRC.indexOf(snippet) !== -1);
});
['nu deschide meniul contului', 'does not open the account menu'].forEach(function (snippet) {
    check('the account slide distinguishes live location: "' + snippet + '"', TUT_SRC.indexOf(snippet) !== -1);
});
check('the account slide targets both the website and PWA account controls',
    /sel: \['#navUser', '#pwaUserItem'\]/.test(TUT_SRC));

['La prima poziție', 'următoarele actualizări GPS', 'On the first fix',
 'zoom out or pan', 'below live location', 'sub locația live'].forEach(function (snippet) {
    check('tutorial documents current live-location and account behavior: "' + snippet + '"', TUT_SRC.includes(snippet));
});
check('tutorial does not claim the PWA account menu is absent',
    !TUT_SRC.includes('not available from the installed app') && !TUT_SRC.includes('a fost scos din dreapta-jos'));

/* ── 5. Friends slide mechanics ────────────────────────────────────────── */
check('the friends slide opens the real panel on the search tab',
    /window\.openFriends\('search'\)/.test(TUT_SRC));
check('the guide only ever closes a panel it opened itself',
    /else if \(!open && state\.openedFriends\)/.test(TUT_SRC) &&
    /window\._closeFriendsPanel\(\)/.test(TUT_SRC));
check('an already-open panel is switched to the search tab, not rebuilt blindly',
    /#friendsManagerPanel \.fr-tab\[data-tab="search"\]/.test(TUT_SRC));
check('the friends slide points at both new tabs (search bar + friend list)',
    TUT_SRC.indexOf('data-tab="friends"') !== -1 &&
    TUT_SRC.indexOf('sel: \'#frSearchInput\'') !== -1);
check('signed-out visitors get an explanatory note, never the auth modal',
    /step\.requiresAuth && !signedIn\(\)/.test(TUT_SRC) &&
    /tr\(step\.authNote\)/.test(TUT_SRC) &&
    TUT_SRC.indexOf('openAuth') === -1);
check('waiting for the async friends render has a hard cap (never stuck)',
    /FRIENDS_MAX_WAIT = 6000/.test(TUT_SRC) && /waited >= FRIENDS_MAX_WAIT/.test(TUT_SRC));
check('closing the guide also closes a guide-opened friends panel',
    /ensureFriends\(false\)/.test(TUT_SRC));

/* ── 6. Bilingual completeness ─────────────────────────────────────────── */
const stepsSrc = TUT_SRC.slice(TUT_SRC.indexOf('var STEPS = ['), TUT_SRC.indexOf('var CATALOG = {'));
const blocks = [...stepsSrc.matchAll(/(title|desc|authNote|text): \{\n([\s\S]{0,900}?)\n\s*\}/g)];
check('every title/desc/authNote block in STEPS is RO+EN (' + blocks.length + ' blocks)',
    blocks.length > 20 && blocks.every(b => b[2].indexOf('ro:') !== -1 && b[2].indexOf('en:') !== -1),
    blocks.filter(b => b[2].indexOf('ro:') === -1 || b[2].indexOf('en:') === -1).map(b => b[1]).join(','));

/* ── 7. Versioned + pre-cached ─────────────────────────────────────────── */
const tutUrl = (INDEX_SRC.match(/src="(js\/tutorial\.js\?v=[^"]+)"/) || [])[1];
check('index.html loads a cache-busted js/tutorial.js', !!tutUrl, 'no ?v= on js/tutorial.js');
if (tutUrl) {
    check('that exact tutorial URL is pre-cached in sw.js',
        SW_SRC.indexOf("'" + tutUrl + "'") !== -1, tutUrl + ' not pre-cached');
}

console.log('\n' + passed + ' checks passed.');
if (process.exitCode) console.error('FAILED');
