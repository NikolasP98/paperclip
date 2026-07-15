export const type = 'minion_drone';
export const label = 'Minion Drone';

export const models: { id: string; label: string }[] = [];

export const MINION_DRONE_IDS = [
  'portfolio-issue-classifier-v1',
  'portfolio-spec-planner-v1',
  'portfolio-implementation-evaluator-v1',
  'portfolio-merge-readiness-v1',
] as const;

export type MinionDroneId = (typeof MINION_DRONE_IDS)[number];

export const agentConfigurationDoc = `# minion_drone agent configuration

Adapter: minion_drone

Use this adapter only for one of the four gateway-owned, bounded portfolio drones.
Paperclip selects a fixed drone id and supplies typed stage input through the
control-plane run context. The adapter cannot configure prompts, models, tools,
token limits, or timeouts.

Persisted adapter config:
- droneId: one fixed id from the allowlist below.
- env.MINION_GATEWAY_URL: a Paperclip environment binding (plain or secret ref)
  that resolves to a ws:// loopback URL or a wss:// URL.
- env.MINION_GATEWAY_TOKEN: a Paperclip secret-ref environment binding. Never
  persist the gateway token as a top-level adapter field.

Allowed drone ids:
- portfolio-issue-classifier-v1
- portfolio-spec-planner-v1
- portfolio-implementation-evaluator-v1
- portfolio-merge-readiness-v1

Runtime contract:
- context.paperclipDrone.input contains the typed input prepared by the
  deterministic portfolio coordinator.
- one Paperclip heartbeat run id maps to one gateway drone run id.
- the adapter probes the selected fixed definition before every execution.
- cancellation is forwarded to drones.cancel for that same run id.
`;
