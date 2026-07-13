import { randomUUID } from "node:crypto";
import type {
  IssuePipelineEventType,
  IssuePipelineRoutingSnapshot,
  IssuePipelineRun,
  IssuePipelineSnapshot,
  PipelineStep,
} from "@paperclipai/shared";

export type StageTaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export interface IssuePipelineStageTask {
  id: string;
  runId: string;
  issueId: string;
  stageKey: string;
  stageKind: PipelineStep["kind"];
  attempt: number;
  materializationKey: string;
  status: StageTaskStatus;
}

export interface AppendPipelineEventInput {
  runId: string;
  companyId: string;
  issueId: string;
  eventKey: string;
  eventType: IssuePipelineEventType;
  childIssueId?: string | null;
  stepKey?: string | null;
  attempt?: number | null;
  outputSnapshot?: Record<string, unknown> | null;
  score?: number | null;
  maxScore?: number | null;
}

export interface MaterializeStageTaskInput {
  runId: string;
  companyId: string;
  selectedProjectId: string | null;
  issueId: string;
  step: PipelineStep;
  attempt: number;
  materializationKey: string;
  title: string;
  description: string;
}

export interface IssuePipelineOrchestratorRepository {
  /** Must serialize operations for one run and wrap all writes in one transaction. */
  withRunLock<T>(
    runId: string,
    operation: (repository: IssuePipelineOrchestratorRepository) => Promise<T>,
  ): Promise<T>;
  createRunIfAbsent(input: {
    id: string;
    companyId: string;
    selectedProjectId: string;
    issueId: string;
    sourceKey: string;
    sourceDeliveryId?: string | null;
    pipelineSnapshot: IssuePipelineSnapshot;
    routingSnapshot?: IssuePipelineRoutingSnapshot;
    currentStepKey: string;
  }): Promise<{ run: IssuePipelineRun; created: boolean }>;
  getRun(runId: string): Promise<IssuePipelineRun | null>;
  listStageTasks(runId: string): Promise<IssuePipelineStageTask[]>;
  /**
   * Must atomically create/reuse the child, replace the root issue's active
   * pipeline blocker edge with that child, and leave the root `blocked` with
   * reason `waiting_on_pipeline_stage:<stepKey>:<attempt>`.
   */
  materializeStageTask(input: MaterializeStageTaskInput): Promise<{
    task: IssuePipelineStageTask;
    created: boolean;
  }>;
  /** Returns false when eventKey was already appended for this run. */
  appendEventOnce(input: AppendPipelineEventInput): Promise<boolean>;
  setRunCursor(runId: string, stepKey: string): Promise<IssuePipelineRun>;
  setRunBlocked(runId: string, reason: string): Promise<IssuePipelineRun>;
  setRunCompleted(runId: string): Promise<IssuePipelineRun>;
  /** Keeps the high-level issue visibly aligned when a run stops or completes. */
  setMainIssueStatus(input: {
    companyId: string;
    issueId: string;
    status: "blocked" | "done";
    reason?: string | null;
  }): Promise<void>;
}

export interface StartIssuePipelineInput {
  companyId: string;
  selectedProjectId: string;
  issueId: string;
  /** Stable ingress key derived from the original issue delivery. */
  sourceKey: string;
  sourceDeliveryId?: string | null;
  pipelineSnapshot: IssuePipelineSnapshot;
  /** Classification and deterministic route evidence available before run creation. */
  routingSnapshot?: IssuePipelineRoutingSnapshot;
}

export interface CompleteStageTaskInput {
  runId: string;
  stageTaskId: string;
  terminalStatus: "done" | "cancelled" | "blocked";
  outcome?: "passed" | "failed";
  score?: number | null;
  maxScore?: number | null;
  summary?: string | null;
}

export interface IssuePipelineOrchestratorOptions {
  createId?: () => string;
}

function cloneFrozenPipeline(pipeline: IssuePipelineSnapshot): IssuePipelineSnapshot {
  return structuredClone(pipeline);
}

function assertPipeline(pipeline: IssuePipelineSnapshot): void {
  if (!pipeline.pipelineId.trim()) throw new Error("pipelineId is required");
  if (pipeline.executionMode !== "stage_tasks") throw new Error("orchestrated pipeline must use stage_tasks mode");
  if (pipeline.steps.length === 0) throw new Error("pipeline must contain at least one step");

  const stageKeys = new Set<string>();
  for (const stage of pipeline.steps) {
    if (!stage.key.trim()) throw new Error("pipeline stage key is required");
    if (stageKeys.has(stage.key)) throw new Error(`duplicate pipeline stage key: ${stage.key}`);
    stageKeys.add(stage.key);
    if (stage.kind === "eval") {
      if (typeof stage.minScore !== "number") throw new Error(`eval stage ${stage.key} requires minScore`);
      if (typeof stage.maxScore !== "number") throw new Error(`eval stage ${stage.key} requires maxScore`);
      if (stage.maxScore < stage.minScore) throw new Error(`eval stage ${stage.key} has maxScore below minScore`);
    }
  }

  for (const stage of pipeline.steps) {
    if (stage.onFailStepKey && !stageKeys.has(stage.onFailStepKey)) {
      throw new Error(`stage ${stage.key} has unknown onFailStepKey ${stage.onFailStepKey}`);
    }
    if (stage.onFailStepKey && (!Number.isInteger(stage.maxAttempts) || (stage.maxAttempts ?? 0) < 1)) {
      throw new Error(`stage ${stage.key} requires a positive maxAttempts when onFailStepKey is set`);
    }
  }
}

