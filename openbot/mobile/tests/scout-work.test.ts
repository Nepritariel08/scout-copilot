import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOwnedRunInput } from "../src/owned-chat.ts";
import {
  type AuthenticatedApi,
  acceptReviewedDraft,
  canAcceptDraft,
  canSelectOdooTask,
  changeOdooRelease,
  consumeOdooTaskSelection,
  type DraftReceipt,
  type OdooContextStatus,
  type OdooTaskSelection,
  readDrafts,
  readOdooContext,
  refreshDraft,
  refreshForCurrentScope,
  sameReviewedDraft,
  selectedOdooTask,
  validOdooTaskId,
  webContextSetupUrl,
} from "../src/scout-work.ts";

function clientFor(
  handler: (
    path: string,
    input?: { method?: string; body?: unknown },
  ) => unknown,
): AuthenticatedApi {
  return async <T>(path: string, input?: { method?: string; body?: unknown }) =>
    handler(path, input) as T;
}

const scope = {
  userId: "alice",
  channelId: "conversation-a",
  agentId: "scout-a",
};
const status: OdooContextStatus = {
  provider: "openrouter",
  route: {
    provider: "openrouter",
    model: "synthetic-free",
    policyFingerprint: "b".repeat(64),
    expiresAt: "2099-01-01T00:00:00Z",
  },
  record: {
    active: true,
    credentialStored: true,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00Z",
    projectCount: 2,
  },
  release: {
    active: true,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00Z",
    provider: "openrouter",
  },
};
const draft: DraftReceipt = {
  id: "draft /1",
  channelId: scope.channelId,
  sourceId: "synthetic-source",
  title: "Synthetic draft",
  state: "review_required",
  workItemId: 7,
  revision: 3,
  result: "A plain-text draft for human review.",
  draftDigest: "a".repeat(64),
  accepted: false,
  errorCode: null,
  updatedAt: "2026-11-01T00:00:00Z",
};

test("consent requires a displayed unexpired route; withdrawal remains possible without one", async () => {
  const calls: unknown[] = [];
  const client = clientFor((_path, input) => {
    calls.push(input);
  });
  assert.throws(
    () => changeOdooRelease(client, "scout-a", true),
    /review the current model route/,
  );
  assert.throws(
    () =>
      changeOdooRelease(client, "scout-a", true, {
        ...status.route,
        expiresAt: "2000-01-01T00:00:00Z",
      }),
    /review the current model route/,
  );
  assert.throws(
    () =>
      changeOdooRelease(client, "scout-a", true, {
        ...status.route,
        policyFingerprint: "invalid",
      }),
    /review the current model route/,
  );
  assert.deepEqual(calls, []);
  await changeOdooRelease(client, "scout-a", false);
  assert.deepEqual(calls, [{ method: "DELETE", body: { agentId: "scout-a" } }]);
  assert.equal(
    canSelectOdooTask({
      ...status,
      route: { ...status.route, expiresAt: "2000-01-01T00:00:00Z" },
    }),
    false,
  );
});

test("task selection belongs to one user, channel and agent and is synchronously consumed once", () => {
  const selection: OdooTaskSelection = { ...scope, taskId: "77" };
  assert.equal(selectedOdooTask(selection, scope), "77");
  for (const different of [
    { ...scope, userId: "bob" },
    { ...scope, channelId: "conversation-b" },
    { ...scope, agentId: "scout-b" },
  ])
    assert.equal(selectedOdooTask(selection, different), null);

  const pending = { current: selection as OdooTaskSelection | undefined };
  const first = consumeOdooTaskSelection(pending, scope);
  assert.equal(first, "77");
  assert.equal(pending.current, undefined);
  assert.equal(consumeOdooTaskSelection(pending, scope), null);

  const selectedRun = buildOwnedRunInput({
    threadId: "thread-a",
    history: [],
    text: "Summarize",
    selectedOdooTaskId: first,
    createId: () => "synthetic-id",
  });
  const nextRun = buildOwnedRunInput({
    threadId: "thread-a",
    history: [selectedRun.userMessage],
    text: "Another turn",
    createId: () => "next-id",
  });
  assert.deepEqual(selectedRun.payload.context, [
    { description: "scout.project_task_id", value: "77" },
  ]);
  assert.deepEqual(nextRun.payload.context, []);
  assert.deepEqual(selectedRun.payload.tools, []);
  assert.deepEqual(selectedRun.payload.forwardedProps, {});
  assert.equal("odooTaskId" in selectedRun.userMessage, false);
});

test("malformed task selectors cannot add arbitrary context or authority", () => {
  for (const value of [
    "",
    "0",
    "-1",
    " 77",
    "77.1",
    "77/1",
    "1e3",
    "1".repeat(16),
  ]) {
    assert.equal(validOdooTaskId(value), false);
    assert.throws(
      () =>
        buildOwnedRunInput({
          threadId: "thread",
          history: [],
          text: "Test",
          selectedOdooTaskId: value,
          createId: () => "id",
        }),
      /valid Odoo project task ID/,
    );
  }
  assert.equal(validOdooTaskId("999999999999999"), true);
});

