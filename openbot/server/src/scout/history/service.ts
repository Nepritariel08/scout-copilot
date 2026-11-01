import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { HistoryError, type HistoryPrincipal } from "./protocol";
import type { HistoryLease, HistoryStore, HistoryThread } from "./store";

export type HistoryOperation = "mint" | "read" | "run" | "stop";
export type HistoryResource = {
  id?: string;
  agentId: string;
  channelId: string | null;
};
export type HistoryAuthority = {
  /** Resolve only a verified native session and its current tenant membership. */
  principal(): Promise<HistoryPrincipal | null>;
  /** Exact true grants access. Re-check channel/agent grants; absence or errors deny. */
  authorize(
    principal: HistoryPrincipal,
    resource: HistoryResource,
    operation: HistoryOperation,
  ): Promise<boolean>;
  /** Owned source-derived history only; no hook in the licensed/default composition. */
  authorizeContext?(
    principal: HistoryPrincipal,
    resource: HistoryResource,
  ): Promise<void>;
};

const same = (a: HistoryPrincipal, b: HistoryPrincipal) =>
  a.userId === b.userId && a.tenantId === b.tenantId;

/** Construct per authenticated request; never share a mutable "current user" across requests. */
export function createBoundHistory(
  store: HistoryStore,
  authority: HistoryAuthority,
) {
  async function principal() {
    const value = await authority.principal();
    if (!value?.userId || !value.tenantId)
      throw new HistoryError("HISTORY_ACCESS_DENIED");
    return { userId: value.userId, tenantId: value.tenantId };
  }
  async function permitted(
    scope: HistoryPrincipal,
    resource: HistoryResource,
    operation: HistoryOperation,
    context = true,
  ) {
    if (
      !same(scope, await principal()) ||
      (await authority.authorize(scope, resource, operation)) !== true
    )
      throw new HistoryError("HISTORY_ACCESS_DENIED");
    if (context && operation !== "stop")
      await authority.authorizeContext?.(scope, resource);
  }
  async function access<T>(
    threadId: string,
    operation: HistoryOperation,
    work: (scope: HistoryPrincipal, thread: HistoryThread) => Promise<T>,
    agentId?: string,
    context = true,
  ) {
    const scope = await principal();
    const thread = await store.get(scope, threadId);
    if (agentId !== undefined && agentId !== thread.agentId)
      throw new HistoryError("HISTORY_NOT_FOUND");
    const resource = {
      id: thread.id,
      agentId: agentId ?? thread.agentId,
      channelId: thread.channelId,
    };
    await permitted(scope, resource, operation, context);
    const result = await work(scope, thread);
    // Withhold a result when membership changed while storage was being read.
    await permitted(scope, resource, operation, context);
    return result;
  }
  async function forLease<T>(
    lease: HistoryLease,
    operation: (scope: HistoryPrincipal) => Promise<T>,
    agentId: string,
  ) {
    return access(
      lease.threadId,
      "run",
      async (scope) => {
        if (!same(scope, lease.principal))
          throw new HistoryError("HISTORY_ACCESS_DENIED");
        return operation(scope);
      },
      agentId,
      false,
    );
  }
  return {
    async mint(input: { agentId: string; channelId?: string }) {
      const scope = await principal();
      const resource = {
        agentId: input.agentId,
        channelId: input.channelId ?? null,
      };
      await permitted(scope, resource, "mint");
      const thread = await store.mint(scope, input);
      await permitted(scope, thread, "mint");
      return thread;
    },
    async list() {
      const scope = await principal();
      const rows = await store.list(scope);
      const visible: HistoryThread[] = [];
      for (const row of rows) {
        try {
          await permitted(scope, row, "read");
          visible.push(row);
        } catch (error) {
          if (
            !(error instanceof HistoryError) ||
            error.code !== "HISTORY_ACCESS_DENIED"
          )
            throw error;
        }
      }
      if (!same(scope, await principal()))
        throw new HistoryError("HISTORY_ACCESS_DENIED");
      return visible;
    },
    get(threadId: string) {
      return access(threadId, "read", async (_scope, thread) => thread);
    },
    check(threadId: string, operation: HistoryOperation, agentId: string) {
      return access(threadId, operation, async () => undefined, agentId);
    },
    snapshot(threadId: string) {
      return access(threadId, "read", (scope) =>
        store.snapshot(scope, threadId),
      );
    },
    start(input: RunAgentInput, agentId: string) {
      return access(
        input.threadId,
        "run",
        (scope) => store.start(scope, agentId, input),
        agentId,
      );
    },
    assertLease(lease: HistoryLease, agentId: string) {
      return forLease(lease, () => store.renew(lease), agentId);
    },
    append(lease: HistoryLease, event: BaseEvent, agentId: string) {
      return forLease(lease, () => store.append(lease, event), agentId);
    },
    renew(lease: HistoryLease, agentId: string) {
      return forLease(lease, () => store.renew(lease), agentId);
    },
    stop(threadId: string, runId?: string) {
      return access(threadId, "stop", (scope) => {
        if (!runId) throw new HistoryError("HISTORY_INPUT_INVALID");
        return store.stop(scope, threadId, runId);
      });
    },
    status(threadId: string) {
      return access(threadId, "read", (scope) => store.status(scope, threadId));
    },
    page(threadId: string, after = 0, runId?: string, agentId?: string) {
      return access(
        threadId,
        "read",
        (scope) => store.page(scope, threadId, after, runId),
        agentId,
      );
    },
  };
}
export type BoundHistory = ReturnType<typeof createBoundHistory>;
