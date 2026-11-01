# Invited customer project-task context

This source candidate adds a separate portal-customer adapter to the same Scout
task-context and provider-consent UI. It does not activate shared access or change
the owner-private deployment defaults. The primary outcome is still
[SSC AI Enablement #4](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4).

## Odoo 20 feasibility and selected boundary

The official Odoo 20
[project access rules](https://github.com/odoo/odoo/blob/20.0/addons/project/security/ir.access.csv)
grant portal project reads through the current user's invited collaboration.
Task rules additionally consider portal visibility, active/template state and
collaboration or task followers. Company restrictions remain a separate rule.
The official
[collaborator model](https://github.com/odoo/odoo/blob/20.0/addons/project/models/project_collaborator.py)
defines `view`, `edit` and `advanced_edit`; this read-only slice needs only
`view`. A customer's company or email is not an authorization relationship.

The [JSON-2 controller](https://github.com/odoo/odoo/blob/20.0/addons/rpc/controllers/json2.py)
uses bearer authentication and calls the selected public method in that user's
environment. Scout sends the individual's mapped API key and only fixed
read-only methods/fields, leaving Odoo ACLs, field access and record rules in
force. It uses no administrator fallback, sudo, portal access-token URL or
source-side permission changes. API-key issuance, supported JSON-2 access and
the actual installed Odoo build still need independent qualification.

Scout deliberately requires **current project collaboration**, even where Odoo
task-follower rules alone would permit a task. The new adapter positively checks
`base.group_portal` and refuses internal, system and settings-administrator
groups, using literal boolean responses. It verifies the key's actual UID,
derives visible projects under trusted allowed-company context, and intersects
that result with the saved grant. It repeats identity/classification and project
access after reading the task. Removing collaboration therefore denies an old
grant even when a task follower remains. The existing employee reader retains
its positive internal-user requirement and portal/admin refusal.

## Trusted provisioning and migration

1. Use the existing closed Entra flow for the invited resource-tenant guest and
   exact native issuer/OID mapping. Current protected native membership is an
   independent prerequisite; neither a guest invitation nor an Odoo key admits
   the user to Scout.
2. Independently verify the customer's own nonadministrator portal UID, source
   instance and company scope. In that user's existing protected
   `SCOUT_ODOO_BINDINGS_FILE` entry, explicitly add
   `"identityClass": "customer"`. Unknown classification values fail closed.
   Missing classification retains the employee-only path. There is no client,
   prompt, request header, partner ID or model argument that selects this path.
3. Through the existing authenticated Odoo setup UI, submit only that mapped
   user's API key. The server selects customer qualification from protected
   admission, discovers the user's current project scope, and issues the same
   short-lived record grant and encrypted credential. A mapping or membership
   change during qualification refuses the grant.
4. Separately review the displayed provider/model and explicitly consent to
   release the existing fixed task-summary data class. Select one task using the
   same web/mobile UI. Native membership, Odoo mapping, grant, release policy,
   key identity and Odoo access are checked again before context release.

No database schema migration is needed. The protected mapping is already part
of the source-admission fingerprint, so adding/removing customer classification
invalidates prior fingerprint-bound grants and credentials. Re-enroll the key
and explicitly reissue provider consent; do not edit old grants or copy an
employee's rows. The existing `verified_nonadmin` ledger value is a qualification
attestation, not an employee role or a substitute for live portal checks. Audit
and vault metadata record customer classification without raw key material.
Withdrawal continues to retire the current native user's grants and credentials
across old binding revisions under the existing membership requirement.

## Qualification and remaining scope

Pure tests cover positive and negative same-company customer reads, strict
fixed methods/fields, UID mismatch, malformed group responses, current project
withdrawal, identity-class change, protected selection, fingerprint rotation,
missing customer adapters, provider-consent absence and native/source revocation.
The existing isolated [pinned Odoo 20 harness](ODOO20-QUALIFICATION.md) additionally
creates two synthetic invited portal collaborators in separate projects of the
same company. It exercises real JSON-2/ORM reads, cross-customer denials,
withdrawal with retained followers and portal-to-internal changes, while keeping
the employee reader's portal-refusal scenarios. Exact-head CI must run that
harness; no local Docker, production key, real customer data or live model test
is claimed.

Local qualification used Bun 1.4.3 and an isolated frozen install with lifecycle
scripts disabled (1,177 packages, no lockfile change). Seven focused suites
passed 102 tests with 1,518 assertions. The production server and the six changed
test files' focused TypeScript graph, 15-file Biome and whitespace checks passed.
The disposable Odoo seed and workflow passed syntax parsing only; their runtime,
the composed-app PostgreSQL cases and exact-head CI remain unrun locally.

This is one fixed project-task summary, not general customer search, document
retrieval, attachments/files, customer-visible citations/exports, shared-channel
history, cache or memory revocation, business writes, or device execution.
Its source/fixture success does not establish complete customer isolation,
live Entra provisioning, production Odoo applicability or shared-access acceptance.
Keep the architecture's separate customer zone and full acceptance matrix until
their own evidence is recorded.
