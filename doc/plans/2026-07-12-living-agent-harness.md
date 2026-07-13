# Living Agent Harness — Authoritative Design and Implementation Plan

**Status:** Implementation contract  
**Date:** 2026-07-12  
**Branch:** `feat/living-agent-harness`  
**Scope:** Paperclip control plane, adapter contracts, workforce UI, and the MINION bug/project workforce  
**Related:** `doc/SPEC-implementation.md`, `doc/plans/2026-04-06-smart-model-routing.md`, `server/src/services/fallback-chain.ts`, `specs/2026-07-11-universal-projects-module.md` in the Minion meta-repo

## 1. Outcome

Paperclip will treat an agent's operating harness as a versioned, inspectable, and reversible product artifact. A harness revision records the instructions, skill versions, runtime/adapter selection, model policy, permissions, and relevant environment identity that produced a run. Evaluator decisions and human feedback become learning signals. A bounded auxiliary reviewer may turn those signals into proposed changes, but no learning process mutates the live harness directly.

The end state is a governed loop:

```text
issue/run
  -> immutable harness fingerprint on the run
  -> evaluator or human feedback signal
  -> typed learning proposal with exact diff
  -> validation and replay/eval
  -> policy/approval gate
  -> atomic harness revision promotion
  -> canary observation
  -> retain or roll back
```

This is deliberately different from unrestricted “the agent rewrites itself.” Paperclip remains the control plane and source of governance. Individual harnesses remain execution engines.

### 1.1 Canonical MINION Code portfolio pipeline

The canonical unit of traceability is the repository issue. It becomes one parent Paperclip issue and retains its immutable origin (`repository`, issue number, URL, webhook delivery, original labels/body). Pipeline work is materialized as child issues rather than represented only by a cursor on the parent. This is necessary because every agent must have a real queue item and a native Paperclip status.

```text
GitHub issue opened/reopened
  -> Intake child: classify tags/scopes (minion-drone, bounded schema output)
  -> deterministic router assigns the parent to a MINION Code project
  -> Plan child (high-reasoning planner)
  -> Plan HITL child
  -> Implement child (OpenCode coding harness)
  -> Evaluate child (independent scored evaluator)
       score below floor -> append findings/spec delta
                         -> create Implement iteration N+1
                         -> create Evaluate iteration N+1
  -> Release HITL child
  -> Merge child (bounded minion-drone after approval)
  -> parent Done
```

The parent/child relation is structural. Sequential dependency is expressed with Paperclip blocker edges: each pending child is blocked by the prior child, and the parent is blocked by the terminal merge child. The native child statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, and `cancelled`; no pipeline-specific status vocabulary is introduced.

The classifier never chooses an arbitrary project ID. It returns a versioned typed classification such as:

```ts
type RepositoryIssueClassification = {
  repository: "minion_hub" | "minion" | "minion_site" | "paperclip-minion" | "minion_plugins" | "pixel-agents" | "meta";
  scopes: Array<"auth" | "crm" | "core" | "gateway" | "workforce" | "ui" | "data" | "plugins" | "ops" | "docs">;
  workType: "bug" | "feature" | "security" | "maintenance" | "docs";
  risk: "low" | "medium" | "high" | "critical";
  confidence: number;
  evidence: string[];
};
```

The router validates that output against an operator-owned route table. Repository is the first partition, concern/scope is the second, explicit operator label overrides model inference, and low-confidence/ambiguous classifications go to Portfolio Intake for human routing. The model may propose tags; deterministic code owns project assignment.

Every child stores `pipelineId`, step key, iteration, parent issue ID, predecessor/blocker IDs, assignee, harness revision, resolved runtime/model, start/finish timestamps, decisions, comments, work products, and activity events. Pipeline edits do not rewrite already-materialized children. A new pipeline revision applies only to new parent issues.

### 1.2 Project grouping

MINION Code groups projects by repository, with concern projects beneath that grouping in the Hub presentation. The first implementation may use stable `repositoryKey`/`groupKey` metadata if Paperclip has no first-class project-group table; UI grouping must not be inferred from display names.

Initial groups and projects:

- `minion_hub`: Hub UI, Workforce/Projects, Hub Auth, Hub Data/DB;
- `minion`: Gateway Core, Gateway Auth/Security, Channels, Shared Runtime;
- `minion_site`: Site/Marketing, Members/Auth;
- `paperclip-minion`: Control Plane, Adapters/Runtimes, Pipeline/Traceability;
- `minion_plugins`: Plugin Platform, CRM;
- `pixel-agents`: Extension Runtime, Pixel Office UI;
- `meta`: shared `@minion-stack/*` packages, specs/docs, CI/release/operations.

Cross-repository primitives such as auth contracts and `@minion-stack/shared` use an explicit `core` scope and may create linked follow-up children in more than one repository project. A single issue still has one primary project for ownership.

## 2. Non-goals and hard boundaries

