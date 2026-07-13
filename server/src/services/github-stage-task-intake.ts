import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  heartbeatRuns,
  issuePipelineRuns,
  issues,
  labels,
  type Db,
} from '@paperclipai/db';
import type {
  IssuePipelineRoutingSnapshot,
  IssuePipelineSnapshot,
  IssuePipelineRun,
} from '@paperclipai/shared';
import { pipelineStepSchema, pipelineTriggerSchema } from '@paperclipai/shared';
import { logger } from '../middleware/logger.js';
import {
  type IssueAssignmentWakeupDeps,
} from './issue-assignment-wakeup.js';
import { issuePipelineOrchestrator } from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';
import {
  blockPipelineDroneDispatchFailure,
  queuePipelineStageTaskWakeup,
} from './issue-pipeline-drone-stages.js';
import { issueService } from './issues.js';
import { getPipelineById } from './pipelines.js';
import {
  MINION_REPOSITORY_KEYS,
  resolveMinionClassifierProjectRoute,
  type MinionIssueClassification,
  type ProjectRouteRule,
} from './project-routing.js';

export const PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID = 'portfolio-issue-classifier-v1' as const;
const GITHUB_CLASSIFIER_CONTEXT_KIND = 'github_issue_classifier_v1' as const;
const CLASSIFIER_STEP_KEY = 'classify';

export const MINION_INTAKE_ALLOWED_LABELS = [
  'bug',
  'feature',
  'security',
  'maintenance',
  'docs',
  'critical',
  'high',
  'medium',
  'low',
] as const;

export const MINION_INTAKE_ALLOWED_SCOPES = [
  'auth',
  'crm',
  'core',
  'gateway',
  'workforce',
  'ui',
  'data',
  'plugins',
  'ops',
  'docs',
] as const;

const MINION_INTAKE_ROUTE_REPOSITORIES = [
  ...MINION_REPOSITORY_KEYS,
  'cross-repo',
] as const;

const routeSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(240),
    projectId: z.string().uuid(),
    group: z.string().trim().min(1).max(120).optional(),
    repository: z.enum(MINION_INTAKE_ROUTE_REPOSITORIES),
    repositories: z.array(z.string().trim().min(1).max(240)).min(1).max(32),
    scopes: z.array(z.enum(MINION_INTAKE_ALLOWED_SCOPES)).max(64).default([]),
    pathPrefixes: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    summary: z.string().trim().max(2_000).optional(),
  })
  .strict();

