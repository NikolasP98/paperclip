/**
 * Paperclip-specific gateway helpers.
 * Auth/header utilities and local types that are NOT part of @minion-stack/shared.
 *
 * Phase 7 WS-04: GatewayClient implementation moved to @minion-stack/shared/node.
 * These helpers stay paperclip-local (see audit D-04 for onLog, audit doc for auth helpers).
 */

// ---------------------------------------------------------------------------
// Paperclip-specific types (kept local — not moved to shared)
// ---------------------------------------------------------------------------

import type { GatewayClient } from "@minion-stack/shared/node";

export type GatewayResponseError = Error & {
  gatewayCode?: string;
  gatewayDetails?: Record<string, unknown>;
};

export type GatewayLogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

/** Paperclip adds expectFinal not present in shared GatewayClientOptions. */
export type GatewayClientRequestOptions = {
  timeoutMs: number;
  expectFinal?: boolean;
};

// ---------------------------------------------------------------------------
// General utilities
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth/header helpers (kept local — paperclip auth wiring not moved to shared)
// ---------------------------------------------------------------------------

export function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

export function headerMapHasIgnoreCase(headers: Record<string, string>, key: string): boolean {
  return Object.keys(headers).some((entryKey) => entryKey.toLowerCase() === key.toLowerCase());
}

export function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

export function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

// ---------------------------------------------------------------------------
// onLog wrapper (D-04: stays paperclip-local)
// ---------------------------------------------------------------------------

/**
 * Wraps a GatewayClient to forward request errors to the onLog callback.
 * The shared GatewayClient has no logging hooks (D-04).
 */
export function withLogging(client: GatewayClient, onLog?: GatewayLogFn): GatewayClient {
  if (!onLog) return client;
  const originalRequest = client.request.bind(client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).request = async (...args: Parameters<typeof originalRequest>) => {
    try {
      return await originalRequest(...args);
    } catch (err) {
      await onLog("stderr", err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
  return client;
}
