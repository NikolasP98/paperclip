export const MINION_REPOSITORY_KEYS = [
  "minion-meta",
  "minion-ai",
  "minion-hub",
  "minion-site",
  "paperclip",
  "pixel-agents",
  "minion-plugins",
] as const;

export type MinionRepositoryKey = (typeof MINION_REPOSITORY_KEYS)[number];
export type RepositoryIssueWorkType = "bug" | "feature" | "remediation" | "chore" | "docs";
export type RepositoryIssueSeverity = "critical" | "high" | "medium" | "low";

export interface RepositoryIssueClassification {
  workType: RepositoryIssueWorkType;
  scopes: string[];
  affectedRepositories: MinionRepositoryKey[];
  affectedPaths: string[];
  severity: RepositoryIssueSeverity;
  riskLabels: string[];
  confidence: number;
  evidence: string[];
  needsHuman: boolean;
}

export interface ProjectRouteRule {
  key: string;
  projectId: string;
  repository: MinionRepositoryKey | "cross-repo";
  scopes?: string[];
  pathPrefixes?: string[];
}

export interface EvaluatedProjectRoute {
  ruleKey: string;
  projectId: string;
  precedence: "path" | "scope" | "repository_default" | "cross_repo";
  matchedPathPrefix: string | null;
  matchedScopes: string[];
}

export interface ProjectRouteDecision {
  projectId: string;
  reason:
    | "operator_override"
    | "path"
    | "scope"
    | "cross_repo"
    | "repository_default"
    | "low_confidence"
    | "ambiguous"
    | "unmatched";
  authoritativeRepository: MinionRepositoryKey;
  candidates: EvaluatedProjectRoute[];
  requiresHuman: boolean;
}

const REPOSITORY_ALIASES: Record<string, MinionRepositoryKey> = {
  "minion-meta": "minion-meta",
  minion: "minion-ai",
  "minion-ai": "minion-ai",
  minion_hub: "minion-hub",
  "minion-hub": "minion-hub",
  minion_site: "minion-site",
  "minion-site": "minion-site",
  paperclip: "paperclip",
  "paperclip-minion": "paperclip",
  "pixel-agents": "pixel-agents",
  minion_plugins: "minion-plugins",
  "minion-plugins": "minion-plugins",
};

export function repositoryKeyFromFullName(fullName: string): MinionRepositoryKey | null {
  const slug = fullName.trim().toLowerCase().split("/").at(-1) ?? "";
  return REPOSITORY_ALIASES[slug] ?? null;
}

function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function matchingPathPrefix(rule: ProjectRouteRule, affectedPaths: string[]) {
  let longest: string | null = null;
  for (const prefix of rule.pathPrefixes ?? []) {
    const normalizedPrefix = normalizePath(prefix).replace(/\/$/, "");
    if (!normalizedPrefix) continue;
    if (
      affectedPaths.some(
        (path) => normalizePath(path) === normalizedPrefix || normalizePath(path).startsWith(`${normalizedPrefix}/`),
      )
    ) {
      if (!longest || normalizedPrefix.length > longest.length) longest = normalizedPrefix;
    }
  }
  return longest;
}

function scopeMatches(rule: ProjectRouteRule, scopes: string[]) {
  const wanted = new Set(scopes.map((scope) => scope.toLowerCase()));
  return [...new Set((rule.scopes ?? []).map((scope) => scope.toLowerCase()).filter((scope) => wanted.has(scope)))];
}

function chooseUnique(
  candidates: EvaluatedProjectRoute[],
  intakeProjectId: string,
  repository: MinionRepositoryKey,
  ambiguousReason: ProjectRouteDecision["reason"],
): ProjectRouteDecision | null {
  if (candidates.length === 0) return null;
  const projectIds = [...new Set(candidates.map((candidate) => candidate.projectId))];
  if (projectIds.length === 1) {
    return {
      projectId: projectIds[0]!,
      reason: candidates[0]!.precedence,
      authoritativeRepository: repository,
      candidates,
      requiresHuman: false,
    };
  }
  return {
    projectId: intakeProjectId,
    reason: ambiguousReason,
    authoritativeRepository: repository,
    candidates,
    requiresHuman: true,
  };
}