const classifierOutputSchema = z
  .object({
    labels: z.array(z.enum(MINION_INTAKE_ALLOWED_LABELS)).max(32),
    scopes: z.array(z.enum(MINION_INTAKE_ALLOWED_SCOPES)).max(32),
    projectKey: z.string().trim().min(1).max(120),
    projectGroup: z.string().trim().min(1).max(120).optional(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

const classifierInputSchema = z
  .object({
    issue: z
      .object({
        source: z.literal('github'),
        repository: z.string().trim().min(1).max(240),
        externalId: z.string().trim().min(1).max(120),
        title: z.string().max(2_000),
        body: z.string().max(100_000),
        labels: z.array(z.string().max(240)).max(100),
      })
      .strict(),
    allowedLabels: z.array(z.enum(MINION_INTAKE_ALLOWED_LABELS)),
    allowedScopes: z.array(z.enum(MINION_INTAKE_ALLOWED_SCOPES)),
    projectCandidates: z.array(
      z
        .object({
          key: z.string().trim().min(1).max(120),
          name: z.string().trim().min(1).max(240),
          group: z.string().trim().min(1).max(120).optional(),
          repositories: z.array(z.string().trim().min(1).max(240)).min(1).max(32),
          scopes: z.array(z.enum(MINION_INTAKE_ALLOWED_SCOPES)).max(64),
          summary: z.string().trim().max(2_000).optional(),
        })
        .strict(),
    ),
    fallbackProjectKey: z.string().trim().min(1).max(120),
  })
  .strict();

const deliveryPipelineSnapshotSchema = z
  .object({
    pipelineId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().nullable(),
    executionMode: z.literal('stage_tasks'),
    trigger: pipelineTriggerSchema.nullable(),
    steps: z.array(pipelineStepSchema).min(1),
  })
  .strict();

const frozenIntakeContextSchema = z
  .object({
    kind: z.literal(GITHUB_CLASSIFIER_CONTEXT_KIND),
    classifierAgentId: z.string().uuid(),
    deliveryPipelineId: z.string().uuid(),
    deliveryPipelineSnapshot: deliveryPipelineSnapshotSchema,
    deliverySourceKey: z.string().trim().min(1).max(500),
    sourceDeliveryId: z.string().max(500).nullable(),
    intakeProjectId: z.string().uuid(),
    minimumConfidence: z.number().min(0).max(1),
    routes: z.array(routeSchema).min(1).max(128),
    classifierInput: classifierInputSchema,
  })
  .strict();

const heartbeatContextSchema = z
  .object({
    kind: z.literal(GITHUB_CLASSIFIER_CONTEXT_KIND),
    classifierPipelineRunId: z.string().uuid(),
    classifierStageTaskId: z.string().uuid(),
  })
  .strict();

export interface GithubStageTaskRoute {
  key: string;
  name: string;
  projectId: string;
  group?: string;
  repository: ProjectRouteRule['repository'];
  repositories: string[];
  scopes: string[];
  pathPrefixes?: string[];
  summary?: string;
}

export interface GithubStageTaskIntakeConfig {
  pipelineId: string;
  intakeProjectId: string;
  classifierAgentId: string;
  minimumConfidence: number;
  routes: GithubStageTaskRoute[];
}

export interface GithubClassifierInput {
  issue: {
    source: 'github';
    repository: string;
    externalId: string;
    title: string;
    body: string;
    labels: string[];
  };
  allowedLabels: string[];
  allowedScopes: string[];
  projectCandidates: Array<{
    key: string;
    name: string;
    group?: string;
    repositories: string[];
    scopes: string[];
    summary?: string;
  }>;
  fallbackProjectKey: string;
}

export type GithubStageTaskHeartbeat = IssueAssignmentWakeupDeps;

export function parseGithubStageTaskIntakeEnv(
  env: NodeJS.ProcessEnv,
): { config: GithubStageTaskIntakeConfig } | null {
  const pipelineId = env.GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID?.trim();
  if (!pipelineId) return null;
  const intakeProjectId = env.GITHUB_BUGS_INTAKE_PROJECT_ID?.trim();
  const classifierAgentId = env.GITHUB_BUGS_CLASSIFIER_AGENT_ID?.trim();
  const routesJson = env.GITHUB_BUGS_STAGE_TASK_ROUTES_JSON?.trim();
  if (!intakeProjectId || !classifierAgentId || !routesJson) {
    throw new Error(
      'GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID requires GITHUB_BUGS_INTAKE_PROJECT_ID, ' +
        'GITHUB_BUGS_CLASSIFIER_AGENT_ID, and GITHUB_BUGS_STAGE_TASK_ROUTES_JSON',
    );
  }
  const ids = z
    .object({
      pipelineId: z.string().uuid(),
      intakeProjectId: z.string().uuid(),
      classifierAgentId: z.string().uuid(),
    })
    .parse({ pipelineId, intakeProjectId, classifierAgentId });
  let decoded: unknown;
  try {
    decoded = JSON.parse(routesJson);
  } catch {
    throw new Error('GITHUB_BUGS_STAGE_TASK_ROUTES_JSON must be valid JSON');
  }
  const routes = z.array(routeSchema).min(1).max(128).parse(decoded) as GithubStageTaskRoute[];
  const routeKeys = new Set(routes.map((route) => route.key));
  if (routeKeys.size !== routes.length) {
    throw new Error('GitHub stage-task route keys must be unique');
  }
  if (!routes.some((route) => route.projectId === ids.intakeProjectId)) {
    throw new Error('GitHub stage-task routes must include the configured intake project');
  }
  const minimumConfidence = z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .parse(env.GITHUB_BUGS_CLASSIFIER_MIN_CONFIDENCE ?? undefined);
  return { config: { ...ids, minimumConfidence, routes } };
}

function classifierInput(input: {
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  originalLabels: string[];
  config: GithubStageTaskIntakeConfig;
}): GithubClassifierInput {
  const fallbackRoute = input.config.routes.find(
    (route) => route.projectId === input.config.intakeProjectId,
  )!;
  return classifierInputSchema.parse({
    issue: {
      source: 'github',
      repository: input.repository,
      externalId: String(input.issueNumber),
      title: input.title,
      body: input.body,
      labels: input.originalLabels,
    },
    allowedLabels: [...MINION_INTAKE_ALLOWED_LABELS],
    allowedScopes: [...MINION_INTAKE_ALLOWED_SCOPES],
    projectCandidates: input.config.routes.map(
      ({ key, name, group, repositories, scopes, summary }) => ({
        key,
        name,
        ...(group ? { group } : {}),
        repositories,
        scopes,
        ...(summary ? { summary } : {}),
      }),
    ),
    fallbackProjectKey: fallbackRoute.key,
  });
}

function classifierSourceKey(sourceKey: string) {
  return `classifier:${sourceKey}`;
}

function deliverySourceKey(sourceKey: string) {
  return `delivery:${sourceKey}`;
}

const ACTIVE_OR_SUCCEEDED_HEARTBEAT_STATUSES = [
  'queued',
  'scheduled_retry',
  'running',
  'succeeded',
] as const;

async function listTaskHeartbeatRuns(db: Db, companyId: string, taskId: string) {
  return db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${taskId}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt));
}

function hasActiveOrSucceededHeartbeat(runs: Array<typeof heartbeatRuns.$inferSelect>) {
  return runs.some((run) =>
    ACTIVE_OR_SUCCEEDED_HEARTBEAT_STATUSES.includes(
      run.status as (typeof ACTIVE_OR_SUCCEEDED_HEARTBEAT_STATUSES)[number],
    ),
  );
}

async function queueClassifierWakeup(input: {
  heartbeat: GithubStageTaskHeartbeat;
  classifierAgentId: string;
  classifierPipelineRunId: string;
  classifierStageTaskId: string;
  classifierInput: GithubClassifierInput;
}) {
  return input.heartbeat.wakeup(input.classifierAgentId, {
    source: 'assignment',
    triggerDetail: 'system',
    reason: 'github_issue_classification',
    payload: {
      issueId: input.classifierStageTaskId,
      mutation: 'pipeline_classifier_materialized',
    },
    idempotencyKey: `github-classifier:${input.classifierPipelineRunId}`,
    requestedByActorType: 'system',
    requestedByActorId: 'github-bugs',
    contextSnapshot: {
      issueId: input.classifierStageTaskId,
      taskId: input.classifierStageTaskId,
      source: 'github-bugs.classifier',
      paperclipDrone: { input: input.classifierInput },
      githubClassifier: {
        kind: GITHUB_CLASSIFIER_CONTEXT_KIND,
        classifierPipelineRunId: input.classifierPipelineRunId,
        classifierStageTaskId: input.classifierStageTaskId,
      },
    },
  });
}

export async function activateGithubStageTaskPipeline(input: {
  db: Db;
  heartbeat: GithubStageTaskHeartbeat;
  companyId: string;
  issue: { id: string; originKind: string; originId: string | null };
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  originalLabels: string[];
  deliveryId?: string | null;
  config: GithubStageTaskIntakeConfig;
}) {
  const sourceKey = input.issue.originId ?? input.issue.id;
  const classifierAgent = await input.db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.id, input.config.classifierAgentId), eq(agents.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  const configuredDroneId =
    classifierAgent?.adapterConfig && typeof classifierAgent.adapterConfig === 'object'
      ? (classifierAgent.adapterConfig as Record<string, unknown>).droneId
      : null;
  if (
    !classifierAgent ||
    classifierAgent.adapterType !== 'minion_drone' ||
    configuredDroneId !== PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID
  ) {
    throw new Error(
      `GITHUB_BUGS_CLASSIFIER_AGENT_ID must reference a company Minion Drone agent configured for ${PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID}`,
    );
  }

  const pipeline = await getPipelineById(input.db, input.companyId, input.config.pipelineId);
  if (!pipeline) {
    throw new Error(`Configured GitHub stage-task pipeline not found: ${input.config.pipelineId}`);
  }
  if (pipeline.executionMode !== 'stage_tasks') {
    throw new Error(`Configured GitHub pipeline ${pipeline.id} does not use stage_tasks mode`);
  }
  const typedClassifierInput = classifierInput(input);
  const deliveryPipelineSnapshot: IssuePipelineSnapshot = {
    pipelineId: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    executionMode: 'stage_tasks',
    trigger: pipeline.trigger,
    steps: pipeline.steps,
  };
  const intakeContext = frozenIntakeContextSchema.parse({
    kind: GITHUB_CLASSIFIER_CONTEXT_KIND,
    classifierAgentId: input.config.classifierAgentId,
    deliveryPipelineId: pipeline.id,
    deliveryPipelineSnapshot,
    deliverySourceKey: deliverySourceKey(sourceKey),
    sourceDeliveryId: input.deliveryId ?? null,
    intakeProjectId: input.config.intakeProjectId,
    minimumConfidence: input.config.minimumConfidence,
    routes: input.config.routes,
    classifierInput: typedClassifierInput,
  });
  const classifierSnapshot: IssuePipelineSnapshot = {
    pipelineId: pipeline.id,
    name: 'GitHub issue classification',
    description: `Asynchronous bounded classification before ${pipeline.name}`,
    executionMode: 'stage_tasks',
    trigger: { originKinds: ['github_issue'] },
    steps: [
      {
        key: CLASSIFIER_STEP_KEY,
        kind: 'work',
        label: 'Classify and route',
        participant: { type: 'agent', agentId: input.config.classifierAgentId },
      },
    ],
  };
  const routingSnapshot: IssuePipelineRoutingSnapshot = {
    repository: input.repository,
    originalLabels: input.originalLabels,
    inferredLabels: [],
    classifierOutput: null,
    candidates: input.config.routes.map((route) => ({
      projectId: route.projectId,
      repository: route.repository,
      scope: route.scopes.join(',') || null,
      matchedRule: route.key,
      confidence: null,
      reason: 'classifier_candidate',
    })),
    selectedPortfolioId: null,
    selectedProjectId: input.config.intakeProjectId,
    confidence: null,
    resolution: 'unresolved',
    reason: 'awaiting asynchronous classifier heartbeat',
    intakeContext,
  };
  const result = await issuePipelineOrchestrator(
    issuePipelineOrchestratorRepository(input.db),
  ).start({
    companyId: input.companyId,
    selectedProjectId: input.config.intakeProjectId,
    issueId: input.issue.id,
    sourceKey: classifierSourceKey(sourceKey),
    sourceDeliveryId: input.deliveryId,
    pipelineSnapshot: classifierSnapshot,
    routingSnapshot,
  });

  await reconcileGithubClassifierPipelineRun({
    db: input.db,
    heartbeat: input.heartbeat,
    pipelineRunId: result.run.id,
  }).catch((err) => {
    logger.warn(
      { err, pipelineRunId: result.run.id, issueId: result.stageTask.issueId },
      'failed to reconcile GitHub classifier agent wakeup',
    );
  });

  return { ...result, classification: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validationFailureDetails(error: z.ZodError) {
  return error.issues.slice(0, 12).map((issue) => ({
    path: issue.path.slice(0, 12).map(String).join('.'),
    message: issue.message.slice(0, 500),
  }));
}

function labelColor(name: string) {
  if (name === 'bug') return '#ef4444';
  if (name === 'security' || name === 'critical') return '#dc2626';
  if (name === 'feature') return '#22c55e';
  if (name === 'high') return '#f97316';
  if (name === 'medium') return '#eab308';
  if (name === 'low') return '#3b82f6';
  return name.startsWith('scope:') ? '#8b5cf6' : '#64748b';
}

async function ensureClassificationLabelIds(
  db: Db,
  companyId: string,
  classification: MinionIssueClassification,
) {
  const names = [...new Set([
    ...classification.labels.map((label) => label.toLowerCase()),
    ...classification.scopes.map((scope) => `scope:${scope.toLowerCase()}`),
  ])].sort();
  if (names.length === 0) return [];
  await db
    .insert(labels)
    .values(names.map((name) => ({ companyId, name, color: labelColor(name) })))
    .onConflictDoNothing({ target: [labels.companyId, labels.name] });
  return db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), inArray(labels.name, names)))
    .then((rows) => rows.map((row) => row.id));
}

