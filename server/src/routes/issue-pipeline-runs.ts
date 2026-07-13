import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { issuePipelineEvents, issuePipelineRuns, type Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";

export function issuePipelineRunRoutes(db: Db) {
  const router = Router();

  router.get("/issues/:issueId/pipeline-run", async (req, res) => {
    const [run] = await db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.issueId, req.params.issueId as string))
      .orderBy(desc(issuePipelineRuns.createdAt))
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

  return router;
}
