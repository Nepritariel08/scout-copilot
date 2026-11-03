import { expect, test } from "bun:test";
import { historyDigest } from "../src/scout/history/protocol";
import {
  bindOwnedOdooContext,
  type OdooAdmissionReader,
} from "../src/scout/owned-model/odoo-binding";
import { ModelPolicyError } from "../src/scout/owned-model/policy";
import { createOdooQualificationProofs } from "../src/scout/owned-model/qualification-proof";
import {
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  resolveProjectTaskContext,
} from "../src/scout/owned-model/record-context";

function grant(index: number): ProjectTaskContextGrant {
  return {
    principal: {
      userId: `synthetic-${index}`,
      tenantId: "synthetic",
      deploymentId: "synthetic",
      bindingFingerprint: "a".repeat(64),
    },
    active: true,
    revision: 1,
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    sourceIdentity: {
      instanceId: "synthetic",
      uid: 101,
      role: "user",
      qualification: "qualified",
      qualificationExpiresAt: new Date(Date.now() - 1).toISOString(),
      companyIds: [1],
      credentialRef: "00000000-0000-4000-8000-000000000101",
    },
    allowedProjectIds: [1],
  };
}

test("qualification fan-out is bounded at sixteen distinct in-flight identities", async () => {
  const grants = Array.from({ length: 17 }, (_, index) => grant(index));
  const byUser = new Map(
    grants.map((value) => [value.principal.userId, value]),
  );
  let calls = 0;
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const proofs = createOdooQualificationProofs({
    sourceInstanceId: "synthetic",
    store: { getGrant: async (principal) => byUser.get(principal.userId) },
    credentials: {
      resolveForUid: async () => ({ uid: 101, apiKey: "synthetic-key" }),
    },
    verifyUserProjectScope: async () => {
      calls++;
      await waiting;
      return [1];
    },
  });
  const pending = grants.map((value) =>
    proofs.qualifyGrant(value.principal, value).then(
      () => "qualified",
      (error: Error) => error.message,
    ),
  );
  try {
    for (let attempt = 0; attempt < 100 && calls < 16; attempt++)
      await Bun.sleep(5);
    expect(calls).toBe(16);
  } finally {
    release();
  }
  const results = await Promise.all(pending);
  expect(results.filter((result) => result === "qualified")).toHaveLength(16);
  expect(
    results.filter((result) => result === "MODEL_UNAVAILABLE"),
  ).toHaveLength(1);
});

test("the proof cache evicts its oldest entry instead of retaining unlimited identities", async () => {
  const grants = Array.from({ length: 129 }, (_, index) => grant(index));
  const byUser = new Map(
    grants.map((value) => [value.principal.userId, value]),
  );
  let calls = 0;
  const proofs = createOdooQualificationProofs({
    sourceInstanceId: "synthetic",
    store: { getGrant: async (principal) => byUser.get(principal.userId) },
    credentials: {
      resolveForUid: async () => ({ uid: 101, apiKey: "synthetic-key" }),
    },
    verifyUserProjectScope: async () => {
      calls++;
      return [1];
    },
  });
  for (const value of grants) await proofs.qualifyGrant(value.principal, value);
  const first = grants[0],
    last = grants.at(-1);
  if (!first || !last) throw new Error("Missing synthetic cache identities");
  expect((await proofs.status(first.principal, first)).current).toBe(false);
  expect((await proofs.status(last.principal, last)).current).toBe(true);
  await proofs.qualifyGrant(first.principal, first);
  expect(calls).toBe(130);
});

test("explicit customer proof uses only the separate customer qualifier", async () => {
  const current = grant(1);
  let employee = 0,
    customer = 0;
  const proofs = createOdooQualificationProofs({
    sourceInstanceId: "synthetic",
    store: { getGrant: async () => current },
    credentials: {
      resolveForUid: async () => ({ uid: 101, apiKey: "synthetic-key" }),
    },
    verifyUserProjectScope: async () => {
      employee++;
      return [1];
    },
    verifyCustomerProjectScope: async () => {
      customer++;
      return [1];
    },
  });
  const proof = await proofs.qualifyGrant(
    current.principal,
    current,
    "customer",
  );
  await proofs.assertQualification(
    current.principal,
    current,
    proof,
    "customer",
  );
  expect(employee).toBe(0);
  expect(customer).toBe(1);
});

test("a qualification extension without a non-renewing fence cannot read source data", async () => {
  const current = grant(1);
  let reads = 0;
  const port: ProjectTaskContextPort = {
    sourceInstanceId: "synthetic",
    getGrant: async () => current,
    getReleaseGrant: async () => ({
      principal: current.principal,
      active: true,
      revision: 1,
      expiresAt: current.expiresAt,
      sourceInstanceId: "synthetic",
      dataClass: "odoo.project_task_summary.v1",
      provider: "local",
      modelPolicyFingerprint: "b".repeat(64),
    }),
    qualifyGrant: async () => ({
      grantDigest: historyDigest(current),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      proofId: "opaque-synthetic",
    }),
    readProjectTask: async () => {
      reads++;
      return [];
    },
  };
  await expect(
    resolveProjectTaskContext(
      port,
      current.principal,
      1,
      "local",
      "b".repeat(64),
    ),
  ).rejects.toThrow("MODEL_ACCESS_DENIED");
  expect(reads).toBe(0);
});

test("native post-read fence translates the receipt and denies a mapping change during its check", async () => {
  const current = grant(1);
  const native = { ...current.principal, bindingFingerprint: "b".repeat(64) };
  const nativeGrant = { ...current, principal: native };
  let active = true;
  const admit: OdooAdmissionReader = async () => ({
    principal: current.principal,
    binding: {
      userId: current.principal.userId,
      tenantId: current.principal.tenantId,
      deploymentId: current.principal.deploymentId,
      sourceInstanceId: "synthetic",
      sourceUid: 101,
      companyIds: [1],
      revision: 1,
      active: true,
      expiresAt: current.expiresAt,
      fingerprint: "c".repeat(64),
    },
    expiresAt: current.expiresAt,
    assertCurrent: async () => {
      if (!active) throw new ModelPolicyError("MODEL_ACCESS_DENIED");
    },
  });
  const proof = {
    grantDigest: historyDigest(nativeGrant),
    proofId: "opaque-synthetic",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const wrapped = bindOwnedOdooContext(
    {
      sourceInstanceId: "synthetic",
      getGrant: async () => current,
      getReleaseGrant: async () => null,
      readProjectTask: async () => [],
      assertQualification: async (principal, inner, receipt) => {
        expect(principal).toEqual(current.principal);
        expect(inner).toEqual(current);
        expect(receipt).toEqual({
          ...proof,
          grantDigest: historyDigest(current),
        });
        active = false;
      },
    },
    admit,
  );
  await expect(
    wrapped.assertQualification?.(native, nativeGrant, proof),
  ).rejects.toThrow("MODEL_ACCESS_DENIED");
});
