# Owned Scout conversation persistence

This is a source foundation on the owner's CopilotKit/OpenDuet fork. It is
stacked on the qualified DSH requester port at
`53f797167dd676e8d0945982a5f65bc65cbbc740`. At the qualified foundation commit,
platform bootstrap, UI and Intelligence/learning configuration were unchanged.
The subsequent [explicit owned composition](OWNED-RUNTIME.md) integrates the
same Scout app. The foundation itself does not activate shared access or
contact a model, identity vendor or Odoo.

The public MIT `AgentRunner` extension in `@copilotkit/runtime` 1.77.0 supports
an application-owned store. This adapter uses that API and AG-UI 1.0.1's public
schemas/reducer. It does not implement the private local-thread feature flag,
imitate an Intelligence server, bypass entitlements or provide licensed memory,
learning or managed Channels. See the official
[runner guide](https://docs.copilotkit.ai/langgraph-python/backend/agent-runner)
and [authorization guide](https://docs.copilotkit.ai/langgraph-python/auth).

## Contracts

- Mint each thread on the server with a random ID and explicit native user,
  current tenant, authorized agent and optional channel. A run cannot create or
  take over a supplied thread ID. Every query scopes both user and tenant.
- Construct `engine.bind(authority)` per authenticated request. `principal`
  revalidates the native session/current tenant membership; `authorize` checks
  current agent/channel grants. Only exact `true` grants access. Never derive
  these values from email alone, headers, AG-UI state, tool input, forwarded
  properties or a model. Recheck before and after each read/write and while
  producing/following a stream. The runtime's agent roster also needs this policy.
- Migration `0069_scout_history` adds three tables: owned thread snapshots,
  immutable run intents with private fenced leases, and ordered events. A row
  lock and unique active-run index serialize admission. The run input/digest and
  initial events commit before agent invocation. Identical retry is replay;
  changed input under the same run ID conflicts. It never repeats a tool call
  merely because a client, producer process or lease disappeared.
- Canonical messages and state come from the store. The browser may add user
  messages or answer an existing pending frontend tool call; it cannot rewrite
  stored assistant/system messages or state. State deltas are validated before
  commit, with prototype changes refused and without SDK warnings containing
  the state. A future UI state command needs its own explicit schema/policy.
- A pending interrupt requires exactly its owned response IDs. Duplicate,
  missing, foreign and expired resolved responses fail. An expired interrupt
  may be cancelled. Resume input conveys the user's answer; it does not approve
  an Odoo action or confer a business-tool grant.
- Producer leases use the database clock. Another process can follow or request
  an exact-run stop; delayed cancellation cannot stop a later run. A stop before
  dispatch prevents invocation. Revocation, persistence failure, shutdown and
  time limits abort the producer explicitly, because the SDK swallows subscriber
  exceptions. Late output is fenced. Disconnecting a viewer preserves execution.
- Expiry recovery retains partial text, uses the public deterministic finalizer
  and reducer, and appends an interruption marker. A committed success remains a
  success after a crash. A new run is a new explicit request, never an automatic
  replay. This does not make arbitrary external tools transactional: retain DSH's
  stable work key/receipt and approval protocol for their effects.
- Default hard admission limits are 500 threads per owner/tenant, 500 runs and
  20,000 events/16 MiB per thread, 1 MiB input and 256 KiB per event. Settings may
  lower those limits. Terminal markers have reserved capacity; old history is
  not silently evicted. The lease is 30 seconds, heartbeat 1 second, follower
  polling 250 ms and maximum run time 10 minutes. Model token/cost and aggregate
  concurrency budgets are separate requirements before real inference.

## HTTP composition

`createHistoryRoutes` requires native authentication and exposes only owned
mint/list/messages/events/exact-run stop. `createHistoryRuntimeHandler` requires
the matching bound history and SSE runtime, bounds the body, checks ownership
and route policy before SDK dispatch, disables CORS and managed Channels, and
returns `Cache-Control: no-store`. It allows public info/run/connect/stop only;
suggestion, debug, unadapted thread/memory and transcription paths cannot become
an alternate model or unscoped history route. Other useful capabilities need
their own explicit adaptation rather than a permissive fallback.

Mount both under the platform's real `createRequireUser` and
`createSameOriginGuard`. Disable cached membership decisions for shared access.
The integration test composes these real middleware and the actual SDK Fetch
handler; its session issuer, agent and all data are synthetic. It does not
validate the company's live identity provider. The later explicit owned
composition mounts these factories through the existing app.

## Qualification and remaining work

On Windows/Bun 1.4.3, 31 dedicated history cases passed against a real pinned
PostgreSQL fixture and public SDK. A combined history/requester rerun passed
65 cases with zero failures. This includes concurrent duplicate admission,
same-email foreign identities at HTTP, fresh tenant policy, malformed/prototype
state patches, interrupted resume, pre-dispatch stop, revocation and a synthetic
storage-write fault. A real child process was killed after its committed
dispatch/partial-output marker: a fresh engine recovered the partial answer,
retained one dispatch marker and did not invoke the same run again. No model
API or live business operation ran. This is not the deferred physical PC-off test.

The new migration was applied to the dedicated minimal local fixture and
`drizzle-kit check` passed. Full platform migration/build/static/test checks
must pass on the published exact head. The test-type baseline remains unchanged.
Production TypeScript passed; the existing test tsconfig reported its same
239 known diagnostics with zero new after Windows path normalization. Scoped
Biome and the frozen dependency installation passed. The only lock change is
the workspace declaration for already locked `fast-json-patch` 3.1.1.

Next integration must adapt config/bootstrap, thread readers and the Scout UI
to this explicit mode without falling back to global in-memory history or
silently disabling required features. Resolve per-user native SSO, agent/tool
and source/record policies, model budgets, retained DSH provenance and approvals.
Then qualify a private installation on the existing Community Linode with
resource limits, migration, backup/restore and rollback, followed by live access
isolation, inference and native MatePad/phone login/reconnect readback. Retain
licensed Intelligence features only through an approved entitlement/deployment.
No shared employee/customer access or full local runtime is claimed here.
