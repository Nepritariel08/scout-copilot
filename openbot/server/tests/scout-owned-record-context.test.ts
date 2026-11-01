import { describe, expect, test } from "bun:test";
import {
  PROJECT_TASK_SELECTION_MARKER,
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  type ProjectTaskContextPrincipal,
  type ProjectTaskContextReleaseGrant,
  type ProjectTaskReadRequest,
  resolveProjectTaskContext,
  selectProjectTask,
} from "../src/scout/owned-model/record-context";

const principal: ProjectTaskContextPrincipal = {
  userId: "native-user-a",
  tenantId: "tenant-a",
  deploymentId: "deployment-a",
  bindingFingerprint: "binding-a",
};
const timestamp = Date.parse("2026-11-01T00:00:00.000Z");

function grant(
  changes: Partial<ProjectTaskContextGrant> = {},
): ProjectTaskContextGrant {
  return {
    principal: { ...principal },
    active: true,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    sourceIdentity: {
      instanceId: "odoo-test",
      uid: 401,
      role: "user",
      qualification: "qualified",
      qualificationExpiresAt: "2099-01-01T00:00:00.000Z",
      companyIds: [7],
      credentialRef: "00000000-0000-4000-8000-000000000401",
    },
    allowedProjectIds: [31],
    ...changes,
  };
}

function releaseGrant(
  changes: Partial<ProjectTaskContextReleaseGrant> = {},
): ProjectTaskContextReleaseGrant {
  return {
    principal: { ...principal },
    active: true,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    dataClass: "odoo.project_task_summary.v1",
    provider: "local",
    sourceInstanceId: "odoo-test",
    modelPolicyFingerprint: "a".repeat(64),
    ...changes,
  };
}

function row(id = 700) {
  return [
    {
      id,
      name: "Synthetic task name",
      stage_id: [9, "Synthetic stage"],
      date_deadline: "2026-12-15",
      company_id: [7, "Synthetic company"],
    },
  ];
}

function fakePort(
  options: {
    currentGrant?: unknown;
    currentReleaseGrant?: unknown;
    rows?: unknown;
    onRead?: (request: ProjectTaskReadRequest) => void;
  } = {},
) {
  let currentGrant: unknown =
    options.currentGrant === undefined ? grant() : options.currentGrant;
  let currentReleaseGrant: unknown =
    options.currentReleaseGrant === undefined
      ? releaseGrant()
      : options.currentReleaseGrant;
  let rows: unknown = options.rows === undefined ? row() : options.rows;
  const requests: ProjectTaskReadRequest[] = [];
  const port: ProjectTaskContextPort = {
    sourceInstanceId: "odoo-test",
    getReleaseGrant: async () => currentReleaseGrant,
    getGrant: async () => currentGrant,
    readProjectTask: async (request) => {
      requests.push(request);
      options.onRead?.(request);
      return rows;
    },
  };
  return {
    port,
    requests,
    setGrant: (value: unknown) => {
      currentGrant = value;
    },
    setReleaseGrant: (value: unknown) => {
      currentReleaseGrant = value;
    },
    setRows: (value: unknown) => {
      rows = value;
    },
  };
}

