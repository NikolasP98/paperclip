import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  documents,
  heartbeatRuns,
  issueDocuments,
  issuePipelineEvents,
  issuePipelineRuns,
  issues,
  labels,
  pipelines,
  portfolios,
  projects,
  projectWorkspaces,
  type Db,
} from '@paperclipai/db';
import {
  type CreateFactoryIntake,
  type DecideFactoryIntakeRouting,
  decideFactoryIntakeRoutingSchema,
  type FactoryIntakeProjection,
  type FactoryRoutingDecision,
  type FactoryScoutEvidence,
  type IssuePipelineRoutingSnapshot,
  type IssuePipelineRun,
  type IssuePipelineSnapshot,
  type PipelineInboxTarget,
  pipelineStepSchema,
  pipelineTriggerSchema,
} from '@paperclipai/shared';
import { conflict } from '../errors.js';
import { logger } from '../middleware/logger.js';
import { logActivity } from './activity-log.js';
import type { IssueAssignmentWakeupDeps } from './issue-assignment-wakeup.js';
import {
  blockPipelineDroneDispatchFailure,
  queuePipelineStageTaskWakeup,
} from './issue-pipeline-drone-stages.js';
import { issuePipelineOrchestrator } from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';
import { issueService } from './issues.js';
import {
  assertPipelineHitlTerminalActor,
  type PipelineHitlTerminalActor,
} from './pipeline-inbox.js';
import { projectService } from './projects.js';

const FACTORY_CONTEXT_KIND = 'paperclip_factory_intake_v1' as const;
const FACTORY_GATE_CONTEXT_KIND = 'paperclip_factory_routing_gate_v1' as const;
const FACTORY_SCOUT_STEP_KEY = 'collect-and-classify';
const FACTORY_GATE_STEP_KEY = 'routing-decision';
const FACTORY_CLASSIFIER_DRONE_ID = 'portfolio-issue-classifier-v1';
const FACTORY_PORTFOLIO_SEED_KEY = 'minion-code:portfolio';
const FACTORY_DELIVERY_PIPELINE_NAME = 'MINION Code Delivery';
const MINIMUM_ROUTE_CONFIDENCE = 0.7;
const MAX_PROJECTS = 128;
const MAX_WORKSPACE_REFS_PER_PROJECT = 16;
const MAX_PRIOR_ISSUES = 12;
const MAX_DOCUMENTS = 8;
const MAX_EXCERPT_CHARS = 500;
export const FACTORY_CLASSIFIER_INPUT_MAX_CHARS = 180_000;

const ALLOWED_LABELS = [
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

const ALLOWED_SCOPES = [
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

const nonEmpty = z.string().trim().min(1);
const workspaceRefSchema = z
  .object({
    workspaceId: z.string().uuid(),
    repoUrl: nonEmpty.max(500),
    repoRef: nonEmpty.max(240),
    defaultRef: nonEmpty.max(240),
  })
  .strict();

const scoutEvidenceSchema = z
  .object({
    mode: z.literal('control_plane_metadata'),
    codeSearchExecuted: z.literal(false),
    projects: z
      .array(
        z
          .object({
            projectId: z.string().uuid(),
            key: nonEmpty.max(120),
            name: nonEmpty.max(240),
            repositoryKey: nonEmpty.max(120),
            groupKey: nonEmpty.max(120),
            scopes: z.array(z.enum(ALLOWED_SCOPES)).max(64),
            pathPrefixes: z.array(nonEmpty.max(500)).max(64),
            workspaceRefs: z.array(workspaceRefSchema).max(MAX_WORKSPACE_REFS_PER_PROJECT),
          })
          .strict(),
      )
      .max(MAX_PROJECTS),
    priorIssues: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            identifier: nonEmpty.max(120),
            title: nonEmpty.max(500),
            status: nonEmpty.max(64),
            projectId: z.string().uuid(),
            excerpt: nonEmpty.max(MAX_EXCERPT_CHARS),
          })
          .strict(),
      )
      .max(MAX_PRIOR_ISSUES),
    documents: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: nonEmpty.max(500),
            projectId: z.string().uuid(),
            issueId: z.string().uuid(),
            excerpt: nonEmpty.max(MAX_EXCERPT_CHARS),
          })
          .strict(),
      )
      .max(MAX_DOCUMENTS),
    bounds: z
      .object({
        maxProjects: z.literal(MAX_PROJECTS),
        maxWorkspaceRefsPerProject: z.literal(MAX_WORKSPACE_REFS_PER_PROJECT),
        maxPriorIssues: z.literal(MAX_PRIOR_ISSUES),
        maxDocuments: z.literal(MAX_DOCUMENTS),
        maxExcerptChars: z.literal(MAX_EXCERPT_CHARS),
      })
      .strict(),
    pendingCapabilities: z.tuple([z.literal('tool_bearing_code_search')]),
  })
  .strict();

const classifierProjectCandidateSchema = z
  .object({
    key: nonEmpty.max(120),
    name: nonEmpty.max(240),
    group: nonEmpty.max(120),
    repositories: z.array(nonEmpty.max(240)).min(1).max(32),
    scopes: z.array(z.enum(ALLOWED_SCOPES)).max(64),
    pathPrefixes: z.array(nonEmpty.max(500)).max(64).optional(),
    summary: nonEmpty.max(2_000).optional(),
  })
  .strict();

export const factoryClassifierInputSchema = z
  .object({
    issue: z
      .object({
        source: z.literal('paperclip'),
        externalId: nonEmpty.max(120),
        title: nonEmpty.max(500),
        body: nonEmpty.max(50_000),
        labels: z.array(nonEmpty.max(120)).max(64),
      })
      .strict(),
    allowedLabels: z.array(z.enum(ALLOWED_LABELS)),
    allowedScopes: z.array(z.enum(ALLOWED_SCOPES)),
    projectCandidates: z.array(classifierProjectCandidateSchema).min(1).max(MAX_PROJECTS),
    fallbackProjectKey: nonEmpty.max(120),
    scoutEvidence: scoutEvidenceSchema,
  })
  .strict();

export const factoryClassifierOutputSchema = z
  .object({
    labels: z.array(z.enum(ALLOWED_LABELS)).max(32),
    scopes: z.array(z.enum(ALLOWED_SCOPES)).max(32),
    projectKey: nonEmpty.max(120),
    projectGroup: nonEmpty.max(120).optional(),
    confidence: z.number().min(0).max(1),
    rationale: nonEmpty.max(2_000),
  })
  .strict();

const deliveryPipelineSnapshotSchema = z
  .object({
    pipelineId: z.string().uuid(),
    name: nonEmpty.max(120),
    description: z.string().nullable(),
    executionMode: z.literal('stage_tasks'),
    trigger: pipelineTriggerSchema.nullable(),
    steps: z.array(pipelineStepSchema).min(1),
  })
  .strict();

const candidateSchema = z
  .object({
    projectId: z.string().uuid(),
    key: nonEmpty.max(120),
    name: nonEmpty.max(240),
    repositoryKey: nonEmpty.max(120),
    groupKey: nonEmpty.max(120),
    scopes: z.array(z.enum(ALLOWED_SCOPES)).max(64),
    pathPrefixes: z.array(nonEmpty.max(500)).max(64),
    description: z.string().max(2_000),
    repositoryReference: nonEmpty.max(500),
    intakeFallback: z.boolean(),
  })
  .strict();

const routingTargetSchema = z.union([
  z.object({ type: z.literal('user'), userId: nonEmpty }).strict(),
  z.object({ type: z.literal('role'), roleKeys: z.array(nonEmpty).min(1).max(20) }).strict(),
]);

const factoryContextSchema = z
  .object({
    kind: z.literal(FACTORY_CONTEXT_KIND),
    companyId: z.string().uuid(),
    requesterUserId: nonEmpty,
    routingTarget: routingTargetSchema,
    request: nonEmpty.max(100_000),
    source: z
      .object({
        kind: z.literal('hub_assistant'),
        route: nonEmpty.max(500),
        selectedAgentId: z.string().uuid().optional(),
      })
      .strict(),
    portfolio: z.object({ id: z.string().uuid(), name: nonEmpty }).strict(),
    intakeProjectId: z.string().uuid(),
    classifierAgentId: z.string().uuid(),
    minimumConfidence: z.number().min(0).max(1),
    candidates: z.array(candidateSchema).min(1).max(MAX_PROJECTS),
    deliveryPipelineSnapshot: deliveryPipelineSnapshotSchema,
    scoutEvidence: scoutEvidenceSchema,
    classifierInput: factoryClassifierInputSchema,
    sourceKey: nonEmpty.max(500),
  })
  .strict();

