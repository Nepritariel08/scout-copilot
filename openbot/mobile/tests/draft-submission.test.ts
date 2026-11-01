import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ChatMessage } from "../src/api.ts";
import {
  type DraftSubmission,
  draftForSavedMessage,
  inspectDraftSubmission,
  type SubmissionContext,
  submitReviewedDraft,
} from "../src/draft-submission.ts";
import { scopedFetch } from "../src/request-scope.ts";
import type { AuthenticatedApi, DraftReceipt } from "../src/scout-work.ts";

const message: ChatMessage = {
  id: "8c81166b-c27d-4b14-bff5-67274cbb676c",
  role: "user",
  content: "Synthetic draft request\nUse only this synthetic fixture.",
};
const scope = { userId: "alice", channelId: "channel-a", agentId: "scout-a" };
const payload = draftForSavedMessage(message, scope.channelId)!;
const digest = async (value: string) =>
  createHash("sha256").update(value).digest("hex");
const receipt: DraftReceipt = {
  id: "d6d89cc5-1c51-4842-8227-ec29158f62f7",
  channelId: scope.channelId,
  sourceId: message.id,
  title: payload.title,
  state: "queued",
  workItemId: 7,
  revision: 1,
  result: null,
  draftDigest: null,
  accepted: false,
  errorCode: null,
  updatedAt: "2026-11-02T00:00:00Z",
};

function harness() {
  const saved = new Map<string, string>();
  const calls: { path: string; input?: { method?: string; body?: unknown } }[] =
    [];
  const state = {
    current: true,
    messages: [message] as ChatMessage[],
    capability: true as unknown,
    tasks: [] as DraftReceipt[],
    posts: 0,
  };
  const context: SubmissionContext = {
    scope,
    serverUrl: "https://scout.example",
    isCurrent: () => state.current,
    persistedMessages: () => state.messages,
    digest,
    storage: {
      getItemAsync: async (key) => saved.get(key) ?? null,
      setItemAsync: async (key, value) => {
        saved.set(key, value);
      },
    },
    client: async <T>(
      path: string,
      input?: { method?: string; body?: unknown },
    ) => {
      calls.push({ path, input });
      if (path === "/api/capabilities")
        return { delegatedDrafts: state.capability } as T;
      if (!input?.method && path.startsWith("/api/scout/tasks?"))
        return { tasks: state.tasks } as T;
      assert.equal(path, "/api/scout/tasks");
      assert.equal(input?.method, "POST");
      assert.equal(
        saved.size,
        1,
        "local attempt must be durable before dispatch",
      );
      assert.deepEqual(input.body, payload);
      state.posts += 1;
      return { task: receipt } as T;
    },
  };
  return { context, state, saved, calls };
}

test("delegation derives one exact bounded payload from a canonical user message", () => {
  assert.deepEqual(payload, {
    sourceId: message.id,
    channelId: scope.channelId,
    title: "Synthetic draft request",
    instructions: message.content,
  });
  for (const invalid of [
    { ...message, role: "assistant" },
    { ...message, role: "tool" },
    { ...message, id: "not-a-uuid" },
    { ...message, content: { text: "Synthetic" } },
    { ...message, content: " " },
    { ...message, content: "a".repeat(8001) },
  ])
    assert.equal(draftForSavedMessage(invalid, scope.channelId), undefined);
  assert.equal(
    draftForSavedMessage(
      { ...message, content: "a".repeat(8000) },
      scope.channelId,
    )?.title.length,
    200,
  );
});

test("an optimistic/removed message or changed reviewed text cannot start submission", async () => {
  for (const messages of [
    [],
    [{ ...message, content: "Changed saved text" }],
  ]) {
    const { context, state, calls, saved } = harness();
    state.messages = messages;
    await assert.rejects(
      submitReviewedDraft(context, payload, "submit"),
      /saved message changed or is unavailable/,
    );
    assert.equal(calls.length, 0);
    assert.equal(saved.size, 0);
  }
  const { context, calls } = harness();
  await assert.rejects(
    submitReviewedDraft(
      context,
      { ...payload, instructions: "Injected instructions" },
      "submit",
    ),
    /saved message changed/,
  );
  assert.equal(calls.length, 0);
});

test("only an explicit true capability permits queue reads or an attempted submission", async () => {
  for (const capability of [false, undefined, "true", 1]) {
    const { context, state, calls, saved } = harness();
    state.capability = capability;
    await assert.rejects(
      submitReviewedDraft(context, payload, "submit"),
      /not available/,
    );
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/api/capabilities"],
    );
    assert.equal(saved.size, 0);
    assert.equal(state.posts, 0);
  }
});

