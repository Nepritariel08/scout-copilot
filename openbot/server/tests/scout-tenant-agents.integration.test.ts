import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { hashCallbackToken } from "../src/agents/callback-token";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor, CreateAgentInput } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { type CredentialSecretReader, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  deploymentPackages,
  users,
} from "../src/db/schema";
import { scoutResourceScopes } from "../src/db/schema/scout-scope";
import { createTenantScope, type TenantScope } from "../src/scout/owned/scope";
import type { ScoutBinding } from "../src/scout/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `tenant-agents-${randomUUID()}`;
const deploymentId = `${prefix}-deployment`;
const memberships = new Map<string, { tenantId: string; revision: number }>();
const userIds: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];
const packageIds: string[] = [];
const managedEndpoint = new URL("https://managed.example.test/ag-ui");
const scope = createTenantScope({
  deploymentId,
  binding: async (actor) => {
    const membership = memberships.get(actor.id);
    if (!membership) throw new Error("Membership denied");
    return {
      userId: actor.id,
      tenantId: membership.tenantId,
      deploymentId,
      fingerprint: `revision-${membership.revision}`,
      command: ["synthetic-python", "-m", "scout_queue.mcp_server"],
      cwd: "/synthetic",
      environment: {
        SCOUT_ODOO_URL: "https://synthetic.example.test",
        SCOUT_ODOO_DB: "synthetic",
        SCOUT_ODOO_UID: "1",
        SCOUT_ODOO_COMPANY_IDS: "1",
        SCOUT_ODOO_KEY_FILE: "/synthetic/key",
      },
      identity: { database: "synthetic", uid: 1, companyIds: [1] },
    } satisfies ScoutBinding;
  },
});
const store = createAgentProfileStore(
  database,
  managedEndpoint,
  undefined,
  scope,
);
const legacy = createAgentProfileStore(database, managedEndpoint);
const input: CreateAgentInput = {
  name: "Tenant helper",
  title: "Assistant",
  roleDescription: "Synthetic tenant instruction",
  visibility: "public",
};

afterEach(async () => {
  // Resource ownership is intentionally not cascaded away by the product's audit schema.
  await database
    .delete(scoutResourceScopes)
    .where(eq(scoutResourceScopes.deploymentId, deploymentId));
  if (channelIds.length)
    await database
      .delete(channels)
      .where(inArray(channels.id, channelIds.splice(0)));
  if (agentIds.length)
    await database.delete(agents).where(inArray(agents.id, agentIds.splice(0)));
  if (packageIds.length)
    await database
      .delete(deploymentPackages)
      .where(inArray(deploymentPackages.id, packageIds.splice(0)));
  if (userIds.length)
    await database.delete(users).where(inArray(users.id, userIds.splice(0)));
  memberships.clear();
});
afterAll(async () => {
  await database.$client.close();
});

