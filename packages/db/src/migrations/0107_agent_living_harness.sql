CREATE TABLE "agent_harness_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "revision_number" integer NOT NULL,
  "content_hash" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "performance_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" text DEFAULT 'runtime_snapshot' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "agent_harness_revisions_agent_revision_uq" ON "agent_harness_revisions" ("agent_id", "revision_number");
CREATE UNIQUE INDEX "agent_harness_revisions_agent_hash_uq" ON "agent_harness_revisions" ("agent_id", "content_hash");
CREATE INDEX "agent_harness_revisions_company_agent_idx" ON "agent_harness_revisions" ("company_id", "agent_id");

ALTER TABLE "agents" ADD COLUMN "current_harness_revision_id" uuid;
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_harness_revision_id_agent_harness_revisions_id_fk" FOREIGN KEY ("current_harness_revision_id") REFERENCES "agent_harness_revisions"("id") ON DELETE set null;

ALTER TABLE "heartbeat_runs" ADD COLUMN "harness_revision_id" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN "resolved_adapter_type" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "resolved_model" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "resolved_provider" text;
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_harness_revision_id_agent_harness_revisions_id_fk" FOREIGN KEY ("harness_revision_id") REFERENCES "agent_harness_revisions"("id") ON DELETE set null;

CREATE TABLE "agent_learning_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "harness_revision_id" uuid REFERENCES "agent_harness_revisions"("id") ON DELETE set null,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
  "decision_id" uuid REFERENCES "issue_execution_decisions"("id") ON DELETE set null,
  "run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE set null,
  "signal_type" text NOT NULL,
  "outcome" text NOT NULL,
  "score" numeric,
  "max_score" numeric,
  "body" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "agent_learning_signals_company_agent_created_idx" ON "agent_learning_signals" ("company_id", "agent_id", "created_at");
CREATE UNIQUE INDEX "agent_learning_signals_decision_uq" ON "agent_learning_signals" ("decision_id");

CREATE TABLE "agent_learning_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "harness_revision_id" uuid REFERENCES "agent_harness_revisions"("id") ON DELETE set null,
  "signal_id" uuid NOT NULL REFERENCES "agent_learning_signals"("id") ON DELETE cascade,
  "status" text DEFAULT 'pending' NOT NULL,
  "proposal_type" text NOT NULL,
  "rationale" text NOT NULL,
  "risk_level" text DEFAULT 'medium' NOT NULL,
  "confidence" integer DEFAULT 50 NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "validation_plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "proposed_changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reviewed_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
  "reviewed_by_user_id" text,
  "reviewed_at" timestamp with time zone,
  "promoted_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
  "promoted_by_user_id" text,
  "promoted_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolution" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "agent_learning_proposals_company_agent_status_idx" ON "agent_learning_proposals" ("company_id", "agent_id", "status");
CREATE UNIQUE INDEX "agent_learning_proposals_signal_uq" ON "agent_learning_proposals" ("signal_id");
