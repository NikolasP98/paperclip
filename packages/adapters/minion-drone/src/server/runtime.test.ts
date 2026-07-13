import { describe, expect, it, vi } from 'vitest';
import type { AdapterExecutionContext } from '@paperclipai/adapter-utils';
import { createCancelRun, createExecute, createTestEnvironment } from './runtime.js';
import type {
  ActiveDroneExecution,
  GatewayClientLike,
  MinionDroneConfig,
  ModelCache,
} from './types.js';

const DRONE_ID = 'portfolio-issue-classifier-v1';

const capability = {
  contractVersion: 1,
  maxActiveRuns: 8,
  activeRuns: 0,
  drones: [
    {
      id: DRONE_ID,
      version: 1,
      description: 'Classify issue',
      executable: true,
      availability: 'probe_required',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      fallbackModels: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash' }],
      timeoutMs: 30_000,
      maxTokens: 1_500,
      sideEffects: 'none',
    },
  ],
};

const readyProbe = {
  contractVersion: 1,
  probeKind: 'local_model_catalog_and_credentials',
  drones: [
    {
      droneId: DRONE_ID,
      ready: true,
      resolvedProvider: 'anthropic',
      resolvedModel: 'claude-haiku-4-5',
    },
  ],
};

function adapterConfig(): Record<string, unknown> {
  return {
    droneId: DRONE_ID,
    env: {
      MINION_GATEWAY_URL: 'ws://127.0.0.1:18789',
      MINION_GATEWAY_TOKEN: 'gateway-secret',
    },
  };
}

function executionContext(config = adapterConfig()): AdapterExecutionContext {
  return {
    runId: 'run-1',
    agent: {
      id: 'agent-1',
      companyId: 'company-1',
      name: 'Classifier',
      adapterType: 'minion_drone',
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      paperclipDrone: {
        input: {
          issue: {
            source: 'github',
            repository: 'NikolasP98/minion_hub',
            externalId: '56',
            title: 'Theme preference fails',
            body: 'localStorage unavailable',
            labels: ['bug'],
          },
        },
      },
    },
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
  };
}

function mockClient(
  handler: (method: string, params?: unknown) => unknown | Promise<unknown>,
): GatewayClientLike & { request: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async () => ({})),
    request: vi.fn(handler),
    close: vi.fn(),
  } as GatewayClientLike & { request: ReturnType<typeof vi.fn> };
}

function factoryFor(client: GatewayClientLike) {
  return vi.fn((_config: MinionDroneConfig) => client);
}