function stageMaterializationKey(runId: string, stageKey: string, attempt: number): string {
  return `${runId}:${stageKey}:${attempt}`;
}

function taskDescription(run: IssuePipelineRun, stage: PipelineStep, attempt: number): string {
  return [
    `Pipeline: ${run.pipelineSnapshot.name}`,
    `Stage: ${stage.label} (${stage.key})`,
    `Attempt: ${attempt}`,
    `Main task: ${run.issueId}`,
    stage.rubric?.trim() || null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function stageAttempt(tasks: IssuePipelineStageTask[], stageKey: string): number {
  return tasks.reduce((highest, task) => (task.stageKey === stageKey ? Math.max(highest, task.attempt) : highest), 0);
}

function stageByKey(run: IssuePipelineRun, stageKey: string): PipelineStep {
  const stage = run.pipelineSnapshot.steps.find((candidate) => candidate.key === stageKey);
  if (!stage) throw new Error(`run ${run.id} references missing stage ${stageKey}`);
  return stage;
}

function nextStage(run: IssuePipelineRun, currentStageKey: string): PipelineStep | null {
  const index = run.pipelineSnapshot.steps.findIndex((stage) => stage.key === currentStageKey);
  if (index < 0) throw new Error(`run ${run.id} references missing stage ${currentStageKey}`);
  return run.pipelineSnapshot.steps[index + 1] ?? null;
}

export function issuePipelineOrchestrator(
  repository: IssuePipelineOrchestratorRepository,
  options: IssuePipelineOrchestratorOptions = {},
) {
  const createId = options.createId ?? randomUUID;

  async function materializeStage(
    stageRepository: IssuePipelineOrchestratorRepository,
    run: IssuePipelineRun,
    stage: PipelineStep,
    attempt: number,
  ): Promise<IssuePipelineStageTask> {
    const materializationKey = stageMaterializationKey(run.id, stage.key, attempt);
    const { task } = await stageRepository.materializeStageTask({
      runId: run.id,
      companyId: run.companyId,
      selectedProjectId: run.selectedProjectId,
      issueId: run.issueId,
      step: stage,
      attempt,
      materializationKey,
      title: `[${stage.label}] ${run.pipelineSnapshot.name} (attempt ${attempt})`,
      description: taskDescription(run, stage, attempt),
    });
    // Always claim the semantic event. This repairs a legacy/interrupted child
    // materialization that exists without its event while remaining idempotent.
    await stageRepository.appendEventOnce({
      runId: run.id,
      companyId: run.companyId,
      issueId: run.issueId,
      eventKey: `stage-created:${stage.key}:${attempt}`,
      eventType: "stage_created",
      childIssueId: task.issueId,
      stepKey: stage.key,
      attempt,
    });
    return task;
  }

  async function blockRun(
    stageRepository: IssuePipelineOrchestratorRepository,
    run: IssuePipelineRun,
    reason: string,
    task: IssuePipelineStageTask,
  ): Promise<IssuePipelineRun> {
    const blocked = await stageRepository.setRunBlocked(run.id, reason);
    await stageRepository.setMainIssueStatus({
      companyId: run.companyId,
      issueId: run.issueId,
      status: "blocked",
      reason,
    });
    await stageRepository.appendEventOnce({
      runId: run.id,
      companyId: run.companyId,
      issueId: run.issueId,
      eventKey: `run-blocked:${task.id}`,
      eventType: "run_blocked",
      childIssueId: task.issueId,
      stepKey: task.stageKey,
      attempt: task.attempt,
      outputSnapshot: { reason },
    });
    return blocked;
  }

  return {
    start: async (input: StartIssuePipelineInput): Promise<{
      run: IssuePipelineRun;
      stageTask: IssuePipelineStageTask;
      created: boolean;
    }> => {
      assertPipeline(input.pipelineSnapshot);
      const pipelineSnapshot = cloneFrozenPipeline(input.pipelineSnapshot);
      const firstStage = pipelineSnapshot.steps[0]!;
      const proposedRunId = createId();
      const claimed = await repository.createRunIfAbsent({
        id: proposedRunId,
        companyId: input.companyId,
        selectedProjectId: input.selectedProjectId,
        issueId: input.issueId,
        sourceKey: input.sourceKey,
        sourceDeliveryId: input.sourceDeliveryId,
        pipelineSnapshot,
        routingSnapshot: input.routingSnapshot ? structuredClone(input.routingSnapshot) : undefined,
        currentStepKey: firstStage.key,
      });

      return repository.withRunLock(claimed.run.id, async (stageRepository) => {
        const run = (await stageRepository.getRun(claimed.run.id)) ?? claimed.run;
        const frozenFirstStage = stageByKey(run, run.pipelineSnapshot.steps[0]!.key);
        await stageRepository.appendEventOnce({
          runId: run.id,
          companyId: run.companyId,
          issueId: run.issueId,
          eventKey: "run-created",
          eventType: "run_created",
          stepKey: frozenFirstStage.key,
          outputSnapshot: {
            pipelineId: run.pipelineSnapshot.pipelineId,
            pipelineSnapshotHash: run.pipelineSnapshotHash,
          },
        });
        // Replaying start repairs a crash between the run claim and its first
        // event/task without duplicating either write.
        const stageTask = await materializeStage(stageRepository, run, frozenFirstStage, 1);
        return { run, stageTask, created: claimed.created };
      });
    },

    completeStageTask: async (input: CompleteStageTaskInput): Promise<IssuePipelineRun> =>
      repository.withRunLock(input.runId, async (stageRepository) => {
        const run = await stageRepository.getRun(input.runId);
        if (!run) throw new Error(`pipeline run not found: ${input.runId}`);

        const tasks = await stageRepository.listStageTasks(run.id);
        const task = tasks.find((candidate) => candidate.id === input.stageTaskId);
        if (!task) throw new Error(`stage task ${input.stageTaskId} does not belong to run ${run.id}`);
        const stage = stageByKey(run, task.stageKey);
        const evalFailed =
          stage.kind === "eval" &&
          (typeof input.score !== "number" || input.score < (stage.minScore ?? Number.POSITIVE_INFINITY));
        const failed = input.terminalStatus !== "done" || input.outcome === "failed" || evalFailed;

        // The task id, rather than a callback-supplied token, is the completion claim.
        // A second callback for the same child is therefore harmless even after the run advanced.
        const claimed = await stageRepository.appendEventOnce({
          runId: run.id,
          companyId: run.companyId,
          issueId: run.issueId,
          eventKey: `stage-terminal:${task.id}`,
          eventType: failed ? "stage_failed" : "stage_completed",
          childIssueId: task.issueId,
          stepKey: task.stageKey,
          attempt: task.attempt,
          outputSnapshot: {
            terminalStatus: input.terminalStatus,
            outcome: input.outcome ?? null,
            summary: input.summary ?? null,
          },
          score: input.score ?? null,
          maxScore: input.maxScore ?? null,
        });
        if (!claimed) return run;

        if (run.status !== "active") return run;
        if (run.currentStepKey !== task.stageKey) {
          throw new Error(`stage task ${task.id} is not current for run ${run.id}`);
        }

        if (input.terminalStatus === "blocked") {
          return blockRun(stageRepository, run, input.summary?.trim() || `${task.stageKey} is blocked`, task);
        }
        if (input.terminalStatus === "cancelled") {
          return blockRun(stageRepository, run, input.summary?.trim() || `${task.stageKey} was cancelled`, task);
        }

        if (failed) {
          if (!stage.onFailStepKey) {
            return blockRun(
              stageRepository,
              run,
              input.summary?.trim() || `${stage.label} failed without a retry route`,
              task,
            );
          }
          const retryStage = stageByKey(run, stage.onFailStepKey);
          const completedAttempts = stageAttempt(tasks, retryStage.key);
          const maxAttempts = stage.maxAttempts ?? 1;
          if (completedAttempts >= maxAttempts) {
            return blockRun(
              stageRepository,
              run,
              `${stage.label} failed and ${retryStage.label} exhausted ${maxAttempts} attempts`,
              task,
            );
          }
          const nextAttempt = completedAttempts + 1;
          const advanced = await stageRepository.setRunCursor(run.id, retryStage.key);
          await stageRepository.appendEventOnce({
            runId: run.id,
            companyId: run.companyId,
            issueId: run.issueId,
            eventKey: `stage-retry:${retryStage.key}:${nextAttempt}`,
            eventType: "stage_retry_scheduled",
            childIssueId: task.issueId,
            stepKey: retryStage.key,
            attempt: nextAttempt,
            outputSnapshot: { failedStepKey: stage.key },
            score: input.score ?? null,
            maxScore: input.maxScore ?? null,
          });
          await materializeStage(stageRepository, advanced, retryStage, nextAttempt);
          return advanced;
        }

        const followingStage = nextStage(run, stage.key);
        if (!followingStage) {
          const completed = await stageRepository.setRunCompleted(run.id);
          await stageRepository.setMainIssueStatus({
            companyId: run.companyId,
            issueId: run.issueId,
            status: "done",
          });
          await stageRepository.appendEventOnce({
            runId: run.id,
            companyId: run.companyId,
            issueId: run.issueId,
            eventKey: "run-completed",
            eventType: "run_completed",
            childIssueId: task.issueId,
            stepKey: task.stageKey,
            attempt: task.attempt,
          });
          return completed;
        }

        const attempt = stageAttempt(tasks, followingStage.key) + 1;
        const advanced = await stageRepository.setRunCursor(run.id, followingStage.key);
        await materializeStage(stageRepository, advanced, followingStage, attempt);
        return advanced;
      }),
  };
}
