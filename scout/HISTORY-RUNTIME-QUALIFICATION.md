# Migration 0074 runtime and recovery qualification

This packet prepares a reviewed release; it executes no migration, grant, role,
host or provider action. Keep the existing approval-bound 0072/0073 command
unchanged. Applying 0074 requires the coordinator's next exact release/target
scope and current host claim. Keep Scout disabled until the complete selected
release, database and private-pilot acceptance evidence agree.

## Exact post-migration inventory

From an independently verified, immutable release, record the source SHA and
artifact digest. Before applying anything, compare the target database's full
`drizzle.__drizzle_migrations` hash/stamp rows to the exact release journal. After
application require one matching row per expected migration through
`0074_scout_history_context`, no duplicates, unknown hashes or null stamps, and
no missing or changed prefix entry. A maximum stamp or row count alone is not
proof. The selected 0074 journal stamp is `1793565619303`; obtain its SQL hash
from the exact staged artifact, not a Windows checkout with different newlines.
The existing migration runner remains the only application path; its
reachability guard is not a replacement for this complete inventory comparison.

From the verified release's `openbot/server`, the following local command reads
source only and emits non-secret expected hashes/stamps; it opens no database:

```sh
<VERIFIED_BUN_1_4_3> --no-env-file -e 'import { readMigrationFolder } from "./src/db/migration-reach"; console.log(JSON.stringify(await readMigrationFolder("./drizzle")));'
```

The authorized DBA reads the journal in a read-only transaction on the exact
dedicated Scout database. Use the established protected local connection,
verify database/role/server identity first, and compare every row with that
expected source output. Do not repair a journal, insert a missing marker, change
PUBLIC ACLs or retry a mismatch as part of readback.

```sql
BEGIN READ ONLY;
SELECT current_database(), session_user, current_user,
       inet_server_addr(), inet_server_port();
SELECT id, hash, created_at
FROM drizzle.__drizzle_migrations ORDER BY id;
ROLLBACK;
```

0074's exact new inventory is:

| Object | Required definition/readback |
| --- | --- |
| `public.scout_history_context` | Four columns: `thread_id text` primary key, `version integer`, `revision integer`, `dependencies jsonb`; all NOT NULL; `scout_history_context_shape` and exact FK below. |
| `scout_history_context_thread_id_scout_history_threads_id_fk` | `thread_id` → `public.scout_history_threads(id)`, ON DELETE CASCADE, ON UPDATE NO ACTION. |
| `public.scout_history_runs.context_revision` | Nullable integer; `scout_history_run_context_revision_check` allows NULL or 0–16. |
| `public.scout_history_context_append_only()` | Trigger function, security invoker; exact reviewed append-prefix and parent-aware DELETE guard. |
| `public.scout_history_context_no_truncate()` | Trigger function, security invoker; unconditionally refuses truncation. |
| `public.scout_history_run_context_once()` | Trigger function, security invoker; immutable non-null run revision and existing-prefix requirement. |
| `scout_history_context_append_only` | Enabled `BEFORE UPDATE OR DELETE`, each row, on `public.scout_history_context`, exact function above. |
| `scout_history_context_no_truncate` | Enabled `BEFORE TRUNCATE`, each statement, on that same table. |
| `scout_history_run_context_once` | Enabled `BEFORE INSERT OR UPDATE OF context_revision`, each row, on `public.scout_history_runs`. |

Read **definitions**, not only names. For example, on the verified Scout target,
these catalog queries expose no conversation content or credentials:

