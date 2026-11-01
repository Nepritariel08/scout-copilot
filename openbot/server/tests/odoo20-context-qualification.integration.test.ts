import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import {
  createOdooJson2ProjectTaskReader,
  createOdooJson2ReadTransport,
} from "../src/scout/owned-model/odoo-json2";
import { createOdooJson2CustomerTaskReader } from "../src/scout/owned-model/odoo-json2-customer";
import type { ProjectTaskReadRequest } from "../src/scout/owned-model/record-context";
import {
  customerClassificationMatches,
  customerClassificationReport,
  customerGroupExpectations,
} from "./fixtures/odoo20-customer-classification";

type Fixture = {
  database: string;
  sourceInstanceId: string;
  companies: { a: number; b: number };
  users: Record<
    "employeeA" | "employeeB" | "portalA" | "portalB" | "admin",
    number
  >;
  groups: { internal: number; portal: number; projectUser: number };
  projects: Record<
    "employeeA" | "employeeB" | "secondCompany" | "portalA" | "portalB",
    number
  >;
  tasks: Record<
    "employeeA" | "employeeB" | "secondCompany" | "portalA" | "portalB",
    number
  >;
  collaborators: Record<"portalA" | "portalB", number>;
  customerClassification: Record<"portalA" | "portalB", unknown>;
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
      const customerReader = createOdooJson2CustomerTaskReader({
        instanceId: fixture.sourceInstanceId,
        baseUrl,
        database: fixture.database,
        credentials: {
          resolveForUid: async (uid, credentialRef) => {
            const portal = (["portalA", "portalB"] as const).find(
              (user) =>
                credentialRef === credentialRefs[user] &&
                fixture.users[user] === uid,
            );
            return portal ? { uid, apiKey: credentials[portal] } : null;
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
      expect(version.version).toBe("20.0-20261015");
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

      // Positive customer access uses the separate portal adapter. Exercise
      // ordinary caller ACLs before any stock portal has_group diagnostic can
      // populate an empty UID-only membership cache in the Odoo web process.
      const classificationReports: ReturnType<
        typeof customerClassificationReport
      >[] = [];
      const attestations: { portal: "portalA" | "portalB"; value: unknown }[] =
        [];
      for (const portal of ["portalA", "portalB"] as const) {
        const seedReport = customerClassificationReport(
          portal,
          "seed",
          fixture.customerClassification[portal],
        );
        console.log(JSON.stringify(seedReport));
        classificationReports.push(seedReport);
        const post = createOdooJson2ReadTransport({
          baseUrl,
          database: fixture.database,
          fetch: transport,
        });
        const attestation = await post(
          "res.users",
          "scout_own_identity_v1",
          credentials[portal],
          {},
          2048,
        );
        attestations.push({ portal, value: attestation });
        const attestationReport = customerClassificationReport(
          portal,
          "attestation",
          attestation &&
            typeof attestation === "object" &&
            !Array.isArray(attestation)
            ? (attestation as Record<string, unknown>).groups
            : null,
        );
        console.log(JSON.stringify(attestationReport));
        classificationReports.push(attestationReport);
      }
      // Collect both customers' four seed/attestation reports before asserting.
      for (const report of classificationReports)
        expect(customerClassificationMatches(report)).toBe(true);
      for (const { portal, value } of attestations)
        expect(value).toEqual({
          contract: "scout-own-identity-v1",
          uid: fixture.users[portal],
          groups: Object.fromEntries(customerGroupExpectations),
        });
      for (const body of [
        { ids: [fixture.users.portalB] },
        { uid: fixture.users.portalB },
        { group_ext_id: "base.group_system" },
      ]) {
        const response = await jsonRequest(
          new URL("/json/2/res.users/scout_own_identity_v1", baseUrl),
          fixture.database,
          credentials.portalA,
          body,
        );
        expect(response.status).toBe(422);
        await response.arrayBuffer();
      }

      for (const portal of ["portalA", "portalB"] as const) {
        expect(
          await customerReader.verifyUserProjectScope(
            credentials[portal],
            fixture.users[portal],
            [fixture.companies.a],
          ),
        ).toEqual([fixture.projects[portal]]);
        const own = await customerReader.readProjectTask(
          makeRequest(
            fixture,
            portal,
            fixture.tasks[portal],
            fixture.projects[portal],
            [fixture.companies.a],
          ),
        );
        if (!Array.isArray(own))
          throw new Error("Expected customer task result array");
        expect(own).toHaveLength(1);
        expect(own[0]).toMatchObject({
          id: fixture.tasks[portal],
          name: `Scout qualification ${portal} task`,
          date_deadline: null,
          company_id: [fixture.companies.a, "Scout Qualification Company A"],
        });
        expect(Object.keys(own[0]).sort()).toEqual([...taskFields].sort());
        expect(
          own[0].stage_id === null ||
            (Array.isArray(own[0].stage_id) && own[0].stage_id.length === 2),
        ).toBe(true);
        const other = portal === "portalA" ? "portalB" : "portalA";
        expect(
          await customerReader.readProjectTask(
            makeRequest(
              fixture,
              portal,
              fixture.tasks[other],
              fixture.projects[portal],
              [fixture.companies.a],
            ),
          ),
        ).toEqual([]);
        // Even a forged wider local scope cannot bypass authoritative Odoo
        // project/task ACLs for another customer within the same company.
        await expect(
          customerReader.readProjectTask(
            makeRequest(
              fixture,
              portal,
              fixture.tasks[other],
              fixture.projects[other],
              [fixture.companies.a],
            ),
          ),
        ).rejects.toThrow();
      }

      const withdrawCustomer = await jsonRequest(
        new URL("/json/2/project.collaborator/unlink", baseUrl),
        fixture.database,
        credentials.admin,
        { ids: [fixture.collaborators.portalA] },
      );
      expect(withdrawCustomer.ok).toBe(true);
      await withdrawCustomer.arrayBuffer();
      await expect(
        customerReader.readProjectTask(
          makeRequest(
            fixture,
            "portalA",
            fixture.tasks.portalA,
            fixture.projects.portalA,
            [fixture.companies.a],
          ),
        ),
      ).rejects.toThrow();
      // Customer B remains usable after customer A's relationship is withdrawn.
      expect(
        await customerReader.readProjectTask(
          makeRequest(
            fixture,
            "portalB",
            fixture.tasks.portalB,
            fixture.projects.portalB,
            [fixture.companies.a],
          ),
        ),
      ).toHaveLength(1);

      // Preserve the employee contract for the SAME keys, but perform these
      // stock has_group calls after all positive customer ACL reads. Odoo may
      // cache a filtered relation across requests; Scout never clears that cache
      // or substitutes attestation for business ACLs. The addon transaction test
      // separately reproduces a cold/poisoned cache within one transaction.
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
        const post = createOdooJson2ReadTransport({
          baseUrl,
          database: fixture.database,
          fetch: transport,
        });
        const currentGroups: Record<string, unknown> = {};
        for (const [group] of customerGroupExpectations) {
          try {
            currentGroups[group] = await post(
              "res.users",
              "has_group",
              credentials[portal],
              { ids: [fixture.users[portal]], group_ext_id: group },
              1024,
            );
          } catch {
            currentGroups[group] = null;
          }
        }
        // Diagnostic only. Warm/cold cache differences supply no authority.
        console.log(
          JSON.stringify(
            customerClassificationReport(portal, "json2", currentGroups),
          ),
        );
      }

      const promoteCustomer = await jsonRequest(
        new URL("/json/2/res.users/write", baseUrl),
        fixture.database,
        credentials.admin,
        {
          ids: [fixture.users.portalB],
          vals: {
            group_ids: [
              [6, 0, [fixture.groups.internal, fixture.groups.projectUser]],
            ],
          },
        },
      );
      expect(promoteCustomer.ok).toBe(true);
      await promoteCustomer.arrayBuffer();
      calls.length = 0;
      await expect(
        customerReader.verifyUserProjectScope(
          credentials.portalB,
          fixture.users.portalB,
          [fixture.companies.a],
        ),
      ).rejects.toThrow();
      expect(
        calls.some(
          (call) => call.path === "/json/2/project.project/search_read",
        ),
      ).toBe(false);

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
          "separate portal customer adapter permits each invited customer's exact task summary",
          "own-identity attestation returns exact current portal groups and refuses caller-selected UID/group/record IDs",
          "same-company portal customers cannot read each other's projects/tasks",
          "live customer collaboration withdrawal denies old grants despite task-follower relationship",
          "customer-to-internal identity change denied by customer adapter before project read",
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
