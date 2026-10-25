// Regression test — in the installed PWA the layer quick actions (APM 2.0
// „Ajutor de căutare”, Iosefină Premium căutare / setări / sugerează) must
// dock in a column UNDER their on-screen slider, never over it.
//
// Bug: index.html lifts the FLOATING (bottom-center) variants of the same
// buttons above the home indicator with
//   `body.is-pwa #apm20SearchHelpBtn { bottom: calc(36px + …) !important }`
//   (Josephine: `76px + …`).
// That selector has specificity (1,1,1) and is !important, so it outranks the
// docked rule in css/styles.css,
//   `.vertical-opacity-actions #apm20SearchHelpBtn { bottom: auto !important }`
// (1,1,0). On a button the docked rule already made position:relative, a
// `bottom` of ~80px / ~120px shifts it UP by that much — straight over the
// slider card. The „Setări detecție” panel had the same race: its PWA lift
// (`bottom: … !important`) beat the plain `bottom: auto` of the docked anchor,
// so the panel got top AND bottom and was squeezed between them.
//
// Fix: css/styles.css re-asserts the docked geometry with `body.is-pwa` in the
// selector (1,2,1) for the four buttons, and the docked panel anchor makes its
// `bottom: auto` !important.
//
// Usage: node test-pwa-docked-actions.js
//   Part 1 (no dependencies) resolves the real cascade for the docked buttons
//   — BOTH stylesheets (css/styles.css + the inline <style> blocks of
//   index.html), specificity, !important and source order — exactly the
//   mechanism that broke. jsdom cannot do this: its getComputedStyle applies
//   rules in source order and ignores specificity.
//   Part 2 (optional) measures the real boxes in Chromium via puppeteer-core;
//   it is skipped when no browser is available (same discovery as
//   test-patrimoniu-zoom-animation-browser.js: PUPPETEER_MODULE_DIR,
//   PUPPETEER_EXECUTABLE_PATH, PUPPETEER_LIB_PATH).
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createRequire } = require('module');

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const css = read('css/styles.css');
const html = read('index.html');
const sw = read('sw.js');

const ACTION_IDS = ['apm20SearchHelpBtn', 'iosBldSearchHelpBtn', 'iosBldSettingsBtn', 'iosBldSuggestBtn'];
const DOCKED_GEOMETRY = { position: 'relative', bottom: 'auto', left: 'auto', transform: 'none' };

/* ───────────────────────── tiny CSS engine ───────────────────────── */

/* Rule reader: { selector, declarations: {prop: {value, important}}, inside,
   order }. `inside` keeps the FULL at-rule header (e.g. "@media (max-width:
   600px)") so media conditions can be evaluated per viewport profile. */
function parseCss(text, inside, out) {
    out = out || [];
    const scope = inside || '';
    let i = 0;
    while (i < text.length) {
        const comment = text.indexOf('/*', i);
        const open = text.indexOf('{', i);
        if (comment !== -1 && (open === -1 || comment < open)) {
            const end = text.indexOf('*/', comment + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (open === -1) break;
        const header = text.slice(i, open).trim();
        let depth = 1;
        let close = -1;
        for (let j = open + 1; j < text.length; j++) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}' && --depth === 0) { close = j; break; }
        }
        if (close === -1) break;
        const body = text.slice(open + 1, close);
        if (header.startsWith('@')) {
            const head = header.replace(/\s+/g, ' ');
            if (/^@(media|supports)\b/.test(head)) {
                parseCss(body, scope ? scope + ' && ' + head : head, out);
            }
            /* @keyframes / @font-face carry no element rules */
        } else if (header) {
            const declarations = {};
            body.replace(/\/\*[\s\S]*?\*\//g, ' ').split(';').forEach(part => {
                const idx = part.indexOf(':');
                if (idx === -1) return;
                const prop = part.slice(0, idx).trim();
                let value = part.slice(idx + 1).trim();
                const important = /!important\s*$/i.test(value);
                value = value.replace(/\s*!important\s*$/i, '').trim();
                if (prop) declarations[prop] = { value, important };
            });
            out.push({ selector: header.replace(/\s+/g, ' '), declarations, inside: scope, order: out.length });
        }
        i = close + 1;
    }
    return out;
}

/* Media evaluation for a viewport profile; features we do not model make
   the rule inactive (the only ones on the docked path are width/height). */
