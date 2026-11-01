import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { createHistoryEngine } from "../src/scout/history/runner";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedAuthority } from "../src/scout/owned/authority";
import { createOwnedRuntimeRoutes } from "../src/scout/owned/routes";
import {
  createOwnedOdooAdmission,
  parseOwnedOdooBinding,
} from "../src/scout/owned-model/odoo-binding";
import { parseModelPolicy } from "../src/scout/owned-model/policy";

type Profile = NonNullable<Awaited<ReturnType<AgentProfileStore["get"]>>>;
type Route =
  | { provider: "local"; model: string; baseUrl: string }
  | { provider: "openrouter"; model: string; apiKeyFile: string };
function fixture(identityClass?: "customer", enroll = false) {
  const userId = "native-alice",
    deploymentId = "scout-test",
    tenantId = "tenant-a";
  const membership = {
    version: 1,
    deploymentId,
    policies: [
      {
        tenantId,
        revision: 1,
        active: true,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
    memberships: [
      {
        userId,
        tenantId,
        revision: 1,
        policyRevision: 1,
        active: true,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    ],
  };
  const model = {
    version: 1,
    deploymentId,
    globalMaxConcurrent: 1,
    globalMaxCallsPerDay: 10,
    bindings: [
      {
        userId,
        tenantId,
        active: true,
        revision: 1,
        expiresAt: "2099-01-01T00:00:00Z",
        agentIds: ["scout"],
        allowConversationContext: true,
        allowPersonalInstructions: false,
        route: {
          provider: "local",
          model: "local-model",
          baseUrl: "http://127.0.0.1:11434/v1",
        } as Route,
        limits: {
          maxInputBytes: 8192,
          maxOutputTokens: 64,
          maxOutputBytes: 4096,
          maxCallsPerRun: 1,
          maxCallsPerDay: 10,
          maxConcurrent: 1,
          timeoutMs: 5000,
        },
      },
    ],
  };
  const source = {
    version: 1,
    deploymentId,
    sourceInstanceId: "odoo-test",
    bindings: [
      {
        userId,
        tenantId,
        revision: 1,
        active: true,
        expiresAt: "2099-01-01T00:00:00Z",
        sourceUid: 101,
        ...(identityClass ? { identityClass } : {}),
        companyIds: [1],
      },
    ],
  };
  let currentUser = userId,
    issued = 0,
    withdrawn = 0;
  const qualified: string[] = [];
  let afterQualification = () => {};
  let beforeConsent = () => {},
    afterStatus = () => {},
    afterModelRead = () => {};
  const readMembership = async (actor: { id: string }) =>
    parseScoutMembership(membership, actor, deploymentId);
  const authority = createOwnedAuthority({
    auth: {
      handler: () => new Response(null),
      api: {
        getSession: async ({ headers, query }) => {
          expect(query?.disableCookieCache).toBe(true);
          return headers.get("x-fixture-session") === "valid"
            ? {
                user: {
                  id: currentUser,
                  role: "user",
                  email: "same@fixture.invalid",
                },
              }
            : null;
        },
      },
    },
    roles: { rolesForUser: async () => ["user"] },
    binding: readMembership,
    profiles: {
      get: async (_actor, id) => (id === "scout" ? ({} as Profile) : null),
    },
    channels: { get: async () => null },
  });
  const admit = createOwnedOdooAdmission({
    membership: readMembership,
    binding: async (principal) =>
      parseOwnedOdooBinding(source, principal, "odoo-test"),
    sourceInstanceId: "odoo-test",
  });
  const app = createOwnedRuntimeRoutes({
    authority,
    engine: {
      bind: () => {
        throw new Error("History execution is outside this consent fixture");
      },
    } as unknown as ReturnType<typeof createHistoryEngine>,
    agents: async () => ({}),
    generativeUi: false,
    odooGrants: {
      admit,
      source: {
        sourceInstanceId: "odoo-test",
        baseUrl: "https://private-source.fixture.invalid",
        database: "private_source_db",
      },
      verifyUserProjectScope: async () => {
        if (enroll) {
          qualified.push("employee");
          afterQualification();
          return [501];
        }
        throw new Error("No Odoo calls in consent fixture");
      },
      verifyCustomerProjectScope: async (apiKey, uid, companyIds) => {
        expect(apiKey).toBe("synthetic-key");
        expect(uid).toBe(101);
        expect(companyIds).toEqual([1]);
        if (enroll) {
          qualified.push("customer");
          afterQualification();
          return [501];
        }
        throw new Error("No Odoo calls in consent fixture");
      },
      issueRecord: async (input) => {
        if (enroll) {
          expect(input.binding.identityClass).toBe(identityClass);
          expect(input.principal.userId).toBe(userId);
          expect(input.allowedProjectIds).toEqual([501]);
          return { revision: 1, projectCount: 1 };
        }
        throw new Error("No credential enrollment in consent fixture");
      },
      readModelPolicy: async (principal) => {
        const current = parseModelPolicy(model, principal);
        afterModelRead();
        return current;
      },
      status: async (_principal, provider) => {
        afterStatus();
        return { provider, record: null, release: null };
      },
      consentRelease: async (input) => {
        // Exercise the same fresh-check port the production transaction invokes
        // after lock/read/audit waits. SQL rollback is covered by its SQL suite.
        beforeConsent();
        await input.assertCurrent();
        expect(input.principal.userId).toBe(userId);
        expect(input.principal.tenantId).toBe(tenantId);
        expect(input.principal.deploymentId).toBe(deploymentId);
        issued++;
        return { revision: issued, provider: input.provider };
      },
      revokeRelease: async () => {
        throw new Error("Current policy must not be needed for withdrawal");
      },
      revokeAll: async (principal, options) => {
        expect(principal.userId).toBe(userId);
        expect(options).toEqual({
          allBindingRevisions: true,
          releasesOnly: true,
        });
        withdrawn++;
        return { revoked: true };
      },
    },
  });
  const request = (
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
    session = "valid",
  ) =>
    app.request(
      `/api/scout/odoo/context-grants${method === "GET" ? "?agentId=scout" : "/release"}`,
      {
        method,
        headers: {
          "x-fixture-session": session,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  const challenge = async () => {
    const response = await request("GET");
    expect(response.status).toBe(200);
    const status = await response.json();
    return {
      agentId: "scout",
      consent: true,
      expectedProvider: status.route.provider,
      expectedModel: status.route.model,
      expectedPolicyFingerprint: status.route.policyFingerprint,
    };
  };
  return {
    model,
    membership,
    source,
    qualified,
    afterQualification: (work: () => void) => {
      afterQualification = work;
    },
    enroll: (body: unknown = { apiKey: "synthetic-key" }) =>
      app.request("/api/scout/odoo/context-grants", {
        method: "POST",
        headers: {
          "x-fixture-session": "valid",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    request,
    challenge,
    issued: () => issued,
    withdrawn: () => withdrawn,
    currentUser: (id: string) => {
      currentUser = id;
    },
    beforeConsent: (work: () => void) => {
      beforeConsent = work;
    },
    afterStatus: (work: () => void) => {
      afterStatus = work;
    },
    afterModelRead: (work: () => void) => {
      afterModelRead = work;
    },
  };
}

describe("owned Odoo consent binds the route actually displayed", () => {
  test("existing enrollment UI selects customer qualification only from protected source mapping", async () => {
    for (const kind of [undefined, "customer"] as const) {
      const f = fixture(kind, true);
      expect((await f.enroll()).status).toBe(201);
      expect(f.qualified).toEqual([kind ?? "employee"]);
      expect(
        (
          await f.enroll({
            apiKey: "synthetic-key",
            identityClass: "customer",
            companyIds: [2],
            partnerId: 1,
          })
        ).status,
      ).toBe(400);
      expect(f.qualified).toHaveLength(1);
    }
  });
  test("customer qualification cannot write a grant after mapping, membership or session changes", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.source.bindings[0].active = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.membership.memberships[0].active = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.currentUser("native-bob");
      },
    ]) {
      const f = fixture("customer", true);
      f.afterQualification(() => change(f));
      expect((await f.enroll()).status).toBe(403);
    }
  });
  test("status exposes only public route fields and the matching challenge issues consent", async () => {
    const f = fixture();
    const response = await f.request("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const status = await response.json();
    expect(status.route).toEqual({
      provider: "local",
      model: "local-model",
      policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: "2099-01-01T00:00:00Z",
    });
    expect(JSON.stringify(status)).not.toContain("127.0.0.1");
    expect(JSON.stringify(status)).not.toContain("private-source");
    expect(JSON.stringify(status)).not.toContain("apiKey");
    expect((await f.request("POST", await f.challenge())).status).toBe(201);
    expect(f.issued()).toBe(1);
  });
  test("missing, malformed and arbitrary challenge fields cannot issue consent", async () => {
    const f = fixture(),
      expected = await f.challenge();
    for (const field of [
      "expectedProvider",
      "expectedModel",
      "expectedPolicyFingerprint",
    ] as const) {
      const incomplete = { ...expected };
      delete (incomplete as Partial<typeof expected>)[field];
      expect((await f.request("POST", incomplete)).status).toBe(400);
    }
    for (const body of [
      { ...expected, expectedPolicyFingerprint: "secret" },
      { ...expected, expectedProvider: "browser-chosen" },
      { ...expected, endpoint: "https://unapproved.invalid" },
    ])
      expect((await f.request("POST", body)).status).toBe(400);
    for (const body of [
      { ...expected, expectedProvider: "openrouter" },
      { ...expected, expectedModel: "other-model" },
      { ...expected, expectedPolicyFingerprint: "b".repeat(64) },
    ])
      expect((await f.request("POST", body)).status).toBe(409);
    expect(f.issued()).toBe(0);
  });
  test("provider, same-provider model, endpoint, revision, expiry and budget changes invalidate old consent", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].route = {
          provider: "openrouter",
          model: "remote-model",
          apiKeyFile: join(tmpdir(), "synthetic-unread-key"),
        };
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].route.model = "new-local-model";
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].route = {
          provider: "local",
          model: "local-model",
          baseUrl: "http://127.0.0.1:11435/v1",
        };
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].revision++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].expiresAt = "2098-01-01T00:00:00Z";
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].limits.maxOutputTokens++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.globalMaxCallsPerDay++;
      },
    ]) {
      const f = fixture(),
        expected = await f.challenge();
      change(f);
      expect((await f.request("POST", expected)).status).toBe(409);
      expect(f.issued()).toBe(0);
      expect((await f.request("POST", await f.challenge())).status).toBe(201);
    }
  });
  test("expired or withdrawn policy never mints from an old challenge, but withdrawal still works", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].expiresAt = "2000-01-01T00:00:00Z";
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.bindings[0].active = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.bindings[0].active = false;
      },
    ]) {
      const f = fixture(),
        expected = await f.challenge();
      change(f);
      expect((await f.request("POST", expected)).status).toBe(403);
      expect(f.issued()).toBe(0);
      expect((await f.request("DELETE", { agentId: "scout" })).status).toBe(
        200,
      );
      expect(f.withdrawn()).toBe(1);
    }
  });
  test("current native identity, membership and agent rights remain independent of the challenge", async () => {
    const f = fixture(),
      expected = await f.challenge();
    expect((await f.request("POST", expected, "missing")).status).toBe(401);
    expect(
      (await f.request("POST", { ...expected, agentId: "ungranted" })).status,
    ).toBe(403);
    f.currentUser("native-bob");
    expect((await f.request("POST", expected)).status).toBe(403);
    f.currentUser("native-alice");
    f.membership.memberships[0].active = false;
    expect((await f.request("POST", expected)).status).toBe(403);
    expect(f.issued()).toBe(0);
  });
  test("policy or identity changes while consent awaits prevent the write", async () => {
    for (const [change, expectedStatus] of [
      [
        (f: ReturnType<typeof fixture>) => {
          f.model.bindings[0].route.model = "changed-during-db-wait";
        },
        409,
      ],
      [
        (f: ReturnType<typeof fixture>) => {
          f.membership.memberships[0].revision++;
        },
        403,
      ],
      [
        (f: ReturnType<typeof fixture>) => {
          f.currentUser("native-bob");
        },
        403,
      ],
    ] as const) {
      const f = fixture(),
        expected = await f.challenge();
      f.beforeConsent(() => change(f));
      expect((await f.request("POST", expected)).status).toBe(expectedStatus);
      expect(f.issued()).toBe(0);
    }
  });
  test("status and consent recheck a policy that changes after its awaited read", async () => {
    const f = fixture(),
      expected = await f.challenge();
    f.afterModelRead(() => {
      f.model.bindings[0].revision++;
    });
    expect((await f.request("POST", expected)).status).toBe(409);
    expect(f.issued()).toBe(0);
    const status = fixture();
    status.afterStatus(() => {
      status.model.bindings[0].revision++;
    });
    expect((await status.request("GET")).status).toBe(409);
  });
});
