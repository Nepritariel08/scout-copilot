# MatePad local-model link proposal

This folder is a source-only, fail-closed proposal for one path:

```text
Scout on Linode -> 127.0.0.1:18088 -> SSH reverse forward -> MatePad 127.0.0.1:8081
```

The Scout local-model route would use `http://127.0.0.1:18088/v1` with a
protected `apiKeyFile`. The MatePad server must independently enforce that
same model API key from its own protected key file. The SSH key and model API
key are separate credentials. This adds no Scout route, identity, employee or
customer access, conversation context, Odoo grant, DSH behavior, scheduler, or
task execution. It must not add automatic OpenRouter fallback or replay an
uncertain model call.

The current source already allows an explicitly protected local route, but its
`apiKeyFile` is optional. A client sending a bearer key does not prove that the
local server checks it. `verify_auth.py` is a bounded verifier invoked by both
`--check` and `--link`; the link refuses unless the verifier matches the live
process, listener, model, server binary, and protected key file, then confirms
that missing and wrong keys receive 401 and a synthetic one-token request with
the correct key succeeds as the approved model. It writes a private proof that
expires after five minutes. `--link` runs the verifier again each time, so a
handwritten success flag or stale proof cannot authorize the connection. The
proof records only file and process identity plus response statuses; it never
prints request/response content or credentials. It verifies the exact
``version: 9590 (`d2462f8`)`` build line. The official `llama.cpp` build b9590
(`d2462f8`) documents `--api-key-file`; the future device owner must still
verify the actual installed binary and live behavior. A model-list endpoint is
not an auth proof. Termux Python 3.9 or newer is a verifier prerequisite; if it
is absent, the launcher refuses, and this source does not install it.

## What the launchers enforce

`matepad-link.sh --link` accepts no arbitrary host, port, model, SSH command,
or shell instructions. It parses a strict key/value profile without sourcing
it, rejects extra and duplicate fields, pins the remote host/user/listen
address/device destination/model, checks protected local files and SHA-256
digests, verifies the out-of-band OpenSSH host-key fingerprint, and runs the
live API-auth verifier before opening a link. It calls one foreground `ssh` process with
`-F /dev/null`, `-N`, `-T`, strict host-key checking, public-key-only
authentication, no agent/X11/command/session, one fixed `-R`, a ten-second
connect timeout, `ExitOnForwardFailure`, and bounded keepalives. It does not
retry: a timeout, disconnect, or unknown outcome must be reconciled before an
owner starts it again.

`matepad-link.sh --serve` is a separate explicit action. It starts the existing
`llama-server` binary only if `/proc/net/tcp` and `/proc/net/tcp6` prove port
8081 is free. If the port is occupied or state is unreadable, it refuses; it
never kills, signals, restarts, or replaces an unknown router. Its fixed
arguments bind only to `127.0.0.1`, select the one allowlisted Qwen3 0.6B model,
enforce `--api-key-file`, disable the Web UI, and cap the initial profile at one
parallel slot, a 4096-token context, and two inference threads. Those resource
values are conservative starting limits, not device qualification or an
always-on guarantee. The owner must measure memory, heat, screen-off behavior,
reboot recovery, and actual request quality on the MatePad before adopting them.

The profile, SSH private key, model API key, pinned `known_hosts` file, model,
server binary, server identity, and auth proof must live in Termux app-private
storage. The `.config/scout-matepad-link` directory must be owned by the
Termux app user with mode `700`. Key files are checked for regular-file status,
ownership, and no group/world permissions; key contents never appear in
command arguments or output. The
known-host entry must be supplied from an independently verified host-key
fingerprint. The launcher does not run `ssh-keyscan` or accept a first-use key.

The starter profile is deliberately unusable: it has placeholder hashes.
Generate no key and start no service from this source branch. A later exact
device work item must record the real model/binary hashes, host-key pin, and
protected-file paths. If any target or model changes, update and review the
source instead of editing around the fixed assertions.

## Future Linode receiver boundary

The templates show a dedicated `scout-matepad-forward` public-key account.
Never reuse root, Odoo, DSH, queue-tunnel, or other service keys. Give this
account no sudo, application/database credentials, writable Scout paths, or
shell purpose. Install one dedicated device public key with the
`authorized_keys` restrictions shown in the example.

