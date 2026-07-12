import { Router } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { agents, pipelines, projects, type Db } from "@paperclipai/db";
import { createPipelineSchema, updatePipelineSchema, type PipelineStep } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";

/** Agent participants must exist in the company and be assignable (not terminated). */
async function assertStepAgentsAssignable(db: Db, companyId: string, steps: PipelineStep[]) {
  const agentIds = [...new Set(steps.flatMap((s) => (s.participant.type === "agent" && s.participant.agentId ? [s.participant.agentId] : [])))];
  for (const agentId of agentIds) {
    const [agent] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);
    if (!agent) throw unprocessable(`Step participant agent ${agentId} not found in company`);
    if (agent.status === "terminated") throw unprocessable(`Step participant agent ${agentId} is terminated`);
  }
  // ponytail: user participants are not membership-checked here — no cheap
  // company-membership helper at the route layer; the stage machine simply
  // won't match a non-member actor at decision time.
}

async function assertProjectInCompany(db: Db, companyId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) throw unprocessable(`Project ${projectId} not found in company`);
}

export function pipelineRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
    const rows = await db
      .select()
      .from(pipelines)
      .where(
        and(
          eq(pipelines.companyId, companyId),
          ...(projectId ? [eq(pipelines.projectId, projectId)] : []),
          ...(includeArchived ? [] : [isNull(pipelines.archivedAt)]),
        ),
      )
      .orderBy(asc(pipelines.sortOrder), asc(pipelines.createdAt));
    res.json(rows);
  });

  router.post("/companies/:companyId/pipelines", validate(createPipelineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as typeof createPipelineSchema._output;
    if (body.projectId) await assertProjectInCompany(db, companyId, body.projectId);
    await assertStepAgentsAssignable(db, companyId, body.steps as PipelineStep[]);
    const [pipeline] = await db
      .insert(pipelines)
      .values({ ...body, companyId })
      .returning();
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline.created",
      entityType: "pipeline",
      entityId: pipeline.id,
      details: { name: pipeline.name, projectId: pipeline.projectId, steps: body.steps.length },
    });
    res.status(201).json(pipeline);
  });

  router.get("/pipelines/:id", async (req, res) => {
    const [pipeline] = await db.select().from(pipelines).where(eq(pipelines.id, req.params.id as string)).limit(1);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    assertCompanyAccess(req, pipeline.companyId);
    res.json(pipeline);
  });

  router.patch("/pipelines/:id", validate(updatePipelineSchema), async (req, res) => {
    const id = req.params.id as string;
    const [existing] = await db.select().from(pipelines).where(eq(pipelines.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const body = req.body as typeof updatePipelineSchema._output;
    if (body.steps) await assertStepAgentsAssignable(db, existing.companyId, body.steps as PipelineStep[]);
    const [pipeline] = await db
      .update(pipelines)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(pipelines.id, id))
      .returning();
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline.updated",
      entityType: "pipeline",
      entityId: pipeline.id,
      details: { ...(body.name ? { name: body.name } : {}), ...(body.steps ? { steps: body.steps.length } : {}), ...(body.archivedAt !== undefined ? { archivedAt: body.archivedAt } : {}) },
    });
    res.json(pipeline);
  });

  return router;
}
