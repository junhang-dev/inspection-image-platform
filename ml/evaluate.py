"""Local evaluation with an explicit immutable freeze contract for final test."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score

from ml.runtime import Predictor, PREPROCESSING_VERSION
from ml.train import validate_manifest


FINAL_TEST_REGISTRY = Path(__file__).parent / "artifacts/final-test-access.local"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args):
    manifest = json.loads(Path(args.manifest).read_text())
    validate_manifest(manifest)
    model = Predictor(args.model)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError("Evaluation output exists; do not overwrite")
    if args.split == "test":
        if not args.freeze:
            raise ValueError("Final test requires an approved freeze contract")
        frozen = json.loads(Path(args.freeze).read_text())
        if not (frozen["model_version"] == model.model_version
                and frozen["preprocessing_version"] == PREPROCESSING_VERSION
                and frozen["checkpoint_sha256"] == sha256(args.model)
                and frozen["manifest_sha256"] == sha256(args.manifest)
                and frozen["approved_thresholds"] == {"train_accuracy": 0.9, "test_accuracy": 0.7}):
            raise ValueError("Frozen model, manifest, or approved thresholds do not match")
        # Reserve once before reading any final-test pixels. A failed run needs review.
        test_identity = sorted((entry["id"], entry["sha256"]) for entry in manifest["entries"]
                               if entry["included"] and entry["split"] == "test")
        test_key = hashlib.sha256(json.dumps(test_identity).encode()).hexdigest()
        FINAL_TEST_REGISTRY.mkdir(parents=True, exist_ok=True)
        marker = FINAL_TEST_REGISTRY / f"{test_key}.json"
        with marker.open("x") as handle:
            json.dump({"started": datetime.now(timezone.utc).isoformat(), "model_version": model.model_version}, handle)
    rows = []
    root = Path(manifest["source_root"]).resolve()
    for entry in manifest["entries"]:
        if not entry["included"] or entry["split"] != args.split:
            continue
        path = (root / entry["relative_path"]).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Source path escaped root")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("Original image integrity mismatch")
        result = model.predict(data)
        rows.append({"id": entry["id"], "actual": entry["grade"], **result})
    actual = np.array([r["actual"] for r in rows])
    predicted = np.array([r["grade"] for r in rows])
    report = {"split": args.split, "model_version": model.model_version,
              "preprocessing_version": PREPROCESSING_VERSION, "checkpoint_sha256": sha256(args.model),
              "manifest_sha256": sha256(args.manifest), "count": len(rows),
              "correct": int(np.sum(actual == predicted)), "accuracy": float(accuracy_score(actual, predicted)),
              "macro_f1": float(f1_score(actual, predicted, labels=[1,2,3,4,5], average="macro", zero_division=0)),
              "confusion_matrix": confusion_matrix(actual, predicted, labels=[1,2,3,4,5]).tolist(),
              "binary_accuracy": float(accuracy_score(actual >= 3, predicted >= 3)),
              "review_needed_recall": float(np.mean(predicted[actual >= 3] >= 3)),
              "severe_under_calls": int(np.sum((actual >= 4) & (predicted <= 2))),
              "results": rows}
    with output.open("x") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({k:v for k,v in report.items() if k != "results"}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--split", choices=["train", "validation", "test"], required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--freeze")
    run(parser.parse_args())
