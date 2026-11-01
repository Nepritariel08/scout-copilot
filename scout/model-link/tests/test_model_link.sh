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
chmod 700 "$HOME/.config/scout-matepad-link" "$HOME/.ssh"

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
exit 0
STUB
cat > "$SSH_BIN" <<'STUB'
#!/bin/sh
printf 'unexpected direct ssh invocation\n' >> "$DIRECT_CALLS_FILE"
exit 10
STUB
cat > "$SERVER_BIN" <<'STUB'
#!/bin/sh
printf 'unexpected direct llama-server invocation\n' >> "$DIRECT_CALLS_FILE"
exit 11
STUB
cat > "$PYTHON_BIN" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$SUPERVISOR_CALLS_FILE"
exit "${SUPERVISOR_STATUS:-0}"
STUB
chmod 700 "$SSH_KEYGEN" "$SSH_BIN" "$SERVER_BIN" "$PYTHON_BIN"

file_sha256() {
  if [[ "$1" == "$SERVER_BIN" ]]; then
    printf '%s' '6e8f34cac967060aa042a8bd2f65f06cf960c3c58063d0fb1876a3fc755e02b8'
  else
    local result
    result=$("$SHA256_BIN" "$1") || return 1
    printf '%s' "${result%% *}"
  fi
}

printf '%s\n' 'test-only-not-a-real-private-key' > "$HOME/.ssh/scout-matepad-link"
printf '%s\n' 'test-only-not-a-real-model-api-key-32chars' > "$HOME/.config/scout-matepad-link/model-api-key"
printf '%s\n' 'scout-pilot-linode ssh-ed25519 TESTONLY-PUBLIC-KEY' > "$HOME/.ssh/scout-matepad-known_hosts"
printf '%s\n' 'synthetic model bytes, not a model' > "$HOME/models/Qwen3-0.6B-Q4_0.gguf"
chmod 600 "$HOME/.ssh/scout-matepad-link" "$HOME/.config/scout-matepad-link/model-api-key" "$HOME/.ssh/scout-matepad-known_hosts"

MODEL_HASH=$(file_sha256 "$HOME/models/Qwen3-0.6B-Q4_0.gguf")
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
llama_server_sha256=6e8f34cac967060aa042a8bd2f65f06cf960c3c58063d0fb1876a3fc755e02b8
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
replace_field linode_host 198.51.100.4
expect_refusal
replace_field linode_host 172.104.173.160
replace_field model_id openrouter/free
expect_refusal
replace_field model_id Qwen3-0.6B
replace_field device_target 0.0.0.0:8081
expect_refusal
replace_field device_target 127.0.0.1:8081
replace_field llama_server_sha256 0000000000000000000000000000000000000000000000000000000000000000
expect_refusal
replace_field llama_server_sha256 6e8f34cac967060aa042a8bd2f65f06cf960c3c58063d0fb1876a3fc755e02b8
printf 'fallback_provider=openrouter\n' >> "$PROFILE_FILE"
expect_refusal
sed -i '/^fallback_provider=/d' "$PROFILE_FILE"
chmod 600 "$PROFILE_FILE"

rm -f "$HOME/.config/scout-matepad-link/model-api-key"
expect_refusal
printf '%s\n' 'test-only-not-a-real-model-api-key-32chars' > "$HOME/.config/scout-matepad-link/model-api-key"
chmod 600 "$HOME/.config/scout-matepad-link/model-api-key"
chmod 644 "$HOME/.config/scout-matepad-link/model-api-key"
expect_refusal
chmod 600 "$HOME/.config/scout-matepad-link/model-api-key"
chmod 755 "$HOME/.config/scout-matepad-link"
expect_refusal
chmod 700 "$HOME/.config/scout-matepad-link"

export DIRECT_CALLS_FILE="$TEST_ROOT/direct-calls" SUPERVISOR_CALLS_FILE="$TEST_ROOT/supervisor-calls"
main --check
[[ "$(wc -l < "$SUPERVISOR_CALLS_FILE")" -eq 1 ]] || fail_test 'check did not call the supervisor exactly once'
[[ "$(cat "$SUPERVISOR_CALLS_FILE")" == *'verify_auth.py --check' ]] || fail_test 'check action changed'

export SUPERVISOR_STATUS=1
if main --run >/dev/null 2>&1; then fail_test 'failed managed run unexpectedly succeeded'; fi
[[ "$(wc -l < "$SUPERVISOR_CALLS_FILE")" -eq 2 ]] || fail_test 'run did not invoke the supervisor exactly once'
[[ "$(tail -n 1 "$SUPERVISOR_CALLS_FILE")" == *'verify_auth.py --run' ]] || fail_test 'run action changed'
[[ ! -e "$DIRECT_CALLS_FILE" ]] || fail_test 'shell launcher directly started a model server or SSH process'
if grep -Fq 'test-only-not-a-real-model-api-key' "$SUPERVISOR_CALLS_FILE"; then fail_test 'model API key leaked into supervisor argv'; fi

printf 'PASS: strict profile, artifact pin, protected file checks, and single managed-supervisor handoff\n'
