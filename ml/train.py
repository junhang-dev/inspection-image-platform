"""Train/validation only. Deliberately provides no final-test execution option."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import resource
import time

import numpy as np
import torch
import torchvision
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, confusion_matrix, f1_score

from ml.runtime import PREPROCESSING_VERSION, backbone, decode_image


def validate_manifest(manifest):
    included = [entry for entry in manifest["entries"] if entry["included"]]
    counts = Counter(entry["split"] for entry in included)
    if counts != {"train": 231, "validation": 58, "test": 10}:
        raise ValueError(f"Unexpected fixed split counts: {counts}")
    ids, hashes, groups = set(), {}, {}
    for entry in included:
        if entry["id"] in ids or entry["grade"] not in range(1, 6):
            raise ValueError("Invalid identity or label in fixed manifest")
        ids.add(entry["id"])
        for key, seen in [("sha256", hashes), ("group", groups)]:
            value, split = entry[key], entry["split"]
            if value in seen and seen[value] != split:
                raise ValueError(f"Split overlap: {key}")
            seen[value] = split


def run(args):
    started = time.monotonic()
    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(2)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    torch.hub.set_dir(str(output / "torch-cache.local"))
    raw = Path(args.manifest).read_bytes()
    manifest = json.loads(raw)
    validate_manifest(manifest)
    entries = [e for e in manifest["entries"] if e["included"] and e["split"] in {"train", "validation"}]
    counts = Counter(e["split"] for e in entries)
    if counts != {"train": 231, "validation": 58}:
        raise ValueError(f"Unexpected fixed split counts: {counts}")
    root = Path(manifest["source_root"]).resolve()
    device = torch.device("mps" if args.device == "auto" and torch.backends.mps.is_available() else args.device if args.device != "auto" else "cpu")
    model = backbone(pretrained=True).to(device)
    xs, ys, splits, ids = [], [], [], []
    for offset in range(0, len(entries), 8):
        batch = entries[offset:offset + 8]
        images = []
        for entry in batch:
            path = (root / entry["relative_path"]).resolve()
            if not path.is_relative_to(root):
                raise ValueError("Source path escaped data root")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError(f"Source integrity mismatch: {entry['id']}")
            images.append(decode_image(data))
            ys.append(entry["grade"])
            splits.append(entry["split"])
            ids.append(entry["id"])
        with torch.inference_mode():
            xs.append(model(torch.stack(images).to(device)).cpu().numpy())
        print(json.dumps({"features_complete": min(offset + 8, len(entries)), "total": len(entries), "device": str(device)}), flush=True)
    x, y = np.concatenate(xs), np.array(ys)
    train = np.array(splits) == "train"
    val = ~train
    trials, best = [], None
    # Fixed small grid; validation selects macro F1 then accuracy. Never read test pixels.
    for class_weight in [None, "balanced"]:
        for c in [0.01, 0.1, 1.0, 10.0, 100.0]:
            classifier = LogisticRegression(C=c, class_weight=class_weight, max_iter=2000, random_state=42)
            classifier.fit(x[train], y[train])
            predicted = classifier.predict(x[val])
            metrics = {"C": c, "class_weight": class_weight,
                       "accuracy": float(accuracy_score(y[val], predicted)),
                       "macro_f1": float(f1_score(y[val], predicted, labels=[1, 2, 3, 4, 5], average="macro", zero_division=0)),
                       "balanced_accuracy": float(balanced_accuracy_score(y[val], predicted)),
                       "confusion_matrix": confusion_matrix(y[val], predicted, labels=[1, 2, 3, 4, 5]).tolist(),
                       "binary_accuracy": float(accuracy_score(y[val] >= 3, predicted >= 3)),
                       "review_needed_recall": float(np.mean(predicted[y[val] >= 3] >= 3)),
                       "severe_under_calls": int(np.sum((y[val] >= 4) & (predicted <= 2)))}
            trials.append(metrics)
            print(json.dumps({"trial": len(trials), **metrics}), flush=True)
            score = (metrics["macro_f1"], metrics["accuracy"])
            if best is None or score > best[0]:
                best = (score, classifier, metrics)
    _, classifier, metrics = best
    version = "mobilenetv3small-linear-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact = {"backbone": model.cpu().state_dict(),
                "coef": torch.tensor(classifier.coef_, dtype=torch.float32),
                "intercept": torch.tensor(classifier.intercept_, dtype=torch.float32),
                "model_version": version, "preprocessing_version": PREPROCESSING_VERSION}
    path = output / "model.pt"
    torch.save(artifact, path)
    report = {"model_version": version, "preprocessing_version": PREPROCESSING_VERSION,
              "manifest_sha256": hashlib.sha256(raw).hexdigest(), "split_counts": dict(counts),
              "test_opened": False, "selection": "validation macro_f1 then accuracy", "selected": metrics,
              "trials": trials, "elapsed_seconds": time.monotonic() - started,
              "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              "device": str(device), "mps_available": torch.backends.mps.is_available(),
              "python": platform.python_version(), "torch": str(torch.__version__), "torchvision": str(torchvision.__version__),
              "weights_source": "https://download.pytorch.org/models/mobilenet_v3_small-047dcff4.pth",
              "checkpoint_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "validation_results": [{"id": ids[i], "grade": int(y[i]), "predicted": int(p)}
                                     for i, p in zip(np.flatnonzero(val), classifier.predict(x[val]))]}
    (output / "training-report.local.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k not in {"trials", "validation_results"}}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", default="ml/artifacts")
    parser.add_argument("--device", choices=["auto", "cpu", "mps"], default="auto")
    run(parser.parse_args())
