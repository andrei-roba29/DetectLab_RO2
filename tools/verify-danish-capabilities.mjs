#!/usr/bin/env node
/* Check every configured Dataforsyningen/Datafordeler WMS layer against its
 * service's GetCapabilities document. Run only from an authorized network;
 * credentials are read from environment variables and are never printed. */
import { config, appendLayerAuth } from '../backend/src/lib/danish-layers.mjs';

const layers = config.layers.filter((layer) => layer.enabled !== false && layer.type === 'wms' &&
    (layer.upstream || /^https:\/\//.test(layer.url || '')));
const groups = new Map();
for (const layer of layers) {
    const endpoint = layer.upstream || layer.url;
    const key = `${layer.auth}|${endpoint}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(layer);
}

function containsLayer(xml, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<Name>\\s*${escaped}\\s*</Name>`, 'i').test(xml);
}

let errors = 0;
for (const [key, group] of groups) {
    const [authType, endpoint] = key.split('|');
    const sample = group[0];
    const url = new URL(endpoint);
    const baseParams = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetCapabilities' });
    const authResult = authType === 'none'
        ? { params: baseParams, missing: [], error: null }
        : appendLayerAuth(sample, baseParams);
    if (authResult.error) {
        console.log(`ERROR ${endpoint}: ${authResult.error}`);
        errors += group.length;
        continue;
    }
    if (authResult.missing.length) {
        console.log(`SKIP ${endpoint}: missing ${authResult.missing.join(', ')}`);
        errors += group.length;
        continue;
    }
    url.search = authResult.params.toString();
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const body = await response.text();
        if (!response.ok || !/<(?:\w+:)?WMS_Capabilities\b|<WMT_MS_Capabilities\b/i.test(body)) {
            console.log(`ERROR ${endpoint}: GetCapabilities HTTP ${response.status} (not a WMS capabilities document)`);
            for (const layer of group) { console.log(`  ${layer.id}: NOT VERIFIED`); errors += 1; }
            continue;
        }
        for (const layer of group) {
            const found = containsLayer(body, layer.layers);
            console.log(`${found ? 'MATCH' : 'MISSING'} ${layer.id}: ${layer.layers}`);
            if (!found) errors += 1;
        }
    } catch (error) {
        console.log(`ERROR ${endpoint}: ${error?.cause?.code || error?.message || 'network failure'}`);
        for (const layer of group) { console.log(`  ${layer.id}: NOT VERIFIED`); errors += 1; }
    }
}
console.log(`\n${errors ? `${errors} layer(s) not confirmed` : 'All configured layer names were found'}.`);
process.exitCode = errors ? 1 : 0;
