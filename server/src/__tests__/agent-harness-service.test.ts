import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentHarnessRevisions,
  agents,
  companies,
  createDb,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentHarnessService, captureDecisionLearningSignal } from "../services/agent-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
describeDb("agent harness persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-agent-harness-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => {
    await temp?.cleanup();
  });
  it("keeps the configuration revision pinned while score telemetry updates", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const decisionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Co",
      issuePrefix: "HAR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "bug-fixer",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-5" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "HAR-1",
      title: "Fix",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueExecutionDecisions).values({
      id: decisionId,
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "changes_requested",
      body: "Needs regression coverage",
      score: 6.5,
      maxScore: 10,
    });
    const service = agentHarnessService(db);
    const before = await service.ensureRevision(agentId, companyId);
    expect(before).not.toBeNull();
    await captureDecisionLearningSignal(db, {
      companyId,
      issueId,
      decisionId,
      workerAgentId: agentId,
      outcome: "changes_requested",
      score: 6.5,
      maxScore: 10,
      body: "Needs regression coverage",
      runId: null,
    });
    const after = await service.ensureRevision(agentId, companyId);
    expect(after?.id).toBe(before?.id);
    expect(after?.performanceSnapshot).toMatchObject({
      signalCount: 1,
      averageScore: 6.5,
      changesRequestedCount: 1,
    });
    const revisions = await db.select().from(agentHarnessRevisions);
    expect(revisions).toHaveLength(1);
  });
});
