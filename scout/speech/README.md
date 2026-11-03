# Owned push-to-talk and playback (disabled until qualification)

This source extends the public MIT app and its owned history. It does not recreate
licensed Intelligence, enable realtime OpenAI/xAI voice, add a chat model, or start
a second job scheduler. The normal approved chat route, model consent/limits,
source grants and owned PostgreSQL history remain authoritative.

The flow is Record -> Stop -> local transcript -> editable composer -> explicit
Send -> existing approved chat -> Play latest saved answer. Text is saved only
when the user sends the normal message. Audio is not archived. Transcription and
speech synthesis have no chat inference or hidden summary call.

## Owned application configuration

Speech stays off unless the operator sets `SCOUT_SPEECH_CONFIG_FILE` to an
absolute protected file after qualifying the separate CPU service. Its schema is:

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:18083/v1",
  "tokenFile": "/etc/scout-pilot/speech-token"
}
```

The owned composition mounts only POST `/api/audio/transcriptions` and POST
`/api/audio/speech`; other auxiliary routes retain their refusal. The browser
receives `transcription` and `speechPlayback` availability, while realtime
`voice` stays false and the unsupported voice archive stays disabled. Speech
middleware is scoped to the audio namespace and uses the application's configured
origins, including HTTPS behind the loopback reverse proxy.

The composer mounts one 30-second recording/playback control, keyed to the native
user and channel, and suppresses the legacy microphone. Stop appends a transcript
to the editable draft; only the user's explicit Send invokes the normal chat
route. Send is blocked during recording/transcription, and navigation, identity
changes and cancellation discard late transcripts. Playback sends saved message
IDs only; the server determines eligibility rather than accepting client text.

TTS reads current authorized saved history and original completion events before
and after synthesis. It only speaks the latest assistant text, no tool calls,
at most 2,000 characters. The server derives the run ID; no caller/provider text
is trusted. The event scan is bounded at 2,048 events, so start a new chat when
an older long conversation exceeds this pilot limit. Current native membership,
tenant/channel and Odoo context/release checks apply through the existing bound
history authority. Routine source proof renewal must preserve that contract.

## Local CPU service

`service.py` uses stdlib HTTP on 127.0.0.1 only, a server-only protected token and
one separately spawned native process at a time. Only the two fixed speech paths
exist. No cloud fallback, generic proxy, UI, model download/upload API, diarization,
Piper, realtime model or GPU extra is included. Install the five direct CPU pins
from `requirements.txt` in an isolated Python 3.12.14 environment. These direct pins were checked
against PyPI; they are not a complete hashed transitive/wheel lock or a measured
runtime qualification. Produce that lock/SBOM for the exact Linux/Windows target
before activation, including codec/eSpeak dependency licenses.

Place the six pinned files listed in `models.json` below a protected models root.
No downloader is supplied. The operator must obtain and hash the exact inventory
in the runtime lane, protect all file/parent ownership from the service account,
and record its receipt. Startup checks every SHA256 and the five package versions;
missing/mismatched files refuse startup. HF offline/telemetry-disabled settings,
explicit local paths and CPU execution prevent implicit provider/model downloads.

The service requires an explicit `--enable-qualified-runtime` switch and otherwise
refuses to start. Example after qualification (paths are examples, no credentials):

```sh
python service.py --enable-qualified-runtime --models-root /opt/scout-speech/models \
  --token-file /etc/scout-speech/service-token --temporary-root /run/scout-speech-private --port 18083
