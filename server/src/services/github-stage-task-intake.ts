import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { createExecute } from '@paperclipai/adapter-minion-drone/server';
import { issuePipelineRuns, type Db } from '@paperclipai/db';
import type { IssuePipelineRoutingSnapshot, IssuePipelineSnapshot } from '@paperclipai/shared';
import { logger } from '../middleware/logger.js';
import { issuePipelineOrchestrator } from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';
import { getPipelineById } from './pipelines.js';
import {
  MINION_REPOSITORY_KEYS,
  resolveMinionClassifierProjectRoute,
  type MinionIssueClassification,
  type ProjectRouteRule,
} from './project-routing.js';

export const PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID = 'portfolio-issue-classifier-v1' as const;

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

const routeSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(240),
    projectId: z.string().uuid(),
    group: z.string().trim().min(1).max(120).optional(),
    repository: z.enum([...MINION_REPOSITORY_KEYS, 'cross-repo'] as [string, ...string[]]),
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

export interface GithubIssueClassifier {
  readonly droneId: typeof PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID;
  classify(input: GithubClassifierInput): Promise<MinionIssueClassification>;
}

export function parseGithubStageTaskIntakeEnv(
  env: NodeJS.ProcessEnv,
): { config: GithubStageTaskIntakeConfig; gatewayUrl: string; gatewayToken: string } | null {
  const pipelineId = env.GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID?.trim();
  if (!pipelineId) return null;
  const intakeProjectId = env.GITHUB_BUGS_INTAKE_PROJECT_ID?.trim();
  const routesJson = env.GITHUB_BUGS_STAGE_TASK_ROUTES_JSON?.trim();
  const gatewayUrl = env.MINION_GATEWAY_URL?.trim();
  const gatewayToken = env.MINION_GATEWAY_TOKEN?.trim();
  if (!intakeProjectId || !routesJson || !gatewayUrl || !gatewayToken) {
    throw new Error(
      'GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID requires GITHUB_BUGS_INTAKE_PROJECT_ID, ' +
        'GITHUB_BUGS_STAGE_TASK_ROUTES_JSON, MINION_GATEWAY_URL, and MINION_GATEWAY_TOKEN',
    );
  }
  const ids = z
    .object({ pipelineId: z.string().uuid(), intakeProjectId: z.string().uuid() })
    .parse({
      pipelineId,
      intakeProjectId,
    });
  let decoded: unknown;
  try {
    decoded = JSON.parse(routesJson);
  } catch {
    throw new Error('GITHUB_BUGS_STAGE_TASK_ROUTES_JSON must be valid JSON');
  }
  const routes = z.array(routeSchema).min(1).max(128).parse(decoded) as GithubStageTaskRoute[];
  const routeKeys = new Set(routes.map((route) => route.key));
  if (routeKeys.size !== routes.length)
    throw new Error('GitHub stage-task route keys must be unique');
  if (!routes.some((route) => route.projectId === ids.intakeProjectId)) {
    throw new Error('GitHub stage-task routes must include the configured intake project');
  }
  const minimumConfidence = z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .parse(env.GITHUB_BUGS_CLASSIFIER_MIN_CONFIDENCE ?? undefined);
  return {
    config: { ...ids, minimumConfidence, routes },
    gatewayUrl,
    gatewayToken,
  };
}

