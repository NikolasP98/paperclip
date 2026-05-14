import postgres from "postgres";
import type { PluginConfig } from "./constants.js";
import type {
  SusiiClient as SusiiClientRow,
  SusiiDocument,
  SusiiPayment,
  SusiiSale,
  SusiiSaleItem,
} from "./susii-client.js";

/**
 * Either a top-level connection or a transaction handle. The `postgres.Sql`
 * type is callable as a tagged template; `postgres.TransactionSql` exposes
 * the same template-call shape but TypeScript can't narrow that across the
 * union. We model `Sql` as the connection type and cast tx-handles when
 * passing them to helpers — runtime behaviour is identical.
 */
export type Sql = postgres.Sql<Record<string, never>>;

/** Top-level connection. Returned by makeSql; `.end()` closes the pool. */
export type SqlConnection = postgres.Sql<Record<string, never>>;

export function makeSql(config: PluginConfig, password: string): SqlConnection {
  return postgres({
    host: config.supabaseDbHost,
    port: config.supabaseDbPort,
    user: config.supabaseDbUser,
    database: config.supabaseDbName,
    password,
    ssl: config.supabaseDbSsl === "disable" ? false : { rejectUnauthorized: false },
    max: 4,
    idle_timeout: 20,
    prepare: false, // Required for Supabase Session Pooler — no prepared statement cache.
  });
}

/**
 * Idempotent upsert for one sale's client.
 *
 * `synced_at = now()` is overwritten on every upsert. The plugin treats
 * the *latest* API JSON as canonical — if a client was updated upstream,
 * we mirror it. The `synced_at > existing.synced_at` guard (used on sales)
 * is intentionally NOT applied here: clients are referenced from many sales,
 * but the API exposes them as nested objects so each fetch sees the latest.
 */
export async function upsertClient(sql: Sql, c: SusiiClientRow): Promise<void> {
  await sql`
    INSERT INTO susii.clients (
      id, name, alias, document_type, document_number, address,
      phone, email, gender, type, business_id, is_active, created_at, synced_at
    ) VALUES (
      ${c.id}, ${c.name}, ${c.alias}, ${c.document_type}, ${c.document_number},
      ${c.address}, ${c.phone}, ${c.email}, ${c.gender}, ${c.type},
      ${c.business}, ${c.is_active ?? true}, ${c.created_at}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      alias = EXCLUDED.alias,
      document_type = EXCLUDED.document_type,
      document_number = EXCLUDED.document_number,
      address = EXCLUDED.address,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      gender = EXCLUDED.gender,
      type = EXCLUDED.type,
      business_id = EXCLUDED.business_id,
      is_active = EXCLUDED.is_active,
      synced_at = now()
  `;
}

/**
 * Upsert sale header. `synced_at` advances so subsequent runs that fetch the
 * same sale (because it falls in the watermark window) idempotently overwrite
 * staler values with newer values from the API.
 */
export async function upsertSale(sql: Sql, s: SusiiSale): Promise<void> {
  await sql`
    INSERT INTO susii.sales (
      id, date, due_date, number, client_id, business_id, user_id, currency_code,
      exchange_rate, discount, discount_percent, discount_type, rounding,
      tax, is_active, is_paid, details, note, observations, prepaid_amount,
      other_charges, service_charge, service_charge_multiplier_factor,
      amount_in_letters, uuid, created_at, synced_at
    ) VALUES (
      ${s.id}, ${s.date}, ${s.due_date}, ${s.number}, ${s.client?.id ?? null},
      ${s.business}, ${s.user}, ${s.currency_code}, ${s.exchange_rate},
      ${s.discount}, ${s.discount_percent}, ${s.discount_type}, ${s.rounding},
      ${s.tax}, ${s.is_active}, ${s.is_paid}, ${s.details}, ${s.note},
      ${s.observations}, ${s.prepaid_amount}, ${s.other_charges},
      ${s.service_charge}, ${s.service_charge_multiplier_factor},
      ${s.amount_in_letters}, ${s.uuid}, ${s.created_at}, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      date = EXCLUDED.date,
      due_date = EXCLUDED.due_date,
      number = EXCLUDED.number,
      client_id = EXCLUDED.client_id,
      business_id = EXCLUDED.business_id,
      user_id = EXCLUDED.user_id,
      currency_code = EXCLUDED.currency_code,
      exchange_rate = EXCLUDED.exchange_rate,
      discount = EXCLUDED.discount,
      discount_percent = EXCLUDED.discount_percent,
      discount_type = EXCLUDED.discount_type,
      rounding = EXCLUDED.rounding,
      tax = EXCLUDED.tax,
      is_active = EXCLUDED.is_active,
      is_paid = EXCLUDED.is_paid,
      details = EXCLUDED.details,
      note = EXCLUDED.note,
      observations = EXCLUDED.observations,
      prepaid_amount = EXCLUDED.prepaid_amount,
      other_charges = EXCLUDED.other_charges,
      service_charge = EXCLUDED.service_charge,
      service_charge_multiplier_factor = EXCLUDED.service_charge_multiplier_factor,
      amount_in_letters = EXCLUDED.amount_in_letters,
      synced_at = now()
  `;
}

