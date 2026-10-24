/* ============================================================
   DetectLab — ASIG (Albania) layer catalogue — GENERATED FILE
   Do not edit: run `node tools/build-asig-catalogue.mjs`
   (source: curated spec (no export)).
   Sections, order, display titles, exact WMS/WMTS names, endpoints
   and the Heritage parts. js/asig-albania-layers.config.js adds the
   request rules; js/asig-albania-layers.js draws the panel.
   ============================================================ */
(function (root, factory) {
    'use strict';
    var data = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = data;
    if (root) root.ASIG_LAYERS_CATALOGUE = data;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';
    return {
    "schema": 1,
    "generatedBy": "tools/build-asig-catalogue.mjs",
    "source": "curated spec (no export)",
    "attribution": "Data: ASIG, Albanian State Authority for Geospatial Information (geoportal.asig.gov.al)",
    "licence": {
      "state": "unverified",
      "holder": "ASIG — Autoriteti Shtetëror për Informacionin Gjeohapësinor",
      "url": "https://geoportal.asig.gov.al",
      "note": "ASIG has not published reuse terms for this service. Treat the tiles as © ASIG, all rights reserved, until confirmed in writing."
    },
    "service": {
      "root": "https://geoportal.asig.gov.al/service/",
      "wms": "https://geoportal.asig.gov.al/service/wms",
      "wmts": "https://geoportal.asig.gov.al/service/wmts",
      "nativeCrs": "EPSG:6870",
      "wmtsVersion": "1.0.0",
      "wmtsStyle": "default",
      "wmtsTileMatrixSet": "EPSG:4326",
      "wmtsTileMatrixPrefix": "EPSG:4326:",
      "wmtsFormat": "image/png"
    },
    "bounds": [
      [
        39.538,
        18.773
      ],
      [
        42.758,
        21.179
      ]
    ],
    "sectionLabels": {
      "orthophotos": {
        "ro": "Orthophotos",
        "en": "Orthophotos"
      },
      "terrain": {
        "ro": "Terrain",
        "en": "Terrain"
      },
      "cadastre": {
        "ro": "Cadastre",
        "en": "Cadastre"
      },
      "maps": {
        "ro": "Maps",
        "en": "Maps"
      },
      "environment": {
        "ro": "Environment",
        "en": "Environment"
      },
      "planning": {
        "ro": "Planning & mining",
        "en": "Planning & mining"
      }
    },
    "zoom": {
      "min": 7,
      "wmsMaxNative": 19,
      "orthoMaxNative": 18,
      "wmtsMaxNative": 20,
      "max": 22
    },
    "heritage": {
      "id": "heritage",
      "title": "Heritage",
      "note": "Protected areas, natural monuments, protected cultural sites and every archaeological zone published by ASIG.",
      "opacity": 0.85,
      "keyword": "archaeolog|archeolog|arkeolog",
      "parts": [
        {
          "id": "heritage_natural_protected_areas",
          "title": "Natural Protected Areas",
          "name": "akzm:zonat_mbrojtura_081124",
          "nameSource": "repo",
          "url": "https://geoportal.asig.gov.al/service/akzm/wms",
          "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
          "dynamic": false
        },
        {
          "id": "heritage_natural_monument",
          "title": "Natural monument",
          "name": "akzm:monumentet_natyrore_07032023",
          "nameSource": "repo",
          "url": "https://geoportal.asig.gov.al/service/akzm/wms",
          "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
          "dynamic": false
        },
        {
          "id": "heritage_cultural_protected_sites_point",
          "title": "Cultural protected sites (point)",
          "name": "iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026",
          "nameSource": "repo",
          "url": "https://geoportal.asig.gov.al/service/iktk/wms",
          "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
          "dynamic": false
        },
        {
          "id": "heritage_cultural_protected_sites_polygon",
          "title": "Cultural protected sites (polygon)",
          "name": "iktk:zonatembrojturatetrashegimisekulturore22_07_2026",
          "nameSource": "repo",
          "url": "https://geoportal.asig.gov.al/service/iktk/wms",
          "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
          "dynamic": false
        },
        {
          "id": "heritage_dynamic",
          "title": "Automatically detected archaeological layers",
          "name": null,
          "nameSource": "resolver",
          "url": "https://geoportal.asig.gov.al/service/wms",
          "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
          "dynamic": true,
          "keywordMatch": true
        }
      ]
    },
    "sections": [
      {
        "id": "orthophotos",
        "title": "Orthophotos",
        "note": "Aerial imagery by survey year. Older flights are the ones metal detecting reports are usually drawn on.",
        "registry": {
          "group": "sat-hist",
          "z": 400
        },
        "layers": [
          {
            "id": "ortho_76_86_25k",
            "title": "Ortofoto 76 86 25k",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 76 86 25k"
          },
          {
            "id": "orto_94",
            "title": "Ortofoto 94",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 94"
          },
          {
            "id": "ortho_2007",
            "title": "Ortofoto 2007",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 2007"
          },
          {
            "id": "ortho_2015",
            "title": "Ortofoto 2015",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 2015"
          },
          {
            "id": "ortho_2015_20cm",
            "title": "Ortofoto 2015 (20 cm)",
            "kind": "wms",
            "name": "orthophoto_2015:OrthoImagery_20cm",
            "nameSource": "repo",
            "url": "https://geoportal.asig.gov.al/service/orthophoto_2015/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18
          },
          {
            "id": "ortho_2015_8cm",
            "title": "Ortofoto 2015 (8 cm)",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 2015 (8 cm)"
          },
          {
            "id": "ortho_cir",
            "title": "Ortofoto CIR",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto CIR"
          },
          {
            "id": "ortho_cir_8cm",
            "title": "Ortofoto CIR (8 cm)",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto CIR (8 cm)"
          },
          {
            "id": "ortho_2018",
            "title": "Ortofoto 2018",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 2018"
          },
          {
            "id": "ortho_2001",
            "title": "Ortofoto 2001",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 2001"
          },
          {
            "id": "ortho_1999",
            "title": "Ortofoto 1999",
            "kind": "wms",
            "name": "Orthophoto:Ortofoto_1999",
            "nameSource": "repo",
            "url": "https://geoportal.asig.gov.al/service/Orthophoto/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18
          },
          {
            "id": "ortho_1957",
            "title": "Ortofoto 1957",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 1957"
          },
          {
            "id": "ortho_1976_1980",
            "title": "Ortofoto 1976–1980",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto 1976–1980"
          },
          {
            "id": "ortho_durres_1986",
            "title": "Ortofoto Durrës 1986",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 18,
            "resolveByTitle": "Ortofoto Durrës 1986"
          }
        ]
      },
      {
        "id": "terrain",
        "title": "Terrain",
        "note": "Hillshade and surface model. Both are published as WMTS tiles only.",
        "registry": {
          "group": "lidar",
          "z": 610
        },
        "layers": [
          {
            "id": "hillshade_2015",
            "title": "Hillshade 2015",
            "kind": "wmts",
            "name": "Dtm_2015:Hillshade_2015_group",
            "nameSource": "repo",
            "url": "https://geoportal.asig.gov.al/service/wmts",
            "fallbackUrl": null,
            "format": "image/png",
            "transparent": true,
            "opacity": 0.5,
            "minZoom": 7,
            "maxNativeZoom": 20
          },
          {
            "id": "dsm_hill",
            "title": "Dsm Hill Group",
            "kind": "wmts",
            "name": "DSM:Dsm_Hill_Group",
            "nameSource": "repo",
            "url": "https://geoportal.asig.gov.al/service/wmts",
            "fallbackUrl": null,
            "format": "image/png",
            "transparent": true,
            "opacity": 0.6,
            "minZoom": 7,
            "maxNativeZoom": 20
          }
        ]
      },
      {
        "id": "cadastre",
        "title": "Cadastre",
        "note": "Cadastral zones and parcels. Exact WMS names are read from the export.",
        "registry": {
          "group": "uat",
          "z": 402
        },
        "layers": [
          {
            "id": "cadastral_zone",
            "title": "Cadastral Zone",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Cadastral Zone"
          },
          {
            "id": "cadastral_parcels",
            "title": "Cadastral Parcels",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Cadastral Parcels"
          },
          {
            "id": "cadastral_parcels_ashk",
            "title": "Cadastral Parcels (ASHK)",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Cadastral Parcels (ASHK)"
          }
        ]
      },
      {
        "id": "maps",
        "title": "Maps",
        "note": "Historical maps and the topographic series.",
        "registry": {
          "group": "hist-free",
          "z": 640
        },
        "layers": [
          {
            "id": "italiane_100k",
            "title": "italiane 100k",
            "kind": "wmts",
            "name": "hartat_historike:italiane_100k",
            "nameSource": "repo",
            "url": "https://geoportal.asig.gov.al/service/wmts",
            "fallbackUrl": null,
            "format": "image/png",
            "transparent": true,
            "opacity": 1,
            "minZoom": 7,
            "maxNativeZoom": 20
          },
          {
            "id": "krgjsh_25k",
            "title": "25k_krgjsh_1",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "25k_krgjsh_1"
          }
        ]
      },
      {
        "id": "environment",
        "title": "Environment",
        "note": "Water courses and water bodies.",
        "registry": {
          "group": "asig-env",
          "z": 618
        },
        "layers": [
          {
            "id": "water_course",
            "title": "Water course link",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.9,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Water course link"
          }
        ]
      },
      {
        "id": "planning",
        "title": "Planning & mining",
        "note": "Mining hazard and planning areas by Council of Ministers decision (DCM / VKM).",
        "registry": {
          "group": "asig-plan",
          "z": 646
        },
        "layers": [
          {
            "id": "planned_areas_dcm347",
            "title": "Areas Planned by (DCM 347)",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Areas Planned by (DCM 347)"
          },
          {
            "id": "mining_hazard_dcm726",
            "title": "Mining Hazardous Areas (DCM 726)",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Mining Hazardous Areas (DCM 726)"
          },
          {
            "id": "mining_hazard_dcm347",
            "title": "Mining Hazardous Areas (DCM 347)",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Mining Hazardous Areas (DCM 347)"
          },
          {
            "id": "old_mining_areas",
            "title": "Old Mining Areas",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Old Mining Areas"
          },
          {
            "id": "mineral_resources",
            "title": "Mineral Resouces",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Mineral Resouces"
          },
          {
            "id": "mining_permits",
            "title": "Mining exploitation permits",
            "kind": "wms",
            "name": null,
            "nameSource": "unresolved",
            "url": "https://geoportal.asig.gov.al/service/wms",
            "fallbackUrl": "https://geoportal.asig.gov.al/service/wms",
            "format": "image/png",
            "transparent": true,
            "opacity": 0.85,
            "minZoom": 7,
            "maxNativeZoom": 19,
            "resolveByTitle": "Mining exploitation permits"
          }
        ]
      }
    ],
    "unresolved": [
      "Ortofoto 76 86 25k",
      "Ortofoto 94",
      "Ortofoto 2007",
      "Ortofoto 2015",
      "Ortofoto 2015 (8 cm)",
      "Ortofoto CIR",
      "Ortofoto CIR (8 cm)",
      "Ortofoto 2018",
      "Ortofoto 2001",
      "Ortofoto 1957",
      "Ortofoto 1976–1980",
      "Ortofoto Durrës 1986",
      "Cadastral Zone",
      "Cadastral Parcels",
      "Cadastral Parcels (ASHK)",
      "25k_krgjsh_1",
      "Water course link",
      "Areas Planned by (DCM 347)",
      "Mining Hazardous Areas (DCM 726)",
      "Mining Hazardous Areas (DCM 347)",
      "Old Mining Areas",
      "Mineral Resouces",
      "Mining exploitation permits"
    ]
  };
}));
