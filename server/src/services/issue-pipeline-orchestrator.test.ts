import { describe, expect, it } from "vitest";
import type { IssuePipelineRun, IssuePipelineSnapshot } from "@paperclipai/shared";
import {
  issuePipelineOrchestrator,
  type AppendPipelineEventInput,
  type IssuePipelineOrchestratorRepository,
  type IssuePipelineStageTask,
  type MaterializeStageTaskInput,
} from "./issue-pipeline-orchestrator.js";

const pipeline: IssuePipelineSnapshot = {
  pipelineId: "pipeline-1",
  name: "Shared code delivery",
  description: null,
  executionMode: "stage_tasks",
  trigger: null,
  steps: [
    {
      key: "plan",
      kind: "work",
      label: "Plan",
      participant: { type: "agent", agentId: "planner" },
    },
    {
      key: "plan-approval",
      kind: "approval",
      label: "Plan approval",
      participant: { type: "user", userId: null },
    },
    {
      key: "implement",
      kind: "work",
      label: "Implement",
      participant: { type: "agent", agentId: "implementer" },
    },
    {
      key: "evaluate",
      kind: "eval",
      label: "Evaluate",
      participant: { type: "agent", agentId: "evaluator" },
      minScore: 7,
      maxScore: 10,
      rubric: "Score the implementation from 0 to 10.",
      onFailStepKey: "implement",
      maxAttempts: 2,
    },
    {
      key: "merge-approval",
      kind: "approval",
      label: "Merge approval",
      participant: { type: "user", userId: null },
    },
    {
      key: "merge",
      kind: "work",
      label: "Merge",
      participant: { type: "agent", agentId: "merger" },
    },
  ],
};

class MemoryRepository implements IssuePipelineOrchestratorRepository {
  runs = new Map<string, IssuePipelineRun>();
  runIdBySourceKey = new Map<string, string>();
  tasks: IssuePipelineStageTask[] = [];
  events: AppendPipelineEventInput[] = [];
  eventKeys = new Set<string>();
  mainIssueStatuses: Array<{ status: "blocked" | "done"; reason?: string | null }> = [];

