export type AgentHarnessRoleKey =
  | "issue-classifier"
  | "spec-planner"
  | "implementer"
  | "evaluator"
  | "code-merger"
  | "portfolio-monitor"
  | "learning-reviewer"
  | "generic";
export interface AgentHarnessRuntimeSelection {
  runtimeKind: string;
  adapterType: string | null;
  model: string | null;
  provider: string | null;
  executable: boolean;
  bridgePending?: boolean;
}
export interface AgentHarnessRuntimePolicy {
  runtimeClass: "coding" | "evaluation" | "monitoring" | "general";
  active: { primary: AgentHarnessRuntimeSelection; fallbacks: AgentHarnessRuntimeSelection[] };
  recommended: {
    primary: AgentHarnessRuntimeSelection;
    fallbacks: AgentHarnessRuntimeSelection[];
    canaries: AgentHarnessRuntimeSelection[];
  };
  tools: string[];
  skills: string[];
  objectives: {
    scoreFloor: number;
    maxLatencyMs: number;
    maxFallbackRate: number;
    maxCostPerAcceptedOutcomeCents: number;
  };
}
export interface AgentHarnessLearningPolicy {
  proposalScoreThreshold: number;
  minimumSignals: number;
  recentSignalLimit: number;
  recentSignalChars: number;
}
export interface AgentHarnessSummary {
  agentId: string;
  revisionId: string;
  revisionNumber: number;
  contentHash: string;
  roleKey: AgentHarnessRoleKey;
  runtime: AgentHarnessRuntimePolicy;
  learning: AgentHarnessLearningPolicy;
  performance: Record<string, unknown>;
  createdAt: Date | string;
}
export interface AgentHarnessRevision extends AgentHarnessSummary {
  companyId: string;
  snapshot: Record<string, unknown>;
  source: string;
}
export interface AgentLearningSignal {
  id: string;
  companyId: string;
  agentId: string;
  harnessRevisionId: string | null;
  issueId: string | null;
  decisionId: string | null;
  runId: string | null;
  signalType: string;
  outcome: string;
  score: number | null;
  maxScore: number | null;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
}
export interface AgentLearningProposal {
  id: string;
  companyId: string;
  agentId: string;
  harnessRevisionId: string | null;
  signalId: string;
  status: string;
  proposalType: string;
  rationale: string;
  riskLevel: string;
  confidence: number;
  evidence: Record<string, unknown>;
  validationPlan: Record<string, unknown>;
  proposedChanges: Record<string, unknown>;
  reviewedByAgentId: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | string | null;
  promotedByAgentId: string | null;
  promotedByUserId: string | null;
  promotedAt: Date | string | null;
  resolvedAt: Date | string | null;
  resolution: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}
