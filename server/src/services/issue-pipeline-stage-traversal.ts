import type { Db } from '@paperclipai/db';
import type { IssuePipelineRun } from '@paperclipai/shared';
import { logger } from '../middleware/logger.js';
import { issueService } from './issues.js';
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from './issue-assignment-wakeup.js';
import {
  blockPipelineDroneDispatchFailure,
  buildReleaseApprovalDecisionSnapshot,
  materializeApprovedPlan,
  queuePipelineStageTaskWakeup,
} from './issue-pipeline-drone-stages.js';
import {
  issuePipelineOrchestrator,
  type CompleteStageTaskTransition,
  type IssuePipelineOrchestratorRepository,
  type IssuePipelineStageTask,
} from './issue-pipeline-orchestrator.js';
import { issuePipelineOrchestratorRepository } from './issue-pipeline-repository.js';
import {
  capturePipelineStageLearning,
  type PipelineStageLearningDeps,
  type PipelineWorkerLearningEvidence,
} from './issue-pipeline-stage-learning.js';

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
  captureLearningSignal?: PipelineStageLearningDeps['captureLearningSignal'];
  resolveWorkerEvidence?: (input: {
    companyId: string;
    workerAgentId: string;
    workerTaskId: string;
  }) => Promise<PipelineWorkerLearningEvidence>;
}

function terminalStatus(status: string): PipelineStageTerminalStatus | null {
  return TERMINAL_STAGE_STATUSES.has(status as PipelineStageTerminalStatus)
    ? (status as PipelineStageTerminalStatus)
    : null;
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
  return {
    async afterCommittedIssueMutation(
      input: AfterCommittedIssueMutationInput,
    ): Promise<PipelineStageTraversalResult> {
      const status = terminalStatus(input.issue.status);
      if (input.issue.originKind !== 'pipeline_step' || !input.issue.originId || !status) {
        return { handled: false, claimed: false, run: null, nextStageTask: null };
      }

      const observedRun = await repository.getRun(input.issue.originId);
      const observedTasks = observedRun ? await repository.listStageTasks(observedRun.id) : [];
      const observedTask = observedTasks.find((task) => task.issueId === input.issue.id) ?? null;
      const observedStep =
        observedRun && observedTask
          ? observedRun.pipelineSnapshot.steps.find((step) => step.key === observedTask.stageKey)
          : null;
      let decisionSnapshot: Record<string, unknown> | null = null;

      if (
        !deps.repository &&
        observedRun &&
        observedTask &&
        observedStep?.kind === 'approval' &&
        status === 'done' &&
        input.pipelineOutcome === 'passed' &&
        input.requestedByActorType === 'user'
      ) {
        try {
          if (observedTask.stageKey === 'plan-approval') {
            const materialized = await materializeApprovedPlan({
              db,
              run: observedRun,
              approvalTaskId: observedTask.issueId,
              actorUserId: input.requestedByActorId,
            });
            decisionSnapshot = {
              outcome: 'approved',
              actor: input.requestedByActorId ?? null,
              acceptedPlanRevisionId: materialized.decomposition.acceptedPlanRevisionId,
              decompositionId: materialized.decomposition.id,
              childIssueIds: materialized.childIssueIds,
            };
          } else if (observedTask.stageKey === 'release-approval') {
            decisionSnapshot = await buildReleaseApprovalDecisionSnapshot({
              db,
              run: observedRun,
              actorId: input.requestedByActorId,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await issueService(db).update(input.issue.id, { status: 'blocked' });
          let blockedTransition: CompleteStageTaskTransition = {
            claimed: false,
            nextStageTask: null,
          };
          const blockedRun = await orchestrator.completeStageTask(
            {
              runId: observedRun.id,
              stageTaskId: observedTask.issueId,
              terminalStatus: 'blocked',
              summary: `Approval evidence could not be finalized: ${message}`,
              trace: {
                decisionSnapshot: {
                  outcome: 'blocked',
                  actor: input.requestedByActorId ?? null,
                  error: message,
                },
              },
            },
            (observed) => {
              blockedTransition = observed;
            },
          );
          return {
            handled: true,
            claimed: blockedTransition.claimed,
            run: blockedRun,
            nextStageTask: blockedTransition.nextStageTask,
          };
        }
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
          trace: decisionSnapshot ? { decisionSnapshot } : undefined,
        },
        (observed) => {
          transition = observed;
        },
      );

      try {
        await capturePipelineStageLearning(db, repository, input, run, {
          captureLearningSignal: deps.captureLearningSignal,
          resolveWorkerEvidence: deps.resolveWorkerEvidence,
        });
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
          if (deps.repository) {
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
                idempotencyKey: `pipeline-stage:${run.id}:${transition.nextStageTask.issueId}`,
              });
            }
          } else {
            await queuePipelineStageTaskWakeup({
              db,
              heartbeat: deps.heartbeat,
              run,
              stageTask: transition.nextStageTask,
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
          if (!deps.repository) {
            await blockPipelineDroneDispatchFailure({
              db,
              run,
              stageTask: transition.nextStageTask,
              error: err,
            });
          }
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