```sql
BEGIN READ ONLY;
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND
  (table_name='scout_history_context' OR
   (table_name='scout_history_runs' AND column_name='context_revision'))
ORDER BY table_name, ordinal_position;
SELECT conrelid::regclass AS relation, conname, convalidated,
       pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('public.scout_history_context'::regclass,
                  'public.scout_history_runs'::regclass)
ORDER BY conrelid::regclass::text, conname;
SELECT t.tgrelid::regclass AS relation, t.tgname, t.tgenabled,
       pg_get_triggerdef(t.oid)
FROM pg_trigger t
WHERE NOT t.tgisinternal AND t.tgrelid IN
  ('public.scout_history_context'::regclass,'public.scout_history_runs'::regclass)
ORDER BY t.tgrelid::regclass::text,t.tgname;
SELECT p.oid::regprocedure AS "function", pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.oid IN
  ('public.scout_history_context_append_only()'::regprocedure,
   'public.scout_history_context_no_truncate()'::regprocedure,
   'public.scout_history_run_context_once()'::regprocedure)
ORDER BY p.oid::regprocedure::text;
ROLLBACK;
```

Require all constraints validated and all three user triggers enabled in ordinary operation (`tgenabled='O'`),
with their exact reviewed events/functions and all three function definitions.
The functions must remain invoker (`prosecdef=false`). Preserve the DBA-reviewed
object owner; the runtime must neither own these tables/functions nor have a
role-membership path allowing it to become their owner. Do not transfer shared
cluster ownership or make a function SECURITY DEFINER to repair a privilege
error. PostgreSQL's [trigger behavior](https://www.postgresql.org/docs/18/trigger-definition.html)
documents the invoking-role boundary.

## Runtime grant and permission evidence

Record the exact runtime role separately from the migration/backup role. On the
dedicated database, read its role attributes, memberships, schema privileges,
table ownership and each effective privilege individually (including inherited
and PUBLIC grants). The 0074 history path needs:

| Scope | Expected runtime boundary |
| --- | --- |
| `public` | USAGE; no CREATE. |
| `scout_history_threads`, `scout_history_runs`, `scout_history_events`, `scout_history_context` | SELECT/INSERT/UPDATE/DELETE for the existing application path, including the new marker insert/read and the invoker functions' table reads. No TRUNCATE, REFERENCES or TRIGGER grants are required. |
| Three trigger functions above | Record effective EXECUTE and owner/security mode; the DBA creates the triggers. No elevated execution or runtime trigger-creation grant is needed. |
| Runtime role | No superuser, CREATEDB, CREATEROLE, replication, BYPASSRLS, application-object ownership or migration/owner role membership. |

No new sequence is introduced by 0074. Do not grant ALL TABLES/ALL FUNCTIONS,
change PUBLIC ACLs, or add DDL/owner membership to make a test pass. A dedicated
database preparation grant is an independently reviewed mutation, not part of
these read-only queries. Replace the following psql variable with the already
verified runtime role; it is an identifier, not a secret:

```sql
\set scout_runtime_role 'scout_pilot'
BEGIN READ ONLY;
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls, rolinherit
FROM pg_roles WHERE rolname=:'scout_runtime_role';
SELECT r.rolname AS member, parent.rolname AS granted_role,
       m.admin_option, m.inherit_option, m.set_option
FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
JOIN pg_roles parent ON parent.oid=m.roleid
WHERE r.rolname=:'scout_runtime_role';
SELECT has_schema_privilege(:'scout_runtime_role','public','USAGE') AS usage,
       has_schema_privilege(:'scout_runtime_role','public','CREATE') AS "create",
       has_parameter_privilege(:'scout_runtime_role','session_replication_role','SET') AS can_bypass_triggers;
SELECT c.oid::regclass AS relation, pg_get_userbyid(c.relowner) AS owner,
       pg_has_role(:'scout_runtime_role',c.relowner,'MEMBER') AS owner_membership,
       privilege, has_table_privilege(:'scout_runtime_role',c.oid,privilege) AS allowed
FROM pg_class c CROSS JOIN
  unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS grants(privilege)
WHERE c.oid IN ('public.scout_history_threads'::regclass,
               'public.scout_history_runs'::regclass,
               'public.scout_history_events'::regclass,
               'public.scout_history_context'::regclass)
ORDER BY c.oid::regclass::text,privilege;
SELECT p.oid::regprocedure AS "function", pg_get_userbyid(p.proowner) AS owner,
       pg_has_role(:'scout_runtime_role',p.proowner,'MEMBER') AS owner_membership,
       p.prosecdef, has_function_privilege(:'scout_runtime_role',p.oid,'EXECUTE') AS "execute"
FROM pg_proc p WHERE p.oid IN
  ('public.scout_history_context_append_only()'::regprocedure,
   'public.scout_history_context_no_truncate()'::regprocedure,
   'public.scout_history_run_context_once()'::regprocedure)
ORDER BY p.oid::regprocedure::text;
ROLLBACK;
```

