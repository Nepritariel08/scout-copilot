import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  scoutHistoryContext,
  scoutHistoryRuns,
} from "../src/db/schema/scout-history";
import { createHistoryContextStore } from "../src/scout/history/context-store";
import { createHistoryStore } from "../src/scout/history/store";
import type { ContextDependency } from "../src/scout/owned-model/context-dependency";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const owner = {
  userId: `context-history-${randomUUID()}`,
  tenantId: "synthetic-tenant",
};
const history = createHistoryStore(database),
  contexts = createHistoryContextStore(database);
const dependency = (recordId = 42): ContextDependency => ({
  kind: "odoo.project_task_summary.v1",
  principal: {
    ...owner,
    deploymentId: "test",
    bindingFingerprint: "a".repeat(64),
  },
  sourceInstanceId: "synthetic-odoo",
  recordId,
  provider: "local",
  modelPolicyFingerprint: "b".repeat(64),
  grantDigest: "c".repeat(64),
  releaseDigest: "d".repeat(64),
  recordDigest: "e".repeat(64),
});
async function started() {
  const thread = await history.mint(owner, { agentId: "scout" });
  const runId = randomUUID();
  const result = await history.start(owner, "scout", {
    threadId: thread.id,
    runId,
    messages: [
      { id: randomUUID(), role: "user", content: "Synthetic request" },
    ],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  });
  if (!result.execute) throw new Error("Expected new synthetic run");
  return { thread, runId, lease: result.lease };
}
beforeAll(async () => {
  await database.execute(
    sql`insert into users(id,email) values (${owner.userId}, ${`${owner.userId}@fixture.invalid`})`,
  );
});
afterAll(async () => {
  await database.execute(sql`delete from users where id=${owner.userId}`);
  await database.$client.end();
});
describe("durable source provenance SQL fencing", () => {
  test("new source-free markers are atomic; absent legacy markers cannot be adopted", async () => {
    const { thread, runId } = await started();
    expect(await contexts.read(owner, thread.id)).toEqual({
      version: 1,
      revision: 0,
      dependencies: [],
    });
    await database
      .delete(scoutHistoryContext)
      .where(eq(scoutHistoryContext.threadId, thread.id));
    await expect(contexts.read(owner, thread.id)).rejects.toThrow(
      "HISTORY_ACCESS_DENIED",
    );
    await expect(
      contexts.append(owner, thread.id, "scout", runId, dependency()),
    ).rejects.toThrow("HISTORY_ACCESS_DENIED");
    const fresh = await history.mint(owner, { agentId: "scout" });
    expect((await contexts.read(owner, fresh.id)).dependencies).toEqual([]);
  });
  test("exact retries are idempotent, older dependencies survive, and SQL replacement rolls back", async () => {
    const { thread, runId } = await started();
    await contexts.append(owner, thread.id, "scout", runId, dependency());
    await contexts.append(owner, thread.id, "scout", runId, dependency());
    expect((await contexts.read(owner, thread.id)).revision).toBe(1);
    await contexts.append(owner, thread.id, "scout", runId, dependency(43));
    const before = await contexts.read(owner, thread.id);
    expect(
      await createHistoryContextStore(database).read(owner, thread.id),
    ).toEqual(before);
    expect(before.dependencies.map((d) => d.recordId)).toEqual([42, 43]);
    await expect(
      database.execute(
        sql`update scout_history_context set revision=1,dependencies=${JSON.stringify([dependency(44)])}::jsonb where thread_id=${thread.id}`,
      ),
    ).rejects.toThrow();
    expect(await contexts.read(owner, thread.id)).toEqual(before);
    await expect(
      database.execute(
        sql`update scout_history_context set revision=3,dependencies=${JSON.stringify([dependency(44), dependency(43), dependency(45)])}::jsonb where thread_id=${thread.id}`,
      ),
    ).rejects.toThrow();
    expect(await contexts.read(owner, thread.id)).toEqual(before);
  });
  test("wrong user, tenant, agent, run, expired lease and terminal run cannot mark a thread", async () => {
    const { thread, runId, lease } = await started();
    await expect(
      contexts.read({ ...owner, userId: "other-user" }, thread.id),
    ).rejects.toThrow();
    await expect(
      contexts.read({ ...owner, tenantId: "other-tenant" }, thread.id),
    ).rejects.toThrow();
    for (const [agent, run] of [
      ["other-agent", runId],
      ["scout", "unknown-run"],
    ])
      await expect(
        contexts.append(owner, thread.id, agent!, run!, dependency()),
      ).rejects.toThrow();
    await expect(
      contexts.append(
        { ...owner, userId: "other-user" },
        thread.id,
        "scout",
        runId,
        dependency(),
      ),
    ).rejects.toThrow();
    await history.finish(lease, "completed");
    await expect(
      contexts.append(owner, thread.id, "scout", runId, dependency()),
    ).rejects.toThrow();
    const second = await started();
    await database
      .update(scoutHistoryRuns)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(scoutHistoryRuns.threadId, second.thread.id));
    await expect(
      contexts.append(
        owner,
        second.thread.id,
        "scout",
        second.runId,
        dependency(),
      ),
    ).rejects.toThrow();
    expect((await contexts.read(owner, second.thread.id)).revision).toBe(0);
  });
  test("bounded dependency exhaustion refuses without dropping older provenance", async () => {
    const { thread, runId } = await started();
    for (let recordId = 1; recordId <= 16; recordId++)
      await contexts.append(
        owner,
        thread.id,
        "scout",
        runId,
        dependency(recordId),
      );
    await expect(
      contexts.append(owner, thread.id, "scout", runId, dependency(17)),
    ).rejects.toThrow("HISTORY_ACCESS_DENIED");
    expect(
      (await contexts.read(owner, thread.id)).dependencies.map(
        (entry) => entry.recordId,
      ),
    ).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
  test("durable turn markers inherit the dependency prefix, reject stale revisions, and cannot be rewritten", async () => {
    const { thread, runId, lease } = await started();
    await contexts.append(owner, thread.id, "scout", runId, dependency());
    await expect(
      contexts.markRun(owner, thread.id, "scout", runId, 0),
    ).rejects.toThrow();
    await contexts.markRun(owner, thread.id, "scout", runId, 1);
    await contexts.markRun(owner, thread.id, "scout", runId, 1);
    await expect(
      database.execute(
        sql`update scout_history_runs set context_revision=0 where thread_id=${thread.id} and id=${runId}`,
      ),
    ).rejects.toThrow();
    await history.finish(lease, "completed");
    const nextId = randomUUID();
    await history.start(owner, "scout", {
      threadId: thread.id,
      runId: nextId,
      state: {},
      context: [],
      tools: [],
      forwardedProps: {},
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: "Synthetic ordinary continuation",
        },
      ],
    });
    await contexts.markRun(owner, thread.id, "scout", nextId, 1);
    const turns = await database
      .select({ revision: scoutHistoryRuns.contextRevision })
      .from(scoutHistoryRuns)
      .where(eq(scoutHistoryRuns.threadId, thread.id));
    expect(turns.map((turn) => turn.revision)).toEqual([1, 1]);
    const fresh = await started();
    await contexts.markRun(owner, fresh.thread.id, "scout", fresh.runId, 0);
    expect(
      (
        await database
          .select({ revision: scoutHistoryRuns.contextRevision })
          .from(scoutHistoryRuns)
          .where(eq(scoutHistoryRuns.threadId, fresh.thread.id))
      )[0]?.revision,
    ).toBe(0);
  });
});
