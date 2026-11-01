import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../src/api.ts";
import {
  buildOwnedRunInput,
  clearForIdentityChange,
  dataForSignedInUser,
  type Fetcher,
  failedSendRecovery,
  readOwnedHistory,
  runOwnedAgent,
} from "../src/owned-chat.ts";

function eventStream(value: string, chunkSizes: number[] = [7, 13, 5]) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let chunkIndex = 0;
      while (offset < bytes.length) {
        const size = chunkSizes[chunkIndex % chunkSizes.length];
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        chunkIndex += 1;
      }
      controller.close();
    },
  });
}

test("cached private data is cleared and hidden when the signed-in identity changes", () => {
  const cached = { userId: "owner-a", value: { channelName: "A's thread" } };
  assert.equal(clearForIdentityChange(cached, "owner-b"), undefined);
  assert.equal(clearForIdentityChange(cached, undefined), undefined);
  assert.equal(clearForIdentityChange(cached, "owner-a"), cached);
  assert.equal(dataForSignedInUser(cached, "owner-b"), undefined);
  assert.equal(dataForSignedInUser(cached, undefined), undefined);
  assert.deepEqual(dataForSignedInUser(cached, "owner-a"), {
    channelName: "A's thread",
  });
});

test("failed-send recovery keeps the error and restores a draft only when absent", () => {
  const previous: ChatMessage[] = [
    { id: "old-user", role: "user", content: "Please retry." },
  ];
  const sent: ChatMessage = {
    id: "new-user",
    role: "user",
    content: "Please retry.",
  };

  const unknown = failedSendRecovery({
    error: "Model unavailable",
    previousHistory: previous,
    persistedHistory: undefined,
    sentMessage: sent,
  });
  assert.deepEqual(unknown, {
    error: "Model unavailable",
    restoreDraft: false,
  });

  const absent = failedSendRecovery({
    error: "Access denied",
    previousHistory: previous,
    persistedHistory: previous,
    sentMessage: sent,
  });
  assert.deepEqual(absent, { error: "Access denied", restoreDraft: true });

  const persisted = failedSendRecovery({
    error: "Model unavailable",
    previousHistory: previous,
    persistedHistory: [...previous, sent],
    sentMessage: sent,
  });
  assert.deepEqual(persisted, {
    error: "Model unavailable",
    restoreDraft: false,
  });

  const serverAssignedId = failedSendRecovery({
    error: "Model unavailable",
    previousHistory: previous,
    persistedHistory: [
      ...previous,
      { id: "server-user", role: "user", content: sent.content },
    ],
    sentMessage: sent,
  });
  assert.deepEqual(serverAssignedId, {
    error: "Model unavailable",
    restoreDraft: false,
  });
});

test("owned run payload appends one user message to the unchanged server history", () => {
  const history: ChatMessage[] = [
    { id: "prior-user", role: "user", content: "Earlier" },
    { id: "prior-assistant", role: "assistant", content: "Earlier answer" },
  ];
  const ids = ["new-user", "new-run"];
  const result = buildOwnedRunInput({
    threadId: "thread-1",
    history,
    text: "  Please summarize.  ",
    createId: () => ids.shift() ?? "unexpected",
  });

  assert.deepEqual(result.userMessage, {
    id: "new-user",
    role: "user",
    content: "Please summarize.",
  });
  assert.deepEqual(result.payload, {
    threadId: "thread-1",
    runId: "new-run",
    messages: [...history, result.userMessage],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  });
  assert.equal(history.length, 2);
});

