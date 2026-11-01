import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { scoutQueueRequests, scoutQueueReviews } from "../db/schema/scout";
import {
  type DraftAction,
  type DraftInput,
  type QueueReceipt,
  type ScoutBinding,
  ScoutError,
} from "./types";

export type StoredScoutTask = typeof scoutQueueRequests.$inferSelect;
export const scoutDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const receiptDigest = (receipt: QueueReceipt) =>
  scoutDigest(
    JSON.stringify([
      receipt.id,
      receipt.revision,
      receipt.state,
      receipt.requested_by,
      receipt.company_id,
      receipt.request_key,
      receipt.accepted,
      receipt.result ?? null,
      receipt.error_code ?? null,
      receipt.dsh_session_id ?? null,
    ]),
  );
type Review = Extract<DraftAction, { action: "accept" | "cancel" }>;

export type ScoutStore = {
  prepare(binding: ScoutBinding, input: DraftInput): Promise<StoredScoutTask>;
  get(binding: ScoutBinding, id: string): Promise<StoredScoutTask>;
  list(binding: ScoutBinding, channelId?: string): Promise<StoredScoutTask[]>;
  review(binding: ScoutBinding, id: string, action: Review): Promise<void>;
  locked<T>(
    binding: ScoutBinding,
    id: string,
    use: (
      task: StoredScoutTask,
      save: (receipt: QueueReceipt) => Promise<StoredScoutTask>,
    ) => Promise<T>,
  ): Promise<T>;
};

function matches(binding: ScoutBinding, id: string) {
  return and(
    eq(scoutQueueRequests.id, id),
    eq(scoutQueueRequests.ownerUserId, binding.userId),
    eq(scoutQueueRequests.tenantId, binding.tenantId),
  );
}
function check(
  task: StoredScoutTask | undefined,
  binding: ScoutBinding,
): StoredScoutTask {
  if (!task) throw new ScoutError("SCOUT_TASK_NOT_FOUND", 404);
  if (task.bindingFingerprint !== binding.fingerprint)
    throw new ScoutError("SCOUT_CONFLICT", 409);
  return task;
}

export function createScoutStore(
  database: Database,
  assertCurrent: (binding: ScoutBinding) => Promise<void> = async () => {},
): ScoutStore {
  async function get(binding: ScoutBinding, id: string) {
    const [row] = await database
      .select()
      .from(scoutQueueRequests)
      .where(matches(binding, id));
    return check(row, binding);
  }
  return {
    get,
    async prepare(binding, input) {
      return database.transaction(async (tx) => {
        await assertCurrent(binding);
        const requestKey = `scout:${scoutDigest(
          JSON.stringify([
            binding.deploymentId,
            binding.userId,
            binding.tenantId,
            input.sourceId,
          ]),
        )}`;
        await tx
          .insert(scoutQueueRequests)
          .values({
            id: randomUUID(),
            ownerUserId: binding.userId,
            tenantId: binding.tenantId,
            bindingFingerprint: binding.fingerprint,
            channelId: input.channelId,
            sourceId: input.sourceId,
            requestKey,
            title: input.title,
            instructions: input.instructions,
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(scoutQueueRequests)
          .where(
            and(
              eq(scoutQueueRequests.ownerUserId, binding.userId),
              eq(scoutQueueRequests.tenantId, binding.tenantId),
              eq(scoutQueueRequests.sourceId, input.sourceId),
            ),
          );
        const task = check(row, binding);
        if (
          task.requestKey !== requestKey ||
          task.channelId !== input.channelId ||
          task.title !== input.title ||
          task.instructions !== input.instructions
        )
          throw new ScoutError("SCOUT_CONFLICT", 409);
        await assertCurrent(binding);
        return task;
      });
    },
    async list(binding, channelId) {
      return database
        .select()
        .from(scoutQueueRequests)
        .where(
          and(
            eq(scoutQueueRequests.ownerUserId, binding.userId),
            eq(scoutQueueRequests.tenantId, binding.tenantId),
            eq(scoutQueueRequests.bindingFingerprint, binding.fingerprint),
            channelId ? eq(scoutQueueRequests.channelId, channelId) : undefined,
          ),
        )
        .orderBy(
          desc(scoutQueueRequests.updatedAt),
          desc(scoutQueueRequests.id),
        )
        .limit(50);
    },
    async review(binding, id, action) {
      const task = await get(binding, id);
      if (
        !task.receipt ||
        task.receipt.revision !== action.revision ||
        (action.action === "accept" &&
          (task.receipt.state !== "review_required" ||
            !task.receipt.result ||
            scoutDigest(task.receipt.result) !== action.draftDigest))
      )
        throw new ScoutError("SCOUT_CONFLICT", 409);
      const digest = action.action === "accept" ? action.draftDigest : null;
      await database.transaction(async (tx) => {
        await assertCurrent(binding);
        await tx
          .insert(scoutQueueReviews)
          .values({
            id: scoutDigest(
              JSON.stringify([
                task.id,
                binding.fingerprint,
                action.action,
                action.revision,
                digest,
              ]),
            ),
            requestId: task.id,
            action: action.action,
            revision: action.revision,
            draftDigest: digest,
          })
          .onConflictDoNothing();
        await assertCurrent(binding);
      });
    },
    async locked(binding, id, use) {
      return database.transaction(async (tx) => {
        await assertCurrent(binding);
        const [lock] = await tx.execute<{ locked: boolean }>(sql`
          select pg_try_advisory_xact_lock(hashtext('scout.requester'), hashtext(${id})) as locked
        `);
        if (!lock?.locked) throw new ScoutError("SCOUT_CONFLICT", 409);
        const [row] = await tx
          .select()
          .from(scoutQueueRequests)
          .where(matches(binding, id));
        const task = check(row, binding);
        const result = await use(task, async (receipt) => {
          if (
            task.receipt &&
            (receipt.revision < task.receipt.revision ||
              (receipt.revision === task.receipt.revision &&
                receiptDigest(receipt) !== receiptDigest(task.receipt)))
          )
            throw new ScoutError("SCOUT_RECEIPT_INVALID", 503);
          const [saved] = await tx
            .update(scoutQueueRequests)
            .set({
              receipt,
              updatedAt: new Date(),
            })
            .where(matches(binding, id))
            .returning();
          return check(saved, binding);
        });
        await assertCurrent(binding);
        return result;
      });
    },
  };
}