- Do not allow a background model to edit live instructions, skills, adapter config, tools, or executable files in place.
- Do not build a global free-text model router. Routing is role-, stage-, and adapter-aware.
- Do not silently switch models or adapters without recording the resolved runtime on the heartbeat run.
- Do not merge memories, user preferences, reusable procedures, and system instructions into one untyped prompt blob.
- Do not let learned state overwrite bundled, marketplace, external, or operator-owned assets. Customization requires an explicit fork.
- Do not claim that `@minion-stack/drone` executes Paperclip agents today.

### 2.1 The minion-drone boundary

`@minion-stack/drone` v0.3 is a bounded in-process LLM primitive with immutable definitions, TypeBox schema output, a short pure-tool loop, timeout/step/token budgets, fallbacks before the first successful turn, and resolved-model/usage reporting. Its tools are intentionally for simple pure handlers, not repository or channel side effects. It is not currently a Paperclip adapter and the gateway currently exposes only drone listing/session-title RPCs.

The canonical pipeline therefore requires a real `minion_drone` bridge before classifier/planner/evaluator/merge-readiness roles can be activated. The bridge is an authenticated allowlisted gateway RPC, not arbitrary remote drone definitions. One Paperclip heartbeat maps to one bounded drone invocation and persists cancellation, transcript, usage, duration, resolved provider/model, typed output, and failure. Definitions and pure tools remain in Minion.

Drone output is advisory data. Deterministic Paperclip services apply labels, routing, exact-once subtask creation, and merge execution. In particular, the merger drone performs readiness and strategy validation; a non-LLM merge executor performs the already-approved merge. No drone receives raw shell, filesystem, GitHub mutation, or live harness-mutation tools.

## 3. Evidence and current production baseline

The production MINION workforce was inspected through the authenticated private Paperclip API on 2026-07-12.

- `bug-fixer` is `claude_local`, idle, callback/system-woken, with heartbeat scheduling disabled.
- `bug-reviewer` is `claude_local`, idle, callback/system-woken, with heartbeat scheduling disabled.
- `portfolio-monitor` is `claude_local`, heartbeat scheduling disabled, and was in `error`; the living-harness rollout must not assume the monitor is healthy.
- No `code-evaluator` agent was present in the returned agent inventory, despite the portfolio specification calling for one. Evaluation must be a first-class role that is seeded or repaired explicitly.
- No fixer/reviewer live run remained after the latest successful system-triggered runs.
- Temporary reviewer API keys used during the eval-gate repair were all revoked; no active temporary key remained.
- The eval callback failure demonstrated that a score written only in prose is not a decision. Eval completion must call the issue update contract with `status: "done"` and numeric `evalScore` in the same mutation.

The current implementation already provides useful foundations:

- adapter fallback chain and stable fallback reasons in `server/src/services/fallback-chain.ts`;
- cheap model profiles in `runtimeConfig.modelProfiles.cheap`;
- per-issue `modelProfile`/adapter overrides and UI controls;
- versioned company skills in `company_skills` and `company_skill_versions`;
- agent configuration revisions and rollback;
- managed/external instruction bundles with path containment;
- execution decision ledger rows with score/max score/run attribution;
- feedback votes on agent-authored comments and document revisions;
- approvals, activity logging, workspaces, cost events, and heartbeat run transcripts.

## 4. Hermes findings to adopt—and not adopt

Hermes improves bounded artifacts: persistent environment/user memory and procedural skills. Its background reviewer uses a quiet auxiliary agent with only memory and skill-management toolsets. Skills use progressive disclosure: compact inventory, then skill body, then supporting file. Its curator periodically proposes consolidation and moves unused agent-created skills through active, stale, and recoverable archived states.

Adopt these properties:

- post-run review is separate from the primary worker response;
- strict auxiliary tool allowlist and iteration/token budget;
- typed environment memory and user profile with hard size budgets;
- targeted skill patches preferred over rewrites or duplicate skill creation;
- progressive skill disclosure;
- usage metadata and periodic curation;
- staged writes, diff review, approval, versioning, and rollback;
- recalled memory fencing and output scrubbing.

Do not adopt these unsafe properties:

- direct autonomous filesystem mutation;
- prompt-only provenance safeguards;
- background children that fail to inherit exact provider/base URL/API mode;
- unrestricted edits to bundled or hub-installed skills;
- unbounded skill proliferation;
- executable learned helpers without syntax validation and approval.

## 5. Harness definition

A harness revision is an immutable snapshot with stable content hashing. It contains references to versioned assets rather than copying secrets.

```ts
type AgentHarnessSnapshot = {
  schemaVersion: "paperclip-agent-harness-v1";
  agentId: string;
  roleProfile: string;
  instructions: {
    mode: "managed" | "external";
    entryFile: string;
    files: Array<{ path: string; contentHash: string; revisionId?: string }>;
  };
  skills: Array<{
    companySkillId: string;
    versionId: string;
    provenance: "bundled" | "marketplace" | "company" | "agent_generated" | "fork";
  }>;
  runtime: {
    adapterType: string;
    adapterVersion?: string;
    primaryModel?: string;
    provider?: string;
    modelProfiles?: Record<string, unknown>;
    fallbackChain?: Array<Record<string, unknown>>;
    environmentId?: string;
    workspacePolicy?: Record<string, unknown>;
  };
  permissionsHash: string;
  toolSchemaHash?: string;
  harnessImageVersion?: string;
};
```

