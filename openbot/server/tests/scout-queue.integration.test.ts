import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type AppVariables,
  type AuthenticatedActor,
  createRequireUser,
} from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { scoutQueueRequests, scoutQueueReviews } from "../src/db/schema/scout";
import { parseScoutBinding } from "../src/scout/binding";
import { createScoutRoutes } from "../src/scout/routes";
import { createScoutService, type ScoutTaskView } from "../src/scout/service";
import { createScoutStore, scoutDigest } from "../src/scout/store";
import { scoutFixtureConfig } from "./scout-binding.test";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { scoutMcpFixture } from "./support/scout-mcp";

const url = testDatabaseUrl();
const database = createDatabase(url, TEST_POOL);
const alice: AuthenticatedActor = {
  id: "scout-fixture-alice",
  email: "alice@synthetic.example",
  role: "user",
};
const bob: AuthenticatedActor = {
  id: "scout-fixture-bob",
  email: alice.email,
  role: "user",
};
let config = scoutFixtureConfig();
let remote = scoutMcpFixture();
let channels = new Set([alice.id, bob.id]);
const actors = new Map([
  [alice.id, alice],
  [bob.id, bob],
]);

function application(connection = database) {
  const service = createScoutService({
    store: createScoutStore(connection),
    binding: async (actor) => parseScoutBinding(config, actor),
    canReadChannel: async (actor, channelId) =>
      channels.has(actor.id) && channelId === `channel-${actor.id}`,
    connect: remote.connect,
  });
  // Real native authentication middleware; only the session authority is a fixture.
  const requireUser = createRequireUser(
    {
      handler: () => new Response(null),
      api: {
        getSession: async ({ headers }) => {
          const actor = actors.get(headers.get("x-synthetic-session") ?? "");
          return actor ? { user: actor } : null;
        },
      },
    },
    { rolesForUser: async () => ["user"] },
  );
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/scout/tasks", createScoutRoutes(service, requireUser));
  return app;
}
let app = application();
const payload = (overrides: Record<string, unknown> = {}) => ({
  sourceId: randomUUID(),
  channelId: `channel-${alice.id}`,
  title: "Synthetic draft",
  instructions: "Return a synthetic draft for review.",
  ...overrides,
});
async function request(
  path = "",
  body?: unknown,
  actor = alice.id,
  applicationUnderTest = app,
) {
  return applicationUnderTest.request(`/api/scout/tasks${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-synthetic-session": actor,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function task(response: Response): Promise<ScoutTaskView> {
  expect(response.status).toBe(200);
  return (await response.json()).task;
}
async function ready() {
  const submitted = await task(await request("", payload()));
  remote.finish();
  const draft = await task(
    await request(`/${submitted.id}`, { action: "refresh" }),
  );
  if (draft.revision === null)
    throw new Error("The fixture draft has no revision.");
  return { ...draft, revision: draft.revision };
}

beforeAll(async () => {
  // Dedicated fixture DB only; preserve unrelated schemas and records.
  await database.execute(
    sql`create table if not exists users (id text primary key, email text not null unique)`,
  );
  for (const actor of [alice, bob])
    await database.execute(
      sql`insert into users(id, email) values (${actor.id}, ${`${actor.id}@fixture.example`}) on conflict (id) do nothing`,
    );
  const migration = await readFile(
    new URL("../drizzle/0068_scout_queue_requester.sql", import.meta.url),
    "utf8",
  );
  const [existing] = await database.execute<{ relation: string | null }>(
    sql`select to_regclass('scout_queue_requests') as relation`,
  );
  if (!existing.relation)
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.execute(sql.raw(statement));
});
beforeEach(async () => {
  await remote.close();
  await database
    .delete(scoutQueueRequests)
    .where(eq(scoutQueueRequests.ownerUserId, alice.id));
  await database
    .delete(scoutQueueRequests)
    .where(eq(scoutQueueRequests.ownerUserId, bob.id));
  config = scoutFixtureConfig();
  config.policies.push({ ...config.policies[0], tenantId: "tenant-b" });
  const binding = structuredClone(config.bindings[0]);
  binding.userId = bob.id;
  binding.tenantId = "tenant-b";
  binding.environment.SCOUT_ODOO_UID = "12";
  config.bindings.push(binding);
  channels = new Set([alice.id, bob.id]);
  remote = scoutMcpFixture();
  app = application();
});
afterAll(async () => {
  await remote.close();
  await database.execute(
    sql`delete from users where id in (${alice.id}, ${bob.id})`,
  );
  await database.$client.close();
});

describe("native auth → durable PostgreSQL intent → real MCP SDK → receipt/review", () => {
  test("unauthenticated and unprovisioned users cannot reach the connector", async () => {
    expect((await request("", undefined, "unknown")).status).toBe(401);
    config.bindings = config.bindings.filter(
      (binding) => binding.userId !== bob.id,
    );
    expect(
      (await request("", payload({ channelId: `channel-${bob.id}` }), bob.id))
        .status,
    ).toBe(403);
    expect(remote.submitCalls).toBe(0);
  });
  test("caller-supplied user/tenant/UID and oversized context are refused intact", async () => {
    for (const extra of [
      { userId: bob.id },
      { tenantId: "tenant-b" },
      { uid: 12 },
      { instructions: "x".repeat(8001) },
    ])
      expect((await request("", payload(extra))).status).toBe(400);
    expect(remote.submitCalls).toBe(0);
  });
  test("one stable source key is one item, and changed payload cannot reuse it", async () => {
    const input = payload();
    const first = await task(await request("", input));
    const second = await task(await request("", input));
    expect(second.id).toBe(first.id);
    expect(remote.items.size).toBe(1);
    expect(remote.submitCalls).toBe(1);
    expect(
      (await request("", { ...input, instructions: "changed" })).status,
    ).toBe(409);
  });
  test("lost submit reply survives a new pool/service and recovers the exact original work", async () => {
    const input = payload();
    remote.lostSubmitReply = true;
    const failed = await request("", input);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("SYNTHETIC_SECRET");
    const tasks = (await (await request()).json()).tasks as ScoutTaskView[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].state).toBe("submission_unknown");
    const restarted = createDatabase(url, TEST_POOL);
    try {
      const recovered = await task(
        await request(
          `/${tasks[0].id}`,
          { action: "recover" },
          alice.id,
          application(restarted),
        ),
      );
      expect(recovered.workItemId).toBe(1);
      expect(remote.items.size).toBe(1);
      expect(remote.submitCalls).toBe(2);
      expect([...remote.items.keys()][0].length).toBeLessThanOrEqual(128);
    } finally {
      await restarted.$client.close();
    }
  });
  test("database operation lock refuses a concurrent duplicate while the first RPC is live", async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    remote.beforeSubmit = async () => {
      started();
      await blocked;
    };
    const input = payload();
    const first = request("", input);
    try {
      await entered;
      expect((await request("", input)).status).toBe(409);
      expect(remote.submitCalls).toBe(1);
    } finally {
      release();
    }
    await task(await first);
    expect(remote.items.size).toBe(1);
  });
  test("same-email users in different tenants cannot read guessed task IDs or origins", async () => {
    const first = await task(await request("", payload()));
    expect(
      (await request(`/${first.id}`, { action: "refresh" }, bob.id)).status,
    ).toBe(404);
    expect(
      (await request("", payload({ channelId: `channel-${alice.id}` }), bob.id))
        .status,
    ).toBe(404);
    expect((await (await request("", undefined, bob.id)).json()).tasks).toEqual(
      [],
    );
    expect(remote.items.size).toBe(1);
  });
  test("forged user, tenant and Odoo headers cannot override the authenticated account", async () => {
    const first = await task(await request("", payload()));
    const response = await app.request(`/api/scout/tasks/${first.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synthetic-session": bob.id,
        "x-user-id": alice.id,
        "x-tenant-id": "tenant-a",
        "x-odoo-uid": "11",
      },
      body: JSON.stringify({ action: "refresh" }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(first.title);
  });
  test("membership/channel revocation and a changed policy version fail closed", async () => {
    const first = await task(await request("", payload()));
    config.bindings[0].active = false;
    expect((await request(`/${first.id}`, { action: "refresh" })).status).toBe(
      403,
    );
    config.bindings[0].active = true;
    channels.delete(alice.id);
    expect((await request(`/${first.id}`, { action: "recover" })).status).toBe(
      404,
    );
    expect((await (await request()).json()).tasks).toEqual([]);
    channels.add(alice.id);
    config.bindings[0].policyRevision = config.policies[0].revision = 2;
    expect((await request(`/${first.id}`, { action: "recover" })).status).toBe(
      409,
    );
    expect(remote.submitCalls).toBe(1);
  });
  test("worker privileges or an expanded toolset prevent submission", async () => {
    remote.badIdentity = true;
    expect((await request("", payload())).status).toBe(503);
    remote.badIdentity = false;
    remote.extraTool = true;
    expect((await request("", payload())).status).toBe(503);
    remote.extraTool = false;
    remote.paginatedTools = true;
    expect((await request("", payload())).status).toBe(503);
    expect(remote.submitCalls).toBe(0);
  });
  test("draft acceptance records exact human review before the RPC, then reads it back", async () => {
    const draft = await ready();
    remote.beforeAccept = async () => {
      const reviews = await database
        .select()
        .from(scoutQueueReviews)
        .where(eq(scoutQueueReviews.requestId, draft.id));
      expect(reviews).toHaveLength(1);
      expect(reviews[0].revision).toBe(draft.revision);
      expect(reviews[0].draftDigest).toBe(scoutDigest(draft.result ?? ""));
    };
    const action = {
      action: "accept",
      revision: draft.revision,
      draftDigest: draft.draftDigest,
    };
    const accepted = await task(await request(`/${draft.id}`, action));
    expect(accepted.accepted).toBe(true);
    expect(accepted.state).toBe("completed");
    await task(await request(`/${draft.id}`, action));
    expect(remote.mutations).toEqual(["scout_accept_draft"]);
  });
  test("stale revision, changed draft and wrong receipt ownership cannot be accepted", async () => {
    const draft = await ready();
    const action = {
      action: "accept",
      revision: draft.revision,
      draftDigest: draft.draftDigest,
    };
    expect(
      (await request(`/${draft.id}`, { ...action, revision: 0 })).status,
    ).toBe(409);
    expect(
      (
        await request(`/${draft.id}`, {
          ...action,
          draftDigest: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    for (const item of remote.items.values())
      item.result = "Changed without a revision";
    expect((await request(`/${draft.id}`, action)).status).toBe(409);
    remote.wrongReceiptOwner = true;
    expect((await request(`/${draft.id}`, { action: "refresh" })).status).toBe(
      503,
    );
    expect(remote.mutations).toEqual([]);
  });
  test("lost acceptance reply is recovered by a read, without replaying acceptance", async () => {
    const draft = await ready();
    remote.lostAcceptReply = true;
    expect(
      (
        await request(`/${draft.id}`, {
          action: "accept",
          revision: draft.revision,
          draftDigest: draft.draftDigest,
        })
      ).status,
    ).toBe(503);
    const accepted = await task(
      await request(`/${draft.id}`, { action: "refresh" }),
    );
    expect(accepted.accepted).toBe(true);
    expect(remote.mutations).toEqual(["scout_accept_draft"]);
  });
  test("explicit cancellation is revision-bound and idempotent", async () => {
    const queued = await task(await request("", payload()));
    const action = { action: "cancel", revision: queued.revision };
    expect(
      (await request(`/${queued.id}`, { ...action, revision: 0 })).status,
    ).toBe(409);
    expect((await task(await request(`/${queued.id}`, action))).state).toBe(
      "cancelled",
    );
    await task(await request(`/${queued.id}`, action));
    expect(remote.mutations).toEqual(["scout_cancel_work"]);
  });
  test("revocation during a remote read withholds the draft response", async () => {
    const draft = await ready();
    remote.afterGet = () => {
      config.bindings[0].active = false;
    };
    const response = await request(`/${draft.id}`, { action: "refresh" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("SCOUT_SYNTHETIC_DRAFT_OK");
  });
  test("receipt revisions never move backwards", async () => {
    const draft = await ready();
    for (const item of remote.items.values()) item.revision = 0;
    expect((await request(`/${draft.id}`, { action: "refresh" })).status).toBe(
      503,
    );
    const [stored] = await database
      .select()
      .from(scoutQueueRequests)
      .where(
        and(
          eq(scoutQueueRequests.id, draft.id),
          eq(scoutQueueRequests.ownerUserId, alice.id),
        ),
      );
    expect(stored.receipt?.revision).toBe(draft.revision);
  });
});