async function person(tenantId: string, role: AgentActor["role"] = "user") {
  const id = `${prefix}-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Tenant fixture user" });
  userIds.push(id);
  memberships.set(id, { tenantId, revision: 1 });
  return { id, role } satisfies AgentActor;
}
async function create(
  actor: AgentActor,
  overrides: Partial<CreateAgentInput> = {},
) {
  const profile = await store.create(actor, { ...input, ...overrides });
  agentIds.push(profile.id);
  return profile;
}
async function historyChannel(
  actor: AgentActor,
  agentId: string,
  stampedFor: AgentActor | null = actor,
) {
  const id = `${prefix}-channel-${randomUUID()}`;
  await database.transaction(async (tx) => {
    await tx.insert(channels).values({
      id,
      name: "Synthetic history",
      description: "Tenant boundary fixture",
    });
    await tx.insert(channelAgents).values({ channelId: id, agentId });
    await tx
      .insert(channelMemberships)
      .values({ channelId: id, userId: actor.id });
    if (stampedFor)
      await scope.stamp(tx, await scope.resolve(stampedFor.id), "channel", id);
  });
  channelIds.push(id);
  return id;
}

describe("owned tenant agent SQL boundary", () => {
  test("stamps new agents atomically and combines tenant scope with native public/private access, even for admins", async () => {
    const owner = await person("alpha");
    const colleague = await person("alpha");
    const admin = await person("alpha", "admin");
    const foreignAdmin = await person("beta", "admin");
    const publicBot = await create(owner);
    const privateBot = await create(owner, { visibility: "private" });
    const [ownership] = await database
      .select()
      .from(scoutResourceScopes)
      .where(
        and(
          eq(scoutResourceScopes.resourceKind, "agent"),
          eq(scoutResourceScopes.resourceId, publicBot.id),
        ),
      );
    expect(ownership).toMatchObject({
      deploymentId,
      tenantId: "alpha",
      scopeKind: "tenant",
    });
    expect(await store.get(colleague, publicBot.id)).toMatchObject({
      id: publicBot.id,
    });
    expect(await store.get(colleague, privateBot.id)).toBeNull();
    expect(await store.get(admin, privateBot.id)).toMatchObject({
      id: privateBot.id,
    });
    expect(await store.get(foreignAdmin, publicBot.id)).toBeNull();
    expect(await store.list(foreignAdmin)).toEqual([]);
    expect(
      await database.transaction((tx) =>
        store.getWithin(tx, foreignAdmin, publicBot.id),
      ),
    ).toBeNull();
    await expect(
      store.update(colleague, publicBot.id, input),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    await store.update(admin, publicBot.id, {
      ...input,
      name: "Scoped admin edit",
    });
    expect(await store.get(owner, publicBot.id)).toMatchObject({
      name: "Scoped admin edit",
    });
  });

  test("foreign public ids cannot be copied, altered, deleted, credentialed, hidden or pinned", async () => {
    const owner = await person("alpha");
    const outsider = await person("beta", "admin");
    const profile = await create(owner);
    const token = await store.issueCallbackToken(owner, profile.id);
    for (const operation of [
      () =>
        store.update(outsider, profile.id, {
          ...input,
          name: "Foreign mutation",
        }),
      () => store.duplicate(outsider, profile.id),
      () => store.softDelete(outsider, profile.id),
      () => store.issueCallbackToken(outsider, profile.id),
      () => store.revokeCallbackToken(outsider, profile.id),
      () => store.setHidden(outsider, profile.id, true),
      () => store.setPinned(outsider, profile.id, true),
    ])
      await expect(operation()).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(
      await database
        .select()
        .from(agentPreferences)
        .where(eq(agentPreferences.userId, outsider.id)),
    ).toEqual([]);
    expect(
      await legacy.agentForCallbackToken(hashCallbackToken(token)),
    ).toEqual({ id: profile.id });
    // Owned callbacks need a qualified service assertion, not the machine bearer hash alone.
    expect(
      await store.agentForCallbackToken(hashCallbackToken(token)),
    ).toBeNull();
    await store.revokeCallbackToken(owner, profile.id);
    expect(
      await legacy.agentForCallbackToken(hashCallbackToken(token)),
    ).toBeNull();
    expect(await store.get(owner, profile.id)).toMatchObject({
      name: input.name,
      hasCallbackToken: false,
    });
  });

  test("curated deployment templates remain readable, customizable by copying, and personally pinnable without cross-tenant writes", async () => {
    const alpha = await person("alpha", "admin");
    const beta = await person("beta", "admin");
    const [pkg] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: "curated-package",
        sourcePath: "test/tenant-agents",
        checksum: randomUUID(),
      })
      .returning();
    if (!pkg) throw new Error("Package fixture missing");
    packageIds.push(pkg.id);
    const template = await legacy.create(alpha, input);
    agentIds.push(template.id);
    await database
      .update(agents)
      .set({
        packageId: pkg.id,
        type: "built_in",
        configuration: { systemPrompt: "Curated reusable instruction" },
      })
      .where(eq(agents.id, template.id));
    await database.transaction((tx) =>
      scope.seedTemplates(tx, "curated-package", [template.id]),
    );
    expect(await store.get(beta, template.id)).toMatchObject({
      systemOwned: true,
    });
    await store.setPinned(beta, template.id, true);
    await store.setHidden(beta, template.id, true);
    expect(await store.list(beta, true)).toContainEqual(
      expect.objectContaining({ id: template.id, pinned: true }),
    );
    expect(await store.list(alpha)).toContainEqual(
      expect.objectContaining({
        id: template.id,
        hidden: false,
        pinned: false,
      }),
    );
    await expect(store.update(beta, template.id, input)).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    await expect(store.softDelete(beta, template.id)).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    await expect(
      store.issueCallbackToken(beta, template.id),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    const copy = await store.duplicate(beta, template.id);
    agentIds.push(copy.id);
    expect(copy).toMatchObject({
      ownerUserId: beta.id,
      systemOwned: false,
      visibility: "private",
    });
    expect(await store.get(alpha, copy.id)).toBeNull();
    const [copiedRun] = await database
      .select({ configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, copy.id));
    expect(copiedRun?.configuration).toEqual({
      systemPrompt: "Curated reusable instruction",
    });
    expect(await store.get(beta, copy.id)).toMatchObject({ id: copy.id });
  });

  test("unscoped legacy resources and prior-tenant resources deny owned reads while the licensed composition stays unchanged", async () => {
    const owner = await person("alpha", "admin");
    const unscoped = await legacy.create(owner, input);
    agentIds.push(unscoped.id);
    const current = await create(owner);
    expect(await store.get(owner, unscoped.id)).toBeNull();
    expect(await legacy.get(owner, unscoped.id)).toMatchObject({
      id: unscoped.id,
    });
    memberships.set(owner.id, { tenantId: "beta", revision: 2 });
    expect(await store.get(owner, current.id)).toBeNull();
    expect(await store.list(owner)).toEqual([]);
    await expect(store.update(owner, current.id, input)).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
    expect(await legacy.get(owner, current.id)).toMatchObject({
      id: current.id,
    });
  });

  test("binding changes after scope stamping roll back both profile and immutable ownership", async () => {
    const owner = await person("alpha");
    const revoked: TenantScope = {
      ...scope,
      stamp: async (tx, principal, kind, id) => {
        await scope.stamp(tx, principal, kind, id);
        memberships.delete(owner.id);
      },
    };
    const guarded = createAgentProfileStore(
      database,
      managedEndpoint,
      undefined,
      revoked,
    );
    const name = `rollback-${randomUUID()}`;
    await expect(
      guarded.create(owner, { ...input, name }),
    ).rejects.toMatchObject({ code: "SCOUT_ACCESS_DENIED" });
    expect(
      await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.name, name)),
    ).toEqual([]);
    expect(
      await database
        .select()
        .from(scoutResourceScopes)
        .where(eq(scoutResourceScopes.deploymentId, deploymentId)),
    ).toEqual([]);
  });

  test("read revalidation rejects a binding changed during the SQL read", async () => {
    const owner = await person("alpha");
    const profile = await create(owner);
    let armed = true;
    const revoked: TenantScope = {
      ...scope,
      predicate: (...args) => {
        const predicate = scope.predicate(...args);
        if (armed) {
          armed = false;
          memberships.delete(owner.id);
        }
        return predicate;
      },
    };
    const guarded = createAgentProfileStore(
      database,
      managedEndpoint,
      undefined,
      revoked,
    );
    await expect(guarded.get(owner, profile.id)).rejects.toMatchObject({
      code: "SCOUT_ACCESS_DENIED",
    });
  });

  test("runtime SQL never decrypts foreign or legacy endpoint credentials despite public visibility or admin role", async () => {
    const owner = await person("alpha", "admin");
    const foreign = await person("beta");
    const own = await create(owner);
    const other = await create(foreign);
    const unscoped = await legacy.create(owner, input);
    agentIds.push(unscoped.id);
    for (const profile of [own, other, unscoped])
      await database
        .update(agents)
        .set({
          configuration: {
            endpoint: managedEndpoint.toString(),
            auth: { header: "Authorization", credentialId: profile.id },
          },
        })
        .where(eq(agents.id, profile.id));
    const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const encryptedValue = await encryptSecret(
      encryptionKey,
      "Bearer synthetic-only",
    );
    const reads: string[] = [];
    const reader: CredentialSecretReader = {
      async readSecret(id) {
        reads.push(id);
        return { encryptedValue, revokedAt: null };
      },
    };
    const load = createRuntimeAgentLoader(
      database,
      { reader, encryptionKey },
      undefined,
      scope,
    );
    expect((await load(owner)).map((agent) => agent.id)).toEqual([own.id]);
    expect(reads).toEqual([own.id]);
    expect(
      (await createRuntimeAgentLoader(database)(owner)).map(
        (agent) => agent.id,
      ),
    ).toEqual(expect.arrayContaining([own.id, other.id, unscoped.id]));
  });

  test("deleted runtime agents require scoped history channels as well as native channel membership", async () => {
    const owner = await person("alpha");
    const foreign = await person("beta", "admin");
    const retained = await create(owner);
    const foreignChannel = await create(owner);
    const unscopedChannel = await create(owner);
    await historyChannel(owner, retained.id);
    await historyChannel(owner, foreignChannel.id, foreign);
    await historyChannel(owner, unscopedChannel.id, null);
    // Even an injected membership does not turn another tenant's agent into a valid tombstone.
    await historyChannel(foreign, retained.id, foreign);
    for (const profile of [retained, foreignChannel, unscopedChannel])
      await store.softDelete(owner, profile.id);
    const load = createRuntimeAgentLoader(
      database,
      undefined,
      undefined,
      scope,
    );
    expect((await load(owner)).map((agent) => agent.id)).toEqual([retained.id]);
    expect(await load(foreign)).toEqual([]);
  });

  test("runtime rechecks membership after asynchronous vault resolution and returns no credentials after revocation", async () => {
    const owner = await person("alpha");
    const profile = await create(owner);
    await database
      .update(agents)
      .set({
        configuration: {
          endpoint: managedEndpoint.toString(),
          auth: { header: "Authorization", credentialId: profile.id },
        },
      })
      .where(eq(agents.id, profile.id));
    const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const encryptedValue = await encryptSecret(
      encryptionKey,
      "Bearer synthetic-only",
    );
    const reader: CredentialSecretReader = {
      async readSecret() {
        memberships.delete(owner.id);
        return { encryptedValue, revokedAt: null };
      },
    };
    const load = createRuntimeAgentLoader(
      database,
      { reader, encryptionKey },
      undefined,
      scope,
    );
    await expect(load(owner)).rejects.toMatchObject({
      code: "SCOUT_ACCESS_DENIED",
    });
  });
});
