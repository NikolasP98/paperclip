# Susii → Supabase ETL — Phased Implementation Plan

**Status:** Plan amended 2026-05-09 22:20 — pivoted from xlsx ingestion to Susii REST API after Phase 0 discovery. See `SUSII_ETL_DESIGN.md` §PIVOT.
**Design contract:** [`SUSII_ETL_DESIGN.md`](./SUSII_ETL_DESIGN.md) — defines schema, idempotency, plugin shape. This plan defines sequencing + verification gates.
**Goal:** Replace ad-hoc CFO xlsx parsing with deterministic plugin-job ingestion into FACES Supabase + read-only consumption via `supabase-finanzas` skill.

## ⚠ Pivot summary (2026-05-09 22:20)

- **Source:** REST `GET /v1/sales/sales/` (paginated, `modified_after` watermark). xlsx is now fallback-only.
- **Schema:** existing `susii.{sales,sale_items,payments,documents,clients,sync_log}` (6 empty tables, API-mirror shape). NOT the design doc's `transactions/transaction_lines/procedures/dead_letter`.
- **PK:** Susii `id` (int8). NOT `(branch, receipt_number)`.
- **Phase 1 changes:** schema migration becomes minor — only add indexes, `cfo_readonly` role, and (deferred) views. Tables already exist.
- **Phase 2 changes:** plugin parses JSON, not xlsx. Dependencies shrink (no `xlsx`/`exceljs`).
- **Phase 3 changes:** sales pipeline ingests one paginated walk; integrity check becomes "row count vs `count` field in API response" instead of discount invariant.
- **Phase 4 changes:** `products` table likely needs adding (currently no `susii.products` in schema; sale_items denormalize name/code).
- **Phase 5 unchanged:** orphan reaper, `sync_log` telemetry still apply.
- **Phase 6 changes:** backfill = same plugin pointed at `modified_after=2024-01-01`. No xlsx monthly chunks.
- **RLS:** stays disabled per user decision. Defense via cfo_readonly role + service-role-only API access.

## Plan principles

1. **Each phase has a verification gate.** Don't advance until the gate is green.
2. **Each phase is rollback-safe.** Add a "rollback" note for any phase that touches prod state.
3. **No phase touches the CFO's day-to-day workflow** until Phase 8 (cutover). The existing `reportes-susii` skill keeps working until then.
4. **Keep changes within FACES SCULPTORS only** until cutover succeeds. Multi-tenant rollout is a follow-up milestone, not part of this plan.

## Phase summary

| # | Phase | Owner type | Effort | Touches prod? |
|---|---|---|---|---|
| 0 | Pre-flight: Supabase project + Infisical secrets | DBA + ops | S | Read-only checks |
| 1 | Schema migration: tables, indexes, FK, role | DB | S | Yes (FACES Supabase only) |
| 2 | Plugin scaffold + Susii client port | TS dev | M | No |
| 3 | Sales pipeline (transactions + lines) — single-month dev test | TS dev | M | No (dev DB) |
| 4 | Payments + reference catalogs | TS dev | S | No (dev DB) |
| 5 | Integrity check + dead_letter + sync_runs telemetry | TS dev | S | No (dev DB) |
| 6 | 28-month backfill | Ops | M | Yes (FACES Supabase) |
| 7 | CFO consumer: read-only role, views, `supabase-finanzas` skill | DB + skill author | M | Yes (FACES Supabase + agent config) |
| 8 | Cutover + monitoring + handoff | Ops + CFO update | S | Yes (CFO instructions) |

Effort: S = ½–1 day, M = 1–3 days. Total estimate: 8–14 days of focused work.

---

## Phase 0 — Pre-flight

**Goal:** Inventory what exists and provision missing prerequisites BEFORE writing any plugin code.

**Tasks:**

