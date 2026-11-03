import { describe, expect, test } from "bun:test";
import type { PlanLanguageModel } from "../src/agents/plan-model";
import { ownedCatalog } from "../src/scout/owned/catalog";
import { OwnedCapabilityTool } from "../src/scout/owned-model/capability-tool";
import { parseModelPolicy } from "../src/scout/owned-model/policy";

type Options = Parameters<PlanLanguageModel["doStream"]>[0];
const principal = {
  userId: "synthetic-owner",
  tenantId: "test",
  deploymentId: "test",
  agentId: "scout",
};
const grant = parseModelPolicy(
  {
    version: 1,
    deploymentId: "test",
    globalMaxConcurrent: 1,
    globalMaxCallsPerDay: 20,
    bindings: [
      {
        ...principal,
        agentId: undefined,
        deploymentId: undefined,
        active: true,
        revision: 1,
        expiresAt: "2099-01-01T00:00:00Z",
        agentIds: ["scout"],
        allowConversationContext: true,
        allowPersonalInstructions: false,
        allowedToolNames: ["scout_capabilities"],
        route: {
          provider: "local",
          model: "fixture",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        limits: {
          maxInputBytes: 8192,
          maxOutputBytes: 4096,
          maxOutputTokens: 64,
          maxCallsPerRun: 2,
          maxCallsPerDay: 20,
          maxConcurrent: 1,
          timeoutMs: 1000,
        },
      },
    ].map(
      ({ agentId: _agentId, deploymentId: _deploymentId, ...binding }) =>
        binding,
    ),
  },
  principal,
);
const catalog = ownedCatalog({ odooSelectedTask: true, delegatedDraft: true });
const options = (): Options => ({
  tools: [
    {
      type: "function",
      name: "scout_capabilities",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  prompt: [
    {
      role: "user",
      content: [{ type: "text", text: "Synthetic status question" }],
    },
  ],
});
const session = (
  authorize = async () => grant,
  signal = new AbortController().signal,
) => new OwnedCapabilityTool(catalog, grant, authorize, signal);
const exchange = (result: string, id = "status_call"): Options["prompt"] => [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "scout_capabilities",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "scout_capabilities",
        output: { type: "text", value: result },
      },
    ],
  },
];

describe("server-owned status capability envelope", () => {
  test("requires an accounted provider call, exact empty arguments and single execution", async () => {
    const tool = session();
    await expect(tool.grantedTool().execute({})).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    for (const [name, input] of [
      ["other", "{}"],
      ["scout_capabilities", '{"userId":"other"}'],
      ["scout_capabilities", "[]"],
      ["scout_capabilities", "{"],
    ])
      expect(() => session().register("status_call", name, input)).toThrow(
        "MODEL_ACCESS_DENIED",
      );
    tool.register("status_call", "scout_capabilities", "{}");
    await expect(
      tool.grantedTool().execute({ url: "https://example.invalid" }),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    const execution = tool.grantedTool().execute({});
    await expect(tool.grantedTool().execute({})).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(JSON.parse(await execution)).toEqual(catalog);
    expect(() => tool.register("again", "scout_capabilities", "{}")).toThrow(
      "MODEL_ACCESS_DENIED",
    );
  });
  test("rechecks revocation and cancellation after asynchronous authorization", async () => {
    for (const scenario of ["revoked", "cancelled"]) {
      const abort = new AbortController();
      let reads = 0;
      const tool = session(async () => {
        reads++;
        if (scenario === "cancelled") abort.abort();
        return scenario === "revoked"
          ? { ...grant, fingerprint: "changed" }
          : grant;
      }, abort.signal);
      tool.register("status_call", "scout_capabilities", "{}");
      await expect(tool.grantedTool().execute({})).rejects.toThrow();
      expect(reads).toBe(1);
    }
  });
  test("owns the wire definition and rejects expanded schemas or unknown tools", () => {
    const tool = session();
    expect(tool.definitions(options())[0].function.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    for (const input of [
      { ...options(), tools: [] },
      {
        ...options(),
        tools: [{ type: "function", name: "foreign", inputSchema: {} }],
      },
      {
        ...options(),
        tools: [
          {
            type: "function",
            name: "scout_capabilities",
            inputSchema: {
              type: "object",
              properties: { userId: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
      },
    ])
      expect(() => tool.definitions(input as Options)).toThrow(
        "MODEL_ACCESS_DENIED",
      );
  });
  test("only the exact current server result enters a follow-up; old status pairs are omitted", async () => {
    const tool = session();
    tool.register("status_call", "scout_capabilities", "{}");
    const result = await tool.grantedTool().execute({});
    const prompt = [...options().prompt, ...exchange(result)];
    const outbound = tool.messages({ ...options(), prompt });
    expect(outbound[2]).toEqual({
      role: "tool",
      tool_call_id: "status_call",
      content: result,
    });
    expect(() => tool.messages(options())).toThrow("MODEL_ACCESS_DENIED");
    expect(() =>
      tool.messages({
        ...options(),
        prompt: exchange(JSON.stringify({ ...catalog, voice: "available" })),
      }),
    ).toThrow("MODEL_ACCESS_DENIED");
    expect(() =>
      tool.messages({
        ...options(),
        prompt: exchange(
          JSON.stringify({
            ...catalog,
            skills: { ...catalog.skills, odooSelectedTask: "unavailable" },
          }),
        ),
      }),
    ).toThrow("MODEL_ACCESS_DENIED");
    expect(session().messages({ ...options(), prompt })).toEqual([
      { role: "user", content: "Synthetic status question" },
    ]);
    expect(
      session().messages({
        ...options(),
        prompt: [...options().prompt, ...exchange(JSON.stringify(result))],
      }),
    ).toEqual([{ role: "user", content: "Synthetic status question" }]);
  });
});
