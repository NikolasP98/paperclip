import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import type { IssuePipelineRun, IssuePipelineSnapshot } from '@paperclipai/shared';
import {
  issuePipelineOrchestrator,
  type AppendPipelineEventInput,
  type IssuePipelineOrchestratorRepository,
  type IssuePipelineStageTask,
  type MaterializeStageTaskInput,
} from './issue-pipeline-orchestrator.js';
import { issuePipelineStageTraversalService } from './issue-pipeline-stage-traversal.js';

const deliveryPipeline: IssuePipelineSnapshot = {
  pipelineId: 'pipeline-delivery',
  name: 'Delivery',
  description: null,
  executionMode: 'stage_tasks',
  trigger: null,
  steps: [
    {
      key: 'plan',
      kind: 'work',
      label: 'Plan',
      participant: { type: 'agent', agentId: 'agent-plan' },
    },
    {
      key: 'implement',
      kind: 'work',
      label: 'Implement',
      participant: { type: 'agent', agentId: 'agent-implement' },
    },
  ],
};

const evaluationPipeline: IssuePipelineSnapshot = {
  pipelineId: 'pipeline-evaluation',
  name: 'Evaluation retry',
  description: null,
  executionMode: 'stage_tasks',
  trigger: null,
  steps: [
    {
      key: 'evaluate',
      kind: 'eval',
      label: 'Evaluate',
      participant: { type: 'agent', agentId: 'agent-evaluate' },
      minScore: 7,
      maxScore: 10,
      onFailStepKey: 'implement',
      maxAttempts: 2,
    },
    {
      key: 'implement',
      kind: 'work',
      label: 'Implement',
      participant: { type: 'agent', agentId: 'agent-implement' },
    },
  ],
};

class MemoryRepository implements IssuePipelineOrchestratorRepository {
  runs = new Map<string, IssuePipelineRun>();
  tasks: IssuePipelineStageTask[] = [];
  events: AppendPipelineEventInput[] = [];
  eventKeys = new Set<string>();

  async withRunLock<T>(
    _runId: string,
    operation: (repository: IssuePipelineOrchestratorRepository) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }

  async createRunIfAbsent(
    input: Parameters<IssuePipelineOrchestratorRepository['createRunIfAbsent']>[0],
  ) {
    const existing = [...this.runs.values()].find((run) => run.sourceOriginId === input.sourceKey);
    if (existing) return { run: existing, created: false };
    const now = new Date('2026-07-12T12:00:00.000Z');
    const run: IssuePipelineRun = {
      id: input.id,
      companyId: input.companyId,
      pipelineId: input.pipelineSnapshot.pipelineId,
      issueId: input.issueId,
      executionMode: 'stage_tasks',
      status: 'active',
      currentStepKey: input.currentStepKey,
      sourceOriginKind: 'github_issue',
      sourceOriginId: input.sourceKey,
      sourceDeliveryId: null,
      pipelineSnapshot: input.pipelineSnapshot,
      pipelineSnapshotHash: 'pipeline-hash',
      routingSnapshot: {
        repository: 'nikolasp98/minion',
        originalLabels: [],
        inferredLabels: [],
        classifierOutput: null,
        candidates: [],
        selectedPortfolioId: null,
        selectedProjectId: input.selectedProjectId,
        confidence: 1,
        resolution: 'rule',
        reason: 'test',
      },
      routingSnapshotHash: 'routing-hash',
      selectedPortfolioId: null,
      selectedProjectId: input.selectedProjectId,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return { run, created: true };
  }

  async getRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  async listStageTasks(runId: string) {
    return this.tasks.filter((task) => task.runId === runId);
  }

  async materializeStageTask(input: MaterializeStageTaskInput) {
    const existing = this.tasks.find(
      (task) => task.materializationKey === input.materializationKey,
    );
    if (existing) return { task: existing, created: false };
    const id = `issue-${this.tasks.length + 1}`;
    const task: IssuePipelineStageTask = {
      id,
      issueId: id,
      runId: input.runId,
      stageKey: input.step.key,
      stageKind: input.step.kind,
      attempt: input.attempt,
      materializationKey: input.materializationKey,
      status: 'todo',
    };
    this.tasks.push(task);
    return { task, created: true };
  }

  async appendEventOnce(input: AppendPipelineEventInput) {
    const key = `${input.runId}:${input.eventKey}`;
    if (this.eventKeys.has(key)) return false;
    this.eventKeys.add(key);
    this.events.push(input);
    return true;
  }

  async setRunCursor(runId: string, stepKey: string) {
    return this.patchRun(runId, { currentStepKey: stepKey, status: 'active' });
  }

  async setRunBlocked(runId: string) {
    return this.patchRun(runId, { status: 'blocked' });
  }

  async setRunCompleted(runId: string) {
    return this.patchRun(runId, {
      status: 'completed',
      currentStepKey: null,
      completedAt: new Date(),
    });
  }

  async setMainIssueStatus() {}

  private patchRun(runId: string, patch: Partial<IssuePipelineRun>) {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`Missing run ${runId}`);
    const updated = { ...current, ...patch, updatedAt: new Date(current.updatedAt.getTime() + 1) };
    this.runs.set(runId, updated);
    return updated;
  }
}

