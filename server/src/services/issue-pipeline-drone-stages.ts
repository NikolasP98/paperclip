import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  documentRevisions,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueLabels,
  issuePlanDecompositions,
  issuePipelineEvents,
  issuePipelineRuns,
  issues,
  issueWorkProducts,
  labels,
  projects,
  type Db,
} from '@paperclipai/db';
import { createIssueThreadInteractionSchema, type IssuePipelineRun } from '@paperclipai/shared';
import { documentService } from './documents.js';
import { issueThreadInteractionService } from './issue-thread-interactions.js';
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from './issue-assignment-wakeup.js';
import {
  issuePipelineOrchestrator,
  type CompleteStageTaskTransition,
  type IssuePipelineStageTask,
} from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';
import { issueService } from './issues.js';

export const PORTFOLIO_SPEC_PLANNER_DRONE_ID = 'portfolio-spec-planner-v1' as const;
export const PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID =
  'portfolio-implementation-evaluator-v1' as const;
export const PORTFOLIO_MERGE_READINESS_DRONE_ID = 'portfolio-merge-readiness-v1' as const;
const PIPELINE_DRONE_CONTEXT_KIND = 'issue_pipeline_drone_stage_v1' as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const shaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{40}$/i, 'must be a full 40-character commit SHA');

const issueReferenceSchema = z
  .object({
    source: z.enum(['github', 'paperclip']),
    repository: boundedText(240),
    externalId: boundedText(128),
    title: boundedText(500),
    body: z.string().max(50_000),
    labels: z.array(boundedText(120)).max(64),
  })
  .strict();

const classificationSchema = z
  .object({
    labels: z.array(boundedText(120)).max(32),
    scopes: z.array(boundedText(120)).max(32),
    projectKey: boundedText(120),
    projectGroup: boundedText(120).optional(),
    confidence: z.number().min(0).max(1),
    rationale: boundedText(2_000),
  })
  .strict();

export const plannerDroneInputSchema = z
  .object({
    issue: issueReferenceSchema,
    classification: classificationSchema,
    projectContext: z.string().max(20_000),
    priorFeedback: z
      .array(
        z
          .object({
            author: boundedText(160),
            body: z.string().max(8_000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const plannedSubtaskSchema = z
  .object({
    key: boundedText(80),
    title: boundedText(300),
    description: boundedText(8_000),
    acceptanceCriteria: z.array(boundedText(1_000)).max(20),
    dependsOn: z.array(boundedText(80)).max(20),
  })
  .strict();

export const plannerDroneOutputSchema = z
  .object({
    objective: boundedText(4_000),
    assumptions: z.array(boundedText(1_000)).max(20),
    subtasks: z.array(plannedSubtaskSchema).min(1).max(24),
    risks: z.array(boundedText(1_000)).max(20),
    testPlan: z.array(boundedText(1_000)).max(30),
  })
  .strict()
  .superRefine((output, ctx) => {
    const keys = new Set(output.subtasks.map((task) => task.key));
    if (keys.size !== output.subtasks.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subtasks'],
        message: 'subtask keys must be unique',
      });
    }
    for (const [index, task] of output.subtasks.entries()) {
      for (const dependency of task.dependsOn) {
        if (!keys.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subtasks', index, 'dependsOn'],
            message: `unknown dependency key: ${dependency}`,
          });
        }
        if (dependency === task.key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['subtasks', index, 'dependsOn'],
            message: 'a subtask cannot depend on itself',
          });
        }
      }
    }
  });

const implementationTestResultSchema = z
  .object({
    command: boundedText(500),
    status: z.enum(['passed', 'failed', 'not_run']),
    output: z.string().max(10_000),
  })
  .strict();

const evaluationRubricCriterionSchema = z
  .object({
    key: boundedText(80),
    description: boundedText(2_000),
    weight: z.number().positive().max(10),
  })
  .strict();

export const implementationEvaluatorDroneInputSchema = z
  .object({
    issue: issueReferenceSchema,
    approvedSpec: boundedText(50_000),
    implementation: z
      .object({
        summary: boundedText(10_000),
        changedFiles: z.array(boundedText(500)).max(256),
        diff: z.string().max(120_000),
        testResults: z.array(implementationTestResultSchema).max(40),
      })
      .strict(),
    rubric: z.array(evaluationRubricCriterionSchema).min(1).max(20),
    passingScore: z.number().min(0).max(10),
  })
  .strict();

const evaluationFindingSchema = z
  .object({
    severity: z.enum(['blocker', 'major', 'minor', 'note']),
    title: boundedText(300),
    evidence: boundedText(4_000),
  })
  .strict();