1. Confirm FACES Supabase project `fsdaqawhzvlphcbxzzji.supabase.co` is accessible. Pull `service_role` key from the Supabase dashboard (Settings → API). Verify `anon` key is also retrievable.
2. Pull current Susii API token from `/paperclip/.hermes/.env` on netcup (`docker exec paperclip-server-1 cat /paperclip/.hermes/.env | grep SUSII`). If the token is missing or stale, re-auth via `POST /auth/login/` with stored username+password and capture the fresh `key`.
3. Provision Infisical secrets in `minion-paperclip` prod env:
   - `SUSII_API_TOKEN` (40-char DRF token)
   - `SUSII_USERNAME`, `SUSII_PASSWORD` (for token-rotation re-auth path)
   - `SUSII_BUSINESS_ID`, `SUSII_USER_PK` (FACES-specific request params)
   - `SUPABASE_URL` = `https://fsdaqawhzvlphcbxzzji.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` (FACES JWT)
4. Verify the paperclip server picks up the new secrets at boot (`docker exec paperclip-server-1 printenv | grep -E 'SUSII|SUPABASE'`).
5. Stand up a Supabase dev branch (or a separate scratch project) for Phases 2–5 testing — DO NOT develop against prod FACES tables.

**Verification gate:**
- [ ] `infisical secrets get SUSII_API_TOKEN --env=prod --projectId=<minion-paperclip>` returns the token.
- [ ] `curl -H 'Authorization: Token <token>' 'https://api.susii.com/v1/stats/requested-reports/?business=<id>&page_size=1'` returns 200 with JSON.
- [ ] `curl -H 'apikey: <service_role>' 'https://fsdaqawhzvlphcbxzzji.supabase.co/rest/v1/?select=*' -X GET` returns 200.
- [ ] Dev Supabase project URL captured for Phases 2–5.

**Rollback:** N/A (no prod state changed yet).

---

## Phase 1 — Schema migration

**Goal:** Create all `susii.*` tables, indexes, FKs, and the `cfo_readonly` role in FACES Supabase. Empty schema — no data yet.

**Tasks:**

1. Author migration `001_susii_schema.sql` containing:
   - `CREATE SCHEMA susii;`
   - All DDL from `SUSII_ETL_DESIGN.md` §Core tables — `transactions`, `transaction_lines`, `payments`, `clientes`, `procedures`
   - All operational tables — `sync_runs`, `dead_letter`
   - All indexes
   - The `cfo_readonly` role: `CREATE ROLE cfo_readonly NOLOGIN; GRANT USAGE ON SCHEMA susii TO cfo_readonly; GRANT SELECT ON ALL TABLES IN SCHEMA susii TO cfo_readonly; ALTER DEFAULT PRIVILEGES IN SCHEMA susii GRANT SELECT ON TABLES TO cfo_readonly;`
   - DEFER view creation to Phase 7 (until data exists, views are useless).
2. Run migration against the dev Supabase first; verify all tables + FKs visible in Studio.
3. Run migration against prod FACES Supabase. Capture migration SHA + timestamp in a `migrations.md` log.

**Verification gate:**
- [ ] `\d susii.transactions` shows PK + columns + 4 indexes.
- [ ] `\d susii.transaction_lines` shows FK to transactions with CASCADE.
- [ ] `\d susii.payments` shows FK to transactions with CASCADE.
- [ ] `SELECT count(*) FROM susii.transactions` returns 0 (empty, schema applied).
- [ ] Login as `cfo_readonly` role: `SET ROLE cfo_readonly; SELECT 1 FROM susii.transactions;` returns 0 rows (not an error). `INSERT` rejected with permission denied.

**Rollback:** `DROP SCHEMA susii CASCADE; DROP ROLE cfo_readonly;` — empty schema, no data loss.

---

## Phase 2 — Plugin scaffold + Susii client

**Goal:** Working `packages/plugins/susii-etl/` package that can authenticate against Susii, request a tiny export (1 day of sales), poll, and download the xlsx. No DB writes yet.

**Tasks:**

1. Scaffold `packages/plugins/susii-etl/` with `manifest.json`, `package.json`, `tsconfig.json`, `src/index.ts`.
2. Manifest declares `requiredSecrets: ["SUSII_API_TOKEN", "SUSII_BUSINESS_ID", "SUSII_USER_PK", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]` and one job `manual-test` (no schedule yet).
3. Implement `src/susii-client.ts`:
   - `authenticate()` (re-auth via username/password if token expired)
   - `requestExport(reportCode, fromDate, toDate)` → returns job ID
   - `pollExport(jobId, maxMs=600000)` → returns ready URL or throws on timeout
   - `downloadXlsx(url)` → returns Buffer
   - All shapes verified against the existing `reportes-susii` SKILL.md as ground truth.