Secrets are represented only by secret reference IDs and versions or by a redacted binding hash. Raw credentials never enter the snapshot, learning evidence, prompt, transcript export, or diff.

### 5.1 Identity rules

- The snapshot JSON is canonicalized before SHA-256 hashing.
- A duplicate hash for one agent reuses the existing revision.
- `heartbeat_runs.harness_revision_id` is fixed before adapter execution.
- A run also records `resolved_adapter_type`, `resolved_provider`, and `resolved_model`; these are observed execution facts, not inferred later from mutable agent config.
- Harness binary/image version and learned artifact versions are independent. Updating Hermes, Claude Code, Codex, or OpenCode must not masquerade as a skill or prompt improvement.

## 6. Runtime and harness decision table

Execution harness/runtime and LLM model/provider are independent axes:

- the **harness axis** determines the executable, tool/session semantics, instruction and skill integration, workspace behavior, transcript parsing, cancellation, and usage reporting (`claude_local`, `codex_local`, `opencode_local`, `hermes_local`);
- the **model axis** determines the provider/model and reasoning profile used inside a compatible harness.

OpenCode is a harness, not a model. Claude Code and Codex are also harnesses even when their names resemble model families. A model ID appearing in more than one harness does not make the sessions or tool behavior interchangeable. Model routing never bypasses the harness’s adapter contract, and harness fallback never assumes cross-runtime session compatibility.

| Runtime | Strengths | Weaknesses | Initial living-harness use | Decision |
|---|---|---|---|---|
| Claude Code (`claude_local`) | Proven in the live bug pipeline; strong repo reasoning and review; managed instructions and skills; mature worktree/session behavior | Subscription quota can exhaust; expensive for routine summaries; self-learning must be built in Paperclip | Independent reviewer/evaluator and implementation fallback | **Ship first** |
| Codex (`codex_local`) | Strong code execution; explicit reasoning effort; robust prompt/session handoff; known cheap profile | Separate auth/quota domain; cross-runtime session resume unsafe | Primary mutating bug fixer, isolated from the reviewer runtime | **Ship first** |
| OpenCode (`opencode_local`) | Multi-provider inventory; model/variant routing; materialized skills; independent provider path | Very large/volatile model catalog; provider entitlement differs; runtime config complexity | Provider-flexible cost canary and classified fallback after environment probe | **Supported after probe** |
| Hermes (`hermes_local`) | Persistent memory/session search; native skill management; background review/curator model | Production adapter reports no model inventory; native state is harness-owned; upstream direct-write/provenance risks; no managed instruction-bundle capability in current adapter | Research/canary only until provenance and export contracts are enforced | **Do not make default** |
| `@minion-stack/drone` | Typed schema output, bounded pure-tool loop, low process overhead, explicit usage/model result | Not yet a Paperclip adapter; no generic execute RPC or Paperclip queue/heartbeat contract | Classifier, planner, evaluator assistant, and merge-readiness after the required bridge | **Build bridge before activation** |

Claude Code and Codex/OpenCode are not “less living” than Hermes. The living behavior belongs in Paperclip’s versioned feedback loop, so it applies consistently to every adapter.

## 7. Verified model inventory and routing policy

On 2026-07-12 the production adapter model endpoint returned these relevant models:

