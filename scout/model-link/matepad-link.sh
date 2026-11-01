#!/usr/bin/env bash
# Bounded, fixed-target Termux launcher for the approved MatePad -> Linode
# reverse SSH model link. No profile file is sourced or evaluated.
set -uo pipefail

TERMUX_PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
PROFILE_FILE="${HOME:-}/.config/scout-matepad-link/profile.conf"
SSH_BIN="$TERMUX_PREFIX/bin/ssh"
SSH_KEYGEN="$TERMUX_PREFIX/bin/ssh-keygen"
SHA256_BIN="$TERMUX_PREFIX/bin/sha256sum"
STAT_BIN="$TERMUX_PREFIX/bin/stat"
MODEL_KEY_FILE="${HOME:-}/.config/scout-matepad-link/model-api-key"
KNOWN_HOSTS_FILE="${HOME:-}/.ssh/scout-matepad-known_hosts"
SSH_KEY_FILE="${HOME:-}/.ssh/scout-matepad-link"
SERVER_BIN="$TERMUX_PREFIX/bin/llama-server"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PYTHON_BIN="$TERMUX_PREFIX/bin/python3"
declare -A PROFILE=()
SSH_ARGS=()
SERVER_ARGS=()

refuse() {
  printf 'SCOUT_MODEL_LINK_REFUSED: %s\n' "$1" >&2
  return 1
}

is_safe_path_value() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "$1" != *"/../"* && "$1" != */.. ]]
}

