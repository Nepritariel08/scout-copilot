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
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq, inArray, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import { loadOwnedConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelMemberships,
  channels,
  deploymentPackages,
  userRoles,
  users,
  workItems,
} from "../src/db/schema";
import {
  scoutHistoryContext,
  scoutHistoryRuns,
  scoutHistoryThreads,
} from "../src/db/schema/scout-history";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedApplication } from "../src/scout/owned/application";
import { createModelPolicyReader } from "../src/scout/owned-model/policy";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `owned-${randomUUID()}`;
const alice = `${prefix}-alice`,
  bob = `${prefix}-bob`,
  outsider = `${prefix}-outsider`;
const agentId = `${prefix}-agent`;
const unapprovedAgentId = `${agentId}-unapproved`;
let fixtureDirectory = "";
let owned: Awaited<ReturnType<typeof createOwnedApplication>>;
let ownedWithGrants: Awaited<ReturnType<typeof createOwnedApplication>>;
let configuredOdooConfig: ReturnType<typeof loadOwnedConfig> | undefined;
let active = true;
let invocations = 0;
let odooFixtureCalls = 0;
let modelFixtureCalls = 0;
let beforeModelDispatch: (() => Promise<void>) | undefined;
let observedModelBodies: unknown[] = [];
let revokeOdooMapOnTaskRead = false;
let issuedFresh = true;
let changingPolicy = false;
let policyReads = 0;
let membershipRevision = 1;
let odooMapRevision = 1;
let changeMembershipOnLookup = false;
let changeOdooMapOnLookup = false;
let odooMapActive = true;
let customerOdooIdentity = false;
let customerCollaboration = true;
const member = (userId: string, tenantId: string) => ({
  userId,
  tenantId,
  revision: membershipRevision,
  policyRevision: 1,
  active: true,
  expiresAt: "2099-01-01T00:00:00Z",
});
const policy = () => ({
  version: 1,
  deploymentId: "fixture-owned",
  policies: ["tenant-a", "tenant-b"].map((tenantId) => ({
    tenantId,
    revision: 1,
    active,
    expiresAt: "2099-01-01T00:00:00Z",
  })),
  memberships: [member(alice, "tenant-a"), member(bob, "tenant-b")],
});
const odooPolicy = () => ({
  version: 1,
  deploymentId: "fixture-owned",
  sourceInstanceId: "fixture-odoo",
  bindings: [
    {
      userId: alice,
      tenantId: "tenant-a",
      revision: odooMapRevision,
      active: odooMapActive,
      expiresAt: "2099-01-01T00:00:00Z",
      sourceUid: 101,
      ...(customerOdooIdentity ? { identityClass: "customer" } : {}),
      companyIds: [1],
    },
  ],
});
const writeOdooPolicy = () =>
  writeFile(
    join(fixtureDirectory, "synthetic-odoo-bindings.json"),
    JSON.stringify(odooPolicy()),
    { mode: 0o600 },
  );
