"""Run with: python -m unittest rvt_service.test_server (in the RVT environment)."""
import json
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

from . import server


class RvtServiceTest(unittest.TestCase):
    def test_method_catalogue(self):
        self.assertEqual([len(group) for group in server.CONFIG['groups'].values()], [3, 3, 5, 6])
        self.assertEqual(len(set(sum(server.CONFIG['groups'].values(), []))), 17)
        self.assertEqual(server.params_for('openness', {'mode':['negative']}, 1)[0]['mode'], 'negative')

    def test_radius_and_input_validation(self):
        self.assertEqual(server.params_for('slrm', {}, 1)[0]['smoothing'], 20)
        for query, resolution in [({'smoothing': ['999']}, 1), ({'smoothing': ['nan']}, 1),
                                  ({'smallest': ['30'], 'largest': ['20']}, 1)]:
            with self.assertRaises(ValueError):
                server.params_for('msrm' if 'smallest' in query else 'slrm', query, resolution)
        with self.assertRaises(ValueError): server.params_for('mstp', {}, 1)

    def test_real_float_tiles_and_nodata(self):
        with tempfile.TemporaryDirectory() as folder:
            dtm = Path(folder) / 'terrain.tif'
            pixels = np.arange(512 * 512, dtype='float32').reshape(512, 512) * .001
            pixels[100:130,100:130] = -9999
            with rasterio.open(dtm, 'w', driver='GTiff', count=1, width=512, height=512,
                               dtype='float32', nodata=-9999, crs='EPSG:3857',
                               transform=from_origin(0, 512, 1, 1)) as dst:
                dst.write(pixels, 1)
            manifest = Path(folder) / 'sources.json'
            manifest.write_text(json.dumps({'nlAhn': {'path': str(dtm)}}))
            prior = os.environ.get('RVT_SOURCES')
            os.environ['RVT_SOURCES'] = str(manifest)
            try:
                for method in ('hillshade', 'multi-hillshade', 'slrm', 'svf', 'openness'):
                    data = np.frombuffer(server.tile('nlAhn', method, 17, 65536, 65535, {}), dtype='<f4')
                    self.assertEqual(data.size, 256 * 256)
                    self.assertTrue(np.isfinite(data).any())
                with self.assertRaises(ValueError): server.tile('roLidar','hillshade',17,65536,65535,{})
                result = server.profile('nlAhn', {'lat1':['0.001'],'lon1':['0.001'],'lat2':['0.002'],'lon2':['0.002']})
                self.assertEqual(len(result['samples']),101)
            finally:
                if prior is None: os.environ.pop('RVT_SOURCES', None)
                else: os.environ['RVT_SOURCES'] = prior


if __name__ == '__main__': unittest.main()
