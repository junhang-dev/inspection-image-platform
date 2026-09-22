"""Private local model service. Expose through the application backend only."""
from contextlib import asynccontextmanager
import asyncio
import logging
import os
from pathlib import Path
import threading

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from python_multipart.exceptions import MultipartParseError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from ml.runtime import PREPROCESSING_VERSION, Predictor
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


app = FastAPI(title="Local corrosion-grade inference", lifespan=lifespan)


async def finish_io_before_cancel(awaitable):
    """A cancelled request must not close a file still used by a worker."""
    task = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()  # Retrieve a worker failure; preserve request cancellation.
        raise


class SafeUploadFile(UploadFile):
    async def write(self, data):
        await finish_io_before_cancel(super().write(data))

    async def seek(self, offset):
        await finish_io_before_cancel(super().seek(offset))


class ImageUploadParser(MultiPartParser):
    """One streamed image, bounded metadata, and explicit end-of-body checks.

    python-multipart.finalize() does not reject truncated bodies. Keep all
    temporary files owned until the request ends, including unfinished parts.
    This uses the pinned Starlette parser's cleanup list; regression tests guard it.
    """
    complete = False

    def on_headers_finished(self):
        super().on_headers_finished()
        file = self._current_part.file
        if file is not None:
            self._current_part.file = SafeUploadFile(
                file.file, size=file.size, filename=file.filename, headers=file.headers)

    def on_part_begin(self):
        super().on_part_begin()
        self.header_bytes = 0

    def check_header_size(self, size):
        self.header_bytes += size
        if self.header_bytes > 16 * 1024:
            raise MultiPartException("Multipart headers too large")

    def on_header_field(self, data, start, end):
        self.check_header_size(end - start)
        super().on_header_field(data, start, end)

    def on_header_value(self, data, start, end):
        self.check_header_size(end - start)
        super().on_header_value(data, start, end)

    def on_end(self):
        self.complete = True

    def close(self):
        for file in self._files_to_close_on_error:
            file.close()


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


@app.post("/predict", response_model=Prediction, openapi_extra={
    "requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
        "type": "object", "required": ["image"],
        "properties": {"image": {"type": "string", "format": "binary"}},
    }}}},
})
async def predict(request: Request):
    if predictor is None:
        raise HTTPException(503, "model_unavailable")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise HTTPException(422, "image_required")
    parser = ImageUploadParser(request.headers, request.stream(), max_files=1, max_fields=0)
    try:
        # Starlette streams file parts into a 1 MiB spool, then temporary disk
        # storage. Do not call request.body() or image.read(): neither is needed.
        # This endpoint accepts one image per inference; product batch size is
        # independent. All paths close even incomplete parts in the finally block.
        form = await parser.parse()
        if not parser.complete:
            raise HTTPException(400, "incomplete_multipart")
        image = form.get("image")
        if not isinstance(image, UploadFile):
            raise HTTPException(422, "image_required")
        try:
            return await finish_io_before_cancel(run_in_threadpool(infer, image.file))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OSError:
            raise
        except Exception as exc:
            logging.exception("Inference failed")
            raise HTTPException(500, "inference_failed") from exc
    except (MultipartParseError, MultiPartException) as exc:
        raise HTTPException(400, "invalid_multipart") from exc
    except OSError as exc:
        logging.exception("Upload temporary storage unavailable")
        raise HTTPException(503, "upload_storage_unavailable") from exc
    finally:
        parser.close()
