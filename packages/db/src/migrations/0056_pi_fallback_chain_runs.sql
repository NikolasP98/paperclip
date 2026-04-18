ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_from_adapter" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_level" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "quota_reset_at" timestamp with time zone;