function mediaActive(inside, profile) {
    if (!inside) return true;
    return inside.split(' && ').every(head => {
        if (head.startsWith('@supports')) return true;
        const cond = head.replace(/^@media\s*/, '');
        return cond.split(/\s*,\s*/).some(query => {
            const features = query.match(/\([^)]*\)/g) || [];
            if (/\bnot\b/.test(query)) return false;
            return features.every(f => {
                const m = /\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)px\s*\)/.exec(f);
                if (!m) return false;
                const actual = m[2] === 'width' ? profile.width : profile.height;
                return m[1] === 'max' ? actual <= Number(m[3]) : actual >= Number(m[3]);
            });
        });
    });
}

/* Compound selector → { tag, id, classes, attrs, pseudos } */
function parseCompound(text) {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], pseudoElement: false };
    const re = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]]*)\]|::[\w-]+|:([\w-]+)(\((?:[^()]|\([^()]*\))*\))?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[1] !== undefined) c.tag = m[1];
        else if (m[2] !== undefined) c.id = m[2];
        else if (m[3] !== undefined) c.classes.push(m[3]);
        else if (m[4] !== undefined) c.attrs.push(m[4]);
        else if (m[0].startsWith('::')) c.pseudoElement = true;
        else c.pseudos.push({ name: m[5], arg: m[6] ? m[6].slice(1, -1) : null });
    }
    return c;
}

/* Split a complex selector into [{compound, combinator}] (right-most last). */
function parseComplex(selector) {
    const tokens = selector.trim().split(/\s*([>+~])\s*|\s+/).filter(t => t !== undefined && t !== '');
    const parts = [];
    let pendingCombinator = ' ';
    tokens.forEach(t => {
        if (t === '>' || t === '+' || t === '~') { pendingCombinator = t; return; }
        parts.push({ compound: parseCompound(t), combinator: pendingCombinator });
        pendingCombinator = ' ';
    });
    return parts;
}

function specificity(selector) {
    let a = 0, b = 0, c = 0;
    parseComplex(selector).forEach(({ compound }) => {
        if (compound.id) a++;
        b += compound.classes.length + compound.attrs.length;
        compound.pseudos.forEach(p => {
            if (p.name === 'not' || p.name === 'is') {
                const inner = specificity(p.arg || '');
                a += inner[0]; b += inner[1]; c += inner[2];
            } else if (p.name !== 'where') b++;
        });
        if (compound.tag && compound.tag !== '*') c++;
        if (compound.pseudoElement) c++;
    });
    return [a, b, c];
}
const cmpSpec = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

/* Resting state: no hover / focus / active / disabled; :not() is evaluated. */
function nodeMatches(node, compound) {
    if (compound.pseudoElement) return false;
    if (compound.tag && compound.tag !== '*' && compound.tag.toLowerCase() !== node.tag) return false;
    if (compound.id && compound.id !== node.id) return false;
    if (!compound.classes.every(cl => node.classes.includes(cl))) return false;
    if (!compound.attrs.every(attr => {
        const m = /^([\w-]+)(?:\s*([~|^$*]?=)\s*["']?([^"'\]]*)["']?)?$/.exec(attr.trim());
        if (!m) return false;
        const actual = (node.attrs || {})[m[1]];
        if (actual === undefined) return false;
        if (!m[2]) return true;
        if (m[2] === '=') return actual === m[3];
        if (m[2] === '*=') return actual.includes(m[3]);
        if (m[2] === '^=') return actual.startsWith(m[3]);
        if (m[2] === '$=') return actual.endsWith(m[3]);
        if (m[2] === '~=') return actual.split(/\s+/).includes(m[3]);
        return false;
    })) return false;
    return compound.pseudos.every(p => {
        if (p.name === 'not') return !parseComplex(p.arg).every(part => nodeMatches(node, part.compound));
        if (p.name === 'is') return parseComplex(p.arg).some(part => nodeMatches(node, part.compound));
        return false; /* state pseudo-classes: not in the resting state */
    });
}

