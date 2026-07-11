import type { PipelineStepKind } from "../constants.js";
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
  trigger: PipelineTrigger | null;
  steps: PipelineStep[];
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
