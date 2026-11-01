import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "../src/channels/attachments";
import {
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase, type Database } from "../src/db/client";
import {
  agents,
  attachments,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { scoutResourceScopes } from "../src/db/schema/scout-scope";
import { createTenantScope, type TenantScope } from "../src/scout/owned/scope";
import { type ScoutBinding, ScoutError } from "../src/scout/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const deploymentId = `tenant-channels-${randomUUID()}`;
const state = new Map<
  string,
  { tenantId: string; revision: number; active: boolean }
>();
let alice: AgentActor;
let bob: AgentActor;
let colleague: AgentActor;
let scope: ReturnType<typeof createTenantScope>;
let profiles: ReturnType<typeof createAgentProfileStore>;
let store: ReturnType<typeof createChannelStore>;
const agentIds: string[] = [];
const channelIds: string[] = [];
const userIds: string[] = [];
const identity = createThreadIdentity(deploymentId);

beforeEach(async () => {
  for (const tenantId of ["a", "b", "a"]) {
    const id = `${deploymentId}-${randomUUID()}`;
    await database.insert(users).values({ id, email: `${id}@fixture.example` });
    userIds.push(id);
    state.set(id, { tenantId, revision: 1, active: true });
  }
  [alice, bob, colleague] = userIds
    .slice(-3)
    .map((id) => ({ id, role: "user" as const }));
  scope = createTenantScope({
    deploymentId,
    binding: async ({ id }) => {
      const entry = state.get(id);
      if (!entry?.active) throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
      return {
        userId: id,
        tenantId: entry.tenantId,
        deploymentId,
        fingerprint: `${entry.tenantId}:${entry.revision}`,
        command: ["synthetic", "-m", "scout_queue.mcp_server"],
        cwd: "/synthetic",
        environment: {
          SCOUT_ODOO_URL: "https://fixture.invalid",
          SCOUT_ODOO_DB: "synthetic",
          SCOUT_ODOO_UID: "1",
          SCOUT_ODOO_COMPANY_IDS: "1",
          SCOUT_ODOO_KEY_FILE: "/synthetic/unused",
        },
        identity: { database: "synthetic", uid: 1, companyIds: [1] },
      } satisfies ScoutBinding;
    },
  });
  profiles = createAgentProfileStore(database, undefined, undefined, scope);
  store = createChannelStore(database, profiles, identity, undefined, scope);
});
afterEach(async () => {
  // Immutable ownership deliberately survives ordinary resource deletion; only the fixture removes it.
  await database
    .delete(scoutResourceScopes)
    .where(eq(scoutResourceScopes.deploymentId, deploymentId));
  if (channelIds.length)
    await database
      .delete(workItems)
      .where(inArray(sql`${workItems.payload}->>'channelId'`, channelIds));
  if (channelIds.length)
    await database
      .delete(channels)
      .where(inArray(channels.id, channelIds.splice(0)));
  if (agentIds.length)
    await database.delete(agents).where(inArray(agents.id, agentIds.splice(0)));
  if (userIds.length)
    await database.delete(users).where(inArray(users.id, userIds.splice(0)));
  state.clear();
});
afterAll(async () => {
  await database.$client.close();
});

async function agent(actor = alice) {
  const row = await profiles.create(actor, {
    name: "Synthetic tenant agent",
    title: "Fixture",
    roleDescription: "Synthetic only",
    visibility: "public",
    systemPrompt: "Return a synthetic marker.",
  });
  agentIds.push(row.id);
  return row.id;
}
async function channel(actor = alice, agentId?: string) {
  const row = await store.create(actor, [agentId ?? (await agent(actor))]);
  channelIds.push(row.id);
  return row;
}
async function member(channelId: string, actor: AgentActor) {
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: actor.id })
    .onConflictDoNothing();
  await database
    .insert(intelligenceChannelMappings)
    .values({ channelId, userId: actor.id, threadId: identity.mint() })
    .onConflictDoNothing();
}
function app(actor: AgentActor, selectedScope: TenantScope = scope) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...actor, email: `${actor.id}@fixture.example` });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) =>
    context.json(
      { code: error instanceof ScoutError ? error.code : "ERROR" },
      error instanceof ScoutError ? error.status : 500,
    ),
  );
  app.route(
    "/api/channels",
    createChannelAttachmentRoutes(database, requireUser, selectedScope),
  );
  app.route(
    "/api/attachments",
    createAttachmentRoutes(database, requireUser, selectedScope),
  );
  return app;
}

