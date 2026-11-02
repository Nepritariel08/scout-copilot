import { createOpenAI } from "@ai-sdk/openai";
import type { PlanLanguageModel } from "../../agents/plan-model";
import { HistoryError, historyDigest } from "../history/protocol";
import { ScoutError } from "../types";
import {
  type ModelGrant,
  ModelPolicyError,
  openRouterOwnedPreferences,
  PAID_PHALA_PROFILE,
  readModelKey,
} from "./policy";
import type { ModelCallStore, ModelRun, ModelUsage } from "./store";

type Options = Parameters<PlanLanguageModel["doStream"]>[0];
type Result = Awaited<ReturnType<PlanLanguageModel["doStream"]>>;
type Part = Result["stream"] extends ReadableStream<infer T> ? T : never;
type Generated = Awaited<ReturnType<PlanLanguageModel["doGenerate"]>>;
const safeError = (error: unknown) => {
  if (error instanceof ModelPolicyError) return error;
  if (
    (error instanceof HistoryError && error.code === "HISTORY_ACCESS_DENIED") ||
    (error instanceof ScoutError && error.code === "SCOUT_ACCESS_DENIED")
  )
    return new ModelPolicyError("MODEL_ACCESS_DENIED");
  return new ModelPolicyError("MODEL_UNAVAILABLE");
};

function messagesFor(options: Options, trustedContext?: string) {
  if (
    options.prompt.length > 500 ||
    (options.responseFormat && options.responseFormat.type !== "text")
  )
    throw new ModelPolicyError("MODEL_ACCESS_DENIED");
  const messages = options.prompt.map((message) => {
    if (message.role === "system")
      return { role: message.role, content: message.content };
    if (message.role !== "user" && message.role !== "assistant")
      throw new ModelPolicyError("MODEL_ACCESS_DENIED");
    if (message.content.some((part) => part.type !== "text"))
      throw new ModelPolicyError("MODEL_ACCESS_DENIED");
    return {
      role: message.role,
      content: message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
    };
  });
  return trustedContext
    ? [{ role: "system" as const, content: trustedContext }, ...messages]
    : messages;
}

/** Text-only first model port. No environment fallback, browser tools, files, retrieval or remote agent. */
export class OwnedTextModel implements PlanLanguageModel {
  readonly specificationVersion = "v3" as const;
  readonly provider = "scout-owned";
  readonly supportedUrls = {};
  get modelId() {
    return this.initialGrant.route.model;
  }
  constructor(
    private readonly scope: ModelRun,
    private readonly initialGrant: ModelGrant,
    private readonly authorize: () => Promise<ModelGrant>,
    private readonly store: ModelCallStore,
    private readonly runSignal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
    private readonly trustedContext?: string,
  ) {}

