import type { PipelineInboxTarget } from './pipeline.js';

export type FactoryIntakeState =
  | 'scouting'
  | 'awaiting_routing_approval'
  | 'pipeline_active'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface FactoryIntakeSource {
  kind: 'hub_assistant';
  route: string;
  selectedAgentId?: string;
}

export interface FactoryScoutWorkspaceRef {
  workspaceId: string;
  repoUrl: string;
  repoRef: string;
  defaultRef: string;
}

export interface FactoryScoutProjectEvidence {
  projectId: string;
  key: string;
  name: string;
  repositoryKey: string;
  groupKey: string;
  scopes: string[];
  pathPrefixes: string[];
  workspaceRefs: FactoryScoutWorkspaceRef[];
}

export interface FactoryScoutIssueEvidence {
  id: string;
  identifier: string;
  title: string;
  status: string;
  projectId: string;
  excerpt: string;
}

export interface FactoryScoutDocumentEvidence {
  id: string;
  title: string;
  projectId: string;
  issueId: string;
  excerpt: string;
}

/**
 * Bounded, company-local metadata collected before classification.
 *
 * `codeSearchExecuted` is deliberately false in the first vertical slice.
 * Workspace repository references make a future isolated read-only Codex scout
 * possible without pretending the control plane searched repository files.
 */
export interface FactoryScoutEvidence {
  mode: 'control_plane_metadata';
  codeSearchExecuted: false;
  projects: FactoryScoutProjectEvidence[];
  priorIssues: FactoryScoutIssueEvidence[];
  documents: FactoryScoutDocumentEvidence[];
  bounds: {
    maxProjects: number;
    maxWorkspaceRefsPerProject: number;
    maxPriorIssues: number;
    maxDocuments: number;
    maxExcerptChars: number;
  };
  pendingCapabilities: ['tool_bearing_code_search'];
}

export interface FactoryRoutingCandidate {
  projectId: string;
  key: string;
  name: string;
  repositoryKey: string;
  groupKey: string;
  confidence: number | null;
  reason: string;
}

export interface FactoryRoutingDecision {
  resolution: 'rule' | 'intake_fallback' | 'override' | 'unresolved';
  confidence: number | null;
  reason: string | null;
  candidates: FactoryRoutingCandidate[];
  newProjectProposal: {
    name: string;
    description: string;
  } | null;
}

export interface FactoryIntakeProjection {
  intake: {
    id: string;
    identifier: string | null;
    status: string;
    state: FactoryIntakeState;
    idempotentReplay: boolean;
  };
  rootIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  };
  portfolio: { id: string; name: string };
  project: { id: string; name: string } | null;
  routingDecision: FactoryRoutingDecision | null;
  routingTarget: PipelineInboxTarget;
  pipelineRun: {
    id: string;
    status: string;
    currentStepKey: string | null;
  } | null;
  scoutEvidence: FactoryScoutEvidence;
  links: {
    issueHref: string;
    statusHref: string;
    workHref: '/work';
  };
}
