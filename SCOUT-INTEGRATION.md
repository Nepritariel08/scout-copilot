# Scout on CopilotKit OpenDuet

The owner selected CopilotKit/OpenDuet on 2026-11-01, superseding the earlier
Anil-matcha/Open Duet and LibreChat interface directions. This owned fork is
[Nepritariel08/scout-copilot](https://github.com/Nepritariel08/scout-copilot),
based on upstream `f52288fff5ccdbd3de428d573d9f026fce5ff480`. Retain MIT notices.
The primary tracker remains [SSC AI Enablement #4](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4#issuecomment-6547459663).
No second product, worker, tracker or deployment is created by this source work.

## Extension and current state

`openbot/examples/scout` copies the upstream OpenDuet tenant package and changes
its product/bot/channel names to Scout. Its model is required through
`SCOUT_MODEL`, avoiding an implicit paid default. Set `BOT_MODEL` to the same
approved gateway model for optional external harnesses. The upstream package
remains untouched, so platform fixes can be pulled from CopilotKit.

`scout/qualification.env.example` is a deliberately incomplete qualification
overlay, not an install script. It selects Scout, keeps all listeners on
loopback, refuses unauthenticated single-user operation, disables optional
telemetry/automatic learning assignment, and configures the OpenRouter protocol
without a key. The model must support the required tools. Existing Anil-pilot
price/token ceilings do not carry over: qualify model routing, all auxiliary
calls, cost limits and refusal paths before real inference.

Source configuration does not establish tenant isolation or provider consent.
The packaged personal-assistant prompt and `allowed_groups: [all]` are not a
customer access policy. Skills confer no grants. The copied optional remote
agents are omitted by upstream when their endpoint variables are empty. Morning
briefs, routines, learning and connectors must be deliberately scoped; the
upstream start script starts a routine worker. Do not activate it for jobs owned
by the existing DSH queue.

## Integrated responsibilities

| Component | Scout role and boundary |
| --- | --- |
| CopilotKit OpenDuet / embedded OpenBot | One branded web/mobile conversation, task, page and review surface. Upstream gateway/policy/approval/audit are reused and tested, not presumed enterprise authorization. |
| Scout policy gateway | Verified issuer/subject and active membership to tenant/source/Odoo requester mapping. Never accept a UID, tenant or role from model/tool arguments. Deny absent/revoked policy. |
| Existing Odoo Community queue / DSH | Durable delegated work, leases, cancellation, draft results and human acceptance. Keep executable queue contract `dba1dab16dcaa32c03984229c628cd866e02e712`; no duplicate submission or background executor. |
| OpenRouter / optional local inference | Approved model route, data-release policy, output/context caps, budgets and usage receipts. Owning the UI does not confer model ownership. |
| Existing Scout MatePad/phone shell | Device consent, narrow native actions and receipts. Remote content must not inherit a trusted JavaScript bridge. Validate WebView/browser login/reconnect before installing/replacing a client. |
| Intelligence | Required thread persistence and optional entitled memory/learning; resolve ownership, data handling, license, availability and restore before real staff/customer data. |

The first queue port must preserve durable intent before submission, stable
originating-message/idempotency key, exact requester/tenant binding, work-item
ID/revision, status/result retrieval, explicit draft acceptance, cancellation
and recovery without replay. An AG-UI endpoint alone supplies none of those.
No existing owner/worker secret is included in this fork. The reference adapter
and accepted task5/client-crash task7 receipts remain in
[scout-workspace PR1](https://github.com/Nepritariel08/scout-workspace/pull/1).

## Persistence and deployment qualification

Upstream `server/src/config.ts` requires Intelligence API, WebSocket and key
settings. A local memory table fallback does not make durable threads optional.
The [local Intelligence evaluation](https://docs.copilotkit.ai/intelligence/self-hosting-local)
currently requires macOS/Docker Desktop and at least 12 GiB Docker RAM; it is a
licensed evaluation, not a supported install route on the existing 8 GB Linux
Community host. Production self-hosting has a separate entitlement. Neither a
vendor signup, license purchase nor hosted business-data transfer is authorized
by this configuration file. No managed project was created or key requested.

Keep the same-Linode preference for a measured private Scout pilot, with separate
PostgreSQL/pgvector database credentials, service identity, private ports,
resource budgets, rollback and matched key/data backups. Never use Odoo's
superuser connection or grant a Bot shell access to the Community host. Upstream
has no OpenDuet-specific published deploy image; plain OpenBot images are not
equivalent to this source. Resolve Intelligence's approved deployment or design
a separately tested local persistence adapter without bypassing license checks.

The full [enterprise architecture and access criteria](https://github.com/Nepritariel08/scout-workspace/blob/scout/bootstrap-20261101/docs/SCOUT-ENTERPRISE-ARCHITECTURE.md)
carry over. No staff/customer access, Linode deployment, phone installation,
live CopilotKit inference or PC-off acceptance is claimed by this bootstrap.

## Initial source validation

On Windows with isolated Bun1.4.3, frozen installation with dependency scripts
disabled succeeded. The Bun Windows archive matched the upstream release
SHA256 `0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d`.

251 selected tests passed across nine existing suites:69 tenant-package
duplicate/agent-file, model-provider, model-URL and Intelligence entitlement
checks;182 configuration, listener, same-origin and organization-auth checks.
The authentication tests use local fixture authorities and Better Auth's test
exchange, not the company's live identity provider. The real package
loader returned Scout branding, one built-in Scout agent and zero knowledge
sources with a synthetic model. Removing `SCOUT_MODEL` was refused. Generated
app configuration also contained Scout branding. These selected tests use local
fixtures; they are not a live provider, identity or end-to-end queue test.

The original OpenDuet package, platform server/shared code and Bun lockfile were
unchanged from the pinned upstream. The local Vite build reached transformation
and was deliberately interrupted after host free RAM fell below1GiB; no frontend
build pass is claimed. Exact-head CI is reported separately in the primary
checkpoint; do not infer it from these bounded source checks.
