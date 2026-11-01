import { createHash } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  defaultApplyEvents,
  type Message,
  type RunAgentInput,
  type State,
} from "@ag-ui/client";
import {
  EventSchema,
  RunAgentInputSchema,
  RunFinishedInterruptOutcomeSchema,
} from "@ag-ui/core/schemas";
import jsonPatch, { type Operation } from "fast-json-patch";
import { EMPTY, from } from "rxjs";

export class HistoryError extends Error {
  constructor(
    readonly code:
      | "HISTORY_ACCESS_DENIED"
      | "HISTORY_NOT_FOUND"
      | "HISTORY_INPUT_INVALID"
      | "HISTORY_CONFLICT"
      | "HISTORY_LIMIT"
      | "HISTORY_LEASE_LOST",
  ) {
    super(code);
    this.name = "HistoryError";
  }
}

export type HistoryPrincipal = { userId: string; tenantId: string };
export type HistorySnapshot = { messages: Message[]; state: State };

/** Normalize wire JSON before hashing; JSONB may reorder object keys. */
export function historyJson<T>(value: T, maxBytes = 1_048_576): T {
  try {
    const text = JSON.stringify(value, (_key, part: unknown) => {
      if (
        typeof part === "bigint" ||
        typeof part === "function" ||
        typeof part === "symbol" ||
        (typeof part === "number" && !Number.isFinite(part))
      )
        throw new Error("not wire JSON");
      return part;
    });
    if (!text || Buffer.byteLength(text) > maxBytes)
      throw new HistoryError("HISTORY_LIMIT");
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError("HISTORY_INPUT_INVALID");
  }
}

function sorted(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new HistoryError("HISTORY_LIMIT");
  if (Array.isArray(value)) return value.map((part) => sorted(part, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          sorted((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  return value;
}

export function historyDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(historyJson(value))))
    .digest("hex");
}

export function historyInput(value: RunAgentInput): RunAgentInput {
  const parsed = RunAgentInputSchema.safeParse(historyJson(value));
  if (!parsed.success) throw new HistoryError("HISTORY_INPUT_INVALID");
  if (
    !parsed.data.threadId.trim() ||
    !parsed.data.runId.trim() ||
    parsed.data.threadId.length > 200 ||
    parsed.data.runId.length > 200 ||
    parsed.data.messages.some(
      (message) => !message.id || message.id.length > 200,
    )
  )
    throw new HistoryError("HISTORY_INPUT_INVALID");
  return parsed.data;
}

/** Stored assistant/system history cannot be rewritten or supplied by the browser. */
export function mergeHistory(
  prior: Message[],
  incoming: Message[],
  allowEmpty = false,
): Message[] {
  const known = new Map(prior.map((message) => [message.id, message]));
  const pending = new Set<string>();
  for (const message of prior) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === "tool") pending.delete(message.toolCallId);
  }
  const additions: Message[] = [];
  const seen = new Set<string>();
  for (const message of incoming) {
    if (seen.has(message.id)) throw new HistoryError("HISTORY_CONFLICT");
    seen.add(message.id);
    const old = known.get(message.id);
    if (old) {
      if (historyDigest(old) !== historyDigest(message))
        throw new HistoryError("HISTORY_CONFLICT");
      continue;
    }
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId))
        throw new HistoryError("HISTORY_INPUT_INVALID");
    } else if (message.role !== "user" || "toolCalls" in message) {
      throw new HistoryError("HISTORY_INPUT_INVALID");
    }
    additions.push(message);
  }
  if (!additions.length && !allowEmpty)
    throw new HistoryError("HISTORY_INPUT_INVALID");
  return [...prior, ...additions];
}

