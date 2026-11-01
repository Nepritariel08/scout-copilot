import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/client";
import { eq, type SQL, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  scoutHistoryContext,
  scoutHistoryRuns,
  scoutHistoryThreads,
} from "../src/db/schema/scout-history";
import { createHistoryContextStore } from "../src/scout/history/context-store";
import { createHistoryStore } from "../src/scout/history/store";
import type { ContextDependency } from "../src/scout/owned-model/context-dependency";
import { testDatabaseUrl } from "./support/database";

// Disposable CI only. The privileged fixture connection creates a unique NOLOGIN
// role; a separate one-connection pool executes SET ROLE. This tests PostgreSQL
// permissions and invoker triggers, NOT password/HBA/TLS/login authentication.
const url = testDatabaseUrl();
const admin = createDatabase(url, { max: 1 });
const runtime = createDatabase(url, { max: 1 });
const suffix = randomUUID().replaceAll("-", "");
const role = `scout_ctx_runtime_${suffix}`;
const principal = {
  userId: `history-runtime-${suffix}`,
  tenantId: "synthetic-runtime-tenant",
};
const history = createHistoryStore(runtime);
const contexts = createHistoryContextStore(runtime);
let roleCreated = false;
const dependency: ContextDependency = {
  kind: "odoo.project_task_summary.v1",
  principal: {
    ...principal,
    deploymentId: "synthetic-runtime-test",
    bindingFingerprint: "a".repeat(64),
  },
  sourceInstanceId: "synthetic-odoo",
  recordId: 42,
  provider: "local",
  modelPolicyFingerprint: "b".repeat(64),
  grantDigest: "c".repeat(64),
  releaseDigest: "d".repeat(64),
  recordDigest: "e".repeat(64),
};

async function assertRuntime() {
  const [identity] = await runtime.execute<{
    role: string;
    privileged: boolean;
    replicationRole: string;
  }>(
    sql`select current_user as role,
      (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
      as privileged, current_setting('session_replication_role') as "replicationRole"
      from pg_roles where rolname=current_user`,
  );
  expect(identity).toEqual({
    role,
    privileged: false,
    replicationRole: "origin",
  });
}
async function expectSqlRefusal(
  work: () => PromiseLike<unknown>,
  code: string,
  message?: string,
) {
  let refused = false;
  try {
    await work();
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth++) {
      const entry = current as {
        errno?: unknown;
        code?: unknown;
        message?: string;
        cause?: unknown;
      };
      if (
        (entry.errno ?? entry.code) === code &&
        (message === undefined || entry.message === message)
      ) {
        refused = true;
        break;
      }
      current = entry.cause;
    }
  }
  expect(refused).toBe(true);
  // A lost/replaced pooled connection cannot silently turn this into an admin test.
  await assertRuntime();
}
function attemptWithoutEffects(statement: SQL) {
  return runtime.transaction(async (tx) => {
    await tx.execute(statement);
    // Even a permission regression must not weaken guards or truncate other fixtures.
    throw new Error("Unexpected runtime permission; transaction rolled back");
  });
}
async function started() {
  await assertRuntime();
  const thread = await history.mint(principal, { agentId: "scout" });
  const runId = randomUUID();
  const run = await history.start(principal, "scout", {
    threadId: thread.id,
    runId,
    messages: [
      { id: randomUUID(), role: "user", content: "Synthetic request" },
    ],
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
  });
  if (!run.execute) throw new Error("Expected synthetic runtime run");
  await assertRuntime();
  return { thread, runId, lease: run.lease };
}

