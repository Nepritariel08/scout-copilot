import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { historyDigest } from "../history/protocol";
import type { ScoutMembership } from "../types";

export class ModelPolicyError extends Error {
  constructor(
    readonly code:
      | "MODEL_NOT_CONFIGURED"
      | "MODEL_ACCESS_DENIED"
      | "MODEL_LIMIT"
      | "MODEL_UNAVAILABLE"
      | "MODEL_CONFLICT"
      | "MODEL_COST_VIOLATION",
  ) {
    super(code);
    this.name = "ModelPolicyError";
  }
}

const identifier = z.string().trim().min(1).max(200);
const absolutePath = z.string().min(1).max(1000).refine(isAbsolute);
const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/);
const localBase = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      /^\/v1\/?$/.test(url.pathname)
    );
  });
const route = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("openrouter"),
    model: modelId,
    apiKeyFile: absolutePath,
  }),
  z.strictObject({
    provider: z.literal("local"),
    model: modelId,
    baseUrl: localBase,
    apiKeyFile: absolutePath.optional(),
  }),
]);
const member = z.strictObject({
  userId: identifier,
  tenantId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  active: z.boolean(),
  revision: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  agentIds: z.array(identifier).min(1).max(50),
  allowConversationContext: z.literal(true),
  allowPersonalInstructions: z.boolean(),
  route,
  limits: z.strictObject({
    maxInputBytes: z.number().int().min(1024).max(262144),
    maxOutputTokens: z.number().int().min(1).max(4096),
    maxOutputBytes: z.number().int().min(1024).max(262144),
    maxCallsPerRun: z.number().int().min(1).max(8),
    maxCallsPerDay: z.number().int().min(1).max(1000),
    maxConcurrent: z.number().int().min(1).max(4),
    timeoutMs: z.number().int().min(1000).max(120000),
  }),
});
const configuration = z.strictObject({
  version: z.literal(1),
  deploymentId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  globalMaxConcurrent: z.number().int().min(1).max(8),
  globalMaxCallsPerDay: z.number().int().min(1).max(10000),
  bindings: z.array(member).max(100),
});
export type ModelGrant = z.infer<typeof member> & {
  deploymentId: string;
  fingerprint: string;
  globalMaxConcurrent: number;
  globalMaxCallsPerDay: number;
};
export type ModelPrincipal = {
  userId: string;
  tenantId: string;
  deploymentId: string;
  agentId: string;
};

/** Administrator-owned configuration, never a browser or model-selected route/budget. */
export function parseModelPolicy(
  input: unknown,
  principal: ModelPrincipal,
  now = Date.now(),
): ModelGrant {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  const value = parsed.data;
  const users = new Set<string>();
  for (const binding of value.bindings) {
    if (
      users.has(binding.userId) ||
      new Set(binding.agentIds).size !== binding.agentIds.length
    )
      throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
    users.add(binding.userId);
  }
  const selected = value.bindings.find(
    (binding) => binding.userId === principal.userId,
  );
  if (
    value.deploymentId !== principal.deploymentId ||
    !selected ||
    !selected.active ||
    selected.tenantId !== principal.tenantId ||
    !selected.agentIds.includes(principal.agentId) ||
    Date.parse(selected.expiresAt) <= now
  )
    throw new ModelPolicyError("MODEL_ACCESS_DENIED");
  return {
    ...selected,
    deploymentId: value.deploymentId,
    globalMaxConcurrent: value.globalMaxConcurrent,
    globalMaxCallsPerDay: value.globalMaxCallsPerDay,
    fingerprint: historyDigest(value),
  };
}

/** Bounded reads with no symlink following or group/world-readable Unix policy/key files. */
export async function readProtectedModelFile(
  path: string,
  maxBytes = 65536,
): Promise<string> {
  if (!isAbsolute(path)) throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("not a regular protected file");
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await file.stat();
      const uid = process.getuid?.();
      if (
        !stat.isFile() ||
        stat.ino !== entry.ino ||
        stat.dev !== entry.dev ||
        stat.size > maxBytes ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || (stat.uid !== 0 && stat.uid !== uid)))
      )
        throw new Error("invalid protected file");
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error("oversized protected file");
      return buffer.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  }
}

export function createModelPolicyReader(path: string) {
  return async (principal: ModelPrincipal): Promise<ModelGrant> => {
    let value: unknown;
    try {
      value = JSON.parse(await readProtectedModelFile(path));
    } catch {
      throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
    }
    return parseModelPolicy(value, principal);
  };
}

export async function readModelKey(grant: ModelGrant): Promise<string | null> {
  const path = grant.route.apiKeyFile;
  if (!path) return null;
  const value = (await readProtectedModelFile(path, 4096)).trim();
  if (
    !value ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  return value;
}

export function modelPrincipal(
  userId: string,
  binding: ScoutMembership,
  agentId: string,
): ModelPrincipal {
  return {
    userId,
    tenantId: binding.tenantId,
    deploymentId: binding.deploymentId,
    agentId,
  };
}

/** Text-only free-tier pilot: all possible price categories are capped, with strict provider privacy. */
export const OPENROUTER_OWNED_PREFERENCES = {
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny",
  zdr: true,
  max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
} as const;
