import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables, AuthenticatedActor } from "../../auth/guards";
import { HistoryError } from "./protocol";
import type { BoundHistory } from "./service";

const mintInput = z.strictObject({
  agentId: z.string().min(1).max(200),
  channelId: z.string().min(1).max(200).optional(),
});
const stopInput = z.strictObject({ runId: z.string().min(1).max(200) });
export const historyErrorStatuses = {
  HISTORY_ACCESS_DENIED: 403,
  HISTORY_NOT_FOUND: 404,
  HISTORY_INPUT_INVALID: 400,
  HISTORY_CONFLICT: 409,
  HISTORY_LIMIT: 413,
  HISTORY_LEASE_LOST: 409,
} as const;

/** Mount under the existing same-origin guard and native authentication, never by tenant headers. */
export function createHistoryRoutes(
  forActor: (actor: AuthenticatedActor, request: Request) => BoundHistory,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  routes.use("*", requireUser, bodyLimit({ maxSize: 4000 }));
  routes.onError((error, context) =>
    error instanceof HistoryError
      ? context.json({ code: error.code }, historyErrorStatuses[error.code])
      : context.json({ code: "HISTORY_UNAVAILABLE" }, 503),
  );
  routes.get("/", async (context) =>
    context.json({
      threads: await forActor(context.var.actor, context.req.raw).list(),
    }),
  );
  routes.post("/", async (context) => {
    const body = mintInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success) throw new HistoryError("HISTORY_INPUT_INVALID");
    return context.json(
      {
        thread: await forActor(context.var.actor, context.req.raw).mint(
          body.data,
        ),
      },
      201,
    );
  });
  routes.get("/:threadId/messages", async (context) =>
    context.json(
      await forActor(context.var.actor, context.req.raw).snapshot(
        context.req.param("threadId"),
      ),
    ),
  );
  routes.get("/:threadId/events", async (context) => {
    const after = Number(context.req.query("after") ?? "0");
    return context.json(
      await forActor(context.var.actor, context.req.raw).page(
        context.req.param("threadId"),
        after,
      ),
    );
  });
  routes.post("/:threadId/stop", async (context) => {
    const body = stopInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success) throw new HistoryError("HISTORY_INPUT_INVALID");
    return context.json({
      stopped: await forActor(context.var.actor, context.req.raw).stop(
        context.req.param("threadId"),
        body.data.runId,
      ),
    });
  });
  return routes;
}