export const implementationEvaluatorDroneOutputSchema = z
  .object({
    score: z.number().min(0).max(10),
    rubricScores: z
      .array(
        z
          .object({
            key: boundedText(80),
            score: z.number().min(0).max(10),
            rationale: boundedText(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    findings: z.array(evaluationFindingSchema).max(30),
    requiredChanges: z.array(boundedText(2_000)).max(30),
    specDelta: z.string().max(10_000).optional(),
    recommendation: z.enum(['approve', 'revise', 'reject']),
    summary: boundedText(4_000),
  })
  .strict();

const mergeCheckSchema = z
  .object({
    name: boundedText(240),
    status: z.enum(['passed', 'failed', 'pending']),
    summary: z.string().max(2_000),
  })
  .strict();

const mergeApprovalSchema = z
  .object({
    gate: boundedText(120),
    status: z.enum(['approved', 'rejected', 'pending']),
    actor: boundedText(160),
  })
  .strict();

export const mergeReadinessDroneInputSchema = z
  .object({
    repository: boundedText(240),
    targetBranch: boundedText(240),
    approvedHeadSha: shaSchema,
    currentHeadSha: shaSchema,
    approvals: z.array(mergeApprovalSchema).min(1).max(20),
    checks: z.array(mergeCheckSchema).min(1).max(50),
  })
  .strict();

export const mergeReadinessDroneOutputSchema = z
  .object({
    ready: z.boolean(),
    blockers: z.array(boundedText(1_000)).max(30),
    risk: z.enum(['low', 'medium', 'high']),
    summary: boundedText(2_000),
  })
  .strict();

const pullRequestMetadataSchema = z
  .object({
    headSha: shaSchema,
    baseRef: boundedText(240),
    baseSha: shaSchema,
    checks: z.array(mergeCheckSchema).min(1).max(50),
  })
  .passthrough();

const implementationEvidenceMetadataSchema = z
  .object({
    summary: boundedText(10_000).optional(),
    changedFiles: z.array(boundedText(500)).max(256).optional(),
    diff: z.string().max(120_000).optional(),
    testResults: z.array(implementationTestResultSchema).max(40).optional(),
  })
  .passthrough();

const IMPLEMENTATION_EVALUATION_RUBRIC = [
  {
    key: 'root-cause-correctness',
    description: 'The implementation fixes the demonstrated root cause without masking it.',
    weight: 2,
  },
  {
    key: 'approved-spec-coverage',
    description:
      'The implementation satisfies the accepted objective and traced plan requirements.',
    weight: 2,
  },
  {
    key: 'regression-protection',
    description: 'Focused automated coverage would fail before the fix and pass after it.',
    weight: 2,
  },
  {
    key: 'verification-evidence',
    description: 'The supplied checks and test results demonstrate the claimed behavior.',
    weight: 2,
  },
  {
    key: 'repository-safety',
    description:
      'The diff is scoped, preserves repository conventions, and avoids unsafe branch actions.',
    weight: 2,
  },
] as const;

const pipelineDroneContextSchema = z
  .object({
    kind: z.literal(PIPELINE_DRONE_CONTEXT_KIND),
    pipelineRunId: z.string().uuid(),
    stageTaskId: z.string().uuid(),
    stageKey: boundedText(64),
    attempt: z.number().int().positive(),
    droneId: z.enum([
      PORTFOLIO_SPEC_PLANNER_DRONE_ID,
      PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID,
      PORTFOLIO_MERGE_READINESS_DRONE_ID,
    ]),
  })
  .strict();

type PipelineHeartbeatRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | 'id'
  | 'companyId'
  | 'agentId'
  | 'status'
  | 'error'
  | 'errorCode'
  | 'resultJson'
  | 'contextSnapshot'
  | 'harnessRevisionId'
  | 'resolvedAdapterType'
  | 'resolvedModel'
  | 'resolvedProvider'
>;

type PlannerOutput = z.infer<typeof plannerDroneOutputSchema>;
type ImplementationEvaluatorInput = z.infer<typeof implementationEvaluatorDroneInputSchema>;
type ImplementationEvaluatorOutput = z.infer<typeof implementationEvaluatorDroneOutputSchema>;
type MergeReadinessInput = z.infer<typeof mergeReadinessDroneInputSchema>;
type MergeReadinessOutput = z.infer<typeof mergeReadinessDroneOutputSchema>;

interface AcceptedPlanHandoff {
  acceptedPlanRevisionId: string;
  objective: string;
  stageDescription: string;
  childIssueSummaries: Array<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
    summary: string;
  }>;
}

const ACCEPTED_PLAN_HANDOFF_START = '<!-- paperclip:accepted-plan-handoff:start -->';
const ACCEPTED_PLAN_HANDOFF_END = '<!-- paperclip:accepted-plan-handoff:end -->';
const ACCEPTED_PLAN_HANDOFF_MAX_CHARS = 32_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hasValidPipelineDroneStageContext(contextSnapshot: unknown): boolean {
  return pipelineDroneContextSchema.safeParse(asRecord(contextSnapshot).pipelineDroneStage).success;
}

function truncate(value: string | null | undefined, max: number): string {
  return Array.from(value ?? '')
    .slice(0, max)
    .join('');
}

function appendAcceptedPlanHandoff(description: string | null, handoff: string): string {
  const current = description?.trim() ?? '';
  const markerStart = current.indexOf(ACCEPTED_PLAN_HANDOFF_START);
  const markerEnd = markerStart < 0 ? -1 : current.indexOf(ACCEPTED_PLAN_HANDOFF_END, markerStart);
  const existingHandoffEnd =
    markerEnd < markerStart ? current.length : markerEnd + ACCEPTED_PLAN_HANDOFF_END.length;
  const withoutExisting =
    markerStart < 0
      ? current
      : [current.slice(0, markerStart), current.slice(existingHandoffEnd)].join('').trim();
  return [withoutExisting || null, handoff].filter(Boolean).join('\n\n');
}

async function buildAcceptedPlanHandoff(
  db: Db,
  run: IssuePipelineRun,
  stageTask: IssuePipelineStageTask,
): Promise<AcceptedPlanHandoff | null> {
  if (stageTask.stageKey !== 'implement') return null;
  const implementIndex = run.pipelineSnapshot.steps.findIndex(
    (step) => step.key === stageTask.stageKey,
  );
  const planIndex = run.pipelineSnapshot.steps.findIndex((step) => step.key === 'plan');
  const approvalIndex = run.pipelineSnapshot.steps.findIndex(
    (step) => step.key === 'plan-approval',
  );
  if (
    planIndex < 0 ||
    approvalIndex < 0 ||
    planIndex >= approvalIndex ||
    approvalIndex >= implementIndex
  ) {
    return null;
  }

  const planEvent = await db
    .select({ outputSnapshot: issuePipelineEvents.outputSnapshot })
    .from(issuePipelineEvents)
    .where(
      and(
        eq(issuePipelineEvents.pipelineRunId, run.id),
        eq(issuePipelineEvents.stepKey, 'plan'),
        eq(issuePipelineEvents.eventType, 'stage_completed'),
      ),
    )
    .orderBy(desc(issuePipelineEvents.sequence))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!planEvent) throw new Error('implementation stage has no completed Plan artifact event');
  const planSnapshot = asRecord(planEvent.outputSnapshot);
  const plan = plannerDroneOutputSchema.parse(planSnapshot.validatedOutput);
  const acceptedPlanRevisionId = z.string().uuid().parse(planSnapshot.planRevisionId);

  const decomposition = await db
    .select({
      status: issuePlanDecompositions.status,
      childIssueIds: issuePlanDecompositions.childIssueIds,
    })
    .from(issuePlanDecompositions)
    .where(
      and(
        eq(issuePlanDecompositions.companyId, run.companyId),
        eq(issuePlanDecompositions.sourceIssueId, run.issueId),
        eq(issuePlanDecompositions.acceptedPlanRevisionId, acceptedPlanRevisionId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!decomposition || decomposition.status !== 'completed') {
    throw new Error('implementation stage has no completed accepted-plan decomposition');
  }
  const childIssueIds = decomposition.childIssueIds.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (childIssueIds.length !== plan.subtasks.length) {
    throw new Error(
      `accepted-plan decomposition has ${childIssueIds.length} children for ${plan.subtasks.length} subtasks`,
    );
  }
  const childRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      priority: issues.priority,
    })
    .from(issues)
    .where(and(eq(issues.companyId, run.companyId), inArray(issues.id, childIssueIds)));
  const childById = new Map(childRows.map((child) => [child.id, child]));
  const children = childIssueIds.map((childIssueId, index) => {
    const child = childById.get(childIssueId);
    if (!child) throw new Error(`accepted-plan child issue not found: ${childIssueId}`);
    return { child, planned: plan.subtasks[index]! };
  });
  const handoffBody = truncate(
    [
      '## Accepted implementation plan',
      '',
      `Accepted plan revision: ${acceptedPlanRevisionId}`,
      '',
      'Objective:',
      plan.objective,
      '',
      'Traceable plan subtasks:',
      ...children.flatMap(({ child, planned }) => [
        '',
        `- ${child.identifier ?? child.id} — ${child.title} (plan key: ${planned.key})`,
        truncate(child.description ?? planned.description, 2_000),
      ]),
      '',
      'Implement the accepted objective across these traced sibling subtasks. Keep the stage task and pull-request evidence linked to the main task; do not re-plan or switch repositories.',
    ].join('\n'),
    ACCEPTED_PLAN_HANDOFF_MAX_CHARS -
      ACCEPTED_PLAN_HANDOFF_START.length -
      ACCEPTED_PLAN_HANDOFF_END.length -
      2,
  );
  const stageDescription = [
    ACCEPTED_PLAN_HANDOFF_START,
    handoffBody,
    ACCEPTED_PLAN_HANDOFF_END,
  ].join('\n');
  return {
    acceptedPlanRevisionId,
    objective: plan.objective,
    stageDescription,
    childIssueSummaries: children.map(({ child, planned }) => ({
      id: child.id,
      identifier: child.identifier,
      title: child.title,
      status: child.status,
      priority: child.priority,
      summary: `Accepted plan key ${planned.key}. ${truncate(child.description ?? planned.description, 1_000)}`,
    })),
  };
}

function validationIssues(error: z.ZodError) {
  return error.issues.slice(0, 12).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message.slice(0, 500),
  }));
}

