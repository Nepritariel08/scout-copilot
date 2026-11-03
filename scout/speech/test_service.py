"""Deterministic stdlib contracts: no model packages, credentials, audio capture or downloads."""
import hashlib
import http.client
import json
import multiprocessing
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import HTTPServer
from pathlib import Path
from types import SimpleNamespace

import service


def fake_job(kind, payload, root):
    if payload in (b"slow", "slow"):
        time.sleep(3)
    if payload == b"crash":
        raise ValueError("SYNTHETIC_SECRET_MUST_NOT_ESCAPE")
    return b'{"text":"synthetic transcript"}' if kind == "stt" else b"synthetic-wav"


def partial_ipc_worker(connection, kind, payload, root, target, temporary_directory=None):
    # A real child sends a valid header and a partial body, then never completes its IPC frame.
    connection.sendall(struct.pack("!I", 1000) + b"1partial")
    time.sleep(30)


def temporary_job(kind, payload, root):
    import os
    path = Path(tempfile.gettempdir())
    if path != Path(os.environ["TMPDIR"]):
        raise ValueError("private temporary root missing")
    (path / "synthetic-phonemes").write_text("synthetic", encoding="utf-8")
    if payload == b"slow":
        time.sleep(30)
    return b"synthetic"


def multipart(parts):
    boundary = "scout-fixture-boundary"
    raw = b""
    for name, content, mime in parts:
        raw += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + content + b"\r\n"
    return f"multipart/form-data; boundary={boundary}", raw + f"--{boundary}--\r\n".encode()


