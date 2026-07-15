import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentHarnessRevisions,
  agentLearningProposals,
  agentLearningSignals,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  agentHarnessService,
  captureAttributedHarnessLearningSignal,
  captureDecisionLearningSignal,
} from "../services/agent-harness.js";

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
    const placeholders = await db.select().from(agentLearningProposals);
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      status: "review_needed",
      proposalType: "review_needed",
      proposedChanges: {},
    });
  });

  it("governs signal-backed guidance promotion, preservation, rollback, and replay", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Governance Co",
      issuePrefix: "HGC",
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
    const service = agentHarnessService(db);
    const base = await service.ensureRevision(workerId, companyId);
    expect(base).not.toBeNull();
    const signal = await db
      .insert(agentLearningSignals)
      .values({
        companyId,
        agentId: workerId,
        harnessRevisionId: base!.id,
        signalType: "human_feedback",
        outcome: "changes_requested",
        score: 6,
        maxScore: 10,
        body: "The implementation missed a focused regression test.",
        metadata: { source: "board" },
      })
      .returning()
      .then((rows) => rows[0]!);
    const before = String(base!.snapshot.guidance);
    const after = `${before} Always add the smallest focused regression test that proves the corrected behavior.`;
    const proposalInput = {
      companyId,
      agentId: workerId,
      signalId: signal.id,
      rationale: "The attributed review repeatedly identifies missing focused regression coverage.",
      change: {
        kind: "replace_role_guidance" as const,
        baseRevisionId: base!.id,
        before,
        after,
      },
    };

    await expect(
      service.createGuidanceProposal({
        ...proposalInput,
        actor: { type: "agent", agentId: workerId },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const proposal = await service.createGuidanceProposal({
      ...proposalInput,
      actor: { type: "agent", agentId: reviewerId },
    });
    const proposalReplay = await service.createGuidanceProposal({
      ...proposalInput,
      actor: { type: "agent", agentId: reviewerId },
    });
    expect(proposalReplay.id).toBe(proposal.id);
    expect(proposal).toMatchObject({ status: "proposed", proposalType: "role_guidance" });

    const approved = await service.approveGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    const approvedReplay = await service.approveGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(approved.status).toBe("approved");
    expect(approvedReplay.id).toBe(proposal.id);

    const promoted = await service.promoteGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    const promotedReplay = await service.promoteGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(promoted.status).toBe("promoted");
    expect(promotedReplay.id).toBe(proposal.id);
    const promotedContext = await service.compactContext(workerId, companyId);
    expect(promotedContext?.guidance).toBe(after);

    await db
      .update(agents)
      .set({ adapterConfig: { model: "github-copilot/claude-sonnet-5.1" } })
      .where(eq(agents.id, workerId));
    const observedChange = await service.ensureRevision(workerId, companyId);
    expect(observedChange?.source).toBe("observed_config_change");
    expect(observedChange?.snapshot.guidance).toBe(after);

    const rolledBack = await service.rollbackGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
      reason: "The new wording was too prescriptive for documentation-only issues.",
    });
    const rollbackReplay = await service.rollbackGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(rolledBack.status).toBe("rolled_back");
    expect(rollbackReplay.id).toBe(proposal.id);
    expect((await service.compactContext(workerId, companyId))?.guidance).toBe(before);

    const revisions = await db
      .select()
      .from(agentHarnessRevisions)
      .where(eq(agentHarnessRevisions.agentId, workerId));
    expect(revisions.map((revision) => revision.revisionNumber).sort()).toEqual([1, 2, 3, 4]);
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, proposal.id));
    expect(activities.map((activity) => activity.action).sort()).toEqual([
      "agent_harness.guidance_approved",
      "agent_harness.guidance_promoted",
      "agent_harness.guidance_proposed",
      "agent_harness.guidance_rolled_back",
    ]);
  });

  it("governs active capabilities within the immutable catalog and narrows on catalog shrink", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Capability Co",
      issuePrefix: "HCP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "bug-fixer-capabilities",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: {
          model: "github-copilot/claude-sonnet-5",
          allowedTools: ["custom-deployer"],
          skills: ["custom-skill"],
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "learning-reviewer-capabilities",
        role: "researcher",
        adapterType: "hermes_local",
        adapterConfig: { model: "review-model" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const service = agentHarnessService(db);
    const base = (await service.ensureRevision(workerId, companyId))!;
    const baseContext = (await service.compactContext(workerId, companyId))!;
    const signal = await db
      .insert(agentLearningSignals)
      .values({
        companyId,
        agentId: workerId,
        harnessRevisionId: base.id,
        signalType: "human_feedback",
        outcome: "changes_requested",
        body: "Use only the read path and the approved custom deployment capability.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const proposalInput = {
      companyId,
      agentId: workerId,
      signalId: signal.id,
      rationale: "The attributed feedback asks for a narrower active execution policy.",
      change: {
        kind: "replace_active_capabilities" as const,
        baseRevisionId: base.id,
        before: {
          tools: baseContext.activeTools,
          skills: baseContext.activeSkills,
        },
        after: {
          tools: ["read", "custom-deployer"],
          skills: ["custom-skill"],
        },
      },
    };

    await expect(
      service.createCapabilityProposal({
        ...proposalInput,
        change: {
          ...proposalInput.change,
          after: { tools: ["read", "root-shell"], skills: ["custom-skill"] },
        },
        actor: { type: "agent", agentId: reviewerId },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.createCapabilityProposal({
        ...proposalInput,
        actor: { type: "agent", agentId: workerId },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const proposal = await service.createCapabilityProposal({
      ...proposalInput,
      actor: { type: "agent", agentId: reviewerId },
    });
    const replay = await service.createCapabilityProposal({
      ...proposalInput,
      actor: { type: "agent", agentId: reviewerId },
    });
    expect(replay.id).toBe(proposal.id);
    expect(proposal).toMatchObject({
      status: "proposed",
      proposalType: "active_capabilities",
      validationPlan: {
        immutableOperatorCatalog: true,
        adapterRemainsOuterBound: true,
      },
    });
    await service.approveProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    await service.promoteProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(await service.compactContext(workerId, companyId)).toMatchObject({
      activeTools: ["custom-deployer", "read"],
      activeSkills: ["custom-skill"],
    });

    await db
      .update(agents)
      .set({
        adapterConfig: {
          model: "github-copilot/claude-sonnet-5.1",
          allowedTools: ["custom-deployer"],
          skills: ["custom-skill"],
        },
      })
      .where(eq(agents.id, workerId));
    const preserved = await service.ensureRevision(workerId, companyId);
    expect(preserved?.source).toBe("observed_config_change");
    expect(await service.compactContext(workerId, companyId)).toMatchObject({
      activeTools: ["custom-deployer", "read"],
      activeSkills: ["custom-skill"],
    });

    await db
      .update(agents)
      .set({
        adapterConfig: {
          model: "github-copilot/claude-sonnet-5.2",
          allowedTools: [],
          skills: [],
        },
      })
      .where(eq(agents.id, workerId));
    const narrowed = await service.ensureRevision(workerId, companyId);
    expect(narrowed?.source).toBe("observed_config_change");
    expect(await service.compactContext(workerId, companyId)).toMatchObject({
      activeTools: ["read"],
      activeSkills: [],
    });

    const rolledBack = await service.rollbackProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
      reason: "Restore the prior selection without restoring removed catalog entries.",
    });
    expect(rolledBack.status).toBe("rolled_back");
    const rollbackReplay = await service.rollbackProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(rollbackReplay.id).toBe(proposal.id);
    expect(await service.compactContext(workerId, companyId)).toMatchObject({
      activeTools: ["edit", "git", "github", "read", "shell"],
      activeSkills: [
        "systematic-debugging",
        "test-driven-development",
        "verification-before-completion",
      ],
    });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, proposal.id));
    expect(activities.map((activity) => activity.action).sort()).toEqual([
      "agent_harness.capabilities_approved",
      "agent_harness.capabilities_promoted",
      "agent_harness.capabilities_proposed",
      "agent_harness.capabilities_rolled_back",
    ]);
  });

  it("supersedes an approved proposal when its locked base is stale", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Stale Base Co",
      issuePrefix: "HSB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "bug-fixer-stale",
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: { model: "github-copilot/claude-sonnet-5" },
      runtimeConfig: {},
      permissions: {},
    });
    const service = agentHarnessService(db);
    const base = (await service.ensureRevision(workerId, companyId))!;
    const signal = await db
      .insert(agentLearningSignals)
      .values({
        companyId,
        agentId: workerId,
        harnessRevisionId: base.id,
        signalType: "human_feedback",
        outcome: "changes_requested",
        body: "Clarify the verification expectation.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const proposal = await service.createGuidanceProposal({
      companyId,
      agentId: workerId,
      signalId: signal.id,
      rationale: "The attributed signal calls for a clearer verification expectation.",
      change: {
        kind: "replace_role_guidance",
        baseRevisionId: base.id,
        before: String(base.snapshot.guidance),
        after: `${String(base.snapshot.guidance)} Report the exact focused verification command.`,
      },
      actor: { type: "user", userId: "board-user" },
    });
    await service.approveGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    await db
      .update(agents)
      .set({ capabilities: "Observed configuration changed before promotion." })
      .where(eq(agents.id, workerId));
    const newer = await service.ensureRevision(workerId, companyId);
    expect(newer?.id).not.toBe(base.id);

    const superseded = await service.promoteGuidanceProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(superseded).toMatchObject({
      status: "superseded",
      resolution: { reason: "stale_base_revision", currentRevisionId: newer?.id },
    });
    expect((await service.compactContext(workerId, companyId))?.guidance).toBe(
      String(base.snapshot.guidance),
    );
  });

  it("supersedes an approved capability proposal when its locked base is stale", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Capability Stale Base Co",
      issuePrefix: "HCS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "bug-fixer-capability-stale",
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: { model: "github-copilot/claude-sonnet-5" },
      runtimeConfig: {},
      permissions: {},
    });
    const service = agentHarnessService(db);
    const base = (await service.ensureRevision(workerId, companyId))!;
    const context = (await service.compactContext(workerId, companyId))!;
    const signal = await db
      .insert(agentLearningSignals)
      .values({
        companyId,
        agentId: workerId,
        harnessRevisionId: base.id,
        signalType: "human_feedback",
        outcome: "changes_requested",
        body: "Narrow the active capability selection.",
      })
      .returning()
      .then((rows) => rows[0]!);
    const proposal = await service.createCapabilityProposal({
      companyId,
      agentId: workerId,
      signalId: signal.id,
      rationale: "The attributed signal requests a narrower active execution policy.",
      change: {
        kind: "replace_active_capabilities",
        baseRevisionId: base.id,
        before: { tools: context.activeTools, skills: context.activeSkills },
        after: { tools: ["read"], skills: [] },
      },
      actor: { type: "user", userId: "board-user" },
    });
    await service.approveProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    await db
      .update(agents)
      .set({ capabilities: "Operator changed the role capability catalog context." })
      .where(eq(agents.id, workerId));
    const newer = await service.ensureRevision(workerId, companyId);
    expect(newer?.id).not.toBe(base.id);

    const superseded = await service.promoteProposal({
      companyId,
      agentId: workerId,
      proposalId: proposal.id,
      userId: "board-user",
    });
    expect(superseded).toMatchObject({
      status: "superseded",
      resolution: { reason: "stale_base_revision", currentRevisionId: newer?.id },
    });
    expect(await service.compactContext(workerId, companyId)).toMatchObject({
      activeTools: context.activeTools,
      activeSkills: context.activeSkills,
    });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, proposal.id));
    expect(activities.map((activity) => activity.action).sort()).toEqual([
      "agent_harness.capabilities_approved",
      "agent_harness.capabilities_proposed",
      "agent_harness.capabilities_superseded",
    ]);
  });

  it("ingests explicitly attributed pipeline signals idempotently by bounded source key", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Harness Pipeline Signal Co",
      issuePrefix: "HPS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "pipeline-worker",
      role: "engineer",
      adapterType: "opencode_local",
      adapterConfig: { model: "github-copilot/claude-sonnet-5" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "HPS-1",
      title: "Pipeline work",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: workerId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "succeeded",
    });
    const revision = (await agentHarnessService(db).ensureRevision(workerId, companyId))!;
    const input = {
      companyId,
      agentId: workerId,
      sourceKey: "pipeline:run-7:evaluate:iteration-2:user-feedback",
      signalType: "pipeline_evaluation",
      outcome: "changes_requested",
      body: "The evaluator found that the regression path is not covered.",
      score: 6,
      maxScore: 10,
      harnessRevisionId: revision.id,
      issueId,
      runId,
      metadata: { stageKey: "evaluate", apiKey: "must-not-persist" },
    };
    const created = await captureAttributedHarnessLearningSignal(db, input);
    const replay = await captureAttributedHarnessLearningSignal(db, input);
    expect(replay.id).toBe(created.id);
    expect(created).toMatchObject({
      harnessRevisionId: revision.id,
      issueId,
      runId,
      sourceKey: input.sourceKey,
      metadata: { stageKey: "evaluate", apiKey: "***REDACTED***" },
    });
    await expect(
      captureAttributedHarnessLearningSignal(db, {
        ...input,
        body: "A conflicting replay must not rewrite attributed evidence.",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      captureAttributedHarnessLearningSignal(db, {
        ...input,
        sourceKey: "not allowed whitespace",
      }),
    ).rejects.toMatchObject({ status: 422 });
    const proposals = await db
      .select()
      .from(agentLearningProposals)
      .where(eq(agentLearningProposals.signalId, created.id));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "review_needed",
      proposedChanges: {},
    });
  });
});