function heartbeatTrace(run: PipelineHeartbeatRun) {
  return {
    heartbeatRunId: run.id,
    harnessRevisionId: run.harnessRevisionId,
    resolvedAdapterType: run.resolvedAdapterType,
    resolvedModel: run.resolvedModel,
    resolvedProvider: run.resolvedProvider,
  };
}

export function renderPlannerArtifact(output: PlannerOutput): string {
  const list = (values: string[], empty: string) =>
    values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
  return [
    '# Implementation Plan',
    '',
    '## Objective',
    '',
    output.objective,
    '',
    '## Assumptions',
    '',
    list(output.assumptions, 'None.'),
    '',
    '## Subtasks',
    '',
    ...output.subtasks.flatMap((task, index) => [
      `### ${index + 1}. ${task.title}`,
      '',
      `Key: \`${task.key}\``,
      '',
      task.description,
      '',
      'Acceptance criteria:',
      '',
      list(task.acceptanceCriteria, 'No additional criteria.'),
      '',
      `Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.map((key) => `\`${key}\``).join(', ') : 'none'}`,
      '',
    ]),
    '## Risks',
    '',
    list(output.risks, 'No material risks identified.'),
    '',
    '## Test Plan',
    '',
    list(output.testPlan, 'No additional checks proposed.'),
  ].join('\n');
}

async function loadRootIssueReference(db: Db, run: IssuePipelineRun) {
  const root = await db
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      identifier: issues.identifier,
      originKind: issues.originKind,
      originId: issues.originId,
      projectId: issues.projectId,
      goalId: issues.goalId,
      priority: issues.priority,
    })
    .from(issues)
    .where(and(eq(issues.id, run.issueId), eq(issues.companyId, run.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!root) throw new Error(`pipeline root issue not found: ${run.issueId}`);
  const labelRows = await db
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(and(eq(issueLabels.issueId, root.id), eq(issueLabels.companyId, run.companyId)))
    .orderBy(asc(labels.name));
  const repository = run.routingSnapshot.repository?.trim();
  if (!repository)
    throw new Error('pipeline routing snapshot is missing the authoritative repository');
  return {
    root,
    reference: issueReferenceSchema.parse({
      source: root.originKind === 'github_issue' ? 'github' : 'paperclip',
      repository,
      externalId: truncate(root.originId ?? root.identifier ?? root.id, 128),
      title: truncate(root.title, 500),
      body: truncate(root.description, 50_000),
      labels: labelRows.map((row) => truncate(row.name, 120)).slice(0, 64),
    }),
  };
}

async function buildPlannerInput(db: Db, run: IssuePipelineRun) {
  const { root, reference } = await loadRootIssueReference(db, run);
  const classification = classificationSchema.parse(run.routingSnapshot.classifierOutput);
  const project = root.projectId
    ? await db
        .select({
          name: projects.name,
          description: projects.description,
          metadata: projects.metadata,
        })
        .from(projects)
        .where(and(eq(projects.id, root.projectId), eq(projects.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  if (!project) throw new Error('pipeline planner requires a selected project');

  const [comments, failedPlanGates] = await Promise.all([
    db
      .select({
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
      })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, root.id), eq(issueComments.companyId, run.companyId)))
      .orderBy(desc(issueComments.createdAt))
      .limit(20),
    db
      .select({ outputSnapshot: issuePipelineEvents.outputSnapshot })
      .from(issuePipelineEvents)
      .where(
        and(
          eq(issuePipelineEvents.pipelineRunId, run.id),
          eq(issuePipelineEvents.stepKey, 'plan-approval'),
          eq(issuePipelineEvents.eventType, 'stage_failed'),
        ),
      )
      .orderBy(desc(issuePipelineEvents.sequence))
      .limit(20),
  ]);
  const priorFeedback = [
    ...failedPlanGates.map((event) => ({
      author: 'pipeline:plan-approval',
      body: truncate(String(asRecord(event.outputSnapshot).summary ?? ''), 8_000),
    })),
    ...comments.map((comment) => ({
      author: truncate(
        comment.authorUserId
          ? `user:${comment.authorUserId}`
          : comment.authorAgentId
            ? `agent:${comment.authorAgentId}`
            : 'system',
        160,
      ),
      body: truncate(comment.body, 8_000),
    })),
  ]
    .filter((feedback) => feedback.body.trim().length > 0)
    .slice(0, 20);

  return plannerDroneInputSchema.parse({
    issue: reference,
    classification,
    projectContext: truncate(
      JSON.stringify({
        project: {
          name: project.name,
          description: project.description,
          metadata: project.metadata,
        },
        route: {
          resolution: run.routingSnapshot.resolution,
          reason: run.routingSnapshot.reason,
          selectedProjectId: run.selectedProjectId,
        },
      }),
      20_000,
    ),
    priorFeedback,
  });
}

function readPullRequestMetadata(metadata: unknown) {
  return pullRequestMetadataSchema.parse(metadata);
}

async function loadAcceptedPlanSpec(db: Db, run: IssuePipelineRun) {
  const planEvent = await db
    .select({ outputSnapshot: issuePipelineEvents.outputSnapshot })
    .from(issuePipelineEvents)
    .where(
      and(
        eq(issuePipelineEvents.pipelineRunId, run.id),
        eq(issuePipelineEvents.stepKey, 'plan'),
        eq(issuePipelineEvents.eventType, 'stage_completed'),
      ),
    )
    .orderBy(desc(issuePipelineEvents.sequence))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!planEvent) throw new Error('implementation evaluation requires a completed Plan artifact');
  const planSnapshot = asRecord(planEvent.outputSnapshot);
  plannerDroneOutputSchema.parse(planSnapshot.validatedOutput);
  const planRevisionId = z.string().uuid().parse(planSnapshot.planRevisionId);
  const revision = await db
    .select({ body: documentRevisions.body })
    .from(documentRevisions)
    .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
    .where(
      and(
        eq(documentRevisions.id, planRevisionId),
        eq(issueDocuments.issueId, run.issueId),
        eq(issueDocuments.key, 'plan'),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!revision)
    throw new Error('accepted Plan revision is not attached to the pipeline root issue');
  return { planRevisionId, body: boundedText(50_000).parse(revision.body) };
}

async function loadPrimaryPullRequestEvidence(
  db: Db,
  run: IssuePipelineRun,
  reviewableStatuses: readonly string[] = ['ready_for_review', 'approved'],
) {
  const stageIssues = await db
    .select({ id: issues.id, originFingerprint: issues.originFingerprint })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, run.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, run.id),
      ),
    );
  const implementTasks = stageIssues
    .map((row) => ({ row, match: /^implement:(\d+)$/.exec(row.originFingerprint ?? '') }))
    .filter((entry): entry is { row: (typeof stageIssues)[number]; match: RegExpExecArray } =>
      Boolean(entry.match),
    )
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
  const latestImplementIssueId = implementTasks[0]?.row.id;
  if (!latestImplementIssueId)
    throw new Error('pipeline review requires a materialized implementation stage');
  const candidateIssueIds = [latestImplementIssueId, run.issueId];
  const products = await db
    .select()
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, run.companyId),
        inArray(issueWorkProducts.issueId, candidateIssueIds),
        eq(issueWorkProducts.type, 'pull_request'),
        eq(issueWorkProducts.provider, 'github'),
        eq(issueWorkProducts.isPrimary, true),
      ),
    );
  if (products.length !== 1) {
    throw new Error(
      `pipeline review requires exactly one primary GitHub pull_request work product; found ${products.length}`,
    );
  }
  const product = products[0]!;
  if (!reviewableStatuses.includes(product.status)) {
    throw new Error(
      `primary GitHub pull_request work product is not reviewable: ${product.status}`,
    );
  }
  const metadata = readPullRequestMetadata(product.metadata);
  return {
    product,
    metadata,
    frozen: {
      workProductId: product.id,
      externalId: product.externalId,
      url: product.url,
      headSha: metadata.headSha,
      baseRef: metadata.baseRef,
      baseSha: metadata.baseSha,
      checks: metadata.checks,
    },
  };
}

function implementationEvidenceFromProduct(
  evidence: Awaited<ReturnType<typeof loadPrimaryPullRequestEvidence>>,
) {
  const metadata = asRecord(evidence.product.metadata);
  const nested = implementationEvidenceMetadataSchema.parse(asRecord(metadata.implementation));
  const topLevel = implementationEvidenceMetadataSchema.parse(metadata);
  const checksAsTests = evidence.metadata.checks.map((check) => ({
    command: check.name,
    status:
      check.status === 'passed'
        ? ('passed' as const)
        : check.status === 'failed'
          ? ('failed' as const)
          : ('not_run' as const),
    output: check.summary,
  }));
  return {
    summary:
      nested.summary ??
      topLevel.summary ??
      truncate(evidence.product.summary ?? evidence.product.title, 10_000),
    changedFiles: nested.changedFiles ?? topLevel.changedFiles ?? [],
    diff: nested.diff ?? topLevel.diff ?? '',
    testResults: nested.testResults ?? topLevel.testResults ?? checksAsTests,
  };
}

async function buildImplementationEvaluatorInput(
  db: Db,
  run: IssuePipelineRun,
): Promise<ImplementationEvaluatorInput> {
  const step = run.pipelineSnapshot.steps.find((candidate) => candidate.key === 'evaluate');
  if (!step || step.kind !== 'eval') {
    throw new Error('implementation evaluator requires the frozen Evaluate pipeline step');
  }
  const passingScore = step.minScore;
  if (typeof passingScore !== 'number' || passingScore < 0 || passingScore > 10) {
    throw new Error('implementation evaluator requires a passing score between 0 and 10');
  }
  const [{ reference }, acceptedPlan, pullRequest] = await Promise.all([
    loadRootIssueReference(db, run),
    loadAcceptedPlanSpec(db, run),
    loadPrimaryPullRequestEvidence(db, run, ['draft', 'ready_for_review', 'approved']),
  ]);
  return implementationEvaluatorDroneInputSchema.parse({
    issue: reference,
    approvedSpec: acceptedPlan.body,
    implementation: implementationEvidenceFromProduct(pullRequest),
    rubric: IMPLEMENTATION_EVALUATION_RUBRIC,
    passingScore,
  });
}

async function loadReleaseApprovalEvidence(db: Db, run: IssuePipelineRun) {
  const event = await db
    .select({
      id: issuePipelineEvents.id,
      decisionSnapshot: issuePipelineEvents.decisionSnapshot,
      outputSnapshot: issuePipelineEvents.outputSnapshot,
    })
    .from(issuePipelineEvents)
    .where(
      and(
        eq(issuePipelineEvents.pipelineRunId, run.id),
        eq(issuePipelineEvents.stepKey, 'release-approval'),
        eq(issuePipelineEvents.eventType, 'stage_completed'),
      ),
    )
    .orderBy(desc(issuePipelineEvents.sequence))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!event) throw new Error('merge readiness requires a terminal release-approval event');
  const decision = asRecord(event.decisionSnapshot);
  const pullRequest = pullRequestMetadataSchema.parse(decision.pullRequest);
  const actor = boundedText(160).parse(decision.actor);
  const workProductId = z.string().uuid().parse(decision.workProductId);
  if (decision.outcome !== 'approved') throw new Error('release-approval event is not approved');
  return { eventId: event.id, actor, pullRequest, workProductId };
}

async function buildMergeReadinessInput(
  db: Db,
  run: IssuePipelineRun,
): Promise<MergeReadinessInput> {
  const [{ reference }, current, approval] = await Promise.all([
    loadRootIssueReference(db, run),
    loadPrimaryPullRequestEvidence(db, run),
    loadReleaseApprovalEvidence(db, run),
  ]);
  if (approval.workProductId !== current.product.id) {
    throw new Error('approved pull request work product is not the current primary work product');
  }
  if (
    approval.pullRequest.baseRef !== current.metadata.baseRef ||
    approval.pullRequest.baseSha !== current.metadata.baseSha
  ) {
    throw new Error(
      'approved pull request target evidence no longer matches the current primary work product',
    );
  }
  return mergeReadinessDroneInputSchema.parse({
    repository: reference.repository,
    targetBranch: approval.pullRequest.baseRef,
    approvedHeadSha: approval.pullRequest.headSha,
    currentHeadSha: current.metadata.headSha,
    approvals: [{ gate: 'release-approval', status: 'approved', actor: approval.actor }],
    checks: current.metadata.checks,
  });
}

async function buildStageDroneContext(
  db: Db,
  run: IssuePipelineRun,
  stageTask: IssuePipelineStageTask,
) {
  if (stageTask.stageKey === 'plan') {
    return {
      droneId: PORTFOLIO_SPEC_PLANNER_DRONE_ID,
      input: await buildPlannerInput(db, run),
    } as const;
  }
  if (stageTask.stageKey === 'evaluate') {
    return {
      droneId: PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID,
      input: await buildImplementationEvaluatorInput(db, run),
    } as const;
  }
  if (stageTask.stageKey === 'merge-readiness') {
    return {
      droneId: PORTFOLIO_MERGE_READINESS_DRONE_ID,
      input: await buildMergeReadinessInput(db, run),
    } as const;
  }
  return null;
}

export async function queuePipelineStageTaskWakeup(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  run: IssuePipelineRun;
  stageTask: IssuePipelineStageTask;
  requestedByActorType?: 'user' | 'agent' | 'system';
  requestedByActorId?: string | null;
}) {
  let issue = await issueService(input.db).getById(input.stageTask.issueId);
  if (!issue) throw new Error(`pipeline stage issue not found: ${input.stageTask.issueId}`);
  const acceptedPlanHandoff = await buildAcceptedPlanHandoff(input.db, input.run, input.stageTask);
  if (acceptedPlanHandoff) {
    const description = appendAcceptedPlanHandoff(
      issue.description,
      acceptedPlanHandoff.stageDescription,
    );
    if (description !== issue.description) {
      issue = await issueService(input.db).update(issue.id, { description });
      if (!issue) throw new Error(`pipeline stage issue disappeared: ${input.stageTask.issueId}`);
    }
  }
  const step = input.run.pipelineSnapshot.steps.find(
    (candidate) => candidate.key === input.stageTask.stageKey,
  );
  const participantAgentId = step?.participant.type === 'agent' ? step.participant.agentId : null;
  const participantAgent = participantAgentId
    ? await input.db
        .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.id, participantAgentId), eq(agents.companyId, input.run.companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const configuredDroneId = asRecord(participantAgent?.adapterConfig).droneId;
  const isBoundedDrone =
    participantAgent?.adapterType === 'minion_drone' &&
    (configuredDroneId === PORTFOLIO_SPEC_PLANNER_DRONE_ID ||
      configuredDroneId === PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID ||
      configuredDroneId === PORTFOLIO_MERGE_READINESS_DRONE_ID);
  if (!isBoundedDrone) {
    return queueIssueAssignmentWakeup({
      heartbeat: input.heartbeat,
      issue,
      reason: 'pipeline_stage_materialized',
      mutation: 'pipeline_stage_advance',
      contextSource: 'issue.pipeline_stage_traversal',
      requestedByActorType: input.requestedByActorType ?? 'system',
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: acceptedPlanHandoff
        ? {
            acceptedPlanRevisionId: acceptedPlanHandoff.acceptedPlanRevisionId,
            acceptedPlanObjective: acceptedPlanHandoff.objective,
            childIssueSummaries: acceptedPlanHandoff.childIssueSummaries,
          }
        : undefined,
    });
  }
  const drone = await buildStageDroneContext(input.db, input.run, input.stageTask);
  if (!drone) {
    throw new Error(
      `bounded Drone ${String(configuredDroneId)} is not valid for stage ${input.stageTask.stageKey}`,
    );
  }
  if (drone.droneId !== configuredDroneId) {
    throw new Error(
      `stage ${input.stageTask.stageKey} requires ${drone.droneId}, not ${String(configuredDroneId)}`,
    );
  }
  return queueIssueAssignmentWakeup({
    heartbeat: input.heartbeat,
    issue,
    reason: 'pipeline_stage_materialized',
    mutation: 'pipeline_stage_advance',
    contextSource: 'issue.pipeline_drone_stage',
    requestedByActorType: input.requestedByActorType ?? 'system',
    requestedByActorId: input.requestedByActorId ?? null,
    idempotencyKey: `pipeline-drone:${input.run.id}:${input.stageTask.issueId}`,
    contextSnapshot: {
      paperclipDrone: { input: drone.input },
      pipelineDroneStage: {
        kind: PIPELINE_DRONE_CONTEXT_KIND,
        pipelineRunId: input.run.id,
        stageTaskId: input.stageTask.issueId,
        stageKey: input.stageTask.stageKey,
        attempt: input.stageTask.attempt,
        droneId: drone.droneId,
      },
    },
    rethrowOnError: true,
  });
}

async function persistPlannerArtifact(
  db: Db,
  input: {
    run: IssuePipelineRun;
    heartbeat: PipelineHeartbeatRun;
    output: PlannerOutput;
  },
) {
  const existingRevision = await db
    .select({ id: documentRevisions.id })
    .from(documentRevisions)
    .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
    .where(
      and(
        eq(issueDocuments.issueId, input.run.issueId),
        eq(issueDocuments.key, 'plan'),
        eq(documentRevisions.createdByRunId, input.heartbeat.id),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingRevision) {
    const current = await documentService(db).getIssueDocumentByKey(input.run.issueId, 'plan');
    if (!current) throw new Error('planner revision exists without its plan document');
    return current;
  }
  const documents = documentService(db);
  const current = await documents.getIssueDocumentByKey(input.run.issueId, 'plan');
  try {
    const result = await documents.upsertIssueDocument({
      issueId: input.run.issueId,
      key: 'plan',
      title: 'Implementation Plan',
      format: 'markdown',
      body: renderPlannerArtifact(input.output),
      changeSummary: `Planner pipeline stage ${input.heartbeat.id}`,
      baseRevisionId: current?.latestRevisionId ?? null,
      createdByAgentId: input.heartbeat.agentId,
      createdByRunId: input.heartbeat.id,
    });
    return result.document;
  } catch (error) {
    const replayRevision = await db
      .select({ id: documentRevisions.id })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .where(
        and(
          eq(issueDocuments.issueId, input.run.issueId),
          eq(issueDocuments.key, 'plan'),
          eq(documentRevisions.createdByRunId, input.heartbeat.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!replayRevision) throw error;
    const replay = await documents.getIssueDocumentByKey(input.run.issueId, 'plan');
    if (!replay) throw error;
    return replay;
  }
}

export function mergeEvidenceReady(input: MergeReadinessInput): boolean {
  return (
    input.approvedHeadSha === input.currentHeadSha &&
    input.approvals.every((approval) => approval.status === 'approved') &&
    input.checks.length > 0 &&
    input.checks.every((check) => check.status === 'passed')
  );
}

export function validateMergeReadinessDecision(
  input: MergeReadinessInput,
  output: MergeReadinessOutput,
) {
  const expectedReady = mergeEvidenceReady(input);
  if (output.ready !== expectedReady) {
    throw new Error(
      `merge-readiness output contradicted frozen evidence (expected ready=${expectedReady})`,
    );
  }
  if (output.ready && output.blockers.length > 0) {
    throw new Error('ready merge-readiness output cannot contain blockers');
  }
  if (!output.ready && output.blockers.length === 0) {
    throw new Error('non-ready merge-readiness output must contain at least one blocker');
  }
  return expectedReady;
}

export function validateImplementationEvaluationDecision(
  input: ImplementationEvaluatorInput,
  output: ImplementationEvaluatorOutput,
) {
  const expectedKeys = new Set(input.rubric.map((criterion) => criterion.key));
  const observedKeys = output.rubricScores.map((criterion) => criterion.key);
  if (new Set(observedKeys).size !== observedKeys.length) {
    throw new Error('implementation evaluation returned duplicate rubric keys');
  }
  const missing = [...expectedKeys].filter((key) => !observedKeys.includes(key));
  const unknown = observedKeys.filter((key) => !expectedKeys.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `implementation evaluation rubric keys do not match frozen input (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
    );
  }
  return output.score >= input.passingScore;
}

