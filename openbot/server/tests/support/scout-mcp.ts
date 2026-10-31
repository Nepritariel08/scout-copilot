import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createScoutConnector,
  SCOUT_REQUESTER_TOOLS,
} from "../../src/scout/mcp";
import type { QueueReceipt, ScoutBinding } from "../../src/scout/types";

/** Synthetic remote queue over the real MCP SDK, never a real Odoo/DSH task. */
export function scoutMcpFixture() {
  const items = new Map<string, QueueReceipt>();
  const servers: Server[] = [];
  const fixture = {
    items,
    submitCalls: 0,
    mutations: [] as string[],
    lostSubmitReply: false,
    lostAcceptReply: false,
    extraTool: false,
    paginatedTools: false,
    badIdentity: false,
    wrongReceiptOwner: false,
    beforeSubmit: undefined as (() => Promise<void>) | undefined,
    beforeAccept: undefined as (() => Promise<void>) | undefined,
    afterGet: undefined as (() => void) | undefined,
    finish() {
      for (const item of items.values()) {
        item.revision++;
        item.state = "review_required";
        item.result = "SCOUT_SYNTHETIC_DRAFT_OK";
      }
    },
    async close() {
      await Promise.all(servers.map((server) => server.close()));
    },
    connect: createScoutConnector((binding: ScoutBinding) => {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "synthetic-scout-queue", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      servers.push(server);
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        ...(fixture.paginatedTools
          ? { nextCursor: "unapproved-next-page" }
          : {}),
        tools: [
          ...SCOUT_REQUESTER_TOOLS,
          ...(fixture.extraTool ? ["arbitrary_orm"] : []),
        ].map((name) => ({
          name,
          inputSchema: { type: "object" as const, properties: {} },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments ?? {};
        const name = request.params.name;
        let value: unknown;
        if (name === "scout_queue_status") {
          value = {
            database: binding.identity.database,
            uid: binding.identity.uid,
            company_ids: binding.identity.companyIds,
            worker: fixture.badIdentity,
            business_actions_enabled: false,
            task_kinds: ["draft_analysis"],
          };
        } else if (name === "scout_submit_work") {
          fixture.submitCalls++;
          await fixture.beforeSubmit?.();
          const key = String(args.request_key);
          if (!items.has(key))
            items.set(key, {
              id: items.size + 1,
              request_key: key,
              revision: 1,
              state: "queued",
              task_kind: "draft_analysis",
              requested_by: binding.identity.uid,
              company_id: binding.identity.companyIds[0],
              accepted: false,
              result: null,
            });
          value = items.get(key);
          if (fixture.lostSubmitReply) {
            fixture.lostSubmitReply = false;
            throw new Error("SYNTHETIC_SECRET_MUST_NOT_LEAK");
          }
        } else {
          const item = [...items.values()].find(
            (row) => row.id === args.work_item_id,
          );
          if (!item) throw new Error("missing synthetic row");
          if (name === "scout_accept_draft" || name === "scout_cancel_work") {
            if (item.revision !== args.revision)
              throw new Error("synthetic revision conflict");
            if (name === "scout_accept_draft") await fixture.beforeAccept?.();
            fixture.mutations.push(name);
            item.revision++;
            item.state =
              name === "scout_accept_draft" ? "completed" : "cancelled";
            item.accepted = name === "scout_accept_draft";
            if (name === "scout_accept_draft" && fixture.lostAcceptReply) {
              fixture.lostAcceptReply = false;
              throw new Error("SYNTHETIC_SECRET_MUST_NOT_LEAK");
            }
          }
          value = {
            ...item,
            requested_by: fixture.wrongReceiptOwner ? 999 : item.requested_by,
          };
          if (name === "scout_get_work") fixture.afterGet?.();
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value as Record<string, unknown>,
        };
      });
      void server.connect(transport);
      return client;
    }),
  };
  return fixture;
}
