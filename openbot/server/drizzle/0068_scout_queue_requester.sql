CREATE TABLE "scout_queue_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"binding_fingerprint" text NOT NULL,
	"channel_id" text NOT NULL,
	"source_id" text NOT NULL,
	"request_key" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scout_queue_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"draft_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scout_queue_requests" ADD CONSTRAINT "scout_queue_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_queue_reviews" ADD CONSTRAINT "scout_queue_reviews_request_id_scout_queue_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."scout_queue_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scout_queue_source_unique" ON "scout_queue_requests" USING btree ("owner_user_id","tenant_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scout_queue_request_key_unique" ON "scout_queue_requests" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "scout_queue_owner_updated_idx" ON "scout_queue_requests" USING btree ("owner_user_id","tenant_id","updated_at");