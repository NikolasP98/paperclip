# Susii → Supabase ETL — Architecture Design (FACES SCULPTORS)

**Status:** Design locked 2026-05-09. Implementation NOT started. Revised same day to normalized multi-grain schema after empirical xlsx audit.
**Origin:** User directive after FAC-111 hermes vs claude eval — *"download a fresh financial copy, load the data into the database in a org-specific supabase table, and use the data there to create financial reports."*
**Reviewers:** Four parallel engineering review agents across two rounds — round 1: audit + pressure-test (locked plugin-job + Supabase); round 2: empirical xlsx grain audit + multi-grain schema design (locked Option A normalized split).

---

## ⚠ PIVOT 2026-05-09 22:20 — REST API mirror, not xlsx

Phase 0 discovery overturned a core premise. **All sections below referencing xlsx parsing, Option A normalized split, `transactions`/`transaction_lines`/`procedures`/`dead_letter`, and `(branch, receipt_number)` PK are SUPERSEDED by this section.** They remain as historical context for *why* the schema looks the way it does (grain awareness, idempotency, receipt vs line vs payment grain).

**What changed:**

1. **`susii` schema is NOT greenfield.** Project `fsdaqawhzvlphcbxzzji` already had 6 empty tables: `sales`, `sale_items`, `payments`, `documents`, `clients`, `sync_log`. Schema mirrors **Susii REST API JSON shape** (`id` PK from Susii server, FK by `sale_id`), not xlsx grain.
2. **Susii REST API is rich.** `GET /v1/sales/sales/?business=<id>&modified_after=<iso>` (DRF Token auth) returns paginated sales — each result is a single JSON document containing nested `client`, `items[]`, `payments[]`, `document_set[]`. One endpoint replaces 4 xlsx exports + parsing + grain reasoning.
3. **No existing writer.** `grep -rln susii\.sales` across paperclip + minion + hub = zero hits. The 6 tables exist but nothing populates them. Pivot is clean.
4. **User decision (2026-05-09):** "Pivot to existing schema (API-shape)." Re-architect plugin to ingest via Susii REST API (JSON), not xlsx. Update design doc + plan. xlsx fallback only.
5. **RLS:** disabled, will stay disabled. Network/role-only lockdown (cfo_readonly + service-role-only API access).

**New pipeline shape:**

```
plugin job tick (cron) →
  GET /v1/sales/sales/?business=5922&modified_after=<last_run_started_at - 5min> (paginate via .next)
  for each sale in results:
    upsert susii.clients (from sale.client) ON CONFLICT (id) DO UPDATE
    upsert susii.sales (top-level) ON CONFLICT (id) DO UPDATE WHERE EXCLUDED.synced_at > existing.synced_at
    delete-then-insert susii.sale_items WHERE sale_id = X (from sale.items)
    delete-then-insert susii.payments WHERE sale_id = X (from sale.payments)
    delete-then-insert susii.documents WHERE sale_id = X (from sale.document_set)
  write susii.sync_log row with counts + last_sale_date
  (no dead_letter — JSON parses or doesn't; on parse failure, row is logged with error and sync_log.error is set)
```

**What's preserved from the original design:**

- Plugin job (agent-free) over routine. Same reliability rationale.
- `requiredSecrets:[...]` manifest enforcement.
- Watermark via `modified_after` query param (REST equivalent of `xlsx_sha256` skip).
- Header-before-children write order with delete-then-insert on `items`/`payments`/`documents`.
- CFO never gets service-role keys; reads via `cfo_readonly` role + views (Phase 7).
- Sticky watermark in `sync_log.last_sale_date`; orphan reaper from Phase 5 still applies.

**What's discarded:**

- xlsx download / `xlsx_sha256` / 8-row title-block parsing.
- `(branch, receipt_number)` natural PK — using Susii `id` (int8) instead. Receipt number kept as `sales.number` for human queries.
- `transactions`/`transaction_lines`/`procedures`/`dead_letter` table names (use `sales`/`sale_items`/`products`(future)/skip).
- Empirical discount invariant check (`Σ TOTAL(ITEM) − IMPORTE = DESCUENTO GLOBAL`) — discount fields are first-class on `sales` (`discount`, `discount_percent`, `discount_amount_with_tax`) directly from API. No reconstruction needed.
- "Branch" dimension — Susii API doesn't expose branch on `/v1/sales/sales/`; deferred until multi-location.

