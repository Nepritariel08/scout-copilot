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
queue as delegated execution. MatePad is also the proposed consent-bound local
model/execution node; verify its actual model and unattended behavior. Shared
durable storage remains on Linode and survives a tablet or controller disconnect.

The owner's lean split supersedes the earlier untested 16 GB growth allowance.
Retain the current 8 GB / 4 vCPU host for the bounded private pilot. Measure
Scout resource use, Odoo/database latency, storage growth and actual concurrency
before resizing or widening access. No infrastructure change was made.

OpenRouter inference needs no local GPU. Benchmark a suitable MatePad model
before considering additional inference hardware; deterministic repetitive
tasks should use ordinary code first. See [model routing](OWNED-MODEL.md).
The first owned implementation can use systemd and PostgreSQL; no additional
scheduler or managed memory service is required for this persistence slice.

## Same app, explicit authority

Owned startup opens independent bounded SQL clients for application data (7)
and native identity (1), plus the existing separate `LISTEN` client (1): nine
configured connections per process. Fresh identity/role checks can run while a
data transaction waits on consent validation. `createOwnedApplication` requires
its caller to supply `options.identityDatabase` with a distinct SQL client and
rejects a missing/shared client before database work. Merely wrapping the same
client twice does not isolate its pool. Only the explicit trusted synthetic
`options.auth` test seam may omit the identity database; production supplies no
issuer override. Every existing native-auth dependency, including exact Entra
mapping, organization materialization, revocation and auth audit, uses the
identity client. No authentication checks or tenant/source/model grants are
cached, removed or broadened by this split. The default licensed composition is
unchanged. See the [pilot connection budget](PRIVATE-PILOT-DEPLOYMENT.md).

Owned mode already refuses SCIM routes and does not provide tenant-aware
directory provisioning. It now also refuses startup/direct identity assembly
when the server's actual `SCIM_BEARER_TOKEN` environment value is configured.
Unset it for owned mode; this is an explicit unsupported-capability/configuration
mismatch, not a way to enable directory administration. This early refusal
precedes database acquisition/work and avoids installing SCIM interactive
transactions whose native hooks can reenter the one-connection identity pool.
The default licensed authentication/SCIM implementation is unchanged.

The pool regression includes bounded synthetic saturation/lifecycle checks and a
separate PostgreSQL test using real native Better Auth session/Entra/role reads
inside the actual consent route and grant transaction with `max: 1` clients.
The latter uses explicitly seeded synthetic signed sessions and policies; it is
not a live Entra sign-in or provider test. It requires a dedicated migrated
`TEST_DATABASE_URL` and never falls back to the application database. SQL CI and
runtime connection readback remain required before deployment; local synthetic
pool checks alone do not qualify the database transaction path.

- Reuses `createApp`, native authentication/people/roles, profiles, channels,
  audit/credential administration, preferences, onboarding, pages and the DSH
  requester. No Intelligence client or second background scheduler is created.
  Global administration remains a platform-owner function, as detailed below.
- Requires sign-in plus protected current native `SCOUT_MEMBERSHIPS_FILE` policy,
  independent of queue commands/requester keys and draft capabilities. The queue
  is optional and separately admitted. See [membership and migration](MEMBERSHIP.md).
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

Owned source now applies immutable `scout_resource_scopes` to native agents,
channels and pages. SQL intersects deployment/tenant scope with existing private/
public/owner, channel membership and page-owner rules before pagination or
disclosure. Channel attachments inherit their channel's scope and retain native
uploader/sent-file restrictions, including HEAD and conditional reads. New
resources receive their scope on the creation transaction; unscoped legacy rows
are denied rather than claimed by the next reader. Curated package agents may
be read as deployment templates under native access rules, but template grants
do not authorize configuration writes or another tenant's channels. Native
membership locks and current-binding checks protect dependent writes and queued
work; websocket delivery revalidates the opening native session and channel grant.

Standing instructions use `(deploymentId, tenantId, userId)` storage in owned
mode, with no fallback to the old global-user row. Reassigning a subject to
another tenant does not transfer old instructions, conversations, pages or
channels. The protected model policy must also explicitly permit release of
personal instructions; instructions never grant tool or record access.

History remains owner-bound. Shared-channel history, multi-agent dispatch,
tenant-specific administration and record/source/tool grants still require
their own adaptations before staff/customer rollout. Native channel membership
does not override history ownership or the thread's pinned agent. These source
controls are not evidence that every enterprise workflow has been qualified.

## Platform ownership and identity administration

