"""Serving-only identity contract. No dataset manifest or evaluation is needed."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

DEFAULT_CONTRACT = Path(__file__).with_name("model-contract.json")


def read_contract(path=DEFAULT_CONTRACT):
    contract = json.loads(Path(path).read_text())
    for key in ("model_version", "preprocessing_version", "checkpoint_sha256"):
        if not isinstance(contract.get(key), str) or not contract[key]:
            raise ValueError(f"Missing serving contract field: {key}")
    checksum = contract["checkpoint_sha256"]
    if len(checksum) != 64 or any(char not in "0123456789abcdef" for char in checksum):
        raise ValueError("Invalid checkpoint SHA-256")
    return {key: contract[key] for key in ("model_version", "preprocessing_version", "checkpoint_sha256")}


def load_verified_predictor(checkpoint, contract_path=DEFAULT_CONTRACT):
    from ml.runtime import Predictor

    contract = read_contract(contract_path)
    checksum = hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest()
    if checksum != contract["checkpoint_sha256"]:
        raise ValueError("Checkpoint hash does not match frozen serving contract")
    predictor = Predictor(checkpoint)
    from ml.runtime import PREPROCESSING_VERSION
    if predictor.model_version != contract["model_version"] or PREPROCESSING_VERSION != contract["preprocessing_version"]:
        raise ValueError("Model/preprocessing version does not match frozen serving contract")
    return predictor, contract


def check_health(health, contract):
    if health.get("ready") is not True:
        raise ValueError("Model is not ready")
    for key, value in contract.items():
        if health.get(key) != value:
            raise ValueError(f"Health identity mismatch: {key}")
