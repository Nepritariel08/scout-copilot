import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema/core";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../src/db/schema/scout-record-context";
import { historyDigest } from "../src/scout/history/protocol";
import {
  bindOwnedOdooContext,
  type OdooAdmissionReader,
} from "../src/scout/owned-model/odoo-binding";
import {
  createOdooJson2CredentialResolver,
  odooJson2CredentialKeyId,
} from "../src/scout/owned-model/odoo-credentials";
import { ModelPolicyError } from "../src/scout/owned-model/policy";
import { createOdooQualificationProofs } from "../src/scout/owned-model/qualification-proof";
import {
  type ProjectTaskReadRequest,
  resolveProjectTaskContext,
  validateProjectTaskContextGrant,
} from "../src/scout/owned-model/record-context";
import { createProjectTaskContextStore } from "../src/scout/owned-model/record-context-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const sourceInstanceId = "proof-odoo";
const policyFingerprint = "c".repeat(64);
afterAll(() => database.$client.close());

async function fixture(lifetime = 12 * 60 * 60 * 1000) {
  const principal = {
    deploymentId: `proof-${randomUUID()}`,
    tenantId: "proof-tenant",
    userId: `proof-${randomUUID()}`,
    bindingFingerprint: "a".repeat(64),
  };
  let now = Date.now();
  let apiKey = "synthetic-proof-key-never-real";
  const credentialRef = randomUUID();
  await database.insert(credentials).values({
    id: credentialRef,
    kind: "connector",
    provider: "odoo-json2",
    keyId: odooJson2CredentialKeyId(sourceInstanceId, 101, principal),
    encryptedValue: await encryptSecret(encryptionKey, apiKey),
    metadata: {
      sourceInstanceId,
      uid: 101,
      ownerNativeUserId: principal.userId,
      ownerTenantId: principal.tenantId,
      ownerDeploymentId: principal.deploymentId,
      ownerBindingFingerprint: principal.bindingFingerprint,
    },
  });
  const [row] = await database
    .insert(scoutOdooRecordAccessGrants)
    .values({
      ...{
        deploymentId: principal.deploymentId,
        tenantId: principal.tenantId,
        nativeUserId: principal.userId,
        bindingFingerprint: principal.bindingFingerprint,
      },
      sourceInstanceId,
      sourceUid: 101,
      revision: 1,
      active: true,
      qualification: "verified_nonadmin",
      qualificationExpiresAt: new Date(now - 1),
      companyIds: [1],
      allowedProjectIds: [501, 502],
      credentialRef,
      expiresAt: new Date(now + lifetime),
    })
    .returning();
  if (!row) throw new Error("Missing synthetic grant");
  await database.insert(scoutContextReleaseGrants).values({
    deploymentId: principal.deploymentId,
    tenantId: principal.tenantId,
    nativeUserId: principal.userId,
    bindingFingerprint: principal.bindingFingerprint,
    sourceInstanceId,
    dataClass: "odoo.project_task_summary.v1",
    provider: "local",
    modelPolicyFingerprint: policyFingerprint,
    revision: 1,
    active: true,
    expiresAt: row.expiresAt,
  });
  const requests: ProjectTaskReadRequest[] = [];
  let afterRead: (() => Promise<void>) | undefined;
  const store = createProjectTaskContextStore(database, sourceInstanceId, {
    readProjectTask: async (request) => {
      expect(
        Date.parse(request.sourceIdentity.qualificationExpiresAt),
      ).toBeGreaterThan(now);
      requests.push(structuredClone(request));
      await afterRead?.();
      return [
        {
          id: 42,
          name: "Synthetic unchanged task",
          stage_id: [1, "Synthetic"],
          date_deadline: null,
          company_id: [1, "Synthetic"],
        },
      ];
    },
  });
  const resolver = createOdooJson2CredentialResolver(
    database,
    encryptionKey,
    sourceInstanceId,
  );
  let calls = 0;
  let visibleProjects = [501, 502];
  let afterQualify: (() => Promise<void>) | undefined;
  const qualify = async (key: string, uid: number, companies: number[]) => {
    calls++;
    expect(key).toBe(apiKey);
    expect(uid).toBe(101);
    expect(companies).toEqual([1]);
    await afterQualify?.();
    return [...visibleProjects];
  };
  const make = () =>
    createOdooQualificationProofs({
      sourceInstanceId,
      store,
      credentials: resolver,
      verifyUserProjectScope: qualify,
      now: () => now,
    });
  const proofs = make();
  const port = {
    ...store,
    qualifyGrant: proofs.qualifyGrant,
    assertQualification: proofs.assertQualification,
  };
  const grant = async () =>
    validateProjectTaskContextGrant(
      await store.getGrant(principal),
      principal,
      now,
      false,
    );
  const resolve = () =>
    resolveProjectTaskContext(
      port,
      principal,
      42,
      "local",
      policyFingerprint,
      () => now,
    );
  return {
    principal,
    credentialRef,
    row,
    store,
    resolver,
    proofs,
    make,
    port,
    grant,
    resolve,
    requests,
    calls: () => calls,
    time: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    projects: (ids: number[]) => {
      visibleProjects = ids;
    },
    afterQualify: (callback: () => Promise<void>) => {
      afterQualify = callback;
    },
    afterRead: (callback: () => Promise<void>) => {
      afterRead = callback;
    },
    revoke: () =>
      database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, credentialRef)),
    rotateSameReference: async () => {
      apiKey = "synthetic-new-proof-key-never-real";
      await database
        .update(credentials)
        .set({ encryptedValue: await encryptSecret(encryptionKey, apiKey) })
        .where(eq(credentials.id, credentialRef));
    },
    appendGrant: (changes: Partial<typeof row>) =>
      database
        .insert(scoutOdooRecordAccessGrants)
        .values({ ...row, id: randomUUID(), revision: 2, ...changes }),
  };
}

