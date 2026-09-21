"""One bounded private computation. Paths are supplied by the local API, not clients."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import resource
import sys
import time

import torch

from ml.contract import load_verified_predictor
from ml.explain import SourceGuard, Logits, background_tensors, digest_json, gradient_shap
from ml.roi import decode_roi, ROI_POLICY


def compute(config, metadata, image_path, operation):
    started = time.monotonic()
    torch.set_num_threads(2)
    guard = SourceGuard(config["manifest"], config["manifestSha256"])
    with open(image_path, "rb") as handle:
        checksum = hashlib.file_digest(handle, "sha256").hexdigest()
        guard.check(metadata["sourceId"], checksum)
        if metadata["originalSha256"] != checksum:
            raise ValueError("source_hash_mismatch")
        predictor, identity = load_verified_predictor(config["checkpoint"], config["contract"])
        if metadata["expectedModel"] != identity:
            raise ValueError("contract_mismatch")
        if metadata["roiPolicyVersion"] != ROI_POLICY:
            raise ValueError("invalid_roi_policy")
        handle.seek(0)
        x, geometry = decode_roi(handle, metadata.get("roi"))
    logits_model = Logits(predictor).eval()
    x = x.unsqueeze(0)
    with torch.no_grad():
        logits = logits_model(x)
        probs = torch.softmax(logits, dim=1)[0]
        grade = int(probs.argmax()) + 1
    result = {"schemaVersion": "roi-shap-v1", "sourceId": metadata["sourceId"],
              "originalSha256": checksum, "roiId": metadata.get("roiId"), **geometry,
              **identity, "grade": grade, "confidence": float(probs[grade - 1]),
              "createdAt": datetime.now(timezone.utc).isoformat()}
    if operation == "explain":
        target = metadata.get("targetGrade") or grade
        bg, provenance = background_tensors(guard, config["backgroundSourceIds"], metadata.get("roi"))
        nsamples = config.get("explanationNsamples", 64)
        explanation = gradient_shap(logits_model, x, bg, target, nsamples=nsamples)
        # Individual background identities remain local. Only its content hash
        # and policy/count cross the private product API boundary.
        explanation.update({"backgroundId": provenance["backgroundId"],
                            "backgroundPolicy": provenance["policy"],
                            "backgroundCount": len(provenance["items"])})
        result["explanation"] = explanation
        result["cacheable"] = explanation["qualityStatus"] == "passed"
        result["cacheKey"] = digest_json({
            "sourceId": metadata["sourceId"], "roiId": metadata.get("roiId"),
            "source": checksum, "bbox": geometry["bbox"], "identity": identity,
            "roiPolicy": ROI_POLICY, "backgroundId": provenance["backgroundId"],
            "targetGrade": target, "outputSpace": "logit", "method": explanation["method"],
            "shapVersion": explanation["shapVersion"], "nsamples": nsamples, "seed": 42,
        })
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    result["peakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return result


if __name__ == "__main__":
    request = json.loads(Path(sys.argv[1]).read_text())
    try:
        result = compute(**request)
    except ValueError as exc:
        result = {"error": str(exc)}
    except ImportError:
        result = {"error": "dependency_unavailable"}
    except Exception:
        result = {"error": "computation_failed"}
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
