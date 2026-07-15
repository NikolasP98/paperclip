import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  agents,
  agentLearningSignals,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRuns,
  issuePipelineEvents,
  issuePipelineRuns,
  issueRelations,
  issues,
  pipelines,
  portfolios,
  projects,
} from "@paperclipai/db";
import type { IssuePipelineSnapshot } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issuePipelineOrchestrator } from "../services/issue-pipeline-orchestrator.js";
import { issuePipelineOrchestratorRepository } from "../services/issue-pipeline-repository.js";
import { issuePipelineStageTraversalService } from "../services/issue-pipeline-stage-traversal.js";
import { agentHarnessService } from "../services/agent-harness.js";
import { issuePipelineRunRoutes } from "../routes/issue-pipeline-runs.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("issue pipeline repository", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-issue-pipeline-repository-");
    db = createDb(temp.connectionString);
  }, 20_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function seedScenario() {
    const companyId = randomUUID();
    const portfolioId = randomUUID();
    const projectId = randomUUID();
    const pipelineId = randomUUID();
    const plannerId = randomUUID();
    const implementerId = randomUUID();
    const rootIssueId = randomUUID();
    const manualBlockerId = randomUUID();

    const snapshot: IssuePipelineSnapshot = {
      pipelineId,
      name: "Traceable delivery",
      description: null,
      executionMode: "stage_tasks",
      trigger: null,
      steps: [
        {
          key: "plan:v1",
          kind: "work",
          label: "Plan",
          participant: { type: "agent", agentId: plannerId },
        },
        {
          key: "implement",
          kind: "work",
          label: "Implement",
          participant: { type: "agent", agentId: implementerId },
          adapterOverrides: { model: "test-model" },
        },
      ],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Pipeline Co",
      issuePrefix: `T${companyId.slice(0, 6)}`.toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: plannerId,
        companyId,
        name: "planner",
        role: "planner",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: implementerId,
        companyId,
        name: "implementer",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(portfolios).values({
      id: portfolioId,
      companyId,
      name: "Minion Code",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      portfolioId,
      name: "Core",
    });
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      projectId,
      name: snapshot.name,
      executionMode: snapshot.executionMode,
      steps: snapshot.steps as unknown as Array<Record<string, unknown>>,
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        pipelineId,
        issueNumber: 1,
        identifier: `ROOT-${rootIssueId.slice(0, 8)}`,
        title: "High-level repository issue",
        status: "todo",
        priority: "high",
      },
      {
        id: manualBlockerId,
        companyId,
        projectId,
        issueNumber: 2,
        identifier: `BLOCK-${manualBlockerId.slice(0, 8)}`,
        title: "Unrelated manual blocker",
        status: "todo",
        priority: "medium",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: manualBlockerId,
      relatedIssueId: rootIssueId,
      type: "blocks",
    });

    return {
      companyId,
      portfolioId,
      projectId,
      pipelineId,
      plannerId,
      implementerId,
      rootIssueId,
      manualBlockerId,
      snapshot,
    };
  }

  function routeApp(allowedCompanyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "pipeline-reader",
        source: "session",
        companyIds: [allowedCompanyId],
        memberships: [
          { companyId: allowedCompanyId, membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issuePipelineRunRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("rolls child, blocker, and root-state writes back together", async () => {
    const scenario = await seedScenario();
    const repository = issuePipelineOrchestratorRepository(db);
    const runId = randomUUID();
    await repository.createRunIfAbsent({
      id: runId,
      companyId: scenario.companyId,
      selectedProjectId: scenario.projectId,
      issueId: scenario.rootIssueId,
      sourceKey: `rollback:${scenario.rootIssueId}`,
      pipelineSnapshot: scenario.snapshot,
      currentStepKey: scenario.snapshot.steps[0]!.key,
    });

    await expect(
      repository.withRunLock(runId, async (transactionalRepository) => {
        const step = scenario.snapshot.steps[0]!;
        await transactionalRepository.materializeStageTask({
          runId,
          companyId: scenario.companyId,
          selectedProjectId: scenario.projectId,
          issueId: scenario.rootIssueId,
          step,
          attempt: 1,
          materializationKey: `${runId}:${step.key}:1`,
          title: "Plan",
          description: "Plan the work",
        });
        throw new Error("abort stage transaction");
      }),
    ).rejects.toThrow("abort stage transaction");

    const pipelineChildren = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.originKind, "pipeline_step"), eq(issues.originId, runId)));
    const root = await db
      .select({ status: issues.status, executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, scenario.rootIssueId))
      .then((rows) => rows[0]!);
    const blockers = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, scenario.rootIssueId));

    expect(pipelineChildren).toEqual([]);
    expect(root).toEqual({ status: "todo", executionState: null });
    expect(blockers).toEqual([{ issueId: scenario.manualBlockerId }]);
  });

  it("materializes and advances stages exactly once while preserving unrelated blockers", async () => {
    const scenario = await seedScenario();
    const repository = issuePipelineOrchestratorRepository(db);
    const orchestrator = issuePipelineOrchestrator(repository);
    const input = {
      companyId: scenario.companyId,
      selectedProjectId: scenario.projectId,
      issueId: scenario.rootIssueId,
      sourceKey: `github-delivery:${scenario.rootIssueId}`,
      pipelineSnapshot: scenario.snapshot,
    };

    const [first, replay] = await Promise.all([orchestrator.start(input), orchestrator.start(input)]);
    expect([first.created, replay.created].sort()).toEqual([false, true]);
    expect(first.run.id).toBe(replay.run.id);

    const firstStageChildren = await db
      .select({
        id: issues.id,
        originFingerprint: issues.originFingerprint,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.originKind, "pipeline_step"), eq(issues.originId, first.run.id)));
    expect(firstStageChildren).toEqual([
      expect.objectContaining({
        originFingerprint: "plan:v1:1",
        assigneeAgentId: scenario.plannerId,
      }),
    ]);

    const initialRoot = await db
      .select({ status: issues.status, executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, scenario.rootIssueId))
      .then((rows) => rows[0]!);
    expect(initialRoot.status).toBe("blocked");
    expect(initialRoot.executionState).toMatchObject({
      pipelineRunId: first.run.id,
      pipelineBlockedReason: "waiting_on_pipeline_stage:plan:v1:1",
      pipelineChildIssueId: firstStageChildren[0]!.id,
    });
    const routedRoot = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, scenario.rootIssueId))
      .then((rows) => rows[0]!);
    expect(routedRoot.projectId).toBe(scenario.projectId);

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, first.stageTask.id));
    await Promise.all([
      orchestrator.completeStageTask({
        runId: first.run.id,
        stageTaskId: first.stageTask.id,
        terminalStatus: "done",
      }),
      orchestrator.completeStageTask({
        runId: first.run.id,
        stageTaskId: first.stageTask.id,
        terminalStatus: "done",
      }),
    ]);

    const children = await db
      .select({
        id: issues.id,
        originFingerprint: issues.originFingerprint,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
      })
      .from(issues)
      .where(and(eq(issues.originKind, "pipeline_step"), eq(issues.originId, first.run.id)))
      .orderBy(asc(issues.issueNumber));
    expect(children).toHaveLength(2);
    expect(children[1]).toMatchObject({
      originFingerprint: "implement:1",
      assigneeAgentId: scenario.implementerId,
      assigneeAdapterOverrides: { adapterConfig: { model: "test-model" } },
    });

    const blockers = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, scenario.rootIssueId))
      .orderBy(asc(issueRelations.issueId));
    expect(blockers.map((row) => row.issueId).sort()).toEqual([scenario.manualBlockerId, children[1]!.id].sort());

    const events = await db
      .select({
        id: issuePipelineEvents.id,
        sequence: issuePipelineEvents.sequence,
        eventKey: issuePipelineEvents.eventKey,
        predecessorEventId: issuePipelineEvents.predecessorEventId,
      })
      .from(issuePipelineEvents)
      .where(eq(issuePipelineEvents.pipelineRunId, first.run.id))
      .orderBy(asc(issuePipelineEvents.sequence));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.eventKey)).toEqual([
      "run-created",
      "stage-created:plan:v1:1",
      `stage-terminal:${first.stageTask.id}`,
      "stage-created:implement:1",
    ]);
    expect(events.slice(1).map((event, index) => event.predecessorEventId === events[index]!.id)).toEqual([
      true,
      true,
      true,
    ]);

    const runs = await db
      .select({ id: issuePipelineRuns.id })
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.sourceOriginId, input.sourceKey));
    expect(runs).toHaveLength(1);

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, children[1]!.id));
    await orchestrator.completeStageTask({
      runId: first.run.id,
      stageTaskId: children[1]!.id,
      terminalStatus: "done",
    });

    const completedRoot = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, scenario.rootIssueId))
      .then((rows) => rows[0]!);
    const completedBlockers = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, scenario.rootIssueId));
    expect(completedRoot.status).toBe("done");
    expect(completedBlockers).toEqual([{ issueId: scenario.manualBlockerId }]);
  });

  it("resolves a stage child to its frozen run and denies cross-company child/direct reads", async () => {
    const scenario = await seedScenario();
    const started = await issuePipelineOrchestrator(
      issuePipelineOrchestratorRepository(db),
    ).start({
      companyId: scenario.companyId,
      selectedProjectId: scenario.projectId,
      issueId: scenario.rootIssueId,
      sourceKey: `route-read:${scenario.rootIssueId}`,
      pipelineSnapshot: scenario.snapshot,
    });
    const allowed = routeApp(scenario.companyId);
    const childRead = await request(allowed).get(
      `/api/issues/${started.stageTask.issueId}/pipeline-run`,
    );
    expect(childRead.status).toBe(200);
    expect(childRead.body).toMatchObject({
      id: started.run.id,
      companyId: scenario.companyId,
      pipelineSnapshot: { steps: [{ key: "plan:v1" }, { key: "implement" }] },
    });
    const directRead = await request(allowed).get(`/api/issue-pipeline-runs/${started.run.id}`);
    expect(directRead.status).toBe(200);
    expect(directRead.body.id).toBe(started.run.id);

    const denied = routeApp(randomUUID());
    expect(
      (await request(denied).get(`/api/issues/${started.stageTask.issueId}/pipeline-run`)).status,
    ).toBe(403);
    expect(
      (await request(denied).get(`/api/issue-pipeline-runs/${started.run.id}`)).status,
    ).toBe(403);
  });

  it("persists one worker-attributed learning signal from task-session heartbeat evidence", async () => {
    const scenario = await seedScenario();
    const evaluatorId = randomUUID();
    await db.insert(agents).values({
      id: evaluatorId,
      companyId: scenario.companyId,
      name: "evaluator",
      role: "qa",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const snapshot: IssuePipelineSnapshot = {
      pipelineId: scenario.pipelineId,
      name: "Learning delivery",
      description: null,
      executionMode: "stage_tasks",
      trigger: null,
      steps: [
        {
          key: "implement",
          kind: "work",
          label: "Implement",
          participant: { type: "agent", agentId: scenario.implementerId },
        },
        {
          key: "evaluate",
          kind: "eval",
          label: "Evaluate",
          participant: { type: "agent", agentId: evaluatorId },
          minScore: 7,
          maxScore: 10,
          onFailStepKey: "implement",
          maxAttempts: 3,
        },
      ],
    };
    const repository = issuePipelineOrchestratorRepository(db);
    const started = await issuePipelineOrchestrator(repository).start({
      companyId: scenario.companyId,
      selectedProjectId: scenario.projectId,
      issueId: scenario.rootIssueId,
      sourceKey: `learning:${scenario.rootIssueId}`,
      pipelineSnapshot: snapshot,
    });
    const revision = await agentHarnessService(db).ensureRevision(
      scenario.implementerId,
      scenario.companyId,
    );
    expect(revision).not.toBeNull();
    const workerHeartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: workerHeartbeatId,
      companyId: scenario.companyId,
      agentId: scenario.implementerId,
      harnessRevisionId: revision!.id,
      invocationSource: "assignment",
      status: "succeeded",
      contextSnapshot: { issueId: "unrelated-direct-context" },
      finishedAt: new Date(),
    });
    await db.insert(agentTaskSessions).values({
      companyId: scenario.companyId,
      agentId: scenario.implementerId,
      adapterType: "opencode_local",
      taskKey: started.stageTask.issueId,
      harnessRevisionId: revision!.id,
      lastRunId: workerHeartbeatId,
    });
    const wakeup = vi.fn().mockResolvedValue(null);
    const traversal = issuePipelineStageTraversalService(db, {
      repository,
      heartbeat: { wakeup },
    });
    const implementation = await traversal.afterCommittedIssueMutation({
      issue: {
        id: started.stageTask.issueId,
        companyId: scenario.companyId,
        originKind: "pipeline_step",
        originId: started.run.id,
        status: "done",
      },
      pipelineOutcome: "passed",
      pipelineSummary: "Implementation ready for evaluation",
    });
    const evaluationTask = implementation.nextStageTask!;
    const evaluated = await traversal.afterCommittedIssueMutation({
      issue: {
        id: evaluationTask.issueId,
        companyId: scenario.companyId,
        originKind: "pipeline_step",
        originId: started.run.id,
        status: "done",
      },
      pipelineOutcome: "failed",
      pipelineSummary: "Regression coverage is incomplete",
      evalScore: 6,
      requestedByActorType: "agent",
      requestedByActorId: evaluatorId,
    });
    expect(evaluated).toMatchObject({
      handled: true,
      claimed: true,
      nextStageTask: { stageKey: "implement", attempt: 2 },
    });
    expect(evaluated.nextStageTask?.issueId).not.toBe(started.stageTask.issueId);
    await traversal.afterCommittedIssueMutation({
      issue: {
        id: evaluationTask.issueId,
        companyId: scenario.companyId,
        originKind: "pipeline_step",
        originId: started.run.id,
        status: "done",
      },
      pipelineOutcome: "failed",
      pipelineSummary: "Regression coverage is incomplete",
      evalScore: 6,
      requestedByActorType: "agent",
      requestedByActorId: evaluatorId,
    });

    const signals = await db
      .select()
      .from(agentLearningSignals)
      .where(eq(agentLearningSignals.companyId, scenario.companyId));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      agentId: scenario.implementerId,
      harnessRevisionId: revision!.id,
      runId: workerHeartbeatId,
      issueId: started.stageTask.issueId,
      signalType: "pipeline_evaluation",
      outcome: "changes_requested",
      score: 6,
      maxScore: 10,
      body: "Regression coverage is incomplete",
      metadata: {
        pipelineRunId: started.run.id,
        gateTaskId: evaluationTask.issueId,
        gateStageKey: "evaluate",
        workerTaskId: started.stageTask.issueId,
        workerStageKey: "implement",
        evidenceSource: "task_session",
      },
    });
    expect(signals.some((signal) => signal.agentId === evaluatorId)).toBe(false);
  });
});
