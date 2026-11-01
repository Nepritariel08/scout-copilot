#!/usr/bin/env python3
"""Prove the fixed local llama.cpp key boundary with one synthetic token call."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterable

MODEL_ID = "Qwen3-0.6B"
LLAMA_VERSION_LINE = "version: 9590 (`d2462f8`)"
REMOTE_HOST = "172.104.173.160"
DEVICE_PORT = 8081
PROOF_TTL_SECONDS = 300
MAX_RESPONSE_BYTES = 65536
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
        "linode_port": "22",
        "remote_user": "scout-matepad-forward",
        "remote_listen": "127.0.0.1:18088",
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
    if not re.fullmatch(r"[a-f0-9]{64}", profile["llama_server_sha256"]):
        raise VerificationError("server digest is missing")
    if _digest(model_path) != profile["model_sha256"]:
        raise VerificationError("model digest changed")
    _owned_regular_file(server_path)
    _owned_regular_file(model_path)
    if _digest(server_path) != profile["llama_server_sha256"]:
        raise VerificationError("server binary digest changed")
    try:
        version = subprocess.run(
            [str(server_path), "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise VerificationError("llama-server version cannot be verified") from exc
    if len(version.stdout) > 2048 or LLAMA_VERSION_LINE not in version.stdout.splitlines():
        raise VerificationError("llama-server is not the approved b9590 build")
    _private_file(key_path, max_bytes=512)
    key_bytes = key_path.read_bytes()
    key = key_bytes.removesuffix(b"\n").decode("ascii", errors="strict")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{32,512}", key):
        raise VerificationError("model API key is not one bounded key")
    return profile, model_path, server_path, key_path


def _key_value_file(path: Path, allowed: set[str], exact_count: int) -> dict[str, str]:
    _private_file(path)
    return _read_kv(path, allowed, exact_count)


def _proc_start_ticks(proc_root: Path, pid: int) -> str:
    try:
        value = (proc_root / str(pid) / "stat").read_text(encoding="ascii")
    except OSError as exc:
        raise VerificationError("the recorded model process is no longer available") from exc
    closing = value.rfind(")")
    fields = value[closing + 2 :].split() if closing >= 0 else []
    # Fields after comm start at proc field 3; starttime is field 22.
    if len(fields) <= 19 or not fields[19].isdigit():
        raise VerificationError("model process identity cannot be read")
    return fields[19]


def _cmdline(proc_root: Path, pid: int) -> list[str]:
    try:
        raw = (proc_root / str(pid) / "cmdline").read_bytes()
    except OSError as exc:
        raise VerificationError("model process arguments cannot be read") from exc
    return [item.decode("utf-8", errors="strict") for item in raw.split(b"\0") if item]


def _listener_inode(proc_root: Path) -> str:
    listeners: list[tuple[str, str, str]] = []
    for table in (proc_root / "net" / "tcp", proc_root / "net" / "tcp6"):
        try:
            rows = table.read_text(encoding="ascii").splitlines()[1:]
        except OSError as exc:
            raise VerificationError("local listener state cannot be read") from exc
        for row in rows:
            fields = row.split()
            if len(fields) < 10:
                raise VerificationError("local listener state is malformed")
            local_address, local_port = fields[1].split(":", 1)
            if local_port.upper() == f"{DEVICE_PORT:04X}" and fields[3] == "0A":
                proto = "tcp6" if table.name == "tcp6" else "tcp"
                listeners.append((proto, local_address.upper(), fields[9]))
    if len(listeners) != 1:
        raise VerificationError("the expected loopback model listener is not unique")
    proto, address, inode = listeners[0]
    if proto != "tcp" or address != "0100007F" or not inode.isdigit():
        raise VerificationError("model listener is not bound only to IPv4 loopback")
    return inode


def _check_live_process(
    home: Path,
    prefix: Path,
    proc_root: Path = Path("/proc"),
) -> tuple[dict[str, str], dict[str, str], Path, Path, Path]:
    profile, model_path, server_path, key_path = _profile(home, prefix)
    identity_path = home / ".config" / "scout-matepad-link" / "server-identity.conf"
    identity = _key_value_file(
        identity_path,
        {"format", "pid", "start_ticks", "server_sha256", "model_sha256", "key_sha256"},
        6,
    )
    if identity.get("format") != "1" or not identity.get("pid", "").isdigit():
        raise VerificationError("server identity record is invalid")
    pid = int(identity["pid"])
    if _proc_start_ticks(proc_root, pid) != identity["start_ticks"]:
        raise VerificationError("model process identity has changed")
    expected_key_hash = _digest(key_path)
    expected_identity = {
        "server_sha256": profile["llama_server_sha256"],
        "model_sha256": profile["model_sha256"],
        "key_sha256": expected_key_hash,
    }
    if any(identity.get(key) != value for key, value in expected_identity.items()):
        raise VerificationError("server launch identity does not match protected artifacts")
    try:
        executable = os.path.realpath(proc_root / str(pid) / "exe")
    except OSError as exc:
        raise VerificationError("model process executable cannot be read") from exc
    if executable != os.path.realpath(server_path):
        raise VerificationError("the recorded process is not the approved llama-server")
    expected_argv = [
        str(server_path),
        "--model",
        str(model_path),
        "--alias",
        MODEL_ID,
        "--host",
        "127.0.0.1",
        "--port",
        str(DEVICE_PORT),
        "--api-key-file",
        str(key_path),
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
    if _cmdline(proc_root, pid) != expected_argv:
        raise VerificationError("model process arguments do not match the fixed profile")
    inode = _listener_inode(proc_root)
    try:
        descriptors = os.listdir(proc_root / str(pid) / "fd")
        owns_listener = any(
            os.readlink(proc_root / str(pid) / "fd" / descriptor) == f"socket:[{inode}]"
            for descriptor in descriptors
        )
    except OSError as exc:
        raise VerificationError("model listener ownership cannot be verified") from exc
    if not owns_listener:
        raise VerificationError("the approved process does not own the local model listener")
    return profile, identity, model_path, server_path, key_path


def _read_key(path: Path) -> str:
    info = _private_file(path, max_bytes=512)
    del info
    raw = path.read_bytes()
    value = raw.removesuffix(b"\n").decode("ascii", errors="strict")
    if not re.fullmatch(r"[A-Za-z0-9._~-]{32,512}", value):
        raise VerificationError("model API key is not one bounded key")
    return value


def probe_api_auth(host: str, port: int, api_key: str) -> tuple[int, int, int, str]:
    """Use two rejected requests and one one-token synthetic inference."""
    wrong_key = secrets.token_urlsafe(48)
    while secrets.compare_digest(wrong_key, api_key):
        wrong_key = secrets.token_urlsafe(48)
    payload = json.dumps(
        {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "Reply with one token: OK"}],
            "max_tokens": 1,
            "temperature": 0,
            "stream": False,
        },
        separators=(",", ":"),
    ).encode("utf-8")

    def request(bearer: str | None, body: bytes) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection(host, port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if bearer is not None:
            headers["Authorization"] = f"Bearer {bearer}"
        try:
            connection.request("POST", "/v1/chat/completions", body=body, headers=headers)
            response = connection.getresponse()
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise VerificationError("model response exceeds the bounded proof limit")
            return response.status, body
        except (OSError, http.client.HTTPException) as exc:
            raise VerificationError("local model endpoint did not complete the bounded probe") from exc
        finally:
            connection.close()

    # Deliberately invalid payloads ensure a server without auth cannot perform
    # an inference during either rejection check.
    missing_status, _ = request(None, b"{}")
    if missing_status != 401:
        raise VerificationError("local model endpoint did not reject missing and wrong API keys")
    wrong_status, _ = request(wrong_key, b"{}")
    if wrong_status != 401:
        raise VerificationError("local model endpoint did not reject missing and wrong API keys")
    valid_status, valid_body = request(api_key, payload)
    if valid_status != 200:
        raise VerificationError("local model endpoint rejected the protected synthetic request")
    try:
        result = json.loads(valid_body)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError("protected synthetic request response was not valid JSON") from exc
    choices = result.get("choices") if isinstance(result, dict) else None
    if not isinstance(result, dict) or result.get("model") != MODEL_ID or not isinstance(choices, list) or not choices:
        raise VerificationError("protected synthetic request response did not match the approved model")
    first_choice = choices[0]
    if not isinstance(first_choice, dict) or not isinstance(first_choice.get("message"), dict):
        raise VerificationError("protected synthetic request response was incomplete")
    return missing_status, wrong_status, valid_status, MODEL_ID


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


def _remove_old_proof(home: Path) -> None:
    proof_path = home / ".config" / "scout-matepad-link" / "auth-proof.conf"
    try:
        if proof_path.exists() and not proof_path.is_symlink():
            proof_path.unlink()
    except OSError:
        pass


def record_server(home: Path, prefix: Path, proc_root: Path = Path("/proc")) -> None:
    profile, model_path, server_path, key_path = _profile(home, prefix)
    del model_path, server_path
    pid = os.getppid()
    args = _cmdline(proc_root, pid)
    if not args or args[-1] != "--serve" or not any(arg.endswith("matepad-link.sh") for arg in args):
        raise VerificationError("server launch identity must be recorded by the trusted --serve action")
    start_ticks = _proc_start_ticks(proc_root, pid)
    identity = {
        "format": "1",
        "pid": str(pid),
        "start_ticks": start_ticks,
        "server_sha256": profile["llama_server_sha256"],
        "model_sha256": profile["model_sha256"],
        "key_sha256": _digest(key_path),
    }
    path = home / ".config" / "scout-matepad-link" / "server-identity.conf"
    _atomic_private_write(path, "".join(f"{key}={value}\n" for key, value in identity.items()))
    _remove_old_proof(home)


def verify(home: Path, prefix: Path, proc_root: Path = Path("/proc")) -> None:
    _remove_old_proof(home)
    profile, identity, model_path, server_path, key_path = _check_live_process(home, prefix, proc_root)
    del model_path, server_path
    api_key = _read_key(key_path)
    missing_status, wrong_status, valid_status, response_model = probe_api_auth(
        "127.0.0.1", DEVICE_PORT, api_key
    )
    # Detect process replacement or key rotation during the network probe.
    profile_after, identity_after, _, _, key_path_after = _check_live_process(home, prefix, proc_root)
    if identity_after != identity or profile_after != profile or _digest(key_path_after) != identity["key_sha256"]:
        raise VerificationError("server or key identity changed during auth verification")
    created = int(time.time())
    proof = {
        "format": "2",
        "created_epoch": str(created),
        "expires_epoch": str(created + PROOF_TTL_SECONDS),
        "model_id": MODEL_ID,
        "server_pid": identity["pid"],
        "process_start_ticks": identity["start_ticks"],
        "server_sha256": profile["llama_server_sha256"],
        "model_sha256": profile["model_sha256"],
        "api_key_file": str(key_path),
        "api_key_sha256": identity["key_sha256"],
        "listener": "127.0.0.1:8081",
        "missing_key_status": str(missing_status),
        "wrong_key_status": str(wrong_status),
        "protected_synthetic_status": str(valid_status),
        "response_model": response_model,
        "inference_count": "1",
    }
    proof_path = home / ".config" / "scout-matepad-link" / "auth-proof.conf"
    _atomic_private_write(proof_path, "".join(f"{key}={value}\n" for key, value in proof.items()))


def main(argv: Iterable[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    home = Path(os.environ.get("HOME", ""))
    prefix = Path(os.environ.get("PREFIX", "/data/data/com.termux/files/usr"))
    if sys.version_info < (3, 9) or not home.is_absolute() or not prefix.is_absolute():
        print("SCOUT_MODEL_AUTH_REFUSED: Python 3.9+ and absolute Termux paths are required", file=sys.stderr)
        return 2
    try:
        if args == ["--record-server"]:
            record_server(home, prefix)
            print("SCOUT_MODEL_SERVER_IDENTITY_RECORDED")
            return 0
        if args == ["--verify"]:
            verify(home, prefix)
            print("SCOUT_MODEL_AUTH_PROOF_OK: protected synthetic request passed; proof expires in 300 seconds")
            return 0
        print("SCOUT_MODEL_AUTH_REFUSED: accepted only --record-server or --verify", file=sys.stderr)
        return 2
    except (VerificationError, OSError, UnicodeError, ValueError) as exc:
        _remove_old_proof(home)
        if isinstance(exc, VerificationError):
            reason = str(exc)
        else:
            reason = "local identity or response validation failed"
        print(f"SCOUT_MODEL_AUTH_REFUSED: {reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