**What might still be needed (deferred to Phase 4):**

- `susii.products` table (mirror of `/v1/products/products/`) for procedure-name lookups when `sale_items.code/name` is stale.
- Backfill strategy: `modified_after` paginated walk works for both incremental + 28-month backfill (just point it at 2024-01-01). No separate xlsx-monthly-chunk path needed.

---

## TL;DR

Replace the current ad-hoc CFO workflow (download xlsx in workspace → parse inline → analyze) with a deterministic two-layer pipeline:

1. **Ingestion (no LLM):** Paperclip plugin job runs cron-scheduled, pulls fresh Susii reports via API, upserts into FACES Supabase under a dedicated `susii` schema. Failures escalate to issues.
2. **Analysis (LLM):** CFO + Reporting Agent + Data Analyst query Supabase via a new `supabase-finanzas` skill (read-only role). Same agents, but now they read normalized rows instead of parsing xlsx.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage target | FACES Supabase `fsdaqawhzvlphcbxzzji.supabase.co` | Reuse existing project; greenfield from Paperclip's perspective. |
| Schema isolation | Dedicated `susii` schema in same project | Keeps BI tables isolated from any future FACES app tables. One billing line. |
| Trigger model | **Paperclip plugin job (agent-free, in-process)** | Deterministic ETL doesn't need an LLM; sidesteps `wakeup_coalescing` and Hermes `process_lost`. LLM enters only on failure escalation. |
| Backfill | 28 months on day 1, monthly chunks, sequential | Separate one-off backfill (not the ongoing job). Respects Susii rate limits. |
| Receipt PK | `(branch, receipt_number)` | Per-branch scope safe even if FACES grows to multi-location. `DOCUMENTOS` is null for ~40% of rows (boletas without electronic invoice) — `NÚMERO` is the right PK. |
| **Schema grain** | **Three-table normalized split: `transactions` + `transaction_lines` + `payments`** | Empirical 28-month audit confirmed every receipt-grain column duplicates verbatim across line-item rows (588 multi-line receipts, 100% duplication). Single-table designs caused FAC-92 5.36M→2.90M correction. |
| Analysis consumer | CFO agent (+ Reporting + Data Analyst) only | No human dashboard in v1. Read-only `supabase-finanzas` skill wraps SQL. |

## Empirical xlsx grain audit (2026-05-09, 28 months / 4138 rows / 3303 receipts / 588 multi-line)

The Susii sales xlsx is a **denormalized fact table with three grains collapsed into one row**:

| Grain | Columns (verbatim) |
|---|---|
| **Receipt-grain** (duplicated 100% across line rows) | `NÚMERO`, `DOCUMENTOS`, `FECHA`, `NOMBRE/DIRECCIÓN/RUC-DNI/EMAIL (CLIENTE)`, `MONEDA`, `TIPO DE CAMBIO`, `IGV`, `IMPORTE TOTAL DEL COMPROBANTE`, `DESCUENTO GLOBAL CON IGV`, `RECARGO AL CONSUMO`, `ESTADO`, `VENDEDOR`, `OBSERVACIONES`, `NOTAS`, `ORDEN DE COMPRA`, `GUÍA DE REMISIÓN` |
| **Line-grain** (varies per row) | `CÓDIGO (ITEM)`, `DESCRIPCIÓN (ITEM)`, `CATEGORÍA (ITEM)`, `TIPO DE IMPUESTO (ITEM)`, `VALOR UNITARIO (ITEM)`, `PRECIO UNITARIO (ITEM)`, `CANTIDAD (ITEM)`, `DESCUENTO CON IGV (ITEM)` (always 0 in 28mo), `TOTAL (ITEM)`, `ALIAS (ITEM)` |
| **Payment-grain** (in `ReportePagos`) | `MÉTODO (PAGO)`, `FECHA (PAGO)`, `ESTADO (PAGO)`, `MONTO DE DEUDA (PAGO)`, `MONTO DE PAGO (PAGO)`, `OBSERVACIONES (PAGO)`. Only 4/2937 receipts have multiple payments. |

