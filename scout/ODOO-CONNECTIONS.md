# Owned Odoo connection controls

In owned mode, Connections includes Odoo setup using the same `ScoutOdooContext`
form, encrypted credential enrollment, status, model-release consent and revoke
APIs already used by chat. Choose an accessible built-in Scout profile explicitly.
The page checks that profile's current model route; a denied profile stays denied
instead of falling back to another profile. Other work apps remain honestly
disconnected, and signing in to Scout is separate from granting work-app access.

The connection-only form omits task selection. In chat, its original default mode
still selects one Odoo task for one explicit send. Connections does not create a
conversation, select a task or submit/accept a DSH draft. Saving/revoking Odoo
access applies to the current native account; model-release consent names the
selected profile and the exact displayed provider/model/policy fingerprint.

Existing server identity mapping, source ACL checks, encrypted storage, grant
expiry (up to12 hours), release expiry and immutable history dependencies are
unchanged. Refresh only reads status. Revoking Scout access does not invalidate
the upstream Odoo key; revoke that key in Odoo when required.

The profile query and form are keyed by the mapped native account/profile.
Switching either clears unsent input and discards late action notices. A failed
status refresh removes cached active/sharing controls rather than presenting them
as current authorization. Keys travel once in the original authenticated API body
and are cleared; they are not stored in browser storage or query/mutation state.

Focused validation uses synthetic keys/status responses in
`app/tests/owned-odoo-connections.test.tsx`, plus the existing Odoo chat-context
and capability-page suites. The tests verify original status/save/release/revoke
wire shapes, profile403/404 refusals, native account/profile changes, late replies,
expiry and the absence of automatic sends or plugin/OAuth calls.
These are source/fixture checks; live connection and owner acceptance require the
authenticated deployed UI and existing server configuration.
