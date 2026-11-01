import "eventsource";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { loadOwnedConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  deploymentPackages,
  userRoles,
  users,
  workItems,
} from "../src/db/schema";
import { scoutHistoryThreads } from "../src/db/schema/scout-history";
import { scoutModelCalls } from "../src/db/schema/scout-model";
import { scoutResourceScopes } from "../src/db/schema/scout-scope";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedApplication } from "../src/scout/owned/application";
import { createModelPolicyReader } from "../src/scout/owned-model/policy";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `pilot-capabilities-${randomUUID()}`;
const owner = `${prefix}-owner`,
  nativeAdmin = `${prefix}-native-admin`,
  botId = `${prefix}-bot`;
const marker = "SYNTHETIC_PILOT_CORE_OK";
let directory = "";
let fixtureUsersCreated = false;
let owned: Awaited<ReturnType<typeof createOwnedApplication>>;
let createFixture: (
  delegatedDrafts?: boolean,
  modelPolicyFile?: string,
) => ReturnType<typeof createOwnedApplication>;
let sink: ReturnType<typeof Bun.serve>;
let nativeSessionActive = true,
  membershipActive = true,
  ownerIsNativeAdmin = true;
let ownerTenant = "tenant-a",
  deploymentId = prefix;
let revision = 1,
  authDispatches = 0,
  futureDispatches = 0,
  futureNetworkRequests = 0,
  modelRequests = 0,
  runs = 0;
const channelIds: string[] = [],
  threadIds: string[] = [],
  agentIds: string[] = [botId];

