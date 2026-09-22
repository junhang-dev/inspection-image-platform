"""Pixel-only inference; no filenames or labels enter the prediction path."""
from __future__ import annotations

import io
from pathlib import Path
import warnings
from typing import BinaryIO

import torch
from PIL import Image, ImageOps
from torchvision import models, transforms

PREPROCESSING_VERSION = "rgb-first-frame-exif-full-resize224-imagenet-v1"
Image.MAX_IMAGE_PIXELS = 40_000_000
TRANSFORM = transforms.Compose([
    transforms.Resize((224, 224), antialias=True),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


def decode_image(data: bytes | BinaryIO) -> torch.Tensor:
    # File inputs avoid duplicating the upload in RAM. Pillow seeks to frame zero;
    # the caller owns the file and closes it after decoding/inference completes.
    source = io.BytesIO(data) if isinstance(data, bytes) else data
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.format not in {"JPEG", "PNG", "MPO"}:
                    raise ValueError("unsupported_image_format")
                image.seek(0)
                return TRANSFORM(ImageOps.exif_transpose(image).convert("RGB"))
    except OSError as exc:
        # Pillow's format/truncation errors have no errno. A real file-device
        # failure must remain distinguishable from a malformed image.
        if exc.errno is not None:
            raise
        raise ValueError("invalid_image") from exc
    except (Image.DecompressionBombError,
            Image.DecompressionBombWarning) as exc:
        raise ValueError("invalid_image") from exc


def backbone(pretrained: bool = False) -> torch.nn.Module:
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
    model = models.mobilenet_v3_small(weights=weights)
    model.classifier = torch.nn.Identity()
    return model.eval()


class Predictor:
    def __init__(self, checkpoint: str | Path):
        torch.set_num_threads(2)
        artifact = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if artifact["preprocessing_version"] != PREPROCESSING_VERSION:
            raise ValueError("unsupported_preprocessing_version")
        self.model = backbone()
        self.model.load_state_dict(artifact["backbone"])
        self.coef = artifact["coef"]
        self.intercept = artifact["intercept"]
        if self.coef.shape != (5, 576) or self.intercept.shape != (5,):
            raise ValueError("invalid_classifier_shape")
        self.model_version = artifact["model_version"]

    @torch.inference_mode()
    def predict(self, data: bytes | BinaryIO) -> dict:
        x = decode_image(data).unsqueeze(0)
        features = self.model(x)
        probabilities = torch.softmax(features @ self.coef.T + self.intercept, dim=1)[0]
        index = int(probabilities.argmax())
        return {"grade": index + 1, "confidence": float(probabilities[index]),
                "model_version": self.model_version,
                "preprocessing_version": PREPROCESSING_VERSION}
