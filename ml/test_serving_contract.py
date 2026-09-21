import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from ml.contract import DEFAULT_CONTRACT, check_health, load_verified_predictor, read_contract
from ml.service import app

CHECKPOINT = Path(__file__).parent / "artifacts/finetune.local/model.pt"


class ServingContractTests(unittest.TestCase):
    def test_frozen_identity_and_health(self):
        env = {"MODEL_PATH": str(CHECKPOINT), "MODEL_CONTRACT_FILE": str(DEFAULT_CONTRACT), "MODEL_REQUIRE_CONTRACT": "1"}
        with patch.dict(os.environ, env), TestClient(app) as client:
            check_health(client.get("/health").json(), read_contract())
            image = Path(__file__).parents[1] / "image/demo/demo-01.jpg"
            response = client.post("/predict", files={"image": ("renamed.jpg", image.read_bytes())})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["model_version"], read_contract()["model_version"])

    def test_wrong_hash_fails_before_checkpoint_loading(self):
        with tempfile.TemporaryDirectory() as tmp:
            contract = read_contract()
            contract["checkpoint_sha256"] = "0" * 64
            path = Path(tmp) / "contract.json"
            path.write_text(json.dumps(contract))
            with patch("ml.runtime.Predictor") as predictor, self.assertRaisesRegex(ValueError, "hash"):
                load_verified_predictor(CHECKPOINT, path)
            predictor.assert_not_called()
            env = {"MODEL_PATH": str(CHECKPOINT), "MODEL_CONTRACT_FILE": str(path), "MODEL_REQUIRE_CONTRACT": "1"}
            with patch.dict(os.environ, env), self.assertRaises(ValueError), TestClient(app):
                pass

    def test_wrong_model_version_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            contract = read_contract()
            contract["model_version"] = "wrong-version"
            path = Path(tmp) / "contract.json"
            path.write_text(json.dumps(contract))
            with self.assertRaisesRegex(ValueError, "version"):
                load_verified_predictor(CHECKPOINT, path)

    def test_health_rejects_wrong_version_and_not_ready(self):
        contract = read_contract()
        with self.assertRaises(ValueError):
            check_health({"ready": False, **contract}, contract)
        with self.assertRaises(ValueError):
            check_health({"ready": True, **contract, "model_version": "other"}, contract)

    def test_docker_context_has_only_explicit_public_allowlist(self):
        root = Path(__file__).parent
        lines = [line for line in (root / ".dockerignore").read_text().splitlines() if line and not line.startswith("#")]
        self.assertEqual(lines[0], "**")
        allowed = {line[1:] for line in lines[1:] if line.startswith("!")}
        self.assertEqual(allowed, {"Dockerfile", ".dockerignore", "requirements-runtime.txt", "__init__.py", "runtime.py", "service.py", "contract.py", "serve.py", "healthcheck.py", "model-contract.json"})
        for name in allowed:
            self.assertTrue((root / name).is_file())
            self.assertFalse((root / name).is_symlink())
        dockerfile = (root / "Dockerfile").read_text()
        self.assertNotIn("COPY .", dockerfile)
        self.assertNotIn("ADD ", dockerfile)
        self.assertNotIn("artifacts/", dockerfile)


if __name__ == "__main__":
    unittest.main()