const gateContextSchema = z
  .object({
    kind: z.literal(FACTORY_GATE_CONTEXT_KIND),
    factory: factoryContextSchema,
    classification: factoryClassifierOutputSchema,
    newProjectProposal: z
      .object({ name: nonEmpty.max(240), description: nonEmpty.max(4_000) })
      .strict(),
  })
  .strict();

const recordedFactoryRoutingDecisionSchema = z
  .object({
    kind: z.literal('factory_routing_decision_v1'),
    request: decideFactoryIntakeRoutingSchema,
    actorUserId: nonEmpty,
  })
  .strict();

const heartbeatContextSchema = z
  .object({
    kind: z.literal(FACTORY_CONTEXT_KIND),
    pipelineRunId: z.string().uuid(),
    stageTaskId: z.string().uuid(),
  })
  .strict();

type FactoryContext = z.infer<typeof factoryContextSchema>;
type FactoryCandidate = z.infer<typeof candidateSchema>;
type FactoryClassification = z.infer<typeof factoryClassifierOutputSchema>;
type FactoryHeartbeat = IssueAssignmentWakeupDeps;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truncate(value: string | null | undefined, max: number): string {
  const truncated = (value ?? '').slice(0, max);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function projectKey(name: string, metadata: unknown): string {
  const record = asRecord(metadata);
  const explicit =
    typeof record.factoryProjectKey === 'string' ? record.factoryProjectKey.trim() : '';
  if (explicit) return truncate(explicit, 120);
  const seed = typeof record.minionSeedKey === 'string' ? record.minionSeedKey.trim() : '';
  if (seed.startsWith('minion-code:project:'))
    return truncate(seed.slice('minion-code:project:'.length), 120);
  return truncate(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project',
    120,
  );
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter(
              (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
            )
            .map((entry) => entry.trim()),
        ),
      ]
    : [];
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateFromProject(
  project: typeof projects.$inferSelect,
  workspaces: Array<typeof projectWorkspaces.$inferSelect>,
): FactoryCandidate {
  const metadata = asRecord(project.metadata);
  const routing = asRecord(metadata.routing);
  const repositoryKey =
    typeof metadata.repositoryKey === 'string' && metadata.repositoryKey.trim()
      ? metadata.repositoryKey.trim()
      : routing.intakeFallback === true
        ? 'cross-repo'
        : 'unclassified';
  const groupKey =
    typeof metadata.groupKey === 'string' && metadata.groupKey.trim()
      ? metadata.groupKey.trim()
      : routing.intakeFallback === true
        ? 'intake'
        : repositoryKey;
  const repositoryReference =
    workspaces
      .map((workspace) => workspace.repoUrl?.trim())
      .find((value): value is string => Boolean(value)) ?? repositoryKey;
  return candidateSchema.parse({
    projectId: project.id,
    key: projectKey(project.name, metadata),
    name: project.name,
    repositoryKey,
    groupKey,
    scopes: metadataStrings(routing.scopes).filter(
      (scope): scope is (typeof ALLOWED_SCOPES)[number] =>
        (ALLOWED_SCOPES as readonly string[]).includes(scope),
    ),
    pathPrefixes: metadataStrings(routing.pathPrefixes),
    description: truncate(project.description ?? '', 2_000),
    repositoryReference,
    intakeFallback: routing.intakeFallback === true,
  });
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g)
      ?.slice(0, 80) ?? [],
  );
}

function relevance(query: Set<string>, ...values: Array<string | null | undefined>): number {
  if (query.size === 0) return 0;
  const corpus = tokens(values.filter(Boolean).join(' '));
  let score = 0;
  for (const token of query) if (corpus.has(token)) score += 1;
  return score;
}

function excerpt(value: string | null | undefined, fallback: string): string {
  return truncate(value?.trim() || fallback.trim() || 'No additional context', MAX_EXCERPT_CHARS);
}

