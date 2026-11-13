/*
 * Cloudflare Worker equivalents of the URL-only portions of the eight
 * browser builders registered in js/layer-registry.js. The formulas, KVP
 * order, rounding, encoding and default modes intentionally mirror those
 * modules; test/map3d-adapters.test.mjs compares their output byte-for-byte
 * with the existing Netlify VM adapter for every advertised mode.
 *
 * Keep this file data/URL-only: image reprojecting stays in the existing
 * browser layer where required, and credentials are attached only by the
 * fixed Pages handlers for the Danish and Swedish internal routes.
 */
const MODES = {
  'lidar.nl-ahn': {
    default: 'dtm',
    values: {
      dtm: ['AHN4_DTM_50cm', 'AHN - Hillshade (Multidirectionaal)'],
      relief: ['AHN4_DTM_50cm', 'AHN - Shaded Relief'],
      slope: ['AHN4_DTM_50cm', 'AHN - Slope (kleur)'],
      dsm: ['AHN4_DSM_50cm', 'AHN - Hillshade (Multidirectionaal)'],
      ahn5: ['AHN5_DTM_50cm', 'AHN - Hillshade (Multidirectionaal)'],
      ahn6: ['AHN6_DTM_50cm', 'AHN - Hillshade (Multidirectionaal)']
    }
  },
  'lidar.no-hoydedata': {
    default: 'dtm',
    values: {
      dtm: ['NHM_DTM_25833', 'skyggerelieff'],
      dsm: ['NHM_DOM_25833', 'skyggerelieff'],
      lrm: ['DTM_lokalhoyde_graatone', 'LokalHoyde']
    }
  },
  'lidar.pl-nmt': {
    default: 'cieniowanie',
    values: { cieniowanie: 'ShadedRelief', hipsometria: 'Hypsometry' }
  },
  'lidar.es-mdt': {
    default: 'mapa_lidar',
    values: { mapa_lidar: ['EL.GridCoverage', ''] }
  },
  'lidar.ch-swisstopo': {
    default: 'relief',
    values: {
      relief: 'ch.swisstopo.swissalti3d-reliefschattierung',
      mono: 'ch.swisstopo.swissalti3d-reliefschattierung_monodirektional',
      surface: 'ch.swisstopo.swisssurface3d-reliefschattierung-multidirektional',
      bathy: 'ch.swisstopo.swissbathy3d-reliefschattierung'
    }
  },
  'lidar.uk-ea': {
    default: 'hillshade',
    values: {
      hillshade: ['lidar-composite-digital-terrain-model-dtm-1m', 'Lidar_Composite_Hillshade_DTM_1m', 'hillshade'],
      elevation: ['lidar-composite-digital-terrain-model-dtm-1m', 'Lidar_Composite_Elevation_DTM_1m', 'elevation'],
      dtm: ['lidar-composite-digital-terrain-model-dtm-1m', 'Lidar_Composite_DTM_1m', ''],
      dsmHillshade: ['lidar-composite-digital-surface-model-last-return-dsm-1m', 'Lidar_Composite_Hillshade_LZ_DSM_1m', 'hillshade']
    }
  },
  'lidar.dk-dhm': {
    default: 'terrain',
    values: {
      terrain: 'dhm_terraen_skyggekort',
      surface: 'dhm_overflade_skyggekort'
    }
  },
  'lidar.se-lantmateriet': {
    default: 'terrangskuggning',
    values: {
      terrangskuggning: 'terrangskuggning',
      terranglutning: 'terranglutning',
      terranglutning_brunton: 'terranglutning_brunton',
      ursprung_kvalitet: 'ursprung_kvalitet'
    }
  }
};

