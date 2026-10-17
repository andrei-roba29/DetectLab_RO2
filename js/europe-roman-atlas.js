/* European country picker and Roman-world layers, adapted from the supplied
   ArcGIS SceneView reference. This page is deliberately isolated from the
   Leaflet interaction map so its 3D globe, ground and basemaps do not interfere
   with DetectLab's existing map layers. */
(function (window, document) {
  'use strict';
  if (!window || !document) return;

  var $ = function (id) { return document.getElementById(id); };
  var SHP_URL = 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/ne_10m_admin_0_countries.shp';
  var ATLAS_URLS = ['data/countries-50m.json', 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json'];
  var ROADS_URL = 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/route-segments-all-1791445468011.ndjson';
  var PLEIADES_URLS = [
    'https://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz',
    'http://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz'
  ];
  var STATIC = 'https://raw.githubusercontent.com/andrei-roba29/geo_data/master/Cultural-Data/';
  var HILLSHADE_URL = 'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer';
  var TERRAIN_URL = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';
  var lang = 'ro';
  var eu = [];
  var byName = new Map();
  var selected = new Set();
  var hovered = null;
  var countryGraphics;
  var casingGraphics;
  var labelGraphics;
  var romanGroup;
  var map;
  var view;
  var hillshade;
  var terrain;
  var baseImagery;
  var baseTopo;
  var baseTerrain;
  var staticCache = new Map();
  var dareLayers = new Map();
  var dareRegistry = new Map();
  var dareEnabled = new Set();
  var roadsLayer = null;
  var roadsRaw = [];
  var roadsMercator = false;
  var placesLayer = null;
  var placeRows = [];
  var placesLoading = false;
  var roadsLoading = false;
  var dareInFlight = false;
  var dareAgain = false;
  var dareTimer = 0;
  var pointerSequence = 0;
  var tipTimer = 0;
  var tipId = null;
  var tip = $('tip');

  var TEXT = {
    ro: {
      title: 'Atlas european și roman', countries: 'Țări europene', searchCountry: 'Caută o țară…',
      zoomSelection: 'Apropie selecția', clear: 'Șterge', mapLayers: 'Straturi hartă',
      hillshade: 'World Hillshade', opacity: 'Opacitate', terrain: 'Relief 3D (elevație)',
      basemap: 'Hartă de bază', imagery: 'Imagery ArcGIS', topographic: 'Topographic ArcGIS', terrainBase: 'Terrain ArcGIS',
      dareSites: 'Situri romane DARE', allCategories: '(20 categorii)', categoriesFilter: 'Categorii și filtru',
      all: 'Toate', none: 'Niciuna', countryIso: 'ISO2 țară', walls: 'Ziduri (AWMC)',
      regionalNames: 'Nume regionale (AWMC)', politicalShading: 'Extinderi istorice', romanLayer: 'Straturi romane',
      romanRoads: 'Drumuri romane', swapRoadCoords: 'Inversează coordonatele din fișierul drumurilor',
      pleiadesSites: 'Situri romane (Pleiades)', sitePeriod: 'Perioada siturilor',
      periodR: 'Romane (30–300 e.n.)', periodRH: '+ Republicane (din 330 î.e.n.)',
      periodRL: '+ Antichitate târzie (până în 640 e.n.)', dataNote: 'Straturile sunt încărcate la cerere. Pentru DARE, apropie harta la nivelul 7 sau mai mult.',
      shpFallback: 'Încarcă manual fișierul .shp:', loading: 'Se încarcă harta…',
      selectedNone: 'Selectează o țară de pe hartă sau bifeaz-o din listă.', noCountries: 'Nu există țări pentru această căutare.',
      outlinesShp: 'Contururi rafinate cu fișierul .shp:', outlinesAtlas: 'Contururi din world-atlas 50m.',
      shpUnavailable: 'Fișierul .shp nu este disponibil; poți încărca unul manual.',
      noCategory: 'DARE: nu este selectată nicio categorie.', zoomForDare: 'DARE: apropie harta la nivelul 7+ pentru a încărca siturile (acum {zoom}).',
      selectedPrefix: 'Selectate ({n}): ',
      daeLoading: 'Se încarcă…'
    },
    en: {
      title: 'European & Roman Atlas', countries: 'European countries', searchCountry: 'Search country…',
      zoomSelection: 'Zoom to selection', clear: 'Clear', mapLayers: 'Map layers',
      hillshade: 'World Hillshade', opacity: 'Opacity', terrain: '3D terrain (elevation)',
      basemap: 'Basemap', imagery: 'Imagery ArcGIS', topographic: 'Topographic ArcGIS', terrainBase: 'Terrain ArcGIS',
      dareSites: 'DARE Roman sites', allCategories: '(20 categories)', categoriesFilter: 'Categories & filter',
      all: 'All', none: 'None', countryIso: 'Country ISO2', walls: 'Walls (AWMC)',
      regionalNames: 'Regional names (AWMC)', politicalShading: 'Historical extents', romanLayer: 'Roman layers',
      romanRoads: 'Roman roads', swapRoadCoords: 'Swap coordinates in roads file',
      pleiadesSites: 'Roman sites (Pleiades)', sitePeriod: 'Site period',
      periodR: 'Roman (AD 30–300)', periodRH: '+ Republican (from 330 BCE)',
      periodRL: '+ Late Antique (to AD 640)', dataNote: 'Layers load on demand. Zoom to level 7 or higher to load DARE sites.',
      shpFallback: 'Pick a .shp file manually:', loading: 'Loading map…',
      selectedNone: 'Click a country on the map (or tick it in the list) to select it.', noCountries: 'No countries match this search.',
      outlinesShp: 'Outlines refined from your .shp file:', outlinesAtlas: 'Outlines from world-atlas 50m data.',
      shpUnavailable: 'The .shp file is unavailable; you can pick one manually.',
      noCategory: 'DARE: no category selected.', zoomForDare: 'DARE: zoom in to level 7+ to load sites (now {zoom}).',
      selectedPrefix: 'Selected ({n}): ', daeLoading: 'Loading…'
    }
  };

  /* world-atlas feature names → localized names from the reference */
  var NAMES = {
    'Albania': ['Albania', 'Albania'], 'Andorra': ['Andorra', 'Andorra'], 'Austria': ['Austria', 'Austria'],
    'Belarus': ['Belarus', 'Belarus'], 'Belgium': ['Belgium', 'Belgia'],
    'Bosnia and Herz.': ['Bosnia and Herzegovina', 'Bosnia și Herțegovina'],
    'Bulgaria': ['Bulgaria', 'Bulgaria'], 'Croatia': ['Croatia', 'Croația'], 'Cyprus': ['Cyprus', 'Cipru'],
    'Czechia': ['Czechia', 'Cehia'], 'Denmark': ['Denmark', 'Danemarca'], 'Estonia': ['Estonia', 'Estonia'],
    'Finland': ['Finland', 'Finlanda'], 'France': ['France', 'Franța'], 'Germany': ['Germany', 'Germania'],
    'Greece': ['Greece', 'Grecia'], 'Hungary': ['Hungary', 'Ungaria'], 'Iceland': ['Iceland', 'Islanda'],
    'Ireland': ['Ireland', 'Irlanda'], 'Italy': ['Italy', 'Italia'], 'Kosovo': ['Kosovo', 'Kosovo'],
    'Latvia': ['Latvia', 'Letonia'], 'Liechtenstein': ['Liechtenstein', 'Liechtenstein'],
    'Lithuania': ['Lithuania', 'Lituania'], 'Luxembourg': ['Luxembourg', 'Luxemburg'], 'Malta': ['Malta', 'Malta'],
    'Moldova': ['Moldova', 'Republica Moldova'], 'Monaco': ['Monaco', 'Monaco'], 'Montenegro': ['Montenegro', 'Muntenegru'],
    'Netherlands': ['Netherlands', 'Țările de Jos'], 'Macedonia': ['North Macedonia', 'Macedonia de Nord'],
    'North Macedonia': ['North Macedonia', 'Macedonia de Nord'], 'Norway': ['Norway', 'Norvegia'],
    'Poland': ['Poland', 'Polonia'], 'Portugal': ['Portugal', 'Portugalia'], 'Romania': ['Romania', 'România'],
    'Russia': ['Russia', 'Rusia'], 'San Marino': ['San Marino', 'San Marino'], 'Serbia': ['Serbia', 'Serbia'],
    'Slovakia': ['Slovakia', 'Slovacia'], 'Slovenia': ['Slovenia', 'Slovenia'], 'Spain': ['Spain', 'Spania'],
    'Sweden': ['Sweden', 'Suedia'], 'Switzerland': ['Switzerland', 'Elveția'], 'Ukraine': ['Ukraine', 'Ucraina'],
    'United Kingdom': ['United Kingdom', 'Regatul Unit'], 'Vatican': ['Vatican City', 'Vatican']
  };
  var ISO_BY_NAME = {
    'Albania': 'AL', 'Andorra': 'AD', 'Austria': 'AT', 'Belarus': 'BY', 'Belgium': 'BE',
    'Bosnia and Herz.': 'BA', 'Bulgaria': 'BG', 'Croatia': 'HR', 'Cyprus': 'CY', 'Czechia': 'CZ',
    'Denmark': 'DK', 'Estonia': 'EE', 'Finland': 'FI', 'France': 'FR', 'Germany': 'DE', 'Greece': 'GR',
    'Hungary': 'HU', 'Iceland': 'IS', 'Ireland': 'IE', 'Italy': 'IT', 'Kosovo': 'XK', 'Latvia': 'LV',
    'Liechtenstein': 'LI', 'Lithuania': 'LT', 'Luxembourg': 'LU', 'Malta': 'MT', 'Moldova': 'MD',
    'Monaco': 'MC', 'Montenegro': 'ME', 'Netherlands': 'NL', 'Macedonia': 'MK', 'North Macedonia': 'MK',
    'Norway': 'NO', 'Poland': 'PL', 'Portugal': 'PT', 'Romania': 'RO', 'Russia': 'RU', 'San Marino': 'SM',
    'Serbia': 'RS', 'Slovakia': 'SK', 'Slovenia': 'SI', 'Spain': 'ES', 'Sweden': 'SE', 'Switzerland': 'CH',
    'Ukraine': 'UA', 'United Kingdom': 'GB', 'Vatican': 'VA'
  };
  var EU_NAMES = new Set(Object.keys(NAMES));
  var NO_DIACRITICS = function (s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); };
  var countryLabel = function (d) { return d.names[lang === 'ro' ? 1 : 0]; };
  var tr = function (key) { return (TEXT[lang] && TEXT[lang][key]) || TEXT.en[key] || key; };
  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function applyLanguage() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (TEXT[lang][key]) node.textContent = TEXT[lang][key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-placeholder');
      if (TEXT[lang][key]) node.setAttribute('placeholder', TEXT[lang][key]);
    });
    if ($('msgtxt') && !$('msg').classList.contains('hide')) $('msgtxt').textContent = tr('loading');
    if (eu.length) renderList();
    if (window.view && typeof window.view.refresh === 'function') window.view.refresh();
  }

  function polygonsOf(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }
  function centroidOf(poly) { return window.d3.geoCentroid({ type: 'Polygon', coordinates: poly }); }
  function looseEurope(poly) {
    var c = centroidOf(poly);
    return c[0] > -32 && c[0] < 190 && c[1] > 34 && c[1] < 82;
  }
  function keepEurope(name, poly) {
    if (name === 'Russia') return true;
    var c = centroidOf(poly);
    return c[0] > -32 && c[0] < 62 && c[1] > 34 && c[1] < 82;
  }
  function bboxArea(poly) {
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    (poly[0] || []).forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    return (maxX - minX) * (maxY - minY);
  }
  function boundsOfPolygons(polygons) {
    var bounds = [Infinity, Infinity, -Infinity, -Infinity];
    (polygons || []).forEach(function (polygon) {
      (polygon || []).forEach(function (ring) {
        (ring || []).forEach(function (point) {
          bounds[0] = Math.min(bounds[0], point[0]);
          bounds[1] = Math.min(bounds[1], point[1]);
          bounds[2] = Math.max(bounds[2], point[0]);
          bounds[3] = Math.max(bounds[3], point[1]);
        });
      });
    });
    return bounds.every(Number.isFinite) ? bounds : null;
  }
  function simplifyRing(ring) {
    if (!ring || ring.length < 40) return ring;
    var out = [ring[0]], last = ring[0];
    for (var i = 1; i < ring.length - 1; i++) {
      var point = ring[i];
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.02) { out.push(point); last = point; }
    }
    out.push(ring[ring.length - 1]);
    return out.length >= 4 ? out : ring;
  }
  function simplifyPolygon(poly) {
    var candidate = poly.map(simplifyRing);
    if (candidate.every(function (ring, i) { return ring === poly[i]; })) return poly;
    var areaBefore = window.d3.geoArea({ type: 'Polygon', coordinates: poly });
    var areaAfter = window.d3.geoArea({ type: 'Polygon', coordinates: candidate });
    return Math.abs(areaAfter - areaBefore) <= 0.0005 + 0.05 * areaBefore ? candidate : poly;
  }
  function buildEurope(shapefileFeatures, world) {
    var worldEurope = world.filter(function (feature) { return EU_NAMES.has(feature.properties && feature.properties.name); });
    var refined = new Map();
    (shapefileFeatures || []).forEach(function (feature) {
      if (!feature.geometry) return;
      var parts = polygonsOf(feature.geometry).filter(looseEurope);
      if (!parts.length) return;
      var largest = parts.reduce(function (a, b) { return bboxArea(a) > bboxArea(b) ? a : b; });
      var centroid = centroidOf(largest);
      var match = worldEurope.find(function (country) { return window.d3.geoContains(country, centroid); });
      if (match) {
        var key = match.properties.name;
        refined.set(key, (refined.get(key) || []).concat(polygonsOf(feature.geometry)));
      }
    });
    var seenIso = new Set();
    return worldEurope.reduce(function (result, feature) {
      var name = feature.properties.name;
      var iso = ISO_BY_NAME[name];
      if (!iso || seenIso.has(iso)) return result;
      seenIso.add(iso);
      var candidates = (refined.get(name) || polygonsOf(feature.geometry)).filter(function (poly) { return keepEurope(name, poly); }).map(simplifyPolygon);
      if (!candidates.length) return result;
      var largest = candidates.reduce(function (a, b) { return bboxArea(a) > bboxArea(b) ? a : b; });
      var center = centroidOf(largest);
      result.push({
        name: name,
        names: NAMES[name],
        iso: iso,
        rings: candidates.reduce(function (all, poly) { return all.concat(poly); }, []),
        bbox: boundsOfPolygons(candidates),
        lat: center[1], lng: center[0], size: Math.sqrt(bboxArea(largest)),
        fromShp: refined.has(name), feature: feature
      });
      return result;
    }, []);
  }

  function setMessage(text, error) {
    var msg = $('msg');
    if (!msg) return;
    $('msgtxt').textContent = text;
    msg.classList.remove('hide');
    if (error) msg.classList.add('error'); else msg.classList.remove('error');
  }
  function hideMessage() { if ($('msg')) $('msg').classList.add('hide'); }

  function symbolFor(country) {
    if (selected.has(country.name)) return { type: 'simple-fill', color: [57, 255, 20, 0.5], outline: { color: [57, 255, 20, 1], width: 1.8 } };
    if (country.name === hovered) return { type: 'simple-fill', color: [57, 255, 20, 0.42], outline: { color: [57, 255, 20, 1], width: 1.5 } };
    return { type: 'simple-fill', color: [107, 95, 130, 0.34], outline: { color: [0, 0, 0, 0.95], width: 0.675 } };
  }
  function casingFor(country) {
    if (selected.has(country.name)) return { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [0, 0, 0, 0.6], width: 3.75 } };
    if (country.name === hovered) return { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [0, 0, 0, 0.6], width: 3.4 } };
    return { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [255, 255, 255, 0.65], width: 1.35 } };
  }
  function restyleCountries() {
    if (!eu.length || !countryGraphics || !casingGraphics) return;
    countryGraphics.graphics.forEach(function (graphic) {
      var country = byName.get(graphic.attributes.name);
      if (country) graphic.symbol = symbolFor(country);
    });
    casingGraphics.graphics.forEach(function (graphic) {
      var country = byName.get(graphic.attributes.name);
      if (country) graphic.symbol = casingFor(country);
    });
    labelGraphics.removeAll();
    eu.filter(function (country) { return selected.has(country.name) || country.name === hovered; }).forEach(function (country) {
      var point = { type: 'point', longitude: country.lng, latitude: country.lat };
      labelGraphics.add(new window.__AtlasGraphic({
        geometry: point,
        symbol: { type: 'label-3d', symbolLayers: [{ type: 'text', text: countryLabel(country), size: 13,
          material: { color: [234, 255, 221] }, halo: { color: [0, 0, 0, 0.8], size: 2 }, font: { weight: 'bold' } }] }
      }));
      if (country.size < 1.2) {
        labelGraphics.add(new window.__AtlasGraphic({ geometry: point,
          symbol: { type: 'simple-marker', style: 'circle', size: 18, color: [0, 0, 0, 0], outline: { color: [0, 0, 0, 0.6], width: 3.75 } } }));
        labelGraphics.add(new window.__AtlasGraphic({ geometry: point,
          symbol: { type: 'simple-marker', style: 'circle', size: 18, color: [0, 0, 0, 0], outline: { color: [57, 255, 20, 1], width: 1.9 } } }));
      }
    });
    document.querySelectorAll('#list input[type="checkbox"]').forEach(function (input) { input.checked = selected.has(input.value); });
    var selectedLabels = Array.from(selected).map(function (name) { return byName.get(name); }).filter(Boolean).map(countryLabel);
    selectedLabels.sort(function (a, b) { return a.localeCompare(b, lang); });
    $('info').textContent = selected.size ? tr('selectedPrefix').replace('{n}', selected.size) + selectedLabels.join(', ') : tr('selectedNone');
  }
  function notifyParentCountrySelection() {
    var single = selected.size === 1 ? byName.get(Array.from(selected)[0]) : null;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'detectlab-atlas-country-selected',
          selectionCount: selected.size,
          iso: single ? single.iso : null,
          name: single ? countryLabel(single) : null,
          bounds: single ? single.bbox : null
        }, window.location.origin);
      }
    } catch (error) { /* country selection still works inside the atlas */ }
  }
  function toggleCountry(name) {
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    restyleCountries();
    notifyParentCountrySelection();
  }
  function setHover(name) {
    if (name === hovered) return;
    hovered = name;
    if (view && view.container) view.container.style.cursor = name ? 'pointer' : 'default';
    restyleCountries();
  }
  function renderList() {
    if (!eu.length) return;
    var query = NO_DIACRITICS($('q').value.trim().toLowerCase());
    var items = eu.filter(function (country) { return NO_DIACRITICS(countryLabel(country).toLowerCase()).indexOf(query) !== -1; })
      .sort(function (a, b) { return countryLabel(a).localeCompare(countryLabel(b), lang); });
    var list = $('list');
    list.textContent = '';
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'mut';
      empty.textContent = tr('noCountries');
      list.appendChild(empty);
    }
    items.forEach(function (country) {
      var row = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'checkbox'; input.value = country.name; input.checked = selected.has(country.name);
      input.addEventListener('change', function () { toggleCountry(country.name); });
      var name = document.createElement('span'); name.className = 'country-name'; name.textContent = countryLabel(country);
      var iso = document.createElement('span'); iso.className = 'mut'; iso.textContent = country.iso;
      row.appendChild(input); row.appendChild(name); row.appendChild(iso); list.appendChild(row);
    });
    restyleCountries();
  }

  function populateCountries(shapefileFeatures, world) {
    eu = buildEurope(shapefileFeatures, world);
    byName = new Map(eu.map(function (country) { return [country.name, country]; }));
    countryGraphics.removeAll(); casingGraphics.removeAll(); labelGraphics.removeAll();
    var polygons = eu.map(function (country) { return new window.__AtlasPolygon({ rings: country.rings, spatialReference: { wkid: 4326 } }); });
    casingGraphics.addMany(eu.map(function (country, index) {
      return new window.__AtlasGraphic({ geometry: polygons[index], attributes: { name: country.name }, symbol: casingFor(country) });
    }));
    countryGraphics.addMany(eu.map(function (country, index) {
      return new window.__AtlasGraphic({ geometry: polygons[index], attributes: { name: country.name }, symbol: symbolFor(country) });
    }));
    var refinedCount = eu.filter(function (country) { return country.fromShp; }).length;
    $('note').textContent = shapefileFeatures ? tr('outlinesShp') + ' ' + refinedCount + '/' + eu.length + '.' : tr('outlinesAtlas');
    renderList();
    hideMessage();
  }
  async function loadCountries() {
    if (!window.d3 || !window.topojson || !window.shapefile) {
      setMessage(lang === 'ro' ? 'Nu s-au putut încărca bibliotecile geografice.' : 'Could not load the geographic libraries.', true);
      return;
    }
    var world = null;
    var loadError = null;
    for (var i = 0; i < ATLAS_URLS.length; i++) {
      try {
        var atlasResponse = await fetch(ATLAS_URLS[i]);
        if (!atlasResponse.ok) throw new Error('HTTP ' + atlasResponse.status);
        var atlas = await atlasResponse.json();
        world = window.topojson.feature(atlas, atlas.objects.countries).features;
        break;
      } catch (error) { loadError = error; }
    }
    if (!world) {
      setMessage((lang === 'ro' ? 'Nu s-au putut încărca datele țărilor: ' : 'Could not load country data: ') + (loadError && loadError.message || ''), true);
      return;
    }
    try {
      setMessage(lang === 'ro' ? 'Se încarcă contururile detaliate…' : 'Loading detailed country outlines…');
      var shape = await window.shapefile.read(SHP_URL);
      populateCountries(shape.features, world);
    } catch (error) {
      console.warn('[Atlas] Detailed country outlines unavailable; using world-atlas.', error);
      populateCountries(null, world);
      $('note').textContent += ' ' + tr('shpUnavailable');
      $('shpPickerWrap').hidden = false;
    }
  }

  function setupMap(EsriMap, SceneView, Basemap, TileLayer, ElevationLayer, GraphicsLayer, Graphic, Polygon, FeatureLayer, GroupLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils) {
    window.__AtlasGraphic = Graphic;
    window.__AtlasPolygon = Polygon;
    baseImagery = new Basemap({ title: 'Imagery ArcGIS', baseLayers: [new TileLayer({ url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer' })] });
    baseTopo = new Basemap({ title: 'Topographic ArcGIS', baseLayers: [new TileLayer({ url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer' })] });
    baseTerrain = new Basemap({
      title: 'Terrain ArcGIS',
      baseLayers: [
        new TileLayer({ url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer' }),
        new TileLayer({ url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Shaded_Relief/MapServer' })
      ]
    });
    hillshade = new TileLayer({ url: HILLSHADE_URL, title: 'World Hillshade', visible: false, opacity: 0.7 });
    terrain = new ElevationLayer({ url: TERRAIN_URL, visible: false });
    casingGraphics = new GraphicsLayer({ title: 'Country casing', elevationInfo: { mode: 'on-the-ground' } });
    countryGraphics = new GraphicsLayer({ title: 'Countries', elevationInfo: { mode: 'on-the-ground' } });
    labelGraphics = new GraphicsLayer({ title: 'Country labels', elevationInfo: { mode: 'relative-to-ground', offset: 25000 } });
    romanGroup = new GroupLayer({ title: 'Roman Empire', visible: false, opacity: 0.7 });
    map = new EsriMap({ basemap: baseImagery, ground: { layers: [terrain] }, layers: [hillshade, casingGraphics, countryGraphics, romanGroup, labelGraphics] });
    view = new SceneView({
      container: 'viewDiv', map: map,
      camera: { position: { longitude: 14, latitude: 40, z: 6500000 }, tilt: 0, heading: 0 },
      environment: { background: { type: 'color', color: [3, 9, 22, 1] }, atmosphereEnabled: false, starsEnabled: false, lighting: { type: 'virtual' } },
      popup: { autoOpenEnabled: false }
    });
    window.view = view;
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin || !event.data || event.data.type !== 'detectlab-atlas-resize') return;
      try { if (view && typeof view.resize === 'function') view.resize(); } catch (error) { /* ArcGIS will retry on its own resize observer */ }
    });
    setupCountryControls();
    setupMapControls();
    window.__AtlasWebMercatorUtils = webMercatorUtils;
    setupRomanLayers(Graphic, FeatureLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils);
    view.when().then(function () {
      try { if (typeof view.resize === 'function') view.resize(); } catch (error) {}
      hideMessage();
      loadCountries();
    }).catch(function (error) {
      console.error('[Atlas] ArcGIS view failed to initialize:', error);
      setMessage((lang === 'ro' ? 'Harta ArcGIS nu a putut fi încărcată: ' : 'The ArcGIS map could not load: ') + (error && error.message || ''), true);
    });
  }

  function setupCountryControls() {
    $('q').addEventListener('input', renderList);
    $('lang').value = lang;
    $('lang').addEventListener('change', function (event) { lang = event.target.value === 'en' ? 'en' : 'ro'; applyLanguage(); });
    $('clear').addEventListener('click', function () { selected.clear(); restyleCountries(); notifyParentCountrySelection(); });
    $('zoomSel').addEventListener('click', function () {
      if (!countryGraphics) return;
      var graphics = [];
      countryGraphics.graphics.forEach(function (graphic) { if (selected.has(graphic.attributes.name)) graphics.push(graphic); });
      if (graphics.length) view.goTo(graphics, { duration: 1200 }).catch(function () {});
    });
    $('shpFile').addEventListener('change', async function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        setMessage(lang === 'ro' ? 'Se citește fișierul .shp…' : 'Reading the .shp file…');
        var shape = await window.shapefile.read(await file.arrayBuffer());
        var atlasResponse = await fetch(ATLAS_URLS[0]);
        var atlas = await atlasResponse.json();
        populateCountries(shape.features, window.topojson.feature(atlas, atlas.objects.countries).features);
      } catch (error) {
        setMessage((lang === 'ro' ? 'Fișierul .shp nu a putut fi citit: ' : 'Could not read the .shp file: ') + error.message, true);
      }
    });
  }

  function setupMapControls() {
    $('hs').addEventListener('change', function (event) { hillshade.visible = event.target.checked; });
    $('hsOp').addEventListener('input', function (event) { hillshade.opacity = Number(event.target.value); });
    $('terr').addEventListener('change', function (event) {
      map.ground.layers.forEach(function (layer) { layer.visible = event.target.checked; });
    });
    $('bm').addEventListener('change', function (event) {
      var value = event.target.value;
      if (value === 'topo') map.basemap = baseTopo;
      else if (value === 'terrain') map.basemap = baseTerrain;
      else map.basemap = baseImagery;
    });
  }

  var CP1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
    0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99,
    0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
  };
  function fixMojibake(value) {
    if (typeof value !== 'string' || !/[\u00c2-\u00f4]/.test(value)) return value;
    var bytes = [];
    for (var character of value) {
      var code = character.codePointAt(0);
      if (code <= 0xff) bytes.push(code);
      else if (CP1252[code] !== undefined) bytes.push(CP1252[code]);
      else return value;
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch (error) { return value; }
  }

  var DARE_CATS = [
    { n: 11, label: 'Major Settlements', g: 'M2 21h20M3 21V11h5v10M8 21V4h7v17M15 21V9h6v12M10.5 8h2M10.5 12h2M10.5 16h2' },
    { n: 12, label: 'Regular Settlements', g: 'M2 21h20M3 21v-8l4-4 4 4v8M13 21v-6l4-4 4 4v6M6 17h2M16 18h2' },
    { n: 13, label: 'Civitas Capitals', g: 'M3 21V11l9-5 9 5v10M12 6V1.5M12 1.5h4.5v3H12M9.5 21v-6h5v6M2 21h20' },
    { n: 14, label: 'Villas', g: 'M2 11l10-7 10 7M4 10v11h16V10M8 21v-6M12 21v-6M16 21v-6M2 21h20' },
    { n: 16, label: 'Roads / Coastal Stations', g: 'M12 2v20M6 4.5h10l3 3-3 3H6zM18 13.5H8l-3 3 3 3h10zM9 22h6' },
    { n: 17, label: 'Major Forts', g: 'M3 21V6h4v3h2V6h6v3h2V6h4v15zM10 21v-5h4v5M3 21h18' },
    { n: 18, label: 'Forts / Castrum', g: 'M6 6h12v12H6zM2.5 2.5h5v5h-5zM16.5 2.5h5v5h-5zM2.5 16.5h5v5h-5zM16.5 16.5h5v5h-5z' },
    { n: 21, label: 'Monasteries', g: 'M2 21h20M3 21V12l9-6 9 6v9M12 8.5v5M9.5 11h5M9 21v-4.5h6V21' },
    { n: 24, label: 'Churches', g: 'M12 1.5v5M9.8 3.7h4.4M5 21v-9l7-5 7 5v9zM10 21v-5h4v5M2 21h20' },
    { n: 32, label: 'Tumuli', g: 'M2 20h20M3.5 20C3.5 13 7.5 9 12 9s8.5 4 8.5 11M12 9V4M12 4h4l-1.2 1.5L16 7h-4' },
    { n: 49, label: 'Passes', g: 'M1.5 20L8 8l4 7 3-5.5 7.5 10.5zM8 8l1.8 3.2M15 9.5l1.5 2.2' },
    { n: 51, label: 'Bridges', g: 'M1.5 9h21M4 9v12M20 9v12M1.5 21h21M4 21c0-5.5 3.5-8.5 8-8.5s8.5 3 8 8.5' },
    { n: 52, label: 'Aqueducts', g: 'M1.5 5.5h21M3 5.5V21M9 5.5V21M15 5.5V21M21 5.5V21M1.5 21h21M3 15.5a3 3 0 0 1 6 0M9 15.5a3 3 0 0 1 6 0M15 15.5a3 3 0 0 1 6 0' },
    { n: 53, label: 'Fortlets / Towers', g: 'M8 21V9h8v12M5.5 9h13V4.5h-2.7V7h-2V4.5h-3.6V7h-2V4.5H5.5zM10.5 21v-4.5h3V21M10.5 12.5h1M4 21h16' },
    { n: 55, label: 'Roads / Milestones', g: 'M2 21h20M8.5 21V8.5a3.5 3.5 0 0 1 7 0V21M10.5 11.5h3M10.5 14.5h3M10.5 17.5h3' },
    { n: 57, label: 'Mines / Quarries', g: 'M5 21.5L16.5 8M6.5 5C12.5 2.5 19.5 6 21 13M6.5 5l2.2 3.2M21 13l-3.4-1.4M3 21.5h5' },
    { n: 61, label: 'Sanctuaries / Temples', g: 'M2 9.5L12 3.5l10 6zM4 9.5h16M6 12v7M10 12v7M14 12v7M18 12v7M3.5 19h17M2 21.5h20' },
    { n: 63, label: 'Cemeteries', g: 'M6.5 21V10a5.5 5.5 0 0 1 11 0v11zM12 8.5v7M9.2 11.2h5.6M3 21h18' },
    { n: 64, label: 'Monuments', g: 'M9.5 20L10.7 6 12 2.5 13.3 6 14.5 20zM7 20h10M5.5 22h13M11 10h2' },
    { n: 66, label: 'Baths', g: 'M2 16c2-2 4 2 6 0s4 2 6 0 4 2 6 0M2 20.5c2-2 4 2 6 0s4 2 6 0 4 2 6 0M7 11.5c-1.5-2 1.5-3 0-5.5M12 11.5c-1.5-2 1.5-3 0-5.5M17 11.5c-1.5-2 1.5-3 0-5.5' }
  ];
  var DARE_BY_N = Object.fromEntries(DARE_CATS.map(function (category) { return [category.n, category]; }));
  DARE_CATS.forEach(function (category) { dareEnabled.add(category.n); });
  function dareIconSvg(number) {
    var category = DARE_BY_N[number];
    if (!category) return '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
      '<defs><filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity=".55"/></filter></defs>' +
      '<circle cx="13" cy="13" r="11.5" fill="#0c111e" fill-opacity=".68" stroke="#CC2222" stroke-width="1.5" filter="url(#s)"/>' +
      '<g transform="translate(4.5 4.5) scale(0.7083)" fill="none" stroke="#ffd9d9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + category.g + '"/></g></svg>';
  }
  function dareIconUri(number) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(dareIconSvg(number)); }
  function dareUrl(bounds, zoom, country) {
    function round4(value) { return Math.round(value * 1e4) / 1e4; }
    return 'https://imperium.ahlfeldt.se/api/geojson.php?bbox=' + bounds.map(round4).join(',') + '&zoom=' + Math.min(Math.round(zoom), 10) +
      (country ? '&cc=' + encodeURIComponent(country.trim().toUpperCase()) : '');
  }
  function parseDare(collection) {
    var result = [];
    ((collection && collection.features) || []).forEach(function (feature) {
      var props = feature.properties || {}, geometry = feature.geometry;
      if (!geometry || geometry.type !== 'Point' || !geometry.coordinates) return;
      var id = String(feature.id != null ? feature.id : props.id != null ? props.id : '');
      if (!id) return;
      var n = parseInt(props.numType, 10);
      if (isNaN(n)) n = parseInt(props.type, 10);
      var raw = props.type_name || props.TYPE || props.feature_type || (isNaN(parseInt(props.type, 10)) ? props.type : '') || props.sympl || '';
      result.push({
        id: id, n: n, name: fixMojibake(String(props.name != null ? props.name : props.NAME || '')).trim(),
        ancient: fixMojibake(String(props.ancient != null ? props.ancient : props.ancient_name || props.ANCIENT || '')).trim(),
        typeRaw: String(raw), country: props.country || '', lon: geometry.coordinates[0], lat: geometry.coordinates[1]
      });
    });
    return result;
  }
  function dareTitle(site) { return site.ancient && site.name ? site.ancient + ' (' + site.name + ')' : (site.ancient || site.name || '(unnamed)'); }
  function dareTypeLabel(site) { return DARE_BY_N[site.n] ? DARE_BY_N[site.n].label : (site.typeRaw || 'Site'); }
  function dareLink(id) { return 'https://imperium.ahlfeldt.se/places/' + encodeURIComponent(id) + '.html'; }

  var ERAS = [
    ['', 'Political shading: none', '', null],
    ['bce60', 'Roman Empire, 60 BCE', 'political_shading/roman_empire_bce_60/roman_empire_bce_60.geojson', [204, 34, 34]],
    ['ce117', 'Roman Empire, 117 CE', 'political_shading/roman_empire_ce_117_extent/roman_empire_ce_117_extent.geojson', [170, 50, 170]],
    ['ce200', 'Roman Empire, 200 CE', 'political_shading/roman_empire_ce_200_extent/roman_empire_ce_200_extent.geojson', [225, 125, 40]],
    ['dio', 'Provinces after Diocletian', 'political_shading/roman_empire_provinces%20post_diocletian/roman_empire_provinces%20post_diocletian.geojson', [60, 140, 205]],
    ['alex', "Alexander's empire", 'political_shading/alexanders_empire/alexanders_empire.geojson', [60, 170, 90]],
    ['pers', 'Persian empire (extent)', 'political_shading/persian_extent/extent_of_the_persian_empire.geojson', [135, 95, 205]],
    ['herod', "Herod's kingdom", 'political_shading/herod/herods_kingdom.geojson', [235, 195, 40]],
    ['hasm', 'Hasmonean kingdom', 'political_shading/hasmonean/hasmonean_kingdom.geojson', [40, 175, 175]]
  ];

  function dareLayer(number, GraphicsLayer) {
    if (!dareLayers.has(number)) {
      var layer = new GraphicsLayer({ title: 'DARE ' + number, visible: dareEnabled.has(number), elevationInfo: { mode: 'relative-to-ground', offset: 1500 } });
      dareLayers.set(number, layer);
      romanGroup.add(layer);
    }
    return dareLayers.get(number);
  }
  function clearDare() {
    dareLayers.forEach(function (layer) { layer.removeAll(); });
    dareRegistry.clear();
    if (tip) tip.style.display = 'none';
  }
  function currentZoom() {
    if (typeof view.zoom === 'number' && view.zoom >= 0) return view.zoom;
    return Math.log2(591657550.5 / view.scale);
  }
  function viewBounds(webMercatorUtils) {
    var extent = view.extent;
    if (extent) {
      var sr = extent.spatialReference;
      if (sr && sr.isWebMercator) extent = webMercatorUtils.webMercatorToGeographic(extent);
      else if (!(sr && sr.isWGS84)) extent = null;
    }
    if (extent && isFinite(extent.xmin)) return [Math.max(-180, extent.xmin), Math.max(-90, extent.ymin), Math.min(180, extent.xmax), Math.min(90, extent.ymax)];
    var center = view.center, zoom = currentZoom();
    if (!center) return null;
    var width = 360 / Math.pow(2, zoom) * (view.width / 256) / 2;
    var height = width * view.height / view.width;
    return [Math.max(-180, center.longitude - width), Math.max(-90, center.latitude - height), Math.min(180, center.longitude + width), Math.min(90, center.latitude + height)];
  }
  function gateDare() { return romanGroup.visible && $('rom').checked && dareEnabled.size > 0 && currentZoom() >= 7; }
  function dareStatus() {
    if (!$('rom').checked) { $('dareSt').textContent = ''; return; }
    if (!dareEnabled.size) { $('dareSt').textContent = tr('noCategory'); return; }
    if (currentZoom() < 7) { $('dareSt').textContent = tr('zoomForDare').replace('{zoom}', currentZoom().toFixed(1)); return; }
  }
  function scheduleDare() {
    window.clearTimeout(dareTimer);
    dareTimer = window.setTimeout(function () {
      fetchDare(window.__AtlasWebMercatorUtils, window.__AtlasGraphic, window.__AtlasGraphicsLayer);
    }, 150);
  }
  async function fetchDare(webMercatorUtils, Graphic, GraphicsLayer) {
    if (!gateDare()) return;
    if (dareInFlight) { dareAgain = true; return; }
    dareInFlight = true;
    try {
      var bounds = viewBounds(webMercatorUtils);
      if (!bounds) return;
      var response = await fetch(dareUrl(bounds, currentZoom(), $('cc').value));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var grouped = new Map(), added = 0;
      parseDare(await response.json()).forEach(function (site) {
        if (dareRegistry.has(site.id) || !DARE_BY_N[site.n] || !dareEnabled.has(site.n)) return;
        dareRegistry.set(site.id, site); added++;
        var graphic = new Graphic({
          geometry: { type: 'point', longitude: site.lon, latitude: site.lat },
          symbol: { type: 'picture-marker', url: dareIconUri(site.n), width: '26px', height: '26px' },
          attributes: { dare: 1, id: site.id, n: site.n, title: dareTitle(site), typeLabel: dareTypeLabel(site) }
        });
        if (!grouped.has(site.n)) grouped.set(site.n, []);
        grouped.get(site.n).push(graphic);
      });
      grouped.forEach(function (graphics, number) { dareLayer(number, GraphicsLayer).addMany(graphics); });
      $('dareSt').textContent = 'DARE: ' + dareRegistry.size.toLocaleString() + ' sites loaded (+' + added + ').';
    } catch (error) { console.warn('[Atlas] DARE request failed; retry on next move.', error); }
    finally {
      dareInFlight = false;
      if (dareAgain) { dareAgain = false; scheduleDare(); }
    }
  }

  function setupRomanLayers(Graphic, FeatureLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils) {
    $('era').innerHTML = ERAS.map(function (era) { return '<option value="' + esc(era[0]) + '">' + esc(era[1]) + '</option>'; }).join('');
    $('cats').innerHTML = DARE_CATS.map(function (category) {
      return '<label><input type="checkbox" data-n="' + category.n + '" checked><img src="' + dareIconUri(category.n) + '" alt=""><span>' + esc(category.label) + '</span></label>';
    }).join('');
    function getStatic(key, relativeUrl, options) {
      if (staticCache.has(key)) return staticCache.get(key);
      var layer = new GeoJSONLayer(Object.assign({ url: STATIC + relativeUrl, title: key, visible: false, popupEnabled: false,
        elevationInfo: { mode: 'on-the-ground' } }, options || {}));
      staticCache.set(key, layer);
      romanGroup.add(layer, 0);
      return layer;
    }
    function wallsLayer() {
      return getStatic('AWMC walls', 'walls/walls.geojson', { renderer: { type: 'simple', symbol: { type: 'simple-line', color: [226, 190, 100, 1], width: 2.4 } } });
    }
    function regionsLayer() {
      var fresh = !staticCache.has('AWMC regional names');
      var layer = getStatic('AWMC regional names', 'regional_name_linework/regional_names_linework.geojson', {
        renderer: { type: 'simple', symbol: { type: 'simple-line', color: [255, 255, 255, 0.5], width: 0.8 } }
      });
      if (fresh) layer.load().then(function () {
        var available = new Set(layer.fields.map(function (field) { return field.name; }));
        var field = ['label', 'name', 'NAME', 'Label', 'LABEL', 'PLabel', 'TITLE', 'Title'].find(function (name) { return available.has(name); });
        if (field) {
          layer.labelingInfo = [{ labelExpressionInfo: { expression: '$feature.' + field }, maxScale: 0, minScale: 6000000,
            symbol: { type: 'label-3d', symbolLayers: [{ type: 'text', size: 10, material: { color: [255, 240, 200] }, halo: { color: [0, 0, 0, 0.85], size: 1.5 } }] } }];
          layer.labelsVisible = true;
        }
      }).catch(function (error) { console.warn('[Atlas] AWMC regional-name layer failed:', error); });
      return layer;
    }
    function eraLayer(code) {
      var era = ERAS.find(function (entry) { return entry[0] === code; });
      if (!era || !era[0]) return null;
      var color = era[3];
      return getStatic('AWMC shading: ' + era[1], era[2], { renderer: { type: 'simple',
        symbol: { type: 'simple-fill', color: [color[0], color[1], color[2], 0.18], outline: { color: [color[0], color[1], color[2], 0.95], width: 1.2 } } } });
    }
    function syncStatic() {
      var era = $('era').value;
      ERAS.forEach(function (entry) {
        if (entry[0]) {
          var key = 'AWMC shading: ' + entry[1];
          if (staticCache.has(key)) staticCache.get(key).visible = false;
        }
      });
      if (era && romanGroup.visible) { var activeEra = eraLayer(era); if (activeEra) activeEra.visible = true; }
      if (staticCache.has('AWMC walls')) staticCache.get('AWMC walls').visible = false;
      if ($('walls').checked && romanGroup.visible) wallsLayer().visible = true;
      if (staticCache.has('AWMC regional names')) staticCache.get('AWMC regional names').visible = false;
      if ($('regn').checked && romanGroup.visible) regionsLayer().visible = true;
      $('attrib').style.display = romanGroup.visible ? 'block' : 'none';
    }
    function periodExpression() { return ({ R: 'R = 1', RH: 'R = 1 OR H = 1', RL: 'R = 1 OR L = 1' })[$('period').value]; }
    function periodCount() {
      return placeRows.filter(function (row) { return $('period').value === 'RH' ? (row.R || row.H) : $('period').value === 'RL' ? (row.R || row.L) : row.R; }).length;
    }
    function setRomanStatus(text) { $('romSt').textContent = text; }
    function addFilePicker(label, accept, handler, id) {
      var existing = $('file-' + id);
      if (existing) return;
      var wrapper = document.createElement('label');
      wrapper.className = 'file-picker'; wrapper.id = 'file-' + id;
      wrapper.textContent = label + ' ';
      var input = document.createElement('input'); input.type = 'file'; input.accept = accept;
      input.addEventListener('change', function () { if (input.files && input.files[0]) handler(input.files[0]); });
      wrapper.appendChild(input); $('romFiles').appendChild(wrapper);
    }
    function addOverlay(layer) { map.add(layer, map.layers.indexOf(labelGraphics)); }

    function buildRoadsLayer() {
      if (roadsLayer) map.remove(roadsLayer);
      var swap = $('swap').checked;
      var wkid = roadsMercator ? 3857 : 4326;
      var graphics = roadsRaw.map(function (road, index) {
        return new Graphic({
          geometry: { type: 'polyline', spatialReference: { wkid: wkid }, paths: swap ? road.paths.map(function (path) { return path.map(function (point) { return [point[1], point[0]]; }); }) : road.paths },
          attributes: { ObjectID: index + 1, name: road.name }
        });
      });
      roadsLayer = new FeatureLayer({
        title: 'Roman roads', source: graphics, objectIdField: 'ObjectID', geometryType: 'polyline', spatialReference: { wkid: wkid },
        fields: [{ name: 'ObjectID', alias: 'ObjectID', type: 'oid' }, { name: 'name', alias: 'name', type: 'string' }],
        renderer: { type: 'simple', symbol: { type: 'simple-line', color: [255, 90, 54, 1], width: 1.8 } },
        elevationInfo: { mode: 'on-the-ground' }, popupEnabled: false, visible: $('roads').checked
      });
      addOverlay(roadsLayer);
      setRomanStatus('Roads: ' + roadsRaw.length.toLocaleString() + ' segments loaded' + (roadsMercator ? ' (Web Mercator).' : '.'));
    }
    function wktPaths(text) {
      var paths = [], regex = /\(([^()]+)\)/g, match;
      while ((match = regex.exec(text))) {
        var points = match[1].split(',').map(function (part) { return part.trim().split(/\s+/).map(Number); }).filter(function (coords) { return coords.length >= 2 && !coords.some(isNaN); });
        if (points.length > 1) paths.push(points);
      }
      return paths;
    }
    function toPaths(geometry) {
      if (!geometry) return [];
      if (typeof geometry === 'string') {
        var text = geometry.trim();
        return text[0] === '{' ? toPaths(JSON.parse(text)) : /LINESTRING/i.test(text) ? wktPaths(text) : [];
      }
      if (Array.isArray(geometry)) {
        if (geometry.length && typeof geometry[0][0] === 'number') return [geometry];
        if (geometry.length && Array.isArray(geometry[0][0]) && typeof geometry[0][0][0] === 'number') return geometry;
        return [];
      }
      switch (geometry.type) {
        case 'Feature': return toPaths(geometry.geometry);
        case 'FeatureCollection': return geometry.features.reduce(function (all, feature) { return all.concat(toPaths(feature)); }, []);
        case 'GeometryCollection': return geometry.geometries.reduce(function (all, item) { return all.concat(toPaths(item)); }, []);
        case 'LineString': return [geometry.coordinates];
        case 'MultiLineString': return geometry.coordinates;
      }
      if (geometry.paths) return geometry.paths;
      return [];
    }
    function recordPaths(record) {
      if (!record || typeof record !== 'object') return [];
      var paths = toPaths(record);
      if (paths.length) return paths;
      var sources = [record, record.properties || {}];
      var keys = ['geometry', 'geom', 'geojson', 'the_geom', 'wkt', 'shape', 'line', 'path', 'coordinates', 'coords'];
      for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
          var value = sources[sourceIndex][keys[keyIndex]];
          if (value == null) continue;
          try { paths = toPaths(value); } catch (error) { paths = []; }
          if (paths.length) return paths;
        }
      }
      return [];
    }
    function recordName(record) {
      var sources = [record.properties || {}, record];
      for (var i = 0; i < sources.length; i++) {
        for (var j = 0; j < ['name', 'title', 'label', 'road', 'route', 'id'].length; j++) {
          var key = ['name', 'title', 'label', 'road', 'route', 'id'][j];
          if (typeof sources[i][key] === 'string' && sources[i][key]) return sources[i][key].slice(0, 120);
        }
      }
      return '';
    }
    function thinPath(path, tolerance) {
      if (!path.length) return path;
      var result = [path[0]], last = path[0];
      for (var i = 1; i < path.length - 1; i++) {
        var point = path[i];
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) > tolerance) { result.push(point); last = point; }
      }
      result.push(path[path.length - 1]);
      return result;
    }
    async function readNdjson(response, onLine, onProgress) {
      if (!response.body || !response.body.getReader) {
        var text = await response.text();
        text.split('\n').forEach(function (line) { if (line.trim()) onLine(line.trim()); });
        return;
      }
      var reader = response.body.getReader(), decoder = new TextDecoder(), total = Number(response.headers.get('content-length')) || 0;
      var buffer = '', received = 0;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.length;
        buffer += decoder.decode(chunk.value, { stream: true });
        var start = 0, index;
        while ((index = buffer.indexOf('\n', start)) >= 0) {
          var line = buffer.slice(start, index).trim(); start = index + 1;
          if (line) onLine(line);
        }
        buffer = buffer.slice(start);
        if (onProgress) onProgress(received, total);
      }
      buffer += decoder.decode();
      if (buffer.trim()) onLine(buffer.trim());
    }
    async function ingestRoads(response) {
      roadsRaw = []; roadsMercator = false;
      var lines = 0, missing = 0, firstKeys = '';
      try {
        await readNdjson(response, function (line) {
          lines++;
          var record;
          try { record = JSON.parse(line); } catch (error) { missing++; return; }
          if (lines === 1) firstKeys = Array.isArray(record) ? '(array)' : Object.keys(record).join(', ');
          var paths = recordPaths(record).filter(function (path) { return path && path.length > 1; });
          if (!paths.length) { missing++; return; }
          if (!roadsRaw.length) roadsMercator = Math.abs(paths[0][0][0]) > 360;
          var tolerance = roadsMercator ? 1000 : 0.01;
          roadsRaw.push({ paths: paths.map(function (path) { return thinPath(path, tolerance); }), name: recordName(record) });
          if (roadsRaw.length % 4000 === 0) setRomanStatus('Roads: ' + lines.toLocaleString() + ' lines read…');
        }, function (received, total) {
          setRomanStatus('Roads: ' + lines.toLocaleString() + ' lines read… ' + (total ? Math.round(received / total * 100) + '%' : ''));
        });
      } catch (error) { setRomanStatus('Roads: read error — ' + error.message); return false; }
      if (!roadsRaw.length) { setRomanStatus('Roads: no geometry recognised in ' + lines + ' lines. Record keys: ' + firstKeys); return false; }
      buildRoadsLayer();
      return true;
    }
    async function loadRoads() {
      if (roadsLoading) return;
      roadsLoading = true; setRomanStatus('Roads: downloading…');
      try {
        var response = await fetch(ROADS_URL);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        await ingestRoads(response);
      } catch (error) {
        console.warn('[Atlas] Roman roads source unavailable:', error);
        setRomanStatus('Roads: server unavailable (' + error.message + '). Pick the file manually.');
        addFilePicker('Roads .ndjson:', '.ndjson,.json,.txt', function (file) { ingestRoads(new Response(file)); }, 'roads');
      } finally { roadsLoading = false; }
    }

    function parseCsv(text) {
      var rows = [], row = [], field = '', quoted = false;
      for (var i = 0; i < text.length; i++) {
        var character = text[i];
        if (quoted) {
          if (character === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
          else field += character;
        } else if (character === '"') quoted = true;
        else if (character === ',') { row.push(field); field = ''; }
        else if (character === '\n' || character === '\r') {
          if (character === '\r' && text[i + 1] === '\n') i++;
          row.push(field); field = '';
          if (row.length > 1 || row[0] !== '') rows.push(row);
          row = [];
        } else field += character;
      }
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      return rows;
    }
    function parsePleiades(text) {
      var rows = parseCsv(text), headers = rows[0].map(function (value) { return value.replace(/^\uFEFF/, '').trim().toLowerCase(); });
      var index = function (key) { return headers.indexOf(key); };
      var idIndex = index('id'), titleIndex = index('title'), descriptionIndex = index('description'), typeIndex = index('featuretypes');
      var latIndex = index('reprlat'), lonIndex = index('reprlong'), pairIndex = index('reprlatlong');
      var keysIndex = index('timeperiodskeys'), periodsIndex = index('timeperiods');
      if (latIndex < 0 && pairIndex < 0) throw new Error('no coordinate column');
      if (keysIndex < 0 && periodsIndex < 0) throw new Error('no time period column');
      var result = [];
      for (var r = 1; r < rows.length; r++) {
        var row = rows[r], lat = parseFloat(row[latIndex]), lon = parseFloat(row[lonIndex]);
        if ((!isFinite(lat) || !isFinite(lon)) && pairIndex >= 0) {
          var pair = String(row[pairIndex] || '').split(/[ ,]+/); lat = parseFloat(pair[0]); lon = parseFloat(pair[1]);
        }
        if (!isFinite(lat) || !isFinite(lon)) continue;
        var tokens = ((keysIndex >= 0 ? row[keysIndex] : '') + ',' + (periodsIndex >= 0 ? row[periodsIndex] : '')).toLowerCase().split(/[\s,;|]+/).filter(Boolean);
        var roman = tokens.indexOf('r') >= 0 || tokens.indexOf('roman') >= 0;
        var hellenistic = tokens.indexOf('h') >= 0 || tokens.some(function (value) { return value.indexOf('hellenistic') === 0; });
        var late = tokens.indexOf('l') >= 0 || tokens.some(function (value) { return value.indexOf('late') === 0; });
        if (!(roman || hellenistic || late)) continue;
        result.push({ pid: row[idIndex], title: row[titleIndex] || '(untitled)', description: row[descriptionIndex] || '',
          types: String(row[typeIndex] || '').replace(/,/g, ', '), lat: lat, lon: lon, R: roman ? 1 : 0, H: hellenistic ? 1 : 0, L: late ? 1 : 0 });
      }
      return result;
    }
    async function bytesToText(buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') throw new Error('gzip decompression is not supported in this browser');
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      }
      return new TextDecoder().decode(bytes);
    }
    function placeRowsForPeriod() {
      return placeRows.filter(function (row) { return $('period').value === 'RH' ? (row.R || row.H) : $('period').value === 'RL' ? (row.R || row.L) : row.R; });
    }
    function buildPlacesLayer() {
      if (!placeRows.length) return;
      if (placesLayer) map.remove(placesLayer);
      var graphics = placeRows.map(function (row, index) {
        return new Graphic({
          geometry: { type: 'point', longitude: row.lon, latitude: row.lat },
          attributes: { ObjectID: index + 1, pid: row.pid || '', title: row.title, description: row.description, types: row.types, R: row.R, H: row.H, L: row.L }
        });
      });
      var field = function (name, type) { return { name: name, alias: name, type: type }; };
      placesLayer = new FeatureLayer({
        title: 'Pleiades — Roman sites', source: graphics, objectIdField: 'ObjectID', geometryType: 'point', spatialReference: { wkid: 4326 },
        definitionExpression: periodExpression(), popupEnabled: false, visible: $('places').checked,
        fields: [{ name: 'ObjectID', alias: 'ObjectID', type: 'oid' }, field('pid', 'string'), field('title', 'string'), field('description', 'string'), field('types', 'string'), field('R', 'small-integer'), field('H', 'small-integer'), field('L', 'small-integer')],
        renderer: { type: 'simple', symbol: { type: 'simple-marker', style: 'circle', size: 6, color: [255, 214, 10, 0.95], outline: { color: [0, 0, 0, 0.7], width: 0.6 } } },
        elevationInfo: { mode: 'on-the-ground' }
      });
      addOverlay(placesLayer);
      setRomanStatus('Sites: ' + periodCount().toLocaleString() + ' Roman-period places (Pleiades). Click a dot for details.');
    }
    async function ingestPlaces(buffer) {
      try { placeRows = parsePleiades(await bytesToText(buffer)); }
      catch (error) { setRomanStatus('Sites: ' + error.message); return false; }
      buildPlacesLayer();
      return true;
    }
    async function loadPlaces() {
      if (placesLoading) return;
      if (placeRows.length) { buildPlacesLayer(); return; }
      placesLoading = true; setRomanStatus('Sites: downloading Pleiades export…');
      try {
        for (var i = 0; i < PLEIADES_URLS.length; i++) {
          try {
            var response = await fetch(PLEIADES_URLS[i]);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            if (await ingestPlaces(await response.arrayBuffer())) return;
          } catch (error) { console.warn('[Atlas] Pleiades source unavailable:', error); }
        }
        setRomanStatus('Sites: Pleiades server unavailable. Pick the CSV.GZ export file.');
        addFilePicker('Pleiades .csv.gz:', '.gz,.csv', function (file) { file.arrayBuffer().then(ingestPlaces); }, 'pleiades');
      } finally { placesLoading = false; }
    }

    function setupRomanControls(Graphic, FeatureLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils) {
      $('rom').addEventListener('change', function (event) {
        romanGroup.visible = event.target.checked;
        if (!event.target.checked) clearDare();
        syncStatic(); dareStatus(); if (event.target.checked) scheduleDare();
      });
      $('romOp').addEventListener('input', function (event) { romanGroup.opacity = Number(event.target.value); });
      $('walls').addEventListener('change', syncStatic);
      $('regn').addEventListener('change', syncStatic);
      $('era').addEventListener('change', syncStatic);
      $('cats').querySelectorAll('input').forEach(function (input) {
        input.addEventListener('change', function () {
          var number = Number(input.dataset.n);
          if (input.checked) dareEnabled.add(number); else dareEnabled.delete(number);
          if (dareLayers.has(number)) dareLayers.get(number).visible = input.checked;
          if (!input.checked) {
            dareLayers.get(number) && dareLayers.get(number).removeAll();
            Array.from(dareRegistry.entries()).forEach(function (entry) { if (entry[1].n === number) dareRegistry.delete(entry[0]); });
          }
          dareStatus(); if (input.checked) scheduleDare();
        });
      });
      function setAll(on) {
        $('cats').querySelectorAll('input').forEach(function (input) { if (input.checked !== on) { input.checked = on; input.dispatchEvent(new Event('change')); } });
      }
      $('catAll').addEventListener('click', function () { setAll(true); });
      $('catNone').addEventListener('click', function () { setAll(false); });
      $('cc').addEventListener('change', function () {
        $('cc').value = $('cc').value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
        clearDare(); scheduleDare();
      });
      $('roads').addEventListener('change', function (event) { if (roadsLayer) roadsLayer.visible = event.target.checked; else if (event.target.checked) loadRoads(); });
      $('swap').addEventListener('change', function () { if (roadsRaw.length) buildRoadsLayer(); });
      $('places').addEventListener('change', function (event) { if (placesLayer) placesLayer.visible = event.target.checked; else if (event.target.checked) loadPlaces(); });
      $('period').addEventListener('change', function () {
        if (!placesLayer) return;
        placesLayer.definitionExpression = periodExpression();
        setRomanStatus('Sites: ' + periodCount().toLocaleString() + ' places in selected period.');
      });
      window._atlasFetchDare = function () { return fetchDare(webMercatorUtils, Graphic, window.__AtlasGraphicsLayer); };
      window._atlasParsePleiades = parsePleiades;
    }
    function periodExpression() { return ({ R: 'R = 1', RH: 'R = 1 OR H = 1', RL: 'R = 1 OR L = 1' })[$('period').value]; }

    function showPlace(graphic) {
      var attributes = graphic.attributes;
      var url = 'https://pleiades.stoa.org/places/' + encodeURIComponent(attributes.pid);
      view.openPopup({ title: attributes.title, location: graphic.geometry, content: function () {
        var element = document.createElement('div');
        element.innerHTML = '<p>' + esc(attributes.description) + '</p><p><b>Types:</b> ' + esc(attributes.types || '–') + '</p><p class="place-names"></p><p><a href="' + url + '" target="_blank" rel="noopener">Open in Pleiades</a></p>';
        fetch('https://pleiades.stoa.org/places/' + encodeURIComponent(attributes.pid) + '/json').then(function (response) { return response.json(); })
          .then(function (data) { var names = element.querySelector('.place-names'); if (names) names.innerHTML = '<b>Names:</b> ' + esc((data.names || []).slice(0, 8).join(', ')); }).catch(function () {});
        return element;
      } });
    }
    function showDare(graphic) {
      var attributes = graphic.attributes;
      view.openPopup({ title: attributes.title, location: graphic.geometry, content: function () {
        var element = document.createElement('div');
        element.innerHTML = '<p><b>Type:</b> ' + esc(attributes.typeLabel) + '</p><p class="mut">DARE Roman Site · Roman Empire</p><p><a href="' + dareLink(attributes.id) + '" target="_blank" rel="noopener">View on DARE</a></p>';
        return element;
      } });
    }
    function setupMapInteractions(Graphic, reactiveUtils, webMercatorUtils) {
      function dareList() { return Array.from(dareLayers.values()); }
      function isDare(result) { return !!(result.graphic && result.graphic.attributes && result.graphic.attributes.dare); }
      view.on('click', function (event) {
        var included = [placesLayer].concat(dareList(), [countryGraphics]).filter(Boolean);
        view.hitTest(event, { include: included }).then(function (response) {
          var place = response.results.find(function (result) { return result.graphic && result.graphic.layer === placesLayer; });
          if (place) { showPlace(place.graphic); return; }
          var dare = response.results.find(isDare);
          if (dare) { showDare(dare.graphic); return; }
          var country = response.results.find(function (result) { return result.graphic && result.graphic.layer === countryGraphics; });
          if (country) toggleCountry(country.graphic.attributes.name);
        });
      });
      function showTip(graphic, event) {
        window.clearTimeout(tipTimer);
        var attributes = graphic.attributes;
        if (tipId !== attributes.id) {
          tipId = attributes.id;
          tip.innerHTML = '<div class="tip-title">' + esc(attributes.title) + '</div><div>Type: ' + esc(attributes.typeLabel) + '</div><div class="mut">DARE Roman Site · Roman Empire</div><a href="' + dareLink(attributes.id) + '" target="_blank" rel="noopener">View on DARE ↗</a>';
        }
        tip.style.left = Math.max(4, Math.min(event.x + 14, view.width - 278)) + 'px';
        tip.style.top = Math.max(4, Math.min(event.y + 14, view.height - 120)) + 'px';
        tip.style.display = 'block';
      }
      function hideTipSoon() {
        window.clearTimeout(tipTimer);
        tipTimer = window.setTimeout(function () { tip.style.display = 'none'; tipId = null; }, 350);
      }
      tip.addEventListener('mouseenter', function () { window.clearTimeout(tipTimer); });
      tip.addEventListener('mouseleave', hideTipSoon);
      view.on('pointer-move', function (event) {
        var sequence = ++pointerSequence;
        view.hitTest(event, { include: dareList().concat([countryGraphics]) }).then(function (response) {
          if (sequence !== pointerSequence) return;
          var dare = response.results.find(isDare);
          if (dare) { showTip(dare.graphic, event); view.container.style.cursor = 'pointer'; setHover(null); return; }
          hideTipSoon();
          var country = response.results.find(function (result) { return result.graphic && result.graphic.layer === countryGraphics; });
          setHover(country ? country.graphic.attributes.name : null);
        });
      });
      reactiveUtils.watch(function () { return view.stationary; }, function (stationary) { if (stationary) { dareStatus(); scheduleDare(); } });
    }

    setupRomanControls(Graphic, FeatureLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils);
    setupMapInteractions(Graphic, reactiveUtils, webMercatorUtils);
  }

  function start() {
    if (typeof window.require !== 'function') {
      setMessage(lang === 'ro' ? 'Loaderul ArcGIS nu a putut fi pornit.' : 'The ArcGIS loader could not be started.', true);
      return;
    }
    window.require([
      'esri/Map', 'esri/views/SceneView', 'esri/Basemap', 'esri/layers/TileLayer', 'esri/layers/ElevationLayer',
      'esri/layers/GraphicsLayer', 'esri/Graphic', 'esri/geometry/Polygon', 'esri/layers/FeatureLayer',
      'esri/layers/GroupLayer', 'esri/layers/GeoJSONLayer', 'esri/core/reactiveUtils', 'esri/geometry/support/webMercatorUtils'
    ], function (EsriMap, SceneView, Basemap, TileLayer, ElevationLayer, GraphicsLayer, Graphic, Polygon, FeatureLayer, GroupLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils) {
      window.__AtlasGraphicsLayer = GraphicsLayer;
      setupMap(EsriMap, SceneView, Basemap, TileLayer, ElevationLayer, GraphicsLayer, Graphic, Polygon, FeatureLayer, GroupLayer, GeoJSONLayer, reactiveUtils, webMercatorUtils);
    }, function (error) {
      console.error('[Atlas] Could not load ArcGIS modules:', error);
      setMessage((lang === 'ro' ? 'Modulele ArcGIS nu s-au încărcat: ' : 'ArcGIS modules failed to load: ') + (error && error.message || ''), true);
    });
    $('lang').value = lang;
    applyLanguage();
  }

  start();
})(window, document);