async function collectScoutEvidence(
  db: Db,
  companyId: string,
  request: string,
  projectRows: Array<typeof projects.$inferSelect>,
  workspaceRows: Array<typeof projectWorkspaces.$inferSelect>,
): Promise<FactoryScoutEvidence> {
  const projectIds = projectRows.map((project) => project.id);
  const workspaceByProject = new Map<string, Array<typeof projectWorkspaces.$inferSelect>>();
  for (const workspace of workspaceRows) {
    const current = workspaceByProject.get(workspace.projectId) ?? [];
    current.push(workspace);
    workspaceByProject.set(workspace.projectId, current);
  }
  const candidates = projectRows
    .map((project) => candidateFromProject(project, workspaceByProject.get(project.id) ?? []))
    .sort(
      (left, right) =>
        stableCompare(left.key, right.key) || stableCompare(left.projectId, right.projectId),
    );
  const query = tokens(request);
  const [recentIssues, recentDocuments] =
    projectIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              description: issues.description,
              status: issues.status,
              projectId: issues.projectId,
              updatedAt: issues.updatedAt,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.projectId, projectIds),
                isNull(issues.hiddenAt),
              ),
            )
            .orderBy(desc(issues.updatedAt))
            .limit(100),
          db
            .select({
              id: documents.id,
              title: documents.title,
              body: documents.latestBody,
              issueId: issueDocuments.issueId,
              projectId: issues.projectId,
              updatedAt: documents.updatedAt,
            })
            .from(documents)
            .innerJoin(
              issueDocuments,
              and(
                eq(issueDocuments.documentId, documents.id),
                eq(issueDocuments.companyId, companyId),
              ),
            )
            .innerJoin(
              issues,
              and(eq(issues.id, issueDocuments.issueId), eq(issues.companyId, companyId)),
            )
            .where(
              and(
                eq(documents.companyId, companyId),
                inArray(issues.projectId, projectIds),
                isNull(issues.hiddenAt),
              ),
            )
            .orderBy(desc(documents.updatedAt))
            .limit(80),
        ]);

  return scoutEvidenceSchema.parse({
    mode: 'control_plane_metadata',
    codeSearchExecuted: false,
    projects: candidates.map((candidate) => ({
      projectId: candidate.projectId,
      key: candidate.key,
      name: candidate.name,
      repositoryKey: candidate.repositoryKey,
      groupKey: candidate.groupKey,
      scopes: candidate.scopes,
      pathPrefixes: candidate.pathPrefixes,
      workspaceRefs: (workspaceByProject.get(candidate.projectId) ?? [])
        .filter((workspace) =>
          Boolean(
            workspace.repoUrl?.trim() && workspace.repoRef?.trim() && workspace.defaultRef?.trim(),
          ),
        )
        .slice(0, MAX_WORKSPACE_REFS_PER_PROJECT)
        .map((workspace) => ({
          workspaceId: workspace.id,
          repoUrl: truncate(workspace.repoUrl!.trim(), 500),
          repoRef: truncate(workspace.repoRef!.trim(), 240),
          defaultRef: truncate(workspace.defaultRef!.trim(), 240),
        })),
    })),
    priorIssues: recentIssues
      .filter((issue): issue is typeof issue & { projectId: string } => Boolean(issue.projectId))
      .map((issue) => ({ issue, score: relevance(query, issue.title, issue.description) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.issue.updatedAt.getTime() - left.issue.updatedAt.getTime() ||
          stableCompare(left.issue.id, right.issue.id),
      )
      .slice(0, MAX_PRIOR_ISSUES)
      .map(({ issue }) => ({
        id: issue.id,
        identifier: truncate(issue.identifier?.trim() || issue.id, 120),
        title: truncate(issue.title, 500),
        status: truncate(issue.status, 64),
        projectId: issue.projectId,
        excerpt: excerpt(issue.description, issue.title),
      })),
    documents: recentDocuments
      .filter((document): document is typeof document & { projectId: string } =>
        Boolean(document.projectId && document.body.trim()),
      )
      .map((document) => ({ document, score: relevance(query, document.title, document.body) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.document.updatedAt.getTime() - left.document.updatedAt.getTime() ||
          stableCompare(left.document.id, right.document.id),
      )
      .slice(0, MAX_DOCUMENTS)
      .map(({ document }) => ({
        id: document.id,
        title: truncate(document.title?.trim() || 'Untitled document', 500),
        projectId: document.projectId,
        issueId: document.issueId,
        excerpt: excerpt(document.body, document.title ?? 'Untitled document'),
      })),
    bounds: {
      maxProjects: MAX_PROJECTS,
      maxWorkspaceRefsPerProject: MAX_WORKSPACE_REFS_PER_PROJECT,
      maxPriorIssues: MAX_PRIOR_ISSUES,
      maxDocuments: MAX_DOCUMENTS,
      maxExcerptChars: MAX_EXCERPT_CHARS,
    },
    pendingCapabilities: ['tool_bearing_code_search'],
  });
}

async function loadFactoryResources(db: Db, companyId: string, request: string) {
  const portfolioRows = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.companyId, companyId), eq(portfolios.status, 'active')));
  const canonicalPortfolios = portfolioRows.filter(
    (row) =>
      asRecord(row.metadata).minionSeedKey === FACTORY_PORTFOLIO_SEED_KEY ||
      row.name.trim().toLowerCase() === 'minion code',
  );
  if (canonicalPortfolios.length !== 1) {
    throw new Error(
      `Expected exactly one active MINION Code portfolio; found ${canonicalPortfolios.length}`,
    );
  }
  const portfolio = canonicalPortfolios[0]!;

  const [projectRows, pipelineRows, agentRows] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.companyId, companyId),
          eq(projects.portfolioId, portfolio.id),
          isNull(projects.archivedAt),
        ),
      ),
    db
      .select()
      .from(pipelines)
      .where(
        and(
          eq(pipelines.companyId, companyId),
          eq(pipelines.name, FACTORY_DELIVERY_PIPELINE_NAME),
          isNull(pipelines.archivedAt),
        ),
      ),
    db.select().from(agents).where(eq(agents.companyId, companyId)),
  ]);
  if (projectRows.length === 0) throw new Error('MINION Code portfolio has no production lines');
  if (projectRows.length > MAX_PROJECTS) {
    throw new Error(
      `MINION Code portfolio exceeds the bounded ${MAX_PROJECTS}-project intake limit`,
    );
  }
  if (pipelineRows.length !== 1) {
    throw new Error(
      `Expected exactly one active ${FACTORY_DELIVERY_PIPELINE_NAME} pipeline; found ${pipelineRows.length}`,
    );
  }
  const pipeline = pipelineRows[0]!;
  if (pipeline.executionMode !== 'stage_tasks') {
    throw new Error('MINION Code delivery pipeline must use stage-task execution');
  }
  const classifiers = agentRows.filter(
    (row) => asRecord(row.metadata).harnessRoleKey === 'classifier',
  );
  if (classifiers.length !== 1) {
    throw new Error(
      `Expected exactly one MINION Code classifier agent; found ${classifiers.length}`,
    );
  }
  const classifier = classifiers[0]!;
  if (
    classifier.adapterType !== 'minion_drone' ||
    asRecord(classifier.adapterConfig).droneId !== FACTORY_CLASSIFIER_DRONE_ID
  ) {
    throw new Error(`MINION Code classifier must use minion_drone:${FACTORY_CLASSIFIER_DRONE_ID}`);
  }
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        inArray(
          projectWorkspaces.projectId,
          projectRows.map((row) => row.id),
        ),
      ),
    );
  projectRows.sort(
    (left, right) =>
      stableCompare(projectKey(left.name, left.metadata), projectKey(right.name, right.metadata)) ||
      stableCompare(left.id, right.id),
  );
  workspaceRows.sort(
    (left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) || stableCompare(left.id, right.id),
  );
  const byProject = new Map<string, Array<typeof projectWorkspaces.$inferSelect>>();
  for (const workspace of workspaceRows) {
    const current = byProject.get(workspace.projectId) ?? [];
    current.push(workspace);
    byProject.set(workspace.projectId, current);
  }
  const candidates = projectRows.map((row) =>
    candidateFromProject(row, byProject.get(row.id) ?? []),
  );
  const duplicateKeys = [
    ...new Set(
      candidates
        .map((candidate) => candidate.key)
        .filter((key, index, keys) => keys.indexOf(key) !== index),
    ),
  ];
  if (duplicateKeys.length > 0) {
    throw new Error(`MINION Code production-line keys must be unique: ${duplicateKeys.join(', ')}`);
  }
  const intakeCandidates = candidates.filter((candidate) => candidate.intakeFallback);
  if (intakeCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one governed intake fallback project; found ${intakeCandidates.length}`,
    );
  }
  const intake = intakeCandidates[0]!;
  const deliveryPipelineSnapshot = deliveryPipelineSnapshotSchema.parse({
    pipelineId: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    executionMode: 'stage_tasks',
    trigger: pipeline.trigger,
    steps: pipeline.steps,
  });
  const scoutEvidence = await collectScoutEvidence(
    db,
    companyId,
    request,
    projectRows,
    workspaceRows,
  );
  return {
    portfolio,
    projectRows,
    pipeline,
    classifier,
    candidates,
    intake,
    deliveryPipelineSnapshot,
    scoutEvidence,
  };
}

function normalizeRoutingTarget(
  requested: CreateFactoryIntake['routingTarget'],
  requesterUserId: string,
  requesterRoleKeys: string[],
): PipelineInboxTarget {
  if (!requested || requested.type === 'user') return { type: 'user', userId: requesterUserId };
  const trusted = new Set(requesterRoleKeys);
  if (requested.roleKeys.some((roleKey) => !trusted.has(roleKey))) {
    throw new Error('Routing target roles must be present in the signed Hub identity');
  }
  return { type: 'role', roleKeys: [...new Set(requested.roleKeys)] };
}

function intakeOriginId(
  companyId: string,
  requesterUserId: string,
  idempotencyKey: string,
): string {
  return `hub-assistant:${createHash('sha256').update(`${companyId}:${requesterUserId}:${idempotencyKey}`).digest('hex')}`;
}

function postgresErrorCode(error: unknown): string | null {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth += 1) {
    const record = cursor as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return record.code;
    cursor = record.cause;
  }
  return null;
}

async function createOrReuseRootIssue(input: {
  db: Db;
  companyId: string;
  requesterUserId: string;
  intakeProjectId: string;
  request: string;
  originId: string;
}) {
  const validateExisting = (existing: typeof issues.$inferSelect) => {
    if (
      existing.createdByUserId !== input.requesterUserId ||
      existing.description !== input.request
    ) {
      throw new Error('Idempotency key is already bound to a different factory request');
    }
    return existing;
  };
  const findExisting = () =>
    input.db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, 'paperclip'),
          eq(issues.originId, input.originId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  const existing = await findExisting();
  if (existing) {
    return { issue: validateExisting(existing), created: false };
  }
  try {
    const issue = await issueService(input.db).create(input.companyId, {
      projectId: input.intakeProjectId,
      title: truncate(input.request.split(/\r?\n/, 1)[0]?.trim() || 'New factory request', 240),
      description: input.request,
      status: 'todo',
      priority: 'medium',
      originKind: 'paperclip',
      originId: input.originId,
      originFingerprint: 'hub-assistant',
      createdByUserId: input.requesterUserId,
    });
    return { issue, created: true };
  } catch (error) {
    if (postgresErrorCode(error) !== '23505') throw error;
    const raced = await findExisting();
    if (!raced) throw error;
    return { issue: validateExisting(raced), created: false };
  }
}

function classifierInput(
  rootIssueId: string,
  request: string,
  candidates: FactoryCandidate[],
  intake: FactoryCandidate,
  scoutEvidence: FactoryScoutEvidence,
) {
  const projectCandidates = candidates.map((candidate) => ({
    key: candidate.key,
    name: candidate.name,
    group: candidate.groupKey,
    repositories: candidate.intakeFallback ? ['*'] : [candidate.repositoryKey],
    scopes: [...new Set(candidate.scopes)],
  }));
  const boundedEvidence: FactoryScoutEvidence = {
    ...scoutEvidence,
    projects: [],
    priorIssues: [],
    documents: [],
  };
  const issueTitle = truncate(request.split(/\r?\n/, 1)[0]?.trim() || 'New factory request', 500);
  const build = (body: string) => ({
    issue: {
      source: 'paperclip',
      externalId: rootIssueId,
      title: issueTitle,
      body,
      labels: [],
    },
    allowedLabels: [...ALLOWED_LABELS],
    allowedScopes: [...ALLOWED_SCOPES],
    projectCandidates,
    fallbackProjectKey: intake.key,
    scoutEvidence: boundedEvidence,
  });
  const fixedChars = JSON.stringify(build('x')).length - 1;
  const bodyBudget = Math.min(
    50_000,
    Math.max(1, FACTORY_CLASSIFIER_INPUT_MAX_CHARS - fixedChars - 1_000),
  );
  const body = truncate(request, bodyBudget);
  const fitsBudget = () => JSON.stringify(build(body)).length <= FACTORY_CLASSIFIER_INPUT_MAX_CHARS;

  for (const project of scoutEvidence.projects) {
    const boundedProject = {
      ...project,
      pathPrefixes: [] as string[],
      workspaceRefs: [] as typeof project.workspaceRefs,
    };
    boundedEvidence.projects.push(boundedProject);
    if (!fitsBudget()) {
      boundedEvidence.projects.pop();
      break;
    }
    for (const pathPrefix of project.pathPrefixes) {
      boundedProject.pathPrefixes.push(pathPrefix);
      if (!fitsBudget()) {
        boundedProject.pathPrefixes.pop();
        break;
      }
    }
    for (const workspaceRef of project.workspaceRefs) {
      boundedProject.workspaceRefs.push(workspaceRef);
      if (!fitsBudget()) {
        boundedProject.workspaceRefs.pop();
        break;
      }
    }
  }
  for (const priorIssue of scoutEvidence.priorIssues) {
    boundedEvidence.priorIssues.push(priorIssue);
    if (!fitsBudget()) {
      boundedEvidence.priorIssues.pop();
      break;
    }
  }
  for (const document of scoutEvidence.documents) {
    boundedEvidence.documents.push(document);
    if (!fitsBudget()) {
      boundedEvidence.documents.pop();
      break;
    }
  }
  const parsed = factoryClassifierInputSchema.parse(build(body));
  if (JSON.stringify(parsed).length > FACTORY_CLASSIFIER_INPUT_MAX_CHARS) {
    throw new Error('Factory classifier input exceeds its deterministic serialized budget');
  }
  return parsed;
}

async function queueFactoryClassifier(input: {
  heartbeat: FactoryHeartbeat;
  classifierAgentId: string;
  runId: string;
  stageTaskId: string;
  classifierInput: z.infer<typeof factoryClassifierInputSchema>;
}) {
  return input.heartbeat.wakeup(input.classifierAgentId, {
    source: 'assignment',
    triggerDetail: 'manual',
    reason: 'paperclip_factory_intake',
    payload: { issueId: input.stageTaskId, mutation: 'factory_intake_materialized' },
    idempotencyKey: `factory-intake:${input.runId}`,
    requestedByActorType: 'system',
    requestedByActorId: 'factory-intake',
    contextSnapshot: {
      issueId: input.stageTaskId,
      taskId: input.stageTaskId,
      source: 'paperclip.factory-intake',
      paperclipDrone: { input: input.classifierInput },
      factoryIntake: {
        kind: FACTORY_CONTEXT_KIND,
        pipelineRunId: input.runId,
        stageTaskId: input.stageTaskId,
      },
    },
  });
}

function newProjectProposal(request: string) {
  const words = request.replace(/\s+/g, ' ').trim().split(' ').slice(0, 10).join(' ');
  return {
    name: truncate(words || 'New production line', 120),
    description: truncate(request, 4_000),
  };
}

function routingSnapshot(input: {
  context: FactoryContext;
  classification: FactoryClassification | null;
  project: FactoryCandidate;
  resolution: IssuePipelineRoutingSnapshot['resolution'];
  reason: string;
  intakeContext?: Record<string, unknown>;
}): IssuePipelineRoutingSnapshot {
  return {
    repository: input.project.repositoryReference,
    originalLabels: [],
    inferredLabels: input.classification?.labels ?? [],
    classifierOutput: input.classification ? { ...input.classification } : null,
    candidates: input.context.candidates.map((candidate) => ({
      portfolioId: input.context.portfolio.id,
      projectId: candidate.projectId,
      repository: candidate.repositoryReference,
      scope: candidate.scopes.join(',') || null,
      matchedRule: candidate.key,
      confidence:
        candidate.projectId === input.project.projectId
          ? (input.classification?.confidence ?? null)
          : null,
      reason: candidate.projectId === input.project.projectId ? input.reason : 'factory_candidate',
    })),
    selectedPortfolioId: input.context.portfolio.id,
    selectedProjectId: input.project.projectId,
    confidence: input.classification?.confidence ?? null,
    resolution: input.resolution,
    reason: input.reason,
    ...(input.intakeContext ? { intakeContext: input.intakeContext } : {}),
  };
}

async function startDelivery(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  rootIssueId: string;
  context: FactoryContext;
  classification: FactoryClassification;
  project: FactoryCandidate;
  resolution: 'rule' | 'override';
  reason: string;
}) {
  const orchestrator = issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db));
  const started = await orchestrator.start({
    companyId: input.context.companyId,
    selectedProjectId: input.project.projectId,
    issueId: input.rootIssueId,
    sourceKey: `factory-delivery:${input.context.sourceKey}`,
    pipelineSnapshot: input.context.deliveryPipelineSnapshot,
    routingSnapshot: routingSnapshot({
      context: input.context,
      classification: input.classification,
      project: input.project,
      resolution: input.resolution,
      reason: input.reason,
      intakeContext: input.context,
    }),
  });
  try {
    await queuePipelineStageTaskWakeup({
      db: input.db,
      heartbeat: input.heartbeat,
      run: started.run,
      stageTask: started.stageTask,
      requestedByActorType: 'system',
      requestedByActorId: 'factory-intake',
    });
  } catch (error) {
    await blockPipelineDroneDispatchFailure({
      db: input.db,
      run: started.run,
      stageTask: started.stageTask,
      error,
    });
  }
  return started;
}

async function materializeRoutingGate(input: {
  db: Db;
  rootIssueId: string;
  context: FactoryContext;
  classification: FactoryClassification;
  reason: string;
}) {
  const intake = input.context.candidates.find(
    (candidate) => candidate.projectId === input.context.intakeProjectId,
  );
  if (!intake) throw new Error('Frozen intake candidate is unavailable');
  const gateContext = gateContextSchema.parse({
    kind: FACTORY_GATE_CONTEXT_KIND,
    factory: input.context,
    classification: input.classification,
    newProjectProposal: newProjectProposal(input.context.request),
  });
  const snapshot: IssuePipelineSnapshot = {
    pipelineId: input.context.deliveryPipelineSnapshot.pipelineId,
    name: 'Factory routing approval',
    description: 'Human governance for ambiguous routing or a proposed production line.',
    executionMode: 'stage_tasks',
    trigger: { originKinds: ['paperclip'] },
    steps: [
      {
        key: FACTORY_GATE_STEP_KEY,
        kind: 'approval',
        label: 'Approve production line routing',
        participant: input.context.routingTarget,
      },
    ],
  };
  return issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db)).start({
    companyId: input.context.companyId,
    selectedProjectId: intake.projectId,
    issueId: input.rootIssueId,
    sourceKey: `factory-gate:${input.context.sourceKey}`,
    pipelineSnapshot: snapshot,
    routingSnapshot: routingSnapshot({
      context: input.context,
      classification: input.classification,
      project: intake,
      resolution: 'intake_fallback',
      reason: input.reason,
      intakeContext: gateContext,
    }),
  });
}

function heartbeatTrace(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    'id' | 'harnessRevisionId' | 'resolvedAdapterType' | 'resolvedModel' | 'resolvedProvider'
  >,
) {
  return {
    heartbeatRunId: run.id,
    harnessRevisionId: run.harnessRevisionId,
    resolvedAdapterType: run.resolvedAdapterType,
    resolvedModel: run.resolvedModel,
    resolvedProvider: run.resolvedProvider,
  };
}

function classificationLabelColor(name: string): string {
  if (name === 'bug') return '#ef4444';
  if (name === 'security' || name === 'critical') return '#dc2626';
  if (name === 'feature') return '#22c55e';
  if (name === 'high') return '#f97316';
  if (name === 'medium') return '#eab308';
  if (name === 'low') return '#3b82f6';
  return name.startsWith('scope:') ? '#8b5cf6' : '#64748b';
}

async function persistFactoryClassificationLabels(input: {
  db: Db;
  companyId: string;
  issueId: string;
  classification: FactoryClassification;
}) {
  const names = [
    ...new Set([
      ...input.classification.labels.map((label) => label.toLowerCase()),
      ...input.classification.scopes.map((scope) => `scope:${scope.toLowerCase()}`),
    ]),
  ].sort();
  if (names.length === 0) return;
  await input.db
    .insert(labels)
    .values(
      names.map((name) => ({
        companyId: input.companyId,
        name,
        color: classificationLabelColor(name),
      })),
    )
    .onConflictDoNothing({ target: [labels.companyId, labels.name] });
  const labelIds = await input.db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, input.companyId), inArray(labels.name, names)))
    .then((rows) => rows.map((row) => row.id));
  const root = await issueService(input.db).getById(input.issueId);
  if (!root) throw new Error(`Factory intake root issue not found: ${input.issueId}`);
  await issueService(input.db).update(root.id, {
    labelIds: [...new Set([...(root.labelIds ?? []), ...labelIds])],
  });
}

/** Exactly-once terminal bridge from the metadata classifier to routing or HITL. */
export async function finalizeFactoryIntakeScoutHeartbeat(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  run: typeof heartbeatRuns.$inferSelect;
}) {
  const heartbeatContext = heartbeatContextSchema.safeParse(
    asRecord(input.run.contextSnapshot).factoryIntake,
  );
  if (!heartbeatContext.success) return { handled: false as const };
  const run = await issuePipelineOrchestratorRepository(input.db).getRun(
    heartbeatContext.data.pipelineRunId,
  );
  if (!run || run.companyId !== input.run.companyId) {
    throw new Error(
      `Factory intake pipeline run not found: ${heartbeatContext.data.pipelineRunId}`,
    );
  }
  const context = factoryContextSchema.parse(run.routingSnapshot.intakeContext);
  if (input.run.agentId !== context.classifierAgentId) {
    throw new Error('Factory intake heartbeat was not executed by the frozen classifier agent');
  }
  const stageTask = await input.db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.id, heartbeatContext.data.stageTaskId),
        eq(issues.companyId, run.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, run.id),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!stageTask) throw new Error('Factory intake classifier stage task was not found');

  const orchestrator = issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db));
  if (input.run.status !== 'succeeded') {
    const updated = await orchestrator.completeStageTask({
      runId: run.id,
      stageTaskId: stageTask.id,
      terminalStatus: 'blocked',
      summary: `Factory metadata classification failed: ${input.run.error ?? input.run.errorCode ?? input.run.status}`,
      trace: {
        ...heartbeatTrace(input.run),
        inputSnapshot: context.classifierInput,
        outputSnapshot: { status: 'heartbeat_failed', codeSearchExecuted: false },
      },
    });
    return { handled: true as const, state: 'failed' as const, run: updated };
  }

  const result = asRecord(input.run.resultJson);
  const parsed = factoryClassifierOutputSchema.safeParse(result.output);
  if (!parsed.success || result.droneId !== FACTORY_CLASSIFIER_DRONE_ID) {
    const updated = await orchestrator.completeStageTask({
      runId: run.id,
      stageTaskId: stageTask.id,
      terminalStatus: 'blocked',
      summary: 'Factory metadata classifier returned output outside the frozen contract',
      trace: {
        ...heartbeatTrace(input.run),
        inputSnapshot: context.classifierInput,
        outputSnapshot: {
          status: 'invalid_output',
          expectedDroneId: FACTORY_CLASSIFIER_DRONE_ID,
          codeSearchExecuted: false,
          validationIssues: parsed.success
            ? []
            : parsed.error.issues.slice(0, 12).map((issue) => ({
                path: issue.path.map(String).join('.'),
                message: issue.message,
              })),
        },
      },
    });
    return { handled: true as const, state: 'failed' as const, run: updated };
  }
  const classification = parsed.data;
  const downstream = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(
        eq(issuePipelineRuns.companyId, run.companyId),
        eq(issuePipelineRuns.issueId, run.issueId),
        inArray(issuePipelineRuns.sourceOriginId, [
          `factory-delivery:${context.sourceKey}`,
          `factory-gate:${context.sourceKey}`,
        ]),
      ),
    )
    .orderBy(desc(issuePipelineRuns.createdAt))
    .then((rows) => rows[0] ?? null);
  if (downstream) {
    return {
      handled: true as const,
      state: downstream.sourceOriginId.startsWith('factory-delivery:')
        ? ('pipeline_active' as const)
        : ('awaiting_routing_approval' as const),
      run: downstream,
    };
  }
  await persistFactoryClassificationLabels({
    db: input.db,
    companyId: run.companyId,
    issueId: run.issueId,
    classification,
  });
  const candidate =
    context.candidates.find((entry) => entry.key === classification.projectKey) ?? null;
  const isAutomatic = Boolean(
    candidate &&
    !candidate.intakeFallback &&
    classification.confidence >= context.minimumConfidence,
  );
  await orchestrator.completeStageTask({
    runId: run.id,
    stageTaskId: stageTask.id,
    terminalStatus: 'done',
    outcome: 'passed',
    summary: classification.rationale,
    trace: {
      ...heartbeatTrace(input.run),
      inputSnapshot: context.classifierInput,
      outputSnapshot: {
        status: 'validated',
        codeSearchExecuted: false,
        validatedOutput: classification,
      },
      decisionSnapshot: {
        automatic: isAutomatic,
        selectedProjectId: isAutomatic ? candidate!.projectId : context.intakeProjectId,
        reason: isAutomatic ? 'high_confidence_existing_project' : 'human_routing_required',
      },
    },
  });

  if (isAutomatic && candidate) {
    const delivery = await startDelivery({
      db: input.db,
      heartbeat: input.heartbeat,
      rootIssueId: run.issueId,
      context,
      classification,
      project: candidate,
      resolution: 'rule',
      reason: `classifier_project: ${classification.rationale}`,
    });
    return { handled: true as const, state: 'pipeline_active' as const, run: delivery.run };
  }
  const gate = await materializeRoutingGate({
    db: input.db,
    rootIssueId: run.issueId,
    context,
    classification,
    reason: candidate
      ? `confidence ${classification.confidence} requires human routing approval`
      : `classifier proposed unknown project key ${classification.projectKey}`,
  });
  return { handled: true as const, state: 'awaiting_routing_approval' as const, run: gate.run };
}

async function createNewProjectFromDecision(input: {
  db: Db;
  companyId: string;
  rootIssueId: string;
  portfolioId: string;
  decision: Extract<DecideFactoryIntakeRouting['decision'], { kind: 'new_project' }>;
  candidates: FactoryCandidate[];
}) {
  const template = input.candidates.find(
    (candidate) =>
      candidate.repositoryKey === input.decision.repositoryKey && !candidate.intakeFallback,
  );
  if (!template)
    throw new Error(
      'New production lines must use a repository already registered in the portfolio',
    );
  const templateProject = await projectService(input.db).getById(template.projectId);
  if (!templateProject) throw new Error('New production-line repository template was not found');
  const id = stableFactoryProjectId(input.companyId, input.rootIssueId);
  let created = await projectService(input.db).getById(id);
  if (!created) {
    try {
      created = await projectService(input.db).create(input.companyId, {
        id,
        portfolioId: input.portfolioId,
        name: input.decision.name,
        description:
          input.decision.description ?? `Production line created from ${input.rootIssueId}.`,
        status: 'in_progress',
        metadata: {
          factoryProjectKey: `factory-${id.slice(0, 8)}`,
          repositoryKey: input.decision.repositoryKey,
          groupKey: input.decision.groupKey ?? template.groupKey,
          routing: {
            scopes: input.decision.scopes ?? [],
            pathPrefixes: [],
          },
        },
        executionWorkspacePolicy: null,
      });
    } catch (error) {
      if (postgresErrorCode(error) !== '23505') throw error;
      created = await projectService(input.db).getById(id);
      if (!created) throw error;
    }
  }
  let workspace = created.primaryWorkspace;
  if (!workspace && templateProject.primaryWorkspace) {
    const source = templateProject.primaryWorkspace;
    workspace = await projectService(input.db).createWorkspace(created.id, {
      name: `${created.name} primary`,
      sourceType: source.sourceType,
      cwd: source.cwd,
      repoUrl: source.repoUrl,
      repoRef: source.repoRef,
      defaultRef: source.defaultRef,
      visibility: source.visibility,
      setupCommand: source.setupCommand,
      cleanupCommand: source.cleanupCommand,
      remoteProvider: source.remoteProvider,
      remoteWorkspaceRef: source.remoteWorkspaceRef,
      sharedWorkspaceKey: source.sharedWorkspaceKey,
      metadata: source.metadata,
      isPrimary: true,
    });
  }
  if (workspace && templateProject.executionWorkspacePolicy) {
    await projectService(input.db).update(created.id, {
      executionWorkspacePolicy: {
        ...templateProject.executionWorkspacePolicy,
        defaultProjectWorkspaceId: workspace.id,
      },
    });
  }
  const hydrated = await projectService(input.db).getById(created.id);
  if (!hydrated) throw new Error('Created production line could not be reloaded');
  return { project: hydrated, template };
}

function stableFactoryProjectId(companyId: string, rootIssueId: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`factory-project:${companyId}:${rootIssueId}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function candidateForCreatedProject(
  project: Awaited<ReturnType<ReturnType<typeof projectService>['getById']>>,
  template: FactoryCandidate,
): FactoryCandidate {
  if (!project) throw new Error('Created project is unavailable');
  return candidateSchema.parse({
    projectId: project.id,
    key: projectKey(project.name, project.metadata),
    name: project.name,
    repositoryKey: asRecord(project.metadata).repositoryKey ?? template.repositoryKey,
    groupKey: asRecord(project.metadata).groupKey ?? template.groupKey,
    scopes: metadataStrings(asRecord(asRecord(project.metadata).routing).scopes).filter(
      (scope): scope is (typeof ALLOWED_SCOPES)[number] =>
        (ALLOWED_SCOPES as readonly string[]).includes(scope),
    ),
    pathPrefixes: [],
    description: truncate(project.description ?? '', 2_000),
    repositoryReference: project.primaryWorkspace?.repoUrl ?? template.repositoryReference,
    intakeFallback: false,
  });
}

function normalizedRoutingDecision(value: DecideFactoryIntakeRouting): DecideFactoryIntakeRouting {
  const parsed = decideFactoryIntakeRoutingSchema.parse(value);
  return { decision: parsed.decision, note: parsed.note ?? null };
}

function sameRoutingDecision(
  left: DecideFactoryIntakeRouting,
  right: DecideFactoryIntakeRouting,
): boolean {
  return (
    JSON.stringify(normalizedRoutingDecision(left)) ===
    JSON.stringify(normalizedRoutingDecision(right))
  );
}

async function recordedRoutingDecision(db: Db, gateRunId: string, gateIssueId: string) {
  const event = await db
    .select({ decision: issuePipelineEvents.decisionSnapshot })
    .from(issuePipelineEvents)
    .where(
      and(
        eq(issuePipelineEvents.pipelineRunId, gateRunId),
        eq(issuePipelineEvents.eventKey, `stage-terminal:${gateIssueId}`),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!event) return null;
  return recordedFactoryRoutingDecisionSchema.parse(event.decision);
}

function assertDecisionUsesFrozenRouting(
  decision: DecideFactoryIntakeRouting,
  context: z.infer<typeof gateContextSchema>,
): void {
  if (decision.decision.kind === 'existing_project') {
    const selected = decision.decision;
    const candidate = context.factory.candidates.find(
      (entry) => entry.projectId === selected.projectId,
    );
    if (!candidate || candidate.intakeFallback) {
      throw new Error('Routing decisions may only select a frozen production-line candidate');
    }
    return;
  }
  if (decision.decision.kind === 'new_project') {
    const selected = decision.decision;
    const template = context.factory.candidates.find(
      (candidate) =>
        candidate.repositoryKey === selected.repositoryKey && !candidate.intakeFallback,
    );
    if (!template) {
      throw new Error(
        'New production lines must use a repository already registered in the frozen portfolio',
      );
    }
  }
}

async function reconcileRecordedRoutingDecision(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  root: typeof issues.$inferSelect;
  gateRun: typeof issuePipelineRuns.$inferSelect;
  gateContext: z.infer<typeof gateContextSchema>;
  recorded: z.infer<typeof recordedFactoryRoutingDecisionSchema>;
}) {
  const decision = input.recorded.request;
  if (decision.decision.kind === 'reject') {
    const current = await input.db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, input.root.id), eq(issues.companyId, input.root.companyId)))
      .then((rows) => rows[0] ?? null);
    if (current?.status !== 'cancelled') {
      await issueService(input.db).update(input.root.id, { status: 'cancelled' });
      await logActivity(input.db, {
        companyId: input.root.companyId,
        actorType: 'user',
        actorId: input.recorded.actorUserId,
        action: 'factory_intake.routing_rejected',
        entityType: 'issue',
        entityId: input.root.id,
        details: { gateRunId: input.gateRun.id, codeSearchExecuted: false },
      });
    }
    return;
  }

  const existingDelivery = await input.db
    .select({ id: issuePipelineRuns.id })
    .from(issuePipelineRuns)
    .where(
      and(
        eq(issuePipelineRuns.companyId, input.root.companyId),
        eq(issuePipelineRuns.issueId, input.root.id),
        eq(
          issuePipelineRuns.sourceOriginId,
          `factory-delivery:${input.gateContext.factory.sourceKey}`,
        ),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existingDelivery) return;

  let selected: FactoryCandidate;
  let decisionKind: 'existing_project' | 'new_project';
  if (decision.decision.kind === 'existing_project') {
    const projectId = decision.decision.projectId;
    const candidate = input.gateContext.factory.candidates.find(
      (entry) => entry.projectId === projectId,
    );
    if (!candidate || candidate.intakeFallback) {
      throw new Error('Recorded factory routing references an unavailable frozen production line');
    }
    selected = candidate;
    decisionKind = 'existing_project';
  } else {
    const newProjectDecision = decision.decision;
    const created = await createNewProjectFromDecision({
      db: input.db,
      companyId: input.root.companyId,
      rootIssueId: input.root.id,
      portfolioId: input.gateContext.factory.portfolio.id,
      decision: newProjectDecision,
      candidates: input.gateContext.factory.candidates,
    });
    selected = candidateForCreatedProject(created.project, created.template);
    decisionKind = 'new_project';
  }

  const delivery = await startDelivery({
    db: input.db,
    heartbeat: input.heartbeat,
    rootIssueId: input.root.id,
    context: {
      ...input.gateContext.factory,
      candidates: input.gateContext.factory.candidates.some(
        (candidate) => candidate.projectId === selected.projectId,
      )
        ? input.gateContext.factory.candidates
        : [...input.gateContext.factory.candidates, selected],
    },
    classification: {
      ...input.gateContext.classification,
      projectKey: selected.key,
      projectGroup: selected.groupKey,
      rationale: decision.note?.trim() || `Human approved ${selected.name}`,
      confidence: 1,
    },
    project: selected,
    resolution: 'override',
    reason: `human_${decisionKind}: ${decision.note?.trim() || selected.name}`,
  });
  if (delivery.created) {
    await logActivity(input.db, {
      companyId: input.root.companyId,
      actorType: 'user',
      actorId: input.recorded.actorUserId,
      action:
        decisionKind === 'new_project'
          ? 'factory_intake.project_created'
          : 'factory_intake.routing_approved',
      entityType: 'issue',
      entityId: input.root.id,
      details: {
        gateRunId: input.gateRun.id,
        projectId: selected.projectId,
        projectKey: selected.key,
        codeSearchExecuted: false,
      },
    });
  }
}