const EVALUATOR_FEEDBACK_START = '<!-- paperclip:evaluator-feedback:start -->';
const EVALUATOR_FEEDBACK_END = '<!-- paperclip:evaluator-feedback:end -->';

async function attachEvaluatorFeedbackToRetry(input: {
  db: Db;
  stageTask: IssuePipelineStageTask;
  output: ImplementationEvaluatorOutput;
  passingScore: number;
}) {
  if (input.stageTask.stageKey !== 'implement') return;
  const issue = await issueService(input.db).getById(input.stageTask.issueId);
  if (!issue) throw new Error(`implementation retry issue not found: ${input.stageTask.issueId}`);
  const findings = input.output.findings.map(
    (finding) => `- [${finding.severity}] ${finding.title}: ${finding.evidence}`,
  );
  const requiredChanges = input.output.requiredChanges.map((change) => `- ${change}`);
  const feedback = truncate(
    [
      EVALUATOR_FEEDBACK_START,
      '## Evaluator feedback for this retry',
      '',
      `Score: ${input.output.score}/10 (passing: ${input.passingScore}/10)`,
      `Recommendation: ${input.output.recommendation}`,
      '',
      input.output.summary,
      '',
      'Findings:',
      ...(findings.length > 0 ? findings : ['- No detailed findings supplied.']),
      '',
      'Required changes:',
      ...(requiredChanges.length > 0 ? requiredChanges : ['- Address the scored rubric gaps.']),
      ...(input.output.specDelta
        ? ['', 'Spec delta for this iteration:', input.output.specDelta]
        : []),
      EVALUATOR_FEEDBACK_END,
    ].join('\n'),
    24_000,
  );
  const description = [issue.description?.trim() || null, feedback].filter(Boolean).join('\n\n');
  await issueService(input.db).update(issue.id, { description });
}