export function resolveProjectRoute(input: {
  signedRepositoryFullName: string;
  classification: RepositoryIssueClassification;
  rules: ProjectRouteRule[];
  intakeProjectId: string;
  operatorProjectId?: string | null;
  minimumConfidence?: number;
}): ProjectRouteDecision {
  const repository = repositoryKeyFromFullName(input.signedRepositoryFullName);
  if (!repository) throw new Error(`Unsupported repository: ${input.signedRepositoryFullName}`);
  if (input.operatorProjectId) {
    return {
      projectId: input.operatorProjectId,
      reason: "operator_override",
      authoritativeRepository: repository,
      candidates: [],
      requiresHuman: false,
    };
  }
  if (input.classification.needsHuman || input.classification.confidence < (input.minimumConfidence ?? 0.7)) {
    return {
      projectId: input.intakeProjectId,
      reason: "low_confidence",
      authoritativeRepository: repository,
      candidates: [],
      requiresHuman: true,
    };
  }

  const isCrossRepo = input.classification.affectedRepositories.some((candidate) => candidate !== repository);
  const scopedRules = input.rules.filter(
    (rule) => rule.repository === repository || (isCrossRepo && rule.repository === "cross-repo"),
  );
  const pathCandidates = scopedRules
    .map((rule) => ({ rule, prefix: matchingPathPrefix(rule, input.classification.affectedPaths) }))
    .filter((value): value is { rule: ProjectRouteRule; prefix: string } => value.prefix !== null);
  const longestPath = Math.max(0, ...pathCandidates.map((candidate) => candidate.prefix.length));
  const pathDecision = chooseUnique(
    pathCandidates
      .filter((candidate) => candidate.prefix.length === longestPath)
      .map(({ rule, prefix }) => ({
        ruleKey: rule.key,
        projectId: rule.projectId,
        precedence: "path",
        matchedPathPrefix: prefix,
        matchedScopes: scopeMatches(rule, input.classification.scopes),
      })),
    input.intakeProjectId,
    repository,
    "ambiguous",
  );
  if (pathDecision) return pathDecision;

  if (isCrossRepo) {
    const crossRepoDecision = chooseUnique(
      scopedRules
        .filter((rule) => rule.repository === "cross-repo")
        .map((rule) => ({
          ruleKey: rule.key,
          projectId: rule.projectId,
          precedence: "cross_repo",
          matchedPathPrefix: null,
          matchedScopes: scopeMatches(rule, input.classification.scopes),
        })),
      input.intakeProjectId,
      repository,
      "ambiguous",
    );
    if (crossRepoDecision) return crossRepoDecision;
  }

  const scopeDecision = chooseUnique(
    scopedRules
      .map((rule) => ({ rule, scopes: scopeMatches(rule, input.classification.scopes) }))
      .filter((value) => value.scopes.length > 0)
      .map(({ rule, scopes }) => ({
        ruleKey: rule.key,
        projectId: rule.projectId,
        precedence: "scope",
        matchedPathPrefix: null,
        matchedScopes: scopes,
      })),
    input.intakeProjectId,
    repository,
    "ambiguous",
  );
  if (scopeDecision) return scopeDecision;

  const defaultDecision = chooseUnique(
    scopedRules
      .filter((rule) => rule.repository === repository && !rule.scopes?.length && !rule.pathPrefixes?.length)
      .map((rule) => ({
        ruleKey: rule.key,
        projectId: rule.projectId,
        precedence: "repository_default",
        matchedPathPrefix: null,
        matchedScopes: [],
      })),
    input.intakeProjectId,
    repository,
    "ambiguous",
  );
  return (
    defaultDecision ?? {
      projectId: input.intakeProjectId,
      reason: "unmatched",
      authoritativeRepository: repository,
      candidates: [],
      requiresHuman: true,
    }
  );
}

export function classificationLabels(repository: MinionRepositoryKey, classification: RepositoryIssueClassification) {
  return [
    ...new Set([
      `type:${classification.workType}`,
      `repo:${repository}`,
      `severity:${classification.severity}`,
      ...classification.scopes.map((scope) => `scope:${scope.toLowerCase()}`),
      ...classification.riskLabels.map((risk) => `risk:${risk.toLowerCase()}`),
      ...(classification.affectedRepositories.length > 1 ? ["route:cross-repo"] : []),
      ...(classification.needsHuman ? ["route:needs-human"] : []),
    ]),
  ];
}
