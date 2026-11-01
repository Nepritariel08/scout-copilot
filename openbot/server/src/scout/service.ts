import type { ScoutTaskView } from "@openbot/shared/scout";
import { z } from "zod";
import type { AuthenticatedActor } from "../auth/guards";
import { type ScoutStore, type StoredScoutTask, scoutDigest } from "./store";
import {
  draftAction,
  draftInput,
  type QueueConnector,
  type ScoutBinding,
  ScoutError,
} from "./types";

export function scoutTaskView(task: StoredScoutTask): ScoutTaskView {
  return {
    id: task.id,
    channelId: task.channelId,
    sourceId: task.sourceId,
    title: task.title,
    state: task.receipt?.state ?? "submission_unknown",
    workItemId: task.receipt?.id ?? null,
    revision: task.receipt?.revision ?? null,
    result: task.receipt?.result ?? null,
    draftDigest: task.receipt?.result ? scoutDigest(task.receipt.result) : null,
    accepted: task.receipt?.accepted ?? false,
    errorCode: task.receipt?.error_code ?? null,
    updatedAt: task.updatedAt.toISOString(),
  };
}
export type { ScoutTaskView } from "@openbot/shared/scout";

export function createScoutService(deps: {
  store: ScoutStore;
  binding(actor: AuthenticatedActor): Promise<ScoutBinding>;
  canReadChannel(
    actor: AuthenticatedActor,
    channelId: string,
  ): Promise<boolean>;
  connect: QueueConnector;
}) {
  async function access(actor: AuthenticatedActor, channelId?: string) {
    const binding = await deps.binding(actor);
    if (binding.userId !== actor.id)
      throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    if (channelId && !(await deps.canReadChannel(actor, channelId)))
      throw new ScoutError("SCOUT_TASK_NOT_FOUND", 404);
    const current = await deps.binding(actor);
    if (
      current.userId !== actor.id ||
      current.fingerprint !== binding.fingerprint
    )
      throw new ScoutError("SCOUT_CONFLICT", 409);
    return binding;
  }
  return {
    async list(
      actor: AuthenticatedActor,
      channelId?: string,
    ): Promise<ScoutTaskView[]> {
      const binding = await access(actor, channelId);
      const rows = await deps.store.list(binding, channelId);
      const visible = await Promise.all(
        rows.map(async (row) =>
          (await deps.canReadChannel(actor, row.channelId))
            ? scoutTaskView(row)
            : null,
        ),
      );
      if ((await access(actor, channelId)).fingerprint !== binding.fingerprint)
        throw new ScoutError("SCOUT_CONFLICT", 409);
      return visible.filter((row) => row !== null);
    },
    async submit(
      actor: AuthenticatedActor,
      raw: unknown,
    ): Promise<ScoutTaskView> {
      const input = draftInput.safeParse(raw);
      if (!input.success) throw new ScoutError("SCOUT_INPUT_INVALID", 400);
      const binding = await access(actor, input.data.channelId);
      // prepare commits independently of the RPC transaction. A lost reply
      // always has the same exact payload/key to recover, even after a crash.
      const task = await deps.store.prepare(binding, input.data);
      return this.act(actor, task.id, { action: "recover" });
    },
    async act(
      actor: AuthenticatedActor,
      id: string,
      raw: unknown,
    ): Promise<ScoutTaskView> {
      if (!z.uuid().safeParse(id).success)
        throw new ScoutError("SCOUT_TASK_NOT_FOUND", 404);
      const input = draftAction.safeParse(raw);
      if (!input.success) throw new ScoutError("SCOUT_INPUT_INVALID", 400);
      const action = input.data;
      const binding = await access(actor);
      const existing = await deps.store.get(binding, id);
      if (
        (await access(actor, existing.channelId)).fingerprint !==
        binding.fingerprint
      )
        throw new ScoutError("SCOUT_CONFLICT", 409);
      const alreadyTarget =
        (action.action === "accept" &&
          existing.receipt?.state === "completed") ||
        (action.action === "cancel" && existing.receipt?.state === "cancelled");
      if (action.action === "accept" || action.action === "cancel") {
        // A completed readback is safe to repeat; an action on a changed draft
        // still has to match an explicit, durably recorded human review.
        if (!alreadyTarget) await deps.store.review(binding, id, action);
      }
      return deps.store.locked(binding, id, async (task, save) => {
        const current = await access(actor, task.channelId);
        if (current.fingerprint !== binding.fingerprint)
          throw new ScoutError("SCOUT_CONFLICT", 409);
        return deps.connect(current, async (queue) => {
          if (
            (await access(actor, task.channelId)).fingerprint !==
            binding.fingerprint
          )
            throw new ScoutError("SCOUT_CONFLICT", 409);
          let receipt = task.receipt
            ? await queue.get(task.receipt.id, task.requestKey)
            : action.action === "recover"
              ? await queue.submit({
                  title: task.title,
                  instructions: task.instructions,
                  request_key: task.requestKey,
                })
              : null;
          if (!receipt) throw new ScoutError("SCOUT_CONFLICT", 409);
          if (action.action === "accept" || action.action === "cancel") {
            const target =
              action.action === "accept" ? "completed" : "cancelled";
            if (receipt.state !== target) {
              if (alreadyTarget) throw new ScoutError("SCOUT_CONFLICT", 409);
              if (
                receipt.revision !== action.revision ||
                (action.action === "accept" &&
                  (receipt.state !== "review_required" ||
                    !receipt.result ||
                    scoutDigest(receipt.result) !== action.draftDigest))
              )
                throw new ScoutError("SCOUT_CONFLICT", 409);
              // Re-read membership/policy immediately before the mutation.
              if (
                (await access(actor, task.channelId)).fingerprint !==
                binding.fingerprint
              )
                throw new ScoutError("SCOUT_CONFLICT", 409);
              await queue.change(
                action.action,
                receipt.id,
                receipt.revision,
                task.requestKey,
              );
              receipt = await queue.get(receipt.id, task.requestKey);
              if (receipt.state !== target)
                throw new ScoutError("SCOUT_QUEUE_UNAVAILABLE", 503);
            }
          }
          const saved = await save(receipt);
          if (
            (await access(actor, task.channelId)).fingerprint !==
            binding.fingerprint
          )
            throw new ScoutError("SCOUT_CONFLICT", 409);
          return scoutTaskView(saved);
        });
      });
    },
  };
}
export type ScoutService = ReturnType<typeof createScoutService>;
