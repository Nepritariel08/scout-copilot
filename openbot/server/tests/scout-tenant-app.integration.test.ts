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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type ChannelActivityEvent,
  startChannelActivityListener,
} from "../src/channels/events";
import { loadOwnedConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelMemberships,
  channels,
  deploymentPackages,
  userRoles,
  users,
} from "../src/db/schema";
import { scoutResourceScopes } from "../src/db/schema/scout-scope";
import { createPageStore } from "../src/openduet/pages";
import { parseScoutBinding } from "../src/scout/binding";
import { createOwnedApplication } from "../src/scout/owned/application";
import { createTenantScope } from "../src/scout/owned/scope";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `tenant-app-${randomUUID()}`,
  alice = `${prefix}-alice`,
  bob = `${prefix}-bob`,
  agentId = `${prefix}-bot`;
let directory = "",
  owned: Awaited<ReturnType<typeof createOwnedApplication>>;
let revision = 1,
  active = true,
  sessions = true,
  ownerNativeAdmin = true,
  handlerCalls = 0;
let aliceTenant = "tenant-a";
let policyDeployment = prefix;
const createdAgents = [agentId];
const policy = () => ({
  version: 1,
  deploymentId: policyDeployment,
  policies: ["tenant-a", "tenant-b"].map((tenantId) => ({
    tenantId,
    revision,
    active,
    draftAnalysis: true,
    expiresAt: "2099-01-01T00:00:00Z",
  })),
  bindings: [alice, bob].map((userId, index) => ({
    userId,
    tenantId: index ? "tenant-b" : aliceTenant,
    policyRevision: revision,
    active: true,
    expiresAt: "2099-01-01T00:00:00Z",
    command: [process.execPath, "-m", "scout_queue.mcp_server"],
    cwd: resolve("."),
    environment: {
      SCOUT_ODOO_URL: "https://synthetic-odoo.fixture.example",
      SCOUT_ODOO_DB: "synthetic",
      SCOUT_ODOO_UID: String(index + 1),
      SCOUT_ODOO_COMPANY_IDS: "1",
      SCOUT_ODOO_KEY_FILE: join(directory, "unused-key"),
    },
  })),
});
const nativeRequest = (userId: string) =>
  new Request("http://127.0.0.1/synthetic", {
    headers: { "x-synthetic-session": userId },
  });
