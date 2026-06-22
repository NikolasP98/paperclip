# Minion Workforce — extraction status

This repo is the **standalone Minion Workforce module** — the control plane for
AI-agent companies that powers the hub's `/workforce` surface. It was extracted
from the `paperclipai/paperclip` fork; that upstream is kept only as a reference
remote (`origin` = paperclipai/paperclip, `fork` = NikolasP98/paperclip,
`workforce` = NikolasP98/minion-workforce — the new canonical).

Approach: **incremental — get it building standalone, publish last.** Do not
publish `@minion-stack/workforce` until the steps below are green.

## Current state (done)

- ✅ Standalone repo created (`NikolasP98/minion-workforce`, private) and the
  full history pushed to `main`. No longer a GitHub fork of paperclipai.
- ✅ Builds standalone today: it's a self-contained pnpm monorepo
  (`pnpm build`) and is the live deployed source on netcup
  (`paperclip-server` container).
- ✅ Prod deploy patches reconciled into the tree (Hermes Agent + browser-harness
  install, bare `claude-sonnet-4-5`/`haiku-4-5` ids) — commit `f406f7bc2`.
- ✅ `createCompanySchema` already accepts an optional `id` (native single-id:
  `company.id === hub org id`), with migration `0103` for the FK-cascade + PK
  rewrite.

## Workspace packages

Publishable target = the server. Internal deps are all `@paperclipai/*`:

| Package | Name | Role |
|---|---|---|
| `server` | `@paperclipai/server` `0.3.1` | the deployable backend → **becomes `@minion-stack/workforce`** |
| `packages/db` | `@paperclipai/db` | Drizzle schema + migrations |
| `packages/shared` | `@paperclipai/shared` | types + validators |
| `packages/adapter-utils` | `@paperclipai/adapter-utils` | adapter base |
| `packages/adapters/*` | `@paperclipai/adapter-*` | claude-local, hermes, codex, … |
| `packages/mcp-server` | `@paperclipai/mcp-server` | MCP surface |
| `packages/skills-catalog`, `packages/teams-catalog` | `@paperclipai/*` | seed catalogs |
| `ui` | `@paperclipai/ui` | board UI (the hub re-implements this natively) |
| `cli` | `paperclipai` | CLI |

The hub consumes the **client** only, already published as
`@minion-stack/workforce-client@0.2.0` (separate package in the meta-repo).

## Remaining work to publish `@minion-stack/workforce`

1. **Pick the publishable boundary.** Either (a) bundle `server` + its workspace
   deps into one self-contained `@minion-stack/workforce` dist (tsup/esbuild,
   no `@paperclipai/*` runtime resolution needed), or (b) publish each
   `@paperclipai/*` dep under `@minion-stack/*` and depend on them. (a) is the
   lazier path to a single publishable artifact.
2. **Rebrand** `@paperclipai/server` → `@minion-stack/workforce` (and, if going
   route (b), the ~1072 `@paperclipai/*` references → `@minion-stack/*`).
3. **Verify** standalone `pnpm install && pnpm build && pnpm test`.
4. **Repoint consumers**: netcup deploy + any meta-repo references; confirm the
   hub's `@minion-stack/workforce-client` still matches the API surface.
5. **Publish** `@minion-stack/workforce` to npm (token is held separately —
   rotate it after the first publish since it was shared in chat).

Until step 5, the live backend keeps running from this repo's Docker build on
netcup unchanged.