/**
 * Replace all line items for a sale. delete-then-insert handles two issues:
 *
 *   1. Susii does not guarantee `items[].id` stability across edits — a
 *      reordered cart could send the same line under a new id. Pure
 *      ON CONFLICT(id) would orphan the old row.
 *   2. Lines deleted upstream must vanish from the DB. ON CONFLICT alone
 *      cannot express that.
 *
 * Wrap in a single transaction at the caller level so a partial failure
 * doesn't leave the sale with no lines.
 */
export async function replaceSaleItems(sql: Sql, saleId: number, items: SusiiSaleItem[]): Promise<void> {
  await sql`DELETE FROM susii.sale_items WHERE sale_id = ${saleId}`;
  if (items.length === 0) return;
  for (const i of items) {
    await sql`
      INSERT INTO susii.sale_items (
        id, sale_id, product_id, name, code, quantity, price, tax,
        tax_reference, discount, discount_type, discount_percent,
        discount_with_tax, isc_percent, icbper_base, observations,
        group_id, created_at, synced_at
      ) VALUES (
        ${i.id}, ${saleId}, ${i.product}, ${i.name}, ${i.code},
        ${i.quantity}, ${i.price}, ${i.tax}, ${i.tax_reference},
        ${i.discount}, ${i.discount_type}, ${i.discount_percent},
        ${i.discount_with_tax}, ${i.isc_percent}, ${i.icbper_base},
        ${i.observations}, ${i.group_id}, ${i.created_at}, now()
      )
    `;
  }
}

export async function replacePayments(sql: Sql, saleId: number, payments: SusiiPayment[]): Promise<void> {
  await sql`DELETE FROM susii.payments WHERE sale_id = ${saleId}`;
  if (payments.length === 0) return;
  for (const p of payments) {
    await sql`
      INSERT INTO susii.payments (
        id, sale_id, date, business_payment_method_id, currency_code,
        amount, is_paid, is_active, user_id, observations, type, synced_at
      ) VALUES (
        ${p.id}, ${saleId}, ${p.date}, ${p.business_payment_method},
        ${p.currency_code}, ${p.amount}, ${p.is_paid}, ${p.is_active},
        ${p.user}, ${p.observations}, ${p.type}, now()
      )
    `;
  }
}

export async function replaceDocuments(sql: Sql, saleId: number, docs: SusiiDocument[]): Promise<void> {
  await sql`DELETE FROM susii.documents WHERE sale_id = ${saleId}`;
  if (docs.length === 0) return;
  for (const d of docs) {
    await sql`
      INSERT INTO susii.documents (
        id, sale_id, serial_id, document_name, type, igv, isc, icbper,
        total, payable, currency, is_active, payment_form, document_state,
        rounding, service_charge, global_allowance, client_name,
        client_document_type, client_document_number, digest_value,
        pdf_file, issue_date, amount_in_letters, synced_at
      ) VALUES (
        ${d.id}, ${saleId}, ${d.serial}, ${d.document_name}, ${d.type},
        ${d.igv}, ${d.isc}, ${d.icbper}, ${d.total}, ${d.payable},
        ${d.currency}, ${d.is_active}, ${d.payment_form}, ${d.document_state},
        ${d.rounding}, ${d.service_charge}, ${d.global_allowance},
        ${d.client_name}, ${d.client_document_type}, ${d.client_document_number},
        ${d.digest_value}, ${d.pdf_file}, ${d.issue_date},
        ${d.amount_in_letters}, now()
      )
    `;
  }
}

/**
 * Process one sale in a single transaction. Returns a count of children written.
 */
