import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { ISSUE_PRIORITIES, type IssueExecutionPolicy, type IssuePriority } from "@paperclipai/shared";
import { issues, type Db } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";
import type { RepoSandboxService } from "../services/repo-sandbox.js";

export interface GithubBugsDeps {
  /** heartbeatService instance — same one handed to issueRoutes in app.ts */
  heartbeat: Parameters<typeof queueIssueAssignmentWakeup>[0]["heartbeat"];
  repoSandbox: RepoSandboxService | null;
  secret: string;
  companyId: string;
  /** bug-fixer agent uuid */
  agentId: string;
  /** only issues from this repo are ingested, e.g. "NikolasP98/minion_hub" */
  bugRepo: string;
  /** project every ingested bug lands in (its workspace drives worktree provisioning) */
  projectId?: string;
  /** review-stage agent — when set, the fixer's "done" routes through this reviewer */
  reviewerAgentId?: string;
  /** approval-stage (HITL) user — final gate before an issue can complete */
  approverUserId?: string;
}

/**
 * Kanban process for bug issues: fix (assignee) → review (agent stage) →
 * approval (user HITL stage). Stages are the runtime's native
 * executionPolicy machine — requesting done advances the cursor and
 * auto-wakes the next participant.
 */
export function buildBugExecutionPolicy(deps: GithubBugsDeps): IssueExecutionPolicy | undefined {
  const stages: IssueExecutionPolicy["stages"] = [];
  if (deps.reviewerAgentId) {
    stages.push({
      id: randomUUID(),
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "agent", agentId: deps.reviewerAgentId }],
    });
  }
  if (deps.approverUserId) {
    stages.push({
      id: randomUUID(),
      type: "approval",
      approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "user", userId: deps.approverUserId }],
    });
  }
  if (stages.length === 0) return undefined;
  return { mode: "normal", commentRequired: true, stages };
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pickSeverity(labels: string[]): IssuePriority {
  return ISSUE_PRIORITIES.find((p) => labels.includes(p)) ?? "medium";
}

export type GithubEventOutcome =
  | { action: "ignored"; reason: string }
  | { action: "refreshed"; repo: string }
  | { action: "created" | "duplicate" | "rewoken"; issueId: string };

type GithubIssuePayload = {
  action?: string;
  repository?: { full_name?: string };
  issue?: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    labels?: Array<{ name?: string }>;
  };
  ref?: string;
};

export async function handleGithubEvent(
  db: Db,
  deps: GithubBugsDeps,
  event: string,
  payload: GithubIssuePayload,
): Promise<GithubEventOutcome> {
  if (event === "push") {
    const fullName = payload.repository?.full_name;
    if (payload.ref && !payload.ref.startsWith("refs/heads/")) {
      return { action: "ignored", reason: "non-branch push" };
    }
    const entry = fullName ? deps.repoSandbox?.findByCloneUrlRepo(fullName) : null;
    if (!entry || !deps.repoSandbox) return { action: "ignored", reason: "unregistered repo" };
    // warm-cache only: workspace realization fetches again before each worktree (baseRef origin/<branch>)
    await deps.repoSandbox.refresh(entry.name).catch((err) => { console.error("[github-bugs] push refresh failed:", err); });
    return { action: "refreshed", repo: entry.name };
  }

  if (event !== "issues") return { action: "ignored", reason: `event ${event || "unknown"}` };

  const gh = payload.issue;
  const fullName = payload.repository?.full_name;
  if (!gh || fullName !== deps.bugRepo) return { action: "ignored", reason: "not the bug repo" };
  const labels = (gh.labels ?? []).map((l) => l.name ?? "");
  if (!labels.includes("bug")) return { action: "ignored", reason: "no bug label" };
  if (payload.action !== "opened" && payload.action !== "reopened") {
    return { action: "ignored", reason: `action ${payload.action ?? "unknown"}` };
  }

  const originId = `${fullName}#${gh.number}`;
  // ponytail: no partial-unique DB index on (companyId, originKind, originId)
  // for originKind "github_issue" (unlike routine_execution etc. — see
  // packages/db/src/schema/issues.ts:95-143), so two concurrent deliveries of
  // the same GitHub event can both pass this select before either commits its
  // insert, racing a duplicate issue. Index deferred: migrations are blocked
  // by the pre-existing duplicate-0057 numbering defect. Add the partial
  // unique index (and switch this to an upsert-on-conflict) once that's fixed.
  const [existing] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, deps.companyId),
        eq(issues.originKind, "github_issue"),
        eq(issues.originId, originId),
      ),
    )
    .limit(1);

  if (existing) {
    if (payload.action === "reopened") {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: existing,
        reason: `GitHub bug reopened: ${originId}`,
        mutation: "updated",
        contextSource: "github-bugs",
        requestedByActorType: "system",
        requestedByActorId: "github-bugs",
      });
      return { action: "rewoken", issueId: existing.id };
    }
    return { action: "duplicate", issueId: existing.id };
  }

  // ponytail: if deps.agentId (GITHUB_BUGS_AGENT_ID) is pending approval or
  // terminated, issueService(...).create's assertAssignableAgent check
  // throws → this delivery 500s. Operators must keep that agent active.
  const executionPolicy = buildBugExecutionPolicy(deps);
  const created = await issueService(db).create(deps.companyId, {
    title: gh.title,
    description: `GitHub issue: ${gh.html_url}\n\n${gh.body ?? ""}`,
    priority: pickSeverity(labels),
    status: "todo",
    assigneeAgentId: deps.agentId,
    originKind: "github_issue",
    originId,
    ...(deps.projectId ? { projectId: deps.projectId } : {}),
    // issues.executionPolicy jsonb column is typed Record<string, unknown>
    ...(executionPolicy ? { executionPolicy: executionPolicy as unknown as Record<string, unknown> } : {}),
  });

  await logActivity(db, {
    companyId: deps.companyId,
    actorType: "system",
    actorId: "github-bugs",
    action: "issue.bug_ingested",
    entityType: "issue",
    entityId: created.id,
    details: { source: "github", repo: fullName, githubIssue: gh.number, url: gh.html_url },
  });

  await queueIssueAssignmentWakeup({
    heartbeat: deps.heartbeat,
    issue: created,
    reason: `GitHub bug: ${originId}`,
    mutation: "created",
    contextSource: "github-bugs",
    requestedByActorType: "system",
    requestedByActorId: "github-bugs",
  });

  return { action: "created", issueId: created.id };
}

export function githubBugRoutes(db: Db, deps: GithubBugsDeps): Router {
  const router = Router();
  router.post("/github-bugs/webhook", async (req, res) => {
    // rawBody is captured only for application/json bodies (express.json verify hook) — the GitHub webhook MUST be configured with content type application/json, or every delivery 401s here.
    const rawBody = (req as { rawBody?: Buffer }).rawBody;
    const signature = req.get("x-hub-signature-256");
    if (!rawBody || !verifyGitHubSignature(rawBody, signature, deps.secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    const event = req.get("x-github-event") ?? "";
    try {
      const outcome = await handleGithubEvent(db, deps, event, req.body as GithubIssuePayload);
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
