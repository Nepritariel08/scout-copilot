import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { QueueReceipt } from "../../scout/types";
import { users } from "./core";
import { jsonb } from "./json";

/** A submission intent and last observed receipt, never an execution queue. */
export const scoutQueueRequests = pgTable(
  "scout_queue_requests",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    bindingFingerprint: text("binding_fingerprint").notNull(),
    channelId: text("channel_id").notNull(),
    sourceId: text("source_id").notNull(),
    requestKey: text("request_key").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    receipt: jsonb("receipt").$type<QueueReceipt>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scout_queue_source_unique").on(
      table.ownerUserId,
      table.tenantId,
      table.sourceId,
    ),
    uniqueIndex("scout_queue_request_key_unique").on(table.requestKey),
    index("scout_queue_owner_updated_idx").on(
      table.ownerUserId,
      table.tenantId,
      table.updatedAt,
    ),
  ],
);

/** Exact human review intent, committed before an accept/cancel RPC. */
export const scoutQueueReviews = pgTable("scout_queue_reviews", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => scoutQueueRequests.id, { onDelete: "cascade" }),
  action: text("action").$type<"accept" | "cancel">().notNull(),
  revision: integer("revision").notNull(),
  draftDigest: text("draft_digest"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
