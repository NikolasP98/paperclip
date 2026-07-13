import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import {
  activityLog,
  agentHarnessRevisions,
  agentLearningProposals,
  agentLearningSignals,
  agents,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  createHarnessGuidanceProposalSchema,
  harnessGuidanceChangeSchema,
  type AgentHarnessLearningPolicy,
  type AgentHarnessProposalStatus,
  type AgentHarnessRoleKey,
  type AgentHarnessRuntimePolicy,
  type AgentHarnessSummary,
  type HarnessGuidanceChange,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

const SECRET_KEY = /(secret|token|password|credential|api.?key|authorization|private.?key)/i;
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sorted(child)]),
  );
}
function sameHarnessValue(left: unknown, right: unknown) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
export function harnessContentHash(snapshot: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify(sorted(snapshot)))
    .digest("hex");
}
export function redactHarnessValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "***REDACTED***";
  if (Array.isArray(value)) return value.map((child) => redactHarnessValue(child));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactHarnessValue(child, childKey),
    ]),
  );
}
export function roleKeyForAgent(agent: { name: string }): AgentHarnessRoleKey {
  const name = agent.name.toLowerCase();
  if (name.includes("classifier") || name.includes("triage-router")) return "issue-classifier";
  if (name.includes("planner") || name.includes("spec-writer")) return "spec-planner";
  if (name.includes("implementer") || name.includes("bug-fixer")) return "implementer";
  if (name.includes("evaluator") || name.includes("bug-reviewer") || name.includes("bug-eval"))
    return "evaluator";
  if (name.includes("merger") || name.includes("merge-readiness")) return "code-merger";
  if (name.includes("portfolio") && (name.includes("monitor") || name.includes("review")))
    return "portfolio-monitor";
  if (name.includes("learning") || name.includes("curator") || name.includes("hermes"))
    return "learning-reviewer";
  return "generic";
}
export function guidanceForRole(roleKey: AgentHarnessRoleKey) {
  return {
    "issue-classifier":
      "Return only the typed repository issue taxonomy. Cite evidence and abstain on ambiguity. Do not mutate labels, projects, issues, repositories, or harness configuration; the control plane applies validated output.",
    "spec-planner":
      "Produce a bounded implementation spec and explicit child-work proposal from the parent issue, project charter, repository instructions, and prior feedback. Do not edit code or create subtasks directly; exact-once decomposition occurs only after plan approval.",
    implementer:
      "Fix the root cause with the smallest safe diff. Read prior feedback first, add focused regression coverage, run focused checks, push only the issue branch, and open a draft PR. Record exactly one primary GitHub pull_request work product on the implementation task with explicit headSha, baseRef, baseSha, and typed checks metadata. Never merge or push a default branch.",
    evaluator:
      "Read-only evaluation: inspect the approved spec, implementation work product, diff, and focused checks. Do not edit or push. Apply the versioned rubric and submit status, findings, and typed evalScore together. A failing score creates a new implementation iteration rather than rewriting history.",
    "code-merger":
      "Validate only the immutable PR, target, approval, head SHA, and check evidence supplied after the release approval gate. Return typed readiness and blockers only. Do not run git or GitHub mutations; readiness completion never merges or pushes.",
    "portfolio-monitor":
      "Read-only monitoring: deduplicate findings, cite evidence, and propose governed remediation. Do not edit repositories or mutate agent prompts, skills, or runtime configuration.",
    "learning-reviewer":
      "Review attributed evaluator and human feedback, then create a bounded memory, skill, instruction, or routing proposal. Never mutate or promote the live harness.",
    generic:
      "Follow the governed issue scope and use attributed evidence. Propose rather than directly mutate harness configuration.",
  }[roleKey];
}
function entry(value: unknown, fallbackType: string) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    runtimeKind: typeof record.runtimeKind === "string" ? record.runtimeKind : "paperclip_adapter",
    adapterType: typeof record.type === "string" ? record.type : fallbackType,
    model: typeof record.model === "string" ? record.model : null,
    provider: typeof record.provider === "string" ? record.provider : null,
    executable: true,
  };
}
const selection = (
  adapterType: string | null,
  model: string,
  provider: string | null,
  runtimeKind = "paperclip_adapter",
  executable = true,
) => ({
  runtimeKind,
  adapterType,
  model,
  provider,
  executable,
  ...(!executable ? { bridgePending: true } : {}),
});
const droneSelection = (model: string, provider: string) =>
  selection(null, model, provider, "minion_drone", false);

export function observedHarnessConfig(agent: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
}) {
  const config = agent.adapterConfig;
  const fallbackChain = Array.isArray(config.fallbackChain)
    ? config.fallbackChain.map((item) => entry(item, agent.adapterType))
    : [];
  const env =
    config.env && typeof config.env === "object"
      ? Object.keys(config.env as Record<string, unknown>).sort()
      : [];
  const instructionPath =
    typeof config.instructionsFilePath === "string"
      ? createHash("sha256").update(config.instructionsFilePath).digest("hex")
      : null;
  return {
    adapterType: agent.adapterType,
    model: typeof config.model === "string" ? config.model : null,
    provider: typeof config.provider === "string" ? config.provider : null,
    timeoutSec: typeof config.timeoutSec === "number" ? config.timeoutSec : null,
    maxTurnsPerRun: typeof config.maxTurnsPerRun === "number" ? config.maxTurnsPerRun : null,
    fallbackChain,
    allowedTools: Array.isArray(config.allowedTools)
      ? config.allowedTools.filter((v): v is string => typeof v === "string")
      : [],
    skills: Array.isArray(config.skills)
      ? config.skills.filter((v): v is string => typeof v === "string")
      : [],
    envKeys: env,
    instructionPathHash: instructionPath,
  };
}