class FixtureAgent extends AbstractAgent {
  constructor() {
    super({ agentId });
  }
  run(input: RunAgentInput) {
    invocations++;
    return new Observable<BaseEvent>((subscriber) => {
      const messageId = randomUUID();
      for (const event of [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: "OWNED_APP_SYNTHETIC_OK",
        },
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
    { id: randomUUID(), role: "user", content: "Synthetic full-app request" },
  ],
});
function request(
  path: string,
  body?: unknown,
  userId = alice,
  extra: Record<string, string> = {},
) {
  return owned.app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-synthetic-session": userId,
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function releaseConsent() {
  const model = await createModelPolicyReader(
    join(fixtureDirectory, "synthetic-model-policy.json"),
  )({
    userId: alice,
    tenantId: "tenant-a",
    deploymentId: "fixture-owned",
    agentId,
  });
  return {
    agentId,
    consent: true,
    expectedProvider: model.route.provider,
    expectedModel: model.route.model,
    expectedPolicyFingerprint: model.fingerprint,
  };
}
function requestConfiguredGrant(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  userId = alice,
) {
  return ownedWithGrants.app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-synthetic-session": userId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "scout-owned-app-"));
  const files = {
    "brand.yaml": `tenant:\n  id: ${prefix}\n  product_name: Scout Synthetic\n`,
    "agents.yaml": `agents:\n  - id: ${agentId}\n    name: Scout Synthetic\n    title: Fixture\n    role_description: Synthetic qualification only.\n    avatar_seed: fixture\n    type: built-in\n    system_prompt: Return synthetic fixture output only.\n  - id: ${unapprovedAgentId}\n    name: Scout Synthetic Secondary\n    title: Fixture\n    role_description: Synthetic unapproved-profile qualification only.\n    avatar_seed: fixture-secondary\n    type: built-in\n    system_prompt: Return synthetic fixture output only.\n`,
    "channels.yaml": "channels: []\n",
    "knowledge.yaml": "sources: []\n",
    "model.yaml":
      "model:\n  provider: openai\n  credential_secret_ref: synthetic-unused\n  default_model: fixture-model\n",
  };
  await Promise.all(
    Object.entries(files).map(([name, text]) =>
      writeFile(join(fixtureDirectory, name), text),
    ),
  );
  for (const id of [alice, bob, outsider]) {
    await database.insert(users).values({ id, email: `${id}@fixture.example` });
    await database.insert(userRoles).values({ userId: id, role: "user" });
  }
  const config = loadOwnedConfig({
    DATABASE_URL: testDatabaseUrl(),
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
    SCOUT_RUNTIME_MODE: "owned",
    DEPLOYMENT_ID: "fixture-owned",
    OPENBOT_ORGANIZATION_AUTH_URL: "https://synthetic-identity.fixture.example",
    OPENBOT_HOST: "127.0.0.1",
    SCOUT_MEMBERSHIPS_FILE: join(fixtureDirectory, "synthetic-policy.json"),
    TENANT_PACKAGE_DIR: fixtureDirectory,
    OPENBOT_GENERATIVE_UI: "false",
    OPENBOT_SELF_HOST_BANNER: "false",
  });
  owned = await createOwnedApplication(config, database, {
    auth: {
      handler: () => new Response(null),
      api: {
        getSession: async ({ headers, query }) => {
          issuedFresh &&= query?.disableCookieCache === true;
          const id = headers.get("x-synthetic-session");
          return id && [alice, bob, outsider].includes(id)
            ? {
                user: {
                  id,
                  email: "same-native-email@fixture.example",
                  role: "user",
                },
              }
            : null;
        },
      },
    },
    membership: async (actor) => {
      const value = parseScoutMembership(policy(), actor, "fixture-owned");
      return changingPolicy
        ? { ...value, fingerprint: String(++policyReads) }
        : value;
    },
    agents: async () => ({ [agentId]: new FixtureAgent() }),
  });
  if (process.platform === "linux") {
    await writeOdooPolicy();
    await writeFile(
      join(fixtureDirectory, "synthetic-model-key"),
      "synthetic-owned-model-key",
      { mode: 0o600 },
    );
    const sourcePath = join(fixtureDirectory, "synthetic-odoo-source.json");
    const modelPath = join(fixtureDirectory, "synthetic-model-policy.json");
    await writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        sourceInstanceId: "fixture-odoo",
        baseUrl: "https://synthetic-odoo.fixture.example",
        database: "fixture_db",
      }),
    );
    await chmod(sourcePath, 0o600);
    await writeFile(
      modelPath,
      JSON.stringify({
        version: 1,
        deploymentId: "fixture-owned",
        globalMaxConcurrent: 2,
        globalMaxCallsPerDay: 100,
        bindings: [
          {
            userId: alice,
            tenantId: "tenant-a",
            active: true,
            revision: 1,
            expiresAt: "2099-01-01T00:00:00Z",
            agentIds: [agentId],
            allowConversationContext: true,
            allowPersonalInstructions: false,
            route: {
              provider: "openrouter",
              model: "fixture-model",
              apiKeyFile: join(fixtureDirectory, "synthetic-model-key"),
            },
            limits: {
              maxInputBytes: 8192,
              maxOutputTokens: 64,
              maxOutputBytes: 8192,
              maxCallsPerRun: 1,
              maxCallsPerDay: 10,
              maxConcurrent: 1,
              timeoutMs: 5000,
            },
          },
        ],
      }),
    );
    await chmod(modelPath, 0o600);
    const configured = loadOwnedConfig({
      DATABASE_URL: testDatabaseUrl(),
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
      SCOUT_RUNTIME_MODE: "owned",
      DEPLOYMENT_ID: "fixture-owned",
      OPENBOT_ORGANIZATION_AUTH_URL:
        "https://synthetic-identity.fixture.example",
      OPENBOT_HOST: "127.0.0.1",
      SCOUT_MEMBERSHIPS_FILE: join(fixtureDirectory, "synthetic-policy.json"),
      SCOUT_ODOO_CONTEXT_SOURCE_FILE: sourcePath,
      SCOUT_ODOO_BINDINGS_FILE: join(
        fixtureDirectory,
        "synthetic-odoo-bindings.json",
      ),
      SCOUT_MODEL_POLICY_FILE: modelPath,
      TENANT_PACKAGE_DIR: fixtureDirectory,
      OPENBOT_GENERATIVE_UI: "false",
      OPENBOT_SELF_HOST_BANNER: "false",
    });
    configuredOdooConfig = configured;
    ownedWithGrants = await createOwnedApplication(configured, database, {
      auth: {
        handler: () => new Response(null),
        api: {
          getSession: async ({ headers, query }) => {
            issuedFresh &&= query?.disableCookieCache === true;
            const id = headers.get("x-synthetic-session");
            return id && [alice, bob, outsider].includes(id)
              ? {
                  user: {
                    id,
                    email: "same-native-email@fixture.example",
                    role: "user",
                  },
                }
              : null;
          },
        },
      },
      membership: async (actor) => {
        const value = parseScoutMembership(policy(), actor, "fixture-owned");
        return changingPolicy
          ? { ...value, fingerprint: String(++policyReads) }
          : value;
      },
      modelFetch: Object.assign(
        async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          await beforeModelDispatch?.();
          observedModelBodies.push(JSON.parse(String(init?.body)));
          modelFixtureCalls++;
          const packets = [
            {
              id: "fixture",
              model: "fixture-reported",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "ODOO_MODEL_SYNTHETIC_OK",
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
            {
              id: "fixture",
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0 },
            },
          ];
          return new Response(
            `${packets.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        { preconnect: fetch.preconnect },
      ),
      odooFetch: Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          odooFixtureCalls++;
          const path = new URL(
            input instanceof Request ? input.url : String(input),
          ).pathname;
          if (path === "/json/2/res.users/context_get") {
            if (changeMembershipOnLookup) membershipRevision++;
            if (changeOdooMapOnLookup) {
              odooMapRevision++;
              await writeOdooPolicy();
            }
            return Response.json({ uid: 101 });
          }
          if (path === "/json/2/res.users/has_group") {
            // Only internal-user membership is true; the two administrator checks are false.
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              group_ext_id?: string;
            };
            return Response.json(
              body.group_ext_id ===
                (customerOdooIdentity
                  ? "base.group_portal"
                  : "base.group_user"),
            );
          }
          if (path === "/json/2/res.users/scout_own_identity_v1")
            return Response.json({
              contract: "scout-own-identity-v1",
              uid: 101,
              groups: {
                "base.group_portal": customerOdooIdentity,
                "base.group_user": !customerOdooIdentity,
                "base.group_system": false,
                "base.group_erp_manager": false,
              },
            });
          if (path === "/json/2/project.project/search_read")
            return Response.json(
              customerOdooIdentity && !customerCollaboration
                ? []
                : [{ id: 501, company_id: [1, "Fixture"] }],
            );
          if (path === "/json/2/project.task/search_read") {
            if (revokeOdooMapOnTaskRead) {
              odooMapActive = false;
              await writeOdooPolicy();
            }
            return Response.json([
              {
                id: 42,
                name: "Synthetic mapped task",
                stage_id: [9, "Fixture"],
                date_deadline: null,
                company_id: [1, "Fixture"],
              },
            ]);
          }
          return Response.json(
            { code: "UNEXPECTED_FIXTURE_REQUEST" },
            { status: 404 },
          );
        },
        { preconnect: fetch.preconnect },
      ),
    });
  }
});
beforeEach(async () => {
  active = true;
  invocations = 0;
  issuedFresh = true;
  changingPolicy = false;
  policyReads = 0;
  odooFixtureCalls = 0;
  modelFixtureCalls = 0;
  beforeModelDispatch = undefined;
  observedModelBodies = [];
  revokeOdooMapOnTaskRead = false;
  membershipRevision = 1;
  odooMapRevision = 1;
  changeMembershipOnLookup = false;
  changeOdooMapOnLookup = false;
  odooMapActive = true;
  customerOdooIdentity = false;
  customerCollaboration = true;
  if (process.platform === "linux" && fixtureDirectory) await writeOdooPolicy();
});
afterAll(async () => {
  await ownedWithGrants?.close();
  await owned?.close();
  const memberships = await database
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .where(inArray(channelMemberships.userId, [alice, bob, outsider]));
  for (const row of memberships)
    await database.delete(channels).where(eq(channels.id, row.id));
  await database.delete(users).where(inArray(users.id, [alice, bob, outsider]));
  await database.delete(agents).where(eq(agents.id, agentId));
  await database
    .delete(deploymentPackages)
    .where(eq(deploymentPackages.tenantId, prefix));
  await database.$client.close();
  if (
    fixtureDirectory &&
    dirname(fixtureDirectory) === tmpdir() &&
    basename(fixtureDirectory).startsWith("scout-owned-app-")
  )
    await rm(fixtureDirectory, { recursive: true, force: true });
});
describe("owned composition through the actual Scout app", () => {
  test("actual protected membership admits identity/channel/history/chat without queue configuration or credentials", async () => {
    const path = join(fixtureDirectory, "native-memberships-only.json");
    const value = policy();
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    const config = loadOwnedConfig({
      DATABASE_URL: testDatabaseUrl(),
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
      SCOUT_RUNTIME_MODE: "owned",
      DEPLOYMENT_ID: "fixture-owned",
      TENANT_PACKAGE_DIR: fixtureDirectory,
      OPENBOT_ORGANIZATION_AUTH_URL:
        "https://synthetic-identity.fixture.example",
      OPENBOT_HOST: "127.0.0.1",
      OPENBOT_GENERATIVE_UI: "false",
      SCOUT_MEMBERSHIPS_FILE: path,
    });
    expect(config.scoutQueueBindingsFile).toBeUndefined();
    expect(config.scoutDelegatedDraftsEnabled).toBe(false);
    expect(JSON.stringify(value)).not.toMatch(
      /command|SCOUT_ODOO|draftAnalysis/,
    );
    const standalone = await createOwnedApplication(config, database, {
      auth: {
        handler: () => new Response(null),
        api: {
          getSession: async () => ({
            user: {
              id: alice,
              email: `${alice}@fixture.example`,
              role: "user",
            },
          }),
        },
      },
      agents: async () => ({ [agentId]: new FixtureAgent() }),
    });
    try {
      const call = (path: string, body?: unknown) =>
        standalone.app.request(path, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      expect((await call("/api/me")).status).toBe(200);
      const channel = await standalone.channels.create(
        { id: alice, role: "user" },
        [agentId],
      );
      const response = await call(
        `/api/copilotkit/agent/${agentId}/run`,
        input(channel.threadId),
      );
      expect(await response.text()).toContain("OWNED_APP_SYNTHETIC_OK");
      const historyPath = `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${agentId}`;
      expect(await (await call(historyPath)).text()).toContain(
        "OWNED_APP_SYNTHETIC_OK",
      );
      expect((await call("/api/scout/tasks")).status).toBe(503);
      expect(
        (
          await call("/api/scout/odoo/context-grants", {
            apiKey: "synthetic-unused",
          })
        ).status,
      ).toBe(503);
      value.memberships[0].active = false;
      await writeFile(path, JSON.stringify(value));
      expect((await call(historyPath)).status).toBe(403);
      expect((await call("/api/agents")).status).toBe(403);
    } finally {
      await standalone.close();
    }
  });
  test("public capabilities expose owned durability without any vendor settings", async () => {
    const response = await request("/api/capabilities", undefined, "none");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "owned",
      durableHistory: true,
      serverTurns: false,
    });
  });
  test("the existing user composer creates a durable channel without queuing an automatic turn", async () => {
    const queued = () =>
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(workItems)
        .where(sql`${workItems.payload}->>'ownerUserId' = ${alice}`);
    const before = await queued();
    expect(
      (
        await request("/api/channels/first-day", {
          agentId,
          greeting: "without_mail",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request("/api/channels/morning-brief", { agentId })).status,
    ).toBe(503); // Unqualified automatic capability is refused before its native handler.
    const response = await request("/api/channels/first-day", { agentId });
    expect(response.status).toBe(200);
    const { start } = await response.json();
    expect(start.claimed).toBe(false);
    const [history] = await database
      .select()
      .from(scoutHistoryThreads)
      .where(eq(scoutHistoryThreads.id, start.channel.threadId));
    expect(history.channelId).toBe(start.channel.id);
    expect(await queued()).toEqual(before);
    expect(invocations).toBe(0);
  });
  test("a fresh public HTTP client reconstructs saved turns and an empty thread exposes no earlier data", async () => {
    const { threadId } = await (
      await request("/api/threads/mint", { agentId })
    ).json();
    const value = input(threadId);
    const response = await request(
      `/api/copilotkit/agent/${agentId}/run`,
      value,
    );
    expect(response.status).toBe(200);
    await response.text();
    const transport = (thread: string) =>
      new HttpAgent({
        agentId,
        threadId: thread,
        url: `http://localhost/api/copilotkit/agent/${agentId}/connect`,
        headers: { "x-synthetic-session": alice },
        fetch: async (url, init) => owned.app.fetch(new Request(url, init)),
      });
    const freshBrowser = transport(threadId);
    await freshBrowser.runAgent({ runId: randomUUID() });
    expect(freshBrowser.messages.at(-1)?.content).toBe(
      "OWNED_APP_SYNTHETIC_OK",
    );
    expect(invocations).toBe(1);
    const { threadId: empty } = await (
      await request("/api/threads/mint", { agentId })
    ).json();
    const switched = transport(empty);
    await switched.runAgent({ runId: randomUUID() });
    expect(switched.messages).toEqual([]);
    expect(switched.state).toEqual({});
    expect(invocations).toBe(1);
  });
  test("native sign-in and current tenant policy protect the whole app", async () => {
    for (const path of [
      "/api/agents",
      "/api/channels",
      "/api/copilotkit/info",
      "/api/settings/instructions",
    ])
      expect((await request(path, undefined, "no-session")).status).toBe(401);
    // Unqualified delegation is unavailable before identity or any requester handler runs.
    for (const actor of [alice, "no-session"])
      expect((await request("/api/scout/tasks", undefined, actor)).status).toBe(
        503,
      );
    expect((await request("/api/agents", undefined, outsider)).status).toBe(
      403,
    );
    expect((await request("/api/agents")).status).toBe(200);
    active = false;
    expect((await request("/api/agents")).status).toBe(403);
  });
  test("Odoo context endpoints fail closed while the source and model route are unconfigured", async () => {
    const secret = "synthetic-api-key-must-not-be-echoed";
    const write = await request("/api/scout/odoo/context-grants", {
      apiKey: secret,
    });
    expect(write.status).toBe(503);
    const writeBody = await write.text();
    expect(writeBody).toContain("MODEL_NOT_CONFIGURED");
    expect(writeBody).not.toContain(secret);

    const status = await request(
      `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(agentId)}`,
    );
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ code: "MODEL_NOT_CONFIGURED" });

    for (const method of ["POST", "DELETE"] as const) {
      const response = await owned.app.request(
        "/api/scout/odoo/context-grants/release",
        {
          method,
          headers: {
            "content-type": "application/json",
            "x-synthetic-session": alice,
          },
          body: JSON.stringify({ agentId, consent: true }),
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "MODEL_NOT_CONFIGURED",
      });
    }
  });
  test.skipIf(process.platform !== "linux")(
    "same configured app admits protected customer task context only after qualification and explicit release, and stops on collaboration withdrawal",
    async () => {
      customerOdooIdentity = true;
      await writeOdooPolicy();
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants",
            { apiKey: "synthetic-production-context-key" },
          )
        ).status,
      ).toBe(201);
      const selected = async () => {
        const minted = await requestConfiguredGrant(
          "POST",
          "/api/threads/mint",
          { agentId },
        );
        expect(minted.status).toBe(200);
        const { threadId } = await minted.json();
        return (
          await requestConfiguredGrant(
            "POST",
            `/api/copilotkit/agent/${agentId}/run`,
            {
              ...input(threadId),
              context: [{ description: "scout.project_task_id", value: "42" }],
            },
          )
        ).text();
      };
      expect(await selected()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(0);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants/release",
            await releaseConsent(),
          )
        ).status,
      ).toBe(201);
      expect(await selected()).toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(1);
      customerCollaboration = false;
      modelFixtureCalls = 0;
      expect(await selected()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(0);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "configured Odoo grant routes authorize by native user and profile, and revoke the scoped key",
    async () => {
      const statusPath = `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(agentId)}`;
      const deniedStatus = await requestConfiguredGrant(
        "GET",
        statusPath,
        undefined,
        outsider,
      );
      expect(deniedStatus.status).toBe(403);
      const deniedConsent = await requestConfiguredGrant(
        "POST",
        "/api/scout/odoo/context-grants/release",
        await releaseConsent(),
        outsider,
      );
      expect(deniedConsent.status).toBe(403);
      expect(odooFixtureCalls).toBe(0);

      const initial = await requestConfiguredGrant("GET", statusPath);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({
        provider: "openrouter",
        record: null,
        release: null,
        route: {
          provider: "openrouter",
          model: "fixture-model",
          policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      });
      const visibleProfiles = await requestConfiguredGrant(
        "GET",
        "/api/agents",
      );
      expect(visibleProfiles.status).toBe(200);
      expect(
        (await visibleProfiles.json()).agents.map(
          (profile: { id: string }) => profile.id,
        ),
      ).toContain(unapprovedAgentId);
      const deniedProfile = await requestConfiguredGrant(
        "GET",
        `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(unapprovedAgentId)}`,
      );
      expect(deniedProfile.status).toBe(403);

      const consent = await requestConfiguredGrant(
        "POST",
        "/api/scout/odoo/context-grants/release",
        await releaseConsent(),
      );
      expect(consent.status).toBe(201);
      const consentStatus = await requestConfiguredGrant("GET", statusPath);
      expect(await consentStatus.json()).toMatchObject({
        release: { active: true, provider: "openrouter" },
      });
      const withdrawn = await requestConfiguredGrant(
        "DELETE",
        "/api/scout/odoo/context-grants/release",
        { agentId },
      );
      expect(withdrawn.status).toBe(200);

      const apiKey = "synthetic-odoo-key-for-route-fixture";
      const grant = await requestConfiguredGrant(
        "POST",
        "/api/scout/odoo/context-grants",
        { apiKey },
      );
      expect(grant.status).toBe(201);
      const grantBody = await grant.json();
      expect(grantBody.projectCount).toBe(1);
      expect(JSON.stringify(grantBody)).not.toContain(apiKey);
      const grantedStatus = await requestConfiguredGrant("GET", statusPath);
      expect(await grantedStatus.json()).toMatchObject({
        record: { active: true, credentialStored: true, projectCount: 1 },
        release: { active: false },
      });

      const revoked = await requestConfiguredGrant(
        "DELETE",
        "/api/scout/odoo/context-grants",
      );
      expect(revoked.status).toBe(200);
      const revokedStatus = await requestConfiguredGrant("GET", statusPath);
      expect(await revokedStatus.json()).toMatchObject({
        record: { active: false, credentialStored: false },
        release: { active: false },
      });
    },
  );
  test.skipIf(process.platform !== "linux")(
    "configured key qualification rejects a tenant binding that changes during the Odoo lookup",
    async () => {
      const statusPath = `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(agentId)}`;
      const before = await requestConfiguredGrant("GET", statusPath);
      expect(before.status).toBe(200);
      const beforeStatus = await before.json();
      changeMembershipOnLookup = true;
      let response: Response;
      try {
        response = await requestConfiguredGrant(
          "POST",
          "/api/scout/odoo/context-grants",
          { apiKey: "synthetic-changing-binding-key" },
        );
      } finally {
        changeMembershipOnLookup = false;
        membershipRevision = 1;
      }
      expect(response.status).toBe(403);
      expect(odooFixtureCalls).toBeGreaterThan(0);

      const after = await requestConfiguredGrant("GET", statusPath);
      expect(await after.json()).toEqual(beforeStatus);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "revoking the independent Odoo mapping denies saved grant status, consent and use without revoking chat",
    async () => {
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants",
            { apiKey: "synthetic-revocation-key" },
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants/release",
            await releaseConsent(),
          )
        ).status,
      ).toBe(201);
      odooMapActive = false;
      await writeOdooPolicy();
      for (const [method, path, body] of [
        [
          "GET",
          `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(agentId)}`,
          undefined,
        ],
        [
          "POST",
          "/api/scout/odoo/context-grants/release",
          await releaseConsent(),
        ],
        [
          "POST",
          "/api/scout/odoo/context-grants",
          { apiKey: "synthetic-revoked-key" },
        ],
      ] as const)
        expect((await requestConfiguredGrant(method, path, body)).status).toBe(
          403,
        );
      expect((await requestConfiguredGrant("GET", "/api/agents")).status).toBe(
        200,
      );
      expect(
        (await requestConfiguredGrant("POST", "/api/threads/mint", { agentId }))
          .status,
      ).toBe(200);
      // Withdrawal remains possible after source admission is removed, and touches only own local authority.
      expect(
        (
          await requestConfiguredGrant(
            "DELETE",
            "/api/scout/odoo/context-grants/release",
            { agentId },
          )
        ).status,
      ).toBe(200);
      const revoked = await requestConfiguredGrant(
        "DELETE",
        "/api/scout/odoo/context-grants",
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        localCredentialRevoked: true,
        recordGrantRevoked: true,
      });
    },
  );
  test.skipIf(process.platform !== "linux")(
    "changing the Odoo mapping during key qualification cannot issue a grant against the earlier source identity",
    async () => {
      changeOdooMapOnLookup = true;
      const response = await requestConfiguredGrant(
        "POST",
        "/api/scout/odoo/context-grants",
        { apiKey: "synthetic-rotating-map-key" },
      );
      expect(response.status).toBe(403);
      expect(odooFixtureCalls).toBeGreaterThan(0);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "production saved Odoo grants support selected context and revoked or rotated mappings then prevent provider egress",
    async () => {
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants",
            { apiKey: "synthetic-production-context-key" },
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants/release",
            await releaseConsent(),
          )
        ).status,
      ).toBe(201);
      const selected = async () => {
        const minted = await requestConfiguredGrant(
          "POST",
          "/api/threads/mint",
          { agentId },
        );
        expect(minted.status).toBe(200);
        const { threadId } = await minted.json();
        const response = await requestConfiguredGrant(
          "POST",
          `/api/copilotkit/agent/${agentId}/run`,
          {
            ...input(threadId),
            context: [{ description: "scout.project_task_id", value: "42" }],
          },
        );
        return response.text();
      };
      expect(await selected()).toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(1);
      odooMapRevision++;
      await writeOdooPolicy();
      modelFixtureCalls = 0;
      expect(await selected()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(0);
      odooMapRevision--;
      odooMapActive = false;
      await writeOdooPolicy();
      expect(await selected()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(0);
      odooMapActive = true;
      await writeOdooPolicy();
      revokeOdooMapOnTaskRead = true;
      expect(await selected()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(0);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "contextual answer and ordinary continuation retain durable source authority for display, replay and later egress",
    async () => {
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants",
            { apiKey: "synthetic-history-context-key" },
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants/release",
            await releaseConsent(),
          )
        ).status,
      ).toBe(201);
      const { threadId } = await (
        await requestConfiguredGrant("POST", "/api/threads/mint", { agentId })
      ).json();
      beforeModelDispatch = async () => {
        const [marked] = await database
          .select()
          .from(scoutHistoryContext)
          .where(eq(scoutHistoryContext.threadId, threadId));
        expect(marked?.revision).toBe(1);
        expect(marked?.dependencies[0]?.recordId).toBe(42);
        const [run] = await database
          .select({ contextRevision: scoutHistoryRuns.contextRevision })
          .from(scoutHistoryRuns)
          .where(eq(scoutHistoryRuns.threadId, threadId))
          .orderBy(sql`${scoutHistoryRuns.startedAt} desc`)
          .limit(1);
        expect(run?.contextRevision).toBe(1);
        expect(JSON.stringify(marked)).not.toContain("Synthetic mapped task");
        expect(JSON.stringify(marked)).not.toContain(
          "synthetic-history-context-key",
        );
      };
      const selected = await requestConfiguredGrant(
        "POST",
        `/api/copilotkit/agent/${agentId}/run`,
        {
          ...input(threadId),
          context: [{ description: "scout.project_task_id", value: "42" }],
        },
      );
      expect(await selected.text()).toContain("ODOO_MODEL_SYNTHETIC_OK");
      const ordinary = await requestConfiguredGrant(
        "POST",
        `/api/copilotkit/agent/${agentId}/run`,
        input(threadId),
      );
      expect(await ordinary.text()).toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(2);
      expect(JSON.stringify(observedModelBodies.at(-1))).toContain(
        "ODOO_MODEL_SYNTHETIC_OK",
      );
      const messages = `/api/scout/threads/${threadId}/messages`;
      const replay = `/api/scout/threads/${threadId}/events`;
      expect((await requestConfiguredGrant("GET", messages)).status).toBe(200);
      expect(
        (await requestConfiguredGrant("GET", messages, undefined, bob)).ok,
      ).toBe(false);
      expect(
        (
          await requestConfiguredGrant(
            "DELETE",
            "/api/scout/odoo/context-grants/release",
            { agentId },
          )
        ).status,
      ).toBe(200);
      modelFixtureCalls = 0;
      for (const path of [
        messages,
        replay,
        `/api/copilotkit/threads/${threadId}/messages?agentId=${agentId}`,
        `/api/threads/${threadId}`,
      ]) {
        const response = await requestConfiguredGrant("GET", path);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      }
      const denied = await requestConfiguredGrant(
        "POST",
        `/api/copilotkit/agent/${agentId}/run`,
        input(threadId),
      );
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(modelFixtureCalls).toBe(0);
      // Source revocation closes only contextual history. A fresh source-free
      // conversation can still use the independently authorized model route.
      beforeModelDispatch = undefined;
      const { threadId: freshId } = await (
        await requestConfiguredGrant("POST", "/api/threads/mint", { agentId })
      ).json();
      odooFixtureCalls = 0;
      const fresh = await requestConfiguredGrant(
        "POST",
        `/api/copilotkit/agent/${agentId}/run`,
        input(freshId),
      );
      expect(await fresh.text()).toContain("ODOO_MODEL_SYNTHETIC_OK");
      expect(odooFixtureCalls).toBe(0);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "current Odoo mapping and native membership gate prior contextual answers without another task selection",
    async () => {
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants",
            { apiKey: "synthetic-source-continuation-key" },
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants/release",
            await releaseConsent(),
          )
        ).status,
      ).toBe(201);
      const { threadId } = await (
        await requestConfiguredGrant("POST", "/api/threads/mint", { agentId })
      ).json();
      expect(
        await (
          await requestConfiguredGrant(
            "POST",
            `/api/copilotkit/agent/${agentId}/run`,
            {
              ...input(threadId),
              context: [{ description: "scout.project_task_id", value: "42" }],
            },
          )
        ).text(),
      ).toContain("ODOO_MODEL_SYNTHETIC_OK");
      odooMapActive = false;
      await writeOdooPolicy();
      modelFixtureCalls = 0;
      expect(
        (
          await requestConfiguredGrant(
            "GET",
            `/api/scout/threads/${threadId}/messages`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            `/api/copilotkit/agent/${agentId}/run`,
            input(threadId),
          )
        ).status,
      ).toBe(403);
      expect(modelFixtureCalls).toBe(0);
      odooMapActive = true;
      await writeOdooPolicy();
      expect(
        (
          await requestConfiguredGrant(
            "GET",
            `/api/scout/threads/${threadId}/messages`,
          )
        ).status,
      ).toBe(200);
      membershipRevision++;
      expect(
        (
          await requestConfiguredGrant(
            "GET",
            `/api/scout/threads/${threadId}/messages`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            `/api/copilotkit/agent/${agentId}/run`,
            input(threadId),
          )
        ).status,
      ).toBe(403);
      expect(modelFixtureCalls).toBe(0);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "unknown legacy provenance and model-route changes cannot reuse contextual history",
    async () => {
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants",
            { apiKey: "synthetic-route-context-key" },
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            "/api/scout/odoo/context-grants/release",
            await releaseConsent(),
          )
        ).status,
      ).toBe(201);
      const { threadId } = await (
        await requestConfiguredGrant("POST", "/api/threads/mint", { agentId })
      ).json();
      expect(
        await (
          await requestConfiguredGrant(
            "POST",
            `/api/copilotkit/agent/${agentId}/run`,
            {
              ...input(threadId),
              context: [{ description: "scout.project_task_id", value: "42" }],
            },
          )
        ).text(),
      ).toContain("ODOO_MODEL_SYNTHETIC_OK");
      const path = join(fixtureDirectory, "synthetic-model-policy.json");
      const original = await readFile(path, "utf8");
      try {
        const changed = JSON.parse(original);
        changed.bindings[0].route.model = "different-synthetic-model";
        await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
        modelFixtureCalls = 0;
        expect(
          (
            await requestConfiguredGrant(
              "GET",
              `/api/scout/threads/${threadId}/messages`,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await requestConfiguredGrant(
              "POST",
              `/api/copilotkit/agent/${agentId}/run`,
              input(threadId),
            )
          ).status,
        ).toBe(403);
        expect(modelFixtureCalls).toBe(0);
      } finally {
        await writeFile(path, original, { mode: 0o600 });
      }
      expect(
        (
          await requestConfiguredGrant(
            "GET",
            `/api/scout/threads/${threadId}/messages`,
          )
        ).status,
      ).toBe(200);
      const [contextualThread] = await database
        .select()
        .from(scoutHistoryThreads)
        .where(eq(scoutHistoryThreads.id, threadId));
      if (!contextualThread)
        throw new Error("Expected synthetic contextual thread fixture");
      expect(JSON.stringify(contextualThread.snapshot)).toContain(
        "ODOO_MODEL_SYNTHETIC_OK",
      );
      // A pre-migration legacy row has saved content but never had a context marker.
      // Construct it directly; deleting a current marker would violate the reset guard.
      const legacyThreadId = randomUUID();
      await database.insert(scoutHistoryThreads).values({
        ...contextualThread,
        id: legacyThreadId,
      });
      expect(
        await database
          .select()
          .from(scoutHistoryContext)
          .where(eq(scoutHistoryContext.threadId, legacyThreadId)),
      ).toEqual([]);
      expect(
        (
          await requestConfiguredGrant(
            "GET",
            `/api/scout/threads/${legacyThreadId}/messages`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await requestConfiguredGrant(
            "POST",
            `/api/copilotkit/agent/${agentId}/run`,
            input(legacyThreadId),
          )
        ).status,
      ).toBe(403);
      expect(modelFixtureCalls).toBe(0);
    },
  );
  test.skipIf(process.platform !== "linux")(
    "configured Odoo admission still gates an injected context transport and missing mapping cannot bypass the production composition",
    async () => {
      if (!configuredOdooConfig)
        throw new Error("Linux source fixture was not configured");
      // This composition deliberately uses the production membership reader rather than
      // the mutable reader seam on ownedWithGrants. Supply its actual protected policy.
      await writeFile(
        configuredOdooConfig.scoutMembershipsFile,
        JSON.stringify(policy()),
        { mode: 0o600 },
      );
      for (const removeMapping of [false, true]) {
        odooMapActive = false;
        await writeOdooPolicy();
        let sourceReads = 0,
          providerCalls = 0;
        const composed = await createOwnedApplication(
          {
            ...configuredOdooConfig,
            ...(removeMapping ? { scoutOdooBindingsFile: undefined } : {}),
          },
          database,
          {
            auth: {
              handler: () => new Response(null),
              api: {
                getSession: async () => ({
                  user: {
                    id: alice,
                    email: `${alice}@fixture.example`,
                    role: "user",
                  },
                }),
              },
            },
            recordContext: {
              sourceInstanceId: "fixture-odoo",
              getGrant: async () => {
                sourceReads++;
                return null;
              },
              getReleaseGrant: async () => {
                sourceReads++;
                return null;
              },
              readProjectTask: async () => {
                sourceReads++;
                return [];
              },
            },
            modelFetch: Object.assign(
              async () => {
                providerCalls++;
                return new Response(null, { status: 500 });
              },
              { preconnect: fetch.preconnect },
            ),
          },
        );
        try {
          const call = (path: string, body: unknown) =>
            composed.app.request(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
          const minted = await call("/api/threads/mint", { agentId });
          expect(minted.status).toBe(200);
          const { threadId } = await minted.json();
          await (
            await call(`/api/copilotkit/agent/${agentId}/run`, {
              ...input(threadId),
              context: [{ description: "scout.project_task_id", value: "42" }],
            })
          ).text();
          expect(sourceReads).toBe(0);
          expect(providerCalls).toBe(0);
        } finally {
          await composed.close();
        }
      }
    },
  );
  test("direct chat server mint persists native ownership and rejects injected identity", async () => {
    expect(
      (await request("/api/threads/mint", { agentId, userId: bob })).status,
    ).toBe(400);
    const response = await request("/api/threads/mint", { agentId });
    expect(response.status).toBe(200);
    const { threadId } = await response.json();
    const [row] = await database
      .select()
      .from(scoutHistoryThreads)
      .where(eq(scoutHistoryThreads.id, threadId));
    expect(row.ownerUserId).toBe(alice);
    expect(row.tenantId).toBe("tenant-a");
    expect(
      (await (await request(`/api/threads/${threadId}`)).json()).known,
    ).toBe(true);
    expect(
      (await (await request(`/api/threads/${threadId}`, undefined, bob)).json())
        .known,
    ).toBe(false);
  });
  test("native channel creation commits its owned history on the same transaction", async () => {
    const channel = await owned.channels.create({ id: alice, role: "user" }, [
      agentId,
    ]);
    const [row] = await database
      .select()
      .from(scoutHistoryThreads)
      .where(eq(scoutHistoryThreads.id, channel.threadId));
    expect(row.channelId).toBe(channel.id);
    expect(row.ownerUserId).toBe(alice);
    const value = input(channel.threadId);
    const response = await request(
      `/api/copilotkit/agent/${agentId}/run`,
      value,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OWNED_APP_SYNTHETIC_OK");
    const restored = await request(
      `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${agentId}`,
    );
    expect((await restored.json()).messages.at(-1)?.content).toBe(
      "OWNED_APP_SYNTHETIC_OK",
    );
    const denied = await request(
      `/api/copilotkit/threads/${channel.threadId}/messages?agentId=${agentId}`,
      undefined,
      bob,
      { "x-user-id": alice, "x-tenant-id": "tenant-a" },
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("OWNED_APP_SYNTHETIC_OK");
    expect(invocations).toBe(1);
    expect(issuedFresh).toBe(true);
  });
  test("a policy changing during channel provisioning rolls back both channel and history", async () => {
    const inventory = async () => ({
      channels: await database
        .select({ id: channelMemberships.channelId })
        .from(channelMemberships)
        .where(eq(channelMemberships.userId, alice))
        .orderBy(channelMemberships.channelId),
      history: await database
        .select({ id: scoutHistoryThreads.id })
        .from(scoutHistoryThreads)
        .where(eq(scoutHistoryThreads.ownerUserId, alice))
        .orderBy(scoutHistoryThreads.id),
    });
    const before = await inventory();
    changingPolicy = true;
    await expect(
      owned.channels.create({ id: alice, role: "user" }, [agentId]),
    ).rejects.toThrow("SCOUT_ACCESS_DENIED");
    changingPolicy = false;
    expect(await inventory()).toEqual(before);
  });
  test("a guessed thread cannot reach an agent and cross-origin mutation is refused", async () => {
    const response = await request(
      `/api/copilotkit/agent/${agentId}/run`,
      input(randomUUID()),
    );
    expect(response.status).toBe(404);
    expect(invocations).toBe(0);
    expect(
      (
        await request("/api/threads/mint", { agentId }, alice, {
          origin: "https://foreign.fixture.example",
        })
      ).status,
    ).toBe(403);
  });
  test("the actual production entry restarts with local history and rejects an email-matched foreign subject", async () => {
    let verifiedId = alice;
    let revoked = false;
    const issuer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        req.headers.get("cookie") ===
          "better-auth.session_token=synthetic-owned-session" && !revoked
          ? Response.json({
              user: {
                id: verifiedId,
                email: `${alice}@fixture.example`,
                role: "user",
              },
            })
          : new Response(null, { status: 401 }),
    });
    const held = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null),
    });
    const port = held.port;
    held.stop(true);
    const policyFile = join(fixtureDirectory, "synthetic-process-policy.json");
    await writeFile(policyFile, JSON.stringify(policy()));
    await chmod(policyFile, 0o600);
    const { threadId } = await (
      await request("/api/threads/mint", { agentId })
    ).json();
    await (
      await request(`/api/copilotkit/agent/${agentId}/run`, input(threadId))
    ).text();
    const origin = `http://127.0.0.1:${port}`;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let drained: Promise<unknown>[] = [];
    let logs = "";
    async function stop() {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      if (child) await child.exited;
      await Promise.all(drained);
      child = undefined;
    }
    async function start() {
      child = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", "src/production-entry.ts"],
        cwd: resolve(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          DATABASE_URL: testDatabaseUrl(),
          KEY_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
          SCOUT_RUNTIME_MODE: "owned",
          DEPLOYMENT_ID: "fixture-owned",
          PORT: String(port),
          OPENBOT_HOST: "127.0.0.1",
          OPENBOT_ORGANIZATION_AUTH_URL: issuer.url.origin,
          SCOUT_MEMBERSHIPS_FILE: policyFile,
          TENANT_PACKAGE_DIR: fixtureDirectory,
          OPENBOT_GENERATIVE_UI: "false",
          COPILOTKIT_TELEMETRY_DISABLED: "true",
          DO_NOT_TRACK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      drained = [child.stdout, child.stderr].map(async (stream) => {
        if (typeof stream !== "number" && stream) {
          const text = await new Response(stream).text();
          logs = (logs + text).slice(-8000);
        }
      });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        const response = await fetch(`${origin}/api/capabilities`).catch(
          () => null,
        );
        if (response?.ok) return;
        await Bun.sleep(50);
      }
      await stop();
      throw new Error(`Owned production entry did not become ready: ${logs}`);
    }
    try {
      await start();
      expect((await fetch(`${origin}/api/agents`)).status).toBe(401);
      const handoff = await fetch(`${origin}/api/auth/organization/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          cookie: "better-auth.session_token=synthetic-owned-session",
        }),
      });
      expect(handoff.status).toBe(200);
      const { ticket } = await handoff.json();
      const consumed = await fetch(
        `${origin}/api/auth/organization/session?ticket=${encodeURIComponent(ticket)}`,
        { redirect: "manual" },
      );
      const cookie = consumed.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const headers = { cookie: cookie ?? "" };
      const path = `${origin}/api/copilotkit/threads/${threadId}/messages?agentId=${agentId}`;
      expect(
        (await (await fetch(path, { headers })).json()).messages.at(-1)
          ?.content,
      ).toBe("OWNED_APP_SYNTHETIC_OK");
      await stop();
      await start();
      expect(
        (await (await fetch(path, { headers })).json()).messages.at(-1)
          ?.content,
      ).toBe("OWNED_APP_SYNTHETIC_OK");
      verifiedId = outsider;
      const foreign = await fetch(path, { headers });
      expect(foreign.ok).toBe(false);
      expect(await foreign.text()).not.toContain("OWNED_APP_SYNTHETIC_OK");
      verifiedId = alice;
      revoked = true;
      expect((await fetch(path, { headers })).status).toBe(401);
    } finally {
      await stop();
      issuer.stop(true);
    }
  }, 60000);
});
