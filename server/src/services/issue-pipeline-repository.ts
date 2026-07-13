import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  issuePipelineEvents,
  issuePipelineRuns,
  issueRelations,
  issues,
  pipelines,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  IssueOriginKind,
  IssuePipelineRoutingSnapshot,
  IssuePipelineRun,
  IssuePipelineRunStatus,
  IssuePipelineSnapshot,
  PipelineExecutionMode,
  PipelineStep,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";
import type {
  AppendPipelineEventInput,
  IssuePipelineOrchestratorRepository,
  IssuePipelineStageTask,
  MaterializeStageTaskInput,
  StageTaskStatus,
} from "./issue-pipeline-orchestrator.js";

type PipelineRunRow = typeof issuePipelineRuns.$inferSelect;
type StageIssueRow = Pick<typeof issues.$inferSelect, "id" | "originFingerprint" | "status">;

const STAGE_TASK_STATUSES = new Set<StageTaskStatus>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]);

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sorted(child)]),
  );
}

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}

function asRun(row: PipelineRunRow): IssuePipelineRun {
  return {
    ...row,
    executionMode: row.executionMode as PipelineExecutionMode,
    status: row.status as IssuePipelineRunStatus,
    sourceOriginKind: row.sourceOriginKind as IssueOriginKind,
  };
}

function parseStageFingerprint(fingerprint: string): { stageKey: string; attempt: number } | null {
  const separator = fingerprint.lastIndexOf(":");
  if (separator < 1) return null;
  const stageKey = fingerprint.slice(0, separator);
  const attempt = Number.parseInt(fingerprint.slice(separator + 1), 10);
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return { stageKey, attempt };
}

function stageTaskFromIssue(run: IssuePipelineRun, issue: StageIssueRow): IssuePipelineStageTask | null {
  const parsed = parseStageFingerprint(issue.originFingerprint);
  if (!parsed) return null;
  const step = run.pipelineSnapshot.steps.find((candidate) => candidate.key === parsed.stageKey);
  if (!step) return null;
  return {
    id: issue.id,
    runId: run.id,
    issueId: issue.id,
    stageKey: parsed.stageKey,
    stageKind: step.kind,
    attempt: parsed.attempt,
    materializationKey: `${run.id}:${issue.originFingerprint}`,
    status: STAGE_TASK_STATUSES.has(issue.status as StageTaskStatus) ? (issue.status as StageTaskStatus) : "blocked",
  };
}

function postgresErrorCode(error: unknown): string | null {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const record = cursor as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    cursor = record.cause;
  }
  return null;
}

function participantAssignee(step: PipelineStep): {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
} {
  if (step.participant.type === "agent") {
    return { assigneeAgentId: step.participant.agentId ?? null, assigneeUserId: null };
  }
  if (step.participant.type === "user") {
    return { assigneeAgentId: null, assigneeUserId: step.participant.userId ?? null };
  }
  // A role gate is intentionally unassigned: its frozen roleKeys select the
  // eligible Hub users without pretending one user has claimed it already.
  return { assigneeAgentId: null, assigneeUserId: null };
}

class DrizzleIssuePipelineOrchestratorRepository implements IssuePipelineOrchestratorRepository {
  constructor(
    private readonly db: Db,
    private readonly lockedRunId: string | null = null,
  ) {}

  private assertRunLock(runId: string): void {
    if (this.lockedRunId !== runId) {
      throw new Error(`pipeline run ${runId} must be mutated inside withRunLock`);
    }
  }