type ClassifierHeartbeatRun = Pick<
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

function heartbeatTrace(run: ClassifierHeartbeatRun) {
  return {
    heartbeatRunId: run.id,
    harnessRevisionId: run.harnessRevisionId,
    resolvedAdapterType: run.resolvedAdapterType,
    resolvedModel: run.resolvedModel,
    resolvedProvider: run.resolvedProvider,
  };
}

async function blockClassifierRun(input: {
  db: Db;
  pipelineRun: IssuePipelineRun;
  stageTaskId: string;
  heartbeatRun: ClassifierHeartbeatRun;
  summary: string;
  outputSnapshot: Record<string, unknown>;
  inputSnapshot: Record<string, unknown>;
}) {
  const stageIssue = await issueService(input.db).getById(input.stageTaskId);
  if (stageIssue && stageIssue.status !== 'blocked' && stageIssue.status !== 'cancelled') {
    await issueService(input.db).update(stageIssue.id, { status: 'blocked' });
  }
  const run = await issuePipelineOrchestrator(
    issuePipelineOrchestratorRepository(input.db),
  ).completeStageTask({
    runId: input.pipelineRun.id,
    stageTaskId: input.stageTaskId,
    terminalStatus: 'blocked',
    summary: input.summary,
    trace: {
      ...heartbeatTrace(input.heartbeatRun),
      inputSnapshot: input.inputSnapshot,
      outputSnapshot: input.outputSnapshot,
    },
  });
  return { handled: true as const, status: 'blocked' as const, classifierRun: run, deliveryRun: null };
}

