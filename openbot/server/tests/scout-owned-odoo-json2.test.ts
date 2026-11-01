import { describe, expect, test } from "bun:test";
import { createOdooJson2ProjectTaskReader } from "../src/scout/owned-model/odoo-json2";
import type { ProjectTaskReadRequest } from "../src/scout/owned-model/record-context";

const key = "synthetic-odoo-api-key";
const request: ProjectTaskReadRequest = {
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
};

type CapturedRequest = {
  url: URL;
  init: RequestInit;
};

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function reader(fetchImplementation: typeof fetch) {
  const resolved: number[] = [];
  const subject = createOdooJson2ProjectTaskReader({
    instanceId: "odoo-test",
    baseUrl: "http://127.0.0.1:8069",
    database: "synthetic_odoo",
    credentials: {
      resolveForUid: async (uid) => {
        resolved.push(uid);
        return { uid, apiKey: key };
      },
    },
    fetch: fetchImplementation,
  });
  return { subject, resolved };
}

function capture() {
  const requests: CapturedRequest[] = [];
  const { subject, resolved } = reader((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requests.push({ url: new URL(String(input)), init: init ?? {} });
    const path = requests.at(-1)?.url.pathname;
    if (path === "/json/2/res.users/context_get")
      return json({ uid: 401, lang: "en_US", tz: "UTC" });
    if (path === "/json/2/res.users/has_group") {
      const body = JSON.parse(String(requests.at(-1)?.init.body)) as {
        group_ext_id: string;
      };
      return json(body.group_ext_id === "base.group_user");
    }
    return json([
      {
        id: 700,
        name: "Synthetic task",
        stage_id: false,
        date_deadline: false,
        company_id: [7, "Synthetic company"],
      },
    ]);
  }) as unknown as typeof fetch);
  return { subject, requests, resolved };
}

