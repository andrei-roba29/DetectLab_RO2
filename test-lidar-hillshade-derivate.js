// Regression: the global MapTiler hillshade layer is removed in every country.
'use strict';
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('js/map-app.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
assert(!/lidarDerivate|Hillshade LiDAR derivate/i.test(html), 'no layer controls or label remain');
assert(!/lidarDerivate|LIDAR_DERIVATE_BOUNDS|lidar_derivate|\bderivate\s*:|api\.maptiler\.com\/tiles\/hillshade/i.test(app), 'no layer catalogue, filtering or tile endpoint remains');
const tag = 'js/map-app.js?v=20261030-sat60-live-location';
assert(html.includes(tag) && sw.includes("'" + tag + "'"), 'updated application is precached');
assert(/const CACHE_NAME = 'detectlab-v(\d+)-/.exec(sw)[1] >= 313, 'PWA cache is refreshed');
console.log('OK — Hillshade LiDAR derivate is removed globally.');