4. Implement `src/parser.ts`:
   - `parseSalesXlsx(buffer)` returns `{ transactions: TxRow[], lines: LineRow[] }` grouped by `(branch, receipt_number)`. Parse by header NAME (not column index). Skip header rows 1–8 (xlsx has title + summary blocks).
   - Surface unknown headers via a warning callback — caller decides whether to fail or continue.
5. Add `manual-test` job that pulls 1 day of sales, parses, and console-logs counts (transactions, lines, dead-letter rows).

**Verification gate:**
- [ ] Plugin registers at paperclip server boot — no `requiredSecrets` errors.
- [ ] Manual job invocation against 2026-04-01 (one known-good day) prints transactions=N, lines≥N, dead_letter=0.
- [ ] Re-running the same job is deterministic (same counts, same xlsx_sha256).
- [ ] Token rotation simulation (delete `SUSII_API_TOKEN` from Infisical) → `authenticate()` re-auths via username/password and recovers.

**Rollback:** Disable plugin via paperclip plugin admin. No DB state to undo.

---

## Phase 3 — Sales pipeline end-to-end

**Goal:** Sales flow writes correctly into `susii.transactions` + `susii.transaction_lines` against the dev Supabase. Verify idempotency.

**Tasks:**

1. Implement `src/upserter.ts`:
   - `upsertTransactions(tx[], syncRunId)` → Phase-1 ON CONFLICT upsert with `synced_at` guard
   - `replaceTransactionLines(receiptKeys[], lines[], syncRunId)` → Phase-2 DELETE WHERE in batch + INSERT
   - Both functions are pure given their inputs; no implicit DB state assumed.
2. Wire `src/reports.ts` `runSalesReport(window)`:
   - download → parse → group → upsertTransactions → replaceTransactionLines → write `sync_runs` row.
   - Compute `net_total = SUM(line.total)` per receipt BEFORE upserting headers.
3. Add a `manual-sync` job that takes `{report_kind, from, to}` and runs the pipeline.
4. Test cases against dev Supabase:
   - **T1** Single-day window (2026-04-15). Verify row counts: `SELECT count(*) FROM susii.transactions WHERE issued_at::date = '2026-04-15'` matches xlsx receipt count.
   - **T2** Re-run T1. Verify no duplicates (transactions count unchanged, `sync_runs` shows `transactions_upserted` matches but `lines_deleted = lines_upserted`).
   - **T3** Mid-window edit simulation: manually `UPDATE susii.transactions SET status='Anulado' WHERE receipt_number='00001'` then re-run T1. Verify row reverts to `'Procedió'` (real status) — confirms `synced_at` guard is correct direction.
   - **T4** Multi-line receipt (use a known-good receipt with 3+ procedures, e.g. NUMERO `00165`). Verify `transactions` has 1 row, `transaction_lines` has 4 rows, `transactions.net_total = SUM(transaction_lines.total)` (modulo discount).

**Verification gate:**
- [ ] T1 → row counts match xlsx
- [ ] T2 → no duplicate rows; `sync_runs.transactions_upserted = X` and `lines_upserted = lines_deleted = Y`
- [ ] T3 → `synced_at` guard reverts manual mutation
- [ ] T4 → multi-line receipt structurally correct
- [ ] No FK violations across any test
- [ ] Parser-by-header-name doesn't crash if a column is missing — issues a warning and moves on (test by manually deleting a column from a copy of the xlsx)

**Rollback:** `TRUNCATE susii.transactions, susii.transaction_lines CASCADE;` (dev Supabase only, no prod data yet).

---

## Phase 4 — Payments + reference catalogs

**Goal:** Same pattern for `pagos`, `clientes`, `procedures`. All four report kinds end-to-end on dev.

**Tasks:**

