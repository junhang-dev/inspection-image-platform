"""Opt-in loopback candidate API. Serving port 8001 is never changed here."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from python_multipart.exceptions import MultipartParseError

from ml.contract import read_contract
from ml.explain import SourceGuard
from ml.roi import ROI_POLICY, pixel_bbox
from ml.service import ImageUploadParser, finish_io_before_cancel


class Metadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceId: StrictStr = Field(min_length=1, max_length=200)
    originalSha256: StrictStr = Field(pattern=r"^[0-9a-f]{64}$")
    expectedModel: dict[str, str]
    roiPolicyVersion: StrictStr
    roiId: StrictStr | None = Field(default=None, max_length=200)
    roi: dict | None = None
    targetGrade: StrictInt | None = Field(default=None, ge=1, le=5)


ERROR_STATUS = {"protected_source": 403, "source_hash_mismatch": 422,
                "contract_mismatch": 409, "dependency_unavailable": 503,
                "computation_failed": 500, "invalid_attribution": 500}


async def subprocess_result(command, output, budget=60):
    """Timeout/cancellation kills and reaps exactly this computation child."""
    with output.open("wb") as stream:
        proc = await asyncio.create_subprocess_exec(*command, stdout=stream,
                                                     stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(proc.wait(), timeout=budget)
        except BaseException:
            if proc.returncode is None:
                proc.kill()
            await finish_io_before_cancel(proc.wait())
            raise
    if proc.returncode:
        raise HTTPException(500, "computation_failed")
    return json.loads(output.read_text())


async def receive_with_idle_limit(request):
    stream = request.stream().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(anext(stream), timeout=30)
        except StopAsyncIteration:
            return
        yield chunk


async def until_disconnect(request, computation):
    async def watch():
        while (await request.receive())["type"] != "http.disconnect":
            pass
    task = asyncio.create_task(computation)
    watcher = asyncio.create_task(watch())
    try:
        done, _ = await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            raise HTTPException(499, "client_disconnected")
        return await task
    finally:
        for pending in (task, watcher):
            if not pending.done():
                pending.cancel()
        # Shield cleanup from repeated request cancellation; subprocess_result
        # reaps the child before this function lets the spool directory close.
        await finish_io_before_cancel(asyncio.gather(task, watcher, return_exceptions=True))


def create_app(config):
    busy = False
    identity = read_contract(config["contract"])
    guard = SourceGuard(config["manifest"], config["manifestSha256"])
    # Validate background membership at startup without loading its pixels.
    ids = config["backgroundSourceIds"]
    if not isinstance(ids, list) or not 1 <= len(ids) <= 16 or len(set(ids)) != len(ids):
        raise ValueError("invalid_background")
    for source_id in ids:
        row = guard.entries.get(source_id)
        if row is None or not row["included"] or row["split"] != "train":
            raise ValueError("background_must_be_train")
    if hashlib.sha256(Path(config["checkpoint"]).read_bytes()).hexdigest() != identity["checkpoint_sha256"]:
        raise ValueError("contract_mismatch")
    app = FastAPI(title="Private ROI and SHAP candidate")

    @app.get("/health")
    def health():
        return {"ready": True, "schemaVersion": "roi-shap-v1", **identity,
                "roiPolicyVersion": ROI_POLICY, "computeBusy": busy}

    async def handle(request, operation):
        nonlocal busy
        if busy:
            raise HTTPException(429, "busy")
        busy = True
        parser = ImageUploadParser(request.headers, receive_with_idle_limit(request), max_files=1,
                                   max_fields=1, max_part_size=16384)
        try:
            if request.headers.get("content-type", "").split(";", 1)[0].lower() != "multipart/form-data":
                raise HTTPException(422, "invalid_multipart")
            form = await parser.parse()
            if not parser.complete:
                raise HTTPException(400, "incomplete_multipart")
            if set(form.keys()) != {"image", "metadata"} or len(form.multi_items()) != 2:
                raise HTTPException(422, "image_and_metadata_required")
            image, raw_metadata = form["image"], form["metadata"]
            if not isinstance(image, UploadFile) or not isinstance(raw_metadata, str):
                raise HTTPException(422, "image_and_metadata_required")
            metadata = Metadata.model_validate_json(raw_metadata).model_dump()
            if metadata["expectedModel"] != identity:
                raise HTTPException(409, "contract_mismatch")
            if metadata["roiPolicyVersion"] != ROI_POLICY:
                raise HTTPException(422, "invalid_roi_policy")
            pixel_bbox(metadata["roi"], 224, 224)
            guard.check(metadata["sourceId"], metadata["originalSha256"])
            with tempfile.TemporaryDirectory(prefix="roi-shap-") as directory:
                directory = Path(directory)
                source = directory / "image"

                def copy_and_hash():
                    image.file.seek(0)
                    with source.open("xb") as dest:
                        shutil.copyfileobj(image.file, dest, length=1024 * 1024)
                    with source.open("rb") as handle:
                        return hashlib.file_digest(handle, "sha256").hexdigest()

                checksum = await finish_io_before_cancel(run_in_threadpool(copy_and_hash))
                guard.check(metadata["sourceId"], checksum)
                if checksum != metadata["originalSha256"]:
                    raise HTTPException(422, "source_hash_mismatch")
                job = directory / "request.json"
                job.write_text(json.dumps({"config": config, "metadata": metadata,
                                           "image_path": str(source), "operation": operation}))
                result = await until_disconnect(request, subprocess_result(
                    [sys.executable, "-m", "ml.explain_worker", str(job)], directory / "result.json"))
                if "error" in result:
                    raise HTTPException(ERROR_STATUS.get(result["error"], 422), result["error"])
                return result
        except asyncio.TimeoutError as exc:
            raise HTTPException(504, "timeout") from exc
        except ValidationError as exc:
            raise HTTPException(422, "invalid_metadata") from exc
        except ValueError as exc:
            raise HTTPException(ERROR_STATUS.get(str(exc), 422), str(exc)) from exc
        except (MultiPartException, MultipartParseError) as exc:
            raise HTTPException(400, "invalid_multipart") from exc
        except OSError as exc:
            raise HTTPException(503, "temporary_storage_unavailable") from exc
        finally:
            parser.close()
            busy = False

    @app.post("/v1/roi/predict")
    async def predict(request: Request):
        return await handle(request, "predict")

    @app.post("/v1/explanations")
    async def explain(request: Request):
        return await handle(request, "explain")

    return app


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--port", type=int, default=8103)
    args = parser.parse_args()
    if args.port == 8001:
        parser.error("The existing serving port is protected")
    uvicorn.run(create_app(json.loads(Path(args.config).read_text())), host="127.0.0.1", port=args.port)
