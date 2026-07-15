export type AgentHarnessRoleKey =
  | "issue-classifier"
  | "spec-planner"
  | "implementer"
  | "evaluator"
  | "code-merger"
  | "portfolio-monitor"
  | "learning-reviewer"
  | "generic";
export type AgentHarnessProposalStatus =
  | "review_needed"
  | "proposed"
  | "approved"
  | "rejected"
  | "promoted"
  | "superseded"
  | "rolled_back";
export interface HarnessGuidanceChange {
  kind: "replace_role_guidance";
  baseRevisionId: string;
  before: string;
  after: string;
}
export interface AgentHarnessCapabilitySelection {
  tools: string[];
  skills: string[];
}
export interface HarnessCapabilitySelectionChange {
  kind: "replace_active_capabilities";
  baseRevisionId: string;
  before: AgentHarnessCapabilitySelection;
  after: AgentHarnessCapabilitySelection;
}
export type AgentHarnessProposalChange = HarnessGuidanceChange | HarnessCapabilitySelectionChange;
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
  /** Immutable operator-approved catalog for this revision. */
  tools: string[];
  skills: string[];
  /** Active policy selection; adapters remain the hard execution boundary. */
  activeCapabilities: AgentHarnessCapabilitySelection;
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
  guidance: string;
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
  sourceKey: string | null;
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
  status: AgentHarnessProposalStatus;
  proposalType: "role_guidance" | "active_capabilities" | "review_needed";
  rationale: string;
  riskLevel: string;
  confidence: number;
  evidence: Record<string, unknown>;
  validationPlan: Record<string, unknown>;
  proposedChanges: AgentHarnessProposalChange | Record<string, never>;
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
