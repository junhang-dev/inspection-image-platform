"""Private local model service. Expose through the application backend only."""
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import threading

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from ml.runtime import MAX_BYTES, PREPROCESSING_VERSION, Predictor
from ml.contract import load_verified_predictor

predictor = None
serving_identity = None
prediction_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    global predictor, serving_identity
    predictor, serving_identity = None, None
    try:
        checkpoint = os.environ.get("MODEL_PATH", str(Path(__file__).parent / "artifacts/model.pt"))
        contract_path = os.environ.get("MODEL_CONTRACT_FILE")
        if contract_path:
            predictor, serving_identity = load_verified_predictor(checkpoint, contract_path)
        elif os.environ.get("MODEL_REQUIRE_CONTRACT") == "1":
            raise ValueError("Serving contract is required")
        else:
            predictor = Predictor(checkpoint)
    except Exception:
        logging.exception("Model unavailable; predictions will return 503")
        if os.environ.get("MODEL_REQUIRE_CONTRACT") == "1":
            raise
    yield
    predictor, serving_identity = None, None


class BodyLimit:
    """Bound the raw request before multipart parsing can spool files to disk."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        limit = MAX_BYTES + 1024 * 1024  # Bounded multipart headers/metadata overhead.
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            size += len(body)
            if size > limit:
                return await JSONResponse({"detail": "request_too_large"}, status_code=413)(scope, receive, send)
            chunks.append(body)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


app = FastAPI(title="Local corrosion-grade inference", lifespan=lifespan)
app.add_middleware(BodyLimit)


class Prediction(BaseModel):
    grade: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0, le=1)
    model_version: str
    preprocessing_version: str


@app.get("/health")
def health():
    return {"ready": predictor is not None,
            "model_version": predictor.model_version if predictor else None,
            "preprocessing_version": PREPROCESSING_VERSION if predictor else None,
            "checkpoint_sha256": serving_identity["checkpoint_sha256"] if serving_identity else None}


def infer(data):
    with prediction_lock:
        return predictor.predict(data)


@app.post("/predict", response_model=Prediction)
async def predict(image: UploadFile = File(...)):
    if predictor is None:
        raise HTTPException(503, "model_unavailable")
    try:
        data = await image.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "image_too_large")
        return await run_in_threadpool(infer, data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logging.exception("Inference failed")
        raise HTTPException(500, "inference_failed") from exc
    finally:
        await image.close()
