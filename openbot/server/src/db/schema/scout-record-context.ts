import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { credentials } from "./core";

/**
 * Append-only, per-native-user authority to read one Odoo project.task summary.
 * The credential column is only a pointer into the encrypted credential vault.
 */
export const scoutOdooRecordAccessGrants = pgTable(
  "scout_odoo_record_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: text("deployment_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    nativeUserId: text("native_user_id").notNull(),
    bindingFingerprint: text("binding_fingerprint").notNull(),
    revision: integer("revision").notNull(),
    active: boolean("active").notNull().default(false),
    sourceInstanceId: text("source_instance_id").notNull(),
    sourceUid: integer("source_uid").notNull(),
    qualification: text("qualification").notNull().default("pending"),
    qualificationExpiresAt: timestamp("qualification_expires_at", {
      withTimezone: true,
    }).notNull(),
    companyIds: integer("company_ids").array().notNull(),
    allowedProjectIds: integer("allowed_project_ids").array().notNull(),
    credentialRef: uuid("credential_ref").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scout_odoo_record_grant_revision").on(
      table.deploymentId,
      table.tenantId,
      table.nativeUserId,
      table.bindingFingerprint,
      table.sourceInstanceId,
      table.revision,
    ),
    index("scout_odoo_record_grant_latest").on(
      table.deploymentId,
      table.tenantId,
      table.nativeUserId,
      table.bindingFingerprint,
      table.sourceInstanceId,
      table.revision,
    ),
    check("scout_odoo_record_grant_revision_check", sql`${table.revision} > 0`),
    check(
      "scout_odoo_record_grant_identity_check",
      sql`${table.sourceUid} > 1 and ${table.sourceInstanceId} ~ '^[A-Za-z0-9_-]{1,100}$' and ${table.bindingFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "scout_odoo_record_grant_qualification_check",
      sql`${table.qualification} in ('pending','verified_nonadmin')`,
    ),
    check(
      "scout_odoo_record_grant_scopes_check",
      sql`cardinality(${table.companyIds}) between 1 and 100 and array_position(${table.companyIds}, null) is null and 0 < all(${table.companyIds}) and cardinality(${table.allowedProjectIds}) between 1 and 100 and array_position(${table.allowedProjectIds}, null) is null and 0 < all(${table.allowedProjectIds})`,
    ),
    foreignKey({
      name: "scout_odoo_record_grant_credential_ref_fk",
      columns: [table.credentialRef],
      foreignColumns: [credentials.id],
    }).onDelete("restrict"),
  ],
);

/** Consent is bound independently to data class, exact Odoo instance and model-policy revision. */
export const scoutContextReleaseGrants = pgTable(
  "scout_context_release_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: text("deployment_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    nativeUserId: text("native_user_id").notNull(),
    bindingFingerprint: text("binding_fingerprint").notNull(),
    sourceInstanceId: text("source_instance_id").notNull(),
    dataClass: text("data_class").notNull(),
    provider: text("provider").notNull(),
    modelPolicyFingerprint: text("model_policy_fingerprint").notNull(),
    revision: integer("revision").notNull(),
    active: boolean("active").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("scout_context_release_grant_revision").on(
      table.deploymentId,
      table.tenantId,
      table.nativeUserId,
      table.bindingFingerprint,
      table.sourceInstanceId,
      table.dataClass,
      table.provider,
      table.modelPolicyFingerprint,
      table.revision,
    ),
    index("scout_context_release_grant_latest").on(
      table.deploymentId,
      table.tenantId,
      table.nativeUserId,
      table.bindingFingerprint,
      table.sourceInstanceId,
      table.dataClass,
      table.provider,
      table.modelPolicyFingerprint,
      table.revision,
    ),
    check("scout_context_release_revision_check", sql`${table.revision} > 0`),
    check(
      "scout_context_release_identity_check",
      sql`${table.sourceInstanceId} ~ '^[A-Za-z0-9_-]{1,100}$' and ${table.bindingFingerprint} ~ '^[a-f0-9]{64}$' and ${table.modelPolicyFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "scout_context_release_data_class_check",
      sql`${table.dataClass} = 'odoo.project_task_summary.v1'`,
    ),
    check(
      "scout_context_release_provider_check",
      sql`${table.provider} in ('openrouter','local')`,
    ),
  ],
);