test("owned run sends the cookie and canonical AG-UI request, streams text, and finishes", async () => {
  const prior: ChatMessage[] = [
    { id: "prior-user", role: "user", content: "Hi" },
    { id: "prior-answer", role: "assistant", content: "Hello" },
  ];
  const run = buildOwnedRunInput({
    threadId: "thread-1",
    history: prior,
    text: "Summarize this.",
    createId: (() => {
      const ids = ["message-2", "run-2"];
      return () => ids.shift() ?? "unexpected";
    })(),
  });
  const stream = [
    'data: {"type":"TEXT_MESSAGE_START","messageId":"answer-2"}\r\n\r\n',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer-2","delta":"A good "}\r\n\r\n',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer-2","delta":"summary: ☃️"}\r\n\r\n',
    'data: {"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-2"}\r\n\r\n',
  ].join("");
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetcher: Fetcher = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(eventStream(stream), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const deltas: string[] = [];

  const result = await runOwnedAgent({
    serverUrl: "https://scout.example",
    cookie: "better-auth.session_token=secret-cookie",
    agentId: "scout assistant",
    payload: run.payload,
    fetcher,
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.equal(
    capturedUrl,
    "https://scout.example/api/copilotkit/agent/scout%20assistant/run",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.credentials, "omit");
  assert.deepEqual(capturedInit?.headers, {
    Accept: "text/event-stream",
    Cookie: "better-auth.session_token=secret-cookie",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), run.payload);
  assert.equal(result.assistantText, "A good summary: ☃️");
  assert.deepEqual(deltas, ["A good ", "summary: ☃️"]);
});

test("owned history fetch reads the authenticated persisted thread snapshot", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const messages: ChatMessage[] = [
    { id: "user-1", role: "user", content: "Stored" },
    { id: "assistant-1", role: "assistant", content: "Persisted" },
  ];
  const fetcher: Fetcher = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({ messages, state: {} });
  };

  const result = await readOwnedHistory({
    serverUrl: "https://scout.example",
    cookie: "session=private",
    threadId: "thread /1",
    agentId: "scout/agent",
    fetcher,
  });

  assert.equal(
    capturedUrl,
    "https://scout.example/api/copilotkit/threads/thread%20%2F1/messages?agentId=scout%2Fagent",
  );
  assert.equal(capturedInit?.method, "GET");
  assert.equal(capturedInit?.credentials, "omit");
  assert.deepEqual(capturedInit?.headers, {
    Accept: "application/json",
    Cookie: "session=private",
  });
  assert.deepEqual(result, messages);
});

test("owned history reports server authorization errors and refuses unreadable snapshots", async () => {
  const denied: Fetcher = async () =>
    Response.json({ code: "HISTORY_ACCESS_DENIED" }, { status: 403 });
  await assert.rejects(
    readOwnedHistory({
      serverUrl: "https://scout.example",
      cookie: null,
      threadId: "thread-1",
      agentId: "scout",
      fetcher: denied,
    }),
    /HISTORY_ACCESS_DENIED/,
  );

  const malformed: Fetcher = async () =>
    Response.json({ messages: [{ id: 2, role: "assistant" }] });
  await assert.rejects(
    readOwnedHistory({
      serverUrl: "https://scout.example",
      cookie: null,
      threadId: "thread-1",
      agentId: "scout",
      fetcher: malformed,
    }),
    /unreadable conversation history/,
  );
});

test("owned run rejects an error event and a stream without a terminal event", async () => {
  const request = buildOwnedRunInput({
    threadId: "thread-1",
    history: [],
    text: "Test",
    createId: (() => {
      const ids = ["message-1", "run-1"];
      return () => ids.shift() ?? "unexpected";
    })(),
  });
  const makeFetcher =
    (data: string): Fetcher =>
    async () =>
      new Response(eventStream(data));
  const base = {
    serverUrl: "https://scout.example",
    cookie: null,
    agentId: "scout",
    payload: request.payload,
  };

  await assert.rejects(
    runOwnedAgent({
      ...base,
      fetcher: makeFetcher(
        'data: {"type":"RUN_ERROR","message":"Model unavailable"}\n\n',
      ),
    }),
    /Model unavailable/,
  );
  await assert.rejects(
    runOwnedAgent({
      ...base,
      fetcher: makeFetcher(
        'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"partial"}\n\n',
      ),
    }),
    /ended before the turn finished/,
  );
});
