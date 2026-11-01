# Scout delegated drafts

The CopilotKit fork now has a requester adapter at `openbot/server/src/scout`,
authenticated `/api/scout/tasks` routes and a Delegated drafts panel in each
Scout conversation. This is source/fixture integration, not a live Odoo/DSH,
company sign-in, shared-access or mobile installation acceptance receipt.

## Authority and activation

Resolve owned conversation persistence and backup/restore qualification, plus
verified native sign-in, first. Setting
`SCOUT_QUEUE_BINDINGS_FILE` activates the adapter only with verified sign-in;
the server refuses unauthenticated single-user mode. An absent setting leaves
the API unmounted. Apply migration `0068_scout_queue_requester.sql` through the
existing migration runner. It adds submission/receipt and review-intent tables,
not a worker, scheduler, lease claimant or execution queue.

In explicit owned mode, native tenant admission uses the separate protected
`SCOUT_MEMBERSHIPS_FILE`; queue bindings never establish membership. Delegated
drafts are disabled by default and construct no queue service/connector. Only
`SCOUT_DELEGATED_DRAFTS_ENABLED=true` requires the separate queue file. Its
user/tenant/deployment must intersect current native membership; the combined
fingerprint pins both policies through intent, review, RPC and receipt checks.
See [the required membership migration](MEMBERSHIP.md). Queue authority is also
independent of `SCOUT_ODOO_BINDINGS_FILE` for direct Odoo record context.

Copy `queue-bindings.example.json` outside source. It is disabled/expired by
default. A trusted operator provisions an exact immutable native user ID,
tenant, active versioned policy, expiry and that user's separately verified Odoo
requester identity. Email matching or open registration cannot grant access.
The pilot supports one tenant per native account. Duplicate user bindings,
duplicate tenant policies and sharing an Odoo requester identity across accounts
are refused. Multi-membership selection needs a later tested provisioning flow.

Protect the JSON and requester key for the service account:0600 on Linux and
verified owner/service-only Windows ACLs. Only the key path is stored in JSON.
The reader rejects non-files, relative paths, oversized/invalid/extra fields,
insecure remote origins and arbitrary process/module/environment arguments.
Use the pinned queue connector contract
`dba1dab16dcaa32c03984229c628cd866e02e712` in a separate protected environment.
The six requester tools and actual UID/database/companies/draft-only/no-worker/
no-business-actions context are verified on every connection and operation.

**Origin-label limitation before live rollout:** that pinned MCP entrypoint
currently writes `source_surface=chatgpt`, including calls from another client.
Scout keeps its actual conversation/source ID and `scout:` request key locally,
but a live Scout deployment must reconcile the connector's origin labeling with
the queue owner. Do not report that field as accurate Scout-client provenance.
The canonical queue/connector source was not changed by this adapter lane.

## Submission, review and recovery

Open Delegated drafts in an authorized conversation. Enter the task and only
permitted context, then Delegate draft. This makes an explicit queue request;
ordinary chat is a separate path and is not also run for the same submission.
The initial adapter does not yet expose model-selected AG-UI delegation.

The server verifies channel access and a fresh binding/policy. It commits the
exact title/instructions/source key before contacting MCP. Source keys cannot
be reused with changed payloads or bindings. A PostgreSQL transaction lock
serializes operations on an existing intent across processes. Odoo owns work
state; the app mirrors only a validated receipt and never claims/executes work.

An unknown submit reply stays visible as Submission needs recovery. Recover
submission reuses the stored payload/key; it does not invent another task.
The browser keeps only its opaque form nonce in session storage. After a reload,
existing intents are listed by their original conversation. Start another draft
is an explicit new intent. Closing/restarting the client is not cancellation.

Refresh status reads the existing item. Accept draft submits the displayed
revision and SHA256 of the displayed result. The exact review intent is committed
before the RPC; the current remote revision/draft and current membership are
checked again before mutation. It accepts a draft only, not proposed business
actions. Repeated confirmed acceptance is a readback. Cancel task uses the
displayed revision. An uncertain result is recovered by reading existing state,
with no blind execution retry. A changed policy/binding, revoked account/channel
or mismatched/stale/foreign receipt fails closed. Errors expose stable safe codes.

Returned drafts render as inert text. Query caches/form nonces are scoped to
the authenticated account and conversation. Model content cannot install an
action, supply a requester/tenant identity or create access rights.

## Validation boundaries

Local integration tests use a dedicated bounded PostgreSQL16 container, actual
native authentication middleware with a synthetic session authority, real Hono
requests and the real MCP SDK over an in-memory transport. The remote Odoo/DSH
queue is a synthetic fixture. Recovery reconstructs the application/store with
a new database connection after a lost reply; it is not an OS/process-kill drill.
UI tests exercise delegation, nonce reuse/recovery, exact review parameters,
inert result text and account-switch cache isolation. Record exact counts,
typechecks, build and CI state in the primary checkpoint.

The production stdio transport also passed locally against the pinned Python
connector and a synthetic local JSON-2 endpoint: lost submit reply/reconnect,
one existing recovered item, one acceptance and one cancellation. Both connector
source files matched the recorded executable pin. That drill observed the
legacy `chatgpt` source label; it made no real Odoo/DSH or provider requests.
Reproduce it from `openbot/`, with protected local toolchain paths:

```sh
SCOUT_TEST_PYTHON=/absolute/path/to/python \
SCOUT_TEST_QUEUE_CWD=/absolute/path/to/pinned/services/scout-queue \
bun server/scripts/qualify-scout-stdio.ts
```

Missing prerequisites fail with an explicit no-test-run error. The harness
creates its own synthetic local endpoint/key, refuses arbitrary Odoo targets,
and tears down its server/key when finished. It is not a live queue acceptance.

Current focused checks:218 backend cases across7 suites,14 UI/chat cases across2
suites, and the separate stdio drill passed. App production/test TypeScript
checked clean. The server test project matched239 existing baseline diagnostics
with zero new diagnostics under Windows path normalization; no baseline entry
was added. Production server types, static checks, full build and CI are reported
separately in the primary checkpoint.

Remaining integration acceptance includes actual native SSO/requester
provisioning, source origin labeling, natural chat
delegation, the Intelligence decision, full build and private same-Linode/mobile
round trip/restart/restore and access/capacity tests. Fixed owner UID5 cannot be
opened to employees/customers. Physical PC-off remains deferred/unarmed.
