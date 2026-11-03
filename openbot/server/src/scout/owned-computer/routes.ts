import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../../auth/guards";
import { createPolicyStore } from "../../computer/policy-store";
import { createComputerRoutes } from "../../computer/routes";
import { OwnedComputerError } from "./bindings";
import { OWNED_COMPUTER_POLICY } from "./policy";
import type { OwnedComputerService } from "./service";

/** Same URL/result shapes as the public MIT computer viewer, with a narrow owned admission layer. */
export function createOwnedComputerRoutes(
  service: OwnedComputerService,
  originGuard: MiddlewareHandler,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/api/computers/*", originGuard, service.authority.requireTenant);
  app.use("/api/computers/*", bodyLimit({ maxSize: 1024 }));
  app.use("/api/computers/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, context) => {
    const code =
      error instanceof OwnedComputerError ? error.code : "COMPUTER_UNAVAILABLE";
    return context.json(
      { code },
      code === "COMPUTER_ACCESS_DENIED"
        ? 404
        : code === "COMPUTER_INPUT_INVALID"
          ? 400
          : code === "COMPUTER_CANCELLED" || code === "COMPUTER_BUSY"
            ? 409
            : 503,
    );
  });
  app.get("/api/computers/fleet", async (context) =>
    context.json(await service.fleet(context.req.raw)),
  );
  app.get("/api/computers/policy", (context) =>
    context.json({ policy: OWNED_COMPUTER_POLICY }),
  );
  app.all("/api/computers/*", async (context) => {
    const url = new URL(context.req.url);
    if (/%(?:2f|5c|2e|25)/i.test(url.pathname) || url.pathname.includes("\\"))
      return context.json({ code: "COMPUTER_ACCESS_DENIED" }, 404);
    const match =
      /^\/api\/computers\/([A-Za-z0-9][A-Za-z0-9_:.-]{0,199})\/(status|screenshot|read|snapshot|read-public|page-frame\/[^/]{1,200})$/.exec(
        url.pathname,
      );
    if (!match)
      return context.json({ code: "COMPUTER_ACTION_UNAVAILABLE" }, 403);
    const agentId = match[1],
      action = match[2];
    if (
      !agentId ||
      !action ||
      !(
        (context.req.method === "GET" &&
          ["status", "screenshot", "read"].includes(action)) ||
        (context.req.method === "GET" && action.startsWith("page-frame/")) ||
        (context.req.method === "POST" &&
          ["snapshot", "read-public"].includes(action))
      )
    )
      return context.json({ code: "COMPUTER_ACTION_UNAVAILABLE" }, 403);
    const bound = await service.forRequest(context.req.raw, agentId);
    if (action === "read-public") {
      if (
        context.req.header("content-type")?.split(";", 1)[0] !==
        "application/json"
      )
        return context.json({ code: "COMPUTER_INPUT_INVALID" }, 400);
      // Only an explicit empty request is accepted; the browser/model cannot select a URL or principal.
      const text = await context.req.text();
      if (text.length > 256 || text.trim() !== "{}")
        return context.json({ code: "COMPUTER_INPUT_INVALID" }, 400);
      const id = randomUUID();
      const result = await bound.readPublic({
        threadId: `owner-${id}`,
        runId: id,
        toolCallId: id,
        signal: context.req.raw.signal,
        assertCurrent: bound.check,
      });
      return context.json({ ...result, pageFrameId: id });
    }
    const viewer = bound.viewer();
    // Reuse the existing route serializer and bot checks; no unguarded upstream router is mounted.
    const legacy = createComputerRoutes(
      viewer.viewer,
      createPolicyStore(OWNED_COMPUTER_POLICY),
      async (inner, next) => {
        inner.set("actor", bound.person);
        await next();
      },
      async (actor, botId) => {
        await bound.check();
        return actor.id === bound.person.id && botId === agentId;
      },
      viewer.frames,
    );
    url.pathname = `/${agentId}/${action}`;
    const response = await legacy.fetch(new Request(url, context.req.raw));
    await bound.check();
    if (!response.ok)
      return context.json(
        { code: "COMPUTER_UNAVAILABLE" },
        response.status === 403 || response.status === 404 ? 404 : 503,
      );
    return response;
  });
  return app;
}
