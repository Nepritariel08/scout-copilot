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
without a key. That overlay describes upstream protocol qualification. The owned
text pilot uses [owned.env.example](scout/owned.env.example) and its protected
model policy; client tools and auxiliary model calls are not enabled. Existing Anil-pilot
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
| Owned conversation storage | Public MIT runner, our PostgreSQL events/snapshots and native owner/tenant grants. Explicit owned mode integrates the same app and protected model port; live inference and deployment remain separately qualified. |
| Scout native chat client | A small branded Expo client for built-in Scout conversations, one-turn Odoo task context and explicit review of existing DSH drafts. Credential setup remains in authenticated Scout web; native provider consent and exact-revision draft acceptance use current server APIs. It adds no draft submission, scheduler, routines, memory, computer, plugins or push. Its Android test APK embeds the JS bundle and needs no EAS project or Metro server. |
| Intelligence | Optional licensed composition for entitled memory/learning/managed Channels; retain its contract and assess cost/deployment separately. |

The queue port at `openbot/server/src/scout` and the conversation's Delegated
drafts panel now implement the source/fixture path. See [setup, invariants and
remaining live acceptance](scout/QUEUE.md). The adapter preserves durable intent before submission, stable
originating-message/idempotency key, exact requester/tenant binding, work-item
ID/revision, status/result retrieval, explicit draft acceptance, cancellation
and recovery without replay. It does not yet provide model-selected AG-UI
delegation or live company SSO/DSH acceptance. An AG-UI endpoint alone supplies
none of those guarantees.
No existing owner/worker secret is included in this fork. The reference adapter
and accepted task5/client-crash task7 receipts remain in
[scout-workspace PR1](https://github.com/Nepritariel08/scout-workspace/pull/1).

Owned native admission now requires the independent protected
`SCOUT_MEMBERSHIPS_FILE`; it needs no queue command, Odoo requester key or
`draftAnalysis` permission. Model policy, optional DSH requester binding and
optional direct Odoo identity mapping remain separate grants. See the
[mandatory configuration/grant migration](scout/MEMBERSHIP.md).

## Persistence and deployment qualification

The separately reviewed [owned PostgreSQL persistence foundation](scout/PERSISTENCE.md)
uses the public MIT AgentRunner extension. It now has synthetic real-SDK/SQL
qualification for native user/tenant isolation, durable replay, fenced producer
recovery, interrupted resume and exact-run cancellation. The subsequent explicit
[owned runtime integration](scout/OWNED-RUNTIME.md) wires the same app, native
sign-in, channel creation and UI readers to that store. The subsequent
[protected model port](scout/OWNED-MODEL.md) connects explicit OpenRouter/local
chat completions with native policy and durable quotas/usage receipts. Native
tenant scopes now intersect agent/channel/page/attachment SQL with existing
visibility, ownership and membership rules; resources are stamped transactionally,
unscoped legacy rows deny, and curated agent templates permit reads only. Standing
instructions use the current deployment/tenant/native-user partition. Model context
still excludes unadapted tools and business-record retrieval. Real inference,
complete record/context controls and deployment remain separately qualified.
See the [platform-owner and identity boundaries](scout/OWNED-RUNTIME.md#platform-ownership-and-identity-administration),
including exact `SCOUT_PLATFORM_OWNER_IDS`, all seven SSO management endpoints and
unavailable auth-admin/SCIM/remote callback paths. The following vendor requirements
apply to the unchanged default licensed composition.

For new owned Scout access, Microsoft Entra is now the selected source-level
identity route: employees use the resource directory and customers must first
redeem a B2B guest invitation there. The adapter admits only an exact
preprovisioned `(issuer, oid)` mapping; local role, owner, tenant and Odoo
requester grants remain separate. Its application registration, credentials,
legacy Microsoft-account reconciliation, and live login are still unqualified;
see [the Entra setup and acceptance guide](scout/OWNED-ENTRA.md).

The upstream/default licensed `server/src/config.ts` composition requires
Intelligence API, WebSocket and key settings. Explicit owned mode instead uses
the public MIT runner and our durable PostgreSQL adapter; it needs no managed
Intelligence project, license purchase or vendor entitlement simulation.
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
equivalent to this source. The independently qualified local persistence adapter
is implemented, rather than awaiting a paid Intelligence decision. It does not
reproduce the vendor's licensed memory/learning service. Keep the current 8 GB
Linode for the capped private pilot; measure Odoo/Scout load before resizing.
Proposed MatePad model/execution capabilities still require actual-device evidence.

The full [enterprise architecture and access criteria](scout/ENTERPRISE-ARCHITECTURE.md)
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

At the bootstrap checkpoint, the original OpenDuet package, platform server/shared
code and Bun lockfile were unchanged. Subsequent owned source adds reviewed
server/schema/shared/UI wiring and one direct server declaration of the already
locked model SDK version; it does not upgrade that dependency. The original
upstream tenant package remains intact.
The local Vite build reached transformation
and was deliberately interrupted after host free RAM fell below1GiB; no frontend
build pass is claimed. Exact-head CI is reported separately in the primary
checkpoint; do not infer it from these bounded source checks.

## Requester-port build and CI follow-up

The later Scout-profile production frontend build passed at adapter commit
`17a406781d440dcf71eda67109c9ae52e3452c55` using Bun1.4.3 and the frozen lockfile.
Vite7.3.6 completed in3m3s; existing large-chunk warnings remain. The generated
configuration selected Scout. The built `app/dist/index.html` SHA256 was
`9de4f15ff98dc50a628429e9641172c26ae48afd84e0f01043b9e855c54d5b6d`.
This follows the interrupted low-memory attempt; it does not rewrite that receipt.

Full CI at that commit failed two test assumptions also present in the pinned
upstream's failed run41243617189. The first-day route test now sends today's UTC
date rather than an expired fixed date, preserving the route's date window.
The provider fixture keeps HTTP's case-insensitive header lookup and requires
exactly one synthetic credential plus a documented API version. The official
[Anthropic SDK1.0 client](https://github.com/anthropics/anthropic-sdk-python/blob/v1.0.0/src/anthropic/_client.py)
uses X-Api-Key/API2023-06-01; the installed and official
[SDK2.3 client](https://github.com/anthropics/anthropic-sdk-python/blob/v2.3.0/src/anthropic/_client.py)
uses Authorization: Bearer with
[API2026-10-21](https://github.com/anthropics/anthropic-sdk-python/blob/v2.3.0/src/anthropic/_constants.py).
Wrong, absent or competing credentials and unknown credential/version pairs fail.
Endpoint, selected model, messages and absence of an OpenAI key remain asserted.
No provider behavior, dependency or CI workflow changes are involved.

Local validation of this repair:3 first-day checks passed (96filtered);85 Python
harness checks passed,3 existing platform cases skipped,2 Linux Docker-mount
cases deselected on Windows. Those two remain unchanged and run in Linux CI.
The Python run used isolated Python3.14.7, Anthropic2.3.0 and httpx2 2.16.0,
with synthetic credentials and HTTP/loopback fixtures, not a live provider.
Scoped Biome formatting/lint and `git diff --check` passed. Exact-head CI and
deployment status remain in the primary tracker; local success is not live
company SSO, remote DSH or employee/customer acceptance.

At test-repair commit `3cf6ee089c3173560447889bf9fccc0d2fca9116`, the Linux full
test run completed10,161 passes/75skips/0failed assertions, but failed overall
on1 unhandled React scheduler callback after the banner test removed its DOM.
That test now uses the repository's existing `settleReactWork` drain before
unregistering, as other React suites already do. The banner, chat-step and
Scout-draft suites passed together locally:28checks/0fail/0unhandled errors.
This run selected the upstream profile expected by its banner text assertions;
the generated Scout configuration was restored afterward. No assertion,
product behavior or CI failure handling was removed. Full exact-head CI still
requires its own terminal readback.

The full test job at `d4c8d40758c50648603bcaf04ba33b2256fe36d4` then passed
10,161checks/75skips/0fail/0unhandled errors across824files. Its later AG2
Python step exposed the same old X-Api-Key expectation. The AG2 fixture now
checks the exact official endpoint, selected model and the same two credential/
API-version pairs. Its10cases passed locally with AG2 1.2.2/Anthropic2.3.0.
The final Microsoft harness was also qualified independently:10cases passed
with its original test unchanged. Its framework constrains Anthropic to
`>=1.11.0,<2` and resolved1.17.0, which retains the original header/API version;
the initial compatibility edit there was discarded. Both isolated Python3.14.7
runs used synthetic credentials and local HTTP/mocked transports, not a live
provider. The AG2 change preserves completion, key, endpoint and model checks;
no runtime, requirements or workflow changes are involved. These versioned
receipts qualify the resolved dependencies, not all future unlocked installs.