**Verified arithmetic invariant (203/203 = 100% of discounted receipts):**
```
Σ TOTAL (ITEM)  −  IMPORTE TOTAL DEL COMPROBANTE  =  DESCUENTO GLOBAL CON IGV
```
Receipt total is post-discount; line totals are pre-discount; discounts are exclusively receipt-grain. ETL must preserve this relationship and assert it post-upsert as an integrity check.

**`ESTADO`** is consistent across all rows of a receipt (no mixed states observed). Existing CFO rule "agrupar por NUMERO, excluir Anulado" is correct and remains the canonical filter.

**Single-branch caveat:** the audited dataset is single-branch (`NÚMERO` monotonic 00001..03303 across 28 months — no resets). Multi-branch collision behavior is unverified; PK includes `branch` for forward-compat.

## Schema (Postgres / Supabase)

All under `susii` schema for isolation.

### Core tables (3-table normalized split — Option A)

```sql
-- Receipt header: one row per physical receipt. Receipt-grain fields only.
CREATE TABLE susii.transactions (
  branch              text NOT NULL,
  receipt_number      text NOT NULL,            -- NÚMERO, zero-padded text from xlsx
  documento_number    text,                     -- DOCUMENTOS, nullable (~40% of rows: boletas without invoice)
  issued_at           timestamptz NOT NULL,     -- FECHA parsed as Lima local
  customer_id         text,                     -- RUC/DNI ('00000000' = unknown — do NOT treat as join key)
  customer_name       text,
  customer_address    text,
  customer_email      text,
  currency            text DEFAULT 'PEN',
  exchange_rate       numeric(12,4),
  igv                 numeric(12,2),            -- receipt-level tax
  total_amount        numeric(12,2) NOT NULL,   -- IMPORTE TOTAL DEL COMPROBANTE (post-discount)
  global_discount     numeric(12,2) DEFAULT 0,  -- DESCUENTO GLOBAL CON IGV (receipt-grain — never split)
  consumption_charge  numeric(12,2) DEFAULT 0,  -- RECARGO AL CONSUMO
  status              text NOT NULL,            -- ESTADO: 'Procedió' | 'Anulado'
  salesperson         text,                     -- VENDEDOR
  observations        text,                     -- OBSERVACIONES
  notes               text,                     -- NOTAS
  purchase_order      text,                     -- ORDEN DE COMPRA
  guide_number        text,                     -- GUÍA DE REMISIÓN
  -- ETL-computed integrity field (see Implementation guardrail #3):
  net_total           numeric(12,2),            -- = SUM(transaction_lines.total) for this receipt
  raw                 jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  sync_run_id         uuid NOT NULL,
  PRIMARY KEY (branch, receipt_number)
);

CREATE INDEX tx_issued_at_idx          ON susii.transactions (issued_at DESC);
CREATE INDEX tx_customer_idx           ON susii.transactions (customer_id, issued_at) WHERE customer_id <> '00000000';
CREATE INDEX tx_status_active_idx      ON susii.transactions (issued_at) WHERE status <> 'Anulado';
CREATE INDEX tx_salesperson_idx        ON susii.transactions (salesperson, issued_at);

-- Procedures sold per receipt: line-grain. ON DELETE CASCADE so re-runs can delete+reinsert cleanly.
CREATE TABLE susii.transaction_lines (
  branch              text NOT NULL,
  receipt_number      text NOT NULL,
  line_seq            int  NOT NULL,            -- 1-based, derived from xlsx row order within the receipt group
  procedure_code      text,                     -- CÓDIGO (ITEM)
  procedure_name      text,                     -- DESCRIPCIÓN (ITEM)
  category            text,                     -- CATEGORÍA (ITEM)
  tax_type            text,                     -- TIPO DE IMPUESTO (ITEM)
  unit_value          numeric(12,4),            -- VALOR UNITARIO (ITEM)
  unit_price          numeric(12,4),            -- PRECIO UNITARIO (ITEM)
  quantity            numeric(12,4) NOT NULL,   -- CANTIDAD (ITEM)
  line_discount       numeric(12,2) DEFAULT 0,  -- DESCUENTO CON IGV (ITEM) — always 0 in 28mo of data; keep for forward-compat
  total               numeric(12,2) NOT NULL,   -- TOTAL (ITEM), pre-global-discount
  alias               text,                     -- ALIAS (ITEM)
  raw                 jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  sync_run_id         uuid NOT NULL,
  PRIMARY KEY (branch, receipt_number, line_seq),
  FOREIGN KEY (branch, receipt_number)
    REFERENCES susii.transactions (branch, receipt_number)
    ON DELETE CASCADE
);

CREATE INDEX tl_procedure_idx          ON susii.transaction_lines (procedure_code);
CREATE INDEX tl_category_idx           ON susii.transaction_lines (category);

-- Payments (instalments) per receipt. Only 4/2937 multi-payment in 28mo, but pattern same as lines.
CREATE TABLE susii.payments (
  branch              text NOT NULL,
  receipt_number      text NOT NULL,
  payment_seq         int  NOT NULL,            -- ordering within receipt
  paid_at             timestamptz,              -- FECHA (PAGO)
  method              text,                     -- MÉTODO (PAGO): PLIN | Transferencia Bancaria | Efectivo | ...
  status              text,                     -- ESTADO (PAGO)
  debt_amount         numeric(12,2),            -- MONTO DE DEUDA (PAGO)
  payment_amount      numeric(12,2),            -- MONTO DE PAGO (PAGO)
  observations        text,                     -- OBSERVACIONES (PAGO)
  raw                 jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  sync_run_id         uuid NOT NULL,
  PRIMARY KEY (branch, receipt_number, payment_seq),
  FOREIGN KEY (branch, receipt_number)
    REFERENCES susii.transactions (branch, receipt_number)
    ON DELETE CASCADE
);

CREATE INDEX pmt_paid_at_idx           ON susii.payments (paid_at DESC);
CREATE INDEX pmt_method_idx            ON susii.payments (method);

-- Reference catalogs (independent reports)
CREATE TABLE susii.clientes (
  client_id           text PRIMARY KEY,         -- Susii's own ID
  raw                 jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  sync_run_id         uuid NOT NULL
);

CREATE TABLE susii.procedures (
  procedure_code      text PRIMARY KEY,
  raw                 jsonb NOT NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  sync_run_id         uuid NOT NULL
);
```