async function setup(pipeline: IssuePipelineSnapshot) {
  const repository = new MemoryRepository();
  const orchestrator = issuePipelineOrchestrator(repository, { createId: () => 'run-1' });
  await orchestrator.start({
    companyId: 'company-1',
    selectedProjectId: 'project-1',
    issueId: 'root-issue',
    sourceKey: 'delivery-1',
    pipelineSnapshot: pipeline,
  });
  const wakeup = vi.fn().mockResolvedValue({ id: 'heartbeat-run-1' });
  const service = issuePipelineStageTraversalService({} as Db, {
    repository,
    heartbeat: { wakeup },
    resolveIssue: async (issueId) => {
      const task = repository.tasks.find((candidate) => candidate.issueId === issueId);
      const step = pipeline.steps.find((candidate) => candidate.key === task?.stageKey);
      return task
        ? {
            id: task.issueId,
            assigneeAgentId:
              step?.participant.type === 'agent' ? (step.participant.agentId ?? null) : null,
            status: task.status,
          }
        : null;
    },
  });
  return { repository, service, wakeup };
}

function committedStageIssue(status: 'done' | 'blocked' | 'cancelled') {
  return {
    id: 'issue-1',
    companyId: 'company-1',
    originKind: 'pipeline_step',
    originId: 'run-1',
    status,
  };
}

describe('issuePipelineStageTraversalService', () => {
  it('advances a committed terminal child and wakes the next agent only for the exact-once claimant', async () => {
    const { repository, service, wakeup } = await setup(deliveryPipeline);

    const first = await service.afterCommittedIssueMutation({
      issue: committedStageIssue('done'),
      pipelineOutcome: 'passed',
      pipelineSummary: 'Plan accepted',
      requestedByActorType: 'agent',
      requestedByActorId: 'agent-plan',
    });
    const duplicate = await service.afterCommittedIssueMutation({
      issue: committedStageIssue('done'),
      pipelineOutcome: 'passed',
      pipelineSummary: 'Plan accepted',
    });

    expect(first).toMatchObject({ handled: true, claimed: true });
    expect(first.nextStageTask).toMatchObject({ stageKey: 'implement', attempt: 1 });
    expect(duplicate).toMatchObject({ handled: true, claimed: false, nextStageTask: null });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      'agent-implement',
      expect.objectContaining({
        reason: 'pipeline_stage_materialized',
        payload: { issueId: 'issue-2', mutation: 'pipeline_stage_advance' },
      }),
    );
    expect(
      repository.events.find((event) => event.eventKey === 'stage-terminal:issue-1')
        ?.outputSnapshot,
    ).toMatchObject({ outcome: 'passed', summary: 'Plan accepted' });
  });

  it('never treats blocked or cancelled tasks as retry approval', async () => {
    const { repository, service, wakeup } = await setup(deliveryPipeline);

    const result = await service.afterCommittedIssueMutation({
      issue: committedStageIssue('blocked'),
      pipelineOutcome: 'passed',
      pipelineSummary: 'Waiting for credentials',
    });

    expect(result.run?.status).toBe('blocked');
    expect(result.nextStageTask).toBeNull();
    expect(wakeup).not.toHaveBeenCalled();
    expect(
      repository.events.find((event) => event.eventKey === 'stage-terminal:issue-1')
        ?.outputSnapshot,
    ).toMatchObject({
      terminalStatus: 'blocked',
      outcome: null,
      summary: 'Waiting for credentials',
    });
  });

  it('maps evaluator score and summary into a failed event and wakes the retry stage', async () => {
    const { repository, service, wakeup } = await setup(evaluationPipeline);

    const result = await service.afterCommittedIssueMutation({
      issue: committedStageIssue('done'),
      pipelineOutcome: 'failed',
      pipelineSummary: 'Regression coverage is incomplete',
      evalScore: 6,
    });

    expect(result.run).toMatchObject({ status: 'active', currentStepKey: 'implement' });
    expect(result.nextStageTask).toMatchObject({ stageKey: 'implement', attempt: 1 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(
      repository.events.find((event) => event.eventKey === 'stage-terminal:issue-1'),
    ).toMatchObject({
      eventType: 'stage_failed',
      score: 6,
      maxScore: 10,
      outputSnapshot: { outcome: 'failed', summary: 'Regression coverage is incomplete' },
    });
  });

  it('keeps the committed traversal successful when the best-effort wake is rejected', async () => {
    const { service, wakeup } = await setup(deliveryPipeline);
    wakeup.mockRejectedValueOnce(new Error('adapter unavailable'));

    await expect(
      service.afterCommittedIssueMutation({
        issue: committedStageIssue('done'),
        pipelineOutcome: 'passed',
        pipelineSummary: 'Plan accepted',
      }),
    ).resolves.toMatchObject({
      handled: true,
      claimed: true,
      run: { status: 'active', currentStepKey: 'implement' },
      nextStageTask: { stageKey: 'implement' },
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});
