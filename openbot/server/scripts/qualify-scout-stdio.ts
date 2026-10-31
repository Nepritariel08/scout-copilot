/** Manual fail-closed qualification against a synthetic local JSON-2 endpoint. */
import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseScoutBinding } from "../src/scout/binding";
import { createScoutConnector } from "../src/scout/mcp";
import type { QueueReceipt } from "../src/scout/types";

const python = process.env.SCOUT_TEST_PYTHON;
const cwd = process.env.SCOUT_TEST_QUEUE_CWD;
if (!python || !cwd)
  throw new Error(
    "Set SCOUT_TEST_PYTHON and SCOUT_TEST_QUEUE_CWD to the approved pinned requester connector. No test was run.",
  );

const directory = await mkdtemp(join(tmpdir(), "scout-stdio-qualification-"));
const keyPath = join(directory, "synthetic.key");
const key = "SYNTHETIC_SCOUT_QUALIFICATION_ONLY";
const methods: string[] = [];
const sources = new Set<string>();
const rows = new Map<string, QueueReceipt>();
let dropped = false;
let acceptCalls = 0;
let cancelCalls = 0;
const inputSchema = z.object({
  context: z.object({ allowed_company_ids: z.array(z.number()) }),
  title: z.string().optional(),
  instructions: z.string().optional(),
  request_key: z.string().optional(),
  source_surface: z.string().optional(),
  work_item_id: z.number().optional(),
  revision: z.number().optional(),
});
await writeFile(keyPath, key, { mode: 0o600 });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (
      request.headers.get("authorization") !== `Bearer ${key}` ||
      request.headers.get("x-odoo-database") !== "synthetic_odoo"
    )
      return new Response(null, { status: 403 });
    const body = inputSchema.parse(await request.json());
    assert.deepEqual(body.context.allowed_company_ids, [1, 2]);
    const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
    methods.push(method);
    if (method === "queue_context")
      return Response.json({
        database: "synthetic_odoo",
        uid: 11,
        company_ids: [1, 2],
        worker: false,
        business_actions_enabled: false,
        task_kinds: ["draft_analysis"],
      });
    if (method === "queue_submit") {
      assert.ok(body.request_key && body.title && body.instructions);
      sources.add(body.source_surface ?? "missing");
      if (!rows.has(body.request_key))
        rows.set(body.request_key, {
          id: rows.size + 1,
          request_key: body.request_key,
          requested_by: 11,
          company_id: 1,
          revision: 1,
          state: "queued",
          task_kind: "draft_analysis",
          accepted: false,
          result: null,
        });
      if (!dropped) {
        dropped = true;
        return new Response("SYNTHETIC_PRIVATE_ERROR_MUST_NOT_ESCAPE", {
          status: 503,
        });
      }
      return Response.json(rows.get(body.request_key));
    }
    const row = [...rows.values()].find(
      (value) => value.id === body.work_item_id,
    );
    if (!row) return new Response(null, { status: 404 });
    if (method === "queue_get") return Response.json(row);
    if (method === "queue_accept" || method === "queue_cancel") {
      assert.equal(body.revision, row.revision);
      row.revision++;
      if (method === "queue_accept") {
        acceptCalls++;
        row.state = "completed";
        row.accepted = true;
      } else {
        cancelCalls++;
        row.state = "cancelled";
      }
      return Response.json(row);
    }
    return new Response(null, { status: 404 });
  },
});

try {
  const binding = parseScoutBinding(
    {
      version: 1,
      deploymentId: "stdio-synthetic-qualification",
      policies: [
        {
          tenantId: "synthetic",
          revision: 1,
          active: true,
          draftAnalysis: true,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
      bindings: [
        {
          userId: "synthetic-native-user",
          tenantId: "synthetic",
          policyRevision: 1,
          active: true,
          expiresAt: "2099-01-01T00:00:00Z",
          command: [python, "-m", "scout_queue.mcp_server"],
          cwd,
          environment: {
            SCOUT_ODOO_URL: server.url.origin,
            SCOUT_ODOO_DB: "synthetic_odoo",
            SCOUT_ODOO_UID: "11",
            SCOUT_ODOO_COMPANY_IDS: "1,2",
            SCOUT_ODOO_KEY_FILE: keyPath,
          },
        },
      ],
    },
    { id: "synthetic-native-user" },
  );
  const connect = createScoutConnector();
  const payload = {
    title: "Synthetic stdio draft",
    instructions: "Return a synthetic marker.",
    request_key: "scout:stdio-qualification",
  };
  let unconfirmed = false;
  try {
    await connect(binding, (queue) => queue.submit(payload));
  } catch (error) {
    assert.equal(
      error instanceof Error ? error.message : "",
      "SCOUT_QUEUE_UNAVAILABLE",
    );
    unconfirmed = true;
  }
  assert.equal(unconfirmed, true);
  const recovered = await connect(binding, (queue) => queue.submit(payload));
  assert.equal(recovered.id, 1);
  assert.equal(rows.size, 1);
  const row = rows.get(payload.request_key);
  assert.ok(row);
  row.state = "review_required";
  row.result = "SCOUT_STDIO_SYNTHETIC_OK";
  row.revision++;
  await connect(binding, async (queue) => {
    const draft = await queue.get(1, payload.request_key);
    assert.equal(draft.result, "SCOUT_STDIO_SYNTHETIC_OK");
    await queue.change("accept", 1, draft.revision, payload.request_key);
    assert.equal((await queue.get(1, payload.request_key)).accepted, true);
  });
  await connect(binding, async (queue) => {
    const second = await queue.submit({
      ...payload,
      request_key: "scout:stdio-cancel",
    });
    await queue.change(
      "cancel",
      second.id,
      second.revision,
      second.request_key,
    );
    assert.equal(
      (await queue.get(second.id, second.request_key)).state,
      "cancelled",
    );
  });
  assert.equal(acceptCalls, 1);
  assert.equal(cancelCalls, 1);
  console.log(
    JSON.stringify({
      result: "pass",
      scope:
        "real stdio MCP to pinned Python connector and synthetic local JSON-2",
      uniqueItems: rows.size,
      acceptCalls,
      cancelCalls,
      recoveredLostSubmitReply: true,
      methods: [...new Set(methods)].sort(),
      observedSourceSurfaces: [...sources],
      liveOdooOrDsh: false,
    }),
  );
} finally {
  server.stop(true);
  await rm(keyPath, { force: true });
  await rmdir(directory);
}