export async function decideFactoryIntakeRouting(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  issueId: string;
  actor: PipelineHitlTerminalActor;
  decision: DecideFactoryIntakeRouting;
}) {
  const root = await input.db
    .select()
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (!root || root.originKind !== 'paperclip') throw new Error('Factory intake not found');
  const runs = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(eq(issuePipelineRuns.companyId, root.companyId), eq(issuePipelineRuns.issueId, root.id)),
    )
    .orderBy(desc(issuePipelineRuns.createdAt));
  const gateRun = runs.find(
    (run) => gateContextSchema.safeParse(run.routingSnapshot.intakeContext).success,
  );
  if (!gateRun) throw new Error('Factory routing approval is not pending');
  const gate = await input.db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, root.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, gateRun.id),
        eq(issues.originFingerprint, `${FACTORY_GATE_STEP_KEY}:1`),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!gate) throw new Error('Factory routing approval task not found');
  await assertPipelineHitlTerminalActor(input.db, gate, input.actor);
  const gateContext = gateContextSchema.parse(gateRun.routingSnapshot.intakeContext);
  const requested = normalizedRoutingDecision(input.decision);
  assertDecisionUsesFrozenRouting(requested, gateContext);
  const existingRecorded = await recordedRoutingDecision(input.db, gateRun.id, gate.id);
  if (existingRecorded && !sameRoutingDecision(existingRecorded.request, requested)) {
    throw conflict('Factory routing was already decided with a different outcome');
  }

  let claimed = false;
  if (!existingRecorded) {
    const rejected = requested.decision.kind === 'reject';
    await issuePipelineOrchestrator(
      issuePipelineOrchestratorRepository(input.db),
    ).completeStageTask(
      {
        runId: gateRun.id,
        stageTaskId: gate.id,
        terminalStatus: rejected ? 'cancelled' : 'done',
        outcome: rejected ? 'failed' : 'passed',
        summary:
          requested.note?.trim() ||
          (rejected
            ? 'Factory routing request rejected'
            : requested.decision.kind === 'new_project'
              ? `Approved new production line ${requested.decision.name}`
              : 'Approved existing production line routing'),
        trace: {
          decisionSnapshot: recordedFactoryRoutingDecisionSchema.parse({
            kind: 'factory_routing_decision_v1',
            request: requested,
            actorUserId: input.actor.userId,
          }),
        },
      },
      (transition) => {
        claimed = transition.claimed;
      },
    );
  }

  const recorded =
    existingRecorded ?? (await recordedRoutingDecision(input.db, gateRun.id, gate.id));
  if (!recorded) throw new Error('Factory routing terminal decision was not recorded');
  if (!sameRoutingDecision(recorded.request, requested)) {
    throw conflict('Factory routing was concurrently decided with a different outcome');
  }
  await reconcileRecordedRoutingDecision({
    db: input.db,
    heartbeat: input.heartbeat,
    root,
    gateRun,
    gateContext,
    recorded,
  });
  return factoryIntakeProjection(input.db, root.id, !claimed);
}