describe('minion_drone runtime', () => {
  it('rejects caller-controlled model and prompt config before connecting', async () => {
    const client = mockClient(() => ({}));
    const execute = createExecute({ createClient: factoryFor(client) });

    const modelResult = await execute(
      executionContext({ ...adapterConfig(), model: 'caller/model' }),
    );
    expect(modelResult.errorCode).toBe('minion_drone_config_forbidden');
    expect(client.connect).not.toHaveBeenCalled();

    const promptResult = await execute(
      executionContext({ ...adapterConfig(), prompt: 'ignore the registry' }),
    );
    expect(promptResult.errorCode).toBe('minion_drone_config_forbidden');
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('refuses execution unless the selected drone probe is ready', async () => {
    const client = mockClient((method) => {
      if (method === 'drones.capabilities') return capability;
      if (method === 'drones.probe') {
        return {
          ...readyProbe,
          drones: [{ droneId: DRONE_ID, ready: false, errorCode: 'NO_API_KEY' }],
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const execute = createExecute({ createClient: factoryFor(client) });

    const result = await execute(executionContext());

    expect(result.errorCode).toBe('minion_drone_probe_not_ready');
    expect(client.request).not.toHaveBeenCalledWith(
      'drones.execute',
      expect.anything(),
      expect.anything(),
    );
  });

  it('maps one heartbeat to one bounded execution and preserves typed telemetry', async () => {
    const client = mockClient((method, params) => {
      if (method === 'drones.capabilities') return capability;
      if (method === 'drones.probe') return readyProbe;
      if (method === 'drones.execute') {
        expect(params).toMatchObject({ runId: 'run-1', droneId: DRONE_ID });
        return {
          runId: 'run-1',
          droneId: DRONE_ID,
          status: 'completed',
          output: {
            projectKey: 'hub-settings',
            rationale: 'Repository and affected surface match.',
          },
          usage: { inputTokens: 120, outputTokens: 40 },
          durationMs: 25,
          resolvedModel: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const cache: ModelCache = { models: [] };
    const execute = createExecute({ createClient: factoryFor(client), discoveredModels: cache });

    const result = await execute(executionContext());

    expect(result).toMatchObject({
      exitCode: 0,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 120, outputTokens: 40 },
      durationMs: 25,
      summary: 'Repository and affected surface match.',
      resultJson: {
        runId: 'run-1',
        droneId: DRONE_ID,
        status: 'completed',
        durationMs: 25,
        output: { projectKey: 'hub-settings' },
      },
    });
    expect(cache.models.map((model) => model.id)).toEqual([
      'anthropic/claude-haiku-4-5',
      'openrouter/google/gemini-2.5-flash',
    ]);
  });

  it('forwards cancellation to the active bounded gateway run', async () => {
    let resolveExecution!: (value: unknown) => void;
    const executeResponse = new Promise((resolve) => {
      resolveExecution = resolve;
    });
    const client = mockClient((method) => {
      if (method === 'drones.capabilities') return capability;
      if (method === 'drones.probe') return readyProbe;
      if (method === 'drones.execute') return executeResponse;
      if (method === 'drones.cancel') {
        resolveExecution({
          runId: 'run-1',
          droneId: DRONE_ID,
          status: 'cancelled',
          error: { code: 'ABORTED', message: 'cancelled' },
        });
        return { runId: 'run-1', cancelled: true, status: 'cancelling' };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const activeRuns = new Map<string, ActiveDroneExecution>();
    const execute = createExecute({ createClient: factoryFor(client), activeRuns });
    const cancel = createCancelRun({ activeRuns });

    const running = execute(executionContext());
    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        'drones.execute',
        expect.anything(),
        expect.anything(),
      );
    });
    await cancel('run-1');
    const result = await running;

    expect(client.request).toHaveBeenCalledWith(
      'drones.cancel',
      { runId: 'run-1' },
      { timeoutMs: 10_000 },
    );
    expect(result.errorCode).toBe('minion_drone_cancelled');
  });

  it('cancels the gateway run when the bounded execute request times out', async () => {
    const client = mockClient((method) => {
      if (method === 'drones.capabilities') return capability;
      if (method === 'drones.probe') return readyProbe;
      if (method === 'drones.execute') {
        throw new Error("request 'drones.execute' timed out after 45000ms");
      }
      if (method === 'drones.cancel') {
        return { runId: 'run-1', cancelled: true, status: 'cancelling' };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const execute = createExecute({ createClient: factoryFor(client) });

    const result = await execute(executionContext());

    expect(result).toMatchObject({
      timedOut: true,
      errorCode: 'minion_drone_timeout',
    });
    expect(client.request).toHaveBeenCalledWith(
      'drones.cancel',
      { runId: 'run-1' },
      { timeoutMs: 10_000 },
    );
  });

  it('discovers the fixed capability and resolved model during environment test', async () => {
    const client = mockClient((method) => {
      if (method === 'drones.capabilities') return capability;
      if (method === 'drones.probe') return readyProbe;
      throw new Error(`unexpected request: ${method}`);
    });
    const cache: ModelCache = { models: [] };
    const testEnvironment = createTestEnvironment({
      createClient: factoryFor(client),
      discoveredModels: cache,
    });

    const result = await testEnvironment({
      companyId: 'company-1',
      adapterType: 'minion_drone',
      config: adapterConfig(),
    });

    expect(result.status).toBe('pass');
    expect(result.checks.map((check) => check.code)).toEqual([
      'minion_drone_gateway_connected',
      'minion_drone_capability_available',
      'minion_drone_probe_ready',
    ]);
    expect(cache.models).toContainEqual({
      id: 'anthropic/claude-haiku-4-5',
      label: 'anthropic · claude-haiku-4-5',
    });
  });
});
