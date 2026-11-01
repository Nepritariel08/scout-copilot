# Scout private pilot on the existing Community Linode

Prepared 2026-11-01. **Review packet only: no installation, reservation, claim,
credential migration, proxy change or deployment has been executed by this file.**
The primary record is [SSC AI Enablement #4](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4#issuecomment-6547459663),
under [architecture #8](https://github.com/Nepritariel08/ssc-ai-enablement/issues/8).
Use [ENTERPRISE-ARCHITECTURE.md](ENTERPRISE-ARCHITECTURE.md),
[OWNED-RUNTIME.md](OWNED-RUNTIME.md), [OWNED-MODEL.md](OWNED-MODEL.md) and
[QUEUE.md](QUEUE.md) for their respective source contracts. Their tests do not
establish installation or live acceptance. The
[pilot artifact contract](PILOT-ARTIFACT.md) covers the retained Scout build,
independent verification and staging boundary.

## Target, budget and first release boundary

The latest bounded host readback recorded for this preparation (2026-11-02,
RDC298915) identifies Linode107087677, `ssc-digital-workforce-runtime`,
`172.104.173.160`, Ubuntu26.04 x86_64,4vCPU,7936MiB RAM with approximately
5950MiB available and63484MiB disk free. Native PostgreSQL18.6 listens on
`localhost:5432`; its HBA file is `/etc/postgresql/18/main/pg_hba.conf`.
`scout_owned_pilot` already exists. `scout_pilot` is currently NOLOGIN,
NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, CONNECTION LIMIT24;
`scout_pilot_owner` is NOLOGIN. No `pilot.env`, `scout-pilot.service` or pilot
listener exists. `ssc-odoo20-community`, `ssc-odoo20-caddy`, `scout-dsh-worker`
and `scout-queue-tunnel` were active in that readback. These are dated snapshots,
not capacity, availability or current-state guarantees; refresh the target and
all relevant state under the existing WI75 record before host work.

Keep this8GB host. The candidate topology is one unprivileged Bun API process
serving the prebuilt Scout UI through `APP_DIST_DIR`, native PostgreSQL in a
separate Scout database/role, and one narrow virtual host in the existing Caddy.
No additional web/dev server, worker, scheduler, Docker, GPU, Redis, Kubernetes,
database cluster or server resize is required. The API and UI use the same origin.

Start with one exact invited owner, synthetic content and one active model call.
Deterministic code handles suitable repetitive work. `SCOUT_DELEGATED_DRAFTS_ENABLED=false`
keeps the retained requester API unavailable and the UI from calling the queue.
Set it true only after the queue owner qualifies current provenance/requester
binding and the actual Scout round trip. The existing connector pin
`dba1dab16dcaa32c03984229c628cd866e02e712` currently labels its source `chatgpt`;
do not relabel this as accepted Scout provenance. No model-selected tools,
business actions, autonomous greetings/briefs, remote agents or native device
execution are enabled by this pilot packet. Owned first-day composition may
create its direct conversation without launching an automatic turn.

The proposed service envelope is 1 CPU (`CPUQuota=100%`), 640 MiB memory
high-water, 1,024 MiB hard memory limit, 128 MiB swap ceiling and 96 tasks. In
the one-process owned runtime, the application data query pool is explicitly
capped at 7 connections, the independent native-identity query pool at 1, and
the separate channel `LISTEN` client at 1, for 9
configured connections per process. The dedicated PostgreSQL role limit is 24
and is shared by every client using that role, leaving up to 15 additional
connections only when no other same-role clients are active. Two owned replicas
would use up to 18 before maintenance clients; three would exceed the role
limit, so horizontal scaling is not covered. Verify cluster headroom, role
ownership, peak connections, pool waits and timeouts first. PostgreSQL's work
is outside the Bun service's memory cgroup. These are initial pilot limits to
measure, not proven throughput or customer-production targets.

The identity pool uses the same explicitly configured Scout database and runtime
role, but a separate SQL client. Native authentication, exact Entra account
mapping, role lookup, organization-user reconciliation, revocation lookup and
authentication audit callbacks all use this pool. Consent keeps its data
transaction and fresh identity, membership, Odoo-map and model-policy checks:
sharing the data pool can deadlock when every data connection is held by a
transaction awaiting another identity read. Do not recombine the pools, increase
the total, or disable those checks to hide a pool wait. Shutdown stops HTTP,
activity listening and history before closing identity and data clients; partial
startup failure closes every acquired client once.

Keep `SCIM_BEARER_TOKEN` unset. Owned mode does not admit SCIM provisioning and
refuses this unsupported server configuration before acquiring database clients.
Silently installing SCIM would enable interactive native-auth transactions whose
SCIM hooks can reenter and exhaust the identity pool. The default licensed
composition retains its existing SCIM behavior; qualifying an owned directory
adapter is a separate task.

## Ownership and inputs before host mutation

Read the existing WI75 record, its linked owner/session and release evidence;
also reconcile WI72/WI182 and independent Community/Odoo, queue and device lanes.
A historic cleared claim, a quiet chat or an online host does not release a
current writer. The queue's [live receipt](https://github.com/Nepritariel08/ssc-ai-enablement/blob/8a9bc957302c2e17506b5312c97d467fded4eac0/services/scout-queue/LIVE-ACCEPTANCE.md)
records earlier bounded host releases and matched recovery; it is not a new
claim. Keep this outcome in the existing primary record.

Proposed WI75 claim text, **not an executed reservation or API payload**:

```text
Task: Scout owner-private pilot installation/acceptance, Issue4/architecture8.
Owner/session: named deployment executor; coordinator01a19336-83fb-7ab0-9829-6fc1c290c93f.
Target: Linode107087677, verified hostname/IP/account; current WI75 record.
Scope: new /opt/scout-pilot, /etc/scout-pilot, /var/lib/scout-pilot,
       /var/backups/scout-pilot; use the existing Scout-only PG database/roles
       only after ownership, grants and schema are reverified;
       scout-pilot.service; one reviewed Caddy site/import for exact approved
       private origin; loopback31881 after collision check; Scout-only
       backup/isolated-restore and bounded synthetic load/rollback checks.
       No shared pg_hba.conf edit except under the separate HBA-only claim below.
Source: exact reviewed release SHA, artifact SHA256 and terminal exact-head CI.
Claim lifetime: 45minutes from recorded UTC start; checkpoint every15minutes.
Expiry: stop issuing mutations; reconcile/extend through existing record and
        owner before continuing. Expiry never releases an outstanding writer.
Excluded: Odoo database/filestore/modules, existing Caddy sites/certificates,
          DSH/queue/tunnel configuration or restarts, their credentials,
          PUBLIC database ACLs, every other PostgreSQL role, listener/bind/port
          changes and any HBA edit outside the marked Scout-role fence below,
          device state/installation, DNS/IdP/access changes outside separately
          verified exact configuration, shared publication and business actions.
Release: Scout validation or safe rollback completed; no owned migration/test
         process left running; exact listeners/services/DB grants and preserved
         Odoo/DSH/HTTPS/queue readback recorded; backups/custody identified;
         WI75 explicitly cleared and read back, with unfinished work assigned.
```

The broad installation claim above does **not** authorize a shared HBA edit. Use
this separate, narrow clause in the existing WI75 record before changing the
shared file; it is a proposed claim text, not a reservation, executed claim or
permission to change other PostgreSQL state:

```text
Task: Scout runtime-role HBA isolation preparation, Issue4/architecture8.
Owner/session: named deployment executor; coordinator01a19336-83fb-7ab0-9829-6fc1c290c93f.
Target: Linode107087677; PostgreSQL18.6 cluster18/main; verified
        /etc/postgresql/18/main/pg_hba.conf; existing localhost:5432 listener.
Scope: record exact HBA/include preimage, owner/group/mode/ACL and SHA256, plus
       scout_pilot role-attribute and session preimage; add only
       the marked literal scout_pilot rule block below before all existing
       authentication records and includes; validate pg_hba_file_rules; perform
       one PostgreSQL configuration reload after adding the block (no service
       restart); if targeted rollback is needed, reload once after removing it;
       make one positive scout_owned_pilot TCP/IPv4 connection and negative
       wrong-database, Unix-socket, and IPv6-if-listening probes using the
       existing protected scout_pilot credential; temporarily set LOGIN on
       scout_pilot only for those probes, then restore its original NOLOGIN
       state and close only its
       own test sessions. Preserve every other HBA byte, role, grant and service.
Credential: use only an already-provisioned protected scout_pilot credential;
            do not create, print, rotate or export credentials in this claim.
            If it is unavailable, do not substitute an owner credential and do
            not edit HBA; record the positive-probe prerequisite as unresolved.
Excluded: PUBLIC ACLs, all other roles and role attributes, owner credentials,
          database/schema/migration changes, listen_addresses/port/firewall,
          pilot.env/service/unit/listener, restarts, Odoo, Caddy, DSH/queue/tunnel,
          device state, DNS/IdP/access changes, business actions and PC-off test.
Rollback: set scout_pilot NOLOGIN; close only its sessions; remove only the exact
          marked block if the full postimage hash and include preimages still
          match; restore recorded owner/group/mode/ACL, validate and reload once.
          If any unrelated file/hash/state changed, stop and preserve it for DBA
          reconciliation; never restore a stale whole-file snapshot over drift.
Release: record postimage hash/mode/ACL, parsed rule order/errors, reload
         evidence, positive and explicit HBA-rejection results, unchanged grants
         and services, every role's attributes restored to its preimage,
         scout_pilot NOLOGIN, and zero scout_pilot sessions; or record the
         verified targeted rollback. Pilot remains disabled and unstarted.
```

Missing owner email or Entra `tid`/`oid` mapping does not block source qualification or an
off-host artifact build. A fresh verified **preparation-only** WI75 claim may
cover isolated source/Bun staging, dedicated Scout-only database roles/schema,
and an empty database backup/isolated restore. Before those mutations, establish
the current host target and released ownership, reviewed source/terminal CI and
artifact hashes, path/database/role collisions, resource headroom, protected DB
and backup custody, and targeted rollback. Narrow the claim above to that scope.
Keep the Scout service **disabled and not started**, and leave ingress unchanged.
Do not provision a placeholder person, Entra account or requester merely to pass
startup. Empty-schema recovery is not authenticated conversation-restore acceptance.

Before Scout startup or activation, the deployment record must additionally supply:

- The reviewed release SHA and Linux artifact, final migration journal and CI.
  This document's preparation branch is not itself an approved release.
- The exact HTTPS private origin, DNS/TLS custody and ingress restriction to
  the owner. `scout.somethingsomewhere.ph` has prior Scout Console routing
  history on this shared Linode; current HTTP redirects to HTTPS, but an
  external Node/OpenSSL probe receives a fatal TLS `internal_error` alert and
  the active certificate/application route could not be verified. Do not reuse
  or cut it over for OpenDuet until its host owner verifies and releases the
  current route. A separate subdomain needs its own DNS/TLS and ingress
  readback. `scout-pilot.example.invalid` below is deliberately unusable. No
  DNS, certificate or public distribution is implied.
- The selected closed [owned Microsoft Entra adapter](OWNED-ENTRA.md), with
  exact resource tenant, application registration, preprovisioned identity and
  verified callback; or
  a specifically approved OpenBot organization authority. The latter implements
  its own `/api/me` and ticket/cookie handoff; an arbitrary Odoo/OIDC URL is not
  an interchangeable authority. Issuer, audience, callbacks, subject and revocation
  must be tested. The Entra app registration, exact owner mapping and live
  HTTPS/login remain unverified. No separate identity service is required.
- Exact native owner subject, native admin role, tenant/deployment and current
  protected membership/requester mapping. `SCOUT_PLATFORM_OWNER_IDS` alone never
  elevates a user; email/domain/header claims do not substitute for the subject.
- Protected custody for the dedicated DB password, encryption/session secrets,
  IdP credentials where required, membership policy, and any approved model key.
  Reuse/migrate existing approved keys only through their owner-controlled path;
  no key is ready merely because a previous local pilot had one. Do not paste,
  print or place them in source, shell arguments, fixtures or build artifacts.

Native admission requires the independent protected `SCOUT_MEMBERSHIPS_FILE`;
see [its strict schema and required migration](MEMBERSHIP.md). The delegated-drafts
switch remains false, so omit queue commands, Odoo UID/key configuration and
`SCOUT_QUEUE_BINDINGS_FILE` for identity/history qualification. Missing verified
authentication or native membership configuration refuses owned startup. An
inactive/expired membership grants nothing. Model policy can remain absent so
inference stays unavailable while identity/history are qualified. Enabling drafts
later requires separate verified queue authority matching the native membership.

## Release and filesystem preparation

Use the [retained pilot artifact](PILOT-ARTIFACT.md), independently checked against
the reviewed source and terminal exact-head CI. Build the Scout UI on a trusted
Linux x86_64 runner, away from shared Odoo; keep the existing8GB Linode for the
bounded runtime. If reproducing the build, use Bun1.4.3 and the frozen
`openbot/bun.lock`. Set `TENANT_PACKAGE_DIR` to the absolute Scout package path
and `SCOUT_MODEL` to the approved non-secret model name before these commands.
From `openbot/`, qualify:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run generate:app-config
bun run --cwd app build
bun run --cwd server typecheck
bun run --cwd app typecheck
```

Use the approved dependency lifecycle policy; if a required native dependency
cannot build with scripts disabled, stop and review that exact script rather than
globally enabling arbitrary lifecycle work. Run relevant existing SQL/native/UI
checks and terminal exact-head CI. Retain the reviewed source/package manifests,
lockfile, runtime workspace sources and migrations in `source.tar.gz`, the
prebuilt UI in `web.tar.gz`, and their verification data in `manifest.json`.
The artifact contains no `node_modules` or runtime image. Install dependencies
on the verified Linux host with the frozen lockfile and reviewed lifecycle
policy before use; do not transfer Windows or CI `node_modules`.
Generate Scout branding with the release's intended `TENANT_PACKAGE_DIR` and
`SCOUT_MODEL`; these names grant no provider or requester access. Exclude secrets,
local `.env`, developer/test databases and private payloads from the artifact.

For Ubuntu x86_64 use the official Bun1.4.3 asset, not a moving installer/latest.
The [official release asset listing](https://github.com/oven-sh/bun/releases/expanded_assets/bun-v1.4.3)
publishes `bun-linux-x64.zip` SHA256
`3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18`.
After the claim and a fresh staging directory are established, the verification
portion is:

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip \
  --output bun-linux-x64.zip
sha256sum --check <<'SCOUT_BUN_SHA'
3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18  bun-linux-x64.zip
SCOUT_BUN_SHA
```

Verify CPU compatibility before choosing the ordinary x64 artifact. If the
official baseline build is needed, qualify `bun-linux-x64-baseline.zip` instead,
whose published SHA256 is
`1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b`;
never use one asset's digest for another. Record actual `bun --version` and
`bun --revision` after extraction (expected version1.4.3, release revision
`c6da4a4…`) before installation. The [Bun installation guide](https://bun.sh/docs/installation)
also requires version/revision readback. No Linux binary was executed here.

Proposed paths and ownership, to instantiate only after collision/ownership checks:

| Path | Purpose and access |
| --- | --- |
| `/opt/scout-pilot/toolchains/bun-1.4.3/bun` | Verified binary, root-owned0755; no global Bun replacement |
| `/opt/scout-pilot/releases/<APPROVED_SHA>/` | Verified Linux release, root-owned and service-readable, no service write |
| `/etc/scout-pilot/pilot.env` | Root-owned0600 systemd environment; never sourced/printed during diagnosis |
| `/etc/scout-pilot/private/` | Root-owned0750, group `scoutpilot`; model/policy/key files service-owned0600; read-only inside the service mount namespace |
| `/var/lib/scout-pilot/` | New unprivileged `scoutpilot` system user's home/state,0700; no Odoo/DSH group membership |
| `/var/backups/scout-pilot/<RUN_ID>/` | Root-only0700 backup staging; encrypted off-host custody required |

Create the system account with no interactive login and no privileged groups.
Inspect existing paths before creating them; an unexpected existing identity,
directory, service or port is a reconciliation point, not permission to overwrite.

## Dedicated PostgreSQL database and migrations

Reverify native cluster identity/version, socket, extension availability,
database inventory, connection headroom and the ownership/grants/schema of
`scout_owned_pilot` before any database work. The latest recorded readback found
that database already present, with `scout_pilot_owner` NOLOGIN and
`scout_pilot` NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION and
CONNECTION LIMIT24. These dated facts are not permission to assume current state.
Do not create or repurpose either name if fresh readback shows another workload.
Never migrate Community Odoo or use its connection string. This runbook's
bounded HBA claim does not authorize PUBLIC ACL changes or any other role,
database, schema, grant or credential changes.

The existing listener is localhost:5432 and the HBA path is
`/etc/postgresql/18/main/pg_hba.conf`, subject to fresh readback under the
separate narrow HBA claim. PostgreSQL uses the first matching rule and does not
fall through after authentication failure; `local` matches Unix-domain sockets,
while `host` matches TCP. Therefore place the exact block below before every
existing HBA record and include directive, after inspecting the complete file
and include chain. Do not delete, reorder, or edit any existing record/include,
and do not rely on a missing `include_if_exists` file for an allow or denial.
The two `all,replication` entries fence this one role from every other database
and physical-replication connection; the specific TCP allow precedes the TCP
deny. All other roles continue to match the existing rules.

```conf
# BEGIN SCOUT PILOT ROLE FENCE - WI75 bounded claim only
host    scout_owned_pilot       scout_pilot     127.0.0.1/32    scram-sha-256
local   all,replication         scout_pilot                     reject
host    all,replication         scout_pilot     all             reject
# END SCOUT PILOT ROLE FENCE
```

The PostgreSQL 18 [HBA documentation](https://www.postgresql.org/docs/18/auth-pg-hba-conf.html)
defines first-match behavior, rule ordering and the `local`, `host`, `all` and
`replication` selectors. Before editing, read back `SHOW hba_file`, port,
`listen_addresses`, the complete HBA and every referenced include. Record exact
file bytes, owner/group/mode and SHA256 for the main file and every included
file; also record `pg_conf_load_time`, current `pg_hba_file_rules` rows/errors,
the exact `scout_pilot` role attributes and all its current sessions, and whether
unrelated PostgreSQL configuration changes are pending reload. Stop before
editing if `scout_pilot` already has a session or any recorded state is unclear.
Any drift, unresolved include, parse error or unrelated pending reload is a
stop condition. `pg_hba_file_rules` parses the current on-disk files; it does
not prove which rules the server has loaded ([view documentation](https://www.postgresql.org/docs/18/view-pg-hba-file-rules.html)).

Under only the narrow HBA claim, add the marked block without changing any other
byte; check that `pg_hba_file_rules` reports no errors and that the three rules
are first, in the exact order shown. If an unrelated change would be activated
by reload, stop and preserve it for DBA reconciliation. Otherwise request one
configuration reload using `pg_reload_conf()` (which sends SIGHUP; see the
[PostgreSQL 18 function reference](https://www.postgresql.org/docs/18/functions-admin.html));
do not restart PostgreSQL or any service. A successful reload signal or a new
`pg_conf_load_time` is not sufficient proof by itself: the real connection
probes below must establish the effective rules.

Only after verifying the protected `scout_pilot` credential is available, and
with `scout_pilot` as the only role temporarily changed to LOGIN for these
probes, verify a fresh TCP/IPv4 connection to `127.0.0.1:5432` succeeds for
`scout_owned_pilot`; read back `current_user`, `current_database()` and
`inet_client_addr()`. Using that same role and credential, verify a TCP attempt
to a different database and a Unix-socket attempt to `scout_owned_pilot` are
explicitly rejected by HBA, rather than failing because of a wrong password,
NOLOGIN or a database CONNECT ACL. If PostgreSQL listens on IPv6, also verify a
connection to `::1` is explicitly rejected. Do not alter PUBLIC ACLs to make a
probe pass, substitute another role, or broaden the listener. Then restore
`scout_pilot` to NOLOGIN and close only sessions owned by `scout_pilot`; verify
the owner remains NOLOGIN, the role's other attributes and all grants are
unchanged, and there are no remaining `scout_pilot` sessions. If a prerequisite
or explicit HBA result cannot be established, do not claim acceptance; perform
the targeted rollback below and keep the pilot disabled.

On any failure after editing, first restore `scout_pilot` to NOLOGIN and close
only sessions owned by `scout_pilot`; never terminate other roles' sessions.
Re-read the main and included-file hashes. If the exact expected postimage
remains and no unrelated file changed, remove only the
marked block, restore the recorded owner/group/mode (and ACL if applicable),
validate `pg_hba_file_rules`, and reload once. Read back the original hash and
the unchanged include chain. If any hash or ownership differs, do not restore a
stale whole-file snapshot over concurrent changes; stop for DBA reconciliation.
Preserve every unrelated rule and do not restart PostgreSQL, Odoo, Caddy,
DSH/queue/tunnel or the Scout pilot.

Run the existing migration runner once as a release step, never in `ExecStart`.
Initial upstream migrations create vector and later migration0010 intentionally
drops the retired document index and vector extension. Use only
`scout_owned_pilot` after verifying it is empty and Scout-owned; review the
entire pinned journal, including0068–0071 and any later release entries.
Vector availability on the host does not mean the final Scout database should
retain that extension. Do not modify Odoo's extensions.

A DBA-owned local-peer migration invocation can avoid any persistent superuser
password in the app. After verifying the actual socket is `/var/run/postgresql`,
the candidate command is:

```sh
sudo -u postgres env PGHOST=/var/run/postgresql PGUSER=postgres \
  DATABASE_URL=postgres:///scout_owned_pilot \
  /opt/scout-pilot/toolchains/bun-1.4.3/bun \
  /opt/scout-pilot/releases/<APPROVED_SHA>/openbot/server/scripts/migrate.ts
```

The pinned migrator uses Postgres.js, whose empty URL hostname permits this
`PGHOST` socket selection. Validate local-peer access before executing; do not
silently substitute TCP superuser credentials. The DBA retains the one-shot
migration authority. The runtime receives no superuser or migration credential.
Grant runtime USAGE on `public`, SELECT/INSERT/UPDATE/DELETE on the exact Scout
application tables, necessary sequence usage and application-function execution;
review grants/readback within `scout_owned_pilot` only. Keep audit invariants and
deny runtime DDL/TRUNCATE. Do not run `REASSIGN OWNED BY postgres` on a shared
cluster. Record migration journal/table/schema hashes and role privileges.

## Service and private ingress templates

Use [owned.env.example](owned.env.example) as the starting contract. This minimal
non-secret overlay still needs the protected inputs listed above:

```dotenv
SCOUT_RUNTIME_MODE=owned
NODE_ENV=production
DEPLOYMENT_ID=scout-owned-pilot
TENANT_PACKAGE_DIR=/opt/scout-pilot/releases/<APPROVED_SHA>/openbot/examples/scout
APP_DIST_DIR=/opt/scout-pilot/releases/<APPROVED_SHA>/openbot/app/dist
OPENBOT_HOST=127.0.0.1
PORT=31881
SERVER_PORT=31881
OPENBOT_SINGLE_USER=false
OPENBOT_DEV_NO_AUTH=false
OPENBOT_GENERATIVE_UI=false
OPENBOT_LEARNING_AUTO_ASSIGN=false
OPENBOT_SELF_HOST_BANNER=false
OPENBOT_MEMORY_SOURCE_DEFAULTS=false
OPENBOT_PROACTIVE_DEFAULTS=false
OPENBOT_OTEL_EXPORT=off
COPILOTKIT_TELEMETRY_DISABLED=true
DO_NOT_TRACK=1
SCOUT_DELEGATED_DRAFTS_ENABLED=false
SCOUT_MODEL=openrouter/free
SCOUT_MEMBERSHIPS_FILE=/etc/scout-pilot/private/memberships.json
OPENBOT_PUBLIC_URL=https://scout-pilot.example.invalid
OPENBOT_APP_URL=https://scout-pilot.example.invalid
TRUSTED_ORIGINS=https://scout-pilot.example.invalid
```

Add the actual dedicated runtime `DATABASE_URL` with URL-encoded password,
`KEY_ENCRYPTION_KEY`, verified authentication configuration and exact
`SCOUT_PLATFORM_OWNER_IDS` through the protected file. Native OAuth requires its
verified provider configuration, `BETTER_AUTH_SECRET`, matching `BETTER_AUTH_URL`
and native admin provisioning. Organization auth uses its specifically verified
authority instead. Neither choice has been configured by this packet.
No wildcard trusted origins, unauthenticated single-user fallback or blanket
email-domain customer admission is permitted.

Initially omit `SCOUT_MODEL_POLICY_FILE`. When real inference is separately ready,
provision the strict protected model-policy JSON for the verified subject/tenant/
deployment/agent. Start with one concurrent call,64 output tokens,16KiB input,
20 calls/day,30s timeout, no personal instructions and the approved route; retain
zero-price/privacy filters on OpenRouter and no paid/automatic fallback. These
caps are proposed pilot settings, not provider guarantees. Do not install an
Intelligence key, duplicate worker key or model-selected tool credential.

`/etc/systemd/system/scout-pilot.service` candidate (replace the SHA before use):

```ini
[Unit]
Description=Scout owner-private owned pilot
After=network-online.target postgresql@18-main.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=scoutpilot
Group=scoutpilot
WorkingDirectory=/opt/scout-pilot/releases/<APPROVED_SHA>/openbot/server
EnvironmentFile=/etc/scout-pilot/pilot.env
ExecStart=/opt/scout-pilot/toolchains/bun-1.4.3/bun /opt/scout-pilot/releases/<APPROVED_SHA>/openbot/server/src/production-entry.ts
Restart=always
RestartSec=5s
TimeoutStopSec=30s
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/scout-pilot
RestrictSUIDSGID=true
CapabilityBoundingSet=
CPUAccounting=true
MemoryAccounting=true
CPUQuota=100%
MemoryHigh=640M
MemoryMax=1024M
MemorySwapMax=128M
TasksMax=96
LimitNOFILE=8192
Nice=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

The process serves static assets and API itself. Do not start `start.sh`, Vite,
`app/serve.ts`, a routines worker or a second DSH worker. Explicit release paths
keep running code and assets on the same immutable SHA. Validate with
`systemd-analyze verify /etc/systemd/system/scout-pilot.service` before a manually
controlled first start. The bounded restart policy must fail visibly rather than
loop indefinitely on invalid configuration. Confirm `31881` is free immediately before binding with `ss -ltnp`.
This port is proposed, not reserved.

Discover the existing `ssc-odoo20-caddy.service` binary/config path from its unit;
do not assume `/etc/caddy/Caddyfile`. Retain a byte-identical backup of that
configuration. Prepare one explicit new site/import, preserving all existing
sites, TLS storage and listeners. Example body for an **approved private origin**:

```caddyfile
scout-pilot.example.invalid {
    # Replace with the exact verified owner network/VPN address before use.
    @outside not remote_ip <APPROVED_OWNER_CIDR>
    respond @outside 403
    request_body {
        max_size 2MB
    }
    reverse_proxy 127.0.0.1:31881 {
        flush_interval -1
    }
}
```

The placeholder CIDR/domain deliberately prevents blind use. Prefer an existing
private access path when it is compatible with the verified native login flow.
If an upstream proxy exists, resolve trusted-client-IP behavior before relying
on an address restriction; do not trust a browser's forwarded header. Validate
the complete candidate with the actual Caddy binary/config adapter before
reload. A Caddy-only reload must preserve Odoo routes and websocket/SSE streaming;
never restart Community/DSH/PostgreSQL to apply this site. Check redirect, cookie,
origin, denied cross-origin writes and websocket behavior through TLS, not just
loopback. No broad CORS or upstream OAuth bypass headers are added.

## Matched backup, isolated restore and rollback

Before the first change, record current Caddy/unit/file hashes, Odoo/DSH/tunnel
health, native PG identity/connections, listener inventory and existing queue
item readback using its established requester. Preserve the accepted Community
DB/filestore/key recovery chain rather than taking over its backup procedure.

For a Scout recovery point, quiesce **Scout only**, wait for its history producers
to stop, then capture its dedicated DB plus the matching encryption/session keys,
protected policies/credentials, unit/proxy fragment, immutable release manifest
and any explicitly approved local attachment/state paths. Native attachments are
currently in the Scout DB; verify the chosen release before assuming that covers
all files. No Odoo or worker stop is part of this Scout snapshot.

After creating a unique root-only staging directory under the claimed path, the
DB portion uses the existing native PostgreSQL tools. The backup operator's
root shell opens the protected output, while `pg_dump` runs under local DBA peer
authentication; no permission widening for the `postgres` user is needed:

```sh
umask 077
sudo -u postgres pg_dump --format=custom --no-owner scout_owned_pilot \
  > /var/backups/scout-pilot/<RUN_ID>/scout.pgdump
pg_restore --list /var/backups/scout-pilot/<RUN_ID>/scout.pgdump
```

Check the dump command's exit and archive readability before proceeding. Use
the existing verified owner-key encrypted backup
procedure for the whole matched bundle, record archive SHA256 and off-host
receipt, and verify decryption/key custody. Its exact tool/command and destination
must be taken from the host owner's current accepted recovery procedure;
this packet does not invent an encryption key or a new backup service. Private
file hashes belong inside the encrypted manifest. Never transfer plaintext
secrets or let a failed encryption be reported as a successful backup.

Restore into a **new, isolated** Scout-only test database/role, never over the
running Scout or Community DB. Example after the DBA verifies the empty target:

```sh
sudo -u postgres pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=scout_pilot_restore_<RUN_ID> \
  < /var/backups/scout-pilot/<RUN_ID>/scout.pgdump
```

Validate table counts, journal/schema, owner/tenant resource stamps, history
events/snapshots, page/attachment references and usage/admission receipts. Verify
key-dependent data decrypts without printing it. An isolated app readback needs
its own checked loopback port and approved authentication/callback configuration;
preserve the restored deployment/user/tenant identities needed to read scoped
history. Keep model egress, delegated drafts and all business/device tools disabled.
Do not point the restore fixture at live requester credentials. Compare persisted
messages and recover interrupted runs without dispatching their model/tool work
again. A successful `pg_restore` alone is not a usable recovery proof.

An older database snapshot may omit later model usage and task observations.
Before re-enabling inference after recovery, reconcile actual provider/queue
receipts and retained quotas; missing cost is unknown, not zero or a daily-budget
reset. Odoo retains current work/lease authority. Uncertain effects require review,
not a new execution because a Scout mirror was restored.

Rollback is manually targeted: withdraw the new Scout Caddy site (or restore
the exact prior verified config), validate/reload Caddy, stop only
`scout-pilot.service`, and retain the failed release/DB/receipts for investigation.
For an update, select the last accepted compatible release/unit/config together;
do not run an older binary against a newer unsupported schema. If DB rollback is
needed, first preserve the current DB and restore the matched recovery point into
a new dedicated target, then explicitly switch the Scout connection after
reconciliation. No automated `DROP`, recursive deletion, global role reassignment,
Odoo restore or broad service restart is provided. Rollback readback must prove
Community HTTPS/login, queue requester status and existing DSH/tunnel remain as
before, and no Scout public listener remains exposed.

## Bounded acceptance and release evidence

Record numeric baseline and test windows with UTC timestamps. Proposed first
load is one owner, two authenticated tabs, one active synthetic conversation,
one SSE stream and at most two ordinary authenticated reads/second for60s;
start without model egress. Exercise history refresh and a small synthetic
attachment, rather than measuring only the process-only `/health` route.
Separately run one explicitly approved capped real inference when its key/data
route is ready. A competing inference must be admitted/refused by policy;
do not bypass the per-user concurrency cap to increase the load score.

Stop Scout load and investigate on Odoo/queue errors, Scout OOM/restart, sustained
host available RAM below1GiB, or Odoo read latency above twice its baseline for
30s. Suggested initial Scout read p95 target is2s, with zero authorization leaks
and preserved task attempts. Record actual CPU/RSS/cgroup peak, PG connections,
latency/error distributions, stream continuity and storage growth; these are
pilot thresholds, not agreed customer SLAs. A failing result calls for fixing or
lowering load before a resize. A single HTTP200 or idle RAM snapshot is insufficient.

Before marking the private pilot accepted, attach evidence for:

1. Exact source/artifact/Bun/journal hashes; dedicated DB privilege readback;
   loopback-only socket; validated unit/resource limits; unchanged Odoo/DSH/Caddy
   routes/services and released ownership.
2. Actual owner login/subject/tenant; anonymous, wrong subject, cross-origin,
   guessed history/channel/page/file and revoked-session denials; exact platform
   owner boundary; websocket denial after revocation; unavailable auxiliary/tool/
   device routes; delegated-drafts capability false and no queue invocation.
3. Real owned history/run reconnect and service restart, matched encrypted
   off-host recovery plus usable isolated restore, safe rollback, and the bounded
   load evidence. Record real inference separately; do not infer it from SDK tests.

Source checks, installed configuration, running service, actual live behavior and
human acceptance are separate states in the primary checkpoint. Shared employee/
customer access stays closed until record/source/context/tool/customer gates,
privacy/retention/recovery targets and that audience's acceptance pass. Publishing
this packet or an owner-private TLS endpoint does not satisfy those gates.

## Device boundary retained

Fresh read-only RDC metadata identified device
`4694482c-3429-44f4-92c1-372e2fab99e0` as HUAWEI ICL-LX9/HWICL, Android12,
matching the existing MateX6 identity; metadata process24139 finished. The other
Android registration `ae44e06d-8243-49b1-a326-4a3b576d0246` timed out without a
PID/property result. Its physical MatePad mapping and command completion remain
unverified; do not infer it from exclusion. No device installation, service,
permission, UI or ADB change was made by that inventory.

The proposed MatePad local-model/executor needs its own released device owner,
exact installed signer/version/public identity, model weights/runtime/checksum,
synthetic on-device inference with remote model egress disabled, bounded quality/
latency/memory/thermal checks, and an approved protected callable endpoint.
The local model route accepts HTTPS or loopback HTTP at `/v1`; an online RDC
agent or remote AI app is not an inference endpoint or proof of local weights.
No automatic model fallback is currently implemented.

Then qualify queued work while screen-off, reboot, lost network and controller
reconnect, using the same Odoo work item/request key, attempt, fenced lease,
expiry/cancellation and durable native receipt/outbox. A lost completion response
must reconcile the original result, not cause a duplicate action. Local presence
and exact approvals remain required where the native action needs them. Keep
shared history and work on Linode, with one Odoo/DSH queue and no second scheduler.
The physical Windows-PC-off exercise remains deferred/unarmed in this platform
goal; the queue owner's redesigned executor acceptance does not require it.