> **Note on `receipt_serie`:** the audited xlsx exports do not surface a separate serie column — `NÚMERO` alone is monotonic 00001..03303 across 28 months in a single-branch dataset. If multi-branch is later confirmed and Susii exposes a serie field, add `receipt_serie` to the PK before 1000+ rows of historical data make migration painful. Either way, `branch` stays in the PK.

### Operational tables

```sql
CREATE TABLE susii.sync_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind              text NOT NULL,       -- 'sales' | 'pagos' | 'clientes' | 'procedures'
  period_start             date,
  period_end               date,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  status                   text NOT NULL,       -- 'running' | 'ok' | 'failed' | 'partial' | 'skipped_unchanged'
  rows_in                  int,                 -- xlsx rows consumed
  -- Split counts so we can spot half-failures (header-phase ok, line-phase failed):
  transactions_upserted    int,
  lines_deleted            int,                 -- from delete-then-insert phase on lines
  lines_upserted           int,
  payments_upserted        int,
  rows_dead_lettered       int,
  -- Integrity check fail count: receipts where transactions.net_total ≠ SUM(transaction_lines.total) post-upsert.
  integrity_violations     int DEFAULT 0,
  xlsx_sha256              text,
  error_text               text,
  triggered_by             text NOT NULL        -- 'plugin_job:susii-etl' | 'manual:<user>' | 'backfill:<window>'
);

CREATE TABLE susii.dead_letter (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id         uuid NOT NULL REFERENCES susii.sync_runs(id),
  report_kind         text NOT NULL,
  raw                 jsonb NOT NULL,
  error_text          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
```

