import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentHarnessRevisions,
  agents,
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issuePipelineEvents,
  issuePipelineRuns,
  issues,
  labels,
  pipelines,
  portfolios,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { handleGithubEvent, type GithubBugsDeps } from "../routes/github-bugs.js";
import {
  finalizeGithubClassifierHeartbeatById,
  PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID,
  reconcileGithubClassifierPipelineRun,
} from "../services/github-stage-task-intake.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("github-bugs ingestion", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let deps!: GithubBugsDeps;
  const wakeup = vi.fn().mockResolvedValue(null);
  const heartbeat = { wakeup } as unknown as GithubBugsDeps["heartbeat"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-bugs-");
    db = createDb(tempDb.connectionString);
    deps = {
      heartbeat,
      repoSandbox: null,
      secret: "s",
      companyId: "",
      agentId: "",
      bugRepo: "NikolasP98/minion_hub",
    };
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(pipelines);
    await db.delete(projects);
    await db.delete(portfolios);
    await db.delete(agents);
    await db.delete(companies);
    wakeup.mockReset().mockResolvedValue(null);
    deps.stageTaskIntake = undefined;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const newCompanyId = randomUUID();
    await db.insert(companies).values({
      id: newCompanyId,
      name: "Paperclip",
      issuePrefix: `T${newCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const newAgentId = randomUUID();
    await db.insert(agents).values({
      id: newAgentId,
      companyId: newCompanyId,
      name: "BugFixerAgent",
      role: "engineer",
      status: "active",
      reportsTo: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { newCompanyId, newAgentId };
  }

  function issuesEvent(action: "opened" | "reopened", number = 7) {
    return {
      action,
      repository: { full_name: "NikolasP98/minion_hub" },
      issue: {
        number,
        title: "[Bug] chart crashes",
        body: "steps…",
        html_url: `https://github.com/NikolasP98/minion_hub/issues/${number}`,
        labels: [{ name: "bug" }, { name: "high" }, { name: "agent" }],
      },
    };
  }

  async function seedAsyncStageTaskIntake() {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;
    const classifierAgentId = randomUUID();
    await db.insert(agents).values({
      id: classifierAgentId,
      companyId,
      name: "IssueClassifier",
      role: "general",
      status: "active",
      reportsTo: null,
      adapterType: "minion_drone",
      adapterConfig: { droneId: PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID },
      runtimeConfig: {},
      permissions: {},
    });
    const harnessRevisionId = randomUUID();
    await db.insert(agentHarnessRevisions).values({
      id: harnessRevisionId,
      companyId,
      agentId: classifierAgentId,
      revisionNumber: 1,
      contentHash: `classifier-${harnessRevisionId}`,
      snapshot: { role: "classifier", revision: 1 },
      performanceSnapshot: {},
      source: "test",
    });
    const portfolioId = randomUUID();
    const intakeProjectId = randomUUID();
    const workforceProjectId = randomUUID();
    const pipelineId = randomUUID();
    await db.insert(portfolios).values({ id: portfolioId, companyId, name: "MINION Code" });
    await db.insert(projects).values([
      { id: intakeProjectId, companyId, portfolioId, name: "Portfolio Intake" },
      { id: workforceProjectId, companyId, portfolioId, name: "Workforce / Projects" },
    ]);
    const intakeProjectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: intakeProjectWorkspaceId,
      companyId,
      projectId: intakeProjectId,
      name: "Portfolio intake workspace",
      cwd: "/tmp/portfolio-intake",
      isPrimary: true,
    });
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      name: "Repository delivery",
      executionMode: "stage_tasks",
      trigger: { originKinds: ["github_issue"] },
      steps: [
        {
          key: "plan",
          kind: "work",
          label: "Plan",
          participant: { type: "agent", agentId },
        },
      ],
    });
    deps.stageTaskIntake = {
      config: {
        pipelineId,
        intakeProjectId,
        classifierAgentId,
        minimumConfidence: 0.7,
        routes: [
          {
            key: "portfolio-intake",
            name: "Portfolio Intake",
            projectId: intakeProjectId,
            repository: "cross-repo",
            repositories: ["*"],
            scopes: [],
          },
          {
            key: "hub-workforce",
            name: "Workforce / Projects",
            projectId: workforceProjectId,
            group: "minion-hub",
            repository: "minion-hub",
            repositories: ["NikolasP98/minion_hub"],
            scopes: ["workforce"],
          },
        ],
      },
    };
    wakeup.mockImplementation(async (wokenAgentId, options) => {
      return db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId: wokenAgentId,
          harnessRevisionId: wokenAgentId === classifierAgentId ? harnessRevisionId : null,
          invocationSource: options.source ?? "assignment",
          triggerDetail: options.triggerDetail ?? "system",
          status: "queued",
          contextSnapshot: options.contextSnapshot ?? {},
        })
        .returning()
        .then((rows) => rows[0]);
    });
    return {
      classifierAgentId,
      harnessRevisionId,
      intakeProjectId,
      intakeProjectWorkspaceId,
      workforceProjectId,
      pipelineId,
    };
  }

  it("creates an issue with origin columns, priority from label, assignee, and wakes the agent", async () => {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;

    const outcome = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"));
    expect(outcome.action).toBe("created");
    expect(outcome).toHaveProperty("issueId");

    const [row] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, (outcome as { issueId: string }).issueId));
    expect(row).toMatchObject({
      originKind: "github_issue",
      originId: "NikolasP98/minion_hub#7",
      priority: "high",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing inline pipeline and assignee wakeup path", async () => {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;
    const pipelineId = randomUUID();
    await db.insert(pipelines).values({
      id: pipelineId,
      companyId,
      name: "Legacy inline bug flow",
      executionMode: "inline",
      trigger: { originKinds: ["github_issue"], labels: ["bug"] },
      steps: [
        {
          key: "fix",
          kind: "work",
          label: "Fix",
          participant: { type: "agent", agentId },
        },
      ],
    });

    const outcome = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"));
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, (outcome as { issueId: string }).issueId))
      .then((rows) => rows[0]);

    expect(row).toMatchObject({ pipelineId, assigneeAgentId: agentId, status: "todo" });
    expect(await db.select().from(issuePipelineRuns)).toEqual([]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on redelivery of opened", async () => {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;

    await handleGithubEvent(db, deps, "issues", issuesEvent("opened"));
    wakeup.mockClear();
    const outcome = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"));
    expect(outcome.action).toBe("duplicate");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("re-wakes on reopened instead of duplicating", async () => {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;

    await handleGithubEvent(db, deps, "issues", issuesEvent("opened"));
    wakeup.mockClear();
    const outcome = await handleGithubEvent(db, deps, "issues", issuesEvent("reopened"));
    expect(outcome.action).toBe("rewoken");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("ignores non-bug-repo and unlabeled issues", async () => {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;

    const ev = issuesEvent("opened", 8);
    ev.repository.full_name = "NikolasP98/other";
    expect((await handleGithubEvent(db, deps, "issues", ev)).action).toBe("ignored");
  });

  it("attributes async classification, freezes delivery, and reconciles exactly once", async () => {
    const seeded = await seedAsyncStageTaskIntake();
    const first = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"), {
      deliveryId: "delivery-1",
    });
    const replay = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"), {
      deliveryId: "delivery-1",
    });

    expect(first).toMatchObject({ action: "created", pipelineRunId: expect.any(String) });
    expect(replay).toMatchObject({ action: "duplicate", pipelineRunId: first.pipelineRunId });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const intakeExecutionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: intakeExecutionWorkspaceId,
      companyId,
      projectId: seeded.intakeProjectId,
      projectWorkspaceId: seeded.intakeProjectWorkspaceId,
      mode: "reuse_project",
      strategyType: "direct",
      name: "Portfolio intake execution",
      cwd: "/tmp/portfolio-intake",
    });
    await db
      .update(issues)
      .set({
        projectWorkspaceId: seeded.intakeProjectWorkspaceId,
        executionWorkspaceId: intakeExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, (first as { issueId: string }).issueId));
    const rootBeforeClassification = await db
      .select()
      .from(issues)
      .where(eq(issues.id, (first as { issueId: string }).issueId))
      .then((rows) => rows[0]);
    expect(rootBeforeClassification).toMatchObject({
      projectId: seeded.intakeProjectId,
      projectWorkspaceId: seeded.intakeProjectWorkspaceId,
      executionWorkspaceId: intakeExecutionWorkspaceId,
    });
    const classifierWake = wakeup.mock.calls[0];
    expect(classifierWake?.[0]).toBe(seeded.classifierAgentId);
    expect(classifierWake?.[1]).toMatchObject({
      reason: "github_issue_classification",
      contextSnapshot: {
        paperclipDrone: {
          input: {
            issue: {
              source: "github",
              repository: "NikolasP98/minion_hub",
              externalId: "7",
            },
            fallbackProjectKey: "portfolio-intake",
          },
        },
        githubClassifier: {
          kind: "github_issue_classifier_v1",
          classifierPipelineRunId: first.pipelineRunId,
        },
      },
    });

    const classifierRun = await db
      .select()
      .from(issuePipelineRuns)
      .where(eq(issuePipelineRuns.id, first.pipelineRunId as string))
      .then((rows) => rows[0]);
    expect(classifierRun).toMatchObject({
      selectedProjectId: seeded.intakeProjectId,
      sourceOriginId: "classifier:NikolasP98/minion_hub#7",
      sourceDeliveryId: "delivery-1",
      pipelineSnapshot: { steps: [{ key: "classify" }] },
      routingSnapshot: {
        resolution: "unresolved",
        selectedProjectId: seeded.intakeProjectId,
        intakeContext: {
          classifierAgentId: seeded.classifierAgentId,
          deliveryPipelineSnapshot: { steps: [{ key: "plan" }] },
        },
      },
    });

    // An operator edit after intake must not alter the in-flight delivery snapshot.
    await db
      .update(pipelines)
      .set({
        steps: [
          {
            key: "edited-plan",
            kind: "work",
            label: "Edited Plan",
            participant: { type: "agent", agentId },
          },
        ],
        updatedAt: new Date(),
      })
      .where(eq(pipelines.id, seeded.pipelineId));

    const classifierHeartbeat = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, seeded.classifierAgentId))
      .then((rows) => rows[0]);
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        resultJson: {
          droneId: PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID,
          output: {
            labels: ["bug", "high"],
            scopes: ["workforce"],
            projectKey: "hub-workforce",
            projectGroup: "minion-hub",
            confidence: 0.94,
            rationale: "The report concerns the workforce projects module.",
          },
        },
        resolvedAdapterType: "minion_drone",
        resolvedModel: "claude-haiku-4-5",
        resolvedProvider: "anthropic",
        finishedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, classifierHeartbeat!.id));

    const finalized = await finalizeGithubClassifierHeartbeatById({
      db,
      heartbeat,
      heartbeatRunId: classifierHeartbeat!.id,
    });
    expect(finalized).toMatchObject({ status: "routed" });
    expect(wakeup).toHaveBeenCalledTimes(2);

    const runs = await db.select().from(issuePipelineRuns);
    expect(runs).toHaveLength(2);
    const deliveryRun = runs.find((run) => run.sourceOriginId.startsWith("delivery:"));
    expect(deliveryRun).toMatchObject({
      selectedProjectId: seeded.workforceProjectId,
      sourceOriginId: "delivery:NikolasP98/minion_hub#7",
      pipelineSnapshot: { steps: [{ key: "plan", participant: { agentId } }] },
      routingSnapshot: {
        inferredLabels: ["bug", "high"],
        selectedProjectId: seeded.workforceProjectId,
        resolution: "rule",
      },
    });
    const allIssues = await db.select().from(issues);
    const root = allIssues.find((issue) => issue.originKind === "github_issue")!;
    const classifierTask = allIssues.find(
      (issue) => issue.originId === first.pipelineRunId && issue.originFingerprint === "classify:1",
    );
    const planTask = allIssues.find(
      (issue) => issue.originId === deliveryRun?.id && issue.originFingerprint === "plan:1",
    );
    expect(root).toMatchObject({
      projectId: seeded.workforceProjectId,
      projectWorkspaceId: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      status: "blocked",
      assigneeAgentId: null,
    });
    expect(classifierTask).toMatchObject({ status: "done", projectId: seeded.intakeProjectId });
    expect(planTask).toMatchObject({ status: "todo", projectId: seeded.workforceProjectId });
    const localLabels = await db.select().from(labels);
    expect(localLabels.map((label) => label.name)).toEqual(
      expect.arrayContaining(["bug", "high", "scope:workforce"]),
    );

    const terminalTrace = await db
      .select()
      .from(issuePipelineEvents)
      .where(eq(issuePipelineEvents.pipelineRunId, first.pipelineRunId as string))
      .then((events) => events.find((event) => event.eventType === "stage_completed"));
    expect(terminalTrace).toMatchObject({
      heartbeatRunId: classifierHeartbeat!.id,
      harnessRevisionId: seeded.harnessRevisionId,
      resolvedAdapterType: "minion_drone",
      resolvedModel: "claude-haiku-4-5",
      resolvedProvider: "anthropic",
      outputSnapshot: {
        classificationStatus: "validated",
        validatedOutput: { projectKey: "hub-workforce" },
      },
      decisionSnapshot: { projectId: seeded.workforceProjectId },
    });

    const rootUpdatedAt = root.updatedAt.getTime();
    const eventCount = (await db.select().from(issuePipelineEvents)).length;
    await reconcileGithubClassifierPipelineRun({
      db,
      heartbeat,
      pipelineRunId: first.pipelineRunId as string,
    });
    await reconcileGithubClassifierPipelineRun({
      db,
      heartbeat,
      pipelineRunId: first.pipelineRunId as string,
    });
    const rootAfterReplay = await db
      .select()
      .from(issues)
      .where(eq(issues.id, root.id))
      .then((rows) => rows[0]);
    expect(rootAfterReplay?.updatedAt.getTime()).toBe(rootUpdatedAt);
    expect(await db.select().from(issuePipelineEvents)).toHaveLength(eventCount);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("blocks invalid classifier output in Portfolio Intake without starting delivery", async () => {
    const seeded = await seedAsyncStageTaskIntake();
    const first = await handleGithubEvent(db, deps, "issues", issuesEvent("opened", 9));
    const classifierHeartbeat = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, seeded.classifierAgentId))
      .then((rows) => rows[0]);
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        resultJson: {
          droneId: PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID,
          output: {
            labels: ["not-in-taxonomy"],
            scopes: ["workforce"],
            projectKey: "hub-workforce",
            confidence: 0.99,
            rationale: "Invalid label must fail strict validation.",
          },
        },
        resolvedAdapterType: "minion_drone",
        resolvedModel: "claude-haiku-4-5",
        resolvedProvider: "anthropic",
        finishedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, classifierHeartbeat!.id));

    const finalized = await finalizeGithubClassifierHeartbeatById({
      db,
      heartbeat,
      heartbeatRunId: classifierHeartbeat!.id,
    });
    expect(finalized).toMatchObject({ status: "blocked", deliveryRun: null });
    expect(await db.select().from(issuePipelineRuns)).toHaveLength(1);
    const root = await db
      .select()
      .from(issues)
      .where(eq(issues.id, (first as { issueId: string }).issueId))
      .then((rows) => rows[0]);
    const child = await db
      .select()
      .from(issues)
      .then((rows) => rows.find((issue) => issue.originKind === "pipeline_step"));
    expect(root).toMatchObject({ projectId: seeded.intakeProjectId, status: "blocked" });
    expect(child).toMatchObject({ projectId: seeded.intakeProjectId, status: "blocked" });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});
