import { Router } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { issues, issueExecutionDecisions, executionWorkspaces, portfolios, projects, type Db } from "@paperclipai/db";
import { createPortfolioSchema, updatePortfolioSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const STUCK_AFTER_HOURS = 24;
const STUCK_CAP = 20;

interface MetricsBucket {
  openByStatus: Record<string, number>;
  createdLast7d: number;
  createdLast30d: number;
  completedLast7d: number;
  completedLast30d: number;
  avgCycleTimeHours: number | null;
  changesRequestedRate: number | null;
  avgEvalScore: number | null;
  stuckIssues: Array<{ id: string; identifier: string | null; title: string; status: string; updatedAt: Date }>;
  activeWorkspaces: number;
}

function emptyBucket(): MetricsBucket {
  return {
    openByStatus: {},
    createdLast7d: 0,
    createdLast30d: 0,
    completedLast7d: 0,
    completedLast30d: 0,
    avgCycleTimeHours: null,
    changesRequestedRate: null,
    avgEvalScore: null,
    stuckIssues: [],
    activeWorkspaces: 0,
  };
}

/** Aggregate issue/decision/workspace metrics for a set of projects, bucketed per project + rollup. */
async function computePortfolioMetrics(
  db: Db,
  companyId: string,
  projectRows: Array<{ id: string; name: string }>,
): Promise<{ rollup: MetricsBucket; projects: Array<{ projectId: string; projectName: string } & MetricsBucket> }> {
  const projectIds = projectRows.map((p) => p.id);
  const rollup = emptyBucket();
  const buckets = new Map<string, MetricsBucket>(projectRows.map((p) => [p.id, emptyBucket()]));
  if (projectIds.length === 0) return { rollup, projects: [] };

  const projectScope = and(eq(issues.companyId, companyId), inArray(issues.projectId, projectIds));

  const statusRows = await db
    .select({ projectId: issues.projectId, status: issues.status, count: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(projectScope, isNull(issues.completedAt), isNull(issues.cancelledAt)))
    .groupBy(issues.projectId, issues.status);
  for (const row of statusRows) {
    if (!row.projectId) continue;
    const bucket = buckets.get(row.projectId);
    if (!bucket) continue;
    bucket.openByStatus[row.status] = row.count;
    rollup.openByStatus[row.status] = (rollup.openByStatus[row.status] ?? 0) + row.count;
  }

  const windowRows = await db
    .select({
      projectId: issues.projectId,
      created7: sql<number>`count(*) FILTER (WHERE ${issues.createdAt} > now() - interval '7 days')::int`,
      created30: sql<number>`count(*) FILTER (WHERE ${issues.createdAt} > now() - interval '30 days')::int`,
      completed7: sql<number>`count(*) FILTER (WHERE ${issues.completedAt} > now() - interval '7 days')::int`,
      completed30: sql<number>`count(*) FILTER (WHERE ${issues.completedAt} > now() - interval '30 days')::int`,
      avgCycleHours: sql<
        number | null
      >`avg(EXTRACT(EPOCH FROM (${issues.completedAt} - ${issues.createdAt})) / 3600.0) FILTER (WHERE ${issues.completedAt} > now() - interval '30 days')`,
    })
    .from(issues)
    .where(projectScope)
    .groupBy(issues.projectId);
  for (const row of windowRows) {
    if (!row.projectId) continue;
    const bucket = buckets.get(row.projectId);
    if (!bucket) continue;
    bucket.createdLast7d = row.created7;
    bucket.createdLast30d = row.created30;
    bucket.completedLast7d = row.completed7;
    bucket.completedLast30d = row.completed30;
    bucket.avgCycleTimeHours = row.avgCycleHours == null ? null : Number(row.avgCycleHours);
  }

  const decisionRows = await db
    .select({
      projectId: issues.projectId,
      total: sql<number>`count(*)::int`,
      changesRequested: sql<number>`count(*) FILTER (WHERE ${issueExecutionDecisions.outcome} = 'changes_requested')::int`,
      avgScore: sql<number | null>`avg(${issueExecutionDecisions.score})`,
    })
    .from(issueExecutionDecisions)
    .innerJoin(issues, eq(issueExecutionDecisions.issueId, issues.id))
    .where(and(projectScope, sql`${issueExecutionDecisions.createdAt} > now() - interval '30 days'`))
    .groupBy(issues.projectId);
  for (const row of decisionRows) {
    if (!row.projectId) continue;
    const bucket = buckets.get(row.projectId);
    if (!bucket) continue;
    bucket.changesRequestedRate = row.total > 0 ? row.changesRequested / row.total : null;
    bucket.avgEvalScore = row.avgScore == null ? null : Number(row.avgScore);
  }

  const stuckRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(
      and(
        projectScope,
        eq(issues.status, "in_review"),
        sql`${issues.updatedAt} < now() - interval '${sql.raw(String(STUCK_AFTER_HOURS))} hours'`,
      ),
    )
    .orderBy(issues.updatedAt)
    .limit(STUCK_CAP);
  for (const row of stuckRows) {
    const entry = { id: row.id, identifier: row.identifier, title: row.title, status: row.status, updatedAt: row.updatedAt };
    if (row.projectId) buckets.get(row.projectId)?.stuckIssues.push(entry);
    if (rollup.stuckIssues.length < STUCK_CAP) rollup.stuckIssues.push(entry);
  }

  const workspaceRows = await db
    .select({ projectId: executionWorkspaces.projectId, count: sql<number>`count(*)::int` })
    .from(executionWorkspaces)
    .where(and(inArray(executionWorkspaces.projectId, projectIds), isNull(executionWorkspaces.closedAt)))
    .groupBy(executionWorkspaces.projectId);
  for (const row of workspaceRows) {
    const bucket = buckets.get(row.projectId);
    if (!bucket) continue;
    bucket.activeWorkspaces = row.count;
    rollup.activeWorkspaces += row.count;
  }

  // Rollup counters/averages from the per-project buckets (weighted where it matters).
  let cycleWeight = 0;
  let cycleSum = 0;
  let decisionTotal = 0;
  let decisionChanges = 0;
  for (const row of windowRows) {
    if (!row.projectId) continue;
    rollup.createdLast7d += row.created7;
    rollup.createdLast30d += row.created30;
    rollup.completedLast7d += row.completed7;
    rollup.completedLast30d += row.completed30;
    if (row.avgCycleHours != null && row.completed30 > 0) {
      cycleSum += Number(row.avgCycleHours) * row.completed30;
      cycleWeight += row.completed30;
    }
  }
  rollup.avgCycleTimeHours = cycleWeight > 0 ? cycleSum / cycleWeight : null;
  let scoreWeight = 0;
  let scoreSum = 0;
  for (const row of decisionRows) {
    decisionTotal += row.total;
    decisionChanges += row.changesRequested;
    if (row.avgScore != null && row.total > 0) {
      scoreSum += Number(row.avgScore) * row.total;
      scoreWeight += row.total;
    }
  }
  rollup.changesRequestedRate = decisionTotal > 0 ? decisionChanges / decisionTotal : null;
  rollup.avgEvalScore = scoreWeight > 0 ? scoreSum / scoreWeight : null;

  return {
    rollup,
    projects: projectRows.map((p) => ({ projectId: p.id, projectName: p.name, ...buckets.get(p.id)! })),
  };
}

export function portfolioRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/portfolios", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = await db
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.companyId, companyId), eq(portfolios.status, status ?? "active")))
      .orderBy(desc(portfolios.createdAt));
    res.json(rows);
  });

  router.post("/companies/:companyId/portfolios", validate(createPortfolioSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const [portfolio] = await db
      .insert(portfolios)
      .values({ ...req.body, companyId })
      .returning();
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "portfolio.created",
      entityType: "portfolio",
      entityId: portfolio.id,
      details: { name: portfolio.name },
    });
    res.status(201).json(portfolio);
  });

  router.get("/portfolios/:id", async (req, res) => {
    const [portfolio] = await db.select().from(portfolios).where(eq(portfolios.id, req.params.id as string)).limit(1);
    if (!portfolio) {
      res.status(404).json({ error: "Portfolio not found" });
      return;
    }
    assertCompanyAccess(req, portfolio.companyId);
    res.json(portfolio);
  });

  router.patch("/portfolios/:id", validate(updatePortfolioSchema), async (req, res) => {
    const id = req.params.id as string;
    const [existing] = await db.select().from(portfolios).where(eq(portfolios.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Portfolio not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const [portfolio] = await db
      .update(portfolios)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(portfolios.id, id))
      .returning();
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: portfolio.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "portfolio.updated",
      entityType: "portfolio",
      entityId: portfolio.id,
      details: req.body,
    });
    res.json(portfolio);
  });

  // Soft delete: portfolios carry charter/history — archive instead of removing.
  router.delete("/portfolios/:id", async (req, res) => {
    const id = req.params.id as string;
    const [existing] = await db.select().from(portfolios).where(eq(portfolios.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Portfolio not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const [portfolio] = await db
      .update(portfolios)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(portfolios.id, id))
      .returning();
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: portfolio.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "portfolio.archived",
      entityType: "portfolio",
      entityId: portfolio.id,
    });
    res.json(portfolio);
  });

  router.get("/portfolios/:id/projects", async (req, res) => {
    const id = req.params.id as string;
    const [portfolio] = await db.select().from(portfolios).where(eq(portfolios.id, id)).limit(1);
    if (!portfolio) {
      res.status(404).json({ error: "Portfolio not found" });
      return;
    }
    assertCompanyAccess(req, portfolio.companyId);
    const rows = await db.select().from(projects).where(eq(projects.portfolioId, id)).orderBy(projects.name);
    res.json(rows);
  });

  router.get("/portfolios/:id/metrics", async (req, res) => {
    const id = req.params.id as string;
    const [portfolio] = await db.select().from(portfolios).where(eq(portfolios.id, id)).limit(1);
    if (!portfolio) {
      res.status(404).json({ error: "Portfolio not found" });
      return;
    }
    assertCompanyAccess(req, portfolio.companyId);
    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.portfolioId, id));
    res.json(await computePortfolioMetrics(db, portfolio.companyId, projectRows));
  });

  return router;
}