  async withRunLock<T>(
    runId: string,
    operation: (repository: IssuePipelineOrchestratorRepository) => Promise<T>,
  ): Promise<T> {
    if (this.lockedRunId === runId) return operation(this);
    if (this.lockedRunId) {
      throw new Error(`cannot lock pipeline run ${runId} while ${this.lockedRunId} is locked`);
    }

    return this.db.transaction(async (tx) => {
      const run = await tx
        .select({ id: issuePipelineRuns.id })
        .from(issuePipelineRuns)
        .where(eq(issuePipelineRuns.id, runId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!run) throw new Error(`pipeline run not found: ${runId}`);
      const transactionalRepository = new DrizzleIssuePipelineOrchestratorRepository(tx as unknown as Db, runId);
      return operation(transactionalRepository);
    });
  }

  async createRunIfAbsent(input: {
    id: string;
    companyId: string;
    selectedProjectId: string;
    issueId: string;
    sourceKey: string;
    sourceDeliveryId?: string | null;
    pipelineSnapshot: IssuePipelineSnapshot;
    routingSnapshot?: IssuePipelineRoutingSnapshot;
    currentStepKey: string;
  }): Promise<{ run: IssuePipelineRun; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const root = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          originKind: issues.originKind,
        })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!root) throw new Error(`pipeline root issue not found: ${input.issueId}`);

      const pipeline = await tx
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.id, input.pipelineSnapshot.pipelineId), eq(pipelines.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!pipeline) throw new Error(`pipeline not found: ${input.pipelineSnapshot.pipelineId}`);

      const selectedProject = await tx
        .select({ id: projects.id, portfolioId: projects.portfolioId })
        .from(projects)
        .where(and(eq(projects.id, input.selectedProjectId), eq(projects.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!selectedProject) throw new Error(`selected project not found: ${input.selectedProjectId}`);

      if (input.routingSnapshot?.selectedProjectId && input.routingSnapshot.selectedProjectId !== selectedProject.id) {
        throw new Error(
          `routing snapshot selected project ${input.routingSnapshot.selectedProjectId} does not match ${selectedProject.id}`,
        );
      }
      const routingSnapshot: IssuePipelineRoutingSnapshot = input.routingSnapshot
        ? {
            ...structuredClone(input.routingSnapshot),
            selectedPortfolioId: selectedProject.portfolioId,
            selectedProjectId: selectedProject.id,
          }
        : {
            repository: null,
            originalLabels: [],
            inferredLabels: [],
            classifierOutput: null,
            candidates: [
              {
                portfolioId: selectedProject.portfolioId,
                projectId: selectedProject.id,
                confidence: 1,
                reason: "selected by issue pipeline orchestration",
              },
            ],
            selectedPortfolioId: selectedProject.portfolioId,
            selectedProjectId: selectedProject.id,
            confidence: 1,
            resolution: "override",
            reason: "selected project supplied by the routing stage",
          };
      const now = new Date();
      const inserted = await tx
        .insert(issuePipelineRuns)
        .values({
          id: input.id,
          companyId: input.companyId,
          pipelineId: pipeline.id,
          issueId: root.id,
          executionMode: "stage_tasks",
          status: "active",
          currentStepKey: input.currentStepKey,
          sourceOriginKind: root.originKind,
          sourceOriginId: input.sourceKey,
          sourceDeliveryId: input.sourceDeliveryId ?? null,
          pipelineSnapshot: input.pipelineSnapshot,
          pipelineSnapshotHash: contentHash(input.pipelineSnapshot),
          routingSnapshot,
          routingSnapshotHash: contentHash(routingSnapshot),
          selectedPortfolioId: selectedProject.portfolioId,
          selectedProjectId: selectedProject.id,
          startedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [issuePipelineRuns.companyId, issuePipelineRuns.sourceOriginKind, issuePipelineRuns.sourceOriginId],
        })
        .returning();
      if (inserted[0]) {
        await tx
          .update(issues)
          .set({ projectId: selectedProject.id, updatedAt: now })
          .where(and(eq(issues.id, root.id), eq(issues.companyId, input.companyId)));
        return { run: asRun(inserted[0]), created: true };
      }

      const existing = await tx
        .select()
        .from(issuePipelineRuns)
        .where(
          and(
            eq(issuePipelineRuns.companyId, input.companyId),
            eq(issuePipelineRuns.sourceOriginKind, root.originKind),
            eq(issuePipelineRuns.sourceOriginId, input.sourceKey),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw new Error(`pipeline run claim disappeared for source ${input.sourceKey}`);
      if (existing.issueId !== input.issueId) {
        throw new Error(`pipeline source ${input.sourceKey} is already bound to issue ${existing.issueId}`);
      }
      if (existing.selectedProjectId !== selectedProject.id) {
        throw new Error(
          `pipeline source ${input.sourceKey} is already routed to project ${existing.selectedProjectId}`,
        );
      }
      await tx
        .update(issues)
        .set({ projectId: selectedProject.id, updatedAt: now })
        .where(and(eq(issues.id, root.id), eq(issues.companyId, input.companyId)));
      return { run: asRun(existing), created: false };
    });
  }

  async getRun(runId: string): Promise<IssuePipelineRun | null> {
    const row = await this.db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return row ? asRun(row) : null;
  }

  async listStageTasks(runId: string): Promise<IssuePipelineStageTask[]> {
    const run = await this.getRun(runId);
    if (!run) return [];
    const rows = await this.db
      .select({
        id: issues.id,
        originFingerprint: issues.originFingerprint,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(eq(issues.companyId, run.companyId), eq(issues.originKind, "pipeline_step"), eq(issues.originId, run.id)),
      )
      .orderBy(issues.createdAt, issues.id);
    return rows
      .map((row) => stageTaskFromIssue(run, row))
      .filter((task): task is IssuePipelineStageTask => task !== null);
  }

  async materializeStageTask(input: MaterializeStageTaskInput): Promise<{
    task: IssuePipelineStageTask;
    created: boolean;
  }> {
    this.assertRunLock(input.runId);
    const originFingerprint = `${input.step.key}:${input.attempt}`;
    const findExisting = () =>
      this.db
        .select({
          id: issues.id,
          originFingerprint: issues.originFingerprint,
          status: issues.status,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.originKind, "pipeline_step"),
            eq(issues.originId, input.runId),
            eq(issues.originFingerprint, originFingerprint),
          ),
        )
        .then((rows) => rows[0] ?? null);

    let child = await findExisting();
    let created = false;
    if (!child) {
      try {
        const result = await issueService(this.db).createChild(input.issueId, {
          title: input.title,
          description: input.description,
          status: "todo",
          projectId: input.selectedProjectId,
          originKind: "pipeline_step",
          originId: input.runId,
          originRunId: input.runId,
          originFingerprint,
          ...participantAssignee(input.step),
          assigneeAdapterOverrides: input.step.adapterOverrides ? { adapterConfig: input.step.adapterOverrides } : null,
          executionState: {
            pipelineRunId: input.runId,
            pipelineStepKey: input.step.key,
            pipelineStepKind: input.step.kind,
            pipelineAttempt: input.attempt,
            materializationKey: input.materializationKey,
          },
          blockParentUntilDone: false,
        } as Parameters<ReturnType<typeof issueService>["createChild"]>[1]);
        child = {
          id: result.issue.id,
          originFingerprint: result.issue.originFingerprint,
          status: result.issue.status,
        };
        created = true;
      } catch (error) {
        if (postgresErrorCode(error) !== "23505") throw error;
        child = await findExisting();
        if (!child) throw error;
      }
    }

    const root = await this.db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) throw new Error(`pipeline root issue not found: ${input.issueId}`);

    const priorPipelineChildren = this.db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, "pipeline_step"),
          eq(issues.originId, input.runId),
        ),
      );
    await this.db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.relatedIssueId, input.issueId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, priorPipelineChildren),
        ),
      );
    await this.db
      .insert(issueRelations)
      .values({
        companyId: input.companyId,
        issueId: child.id,
        relatedIssueId: input.issueId,
        type: "blocks",
      })
      .onConflictDoNothing();

    const reason = `waiting_on_pipeline_stage:${input.step.key}:${input.attempt}`;
    await this.db
      .update(issues)
      .set({
        status: "blocked",
        completedAt: null,
        cancelledAt: null,
        executionState: {
          ...((root.executionState as Record<string, unknown> | null) ?? {}),
          pipelineRunId: input.runId,
          pipelineBlockedReason: reason,
          pipelineStepKey: input.step.key,
          pipelineAttempt: input.attempt,
          pipelineChildIssueId: child.id,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));

    const run = await this.getRun(input.runId);
    if (!run) throw new Error(`pipeline run not found: ${input.runId}`);
    const task = stageTaskFromIssue(run, child);
    if (!task) throw new Error(`invalid pipeline stage identity ${originFingerprint}`);
    return { task, created };
  }

  async appendEventOnce(input: AppendPipelineEventInput): Promise<boolean> {
    this.assertRunLock(input.runId);
    const existingByKey = await this.db
      .select({ id: issuePipelineEvents.id })
      .from(issuePipelineEvents)
      .where(and(eq(issuePipelineEvents.pipelineRunId, input.runId), eq(issuePipelineEvents.eventKey, input.eventKey)))
      .then((rows) => rows[0] ?? null);
    if (existingByKey) return false;

    if (input.stepKey != null && input.attempt != null) {
      const existingSemanticEvent = await this.db
        .select({ id: issuePipelineEvents.id })
        .from(issuePipelineEvents)
        .where(
          and(
            eq(issuePipelineEvents.pipelineRunId, input.runId),
            eq(issuePipelineEvents.stepKey, input.stepKey),
            eq(issuePipelineEvents.attempt, input.attempt),
            eq(issuePipelineEvents.eventType, input.eventType),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existingSemanticEvent) return false;
    }

    const latest = await this.db
      .select({ id: issuePipelineEvents.id, sequence: issuePipelineEvents.sequence })
      .from(issuePipelineEvents)
      .where(eq(issuePipelineEvents.pipelineRunId, input.runId))
      .orderBy(desc(issuePipelineEvents.sequence))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    await this.db.insert(issuePipelineEvents).values({
      companyId: input.companyId,
      pipelineRunId: input.runId,
      sequence: (latest?.sequence ?? 0) + 1,
      eventKey: input.eventKey,
      eventType: input.eventType,
      childIssueId: input.childIssueId ?? null,
      stepKey: input.stepKey ?? null,
      attempt: input.attempt ?? null,
      predecessorEventId: latest?.id ?? null,
      outputSnapshot: input.outputSnapshot ?? null,
      inputSnapshot: input.inputSnapshot ?? null,
      decisionSnapshot: input.decisionSnapshot ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      harnessRevisionId: input.harnessRevisionId ?? null,
      resolvedAdapterType: input.resolvedAdapterType ?? null,
      resolvedModel: input.resolvedModel ?? null,
      resolvedProvider: input.resolvedProvider ?? null,
      score: input.score ?? null,
      maxScore: input.maxScore ?? null,
    });
    return true;
  }

  async setRunCursor(runId: string, stepKey: string): Promise<IssuePipelineRun> {
    this.assertRunLock(runId);
    return this.updateRun(runId, { currentStepKey: stepKey, status: "active" });
  }

  async setRunBlocked(runId: string, _reason: string): Promise<IssuePipelineRun> {
    this.assertRunLock(runId);
    return this.updateRun(runId, { status: "blocked" });
  }

  async setRunCompleted(runId: string): Promise<IssuePipelineRun> {
    this.assertRunLock(runId);
    return this.updateRun(runId, {
      status: "completed",
      currentStepKey: null,
      completedAt: new Date(),
    });
  }

  private async updateRun(
    runId: string,
    patch: Partial<typeof issuePipelineRuns.$inferInsert>,
  ): Promise<IssuePipelineRun> {
    const row = await this.db
      .update(issuePipelineRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(issuePipelineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error(`pipeline run not found: ${runId}`);
    return asRun(row);
  }

  async setMainIssueStatus(input: {
    companyId: string;
    issueId: string;
    status: "blocked" | "done";
    reason?: string | null;
  }): Promise<void> {
    if (!this.lockedRunId) throw new Error("main issue status must be updated inside withRunLock");
    const root = await this.db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) throw new Error(`pipeline root issue not found: ${input.issueId}`);
    if (input.status === "done") {
      const pipelineChildren = this.db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.originKind, "pipeline_step"),
            eq(issues.originId, this.lockedRunId),
          ),
        );
      await this.db
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, input.companyId),
            eq(issueRelations.relatedIssueId, input.issueId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, pipelineChildren),
          ),
        );
    }
    const currentExecutionState = (root.executionState as Record<string, unknown> | null) ?? {};
    const executionState: Record<string, unknown> = {
      ...currentExecutionState,
      pipelineRunId: this.lockedRunId,
      pipelineBlockedReason: input.status === "blocked" ? (input.reason ?? null) : null,
    };
    if (input.status === "done") executionState.pipelineChildIssueId = null;
    await this.db
      .update(issues)
      .set({
        status: input.status,
        executionState,
        completedAt: input.status === "done" ? new Date() : null,
        cancelledAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  }
}

export function issuePipelineOrchestratorRepository(db: Db): IssuePipelineOrchestratorRepository {
  return new DrizzleIssuePipelineOrchestratorRepository(db);
}