protected_regular_file() {
  local path="$1" mode owner size uid
  [[ -f "$path" && ! -L "$path" ]] || return 1
  mode=$("$STAT_BIN" -c '%a' "$path" 2>/dev/null) || return 1
  owner=$("$STAT_BIN" -c '%u' "$path" 2>/dev/null) || return 1
  size=$("$STAT_BIN" -c '%s' "$path" 2>/dev/null) || return 1
  uid=$(id -u) || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ && "$owner" == "$uid" ]] || return 1
  [[ "$size" =~ ^[0-9]+$ ]] && (( size <= 16384 )) || return 1
  (( (8#$mode & 077) == 0 )) || return 1
}

file_sha256() {
  local result
  result=$("$SHA256_BIN" "$1" 2>/dev/null) || return 1
  printf '%s' "${result%% *}"
}

load_profile() {
  local line key value seen=0
  PROFILE=()
  protected_regular_file "$PROFILE_FILE" || { refuse 'profile missing, linked, foreign-owned, or not private'; return 1; }

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || { refuse 'profile syntax invalid'; return 1; }
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[a-z0-9_]+$ && -n "$value" ]] || { refuse 'profile syntax invalid'; return 1; }
    case "$key" in
      format|linode_host|linode_port|remote_user|remote_listen|device_target|model_id|model_file|model_sha256|llama_server_sha256|host_key_fingerprint) ;;
      *) refuse 'profile has an unknown field'; return 1 ;;
    esac
    [[ -z "${PROFILE[$key]+present}" ]] || { refuse 'profile has a duplicate field'; return 1; }
    PROFILE[$key]="$value"
    ((seen += 1))
  done < "$PROFILE_FILE"

  [[ "$seen" -eq 11 ]] || { refuse 'profile is incomplete'; return 1; }
  [[ "${PROFILE[format]}" == '1' \
    && "${PROFILE[linode_host]}" == '172.104.173.160' \
    && "${PROFILE[linode_port]}" == '22' \
    && "${PROFILE[remote_user]}" == 'scout-matepad-forward' \
    && "${PROFILE[remote_listen]}" == '127.0.0.1:18088' \
    && "${PROFILE[device_target]}" == '127.0.0.1:8081' \
    && "${PROFILE[model_id]}" == 'Qwen3-0.6B' ]] || { refuse 'profile target or model drifted'; return 1; }

  is_safe_path_value "${PROFILE[model_file]}" || { refuse 'model path is unsafe'; return 1; }
  [[ "${PROFILE[model_file]}" == "${HOME}/models/Qwen3-0.6B"*.gguf ]] || { refuse 'model is outside the one-model allowlist'; return 1; }
  [[ "${PROFILE[model_sha256]}" =~ ^[a-f0-9]{64}$ && "${PROFILE[llama_server_sha256]}" =~ ^[a-f0-9]{64}$ ]] || { refuse 'model/server digest is absent'; return 1; }
  [[ "${PROFILE[host_key_fingerprint]}" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || { refuse 'pinned host fingerprint is absent'; return 1; }
  [[ "$TERMUX_PREFIX" == /* && "$TERMUX_PREFIX" != *[!A-Za-z0-9._/-]* ]] || { refuse 'Termux executable root is unsafe'; return 1; }
  [[ -x "$SSH_BIN" && -x "$SSH_KEYGEN" && -x "$SHA256_BIN" && -x "$STAT_BIN" ]] || { refuse 'existing OpenSSH or core utilities are unavailable'; return 1; }
  command -v grep >/dev/null 2>&1 && command -v wc >/dev/null 2>&1 || { refuse 'required base shell utilities are unavailable'; return 1; }
  [[ -x "$SERVER_BIN" ]] || { refuse 'approved llama-server binary is unavailable'; return 1; }
  [[ "$(file_sha256 "$SERVER_BIN")" == "${PROFILE[llama_server_sha256]}" ]] || { refuse 'llama-server binary digest changed'; return 1; }
  [[ -f "${PROFILE[model_file]}" && ! -L "${PROFILE[model_file]}" ]] || { refuse 'approved model file is missing or linked'; return 1; }
  [[ "$(file_sha256 "${PROFILE[model_file]}")" == "${PROFILE[model_sha256]}" ]] || { refuse 'model file digest changed'; return 1; }

  protected_regular_file "$SSH_KEY_FILE" || { refuse 'SSH private key missing or not private'; return 1; }
  protected_regular_file "$MODEL_KEY_FILE" || { refuse 'model API key missing or not private'; return 1; }
  protected_regular_file "$KNOWN_HOSTS_FILE" || { refuse 'pinned known-hosts file missing or not private'; return 1; }
  local key_size key_lines
  key_size=$("$STAT_BIN" -c '%s' "$MODEL_KEY_FILE" 2>/dev/null) || { refuse 'model API key size cannot be checked'; return 1; }
  key_lines=$(wc -l < "$MODEL_KEY_FILE") || { refuse 'model API key file cannot be checked'; return 1; }
  [[ "$key_size" =~ ^[0-9]+$ && "$key_lines" =~ ^[0-1]$ ]] && (( key_size >= 32 && key_size <= 512 )) \
    && LC_ALL=C grep -Eq '^[A-Za-z0-9._~-]{32,512}$' "$MODEL_KEY_FILE" || { refuse 'model API key file is not one bounded key'; return 1; }
  "$SSH_KEYGEN" -y -P '' -f "$SSH_KEY_FILE" >/dev/null 2>&1 || { refuse 'SSH key is unreadable or needs interaction'; return 1; }

  local host_entry fingerprint_line actual_fingerprint
  host_entry=$("$SSH_KEYGEN" -F 'scout-pilot-linode' -f "$KNOWN_HOSTS_FILE" 2>/dev/null) || { refuse 'strict out-of-band host pin not found'; return 1; }
  [[ "$(printf '%s\n' "$host_entry" | awk 'NF && $1 !~ /^#/ {n++} END {print n+0}')" == '1' ]] || { refuse 'host pin is ambiguous'; return 1; }
  [[ "$(printf '%s\n' "$host_entry" | awk 'NF && $1 !~ /^#/ {print $1, $2}')" == 'scout-pilot-linode ssh-ed25519' ]] || { refuse 'host pin alias or key type drifted'; return 1; }
  fingerprint_line=$("$SSH_KEYGEN" -lf "$KNOWN_HOSTS_FILE" -E sha256 2>/dev/null) || { refuse 'host pin cannot be fingerprinted'; return 1; }
  actual_fingerprint=$(printf '%s\n' "$fingerprint_line" | awk 'NF {print $2}')
  [[ "$(printf '%s\n' "$fingerprint_line" | awk 'NF {n++} END {print n+0}')" == '1' && "$actual_fingerprint" == "${PROFILE[host_key_fingerprint]}" ]] || { refuse 'known-host key differs from out-of-band pin'; return 1; }
}

verify_local_auth() {
  [[ -x "$PYTHON_BIN" && -f "$SCRIPT_DIR/verify_auth.py" ]] || { refuse 'bounded local API-auth verifier is unavailable'; return 1; }
  "$PYTHON_BIN" "$SCRIPT_DIR/verify_auth.py" --verify
}

build_ssh_args() {
  SSH_ARGS=(
    -F /dev/null
    -N -T
    -p 22
    -i "$SSH_KEY_FILE"
    -o BatchMode=yes
    -o PreferredAuthentications=publickey
    -o PubkeyAuthentication=yes
    -o IdentitiesOnly=yes
    -o IdentityAgent=none
    -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
    -o GlobalKnownHostsFile=/dev/null
    -o HostKeyAlias=scout-pilot-linode
    -o HostKeyAlgorithms=ssh-ed25519
    -o CanonicalizeHostname=no
    -o ProxyCommand=none
    -o ProxyJump=none
    -o PermitLocalCommand=no
    -o ForwardAgent=no
    -o ForwardX11=no
    -o RequestTTY=no
    -o ConnectTimeout=10
    -o ConnectionAttempts=1
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=3
    -R 127.0.0.1:18088:127.0.0.1:8081
    scout-matepad-forward@172.104.173.160
  )
}

build_server_args() {
  SERVER_ARGS=(
    --model "${PROFILE[model_file]}"
    --alias Qwen3-0.6B
    --host 127.0.0.1
    --port 8081
    --api-key-file "$MODEL_KEY_FILE"
    --parallel 1
    --ctx-size 4096
    --threads 2
    --threads-batch 2
    --no-cont-batching
    --no-ui
  )
}

port_8081_state() {
  local proc_root="${1:-/proc/net}" file result found=0
  [[ -r "$proc_root/tcp" && -r "$proc_root/tcp6" ]] || return 2
  command -v awk >/dev/null 2>&1 || return 2
  for file in "$proc_root/tcp" "$proc_root/tcp6"; do
    result=$(awk 'NR > 1 { split($2, a, ":"); if (toupper(a[2]) == "1F91" && $4 == "0A") found=1 } END { exit found ? 0 : 1 }' "$file" 2>/dev/null)
    local status=$?
    [[ "$status" -le 1 ]] || return 2
    if [[ "$status" -eq 0 ]]; then found=1; fi
  done
  (( found == 1 )) && return 0
  return 1
}

run_link_once() {
  build_ssh_args
  "$SSH_BIN" "${SSH_ARGS[@]}"
}

main() {
  local action="${1:---link}"
  [[ $# -le 1 ]] || { refuse 'launcher accepts only --link, --serve, or --check'; return 1; }
  case "$action" in
    --link)
      load_profile || return 1
      verify_local_auth || return 1
      run_link_once
      ;;
    --check)
      load_profile && verify_local_auth && printf 'SCOUT_MODEL_LINK_PREFLIGHT_OK\n'
      ;;
    --serve)
      load_profile || return 1
      local port_state
      if port_8081_state; then
        refuse 'port 8081 is already listening; do not stop or replace an unknown process'
        return 1
      else
        port_state=$?
      fi
      [[ "$port_state" -eq 1 ]] || { refuse 'cannot prove the local model port is free'; return 1; }
      [[ -x "$PYTHON_BIN" && -f "$SCRIPT_DIR/verify_auth.py" ]] || { refuse 'bounded local API-auth verifier is unavailable'; return 1; }
      "$PYTHON_BIN" "$SCRIPT_DIR/verify_auth.py" --record-server || return 1
      build_server_args
      exec "$SERVER_BIN" "${SERVER_ARGS[@]}"
      ;;
    *)
      refuse 'launcher accepts only --link, --serve, or --check'
      return 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
