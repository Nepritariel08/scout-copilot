import { createHash } from "node:crypto";
import { z } from "zod";

const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const requestSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.uuid(),
  action: z.enum(["enroll", "withdraw"]),
  target: z.strictObject({
    database: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/),
    role: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/),
  }),
  tenantId: guid,
  issuer: z.string().max(150),
  objectId: guid,
  nativeUser: z.strictObject({
    id: identifier,
    email: z.email().max(254),
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((value) =>
        Array.from(value).every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      )
      .nullable(),
  }),
  review: z.strictObject({
    operatorUserId: identifier,
    reference: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9:/#_.-]+$/),
  }),
});
export type EntraIdentityRequest = z.infer<typeof requestSchema>;
const planSchema = z.strictObject({
  version: z.literal(1),
  request: requestSchema,
  createdAt: timestamp,
  expiresAt: timestamp,
  observedDigest: digest,
  effect: z.enum(["insert_binding", "remove_binding", "binding_unchanged"]),
});
export type EntraIdentityPlan = z.infer<typeof planSchema>;
const receiptSchema = z.strictObject({
  kind: z.literal("scout.entra.identity.operation.v1"),
  operationId: z.uuid(),
  requestDigest: digest,
  planDigest: digest,
  action: z.enum(["enroll", "withdraw"]),
  effect: planSchema.shape.effect,
  postIdentityDigest: digest,
  removedSessions: z.number().int().min(0).max(1000),
  operatorDigest: digest,
  reviewDigest: digest,
});
export type EntraIdentityReceipt = z.infer<typeof receiptSchema>;
export type EntraIdentityResult = Pick<
  EntraIdentityReceipt,
  "operationId" | "planDigest" | "action" | "effect" | "removedSessions"
> & { replayed: boolean };

type NativeContact = EntraIdentityRequest["nativeUser"] & {
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
};
type Account = {
  id: string;
  userId: string;
  providerId: string;
  issuer: string | null;
  accountId: string;
  createdAt: string;
  updatedAt: string;
};
export type EntraIdentitySnapshot = {
  target: {
    database: string;
    role: string;
    serverAddress: string | null;
    serverPort: number | null;
  };
  user: NativeContact | null;
  revoked: boolean;
  accounts: Account[];
  sessions: { id: string; createdAt: string; expiresAt: string }[];
};
export type EntraIdentityTransaction = {
  snapshot(request: EntraIdentityRequest): Promise<EntraIdentitySnapshot>;
  receipt(operationId: string): Promise<unknown | null>;
  insertBinding(request: EntraIdentityRequest): Promise<void>;
  removeBinding(accountId: string): Promise<void>;
  removeSessions(userId: string): Promise<number>;
  record(receipt: EntraIdentityReceipt): Promise<void>;
};
export type EntraIdentityStore = {
  read<T>(
    use: (transaction: EntraIdentityTransaction) => Promise<T>,
  ): Promise<T>;
  write<T>(
    use: (transaction: EntraIdentityTransaction) => Promise<T>,
  ): Promise<T>;
};

