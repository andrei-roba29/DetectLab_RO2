/* Desktop web 3D controls follow the PWA row, without affecting 2D. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync('css/map3d-terrain.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
function rule(selector) {
  const start = css.indexOf(selector + ' {');
  assert(start >= 0, 'missing ' + selector);
  return css.slice(start, css.indexOf('}', start));
}
const prefix = 'body:not(.is-pwa).is-3d ';
const group = rule(prefix + '.m3d-toggle-group');
const basemap = rule(prefix + '#detectlab-map #arcgisBasemapCtrl');
assert(group.includes('50% - 22px') && group.includes('96px'));
assert(basemap.includes('50% + 25px') && basemap.includes('98px'));
assert(basemap.includes('column-reverse') && basemap.includes('pointer-events: auto'));
assert(rule(prefix + '#detectlab-map .leaflet-bottom.leaflet-left').includes('bottom: 0 !important'));
assert(rule(prefix + '#arcgisBasemapCtrl .arcgis-basemap-header').includes('width: 38px'));
assert(css.includes(prefix + '#map3d-toggle,\n' + prefix + '#map3d-refresh {\n    width: 38px;'));
assert(css.includes(prefix + '#map3d-bar .m3d-basemap-row { display: none; }'));
assert(rule(prefix + '#map3d-bar.collapsed .m3d-actions').includes('display: flex'));
assert(css.includes('bottom: calc(142px + var(--country-exit-lift, 0px))')); 
assert(html.includes('css/map3d-terrain.css?v=20261029-web-3d-basemap-row'));
assert(sw.includes('css/map3d-terrain.css?v=20261029-web-3d-basemap-row'));
console.log('Desktop web 3D basemap row checks passed');