export function createMinionGithubIssueClassifier(input: {
  gatewayUrl: string;
  gatewayToken: string;
}): GithubIssueClassifier {
  const execute = createExecute();
  return {
    droneId: PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID,
    async classify(classifierInput) {
      const runId = randomUUID();
      const config = {
        droneId: PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID,
        env: {
          MINION_GATEWAY_URL: input.gatewayUrl,
          MINION_GATEWAY_TOKEN: input.gatewayToken,
        },
      };
      const result = await execute({
        runId,
        agent: {
          id: 'github-intake-classifier',
          companyId: 'github-intake',
          name: 'GitHub intake classifier',
          adapterType: 'minion_drone',
          adapterConfig: config,
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config,
        context: { paperclipDrone: { input: classifierInput } },
        onLog: async (stream, chunk) => {
          const message = chunk.trim();
          if (!message) return;
          if (stream === 'stderr') logger.warn({ runId, message }, 'GitHub intake classifier');
          else logger.debug({ runId, message }, 'GitHub intake classifier');
        },
      } satisfies AdapterExecutionContext);
      if (result.exitCode !== 0 || result.errorMessage) {
        throw new Error(result.errorMessage ?? 'Minion issue classifier failed');
      }
      const output = result.resultJson?.output;
      const parsed = classifierOutputSchema.safeParse(output);
      if (!parsed.success) {
        throw new Error(
          `Minion issue classifier returned invalid output: ${parsed.error.issues[0]?.message}`,
        );
      }
      return parsed.data;
    },
  };
}

export async function activateGithubStageTaskPipeline(input: {
  db: Db;
  companyId: string;
  issue: { id: string; originKind: string; originId: string | null };
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  originalLabels: string[];
  deliveryId?: string | null;
  config: GithubStageTaskIntakeConfig;
  classifier: GithubIssueClassifier;
}) {
  if (input.classifier.droneId !== PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID) {
    throw new Error(`GitHub intake requires ${PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID}`);
  }
  const sourceKey = input.issue.originId ?? input.issue.id;
  const existing = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(
        eq(issuePipelineRuns.companyId, input.companyId),
        eq(issuePipelineRuns.sourceOriginKind, input.issue.originKind),
        eq(issuePipelineRuns.sourceOriginId, sourceKey),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existing) return { run: existing, stageTask: null, created: false, classification: null };

  const pipeline = await getPipelineById(input.db, input.companyId, input.config.pipelineId);
  if (!pipeline)
    throw new Error(`Configured GitHub stage-task pipeline not found: ${input.config.pipelineId}`);
  if (pipeline.executionMode !== 'stage_tasks') {
    throw new Error(`Configured GitHub pipeline ${pipeline.id} does not use stage_tasks mode`);
  }
  const fallbackRoute = input.config.routes.find(
    (route) => route.projectId === input.config.intakeProjectId,
  )!;
  const classifierInput: GithubClassifierInput = {
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
  };
  const classification = await input.classifier.classify(classifierInput);
  if (!input.config.routes.some((route) => route.key === classification.projectKey)) {
    throw new Error(
      `Minion issue classifier selected unknown project key: ${classification.projectKey}`,
    );
  }
  const overrideLabel = input.originalLabels.find((label) => label.startsWith('project:'));
  const overrideRule = overrideLabel
    ? input.config.routes.find((route) => route.key === overrideLabel.slice('project:'.length))
    : null;
  const rules: ProjectRouteRule[] = input.config.routes.map((route) => ({
    key: route.key,
    projectId: route.projectId,
    repository: route.repository,
    scopes: route.scopes,
    pathPrefixes: route.pathPrefixes,
  }));
  const decision = resolveMinionClassifierProjectRoute({
    signedRepositoryFullName: input.repository,
    classification,
    rules,
    intakeProjectId: input.config.intakeProjectId,
    operatorProjectId: overrideRule?.projectId,
    minimumConfidence: input.config.minimumConfidence,
  });
  const routingSnapshot: IssuePipelineRoutingSnapshot = {
    repository: input.repository,
    originalLabels: input.originalLabels,
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
  const snapshot: IssuePipelineSnapshot = {
    pipelineId: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    executionMode: 'stage_tasks',
    trigger: pipeline.trigger,
    steps: pipeline.steps,
  };
  const result = await issuePipelineOrchestrator(
    issuePipelineOrchestratorRepository(input.db),
  ).start({
    companyId: input.companyId,
    selectedProjectId: decision.projectId,
    issueId: input.issue.id,
    sourceKey,
    sourceDeliveryId: input.deliveryId,
    pipelineSnapshot: snapshot,
    routingSnapshot,
  });
  return { ...result, classification };
}
