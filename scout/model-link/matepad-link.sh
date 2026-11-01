#!/usr/bin/env bash
# Fixed-profile front end for the bounded MatePad model-link supervisor.
# It never starts/stops arbitrary processes and never sources local policy.
set -uo pipefail

TERMUX_PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
PROFILE_FILE="${HOME:-}/.config/scout-matepad-link/profile.conf"
CONFIG_DIR="${HOME:-}/.config/scout-matepad-link"
SSH_BIN="$TERMUX_PREFIX/bin/ssh"
SSH_KEYGEN="$TERMUX_PREFIX/bin/ssh-keygen"
SHA256_BIN="$TERMUX_PREFIX/bin/sha256sum"
STAT_BIN="$TERMUX_PREFIX/bin/stat"
MODEL_KEY_FILE="$CONFIG_DIR/model-api-key"
KNOWN_HOSTS_FILE="${HOME:-}/.ssh/scout-matepad-known_hosts"
SSH_KEY_FILE="${HOME:-}/.ssh/scout-matepad-link"
SERVER_BIN="$TERMUX_PREFIX/bin/llama-server"
PYTHON_BIN="$TERMUX_PREFIX/bin/python3"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
declare -A PROFILE=()

refuse() {
  printf 'SCOUT_MODEL_LINK_REFUSED: %s\n' "$1" >&2
  return 1
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

protected_private_directory() {
  local path="$1" mode owner uid
  [[ -d "$path" && ! -L "$path" ]] || return 1
  mode=$("$STAT_BIN" -c '%a' "$path" 2>/dev/null) || return 1
  owner=$("$STAT_BIN" -c '%u' "$path" 2>/dev/null) || return 1
  uid=$(id -u) || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ && "$owner" == "$uid" ]] || return 1
  (( (8#$mode & 077) == 0 ))
}

file_sha256() {
  local result
  result=$("$SHA256_BIN" "$1" 2>/dev/null) || return 1
  printf '%s' "${result%% *}"
}

load_profile() {
  local line key value seen=0
  PROFILE=()
  protected_private_directory "$CONFIG_DIR" || { refuse 'protected config directory is missing or unsafe'; return 1; }
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

  [[ "${PROFILE[model_file]}" == "${HOME}/models/Qwen3-0.6B"*.gguf ]] || { refuse 'model is outside the one-model allowlist'; return 1; }
  [[ "${PROFILE[model_sha256]}" =~ ^[a-f0-9]{64}$ \
    && "${PROFILE[llama_server_sha256]}" == '6e8f34cac967060aa042a8bd2f65f06cf960c3c58063d0fb1876a3fc755e02b8' ]] || { refuse 'model or approved server digest is absent or changed'; return 1; }
  [[ "${PROFILE[host_key_fingerprint]}" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || { refuse 'pinned host fingerprint is absent'; return 1; }
  [[ "$TERMUX_PREFIX" == /* && "$TERMUX_PREFIX" != *[!A-Za-z0-9._/-]* ]] || { refuse 'Termux executable root is unsafe'; return 1; }
  [[ -x "$SSH_BIN" && -x "$SSH_KEYGEN" && -x "$SHA256_BIN" && -x "$STAT_BIN" ]] || { refuse 'existing OpenSSH or core utilities are unavailable'; return 1; }
  [[ -x "$SERVER_BIN" && -x "$PYTHON_BIN" && -f "$SCRIPT_DIR/verify_auth.py" ]] || { refuse 'approved server or bounded supervisor is unavailable'; return 1; }
  command -v grep >/dev/null 2>&1 && command -v wc >/dev/null 2>&1 || { refuse 'required base shell utilities are unavailable'; return 1; }
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
}

main() {
  local action="${1:---check}"
  [[ $# -le 1 ]] || { refuse 'launcher accepts only --check or --run'; return 1; }
  case "$action" in
    --check|--run)
      load_profile || return 1
      "$PYTHON_BIN" "$SCRIPT_DIR/verify_auth.py" "$action"
      ;;
    *)
      refuse 'launcher accepts only --check or --run'
      return 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