describe("owned Odoo JSON-2 project-task transport", () => {
  test("derives a bounded project scope from the fixed bound nonadmin identity", async () => {
    const requests: CapturedRequest[] = [];
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: { resolveForUid: async (uid) => ({ uid, apiKey: key }) },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: new URL(String(input)), init: init ?? {} });
        if (requests.at(-1)?.url.pathname.endsWith("context_get"))
          return json({ uid: 401 });
        if (requests.at(-1)?.url.pathname.endsWith("has_group")) {
          const body = JSON.parse(String(init?.body)) as {
            group_ext_id: string;
          };
          return json(body.group_ext_id === "base.group_user");
        }
        return json([
          { id: 31, company_id: [7, "Synthetic company"] },
          { id: 32, company_id: [8, "Other bound company"] },
        ]);
      }) as unknown as typeof fetch,
    });

    await expect(
      subject.verifyUserProjectScope(key, 401, [8, 7]),
    ).resolves.toEqual([31, 32]);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/project.project/search_read",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
    ]);
    expect(JSON.parse(String(requests[4]?.init.body))).toEqual({
      context: { allowed_company_ids: [7, 8] },
      domain: [["company_id", "in", [7, 8]]],
      fields: ["id", "company_id"],
      limit: 101,
    });
    expect(
      requests.every(
        ({ init }) =>
          new Headers(init.headers).get("authorization") === `bearer ${key}`,
      ),
    ).toBe(true);
  });

  test.each([
    {
      name: "a mismatched Odoo UID",
      identity: { uid: 402 },
      internal: true,
      groups: false,
      rows: [{ id: 31, company_id: [7, "Synthetic company"] }],
    },
    {
      name: "an administrator group",
      identity: { uid: 401 },
      internal: true,
      groups: true,
      rows: [{ id: 31, company_id: [7, "Synthetic company"] }],
    },
    {
      name: "a cross-company project",
      identity: { uid: 401 },
      internal: true,
      groups: false,
      rows: [{ id: 31, company_id: [99, "Unbound company"] }],
    },
    {
      name: "an empty project scope",
      identity: { uid: 401 },
      internal: true,
      groups: false,
      rows: [],
    },
    {
      name: "an over-cap project scope",
      identity: { uid: 401 },
      internal: true,
      groups: false,
      rows: Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        company_id: [7, "Synthetic company"],
      })),
    },
    {
      name: "a portal user without internal membership",
      identity: { uid: 401 },
      internal: false,
      groups: false,
      rows: [{ id: 31, company_id: [7, "Synthetic company"] }],
    },
  ])(
    "fails closed for $name during grant qualification",
    async ({ identity, internal, groups, rows }) => {
      const paths: string[] = [];
      const subject = createOdooJson2ProjectTaskReader({
        instanceId: "odoo-test",
        baseUrl: "http://127.0.0.1:8069",
        database: "synthetic_odoo",
        credentials: { resolveForUid: async (uid) => ({ uid, apiKey: key }) },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          if (path.endsWith("context_get")) return json(identity);
          if (path.endsWith("has_group")) {
            const body = JSON.parse(String(init?.body)) as {
              group_ext_id: string;
            };
            return json(
              body.group_ext_id === "base.group_user" ? internal : groups,
            );
          }
          return json(rows);
        }) as unknown as typeof fetch,
      });
      await expect(
        subject.verifyUserProjectScope(key, 401, [7]),
      ).rejects.toThrow("MODEL_ACCESS_DENIED");
      if (identity.uid !== 401 || !internal || groups)
        expect(paths).not.toContain("/json/2/project.project/search_read");
      else expect(paths).toContain("/json/2/project.project/search_read");
    },
  );

  test("verifies the API key UID, then reads one fixed row under that same user", async () => {
    const fake = capture();
    await expect(fake.subject.readProjectTask(request)).resolves.toEqual([
      {
        id: 700,
        name: "Synthetic task",
        stage_id: null,
        date_deadline: null,
        company_id: [7, "Synthetic company"],
      },
    ]);
    expect(fake.resolved).toEqual([401]);
    expect(fake.requests).toHaveLength(8);
    expect(fake.requests.map(({ url }) => url.pathname)).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/project.task/search_read",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
    ]);
    const [
      identityCall,
      internalCall,
      privilegeCall,
      erpManagerCall,
      taskCall,
      finalInternalCall,
      finalPrivilegeCall,
      finalErpManagerCall,
    ] = fake.requests;
    expect(identityCall?.init.method).toBe("POST");
    expect(JSON.parse(String(identityCall?.init.body))).toEqual({});
    expect(JSON.parse(String(internalCall?.init.body))).toEqual({
      ids: [401],
      group_ext_id: "base.group_user",
    });
    expect(JSON.parse(String(privilegeCall?.init.body))).toEqual({
      ids: [401],
      group_ext_id: "base.group_system",
    });
    expect(JSON.parse(String(erpManagerCall?.init.body))).toEqual({
      ids: [401],
      group_ext_id: "base.group_erp_manager",
    });
    expect(JSON.parse(String(taskCall?.init.body))).toEqual({
      domain: [
        ["id", "=", 700],
        ["project_id", "in", [31]],
      ],
      context: { allowed_company_ids: [7] },
      fields: ["id", "name", "stage_id", "date_deadline", "company_id"],
      limit: 1,
    });
    expect(JSON.parse(String(finalPrivilegeCall?.init.body))).toEqual({
      ids: [401],
      group_ext_id: "base.group_system",
    });
    expect(JSON.parse(String(finalErpManagerCall?.init.body))).toEqual({
      ids: [401],
      group_ext_id: "base.group_erp_manager",
    });
    expect(JSON.parse(String(finalInternalCall?.init.body))).toEqual({
      ids: [401],
      group_ext_id: "base.group_user",
    });
    for (const call of fake.requests) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(`bearer ${key}`);
      expect(headers.get("x-odoo-database")).toBe("synthetic_odoo");
      expect(headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test.each(["base.group_system", "base.group_erp_manager"])(
    "denies a current Odoo administrator in %s before reading a task",
    async (adminGroup) => {
      const paths: string[] = [];
      const subject = createOdooJson2ProjectTaskReader({
        instanceId: "odoo-test",
        baseUrl: "http://127.0.0.1:8069",
        database: "synthetic_odoo",
        credentials: {
          resolveForUid: async (uid) => ({ uid, apiKey: key }),
        },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          if (path === "/json/2/res.users/context_get")
            return json({ uid: 401 });
          const body = JSON.parse(String(init?.body)) as {
            group_ext_id: string;
          };
          return json(
            body.group_ext_id === "base.group_user" ||
              body.group_ext_id === adminGroup,
          );
        }) as unknown as typeof fetch,
      });

      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(paths).toEqual([
        "/json/2/res.users/context_get",
        "/json/2/res.users/has_group",
        "/json/2/res.users/has_group",
        ...(adminGroup === "base.group_erp_manager"
          ? ["/json/2/res.users/has_group"]
          : []),
      ]);
    },
  );

  test("fails closed when the live group check is malformed", async () => {
    for (const privilegeResult of [null, {}, 0]) {
      const paths: string[] = [];
      const subject = createOdooJson2ProjectTaskReader({
        instanceId: "odoo-test",
        baseUrl: "http://127.0.0.1:8069",
        database: "synthetic_odoo",
        credentials: {
          resolveForUid: async (uid) => ({ uid, apiKey: key }),
        },
        fetch: (async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          if (path === "/json/2/res.users/context_get")
            return json({ uid: 401 });
          return json(privilegeResult);
        }) as unknown as typeof fetch,
      });

      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(paths).toEqual([
        "/json/2/res.users/context_get",
        "/json/2/res.users/has_group",
      ]);
    }
  });

  test("does not read tasks when Odoo cannot verify the current group", async () => {
    const paths: string[] = [];
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/json/2/res.users/context_get") return json({ uid: 401 });
        return new Response("synthetic upstream detail", {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_UNAVAILABLE",
    );
    expect(paths).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
    ]);
  });

  test("denies a portal user on a live read even when both admin groups are false", async () => {
    const paths: string[] = [];
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/json/2/res.users/context_get") return json({ uid: 401 });
        if (path === "/json/2/res.users/has_group") {
          const body = JSON.parse(String(init?.body)) as {
            group_ext_id: string;
          };
          expect(body.group_ext_id).toBe("base.group_user");
          return json(false);
        }
        return json([{ id: 700 }]);
      }) as unknown as typeof fetch,
    });

    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(paths).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
    ]);
  });

  test("denies an internal user demoted to portal during a live task read", async () => {
    const paths: string[] = [];
    let taskRead = false;
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/json/2/res.users/context_get") return json({ uid: 401 });
        if (path === "/json/2/res.users/has_group") {
          const body = JSON.parse(String(init?.body)) as {
            group_ext_id: string;
          };
          return json(body.group_ext_id === "base.group_user" && !taskRead);
        }
        taskRead = true;
        return json([{ id: 700 }]);
      }) as unknown as typeof fetch,
    });

    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(paths).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/project.task/search_read",
      "/json/2/res.users/has_group",
    ]);
  });

  test("denies a user promoted to ERP Manager during the task read", async () => {
    const paths: string[] = [];
    let taskRead = false;
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/json/2/res.users/context_get") return json({ uid: 401 });
        if (path === "/json/2/res.users/has_group") {
          const body = JSON.parse(String(init?.body)) as {
            group_ext_id: string;
          };
          return json(
            body.group_ext_id === "base.group_user" ||
              (body.group_ext_id === "base.group_erp_manager" && taskRead),
          );
        }
        taskRead = true;
        return json([
          {
            id: 700,
            name: "Synthetic task",
            stage_id: [2, "Open"],
            date_deadline: false,
            company_id: [7, "Synthetic company"],
          },
        ]);
      }) as unknown as typeof fetch,
    });

    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(paths).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/project.task/search_read",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
    ]);
  });

  test("denies a user promoted to Settings administrator during the task read", async () => {
    const paths: string[] = [];
    let taskRead = false;
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/json/2/res.users/context_get") return json({ uid: 401 });
        if (path === "/json/2/res.users/has_group") {
          const body = JSON.parse(String(init?.body)) as {
            group_ext_id: string;
          };
          return json(
            body.group_ext_id === "base.group_user" ||
              (body.group_ext_id === "base.group_system" && taskRead),
          );
        }
        taskRead = true;
        return json([
          {
            id: 700,
            name: "Synthetic task",
            stage_id: [2, "Open"],
            date_deadline: false,
            company_id: [7, "Synthetic company"],
          },
        ]);
      }) as unknown as typeof fetch,
    });

    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(paths).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
      "/json/2/project.task/search_read",
      "/json/2/res.users/has_group",
      "/json/2/res.users/has_group",
    ]);
  });

  test("denies a credential whose Odoo-reported UID differs from the qualified grant", async () => {
    const requests: string[] = [];
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://localhost:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async () => ({ uid: 401, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(new URL(String(input)).pathname);
        return json({ uid: 402, lang: "en_US", tz: "UTC" });
      }) as unknown as typeof fetch,
    });
    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(requests).toEqual(["/json/2/res.users/context_get"]);
  });

  test("refuses an unresolved or mismapped key before network access", async () => {
    for (const credential of [
      null,
      { uid: 1, apiKey: key },
      { uid: 402, apiKey: key },
      { uid: 401, apiKey: "" },
    ]) {
      let calls = 0;
      const subject = createOdooJson2ProjectTaskReader({
        instanceId: "odoo-test",
        baseUrl: "http://127.0.0.1:8069",
        database: "synthetic_odoo",
        credentials: {
          resolveForUid: async () => credential,
        },
        fetch: (async () => {
          calls += 1;
          return json({ uid: 401 });
        }) as unknown as typeof fetch,
      });
      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect(calls).toBe(0);
    }
  });

  test("rejects Odoo superuser identity before credential lookup or network access", async () => {
    let resolved = 0;
    let calls = 0;
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => {
          resolved += 1;
          return { uid, apiKey: key };
        },
      },
      fetch: (async () => {
        calls += 1;
        return json({ uid: 1 });
      }) as unknown as typeof fetch,
    });
    await expect(
      subject.readProjectTask({
        ...request,
        sourceIdentity: { ...request.sourceIdentity, uid: 1 },
      }),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(resolved).toBe(0);
    expect(calls).toBe(0);
  });

  test("rejects unsafe endpoint configuration and a widened or malformed request", async () => {
    for (const baseUrl of [
      "http://192.168.1.2:8069",
      "http://example.com:8069",
      "https://user:password@example.com",
      "https://odoo.example.com/custom",
      "https://odoo.example.com?database=other",
    ]) {
      expect(() =>
        createOdooJson2ProjectTaskReader({
          instanceId: "odoo-test",
          baseUrl,
          database: "synthetic_odoo",
          credentials: {
            resolveForUid: async () => ({ uid: 401, apiKey: key }),
          },
        }),
      ).toThrow("MODEL_ACCESS_DENIED");
    }
    for (const database of [
      "",
      "odoo/other",
      "odoo\nother",
      "x".repeat(64),
      null,
    ]) {
      expect(() =>
        createOdooJson2ProjectTaskReader({
          instanceId: "odoo-test",
          baseUrl: "http://127.0.0.1:8069",
          database: database as string,
          credentials: {
            resolveForUid: async () => ({ uid: 401, apiKey: key }),
          },
        }),
      ).toThrow("MODEL_ACCESS_DENIED");
    }

    let calls = 0;
    const { subject } = reader((async () => {
      calls += 1;
      return json({ uid: 401 });
    }) as unknown as typeof fetch);
    const widened = {
      ...request,
      domain: [
        ["id", "in", [700, 701]],
        ["project_id", "in", [31]],
      ],
    } as unknown as ProjectTaskReadRequest;
    await expect(subject.readProjectTask(widened)).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    expect(calls).toBe(0);
  });

  test("fails closed on HTTP errors without reflecting the response or API key", async () => {
    const requests: CapturedRequest[] = [];
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "https://odoo.example.com",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: new URL(String(input)), init: init ?? {} });
        if (requests.length === 1) return json({ uid: 401 });
        if (requests.length <= 4) return json(requests.length === 2);
        return new Response(`provider leaked ${key}`, {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    let failure: unknown;
    try {
      await subject.readProjectTask(request);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("MODEL_UNAVAILABLE");
    expect(String(failure)).not.toContain(key);
    expect(requests).toHaveLength(5);
  });

  test("bounds and validates Odoo response bodies", async () => {
    const responses: Response[] = [
      new Response("x".repeat(6000), {
        headers: { "content-type": "application/json" },
      }),
      new Response("not-json", {
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", {
        headers: { "content-type": "text/plain" },
      }),
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "6000",
        },
      }),
      new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const failureResponse of responses) {
      let calls = 0;
      const subject = createOdooJson2ProjectTaskReader({
        instanceId: "odoo-test",
        baseUrl: "http://127.0.0.1:8069",
        database: "synthetic_odoo",
        credentials: {
          resolveForUid: async (uid) => ({ uid, apiKey: key }),
        },
        fetch: (async () => {
          calls += 1;
          if (calls === 1) return json({ uid: 401 });
          if (calls <= 4) return json(calls === 2);
          return failureResponse;
        }) as unknown as typeof fetch,
      });
      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_UNAVAILABLE",
      );
      expect(calls).toBe(5);
    }
  });

  test("cancels unread bodies when response headers or status are rejected", async () => {
    for (const rejection of [
      { status: 200, contentType: "text/plain" },
      { status: 503, contentType: "application/json" },
    ]) {
      let cancelled = false;
      const rejectedResponse = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("not read"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: rejection.status,
          headers: { "content-type": rejection.contentType },
        },
      );
      let calls = 0;
      const subject = createOdooJson2ProjectTaskReader({
        instanceId: "odoo-test",
        baseUrl: "http://127.0.0.1:8069",
        database: "synthetic_odoo",
        credentials: {
          resolveForUid: async (uid) => ({ uid, apiKey: key }),
        },
        fetch: (async () => {
          calls += 1;
          if (calls === 1) return json({ uid: 401 });
          if (calls <= 4) return json(calls === 2);
          return rejectedResponse;
        }) as unknown as typeof fetch,
      });
      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_UNAVAILABLE",
      );
      expect(cancelled).toBe(true);
      expect(calls).toBe(5);
    }
  });

  test("does not follow redirects", async () => {
    const requests: CapturedRequest[] = [];
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "https://odoo.example.com",
      database: "synthetic_odoo",
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: new URL(String(input)), init: init ?? {} });
        if (requests.length === 1) return json({ uid: 401 });
        if (requests.length <= 4) return json(requests.length === 2);
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://other.example.com/collect",
            "content-type": "application/json",
          },
        });
      }) as unknown as typeof fetch,
    });
    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_UNAVAILABLE",
    );
    expect(requests[4]?.init.redirect).toBe("error");
  });

  test("uses a bounded timeout for each Odoo request", async () => {
    let calls = 0;
    const subject = createOdooJson2ProjectTaskReader({
      instanceId: "odoo-test",
      baseUrl: "http://127.0.0.1:8069",
      database: "synthetic_odoo",
      timeoutMs: 500,
      credentials: {
        resolveForUid: async (uid) => ({ uid, apiKey: key }),
      },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return json({ uid: 401 });
        if (calls <= 4) return json(calls === 2);
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }) as unknown as typeof fetch,
    });
    await expect(subject.readProjectTask(request)).rejects.toThrow(
      "MODEL_UNAVAILABLE",
    );
    expect(calls).toBe(5);
  });
});
