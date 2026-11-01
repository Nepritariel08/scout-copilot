# Entra identity operator: prepare contact, bind and withdraw

This source-only operator tool supplies the exact account-mapping step in
[OWNED-ENTRA.md](OWNED-ENTRA.md). It has not run against a live database,
directory or deployed Scout. The primary work record remains
[SSC AI Enablement #4](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4).
Shared access and deployment retain their separate qualification requirements.

## Authority and prerequisites

The `enroll` action binds an **existing, exactly reviewed native user** to one
resource tenant's Microsoft Entra object. If that exact native contact does not
exist, a separate `create_contact` action can prepare it under its own reviewed
plan. Contact creation never binds an identity or grants access. Do not create a
placeholder person or copy an employee/owner account to get through the preview.
The tool never reconciles legacy accounts, selects an identity by email,
invites guests, registers an app or calls Microsoft.

An authorized operator must independently verify the database/host and native
user/contact, resource tenant GUID, resource-tenant `oid`, and owner-reviewed
change reference. For a customer this means the redeemed resource-directory
B2B guest object, not its home-directory object or an email/UPN. Neither this
JSON request nor its review-reference string proves authorization or directory
identity. Possession of the protected database connection is privileged
maintenance access. This is a local operator program, absent from Scout's HTTP,
model/tool and startup composition.

The tool never grants native roles, groups, platform-owner configuration,
membership policy, Odoo/company/project grants, provider-release consent or
credentials. An Entra mapping grants authentication only. It is not full user
onboarding, employee access acceptance or customer isolation. Separate reviewed
grants and acceptance remain required even after the mapping is installed.
Contact creation writes only the exact native ID/email/name and fixed normal
defaults: unverified email, empty groups/preferences, null image/last-sign-in/
onboarding completion, and onboarding step zero. There is no password, token,
account row, session, role or implicit tenant membership.

Run only on the qualified Linux release with Bun 1.4.3, reviewed migrations
through issuer-account uniqueness, protected database custody and released
maintenance ownership. An existing Microsoft/other-provider account, legacy
pairwise `sub`/null issuer or another user's matching object is a conflict to
reconcile separately from trusted identity evidence. This tool will not fix it
by email, relink it, or delete an unknown identity. A natively revoked contact
is also refused; this tool cannot restore it.

Prepare a dedicated protected operator environment file with only:

```text
SCOUT_RUNTIME_MODE=owned
DATABASE_URL=<protected connection to the exact Scout-only database>
MICROSOFT_OAUTH_TENANT_ID=<verified lowercase resource-tenant GUID>
```

The database URL is read from the environment, never a command argument or
log. Do not provide a provider key, password, client secret or token to this
program. `OPENBOT_ORGANIZATION_AUTH_URL` must be unset. The database role needs
the existing identity/session/audit table privileges and PostgreSQL table-lock
rights; no role or privilege is created by the tool. Verify that this is the
dedicated Scout database, not Odoo or a copied development connection. The
request must match `current_database()` and `current_user`; the preview also
binds the server address/port observed on that connection. These checks do not
replace the operator's verified host/database custody.

## Review request

Store the request privately, for example under a newly prepared
`/var/lib/scout-pilot/entra-operator/` directory. The directory and every parent
must be real directories owned by root or the operator, with no group/other
write bit. Input/plan files must be regular files owned by root or the operator,
with mode 0600 or stricter. Symlink paths are refused. The CLI refuses Windows
and macOS because their native ACL protections are not implemented here.

Use `create_contact` only when the exact reviewed native ID and its email are
both absent. The case-insensitive email check is a conflict check, not an
account lookup or relink. It rejects existing IDs even when the contact text
matches, addresses already used under any casing, and revoked addresses.
The request has no issuer/object, role, group, verification flag or other
custom-default fields; unknown fields fail closed. The configured resource
tenant still scopes this operator action but grants no authentication.

This deliberately synthetic contact request is not a deployment payload:

```json
{
  "version": 1,
  "operationId": "d7fda99e-e51a-4ec8-8c64-f2b3b95bd6a0",
  "action": "create_contact",
  "target": { "database": "scout_pilot", "role": "scout_operator" },
  "tenantId": "8f2c1e40-0000-0000-0000-000000000000",
  "nativeUser": {
    "id": "synthetic-new-reviewed-native-user",
    "email": "synthetic-new@fixture.invalid",
    "name": "Synthetic reviewed contact"
  },
  "review": {
    "operatorUserId": "synthetic-operator",
    "reference": "synthetic-approved-contact-change/42"
  }
}
```

Preview and explicitly approve that contact plan using the commands below.
The only selected effect is `insert_contact`. If the intended person already
exists, preserve that person's native ID/history and use a separately reviewed
enrollment request instead. Never use contact creation to replace, restore,
adopt or rename an existing person.

After a new contact is created, use a **new operation ID and separate reviewed
enrollment plan** for the immutable resource-tenant issuer/OID binding. The
following deliberately synthetic shape is not a deployment payload:

```json
{
  "version": 1,
  "operationId": "985720cc-e7a7-4da8-9704-de86891a20c3",
  "action": "enroll",
  "target": { "database": "scout_pilot", "role": "scout_operator" },
  "tenantId": "8f2c1e40-0000-0000-0000-000000000000",
  "issuer": "https://login.microsoftonline.com/8f2c1e40-0000-0000-0000-000000000000/v2.0",
  "objectId": "4e70e6f1-0000-0000-0000-000000000000",
  "nativeUser": {
    "id": "synthetic-new-reviewed-native-user",
    "email": "synthetic-new@fixture.invalid",
    "name": "Synthetic reviewed contact"
  },
  "review": {
    "operatorUserId": "synthetic-operator",
    "reference": "synthetic-approved-change/42"
  }
}
```

For enrollment/withdrawal, the exact native ID, email and name must match the
existing contact. A null name is supported for either contact action. Values
are not rewritten or normalized, and email never selects an identity. GUIDs must be
lowercase; the exact issuer is derived from and checked against the configured
tenant. Unknown fields, including roles/credentials/membership, are refused.
There is one contact or requested identity per operation, no batch. Use a new
UUID for each reviewed operation; an old operation ID cannot name a new plan.

## Preview and explicit apply

From the reviewed release's `openbot/server` directory:

```sh
bun --env-file=/etc/scout-pilot/entra-operator.env \
  scripts/scout-entra-operator.ts preview \
  --request /var/lib/scout-pilot/entra-operator/request.json \
  --plan /var/lib/scout-pilot/entra-operator/new-plan.json
```

Omitting `preview` also selects preview. It opens a read-only repeatable-read
transaction and writes no database state. It creates a new mode-0600 plan file
exclusively, refusing to overwrite a previous artifact. Standard output contains
only the effect, 15-minute expiry and SHA-256 digest of the canonical plan. The
plan includes the exact reviewed contact and identity, so retain it privately
and do not paste it into source, logs or chat.

Review the request inside the plan, selected effect, expiry and digest against
the actual owner-approved change. Only after that review, use the exact emitted
digest as the non-secret `--approve` argument:

```sh
bun --env-file=/etc/scout-pilot/entra-operator.env \
  scripts/scout-entra-operator.ts apply \
  --plan /var/lib/scout-pilot/entra-operator/new-plan.json \
  --approve REPLACE_WITH_EXACT_REVIEWED_64_CHARACTER_DIGEST
```

An altered, expired or future-dated plan is refused. Apply obtains fresh
database state inside a new transaction and refuses a changed contact, account,
session inventory or database target. Preview again under a new operation ID
after reconciling the actual change; do not edit the observed fingerprint to
make an old plan pass. A name/role string in the request is never verified
operator authentication; the audit correctly attributes this maintenance
operation to the deployment and stores only hashes for the supplied operator
and change reference.

## Transaction, retries and withdrawal

Apply takes short `SHARE ROW EXCLUSIVE` locks on `users`, `accounts`, `sessions`,
`revoked_access` and `user_roles`, then rechecks the state. The role table is
read/locked to fence the contact's no-role postcondition, never written. These
locks fence native writers that do not participate in an operator advisory-lock
protocol and cover
absent account/session rows. They temporarily block writes to those tables, so
schedule the operation under bounded identity maintenance with sign-in/callback
traffic quiesced. Lock acquisition times out after three seconds and individual
statements after five seconds; a failure rolls back. There is no automatic
retry, migration, service restart or background process.
Both transaction paths explicitly use the existing `public` identity tables,
with `pg_catalog, public` as their local search path; an alternate-schema
deployment is not supported by this operator tool.

Contact creation inserts only its reviewed `users` row and verifies its fixed
defaults, absence of role/account/session and unique case-insensitive email
before recording the receipt. Contact insertion and audit commit together;
any mismatch or audit error rolls back the new contact. It never deletes an
existing row or session. Its redacted receipt kind is
`scout.native.contact.operation.v1`; enrollment/withdrawal retain
`scout.entra.identity.operation.v1` and their existing strict payload shape.

New enrollment inserts only the Microsoft provider/issuer/OID/native-user row,
with no password or provider tokens, and deletes prior Scout sessions so old
cookies cannot inherit the new identity binding. If the exact binding already
exists, enrollment records an unchanged-binding result and preserves sessions.
Withdrawal uses a **new reviewed request** with `action: "withdraw"`; it removes
only the exact binding and deletes every session for that native user, including
orphan sessions when the binding is already absent. It retains the local
contact, roles, history and all separately governed grants. Full offboarding
must separately withdraw those grants and any upstream identity access.

Mutation, any required session deletion and a redacted append-only `configuration.changed`
receipt with target `scout_entra_identity_operation` commit together. A failed
audit insert rolls back the entire operation. The receipt records plan/request
digests, effect and removed-session count, without raw tenant/OID/contact,
tokens or connection values. Retain the private plan and external approval
evidence to resolve those hashes. The normal success output is also redacted.
Failures expose a stable refusal code, never a database-driver exception.

Within the plan's validity window, retrying that same plan/digest returns its
one receipt without another account, audit row or session deletion, provided
the resulting state still matches. Contact retry requires the exact unchanged
contact/defaults/timestamps and no new roles/accounts/sessions or duplicate email;
later enrollment or onboarding therefore causes a refusal, never a reset.
A withdrawal retry also requires no
sessions to have reappeared. Conflicting operation reuse or a changed
postcondition is refused for reconciliation. A timed-out/disconnected apply
has an unknown commit outcome until the same exact-plan retry reads the
receipt; do not blindly submit a fresh operation.

The locks prove transaction-time state, not that an old callback can never
finish afterward. The closed Entra adapter rechecks the live mapping on
authoritative session reads; removing the mapping makes such sessions
unusable. Keep sign-in quiesced for cutover and verify retained old cookies
are refused after withdrawal. Do not route Entra traffic to an older adapter
that lacks that check. Directory invitations, token invalidation at Microsoft,
native callback configuration and real browser/device acceptance remain
separate tasks.

## Validation boundary

Focused pure/CLI tests exercise exact-contact/tenant admission, conflicting
provider/issuer/OID/native identities, legacy denial, approval/stale/expired
plans, idempotent retry, withdrawal and rollback with an in-memory transaction
fixture. Contact tests additionally cover strict no-grant payloads, existing or
revoked contact refusal, stale target/email state, exact replay, later-onboarding
refusal and rollback. PostgreSQL integration tests use only `TEST_DATABASE_URL` through the
existing dedicated-database guard. They exercise the actual account reader,
no privilege/Odoo/release-grant changes, isolated session deletion, concurrent
retry, native-writer lock fencing and rollback after an actual audit insert.
There is no fallback to `DATABASE_URL`.

The local SQL tests have not run: no verified dedicated synthetic database was
available, and existing PostgreSQL listeners belong to another lane. Root must
obtain exact-head PostgreSQL CI and independent review before release. These
tests do not prove live Entra, target-host custody, customer record access,
production migration or deployed operator acceptance.

Local Bun 1.4.3 qualification used an isolated fresh frozen install with
`--ignore-scripts` (1,177 packages), without dependency junctions or lockfile
changes. The operator's 47 unit/CLI tests passed with 156 assertions; the combined
operator, Entra and membership boundary suites passed 66 tests with 210 assertions.
The full production server typecheck, both operator test files' focused TypeScript
dependency graph, scoped Biome and whitespace checks passed. Exact-head CI,
including the dedicated PostgreSQL suites, remains required before release.
No live identity, provider, model or host operation was executed.
