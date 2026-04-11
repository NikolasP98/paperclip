import type { HireApprovedHookResult, HireApprovedPayload } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  GatewayWsClient,
  PROTOCOL_VERSION,
  nonEmpty,
  resolveAuthToken,
  toAuthorizationHeaderValue,
  toStringRecord,
} from "./gateway-client.js";

const CONNECT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;

function buildOnboardingMessage(payload: HireApprovedPayload, adapterConfig: Record<string, unknown>): string {
  const apiUrl = nonEmpty(adapterConfig.paperclipApiUrl) ?? "<not configured>";
  const lines = [
    `You have been hired as "${payload.agentName}" (agent ID: ${payload.agentId}).`,
    "",
    "Paperclip credentials:",
    `  API URL: ${apiUrl}`,
    `  Agent ID: ${payload.agentId}`,
    `  Company ID: ${payload.companyId}`,
    "",
    payload.message,
    "",
    "To start working, configure your Paperclip integration and then use the `paperclip` tool to check assignments.",
  ];
  return lines.join("\n");
}

export async function onHireApproved(
  payload: HireApprovedPayload,
  adapterConfig: Record<string, unknown>,
): Promise<HireApprovedHookResult> {
  const urlValue = nonEmpty(adapterConfig.url);
  if (!urlValue) {
    return { ok: false, error: "missing gateway url in adapterConfig" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return { ok: false, error: `invalid gateway url: ${urlValue}` };
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    return { ok: false, error: `unsupported protocol: ${parsedUrl.protocol}` };
  }

  const headers = toStringRecord(adapterConfig.headers);
  const authToken = resolveAuthToken(parseObject(adapterConfig), headers);

  if (authToken && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
    headers.authorization = toAuthorizationHeaderValue(authToken);
  }

  const notificationChannel = nonEmpty(adapterConfig.notificationChannel);
  const notificationTo = nonEmpty(adapterConfig.notificationTo);
  const sessionKey = nonEmpty(adapterConfig.agentSessionKey);

  if (!notificationTo && !sessionKey) {
    return {
      ok: false,
      error: "adapterConfig must include notificationTo (channel target) or agentSessionKey to deliver onboarding message",
    };
  }

  const message = buildOnboardingMessage(payload, adapterConfig);

  const noopLog = async () => {};
  const client = new GatewayWsClient({
    url: parsedUrl.toString(),
    headers,
    onEvent: () => {},
    onLog: noopLog,
  });

  try {
    await client.connect(
      () => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "paperclip-hire-hook",
          version: "paperclip",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin"],
        auth: authToken ? { token: authToken } : undefined,
      }),
      CONNECT_TIMEOUT_MS,
    );

    if (notificationTo) {
      await client.request(
        "send",
        {
          to: notificationTo,
          message,
          ...(notificationChannel ? { channel: notificationChannel } : {}),
          idempotencyKey: `hire-approved:${payload.agentId}:${payload.approvedAt}`,
        },
        { timeoutMs: SEND_TIMEOUT_MS },
      );
    } else if (sessionKey) {
      await client.request(
        "chat.send",
        {
          message,
          sessionKey,
          idempotencyKey: `hire-approved:${payload.agentId}:${payload.approvedAt}`,
        },
        { timeoutMs: SEND_TIMEOUT_MS },
      );
    }

    return { ok: true };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `gateway communication failed: ${errMessage}` };
  } finally {
    client.close();
  }
}