/* chain: ancestors first, element last. */
function selectorMatches(selector, chain) {
    return selector.split(',').some(part => {
        const parts = parseComplex(part);
        if (!parts.length) return false;
        function match(partIdx, nodeIdx) {
            const { compound, combinator } = parts[partIdx];
            if (!nodeMatches(chain[nodeIdx], compound)) return false;
            if (partIdx === 0) return true;
            const next = parts[partIdx].combinator; /* combinator BEFORE this compound */
            if (next === '+' || next === '~') return false;
            if (next === '>') return nodeIdx > 0 && match(partIdx - 1, nodeIdx - 1);
            for (let k = nodeIdx - 1; k >= 0; k--) if (match(partIdx - 1, k)) return true;
            return false;
        }
        void parts[parts.length - 1].combinator;
        return match(parts.length - 1, chain.length - 1);
    });
}

/* The real cascade for one property: !important beats normal, then higher
   specificity, then later source order. */
function cascade(rules, chain, prop, profile) {
    let winner = null;
    rules.forEach(rule => {
        const decl = rule.declarations[prop];
        if (!decl || !mediaActive(rule.inside, profile)) return;
        if (!selectorMatches(rule.selector, chain)) return;
        const cand = { value: decl.value, important: decl.important, spec: specificity(rule.selector), order: rule.order, rule };
        if (!winner) { winner = cand; return; }
        if (cand.important !== winner.important) { if (cand.important) winner = cand; return; }
        const s = cmpSpec(cand.spec, winner.spec);
        if (s > 0 || (s === 0 && cand.order > winner.order)) winner = cand;
    });
    return winner;
}

/* ───────────────── 1. the two stylesheets, in page order ───────────────── */

const inlineStyles = [];
html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, body) => { inlineStyles.push(body); return m; });
assert(inlineStyles.length >= 1, 'index.html must carry its inline <style> block (the PWA layout overrides)');
const linkIdx = html.indexOf('href="css/styles.css');
assert(linkIdx !== -1 && linkIdx < html.indexOf('<style'),
    'css/styles.css is linked before the inline <style> (source order matters for equal specificity)');

const rules = parseCss(css);
inlineStyles.forEach(block => parseCss(block, '', rules));
assert(rules.length > 500, 'expected hundreds of rules, got ' + rules.length);

/* Precondition of the regression (documents WHY the fix is needed). If the
   PWA lift ever disappears from index.html this stays green — the cascade
   below is what matters. */
