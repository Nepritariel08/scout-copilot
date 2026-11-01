import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema/core";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../src/db/schema/scout-record-context";
import { createOwnedOdooProjectTaskContext } from "../src/scout/owned-model/context-source";
import { createOdooJson2CredentialResolver } from "../src/scout/owned-model/odoo-credentials";
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
}) {
  const id = input.id ?? randomUUID();
  await database.insert(credentials).values({
    id,
    kind: input.kind ?? "connector",
    provider: input.provider ?? "odoo-json2",
    encryptedValue:
      input.encryptedValue ??
      (await encryptSecret(encryptionKey, `synthetic-odoo-key-${input.uid}`)),
    keyId: `${sourceInstanceId}:uid:${input.uid}`,
    metadata: {},
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
    await expect(resolver.resolveForUid(101, credentialRef)).resolves.toEqual({
      uid: 101,
      apiKey: "synthetic-odoo-key-101",
    });
    await expect(resolver.resolveForUid(101, randomUUID())).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(102, await credentialForUid(102)),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(103, await credentialForUid(103)),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(104, await credentialForUid(104)),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveForUid(105, await credentialForUid(105)),
    ).resolves.toBeNull();
    await expect(resolver.resolveForUid(1, credentialRef)).resolves.toBeNull();
    await expect(
      createOdooJson2CredentialResolver(
        database,
        encryptionKey,
        "other-instance",
      ).resolveForUid(101, credentialRef),
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
        else if (url.pathname === "/json/2/res.users/has_group") result = false;
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
      "/json/2/project.task/search_read",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
    ]);
    expect(calls[3]?.body).toEqual({
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
  const [row] = await database
    .select({ id: credentials.id })
    .from(credentials)
    .where(sql`${credentials.keyId} = ${`${sourceInstanceId}:uid:${uid}`}`);
  if (!row) throw new Error("Synthetic credential fixture was not inserted");
  return row.id;
}
