CREATE TABLE "scout_context_release_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"native_user_id" text NOT NULL,
	"binding_fingerprint" text NOT NULL,
	"source_instance_id" text NOT NULL,
	"data_class" text NOT NULL,
	"provider" text NOT NULL,
	"model_policy_fingerprint" text NOT NULL,
	"revision" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_context_release_revision_check" CHECK ("scout_context_release_grants"."revision" > 0),
	CONSTRAINT "scout_context_release_identity_check" CHECK ("scout_context_release_grants"."source_instance_id" ~ '^[A-Za-z0-9_-]{1,100}$' and "scout_context_release_grants"."binding_fingerprint" ~ '^[a-f0-9]{64}$' and "scout_context_release_grants"."model_policy_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "scout_context_release_data_class_check" CHECK ("scout_context_release_grants"."data_class" = 'odoo.project_task_summary.v1'),
	CONSTRAINT "scout_context_release_provider_check" CHECK ("scout_context_release_grants"."provider" in ('openrouter','local'))
);
--> statement-breakpoint
CREATE TABLE "scout_odoo_record_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"native_user_id" text NOT NULL,
	"binding_fingerprint" text NOT NULL,
	"revision" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"source_instance_id" text NOT NULL,
	"source_uid" integer NOT NULL,
	"qualification" text DEFAULT 'pending' NOT NULL,
	"qualification_expires_at" timestamp with time zone NOT NULL,
	"company_ids" integer[] NOT NULL,
	"allowed_project_ids" integer[] NOT NULL,
	"credential_ref" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_odoo_record_grant_revision_check" CHECK ("scout_odoo_record_access_grants"."revision" > 0),
	CONSTRAINT "scout_odoo_record_grant_identity_check" CHECK ("scout_odoo_record_access_grants"."source_uid" > 1 and "scout_odoo_record_access_grants"."source_instance_id" ~ '^[A-Za-z0-9_-]{1,100}$' and "scout_odoo_record_access_grants"."binding_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "scout_odoo_record_grant_qualification_check" CHECK ("scout_odoo_record_access_grants"."qualification" in ('pending','verified_nonadmin')),
	CONSTRAINT "scout_odoo_record_grant_scopes_check" CHECK (cardinality("scout_odoo_record_access_grants"."company_ids") between 1 and 100 and array_position("scout_odoo_record_access_grants"."company_ids", null) is null and 0 < all("scout_odoo_record_access_grants"."company_ids") and cardinality("scout_odoo_record_access_grants"."allowed_project_ids") between 1 and 100 and array_position("scout_odoo_record_access_grants"."allowed_project_ids", null) is null and 0 < all("scout_odoo_record_access_grants"."allowed_project_ids"))
);
--> statement-breakpoint
ALTER TABLE "scout_odoo_record_access_grants" ADD CONSTRAINT "scout_odoo_record_grant_credential_ref_fk" FOREIGN KEY ("credential_ref") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scout_context_release_grant_revision" ON "scout_context_release_grants" USING btree ("deployment_id","tenant_id","native_user_id","binding_fingerprint","source_instance_id","data_class","provider","model_policy_fingerprint","revision");--> statement-breakpoint
CREATE INDEX "scout_context_release_grant_latest" ON "scout_context_release_grants" USING btree ("deployment_id","tenant_id","native_user_id","binding_fingerprint","source_instance_id","data_class","provider","model_policy_fingerprint","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "scout_odoo_record_grant_revision" ON "scout_odoo_record_access_grants" USING btree ("deployment_id","tenant_id","native_user_id","binding_fingerprint","source_instance_id","revision");--> statement-breakpoint
CREATE INDEX "scout_odoo_record_grant_latest" ON "scout_odoo_record_access_grants" USING btree ("deployment_id","tenant_id","native_user_id","binding_fingerprint","source_instance_id","revision");--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_scout_context_grant_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Scout context grants are append-only';
  END IF;
  RAISE EXCEPTION 'Unsupported Scout context grant mutation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scout_odoo_record_grant_no_update_delete
BEFORE UPDATE OR DELETE ON "scout_odoo_record_access_grants"
FOR EACH ROW EXECUTE FUNCTION prevent_scout_context_grant_mutation();--> statement-breakpoint
CREATE TRIGGER scout_odoo_record_grant_no_truncate
BEFORE TRUNCATE ON "scout_odoo_record_access_grants"
FOR EACH STATEMENT EXECUTE FUNCTION prevent_scout_context_grant_mutation();--> statement-breakpoint
CREATE TRIGGER scout_context_release_grant_no_update_delete
BEFORE UPDATE OR DELETE ON "scout_context_release_grants"
FOR EACH ROW EXECUTE FUNCTION prevent_scout_context_grant_mutation();--> statement-breakpoint
CREATE TRIGGER scout_context_release_grant_no_truncate
BEFORE TRUNCATE ON "scout_context_release_grants"
FOR EACH STATEMENT EXECUTE FUNCTION prevent_scout_context_grant_mutation();
