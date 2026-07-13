import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { agents, companies, pipelines, portfolios, projects, type Db } from '@paperclipai/db';
import {
  createPipelineSchema,
  isUuidLike,
  type PipelineStep,
  type ProjectMetadata,
} from '@paperclipai/shared';
import { MINION_DRONE_IDS, type MinionDroneId } from '@paperclipai/adapter-minion-drone';
import { agentHarnessService } from './agent-harness.js';
import { normalizeAgentPermissions } from './agent-permissions.js';
import { agentService } from './agents.js';

export const MINION_CODE_SEED_VERSION = 1;
export const MINION_CODE_PORTFOLIO_SEED_KEY = 'minion-code:portfolio';
export const MINION_CODE_PIPELINE_NAME = 'MINION Code Delivery';

export const MINION_CODE_GROUPS = [
  { key: 'minion_hub', repositoryKey: 'minion-hub', label: 'Minion Hub' },
  { key: 'minion', repositoryKey: 'minion-ai', label: 'Minion Gateway' },
  { key: 'minion_site', repositoryKey: 'minion-site', label: 'Minion Site' },
  { key: 'paperclip-minion', repositoryKey: 'paperclip', label: 'Paperclip Minion' },
  { key: 'minion_plugins', repositoryKey: 'minion-plugins', label: 'Minion Plugins' },
  { key: 'pixel-agents', repositoryKey: 'pixel-agents', label: 'Pixel Agents' },
  { key: 'meta', repositoryKey: 'minion-meta', label: 'MINION Meta' },
] as const;

interface ProjectSeedDefinition {
  key: string;
  name: string;
  description: string;
  groupKey: string;
  repositoryKey: string;
  scopes: string[];
  pathPrefixes: string[];
  isRepositoryDefault?: boolean;
  intakeFallback?: boolean;
}

