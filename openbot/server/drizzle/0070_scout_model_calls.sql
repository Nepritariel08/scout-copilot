CREATE TABLE "scout_model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"lease_token" text NOT NULL,
	"request_digest" text NOT NULL,
	"policy_fingerprint" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"provider" text NOT NULL,
	"requested_model" text NOT NULL,
	"reported_model" text,
	"endpoint_origin" text NOT NULL,
	"input_bytes" integer NOT NULL,
	"output_bytes" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"reported_cost_usd" text,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scout_model_status_check" CHECK ("scout_model_calls"."status" in ('reserved','dispatched','completed','refused','uncertain')),
	CONSTRAINT "scout_model_provider_check" CHECK ("scout_model_calls"."provider" in ('local','openrouter')),
	CONSTRAINT "scout_model_counters_check" CHECK ("scout_model_calls"."ordinal" > 0 and "scout_model_calls"."policy_revision" > 0 and "scout_model_calls"."input_bytes" >= 0 and "scout_model_calls"."output_bytes" >= 0 and ("scout_model_calls"."input_tokens" is null or "scout_model_calls"."input_tokens" >= 0) and ("scout_model_calls"."output_tokens" is null or "scout_model_calls"."output_tokens" >= 0)),
	CONSTRAINT "scout_model_digest_check" CHECK ("scout_model_calls"."request_digest" ~ '^[a-f0-9]{64}$' and "scout_model_calls"."policy_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "scout_model_cost_check" CHECK ("scout_model_calls"."reported_cost_usd" is null or "scout_model_calls"."reported_cost_usd" ~ '^[0-9]+([.][0-9]+)?$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scout_model_run_ordinal" ON "scout_model_calls" USING btree ("thread_id","run_id","ordinal");--> statement-breakpoint
CREATE INDEX "scout_model_deployment_day" ON "scout_model_calls" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX "scout_model_actor_day" ON "scout_model_calls" USING btree ("deployment_id","owner_user_id","tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "scout_model_active_expiry" ON "scout_model_calls" USING btree ("deployment_id","status","expires_at");