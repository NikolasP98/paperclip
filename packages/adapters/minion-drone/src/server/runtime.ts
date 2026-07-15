import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterModel,
  AdapterConfigSchema,
} from '@paperclipai/adapter-utils';
import { MINION_DRONE_IDS } from '../index.js';
import { parseMinionDroneConfig, readDroneInput } from './config.js';
import { createGatewayClient } from './gateway.js';
import type {
  ActiveDroneExecution,
  CancelResponse,
  CapabilitiesResponse,
  DroneCapability,
  ExecuteResponse,
  GatewayClientFactory,
  ModelCache,
  ProbeResponse,
} from './types.js';

const activeExecutions = new Map<string, ActiveDroneExecution>();
const modelCache: ModelCache = { models: [] };

export type MinionDroneRuntimeDependencies = {
  createClient?: GatewayClientFactory;
  activeRuns?: Map<string, ActiveDroneExecution>;
  discoveredModels?: ModelCache;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function capabilityModels(capability: DroneCapability): AdapterModel[] {
  return [
    { provider: capability.provider, model: capability.model },
    ...(Array.isArray(capability.fallbackModels) ? capability.fallbackModels : []),
  ]
    .filter((entry) => nonEmpty(entry.provider) && nonEmpty(entry.model))
    .map((entry) => ({
      id: `${entry.provider}/${entry.model}`,
      label: `${entry.provider} · ${entry.model}`,
    }));
}

function mergeModels(cache: ModelCache, models: AdapterModel[]) {
  const merged = new Map(cache.models.map((model) => [model.id, model]));
  for (const model of models) merged.set(model.id, model);
  cache.models = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function selectedCapability(
  response: CapabilitiesResponse,
  droneId: string,
): DroneCapability | null {
  if (response.contractVersion !== 1 || !Array.isArray(response.drones)) return null;
  const capability = response.drones.find((entry) => entry.id === droneId);
  if (
    !capability ||
    capability.executable !== true ||
    capability.availability !== 'probe_required' ||
    capability.sideEffects !== 'none'
  ) {
    return null;
  }
  return capability;
}

function selectedProbe(response: ProbeResponse, droneId: string) {
  if (response.contractVersion !== 1 || !Array.isArray(response.drones)) return null;
  return response.drones.find((entry) => entry.droneId === droneId) ?? null;
}

function usageFrom(response: ExecuteResponse): AdapterExecutionResult['usage'] {
  const inputTokens = positiveNumber(response.usage?.inputTokens);
  const outputTokens = positiveNumber(response.usage?.outputTokens);
  if (inputTokens === null || outputTokens === null) return undefined;
  const cachedInputTokens = positiveNumber(response.usage?.cachedInputTokens);
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

function resolvedModel(
  response: ExecuteResponse,
  probe: NonNullable<ReturnType<typeof selectedProbe>>,
) {
  const record = asRecord(response.resolvedModel);
  return {
    provider: nonEmpty(record?.provider) ?? nonEmpty(probe.resolvedProvider),
    model: nonEmpty(record?.model) ?? nonEmpty(probe.resolvedModel),
  };
}

function outputSummary(output: unknown): string | null {
  const record = asRecord(output);
  if (!record) return null;
  for (const key of ['summary', 'rationale', 'objective', 'recommendation']) {
    const value = nonEmpty(record[key]);
    if (value) return value.slice(0, 4_000);
  }
  return null;
}

function outputForLog(output: unknown): string {
  const serialized = JSON.stringify(output ?? null);
  return serialized.length <= 48_000 ? serialized : `${serialized.slice(0, 48_000)}…[truncated]`;
}

function configFailure(
  result: Extract<ReturnType<typeof parseMinionDroneConfig>, { ok: false }>,
): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: result.code,
    errorMessage: result.message,
  };
}

export function createExecute(dependencies: MinionDroneRuntimeDependencies = {}) {
  const factory = dependencies.createClient ?? createGatewayClient;
  const runs = dependencies.activeRuns ?? activeExecutions;
  const cache = dependencies.discoveredModels ?? modelCache;

  return async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const parsed = parseMinionDroneConfig(ctx.config);
    if (!parsed.ok) return configFailure(parsed);

    const input = readDroneInput(ctx.context);
    if (!input) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: 'minion_drone_input_missing',
        errorMessage: 'minion_drone requires context.paperclipDrone.input',
      };
    }

    const active: ActiveDroneExecution = {
      client: null,
      cancelRequested: false,
      executeStarted: false,
    };
    if (runs.has(ctx.runId)) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: 'minion_drone_run_conflict',
        errorMessage: `minion_drone run is already active: ${ctx.runId}`,
      };
    }
    runs.set(ctx.runId, active);

    const client = factory(parsed.config);
    active.client = client;
    try {
      await ctx.onMeta?.({
        adapterType: 'minion_drone',
        command: 'minion-gateway',
        commandArgs: ['drones.execute', parsed.config.droneId],
        context: { runId: ctx.runId, droneId: parsed.config.droneId },
      });
      await ctx.onLog(
        'stdout',
        `[minion-drone] connecting drone=${parsed.config.droneId} run=${ctx.runId}\n`,
      );
      await client.connect();

      const capabilities = await client.request<CapabilitiesResponse>(
        'drones.capabilities',
        { droneIds: [parsed.config.droneId] },
        { timeoutMs: 10_000 },
      );
      const capability = selectedCapability(capabilities, parsed.config.droneId);
      if (!capability) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: 'minion_drone_capability_unavailable',
          errorMessage: `Gateway did not advertise a safe executable capability for ${parsed.config.droneId}`,
        };
      }
      mergeModels(cache, capabilityModels(capability));

      const probeResponse = await client.request<ProbeResponse>(
        'drones.probe',
        { droneIds: [parsed.config.droneId] },
        { timeoutMs: 15_000 },
      );
      const probe = selectedProbe(probeResponse, parsed.config.droneId);
      if (!probe?.ready) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: 'minion_drone_probe_not_ready',
          errorMessage: `Gateway probe is not ready for ${parsed.config.droneId}${probe?.errorCode ? ` (${probe.errorCode})` : ''}`,
          resultJson: {
            droneId: parsed.config.droneId,
            probe: probe ? { ready: false, errorCode: probe.errorCode ?? null } : null,
          },
        };
      }

      if (probe.resolvedProvider && probe.resolvedModel) {
        mergeModels(cache, [
          {
            id: `${probe.resolvedProvider}/${probe.resolvedModel}`,
            label: `${probe.resolvedProvider} · ${probe.resolvedModel}`,
          },
        ]);
      }

      if (active.cancelRequested) {
        return {
          exitCode: 130,
          signal: 'SIGTERM',
          timedOut: false,
          errorCode: 'minion_drone_cancelled',
          errorMessage: 'Minion Drone run cancelled before execution',
        };
      }

      active.executeStarted = true;
      const capabilityTimeoutMs = positiveNumber(capability.timeoutMs) ?? 120_000;
      const requestTimeoutMs = Math.max(15_000, Math.min(capabilityTimeoutMs + 15_000, 180_000));
      const response = await client.request<ExecuteResponse>(
        'drones.execute',
        { runId: ctx.runId, droneId: parsed.config.droneId, input },
        { timeoutMs: requestTimeoutMs },
      );
      const durationMs = positiveNumber(response.durationMs);
      const model = resolvedModel(response, probe);
      const resultJson = {
        runId: response.runId,
        droneId: response.droneId,
        status: response.status,
        output: response.output ?? null,
        usage: response.usage ?? null,
        durationMs,
        resolvedModel: {
          provider: model.provider,
          model: model.model,
        },
        ...(response.error ? { error: response.error } : {}),
      };

      await ctx.onLog(
        response.status === 'completed' ? 'stdout' : 'stderr',
        `[minion-drone] ${response.status} drone=${parsed.config.droneId} durationMs=${durationMs ?? 0}\n`,
      );
      if (response.output !== undefined) {
        await ctx.onLog('stdout', `[minion-drone:output] ${outputForLog(response.output)}\n`);
      }

      if (response.status === 'cancelled') {
        return {
          exitCode: 130,
          signal: 'SIGTERM',
          timedOut: false,
          errorCode: 'minion_drone_cancelled',
          errorMessage: response.error?.message ?? 'Minion Drone run cancelled',
          provider: model.provider,
          model: model.model,
          usage: usageFrom(response),
          durationMs,
          resultJson,
        };
      }
      if (response.status !== 'completed') {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: nonEmpty(response.error?.code) ?? 'minion_drone_failed',
          errorMessage: nonEmpty(response.error?.message) ?? 'Minion Drone execution failed',
          provider: model.provider,
          model: model.model,
          usage: usageFrom(response),
          durationMs,
          resultJson,
        };
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: model.provider,
        model: model.model,
        usage: usageFrom(response),
        durationMs,
        resultJson,
        summary: outputSummary(response.output),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = message.toLowerCase().includes('timed out');
      if (timedOut && active.executeStarted) {
        try {
          await client.request<CancelResponse>(
            'drones.cancel',
            { runId: ctx.runId },
            { timeoutMs: 10_000 },
          );
        } catch {
          // Best effort: the gateway connection may be the reason the run timed out.
        }
      }
      await ctx.onLog('stderr', `[minion-drone] gateway request failed: ${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut,
        errorCode: timedOut ? 'minion_drone_timeout' : 'minion_drone_gateway_error',
        errorMessage: message,
      };
    } finally {
      if (runs.get(ctx.runId) === active) runs.delete(ctx.runId);
      client.close();
    }
  };
}

export function createCancelRun(dependencies: MinionDroneRuntimeDependencies = {}) {
  const runs = dependencies.activeRuns ?? activeExecutions;
  return async function cancelRun(runId: string): Promise<void> {
    const active = runs.get(runId);
    if (!active) return;
    active.cancelRequested = true;
    if (!active.client || !active.executeStarted) return;
    await active.client.request<CancelResponse>('drones.cancel', { runId }, { timeoutMs: 10_000 });
  };
}

function statusFromChecks(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult['status'] {
  if (checks.some((check) => check.level === 'error')) return 'fail';
  if (checks.some((check) => check.level === 'warn')) return 'warn';
  return 'pass';
}

export function createTestEnvironment(dependencies: MinionDroneRuntimeDependencies = {}) {
  const factory = dependencies.createClient ?? createGatewayClient;
  const cache = dependencies.discoveredModels ?? modelCache;
  return async function testEnvironment(
    ctx: AdapterEnvironmentTestContext,
  ): Promise<AdapterEnvironmentTestResult> {
    const checks: AdapterEnvironmentCheck[] = [];
    const parsed = parseMinionDroneConfig(ctx.config);
    if (!parsed.ok) {
      checks.push({ code: parsed.code, level: 'error', message: parsed.message });
      return {
        adapterType: 'minion_drone',
        status: 'fail',
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    const client = factory(parsed.config);
    try {
      await client.connect();
      checks.push({
        code: 'minion_drone_gateway_connected',
        level: 'info',
        message: 'Authenticated Minion gateway connection succeeded',
      });
      const capabilities = await client.request<CapabilitiesResponse>(
        'drones.capabilities',
        { droneIds: [parsed.config.droneId] },
        { timeoutMs: 10_000 },
      );
      const capability = selectedCapability(capabilities, parsed.config.droneId);
      if (!capability) {
        checks.push({
          code: 'minion_drone_capability_unavailable',
          level: 'error',
          message: `Gateway does not advertise the safe ${parsed.config.droneId} capability`,
        });
      } else {
        mergeModels(cache, capabilityModels(capability));
        checks.push({
          code: 'minion_drone_capability_available',
          level: 'info',
          message: `Gateway advertises ${parsed.config.droneId} with no side effects`,
          detail: `${capability.provider}/${capability.model}`,
        });
      }

      if (capability) {
        const probeResponse = await client.request<ProbeResponse>(
          'drones.probe',
          { droneIds: [parsed.config.droneId] },
          { timeoutMs: 15_000 },
        );
        const probe = selectedProbe(probeResponse, parsed.config.droneId);
        if (!probe?.ready) {
          checks.push({
            code: 'minion_drone_probe_not_ready',
            level: 'error',
            message: `Gateway model probe is not ready for ${parsed.config.droneId}`,
            detail: probe?.errorCode ?? null,
          });
        } else {
          if (probe.resolvedProvider && probe.resolvedModel) {
            mergeModels(cache, [
              {
                id: `${probe.resolvedProvider}/${probe.resolvedModel}`,
                label: `${probe.resolvedProvider} · ${probe.resolvedModel}`,
              },
            ]);
          }
          checks.push({
            code: 'minion_drone_probe_ready',
            level: 'info',
            message: `Gateway model probe is ready for ${parsed.config.droneId}`,
            detail:
              probe.resolvedProvider && probe.resolvedModel
                ? `${probe.resolvedProvider}/${probe.resolvedModel}`
                : null,
          });
        }
      }
    } catch (error) {
      checks.push({
        code: 'minion_drone_gateway_error',
        level: 'error',
        message: 'Minion gateway capability probe failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client.close();
    }

    return {
      adapterType: 'minion_drone',
      status: statusFromChecks(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  };
}

export function listModels(): AdapterModel[] {
  return [...modelCache.models];
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: 'droneId',
        label: 'Bounded drone',
        type: 'select',
        required: true,
        options: MINION_DRONE_IDS.map((droneId) => ({ value: droneId, label: droneId })),
        hint: "The gateway owns this drone's prompt, model, tools, limits, and typed schemas.",
      },
    ],
  };
}

export const execute = createExecute();
export const cancelRun = createCancelRun();
export const testEnvironment = createTestEnvironment();
