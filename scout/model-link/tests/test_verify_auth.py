#!/usr/bin/env python3
"""Portable tests for the live auth probe and its process-bound proof."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "verify_auth.py"
SPEC = importlib.util.spec_from_file_location("verify_auth", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
verify_auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_auth)

API_KEY = "Synthetic-Test-Key-That-Is-Not-A-Real-Secret-32"


class AuthHandler(BaseHTTPRequestHandler):
    accept_all = False
    result_model = verify_auth.MODEL_ID

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        auth = self.headers.get("Authorization")
        if not self.accept_all and auth != f"Bearer {API_KEY}":
            self.send_response(401)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        if body.get("model") != verify_auth.MODEL_ID or body.get("max_tokens") != 1:
            self.send_response(400)
            self.end_headers()
            return
        payload = json.dumps(
            {"model": self.result_model, "choices": [{"message": {"role": "assistant", "content": "O"}}]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def write_private(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)


class AuthProbeTests(unittest.TestCase):
    def run_probe(self, *, accept_all: bool = False, result_model: str = verify_auth.MODEL_ID):
        handler = type("ConfiguredAuthHandler", (AuthHandler,), {"accept_all": accept_all, "result_model": result_model})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return verify_auth.probe_api_auth("127.0.0.1", server.server_port, API_KEY)

    def test_missing_and_wrong_keys_fail_and_correct_synthetic_inference_succeeds(self):
        self.assertEqual(self.run_probe(), (401, 401, 200, verify_auth.MODEL_ID))

    def test_endpoint_that_accepts_missing_key_is_rejected(self):
        with self.assertRaisesRegex(verify_auth.VerificationError, "did not reject"):
            self.run_probe(accept_all=True)

    def test_response_for_another_model_is_rejected(self):
        with self.assertRaisesRegex(verify_auth.VerificationError, "did not match"):
            self.run_probe(result_model="different-model")


class ProcessBoundProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scout-auth-proof-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.prefix = self.root / "termux"
        self.config = self.home / ".config" / "scout-matepad-link"
        self.model_dir = self.home / "models"
        self.bin_dir = self.prefix / "bin"
        self.config.mkdir(parents=True)
        self.config.chmod(0o700)
        self.model_dir.mkdir(parents=True)
        self.bin_dir.mkdir(parents=True)
        self.model_path = self.model_dir / "Qwen3-0.6B-Q4_0.gguf"
        self.server_path = self.bin_dir / "llama-server"
        self.key_path = self.config / "model-api-key"
        self.profile_path = self.config / "profile.conf"
        self.identity_path = self.config / "server-identity.conf"
        self.proc_root = self.root / "proc"
        self.pid = 4567
        self.start_ticks = "24680"
        self.model_path.write_bytes(b"synthetic model fixture")
        self.server_path.write_text(
            "#!/bin/sh\nprintf 'version: 9590 (`d2462f8`)\\nbuilt for synthetic tests\\n'\n",
            encoding="utf-8",
        )
        self.server_path.chmod(0o755)
        self.key_path.write_text(API_KEY + "\n", encoding="ascii")
        self.key_path.chmod(0o600)
        self.model_hash = hashlib.sha256(self.model_path.read_bytes()).hexdigest()
        self.server_hash = hashlib.sha256(self.server_path.read_bytes()).hexdigest()
        profile = {
            "format": "1",
            "linode_host": verify_auth.REMOTE_HOST,
            "linode_port": "22",
            "remote_user": "scout-matepad-forward",
            "remote_listen": "127.0.0.1:18088",
            "device_target": "127.0.0.1:8081",
            "model_id": verify_auth.MODEL_ID,
            "model_file": str(self.model_path),
            "model_sha256": self.model_hash,
            "llama_server_sha256": self.server_hash,
            "host_key_fingerprint": "SHA256:" + "A" * 43,
        }
        write_private(self.profile_path, "".join(f"{key}={value}\n" for key, value in profile.items()))
        self._write_proc_fixture()
        identity = {
            "format": "1",
            "pid": str(self.pid),
            "start_ticks": self.start_ticks,
            "server_sha256": self.server_hash,
            "model_sha256": self.model_hash,
            "key_sha256": hashlib.sha256(self.key_path.read_bytes()).hexdigest(),
        }
        write_private(self.identity_path, "".join(f"{key}={value}\n" for key, value in identity.items()))

    def _write_proc_fixture(self, *, wrong_argv: bool = False, start_ticks: str | None = None) -> None:
        process = self.proc_root / str(self.pid)
        (process / "fd").mkdir(parents=True, exist_ok=True)
        (process / "exe").unlink(missing_ok=True)
        (process / "fd" / "3").unlink(missing_ok=True)
        state_fields = ["S"] + ["0"] * 18 + [start_ticks or self.start_ticks]
        (process / "stat").write_text(f"{self.pid} (llama-server) " + " ".join(state_fields), encoding="ascii")
        model_arg = str(self.model_path) + (".wrong" if wrong_argv else "")
        argv = [
            str(self.server_path),
            "--model",
            model_arg,
            "--alias",
            verify_auth.MODEL_ID,
            "--host",
            "127.0.0.1",
            "--port",
            "8081",
            "--api-key-file",
            str(self.key_path),
            "--parallel",
            "1",
            "--ctx-size",
            "4096",
            "--threads",
            "2",
            "--threads-batch",
            "2",
            "--no-cont-batching",
            "--no-ui",
        ]
        (process / "cmdline").write_bytes(b"\0".join(arg.encode() for arg in argv) + b"\0")
        os.symlink(self.server_path, process / "exe")
        net = self.proc_root / "net"
        net.mkdir(parents=True, exist_ok=True)
        header = "sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode\n"
        row = "0: 0100007F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 98765\n"
        (net / "tcp").write_text(header + row, encoding="ascii")
        (net / "tcp6").write_text(header, encoding="ascii")
        os.symlink("socket:[98765]", process / "fd" / "3")

    def test_exact_process_and_listener_identity_required(self):
        _, identity, _, _, _ = verify_auth._check_live_process(self.home, self.prefix, self.proc_root)
        self.assertEqual(identity["pid"], str(self.pid))
        self._write_proc_fixture(wrong_argv=True)
        with self.assertRaisesRegex(verify_auth.VerificationError, "arguments"):
            verify_auth._check_live_process(self.home, self.prefix, self.proc_root)

    def test_pid_reuse_is_rejected_by_start_time(self):
        self._write_proc_fixture(start_ticks="99999")
        with self.assertRaisesRegex(verify_auth.VerificationError, "identity has changed"):
            verify_auth._check_live_process(self.home, self.prefix, self.proc_root)

    def test_same_profile_digest_cannot_approve_a_different_llama_build(self):
        self.server_path.write_text("#!/bin/sh\nprintf 'version: 9999 (different)\\n'\n", encoding="utf-8")
        self.server_path.chmod(0o755)
        digest = hashlib.sha256(self.server_path.read_bytes()).hexdigest()
        lines = self.profile_path.read_text(encoding="utf-8").splitlines()
        write_private(
            self.profile_path,
            "\n".join(
                f"llama_server_sha256={digest}" if line.startswith("llama_server_sha256=") else line
                for line in lines
            )
            + "\n",
        )
        with self.assertRaisesRegex(verify_auth.VerificationError, "approved b9590"):
            verify_auth._profile(self.home, self.prefix)

    def test_proof_contains_identity_and_expiry_without_key_bytes(self):
        before = int(time.time())
        with patch.object(verify_auth, "probe_api_auth", return_value=(401, 401, 200, verify_auth.MODEL_ID)) as probe:
            verify_auth.verify(self.home, self.prefix, self.proc_root)
        probe.assert_called_once_with("127.0.0.1", 8081, API_KEY)
        proof_path = self.config / "auth-proof.conf"
        self.assertEqual(proof_path.stat().st_mode & 0o777, 0o600)
        proof = dict(line.split("=", 1) for line in proof_path.read_text(encoding="utf-8").splitlines())
        self.assertEqual(proof["format"], "2")
        self.assertEqual(proof["server_pid"], str(self.pid))
        self.assertEqual(proof["api_key_sha256"], hashlib.sha256(self.key_path.read_bytes()).hexdigest())
        self.assertEqual(int(proof["expires_epoch"]) - int(proof["created_epoch"]), 300)
        self.assertGreaterEqual(int(proof["created_epoch"]), before)
        self.assertNotIn(API_KEY, proof_path.read_text(encoding="utf-8"))

    def test_key_rotation_during_probe_refuses_and_leaves_no_proof(self):
        def rotate_then_pass(*_args):
            self.key_path.write_text("A-Different-Synthetic-Test-Key-That-Is-Not-Real\n", encoding="ascii")
            self.key_path.chmod(0o600)
            return 401, 401, 200, verify_auth.MODEL_ID

        with patch.object(verify_auth, "probe_api_auth", side_effect=rotate_then_pass):
            with self.assertRaisesRegex(verify_auth.VerificationError, "identity|artifacts"):
                verify_auth.verify(self.home, self.prefix, self.proc_root)
        self.assertFalse((self.config / "auth-proof.conf").exists())


if __name__ == "__main__":
    unittest.main()
