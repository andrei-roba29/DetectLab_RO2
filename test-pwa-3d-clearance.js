/* Regression checks for the installed PWA's 3D bottom controls. */
const assert = require('assert');
const fs = require('fs');
const css = fs.readFileSync('css/map3d-terrain.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
function rule(selector) {
  const start = css.indexOf(selector + ' {');
  assert(start >= 0, `missing ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}
const group = rule('body.is-pwa.is-3d .m3d-toggle-group');
const layer = rule('body.is-pwa.is-3d #detectlab-map #arcgisBasemapCtrl');
assert(group.includes('96px') && group.includes('50% - 22px'));
assert(layer.includes('98px') && layer.includes('50% + 25px'));
for (const r of [group, layer]) {
  assert(r.includes('--map3d-safe-area-bottom'));
  assert(r.includes('--country-exit-lift'));
}
assert(rule('body.is-pwa #map3d-focus').includes('30px + var(--map3d-safe-area-bottom'));
assert(rule('body.is-pwa #map3d-focus .m3d-focus-card').includes('calc(100% - 40px'));
assert(rule('body.is-pwa.is-3d #map3d-bar').includes('142px'));
assert(html.includes('css/map3d-terrain.css?v=20261029-pwa-3d-shortcuts'));
assert(sw.includes('css/map3d-terrain.css?v=20261029-pwa-3d-shortcuts'));
console.log('PWA 3D clearance checks passed');
assert(css.includes('body.is-pwa.is-3d #map3d-bar .m3d-basemap-row { display: none; }'));
assert(rule('body.is-pwa.is-3d #map3d-bar.collapsed .m3d-actions').includes('display: flex'));
assert(!css.includes('body.is-pwa.is-3d #map3d-bar.collapsed .m3d-row'));