/** Resume is an owned user's input, never a grant to a business tool. */
export function historyResume(
  input: RunAgentInput,
  terminal: BaseEvent | undefined,
  now: number,
): boolean {
  const pending =
    terminal?.type === "RUN_FINISHED"
      ? RunFinishedInterruptOutcomeSchema.safeParse(terminal.outcome)
      : undefined;
  const responses = input.resume ?? [];
  if (!pending?.success) {
    if (responses.length) throw new HistoryError("HISTORY_INPUT_INVALID");
    return false;
  }
  const ids = new Set(responses.map((entry) => entry.interruptId));
  const expected = pending.data.interrupts;
  if (
    !expected.length ||
    expected.some((entry) => !entry.id.trim() || entry.id.length > 200) ||
    new Set(expected.map((entry) => entry.id)).size !== expected.length
  )
    throw new HistoryError("HISTORY_INPUT_INVALID");
  if (
    responses.length !== expected.length ||
    ids.size !== responses.length ||
    expected.some((entry) => !ids.has(entry.id))
  )
    throw new HistoryError("HISTORY_CONFLICT");
  for (const interrupt of expected) {
    const response = responses.find(
      (entry) => entry.interruptId === interrupt.id,
    );
    if (
      response?.status !== "cancelled" &&
      interrupt.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(interrupt.expiresAt)) ||
        Date.parse(interrupt.expiresAt) <= now)
    )
      throw new HistoryError("HISTORY_CONFLICT");
  }
  return true;
}

export function historyEvent(
  event: BaseEvent,
  threadId: string,
  runId: string,
): BaseEvent {
  const parsed = EventSchema.safeParse(historyJson(event, 262_144));
  if (!parsed.success) throw new HistoryError("HISTORY_INPUT_INVALID");
  if (
    parsed.data.type === "RUN_FINISHED" &&
    parsed.data.outcome &&
    typeof parsed.data.outcome === "object" &&
    "type" in parsed.data.outcome &&
    parsed.data.outcome.type === "interrupt"
  ) {
    const pending = RunFinishedInterruptOutcomeSchema.safeParse(
      parsed.data.outcome,
    );
    if (
      !pending.success ||
      !pending.data.interrupts.length ||
      pending.data.interrupts.some(
        (entry) => !entry.id.trim() || entry.id.length > 200,
      ) ||
      new Set(pending.data.interrupts.map((entry) => entry.id)).size !==
        pending.data.interrupts.length
    )
      throw new HistoryError("HISTORY_INPUT_INVALID");
  }
  if (
    ("threadId" in parsed.data && parsed.data.threadId !== threadId) ||
    ("runId" in parsed.data && parsed.data.runId !== runId)
  )
    throw new HistoryError("HISTORY_INPUT_INVALID");
  return parsed.data;
}

/** Validate without logging state or permitting prototype mutation. */
export function historyState(state: State, event: BaseEvent): State {
  if (event.type === "STATE_SNAPSHOT") return historyJson(event.snapshot);
  if (event.type !== "STATE_DELTA") return state;
  try {
    if (!Array.isArray(event.delta)) throw new Error("invalid delta");
    return historyJson(
      jsonPatch.applyPatch(
        historyJson(state),
        historyJson(event.delta) as Operation[],
        true,
        false,
        true,
      ).newDocument,
    );
  } catch {
    throw new HistoryError("HISTORY_INPUT_INVALID");
  }
}

class SnapshotAgent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

/** Public SDK reducer only: replaying persisted events never invokes a model or tool. */
export async function replayHistory(
  input: RunAgentInput,
  events: BaseEvent[],
): Promise<HistorySnapshot> {
  let state = input.state;
  const safeEvents = events.map((event) => {
    if (event.type === "STATE_SNAPSHOT" || event.type === "STATE_DELTA") {
      state = historyState(state, event);
      // Feed snapshots to the SDK: its invalid-delta warning otherwise logs the full state.
      return { type: "STATE_SNAPSHOT", snapshot: state } as BaseEvent;
    }
    return event;
  });
  const agent = new SnapshotAgent({
    threadId: input.threadId,
    initialMessages: input.messages,
    initialState: input.state,
  });
  await new Promise<void>((resolve, reject) => {
    defaultApplyEvents(input, from(safeEvents), agent, []).subscribe({
      next(mutation) {
        if (mutation.messages !== undefined)
          agent.setMessages(mutation.messages);
        if (mutation.state !== undefined) agent.setState(mutation.state);
      },
      complete: resolve,
      error: reject,
    });
  });
  return historyJson(
    { messages: agent.messages, state: agent.state },
    64 * 1024 * 1024,
  );
}