- Claude local: `claude-opus-4-8`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`.
- Codex local: `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5`, `o3`, `o4-mini`, `gpt-5-mini`, `gpt-5-nano`, `o3-mini`, `codex-mini-latest`.
- OpenCode discovery included, among others, `github-copilot/claude-fable-5`, `github-copilot/claude-sonnet-5`, `github-copilot/gpt-5.5`, `github-copilot/gpt-5.6-terra`, `github-copilot/gpt-5.6-sol`, `github-copilot/gpt-5.6-luna`, `github-copilot/gpt-5.4-mini`, `github-copilot/gpt-5.4-nano`, plus OpenRouter and free OpenCode models.
- Model discovery is not an authentication guarantee. The production OpenCode runtime does not support GitHub Copilot through the available PAT transport, so the implementer uses the supported OpenRouter provider and `openrouter/anthropic/claude-sonnet-5` model.
- Hermes returned an empty model list. Do not assign a Hermes model until its environment probe/detection returns a concrete model.

“Returned by the model endpoint” means adapter-reported availability on that deployment. It does not guarantee provider entitlement forever. Every promotion validates the selected primary and fallback models in the target environment.

The role assignments below are rollout hypotheses, not static price claims. Paperclip will choose and retain a “cheap” or cost-optimized lane only from canary evidence using:

- observed Paperclip cost per accepted outcome, including retries and fallback attempts;
- role-specific evaluator score floor and regression rate;
- end-to-end latency to accepted outcome;
- fallback frequency and failure classification;
- canary comparison against the incumbent harness/model policy on equivalent work.

Sticker price, vendor tier labels, or model-name suffixes are not sufficient routing evidence. If a nominally cheaper model needs more retries or produces fewer accepted outcomes, it loses the cost-optimized lane.

### 7.1 Role policies

| Role/stage | Harness and initial model policy | Fallback/canary | Contract |
|---|---|---|---|
| Intake classifier | `minion_drone:anthropic/claude-haiku-4-6` | `claude_local:claude-haiku-4-6`; cost canary `minion_drone:openrouter/google/gemini-2.5-flash` | Typed taxonomy only; deterministic service applies labels and routing |
| Spec/planner | `minion_drone:anthropic/claude-opus-4-8` after bridge | `claude_local:claude-opus-4-8`; canary `opencode_local:github-copilot/claude-fable-5` | Reads issue/project SDK context; emits typed plan and child specs; no code mutation. Fable/other alternatives earn use only from cost-per-accepted-plan evidence |
| Implementer | `opencode_local:openrouter/anthropic/claude-sonnet-5` (provider `openrouter`) | `codex_local:gpt-5.3-codex` -> `claude_local:claude-sonnet-4-6` | Own isolated workspace; implement/test/push issue branch and draft PR; never merge |
| Evaluator | `minion_drone:portfolio-implementation-evaluator-v1` (OpenAI `gpt-5.4`, gateway-owned Anthropic Opus fallback) | `codex_local:gpt-5.4` only where local Codex authentication has been explicitly verified | Independent rubric score over frozen spec, PR, diff, and test evidence; no code mutation; failed score appends spec delta and creates a new implementation iteration |
| Code merger | `minion_drone:anthropic/claude-haiku-4-6` for readiness only | `claude_local:claude-haiku-4-6` readiness fallback | Runs only after release HITL; deterministic merge executor verifies approved head SHA and performs merge |
| Portfolio monitor | `minion_drone:openrouter/google/gemini-2.5-flash` after bridge | current executable canary `opencode_local:github-copilot/gpt-5.4-mini` | Read-only, deduped remediation, hard spend and breadth limits |
| Learning proposal reviewer | `hermes_local:mistralai/mistral-large-2512` after environment probe | `claude_local:claude-sonnet-4-6` -> `codex_local:gpt-5.3-codex-spark` | Hermes is used for memory/skill curation outside the delivery pipeline; proposal-only and never self-promoting |

Model names above are target-environment candidates, not price assertions. A role keeps the cheapest lane that meets its score floor, latency, fallback, and accepted-outcome requirements. “Haiku-level,” “Sonnet-level,” and “Opus/Fable-level” describe capability/cost intent; the stored policy always records the exact provider/model ID actually probed and executed.

The listed primary choices are rollout hypotheses and must earn promotion through target-environment probes and equivalent-work canaries. The presence of newer-looking model IDs alone is not a quality or cost ranking.

For each role, the stored policy therefore has separate `harnessPolicy` and `modelPolicy` objects. A role may change models within one harness without changing its execution semantics, or change harnesses only through a fresh-session fallback/promotion with independent evaluation.

### 7.2 Failover semantics

- Preserve the existing fallback-chain invariant: only classified failures advance the chain.
- Extend stable reasons beyond current Claude quota/OpenRouter credit cases: `provider_unavailable`, `model_unavailable`, `auth_unavailable`, and `runtime_missing` may advance; task errors, test failures, timeouts caused by work, permission denial, and evaluator rejection do not.
- Never resume a persisted session across adapter types. Build a redacted continuation handoff and start a fresh fallback session.
- Cheap preflight sessions are ephemeral. The primary model session is canonical.
- Each attempt and execution segment records usage/cost/model truthfully.
- A fallback cannot gain permissions, broader filesystem roots, or new secrets relative to the primary.

## 8. Role-specific harness contracts

### 8.1 Bug fixer

- Receives issue, repository/project routing, pipeline metadata, prior stage decisions, and scoped workspace.
- Checks out atomically and works only in the issue execution workspace.
- Produces root-cause narrative, focused verification, commit/PR evidence, and a complete issue update.
- May propose a skill patch after repeated procedural evidence, but cannot promote it.
- Learning signals: evaluator score, reviewer changes request, HITL rejection/approval, failed/recovered tool sequence, rollback.
- Guardrails: no default-branch push, no full gateway suite where prohibited, no secret-bearing logs, no self-assignment around review gates.

### 8.2 Bug reviewer

- Starts in a fresh reviewer session and reads the fixer’s work product, diff, tests, issue requirements, and harness revision.
- Has read-only repository access by default; any corrective patch is a new explicitly owned issue/stage.
- Returns structured findings with severity and evidence, then an approved/changes-requested decision.
- Cannot edit the fixer’s live harness. It can emit a learning signal or proposal candidate.
- Reviewer identity must not equal the fixer identity for the same decision.

### 8.3 Evaluator

- Uses a stable, versioned rubric and max score supplied in stage metadata.
- Produces criterion-level scores plus numeric aggregate.
- Completes by the typed API/MCP update with `status: done`, `evalScore`, and explanatory comment in one call.
- Cannot change code, harness, rubric, or threshold while scoring.
- Eval records link issue, stage, evaluator run, subject harness revision, rubric version, score, max score, and decision.

### 8.4 Portfolio monitor

- Runs on a routine/callback, not an always-on heartbeat.
- Uses read-only portfolio/project/pipeline/decision/run/cost endpoints.
- Emits a bounded report or creates one remediation issue with dedupe key; it does not patch repositories.
- Hard limits: one run at a time, maximum issues inspected, maximum output, maximum cost, and no recursive wake.
- Its current production error state must be diagnosed and cleared before enabling living-agent learning from monitor output.

### 8.5 Human feedback

- Up/down votes and reasons remain attached to agent-authored comments/document revisions.
- Explicit correction, approval, rejection, rollback, or edited accepted output is a stronger signal than a passive vote.
- One negative vote never auto-mutates a harness. It creates or updates a proposal evidence set.
- UI must show what feedback contributed to a proposal and allow the user to exclude a signal.
- User-profile memory is private to the appropriate user/agent scope and is never inferred from company-wide feedback without explicit policy.

## 9. Governed learning lifecycle

### 9.1 Signal capture

Capture signals idempotently from:

- `issue_execution_decisions` including score/max score/body;
- feedback votes and reasons;
- accepted/rejected approvals and interactions;
- run terminal status and classified failure;
- recovery/rollback events;
- repeated successful tool sequences;
- explicit “remember this” or “use this process next time” requests.

Signals include the source run and harness revision. A signal without artifact/runtime attribution cannot drive automatic promotion.

### 9.2 Proposal generation

The auxiliary reviewer receives a redacted evidence bundle and only these logical tools:

- list current harness manifest;
- view current versioned instruction/skill/memory artifact;
- search similar company skills and proposals;
- create a typed proposal;
- abstain with a reason.

Proposal types are:

```text
memory_patch
user_profile_patch
skill_patch
skill_create
skill_archive
instruction_patch
routing_metadata_patch
model_policy_patch
```

Patch-first policy: update an existing agent-generated/company fork before creating a new skill. Vendor/bundled/marketplace assets require an explicit fork proposal.

### 9.3 Validation

All proposals receive deterministic checks before an LLM evaluation:

- company/agent scope and actor authorization;
- optimistic base-version match;
- provenance and write-boundary enforcement;
- path traversal and symlink rejection;
- secret, credential-harvesting, prompt-injection, and exfiltration scan;
- content/file/count/character budgets;
- duplicate name and semantic-overlap check;
- syntax/schema validation for structured or executable content;
- adapter model/environment availability probe;
- no permission or secret-scope expansion.

### 9.4 Evaluation and promotion

- Replay a fixed role-specific eval suite against baseline and candidate harnesses.
- Record suite version, model/runtime fingerprint, baseline score, candidate score, per-case regressions, cost, and evaluator run.
- Low-risk memory patches may auto-promote only after deterministic validation and a configurable evidence threshold.
- Skill changes require evaluator pass. Instruction, routing, model-policy, executable, permission, or tool changes require HITL approval.
- Promotion is atomic: create immutable revision, update current pointer, materialize/sync, and log activity.
- Canary initially applies to one agent and new sessions only. Existing sessions stay pinned to their starting harness revision.
- Regression threshold breach automatically restores the previous revision and opens a visible rollback issue.

### 9.5 Curation

Track `loadCount`, `lastLoadedAt`, `lastSucceededAt`, `lastFailedAt`, and issue/run outcome links. A weekly curator may propose `active -> stale`, merge, or archive. Archive is reversible. Curator proposals obey the same provenance, evaluation, and approval rules.

## 10. Data contracts

### 10.0 Traceable stage-task workflow

The current inline pipeline compiler remains supported for existing one-worker flows. Add `executionMode: "issue_gate" | "stage_tasks"` with `issue_gate` as the default. `stage_tasks` permits multiple work steps and materializes one child issue per step/attempt.

Required durable records:

- `pipeline_revisions`: immutable pipeline snapshot/hash so edits never change an active or historical route;
- `pipeline_runs`: webhook delivery/origin idempotency, parent issue, classification, evaluated route candidates, selected group/project, pipeline revision, current step and terminal state;
- `pipeline_stage_runs`: pipeline run, step key, attempt, child issue, predecessor, participant, heartbeat/harness/runtime/model attribution, input/output artifact revisions, decision/score, and timestamps;
- `issue_routing_decisions`: original repo/labels, typed classifier output, rule-by-rule candidates, selected project, confidence and fallback/override reason.

Use unique `(pipeline_run_id, step_key, attempt)` and unique company/source-origin keys. Advance through one domain service used by HTTP routes, agent/MCP tools, plugin SDK calls, and recovery jobs; route-only side effects are insufficient because plugin-host issue updates bypass `routes/issues.ts`.

The evaluator's `onFailStepKey` is `implement`, with a bounded `maxAttempts`. Failure completes the historical evaluation child, appends a findings/spec revision, and creates new implementation/evaluation stage runs. It never reopens or overwrites a prior attempt. The accepted-plan decomposition primitive remains the exact-once authority for turning an approved plan revision into downstream stage tasks.

### 10.1 Initial tables and columns

The implementation should use the branch’s emerging schema names, with these required semantics:

#### `agent_harness_revisions`

- `id`, `company_id`, `agent_id`, `revision_number`, `content_hash`;
- canonical `snapshot` JSON and derived `performance_snapshot`;
- `source`, creator agent/user/run, optional parent/rollback revision;
- immutable after insert; unique `(agent_id, revision_number)` and `(agent_id, content_hash)`.

#### `agents.current_harness_revision_id`

- nullable during migration/backfill;
- FK to a revision owned by the same agent/company, enforced in service logic and tests;
- becomes non-null for active living-harness agents after rollout, not globally in V1.

#### `heartbeat_runs`

- `harness_revision_id`, `resolved_adapter_type`, `resolved_model`, `resolved_provider`;
- optional `execution_segments`/metadata for cheap preflight and fallback attempts;
- fields set before/at execution and never rewritten from later agent config.

#### `agent_learning_signals`

- source issue, decision, feedback vote, run, and harness revision references;
- typed signal/outcome, score/max score, body, redacted metadata;
- idempotency unique key appropriate to source type, not only decision ID.

#### `agent_learning_proposals`

- one proposal may aggregate multiple signals; use a join table rather than permanently limiting one signal to one proposal;
- target kind/id, base version, exact proposed changes, evidence summary, confidence, risk, status;
- statuses: `proposed`, `validating`, `rejected`, `awaiting_approval`, `approved`, `promoted`, `rolled_back`, `superseded`;
- evaluation and promotion records must be first-class, not buried only in metadata.

#### Additional required tables

- `agent_learning_proposal_signals`;
- `agent_learning_evaluations`;
- `agent_harness_promotions`;
- `agent_instruction_versions` or a generalized artifact-version table;
- bounded/versioned `agent_memory_blocks` for `environment` and `user_profile` categories;
- skill usage events or counters tied to version IDs.

### 10.2 Schema constraints

- Use shared constants/Zod enums for signal, proposal, status, target, risk, and provenance values.
- Scores use numeric values consistently with execution decisions; do not narrow valid finite scores to integer without a product decision.
- All rows are company-scoped and all cross-table references are checked for company equality.
- Deleting an agent cascades private learned artifacts but preserves audit-safe aggregate metrics where policy allows.
- No raw transcript bulk or secrets in proposal tables.

## 11. API contracts

Board/user endpoints:

```text
GET  /api/agents/:agentId/harness
GET  /api/agents/:agentId/harness/revisions
GET  /api/agents/:agentId/harness/revisions/:revisionId
POST /api/agents/:agentId/harness/snapshot
POST /api/agents/:agentId/harness/revisions/:revisionId/promote
POST /api/agents/:agentId/harness/rollback

