import { z } from "zod";

/** Server-created references and digests only. No prompt, record payload or credential. */
export const contextDependencySchema = z.strictObject({
  kind: z.literal("odoo.project_task_summary.v1"),
  principal: z.strictObject({
    userId: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    deploymentId: z.string().min(1).max(200),
    bindingFingerprint: z.string().min(1).max(200),
  }),
  sourceInstanceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  recordId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  provider: z.enum(["openrouter", "local"]),
  modelPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  grantDigest: z.string().regex(/^[a-f0-9]{64}$/),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ContextDependency = z.infer<typeof contextDependencySchema>;
export const historyContextSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(16),
    dependencies: z.array(contextDependencySchema).max(16),
  })
  .refine((value) => value.revision === value.dependencies.length);
export type HistoryContext = z.infer<typeof historyContextSchema>;
