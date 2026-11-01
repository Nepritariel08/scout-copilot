import type { ChatMessage } from "./api";
import {
  type AuthenticatedApi,
  type DraftReceipt,
  readDrafts,
  type WorkScope,
} from "./scout-work.ts";

export type DraftSubmission = {
  sourceId: string;
  channelId: string;
  title: string;
  instructions: string;
};

export type IntentStorage = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

export type SubmissionContext = {
  scope: WorkScope;
  serverUrl: string;
  isCurrent(): boolean;
  /** Only the last successfully read server history, never optimistic chat state. */
  persistedMessages(): readonly ChatMessage[];
  client: AuthenticatedApi;
  storage: IntentStorage;
  digest(value: string): Promise<string>;
};

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** One canonical user message is one stable queue source; editing needs a new saved message. */
export function draftForSavedMessage(
  message: ChatMessage,
  channelId: string,
): DraftSubmission | undefined {
  if (
    message.role !== "user" ||
    !uuid.test(message.id) ||
    typeof message.content !== "string"
  )
    return undefined;
  const instructions = message.content.trim();
  if (
    !instructions ||
    instructions.length > 8000 ||
    !channelId ||
    channelId.length > 200
  )
    return undefined;
  return {
    sourceId: message.id,
    channelId,
    title: instructions.split(/\r?\n/, 1)[0].trim().slice(0, 200),
    instructions,
  };
}

function assertReviewed(context: SubmissionContext, reviewed: DraftSubmission) {
  if (
    !context.isCurrent() ||
    !context.scope.userId ||
    !context.scope.agentId ||
    context.scope.channelId !== reviewed.channelId
  )
    throw new Error(
      "Your Scout account, conversation or assistant changed. Review the current message again.",
    );
  const message = context
    .persistedMessages()
    .find((entry) => entry.id === reviewed.sourceId);
  const current =
    message && draftForSavedMessage(message, context.scope.channelId);
  if (!current || JSON.stringify(current) !== JSON.stringify(reviewed))
    throw new Error(
      "This saved message changed or is unavailable. Refresh the conversation and review it again.",
    );
}

async function localIntent(
  context: SubmissionContext,
  reviewed: DraftSubmission,
) {
  assertReviewed(context, reviewed);
  const keyDigest = await context.digest(
    JSON.stringify([
      context.serverUrl,
      context.scope.userId,
      context.scope.channelId,
      context.scope.agentId,
      reviewed.sourceId,
    ]),
  );
  assertReviewed(context, reviewed);
  const payloadDigest = await context.digest(JSON.stringify(reviewed));
  assertReviewed(context, reviewed);
  if (
    !/^[a-f0-9]{64}$/.test(keyDigest) ||
    !/^[a-f0-9]{64}$/.test(payloadDigest)
  )
    throw new Error("Could not fingerprint this draft request.");
  const key = `scout.draft.v1.${keyDigest}`;
  const value = JSON.stringify({
    version: 1,
    sourceId: reviewed.sourceId,
    payloadDigest,
  });
  const stored = await context.storage.getItemAsync(key);
  assertReviewed(context, reviewed);
  if (stored !== null && stored !== value)
    throw new Error(
      "The saved request differs from this message. Use its original receipt or contact the administrator.",
    );
  return { key, value, attempted: stored !== null };
}

/** Read-only on open/remount. A missing list entry is not proof that submission never happened. */
export async function inspectDraftSubmission(
  context: SubmissionContext,
  reviewed: DraftSubmission,
) {
  assertReviewed(context, reviewed);
  const page = await readDrafts(context.client, reviewed.channelId);
  assertReviewed(context, reviewed);
  if (!page.available)
    return { available: false as const, attempted: false, task: undefined };
  const local = await localIntent(context, reviewed);
  const matches = page.tasks.filter(
    (task) => task.sourceId === reviewed.sourceId,
  );
  if (matches.length > 1)
    throw new Error("Scout returned conflicting receipts for this message.");
  return {
    available: true as const,
    attempted: local.attempted,
    task: matches[0],
    local,
  };
}

/** Human action only. Reuse the exact source/payload; prepare() verifies equality before recovery. */
export async function submitReviewedDraft(
  context: SubmissionContext,
  reviewed: DraftSubmission,
  mode: "submit" | "recover",
): Promise<{ kind: "existing" | "submitted"; task: DraftReceipt }> {
  const status = await inspectDraftSubmission(context, reviewed);
  if (!status.available)
    throw new Error("Draft delegation is not available in this workspace.");
  if (status.task && status.task.state !== "submission_unknown")
    return { kind: "existing", task: status.task };
  if (mode === "submit" && (status.attempted || status.task))
    throw new Error(
      "This message already has a saved request. Check its status and explicitly recover the same request.",
    );
  if (mode === "recover" && !status.attempted && !status.task)
    throw new Error(
      "No saved request was found. Review the message before delegating it.",
    );

  if (!status.attempted) {
    assertReviewed(context, reviewed);
    await context.storage.setItemAsync(status.local.key, status.local.value);
    assertReviewed(context, reviewed);
    const readback = await context.storage.getItemAsync(status.local.key);
    assertReviewed(context, reviewed);
    if (readback !== status.local.value)
      throw new Error(
        "Could not confirm the saved request. No submission was sent.",
      );
  }
  const capability = await context.client<{ delegatedDrafts?: boolean }>(
    "/api/capabilities",
  );
  assertReviewed(context, reviewed);
  if (capability.delegatedDrafts !== true)
    throw new Error("Draft delegation is not available in this workspace.");
  // POSTing the original payload is intentional: a public list receipt omits instructions.
  // A sourceId match alone cannot safely justify recovering a different stored payload by ID.
  const response = await context.client<{ task: DraftReceipt }>(
    "/api/scout/tasks",
    {
      method: "POST",
      body: reviewed,
    },
  );
  assertReviewed(context, reviewed);
  if (
    !response.task?.id ||
    response.task.channelId !== reviewed.channelId ||
    response.task.sourceId !== reviewed.sourceId ||
    response.task.title !== reviewed.title
  )
    throw new Error(
      "Submission was not confirmed for this saved message. Check its existing request before recovering.",
    );
  return { kind: "submitted", task: response.task };
}