  async withRunLock<T>(_runId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async createRunIfAbsent(input: Parameters<IssuePipelineOrchestratorRepository["createRunIfAbsent"]>[0]) {
    const existingId = this.runIdBySourceKey.get(input.sourceKey);
    if (existingId) return { run: this.runs.get(existingId)!, created: false };
    const now = new Date("2026-07-12T12:00:00.000Z");
    const run: IssuePipelineRun = {
      id: input.id,
      companyId: input.companyId,
      pipelineId: input.pipelineSnapshot.pipelineId,
      issueId: input.issueId,
      executionMode: "stage_tasks",
      status: "active",
      currentStepKey: input.currentStepKey,
      sourceOriginKind: "github_issue",
      sourceOriginId: input.sourceKey,
      sourceDeliveryId: null,
      pipelineSnapshot: input.pipelineSnapshot,
      pipelineSnapshotHash: "snapshot-hash-1",
      routingSnapshot: {
        repository: "nikolasp98/minion",
        originalLabels: [],
        inferredLabels: [],
        classifierOutput: null,
        candidates: [],
        selectedPortfolioId: null,
        selectedProjectId: input.selectedProjectId,
        confidence: 1,
        resolution: "rule",
        reason: "test",
      },
      routingSnapshotHash: "routing-hash-1",
      selectedPortfolioId: null,
      selectedProjectId: input.selectedProjectId,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.runIdBySourceKey.set(input.sourceKey, run.id);
    return { run, created: true };
  }

  async getRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  async listStageTasks(runId: string) {
    return this.tasks.filter((task) => task.runId === runId);
  }

  async materializeStageTask(input: MaterializeStageTaskInput) {
    const existing = this.tasks.find((task) => task.materializationKey === input.materializationKey);
    if (existing) return { task: existing, created: false };
    const task: IssuePipelineStageTask = {
      id: `task-${this.tasks.length + 1}`,
      issueId: `issue-${this.tasks.length + 1}`,
      runId: input.runId,
      stageKey: input.step.key,
      stageKind: input.step.kind,
      attempt: input.attempt,
      materializationKey: input.materializationKey,
      status: "todo",
    };
    this.tasks.push(task);
    this.mainIssueStatuses.push({
      status: "blocked",
      reason: `waiting_on_pipeline_stage:${input.step.key}:${input.attempt}`,
    });
    return { task, created: true };
  }

  async appendEventOnce(input: AppendPipelineEventInput) {
    const key = `${input.runId}:${input.eventKey}`;
    if (this.eventKeys.has(key)) return false;
    this.eventKeys.add(key);
    this.events.push(input);
    return true;
  }

  async setRunCursor(runId: string, stageKey: string) {
    return this.patchRun(runId, { currentStepKey: stageKey });
  }

  async setRunBlocked(runId: string, reason: string) {
    void reason;
    return this.patchRun(runId, { status: "blocked" });
  }

  async setRunCompleted(runId: string) {
    return this.patchRun(runId, { status: "completed", currentStepKey: null, completedAt: new Date() });
  }

  async setMainIssueStatus(input: {
    status: "blocked" | "done";
    reason?: string | null;
  }) {
    this.mainIssueStatuses.push({ status: input.status, reason: input.reason });
  }

  private patchRun(runId: string, patch: Partial<IssuePipelineRun>) {
    const current = this.runs.get(runId);
    if (!current) throw new Error("run not found");
    const updated = { ...current, ...patch, updatedAt: new Date(current.updatedAt.getTime() + 1) };
    this.runs.set(runId, updated);
    return updated;
  }
}

function setup() {
  const repository = new MemoryRepository();
  const orchestrator = issuePipelineOrchestrator(repository, { createId: () => "run-1" });
  return { repository, orchestrator };
}

async function startAndCompleteThroughEvaluate(
  repository: MemoryRepository,
  orchestrator: ReturnType<typeof issuePipelineOrchestrator>,
) {
  await orchestrator.start({
    companyId: "company-1",
    selectedProjectId: "project-1",
    issueId: "main-issue-1",
    sourceKey: "main-issue-1:revision-7",
    pipelineSnapshot: pipeline,
  });
  for (const stageKey of ["plan", "plan-approval", "implement"] as const) {
    const task = repository.tasks.findLast((candidate) => candidate.stageKey === stageKey)!;
    await orchestrator.completeStageTask({ runId: "run-1", stageTaskId: task.id, terminalStatus: "done" });
  }
  return repository.tasks.findLast((task) => task.stageKey === "evaluate")!;
}

describe("issuePipelineOrchestrator", () => {
  it("freezes a run and materializes the first stage exactly once", async () => {
    const { repository, orchestrator } = setup();
    const input = {
      companyId: "company-1",
      selectedProjectId: "project-1",
      issueId: "main-issue-1",
      sourceKey: "main-issue-1:revision-7",
      pipelineSnapshot: pipeline,
    };

    const first = await orchestrator.start(input);
    const duplicate = await orchestrator.start(input);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(repository.tasks.map((task) => [task.stageKey, task.attempt])).toEqual([["plan", 1]]);
    expect(repository.events.filter((event) => event.eventType === "run_created")).toHaveLength(1);
    expect(repository.events.filter((event) => event.eventType === "stage_created")).toHaveLength(1);
    expect(first.run.pipelineSnapshot).not.toBe(pipeline);
    expect(repository.mainIssueStatuses).toEqual([
      { status: "blocked", reason: "waiting_on_pipeline_stage:plan:1" },
    ]);
  });

  it("repairs a run claim interrupted before its start event and first task", async () => {
    const { repository, orchestrator } = setup();
    await repository.createRunIfAbsent({
      id: "run-1",
      companyId: "company-1",
      selectedProjectId: "project-1",
      issueId: "main-issue-1",
      sourceKey: "interrupted-start",
      pipelineSnapshot: structuredClone(pipeline),
      currentStepKey: "plan",
    });

    const replay = await orchestrator.start({
      companyId: "company-1",
      selectedProjectId: "project-1",
      issueId: "main-issue-1",
      sourceKey: "interrupted-start",
      pipelineSnapshot: pipeline,
    });

    expect(replay.created).toBe(false);
    expect(repository.events.map((event) => event.eventType)).toEqual(["run_created", "stage_created"]);
    expect(repository.tasks).toHaveLength(1);
    expect(repository.mainIssueStatuses).toEqual([
      { status: "blocked", reason: "waiting_on_pipeline_stage:plan:1" },
    ]);
  });

  it("advances one stage at a time and ignores duplicate completion delivery", async () => {
    const { repository, orchestrator } = setup();
    await orchestrator.start({
      companyId: "company-1",
      selectedProjectId: "project-1",
      issueId: "main-issue-1",
      sourceKey: "source-1",
      pipelineSnapshot: pipeline,
    });
    const planTask = repository.tasks[0]!;

    await orchestrator.completeStageTask({ runId: "run-1", stageTaskId: planTask.id, terminalStatus: "done" });
    await orchestrator.completeStageTask({ runId: "run-1", stageTaskId: planTask.id, terminalStatus: "done" });

    expect(repository.tasks.map((task) => task.stageKey)).toEqual(["plan", "plan-approval"]);
    expect(repository.events.filter((event) => event.eventKey === `stage-terminal:${planTask.id}`)).toHaveLength(1);
    expect(repository.runs.get("run-1")?.currentStepKey).toBe("plan-approval");
  });

  it("routes a failed evaluation to a new implement attempt", async () => {
    const { repository, orchestrator } = setup();
    const evaluateTask = await startAndCompleteThroughEvaluate(repository, orchestrator);

    const run = await orchestrator.completeStageTask({
      runId: "run-1",
      stageTaskId: evaluateTask.id,
      terminalStatus: "done",
      score: 6,
      maxScore: 10,
      summary: "Regression test missing",
    });

    expect(run.status).toBe("active");
    expect(run.currentStepKey).toBe("implement");
    expect(repository.tasks.map((task) => [task.stageKey, task.attempt])).toContainEqual(["implement", 2]);
  });

  it("blocks the main task visibly when the evaluator exhausts implementation attempts", async () => {
    const { repository, orchestrator } = setup();
    const firstEvaluateTask = await startAndCompleteThroughEvaluate(repository, orchestrator);
    await orchestrator.completeStageTask({
      runId: "run-1",
      stageTaskId: firstEvaluateTask.id,
      terminalStatus: "done",
      score: 4,
    });
    const secondImplementTask = repository.tasks.findLast((task) => task.stageKey === "implement")!;
    await orchestrator.completeStageTask({
      runId: "run-1",
      stageTaskId: secondImplementTask.id,
      terminalStatus: "done",
    });
    const secondEvaluateTask = repository.tasks.findLast((task) => task.stageKey === "evaluate")!;

    const blocked = await orchestrator.completeStageTask({
      runId: "run-1",
      stageTaskId: secondEvaluateTask.id,
      terminalStatus: "done",
      score: 5,
    });

    expect(blocked.status).toBe("blocked");
    expect(repository.tasks.filter((task) => task.stageKey === "implement")).toHaveLength(2);
    expect(repository.mainIssueStatuses.at(-1)).toMatchObject({ status: "blocked" });
    expect(repository.events.at(-1)?.outputSnapshot?.reason).toContain("exhausted 2 attempts");
  });

  it("completes the main issue only after the final merge stage", async () => {
    const { repository, orchestrator } = setup();
    const evaluateTask = await startAndCompleteThroughEvaluate(repository, orchestrator);
    await orchestrator.completeStageTask({
      runId: "run-1",
      stageTaskId: evaluateTask.id,
      terminalStatus: "done",
      score: 8,
    });
    for (const stageKey of ["merge-approval", "merge"] as const) {
      const task = repository.tasks.findLast((candidate) => candidate.stageKey === stageKey)!;
      await orchestrator.completeStageTask({ runId: "run-1", stageTaskId: task.id, terminalStatus: "done" });
    }

    expect(repository.runs.get("run-1")?.status).toBe("completed");
    expect(repository.mainIssueStatuses.at(-1)).toEqual({ status: "done", reason: undefined });
    expect(repository.events.filter((event) => event.eventType === "run_completed")).toHaveLength(1);
  });
});