export async function applySaleInTx(
  sql: Sql,
  sale: SusiiSale,
): Promise<{ items: number; payments: number; documents: number }> {
  let result = { items: 0, payments: 0, documents: 0 };
  await sql.begin(async (txHandle) => {
    // postgres.js' TransactionSql shares the tagged-template call shape with
    // Sql but lacks .CLOSE/.END; cast through unknown so the upsert helpers
    // (typed against the connection-shaped Sql) can run inside the tx.
    const tx = txHandle as unknown as Sql;
    // Susii sometimes returns `client: null` for anonymous walk-ins. The
    // schema allows NULL on sales.client_id, so skip the client upsert in
    // that case — upsertSale will write NULL into the FK column.
    if (sale.client) await upsertClient(tx, sale.client);
    await upsertSale(tx, sale);
    await replaceSaleItems(tx, sale.id, sale.items);
    await replacePayments(tx, sale.id, sale.payments);
    await replaceDocuments(tx, sale.id, sale.document_set);
    result = {
      items: sale.items.length,
      payments: sale.payments.length,
      documents: sale.document_set.length,
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// sync_log helpers
// ---------------------------------------------------------------------------

export interface SyncLogStart {
  runId: number;
}

export async function startSyncRun(sql: Sql): Promise<SyncLogStart> {
  // Reap orphans: any "running" row from a previous boot that's been hanging
  // for >5 minutes is dead. (Container restart leaves the row behind because
  // the writer never reached the COMMIT.)
  await sql`
    UPDATE susii.sync_log
    SET status = 'failed',
        finished_at = now(),
        error = 'orphaned: server restarted mid-run'
    WHERE status = 'running'
      AND started_at < now() - interval '5 minutes'
  `;
  // Concurrency guard: refuse to start if anything is currently running.
  const running = await sql<{ count: number }[]>`
    SELECT count(*)::int FROM susii.sync_log WHERE status = 'running'
  `;
  if (running[0].count > 0) {
    throw new Error("susii sync already in progress (sync_log has a running row younger than 5 minutes)");
  }
  const ins = await sql<{ id: number }[]>`
    INSERT INTO susii.sync_log (status) VALUES ('running') RETURNING id
  `;
  return { runId: ins[0].id };
}

export async function finishSyncRun(
  sql: Sql,
  runId: number,
  args: {
    status: "success" | "partial" | "failed";
    fetched: number;
    upserted: number;
    lastSaleDate: string | null;
    error: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE susii.sync_log
    SET status = ${args.status},
        finished_at = now(),
        records_fetched = ${args.fetched},
        records_upserted = ${args.upserted},
        last_sale_date = ${args.lastSaleDate},
        error = ${args.error}
    WHERE id = ${runId}
  `;
}

/**
 * Resolve the watermark for an incremental sync.
 *
 * Order of preference:
 *   1. Latest successful sync_log.last_sale_date (the natural watermark).
 *   2. MAX(sales.synced_at) — fallback if sync_log was never populated by
 *      the new plugin (e.g. legacy backfill from sql-batch left no useful
 *      sync_log rows).
 *   3. fallbackIso (typically a hard floor like '2024-01-01' for full backfill).
 *
 * The returned value is fed to Susii as `date__gte=YYYY-MM-DD`. Susii's
 * `modified_after` filter is silently a no-op (discovered 2026-05-10), so
 * we use `sale.date` instead. To catch sales whose receipt is older but
 * whose payment/document was modified within the rewind window, we subtract
 * `rewindDays` from the max watermark seen. Default 1 day balances coverage
 * against re-walk cost (~10-30 sales/day for FACES).
 */
export async function resolveWatermark(
  sql: Sql,
  fallbackIso: string,
  rewindDays = 1,
): Promise<string> {
  let rawWatermark: string | null = null;
  const fromLog = await sql<{ last_sale_date: string | null }[]>`
    SELECT last_sale_date
    FROM susii.sync_log
    WHERE status = 'success' AND last_sale_date IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 1
  `;
  if (fromLog[0]?.last_sale_date) rawWatermark = fromLog[0].last_sale_date;

  if (!rawWatermark) {
    const fromSales = await sql<{ max: string | null }[]>`
      SELECT max(date)::text AS max FROM susii.sales
    `;
    if (fromSales[0]?.max) rawWatermark = fromSales[0].max;
  }

  if (!rawWatermark) rawWatermark = fallbackIso;

  // Rewind by N days and truncate to YYYY-MM-DD (date__gte is date-only granularity)
  const parsed = new Date(rawWatermark);
  if (isNaN(parsed.getTime())) return rawWatermark.slice(0, 10); // last-ditch: assume ISO prefix
  parsed.setUTCDate(parsed.getUTCDate() - rewindDays);
  return parsed.toISOString().slice(0, 10);
}
