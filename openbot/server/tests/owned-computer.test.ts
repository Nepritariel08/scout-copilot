import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createSameOriginGuard } from "../src/auth/same-origin";
import type { PageFrameStore } from "../src/computer/page-frames";
import { evaluateActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import { createInMemorySnapshotStore } from "../src/computer/snapshot-store";
import { historyDigest } from "../src/scout/history/protocol";
import { ownedApiAllowed } from "../src/scout/owned/capabilities";
import {
  type OwnedComputerRuntime,
  parseOwnedComputerBindings,
  privateComputerId,
} from "../src/scout/owned-computer/bindings";
import {
  OWNED_COMPUTER_EGRESS,
  OWNED_COMPUTER_POLICY,
  PUBLIC_COMPUTER_URL,
  publicComputerUrl,
} from "../src/scout/owned-computer/policy";
import { boundedComputerFetch } from "../src/scout/owned-computer/provider";
import { createOwnedComputerRoutes } from "../src/scout/owned-computer/routes";
import { createOwnedComputerService } from "../src/scout/owned-computer/service";

// Synthetic data only. The actual MIT gateway, policy engine and Hono serializer run below;
// no supervisor, browser, database, native session or external website is contacted.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=";
const future = "2099-01-01T00:00:00.000Z";
const agentId = "scout";
const initialConfig = () => ({
  version: 1,
  deploymentId: "computer-test",
  supervisorUrl: "http://127.0.0.1:18089/",
  supervisorTokenFile: resolve("synthetic", "supervisor-token"),
  computerTokenFile: resolve("synthetic", "computer-token"),
  grants: [
    {
      userId: "alice",
      tenantId: "tenant-a",
      agentId,
      revision: 1,
      active: true,
      expiresAt: future,
    },
  ],
});
type Event = Parameters<AuditStore["insert"]>[0];
type Frame = Parameters<PageFrameStore["save"]>[0];
function fixture(useActualSupervisor = false) {
  let runtime: OwnedComputerRuntime = {
    ...parseOwnedComputerBindings(initialConfig(), "computer-test"),
    supervisorToken: "a".repeat(32),
    computerToken: "b".repeat(32),
    fingerprint: "c".repeat(64),
  };
  let nativeRevision = 1;
  let profileVisible = true;
  let url = "about:blank";
  let ready = true;
  let shared = false;
  let pushOk = true;
  let containerExists = true;
  let screenshotUrl: string | undefined;
  let text = "This domain is for use in illustrative examples.";
  let hook: ((path: string, init?: RequestInit) => Promise<void>) | undefined;
  const calls: string[] = [];
  const providerIds: string[] = [];
  const events: Event[] = [];
  const savedFrames: Frame[] = [];
  const snapshots = createInMemorySnapshotStore();
  const privateId = privateComputerId(
    "computer-test",
    "tenant-a",
    "alice",
    agentId,
  );
  const frames: PageFrameStore = {
    async save(value) {
      savedFrames.push(value);
    },
    async load(id, toolCallId) {
      const value = savedFrames.find(
        (frame) => frame.computerId === id && frame.toolCallId === toolCallId,
      );
      return value
        ? { url: value.url, title: value.title ?? null, frame: value.frame }
        : null;
    },
    async clear() {
      throw new Error("Unexpected clear");
    },
    async purge() {
      throw new Error("Unexpected purge");
    },
  };
  async function binding(request: Request) {
    const userId = request.headers.get("x-fixture-user") ?? "alice";
    const person: AuthenticatedActor = {
      id: userId,
      email: `${userId}@example.invalid`,
      role: userId === "admin" ? "admin" : "user",
    };
    return {
      person,
      policy: {
        userId,
        tenantId: request.headers.get("x-fixture-tenant") ?? "tenant-a",
        deploymentId: "computer-test",
        fingerprint: historyDigest({ userId, nativeRevision }),
        expiresAt: future,
      },
    };
  }
  const authority = {
    binding,
    requireTenant: async (
      context: import("hono").Context<{ Variables: AppVariables }>,
      next: import("hono").Next,
    ) => {
      context.set("actor", (await binding(context.req.raw)).person);
      await next();
    },
  };
  const fakeFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      calls.push(path);
      expect(init?.redirect).toBe("error");
      if (path === "/computers") {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${"a".repeat(32)}`,
        );
        return Response.json({
          computers: containerExists
            ? [
                {
                  botId: privateId,
                  status: "running" as const,
                  port: 18090,
                  startedAt: "2026-11-03T00:00:00.000Z",
                },
              ]
            : [],
        });
      }
      if (path.endsWith("/ensure")) {
        expect(path).toBe(`/computers/${privateId}/ensure`);
        providerIds.push(path.split("/")[2] ?? "");
        containerExists = true;
        return Response.json({
          botId: privateId,
          status: "running",
          port: 18090,
          startedAt: "2026-11-03T00:00:00.000Z",
        });
      }
      expect(new Headers(init?.headers).get("x-openbot-bot-id")).toBe(agentId);
      await hook?.(path, init);
      if (path === "/egress-policy") {
        expect(JSON.parse(String(init?.body))).toEqual({
          policy: OWNED_COMPUTER_EGRESS,
        });
        return Response.json({}, { status: pushOk ? 200 : 503 });
      }
      if (path === "/navigate") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          url: PUBLIC_COMPUTER_URL,
        });
        expect(typeof JSON.parse(String(init?.body)).toolCallId).toBe("string");
        expect(
          events.some((event) => event.eventType === "computer.action_allowed"),
        ).toBe(true);
        url = PUBLIC_COMPUTER_URL;
        return Response.json({
          url,
          title: "Example Domain",
          text,
          truncated: false,
          elapsedMs: 1,
        });
      }
      if (path === "/read")
        return Response.json({
          url,
          title: "Example Domain",
          text,
          truncated: false,
        });
      if (path === "/screenshot")
        return Response.json({
          base64: PNG,
          width: 1,
          height: 1,
          capturedAt: "2026-11-03T00:00:00.000Z",
          ...(screenshotUrl === "missing" ? {} : { url: screenshotUrl ?? url }),
        });
      if (path === "/snapshot")
        return Response.json({
          snapshotId: 1,
          url,
          title: "Example Domain",
          elements: [
            {
              ref: "e1",
              role: "textbox",
              name: "Example",
              value: "must not persist",
              unknown: "must not return",
            },
          ],
          truncated: false,
        });
      throw new Error(`Unexpected backend path ${path}`);
    },
    { preconnect: fetch.preconnect },
  );
  const service = createOwnedComputerService({
    authority,
    config: async () => runtime,
    canUseAgent: async (_actor, id) => profileVisible && id === agentId,
    audit: {
      insert: async (event) => {
        events.push(event);
      },
    },
    snapshots,
    frames,
    fetch: fakeFetch,
    ...(useActualSupervisor
      ? {}
      : {
          provider: (): ComputerProvider => ({
            name: "synthetic-supervisor",
            isolation: shared ? "shared" : "per-bot",
            async locate(id) {
              providerIds.push(id);
              return "http://127.0.0.1:18090";
            },
            async status(id) {
              providerIds.push(id);
              return { botId: id, state: ready ? "ready" : "absent" };
            },
            async list() {
              return [
                ...(containerExists
                  ? [
                      {
                        botId: privateId,
                        status: "running" as const,
                        startedAt: "2026-11-03T00:00:00.000Z",
                        url: "private-url",
                        egress: "internal detail",
                      },
                    ]
                  : []),
                {
                  botId: "another-person-private-computer",
                  status: "running",
                  url: "private-url",
                },
              ];
            },
            stop: async () => {
              throw new Error("Unexpected stop");
            },
            reset: async () => {
              throw new Error("Unexpected reset");
            },
            sessionOf: async () => "synthetic-session",
          }),
        }),
  });
  const app = new Hono();
  app.route(
    "/",
    createOwnedComputerRoutes(
      service,
      createSameOriginGuard({ publicUrl: "https://scout.example" }),
    ),
  );
  app.get("/unrelated", (context) => context.text("unrelated"));
  const request = (
    path = `/api/computers/${agentId}/read`,
    init?: RequestInit,
  ) => new Request(`https://scout.example${path}`, init);
  const context = (signal = new AbortController().signal) => ({
    threadId: "thread-1",
    runId: "run-1",
    toolCallId: "tool-1",
    signal,
    assertCurrent: async () => {},
  });
  return {
    app,
    service,
    request,
    context,
    events,
    calls,
    providerIds,
    privateId,
    snapshots,
    savedFrames,
    setPage: (value: string) => {
      url = value;
    },
    setText: (value: string) => {
      text = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setShared: () => {
      shared = true;
    },
    denyPush: () => {
      pushOk = false;
    },
    absentContainer: () => {
      containerExists = false;
    },
    setScreenshotUrl: (value: string) => {
      screenshotUrl = value;
    },
    revokeNative: () => {
      nativeRevision += 1;
    },
    revokeProfile: () => {
      profileVisible = false;
    },
    revokeGrant: () => {
      runtime = {
        ...runtime,
        grants: runtime.grants.map((grant) => ({ ...grant, active: false })),
      };
    },
    rotateConfig: () => {
      runtime = { ...runtime, fingerprint: "d".repeat(64) };
    },
    setHook: (value: typeof hook) => {
      hook = value;
    },
  };
}

describe("owned computer admission and real gateway composition", () => {
  test("the owned runtime pushes strict public-sample egress rather than a domain-only allowance", () => {
    expect(OWNED_COMPUTER_EGRESS).toEqual({
      mode: "owned_public_sample",
      rules: [],
    });
  });
  test("is opt-in and refuses every unqualified action even when computers are enabled", () => {
    expect(ownedApiAllowed("/api/computers/scout/read", "GET")).toBe(false);
    expect(
      ownedApiAllowed("/api/computers/fleet", "GET", { computers: true }),
    ).toBe(true);
    for (const path of [
      "navigate",
      "click",
      "type",
      "key",
      "scroll",
      "files",
      "exec",
      "control",
      "stop",
      "reset",
      "update",
      "stream",
      "human-stream",
    ])
      expect(
        ownedApiAllowed(`/api/computers/scout/${path}`, "POST", {
          computers: true,
        }),
      ).toBe(false);
  });

  test("private provider IDs bind all immutable native dimensions; config is strict", () => {
    const value = privateComputerId("d", "t", "u", "a");
    expect(value).toBe(privateComputerId("d", "t", "u", "a"));
    expect(value).not.toContain("u/");
    for (const args of [
      ["x", "t", "u", "a"],
      ["d", "x", "u", "a"],
      ["d", "t", "x", "a"],
      ["d", "t", "u", "x"],
    ])
      expect(
        privateComputerId(
          args[0] ?? "",
          args[1] ?? "",
          args[2] ?? "",
          args[3] ?? "",
        ),
      ).not.toBe(value);
    const config = initialConfig();
    expect(() =>
      parseOwnedComputerBindings(
        { ...config, providerId: "someone-else" },
        "computer-test",
      ),
    ).toThrow();
    expect(() =>
      parseOwnedComputerBindings(
        { ...config, grants: [...config.grants, ...config.grants] },
        "computer-test",
      ),
    ).toThrow();
    for (const supervisorUrl of [
      "http://localhost:18089/",
      "https://127.0.0.1:18089/",
      "http://169.254.169.254/",
      "http://127.0.0.1:18089/private",
    ])
      expect(() =>
        parseOwnedComputerBindings(
          { ...config, supervisorUrl },
          "computer-test",
        ),
      ).toThrow();
  });

  test("explicit CEL policy admits only fixed navigation and necessary public reads", () => {
    for (const tool of [
      "computer_navigate",
      "computer_read",
      "computer_snapshot",
      "computer_screenshot",
      "computer_click",
      "computer_run_command",
    ])
      for (const url of [
        PUBLIC_COMPUTER_URL,
        "https://example.org/private",
        "http://127.0.0.1/",
        "https://odoo.example/",
      ])
        expect(
          evaluateActionPolicy(OWNED_COMPUTER_POLICY, {
            tool: { name: tool },
            bot: { id: agentId },
            actor: { id: "alice" },
            page: { url, host: new URL(url).hostname },
            initiator: { kind: "person", id: "" },
          }).forward,
        ).toBe(
          url === PUBLIC_COMPUTER_URL &&
            [
              "computer_navigate",
              "computer_read",
              "computer_snapshot",
              "computer_screenshot",
            ].includes(tool),
        );
    for (const value of [
      "https://example.org/#private",
      "https://example.org/?private=1",
      "https://user:password@example.org/",
      "https://example.org.evil/",
      "file:///private",
      "about:blank",
    ])
      expect(() => publicComputerUrl(value)).toThrow();
  });

  test("owner fleet filters foreign providers and internal metadata; admin grants no bypass", async () => {
    const f = fixture();
    const response = await f.app.fetch(f.request("/api/computers/fleet"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      isolation: "per-bot",
      computers: [
        {
          botId: agentId,
          running: true,
          startedAt: "2026-11-03T00:00:00.000Z",
        },
      ],
    });
    for (const userId of ["bob", "admin"])
      expect(
        (
          await f.app.fetch(
            f.request(undefined, { headers: { "x-fixture-user": userId } }),
          )
        ).status,
      ).toBe(404);
    expect(f.calls).toHaveLength(0);
    expect(
      (
        await f.app.fetch(
          f.request(undefined, { headers: { "x-fixture-tenant": "tenant-b" } }),
        )
      ).status,
    ).toBe(404);
  });

  test("fixed read uses private provider, enforced egress and actual gateway audit before navigation", async () => {
    const f = fixture();
    const bound = await f.service.forRequest(f.request(), agentId);
    const result = await bound.readPublic(f.context());
    expect(result).toMatchObject({
      kind: "scout.computer.public_read.v1",
      computerId: agentId,
      url: PUBLIC_COMPUTER_URL,
      title: "Example Domain",
    });
    expect(result.text).toContain("illustrative examples");
    expect(result.untrusted).toContain("untrusted");
    expect(f.calls.indexOf("/egress-policy")).toBeLessThan(
      f.calls.indexOf("/navigate"),
    );
    expect(f.calls.filter((path) => path === "/navigate")).toHaveLength(1);
    expect(f.providerIds.every((id) => id === f.privateId)).toBe(true);
    expect(f.events[0]?.actorUserId).toBe("alice");
    expect(f.events[0]?.payload.ownedComputer).toEqual({
      userId: "alice",
      tenantId: "tenant-a",
      deploymentId: "computer-test",
      agentId,
      privateId: f.privateId,
    });
    expect(f.savedFrames[0]?.computerId).toBe(f.privateId);
    expect(f.savedFrames[0]?.toolCallId).toBe("tool-1");
    const frame = await f.app.fetch(
      f.request(`/api/computers/${agentId}/page-frame/tool-1`),
    );
    expect(frame.status).toBe(200);
  });

  test("fresh fleet advertises only admitted aliases, and actual supervisor receives private IDs", async () => {
    const f = fixture(true);
    f.absentContainer();
    const fleet = await f.app.fetch(f.request("/api/computers/fleet"));
    expect(await fleet.json()).toEqual({
      isolation: "per-bot",
      computers: [{ botId: agentId, running: false, startedAt: null }],
    });
    const response = await f.app.fetch(
      f.request(`/api/computers/${agentId}/read-public`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://scout.example",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.pageFrameId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.savedFrames[0]?.toolCallId).toBe(result.pageFrameId);
    expect(f.providerIds.every((id) => id === f.privateId)).toBe(true);
    const frame = await f.app.fetch(
      f.request(`/api/computers/${agentId}/page-frame/${result.pageFrameId}`),
    );
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toContain("application/json");
    expect(await frame.json()).toEqual({
      frame: { url: PUBLIC_COMPUTER_URL, title: "Example Domain", frame: PNG },
    });
    const foreign = await f.app.fetch(
      f.request(`/api/computers/${agentId}/page-frame/${result.pageFrameId}`, {
        headers: { "x-fixture-user": "bob" },
      }),
    );
    expect(foreign.status).toBe(404);
  });

  test("viewer does not wake absent computers and never releases a private or unidentifiable screenshot", async () => {
    const f = fixture();
    f.setReady(false);
    expect((await f.app.fetch(f.request())).status).toBe(503);
    expect(f.calls).toHaveLength(0);
    f.setReady(true);
    f.setPage("https://odoo.example/private");
    expect(
      (await f.app.fetch(f.request(`/api/computers/${agentId}/screenshot`)))
        .status,
    ).toBe(503);
    expect(f.calls).not.toContain("/screenshot");
    f.setPage(PUBLIC_COMPUTER_URL);
    for (const screenshotUrl of ["https://odoo.example/private", "missing"]) {
      f.setScreenshotUrl(screenshotUrl);
      const response = await f.app.fetch(
        f.request(`/api/computers/${agentId}/screenshot`),
      );
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain(PNG);
    }
  });

  test("snapshot persists only bounded public labels under private key, removing form values", async () => {
    const f = fixture();
    f.setPage(PUBLIC_COMPUTER_URL);
    const response = await f.app.fetch(
      f.request(`/api/computers/${agentId}/snapshot`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.elements).toEqual([
      { ref: "e1", role: "textbox", name: "Example" },
    ]);
    expect(JSON.stringify(result)).not.toContain("must not");
    expect(await f.snapshots.load(agentId)).toBeUndefined();
    expect([
      ...((await f.snapshots.load(f.privateId))?.elements.values() ?? []),
    ]).toEqual([{ ref: "e1", role: "textbox", name: "Example" }]);
  });

  test("egress rejection and shared provider fail closed without a browser navigation", async () => {
    for (const setup of [
      (f: ReturnType<typeof fixture>) => f.denyPush(),
      (f: ReturnType<typeof fixture>) => f.setShared(),
    ]) {
      const f = fixture();
      setup(f);
      const bound = await f.service.forRequest(f.request(), agentId);
      await expect(bound.readPublic(f.context())).rejects.toThrow();
      expect(f.calls).not.toContain("/navigate");
      expect(f.savedFrames).toHaveLength(0);
    }
  });

  test("revocation, membership change, credential/config rotation and model fence deny after I/O", async () => {
    for (const revoke of [
      (f: ReturnType<typeof fixture>) => f.revokeNative(),
      (f: ReturnType<typeof fixture>) => f.revokeProfile(),
      (f: ReturnType<typeof fixture>) => f.revokeGrant(),
      (f: ReturnType<typeof fixture>) => f.rotateConfig(),
    ]) {
      const f = fixture();
      f.setHook(async (path) => {
        if (path === "/navigate") revoke(f);
      });
      const bound = await f.service.forRequest(f.request(), agentId);
      await expect(bound.readPublic(f.context())).rejects.toThrow(
        "COMPUTER_ACCESS_DENIED",
      );
      expect(f.savedFrames).toHaveLength(0);
    }
    const f = fixture();
    const bound = await f.service.forRequest(f.request(), agentId);
    await expect(
      bound.readPublic({
        ...f.context(),
        assertCurrent: async () => {
          throw new Error("Synthetic model grant revoked");
        },
      }),
    ).rejects.toThrow("COMPUTER_UNAVAILABLE");
    expect(f.calls).toHaveLength(0);
  });

  test("one in-flight navigation per private computer; abort never retries or returns late data", async () => {
    const f = fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.setHook(async (path, init) => {
      if (path !== "/navigate") return;
      entered();
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("Synthetic cancellation")),
          { once: true },
        );
      });
    });
    const bound = await f.service.forRequest(f.request(), agentId);
    const abort = new AbortController();
    const pending = bound.readPublic(f.context(abort.signal));
    await waiting;
    await expect(bound.readPublic(f.context())).rejects.toThrow(
      "COMPUTER_BUSY",
    );
    abort.abort();
    await expect(pending).rejects.toThrow("COMPUTER_CANCELLED");
    expect(f.calls.filter((path) => path === "/navigate")).toHaveLength(1);
    expect(f.savedFrames).toHaveLength(0);
  });

  test("public text is bounded and viewer refuses page changes around screenshot", async () => {
    const f = fixture();
    f.setText("a".repeat(9000));
    const bound = await f.service.forRequest(f.request(), agentId);
    const result = await bound.readPublic(f.context());
    expect(result.text.length).toBe(8192);
    expect(result.truncated).toBe(true);
    f.setHook(async (path) => {
      if (path === "/screenshot") f.setPage("https://odoo.example/private");
    });
    expect(
      (await f.app.fetch(f.request(`/api/computers/${agentId}/screenshot`)))
        .status,
    ).toBe(503);
  });

  test("owned routes scope middleware, deny generic controls and client-chosen targets", async () => {
    const f = fixture();
    expect(
      (
        await f.app.fetch(
          f.request("/unrelated", {
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(200);
    for (const action of [
      "navigate",
      "click",
      "type",
      "key",
      "scroll",
      "exec",
      "files",
      "control",
      "secret",
      "stop",
      "reset",
      "stream",
      "human-stream",
    ])
      expect(
        (
          await f.app.fetch(
            f.request(`/api/computers/${agentId}/${action}`, {
              method: "POST",
            }),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await f.app.fetch(
          f.request(`/api/computers/${agentId}/read-public`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://evil.example",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    for (const body of [
      '{"url":"http://169.254.169.254/"}',
      '{"userId":"admin"}',
      '{"commands":[]}',
    ])
      expect(
        (
          await f.app.fetch(
            f.request(`/api/computers/${agentId}/read-public`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          )
        ).status,
      ).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  test("legacy serializer never returns raw provider error text", async () => {
    const f = fixture();
    f.setHook(async () => {
      throw new Error("synthetic-private-host-detail");
    });
    const response = await f.app.fetch(f.request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"code":"COMPUTER_UNAVAILABLE"}');
  });

  test("transport bounds response bytes before upstream parsing and refuses redirect delegation", async () => {
    let checked = 0;
    const transport = boundedComputerFetch(
      async () => {
        checked += 1;
      },
      new AbortController().signal,
      Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          expect(init?.redirect).toBe("error");
          return new Response("x".repeat(5 * 1024 * 1024 + 1));
        },
        { preconnect: fetch.preconnect },
      ),
    );
    await expect(transport("http://127.0.0.1:18090/read")).rejects.toThrow(
      "COMPUTER_UNAVAILABLE",
    );
    expect(checked).toBe(1);
  });
});
