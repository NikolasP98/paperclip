import type { GatewayClient } from '@minion-stack/shared/node';
import type { AdapterModel, UsageSummary } from '@paperclipai/adapter-utils';
import type { MinionDroneId } from '../index.js';

export type MinionDroneConfig = {
  droneId: MinionDroneId;
  gatewayUrl: string;
  gatewayToken: string;
};

export type DroneCapability = {
  id: string;
  version: number;
  description: string;
  executable: true;
  availability: 'probe_required';
  provider: string;
  model: string;
  fallbackModels: Array<{ provider: string; model: string }>;
  timeoutMs: number;
  maxTokens: number;
  sideEffects: 'none';
  inputSchema?: unknown;
  outputSchema?: unknown;
};

export type CapabilitiesResponse = {
  contractVersion: number;
  maxActiveRuns: number;
  activeRuns: number;
  drones: DroneCapability[];
};

export type ProbeResponse = {
  contractVersion: number;
  probeKind: string;
  drones: Array<{
    droneId: string;
    ready: boolean;
    resolvedProvider?: string;
    resolvedModel?: string;
    errorCode?: string;
  }>;
};

export type ExecuteResponse = {
  runId: string;
  droneId: string;
  status: 'completed' | 'failed' | 'cancelled';
  output?: unknown;
  usage?: UsageSummary;
  durationMs?: number;
  resolvedModel?: { provider?: string; model?: string };
  error?: { code?: string; message?: string };
};

export type CancelResponse = {
  runId: string;
  cancelled: boolean;
  status: 'cancelling' | 'not_active';
};

export type GatewayClientLike = Pick<GatewayClient, 'connect' | 'request' | 'close'>;

export type GatewayClientFactory = (config: MinionDroneConfig) => GatewayClientLike;

export type ActiveDroneExecution = {
  client: GatewayClientLike | null;
  cancelRequested: boolean;
  executeStarted: boolean;
};

export type ModelCache = {
  models: AdapterModel[];
};
