import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentLearningSignals, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentHarnessRoutes } from "../routes/agent-harnesses.js";
import { agentHarnessService } from "../services/agent-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("agent harness governance routes", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-agent-harness-routes-");
    db = createDb(temp.connectionString);
  }, 20_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  function app(actor: express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", agentHarnessRoutes(db));
    instance.use(
      (
        error: { status?: number; message?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => res.status(error.status ?? 500).json({ error: error.message ?? "Internal error" }),
    );
    return instance;
  }

  it("allows reviewer proposals but reserves every decision endpoint for board users", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Routes Co",
      issuePrefix: "HRC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "bug-fixer",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: { model: "github-copilot/claude-sonnet-5" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "learning-reviewer",
        role: "researcher",
        adapterType: "hermes_local",
        adapterConfig: { model: "review-model" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const base = (await agentHarnessService(db).ensureRevision(workerId, companyId))!;
    const signal = await db
      .insert(agentLearningSignals)
      .values({
        companyId,
        agentId: workerId,
        harnessRevisionId: base.id,
        signalType: "human_feedback",
        outcome: "changes_requested",
        body: "Ask for focused verification evidence.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const payload = {
      signalId: signal.id,
      rationale: "The attributed feedback asks for focused verification evidence.",
      change: {
        kind: "replace_role_guidance",
        baseRevisionId: base.id,
        before: String(base.snapshot.guidance),
        after: `${String(base.snapshot.guidance)} Include the exact focused verification command.`,
      },
    };
    const workerActor: express.Request["actor"] = {
      type: "agent",
      agentId: workerId,
      companyId,
      runId: null,
      keyId: "worker-key",
      source: "agent_key",
    };
    const reviewerActor: express.Request["actor"] = {
      type: "agent",
      agentId: reviewerId,
      companyId,
      runId: null,
      keyId: "reviewer-key",
      source: "agent_key",
    };
    const boardActor: express.Request["actor"] = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    };

    const missingIdentity = await request(
      app({ type: "agent", companyId, source: "agent_key" }),
    )
      .post(`/api/agents/${workerId}/harness/proposals`)
      .send(payload);
    expect(missingIdentity.status).toBe(403);
    const self = await request(app(workerActor))
      .post(`/api/agents/${workerId}/harness/proposals`)
      .send(payload);
    expect(self.status).toBe(403);
    const created = await request(app(reviewerActor))
      .post(`/api/agents/${workerId}/harness/proposals`)
      .send(payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.status).toBe("proposed");

    const decisionRequests = [
      ["approve", {}],
      ["reject", { reason: "Human review is required." }],
      ["promote", {}],
      ["rollback", { reason: "Human review is required." }],
    ] as const;
    for (const [decision, body] of decisionRequests) {
      const response = await request(app(reviewerActor))
        .post(`/api/agents/${workerId}/harness/proposals/${created.body.id}/${decision}`)
        .send(body);
      expect(response.status, decision).toBe(403);
    }

    const approved = await request(app(boardActor))
      .post(`/api/agents/${workerId}/harness/proposals/${created.body.id}/approve`)
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const promoted = await request(app(boardActor))
      .post(`/api/agents/${workerId}/harness/proposals/${created.body.id}/promote`)
      .send({});
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.status).toBe("promoted");
    const rolledBack = await request(app(boardActor))
      .post(`/api/agents/${workerId}/harness/proposals/${created.body.id}/rollback`)
      .send({ reason: "Restore the prior guidance after the trial." });
    expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
    expect(rolledBack.body.status).toBe("rolled_back");
  });
});