  private async currentGrant(fingerprint: string, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const current = await this.authorize();
      // Revocation/abort may arrive while native identity, history or policy is being read.
      signal.throwIfAborted();
      if (
        current.fingerprint !== fingerprint ||
        !current.active ||
        !(Date.parse(current.expiresAt) > Date.now())
      )
        throw new ModelPolicyError("MODEL_ACCESS_DENIED");
      return current;
    } catch (error) {
      throw safeError(error);
    }
  }

  async doGenerate(options: Options): Promise<Generated> {
    const { stream } = await this.doStream(options);
    const content: Generated["content"] = [];
    const text = new Map<string, { type: "text"; text: string }>();
    let finish: Extract<Part, { type: "finish" }> | undefined;
    for await (const part of stream) {
      if (part.type === "text-start") {
        const item = { type: "text" as const, text: "" };
        text.set(part.id, item);
        content.push(item);
      }
      if (part.type === "text-delta") {
        const item = text.get(part.id);
        if (item) item.text += part.delta;
      }
      if (part.type === "finish") finish = part;
      if (part.type === "error") throw safeError(part.error);
    }
    if (!finish) throw new ModelPolicyError("MODEL_UNAVAILABLE");
    // The answer is still private after the final asynchronous stream-close read.
    await this.currentGrant(
      this.initialGrant.fingerprint,
      AbortSignal.any([
        this.runSignal,
        ...(options.abortSignal ? [options.abortSignal] : []),
      ]),
    );
    return {
      content,
      finishReason: finish.finishReason,
      usage: finish.usage,
      warnings: [],
    };
  }

  async doStream(options: Options): Promise<Result> {
    try {
      return await this.openStream(options);
    } catch (error) {
      throw safeError(error);
    }
  }

  private async openStream(options: Options): Promise<Result> {
    let grant = await this.authorize();
    if (grant.fingerprint !== this.initialGrant.fingerprint)
      throw new ModelPolicyError("MODEL_ACCESS_DENIED");
    const paid =
      grant.route.provider === "openrouter" && !!grant.route.paidProfile;
    // The public built-in agent advertises its own tools. This text-only port discards all
    // definitions/selection rather than forwarding them; tool content and provider calls still deny.
    const body = {
      model: grant.route.model,
      messages: messagesFor(options, this.trustedContext),
      stream: true,
      max_tokens: grant.limits.maxOutputTokens,
      ...(grant.route.provider === "openrouter"
        ? {
            stream_options: { include_usage: true },
            provider: openRouterOwnedPreferences(grant),
          }
        : {}),
    };
    const serialized = JSON.stringify(body);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > grant.limits.maxInputBytes)
      throw new ModelPolicyError("MODEL_LIMIT");
    const baseURL =
      grant.route.provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : grant.route.baseUrl.replace(/\/$/, "");
    const endpoint = `${baseURL}/chat/completions`;
    const call = await this.store.reserve(this.scope, grant, {
      digest: historyDigest(body),
      bytes,
      endpointOrigin: new URL(endpoint).origin,
    });
    let dispatched = false,
      settled = false,
      outputBytes = 0;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      grant.limits.timeoutMs,
    );
    const signal = AbortSignal.any([
      controller.signal,
      this.runSignal,
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    const usage: ModelUsage = {
      outputBytes: 0,
      inputTokens: null,
      outputTokens: null,
      reportedCostUsd: null,
      reportedModel: null,
    };
    let providerFinishReason: "stop" | "length" | null = null;
    let usageReceived = false;
    const fail = async (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller.abort();
      await this.store.finish(
        call,
        dispatched ? "uncertain" : "refused",
        { ...usage, outputBytes },
        safeError(error).code,
      );
    };
    const onAbort = () => {
      void fail(new ModelPolicyError("MODEL_UNAVAILABLE")).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const revalidate = () => this.currentGrant(grant.fingerprint, signal);
    try {
      const key = await readModelKey(grant);
      grant = await revalidate();
      await this.store.dispatch(this.scope, call, grant);
      dispatched = true;
      await revalidate();
      const model = createOpenAI({
        baseURL,
        apiKey: key ?? "scout-local-no-key",
        fetch: Object.assign(
          async () => {
            // Build the entire outbound request here: SDK/provider/browser options cannot override it.
            await revalidate();
            const response = await this.transport(endpoint, {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                "content-type": "application/json",
                ...(key ? { authorization: `Bearer ${key}` } : {}),
              },
              body: serialized,
            });
            if (!response.ok || !response.body) {
              await response.body?.cancel().catch(() => {});
              throw new ModelPolicyError("MODEL_UNAVAILABLE");
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = "",
              wireBytes = 0;
            const inspect = (line: string) => {
              if (!line.startsWith("data:")) return;
              const json = line.slice(5).trim();
              if (!json) return;
              if (json === "[DONE]") {
                if (providerFinishReason === null)
                  throw new ModelPolicyError("MODEL_UNAVAILABLE");
                return;
              }
              let value: unknown;
              try {
                value = JSON.parse(json);
              } catch {
                throw new ModelPolicyError("MODEL_UNAVAILABLE");
              }
              if (!value || typeof value !== "object")
                throw new ModelPolicyError("MODEL_UNAVAILABLE");
              const packet = value as Record<string, unknown>;
              if (packet.error) throw new ModelPolicyError("MODEL_UNAVAILABLE");
              const hasUsage =
                packet.usage !== null &&
                typeof packet.usage === "object" &&
                !Array.isArray(packet.usage);
              if (hasUsage && usageReceived)
                throw new ModelPolicyError("MODEL_UNAVAILABLE");
              if (
                typeof packet.model === "string" &&
                /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(packet.model)
              )
                usage.reportedModel = packet.model;
              if (Array.isArray(packet.choices))
                for (const choice of packet.choices) {
                  if (!choice || typeof choice !== "object")
                    throw new ModelPolicyError("MODEL_UNAVAILABLE");
                  if (choice.index !== 0)
                    throw new ModelPolicyError("MODEL_UNAVAILABLE");
                  if (providerFinishReason !== null) {
                    // OpenRouter repeats the terminal reason on its final accounting frame.
                    // Admit that one content-free tail, never a second generated response.
                    const delta = choice.delta;
                    if (
                      grant.route.provider !== "openrouter" ||
                      !hasUsage ||
                      packet.choices.length !== 1 ||
                      choice.finish_reason !== providerFinishReason ||
                      choice.message !== undefined ||
                      !delta ||
                      typeof delta !== "object" ||
                      Array.isArray(delta) ||
                      !Object.entries(delta).every(
                        ([key, value]) =>
                          (key === "content" &&
                            (value == null || value === "")) ||
                          (key === "role" &&
                            (value == null || value === "assistant")),
                      )
                    )
                      throw new ModelPolicyError("MODEL_UNAVAILABLE");
                  }
                  if (
                    choice.finish_reason !== null &&
                    choice.finish_reason !== undefined
                  ) {
                    if (
                      choice.finish_reason !== "stop" &&
                      choice.finish_reason !== "length"
                    )
                      throw new ModelPolicyError("MODEL_UNAVAILABLE");
                    providerFinishReason = choice.finish_reason;
                  }
                  for (const part of [choice.delta, choice.message])
                    if (
                      part &&
                      typeof part === "object" &&
                      (part.tool_calls ||
                        part.function_call ||
                        part.audio ||
                        part.images)
                    )
                      throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                }
              if (hasUsage) {
                usageReceived = true;
                const reported = packet.usage as Record<string, unknown>;
                for (const [source, destination] of [
                  ["prompt_tokens", "inputTokens"],
                  ["completion_tokens", "outputTokens"],
                ] as const) {
                  const n = reported[source];
                  if (n !== undefined && n !== null) {
                    if (
                      typeof n !== "number" ||
                      !Number.isSafeInteger(n) ||
                      n < 0
                    )
                      throw new ModelPolicyError("MODEL_UNAVAILABLE");
                    if (n > 2147483647)
                      throw new ModelPolicyError(
                        paid ? "MODEL_COST_VIOLATION" : "MODEL_UNAVAILABLE",
                      );
                    usage[destination] = n;
                    if (
                      paid &&
                      n >
                        (source === "prompt_tokens"
                          ? PAID_PHALA_PROFILE.maxInputTokens
                          : grant.limits.maxOutputTokens)
                    )
                      throw new ModelPolicyError("MODEL_COST_VIOLATION");
                  }
                }
                if (reported.cost !== undefined && reported.cost !== null) {
                  const cost = reported.cost;
                  if (
                    typeof cost !== "number" ||
                    !Number.isFinite(cost) ||
                    cost < 0
                  )
                    throw new ModelPolicyError("MODEL_UNAVAILABLE");
                  if (cost > 1000000)
                    throw new ModelPolicyError(
                      grant.route.provider === "openrouter"
                        ? "MODEL_COST_VIOLATION"
                        : "MODEL_UNAVAILABLE",
                    );
                  usage.reportedCostUsd = cost.toFixed(12);
                  if (
                    grant.route.provider === "openrouter" &&
                    cost > (paid ? PAID_PHALA_PROFILE.maxCostUsd : 0)
                  )
                    throw new ModelPolicyError("MODEL_COST_VIOLATION");
                }
              }
            };
            return new Response(
              new ReadableStream<Uint8Array>({
                async pull(out) {
                  try {
                    signal.throwIfAborted();
                    const item = await reader.read();
                    if (item.done) {
                      pending += decoder.decode();
                      for (const line of pending.split(/\r?\n/)) inspect(line);
                      pending = "";
                      // The SDK synthesizes a finish when a socket closes. Require the provider's
                      // terminal reason so a cleanly truncated answer cannot become completed.
                      if (providerFinishReason === null)
                        throw new ModelPolicyError("MODEL_UNAVAILABLE");
                      if (
                        paid &&
                        (usage.inputTokens === null ||
                          usage.outputTokens === null ||
                          usage.reportedCostUsd === null)
                      )
                        throw new ModelPolicyError("MODEL_UNAVAILABLE");
                      out.close();
                      return;
                    }
                    wireBytes += item.value.byteLength;
                    if (wireBytes > grant.limits.maxOutputBytes * 4 + 65536)
                      throw new ModelPolicyError("MODEL_LIMIT");
                    pending += decoder.decode(item.value, { stream: true });
                    if (pending.length > 262144)
                      throw new ModelPolicyError("MODEL_LIMIT");
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop() ?? "";
                    for (const line of lines) inspect(line);
                    out.enqueue(item.value);
                  } catch (error) {
                    await reader.cancel().catch(() => {});
                    out.error(safeError(error));
                  }
                },
                cancel: () => reader.cancel(),
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
          { preconnect: fetch.preconnect },
        ),
      }).chat(grant.route.model);
      const result = await model.doStream({
        ...options,
        abortSignal: signal,
        tools: [],
        providerOptions: {},
        headers: {},
        includeRawChunks: false,
      });
      const reader = result.stream.getReader();
      const store = this.store;
      return {
        stream: new ReadableStream<Part>(
          {
            async pull(out) {
              try {
                for (;;) {
                  signal.throwIfAborted();
                  const item = await reader.read();
                  // Recheck after the provider/SDK wait, including each decoded part from
                  // a buffered wire chunk, before releasing any content or identifiers.
                  await revalidate();
                  if (item.done) {
                    if (!settled)
                      throw new ModelPolicyError("MODEL_UNAVAILABLE");
                    signal.removeEventListener("abort", onAbort);
                    out.close();
                    return;
                  }
                  const part = item.value;
                  if (part.type === "error") throw safeError(part.error);
                  if (part.type.startsWith("tool-") || part.type === "file")
                    throw new ModelPolicyError("MODEL_ACCESS_DENIED");
                  if (
                    part.type === "text-delta" ||
                    part.type === "reasoning-delta"
                  ) {
                    outputBytes += Buffer.byteLength(part.delta);
                    if (outputBytes > grant.limits.maxOutputBytes)
                      throw new ModelPolicyError("MODEL_LIMIT");
                  }
                  if (part.type === "finish") {
                    if (providerFinishReason === null)
                      throw new ModelPolicyError("MODEL_UNAVAILABLE");
                    await store.finish(call, "completed", {
                      ...usage,
                      outputBytes,
                    });
                    settled = true;
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", onAbort);
                    // A committed receipt remains counted even if authority changes while
                    // persistence awaits; it does not authorize a stale terminal response.
                    await revalidate();
                    out.enqueue({
                      type: "finish",
                      finishReason: {
                        unified: part.finishReason.unified,
                        raw: undefined,
                      },
                      usage: part.usage,
                    });
                    return;
                  }
                  // Never forward provider metadata, raw payloads, request/response bodies or warning strings.
                  if (part.type === "stream-start")
                    out.enqueue({ type: "stream-start", warnings: [] });
                  else if (
                    part.type === "text-start" ||
                    part.type === "text-end" ||
                    part.type === "reasoning-start" ||
                    part.type === "reasoning-end"
                  )
                    out.enqueue({ type: part.type, id: part.id });
                  else if (
                    part.type === "text-delta" ||
                    part.type === "reasoning-delta"
                  )
                    out.enqueue({
                      type: part.type,
                      id: part.id,
                      delta: part.delta,
                    });
                  else continue;
                  // Dropped SDK metadata does not fulfill a pending read; keep reading
                  // until one allowed part is available, then preserve backpressure.
                  return;
                }
              } catch (error) {
                await reader.cancel().catch(() => {});
                await fail(error);
                signal.removeEventListener("abort", onAbort);
                out.error(safeError(error));
              }
            },
            async cancel() {
              await reader.cancel().catch(() => {});
              await fail(new ModelPolicyError("MODEL_UNAVAILABLE"));
              signal.removeEventListener("abort", onAbort);
            },
          },
          { highWaterMark: 0 },
        ),
      };
    } catch (error) {
      await fail(error);
      signal.removeEventListener("abort", onAbort);
      throw safeError(error);
    }
  }
}
