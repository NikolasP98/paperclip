import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { issuePipelineEvents, issuePipelineRuns, issues, pipelines, type Db } from "@paperclipai/db";
import type { IssuePipelineSnapshot, PipelineStep, PipelineTrigger } from "@paperclipai/shared";
import { issuePipelineOrchestrator } from "../services/issue-pipeline-orchestrator.js";
import { issuePipelineOrchestratorRepository } from "../services/issue-pipeline-repository.js";
import { assertCompanyAccess } from "./authz.js";
import { assertPipelineHitlTerminalActor } from "../services/pipeline-inbox.js";

const startPipelineRunSchema = z.object({
  pipelineId: z.string().uuid(),
  selectedProjectId: z.string().uuid().optional(),
  sourceKey: z.string().trim().min(1).max(500).optional(),
});

const completePipelineStageSchema = z.object({
  stageTaskId: z.string().uuid(),
  terminalStatus: z.enum(["done", "cancelled", "blocked"]),
  outcome: z.enum(["passed", "failed"]).optional(),
  score: z.number().finite().optional().nullable(),
  maxScore: z.number().finite().positive().optional().nullable(),
  summary: z.string().trim().max(4_000).optional().nullable(),
});

export function issuePipelineRunRoutes(db: Db) {
  const router = Router();

  router.post("/issues/:issueId/pipeline-run", async (req, res) => {
    const parsed = startPipelineRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid pipeline run request" });
      return;
    }
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, req.params.issueId as string))
      .limit(1);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [pipeline] = await db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, parsed.data.pipelineId))
      .limit(1);
    if (!pipeline || pipeline.companyId !== issue.companyId) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    if (pipeline.executionMode !== "stage_tasks") {
      res.status(422).json({ error: "Only stage_tasks pipelines can be materialized" });
      return;
    }
    const selectedProjectId = parsed.data.selectedProjectId ?? issue.projectId ?? pipeline.projectId;
    if (!selectedProjectId) {
      res.status(422).json({ error: "A routed project is required before materializing pipeline tasks" });
      return;
    }
    const snapshot: IssuePipelineSnapshot = {
      pipelineId: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      executionMode: "stage_tasks",
      trigger: (pipeline.trigger as PipelineTrigger | null) ?? null,
      steps: (pipeline.steps as unknown as PipelineStep[]) ?? [],
    };
    const repository = issuePipelineOrchestratorRepository(db);
    const result = await issuePipelineOrchestrator(repository).start({
      companyId: issue.companyId,
      selectedProjectId,
      issueId: issue.id,
      sourceKey: parsed.data.sourceKey ?? `${issue.originKind}:${issue.originId ?? issue.id}:${pipeline.id}`,
      pipelineSnapshot: snapshot,
    });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.get("/issues/:issueId/pipeline-run", async (req, res) => {
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, req.params.issueId as string))
      .limit(1);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [run] = issue.originKind === "pipeline_step" && issue.originId
      ? await db
        .select()
        .from(issuePipelineRuns)
        .where(
          and(
            eq(issuePipelineRuns.id, issue.originId),
            eq(issuePipelineRuns.companyId, issue.companyId),
          ),
        )
        .limit(1)
      : await db
        .select()
        .from(issuePipelineRuns)
        .where(
          and(
            eq(issuePipelineRuns.issueId, issue.id),
            eq(issuePipelineRuns.companyId, issue.companyId),
          ),
        )
        .orderBy(desc(issuePipelineRuns.createdAt))
        .limit(1);
    if (!run) {
      res.status(404).json({ error: "Pipeline run not found" });
      return;
    }
    res.json(run);
  });

  router.get("/issue-pipeline-runs/:id", async (req, res) => {
    const [run] = await db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, req.params.id as string))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "Pipeline run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    res.json(run);
  });

  router.get("/issue-pipeline-runs/:id/events", async (req, res) => {
    const [run] = await db
      .select({ id: issuePipelineRuns.id, companyId: issuePipelineRuns.companyId })
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, req.params.id as string))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "Pipeline run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const events = await db
      .select()
      .from(issuePipelineEvents)
      .where(eq(issuePipelineEvents.pipelineRunId, run.id))
      .orderBy(asc(issuePipelineEvents.sequence));
    res.json(events);
  });

  router.post("/issue-pipeline-runs/:id/complete-stage", async (req, res) => {
    const parsed = completePipelineStageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid stage completion" });
      return;
    }
    const [run] = await db
      .select({ id: issuePipelineRuns.id, companyId: issuePipelineRuns.companyId })
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, req.params.id as string))
      .limit(1);
    if (!run) {
      res.status(404).json({ error: "Pipeline run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const [stageTask] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.id, parsed.data.stageTaskId),
          eq(issues.companyId, run.companyId),
          eq(issues.originKind, "pipeline_step"),
          eq(issues.originId, run.id),
        ),
      )
      .limit(1);
    if (!stageTask) {
      res.status(404).json({ error: "Pipeline stage task not found" });
      return;
    }
    await assertPipelineHitlTerminalActor(db, stageTask, req.actor);
    const repository = issuePipelineOrchestratorRepository(db);
    const updated = await issuePipelineOrchestrator(repository).completeStageTask({
      runId: run.id,
      ...parsed.data,
    });
    res.json(updated);
  });

  return router;
}