function routingDecisionForRun(
  run: typeof issuePipelineRuns.$inferSelect,
  factory: FactoryContext,
  proposal: z.infer<typeof gateContextSchema>['newProjectProposal'] | null,
): FactoryRoutingDecision {
  return {
    resolution: run.routingSnapshot.resolution,
    confidence: run.routingSnapshot.confidence,
    reason: run.routingSnapshot.reason,
    candidates: factory.candidates.map((candidate) => ({
      projectId: candidate.projectId,
      key: candidate.key,
      name: candidate.name,
      repositoryKey: candidate.repositoryKey,
      groupKey: candidate.groupKey,
      confidence:
        run.routingSnapshot.classifierOutput &&
        asRecord(run.routingSnapshot.classifierOutput).projectKey === candidate.key
          ? run.routingSnapshot.confidence
          : null,
      reason: candidate.intakeFallback ? 'intake_fallback' : 'factory_candidate',
    })),
    newProjectProposal: proposal,
  };
}

export async function factoryIntakeProjection(
  db: Db,
  issueId: string,
  idempotentReplay = false,
): Promise<FactoryIntakeProjection> {
  const root = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  if (!root || root.originKind !== 'paperclip') throw new Error('Factory intake not found');
  const runs = await db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(eq(issuePipelineRuns.companyId, root.companyId), eq(issuePipelineRuns.issueId, root.id)),
    )
    .orderBy(desc(issuePipelineRuns.createdAt));
  const scoutRun = runs.find((run) => run.sourceOriginId.startsWith('factory-scout:'));
  const gateRun = runs.find(
    (run) => gateContextSchema.safeParse(run.routingSnapshot.intakeContext).success,
  );
  const deliveryRun = runs.find((run) => run.sourceOriginId.startsWith('factory-delivery:'));
  const contextResult = scoutRun
    ? factoryContextSchema.safeParse(scoutRun.routingSnapshot.intakeContext)
    : null;
  const gateContextResult = gateRun
    ? gateContextSchema.safeParse(gateRun.routingSnapshot.intakeContext)
    : null;
  const context = gateContextResult?.success
    ? gateContextResult.data.factory
    : contextResult?.success
      ? contextResult.data
      : null;
  if (!context) throw new Error('Factory intake context is unavailable');
  const selectedRun = deliveryRun ?? gateRun ?? scoutRun ?? null;
  const rejected = gateRun
    ? await db
        .select({ decision: issuePipelineEvents.decisionSnapshot })
        .from(issuePipelineEvents)
        .where(
          and(
            eq(issuePipelineEvents.pipelineRunId, gateRun.id),
            eq(issuePipelineEvents.stepKey, FACTORY_GATE_STEP_KEY),
          ),
        )
        .then((rows) =>
          rows.some((row) => {
            const recorded = recordedFactoryRoutingDecisionSchema.safeParse(row.decision);
            return recorded.success && recorded.data.request.decision.kind === 'reject';
          }),
        )
    : false;
  const state: FactoryIntakeProjection['intake']['state'] =
    rejected || root.status === 'cancelled'
      ? 'rejected'
      : deliveryRun?.status === 'completed'
        ? 'completed'
        : deliveryRun
          ? deliveryRun.status === 'blocked' || deliveryRun.status === 'failed'
            ? 'failed'
            : 'pipeline_active'
          : gateRun?.status === 'active'
            ? 'awaiting_routing_approval'
            : scoutRun?.status === 'blocked' || scoutRun?.status === 'failed'
              ? 'failed'
              : 'scouting';
  const projectId =
    deliveryRun?.selectedProjectId ?? (state === 'pipeline_active' ? root.projectId : null);
  const project = projectId
    ? await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, root.companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  return {
    intake: {
      id: root.id,
      identifier: root.identifier,
      status: root.status,
      state,
      idempotentReplay,
    },
    rootIssue: { id: root.id, identifier: root.identifier, title: root.title, status: root.status },
    portfolio: context.portfolio,
    project,
    routingDecision: selectedRun
      ? routingDecisionForRun(
          selectedRun,
          context,
          gateContextResult?.success ? gateContextResult.data.newProjectProposal : null,
        )
      : null,
    routingTarget: context.routingTarget,
    pipelineRun: selectedRun
      ? {
          id: selectedRun.id,
          status: selectedRun.status,
          currentStepKey: selectedRun.currentStepKey,
        }
      : null,
    scoutEvidence: context.scoutEvidence,
    links: {
      issueHref: `/workforce/issues/${root.id}`,
      statusHref: `/api/factory-intakes/${root.id}`,
      workHref: '/work',
    },
  };
}