async function listStageHeartbeatRuns(db: Db, companyId: string, stageTaskId: string) {
  const rows = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [
          'queued',
          'scheduled_retry',
          'running',
          'succeeded',
          'failed',
          'cancelled',
          'timed_out',
        ]),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt));
  return rows.filter((run) => {
    const context = asRecord(run.contextSnapshot);
    return context.issueId === stageTaskId || context.taskId === stageTaskId;
  });
}

async function blockDroneStage(input: {
  db: Db;
  run: IssuePipelineRun;
  stageTask: IssuePipelineStageTask;
  heartbeat: PipelineHeartbeatRun | null;
  summary: string;
  inputSnapshot: Record<string, unknown> | null;
  outputSnapshot: Record<string, unknown>;
}) {
  const stageIssue = await issueService(input.db).getById(input.stageTask.issueId);
  if (stageIssue && stageIssue.status !== 'blocked' && stageIssue.status !== 'cancelled') {
    await issueService(input.db).update(stageIssue.id, { status: 'blocked' });
  }
  return issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db)).completeStageTask(
    {
      runId: input.run.id,
      stageTaskId: input.stageTask.issueId,
      terminalStatus: 'blocked',
      summary: input.summary,
      trace: {
        ...(input.heartbeat ? heartbeatTrace(input.heartbeat) : {}),
        inputSnapshot: input.inputSnapshot,
        outputSnapshot: input.outputSnapshot,
      },
    },
  );
}

