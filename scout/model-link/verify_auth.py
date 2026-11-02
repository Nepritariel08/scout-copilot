#!/usr/bin/env python3
"""Run one bounded, authenticated MatePad model-link session.

This verifier assumes a trusted Termux device account. It proves that this
launcher started the pinned server binary with the fixed loopback arguments,
that the child remains alive, and that the endpoint enforces its protected key.
It does not claim kernel-level socket ownership or protection from compromised
code running as the same Android UID.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

MODEL_ID = "Qwen3-0.6B"
SENTINEL = "SCOUT_MATEPAD_LOCAL_OK"
SERVER_BINARY_SHA256 = "6e8f34cac967060aa042a8bd2f65f06cf960c3c58063d0fb1876a3fc755e02b8"
REMOTE_HOST = "172.104.173.160"
DEVICE_PORT = 8081
LINODE_PORT = 22
REMOTE_LISTEN = "127.0.0.1:18088"
REMOTE_USER = "scout-matepad-forward"
PROOF_TTL_SECONDS = 300
SERVER_START_TIMEOUT_SECONDS = 120
AUTH_PROBE_TOTAL_DEADLINE_SECONDS = 60
SUPERVISOR_POLL_SECONDS = 5
HEALTH_INTERVAL_SECONDS = 30
HTTP_REQUEST_TIMEOUT_SECONDS = 5
MAX_RESPONSE_BYTES = 65536
MAX_SERVER_LOG_LINE_BYTES = 1024
SERVER_READY_MARKER = f"main: server is listening on http://127.0.0.1:{DEVICE_PORT}"
PROFILE_FIELDS = {
    "format",
    "linode_host",
    "linode_port",
    "remote_user",
    "remote_listen",
    "device_target",
    "model_id",
    "model_file",
    "model_sha256",
    "llama_server_sha256",
    "host_key_fingerprint",
}


class VerificationError(Exception):
    """A safe-to-print refusal without response bodies or credential values."""


@dataclass(frozen=True)
class Snapshot:
    profile: dict[str, str]
    model_path: Path
    server_path: Path
    key_path: Path
    ssh_path: Path
    ssh_key_path: Path
    known_hosts_path: Path
    model_sha256: str
    server_sha256: str
    key_sha256: str
    ssh_sha256: str
    ssh_key_sha256: str
    known_hosts_sha256: str


@dataclass(frozen=True)
class AuthProbeResult:
    missing_status: int
    wrong_status: int
    valid_status: int
    response_model: str
    response_text: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    finish_reason: str


@dataclass
class ManagedServer:
    process: subprocess.Popen[bytes]
    output_event: threading.Event = field(default_factory=threading.Event)
    readiness_message: str | None = None
    output_eof: bool = False
    output_thread: threading.Thread | None = None


def _read_kv(path: Path, allowed: set[str], exact_count: int) -> dict[str, str]:
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise VerificationError("required local policy file cannot be read") from exc
    result: dict[str, str] = {}
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise VerificationError("local policy file syntax is invalid")
        key, value = line.split("=", 1)
        if key not in allowed or not value or key in result:
            raise VerificationError("local policy file fields are invalid")
        result[key] = value
    if len(result) != exact_count:
        raise VerificationError("local policy file is incomplete")
    return result


def _private_file(path: Path, max_bytes: int = 16384) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as exc:
        raise VerificationError("required protected file is missing") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise VerificationError("protected file is linked or has the wrong owner")
    if info.st_mode & 0o077 or info.st_size > max_bytes:
        raise VerificationError("protected file permissions or size are unsafe")
    return info


def _owned_regular_file(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as exc:
        raise VerificationError("required local artifact is missing") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise VerificationError("local artifact is linked or has the wrong owner")
    return info


def _private_directory(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as exc:
        raise VerificationError("protected model-link directory is unavailable") from exc
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise VerificationError("protected model-link directory permissions are unsafe")
    return info


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        raise VerificationError("required artifact cannot be read") from exc
    return digest.hexdigest()


def _profile(home: Path, prefix: Path) -> tuple[dict[str, str], Path, Path, Path]:
    config_dir = home / ".config" / "scout-matepad-link"
    _private_directory(config_dir)
    profile_path = config_dir / "profile.conf"
    _private_file(profile_path)
    profile = _read_kv(profile_path, PROFILE_FIELDS, 11)
    expected = {
        "format": "1",
        "linode_host": REMOTE_HOST,
        "linode_port": str(LINODE_PORT),
        "remote_user": REMOTE_USER,
        "remote_listen": REMOTE_LISTEN,
        "device_target": "127.0.0.1:8081",
        "model_id": MODEL_ID,
    }
    if any(profile.get(key) != value for key, value in expected.items()):
        raise VerificationError("local profile target or model has drifted")
    if not re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", profile["host_key_fingerprint"]):
        raise VerificationError("out-of-band host-key fingerprint is invalid")
    model_path = Path(profile["model_file"])
    server_path = prefix / "bin" / "llama-server"
    key_path = config_dir / "model-api-key"
    if not model_path.is_absolute() or model_path.parent != home / "models":
        raise VerificationError("model path is outside the one-model directory")
    if not re.fullmatch(r"Qwen3-0\.6B[A-Za-z0-9._-]*\.gguf", model_path.name):
        raise VerificationError("model path is outside the one-model allowlist")
    if not re.fullmatch(r"[a-f0-9]{64}", profile["model_sha256"]):
        raise VerificationError("model digest is missing")
    if profile["llama_server_sha256"] != SERVER_BINARY_SHA256:
        raise VerificationError("server digest does not match the protected device readback")
    _owned_regular_file(server_path)
    _owned_regular_file(model_path)
    if _digest(model_path) != profile["model_sha256"]:
        raise VerificationError("model digest changed")
    if _digest(server_path) != profile["llama_server_sha256"]:
        raise VerificationError("server binary digest changed")
    _read_key(key_path)
    return profile, model_path, server_path, key_path


def _read_key(path: Path) -> str:
    _private_file(path, max_bytes=512)
    try:
        raw = path.read_bytes()
        value = raw.removesuffix(b"\n").decode("ascii", errors="strict")
    except (OSError, UnicodeError) as exc:
        raise VerificationError("model API key cannot be read safely") from exc
    if not re.fullmatch(r"[A-Za-z0-9._~-]{32,512}", value):
        raise VerificationError("model API key is not one bounded key")
    return value


def _capture_snapshot(home: Path, prefix: Path) -> Snapshot:
    profile, model_path, server_path, key_path = _profile(home, prefix)
    ssh_path = prefix / "bin" / "ssh"
    ssh_key_path = home / ".ssh" / "scout-matepad-link"
    known_hosts_path = home / ".ssh" / "scout-matepad-known_hosts"
    _owned_regular_file(ssh_path)
    if not os.access(ssh_path, os.X_OK):
        raise VerificationError("existing OpenSSH client is unavailable")
    _private_file(ssh_key_path, max_bytes=16384)
    _private_file(known_hosts_path, max_bytes=16384)
    return Snapshot(
        profile=profile,
        model_path=model_path,
        server_path=server_path,
        key_path=key_path,
        ssh_path=ssh_path,
        ssh_key_path=ssh_key_path,
        known_hosts_path=known_hosts_path,
        model_sha256=_digest(model_path),
        server_sha256=_digest(server_path),
        key_sha256=_digest(key_path),
        ssh_sha256=_digest(ssh_path),
        ssh_key_sha256=_digest(ssh_key_path),
        known_hosts_sha256=_digest(known_hosts_path),
    )


def _validate_ssh_identity(snapshot: Snapshot) -> None:
    ssh_keygen = snapshot.ssh_path.with_name("ssh-keygen")
    _owned_regular_file(ssh_keygen)
    if not os.access(ssh_keygen, os.X_OK):
        raise VerificationError("existing ssh-keygen is unavailable")
    try:
        key_check = subprocess.run(
            [str(ssh_keygen), "-y", "-P", "", "-f", str(snapshot.ssh_key_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        pin_check = subprocess.run(
            [str(ssh_keygen), "-F", "scout-pilot-linode", "-f", str(snapshot.known_hosts_path)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        fingerprint_check = subprocess.run(
            [str(ssh_keygen), "-lf", str(snapshot.known_hosts_path), "-E", "sha256"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise VerificationError("strict SSH key and host-pin validation could not complete") from exc
    if key_check.returncode != 0:
        raise VerificationError("dedicated SSH private key is unreadable or requires interaction")
    if pin_check.returncode != 0:
        raise VerificationError("out-of-band pinned SSH host is missing")
    entries = [line.split() for line in pin_check.stdout.splitlines() if line and not line.startswith("#")]
    if len(entries) != 1 or len(entries[0]) < 3 or entries[0][0] != "scout-pilot-linode" or entries[0][1] != "ssh-ed25519":
        raise VerificationError("pinned SSH host entry is ambiguous or has changed")
    fingerprints = [line.split() for line in fingerprint_check.stdout.splitlines() if line.strip()]
    if fingerprint_check.returncode != 0 or len(fingerprints) != 1 or len(fingerprints[0]) < 2:
        raise VerificationError("pinned SSH host fingerprint cannot be read")
    if fingerprints[0][1] != snapshot.profile["host_key_fingerprint"]:
        raise VerificationError("known-host key differs from the out-of-band pin")


def _assert_snapshot(home: Path, prefix: Path, initial: Snapshot) -> None:
    current = _capture_snapshot(home, prefix)
    if current != initial:
        raise VerificationError("server, model, credential, host pin, or profile identity changed")


def _endpoint_is_free(host: str, port: int, family: int) -> bool:
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
    except OSError as exc:
        if family == socket.AF_INET6 and exc.errno in {
            errno.EAFNOSUPPORT,
            errno.EPROTONOSUPPORT,
            errno.ENOPROTOOPT,
            errno.EADDRNOTAVAIL,
        }:
            return True
        raise VerificationError("cannot determine whether the model endpoint is already occupied") from exc
    try:
        sock.settimeout(0.75)
        try:
            address = (host, port) if family == socket.AF_INET else (host, port, 0, 0)
            result = sock.connect_ex(address)
        except OSError as exc:
            if exc.errno in {errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.ENOPROTOOPT, errno.EADDRNOTAVAIL}:
                return True
            raise VerificationError("cannot determine whether the model endpoint is already occupied") from exc
        if result == 0:
            return False
        if result == errno.ECONNREFUSED:
            return True
        if family == socket.AF_INET6 and result in {
            errno.EAFNOSUPPORT,
            errno.EPROTONOSUPPORT,
            errno.ENOPROTOOPT,
            errno.EADDRNOTAVAIL,
        }:
            return True
        raise VerificationError("model endpoint occupancy is unknown; refusing to start")
    finally:
        sock.close()


def assert_port_free(port: int = DEVICE_PORT) -> None:
    if not _endpoint_is_free("127.0.0.1", port, socket.AF_INET):
        raise VerificationError("port 8081 already has a responding listener; unknown processes are left untouched")
    if hasattr(socket, "AF_INET6") and not _endpoint_is_free("::1", port, socket.AF_INET6):
        raise VerificationError("IPv6 loopback port 8081 is occupied; refusing to start")


def _server_argv(snapshot: Snapshot) -> list[str]:
    return [
        str(snapshot.server_path),
        "--model",
        str(snapshot.model_path),
        "--alias",
        MODEL_ID,
        "--host",
        "127.0.0.1",
        "--port",
        str(DEVICE_PORT),
        "--api-key-file",
        str(snapshot.key_path),
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


def _ssh_argv(snapshot: Snapshot) -> list[str]:
    return [
        str(snapshot.ssh_path),
        "-F",
        "/dev/null",
        "-N",
        "-T",
        "-p",
        str(LINODE_PORT),
        "-i",
        str(snapshot.ssh_key_path),
        "-o",
        "BatchMode=yes",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "PubkeyAuthentication=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        f"UserKnownHostsFile={snapshot.known_hosts_path}",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "HostKeyAlias=scout-pilot-linode",
        "-o",
        "HostKeyAlgorithms=ssh-ed25519",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "CanonicalizeHostname=no",
        "-o",
        "ProxyCommand=none",
        "-o",
        "ProxyJump=none",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "RequestTTY=no",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=no",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-R",
        f"{REMOTE_LISTEN}:127.0.0.1:{DEVICE_PORT}",
        f"{REMOTE_USER}@{REMOTE_HOST}",
    ]


def _request_json(
    host: str,
    port: int,
    path: str,
    api_key: str | None,
    body: bytes | None,
    deadline: float,
) -> tuple[int, bytes]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise VerificationError("local model probe exceeded its total deadline")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    headers: list[str] = [f"Host: {host}:{port}", "Connection: close"]
    if api_key is not None:
        headers.append(f"Authorization: Bearer {api_key}")
    if body is not None:
        headers.append("Content-Type: application/json")
        headers.append(f"Content-Length: {len(body)}")
    request_body = body or b""
    request = (
        f"{'POST' if body is not None else 'GET'} {path} HTTP/1.1\r\n"
        + "\r\n".join(headers)
        + "\r\n\r\n"
    ).encode("ascii") + request_body
    try:
        sock.settimeout(min(HTTP_REQUEST_TIMEOUT_SECONDS, remaining))
        sock.connect((host, port))
        sock.setblocking(False)
        sent = 0
        while sent < len(request):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerificationError("local model probe exceeded its total deadline")
            _, writable, _ = select.select([], [sock], [], remaining)
            if not writable:
                raise VerificationError("local model probe exceeded its total deadline")
            sent_count = sock.send(request[sent:])
            if sent_count <= 0:
                raise VerificationError("local model endpoint connection closed while sending a request")
            sent += sent_count

        received = bytearray()
        header_end: int | None = None
        expected_length: int | None = None
        status: int | None = None
        while True:
            if header_end is not None and expected_length is not None:
                if len(received) >= header_end + expected_length:
                    return status or 0, bytes(received[header_end : header_end + expected_length])
            if len(received) > MAX_RESPONSE_BYTES + 8192:
                raise VerificationError("model response exceeds the bounded proof limit")
            if header_end is None and len(received) > 8192:
                raise VerificationError("model response headers exceed the bounded proof limit")
            if header_end is None:
                marker = received.find(b"\r\n\r\n")
                if marker >= 0:
                    header_end = marker + 4
                    header_lines = bytes(received[:marker]).decode("iso-8859-1").split("\r\n")
                    status_fields = header_lines[0].split()
                    if len(status_fields) < 2 or not status_fields[0].startswith("HTTP/") or not status_fields[1].isdigit():
                        raise VerificationError("local model endpoint returned an invalid HTTP status line")
                    status = int(status_fields[1])
                    response_headers: dict[str, list[str]] = {}
                    for line in header_lines[1:]:
                        if ":" not in line:
                            raise VerificationError("local model endpoint returned invalid HTTP headers")
                        name, value = line.split(":", 1)
                        response_headers.setdefault(name.strip().lower(), []).append(value.strip())
                    if response_headers.get("transfer-encoding"):
                        raise VerificationError("chunked model responses are not accepted by the bounded probe")
                    lengths = response_headers.get("content-length", [])
                    if len(lengths) > 1 or (lengths and not lengths[0].isdigit()):
                        raise VerificationError("local model endpoint returned ambiguous response length")
                    if lengths:
                        expected_length = int(lengths[0])
                        if expected_length > MAX_RESPONSE_BYTES:
                            raise VerificationError("model response exceeds the bounded proof limit")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerificationError("local model probe exceeded its total deadline")
            readable, _, _ = select.select([sock], [], [], remaining)
            if not readable:
                raise VerificationError("local model probe exceeded its total deadline")
            chunk = sock.recv(8192)
            if not chunk:
                if header_end is None or status is None:
                    raise VerificationError("local model endpoint closed before returning a response")
                if expected_length is not None and len(received) < header_end + expected_length:
                    raise VerificationError("local model endpoint closed an incomplete response")
                return status, bytes(received[header_end:])
            received.extend(chunk)
    except (OSError, select.error) as exc:
        raise VerificationError("local model endpoint did not complete the bounded probe") from exc
    finally:
        sock.close()


def _expect_model_ready(host: str, port: int, api_key: str, deadline: float) -> None:
    status, body = _request_json(host, port, "/v1/models", api_key, None, deadline)
    if status != 200:
        raise VerificationError("managed model child is not ready")
    try:
        result = json.loads(body)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError("model readiness response was not valid JSON") from exc
    data = result.get("data") if isinstance(result, dict) else None
    if (
        not isinstance(data, list)
        or len(data) != 1
        or not isinstance(data[0], dict)
        or data[0].get("id") != MODEL_ID
    ):
        raise VerificationError("local endpoint did not expose exactly the approved model")


def probe_api_auth(
    host: str,
    port: int,
    api_key: str,
    total_deadline_seconds: float = AUTH_PROBE_TOTAL_DEADLINE_SECONDS,
) -> AuthProbeResult:
    """Prove two auth refusals and one bounded exact synthetic generation."""
    deadline = time.monotonic() + total_deadline_seconds
    wrong_key = secrets.token_urlsafe(48)
    while secrets.compare_digest(wrong_key, api_key):
        wrong_key = secrets.token_urlsafe(48)
    payload = json.dumps(
        {
            "model": MODEL_ID,
            "messages": [
                {
                    "role": "user",
                    "content": f"Return exactly {SENTINEL} and nothing else. Do not add commentary.",
                }
            ],
            "max_tokens": 16,
            "temperature": 0,
            "stream": False,
            "chat_template_kwargs": {"enable_thinking": False},
        },
        separators=(",", ":"),
    ).encode("utf-8")

    # Invalid empty bodies ensure rejected credentials cannot trigger inference.
    missing_status, _ = _request_json(host, port, "/v1/chat/completions", None, b"{}", deadline)
    if missing_status != 401:
        raise VerificationError("local model endpoint did not reject missing and wrong API keys")
    wrong_status, _ = _request_json(host, port, "/v1/chat/completions", wrong_key, b"{}", deadline)
    if wrong_status != 401:
        raise VerificationError("local model endpoint did not reject missing and wrong API keys")
    valid_status, valid_body = _request_json(host, port, "/v1/chat/completions", api_key, payload, deadline)
    if valid_status != 200:
        raise VerificationError("local model endpoint rejected the protected synthetic request")
    try:
        result = json.loads(valid_body)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError("protected synthetic request response was not valid JSON") from exc
    choices = result.get("choices") if isinstance(result, dict) else None
    if not isinstance(result, dict) or result.get("model") != MODEL_ID or not isinstance(choices, list) or len(choices) != 1:
        raise VerificationError("protected synthetic request response did not match the approved model")
    choice = choices[0]
    message = choice.get("message") if isinstance(choice, dict) else None
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise VerificationError("protected synthetic request did not return an assistant message")
    content = message.get("content")
    finish_reason = choice.get("finish_reason")
    if not isinstance(content, str) or content != SENTINEL or finish_reason != "stop":
        raise VerificationError("protected synthetic request did not complete the exact bounded sentinel")
    usage = result.get("usage")
    if not isinstance(usage, dict):
        raise VerificationError("protected synthetic request omitted token usage")
    tokens = [usage.get("prompt_tokens"), usage.get("completion_tokens"), usage.get("total_tokens")]
    if any(not isinstance(value, int) or isinstance(value, bool) or value <= 0 for value in tokens):
        raise VerificationError("protected synthetic request returned invalid token usage")
    prompt_tokens, completion_tokens, total_tokens = tokens
    if total_tokens != prompt_tokens + completion_tokens:
        raise VerificationError("protected synthetic request token usage is inconsistent")
    if time.monotonic() > deadline:
        raise VerificationError("local model probe exceeded its total deadline")
    return AuthProbeResult(
        missing_status=missing_status,
        wrong_status=wrong_status,
        valid_status=valid_status,
        response_model=MODEL_ID,
        response_text=content,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        finish_reason=finish_reason,
    )


def _atomic_private_write(path: Path, content: str) -> None:
    parent = path.parent
    _private_directory(parent)
    fd, temp_name = tempfile.mkstemp(prefix=".model-link-", dir=parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        os.chmod(path, 0o600)
    except OSError as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise VerificationError("protected proof record could not be written") from exc


def _proof_path(home: Path) -> Path:
    return home / ".config" / "scout-matepad-link" / "auth-proof.conf"


def _remove_proof(home: Path) -> None:
    proof_path = _proof_path(home)
    try:
        if proof_path.exists() and not proof_path.is_symlink():
            proof_path.unlink()
    except OSError:
        pass


def _assert_child_alive(child: subprocess.Popen[bytes], name: str) -> None:
    if child.poll() is not None:
        raise VerificationError(f"managed {name} child exited; session is stopped")


def _stop_child(child: subprocess.Popen[bytes] | None) -> None:
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            child.kill()
            child.wait(timeout=2)
        except (OSError, subprocess.SubprocessError):
            pass
    except (OSError, subprocess.SubprocessError):
        pass


def _write_proof(home: Path, snapshot: Snapshot, child: subprocess.Popen[bytes], result: AuthProbeResult) -> None:
    created = time.time()
    fields = {
        "format": "4",
        "created_epoch": f"{created:.3f}",
        "expires_epoch": f"{created + PROOF_TTL_SECONDS:.3f}",
        "scope": "managed-trusted-Termux-account-only",
        "kernel_socket_attestation": "false",
        "server_pid": str(child.pid),
        "server_sha256": snapshot.server_sha256,
        "model_sha256": snapshot.model_sha256,
        "api_key_sha256": snapshot.key_sha256,
        "ssh_sha256": snapshot.ssh_sha256,
        "ssh_key_sha256": snapshot.ssh_key_sha256,
        "known_hosts_sha256": snapshot.known_hosts_sha256,
        "model_id": MODEL_ID,
        "listener_target": f"127.0.0.1:{DEVICE_PORT}",
        "server_readiness_marker": SERVER_READY_MARKER,
        "missing_key_status": str(result.missing_status),
        "wrong_key_status": str(result.wrong_status),
        "protected_synthetic_status": str(result.valid_status),
        "response_model": result.response_model,
        "response_text": result.response_text,
        "finish_reason": result.finish_reason,
        "prompt_tokens": str(result.prompt_tokens),
        "completion_tokens": str(result.completion_tokens),
        "total_tokens": str(result.total_tokens),
        "inference_count": "1",
    }
    _atomic_private_write(_proof_path(home), "".join(f"{key}={value}\n" for key, value in fields.items()))


def _popen(argv: list[str], *, capture_output: bool = False) -> subprocess.Popen[bytes]:
    try:
        return subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture_output else subprocess.DEVNULL,
            stderr=subprocess.STDOUT if capture_output else subprocess.DEVNULL,
            bufsize=0,
            close_fds=True,
        )
    except OSError as exc:
        raise VerificationError("managed child could not be started") from exc


def _drain_server_output(server: ManagedServer) -> None:
    stream = server.process.stdout
    if stream is None:
        server.output_eof = True
        server.output_event.set()
        return
    buffered = bytearray()
    discarding_long_line = False
    try:
        while True:
            chunk = stream.readline(MAX_SERVER_LOG_LINE_BYTES + 1)
            if not chunk:
                server.output_eof = True
                server.output_event.set()
                return
            newline_terminated = chunk.endswith(b"\n")
            if discarding_long_line:
                if newline_terminated:
                    discarding_long_line = False
                continue
            if len(buffered) + len(chunk) > MAX_SERVER_LOG_LINE_BYTES:
                buffered.clear()
                discarding_long_line = not newline_terminated
                continue
            buffered.extend(chunk)
            if not newline_terminated:
                continue
            try:
                line = buffered.decode("utf-8").rstrip("\r\n")
            except UnicodeDecodeError:
                line = ""
            buffered.clear()
            if line == SERVER_READY_MARKER or line.startswith(SERVER_READY_MARKER + " - "):
                # Retain only the known-safe fixed marker, never arbitrary child logs.
                server.readiness_message = SERVER_READY_MARKER
                server.output_event.set()
    except (OSError, ValueError):
        server.output_eof = True
        server.output_event.set()


def _start_server(argv: list[str]) -> ManagedServer:
    process = _popen(argv, capture_output=True)
    if process.stdout is None:
        _stop_child(process)
        raise VerificationError("managed model child has no private readiness channel")
    server = ManagedServer(process=process)
    reader = threading.Thread(target=_drain_server_output, args=(server,), daemon=True)
    server.output_thread = reader
    reader.start()
    return server


def _wait_server_readiness(server: ManagedServer, deadline: float) -> None:
    while True:
        _assert_child_alive(server.process, "model server")
        if server.readiness_message == SERVER_READY_MARKER:
            return
        if server.output_eof:
            raise VerificationError("managed model child exited its private output without a readiness marker")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise VerificationError("managed model child did not emit its bounded readiness marker in time")
        server.output_event.wait(min(0.1, remaining))


def _stop_server(server: ManagedServer | None) -> None:
    if server is None:
        return
    _stop_child(server.process)
    if server.output_thread is not None:
        server.output_thread.join(timeout=1)
    if server.process.stdout is not None:
        try:
            server.process.stdout.close()
        except OSError:
            pass


def run_managed(home: Path, prefix: Path, *, sleep_fn=time.sleep) -> None:
    """Start one server and one fixed SSH child; stop both at drift or TTL."""
    _remove_proof(home)
    server: ManagedServer | None = None
    tunnel: subprocess.Popen[bytes] | None = None
    proof_written = False
    try:
        snapshot = _capture_snapshot(home, prefix)
        _validate_ssh_identity(snapshot)
        assert_port_free(DEVICE_PORT)
        api_key = _read_key(snapshot.key_path)
        if hashlib.sha256(snapshot.key_path.read_bytes()).hexdigest() != snapshot.key_sha256:
            raise VerificationError("model API key changed before server launch")
        server = _start_server(_server_argv(snapshot))
        ready_deadline = time.monotonic() + SERVER_START_TIMEOUT_SECONDS
        # An authenticated listener is not enough: the exact child started above
        # must first announce its fixed loopback bind over this private pipe.
        _wait_server_readiness(server, ready_deadline)
        while True:
            _assert_child_alive(server.process, "model server")
            _assert_snapshot(home, prefix, snapshot)
            try:
                _expect_model_ready("127.0.0.1", DEVICE_PORT, api_key, min(ready_deadline, time.monotonic() + HTTP_REQUEST_TIMEOUT_SECONDS))
                break
            except VerificationError:
                if time.monotonic() >= ready_deadline:
                    raise VerificationError("managed model child did not become ready within the bounded wait")
                sleep_fn(min(1.0, max(0.0, ready_deadline - time.monotonic())))

        _assert_child_alive(server.process, "model server")
        _assert_snapshot(home, prefix, snapshot)
        result = probe_api_auth("127.0.0.1", DEVICE_PORT, api_key)
        _assert_child_alive(server.process, "model server")
        _assert_snapshot(home, prefix, snapshot)
        proof_started = time.monotonic()
        _write_proof(home, snapshot, server.process, result)
        proof_written = True

        tunnel = _popen(_ssh_argv(snapshot))
        _assert_child_alive(server.process, "model server")
        _assert_child_alive(tunnel, "SSH tunnel")
        expires_at = proof_started + PROOF_TTL_SECONDS
        if time.monotonic() >= expires_at:
            raise VerificationError("synthetic auth proof expired before the managed tunnel became ready")
        next_health = time.monotonic() + HEALTH_INTERVAL_SECONDS
        while time.monotonic() < expires_at:
            _assert_child_alive(server.process, "model server")
            _assert_child_alive(tunnel, "SSH tunnel")
            _assert_snapshot(home, prefix, snapshot)
            if time.monotonic() >= next_health:
                _expect_model_ready(
                    "127.0.0.1",
                    DEVICE_PORT,
                    api_key,
                    time.monotonic() + HTTP_REQUEST_TIMEOUT_SECONDS,
                )
                _assert_child_alive(server.process, "model server")
                _assert_child_alive(tunnel, "SSH tunnel")
                next_health = time.monotonic() + HEALTH_INTERVAL_SECONDS
            sleep_fn(min(SUPERVISOR_POLL_SECONDS, max(0.0, expires_at - time.monotonic())))
        print("SCOUT_MODEL_LINK_SESSION_EXPIRED: managed children stopped; explicit requalification is required")
    except BaseException:
        if proof_written:
            _remove_proof(home)
        raise
    finally:
        # Only Popen objects created by this invocation are ever stopped.
        _stop_child(tunnel)
        _stop_server(server)


def main(argv: Iterable[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    home = Path(os.environ.get("HOME", ""))
    prefix = Path(os.environ.get("PREFIX", "/data/data/com.termux/files/usr"))
    if sys.version_info < (3, 10) or not home.is_absolute() or not prefix.is_absolute():
        print("SCOUT_MODEL_LINK_REFUSED: Python 3.10+ and absolute Termux paths are required", file=sys.stderr)
        return 2

    def stop_managed_run(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    for stop_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(stop_signal, stop_managed_run)
    try:
        if args == ["--check"]:
            snapshot = _capture_snapshot(home, prefix)
            _validate_ssh_identity(snapshot)
            assert_port_free(DEVICE_PORT)
            print("SCOUT_MODEL_LINK_PREFLIGHT_OK: no live auth proof or model request was performed")
            return 0
        if args == ["--run"]:
            run_managed(home, prefix)
            return 0
        print("SCOUT_MODEL_LINK_REFUSED: accepted only --check or --run", file=sys.stderr)
        return 2
    except (VerificationError, OSError, UnicodeError, ValueError, subprocess.SubprocessError) as exc:
        _remove_proof(home)
        reason = str(exc) if isinstance(exc, VerificationError) else "local identity or bounded process validation failed"
        print(f"SCOUT_MODEL_LINK_REFUSED: {reason}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        _remove_proof(home)
        print("SCOUT_MODEL_LINK_STOPPED: managed children were asked to stop", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
