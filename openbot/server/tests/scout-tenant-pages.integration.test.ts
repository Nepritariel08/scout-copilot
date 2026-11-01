import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { type AuthService, createRoleRepository } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  openduetChannels,
  openduetPages,
  userRoles,
  users,
} from "../src/db/schema";
import { scoutResourceScopes } from "../src/db/schema/scout-scope";
import {
  ChannelRefusedError,
  createDuetChannelStore,
  DuetChannelNotFoundError,
} from "../src/openduet/channels";
import {
  createPageStore,
  type PageInput,
  PageNotFoundError,
} from "../src/openduet/pages";
import { createOwnedIdentity } from "../src/scout/owned/auth";
import { createTenantScope, type TenantScope } from "../src/scout/owned/scope";
import { type ScoutBinding, ScoutError } from "../src/scout/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `tenant-pages-${randomUUID()}`;
const deploymentId = prefix;
const tenantA = `${prefix}-a`;
const tenantB = `${prefix}-b`;
const ownerA = `${prefix}-owner-a`;
const teammate = `${prefix}-teammate`;
const ownerB = `${prefix}-owner-b`;
const botA = `${prefix}-bot-a`;
const botB = `${prefix}-bot-b`;
const privateBot = `${prefix}-private`;
const foreignPrivateBot = `${prefix}-foreign-private`;
const legacyBot = `${prefix}-legacy`;
const template = `${prefix}-template`;
const packageId = randomUUID();
const people = [ownerA, teammate, ownerB];
const bots = [botA, botB, privateBot, foreignPrivateBot, legacyBot, template];
const channelIds: string[] = [];
const memberships = new Map(
  people.map((id) => [
    id,
    { tenantId: id === ownerB ? tenantB : tenantA, revision: 1 },
  ]),
);
const scope = createTenantScope({
  deploymentId,
  async binding(actor): Promise<ScoutBinding> {
    const value = memberships.get(actor.id);
    if (!value) throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    return {
      userId: actor.id,
      tenantId: value.tenantId,
      deploymentId,
      fingerprint: `${value.tenantId}:${value.revision}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      command: ["fixture", "-m", "scout_queue.mcp_server"],
      cwd: "fixture",
      environment: {
        SCOUT_ODOO_URL: "https://fixture.invalid",
        SCOUT_ODOO_DB: "synthetic",
        SCOUT_ODOO_UID: "1",
        SCOUT_ODOO_COMPANY_IDS: "1",
        SCOUT_ODOO_KEY_FILE: "fixture",
      },
      identity: { database: "synthetic", uid: 1, companyIds: [1] },
    };
  },
});
const pages = createPageStore(database, scope);
const profiles = createAgentProfileStore(database, undefined, undefined, scope);
const native = createChannelStore(
  database,
  profiles,
  createThreadIdentity(prefix),
  undefined,
  scope,
);
const duet = createDuetChannelStore({ database, channels: native, scope });
const actor = (id: string): AgentActor => ({ id, role: "user" });
const body = (title = "Synthetic private plan"): PageInput => ({
  kind: "page",
  title,
  blocks: [
    {
      type: "checklist",
      items: [{ id: "one", text: "Synthetic item", checked: false }],
    },
  ],
});

const verifiedRequest = (person = ownerA) =>
  new Request("https://fixture.invalid/owned-run", {
    headers: {
      authorization: `Bearer fixture-${person === ownerA ? "owner-a" : "owner-b"}`,
    },
  });

/** Synthetic issuer validates fixed fixture sessions; public role/email headers confer no identity. */
function verifiedPageActor(
  platformOwnerIds: readonly string[],
  beforeRead?: (read: number) => Promise<boolean | undefined>,
) {
  let reads = 0;
  const nativeAuth: AuthService = {
    handler: () => new Response(null, { status: 404 }),
    api: {
      async getSession({ headers, query }) {
        expect(query?.disableCookieCache).toBe(true);
        if ((await beforeRead?.(++reads)) === false) return null;
        const token = headers.get("authorization");
        const id =
          token === "Bearer fixture-owner-a"
            ? ownerA
            : token === "Bearer fixture-owner-b"
              ? ownerB
              : null;
        return id ? { user: { id, email: `${id}@example.test` } } : null;
      },
    },
  };
  const identity = createOwnedIdentity({
    auth: nativeAuth,
    roles: createRoleRepository(database),
    scope,
    platformOwnerIds,
  });
  return async (request: Request): Promise<AgentActor | null> => {
    const session = await identity.auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    return session?.user.role
      ? { id: session.user.id, role: session.user.role }
      : null;
  };
}

async function channel(
  owner: string,
  botId: string,
  scoped = true,
  dressed = true,
) {
  const id = `${prefix}-channel-${randomUUID()}`;
  channelIds.push(id);
  await database.transaction(async (tx) => {
    await tx.insert(channels).values({
      id,
      name: "Synthetic workstream",
      description: "Synthetic purpose",
    });
    await tx
      .insert(channelMemberships)
      .values({ channelId: id, userId: owner });
    await tx.insert(channelAgents).values({ channelId: id, agentId: botId });
    await tx
      .insert(intelligenceChannelMappings)
      .values({ channelId: id, userId: owner, threadId: `${id}-thread` });
    if (dressed)
      await tx
        .insert(openduetChannels)
        .values({ channelId: id, icon: "mail", colour: "lavender" });
    if (scoped)
      await scope.stamp(tx, await scope.resolve(owner), "channel", id);
  });
  return id;
}

beforeAll(async () => {
  await database
    .insert(users)
    .values(people.map((id) => ({ id, email: `${id}@example.test` })));
  await database
    .insert(userRoles)
    .values([
      ...people.map((userId) => ({ userId, role: "user" as const })),
      { userId: ownerA, role: "admin" },
      { userId: ownerB, role: "admin" },
    ]);
  await database.insert(deploymentPackages).values({
    id: packageId,
    tenantId: prefix,
    sourcePath: "fixture",
    checksum: "synthetic",
  });
  await database.insert(agents).values(
    bots.map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
      ...(id === template ? { packageId } : {}),
    })),
  );
  await database.insert(agentProfiles).values(
    bots.map((id) => ({
      agentId: id,
      ownerUserId:
        id === privateBot ? teammate : id === foreignPrivateBot ? ownerB : null,
      title: "Synthetic",
      roleDescription: "Synthetic fixture",
      avatarSeed: id,
      visibility:
        id === privateBot || id === foreignPrivateBot
          ? ("private" as const)
          : ("public" as const),
    })),
  );
  await database.transaction(async (tx) => {
    await scope.stamp(tx, await scope.resolve(ownerA), "agent", botA);
    await scope.stamp(tx, await scope.resolve(ownerA), "agent", privateBot);
    await scope.stamp(tx, await scope.resolve(ownerB), "agent", botB);
    await scope.stamp(
      tx,
      await scope.resolve(ownerB),
      "agent",
      foreignPrivateBot,
    );
    await scope.seedTemplates(tx, prefix, [template]);
  });
});
beforeEach(() => {
  memberships.set(ownerA, { tenantId: tenantA, revision: 1 });
});
afterAll(async () => {
  if (channelIds.length)
    await database.delete(channels).where(inArray(channels.id, channelIds));
  await database.delete(users).where(inArray(users.id, people));
  await database.delete(agents).where(inArray(agents.id, bots));
  await database
    .delete(deploymentPackages)
    .where(eq(deploymentPackages.id, packageId));
  await database
    .delete(scoutResourceScopes)
    .where(eq(scoutResourceScopes.deploymentId, deploymentId));
  await database.$client.close();
});

test("owned pages combine native owner with immutable tenant scope, including account reassignment", async () => {
  const saved = await pages.save(ownerA, botA, body());
  const [stamp] = await database
    .select()
    .from(scoutResourceScopes)
    .where(eq(scoutResourceScopes.resourceId, saved.id));
  expect(stamp).toMatchObject({
    resourceKind: "page",
    deploymentId,
    tenantId: tenantA,
    scopeKind: "tenant",
  });
  expect((await pages.get(ownerA, saved.id)).id).toBe(saved.id);
  await expect(pages.get(teammate, saved.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  await expect(pages.get(ownerB, saved.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  memberships.set(ownerA, { tenantId: tenantB, revision: 2 });
  expect((await pages.list(ownerA)).some((p) => p.id === saved.id)).toBe(false);
  await expect(pages.get(ownerA, saved.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  await expect(
    pages.save(ownerA, botB, {
      ...body("Taken"),
      id: saved.id,
      expectedUpdatedAt: saved.updatedAt,
    }),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(
    pages.check(ownerA, saved.id, {
      block: 0,
      item: "one",
      checked: true,
      expectedChecklistRevision: saved.checklistRevision,
    }),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(pages.delete(ownerA, saved.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  const inB = await pages.save(ownerA, botB, body("New tenant"));
  memberships.set(ownerA, { tenantId: tenantA, revision: 3 });
  await expect(pages.get(ownerA, inB.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  expect((await pages.get(ownerA, saved.id)).title).toBe(saved.title);
});

test("owned pages refuse unscoped legacy rows and cannot adopt them by revision, check or deletion", async () => {
  const legacy = await createPageStore(database).save(
    ownerA,
    legacyBot,
    body("Legacy"),
  );
  expect((await pages.list(ownerA)).some((p) => p.id === legacy.id)).toBe(
    false,
  );
  await expect(pages.get(ownerA, legacy.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  await expect(
    pages.save(ownerA, botA, {
      ...body(),
      id: legacy.id,
      expectedUpdatedAt: legacy.updatedAt,
    }),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(
    pages.check(ownerA, legacy.id, {
      block: 0,
      item: "one",
      checked: true,
      expectedChecklistRevision: legacy.checklistRevision,
    }),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(pages.delete(ownerA, legacy.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  expect((await createPageStore(database).get(ownerA, legacy.id)).title).toBe(
    "Legacy",
  );
});

test("page references require tenant scope and native Bot visibility/channel membership; curated templates remain usable", async () => {
  const foreign = await channel(ownerB, botB);
  await database
    .insert(channelMemberships)
    .values({ channelId: foreign, userId: ownerA });
  const mine = await channel(ownerA, botA);
  const legacy = await channel(ownerA, botA, false);
  await expect(pages.save(ownerA, botB, body())).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  await expect(pages.save(ownerA, legacyBot, body())).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  await expect(pages.save(ownerA, privateBot, body())).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  await expect(
    pages.save(ownerA, botA, body(), foreign),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(pages.save(ownerA, botA, body(), legacy)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  const saved = await pages.save(ownerA, template, body("Curated"), mine);
  expect(saved.botId).toBe(template);
  const checked = await pages.check(ownerA, saved.id, {
    block: 0,
    item: "one",
    checked: true,
    expectedChecklistRevision: saved.checklistRevision,
  });
  expect(checked.content).toMatchObject({
    blocks: [{ type: "checklist", items: [{ id: "one", checked: true }] }],
  });
  const revised = await pages.save(
    ownerA,
    template,
    { ...body("Revised"), id: saved.id, expectedUpdatedAt: checked.updatedAt },
    mine,
  );
  expect(revised.title).toBe("Revised");
  await pages.delete(ownerA, saved.id);
  await expect(pages.get(ownerA, saved.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
});

test("page scope and page creation roll back together if membership changes before commit", async () => {
  let inserted = "";
  const changing: TenantScope = {
    ...scope,
    async stamp(tx, principal, kind, id) {
      await scope.stamp(tx, principal, kind, id);
      inserted = id;
      memberships.set(ownerA, { tenantId: tenantB, revision: 2 });
    },
  };
  await expect(
    createPageStore(database, changing).save(ownerA, botA, body()),
  ).rejects.toBeInstanceOf(ScoutError);
  expect(inserted).not.toBe("");
  expect(
    await database
      .select()
      .from(openduetPages)
      .where(eq(openduetPages.id, inserted)),
  ).toHaveLength(0);
  expect(
    await database
      .select()
      .from(scoutResourceScopes)
      .where(eq(scoutResourceScopes.resourceId, inserted)),
  ).toHaveLength(0);
});

test("Duet reads and mutations deny stale cross-tenant memberships/mappings and unscoped legacy channels", async () => {
  const mine = await channel(ownerA, botA);
  const foreign = await channel(ownerB, botB);
  const legacy = await channel(ownerA, botA, false);
  await database
    .insert(channelMemberships)
    .values({ channelId: foreign, userId: ownerA });
  await database.insert(intelligenceChannelMappings).values({
    channelId: foreign,
    userId: ownerA,
    threadId: `${foreign}-stale-owner-thread`,
  });
  expect((await duet.get(ownerA, mine)).id).toBe(mine);
  expect((await duet.list(ownerA, botA)).channels.map((c) => c.id)).toContain(
    mine,
  );
  for (const id of [foreign, legacy]) {
    await expect(duet.get(ownerA, id)).rejects.toBeInstanceOf(
      DuetChannelNotFoundError,
    );
    await expect(
      duet.update(ownerA, id, { name: "Taken" }),
    ).rejects.toBeInstanceOf(DuetChannelNotFoundError);
    await expect(duet.setArchived(ownerA, id, true)).rejects.toBeInstanceOf(
      DuetChannelNotFoundError,
    );
    await expect(duet.keep(ownerA, id)).rejects.toBeInstanceOf(
      DuetChannelNotFoundError,
    );
    expect(await duet.isChannel(ownerA, id)).toBe(false);
    expect(
      await duet.ofThread(
        ownerA,
        id === foreign ? `${foreign}-stale-owner-thread` : `${legacy}-thread`,
      ),
    ).toBeNull();
    expect(
      (await duet.list(ownerA, botA)).channels.some((c) => c.id === id),
    ).toBe(false);
  }
  const renamed = await duet.update(ownerA, mine, {
    name: "My revised workstream",
    purpose: "Scoped purpose",
  });
  expect(renamed.name).toBe("My revised workstream");
  expect(
    (await duet.setArchived(ownerA, mine, true)).archivedAt,
  ).not.toBeNull();
  expect((await duet.setArchived(ownerA, mine, false)).archivedAt).toBeNull();
  expect((await duet.keep(ownerA, mine)).id).toBe(mine);
});

test("Duet account reassignment and corrupted foreign-agent relationships cannot disclose channel summaries", async () => {
  const mine = await channel(ownerA, botA);
  memberships.set(ownerA, { tenantId: tenantB, revision: 2 });
  await expect(duet.get(ownerA, mine)).rejects.toBeInstanceOf(
    DuetChannelNotFoundError,
  );
  expect(await duet.ofThread(ownerA, `${mine}-thread`)).toBeNull();
  memberships.set(ownerA, { tenantId: tenantA, revision: 3 });
  await database
    .insert(channelAgents)
    .values({ channelId: mine, agentId: botB });
  await expect(duet.get(ownerA, mine)).rejects.toBeInstanceOf(
    DuetChannelNotFoundError,
  );
  expect(await duet.isChannel(ownerA, mine)).toBe(false);
  expect(await duet.ofThread(ownerA, `${mine}-thread`)).toBeNull();
});

test("Duet creation shares native channel transaction/scope and declines a foreign Bot", async () => {
  const made = await duet.create(actor(ownerA), {
    botId: botA,
    name: "Scoped creation",
    purpose: "Synthetic",
    icon: "mail",
    colour: "lavender",
  });
  channelIds.push(made.id);
  const [stamp] = await database
    .select()
    .from(scoutResourceScopes)
    .where(eq(scoutResourceScopes.resourceId, made.id));
  expect(stamp).toMatchObject({
    resourceKind: "channel",
    tenantId: tenantA,
    deploymentId,
  });
  expect(made.dressed).toBe(true);
  await expect(
    duet.create(actor(ownerA), {
      botId: botB,
      name: "Taken",
      purpose: "",
      icon: "mail",
      colour: "lavender",
    }),
  ).rejects.toThrow();
});

test("a lost current binding rolls back both native channel edits and Duet metadata", async () => {
  const mine = await channel(ownerA, botA);
  let checks = 0;
  const changing: TenantScope = {
    ...scope,
    async assertCurrent(principal) {
      await scope.assertCurrent(principal);
      if (++checks === 3) throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    },
  };
  const guarded = createDuetChannelStore({
    database,
    channels: native,
    scope: changing,
  });
  await expect(
    guarded.update(ownerA, mine, { name: "Must roll back", icon: "book" }),
  ).rejects.toBeInstanceOf(ScoutError);
  const [saved] = await database
    .select()
    .from(channels)
    .where(eq(channels.id, mine));
  const [look] = await database
    .select()
    .from(openduetChannels)
    .where(eq(openduetChannels.channelId, mine));
  expect(saved?.name).toBe("Synthetic workstream");
  expect(look?.icon).toBe("mail");
});

test("a fresh request-bound platform owner may reference same-tenant private Bots, with no page/channel ownership override", async () => {
  const privileged = createPageStore(database, {
    scope,
    actorForRequest: verifiedPageActor([ownerA]),
  });
  const request = verifiedRequest();
  expect(
    await profiles.get({ id: ownerA, role: "admin" }, privateBot),
  ).not.toBeNull();
  const mine = await channel(ownerA, botA);
  const saved = await privileged.save(
    ownerA,
    privateBot,
    body("Authorized private Bot"),
    mine,
    request,
  );
  expect(saved.botId).toBe(privateBot);
  expect((await pages.get(ownerA, saved.id)).id).toBe(saved.id);
  await expect(pages.get(teammate, saved.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
  const revised = await privileged.save(
    ownerA,
    privateBot,
    {
      ...body("Authorized revision"),
      id: saved.id,
      expectedUpdatedAt: saved.updatedAt,
    },
    mine,
    request,
  );
  expect(revised.title).toBe("Authorized revision");
  await expect(
    privileged.save(ownerA, foreignPrivateBot, body(), null, request),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  const unjoined = await channel(teammate, privateBot);
  await expect(
    privileged.save(ownerA, privateBot, body(), unjoined, request),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  const foreign = await channel(ownerB, botB);
  await database
    .insert(channelMemberships)
    .values({ channelId: foreign, userId: ownerA });
  await expect(
    privileged.save(ownerA, privateBot, body(), foreign, request),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(
    privileged.save(ownerB, foreignPrivateBot, body(), null, request),
  ).rejects.toBeInstanceOf(PageNotFoundError);
});

test("private Bot read grants reject native database admin alone, missing requests, forged claims and another subject", async () => {
  const ordinary = createPageStore(database, {
    scope,
    actorForRequest: verifiedPageActor([]),
  });
  await expect(
    ordinary.save(ownerA, privateBot, body(), null, verifiedRequest()),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  const privileged = createPageStore(database, {
    scope,
    actorForRequest: verifiedPageActor([ownerA]),
  });
  await expect(
    privileged.save(ownerA, privateBot, body()),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(
    pages.save(ownerA, privateBot, body(), null, verifiedRequest()),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  const forged = new Request("https://fixture.invalid/owned-run", {
    headers: {
      "x-role": "admin",
      "x-user": ownerA,
      "x-email": `${ownerA}@example.test`,
      "x-platform-owner": "true",
    },
  });
  await expect(
    privileged.save(ownerA, privateBot, body(), null, forged),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  await expect(
    privileged.save(ownerA, privateBot, body(), null, verifiedRequest(ownerB)),
  ).rejects.toBeInstanceOf(PageNotFoundError);
});

test("request/session or platform-owner role revocation before commit rolls back privileged page creation", async () => {
  const before = await database
    .select()
    .from(scoutResourceScopes)
    .where(eq(scoutResourceScopes.deploymentId, deploymentId));
  const count = (await pages.list(ownerA)).length;
  const sessionRevoked = createPageStore(database, {
    scope,
    actorForRequest: verifiedPageActor([ownerA], async (read) => read !== 2),
  });
  await expect(
    sessionRevoked.save(
      ownerA,
      privateBot,
      body("Revoked session"),
      null,
      verifiedRequest(),
    ),
  ).rejects.toBeInstanceOf(PageNotFoundError);
  const roleRevoked = createPageStore(database, {
    scope,
    actorForRequest: verifiedPageActor([ownerA], async (read) => {
      if (read === 2)
        await database.delete(userRoles).where(eq(userRoles.userId, ownerA));
      return undefined;
    }),
  });
  try {
    await expect(
      roleRevoked.save(
        ownerA,
        privateBot,
        body("Revoked role"),
        null,
        verifiedRequest(),
      ),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  } finally {
    await database
      .insert(userRoles)
      .values([
        { userId: ownerA, role: "admin" },
        { userId: ownerA, role: "user" },
      ])
      .onConflictDoNothing();
  }
  expect((await pages.list(ownerA)).length).toBe(count);
  expect(
    await database
      .select()
      .from(scoutResourceScopes)
      .where(eq(scoutResourceScopes.deploymentId, deploymentId)),
  ).toHaveLength(before.length);
});

test("missing and blank page ids cannot select, check, revise or delete another page in either composition", async () => {
  for (const store of [pages, createPageStore(database)]) {
    const first = await store.save(ownerA, botA, body("First unchanged"));
    const second = await store.save(ownerA, botA, body("Second unchanged"));
    const before = (await store.list(ownerA)).length;
    for (const id of ["", " ", "\t", undefined] as unknown as string[]) {
      await expect(store.get(ownerA, id)).rejects.toBeInstanceOf(
        PageNotFoundError,
      );
      await expect(
        store.check(ownerA, id, {
          block: 0,
          item: "one",
          checked: true,
          expectedChecklistRevision: first.checklistRevision,
        }),
      ).rejects.toBeInstanceOf(PageNotFoundError);
      await expect(store.delete(ownerA, id)).rejects.toBeInstanceOf(
        PageNotFoundError,
      );
      if (id !== undefined)
        await expect(
          store.save(ownerA, botA, {
            ...body("Must not revise"),
            id,
            expectedUpdatedAt: first.updatedAt,
          }),
        ).rejects.toBeInstanceOf(PageNotFoundError);
    }
    expect((await store.list(ownerA)).length).toBe(before);
    expect((await store.get(ownerA, first.id)).title).toBe("First unchanged");
    expect((await store.get(ownerA, second.id)).title).toBe("Second unchanged");
  }
});

test("missing and blank Duet channel ids/selectors never select an arbitrary channel or list", async () => {
  const mine = await channel(ownerA, botA);
  for (const store of [
    duet,
    createDuetChannelStore({ database, channels: native }),
  ]) {
    for (const id of ["", " ", "\t", undefined] as unknown as string[]) {
      await expect(store.get(ownerA, id)).rejects.toBeInstanceOf(
        DuetChannelNotFoundError,
      );
      await expect(store.list(ownerA, id)).rejects.toBeInstanceOf(
        ChannelRefusedError,
      );
      await expect(
        store.update(ownerA, id, { name: "Must not rename" }),
      ).rejects.toBeInstanceOf(DuetChannelNotFoundError);
      await expect(store.setArchived(ownerA, id, true)).rejects.toBeInstanceOf(
        DuetChannelNotFoundError,
      );
      await expect(store.keep(ownerA, id)).rejects.toBeInstanceOf(
        DuetChannelNotFoundError,
      );
    }
    expect((await store.get(ownerA, mine)).name).toBe("Synthetic workstream");
  }
});

test("page creation and revision retain native membership/profile locks until commit, while existing page ownership stays independent", async () => {
  const privileged = createPageStore(database, {
    scope,
    actorForRequest: verifiedPageActor([ownerA]),
  });
  const request = verifiedRequest();
  for (const phase of ["create", "revision"] as const) {
    const channelId = await channel(ownerA, privateBot);
    const previous =
      phase === "revision"
        ? await privileged.save(
            ownerA,
            privateBot,
            body("Prior revision"),
            channelId,
            request,
          )
        : undefined;
    let checked = false;
    const racing = createPageStore(database, {
      scope,
      actorForRequest: verifiedPageActor([ownerA], async (read) => {
        if (read !== 2) return undefined;
        // The page has already been inserted/updated, but its transaction has not committed yet.
        // NOWAIT makes the competing lock probe deterministic, without scheduler sleeps or timing claims.
        for (const resource of ["membership", "profile", "agent"] as const) {
          let failure: unknown;
          try {
            await database.transaction(async (tx) => {
              if (resource === "membership") {
                await tx
                  .select()
                  .from(channelMemberships)
                  .where(
                    and(
                      eq(channelMemberships.channelId, channelId),
                      eq(channelMemberships.userId, ownerA),
                    ),
                  )
                  .for("update", { noWait: true });
              } else if (resource === "profile") {
                await tx
                  .select()
                  .from(agentProfiles)
                  .where(eq(agentProfiles.agentId, privateBot))
                  .for("update", { noWait: true });
              } else {
                await tx
                  .select()
                  .from(agents)
                  .where(eq(agents.id, privateBot))
                  .for("update", { noWait: true });
              }
            });
          } catch (error) {
            failure = error;
          }
          const databaseError = failure as
            | {
                errno?: string;
                code?: string;
                cause?: { errno?: string; code?: string };
              }
            | undefined;
          expect(
            databaseError?.cause?.errno ??
              databaseError?.errno ??
              databaseError?.cause?.code ??
              databaseError?.code,
          ).toBe("55P03");
        }
        checked = true;
        return undefined;
      }),
    });
    const saved = await racing.save(
      ownerA,
      privateBot,
      {
        ...body(`Committed ${phase}`),
        ...(previous
          ? { id: previous.id, expectedUpdatedAt: previous.updatedAt }
          : {}),
      },
      channelId,
      request,
    );
    expect(checked).toBe(true);
    expect(saved.title).toBe(`Committed ${phase}`);
    const removed = await database.transaction(async (tx) => {
      const removed = await tx
        .delete(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, ownerA),
          ),
        )
        .returning({ id: channelMemberships.channelId });
      await tx
        .delete(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.channelId, channelId),
            eq(intelligenceChannelMappings.userId, ownerA),
          ),
        );
      return removed;
    });
    expect(removed).toHaveLength(1);
    await expect(
      privileged.save(
        ownerA,
        privateBot,
        {
          ...body("Must be refused after removal"),
          id: saved.id,
          expectedUpdatedAt: saved.updatedAt,
        },
        channelId,
        request,
      ),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    // Membership removal does not transfer or revoke the person's independently owned saved page.
    expect((await pages.get(ownerA, saved.id)).id).toBe(saved.id);
    const checkedPage = await pages.check(ownerA, saved.id, {
      block: 0,
      item: "one",
      checked: true,
      expectedChecklistRevision: saved.checklistRevision,
    });
    expect(checkedPage.content).toMatchObject({
      blocks: [{ type: "checklist", items: [{ id: "one", checked: true }] }],
    });
    await pages.delete(ownerA, saved.id);
    await expect(pages.get(ownerA, saved.id)).rejects.toBeInstanceOf(
      PageNotFoundError,
    );
  }
});
