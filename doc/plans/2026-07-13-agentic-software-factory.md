# MINION Agentic Software Factory — Conversational Intake Contract

**Status:** Vertical slice in implementation  
**Date:** 2026-07-13  
**Scope:** Minion Hub assistant, Workforce/Paperclip control plane, MINION Code portfolio, and Minion Drone classifier

## Outcome

The MINION Code portfolio is the software factory. Each project is a governed production line. A signed-in Hub user can open the floating assistant, switch to **Factory**, describe a feature or bug in natural language, and receive a durable, traceable root issue routed into the existing delivery pipeline.

The first slice does not treat chat as a hidden side effect. The request becomes a real Paperclip issue before model work starts, and every subsequent decision is represented by a pipeline run, child issue, activity event, or human gate.

```text
Hub assistant — Factory mode
  -> signed company/user-scoped factory intake
  -> durable root issue in Portfolio Intake
  -> bounded control-plane context collection
  -> typed Minion Drone classification
  -> deterministic route resolution
       high confidence -> existing production line + canonical delivery pipeline
       ambiguous/gap   -> user/role routing gate in Hub /work
                           -> existing project | governed new project | reject
                           -> canonical delivery pipeline
  -> Plan -> Plan HITL -> Implement -> Evaluate/retry -> Release HITL -> Merge readiness
```

## Product boundaries

- Hub `/work` is the canonical human queue. `/workforce/inbox` remains an operational compatibility view, not the primary product destination.
- Factory intake remains available when the personal gateway agent is offline because it uses Hub's authenticated server-side Workforce bridge. Normal assistant chat keeps its existing gateway path.
- The client never supplies a trusted company ID, user ID, or role. Hub derives the active organization and mints the signed Workforce identity.
- A role-scoped routing gate may only use roles present in the signed actor claims. Exact-user gates resolve to the signed requester.
- The classifier chooses one frozen candidate or Portfolio Intake. It cannot invent a project ID, create a project, edit code, or mutate the pipeline.
- A new production line is created only by a human routing decision and is attached to the same canonical delivery pipeline.

## Intake API

### Create

```http
POST /api/companies/:companyId/factory-intakes
```

```ts
type CreateFactoryIntake = {
  request: string;
  source: {
    kind: 'hub_assistant';
    route: string;
    selectedAgentId?: string;
  };
  idempotencyKey: string;
  routingTarget?: { type: 'user' } | { type: 'role'; roleKeys: string[] };
};
```

The service namespaces idempotency by company and signed actor, creates the root issue exactly once, captures context, queues classification, and returns `202 Accepted`. Replaying the same key returns the same root issue and reports `idempotentReplay: true`.

### Inspect

```http
GET /api/factory-intakes/:rootIssueId
```

The projection contains the intake state, root issue, portfolio/project, frozen routing evidence, active pipeline run, routing target, and same-origin navigation identifiers. Hub reconstructs its own links rather than trusting backend-provided URLs.

### Decide an ambiguous route

```http
POST /api/factory-intakes/:rootIssueId/routing-decision
```

```ts
type FactoryRoutingDecisionInput = {
  decision:
    | { kind: 'existing_project'; projectId: string }
    | {
        kind: 'new_project';
        name: string;
        description?: string | null;
        repositoryKey: string;
        groupKey?: string;
        scopes?: string[];
      }
    | { kind: 'reject' };
  note?: string | null;
};
```

Only the frozen gate participant may decide. The service revalidates company membership, signed user/role authority, the current pipeline cursor, candidate ownership, and exact-once terminal state before applying the decision.

## Context collection and scout boundary

The initial release collects bounded, company-local control-plane evidence:

- candidate project metadata, repository/group keys, scopes, path prefixes, and complete workspace repository references;
- recent related issues with short excerpts;
- project/issue documents with short excerpts;
- explicit bounds and a statement that repository code search did not run.

Its evidence mode is `control_plane_metadata`, with `codeSearchExecuted: false` and `pendingCapabilities: ["tool_bearing_code_search"]`. The product must not label that evidence as a completed code search.

