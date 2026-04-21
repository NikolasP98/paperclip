// Phase 7 WS-04: implementation lives in @minion-stack/shared/node.
// Paperclip-specific helpers (auth resolution, header parsing, onLog wrapping) stay local in gateway-helpers.ts.
export {
  GatewayClient as GatewayWsClient,
  PROTOCOL_VERSION,
  createNodeGatewayClient,
  type GatewayClientOptions as GatewayWsClientOptions,
  type NodeGatewayClientOptions,
  type EventFrame as GatewayEventFrame,
  type RequestFrame as GatewayRequestFrame,
  type ResponseFrame as GatewayResponseFrame,
  type GatewayFrame,
} from "@minion-stack/shared/node";

// Re-export paperclip-local helpers for call sites that import them from here.
export {
  asRecord,
  nonEmpty,
  withTimeout,
  toStringRecord,
  headerMapGetIgnoreCase,
  headerMapHasIgnoreCase,
  toAuthorizationHeaderValue,
  resolveAuthToken,
  withLogging,
  type GatewayResponseError,
  type GatewayLogFn,
  type GatewayClientRequestOptions,
} from "./gateway-helpers.js";
