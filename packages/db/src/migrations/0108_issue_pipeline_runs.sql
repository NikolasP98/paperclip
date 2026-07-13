ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "execution_mode" text DEFAULT 'inline' NOT NULL;

CREATE TABLE "issue_pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "pipeline_id" uuid REFERENCES "pipelines"("id") ON DELETE set null,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
  "execution_mode" text DEFAULT 'inline' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "current_step_key" text,
  "source_origin_kind" text NOT NULL,
  "source_origin_id" text NOT NULL,
  "source_delivery_id" text,
  "pipeline_snapshot" jsonb NOT NULL,
  "pipeline_snapshot_hash" text NOT NULL,
  "routing_snapshot" jsonb NOT NULL,
  "routing_snapshot_hash" text NOT NULL,
  "selected_portfolio_id" uuid REFERENCES "portfolios"("id") ON DELETE set null,
  "selected_project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "issue_pipeline_runs_source_origin_uq" ON "issue_pipeline_runs" ("company_id", "source_origin_kind", "source_origin_id");
CREATE INDEX "issue_pipeline_runs_company_issue_idx" ON "issue_pipeline_runs" ("company_id", "issue_id", "created_at");
CREATE INDEX "issue_pipeline_runs_company_status_idx" ON "issue_pipeline_runs" ("company_id", "status", "updated_at");
CREATE INDEX "issue_pipeline_runs_snapshot_hash_idx" ON "issue_pipeline_runs" ("pipeline_snapshot_hash");
CREATE INDEX "issue_pipeline_runs_selected_project_idx" ON "issue_pipeline_runs" ("company_id", "selected_project_id");

CREATE TABLE "issue_pipeline_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "pipeline_run_id" uuid NOT NULL REFERENCES "issue_pipeline_runs"("id") ON DELETE cascade,
  "sequence" integer NOT NULL,
  "event_key" text NOT NULL,
  "event_type" text NOT NULL,
  "step_key" text,
  "attempt" integer,
  "child_issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
  "predecessor_event_id" uuid REFERENCES "issue_pipeline_events"("id") ON DELETE set null,
  "participant" jsonb,
  "heartbeat_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE set null,
  "harness_revision_id" uuid REFERENCES "agent_harness_revisions"("id") ON DELETE set null,
  "resolved_adapter_type" text,
  "resolved_model" text,
  "resolved_provider" text,
  "input_snapshot" jsonb,
  "output_snapshot" jsonb,
  "decision_snapshot" jsonb,
  "score" numeric,
  "max_score" numeric,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "issue_pipeline_events_run_sequence_uq" ON "issue_pipeline_events" ("pipeline_run_id", "sequence");
CREATE UNIQUE INDEX "issue_pipeline_events_run_event_key_uq" ON "issue_pipeline_events" ("pipeline_run_id", "event_key");
CREATE UNIQUE INDEX "issue_pipeline_events_run_stage_attempt_type_uq" ON "issue_pipeline_events" ("pipeline_run_id", "step_key", "attempt", "event_type");
CREATE INDEX "issue_pipeline_events_company_run_occurred_idx" ON "issue_pipeline_events" ("company_id", "pipeline_run_id", "occurred_at");
CREATE INDEX "issue_pipeline_events_child_issue_idx" ON "issue_pipeline_events" ("child_issue_id");
CREATE INDEX "issue_pipeline_events_stage_attempt_idx" ON "issue_pipeline_events" ("pipeline_run_id", "step_key", "attempt");