Require false for both owner-membership checks and `can_bypass_triggers`; retain
the membership inventory for DBA review. PostgreSQL's [access inquiry functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE)
include these effective privilege checks. A real runtime login/HBA/TLS check still uses the
existing private-pilot procedure with its protected credential. On that real
runtime connection verify `current_user` is the exact runtime role and
`current_setting('session_replication_role')='origin'`; a DBA's session does not
prove the runtime's effective startup settings. This packet's
`scout-history-runtime-role.integration.test.ts` deliberately uses SET ROLE from
the disposable CI administrator, a unique NOLOGIN role and a dedicated max=1
pool. It checks current role throughout, normal history DML/cascades, exact
P0001 invariant refusals, and 42501 application-DDL/TRUNCATE denial. It tests
permissions, not authentication or inability of that privileged session to
RESET ROLE. It never grants the synthetic role ownership or DDL. Forbidden DDL
attempts roll back even on an unexpected success. The fixture revokes only its
own exact grants and drops only its unique role; no DROP OWNED/PUBLIC changes.
Actual PostgreSQL results belong to the existing disposable CI run, not this
source packet. Local types/formatting do not qualify SQL execution.

## Minimum binary and recovery boundary

0074 is additive SQL but changes a security boundary. The provenance-aware
source floor is `714bdf4e9d642fd0ef919fc7e269d52aa9aeee53`, including its ancestry;
select its reviewed descendant only after exact-head CI/artifact qualification.
Do not route owned history/list/replay/connect/run/model requests to any older
replica or rollback binary that lacks that authorization, even if its SQL
queries still work. Verify every serving release and route. Before an older
rollback, stop Scout and withdraw its ingress; keep contextual reads and model
reuse unavailable until a qualified provenance-aware binary is restored. Do not
remove 0074, reset markers, relabel old history source-free, or run an older
reader against newer contextual content as a rollback shortcut. Continue the
separate Entra callback rollback restrictions in OWNED-ENTRA.md.

The matched backup must include context rows, run revisions, complete migration
prefix, constraint/function/trigger definitions, object ownership/grant evidence,
and the release/policies/keys that give the stored digests meaning. Restore into
a new isolated Scout target; reverify the inventory/privileges above because
`pg_restore --no-owner --no-privileges` does not recreate the original owner/grant
policy. No privilege widening is an automatic restore step.

First perform DB-only counts, metadata/digest equality and run-prefix checks
without exposing saved business text or enabling source/model egress. Require no
non-null run revision beyond its thread's dependency revision. A missing legacy
marker must stay missing; verify its expected denial rather than manufacturing
revision 0. Recheck all three trigger definitions/enabled states and invoker
behavior; a journal stamp cannot prove guards survived restoration.

For a sourceful thread with unavailable Odoo, missing current mapping/grant,
release consent or model route, application history/replay/continuation must
deny. That is expected recovery behavior, not a reason to bypass authorization.
Keep model, queue and device execution disabled. Qualify positive restored
sourceful display with a separate synthetic matched backup and isolated source
fixture/credentials, original native/deployment/tenant identities and matching
policy/release versions. Use that fixture's current ACL/revocation checks; never
point it at live Odoo credentials. Model dispatch remains blocked. Source-free
history and unavailable-source denials can be checked independently. Restore
acceptance requires these readbacks plus the existing usage/uncertain-effect
reconciliation; a successful pg_restore alone is insufficient.