beforeAll(async () => {
  await admin.execute(sql`create role ${sql.identifier(role)} nologin nosuperuser
    nocreatedb nocreaterole noreplication noinherit nobypassrls`);
  roleCreated = true;
  await admin.execute(
    sql`grant usage on schema public to ${sql.identifier(role)}`,
  );
  await admin.execute(sql`grant select,insert,update,delete on table
    public.scout_history_threads,public.scout_history_runs,
    public.scout_history_events,public.scout_history_context
    to ${sql.identifier(role)}`);
  await admin.execute(sql`grant execute on function
    public.scout_history_context_append_only(),
    public.scout_history_context_no_truncate(),
    public.scout_history_run_context_once() to ${sql.identifier(role)}`);
  await admin.execute(sql`insert into public.users(id,email)
    values(${principal.userId},${`${principal.userId}@fixture.invalid`})`);
  // This pool belongs only to this file and has max=1. No admin work uses it.
  await runtime.execute(sql`set role ${sql.identifier(role)}`);
  await assertRuntime();
});
afterAll(async () => {
  try {
    await runtime.$client.end();
  } finally {
    try {
      // Deleting this exact synthetic parent also exercises the native FK cascade.
      await admin.execute(
        sql`delete from public.users where id=${principal.userId}`,
      );
      if (roleCreated) {
        await admin.execute(sql`revoke select,insert,update,delete on table
          public.scout_history_threads,public.scout_history_runs,
          public.scout_history_events,public.scout_history_context
          from ${sql.identifier(role)}`);
        await admin.execute(sql`revoke execute on function
          public.scout_history_context_append_only(),
          public.scout_history_context_no_truncate(),
          public.scout_history_run_context_once() from ${sql.identifier(role)}`);
        await admin.execute(
          sql`revoke usage on schema public from ${sql.identifier(role)}`,
        );
        // No DROP OWNED, ownership transfer, PUBLIC ACL change or broad cleanup.
        await admin.execute(sql`drop role ${sql.identifier(role)}`);
      }
    } finally {
      await admin.$client.end();
    }
  }
});