export function harnessPolicyPreset(agent: {
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}): {
  roleKey: AgentHarnessRoleKey;
  runtime: AgentHarnessRuntimePolicy;
  learning: AgentHarnessLearningPolicy;
} {
  const roleKey = roleKeyForAgent(agent);
  const skills = Array.isArray(agent.adapterConfig.skills)
    ? agent.adapterConfig.skills.filter((v): v is string => typeof v === "string")
    : [];
  const tools = Array.isArray(agent.adapterConfig.allowedTools)
    ? agent.adapterConfig.allowedTools.filter((v): v is string => typeof v === "string")
    : [];
  const fallbacks = Array.isArray(agent.adapterConfig.fallbackChain)
    ? agent.adapterConfig.fallbackChain
    : [];
  const preset = {
    "issue-classifier": [
      "general",
      ["issue-read", "taxonomy-read"],
      ["repository-issue-classification"],
      8,
      60_000,
      0.1,
      10,
    ],
    "spec-planner": [
      "general",
      ["issue-read", "project-read", "repository-read"],
      ["task-planning", "spec-writing"],
      8,
      600_000,
      0.15,
      300,
    ],
    implementer: [
      "coding",
      ["read", "edit", "shell", "git", "github"],
      ["systematic-debugging", "test-driven-development", "verification-before-completion"],
      7,
      1_800_000,
      0.25,
      500,
    ],
    evaluator: [
      "evaluation",
      ["read", "shell", "git", "issue-update"],
      ["requesting-code-review", "verification-before-completion"],
      7,
      900_000,
      0.15,
      250,
    ],
    "code-merger": [
      "general",
      ["issue-read", "approval-read", "work-product-read"],
      ["merge-readiness"],
      9,
      90_000,
      0.05,
      20,
    ],
    "portfolio-monitor": [
      "monitoring",
      ["read", "issue-search", "portfolio-read"],
      ["paperclip-board"],
      6,
      300_000,
      0.1,
      100,
    ],
    "learning-reviewer": [
      "general",
      ["harness-read", "signal-read", "proposal-create"],
      ["skill-curation", "memory-review"],
      7,
      600_000,
      0.15,
      200,
    ],
    generic: [
      "general",
      ["read", "shell", "issue-update"],
      ["paperclip"],
      6,
      900_000,
      0.25,
      300,
    ],
  }[roleKey] as [
    AgentHarnessRuntimePolicy["runtimeClass"],
    string[],
    string[],
    number,
    number,
    number,
    number,
  ];
  const recommended =
    roleKey === "issue-classifier"
      ? {
          primary: droneSelection("claude-haiku-4-6", "anthropic"),
          fallbacks: [selection("claude_local", "claude-haiku-4-6", "anthropic")],
          canaries: [droneSelection("google/gemini-2.5-flash", "openrouter")],
        }
      : roleKey === "spec-planner"
        ? {
            primary: droneSelection("claude-opus-4-8", "anthropic"),
            fallbacks: [selection("claude_local", "claude-opus-4-8", "anthropic")],
            canaries: [
              selection("opencode_local", "github-copilot/claude-fable-5", "github-copilot"),
            ],
          }
        : roleKey === "implementer"
      ? {
          primary: selection(
            "opencode_local",
            "github-copilot/claude-sonnet-5",
            "github-copilot",
          ),
          fallbacks: [
            selection("codex_local", "gpt-5.3-codex", "openai"),
            selection("claude_local", "claude-sonnet-4-6", "anthropic"),
          ],
          canaries: [],
        }
      : roleKey === "evaluator"
        ? {
            primary: selection("codex_local", "gpt-5.4", "openai"),
            fallbacks: [selection("claude_local", "claude-opus-4-8", "anthropic")],
            canaries: [droneSelection("gpt-5.4", "openai")],
          }
        : roleKey === "code-merger"
          ? {
              primary: droneSelection("claude-haiku-4-6", "anthropic"),
              fallbacks: [selection("claude_local", "claude-haiku-4-6", "anthropic")],
              canaries: [],
            }
          : roleKey === "portfolio-monitor"
          ? {
              primary: droneSelection("google/gemini-2.5-flash", "openrouter"),
              fallbacks: [
                selection("opencode_local", "github-copilot/gpt-5.4-mini", "github-copilot"),
              ],
              canaries: [],
            }
          : roleKey === "learning-reviewer"
            ? {
                primary: selection(
                  "hermes_local",
                  "mistralai/mistral-large-2512",
                  "openrouter",
                ),
                fallbacks: [
                  selection("claude_local", "claude-sonnet-4-6", "anthropic"),
                  selection("codex_local", "gpt-5.3-codex-spark", "openai"),
                ],
                canaries: [],
              }
          : {
              primary: entry(agent.adapterConfig, agent.adapterType),
              fallbacks: fallbacks.map((item) => entry(item, agent.adapterType)),
              canaries: [],
            };
  return {
    roleKey,
    runtime: {
      runtimeClass: preset[0],
      active: {
        primary: entry(agent.adapterConfig, agent.adapterType),
        fallbacks: fallbacks.map((item) => entry(item, agent.adapterType)),
      },
      recommended,
      tools: [...new Set([...preset[1], ...tools])],
      skills: [...new Set([...preset[2], ...skills])],
      objectives: {
        scoreFloor: preset[3],
        maxLatencyMs: preset[4],
        maxFallbackRate: preset[5],
        maxCostPerAcceptedOutcomeCents: preset[6],
      },
    },
    learning: {
      proposalScoreThreshold: preset[3],
      minimumSignals: 1,
      recentSignalLimit: 5,
      recentSignalChars: 2_000,
    },
  };
}