/** Commit a real second-connection removal after the old authorization SELECT has completed. */
function afterAuthorizationRead(
  selected: (fields: Record<string, unknown>) => boolean,
  revoke: () => Promise<void>,
) {
  let fired = false;
  function intercepted<T extends object>(executor: T): T {
    return new Proxy(executor, {
      get(target, property) {
        const method = Reflect.get(target, property, target);
        if (property !== "select" || typeof method !== "function")
          return typeof method === "function" ? method.bind(target) : method;
        return (fields: Record<string, unknown>) => {
          const query = Reflect.apply(method, target, [fields]) as object;
          if (!selected(fields)) return query;
          function wrapped(query: object): object {
            return new Proxy(query, {
              get(target, property) {
                const method = Reflect.get(target, property, target);
                if (property === "then")
                  return (
                    resolve: (rows: unknown) => unknown,
                    reject: (error: unknown) => unknown,
                  ) => {
                    const pending = Reflect.apply(method, target, [
                      async (rows: unknown) => {
                        if (!fired && Array.isArray(rows) && rows.length) {
                          fired = true;
                          await revoke();
                        }
                        return rows;
                      },
                    ]) as PromiseLike<unknown>;
                    return pending.then(resolve, reject);
                  };
                return typeof method === "function"
                  ? (...args: unknown[]) => {
                      const result = Reflect.apply(
                        method,
                        target,
                        args,
                      ) as unknown;
                      return result && typeof result === "object"
                        ? wrapped(result)
                        : result;
                    }
                  : method;
              },
            });
          }
          return wrapped(query);
        };
      },
    });
  }
  const reader = intercepted(database);
  const raced = new Proxy(reader, {
    get(target, property) {
      if (property === "transaction")
        return (
          callback: Parameters<Database["transaction"]>[0],
          options: Parameters<Database["transaction"]>[1],
        ) =>
          database.transaction(
            (transaction) => callback(intercepted(transaction)),
            options,
          );
      return Reflect.get(target, property, target);
    },
  });
  return { database: raced, fired: () => fired };
}
async function upload(
  actor: AgentActor,
  channelId: string,
  selectedScope: TenantScope = scope,
) {
  const form = new FormData();
  form.set(
    "file",
    new File(["SYNTHETIC_TENANT_ATTACHMENT"], "fixture.txt", {
      type: "text/plain",
    }),
  );
  return app(actor, selectedScope).request(
    `/api/channels/${channelId}/attachments`,
    { method: "POST", body: form },
  );
}

