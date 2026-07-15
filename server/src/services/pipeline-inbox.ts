import { and, asc, eq, inArray } from "drizzle-orm";
import { issuePipelineRuns, issues, type Db } from "@paperclipai/db";
import type { PipelineInboxItem, PipelineStepParticipant } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";

const ACTIONABLE_STATUSES = new Set(["todo", "in_progress", "in_review"] as const);

interface PipelineInboxActor {
  userId: string;
  /** Only roles verified from a signed Hub identity may be supplied here. */
  trustedRoleKeys: string[];
}

function stageAttempt(originFingerprint: string, stageKey: string): number | null {
  const prefix = `${stageKey}:`;
  if (!originFingerprint.startsWith(prefix)) return null;
  const suffix = originFingerprint.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const attempt = Number.parseInt(suffix, 10);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

function actorCanAct(participant: PipelineStepParticipant, actor: PipelineInboxActor): boolean {
  if (participant.type === "agent") return false;
  if (participant.type === "user") return participant.userId === actor.userId;
  if (actor.trustedRoleKeys.length === 0) return false;
  const trusted = new Set(actor.trustedRoleKeys);
  return participant.roleKeys.some((roleKey) => trusted.has(roleKey));
}

export interface PipelineHitlTerminalActor {
  type: "board" | "agent" | "none";
  userId?: string;
  source?: string;
  roleKeys?: string[];
}

export interface PipelineHitlIssueIdentity {
  id: string;
  companyId: string;
  originKind: string;
  originId: string | null;
  originFingerprint: string;
  status: string;
}

/**
 * Enforces the frozen participant on terminal mutations of human stage-task
 * gates. Agent/work stages keep their existing issue authorization path.
 */
export async function assertPipelineHitlTerminalActor(
  db: Db,
  issue: PipelineHitlIssueIdentity,
  actor: PipelineHitlTerminalActor,
): Promise<void> {
  if (issue.originKind !== "pipeline_step" || !issue.originId) return;
  const run = await db
    .select()
    .from(issuePipelineRuns)
    .where(and(eq(issuePipelineRuns.id, issue.originId), eq(issuePipelineRuns.companyId, issue.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!run) return;

  const step = run.pipelineSnapshot.steps.find(
    (candidate) => stageAttempt(issue.originFingerprint, candidate.key) !== null,
  );
  if (!step || (step.kind !== "eval" && step.kind !== "approval") || step.participant.type === "agent") return;

  if (actor.type !== "board" || !actor.userId) {
    throw forbidden("This pipeline gate requires an eligible Hub user");
  }
  if (actor.source !== "hub_identity") {
    throw forbidden("A signed Hub identity is required to decide this pipeline gate");
  }
  const trustedRoleKeys = actor.roleKeys ?? [];
  if (!actorCanAct(step.participant, { userId: actor.userId, trustedRoleKeys })) {
    throw forbidden("This pipeline gate is assigned to another user or role");
  }

  // A matching participant may replay an already-terminal write to repair an
  // interrupted exact-once traversal. A still-open stale attempt must never
  // be allowed to decide a run after its cursor moved elsewhere.
  if (!ACTIONABLE_STATUSES.has(issue.status as "todo" | "in_progress" | "in_review")) return;
  if (run.status !== "active" || run.currentStepKey !== step.key) {
    throw conflict("This pipeline gate is no longer current");
  }
  const siblings = await db
    .select({ id: issues.id, originFingerprint: issues.originFingerprint })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, issue.companyId),
        eq(issues.originKind, "pipeline_step"),
        eq(issues.originId, run.id),
      ),
    );
  const latest = siblings
    .map((sibling) => ({ sibling, attempt: stageAttempt(sibling.originFingerprint, step.key) }))
    .filter((entry): entry is { sibling: typeof siblings[number]; attempt: number } => entry.attempt !== null)
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!latest || latest.sibling.id !== issue.id) {
    throw conflict("This pipeline gate attempt is stale");
  }
}

export function pipelineInboxService(db: Db) {
  return {
    async list(companyId: string, actor: PipelineInboxActor): Promise<PipelineInboxItem[]> {
      const runs = await db
        .select()
        .from(issuePipelineRuns)
        .where(and(eq(issuePipelineRuns.companyId, companyId), eq(issuePipelineRuns.status, "active")))
        .orderBy(asc(issuePipelineRuns.createdAt));
      if (runs.length === 0) return [];

      const children = await db
        .select({
          id: issues.id,
          originId: issues.originId,
          originFingerprint: issues.originFingerprint,
          status: issues.status,
          title: issues.title,
          description: issues.description,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "pipeline_step"),
            inArray(issues.originId, runs.map((run) => run.id)),
          ),
        );

      const items: PipelineInboxItem[] = [];
      for (const run of runs) {
        if (!run.currentStepKey) continue;
        const step = run.pipelineSnapshot.steps.find((candidate) => candidate.key === run.currentStepKey);
        if (!step || (step.kind !== "eval" && step.kind !== "approval") || step.participant.type === "agent") continue;
        if (step.participant.type === "user" && !step.participant.userId) continue;
        if (!actorCanAct(step.participant, actor)) continue;

        const currentChild = children
          .filter((child) => child.originId === run.id)
          .map((child) => ({ child, attempt: stageAttempt(child.originFingerprint, step.key) }))
          .filter((entry): entry is { child: typeof children[number]; attempt: number } => entry.attempt !== null)
          .sort((left, right) => right.attempt - left.attempt || right.child.createdAt.getTime() - left.child.createdAt.getTime())[0];
        if (!currentChild || !ACTIONABLE_STATUSES.has(currentChild.child.status as "todo" | "in_progress" | "in_review")) {
          continue;
        }

        const target = step.participant.type === "user"
          ? { type: "user" as const, userId: step.participant.userId! }
          : { type: "role" as const, roleKeys: [...step.participant.roleKeys] };
        items.push({
          id: currentChild.child.id,
          type: "approval",
          issueId: currentChild.child.id,
          rootIssueId: run.issueId,
          runId: run.id,
          pipelineId: run.pipelineId,
          pipelineName: run.pipelineSnapshot.name,
          projectId: run.selectedProjectId,
          stageKey: step.key,
          stageKind: step.kind,
          stageLabel: step.label,
          attempt: currentChild.attempt,
          status: currentChild.child.status as PipelineInboxItem["status"],
          title: currentChild.child.title,
          description: currentChild.child.description,
          href: `/workforce/issues/${currentChild.child.id}`,
          target,
          participantUserId: target.type === "user" ? target.userId : null,
          participantRoleKeys: target.type === "role" ? target.roleKeys : [],
          createdAt: currentChild.child.createdAt,
          updatedAt: currentChild.child.updatedAt,
        });
      }
      return items;
    },
  };
}
