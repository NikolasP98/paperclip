import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  companies,
  createDb,
  issues,
  pipelines,
  portfolios,
  projects,
} from "@paperclipai/db";
import type { IssuePipelineSnapshot, PipelineStepParticipant } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { issuePipelineOrchestrator } from "./issue-pipeline-orchestrator.js";
import { issuePipelineOrchestratorRepository } from "./issue-pipeline-repository.js";
import { assertPipelineHitlTerminalActor, pipelineInboxService } from "./pipeline-inbox.js";
import { pipelineInboxRoutes } from "../routes/pipeline-inbox.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("actor-scoped pipeline Inbox", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-inbox-");
    db = createDb(temp.connectionString);
  }, 20_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function seedGate(participant: PipelineStepParticipant) {
    const companyId = randomUUID();
    const portfolioId = randomUUID();
    const projectId = randomUUID();
    const pipelineId = randomUUID();
    const workerId = randomUUID();
    const rootIssueId = randomUUID();
    const userA = `user-a-${companyId}`;
    const userB = `user-b-${companyId}`;
    const effectiveParticipant: PipelineStepParticipant = participant.type === "user"
      ? { ...participant, userId: userA }
      : participant;
    const snapshot: IssuePipelineSnapshot = {
      pipelineId,
      name: "Human gate",
      description: null,
      executionMode: "stage_tasks",
      trigger: null,
      steps: [
        { key: "plan", kind: "work", label: "Plan", participant: { type: "agent", agentId: workerId } },
        { key: "approve", kind: "approval", label: "Approve", participant: effectiveParticipant },
      ],
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Inbox Co",
      issuePrefix: `I${companyId.slice(0, 6)}`.toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([
      { id: userA, name: "User A", email: `${userA}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: userB, name: "User B", email: `${userB}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userA, status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: userB, status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "planner",
      role: "planner",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(portfolios).values({ id: portfolioId, companyId, name: "Portfolio" });
    await db.insert(projects).values({ id: projectId, companyId, portfolioId, name: "Project" });
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      projectId,
      name: snapshot.name,
      executionMode: "stage_tasks",
      steps: snapshot.steps as unknown as Array<Record<string, unknown>>,
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      projectId,
      pipelineId,
      issueNumber: 1,
      identifier: `I-${rootIssueId.slice(0, 8)}`,
      title: "Root",
      status: "todo",
      priority: "medium",
    });
    const repository = issuePipelineOrchestratorRepository(db);
    const orchestrator = issuePipelineOrchestrator(repository);
    const started = await orchestrator.start({
      companyId,
      selectedProjectId: projectId,
      issueId: rootIssueId,
      sourceKey: `inbox:${rootIssueId}`,
      pipelineSnapshot: snapshot,
    });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, started.stageTask.issueId));
    let gateTaskId: string | null = null;
    await orchestrator.completeStageTask(
      { runId: started.run.id, stageTaskId: started.stageTask.issueId, terminalStatus: "done" },
      (transition) => { gateTaskId = transition.nextStageTask?.issueId ?? null; },
    );
    if (!gateTaskId) throw new Error("gate was not materialized");
    const gate = await db.select().from(issues).where(eq(issues.id, gateTaskId)).then((rows) => rows[0]!);
    return { companyId, runId: started.run.id, gate, userA, userB };
  }

  function routeApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", pipelineInboxRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("shows an exact-user gate only to the signed matching Hub user", async () => {
    const seeded = await seedGate({ type: "user", userId: "user-a" });
    const inbox = pipelineInboxService(db);
    const matching = await inbox.list(seeded.companyId, { userId: seeded.userA, trustedRoleKeys: [] });
    const mismatch = await inbox.list(seeded.companyId, { userId: seeded.userB, trustedRoleKeys: ["owner"] });
    expect(matching).toEqual([
      expect.objectContaining({
        id: seeded.gate.id,
        stageKey: "approve",
        participantUserId: seeded.userA,
        participantRoleKeys: [],
        target: { type: "user", userId: seeded.userA },
      }),
    ]);
    expect(mismatch).toEqual([]);
  });

  it("shows a role gate only when trusted signed role claims intersect", async () => {
    const seeded = await seedGate({ type: "role", roleKeys: ["engineering_lead", "owner"] });
    const inbox = pipelineInboxService(db);
    expect(await inbox.list(seeded.companyId, { userId: "user-a", trustedRoleKeys: ["engineering_lead"] }))
      .toEqual([expect.objectContaining({ id: seeded.gate.id, participantRoleKeys: ["engineering_lead", "owner"] })]);
    expect(await inbox.list(seeded.companyId, { userId: "user-a", trustedRoleKeys: ["viewer"] })).toEqual([]);
    expect(await inbox.list(seeded.companyId, { userId: seeded.userA, trustedRoleKeys: [] })).toEqual([]);
  });

  it("excludes terminal gates and open children after the run cursor becomes stale", async () => {
    const seeded = await seedGate({ type: "user", userId: "user-a" });
    const inbox = pipelineInboxService(db);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seeded.gate.id));
    expect(await inbox.list(seeded.companyId, { userId: seeded.userA, trustedRoleKeys: [] })).toEqual([]);

    await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, seeded.gate.id));
    await issuePipelineOrchestrator(issuePipelineOrchestratorRepository(db)).completeStageTask({
      runId: seeded.runId,
      stageTaskId: seeded.gate.id,
      terminalStatus: "done",
      outcome: "passed",
      summary: "approved",
    });
    expect(await inbox.list(seeded.companyId, { userId: "user-a", trustedRoleKeys: [] })).toEqual([]);
  });

  it("requires signed Hub identity and enforces exact user/role terminal authority", async () => {
    const userGate = await seedGate({ type: "user", userId: "user-a" });
    await expect(assertPipelineHitlTerminalActor(db, userGate.gate, {
      type: "board", userId: userGate.userA, source: "board_key",
    })).rejects.toMatchObject({ status: 403 });
    await expect(assertPipelineHitlTerminalActor(db, userGate.gate, {
      type: "board", userId: userGate.userB, source: "hub_identity", roleKeys: [],
    })).rejects.toMatchObject({ status: 403 });
    await expect(assertPipelineHitlTerminalActor(db, userGate.gate, {
      type: "board", userId: userGate.userA, source: "hub_identity", roleKeys: [],
    })).resolves.toBeUndefined();

    const roleGate = await seedGate({ type: "role", roleKeys: ["owner"] });
    await expect(assertPipelineHitlTerminalActor(db, roleGate.gate, {
      type: "board", userId: "user-a", source: "hub_identity", roleKeys: ["viewer"],
    })).rejects.toMatchObject({ status: 403 });
    await expect(assertPipelineHitlTerminalActor(db, roleGate.gate, {
      type: "board", userId: "user-a", source: "hub_identity", roleKeys: ["owner"],
    })).resolves.toBeUndefined();
  });

  it("fails the company Inbox route closed for service auth and returns signed-user items", async () => {
    const seeded = await seedGate({ type: "user", userId: "placeholder" });
    const actorBase = {
      type: "board" as const,
      userId: seeded.userA,
      companyIds: [seeded.companyId],
      memberships: [{ companyId: seeded.companyId, membershipRole: "member", status: "active" }],
      isInstanceAdmin: false,
    };
    const serviceResponse = await request(routeApp({ ...actorBase, source: "board_key" }))
      .get(`/api/companies/${seeded.companyId}/inbox`);
    expect(serviceResponse.status).toBe(403);

    const signedResponse = await request(routeApp({ ...actorBase, source: "hub_identity", roleKeys: [] }))
      .get(`/api/companies/${seeded.companyId}/inbox`);
    expect(signedResponse.status).toBe(200);
    expect(signedResponse.body).toEqual([
      expect.objectContaining({ id: seeded.gate.id, participantUserId: seeded.userA }),
    ]);
  });
});
