CREATE TABLE "scout_history_context" (
  "thread_id" text PRIMARY KEY NOT NULL REFERENCES "scout_history_threads"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "revision" integer NOT NULL,
  "dependencies" jsonb NOT NULL,
  CONSTRAINT "scout_history_context_shape" CHECK (
    "version" = 1 AND "revision" BETWEEN 0 AND 16
    AND jsonb_typeof("dependencies") = 'array'
    AND jsonb_array_length("dependencies") = "revision"
  )
);
--> statement-breakpoint
-- Existing threads deliberately receive no marker: unknown provenance denies.
CREATE FUNCTION "scout_history_context_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "scout_history_context_append_only" BEFORE UPDATE ON "scout_history_context"
FOR EACH ROW EXECUTE FUNCTION "scout_history_context_append_only"();
--> statement-breakpoint
ALTER TABLE "scout_history_runs" ADD COLUMN "context_revision" integer;
--> statement-breakpoint
ALTER TABLE "scout_history_runs" ADD CONSTRAINT "scout_history_run_context_revision_check"
  CHECK ("context_revision" IS NULL OR "context_revision" BETWEEN 0 AND 16);
--> statement-breakpoint
CREATE FUNCTION "scout_history_run_context_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.context_revision IS NOT NULL AND NEW.context_revision IS DISTINCT FROM OLD.context_revision THEN
    RAISE EXCEPTION 'Scout run context provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scout_history_run_context_once" BEFORE UPDATE OF "context_revision" ON "scout_history_runs"
FOR EACH ROW EXECUTE FUNCTION "scout_history_run_context_once"();
