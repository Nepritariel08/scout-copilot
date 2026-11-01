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
    if (requests.length === 1)
      return json({ uid: 401, lang: "en_US", tz: "UTC" });
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
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map(({ url }) => url.pathname)).toEqual([
      "/json/2/res.users/context_get",
      "/json/2/project.task/search_read",
    ]);
    const [identityCall, taskCall] = fake.requests;
    expect(identityCall?.init.method).toBe("POST");
    expect(JSON.parse(String(identityCall?.init.body))).toEqual({});
    expect(JSON.parse(String(taskCall?.init.body))).toEqual({
      domain: [
        ["id", "=", 700],
        ["project_id", "in", [31]],
      ],
      context: { allowed_company_ids: [7] },
      fields: ["id", "name", "stage_id", "date_deadline", "company_id"],
      limit: 1,
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
        return requests.length === 1
          ? json({ uid: 401 })
          : new Response(`provider leaked ${key}`, {
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
    expect(requests).toHaveLength(2);
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
          return calls === 1 ? json({ uid: 401 }) : failureResponse;
        }) as unknown as typeof fetch,
      });
      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_UNAVAILABLE",
      );
      expect(calls).toBe(2);
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
          return calls === 1 ? json({ uid: 401 }) : rejectedResponse;
        }) as unknown as typeof fetch,
      });
      await expect(subject.readProjectTask(request)).rejects.toThrow(
        "MODEL_UNAVAILABLE",
      );
      expect(cancelled).toBe(true);
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
        return requests.length === 1
          ? json({ uid: 401 })
          : new Response(null, {
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
    expect(requests[1]?.init.redirect).toBe("error");
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
    expect(calls).toBe(2);
  });
});
