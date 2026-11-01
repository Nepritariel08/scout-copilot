import { createHash } from "node:crypto";
import { z } from "zod";
import { readProtectedModelFile } from "./owned-model/policy";
import { type ScoutActor, ScoutError, type ScoutMembership } from "./types";

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const subject = z
  .string()
  .min(1)
  .max(200)
  .refine((value) =>
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
    ),
  );
const policy = z.strictObject({
  tenantId: name,
  revision: z.number().int().positive(),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
});
const membership = z.strictObject({
  userId: subject,
  tenantId: name,
  revision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
});
const configuration = z.strictObject({
  version: z.literal(1),
  deploymentId: name,
  policies: z.array(policy).max(100),
  memberships: z.array(membership).max(100),
});

export type MembershipReader = (actor: ScoutActor) => Promise<ScoutMembership>;

/** Native tenant admission only. No queue, Odoo, model, or platform-owner grant. */
export function parseScoutMembership(
  input: unknown,
  actor: ScoutActor,
  deploymentId: string,
  now = Date.now(),
): ScoutMembership {
  const parsed = configuration.safeParse(input);
  if (!parsed.success || !name.safeParse(deploymentId).success)
    throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
  const config = parsed.data;
  const tenants = new Set(config.policies.map((row) => row.tenantId));
  const users = new Set(config.memberships.map((row) => row.userId));
  if (
    tenants.size !== config.policies.length ||
    users.size !== config.memberships.length ||
    config.memberships.some((row) => !tenants.has(row.tenantId))
  )
    throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
  const selected = config.memberships.find((row) => row.userId === actor.id);
  const tenant = config.policies.find(
    (row) => row.tenantId === selected?.tenantId,
  );
  if (
    config.deploymentId !== deploymentId ||
    !selected ||
    !tenant ||
    !selected.active ||
    !tenant.active ||
    selected.policyRevision !== tenant.revision ||
    Date.parse(selected.expiresAt) <= now ||
    Date.parse(tenant.expiresAt) <= now
  )
    throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
  return {
    userId: selected.userId,
    tenantId: selected.tenantId,
    deploymentId: config.deploymentId,
    expiresAt: new Date(
      Math.min(Date.parse(selected.expiresAt), Date.parse(tenant.expiresAt)),
    ).toISOString(),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          purpose: "scout-native-membership-v1",
          deploymentId: config.deploymentId,
          membership: selected,
          policy: tenant,
        }),
      )
      .digest("hex"),
  };
}

/** Fresh bounded protected-file reads make revocation effective without a restart. */
export function createScoutMembershipReader(
  path: string,
  deploymentId: string,
): MembershipReader {
  return async (actor) => {
    let input: unknown;
    try {
      input = JSON.parse(await readProtectedModelFile(path));
    } catch {
      throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
    }
    return parseScoutMembership(input, actor, deploymentId);
  };
}
