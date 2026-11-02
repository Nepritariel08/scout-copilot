import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import {
  scoutHistoryRuns as historyRuns,
  scoutHistoryThreads as threads,
} from "../src/db/schema/scout-history";
import { scoutModelCalls as calls } from "../src/db/schema/scout-model";
import { createHistoryStore } from "../src/scout/history/store";
import { OwnedTextModel } from "../src/scout/owned-model/model";
import {
  type ModelGrant,
  parseModelPolicy,
} from "../src/scout/owned-model/policy";
import {
  createModelCallStore,
  type ModelCallStore,
  type ModelRun,
} from "../src/scout/owned-model/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const history = createHistoryStore(database);
const store = createModelCallStore(database);
const prefix = `model-edge-${randomUUID()}`;
const userId = `${prefix}-user`;
const agentId = `${prefix}-agent`;
const principal = {
  userId,
  tenantId: "edge-tenant",
  deploymentId: prefix,
  agentId,
};
const syntheticKey = "synthetic-edge-key-never-real";
let directory = "",
  keyFile = "";
let providerCalls = 0;
type Options = Parameters<OwnedTextModel["doGenerate"]>[0];
const options = (): Options => ({
  prompt: [
    {
      role: "user",
      content: [{ type: "text", text: "Synthetic edge request" }],
    },
  ],
});

function grantFor(provider: "local" | "openrouter" = "local") {
  return parseModelPolicy(
    {
      version: 1,
      deploymentId: prefix,
      globalMaxConcurrent: 4,
      globalMaxCallsPerDay: 100,
      bindings: [
        {
          userId,
          tenantId: principal.tenantId,
          revision: 1,
          active: true,
          expiresAt: "2099-01-01T00:00:00Z",
          agentIds: [agentId],
          allowConversationContext: true,
          allowPersonalInstructions: false,
          route:
            provider === "openrouter"
              ? {
                  provider,
                  model: "openrouter/free",
                  apiKeyFile: keyFile,
                }
              : {
                  provider,
                  model: "fixture-edge",
                  baseUrl: "http://127.0.0.1:25435/v1",
                  apiKeyFile: keyFile,
                },
          limits: {
            maxInputBytes: 65536,
            maxOutputTokens: 16,
            maxOutputBytes: 4096,
            maxCallsPerRun: 1,
            maxCallsPerDay: 100,
            maxConcurrent: 4,
            timeoutMs: 1000,
          },
        },
      ],
    },
    principal,
  );
}

async function run(): Promise<ModelRun> {
  const thread = await history.mint(principal, { agentId });
  const runId = randomUUID();
  await history.start(principal, agentId, {
    threadId: thread.id,
    runId,
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    messages: [
      { id: randomUUID(), role: "user", content: "Synthetic edge request" },
    ],
  });
  return { ...principal, threadId: thread.id, runId };
}

async function receipts() {
  return database.select().from(calls).where(eq(calls.deploymentId, prefix));
}

async function terminalReceipt() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [receipt] = await receipts();
    if (receipt && !["reserved", "dispatched"].includes(receipt.status))
      return receipt;
    await Bun.sleep(10);
  }
  throw new Error("Synthetic model receipt did not settle");
}

function transport(
  body: string | ((init: RequestInit) => Response | Promise<Response>),
): typeof fetch {
  return Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      providerCalls++;
      expect((await receipts())[0]?.status).toBe("dispatched");
      if (typeof body === "function") return body(init ?? {});
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: fetch.preconnect },
  );
}

function packet(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

const success = () =>
  packet({
    id: "edge",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "EDGE_OK" },
        finish_reason: null,
      },
    ],
  }) +
  packet({
    id: "edge",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }) +
  "data: [DONE]\n\n";

