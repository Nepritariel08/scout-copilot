import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Metadata only. Conversation/user deletion must not reset quotas or erase usage receipts. */
export const scoutModelCalls = pgTable(
  "scout_model_calls",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    runId: text("run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    leaseToken: text("lease_token").notNull(),
    requestDigest: text("request_digest").notNull(),
    policyFingerprint: text("policy_fingerprint").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    provider: text("provider").notNull(),
    requestedModel: text("requested_model").notNull(),
    reportedModel: text("reported_model"),
    endpointOrigin: text("endpoint_origin").notNull(),
    inputBytes: integer("input_bytes").notNull(),
    outputBytes: integer("output_bytes").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reportedCostUsd: text("reported_cost_usd"),
    status: text("status")
      .$type<
        "reserved" | "dispatched" | "completed" | "refused" | "uncertain"
      >()
      .notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("scout_model_run_ordinal").on(
      table.threadId,
      table.runId,
      table.ordinal,
    ),
    index("scout_model_deployment_day").on(table.deploymentId, table.createdAt),
    index("scout_model_actor_day").on(
      table.deploymentId,
      table.ownerUserId,
      table.tenantId,
      table.createdAt,
    ),
    index("scout_model_active_expiry").on(
      table.deploymentId,
      table.status,
      table.expiresAt,
    ),
    check(
      "scout_model_status_check",
      sql`${table.status} in ('reserved','dispatched','completed','refused','uncertain')`,
    ),
    check(
      "scout_model_provider_check",
      sql`${table.provider} in ('local','openrouter')`,
    ),
    check(
      "scout_model_counters_check",
      sql`${table.ordinal} > 0 and ${table.policyRevision} > 0 and ${table.inputBytes} >= 0 and ${table.outputBytes} >= 0 and (${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0)`,
    ),
    check(
      "scout_model_digest_check",
      sql`${table.requestDigest} ~ '^[a-f0-9]{64}$' and ${table.policyFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "scout_model_cost_check",
      sql`${table.reportedCostUsd} is null or ${table.reportedCostUsd} ~ '^[0-9]+([.][0-9]+)?$'`,
    ),
  ],
);
