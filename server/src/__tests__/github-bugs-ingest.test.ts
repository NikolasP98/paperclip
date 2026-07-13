import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  issuePipelineRuns,
  issues,
  pipelines,
  portfolios,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { handleGithubEvent, type GithubBugsDeps } from "../routes/github-bugs.js";
import { PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID } from "../services/github-stage-task-intake.js";

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
    await db.delete(issues);
    await db.delete(pipelines);
    await db.delete(projects);
    await db.delete(portfolios);
    await db.delete(agents);
    await db.delete(companies);
    wakeup.mockClear();
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

  it("classifies, deterministically routes, and materializes one stage-task run across webhook retries", async () => {
    const seeded = await seedCompanyAndAgent();
    companyId = seeded.newCompanyId;
    agentId = seeded.newAgentId;
    deps.companyId = companyId;
    deps.agentId = agentId;
    const portfolioId = randomUUID();
    const intakeProjectId = randomUUID();
    const workforceProjectId = randomUUID();
    const pipelineId = randomUUID();
    await db.insert(portfolios).values({ id: portfolioId, companyId, name: "MINION Code" });
    await db.insert(projects).values([
      { id: intakeProjectId, companyId, portfolioId, name: "Portfolio Intake" },
      { id: workforceProjectId, companyId, portfolioId, name: "Workforce / Projects" },
    ]);
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
    const classify = vi.fn(async () => ({
      labels: ["bug"],
      scopes: ["workforce"],
      projectKey: "hub-workforce",
      projectGroup: "minion-hub",
      confidence: 0.94,
      rationale: "The report concerns the workforce projects module.",
    }));
    deps.stageTaskIntake = {
      classifier: { droneId: PORTFOLIO_ISSUE_CLASSIFIER_DRONE_ID, classify },
      config: {
        pipelineId,
        intakeProjectId,
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

    const first = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"), {
      deliveryId: "delivery-1",
    });
    const replay = await handleGithubEvent(db, deps, "issues", issuesEvent("opened"), {
      deliveryId: "delivery-1",
    });

    expect(first).toMatchObject({ action: "created", pipelineRunId: expect.any(String) });
    expect(replay).toMatchObject({ action: "duplicate", pipelineRunId: first.pipelineRunId });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]).toEqual({
      issue: {
        source: "github",
        repository: "NikolasP98/minion_hub",
        externalId: "7",
        title: "[Bug] chart crashes",
        body: "steps…",
        labels: ["bug", "high", "agent"],
      },
      allowedLabels: ["bug", "feature", "security", "maintenance", "docs", "critical", "high", "medium", "low"],
      allowedScopes: ["auth", "crm", "core", "gateway", "workforce", "ui", "data", "plugins", "ops", "docs"],
      projectCandidates: [
        {
          key: "portfolio-intake",
          name: "Portfolio Intake",
          repositories: ["*"],
          scopes: [],
        },
        {
          key: "hub-workforce",
          name: "Workforce / Projects",
          group: "minion-hub",
          repositories: ["NikolasP98/minion_hub"],
          scopes: ["workforce"],
        },
      ],
      fallbackProjectKey: "portfolio-intake",
    });

    const runs = await db.select().from(issuePipelineRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: first.pipelineRunId,
      selectedProjectId: workforceProjectId,
      sourceDeliveryId: "delivery-1",
      routingSnapshot: {
        repository: "NikolasP98/minion_hub",
        inferredLabels: ["bug"],
        selectedProjectId: workforceProjectId,
        resolution: "rule",
        classifierOutput: { projectKey: "hub-workforce", scopes: ["workforce"] },
      },
    });
    const allIssues = await db.select().from(issues);
    const root = allIssues.find((issue) => issue.originKind === "github_issue");
    const stageChildren = allIssues.filter((issue) => issue.originKind === "pipeline_step");
    expect(root).toMatchObject({ projectId: workforceProjectId, status: "blocked", assigneeAgentId: null });
    expect(stageChildren).toHaveLength(1);
    expect(stageChildren[0]).toMatchObject({ parentId: root?.id, originFingerprint: "plan:1", projectId: workforceProjectId });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
