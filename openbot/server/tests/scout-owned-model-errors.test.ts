import { describe, expect, test } from "bun:test";
import { HistoryError } from "../src/scout/history/protocol";
import { OwnedTextModel } from "../src/scout/owned-model/model";
import { parseModelPolicy } from "../src/scout/owned-model/policy";
import type { ModelCallStore } from "../src/scout/owned-model/store";
import { ScoutError } from "../src/scout/types";

const scope = {
  userId: "native-alice",
  tenantId: "tenant-a",
  deploymentId: "scout-test",
  agentId: "scout",
  threadId: "thread",
  runId: "run",
};
const grant = parseModelPolicy(
  {
    version: 1,
    deploymentId: scope.deploymentId,
    globalMaxConcurrent: 1,
    globalMaxCallsPerDay: 10,
    bindings: [
      {
        userId: scope.userId,
        tenantId: scope.tenantId,
        active: true,
        revision: 1,
        expiresAt: "2099-01-01T00:00:00Z",
        agentIds: [scope.agentId],
        allowConversationContext: true,
        allowPersonalInstructions: false,
        route: {
          provider: "local",
          model: "synthetic-model",
          baseUrl: "http://127.0.0.1:1/v1",
        },
        limits: {
          maxInputBytes: 8192,
          maxOutputTokens: 64,
          maxOutputBytes: 4096,
          maxCallsPerRun: 1,
          maxCallsPerDay: 10,
          maxConcurrent: 1,
          timeoutMs: 5000,
        },
      },
    ],
  },
  scope,
);
const options = {
  prompt: [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Synthetic authorization regression" },
      ],
    },
  ],
};
function fixture(authorizationError: Error, revokeInitially = false) {
  let revoked = revokeInitially,
    reserves = 0,
    providerCalls = 0;
  const receipts: {
    status: string;
    code: string | undefined;
    outputBytes: number;
  }[] = [];
  const store: ModelCallStore = {
    reserve: async () => {
      reserves++;
      return {} as Awaited<ReturnType<ModelCallStore["reserve"]>>;
    },
    dispatch: async () => {},
    finish: async (_call, status, usage, code) => {
      if (!usage) throw new Error("Expected synthetic model usage receipt");
      receipts.push({ status, code, outputBytes: usage.outputBytes });
    },
    receipts: async () => [],
  };
  const transport: typeof fetch = Object.assign(
    async () => {
      providerCalls++;
      revoked = true;
      const packets = [
        {
          id: "fixture",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "REVOKED_RESPONSE_MUST_NOT_LEAK",
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "fixture",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return new Response(
        `${packets.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const model = new OwnedTextModel(
    scope,
    grant,
    async () => {
      if (revoked) throw authorizationError;
      return grant;
    },
    store,
    new AbortController().signal,
    transport,
  );
  return {
    model,
    receipts,
    reserves: () => reserves,
    providerCalls: () => providerCalls,
  };
}
describe("owned model preserves native authorization refusal semantics", () => {
  for (const [name, refusal] of [
    ["history authorization", () => new HistoryError("HISTORY_ACCESS_DENIED")],
    ["native membership", () => new ScoutError("SCOUT_ACCESS_DENIED", 403)],
  ] as const) {
    test(`${name} before dispatch is access denied without reserving or calling a provider`, async () => {
      const f = fixture(refusal(), true);
      await expect(f.model.doGenerate(options)).rejects.toMatchObject({
        code: "MODEL_ACCESS_DENIED",
      });
      expect(f.reserves()).toBe(0);
      expect(f.providerCalls()).toBe(0);
      expect(f.receipts).toEqual([]);
    });
    test(`${name} during a provider wait withholds output and records the denial`, async () => {
      const f = fixture(refusal());
      await expect(f.model.doGenerate(options)).rejects.toMatchObject({
        code: "MODEL_ACCESS_DENIED",
      });
      expect(f.providerCalls()).toBe(1);
      expect(f.receipts).toEqual([
        { status: "uncertain", code: "MODEL_ACCESS_DENIED", outputBytes: 0 },
      ]);
    });
  }
  test("an unrelated error with a forged native code stays unavailable", async () => {
    const f = fixture(
      Object.assign(new Error("synthetic-private-provider-error"), {
        code: "HISTORY_ACCESS_DENIED",
      }),
    );
    await expect(f.model.doGenerate(options)).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
    });
    expect(f.receipts).toEqual([
      { status: "uncertain", code: "MODEL_UNAVAILABLE", outputBytes: 0 },
    ]);
  });
});