### Read-only views (for CFO consumption)

> **Grain rule:** receipt-grain aggregations (revenue, discount, customer counts, AOV) read ONLY from `susii.transactions`. `transaction_lines` is touched ONLY when the query needs procedure-level breakdown. Any view that violates this rule will N×-overcount denormalized fields. Document the rule as an inline SQL comment in every view.

```sql
-- Monthly revenue: receipt-grain ONLY. Uses ETL-computed net_total — no JOIN to lines.
CREATE VIEW susii.v_monthly_sales AS
  -- Receipt-grain only. Do NOT join transaction_lines or counts/discounts will N×.
  SELECT date_trunc('month', issued_at)::date AS month,
         count(*)                              AS receipts,
         sum(net_total)                        AS revenue,
         avg(net_total)                        AS avg_ticket,
         sum(global_discount)                  AS total_discount,
         count(distinct customer_id) FILTER (WHERE customer_id <> '00000000') AS unique_known_customers
  FROM susii.transactions
  WHERE status <> 'Anulado'
  GROUP BY 1;

-- Top procedures: line-grain. JOIN to transactions ONLY to filter by status — never sum receipt-grain fields here.
CREATE VIEW susii.v_top_procedures AS
  -- Line-grain. Filter via transactions.status; never SUM receipt-grain fields in this view.
  SELECT tl.procedure_code,
         tl.procedure_name,
         count(*)        AS units_sold,
         sum(tl.total)   AS revenue,
         sum(tl.quantity) AS total_quantity
  FROM susii.transaction_lines tl
  JOIN susii.transactions t USING (branch, receipt_number)
  WHERE t.status <> 'Anulado'
  GROUP BY 1, 2;

-- Customer LTV: receipt-grain ONLY. visits = receipt count, lifetime_spend = sum(net_total). Never join lines.
CREATE VIEW susii.v_customer_ltv AS
  -- Receipt-grain only. visits is receipt count (one appointment = one receipt regardless of procedures sold).
  SELECT customer_id,
         customer_name,
         count(*)             AS visits,
         sum(net_total)       AS lifetime_spend,
         sum(global_discount) AS lifetime_discount,
         min(issued_at)       AS first_visit,
         max(issued_at)       AS last_visit
  FROM susii.transactions
  WHERE status <> 'Anulado'
    AND customer_id <> '00000000'
  GROUP BY 1, 2;

-- AR aging: receipt-grain joined to payments to compute outstanding balance.
CREATE VIEW susii.v_ar_aging AS
  SELECT t.branch, t.receipt_number, t.customer_id, t.customer_name,
         t.issued_at, t.net_total,
         coalesce(sum(p.payment_amount), 0)        AS paid,
         t.net_total - coalesce(sum(p.payment_amount), 0) AS outstanding,
         (now() - t.issued_at)                     AS age
  FROM susii.transactions t
  LEFT JOIN susii.payments p USING (branch, receipt_number)
  WHERE t.status <> 'Anulado'
  GROUP BY 1, 2, 3, 4, 5, 6
  HAVING t.net_total - coalesce(sum(p.payment_amount), 0) > 0;

-- + v_weekly_sales, v_branch_breakdown, v_payment_method_mix as needed
```

## Idempotent upsert pattern (two-phase)

Re-running the same window MUST NOT duplicate rows. Because we have a parent–child relationship with a FK, ETL runs in two phases per receipt batch:

### Phase 1 — upsert headers