export async function activateFactoryIntake(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  companyId: string;
  requesterUserId: string;
  requesterRoleKeys: string[];
  intake: CreateFactoryIntake;
}) {
  const routingTarget = normalizeRoutingTarget(
    input.intake.routingTarget,
    input.requesterUserId,
    input.requesterRoleKeys,
  );
  const resources = await loadFactoryResources(input.db, input.companyId, input.intake.request);
  const originId = intakeOriginId(
    input.companyId,
    input.requesterUserId,
    input.intake.idempotencyKey,
  );
  const root = await createOrReuseRootIssue({
    db: input.db,
    companyId: input.companyId,
    requesterUserId: input.requesterUserId,
    intakeProjectId: resources.intake.projectId,
    request: input.intake.request,
    originId,
  });
  const existing = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(
        eq(issuePipelineRuns.companyId, input.companyId),
        eq(issuePipelineRuns.issueId, root.issue.id),
        eq(issuePipelineRuns.sourceOriginId, `factory-scout:${originId}`),
      ),
    );
  if (existing.length > 1) {
    throw new Error('Factory intake has multiple scout runs for one idempotency identity');
  }
  if (existing.length === 1) {
    const existingContext = factoryContextSchema.safeParse(
      existing[0]!.routingSnapshot.intakeContext,
    );
    if (
      !existingContext.success ||
      existingContext.data.companyId !== input.companyId ||
      existingContext.data.requesterUserId !== input.requesterUserId ||
      existingContext.data.request !== input.intake.request ||
      JSON.stringify(existingContext.data.source) !== JSON.stringify(input.intake.source) ||
      JSON.stringify(existingContext.data.routingTarget) !== JSON.stringify(routingTarget)
    ) {
      throw new Error('Idempotency key is already bound to different factory intake context');
    }
    return factoryIntakeProjection(input.db, root.issue.id, true);
  }
  const typedClassifierInput = classifierInput(
    root.issue.id,
    input.intake.request,
    resources.candidates,
    resources.intake,
    resources.scoutEvidence,
  );
  const context = factoryContextSchema.parse({
    kind: FACTORY_CONTEXT_KIND,
    companyId: input.companyId,
    requesterUserId: input.requesterUserId,
    routingTarget,
    request: input.intake.request,
    source: input.intake.source,
    portfolio: { id: resources.portfolio.id, name: resources.portfolio.name },
    intakeProjectId: resources.intake.projectId,
    classifierAgentId: resources.classifier.id,
    minimumConfidence: MINIMUM_ROUTE_CONFIDENCE,
    candidates: resources.candidates,
    deliveryPipelineSnapshot: resources.deliveryPipelineSnapshot,
    scoutEvidence: resources.scoutEvidence,
    classifierInput: typedClassifierInput,
    sourceKey: originId,
  });
  const snapshot: IssuePipelineSnapshot = {
    pipelineId: resources.pipeline.id,
    name: 'Factory metadata classification',
    description:
      'Bounded project, repository metadata, prior-issue, and document context before routing.',
    executionMode: 'stage_tasks',
    trigger: { originKinds: ['paperclip'] },
    steps: [
      {
        key: FACTORY_SCOUT_STEP_KEY,
        kind: 'work',
        label: 'Collect metadata and classify',
        participant: { type: 'agent', agentId: resources.classifier.id },
      },
    ],
  };
  const run = await issuePipelineOrchestrator(issuePipelineOrchestratorRepository(input.db)).start({
    companyId: input.companyId,
    selectedProjectId: resources.intake.projectId,
    issueId: root.issue.id,
    sourceKey: `factory-scout:${originId}`,
    pipelineSnapshot: snapshot,
    routingSnapshot: routingSnapshot({
      context,
      classification: null,
      project: resources.intake,
      resolution: 'unresolved',
      reason: 'awaiting bounded metadata classification',
      intakeContext: context,
    }),
  });
  await queueFactoryClassifier({
    heartbeat: input.heartbeat,
    classifierAgentId: resources.classifier.id,
    runId: run.run.id,
    stageTaskId: run.stageTask.issueId,
    classifierInput: typedClassifierInput,
  });
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: 'user',
    actorId: input.requesterUserId,
    action: 'factory_intake.created',
    entityType: 'issue',
    entityId: root.issue.id,
    details: {
      pipelineRunId: run.run.id,
      portfolioId: resources.portfolio.id,
      routingTarget,
      scoutMode: resources.scoutEvidence.mode,
      codeSearchExecuted: false,
      pendingCapabilities: resources.scoutEvidence.pendingCapabilities,
    },
  });
  return factoryIntakeProjection(input.db, root.issue.id, !root.created);
}