export class EntraOperatorError extends Error {
  constructor(
    readonly code:
      | "ENTRA_INPUT_REFUSED"
      | "ENTRA_TARGET_REFUSED"
      | "ENTRA_CONTACT_REFUSED"
      | "ENTRA_MAPPING_CONFLICT"
      | "ENTRA_PLAN_REFUSED"
      | "ENTRA_PLAN_STALE"
      | "ENTRA_OPERATION_CONFLICT"
      | "ENTRA_POSTCONDITION_REFUSED"
      | "ENTRA_OPERATOR_FAILED",
  ) {
    super(code);
    this.name = "EntraOperatorError";
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function entraIdentityDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function parseEntraIdentityRequest(
  input: unknown,
): EntraIdentityRequest {
  const parsed = requestSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.issuer !==
      `https://login.microsoftonline.com/${parsed.data.tenantId}/v2.0`
  ) {
    throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
  }
  return parsed.data;
}
function validatedSnapshot(
  request: EntraIdentityRequest,
  snapshot: EntraIdentitySnapshot,
) {
  if (
    snapshot.target.database !== request.target.database ||
    snapshot.target.role !== request.target.role
  ) {
    throw new EntraOperatorError("ENTRA_TARGET_REFUSED");
  }
  const user = snapshot.user;
  if (
    !user ||
    user.id !== request.nativeUser.id ||
    user.email !== request.nativeUser.email ||
    user.name !== request.nativeUser.name ||
    snapshot.revoked
  ) {
    throw new EntraOperatorError("ENTRA_CONTACT_REFUSED");
  }
  if (snapshot.accounts.length > 1 || snapshot.sessions.length > 1000) {
    throw new EntraOperatorError("ENTRA_MAPPING_CONFLICT");
  }
  const account = snapshot.accounts[0];
  if (
    account &&
    (account.userId !== user.id ||
      account.providerId !== "microsoft" ||
      account.issuer !== request.issuer ||
      account.accountId !== request.objectId)
  ) {
    throw new EntraOperatorError("ENTRA_MAPPING_CONFLICT");
  }
  return account;
}
function identityDigest(snapshot: EntraIdentitySnapshot) {
  const { updatedAt: _updatedAt, ...user } = snapshot.user ?? {};
  // Token/session refresh and last-seen timestamps are not a different identity.
  return entraIdentityDigest({
    target: snapshot.target,
    user: snapshot.user && user,
    revoked: snapshot.revoked,
    accounts: snapshot.accounts.map(
      ({ updatedAt: _updatedAt, ...account }) => account,
    ),
  });
}
function result(
  receipt: EntraIdentityReceipt,
  replayed: boolean,
): EntraIdentityResult {
  const { operationId, planDigest, action, effect, removedSessions } = receipt;
  return { operationId, planDigest, action, effect, removedSessions, replayed };
}
function safeFailure(error: unknown): never {
  if (error instanceof EntraOperatorError) throw error;
  // Driver errors can carry SQL values and the connection address. Never echo them.
  throw new EntraOperatorError("ENTRA_OPERATOR_FAILED");
}

/** Operator-only library, deliberately absent from HTTP, agent and runtime composition. */
export function createEntraIdentityOperator(
  store: EntraIdentityStore,
  configuration: { tenantId: string; now?: () => number },
) {
  if (!guid.safeParse(configuration.tenantId).success)
    throw new EntraOperatorError("ENTRA_TARGET_REFUSED");
  const now = configuration.now ?? Date.now;
  function requestForDeployment(input: unknown) {
    const request = parseEntraIdentityRequest(input);
    if (request.tenantId !== configuration.tenantId)
      throw new EntraOperatorError("ENTRA_TARGET_REFUSED");
    return request;
  }
  return {
    async preview(
      input: unknown,
    ): Promise<{ plan: EntraIdentityPlan; digest: string }> {
      const request = requestForDeployment(input);
      try {
        return await store.read(async (transaction) => {
          if (await transaction.receipt(request.operationId))
            throw new EntraOperatorError("ENTRA_OPERATION_CONFLICT");
          const snapshot = await transaction.snapshot(request);
          const account = validatedSnapshot(request, snapshot);
          const createdAt = now();
          const plan: EntraIdentityPlan = {
            version: 1,
            request,
            createdAt: new Date(createdAt).toISOString(),
            expiresAt: new Date(createdAt + 15 * 60_000).toISOString(),
            observedDigest: entraIdentityDigest(snapshot),
            effect:
              request.action === "enroll"
                ? account
                  ? "binding_unchanged"
                  : "insert_binding"
                : account
                  ? "remove_binding"
                  : "binding_unchanged",
          };
          return { plan, digest: entraIdentityDigest(plan) };
        });
      } catch (error) {
        return safeFailure(error);
      }
    },
    async apply(
      input: unknown,
      approvedDigest: string,
    ): Promise<EntraIdentityResult> {
      const parsed = planSchema.safeParse(input);
      if (!parsed.success) throw new EntraOperatorError("ENTRA_PLAN_REFUSED");
      const plan = parsed.data;
      const request = requestForDeployment(plan.request);
      const planDigest = entraIdentityDigest(plan);
      const createdAt = Date.parse(plan.createdAt);
      const expiresAt = Date.parse(plan.expiresAt);
      if (
        !digest.safeParse(approvedDigest).success ||
        approvedDigest !== planDigest ||
        createdAt > now() ||
        expiresAt <= now() ||
        expiresAt - createdAt !== 15 * 60_000
      ) {
        throw new EntraOperatorError("ENTRA_PLAN_REFUSED");
      }
      try {
        return await store.write(async (transaction) => {
          if (expiresAt <= now())
            throw new EntraOperatorError("ENTRA_PLAN_REFUSED");
          // Locks and a new snapshot come from the store, never the preview transaction.
          const snapshot = await transaction.snapshot(request);
          const account = validatedSnapshot(request, snapshot);
          const previous = await transaction.receipt(request.operationId);
          if (previous) {
            const receipt = receiptSchema.safeParse(previous);
            if (
              !receipt.success ||
              receipt.data.requestDigest !== entraIdentityDigest(request) ||
              receipt.data.planDigest !== planDigest ||
              receipt.data.operationId !== request.operationId ||
              receipt.data.action !== request.action ||
              receipt.data.effect !== plan.effect
            )
              throw new EntraOperatorError("ENTRA_OPERATION_CONFLICT");
            if (
              identityDigest(snapshot) !== receipt.data.postIdentityDigest ||
              (request.action === "withdraw" && snapshot.sessions.length !== 0)
            )
              throw new EntraOperatorError("ENTRA_POSTCONDITION_REFUSED");
            return result(receipt.data, true);
          }
          if (entraIdentityDigest(snapshot) !== plan.observedDigest)
            throw new EntraOperatorError("ENTRA_PLAN_STALE");
          const effect =
            request.action === "enroll"
              ? account
                ? "binding_unchanged"
                : "insert_binding"
              : account
                ? "remove_binding"
                : "binding_unchanged";
          if (plan.effect !== effect)
            throw new EntraOperatorError("ENTRA_PLAN_REFUSED");
          if (effect === "insert_binding")
            await transaction.insertBinding(request);
          if (effect === "remove_binding" && account)
            await transaction.removeBinding(account.id);
          const removedSessions =
            request.action === "withdraw" || effect === "insert_binding"
              ? await transaction.removeSessions(request.nativeUser.id)
              : 0;
          const after = await transaction.snapshot(request);
          const afterAccount = validatedSnapshot(request, after);
          if (
            (request.action === "enroll") !== Boolean(afterAccount) ||
            ((request.action === "withdraw" || effect === "insert_binding") &&
              after.sessions.length !== 0)
          )
            throw new EntraOperatorError("ENTRA_POSTCONDITION_REFUSED");
          const receipt: EntraIdentityReceipt = {
            kind: "scout.entra.identity.operation.v1",
            operationId: request.operationId,
            requestDigest: entraIdentityDigest(request),
            planDigest,
            action: request.action,
            effect,
            postIdentityDigest: identityDigest(after),
            removedSessions,
            operatorDigest: entraIdentityDigest(request.review.operatorUserId),
            reviewDigest: entraIdentityDigest(request.review.reference),
          };
          if (expiresAt <= now())
            throw new EntraOperatorError("ENTRA_PLAN_REFUSED");
          await transaction.record(receipt);
          return result(receipt, false);
        });
      } catch (error) {
        return safeFailure(error);
      }
    },
  };
}
