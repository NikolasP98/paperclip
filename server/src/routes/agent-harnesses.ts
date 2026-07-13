import { Router } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { agentHarnessIdsQuerySchema } from "@paperclipai/shared";
import { agentHarnessService } from "../services/agent-harness.js";
import { assertCompanyAccess } from "./authz.js";

export function agentHarnessRoutes(db: Db) {
  const router = Router();
  const service = agentHarnessService(db);
  async function companyForAgent(id: string) {
    const [agent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return agent?.companyId ?? null;
  }
  async function scope(req: Parameters<typeof assertCompanyAccess>[0], id: string) {
    const companyId = await companyForAgent(id);
    if (companyId) assertCompanyAccess(req, companyId);
    return companyId;
  }
  router.get("/companies/:companyId/agent-harnesses", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = agentHarnessIdsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid agentIds" });
      return;
    }
    res.json(await service.currentSummaries(companyId, parsed.data.agentIds));
  });
  router.get("/agents/:id/harness", async (req, res) => {
    const companyId = await scope(req, req.params.id as string);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await service.current(req.params.id as string, companyId));
  });
  router.get("/agents/:id/harness/revisions", async (req, res) => {
    const companyId = await scope(req, req.params.id as string);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await service.revisions(req.params.id as string, companyId));
  });
  router.get("/agents/:id/harness/signals", async (req, res) => {
    const companyId = await scope(req, req.params.id as string);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await service.signals(req.params.id as string, companyId));
  });
  router.get("/agents/:id/harness/proposals", async (req, res) => {
    const companyId = await scope(req, req.params.id as string);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await service.proposals(req.params.id as string, companyId));
  });
  return router;
}