const policy = () => ({
  version: 1,
  deploymentId,
  policies: ["tenant-a", "tenant-b"].map((tenantId) => ({
    tenantId,
    revision,
    active: membershipActive,
    expiresAt: "2099-01-01T00:00:00Z",
  })),
  memberships: [owner, nativeAdmin].map((userId, index) => ({
    userId,
    tenantId: index ? "tenant-b" : ownerTenant,
    revision,
    policyRevision: revision,
    active: true,
    expiresAt: "2099-01-01T00:00:00Z",
  })),
});
class CoreAgent extends AbstractAgent {
  constructor() {
    super({ agentId: botId });
  }
  run(input: RunAgentInput) {
    runs++;
    return new Observable<BaseEvent>((subscriber) => {
      const messageId = randomUUID();
      for (const event of [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: marker },
        { type: "TEXT_MESSAGE_END", messageId },
        {
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: "success" },
        },
      ] as BaseEvent[])
        subscriber.next(event);
      subscriber.complete();
    });
  }
}
const input = (threadId: string): RunAgentInput => ({
  threadId,
  runId: randomUUID(),
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [
    {
      id: randomUUID(),
      role: "user",
      content: "Synthetic capability qualification",
    },
  ],
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  userId = owner,
  extra: Record<string, string> = {},
) {
  return owned.app.request(path, {
    method,
    headers: {
      "x-synthetic-session": userId,
      "content-type": "application/json",
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function createChannel() {
  const response = await request("/api/channels", "POST", {
    agentIds: [botId],
  });
  expect(response.status).toBe(201);
  const { channel } = (await response.json()) as {
    channel: { id: string; threadId: string };
  };
  channelIds.push(channel.id);
  threadIds.push(channel.threadId);
  return channel;
}
async function unavailable(path: string, method = "GET", body?: unknown) {
  const response = await request(path, method, body);
  if (response.status !== 503)
    throw new Error(
      `Unqualified dispatch ${method} ${path} returned ${response.status}`,
    );
  expect(response.status).toBe(503);
  if (method !== "HEAD")
    expect(await response.text()).not.toContain("SYNTHETIC_FUTURE_EFFECT");
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scout-pilot-capabilities-"));
  await Promise.all(
    Object.entries({
      "brand.yaml": `tenant:\n  id: ${prefix}\n  product_name: Scout Capability Fixture\n`,
      "agents.yaml": `agents:\n  - id: ${botId}\n    name: Scout Capability Fixture\n    title: Fixture\n    role_description: Synthetic qualification only.\n    avatar_seed: fixture\n    type: built-in\n    system_prompt: Synthetic marker only.\n`,
      "channels.yaml": "channels: []\n",
      "knowledge.yaml": "sources: []\n",
      "model.yaml":
        "model:\n  provider: openai\n  credential_secret_ref: synthetic-unused\n  default_model: fixture-model\n",
    }).map(([file, content]) => writeFile(join(directory, file), content)),
  );
  await database.insert(users).values(
    [owner, nativeAdmin].map((id) => ({
      id,
      email: `${id}@fixture.invalid`,
    })),
  );
  fixtureUsersCreated = true;
  await database.insert(userRoles).values(
    [owner, nativeAdmin].map((userId) => ({
      userId,
      role: "admin" as const,
    })),
  );
  createFixture = async (delegatedDrafts = false, modelPolicyFile) => {
    const queuePolicyFile = join(directory, "synthetic-queue-policy.json");
    if (delegatedDrafts)
      await writeFile(
        queuePolicyFile,
        JSON.stringify({
          version: 1,
          deploymentId: prefix,
          policies: ["tenant-a", "tenant-b"].map((tenantId) => ({
            tenantId,
            revision: 1,
            active: true,
            draftAnalysis: true,
            expiresAt: "2099-01-01T00:00:00Z",
          })),
          bindings: [owner, nativeAdmin].map((userId, index) => ({
            userId,
            tenantId: index ? "tenant-b" : "tenant-a",
            policyRevision: 1,
            active: true,
            expiresAt: "2099-01-01T00:00:00Z",
            command: [process.execPath, "-m", "scout_queue.mcp_server"],
            cwd: directory,
            environment: {
              SCOUT_ODOO_URL: "https://synthetic-odoo.fixture.invalid",
              SCOUT_ODOO_DB: "synthetic",
              SCOUT_ODOO_UID: String(index + 2),
              SCOUT_ODOO_COMPANY_IDS: "1",
              SCOUT_ODOO_KEY_FILE: join(directory, "never-created-queue-key"),
            },
          })),
        }),
        { mode: 0o600 },
      );
    return createOwnedApplication(
      loadOwnedConfig({
        DATABASE_URL: testDatabaseUrl(),
        KEY_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString("base64"),
        SCOUT_RUNTIME_MODE: "owned",
        DEPLOYMENT_ID: prefix,
        TENANT_PACKAGE_DIR: directory,
        OPENBOT_ORGANIZATION_AUTH_URL:
          "https://synthetic-identity.fixture.invalid",
        SCOUT_MEMBERSHIPS_FILE: join(directory, "never-created-memberships"),
        ...(delegatedDrafts
          ? {
              SCOUT_QUEUE_BINDINGS_FILE: queuePolicyFile,
            }
          : {}),
        SCOUT_PLATFORM_OWNER_IDS: owner,
        OPENBOT_HOST: "127.0.0.1",
        OPENBOT_GENERATIVE_UI: "false",
        SCOUT_DELEGATED_DRAFTS_ENABLED: String(delegatedDrafts),
        ...(modelPolicyFile
          ? { SCOUT_MODEL_POLICY_FILE: modelPolicyFile }
          : {}),
      }),
      database,
      {
        auth: {
          handler: () => {
            authDispatches++;
            return new Response("SYNTHETIC_AUTH_DISPATCHED");
          },
          api: {
            getSession: async ({ headers, query }) => {
              expect(query?.disableCookieCache).toBe(true);
              const id = headers.get("x-synthetic-session");
              return nativeSessionActive &&
                id &&
                [owner, nativeAdmin].includes(id)
                ? {
                    user: {
                      id,
                      email: `${id}@fixture.invalid`,
                      role:
                        id === owner && !ownerIsNativeAdmin ? "user" : "admin",
                    },
                  }
                : null;
            },
          },
        },
        membership: async (actor) =>
          parseScoutMembership(policy(), actor, prefix),
        ...(modelPolicyFile
          ? {
              modelFetch: Object.assign(async () => {
                modelRequests++;
                const packets = [
                  {
                    id: "synthetic-pilot",
                    model: "synthetic-model",
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant", content: marker },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "synthetic-pilot",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  },
                  {
                    id: "synthetic-pilot",
                    choices: [],
                    usage: { prompt_tokens: 12, completion_tokens: 4 },
                  },
                ];
                return new Response(
                  `${packets.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                );
              }, fetch),
            }
          : { agents: async () => ({ [botId]: new CoreAgent() }) }),
      },
    );
  };
  owned = await createFixture();
  sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      futureNetworkRequests++;
      return new Response("SYNTHETIC_FUTURE_EFFECT");
    },
  });
  const future = new Hono();
  future.all("*", async (context) => {
    futureDispatches++;
    const response = await fetch(
      `http://127.0.0.1:${sink.port}/synthetic-effect`,
    );
    return context.text(await response.text());
  });
  // The isolated control proves this handler would perform real loopback I/O if dispatched.
  const control = await future.request("/synthetic-control");
  expect(await control.text()).toBe("SYNTHETIC_FUTURE_EFFECT");
  expect(futureDispatches).toBe(1);
  expect(futureNetworkRequests).toBe(1);
  // Deliberately mount after the real composition, as an accidentally introduced feature would be.
  for (const path of [
    "/api",
    "/api/pilot-future",
    "/api/connectors/future",
    "/api/skills/future",
    "/api/admin/future",
    "/api/channels/future/future-tools",
    "/api/agents/future/future-secret",
    "/api/scout/threads/future/future-export",
    "/api/copilotkit/future",
    "/api/openduet/pages/future/future-export",
  ])
    owned.app.route(path, future);
  owned.app.all("/api/capabilities", async (context) => {
    futureDispatches++;
    const response = await fetch(
      `http://127.0.0.1:${sink.port}/synthetic-effect`,
    );
    return context.text(await response.text());
  });
});
beforeEach(() => {
  nativeSessionActive = true;
  membershipActive = true;
  ownerIsNativeAdmin = true;
  ownerTenant = "tenant-a";
  deploymentId = prefix;
  revision++;
  authDispatches = 0;
  futureDispatches = 0;
  futureNetworkRequests = 0;
  modelRequests = 0;
  runs = 0;
});
afterAll(async () => {
  try {
    await owned?.close();
    await sink?.stop(true);
    if (fixtureUsersCreated) {
      await database
        .delete(scoutModelCalls)
        .where(eq(scoutModelCalls.deploymentId, prefix));
      if (channelIds.length)
        await database.delete(channels).where(inArray(channels.id, channelIds));
      if (threadIds.length)
        await database
          .delete(scoutHistoryThreads)
          .where(inArray(scoutHistoryThreads.id, threadIds));
      await database
        .delete(users)
        .where(inArray(users.id, [owner, nativeAdmin]));
      await database.delete(agents).where(inArray(agents.id, agentIds));
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.tenantId, prefix));
      await database
        .delete(scoutResourceScopes)
        .where(eq(scoutResourceScopes.deploymentId, prefix));
    }
  } finally {
    await database.$client.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("actual owned pilot capability boundary", () => {
  test("the qualified UI bootstrap and native core reads remain available", async () => {
    for (const path of [
      "/health",
      "/api/capabilities",
      "/api/me",
      "/api/agents",
      "/api/agents/capabilities",
      `/api/agents/${botId}`,
      "/api/channels",
      "/api/settings/instructions",
      "/api/settings/preferences",
      "/api/openduet/pages",
      `/api/openduet/channels?bot=${botId}`,
      "/api/scout/threads",
      "/api/copilotkit/info",
    ])
      expect((await request(path)).status).toBe(200);
    expect(await (await request("/api/capabilities")).json()).toMatchObject({
      mode: "owned",
      durableHistory: true,
      serverTurns: false,
    });
    expect(await (await request("/api/agents/capabilities")).json()).toEqual({
      capabilities: { builtInAvailable: true, remoteAvailable: false },
    });
    expect(
      await (await request("/api/me", "GET", undefined, nativeAdmin)).json(),
    ).toMatchObject({ user: { id: nativeAdmin, role: "user" } });
    expect(futureDispatches).toBe(0);
    expect(futureNetworkRequests).toBe(0);
  });

  test("native built-in creation needs no connection probe and retains immutable scope without an automatic model grant", async () => {
    const modelPolicyFile = join(directory, "synthetic-built-in-policy.json");
    const modelPolicy = JSON.stringify({
      version: 1,
      deploymentId: prefix,
      globalMaxConcurrent: 1,
      globalMaxCallsPerDay: 10,
      memberships: [
        {
          userId: owner,
          tenantId: "tenant-a",
          revision: 1,
          active: true,
          expiresAt: "2099-01-01T00:00:00Z",
          agentIds: [botId],
          allowConversationContext: true,
          allowPersonalInstructions: false,
          route: {
            provider: "local",
            model: "synthetic-model",
            baseUrl: "http://127.0.0.1:1/v1",
          },
          limits: {
            maxInputBytes: 65536,
            maxOutputTokens: 32,
            maxOutputBytes: 4096,
            maxCallsPerRun: 1,
            maxCallsPerDay: 10,
            maxConcurrent: 1,
            timeoutMs: 3000,
          },
        },
      ],
    });
    await writeFile(modelPolicyFile, modelPolicy, { mode: 0o600 });
    const modeled = await createFixture(false, modelPolicyFile);
    const call = (
      path: string,
      method = "GET",
      body?: unknown,
      userId = owner,
    ) =>
      modeled.app.request(path, {
        method,
        headers: {
          "x-synthetic-session": userId,
          "content-type": "application/json",
          "x-tenant-id": "tenant-b",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const run = async (agentId: string) => {
      const minted = await call("/api/threads/mint", "POST", { agentId });
      expect(minted.status).toBe(200);
      const { threadId } = (await minted.json()) as { threadId: string };
      threadIds.push(threadId);
      const response = await call(
        `/api/copilotkit/agent/${agentId}/run`,
        "POST",
        input(threadId),
      );
      expect(response.status).toBe(200);
      return response.text();
    };
    const body = {
      name: "Synthetic owned Bot",
      title: "Fixture",
      roleDescription: "Synthetic instruction only.",
      visibility: "private",
      endpoint: "",
      tenantId: "tenant-b",
      ownerUserId: nativeAdmin,
    };
    try {
      // This composition uses the real protected model port rather than the CoreAgent test seam.
      expect(await run(botId)).toContain(marker);
      expect(modelRequests).toBe(1);
      const created = await call("/api/agents", "POST", body);
      expect(created.status).toBe(201);
      const { agent } = (await created.json()) as {
        agent: { id: string; builtIn: boolean };
      };
      agentIds.push(agent.id);
      expect(agent.builtIn).toBe(true);
      expect(modelRequests).toBe(1);
      expect(
        await database.select().from(agents).where(eq(agents.id, agent.id)),
      ).toMatchObject([
        {
          type: "built_in",
          packageId: null,
          configuration: { systemPrompt: body.roleDescription },
        },
      ]);
      const ownership = () =>
        database
          .select({
            deploymentId: scoutResourceScopes.deploymentId,
            tenantId: scoutResourceScopes.tenantId,
            scopeKind: scoutResourceScopes.scopeKind,
          })
          .from(scoutResourceScopes)
          .where(
            and(
              eq(scoutResourceScopes.resourceKind, "agent"),
              eq(scoutResourceScopes.resourceId, agent.id),
            ),
          );
      const originalScope = await ownership();
      expect(originalScope).toEqual([
        { deploymentId: prefix, tenantId: "tenant-a", scopeKind: "tenant" },
      ]);
      const restored = await call(`/api/agents/${agent.id}`);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({
        agent: { id: agent.id, builtIn: true },
      });
      expect(
        (await call(`/api/agents/${agent.id}`, "GET", undefined, nativeAdmin))
          .status,
      ).toBe(404);
      expect(
        (
          await call(`/api/agents/${agent.id}`, "PATCH", {
            ...body,
            visibility: "public",
          })
        ).status,
      ).toBe(200);
      // Public native visibility still intersects the immutable tenant grant.
      expect(
        (await call(`/api/agents/${agent.id}`, "GET", undefined, nativeAdmin))
          .status,
      ).toBe(404);
      const denied = await run(agent.id);
      // The public history stream masks the internal policy error and never reports completion.
      expect(denied).toContain('"type":"RUN_ERROR"');
      expect(denied).toContain('"code":"INCOMPLETE_STREAM"');
      expect(denied).not.toContain('"type":"RUN_FINISHED"');
      expect(denied).not.toContain(marker);
      expect(modelRequests).toBe(1);
      expect(await readFile(modelPolicyFile, "utf8")).toBe(modelPolicy);
      await expect(
        createModelPolicyReader(modelPolicyFile)({
          userId: owner,
          tenantId: "tenant-a",
          deploymentId: prefix,
          agentId: agent.id,
        }),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(
        await database
          .select({ id: scoutModelCalls.id })
          .from(scoutModelCalls)
          .where(eq(scoutModelCalls.agentId, agent.id)),
      ).toHaveLength(0);
      ownerTenant = "tenant-b";
      revision++;
      expect((await call(`/api/agents/${agent.id}`)).status).toBe(404);
      expect(
        (await call(`/api/agents/${agent.id}`, "PATCH", body)).status,
      ).toBe(404);
      expect((await call(`/api/agents/${agent.id}`, "DELETE")).status).toBe(
        404,
      );
      expect(await ownership()).toEqual(originalScope);
      ownerTenant = "tenant-a";
      revision++;
      expect((await call(`/api/agents/${agent.id}`)).status).toBe(200);
      await unavailable("/api/agents/test-connection", "POST", {
        endpoint: "https://synthetic-agent.fixture.invalid",
      });
      expect(futureDispatches).toBe(0);
      expect(futureNetworkRequests).toBe(0);
    } finally {
      await modeled.close();
    }
  });

  test("delegated drafts stay unavailable by default and opt-in preserves protected native admission", async () => {
    expect(await (await request("/api/capabilities")).json()).toMatchObject({
      delegatedDrafts: false,
    });
    await unavailable("/api/scout/tasks");
    await unavailable("/api/scout/tasks", "POST", {});
    await unavailable(`/api/scout/tasks/${randomUUID()}`, "POST", {});
    const enabled = await createFixture(true);
    try {
      const call = (path: string, method = "GET", body?: unknown) =>
        enabled.app.request(path, {
          method,
          headers: {
            "x-synthetic-session": owner,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      expect(await (await call("/api/capabilities")).json()).toMatchObject({
        delegatedDrafts: true,
      });
      expect((await call("/api/scout/tasks")).status).toBe(200);
      // Native membership cannot substitute for the separately read queue policy.
      await rm(join(directory, "synthetic-queue-policy.json"));
      expect((await call("/api/scout/tasks")).status).toBe(503);
      // Invalid input refuses before any MCP child or remote queue connection can be constructed.
      expect((await call("/api/scout/tasks", "POST", {})).status).toBe(400);
      expect(
        (await call(`/api/scout/tasks/${randomUUID()}`, "POST", {})).status,
      ).toBe(400);
      membershipActive = false;
      expect((await call("/api/scout/tasks")).status).toBe(403);
      expect(futureDispatches).toBe(0);
      expect(futureNetworkRequests).toBe(0);
    } finally {
      await enabled.close();
    }
  });

  test("native preferences and channel composition still persist through qualified routes", async () => {
    expect(
      (
        await request("/api/settings/instructions", "PUT", {
          instructions: marker,
        })
      ).status,
    ).toBe(200);
    expect(await (await request("/api/settings/instructions")).json()).toEqual({
      instructions: marker,
    });
    expect(
      (await request("/api/me/onboarding", "POST", { step: 1 })).status,
    ).toBe(200);
    const channel = await createChannel();
    expect((await request(`/api/channels/${channel.id}`)).status).toBe(200);
    expect(
      (
        await request(`/api/channels/${channel.id}/pin`, "PUT", {
          pinned: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(`/api/channels/${channel.id}/read`, "PUT", {})).status,
    ).toBe(204);
    const firstDay = await request("/api/channels/first-day", "POST", {
      agentId: botId,
    });
    expect(firstDay.status).toBe(200);
    const started = (await firstDay.json()).start.channel as {
      id: string;
      threadId: string;
    };
    if (!channelIds.includes(started.id)) {
      channelIds.push(started.id);
      threadIds.push(started.threadId);
    }
    expect(
      (
        await request("/api/channels/first-day", "POST", {
          agentId: botId,
          greeting: "without_mail",
        })
      ).status,
    ).toBe(409);
    expect(
      await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(sql`${workItems.payload}->>'channelId' = ${started.id}`),
    ).toHaveLength(0);
    expect(futureDispatches).toBe(0);
    expect(futureNetworkRequests).toBe(0);
  });

  test("public SDK run and owned history readers retain their positive path", async () => {
    const minted = await request("/api/threads/mint", "POST", {
      agentId: botId,
    });
    expect(minted.status).toBe(200);
    const { threadId } = (await minted.json()) as { threadId: string };
    threadIds.push(threadId);
    expect(await (await request(`/api/threads/${threadId}`)).json()).toEqual({
      known: true,
    });
    const response = await request(
      `/api/copilotkit/agent/${botId}/run`,
      "POST",
      input(threadId),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(marker);
    expect(runs).toBe(1);
    const restored = await request(
      `/api/copilotkit/threads/${threadId}/messages?agentId=${botId}`,
    );
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain(marker);
    expect(
      (await request(`/api/scout/threads/${threadId}/messages`)).status,
    ).toBe(200);
    expect(
      (await request(`/api/scout/threads/${threadId}/events?after=0`)).status,
    ).toBe(200);
    expect(
      (await request(`/api/scout/model/${threadId}/receipts`)).status,
    ).toBe(200);
  });

  test("qualified uploads, conditional reads and draft withdrawal retain native authorization", async () => {
    const channel = await createChannel();
    const form = new FormData();
    form.set("file", new File([marker], "fixture.txt", { type: "text/plain" }));
    const uploaded = await owned.app.request(
      `/api/channels/${channel.id}/attachments`,
      { method: "POST", headers: { "x-synthetic-session": owner }, body: form },
    );
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    const file = await request(`/api/attachments/${id}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(marker);
    const head = await request(`/api/attachments/${id}`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(
      (
        await request(`/api/attachments/${id}`, "GET", undefined, owner, {
          "if-none-match": `"${id}"`,
        })
      ).status,
    ).toBe(304);
    expect((await request(`/api/attachments/${id}`, "DELETE")).status).toBe(
      204,
    );
  });

  test("allowed sign-in/session/sign-out and native protocol callbacks reach only the auth handler", async () => {
    for (const [method, path] of [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-in/sso"],
      ["POST", "/api/auth/sign-out"],
      ["GET", "/api/auth/sso/callback/synthetic-provider"],
      ["GET", "/api/auth/sso/saml2/sp/metadata"],
      ["POST", "/api/auth/sso/saml2/sp/acs/synthetic-provider"],
    ]) {
      const response = await request(
        path,
        method,
        method === "POST" ? {} : undefined,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("SYNTHETIC_AUTH_DISPATCHED");
    }
    expect(authDispatches).toBe(7);
    expect(futureDispatches).toBe(0);
    nativeSessionActive = false;
    expect((await request("/api/auth/sign-out", "POST", {})).status).toBe(200);
  });

  test("all seven SSO management routes retain exact platform-owner rather than native-admin authority", async () => {
    for (const [method, suffix] of [
      ["GET", "providers"],
      ["GET", "get-provider"],
      ["POST", "register"],
      ["POST", "update-provider"],
      ["POST", "delete-provider"],
      ["POST", "request-domain-verification"],
      ["POST", "verify-domain"],
    ]) {
      const path = `/api/auth/sso/${suffix}`;
      expect(
        (
          await request(
            path,
            method,
            method === "POST" ? {} : undefined,
            nativeAdmin,
          )
        ).status,
      ).toBe(403);
      expect(authDispatches).toBe(0);
      expect(
        (await request(path, method, method === "POST" ? {} : undefined))
          .status,
      ).toBe(200);
      expect(authDispatches).toBe(1);
      authDispatches = 0;
    }
    ownerIsNativeAdmin = false;
    expect((await request("/api/auth/sso/providers")).status).toBe(403);
    expect(authDispatches).toBe(0);
  });

  test("unknown currently unmounted features refuse instead of acquiring authority from native login", async () => {
    for (const path of [
      "/api/channels/morning-brief",
      "/api/memory",
      "/api/routines",
      "/api/plugins",
      "/api/skills",
      "/api/groups",
      "/api/team-bots",
      "/api/approvals",
      "/api/passwords",
      "/api/identity",
      "/api/demonstrations",
      "/api/proactive",
      "/api/openduet/tasks",
      "/api/openduet/setup",
      "/api/delivery/webhooks",
      "/api/admin/future",
    ])
      await unavailable(
        path,
        path === "/api/channels/morning-brief" ? "POST" : "GET",
        path === "/api/channels/morning-brief" ? { agentId: botId } : undefined,
      );
    expect(futureDispatches).toBe(0);
    expect(futureNetworkRequests).toBe(0);
    expect(authDispatches).toBe(0);
  });

  test("late-mounted future features cannot dispatch handlers or outbound calls under known or unknown prefixes", async () => {
    for (const path of [
      "/api",
      "/api/pilot-future",
      "/api/connectors/future",
      "/api/skills/future",
      "/api/admin/future",
      "/api/channels/future/future-tools",
      "/api/agents/future/future-secret",
      "/api/scout/threads/future/future-export",
      "/api/copilotkit/future",
      "/api/openduet/pages/future/future-export",
    ])
      for (const method of [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
      ])
        await unavailable(
          path,
          method,
          ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
        );
    expect(futureDispatches).toBe(0);
    expect(futureNetworkRequests).toBe(0);
  });

  test("unknown methods, encoded aliases and trailing variants cannot bypass closed dispatch", async () => {
    for (const path of [
      "/api/capabilities",
      "/api/me",
      "/api/agents",
      "/api/settings/instructions",
      "/api/auth/get-session",
      "/api/auth/sso/providers",
    ])
      await unavailable(path, "PROPFIND");
    for (const path of [
      "/api/capabilities/",
      "/api/%63apabilities",
      "/api/agents//future",
      "/api/agents/future/",
      "/api/agents/future%2ffuture-secret",
      "/api/copilotkit/info/",
      "/api/auth/%67et-session",
      "/api/auth/get-session/",
      "/api/auth/sso/%70roviders",
      "/api/auth/sso/providers/",
      "/api/auth/sso//providers",
      "/api/auth/sso/future",
    ])
      await unavailable(path);
    await unavailable("/api/capabilities", "PUT", {});
    await unavailable("/api/agents", "DELETE");
    await unavailable("/api/auth/sso/providers", "POST", {});
    await unavailable("/api/auth/sso/register", "GET");
    for (const path of [
      "/api/auth/get-access-token",
      "/api/auth/refresh-token",
      "/api/auth/list-accounts",
      "/api/auth/account-info",
      "/api/auth/link-social",
      "/api/auth/future-endpoint",
    ])
      for (const method of ["GET", "POST"])
        await unavailable(path, method, method === "POST" ? {} : undefined);
    expect(authDispatches).toBe(0);
    expect(futureDispatches).toBe(0);
    expect(futureNetworkRequests).toBe(0);
  });

  test("raw requests and real loopback HTTP reject encoded public-route aliases before Hono dispatch", async () => {
    const direct = await owned.app.fetch(
      new Request("http://127.0.0.1/api/%63apabilities"),
    );
    let received = 0;
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (incoming) => {
        received++;
        return owned.app.fetch(incoming);
      },
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${http.port}/api/%63apabilities`,
      );
      // Observe both transports before assertions so a failure cannot hide the HTTP evidence.
      expect({
        rawRequest: direct.status,
        realHttp: response.status,
        received,
      }).toEqual({ rawRequest: 503, realHttp: 503, received: 1 });
      expect(futureDispatches).toBe(0);
      expect(futureNetworkRequests).toBe(0);
    } finally {
      await http.stop(true);
    }
  });

  test("a qualified route remains tenant-bound after native-subject reassignment or membership revocation", async () => {
    const channel = await createChannel();
    expect(
      (
        await request("/api/settings/instructions", "PUT", {
          instructions: marker,
        })
      ).status,
    ).toBe(200);
    ownerTenant = "tenant-b";
    revision++;
    expect(
      (
        await request(`/api/channels/${channel.id}`, "GET", undefined, owner, {
          "x-tenant-id": "tenant-a",
          "x-user-id": owner,
        })
      ).status,
    ).toBe(404);
    expect(await (await request("/api/settings/instructions")).json()).toEqual({
      instructions: "",
    });
    expect(
      await (await request(`/api/threads/${channel.threadId}`)).json(),
    ).toEqual({ known: false });
    deploymentId = "synthetic-wrong-deployment";
    expect((await request("/api/admin/status")).status).toBe(403);
    expect((await request("/api/auth/sso/providers")).status).toBe(403);
    expect(authDispatches).toBe(0);
    deploymentId = prefix;
    membershipActive = false;
    expect((await request("/api/me")).status).toBe(403);
    expect((await request("/api/auth/sso/providers")).status).toBe(403);
    expect(authDispatches).toBe(0);
    expect(futureDispatches).toBe(0);
  });
});