const pwaLift = rules.filter(r => /body\.is-pwa #(apm20SearchHelpBtn|iosBldSearchHelpBtn|iosBldSettingsBtn|iosBldSuggestBtn)\b/.test(r.selector) && r.declarations.bottom);
if (pwaLift.length) {
    assert(pwaLift.every(r => r.declarations.bottom.important),
        'the index.html PWA lift uses !important on bottom (that is the race this test guards)');
}

const PROFILES = {
    'portrait phone 412×915': { width: 412, height: 915 },
    'small phone 360×640': { width: 360, height: 640 },
    'landscape phone 915×412': { width: 915, height: 412 },
    'desktop 1280×800': { width: 1280, height: 800 }
};

function buttonChain(id, slot, pwa) {
    const bodyClasses = pwa ? ['is-pwa', 'vo-josephine-docked'] : ['vo-josephine-docked'];
    if (slot === 'secondary') bodyClasses.push('vo-josephine-docked-secondary');
    return [
        { tag: 'html', classes: pwa ? ['is-pwa'] : [] },
        { tag: 'body', classes: bodyClasses },
        { tag: 'div', classes: ['container'] },
        { tag: 'div', classes: ['map-frame'] },
        { tag: 'div', classes: ['map-wrapper'] },
        { tag: 'div', id: slot === 'secondary' ? 'verticalOpacityControlSecondary' : 'verticalOpacityControl',
          classes: ['vertical-opacity-control', 'visible'].concat(slot === 'secondary' ? ['vertical-opacity-secondary'] : []),
          attrs: { 'data-kind': 'opacity' } },
        { tag: 'div', id: slot === 'secondary' ? 'verticalOpacityActionsSecondary' : 'verticalOpacityActions', classes: ['vertical-opacity-actions'] },
        { tag: 'button', id, classes: ['vo-docked'], attrs: { type: 'button' } }
    ];
}

let cascadeChecks = 0;
Object.keys(PROFILES).forEach(profileName => {
    const profile = PROFILES[profileName];
    [true, false].forEach(pwa => {
        ['primary', 'secondary'].forEach(slot => {
            ACTION_IDS.forEach(id => {
                const chain = buttonChain(id, slot, pwa);
                Object.keys(DOCKED_GEOMETRY).forEach(prop => {
                    const win = cascade(rules, chain, prop, profile);
                    const where = (pwa ? 'PWA' : 'site') + ', ' + slot + ' mirror, ' + profileName;
                    assert(win, '#' + id + ' (' + where + '): no rule sets ' + prop);
                    assert.strictEqual(win.value, DOCKED_GEOMETRY[prop],
                        '#' + id + ' docked under the slider (' + where + ') must have ' + prop + ': ' +
                        DOCKED_GEOMETRY[prop] + ' — the cascade resolves to "' + win.value + '" from `' +
                        win.rule.selector + '`' + (win.rule.inside ? ' in ' + win.rule.inside : '') +
                        (prop === 'bottom' ? ' (a relative button with a non-auto bottom is pushed up over the slider card)' : ''));
                    cascadeChecks++;
                });
            });
        });
    });
});

/* The docked-in-PWA rule keys off the container CLASS, so it covers both
   mirrors (see SLIDER_ACTIONS_BOTH_MIRRORS.md), and it lives in styles.css. */
const stylesRules = parseCss(css);
ACTION_IDS.forEach(id => {
    const fix = stylesRules.filter(r => r.selector.split(',').some(s =>
        /body\.is-pwa .vertical-opacity-actions #/.test(s.trim()) && s.trim().endsWith('#' + id)));
    assert(fix.length > 0, 'css/styles.css must re-assert the docked geometry for #' + id + ' under body.is-pwa');
    assert(fix.some(r => r.declarations.bottom && r.declarations.bottom.value === 'auto' && r.declarations.bottom.important),
        'the PWA docked rule for #' + id + ' must set bottom: auto !important (the lift it beats is !important too)');
});

/* ─────────── the „Setări detecție” panel keeps its auto height in PWA ─────────── */

function panelChain(pwa, secondary) {
    const bodyClasses = (pwa ? ['is-pwa'] : []).concat(['vo-josephine-docked']).concat(secondary ? ['vo-josephine-docked-secondary'] : []);
    return [
        { tag: 'html', classes: pwa ? ['is-pwa'] : [] },
        { tag: 'body', classes: bodyClasses },
        { tag: 'div', classes: ['container'] },
        { tag: 'div', classes: ['map-frame'] },
        { tag: 'div', classes: ['map-wrapper'] },
        { tag: 'div', id: 'iosBldSettingsPanel', classes: ['open'] }
    ];
}
Object.keys(PROFILES).forEach(profileName => {
    const profile = PROFILES[profileName];
    [false, true].forEach(secondary => {
        const chain = panelChain(true, secondary);
        const bottom = cascade(rules, chain, 'bottom', profile);
        assert(bottom, 'the settings panel must have a resolved bottom');
        assert.strictEqual(bottom.value, 'auto',
            'PWA + Josephine docked (' + profileName + (secondary ? ', secondary mirror' : '') + '): the „Setări detecție” panel ' +
            'must NOT keep a bottom offset — got "' + bottom.value + '" from `' + bottom.rule.selector +
            '`; with top AND bottom set the panel is squeezed between them and its fields overflow the card');
        const top = cascade(rules, chain, 'top', profile);
        assert(top && /50%/.test(top.value), 'the docked panel stays vertically anchored to the slider (top ~50%), got ' + (top && top.value));
        const site = cascade(rules, panelChain(false, secondary), 'bottom', profile);
        assert.strictEqual(site.value, 'auto', 'site: the docked panel anchor is unchanged (bottom: auto)');
    });
});

/* On phones the panel anchored beside the SECONDARY mirror sits one mirror
   step (46 + 10px) further left than the primary anchor, so it must also be
   that much narrower to keep the same 50px margin to the left control column
   (primary: 100vw − 140px; secondary: 100vw − 196px). Otherwise a 272px panel
   starts 6px off-screen at 412px wide. */
const narrowSecondaryPanel = stylesRules.find(r =>
    /max-width: 600px/.test(r.inside) &&
    r.selector === 'body.vo-josephine-docked.vo-josephine-docked-secondary #iosBldSettingsPanel');
assert(narrowSecondaryPanel, 'the narrow-screen secondary anchor of the settings panel must exist');
assert(narrowSecondaryPanel.declarations.width && /100vw - 176px/.test(narrowSecondaryPanel.declarations.width.value),
    'beside the secondary mirror the phone-width panel must be min(280px, calc(100vw - 176px)), got ' +
    (narrowSecondaryPanel.declarations.width && narrowSecondaryPanel.declarations.width.value));

/* ───────────── installed PWAs must actually receive the new shell ───────────── */

const stylesV = (html.match(/href="css\/styles\.css\?v=([^"]+)"/) || [])[1];
assert(stylesV, 'index.html links a versioned css/styles.css');
assert(sw.includes("'css/styles.css?v=" + stylesV + "'"),
    'sw.js must pre-cache the exact styles.css URL index.html requests (' + stylesV + ')');
const cacheVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(cacheVersion >= 137,
    'CACHE_NAME must be bumped to v137 or later so installed apps swap to the shell with the docked-in-PWA rules (got v' + cacheVersion + ')');

console.log('OK — cascade (' + cascadeChecks + ' checks): in the PWA the APM 2.0 / Iosefină Premium icons keep');
console.log('    position:relative + bottom:auto under the slider in both mirrors, the „Setări detecție”');
console.log('    panel keeps its auto height, and the shell is re-versioned (v' + cacheVersion + ').');

/* ─────────────── 2. optional: real boxes in Chromium (puppeteer-core) ─────────────── */

function loadPuppeteer() {
    const dirs = [process.env.PUPPETEER_MODULE_DIR, path.join(ROOT, 'node_modules'), '/home/user/pptr/node_modules'].filter(Boolean);
    for (const dir of dirs) {
        try {
            const req = createRequire(path.join(dir, 'index.js'));
            let chromium = null;
            try { chromium = req('@sparticuz/chromium'); } catch (e) { /* system Chrome via PUPPETEER_EXECUTABLE_PATH */ }
            return { puppeteer: req('puppeteer-core'), chromium };
        } catch (e) { /* keep looking */ }
    }
    return null;
}

function contentType(file) {
    const ext = path.extname(file);
    return { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
        '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
}

function serve() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('nope'); return;
        }
        res.writeHead(200, { 'content-type': contentType(file) });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

(async () => {
    const loaded = loadPuppeteer();
    if (!loaded) {
        console.log('⚠ browser part skipped: puppeteer-core not installed (set PUPPETEER_MODULE_DIR)');
        return;
    }
    const { puppeteer, chromium } = loaded;
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    const env = Object.assign({}, process.env);
    if (!executablePath) {
        try {
            const mod = chromium && (chromium.default || chromium);
            if (!mod) throw new Error('no @sparticuz/chromium and no PUPPETEER_EXECUTABLE_PATH');
            executablePath = await mod.executablePath();
            args = args.concat(mod.args || []);
        } catch (e) {
            console.log('⚠ browser part skipped: no Chromium executable (' + e.message + ')');
            return;
        }
    }
    const libCandidates = [process.env.PUPPETEER_LIB_PATH, '/tmp/dl-al2023-lib/lib', '/tmp/al2023x/lib'].filter(Boolean);
    const libDir = libCandidates.find(d => { try { return fs.readdirSync(d).some(f => f.startsWith('libnspr4')); } catch (e) { return false; } });
    if (libDir) env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');

    const { server, port } = await serve();
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath, args, headless: 'shell', env,
            defaultViewport: { width: 412, height: 915, deviceScaleFactor: 1, isMobile: true, hasTouch: true } });
    } catch (e) {
        server.close();
        if (/libnspr4|shared libraries|libnss3/.test(e.message)) {
            console.log('⚠ browser part skipped: Chromium shared libraries missing (set PUPPETEER_LIB_PATH)');
            return;
        }
        throw e;
    }
    try {
        const page = await browser.newPage();
        page.on('pageerror', () => { /* blocked CDNs make the app noisy; irrelevant here */ });
        await page.setRequestInterception(true);
        page.on('request', req => {
            try {
                if (req.url().startsWith('http://127.0.0.1:' + port + '/')) return req.continue();
                return req.abort();
            } catch (e) { try { req.abort(); } catch (_) { /* closed */ } }
        });
        /* ?pwa=1 = the standalone layout (body.is-pwa) in a normal tab. */
        await page.goto('http://127.0.0.1:' + port + '/index.html?pwa=1', { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction('window.DetectLabVerticalOpacity && document.body.classList.contains("is-pwa")', { timeout: 60000 });
        await new Promise(r => setTimeout(r, 500));

        const measured = await page.evaluate(async (ids) => {
            const api = window.DetectLabVerticalOpacity;
            const wait = ms => new Promise(r => setTimeout(r, ms));
            function boxes(cardId, list) {
                const card = document.getElementById(cardId).getBoundingClientRect();
                return {
                    card: { top: card.top, bottom: card.bottom, cx: (card.left + card.right) / 2 },
                    buttons: list.map(id => {
                        const b = document.getElementById(id);
                        if (b.style.display === 'none') b.style.display = 'flex'; /* map-app.js shows it once the layer is on */
                        const r = b.getBoundingClientRect();
                        return { id, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, parent: b.parentElement.id,
                            position: getComputedStyle(b).position, bottomCss: getComputedStyle(b).bottom };
                    })
                };
            }
            api.select('apm20OpacitySlider');
            await wait(300);
            const apm = boxes(document.getElementById(ids[0]).closest('.vertical-opacity-control').id, [ids[0]]);
            api.select('josephineOpacitySlider');
            await wait(300);
            const josCard = document.getElementById(ids[1]).closest('.vertical-opacity-control').id;
            const jos = boxes(josCard, ids.slice(1));
            const panel = document.getElementById('iosBldSettingsPanel');
            panel.classList.add('open');
            await wait(100);
            const p = panel.getBoundingClientRect();
            const card = document.getElementById(josCard).getBoundingClientRect();
            return { apm, jos, josCard, panel: { top: p.top, bottom: p.bottom, left: p.left, right: p.right, height: p.height,
                scrollHeight: panel.scrollHeight, cardMid: (card.top + card.bottom) / 2, cardLeft: card.left,
                viewport: window.innerHeight, viewportWidth: window.innerWidth } };
        }, ACTION_IDS);

        function checkColumn(label, m) {
            let prevBottom = m.card.bottom;
            m.buttons.forEach(b => {
                assert(/verticalOpacityActions/.test(b.parent), label + ': #' + b.id + ' is docked in a mirror slot (' + b.parent + ')');
                assert.strictEqual(b.position, 'relative', label + ': #' + b.id + ' position');
                assert(b.top >= prevBottom - 0.5,
                    label + ': #' + b.id + ' must sit BELOW the previous element (top ' + b.top.toFixed(1) +
                    ' < ' + prevBottom.toFixed(1) + ') — computed bottom ' + b.bottomCss + '; it overlaps the slider card');
                assert(Math.abs(b.cx - m.card.cx) <= 2, label + ': #' + b.id + ' is centred under the slider');
                prevBottom = b.bottom;
            });
            assert(m.buttons[0].top - m.card.bottom <= 24, label + ': the first icon hugs the card (gap ' + (m.buttons[0].top - m.card.bottom).toFixed(1) + 'px)');
        }
        checkColumn('APM 2.0', measured.apm);
        checkColumn('Iosefină Premium (' + measured.josCard + ')', measured.jos);
        assert(measured.panel.height >= measured.panel.scrollHeight - 2,
            'the „Setări detecție” panel keeps its natural height (box ' + measured.panel.height.toFixed(0) +
            'px for ' + measured.panel.scrollHeight + 'px of content)');
        assert(Math.abs((measured.panel.top + measured.panel.bottom) / 2 - measured.panel.cardMid) <= 2,
            'the panel is vertically centred on the Josephine slider');
        /* Josephine was selected second → secondary mirror → the narrower anchor. */
        assert.strictEqual(measured.josCard, 'verticalOpacityControlSecondary', 'Josephine mirrors into the secondary slot when added second');
        assert(measured.panel.left >= 48, 'the panel stays clear of the left control column (left ' + measured.panel.left.toFixed(0) + 'px)');
        assert(measured.panel.right <= measured.panel.cardLeft, 'the panel ends before the slider it belongs to');
        assert(measured.panel.top >= 0 && measured.panel.bottom <= measured.panel.viewport, 'the panel is fully on screen');
        console.log('OK — Chromium (412×915, standalone layout): APM 2.0 icon and the three Iosefină Premium icons');
        console.log('    stack under their slider cards; the settings panel is not squeezed.');
    } finally {
        await browser.close();
        server.close();
    }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
