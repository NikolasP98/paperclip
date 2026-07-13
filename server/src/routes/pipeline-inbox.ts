import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { pipelineInboxService } from "../services/pipeline-inbox.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function pipelineInboxRoutes(db: Db) {
  const router = Router();
  const inbox = pipelineInboxService(db);

  router.get("/companies/:companyId/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId?.trim();
    if (!userId) throw forbidden("A concrete board user is required for Inbox access");
    if (req.actor.source !== "hub_identity") {
      throw forbidden("A signed Hub identity is required for pipeline Inbox access");
    }
    const trustedRoleKeys = req.actor.roleKeys ?? [];
    res.json(await inbox.list(companyId, { userId, trustedRoleKeys }));
  });

  return router;
}
