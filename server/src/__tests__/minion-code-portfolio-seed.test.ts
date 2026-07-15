import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentHarnessRevisions,
  agents,
  companySecretBindings,
  companySecrets,
  companies,
  createDb,
  pipelines,
  portfolios,
  projects,
  projectWorkspaces,
} from '@paperclipai/db';
import { createPipelineSchema } from '@paperclipai/shared';
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from './helpers/embedded-postgres.js';
import {
  MINION_CODE_PROJECTS,
  seedMinionCodePortfolio,
} from '../services/minion-code-portfolio-seed.js';

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb('MINION Code portfolio seed', () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefix = 0;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase('paperclip-minion-code-seed-');
    db = createDb(temp.connectionString);
  }, 20_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function createCompany(name: string) {
    prefix += 1;
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `MCS${prefix}` })
      .returning();
    return company.id;
  }

  async function input(companyId: string) {
    const minionGatewayTokenSecretId = randomUUID();
    await db.insert(companySecrets).values({
      id: minionGatewayTokenSecretId,
      companyId,
      key: `minion-gateway-${minionGatewayTokenSecretId}`,
      name: `Minion gateway ${minionGatewayTokenSecretId}`,
    });
    return {
      companyId,
      planApproverUserId: 'board-plan-approver',
      releaseApproverUserId: 'board-release-approver',
      minionGatewayUrl: 'ws://127.0.0.1:18789',
      minionGatewayTokenSecretId,
      repositoryWorkspaces: repositoryWorkspaceInput(),
    };
  }

  function repositoryWorkspaceInput() {
    return {
      'minion-meta': {
        cwd: '/srv/minion/minion-meta',
        repoUrl: 'https://github.com/example/minion-meta.git',
        baseRef: 'origin/main',
        worktreeParentDir: '/srv/minion-worktrees/minion-meta',
      },
      'minion-ai': {
        cwd: '/srv/minion/minion-ai',
        repoUrl: 'https://github.com/example/minion-ai.git',
        baseRef: 'origin/main',
        worktreeParentDir: '/srv/minion-worktrees/minion-ai',
      },
      'minion-hub': {
        cwd: '/srv/minion/minion-hub',
        repoUrl: 'https://github.com/example/minion-hub.git',
        baseRef: 'origin/dev',
        worktreeParentDir: '/srv/minion-worktrees/minion-hub',
      },
      'minion-site': {
        cwd: '/srv/minion/minion-site',
        repoUrl: 'https://github.com/example/minion-site.git',
        baseRef: 'origin/main',
        worktreeParentDir: '/srv/minion-worktrees/minion-site',
      },
      paperclip: {
        cwd: '/srv/minion/paperclip',
        repoUrl: 'https://github.com/example/paperclip.git',
        baseRef: 'origin/main',
        worktreeParentDir: '/srv/minion-worktrees/paperclip',
      },
      'pixel-agents': {
        cwd: '/srv/minion/pixel-agents',
        repoUrl: 'https://github.com/example/pixel-agents.git',
        baseRef: 'origin/main',
        worktreeParentDir: '/srv/minion-worktrees/pixel-agents',
      },
      'minion-plugins': {
        cwd: '/srv/minion/minion-plugins',
        repoUrl: 'https://github.com/example/minion-plugins.git',
        baseRef: 'origin/main',
        worktreeParentDir: '/srv/minion-worktrees/minion-plugins',
      },
    };
  }

  it('fails closed when a repository workspace is not container-absolute', async () => {
    const companyId = await createCompany('MINION Invalid Workspace Co');
    const seedInput = await input(companyId);
    await expect(
      seedMinionCodePortfolio(db, {
        ...seedInput,
        repositoryWorkspaces: {
          ...seedInput.repositoryWorkspaces,
          'minion-hub': {
            ...seedInput.repositoryWorkspaces['minion-hub'],
            cwd: 'relative/minion-hub',
          },
        },
      }),
    ).rejects.toThrow('repository workspace minion-hub.cwd must be an absolute path');
  });

  it('previews without writes, applies the grouped portfolio, and reruns without reconciliation drift', async () => {
    const companyId = await createCompany('MINION Seed Co');
    const seedInput = await input(companyId);

    const preview = await seedMinionCodePortfolio(db, seedInput);
    expect(preview.applied).toBe(false);
    expect(preview.actions.every((action) => action.operation === 'create')).toBe(true);
    expect(await db.select().from(portfolios)).toHaveLength(0);
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(await db.select().from(projectWorkspaces)).toHaveLength(0);
    expect(await db.select().from(agents)).toHaveLength(0);
    expect(await db.select().from(pipelines)).toHaveLength(0);

    const applied = await seedMinionCodePortfolio(db, { ...seedInput, apply: true });
    expect(applied.applied).toBe(true);
    expect(Object.keys(applied.projectIds)).toHaveLength(MINION_CODE_PROJECTS.length);
    expect(Object.keys(applied.workspaceIds)).toHaveLength(MINION_CODE_PROJECTS.length - 1);
    expect(Object.keys(applied.agentIds)).toHaveLength(7);
    expect(Object.keys(applied.harnessRevisionIds)).toHaveLength(7);
    expect(applied.githubIntakeActivation).toMatchObject({
      pipelineId: applied.pipelineId,
      intakeProjectId: applied.intakeProjectId,
      classifierAgentId: applied.agentIds.classifier,
    });
    expect(JSON.parse(applied.githubIntakeActivation.routesJson)).toEqual(applied.routeRules);
    expect(applied.routeRules).toContainEqual({
      key: 'hub-ui',
      name: 'Hub UI',
      projectId: applied.projectIds['hub-ui'],
      group: 'minion_hub',
      repository: 'minion-hub',
      repositories: ['NikolasP98/minion_hub'],
      scopes: [],
      summary: 'Minion Hub application shell, pages, components, and user-facing behavior.',
    });
    expect(applied.routeRules).toContainEqual(
      expect.objectContaining({
        key: 'portfolio-intake',
        projectId: applied.intakeProjectId,
        repository: 'cross-repo',
        repositories: ['*'],
        scopes: [],
      }),
    );
    expect(new Set(applied.routeRules.map((rule) => rule.repository))).toEqual(
      new Set([
        'minion-meta',
        'minion-ai',
        'minion-hub',
        'minion-site',
        'paperclip',
        'pixel-agents',
        'minion-plugins',
        'cross-repo',
      ]),
    );
    expect(applied.deferred).toContain(
      'Hermes learning reviewer remains paused until a target-environment model probe succeeds.',
    );

    const [portfolioRows, projectRows, workspaceRows, agentRows, pipelineRows, harnessRows] =
      await Promise.all([
        db.select().from(portfolios),
        db.select().from(projects),
        db.select().from(projectWorkspaces),
        db.select().from(agents),
        db.select().from(pipelines),
        db.select().from(agentHarnessRevisions),
      ]);
    expect(portfolioRows).toHaveLength(1);
    expect(projectRows).toHaveLength(MINION_CODE_PROJECTS.length);
    expect(workspaceRows).toHaveLength(MINION_CODE_PROJECTS.length - 1);
    expect(agentRows).toHaveLength(7);
    expect(pipelineRows).toHaveLength(1);
    expect(harnessRows).toHaveLength(7);

    const secretBindings = await db.select().from(companySecretBindings);
    expect(secretBindings).toHaveLength(4);
    expect(
      secretBindings.map((binding) => ({
        targetId: binding.targetId,
        configPath: binding.configPath,
        secretId: binding.secretId,
      })),
    ).toEqual(
      expect.arrayContaining(
        (['classifier', 'planner', 'evaluator', 'merger'] as const).map((role) => ({
          targetId: applied.agentIds[role],
          configPath: 'env.MINION_GATEWAY_TOKEN',
          secretId: seedInput.minionGatewayTokenSecretId,
        })),
      ),
    );

    const intake = projectRows.find((project) => project.id === applied.intakeProjectId);
    expect(intake?.metadata).toMatchObject({
      minionSeedKey: 'minion-code:project:portfolio-intake',
      repositoryKey: 'cross-repo',
      groupKey: 'intake',
      routing: { intakeFallback: true },
    });
    const workforce = projectRows.find(
      (project) => project.metadata?.minionSeedKey === 'minion-code:project:workforce-projects',
    );
    expect(workforce).toMatchObject({
      portfolioId: applied.portfolioId,
      name: 'Workforce/Projects',
    });
    expect(workforce?.metadata).toMatchObject({
      repositoryKey: 'minion-hub',
      groupKey: 'minion_hub',
      routing: { scopes: ['workforce', 'core'] },
    });
    const workforceWorkspace = workspaceRows.find(
      (workspace) => workspace.id === applied.workspaceIds['workforce-projects'],
    );
    expect(workforceWorkspace).toMatchObject({
      projectId: applied.projectIds['workforce-projects'],
      sourceType: 'git_repo',
      cwd: '/srv/minion/minion-hub',
      repoRef: 'origin/dev',
      defaultRef: 'origin/dev',
      isPrimary: true,
    });
    expect(workforceWorkspace?.metadata).toMatchObject({
      minionSeedKey: 'minion-code:workspace:workforce-projects',
      repositoryKey: 'minion-hub',
    });
    expect(workforce?.executionWorkspacePolicy).toMatchObject({
      enabled: true,
      defaultMode: 'isolated_workspace',
      allowIssueOverride: false,
      defaultProjectWorkspaceId: workforceWorkspace?.id,
      workspaceStrategy: {
        type: 'git_worktree',
        baseRef: 'origin/dev',
        worktreeParentDir: '/srv/minion-worktrees/minion-hub',
      },
    });
    expect(intake?.executionWorkspacePolicy).toBeNull();

    const bySeedKey = new Map(
      agentRows.map((agent) => [String(agent.metadata?.minionSeedKey), agent]),
    );
    for (const role of ['classifier', 'planner', 'evaluator', 'merger'] as const) {
      const agent = bySeedKey.get(`minion-code:agent:${role}`);
      expect(agent?.adapterType).toBe('minion_drone');
      expect(agent?.adapterConfig).not.toHaveProperty('model');
      expect(agent?.adapterConfig).not.toHaveProperty('provider');
      expect(agent?.adapterConfig).not.toHaveProperty('prompt');
      expect(agent?.adapterConfig).toMatchObject({
        env: {
          MINION_GATEWAY_TOKEN: {
            type: 'secret_ref',
            secretId: seedInput.minionGatewayTokenSecretId,
          },
        },
      });
    }
    expect(bySeedKey.get('minion-code:agent:classifier')?.adapterConfig).toMatchObject({
      droneId: 'portfolio-issue-classifier-v1',
    });
    expect(bySeedKey.get('minion-code:agent:planner')?.adapterConfig).toMatchObject({
      droneId: 'portfolio-spec-planner-v1',
    });
    expect(bySeedKey.get('minion-code:agent:evaluator')?.adapterConfig).toMatchObject({
      droneId: 'portfolio-implementation-evaluator-v1',
    });
    expect(bySeedKey.get('minion-code:agent:merger')?.adapterConfig).toMatchObject({
      droneId: 'portfolio-merge-readiness-v1',
    });
    expect(bySeedKey.get('minion-code:agent:implementer')).toMatchObject({
      adapterType: 'opencode_local',
      adapterConfig: {
        model: 'openrouter/anthropic/claude-sonnet-5',
        provider: 'openrouter',
      },
    });
    expect(bySeedKey.get('minion-code:agent:monitor')).toMatchObject({
      adapterType: 'opencode_local',
      adapterConfig: { model: 'github-copilot/gpt-5.4-mini' },
    });
    expect(bySeedKey.get('minion-code:agent:learning-reviewer')).toMatchObject({
      adapterType: 'hermes_local',
      adapterConfig: {},
      status: 'paused',
      pauseReason: 'system',
    });

    const [pipeline] = pipelineRows;
    const parsed = createPipelineSchema.safeParse({
      name: pipeline.name,
      description: pipeline.description,
      projectId: pipeline.projectId,
      executionMode: pipeline.executionMode,
      trigger: pipeline.trigger,
      steps: pipeline.steps,
      sortOrder: pipeline.sortOrder,
    });
    expect(parsed.success).toBe(true);
    expect(pipeline.executionMode).toBe('stage_tasks');
    expect(pipeline.projectId).toBeNull();
    expect(pipeline.steps.map((step) => step.key)).toEqual([
      'plan',
      'plan-approval',
      'implement',
      'evaluate',
      'release-approval',
      'merge-readiness',
    ]);
    expect(pipeline.steps[3]).toMatchObject({
      kind: 'eval',
      minScore: 7,
      maxScore: 10,
      onFailStepKey: 'implement',
      maxAttempts: 3,
    });

    const rerun = await seedMinionCodePortfolio(db, { ...seedInput, apply: true });
    expect(rerun.actions.every((action) => action.operation === 'unchanged')).toBe(true);
    expect(await db.select().from(portfolios)).toHaveLength(1);
    expect(await db.select().from(projects)).toHaveLength(MINION_CODE_PROJECTS.length);
    expect(await db.select().from(projectWorkspaces)).toHaveLength(MINION_CODE_PROJECTS.length - 1);
    expect(await db.select().from(agents)).toHaveLength(7);
    expect(await db.select().from(pipelines)).toHaveLength(1);
    expect(await db.select().from(agentHarnessRevisions)).toHaveLength(7);
  });

  it('adopts the existing bug-fixer but creates a distinct independent evaluator', async () => {
    const companyId = await createCompany('MINION Adoption Co');
    const existingImplementerId = randomUUID();
    const existingReviewerId = randomUUID();
    const existingMonitorId = randomUUID();
    await db.insert(agents).values([
      {
        id: existingImplementerId,
        companyId,
        name: 'bug-fixer',
        role: 'engineer',
        adapterType: 'process',
        adapterConfig: { command: 'old-fixer' },
        runtimeConfig: {},
        permissions: { canCreateAgents: false },
      },
      {
        id: existingReviewerId,
        companyId,
        name: 'bug-reviewer',
        role: 'qa',
        adapterType: 'claude_local',
        adapterConfig: { model: 'reviewer-model' },
        runtimeConfig: {},
        permissions: { canCreateAgents: false },
      },
      {
        id: existingMonitorId,
        companyId,
        name: 'portfolio-monitor',
        role: 'pm',
        status: 'error',
        adapterType: 'claude_local',
        adapterConfig: { model: 'broken-monitor-model' },
        runtimeConfig: {},
        permissions: { canCreateAgents: false },
      },
    ]);

    const result = await seedMinionCodePortfolio(db, {
      ...(await input(companyId)),
      apply: true,
    });
    expect(result.agentIds.implementer).toBe(existingImplementerId);
    expect(result.agentIds.evaluator).not.toBe(existingImplementerId);
    expect(result.agentIds.evaluator).not.toBe(existingReviewerId);

    const companyAgents = await db.select().from(agents);
    const implementer = companyAgents.find((agent) => agent.id === existingImplementerId);
    const evaluator = companyAgents.find((agent) => agent.id === result.agentIds.evaluator);
    const reviewer = companyAgents.find((agent) => agent.id === existingReviewerId);
    const monitor = companyAgents.find((agent) => agent.id === existingMonitorId);
    expect(implementer).toMatchObject({
      name: 'bug-fixer',
      adapterType: 'opencode_local',
      adapterConfig: {
        model: 'openrouter/anthropic/claude-sonnet-5',
        provider: 'openrouter',
      },
    });
    expect(implementer?.metadata).toMatchObject({ minionSeedKey: 'minion-code:agent:implementer' });
    expect(evaluator).toMatchObject({
      name: 'code-evaluator',
      adapterType: 'minion_drone',
      adapterConfig: { droneId: 'portfolio-implementation-evaluator-v1' },
    });
    expect(reviewer).toMatchObject({
      name: 'bug-reviewer',
      adapterType: 'claude_local',
      adapterConfig: { model: 'reviewer-model' },
      metadata: null,
    });
    expect(monitor).toMatchObject({
      status: 'idle',
      adapterType: 'opencode_local',
      adapterConfig: { model: 'github-copilot/gpt-5.4-mini' },
    });
  });

  it('activates Hermes only when the operator supplies a probed model', async () => {
    const companyId = await createCompany('MINION Hermes Co');
    const result = await seedMinionCodePortfolio(db, {
      ...(await input(companyId)),
      probedHermesModel: 'mistralai/mistral-large-2512',
      apply: true,
    });
    const companyAgents = await db.select().from(agents);
    const reviewer = companyAgents.find(
      (agent) => agent.id === result.agentIds['learning-reviewer'],
    );
    expect(reviewer).toMatchObject({
      status: 'idle',
      adapterType: 'hermes_local',
      adapterConfig: { model: 'mistralai/mistral-large-2512' },
    });
    expect(reviewer?.metadata).toMatchObject({ activationState: 'operator_probed_model' });
  });
});
