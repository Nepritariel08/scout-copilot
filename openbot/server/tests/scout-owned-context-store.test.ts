import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../src/db/schema/scout-record-context";
import {
  type ProjectTaskContextGrant,
  resolveProjectTaskContext,
} from "../src/scout/owned-model/record-context";
import { createProjectTaskContextStore } from "../src/scout/owned-model/record-context-store";

const principal = {
  userId: "native-alice",
  tenantId: "tenant-a",
  deploymentId: "scout-test",
  bindingFingerprint: "a".repeat(64),
};
const modelFingerprint = "b".repeat(64);
function fixture(array: (values: number[]) => number[] | Int32Array) {
  const common = {
    deploymentId: principal.deploymentId,
    tenantId: principal.tenantId,
    nativeUserId: principal.userId,
    bindingFingerprint: principal.bindingFingerprint,
    active: true,
    revision: 1,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    sourceInstanceId: "odoo-test",
  };
  const record = {
    ...common,
    sourceUid: 101,
    qualification: "verified_nonadmin",
    qualificationExpiresAt: new Date("2099-01-01T00:00:00Z"),
    companyIds: array([1]),
    allowedProjectIds: array([501]),
    credentialRef: "00000000-0000-4000-8000-000000000101",
  };
  const release = {
    ...common,
    dataClass: "odoo.project_task_summary.v1",
    provider: "local",
    modelPolicyFingerprint: modelFingerprint,
  };
  const rows = new Map<unknown, unknown[]>([
    [scoutOdooRecordAccessGrants, [record]],
    [scoutContextReleaseGrants, [release]],
  ]);
  // The DB boundary returns the same integer[] representations as Bun SQL. No SQL is executed.
  const database = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({ limit: async () => rows.get(table) ?? [] }),
        }),
      }),
    }),
  } as unknown as Database;
  let reads = 0;
  const port = createProjectTaskContextStore(database, "odoo-test", {
    readProjectTask: async (request) => {
      reads++;
      expect(request.sourceIdentity.companyIds).toEqual([1]);
      expect(request.domain).toEqual([
        ["id", "=", 42],
        ["project_id", "in", [501]],
      ]);
      return [
        {
          id: 42,
          name: "SQL_ARRAY_CONTEXT_OK",
          stage_id: [9, "Fixture"],
          date_deadline: null,
          company_id: [1, "Fixture"],
        },
      ];
    },
  });
  return { record, release, port, reads: () => reads };
}
describe("persisted Odoo grant array representations", () => {
  for (const [name, array] of [
    ["plain arrays", (values: number[]) => values],
    ["Bun SQL typed arrays", (values: number[]) => new Int32Array(values)],
  ] as const) {
    test(`${name} become strict wire grants without changing company/project scope`, async () => {
      const f = fixture(array);
      const grant = (await f.port.getGrant(
        principal,
      )) as ProjectTaskContextGrant;
      expect(Array.isArray(grant.sourceIdentity.companyIds)).toBe(true);
      expect(Array.isArray(grant.allowedProjectIds)).toBe(true);
      expect(grant.sourceIdentity.companyIds).toEqual([1]);
      expect(grant.allowedProjectIds).toEqual([501]);
      const selected = await resolveProjectTaskContext(
        f.port,
        principal,
        42,
        "local",
        modelFingerprint,
      );
      expect(selected.prompt).toContain("SQL_ARRAY_CONTEXT_OK");
      await selected.assertCurrent(principal, "local");
      expect(f.reads()).toBe(2);
    });
  }
  test("normalizing the driver representation does not grant invalid, duplicate or empty company/project IDs", async () => {
    for (const ids of [[], [0], [1, 1]]) {
      for (const field of ["companyIds", "allowedProjectIds"] as const) {
        const f = fixture((values) => new Int32Array(values));
        f.record[field] = new Int32Array(ids);
        await expect(
          resolveProjectTaskContext(
            f.port,
            principal,
            42,
            "local",
            modelFingerprint,
          ),
        ).rejects.toThrow("MODEL_ACCESS_DENIED");
        expect(f.reads()).toBe(0);
      }
    }
  });
});
