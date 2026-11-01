import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { addAuditTap } from "../src/audit";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents, credentials } from "../src/db/schema/core";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../src/db/schema/scout-record-context";
import { createOwnedOdooProjectTaskContext } from "../src/scout/owned-model/context-source";
import { createOwnedOdooGrantService } from "../src/scout/owned-model/grant-service";
import {
  createOdooJson2CredentialResolver,
  odooJson2CredentialKeyId,
} from "../src/scout/owned-model/odoo-credentials";
import type { ProjectTaskReadRequest } from "../src/scout/owned-model/record-context";
import { createProjectTaskContextStore } from "../src/scout/owned-model/record-context-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `scout-context-${randomUUID()}`;
const sourceInstanceId = "odoo-test";
const deploymentId = `${prefix}-deployment`;
const tenantId = `${prefix}-tenant`;
const nativeUserId = `${prefix}-user`;
const bindingFingerprint = "a".repeat(64);
const modelPolicyFingerprint = "b".repeat(64);
const credentialRef = randomUUID();
const recordGrantId = randomUUID();
const revokedRecordGrantId = randomUUID();
const releaseGrantId = randomUUID();
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
const qualificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
const principal = {
  deploymentId,
  tenantId,
  userId: nativeUserId,
  bindingFingerprint,
};

async function insertCredential(input: {
  uid: number;
  id?: string;
  kind?: "connector" | "model";
  provider?: string;
  revokedAt?: Date | null;
  encryptedValue?: string;
  owner?: typeof principal;
}) {
  const id = input.id ?? randomUUID();
  const owner = input.owner ?? principal;
  await database.insert(credentials).values({
    id,
    kind: input.kind ?? "connector",
    provider: input.provider ?? "odoo-json2",
    encryptedValue:
      input.encryptedValue ??
      (await encryptSecret(encryptionKey, `synthetic-odoo-key-${input.uid}`)),
    keyId: odooJson2CredentialKeyId(sourceInstanceId, input.uid, owner),
    metadata: {
      sourceInstanceId,
      uid: input.uid,
      ownerNativeUserId: owner.userId,
      ownerTenantId: owner.tenantId,
      ownerDeploymentId: owner.deploymentId,
      ownerBindingFingerprint: owner.bindingFingerprint,
    },
    revokedAt: input.revokedAt ?? null,
  });
  return id;
}

async function wasRefusedAsAppendOnly(
  work: () => PromiseLike<unknown>,
): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth++) {
      if (
        String((current as { message?: string }).message ?? "").includes(
          "append-only",
        )
      )
        return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }
}

beforeAll(async () => {
  await insertCredential({ uid: 101, id: credentialRef });
  await insertCredential({ uid: 102, encryptedValue: "invalid-envelope" });
  await insertCredential({ uid: 103, provider: "other-provider" });
  await insertCredential({ uid: 104, kind: "model" });
  await insertCredential({ uid: 105, revokedAt: new Date() });

  await database.insert(scoutOdooRecordAccessGrants).values([
    {
      id: recordGrantId,
      deploymentId,
      tenantId,
      nativeUserId,
      bindingFingerprint,
      revision: 1,
      active: true,
      sourceInstanceId,
      sourceUid: 101,
      qualification: "verified_nonadmin",
      qualificationExpiresAt,
      companyIds: [1],
      allowedProjectIds: [501],
      credentialRef,
      expiresAt,
    },
    {
      id: revokedRecordGrantId,
      deploymentId,
      tenantId,
      nativeUserId,
      bindingFingerprint,
      revision: 2,
      active: false,
      sourceInstanceId,
      sourceUid: 101,
      qualification: "pending",
      qualificationExpiresAt,
      companyIds: [1],
      allowedProjectIds: [501],
      credentialRef,
      expiresAt,
    },
  ]);

  await database.insert(scoutContextReleaseGrants).values({
    id: releaseGrantId,
    deploymentId,
    tenantId,
    nativeUserId,
    bindingFingerprint,
    sourceInstanceId,
    dataClass: "odoo.project_task_summary.v1",
    provider: "openrouter",
    modelPolicyFingerprint,
    revision: 1,
    active: true,
    expiresAt,
  });
});

