export const PLUGIN_ID = "openclaw.susii-etl";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  syncIncremental: "sync-incremental",
  manualTest: "manual-test",
} as const;

export const STATE_KEYS = {
  watermark: "sync.watermark",
} as const;

/**
 * Required config refs (instanceConfigSchema → ctx.secrets.resolve).
 *
 * Each key is a Paperclip secret reference. Operators set these to point
 * at entries in the secret store; values come from Infisical at boot.
 *
 * Plain config (host, port, user, db name) lives in plain string fields —
 * not secret-protected.
 */
export const SECRET_REF_KEYS = [
  "susiiUsernameRef",
  "susiiPasswordRef",
  "supabaseDbPasswordRef",
] as const;

export const PLAIN_CONFIG_KEYS = [
  "susiiBusinessId",
  "supabaseDbHost",
  "supabaseDbPort",
  "supabaseDbUser",
  "supabaseDbName",
  "supabaseDbSsl",
] as const;

export interface PluginConfig {
  susiiUsernameRef: string;
  susiiPasswordRef: string;
  supabaseDbPasswordRef: string;
  susiiBusinessId: number;
  supabaseDbHost: string;
  supabaseDbPort: number;
  supabaseDbUser: string;
  supabaseDbName: string;
  supabaseDbSsl: "require" | "verify-full" | "disable";

  // Phase 3 controls. Both optional. Used for guarded first-runs and re-tests.
  /** If set, skip resolveWatermark() and use this ISO timestamp as modified_after. */
  modifiedAfterOverride?: string;
  /** If set, stop ingesting after N sales in a single run (for guarded first-runs). */
  maxSalesPerRun?: number;
}

export const SUSII_API_BASE = "https://api.susii.com";

/** Fallback floor when no sync_log + no sales rows exist (cold-start backfill). */
export const COLD_START_FALLBACK_ISO = "2024-01-01T00:00:00Z";
