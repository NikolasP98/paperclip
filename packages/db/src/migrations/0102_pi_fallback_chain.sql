-- MINION fork: per-agent fallback chain (renumbered from fork-local 0055/0056 to
-- land after upstream 0101 during the 2026-06-15 upstream merge). Uses
-- IF NOT EXISTS so it is a safe no-op on the existing prod DB where the original
-- fork migrations already added these columns, while still applying on fresh DBs.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "active_adapter_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "fallback_from_adapter" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "fallback_level" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "quota_reset_at" timestamp with time zone;
