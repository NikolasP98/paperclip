import type { AdapterExecutionResult } from "../adapters/types.js";

export interface AdapterChainEntry {
  type: string;
  model?: string;
  command?: string;
  envAlias?: Record<string, string>;
  [key: string]: unknown;
}

const CLAUDE_QUOTA_PATTERN = /You're out of extra usage/i;
const CLAUDE_RESET_PATTERN =
  /resets\s+([A-Za-z]+\s+\d{1,2})(?:,\s*(\d{1,2}(?::\d{2})?(?:am|pm)?))?\s*([A-Z]{2,4})?/i;

/**
 * Build the effective chain by prepending the agent's primary adapter config
 * to its (optional) fallbackChain.
 */
export function resolveEffectiveChain(
  primary: AdapterChainEntry,
  fallbackChain: AdapterChainEntry[] | undefined,
): AdapterChainEntry[] {
  if (!fallbackChain || fallbackChain.length === 0) return [primary];
  return [primary, ...fallbackChain];
}

/**
 * Merge one chain level into the runtime config handed to an adapter.
 *
 * The primary chain entry is built from the persisted adapter config, while
 * `resolvedConfig` contains its decrypted/plain runtime env. Preserve that
 * resolved env instead of replacing it with persisted binding objects.
 * Fallback levels retain their explicit overrides; this helper only corrects
 * the primary entry, whose values have already been resolved.
 */
export function mergeAdapterChainLevelConfig(
  resolvedConfig: Record<string, unknown>,
  entry: AdapterChainEntry,
  activeIndex: number,
): Record<string, unknown> {
  const merged = { ...resolvedConfig, ...entry };
  if (activeIndex !== 0) return merged;
  if (Object.prototype.hasOwnProperty.call(resolvedConfig, "env")) {
    merged.env = resolvedConfig.env;
  } else {
    delete merged.env;
  }
  return merged;
}

/**
 * Decide whether a failed adapter result should advance to the next chain level.
 * Returns false for non-fallback-triggering errors (timeouts, panics, etc.).
 */
export function shouldAdvanceChain(
  result: Partial<Pick<AdapterExecutionResult, "errorMessage" | "errorCode" | "timedOut">>,
  adapter: AdapterChainEntry,
): boolean {
  if (result.timedOut) return false;
  if (adapter.type === "claude_local") {
    return Boolean(result.errorMessage && CLAUDE_QUOTA_PATTERN.test(result.errorMessage));
  }
  if (adapter.type === "pi_local") {
    return result.errorCode === "openrouter_credit_limit";
  }
  return false;
}

/**
 * Map a triggering result to a stable reason string for persistence + UI.
 */
export function classifyFallbackReason(
  result: Partial<Pick<AdapterExecutionResult, "errorMessage" | "errorCode">>,
  adapter: AdapterChainEntry,
): "quota_exhausted" | "credit_cap_hit" | null {
  if (
    adapter.type === "claude_local" &&
    result.errorMessage &&
    CLAUDE_QUOTA_PATTERN.test(result.errorMessage)
  ) {
    return "quota_exhausted";
  }
  if (adapter.type === "pi_local" && result.errorCode === "openrouter_credit_limit") {
    return "credit_cap_hit";
  }
  return null;
}

/**
 * Parse the Claude "resets <month> <day>, <time> <tz>" suffix from a quota error.
 * Returns a Date assumed to be in the current year. Returns null if no
 * timestamp is found.
 */
export function parseQuotaResetAt(message: string): Date | null {
  const match = message.match(CLAUDE_RESET_PATTERN);
  if (!match) return null;
  const [, monthDay, timeStr, tz] = match;
  const time = normalizeTimeString(timeStr ?? "12pm");
  const tzSuffix = tz ?? "UTC";
  const year = new Date().getUTCFullYear();
  const candidate = new Date(`${monthDay} ${year} ${time} ${tzSuffix}`);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

/**
 * Normalize Claude's compact time format ("7pm", "12am", "3:30pm") into a form
 * the JS Date constructor reliably parses ("7:00 PM", "12:00 AM", "3:30 PM").
 */
function normalizeTimeString(raw: string): string {
  const m = raw.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return raw;
  const [, hour, minute, suffix] = m;
  const mins = minute ?? "00";
  const meridiem = suffix ? suffix.toUpperCase() : "";
  return meridiem ? `${hour}:${mins} ${meridiem}` : `${hour}:${mins}`;
}
