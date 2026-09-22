"""Exactly two predeclared local candidates; no final-test pixels or serving writes."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score

from ml.contract import load_verified_predictor, read_contract
from ml.explain import SourceGuard, digest_json
from ml.runtime import decode_image, PREPROCESSING_VERSION


CANDIDATES = [
    {"name": "last-block-regularized", "blocks": 1, "weightExponent": 0.5},
    {"name": "rare-grade-balanced", "blocks": 3, "weightExponent": 1.0},
]
COMMON = {"epochs": 4, "seed": 42, "threads": 2, "batchSize": 16,
          "backboneLr": 0.00002, "headLr": 0.00005, "labelSmoothing": 0.05,
          "weightDecay": 0.01, "augmentation": "horizontal-flip-batch-p0.5"}


def metrics(actual, predicted):
    return {"accuracy": float(accuracy_score(actual, predicted)),
            "macro_f1": float(f1_score(actual, predicted, labels=[1, 2, 3, 4, 5], average="macro", zero_division=0)),
            "confusion_matrix": confusion_matrix(actual, predicted, labels=[1, 2, 3, 4, 5]).tolist(),
            "severe_under_calls": int(np.sum((actual >= 4) & (predicted <= 2)))}


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)


def run(config, output):
    output = Path(output)
    # One ledger directory for this authorized two-candidate unit. It cannot be
    # reused after either success or failure; recovery requires reviewing it.
    output.mkdir(parents=False, exist_ok=False)
    identity = read_contract(config["contract"])
    plan = {"candidates": CANDIDATES, "common": COMMON, "identity": identity,
            "manifestSha256": config["manifestSha256"], "status": "started",
            "startedAt": datetime.now(timezone.utc).isoformat(), "testPixelsOpened": False}
    plan["configSha256"] = digest_json(plan)
    ledger = output / "ledger.local.json"
    atomic_json(ledger, plan)
    try:
        torch.set_num_threads(2)
        guard = SourceGuard(config["manifest"], config["manifestSha256"])
        splits = {}
        for split in ("train", "validation"):
            tensors, labels, ids = [], [], []
            for row in guard.entries.values():
                if not row["included"] or row["split"] != split:
                    continue
                guard.check(row["id"], row["sha256"])
                path = (guard.root / row["relative_path"]).resolve()
                if not path.is_relative_to(guard.root):
                    raise ValueError("source_path_invalid")
                raw = path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != row["sha256"]:
                    raise ValueError("source_hash_mismatch")
                tensors.append(decode_image(raw)); labels.append(row["grade"] - 1); ids.append(row["id"])
            splits[split] = (torch.stack(tensors), torch.tensor(labels), ids)
        all_reports = []
        for number, candidate in enumerate(CANDIDATES):
            torch.manual_seed(42); np.random.seed(42)
            plan["candidateStarted"] = number + 1
            atomic_json(ledger, plan)
            started = time.monotonic()
            predictor, actual_identity = load_verified_predictor(config["checkpoint"], config["contract"])
            if actual_identity != identity:
                raise ValueError("Initial identity changed during candidate unit")
            model = predictor.model
            for p in model.parameters():
                p.requires_grad_(False)
            for block in list(model.features.children())[-candidate["blocks"]:]:
                for p in block.parameters():
                    p.requires_grad_(True)
            head = torch.nn.Linear(576, 5)
            with torch.no_grad():
                head.weight.copy_(predictor.coef); head.bias.copy_(predictor.intercept)
            optimizer = torch.optim.AdamW([
                {"params": [p for p in model.parameters() if p.requires_grad], "lr": COMMON["backboneLr"]},
                {"params": head.parameters(), "lr": COMMON["headLr"]},
            ], weight_decay=COMMON["weightDecay"])
            train_x, train_y, _ = splits["train"]
            val_x, val_y, val_ids = splits["validation"]
            frequencies = torch.bincount(train_y, minlength=5).float()
            weights = (frequencies.sum() / (5 * frequencies)) ** candidate["weightExponent"]
            criterion = torch.nn.CrossEntropyLoss(weight=weights, label_smoothing=COMMON["labelSmoothing"])
            trials, best, selected = [], None, None
            for epoch in range(1, 5):
                model.eval(); head.train()
                for indices in torch.randperm(len(train_y)).split(16):
                    batch = train_x[indices]
                    if bool(torch.rand(()) < 0.5):
                        batch = batch.flip(-1)
                    optimizer.zero_grad(set_to_none=True)
                    criterion(head(model(batch)), train_y[indices]).backward()
                    optimizer.step()
                model.eval(); head.eval()
                with torch.inference_mode():
                    predicted = torch.cat([head(model(b)).argmax(1) for b in val_x.split(16)]).numpy() + 1
                result = {"epoch": epoch, **metrics(val_y.numpy() + 1, predicted)}
                with (output / "observations.local.jsonl").open("a") as stream:
                    stream.write(json.dumps({"candidate": candidate["name"], **result}) + "\n")
                    stream.flush(); os.fsync(stream.fileno())
                trials.append(result)
                score = (result["macro_f1"], result["accuracy"])
                if best is None or score > best:
                    best, selected = score, result
                    artifact = {"backbone": {k: v.detach().clone() for k, v in model.state_dict().items()},
                                "coef": head.weight.detach().clone(), "intercept": head.bias.detach().clone(),
                                "model_version": "mobilenetv3small-v3-" + candidate["name"] + "-" + plan["configSha256"][:10],
                                "preprocessing_version": PREPROCESSING_VERSION}
                    predictions = [{"id": i, "actual": int(y) + 1, "grade": int(p)}
                                   for i, y, p in zip(val_ids, val_y, predicted)]
                print(json.dumps({"candidate": candidate["name"], **result}), flush=True)
            dest = output / candidate["name"]; dest.mkdir()
            torch.save(artifact, dest / "model.pt")
            report = {"config": {**COMMON, **candidate}, "trials": trials, "selected": selected,
                      "initialIdentity": identity,
                      "validation_results": predictions, "candidate_only": True,
                      "checkpoint_sha256": hashlib.sha256((dest / "model.pt").read_bytes()).hexdigest(),
                      "elapsedSeconds": time.monotonic() - started, "testEvaluated": False}
            (dest / "report.local.json").write_text(json.dumps(report, indent=2))
            all_reports.append({k: v for k, v in report.items() if k != "validation_results"})
        plan.update(status="completed", candidatesCompleted=2, reports=all_reports)
    except BaseException as exc:
        plan.update(status="failed", errorType=type(exc).__name__)
        raise
    finally:
        plan["initialCheckpointUnchanged"] = (hashlib.sha256(Path(config["checkpoint"]).read_bytes()).hexdigest()
                                               == identity["checkpoint_sha256"])
        observations = output / "observations.local.jsonl"
        plan["validationObservations"] = len(observations.read_text().splitlines()) if observations.exists() else 0
        atomic_json(ledger, plan)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(json.loads(Path(args.config).read_text()), args.output)
