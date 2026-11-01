# Scout mobile chat client

This Expo app provides native sign-in and text chat for built-in Scout agents.
It reads conversations from the owned CopilotKit history endpoint and submits
turns through the owned AG-UI runner; PostgreSQL on the server remains the
transcript authority.

The conversation's Odoo context panel shows the current user's access and
provider-sharing status. Users explicitly allow or withdraw the existing
model-release consent for the displayed provider and model, then select one
project task ID for their next message. Consent carries the displayed policy
fingerprint; a changed route requires refresh and a new explicit decision.
The reference is scoped to the user, conversation and agent and consumed once
when a turn is attempted. A failed turn restores only the chat draft under the
existing recovery rules; selecting a task again requires another explicit choice.
The server rechecks membership, grants, model policy and Odoo visibility before
releasing the fixed summary. Configure or replace the Odoo credential through
the authenticated web setup link; mobile has no raw-key enrollment field.

The DSH panel loads existing receipts only when the server's
`delegatedDrafts` capability is explicitly true. It filters to the current
conversation and renders returned results as plain text. Refreshing a task reads
its current receipt. Acceptance requires a separate review/confirmation action
and carries the exact reviewed revision and draft digest. A conflict requires
refresh and review rather than automatic acceptance of a newer result.

For explicit delegation, choose a saved user message and review the displayed
title and instructions, then select **Delegate reviewed message to DSH**. Only
plain-text messages read from canonical server history, with a UUID and up to
8,000 characters, qualify; optimistic messages and model/tool replies do not.
The title is derived from the first line (up to 200 characters), instructions
are the trimmed message text, and its original message UUID is the stable
`sourceId`. To change a request, save and explicitly choose a new message.

Before the first submission, SecureStore persists and reads back an opaque
attempt marker scoped to the server, account, conversation, assistant and
message. It holds only the source UUID and payload digest, never the prompt or
an authorization claim. Failed storage blocks submission. The backend commits
the complete intent before its queue RPC. A lost response retains the local
marker; opening the panel or remounting performs no automatic submission.
**Check request status** reads current receipts. A list is capped at 50, so
absence does not establish that a request never reached the server.

**Recover the same reviewed request** is an explicit retry of the identical
payload/source through the existing submission API. The server verifies the
stored payload and binding before recovering it. A matching list `sourceId`
alone does not authorize by-ID recovery: public receipts omit instructions.
Changed content, unreadable markers and changed identities/scopes fail closed.
All saved eligible messages remain selectable, including older uncertain
requests; messages no longer present in canonical history require web/operator
reconciliation. No source key is rotated automatically. All network requests
reuse the subject-bound `scopedApi` guard, including asynchronous cookie reads.

This slice adds no cancellation, recovery worker, scheduler,
routines, memory, computer access, plugins or push notifications. Existing queue
and server authorization remain authoritative. Runtime activation, live Entra/
Odoo/model/DSH qualification and physical-device acceptance are separate work.

## Build

The GitHub Actions workflow `Scout mobile test APK` creates a standalone Android
APK with the JavaScript bundle embedded. It does not use EAS, an EAS project ID,
signing secrets or a Metro server. The resulting artifact is debug-signed for
installation on Android test devices and is not a Play Store release.

The build configures the public origin as
`https://scout.somethingsomewhere.ph`. That hostname's current TLS and app route
have not been verified, so a successful APK build does not establish that the
phone can reach Scout or sign in. Before live sign-in, confirm the HTTPS route,
configure the exact Microsoft Entra web callback, and enable the server's narrow
native callback with `SCOUT_NATIVE_AUTH_ENABLED=true`. This switch enables only
Better Auth's `scoutmobile://` callback; it does not enable push or require an
EAS project.

For local development, install the reviewed `package-lock.json` with `npm ci`,
set `EXPO_PUBLIC_SERVER_URL` to an approved HTTPS origin, and use Expo's native
prebuild/run commands. The release APK build is independent of a development
server.

## Checks

Run `npm run typecheck` and `npm test` from this directory. The focused
tests cover persisted history reads, authenticated request shape, owned-run
payloads, streamed text, terminal events, failure recovery, one-turn task
selection, consent request shapes, capability gating, exact draft acceptance,
durable submission markers, lost replies, same-key recovery, and delayed
storage/cookie completion across account, conversation and assistant changes.
They use synthetic fixtures and fake API ports, not live providers or queue work.
Native API and chat dispatches recheck the initiating account and conversation
after asynchronous credential reads. The server also rejects an expected-user
header that differs from the authenticated cookie subject. The header grants
no access. Rebuild and deploy the matching client/server contract together.