test("selection UI requires both current source access and consent for the exact provider", () => {
  const now = Date.parse("2026-11-02T00:00:00Z");
  assert.equal(canSelectOdooTask(status, now), true);
  assert.equal(canSelectOdooTask(undefined, now), false);
  assert.equal(canSelectOdooTask({ ...status, record: null }, now), false);
  assert.equal(canSelectOdooTask({ ...status, release: null }, now), false);
  assert.equal(
    canSelectOdooTask(
      { ...status, record: { ...status.record!, active: false } },
      now,
    ),
    false,
  );
  assert.equal(
    canSelectOdooTask(
      { ...status, release: { ...status.release!, provider: "local" } },
      now,
    ),
    false,
  );
  assert.equal(
    canSelectOdooTask(
      {
        ...status,
        record: { ...status.record!, expiresAt: "2026-11-01T00:00:00Z" },
      },
      now,
    ),
    false,
  );
  assert.equal(
    canSelectOdooTask(
      { ...status, release: { ...status.release!, expiresAt: "invalid" } },
      now,
    ),
    false,
  );
});

test("Odoo status and explicit consent use the existing native-authenticated contracts without a key", async () => {
  const calls: unknown[] = [];
  const client = clientFor((path, input) => {
    calls.push({ path, input });
    return status;
  });
  assert.deepEqual(await readOdooContext(client, "scout /a"), status);
  await changeOdooRelease(client, "scout-a", true, status.route);
  await changeOdooRelease(client, "scout-a", false);
  assert.deepEqual(calls, [
    {
      path: "/api/scout/odoo/context-grants?agentId=scout%20%2Fa",
      input: undefined,
    },
    {
      path: "/api/scout/odoo/context-grants/release",
      input: {
        method: "POST",
        body: {
          agentId: "scout-a",
          consent: true,
          expectedProvider: "openrouter",
          expectedModel: "synthetic-free",
          expectedPolicyFingerprint: "b".repeat(64),
        },
      },
    },
    {
      path: "/api/scout/odoo/context-grants/release",
      input: { method: "DELETE", body: { agentId: "scout-a" } },
    },
  ]);
  assert.equal(
    webContextSetupUrl("https://scout.example", "channel /1"),
    "https://scout.example/channel/channel%20%2F1",
  );
  assert.throws(
    () => webContextSetupUrl("https://secret@scout.example", "channel"),
    /approved HTTPS/,
  );
  assert.throws(
    () => webContextSetupUrl("http://scout.example", "channel"),
    /approved HTTPS/,
  );
});

test("disabled draft capability makes no queue request and mixed-channel receipts stay hidden", async () => {
  const calls: string[] = [];
  const disabled = clientFor((path) => {
    calls.push(path);
    return { delegatedDrafts: false };
  });
  assert.deepEqual(await readDrafts(disabled, scope.channelId), {
    available: false,
    tasks: [],
  });
  assert.deepEqual(calls, ["/api/capabilities"]);
  const enabled = clientFor((path) => {
    calls.push(path);
    return path === "/api/capabilities"
      ? { delegatedDrafts: true }
      : {
          tasks: [draft, { ...draft, id: "other", channelId: "other-channel" }],
        };
  });
  assert.deepEqual(await readDrafts(enabled, scope.channelId), {
    available: true,
    tasks: [draft],
  });
  assert.equal(calls.at(-1), "/api/scout/tasks?channelId=conversation-a");
});

test("acceptance carries only the exact explicitly reviewed revision and digest", async () => {
  const calls: unknown[] = [];
  const completed = { ...draft, state: "completed", accepted: true };
  const client = clientFor((path, input) => {
    calls.push({ path, input });
    return { task: completed };
  });
  assert.equal(canAcceptDraft(draft), true);
  assert.deepEqual(
    await acceptReviewedDraft(client, scope.channelId, draft, { ...draft }),
    completed,
  );
  assert.deepEqual(calls, [
    {
      path: "/api/scout/tasks/draft%20%2F1",
      input: {
        method: "POST",
        body: { action: "accept", revision: 3, draftDigest: "a".repeat(64) },
      },
    },
  ]);
  calls.length = 0;
  for (const changed of [
    { ...draft, revision: 4 },
    { ...draft, draftDigest: "b".repeat(64) },
    { ...draft, result: "A changed result" },
    { ...draft, accepted: true },
    { ...draft, state: "running" as const },
    { ...draft, channelId: "other-channel" },
  ]) {
    assert.equal(sameReviewedDraft(changed, draft), false);
    assert.throws(
      () => acceptReviewedDraft(client, scope.channelId, changed, draft),
      /draft changed/,
    );
  }
  assert.deepEqual(calls, []);
  for (const invalid of [
    { ...draft, result: null },
    { ...draft, draftDigest: null },
    { ...draft, revision: null },
  ])
    assert.equal(canAcceptDraft(invalid), false);
});

