'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
    constructor() { this.children = []; this.hidden = false; this.attrs = {}; this.events = {}; }
    appendChild(child) { this.children.push(child); child.parent = this; }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    click() { this.events.click(); }
}
const host = new Element(), window = {};
const document = {querySelector() { return host; }, createElement() { return new Element(); }, body: host};
vm.runInNewContext(fs.readFileSync('js/map-window-dock.js', 'utf8'), {window, document, Object});
const api = window.DetectLabWindowDock; let restored = [];
api.minimize('apm-next', 'APM Next-Gen', () => restored.push('apm'));
api.minimize('lidar-settings', 'LiDAR Settings', () => restored.push('lidar'));
api.minimize('lidar-settings', 'LiDAR Settings', () => { throw Error('duplicate'); });
const dock = host.children[0], [tab, list] = dock.children;
assert.equal(dock.hidden, false); assert.equal(list.hidden, true); assert.equal(list.children.length, 2);
tab.click(); assert.equal(list.hidden, false); assert.equal(tab.attrs['aria-expanded'], 'true');
list.children[1].click(); assert.deepEqual(restored, ['lidar']); assert.equal(list.children.length, 1);
assert.equal(dock.hidden, false, 'other minimized window remains');
api.remove('apm-next'); assert.equal(dock.hidden, true); assert.equal(list.hidden, true);
assert.equal(tab.attrs['aria-expanded'], 'false');
api.minimize('apm-next', 'APM Next-Gen', () => restored.push('apm'));
assert.equal(list.hidden, true, 'drawer starts collapsed after all entries were restored');
console.log('Shared minimized-window drawer: multi-window, restore, removal and collapse OK.');

// The arrow and expanded list move together above mobile system UI. Desktop
// browser placement stays flush with the map; PWA also compensates map bleed,
// aligned with the Leaflet copyright tag (4px + bleed).
const css = fs.readFileSync('css/next-gen-apm.css', 'utf8');
assert.match(css, /@media \(max-width: 768px\), \(pointer: coarse\)\s*\{\s*\.apm-dock\s*\{\s*bottom: calc\(16px \+ env\(safe-area-inset-bottom, 0px\)\);/);
assert.match(css, /body\.is-pwa \.apm-dock\s*\{\s*bottom: calc\(4px \+ var\(--pwa-bleed, 0px\)\);/);
assert.match(css, /\.apm-dock\s*\{[^}]*bottom: 0;/);
const cssUrl = 'css/next-gen-apm.css?v=20261031-dock-leafleet-align';
for (const file of ['index.html', 'sw.js']) {
    assert(fs.readFileSync(file, 'utf8').includes(cssUrl), `${file} uses the updated drawer stylesheet`);
}
console.log('Mobile drawer clears safe area and PWA bleed; cache tags match.');