function model(
  scope: ModelRun,
  grant: ModelGrant,
  fetcher: typeof fetch,
  authorize = async () => grant,
  signal = new AbortController().signal,
  callStore: ModelCallStore = store,
) {
  return new OwnedTextModel(
    scope,
    grant,
    authorize,
    callStore,
    signal,
    fetcher,
  );
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scout-model-edge-"));
  keyFile = join(directory, "synthetic-key");
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@fixture.example` });
});
beforeEach(async () => {
  providerCalls = 0;
  await database.delete(calls).where(eq(calls.deploymentId, prefix));
  await writeFile(keyFile, syntheticKey, { mode: 0o600 });
});
afterAll(async () => {
  await database.delete(calls).where(eq(calls.deploymentId, prefix));
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
  await rm(directory, { recursive: true, force: true });
});

describe("owned model adversarial SQL/public-SDK boundaries", () => {
  test("denies media, tool transcripts and structured output before reserving or dispatching", async () => {
    const inputs: Options[] = [
      {
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: new URL(
                  "https://never-fetch.fixture.example/private.png",
                ),
              },
            ],
          },
        ],
      },
      {
        prompt: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "invented",
                toolName: "private",
                output: { type: "text", value: "untrusted" },
              },
            ],
          },
        ],
      },
      { ...options(), responseFormat: { type: "json" } },
    ];
    const scope = await run(),
      grant = grantFor();
    for (const input of inputs) {
      await expect(
        model(scope, grant, transport(success())).doGenerate(input),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
    }
    expect(providerCalls).toBe(0);
    expect(await receipts()).toHaveLength(0);
  });

  test("provider options, headers, tool definitions and tool choice cannot override the protected outbound request", async () => {
    let sentBody: unknown, sentHeaders: Headers | undefined;
    const input: Options = {
      ...options(),
      tools: [
        {
          type: "function",
          name: "private",
          description: "untrusted",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: { type: "tool", toolName: "private" },
      providerOptions: {
        openai: {
          model: "unapproved-paid-model",
          apiKey: "unapproved-key",
          baseURL: "https://never-fetch.fixture.example/v1",
        },
      },
      headers: {
        authorization: "Bearer unapproved-key",
        "x-untrusted-header": "untrusted",
      },
      maxOutputTokens: 10000,
    };
    await model(
      await run(),
      grantFor(),
      transport((init) => {
        sentBody = JSON.parse(String(init.body));
        sentHeaders = new Headers(init.headers);
        return new Response(success(), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    ).doGenerate(input);
    expect(sentBody).toMatchObject({ model: "fixture-edge", max_tokens: 16 });
    expect(sentBody).not.toHaveProperty("tools");
    expect(sentBody).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(sentBody)).not.toContain("unapproved");
    expect(sentHeaders?.get("authorization")).toBe(`Bearer ${syntheticKey}`);
    expect(sentHeaders?.has("x-untrusted-header")).toBe(false);
  });

  test("reads a key rotated after durable reservation rather than caching the initial secret", async () => {
    const rotated = "synthetic-edge-rotated-key";
    const captured: { authorization: string | null } = { authorization: null };
    const wrapped = {
      ...store,
      reserve: async (...args: Parameters<ModelCallStore["reserve"]>) => {
        const call = await store.reserve(...args);
        await writeFile(keyFile, rotated);
        return call;
      },
    };
    const result = await model(
      await run(),
      grantFor(),
      transport((init) => {
        captured.authorization = new Headers(init.headers).get("authorization");
        return new Response(success(), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
      undefined,
      undefined,
      wrapped,
    ).doGenerate(options());
    expect(result.content).toEqual([{ type: "text", text: "EDGE_OK" }]);
    expect(captured.authorization).toBe(`Bearer ${rotated}`);
    expect(JSON.stringify(await receipts())).not.toContain(rotated);
  });

  test("invalid replacement key refuses a reserved call without sending either secret", async () => {
    const wrapped = {
      ...store,
      reserve: async (...args: Parameters<ModelCallStore["reserve"]>) => {
        const call = await store.reserve(...args);
        await writeFile(keyFile, "synthetic\ninvalid-key");
        return call;
      },
    };
    await expect(
      model(
        await run(),
        grantFor(),
        transport(success()),
        undefined,
        undefined,
        wrapped,
      ).doGenerate(options()),
    ).rejects.toThrow("MODEL_NOT_CONFIGURED");
    expect(providerCalls).toBe(0);
    expect((await terminalReceipt()).status).toBe("refused");
  });

  test("policy change immediately after durable dispatch prevents network egress and records uncertainty", async () => {
    let changed = false;
    const grant = grantFor();
    const wrapped = {
      ...store,
      dispatch: async (...args: Parameters<ModelCallStore["dispatch"]>) => {
        await store.dispatch(...args);
        changed = true;
      },
    };
    await expect(
      model(
        await run(),
        grant,
        transport(success()),
        async () =>
          changed
            ? { ...grant, fingerprint: "f".repeat(64), revision: 2 }
            : grant,
        undefined,
        wrapped,
      ).doGenerate(options()),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(providerCalls).toBe(0);
    const receipt = await terminalReceipt();
    expect(receipt.status).toBe("uncertain");
    expect(receipt.errorCode).toBe("MODEL_ACCESS_DENIED");
  });

  test("changed history producer token fences a reserved call before dispatch", async () => {
    const scope = await run(),
      grant = grantFor();
    const wrapped = {
      ...store,
      reserve: async (...args: Parameters<ModelCallStore["reserve"]>) => {
        const call = await store.reserve(...args);
        await database
          .update(historyRuns)
          .set({ leaseToken: randomUUID() })
          .where(
            and(
              eq(historyRuns.threadId, scope.threadId),
              eq(historyRuns.id, scope.runId),
            ),
          );
        return call;
      },
    };
    await expect(
      model(
        scope,
        grant,
        transport(success()),
        undefined,
        undefined,
        wrapped,
      ).doGenerate(options()),
    ).rejects.toThrow("MODEL_CONFLICT");
    expect(providerCalls).toBe(0);
    expect((await terminalReceipt()).status).toBe("refused");
  });

  test("expired dispatched receipt becomes uncertain even when the next admission is denied by the exhausted daily quota", async () => {
    const scope = await run(),
      grant = { ...grantFor(), globalMaxCallsPerDay: 1 };
    const call = await store.reserve(scope, grant, {
      digest: "a".repeat(64),
      bytes: 100,
      endpointOrigin: "http://127.0.0.1:25435",
    });
    await store.dispatch(scope, call, grant);
    await database
      .update(calls)
      .set({ expiresAt: new Date(0) })
      .where(eq(calls.id, call.id));
    await expect(
      createModelCallStore(database).reserve(await run(), grant, {
        digest: "b".repeat(64),
        bytes: 100,
        endpointOrigin: "http://127.0.0.1:25435",
      }),
    ).rejects.toThrow("MODEL_LIMIT");
    const [receipt] = await receipts();
    expect(receipt?.id).toBe(call.id);
    expect(receipt?.status).toBe("uncertain");
    expect(receipt?.errorCode).toBe("MODEL_LEASE_EXPIRED");
    expect(providerCalls).toBe(0);
    await expect(store.finish(call, "completed")).rejects.toThrow(
      "MODEL_CONFLICT",
    );
  });

  test("an owner receipt read alone recovers an expired dispatch while foreign tenant reads cannot mutate it", async () => {
    const scope = await run(),
      grant = grantFor();
    const call = await store.reserve(scope, grant, {
      digest: "c".repeat(64),
      bytes: 100,
      endpointOrigin: "http://127.0.0.1:25435",
    });
    await store.dispatch(scope, call, grant);
    await database
      .update(calls)
      .set({ expiresAt: new Date(0) })
      .where(eq(calls.id, call.id));
    expect(
      await createModelCallStore(database).receipts(
        { ...principal, tenantId: "foreign-tenant" },
        scope.threadId,
      ),
    ).toHaveLength(0);
    expect((await receipts())[0]?.status).toBe("dispatched");
    const [receipt] = await createModelCallStore(database).receipts(
      principal,
      scope.threadId,
    );
    expect(receipt?.id).toBe(call.id);
    expect(receipt?.status).toBe("uncertain");
    expect(receipt?.errorCode).toBe("MODEL_LEASE_EXPIRED");
    expect((await receipts())[0]?.status).toBe("uncertain");
    expect(providerCalls).toBe(0);
  });

  for (const change of ["producer-token", "stopped-history"] as const) {
    test(`${change} after dispatch fences terminal output and prevents a completed receipt`, async () => {
      const scope = await run(),
        grant = grantFor();
      const emitted: unknown[] = [];
      let caught: unknown;
      const fetcher = transport(async () => {
        if (change === "producer-token") {
          await database
            .update(historyRuns)
            .set({ leaseToken: randomUUID() })
            .where(
              and(
                eq(historyRuns.threadId, scope.threadId),
                eq(historyRuns.id, scope.runId),
              ),
            );
        } else {
          await history.stop(principal, scope.threadId, scope.runId);
        }
        return new Response(success(), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      try {
        const result = await model(scope, grant, fetcher).doStream(options());
        for await (const part of result.stream) emitted.push(part);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("MODEL_CONFLICT");
      expect(
        emitted.some((part) => (part as { type?: string }).type === "finish"),
      ).toBe(false);
      expect(providerCalls).toBe(1);
      const receipt = await terminalReceipt();
      expect(receipt.status).toBe("uncertain");
      expect(receipt.errorCode).toBe("MODEL_CONFLICT");
    });
  }

  describe("OpenRouter terminal accounting frames", () => {
    type Reason = "stop" | "length";
    const answer = "ACCOUNTING_OK_✓";
    const reportedModel = "synthetic/accounting-free";
    const usage = () => ({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      cost: 0,
    });
    const choice = (reason: Reason) => ({
      index: 0,
      delta: { content: "", role: "assistant" },
      finish_reason: reason,
      native_finish_reason: reason,
    });
    const accounting = (reason: Reason) => ({
      id: "accounting-edge",
      model: reportedModel,
      choices: [choice(reason)],
      usage: usage(),
    });
    const prefixBody = (reason: Reason) =>
      packet({
        id: "accounting-edge",
        model: reportedModel,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: answer },
            finish_reason: null,
          },
        ],
      }) +
      packet({
        id: "accounting-edge",
        model: reportedModel,
        choices: [choice(reason)],
      });
    const bodyFor = (reason: Reason, tails: unknown[]) =>
      `${prefixBody(reason)}${tails.map(packet).join("")}data: [DONE]\n\n`;

    for (const reason of ["stop", "length"] as const) {
      for (const fragmented of [false, true]) {
        test(`accepts ${reason} repeated only by its ${fragmented ? "fragmented " : ""}usage tail and records exact accounting once`, async () => {
          const body = bodyFor(reason, [accounting(reason)]);
          const response = fragmented
            ? transport(() => {
                const bytes = new TextEncoder().encode(body);
                const unicode = bytes.indexOf(0xe2);
                const tail = Buffer.byteLength(prefixBody(reason));
                // Split inside the answer's UTF-8 character, the accounting SSE
                // prefix and JSON, and DONE. No chunk aligns with an event.
                const cuts = [
                  0,
                  1,
                  unicode + 1,
                  unicode + 2,
                  tail + 3,
                  tail + 37,
                  bytes.length - 4,
                  bytes.length,
                ];
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(out) {
                      for (let index = 0; index < cuts.length - 1; index++)
                        out.enqueue(bytes.slice(cuts[index], cuts[index + 1]));
                      out.close();
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                );
              })
            : transport(body);
          const output = await model(
            await run(),
            grantFor("openrouter"),
            response,
          ).doGenerate(options());
          expect(output.content).toEqual([{ type: "text", text: answer }]);
          expect(output.finishReason.unified).toBe(reason);
          expect(output.usage).toMatchObject({
            inputTokens: { total: 12 },
            outputTokens: { total: 4 },
          });
          expect(providerCalls).toBe(1);
          const rows = await receipts();
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            status: "completed",
            errorCode: null,
            inputTokens: 12,
            outputTokens: 4,
            reportedCostUsd: "0.000000000000",
            reportedModel,
            outputBytes: Buffer.byteLength(answer),
            provider: "openrouter",
            requestedModel: "openrouter/free",
          });
        });
      }
    }

    test("retains compatibility with the empty-choices accounting tail", async () => {
      const output = await model(
        await run(),
        grantFor("openrouter"),
        transport(
          bodyFor("stop", [
            {
              id: "accounting-edge",
              model: reportedModel,
              choices: [],
              usage: usage(),
            },
          ]),
        ),
      ).doGenerate(options());
      expect(output.content).toEqual([{ type: "text", text: answer }]);
      expect(providerCalls).toBe(1);
      expect(await receipts()).toHaveLength(1);
      expect(await terminalReceipt()).toMatchObject({
        status: "completed",
        inputTokens: 12,
        outputTokens: 4,
        reportedCostUsd: "0.000000000000",
      });
    });

    const refusals: {
      name: string;
      tails: () => unknown[];
      codes?: string[];
    }[] = [
      {
        name: "conflicting terminal reason in the accounting tail",
        tails: () => [accounting("length")],
      },
      {
        name: "a duplicate terminal without accounting",
        tails: () => [
          {
            id: "accounting-edge",
            choices: [choice("stop")],
          },
        ],
      },
      {
        name: "a duplicate terminal with array-shaped usage",
        tails: () => [{ ...accounting("stop"), usage: [] }],
      },
      {
        name: "new content on the repeated terminal",
        tails: () => [
          {
            ...accounting("stop"),
            choices: [
              {
                ...choice("stop"),
                delta: { content: "FORBIDDEN_ACCOUNTING_CONTENT" },
              },
            ],
          },
        ],
      },
      {
        name: "new reasoning on the repeated terminal",
        tails: () => [
          {
            ...accounting("stop"),
            choices: [
              {
                ...choice("stop"),
                delta: { reasoning: "FORBIDDEN_ACCOUNTING_REASONING" },
              },
            ],
          },
        ],
      },
      {
        name: "a message on the repeated terminal",
        tails: () => [
          {
            ...accounting("stop"),
            choices: [
              {
                ...choice("stop"),
                message: {
                  role: "assistant",
                  content: "FORBIDDEN_ACCOUNTING_MESSAGE",
                },
              },
            ],
          },
        ],
      },
      {
        name: "a tool payload on the repeated terminal",
        tails: () => [
          {
            ...accounting("stop"),
            choices: [
              {
                ...choice("stop"),
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "accounting-tool",
                      type: "function",
                      function: {
                        name: "FORBIDDEN_ACCOUNTING_TOOL",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
        codes: ["MODEL_UNAVAILABLE", "MODEL_ACCESS_DENIED"],
      },
      {
        name: "a second accounting tail",
        tails: () => [accounting("stop"), accounting("stop")],
      },
      {
        name: "an empty-choices accounting tail after a repeated terminal tail",
        tails: () => [
          accounting("stop"),
          { ...accounting("stop"), choices: [] },
        ],
      },
      {
        name: "two empty-choices accounting tails",
        tails: () => [
          { ...accounting("stop"), choices: [] },
          { ...accounting("stop"), choices: [] },
        ],
      },
      {
        name: "negative prompt tokens in the accounting tail",
        tails: () => [
          {
            ...accounting("stop"),
            usage: { ...usage(), prompt_tokens: -1 },
          },
        ],
      },
      {
        name: "fractional completion tokens in the accounting tail",
        tails: () => [
          {
            ...accounting("stop"),
            usage: { ...usage(), completion_tokens: 1.5 },
          },
        ],
      },
      {
        name: "an out-of-range token count in the accounting tail",
        tails: () => [
          {
            ...accounting("stop"),
            usage: { ...usage(), prompt_tokens: 2147483648 },
          },
        ],
      },
      {
        name: "string cost in the accounting tail",
        tails: () => [
          { ...accounting("stop"), usage: { ...usage(), cost: "0" } },
        ],
      },
      {
        name: "negative cost in the accounting tail",
        tails: () => [
          { ...accounting("stop"), usage: { ...usage(), cost: -1 } },
        ],
      },
      {
        name: "a positive charge in the accounting tail",
        tails: () => [
          { ...accounting("stop"), usage: { ...usage(), cost: 0.01 } },
        ],
        codes: ["MODEL_COST_VIOLATION"],
      },
    ];
    for (const refusal of refusals) {
      test(`refuses ${refusal.name} without a successful finish or retry`, async () => {
        const emitted: unknown[] = [];
        let failure: unknown;
        try {
          const result = await model(
            await run(),
            grantFor("openrouter"),
            transport(bodyFor("stop", refusal.tails())),
          ).doStream(options());
          for await (const part of result.stream) emitted.push(part);
        } catch (error) {
          failure = error;
        }
        const codes = refusal.codes ?? ["MODEL_UNAVAILABLE"];
        expect(codes.some((code) => String(failure).includes(code))).toBe(true);
        expect(String(failure)).not.toContain(syntheticKey);
        expect(JSON.stringify(emitted)).not.toContain("FORBIDDEN_ACCOUNTING");
        expect(
          emitted.some((part) => (part as { type?: string }).type === "finish"),
        ).toBe(false);
        expect(providerCalls).toBe(1);
        expect(await receipts()).toHaveLength(1);
        const receipt = await terminalReceipt();
        expect(receipt.status).toBe("uncertain");
        expect(codes.some((code) => code === receipt.errorCode)).toBe(true);
      });
    }
  });

  test("malformed/error SSE and invalid usage reject with sanitized errors and retain the dispatched receipt", async () => {
    const bodies = [
      `data: {malformed-${syntheticKey}\n\n`,
      packet({ error: { message: syntheticKey, code: "provider_error" } }),
      packet({
        id: "edge",
        choices: [],
        usage: { prompt_tokens: -1, completion_tokens: 2 },
      }),
      packet({
        id: "edge",
        choices: [],
        usage: { prompt_tokens: 1.5, completion_tokens: 2 },
      }),
      packet({ id: "edge", choices: [], usage: { cost: "0" } }),
    ];
    for (const body of bodies) {
      let caught: unknown;
      try {
        await model(await run(), grantFor(), transport(body)).doGenerate(
          options(),
        );
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("MODEL_UNAVAILABLE");
      expect(String(caught)).not.toContain(syntheticKey);
    }
    expect(providerCalls).toBe(bodies.length);
    const rows = await receipts();
    expect(rows).toHaveLength(bodies.length);
    expect(rows.every((row) => row.status === "uncertain")).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.inputTokens === null &&
          row.outputTokens === null &&
          row.reportedCostUsd === null,
      ),
    ).toBe(true);
  });

  const partial = packet({
    id: "edge",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "INCOMPLETE_PARTIAL" },
        finish_reason: null,
      },
    ],
  });
  for (const [name, body] of [
    ["empty clean EOF", ""],
    ["partial text followed by clean EOF", partial],
    [
      "DONE marker without provider terminal reason",
      `${partial}data: [DONE]\n\n`,
    ],
  ] as const) {
    test(`${name} cannot be mistaken for successful provider completion`, async () => {
      const emitted: unknown[] = [];
      let caught: unknown;
      try {
        const result = await model(
          await run(),
          grantFor(),
          transport(body),
        ).doStream(options());
        for await (const part of result.stream) emitted.push(part);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("MODEL_UNAVAILABLE");
      expect(
        emitted.some((part) => (part as { type?: string }).type === "finish"),
      ).toBe(false);
      expect(providerCalls).toBe(1);
      const receipt = await terminalReceipt();
      expect(receipt.status).toBe("uncertain");
      expect(receipt.errorCode).toBe("MODEL_UNAVAILABLE");
    });
  }

  test("unexpected provider images are rejected before any assistant content reaches the caller", async () => {
    const body = packet({
      id: "edge",
      choices: [
        {
          index: 0,
          delta: {
            content: "NEVER_FORWARD",
            images: [
              { image_url: "https://never-fetch.fixture.example/private.png" },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    const emitted: unknown[] = [];
    let caught: unknown;
    try {
      const result = await model(
        await run(),
        grantFor(),
        transport(body),
      ).doStream(options());
      for await (const part of result.stream) emitted.push(part);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("MODEL_ACCESS_DENIED");
    expect(JSON.stringify(emitted)).not.toContain("NEVER_FORWARD");
    expect((await terminalReceipt()).status).toBe("uncertain");
  });

  test("timeout aborts an in-flight provider once, retains quota and cannot become completed later", async () => {
    let aborted = 0;
    const scope = await run(),
      grant = grantFor();
    const fetcher = transport(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            aborted++;
            reject(new Error(`provider aborted ${syntheticKey}`));
          };
          init.signal?.addEventListener("abort", abort, { once: true });
          if (init.signal?.aborted) abort();
        }),
    );
    const started = Date.now();
    await expect(
      model(scope, grant, fetcher).doGenerate(options()),
    ).rejects.toThrow("MODEL_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(aborted).toBe(1);
    expect(providerCalls).toBe(1);
    expect((await terminalReceipt()).status).toBe("uncertain");
    await expect(
      model(scope, grant, transport(success())).doGenerate(options()),
    ).rejects.toThrow("MODEL_LIMIT");
    expect(providerCalls).toBe(1);
  }, 5000);

  test("run cancellation propagates through the public SDK and leaves no completed receipt", async () => {
    const controller = new AbortController();
    let aborted = 0;
    const fetcher = transport(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted++;
              reject(new Error("synthetic run cancelled"));
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        }),
    );
    await expect(
      model(
        await run(),
        grantFor(),
        fetcher,
        undefined,
        controller.signal,
      ).doGenerate(options()),
    ).rejects.toThrow("MODEL_UNAVAILABLE");
    expect(aborted).toBe(1);
    expect(providerCalls).toBe(1);
    expect((await terminalReceipt()).status).toBe("uncertain");
  });

  test("abort while completed receipt persistence awaits suppresses successful finish without downgrading or replaying the committed call", async () => {
    const controller = new AbortController();
    const scope = await run(),
      grant = grantFor();
    let committedBeforeAbort = false;
    const wrapped = {
      ...store,
      finish: async (...args: Parameters<ModelCallStore["finish"]>) => {
        await store.finish(...args);
        if (args[1] === "completed") {
          committedBeforeAbort = (await receipts())[0]?.status === "completed";
          controller.abort();
        }
      },
    };
    const emitted: unknown[] = [];
    let caught: unknown;
    try {
      const result = await model(
        scope,
        grant,
        transport(success()),
        undefined,
        controller.signal,
        wrapped,
      ).doStream(options());
      for await (const part of result.stream) emitted.push(part);
    } catch (error) {
      caught = error;
    }
    expect(committedBeforeAbort).toBe(true);
    expect(String(caught)).toContain("MODEL_UNAVAILABLE");
    expect(
      emitted.some((part) => (part as { type?: string }).type === "finish"),
    ).toBe(false);
    expect(providerCalls).toBe(1);
    const receipt = await terminalReceipt();
    expect(receipt.status).toBe("completed");
    expect(receipt.errorCode).toBeNull();
    expect(receipt.outputBytes).toBe(Buffer.byteLength("EDGE_OK"));
    await expect(
      model(scope, grant, transport(success())).doGenerate(options()),
    ).rejects.toThrow("MODEL_LIMIT");
    expect(providerCalls).toBe(1);
    expect((await receipts())[0]?.status).toBe("completed");
  });

  test("revocation while streaming prevents a successful terminal receipt", async () => {
    let revoked = false;
    const grant = grantFor();
    const fetcher = transport(() => {
      revoked = true;
      return new Response(success(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await expect(
      model(await run(), grant, fetcher, async () =>
        revoked
          ? { ...grant, fingerprint: "e".repeat(64), revision: 2 }
          : grant,
      ).doGenerate(options()),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(providerCalls).toBe(1);
    expect((await terminalReceipt()).status).toBe("uncertain");
  });

  test("revocation while awaiting provider content releases no text", async () => {
    const grant = grantFor();
    let revoked = false;
    let providerStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const providerReady = Promise.withResolvers<void>();
    const emitted: unknown[] = [];
    const opening = model(
      await run(),
      grant,
      transport(
        (init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                providerStream = controller;
                init.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(new Error("Synthetic provider aborted")),
                  { once: true },
                );
                providerReady.resolve();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
      async () => (revoked ? { ...grant, fingerprint: "e".repeat(64) } : grant),
    ).doStream(options());
    // The SDK waits for a nonempty output packet before returning doStream.
    // Revoke only after transport dispatch, while that provider read is pending.
    await providerReady.promise;
    revoked = true;
    providerStream?.enqueue(new TextEncoder().encode(success()));
    providerStream?.close();
    let failure: unknown;
    try {
      const result = await opening;
      for await (const part of result.stream) emitted.push(part);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("MODEL_ACCESS_DENIED");
    expect(
      emitted.filter((part) =>
        ["text-delta", "reasoning-delta", "finish"].includes(
          (part as { type: string }).type,
        ),
      ),
    ).toEqual([]);
    expect(providerCalls).toBe(1);
    const receipt = await terminalReceipt();
    expect(receipt.status).toBe("uncertain");
    expect(receipt.outputBytes).toBe(0);
  });

  test("allowed streaming stays incremental and revocation withholds later provider content", async () => {
    const grant = grantFor();
    let revoked = false;
    let providerStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const result = await model(
      await run(),
      grant,
      transport(
        (init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                providerStream = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    packet({
                      id: "edge",
                      choices: [
                        {
                          index: 0,
                          delta: {
                            role: "assistant",
                            content: "ALLOWED_PREFIX",
                          },
                          finish_reason: null,
                        },
                      ],
                    }),
                  ),
                );
                init.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(new Error("Synthetic provider aborted")),
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
      async () => (revoked ? { ...grant, fingerprint: "e".repeat(64) } : grant),
    ).doStream(options());
    const reader = result.stream.getReader();
    const emitted: { type: string; delta?: string }[] = [];
    while (!emitted.some((part) => part.type === "text-delta")) {
      const next = await reader.read();
      if (next.done)
        throw new Error("Synthetic stream ended before its prefix");
      emitted.push(next.value);
    }
    // No finish packet has arrived: the authorized prefix must stream without
    // buffering the entire answer, while the next provider read remains gated.
    expect(emitted.find((part) => part.type === "text-delta")?.delta).toBe(
      "ALLOWED_PREFIX",
    );
    revoked = true;
    providerStream?.enqueue(
      new TextEncoder().encode(success().replace("EDGE_OK", "DENIED_SUFFIX")),
    );
    providerStream?.close();
    let failure: unknown;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        emitted.push(next.value);
      }
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("MODEL_ACCESS_DENIED");
    expect(JSON.stringify(emitted)).not.toContain("DENIED_SUFFIX");
    expect(emitted.some((part) => part.type === "finish")).toBe(false);
    expect(providerCalls).toBe(1);
    const receipt = await terminalReceipt();
    expect(receipt.status).toBe("uncertain");
    expect(receipt.outputBytes).toBe(Buffer.byteLength("ALLOWED_PREFIX"));
  });

  test("abort during asynchronous output authorization releases no provider content", async () => {
    const grant = grantFor();
    const controller = new AbortController();
    let providerReturned = false;
    const emitted: { type: string }[] = [];
    let failure: unknown;
    try {
      const result = await model(
        await run(),
        grant,
        transport(() => {
          providerReturned = true;
          return new Response(success(), {
            headers: { "content-type": "text/event-stream" },
          });
        }),
        async () => {
          if (providerReturned) controller.abort();
          return grant;
        },
        controller.signal,
      ).doStream(options());
      for await (const part of result.stream) emitted.push(part);
    } catch (error) {
      failure = error;
    }
    expect(
      emitted.filter((part) =>
        ["text-delta", "reasoning-delta", "finish"].includes(part.type),
      ),
    ).toEqual([]);
    expect(String(failure)).toContain("MODEL_UNAVAILABLE");
    expect(providerCalls).toBe(1);
    expect((await terminalReceipt()).status).toBe("uncertain");
  });

  test("revocation during completed receipt persistence withholds finish without rewriting the committed receipt", async () => {
    const grant = grantFor();
    let revoked = false;
    const wrapped = {
      ...store,
      finish: async (...args: Parameters<ModelCallStore["finish"]>) => {
        await store.finish(...args);
        if (args[1] === "completed") revoked = true;
      },
    };
    const emitted: { type: string }[] = [];
    let failure: unknown;
    try {
      const result = await model(
        await run(),
        grant,
        transport(success()),
        async () =>
          revoked ? { ...grant, fingerprint: "e".repeat(64) } : grant,
        undefined,
        wrapped,
      ).doStream(options());
      for await (const part of result.stream) emitted.push(part);
    } catch (error) {
      failure = error;
    }
    expect(revoked).toBe(true);
    expect(emitted.some((part) => part.type === "finish")).toBe(false);
    expect(String(failure)).toContain("MODEL_ACCESS_DENIED");
    expect(providerCalls).toBe(1);
    const receipt = await terminalReceipt();
    expect(receipt.status).toBe("completed");
    expect(receipt.errorCode).toBeNull();
  });

  test("revocation during stream closure withholds the accumulated generated answer", async () => {
    const grant = grantFor();
    let revoked = false;
    const subject = model(await run(), grant, transport(success()), async () =>
      revoked ? { ...grant, fingerprint: "e".repeat(64) } : grant,
    );
    const originalStream = subject.doStream.bind(subject);
    subject.doStream = async (value) => {
      const result = await originalStream(value);
      const reader = result.stream.getReader();
      return {
        ...result,
        stream: new ReadableStream({
          async pull(out) {
            const next = await reader.read();
            if (next.done) {
              // Change authority after the actual SDK stream closes, while
              // doGenerate still holds the answer privately in its accumulator.
              revoked = true;
              out.close();
            } else out.enqueue(next.value);
          },
          cancel: () => reader.cancel(),
        }),
      };
    };
    await expect(subject.doGenerate(options())).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(revoked).toBe(true);
    expect(providerCalls).toBe(1);
    expect((await terminalReceipt()).status).toBe("completed");
  });

  test("a paused consumer cannot receive a prefetched delta after revocation", async () => {
    const grant = grantFor();
    let revoked = false;
    const body = success().replace(
      packet({
        id: "edge",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      packet({
        id: "edge",
        choices: [
          {
            index: 0,
            delta: { content: "DENIED_SUFFIX" },
            finish_reason: null,
          },
        ],
      }) +
        packet({
          id: "edge",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
    );
    const result = await model(await run(), grant, transport(body), async () =>
      revoked ? { ...grant, fingerprint: "e".repeat(64) } : grant,
    ).doStream(options());
    const reader = result.stream.getReader();
    const emitted: { type: string; delta?: string }[] = [];
    while (!emitted.some((part) => part.type === "text-delta")) {
      const next = await reader.read();
      if (next.done) throw new Error("Synthetic prefix missing");
      emitted.push(next.value);
    }
    expect(emitted.find((part) => part.type === "text-delta")?.delta).toBe(
      "EDGE_OK",
    );
    // Drain scheduled microtasks while the consumer is paused, as when the native
    // runner awaits history persistence. The next wire delta is already in the SDK.
    await new Promise<void>((resolve) => setImmediate(resolve));
    revoked = true;
    let failure: unknown;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        emitted.push(next.value);
      }
    } catch (error) {
      failure = error;
    }
    expect(JSON.stringify(emitted)).not.toContain("DENIED_SUFFIX");
    expect(String(failure)).toContain("MODEL_ACCESS_DENIED");
    expect((await terminalReceipt()).status).toBe("uncertain");
  });

  test("a grant expiring during output authorization releases no content even with the same fingerprint", async () => {
    const grant = grantFor();
    let providerReturned = false;
    const emitted: { type: string }[] = [];
    let failure: unknown;
    try {
      const result = await model(
        await run(),
        grant,
        transport(() => {
          providerReturned = true;
          return new Response(success(), {
            headers: { "content-type": "text/event-stream" },
          });
        }),
        async () => {
          if (!providerReturned) return grant;
          const snapshot = {
            ...grant,
            expiresAt: new Date(Date.now() + 1).toISOString(),
          };
          await Bun.sleep(10);
          expect(Date.parse(snapshot.expiresAt)).toBeLessThanOrEqual(
            Date.now(),
          );
          return snapshot;
        },
      ).doStream(options());
      for await (const part of result.stream) emitted.push(part);
    } catch (error) {
      failure = error;
    }
    expect(
      emitted.filter((part) =>
        ["text-delta", "reasoning-delta", "finish"].includes(part.type),
      ),
    ).toEqual([]);
    expect(String(failure)).toContain("MODEL_ACCESS_DENIED");
    expect((await terminalReceipt()).status).toBe("uncertain");
  });

  test("deleting conversation history preserves durable daily usage and protected receipt scope", async () => {
    const scope = await run(),
      grant = { ...grantFor(), globalMaxCallsPerDay: 1 };
    await model(scope, grant, transport(success())).doGenerate(options());
    await database.delete(threads).where(eq(threads.id, scope.threadId));
    expect(await receipts()).toHaveLength(1);
    await expect(
      model(await run(), grant, transport(success())).doGenerate(options()),
    ).rejects.toThrow("MODEL_LIMIT");
    expect(
      await store.receipts(
        { ...principal, tenantId: "other-tenant" },
        scope.threadId,
      ),
    ).toHaveLength(0);
    expect(
      await store.receipts(
        { ...principal, userId: `${prefix}-other-user` },
        scope.threadId,
      ),
    ).toHaveLength(0);
    expect(
      await store.receipts(
        { ...principal, deploymentId: `${prefix}-other-deployment` },
        scope.threadId,
      ),
    ).toHaveLength(0);
    const [receipt] = await store.receipts(principal, scope.threadId);
    expect(receipt?.status).toBe("completed");
    expect(receipt).not.toHaveProperty("leaseToken");
    expect(providerCalls).toBe(1);
  });
});
