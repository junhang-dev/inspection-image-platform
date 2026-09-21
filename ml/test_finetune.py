import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml.finetune import output_checkpoint


class CheckpointProtectionTests(unittest.TestCase):
    def test_protects_initial_checkpoint_and_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            initial = Path(tmp) / "initial/model.pt"
            with self.assertRaises(ValueError):
                output_checkpoint(initial, initial.parent)
            output = Path(tmp) / "new"
            output.mkdir()
            ((output / "model.pt").resolve()).touch()
            with self.assertRaises(FileExistsError):
                output_checkpoint(initial, output)

    def test_protects_serving_checkpoint_and_allows_new_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            serving = Path(tmp) / "serving/model.pt"
            initial = Path(tmp) / "initial/model.pt"
            with patch.dict(os.environ, {"MODEL_PATH": str(serving)}):
                with self.assertRaises(ValueError):
                    output_checkpoint(initial, serving.parent)
                output = Path(tmp) / "new"
                self.assertEqual(output_checkpoint(initial, output), (output / "model.pt").resolve())


if __name__ == "__main__":
    unittest.main()
