import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { desc, eq } from "drizzle-orm";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { OwnedDeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  auditEvents,
  sessions,
  userRoles,
  users,
} from "../src/db/schema";
import { scoutContextReleaseGrants } from "../src/db/schema/scout-record-context";
import type { createHistoryEngine } from "../src/scout/history/runner";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedAuthority } from "../src/scout/owned/authority";
import { createOwnedNativeIdentity } from "../src/scout/owned/native-identity";
import { createOwnedRuntimeRoutes } from "../src/scout/owned/routes";
import { createTenantScope } from "../src/scout/owned/scope";
import { createOwnedOdooGrantService } from "../src/scout/owned-model/grant-service";
import {
  createOwnedOdooAdmission,
  parseOwnedOdooBinding,
} from "../src/scout/owned-model/odoo-binding";
import { parseModelPolicy } from "../src/scout/owned-model/policy";
import { testDatabaseUrl } from "./support/database";

// No application/default URL or provider traffic. Both clients target only the
// explicitly supplied synthetic test DB, with one actual SQL connection each.
const database = createDatabase(testDatabaseUrl(), { max: 1 });
const identityDatabase = createDatabase(testDatabaseUrl(), { max: 1 });
const prefix = `consent-pool-${randomUUID()}`;
const userId = `${prefix}-native-user`;
const email = `${prefix}@fixture.invalid`;
const entraTenantId = randomUUID();
const issuer = `https://login.microsoftonline.com/${entraTenantId}/v2.0`;
const entraObjectId = randomUUID();
const sourceInstanceId = `${prefix}-odoo`;
const token = `${prefix}-synthetic-session-token`;
const config = {
  runtime: { mode: "owned", durableHistory: true },
  deploymentId: prefix,
  scoutPlatformOwnerIds: [],
  auth: {
    baseUrl: "http://localhost:3001",
    secret: `${prefix}-synthetic-owned-session-secret`,
    trustedOrigins: ["http://localhost:3001"],
    initialAdminEmails: [],
    allowedEmailDomains: [],
    microsoft: {
      tenantId: entraTenantId,
      clientId: `${prefix}-client`,
      clientSecret: `${prefix}-synthetic-client-secret`,
    },
  },
  keyEncryptionKey: Buffer.alloc(32, 41).toString("base64"),
} as unknown as OwnedDeploymentConfig;
const membershipDocument = {
  version: 1,
  deploymentId: prefix,
  policies: [
    {
      tenantId: "tenant-a",
      revision: 1,
      active: true,
      expiresAt: "2099-01-01T00:00:00Z",
    },
  ],
  memberships: [
    {
      userId,
      tenantId: "tenant-a",
      revision: 1,
      policyRevision: 1,
      active: true,
      expiresAt: "2099-01-01T00:00:00Z",
    },
  ],
};
const odooDocument = {
  version: 1,
  deploymentId: prefix,
  sourceInstanceId,
  bindings: [
    {
      userId,
      tenantId: "tenant-a",
      revision: 1,
      active: true,
      expiresAt: "2099-01-01T00:00:00Z",
      sourceUid: 101,
      companyIds: [1],
    },
  ],
};
const modelDocument = {
  version: 1,
  deploymentId: prefix,
  globalMaxConcurrent: 1,
  globalMaxCallsPerDay: 10,
  bindings: [
    {
      userId,
      tenantId: "tenant-a",
      revision: 1,
      active: true,
      expiresAt: "2099-01-01T00:00:00Z",
      agentIds: ["scout"],
      allowConversationContext: true,
      allowPersonalInstructions: false,
      route: {
        provider: "local",
        model: "synthetic-local-model",
        baseUrl: "http://127.0.0.1:11434/v1",
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
};
const membership = async (actor: { id: string }) =>
  parseScoutMembership(membershipDocument, actor, prefix);
const scope = createTenantScope({ binding: membership, deploymentId: prefix });
const profiles = {
  get: async (_actor: unknown, id: string) =>
    id === "scout"
      ? ({} as NonNullable<Awaited<ReturnType<AgentProfileStore["get"]>>>)
      : null,
};
function authorityFor(identity: ReturnType<typeof createOwnedNativeIdentity>) {
  return createOwnedAuthority({
    ...identity,
    binding: membership,
    profiles,
    channels: { get: async () => null },
  });
}
let authority: ReturnType<typeof authorityFor>;
let sharedAuthority: ReturnType<typeof authorityFor>;
let app: ReturnType<typeof createOwnedRuntimeRoutes>;
const grants = createOwnedOdooGrantService(
  database,
  config.keyEncryptionKey,
  sourceInstanceId,
);
let cookie = "";
let transactionChecks = 0;
let beforeCheck: (check: number) => Promise<void> = async () => {};
const pendingChecks = new Set<Promise<unknown>>();
const deadlineError = new Error("Synthetic identity acquisition deadline");
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  pendingChecks.add(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(deadlineError), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // A timed-out same-pool read is drained after its transaction rolls back.
    void work.finally(() => pendingChecks.delete(work)).catch(() => {});
  }
}
function createFixtureApp() {
  return createOwnedRuntimeRoutes({
    authority,
    engine: {} as ReturnType<typeof createHistoryEngine>,
    agents: async () => ({}),
    generativeUi: false,
    odooGrants: {
      ...grants,
      source: {
        sourceInstanceId,
        baseUrl: "https://synthetic-odoo.fixture.invalid",
        database: "synthetic_odoo",
      },
      admit: createOwnedOdooAdmission({
        membership,
        binding: async (principal) =>
          parseOwnedOdooBinding(odooDocument, principal, sourceInstanceId),
        sourceInstanceId,
      }),
      readModelPolicy: async (principal) =>
        parseModelPolicy(modelDocument, principal),
      verifyUserProjectScope: async () => {
        throw new Error("No Odoo calls in the consent SQL fixture");
      },
      consentRelease: (input) =>
        grants.consentRelease({
          ...input,
          assertCurrent: async () => {
            await beforeCheck(++transactionChecks);
            // Bound the fixture even if composition regresses back to the shared
            // pool: a deadline throws inside the actual transaction and rolls back.
            await bounded(input.assertCurrent(), 2000);
          },
        }),
    },
  });
}
function request(method: "GET" | "POST" | "DELETE", body?: unknown) {
  return app.request(
    `/api/scout/odoo/context-grants${method === "GET" ? "?agentId=scout" : "/release"}`,
    {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        "X-Scout-Expected-User": userId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}
async function challenge() {
  const status = await request("GET");
  expect(status.status).toBe(200);
  const value = (await status.json()) as {
    route: { provider: string; model: string; policyFingerprint: string };
  };
  return {
    agentId: "scout",
    consent: true,
    expectedProvider: value.route.provider,
    expectedModel: value.route.model,
    expectedPolicyFingerprint: value.route.policyFingerprint,
  };
}
async function counts() {
  return {
    grants: (
      await database
        .select()
        .from(scoutContextReleaseGrants)
        .where(eq(scoutContextReleaseGrants.nativeUserId, userId))
    ).length,
    audit: (
      await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, userId))
    ).length,
  };
}
async function seedNative() {
  await database
    .insert(users)
    .values({ id: userId, email, emailVerified: true })
    .onConflictDoNothing();
  await database
    .insert(accounts)
    .values({
      id: `${prefix}-account`,
      userId,
      accountId: entraObjectId,
      issuer,
      providerId: "microsoft",
    })
    .onConflictDoNothing();
  await database
    .insert(userRoles)
    .values({ userId, role: "user" })
    .onConflictDoNothing();
  await database
    .insert(sessions)
    .values({
      id: `${prefix}-session`,
      userId,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .onConflictDoNothing();
}

beforeAll(async () => {
  // Better Auth initializes provider discovery even when the tested operation
  // only reads an existing signed session. Stub this exact synthetic tenant's
  // discovery before constructing either native client; every other request
  // still goes through the original test network guard. No OAuth login or
  // provider token is supplied by this pool/authorization fixture.
  const originalFetch = globalThis.fetch;
  let discoveryReads = 0;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        url === `${issuer}/.well-known/openid-configuration` &&
        method.toUpperCase() === "GET"
      ) {
        discoveryReads++;
        return Response.json({
          issuer,
          authorization_endpoint:
            "https://synthetic-entra.fixture.invalid/authorize",
          token_endpoint: "https://synthetic-entra.fixture.invalid/token",
          jwks_uri: "https://synthetic-entra.fixture.invalid/jwks",
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const identity = createOwnedNativeIdentity(config, identityDatabase, scope);
    const sharedIdentity = createOwnedNativeIdentity(config, database, scope);
    // Await initialization while the fixture transport is installed, before
    // restoring fetch or holding a data transaction for the deadlock proof.
    const initialized = await Promise.allSettled(
      [identity, sharedIdentity].map((native) =>
        native.auth.api.getSession({ headers: new Headers() }),
      ),
    );
    for (const result of initialized) {
      if (result.status === "rejected") throw result.reason;
      expect(result.value).toBeNull();
    }
    expect(discoveryReads).toBe(2);
    authority = authorityFor(identity);
    sharedAuthority = authorityFor(sharedIdentity);
    app = createFixtureApp();
  } finally {
    globalThis.fetch = originalFetch;
  }
  await seedNative();
  // Only the synthetic persisted fixture is minted here; Better Auth's actual
  // signed-cookie/session reader and closed Entra hook perform every lookup.
  const signature = await makeSignature(token, config.auth?.secret ?? "");
  cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  expect(
    (
      await authority.binding(
        new Request("http://fixture.invalid", { headers: { cookie } }),
      )
    ).person.id,
  ).toBe(userId);
});
beforeEach(async () => {
  transactionChecks = 0;
  beforeCheck = async () => {};
  membershipDocument.memberships[0]!.active = true;
  odooDocument.bindings[0]!.revision = 1;
  modelDocument.bindings[0]!.revision = 1;
  modelDocument.bindings[0]!.expiresAt = "2099-01-01T00:00:00Z";
  await seedNative();
});
afterAll(async () => {
  await Promise.allSettled([...pendingChecks]);
  await identityDatabase.$client.close();
  await database.$client.close();
});

describe("native auth revalidation inside one-connection consent transactions", () => {
  test("reproduces the old shared-pool wait with real Better Auth and drains it after rollback", async () => {
    let pending: Promise<unknown> | undefined;
    await expect(
      database.transaction(async () => {
        pending = sharedAuthority.binding(
          new Request("http://fixture.invalid", { headers: { cookie } }),
        );
        await bounded(pending, 250);
      }),
    ).rejects.toBe(deadlineError);
    await pending;
    expect(await counts()).toEqual({ grants: 0, audit: 0 });
  });

  test("the same actual route commits with independent max:1 pools and three fresh checks", async () => {
    expect(database.$client).not.toBe(identityDatabase.$client);
    const before = await counts();
    const response = await request("POST", await challenge());
    expect(response.status).toBe(201);
    expect(transactionChecks).toBe(3);
    expect(await counts()).toEqual({
      grants: before.grants + 1,
      audit: before.audit + 1,
    });
  });

  test("native session, Entra mapping and real role withdrawal at each transaction checkpoint roll back the grant and audit", async () => {
    for (const withdrawIdentity of [
      () =>
        identityDatabase.delete(sessions).where(eq(sessions.userId, userId)),
      () =>
        identityDatabase.delete(accounts).where(eq(accounts.userId, userId)),
      () =>
        identityDatabase.delete(userRoles).where(eq(userRoles.userId, userId)),
    ]) {
      for (const stopAt of [1, 2, 3]) {
        await seedNative();
        transactionChecks = 0;
        const body = await challenge();
        const before = await counts();
        beforeCheck = async (check) => {
          if (check === stopAt) await withdrawIdentity();
        };
        const response = await request("POST", body);
        expect(response.status).toBe(403);
        expect(transactionChecks).toBe(stopAt);
        expect(await counts()).toEqual(before);
      }
    }
  });

  test("membership withdrawal, Odoo map rotation, model revision and true policy expiry remain fresh within the transaction", async () => {
    const withdraw = [
      {
        status: 403,
        change: () => {
          membershipDocument.memberships[0]!.active = false;
        },
      },
      {
        status: 403,
        change: () => {
          odooDocument.bindings[0]!.revision++;
        },
      },
      {
        status: 409,
        change: () => {
          modelDocument.bindings[0]!.revision++;
        },
      },
      {
        status: 403,
        change: () => {
          modelDocument.bindings[0]!.expiresAt = "2000-01-01T00:00:00Z";
        },
      },
    ];
    for (const { status, change } of withdraw) {
      for (const stopAt of [1, 2, 3]) {
        membershipDocument.memberships[0]!.active = true;
        odooDocument.bindings[0]!.revision = 1;
        modelDocument.bindings[0]!.revision = 1;
        modelDocument.bindings[0]!.expiresAt = "2099-01-01T00:00:00Z";
        transactionChecks = 0;
        const body = await challenge();
        const before = await counts();
        beforeCheck = async (check) => {
          if (check === stopAt) change();
        };
        const response = await request("POST", body);
        expect(response.status).toBe(status);
        expect(transactionChecks).toBe(stopAt);
        expect(await counts()).toEqual(before);
      }
    }
  });

  test("explicit withdrawal still retires the saved consent when model admission is expired", async () => {
    const response = await request("POST", await challenge());
    expect(response.status).toBe(201);
    modelDocument.bindings[0]!.expiresAt = "2000-01-01T00:00:00Z";
    const withdrawn = await request("DELETE", { agentId: "scout" });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({ releaseGrantsRevoked: 1 });
    const rows = await database
      .select()
      .from(scoutContextReleaseGrants)
      .where(eq(scoutContextReleaseGrants.nativeUserId, userId))
      .orderBy(desc(scoutContextReleaseGrants.revision));
    expect(rows[0]?.active).toBe(false);
  });
});
