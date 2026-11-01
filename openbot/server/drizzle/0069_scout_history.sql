CREATE TABLE "scout_history_events" (
	"thread_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"run_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_history_events_thread_id_sequence_pk" PRIMARY KEY("thread_id","sequence"),
	CONSTRAINT "scout_history_event_sequence_check" CHECK ("scout_history_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "scout_history_runs" (
	"thread_id" text NOT NULL,
	"id" text NOT NULL,
	"agent_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"lease_token" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scout_history_runs_thread_id_id_pk" PRIMARY KEY("thread_id","id"),
	CONSTRAINT "scout_history_run_status_check" CHECK ("scout_history_runs"."status" in ('running', 'stop_requested', 'completed', 'cancelled', 'interrupted')),
	CONSTRAINT "scout_history_run_digest_check" CHECK ("scout_history_runs"."request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "scout_history_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text,
	"name" text DEFAULT 'New conversation' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb DEFAULT '{"messages":[],"state":{}}'::jsonb NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_history_thread_counters_check" CHECK ("scout_history_threads"."sequence" >= 0 and "scout_history_threads"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "scout_history_events" ADD CONSTRAINT "scout_history_events_thread_id_run_id_scout_history_runs_thread_id_id_fk" FOREIGN KEY ("thread_id","run_id") REFERENCES "public"."scout_history_runs"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_history_runs" ADD CONSTRAINT "scout_history_runs_thread_id_scout_history_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."scout_history_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_history_threads" ADD CONSTRAINT "scout_history_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scout_history_run_events_idx" ON "scout_history_events" USING btree ("thread_id","run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "scout_history_one_active_run" ON "scout_history_runs" USING btree ("thread_id") WHERE "scout_history_runs"."status" in ('running', 'stop_requested');--> statement-breakpoint
CREATE INDEX "scout_history_owner_updated_idx" ON "scout_history_threads" USING btree ("owner_user_id","tenant_id","updated_at");