A later scout revision will add a real repository-reading stage before classification. The current runtime recommendation is an isolated `codex_local` read-only session using a cost-optimized coding model, no approvals, no network search, a strict workspace root, a short timeout, and at most one retry. OpenCode is not the default scout until its adapter exposes a sufficiently narrow read-only permission contract. The scout emits a separately versioned bounded evidence envelope; it still performs no writes.

## Runtime roles

| Stage                            | Harness                          | Initial model policy                         | Authority                                                         |
| -------------------------------- | -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Control-plane context            | Deterministic Paperclip service  | none                                         | Read company project/issue/document metadata only                 |
| Repository scout, later revision | `codex_local` isolated read-only | `gpt-5.3-codex-spark` canary, evidence-gated | Read one registered repository workspace; emit bounded references |
| Intake classifier                | `minion_drone`                   | Claude Haiku 4.5, Gemini Flash fallback      | Typed labels/scopes/candidate key only                            |
| Spec planner                     | `minion_drone`                   | high-reasoning Opus-class policy             | Typed plan and traceable subtasks; no code writes                 |
| Implementer                      | `opencode_local`                 | Sonnet-class provider policy                 | Isolated worktree, implementation, tests, draft PR; never merge   |
| Evaluator                        | `minion_drone`                   | GPT-5.4, Opus fallback                       | Independent typed score/findings; no code writes                  |
| Merge readiness                  | `minion_drone`                   | cost-optimized bounded model                 | Validate approved evidence and SHA; no merge mutation             |
| Merge executor                   | deterministic service            | none                                         | Merge only the approved immutable head SHA                        |
| Harness learning curator         | `hermes_local` canary            | environment-probed policy                    | Propose memory/skill/harness patches; never self-promote          |

The harness and model are independent axes. A model fallback does not imply a compatible session/runtime fallback, and a runtime change always starts a fresh session with a redacted handoff.

## Hub behavior

The assistant exposes explicit **Chat** and **Factory** modes:

- Chat keeps the personal agent/gateway transcript unchanged.
- Factory is available without a live personal agent connection and submits through a dedicated authenticated Hub server route.
- `/work` and Workforce pages default the composer to Factory; the user may switch back to Chat.
- The accepted request renders a durable status card and polls only while classification is pending.
- Ambiguous routing links to `/work` and exposes the existing-project/new-project/reject decision surface.

Hub `/work` combines native assigned tickets/leads/orders with signed Workforce HITL projections. It reuses the fail-closed inbox normalizer, shows only exact-user or intersecting signed-role gates, never offers native reassignment for a pipeline gate, and continues to render native work when Workforce is unavailable.

## Acceptance criteria

- A signed user can submit a feature request from the assistant and receive the same root issue on an idempotent retry.
- The root issue records origin `paperclip`, requester, active company, source route, bounded evidence, and classifier input.
- High-confidence classification selects only an existing frozen project candidate and starts the canonical pipeline.
- Fallback or ambiguous classification creates one actionable user/role routing gate visible in `/work`.
- An eligible user can route to an existing project, create a governed project, or reject; an ineligible user cannot see or decide the gate.
- New project creation is company-scoped, portfolio-linked, metadata-backed, and followed by the same canonical delivery pipeline.
- The assistant remains capable of submitting factory work while the gateway/personal agent is offline.
- `/work` keeps native items visible when Workforce is offline and communicates only the missing factory lane.
- Tests cover schema bounds, source discrimination, idempotency, cross-company isolation, signed participant enforcement, project ownership, pipeline activation, Hub proxy trust boundaries, queue federation, and assistant result normalization.

## Deferred work

- Tool-bearing repository scout and separately versioned code evidence.
- Specialized security/performance/documentation reviewer fan-out and coordinator synthesis.
- Deterministic merge execution after immutable-SHA verification. The current final Drone remains merge-readiness only.
- Automatic canary promotion of harness/model revisions. Living-harness changes remain proposal/approval driven.
