"""Owner-only loopback speech. No chat, downloads, audio files, or transcription logs.

The HTTP parent uses only stdlib. Each native job has a separately killable process;
its one global slot is released only after that process is confirmed dead.
"""

import argparse
import hashlib
import hmac
import io
import importlib.metadata
import json
import logging
import multiprocessing
import os
import re
import shutil
import socket
import struct
import tempfile
import threading
import time
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAX_UPLOAD = 2 * 1024 * 1024
MAX_REQUEST = MAX_UPLOAD + 65536
MAX_TRANSCRIPT = 16384
MAX_TEXT = 2000
MAX_SECONDS = 30
MAX_SPEECH_SECONDS = 90
MAX_AUDIO = 4_320_044
TIMEOUT = 60
STT_MODEL = "Systran/faster-whisper-tiny"
TTS_MODEL = "kokoro-v1.0"
VOICE = "af_heart"


class SpeechError(Exception):
    """Only these fixed, data-free error codes may cross the worker boundary."""


def verify_models(root, manifest=None):
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise SpeechError("MODELS_UNQUALIFIED")
    manifest = manifest or json.loads(Path(__file__).with_name("models.json").read_text())
    for name, expected in manifest["files"].items():
        path = root / name
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise SpeechError("MODELS_UNQUALIFIED")
        if not path.is_file() or root.resolve() not in path.resolve().parents:
            raise SpeechError("MODELS_UNQUALIFIED")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        if not hmac.compare_digest(digest.hexdigest(), expected):
            raise SpeechError("MODELS_UNQUALIFIED")


def transcript_payload(content_type, raw):
    if len(raw) > MAX_REQUEST or "\r" in content_type or "\n" in content_type:
        raise SpeechError("INPUT_INVALID")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
    )
    if message.get_content_type() != "multipart/form-data" or not message.is_multipart():
        raise SpeechError("INPUT_INVALID")
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if part.get_content_disposition() != "form-data" or name not in ("file", "model") or name in fields:
            raise SpeechError("INPUT_INVALID")
        fields[name] = part.get_payload(decode=True)
        if name == "file" and part.get_content_type() not in ("audio/webm", "audio/mp4", "audio/wav"):
            raise SpeechError("INPUT_INVALID")
    if set(fields) != {"file", "model"} or fields["model"] != STT_MODEL.encode():
        raise SpeechError("INPUT_INVALID")
    if not fields["file"] or len(fields["file"]) > MAX_UPLOAD:
        raise SpeechError("INPUT_INVALID")
    return fields["file"]


def speech_payload(raw):
    if len(raw) > 16384:
        raise SpeechError("INPUT_INVALID")
    try:
        value = json.loads(raw)
    except (UnicodeError, ValueError):
        raise SpeechError("INPUT_INVALID") from None
    if not isinstance(value, dict) or set(value) != {"input", "model", "voice", "response_format"}:
        raise SpeechError("INPUT_INVALID")
    if value["model"] != TTS_MODEL or value["voice"] != VOICE or value["response_format"] != "wav":
        raise SpeechError("INPUT_INVALID")
    text = value["input"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise SpeechError("INPUT_INVALID")
    return text


def bounded_pcm(frames, resample):
    """Count actual decoded/resampled samples; never trust a container duration tag."""
    chunks = []
    samples = 0
    count = 0
    for frame in frames:
        count += 1
        if count > 10000 or frame.samples > 192000 or frame.sample_rate > 192000:
            raise SpeechError("AUDIO_LIMIT")
        for decoded in resample(frame):
            samples += decoded.samples
            if samples > 16000 * MAX_SECONDS:
                raise SpeechError("AUDIO_LIMIT")
            chunks.append(decoded.to_ndarray().tobytes())
    for decoded in resample(None):
        samples += decoded.samples
        if samples > 16000 * MAX_SECONDS:
            raise SpeechError("AUDIO_LIMIT")
        chunks.append(decoded.to_ndarray().tobytes())
    if samples == 0:
        raise SpeechError("AUDIO_EMPTY")
    return b"".join(chunks)


def encode_wav(samples, sample_rate):
    import numpy as np

    samples = np.asarray(samples)
    if samples.ndim != 1 or sample_rate != 24000 or not np.isfinite(samples).all():
        raise SpeechError("SPEECH_OUTPUT_INVALID")
    if not 0 < len(samples) <= sample_rate * MAX_SPEECH_SECONDS:
        raise SpeechError("SPEECH_OUTPUT_LIMIT")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(pcm)
    return output.getvalue()


def native_job(kind, payload, root):
    # These imports occur only inside the bounded native child, never in the HTTP parent.
    import numpy as np

    if kind == "stt":
        import av
        from faster_whisper import WhisperModel

        # Custom memory I/O only. A forged playlist cannot fetch network or local-file URLs.
        with av.open(io.BytesIO(payload), mode="r", options={"protocol_whitelist": "pipe"}) as container:
            if not set(container.format.name.split(",")) & {"matroska", "webm", "mov", "mp4", "m4a", "wav"}:
                raise SpeechError("INPUT_INVALID")
            if len(container.streams.audio) != 1 or len(container.streams.video):
                raise SpeechError("INPUT_INVALID")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            pcm = bounded_pcm(container.decode(audio=0), resampler.resample)
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        model = WhisperModel(str(Path(root) / "whisper-tiny"), device="cpu", compute_type="int8",
                             cpu_threads=1, num_workers=1, local_files_only=True)
        segments, _ = model.transcribe(audio, beam_size=1, vad_filter=False,
                                       condition_on_previous_text=False)
        text = ""
        for segment in segments:
            text += segment.text
            if len(text.encode("utf-8")) > MAX_TRANSCRIPT:
                raise SpeechError("SPEECH_OUTPUT_LIMIT")
        return json.dumps({"text": text.strip()}, ensure_ascii=False).encode("utf-8")
    if kind == "tts":
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(Path(root) / "kokoro-v1.0.onnx"),
                                       sess_options=options, providers=["CPUExecutionProvider"])
        model = Kokoro.from_session(session, str(Path(root) / "voices-v1.0.bin"))
        samples, rate = model.create(payload, voice=VOICE, speed=1.0, lang="en-us")
        return encode_wav(samples, rate)
    raise SpeechError("INPUT_INVALID")