```

The token file must be absolute, regular, non-symlink and private on POSIX. Share
its protected value only with Scout's server process. Never deliver it to the
browser. Configure private filesystem ownership and Windows ACLs separately.
Both backend and browser-facing endpoints refuse redirects/CORS exposure.

Runtime limits are 30 seconds of decoded mono 16 kHz audio, 2 MiB upload,
16 KiB transcript, 2,000 TTS characters, 90 seconds mono 24 kHz PCM WAV output and
60 seconds native execution. The Scout backend deadline is 70 seconds. Native
work is never released merely because a client disconnected: timeout/cancellation
must reap the actual worker before its slot is released. Raw audio/PCM is bounded
memory only, no temporary audio file; the HTTP parent accepts one body at a time.
The service suppresses native stdout/stderr and never logs content or credentials.
This is not a zero-write claim for native dependencies: phonemizer/eSpeak may
create phoneme text and extract its native library. Each job receives a private
child directory under the required protected temporary root; TMPDIR/TEMP/TMP and
cache paths are directed there before native imports. Remove it only after both
worker and receiver are reaped; retain a poisoned job's files for operator recovery.
The complete IPC frame and normal child exit share one absolute native deadline;
bounded terminate/kill/receiver cleanup follows it. If the OS cannot reap a child
or its receiver, the runner retains its slot and permanently refuses new jobs
until an operator restarts the qualified service. It never claims successful
bounded termination in that condition.

An operator must also apply a dedicated unprivileged account, read-only runtime
and model files, no external network egress, private bounded temporary/cache paths,
process/task/CPU and memory limits, and no inherited audio-bearing diagnostics.
Benchmark before choosing the actual memory cgroup; neither these source checks
nor package sizes establish peak RAM or Community performance. Kill/reap behavior
must be measured under that cgroup. Do not increase Linode size without evidence.

## Acceptance still required

Source contracts use synthetic data and fake native workers, no model downloads,
audio capture or external inference:

```sh
python -B -m unittest -v test_service.py
```

Also run the focused Bun owned-voice/dictation tests, server/app type checks and
Biome checks. Actual CPU decoding/STT/TTS, English/Filipino recognition quality,
the exact model/voice combination and deadline/resource usage are unproven until
the independent runtime lane qualifies them. Kokoro's fixed `af_heart`/`en-us`
voice is an English pilot; do not claim Filipino speech output support.

On Windows and the actual Huawei browser, verify HTTPS microphone permission,
available WebM/MP4 codec, Stop/Cancel, transcript review, one paid text call,
saved answer, Play/Stop, reload/identity switch, foreground/background and denied
permission. Audible playback can need a second tap; the component retains the
prepared audio for that tap. No background/wake-word listening or speech-to-action
authority is added. The recording/answer stays on owned infrastructure; the user
still explicitly sends transcript text through the approved model route.

## Public source provenance and licenses

Checked 2026-11-03. Model checksums below are upstream metadata/small tokenizer
artifact verification, not evidence that the actual large weights were installed.

- [faster-whisper 1.2.1 metadata](https://pypi.org/pypi/faster-whisper/1.2.1/json)
  and [MIT runtime source](https://github.com/SYSTRAN/faster-whisper).
- [Kokoro ONNX 0.6.1 metadata](https://pypi.org/pypi/kokoro-onnx/0.6.1/json)
  and [MIT runtime source](https://github.com/thewh1teagle/kokoro-onnx).
  Its source distribution SHA256 is
  `7bbdb66dd53775f71088a99999a9aefdad240740daf54cb09410d8bb1e294e35`;
  the actual pinned source API (`from_session`, CPU session, `create`) was read.
- [Whisper tiny MIT model](https://huggingface.co/Systran/faster-whisper-tiny),
  exact revision `d90ca5fe260221311c53c58e660288d3deb8d356`.
  `model.bin` hash comes from its official LFS metadata; small config, tokenizer
  and vocabulary files were read and hashed in memory.
- [Kokoro upstream Apache-2.0 weights](https://huggingface.co/hexgrad/Kokoro-82M)
  and [exact ONNX/voice release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1).
  The two hashes in `models.json` come from GitHub's release asset digests.
- [PyAV metadata](https://pypi.org/pypi/av/19.0.2/json),
  [ONNX Runtime metadata](https://pypi.org/pypi/onnxruntime/1.31.1/json),
  [NumPy metadata](https://pypi.org/pypi/numpy/2.5.4/json).
  Preserve each packaged dependency/model's notices; do not describe the entire
  binary speech stack as MIT merely because the app/adapters are MIT.
