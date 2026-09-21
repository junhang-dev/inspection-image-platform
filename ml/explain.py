"""Real expected-gradients SHAP, isolated from the serving inference-mode path."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

import numpy as np
import torch

from ml.roi import decode_roi, tensor_sha
from ml.train import validate_manifest


def digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


class SourceGuard:
    def __init__(self, manifest_path, expected_sha):
        raw = Path(manifest_path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_sha:
            raise ValueError("protection_manifest_mismatch")
        manifest = json.loads(raw)
        validate_manifest(manifest)
        included = [r for r in manifest["entries"] if r["included"]]
        if len({r["sha256"] for r in included}) != len(included):
            raise ValueError("duplicate_manifest_hash")
        self.root = Path(manifest["source_root"]).resolve()
        self.entries = {row["id"]: row for row in manifest["entries"]}
        self.test_ids = {r["id"] for r in manifest["entries"] if r["split"] == "test"}
        self.test_hashes = {r["sha256"] for r in manifest["entries"] if r["split"] == "test"}

    def check(self, source_id, checksum):
        if source_id in self.test_ids or checksum in self.test_hashes:
            raise ValueError("protected_source")
        row = self.entries.get(source_id)
        if row is not None and row["sha256"] != checksum:
            raise ValueError("source_hash_mismatch")
        # New product uploads have no dataset source ID. Their DB binding is
        # product-owned; the actual-byte test deny-list still applies here.

    def train_bytes(self, source_id):
        row = self.entries.get(source_id)
        if row is None or not row["included"] or row["split"] != "train":
            raise ValueError("background_must_be_train")
        self.check(source_id, row["sha256"])
        path = (self.root / row["relative_path"]).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("source_path_invalid")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ValueError("source_hash_mismatch")
        return raw, row["sha256"]


class Logits(torch.nn.Module):
    def __init__(self, predictor):
        super().__init__()
        self.backbone = predictor.model
        self.register_buffer("coef", predictor.coef)
        self.register_buffer("intercept", predictor.intercept)

    def forward(self, x):
        return self.backbone(x) @ self.coef.T + self.intercept


class TargetLogit(torch.nn.Module):
    def __init__(self, model, index):
        super().__init__()
        self.model, self.index = model, index

    def forward(self, x):
        return self.model(x)[:, self.index:self.index + 1]


def background_tensors(guard, ids, roi):
    if not isinstance(ids, list) or not 1 <= len(ids) <= 16 or len(set(ids)) != len(ids):
        raise ValueError("invalid_background")
    tensors, rows = [], []
    for source_id in ids:
        raw, checksum = guard.train_bytes(source_id)
        tensor, geometry = decode_roi(raw, roi)
        tensors.append(tensor)
        rows.append({"sourceId": source_id, "originalSha256": checksum, "split": "train",
                     **geometry})
    policy = {"policy": "same-normalized-roi-on-fixed-train-background-v1", "items": rows}
    return torch.stack(tensors), {"backgroundId": digest_json(policy), **policy}


def gradient_shap(model, x, background, target_grade, nsamples=64, seed=42):
    import shap

    if type(target_grade) is not int or not 1 <= target_grade <= 5:
        raise ValueError("invalid_target_grade")
    if type(nsamples) is not int or not 1 <= nsamples <= 256:
        raise ValueError("invalid_sample_budget")
    started = time.monotonic()
    target = TargetLogit(model.eval(), target_grade - 1).eval()
    with torch.no_grad():
        base = float(target(background).mean())
        output = float(target(x)[0, 0])
    explainer = shap.GradientExplainer(target, background, batch_size=8, local_smoothing=0)
    values = explainer.shap_values(x, nsamples=nsamples, rseed=seed)
    values = np.asarray(values)
    if values.shape == (*x.shape, 1):
        values = values[..., 0]
    if values.shape != tuple(x.shape) or not np.isfinite(values).all():
        raise ValueError("invalid_attribution")
    heatmap = values[0].sum(axis=0)
    total = float(heatmap.sum())
    residual = output - base - total
    tolerance = max(0.1, 0.25 * abs(output - base))
    return {"method": "shap.GradientExplainer", "approximation": "expected_gradients",
            "shapVersion": shap.__version__, "targetGrade": target_grade, "outputSpace": "logit",
            "baseValue": base, "outputValue": output, "attributionSum": total,
            "additivityResidual": residual, "residualTolerance": tolerance,
            "qualityStatus": "passed" if abs(residual) <= tolerance else "residual_high",
            "map": heatmap.tolist(), "mapShape": list(heatmap.shape),
            "mapScale": float(np.max(np.abs(heatmap))), "mapAggregation": "signed-channel-sum",
            "nsamples": nsamples, "seed": seed, "batchSize": 8,
            "elapsedMs": round((time.monotonic() - started) * 1000),
            "inputTensorSha256": tensor_sha(x[0])}