describe("0074 invoker behavior under a reduced runtime role", () => {
  test("non-owner DML can mint, append, mark, reconstruct and parent-delete history", async () => {
    const [privileges] = await runtime.execute<{
      contextOwner: boolean;
      schemaCreate: boolean;
      bypassTriggers: boolean;
      truncate: boolean;
      tableDml: boolean;
      triggerOwner: boolean;
      elevatedFunction: boolean;
      missingExecute: boolean;
    }>(sql`select
      c.relowner=(select oid from pg_roles where rolname=current_user) as "contextOwner",
      has_schema_privilege(current_user,'public','CREATE') as "schemaCreate",
      has_parameter_privilege(current_user,'session_replication_role','SET') as "bypassTriggers",
      has_table_privilege(current_user,c.oid,'TRUNCATE') as "truncate",
      (has_table_privilege(current_user,c.oid,'SELECT')
        and has_table_privilege(current_user,c.oid,'INSERT')
        and has_table_privilege(current_user,c.oid,'UPDATE')
        and has_table_privilege(current_user,c.oid,'DELETE')) as "tableDml",
      bool_or(p.proowner=(select oid from pg_roles where rolname=current_user)) as "triggerOwner",
      bool_or(p.prosecdef) as "elevatedFunction",
      bool_or(not has_function_privilege(current_user,p.oid,'EXECUTE')) as "missingExecute"
      from pg_class c cross join pg_proc p
      where c.oid='public.scout_history_context'::regclass
      and p.oid in ('public.scout_history_context_append_only()'::regprocedure,
        'public.scout_history_context_no_truncate()'::regprocedure,
        'public.scout_history_run_context_once()'::regprocedure)
      group by c.oid,c.relowner`);
    expect(privileges).toEqual({
      contextOwner: false,
      schemaCreate: false,
      bypassTriggers: false,
      truncate: false,
      tableDml: true,
      triggerOwner: false,
      elevatedFunction: false,
      missingExecute: false,
    });
    const { thread, runId, lease } = await started();
    expect((await contexts.read(principal, thread.id)).revision).toBe(0);
    await contexts.append(principal, thread.id, "scout", runId, dependency);
    await contexts.append(principal, thread.id, "scout", runId, dependency);
    await contexts.markRun(principal, thread.id, "scout", runId, 1);
    expect(
      await createHistoryContextStore(runtime).read(principal, thread.id),
    ).toEqual({ version: 1, revision: 1, dependencies: [dependency] });
    const messageId = randomUUID();
    await history.append(lease, {
      type: EventType.TEXT_MESSAGE_START,
      role: "assistant",
      messageId,
    });
    await history.append(lease, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: "SYNTHETIC_REDUCED_ROLE_OK",
    });
    await history.append(lease, {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    });
    await history.finish(lease, "completed");
    expect(
      (await history.snapshot(principal, thread.id)).messages.at(-1)?.content,
    ).toBe("SYNTHETIC_REDUCED_ROLE_OK");
    const other = await history.mint(principal, { agentId: "scout" });
    await runtime
      .delete(scoutHistoryThreads)
      .where(eq(scoutHistoryThreads.id, thread.id));
    expect(
      await runtime
        .select()
        .from(scoutHistoryContext)
        .where(eq(scoutHistoryContext.threadId, thread.id)),
    ).toEqual([]);
    expect(
      await runtime
        .select()
        .from(scoutHistoryRuns)
        .where(eq(scoutHistoryRuns.threadId, thread.id)),
    ).toEqual([]);
    expect((await contexts.read(principal, other.id)).revision).toBe(0);
    await assertRuntime();
  });
  test("reset and invalid-prefix attempts are refused and roll back prior DML", async () => {
    const { thread, runId } = await started();
    await expectSqlRefusal(
      () =>
        attemptWithoutEffects(sql`update public.scout_history_runs set context_revision=1
        where thread_id=${thread.id} and id=${runId}`),
      "P0001",
      "Scout run context provenance has no dependency prefix",
    );
    await contexts.append(principal, thread.id, "scout", runId, dependency);
    await contexts.markRun(principal, thread.id, "scout", runId, 1);
    const before = await contexts.read(principal, thread.id);
    await expectSqlRefusal(
      () =>
        runtime.transaction(async (tx) => {
          await tx
            .update(scoutHistoryThreads)
            .set({ name: "Must roll back" })
            .where(eq(scoutHistoryThreads.id, thread.id));
          await tx
            .delete(scoutHistoryContext)
            .where(eq(scoutHistoryContext.threadId, thread.id));
          await tx.insert(scoutHistoryContext).values({
            threadId: thread.id,
            version: 1,
            revision: 0,
            dependencies: [],
          });
          throw new Error(
            "Unexpected reset permission; transaction rolled back",
          );
        }),
      "P0001",
      "Scout history context is append-only",
    );
    expect(await contexts.read(principal, thread.id)).toEqual(before);
    expect((await history.get(principal, thread.id)).name).toBe(thread.name);
    await expectSqlRefusal(
      () =>
        attemptWithoutEffects(sql`update public.scout_history_runs set context_revision=0
        where thread_id=${thread.id} and id=${runId}`),
      "P0001",
      "Scout run context provenance is immutable",
    );
    await expectSqlRefusal(
      () =>
        attemptWithoutEffects(sql`truncate table public.scout_history_context`),
      "42501",
    );
    expect(await contexts.read(principal, thread.id)).toEqual(before);
  });
  test("runtime cannot create application objects or weaken the installed guards", async () => {
    await assertRuntime();
    await expectSqlRefusal(
      () =>
        attemptWithoutEffects(
          sql`create table public.${sql.identifier(`ctx_forbidden_${suffix}`)}(id integer)`,
        ),
      "42501",
    );
    await expectSqlRefusal(
      () =>
        attemptWithoutEffects(sql`alter table public.scout_history_context
        disable trigger scout_history_context_append_only`),
      "42501",
    );
    await expectSqlRefusal(
      () =>
        attemptWithoutEffects(sql`alter function public.scout_history_run_context_once()
        security definer`),
      "42501",
    );
  });
});
