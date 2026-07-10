import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { handleGithubEvent, type GithubBugsDeps } from "../routes/github-bugs.js";

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
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    wakeup.mockClear();
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
});
