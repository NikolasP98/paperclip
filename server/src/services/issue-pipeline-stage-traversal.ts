import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { agentTaskSessions, heartbeatRuns, type Db } from '@paperclipai/db';
import type { IssuePipelineRun } from '@paperclipai/shared';
import { logger } from '../middleware/logger.js';
import { captureAttributedHarnessLearningSignal } from './agent-harness.js';
import { issueService } from './issues.js';
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from './issue-assignment-wakeup.js';
import {
  issuePipelineOrchestrator,
  type CompleteStageTaskTransition,
  type IssuePipelineOrchestratorRepository,
  type IssuePipelineStageTask,
} from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';

const TERMINAL_STAGE_STATUSES = new Set(['done', 'blocked', 'cancelled'] as const);

export type PipelineStageTerminalStatus = 'done' | 'blocked' | 'cancelled';
export type PipelineStageOutcome = 'passed' | 'failed';

export interface CommittedPipelineStageIssue {
  id: string;
  companyId: string;
  originKind: string;
  originId: string | null;
  status: string;
}

export interface AfterCommittedIssueMutationInput {
  issue: CommittedPipelineStageIssue;
  pipelineOutcome?: PipelineStageOutcome;
  pipelineSummary?: string | null;
  evalScore?: number;
  feedbackScore?: number;
  requestedByActorType?: 'user' | 'agent' | 'system';
  requestedByActorId?: string | null;
}

export interface PipelineStageTraversalResult {
  handled: boolean;
  claimed: boolean;
  run: IssuePipelineRun | null;
  nextStageTask: IssuePipelineStageTask | null;
}

interface WakeableIssue {
  id: string;
  assigneeAgentId: string | null;
  status: string;
}

export interface IssuePipelineStageTraversalDeps {
  heartbeat: IssueAssignmentWakeupDeps;
  repository?: IssuePipelineOrchestratorRepository;
  resolveIssue?: (issueId: string) => Promise<WakeableIssue | null>;
  captureLearningSignal?: (
    input: Parameters<typeof captureAttributedHarnessLearningSignal>[1],
  ) => Promise<unknown>;
  resolveWorkerEvidence?: (input: {
    companyId: string;
    workerAgentId: string;
    workerTaskId: string;
  }) => Promise<PipelineWorkerLearningEvidence>;
}

export interface PipelineWorkerLearningEvidence {
  harnessRevisionId: string | null;
  heartbeatRunId: string | null;
  source: 'heartbeat_run' | 'task_session' | 'task_session_revision' | 'none';
}

