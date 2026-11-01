import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { lastValueFrom, Observable, toArray } from "rxjs";
import { type AppVariables, createRequireUser } from "../src/auth/guards";
import { createSameOriginGuard } from "../src/auth/same-origin";
import { createDatabase } from "../src/db/client";
import {
  scoutHistoryRuns,
  scoutHistoryThreads,
} from "../src/db/schema/scout-history";
import { createHistoryRuntimeHandler } from "../src/scout/history/endpoint";
import {
  type HistoryPrincipal,
  historyDigest,
  historyEvent,
  historyInput,
  historyJson,
  mergeHistory,
} from "../src/scout/history/protocol";
import { createHistoryRoutes } from "../src/scout/history/routes";
import { createHistoryEngine } from "../src/scout/history/runner";
import {
  createBoundHistory,
  type HistoryAuthority,
} from "../src/scout/history/service";
import { createHistoryStore } from "../src/scout/history/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const url = testDatabaseUrl();
const database = createDatabase(url, TEST_POOL);
const prefix = `history-${randomUUID()}`;
const alice = { userId: `${prefix}-alice`, tenantId: "tenant-a" };
const bob = { userId: `${prefix}-bob`, tenantId: "tenant-a" };
const customer = { userId: alice.userId, tenantId: "tenant-b" };
const store = createHistoryStore(database);
let active = true;
let channelAccess = true;
const authority = (who: HistoryPrincipal = alice): HistoryAuthority => ({
  principal: async () => (active ? { ...who } : null),
  authorize: async (_scope, resource) =>
    channelAccess &&
    resource.agentId === "fixture" &&
    resource.channelId === "owned-channel",
});
const input = (
  threadId: string,
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput => ({
  threadId,
  runId: randomUUID(),
  state: {},
  context: [],
  tools: [],
  forwardedProps: {},
  protocolVersion: "1.0",
  messages: [{ id: randomUUID(), role: "user", content: "Synthetic request" }],
  ...overrides,
});
const mint = (who = alice, target = store) =>
  target.mint(who, { agentId: "fixture", channelId: "owned-channel" });
function executing(result: Awaited<ReturnType<typeof store.start>>) {
  if (!result.execute) throw new Error("Expected a new fixture execution");
  return result;
}
async function expired(threadId: string) {
  await database
    .update(scoutHistoryRuns)
    .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(scoutHistoryRuns.threadId, threadId));
}
async function text(
  lease: Parameters<typeof store.append>[0],
  messageId = randomUUID(),
  content = "Private fixture answer",
) {
  await store.append(lease, {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  });
  await store.append(lease, {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: content,
  });
  await store.append(lease, { type: EventType.TEXT_MESSAGE_END, messageId });
}
const collect = (value: Observable<BaseEvent>) =>
  lastValueFrom(value.pipe(toArray()));
let engines: ReturnType<typeof createHistoryEngine>[] = [];
function engine() {
  const value = createHistoryEngine(store, {
    heartbeatMs: 100,
    pollMs: 10,
    maxRunMs: 2000,
  });
  engines.push(value);
  return value;
}
function application() {
  const owner = engine();
  // Native authentication and origin middleware are real; only the session issuer is synthetic.
  const requireUser = createRequireUser(
    {
      handler: () => new Response(null),
      api: {
        getSession: async ({ headers }) => {
          const userId = headers.get("x-synthetic-session");
          return [alice.userId, bob.userId].includes(userId ?? "")
            ? {
                user: {
                  id: userId!,
                  email: "same-email@fixture.example",
                  role: "user" as const,
                },
              }
            : null;
        },
      },
    },
    { rolesForUser: async () => ["user"] },
  );
  const forActor = (userId: string) =>
    owner.bind(
      authority({
        userId,
        tenantId: userId === alice.userId ? alice.tenantId : customer.tenantId,
      }),
    );
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createSameOriginGuard({ publicUrl: "http://localhost" }));
  app.route(
    "/api/scout/threads",
    createHistoryRoutes((actor) => forActor(actor.id).history, requireUser),
  );
  app.use("/api/copilotkit/*", requireUser);
  app.all("/api/copilotkit/*", (context) => {
    const bound = forActor(context.var.actor.id);
    return createHistoryRuntimeHandler(
      new CopilotRuntime({
        agents: { fixture: new FixtureAgent() },
        runner: bound.runner,
      }),
      bound.history,
      "/api/copilotkit",
    )(context.req.raw);
  });
  const request = (
    path: string,
    body?: unknown,
    userId = alice.userId,
    extra: Record<string, string> = {},
  ) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-synthetic-session": userId,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, request };
}
let calls = 0;
class FixtureAgent extends AbstractAgent {
  constructor(readonly delay = 0) {
    super({ agentId: "fixture" });
  }
  run(value: RunAgentInput) {
    calls++;
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: value.threadId,
        runId: value.runId,
      });
      const timer = setTimeout(() => {
        const messageId = randomUUID();
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: "SDK fixture answer",
        });
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId });
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: value.threadId,
          runId: value.runId,
          outcome: { type: "success" },
        });
        subscriber.complete();
      }, this.delay);
      return () => clearTimeout(timer);
    });
  }
}