The sshd profile permits remote TCP forwarding only and exactly
`127.0.0.1:18088`, disables local-destination forwarding with `PermitOpen none`,
disallows TTY, shell/subsystem sessions (`MaxSessions 0`), agent/X11,
StreamLocal, tunnel, user RC and user environment, and uses public-key auth
only. `GatewayPorts no` keeps the reverse listener private. OpenSSH documents
that `PermitListen` controls the remote bind address/port and `MaxSessions 0`
still permits forwarding. `PermitOpen none` does not limit the destination
inside a client-requested `-R`; the trusted MatePad launcher fixes that target
to `127.0.0.1:8081`, and the device key must remain protected.

Do not install the `Match` example as an early drop-in. `Match` scopes later
configuration until another `Match`; inspect the complete include order, stage
and validate the full candidate, and compare `sshd -T -C` effective output for
the dedicated account and existing accounts before any reload. On the exact
Linode, first prove the listener is bound only to loopback and verify that
unrelated SSH users retain their previous effective settings. Test a valid
forward and refusals for another listen port/address, local forwarding,
shell/exec/SFTP, wrong database/other TCP destinations, and public listener
reachability. A successful SSH login alone is not sufficient.

## Later owner-controlled qualification

The source branch does not create keys, configure the host/tablet, connect an
SSH tunnel, start/restart llama.cpp, alter a Scout policy, or prove the device
is always on. Those actions require fresh owner-controlled claims for the
shared Linode SSH configuration and the MatePad process/startup path.

1. Under a fresh host claim, verify the current OpenSSH version/config/include
   order, create only the dedicated account and key, stage the full sshd
   config, run `sshd -t`, compare effective settings for the dedicated and
   existing accounts, then apply the narrowly scoped reload and read back
   listeners. Keep a byte-identical preimage and targeted rollback.
2. Under a fresh MatePad claim, identify the exact installed signer, binary,
   model artifact and startup manager. Confirm the original process and active
   slots before cutover. If 8081 is occupied, stop only the exact verified
   process with owner control; otherwise use the launcher's refusal. The
   verifier proves loopback bind, 401 rejection for missing/wrong keys, and a
   successful one-token synthetic request with the protected key. Then verify
   `/v1/models` returns only `Qwen3-0.6B`. No public model endpoint is opened.
3. Pin the Linode host key through an independent trusted readback. Create a
   dedicated device SSH key and separate random model API key inside protected
   storage. Transfer the model key to the existing protected Scout deployment
   through its approved secret path, then use the existing per-route consent
   and model policy. The source key never appears in chat, Git, shell history,
   process arguments, logs, or fixtures.
4. Connect once and read back both ends: the Linode listener is only
   `127.0.0.1:18088`; the device server is only `127.0.0.1:8081`; unauthenticated
   inference is refused; the authorized key works; and Scout's selected local
   route returns the exact model. Then test loss of device/network, screen-off,
   reboot, disconnect, and controlled revocation. No automatic restart or
   request replay is accepted until separately designed and tested.

Revocation removes only this account's marked public key / account access,
withdraws the existing Scout local route through its policy process, and
rotates the model API key if it may have been exposed. Stop only the exact
owner-verified device tunnel/server process. If process state or a model call
outcome is unknown, preserve the current state for reconciliation; do not kill
an unknown PID, retry a call, or fall back to OpenRouter automatically.

The established physical-PC-off exercise remains deferred. A protected
reverse-SSH connection and one successful local-model request do not prove
unattended persistence, business-context authorization, DSH execution, or
customer access.

## References

- [OpenSSH `sshd_config(5)`](https://man.openbsd.org/sshd_config): `AllowTcpForwarding`, `PermitListen`, `PermitOpen`, `MaxSessions`, and user/session restrictions.
- [OpenSSH `ssh_config(5)`](https://man.openbsd.org/ssh_config): strict host-key checking, `ExitOnForwardFailure`, and bounded server-alive settings.
- [llama.cpp server README at b9590 (`d2462f8`)](https://github.com/ggml-org/llama.cpp/blob/d2462f8/tools/server/README.md): `--api-key-file`, bind/port/model alias and resource flags. The installed MatePad binary still requires exact readback.
