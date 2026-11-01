import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { ScoutService } from "./service";
import { ScoutError } from "./types";

const messages = {
  SCOUT_NOT_CONFIGURED: "The DSH queue is not configured for this account.",
  SCOUT_ACCESS_DENIED: "This account has no active DSH queue permission.",
  SCOUT_TASK_NOT_FOUND: "Draft task not found.",
  SCOUT_INPUT_INVALID: "Check the task fields and try again.",
  SCOUT_CONFLICT:
    "The task or its permissions changed. Refresh and review it first.",
  SCOUT_QUEUE_UNAVAILABLE:
    "The queue operation was not confirmed. Refresh or recover the existing task.",
  SCOUT_RECEIPT_INVALID:
    "The queue response could not be verified. Contact the administrator.",
} as const;

export function createScoutRoutes(
  service: ScoutService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 40_000 }));
  routes.onError((error, context) => {
    if (error instanceof ScoutError)
      return context.json(
        { code: error.code, error: messages[error.code] },
        error.status,
      );
    return context.json(
      {
        code: "SCOUT_QUEUE_UNAVAILABLE",
        error: messages.SCOUT_QUEUE_UNAVAILABLE,
      },
      503,
    );
  });
  routes.get("/", async (context) =>
    context.json({
      tasks: await service.list(
        context.var.actor,
        context.req.query("channelId"),
      ),
    }),
  );
  routes.post("/", async (context) =>
    context.json({
      task: await service.submit(
        context.var.actor,
        await body(context.req.raw),
      ),
    }),
  );
  routes.post("/:id", async (context) =>
    context.json({
      task: await service.act(
        context.var.actor,
        context.req.param("id"),
        await body(context.req.raw),
      ),
    }),
  );
  return routes;
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ScoutError("SCOUT_INPUT_INVALID", 400);
  }
}