beforeAll(async () => {
  await database.execute(
    sql`create table if not exists users (id text primary key, email text not null unique)`,
  );
  for (const userId of [alice.userId, bob.userId])
    await database.execute(
      sql`insert into users(id,email) values (${userId}, ${`${userId}@fixture.example`}) on conflict (id) do nothing`,
    );
  const [exists] = await database.execute<{ relation: string | null }>(
    sql`select to_regclass('scout_history_threads') as relation`,
  );
  if (!exists.relation) {
    const migration = await readFile(
      new URL("../drizzle/0069_scout_history.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.execute(sql.raw(statement));
  }
  const [contextTable] = await database.execute<{ relation: string | null }>(
    sql`select to_regclass('scout_history_context') as relation`,
  );
  if (!contextTable.relation) {
    const migration = await readFile(
      new URL("../drizzle/0074_scout_history_context.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.execute(sql.raw(statement));
  }
});
beforeEach(async () => {
  await Promise.all(engines.map((value) => value.close()));
  engines = [];
  await database
    .delete(scoutHistoryThreads)
    .where(
      inArray(scoutHistoryThreads.ownerUserId, [alice.userId, bob.userId]),
    );
  active = true;
  channelAccess = true;
  calls = 0;
});
afterAll(async () => {
  await Promise.all(engines.map((value) => value.close()));
  await database.execute(
    sql`delete from users where id in (${alice.userId}, ${bob.userId})`,
  );
  await database.$client.close();
});

describe("PostgreSQL-owned conversation history", () => {
  test("mint persists explicit owner/tenant, not a first-writer claim on a supplied id", async () => {
    const thread = await mint();
    expect(thread.ownerUserId).toBe(alice.userId);
    expect(thread.tenantId).toBe(alice.tenantId);
    expect(thread.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(await store.list(bob)).toEqual([]);
    expect(await store.list(customer)).toEqual([]);
    expect("snapshot" in thread).toBe(false);
  });
  test("every operation refuses another native user, even in the same tenant", async () => {
    const thread = await mint();
    for (const operation of [
      () => store.get(bob, thread.id),
      () => store.snapshot(bob, thread.id),
      () => store.page(bob, thread.id),
      () => store.stop(bob, thread.id),
      () => store.start(bob, "fixture", input(thread.id)),
    ])
      await expect(operation()).rejects.toThrow("HISTORY_NOT_FOUND");
  });
  test("a valid user in a different tenant cannot read or run the original thread", async () => {
    const thread = await mint();
    await expect(store.snapshot(customer, thread.id)).rejects.toThrow(
      "HISTORY_NOT_FOUND",
    );
    await expect(
      store.start(customer, "fixture", input(thread.id)),
    ).rejects.toThrow("HISTORY_NOT_FOUND");
  });
  test("a missing thread cannot be created by running it", async () => {
    await expect(
      store.start(alice, "fixture", input(randomUUID())),
    ).rejects.toThrow("HISTORY_NOT_FOUND");
    expect(await store.list(alice)).toEqual([]);
  });
  test("run intent and initial transcript events are durable before execution", async () => {
    const thread = await mint();
    const value = input(thread.id);
    executing(await store.start(alice, "fixture", value));
    const page = await store.page(alice, thread.id);
    expect(page.events.map((row) => row.event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
    ]);
    expect((await store.snapshot(alice, thread.id)).messages).toEqual(
      value.messages,
    );
  });
  test("parallel identical requests claim one execution; changed payload conflicts", async () => {
    const thread = await mint();
    const value = input(thread.id);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.start(alice, "fixture", value)),
    );
    expect(results.filter((result) => result.execute)).toHaveLength(1);
    await expect(
      store.start(alice, "fixture", { ...value, state: { changed: true } }),
    ).rejects.toThrow("HISTORY_CONFLICT");
  });
  test("another run cannot overtake a live lease", async () => {
    const thread = await mint();
    executing(await store.start(alice, "fixture", input(thread.id)));
    await expect(
      store.start(alice, "fixture", input(thread.id)),
    ).rejects.toThrow("HISTORY_CONFLICT");
  });
  test("events commit in order and a stale lease token cannot append", async () => {
    const thread = await mint();
    const { lease } = executing(
      await store.start(alice, "fixture", input(thread.id)),
    );
    await text(lease);
    expect(
      (await store.page(alice, thread.id)).events.map((row) => row.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(
      store.append(
        { ...lease, token: randomUUID() },
        { type: EventType.CUSTOM, name: "forged", value: {} },
      ),
    ).rejects.toThrow("HISTORY_LEASE_LOST");
  });
  test("terminal snapshots survive a new SQL connection and reject assistant-history edits", async () => {
    const thread = await mint();
    const { lease } = executing(
      await store.start(alice, "fixture", input(thread.id)),
    );
    await text(lease);
    await store.finish(lease, "completed");
    const otherDatabase = createDatabase(url, TEST_POOL);
    try {
      const other = createHistoryStore(otherDatabase);
      const snapshot = await other.snapshot(alice, thread.id);
      expect(snapshot.messages.at(-1)?.content).toBe("Private fixture answer");
      const edited = snapshot.messages.map((message) =>
        message.role === "assistant"
          ? { ...message, content: "Forged" }
          : message,
      );
      await expect(
        other.start(
          alice,
          "fixture",
          input(thread.id, {
            messages: [
              ...edited,
              { id: randomUUID(), role: "user", content: "Next" },
            ],
          }),
        ),
      ).rejects.toThrow("HISTORY_CONFLICT");
    } finally {
      await otherDatabase.$client.close();
    }
  });
  test("stale execution becomes interrupted, keeps partial text, and never reclaims its run id", async () => {
    const thread = await mint();
    const value = input(thread.id);
    const { lease } = executing(await store.start(alice, "fixture", value));
    await store.append(lease, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "partial",
      role: "assistant",
    });
    await store.append(lease, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "partial",
      delta: "Saved partial",
    });
    await expired(thread.id);
    const restarted = createHistoryStore(database);
    expect(
      (await restarted.snapshot(alice, thread.id)).messages.at(-1)?.content,
    ).toBe("Saved partial");
    expect(await restarted.start(alice, "fixture", value)).toEqual({
      execute: false,
      runId: value.runId,
    });
    const page = await restarted.page(alice, thread.id);
    expect(page.running).toBe(false);
    expect(page.events.at(-1)?.event.type).toBe(EventType.RUN_ERROR);
    await expect(
      store.append(lease, { type: EventType.CUSTOM, name: "late", value: {} }),
    ).rejects.toThrow("HISTORY_LEASE_LOST");
  });
  test("a committed success before a crash is recovered as completed", async () => {
    const thread = await mint();
    const value = input(thread.id);
    const { lease } = executing(await store.start(alice, "fixture", value));
    await text(lease);
    await store.append(lease, {
      type: EventType.RUN_FINISHED,
      threadId: thread.id,
      runId: value.runId,
      outcome: { type: "success" },
    });
    await expired(thread.id);
    await store.get(alice, thread.id);
    const [run] = await database
      .select()
      .from(scoutHistoryRuns)
      .where(eq(scoutHistoryRuns.threadId, thread.id));
    expect(run.status).toBe("completed");
  });
  test("exact-run cancellation survives restart and cannot cancel a later run", async () => {
    const thread = await mint();
    const first = input(thread.id);
    const { lease } = executing(await store.start(alice, "fixture", first));
    expect(await store.stop(alice, thread.id, "wrong-run")).toBe(false);
    expect(await store.stop(alice, thread.id, first.runId)).toBe(true);
    expect(
      await store.append(lease, {
        type: EventType.CUSTOM,
        name: "late",
        value: {},
      }),
    ).toEqual({ stopRequested: true });
    await expired(thread.id);
    await store.get(alice, thread.id);
    const second = input(thread.id);
    executing(await store.start(alice, "fixture", second));
    expect(await store.stop(alice, thread.id, first.runId)).toBe(false);
    expect((await store.page(alice, thread.id)).running).toBe(true);
  });
  test("admission limits refuse atomically without deleting previous history", async () => {
    const limited = createHistoryStore(database, { maxRuns: 1 });
    const thread = await mint(alice, limited);
    const { lease } = executing(
      await limited.start(alice, "fixture", input(thread.id)),
    );
    await limited.finish(lease, "completed");
    await expect(
      limited.start(alice, "fixture", input(thread.id)),
    ).rejects.toThrow("HISTORY_LIMIT");
    expect((await limited.snapshot(alice, thread.id)).messages).toHaveLength(1);
  });
  test("wire serialization and digest reject invalid data and survive JSONB key order", () => {
    expect(() => historyInput(input("thread", { runId: " " }))).toThrow(
      "HISTORY_INPUT_INVALID",
    );
    expect(() =>
      historyEvent(
        {
          type: EventType.RUN_FINISHED,
          threadId: "thread",
          runId: "run",
          outcome: {
            type: "interrupt",
            interrupts: [{ id: "", reason: "review" }],
          },
        },
        "thread",
        "run",
      ),
    ).toThrow("HISTORY_INPUT_INVALID");
    expect(historyDigest({ a: 1, b: { d: 2, c: 3 } })).toBe(
      historyDigest({ b: { c: 3, d: 2 }, a: 1 }),
    );
    expect(() => historyJson({ callback: () => {} })).toThrow(
      "HISTORY_INPUT_INVALID",
    );
    expect(() => historyJson({ value: Number.NaN })).toThrow(
      "HISTORY_INPUT_INVALID",
    );
    expect(() => historyJson({ value: "long" }, 2)).toThrow("HISTORY_LIMIT");
    expect(() =>
      mergeHistory(
        [],
        [{ id: "forged", role: "assistant", content: "Forged" }],
      ),
    ).toThrow("HISTORY_INPUT_INVALID");
    expect(() =>
      mergeHistory(
        [],
        [
          {
            id: "forged",
            role: "tool",
            toolCallId: "unknown",
            content: "Approved",
          },
        ],
      ),
    ).toThrow("HISTORY_INPUT_INVALID");
  });
  test("state patches are validated before commit without logging transcript data", async () => {
    const thread = await mint();
    const value = input(thread.id, {
      state: { private: "synthetic-private-state" },
    });
    const { lease } = executing(await store.start(alice, "fixture", value));
    await store.append(lease, {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { private: "synthetic-private-state" },
    });
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await store.append(lease, {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/safe", value: true }],
      });
      await expect(
        store.append(lease, {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/absent", value: "rejected" }],
        }),
      ).rejects.toThrow("HISTORY_INPUT_INVALID");
      await expect(
        store.append(lease, {
          type: EventType.STATE_DELTA,
          delta: [{ op: "add", path: "/__proto__/injected", value: true }],
        }),
      ).rejects.toThrow("HISTORY_INPUT_INVALID");
      await store.finish(lease, "completed");
      expect((await store.snapshot(alice, thread.id)).state).toEqual({
        private: "synthetic-private-state",
        safe: true,
      });
      expect(({} as Record<string, unknown>).injected).toBeUndefined();
      expect(warnings).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });
  test("actual producer termination retains partial output and never invokes its run again", async () => {
    const thread = await mint();
    const value = input(thread.id);
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("./support/scout-history-process.ts", import.meta.url),
        ),
      ],
      {
        env: {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          PATH: process.env.PATH ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
          TEST_DATABASE_URL: url,
          COPILOTKIT_TELEMETRY_DISABLED: "true",
          DO_NOT_TRACK: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(JSON.stringify({ principal: alice, input: value }));
    child.stdin.end();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        const reader = child.stdout.getReader();
        let text = "";
        try {
          while (!text.includes("ready\n")) {
            const chunk = await reader.read();
            if (chunk.done)
              throw new Error(
                "Synthetic producer exited before its commit marker",
              );
            text += new TextDecoder().decode(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("Synthetic producer readiness timed out")),
            7000,
          );
        }),
      ]);
      clearTimeout(watchdog);
      child.kill("SIGKILL");
      await child.exited;
      let page = await store.page(alice, thread.id);
      const deadline = Date.now() + 3000;
      while (page.running && Date.now() < deadline) {
        await Bun.sleep(25);
        page = await store.page(alice, thread.id);
      }
      expect(page.running).toBe(false);
      expect(page.events.at(-1)?.event.type).toBe(EventType.RUN_ERROR);
      expect(
        page.events.filter(
          ({ event }) =>
            event.type === EventType.CUSTOM &&
            event.name === "fixture-model-dispatched",
        ),
      ).toHaveLength(1);
      expect(
        (await store.snapshot(alice, thread.id)).messages.at(-1)?.content,
      ).toBe("Committed before process termination");
      const restarted = engine().bind(authority());
      const replay = await collect(
        restarted.runner.run({
          threadId: thread.id,
          input: value,
          agent: new FixtureAgent(),
        }),
      );
      expect(replay.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(calls).toBe(0);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15000);
});

describe("fresh server authority and public CopilotKit runner", () => {
  test("revoked membership and channel access withhold existing history", async () => {
    const history = createBoundHistory(store, authority());
    const thread = await history.mint({
      agentId: "fixture",
      channelId: "owned-channel",
    });
    active = false;
    await expect(history.snapshot(thread.id)).rejects.toThrow(
      "HISTORY_ACCESS_DENIED",
    );
    active = true;
    channelAccess = false;
    expect(await history.list()).toEqual([]);
    await expect(history.snapshot(thread.id)).rejects.toThrow(
      "HISTORY_ACCESS_DENIED",
    );
  });
  test("a native principal changing during a read cannot inherit the previous owner's data", async () => {
    const thread = await mint();
    let lookups = 0;
    const history = createBoundHistory(store, {
      principal: async () => (++lookups > 2 ? bob : alice),
      authorize: async () => true,
    });
    await expect(history.snapshot(thread.id)).rejects.toThrow(
      "HISTORY_ACCESS_DENIED",
    );
  });
  test("real SDK execution, persisted replay and identical retry invoke the agent once", async () => {
    const thread = await mint();
    const bound = engine().bind(authority());
    const value = input(thread.id);
    const runtime = new CopilotRuntime({
      agents: { fixture: new FixtureAgent() },
      runner: bound.runner,
    });
    expect(runtime.mode).toBe("sse");
    const first = await collect(
      runtime.runner.run({
        threadId: thread.id,
        input: value,
        agent: new FixtureAgent(),
      }),
    );
    expect(first.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    const replay = await collect(
      bound.runner.run({
        threadId: thread.id,
        input: value,
        agent: new FixtureAgent(),
      }),
    );
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(
      (await bound.history.snapshot(thread.id)).messages.at(-1)?.content,
    ).toBe("SDK fixture answer");
  });
  test("disconnecting a subscriber leaves execution durable for another request's connect", async () => {
    const thread = await mint();
    const owner = engine();
    const bound = owner.bind(authority());
    const value = input(thread.id);
    await new Promise<void>((resolve, reject) => {
      const sub = bound.runner
        .run({
          threadId: thread.id,
          input: value,
          agent: new FixtureAgent(100),
        })
        .subscribe({
          next() {
            sub.unsubscribe();
            resolve();
          },
          error: reject,
        });
    });
    const reconnected = engine().bind(authority());
    const replay = await collect(
      reconnected.runner.connect({ threadId: thread.id, agentId: "fixture" }),
    );
    expect(replay.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(calls).toBe(1);
  });
  test("another user cannot connect, inspect activity or stop even with guessed thread and headers", async () => {
    const thread = await mint();
    const other = engine().bind(authority(bob));
    await expect(
      collect(
        other.runner.connect({
          threadId: thread.id,
          headers: { "x-tenant-id": alice.tenantId, "x-user-id": alice.userId },
        }),
      ),
    ).rejects.toThrow("HISTORY_NOT_FOUND");
    await expect(
      other.runner.isRunning({ threadId: thread.id }),
    ).rejects.toThrow("HISTORY_NOT_FOUND");
    await expect(other.runner.stop({ threadId: thread.id })).rejects.toThrow(
      "HISTORY_NOT_FOUND",
    );
    expect(calls).toBe(0);
  });
  test("durable stop from a second engine interrupts the producer and fences late output", async () => {
    const thread = await mint();
    const producer = engine();
    const bound = producer.bind(authority());
    const value = input(thread.id);
    const stream = collect(
      bound.runner.run({
        threadId: thread.id,
        input: value,
        agent: new FixtureAgent(1000),
      }),
    );
    void stream.catch(() => {});
    try {
      const deadline = Date.now() + 1500;
      while (!calls && Date.now() < deadline) await Bun.sleep(5);
      expect(calls).toBe(1);
      expect(await bound.runner.isRunning({ threadId: thread.id })).toBe(true);
      const other = engine().bind(authority());
      expect(
        await other.runner.stop({ threadId: thread.id, runId: value.runId }),
      ).toBe(true);
      const result = await stream;
      expect(
        result.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
      ).toBe(false);
      expect(result.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(calls).toBe(1);
    } finally {
      await producer.close();
      await stream.catch(() => {});
    }
  });
  test("persisted state and thread agent cannot be replaced by browser input", async () => {
    const thread = await mint();
    const first = executing(
      await store.start(alice, "fixture", input(thread.id)),
    );
    await store.append(first.lease, {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { serverValue: "retained" },
    });
    await store.finish(first.lease, "completed");
    const next = executing(
      await store.start(
        alice,
        "fixture",
        input(thread.id, { state: { serverValue: "forged" } }),
      ),
    );
    expect(next.input.state).toEqual({ serverValue: "retained" });
    const bound = engine().bind({
      principal: async () => alice,
      authorize: async () => true,
    });
    await expect(
      collect(
        bound.runner.connect({
          threadId: thread.id,
          agentId: "different-agent",
        }),
      ),
    ).rejects.toThrow("HISTORY_NOT_FOUND");
    await expect(
      store.start(alice, "different-agent", input(thread.id)),
    ).rejects.toThrow("HISTORY_NOT_FOUND");
    await expect(bound.runner.stop({ threadId: thread.id })).rejects.toThrow(
      "HISTORY_INPUT_INVALID",
    );
    expect((await store.status(alice, thread.id)).running).toBe(true);
  });
  test("pending interrupts require their exact owned resume and retain canonical history", async () => {
    const thread = await mint();
    const first = executing(
      await store.start(alice, "fixture", input(thread.id)),
    );
    await text(first.lease);
    await store.append(first.lease, {
      type: EventType.RUN_FINISHED,
      threadId: thread.id,
      runId: first.lease.runId,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "review-1", reason: "human-review" }],
      },
    });
    await store.finish(first.lease, "completed");
    await expect(
      store.start(alice, "fixture", input(thread.id)),
    ).rejects.toThrow("HISTORY_CONFLICT");
    for (const resume of [
      [{ interruptId: "foreign", status: "resolved" as const }],
      [
        { interruptId: "review-1", status: "resolved" as const },
        { interruptId: "review-1", status: "resolved" as const },
      ],
    ])
      await expect(
        store.start(
          alice,
          "fixture",
          input(thread.id, { messages: [], resume }),
        ),
      ).rejects.toThrow("HISTORY_CONFLICT");
    let observed: RunAgentInput | undefined;
    class ResumeAgent extends FixtureAgent {
      run(value: RunAgentInput) {
        observed = value;
        return super.run(value);
      }
    }
    const resume = [
      {
        interruptId: "review-1",
        status: "resolved" as const,
        payload: { answer: "synthetic" },
      },
    ];
    await collect(
      engine()
        .bind(authority())
        .runner.run({
          threadId: thread.id,
          input: input(thread.id, { messages: [], resume }),
          agent: new ResumeAgent(),
        }),
    );
    expect(observed?.resume).toEqual(resume);
    expect(observed?.messages.at(-1)?.content).toBe("Private fixture answer");
    expect(calls).toBe(1);
    await expect(
      store.start(alice, "fixture", input(thread.id, { messages: [], resume })),
    ).rejects.toThrow("HISTORY_INPUT_INVALID");
  });
  test("expired interrupts can be cancelled but cannot be approved or duplicated", async () => {
    const thread = await mint();
    const first = executing(
      await store.start(alice, "fixture", input(thread.id)),
    );
    const interrupt = {
      id: "expired",
      reason: "review",
      expiresAt: "2020-01-01T00:00:00Z",
    };
    await expect(
      store.append(first.lease, {
        type: EventType.RUN_FINISHED,
        threadId: thread.id,
        runId: first.lease.runId,
        outcome: { type: "interrupt", interrupts: [interrupt, interrupt] },
      }),
    ).rejects.toThrow("HISTORY_INPUT_INVALID");
    await store.append(first.lease, {
      type: EventType.RUN_FINISHED,
      threadId: thread.id,
      runId: first.lease.runId,
      outcome: { type: "interrupt", interrupts: [interrupt] },
    });
    await store.finish(first.lease, "completed");
    await expect(
      store.start(
        alice,
        "fixture",
        input(thread.id, {
          messages: [],
          resume: [{ interruptId: "expired", status: "resolved" }],
        }),
      ),
    ).rejects.toThrow("HISTORY_CONFLICT");
    const resumed = executing(
      await store.start(
        alice,
        "fixture",
        input(thread.id, {
          messages: [],
          resume: [{ interruptId: "expired", status: "cancelled" }],
        }),
      ),
    );
    expect(resumed.input.resume?.[0].status).toBe("cancelled");
  });
  test("native HTTP auth and same-origin policy guard history and actual SDK dispatch", async () => {
    const { request } = application();
    const body = { agentId: "fixture", channelId: "owned-channel" };
    for (const path of ["/api/scout/threads", "/api/copilotkit/info"])
      expect((await request(path, undefined, "no-session")).status).toBe(401);
    expect(
      (
        await request("/api/scout/threads", body, alice.userId, {
          Origin: "https://foreign.example",
        })
      ).status,
    ).toBe(403);
    for (const extra of [
      { userId: bob.userId },
      { tenantId: "foreign" },
      { ownerUserId: alice.userId },
    ])
      expect(
        (await request("/api/scout/threads", { ...body, ...extra })).status,
      ).toBe(400);
    const minted = await request("/api/scout/threads", body);
    expect(minted.status).toBe(201);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    const { thread } = await minted.json();
    const value = input(thread.id);
    const result = await request("/api/copilotkit/agent/fixture/run", value);
    expect(result.status).toBe(200);
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.text()).toContain("SDK fixture answer");
    expect(calls).toBe(1);
    const snapshot = await request(`/api/scout/threads/${thread.id}/messages`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).messages.at(-1)?.content).toBe(
      "SDK fixture answer",
    );
  });
  test("HTTP foreign identities cannot run, connect, read or stop by forging owner context", async () => {
    const { request } = application();
    const thread = await mint();
    const value = input(thread.id);
    await collect(
      engine().bind(authority()).runner.run({
        threadId: thread.id,
        input: value,
        agent: new FixtureAgent(),
      }),
    );
    const forged = {
      "x-user-id": alice.userId,
      "x-tenant-id": alice.tenantId,
      authorization: "Bearer fixture-not-authority",
    };
    for (const path of ["messages", "events"])
      expect(
        (
          await request(
            `/api/scout/threads/${thread.id}/${path}`,
            undefined,
            bob.userId,
            forged,
          )
        ).status,
      ).toBe(404);
    expect(
      (
        await request(
          `/api/scout/threads/${thread.id}/stop`,
          { runId: value.runId },
          bob.userId,
          forged,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await (
          await request("/api/scout/threads", undefined, bob.userId)
        ).json()
      ).threads,
    ).toEqual([]);
    for (const [path, body] of [
      [
        "run",
        {
          ...input(thread.id),
          forwardedProps: { userId: alice.userId, tenantId: alice.tenantId },
        },
      ],
      ["connect", { threadId: thread.id }],
      [`stop/${thread.id}`, { runId: value.runId }],
    ] as const) {
      const result = await request(
        `/api/copilotkit/agent/fixture/${path}`,
        body,
        bob.userId,
        forged,
      );
      const output = await result.text();
      expect(output).not.toContain("SDK fixture answer");
      expect(
        result.status !== 200 || output.includes("HISTORY_NOT_FOUND"),
      ).toBe(true);
    }
    expect(calls).toBe(1);
  });
  test("unadapted SDK auxiliary routes cannot expose history or invoke another model path", async () => {
    const { request } = application();
    for (const [path, body] of [
      ["/agent/fixture/suggest", {}],
      ["/threads", undefined],
      ["/threads/clear", {}],
      ["/inspector/metadata", undefined],
      ["/transcribe", {}],
    ] as const) {
      const result = await request(`/api/copilotkit${path}`, body);
      expect(result.status).toBe(404);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls).toBe(0);
  });
  test("a stop committed before dispatch prevents any agent invocation", async () => {
    const thread = await mint();
    const value = input(thread.id);
    let checks = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bound = engine().bind({
      ...authority(),
      authorize: async (_scope, _resource, operation) => {
        if (operation === "run" && ++checks === 3) await gate;
        return true;
      },
    });
    const result = collect(
      bound.runner.run({
        threadId: thread.id,
        input: value,
        agent: new FixtureAgent(),
      }),
    );
    void result.catch(() => {});
    try {
      const deadline = Date.now() + 1500;
      while (checks < 3 && Date.now() < deadline) await Bun.sleep(5);
      expect(checks).toBe(3);
      expect(await store.stop(alice, thread.id, value.runId)).toBe(true);
    } finally {
      release();
    }
    expect((await result).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(calls).toBe(0);
  });
  test("membership revocation during a run aborts production and withholds its stream", async () => {
    const thread = await mint();
    const bound = engine().bind(authority());
    const result = collect(
      bound.runner.run({
        threadId: thread.id,
        input: input(thread.id),
        agent: new FixtureAgent(1000),
      }),
    );
    const outcome = result.then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 1500;
    while (!calls && Date.now() < deadline) await Bun.sleep(5);
    expect(calls).toBe(1);
    active = false;
    const failure = await Promise.race([
      outcome,
      Bun.sleep(1500).then(() => new Error("Revoked stream did not close")),
    ]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("HISTORY_ACCESS_DENIED");
    await Promise.all(engines.map((owner) => owner.close()));
    const page = await store.page(alice, thread.id);
    expect(page.running).toBe(false);
    expect(
      page.events.some(
        ({ event }) => event.type === EventType.TEXT_MESSAGE_CONTENT,
      ),
    ).toBe(false);
  });
  test("a persistence failure aborts the SDK producer even when subscriber exceptions are swallowed", async () => {
    const thread = await mint();
    let rejected = false;
    const failing = createHistoryEngine(
      {
        ...store,
        append: async (lease, event) => {
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
            rejected = true;
            throw new Error("synthetic-private-storage-fault");
          }
          return store.append(lease, event);
        },
      },
      { heartbeatMs: 100, pollMs: 10, maxRunMs: 2000 },
    );
    engines.push(failing);
    const result = await collect(
      failing.bind(authority()).runner.run({
        threadId: thread.id,
        input: input(thread.id),
        agent: new FixtureAgent(),
      }),
    );
    expect(rejected).toBe(true);
    expect(
      result.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toBe(false);
    expect(result.at(-1)?.type).toBe(EventType.RUN_ERROR);
    expect(JSON.stringify(result)).not.toContain(
      "synthetic-private-storage-fault",
    );
    expect((await store.status(alice, thread.id)).running).toBe(false);
  });
});
