import type { ChatMessage } from "./api";
import { validOdooTaskId } from "./scout-work.ts";

export type OwnedRunInput = {
  threadId: string;
  runId: string;
  messages: ChatMessage[];
  state: Record<string, never>;
  tools: [];
  context: { description: "scout.project_task_id"; value: string }[];
  forwardedProps: Record<string, never>;
};

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type IdentityScopedData<T> = { userId: string; value: T };

/** Never render cached private state for a different or signed-out identity. */
export function dataForSignedInUser<T>(
  data: IdentityScopedData<T> | undefined,
  userId: string | undefined,
): T | undefined {
  return userId && data?.userId === userId ? data.value : undefined;
}

export function clearForIdentityChange<T>(
  data: IdentityScopedData<T> | undefined,
  userId: string | undefined,
): IdentityScopedData<T> | undefined {
  return userId && data?.userId === userId ? data : undefined;
}

/**
 * Return whether a failed turn's user message is in a successfully refreshed transcript.
 * `undefined` means the transcript could not be read, so restoring a draft could duplicate it.
 */
export function userMessagePersisted(
  previousHistory: readonly ChatMessage[],
  persistedHistory: readonly ChatMessage[] | undefined,
  sentMessage: ChatMessage,
): boolean | undefined {
  if (!persistedHistory) return undefined;
  if (persistedHistory.some((message) => message.id === sentMessage.id))
    return true;

  const previousIds = new Set(previousHistory.map((message) => message.id));
  return persistedHistory.some(
    (message) =>
      !previousIds.has(message.id) &&
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content === sentMessage.content,
  );
}

export function failedSendRecovery(input: {
  error: string;
  previousHistory: readonly ChatMessage[];
  persistedHistory: readonly ChatMessage[] | undefined;
  sentMessage: ChatMessage;
}): { error: string; restoreDraft: boolean } {
  return {
    error: input.error,
    restoreDraft:
      userMessagePersisted(
        input.previousHistory,
        input.persistedHistory,
        input.sentMessage,
      ) === false,
  };
}

export async function recoverFailedSend(input: {
  error: string;
  submittedText: string;
  previousHistory: readonly ChatMessage[];
  sentMessage: ChatMessage;
  isCurrentScope: () => boolean;
  refreshHistory: () => Promise<readonly ChatMessage[] | undefined>;
  setError: (error: string) => void;
  restoreDraft: (text: string) => void;
}): Promise<void> {
  if (!input.isCurrentScope()) return;

  // Show the failure immediately; the history refresh may take much longer.
  input.setError(input.error);

  let persistedHistory: readonly ChatMessage[] | undefined;
  try {
    persistedHistory = await input.refreshHistory();
  } catch {
    persistedHistory = undefined;
  }

  // An in-flight send belongs to the identity and channel that started it.
  if (!input.isCurrentScope()) return;
  const recovery = failedSendRecovery({
    error: input.error,
    previousHistory: input.previousHistory,
    persistedHistory,
    sentMessage: input.sentMessage,
  });
  if (recovery.restoreDraft) input.restoreDraft(input.submittedText);
}

export function buildOwnedRunInput(input: {
  threadId: string;
  history: readonly ChatMessage[];
  text: string;
  selectedOdooTaskId?: string | null;
  createId: () => string;
}): { payload: OwnedRunInput; userMessage: ChatMessage } {
  const text = input.text.trim();
  if (!input.threadId || !text)
    throw new Error("A Scout conversation and message are required.");
  if (
    input.selectedOdooTaskId != null &&
    !validOdooTaskId(input.selectedOdooTaskId)
  )
    throw new Error("Choose a valid Odoo project task ID.");
  const userMessage: ChatMessage = {
    id: input.createId(),
    role: "user",
    content: text,
  };
  return {
    userMessage,
    payload: {
      threadId: input.threadId,
      runId: input.createId(),
      messages: [...input.history, userMessage],
      state: {},
      tools: [],
      context:
        input.selectedOdooTaskId == null
          ? []
          : [
              {
                description: "scout.project_task_id",
                value: input.selectedOdooTaskId,
              },
            ],
      forwardedProps: {},
    },
  };
}