```sql
INSERT INTO susii.transactions AS t (
  branch, receipt_number, documento_number, issued_at, customer_id, customer_name,
  total_amount, global_discount, status, salesperson, net_total, raw, sync_run_id, synced_at
)
VALUES (...)
ON CONFLICT (branch, receipt_number)
DO UPDATE SET
  issued_at        = EXCLUDED.issued_at,
  total_amount     = EXCLUDED.total_amount,
  global_discount  = EXCLUDED.global_discount,
  status           = EXCLUDED.status,
  net_total        = EXCLUDED.net_total,
  raw              = EXCLUDED.raw,
  sync_run_id      = EXCLUDED.sync_run_id,
  synced_at        = EXCLUDED.synced_at
WHERE EXCLUDED.synced_at > t.synced_at;
```

The `WHERE EXCLUDED.synced_at > t.synced_at` guard prevents an out-of-order retry from clobbering newer data.

### Phase 2 — delete-then-insert lines and payments

Line-level upserts are unreliable because `line_seq` is positional in the xlsx — Susii could reorder rows within a receipt between exports. Instead, scope a delete to only the receipts touched in this batch, then plain-insert. ON DELETE CASCADE on the FK is irrelevant here because we delete the children directly, not the parents.

```sql
-- Delete lines for receipts in this batch
DELETE FROM susii.transaction_lines
WHERE (branch, receipt_number) IN (<batch of (branch, receipt_number) tuples>);

INSERT INTO susii.transaction_lines (branch, receipt_number, line_seq, ...)
VALUES (...);   -- plain insert, no conflict possible after delete

-- Same pattern for payments:
DELETE FROM susii.payments
WHERE (branch, receipt_number) IN (<same batch>);

INSERT INTO susii.payments (branch, receipt_number, payment_seq, ...)
VALUES (...);
```

Track `lines_deleted`, `lines_upserted`, `payments_upserted` separately on `sync_runs`.

### Phase 3 — post-upsert integrity check

For every receipt touched in this batch, assert the arithmetic invariant:

```sql
SELECT t.branch, t.receipt_number,
       t.net_total,
       t.total_amount + t.global_discount AS reconstructed,
       sum(tl.total)                       AS sum_lines
FROM susii.transactions t
JOIN susii.transaction_lines tl USING (branch, receipt_number)
WHERE (t.branch, t.receipt_number) IN (<batch>)
GROUP BY 1, 2, 3, 4
HAVING abs(sum(tl.total) - (t.total_amount + t.global_discount)) > 0.01;
```

Any rows returned are integrity violations: dead-letter them and increment `sync_runs.integrity_violations`. Don't fail the run — log + escalate.

## Plugin shape (`packages/plugins/susii-etl/`)

```
susii-etl/
├── manifest.json        # declares jobs.schedule, requiredSecrets
├── src/
│   ├── index.ts         # plugin entrypoint
│   ├── susii-client.ts  # auth, export-job, poll, download
│   ├── parser.ts        # xlsx → typed rows (parse by header name)
│   ├── upserter.ts      # batched upserts, dead-letter, sync_runs
│   └── reports.ts       # per-report orchestration (sales, payments, ...)
└── package.json
```

### Manifest (sketch)

```json
{
  "name": "susii-etl",
  "version": "0.1.0",
  "requiredSecrets": ["SUSII_API_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"],
  "jobs": [
    {
      "key": "daily-sync",
      "schedule": "0 6 * * * America/Lima",
      "concurrencyPolicy": "skip_if_active",
      "maxDurationMs": 1800000
    },
    {
      "key": "manual-backfill",
      "trigger": "manual"
    }
  ]
}
```

### Pipeline flow

