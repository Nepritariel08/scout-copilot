import { setTimeout as delay } from "node:timers/promises";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Observable, type Subscriber } from "rxjs";
import { HistoryError } from "./protocol";
import {
  type BoundHistory,
  createBoundHistory,
  type HistoryAuthority,
} from "./service";
import type { HistoryLease, HistoryStore } from "./store";

const safeError = (error: unknown) =>
  error instanceof HistoryError ? error : new Error("HISTORY_UNAVAILABLE");
async function wait(ms: number, signal: AbortSignal) {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/** One process engine; its Set holds cancellation handles, never authoritative history. */
export function createHistoryEngine(
  store: HistoryStore,
  options: { pollMs?: number; heartbeatMs?: number; maxRunMs?: number } = {},
) {
  const pollMs = options.pollMs ?? 250;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const maxRunMs = options.maxRunMs ?? 600_000;
  if (
    ![pollMs, heartbeatMs, maxRunMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    heartbeatMs >= store.limits.leaseMs ||
    pollMs > 5000 ||
    maxRunMs > 600_000
  )
    throw new HistoryError("HISTORY_INPUT_INVALID");
  const jobs = new Set<Promise<void>>();
  const interrupts = new Set<() => void>();
  let closing = false;

  async function execute(
    history: BoundHistory,
    lease: HistoryLease,
    input: RunAgentInput,
    agent: AbstractAgent,
    agentId: string,
  ) {
    let closed = false;
    let interrupted = false;
    const writes = new Set<Promise<unknown>>();
    const clock = new AbortController();
    let signalInterrupt: () => void = () => {};
    const interruption = new Promise<void>((resolve) => {
      signalInterrupt = resolve;
    });
    const interrupt = () => {
      interrupted = true;
      try {
        agent.abortRun();
      } catch {
        /* The durable lease still fences any late output. */
      }
      signalInterrupt();
    };
    interrupts.add(interrupt);
    const timeout = setTimeout(interrupt, maxRunMs);
    const heartbeat = (async () => {
      while (!clock.signal.aborted) {
        await wait(heartbeatMs, clock.signal);
        if (clock.signal.aborted) break;
        try {
          if ((await history.renew(lease, agentId)).stopRequested) {
            interrupt();
            break;
          }
        } catch {
          interrupt();
          break;
        }
      }
    })();
    try {
      if ((await history.assertLease(lease, agentId)).stopRequested) {
        interrupt();
        return;
      }
      if (closing) {
        interrupt();
        return;
      }
      agent.threadId = lease.threadId;
      agent.setMessages(input.messages);
      agent.setState(input.state);
      const run = agent
        .runAgent(input, {
          async onEvent({ event }) {
            if (closed || interrupted) return { stopPropagation: true };
            const write = history.append(lease, event, agentId);
            writes.add(write);
            try {
              if (
                (await write).stopRequested ||
                event.type === EventType.RUN_ERROR
              )
                interrupt();
            } catch {
              // The SDK logs/swallow subscriber exceptions. Abort explicitly and return a policy.
              interrupt();
              return { stopPropagation: true };
            } finally {
              writes.delete(write);
            }
          },
        })
        .then(
          () => undefined,
          () => {
            interrupted = true;
          },
        );
      await Promise.race([run, interruption]);
    } catch {
      interrupted = true;
    } finally {
      closed = true;
      clearTimeout(timeout);
      clock.abort();
      await heartbeat;
      await Promise.allSettled(writes);
      // Private lease authority can close a revoked user's run without releasing its data.
      try {
        await store.finish(lease, interrupted ? "interrupted" : "completed");
      } catch {
        /* Expiry recovery owns a lost lease; never replay the agent. */
      }
      interrupts.delete(interrupt);
    }
  }

  async function follow(
    history: BoundHistory,
    threadId: string,
    subscriber: Subscriber<BaseEvent>,
    signal: AbortSignal,
    runId?: string,
    agentId?: string,
  ) {
    let cursor = 0;
    while (!signal.aborted) {
      const page = await history.page(threadId, cursor, runId, agentId);
      if (signal.aborted) break;
      for (const row of page.events) {
        subscriber.next(row.event);
        cursor = row.sequence;
      }
      if (page.events.length === 128) continue;
      if (!page.running) {
        subscriber.complete();
        return;
      }
      await wait(pollMs, signal);
    }
  }

  return {
    bind(authority: HistoryAuthority) {
      const history = createBoundHistory(store, authority);
      class BoundRunner extends AgentRunner {
        run(request: AgentRunnerRunRequest) {
          return new Observable<BaseEvent>((subscriber) => {
            const controller = new AbortController();
            (async () => {
              if (closing) throw new Error("HISTORY_UNAVAILABLE");
              if (request.threadId !== request.input.threadId)
                throw new HistoryError("HISTORY_INPUT_INVALID");
              const agentId = request.agent.agentId;
              if (!agentId) throw new HistoryError("HISTORY_INPUT_INVALID");
              const started = await history.start(request.input, agentId);
              if (started.execute) {
                const job = execute(
                  history,
                  started.lease,
                  started.input,
                  request.agent,
                  agentId,
                ).finally(() => jobs.delete(job));
                jobs.add(job);
              }
              await follow(
                history,
                request.threadId,
                subscriber,
                controller.signal,
                request.input.runId,
                agentId,
              );
            })().catch((error) => {
              if (!subscriber.closed) subscriber.error(safeError(error));
            });
            return () => controller.abort();
          });
        }
        connect(request: AgentRunnerConnectRequest) {
          return new Observable<BaseEvent>((subscriber) => {
            const controller = new AbortController();
            (async () => {
              if (request.joinCode !== undefined)
                throw new HistoryError("HISTORY_ACCESS_DENIED");
              await follow(
                history,
                request.threadId,
                subscriber,
                controller.signal,
                undefined,
                request.agentId,
              );
            })().catch((error) => {
              if (!subscriber.closed) subscriber.error(safeError(error));
            });
            return () => controller.abort();
          });
        }
        async isRunning(request: AgentRunnerIsRunningRequest) {
          return (await history.status(request.threadId)).running;
        }
        stop(request: AgentRunnerStopRequest) {
          return history.stop(request.threadId, request.runId);
        }
      }
      return { runner: new BoundRunner(), history };
    },
    async close() {
      closing = true;
      for (const interrupt of interrupts) interrupt();
      await Promise.allSettled(jobs);
    },
  };
}
