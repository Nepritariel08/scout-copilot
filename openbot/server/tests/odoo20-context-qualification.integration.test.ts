import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createOdooJson2ProjectTaskReader } from "../src/scout/owned-model/odoo-json2";
import type { ProjectTaskReadRequest } from "../src/scout/owned-model/record-context";

type Fixture = {
  database: string;
  sourceInstanceId: string;
  companies: { a: number; b: number };
  users: Record<
    "employeeA" | "employeeB" | "portalA" | "portalB" | "admin",
    number
  >;
  groups: { internal: number; portal: number; projectUser: number };
  projects: { employeeA: number; employeeB: number; secondCompany: number };
  tasks: { employeeA: number; employeeB: number; secondCompany: number };
};

type Credentials = Record<
  "employeeA" | "employeeB" | "portalA" | "portalB" | "admin",
  string
>;

const configured = Boolean(
  process.env.SCOUT_ODOO20_BASE_URL &&
    process.env.SCOUT_ODOO20_FIXTURE_FILE &&
    process.env.SCOUT_ODOO20_CREDENTIALS_FILE &&
    process.env.SCOUT_ODOO20_REPORT_FILE,
);

const taskFields = [
  "id",
  "name",
  "stage_id",
  "date_deadline",
  "company_id",
] as const;
const principal = {
  userId: "qualification-native-user",
  tenantId: "qualification-tenant",
  deploymentId: "qualification-deployment",
  bindingFingerprint: "a".repeat(64),
};
const credentialRefs = {
  employeeA: "10000000-0000-4000-8000-000000000001",
  employeeB: "10000000-0000-4000-8000-000000000002",
  portalA: "10000000-0000-4000-8000-000000000003",
  portalB: "10000000-0000-4000-8000-000000000004",
  admin: "10000000-0000-4000-8000-000000000005",
  mismatchedEmployeeBKey: "10000000-0000-4000-8000-000000000006",
};

function makeRequest(
  fixture: Fixture,
  user: keyof Fixture["users"],
  recordId: number,
  projectId: number,
  companyIds: number[],
  credentialRef = credentialRefs[user],
): ProjectTaskReadRequest {
  return {
    principal,
    sourceIdentity: {
      instanceId: fixture.sourceInstanceId,
      uid: fixture.users[user],
      role: "user",
      qualification: "qualified",
      qualificationExpiresAt: "2099-01-01T00:00:00.000Z",
      companyIds,
      credentialRef,
    },
    model: "project.task",
    domain: [
      ["id", "=", recordId],
      ["project_id", "in", [projectId]],
    ],
    fields: taskFields,
    limit: 1,
    maxBytes: 4096,
  };
}

function jsonRequest(
  url: URL,
  database: string,
  apiKey: string,
  body: Record<string, unknown>,
) {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `bearer ${apiKey}`,
      "content-type": "application/json; charset=utf-8",
      "x-odoo-database": database,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
}