test("the attempt marker is read back before POST and contains no prompt or authority claim", async () => {
  const { context, state, saved, calls } = harness();
  const result = await submitReviewedDraft(context, payload, "submit");
  assert.deepEqual(result, { kind: "submitted", task: receipt });
  assert.equal(state.posts, 1);
  const [[key, value]] = [...saved];
  assert.match(key, /^scout\.draft\.v1\.[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(value), {
    version: 1,
    sourceId: message.id,
    payloadDigest: await digest(JSON.stringify(payload)),
  });
  assert.equal(value.includes(payload.instructions), false);
  assert.deepEqual(calls.at(-1)?.input, { method: "POST", body: payload });
  assert.deepEqual(
    Object.keys(calls.at(-1)?.input?.body as DraftSubmission).sort(),
    ["channelId", "instructions", "sourceId", "title"],
  );
});

test("storage failures and unconfirmed write readback prevent any POST", async () => {
  for (const failure of ["read", "write", "readback"] as const) {
    const { context, state, saved } = harness();
    let reads = 0;
    context.storage = {
      getItemAsync: async (key) => {
        reads += 1;
        if (failure === "read") throw new Error("storage unavailable");
        return failure === "readback" && reads > 1
          ? null
          : (saved.get(key) ?? null);
      },
      setItemAsync: async (key, value) => {
        if (failure === "write") throw new Error("storage unavailable");
        saved.set(key, value);
      },
    };
    await assert.rejects(
      submitReviewedDraft(context, payload, "submit"),
      /storage unavailable|Could not confirm/,
    );
    assert.equal(state.posts, 0);
  }
});

test("lost reply/remount is read-only until explicit recovery reuses the same source and payload", async () => {
  const { context, state, saved, calls } = harness();
  const original = context.client;
  let lostReply = true;
  const intents = new Map<string, string>();
  context.client = async <T>(
    path: string,
    input?: { method?: string; body?: unknown },
  ) => {
    const response = await original<T>(path, input);
    if (input?.method === "POST") {
      const body = input.body as DraftSubmission;
      const previous = intents.get(body.sourceId);
      if (previous) assert.equal(JSON.stringify(body), previous);
      else intents.set(body.sourceId, JSON.stringify(body));
      if (lostReply) {
        lostReply = false;
        throw new Error("Synthetic lost reply");
      }
    }
    return response;
  };
  await assert.rejects(
    submitReviewedDraft(context, payload, "submit"),
    /lost reply/,
  );
  assert.equal(saved.size, 1);
  const remounted: SubmissionContext = { ...context };
  const status = await inspectDraftSubmission(remounted, payload);
  assert.equal(status.attempted, true);
  assert.equal(
    status.task,
    undefined,
    "missing from capped list is not proof absent",
  );
  assert.equal(state.posts, 1, "opening/checking must not resubmit");
  await assert.rejects(
    submitReviewedDraft(remounted, payload, "submit"),
    /already has a saved request/,
  );
  assert.equal(state.posts, 1);
  assert.equal(
    (await submitReviewedDraft(remounted, payload, "recover")).task.sourceId,
    message.id,
  );
  assert.equal(state.posts, 2);
  assert.equal(intents.size, 1);
  assert.deepEqual(
    calls
      .filter((call) => call.input?.method === "POST")
      .map((call) => call.input?.body),
    [payload, payload],
  );
});

test("unknown server intent without a local marker recovers only through exact-payload POST", async () => {
  const { context, state, calls } = harness();
  state.tasks = [{ ...receipt, state: "submission_unknown", workItemId: null }];
  await assert.rejects(
    submitReviewedDraft(context, payload, "submit"),
    /already has a saved request/,
  );
  assert.equal(state.posts, 0);
  await submitReviewedDraft(context, payload, "recover");
  assert.equal(state.posts, 1);
  assert.deepEqual(
    calls.filter((call) => call.input?.method === "POST"),
    [{ path: "/api/scout/tasks", input: { method: "POST", body: payload } }],
  );
});

test("recovery does not trust sourceId alone when the server's full intent differs", async () => {
  const { context, state, saved } = harness();
  state.tasks = [{ ...receipt, state: "submission_unknown", workItemId: null }];
  const original = context.client;
  context.client = async <T>(
    path: string,
    input?: { method?: string; body?: unknown },
  ) => {
    const response = await original<T>(path, input);
    if (input?.method === "POST")
      throw new Error("SCOUT_CONFLICT: stored instructions differ");
    return response;
  };
  await assert.rejects(
    submitReviewedDraft(context, payload, "recover"),
    /SCOUT_CONFLICT/,
  );
  assert.equal(state.posts, 1);
  assert.equal(
    saved.size,
    1,
    "retain marker after conflict; never mint another origin",
  );
  await inspectDraftSubmission(context, payload);
  assert.equal(state.posts, 1);
});

test("confirmed receipts are read without another POST or automatic acceptance", async () => {
  const { context, state, saved } = harness();
  state.tasks = [receipt];
  assert.deepEqual(await submitReviewedDraft(context, payload, "submit"), {
    kind: "existing",
    task: receipt,
  });
  assert.equal(state.posts, 0);
  assert.equal(saved.size, 0);
});

test("a changed message payload or corrupted marker cannot reuse an attempted source", async () => {
  const { context, state, saved } = harness();
  await submitReviewedDraft(context, payload, "submit");
  state.messages = [{ ...message, content: "Changed canonical request" }];
  const changed = draftForSavedMessage(state.messages[0], scope.channelId)!;
  await assert.rejects(
    submitReviewedDraft(context, changed, "recover"),
    /saved request differs/,
  );
  assert.equal(state.posts, 1);
  state.messages = [message];
  saved.set([...saved.keys()][0], "corrupt-marker");
  await assert.rejects(
    submitReviewedDraft(context, payload, "recover"),
    /saved request differs/,
  );
  assert.equal(state.posts, 1);
});

test("scope changes during storage read/write/digest never dispatch or touch the new scope's marker", async () => {
  for (const boundary of ["read", "write", "digest"] as const) {
    for (const nextScope of [
      { ...scope, userId: "bob" },
      { ...scope, channelId: "channel-b" },
      { ...scope, agentId: "scout-b" },
    ]) {
      const { context, state, saved } = harness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalStorage = context.storage;
      let held = false;
      async function hold() {
        if (held) return;
        held = true;
        entered.resolve();
        await release.promise;
      }
      context.storage = {
        getItemAsync: async (key) => {
          if (boundary === "read") await hold();
          return originalStorage.getItemAsync(key);
        },
        setItemAsync: async (key, value) => {
          if (boundary === "write") await hold();
          await originalStorage.setItemAsync(key, value);
        },
      };
      context.digest = async (value) => {
        if (boundary === "digest") await hold();
        return digest(value);
      };
      const running = submitReviewedDraft(context, payload, "submit");
      await entered.promise;
      state.current = false;
      release.resolve();
      await assert.rejects(
        running,
        /account, conversation or assistant changed/,
      );
      assert.equal(state.posts, 0);
      const next: SubmissionContext = {
        ...context,
        scope: nextScope,
        isCurrent: () => true,
        storage: originalStorage,
        digest,
      };
      const nextPayload = draftForSavedMessage(message, nextScope.channelId)!;
      const inspected = await inspectDraftSubmission(next, nextPayload);
      assert.equal(inspected.attempted, false);
      assert.ok(saved.size <= 1, "only a completed old-scope write can remain");
    }
  }
});

test("capability is rechecked after delayed durable storage before submission", async () => {
  const { context, state, saved } = harness();
  context.storage.setItemAsync = async (key, value) => {
    saved.set(key, value);
    state.capability = false;
  };
  await assert.rejects(
    submitReviewedDraft(context, payload, "submit"),
    /not available/,
  );
  assert.equal(state.posts, 0);
  assert.equal(saved.size, 1);
});

test("delayed cookie lookup on submission cannot send another account/channel/agent credential", async () => {
  for (const changed of ["account", "channel", "agent"] as const) {
    const { context, state, saved } = harness();
    const entered = Promise.withResolvers<void>();
    const cookie = Promise.withResolvers<string>();
    let reads = 0;
    let posts = 0;
    const fetcher = scopedFetch(
      () => {
        reads += 1;
        if (reads === 4) {
          entered.resolve();
          return cookie.promise;
        }
        return "synthetic-old-cookie";
      },
      { userId: scope.userId, isCurrent: context.isCurrent },
      async (url, input) => {
        const headers = new Headers(input?.headers);
        assert.equal(headers.get("X-Scout-Expected-User"), scope.userId);
        assert.equal(headers.get("Cookie"), "synthetic-old-cookie");
        if (input?.method === "POST") {
          posts += 1;
          return Response.json({ task: receipt });
        }
        return Response.json(
          String(url).endsWith("/api/capabilities")
            ? { delegatedDrafts: true }
            : { tasks: [] },
        );
      },
    );
    context.client = (async <T>(
      path: string,
      input?: { method?: string; body?: unknown },
    ) => {
      const response = await fetcher(`${context.serverUrl}${path}`, {
        method: input?.method,
        ...(input?.body ? { body: JSON.stringify(input.body) } : {}),
      });
      return (await response.json()) as T;
    }) as AuthenticatedApi;
    const running = submitReviewedDraft(context, payload, "submit");
    await entered.promise;
    state.current = false;
    cookie.resolve(`synthetic-${changed}-cookie`);
    await assert.rejects(running, /account or conversation changed/);
    assert.equal(posts, 0);
    assert.equal(saved.size, 1);
  }
});

test("a delayed response after navigation stays unknown locally without automatic retry", async () => {
  const { context, state, saved } = harness();
  const original = context.client;
  const pending = Promise.withResolvers<{ task: DraftReceipt }>();
  const dispatched = Promise.withResolvers<void>();
  context.client = async <T>(
    path: string,
    input?: { method?: string; body?: unknown },
  ) => {
    const response = await original<T>(path, input);
    if (input?.method === "POST") {
      dispatched.resolve();
      return (await pending.promise) as T;
    }
    return response;
  };
  const running = submitReviewedDraft(context, payload, "submit");
  await dispatched.promise;
  state.current = false;
  pending.resolve({ task: receipt });
  await assert.rejects(running, /account, conversation or assistant changed/);
  assert.equal(state.posts, 1);
  assert.equal(saved.size, 1);
});
