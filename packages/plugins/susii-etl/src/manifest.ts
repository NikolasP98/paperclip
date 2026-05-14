import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Susii ETL",
  description:
    "Ingest Susii sales/clients/items/payments/documents into the Supabase susii.* schema. Deterministic plugin job — no LLM in the hot path. Replaces ad-hoc xlsx parsing.",
  author: "OpenClaw",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      susiiUsernameRef: {
        type: "string",
        title: "Susii Username (Secret Ref)",
        description: "Secret reference resolving to the Susii admin email (e.g. SUSII_USERNAME).",
      },
      susiiPasswordRef: {
        type: "string",
        title: "Susii Password (Secret Ref)",
        description: "Secret reference resolving to the Susii admin password (e.g. SUSII_PASSWORD).",
      },
      susiiBusinessId: {
        type: "integer",
        title: "Susii Business ID",
        description: "Numeric business identifier for the FACES SCULPTORS account in Susii.",
      },
      supabaseDbHost: {
        type: "string",
        title: "Supabase DB Host",
        description: "Pooler host (e.g. aws-1-us-west-2.pooler.supabase.com).",
      },
      supabaseDbPort: {
        type: "integer",
        title: "Supabase DB Port",
        default: 5432,
      },
      supabaseDbUser: {
        type: "string",
        title: "Supabase DB User",
        description: "Pooler-prefixed user (e.g. postgres.<projectref>).",
      },
      supabaseDbName: {
        type: "string",
        title: "Supabase DB Name",
        default: "postgres",
      },
      supabaseDbPasswordRef: {
        type: "string",
        title: "Supabase DB Password (Secret Ref)",
        description: "Secret reference resolving to SUPABASE_DB_PASSWORD.",
      },
      supabaseDbSsl: {
        type: "string",
        title: "Supabase DB SSL Mode",
        enum: ["require", "verify-full", "disable"],
        default: "require",
      },
      modifiedAfterOverride: {
        type: "string",
        title: "modified_after override (ISO 8601)",
        description:
          "If set, sync-incremental skips watermark resolution and uses this value as the Susii modified_after filter. For controlled re-tests; clear in normal operation.",
      },
      maxSalesPerRun: {
        type: "integer",
        title: "Max sales per run",
        description:
          "Hard cap on sales ingested per sync-incremental invocation. Use a small value (e.g. 50) for first-run validation; clear for normal operation.",
        minimum: 1,
      },
    },
    required: [
      "susiiUsernameRef",
      "susiiPasswordRef",
      "susiiBusinessId",
      "supabaseDbHost",
      "supabaseDbUser",
      "supabaseDbPasswordRef",
    ],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.manualTest,
      displayName: "Manual: probe Susii API (dry-run)",
      description:
        "Read-only probe: fetch one page of sales modified in the last day, log counts. No DB writes. Use for connectivity validation.",
      // No schedule — operator-triggered only.
    },
    {
      jobKey: JOB_KEYS.syncIncremental,
      displayName: "Sync incremental (Susii → Supabase)",
      description:
        "Walk /v1/sales/sales/ filtered by modified_after watermark, upsert into susii.* schema. Updates watermark on success.",
      // 11:00 UTC = 06:00 America/Lima. Paperclip's cron parser is UTC-only
      // (no timezone field), so we hard-code the offset here. Lima does not
      // observe daylight savings, so this is stable year-round.
      schedule: "0 11 * * *",
    },
  ],
};

export default manifest;
