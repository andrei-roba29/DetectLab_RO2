"""Opt-in raw-DTM RVT sidecar. Never interprets published RGB map tiles as heights.

python -m rvt_service.server (RVT_SOURCES=/absolute/path/sources.json)
Access only through the Express allow-listed /api/rvt proxy; bind to loopback.
"""
import hashlib
import json
import math
import os
import re
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from rvt import vis

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'methods.json').read_text())
CACHE = Path(os.environ.get('RVT_CACHE', '/tmp/detectlab-rvt-cache'))
CACHE.mkdir(parents=True, exist_ok=True)
TILE = 256
MAX_PAD = 128  # deliberately rejects expensive radii rather than making seams
LOCK = Lock()


def sources():
    path = os.environ.get('RVT_SOURCES')
    if not path or not Path(path).is_file():
        return {}
    entries = json.loads(Path(path).read_text())
    # only administrator-owned local raster files, never a caller-supplied URL
    return {key: value for key, value in entries.items()
            if re.fullmatch(r'[A-Za-z0-9_-]{1,60}', key)
            and isinstance(value, dict) and Path(value.get('path', '')).is_file()}


def params_for(method, query, resolution):
    if method not in CONFIG['methods'] or CONFIG['methods'][method].get('unavailable'):
        raise ValueError('Method needs offline preprocessing or is not supported')
    defaults = CONFIG['methods'][method].get('measure', {})
    params = {}
    for field, default in defaults.items():
        value = float(query.get(field, [default])[0])
        if not math.isfinite(value) or value < 0 or value > 2048:
            raise ValueError('Measure out of range')
        params[field] = value
    if method == 'openness':
        mode = query.get('mode', ['positive'])[0]
        if mode not in ('positive', 'negative'): raise ValueError('Invalid openness mode')
        params['mode'] = mode
    if method == 'slrm':
        radius = round(params['smoothing'] / resolution)
        if not 10 <= radius <= 50:
            raise ValueError('RVT SLRM radius must be 10–50 pixels at this zoom; adjust smoothing or zoom')
        pad = radius * 2 + 2
    elif method == 'msrm':
        if params['smallest'] >= params['largest'] or not 1 <= params['scaling'] <= 8:
            raise ValueError('Invalid MSRM feature interval or scaling')
        pad = max(2, math.ceil(params['largest'] / resolution) * 3 + 2)
    else:
        pad = CONFIG['methods'][method]['radiusPx'] + 2
    if pad > MAX_PAD:
        raise ValueError(f'Radius exceeds tile budget ({MAX_PAD} pixels); increase zoom/resolution or precompute offline')
    return params, pad


def calculate(method, dem, resolution, params):
    """Call the RVT implementation with rvt.default.DefaultValues 2.2.3 parameters."""
    if method == 'hillshade': return vis.hillshade(dem, resolution, resolution)
    if method == 'multi-hillshade':
        # RVT returns 16 directional planes. Average float intensities, not rendered images.
        return np.nanmean(vis.multi_hillshade(dem, resolution, resolution), axis=0)
    if method == 'slope': return vis.slope_aspect(dem, resolution, resolution, output_units='degree')['slope']
    if method == 'slrm': return vis.slrm(dem, radius_cell=round(params['smoothing'] / resolution))
    if method == 'msrm':
        return vis.msrm(dem, resolution, params['smallest'], params['largest'], int(params['scaling']))
    if method == 'openness' and params['mode'] == 'negative':
        return vis.sky_view_factor(-dem, resolution, compute_svf=False, compute_opns=True)['opns']
    if method in ('svf', 'asvf', 'openness'):
        flags = {'svf': 'svf', 'asvf': 'asvf', 'openness': 'opns'}
        return vis.sky_view_factor(dem, resolution, compute_svf=method == 'svf',
                                   compute_asvf=method == 'asvf', compute_opns=method == 'openness')[flags[method]]
    if method == 'local-dominance': return vis.local_dominance(dem)
    if method == 'sky-illumination': return vis.sky_illumination(dem, resolution)
    raise ValueError('Unsupported method')


