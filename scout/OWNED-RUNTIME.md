# Scout owned runtime integration

The owner chose infrastructure-owned conversations on 2026-11-01. This source
slice connects the qualified PostgreSQL/public MIT runner to the existing
CopilotKit/OpenDuet app. `SCOUT_RUNTIME_MODE=owned` selects it explicitly; the
default licensed Intelligence composition and entitlements are preserved.

## Cost and scope

Checked on 2026-11-01: [CopilotKit pricing](https://www.copilotkit.ai/pricing)
lists production self-hosted PAYG at USD49/month per organization, including
10,000 interactions, with metered overage and usage reporting. Annual/offline
terms use custom pricing. Model and infrastructure costs are separate. No
account or purchase was created. Confirm terms and sizing before selecting it.

The [production self-hosting guide](https://docs.copilotkit.ai/intelligence/self-hosting)
describes licensed services with PostgreSQL, Redis and OIDC on Kubernetes. The
[local evaluation](https://docs.copilotkit.ai/intelligence/self-hosting-local)
is non-production; the supported macOS/Docker preview requires 4 CPUs, 12 GiB
RAM and 40 GiB free storage. This is not a measured production requirement or
evidence of fit on the Community Linode.

The selected public MIT SDK/owned PostgreSQL adapter has no Intelligence
subscription fee. We maintain its source, upgrades, backup/restore and operations.
It does not implement licensed memory, learning or managed Channels. OpenRouter
still receives approved prompt context for inference; retention, context release,
spend limits and receipts require separate qualification.

## Infrastructure for our own intelligence layer

Read-only host verification on 2026-11-01 confirmed the existing Community Linode
at `172.104.173.160`: 4 vCPUs, 7936 MiB RAM, 6085 MiB currently available, and 66.1 GiB
free on the root filesystem. This is a point-in-time observation, not a load test.

Use that host for a capped private pilot: the existing Caddy/HTTPS front door,
one separately owned Scout API service, a dedicated PostgreSQL/pgvector database
and role, protected model/policy credentials, existing native/company sign-in,
and encrypted off-host database/key/document backups. Keep the existing DSH/Odoo
queue as delegated execution. MatePad/phone remain clients and consent-bound
device executors; durable storage and unattended server execution stay on Linode.

Engineering sizing target for an initial small staff/customer rollout is 16 GB
RAM with 4–6 vCPUs and 100–200 GB usable SSD, then load-test document ingestion,
concurrent chats, Odoo contention and restore before increasing access. These
are planning estimates for our implementation, not CopilotKit vendor minima.
Current [Akamai shared-CPU pricing](https://www.akamai.com/cloud/pricing/cpu)
lists 16 GB/6 vCPU/320 GB at USD96/month; region, backups and inference are extra
considerations. No infrastructure change was made.

OpenRouter inference needs no local GPU. A fully local model can use a separate
CPU/GPU inference node later, sized after choosing the model, context and load.
The first owned implementation can use systemd and PostgreSQL; no additional
scheduler or managed memory service is required for this persistence slice.

## Same app, explicit authority

- Reuses `createApp`, native authentication/people/roles, profiles, channels,
  audit/credential administration, preferences, onboarding, pages and the DSH
  requester. No Intelligence client or second background scheduler is created.
- Requires sign-in plus protected current per-user tenant/requester policy.
  Every protected API route checks membership. History/run/stream checks refresh
  native identity and grants. Body fields, headers and prompts grant no rights.
  The organization bridge requires matching verified subject IDs in owned mode;
  a same-email foreign subject cannot inherit another local account.
- Commits native channel creation and its server-minted history on one SQL
  transaction. Direct mint accepts only the agent ID. Owned mint failure never
  falls back to a browser UUID. Public SDK run/connect/stop and existing UI
  readers use the request-bound store.
- Namespaces direct-chat browser storage by native user and agent; late prior-user
  responses cannot replace the active thread. A user switch replaces the SDK core;
  each owned direct chat uses the public thread-scoped SDK agent API.
- Disables automatic greetings/briefs while retaining explicit user composition.
  `start.sh` refuses owned mode before secret rotation, Docker or process changes
  because that upstream development launcher owns a separate routines worker.

History remains owner-bound in this private slice. Shared-channel history,
multi-agent channel dispatch and tenant administration require their own
authorization adaptation, as does tenant partitioning of other app records,
before staff/customer rollout. Channel membership does
not override history ownership or the thread's pinned agent.

## Operator entry and current limits

Use [owned.env.example](owned.env.example) as an incomplete overlay. Provision a
separate PostgreSQL database/service identity, verified native authentication,
protected membership policy and matched database/encryption-key backups outside
Git. After reviewing and applying existing migrations, from `openbot/server`:

```sh
bun --env-file=../.env scripts/migrate.ts
bun --env-file=../.env src/production-entry.ts
```

Build/serve the existing app on the same authenticated origin using its scripts.
Server development and the container API service also use `production-entry.ts`.
This does not qualify the full upstream computer image for the Community host.
Owned startup closes its database/engine and prior listeners on failure; shutdown
closes listeners, producers and the database. No worker is imported by this entry.

**Production inference is unavailable in this slice.** Agents report that an
approved model route has not been configured. Tests inject a trusted synthetic
agent; HTTP cannot select that seam. No model key is read/created and no implicit
provider fallback is enabled. Reuse the owner's existing OpenRouter credential
through the forthcoming protected model port; do not copy it into source/chat.

## Evidence and next steps

Local Windows/Bun1.4.3 qualification used a digest-pinned, loopback-only,
resource-bounded PostgreSQL17/pgvector fixture with full platform migrations:

- 46 backend checks passed: 31 retained history cases and 15 owned app/config
  cases, with real SQL/app/public SDK and synthetic identities, policy and agent.
  The real production entry completed a native organization sign-in ticket/cookie
  exchange, restored persisted messages before/after process restart, denied a
  same-email foreign subject and refused a revoked authority session. A policy
  change during channel provisioning rolled back both channel and history.
- 21 UI checks passed together, including actual React hook failure/retry,
  identity-switch races, storage separation and remount. The route fixture mocks
  packaged chat; browser/private-device acceptance remains separate.
- Owned launcher refusal passed with no secret/process/Docker mutation; 28 native
  channel/organization regressions also passed. Earlier default config/same-origin
  regressions passed 164 checks. Server/app production TypeScript and scoped Biome
  passed. Build/test-type and exact-head CI results belong in the primary checkpoint.

This is synthetic source/runtime evidence, not Linode deployment, company SSO,
live inference/Odoo, shared access or the deferred physical PC-off acceptance.

1. Add the approved model port with native/tenant context-release policy, token,
   concurrency and cost caps, durable usage receipts and refusal paths. Adapt
   tool/source/record grants and AG-UI delegation without duplicating DSH.
2. Reconcile queue provenance and the Community host owner, then qualify private
   same-Linode capacity, HTTPS/SSO, backup/restore, rollback and live isolation.
3. Reconcile device ownership and validate MatePad/phone sign-in, history,
   reconnect and consent-bound actions before staff/customer invitations. The
   physical PC-off test remains deferred/unarmed.
