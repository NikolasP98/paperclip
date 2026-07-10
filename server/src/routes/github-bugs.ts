import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { ISSUE_PRIORITIES, type IssuePriority } from "@paperclipai/shared";
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
    await deps.repoSandbox.refresh(entry.name).catch(() => undefined);
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

  const created = await issueService(db).create(deps.companyId, {
    title: gh.title,
    description: `GitHub issue: ${gh.html_url}\n\n${gh.body ?? ""}`,
    priority: pickSeverity(labels),
    status: "todo",
    assigneeAgentId: deps.agentId,
    originKind: "github_issue",
    originId,
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
