# Owned contextual history authorization

The selected Odoo task summary is no longer treated as authority for only one
model call. Its answers and subsequent conversation can contain derived facts.
Owned Scout therefore keeps an append-only dependency set for the whole thread.
Every later answer inherits all earlier dependencies, even when the user does
not select a task on that turn. This is deliberately conservative; it does not
attempt to decide which sentence came from which source.

## Durable boundary

Migration `0074_scout_history_context` adds the private `scout_history_context`
table and a nullable `scout_history_runs.context_revision`. New history threads
receive an explicit version-1, empty-source marker in their creation transaction.
Existing threads receive no marker. Missing, malformed or unsupported provenance
denies access; an empty snapshot or browser declaration cannot adopt an old thread.
There is no migration that labels old content safe, copies it to a new tenant, or
silently deletes it. Preserve a backup and review old history under a separately
approved retention/migration workflow before any future adoption capability.

Before contextual model dispatch, the server appends an exact source dependency:
native deployment/tenant/user/membership binding, source instance, fixed task ID,
provider/model-policy fingerprint, and record/grant/release digests. Metadata
contains no task fields, prompt, API key, password, contact or credential reference.
The source payload is still bounded by the existing fixed Odoo task contract.
Database locks recheck the exact owned thread/agent/live run. Exact dependency
retries are idempotent; the limit is 16 dependencies, and exhaustion refuses
instead of dropping older ones. SQL enforces append-only prefixes.

Each owned-model run durably freezes its dependency revision before inference:
zero for new source-free chat, or the current dependency prefix for selected and
ordinary derived turns. SQL prevents rewriting that run marker. It is metadata,
not permission. Failed/cancelled attempts may conservatively leave a dependency
even when no model answer was returned. A producer crash cannot turn a marked
thread back into source-free history.

## Current authorization and reuse

History listing/display, snapshots, event replay, connect and run admission use
the same owned authority hook. Model authorization additionally checks inherited
dependencies before provider use, including a turn without a task selector.
Checks intersect the current authenticated identity and membership, protected
native-to-Odoo mapping, record and release grants, model policy/provider route,
and fresh Odoo identity/project/task ACL reads under the mapped individual's key.
Source rights are not inferred from a saved fingerprint or from provenance.
Metadata and model policy are read again after asynchronous source checks; a
concurrent dependency change denies. No remote source I/O holds a SQL transaction
lock. The existing independent identity connection pool remains required.

A changed/revoked membership, source mapping, source grant, release consent,
model route/policy or task content closes the contextual thread. Missing sources
and Odoo ACL/network failures also deny display/reuse. A new source-free chat
continues to use its independently approved model policy; revoking Odoo access
does not revoke ordinary chat. Stopping a run remains possible after source
revocation. Internal lease maintenance still checks native authority and exposes
no history; reader/replay delivery and model dispatch retain source checks.

The licensed/default composition is unchanged. This adds no document index,
semantic cache, memory service, export endpoint, queue, business tool or provider
fallback. It does not erase copies already downloaded or user-authored pasted
text. Broader retention/deletion, curated retrieval, files, user-visible citations,
exports and device acceptance remain separate requirements. Source checks can
affect latency and availability; measure those against real pilot traffic before
shared rollout. No shared authorization-result cache was added to hide that cost.

## Qualification boundary

Focused tests exercise selected context followed by ordinary continuation,
source/release/route/content/native revocation, transitive older dependencies,
concurrent metadata changes and new source-free chat. Synthetic SQL cases cover
atomic new markers, unknown legacy refusal, exact retries, active-run fencing,
append-only rollback, bounded exhaustion, durable turn prefixes and reconstruction
through a fresh store instance. The composed-app fixture requires metadata and
the run revision to exist before its synthetic provider receives a request; it
checks history/replay and continuation refusal after release/source/native/route
changes. These are synthetic fixtures, not real employee/customer acceptance.

No local database, directory, Odoo, provider, device or host is used for this
source lane. Actual SQL and full exact-head CI are pending the coordinator's
existing isolated harness. The earlier pinned-Odoo qualification at `ad5bf57`
remains distinct from this new combined source and its required fresh checks.

Local Bun 1.4.3 frozen installation with scripts disabled installed 1,177 packages
without lockfile or manifest changes. The focused seven-suite bundle passed
108 tests/941 assertions; the overlapping authority/pool/consent bundle passed
33 tests/794 assertions. The changed four-test/application TypeScript graph and
the additional authority-test graph passed, as did 15-file Biome and whitespace
checks. The five new dedicated SQL cases and composed-app scenarios were not
run locally; only the coordinator's dedicated CI database can qualify them.
