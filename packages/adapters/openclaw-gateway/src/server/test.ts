import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  buildDeviceAuthPayloadV2,
  buildDeviceAuthPayloadV3,
  resolveDeviceIdentity,
  signDevicePayload,
} from "../shared/device-auth.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

type ProbeResult = {
  status: "ok" | "challenge_only" | "failed";
  gatewayError?: string;
  gatewayCode?: string;
};

const PROTOCOL_VERSION = 3;

async function probeGateway(input: {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  role: string;
  scopes: string[];
  timeoutMs: number;
  disableDeviceAuth?: boolean;
  adapterConfig: Record<string, unknown>;
}): Promise<ProbeResult> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(input.url, { headers: input.headers, maxPayload: 2 * 1024 * 1024 });
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ status: "failed" });
    }, input.timeoutMs);

    let completed = false;

    const finish = (result: ProbeResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (event?.type === "event" && event.event === "connect.challenge") {
        const nonce = nonEmpty(asRecord(event.payload)?.nonce);
        if (!nonce) {
          finish({ status: "failed", gatewayError: "Challenge missing nonce" });
          return;
        }

        const connectParams: Record<string, unknown> = {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            version: "paperclip-probe",
            platform: process.platform,
            mode: "probe",
          },
          role: input.role,
          scopes: input.scopes,
          ...(input.authToken
            ? {
                auth: {
                  token: input.authToken,
                },
              }
            : {}),
        };

        if (!input.disableDeviceAuth) {
          try {
            const deviceIdentity = resolveDeviceIdentity(input.adapterConfig);
            const signedAtMs = Date.now();
            const sigParams = {
              deviceId: deviceIdentity.deviceId,
              clientId: "gateway-client",
              clientMode: "probe",
              role: input.role,
              scopes: input.scopes,
              signedAtMs,
              token: input.authToken,
              nonce,
            };
            // Use v2 payload for broader gateway compatibility (v3 adds
            // platform/deviceFamily which older gateways reject as invalid).
            const payload = buildDeviceAuthPayloadV2(sigParams);
            connectParams.device = {
              id: deviceIdentity.deviceId,
              publicKey: deviceIdentity.publicKeyRawBase64Url,
              signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
              signedAt: signedAtMs,
              nonce,
            };
          } catch {
            // Fall through without device auth if key generation fails
          }
        }

        const connectId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: connectParams,
          }),
        );
        return;
      }

      if (event?.type === "res") {
        if (event.ok === true) {
          finish({ status: "ok" });
        } else {
          const error = asRecord(event.error);
          finish({
            status: "challenge_only",
            gatewayError: nonEmpty(error?.message) ?? undefined,
            gatewayCode: nonEmpty(error?.code) ?? undefined,
          });
        }
      }
    });

    ws.on("error", () => {
      finish({ status: "failed" });
    });

    ws.on("close", () => {
      if (!completed) finish({ status: "failed" });
    });
  });
}

