# Scout own identity attestation for Odoo 20

This MIT addon extends `res.users` with one read-only, model-level JSON-2 method:
`scout_own_identity_v1`. The request body is exactly `{}`. JSON-2 rejects record
IDs and unknown UID/group/company arguments. Its versioned response contains
only the authenticated Odoo UID and four literal effective-group booleans:
portal, internal user, system administrator and access-rights administrator.

Odoo 20's stock `has_group` can read a filtered empty relation for portal users,
who lack `res.groups` read access. The addon reads only the authenticated user's
effective group relation with sudo and clears caller context. It avoids the
`has_group`/`_get_group_ids` registry cache, whose user-ID-only key can retain a
filtered result. It exposes no group enumeration, arbitrary user lookup, HTTP
controller, model ACL, role grant, credential, company, contact or business data.
It performs no writes and does not change stock `has_group` behavior.

Scout still verifies `context_get` UID separately, requires exact response shape
and contract version, and positively requires portal=true with the other three
groups=false. Missing addon, wrong UID/version, malformed or extra fields, and
any denied classification fail before project/task reads. Every project/task
read continues with the customer's bearer key and normal Odoo ACLs/record rules.
Attestation does not repair or clear Odoo's caches. If a cached group result makes
Odoo deny a project/task read, Scout denies that request too. This is a residual
availability constraint, not permission to bypass ACLs. The local mock proves
that refusal; actual cache and caller-ACL behavior needs exact-image evidence.

The disposable pinned-Odoo qualification mounts this directory read-only and
installs the addon only in its synthetic database. Its Odoo transaction test
reproduces inaccessible groups and cached false stock membership, checks exact
own attestation without account/group/key changes, then checks a current role
change. JSON-2 integration additionally rejects caller-selected identities and
qualifies same-company customer ACLs and revocation. These actual Odoo tests
remain pending until the exact-head workflow succeeds.

Production installation is a separate operator prerequisite: verify exact Odoo
20 build, database, source checksum, addon paths, backup and rollback scope,
then use the established Odoo deployment owner. This source preparation does
not install an addon, change permissions, issue keys or activate customer access.
Existing native membership, trusted customer mapping, key enrollment, saved
record grant and explicit model/provider release remain independent requirements.