function summary(row: typeof agentHarnessRevisions.$inferSelect): AgentHarnessSummary {
  const snapshot = row.snapshot;
  const roleKey = snapshot.roleKey as AgentHarnessRoleKey;
  return {
    agentId: row.agentId,
    revisionId: row.id,
    revisionNumber: row.revisionNumber,
    contentHash: row.contentHash,
    roleKey,
    guidance:
      typeof snapshot.guidance === "string" ? snapshot.guidance : guidanceForRole(roleKey),
    runtime: snapshot.runtime as AgentHarnessRuntimePolicy,
    learning: snapshot.learning as AgentHarnessLearningPolicy,
    performance: row.performanceSnapshot,
    createdAt: row.createdAt,
  };
}

function revisionGuidance(revision: typeof agentHarnessRevisions.$inferSelect) {
  const roleKey = revision.snapshot.roleKey as AgentHarnessRoleKey;
  return typeof revision.snapshot.guidance === "string"
    ? revision.snapshot.guidance
    : guidanceForRole(roleKey);
}

type HarnessProposalActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string };

export function agentHarnessService(db: Db) {
  async function ensureRevision(agentId: string, companyId?: string) {
    return db.transaction(async (tx) => {
      const agent = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, agentId),
            ...(companyId ? [eq(agents.companyId, companyId)] : []),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!agent) return null;

      const current = agent.currentHarnessRevisionId
        ? await tx
            .select()
            .from(agentHarnessRevisions)
            .where(
              and(
                eq(agentHarnessRevisions.id, agent.currentHarnessRevisionId),
                eq(agentHarnessRevisions.agentId, agent.id),
                eq(agentHarnessRevisions.companyId, agent.companyId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const policy = harnessPolicyPreset(agent);
      const snapshot = sorted({
        ...policy,
        guidance: current ? revisionGuidance(current) : guidanceForRole(policy.roleKey),
        observed: observedHarnessConfig(agent),
        capabilities: agent.capabilities,
      }) as Record<string, unknown>;
      const contentHash = harnessContentHash(snapshot);
      if (current?.contentHash === contentHash) return current;

      const counter = await tx
        .select({ value: max(agentHarnessRevisions.revisionNumber) })
        .from(agentHarnessRevisions)
        .where(eq(agentHarnessRevisions.agentId, agent.id))
        .then((rows) => rows[0]?.value ?? 0);
      const created = await tx
        .insert(agentHarnessRevisions)
        .values({
          companyId: agent.companyId,
          agentId: agent.id,
          revisionNumber: counter + 1,
          contentHash,
          snapshot,
          source: current ? "observed_config_change" : "runtime_snapshot",
        })
        .returning()
        .then((rows) => rows[0]!);
      const pointerCondition = agent.currentHarnessRevisionId
        ? eq(agents.currentHarnessRevisionId, agent.currentHarnessRevisionId)
        : isNull(agents.currentHarnessRevisionId);
      const updated = await tx
        .update(agents)
        .set({ currentHarnessRevisionId: created.id, updatedAt: new Date() })
        .where(and(eq(agents.id, agent.id), pointerCondition))
        .returning({ id: agents.id });
      if (updated.length !== 1) throw conflict("Harness revision changed during reconciliation");
      return created;
    });
  }

  async function compactContext(agentId: string, companyId: string) {
    const revision = await ensureRevision(agentId, companyId);
    if (!revision) return null;
    const learning = revision.snapshot.learning as AgentHarnessLearningPolicy;
    const roleKey = revision.snapshot.roleKey as AgentHarnessRoleKey;
    const rows = await db
      .select()
      .from(agentLearningSignals)
      .where(
        and(
          eq(agentLearningSignals.companyId, companyId),
          eq(agentLearningSignals.agentId, agentId),
        ),
      )
      .orderBy(desc(agentLearningSignals.createdAt))
      .limit(Math.min(learning.recentSignalLimit, 10));
    let remaining = Math.min(learning.recentSignalChars, 4_000);
    const recentFeedback = rows.flatMap((signal) => {
      if (remaining <= 0) return [];
      const body = signal.body.slice(0, Math.min(400, remaining));
      remaining -= body.length;
      return [
        {
          outcome: signal.outcome,
          score: signal.score,
          maxScore: signal.maxScore,
          body,
          createdAt: signal.createdAt,
        },
      ];
    });
    return {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      roleKey,
      guidance: revisionGuidance(revision),
      learning,
      performance: revision.performanceSnapshot,
      recentFeedback,
    };
  }
  async function currentSummaries(companyId: string, agentIds: string[]) {
    const rows = await db
      .select({ agent: agents, revision: agentHarnessRevisions })
      .from(agents)
      .leftJoin(
        agentHarnessRevisions,
        eq(agents.currentHarnessRevisionId, agentHarnessRevisions.id),
      )
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    const result: AgentHarnessSummary[] = [];
    for (const row of rows) {
      const revision = row.revision ?? (await ensureRevision(row.agent.id, companyId));
      if (revision) result.push(summary(revision));
    }
    return result;
  }

  async function authorizeProposalActor(
    store: Db,
    actor: HarnessProposalActor,
    targetAgentId: string,
    companyId: string,
  ) {
    if (actor.type === "user") return;
    if (actor.agentId === targetAgentId) {
      throw forbidden("Workers cannot propose changes to their own harness");
    }
    const reviewer = await store
      .select()
      .from(agents)
      .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (
      !reviewer ||
      (reviewer.adapterType !== "hermes_local" && roleKeyForAgent(reviewer) !== "learning-reviewer")
    ) {
      throw forbidden("Only a board user or learning-reviewer/Hermes agent may propose guidance");
    }
  }

  async function writeActivity(
    store: Db,
    input: {
      companyId: string;
      actorType: "agent" | "user";
      actorId: string;
      action: string;
      proposalId: string;
      agentId: string;
      details: Record<string, unknown>;
    },
  ) {
    await store.insert(activityLog).values({
      companyId: input.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: "agent_learning_proposal",
      entityId: input.proposalId,
      agentId: input.agentId,
      details: input.details,
    });
  }

  async function createGuidanceProposal(input: {
    companyId: string;
    agentId: string;
    signalId: string;
    rationale: string;
    change: HarnessGuidanceChange;
    actor: HarnessProposalActor;
  }) {
    const parsedInput = createHarnessGuidanceProposalSchema.parse({
      signalId: input.signalId,
      rationale: input.rationale,
      change: input.change,
    });
    const change = parsedInput.change;
    return db.transaction(async (tx) => {
      const store = tx as unknown as Db;
      const target = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Agent not found");
      await authorizeProposalActor(store, input.actor, input.agentId, input.companyId);

      const signal = await tx
        .select()
        .from(agentLearningSignals)
        .where(
          and(
            eq(agentLearningSignals.id, parsedInput.signalId),
            eq(agentLearningSignals.companyId, input.companyId),
            eq(agentLearningSignals.agentId, input.agentId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!signal?.harnessRevisionId) {
        throw unprocessable("Proposal requires an attributed learning signal with a revision");
      }
      if (signal.harnessRevisionId !== change.baseRevisionId) {
        throw unprocessable("Proposal base revision must match the attributed signal revision");
      }
      const base = await tx
        .select()
        .from(agentHarnessRevisions)
        .where(
          and(
            eq(agentHarnessRevisions.id, change.baseRevisionId),
            eq(agentHarnessRevisions.companyId, input.companyId),
            eq(agentHarnessRevisions.agentId, input.agentId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!base) throw unprocessable("Base harness revision does not belong to the target agent");
      if (revisionGuidance(base) !== change.before) {
        throw conflict("Proposal before-guidance does not match the base revision");
      }

      const existing = await tx
        .select()
        .from(agentLearningProposals)
        .where(eq(agentLearningProposals.signalId, signal.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (existing && existing.status !== "review_needed") {
        if (
          existing.status === "proposed" &&
          existing.rationale === parsedInput.rationale &&
          harnessGuidanceChangeSchema.safeParse(existing.proposedChanges).success &&
          harnessContentHash(existing.proposedChanges as unknown as Record<string, unknown>) ===
            harnessContentHash(change as unknown as Record<string, unknown>)
        ) {
          return existing;
        }
        throw conflict("The attributed signal already has a governed proposal");
      }

      const actorType = input.actor.type;
      const actorId = input.actor.type === "user" ? input.actor.userId : input.actor.agentId;
      const values = {
        companyId: input.companyId,
        agentId: input.agentId,
        harnessRevisionId: base.id,
        signalId: signal.id,
        status: "proposed",
        proposalType: "role_guidance",
        rationale: parsedInput.rationale,
        riskLevel: "medium",
        confidence: 50,
        evidence: {
          signalId: signal.id,
          signalType: signal.signalType,
          outcome: signal.outcome,
          score: signal.score,
          maxScore: signal.maxScore,
        },
        validationPlan: {
          guidanceOnly: true,
          requiresHumanApproval: true,
          automaticPromotion: false,
        },
        proposedChanges: change,
        reviewedByAgentId: null,
        reviewedByUserId: null,
        reviewedAt: null,
        promotedByAgentId: null,
        promotedByUserId: null,
        promotedAt: null,
        resolvedAt: null,
        resolution: null,
        updatedAt: new Date(),
      } as const;
      const proposal = existing
        ? await tx
            .update(agentLearningProposals)
            .set(values)
            .where(eq(agentLearningProposals.id, existing.id))
            .returning()
            .then((rows) => rows[0]!)
        : await tx
            .insert(agentLearningProposals)
            .values(values)
            .returning()
            .then((rows) => rows[0]!);
      await writeActivity(store, {
        companyId: input.companyId,
        actorType,
        actorId,
        action: "agent_harness.guidance_proposed",
        proposalId: proposal.id,
        agentId: input.agentId,
        details: { signalId: signal.id, baseRevisionId: base.id },
      });
      return proposal;
    });
  }

  async function lockProposal(
    store: Db,
    proposalId: string,
    agentId: string,
    companyId: string,
  ) {
    const proposal = await store
      .select()
      .from(agentLearningProposals)
      .where(
        and(
          eq(agentLearningProposals.id, proposalId),
          eq(agentLearningProposals.agentId, agentId),
          eq(agentLearningProposals.companyId, companyId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!proposal) throw notFound("Harness proposal not found");
    return proposal;
  }

  async function reviewProposal(input: {
    companyId: string;
    agentId: string;
    proposalId: string;
    userId: string;
    decision: "approve" | "reject";
    reason?: string;
  }) {
    return db.transaction(async (tx) => {
      const store = tx as unknown as Db;
      const target = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Agent not found");
      const proposal = await lockProposal(store, input.proposalId, input.agentId, input.companyId);
      const desiredStatus: AgentHarnessProposalStatus =
        input.decision === "approve" ? "approved" : "rejected";
      if (proposal.status === desiredStatus) return proposal;
      if (proposal.status !== "proposed") {
        throw conflict(
          `Only proposed guidance can be ${input.decision === "approve" ? "approved" : "rejected"}`,
        );
      }
      if (proposal.harnessRevisionId) {
        const base = await tx
          .select({ id: agentHarnessRevisions.id })
          .from(agentHarnessRevisions)
          .where(eq(agentHarnessRevisions.id, proposal.harnessRevisionId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!base) throw conflict("Proposal base revision no longer exists");
      }
      const now = new Date();
      const updated = await tx
        .update(agentLearningProposals)
        .set({
          status: desiredStatus,
          reviewedByAgentId: null,
          reviewedByUserId: input.userId,
          reviewedAt: now,
          resolvedAt: input.decision === "reject" ? now : null,
          resolution:
            input.decision === "reject" ? { decision: "rejected", reason: input.reason } : null,
          updatedAt: now,
        })
        .where(eq(agentLearningProposals.id, proposal.id))
        .returning()
        .then((rows) => rows[0]!);
      await writeActivity(store, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.userId,
        action: `agent_harness.guidance_${input.decision === "approve" ? "approved" : "rejected"}`,
        proposalId: proposal.id,
        agentId: input.agentId,
        details: { baseRevisionId: proposal.harnessRevisionId, reason: input.reason },
      });
      return updated;
    });
  }

  async function promoteProposal(input: {
    companyId: string;
    agentId: string;
    proposalId: string;
    userId: string;
  }) {
    return db.transaction(async (tx) => {
      const store = tx as unknown as Db;
      const target = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Agent not found");
      const proposal = await lockProposal(store, input.proposalId, input.agentId, input.companyId);
      if (proposal.status === "promoted") return proposal;
      if (proposal.status !== "approved") throw conflict("Only approved guidance can be promoted");
      const parsed = harnessGuidanceChangeSchema.safeParse(proposal.proposedChanges);
      if (!parsed.success || proposal.harnessRevisionId !== parsed.data.baseRevisionId) {
        throw conflict("Proposal does not contain a valid guidance-only change");
      }
      const change = parsed.data;
      const base = await tx
        .select()
        .from(agentHarnessRevisions)
        .where(
          and(
            eq(agentHarnessRevisions.id, change.baseRevisionId),
            eq(agentHarnessRevisions.agentId, input.agentId),
            eq(agentHarnessRevisions.companyId, input.companyId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!base) throw conflict("Proposal base revision no longer exists");
      if (target.currentHarnessRevisionId !== base.id) {
        const superseded = await tx
          .update(agentLearningProposals)
          .set({
            status: "superseded",
            resolvedAt: new Date(),
            resolution: {
              decision: "superseded",
              reason: "stale_base_revision",
              currentRevisionId: target.currentHarnessRevisionId,
            },
            updatedAt: new Date(),
          })
          .where(eq(agentLearningProposals.id, proposal.id))
          .returning()
          .then((rows) => rows[0]!);
        await writeActivity(store, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.userId,
          action: "agent_harness.guidance_superseded",
          proposalId: proposal.id,
          agentId: input.agentId,
          details: { baseRevisionId: base.id, currentRevisionId: target.currentHarnessRevisionId },
        });
        return superseded;
      }
      if (revisionGuidance(base) !== change.before) {
        throw conflict("Proposal before-guidance no longer matches its base revision");
      }
      const snapshot = sorted({ ...base.snapshot, guidance: change.after }) as Record<
        string,
        unknown
      >;
      const counter = await tx
        .select({ value: max(agentHarnessRevisions.revisionNumber) })
        .from(agentHarnessRevisions)
        .where(eq(agentHarnessRevisions.agentId, input.agentId))
        .then((rows) => rows[0]?.value ?? 0);
      const revision = await tx
        .insert(agentHarnessRevisions)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          revisionNumber: counter + 1,
          contentHash: harnessContentHash(snapshot),
          snapshot,
          performanceSnapshot: base.performanceSnapshot,
          source: `guidance_proposal:${proposal.id}`,
        })
        .returning()
        .then((rows) => rows[0]!);
      const pointer = await tx
        .update(agents)
        .set({ currentHarnessRevisionId: revision.id, updatedAt: new Date() })
        .where(
          and(eq(agents.id, input.agentId), eq(agents.currentHarnessRevisionId, base.id)),
        )
        .returning({ id: agents.id });
      if (pointer.length !== 1) throw conflict("Harness revision changed during promotion");
      const now = new Date();
      const promoted = await tx
        .update(agentLearningProposals)
        .set({
          status: "promoted",
          promotedByAgentId: null,
          promotedByUserId: input.userId,
          promotedAt: now,
          resolvedAt: now,
          resolution: { decision: "promoted", promotedRevisionId: revision.id },
          updatedAt: now,
        })
        .where(eq(agentLearningProposals.id, proposal.id))
        .returning()
        .then((rows) => rows[0]!);
      await writeActivity(store, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.userId,
        action: "agent_harness.guidance_promoted",
        proposalId: proposal.id,
        agentId: input.agentId,
        details: { baseRevisionId: base.id, promotedRevisionId: revision.id },
      });
      return promoted;
    });
  }

  async function rollbackProposal(input: {
    companyId: string;
    agentId: string;
    proposalId: string;
    userId: string;
    reason?: string;
  }) {
    return db.transaction(async (tx) => {
      const store = tx as unknown as Db;
      const target = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Agent not found");
      const proposal = await lockProposal(store, input.proposalId, input.agentId, input.companyId);
      if (proposal.status === "rolled_back") return proposal;
      if (proposal.status !== "promoted") throw conflict("Only promoted guidance can be rolled back");
      const parsed = harnessGuidanceChangeSchema.safeParse(proposal.proposedChanges);
      if (!parsed.success) throw conflict("Proposal does not contain a valid guidance-only change");
      if (!target.currentHarnessRevisionId) throw conflict("Agent has no current harness revision");
      const current = await tx
        .select()
        .from(agentHarnessRevisions)
        .where(
          and(
            eq(agentHarnessRevisions.id, target.currentHarnessRevisionId),
            eq(agentHarnessRevisions.agentId, input.agentId),
            eq(agentHarnessRevisions.companyId, input.companyId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) throw conflict("Current harness revision no longer exists");
      if (revisionGuidance(current) !== parsed.data.after) {
        throw conflict("Current guidance no longer matches the promoted proposal");
      }
      const snapshot = sorted({ ...current.snapshot, guidance: parsed.data.before }) as Record<
        string,
        unknown
      >;
      const counter = await tx
        .select({ value: max(agentHarnessRevisions.revisionNumber) })
        .from(agentHarnessRevisions)
        .where(eq(agentHarnessRevisions.agentId, input.agentId))
        .then((rows) => rows[0]?.value ?? 0);
      const revision = await tx
        .insert(agentHarnessRevisions)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          revisionNumber: counter + 1,
          contentHash: harnessContentHash(snapshot),
          snapshot,
          performanceSnapshot: current.performanceSnapshot,
          source: `guidance_rollback:${proposal.id}`,
        })
        .returning()
        .then((rows) => rows[0]!);
      const pointer = await tx
        .update(agents)
        .set({ currentHarnessRevisionId: revision.id, updatedAt: new Date() })
        .where(
          and(
            eq(agents.id, input.agentId),
            eq(agents.currentHarnessRevisionId, current.id),
          ),
        )
        .returning({ id: agents.id });
      if (pointer.length !== 1) throw conflict("Harness revision changed during rollback");
      const priorResolution =
        proposal.resolution && typeof proposal.resolution === "object" ? proposal.resolution : {};
      const now = new Date();
      const rolledBack = await tx
        .update(agentLearningProposals)
        .set({
          status: "rolled_back",
          resolvedAt: now,
          resolution: {
            ...priorResolution,
            decision: "rolled_back",
            rollbackRevisionId: revision.id,
            rollbackReason: input.reason,
            rolledBackByUserId: input.userId,
          },
          updatedAt: now,
        })
        .where(eq(agentLearningProposals.id, proposal.id))
        .returning()
        .then((rows) => rows[0]!);
      await writeActivity(store, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.userId,
        action: "agent_harness.guidance_rolled_back",
        proposalId: proposal.id,
        agentId: input.agentId,
        details: { fromRevisionId: current.id, rollbackRevisionId: revision.id },
      });
      return rolledBack;
    });
  }

  return {
    ensureRevision,
    compactContext,
    currentSummaries,
    createGuidanceProposal,
    approveGuidanceProposal: (input: {
      companyId: string;
      agentId: string;
      proposalId: string;
      userId: string;
    }) => reviewProposal({ ...input, decision: "approve" }),
    rejectGuidanceProposal: (input: {
      companyId: string;
      agentId: string;
      proposalId: string;
      userId: string;
      reason: string;
    }) => reviewProposal({ ...input, decision: "reject" }),
    promoteGuidanceProposal: promoteProposal,
    rollbackGuidanceProposal: rollbackProposal,
    async current(agentId: string, companyId: string) {
      const row = await ensureRevision(agentId, companyId);
      return row ? summary(row) : null;
    },
    async revisions(agentId: string, companyId: string) {
      return db
        .select()
        .from(agentHarnessRevisions)
        .where(
          and(
            eq(agentHarnessRevisions.agentId, agentId),
            eq(agentHarnessRevisions.companyId, companyId),
          ),
        )
        .orderBy(desc(agentHarnessRevisions.revisionNumber));
    },
    async signals(agentId: string, companyId: string) {
      return db
        .select()
        .from(agentLearningSignals)
        .where(
          and(
            eq(agentLearningSignals.agentId, agentId),
            eq(agentLearningSignals.companyId, companyId),
          ),
        )
        .orderBy(desc(agentLearningSignals.createdAt));
    },
    async proposals(agentId: string, companyId: string) {
      return db
        .select()
        .from(agentLearningProposals)
        .where(
          and(
            eq(agentLearningProposals.agentId, agentId),
            eq(agentLearningProposals.companyId, companyId),
          ),
        )
        .orderBy(desc(agentLearningProposals.createdAt));
    },
  };
}

export function deriveHarnessPerformance(
  signals: Array<{ score: number | null; outcome: string }>,
) {
  const scored = signals.filter((item) => item.score != null);
  return {
    signalCount: signals.length,
    scoredSignalCount: scored.length,
    averageScore: scored.length
      ? scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length
      : null,
    changesRequestedCount: signals.filter((item) => item.outcome === "changes_requested").length,
    updatedAt: new Date().toISOString(),
  };
}

const LEARNING_SIGNAL_SOURCE_KEY = /^[a-z0-9][a-z0-9._:/-]*$/i;
const LEARNING_SIGNAL_KIND = /^[a-z][a-z0-9_.:-]*$/i;

export async function captureAttributedHarnessLearningSignal(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    sourceKey: string;
    signalType: string;
    outcome: string;
    body: string;
    score?: number | null;
    maxScore?: number | null;
    harnessRevisionId?: string | null;
    runId?: string | null;
    issueId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const sourceKey = input.sourceKey.trim();
  const signalType = input.signalType.trim();
  const outcome = input.outcome.trim();
  const body = input.body.trim();
  if (sourceKey.length < 1 || sourceKey.length > 256 || !LEARNING_SIGNAL_SOURCE_KEY.test(sourceKey)) {
    throw unprocessable("Learning signal sourceKey must be 1-256 URL-safe characters");
  }
  if (signalType.length < 1 || signalType.length > 64 || !LEARNING_SIGNAL_KIND.test(signalType)) {
    throw unprocessable("Learning signal type must be 1-64 bounded identifier characters");
  }
  if (outcome.length < 1 || outcome.length > 64 || !LEARNING_SIGNAL_KIND.test(outcome)) {
    throw unprocessable("Learning signal outcome must be 1-64 bounded identifier characters");
  }
  if (body.length < 1 || body.length > 4_000) {
    throw unprocessable("Learning signal body must be 1-4000 characters");
  }
  const score = input.score ?? null;
  const maxScore = input.maxScore ?? null;
  if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) {
    throw unprocessable("Learning signal score must be between 0 and 100");
  }
  if (maxScore != null && (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100)) {
    throw unprocessable("Learning signal maxScore must be greater than 0 and at most 100");
  }
  if (score != null && maxScore != null && score > maxScore) {
    throw unprocessable("Learning signal score cannot exceed maxScore");
  }
  const redactedMetadata = redactHarnessValue(input.metadata ?? {}) as Record<string, unknown>;
  if (JSON.stringify(redactedMetadata).length > 8_000) {
    throw unprocessable("Learning signal metadata must be at most 8000 serialized characters");
  }

  const service = agentHarnessService(db);
  const ensured = input.harnessRevisionId
    ? null
    : await service.ensureRevision(input.agentId, input.companyId);
  const requestedRevisionId = input.harnessRevisionId ?? ensured?.id ?? null;
  if (!requestedRevisionId) throw notFound("Agent harness revision not found");

  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Agent not found");
    const revision = await tx
      .select()
      .from(agentHarnessRevisions)
      .where(
        and(
          eq(agentHarnessRevisions.id, requestedRevisionId),
          eq(agentHarnessRevisions.agentId, input.agentId),
          eq(agentHarnessRevisions.companyId, input.companyId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!revision) throw unprocessable("Harness revision is not attributed to the target agent");
    if (input.issueId) {
      const issue = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw unprocessable("Learning signal issue is not in the target company");
    }
    if (input.runId) {
      const run = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!run) throw unprocessable("Learning signal run is not in the target company");
    }

    const existing = await tx
      .select()
      .from(agentLearningSignals)
      .where(
        and(
          eq(agentLearningSignals.companyId, input.companyId),
          eq(agentLearningSignals.agentId, input.agentId),
          eq(agentLearningSignals.sourceKey, sourceKey),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const desired = {
      harnessRevisionId: revision.id,
      issueId: input.issueId ?? null,
      runId: input.runId ?? null,
      sourceKey,
      signalType,
      outcome,
      score,
      maxScore,
      body,
      metadata: redactedMetadata,
    };
    if (existing) {
      const replay = Object.entries(desired).every(([key, value]) =>
        sameHarnessValue(existing[key as keyof typeof existing], value),
      );
      if (!replay) throw conflict("Learning signal sourceKey was replayed with different evidence");
      return existing;
    }

    const signal = await tx
      .insert(agentLearningSignals)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        ...desired,
      })
      .returning()
      .then((rows) => rows[0]!);
    const learning = revision.snapshot.learning as AgentHarnessLearningPolicy;
    const normalizedScore = score != null && maxScore ? (score / maxScore) * 10 : score;
    const requestsReview =
      ["changes_requested", "failed", "rejected"].includes(outcome) ||
      (normalizedScore != null && normalizedScore < learning.proposalScoreThreshold);
    if (requestsReview) {
      await tx
        .insert(agentLearningProposals)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          harnessRevisionId: revision.id,
          signalId: signal.id,
          status: "review_needed",
          proposalType: "review_needed",
          rationale: "An attributed pipeline signal requires human guidance review.",
          riskLevel: "medium",
          confidence: 50,
          evidence: { sourceKey, outcome, score, maxScore },
          validationPlan: {
            required: ["human-authored guidance proposal", "human approval"],
            noAutomaticMutation: true,
          },
          proposedChanges: {},
        })
        .onConflictDoNothing();
    }
    const allSignals = await tx
      .select({ score: agentLearningSignals.score, outcome: agentLearningSignals.outcome })
      .from(agentLearningSignals)
      .where(
        and(
          eq(agentLearningSignals.companyId, input.companyId),
          eq(agentLearningSignals.agentId, input.agentId),
          eq(agentLearningSignals.harnessRevisionId, revision.id),
        ),
      );
    await tx
      .update(agentHarnessRevisions)
      .set({ performanceSnapshot: deriveHarnessPerformance(allSignals) })
      .where(eq(agentHarnessRevisions.id, revision.id));
    return signal;
  });
}

export async function captureDecisionLearningSignal(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    decisionId: string;
    workerAgentId: string | null;
    outcome: string;
    score: number | null;
    maxScore: number | null;
    body: string;
    runId: string | null;
  },
) {
  if (!input.workerAgentId) return null;
  const service = agentHarnessService(db);
  const revision = await service.ensureRevision(input.workerAgentId, input.companyId);
  if (!revision) return null;
  const [signal] = await db
    .insert(agentLearningSignals)
    .values({
      companyId: input.companyId,
      agentId: input.workerAgentId,
      harnessRevisionId: revision.id,
      issueId: input.issueId,
      decisionId: input.decisionId,
      runId: input.runId,
      signalType: input.score == null ? "stage_decision" : "scored_stage_decision",
      outcome: input.outcome,
      score: input.score,
      maxScore: input.maxScore,
      body: input.body.slice(0, 4_000),
      metadata: { source: "execution_decision" },
    })
    .onConflictDoNothing()
    .returning();
  if (!signal) return null;
  const policy = revision.snapshot.learning as AgentHarnessLearningPolicy;
  const lowScore = input.score != null && input.score < policy.proposalScoreThreshold;
  if (input.outcome === "changes_requested" || lowScore)
    await db
      .insert(agentLearningProposals)
      .values({
        companyId: input.companyId,
        agentId: input.workerAgentId,
        harnessRevisionId: revision.id,
        signalId: signal.id,
        status: "review_needed",
        proposalType: "review_needed",
        rationale:
          input.outcome === "changes_requested"
            ? "A governed stage requested changes."
            : `Score ${input.score}/10 fell below ${policy.proposalScoreThreshold}.`,
        riskLevel: "medium",
        confidence: input.score == null ? 60 : Math.max(50, Math.round((10 - input.score) * 10)),
        evidence: {
          decisionId: input.decisionId,
          issueId: input.issueId,
          outcome: input.outcome,
          score: input.score,
        },
        validationPlan: {
          required: ["human-authored guidance proposal", "human approval"],
          noAutomaticMutation: true,
        },
        // A signal can request review, but it must never invent guidance or a
        // broader model/tool/skill/runtime/permission mutation.
        proposedChanges: {},
      })
      .onConflictDoNothing();
  const allSignals = await service.signals(input.workerAgentId, input.companyId);
  const performanceSnapshot = deriveHarnessPerformance(allSignals);
  // Performance is mutable derived telemetry; the governed configuration snapshot/hash remains immutable.
  await db
    .update(agentHarnessRevisions)
    .set({ performanceSnapshot })
    .where(
      and(
        eq(agentHarnessRevisions.id, revision.id),
        eq(agentHarnessRevisions.companyId, input.companyId),
      ),
    );
  return signal;
}
