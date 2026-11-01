import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { finalizeRunEvents } from "@copilotkit/runtime/v2";
import { and, asc, count, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  scoutHistoryEvents as events,
  type HistoryRunStatus,
  scoutHistoryRuns as runs,
  scoutHistoryThreads as threads,
} from "../../db/schema/scout-history";
import {
  HistoryError,
  type HistoryPrincipal,
  historyDigest,
  historyEvent,
  historyInput,
  historyJson,
  historyResume,
  historyState,
  mergeHistory,
  replayHistory,
} from "./protocol";

export type HistoryThread = Omit<typeof threads.$inferSelect, "snapshot">;
const metadata = {
  id: threads.id,
  ownerUserId: threads.ownerUserId,
  tenantId: threads.tenantId,
  agentId: threads.agentId,
  channelId: threads.channelId,
  name: threads.name,
  archived: threads.archived,
  sequence: threads.sequence,
  bytes: threads.bytes,
  createdAt: threads.createdAt,
  updatedAt: threads.updatedAt,
};
type HistoryRun = typeof runs.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type HistoryLease = {
  principal: HistoryPrincipal;
  threadId: string;
  runId: string;
  token: string;
};
export type HistoryLimits = {
  maxThreads: number;
  maxRuns: number;
  maxEvents: number;
  maxBytes: number;
  leaseMs: number;
};
const defaults: HistoryLimits = {
  maxThreads: 500,
  maxRuns: 500,
  maxEvents: 20_000,
  maxBytes: 16 * 1024 * 1024,
  leaseMs: 30_000,
};
const active = ["running", "stop_requested"] as const;
export const terminalHistoryRun = (status: HistoryRunStatus) =>
  !active.includes(status as (typeof active)[number]);

function owned(principal: HistoryPrincipal, id?: string) {
  if (
    !principal.userId ||
    !principal.tenantId ||
    principal.userId.length > 200 ||
    principal.tenantId.length > 100
  )
    throw new HistoryError("HISTORY_ACCESS_DENIED");
  return and(
    eq(threads.ownerUserId, principal.userId),
    eq(threads.tenantId, principal.tenantId),
    id === undefined ? undefined : eq(threads.id, id),
  );
}
const runKey = (threadId: string, runId: string) =>
  and(eq(runs.threadId, threadId), eq(runs.id, runId));