function terminalStatus(status: string): PipelineStageTerminalStatus | null {
  return TERMINAL_STAGE_STATUSES.has(status as PipelineStageTerminalStatus)
    ? (status as PipelineStageTerminalStatus)
    : null;
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
 * Advances a stage-task pipeline after the issue mutation that made its child
 * terminal has committed. The orchestrator's run lock and stage-terminal event
 * are the exact-once claim; only that claimant may wake a newly created stage.
 */
export function issuePipelineStageTraversalService(db: Db, deps: IssuePipelineStageTraversalDeps) {
  const repository = deps.repository ?? issuePipelineOrchestratorRepository(db);
  const orchestrator = issuePipelineOrchestrator(repository);
  const resolveIssue =
    deps.resolveIssue ?? (async (issueId: string) => issueService(db).getById(issueId));
  const captureLearningSignal =
    deps.captureLearningSignal ??
    ((input: Parameters<typeof captureAttributedHarnessLearningSignal>[1]) =>
      captureAttributedHarnessLearningSignal(db, input));
  const resolveEvidence =
    deps.resolveWorkerEvidence ??
    ((input: { companyId: string; workerAgentId: string; workerTaskId: string }) =>
      resolveWorkerLearningEvidence(db, input));

  async function captureStageLearning(
    input: AfterCommittedIssueMutationInput,
    run: IssuePipelineRun,
  ) {
    const body = input.pipelineSummary?.trim();
    if (!body) return;
    const tasks = await repository.listStageTasks(run.id);
    const gateTaskIndex = tasks.findIndex((task) => task.issueId === input.issue.id);
    if (gateTaskIndex < 0) return;
    const gateTask = tasks[gateTaskIndex]!;
    const gateStep = run.pipelineSnapshot.steps.find((step) => step.key === gateTask.stageKey);
    if (
      !gateStep ||
      (gateStep.kind !== 'eval' && gateStep.kind !== 'approval') ||
      !gateStep.onFailStepKey
    ) {
      return;
    }
    const workerStep = run.pipelineSnapshot.steps.find(
      (step) => step.key === gateStep.onFailStepKey,
    );
    if (
      !workerStep ||
      workerStep.kind !== 'work' ||
      workerStep.participant.type !== 'agent' ||
      !workerStep.participant.agentId
    ) {
      return;
    }
    // The failed transition may already have materialized the next worker
    // attempt. Only a worker task ordered before this gate produced the
    // artifact that was actually reviewed.
    const workerTask = tasks
      .slice(0, gateTaskIndex)
      .reverse()
      .find((task) => task.stageKey === workerStep.key);
    if (!workerTask) return;

    const workerAgentId = workerStep.participant.agentId;
    const evidence = await resolveEvidence({
      companyId: run.companyId,
      workerAgentId,
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

    await captureLearningSignal({
      companyId: run.companyId,
      agentId: workerAgentId,
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
      },
    });
  }

  return {
    async afterCommittedIssueMutation(
      input: AfterCommittedIssueMutationInput,
    ): Promise<PipelineStageTraversalResult> {
      const status = terminalStatus(input.issue.status);
      if (input.issue.originKind !== 'pipeline_step' || !input.issue.originId || !status) {
        return { handled: false, claimed: false, run: null, nextStageTask: null };
      }

      let transition: CompleteStageTaskTransition = { claimed: false, nextStageTask: null };
      const run = await orchestrator.completeStageTask(
        {
          runId: input.issue.originId,
          stageTaskId: input.issue.id,
          terminalStatus: status,
          // A blocked or cancelled task must never be interpreted as approval,
          // even if a stale client also submitted pipelineOutcome="passed".
          outcome: status === 'done' ? input.pipelineOutcome : undefined,
          score: input.evalScore,
          summary: input.pipelineSummary,
        },
        (observed) => {
          transition = observed;
        },
      );

      try {
        await captureStageLearning(input, run);
      } catch (err) {
        logger.warn(
          {
            err,
            pipelineRunId: run.id,
            completedStageTaskId: input.issue.id,
          },
          'failed to capture attributed pipeline harness learning signal',
        );
      }

      if (transition.claimed && transition.nextStageTask) {
        try {
          const nextIssue = await resolveIssue(transition.nextStageTask.issueId);
          if (nextIssue) {
            await queueIssueAssignmentWakeup({
              heartbeat: deps.heartbeat,
              issue: nextIssue,
              reason: 'pipeline_stage_materialized',
              mutation: 'pipeline_stage_advance',
              contextSource: 'issue.pipeline_stage_traversal',
              requestedByActorType: input.requestedByActorType ?? 'system',
              requestedByActorId: input.requestedByActorId ?? null,
            });
          }
        } catch (err) {
          logger.warn(
            {
              err,
              pipelineRunId: run.id,
              completedStageTaskId: input.issue.id,
              nextStageTaskId: transition.nextStageTask.issueId,
            },
            'failed to wake newly materialized pipeline stage assignee',
          );
        }
      }

      return {
        handled: true,
        claimed: transition.claimed,
        run,
        nextStageTask: transition.nextStageTask,
      };
    },
  };
}

export type IssuePipelineStageTraversalService = ReturnType<
  typeof issuePipelineStageTraversalService
>;
