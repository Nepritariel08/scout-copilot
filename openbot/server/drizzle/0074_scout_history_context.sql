CREATE TABLE "scout_history_context" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"revision" integer NOT NULL,
	"dependencies" jsonb NOT NULL,
	CONSTRAINT "scout_history_context_shape" CHECK ("scout_history_context"."version" = 1 and "scout_history_context"."revision" between 0 and 16 and jsonb_typeof("scout_history_context"."dependencies") = 'array' and jsonb_array_length("scout_history_context"."dependencies") = "scout_history_context"."revision")
);
--> statement-breakpoint
ALTER TABLE "scout_history_runs" ADD COLUMN "context_revision" integer;--> statement-breakpoint
ALTER TABLE "scout_history_context" ADD CONSTRAINT "scout_history_context_thread_id_scout_history_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."scout_history_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_history_runs" ADD CONSTRAINT "scout_history_run_context_revision_check" CHECK ("scout_history_runs"."context_revision" is null or "scout_history_runs"."context_revision" between 0 and 16);
--> statement-breakpoint
-- Existing threads deliberately receive no marker: unknown provenance denies.
CREATE FUNCTION "scout_history_context_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A parent DELETE's FK cascade runs after the parent row has disappeared.
    -- Direct child deletion while the parent remains must never permit reset.
    IF EXISTS (SELECT 1 FROM "public"."scout_history_threads" WHERE "id" = OLD.thread_id) THEN
      RAISE EXCEPTION 'Scout history context is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.thread_id IS DISTINCT FROM OLD.thread_id OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.revision <> OLD.revision + 1
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.dependencies) WITH ORDINALITY AS prior_entry(value, entry_index)
      WHERE NEW.dependencies -> (prior_entry.entry_index::integer - 1) IS DISTINCT FROM prior_entry.value
    ) THEN
    RAISE EXCEPTION 'Scout history context is append-only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scout_history_context_append_only" BEFORE UPDATE OR DELETE ON "scout_history_context"
FOR EACH ROW EXECUTE FUNCTION "scout_history_context_append_only"();
--> statement-breakpoint
CREATE FUNCTION "scout_history_context_no_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Scout history context cannot be truncated';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scout_history_context_no_truncate" BEFORE TRUNCATE ON "scout_history_context"
FOR EACH STATEMENT EXECUTE FUNCTION "scout_history_context_no_truncate"();
--> statement-breakpoint
CREATE FUNCTION "scout_history_run_context_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.context_revision IS NOT NULL AND NEW.context_revision IS DISTINCT FROM OLD.context_revision THEN
      RAISE EXCEPTION 'Scout run context provenance is immutable';
    END IF;
  END IF;
  IF NEW.context_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."scout_history_context"
    WHERE "thread_id" = NEW.thread_id AND "revision" >= NEW.context_revision
  ) THEN
    RAISE EXCEPTION 'Scout run context provenance has no dependency prefix';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scout_history_run_context_once" BEFORE INSERT OR UPDATE OF "context_revision" ON "scout_history_runs"
FOR EACH ROW EXECUTE FUNCTION "scout_history_run_context_once"();
