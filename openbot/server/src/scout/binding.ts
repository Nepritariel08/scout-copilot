import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { readProtectedModelFile } from "./owned-model/policy";
import { type ScoutActor, type ScoutBinding, ScoutError } from "./types";

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const absolutePath = z.string().min(1).max(1000).refine(isAbsolute);
const positiveInteger = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["", "/"].includes(url.pathname)
    );
  });
const companyIds = z
  .string()
  .regex(/^[1-9][0-9]*(,[1-9][0-9]*)*$/)
  .refine((value) => {
    const ids = value.split(",").map(Number);
    return ids.every(Number.isSafeInteger) && new Set(ids).size === ids.length;
  });
const policy = z.strictObject({
  tenantId: name,
  revision: z.number().int().positive(),
  active: z.boolean(),
  draftAnalysis: z.boolean(),
  expiresAt: z.iso.datetime(),
});
const membership = z.strictObject({
  userId: z.string().min(1).max(200),
  tenantId: name,
  policyRevision: z.number().int().positive(),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
  command: z.tuple([
    absolutePath,
    z.literal("-m"),
    z.literal("scout_queue.mcp_server"),
  ]),
  cwd: absolutePath,
  environment: z.strictObject({
    SCOUT_ODOO_URL: origin,
    SCOUT_ODOO_DB: name,
    SCOUT_ODOO_UID: positiveInteger,
    SCOUT_ODOO_COMPANY_IDS: companyIds,
    SCOUT_ODOO_KEY_FILE: absolutePath,
  }),
});
const configuration = z.strictObject({
  version: z.literal(1),
  deploymentId: name,
  policies: z.array(policy).max(100),
  bindings: z.array(membership).max(100),
});

/** Reload for every operation: revocation must not wait for a process restart. */
export function parseScoutBinding(
  input: unknown,
  actor: ScoutActor,
  now = Date.now(),
): ScoutBinding {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
  const config = parsed.data;
  const users = new Set<string>();
  const requesters = new Set<string>();
  const tenants = new Set<string>();
  for (const p of config.policies) {
    if (tenants.has(p.tenantId))
      throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
    tenants.add(p.tenantId);
  }
  for (const binding of config.bindings) {
    const requester = JSON.stringify([
      new URL(binding.environment.SCOUT_ODOO_URL).origin,
      binding.environment.SCOUT_ODOO_DB,
      Number(binding.environment.SCOUT_ODOO_UID),
    ]);
    // The private pilot has one active tenant per native account. Never share
    // the owner's Odoo identity with a second employee/customer account.
    if (users.has(binding.userId) || requesters.has(requester))
      throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
    users.add(binding.userId);
    requesters.add(requester);
  }
  const binding = config.bindings.find((row) => row.userId === actor.id);
  const tenantPolicy = config.policies.find(
    (row) => row.tenantId === binding?.tenantId,
  );
  if (
    !binding ||
    !tenantPolicy ||
    !binding.active ||
    !tenantPolicy.active ||
    !tenantPolicy.draftAnalysis ||
    binding.policyRevision !== tenantPolicy.revision ||
    Date.parse(binding.expiresAt) <= now ||
    Date.parse(tenantPolicy.expiresAt) <= now
  )
    throw new ScoutError("SCOUT_ACCESS_DENIED", 403);
  const identity = {
    database: binding.environment.SCOUT_ODOO_DB,
    uid: Number(binding.environment.SCOUT_ODOO_UID),
    companyIds: binding.environment.SCOUT_ODOO_COMPANY_IDS.split(",")
      .map(Number)
      .sort((a, b) => a - b),
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        deploymentId: config.deploymentId,
        userId: binding.userId,
        tenantId: binding.tenantId,
        policyRevision: binding.policyRevision,
        origin: new URL(binding.environment.SCOUT_ODOO_URL).origin,
        identity,
        command: binding.command,
        cwd: binding.cwd,
        keyFile: binding.environment.SCOUT_ODOO_KEY_FILE,
        expiresAt: binding.expiresAt,
        policy: tenantPolicy,
      }),
    )
    .digest("hex");
  return {
    ...binding,
    deploymentId: config.deploymentId,
    fingerprint,
    identity,
    expiresAt: new Date(
      Math.min(
        Date.parse(binding.expiresAt),
        Date.parse(tenantPolicy.expiresAt),
      ),
    ).toISOString(),
  };
}

export function createScoutBindingReader(path: string) {
  return async (actor: ScoutActor): Promise<ScoutBinding> => {
    if (!isAbsolute(path)) throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
    let input: unknown;
    try {
      input = JSON.parse(await readProtectedModelFile(path));
    } catch {
      throw new ScoutError("SCOUT_NOT_CONFIGURED", 503);
    }
    return parseScoutBinding(input, actor);
  };
}
