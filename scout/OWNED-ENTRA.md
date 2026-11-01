# Microsoft Entra sign-in for owned Scout

This is the selected identity route for Scout employees and invited customers.
It is a source-level design and implementation guide; no Entra app registration,
tenant credentials, invitation, account mapping, deployment or live login has
been performed. The [private deployment packet](PRIVATE-PILOT-DEPLOYMENT.md)
remains the authority for host ownership, release, ingress, rollback and runtime
acceptance.

## Directory and application

Use one Microsoft Entra workforce tenant as Scout's resource tenant. Employees
sign in as members of that directory. Customers must first be invited and
redeem an Entra B2B guest invitation in that same directory; their home identity
provider can authenticate them, while Scout receives the resource tenant's
guest object. Entra's B2B directory object and authentication flow are described
in Microsoft's [B2B collaboration guidance](https://learn.microsoft.com/en-us/entra/external-id/what-is-b2b).

Register one confidential web application for the approved OpenDuet origin.
The requested `scout.somethingsomewhere.ph` hostname is already associated in
deployment history with the older authenticated Scout Console route through
Caddy and an OAuth2 proxy. The current read-only check confirms it resolves to
the shared Linode and redirects HTTP to HTTPS. A current Node/OpenSSL probe
receives a fatal TLS `internal_error` alert; the Windows Schannel probe also
fails inside the local security subsystem, so the active certificate and
application route are not verified. Do not switch the root route or register a
new callback on it until the current host owner verifies the route and releases
or migrates that ingress. A separately approved subdomain can avoid that
collision. Once the origin is approved, set the redirect URI to its exact Better Auth callback
`<BETTER_AUTH_URL>/api/auth/callback/microsoft`. Do not register a wildcard or
use an incoming Host header to construct this value. The application must be
single-tenant; its credentials must be delivered through protected
deployment-secret custody.

The incomplete [owned environment overlay](owned.env.example) uses:

| Variable | Requirement |
| --- | --- |
| `SCOUT_RUNTIME_MODE` | `owned`. |
| `MICROSOFT_OAUTH_TENANT_ID` | Exact resource-tenant GUID; `common`, `organizations` and `consumers` are refused. |
| `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET` | Paired application values from protected custody; never place them in Git, chat, logs or fixtures. |
| `BETTER_AUTH_URL` | Exact owner-approved OpenDuet origin after resolving the existing Scout Console route. |
| `BETTER_AUTH_SECRET` | Protected native session secret of at least 32 characters. Preserve it with the matching Scout database backup. |
| `TRUSTED_ORIGINS` | Exact approved browser origin; no wildcard. |
| `INITIAL_ADMIN_EMAILS` | Exact locally provisioned admin contact address. This is a role-seeding setting, not an identity key. |

## Identity and enrollment

Owned Scout uses Better Auth 1.7.1's tenant-specific `microsoftEntraId` generic
OAuth helper under the existing `microsoft` provider ID. It uses server-started
authorization code with PKCE, native state and nonce, verified tenant-specific
OIDC discovery/JWKS, and the default callback route. The owned adapter also
checks exact issuer, audience, `tid`, `oid`, token lifetime and native nonce.
Better Auth's pinned provider uses Entra's immutable `oid`; Microsoft's claims
guidance recommends `tid` with `oid` when identity must be consistent across
services, and says guest identities should be scoped to the tenant where the
guest was invited. [ID token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)

Before a person can sign in, an authorized Scout operator must create their
native `users` row and the exact identity binding:

| `accounts` field | Value |
| --- | --- |
| `provider_id` | `microsoft` |
| `issuer` | `https://login.microsoftonline.com/<tenant-guid>/v2.0` for the resource tenant |
| `account_id` | The verified resource-tenant `oid` GUID |
| `user_id` | The already approved local Scout user ID |

The exact tenant `tid` is represented by the issuer, and `oid` remains the
Better Auth account key. Sign-in requires this exact provider/issuer/object
binding and rechecks it before session creation. A matching email or UPN is not
enough. The local preprovisioned email is contact/display data only; Entra
email and `preferred_username` can be absent or change. New-user signup,
implicit linking, account linking and client-posted ID-token login are disabled
for the owned Entra adapter. An unmapped identity is refused.

The binding grants authentication only. Assign each person's native role,
platform-owner status, Scout tenant membership and Odoo requester/company scope
as separate reviewed grants. Entra guest membership alone must never create an
Odoo grant. Do not derive DSH's fixed requester UID/company from an employee's
or customer's Entra claims. The current DSH requester remains a separate
server-side integration principal.

Migration `0073` adds the `(issuer, account_id)` unique index while retaining
the existing `(provider_id, account_id)` index. The issuer column stays nullable
through mixed-version rollout because older replicas do not write it; the old
index remains the duplicate guard for those rows. Removing that legacy index is
a later schema change, and only after runtime readback verifies that no old
replica remains. Migration `0073` also stops if duplicate non-null issuer/object
pairs already exist; reconcile only from trusted identity evidence, never by
email. While the legacy index remains, the schema also forbids the same provider
and account ID under two issuers. That is compatible with this single-resource-
tenant route; multi-issuer reuse of one provider ID would need a later, separately
qualified index-removal migration after every old writer is gone.

Identity code needs a gated cutover even though the additive schema supports
mixed-version writes. Older Scout binaries register Microsoft as the ordinary
social provider and do not enforce the preprovisioned OID binding. Do not send
Entra callback or sign-in traffic to an old replica. Keep the Entra callback
blocked or use an isolated new pool until every serving instance is verified to
run this closed adapter; enable the Entra credentials only for that pool. On
rollback, block Entra sign-in before routing traffic to an older binary. Verify
the active image/version and ingress route, not just the migration journal.

Provisioning order for a new customer is: invite and redeem the guest in Entra;
review/create the local Scout account and immutable Entra mapping; separately
grant the intended Scout tenant, role and record scope; then test with a
synthetic or explicitly approved customer account. Removing a guest or Scout
mapping must revoke future sign-in and separately remove active Scout sessions
and tenant/record grants under the qualified offboarding workflow.

## Acceptance still required

The source tests do not establish the live tenant, app registration or credentials.
Before activation, the owner must verify the actual tenant GUID, application
account type, protected secret custody, exact HTTPS callback registration,
guest invitation/redeeming policy, conditional access/MFA, and an owner-approved
mapping. Revoke all active Scout sessions created under the prior identity
configuration immediately before cutover, and verify that a retained old cookie
is refused afterward. The adapter also rechecks the exact issuer/OID mapping on
each authoritative session read, including reads served from cookie cache. Audit
existing Microsoft account rows before enabling this route:
Better Auth 1.7 uses `oid` as the account key, while older rows may hold a
pairwise `sub`. Reconcile any such row only from a verified Entra token or
trusted directory export; never relink by email. Then run the real callback
against a preprovisioned synthetic test identity, verify native
user/account/role/session readback, prove unmapped and revoked identities fail,
and record the expected tenant and requester boundary.
Do not create or change an Entra registration or invite users from this source
change.
