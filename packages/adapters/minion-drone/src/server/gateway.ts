import { createNodeGatewayClient, PROTOCOL_VERSION } from '@minion-stack/shared/node';
import type { GatewayClientFactory, MinionDroneConfig } from './types.js';

export const createGatewayClient: GatewayClientFactory = (config: MinionDroneConfig) =>
  createNodeGatewayClient({
    url: config.gatewayUrl,
    autoReconnect: false,
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 15_000,
    onChallenge: async () => ({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: 'gateway-client',
        displayName: 'Paperclip Minion Drone',
        version: 'paperclip-minion-drone/1',
        platform: process.platform,
        mode: 'backend',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: config.gatewayToken },
    }),
  });