export async function blockPipelineDroneDispatchFailure(input: {
  db: Db;
  run: IssuePipelineRun;
  stageTask: IssuePipelineStageTask;
  error: unknown;
}) {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return blockDroneStage({
    ...input,
    heartbeat: null,
    summary: `Unable to build immutable ${input.stageTask.stageKey} Drone input: ${message}`,
    inputSnapshot: null,
    outputSnapshot: { dispatchStatus: 'blocked', error: truncate(message, 2_000) },
  });
}

async function queueTransitionStage(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  run: IssuePipelineRun;
  transition: CompleteStageTaskTransition;
}) {
  if (!input.transition.claimed || !input.transition.nextStageTask) return;
  try {
    await queuePipelineStageTaskWakeup({
      db: input.db,
      heartbeat: input.heartbeat,
      run: input.run,
      stageTask: input.transition.nextStageTask,
    });
  } catch (error) {
    await blockPipelineDroneDispatchFailure({
      db: input.db,
      run: input.run,
      stageTask: input.transition.nextStageTask,
      error,
    });
  }
}

/** Finalizes one attributed Plan, Evaluate, or Merge-readiness heartbeat. Replays are idempotent. */
export async function finalizePipelineDroneHeartbeat(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  run: PipelineHeartbeatRun;
}) {
  const context = pipelineDroneContextSchema.safeParse(
    asRecord(input.run.contextSnapshot).pipelineDroneStage,
  );
  if (!context.success) return { handled: false as const };
  const pipelineRun = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(
        eq(issuePipelineRuns.id, context.data.pipelineRunId),
        eq(issuePipelineRuns.companyId, input.run.companyId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!pipelineRun) throw new Error(`pipeline run not found: ${context.data.pipelineRunId}`);
  const run = pipelineRun as IssuePipelineRun;
  const stageTask = (
    await issuePipelineOrchestratorRepository(input.db).listStageTasks(run.id)
  ).find((task) => task.issueId === context.data.stageTaskId);
  if (
    !stageTask ||
    stageTask.stageKey !== context.data.stageKey ||
    stageTask.attempt !== context.data.attempt
  ) {
    throw new Error('attributed pipeline Drone stage task does not match its frozen context');
  }
  const existingTerminalEvent = await input.db
    .select({ id: issuePipelineEvents.id })
    .from(issuePipelineEvents)
    .where(
      and(
        eq(issuePipelineEvents.pipelineRunId, run.id),
        eq(issuePipelineEvents.eventKey, `stage-terminal:${stageTask.issueId}`),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existingTerminalEvent) {
    return { handled: true as const, status: 'reconciled' as const, run };
  }
  const step = run.pipelineSnapshot.steps.find((candidate) => candidate.key === stageTask.stageKey);
  if (
    !step ||
    step.participant.type !== 'agent' ||
    step.participant.agentId !== input.run.agentId
  ) {
    throw new Error('pipeline Drone heartbeat agent does not match the frozen stage participant');
  }
  const agent = await input.db
    .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, input.run.agentId), eq(agents.companyId, run.companyId)))
    .then((rows) => rows[0] ?? null);
  if (
    agent?.adapterType !== 'minion_drone' ||
    asRecord(agent.adapterConfig).droneId !== context.data.droneId
  ) {
    throw new Error(`pipeline Drone agent is not configured for ${context.data.droneId}`);
  }
  const frozenInput = asRecord(asRecord(input.run.contextSnapshot).paperclipDrone).input;

  if (input.run.status !== 'succeeded') {
    const runs = await listStageHeartbeatRuns(input.db, run.companyId, stageTask.issueId);
    const activeRetry = runs.some(
      (candidate) =>
        candidate.id !== input.run.id &&
        ['queued', 'scheduled_retry', 'running'].includes(candidate.status),
    );
    if (activeRetry) return { handled: true as const, status: 'retry_pending' as const, run };
    const blocked = await blockDroneStage({
      db: input.db,
      run,
      stageTask,
      heartbeat: input.run,
      summary: `${stageTask.stageKey} Drone heartbeat failed: ${input.run.error ?? input.run.errorCode ?? input.run.status}`,
      inputSnapshot: asRecord(frozenInput),
      outputSnapshot: {
        finalizationStatus: 'heartbeat_failed',
        errorCode: input.run.errorCode ?? null,
        error: truncate(input.run.error, 2_000) || null,
      },
    });
    return { handled: true as const, status: 'blocked' as const, run: blocked };
  }

  const result = asRecord(input.run.resultJson);
  if (result.droneId !== context.data.droneId) {
    const blocked = await blockDroneStage({
      db: input.db,
      run,
      stageTask,
      heartbeat: input.run,
      summary: `Heartbeat did not execute frozen Drone ${context.data.droneId}`,
      inputSnapshot: asRecord(frozenInput),
      outputSnapshot: { finalizationStatus: 'wrong_drone', actualDroneId: result.droneId ?? null },
    });
    return { handled: true as const, status: 'blocked' as const, run: blocked };
  }

  let transition: CompleteStageTaskTransition = { claimed: false, nextStageTask: null };
  if (context.data.droneId === PORTFOLIO_SPEC_PLANNER_DRONE_ID) {
    const parsedInput = plannerDroneInputSchema.safeParse(frozenInput);
    const parsedOutput = plannerDroneOutputSchema.safeParse(result.output);
    if (!parsedInput.success || !parsedOutput.success) {
      const blocked = await blockDroneStage({
        db: input.db,
        run,
        stageTask,
        heartbeat: input.run,
        summary: 'Planner Drone returned output outside the strict plan contract',
        inputSnapshot: asRecord(frozenInput),
        outputSnapshot: {
          finalizationStatus: 'invalid',
          inputIssues: parsedInput.success ? [] : validationIssues(parsedInput.error),
          outputIssues: parsedOutput.success ? [] : validationIssues(parsedOutput.error),
        },
      });
      return { handled: true as const, status: 'blocked' as const, run: blocked };
    }
    let artifact: Awaited<ReturnType<typeof persistPlannerArtifact>>;
    try {
      artifact = await persistPlannerArtifact(input.db, {
        run,
        heartbeat: input.run,
        output: parsedOutput.data,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = await blockDroneStage({
        db: input.db,
        run,
        stageTask,
        heartbeat: input.run,
        summary: `Planner output was valid but its plan artifact could not be persisted: ${message}`,
        inputSnapshot: parsedInput.data,
        outputSnapshot: {
          finalizationStatus: 'artifact_persistence_failed',
          validationStatus: 'valid',
          error: truncate(message, 2_000),
        },
      });
      return { handled: true as const, status: 'blocked' as const, run: blocked };
    }
    const stageIssue = await issueService(input.db).getById(stageTask.issueId);
    if (stageIssue && stageIssue.status !== 'done')
      await issueService(input.db).update(stageIssue.id, { status: 'done' });
    const completed = await issuePipelineOrchestrator(
      issuePipelineOrchestratorRepository(input.db),
    ).completeStageTask(
      {
        runId: run.id,
        stageTaskId: stageTask.issueId,
        terminalStatus: 'done',
        outcome: 'passed',
        summary: parsedOutput.data.objective,
        trace: {
          ...heartbeatTrace(input.run),
          inputSnapshot: parsedInput.data,
          outputSnapshot: {
            finalizationStatus: 'validated',
            validatedOutput: parsedOutput.data,
            planDocumentId: artifact.id,
            planRevisionId: artifact.latestRevisionId,
          },
        },
      },
      (observed) => {
        transition = observed;
      },
    );
    await queueTransitionStage({
      db: input.db,
      heartbeat: input.heartbeat,
      run: completed,
      transition,
    });
    return { handled: true as const, status: 'completed' as const, run: completed, transition };
  }

  if (context.data.droneId === PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID) {
    const parsedInput = implementationEvaluatorDroneInputSchema.safeParse(frozenInput);
    const parsedOutput = implementationEvaluatorDroneOutputSchema.safeParse(result.output);
    let decisionError: string | null = null;
    let passed = false;
    if (parsedInput.success && parsedOutput.success) {
      try {
        passed = validateImplementationEvaluationDecision(parsedInput.data, parsedOutput.data);
      } catch (error) {
        decisionError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!parsedInput.success || !parsedOutput.success || decisionError) {
      const blocked = await blockDroneStage({
        db: input.db,
        run,
        stageTask,
        heartbeat: input.run,
        summary:
          decisionError ??
          'Implementation evaluator Drone returned output outside the strict score contract',
        inputSnapshot: asRecord(frozenInput),
        outputSnapshot: {
          finalizationStatus: 'invalid',
          inputIssues: parsedInput.success ? [] : validationIssues(parsedInput.error),
          outputIssues: parsedOutput.success ? [] : validationIssues(parsedOutput.error),
          decisionError,
        },
      });
      return { handled: true as const, status: 'blocked' as const, run: blocked };
    }
    const stageIssue = await issueService(input.db).getById(stageTask.issueId);
    if (stageIssue && stageIssue.status !== 'done') {
      await issueService(input.db).update(stageIssue.id, { status: 'done' });
    }
    const completed = await issuePipelineOrchestrator(
      issuePipelineOrchestratorRepository(input.db),
    ).completeStageTask(
      {
        runId: run.id,
        stageTaskId: stageTask.issueId,
        terminalStatus: 'done',
        outcome: passed ? 'passed' : 'failed',
        score: parsedOutput.data.score,
        maxScore: 10,
        summary: parsedOutput.data.summary,
        trace: {
          ...heartbeatTrace(input.run),
          inputSnapshot: parsedInput.data,
          outputSnapshot: {
            finalizationStatus: passed ? 'passed' : 'changes_requested',
            validatedOutput: parsedOutput.data,
          },
          decisionSnapshot: {
            outcome: passed ? 'passed' : 'failed',
            score: parsedOutput.data.score,
            maxScore: 10,
            passingScore: parsedInput.data.passingScore,
            recommendation: parsedOutput.data.recommendation,
          },
        },
      },
      (observed) => {
        transition = observed;
      },
    );
    if (!passed && transition.claimed && transition.nextStageTask) {
      await attachEvaluatorFeedbackToRetry({
        db: input.db,
        stageTask: transition.nextStageTask,
        output: parsedOutput.data,
        passingScore: parsedInput.data.passingScore,
      });
    }
    await queueTransitionStage({
      db: input.db,
      heartbeat: input.heartbeat,
      run: completed,
      transition,
    });
    return {
      handled: true as const,
      status: passed ? ('completed' as const) : ('changes_requested' as const),
      run: completed,
      transition,
    };
  }

  const parsedInput = mergeReadinessDroneInputSchema.safeParse(frozenInput);
  const parsedOutput = mergeReadinessDroneOutputSchema.safeParse(result.output);
  let decisionError: string | null = null;
  if (parsedInput.success && parsedOutput.success) {
    try {
      validateMergeReadinessDecision(parsedInput.data, parsedOutput.data);
    } catch (error) {
      decisionError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!parsedInput.success || !parsedOutput.success || decisionError) {
    const blocked = await blockDroneStage({
      db: input.db,
      run,
      stageTask,
      heartbeat: input.run,
      summary:
        decisionError ??
        'Merge-readiness Drone returned output outside the strict evidence contract',
      inputSnapshot: asRecord(frozenInput),
      outputSnapshot: {
        finalizationStatus: 'invalid',
        inputIssues: parsedInput.success ? [] : validationIssues(parsedInput.error),
        outputIssues: parsedOutput.success ? [] : validationIssues(parsedOutput.error),
        decisionError,
      },
    });
    return { handled: true as const, status: 'blocked' as const, run: blocked };
  }
  if (!parsedOutput.data.ready) {
    const blocked = await blockDroneStage({
      db: input.db,
      run,
      stageTask,
      heartbeat: input.run,
      summary: parsedOutput.data.summary,
      inputSnapshot: parsedInput.data,
      outputSnapshot: { finalizationStatus: 'not_ready', validatedOutput: parsedOutput.data },
    });
    return { handled: true as const, status: 'blocked' as const, run: blocked };
  }
  const stageIssue = await issueService(input.db).getById(stageTask.issueId);
  if (stageIssue && stageIssue.status !== 'done')
    await issueService(input.db).update(stageIssue.id, { status: 'done' });
  const completed = await issuePipelineOrchestrator(
    issuePipelineOrchestratorRepository(input.db),
  ).completeStageTask(
    {
      runId: run.id,
      stageTaskId: stageTask.issueId,
      terminalStatus: 'done',
      outcome: 'passed',
      summary: parsedOutput.data.summary,
      trace: {
        ...heartbeatTrace(input.run),
        inputSnapshot: parsedInput.data,
        outputSnapshot: {
          finalizationStatus: 'ready_without_merge',
          validatedOutput: parsedOutput.data,
        },
        decisionSnapshot: {
          ready: true,
          mergeExecuted: false,
          approvedHeadSha: parsedInput.data.approvedHeadSha,
          targetBranch: parsedInput.data.targetBranch,
        },
      },
    },
    (observed) => {
      transition = observed;
    },
  );
  return {
    handled: true as const,
    status: 'completed_without_merge' as const,
    run: completed,
    transition,
  };
}

/**
 * Freezes the exact PR evidence approved by the release gate. The resulting
 * event snapshot is later the sole source of approvedHeadSha.
 */
export async function buildReleaseApprovalDecisionSnapshot(input: {
  db: Db;
  run: IssuePipelineRun;
  actorId: string | null | undefined;
}) {
  if (!input.actorId?.trim()) throw new Error('release approval requires an attributed user');
  try {
    const evidence = await loadPrimaryPullRequestEvidence(input.db, input.run);
    return {
      outcome: 'approved',
      actor: input.actorId.trim(),
      pullRequest: evidence.metadata,
      workProductId: evidence.product.id,
      evidenceError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Approval remains a human decision. The following merge-readiness child
    // is materialized and then blocked by its deterministic input builder so
    // the missing/ambiguous evidence is visible at the stage that owns it.
    return {
      outcome: 'approved',
      actor: input.actorId.trim(),
      pullRequest: null,
      workProductId: null,
      evidenceError: truncate(message, 2_000),
    };
  }
}

/** Creates an auditable accepted plan confirmation and exact-once child set. */
export async function materializeApprovedPlan(input: {
  db: Db;
  run: IssuePipelineRun;
  approvalTaskId: string;
  actorUserId: string | null | undefined;
}) {
  if (!input.actorUserId?.trim()) throw new Error('plan approval requires an attributed user');
  const actorUserId = input.actorUserId.trim();
  const planEvent = await input.db
    .select({
      heartbeatRunId: issuePipelineEvents.heartbeatRunId,
      outputSnapshot: issuePipelineEvents.outputSnapshot,
    })
    .from(issuePipelineEvents)
    .where(
      and(
        eq(issuePipelineEvents.pipelineRunId, input.run.id),
        eq(issuePipelineEvents.stepKey, 'plan'),
        eq(issuePipelineEvents.eventType, 'stage_completed'),
      ),
    )
    .orderBy(desc(issuePipelineEvents.sequence))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!planEvent) throw new Error('accepted Plan stage has no terminal plan artifact event');
  const planEventOutput = asRecord(planEvent.outputSnapshot);
  const output = plannerDroneOutputSchema.parse(planEventOutput.validatedOutput);
  const plannedRevisionId = z.string().uuid().parse(planEventOutput.planRevisionId);
  const plan = await documentService(input.db).getIssueDocumentByKey(input.run.issueId, 'plan');
  if (!plan?.latestRevisionId) throw new Error('accepted Plan stage has no current plan revision');
  if (plan.latestRevisionId !== plannedRevisionId) {
    throw new Error(
      'current plan revision differs from the revision produced by the accepted Plan stage',
    );
  }
  const root = await issueService(input.db).getById(input.run.issueId);
  if (!root) throw new Error(`pipeline root issue not found: ${input.run.issueId}`);
  const interactionService = issueThreadInteractionService(input.db);
  const actor = { userId: actorUserId };
  const createInteraction = createIssueThreadInteractionSchema.parse({
    kind: 'request_confirmation',
    idempotencyKey: `pipeline-plan-approval:${input.run.id}:${input.approvalTaskId}`,
    sourceRunId: planEvent.heartbeatRunId,
    title: 'Plan approved',
    summary: 'Accepted through the governed pipeline Plan approval stage.',
    continuationPolicy: 'none',
    payload: {
      version: 1,
      prompt: 'Approve this implementation plan and materialize its traceable subtasks?',
      acceptLabel: 'Approved',
      rejectLabel: 'Request changes',
      target: {
        type: 'issue_document',
        issueId: root.id,
        documentId: plan.id,
        key: 'plan',
        revisionId: plannedRevisionId,
        revisionNumber: plan.latestRevisionNumber,
      },
    },
  });
  const interaction = await interactionService.create(root, createInteraction, actor);
  if (interaction.status === 'pending') {
    await interactionService.acceptInteraction(root, interaction.id, {}, actor);
  } else if (interaction.status !== 'accepted') {
    throw new Error(`plan confirmation is ${interaction.status}, not accepted`);
  }
  return issueService(input.db).decomposeAcceptedPlan(root.id, {
    acceptedPlanRevisionId: plannedRevisionId,
    children: output.subtasks.map((task) => ({
      title: task.title,
      description: [
        task.description,
        task.dependsOn.length > 0 ? `Depends on plan keys: ${task.dependsOn.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      acceptanceCriteria: task.acceptanceCriteria,
      status: 'backlog',
      workMode: 'standard',
      priority: root.priority,
      projectId: root.projectId,
      goalId: root.goalId,
      actorUserId,
      blockParentUntilDone: false,
    })),
    actorUserId,
    actorRunId: planEvent.heartbeatRunId,
  });
}

export async function reconcilePipelineDroneRuns(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  companyId?: string;
}) {
  const runs = await input.db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        input.companyId ? eq(heartbeatRuns.companyId, input.companyId) : undefined,
        inArray(heartbeatRuns.status, ['succeeded', 'failed', 'cancelled', 'timed_out']),
        sql`${heartbeatRuns.contextSnapshot} -> 'pipelineDroneStage' is not null`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1_000);
  let inspected = 0;
  let handled = 0;
  for (const run of runs) {
    if (
      !pipelineDroneContextSchema.safeParse(asRecord(run.contextSnapshot).pipelineDroneStage)
        .success
    )
      continue;
    inspected += 1;
    if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) continue;
    const result = await finalizePipelineDroneHeartbeat({
      db: input.db,
      heartbeat: input.heartbeat,
      run,
    });
    if (result.handled) handled += 1;
  }
  return { inspected, handled };
}
