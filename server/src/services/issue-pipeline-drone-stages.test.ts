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
  implementationEvaluatorDroneInputSchema,
  implementationEvaluatorDroneOutputSchema,
  mergeEvidenceReady,
  mergeReadinessDroneInputSchema,
  plannerDroneOutputSchema,
  PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID,
  PORTFOLIO_SPEC_PLANNER_DRONE_ID,
  PORTFOLIO_MERGE_READINESS_DRONE_ID,
  queuePipelineStageTaskWakeup,
  renderPlannerArtifact,
  validateImplementationEvaluationDecision,
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

  it('requires evaluator rubric scores to cover the frozen criteria exactly once', () => {
    const input = implementationEvaluatorDroneInputSchema.parse({
      issue: {
        source: 'github',
        repository: 'NikolasP98/minion_hub',
        externalId: '56',
        title: 'Fix storage fallback',
        body: 'localStorage can throw.',
        labels: ['bug'],
      },
      approvedSpec: '# Plan',
      implementation: {
        summary: 'Guard storage access.',
        changedFiles: ['src/lib/theme.ts'],
        diff: '+ try { localStorage.setItem(...) } catch {}',
        testResults: [{ command: 'bun test theme', status: 'passed', output: 'green' }],
      },
      rubric: [
        { key: 'correctness', description: 'Fixes the root cause.', weight: 5 },
        { key: 'coverage', description: 'Includes a regression test.', weight: 5 },
      ],
      passingScore: 7,
    });
    const output = implementationEvaluatorDroneOutputSchema.parse({
      score: 8,
      rubricScores: [{ key: 'correctness', score: 8, rationale: 'Guard is present.' }],
      findings: [],
      requiredChanges: [],
      recommendation: 'approve',
      summary: 'Mostly complete.',
    });
    expect(() => validateImplementationEvaluationDecision(input, output)).toThrow(
      /rubric keys do not match frozen input/,
    );
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
    const decomposedChildById = new Map(decomposedChildren.map((issue) => [issue.id, issue]));
    const acceptedPlanChildren = decompositions[0]!.childIssueIds.map((id) =>
      decomposedChildById.get(id),
    );
    expect(acceptedPlanChildren).toHaveLength(2);
    expect(acceptedPlanChildren.every(Boolean)).toBe(true);
    const implementTask = decomposedChildren.find(
      (issue) => issue.originKind === 'pipeline_step' && issue.originFingerprint === 'implement:1',
    );
    expect(implementTask?.description).toContain(
      'Objective:\nMake theme persistence best-effort without breaking preference updates.',
    );
    expect(implementTask?.description).toContain(
      `Accepted plan revision: ${plan?.latestRevisionId}`,
    );
    expect(implementTask?.description).toContain(
      `${acceptedPlanChildren[0]!.identifier} — Guard theme storage (plan key: guard-storage)`,
    );
    expect(implementTask?.description).toContain(
      `${acceptedPlanChildren[1]!.identifier} — Add storage regression coverage (plan key: regression-test)`,
    );
    expect(implementWake).toHaveBeenCalledTimes(1);
    expect(implementWake.mock.calls[0]?.[1].contextSnapshot).toMatchObject({
      acceptedPlanRevisionId: plan?.latestRevisionId,
      acceptedPlanObjective:
        'Make theme persistence best-effort without breaking preference updates.',
      childIssueSummaries: [
        {
          id: acceptedPlanChildren[0]!.id,
          identifier: acceptedPlanChildren[0]!.identifier,
          title: 'Guard theme storage',
          status: 'backlog',
          summary: expect.stringContaining('Accepted plan key guard-storage.'),
        },
        {
          id: acceptedPlanChildren[1]!.id,
          identifier: acceptedPlanChildren[1]!.identifier,
          title: 'Add storage regression coverage',
          status: 'backlog',
          summary: expect.stringContaining('Accepted plan key regression-test.'),
        },
      ],
    });
    const implementStageTask = (
      await issuePipelineOrchestratorRepository(db).listStageTasks(started.run.id)
    ).find((task) => task.stageKey === 'implement');
    expect(implementStageTask).toBeTruthy();
    await queuePipelineStageTaskWakeup({
      db,
      heartbeat: { wakeup: vi.fn().mockResolvedValue({ id: 'replayed-implement-wake' }) },
      run: started.run,
      stageTask: implementStageTask!,
    });
    const replayedImplementTask = await issueService(db).getById(implementStageTask!.issueId);
    expect(
      replayedImplementTask?.description?.match(/<!-- paperclip:accepted-plan-handoff:start -->/g),
    ).toHaveLength(1);
    expect(await documentService(db).listIssueDocumentRevisions(root.id, 'plan')).toHaveLength(1);
  });

  it('freezes implementation evidence and turns a failing evaluator Drone score into a traced retry', async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const pipelineId = randomUUID();
    const plannerId = randomUUID();
    const implementerId = randomUUID();
    const evaluatorId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: 'MINION evaluation',
      issuePrefix: `E${companyId.slice(0, 6)}`.toUpperCase(),
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
    await db.insert(agents).values([
      {
        id: plannerId,
        companyId,
        name: 'spec-planner',
        role: 'pm',
        status: 'idle',
        adapterType: 'process',
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: implementerId,
        companyId,
        name: 'bug-fixer',
        role: 'engineer',
        status: 'idle',
        adapterType: 'process',
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: evaluatorId,
        companyId,
        name: 'code-evaluator',
        role: 'qa',
        status: 'idle',
        adapterType: 'minion_drone',
        adapterConfig: { droneId: PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const snapshot: IssuePipelineSnapshot = {
      pipelineId,
      name: 'Plan, implement, evaluate',
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
          key: 'implement',
          kind: 'work',
          label: 'Implement',
          participant: { type: 'agent', agentId: implementerId },
        },
        {
          key: 'evaluate',
          kind: 'eval',
          label: 'Evaluate',
          participant: { type: 'agent', agentId: evaluatorId },
          rubric: 'Score correctness, spec coverage, regression protection, evidence, and safety.',
          minScore: 7,
          maxScore: 10,
          onFailStepKey: 'implement',
          maxAttempts: 3,
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
      description: 'Theme preference writes throw when localStorage is unavailable.',
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
      sourceKey: 'NikolasP98/minion_hub#56:evaluation',
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
    const planOutput = plannerDroneOutputSchema.parse({
      objective: 'Keep theme changes working when localStorage is unavailable.',
      assumptions: [],
      subtasks: [
        {
          key: 'storage-fallback',
          title: 'Add storage fallback',
          description: 'Make theme persistence best effort.',
          acceptanceCriteria: ['Theme changes remain usable in memory.'],
          dependsOn: [],
        },
      ],
      risks: [],
      testPlan: ['Run the focused theme tests.'],
    });
    const plan = await documentService(db).upsertIssueDocument({
      issueId: root.id,
      key: 'plan',
      title: 'Implementation Plan',
      format: 'markdown',
      body: renderPlannerArtifact(planOutput),
      createdByAgentId: plannerId,
    });
    await issueService(db).update(started.stageTask.issueId, { status: 'done' });
    let implementStage: (typeof started)['stageTask'] | null = null;
    let run = await issuePipelineOrchestrator(
      issuePipelineOrchestratorRepository(db),
    ).completeStageTask(
      {
        runId: started.run.id,
        stageTaskId: started.stageTask.issueId,
        terminalStatus: 'done',
        outcome: 'passed',
        summary: planOutput.objective,
        trace: {
          outputSnapshot: {
            validatedOutput: planOutput,
            planDocumentId: plan.document.id,
            planRevisionId: plan.document.latestRevisionId,
          },
        },
      },
      (transition) => {
        implementStage = transition.nextStageTask;
      },
    );
    expect(implementStage).toMatchObject({ stageKey: 'implement', attempt: 1 });
    const headSha = 'a'.repeat(40);
    const baseSha = 'b'.repeat(40);
    await db.insert(issueWorkProducts).values({
      companyId,
      projectId,
      issueId: implementStage!.issueId,
      type: 'pull_request',
      provider: 'github',
      externalId: '60',
      title: 'Fix localStorage fallback',
      url: 'https://github.com/NikolasP98/minion_hub/pull/60',
      status: 'ready_for_review',
      reviewState: 'needs_board_review',
      isPrimary: true,
      summary: 'Guard theme storage reads and writes.',
      metadata: {
        headSha,
        baseRef: 'dev',
        baseSha,
        checks: [{ name: 'bun test theme', status: 'passed', summary: '8 tests passed' }],
        implementation: {
          changedFiles: ['src/lib/state/theme.ts', 'src/lib/state/theme.test.ts'],
          diff: '+try { storage.setItem(key, value); } catch { /* best effort */ }',
          testResults: [{ command: 'bun test theme', status: 'passed', output: '8 tests passed' }],
        },
      },
    });
    await issueService(db).update(implementStage!.issueId, { status: 'done' });
    let evaluatorStage: (typeof started)['stageTask'] | null = null;
    run = await issuePipelineOrchestrator(
      issuePipelineOrchestratorRepository(db),
    ).completeStageTask(
      {
        runId: run.id,
        stageTaskId: implementStage!.issueId,
        terminalStatus: 'done',
        outcome: 'passed',
        summary: 'Implementation ready for independent evaluation.',
      },
      (transition) => {
        evaluatorStage = transition.nextStageTask;
      },
    );
    expect(evaluatorStage).toMatchObject({ stageKey: 'evaluate', attempt: 1 });
    const evaluatorWake = vi.fn().mockResolvedValue({ id: 'evaluate-wake' });
    await queuePipelineStageTaskWakeup({
      db,
      heartbeat: { wakeup: evaluatorWake },
      run,
      stageTask: evaluatorStage!,
    });
    const evaluatorContext = evaluatorWake.mock.calls[0]?.[1].contextSnapshot;
    expect(evaluatorContext).toMatchObject({
      paperclipDrone: {
        input: {
          approvedSpec: expect.stringContaining('Keep theme changes working'),
          implementation: {
            changedFiles: ['src/lib/state/theme.ts', 'src/lib/state/theme.test.ts'],
            diff: expect.stringContaining('storage.setItem'),
            testResults: [
              { command: 'bun test theme', status: 'passed', output: '8 tests passed' },
            ],
          },
          passingScore: 7,
        },
      },
      pipelineDroneStage: {
        stageKey: 'evaluate',
        droneId: PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID,
      },
    });
    const rubricKeys = implementationEvaluatorDroneInputSchema
      .parse(evaluatorContext.paperclipDrone.input)
      .rubric.map((criterion) => criterion.key);
    const evaluatorOutput = implementationEvaluatorDroneOutputSchema.parse({
      score: 6,
      rubricScores: rubricKeys.map((key) => ({
        key,
        score: 6,
        rationale: `${key} needs stronger evidence.`,
      })),
      findings: [
        {
          severity: 'major',
          title: 'Missing throwing-read coverage',
          evidence: 'The supplied test output does not identify a throwing getter case.',
        },
      ],
      requiredChanges: ['Add regression coverage for a throwing localStorage getter.'],
      specDelta:
        'Explicitly exercise storage accessors that throw before returning a Storage object.',
      recommendation: 'revise',
      summary: 'The write path is guarded, but read-path regression evidence is incomplete.',
    });
    const [heartbeat] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: evaluatorId,
        status: 'succeeded',
        invocationSource: 'assignment',
        contextSnapshot: evaluatorContext,
        resultJson: {
          droneId: PORTFOLIO_IMPLEMENTATION_EVALUATOR_DRONE_ID,
          output: evaluatorOutput,
        },
        resolvedAdapterType: 'minion_drone',
        resolvedModel: 'gpt-5.4',
        resolvedProvider: 'openai',
        finishedAt: new Date(),
      })
      .returning();
    const retryWake = vi.fn().mockResolvedValue({ id: 'retry-wake' });
    const finalized = await finalizePipelineDroneHeartbeat({
      db,
      heartbeat: { wakeup: retryWake },
      run: heartbeat!,
    });
    const replay = await finalizePipelineDroneHeartbeat({
      db,
      heartbeat: { wakeup: retryWake },
      run: heartbeat!,
    });

    expect(finalized.status).toBe('changes_requested');
    expect(finalized.run).toMatchObject({ status: 'active', currentStepKey: 'implement' });
    expect(replay.status).toBe('reconciled');
    expect(retryWake).toHaveBeenCalledTimes(1);
    const transition = 'transition' in finalized ? finalized.transition : undefined;
    if (!transition) throw new Error('evaluator finalizer omitted transition');
    const retryStage = transition.nextStageTask;
    expect(retryStage).toMatchObject({ stageKey: 'implement', attempt: 2 });
    const retryIssue = await issueService(db).getById(retryStage!.issueId);
    expect(retryIssue?.description).toContain('Evaluator feedback for this retry');
    expect(retryIssue?.description).toContain('Missing throwing-read coverage');
    expect(retryIssue?.description).toContain('Explicitly exercise storage accessors');
    const terminal = await db
      .select()
      .from(issuePipelineEvents)
      .where(eq(issuePipelineEvents.eventKey, `stage-terminal:${evaluatorStage!.issueId}`))
      .then((rows) => rows[0]);
    expect(terminal).toMatchObject({
      eventType: 'stage_failed',
      score: 6,
      maxScore: 10,
      resolvedAdapterType: 'minion_drone',
      resolvedModel: 'gpt-5.4',
      resolvedProvider: 'openai',
      outputSnapshot: {
        finalizationStatus: 'changes_requested',
        validatedOutput: { score: 6, recommendation: 'revise' },
      },
      decisionSnapshot: { outcome: 'failed', score: 6, passingScore: 7 },
    });
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
    expect(
      await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
    ).toHaveLength(1);
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
