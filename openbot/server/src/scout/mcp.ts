import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type QueueConnector,
  type QueueReceipt,
  type QueueSession,
  queueReceipt,
  type ScoutBinding,
  ScoutError,
} from "./types";

export const SCOUT_REQUESTER_TOOLS = [
  "scout_queue_status",
  "scout_list_work",
  "scout_get_work",
  "scout_submit_work",
  "scout_accept_draft",
  "scout_cancel_work",
] as const;

/** Only protected binding values and the existing platform allowlist reach stdio. */
export function scoutConnectorEnvironment(
  binding: ScoutBinding,
  environment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    SCOUT_ODOO_URL: binding.environment.SCOUT_ODOO_URL,
    SCOUT_ODOO_DB: binding.environment.SCOUT_ODOO_DB,
    SCOUT_ODOO_UID: binding.environment.SCOUT_ODOO_UID,
    SCOUT_ODOO_COMPANY_IDS: binding.environment.SCOUT_ODOO_COMPANY_IDS,
    SCOUT_ODOO_KEY_FILE: binding.environment.SCOUT_ODOO_KEY_FILE,
  };
  const source = binding.environment.SCOUT_QUEUE_SOURCE_SURFACE;
  if (source !== undefined) {
    if (source !== "chatgpt" && source !== "api")
      throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
    env.SCOUT_QUEUE_SOURCE_SURFACE = source;
  }
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
  ]) {
    if (environment[key]) env[key] = environment[key];
  }
  return env;
}

function transportFor(binding: ScoutBinding): Transport {
  const transport = new StdioClientTransport({
    command: binding.command[0],
    args: binding.command.slice(1),
    cwd: binding.cwd,
    env: scoutConnectorEnvironment(binding),
    stderr: "ignore",
  });
  return transport;
}

/** Native MCP transport, restricted to the existing six requester operations. */
export function createScoutConnector(
  createTransport: (binding: ScoutBinding) => Transport = transportFor,
): QueueConnector {
  return async <T>(
    binding: ScoutBinding,
    use: (session: QueueSession) => Promise<T>,
  ): Promise<T> => {
    const client = new Client({
      name: "scout-dsh-requester",
      version: "1.0.0",
    });
    try {
      await client.connect(createTransport(binding), { timeout: 15_000 });
      const tools = await client.listTools({}, { timeout: 15_000 });
      const expected = new Set<string>(SCOUT_REQUESTER_TOOLS);
      if (
        tools.nextCursor ||
        tools.tools.length !== expected.size ||
        tools.tools.some((tool) => !expected.delete(tool.name))
      )
        throw new ScoutError("SCOUT_RECEIPT_INVALID", 503);

      async function call(name: string, args: Record<string, unknown> = {}) {
        const result = CallToolResultSchema.parse(
          await client.callTool(
            { name, arguments: args },
            CallToolResultSchema,
            { timeout: 15_000 },
          ),
        );
        if (result.isError)
          throw new ScoutError("SCOUT_QUEUE_UNAVAILABLE", 503);
        let value: unknown = result.structuredContent;
        if (!value) {
          const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          if (text.length > 100_000)
            throw new ScoutError("SCOUT_RECEIPT_INVALID", 503);
          value = JSON.parse(text);
        }
        if (JSON.stringify(value).length > 100_000)
          throw new ScoutError("SCOUT_RECEIPT_INVALID", 503);
        return value;
      }

      async function verify() {
        const value = z
          .object({
            database: z.literal(binding.identity.database),
            uid: z.literal(binding.identity.uid),
            company_ids: z.array(z.number().int().positive()),
            worker: z.literal(false),
            business_actions_enabled: z.literal(false),
            task_kinds: z.tuple([z.literal("draft_analysis")]),
          })
          .safeParse(await call("scout_queue_status"));
        if (
          !value.success ||
          JSON.stringify([...value.data.company_ids].sort((a, b) => a - b)) !==
            JSON.stringify(binding.identity.companyIds)
        )
          throw new ScoutError("SCOUT_RECEIPT_INVALID", 503);
      }

      function receipt(
        value: unknown,
        requestKey: string,
        id?: number,
      ): QueueReceipt {
        const parsed = queueReceipt.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.request_key !== requestKey ||
          parsed.data.accepted !== (parsed.data.state === "completed") ||
          parsed.data.requested_by !== binding.identity.uid ||
          !binding.identity.companyIds.includes(parsed.data.company_id) ||
          (id !== undefined && parsed.data.id !== id)
        )
          throw new ScoutError("SCOUT_RECEIPT_INVALID", 503);
        return parsed.data;
      }

      await verify();
      return await use({
        async submit(payload) {
          await verify();
          return receipt(
            await call("scout_submit_work", payload),
            payload.request_key,
          );
        },
        async get(id, requestKey) {
          await verify();
          return receipt(
            await call("scout_get_work", { work_item_id: id }),
            requestKey,
            id,
          );
        },
        async change(action, id, revision, requestKey) {
          await verify();
          const tool =
            action === "accept" ? "scout_accept_draft" : "scout_cancel_work";
          return receipt(
            await call(tool, { work_item_id: id, revision }),
            requestKey,
            id,
          );
        },
      });
    } catch (error) {
      if (error instanceof ScoutError) throw error;
      throw new ScoutError("SCOUT_QUEUE_UNAVAILABLE", 503);
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}
