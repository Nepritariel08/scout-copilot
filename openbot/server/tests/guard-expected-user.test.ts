import { expect, test } from "bun:test";
import { Hono } from "hono";
import { type AppVariables, createRequireUser } from "../src/auth/guards";

function fixture(subject: string | null) {
  const effects: string[] = [];
  const app = new Hono<{ Variables: AppVariables }>();
  app.post(
    "/mutation",
    createRequireUser(
      {
        handler: () => new Response(),
        api: {
          getSession: async () =>
            subject
              ? { user: { id: subject, email: "synthetic@example.test" } }
              : null,
        },
      },
      {
        rolesForUser: async () => {
          effects.push("roles");
          return ["user"];
        },
      },
    ),
    (c) => {
      effects.push(c.var.actor.id);
      return c.json({ ok: true });
    },
  );
  return { app, effects };
}

test("new cookie subject cannot execute an action initiated as the previous native user", async () => {
  const { app, effects } = fixture("new-user");
  const result = await app.request("http://scout.test/mutation", {
    method: "POST",
    headers: { "X-Scout-Expected-User": "old-user" },
  });
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ code: "SCOUT_IDENTITY_CHANGED" });
  expect(effects).toEqual([]);
});

test("matching initiating subject retains normal role authorization", async () => {
  const { app, effects } = fixture("same-user");
  const result = await app.request("http://scout.test/mutation", {
    method: "POST",
    headers: { "X-Scout-Expected-User": "same-user" },
  });
  expect(result.status).toBe(200);
  expect(effects).toEqual(["roles", "same-user"]);
});

test("expected-subject header never creates authentication", async () => {
  const { app, effects } = fixture(null);
  const result = await app.request("http://scout.test/mutation", {
    method: "POST",
    headers: { "X-Scout-Expected-User": "admin" },
  });
  expect(result.status).toBe(401);
  expect(effects).toEqual([]);
});
