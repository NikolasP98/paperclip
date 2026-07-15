import {
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
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueExecutionDecisions } from "./issue_execution_decisions.js";
import { issues } from "./issues.js";
import type { AgentHarnessProposalChange } from "@paperclipai/shared";

export const agentHarnessRevisions = pgTable(
  "agent_harness_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    contentHash: text("content_hash").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    performanceSnapshot: jsonb("performance_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    source: text("source").notNull().default("runtime_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentRevisionUq: uniqueIndex("agent_harness_revisions_agent_revision_uq").on(
      table.agentId,
      table.revisionNumber,
    ),
    agentHashIdx: index("agent_harness_revisions_agent_hash_idx").on(
      table.agentId,
      table.contentHash,
    ),
    companyAgentIdx: index("agent_harness_revisions_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
  }),
);

export const agentLearningSignals = pgTable(
  "agent_learning_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    harnessRevisionId: uuid("harness_revision_id").references(() => agentHarnessRevisions.id, {
      onDelete: "set null",
    }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    decisionId: uuid("decision_id").references(() => issueExecutionDecisions.id, {
      onDelete: "set null",
    }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceKey: text("source_key"),
    signalType: text("signal_type").notNull(),
    outcome: text("outcome").notNull(),
    score: numeric("score", { mode: "number" }),
    maxScore: numeric("max_score", { mode: "number" }),
    body: text("body").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("agent_learning_signals_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    decisionUq: uniqueIndex("agent_learning_signals_decision_uq").on(table.decisionId),
    companyAgentSourceUq: uniqueIndex("agent_learning_signals_company_agent_source_uq").on(
      table.companyId,
      table.agentId,
      table.sourceKey,
    ),
  }),
);

export const agentLearningProposals = pgTable(
  "agent_learning_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    harnessRevisionId: uuid("harness_revision_id").references(() => agentHarnessRevisions.id, {
      onDelete: "set null",
    }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => agentLearningSignals.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    proposalType: text("proposal_type").notNull(),
    rationale: text("rationale").notNull(),
    riskLevel: text("risk_level").notNull().default("medium"),
    confidence: integer("confidence").notNull().default(50),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    validationPlan: jsonb("validation_plan").$type<Record<string, unknown>>().notNull().default({}),
    proposedChanges: jsonb("proposed_changes")
      .$type<AgentHarnessProposalChange | Record<string, never>>()
      .notNull()
      .default({}),
    reviewedByAgentId: uuid("reviewed_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    promotedByAgentId: uuid("promoted_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    promotedByUserId: text("promoted_by_user_id"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: jsonb("resolution").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_learning_proposals_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    signalUq: uniqueIndex("agent_learning_proposals_signal_uq").on(table.signalId),
  }),
);
