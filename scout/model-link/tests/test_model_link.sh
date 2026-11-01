#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/scout-model-link-test.XXXXXX")
cleanup() {
  case "$TEST_ROOT" in
    /tmp/scout-model-link-test.*) rm -rf -- "$TEST_ROOT" ;;
    *) printf 'refusing unexpected test cleanup path\n' >&2; return 1 ;;
  esac
}
trap cleanup EXIT

export HOME="$TEST_ROOT/home"
export PREFIX="$TEST_ROOT/termux"
mkdir -p "$HOME/.config/scout-matepad-link" "$HOME/.ssh" "$HOME/models" "$PREFIX/bin"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$SCRIPT_DIR/matepad-link.sh"
STAT_BIN=$(command -v stat)
SHA256_BIN=$(command -v sha256sum)
SSH_KEYGEN="$PREFIX/bin/ssh-keygen"
SSH_BIN="$PREFIX/bin/ssh"
SERVER_BIN="$PREFIX/bin/llama-server"
PYTHON_BIN="$PREFIX/bin/python3"

fail_test() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
expect_refusal() {
  if load_profile "$@" 2>/dev/null; then fail_test "expected profile refusal ($*)"; fi
}

cat > "$SSH_KEYGEN" <<'STUB'
#!/bin/sh
case "$1" in
  -y) exit 0 ;;
  -F) grep -q "^$2 ssh-ed25519 " "$4" || exit 1
      printf '# Host scout-pilot-linode found: line 1\nscout-pilot-linode ssh-ed25519 TESTONLY-PUBLIC-KEY\n' ;;
  -lf) grep -q '^scout-pilot-linode ssh-ed25519 ' "$2" || exit 1
       printf '256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA known-host (ED25519)\n' ;;
  *) exit 2 ;;
esac
STUB
cat > "$SERVER_BIN" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  printf 'version: 9590 (`d2462f8`)\nbuilt for synthetic tests\n'
  exit 0
fi
printf 'invoked\n' >> "$SERVER_CALLS_FILE"
exit 0
STUB
cat > "$SSH_BIN" <<'STUB'
#!/bin/sh
printf 'call\n' >> "$CALLS_FILE"
printf '%s\n' "$@" > "$ARGS_FILE"
exit 23
STUB
cat > "$PYTHON_BIN" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$VERIFY_CALLS_FILE"
exit "${VERIFY_STATUS:-0}"
STUB
chmod 700 "$SSH_KEYGEN" "$SERVER_BIN" "$SSH_BIN" "$PYTHON_BIN"

printf '%s\n' 'test-only-not-a-real-private-key' > "$SSH_KEY_FILE"
printf '%s\n' 'test-only-not-a-real-model-api-key-32chars' > "$MODEL_KEY_FILE"
printf '%s\n' 'scout-pilot-linode ssh-ed25519 TESTONLY-PUBLIC-KEY' > "$KNOWN_HOSTS_FILE"
printf '%s\n' 'synthetic model bytes, not a model' > "$HOME/models/Qwen3-0.6B-Q4_0.gguf"
chmod 600 "$SSH_KEY_FILE" "$MODEL_KEY_FILE" "$KNOWN_HOSTS_FILE"

MODEL_HASH=$(file_sha256 "$HOME/models/Qwen3-0.6B-Q4_0.gguf")
SERVER_HASH=$(file_sha256 "$SERVER_BIN")
cat > "$PROFILE_FILE" <<EOF
format=1
linode_host=172.104.173.160
linode_port=22
remote_user=scout-matepad-forward
remote_listen=127.0.0.1:18088
device_target=127.0.0.1:8081
model_id=Qwen3-0.6B
model_file=$HOME/models/Qwen3-0.6B-Q4_0.gguf
model_sha256=$MODEL_HASH
llama_server_sha256=$SERVER_HASH
host_key_fingerprint=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
EOF
chmod 600 "$PROFILE_FILE"

replace_field() {
  local field="$1" value="$2" tmp="$PROFILE_FILE.tmp" line
  while IFS= read -r line; do
    if [[ "${line%%=*}" == "$field" ]]; then printf '%s=%s\n' "$field" "$value"; else printf '%s\n' "$line"; fi
  done < "$PROFILE_FILE" > "$tmp"
  mv "$tmp" "$PROFILE_FILE"
  chmod 600 "$PROFILE_FILE"
}

load_profile
build_ssh_args
[[ "${SSH_ARGS[*]}" == *'-F /dev/null'* && "${SSH_ARGS[*]}" == *'-N -T'* ]] || fail_test 'fixed no-config, no-session SSH mode absent'
[[ "${SSH_ARGS[*]}" == *'127.0.0.1:18088:127.0.0.1:8081'* ]] || fail_test 'reverse-forward target changed'
[[ "${SSH_ARGS[*]}" == *'scout-matepad-forward@172.104.173.160'* ]] || fail_test 'remote account/host changed'
[[ "${SSH_ARGS[*]}" != *'test-only-not-a-real-model-api-key'* ]] || fail_test 'model API key appeared in SSH argv'