export const MINION_CODE_PROJECTS: readonly ProjectSeedDefinition[] = [
  {
    key: 'portfolio-intake',
    name: 'Portfolio Intake',
    description:
      'Human routing fallback for ambiguous, unsupported, or low-confidence repository work.',
    groupKey: 'intake',
    repositoryKey: 'cross-repo',
    scopes: [],
    pathPrefixes: [],
    intakeFallback: true,
  },
  {
    key: 'hub-ui',
    name: 'Hub UI',
    description: 'Minion Hub application shell, pages, components, and user-facing behavior.',
    groupKey: 'minion_hub',
    repositoryKey: 'minion-hub',
    scopes: ['ui'],
    pathPrefixes: ['src/lib/components', 'src/routes/(app)'],
    isRepositoryDefault: true,
  },
  {
    key: 'workforce-projects',
    name: 'Workforce/Projects',
    description:
      'Workforce, portfolio, project, pipeline, and agent orchestration surfaces in Minion Hub.',
    groupKey: 'minion_hub',
    repositoryKey: 'minion-hub',
    scopes: ['workforce', 'core'],
    pathPrefixes: ['src/routes/(app)/workforce', 'src/lib/workforce', 'src/lib/projects'],
  },
  {
    key: 'hub-auth',
    name: 'Hub Auth',
    description: 'Authentication, account, session, and access flows owned by Minion Hub.',
    groupKey: 'minion_hub',
    repositoryKey: 'minion-hub',
    scopes: ['auth'],
    pathPrefixes: ['src/lib/auth', 'src/routes/api/auth', 'src/routes/(auth)'],
  },
  {
    key: 'hub-data-db',
    name: 'Hub Data/DB',
    description: 'Hub persistence, shared database schema, migrations, and data services.',
    groupKey: 'minion_hub',
    repositoryKey: 'minion-hub',
    scopes: ['data'],
    pathPrefixes: ['src/server/db', 'src/lib/server/db', 'drizzle'],
  },
  {
    key: 'gateway-core',
    name: 'Gateway Core',
    description: 'Core gateway dispatch, routing, sessions, and protocol behavior.',
    groupKey: 'minion',
    repositoryKey: 'minion-ai',
    scopes: ['gateway', 'core'],
    pathPrefixes: ['src/gateway', 'src/dispatch', 'src/routing', 'src/sessions'],
    isRepositoryDefault: true,
  },
  {
    key: 'gateway-auth-security',
    name: 'Gateway Auth/Security',
    description: 'Gateway authentication, authorization, credentials, and security controls.',
    groupKey: 'minion',
    repositoryKey: 'minion-ai',
    scopes: ['auth'],
    pathPrefixes: ['src/auth', 'src/security'],
  },
  {
    key: 'channels',
    name: 'Channels',
    description: 'Messaging channel integrations and shared channel runtime behavior.',
    groupKey: 'minion',
    repositoryKey: 'minion-ai',
    scopes: ['plugins'],
    pathPrefixes: ['src/channels', 'extensions'],
  },
  {
    key: 'shared-runtime',
    name: 'Shared Runtime',
    description:
      'Shared agent, tool, configuration, event, and runtime primitives in the gateway repository.',
    groupKey: 'minion',
    repositoryKey: 'minion-ai',
    scopes: ['core'],
    pathPrefixes: ['src/agents', 'src/tools', 'src/config', 'src/events', 'packages'],
  },
  {
    key: 'site-marketing',
    name: 'Site/Marketing',
    description: 'Public Minion site, marketing pages, localization, and acquisition surfaces.',
    groupKey: 'minion_site',
    repositoryKey: 'minion-site',
    scopes: ['ui'],
    pathPrefixes: ['src/routes/(marketing)', 'src/lib/components'],
    isRepositoryDefault: true,
  },
  {
    key: 'members-auth',
    name: 'Members/Auth',
    description: 'Members dashboard, shared identity, account, and authentication flows.',
    groupKey: 'minion_site',
    repositoryKey: 'minion-site',
    scopes: ['auth'],
    pathPrefixes: ['src/routes/(app)', 'src/lib/auth'],
  },
  {
    key: 'control-plane',
    name: 'Control Plane',
    description: 'Paperclip company, agent, project, issue, governance, and board primitives.',
    groupKey: 'paperclip-minion',
    repositoryKey: 'paperclip',
    scopes: ['core', 'workforce'],
    pathPrefixes: ['server/src/routes', 'server/src/services', 'ui/src/pages'],
    isRepositoryDefault: true,
  },
  {
    key: 'adapters-runtimes',
    name: 'Adapters/Runtimes',
    description:
      'Paperclip execution adapters, runtime environments, heartbeats, and workspace execution.',
    groupKey: 'paperclip-minion',
    repositoryKey: 'paperclip',
    scopes: ['plugins', 'ops'],
    pathPrefixes: ['packages/adapters', 'packages/adapter-utils', 'server/src/adapters'],
  },
  {
    key: 'pipeline-traceability',
    name: 'Pipeline/Traceability',
    description:
      'Stage-task workflows, routing evidence, decisions, and end-to-end task traceability.',
    groupKey: 'paperclip-minion',
    repositoryKey: 'paperclip',
    scopes: ['workforce', 'data'],
    pathPrefixes: ['server/src/services/issue-pipeline', 'packages/db/src/schema/issue_pipelines'],
  },
  {
    key: 'plugin-platform',
    name: 'Plugin Platform',
    description: 'Minion plugin marketplace, plugin packaging, and reusable extension platform.',
    groupKey: 'minion_plugins',
    repositoryKey: 'minion-plugins',
    scopes: ['plugins'],
    pathPrefixes: ['plugins', '.claude-plugin'],
    isRepositoryDefault: true,
  },
  {
    key: 'crm',
    name: 'CRM',
    description: 'Customer relationship workflows and CRM-specific Minion plugins.',
    groupKey: 'minion_plugins',
    repositoryKey: 'minion-plugins',
    scopes: ['crm'],
    pathPrefixes: ['plugins/crm', 'crm'],
  },
  {
    key: 'extension-runtime',
    name: 'Extension Runtime',
    description:
      'VS Code extension lifecycle, terminal integration, transcript parsing, and agent management.',
    groupKey: 'pixel-agents',
    repositoryKey: 'pixel-agents',
    scopes: ['core'],
    pathPrefixes: ['src'],
    isRepositoryDefault: true,
  },
  {
    key: 'pixel-office-ui',
    name: 'Pixel Office UI',
    description: 'Pixel office rendering, editor, characters, sprites, and webview interactions.',
    groupKey: 'pixel-agents',
    repositoryKey: 'pixel-agents',
    scopes: ['ui'],
    pathPrefixes: ['webview-ui/src'],
  },
  {
    key: 'shared-packages',
    name: 'Shared Packages',
    description:
      'Cross-repository @minion-stack packages and shared protocol/database/auth contracts.',
    groupKey: 'meta',
    repositoryKey: 'minion-meta',
    scopes: ['core'],
    pathPrefixes: ['packages'],
    isRepositoryDefault: true,
  },
  {
    key: 'specs-docs',
    name: 'Specs/Docs',
    description:
      'MINION architecture specifications, agent registry, product documentation, and plans.',
    groupKey: 'meta',
    repositoryKey: 'minion-meta',
    scopes: ['docs'],
    pathPrefixes: ['specs', 'docs'],
  },
  {
    key: 'ci-release-operations',
    name: 'CI/Release/Operations',
    description: 'Meta-repository CI, deployment, release automation, and operational tooling.',
    groupKey: 'meta',
    repositoryKey: 'minion-meta',
    scopes: ['ops'],
    pathPrefixes: ['.github', 'scripts', 'deploy'],
  },
] as const;

