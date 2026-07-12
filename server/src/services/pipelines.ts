import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pipelines } from "@paperclipai/db";
import type {
  IssueAssigneeAdapterOverrides,
  IssueExecutionPolicy,
  IssueExecutionStage,
  IssueExecutionStageParticipant,
  IssueExecutionStageType,
  Pipeline,
  PipelineStep,
  PipelineTrigger,
} from "@paperclipai/shared";

type PipelineTableRow = typeof pipelines.$inferSelect;

/** Row shape returned by resolvePipeline — the DB row's jsonb columns cast to their typed shared shapes. */
export type PipelineRow = Pipeline;

function rowToPipeline(row: PipelineTableRow): Pipeline {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    trigger: (row.trigger as PipelineTrigger | null) ?? null,
    steps: (row.steps as unknown as PipelineStep[] | null) ?? [],
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// compilePipeline — pure. Step[0] (work) -> assignee + adapter overrides.
// Steps 1..n -> executionPolicy.stages[]. review/approval map 1:1; eval maps
// to a "review" stage carrying a `meta` block with the rubric/score gate.
//
// WP3 wires `meta` through normalizeIssueExecutionPolicy + IssueExecutionStage
// (it doesn't exist on that type yet) — until then, meta survives on the
// *compiled* policy object returned here but is stripped the moment the
// policy round-trips through normalizeIssueExecutionPolicy (issue create/
// update path), since that function only copies known fields per stage.
// ---------------------------------------------------------------------------

export interface CompiledPipelineEvalMeta {
  kind: "eval";
  minScore: number;
  maxScore: number;
  rubric: string;
}

export interface CompiledPipeline {
  assigneeAgentId: string | null;
  assigneeAdapterOverrides?: IssueAssigneeAdapterOverrides | null;
  executionPolicy: IssueExecutionPolicy | null;
}

export function compilePipeline(pipeline: Pipeline): CompiledPipeline {
  const [workStep, ...gateSteps] = pipeline.steps;

  const assigneeAgentId =
    workStep?.kind === "work" && workStep.participant.type === "agent"
      ? workStep.participant.agentId ?? null
      : null;

  const assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null =
    workStep?.adapterOverrides != null
      ? ({ adapterConfig: workStep.adapterOverrides } as IssueAssigneeAdapterOverrides)
      : null;

  const stages: IssueExecutionStage[] = gateSteps.map((step) => buildCompiledStage(step));

  const executionPolicy: IssueExecutionPolicy | null =
    stages.length > 0 ? { mode: "normal", commentRequired: true, stages } : null;

  return { assigneeAgentId, assigneeAdapterOverrides, executionPolicy };
}

function buildCompiledStage(step: PipelineStep): IssueExecutionStage {
  const participant: IssueExecutionStageParticipant = {
    id: randomUUID(),
    type: step.participant.type,
    agentId: step.participant.type === "agent" ? step.participant.agentId ?? null : null,
    userId: step.participant.type === "user" ? step.participant.userId ?? null : null,
  };
  const type: IssueExecutionStageType = step.kind === "approval" ? "approval" : "review";

  const stage: IssueExecutionStage & { meta?: CompiledPipelineEvalMeta } = {
    id: randomUUID(),
    type,
    approvalsNeeded: 1,
    participants: [participant],
    ...(step.kind === "eval"
      ? {
          meta: {
            kind: "eval",
            minScore: step.minScore ?? 0,
            maxScore: step.maxScore ?? 0,
            rubric: step.rubric ?? "",
          },
        }
      : {}),
  };
  return stage;
}

// ---------------------------------------------------------------------------
// matchTrigger / resolvePipeline
// ---------------------------------------------------------------------------

export interface PipelineTriggerContext {
  originKind?: string;
  labels?: string[];
  priority?: string;
}

/** Every trigger field that is present must match. Empty/absent trigger matches everything. */
export function matchTrigger(trigger: PipelineTrigger | null | undefined, ctx: PipelineTriggerContext): boolean {
  if (!trigger) return true;

  if (trigger.originKinds && trigger.originKinds.length > 0) {
    if (ctx.originKind === undefined) return false;
    if (!trigger.originKinds.some((kind) => kind === ctx.originKind)) return false;
  }

  if (trigger.labels && trigger.labels.length > 0) {
    if (!ctx.labels || ctx.labels.length === 0) return false;
    if (!trigger.labels.some((label) => ctx.labels!.includes(label))) return false;
  }

  if (trigger.priorities && trigger.priorities.length > 0) {
    if (ctx.priority === undefined) return false;
    if (!trigger.priorities.some((priority) => priority === ctx.priority)) return false;
  }

  return true;
}

/** Exported for unit testing the specificity ordering resolvePipeline sorts candidates by. */
export function triggerSpecificity(trigger: PipelineTrigger | null | undefined): number {
  if (!trigger) return 0;
  let specificity = 0;
  if (trigger.originKinds && trigger.originKinds.length > 0) specificity += 1;
  if (trigger.labels && trigger.labels.length > 0) specificity += 1;
  if (trigger.priorities && trigger.priorities.length > 0) specificity += 1;
  return specificity;
}

export interface ResolvePipelineParams extends PipelineTriggerContext {
  companyId: string;
  projectId?: string | null;
}

/**
 * Ranks matching pipeline candidates: project-scoped beats the company-level
 * default (projectId null); within the same scope, more matched trigger
 * fields wins; ties break on lowest sortOrder then earliest createdAt.
 * Exported (pure, no DB) so the ordering rules are unit-testable directly.
 */
export function rankPipelineCandidates(candidates: Pipeline[]): Pipeline[] {
  return [...candidates].sort((a, b) => {
    const aScoped = a.projectId != null ? 1 : 0;
    const bScoped = b.projectId != null ? 1 : 0;
    if (aScoped !== bScoped) return bScoped - aScoped;

    const aSpecificity = triggerSpecificity(a.trigger);
    const bSpecificity = triggerSpecificity(b.trigger);
    if (aSpecificity !== bSpecificity) return bSpecificity - aSpecificity;

    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * Resolution order: see rankPipelineCandidates. Returns null when nothing
 * matches — callers must treat that as "no pipeline" and behave exactly as
 * before pipelines existed.
 */
export async function resolvePipeline(db: Db, params: ResolvePipelineParams): Promise<PipelineRow | null> {
  const projectScope = params.projectId
    ? or(eq(pipelines.projectId, params.projectId), isNull(pipelines.projectId))
    : isNull(pipelines.projectId);

  const rows = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.companyId, params.companyId), isNull(pipelines.archivedAt), projectScope));

  const candidates = rows
    .map(rowToPipeline)
    .filter((pipeline) => matchTrigger(pipeline.trigger, params));
  if (candidates.length === 0) return null;

  return rankPipelineCandidates(candidates)[0]!;
}

/** Explicit pipeline selection by id (e.g. request body `pipelineId`) — company-scoped, archived pipelines excluded. */
export async function getPipelineById(db: Db, companyId: string, pipelineId: string): Promise<PipelineRow | null> {
  const [row] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.companyId, companyId), eq(pipelines.id, pipelineId), isNull(pipelines.archivedAt)))
    .limit(1);
  return row ? rowToPipeline(row) : null;
}

