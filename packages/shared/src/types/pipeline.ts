import type {
  IssuePipelineEventType,
  IssuePipelineRunStatus,
  PipelineExecutionMode,
  PipelineStepKind,
} from "../constants.js";
import type { IssueOriginKind, IssuePriority } from "../constants.js";
import type { IssueExecutionStagePrincipal } from "./issue.js";

/** Step participant — an agent or a user (user step = HITL gate). Same shape as an execution stage principal. */
export type PipelineStepParticipant = IssueExecutionStagePrincipal;

export interface PipelineStep {
  key: string;
  kind: PipelineStepKind;
  label: string;
  participant: PipelineStepParticipant;
  /** Optional per-step runtime override, compiled into `issues.assigneeAdapterOverrides` for the work step. */
  adapterOverrides?: Record<string, unknown> | null;
  /** Eval-kind steps only: markdown rubric shown to the evaluator. */
  rubric?: string | null;
  /** Eval-kind steps only: score below this bounces the issue back to the return assignee. */
  minScore?: number | null;
  /** Eval-kind steps only: upper bound of the score scale. */
  maxScore?: number | null;
  /** Stage-task mode only: earlier work step to retry when this gate requests changes. */
  onFailStepKey?: string | null;
  /** Stage-task mode only: maximum attempts for the target/gate loop. */
  maxAttempts?: number | null;
}

export interface PipelineTrigger {
  originKinds?: IssueOriginKind[];
  labels?: string[];
  priorities?: IssuePriority[];
}

export interface Pipeline {
  id: string;
  companyId: string;
  /** null = company default pipeline (no project scope). */
  projectId: string | null;
  name: string;
  description: string | null;
  executionMode: PipelineExecutionMode;
  trigger: PipelineTrigger | null;
  steps: PipelineStep[];
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Frozen pipeline configuration used for a run. Edits to the source pipeline cannot change it. */
export interface IssuePipelineSnapshot {
  pipelineId: string;
  name: string;
  description: string | null;
  executionMode: PipelineExecutionMode;
  trigger: PipelineTrigger | null;
  steps: PipelineStep[];
}

export interface IssuePipelineRouteCandidate {
  portfolioId?: string | null;
  projectId?: string | null;
  repository?: string | null;
  scope?: string | null;
  matchedRule?: string | null;
  confidence?: number | null;
  reason?: string | null;
}

/** Immutable routing evidence retained with the run, including unresolved intake fallbacks. */
export interface IssuePipelineRoutingSnapshot {
  repository: string | null;
  originalLabels: string[];
  inferredLabels: string[];
  classifierOutput: Record<string, unknown> | null;
  candidates: IssuePipelineRouteCandidate[];
  selectedPortfolioId: string | null;
  selectedProjectId: string | null;
  confidence: number | null;
  resolution: "rule" | "override" | "intake_fallback" | "unresolved";
  reason: string | null;
  /** Frozen coordinator-owned input needed to replay an asynchronous intake decision. */
  intakeContext?: Record<string, unknown> | null;
}

export interface IssuePipelineRun {
  id: string;
  companyId: string;
  pipelineId: string | null;
  issueId: string;
  executionMode: PipelineExecutionMode;
  status: IssuePipelineRunStatus;
  currentStepKey: string | null;
  sourceOriginKind: IssueOriginKind;
  sourceOriginId: string;
  sourceDeliveryId: string | null;
  pipelineSnapshot: IssuePipelineSnapshot;
  pipelineSnapshotHash: string;
  routingSnapshot: IssuePipelineRoutingSnapshot;
  routingSnapshotHash: string;
  selectedPortfolioId: string | null;
  selectedProjectId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssuePipelineEvent {
  id: string;
  companyId: string;
  pipelineRunId: string;
  sequence: number;
  eventKey: string;
  eventType: IssuePipelineEventType;
  stepKey: string | null;
  attempt: number | null;
  childIssueId: string | null;
  predecessorEventId: string | null;
  participant: PipelineStepParticipant | null;
  heartbeatRunId: string | null;
  harnessRevisionId: string | null;
  resolvedAdapterType: string | null;
  resolvedModel: string | null;
  resolvedProvider: string | null;
  inputSnapshot: Record<string, unknown> | null;
  outputSnapshot: Record<string, unknown> | null;
  decisionSnapshot: Record<string, unknown> | null;
  score: number | null;
  maxScore: number | null;
  occurredAt: Date;
  createdAt: Date;
}
