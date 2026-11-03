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

## Protected status tool

An operator may add `"allowedToolNames": ["scout_capabilities"]` to one member's
protected model policy and set `limits.maxCallsPerRun` to at least two. The field
is optional with no default; omission preserves the previous policy fingerprint
and text-only outbound request. Changing it changes the policy fingerprint and
therefore requires renewed policy-bound Odoo release consent before reusing task
context. No web request or model argument can enable it.

The existing public MIT SDK runs the tool loop. The provider receives exactly
one server-owned empty-object function schema, with parallel calls disabled;
SDK-injected state tools and browser definitions never reach the provider.
The tool returns only the product catalog. It cannot select an account, URL,
credential, data source or Odoo record, submit DSH work, accept a draft or call an
external integration. The per-run ledger permits one status execution and admits
only its exact result into the follow-up. Old status exchanges are validated and
omitted from future provider prompts; their saved text answers remain readable.

Each provider hop still reserves and completes its own SQL usage receipt and
passes existing quota, cost, timeout, cancellation and current-authority checks.
The tool call is withheld until provider finish and required usage are validated.
Definitions and tool messages count toward the full outbound request byte cap;
the small catalog result also has an output byte cap. Unknown or malformed calls,
missing usage, cancellation or revoked admission cannot execute a tool or start
an authorized follow-up. No second scheduler, general MCP client, work-app
credential migration or private-context history class is introduced.

Withdrawing the tool opt-in restores the unchanged text-only transcript contract.
Stored tool-bearing conversations remain readable, but their model continuation
then refuses the tool transcript; use a fresh text-only conversation. Broadening
the default replay contract is outside this first status-tool qualification.
