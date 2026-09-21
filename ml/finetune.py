"""Small train/validation-only fine-tuning; never replaces the serving checkpoint."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import resource
import time

import numpy as np
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score

from ml.runtime import PREPROCESSING_VERSION, backbone, decode_image
from ml.train import validate_manifest


def output_checkpoint(initial, output):
    checkpoint = (Path(output) / "model.pt").resolve()
    serving_default = Path(__file__).parent / "artifacts/model.pt"
    protected = {Path(initial).resolve(), serving_default.resolve(),
                 Path(os.environ.get("MODEL_PATH", str(serving_default))).resolve()}
    if checkpoint in protected:
        raise ValueError("Output would replace an initial or serving checkpoint")
    if checkpoint.exists():
        raise FileExistsError("Experiment output already exists; use a new directory")
    return checkpoint


def run(args):
    checkpoint = output_checkpoint(args.initial, args.output)
    if args.epochs < 1:
        raise ValueError("epochs must be positive")
    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(2)
    started = time.monotonic()
    raw = Path(args.manifest).read_bytes()
    manifest = json.loads(raw)
    validate_manifest(manifest)
    root = Path(manifest["source_root"]).resolve()
    split = {}
    for name in ["train", "validation"]:
        samples, labels = [], []
        for entry in manifest["entries"]:
            if not entry["included"] or entry["split"] != name:
                continue
            path = (root / entry["relative_path"]).resolve()
            if not path.is_relative_to(root):
                raise ValueError("Source escaped root")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError("Source integrity mismatch")
            samples.append(decode_image(data))
            labels.append(entry["grade"] - 1)
        split[name] = (torch.stack(samples), torch.tensor(labels))
    artifact = torch.load(args.initial, map_location="cpu", weights_only=True)
    if artifact["preprocessing_version"] != PREPROCESSING_VERSION:
        raise ValueError("Preprocessing mismatch")
    model = backbone()
    model.load_state_dict(artifact["backbone"])
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    for block in list(model.features.children())[-3:]:
        for parameter in block.parameters():
            parameter.requires_grad_(True)
    head = torch.nn.Linear(576, 5)
    with torch.no_grad():
        head.weight.copy_(artifact["coef"])
        head.bias.copy_(artifact["intercept"])
    optimizer = torch.optim.AdamW([
        {"params": [p for p in model.parameters() if p.requires_grad], "lr": 0.0001},
        {"params": head.parameters(), "lr": 0.0003},
    ], weight_decay=0.01)
    frequencies = torch.bincount(split["train"][1], minlength=5).float()
    class_weights = (frequencies.sum() / (5 * frequencies)).sqrt()
    criterion = torch.nn.CrossEntropyLoss(weight=class_weights)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    trials, best_score, stale = [], None, 0
    best_artifact = artifact
    for epoch in range(args.epochs + 1):
        # Frozen BN statistics avoid unstable batch statistics with a small dataset.
        model.eval()
        if epoch:
            order = torch.randperm(len(split["train"][1]))
            x, y = split["train"]
            for indices in order.split(16):
                batch = x[indices]
                if bool(torch.rand(()) < 0.5):
                    batch = batch.flip(-1)
                optimizer.zero_grad(set_to_none=True)
                loss = criterion(head(model(batch)), y[indices])
                loss.backward()
                optimizer.step()
        x, labels = split["validation"]
        with torch.inference_mode():
            predicted = torch.cat([head(model(batch)).argmax(1) for batch in x.split(16)]).numpy() + 1
        actual = labels.numpy() + 1
        metrics = {"epoch": epoch, "accuracy": float(accuracy_score(actual, predicted)),
                   "macro_f1": float(f1_score(actual, predicted, labels=[1, 2, 3, 4, 5], average="macro", zero_division=0)),
                   "confusion_matrix": confusion_matrix(actual, predicted, labels=[1, 2, 3, 4, 5]).tolist(),
                   "binary_accuracy": float(accuracy_score(actual >= 3, predicted >= 3)),
                   "review_needed_recall": float(np.mean(predicted[actual >= 3] >= 3)),
                   "severe_under_calls": int(np.sum((actual >= 4) & (predicted <= 2)))}
        score = (metrics["macro_f1"], metrics["accuracy"])
        trials.append(metrics)
        print(json.dumps(metrics), flush=True)
        if best_score is None or score > best_score:
            best_score, stale = score, 0
            best_metrics = metrics
            # Clone tensors: subsequent optimizer steps must not mutate the saved best.
            best_artifact = {"backbone": {k: v.detach().clone() for k, v in model.state_dict().items()},
                             "coef": head.weight.detach().clone(), "intercept": head.bias.detach().clone(),
                             "model_version": "mobilenetv3small-ft-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                             "preprocessing_version": PREPROCESSING_VERSION}
        else:
            stale += 1
        if stale >= 10:
            break
    with checkpoint.open("xb") as handle:
        torch.save(best_artifact, handle)
    report = {"initial_model": artifact["model_version"], "model_version": best_artifact["model_version"],
              "preprocessing_version": PREPROCESSING_VERSION, "manifest_sha256": hashlib.sha256(raw).hexdigest(),
              "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
              "trials": trials, "selected": best_metrics, "stagnant_epochs": stale,
              "elapsed_seconds": time.monotonic() - started, "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              "device": "cpu", "test_opened": False, "serving_checkpoint_replaced": False}
    (output / "finetune-report.local.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "trials"}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--initial", default="ml/artifacts/model.pt")
    parser.add_argument("--output", default="ml/artifacts/finetune.local")
    parser.add_argument("--epochs", type=int, default=12)
    run(parser.parse_args())