```
plugin job tick (cron) →
  for each report_kind in [sales, pagos, clientes, procedures]:
    1.  Compute window (yesterday + last 7 days for incremental safety)
    2.  Auth Susii (DRF Token from ctx.secrets.SUSII_API_TOKEN)
    3.  POST /v1/stats/requested-reports/ → job_id
    4.  Poll until state=3 (ready), max 10min, exp backoff
    5.  Download xlsx (presigned storage.susii.com URL)
    6.  sha256 → if matches last sync_runs.xlsx_sha256 for same window → skip with status='skipped_unchanged'
    7.  Cache xlsx to /paperclip/instances/default/data/susii-cache/<run_id>.xlsx
    8.  Parse by header NAME (not index); per-row try/catch; bad rows → susii.dead_letter
    9.  Group rows by (branch, receipt_number); compute net_total = SUM(line.total) per receipt
    10. Phase 1: upsert susii.transactions (header batch first, with computed net_total)
    11. Phase 2: DELETE susii.transaction_lines + susii.payments for batch receipts; INSERT fresh rows
    12. Phase 3: integrity check — assert SUM(lines.total) ≈ total_amount + global_discount per receipt; dead-letter violations
    13. Insert susii.sync_runs row with all split counts (transactions/lines/payments/integrity_violations)
  if any report failed → post failure-summary issue, mention CFO + CTO
```

### Failure modes

| Mode | Behavior |
|---|---|
| Susii 5xx / timeout | Retry 3× with exp backoff inside the run. On final fail → `sync_runs.status='failed'`, post issue. Next cron retry retries the same window (idempotent). |
| Susii 401 (token rotated) | Fail fast with `auth_failed` status. Open issue with `human_required` blocker. No silent retries against rotated creds. |
| Supabase down | Fail fast. xlsx already cached — retry skips re-export. |
| Schema drift (unknown header) | Continue parsing what we know; alert if dead_letter ratio > 1%. Raw row preserved in `jsonb` for backfill once parser updated. |
| Stuck run | `concurrencyPolicy: skip_if_active` + `maxDurationMs: 30min` kill. Stuck run becomes a visible failure, not silent. |

## Secret management

**Single source of truth: Infisical `minion-paperclip` prod env.**

New secrets to provision:
- `SUSII_API_TOKEN` (DRF token, 40 chars)
- `SUPABASE_SERVICE_ROLE_KEY` (FACES project, JWT)
- `SUPABASE_URL` (`https://fsdaqawhzvlphcbxzzji.supabase.co`)

Plugin manifest's `requiredSecrets:[...]` enforces presence at plugin registration time. If any are missing, paperclip refuses to register the plugin → boot-time error, not a silent runtime 401 hours into a cron tick.

`/paperclip/.hermes/.env` stays as the local-dev escape hatch only.

## Backfill plan

Separate one-off operation, NOT part of the ongoing daily job:
1. Manual trigger: `POST /api/plugins/susii-etl/jobs/manual-backfill {"start":"2024-01-01","end":"2026-04-30"}`
2. Plugin walks monthly windows sequentially (28 chunks).
3. Each window writes its own `sync_runs` row with `triggered_by='backfill:2024-01'`.
4. On failure of a single window, others continue. Failed windows can be re-triggered individually.

## CFO-side `supabase-finanzas` skill (v1)

New skill at `/paperclip/.claude/skills/supabase-finanzas/SKILL.md`. Wraps the Supabase REST endpoint with a **`cfo_readonly` role** (NOT service-role). Skill helpers:

- `revenue_by_period(start, end)` → table
- `compare_periods(a_start, a_end, b_start, b_end)` → MoM / YoY delta
- `top_customers(n, period)`
- `top_procedures(n, period)`
- `weekly_breakdown(start, end)`
- `customer_visits(customer_id)` (when researching specific clients)

Service-role key stays exclusively in the ETL plugin. CFO never touches it.

## Top risks (from review)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|---|---|---|
| 1 | Susii xlsx column rename/reorder breaks parser silently | High | Data corruption | Parse by header name; store raw jsonb; alert when unknown headers appear |
| 2 | Susii API token rotates, ETL silently 401s for days | Medium | Stale data → wrong CFO decisions | `auth_failed` blocker + weekly health check `last_ok_run < 26h` |
| 3 | 28-month backfill hits Susii rate limits | High on first run | Backfill fails | Sequential monthly chunks + exp backoff + per-window retry |
| 4 | service-role key leaked via run logs | Medium | Full DB compromise | Plugin scrubs secrets from logs; only `ctx.secrets.get` in-memory; Supabase RLS as defense-in-depth |
| 5 | Coalesced runs hide stuck pipeline | Medium | Pipeline appears "running" forever | `skip_if_active` + 30min kill |
| 6 | Susii reorders rows within a receipt between exports → `line_seq` drift breaks naive line upsert | Low–Medium | Phantom inserts / lost lines | Phase-2 delete-then-insert (no per-line ON CONFLICT). Alert if a receipt's `line_count` changes unexpectedly between runs. |
| 7 | Multi-grain mistake in CFO views (joining lines for receipt-level math) | Medium long-term | N×-overcounting metrics | Inline grain-rule SQL comment in every view; `net_total` denormalized on `transactions` so revenue queries never need to JOIN. |