replace_field linode_host 198.51.100.4
expect_refusal
replace_field linode_host 172.104.173.160
replace_field model_id openrouter/free
expect_refusal
replace_field model_id Qwen3-0.6B
replace_field device_target 0.0.0.0:8081
expect_refusal
replace_field device_target 127.0.0.1:8081
printf 'fallback_provider=openrouter\n' >> "$PROFILE_FILE"
expect_refusal
sed -i '/^fallback_provider=/d' "$PROFILE_FILE"
chmod 600 "$PROFILE_FILE"

rm -f "$MODEL_KEY_FILE"
expect_refusal
printf '%s\n' 'test-only-not-a-real-model-api-key-32chars' > "$MODEL_KEY_FILE"
chmod 600 "$MODEL_KEY_FILE"
rm -f "$SSH_KEY_FILE"
expect_refusal
printf '%s\n' 'test-only-not-a-real-private-key' > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
chmod 644 "$MODEL_KEY_FILE"
expect_refusal
chmod 600 "$MODEL_KEY_FILE"

replace_field host_key_fingerprint SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
expect_refusal
replace_field host_key_fingerprint SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
mv "$KNOWN_HOSTS_FILE" "$KNOWN_HOSTS_FILE.saved"
expect_refusal
mv "$KNOWN_HOSTS_FILE.saved" "$KNOWN_HOSTS_FILE"
chmod 600 "$KNOWN_HOSTS_FILE"

load_profile
build_server_args
[[ "${SERVER_ARGS[*]}" == *'--host 127.0.0.1 --port 8081'* ]] || fail_test 'model server did not bind loopback only'
[[ "${SERVER_ARGS[*]}" == *'--api-key-file '*"$MODEL_KEY_FILE"* ]] || fail_test 'model server does not enforce the protected key file'
[[ "${SERVER_ARGS[*]}" == *'--parallel 1 --ctx-size 4096 --threads 2 --threads-batch 2'* ]] || fail_test 'bounded resource defaults changed'
[[ "${SERVER_ARGS[*]}" != *'test-only-not-a-real-model-api-key-32chars'* ]] || fail_test 'model API key appeared in llama-server argv'

PROC="$TEST_ROOT/proc"
mkdir -p "$PROC"
printf '  sl local_address rem_address st\n' > "$PROC/tcp"
printf '  sl local_address rem_address st\n' > "$PROC/tcp6"
if port_8081_state "$PROC"; then fail_test 'free synthetic port was identified as occupied'; else [[ $? -eq 1 ]] || fail_test 'free synthetic port state was not distinguished'; fi
printf '  0: 0100007F:1F91 00000000:0000 0A\n' >> "$PROC/tcp"
if port_8081_state "$PROC"; then :; else fail_test 'occupied synthetic port was not identified'; fi
if port_8081_state "$TEST_ROOT/missing-proc" 2>/dev/null; then fail_test 'unknown port state was accepted'; else [[ $? -eq 2 ]] || fail_test 'unknown port state was not fail-closed'; fi

export SERVER_CALLS_FILE="$TEST_ROOT/server-calls"
port_8081_state() { return 0; }
if main --serve >/dev/null 2>&1; then fail_test 'occupied local port allowed a server replacement'; fi
[[ ! -e "$SERVER_CALLS_FILE" ]] || fail_test 'occupied-port refusal started another server'
port_8081_state() { return 2; }
if main --serve >/dev/null 2>&1; then fail_test 'unknown local port state allowed server start'; fi
[[ ! -e "$SERVER_CALLS_FILE" ]] || fail_test 'unknown-port refusal started a server'

export CALLS_FILE="$TEST_ROOT/calls" ARGS_FILE="$TEST_ROOT/args"
export VERIFY_CALLS_FILE="$TEST_ROOT/verify-calls" VERIFY_STATUS=1
if main --link >/dev/null 2>&1; then fail_test 'failed live auth verifier allowed the model link'; fi
[[ ! -e "$CALLS_FILE" ]] || fail_test 'SSH started despite failed live auth verification'
[[ "$(wc -l < "$VERIFY_CALLS_FILE")" -eq 1 ]] || fail_test 'link did not run exactly one bounded verifier'
VERIFY_STATUS=0
if main --link >/dev/null 2>&1; then fail_test 'simulated SSH failure unexpectedly succeeded'; else [[ $? -eq 23 ]] || fail_test 'SSH failure status was not preserved'; fi
[[ "$(wc -l < "$CALLS_FILE")" -eq 1 ]] || fail_test 'unknown SSH outcome was automatically replayed'
[[ "$(wc -l < "$VERIFY_CALLS_FILE")" -eq 2 ]] || fail_test 'link did not re-run live auth verification'
if grep -Fq 'test-only-not-a-real-model-api-key' "$ARGS_FILE"; then fail_test 'model API key leaked into SSH process arguments'; fi

printf 'PASS: strict target, key, host-pin, live-auth gate, model allowlist, loopback bind, refusal and no-replay cases\n'