const round = (n, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function tileBounds3857(z, x, y) {
  const half = Math.PI * 6378137;
  const size = (2 * half) / Math.pow(2, z);
  const minX = -half + x * size;
  const maxY = half - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

function modeFor(id, requested) {
  const entry = MODES[id];
  if (!entry) return null;
  return entry.values[requested] || entry.values[entry.default];
}

export function moduleModes(id) {
  const entry = MODES[id];
  return entry ? Object.keys(entry.values) : [];
}

/** Build the exact URL emitted by the original registry module builder. */
export function map3dCountryTileUrl(id, { z, x, y, mode } = {}) {
  const selected = modeFor(id, mode);
  if (selected == null) return '';
  const bbox = tileBounds3857(z, x, y);

  switch (id) {
    case 'lidar.nl-ahn': {
      const [service, renderingRule] = selected;
      const params = [
        'f=image', 'format=png32', 'bbox=' + bbox.map(round6).join(','),
        'bboxSR=3857', 'imageSR=3857', 'size=256,256', 'transparent=true',
        'adjustAspectRatio=false', 'interpolation=RSP_BilinearInterpolation',
        'renderingRule=' + encodeURIComponent(JSON.stringify({ rasterFunction: renderingRule }))
      ];
      return `https://ahn.arcgisonline.nl/arcgis/rest/services/Hoogtebestand/${service}/ImageServer/exportImage?${params.join('&')}`;
    }
    case 'lidar.no-hoydedata': {
      const [service, renderingRule] = selected;
      const params = [
        'f=image', 'format=png32', 'bbox=' + bbox.map(round6).join(','),
        'bboxSR=3857', 'imageSR=3857', 'size=256,256', 'transparent=true',
        'interpolation=RSP_BilinearInterpolation',
        'renderingRule=' + encodeURIComponent(JSON.stringify({ rasterFunction: renderingRule }))
      ];
      return `https://hoydedata.no/arcgis/rest/services/${service}/ImageServer/exportImage?${params.join('&')}`;
    }
    case 'lidar.pl-nmt': {
      const params = [
        'SERVICE=WMS', 'VERSION=1.3.0', 'REQUEST=GetMap',
        'LAYERS=Raster', 'STYLES=', 'CRS=EPSG%3A3857',
        'BBOX=' + bbox.map((n) => round(n)).join(','), 'WIDTH=256', 'HEIGHT=256',
        'FORMAT=image%2Fpng', 'TRANSPARENT=TRUE'
      ];
      return `https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WMS/${selected}?${params.join('&')}`;
    }
    case 'lidar.es-mdt': {
      const [layer, styles] = selected;
      const params = [
        'SERVICE=WMS', 'REQUEST=GetMap', `LAYERS=${encodeURIComponent(layer)}`,
        `STYLES=${encodeURIComponent(styles)}`, 'FORMAT=image%2Fpng',
        'TRANSPARENT=true', 'VERSION=1.1.1', 'CONTINUOUSWORLD=true', 'TILED=true',
        'INFO_FORMAT=text%2Fxml', 'WIDTH=256', 'HEIGHT=256', 'SRS=EPSG%3A3857',
        'BBOX=' + bbox.map((n) => round(n)).join(',')
      ];
      return `https://wms-mapa-lidar.idee.es/lidar?${params.join('&')}`;
    }
    case 'lidar.ch-swisstopo':
      return `https://wmts.geo.admin.ch/1.0.0/${selected}/default/current/3857/${z}/${x}/${y}.png`;
    case 'lidar.uk-ea': {
      const [service, layer, style] = selected;
      return `https://environment.data.gov.uk/spatialdata/${service}/wmts?service=WMTS&request=GetTile&version=1.0.0&layer=${layer}&style=${style}&tileMatrixSet=WebMercatorQuad&format=image%2Fpng&transparent=true&tileMatrix=${z}&tileRow=${y}&tileCol=${x}`;
    }
    case 'lidar.dk-dhm':
      return `/api/geo/dk-dhm?service=WMTS&request=GetTile&version=1.0.0&layer=${selected}&style=default&tilematrixset=View1&format=image%2Fjpeg&TileMatrix=${z}&TileCol=${x}&TileRow=${y}`;
    case 'lidar.se-lantmateriet':
      return `/api/geo/se-hojdmodell?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${encodeURIComponent(selected)}&STYLES=&SRS=EPSG%3A3857&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng&TRANSPARENT=true&TILED=true`;
    default:
      return '';
  }
}