async function repairDeliveryPlanWake(input: {
  db: Db;
  heartbeat: GithubStageTaskHeartbeat;
  deliveryRun: typeof issuePipelineRuns.$inferSelect;
}) {
  const firstStep = input.deliveryRun.pipelineSnapshot.steps[0];
  if (!firstStep) return { repaired: false, reason: 'missing_frozen_plan_step' as const };
  const planIssue = await input.db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.deliveryRun.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, input.deliveryRun.id),
        eq(issues.originFingerprint, `${firstStep.key}:1`),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!planIssue) return { repaired: false, reason: 'missing_plan_task' as const };
  if (planIssue.status !== 'todo' && planIssue.status !== 'in_progress') {
    return { repaired: false, reason: 'plan_task_not_wakeable' as const };
  }
  const planRuns = await listTaskHeartbeatRuns(input.db, input.deliveryRun.companyId, planIssue.id);
  if (hasActiveOrSucceededHeartbeat(planRuns)) {
    return { repaired: false, reason: 'plan_heartbeat_present' as const };
  }
  const run = input.deliveryRun as IssuePipelineRun;
  const repository = issuePipelineOrchestratorRepository(input.db);
  const stageTask = (await repository.listStageTasks(run.id)).find((task) => task.issueId === planIssue.id);
  if (!stageTask) return { repaired: false, reason: 'missing_plan_stage_identity' as const };
  try {
    await queuePipelineStageTaskWakeup({
      db: input.db,
      heartbeat: input.heartbeat,
      run,
      stageTask,
      requestedByActorType: 'system',
      requestedByActorId: 'github-bugs',
    });
  } catch (error) {
    await blockPipelineDroneDispatchFailure({ db: input.db, run, stageTask, error });
    return { repaired: false, reason: 'plan_input_blocked' as const };
  }
  return { repaired: true, reason: 'plan_heartbeat_queued' as const };
}