function sessionHeaders(
  cookie: string | null,
  accept: string,
  expectedUserId: string,
) {
  if (!expectedUserId)
    throw new Error("A signed-in Scout identity is required.");
  return {
    Accept: accept,
    "X-Scout-Expected-User": expectedUserId,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      if ("error" in body && typeof body.error === "string")
        return new Error(body.error);
      if ("code" in body && typeof body.code === "string")
        return new Error(body.code);
    }
  } catch {
    // Some reverse proxies return a plain-text error. Do not echo it into the app.
  }
  return new Error(`Scout request failed (${response.status}).`);
}

export async function readOwnedHistory(input: {
  serverUrl: string;
  cookie: string | null;
  expectedUserId: string;
  threadId: string;
  agentId: string;
  fetcher?: Fetcher;
}): Promise<ChatMessage[]> {
  const fetcher = input.fetcher ?? fetch;
  const path = `/api/copilotkit/threads/${encodeURIComponent(input.threadId)}/messages?agentId=${encodeURIComponent(input.agentId)}`;
  const response = await fetcher(`${input.serverUrl}${path}`, {
    method: "GET",
    credentials: "omit",
    headers: sessionHeaders(
      input.cookie,
      "application/json",
      input.expectedUserId,
    ),
  });
  if (!response.ok) throw await responseError(response);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("messages" in body) ||
    !Array.isArray(body.messages) ||
    body.messages.some(
      (message) =>
        !message ||
        typeof message !== "object" ||
        typeof message.id !== "string" ||
        typeof message.role !== "string",
    )
  )
    throw new Error("Scout returned an unreadable conversation history.");
  return body.messages as ChatMessage[];
}

function eventFromBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  const value: unknown = JSON.parse(data);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function consumeOwnedEventStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: {
    onTextDelta?: (delta: string) => void;
    onAssistantStart?: (messageId: string) => void;
  } = {},
): Promise<{ assistantText: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let assistantText = "";
  let finished = false;
  let activeMessageId: string | undefined;

  const handleBlock = (block: string) => {
    let event: Record<string, unknown> | null;
    try {
      event = eventFromBlock(block);
    } catch {
      throw new Error("Scout returned an invalid event stream.");
    }
    if (!event) return;
    if (event.type === "RUN_ERROR") {
      throw new Error(
        typeof event.message === "string"
          ? event.message
          : typeof event.code === "string"
            ? event.code
            : "Scout could not complete this turn.",
      );
    }
    if (event.type === "TEXT_MESSAGE_START") {
      activeMessageId =
        typeof event.messageId === "string" ? event.messageId : undefined;
      if (activeMessageId) callbacks.onAssistantStart?.(activeMessageId);
      return;
    }
    if (event.type === "TEXT_MESSAGE_CONTENT") {
      const delta = event.delta;
      if (typeof delta === "string") {
        assistantText += delta;
        callbacks.onTextDelta?.(delta);
      }
      return;
    }
    if (event.type === "TEXT_MESSAGE_END") {
      activeMessageId = undefined;
      return;
    }
    if (event.type === "RUN_FINISHED") finished = true;
  };

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      while (true) {
        const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
        if (!boundary) break;
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        handleBlock(block);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) handleBlock(pending);
    if (!finished)
      throw new Error("Scout's response ended before the turn finished.");
    return { assistantText };
  } finally {
    reader.releaseLock();
  }
}

export async function runOwnedAgent(input: {
  serverUrl: string;
  cookie: string | null;
  expectedUserId: string;
  agentId: string;
  payload: OwnedRunInput;
  fetcher: Fetcher;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onAssistantStart?: (messageId: string) => void;
}): Promise<{ assistantText: string }> {
  const response = await input.fetcher(
    `${input.serverUrl}/api/copilotkit/agent/${encodeURIComponent(input.agentId)}/run`,
    {
      method: "POST",
      credentials: "omit",
      headers: {
        ...sessionHeaders(
          input.cookie,
          "text/event-stream",
          input.expectedUserId,
        ),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: input.signal,
    },
  );
  if (!response.ok) throw await responseError(response);
  if (!response.body)
    throw new Error("This device cannot read Scout's live response stream.");
  return consumeOwnedEventStream(response.body, {
    ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
    ...(input.onAssistantStart
      ? { onAssistantStart: input.onAssistantStart }
      : {}),
  });
}
