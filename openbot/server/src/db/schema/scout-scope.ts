import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/** Immutable ownership; legacy rows have no implicit tenant grant. */
export const scoutResourceScopes = pgTable(
  "scout_resource_scopes",
  {
    resourceKind: text("resource_kind")
      .$type<"agent" | "channel" | "page">()
      .notNull(),
    resourceId: text("resource_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    tenantId: text("tenant_id"),
    scopeKind: text("scope_kind").$type<"tenant" | "template">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.resourceKind, t.resourceId] }),
    index("scout_scope_tenant_resource").on(
      t.deploymentId,
      t.tenantId,
      t.resourceKind,
    ),
    check(
      "scout_scope_kind_check",
      sql`${t.resourceKind} in ('agent','channel','page')`,
    ),
    check(
      "scout_scope_ownership_check",
      sql`(${t.scopeKind} = 'tenant' and ${t.tenantId} is not null) or (${t.scopeKind} = 'template' and ${t.resourceKind} = 'agent' and ${t.tenantId} is null)`,
    ),
  ],
);

/** Account reassignment must not release a previous tenant's standing instructions. */
export const scoutTenantInstructions = pgTable(
  "scout_tenant_instructions",
  {
    deploymentId: text("deployment_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    instructions: text("instructions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.tenantId, t.userId] })],
);