describe.skipIf(!configured)(
  "real Odoo 20 JSON-2 context qualification",
  () => {
    test("enforces actual user, company, project, field, and revocation boundaries", async () => {
      const fixture = JSON.parse(
        await readFile(process.env.SCOUT_ODOO20_FIXTURE_FILE!, "utf8"),
      ) as Fixture;
      const credentials = JSON.parse(
        await readFile(process.env.SCOUT_ODOO20_CREDENTIALS_FILE!, "utf8"),
      ) as Credentials;
      const baseUrl = process.env.SCOUT_ODOO20_BASE_URL!;
      const calls: Array<{ path: string; method: string; body: unknown }> = [];
      const transport: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.startsWith("/json/2/")) {
            let body: unknown;
            try {
              body = JSON.parse(String(init?.body ?? "{}"));
            } catch {
              body = null;
            }
            calls.push({
              path: url.pathname,
              method: String(init?.method ?? "GET"),
              body,
            });
          }
          return fetch(input, init);
        },
        { preconnect: fetch.preconnect },
      );
      const reader = createOdooJson2ProjectTaskReader({
        instanceId: fixture.sourceInstanceId,
        baseUrl,
        database: fixture.database,
        credentials: {
          resolveForUid: async (uid, credentialRef) => {
            const refToUser: Record<string, keyof Credentials> = {
              [credentialRefs.employeeA]: "employeeA",
              [credentialRefs.employeeB]: "employeeB",
              [credentialRefs.portalA]: "portalA",
              [credentialRefs.portalB]: "portalB",
              [credentialRefs.admin]: "admin",
              [credentialRefs.mismatchedEmployeeBKey]: "employeeB",
            };
            const account = refToUser[credentialRef];
            if (!account) return null;
            // For the deliberate mismatch case return the expected UID paired with
            // another user's real key. Odoo's context_get must catch the mismatch.
            return { uid, apiKey: credentials[account] };
          },
        },
        fetch: transport,
      });

      const versionResponse = await fetch(new URL("/web/version", baseUrl), {
        signal: AbortSignal.timeout(5000),
      });
      expect(versionResponse.ok).toBe(true);
      const version = (await versionResponse.json()) as {
        version?: unknown;
        version_info?: unknown[];
      };
      expect(version.version).toBe("20.0");
      expect(Array.isArray(version.version_info)).toBe(true);
      expect(version.version_info?.[0]).toBe(20);
      expect(version.version_info?.[1]).toBe(0);

      const aProjects = await reader.verifyUserProjectScope(
        credentials.employeeA,
        fixture.users.employeeA,
        [fixture.companies.a],
      );
      expect(aProjects).toEqual([fixture.projects.employeeA]);

      const bCompanyAProjects = await reader.verifyUserProjectScope(
        credentials.employeeB,
        fixture.users.employeeB,
        [fixture.companies.a],
      );
      expect(bCompanyAProjects).toEqual([fixture.projects.employeeB]);

      const bBothCompanyProjects = await reader.verifyUserProjectScope(
        credentials.employeeB,
        fixture.users.employeeB,
        [fixture.companies.a, fixture.companies.b],
      );
      expect(bBothCompanyProjects).toEqual(
        [fixture.projects.employeeB, fixture.projects.secondCompany].sort(
          (left, right) => left - right,
        ),
      );

      await expect(
        reader.readProjectTask(
          makeRequest(
            fixture,
            "employeeB",
            fixture.tasks.secondCompany,
            fixture.projects.secondCompany,
            [fixture.companies.a],
          ),
        ),
      ).resolves.toEqual([]);

      calls.length = 0;
      const task = await reader.readProjectTask(
        makeRequest(
          fixture,
          "employeeA",
          fixture.tasks.employeeA,
          fixture.projects.employeeA,
          [fixture.companies.a],
        ),
      );
      if (!Array.isArray(task)) throw new Error("Expected task result array");
      expect(task).toHaveLength(1);
      expect(task[0]).toMatchObject({
        id: fixture.tasks.employeeA,
        name: "Scout qualification employee A task",
        company_id: [fixture.companies.a, "Scout Qualification Company A"],
        date_deadline: null,
      });
      expect(
        task[0].stage_id === null ||
          (Array.isArray(task[0].stage_id) && task[0].stage_id.length === 2),
      ).toBe(true);
      expect(Object.keys(task[0]).sort()).toEqual([...taskFields].sort());
      const taskCall = calls.find(
        (call) => call.path === "/json/2/project.task/search_read",
      );
      expect(taskCall).toBeDefined();
      expect(taskCall?.body).toMatchObject({
        fields: taskFields,
        limit: 1,
        domain: [
          ["id", "=", fixture.tasks.employeeA],
          ["project_id", "in", [fixture.projects.employeeA]],
        ],
        context: { allowed_company_ids: [fixture.companies.a] },
      });

      calls.length = 0;
      await expect(
        reader.readProjectTask(
          makeRequest(
            fixture,
            "employeeA",
            fixture.tasks.employeeB,
            fixture.projects.employeeA,
            [fixture.companies.a],
          ),
        ),
      ).resolves.toEqual([]);
      expect(
        calls.filter(
          (call) => call.path === "/json/2/project.task/search_read",
        ),
      ).toHaveLength(1);

      // Even if a caller supplies the other employee's project ID as its scope,
      // Odoo's own project/task record rules must still hide that task.
      await expect(
        reader.readProjectTask(
          makeRequest(
            fixture,
            "employeeA",
            fixture.tasks.employeeB,
            fixture.projects.employeeB,
            [fixture.companies.a],
          ),
        ),
      ).resolves.toEqual([]);

      for (const portal of ["portalA", "portalB"] as const) {
        calls.length = 0;
        await expect(
          reader.verifyUserProjectScope(
            credentials[portal],
            fixture.users[portal],
            [fixture.companies.a],
          ),
        ).rejects.toThrow();
        expect(
          calls.some(
            (call) => call.path === "/json/2/project.project/search_read",
          ),
        ).toBe(false);
        expect(
          calls.some(
            (call) => call.path === "/json/2/project.task/search_read",
          ),
        ).toBe(false);
      }

      calls.length = 0;
      await expect(
        reader.readProjectTask(
          makeRequest(
            fixture,
            "admin",
            fixture.tasks.employeeA,
            fixture.projects.employeeA,
            [fixture.companies.a],
          ),
        ),
      ).rejects.toThrow();
      expect(
        calls.some((call) => call.path === "/json/2/project.task/search_read"),
      ).toBe(false);

      calls.length = 0;
      await expect(
        reader.readProjectTask(
          makeRequest(
            fixture,
            "employeeA",
            fixture.tasks.employeeA,
            fixture.projects.employeeA,
            [fixture.companies.a],
            credentialRefs.mismatchedEmployeeBKey,
          ),
        ),
      ).rejects.toThrow();
      expect(
        calls.some((call) => call.path === "/json/2/project.task/search_read"),
      ).toBe(false);

      // Delete the source record with the disposable administrator. The next read
      // uses the same employee grant/key, but Odoo must return no current record.
      const deleteResponse = await jsonRequest(
        new URL("/json/2/project.task/unlink", baseUrl),
        fixture.database,
        credentials.admin,
        { ids: [fixture.tasks.employeeA] },
      );
      expect(deleteResponse.ok).toBe(true);
      await deleteResponse.arrayBuffer();
      await expect(
        reader.readProjectTask(
          makeRequest(
            fixture,
            "employeeA",
            fixture.tasks.employeeA,
            fixture.projects.employeeA,
            [fixture.companies.a],
          ),
        ),
      ).resolves.toEqual([]);

      // Remove employee B's current internal/project groups. Existing API key and
      // old qualification snapshot remain, so the next adapter call must still deny.
      const revokeResponse = await jsonRequest(
        new URL("/json/2/res.users/write", baseUrl),
        fixture.database,
        credentials.admin,
        {
          ids: [fixture.users.employeeB],
          vals: { group_ids: [[6, 0, [fixture.groups.portal]]] },
        },
      );
      expect(revokeResponse.ok).toBe(true);
      await revokeResponse.arrayBuffer();
      calls.length = 0;
      await expect(
        reader.verifyUserProjectScope(
          credentials.employeeB,
          fixture.users.employeeB,
          [fixture.companies.a, fixture.companies.b],
        ),
      ).rejects.toThrow();
      expect(
        calls.some(
          (call) => call.path === "/json/2/project.project/search_read",
        ),
      ).toBe(false);

      const report = {
        qualification: "passed",
        source: {
          serverVersion: version.version,
          imageRef: process.env.SCOUT_ODOO20_IMAGE_REF ?? "unspecified",
        },
        fixture: "synthetic-disposable-two-company",
        assertions: [
          "employee project visibility and company scoping",
          "second-company task hidden when request context allows only company A",
          "exact task fields and Odoo project/task record rule despite wider request scope",
          "portal A and portal B denied before project/task read",
          "administrator denied before task read",
          "Odoo UID/key mismatch denied before task read",
          "deleted source task not returned on re-read",
          "live internal-group revocation denied before project read",
        ],
      };
      await writeFile(
        process.env.SCOUT_ODOO20_REPORT_FILE!,
        JSON.stringify(report, null, 2),
        {
          mode: 0o600,
          flag: "w",
        },
      );
      console.log(JSON.stringify(report));
    });
  },
);