GET  /api/agents/:agentId/learning/signals
GET  /api/agents/:agentId/learning/proposals
GET  /api/learning-proposals/:proposalId
POST /api/learning-proposals/:proposalId/validate
POST /api/learning-proposals/:proposalId/approve
POST /api/learning-proposals/:proposalId/reject
POST /api/learning-proposals/:proposalId/promote
POST /api/learning-proposals/:proposalId/rollback
```

Agent endpoints/tools:

```text
POST /api/agents/me/learning-signals
POST /api/agents/me/learning-proposals
GET  /api/agents/me/harness-manifest
GET  /api/agents/me/skills/:skillId/versions/:versionId
```

Agents may create signals/proposals for themselves within company scope. They cannot approve, promote, roll back, change risk classification, or fetch another agent’s private memory. Every mutation requires `X-Paperclip-Run-Id` when agent-authored and writes an activity event.

MCP adds typed equivalents. Do not force agents to invent raw HTTP for eval scores or learning proposals.

## 12. UI contract

Add an **Harness & Learning** area to agent detail:

- current revision, content hash, role, adapter/version, primary/cheap/fallback models, environment, skills and instruction versions;
- run-to-revision history and performance trend;
- side-by-side revision diff with provenance badges;
- learning inbox with signal evidence, proposed exact diff, risk, validation/eval result, cost impact, and approve/reject controls;
- canary/promoted/rolled-back state and one-click rollback;
- memory blocks shown separately from procedural skills and system instructions;
- skill usage/stale/archive indicators;
- clear banners for unavailable model, missing runtime, unhealthy monitor, stale base revision, or failed materialization.

Issue/run UI additions:

- harness revision link on every run;
- resolved adapter/provider/model and fallback reason/level;
- execution segments and cost split;
- evaluator rubric version and numeric score;
- “contributed to learning proposal” backlinks.

No learning action may be hidden behind optimistic success. Failures remain visible and retryable.

## 13. Security and operational safeguards

- Tool allowlists are enforced at dispatch, not described only in prompts.
- Auxiliary learning runs cannot access terminal, browser, arbitrary network, secrets, raw environment, or live mutation tools.
- Learned executable files are disabled in V1. If later enabled, require opt-in, isolated validation, signature/hash, approval, namespace isolation, file locking, and strict size/count limits.
- External/bundled/marketplace skills are immutable; customization forks to a company-owned version.
- Redact credentials and injected memory from evidence. Use streaming context scrubbers where memory is injected.
- Freeze provider/base URL/API mode and memory provider identity into auxiliary run context so it cannot silently use a different backend.
- Enforce per-company monthly learning budget, per-agent proposal rate, and global concurrency.
- Prevent feedback poisoning: one actor, run, or issue cannot meet promotion evidence thresholds alone for high-risk changes.
- Prevent self-approval: proposal author/evidence subject cannot be the sole evaluator or approver.
- Promotion uses transactional pointer updates and idempotency keys.
- Materialization failure leaves the prior revision active.
- Backups/restores preserve harness artifacts and revision pointers; a harness image upgrade does not rewrite learned data.

## 14. Migration and backfill

1. Add nullable harness/run attribution columns and new learning tables.
2. Backfill one `runtime_snapshot` harness revision for each active agent from current managed instructions, desired/current skill versions, adapter/runtime config, permission hash, and environment reference.
3. Set `agents.current_harness_revision_id` only after snapshot validation.
4. Attribute future runs synchronously. Historical runs remain null unless their config can be reconstructed without guessing.
5. Seed role profiles for bug-fixer, bug-reviewer, evaluator, and portfolio-monitor.
6. Create/repair the missing evaluator agent and diagnose portfolio-monitor before enabling learning.
7. Keep learning disabled by default behind company and agent feature flags.
8. Backfill learning signals only from structured execution decisions/feedback; do not mine arbitrary old transcripts in V1.

Migration must be ledger-safe, idempotent, and tested on embedded Postgres plus production Postgres. Rollback removes feature use before dropping data; deployed revisions remain readable throughout rollback.

## 15. Implementation work packages

### WP1 — Shared contracts and schema

- constants, validators, DB tables, indexes, migrations, exports;
- correct the one-signal/one-proposal limitation with a join table;
- add evaluation and promotion records;
- tests for company scope, numeric scores, idempotency, and immutable revisions.

### WP2 — Harness snapshot service

- canonical snapshot builder/hash;
- instruction/skill/runtime/permission inventory;
- current pointer and run attribution;
- snapshot, list, detail, diff, promote, rollback services and routes.

### WP3 — Runtime resolution and truthful ledger

- resolve primary/cheap/fallback policy before execution;
- environment model probe;
- stable fallback classifications and fresh-session handoff;
- resolved adapter/provider/model, harness revision, segments, usage, and cost persistence.

### WP4 — Signal ingestion

- idempotent subscribers for decisions, feedback, approvals, recovery and rollback;
- explicit agent signal endpoint;
- evidence redaction and signal UI/API.

### WP5 — Proposal reviewer and deterministic policy

- bounded auxiliary execution with proposal-only tools;
- patch-first/dedupe behavior;
- provenance, scope, secret/injection, size and concurrency checks;
- no live writes.

### WP6 — Evaluation, approval, promotion and rollback

- versioned eval suites and baseline/candidate comparison;
- execution-policy/approval integration;
- atomic promotion, materialization, canary and auto-rollback.

### WP7 — Role harnesses

- seed/repair classifier, planner, implementer, evaluator, merger, learning-reviewer, and monitor profiles;
- exact model/fallback policies above, with drone-backed roles disabled until their bridge probe passes;
- evaluator typed score submission and immutable retry attempts;
- deterministic label/routing/subtask/merge coordinators;
- monitor read-only/cost/dedupe limits.

### WP8 — UI

- Harness & Learning agent surface;
- proposal diff/approval/eval views;
- run harness/model/fallback/segment ledger;
- rollback and error states.

### WP9 — Curator and memory

- bounded environment/user memory blocks;
- skill usage tracking and progressive disclosure;
- weekly proposal-only curation.

### WP10 — minion-drone bridge

- upgrade Minion's `@minion-stack/drone` dependency to the standalone v0.3 contract;
- register allowlisted executable drone definitions and add authenticated execute/cancel/capability-probe gateway RPCs;
- add a Paperclip `minion_drone` adapter with cancellation, transcript, cost/usage, model discovery, auth, typed result, and run-result parity;
- never accept arbitrary prompts/models/tools from Paperclip and never expose side-effecting Drone tools.

### WP11 — stage-task pipeline and portfolio routing

- add immutable pipeline revisions/runs/stage runs/routing decisions and `stage_tasks` validation;
- generalize GitHub intake beyond one pre-labeled bug repo and return `202` after idempotent parent/classifier creation;
- persist prefixed flat taxonomy labels and apply GitHub labels through a scoped deterministic client;
- add operator-owned repository/scope route rules, Intake fallback, and repo-group presentation metadata;
- materialize blocker-linked stage children and evaluator retry attempts through one transactionally safe coordinator;
- extend Projects SDK/MCP with typed classification, exact-once stage-plan materialization, and stage completion tools.
- Planner Drone heartbeats receive coordinator-built immutable inputs, write a run-attributed `plan` revision, and materialize the accepted typed subtask set only after the Plan HITL decision.
- Merge-readiness accepts one primary GitHub `pull_request` work product only. Its metadata must contain explicit `headSha`, `baseRef`, `baseSha`, and a non-empty typed `checks` array; URLs and comments are never parsed as evidence.
- Release approval freezes that PR evidence in the terminal pipeline event. The final Drone compares the approved SHA with the current stored SHA, records readiness, and completes or blocks orchestration without invoking git, GitHub merge, or push side effects.

## 16. Rollout

1. **Shadow attribution:** snapshot harnesses and tag runs; no learning generation.
2. **Signal-only:** create visible signals from eval decisions and human feedback.
3. **Proposal shadow:** generate proposals but prohibit approval/promotion; compare with human judgment.
4. **Manual promotion:** enable deterministic validation, eval, and HITL promotion for one non-critical canary agent.
5. **Bug workforce canary:** fixer proposals, reviewer/evaluator independent validation, new sessions only.
6. **Low-risk auto-promotion:** bounded memory patches only, with evidence threshold and auto-rollback.
7. **Portfolio monitor:** enable after its production error is resolved and read-only smoke tests pass.
8. **Curator:** enable weekly proposal generation after usage data has accumulated.

Feature flags:

```text
livingHarness.capture
livingHarness.signals
livingHarness.proposals
livingHarness.promotion
livingHarness.autoPromoteMemory
livingHarness.curator
```

Kill switches operate per instance, company, agent, proposal type, and adapter.

## 17. Verification and acceptance criteria

### Data and attribution

- Every new canary run has a valid harness revision and resolved adapter/model fields before completion.
- Repeating an unchanged snapshot reuses the same content hash/revision.
- A run remains linked to its starting revision after later promotion.
- Cross-company references and cross-agent current pointers are rejected.
- No raw secret appears in snapshot, signal, proposal, diff, log, or exported evidence.

### Runtime routing

- Each configured model passes the target-environment adapter probe.
- Harness and model decisions are stored and evaluated separately; OpenCode is never represented as a model and minion-drone is never represented as a workforce harness before its follow-up adapter exists.
- Cheap preflight never persists as the primary session and cannot perform final mutation.
- Classified quota/provider/model failures advance exactly once per configured fallback.
- Work/test/permission/time-limit failures do not incorrectly advance.
- Cross-adapter fallback starts fresh with a redacted handoff and preserves permission scope.
- Cost events and run UI identify every model/segment used.
- A cost-optimized lane is promoted only when canary data beats or matches the incumbent on cost per accepted outcome while meeting the score floor and latency/fallback limits; no test asserts unverified static provider pricing.

### Learning governance

- Background review can only view versioned evidence and create/abstain from proposals.
- Bundled/marketplace/external skills cannot be mutated; an explicit fork succeeds.
- A stale base version fails validation rather than overwriting newer work.
- High-risk proposals cannot self-approve or auto-promote.
- Promotion is atomic; failed sync keeps the previous revision active.
- Rollback restores the exact prior snapshot and pins subsequent runs to it.
- Curator archive is recoverable and never directly deletes a skill.

### Role E2E

- A signed test issue from each registered repository creates exactly one parent issue and one classifier child, even when webhook delivery is retried.
- The classifier returns a typed taxonomy; deterministic code persists Paperclip/GitHub labels, an append-only routing decision, and the selected repository/concern project. Ambiguous classification remains in Intake.
- The selected shared pipeline materializes Plan -> Plan HITL -> Implement -> Evaluate -> Release HITL -> Merge as child issues with native statuses, assignees, blockers, and immutable stage-run identity.
- Planner approval is bound to the exact plan revision and downstream decomposition occurs exactly once.
- Implementer uses its pinned OpenCode/model policy or a recorded classified fresh-session fallback and produces a draft PR, never a merge.
- Evaluator submits a numeric score through the typed update; the ledger stores score/max score/run/harness revision. A failing score appends findings and creates implementation/evaluation attempt N+1 without mutating attempt N.
- Release HITL records optional human score/feedback and is required before merge-readiness.
- The merger drone returns typed readiness only; Paperclip rechecks the frozen approval, target, head SHA, and checks, records `mergeExecuted: false`, and marks the orchestration complete without merging or pushing.
- Every transition is reconstructable from origin delivery through routing, stage issues/runs, artifacts, decisions, approvals, harness revisions, resolved runtimes/models, and merge result.
- At least one safe proposal is generated from the traversal, evaluated, displayed with exact evidence/diff, manually promoted to a canary revision, and successfully rolled back.
- Portfolio monitor completes a read-only run, creates no duplicate issue, stays inside budget, and does not enter `error`.

### Quality gates

- DB generation/migration tests, shared/server/UI typechecks, focused unit/integration tests, and production build pass.
- Existing non-living agents and adapters behave unchanged with feature flags off.
- Existing bug callback/autostart behavior remains functional.
- Production deploy includes a documented backup, migration ledger check, health check, agent idle/live-run check, temporary-key audit, and rollback procedure.

## 18. Definition of done

The living-agent harness is complete only when Paperclip can answer, from durable records:

1. Which exact instructions, skills, adapter, model, permissions, and environment produced this run?
2. What evaluator/human/runtime evidence suggested a change?
3. What exact artifact diff was proposed, validated, evaluated, and approved?
4. Which revision is live, where is it canaried, how is it performing, and how can it be rolled back?

If any answer depends on mutable files, a guessed runtime, an unlinked transcript, or an agent’s prose claim, the loop is not yet governed and is not done.