class Contracts(unittest.TestCase):
    def test_fixed_speech_profile_and_no_arbitrary_fields(self):
        value = {"input": "Synthetic answer", "model": service.TTS_MODEL, "voice": service.VOICE, "response_format": "wav"}
        self.assertEqual(service.speech_payload(json.dumps(value).encode()), "Synthetic answer")
        for mutation in ({"voice": "clone"}, {"model": "other"}, {"url": "https://external.invalid"}, {"input": "x" * 2001}, {"input": " "}):
            with self.assertRaises(service.SpeechError):
                service.speech_payload(json.dumps(value | mutation).encode())

    def test_multipart_exact_model_format_size_and_duplicates(self):
        parts = [("file", b"synthetic-audio", "audio/webm"), ("model", service.STT_MODEL.encode(), "text/plain")]
        self.assertEqual(service.transcript_payload(*multipart(parts)), b"synthetic-audio")
        for invalid in (parts + [parts[0]], [("file", b"x", "image/jpeg"), parts[1]], [parts[0], ("model", b"other", "text/plain")], [parts[1]], [("file", b"x" * (service.MAX_UPLOAD + 1), "audio/wav"), parts[1]]):
            with self.assertRaises(service.SpeechError):
                service.transcript_payload(*multipart(invalid))

    def test_actual_decoded_duration_is_bounded(self):
        frame = SimpleNamespace(samples=16000, sample_rate=16000, to_ndarray=lambda: SimpleNamespace(tobytes=lambda: b"\0\0" * 16000))
        resample = lambda value: [] if value is None else [value]
        self.assertEqual(len(service.bounded_pcm([frame] * 30, resample)), 960000)
        with self.assertRaises(service.SpeechError):
            service.bounded_pcm([frame] * 31, resample)
        with self.assertRaises(service.SpeechError):
            service.bounded_pcm([], resample)

    def test_exact_model_inventory_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "model.bin"
            path.write_bytes(b"synthetic-model")
            manifest = {"files": {"model.bin": hashlib.sha256(path.read_bytes()).hexdigest()}}
            service.verify_models(root, manifest)
            path.write_bytes(b"modified")
            with self.assertRaises(service.SpeechError):
                service.verify_models(root, manifest)

    def test_native_worker_success_error_and_timeout_reap(self):
        runner = service.JobRunner("synthetic-root", timeout=5, target=fake_job)
        self.assertIn(b"synthetic transcript", runner.run("stt", b"ok"))
        with self.assertRaisesRegex(service.SpeechError, "SPEECH_UNAVAILABLE"):
            runner.run("stt", b"crash")
        runner.timeout = 0.1
        with self.assertRaisesRegex(service.SpeechError, "SPEECH_TIMEOUT"):
            runner.run("stt", b"slow")
        self.assertFalse(multiprocessing.active_children())
        self.assertTrue(runner.slot.acquire(blocking=False))
        runner.slot.release()

    def test_native_slot_stays_owned_until_process_is_reaped(self):
        runner = service.JobRunner("synthetic-root", timeout=0.5, target=fake_job)
        errors = []
        def first():
            try:
                runner.run("stt", b"slow")
            except service.SpeechError as error:
                errors.append(str(error))
        thread = threading.Thread(target=first)
        thread.start()
        deadline = time.monotonic() + 2
        while not runner.slot.locked() and time.monotonic() < deadline:
            time.sleep(0.005)
        with self.assertRaisesRegex(service.SpeechError, "SPEECH_BUSY"):
            runner.run("stt", b"ok")
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ["SPEECH_TIMEOUT"])
        self.assertFalse(multiprocessing.active_children())

    def test_partial_ipc_frame_has_one_absolute_deadline_and_reaps_child_reader(self):
        runner = service.JobRunner("synthetic-root", timeout=2, target=fake_job, worker_target=partial_ipc_worker)
        started = time.monotonic()
        with self.assertRaisesRegex(service.SpeechError, "SPEECH_TIMEOUT"):
            runner.run("stt", b"synthetic")
        self.assertLess(time.monotonic() - started, 6)
        self.assertFalse(multiprocessing.active_children())
        self.assertFalse(runner.slot.locked())
        self.assertFalse(runner.poisoned)

    def test_unreapable_worker_poison_retains_slot_and_refuses_new_jobs(self):
        # Simulate OS inability to reap; no real PID is signalled or left running.
        joins = []
        process = SimpleNamespace(pid=0, start=lambda: None, is_alive=lambda: True,
                                  terminate=lambda: None, kill=lambda: None,
                                  join=lambda timeout: joins.append(timeout))
        context = SimpleNamespace(Process=lambda **kwargs: process)
        runner = service.JobRunner("synthetic", timeout=0.01, target=fake_job)
        with patch("service.multiprocessing.get_context", return_value=context):
            with self.assertRaises(service.SpeechError):
                runner.run("stt", b"synthetic")
        self.assertTrue(runner.poisoned)
        self.assertTrue(runner.slot.locked())
        self.assertTrue(all(timeout is not None and timeout >= 0 for timeout in joins))
        with self.assertRaisesRegex(service.SpeechError, "SPEECH_UNAVAILABLE"):
            runner.run("stt", b"synthetic")
        runner.quarantined[1].close()

    def test_private_job_temporary_files_clean_only_after_native_exit_or_reap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            runner = service.JobRunner("synthetic", timeout=5, target=temporary_job, temporary_root=root)
            self.assertEqual(runner.run("tts", b"ok"), b"synthetic")
            self.assertEqual(list(root.iterdir()), [])
            runner.timeout = 1
            with self.assertRaises(service.SpeechError):
                runner.run("tts", b"slow")
            self.assertEqual(list(root.iterdir()), [])
            self.assertFalse(multiprocessing.active_children())

    def test_loopback_http_auth_no_cors_and_fixed_request(self):
        token = "synthetic-test-token-" + "x" * 32
        seen = []
        runner = SimpleNamespace(run=lambda kind, payload: seen.append((kind, payload)) or b"synthetic-wav")
        server = HTTPServer(("127.0.0.1", 0), service.handler_for(token, runner))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            client = http.client.HTTPConnection(*server.server_address, timeout=2)
            client.request("POST", "/v1/audio/speech", b"{}")
            response = client.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
            self.assertFalse(seen)
            value = {"input": "Synthetic answer", "model": service.TTS_MODEL, "voice": service.VOICE, "response_format": "wav"}
            client.request("POST", "/v1/audio/speech", json.dumps(value), {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
            self.assertEqual(response.read(), b"synthetic-wav")
            self.assertEqual(seen, [("tts", "Synthetic answer")])
            client.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_http_disconnect_does_not_release_native_worker(self):
        token = "synthetic-test-token-" + "x" * 32
        runner = service.JobRunner("synthetic-root", timeout=1, target=fake_job)
        server = HTTPServer(("127.0.0.1", 0), service.handler_for(token, runner))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            value = {"input": "slow", "model": service.TTS_MODEL, "voice": service.VOICE, "response_format": "wav"}
            # The fake TTS payload waits; no native libraries or real speech are used.
            client = http.client.HTTPConnection(*server.server_address, timeout=2)
            client.request("POST", "/v1/audio/speech", json.dumps(value), {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            deadline = time.monotonic() + 2
            while not runner.slot.locked() and time.monotonic() < deadline:
                time.sleep(0.005)
            client.close()
            self.assertTrue(runner.slot.locked())
            with self.assertRaisesRegex(service.SpeechError, "SPEECH_BUSY"):
                runner.run("stt", b"ok")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)
        self.assertFalse(runner.slot.locked())
        self.assertFalse(multiprocessing.active_children())


if __name__ == "__main__":
    unittest.main()