/**
 * Converts an attributed classifier heartbeat into deterministic routing and
 * delivery. It is safe to call repeatedly for the same terminal heartbeat.
 */
export async function finalizeGithubClassifierHeartbeat(input: {
  db: Db;
  heartbeat: GithubStageTaskHeartbeat;
  run: ClassifierHeartbeatRun;
}) {
  const heartbeatContext = heartbeatContextSchema.safeParse(
    asRecord(input.run.contextSnapshot).githubClassifier,
  );
  if (!heartbeatContext.success) return { handled: false as const };

  const pipelineRun = await issuePipelineOrchestratorRepository(input.db).getRun(
    heartbeatContext.data.classifierPipelineRunId,
  );
  if (!pipelineRun || pipelineRun.companyId !== input.run.companyId) {
    throw new Error(`GitHub classifier pipeline run not found: ${heartbeatContext.data.classifierPipelineRunId}`);
  }
  const frozen = frozenIntakeContextSchema.parse(pipelineRun.routingSnapshot.intakeContext);
  if (input.run.agentId !== frozen.classifierAgentId) {
    throw new Error(`Heartbeat ${input.run.id} was not executed by the frozen classifier agent`);
  }
  const stageTask = await input.db
    .select({ id: issues.id, companyId: issues.companyId, originId: issues.originId })
    .from(issues)
    .where(
      and(
        eq(issues.id, heartbeatContext.data.classifierStageTaskId),
        eq(issues.companyId, input.run.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, pipelineRun.id),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!stageTask) throw new Error('Attributed GitHub classifier stage task was not found');

  if (input.run.status !== 'succeeded') {
    const taskRuns = await listTaskHeartbeatRuns(input.db, input.run.companyId, stageTask.id);
    const activeRetry = taskRuns.some(
      (run) =>
        run.id !== input.run.id &&
        ['queued', 'scheduled_retry', 'running'].includes(run.status),
    );
    if (activeRetry) {
      return {
        handled: true as const,
        status: 'retry_pending' as const,
        classifierRun: pipelineRun,
        deliveryRun: null,
      };
    }
    return blockClassifierRun({
      db: input.db,
      pipelineRun,
      stageTaskId: stageTask.id,
      heartbeatRun: input.run,
      summary: `Classifier heartbeat failed: ${input.run.error ?? input.run.errorCode ?? input.run.status}`,
      inputSnapshot: frozen.classifierInput,
      outputSnapshot: {
        classificationStatus: 'heartbeat_failed',
        errorCode: input.run.errorCode ?? null,
        error: input.run.error?.slice(0, 2_000) ?? null,
      },
    });
  }

  const resultJson = asRecord(input.run.resultJson);
  const parsed = classifierOutputSchema.safeParse(resultJson.output);
  const expectedDrone = resultJson.droneId === PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID;
  if (!parsed.success || !expectedDrone) {
    return blockClassifierRun({
      db: input.db,
      pipelineRun,
      stageTaskId: stageTask.id,
      heartbeatRun: input.run,
      summary: expectedDrone
        ? 'Classifier heartbeat returned output outside the strict taxonomy contract'
        : `Classifier heartbeat did not use ${PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID}`,
      inputSnapshot: frozen.classifierInput,
      outputSnapshot: {
        classificationStatus: 'invalid',
        expectedDrone,
        validationIssues: parsed.success ? [] : validationFailureDetails(parsed.error),
      },
    });
  }
  const classification = parsed.data;
  if (!frozen.routes.some((route) => route.key === classification.projectKey)) {
    return blockClassifierRun({
      db: input.db,
      pipelineRun,
      stageTaskId: stageTask.id,
      heartbeatRun: input.run,
      summary: `Classifier selected unknown project key: ${classification.projectKey}`,
      inputSnapshot: frozen.classifierInput,
      outputSnapshot: { classificationStatus: 'invalid_project_key', validatedOutput: classification },
    });
  }

  const overrideLabel = pipelineRun.routingSnapshot.originalLabels.find((label) =>
    label.startsWith('project:'),
  );
  const overrideRule = overrideLabel
    ? frozen.routes.find((route) => route.key === overrideLabel.slice('project:'.length))
    : null;
  const rules: ProjectRouteRule[] = frozen.routes.map((route) => ({
    key: route.key,
    projectId: route.projectId,
    repository: route.repository as ProjectRouteRule['repository'],
    scopes: route.scopes,
    pathPrefixes: route.pathPrefixes,
  }));
  const decision = resolveMinionClassifierProjectRoute({
    signedRepositoryFullName: frozen.classifierInput.issue.repository,
    classification,
    rules,
    intakeProjectId: frozen.intakeProjectId,
    operatorProjectId: overrideRule?.projectId,
    minimumConfidence: frozen.minimumConfidence,
  });
  const routingSnapshot: IssuePipelineRoutingSnapshot = {
    repository: frozen.classifierInput.issue.repository,
    originalLabels: pipelineRun.routingSnapshot.originalLabels,
    inferredLabels: classification.labels,
    classifierOutput: { ...classification },
    candidates: decision.candidates.map((candidate) => ({
      projectId: candidate.projectId,
      repository: decision.authoritativeRepository,
      scope: candidate.matchedScopes.join(',') || null,
      matchedRule: candidate.ruleKey,
      confidence: classification.confidence,
      reason: candidate.precedence,
    })),
    selectedPortfolioId: null,
    selectedProjectId: decision.projectId,
    confidence: classification.confidence,
    resolution:
      decision.reason === 'operator_override'
        ? 'override'
        : decision.requiresHuman
          ? 'intake_fallback'
          : 'rule',
    reason: `${decision.reason}: ${classification.rationale}`,
  };
  const deliveryPipeline = await getPipelineById(
    input.db,
    input.run.companyId,
    frozen.deliveryPipelineId,
  );
  if (!deliveryPipeline || deliveryPipeline.executionMode !== 'stage_tasks') {
    throw new Error(`Frozen delivery pipeline is unavailable: ${frozen.deliveryPipelineId}`);
  }
  const deliverySnapshot = frozen.deliveryPipelineSnapshot as IssuePipelineSnapshot;
  if (deliverySnapshot.pipelineId !== deliveryPipeline.id) {
    throw new Error('Frozen delivery pipeline identity does not match its source row');
  }

  const existingDelivery = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(
        eq(issuePipelineRuns.companyId, input.run.companyId),
        eq(issuePipelineRuns.sourceOriginKind, pipelineRun.sourceOriginKind),
        eq(issuePipelineRuns.sourceOriginId, frozen.deliverySourceKey),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existingDelivery) {
    let repair = await repairDeliveryPlanWake({
      db: input.db,
      heartbeat: input.heartbeat,
      deliveryRun: existingDelivery,
    });
    if (repair.reason === 'missing_plan_task') {
      await issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db)).start({
        companyId: input.run.companyId,
        selectedProjectId: existingDelivery.selectedProjectId!,
        issueId: existingDelivery.issueId,
        sourceKey: frozen.deliverySourceKey,
        sourceDeliveryId: frozen.sourceDeliveryId,
        pipelineSnapshot: deliverySnapshot,
        routingSnapshot: existingDelivery.routingSnapshot,
      });
      const refreshedDelivery = await input.db
        .select()
        .from(issuePipelineRuns)
        .where(eq(issuePipelineRuns.id, existingDelivery.id))
        .then((rows) => rows[0] ?? existingDelivery);
      repair = await repairDeliveryPlanWake({
        db: input.db,
        heartbeat: input.heartbeat,
        deliveryRun: refreshedDelivery,
      });
    }
    return {
      handled: true as const,
      status: 'reconciled' as const,
      classifierRun: pipelineRun,
      deliveryRun: existingDelivery,
      classification,
      decision,
      repair,
    };
  }

  const issueSvc = issueService(input.db);
  const root = await issueSvc.getById(pipelineRun.issueId);
  if (!root) throw new Error(`GitHub classifier root issue not found: ${pipelineRun.issueId}`);
  const classificationLabelIds = await ensureClassificationLabelIds(
    input.db,
    input.run.companyId,
    classification,
  );
  await issueSvc.update(root.id, {
    projectId: decision.projectId,
    labelIds: [...new Set([...(root.labelIds ?? []), ...classificationLabelIds])],
  });
  const currentStage = await issueSvc.getById(stageTask.id);
  if (currentStage && currentStage.status !== 'done') {
    await issueSvc.update(currentStage.id, { status: 'done' });
  }
  await issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db)).completeStageTask({
    runId: pipelineRun.id,
    stageTaskId: stageTask.id,
    terminalStatus: 'done',
    outcome: 'passed',
    summary: classification.rationale,
    trace: {
      ...heartbeatTrace(input.run),
      inputSnapshot: frozen.classifierInput,
      outputSnapshot: { classificationStatus: 'validated', validatedOutput: classification },
      decisionSnapshot: decision as unknown as Record<string, unknown>,
    },
  });

  const delivery = await issuePipelineOrchestrator(
    issuePipelineOrchestratorRepository(input.db),
  ).start({
    companyId: input.run.companyId,
    selectedProjectId: decision.projectId,
    issueId: root.id,
    sourceKey: frozen.deliverySourceKey,
    sourceDeliveryId: frozen.sourceDeliveryId,
    pipelineSnapshot: deliverySnapshot,
    routingSnapshot,
  });
  const persistedDelivery = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(eq(issuePipelineRuns.id, delivery.run.id))
    .then((rows) => rows[0] ?? null);
  if (persistedDelivery) {
    await repairDeliveryPlanWake({
      db: input.db,
      heartbeat: input.heartbeat,
      deliveryRun: persistedDelivery,
    });
  }

  return {
    handled: true as const,
    status: 'routed' as const,
    classifierRun: pipelineRun,
    deliveryRun: delivery.run,
    classification,
    decision,
  };
}

