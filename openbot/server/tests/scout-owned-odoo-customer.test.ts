import { describe, expect, test } from "bun:test";
import { createOdooJson2CustomerTaskReader } from "../src/scout/owned-model/odoo-json2-customer";
import type { ProjectTaskReadRequest } from "../src/scout/owned-model/record-context";

function request(
  uid = 401,
  task = 700,
  projects = [31],
): ProjectTaskReadRequest {
  return {
    principal: {
      userId: `native-${uid}`,
      tenantId: "same-tenant",
      deploymentId: "test",
      bindingFingerprint: "a".repeat(64),
    },
    sourceIdentity: {
      instanceId: "odoo-test",
      uid,
      role: "user",
      qualification: "qualified",
      qualificationExpiresAt: "2099-01-01T00:00:00Z",
      companyIds: [7],
      credentialRef: "00000000-0000-4000-8000-000000000401",
    },
    model: "project.task",
    domain: [
      ["id", "=", task],
      ["project_id", "in", projects],
    ],
    fields: ["id", "name", "stage_id", "date_deadline", "company_id"],
    limit: 1,
    maxBytes: 4096,
  };
}
function fixture(uid = 401) {
  const state = {
    actualUid: uid,
    kind: "portal" as "portal" | "employee" | "admin" | "public" | "unknown",
    projects: uid === 401 ? [31] : [32],
    company: 7,
    afterTask: () => {},
    groupOverride: undefined as unknown,
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const reader = createOdooJson2CustomerTaskReader({
    instanceId: "odoo-test",
    baseUrl: "http://127.0.0.1:8069",
    database: "synthetic_odoo",
    credentials: {
      resolveForUid: async (expected, ref, principal) => {
        expect(expected).toBe(uid);
        expect(ref).toBe(request(uid).sourceIdentity.credentialRef);
        expect(principal.userId).toBe(`native-${uid}`);
        return { uid, apiKey: "synthetic-portal-key" };
      },
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "bearer synthetic-portal-key",
      );
      if (path.endsWith("context_get"))
        return Response.json({ uid: state.actualUid });
      if (path.endsWith("has_group")) {
        if (state.groupOverride !== undefined)
          return Response.json(state.groupOverride);
        return Response.json(
          state.kind === "portal"
            ? body.group_ext_id === "base.group_portal"
            : state.kind === "employee"
              ? body.group_ext_id === "base.group_user"
              : state.kind === "admin"
                ? ["base.group_portal", "base.group_system"].includes(
                    String(body.group_ext_id),
                  )
                : false,
        );
      }
      expect(body.context).toEqual({ allowed_company_ids: [7] });
      if (path === "/json/2/project.project/search_read") {
        expect(body).toEqual({
          context: { allowed_company_ids: [7] },
          domain: [["company_id", "in", [7]]],
          fields: ["id", "company_id"],
          limit: 101,
        });
        return Response.json(
          state.projects.map((id) => ({
            id,
            company_id: [state.company, "Synthetic company"],
          })),
        );
      }
      expect(path).toBe("/json/2/project.task/search_read");
      const [[, , selected], [, , scope]] = body.domain as [
        unknown,
        unknown,
        number | number[],
      ][];
      const rows = [
        { id: 700, project: 31 },
        { id: 701, project: 32 },
      ]
        .filter(
          (task) =>
            task.id === selected &&
            state.projects.includes(task.project) &&
            (scope as number[]).includes(task.project),
        )
        .map((task) => ({
          id: task.id,
          name: `Synthetic customer ${task.id}`,
          stage_id: false,
          date_deadline: false,
          company_id: [7, "Synthetic company"],
        }));
      state.afterTask();
      return Response.json(rows);
    }) as unknown as typeof fetch,
  });
  return { state, calls, reader };
}

describe("separately selected portal customer task reader", () => {
  test("qualifies exact bearer identity and invited-project ACL, then reads only fixed summary fields", async () => {
    const f = fixture();
    expect(
      await f.reader.verifyUserProjectScope("synthetic-portal-key", 401, [7]),
    ).toEqual([31]);
    f.calls.length = 0;
    expect(await f.reader.readProjectTask(request())).toEqual([
      {
        id: 700,
        name: "Synthetic customer 700",
        stage_id: null,
        date_deadline: null,
        company_id: [7, "Synthetic company"],
      },
    ]);
    const task = f.calls.find(
      (call) => call.path === "/json/2/project.task/search_read",
    );
    expect(task?.body).toEqual({
      context: { allowed_company_ids: [7] },
      domain: [
        ["id", "=", 700],
        ["project_id", "in", [31]],
      ],
      fields: request().fields,
      limit: 1,
    });
    expect(
      f.calls.filter(
        (call) => call.path === "/json/2/project.project/search_read",
      ),
    ).toHaveLength(2);
    expect(
      f.calls.every((call) => !JSON.stringify(call.body).includes("sudo")),
    ).toBe(true);
  });
  test("two portal customers in the same company cannot read each other's task or broaden to the other project", async () => {
    const a = fixture(401),
      b = fixture(402);
    expect(
      await b.reader.readProjectTask(request(402, 701, [32])),
    ).toHaveLength(1);
    expect(await a.reader.readProjectTask(request(401, 701, [31]))).toEqual([]);
    expect(await a.reader.readProjectTask(request(401, 701, [31, 32]))).toEqual(
      [],
    );
    a.calls.length = 0;
    await expect(
      a.reader.readProjectTask(request(401, 701, [32])),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(a.calls.some((call) => call.path.includes("project.task"))).toBe(
      false,
    );
  });
  test.each(["employee", "admin", "public", "unknown"] as const)(
    "refuses %s identities before any project/task read",
    async (kind) => {
      const f = fixture();
      f.state.kind = kind;
      await expect(f.reader.readProjectTask(request())).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(f.calls.some((call) => call.path.includes("project."))).toBe(
        false,
      );
    },
  );
  test("UID/key mismatch, malformed classification and cross-company scope fail closed", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.state.actualUid = 402;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.groupOverride = "true";
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.company = 8;
      },
    ]) {
      const f = fixture();
      change(f);
      await expect(f.reader.readProjectTask(request())).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(f.calls.some((call) => call.path.includes("project.task"))).toBe(
        false,
      );
    }
  });
  test("old grants and task-follower access cannot survive missing current project collaboration", async () => {
    const f = fixture();
    f.state.projects = [];
    await expect(f.reader.readProjectTask(request())).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(f.calls.some((call) => call.path.includes("project.task"))).toBe(
      false,
    );
  });
  test.each(["collaboration", "classification"] as const)(
    "withholds a task if %s is revoked during its read",
    async (kind) => {
      const f = fixture();
      f.state.afterTask = () => {
        if (kind === "collaboration") f.state.projects = [];
        else f.state.kind = "employee";
      };
      await expect(f.reader.readProjectTask(request())).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(
        f.calls.filter((call) => call.path.includes("project.task")),
      ).toHaveLength(1);
    },
  );
  test("request/model controlled field, company, method and scope shapes cannot broaden the fixed read", async () => {
    for (const invalid of [
      { ...request(), model: "res.partner" },
      { ...request(), fields: [...request().fields, "description"] },
      { ...request(), limit: 2 },
      { ...request(), domain: [["id", "=", 700]] },
      {
        ...request(),
        sourceIdentity: { ...request().sourceIdentity, companyIds: ["7"] },
      },
    ]) {
      const f = fixture();
      await expect(
        f.reader.readProjectTask(invalid as ProjectTaskReadRequest),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      expect(f.calls).toHaveLength(0);
    }
  });
});