function buildProbeHint(result: ProbeResult): string {
  const msg = result.gatewayError?.toLowerCase() ?? "";
  const code = result.gatewayCode?.toLowerCase() ?? "";

  if (msg.includes("device identity required") || code === "not_paired") {
    return "Gateway requires device auth. Ensure device auth is enabled, or pair this device with the gateway.";
  }
  if (msg.includes("token") && msg.includes("missing")) {
    return "No auth token provided. Set the gateway auth token in adapter config.";
  }
  if (msg.includes("token") && (msg.includes("mismatch") || msg.includes("invalid"))) {
    return "Auth token does not match the gateway's configured token.";
  }
  if (msg.includes("signature") && msg.includes("invalid")) {
    return "Device key signature failed. Check devicePrivateKeyPem or let the adapter generate an ephemeral key.";
  }
  if (msg.includes("signature") && msg.includes("expired")) {
    return "Device signature clock skew too large. Check server/client time sync.";
  }
  if (msg.includes("pairing required") || msg.includes("pairing")) {
    return "Device needs to be paired with the gateway. Enable autoPairOnFirstConnect or approve the device manually.";
  }
  if (msg.includes("rate_limited") || msg.includes("rate limit")) {
    return "Too many failed auth attempts. Wait a moment and retry.";
  }
  if (result.gatewayError) {
    return `Gateway rejected connect: ${result.gatewayError}`;
  }
  return "Check gateway credentials, scopes, role, and device-auth configuration.";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "").trim();

  if (!urlValue) {
    checks.push({
      code: "openclaw_gateway_url_missing",
      level: "error",
      message: "OpenClaw gateway adapter requires a WebSocket URL.",
      hint: "Set adapterConfig.url to ws://host:port (or wss://).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "openclaw_gateway_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "ws:" && url.protocol !== "wss:") {
    checks.push({
      code: "openclaw_gateway_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use ws:// or wss://.",
    });
  }

  if (url) {
    checks.push({
      code: "openclaw_gateway_url_valid",
      level: "info",
      message: `Configured gateway URL: ${url.toString()}`,
    });

    if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
      checks.push({
        code: "openclaw_gateway_plaintext_remote_ws",
        level: "warn",
        message: "Gateway URL uses plaintext ws:// on a non-loopback host.",
        hint: "Prefer wss:// for remote gateways.",
      });
    }
  }

  const headers = toStringRecord(config.headers);
  const authToken = resolveAuthToken(config, headers);
  const password = nonEmpty(config.password);
  const role = nonEmpty(config.role) ?? "operator";
  const scopes = toStringArray(config.scopes);
  const disableDeviceAuth = parseBoolean(config.disableDeviceAuth, false);

  if (authToken || password) {
    checks.push({
      code: "openclaw_gateway_auth_present",
      level: "info",
      message: "Gateway credentials are configured.",
    });
  } else {
    checks.push({
      code: "openclaw_gateway_auth_missing",
      level: "warn",
      message: "No gateway credentials detected in adapter config.",
      hint: "Set authToken/password or headers.x-openclaw-token for authenticated gateways.",
    });
  }

  if (url && (url.protocol === "ws:" || url.protocol === "wss:")) {
    try {
      const probeResult = await probeGateway({
        url: url.toString(),
        headers,
        authToken,
        role,
        scopes: scopes.length > 0 ? scopes : ["operator.admin"],
        timeoutMs: 5_000,
        disableDeviceAuth,
        adapterConfig: config,
      });

      if (probeResult.status === "ok") {
        checks.push({
          code: "openclaw_gateway_probe_ok",
          level: "info",
          message: "Gateway connect probe succeeded.",
        });
      } else if (probeResult.status === "challenge_only") {
        const isPairingRequired =
          probeResult.gatewayError?.toLowerCase().includes("pairing") ?? false;
        if (isPairingRequired) {
          checks.push({
            code: "openclaw_gateway_probe_pairing",
            level: "info",
            message: "Gateway probe passed: URL, token, protocol, and device signature verified.",
          });
          checks.push({
            code: "openclaw_gateway_probe_pairing_pending",
            level: "warn",
            message: "Device pairing required. Approve this device on the gateway to complete setup.",
            hint: "Run: ssh <gateway-host> 'minion device approve' or approve via the gateway's control UI.",
          });
        } else {
          checks.push({
            code: "openclaw_gateway_probe_challenge_only",
            level: "warn",
            message: probeResult.gatewayError
              ? `Gateway rejected connect: ${probeResult.gatewayError}`
              : "Gateway challenge was received, but connect probe was rejected.",
            hint: buildProbeHint(probeResult),
          });
        }
      } else {
        checks.push({
          code: "openclaw_gateway_probe_failed",
          level: "warn",
          message: "Gateway probe failed.",
          hint: "Verify network reachability and gateway URL from the Paperclip server host.",
        });
      }
    } catch (err) {
      checks.push({
        code: "openclaw_gateway_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Gateway probe failed",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
