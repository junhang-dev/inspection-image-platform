"""Streaming transport checks; approved demo only, no training/evaluation data."""
import asyncio
import errno
import hashlib
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import ClientDisconnect, Request
import torch

from ml.runtime import decode_image
from ml.service import predict

DEMO = Path(__file__).parents[1] / "image/demo/demo-01.jpg"
HEADER = (b'--upload\r\nContent-Disposition: form-data; name="image"; '
          b'filename="transport.jpg"\r\nContent-Type: image/jpeg\r\n\r\n')
END = b"\r\n--upload--\r\n"


def request_for(chunks, *, interruption=None):
    iterator = iter(chunks)

    async def receive():
        try:
            return {"type": "http.request", "body": next(iterator), "more_body": True}
        except StopIteration:
            if interruption:
                raise interruption
            return {"type": "http.request", "body": b"", "more_body": False}

    return Request({"type": "http", "method": "POST", "path": "/predict",
                    "headers": [(b"content-type", b"multipart/form-data; boundary=upload")]}, receive)


class StreamingUploadTests(unittest.TestCase):
    def setUp(self):
        self.files = []
        original = tempfile.SpooledTemporaryFile

        def tracked(*args, **kwargs):
            file = original(*args, **kwargs)
            self.files.append(file)
            return file

        self.spool_patch = patch("starlette.formparsers.SpooledTemporaryFile", tracked)
        self.spool_patch.start()
        self.addCleanup(self.spool_patch.stop)
        self.model_patch = patch("ml.service.predictor", object())
        self.model_patch.start()
        self.addCleanup(self.model_patch.stop)

    def assert_closed(self):
        self.assertTrue(self.files)
        self.assertTrue(all(file.closed for file in self.files))

    def test_above_20mib_spools_preserves_bytes_and_decoded_pixels(self):
        data = DEMO.read_bytes()
        original_sha = hashlib.sha256(data).hexdigest()
        padding = b"\0" * (64 * 1024)
        expected = hashlib.sha256(data)
        for _ in range(400):
            expected.update(padding)

        def chunks():
            yield HEADER
            yield data
            for _ in range(400):
                yield padding
            yield END

        def inspect(file):
            self.assertTrue(file._rolled)
            self.assertEqual(hashlib.file_digest(file, "sha256").hexdigest(), expected.hexdigest())
            file.seek(0)
            self.assertTrue(torch.equal(decode_image(data), decode_image(file)))
            return {"transport": "verified"}

        with patch("ml.service.infer", side_effect=inspect):
            self.assertEqual(asyncio.run(predict(request_for(chunks()))), {"transport": "verified"})
        self.assert_closed()
        self.assertEqual(hashlib.sha256(DEMO.read_bytes()).hexdigest(), original_sha)

    def test_bytes_and_file_decoder_match_all_approved_demo(self):
        for demo in sorted(DEMO.parent.glob("demo-*")):
            with demo.open("rb") as file:
                self.assertTrue(torch.equal(decode_image(demo.read_bytes()), decode_image(file)))

    def test_invalid_decode_and_inference_failure_close_files(self):
        for error, status in [(ValueError("invalid_image"), 422), (RuntimeError("injected"), 500)]:
            with patch("ml.service.infer", side_effect=error):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(predict(request_for([HEADER, b"bad", END])))
            self.assertEqual(caught.exception.status_code, status)
            self.assert_closed()

    def test_incomplete_body_closes_partial_file_without_inference(self):
        with patch("ml.service.infer") as infer:
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(predict(request_for([HEADER, b"x" * (2 * 1024 * 1024)])))
            self.assertEqual(caught.exception.status_code, 400)
            self.assertEqual(caught.exception.detail, "incomplete_multipart")
            infer.assert_not_called()
        self.assert_closed()

    def test_disconnect_and_cancellation_close_partial_file(self):
        for error in [ClientDisconnect(), asyncio.CancelledError()]:
            with self.assertRaises(type(error)):
                asyncio.run(predict(request_for([HEADER, b"x" * (2 * 1024 * 1024)], interruption=error)))
            self.assert_closed()

    def test_disk_full_is_retryable_and_closes_file(self):
        with patch("tempfile.TemporaryFile", side_effect=OSError(errno.ENOSPC, "injected disk full")):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(predict(request_for([HEADER, b"x" * (2 * 1024 * 1024), END])))
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (503, "upload_storage_unavailable"))
        self.assert_closed()

    def test_disk_read_error_is_not_invalid_image(self):
        class BrokenDisk(io.BytesIO):
            def read(self, *args):
                raise OSError(errno.EIO, "injected read failure")

        with self.assertRaises(OSError):
            decode_image(BrokenDisk(b"image"))
        with patch("ml.service.infer", side_effect=OSError(errno.EIO, "injected read failure")):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(predict(request_for([HEADER, b"image", END])))
        self.assertEqual((caught.exception.status_code, caught.exception.detail),
                         (503, "upload_storage_unavailable"))
        self.assert_closed()

    def test_cancel_during_inference_waits_before_closing_file(self):
        entered, release = threading.Event(), threading.Event()
        observed = []

        def worker(file):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test release timeout")
            observed.append(file.read())
            return {}

        async def exercise():
            task = asyncio.create_task(predict(request_for([HEADER, b"image", END])))
            try:
                for _ in range(500):
                    if entered.is_set():
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(entered.is_set())
                task.cancel()
                await asyncio.sleep(.02)
                task.cancel()  # Repeated cancellation must not bypass the wait.
                await asyncio.sleep(.02)
                self.assertFalse(task.done())
                self.assertFalse(self.files[0].closed)
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

        with patch("ml.service.infer", side_effect=worker):
            asyncio.run(exercise())
        self.assertEqual(observed, [b"image"])
        self.assert_closed()

    def test_cancel_during_disk_write_waits_before_closing_file(self):
        entered, release = threading.Event(), threading.Event()
        observed = []
        original_write = tempfile.SpooledTemporaryFile.write

        def slow_write(file, data):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test release timeout")
            observed.append(file.closed)
            return original_write(file, data)

        async def exercise():
            task = asyncio.create_task(predict(request_for([HEADER, b"x" * (2 * 1024 * 1024), END])))
            try:
                for _ in range(500):
                    if entered.is_set():
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(entered.is_set())
                task.cancel()
                await asyncio.sleep(.02)
                self.assertFalse(task.done())
                self.assertFalse(self.files[0].closed)
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

        with patch.object(tempfile.SpooledTemporaryFile, "write", slow_write):
            asyncio.run(exercise())
        self.assertEqual(observed, [False])
        self.assert_closed()

    def test_extra_file_and_oversized_headers_are_rejected(self):
        second = HEADER.replace(b"--upload", b"\r\n--upload")
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(predict(request_for([HEADER, b"data", second, b"data", END])))
        self.assertEqual(caught.exception.status_code, 400)
        self.assert_closed()
        huge = HEADER.replace(b"transport.jpg", b"x" * (17 * 1024))
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(predict(request_for([huge, b"data", END])))
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