test("refresh is explicit, channel-bound and never submits or accepts a task", async () => {
  const calls: unknown[] = [];
  const client = clientFor((path, input) => {
    calls.push({ path, input });
    return { task: draft };
  });
  assert.deepEqual(await refreshDraft(client, scope.channelId, draft), draft);
  assert.deepEqual(calls, [
    {
      path: "/api/scout/tasks/draft%20%2F1",
      input: { method: "POST", body: { action: "refresh" } },
    },
  ]);
  await assert.rejects(
    refreshDraft(client, "another-channel", draft),
    /different conversation/,
  );
  assert.equal(calls.length, 1);
  const wrongReceipt = clientFor(() => ({
    task: { ...draft, channelId: "other-channel" },
  }));
  await assert.rejects(
    refreshDraft(wrongReceipt, scope.channelId, draft),
    /different draft receipt/,
  );
});

test("an acceptance response must confirm the reviewed result, not just an HTTP success", async () => {
  for (const receipt of [
    draft,
    { ...draft, state: "completed", accepted: false },
    { ...draft, state: "completed", accepted: true, result: "Another result" },
    {
      ...draft,
      state: "completed",
      accepted: true,
      draftDigest: "b".repeat(64),
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      acceptReviewedDraft(
        clientFor(() => {
          calls += 1;
          return { task: receipt };
        }),
        scope.channelId,
        draft,
        { ...draft },
      ),
      /acceptance was not confirmed/,
    );
    assert.equal(
      calls,
      1,
      "an ambiguous acceptance must never retry automatically",
    );
  }
});

test("delayed refresh cannot replace a new account/channel view or clear its selected task", async () => {
  for (const nextScope of [
    { ...scope, userId: "bob" },
    { ...scope, channelId: "conversation-b" },
  ]) {
    const pending = Promise.withResolvers<{ agentId: string }>();
    let active = scope;
    let selection: OdooTaskSelection | undefined = { ...scope, taskId: "77" };
    const effects: string[] = [];
    const running = refreshForCurrentScope({
      isCurrent: () => active === scope,
      read: () => pending.promise,
      apply: () => {
        effects.push("replace-view");
        selection = undefined;
      },
      failed: () => effects.push("replace-error"),
      finished: () => effects.push("clear-loading"),
    });
    active = nextScope;
    selection = { ...nextScope, taskId: "88" };
    pending.resolve({ agentId: "old-agent" });
    assert.equal(await running, undefined);
    assert.deepEqual(effects, []);
    assert.equal(selectedOdooTask(selection, nextScope), "88");
  }
});

test("only the latest refresh may apply results, errors or loading completion", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const pending = Promise.withResolvers<string>();
    let generation = 1;
    const effects: string[] = [];
    const older = refreshForCurrentScope({
      isCurrent: () => generation === 1,
      read: () => pending.promise,
      apply: (value) => effects.push(value),
      failed: () => effects.push("old-error"),
      finished: () => effects.push("old-finished"),
    });
    generation = 2;
    assert.equal(
      await refreshForCurrentScope({
        isCurrent: () => generation === 2,
        read: async () => "current-view",
        apply: (value) => effects.push(value),
        failed: () => effects.push("current-error"),
        finished: () => effects.push("current-finished"),
      }),
      "current-view",
    );
    if (outcome === "success") pending.resolve("old-view");
    else pending.reject(new Error("old-failure"));
    assert.equal(await older, undefined);
    assert.deepEqual(effects, ["current-view", "current-finished"]);
  }
});

test("refresh after unmount is discarded and current failures are reported", async () => {
  let reads = 0;
  assert.equal(
    await refreshForCurrentScope({
      isCurrent: () => false,
      read: async () => {
        reads += 1;
        return "ignored";
      },
      apply: () => assert.fail("must not apply"),
      failed: () => assert.fail("must not fail"),
      finished: () => assert.fail("must not finish"),
    }),
    undefined,
  );
  assert.equal(reads, 0);
  const pending = Promise.withResolvers<string>();
  let mounted = true;
  const unmounted = refreshForCurrentScope({
    isCurrent: () => mounted,
    read: () => pending.promise,
    apply: () => assert.fail("must not apply after unmount"),
    failed: () => assert.fail("must not fail after unmount"),
    finished: () => assert.fail("must not finish after unmount"),
  });
  mounted = false;
  pending.resolve("late-view");
  assert.equal(await unmounted, undefined);
  const failure = new Error("current failure");
  const effects: unknown[] = [];
  assert.equal(
    await refreshForCurrentScope({
      isCurrent: () => true,
      read: async () => {
        throw failure;
      },
      apply: () => assert.fail("must not apply failed read"),
      failed: (error) => effects.push(error),
      finished: () => effects.push("finished"),
    }),
    undefined,
  );
  assert.deepEqual(effects, [failure, "finished"]);
});