/**
 * Repairs the two durable handoff seams around asynchronous classification:
 * a classifier task committed without a heartbeat, and a successful
 * classifier heartbeat committed before its delivery/Plan wake completed.
 */
export async function reconcileGithubClassifierPipelineRun(input: {
  db: Db;
  heartbeat: GithubStageTaskHeartbeat;
  pipelineRunId: string;
}) {
  const pipelineRun = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(eq(issuePipelineRuns.id, input.pipelineRunId))
    .then((rows) => rows[0] ?? null);
  if (!pipelineRun) return { handled: false as const, reason: 'missing_pipeline_run' as const };
  const frozenResult = frozenIntakeContextSchema.safeParse(
    pipelineRun.routingSnapshot.intakeContext,
  );
  if (!frozenResult.success) {
    return { handled: false as const, reason: 'not_github_classifier' as const };
  }
  const frozen = frozenResult.data;
  const stageTask = await input.db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, pipelineRun.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, pipelineRun.id),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!stageTask) {
    throw new Error(`GitHub classifier stage task missing for run ${pipelineRun.id}`);
  }

  const runs = await listTaskHeartbeatRuns(input.db, pipelineRun.companyId, stageTask.id);
  const succeeded = runs.find(
    (run) => run.agentId === frozen.classifierAgentId && run.status === 'succeeded',
  );
  if (succeeded) {
    return finalizeGithubClassifierHeartbeat({ db: input.db, heartbeat: input.heartbeat, run: succeeded });
  }
  const active = runs.find(
    (run) =>
      run.agentId === frozen.classifierAgentId &&
      ['queued', 'scheduled_retry', 'running'].includes(run.status),
  );
  if (active) {
    return { handled: true as const, status: 'heartbeat_active' as const, heartbeatRunId: active.id };
  }
  const failed = runs.find(
    (run) =>
      run.agentId === frozen.classifierAgentId &&
      ['failed', 'cancelled', 'timed_out'].includes(run.status),
  );
  if (failed) {
    return finalizeGithubClassifierHeartbeat({ db: input.db, heartbeat: input.heartbeat, run: failed });
  }
  if (pipelineRun.status !== 'pending' && pipelineRun.status !== 'active') {
    return { handled: true as const, status: 'terminal_without_heartbeat' as const };
  }

  const queued = await queueClassifierWakeup({
    heartbeat: input.heartbeat,
    classifierAgentId: frozen.classifierAgentId,
    classifierPipelineRunId: pipelineRun.id,
    classifierStageTaskId: stageTask.id,
    classifierInput: frozen.classifierInput,
  });
  return {
    handled: true as const,
    status: queued ? ('heartbeat_queued' as const) : ('heartbeat_not_queued' as const),
  };
}