## Implementation guardrails (Option A non-negotiables)

Three things the implementer MUST NOT skip when building the normalized split:

1. **FK with `ON DELETE CASCADE` + header-before-lines write order.** ETL must group xlsx rows by receipt and flush all transaction headers in a batch before any lines/payments for that batch. Re-runs use Phase-2 delete-then-insert on lines and payments for receipts in the batch, never per-line `ON CONFLICT`. CASCADE keeps the system clean if a receipt is ever deleted upstream.

2. **CFO views NEVER touch `transaction_lines` for receipt-grain aggregations.** `SUM(global_discount)`, `COUNT(receipts)`, `SUM(net_total)`, customer LTV — all read from `susii.transactions` ONLY. The only views that JOIN to lines are procedure-breakdown views (`v_top_procedures`). Document the rule as an inline SQL comment in every view definition; the next developer or LLM maintaining views WILL be tempted to "helpfully" add `transaction_lines` to a receipt-level view and reintroduce N× counting.

3. **`net_total` on `transactions` is ETL-computed at ingest** (= `SUM(line.total)` for the receipt). Two payoffs: (a) revenue queries never need a JOIN, eliminating the most common multi-grain mistake; (b) post-upsert integrity check is trivial — assert `transactions.net_total ≈ SUM(transaction_lines.total)` per receipt. Empirically also asserts `transactions.total_amount + transactions.global_discount = SUM(transaction_lines.total)` (verified 203/203 = 100% of discounted receipts in 28-month audit). Violations dead-letter and increment `sync_runs.integrity_violations`.

## Implementation outline (NOT a plan — a sketch)

1. Provision FACES Supabase: create `susii` schema, run migrations for tables + indexes + views, create `cfo_readonly` role.
2. Write secrets to Infisical `minion-paperclip` prod (`SUSII_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`).
3. Scaffold `packages/plugins/susii-etl/` (manifest, src, package.json). Port Susii client logic from `reportes-susii` Python skill to TypeScript.
4. Wire upserter using `@supabase/supabase-js` (or `pg` directly with SSL). Use COPY-style batched upserts.
5. End-to-end test against ONE report (sales) ONE month → verify rows in Supabase + sync_runs row present.
6. Run 28-month backfill as one-off. Verify row counts vs xlsx ground-truth on a sampled month.
7. Build `supabase-finanzas` skill. Wire it into CFO + Reporting + Data Analyst extraArgs.
8. Cut over: CFO instructions updated to query Supabase as primary source; reportes-susii skill becomes break-glass only.

Implementation should produce its own per-phase plan. This document is the contract.

## References

- Existing skill: `/paperclip/.hermes/skills/reportes-susii/SKILL.md` (~22 KB) and `/paperclip/.claude/skills/reportes-susii/SKILL.md`
- Routine schema: `packages/db/src/schema/routines.ts` (rejected — agent-bound)
- Plugin job schema: `packages/db/src/schema/plugin_jobs.ts` (chosen)
- Plugin job scheduler: `server/src/services/plugin-job-scheduler.ts`
- Existing plugin example: `packages/plugins/github-agent-trigger/`
- Susii API auth: DRF `Authorization: Token <40-char>`; report_codes verified `export_sales`, `export_sale_payments`
- FAC-101 (blocked) — original symptom that drove this design
- FAC-111 (done) — claude_local FAC-24 baseline replication that proved analysis quality is fine, ETL was the missing layer
