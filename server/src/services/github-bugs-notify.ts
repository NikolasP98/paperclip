import { eq } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export function parseGithubOrigin(originId: string): { repo: string; number: number } | null {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(originId);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export function buildFailureComment(input: { runId: string; reason: string }): string {
  return [
    "⚠️ Automated triage failed before producing a diagnosis.",
    `Run \`${input.runId}\`: ${input.reason}`,
    "The issue remains open for the next run or a human.",
  ].join("\n\n");
}

/**
 * Best-effort: comments on the linked GitHub issue when a github_issue-origin
 * heartbeat run crashes before the agent could post its own diagnosis. Never throws.
 */
export async function notifyGithubBugRunFailure(
  db: Db,
  input: { issueId: string | null; runId: string; reason: string },
): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token || !input.issueId) return;
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId)).limit(1);
    if (!issue || issue.originKind !== "github_issue" || !issue.originId) return;
    const origin = parseGithubOrigin(issue.originId);
    if (!origin) return;
    const res = await fetch(
      `https://api.github.com/repos/${origin.repo}/issues/${origin.number}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: buildFailureComment(input) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      logger.error(
        { status: res.status, originId: issue.originId, runId: input.runId },
        "github-bugs: failure comment request rejected",
      );
    }
  } catch (err) {
    logger.error({ err, runId: input.runId }, "github-bugs: failure comment error");
  }
}
