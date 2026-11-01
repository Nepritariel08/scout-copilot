import { z } from "zod";
import type { Database } from "../../db/client";
import { createOdooJson2CredentialResolver } from "./odoo-credentials";
import { createOdooJson2ProjectTaskReader } from "./odoo-json2";
import { ModelPolicyError, readProtectedModelFile } from "./policy";
import type { ProjectTaskContextPort } from "./record-context";
import { createProjectTaskContextStore } from "./record-context-store";

const instanceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const databaseName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/);
const baseUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      ["", "/"].includes(url.pathname) &&
      !url.search &&
      !url.hash
    );
  });

const sourceFile = z.strictObject({
  version: z.literal(1),
  sourceInstanceId: instanceId,
  baseUrl,
  database: databaseName,
});

export type OwnedOdooContextSource = z.infer<typeof sourceFile>;

/** Bounded protected deployment settings; no user, grant, credential, or project scope is accepted here. */
export async function readOwnedOdooContextSource(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<OwnedOdooContextSource> {
  try {
    if (platform !== "linux") {
      throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
    }
    const value: unknown = JSON.parse(await readProtectedModelFile(path, 8192));
    const parsed = sourceFile.safeParse(value);
    if (!parsed.success) throw new Error("invalid source configuration");
    return parsed.data;
  } catch {
    throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  }
}

/** Compose the production, read-only port. No database grant means no Odoo lookup or model release. */
export function createOwnedOdooProjectTaskContext(
  database: Database,
  encryptionKey: string,
  source: OwnedOdooContextSource,
  fetch?: typeof globalThis.fetch,
): ProjectTaskContextPort {
  const credentials = createOdooJson2CredentialResolver(
    database,
    encryptionKey,
    source.sourceInstanceId,
  );
  const reader = createOdooJson2ProjectTaskReader({
    instanceId: source.sourceInstanceId,
    baseUrl: source.baseUrl,
    database: source.database,
    credentials,
    ...(fetch ? { fetch } : {}),
  });
  return createProjectTaskContextStore(
    database,
    source.sourceInstanceId,
    reader,
  );
}
