# MatePad local-model link proposal

This is a source-only, fail-closed proposal for a narrowly bounded path:

```text
Scout on Linode -> 127.0.0.1:18088 -> SSH reverse forward -> MatePad 127.0.0.1:8081
```

Scout's selected local-model route would use `http://127.0.0.1:18088/v1` and
its existing protected `apiKeyFile`. The MatePad server must independently
enforce the same model key from a protected local key file. The SSH key and
model API key remain separate credentials. This source adds no Scout route,
identity, employee/customer access, conversation context, Odoo grant, DSH
behavior, scheduler, task execution, or automatic OpenRouter fallback. It
never replays an inference whose outcome is uncertain.

The installed MatePad runtime was read-only identified as the existing
`llama-server` binary with SHA-256
`6e8f34cac967060aa042a8bd2f65f06cf960c3c58063d0fb1876a3fc755e02b8`;
its version string is `0 (unknown)`. The profile and launcher pin that exact
binary hash and do not infer a release version from a different build. The
existing llama.cpp server documentation for the pinned source commit describes
`--api-key-file`, but only a future device qualification can prove that this
installed executable enforces it.

## Managed session and evidence

`matepad-link.sh --check` validates the fixed profile, protected files,
artifact hashes, SSH key, and out-of-band host-key pin, then refuses if the
local model endpoint is occupied or its state is unknown. It performs no
inference and creates no live proof.

`matepad-link.sh --run` hands control to one bounded Python supervisor. The
supervisor starts only its own pinned `llama-server` child, with fixed
`127.0.0.1:8081`, model, protected `--api-key-file`, one parallel slot, a
4096-token context, two inference threads, and no Web UI. It refuses to start
if a TCP connection to either IPv4 or available IPv6 loopback shows an existing
listener. It never kills or replaces an unknown or pre-existing process. The
free-port check and child launch have a small race; operation assumes the
Termux application account remains trusted during the managed run.

Readiness first requires the exact `Popen` child this run created to emit the
bounded private log line `main: server is listening on
http://127.0.0.1:8081`; the supervisor drains the child's output through a
private pipe and retains only that fixed marker. Only then does it require the
child to remain alive and an authenticated `/v1/models` request to report
exactly `Qwen3-0.6B`. A foreign listener that wins the free-port/launch race
cannot pass by answering the API checks if the owned child never emits its
readiness marker. Then the supervisor makes one protected synthetic inference, using the exact
`SCOUT_MATEPAD_LOCAL_OK` sentinel, `max_tokens: 16`, and
`chat_template_kwargs.enable_thinking: false`. It requires the exact assistant
text, approved model name, normal `stop` finish, and internally consistent
prompt/completion/total token usage. Before that inference, it requires empty
and random-wrong credentials to receive HTTP 401 on invalid empty request
bodies. The successful protected inference is the only model generation in
each run.

The supervisor then starts one fixed foreground reverse-SSH child and checks
both owned children, profile/artifact/key/host-pin digests, and authenticated
model readiness during the session. It stops only the children it created if
either child exits, any identity changes, the health check fails, or the
five-minute proof window expires. It never retries a generation or silently
restarts either child. The private `auth-proof.conf` records the bounded
synthetic result and its expiry; it is evidence only and is not a Scout route
authorization token. A route still requires the existing per-route consent and
model policy. A successful SSH child is not independent proof of the Linode
listener; host-side readback remains a future qualification step.

### Android trust boundary

The verified MatePad Android surface denies both `/proc/net` socket inspection
and `ss` netlink access. The supervisor therefore uses the trusted-device
account contract: it checks that loopback has no responding endpoint, launches
the approved binary itself with the exact fixed arguments, requires that
specific `Popen` child to emit the private bounded bind/readiness marker,
observes it remain alive, and validates the endpoint with the
missing/wrong/correct-key requests and synthetic inference. It also monitors
the child and the server/model/key/SSH/host-pin files for change.

This provides no kernel socket-inode attestation and does not protect against
malicious or compromised code running under the same Android UID. It does not
claim the endpoint is cryptographically bound to the child at the kernel
level. The SSH tunnel stays within the same trusted-account assumption. A
stronger isolation boundary would require a separately reviewed platform
capability, not an unsupported `/proc` or `ss` check.

The five-minute managed run is a qualification session, not an always-on
service. Do not adopt a startup manager, unattended restart policy, or
long-running tunnel until device thermals, memory, screen-off behavior, reboot
recovery, sustained request quality, connection revocation, and the runtime
trust boundary are separately qualified.