def worker(connection, kind, payload, root, target, temporary_directory=None):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1")
    if temporary_directory:
        os.environ.update(TMPDIR=temporary_directory, TMP=temporary_directory, TEMP=temporary_directory,
                          XDG_CACHE_HOME=str(Path(temporary_directory) / "cache"))
        tempfile.tempdir = temporary_directory
    logging.disable(logging.CRITICAL)
    # Native libraries must not emit transcripts, prompts or filesystem details to service logs.
    with open(os.devnull, "w") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
        try:
            result = target(kind, payload, root)
            if not isinstance(result, bytes) or len(result) > MAX_AUDIO:
                raise SpeechError("SPEECH_OUTPUT_LIMIT")
            send_packet(connection, b"1" + result)
        except BaseException:
            send_packet(connection, b"0SPEECH_UNAVAILABLE")
        finally:
            connection.close()


def send_packet(connection, body):
    connection.sendall(struct.pack("!I", len(body)) + body)


def receive_packet(connection, deadline):
    def exact(size):
        chunks = []
        while size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SpeechError("SPEECH_TIMEOUT")
            connection.settimeout(remaining)
            value = connection.recv(min(size, 65536))
            if not value:
                raise SpeechError("SPEECH_UNAVAILABLE")
            chunks.append(value)
            size -= len(value)
        return b"".join(chunks)
    size = struct.unpack("!I", exact(4))[0]
    if not 0 < size <= MAX_AUDIO + 1:
        raise SpeechError("SPEECH_UNAVAILABLE")
    return exact(size)


class JobRunner:
    def __init__(self, root, timeout=TIMEOUT, target=native_job, worker_target=worker, temporary_root=None):
        self.root = str(root)
        self.timeout = timeout
        self.target = target
        self.worker_target = worker_target
        self.slot = threading.Lock()
        self.poisoned = False
        self.quarantined = None
        self.temporary_root = Path(temporary_root) if temporary_root is not None else None

    def run(self, kind, payload):
        if self.poisoned:
            raise SpeechError("SPEECH_UNAVAILABLE")
        if self.target is native_job and self.temporary_root is None:
            raise SpeechError("SPEECH_UNAVAILABLE")
        if not self.slot.acquire(blocking=False):
            raise SpeechError("SPEECH_BUSY")
        temporary_directory = None
        if self.temporary_root is not None:
            try:
                verify_private_directory(self.temporary_root)
                temporary_directory = tempfile.mkdtemp(prefix="job-", dir=self.temporary_root)
            except Exception:
                self.slot.release()
                raise SpeechError("SPEECH_UNAVAILABLE") from None
        context = multiprocessing.get_context("spawn")
        reader, writer = socket.socketpair()
        process = context.Process(target=self.worker_target, args=(writer, kind, payload, self.root, self.target, temporary_directory), daemon=True)
        received = threading.Event()
        result_holder = []
        deadline = time.monotonic() + self.timeout
        def receive():
            try:
                result_holder.append(receive_packet(reader, deadline))
            except BaseException:
                result_holder.append(b"0SPEECH_UNAVAILABLE")
            finally:
                received.set()
        receiver = threading.Thread(target=receive, daemon=True)
        try:
            process.start()
            writer.close()
            receiver.start()
            if not received.wait(max(0, deadline - time.monotonic())):
                raise SpeechError("SPEECH_TIMEOUT")
            if time.monotonic() >= deadline:
                raise SpeechError("SPEECH_TIMEOUT")
            result = result_holder[0]
            if not result.startswith(b"1"):
                raise SpeechError("SPEECH_UNAVAILABLE")
            process.join(max(0, deadline - time.monotonic()))
            if process.is_alive():
                raise SpeechError("SPEECH_TIMEOUT")
            return result[1:]
        except (EOFError, OSError):
            raise SpeechError("SPEECH_UNAVAILABLE") from None
        finally:
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                    process.join(1)
                if process.is_alive():
                    process.kill()
                    process.join(1)
            writer.close()
            # Interrupt a partial frame reader too; include its termination in the release condition.
            try:
                reader.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            if receiver.ident is not None:
                receiver.join(1)
            worker_alive = process.pid is not None and process.is_alive()
            if worker_alive or receiver.is_alive():
                self.poisoned = True
                self.quarantined = (process, reader, receiver, temporary_directory)
                # Keep the slot locked: OS failure to reap never becomes permission for another job.
            else:
                if process.pid is not None:
                    process.close()
                reader.close()
                if temporary_directory:
                    path = Path(temporary_directory)
                    if path.is_symlink() or path.resolve().parent != self.temporary_root.resolve():
                        self.poisoned = True
                        raise SpeechError("SPEECH_UNAVAILABLE")
                    try:
                        shutil.rmtree(path)
                    except OSError:
                        self.poisoned = True
                        raise SpeechError("SPEECH_UNAVAILABLE") from None
                self.slot.release()


