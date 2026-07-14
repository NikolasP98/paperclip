import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activityLog,
  agents,
  companyMemberships,
  companies,
  createDb,
  heartbeatRuns,
  issueLabels,
  issuePipelineEvents,
  issuePipelineRuns,
  issues,
  labels,
  pipelines,
  portfolios,
  projectWorkspaces,
  projects,
} from '@paperclipai/db';
import { errorHandler } from '../middleware/error-handler.js';
import { factoryIntakeRoutes } from '../routes/factory-intakes.js';
import {
  activateFactoryIntake,
  decideFactoryIntakeRouting,
  FACTORY_CLASSIFIER_INPUT_MAX_CHARS,
  factoryIntakeProjection,
  finalizeFactoryIntakeScoutHeartbeatById,
  reconcileFactoryIntakeRuns,
} from '../services/factory-intake.js';
import type { IssueAssignmentWakeupDeps } from '../services/issue-assignment-wakeup.js';
import { issuePipelineOrchestrator } from '../services/issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from '../services/issue-pipeline-repository.js';
import { pipelineInboxService } from '../services/pipeline-inbox.js';
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from './helpers/embedded-postgres.js';

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb('conversational factory intake', () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const wakeup = vi.fn();
  const heartbeat = { wakeup } as unknown as IssueAssignmentWakeupDeps;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('paperclip-factory-intake-');
    db = createDb(temp.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(pipelines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(portfolios);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    wakeup.mockReset();
  });

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function seedFactory() {
    const companyId = randomUUID();
    const portfolioId = randomUUID();
    const intakeProjectId = randomUUID();
    const workforceProjectId = randomUUID();
    const classifierAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const pipelineId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: 'Factory Co',
      issuePrefix: `F${companyId.replace(/-/g, '').slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: 'user',
      principalId: 'hub-user-1',
      status: 'active',
      membershipRole: 'owner',
    });
    await db.insert(agents).values([
      {
        id: classifierAgentId,
        companyId,
        name: 'Factory classifier',
        role: 'general',
        status: 'active',
        adapterType: 'minion_drone',
        adapterConfig: { droneId: 'portfolio-issue-classifier-v1' },
        runtimeConfig: {},
        permissions: {},
        metadata: { harnessRoleKey: 'classifier' },
      },
      {
        id: builderAgentId,
        companyId,
        name: 'Factory builder',
        role: 'engineer',
        status: 'active',
        adapterType: 'process',
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(portfolios).values({
      id: portfolioId,
      companyId,
      name: 'MINION Code',
      metadata: { minionSeedKey: 'minion-code:portfolio' },
    });
    await db.insert(projects).values([
      {
        id: intakeProjectId,
        companyId,
        portfolioId,
        name: 'Portfolio Intake',
        status: 'in_progress',
        metadata: {
          factoryProjectKey: 'portfolio-intake',
          repositoryKey: 'cross-repo',
          groupKey: 'intake',
          routing: { intakeFallback: true, scopes: [], pathPrefixes: [] },
        },
      },
      {
        id: workforceProjectId,
        companyId,
        portfolioId,
        name: 'Workforce / Projects',
        description: 'Hub factory and workforce UI',
        status: 'in_progress',
        metadata: {
          factoryProjectKey: 'hub-workforce',
          repositoryKey: 'minion-hub',
          groupKey: 'hub',
          routing: { scopes: ['workforce', 'ui'], pathPrefixes: ['src/routes/(app)/workforce'] },
        },
      },
    ]);
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId: workforceProjectId,
      name: 'Hub primary',
      cwd: '/workspace/minion_hub',
      repoUrl: 'https://github.com/NikolasP98/minion_hub',
      repoRef: 'refs/heads/dev',
      defaultRef: 'dev',
      isPrimary: true,
    });
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      name: 'MINION Code Delivery',
      description: 'Shared factory delivery',
      executionMode: 'stage_tasks',
      trigger: { originKinds: ['paperclip'] },
      steps: [
        {
          key: 'build',
          kind: 'work',
          label: 'Build',
          participant: { type: 'agent', agentId: builderAgentId },
        },
      ],
    });
    wakeup.mockImplementation(
      async (agentId: string, options: Parameters<IssueAssignmentWakeupDeps['wakeup']>[1]) =>
        db
          .insert(heartbeatRuns)
          .values({
            companyId,
            agentId,
            invocationSource: options.source ?? 'assignment',
            triggerDetail: options.triggerDetail ?? 'system',
            status: 'queued',
            contextSnapshot: options.contextSnapshot ?? {},
          })
          .returning()
          .then((rows) => rows[0]),
    );
    return {
      companyId,
      portfolioId,
      intakeProjectId,
      workforceProjectId,
      classifierAgentId,
      builderAgentId,
      pipelineId,
    };
  }

  async function activate(
    scenario: Awaited<ReturnType<typeof seedFactory>>,
    options: {
      request?: string;
      requesterUserId?: string;
      idempotencyKey?: string;
      routingTarget?: { type: 'user' } | { type: 'role'; roleKeys: string[] };
      sourceRoute?: string;
    } = {},
  ) {
    return activateFactoryIntake({
      db,
      heartbeat,
      companyId: scenario.companyId,
      requesterUserId: options.requesterUserId ?? 'hub-user-1',
      requesterRoleKeys: ['owner'],
      intake: {
        request: options.request ?? 'Add role-scoped factory approvals to the workforce project UI',
        source: { kind: 'hub_assistant', route: options.sourceRoute ?? '/workforce' },
        idempotencyKey: options.idempotencyKey ?? 'factory-request-1',
        routingTarget: options.routingTarget,
      },
    });
  }

  async function finishClassifier(
    scenario: Awaited<ReturnType<typeof seedFactory>>,
    rootIssueId: string,
    confidence: number,
  ) {
    const classifierRun = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, scenario.companyId),
          eq(heartbeatRuns.agentId, scenario.classifierAgentId),
        ),
      )
      .then((rows) =>
        rows.find((row) => {
          const context = row.contextSnapshot as Record<string, unknown>;
          return Boolean(context.factoryIntake);
        }),
      );
    if (!classifierRun) throw new Error('classifier heartbeat was not queued');
    await db
      .update(heartbeatRuns)
      .set({
        status: 'succeeded',
        resultJson: {
          droneId: 'portfolio-issue-classifier-v1',
          output: {
            labels: ['feature', 'high'],
            scopes: ['workforce', 'ui'],
            projectKey: 'hub-workforce',
            projectGroup: 'hub',
            confidence,
            rationale: 'The request targets the workforce projects interface.',
          },
        },
        finishedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, classifierRun.id));
    await finalizeFactoryIntakeScoutHeartbeatById({
      db,
      heartbeat,
      heartbeatRunId: classifierRun.id,
    });
    return factoryIntakeProjection(db, rootIssueId);
  }

  it('persists taxonomy, exposes a user HITL gate, and replays one delivery with frozen candidates', async () => {
    const scenario = await seedFactory();
    const started = await activate(scenario);
    expect(started.intake.state).toBe('scouting');
    const gated = await finishClassifier(scenario, started.rootIssue.id, 0.4);
    expect(gated.intake.state).toBe('awaiting_routing_approval');

    const labelNames = await db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(issueLabels.issueId, started.rootIssue.id))
      .then((rows) => rows.map((row) => row.name).sort());
    expect(labelNames).toEqual(['feature', 'high', 'scope:ui', 'scope:workforce']);
    const inbox = await pipelineInboxService(db).list(scenario.companyId, {
      userId: 'hub-user-1',
      trustedRoleKeys: [],
    });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      stageKey: 'routing-decision',
      rootIssueId: started.rootIssue.id,
    });
    await expect(
      pipelineInboxService(db).list(scenario.companyId, {
        userId: 'another-user',
        trustedRoleKeys: [],
      }),
    ).resolves.toEqual([]);

    const decided = await decideFactoryIntakeRouting({
      db,
      heartbeat,
      issueId: started.rootIssue.id,
      actor: { type: 'board', userId: 'hub-user-1', source: 'hub_identity', roleKeys: [] },
      decision: { decision: { kind: 'existing_project', projectId: scenario.workforceProjectId } },
    });
    expect(decided.intake.state).toBe('pipeline_active');
    const replay = await activate(scenario);
    expect(replay.intake.idempotentReplay).toBe(true);
    expect(replay.routingDecision?.candidates.map((candidate) => candidate.key)).toEqual(
      gated.routingDecision?.candidates.map((candidate) => candidate.key),
    );
    const deliveries = await db
      .select()
      .from(issuePipelineRuns)
      .where(
        and(
          eq(issuePipelineRuns.issueId, started.rootIssue.id),
          like(issuePipelineRuns.sourceOriginId, 'factory-delivery:%'),
        ),
      );
    expect(deliveries).toHaveLength(1);
    await expect(activate(scenario, { sourceRoute: '/different' })).rejects.toThrow(
      'different factory intake context',
    );
    const otherActor = await activate(scenario, { requesterUserId: 'hub-user-2' });
    expect(otherActor.rootIssue.id).not.toBe(started.rootIssue.id);
  });

  it('commits one canonical choice under concurrent conflicting role decisions', async () => {
    const scenario = await seedFactory();
    const started = await activate(scenario, {
      routingTarget: { type: 'role', roleKeys: ['owner'] },
    });
    await finishClassifier(scenario, started.rootIssue.id, 0.2);
    const actor = (userId: string) => ({
      type: 'board' as const,
      userId,
      source: 'hub_identity',
      roleKeys: ['owner'],
    });
    const outcomes = await Promise.allSettled([
      decideFactoryIntakeRouting({
        db,
        heartbeat,
        issueId: started.rootIssue.id,
        actor: actor('role-user-1'),
        decision: {
          decision: {
            kind: 'new_project',
            name: 'Agent Bubble',
            repositoryKey: 'minion-hub',
            scopes: ['workforce', 'ui'],
          },
        },
      }),
      decideFactoryIntakeRouting({
        db,
        heartbeat,
        issueId: started.rootIssue.id,
        actor: actor('role-user-2'),
        decision: { decision: { kind: 'reject' }, note: 'Do not build this.' },
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const root = await db
      .select()
      .from(issues)
      .where(eq(issues.id, started.rootIssue.id))
      .then((rows) => rows[0]!);
    const createdProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, scenario.companyId), eq(projects.name, 'Agent Bubble')));
    const deliveries = await db
      .select()
      .from(issuePipelineRuns)
      .where(
        and(
          eq(issuePipelineRuns.issueId, started.rootIssue.id),
          like(issuePipelineRuns.sourceOriginId, 'factory-delivery:%'),
        ),
      );
    if (root.status === 'cancelled') {
      expect(createdProjects).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    } else {
      expect(createdProjects).toHaveLength(1);
      expect(deliveries).toHaveLength(1);
    }
    const terminalEvents = await db
      .select()
      .from(issuePipelineEvents)
      .where(
        and(
          eq(issuePipelineEvents.stepKey, 'routing-decision'),
          like(issuePipelineEvents.eventKey, 'stage-terminal:%'),
        ),
      );
    expect(terminalEvents).toHaveLength(1);
  });

  it('materializes one delivery stage under concurrent matching decision replays', async () => {
    const scenario = await seedFactory();
    const started = await activate(scenario, {
      routingTarget: { type: 'role', roleKeys: ['owner'] },
    });
    await finishClassifier(scenario, started.rootIssue.id, 0.2);
    const decide = (userId: string) =>
      decideFactoryIntakeRouting({
        db,
        heartbeat,
        issueId: started.rootIssue.id,
        actor: { type: 'board', userId, source: 'hub_identity', roleKeys: ['owner'] },
        decision: {
          decision: { kind: 'existing_project', projectId: scenario.workforceProjectId },
        },
      });
    const outcomes = await Promise.allSettled([decide('role-user-1'), decide('role-user-2')]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const delivery = await db
      .select()
      .from(issuePipelineRuns)
      .where(
        and(
          eq(issuePipelineRuns.issueId, started.rootIssue.id),
          like(issuePipelineRuns.sourceOriginId, 'factory-delivery:%'),
        ),
      );
    expect(delivery).toHaveLength(1);
    const deliveryTasks = await db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, 'pipeline_step'), eq(issues.originId, delivery[0]!.id)));
    expect(deliveryTasks).toHaveLength(1);
    expect(delivery[0]!.status).toBe('active');
    expect(delivery[0]!.currentStepKey).toBe('build');
  });

  it('creates one project, primary workspace, and delivery under matching new-project replays', async () => {
    const scenario = await seedFactory();
    const started = await activate(scenario, {
      routingTarget: { type: 'role', roleKeys: ['owner'] },
    });
    await finishClassifier(scenario, started.rootIssue.id, 0.2);
    const decide = (userId: string) =>
      decideFactoryIntakeRouting({
        db,
        heartbeat,
        issueId: started.rootIssue.id,
        actor: { type: 'board', userId, source: 'hub_identity', roleKeys: ['owner'] },
        decision: {
          decision: {
            kind: 'new_project',
            name: 'Agent Bubble',
            repositoryKey: 'minion-hub',
            scopes: ['workforce', 'ui'],
          },
        },
      });

    const outcomes = await Promise.allSettled([decide('role-user-1'), decide('role-user-2')]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);

    const createdProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, scenario.companyId), eq(projects.name, 'Agent Bubble')));
    expect(createdProjects).toHaveLength(1);
    const workspaces = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, createdProjects[0]!.id));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.isPrimary).toBe(true);
    const deliveries = await db
      .select()
      .from(issuePipelineRuns)
      .where(
        and(
          eq(issuePipelineRuns.issueId, started.rootIssue.id),
          like(issuePipelineRuns.sourceOriginId, 'factory-delivery:%'),
        ),
      );
    expect(deliveries).toHaveLength(1);
  });

  it('does not regress a completed delivery when periodic reconciliation revisits the scout', async () => {
    const scenario = await seedFactory();
    const started = await activate(scenario);
    const routed = await finishClassifier(scenario, started.rootIssue.id, 0.95);
    const delivery = await db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, routed.pipelineRun!.id))
      .then((rows) => rows[0]!);
    const repository = issuePipelineOrchestratorRepository(db);
    const stageTask = (await repository.listStageTasks(delivery.id))[0]!;
    await issuePipelineOrchestrator(repository).completeStageTask({
      runId: delivery.id,
      stageTaskId: stageTask.issueId,
      terminalStatus: 'done',
      outcome: 'passed',
      summary: 'Build completed',
    });
    const beforeRoot = await db
      .select()
      .from(issues)
      .where(eq(issues.id, started.rootIssue.id))
      .then((rows) => rows[0]!);
    const beforeDelivery = await db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, delivery.id))
      .then((rows) => rows[0]!);
    const beforeTasks = await repository.listStageTasks(delivery.id);

    await reconcileFactoryIntakeRuns({ db, heartbeat, companyId: scenario.companyId });

    const afterRoot = await db
      .select()
      .from(issues)
      .where(eq(issues.id, started.rootIssue.id))
      .then((rows) => rows[0]!);
    const afterDelivery = await db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, delivery.id))
      .then((rows) => rows[0]!);
    const afterTasks = await repository.listStageTasks(delivery.id);
    expect(afterRoot.status).toBe('done');
    expect(afterRoot.updatedAt.getTime()).toBe(beforeRoot.updatedAt.getTime());
    expect(afterDelivery.status).toBe('completed');
    expect(afterDelivery.updatedAt.getTime()).toBe(beforeDelivery.updatedAt.getTime());
    expect(afterTasks.map((task) => [task.issueId, task.status])).toEqual(
      beforeTasks.map((task) => [task.issueId, task.status]),
    );
  });

  it('caps serialized classifier input while preserving the full root request', async () => {
    const scenario = await seedFactory();
    const longRequest = `Build the factory assistant. ${'x'.repeat(99_000)}`;
    const started = await activate(scenario, {
      request: longRequest,
      idempotencyKey: 'long-request',
    });
    const classifierRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, scenario.classifierAgentId))
      .then((rows) => rows[0]!);
    const context = classifierRun.contextSnapshot as Record<string, unknown>;
    const drone = (context.paperclipDrone ?? {}) as Record<string, unknown>;
    expect(JSON.stringify(drone.input).length).toBeLessThanOrEqual(
      FACTORY_CLASSIFIER_INPUT_MAX_CHARS,
    );
    const root = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, started.rootIssue.id))
      .then((rows) => rows[0]!);
    expect(root.description).toBe(longRequest);
  });

  it('authenticates before looking up a factory intake UUID', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: 'none', source: 'anonymous' };
      next();
    });
    app.use('/api', factoryIntakeRoutes(db, { heartbeat }));
    app.use(errorHandler);
    await request(app).get(`/api/factory-intakes/${randomUUID()}`).expect(403);
  });
});
