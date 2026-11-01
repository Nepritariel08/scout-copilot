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
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { scoutHistoryThreads } from "../src/db/schema/scout-history";
import { parseScoutBinding } from "../src/scout/binding";
import { createOwnedApplication } from "../src/scout/owned/application";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `owned-${randomUUID()}`;
const alice = `${prefix}-alice`,
  bob = `${prefix}-bob`,
  outsider = `${prefix}-outsider`;
const agentId = `${prefix}-agent`;
let fixtureDirectory = "";
let owned: Awaited<ReturnType<typeof createOwnedApplication>>;
let active = true;
let invocations = 0;
let issuedFresh = true;
let changingPolicy = false;
let policyReads = 0;
const member = (userId: string, tenantId: string, uid: number) => ({
  userId,
  tenantId,
  policyRevision: 1,
  active: true,
  expiresAt: "2099-01-01T00:00:00Z",
  command: [process.execPath, "-m", "scout_queue.mcp_server"],
  cwd: resolve("."),
  environment: {
    SCOUT_ODOO_URL: "https://synthetic-odoo.fixture.example",
    SCOUT_ODOO_DB: "fixture_db",
    SCOUT_ODOO_UID: String(uid),
    SCOUT_ODOO_COMPANY_IDS: "1",
    SCOUT_ODOO_KEY_FILE: join(tmpdir(), "synthetic-unused-key"),
  },
});
const policy = () => ({
  version: 1,
  deploymentId: "fixture-owned",
  policies: ["tenant-a", "tenant-b"].map((tenantId) => ({
    tenantId,
    revision: 1,
    active,
    draftAnalysis: true,
    expiresAt: "2099-01-01T00:00:00Z",
  })),
  bindings: [member(alice, "tenant-a", 101), member(bob, "tenant-b", 102)],
});
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
beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "scout-owned-app-"));
  const files = {
    "brand.yaml": `tenant:\n  id: ${prefix}\n  product_name: Scout Synthetic\n`,
    "agents.yaml": `agents:\n  - id: ${agentId}\n    name: Scout Synthetic\n    title: Fixture\n    role_description: Synthetic qualification only.\n    avatar_seed: fixture\n    type: built-in\n    system_prompt: Return synthetic fixture output only.\n`,
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
    SCOUT_QUEUE_BINDINGS_FILE: join(fixtureDirectory, "synthetic-policy.json"),
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
    binding: async (actor) => {
      const value = parseScoutBinding(policy(), actor);
      return changingPolicy
        ? { ...value, fingerprint: String(++policyReads) }
        : value;
    },
    agents: async () => ({ [agentId]: new FixtureAgent() }),
  });
});
beforeEach(() => {
  active = true;
  invocations = 0;
  issuedFresh = true;
  changingPolicy = false;
  policyReads = 0;
});
afterAll(async () => {
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
          SCOUT_QUEUE_BINDINGS_FILE: policyFile,
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
