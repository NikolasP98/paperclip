# Susii ETL plugin

Ingests Susii sales (and nested clients/items/payments/documents) from the
Susii REST API into the Supabase `susii.*` schema. Deterministic plugin job —
no LLM in the hot path. Replaces ad-hoc xlsx parsing.

## Phase status

- **Phase 0** — secrets provisioned in `minion-paperclip` Infisical (dev env).
- **Phase 1** — schema cascade FKs + `cfo_readonly` role + `sync_log` index applied.
- **Phase 2** *(this commit)* — package scaffold, manifest, REST client, `manual-test` job.
- **Phase 3+** — sync writer, watermark, integrity check, backfill, CFO consumer.

## Jobs

| Job key | Status | What it does |
|---|---|---|
| `manual-test` | ✅ implemented | Read-only API probe. Fetches 5 sales modified in last 24h, logs counts. No DB writes. |
| `sync-incremental` | 🚧 Phase 3 | Walks `/v1/sales/sales/?modified_after=<watermark>`, upserts into `susii.*`. |

## Configuration

All required keys live in the plugin's instance config (see `manifest.ts`):

| Key | Type | Notes |
|---|---|---|
| `susiiUsernameRef` | secret-ref | resolves to `SUSII_USERNAME` (admin email) |
| `susiiPasswordRef` | secret-ref | resolves to `SUSII_PASSWORD` |
| `susiiBusinessId` | integer | e.g. `5922` for FACES SCULPTORS |
| `supabaseDbHost` | string | pooler host, e.g. `aws-1-us-west-2.pooler.supabase.com` |
| `supabaseDbPort` | integer | default `5432` |
| `supabaseDbUser` | string | pooler-prefixed, e.g. `postgres.<projectref>` |
| `supabaseDbName` | string | default `postgres` |
| `supabaseDbPasswordRef` | secret-ref | resolves to `SUPABASE_DB_PASSWORD` |
| `supabaseDbSsl` | enum | `require` (default) / `verify-full` / `disable` |

Direct Postgres via Session Pooler (IPv4) — paperclip's Docker bridge is
IPv4-only, so `db.<projectref>.supabase.co` (IPv6 only) is unreachable.

## Build

```bash
pnpm --filter paperclip-plugin-susii-etl build
```

## Test

```bash
pnpm --filter paperclip-plugin-susii-etl test
```
