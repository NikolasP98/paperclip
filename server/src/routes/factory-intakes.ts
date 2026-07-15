import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { issues, type Db } from '@paperclipai/db';
import { createFactoryIntakeSchema, decideFactoryIntakeRoutingSchema } from '@paperclipai/shared';
import { forbidden, notFound } from '../errors.js';
import type { IssueAssignmentWakeupDeps } from '../services/issue-assignment-wakeup.js';
import {
  activateFactoryIntake,
  decideFactoryIntakeRouting,
  factoryIntakeProjection,
} from '../services/factory-intake.js';
import { assertBoard, assertCompanyAccess } from './authz.js';

export function factoryIntakeRoutes(db: Db, deps: { heartbeat: IssueAssignmentWakeupDeps }) {
  const router = Router();

  router.post('/companies/:companyId/factory-intakes', async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source !== 'hub_identity' || !req.actor.userId?.trim()) {
      throw forbidden('A signed Hub user is required for factory intake');
    }
    const parsed = createFactoryIntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: parsed.error.issues[0]?.message ?? 'Invalid factory intake' });
      return;
    }
    const result = await activateFactoryIntake({
      db,
      heartbeat: deps.heartbeat,
      companyId,
      requesterUserId: req.actor.userId,
      requesterRoleKeys: req.actor.roleKeys ?? [],
      intake: parsed.data,
    });
    res.status(202).json(result);
  });

  router.get('/factory-intakes/:issueId', async (req, res) => {
    const issueId = req.params.issueId as string;
    assertBoard(req);
    const issue = await db
      .select({ companyId: issues.companyId, originKind: issues.originKind })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.originKind !== 'paperclip') throw notFound('Factory intake not found');
    assertCompanyAccess(req, issue.companyId);
    res.json(await factoryIntakeProjection(db, issueId));
  });

  router.post('/factory-intakes/:issueId/routing-decision', async (req, res) => {
    const issueId = req.params.issueId as string;
    assertBoard(req);
    const issue = await db
      .select({ companyId: issues.companyId, originKind: issues.originKind })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.originKind !== 'paperclip') throw notFound('Factory intake not found');
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.source !== 'hub_identity' || !req.actor.userId?.trim()) {
      throw forbidden('A signed Hub user is required for factory routing decisions');
    }
    const parsed = decideFactoryIntakeRoutingSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(422)
        .json({ error: parsed.error.issues[0]?.message ?? 'Invalid routing decision' });
      return;
    }
    res.json(
      await decideFactoryIntakeRouting({
        db,
        heartbeat: deps.heartbeat,
        issueId,
        actor: req.actor,
        decision: parsed.data,
      }),
    );
  });

  return router;
}