def handler_for(token, runner):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, _format, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def reply(self, status, body, content_type="application/json"):
            try:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (OSError, socket.timeout):
                pass

        def do_POST(self):
            authorization = self.headers.get_all("Authorization", [])
            if len(authorization) != 1 or not hmac.compare_digest(authorization[0], "Bearer " + token):
                return self.reply(403, b'{"code":"SPEECH_ACCESS_DENIED"}')
            if self.path not in ("/v1/audio/transcriptions", "/v1/audio/speech"):
                return self.reply(404, b'{"code":"NOT_FOUND"}')
            try:
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,8}", lengths[0]) or self.headers.get("Transfer-Encoding"):
                    raise SpeechError("INPUT_INVALID")
                size = int(lengths[0])
                if not 0 < size <= MAX_REQUEST:
                    raise SpeechError("INPUT_INVALID")
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise SpeechError("INPUT_INVALID")
                if self.path.endswith("transcriptions"):
                    payload = transcript_payload(self.headers.get("Content-Type", ""), raw)
                    kind, content_type = "stt", "application/json"
                else:
                    if self.headers.get("Content-Type") != "application/json":
                        raise SpeechError("INPUT_INVALID")
                    payload = speech_payload(raw)
                    kind, content_type = "tts", "audio/wav"
                output = runner.run(kind, payload)
                self.reply(200, output, content_type)
            except SpeechError as error:
                code = str(error)
                status = 429 if code == "SPEECH_BUSY" else 400 if code == "INPUT_INVALID" else 503
                self.reply(status, json.dumps({"code": code}).encode())
            except Exception:
                self.reply(503, b'{"code":"SPEECH_UNAVAILABLE"}')

    return Handler


def verify_private_directory(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_dir() or any(p.is_symlink() for p in (path, *path.parents)):
        raise SpeechError("CONFIG_INVALID")
    if os.name != "nt" and path.stat().st_mode & 0o077:
        raise SpeechError("CONFIG_INVALID")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable-qualified-runtime", action="store_true")
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--temporary-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18083)
    args = parser.parse_args()
    if not args.enable_qualified_runtime:
        parser.error("Runtime is disabled until CPU artifact/weights/device qualification is recorded.")
    if not 1024 <= args.port <= 65535:
        parser.error("Invalid loopback port.")
    try:
        if not args.token_file.is_absolute() or not args.token_file.is_file() or any(p.is_symlink() for p in (args.token_file, *args.token_file.parents)):
            raise SpeechError("CONFIG_INVALID")
        if os.name != "nt" and args.token_file.stat().st_mode & 0o077:
            raise SpeechError("CONFIG_INVALID")
        token = args.token_file.read_text().strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token):
            raise SpeechError("CONFIG_INVALID")
        verify_models(args.models_root)
        verify_private_directory(args.temporary_root)
        for package, version in {
            "faster-whisper": "1.2.1", "kokoro-onnx": "0.6.1", "onnxruntime": "1.31.1",
            "av": "19.0.2", "numpy": "2.5.4",
        }.items():
            if importlib.metadata.version(package) != version:
                raise SpeechError("RUNTIME_UNQUALIFIED")
    except Exception:
        parser.error("Protected token or pinned model inventory is unavailable/unqualified.")
    # One request body in memory at a time; Scout returns concurrent requests busy immediately.
    HTTPServer(("127.0.0.1", args.port), handler_for(token, JobRunner(args.models_root, temporary_root=args.temporary_root))).serve_forever()


if __name__ == "__main__":
    main()
