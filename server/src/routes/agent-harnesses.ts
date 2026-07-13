import { Router } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  agentHarnessIdsQuerySchema,
  createHarnessGuidanceProposalSchema,
  emptyHarnessGuidanceDecisionSchema,
  rejectHarnessGuidanceProposalSchema,
  rollbackHarnessGuidanceProposalSchema,
} from "@paperclipai/shared";
import { agentHarnessService } from "../services/agent-harness.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

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
  router.post("/agents/:id/harness/proposals", async (req, res) => {
    const agentId = req.params.id as string;
    const companyId = await scope(req, agentId);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const parsed = createHarnessGuidanceProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid proposal" });
      return;
    }
    let actor: { type: "agent"; agentId: string } | { type: "user"; userId: string };
    if (req.actor.type === "agent") {
      const actorAgentId = req.actor.agentId;
      if (!actorAgentId) {
        res.status(403).json({ error: "Agent identity is required to propose harness guidance" });
        return;
      }
      actor = { type: "agent", agentId: actorAgentId };
    } else {
      actor = { type: "user", userId: req.actor.userId ?? "local-board" };
    }
    const proposal = await service.createGuidanceProposal({
      companyId,
      agentId,
      signalId: parsed.data.signalId,
      rationale: parsed.data.rationale,
      change: parsed.data.change,
      actor,
    });
    res.status(201).json(proposal);
  });

  router.post("/agents/:id/harness/proposals/:proposalId/approve", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.id as string;
    const companyId = await scope(req, agentId);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const parsed = emptyHarnessGuidanceDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid approval" });
      return;
    }
    res.json(
      await service.approveGuidanceProposal({
        companyId,
        agentId,
        proposalId: req.params.proposalId as string,
        userId: req.actor.userId ?? "local-board",
      }),
    );
  });

  router.post("/agents/:id/harness/proposals/:proposalId/reject", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.id as string;
    const companyId = await scope(req, agentId);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const parsed = rejectHarnessGuidanceProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid rejection" });
      return;
    }
    res.json(
      await service.rejectGuidanceProposal({
        companyId,
        agentId,
        proposalId: req.params.proposalId as string,
        userId: req.actor.userId ?? "local-board",
        reason: parsed.data.reason,
      }),
    );
  });

  router.post("/agents/:id/harness/proposals/:proposalId/promote", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.id as string;
    const companyId = await scope(req, agentId);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const parsed = emptyHarnessGuidanceDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid promotion" });
      return;
    }
    res.json(
      await service.promoteGuidanceProposal({
        companyId,
        agentId,
        proposalId: req.params.proposalId as string,
        userId: req.actor.userId ?? "local-board",
      }),
    );
  });

  router.post("/agents/:id/harness/proposals/:proposalId/rollback", async (req, res) => {
    assertBoard(req);
    const agentId = req.params.id as string;
    const companyId = await scope(req, agentId);
    if (!companyId) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const parsed = rollbackHarnessGuidanceProposalSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? "Invalid rollback" });
      return;
    }
    res.json(
      await service.rollbackGuidanceProposal({
        companyId,
        agentId,
        proposalId: req.params.proposalId as string,
        userId: req.actor.userId ?? "local-board",
        reason: parsed.data.reason,
      }),
    );
  });
  return router;
}
