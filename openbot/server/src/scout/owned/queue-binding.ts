import { createHash } from "node:crypto";
import type { MembershipReader } from "../membership";
import {
  type ScoutActor,
  type ScoutBinding,
  ScoutError,
  type ScoutMembership,
} from "../types";

export type QueueBindingReader = (actor: ScoutActor) => Promise<ScoutBinding>;

/** Queue authority is the intersection of two current, independently provisioned grants. */
export function createOwnedQueueBindingReader(deps: {
  membership: MembershipReader;
  queue: QueueBindingReader;
  deploymentId: string;
}): QueueBindingReader {
  const matches = (actor: ScoutActor, value: ScoutMembership) =>
    value.userId === actor.id &&
    value.deploymentId === deps.deploymentId &&
    Boolean(value.tenantId && value.fingerprint) &&
    Date.parse(value.expiresAt) > Date.now();
  return async (actor) => {
    const member = await deps.membership(actor);
    if (!matches(actor, member))
      throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    const queue = await deps.queue(actor);
    const current = await deps.membership(actor);
    if (
      !matches(actor, current) ||
      !matches(actor, queue) ||
      current.tenantId !== member.tenantId ||
      current.fingerprint !== member.fingerprint ||
      queue.tenantId !== member.tenantId
    )
      throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
    return {
      ...queue,
      expiresAt: new Date(
        Math.min(Date.parse(current.expiresAt), Date.parse(queue.expiresAt)),
      ).toISOString(),
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            purpose: "scout-owned-queue-admission-v1",
            membership: current.fingerprint,
            queue: queue.fingerprint,
          }),
        )
        .digest("hex"),
    };
  };
}
