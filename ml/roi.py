"""Versioned ROI geometry on the EXIF-oriented first frame; raw bytes stay intact."""
from __future__ import annotations

import hashlib
import io
import math
import warnings

from PIL import Image, ImageOps

from ml.runtime import TRANSFORM

ROI_POLICY = "exif-oriented-first-frame-normalized-v1"


def pixel_bbox(roi, width, height):
    if roi is None:
        return [0, 0, width, height]
    if not isinstance(roi, dict) or set(roi) != {"x", "y", "w", "h"}:
        raise ValueError("invalid_roi")
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in roi.values()):
        raise ValueError("invalid_roi")
    x, y, w, h = (roi[k] for k in ("x", "y", "w", "h"))
    if not (0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0
            and x + w <= 1 and y + h <= 1):
        raise ValueError("invalid_roi")
    box = [math.floor(x * width), math.floor(y * height),
           math.ceil((x + w) * width), math.ceil((y + h) * height)]
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("invalid_roi")
    return box


def tensor_sha(tensor):
    return hashlib.sha256(tensor.detach().cpu().contiguous().numpy().tobytes()).hexdigest()


def decode_roi(source, roi=None):
    source = io.BytesIO(source) if isinstance(source, bytes) else source
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as raw:
                if raw.format not in {"JPEG", "PNG", "MPO"}:
                    raise ValueError("unsupported_image_format")
                raw.seek(0)
                image = ImageOps.exif_transpose(raw).convert("RGB")
                box = pixel_bbox(roi, *image.size)
                tensor = TRANSFORM(image.crop(tuple(box)))
                return tensor, {"roi": roi, "roiPolicyVersion": ROI_POLICY,
                                "orientedWidth": image.width, "orientedHeight": image.height,
                                "bbox": box, "cropTensorSha256": tensor_sha(tensor)}
    except OSError as exc:
        if exc.errno is not None:
            raise
        raise ValueError("invalid_image") from exc
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("invalid_image") from exc
