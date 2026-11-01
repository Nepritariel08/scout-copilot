CREATE TABLE "scout_resource_scopes" (
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"tenant_id" text,
	"scope_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_resource_scopes_resource_kind_resource_id_pk" PRIMARY KEY("resource_kind","resource_id"),
	CONSTRAINT "scout_scope_kind_check" CHECK ("scout_resource_scopes"."resource_kind" in ('agent','channel','page')),
	CONSTRAINT "scout_scope_ownership_check" CHECK (("scout_resource_scopes"."scope_kind" = 'tenant' and "scout_resource_scopes"."tenant_id" is not null) or ("scout_resource_scopes"."scope_kind" = 'template' and "scout_resource_scopes"."resource_kind" = 'agent' and "scout_resource_scopes"."tenant_id" is null))
);
--> statement-breakpoint
CREATE TABLE "scout_tenant_instructions" (
	"deployment_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"instructions" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scout_tenant_instructions_deployment_id_tenant_id_user_id_pk" PRIMARY KEY("deployment_id","tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "scout_tenant_instructions" ADD CONSTRAINT "scout_tenant_instructions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scout_scope_tenant_resource" ON "scout_resource_scopes" USING btree ("deployment_id","tenant_id","resource_kind");