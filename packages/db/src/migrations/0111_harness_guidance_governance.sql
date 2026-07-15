ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "harness_revision_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "agent_task_sessions"
    ADD CONSTRAINT "agent_task_sessions_harness_revision_id_agent_harness_revisions_id_fk"
    FOREIGN KEY ("harness_revision_id")
    REFERENCES "public"."agent_harness_revisions"("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_harness_revisions_agent_hash_uq";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_harness_revisions_agent_hash_idx"
  ON "agent_harness_revisions" USING btree ("agent_id", "content_hash");
--> statement-breakpoint
ALTER TABLE "agent_learning_signals" ADD COLUMN IF NOT EXISTS "source_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_learning_signals_company_agent_source_uq"
  ON "agent_learning_signals" USING btree ("company_id", "agent_id", "source_key");
--> statement-breakpoint
UPDATE "agent_learning_proposals"
SET
  "status" = 'review_needed',
  "proposal_type" = 'review_needed',
  "proposed_changes" = '{}'::jsonb,
  "updated_at" = now()
WHERE "status" = 'pending' AND "proposal_type" = 'harness_improvement';
