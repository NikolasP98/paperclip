import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  agents,
  companyMemberships,
  companies,
  createDb,
  heartbeatRuns,
  issuePipelineEvents,
  issuePipelineRuns,
  issuePlanDecompositions,
  issueWorkProducts,
  issues,
  pipelines,
  projects,
} from '@paperclipai/db';
import type { IssuePipelineSnapshot } from '@paperclipai/shared';
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from '../__tests__/helpers/embedded-postgres.js';
import { issuePipelineOrchestrator } from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';
import { issuePipelineStageTraversalService } from './issue-pipeline-stage-traversal.js';
import { documentService } from './documents.js';
import { issueService } from './issues.js';
import {
  finalizePipelineDroneHeartbeat,
  mergeEvidenceReady,
  mergeReadinessDroneInputSchema,
  plannerDroneOutputSchema,
  PORTFOLIO_SPEC_PLANNER_DRONE_ID,
  PORTFOLIO_MERGE_READINESS_DRONE_ID,
  queuePipelineStageTaskWakeup,
  renderPlannerArtifact,
  validateMergeReadinessDecision,
} from './issue-pipeline-drone-stages.js';

describe('pipeline Drone contracts', () => {
  it('rejects planner dependency keys outside the typed proposal', () => {
    expect(
      plannerDroneOutputSchema.safeParse({
        objective: 'Fix the bug',
        assumptions: [],
        subtasks: [
          {
            key: 'fix',
            title: 'Fix',
            description: 'Change the implementation.',
            acceptanceCriteria: ['Regression is covered.'],
            dependsOn: ['missing'],
          },
        ],
        risks: [],
        testPlan: ['Run the focused test.'],
      }).success,
    ).toBe(false);
  });

  it('renders a stable inspectable plan artifact', () => {
    const output = plannerDroneOutputSchema.parse({
      objective: 'Fix the bug',
      assumptions: ['The reproduction is current.'],
      subtasks: [
        {
          key: 'fix',
          title: 'Fix',
          description: 'Change the implementation.',
          acceptanceCriteria: ['Regression is covered.'],
          dependsOn: [],
        },
      ],
      risks: ['The fallback path may regress.'],
      testPlan: ['Run the focused test.'],
    });
    expect(renderPlannerArtifact(output)).toContain('Key: `fix`');
    expect(renderPlannerArtifact(output)).toContain('Acceptance criteria:');
  });

  it('fails closed when a Drone contradicts immutable readiness evidence', () => {
    const input = mergeReadinessDroneInputSchema.parse({
      repository: 'NikolasP98/minion_hub',
      targetBranch: 'dev',
      approvedHeadSha: 'a'.repeat(40),
      currentHeadSha: 'b'.repeat(40),
      approvals: [{ gate: 'release-approval', status: 'approved', actor: 'user-1' }],
      checks: [{ name: 'test', status: 'passed', summary: 'green' }],
    });
    expect(mergeEvidenceReady(input)).toBe(false);
    expect(() =>
      validateMergeReadinessDecision(input, {
        ready: true,
        blockers: [],
        risk: 'low',
        summary: 'Ready',
      }),
    ).toThrow(/contradicted frozen evidence/);
  });
});

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb('merge-readiness finalizer', () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('paperclip-pipeline-drone-finalizer-');
    db = createDb(temp.connectionString);
  }, 20_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  it('persists the Planner artifact and decomposes its accepted revision exactly once', async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const pipelineId = randomUUID();
    const plannerId = randomUUID();
    const implementerId = randomUUID();
    const approverId = 'user-plan-approver';
    await db.insert(companies).values({
      id: companyId,
      name: 'MINION planning',
      issuePrefix: `P${companyId.slice(0, 6)}`.toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: 'Hub',
      description: 'Minion Hub concerns.',
      status: 'in_progress',
      metadata: { repositoryKey: 'minion-hub' },
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: 'user',
      principalId: approverId,
      status: 'active',
      membershipRole: 'owner',
    });
    await db.insert(agents).values([
      {
        id: plannerId,
        companyId,
        name: 'spec-planner',
        role: 'pm',
        status: 'idle',
        adapterType: 'minion_drone',
        adapterConfig: { droneId: PORTFOLIO_SPEC_PLANNER_DRONE_ID },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: implementerId,
        companyId,
        name: 'implementer',
        role: 'engineer',
        status: 'idle',
        adapterType: 'process',
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const snapshot: IssuePipelineSnapshot = {
      pipelineId,
      name: 'Plan and implement',
      description: null,
      executionMode: 'stage_tasks',
      trigger: null,
      steps: [
        {
          key: 'plan',
          kind: 'work',
          label: 'Plan',
          participant: { type: 'agent', agentId: plannerId },
        },
        {
          key: 'plan-approval',
          kind: 'approval',
          label: 'Plan approval',
          participant: { type: 'user', userId: approverId },
          onFailStepKey: 'plan',
          maxAttempts: 3,
        },
        {
          key: 'implement',
          kind: 'work',
          label: 'Implement',
          participant: { type: 'agent', agentId: implementerId },
        },
      ],
    };
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      projectId: null,
      name: snapshot.name,
      executionMode: 'stage_tasks',
      trigger: null,
      steps: snapshot.steps as unknown as Record<string, unknown>[],
    });
    const root = await issueService(db).create(companyId, {
      title: 'Fix unavailable localStorage',
      description: 'Theme changes throw when localStorage is unavailable.',
      status: 'todo',
      priority: 'high',
      projectId,
      originKind: 'github_issue',
      originId: 'NikolasP98/minion_hub#56',
    });
    const started = await issuePipelineOrchestrator(issuePipelineOrchestratorRepository(db)).start({
      companyId,
      selectedProjectId: projectId,
      issueId: root.id,
      sourceKey: 'NikolasP98/minion_hub#56:planning',
      pipelineSnapshot: snapshot,
      routingSnapshot: {
        repository: 'NikolasP98/minion_hub',
        originalLabels: ['bug'],
        inferredLabels: ['bug'],
        classifierOutput: {
          labels: ['bug'],
          scopes: ['ui'],
          projectKey: 'hub',
          confidence: 0.99,
          rationale: 'Hub theme behavior.',
        },
        candidates: [],
        selectedPortfolioId: null,
        selectedProjectId: projectId,
        confidence: 0.99,
        resolution: 'rule',
        reason: 'test',
      },
    });
    const plannerWake = vi.fn().mockResolvedValue({ id: 'queued' });
    await queuePipelineStageTaskWakeup({
      db,
      heartbeat: { wakeup: plannerWake },
      run: started.run,
      stageTask: started.stageTask,
    });
    const plannerContext = plannerWake.mock.calls[0]?.[1].contextSnapshot;
    const output = plannerDroneOutputSchema.parse({
      objective: 'Make theme persistence best-effort without breaking preference updates.',
      assumptions: ['The in-memory theme remains authoritative for the current session.'],
      subtasks: [
        {
          key: 'guard-storage',
          title: 'Guard theme storage',
          description: 'Catch unavailable storage on read and write.',
          acceptanceCriteria: ['Theme changes still apply in memory.'],
          dependsOn: [],
        },
        {
          key: 'regression-test',
          title: 'Add storage regression coverage',
          description: 'Exercise throwing localStorage access.',
          acceptanceCriteria: ['The focused test passes.'],
          dependsOn: ['guard-storage'],
        },
      ],
      risks: ['Silent persistence failure must not hide unrelated errors.'],
      testPlan: ['Run the theme preference unit tests.'],
    });
    const [plannerHeartbeat] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: plannerId,
        status: 'succeeded',
        invocationSource: 'assignment',
        contextSnapshot: plannerContext,
        resultJson: { droneId: PORTFOLIO_SPEC_PLANNER_DRONE_ID, output },
        resolvedAdapterType: 'minion_drone',
        resolvedModel: 'claude-opus-4-7',
        resolvedProvider: 'anthropic',
        finishedAt: new Date(),
      })
      .returning();
    await finalizePipelineDroneHeartbeat({
      db,
      heartbeat: { wakeup: vi.fn() },
      run: plannerHeartbeat!,
    });
    const plan = await documentService(db).getIssueDocumentByKey(root.id, 'plan');
    expect(plan).toMatchObject({ latestRevisionNumber: 1, createdByAgentId: plannerId });
    expect(plan?.body).toContain('`guard-storage`');
    const tasks = await issuePipelineOrchestratorRepository(db).listStageTasks(started.run.id);
    const approvalTask = tasks.find((task) => task.stageKey === 'plan-approval');
    expect(approvalTask).toBeTruthy();
    await issueService(db).update(approvalTask!.issueId, { status: 'done' });
    const implementWake = vi.fn().mockResolvedValue({ id: 'implement-wake' });
    const traversal = issuePipelineStageTraversalService(db, {
      heartbeat: { wakeup: implementWake },
    });
    const mutation = {
      issue: {
        id: approvalTask!.issueId,
        companyId,
        originKind: 'pipeline_step',
        originId: started.run.id,
        status: 'done',
      },
      pipelineOutcome: 'passed' as const,
      pipelineSummary: 'Plan approved.',
      requestedByActorType: 'user' as const,
      requestedByActorId: approverId,
    };
    await traversal.afterCommittedIssueMutation(mutation);
    await traversal.afterCommittedIssueMutation(mutation);

    const decompositions = await db
      .select()
      .from(issuePlanDecompositions)
      .where(eq(issuePlanDecompositions.sourceIssueId, root.id));
    expect(decompositions).toHaveLength(1);
    expect(decompositions[0]).toMatchObject({ status: 'completed', requestedChildCount: 2 });
    const decomposedChildren = await db.select().from(issues).where(eq(issues.parentId, root.id));
    expect(decomposedChildren.filter((issue) => issue.originKind !== 'pipeline_step')).toHaveLength(
      2,
    );
    expect(implementWake).toHaveBeenCalledTimes(1);
    expect(await documentService(db).listIssueDocumentRevisions(root.id, 'plan')).toHaveLength(1);
  });

  it('completes orchestration without merging, pushing, or mutating the PR work product', async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const pipelineId = randomUUID();
    const mergerId = randomUUID();
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    await db.insert(companies).values({
      id: companyId,
      name: 'MINION',
      issuePrefix: `T${companyId.slice(0, 6)}`.toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: 'Hub',
      status: 'in_progress',
    });
    await db.insert(agents).values({
      id: mergerId,
      companyId,
      name: 'merge-readiness',
      role: 'devops',
      status: 'idle',
      adapterType: 'minion_drone',
      adapterConfig: { droneId: PORTFOLIO_MERGE_READINESS_DRONE_ID },
      runtimeConfig: {},
      permissions: {},
    });
    const snapshot: IssuePipelineSnapshot = {
      pipelineId,
      name: 'Merge readiness only',
      description: null,
      executionMode: 'stage_tasks',
      trigger: null,
      steps: [
        {
          key: 'merge-readiness',
          kind: 'work',
          label: 'Merge readiness',
          participant: { type: 'agent', agentId: mergerId },
        },
      ],
    };
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      projectId: null,
      name: snapshot.name,
      executionMode: 'stage_tasks',
      trigger: null,
      steps: snapshot.steps as unknown as Record<string, unknown>[],
    });
    const root = await issueService(db).create(companyId, {
      title: 'Fix storage fallback',
      description: 'localStorage may throw.',
      status: 'todo',
      priority: 'medium',
      projectId,
      originKind: 'github_issue',
      originId: 'NikolasP98/minion_hub#56',
    });
    const started = await issuePipelineOrchestrator(issuePipelineOrchestratorRepository(db)).start({
      companyId,
      selectedProjectId: projectId,
      issueId: root.id,
      sourceKey: 'NikolasP98/minion_hub#56:delivery',
      pipelineSnapshot: snapshot,
      routingSnapshot: {
        repository: 'NikolasP98/minion_hub',
        originalLabels: ['bug'],
        inferredLabels: ['bug'],
        classifierOutput: {
          labels: ['bug'],
          scopes: ['ui'],
          projectKey: 'hub',
          confidence: 1,
          rationale: 'Hub issue',
        },
        candidates: [],
        selectedPortfolioId: null,
        selectedProjectId: projectId,
        confidence: 1,
        resolution: 'rule',
        reason: 'test',
      },
    });
    const implementation = await issueService(db).createChild(root.id, {
      title: 'Implement',
      description: 'Implementation evidence owner.',
      status: 'done',
      priority: 'medium',
      projectId,
      originKind: 'pipeline_step',
      originId: started.run.id,
      originRunId: started.run.id,
      originFingerprint: 'implement:1',
      blockParentUntilDone: false,
    });
    const [product] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        projectId,
        issueId: implementation.issue.id,
        type: 'pull_request',
        provider: 'github',
        externalId: '56',
        title: 'Fix storage fallback',
        url: 'https://github.com/NikolasP98/minion_hub/pull/56',
        status: 'ready_for_review',
        reviewState: 'approved',
        isPrimary: true,
        metadata: {
          headSha,
          baseRef: 'dev',
          baseSha,
          checks: [{ name: 'test', status: 'passed', summary: 'green' }],
        },
      })
      .returning();
    await db.insert(issuePipelineEvents).values({
      companyId,
      pipelineRunId: started.run.id,
      sequence: 3,
      eventKey: 'stage-terminal:release-approval-test',
      eventType: 'stage_completed',
      stepKey: 'release-approval',
      attempt: 1,
      decisionSnapshot: {
        outcome: 'approved',
        actor: 'user-1',
        pullRequest: {
          headSha,
          baseRef: 'dev',
          baseSha,
          checks: [{ name: 'test', status: 'passed', summary: 'green' }],
        },
        workProductId: product!.id,
      },
    });
    const frozenInput = mergeReadinessDroneInputSchema.parse({
      repository: 'NikolasP98/minion_hub',
      targetBranch: 'dev',
      approvedHeadSha: headSha,
      currentHeadSha: headSha,
      approvals: [{ gate: 'release-approval', status: 'approved', actor: 'user-1' }],
      checks: [{ name: 'test', status: 'passed', summary: 'green' }],
    });
    const [heartbeat] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: mergerId,
        status: 'succeeded',
        invocationSource: 'assignment',
        contextSnapshot: {
          issueId: started.stageTask.issueId,
          paperclipDrone: { input: frozenInput },
          pipelineDroneStage: {
            kind: 'issue_pipeline_drone_stage_v1',
            pipelineRunId: started.run.id,
            stageTaskId: started.stageTask.issueId,
            stageKey: 'merge-readiness',
            attempt: 1,
            droneId: PORTFOLIO_MERGE_READINESS_DRONE_ID,
          },
        },
        resultJson: {
          droneId: PORTFOLIO_MERGE_READINESS_DRONE_ID,
          output: {
            ready: true,
            blockers: [],
            risk: 'low',
            summary: 'All frozen evidence passed.',
          },
        },
        resolvedAdapterType: 'minion_drone',
        resolvedModel: 'claude-haiku-4-5',
        resolvedProvider: 'anthropic',
        finishedAt: new Date(),
      })
      .returning();
    const wakeup = vi.fn();

    const first = await finalizePipelineDroneHeartbeat({
      db,
      heartbeat: { wakeup },
      run: heartbeat!,
    });
    const replay = await finalizePipelineDroneHeartbeat({
      db,
      heartbeat: { wakeup },
      run: heartbeat!,
    });

    expect(first.status).toBe('completed_without_merge');
    expect(replay.status).toBe('reconciled');
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      await db
        .select({ status: issuePipelineRuns.status })
        .from(issuePipelineRuns)
        .where(eq(issuePipelineRuns.id, started.run.id))
        .then((rows) => rows[0]?.status),
    ).toBe('completed');
    expect(
      await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, root.id))
        .then((rows) => rows[0]?.status),
    ).toBe('done');
    const unchangedProduct = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, product!.id))
      .then((rows) => rows[0]);
    expect(unchangedProduct).toMatchObject({
      status: 'ready_for_review',
      reviewState: 'approved',
      metadata: { headSha, baseRef: 'dev', baseSha },
    });
    expect(await db.select().from(issueWorkProducts)).toHaveLength(1);
    const terminal = await db
      .select()
      .from(issuePipelineEvents)
      .where(eq(issuePipelineEvents.eventKey, `stage-terminal:${started.stageTask.issueId}`))
      .then((rows) => rows[0]);
    expect(terminal?.decisionSnapshot).toMatchObject({
      mergeExecuted: false,
      approvedHeadSha: headSha,
    });
  });
});
