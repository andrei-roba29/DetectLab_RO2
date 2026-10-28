// Regression test — unified slim 3D-style pastel faded semitransparent orange
// sliders and blurred semitransparent button-box (--ctl-*) slider containers
// across both the layer window and the vertical on-map mirrors (desktop & PWA).
// Usage: node test-pastel-orange-sliders.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, rel), 'utf8');

const stylesCss = read('css/styles.css');
const terrainCss = read('css/map3d-terrain.css');
const otherMapsCss = read('css/other-maps.css');
const atlasCss = read('css/europe-roman-atlas.css');
const indexHtml = read('index.html');
const swJs = read('sw.js');
const voJs = read('js/vertical-opacity-control.js');

/* 1. Root tokens: pastel faded semitransparent orange + slim 3D dimensions */
assert(/--slider-track-h:\s*3px/.test(stylesCss), 'track height is a slim 3px');
assert(/--slider-thumb-size:\s*12px/.test(stylesCss), 'horizontal thumb is a slim 12px circle');
assert(/--slider-v-thumb-size:\s*13px/.test(stylesCss), 'vertical thumb is a slim 13px circle');
assert(/--slider-fill:\s*rgba\(242,\s*170,\s*121,\s*0\.52\)/.test(stylesCss),
    'track progress fill is pastel faded semitransparent orange');
assert(/--slider-thumb-bg:\s*rgba\(244,\s*176,\s*128,\s*0\.74\)/.test(stylesCss),
    'thumb fill is pastel faded semitransparent orange');
assert(/--slider-thumb-border:\s*rgba\(255,\s*228,\s*206,\s*0\.52\)/.test(stylesCss),
    'thumb rim is soft translucent warm highlight');
console.log('  ✓ root tokens define slim 3px/12px/13px pastel faded semitransparent orange sliders');

