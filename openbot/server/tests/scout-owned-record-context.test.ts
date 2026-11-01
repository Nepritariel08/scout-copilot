import { describe, expect, test } from "bun:test";
import {
  PROJECT_TASK_SELECTION_MARKER,
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  type ProjectTaskContextPrincipal,
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
      uid: 401,
      role: "user",
      qualification: "qualified",
      companyIds: [7],
    },
    allowedProjectIds: [31],
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
    },
  ];
}

function fakePort(
  options: {
    currentGrant?: unknown;
    rows?: unknown;
    onRead?: (request: ProjectTaskReadRequest) => void;
  } = {},
) {
  let currentGrant: unknown =
    options.currentGrant === undefined ? grant() : options.currentGrant;
  let rows: unknown = options.rows === undefined ? row() : options.rows;
  const requests: ProjectTaskReadRequest[] = [];
  const port: ProjectTaskContextPort = {
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
      () => timestamp,
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({
      sourceIdentity: {
        uid: 401,
        role: "user",
        qualification: "qualified",
        companyIds: [7],
      },
      model: "project.task",
      domain: [
        ["id", "=", 700],
        ["project_id", "in", [31]],
      ],
      fields: ["id", "name", "stage_id", "date_deadline"],
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
  });

  test("fails closed for a missing grant without making a source read", async () => {
    const fake = fakePort({ currentGrant: null });
    await expect(
      resolveProjectTaskContext(fake.port, principal, 700, () => timestamp),
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
            uid: 402,
            role: "user",
            qualification: "qualified",
            companyIds: [7],
          },
        }),
      });
      await expect(
        resolveProjectTaskContext(fake.port, principal, 700, () => timestamp),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(fake.requests).toHaveLength(0);
    }
  });

  test("requires a qualified nonadmin source identity", async () => {
    const invalidGrants = [
      {
        ...grant(),
        sourceIdentity: {
          uid: 401,
          role: "admin",
          qualification: "qualified",
          companyIds: [7],
        },
      },
      {
        ...grant(),
        sourceIdentity: {
          uid: 401,
          role: "user",
          qualification: "pending",
          companyIds: [7],
        },
      },
    ];
    for (const currentGrant of invalidGrants) {
      const fake = fakePort({ currentGrant });
      await expect(
        resolveProjectTaskContext(fake.port, principal, 700, () => timestamp),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(fake.requests).toHaveLength(0);
    }
  });

  test("denies guessed or out-of-grant record IDs and never accepts browser domain or fields", async () => {
    const fake = fakePort({ rows: row(701) });
    await expect(
      resolveProjectTaskContext(fake.port, principal, 700, () => timestamp),
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
    ]);
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
        resolveProjectTaskContext(fake.port, principal, 700, () => timestamp),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
    }
  });

  test("rechecks grant before model egress and stops after revocation", async () => {
    const fake = fakePort();
    const resolved = await resolveProjectTaskContext(
      fake.port,
      principal,
      700,
      () => timestamp,
    );
    fake.setGrant(grant({ active: false, revision: 2 }));
    await expect(resolved.assertCurrent(principal)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
  });
});