async function reconcileFactoryScoutRun(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  run: typeof issuePipelineRuns.$inferSelect;
}) {
  const context = factoryContextSchema.safeParse(input.run.routingSnapshot.intakeContext);
  if (!context.success || !input.run.sourceOriginId.startsWith('factory-scout:')) {
    return { handled: false as const };
  }
  const stageTask = await input.db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.run.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, input.run.id),
        eq(issues.originFingerprint, `${FACTORY_SCOUT_STEP_KEY}:1`),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!stageTask) throw new Error(`Factory classifier stage task missing for run ${input.run.id}`);
  const runs = await input.db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.run.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${stageTask.id}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt));
  const succeeded = runs.find(
    (run) => run.agentId === context.data.classifierAgentId && run.status === 'succeeded',
  );
  if (succeeded) return finalizeFactoryIntakeScoutHeartbeat({ ...input, run: succeeded });
  const active = runs.find(
    (run) =>
      run.agentId === context.data.classifierAgentId &&
      ['queued', 'scheduled_retry', 'running'].includes(run.status),
  );
  if (active) return { handled: true as const, state: 'heartbeat_active' as const };
  const failed = runs.find(
    (run) =>
      run.agentId === context.data.classifierAgentId &&
      ['failed', 'cancelled', 'timed_out'].includes(run.status),
  );
  if (failed) return finalizeFactoryIntakeScoutHeartbeat({ ...input, run: failed });
  if (input.run.status !== 'pending' && input.run.status !== 'active') {
    return { handled: true as const, state: 'terminal_without_heartbeat' as const };
  }
  await queueFactoryClassifier({
    heartbeat: input.heartbeat,
    classifierAgentId: context.data.classifierAgentId,
    runId: input.run.id,
    stageTaskId: stageTask.id,
    classifierInput: context.data.classifierInput,
  });
  return { handled: true as const, state: 'heartbeat_queued' as const };
}

