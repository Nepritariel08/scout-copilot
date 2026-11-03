# Owner capability qualification

`GET /api/scout/capabilities` is an authenticated, no-store native-membership
projection of configured owned adapters. `requires_authorization` means the
adapter exists; it does not attest a current Odoo credential, release consent or
DSH requester grant. The existing context-grant and queue handlers remain the
authority for those operations. Work apps installed in ChatGPT are not Scout
connections. No account credential or app grant transfers between products.

The first owner acceptance pack is:

1. Select one permitted Odoo task, request a sourced brief, then verify that
   another user's task and withdrawn context/release grants are refused.
2. Explicitly submit one saved user-message draft to the existing DSH queue,
   correlate its result and accept its exact revision in the review UI. Reconnect
   must not submit twice. Model-selected submission and acceptance stay disabled.
3. After a separate Scout-specific connection and data-release qualification,
   request a read-only workday brief from calendar/mail. Disconnected apps must
   be reported as unavailable. Sending mail, booking meetings and changing files
   require their own bounded implementation and acceptance.

Voice is unavailable in this source slice. The catalog is not plugin installation
or evidence that a workflow ran. Source/fixture tests do not establish deployment,
live inference or human acceptance.
