import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { HistorySnapshot } from "../../scout/history/protocol";
import type { ContextDependency } from "../../scout/owned-model/context-dependency";
import { users } from "./core";
import { jsonb } from "./json";

export const scoutHistoryThreads = pgTable(
  "scout_history_threads",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id").notNull(),
    channelId: text("channel_id"),
    name: text("name").notNull().default("New conversation"),
    archived: boolean("archived").notNull().default(false),
    snapshot: jsonb("snapshot")
      .$type<HistorySnapshot>()
      .notNull()
      .default({ messages: [], state: {} }),
    sequence: integer("sequence").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("scout_history_owner_updated_idx").on(
      table.ownerUserId,
      table.tenantId,
      table.updatedAt,
    ),
    check(
      "scout_history_thread_counters_check",
      sql`${table.sequence} >= 0 and ${table.bytes} >= 0`,
    ),
  ],
);

export type HistoryRunStatus =
  | "running"
  | "stop_requested"
  | "completed"
  | "cancelled"
  | "interrupted";
export const scoutHistoryRuns = pgTable(
  "scout_history_runs",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => scoutHistoryThreads.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    agentId: text("agent_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    contextRevision: integer("context_revision"),
    input: jsonb("input").$type<RunAgentInput>().notNull(),
    status: text("status").$type<HistoryRunStatus>().notNull(),
    leaseToken: text("lease_token").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.id] }),
    uniqueIndex("scout_history_one_active_run")
      .on(table.threadId)
      .where(sql`${table.status} in ('running', 'stop_requested')`),
    check(
      "scout_history_run_status_check",
      sql`${table.status} in ('running', 'stop_requested', 'completed', 'cancelled', 'interrupted')`,
    ),
    check(
      "scout_history_run_digest_check",
      sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "scout_history_run_context_revision_check",
      sql`${table.contextRevision} is null or ${table.contextRevision} between 0 and 16`,
    ),
  ],
);

export const scoutHistoryEvents = pgTable(
  "scout_history_events",
  {
    threadId: text("thread_id").notNull(),
    sequence: integer("sequence").notNull(),
    runId: text("run_id").notNull(),
    event: jsonb("event").$type<BaseEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.sequence] }),
    foreignKey({
      columns: [table.threadId, table.runId],
      foreignColumns: [scoutHistoryRuns.threadId, scoutHistoryRuns.id],
    }).onDelete("cascade"),
    index("scout_history_run_events_idx").on(
      table.threadId,
      table.runId,
      table.sequence,
    ),
    check("scout_history_event_sequence_check", sql`${table.sequence} > 0`),
  ],
);

/** Absence means unknown legacy provenance, never implicitly source-free. */
export const scoutHistoryContext = pgTable(
  "scout_history_context",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => scoutHistoryThreads.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    revision: integer("revision").notNull(),
    dependencies: jsonb("dependencies").$type<ContextDependency[]>().notNull(),
  },
  (table) => [
    check(
      "scout_history_context_shape",
      sql`${table.version} = 1 and ${table.revision} between 0 and 16 and jsonb_typeof(${table.dependencies}) = 'array' and jsonb_array_length(${table.dependencies}) = ${table.revision}`,
    ),
  ],
);