async function reconcileFactoryRoutingGate(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  run: typeof issuePipelineRuns.$inferSelect;
}) {
  const gateContext = gateContextSchema.safeParse(input.run.routingSnapshot.intakeContext);
  if (!gateContext.success || !input.run.sourceOriginId.startsWith('factory-gate:')) {
    return { handled: false as const };
  }
  const gate = await input.db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.run.companyId),
        eq(issues.originKind, 'pipeline_step'),
        eq(issues.originId, input.run.id),
        eq(issues.originFingerprint, `${FACTORY_GATE_STEP_KEY}:1`),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!gate) throw new Error(`Factory routing gate task missing for run ${input.run.id}`);
  const recorded = await recordedRoutingDecision(input.db, input.run.id, gate.id);
  if (!recorded) return { handled: true as const, state: 'awaiting_decision' as const };
  const root = await input.db
    .select()
    .from(issues)
    .where(and(eq(issues.id, input.run.issueId), eq(issues.companyId, input.run.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!root) throw new Error(`Factory root issue missing for routing gate ${input.run.id}`);
  await reconcileRecordedRoutingDecision({
    db: input.db,
    heartbeat: input.heartbeat,
    root,
    gateRun: input.run,
    gateContext: gateContext.data,
    recorded,
  });
  return { handled: true as const, state: 'decision_reconciled' as const };
}

/** Repairs classifier dispatch/finalization and post-HITL delivery seams. */
export async function reconcileFactoryIntakeRuns(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  companyId?: string;
}) {
  const statuses = ['pending', 'active', 'blocked', 'completed', 'failed'];
  const factorySource = or(
    like(issuePipelineRuns.sourceOriginId, 'factory-scout:%'),
    like(issuePipelineRuns.sourceOriginId, 'factory-gate:%'),
  )!;
  const rows = await input.db
    .select()
    .from(issuePipelineRuns)
    .where(
      and(
        ...(input.companyId ? [eq(issuePipelineRuns.companyId, input.companyId)] : []),
        inArray(issuePipelineRuns.status, statuses),
        factorySource,
      ),
    )
    .orderBy(desc(issuePipelineRuns.createdAt))
    .limit(1_000);
  let inspected = 0;
  let handled = 0;
  for (const run of rows) {
    if (run.sourceOriginId.startsWith('factory-scout:')) {
      if (!factoryContextSchema.safeParse(run.routingSnapshot.intakeContext).success) continue;
      inspected += 1;
      const result = await reconcileFactoryScoutRun({ ...input, run });
      if (result.handled) handled += 1;
      continue;
    }
    if (run.sourceOriginId.startsWith('factory-gate:')) {
      if (!gateContextSchema.safeParse(run.routingSnapshot.intakeContext).success) continue;
      inspected += 1;
      const result = await reconcileFactoryRoutingGate({ ...input, run });
      if (result.handled) handled += 1;
    }
  }
  return { inspected, handled };
}

export async function finalizeFactoryIntakeScoutHeartbeatById(input: {
  db: Db;
  heartbeat: FactoryHeartbeat;
  heartbeatRunId: string;
}) {
  const run = await input.db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.heartbeatRunId))
    .then((rows) => rows[0] ?? null);
  if (!run) return { handled: false as const };
  return finalizeFactoryIntakeScoutHeartbeat({ ...input, run });
}
