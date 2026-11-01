import type { ChatMessage } from "./api";

export type OwnedRunInput = {
  threadId: string;
  runId: string;
  messages: ChatMessage[];
  state: Record<string, never>;
  tools: [];
  context: [];
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

export function buildOwnedRunInput(input: {
  threadId: string;
  history: readonly ChatMessage[];
  text: string;
  createId: () => string;
}): { payload: OwnedRunInput; userMessage: ChatMessage } {
  const text = input.text.trim();
  if (!input.threadId || !text)
    throw new Error("A Scout conversation and message are required.");
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
      context: [],
      forwardedProps: {},
    },
  };
}

function sessionHeaders(cookie: string | null, accept: string) {
  return {
    Accept: accept,
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
  threadId: string;
  agentId: string;
  fetcher?: Fetcher;
}): Promise<ChatMessage[]> {
  const fetcher = input.fetcher ?? fetch;
  const path = `/api/copilotkit/threads/${encodeURIComponent(input.threadId)}/messages?agentId=${encodeURIComponent(input.agentId)}`;
  const response = await fetcher(`${input.serverUrl}${path}`, {
    method: "GET",
    credentials: "omit",
    headers: sessionHeaders(input.cookie, "application/json"),
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
        ...sessionHeaders(input.cookie, "text/event-stream"),
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