describe("owned channel and attachment tenant isolation", () => {
  test("a successful claim retains its membership lock through the transactional work enqueue", async () => {
    const agentId = await agent();
    const own = await channel(alice, agentId);
    const observed = afterAuthorizationRead(
      (fields) => "channelId" in fields && Object.keys(fields).length === 1,
      async () => {
        let failure: unknown;
        try {
          await database.transaction(async (transaction) => {
            await transaction
              .select()
              .from(channelMemberships)
              .where(
                and(
                  eq(channelMemberships.channelId, own.id),
                  eq(channelMemberships.userId, alice.id),
                ),
              )
              .for("update", { noWait: true });
          });
        } catch (error) {
          failure = error;
        }
        const databaseError = failure as
          | {
              code?: string;
              errno?: string;
              cause?: { code?: string; errno?: string };
            }
          | undefined;
        expect(
          databaseError?.cause?.errno ??
            databaseError?.errno ??
            databaseError?.cause?.code ??
            databaseError?.code,
        ).toBe("55P03");
      },
    );
    const guarded = createChannelStore(
      observed.database,
      profiles,
      identity,
      undefined,
      scope,
    );
    expect(
      (
        await guarded.firstDay(
          alice,
          agentId,
          "SYNTHETIC_AUTHORIZED_GREETING",
          "2026-01-02",
        )
      ).claimed,
    ).toBe(true);
    expect(observed.fired()).toBe(true);
    expect(
      await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(sql`${workItems.payload}->>'channelId' = ${own.id}`),
    ).toHaveLength(1);
    // The grant lock is transaction-scoped: native removal succeeds immediately after commit.
    const removed = await database
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, own.id),
          eq(channelMemberships.userId, alice.id),
        ),
      )
      .returning({ id: channelMemberships.channelId });
    expect(removed).toHaveLength(1);
  });
  for (const kind of [
    "firstDay",
    "morningBrief",
    "softDelete",
    "recordActivity",
  ] as const) {
    test(`${kind} refuses a membership removal committed after its native authorization read`, async () => {
      const agentId = await agent();
      const own = await channel(alice, agentId);
      if (kind === "morningBrief")
        await database
          .update(channels)
          .set({ lastMessageAt: new Date("2026-01-01T00:00:00Z") })
          .where(eq(channels.id, own.id));
      const before = await scope.resolve(alice.id);
      const race = afterAuthorizationRead(
        (fields) =>
          kind === "softDelete"
            ? "packageId" in fields
            : kind === "recordActivity"
              ? "channelId" in fields && Object.keys(fields).length === 1
              : "threadId" in fields && "agentId" in fields,
        async () => {
          // Identical statements and order to the native group-store removeMember transaction.
          await database.transaction(async (transaction) => {
            await transaction
              .delete(channelMemberships)
              .where(
                and(
                  eq(channelMemberships.channelId, own.id),
                  eq(channelMemberships.userId, alice.id),
                ),
              );
            await transaction
              .delete(intelligenceChannelMappings)
              .where(
                and(
                  eq(intelligenceChannelMappings.channelId, own.id),
                  eq(intelligenceChannelMappings.userId, alice.id),
                ),
              );
          });
        },
      );
      const raced = createChannelStore(
        race.database,
        profiles,
        identity,
        undefined,
        scope,
      );
      const operation =
        kind === "firstDay"
          ? raced.firstDay(
              alice,
              agentId,
              "SYNTHETIC_REVOKED_GREETING",
              "2026-01-02",
            )
          : kind === "morningBrief"
            ? raced.morningBrief(
                alice,
                agentId,
                "2026-01-02",
                "SYNTHETIC_REVOKED_BRIEF",
              )
            : kind === "softDelete"
              ? raced.softDelete(alice, own.id)
              : raced.recordActivity(alice, own.id, {
                  text: "SYNTHETIC_REVOKED_ACTIVITY",
                  agentId: null,
                  at: new Date(),
                });
      await expect(operation).rejects.toBeInstanceOf(ChannelNotFoundError);
      expect(race.fired()).toBe(true);
      expect(await scope.resolve(alice.id)).toEqual(before);
      const [unchanged] = await database
        .select()
        .from(channels)
        .where(eq(channels.id, own.id));
      expect(unchanged?.deletedAt).toBeNull();
      expect(unchanged?.lastMessage).toBeNull();
      expect(unchanged?.firstDayStartedAt).toBeNull();
      expect(unchanged?.morningBriefOn).toBeNull();
      expect(
        await database
          .select({ key: workItems.key })
          .from(workItems)
          .where(sql`${workItems.payload}->>'channelId' = ${own.id}`),
      ).toHaveLength(0);
    });
  }
  test("new channels stamp their immutable tenant; direct never claims an old unscoped row", async () => {
    const agentId = await agent();
    const legacy = createChannelStore(
      database,
      createAgentProfileStore(database, undefined),
      identity,
    );
    const old = await legacy.create(alice, [agentId]);
    channelIds.push(old.id);
    expect(await store.get(alice, old.id)).toBeNull();
    expect((await store.list(alice)).channels).toHaveLength(0);
    const own = await store.direct(alice, agentId);
    channelIds.push(own.id);
    expect(own.id).not.toBe(old.id);
    const scopes = await database
      .select()
      .from(scoutResourceScopes)
      .where(
        and(
          eq(scoutResourceScopes.resourceKind, "channel"),
          inArray(scoutResourceScopes.resourceId, [old.id, own.id]),
        ),
      );
    expect(scopes.map((row) => [row.resourceId, row.tenantId])).toEqual([
      [own.id, "a"],
    ]);
    expect((await store.direct(alice, agentId)).id).toBe(own.id);
  });

  test("foreign membership does not expose a channel or consume a pagination slot", async () => {
    const own = await channel();
    const foreign = await channel(bob);
    await member(foreign.id, alice);
    expect(await store.get(alice, foreign.id)).toBeNull();
    const page = await store.list(alice, { limit: 1 });
    expect(page.channels.map((row) => row.id)).toEqual([own.id]);
    expect(page.nextCursor).toBeNull();
    for (const operation of [
      () => store.setPinned(alice, foreign.id, true),
      () => store.markRead(alice, foreign.id),
      () => store.softDelete(alice, foreign.id),
      () =>
        store.recordActivity(alice, foreign.id, {
          text: "FOREIGN_WRITE",
          agentId: null,
          at: new Date(),
        }),
      () => store.signalChannelBusy(alice, foreign.id, true),
    ])
      await expect(operation()).rejects.toBeInstanceOf(ChannelNotFoundError);
    const [untouched] = await database
      .select()
      .from(channels)
      .where(eq(channels.id, foreign.id));
    expect(untouched?.lastMessage).toBeNull();
    expect(untouched?.deletedAt).toBeNull();
  });

  test("foreign agents cannot be linked, including a damaged same-tenant channel roster", async () => {
    const foreignAgent = await agent(bob);
    await expect(store.create(alice, [foreignAgent])).rejects.toThrow();
    const own = await channel();
    await database.execute(
      sql`insert into channel_agents(channel_id, agent_id) values (${own.id}, ${foreignAgent})`,
    );
    expect(await store.get(alice, own.id)).toBeNull();
    expect((await store.list(alice)).channels).toHaveLength(0);
  });

  test("curated read templates can start a new tenant-owned channel without granting a foreign channel", async () => {
    const template = await agent(bob);
    const foreign = await channel(bob, template);
    // Fixture models the scope seeded from a curated package; it does not run the seed authority path.
    await database
      .update(scoutResourceScopes)
      .set({ tenantId: null, scopeKind: "template" })
      .where(
        and(
          eq(scoutResourceScopes.resourceKind, "agent"),
          eq(scoutResourceScopes.resourceId, template),
        ),
      );
    const own = await channel(alice, template);
    expect((await store.get(alice, own.id))?.agentIds).toEqual([template]);
    await member(foreign.id, alice);
    expect(await store.get(alice, foreign.id)).toBeNull();
    await store.setPinned(alice, own.id, true);
    expect(
      (await store.list(alice)).channels.map((row) => [row.id, row.pinned]),
    ).toEqual([[own.id, true]]);
  });

  test("same tenant still requires native channel membership and uploader rights", async () => {
    const own = await channel();
    expect(await store.get(colleague, own.id)).toBeNull();
    expect((await upload(colleague, own.id)).status).toBe(403);
    const posted = await upload(alice, own.id);
    expect(posted.status).toBe(201);
    const file = (await posted.json()) as { id: string };
    await member(own.id, colleague);
    expect(
      (await app(colleague).request(`/api/attachments/${file.id}`)).status,
    ).toBe(404);
    expect(
      (
        await app(colleague).request(`/api/attachments/${file.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    await markAttachmentsSent(
      database,
      { actorId: alice.id, threadId: own.threadId },
      [file.id],
      scope,
    );
    const response = await app(colleague).request(
      `/api/attachments/${file.id}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SYNTHETIC_TENANT_ATTACHMENT");
    expect(
      (
        await app(alice).request(`/api/attachments/${file.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
  });

  test("foreign attachments refuse upload, fetch, HEAD, 304, deletion and turn resolution", async () => {
    const foreign = await channel(bob);
    const posted = await upload(bob, foreign.id);
    expect(posted.status).toBe(201);
    const file = (await posted.json()) as { id: string };
    await markAttachmentsSent(
      database,
      { actorId: bob.id, threadId: foreign.threadId },
      [file.id],
      scope,
    );
    await member(foreign.id, alice);
    expect((await upload(alice, foreign.id)).status).toBe(403);
    for (const options of [
      {},
      { method: "HEAD" },
      { headers: { "if-none-match": `"${file.id}"` } },
      { method: "DELETE" },
    ])
      expect(
        (await app(alice).request(`/api/attachments/${file.id}`, options))
          .status,
      ).toBe(404);
    expect(
      await loadAttachmentForTurn(
        database,
        { actorId: alice.id, threadId: "unmapped-fixture" },
        file.id,
        scope,
      ),
    ).toBeNull();
    await expect(
      markAttachmentsSent(
        database,
        { actorId: alice.id, threadId: "unmapped-fixture" },
        [file.id],
        scope,
      ),
    ).rejects.toThrow();
  });

  test("reassigning a native subject never transfers old channel or attachment ownership", async () => {
    const own = await channel();
    const posted = await upload(alice, own.id);
    const file = (await posted.json()) as { id: string };
    state.set(alice.id, { tenantId: "b", revision: 2, active: true });
    expect(await store.get(alice, own.id)).toBeNull();
    expect((await store.list(alice)).channels).toHaveLength(0);
    expect(
      (await app(alice).request(`/api/attachments/${file.id}`)).status,
    ).toBe(404);
    const replacement = await channel(alice);
    const [stamp] = await database
      .select()
      .from(scoutResourceScopes)
      .where(eq(scoutResourceScopes.resourceId, replacement.id));
    expect(stamp?.tenantId).toBe("b");
  });

  test("binding revocation during channel provisioning rolls back channel, mapping and scope", async () => {
    const agentId = await agent();
    let createdId = "";
    const racing = createChannelStore(
      database,
      profiles,
      identity,
      async (_transaction, input) => {
        createdId = input.channelId;
        state.get(alice.id)!.active = false;
      },
      scope,
    );
    await expect(racing.create(alice, [agentId])).rejects.toThrow();
    expect(
      await database.select().from(channels).where(eq(channels.id, createdId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, createdId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(scoutResourceScopes)
        .where(eq(scoutResourceScopes.resourceId, createdId)),
    ).toHaveLength(0);
  });

  test("policy change before channel write commit rolls back preferences, activity, busy claims and deletion", async () => {
    const own = await channel();
    const revoked: TenantScope = {
      ...scope,
      async assertCurrent(principal) {
        state.get(alice.id)!.revision++;
        await scope.assertCurrent(principal);
      },
    };
    const racing = createChannelStore(
      database,
      profiles,
      identity,
      undefined,
      revoked,
    );
    for (const operation of [
      () => racing.setPinned(alice, own.id, true),
      () => racing.markRead(alice, own.id),
      () =>
        racing.recordActivity(alice, own.id, {
          text: "REVOKED_WRITE",
          agentId: null,
          at: new Date(),
        }),
      () => racing.signalBusy(own.threadId, true),
      () => racing.softDelete(alice, own.id),
    ])
      await expect(operation()).rejects.toThrow();
    const [row] = await database
      .select()
      .from(channels)
      .where(eq(channels.id, own.id));
    const [membership] = await database
      .select()
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, own.id),
          eq(channelMemberships.userId, alice.id),
        ),
      );
    expect(row?.lastMessage).toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.busyClaims).toEqual({});
    expect(membership?.pinnedAt).toBeNull();
    expect(membership?.lastReadAt).toBeNull();
  });

  test("upload policy change before commit rolls back bytes; read policy change discloses none", async () => {
    const own = await channel();
    let checks = 0;
    const racing: TenantScope = {
      ...scope,
      async assertCurrent(principal) {
        if (++checks === 2) state.get(alice.id)!.revision++;
        await scope.assertCurrent(principal);
      },
    };
    expect((await upload(alice, own.id, racing)).status).toBe(503);
    expect(
      await database
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.channelId, own.id)),
    ).toHaveLength(0);
    const posted = await upload(alice, own.id);
    const file = (await posted.json()) as { id: string };
    const revoked: TenantScope = {
      ...scope,
      async assertCurrent(principal) {
        state.get(alice.id)!.revision++;
        await scope.assertCurrent(principal);
      },
    };
    const refused = await app(alice, revoked).request(
      `/api/attachments/${file.id}`,
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("SYNTHETIC_TENANT_ATTACHMENT");
  });
});