The selected [owned Microsoft Entra adapter](OWNED-ENTRA.md) uses one exact
resource tenant and the Better Auth callback through native authorization-code
authentication. Enrollment is closed: provision the exact issuer/`oid`/native
user account before login, then assign native role, platform owner and current
tenant grants separately. Verified `tid`, `oid`, issuer, audience, state, PKCE
and nonce establish the identity mapping; email or proxy headers do not. Source
qualification does not establish the live application registration, credentials,
HTTPS ingress or owner acceptance. The legacy [Auth0 adapter](OWNED-AUTH0.md)
remains documented for existing deployments only.

`SCOUT_PLATFORM_OWNER_IDS` is a comma-separated list of exact verified native
subject IDs, not email addresses, domains, display names or roles. Whitespace
around entries is trimmed; empty entries are discarded. The list allows at most
100 unique IDs, each at most 200 characters without ASCII spaces/control bytes.
Its empty default gives nobody platform administration. An ID on the list must
also possess the native `admin` role and current protected tenant membership;
the list does not elevate an ordinary user. A native admin absent from this list
is exposed to owned routes as a user, so a tenant's admin cannot inherit global
people, credential, audit or enterprise administration.

All seven SSO management paths require this platform-owner boundary before the
native auth handler:

- `/api/auth/sso/register`
- `/api/auth/sso/update-provider`
- `/api/auth/sso/delete-provider`
- `/api/auth/sso/providers`
- `/api/auth/sso/get-provider`
- `/api/auth/sso/request-domain-verification`
- `/api/auth/sso/verify-domain`

OIDC callbacks and the allowlisted SAML metadata/ACS/SLO/logout protocol routes remain authentication
flows; this allowlist is not a blanket grant to arbitrary SSO endpoints.

Unadapted `/api/auth/admin` and SCIM paths are unavailable in owned mode,
including SCIM PUT/PATCH/DELETE. This is not a tenant-aware directory provisioning
implementation. Remote-agent connection probes, bearer-only machine callbacks
and remote-agent execution remain unavailable until a named-service, tenant-bound
adapter is qualified. Local token issuance is not proof that a remote callback
can authenticate. Native business administration and customer self-service need
their own approved, resource-scoped flows; do not grant platform ownership as a
shortcut. The default licensed composition retains its existing behavior.

Native account token export/refresh, provider account-info and account listing
are also unavailable through the owned auth handler. Native login/callback and
session management remain identity flows; login credentials must not become an
unqualified connector or provider-context route. Optional upstream memory,
routine, proactive, tool, plugin and device APIs are not installed by the owned
application composition; their availability requires separate scoped adapters.

## Operator entry and current limits

Owned pilot admission permits an explicit API/auth method and path inventory
before public or feature handlers can dispatch. It supplements native identity,
tenant, resource and platform-owner checks. New optional adapters remain
unavailable until admitted and qualified. Canonical login/session protocols and
the direct-only first-day conversation path remain available.

`SCOUT_DELEGATED_DRAFTS_ENABLED` defaults to false. Keep it false until the
selected deployed queue's Scout provenance and live contract pass. The browser
reads the server capability and offers no submission controls or queue requests
while unavailable; ordinary chat remains independent. An explicit true enables
only the existing protected requester contract, never another worker.

The concrete same-Linode preparation, ownership claim, service/resource limits,
backup/restore and rollback packet is [PRIVATE-PILOT-DEPLOYMENT.md](PRIVATE-PILOT-DEPLOYMENT.md).
It is prepared source, not an executed installation.

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

**The original PR3 slice left inference unavailable.** The subsequent protected
[model port](OWNED-MODEL.md) adds explicit OpenRouter/local chat completions,
native identity/context policy and durable quotas/receipts. An absent policy
still keeps agents unavailable. Its synthetic SQL/SDK qualification is separate
from real credentials, live inference and deployment. Reuse the owner's existing
credential only through the protected deployment path; never source or chat.

## Evidence and next steps

The original runtime slice's local Windows/Bun1.4.3 qualification used a
digest-pinned, loopback-only, resource-bounded PostgreSQL17/pgvector fixture with
full platform migrations:

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
The subsequent model/scope work also uses a separate PostgreSQL18.6 fixture to
exercise the host's major version; integrated counts and exact-head CI remain
in the primary checkpoint. A local fixture does not migrate the production host.

1. Qualify the implemented model port and native tenant scopes together. Add
   tool/source/record grants, tenant administration and AG-UI delegation without
   duplicating DSH; retain exact approval/revision/readback gates for actions.
2. Reconcile queue provenance and the Community host owner, then qualify private
   same-Linode capacity, HTTPS/SSO, backup/restore, rollback and live isolation.
3. Reconcile device ownership and validate MatePad/phone sign-in, history,
   reconnect and consent-bound actions before staff/customer invitations. The
   physical PC-off test remains deferred/unarmed.
