import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { IssuePipelineRoutingSnapshot, IssuePipelineSnapshot, PipelineStepParticipant } from "@paperclipai/shared";
import { agentHarnessRevisions } from "./agent_harnesses.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { pipelines } from "./pipelines.js";
import { portfolios } from "./portfolios.js";
import { projects } from "./projects.js";

/**
 * Durable execution identity for an issue pipeline.
 *
 * Pipeline and routing snapshots are frozen at creation. Services may advance
 * status/currentStepKey, but must never rewrite either snapshot or hash.
 */
export const issuePipelineRuns = pgTable(
  "issue_pipeline_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").references(() => pipelines.id, { onDelete: "set null" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    executionMode: text("execution_mode").notNull().default("inline"),
    status: text("status").notNull().default("pending"),
    currentStepKey: text("current_step_key"),
    sourceOriginKind: text("source_origin_kind").notNull(),
    sourceOriginId: text("source_origin_id").notNull(),
    sourceDeliveryId: text("source_delivery_id"),
    pipelineSnapshot: jsonb("pipeline_snapshot").$type<IssuePipelineSnapshot>().notNull(),
    pipelineSnapshotHash: text("pipeline_snapshot_hash").notNull(),
    routingSnapshot: jsonb("routing_snapshot").$type<IssuePipelineRoutingSnapshot>().notNull(),
    routingSnapshotHash: text("routing_snapshot_hash").notNull(),
    selectedPortfolioId: uuid("selected_portfolio_id").references(() => portfolios.id, {
      onDelete: "set null",
    }),
    selectedProjectId: uuid("selected_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceOriginUq: uniqueIndex("issue_pipeline_runs_source_origin_uq").on(
      table.companyId,
      table.sourceOriginKind,
      table.sourceOriginId,
    ),
    companyIssueIdx: index("issue_pipeline_runs_company_issue_idx").on(table.companyId, table.issueId, table.createdAt),
    companyStatusIdx: index("issue_pipeline_runs_company_status_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    pipelineSnapshotHashIdx: index("issue_pipeline_runs_snapshot_hash_idx").on(table.pipelineSnapshotHash),
    selectedProjectIdx: index("issue_pipeline_runs_selected_project_idx").on(table.companyId, table.selectedProjectId),
  }),
);

/** Append-only facts that reconstruct routing, materialization, retries, and completion. */
export const issuePipelineEvents = pgTable(
  "issue_pipeline_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pipelineRunId: uuid("pipeline_run_id")
      .notNull()
      .references(() => issuePipelineRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    stepKey: text("step_key"),
    attempt: integer("attempt"),
    childIssueId: uuid("child_issue_id").references(() => issues.id, { onDelete: "set null" }),
    predecessorEventId: uuid("predecessor_event_id").references((): AnyPgColumn => issuePipelineEvents.id, {
      onDelete: "set null",
    }),
    participant: jsonb("participant").$type<PipelineStepParticipant>(),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    harnessRevisionId: uuid("harness_revision_id").references(() => agentHarnessRevisions.id, {
      onDelete: "set null",
    }),
    resolvedAdapterType: text("resolved_adapter_type"),
    resolvedModel: text("resolved_model"),
    resolvedProvider: text("resolved_provider"),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>(),
    outputSnapshot: jsonb("output_snapshot").$type<Record<string, unknown>>(),
    decisionSnapshot: jsonb("decision_snapshot").$type<Record<string, unknown>>(),
    score: numeric("score", { mode: "number" }),
    maxScore: numeric("max_score", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSequenceUq: uniqueIndex("issue_pipeline_events_run_sequence_uq").on(table.pipelineRunId, table.sequence),
    runEventKeyUq: uniqueIndex("issue_pipeline_events_run_event_key_uq").on(table.pipelineRunId, table.eventKey),
    runStageAttemptTypeUq: uniqueIndex("issue_pipeline_events_run_stage_attempt_type_uq").on(
      table.pipelineRunId,
      table.stepKey,
      table.attempt,
      table.eventType,
    ),
    companyRunOccurredIdx: index("issue_pipeline_events_company_run_occurred_idx").on(
      table.companyId,
      table.pipelineRunId,
      table.occurredAt,
    ),
    childIssueIdx: index("issue_pipeline_events_child_issue_idx").on(table.childIssueId),
    stageAttemptIdx: index("issue_pipeline_events_stage_attempt_idx").on(
      table.pipelineRunId,
      table.stepKey,
      table.attempt,
    ),
  }),
);
