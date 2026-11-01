import assert from "node:assert/strict";
import test from "node:test";
import { scopedFetch, scopedSession } from "../src/request-scope.ts";

test("switching account while cookie lookup waits refuses before any dispatch", async () => {
  let currentUser = "old-user";
  let finish!: (cookie: string) => void;
  let dispatches = 0;
  const request = scopedFetch(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    {
      userId: "old-user",
      isCurrent: () => currentUser === "old-user",
    },
    async () => {
      dispatches++;
      return Response.json({ ok: true });
    },
  );
  const pending = request(
    "https://scout.test/api/scout/odoo/context-grants/release",
    { method: "POST" },
  );
  currentUser = "new-user";
  finish("new-cookie");
  await assert.rejects(pending, /account or conversation changed/);
  assert.equal(dispatches, 0);
});

test("unchanged scope sends captured credential and exact expected subject without ambient cookies", async () => {
  let headers: Headers | undefined;
  const request = scopedFetch(
    () => "synthetic-cookie",
    { userId: "old-user", isCurrent: () => true },
    async (_url, init) => {
      headers = new Headers(init?.headers);
      assert.equal(init?.credentials, "omit");
      return Response.json({ ok: true });
    },
  );
  await request("https://scout.test/api/channels", {
    method: "POST",
    headers: { Cookie: "untrusted", "X-Scout-Expected-User": "new-user" },
  });
  assert.equal(headers?.get("Cookie"), "synthetic-cookie");
  assert.equal(headers?.get("X-Scout-Expected-User"), "old-user");
});

test("unmounted or changed channel cannot begin a credential lookup", async () => {
  let reads = 0;
  await assert.rejects(
    scopedSession(
      () => {
        reads++;
        return "cookie";
      },
      { userId: "old-user", isCurrent: () => false },
    ),
    /account or conversation changed/,
  );
  assert.equal(reads, 0);
});

test("each chained request rechecks scope and refuses late results", async () => {
  let current = true;
  let dispatches = 0;
  const request = scopedFetch(
    () => "cookie",
    { userId: "old-user", isCurrent: () => current },
    async () => {
      dispatches++;
      current = false;
      return Response.json({ ok: true });
    },
  );
  await assert.rejects(
    request("https://scout.test/api/capabilities"),
    /account or conversation changed/,
  );
  await assert.rejects(
    request("https://scout.test/api/scout/tasks"),
    /account or conversation changed/,
  );
  assert.equal(dispatches, 1);
});
