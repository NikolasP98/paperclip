import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { COLD_START_FALLBACK_ISO, JOB_KEYS, type PluginConfig } from "./constants.js";
import {
  applySaleInTx,
  finishSyncRun,
  makeSql,
  resolveWatermark,
  startSyncRun,
} from "./db.js";
import { SusiiClient, type SusiiSale } from "./susii-client.js";

const PLUGIN_NAME = "susii-etl";

async function loadConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = (await ctx.config.get()) as Record<string, unknown>;
  return {
    susiiUsernameRef: raw.susiiUsernameRef as string,
    susiiPasswordRef: raw.susiiPasswordRef as string,
    supabaseDbPasswordRef: raw.supabaseDbPasswordRef as string,
    susiiBusinessId: Number(raw.susiiBusinessId),
    supabaseDbHost: raw.supabaseDbHost as string,
    supabaseDbPort: Number(raw.supabaseDbPort ?? 5432),
    supabaseDbUser: raw.supabaseDbUser as string,
    supabaseDbName: (raw.supabaseDbName as string) ?? "postgres",
    supabaseDbSsl: ((raw.supabaseDbSsl as string) ?? "require") as PluginConfig["supabaseDbSsl"],
    modifiedAfterOverride: (raw.modifiedAfterOverride as string) || undefined,
    maxSalesPerRun: raw.maxSalesPerRun ? Number(raw.maxSalesPerRun) : undefined,
  };
}

async function buildSusiiClient(
  ctx: PluginContext,
  config: PluginConfig,
): Promise<SusiiClient> {
  const [username, password] = await Promise.all([
    ctx.secrets.resolve(config.susiiUsernameRef),
    ctx.secrets.resolve(config.susiiPasswordRef),
  ]);
  return new SusiiClient({
    username,
    password,
    businessId: config.susiiBusinessId,
    log: (msg, meta) => ctx.logger.info(msg, meta),
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup complete`);

    /**
     * `manual-test` — read-only API probe.
     *
     * Fetches one page (max 5 sales) modified in the last 24h, logs structural
     * counts and a sample sale id. NO DB writes. Used to validate connectivity
     * + secret resolution + manifest registration end-to-end.
     */
    ctx.jobs.register(JOB_KEYS.manualTest, async (job: PluginJobContext) => {
      ctx.logger.info("susii-etl.manualTest.start", {
        trigger: job.trigger,
        scheduledAt: job.scheduledAt,
      });
      const config = await loadConfig(ctx);
      const client = await buildSusiiClient(ctx, config);

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const total = await client.countSalesSince(yesterday);
      const sampled: SusiiSale[] = [];
      for await (const sale of client.listSalesPaginated({
        dateGteIsoDay: yesterday,
        pageSize: 5,
        maxPages: 1,
      })) {
        sampled.push(sale);
        if (sampled.length >= 5) break;
      }

      const summary = {
        dateGte: yesterday,
        totalMatching: total,
        sampledCount: sampled.length,
        sampleIds: sampled.map((s) => s.id),
        firstItemCounts: sampled[0]
          ? {
              items: sampled[0].items.length,
              payments: sampled[0].payments.length,
              documents: sampled[0].document_set.length,
            }
          : null,
      };
      ctx.logger.info("susii-etl.manualTest.ok", summary);
      // Activity log requires companyId — re-add at Phase 3 when company-scoped.
    });

    /**
     * `sync-incremental` — paginated walk + idempotent upsert.
     *
     * Pipeline:
     *   1. startSyncRun — orphan-reaper + concurrency guard + insert sync_log row.
     *   2. resolveWatermark — last successful sync_log.last_sale_date,
     *      or MAX(sales.synced_at), or cold-start floor (2024-01-01).
     *      Operator can override via instance config `modifiedAfterOverride`.
     *   3. Walk Susii API page-by-page. For each sale, applySaleInTx (per-sale
     *      transaction: client + sale + items + payments + documents).
     *   4. Track latest sale.date seen. On finish, write sync_log with
     *      status=success / partial / failed and the new watermark.
     *
     * Errors are localized: per-sale tx failure increments errorCount; the
     * loop continues. If errorCount > 0 the run finishes as `partial`.
     * Hard errors (auth, network) bubble up and finish the run as `failed`.
     */
    ctx.jobs.register(JOB_KEYS.syncIncremental, async (job: PluginJobContext) => {
      const config = await loadConfig(ctx);
      const dbPassword = await ctx.secrets.resolve(config.supabaseDbPasswordRef);
      const sql = makeSql(config, dbPassword);

      let runId: number | null = null;
      let fetched = 0;
      let upserted = 0;
      let errorCount = 0;
      let lastSaleDate: string | null = null;
      const errors: Array<{ saleId: number; message: string }> = [];

      try {
        const startInfo = await startSyncRun(sql);
        runId = startInfo.runId;

        // Susii's `modified_after` is a silent no-op; we filter by `date__gte`
        // instead, with a 1-day rewind to catch late-modified older sales.
        // Operator can override via `modifiedAfterOverride` (kept name for
        // back-compat) — accepts ISO or YYYY-MM-DD; we slice to date prefix.
        const watermark = config.modifiedAfterOverride
          ? config.modifiedAfterOverride.slice(0, 10)
          : await resolveWatermark(sql, COLD_START_FALLBACK_ISO, 1);

        ctx.logger.info("susii-etl.syncIncremental.start", {
          trigger: job.trigger,
          runId,
          watermark,
          maxSalesPerRun: config.maxSalesPerRun ?? null,
          override: !!config.modifiedAfterOverride,
        });

        const client = await buildSusiiClient(ctx, config);
        const cap = config.maxSalesPerRun ?? Number.MAX_SAFE_INTEGER;

        for await (const sale of client.listSalesPaginated({
          dateGteIsoDay: watermark,
          pageSize: 100,
        })) {
          fetched += 1;
          if (fetched > cap) {
            ctx.logger.info("susii-etl.syncIncremental.cap", { cap, fetched });
            break;
          }
          try {
            await applySaleInTx(sql, sale);
            upserted += 1;
            if (!lastSaleDate || sale.date > lastSaleDate) {
              lastSaleDate = sale.date;
            }
          } catch (err) {
            errorCount += 1;
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ saleId: sale.id, message });
            ctx.logger.warn("susii-etl.syncIncremental.saleError", {
              saleId: sale.id,
              message,
            });
            if (errorCount >= 5) {
              throw new Error(
                `aborting after ${errorCount} consecutive sale errors; first: ${errors[0].message}`,
              );
            }
          }
        }

        const status: "success" | "partial" = errorCount === 0 ? "success" : "partial";
        await finishSyncRun(sql, runId, {
          status,
          fetched,
          upserted,
          lastSaleDate,
          error: errors.length > 0 ? JSON.stringify(errors.slice(0, 10)) : null,
        });
        ctx.logger.info("susii-etl.syncIncremental.done", {
          runId,
          status,
          fetched,
          upserted,
          errorCount,
          lastSaleDate,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error("susii-etl.syncIncremental.failed", {
          runId,
          fetched,
          upserted,
          errorCount,
          message,
        });
        if (runId !== null) {
          await finishSyncRun(sql, runId, {
            status: "failed",
            fetched,
            upserted,
            lastSaleDate,
            error: message,
          });
        }
        throw err;
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },

  async onHealth() {
    return { status: "ok", message: "susii-etl ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
