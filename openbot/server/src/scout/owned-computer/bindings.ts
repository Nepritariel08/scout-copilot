import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { historyDigest } from "../history/protocol";
import { readProtectedModelFile } from "../owned-model/policy";

export class OwnedComputerError extends Error {
  constructor(
    readonly code:
      | "COMPUTER_ACCESS_DENIED"
      | "COMPUTER_UNAVAILABLE"
      | "COMPUTER_INPUT_INVALID"
      | "COMPUTER_CANCELLED"
      | "COMPUTER_BUSY",
  ) {
    super(code);
  }
}
const name = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const agent = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/);
const file = z.string().min(1).max(2048).refine(isAbsolute);
export const ownedComputerBindingsSchema = z.strictObject({
  version: z.literal(1),
  deploymentId: name,
  supervisorUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        Boolean(url.port) &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
  supervisorTokenFile: file,
  computerTokenFile: file,
  grants: z
    .array(
      z.strictObject({
        userId: z.string().trim().min(1).max(200),
        tenantId: name,
        agentId: agent,
        revision: z.number().int().positive(),
        active: z.boolean(),
        expiresAt: z.iso.datetime(),
      }),
    )
    .min(1)
    .max(32),
});
export type OwnedComputerBindings = z.infer<typeof ownedComputerBindingsSchema>;
export type OwnedComputerRuntime = OwnedComputerBindings & {
  supervisorToken: string;
  computerToken: string;
  fingerprint: string;
};
export function privateComputerId(
  deploymentId: string,
  tenantId: string,
  userId: string,
  agentId: string,
) {
  return `sc-${historyDigest({ purpose: "scout-owned-computer-v1", deploymentId, tenantId, userId, agentId }).slice(0, 40)}`;
}
export function parseOwnedComputerBindings(
  value: unknown,
  deploymentId: string,
): OwnedComputerBindings {
  const result = ownedComputerBindingsSchema.safeParse(value);
  if (!result.success || result.data.deploymentId !== deploymentId)
    throw new OwnedComputerError("COMPUTER_UNAVAILABLE");
  const keys = result.data.grants.map((grant) =>
    JSON.stringify([grant.userId, grant.tenantId, grant.agentId]),
  );
  if (new Set(keys).size !== keys.length)
    throw new OwnedComputerError("COMPUTER_UNAVAILABLE");
  return result.data;
}
export function createOwnedComputerConfigReader(
  path: string,
  deploymentId: string,
) {
  return async (): Promise<OwnedComputerRuntime> => {
    try {
      const config = parseOwnedComputerBindings(
        JSON.parse(await readProtectedModelFile(path)),
        deploymentId,
      );
      const tokens = await Promise.all(
        [config.supervisorTokenFile, config.computerTokenFile].map(
          async (tokenFile) => {
            const token = (
              await readProtectedModelFile(tokenFile, 4096)
            ).trim();
            if (!/^[A-Za-z0-9_-]{32,512}$/.test(token))
              throw new Error("Invalid protected token");
            return token;
          },
        ),
      );
      const supervisorToken = tokens[0],
        computerToken = tokens[1];
      if (!supervisorToken || !computerToken)
        throw new Error("Missing protected token");
      return {
        ...config,
        supervisorToken,
        computerToken,
        fingerprint: historyDigest({
          config,
          credentials: tokens.map((token) =>
            createHash("sha256").update(token).digest("hex"),
          ),
        }),
      };
    } catch {
      throw new OwnedComputerError("COMPUTER_UNAVAILABLE");
    }
  };
}
