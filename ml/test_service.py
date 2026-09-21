"""Model/API checks; real inference uses only approved demo copies from train."""
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from ml.runtime import decode_image
from ml.service import app


class ModelServiceTests(unittest.TestCase):
    def test_no_model_returns_unavailable(self):
        with patch.dict(os.environ, {"MODEL_PATH": "/nonexistent/model.pt"}):
            with TestClient(app) as client:
                self.assertFalse(client.get("/health").json()["ready"])
                self.assertEqual(client.post("/predict", files={"image": ("a.png", b"bad")}).status_code, 503)

    def test_decoder_rejects_non_image(self):
        for data in [b"", b"this is not a picture", b"<svg></svg>"]:
            with self.assertRaises(ValueError):
                decode_image(data)
        blob = io.BytesIO()
        Image.new("RGB", (10, 10)).save(blob, format="GIF")
        with self.assertRaises(ValueError):
            decode_image(blob.getvalue())

    def test_chunked_body_limit_before_multipart(self):
        with TestClient(app) as client:
            def chunks():
                for _ in range(22):
                    yield b"x" * (1024 * 1024)
            response = client.post("/predict", content=chunks(), headers={"Content-Type": "multipart/form-data; boundary=x"})
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.json()["detail"], "request_too_large")

    def test_real_inference_filename_independence_and_errors(self):
        with TestClient(app) as client:
            self.assertTrue(client.get("/health").json()["ready"])
            data = (Path(__file__).parents[1] / "image/demo/demo-01.jpg").read_bytes()
            a = client.post("/predict", files={"image": ("grade_1.jpg", data, "image/jpeg")})
            b = client.post("/predict", files={"image": ("grade_5.jpg", data, "image/jpeg")})
            self.assertEqual(a.status_code, 200)
            self.assertEqual(a.json(), b.json())
            value = a.json()
            self.assertIn(value["grade"], range(1, 6))
            self.assertTrue(0 <= value["confidence"] <= 1)
            self.assertTrue(value["model_version"])
            self.assertTrue(value["preprocessing_version"])
            self.assertEqual(client.post("/predict", files={"image": ("bad.jpg", b"bad")}).status_code, 422)
            self.assertEqual(client.post("/predict").status_code, 422)
            self.assertEqual(client.post("/predict", files={"image": ("big.jpg", bytes(20 * 1024 * 1024 + 1))}).status_code, 413)


if __name__ == "__main__":
    unittest.main()
