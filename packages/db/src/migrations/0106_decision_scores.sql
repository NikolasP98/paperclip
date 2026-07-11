ALTER TABLE "issue_execution_decisions" ADD COLUMN IF NOT EXISTS "score" numeric;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN IF NOT EXISTS "max_score" numeric;
