import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageOps
import torch

from ml.explain import SourceGuard, Logits, gradient_shap
from ml.roi import decode_roi, pixel_bbox
from ml.runtime import decode_image, TRANSFORM
from ml.roi_service import subprocess_result, until_disconnect, create_app


class RoiTests(unittest.TestCase):
    def test_exif_all_directions_and_full_parity(self):
        pixels = np.arange(9 * 7 * 3, dtype=np.uint8).reshape(7, 9, 3)
        for orientation in range(1, 9):
            raw = io.BytesIO()
            image = Image.fromarray(pixels)
            exif = image.getexif()
            exif[274] = orientation
            image.save(raw, format="JPEG", exif=exif)
            data = raw.getvalue()
            checksum = hashlib.sha256(data).hexdigest()
            full, geometry = decode_roi(data, {"x": 0, "y": 0, "w": 1, "h": 1})
            self.assertTrue(torch.equal(full, decode_image(data)))
            roi = {"x": 0.2, "y": 0.1, "w": 0.4, "h": 0.5}
            cropped, geometry = decode_roi(data, roi)
            with Image.open(io.BytesIO(data)) as source:
                oriented = ImageOps.exif_transpose(source).convert("RGB")
                self.assertEqual([geometry["orientedWidth"], geometry["orientedHeight"]], list(oriented.size))
                expected = TRANSFORM(oriented.crop(tuple(pixel_bbox(roi, *oriented.size))))
                self.assertTrue(torch.equal(cropped, expected))
            self.assertEqual(hashlib.sha256(data).hexdigest(), checksum)

    def test_invalid_roi(self):
        for value in [True, float("nan"), float("inf"), "0", -0.1, 1]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                pixel_bbox({"x": value, "y": 0, "w": 0.1, "h": 0.1}, 50, 70)
        for roi in [{}, {"x": 0.8, "y": 0, "w": 0.3, "h": 1},
                    {"x": 0, "y": 0, "w": 0, "h": 1}]:
            with self.assertRaises(ValueError):
                pixel_bbox(roi, 50, 70)

    def test_guard_checks_both_id_and_actual_hash(self):
        guard = SourceGuard.__new__(SourceGuard)
        guard.test_ids, guard.test_hashes = {"test-id"}, {"test-hash"}
        guard.entries = {"train-id": {"sha256": "train-hash"}}
        for identity, checksum in [("renamed", "test-hash"), ("test-id", "other"),
                                    ("train-id", "other")]:
            with self.assertRaises(ValueError):
                guard.check(identity, checksum)
        guard.check("new-upload", "new-bytes")
        with self.assertRaises(ValueError):
            guard.train_bytes("new-upload")

    def test_linear_real_shap_and_seed(self):
        class Linear(torch.nn.Module):
            def forward(self, x):
                return x.flatten(1).sum(1, keepdim=True).repeat(1, 5) * 2
        x = torch.ones((1, 3, 4, 4))
        background = torch.zeros((2, 3, 4, 4))
        first = gradient_shap(Linear(), x, background, 3)
        second = gradient_shap(Linear(), x, background, 3)
        self.assertEqual(first["method"], "shap.GradientExplainer")
        self.assertAlmostEqual(first["attributionSum"], 96, places=5)
        self.assertAlmostEqual(first["additivityResidual"], 0, places=5)
        self.assertEqual(first["qualityStatus"], "passed")
        self.assertEqual(first["map"], second["map"])

    def test_http_guards_before_worker(self):
        from fastapi.testclient import TestClient
        from ml.roi import ROI_POLICY
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / 'synthetic.pt'
            checkpoint.write_bytes(b'fake-checkpoint')
            identity = {'model_version': 'fake', 'preprocessing_version': 'fake',
                        'checkpoint_sha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest()}
            guard = SourceGuard.__new__(SourceGuard)
            guard.test_ids, guard.test_hashes = {'protected-id'}, {hashlib.sha256(b'protected-bytes').hexdigest()}
            guard.entries = {'bg': {'included': True, 'split': 'train', 'sha256': 'bg-hash'}}
            config = {'contract': 'synthetic', 'manifest': 'synthetic', 'manifestSha256': 'synthetic',
                      'checkpoint': str(checkpoint), 'backgroundSourceIds': ['bg']}
            with patch('ml.roi_service.read_contract', return_value=identity), patch('ml.roi_service.SourceGuard', return_value=guard):
                app = create_app(config)
            metadata = {'sourceId': 'new-upload', 'originalSha256': '0'*64,
                        'expectedModel': identity, 'roiPolicyVersion': ROI_POLICY}
            with TestClient(app) as client, patch('ml.roi_service.subprocess_result') as worker:
                response = client.post('/v1/explanations', files={'image': ('a.jpg', b'protected-bytes')},
                                       data={'metadata': json.dumps(metadata)})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()['detail'], 'protected_source')
                for body, status in [({**metadata, 'sourceId': 'protected-id'}, 403),
                                     ({**metadata, 'targetGrade': True}, 422),
                                     ({**metadata, 'expectedModel': {}}, 409)]:
                    response = client.post('/v1/roi/predict', files={'image': ('a.jpg', b'x')},
                                           data={'metadata': json.dumps(body)})
                    self.assertEqual(response.status_code, status)
                worker.assert_not_called()
                self.assertFalse(client.get('/health').json()['computeBusy'])

    def test_timeout_and_cancel_reap_child(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                pidfile = path / 'pid'
                command = [sys.executable, "-c", f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(30)"]
                with self.assertRaises(asyncio.TimeoutError):
                    await subprocess_result(command, path / "out", budget=0.5)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
                task = asyncio.create_task(subprocess_result(command, path / "out", budget=30))
                await asyncio.sleep(0.5)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
                class Disconnected:
                    async def receive(self):
                        await asyncio.sleep(0.5)
                        return {"type": "http.disconnect"}
                from fastapi import HTTPException
                with self.assertRaises(HTTPException) as caught:
                    await until_disconnect(Disconnected(), subprocess_result(command, path / 'out'))
                self.assertEqual(caught.exception.status_code, 499)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