The supervisor requires Python 3.10 or newer; the current MatePad readback
reported Python 3.13.13. It does not install or update Python.

## Protected files and source scope

Keep the profile, SSH private key, model API key, pinned `known_hosts`, model,
and server binary in Termux app-private storage. The
`.config/scout-matepad-link` directory must be owned by the Termux app user
with mode `700`. Secret files must be regular files with owner-only
permissions. The host key must be pinned from an independent trusted readback;
the launcher neither runs `ssh-keyscan` nor accepts first-use trust.

The starter profile is not operational: model and host-pin values remain
placeholders. No key is generated and no service is started from this source
branch. The server binary hash is fixed to the verified device readback; a
binary update requires a new exact device readback and reviewed source change.

## Future Linode receiver boundary

The templates describe a dedicated `scout-matepad-forward` public-key account.
Never reuse root, Odoo, DSH, queue-tunnel, or other service keys. Give this
account no sudo, application/database credentials, writable Scout paths, or
shell purpose. Install one dedicated device public key with the
`authorized_keys` restrictions shown in the example.

The sshd template permits remote TCP forwarding only and exactly
`127.0.0.1:18088`, disables local-destination forwarding with `PermitOpen
none`, disallows TTY, shell/subsystem sessions (`MaxSessions 0`), agent/X11,
StreamLocal, tunnel, and user RC. Do not add global-only directives inside a
`Match` block. `GatewayPorts no` keeps the reverse listener private.
`PermitOpen none` does not constrain the destination inside a client-requested
`-R`; the trusted MatePad launcher fixes that target to `127.0.0.1:8081`, and
the device key must remain protected.

Do not install the `Match` example as an early drop-in. `Match` scopes later
settings until another `Match`; inspect the complete include order, stage and
validate the full candidate config, and compare `sshd -T -C` effective output
for the dedicated account and existing accounts before any reload. Any future
host operation needs a fresh exact host claim, a byte-identical preimage,
`sshd -t`, listener readback, positive/negative forwarding tests, and a
targeted rollback. Preserve unrelated settings and users.

## Future owner-controlled qualification

This branch does not create keys, configure the host/tablet, connect an SSH
tunnel, start/restart llama.cpp, alter Scout policy, or prove that the device
stays awake. Those steps require fresh owner-controlled claims for the shared
Linode SSH config and the MatePad process/startup path.

1. Under a fresh host claim, verify the current OpenSSH version/config/include
   order, create only the dedicated account and key, stage and validate the
   complete sshd config, compare effective settings for the dedicated and
   existing accounts, then apply the narrow reload and read back listeners.
2. Under a fresh MatePad claim, confirm the exact installed binary/model
   hashes, trusted account, available runtime, protected API key, and that the
   endpoint is unused. Run the managed five-minute proof. Never stop an
   unknown or pre-existing router; any cutover is a separately claimed future
   operation with an exact rollback.
3. Pin the Linode host key independently. Transfer a dedicated device public
   key and separate random model API key through approved protected paths; use
   existing per-route consent and model policy. Secrets never enter chat,
   Git, shell history, process arguments, logs, or fixtures.
4. Independently read back the Linode listener at `127.0.0.1:18088`, test
   expected forwarding and refusal cases, and confirm Scout uses the exact
   approved local route. Then test loss of device/network, screen-off, reboot,
   disconnect, and controlled revocation. No restart, request replay, or
   OpenRouter fallback is enabled by this source.

Revocation must remove only this account's marked public key/account access,
withdraw the existing Scout local route through its policy process, and rotate
the model API key if it may have been exposed. Stop only exact owner-verified
device children. If state or a model-call outcome is unknown, preserve it for
reconciliation.

The established physical-PC-off exercise remains deferred. This source and a
successful synthetic local request do not prove unattended persistence,
business-context authorization, DSH execution, or customer access.

## References

- [OpenSSH `sshd_config(5)`](https://man.openbsd.org/sshd_config):
  `AllowTcpForwarding`, `PermitListen`, `PermitOpen`, `MaxSessions`, and
  forwarding/session restrictions.
- [OpenSSH `ssh_config(5)`](https://man.openbsd.org/ssh_config): strict
  host-key checking, `ExitOnForwardFailure`, and bounded keepalives.
- [llama.cpp server README at b9590 (`d2462f8`)](https://github.com/ggml-org/llama.cpp/blob/d2462f8/tools/server/README.md):
  `--api-key-file`, bind/port/model alias, and resource flags. The installed
  MatePad binary still requires a future exact runtime test.
