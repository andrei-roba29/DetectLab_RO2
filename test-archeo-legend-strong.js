// Regression test — the archaeological-potential legend reads “Strong” at the
// left end of its heat bar, in every language.
//
// The legend is `#archeoPotLegendHeat` in index.html:
//
//     <span class="archeo-pot-heatbar" id="archeoPotHeatbar"></span>
//     <span class="archeo-pot-heatlabels">
//         <span class="t" data-key="archeo_legend_heat_lo">Strong</span>
//         <span class="t" data-key="archeo_legend_heat_hi">Strong</span>
//     </span>
//
// `heat_lo` used to say “Weak” / “Slab”. It now carries the same word as
// `heat_hi`, and every one of the 25 language packs was updated with it, so a
// language switch cannot bring “Weak” back.
//
// Run: node test-archeo-legend-strong.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

console.log('[Legend] archaeological potential — heat bar labels');

/* ── 1. The markup ──────────────────────────────────────────────────────── */
const html = read('index.html');
const legendStart = html.indexOf('id="archeoPotLegendHeat"');
check(legendStart > -1, 'the heat legend block is still in the shell');
const legend = html.slice(legendStart, legendStart + 1400);

check(/data-key="archeo_legend_heat_lo">Strong</.test(legend),
    'the left end of the heat bar must render “Strong”');
check(/data-key="archeo_legend_heat_hi">Strong</.test(legend),
    'the right end keeps “Strong”');
check(!/>\s*Weak\s*</.test(legend), 'no static “Weak” may remain inside the heat legend');
check(!/data-key="archeo_legend_heat_lo">\s*</.test(legend),
    'the label must not be left empty for translations to fill in later');

/* ── 2. Every language pack carries the same word at both ends ───────────── */
const tsrc = read('js/translations.js');
const at = tsrc.indexOf('const translations = {');
check(at > -1, 'js/translations.js still exports `const translations = {');
let depth = 0;
let i = tsrc.indexOf('{', at);
const from = i;
for (; i < tsrc.length; i++) {
    if (tsrc[i] === '{') depth++;
    else if (tsrc[i] === '}' && --depth === 0) break;
}
// eslint-disable-next-line no-eval
const dict = eval('(' + tsrc.slice(from, i + 1) + ')');
const langs = Object.keys(dict);
check(langs.length === 25, 'all 25 language packs are present (got ' + langs.length + ')');
check(!!dict.en && !!dict.ro, 'English and Romanian are present');

langs.forEach((lang) => {
    const pack = dict[lang] || {};
    const lo = pack.archeo_legend_heat_lo;
    const hi = pack.archeo_legend_heat_hi;
    check(typeof lo === 'string' && lo.trim().length > 0,
        lang + ': archeo_legend_heat_lo must be a non-empty string');
    check(lo === hi,
        lang + ': both ends of the heat bar must read the same (“' + lo + '” vs “' + hi + '”)');
    check(!/^(weak|slab)$/i.test(lo),
        lang + ': the old “Weak” / “Slab” label must be gone (got “' + lo + '”)');
});

check(dict.en.archeo_legend_heat_lo === 'Strong', 'English reads “Strong”');
check(dict.ro.archeo_legend_heat_lo === 'Puternic', 'Romanian reads “Puternic”');

/* Spot-check the other packs against their own word for “strong”: the point of
 * mirroring heat_hi is that each language keeps its own correct translation. */
const expected = {
    de: 'Stark', fr: 'Fort', it: 'Forte', es: 'Fuerte', pl: 'Silny', uk: 'Сильний',
    hu: 'Erős', cs: 'Silný', sk: 'Silný', nl: 'Sterk', pt: 'Forte', ru: 'Сильный',
    bg: 'Силен', hr: 'Jak', sr: 'Јак', el: 'Ισχυρό', da: 'Stærk', sv: 'Stark',
    no: 'Sterk', fi: 'Vahva', lt: 'Stiprus', lv: 'Spēcīgs', et: 'Tugev'
};
Object.keys(expected).forEach((lang) => {
    check(dict[lang] && dict[lang].archeo_legend_heat_lo === expected[lang],
        lang + ': expected “' + expected[lang] + '”, got “' +
        (dict[lang] && dict[lang].archeo_legend_heat_lo) + '”');
});

/* ── 3. Installed PWAs actually receive it ──────────────────────────────── */
const liveTranslations = (html.match(/js\/translations\.js\?v=[^"']+/) || [])[0];
check(!!liveTranslations, 'index.html requests a cache-busted translations.js');
const sw = read('sw.js');
check(sw.includes("'" + liveTranslations + "'"),
    'sw.js must pre-cache the exact translations.js URL index.html requests '
    + '(' + liveTranslations + ')');
const cache = (sw.match(/const CACHE_NAME = 'detectlab-(v\d+)-/) || [])[1];
check(Number(String(cache).replace('v', '')) >= 287,
    'the shell cache must be bumped past v286 (got ' + cache + ')');

console.log('✓ the heat bar renders “Strong” on the left, “Strong” on the right');
console.log('✓ all 25 packs agree, each in its own language (ro: Puternic)');
console.log('✓ translations.js is re-tagged and pre-cached by the service worker');
console.log('\n' + checks + ' checks passed — no “Weak” label can come back.');
