import { createHash } from "node:crypto";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import {
  agentHarnessRevisions,
  agentLearningProposals,
  agentLearningSignals,
  agents,
  type Db,
} from "@paperclipai/db";
import type {
  AgentHarnessLearningPolicy,
  AgentHarnessRoleKey,
  AgentHarnessRuntimePolicy,
  AgentHarnessSummary,
} from "@paperclipai/shared";

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
      "Fix the root cause with the smallest safe diff. Read prior feedback first, add focused regression coverage, run focused checks, push only the issue branch, and open a draft PR. Never merge or push a default branch.",
    evaluator:
      "Read-only evaluation: inspect the approved spec, implementation work product, diff, and focused checks. Do not edit or push. Apply the versioned rubric and submit status, findings, and typed evalScore together. A failing score creates a new implementation iteration rather than rewriting history.",
    "code-merger":
      "Validate merge readiness only after the release approval gate. Return the typed approved head SHA and merge strategy. Do not run git or GitHub mutations; the deterministic merge executor performs the merge.",
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
  return {
    agentId: row.agentId,
    revisionId: row.id,
    revisionNumber: row.revisionNumber,
    contentHash: row.contentHash,
    roleKey: snapshot.roleKey as AgentHarnessRoleKey,
    runtime: snapshot.runtime as AgentHarnessRuntimePolicy,
    learning: snapshot.learning as AgentHarnessLearningPolicy,
    performance: row.performanceSnapshot,
    createdAt: row.createdAt,
  };
}

export function agentHarnessService(db: Db) {
  async function ensureRevision(agentId: string, companyId?: string) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), ...(companyId ? [eq(agents.companyId, companyId)] : [])))
      .limit(1);
    if (!agent) return null;
    const policy = harnessPolicyPreset(agent);
    const snapshot = sorted({
      ...policy,
      observed: observedHarnessConfig(agent),
      capabilities: agent.capabilities,
    }) as Record<string, unknown>;
    const contentHash = harnessContentHash(snapshot);
    const [same] = await db
      .select()
      .from(agentHarnessRevisions)
      .where(
        and(
          eq(agentHarnessRevisions.agentId, agent.id),
          eq(agentHarnessRevisions.contentHash, contentHash),
        ),
      )
      .limit(1);
    if (same) {
      if (agent.currentHarnessRevisionId !== same.id)
        await db
          .update(agents)
          .set({ currentHarnessRevisionId: same.id })
          .where(eq(agents.id, agent.id));
      return same;
    }
    const [counter] = await db
      .select({ value: max(agentHarnessRevisions.revisionNumber) })
      .from(agentHarnessRevisions)
      .where(eq(agentHarnessRevisions.agentId, agent.id));
    const [created] = await db
      .insert(agentHarnessRevisions)
      .values({
        companyId: agent.companyId,
        agentId: agent.id,
        revisionNumber: (counter?.value ?? 0) + 1,
        contentHash,
        snapshot,
      })
      .returning();
    await db
      .update(agents)
      .set({ currentHarnessRevisionId: created.id })
      .where(eq(agents.id, agent.id));
    return created;
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
      guidance: guidanceForRole(roleKey),
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
  return {
    ensureRevision,
    compactContext,
    currentSummaries,
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
        proposalType: "harness_improvement",
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
          required: ["focused regression test", "independent evaluator score at or above floor"],
          noAutomaticMutation: true,
        },
        proposedChanges: {
          targets: ["instructions", "skills", "routing"],
          action: "review_required",
        },
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
