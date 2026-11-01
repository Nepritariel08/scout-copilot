import {
  type CopilotRuntimeLike,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { HistoryError } from "./protocol";
import type { BoundHistory } from "./service";

async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.clone().body?.getReader();
  if (!reader) throw new HistoryError("HISTORY_INPUT_INVALID");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1_048_576) throw new HistoryError("HISTORY_LIMIT");
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new HistoryError("HISTORY_INPUT_INVALID");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError("HISTORY_INPUT_INVALID");
  } finally {
    // A tee branch must not await cancellation while the other branch remains unread.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const statuses = {
  HISTORY_ACCESS_DENIED: 403,
  HISTORY_NOT_FOUND: 404,
  HISTORY_INPUT_INVALID: 400,
  HISTORY_CONFLICT: 409,
  HISTORY_LIMIT: 413,
  HISTORY_LEASE_LOST: 409,
} as const;

/** Public MIT SDK transport. Construct with a request-bound runner and authorized agent roster. */
export function createHistoryRuntimeHandler(
  runtime: CopilotRuntimeLike,
  history: BoundHistory,
  basePath: string,
) {
  if (runtime.mode !== "sse") throw new HistoryError("HISTORY_INPUT_INVALID");
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath,
    mode: "multi-route",
    cors: false,
    activateChannels: false,
    hooks: {
      async onBeforeHandler({ route, request }) {
        // Other SDK routes need their own policy, persistence and model-budget adaptation.
        if (
          !["info", "agent/run", "agent/connect", "agent/stop"].includes(
            route.method,
          )
        )
          throw Response.json(
            { code: "HISTORY_ROUTE_UNAVAILABLE" },
            { status: 404 },
          );
        if (route.method === "info") return;
        try {
          const value = await body(request);
          const threadId =
            route.method === "agent/stop" ? route.threadId : value.threadId;
          if (
            typeof threadId !== "string" ||
            !threadId ||
            threadId.length > 200
          )
            throw new HistoryError("HISTORY_INPUT_INVALID");
          if (
            route.method === "agent/stop" &&
            (typeof value.runId !== "string" || !value.runId)
          )
            throw new HistoryError("HISTORY_INPUT_INVALID");
          if (route.method === "agent/connect" && value.joinCode !== undefined)
            throw new HistoryError("HISTORY_ACCESS_DENIED");
          if (!("agentId" in route))
            throw new HistoryError("HISTORY_INPUT_INVALID");
          await history.check(
            threadId,
            route.method === "agent/run"
              ? "run"
              : route.method === "agent/stop"
                ? "stop"
                : "read",
            route.agentId,
          );
        } catch (error) {
          throw error instanceof HistoryError
            ? Response.json(
                { code: error.code },
                { status: statuses[error.code] },
              )
            : Response.json({ code: "HISTORY_UNAVAILABLE" }, { status: 503 });
        }
      },
      onError() {
        return Response.json({ code: "HISTORY_UNAVAILABLE" }, { status: 503 });
      },
    },
  });
  return async (request: Request) => {
    const response = await handler(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  };
}
