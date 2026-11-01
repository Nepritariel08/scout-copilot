import type { AbstractAgent } from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables, AuthenticatedActor } from "../../auth/guards";
import { createHistoryRuntimeHandler } from "../history/endpoint";
import { HistoryError } from "../history/protocol";
import { createHistoryRoutes, historyErrorStatuses } from "../history/routes";
import type { createHistoryEngine } from "../history/runner";
import type { createOwnedAuthority } from "./authority";

const mintInput = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
});

/** Adapts the existing Scout UI URLs; all identity comes from the native session. */
export function createOwnedRuntimeRoutes(deps: {
  authority: ReturnType<typeof createOwnedAuthority>;
  engine: ReturnType<typeof createHistoryEngine>;
  agents(
    actor: AuthenticatedActor,
    request: Request,
  ): Promise<Record<string, AbstractAgent>>;
  generativeUi: boolean;
  modelReceipts?: (request: Request, threadId: string) => Promise<unknown>;
}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  const bound = (request: Request) =>
    deps.engine.bind(deps.authority.forRequest(request));
  app.use("/api/threads/*", deps.authority.requireTenant);
  app.use("/api/threads/*", bodyLimit({ maxSize: 4000 }));
  app.use("/api/copilotkit/*", deps.authority.requireTenant);
  app.use("/api/scout/model/*", deps.authority.requireTenant);
  app.get("/api/scout/model/:threadId/receipts", async (context) => {
    if (!deps.modelReceipts)
      return context.json({ code: "MODEL_NOT_CONFIGURED" }, 503);
    return context.json({
      calls: await deps.modelReceipts(
        context.req.raw,
        context.req.param("threadId"),
      ),
    });
  });
  app.onError((error, context) =>
    error instanceof HistoryError
      ? context.json({ code: error.code }, historyErrorStatuses[error.code])
      : context.json({ code: "HISTORY_UNAVAILABLE" }, 503),
  );
  app.post("/api/threads/mint", async (context) => {
    const parsed = mintInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ code: "HISTORY_INPUT_INVALID" }, 400);
    const thread = await bound(context.req.raw).history.mint(parsed.data);
    return context.json({ threadId: thread.id });
  });
  app.get("/api/threads/:threadId", async (context) => {
    try {
      await bound(context.req.raw).history.get(context.req.param("threadId"));
    } catch (error) {
      if (error instanceof HistoryError && error.code === "HISTORY_NOT_FOUND")
        return context.json({ known: false });
      throw error;
    }
    return context.json({ known: true });
  });
  app.route(
    "/api/scout/threads",
    createHistoryRoutes(
      (_actor, request) => bound(request).history,
      deps.authority.requireTenant,
    ),
  );
  app.get("/api/copilotkit/threads/:threadId/messages", async (context) => {
    const history = bound(context.req.raw).history;
    const threadId = context.req.param("threadId");
    const agentId = context.req.query("agentId");
    if (agentId) await history.check(threadId, "read", agentId);
    return context.json(await history.snapshot(threadId));
  });
  app.all("/api/copilotkit/*", async (context) => {
    const current = bound(context.req.raw);
    const runtime = new CopilotRuntime({
      agents: await deps.agents(context.var.actor, context.req.raw),
      runner: current.runner,
      ...(deps.generativeUi ? { openGenerativeUI: true } : {}),
      a2ui: { enabled: deps.generativeUi },
    });
    return createHistoryRuntimeHandler(
      runtime,
      current.history,
      "/api/copilotkit",
    )(context.req.raw);
  });
  const handler = new Hono();
  handler.route("/", app);
  return handler;
}
