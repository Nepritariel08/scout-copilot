# Owned Scout native membership

`SCOUT_MEMBERSHIPS_FILE` is mandatory in owned mode. It names an absolute,
operator-protected JSON file outside source, independently of
`SCOUT_QUEUE_BINDINGS_FILE`, `SCOUT_MODEL_POLICY_FILE`,
`SCOUT_ODOO_BINDINGS_FILE` and Odoo context grants.
Verified authentication proves the native identity; this file grants current
tenant admission. No email, Entra group, browser header, queue requester, model
policy or Odoo key can substitute for it. Native roles and platform ownership
remain separate grants.
Owned mode also requires an explicit `DEPLOYMENT_ID` using 1–100 ASCII letters,
digits, `_` or `-`; it never infers deployment identity from the tenant package.
The membership file must match that exact configured deployment.

Start from [memberships.example.json](memberships.example.json). The example is
inactive and expired. Set the exact deployment ID used by the server, tenant ID
and preprovisioned native user ID, reviewed revisions, active flags and short
expiry. Do not insert a queue command, UID, credential path, `draftAnalysis`,
source scope or model capability in the membership file; extra fields fail.

The strict version-1 document contains `deploymentId`, `policies` and
`memberships`. Deployment/tenant IDs use 1–100 ASCII letters, digits, `_` or `-`.
Each tenant policy has `tenantId`, positive integer `revision`, `active` and ISO
`expiresAt`. Each membership has exact `userId` (1–200 characters without ASCII
spaces/control bytes), `tenantId`, positive integer `revision`, matching
`policyRevision`, `active` and ISO `expiresAt`. Each list has at most 100 entries;
empty lists grant nobody access. Duplicate tenants, duplicate users (even across
tenants), unknown tenants, malformed or unknown fields fail closed. The pilot
allows one tenant per native account; it has no implicit multi-tenant selector.

The reader reloads the file for every decision and requires an exact deployment
and native subject, both active and unexpired membership/tenant policy, and a
current tenant revision. It returns a domain-separated fingerprint of the
selected membership and tenant policy, including their revisions and expiry.
It returns no delegated authority. In-flight native history, scope and model
checks pin that fingerprint and withhold results after revocation or change.
Changing another user's grant does not rotate this user's fingerprint.

Readers reject relative paths, directories, final symlinks, replacement-file
identity changes during open, malformed JSON and files above 64 KiB. Unix files
must be owned by root or the service UID with no group/world permissions; use
0600 and a protected parent directory. Windows deployment still requires
independent owner/service-only ACL verification. The reader does not validate
Windows ACLs or every parent directory, and does not claim those guarantees.
Keep policy and deployment environment directories outside employee write
access; replace files atomically after review, preserving custody and rollback.

## Separate capabilities

With `SCOUT_DELEGATED_DRAFTS_ENABLED=false` (default), owned startup requires no
queue configuration, process command, Odoo UID, requester key file or
`draftAnalysis` grant. It constructs no queue service/connector. Identity,
channels and saved conversations can be qualified on their own. Inference still
requires a separate model grant. Selected Odoo context still requires its
separate source configuration, verified per-user credential, record grant and
provider-release consent. Membership cannot activate any of these.

Direct Odoo context additionally requires `SCOUT_ODOO_BINDINGS_FILE` and the
fixed `SCOUT_ODOO_CONTEXT_SOURCE_FILE`. The mapping schema is version 1 with
`deploymentId`, exact `sourceInstanceId` and at most 100 `bindings`, each containing
exact `userId`, `tenantId`, positive `revision`, `active`, ISO `expiresAt`,
non-superuser `sourceUid` (>1) and 1–100 unique positive `companyIds`. Duplicate
native users or sharing an Odoo UID across accounts are rejected. Unknown fields,
queue commands, API-key paths and role assertions are refused. See the inactive,
expired [example](odoo-bindings.example.json); its UID is illustrative and must
never be treated as a verified employee/customer mapping. The submitted user key
must independently prove its expected Odoo UID, internal-user status and absence
of administrator privileges. Customer access still needs its separately reviewed
record/company/project policy; this change grants no portal/admin fallback.

Odoo grants/credentials use a separate fingerprint combining current native
membership and the current Odoo mapping. Production context reads translate the
native principal to that source scope on every saved record/release/task read.
Removing, expiring, revoking or revising either policy therefore denies old
grants and withholds in-flight source results. Queue rotation has no effect on
that source scope. No extra grant table or migration is needed.

Authenticated members can still withdraw their own local Odoo record/release
grants and cached credentials across prior binding revisions for the fixed
configured source after its mapping or model route is withdrawn. DELETE accepts
no browser-selected source, UID or tenant. It preserves other users, tenants,
deployments and sources. Withdrawal is audited and never grants new rights or
revokes the upstream Odoo API key.

With delegated drafts explicitly enabled, `SCOUT_QUEUE_BINDINGS_FILE` is also
required. Its current independent draft-only grant must match native user,
tenant and deployment. The combined queue fingerprint pins both membership and
queue policy; either change prevents reuse of stale intent/review/receipt
authority. Both policies are rechecked after channel/database/RPC waits and
before external mutation. Changing queue requester/command/key-path authority
alone leaves the native membership fingerprint and unrelated model/Odoo grants
unchanged. Odoo requester visibility is still verified by the queue connector.

## Required migration from the previous source

There is no queue-schema fallback or automatic membership migration. Existing
owned environments that specify only `SCOUT_QUEUE_BINDINGS_FILE` refuse startup
until the separately reviewed `SCOUT_MEMBERSHIPS_FILE` is supplied. Provision its
native subjects/tenants from verified identity evidence; do not manufacture a UID
or key path to make native admission pass. For an identity/history-only pilot,
leave delegated drafts disabled and omit queue configuration and credentials.

Native fingerprints intentionally change from the former queue-derived values.
Existing fingerprint-bound Odoo record/context/provider-release grants and
credentials must be reviewed and reissued against the current native membership;
they fail closed until then. Do not rewrite grant fingerprint columns to bypass
verification. A membership revision/tenant reassignment likewise invalidates
the old Odoo grant. Provision the separate reviewed Odoo identity mapping before
reissuing; a queue requester can no longer supply it. Model policy remains
independently reviewed and must match
the current user/tenant/deployment; an in-flight model run stops on membership
change. Native conversation/resource ownership is not reassigned by migration.

Queue intent fingerprints also change to the combined admission digest. Do not
rebind stored queue tasks or replay their old source keys automatically. Reconcile
existing in-flight work and human-review receipts with the queue owner before
enabling drafts; source validation is not deployment or live acceptance.