describe("owned read-only project.task context seam", () => {
  test("accepts one exact selected ID hint and strips arbitrary browser fields", () => {
    expect(
      selectProjectTask([
        { description: "unrelated browser context", value: "private" },
        { description: PROJECT_TASK_SELECTION_MARKER, value: "700" },
      ]),
    ).toEqual({ kind: "selected", recordId: 700 });
    expect(
      selectProjectTask([
        {
          description: PROJECT_TASK_SELECTION_MARKER,
          value: "700",
          fields: ["description"],
        },
      ]),
    ).toEqual({ kind: "invalid" });
    expect(
      selectProjectTask([
        {
          description: PROJECT_TASK_SELECTION_MARKER,
          value: "700",
          domain: [["id", "=", 700]],
        },
      ]),
    ).toEqual({ kind: "invalid" });
    expect(
      selectProjectTask([
        { description: PROJECT_TASK_SELECTION_MARKER, value: "700" },
        { description: PROJECT_TASK_SELECTION_MARKER, value: "701" },
      ]),
    ).toEqual({ kind: "invalid" });
  });

  test("builds fixed one-row Odoo request and releases only allowlisted fields with provenance and freshness", async () => {
    const fake = fakePort();
    const resolved = await resolveProjectTaskContext(
      fake.port,
      principal,
      700,
      "local",
      "a".repeat(64),
      () => timestamp,
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({
      sourceIdentity: {
        instanceId: "odoo-test",
        uid: 401,
        role: "user",
        qualification: "qualified",
        qualificationExpiresAt: "2099-01-01T00:00:00.000Z",
        companyIds: [7],
        credentialRef: "00000000-0000-4000-8000-000000000401",
      },
      model: "project.task",
      domain: [
        ["id", "=", 700],
        ["project_id", "in", [31]],
      ],
      fields: ["id", "name", "stage_id", "date_deadline", "company_id"],
      limit: 1,
      maxBytes: 4096,
    });
    const context = JSON.parse(resolved.prompt.split("\n").slice(1).join("\n"));
    expect(context).toEqual({
      source: { system: "Odoo", model: "project.task", recordId: 700 },
      provenance: {
        grantRevision: 1,
        retrievedAt: "2026-11-01T00:00:00.000Z",
      },
      freshness: { state: "current", maxAgeSeconds: 60 },
      fields: {
        name: "Synthetic task name",
        stage_id: [9, "Synthetic stage"],
        date_deadline: "2026-12-15",
      },
    });
    expect(Object.keys(context.fields).sort()).toEqual([
      "date_deadline",
      "name",
      "stage_id",
    ]);
    expect(resolved.prompt).not.toContain("description");
    expect(resolved.prompt).not.toContain("chatter");
    expect(resolved.prompt).not.toContain("partner_id");
    await resolved.assertCurrent(principal, "local");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]).toEqual(fake.requests[0]);
  });

  test("fails closed for a missing grant without making a source read", async () => {
    const fake = fakePort({ currentGrant: null });
    await expect(
      resolveProjectTaskContext(
        fake.port,
        principal,
        700,
        "local",
        "a".repeat(64),
        () => timestamp,
      ),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(fake.requests).toHaveLength(0);
  });

  test("denies grants for another native user or tenant even when Odoo company is the same", async () => {
    for (const foreignPrincipal of [
      { ...principal, userId: "native-user-b" },
      { ...principal, tenantId: "tenant-b" },
    ]) {
      const fake = fakePort({
        currentGrant: grant({
          principal: foreignPrincipal,
          sourceIdentity: {
            instanceId: "odoo-test",
            uid: 402,
            role: "user",
            qualification: "qualified",
            qualificationExpiresAt: "2099-01-01T00:00:00.000Z",
            companyIds: [7],
            credentialRef: "00000000-0000-4000-8000-000000000402",
          },
        }),
      });
      await expect(
        resolveProjectTaskContext(
          fake.port,
          principal,
          700,
          "local",
          "a".repeat(64),
          () => timestamp,
        ),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(fake.requests).toHaveLength(0);
    }
  });

  test("requires a qualified nonadmin source identity", async () => {
    const invalidGrants = [
      {
        ...grant(),
        sourceIdentity: {
          instanceId: "odoo-test",
          uid: 401,
          role: "admin",
          qualification: "qualified",
          qualificationExpiresAt: "2099-01-01T00:00:00.000Z",
          companyIds: [7],
          credentialRef: "00000000-0000-4000-8000-000000000401",
        },
      },
      {
        ...grant(),
        sourceIdentity: {
          instanceId: "odoo-test",
          uid: 401,
          role: "user",
          qualification: "pending",
          qualificationExpiresAt: "2099-01-01T00:00:00.000Z",
          companyIds: [7],
          credentialRef: "00000000-0000-4000-8000-000000000401",
        },
      },
    ];
    for (const currentGrant of invalidGrants) {
      const fake = fakePort({ currentGrant });
      await expect(
        resolveProjectTaskContext(
          fake.port,
          principal,
          700,
          "local",
          "a".repeat(64),
          () => timestamp,
        ),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(fake.requests).toHaveLength(0);
    }
  });

  test("requires an exact context data-class release grant for the selected provider before record reads", async () => {
    const invalidReleaseGrants = [
      null,
      releaseGrant({ provider: "openrouter" }),
      { ...releaseGrant(), dataClass: "odoo.project_task_detail.v1" },
    ];
    for (const currentReleaseGrant of invalidReleaseGrants) {
      const fake = fakePort({ currentReleaseGrant });
      await expect(
        resolveProjectTaskContext(
          fake.port,
          principal,
          700,
          "local",
          "a".repeat(64),
          () => timestamp,
        ),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(fake.requests).toHaveLength(0);
    }
  });

  test("denies guessed or out-of-grant record IDs and never accepts browser domain or fields", async () => {
    const fake = fakePort({ rows: row(701) });
    await expect(
      resolveProjectTaskContext(
        fake.port,
        principal,
        700,
        "local",
        "a".repeat(64),
        () => timestamp,
      ),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(fake.requests[0]?.domain).toEqual([
      ["id", "=", 700],
      ["project_id", "in", [31]],
    ]);
    expect(fake.requests[0]?.fields).toEqual([
      "id",
      "name",
      "stage_id",
      "date_deadline",
      "company_id",
    ]);
  });

  test("denies a selected task whose company is outside the per-user grant", async () => {
    const fake = fakePort({
      rows: [{ ...row()[0], company_id: [8, "Another customer company"] }],
    });
    await expect(
      resolveProjectTaskContext(
        fake.port,
        principal,
        700,
        "local",
        "a".repeat(64),
        () => timestamp,
      ),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
  });

  test("denies missing, duplicate, oversized, or extra-field rows", async () => {
    for (const rows of [
      [],
      [row()[0], row()[0]],
      [{ ...row()[0], name: "é".repeat(3500), stage_id: [9, "y".repeat(400)] }],
      [{ ...row()[0], description: "not allowlisted" }],
    ]) {
      const fake = fakePort({ rows });
      await expect(
        resolveProjectTaskContext(
          fake.port,
          principal,
          700,
          "local",
          "a".repeat(64),
          () => timestamp,
        ),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
    }
  });

  test("rechecks grant before model egress and stops after revocation", async () => {
    const fake = fakePort();
    const resolved = await resolveProjectTaskContext(
      fake.port,
      principal,
      700,
      "local",
      "a".repeat(64),
      () => timestamp,
    );
    fake.setGrant(grant({ active: false, revision: 2 }));
    await expect(resolved.assertCurrent(principal, "local")).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
  });

  test("rechecks record and release grants after the final Odoo read", async () => {
    for (const revoke of ["record", "release"] as const) {
      const fake = fakePort();
      const resolved = await resolveProjectTaskContext(
        fake.port,
        principal,
        700,
        "local",
        "a".repeat(64),
        () => timestamp,
      );
      const readProjectTask = fake.port.readProjectTask;
      let reads = 0;
      fake.port.readProjectTask = async (request) => {
        const value = await readProjectTask(request);
        reads++;
        if (reads === 1) {
          if (revoke === "record")
            fake.setGrant(grant({ active: false, revision: 2 }));
          else
            fake.setReleaseGrant(releaseGrant({ active: false, revision: 2 }));
        }
        return value;
      };

      await expect(resolved.assertCurrent(principal, "local")).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(reads).toBe(1);
    }
  });

  test("pins the data-class/provider release grant and rechecks it before egress", async () => {
    const fake = fakePort();
    const resolved = await resolveProjectTaskContext(
      fake.port,
      principal,
      700,
      "local",
      "a".repeat(64),
      () => timestamp,
    );
    fake.setReleaseGrant(releaseGrant({ revision: 2 }));
    await expect(resolved.assertCurrent(principal, "local")).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(fake.requests).toHaveLength(1);

    const otherProvider = fakePort({
      currentReleaseGrant: releaseGrant({ provider: "openrouter" }),
    });
    const openRouterContext = await resolveProjectTaskContext(
      otherProvider.port,
      principal,
      700,
      "openrouter",
      "a".repeat(64),
      () => timestamp,
    );
    await expect(
      openRouterContext.assertCurrent(principal, "local"),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(otherProvider.requests).toHaveLength(1);
  });

  test("denies before egress when task ACL visibility or released fields change under an unchanged grant", async () => {
    for (const changedRows of [
      [],
      [
        {
          id: 700,
          name: "Changed synthetic task name",
          stage_id: [9, "Synthetic stage"],
          date_deadline: "2026-12-15",
          company_id: [7, "Synthetic company"],
        },
      ],
    ]) {
      const fake = fakePort();
      const resolved = await resolveProjectTaskContext(
        fake.port,
        principal,
        700,
        "local",
        "a".repeat(64),
        () => timestamp,
      );
      fake.setRows(changedRows);
      await expect(resolved.assertCurrent(principal, "local")).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(fake.requests).toHaveLength(2);
    }
  });
});