1. `src/parser.ts`: add `parsePaymentsXlsx`, `parseClientesXlsx`, `parseProceduresXlsx`. Identify header rows for each report (audit findings: pagos header is row 5, ventas header is row 9 — confirm clientes + procedures empirically).
2. `src/upserter.ts`: add `replacePayments(receiptKeys[], payments[], syncRunId)` (same delete+insert pattern as lines, FK to transactions). For `clientes` and `procedures`, plain ON CONFLICT upsert by their PK (no parent grain).
3. `src/reports.ts`: orchestrate all four kinds in one `runAllReports(window)` function. Sequential, not parallel — Susii rate limits.
4. Test cases:
   - **T5** Pagos for 2026-04 → verify `payments` rows attached to existing `transactions` (FK satisfied).
   - **T6** Pagos for a receipt that does NOT exist in `transactions` (sales report wasn't loaded yet) → expect FK violation and graceful fail (log to dead_letter, `sync_runs.status='partial'`). DO NOT attempt phantom-parent insertion.
   - **T7** `clientes` round-trip → `count(*)` matches xlsx.
   - **T8** `procedures` round-trip → `count(*)` matches xlsx.

**Verification gate:**
- [ ] Pagos T5 succeeds; payments visible joined to transactions via `(branch, receipt_number)`.
- [ ] T6 fails gracefully — does not create orphaned rows.
- [ ] T7, T8 land catalog data correctly.
- [ ] All four reports run via `manual-sync` job in a single invocation.

**Rollback:** `TRUNCATE susii.payments, susii.clientes, susii.procedures CASCADE;`.

---

## Phase 5 — Integrity check + telemetry + orphan reaper

**Goal:** Post-upsert assertions catch silent corruption. `sync_runs` provides the operator's primary observability surface. Survive container/server restarts cleanly.

**Tasks:**

1. Implement Phase-3 integrity check from design doc § "Phase 3 — post-upsert integrity check". Run after every batch.
2. Receipts that violate the invariant (`SUM(lines.total) - (total_amount + global_discount) > 0.01`) → insert into `dead_letter` with `error_text='integrity_violation'` + `sync_runs.integrity_violations++`. Do NOT block the run.
3. Schema drift detection: in `parser.ts`, when an unknown column header is seen, push to a `unknown_headers` set; at end of run, if non-empty, write a single `dead_letter` row with `error_text='unknown_headers: <list>'` so it shows up in monitoring.
4. Add a 1-line summary log line per run: `sales OK 47 receipts/151 lines/0 dead-letter/0 integrity-violations/sha256=...`.
5. **Orphan-run reaper.** Plugin job scheduler re-reads schedules from `plugin_jobs` on boot, but in-flight `sync_runs` rows with `status='running'` from a killed prior process stay orphaned forever — they trip `concurrencyPolicy: skip_if_active` and silently freeze the next scheduled run. Mitigation: register an `onLoad` plugin hook that sweeps stale runs once at boot:

   ```sql
   -- Runs once when the plugin registers at server boot.
   -- Idempotent — safe on every boot.
   UPDATE susii.sync_runs
   SET status = 'failed',
       finished_at = now(),
       error_text = 'orphaned: paperclip server restarted mid-run'
   WHERE status = 'running'
     AND started_at < now() - interval '5 minutes';
   ```

   The 5-minute threshold prevents false-positives on a run that's legitimately in-flight when another plugin instance loads. Reaped rows surface naturally in the "no successful run in 26h" alert and free the next scheduled run to fire.

**Verification gate:**
- [ ] Test by manually mutating `susii.transactions.net_total` for one receipt, then re-running same window with `synced_at` guard tricked OFF → integrity check catches the drift, dead-letters the receipt, integrity_violations counter increments.
- [ ] Test schema drift by manipulating a copy of the xlsx (rename `DESCUENTO GLOBAL CON IGV` → `DESCUENTO TOTAL`) → run logs unknown header, dead_letter row created, but rows that DID parse still load.
- [ ] `sync_runs.status` correctly reflects `ok | partial | failed | skipped_unchanged`.
- [ ] **Orphan reaper test:** start a long-running sync, `docker kill paperclip-server-1` mid-flight, restart container → boot reaper marks the orphaned `sync_runs` row `status='failed'` with `error_text='orphaned: ...'`, AND the next scheduled run is no longer skipped by concurrency policy.

**Rollback:** N/A (additive logic only).

---

## Phase 6 — 28-month backfill

**Goal:** Load all historical FACES sales + payments + clientes + procedures from 2024-01 through latest available month into the production FACES Supabase.

**Tasks:**

1. Add `backfill` job (manual trigger) that takes `{from: 'YYYY-MM', to: 'YYYY-MM'}` and walks monthly windows sequentially. Each window writes its own `sync_runs` row with `triggered_by='backfill:YYYY-MM'`.
2. Run backfill in three slices to limit blast radius and rate-limit pressure:
   - **B1** 2026-04 only (most recent — sanity check on prod table)
   - **B2** 2025-01 → 2026-03 (15 months)
   - **B3** 2024-01 → 2024-12 (12 months)
3. After each slice: verify row counts vs xlsx ground-truth on a sampled month (use the existing `ReporteVentas_2023-04-01_2026-04-16.xlsx` in the CFO workspace as comparison source for sample dates).
4. Run xlsx_sha256 dedupe — if a backfill window matches a previous sync's sha256, skip with `status='skipped_unchanged'`.

**Verification gate:**
- [ ] B1 → row count for 2026-04 matches workspace xlsx for the same period.
- [ ] B2 → completes without rate-limit errors. If any window fails, retry that window only (idempotent).
- [ ] B3 → completes; total `transactions` count ≥ 3000.
- [ ] `SELECT report_kind, status, count(*) FROM susii.sync_runs GROUP BY 1, 2;` shows all-`ok` distribution with no `failed`/`partial` left unresolved.
- [ ] Sampled receipt audit: pick 5 random receipts across 28 months, confirm `transactions.net_total = SUM(transaction_lines.total) - global_discount` for each.

**Rollback:** Per-slice rollback via `DELETE FROM susii.transactions WHERE issued_at >= '<slice_start>' AND issued_at < '<slice_end>'` (CASCADE handles lines/payments). `sync_runs` rows preserved as audit trail.

---

## Phase 7 — CFO consumer side

**Goal:** Views, read-only access, and the `supabase-finanzas` skill that lets the CFO query Supabase via the agent.

**Tasks:**

1. Author migration `002_susii_views.sql` with the view definitions from `SUSII_ETL_DESIGN.md` §Read-only views (`v_monthly_sales`, `v_top_procedures`, `v_customer_ltv`, `v_ar_aging`). Inline the grain-rule SQL comment in each view.
2. Grant SELECT on views to `cfo_readonly`. Verify `cfo_readonly` cannot SELECT from base tables OR FROM raw `susii.transactions` directly — only views.
   - **Decision required at this phase:** do we restrict base-table access for `cfo_readonly` (forces views), or allow it (more flexible but bypassable)? Default: allow, with grain-rule as documentation. Revisit if first month shows multi-grain mistakes in CFO queries.
3. Author skill at `/paperclip/.claude/skills/supabase-finanzas/SKILL.md` and symlink to `/paperclip/.hermes/skills/supabase-finanzas/SKILL.md`.
4. Skill documents: connection (URL + role), available views, helper SQL templates for `revenue_by_period`, `compare_periods`, `top_customers`, `top_procedures`, `weekly_breakdown`, `customer_visits`, `ar_aging`. Each helper is a copy-pasteable SQL block.
5. Add `supabase-finanzas` to extraArgs `-s` list for CFO, Reporting Agent, Data Analyst (now that C-suite is on claude_local, this is just a config edit per `reference_paperclip_fallback_extraargs_leak.md` — set on the active `claude_local` adapter, NOT the demoted hermes fallback unless we want both modes).

**Verification gate:**
- [ ] Each view returns expected shape: `SELECT * FROM susii.v_monthly_sales LIMIT 3;` returns months with non-null revenue.
- [ ] `cfo_readonly` can SELECT from views AND base tables (or restricted to views per decision above) — but never INSERT/UPDATE/DELETE.
- [ ] CFO heartbeat with the new skill loaded responds to "What was revenue in March 2026?" by issuing a Supabase query against `v_monthly_sales` and reporting the answer correctly.
- [ ] Spot-check: CFO's answer matches the FAC-24 baseline (Ene–Abr 15 2026 = S/525,578) within 1% rounding.

**Rollback:** Drop views, revoke role, remove skill from agent extraArgs.

---

## Phase 8 — Cutover + monitoring + handoff

**Goal:** Daily routine running unattended; CFO instructions updated to query Supabase first; old `reportes-susii` skill demoted to break-glass.

**Tasks:**

1. Update plugin manifest: enable the daily-sync job at `0 6 * * * America/Lima`, `concurrencyPolicy: skip_if_active`, `maxDurationMs: 1800000`.
2. Update CFO + Reporting + Data Analyst `instructions/AGENTS.md`:
   - "When asked for financial data, query Supabase via `supabase-finanzas` skill FIRST."
   - "If `supabase-finanzas` doesn't have what you need, fall back to `reportes-susii` and report the gap as a comment on the issue so it can be added to the ETL."
3. Add 3 monitoring queries (daily Slack/email or paperclip routine):
   - `last_ok_run` per `report_kind` — alert if `> 26h ago`.
   - `dead_letter` count over last 7 days — alert if `> 0`.
   - `integrity_violations` over last 7 days — alert if `> 0`.
4. Document operational runbook in `paperclip-minion/doc/SUSII_ETL_RUNBOOK.md`:
   - How to manually trigger a sync
   - How to interpret each `sync_runs.status`
   - How to diagnose a failed run (dead_letter inspection, run-log path)
   - How to re-fetch a stuck window
   - How to rotate the Susii API token

**Verification gate:**
- [ ] Daily-sync job ran for 7 consecutive days with `status='ok'` (or `'skipped_unchanged'` on weekend non-activity days).
- [ ] CFO produces a financial summary using only `supabase-finanzas` (not `reportes-susii`) and the answer matches a known-good benchmark (e.g. FAC-24 numbers for the same period).
- [ ] Monitoring queries are wired and observable.
- [ ] Runbook is checked into the repo.

**Rollback (full):**
- Pause daily-sync job (manifest `enabled: false`).
- Revert CFO instructions to "use `reportes-susii`".
- Optionally `DROP SCHEMA susii CASCADE` if abandoning the system entirely (preserves nothing — only do this if abandoning).

---

## Open questions to resolve during execution (not blockers for starting)

1. **Dev Supabase project** — separate project, separate branch of FACES, or is dev = local Postgres? Cheapest is local Postgres; safest for parity is a Supabase branch. Decide at Phase 0.
2. **`cfo_readonly` strictness** — restrict to views only, or allow base-table access? Default to permissive; revisit at Phase 7 review.
3. **Multi-tenant later** — this plan is FACES-only. Phase 9 (out of scope) would generalize to MINION/Pinonite by parameterizing `companyId` in the plugin and wiring per-company Susii credentials. Don't design for it yet.
4. **`receipt_serie`** — confirm whether the ReporteVentas xlsx ever surfaces a serie column distinct from NÚMERO. If yes, add to PK in Phase 1 BEFORE backfill (Phase 6).

## References

- Design contract: `paperclip-minion/doc/SUSII_ETL_DESIGN.md`
- Existing Python skill (logic ground-truth for the port): `/paperclip/.hermes/skills/reportes-susii/SKILL.md` (and symlink at `/paperclip/.claude/skills/reportes-susii/SKILL.md`)
- Plugin job machinery: `packages/db/src/schema/plugin_jobs.ts`, `server/src/services/plugin-job-scheduler.ts`
- Existing plugin example: `packages/plugins/github-agent-trigger/`
- Susii API report codes: `export_sales`, `export_sale_payments` (verified)
- FAC-24 (claude-local baseline metrics for verification): S/525,577 ingresos · 595 receipts · S/883 ticket · 334 clients · Afinamiento de Rostro 42% · 2026-01-01 → 2026-04-15
