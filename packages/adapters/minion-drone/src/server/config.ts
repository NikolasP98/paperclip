import { MINION_DRONE_IDS, type MinionDroneId } from '../index.js';
import type { MinionDroneConfig } from './types.js';

const FORBIDDEN_CONFIG_KEYS = new Set([
  'args',
  'command',
  'maxTokens',
  'model',
  'payloadTemplate',
  'prompt',
  'promptTemplate',
  'provider',
  'timeout',
  'timeoutMs',
  'timeoutSec',
  'tools',
]);

const ALLOWED_ENV_KEYS = new Set(['MINION_GATEWAY_URL', 'MINION_GATEWAY_TOKEN']);

export type ConfigParseResult =
  | { ok: true; config: MinionDroneConfig }
  | { ok: false; code: string; message: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function isMinionDroneId(value: unknown): value is MinionDroneId {
  return typeof value === 'string' && (MINION_DRONE_IDS as readonly string[]).includes(value);
}

export function parseMinionDroneConfig(config: Record<string, unknown>): ConfigParseResult {
  const forbiddenKey = Object.keys(config).find((key) => FORBIDDEN_CONFIG_KEYS.has(key));
  if (forbiddenKey) {
    return {
      ok: false,
      code: 'minion_drone_config_forbidden',
      message: `minion_drone does not allow adapter config field: ${forbiddenKey}`,
    };
  }

  if (!isMinionDroneId(config.droneId)) {
    return {
      ok: false,
      code: 'minion_drone_id_invalid',
      message: 'minion_drone requires a fixed allowlisted droneId',
    };
  }

  const env = asRecord(config.env);
  const unknownEnvKey = Object.keys(env).find((key) => !ALLOWED_ENV_KEYS.has(key));
  if (unknownEnvKey) {
    return {
      ok: false,
      code: 'minion_drone_env_forbidden',
      message: `minion_drone does not allow environment field: ${unknownEnvKey}`,
    };
  }

  const gatewayUrl = nonEmpty(env.MINION_GATEWAY_URL);
  if (!gatewayUrl) {
    return {
      ok: false,
      code: 'minion_drone_gateway_url_missing',
      message: 'minion_drone requires env.MINION_GATEWAY_URL',
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(gatewayUrl);
  } catch {
    return {
      ok: false,
      code: 'minion_drone_gateway_url_invalid',
      message: 'env.MINION_GATEWAY_URL is not a valid URL',
    };
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    return {
      ok: false,
      code: 'minion_drone_gateway_url_protocol',
      message: 'env.MINION_GATEWAY_URL must use ws:// or wss://',
    };
  }
  if (parsedUrl.protocol === 'ws:' && !isLoopback(parsedUrl.hostname)) {
    return {
      ok: false,
      code: 'minion_drone_gateway_plaintext_remote',
      message: 'Remote minion_drone gateways must use wss://',
    };
  }

  const gatewayToken = nonEmpty(env.MINION_GATEWAY_TOKEN);
  if (!gatewayToken) {
    return {
      ok: false,
      code: 'minion_drone_gateway_token_missing',
      message: 'minion_drone requires the env.MINION_GATEWAY_TOKEN secret binding',
    };
  }

  return {
    ok: true,
    config: {
      droneId: config.droneId,
      gatewayUrl: parsedUrl.toString(),
      gatewayToken,
    },
  };
}

export function readDroneInput(context: Record<string, unknown>): Record<string, unknown> | null {
  const envelope = asRecord(context.paperclipDrone);
  const input = asRecord(envelope.input);
  return Object.keys(input).length > 0 ? input : null;
}