function request(path: string, userId = alice, method = "GET", body?: unknown) {
  return owned.app.request(path, {
    method,
    headers: {
      "x-synthetic-session": userId,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Synthetic event did not settle");
}
function event(channelId: string): ChannelActivityEvent {
  return {
    channelId,
    memberIds: [alice],
    lastMessage: "SYNTHETIC_EVENT",
    lastMessageAt: new Date().toISOString(),
    lastMessageAgentId: agentId,
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scout-tenant-app-"));
  const files = {
    "brand.yaml": `tenant:\n  id: ${prefix}\n  product_name: Scout Tenant Fixture\n`,
    "agents.yaml": `agents:\n  - id: ${agentId}\n    name: Scout Tenant Fixture\n    title: Fixture\n    role_description: Synthetic qualification.\n    avatar_seed: fixture\n    type: built-in\n    system_prompt: Synthetic text only.\n`,
    "channels.yaml": "channels: []\n",
    "knowledge.yaml": "sources: []\n",
    "model.yaml":
      "model:\n  provider: openai\n  credential_secret_ref: synthetic-unused\n  default_model: fixture-model\n",
  };
  await Promise.all(
    Object.entries(files).map(([name, text]) =>
      writeFile(join(directory, name), text),
    ),
  );
  for (const id of [alice, bob]) {
    await database.insert(users).values({ id, email: `${id}@fixture.example` });
    await database.insert(userRoles).values({ userId: id, role: "admin" });
  }
  owned = await createOwnedApplication(
    loadOwnedConfig({
      DATABASE_URL: testDatabaseUrl(),
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
      SCOUT_RUNTIME_MODE: "owned",
      DEPLOYMENT_ID: prefix,
      TENANT_PACKAGE_DIR: directory,
      OPENBOT_ORGANIZATION_AUTH_URL:
        "https://synthetic-identity.fixture.example",
      SCOUT_QUEUE_BINDINGS_FILE: join(directory, "unused-bindings"),
      SCOUT_PLATFORM_OWNER_IDS: alice,
      OPENBOT_HOST: "127.0.0.1",
      OPENBOT_GENERATIVE_UI: "false",
    }),
    database,
    {
      auth: {
        handler: () => {
          handlerCalls++;
          return new Response("SYNTHETIC_AUTH_OK");
        },
        api: {
          getSession: async ({ headers, query }) => {
            expect(query?.disableCookieCache).toBe(true);
            const id = headers.get("x-synthetic-session");
            return sessions && id && [alice, bob].includes(id)
              ? {
                  user: {
                    id,
                    email: `${id}@fixture.example`,
                    role: id === alice && !ownerNativeAdmin ? "user" : "admin",
                  },
                }
              : null;
          },
        },
      },
      binding: async (actor) => parseScoutBinding(policy(), actor),
    },
  );
});
beforeEach(() => {
  revision++;
  active = true;
  sessions = true;
  ownerNativeAdmin = true;
  handlerCalls = 0;
  aliceTenant = "tenant-a";
  policyDeployment = prefix;
});
afterAll(async () => {
  await owned?.close();
  const rows = await database
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .where(inArray(channelMemberships.userId, [alice, bob]));
  if (rows.length)
    await database.delete(channels).where(
      inArray(
        channels.id,
        rows.map((row) => row.id),
      ),
    );
  await database.delete(users).where(inArray(users.id, [alice, bob]));
  await database.delete(agents).where(inArray(agents.id, createdAgents));
  await database
    .delete(deploymentPackages)
    .where(eq(deploymentPackages.tenantId, prefix));
  await database
    .delete(scoutResourceScopes)
    .where(eq(scoutResourceScopes.deploymentId, prefix));
  await database.$client.close();
  await rm(directory, { recursive: true, force: true });
});

describe("actual owned app tenant and platform-owner boundaries", () => {
  test("raw native admins do not gain platform administration without exact owner configuration", async () => {
    expect((await request("/api/admin/status", alice)).status).toBe(200);
    expect((await request("/api/admin/status", bob)).status).toBe(403);
    expect(await (await request("/api/me", bob)).json()).toMatchObject({
      user: { role: "user" },
    });
    ownerNativeAdmin = false;
    expect((await request("/api/admin/status", alice)).status).toBe(403);
  });
  test("all installed SSO management endpoints require current platform-owner authority before handler dispatch", async () => {
    for (const [method, path] of [
      ["GET", "providers"],
      ["GET", "get-provider"],
      ["POST", "register"],
      ["POST", "update-provider"],
      ["POST", "delete-provider"],
      ["POST", "request-domain-verification"],
      ["POST", "verify-domain"],
    ]) {
      expect(
        (
          await request(
            `/api/auth/sso/${path}`,
            bob,
            method,
            method === "POST" ? {} : undefined,
          )
        ).status,
      ).toBe(403);
      expect(handlerCalls).toBe(0);
      expect(
        (
          await request(
            `/api/auth/sso/${path}`,
            alice,
            method,
            method === "POST" ? {} : undefined,
          )
        ).status,
      ).toBe(200);
      handlerCalls = 0;
    }
    active = false;
    expect((await request("/api/auth/sso/providers", alice)).status).toBe(403);
    expect(handlerCalls).toBe(0);
  });
  test("a valid native platform owner with a foreign deployment binding cannot reach administration or SSO management", async () => {
    policyDeployment = "synthetic-foreign-deployment";
    expect((await request("/api/admin/status", alice)).status).toBe(403);
    expect((await request("/api/admin/people", alice)).status).toBe(403);
    for (const [method, path] of [
      ["GET", "providers"],
      ["GET", "get-provider"],
      ["POST", "register"],
      ["POST", "update-provider"],
      ["POST", "delete-provider"],
      ["POST", "request-domain-verification"],
      ["POST", "verify-domain"],
    ])
      expect(
        (
          await request(
            `/api/auth/sso/${path}`,
            alice,
            method,
            method === "POST" ? {} : undefined,
          )
        ).status,
      ).toBe(403);
    expect(handlerCalls).toBe(0);
  });
  test("unadapted auth/remote routes refuse while protocol callbacks remain available", async () => {
    for (const path of [
      "/api/auth/admin/set-role",
      "/api/auth/scim/Users",
      "/api/auth/sso/future-management",
      "/api/auth/get-access-token",
      "/api/auth/refresh-token",
      "/api/auth/account-info",
      "/api/auth/list-accounts",
      "/api/auth/get-access-token/",
      "/api/auth/%67et-access-token",
      "/api/auth/sso/%72egister",
    ])
      expect((await request(path, alice, "POST", {})).status).toBe(503);
    expect(
      (
        await request("/api/agents/test-connection", bob, "POST", {
          endpoint: "https://unapproved.fixture.example",
        })
      ).status,
    ).toBe(503);
    expect(handlerCalls).toBe(0);
    expect((await request("/api/auth/sso/saml2/sp/metadata")).status).toBe(200);
    expect(
      (await request("/api/auth/sso/callback/synthetic-provider")).status,
    ).toBe(200);
    expect(handlerCalls).toBe(2);
  });
  test("tenant-public agents and copies stay scoped through actual HTTP routes, including platform-owner guessed IDs", async () => {
    const response = await request("/api/agents", bob, "POST", {
      name: "Synthetic tenant B public",
      title: "Fixture",
      roleDescription: "Synthetic isolation only",
      visibility: "public",
      endpoint: "https://agent.fixture.example/run",
    });
    expect(response.status).toBe(201);
    const { agent } = await response.json();
    createdAgents.push(agent.id);
    expect((await request(`/api/agents/${agent.id}`, bob)).status).toBe(200);
    expect((await request(`/api/agents/${agent.id}`, alice)).status).toBe(404);
    expect(await (await request("/api/agents", alice)).text()).not.toContain(
      "Synthetic tenant B public",
    );
    const copy = await request(
      `/api/agents/${agentId}/duplicate`,
      bob,
      "POST",
      {},
    );
    expect(copy.status).toBe(201);
    const copied = (await copy.json()).agent;
    createdAgents.push(copied.id);
    expect((await request(`/api/agents/${copied.id}`, alice)).status).toBe(404);
    expect((await request(`/api/agents/${agentId}`, bob)).status).toBe(200);
  });
  test("standing instructions are tenant-specific and never inherit the prior tenant after account reassignment", async () => {
    expect(
      (
        await request("/api/settings/instructions", alice, "PUT", {
          instructions: "TENANT_A_INSTRUCTION",
        })
      ).status,
    ).toBe(200);
    expect(await (await request("/api/settings/instructions")).json()).toEqual({
      instructions: "TENANT_A_INSTRUCTION",
    });
    aliceTenant = "tenant-b";
    revision++;
    expect(await (await request("/api/settings/instructions")).json()).toEqual({
      instructions: "",
    });
    await request("/api/settings/instructions", alice, "PUT", {
      instructions: "TENANT_B_INSTRUCTION",
    });
    aliceTenant = "tenant-a";
    revision++;
    expect(await (await request("/api/settings/instructions")).json()).toEqual({
      instructions: "TENANT_A_INSTRUCTION",
    });
  });
  test("empty page IDs cannot select or delete a different owned resource", async () => {
    const pages = createPageStore(database, owned.scope);
    const page = await pages.save(alice, agentId, {
      kind: "page",
      title: "Synthetic empty ID protection",
      blocks: [{ type: "text", text: "Synthetic private page" }],
    });
    await expect(pages.get(alice, "")).rejects.toThrow();
    await expect(pages.delete(alice, "")).rejects.toThrow();
    expect((await pages.get(alice, page.id)).title).toBe(
      "Synthetic empty ID protection",
    );
  });
  test("channel event delivery revalidates the captured native session and stops after expiry", async () => {
    const channel = await owned.channels.direct(
      { id: alice, role: "admin" },
      agentId,
    );
    const payloads: string[] = [];
    const detach = owned.channelEvents.register(
      alice,
      (payload) => payloads.push(payload),
      nativeRequest(alice),
    );
    try {
      owned.channelEvents.deliver(event(channel.id));
      await until(() => payloads.length === 1);
      sessions = false;
      owned.channelEvents.deliver(event(channel.id));
      await until(() => owned.channelEvents.connectionCount(alice) === 0);
      expect(payloads).toHaveLength(1);
    } finally {
      detach();
    }
  });
  test("reassignment during channel lookup cannot send the new tenant's event to the old socket", async () => {
    const channel = await owned.channels.direct(
      { id: bob, role: "user" },
      agentId,
    );
    await database
      .insert(channelMemberships)
      .values({ channelId: channel.id, userId: alice })
      .onConflictDoNothing();
    const payloads: string[] = [];
    const detach = owned.channelEvents.register(
      alice,
      (payload) => payloads.push(payload),
      nativeRequest(alice),
    );
    const original = owned.channels.get;
    owned.channels.get = async (...args) => {
      aliceTenant = "tenant-b";
      revision++;
      return original(...args);
    };
    try {
      owned.channelEvents.deliver(event(channel.id));
      await until(() => owned.channelEvents.connectionCount(alice) === 0);
      expect(payloads).toHaveLength(0);
    } finally {
      owned.channels.get = original;
      detach();
    }
  });
  test("reassignment during the last session lookup still refuses the captured socket", async () => {
    const channel = await owned.channels.direct(
      { id: alice, role: "admin" },
      agentId,
    );
    const payloads: string[] = [];
    const original = owned.authority.actor;
    let lookups = 0;
    owned.authority.actor = async (...args) => {
      const actor = await original(...args);
      if (++lookups === 3) {
        aliceTenant = "tenant-b";
        revision++;
      }
      return actor;
    };
    const detach = owned.channelEvents.register(
      alice,
      (payload) => payloads.push(payload),
      nativeRequest(alice),
    );
    try {
      owned.channelEvents.deliver(event(channel.id));
      await until(() => owned.channelEvents.connectionCount(alice) === 0);
      expect(lookups).toBe(3);
      expect(payloads).toHaveLength(0);
    } finally {
      owned.authority.actor = original;
      detach();
    }
  });
  test("deletion tombstones still reach current same-tenant members without restoring deleted channel reads", async () => {
    const channel = await owned.channels.direct(
      { id: alice, role: "admin" },
      agentId,
    );
    const payloads: string[] = [];
    const detach = owned.channelEvents.register(
      alice,
      (payload) => payloads.push(payload),
      nativeRequest(alice),
    );
    try {
      await owned.channels.softDelete({ id: alice, role: "admin" }, channel.id);
      expect(
        await owned.channels.get({ id: alice, role: "admin" }, channel.id),
      ).toBeNull();
      owned.channelEvents.deliver({
        ...event(channel.id),
        deleted: true,
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
      });
      await until(() => payloads.length === 1);
      expect(JSON.parse(payloads[0])).toMatchObject({
        channelId: channel.id,
        deleted: true,
        lastMessage: null,
      });
      aliceTenant = "tenant-b";
      revision++;
      owned.channelEvents.deliver({ ...event(channel.id), deleted: true });
      await until(() => owned.channelEvents.connectionCount(alice) === 0);
      expect(payloads).toHaveLength(1);
    } finally {
      detach();
    }
  });
  test("real PostgreSQL NOTIFY reaches only a freshly authorized connection", async () => {
    const channel = await owned.channels.direct(
      { id: alice, role: "admin" },
      agentId,
    );
    const payloads: string[] = [];
    const detach = owned.channelEvents.register(
      alice,
      (payload) => payloads.push(payload),
      nativeRequest(alice),
    );
    const listener = await startChannelActivityListener(
      testDatabaseUrl(),
      owned.channelEvents,
    );
    try {
      await database.execute(
        sql`select pg_notify('channel_activity', ${JSON.stringify(event(channel.id))})`,
      );
      await until(() => payloads.length === 1);
      active = false;
      await database.execute(
        sql`select pg_notify('channel_activity', ${JSON.stringify(event(channel.id))})`,
      );
      await until(() => owned.channelEvents.connectionCount(alice) === 0);
      expect(payloads).toHaveLength(1);
    } finally {
      detach();
      await listener.stop();
    }
  });
  test("an incorrect binding adapter cannot substitute another native subject", async () => {
    const scope = createTenantScope({
      deploymentId: prefix,
      binding: async () => parseScoutBinding(policy(), { id: bob }),
    });
    await expect(scope.resolve(alice)).rejects.toThrow("SCOUT_ACCESS_DENIED");
  });
});