/** Internal database port. Only a server-authenticated, request-bound service may expose its data. */
export function createHistoryStore(
  database: Database,
  options: Partial<HistoryLimits> = {},
) {
  const limits = { ...defaults, ...options };
  for (const [key, value] of Object.entries(limits))
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > defaults[key as keyof HistoryLimits]
    )
      throw new HistoryError("HISTORY_INPUT_INVALID");
  const expiry = () =>
    sql`clock_timestamp() + ${limits.leaseMs} * interval '1 millisecond'`;

  async function runEvents(tx: Transaction, threadId: string, runId: string) {
    return tx
      .select()
      .from(events)
      .where(and(eq(events.threadId, threadId), eq(events.runId, runId)))
      .orderBy(asc(events.sequence));
  }
  async function writeEvents(
    tx: Transaction,
    thread: HistoryThread,
    runId: string,
    values: BaseEvent[],
    final = false,
  ) {
    const normalized = values.map((event) =>
      historyEvent(event, thread.id, runId),
    );
    const bytes = normalized.reduce(
      (sum, value) => sum + Buffer.byteLength(JSON.stringify(value)),
      0,
    );
    // Space for deterministic terminal markers is reserved even when normal admission is full.
    const multiplier = final ? 4 : 1;
    if (
      thread.sequence + values.length >
        limits.maxEvents * multiplier + (final ? 100 : 0) ||
      thread.bytes + bytes >
        limits.maxBytes * multiplier + (final ? 1_048_576 : 0)
    )
      throw new HistoryError("HISTORY_LIMIT");
    if (normalized.length)
      await tx.insert(events).values(
        normalized.map((event, offset) => ({
          threadId: thread.id,
          runId,
          sequence: thread.sequence + offset + 1,
          event,
        })),
      );
    const [updated] = await tx
      .update(threads)
      .set({
        sequence: thread.sequence + normalized.length,
        bytes: thread.bytes + bytes,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(threads.id, thread.id))
      .returning(metadata);
    Object.assign(thread, updated);
  }

  async function finalize(
    tx: Transaction,
    thread: HistoryThread,
    run: HistoryRun,
    status: "completed" | "cancelled" | "interrupted",
  ) {
    const persisted = (await runEvents(tx, thread.id, run.id)).map(
      (row) => row.event,
    );
    const terminal = persisted.findLast(
      (event) =>
        event.type === EventType.RUN_FINISHED ||
        event.type === EventType.RUN_ERROR,
    );
    if (terminal?.type === EventType.RUN_ERROR) status = "interrupted";
    if (terminal?.type === EventType.RUN_FINISHED) {
      const outcome = terminal.outcome;
      status =
        outcome &&
        typeof outcome === "object" &&
        "type" in outcome &&
        outcome.type === "cancelled"
          ? "cancelled"
          : "completed";
    }
    const stopRequested = status === "cancelled";
    const appended = finalizeRunEvents(persisted, {
      protocolVersion: run.input.protocolVersion,
      stopRequested,
      ...(status === "interrupted"
        ? {
            interruptionMessage:
              "This run was interrupted. It was not executed again.",
          }
        : {}),
    });
    const snapshot = await replayHistory(run.input, persisted);
    await writeEvents(tx, thread, run.id, appended, true);
    const [updated] = await tx
      .update(threads)
      .set({ snapshot, updatedAt: sql`clock_timestamp()` })
      .where(eq(threads.id, thread.id))
      .returning(metadata);
    Object.assign(thread, updated);
    await tx
      .update(runs)
      .set({ status, finishedAt: sql`clock_timestamp()` })
      .where(runKey(thread.id, run.id));
  }
  async function recoverExpired(tx: Transaction, thread: HistoryThread) {
    const expired = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.threadId, thread.id),
          inArray(runs.status, [...active]),
          lte(runs.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      );
    for (const run of expired)
      await finalize(
        tx,
        thread,
        run,
        run.status === "stop_requested" ? "cancelled" : "interrupted",
      );
  }
  async function locked<T>(
    principal: HistoryPrincipal,
    id: string,
    use: (tx: Transaction, thread: HistoryThread) => Promise<T>,
  ) {
    return database.transaction(async (tx) => {
      const [thread] = await tx
        .select(metadata)
        .from(threads)
        .where(owned(principal, id))
        .for("update");
      if (!thread) throw new HistoryError("HISTORY_NOT_FOUND");
      await recoverExpired(tx, thread);
      return use(tx, thread);
    });
  }
  async function leased(tx: Transaction, lease: HistoryLease) {
    const [run] = await tx
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          runKey(lease.threadId, lease.runId),
          eq(runs.leaseToken, lease.token),
          inArray(runs.status, [...active]),
          gt(runs.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      );
    if (!run) throw new HistoryError("HISTORY_LEASE_LOST");
    return run;
  }

  async function mintWithin(
    tx: Transaction,
    principal: HistoryPrincipal,
    input: { agentId: string; channelId?: string },
    id: string,
  ) {
    if (
      !input.agentId ||
      input.agentId.length > 200 ||
      (input.channelId !== undefined &&
        (!input.channelId || input.channelId.length > 200))
    )
      throw new HistoryError("HISTORY_INPUT_INVALID");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["scout-history-mint", principal.userId, principal.tenantId])}, 0))`,
    );
    const [total] = await tx
      .select({ count: count() })
      .from(threads)
      .where(owned(principal));
    if (total.count >= limits.maxThreads)
      throw new HistoryError("HISTORY_LIMIT");
    const [thread] = await tx
      .insert(threads)
      .values({
        id,
        ownerUserId: principal.userId,
        tenantId: principal.tenantId,
        agentId: input.agentId,
        channelId: input.channelId ?? null,
      })
      .returning(metadata);
    return thread;
  }

  return {
    limits,
    mint(
      principal: HistoryPrincipal,
      input: { agentId: string; channelId?: string },
    ) {
      return database.transaction((tx) =>
        mintWithin(tx, principal, input, randomUUID()),
      );
    },
    /** Internal channel-creation port: ID is minted by the server and committed with its native mapping. */
    mintForChannel(
      tx: Transaction,
      principal: HistoryPrincipal,
      input: { id: string; agentId: string; channelId: string },
    ) {
      return mintWithin(tx, principal, input, input.id);
    },
    get(principal: HistoryPrincipal, threadId: string) {
      return locked(principal, threadId, async (_tx, thread) => thread);
    },
    async list(principal: HistoryPrincipal) {
      return database
        .select(metadata)
        .from(threads)
        .where(owned(principal))
        .orderBy(desc(threads.updatedAt), desc(threads.id))
        .limit(limits.maxThreads);
    },
    async snapshot(principal: HistoryPrincipal, threadId: string) {
      return locked(principal, threadId, async (tx, thread) => {
        const [run] = await tx
          .select()
          .from(runs)
          .where(
            and(eq(runs.threadId, threadId), inArray(runs.status, [...active])),
          )
          .limit(1);
        if (!run) {
          const [row] = await tx
            .select({ snapshot: threads.snapshot })
            .from(threads)
            .where(eq(threads.id, thread.id));
          return row.snapshot;
        }
        return replayHistory(
          run.input,
          (await runEvents(tx, threadId, run.id)).map((row) => row.event),
        );
      });
    },
    async start(
      principal: HistoryPrincipal,
      agentId: string,
      value: RunAgentInput,
    ): Promise<
      | { execute: false; runId: string }
      | { execute: true; lease: HistoryLease; input: RunAgentInput }
    > {
      const input = historyInput(value);
      const digest = historyDigest({ agentId, input });
      return locked(principal, input.threadId, async (tx, thread) => {
        if (thread.agentId !== agentId)
          throw new HistoryError("HISTORY_NOT_FOUND");
        const [existing] = await tx
          .select()
          .from(runs)
          .where(runKey(thread.id, input.runId));
        if (existing) {
          if (existing.requestDigest !== digest || existing.agentId !== agentId)
            throw new HistoryError("HISTORY_CONFLICT");
          return { execute: false, runId: existing.id };
        }
        const [running] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.threadId, thread.id),
              inArray(runs.status, [...active]),
            ),
          );
        if (running) throw new HistoryError("HISTORY_CONFLICT");
        const [total] = await tx
          .select({ count: count() })
          .from(runs)
          .where(eq(runs.threadId, thread.id));
        if (thread.archived || total.count >= limits.maxRuns)
          throw new HistoryError("HISTORY_LIMIT");
        const [saved] = await tx
          .select({ snapshot: threads.snapshot })
          .from(threads)
          .where(eq(threads.id, thread.id));
        const [previous] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.threadId, thread.id))
          .orderBy(desc(runs.startedAt), desc(runs.id))
          .limit(1);
        const [last] = previous
          ? await tx
              .select({ event: events.event })
              .from(events)
              .where(
                and(
                  eq(events.threadId, thread.id),
                  eq(events.runId, previous.id),
                  sql`${events.event}->>'type' in ('RUN_FINISHED', 'RUN_ERROR')`,
                ),
              )
              .orderBy(desc(events.sequence))
              .limit(1)
          : [];
        const [clock] = await tx.execute<{ now: number }>(
          sql`select extract(epoch from clock_timestamp()) * 1000 as now`,
        );
        const resuming = historyResume(input, last?.event, Number(clock.now));
        const canonical = historyJson({
          ...input,
          // Browser state is data, never the authority to overwrite persisted agent state.
          state: saved.snapshot.state,
          messages: mergeHistory(
            saved.snapshot.messages,
            input.messages,
            resuming,
          ),
        });
        const token = randomUUID();
        await tx.insert(runs).values({
          threadId: thread.id,
          id: input.runId,
          agentId,
          requestDigest: digest,
          input: canonical,
          status: "running",
          leaseToken: token,
          leaseExpiresAt: expiry(),
        });
        thread.bytes += Buffer.byteLength(JSON.stringify(canonical));
        await writeEvents(tx, thread, input.runId, [
          {
            type: EventType.RUN_STARTED,
            threadId: thread.id,
            runId: input.runId,
            input: canonical,
          },
          { type: EventType.MESSAGES_SNAPSHOT, messages: canonical.messages },
          { type: EventType.STATE_SNAPSHOT, snapshot: canonical.state },
        ]);
        await tx
          .update(threads)
          .set({
            snapshot: sql`jsonb_set(${threads.snapshot}, '{state}', ${JSON.stringify(canonical.state)}::jsonb, true)`,
          })
          .where(eq(threads.id, thread.id));
        return {
          execute: true,
          lease: {
            principal: { ...principal },
            threadId: thread.id,
            runId: input.runId,
            token,
          },
          input: canonical,
        };
      });
    },
    append(lease: HistoryLease, event: BaseEvent) {
      return locked(lease.principal, lease.threadId, async (tx, thread) => {
        const run = await leased(tx, lease);
        if (run.status === "stop_requested") return { stopRequested: true };
        if (event.type === EventType.RUN_STARTED) {
          historyEvent(event, lease.threadId, lease.runId);
          return { stopRequested: false };
        }
        const normalized = historyEvent(event, lease.threadId, lease.runId);
        if (
          normalized.type === EventType.STATE_DELTA ||
          normalized.type === EventType.STATE_SNAPSHOT
        ) {
          const [current] = await tx
            .select({ state: sql`${threads.snapshot}->'state'` })
            .from(threads)
            .where(eq(threads.id, thread.id));
          const state = historyState(current.state, normalized);
          await tx
            .update(threads)
            .set({
              snapshot: sql`jsonb_set(${threads.snapshot}, '{state}', ${JSON.stringify(state)}::jsonb, true)`,
            })
            .where(eq(threads.id, thread.id));
        }
        await writeEvents(tx, thread, lease.runId, [normalized]);
        await tx
          .update(runs)
          .set({ leaseExpiresAt: expiry() })
          .where(runKey(thread.id, run.id));
        return { stopRequested: false };
      });
    },
    renew(lease: HistoryLease) {
      return locked(lease.principal, lease.threadId, async (tx) => {
        const run = await leased(tx, lease);
        await tx
          .update(runs)
          .set({ leaseExpiresAt: expiry() })
          .where(runKey(lease.threadId, run.id));
        return { stopRequested: run.status === "stop_requested" };
      });
    },
    finish(lease: HistoryLease, result: "completed" | "interrupted") {
      return locked(lease.principal, lease.threadId, async (tx, thread) => {
        const run = await leased(tx, lease);
        const status = run.status === "stop_requested" ? "cancelled" : result;
        const [full] = await tx
          .select()
          .from(runs)
          .where(runKey(thread.id, run.id));
        await finalize(tx, thread, full, status);
      });
    },
    stop(principal: HistoryPrincipal, threadId: string, runId?: string) {
      return locked(principal, threadId, async (tx) => {
        if (!runId) throw new HistoryError("HISTORY_INPUT_INVALID");
        const [run] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.threadId, threadId),
              eq(runs.status, "running"),
              eq(runs.id, runId),
            ),
          );
        if (!run) return false;
        const rows = await runEvents(tx, threadId, run.id);
        if (
          rows.some(
            ({ event }) =>
              event.type === EventType.RUN_FINISHED ||
              event.type === EventType.RUN_ERROR,
          )
        )
          return false;
        await tx
          .update(runs)
          .set({ status: "stop_requested" })
          .where(runKey(threadId, run.id));
        return true;
      });
    },
    status(principal: HistoryPrincipal, threadId: string) {
      return locked(principal, threadId, async (tx) => {
        const [run] = await tx
          .select({ status: runs.status })
          .from(runs)
          .where(
            and(eq(runs.threadId, threadId), inArray(runs.status, [...active])),
          )
          .limit(1);
        return { running: run !== undefined };
      });
    },
    page(
      principal: HistoryPrincipal,
      threadId: string,
      after = 0,
      runId?: string,
    ) {
      if (!Number.isSafeInteger(after) || after < 0)
        throw new HistoryError("HISTORY_INPUT_INVALID");
      return locked(principal, threadId, async (tx, thread) => {
        const rows = await tx
          .select({ sequence: events.sequence, event: events.event })
          .from(events)
          .where(
            and(
              eq(events.threadId, threadId),
              gt(events.sequence, after),
              runId === undefined ? undefined : eq(events.runId, runId),
            ),
          )
          .orderBy(asc(events.sequence))
          .limit(128);
        const [run] = await tx
          .select({ status: runs.status })
          .from(runs)
          .where(
            and(
              eq(runs.threadId, threadId),
              runId === undefined ? undefined : eq(runs.id, runId),
            ),
          )
          .orderBy(desc(runs.startedAt), desc(runs.id))
          .limit(1);
        return {
          events: rows,
          tail: thread.sequence,
          running: run !== undefined && !terminalHistoryRun(run.status),
        };
      });
    },
  };
}
export type HistoryStore = ReturnType<typeof createHistoryStore>;