export async function reconcileGithubClassifierRuns(input: {
  db: Db;
  heartbeat: GithubStageTaskHeartbeat;
  companyId?: string;
}) {
  const rows = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      input.companyId
        ? and(
            eq(issuePipelineRuns.companyId, input.companyId),
            inArray(issuePipelineRuns.status, ['pending', 'active', 'blocked', 'completed', 'failed']),
          )
        : inArray(issuePipelineRuns.status, ['pending', 'active', 'blocked', 'completed', 'failed']),
    )
    .orderBy(desc(issuePipelineRuns.createdAt));
  let inspected = 0;
  let handled = 0;
  for (const row of rows) {
    if (!frozenIntakeContextSchema.safeParse(row.routingSnapshot.intakeContext).success) continue;
    inspected += 1;
    const result = await reconcileGithubClassifierPipelineRun({
      db: input.db,
      heartbeat: input.heartbeat,
      pipelineRunId: row.id,
    });
    if (result.handled) handled += 1;
  }
  return { inspected, handled };
}

export async function finalizeGithubClassifierHeartbeatById(input: {
  db: Db;
  heartbeat: GithubStageTaskHeartbeat;
  heartbeatRunId: string;
}) {
  const run = await input.db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.heartbeatRunId))
    .then((rows) => rows[0] ?? null);
  if (!run) return { handled: false as const };
  return finalizeGithubClassifierHeartbeat({ ...input, run });
}