afterAll(async () => {
  await database.$client.close();
});

describe("owned Odoo grant persistence and credential resolution", () => {
  test("provisions encrypted record access, records explicit release consent, and revokes both atomically", async () => {
    const grantPrincipal = {
      ...principal,
      userId: `${prefix}-provisioning-user`,
      bindingFingerprint: "c".repeat(64),
    };
    const provisioningSourceId = `${sourceInstanceId}-${randomUUID()}`;
    const service = createOwnedOdooGrantService(
      database,
      encryptionKey,
      provisioningSourceId,
    );
    let taps = 0;
    const removeTap = addAuditTap(() => {
      taps += 1;
    });
    try {
      const issued = await service.issueRecord({
        principal: grantPrincipal,
        binding: {
          sourceUid: 201,
          companyIds: [1, 2],
          bindingExpiresAt: "2099-01-01T00:00:00.000Z",
        },
        apiKey: "synthetic-new-api-key",
        allowedProjectIds: [501, 502],
      });
      expect(issued).toMatchObject({ revision: 1, projectCount: 2 });
      const [record] = await database
        .select()
        .from(scoutOdooRecordAccessGrants)
        .where(
          eq(scoutOdooRecordAccessGrants.nativeUserId, grantPrincipal.userId),
        );
      expect(record).toMatchObject({
        active: true,
        revision: 1,
        sourceUid: 201,
        qualification: "verified_nonadmin",
      });
      expect(Array.from(record!.companyIds)).toEqual([1, 2]);
      expect(Array.from(record!.allowedProjectIds)).toEqual([501, 502]);
      const [storedSecret] = await database
        .select({ encryptedValue: credentials.encryptedValue })
        .from(credentials)
        .where(eq(credentials.id, record!.credentialRef));
      expect(storedSecret?.encryptedValue).not.toContain(
        "synthetic-new-api-key",
      );
      const resolver = createOdooJson2CredentialResolver(
        database,
        encryptionKey,
        provisioningSourceId,
      );
      await expect(
        resolver.resolveForUid(201, record!.credentialRef, grantPrincipal),
      ).resolves.toEqual({ uid: 201, apiKey: "synthetic-new-api-key" });

      const consent = await service.consentRelease({
        principal: grantPrincipal,
        bindingExpiresAt: "2099-01-01T00:00:00.000Z",
        modelPolicyExpiresAt: "2099-01-01T00:00:00.000Z",
        provider: "openrouter",
        modelPolicyFingerprint,
      });
      expect(consent).toMatchObject({ revision: 1, provider: "openrouter" });
      await expect(
        service.status(grantPrincipal, "openrouter", modelPolicyFingerprint),
      ).resolves.toMatchObject({
        provider: "openrouter",
        record: { active: true, revision: 1, projectCount: 2 },
        release: { active: true, revision: 1, provider: "openrouter" },
      });
      expect(await service.revokeAll(grantPrincipal)).toEqual({
        recordGrantRevoked: true,
        recordGrantsRevoked: 1,
        releaseGrantsRevoked: 1,
        localCredentialRevoked: true,
        odooKeyRevokedUpstream: false,
      });
      const recordRevisions = await database
        .select()
        .from(scoutOdooRecordAccessGrants)
        .where(
          eq(scoutOdooRecordAccessGrants.nativeUserId, grantPrincipal.userId),
        )
        .orderBy(desc(scoutOdooRecordAccessGrants.revision));
      expect(recordRevisions[0]).toMatchObject({ active: false, revision: 2 });
      const releaseRevisions = await database
        .select()
        .from(scoutContextReleaseGrants)
        .where(
          eq(scoutContextReleaseGrants.nativeUserId, grantPrincipal.userId),
        )
        .orderBy(desc(scoutContextReleaseGrants.revision));
      expect(releaseRevisions[0]).toMatchObject({ active: false, revision: 2 });
      await expect(
        service.status(grantPrincipal, "openrouter", modelPolicyFingerprint),
      ).resolves.toMatchObject({
        record: { active: false, revision: 2 },
        release: { active: false, revision: 2 },
      });
      await expect(
        resolver.resolveForUid(201, record!.credentialRef, grantPrincipal),
      ).resolves.toBeNull();
      expect(taps).toBe(0);
      const events = await database
        .select({
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, grantPrincipal.userId));
      expect(events.map((event) => event.eventType).sort()).toEqual(
        [
          "scout.odoo_context_grant.issued",
          "scout.odoo_context_grant.revoked",
          "scout.odoo_context_release.consent_recorded",
        ].sort(),
      );
      expect(JSON.stringify(events)).not.toContain("synthetic-new-api-key");
    } finally {
      removeTap();
    }
  });

  test("record revocation is isolated by tenant and binding when one Odoo UID is reused", async () => {
    const sharedUserId = `${prefix}-shared-user`;
    const tenantA = {
      ...principal,
      userId: sharedUserId,
      tenantId: `${prefix}-tenant-a`,
      bindingFingerprint: "d".repeat(64),
    };
    const tenantB = {
      ...principal,
      userId: sharedUserId,
      tenantId: `${prefix}-tenant-b`,
      bindingFingerprint: "e".repeat(64),
    };
    const scopedSourceId = `${sourceInstanceId}-${randomUUID()}`;
    const service = createOwnedOdooGrantService(
      database,
      encryptionKey,
      scopedSourceId,
    );
    await service.issueRecord({
      principal: tenantA,
      binding: {
        sourceUid: 301,
        companyIds: [1],
        bindingExpiresAt: "2099-01-01T00:00:00.000Z",
      },
      apiKey: "tenant-a-odoo-key",
      allowedProjectIds: [601],
    });
    await service.issueRecord({
      principal: tenantB,
      binding: {
        sourceUid: 301,
        companyIds: [1],
        bindingExpiresAt: "2099-01-01T00:00:00.000Z",
      },
      apiKey: "tenant-b-odoo-key",
      allowedProjectIds: [602],
    });
    const [recordA] = await database
      .select()
      .from(scoutOdooRecordAccessGrants)
      .where(
        and(
          eq(scoutOdooRecordAccessGrants.tenantId, tenantA.tenantId),
          eq(scoutOdooRecordAccessGrants.nativeUserId, sharedUserId),
        ),
      )
      .orderBy(desc(scoutOdooRecordAccessGrants.revision))
      .limit(1);
    const [recordB] = await database
      .select()
      .from(scoutOdooRecordAccessGrants)
      .where(
        and(
          eq(scoutOdooRecordAccessGrants.tenantId, tenantB.tenantId),
          eq(scoutOdooRecordAccessGrants.nativeUserId, sharedUserId),
        ),
      )
      .orderBy(desc(scoutOdooRecordAccessGrants.revision))
      .limit(1);
    expect(recordA?.credentialRef).not.toBe(recordB?.credentialRef);
    const resolver = createOdooJson2CredentialResolver(
      database,
      encryptionKey,
      scopedSourceId,
    );
    await expect(
      resolver.resolveForUid(301, recordA!.credentialRef, tenantB),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(301, recordB!.credentialRef, tenantB),
    ).resolves.toEqual({ uid: 301, apiKey: "tenant-b-odoo-key" });

    await expect(service.revokeAll(tenantA)).resolves.toMatchObject({
      recordGrantsRevoked: 1,
      localCredentialRevoked: true,
    });
    const [latestB] = await database
      .select()
      .from(scoutOdooRecordAccessGrants)
      .where(
        and(
          eq(scoutOdooRecordAccessGrants.tenantId, tenantB.tenantId),
          eq(scoutOdooRecordAccessGrants.nativeUserId, sharedUserId),
        ),
      )
      .orderBy(desc(scoutOdooRecordAccessGrants.revision))
      .limit(1);
    expect(latestB).toMatchObject({ active: true, revision: 1 });
    await expect(
      resolver.resolveForUid(301, recordB!.credentialRef, tenantB),
    ).resolves.toEqual({ uid: 301, apiKey: "tenant-b-odoo-key" });
  });

  test("model-release consent can be withdrawn without revoking the Odoo record grant", async () => {
    const releasePrincipal = {
      ...principal,
      userId: `${prefix}-release-revoke-user`,
      bindingFingerprint: "f".repeat(64),
    };
    const scopedSourceId = `${sourceInstanceId}-${randomUUID()}`;
    const service = createOwnedOdooGrantService(
      database,
      encryptionKey,
      scopedSourceId,
    );
    await service.issueRecord({
      principal: releasePrincipal,
      binding: {
        sourceUid: 401,
        companyIds: [1],
        bindingExpiresAt: "2099-01-01T00:00:00.000Z",
      },
      apiKey: "synthetic-release-revoke-key",
      allowedProjectIds: [701],
    });
    await service.consentRelease({
      principal: releasePrincipal,
      bindingExpiresAt: "2099-01-01T00:00:00.000Z",
      modelPolicyExpiresAt: "2099-01-01T00:00:00.000Z",
      provider: "openrouter",
      modelPolicyFingerprint,
    });
    await expect(
      service.revokeRelease({
        principal: releasePrincipal,
        provider: "openrouter",
        modelPolicyFingerprint,
      }),
    ).resolves.toMatchObject({ revoked: true, revision: 2 });
    await expect(
      service.status(releasePrincipal, "openrouter", modelPolicyFingerprint),
    ).resolves.toMatchObject({
      record: { active: true, revision: 1 },
      release: { active: false, revision: 2 },
    });
  });

  test("the newest inactive record revision shadows the prior active grant", async () => {
    const store = createProjectTaskContextStore(database, sourceInstanceId, {
      readProjectTask: async () => null,
    });
    const grant = await store.getGrant(principal);
    expect(grant).toMatchObject({
      active: false,
      revision: 2,
      sourceIdentity: {
        instanceId: sourceInstanceId,
        uid: 101,
        qualification: "pending",
        credentialRef,
      },
    });
  });

  test("record and release grants require exact principal, instance, provider and policy", async () => {
    const store = createProjectTaskContextStore(database, sourceInstanceId, {
      readProjectTask: async () => null,
    });

    expect(
      await store.getGrant({ ...principal, userId: `${prefix}-other` }),
    ).toBeNull();
    expect(
      await createProjectTaskContextStore(database, "other-instance", {
        readProjectTask: async () => null,
      }).getGrant(principal),
    ).toBeNull();
    await expect(
      store.getReleaseGrant(principal, "openrouter", modelPolicyFingerprint),
    ).resolves.toMatchObject({ active: true, revision: 1 });
    await expect(
      store.getReleaseGrant(principal, "local", modelPolicyFingerprint),
    ).resolves.toBeNull();
    await expect(
      store.getReleaseGrant(principal, "openrouter", "c".repeat(64)),
    ).resolves.toBeNull();
  });

  test("credential resolution decrypts only the exact live instance and UID reference", async () => {
    const resolver = createOdooJson2CredentialResolver(
      database,
      encryptionKey,
      sourceInstanceId,
    );
    await expect(
      resolver.resolveForUid(101, credentialRef, principal),
    ).resolves.toEqual({
      uid: 101,
      apiKey: "synthetic-odoo-key-101",
    });
    await expect(
      resolver.resolveForUid(101, randomUUID(), principal),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(102, await credentialForUid(102), principal),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(103, await credentialForUid(103), principal),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(104, await credentialForUid(104), principal),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(105, await credentialForUid(105), principal),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(1, credentialRef, principal),
    ).resolves.toBeNull();
    await expect(
      createOdooJson2CredentialResolver(
        database,
        encryptionKey,
        "other-instance",
      ).resolveForUid(101, credentialRef, principal),
    ).resolves.toBeNull();
  });

  test("production context composition reads through encrypted credentials and the fixed JSON-2 allowlist", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const transport: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        expect(url.origin).toBe("https://odoo.fixture.example");
        expect(headers.get("authorization")).toBe(
          "bearer synthetic-odoo-key-101",
        );
        expect(headers.get("x-odoo-database")).toBe("fixture_odoo");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ path: url.pathname, body });
        let result: unknown;
        if (url.pathname === "/json/2/res.users/context_get")
          result = { uid: 101 };
        else if (url.pathname === "/json/2/res.users/has_group")
          result = body.group_ext_id === "base.group_user";
        else if (url.pathname === "/json/2/project.task/search_read")
          result = [
            {
              id: 77,
              name: "Synthetic task",
              stage_id: [2, "In Progress"],
              date_deadline: "2026-11-30",
              company_id: [1, "Synthetic company"],
            },
          ];
        else return new Response(null, { status: 404 });
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: async () => {} },
    );
    const context = createOwnedOdooProjectTaskContext(
      database,
      encryptionKey,
      {
        version: 1,
        sourceInstanceId,
        baseUrl: "https://odoo.fixture.example",
        database: "fixture_odoo",
      },
      transport,
    );
    const request: ProjectTaskReadRequest = {
      principal,
      sourceIdentity: {
        instanceId: sourceInstanceId,
        uid: 101,
        role: "user",
        qualification: "qualified",
        qualificationExpiresAt: qualificationExpiresAt.toISOString(),
        companyIds: [1],
        credentialRef,
      },
      model: "project.task",
      domain: [
        ["id", "=", 77],
        ["project_id", "in", [501]],
      ],
      fields: ["id", "name", "stage_id", "date_deadline", "company_id"],
      limit: 1,
      maxBytes: 4096,
    };

    await expect(context.readProjectTask(request)).resolves.toEqual([
      {
        id: 77,
        name: "Synthetic task",
        stage_id: [2, "In Progress"],
        date_deadline: "2026-11-30",
        company_id: [1, "Synthetic company"],
      },
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/project.task/search_read",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
    ]);
    expect(calls[4]?.body).toEqual({
      context: { allowed_company_ids: [1] },
      domain: [
        ["id", "=", 77],
        ["project_id", "in", [501]],
      ],
      fields: ["id", "name", "stage_id", "date_deadline", "company_id"],
      limit: 1,
    });
  });

  test("the database refuses update, delete and truncate on both grant ledgers", async () => {
    for (const [table, id] of [
      ["scout_odoo_record_access_grants", recordGrantId],
      ["scout_context_release_grants", releaseGrantId],
    ] as const) {
      expect(
        await wasRefusedAsAppendOnly(() =>
          database.execute(
            sql`UPDATE ${sql.identifier(table)} SET active = false WHERE id = ${id}::uuid`,
          ),
        ),
      ).toBe(true);
      expect(
        await wasRefusedAsAppendOnly(() =>
          database.execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`,
          ),
        ),
      ).toBe(true);
      expect(
        await wasRefusedAsAppendOnly(() =>
          database.execute(sql`TRUNCATE TABLE ${sql.identifier(table)}`),
        ),
      ).toBe(true);
    }
  });
});

async function credentialForUid(uid: number) {
  const keyId = odooJson2CredentialKeyId(sourceInstanceId, uid, principal);
  const [row] = await database
    .select({ id: credentials.id })
    .from(credentials)
    .where(sql`${credentials.keyId} = ${keyId}`);
  if (!row) throw new Error("Synthetic credential fixture was not inserted");
  return row.id;
}