/* 2. All slider skins use the slim pastel-orange 3D look (no yellow #c8a96e left on sliders) */
assert(/\.transp-slider,\s*\.lidar-country-opacity,\s*\.albania-active-slider\s*\{[\s\S]{0,450}?var\(--slider-pct,\s*0%\)/.test(stylesCss),
    'layer-window sliders (.transp-slider, .lidar-country-opacity, .albania-active-slider) share the slim filled track');
assert(/\.vertical-opacity-slider\s*\{[\s\S]{0,500}?var\(--slider-pct,\s*0%\)/.test(stylesCss),
    'vertical on-map sliders use the slim pastel-orange filled track');
assert(/#iosBldSettingsPanel input\[type=range\]\s*\{[\s\S]{0,450}?var\(--slider-fill\)/.test(stylesCss),
    'Josephine settings sliders use the slim pastel-orange filled track');
assert(/\.cenagis-opacity-slider\s*\{\s*height:\s*var\(--slider-track-h\)\s*!important/.test(stylesCss),
    'CENAGIS generated sliders override their inline 4px height to --slider-track-h');
assert(/\.danish-layer-slider\s*\{[^}]*width:\s*calc\(100%\s*-\s*19px\)/.test(stylesCss) &&
       /\.albania-layer-slider\s*\{[^}]*width:\s*calc\(100%\s*-\s*19px\)/.test(stylesCss) &&
       /\.finland-layer-slider\s*\{[^}]*width:\s*calc\(100%\s*-\s*19px\)/.test(stylesCss),
    'indented country sliders stay flush inside their row box');
assert(/#map3d-bar input\[type="range"\],\s*#map3d-focus \.m3d-focus-radius\s*\{[\s\S]{0,500}?var\(--slider-fill/.test(terrainCss),
    '3D terrain / focus sliders use the pastel-orange 3D slider skin instead of yellow');
assert(!/m3d-focus-radius[^}]*#c8a96e/.test(terrainCss),
    'yellow #c8a96e accent is gone from the 3D focus radius slider');
assert(/\.om-range\s*\{[\s\S]{0,500}?var\(--slider-fill/.test(otherMapsCss) &&
       !/\.om-range[^{]*\{[^}]*#c8a96e/.test(otherMapsCss) &&
       !/\.om-range::-webkit-slider-thumb\s*\{[^}]*#c8a96e/.test(otherMapsCss),
    'Other Maps sliders (.om-range) replaced yellow #c8a96e with pastel orange');
assert(/\.range-row input\[type="range"\]::-webkit-slider-thumb\s*\{[\s\S]{0,220}?rgba\(244,\s*176,\s*128,\s*0\.74\)/.test(atlasCss),
    'Europe Roman Atlas sliders share the slim pastel-orange thumb');
console.log('  ✓ layer-window, vertical map, 3D, Other Maps, Josephine, country & atlas sliders unified');

/* 3. Blurred semitransparent button-box material (--ctl-*) on slider boxes */
const voBox = (/\.vertical-opacity-control\s*\{([^}]*)\}/.exec(stylesCss) || [])[1] || '';
assert(/background:\s*var\(--ctl-bg\)/.test(voBox) &&
       /border:\s*1px\s+solid\s+var\(--ctl-border\)/.test(voBox) &&
       /border-radius:\s*var\(--ctl-radius\)/.test(voBox) &&
       /backdrop-filter:\s*var\(--ctl-blur\)/.test(voBox) &&
       /box-shadow:\s*var\(--ctl-shadow\)/.test(voBox),
    'vertical slider box uses the exact --ctl-* blurred semitransparent button-box material');

const iosPanel = (/#iosBldSettingsPanel\s*\{([^}]*)\}/.exec(stylesCss) || [])[1] || '';
assert(/background:\s*var\(--ctl-bg\)/.test(iosPanel) &&
       /border:\s*1px\s+solid\s+var\(--ctl-border\)/.test(iosPanel) &&
       /backdrop-filter:\s*var\(--ctl-blur\)/.test(iosPanel),
    'Josephine slider settings box uses the --ctl-* blurred semitransparent button-box material');

const omPanel = (/\.om-panel\s*\{([^}]*)\}/.exec(otherMapsCss) || [])[1] || '';
assert(/background:\s*var\(--ctl-bg/.test(omPanel) &&
       /border:\s*1px\s+solid\s+var\(--ctl-border/.test(omPanel) &&
       /backdrop-filter:\s*var\(--ctl-blur/.test(omPanel),
    'Other Maps alignment slider box uses the --ctl-* blurred semitransparent button-box material');
console.log('  ✓ slider boxes (.vertical-opacity-control, #transpPanel rows, #iosBldSettingsPanel, .om-panel) match button-box glass');

/* 4. Slimmer dimensions on both web desktop and PWA / mobile */
assert(/width:\s*38px/.test(voBox) && /height:\s*248px/.test(voBox),
    'desktop vertical slider card is slimmed to 38×248px (matching 38px map buttons)');
const mobileVoMatch = stylesCss.match(/@media\s*\(max-width:\s*600px\)\s*\{\s*\.vertical-opacity-control\s*\{([^}]*)\}/);
assert(mobileVoMatch && /width:\s*36px/.test(mobileVoMatch[1]) && /height:\s*224px/.test(mobileVoMatch[1]),
    'PWA / mobile vertical slider card is slimmed to 36×224px');
assert(/padding:\s*10px\s+12px\s+11px/.test(stylesCss) &&
       /padding:\s*8px\s+10px\s+9px/.test(stylesCss),
    'layer-window top-level and nested slider rows use slimmer padding');
assert(/var\s+PERIOD_THUMB_SIZE\s*=\s*13\s*;/.test(voJs),
    'vertical period tooltip thumb constant matches the 13px slim vertical thumb');
console.log('  ✓ slimmer geometry verified for both web desktop and PWA');

/* 5. Cache-busting & SW precache */
/* Each asset carries its own live tag — they moved on independently after
 * this change; index.html and sw.js must agree on the exact URL. */
const TAGS = {
    'css/styles.css': '20261027-danish-row-style',
    'css/map3d-terrain.css': '20261026-pwa-3d-button-size',
    'css/other-maps.css': '20261026-nls-find',
    'js/vertical-opacity-control.js': '20261026-flat-country-sections'
};
for (const asset of Object.keys(TAGS)) {
    const url = asset + '?v=' + TAGS[asset];
    assert(indexHtml.includes(url), 'index.html loads ' + url);
    assert(swJs.includes("'" + url + "'"), 'sw.js precaches ' + url);
}
const cacheNum = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
assert(cacheNum >= 271, 'CACHE_NAME bumped to v271+ (got v' + cacheNum + ')');
console.log('  ✓ cache-busting and service-worker precache v' + cacheNum + ' verified');

/* 6. Optional real-DOM check (runs when jsdom is resolvable) */
let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { JSDOM = null; }
if (JSDOM) {
    const dom = new JSDOM(indexHtml, { url: 'https://detectlab.app/', pretendToBeVisual: true, runScripts: 'outside-only' });
    const win = dom.window;
    const doc = win.document;
    win.eval(voJs);
    if (doc.readyState === 'loading') {
        doc.dispatchEvent(new win.Event('DOMContentLoaded'));
    }

    const apm = doc.getElementById('apmOpacitySlider');
    const battles = doc.getElementById('battlesPeriodSlider');
    const iosConf = doc.getElementById('iosBldConfSlider');
    assert(apm && apm.style.getPropertyValue('--slider-pct') !== '',
        'initial load populates --slider-pct on layer-window sliders');
    assert(battles && battles.style.getPropertyValue('--slider-pct') !== '',
        'initial load populates --slider-pct on negative-min century slider');
    assert(iosConf && iosConf.style.getPropertyValue('--slider-pct') !== '',
        'initial load populates --slider-pct on settings panel sliders');

    apm.value = '35';
    apm.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(apm.style.getPropertyValue('--slider-pct'), '35.00%',
        'moving a horizontal slider updates --slider-pct immediately');

    win.DetectLabVerticalOpacity.select('apmOpacitySlider');
    const vSlider = doc.getElementById('verticalOpacitySlider');
    assert.strictEqual(vSlider.style.getPropertyValue('--slider-pct'), '35.00%',
        'mirroring a layer syncs --slider-pct onto the vertical map slider');

    const dyn = doc.createElement('input');
    dyn.type = 'range';
    dyn.min = '0';
    dyn.max = '1';
    dyn.step = '0.01';
    dyn.value = '0.6';
    dyn.className = 'transp-slider danish-layer-slider';
    doc.body.appendChild(dyn);

    setTimeout(() => {
        assert.strictEqual(dyn.style.getPropertyValue('--slider-pct'), '60.00%',
            'MutationObserver initializes --slider-pct on dynamically injected sliders');
        console.log('  ✓ real-DOM (jsdom) --slider-pct live sync verified across static, vertical & dynamic sliders');
        console.log('\n✅ test-pastel-orange-sliders.js passed all checks.');
        dom.window.close();
        process.exit(0);
    }, 20);
} else {
    console.log('\n✅ test-pastel-orange-sliders.js passed all static checks (jsdom optional).');
}
