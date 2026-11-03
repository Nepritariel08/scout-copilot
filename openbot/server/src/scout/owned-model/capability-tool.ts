import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { PlanLanguageModel } from "../../agents/plan-model";
import { historyDigest } from "../history/protocol";
import { type OwnedCatalog, ownedCatalogSchema } from "../owned/catalog";
import { type ModelGrant, ModelPolicyError } from "./policy";

export const CAPABILITY_TOOL_NAME = "scout_capabilities" as const;
const argsSchema = z.strictObject({});
const callId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
type Options = Parameters<PlanLanguageModel["doStream"]>[0];
export const capabilityToolDefinition = {
  type: "function" as const,
  name: CAPABILITY_TOOL_NAME,
  description:
    "Report Scout's configured capabilities. This reads no business data and cannot connect apps or execute workflows.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
function deny(): never {
  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
}

/** A server-created per-run ledger. Neither browser context nor a model argument can construct it. */
export class OwnedCapabilityTool {
  private call?: { id: string; executing?: boolean; result?: string };
  private readonly catalog: OwnedCatalog;
  constructor(
    catalog: OwnedCatalog,
    private readonly initialGrant: ModelGrant,
    private readonly authorize: () => Promise<ModelGrant>,
    private readonly signal: AbortSignal,
  ) {
    this.catalog = ownedCatalogSchema.parse(catalog);
  }

  private async current() {
    this.signal.throwIfAborted();
    const grant = await this.authorize();
    this.signal.throwIfAborted();
    if (
      grant.fingerprint !== this.initialGrant.fingerprint ||
      !grant.active ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      grant.allowedToolNames?.[0] !== CAPABILITY_TOOL_NAME
    )
      deny();
  }

  /** Only the validated, accounted provider terminal can register a call for execution. */
  register(id: string, name: string, input: string) {
    if (
      this.call ||
      !callId.safeParse(id).success ||
      name !== CAPABILITY_TOOL_NAME
    )
      deny();
    this.assertArguments(input);
    this.call = { id };
  }

  assertArguments(input: string) {
    if (Buffer.byteLength(input) > 256) deny();
    try {
      if (!argsSchema.safeParse(JSON.parse(input)).success) deny();
    } catch {
      deny();
    }
  }

  definitions(options: Options) {
    // The public SDK adds AG-UI state tools. They are never exposed on this protected wire.
    const tools = (options.tools ?? []).filter(
      (tool) => tool.type === "function" && tool.name === CAPABILITY_TOOL_NAME,
    );
    if (
      tools.length !== 1 ||
      tools[0]?.type !== "function" ||
      tools[0].name !== CAPABILITY_TOOL_NAME
    )
      deny();
    const schema = tools[0].inputSchema;
    if (
      !schema ||
      typeof schema !== "object" ||
      schema.type !== "object" ||
      schema.additionalProperties !== false ||
      !schema.properties ||
      Object.keys(schema.properties).length !== 0 ||
      (schema.required !== undefined &&
        (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
      Object.keys(schema).some(
        (key) =>
          ![
            "$schema",
            "type",
            "properties",
            "additionalProperties",
            "required",
          ].includes(key),
      )
    )
      deny();
    // Ignore description, tool choice and provider metadata. The wire schema is ours.
    return [
      {
        type: "function",
        function: {
          name: capabilityToolDefinition.name,
          description: capabilityToolDefinition.description,
          parameters: capabilityToolDefinition.inputSchema,
        },
      },
    ];
  }

  grantedTool(): GrantedTool {
    return {
      name: CAPABILITY_TOOL_NAME,
      ref: `scout/${CAPABILITY_TOOL_NAME}`,
      description: capabilityToolDefinition.description,
      parameters: argsSchema,
      execute: async (args) => {
        if (
          !argsSchema.safeParse(args).success ||
          !this.call ||
          this.call.executing ||
          this.call.result !== undefined
        )
          deny();
        this.call.executing = true;
        await this.current();
        const result = JSON.stringify(ownedCatalogSchema.parse(this.catalog));
        if (Buffer.byteLength(result) > this.initialGrant.limits.maxOutputBytes)
          throw new ModelPolicyError("MODEL_LIMIT");
        await this.current();
        this.call.result = result;
        return result;
      },
    };
  }

  /** Historical status pairs are validated then omitted; only this run's exact result is sent. */
  messages(options: Options, trustedContext?: string) {
    const messages: Record<string, unknown>[] = [];
    let currentCall = false,
      currentResult = false;
    for (const message of options.prompt) {
      if (message.role === "system") {
        messages.push({ role: "system", content: message.content });
        continue;
      }
      if (message.role === "user" || message.role === "assistant") {
        let text = "";
        const calls: Record<string, unknown>[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            text += part.text;
            continue;
          }
          if (
            message.role !== "assistant" ||
            part.type !== "tool-call" ||
            part.toolName !== CAPABILITY_TOOL_NAME ||
            !callId.safeParse(part.toolCallId).success ||
            !argsSchema.safeParse(part.input).success ||
            part.providerExecuted
          )
            deny();
          if (part.toolCallId === this.call?.id) {
            if (currentCall) deny();
            currentCall = true;
            calls.push({
              id: part.toolCallId,
              type: "function",
              function: { name: CAPABILITY_TOOL_NAME, arguments: "{}" },
            });
          }
        }
        if (text || calls.length || message.role === "user")
          messages.push({
            role: message.role,
            content: text,
            ...(calls.length ? { tool_calls: calls } : {}),
          });
        continue;
      }
      if (message.role !== "tool") deny();
      for (const part of message.content) {
        if (
          part.type !== "tool-result" ||
          part.toolName !== CAPABILITY_TOOL_NAME ||
          !callId.safeParse(part.toolCallId).success ||
          (part.output.type !== "text" && part.output.type !== "json")
        )
          deny();
        let value: unknown;
        try {
          value =
            part.output.type === "text"
              ? JSON.parse(part.output.value)
              : part.output.value;
          // AG-UI persists a string result as JSON text, adding exactly one encoding layer.
          if (typeof value === "string") value = JSON.parse(value);
        } catch {
          deny();
        }
        if (!ownedCatalogSchema.safeParse(value).success) deny();
        if (part.toolCallId === this.call?.id) {
          if (
            !currentCall ||
            currentResult ||
            !this.call.result ||
            historyDigest(value) !== historyDigest(JSON.parse(this.call.result))
          )
            deny();
          currentResult = true;
          messages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: this.call.result,
          });
        }
      }
    }
    if (this.call && (!currentCall || !currentResult)) deny();
    return trustedContext
      ? [{ role: "system", content: trustedContext }, ...messages]
      : messages;
  }
}
