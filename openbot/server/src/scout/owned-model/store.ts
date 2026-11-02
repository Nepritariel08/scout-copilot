import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  scoutHistoryRuns as runs,
  scoutHistoryThreads as threads,
} from "../../db/schema/scout-history";
import { scoutModelCalls as calls } from "../../db/schema/scout-model";
import {
  type ModelGrant,
  ModelPolicyError,
  type ModelPrincipal,
  PAID_PHALA_PROFILE,
} from "./policy";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Call = typeof calls.$inferSelect;
export type ModelRun = ModelPrincipal & { threadId: string; runId: string };
export type ModelUsage = {
  outputBytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedCostUsd: string | null;
  reportedModel: string | null;
};
const active = ["reserved", "dispatched"] as const;

/** A lease here never authorizes a run: the current owned history lease must exist as well. */
export function createModelCallStore(database: Database) {
  async function historyLease(
    tx: Transaction,
    scope: ModelRun,
    token?: string,
  ) {
    // Match the history store's lock order, including deletion/stop, to avoid an inverted lock.
    const [thread] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.id, scope.threadId),
          eq(threads.ownerUserId, scope.userId),
          eq(threads.tenantId, scope.tenantId),
          eq(threads.agentId, scope.agentId),
        ),
      )
      .for("update");
    if (!thread) throw new ModelPolicyError("MODEL_ACCESS_DENIED");
    const [run] = await tx
      .select({ token: runs.leaseToken })
      .from(runs)
      .where(
        and(
          eq(runs.threadId, scope.threadId),
          eq(runs.id, scope.runId),
          eq(runs.agentId, scope.agentId),
          eq(runs.status, "running"),
          gt(runs.leaseExpiresAt, sql`clock_timestamp()`),
          token ? eq(runs.leaseToken, token) : undefined,
        ),
      );
    if (!run) throw new ModelPolicyError("MODEL_CONFLICT");
    return run.token;
  }
  const actor = (scope: ModelPrincipal) =>
    and(
      eq(calls.deploymentId, scope.deploymentId),
      eq(calls.ownerUserId, scope.userId),
      eq(calls.tenantId, scope.tenantId),
    );
  const key = (call: Call) =>
    and(eq(calls.id, call.id), eq(calls.leaseToken, call.leaseToken));
  async function sweep(
    tx: Transaction,
    deploymentId: string,
    scope?: ModelPrincipal,
    threadId?: string,
  ) {
    await tx
      .update(calls)
      .set({
        status: sql`case when ${calls.status} = 'reserved' then 'refused' else 'uncertain' end`,
        errorCode: "MODEL_LEASE_EXPIRED",
        finishedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(calls.deploymentId, deploymentId),
          scope ? actor(scope) : undefined,
          threadId ? eq(calls.threadId, threadId) : undefined,
          inArray(calls.status, active),
          lte(calls.expiresAt, sql`clock_timestamp()`),
        ),
      );
  }
  return {
    async reserve(
      scope: ModelRun,
      grant: ModelGrant,
      input: { digest: string; bytes: number; endpointOrigin: string },
    ) {
      if (
        scope.userId !== grant.userId ||
        scope.tenantId !== grant.tenantId ||
        scope.deploymentId !== grant.deploymentId ||
        !grant.agentIds.includes(scope.agentId) ||
        input.bytes > grant.limits.maxInputBytes
      )
        throw new ModelPolicyError("MODEL_ACCESS_DENIED");
      const reservation = await database.transaction(async (tx) => {
        // One short admission lock across processes. No provider I/O is performed inside it.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`scout-model:${scope.deploymentId}`}, 0))`,
        );
        await sweep(tx, scope.deploymentId);
        const leaseToken = await historyLease(tx, scope);
        // A transaction can begin before midnight and wait for either lock. Use one
        // database instant after admission waits, never DEFAULT now() (transaction start).
        const [admission] = await tx.execute<{ admittedAt: string }>(
          sql`select clock_timestamp()::text as "admittedAt"`,
        );
        if (!admission) throw new ModelPolicyError("MODEL_UNAVAILABLE");
        const admittedAt = sql`${admission.admittedAt}::timestamptz`;
        const day = sql`date_trunc('day', ${admittedAt} at time zone 'UTC') at time zone 'UTC'`;
        const [totals] = await tx
          .select({
            daily: sql<number>`count(*) filter (where ${calls.createdAt} >= ${day})::int`,
            userDaily: sql<number>`count(*) filter (where ${calls.createdAt} >= ${day} and ${calls.ownerUserId} = ${scope.userId} and ${calls.tenantId} = ${scope.tenantId})::int`,
            active: sql<number>`count(*) filter (where ${calls.status} in ('reserved','dispatched'))::int`,
            userActive: sql<number>`count(*) filter (where ${calls.status} in ('reserved','dispatched') and ${calls.ownerUserId} = ${scope.userId} and ${calls.tenantId} = ${scope.tenantId})::int`,
            costViolations: sql<number>`count(*) filter (where ${calls.createdAt} >= ${day} and ${calls.errorCode} = 'MODEL_COST_VIOLATION')::int`,
          })
          .from(calls)
          .where(eq(calls.deploymentId, scope.deploymentId));
        const [perRun] = await tx
          .select({ count: count() })
          .from(calls)
          .where(
            and(
              eq(calls.threadId, scope.threadId),
              eq(calls.runId, scope.runId),
            ),
          );
        const paid =
          grant.route.provider === "openrouter" && !!grant.route.paidProfile;
        const globalDailyLimit = paid
          ? Math.min(
              grant.globalMaxCallsPerDay,
              PAID_PHALA_PROFILE.maxCallsPerDay,
            )
          : grant.globalMaxCallsPerDay;
        if (
          !totals ||
          totals.daily >= globalDailyLimit ||
          (paid && totals.costViolations > 0) ||
          totals.userDaily >= grant.limits.maxCallsPerDay ||
          totals.active >= grant.globalMaxConcurrent ||
          totals.userActive >= grant.limits.maxConcurrent ||
          (perRun?.count ?? 0) >= grant.limits.maxCallsPerRun
        )
          // Commit expiry recovery even when this run has exhausted its budget.
          return null;
        const [call] = await tx
          .insert(calls)
          .values({
            id: randomUUID(),
            ownerUserId: scope.userId,
            tenantId: scope.tenantId,
            deploymentId: scope.deploymentId,
            threadId: scope.threadId,
            runId: scope.runId,
            agentId: scope.agentId,
            ordinal: (perRun?.count ?? 0) + 1,
            leaseToken,
            policyFingerprint: grant.fingerprint,
            policyRevision: grant.revision,
            provider: grant.route.provider,
            requestedModel: grant.route.model,
            endpointOrigin: input.endpointOrigin,
            inputBytes: input.bytes,
            requestDigest: input.digest,
            status: "reserved",
            createdAt: admittedAt,
            expiresAt: sql`${admittedAt} + ${grant.limits.timeoutMs + 5000} * interval '1 millisecond'`,
          })
          .returning();
        if (!call) throw new ModelPolicyError("MODEL_UNAVAILABLE");
        return call;
      });
      if (!reservation) throw new ModelPolicyError("MODEL_LIMIT");
      return reservation;
    },
    async dispatch(scope: ModelRun, call: Call, grant: ModelGrant) {
      if (grant.fingerprint !== call.policyFingerprint)
        throw new ModelPolicyError("MODEL_ACCESS_DENIED");
      await database.transaction(async (tx) => {
        await historyLease(tx, scope, call.leaseToken);
        const [changed] = await tx
          .update(calls)
          .set({
            status: "dispatched",
            dispatchedAt: sql`clock_timestamp()`,
            expiresAt: sql`clock_timestamp() + ${grant.limits.timeoutMs + 5000} * interval '1 millisecond'`,
          })
          .where(
            and(
              key(call),
              actor(scope),
              eq(calls.status, "reserved"),
              gt(calls.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ id: calls.id });
        if (!changed) throw new ModelPolicyError("MODEL_CONFLICT");
      });
    },
    async finish(
      call: Call,
      status: "completed" | "refused" | "uncertain",
      usage?: ModelUsage,
      errorCode?: string,
    ) {
      await database.transaction(async (tx) => {
        if (status === "completed")
          await historyLease(
            tx,
            {
              userId: call.ownerUserId,
              tenantId: call.tenantId,
              deploymentId: call.deploymentId,
              agentId: call.agentId,
              threadId: call.threadId,
              runId: call.runId,
            },
            call.leaseToken,
          );
        const [changed] = await tx
          .update(calls)
          .set({
            status,
            ...usage,
            errorCode: errorCode ?? null,
            finishedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              key(call),
              status === "completed"
                ? eq(calls.status, "dispatched")
                : inArray(calls.status, active),
              status === "completed"
                ? gt(calls.expiresAt, sql`clock_timestamp()`)
                : undefined,
            ),
          )
          .returning({ id: calls.id });
        if (!changed && status === "completed")
          throw new ModelPolicyError("MODEL_CONFLICT");
      });
    },
    async receipts(scope: ModelPrincipal, threadId: string) {
      // Recovery must also become visible when the owner only reads after a process crash.
      await database.transaction((tx) =>
        sweep(tx, scope.deploymentId, scope, threadId),
      );
      // Deliberately omit private lease tokens, key paths, raw prompts and policy contents.
      return database
        .select({
          id: calls.id,
          runId: calls.runId,
          ordinal: calls.ordinal,
          provider: calls.provider,
          requestedModel: calls.requestedModel,
          reportedModel: calls.reportedModel,
          inputBytes: calls.inputBytes,
          outputBytes: calls.outputBytes,
          inputTokens: calls.inputTokens,
          outputTokens: calls.outputTokens,
          reportedCostUsd: calls.reportedCostUsd,
          status: calls.status,
          errorCode: calls.errorCode,
          createdAt: calls.createdAt,
          finishedAt: calls.finishedAt,
        })
        .from(calls)
        .where(
          and(
            actor(scope),
            eq(calls.agentId, scope.agentId),
            eq(calls.threadId, threadId),
          ),
        )
        .orderBy(desc(calls.createdAt))
        .limit(100);
    },
  };
}
export type ModelCallStore = ReturnType<typeof createModelCallStore>;
