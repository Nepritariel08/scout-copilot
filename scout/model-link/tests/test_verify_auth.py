#!/usr/bin/env python3
"""Portable contract tests for the managed synthetic-auth qualification."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import socket
import sys
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
sys.modules[SPEC.name] = verify_auth
SPEC.loader.exec_module(verify_auth)

API_KEY = "Synthetic-Test-Key-That-Is-Not-A-Real-Secret-32"
HOST_FINGERPRINT = "SHA256:" + "A" * 43


class AuthHandler(BaseHTTPRequestHandler):
    accept_all = False
    result_model = verify_auth.MODEL_ID
    result_role = "assistant"
    result_content = verify_auth.SENTINEL
    result_finish = "stop"
    include_usage = True
    valid_status = 200
    delay_seconds = 0.0
    observed: list[tuple[str | None, str, dict[str, object]]] = []
    get_observed: list[tuple[str | None, str]] = []

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        type(self).get_observed.append((self.headers.get("Authorization"), self.path))
        if self.path != "/v1/models":
            self.send_response(404)
            self.end_headers()
            return
        if not self.accept_all and self.headers.get("Authorization") != f"Bearer {API_KEY}":
            self.send_response(401)
            self.end_headers()
            return
        payload = json.dumps({"data": [{"id": verify_auth.MODEL_ID}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        auth = self.headers.get("Authorization")
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).observed.append((auth, self.path, body))
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        if not self.accept_all and auth != f"Bearer {API_KEY}":
            self.send_response(401)
            self.end_headers()
            return
        if body.get("model") != verify_auth.MODEL_ID or body.get("max_tokens") != 16:
            self.send_response(400)
            self.end_headers()
            return
        if body.get("chat_template_kwargs") != {"enable_thinking": False}:
            self.send_response(400)
            self.end_headers()
            return
        payload_dict: dict[str, object] = {
            "model": self.result_model,
            "choices": [
                {
                    "message": {"role": self.result_role, "content": self.result_content},
                    "finish_reason": self.result_finish,
                }
            ],
        }
        if self.include_usage:
            payload_dict["usage"] = {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12}
        payload = json.dumps(payload_dict).encode()
        self.send_response(self.valid_status)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def serve_auth(handler: type[AuthHandler] | None = None, port: int = 0):
    cls = handler or AuthHandler
    server = ThreadingHTTPServer(("127.0.0.1", port), cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


class AuthProbeTests(unittest.TestCase):
    def run_probe(self, **settings):
        handler = type("ConfiguredAuthHandler", (AuthHandler,), {"observed": [], **settings})
        server, thread = serve_auth(handler)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return verify_auth.probe_api_auth("127.0.0.1", server.server_port, API_KEY), handler

    def test_missing_and_wrong_keys_fail_then_one_exact_synthetic_generation_succeeds(self):
        result, handler = self.run_probe()
        self.assertEqual((result.missing_status, result.wrong_status, result.valid_status), (401, 401, 200))
        self.assertEqual(result.response_text, verify_auth.SENTINEL)
        self.assertEqual(result.total_tokens, result.prompt_tokens + result.completion_tokens)
        self.assertEqual(len(handler.observed), 3)
        self.assertIsNone(handler.observed[0][0])
        self.assertNotEqual(handler.observed[1][0], f"Bearer {API_KEY}")
        request = handler.observed[2][2]
        self.assertEqual(request["max_tokens"], 16)
        self.assertEqual(request["chat_template_kwargs"], {"enable_thinking": False})
        self.assertIn(verify_auth.SENTINEL, request["messages"][0]["content"])

    def test_endpoint_that_accepts_missing_key_is_rejected(self):
        with self.assertRaisesRegex(verify_auth.VerificationError, "did not reject"):
            self.run_probe(accept_all=True)

    def test_wrong_model_role_content_finish_or_missing_usage_is_rejected(self):
        for settings in (
            {"result_model": "different-model"},
            {"result_role": "user"},
            {"result_content": "some other answer"},
            {"result_content": f" {verify_auth.SENTINEL} "},
            {"result_finish": "length"},
            {"include_usage": False},
        ):
            with self.subTest(settings=settings):
                with self.assertRaises(verify_auth.VerificationError):
                    self.run_probe(**settings)

    def test_total_deadline_bounds_a_slow_endpoint(self):
        handler = type("SlowAuthHandler", (AuthHandler,), {"delay_seconds": 0.1, "accept_all": True})
        server, thread = serve_auth(handler)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        with self.assertRaises(verify_auth.VerificationError):
            verify_auth.probe_api_auth("127.0.0.1", server.server_port, API_KEY, total_deadline_seconds=0.02)


class FakeChild:
    next_pid = 9000

    def __init__(self, *, stdout: bytes | None = None):
        self.pid = FakeChild.next_pid
        FakeChild.next_pid += 1
        self.returncode: int | None = None
        self.terminated = False
        self.stdout = io.BytesIO(stdout) if stdout is not None else None

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


class ManagedRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scout-model-link-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.prefix = self.root / "termux"
        self.config = self.home / ".config" / "scout-matepad-link"
        self.ssh_dir = self.home / ".ssh"
        self.model_dir = self.home / "models"
        self.bin_dir = self.prefix / "bin"
        for directory in (self.config, self.ssh_dir, self.model_dir, self.bin_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.config.chmod(0o700)
        self.ssh_dir.chmod(0o700)
        self.model_path = self.model_dir / "Qwen3-0.6B-Q4_0.gguf"
        self.server_path = self.bin_dir / "llama-server"
        self.ssh_path = self.bin_dir / "ssh"
        self.ssh_keygen_path = self.bin_dir / "ssh-keygen"
        self.key_path = self.config / "model-api-key"
        self.profile_path = self.config / "profile.conf"
        self.ssh_key_path = self.ssh_dir / "scout-matepad-link"
        self.known_hosts_path = self.ssh_dir / "scout-matepad-known_hosts"
        self.model_path.write_bytes(b"synthetic model fixture")
        self.server_path.write_text("synthetic llama-server fixture\n", encoding="ascii")
        self.server_path.chmod(0o700)
        self.ssh_path.write_text("synthetic ssh fixture\n", encoding="ascii")
        self.ssh_path.chmod(0o700)
        self.ssh_keygen_path.write_text(
            "#!/bin/sh\n"
            "case \"$1\" in\n"
            "  -y) exit 0 ;;\n"
            "  -F) printf '# Host scout-pilot-linode found: line 1\\nscout-pilot-linode ssh-ed25519 SYNTHETIC\\n' ;;\n"
            "  -lf) printf '256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA known-host (ED25519)\\n' ;;\n"
            "  *) exit 2 ;;\n"
            "esac\n",
            encoding="ascii",
        )
        self.ssh_keygen_path.chmod(0o700)
        self.key_path.write_text(API_KEY + "\n", encoding="ascii")
        self.key_path.chmod(0o600)
        self.ssh_key_path.write_text("synthetic protected SSH key\n", encoding="ascii")
        self.known_hosts_path.write_text("scout-pilot-linode ssh-ed25519 SYNTHETIC\n", encoding="ascii")
        self.ssh_key_path.chmod(0o600)
        self.known_hosts_path.chmod(0o600)
        self.model_hash = hashlib.sha256(self.model_path.read_bytes()).hexdigest()
        self.server_hash = hashlib.sha256(self.server_path.read_bytes()).hexdigest()
        profile = {
            "format": "1",
            "linode_host": verify_auth.REMOTE_HOST,
            "linode_port": str(verify_auth.LINODE_PORT),
            "remote_user": verify_auth.REMOTE_USER,
            "remote_listen": verify_auth.REMOTE_LISTEN,
            "device_target": "127.0.0.1:8081",
            "model_id": verify_auth.MODEL_ID,
            "model_file": str(self.model_path),
            "model_sha256": self.model_hash,
            "llama_server_sha256": self.server_hash,
            "host_key_fingerprint": HOST_FINGERPRINT,
        }
        self._write_profile(profile)

    def _write_profile(self, profile: dict[str, str]) -> None:
        self.profile_path.write_text("".join(f"{key}={value}\n" for key, value in profile.items()), encoding="utf-8")
        self.profile_path.chmod(0o600)

    def _free_port(self) -> int:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(sock.close)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        return port

    def _run_with_children(self, *, accept_all: bool = False, sleep_hook=None):
        port = self._free_port()
        handler = type("ManagedAuthHandler", (AuthHandler,), {"accept_all": accept_all, "observed": [], "get_observed": []})
        servers: list[ThreadingHTTPServer] = []
        threads: list[threading.Thread] = []
        children: list[FakeChild] = []
        argv_calls: list[list[str]] = []

        def fake_popen(argv, *, capture_output=False):
            argv_calls.append(argv)
            readiness = (verify_auth.SERVER_READY_MARKER + " - starting the main loop\n").encode() if capture_output else None
            child = FakeChild(stdout=readiness)
            children.append(child)
            if argv[0] == str(self.server_path):
                self.assertTrue(capture_output)
                server, thread = serve_auth(handler, port=port)
                servers.append(server)
                threads.append(thread)
            return child

        cleanup = lambda: [server.shutdown() for server in servers]
        self.addCleanup(cleanup)
        self.addCleanup(lambda: [thread.join(2) for thread in threads])
        self.addCleanup(lambda: [server.server_close() for server in servers])
        with patch.object(verify_auth, "DEVICE_PORT", port), patch.object(
            verify_auth, "SERVER_BINARY_SHA256", self.server_hash
        ), patch.object(verify_auth, "_popen", side_effect=fake_popen):
            if sleep_hook is None:
                verify_auth.run_managed(self.home, self.prefix)
            else:
                verify_auth.run_managed(self.home, self.prefix, sleep_fn=sleep_hook)
        return children, handler, argv_calls, port

    def test_profile_pins_artifacts_and_rejects_digest_drift(self):
        with patch.object(verify_auth, "SERVER_BINARY_SHA256", self.server_hash):
            _, _, _, _ = verify_auth._profile(self.home, self.prefix)
            profile = dict(line.split("=", 1) for line in self.profile_path.read_text(encoding="utf-8").splitlines())
            profile["llama_server_sha256"] = "0" * 64
            self._write_profile(profile)
            with self.assertRaisesRegex(verify_auth.VerificationError, "digest"):
                verify_auth._profile(self.home, self.prefix)

            profile["llama_server_sha256"] = self.server_hash
            self._write_profile(profile)
            self.model_path.write_bytes(b"changed synthetic model fixture")
            with self.assertRaisesRegex(verify_auth.VerificationError, "model digest changed"):
                verify_auth._profile(self.home, self.prefix)

    def test_out_of_band_host_pin_must_match_known_hosts(self):
        with patch.object(verify_auth, "SERVER_BINARY_SHA256", self.server_hash):
            profile = dict(line.split("=", 1) for line in self.profile_path.read_text(encoding="utf-8").splitlines())
            profile["host_key_fingerprint"] = "SHA256:" + "B" * 43
            self._write_profile(profile)
            snapshot = verify_auth._capture_snapshot(self.home, self.prefix)
            with self.assertRaisesRegex(verify_auth.VerificationError, "out-of-band pin"):
                verify_auth._validate_ssh_identity(snapshot)

    def test_expiry_stops_only_owned_children_and_writes_expiring_nonsecret_evidence(self):
        expected_proof_ttl = 0.02
        with patch.object(verify_auth, "PROOF_TTL_SECONDS", expected_proof_ttl), patch.object(
            verify_auth, "SUPERVISOR_POLL_SECONDS", 0.001
        ), patch.object(verify_auth, "HEALTH_INTERVAL_SECONDS", 100):
            children, handler, argv_calls, port = self._run_with_children()
        self.assertEqual(len(children), 2)
        self.assertTrue(all(child.terminated for child in children))
        self.assertEqual(len(handler.observed), 3)
        server_argv, ssh_argv = argv_calls
        self.assertEqual(server_argv[0], str(self.server_path))
        self.assertEqual(server_argv[server_argv.index("--host") + 1], "127.0.0.1")
        self.assertEqual(server_argv[server_argv.index("--port") + 1], str(port))
        self.assertEqual(server_argv[server_argv.index("--api-key-file") + 1], str(self.key_path))
        self.assertNotIn(API_KEY, server_argv)
        self.assertIn("-N", ssh_argv)
        self.assertIn("-T", ssh_argv)
        self.assertIn("-F", ssh_argv)
        self.assertIn("/dev/null", ssh_argv)
        self.assertIn("scout-matepad-forward@172.104.173.160", ssh_argv)
        remote_forward = ssh_argv[ssh_argv.index("-R") + 1]
        self.assertTrue(remote_forward.startswith("127.0.0.1:18088:127.0.0.1:"))
        proof = self.config / "auth-proof.conf"
        self.assertTrue(proof.exists())
        text = proof.read_text(encoding="utf-8")
        fields = dict(line.split("=", 1) for line in text.splitlines())
        self.assertEqual(fields["kernel_socket_attestation"], "false")
        self.assertEqual(fields["server_readiness_marker"], verify_auth.SERVER_READY_MARKER)
        self.assertEqual(fields["response_text"], verify_auth.SENTINEL)
        self.assertEqual(verify_auth.PROOF_TTL_SECONDS, 300)
        self.assertAlmostEqual(float(fields["expires_epoch"]) - float(fields["created_epoch"]), expected_proof_ttl)
        self.assertNotIn(API_KEY, text)

    def test_auth_failure_never_starts_tunnel_or_preserves_proof(self):
        port = self._free_port()
        children: list[FakeChild] = []
        handler = type("NoAuthHandler", (AuthHandler,), {"accept_all": True, "observed": [], "get_observed": []})
        servers: list[ThreadingHTTPServer] = []
        threads: list[threading.Thread] = []

        def fake_popen(argv, *, capture_output=False):
            child = FakeChild(stdout=(verify_auth.SERVER_READY_MARKER + "\n").encode() if capture_output else None)
            children.append(child)
            if argv[0] == str(self.server_path):
                server, thread = serve_auth(handler, port=port)
                servers.append(server)
                threads.append(thread)
            return child

        self.addCleanup(lambda: [thread.join(2) for thread in threads])
        self.addCleanup(lambda: [server.shutdown() for server in servers])
        self.addCleanup(lambda: [server.server_close() for server in servers])
        with patch.object(verify_auth, "DEVICE_PORT", port), patch.object(
            verify_auth, "SERVER_BINARY_SHA256", self.server_hash
        ), patch.object(verify_auth, "_popen", side_effect=fake_popen):
            with self.assertRaisesRegex(verify_auth.VerificationError, "did not reject"):
                verify_auth.run_managed(self.home, self.prefix)
        self.assertEqual(len(children), 1)
        self.assertTrue(children[0].terminated)
        self.assertFalse((self.config / "auth-proof.conf").exists())
        self.assertEqual(len(handler.observed), 1)

    def test_preexisting_listener_is_left_untouched_and_no_child_is_spawned(self):
        port = self._free_port()
        server, thread = serve_auth(port=port)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        called = []
        with patch.object(verify_auth, "DEVICE_PORT", port), patch.object(
            verify_auth, "SERVER_BINARY_SHA256", self.server_hash
        ), patch.object(verify_auth, "_popen", side_effect=lambda *_: called.append(True)):
            with self.assertRaisesRegex(verify_auth.VerificationError, "already has a responding listener"):
                verify_auth.run_managed(self.home, self.prefix)
        self.assertEqual(called, [])
        self.assertTrue(server.socket.fileno() >= 0)

    def test_foreign_listener_cannot_pass_without_owned_child_readiness_marker(self):
        port = self._free_port()
        handler = type("ForeignAuthHandler", (AuthHandler,), {"accept_all": True, "observed": [], "get_observed": []})
        servers: list[ThreadingHTTPServer] = []
        threads: list[threading.Thread] = []
        children: list[FakeChild] = []
        popen_calls: list[list[str]] = []
        real_assert_port_free = verify_auth.assert_port_free

        def race_after_free_check(checked_port):
            real_assert_port_free(checked_port)
            self.assertEqual(checked_port, port)
            foreign, thread = serve_auth(handler, port=port)
            servers.append(foreign)
            threads.append(thread)

        def fake_popen(argv, *, capture_output=False):
            popen_calls.append(argv)
            child = FakeChild(stdout=b"" if capture_output else None)
            children.append(child)
            return child

        self.addCleanup(lambda: [thread.join(2) for thread in threads])
        self.addCleanup(lambda: [server.shutdown() for server in servers])
        self.addCleanup(lambda: [server.server_close() for server in servers])
        with patch.object(verify_auth, "DEVICE_PORT", port), patch.object(
            verify_auth, "SERVER_BINARY_SHA256", self.server_hash
        ), patch.object(verify_auth, "assert_port_free", side_effect=race_after_free_check), patch.object(
            verify_auth, "SERVER_START_TIMEOUT_SECONDS", 1
        ), patch.object(verify_auth, "_popen", side_effect=fake_popen):
            with self.assertRaisesRegex(verify_auth.VerificationError, "without a readiness marker"):
                verify_auth.run_managed(self.home, self.prefix)

        self.assertEqual(len(children), 1)
        self.assertTrue(children[0].terminated)
        self.assertEqual(len(popen_calls), 1)
        self.assertEqual(handler.get_observed, [])
        self.assertEqual(handler.observed, [])
        self.assertFalse((self.config / "auth-proof.conf").exists())

    def test_key_change_during_session_stops_owned_children_and_removes_proof(self):
        def rotate(_seconds):
            self.key_path.write_text("Another-Synthetic-API-Key-That-Is-Not-Real-32chars\n", encoding="ascii")
            self.key_path.chmod(0o600)

        with patch.object(verify_auth, "PROOF_TTL_SECONDS", 2), patch.object(
            verify_auth, "SUPERVISOR_POLL_SECONDS", 0.001
        ), patch.object(verify_auth, "HEALTH_INTERVAL_SECONDS", 100):
            with self.assertRaisesRegex(verify_auth.VerificationError, "identity changed"):
                self._run_with_children(sleep_hook=rotate)
        self.assertFalse((self.config / "auth-proof.conf").exists())


if __name__ == "__main__":
    unittest.main()