export type MinionCodeAgentRoleKey =
  | 'classifier'
  | 'planner'
  | 'implementer'
  | 'evaluator'
  | 'merger'
  | 'monitor'
  | 'learning-reviewer';

interface AgentSeedDefinition {
  key: MinionCodeAgentRoleKey;
  name: string;
  aliases: string[];
  role: typeof agents.$inferInsert.role;
  title: string;
  capabilities: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  status: typeof agents.$inferInsert.status;
  metadata: Record<string, unknown>;
}

export interface SeedMinionCodePortfolioInput {
  companyId: string;
  planApproverUserId: string;
  releaseApproverUserId?: string;
  minionGatewayUrl: string;
  minionGatewayTokenSecretId: string;
  /** An operator-provided model id that has already passed the target-environment probe. */
  probedHermesModel?: string | null;
  apply?: boolean;
}

export type MinionCodeSeedResourceType = 'portfolio' | 'project' | 'agent' | 'pipeline';
export type MinionCodeSeedOperation = 'create' | 'update' | 'unchanged';

export interface MinionCodeSeedAction {
  resourceType: MinionCodeSeedResourceType;
  key: string;
  id: string;
  operation: MinionCodeSeedOperation;
  changedFields: string[];
}

export interface MinionCodeRouteRule {
  key: string;
  name: string;
  projectId: string;
  group?: string;
  repository:
    | 'minion-meta'
    | 'minion-ai'
    | 'minion-hub'
    | 'minion-site'
    | 'paperclip'
    | 'pixel-agents'
    | 'minion-plugins'
    | 'cross-repo';
  repositories: string[];
  scopes: string[];
  pathPrefixes?: string[];
  summary?: string;
}

export interface SeedMinionCodePortfolioResult {
  applied: boolean;
  portfolioId: string;
  intakeProjectId: string;
  projectIds: Record<string, string>;
  agentIds: Record<MinionCodeAgentRoleKey, string>;
  pipelineId: string;
  routeRules: MinionCodeRouteRule[];
  githubIntakeActivation: {
    pipelineId: string;
    intakeProjectId: string;
    classifierAgentId: string;
    routesJson: string;
  };
  actions: MinionCodeSeedAction[];
  harnessRevisionIds: Partial<Record<MinionCodeAgentRoleKey, string>>;
  deferred: string[];
}