// ---------------------------------------------------------------------------
// applyPipelineToCreateInput
// ---------------------------------------------------------------------------

export interface PipelineApplyTarget {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  assigneeAdapterOverrides?: Record<string, unknown> | null;
  executionPolicy?: Record<string, unknown> | null;
  pipelineId?: string | null;
}

/**
 * Stamps a resolved pipeline onto an issue-create input, pure/additive:
 * assigneeAgentId only fills in when the input has no assignee at all;
 * assigneeAdapterOverrides / executionPolicy only fill in when the input has
 * none — an explicit executionPolicy on the request always wins.
 */
export function applyPipelineToCreateInput<T extends PipelineApplyTarget>(pipeline: Pipeline, input: T): T {
  const compiled = compilePipeline(pipeline);
  const hasAssignee = Boolean(input.assigneeAgentId || input.assigneeUserId);

  // Built as a concretely-typed patch (not T) — T is a generic parameter here,
  // and TS won't let you write to a property typed as T[K] for an opaque T.
  const patch: PipelineApplyTarget = { pipelineId: pipeline.id };
  if (!hasAssignee && compiled.assigneeAgentId) {
    patch.assigneeAgentId = compiled.assigneeAgentId;
  }
  if (!input.assigneeAdapterOverrides && compiled.assigneeAdapterOverrides) {
    patch.assigneeAdapterOverrides = compiled.assigneeAdapterOverrides as unknown as Record<string, unknown>;
  }
  if (!input.executionPolicy && compiled.executionPolicy) {
    patch.executionPolicy = compiled.executionPolicy as unknown as Record<string, unknown>;
  }
  // Safe: the merged shape is a structural subtype of T (T extends PipelineApplyTarget).
  return { ...input, ...patch } as T;
}

// ---------------------------------------------------------------------------
// seedGithubBugsPipeline — idempotent, env-var-driven cutover seed.
// Superseded by SDK/UI pipeline authoring (§2.7/2.8 of the spec); this only
// exists so GITHUB_BUGS_REVIEWER_AGENT_ID / GITHUB_BUGS_APPROVER_USER_ID
// keep working with zero operator action during the pipelines rollout.
// ---------------------------------------------------------------------------

export const GITHUB_BUGS_DEFAULT_PIPELINE_NAME = "github-bugs-default";

export interface SeedGithubBugsPipelineDeps {
  companyId: string;
  projectId?: string;
  agentId: string;
  reviewerAgentId?: string;
  approverUserId?: string;
}

export async function seedGithubBugsPipeline(db: Db, deps: SeedGithubBugsPipelineDeps): Promise<void> {
  const projectScope = deps.projectId ? eq(pipelines.projectId, deps.projectId) : isNull(pipelines.projectId);
  const existing = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(
      and(eq(pipelines.companyId, deps.companyId), eq(pipelines.name, GITHUB_BUGS_DEFAULT_PIPELINE_NAME), projectScope),
    )
    .limit(1);
  if (existing.length > 0) return;

  const steps: PipelineStep[] = [
    { key: "fix", kind: "work", label: "Fix", participant: { type: "agent", agentId: deps.agentId } },
    ...(deps.reviewerAgentId
      ? [
          {
            key: "review",
            kind: "review" as const,
            label: "Review",
            participant: { type: "agent" as const, agentId: deps.reviewerAgentId },
          },
        ]
      : []),
    ...(deps.approverUserId
      ? [
          {
            key: "approve",
            kind: "approval" as const,
            label: "Approval",
            participant: { type: "user" as const, userId: deps.approverUserId },
          },
        ]
      : []),
  ];

  await db.insert(pipelines).values({
    companyId: deps.companyId,
    projectId: deps.projectId ?? null,
    name: GITHUB_BUGS_DEFAULT_PIPELINE_NAME,
    description: "Seeded from GITHUB_BUGS_* env vars",
    trigger: { originKinds: ["github_issue"] },
    steps: steps as unknown as Array<Record<string, unknown>>,
  });
}