def tile(layer, method, z, x, y, query):
    if layer not in sources(): raise ValueError('No local bare-earth DTM registered for this layer')
    if not 0 <= z <= 22 or not 0 <= x < 2 ** z or not 0 <= y < 2 ** z:
        raise ValueError('Invalid tile coordinates')
    item = sources()[layer]
    path = Path(item['path'])
    # Web Mercator XYZ grid; RVT gets *ground* metre/pixel, correcting Mercator scale.
    mercator_pixel = 40075016.68557849 / (2 ** z * TILE)
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + .5) / 2 ** z))))
    resolution = mercator_pixel * math.cos(math.radians(lat))
    params, pad = params_for(method, query, resolution)
    revision = (str(path.resolve()), path.stat().st_mtime_ns, path.stat().st_size)
    key = hashlib.sha256(json.dumps([revision, layer, method, z, x, y, params], sort_keys=True).encode()).hexdigest()
    destination = CACHE / (key + '.bin')
    if destination.exists(): return destination.read_bytes()
    with rasterio.open(path) as src:
        if src.count != 1 or not src.crs or src.crs.is_geographic:
            raise ValueError('DTM must be a single-band raster with projected CRS in metres')
        if abs(src.crs.linear_units_factor[1] - 1) > 1e-6:
            raise ValueError('DTM CRS must use metre coordinates')
        if abs(src.res[0] - src.res[1]) > .01 * src.res[0]:
            raise ValueError('DTM pixels must be square')
        if resolution < src.res[0] / 2:
            raise ValueError('Zoom exceeds twice native DTM resolution; zoom out for meaningful terrain results')
        # Full virtual Mercator pyramid, read the padded region BEFORE computing.
        with WarpedVRT(src, crs='EPSG:3857', transform=rasterio.Affine(
                mercator_pixel, 0, -20037508.342789244,
                0, -mercator_pixel, 20037508.342789244),
                width=TILE * 2 ** z, height=TILE * 2 ** z,
                resampling=Resampling.bilinear, nodata=np.nan) as vrt:
            masked = vrt.read(1, window=Window(x*TILE-pad, y*TILE-pad, TILE+2*pad, TILE+2*pad),
                              masked=True).filled(np.nan).astype('float32')
    valid = np.isfinite(masked)
    if not np.any(valid):
        result = np.full((TILE, TILE), np.nan, dtype='<f4')
    else:
        # RVT requires finite neighborhoods; preserve holes and a one-pixel halo around them.
        from scipy.ndimage import distance_transform_edt, binary_dilation
        filled = masked.copy()
        indices = distance_transform_edt(~valid, return_distances=False, return_indices=True)
        filled[~valid] = masked[tuple(indices[:, ~valid])]
        output = np.asarray(calculate(method, filled, resolution, params), dtype=np.float32)
        if output.ndim != 2: raise ValueError('This method needs a multi-band float pyramid')
        crop = pad - 1 if method == 'multi-hillshade' else pad
        result = output[crop:crop+TILE, crop:crop+TILE].copy()
        result[binary_dilation(~valid, iterations=1)[pad:pad+TILE, pad:pad+TILE]] = np.nan
    payload = result.astype('<f4').tobytes()
    # atomic cache writes; computed key includes file revision and all measure settings
    with LOCK:
        if not destination.exists():
            temp = CACHE / (key + '.' + str(os.getpid()) + '.tmp')
            temp.write_bytes(payload)
            temp.replace(destination)
    return payload


def profile(layer, query):
    if layer not in sources(): raise ValueError('No local DTM registered for this layer')
    points = []
    for index in (1, 2):
        lat = float(query['lat' + str(index)][0]); lon = float(query['lon' + str(index)][0])
        if not math.isfinite(lat) or not math.isfinite(lon) or not -85 <= lat <= 85 or not -180 <= lon <= 180:
            raise ValueError('Invalid profile coordinates')
        points.append((lat, lon))
    from rasterio.warp import transform
    lat1, lon1 = points[0]; lat2, lon2 = points[1]
    dy = (lat2-lat1)*111200
    dx = (lon2-lon1)*111200*math.cos(math.radians((lat1+lat2)/2))
    length = math.hypot(dx,dy)
    if not 0 < length <= 5000: raise ValueError('Profile length must be between 0 and 5 km')
    t = np.linspace(0, 1, 101)
    lats = lat1 + t*(lat2-lat1); lons = lon1 + t*(lon2-lon1)
    with rasterio.open(sources()[layer]['path']) as src:
        xs, ys = transform('EPSG:4326', src.crs, lons.tolist(), lats.tolist())
        samples = src.sample(zip(xs, ys), masked=True)
        heights = [None if np.ma.is_masked(v[0]) or not np.isfinite(v[0]) else round(float(v[0]), 3)
                   for v in samples]
    return {'samples': [{'distance': round(float(f*length), 2), 'lat': float(lat), 'lon': float(lon), 'height': height}
                        for f, lat, lon, height in zip(t, lats, lons, heights)]}


def app(environ, start_response):
    path = environ['PATH_INFO'].strip('/').split('/')
    try:
        if path == ['metadata']:
            available = sources()
            data = {}
            for key, value in available.items():
                with rasterio.open(value['path']) as dataset:
                    if (dataset.count != 1 or not dataset.crs or dataset.crs.is_geographic
                            or abs(dataset.crs.linear_units_factor[1] - 1) > 1e-6
                            or abs(dataset.res[0] - dataset.res[1]) > .01 * dataset.res[0]):
                        continue
                    data[key] = {'resolution': abs(dataset.res[0]), 'attribution': value.get('attribution', '')}
            body = json.dumps({'layers': data, 'config': CONFIG}).encode()
            typ = 'application/json'
        elif len(path) == 2 and path[0] == 'profile':
            body = json.dumps(profile(path[1], parse_qs(environ['QUERY_STRING']))).encode()
            typ = 'application/json'
        elif len(path) == 6 and path[0] == 'tile' and path[-1].endswith('.bin'):
            layer, method, z, x, yy = path[1:]
            body = tile(layer, method, int(z), int(x), int(yy[:-4]), parse_qs(environ['QUERY_STRING']))
            typ = 'application/octet-stream'
        else:
            raise ValueError('Unknown route')
        start_response('200 OK', [('Content-Type', typ), ('Content-Length', str(len(body))),
                                  ('Cache-Control', 'public, max-age=3600' if typ != 'application/json' else 'no-store')])
    except (ValueError, KeyError, OSError, rasterio.errors.RasterioError) as exc:
        body = json.dumps({'error': str(exc)}).encode()
        start_response('400 Bad Request', [('Content-Type', 'application/json'), ('Content-Length', str(len(body)))])
    return [body]


if __name__ == '__main__':
    with make_server('127.0.0.1', int(os.environ.get('RVT_PORT', '8765')), app) as server:
        server.serve_forever()
