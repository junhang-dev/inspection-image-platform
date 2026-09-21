import argparse
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from ml.evaluate import run, sha256
from ml.runtime import PREPROCESSING_VERSION


class FinalEvaluationGuardTests(unittest.TestCase):
    def test_freeze_mismatch_and_once_only_final_test(self):
        # Synthetic bytes and fake predictor: no real held-out photographs are used.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entries = []
            for split, count in [("train", 231), ("validation", 58), ("test", 10)]:
                for i in range(count):
                    name = f"{split}-{i}"
                    data = name.encode()
                    (root / name).write_bytes(data)
                    entries.append({"id": name, "relative_path": name, "sha256": hashlib.sha256(data).hexdigest(),
                                    "grade": 1 + i % 5, "group": name, "split": split, "included": True})
            manifest = root / "manifest.local.json"
            manifest.write_text(json.dumps({"source_root": str(root), "entries": entries}))
            model = root / "model.pt"
            model.write_bytes(b"fake-weights")
            freeze = root / "freeze.local.json"
            contract = {"model_version": "fake-v1", "preprocessing_version": PREPROCESSING_VERSION,
                        "checkpoint_sha256": "incorrect", "manifest_sha256": sha256(manifest),
                        "approved_thresholds": {"train_accuracy": 0.9, "test_accuracy": 0.7}}
            freeze.write_text(json.dumps(contract))
            args = argparse.Namespace(manifest=str(manifest), model=str(model), freeze=str(freeze), split="test", output=str(root / "result.local.json"))
            with patch("ml.evaluate.Predictor") as predictor, patch("ml.evaluate.FINAL_TEST_REGISTRY", root / "registry.local"):
                predictor.return_value.model_version = "fake-v1"
                predictor.return_value.predict.return_value = {"grade": 1, "confidence": 1.0,
                    "model_version": "fake-v1", "preprocessing_version": PREPROCESSING_VERSION}
                with self.assertRaises(ValueError):
                    run(args)
                predictor.return_value.predict.assert_not_called()
                contract["checkpoint_sha256"] = sha256(model)
                freeze.write_text(json.dumps(contract))
                with redirect_stdout(io.StringIO()):
                    run(args)
                self.assertEqual(predictor.return_value.predict.call_count, 10)
                report = json.loads(Path(args.output).read_text())
                self.assertEqual((report["correct"], report["count"]), (2, 10))
                args.output = str(root / "another-result.local.json")
                copied_freeze = root / "copied-freeze.local.json"
                copied_freeze.write_text(freeze.read_text())
                args.freeze = str(copied_freeze)
                with self.assertRaises(FileExistsError):
                    run(args)
                self.assertEqual(predictor.return_value.predict.call_count, 10)


if __name__ == "__main__":
    unittest.main()
