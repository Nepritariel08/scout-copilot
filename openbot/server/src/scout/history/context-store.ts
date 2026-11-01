import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  scoutHistoryContext as contexts,
  scoutHistoryRuns as runs,
  scoutHistoryThreads as threads,
} from "../../db/schema/scout-history";
import {
  type ContextDependency,
  contextDependencySchema,
  historyContextSchema,
} from "../owned-model/context-dependency";
import { HistoryError, type HistoryPrincipal, historyDigest } from "./protocol";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const deny = () => new HistoryError("HISTORY_ACCESS_DENIED");

/** Only called in the transaction that creates a NEW history thread. No legacy adoption. */
export async function stampNewHistoryContext(
  tx: Transaction,
  threadId: string,
) {
  await tx
    .insert(contexts)
    .values({ threadId, version: 1, revision: 0, dependencies: [] });
}

export function createHistoryContextStore(database: Database) {
  const owned = (principal: HistoryPrincipal, threadId: string) =>
    and(
      eq(threads.id, threadId),
      eq(threads.ownerUserId, principal.userId),
      eq(threads.tenantId, principal.tenantId),
    );
  return {
    async read(principal: HistoryPrincipal, threadId: string) {
      const [row] = await database
        .select({
          version: contexts.version,
          revision: contexts.revision,
          dependencies: contexts.dependencies,
        })
        .from(contexts)
        .innerJoin(threads, eq(contexts.threadId, threads.id))
        .where(owned(principal, threadId));
      const parsed = historyContextSchema.safeParse(row);
      if (!parsed.success) throw deny();
      return parsed.data;
    },
    /** Freeze this run's dependency prefix before its first owned-model dispatch. */
    async markRun(
      principal: HistoryPrincipal,
      threadId: string,
      agentId: string,
      runId: string,
      revision: number,
    ) {
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > 16)
        throw deny();
      await database.transaction(async (tx) => {
        const [thread] = await tx
          .select({ agentId: threads.agentId })
          .from(threads)
          .where(owned(principal, threadId))
          .for("update");
        if (!thread || thread.agentId !== agentId) throw deny();
        const [context] = await tx
          .select({ revision: contexts.revision })
          .from(contexts)
          .where(eq(contexts.threadId, threadId));
        if (!context || context.revision !== revision) throw deny();
        const [run] = await tx
          .select({ contextRevision: runs.contextRevision })
          .from(runs)
          .where(
            and(
              eq(runs.threadId, threadId),
              eq(runs.id, runId),
              eq(runs.agentId, agentId),
              eq(runs.status, "running"),
              gt(runs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .for("update");
        if (
          !run ||
          (run.contextRevision !== null && run.contextRevision !== revision)
        )
          throw deny();
        if (run.contextRevision === null)
          await tx
            .update(runs)
            .set({ contextRevision: revision })
            .where(and(eq(runs.threadId, threadId), eq(runs.id, runId)));
      });
    },
    /** Server-only: durable marking must succeed BEFORE context can reach any provider. */
    async append(
      principal: HistoryPrincipal,
      threadId: string,
      agentId: string,
      runId: string,
      value: ContextDependency,
    ) {
      const parsed = contextDependencySchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.principal.userId !== principal.userId ||
        parsed.data.principal.tenantId !== principal.tenantId
      )
        throw deny();
      const dependency = parsed.data;
      return database.transaction(async (tx) => {
        const [thread] = await tx
          .select({ id: threads.id, agentId: threads.agentId })
          .from(threads)
          .where(owned(principal, threadId))
          .for("update");
        if (!thread || thread.agentId !== agentId) throw deny();
        const [run] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.threadId, threadId),
              eq(runs.id, runId),
              eq(runs.agentId, agentId),
              eq(runs.status, "running"),
              gt(runs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          );
        if (!run) throw deny();
        const [row] = await tx
          .select({
            version: contexts.version,
            revision: contexts.revision,
            dependencies: contexts.dependencies,
          })
          .from(contexts)
          .where(eq(contexts.threadId, threadId))
          .for("update");
        const current = historyContextSchema.safeParse(row);
        if (!current.success) throw deny();
        if (
          current.data.dependencies.some(
            (entry) => historyDigest(entry) === historyDigest(dependency),
          )
        )
          return;
        if (current.data.dependencies.length >= 16) throw deny();
        await tx
          .update(contexts)
          .set({
            revision: current.data.revision + 1,
            dependencies: [...current.data.dependencies, dependency],
          })
          .where(eq(contexts.threadId, threadId));
      });
    },
  };
}
export type HistoryContextStore = ReturnType<typeof createHistoryContextStore>;