function stableSeedId(companyId: string, resourceKey: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`paperclip:minion-code:${companyId}:${resourceKey}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function changedFields(
  existing: Record<string, unknown> | null,
  desired: Record<string, unknown>,
): string[] {
  if (!existing) return Object.keys(desired);
  return Object.entries(desired).flatMap(([key, value]) =>
    same(existing[key], value) ? [] : [key],
  );
}

function seedAction(
  resourceType: MinionCodeSeedResourceType,
  key: string,
  id: string,
  existing: Record<string, unknown> | null,
  desired: Record<string, unknown>,
): MinionCodeSeedAction {
  const fields = changedFields(existing, desired);
  return {
    resourceType,
    key,
    id,
    operation: !existing ? 'create' : fields.length > 0 ? 'update' : 'unchanged',
    changedFields: fields,
  };
}

function validateGatewayInput(input: SeedMinionCodePortfolioInput) {
  if (!isUuidLike(input.companyId)) throw new Error('companyId must be a UUID');
  if (!input.planApproverUserId.trim()) throw new Error('planApproverUserId is required');
  if (!(input.releaseApproverUserId ?? input.planApproverUserId).trim()) {
    throw new Error('releaseApproverUserId is required');
  }
  if (!isUuidLike(input.minionGatewayTokenSecretId)) {
    throw new Error('minionGatewayTokenSecretId must be a company secret UUID');
  }
  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(input.minionGatewayUrl);
  } catch {
    throw new Error('minionGatewayUrl must be a valid URL');
  }
  if (gatewayUrl.protocol !== 'ws:' && gatewayUrl.protocol !== 'wss:') {
    throw new Error('minionGatewayUrl must use ws:// or wss://');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    gatewayUrl.hostname.toLowerCase(),
  );
  if (gatewayUrl.protocol === 'ws:' && !loopback) {
    throw new Error('Remote minion gateways must use wss://');
  }
  return gatewayUrl.toString();
}

function droneConfig(
  droneId: MinionDroneId,
  gatewayUrl: string,
  gatewayTokenSecretId: string,
): Record<string, unknown> {
  if (!(MINION_DRONE_IDS as readonly string[]).includes(droneId)) {
    throw new Error(`Unsupported Minion drone id: ${droneId}`);
  }
  return {
    droneId,
    env: {
      MINION_GATEWAY_URL: { type: 'plain', value: gatewayUrl },
      MINION_GATEWAY_TOKEN: {
        type: 'secret_ref',
        secretId: gatewayTokenSecretId,
        version: 'latest',
      },
    },
  };
}

function buildAgentDefinitions(
  input: SeedMinionCodePortfolioInput,
  gatewayUrl: string,
): AgentSeedDefinition[] {
  const deferredHermes = !input.probedHermesModel?.trim();
  const baseMetadata = (roleKey: MinionCodeAgentRoleKey) => ({
    minionSeedKey: `minion-code:agent:${roleKey}`,
    minionSeedVersion: MINION_CODE_SEED_VERSION,
    harnessRoleKey: roleKey,
  });
  return [
    {
      key: 'classifier',
      name: 'issue-classifier',
      aliases: ['issue-classifier', 'triage-router'],
      role: 'general',
      title: 'Repository Issue Classifier',
      capabilities:
        'Returns bounded repository issue taxonomy only; deterministic services own labels and routing.',
      adapterType: 'minion_drone',
      adapterConfig: droneConfig(
        'portfolio-issue-classifier-v1',
        gatewayUrl,
        input.minionGatewayTokenSecretId,
      ),
      status: 'idle',
      metadata: baseMetadata('classifier'),
    },
    {
      key: 'planner',
      name: 'spec-planner',
      aliases: ['spec-planner', 'spec-writer'],
      role: 'pm',
      title: 'Implementation Spec Planner',
      capabilities:
        'Produces bounded implementation specs and accepted-plan child-work proposals without editing code.',
      adapterType: 'minion_drone',
      adapterConfig: droneConfig(
        'portfolio-spec-planner-v1',
        gatewayUrl,
        input.minionGatewayTokenSecretId,
      ),
      status: 'idle',
      metadata: baseMetadata('planner'),
    },
    {
      key: 'implementer',
      name: 'bug-fixer',
      aliases: ['bug-fixer', 'implementer'],
      role: 'engineer',
      title: 'Issue Implementer',
      capabilities:
        'Implements approved specs in isolated workspaces, verifies the fix, and opens draft pull requests without merging.',
      adapterType: 'opencode_local',
      adapterConfig: {
        model: 'github-copilot/claude-sonnet-5',
        dangerouslySkipPermissions: true,
      },
      status: 'idle',
      metadata: baseMetadata('implementer'),
    },
    {
      key: 'evaluator',
      name: 'code-evaluator',
      aliases: ['code-evaluator', 'implementation-evaluator'],
      role: 'qa',
      title: 'Independent Implementation Evaluator',
      capabilities:
        'Evaluates approved-spec compliance and regression evidence with a versioned rubric; never edits or pushes code.',
      adapterType: 'codex_local',
      adapterConfig: {
        model: 'gpt-5.4',
        modelReasoningEffort: 'high',
        dangerouslyBypassApprovalsAndSandbox: false,
      },
      status: 'idle',
      metadata: baseMetadata('evaluator'),
    },
    {
      key: 'merger',
      name: 'merge-readiness',
      aliases: ['merge-readiness', 'code-merger'],
      role: 'devops',
      title: 'Merge Readiness Validator',
      capabilities:
        'Validates approved head SHA and merge strategy after release approval; deterministic code performs the merge.',
      adapterType: 'minion_drone',
      adapterConfig: droneConfig(
        'portfolio-merge-readiness-v1',
        gatewayUrl,
        input.minionGatewayTokenSecretId,
      ),
      status: 'idle',
      metadata: baseMetadata('merger'),
    },
    {
      key: 'monitor',
      name: 'portfolio-monitor',
      aliases: ['portfolio-monitor'],
      role: 'pm',
      title: 'Portfolio Monitor',
      capabilities:
        'Performs bounded read-only portfolio monitoring and proposes deduplicated remediation work.',
      adapterType: 'opencode_local',
      adapterConfig: {
        model: 'github-copilot/gpt-5.4-mini',
        dangerouslySkipPermissions: false,
      },
      status: 'idle',
      metadata: {
        ...baseMetadata('monitor'),
        activationState: 'executable_fallback',
        deferredDroneReason: 'portfolio-monitor drone is not allowlisted',
      },
    },
    {
      key: 'learning-reviewer',
      name: 'learning-reviewer',
      aliases: ['learning-reviewer', 'hermes-curator'],
      role: 'researcher',
      title: 'Harness Learning Proposal Reviewer',
      capabilities:
        'Curates evidence-backed memory, skill, instruction, or routing proposals without self-promotion.',
      adapterType: 'hermes_local',
      adapterConfig: deferredHermes ? {} : { model: input.probedHermesModel!.trim() },
      status: deferredHermes ? 'paused' : 'idle',
      metadata: {
        ...baseMetadata('learning-reviewer'),
        activationState: deferredHermes ? 'deferred_model_probe' : 'operator_probed_model',
      },
    },
  ];
}

function buildProjectMetadata(
  definition: ProjectSeedDefinition,
  existing: unknown,
): ProjectMetadata {
  return {
    ...asRecord(existing),
    minionSeedKey: `minion-code:project:${definition.key}`,
    minionSeedVersion: MINION_CODE_SEED_VERSION,
    repositoryKey: definition.repositoryKey,
    groupKey: definition.groupKey,
    routing: {
      scopes: definition.scopes,
      pathPrefixes: definition.pathPrefixes,
      isRepositoryDefault: definition.isRepositoryDefault ?? false,
      intakeFallback: definition.intakeFallback ?? false,
    },
  };
}

function findBySeedKey<T extends { metadata: unknown }>(rows: T[], seedKey: string): T | undefined {
  return rows.find((row) => asRecord(row.metadata).minionSeedKey === seedKey);
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

const REPOSITORY_FULL_NAMES: Record<
  Exclude<MinionCodeRouteRule['repository'], 'cross-repo'>,
  string[]
> = {
  'minion-meta': ['NikolasP98/minion-meta'],
  'minion-ai': ['NikolasP98/minion-ai'],
  'minion-hub': ['NikolasP98/minion_hub'],
  'minion-site': ['NikolasP98/minion-site'],
  paperclip: ['NikolasP98/paperclip', 'paperclipai/paperclip'],
  'pixel-agents': ['pablodelucca/pixel-agents'],
  'minion-plugins': ['NikolasP98/minion_plugins'],
};

export async function seedMinionCodePortfolio(
  db: Db,
  input: SeedMinionCodePortfolioInput,
): Promise<SeedMinionCodePortfolioResult> {
  const gatewayUrl = validateGatewayInput(input);
  const releaseApproverUserId = input.releaseApproverUserId ?? input.planApproverUserId;
  const apply = input.apply === true;

  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!company) throw new Error(`Company not found: ${input.companyId}`);

  const [existingPortfolios, existingProjects, existingAgents, existingPipelines] =
    await Promise.all([
      db.select().from(portfolios).where(eq(portfolios.companyId, input.companyId)),
      db.select().from(projects).where(eq(projects.companyId, input.companyId)),
      db.select().from(agents).where(eq(agents.companyId, input.companyId)),
      db
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.companyId, input.companyId), isNull(pipelines.projectId))),
    ]);

  const activeAgents = existingAgents.filter((agent) => agent.status !== 'terminated');
  const agentDefinitions = buildAgentDefinitions(input, gatewayUrl);
  const agentPlans = agentDefinitions.map((definition) => {
    const seedKey = `minion-code:agent:${definition.key}`;
    const existing =
      findBySeedKey(activeAgents, seedKey) ??
      activeAgents.find((agent) =>
        definition.aliases.some((alias) => normalizedName(alias) === normalizedName(agent.name)),
      );
    const id = existing?.id ?? stableSeedId(input.companyId, seedKey);
    const metadata = { ...asRecord(existing?.metadata), ...definition.metadata };
    const desired = {
      name: existing?.name ?? definition.name,
      role: definition.role,
      title: definition.title,
      capabilities: definition.capabilities,
      adapterType: definition.adapterType,
      adapterConfig: definition.adapterConfig,
      runtimeConfig: {
        ...asRecord(existing?.runtimeConfig),
        heartbeat: { enabled: false, maxConcurrentRuns: 1 },
      },
      permissions: normalizeAgentPermissions(existing?.permissions, definition.role ?? 'general'),
      metadata,
      ...(!existing ? { status: definition.status } : {}),
      ...(definition.key === 'learning-reviewer' && !input.probedHermesModel?.trim()
        ? { status: 'paused', pauseReason: 'system' }
        : {}),
      ...(definition.key === 'monitor' && existing?.status === 'error'
        ? { status: 'idle', pauseReason: null, pausedAt: null }
        : {}),
    } satisfies Record<string, unknown>;
    return { definition, existing, id, desired };
  });
  const agentIds = Object.fromEntries(
    agentPlans.map((plan) => [plan.definition.key, plan.id]),
  ) as Record<MinionCodeAgentRoleKey, string>;

  const portfolioExisting =
    findBySeedKey(existingPortfolios, MINION_CODE_PORTFOLIO_SEED_KEY) ??
    existingPortfolios.find(
      (portfolio) => normalizedName(portfolio.name) === normalizedName('MINION Code'),
    );
  const portfolioId =
    portfolioExisting?.id ?? stableSeedId(input.companyId, MINION_CODE_PORTFOLIO_SEED_KEY);
  const portfolioMetadata = {
    ...asRecord(portfolioExisting?.metadata),
    minionSeedKey: MINION_CODE_PORTFOLIO_SEED_KEY,
    minionSeedVersion: MINION_CODE_SEED_VERSION,
    groupPresentation: MINION_CODE_GROUPS,
  };
  const portfolioDesired = {
    name: portfolioExisting?.name ?? 'MINION Code',
    objective:
      portfolioExisting?.objective ??
      'Trace repository work from intake through governed delivery.',
    guardrails:
      portfolioExisting?.guardrails ??
      'Models propose classification, plans, scores, and merge readiness; deterministic services own routing, task creation, and merge execution.',
    charter:
      portfolioExisting?.charter ??
      'Every repository issue remains the parent task. Pipeline stages are blocker-linked child tasks with human approval before implementation and release.',
    status: 'active',
    leadAgentId: agentIds.monitor,
    metadata: portfolioMetadata,
  } satisfies Record<string, unknown>;

  const projectPlans = MINION_CODE_PROJECTS.map((definition) => {
    const seedKey = `minion-code:project:${definition.key}`;
    const existing =
      findBySeedKey(existingProjects, seedKey) ??
      existingProjects.find(
        (project) =>
          project.portfolioId === portfolioId &&
          normalizedName(project.name) === normalizedName(definition.name),
      );
    const id = existing?.id ?? stableSeedId(input.companyId, seedKey);
    const desired = {
      portfolioId,
      name: existing?.name ?? definition.name,
      description: existing?.description ?? definition.description,
      status: existing?.status ?? 'in_progress',
      metadata: buildProjectMetadata(definition, existing?.metadata),
    } satisfies Record<string, unknown>;
    return { definition, existing, id, desired };
  });
  const projectIds = Object.fromEntries(projectPlans.map((plan) => [plan.definition.key, plan.id]));
  const routeRules: MinionCodeRouteRule[] = projectPlans.map((plan) => {
    if (plan.definition.intakeFallback || plan.definition.repositoryKey === 'cross-repo') {
      return {
        key: plan.definition.key,
        name: plan.definition.name,
        projectId: plan.id,
        group: plan.definition.groupKey,
        repository: 'cross-repo',
        repositories: ['*'],
        scopes: [],
        summary: plan.definition.description,
      };
    }
    const repository = plan.definition.repositoryKey as Exclude<
      MinionCodeRouteRule['repository'],
      'cross-repo'
    >;
    return {
      key: plan.definition.key,
      name: plan.definition.name,
      projectId: plan.id,
      group: plan.definition.groupKey,
      repository,
      repositories: REPOSITORY_FULL_NAMES[repository],
      // A default rule must have no constraints so deterministic routing can
      // use it when the classifier abstains from a narrower concern.
      scopes: plan.definition.isRepositoryDefault ? [] : plan.definition.scopes,
      ...(!plan.definition.isRepositoryDefault && plan.definition.pathPrefixes.length > 0
        ? { pathPrefixes: plan.definition.pathPrefixes }
        : {}),
      summary: plan.definition.description,
    };
  });

  const pipelineExisting = existingPipelines.find(
    (pipeline) => normalizedName(pipeline.name) === normalizedName(MINION_CODE_PIPELINE_NAME),
  );
  const pipelineId =
    pipelineExisting?.id ?? stableSeedId(input.companyId, 'minion-code:pipeline:delivery');
  const pipelineSteps: PipelineStep[] = [
    {
      key: 'plan',
      kind: 'work',
      label: 'Plan',
      participant: { type: 'agent', agentId: agentIds.planner },
    },
    {
      key: 'plan-approval',
      kind: 'approval',
      label: 'Plan approval',
      participant: { type: 'user', userId: input.planApproverUserId },
      onFailStepKey: 'plan',
      maxAttempts: 3,
    },
    {
      key: 'implement',
      kind: 'work',
      label: 'Implement',
      participant: { type: 'agent', agentId: agentIds.implementer },
    },
    {
      key: 'evaluate',
      kind: 'eval',
      label: 'Evaluate',
      participant: { type: 'agent', agentId: agentIds.evaluator },
      rubric:
        'Score root-cause correctness, approved-spec coverage, regression protection, verification evidence, and repository safety. Include criterion-level findings and an aggregate score.',
      minScore: 7,
      maxScore: 10,
      onFailStepKey: 'implement',
      maxAttempts: 3,
    },
    {
      key: 'release-approval',
      kind: 'approval',
      label: 'Release approval',
      participant: { type: 'user', userId: releaseApproverUserId },
      onFailStepKey: 'implement',
      maxAttempts: 3,
    },
    {
      key: 'merge-readiness',
      kind: 'work',
      label: 'Merge readiness',
      participant: { type: 'agent', agentId: agentIds.merger },
    },
  ];
  const parsedPipeline = createPipelineSchema.parse({
    name: MINION_CODE_PIPELINE_NAME,
    description:
      'Shared governed delivery pipeline. Repository classification and deterministic project routing occur before this pipeline starts.',
    projectId: null,
    executionMode: 'stage_tasks',
    trigger: { originKinds: ['github_issue'] },
    steps: pipelineSteps,
    sortOrder: 0,
  });
  const pipelineDesired = {
    projectId: null,
    name: parsedPipeline.name,
    description: parsedPipeline.description ?? null,
    executionMode: parsedPipeline.executionMode,
    trigger: parsedPipeline.trigger ?? null,
    steps: parsedPipeline.steps,
    sortOrder: parsedPipeline.sortOrder ?? 0,
    archivedAt: null,
  } satisfies Record<string, unknown>;

  const actions: MinionCodeSeedAction[] = [
    ...agentPlans.map((plan) =>
      seedAction(
        'agent',
        plan.definition.key,
        plan.id,
        plan.existing as Record<string, unknown> | null,
        plan.desired,
      ),
    ),
    seedAction(
      'portfolio',
      'portfolio',
      portfolioId,
      portfolioExisting as Record<string, unknown> | null,
      portfolioDesired,
    ),
    ...projectPlans.map((plan) =>
      seedAction(
        'project',
        plan.definition.key,
        plan.id,
        plan.existing as Record<string, unknown> | null,
        plan.desired,
      ),
    ),
    seedAction(
      'pipeline',
      'delivery',
      pipelineId,
      pipelineExisting as Record<string, unknown> | null,
      pipelineDesired,
    ),
  ];

  if (apply) {
    const operationFor = (resourceType: MinionCodeSeedResourceType, key: string) =>
      actions.find((action) => action.resourceType === resourceType && action.key === key)
        ?.operation;
    await db.transaction(async (tx) => {
      for (const plan of agentPlans) {
        if (operationFor('agent', plan.definition.key) === 'unchanged') continue;
        await tx
          .insert(agents)
          .values({
            id: plan.id,
            companyId: input.companyId,
            ...plan.desired,
          } as typeof agents.$inferInsert)
          .onConflictDoUpdate({
            target: agents.id,
            set: { ...plan.desired, updatedAt: new Date() } as Partial<typeof agents.$inferInsert>,
          });
      }

      if (operationFor('portfolio', 'portfolio') !== 'unchanged') {
        await tx
          .insert(portfolios)
          .values({
            id: portfolioId,
            companyId: input.companyId,
            ...portfolioDesired,
          } as typeof portfolios.$inferInsert)
          .onConflictDoUpdate({
            target: portfolios.id,
            set: { ...portfolioDesired, updatedAt: new Date() } as Partial<
              typeof portfolios.$inferInsert
            >,
          });
      }

      for (const plan of projectPlans) {
        if (operationFor('project', plan.definition.key) === 'unchanged') continue;
        await tx
          .insert(projects)
          .values({
            id: plan.id,
            companyId: input.companyId,
            ...plan.desired,
          } as typeof projects.$inferInsert)
          .onConflictDoUpdate({
            target: projects.id,
            set: { ...plan.desired, updatedAt: new Date() } as Partial<
              typeof projects.$inferInsert
            >,
          });
      }

      if (operationFor('pipeline', 'delivery') !== 'unchanged') {
        await tx
          .insert(pipelines)
          .values({
            id: pipelineId,
            companyId: input.companyId,
            ...pipelineDesired,
            steps: parsedPipeline.steps as unknown as Array<Record<string, unknown>>,
          } as typeof pipelines.$inferInsert)
          .onConflictDoUpdate({
            target: pipelines.id,
            set: {
              ...pipelineDesired,
              steps: parsedPipeline.steps as unknown as Array<Record<string, unknown>>,
              updatedAt: new Date(),
            } as Partial<typeof pipelines.$inferInsert>,
          });
      }
    });
  }

  const harnessRevisionIds: Partial<Record<MinionCodeAgentRoleKey, string>> = {};
  if (apply) {
    const agentsService = agentService(db);
    const harnesses = agentHarnessService(db);
    for (const plan of agentPlans) {
      await agentsService.invalidate(plan.id, input.companyId);
      const revision = await harnesses.ensureRevision(plan.id, input.companyId);
      if (revision) harnessRevisionIds[plan.definition.key] = revision.id;
    }
  }

  return {
    applied: apply,
    portfolioId,
    intakeProjectId: projectIds['portfolio-intake']!,
    projectIds,
    agentIds,
    pipelineId,
    routeRules,
    githubIntakeActivation: {
      pipelineId,
      intakeProjectId: projectIds['portfolio-intake']!,
      classifierAgentId: agentIds.classifier,
      routesJson: JSON.stringify(routeRules),
    },
    actions,
    harnessRevisionIds,
    deferred: input.probedHermesModel?.trim()
      ? ['Deterministic merge execution is intentionally not part of this seed.']
      : [
          'Hermes learning reviewer remains paused until a target-environment model probe succeeds.',
          'Deterministic merge execution is intentionally not part of this seed.',
        ],
  };
}
