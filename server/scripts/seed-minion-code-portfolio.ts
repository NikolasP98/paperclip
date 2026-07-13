#!/usr/bin/env tsx
import { createDb } from '@paperclipai/db';
import { seedMinionCodePortfolio } from '../src/services/minion-code-portfolio-seed.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function required(name: string, envName?: string): string {
  const value = option(name) ?? (envName ? process.env[envName] : undefined);
  if (!value?.trim()) {
    throw new Error(`${name} is required${envName ? ` (or ${envName})` : ''}`);
  }
  return value.trim();
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage:
  pnpm seed:minion-code -- \\
    --company-id <uuid> \\
    --plan-approver-user-id <user-id> \\
    [--release-approver-user-id <user-id>] \\
    --gateway-url <ws-or-wss-url> \\
    --gateway-token-secret-id <company-secret-uuid> \\
    [--probed-hermes-model <model-id>] \\
    [--apply] [--json]

Dry-run is the default. The gateway token must already exist as a company
secret; this command never accepts or persists its plaintext value. Use --json
to emit pipelineId, intakeProjectId, and deterministic route rules for intake.`);
    return;
  }

  const databaseUrl = required('DATABASE_URL', 'DATABASE_URL');
  const db = createDb(databaseUrl);
  const result = await seedMinionCodePortfolio(db, {
    companyId: required('--company-id', 'PAPERCLIP_COMPANY_ID'),
    planApproverUserId: required('--plan-approver-user-id', 'MINION_CODE_PLAN_APPROVER_USER_ID'),
    releaseApproverUserId:
      option('--release-approver-user-id') ?? process.env.MINION_CODE_RELEASE_APPROVER_USER_ID,
    minionGatewayUrl: required('--gateway-url', 'MINION_GATEWAY_URL'),
    minionGatewayTokenSecretId: required(
      '--gateway-token-secret-id',
      'MINION_GATEWAY_TOKEN_SECRET_ID',
    ),
    probedHermesModel:
      option('--probed-hermes-model') ?? process.env.MINION_CODE_PROBED_HERMES_MODEL,
    apply: process.argv.includes('--apply'),
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    result.applied ? 'Applied MINION Code seed.' : 'MINION Code seed preview (no writes).',
  );
  for (const action of result.actions) {
    const fields = action.changedFields.length > 0 ? ` [${action.changedFields.join(', ')}]` : '';
    console.log(
      `${action.operation.padEnd(9)} ${action.resourceType.padEnd(9)} ${action.key}${fields}`,
    );
  }
  console.log(`GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID=${result.githubIntakeActivation.pipelineId}`);
  console.log(`GITHUB_BUGS_INTAKE_PROJECT_ID=${result.githubIntakeActivation.intakeProjectId}`);
  console.log(`GITHUB_BUGS_CLASSIFIER_AGENT_ID=${result.githubIntakeActivation.classifierAgentId}`);
  console.log(`GITHUB_BUGS_STAGE_TASK_ROUTES_JSON=${result.githubIntakeActivation.routesJson}`);
  for (const deferred of result.deferred) console.log(`deferred  ${deferred}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
