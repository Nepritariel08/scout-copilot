# Scout owned model port

This source adds an explicit model connection to the owned runtime in
[OWNED-RUNTIME.md](OWNED-RUNTIME.md). It uses the public V3 language-model
contract and the already locked `@ai-sdk/openai` version `3.0.99`, now declared
directly by the server. This declaration does not upgrade the dependency or
create a CopilotKit Intelligence entitlement. The default licensed composition
retains its existing contract.

The source contains the model integration, its migration and synthetic SQL/SDK
qualification. This document describes the source contract, not a deployed,
live or accepted service. Exact-head test evidence and deployment ownership belong in the
[primary checkpoint](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4#issuecomment-6547459663).
Do not provision staff or customer access from this example.

## Keep the pilot on the existing infrastructure

Use the current 8 GB RAM / 4 vCPU Community Linode as the candidate for a capped
private pilot, with its existing PostgreSQL and Caddy. Scout needs a dedicated
database identity, protected configuration, loopback service and measured
resource limits. No 16 GB upgrade, additional server or GPU is assumed. Measure
Odoo and Scout together before changing capacity; the current PostgreSQL major
also needs migration and runtime qualification.

Linode keeps authoritative shared identity, conversations, queued work,
approvals and audit. Suitable deterministic tasks should use ordinary code
first. MatePad is the proposed small-model and execution device; its model,
callable endpoint, accuracy, speed, resource use and unattended operation remain
unverified. Accept it only after real screen-off, reboot, reconnect and task
recovery checks. A tablet AI app alone is not evidence of an on-device model.

OpenRouter supplies an explicitly approved remote model route. The current
source selects one route per protected binding; it does not automatically
switch between OpenRouter and MatePad. If MatePad is unavailable, retain the
durable work and its state rather than inventing a successful execution. Any
future fallback must apply the same context-release and spending policy.

Keep the existing Odoo/DSH worker for delegated work, leases and human draft
acceptance. This model connection creates no second scheduler. Physical PC-off
testing remains deferred and unarmed.

## Protected operator configuration

Use `SCOUT_RUNTIME_MODE=owned` with the explicit `production-entry.ts` entry.
The upstream `start.sh` refuses owned mode. Verified native authentication,
`SCOUT_QUEUE_BINDINGS_FILE` and the owned PostgreSQL store remain required;
model policy grants no login, tenant membership or Odoo rights.

Set `SCOUT_MODEL_POLICY_FILE` to an absolute path outside the repository, for
example `/etc/scout/private/model-policy.json`. If it is absent, the owned app
keeps model execution unavailable. Missing, malformed, revoked, expired or
unmatched policy refuses the request; it never falls back to an environment
key or a browser-selected route.

[owned-model-policy.example.json](owned-model-policy.example.json) contains
synthetic IDs and a key path, not a credential. An administrator must replace
the IDs with the exact verified native user ID, protected tenant/deployment
binding and granted native agent ID. Email addresses, display names, prompts,
channel groups and client headers cannot substitute for these identifiers.
Choose a short appropriate expiry before enabling a pilot.

Both policy and key files must be absolute regular files, not symlinks. The
reader bounds the policy to 65,536 bytes and each key to 4,096 bytes, verifies
the opened file matches the checked inode/device, and reloads the relevant
files for calls. On Unix it rejects group/world permission bits and owners
other than root or the service UID. The operating system must also allow the
service to read the file. For example, use service-owned `0600` files inside an
administrator-managed directory whose traversal permits the service and whose
write permissions exclude other users. Keep parent directories protected;
file checks do not validate every ancestor or Windows ACL.

Provision secrets through the protected deployment path. Never paste a key
into policy JSON, source, chat, fixtures, command arguments or logs. An
OpenRouter route requires `apiKeyFile`; a local route may omit it. A key is
trimmed, must be nonempty and may not contain embedded whitespace or control
characters. Rotation uses the same protected path; arbitrary environment keys
are not a fallback. Validation errors expose a generic code rather than the
file path or contents.

## Exact policy shape

All objects are strict: extra properties are invalid. The root requires
`version: 1`, `deploymentId`, `globalMaxConcurrent`, `globalMaxCallsPerDay` and
`bindings`. Deployment and tenant IDs contain only letters, digits, `_` and
`-`, with length 1–100. There may be at most 100 bindings and each native user
ID appears once. An empty binding list grants nobody access.

Each binding requires `userId`, `tenantId`, `active`, positive integer
`revision`, ISO date-time `expiresAt`, unique `agentIds`,
`allowConversationContext: true`, boolean `allowPersonalInstructions`, `route`
and `limits`. User/agent IDs are trimmed strings of length 1–200; the agent
list has 1–50 entries. `allowConversationContext: false` is not a supported
execution mode: remove or deactivate the binding to deny conversation release.
Personal instructions remain excluded unless explicitly enabled.
In owned mode those instructions are read only from the current native subject,
tenant and deployment partition. The legacy global-user instruction row is not
a fallback, and changing a subject's tenant does not release its old instructions
into the new tenant's model context.

| Field | Accepted integer range | Example cap |
| --- | --- | --- |
| Root `globalMaxConcurrent` | 1–8 | 2 |
| Root `globalMaxCallsPerDay` | 1–10,000 | 100 |
| `limits.maxInputBytes` | 1,024–262,144 | 16,384 |
| `limits.maxOutputTokens` | 1–4,096 | 256 |
| `limits.maxOutputBytes` | 1,024–262,144 | 16,384 |
| `limits.maxCallsPerRun` | 1–8 | 1 |
| `limits.maxCallsPerDay` | 1–1,000 | 20 |
| `limits.maxConcurrent` | 1–4 | 1 |
| `limits.timeoutMs` | 1,000–120,000 | 30,000 |

The example caps are operator choices, not measured capacity or provider
availability. Input bytes measure the serialized outbound body, not exact
tokenization. Output bytes bound emitted text/reasoning; the wire parser has
an additional bounded transport allowance. The server pins `max_tokens` to
the protected output-token limit.

An OpenRouter route has exactly `provider: "openrouter"`, `model` and
`apiKeyFile`. The example chooses `openrouter/free`. The endpoint is fixed by
source to `https://openrouter.ai/api/v1/chat/completions`; policy cannot change
its host. Every request sends `allow_fallbacks: false`,
`require_parameters: true`, `data_collection: "deny"`, `zdr: true`, and zero
`max_price` for prompt, completion, request and image. An incompatible or
unavailable free endpoint must refuse, not relax the policy. There is no paid
budget or subscription-bypass configuration in this slice. Positive reported
OpenRouter cost is treated as `MODEL_COST_VIOLATION`; a provider's report is
still not a billing guarantee.

A local route replaces the entire `route` object with this shape:

```json
{
  "provider": "local",
  "model": "synthetic-local-model",
  "baseUrl": "http://127.0.0.1:11434/v1"
}
```

`apiKeyFile` may be added as an absolute protected path. The adapter uses
OpenAI-compatible chat completions at `<baseUrl>/chat/completions`. Only HTTPS
or loopback HTTP is accepted, with exactly `/v1` or `/v1/`, no URL credentials,
query or fragment. A networked MatePad would therefore need an explicitly
protected reachable HTTPS endpoint, or an approved loopback tunnel; neither
exists merely because the tablet is online. Route syntax alone establishes
neither endpoint ownership nor device consent. Verify both before enabling it.
The model identifier starts with a letter/digit and contains at most 200
letters, digits, `.`, `_`, `:`, `/`, `+` or `-`.

## Admission, limits and receipts

The source binds model execution to the current native user, tenant,
deployment, agent and owned thread/run. It rechecks authentication, current
bindings, history access and policy fingerprint before dispatch. Browser
provider options, forwarded properties, arbitrary screen context and tools do
not select credentials, endpoints or budgets.

Each run pins its requester-binding fingerprint separately from its model policy.
After every awaited SDK read, the output gate rechecks current authorization,
expiry and cancellation before releasing a decoded part. The output stream reads
on demand, so a paused consumer cannot receive a prefetched part after revocation.
Content already released before revocation cannot be recalled. Completion and
generated answers are checked again after persistence and stream-close waits;
an already committed receipt can remain `completed` while output is withheld.

`scout_model_calls` stores metadata rather than prompts or secrets. Admission
uses a short PostgreSQL advisory lock per deployment and requires the live
owned-history run lease. The sequence is durable reservation, durable dispatch
marker, then provider I/O. The provider request does not run inside the
admission transaction. The ledger enforces per-run and per-user/tenant UTC-day
call counts, deployment UTC-day counts, and user/deployment concurrency across
processes. Changing a policy fingerprint or deleting a conversation must not
reset these counts; usage metadata has no conversation/user cascade.

Reservations and dispatches have bounded expiry. A refusal before dispatch is
recorded as `refused`; an interruption after dispatch is conservatively
`uncertain`, because the provider may have performed work. Expired reserved
rows become refused and expired dispatched rows become uncertain on subsequent
admission (including budget-refused admission) or an authorized receipt read.
Completion also requires the same live history producer lease and an observed
provider terminal reason; clean partial/empty EOF cannot complete a receipt.
These attempts remain counted. The system does not automatically
refund quota, replay an uncertain call or add a recovery scheduler.

Owner-bound receipts are read through
`GET /api/scout/model/:threadId/receipts` after native history access checks.
They include status, ordinal, provider, requested/reported model, byte counts,
available token/cost reports, timestamps and safe error codes. They omit raw
prompts, policy contents, private lease tokens and key paths. Missing provider
usage or cost stays `null`; it is never presented as zero. Local compute and
device energy cost are not measured by these API reports.

## Text pilot and remaining acceptance

The first port accepts owned conversation text and, only if granted, personal
instructions. It strips client tools, arbitrary context and forwarded
properties; provider options cannot override the constructed outbound request.
It rejects file/media messages, unexpected provider tool calls and unadapted
remote-agent execution. Auxiliary model calls cannot inherit an unrestricted
credential path. Owned configuration ignores transcription/voice environment
settings, reports those capabilities unavailable, and refuses their native
routes before provider construction. Delegated drafts continue through the separately governed
Scout/DSH requester port.

Storing conversations on Linode does not keep prompts on Linode when an
OpenRouter route is selected. The operator must approve the actual context
release and verify the selected provider/account policy. Strict privacy fields
are requested by this code; they do not replace provider consent, contractual
review or runtime evidence.

Before deployment, verify schema migration and real SQL admission on the host's
PostgreSQL major, actual public-SDK streaming, durable usage across restart,
revocation, parallel limits, interruption/uncertain recovery, output/time caps,
provider error sanitization and absence of unapproved tool execution. Use
synthetic keys and loopback providers first; no real model spend or live
business-data test follows from this document.

Shared employee/customer access also needs qualified tenant partitioning across
the whole app. The current source adds immutable native agent/channel/page scopes,
channel-bound attachment access, scoped standing instructions and an exact native
platform-owner boundary; these still need integrated live qualification. It also
needs record-level Odoo/source authorization, permission-aware retrieval,
document deletion/revocation, shared-channel rules, tool approvals, audit and
deployment/device acceptance. The current owner-bound history and model binding
are prerequisites; they are not proof of the entire enterprise boundary. Keep
private-pilot scope until the primary tracker records that evidence.
