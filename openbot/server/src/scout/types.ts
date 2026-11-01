import { z } from "zod";

export class ScoutError extends Error {
  constructor(
    readonly code:
      | "SCOUT_NOT_CONFIGURED"
      | "SCOUT_ACCESS_DENIED"
      | "SCOUT_TASK_NOT_FOUND"
      | "SCOUT_INPUT_INVALID"
      | "SCOUT_CONFLICT"
      | "SCOUT_QUEUE_UNAVAILABLE"
      | "SCOUT_RECEIPT_INVALID",
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = "ScoutError";
  }
}

export const draftState = z.enum([
  "queued",
  "running",
  "review_required",
  "completed",
  "cancelled",
  "failed",
]);

export const queueReceipt = z.object({
  id: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  state: draftState,
  task_kind: z.literal("draft_analysis"),
  requested_by: z.number().int().positive(),
  company_id: z.number().int().positive(),
  request_key: z.string().min(1).max(128),
  accepted: z.boolean(),
  result: z.string().max(20_000).nullable().optional(),
  error_code: z.string().max(100).nullable().optional(),
  dsh_session_id: z.string().max(200).nullable().optional(),
});

export type QueueReceipt = z.infer<typeof queueReceipt>;
export type QueuePayload = {
  title: string;
  instructions: string;
  request_key: string;
};

export const draftInput = z.strictObject({
  sourceId: z.uuid(),
  channelId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(8000),
});
export type DraftInput = z.infer<typeof draftInput>;
export const draftAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("refresh") }),
  z.strictObject({ action: z.literal("recover") }),
  z.strictObject({
    action: z.literal("accept"),
    revision: z.number().int().nonnegative(),
    draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    revision: z.number().int().nonnegative(),
  }),
]);
export type DraftAction = z.infer<typeof draftAction>;

/** An already authenticated native user, never a user id from an HTTP body. */
export type ScoutActor = { id: string };

export type ScoutMembership = {
  userId: string;
  tenantId: string;
  fingerprint: string;
  /** Earliest expiration of the current protected tenant policy and membership. */
  expiresAt: string;
  deploymentId: string;
};

/** Separate delegated-draft requester authority; never native tenant admission. */
export type ScoutBinding = ScoutMembership & {
  command: [string, "-m", "scout_queue.mcp_server"];
  cwd: string;
  environment: {
    SCOUT_ODOO_URL: string;
    SCOUT_ODOO_DB: string;
    SCOUT_ODOO_UID: string;
    SCOUT_ODOO_COMPANY_IDS: string;
    SCOUT_ODOO_KEY_FILE: string;
  };
  identity: { database: string; uid: number; companyIds: number[] };
};

export type QueueSession = {
  submit(payload: QueuePayload): Promise<QueueReceipt>;
  get(id: number, requestKey: string): Promise<QueueReceipt>;
  change(
    action: "accept" | "cancel",
    id: number,
    revision: number,
    requestKey: string,
  ): Promise<QueueReceipt>;
};

export type QueueConnector = <T>(
  binding: ScoutBinding,
  use: (session: QueueSession) => Promise<T>,
) => Promise<T>;
