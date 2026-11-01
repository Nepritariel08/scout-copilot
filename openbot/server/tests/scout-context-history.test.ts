import { describe, expect, test } from "bun:test";
import { createBoundHistory } from "../src/scout/history/service";
import type { HistoryStore } from "../src/scout/history/store";
import {
  type HistoryContext,
  historyContextSchema,
} from "../src/scout/owned-model/context-dependency";
import { createContextHistory } from "../src/scout/owned-model/context-history";
import { parseModelPolicy } from "../src/scout/owned-model/policy";
import {
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  type ProjectTaskContextReleaseGrant,
  resolveProjectTaskContext,
} from "../src/scout/owned-model/record-context";

const principal = {
  userId: "alice",
  tenantId: "tenant-a",
  deploymentId: "test",
  bindingFingerprint: "a".repeat(64),
};
function fixture() {
  const policy = parseModelPolicy(
    {
      version: 1,
      deploymentId: "test",
      globalMaxConcurrent: 1,
      globalMaxCallsPerDay: 20,
      bindings: [
        {
          userId: "alice",
          tenantId: "tenant-a",
          active: true,
          revision: 1,
          expiresAt: "2099-01-01T00:00:00Z",
          agentIds: ["scout"],
          allowConversationContext: true,
          allowPersonalInstructions: false,
          route: {
            provider: "local",
            model: "synthetic",
            baseUrl: "http://127.0.0.1:9191/v1",
          },
          limits: {
            maxInputBytes: 8192,
            maxOutputTokens: 64,
            maxOutputBytes: 4096,
            maxCallsPerRun: 1,
            maxCallsPerDay: 20,
            maxConcurrent: 1,
            timeoutMs: 5000,
          },
        },
      ],
    },
    { ...principal, agentId: "scout" },
  );
  const grant: ProjectTaskContextGrant = {
    principal,
    active: true,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00Z",
    sourceIdentity: {
      instanceId: "fixture-odoo",
      uid: 401,
      role: "user",
      qualification: "qualified",
      qualificationExpiresAt: "2099-01-01T00:00:00Z",
      companyIds: [7],
      credentialRef: "00000000-0000-4000-8000-000000000401",
    },
    allowedProjectIds: [31],
  };
  const release: ProjectTaskContextReleaseGrant = {
    principal,
    active: true,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00Z",
    sourceInstanceId: "fixture-odoo",
    dataClass: "odoo.project_task_summary.v1",
    provider: "local",
    modelPolicyFingerprint: policy.fingerprint,
  };
  const state = {
    context: { version: 1, revision: 0, dependencies: [] } as HistoryContext,
    grant,
    release,
    policy,
    denied: false,
    name: "SYNTHETIC_PRIVATE_RECORD_PAYLOAD",
    afterRead: () => {},
    writes: 0,
  };
  const port: ProjectTaskContextPort = {
    sourceInstanceId: "fixture-odoo",
    getGrant: async () => state.grant,
    getReleaseGrant: async () => state.release,
    readProjectTask: async (request) => {
      if (state.denied) throw new Error("Synthetic Odoo ACL denial");
      state.afterRead();
      return [
        {
          id: request.domain[0][2],
          name: state.name,
          stage_id: null,
          date_deadline: null,
          company_id: [7, "Synthetic company"],
        },
      ];
    },
  };
  const store = {
    markRun: async () => {},
    read: async () => structuredClone(state.context),
    append: async (
      _principal: unknown,
      _thread: string,
      _agent: string,
      _run: string,
      dependency: HistoryContext["dependencies"][number],
    ) => {
      state.writes++;
      state.context.dependencies.push(dependency);
      state.context.revision++;
    },
  };
  const history = createContextHistory({
    store,
    recordContext: port,
    readPolicy: async () => state.policy,
  });
  const selected = () =>
    resolveProjectTaskContext(
      port,
      principal,
      700,
      "local",
      policy.fingerprint,
    );
  return { state, store, port, history, selected };
}
describe("owned durable contextual history authorization", () => {
  test("selected-turn provenance persists without source payload; an ordinary continuation requires the same current authority", async () => {
    const f = fixture();
    const context = await f.selected();
    expect(context.prompt).toContain(f.state.name);
    expect(JSON.stringify(context.dependency)).not.toContain(f.state.name);
    expect(JSON.stringify(context.dependency)).not.toContain("credentialRef");
    await f.history.remember(
      principal,
      "thread",
      "scout",
      "run",
      context.dependency,
    );
    expect(f.state.writes).toBe(1);
    await f.history.assertCurrent(principal, "thread", "scout");
    f.state.release.active = false;
    await expect(
      f.history.assertCurrent(principal, "thread", "scout"),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
  });
  test.each([
    "source",
    "release",
    "route",
    "content",
    "acl",
    "native",
    "membership",
    "tenant",
  ] as const)(
    "saved history refuses current %s changes without a new selector",
    async (change) => {
      const f = fixture(),
        selected = await f.selected();
      await f.history.remember(
        principal,
        "thread",
        "scout",
        "run",
        selected.dependency,
      );
      let caller = principal;
      if (change === "source") f.state.grant.active = false;
      if (change === "release") f.state.release.revision++;
      if (change === "route") f.state.policy.fingerprint = "f".repeat(64);
      if (change === "content") f.state.name = "Changed source record";
      if (change === "acl") f.state.denied = true;
      if (change === "native") caller = { ...principal, userId: "bob" };
      if (change === "membership")
        caller = { ...principal, bindingFingerprint: "b".repeat(64) };
      if (change === "tenant") caller = { ...principal, tenantId: "tenant-b" };
      await expect(
        f.history.assertCurrent(caller, "thread", "scout"),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
    },
  );
  test("dependencies are transitive and an older source still gates a later contextual answer", async () => {
    const f = fixture(),
      first = await f.selected();
    await f.history.remember(
      principal,
      "thread",
      "scout",
      "one",
      first.dependency,
    );
    const second = await resolveProjectTaskContext(
      f.port,
      principal,
      701,
      "local",
      f.state.policy.fingerprint,
    );
    await f.history.remember(
      principal,
      "thread",
      "scout",
      "two",
      second.dependency,
    );
    expect(f.state.context.dependencies.map((d) => d.recordId)).toEqual([
      700, 701,
    ]);
    f.state.grant.revision++;
    await expect(
      f.history.assertCurrent(principal, "thread", "scout"),
    ).rejects.toThrow();
    expect(f.state.context.dependencies).toHaveLength(2);
  });
  test("unknown provenance and concurrent dependency additions deny; a new source-free thread needs no Odoo/model route", async () => {
    const f = fixture();
    const empty = createContextHistory({ store: f.store });
    await empty.assertCurrent(principal, "thread", "scout");
    for (const invalid of [
      null,
      {},
      { version: 2, revision: 0, dependencies: [] },
      { version: 1, revision: 1, dependencies: [] },
    ]) {
      expect(historyContextSchema.safeParse(invalid).success).toBe(false);
      await expect(
        createContextHistory({
          store: { ...f.store, read: async () => invalid as HistoryContext },
        }).assertCurrent(principal, "thread", "scout"),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
    }
    const selected = await f.selected();
    await f.history.remember(
      principal,
      "thread",
      "scout",
      "one",
      selected.dependency,
    );
    f.state.afterRead = () => {
      f.state.context = {
        ...f.state.context,
        revision: 2,
        dependencies: [
          ...f.state.context.dependencies,
          { ...selected.dependency, recordId: 701 },
        ],
      };
      f.state.afterRead = () => {};
    };
    await expect(
      f.history.assertCurrent(principal, "thread", "scout"),
    ).rejects.toThrow();
  });
  test("history display, replay and run use the context hook; cancellation remains available after source revocation", async () => {
    let allowed = true,
      reads = 0;
    const store = {
      get: async () => ({ id: "thread", agentId: "scout", channelId: null }),
      snapshot: async () => {
        reads++;
        return { messages: [] };
      },
      page: async () => {
        reads++;
        return { events: [] };
      },
      stop: async () => true,
    } as unknown as HistoryStore;
    const history = createBoundHistory(store, {
      principal: async () => principal,
      authorize: async () => true,
      authorizeContext: async () => {
        if (!allowed) throw new Error("CONTEXT_REVOKED");
      },
    });
    await history.snapshot("thread");
    expect(reads).toBe(1);
    allowed = false;
    await expect(history.snapshot("thread")).rejects.toThrow("CONTEXT_REVOKED");
    await expect(history.page("thread")).rejects.toThrow("CONTEXT_REVOKED");
    await expect(history.check("thread", "run", "scout")).rejects.toThrow(
      "CONTEXT_REVOKED",
    );
    expect(reads).toBe(1);
    expect(await history.stop("thread", "run")).toBe(true);
  });
});
