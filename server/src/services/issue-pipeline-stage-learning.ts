import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { agentTaskSessions, heartbeatRuns, type Db } from '@paperclipai/db';
import type { IssuePipelineRun } from '@paperclipai/shared';
import { captureAttributedHarnessLearningSignal } from './agent-harness.js';
import type { IssuePipelineOrchestratorRepository } from './issue-pipeline-orchestrator.js';

export interface PipelineWorkerLearningEvidence {
  harnessRevisionId: string | null;
  heartbeatRunId: string | null;
  source: 'heartbeat_run' | 'task_session' | 'task_session_revision' | 'none';
}

export interface PipelineStageLearningInput {
  issue: {
    id: string;
    companyId: string;
    status: string;
  };
  pipelineOutcome?: 'passed' | 'failed';
  pipelineSummary?: string | null;
  evalScore?: number;
  feedbackScore?: number;
  learningMetadata?: Record<string, unknown>;
}

export interface PipelineStageLearningDeps {
  captureLearningSignal?: (
    input: Parameters<typeof captureAttributedHarnessLearningSignal>[1],
  ) => Promise<unknown>;
  resolveWorkerEvidence?: (input: {
    companyId: string;
    workerAgentId: string;
    workerTaskId: string;
  }) => Promise<PipelineWorkerLearningEvidence>;
}

function learningSourceKey(runId: string, gateTaskId: string) {
  const digest = createHash('sha256')
    .update(JSON.stringify(['pipeline_stage_learning_v1', runId, gateTaskId]))
    .digest('base64url');
  return `pipeline-stage-learning:${digest}`;
}

async function resolveWorkerLearningEvidence(
  db: Db,
  input: { companyId: string; workerAgentId: string; workerTaskId: string },
): Promise<PipelineWorkerLearningEvidence> {
  const directRun = await db
    .select({ id: heartbeatRuns.id, harnessRevisionId: heartbeatRuns.harnessRevisionId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.workerAgentId),
        eq(heartbeatRuns.status, 'succeeded'),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.workerTaskId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${input.workerTaskId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskKey' = ${input.workerTaskId}`,
        ),
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (directRun) {
    return {
      harnessRevisionId: directRun.harnessRevisionId,
      heartbeatRunId: directRun.id,
      source: 'heartbeat_run',
    };
  }

  const session = await db
    .select({
      harnessRevisionId: agentTaskSessions.harnessRevisionId,
      lastRunId: agentTaskSessions.lastRunId,
    })
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.companyId, input.companyId),
        eq(agentTaskSessions.agentId, input.workerAgentId),
        eq(agentTaskSessions.taskKey, input.workerTaskId),
      ),
    )
    .orderBy(desc(agentTaskSessions.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!session) {
    return { harnessRevisionId: null, heartbeatRunId: null, source: 'none' };
  }
  if (session.lastRunId) {
    const sessionRun = await db
      .select({ id: heartbeatRuns.id, harnessRevisionId: heartbeatRuns.harnessRevisionId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, session.lastRunId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.workerAgentId),
          inArray(heartbeatRuns.status, ['succeeded']),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (sessionRun) {
      return {
        harnessRevisionId: sessionRun.harnessRevisionId ?? session.harnessRevisionId,
        heartbeatRunId: sessionRun.id,
        source: 'task_session',
      };
    }
  }
  return {
    harnessRevisionId: session.harnessRevisionId,
    heartbeatRunId: null,
    source: session.harnessRevisionId ? 'task_session_revision' : 'none',
  };
}

/**
 * Captures the immutable learning signal for an eval or approval stage. The
 * source key is derived from the run and gate task, so reconciliation replays
 * are exactly-once and conflicting evidence fails closed.
 */
export async function capturePipelineStageLearning(
  db: Db,
  repository: IssuePipelineOrchestratorRepository,
  input: PipelineStageLearningInput,
  run: IssuePipelineRun,
  deps: PipelineStageLearningDeps = {},
) {
  const body = input.pipelineSummary?.trim();
  if (!body) return null;
  const tasks = await repository.listStageTasks(run.id);
  const gateTaskIndex = tasks.findIndex((task) => task.issueId === input.issue.id);
  if (gateTaskIndex < 0) return null;
  const gateTask = tasks[gateTaskIndex]!;
  const gateStep = run.pipelineSnapshot.steps.find((step) => step.key === gateTask.stageKey);
  if (
    !gateStep ||
    (gateStep.kind !== 'eval' && gateStep.kind !== 'approval') ||
    !gateStep.onFailStepKey
  ) {
    return null;
  }
  const workerStep = run.pipelineSnapshot.steps.find((step) => step.key === gateStep.onFailStepKey);
  if (
    !workerStep ||
    workerStep.kind !== 'work' ||
    workerStep.participant.type !== 'agent' ||
    !workerStep.participant.agentId
  ) {
    return null;
  }
  const workerTask = tasks
    .slice(0, gateTaskIndex)
    .reverse()
    .find((task) => task.stageKey === workerStep.key);
  if (!workerTask) return null;

  const resolveEvidence =
    deps.resolveWorkerEvidence ??
    ((evidenceInput: { companyId: string; workerAgentId: string; workerTaskId: string }) =>
      resolveWorkerLearningEvidence(db, evidenceInput));
  const evidence = await resolveEvidence({
    companyId: run.companyId,
    workerAgentId: workerStep.participant.agentId,
    workerTaskId: workerTask.issueId,
  });
  const isEvaluation = gateStep.kind === 'eval';
  const approved = isEvaluation
    ? input.issue.status === 'done' &&
      input.pipelineOutcome !== 'failed' &&
      typeof input.evalScore === 'number' &&
      input.evalScore >= (gateStep.minScore ?? Number.POSITIVE_INFINITY)
    : input.issue.status === 'done' && input.pipelineOutcome === 'passed';
  const score = isEvaluation ? (input.evalScore ?? null) : (input.feedbackScore ?? null);
  const maxScore = isEvaluation
    ? (gateStep.maxScore ?? null)
    : input.feedbackScore == null
      ? null
      : 10;
  const capture =
    deps.captureLearningSignal ??
    ((signalInput: Parameters<typeof captureAttributedHarnessLearningSignal>[1]) =>
      captureAttributedHarnessLearningSignal(db, signalInput));

  return capture({
    companyId: run.companyId,
    agentId: workerStep.participant.agentId,
    sourceKey: learningSourceKey(run.id, gateTask.issueId),
    signalType: isEvaluation ? 'pipeline_evaluation' : 'pipeline_human_gate',
    outcome: approved ? 'approved' : 'changes_requested',
    body,
    score,
    maxScore,
    harnessRevisionId: evidence.harnessRevisionId,
    runId: evidence.heartbeatRunId,
    issueId: workerTask.issueId,
    metadata: {
      source: 'stage_task_pipeline',
      pipelineRunId: run.id,
      gateTaskId: gateTask.issueId,
      gateStageKey: gateStep.key,
      gateStageKind: gateStep.kind,
      gateAttempt: gateTask.attempt,
      workerTaskId: workerTask.issueId,
      workerStageKey: workerStep.key,
      workerAttempt: workerTask.attempt,
      evidenceSource: evidence.source,
      ...(input.learningMetadata ? { evaluationEvidence: input.learningMetadata } : {}),
    },
  });
}