describe("renewable qualification with real immutable SQL grants and encrypted vault", () => {
  test("renewal and restart preserve the exact original grant, release and history dependency", async () => {
    const f = await fixture();
    const original = await f.grant();
    await expect(
      resolveProjectTaskContext(
        f.store,
        f.principal,
        42,
        "local",
        policyFingerprint,
        f.time,
      ),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    const before = await f.resolve();
    expect(f.calls()).toBe(1);
    expect(before.dependency.grantDigest).toBe(historyDigest(original));
    await before.assertCurrent(f.principal, "local");
    expect(f.calls()).toBe(1);
    f.advance(16 * 60 * 1000);
    const renewed = await f.resolve();
    await renewed.assertCurrent(f.principal, "local");
    expect(renewed.dependency).toEqual(before.dependency);
    expect(f.calls()).toBe(2);
    expect(await f.grant()).toEqual(original);
    expect(f.requests.at(-1)?.domain[1][2]).toEqual([501, 502]);
    const restarted = f.make();
    expect(await restarted.status(f.principal, original)).toEqual({
      renewable: true,
      current: false,
      expiresAt: null,
    });
    const proof = await restarted.qualifyGrant(f.principal, original);
    expect(proof.grantDigest).toBe(before.dependency.grantDigest);
    expect(f.calls()).toBe(3);
    expect(
      JSON.stringify([proof, await restarted.status(f.principal, original)]),
    ).not.toContain("synthetic-proof-key");
    const rows = await database
      .select()
      .from(scoutOdooRecordAccessGrants)
      .where(
        eq(scoutOdooRecordAccessGrants.deploymentId, f.principal.deploymentId),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(f.row);
  });

  test("a proof is capped by the original grant and cannot revive its expiry", async () => {
    const f = await fixture(5 * 60 * 1000);
    const original = await f.grant();
    const proof = await f.proofs.qualifyGrant(f.principal, original);
    expect(proof.expiresAt).toBe(original.expiresAt);
    f.advance(5 * 60 * 1000 + 1);
    await expect(f.proofs.qualifyGrant(f.principal, original)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(f.calls()).toBe(1);
    expect(await f.proofs.status(f.principal, original)).toEqual({
      renewable: false,
      current: false,
      expiresAt: null,
    });
  });

  test("qualification expiring during the final task read denies instead of renewing after the authority fence", async () => {
    const f = await fixture();
    const resolved = await f.resolve();
    f.afterRead(async () => {
      f.advance(16 * 60 * 1000);
    });
    await expect(resolved.assertCurrent(f.principal, "local")).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(f.calls()).toBe(1);
  });

  for (const phase of ["initial resolve", "final task read"] as const) {
    for (const change of [
      "revoke",
      "rotate",
      "rotate with parallel replacement",
    ] as const) {
      test(`${change} during ${phase} denies the old credential-bound proof without renewing it`, async () => {
        const f = await fixture();
        const original = await f.grant();
        const resolved =
          phase === "final task read" ? await f.resolve() : undefined;
        f.afterRead(async () => {
          if (change === "revoke") await f.revoke();
          else {
            await f.rotateSameReference();
            if (change === "rotate with parallel replacement")
              await f.proofs.qualifyGrant(f.principal, original);
          }
        });
        await expect(
          resolved ? resolved.assertCurrent(f.principal, "local") : f.resolve(),
        ).rejects.toThrow("MODEL_ACCESS_DENIED");
        expect(await f.grant()).toEqual(original);
        expect(f.calls()).toBe(
          change === "rotate with parallel replacement" ? 2 : 1,
        );
        if (change === "rotate with parallel replacement")
          expect((await f.proofs.status(f.principal, original)).current).toBe(
            true,
          );
      });
    }
  }

  test("concurrent readers coalesce one qualification but each retains current vault checks", async () => {
    const f = await fixture();
    const original = await f.grant();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.afterQualify(() => waiting);
    const pending = Array.from({ length: 6 }, () =>
      f.proofs.qualifyGrant(f.principal, original),
    );
    for (let n = 0; n < 100 && f.calls() === 0; n++) await Bun.sleep(5);
    expect(f.calls()).toBe(1);
    release();
    const results = await Promise.all(pending);
    expect(new Set(results.map((proof) => JSON.stringify(proof))).size).toBe(1);
    expect(f.calls()).toBe(1);
    await f.revoke();
    await expect(f.proofs.qualifyGrant(f.principal, original)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(f.calls()).toBe(1);
  });

  test("newly visible projects never widen the original scope, but loss of an original project denies renewal", async () => {
    const f = await fixture();
    const original = await f.grant();
    f.projects([501, 502, 999]);
    await f.resolve();
    expect(f.requests[0]?.domain[1][2]).toEqual([501, 502]);
    expect(await f.grant()).toEqual(original);
    f.advance(16 * 60 * 1000);
    f.projects([501, 999]);
    await expect(f.resolve()).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(await f.grant()).toEqual(original);
  });

  for (const change of [
    "revoked credential",
    "replaced grant",
    "revoked grant",
  ] as const) {
    test(`${change} during qualification cannot publish a reusable proof`, async () => {
      const f = await fixture();
      const original = await f.grant();
      f.afterQualify(async () => {
        if (change === "revoked credential") await f.revoke();
        else
          await f.appendGrant(
            change === "revoked grant"
              ? { active: false }
              : { allowedProjectIds: [501, 502, 999] },
          );
      });
      await expect(
        f.proofs.qualifyGrant(f.principal, original),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(await f.proofs.status(f.principal, original)).toEqual({
        renewable: false,
        current: false,
        expiresAt: null,
      });
    });
  }

  test("a changed secret at the same credential reference requires a new qualification", async () => {
    const f = await fixture();
    const original = await f.grant();
    await f.proofs.qualifyGrant(f.principal, original);
    await f.rotateSameReference();
    expect((await f.proofs.status(f.principal, original)).current).toBe(false);
    await f.proofs.qualifyGrant(f.principal, original);
    expect(f.calls()).toBe(2);
    expect(await f.grant()).toEqual(original);
  });

  test("customer qualification cannot fall back to an employee qualifier", async () => {
    const f = await fixture();
    await expect(
      f.proofs.qualifyGrant(f.principal, await f.grant(), "customer"),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(f.calls()).toBe(0);
  });

  test("native wrapper translates proof digests and fences a mapping revoked during qualification", async () => {
    const f = await fixture();
    const native = { ...f.principal, bindingFingerprint: "b".repeat(64) };
    let active = true;
    const admit: OdooAdmissionReader = async (principal) => {
      if (!active || historyDigest(principal) !== historyDigest(native))
        throw new ModelPolicyError("MODEL_ACCESS_DENIED");
      return {
        principal: f.principal,
        binding: {
          ...f.principal,
          sourceInstanceId,
          sourceUid: 101,
          companyIds: [1],
          revision: 1,
          active: true,
          expiresAt: f.row.expiresAt.toISOString(),
          fingerprint: "d".repeat(64),
        },
        expiresAt: f.row.expiresAt.toISOString(),
        assertCurrent: async () => {
          if (!active) throw new ModelPolicyError("MODEL_ACCESS_DENIED");
        },
      };
    };
    const wrapped = bindOwnedOdooContext(f.port, admit);
    const nativeGrant = validateProjectTaskContextGrant(
      await wrapped.getGrant(native),
      native,
      f.time(),
      false,
    );
    const proof = await wrapped.qualifyGrant?.(native, nativeGrant);
    expect(proof?.grantDigest).toBe(historyDigest(nativeGrant));
    expect(proof?.grantDigest).not.toBe(historyDigest(await f.grant()));
    const resolved = await resolveProjectTaskContext(
      wrapped,
      native,
      42,
      "local",
      policyFingerprint,
      f.time,
    );
    await resolved.assertCurrent(native, "local");
    f.advance(16 * 60 * 1000);
    f.afterQualify(async () => {
      active = false;
    });
    await expect(wrapped.qualifyGrant?.(native, nativeGrant)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
  });
});
