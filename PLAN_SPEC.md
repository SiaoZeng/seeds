# Seeds: `sd plan` — Planning Facilitation

Design spec for extending seeds beyond issue tracking into a structured planning layer for AI agents.

## Thesis

Most human and agent attention should be spent in the planning step, not the review step. Plans should be the artifact reviewed; by the time an agent is tasked with implementation, the work should be so straightforward that even a small model can execute it. When an implementation fails, the fix belongs in the planning *process* — adding a new section, validation rule, or risk check that prevents the failure mode next time — not in post-hoc code review.

`sd plan` makes planning a structured, templated, customizable workflow that lives where the work already lives: alongside the seeds it produces.

## Design Principles

1. **Structured data, not prose.** Plans are JSONL rows with validated fields. No markdown plan documents anywhere in the artifact path. The plan is queryable, validatable, mechanically traversable.
2. **Plans are first-class.** Plans get their own ID space and their own JSONL file, parallel to issues. They are not a field on a seed.
3. **Bidirectional linking.** Plans know their parent seed and their spawned children; seeds know their plan. Navigation is cheap from either direction.
4. **Config-declared templates.** Customization mirrors mulch's `custom_types`: declare plan templates in `.seeds/config.yaml` with required/optional sections and validation. AJV schema generated from the template definition.
5. **Soft mulch coupling.** `sd plan` works standalone. If `ml` is on PATH, prior art (conventions, patterns, decisions, failures) is injected into the planning prompt automatically. Mulch absent → planning still works.
6. **One-shot with resume.** The LLM receives a structured prompt, produces a complete plan JSON, and submits it. Validation failure returns a patchable partial-state diff — no multi-turn state machine required.
7. **Decomposable, recursively.** A plan step may itself be another plan. Epics decompose into nested plans without context-switching to a different tool.

## Architecture Overview

```
.seeds/
  config.yaml          # adds plan_templates: block
  issues.jsonl         # unchanged shape; gains optional plan_id field
  plans.jsonl          # NEW — one plan per line
  templates.jsonl      # convoy templates (existing, untouched)
  .gitignore
```

Plans are created via `sd plan prompt <seed-id>` → LLM → `sd plan submit <seed-id>`. On successful submit, child seeds are spawned with blocking edges wired and `plan_id` back-pointers populated.

## On-Disk Format

### config.yaml additions

```yaml
project: overstory
version: "1"

plan_templates:
  feature:
    sections:
      context:
        required: true
        kind: text
        min_length: 50
        prompt: "Why does this work need to happen? What problem or opportunity drives it?"
      approach:
        required: true
        kind: text
        prompt: "What's the chosen approach, and why this over alternatives?"
      alternatives:
        required: false
        kind: list
        item:
          name: { kind: text }
          rejected_because: { kind: text }
        prompt: "What other approaches were considered and rejected?"
      steps:
        required: true
        kind: steps
        min: 2
        prompt: "Decompose into ordered, independent implementation steps. Each becomes a child seed."
      risks:
        required: false
        kind: list
        item: text
        mulch_source: failure
        prompt: "What could go wrong? Known failure modes from prior work are pre-filled when mulch is available."
      acceptance:
        required: true
        kind: list
        item: text
        min: 1
        prompt: "Concrete, verifiable conditions for plan completion."
```

Section field reference:

| Field           | Purpose                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `required`      | Validation gate. Required sections must be non-empty on submit.                                     |
| `kind`          | One of `text`, `list`, `steps`, or a structured object spec.                                        |
| `min_length`    | For `kind: text` — minimum character count.                                                          |
| `min`           | For `kind: list` or `kind: steps` — minimum number of entries.                                       |
| `item`          | For `kind: list` — schema for each entry. Either `text` or a structured object.                      |
| `mulch_source`  | When mulch is present, pre-populate this section's `prior_art` from records of this type.            |
| `prompt`        | The natural-language prompt the LLM sees when filling this section.                                 |

### plans.jsonl

One plan per line, append-on-create, atomic-rewrite on update (same locking model as `issues.jsonl`).

```jsonl
{"id":"pl-a1b2","seed":"seeds-9c4d","template":"feature","status":"draft","revision":1,"sections":{"context":"...","approach":"...","alternatives":[],"steps":[{"title":"Add OAuth provider config","type":"task","priority":2,"blocks":[1]},{"title":"Wire callback handler","type":"task","priority":2,"blocks":[]}],"risks":["Token refresh race condition (mx-902)"],"acceptance":["Login flow completes end-to-end","Refresh token rotates on use"]},"children":["seeds-aa01","seeds-aa02"],"outcome":null,"reviewedBy":null,"createdAt":"2026-05-06T10:00:00Z","updatedAt":"2026-05-06T10:00:00Z"}
```

### issues.jsonl additions

Two optional fields on `Issue`:

- `plan_id?: string` — the plan this seed is part of (parent seed or spawned child).
- `plan_step_index?: number` — for spawned children, the index in the plan's `steps` array (enables stale-child detection on plan revisions).

These are additive; existing seeds remain valid.

## Plan Lifecycle

```
draft  →  approved  →  active        →  done
              ↓             ↓
        (validation     (children
         passed,         all closed,
         children        outcome
         spawned)        appended)
```

- **draft** — created by `sd plan prompt`; not yet submitted, no children.
- **approved** — `sd plan submit` succeeded, validation passed, children spawned.
- **active** — at least one child seed is `in_progress`. Set automatically.
- **done** — all children closed. `sd plan outcome` may append a result.

Optional human review gate is **suggested, not enforced** (see Reviewer Suggestion below).

## Command Surface

```
sd plan prompt   <seed-id> [--template <name>] [--domain <name>]
                                                       Print structured prompt JSON to stdout.
                                                       Embeds mulch prior_art when ml is on PATH.

sd plan submit   <seed-id> --plan <file> [--overwrite]
                                                       Validate plan JSON, spawn children, write
                                                       plans.jsonl row, update parent seed.
                                                       --overwrite required to replace an existing
                                                       approved plan.

sd plan show     <pl-id>                               Display plan with sections, children, status.

sd plan list     [--seed <id>] [--status <s>]          Query plans.
                 [--outcome <r>] [--template <name>]

sd plan outcome  <pl-id> --result <success|partial|failure>
                 [--note <text>]                       Append outcome on plan close.

sd plan validate <pl-id>                               Re-run validation against current template
                                                       (useful after template config changes).

sd plan templates                                      List available templates from config.
```

`sd ready` is updated to surface plans-in-`draft` for the parent seeds it would otherwise return — planning is the highest-priority work when present.

`sd show <seed>` and `sd list` gain awareness of `plan_id`: a seed with a plan in `draft` displays a hint, and a seed whose plan is `approved` shows the children inline.

## Walkthrough Protocol

Hybrid: one-shot with resume on validation failure.

### Successful path

```bash
$ sd plan prompt seeds-9c4d --template feature > plan.json
# stdout is the structured prompt: sections, prompts, validation rules,
# and prior_art populated from mulch where mulch_source matched.

# LLM fills plan.json with answers under sections.

$ sd plan submit seeds-9c4d --plan plan.json
✓ plan pl-a1b2 created (status: approved)
✓ spawned 4 child seeds: seeds-aa01, seeds-aa02, seeds-aa03, seeds-aa04
✓ seeds-9c4d now blocked by 4 children
```

### Validation-failure path

```bash
$ sd plan submit seeds-9c4d --plan plan.json
✗ validation failed:
  - sections.risks: required, missing
  - sections.steps: must have >=2 entries (got 1)

# stderr emits a partial-state JSON the LLM patches and resubmits:
# {
#   "errors": [
#     { "path": "sections.risks", "code": "required", "fix": "add a 'risks' array (string entries)" },
#     { "path": "sections.steps", "code": "min", "fix": "add at least 1 more step entry" }
#   ],
#   "current": { ...plan-as-submitted... }
# }

# LLM patches plan.json and re-submits.
```

The LLM never has to re-run `sd plan prompt`; the failure response carries enough state to patch and retry.

### Prompt JSON shape (emitted by `sd plan prompt`)

```json
{
  "plan_request": {
    "seed": "seeds-9c4d",
    "template": "feature",
    "instructions": "Fill every section. Required fields are marked. Use prior_art entries to ground decisions.",
    "sections": [
      {
        "name": "context",
        "required": true,
        "kind": "text",
        "min_length": 50,
        "prompt": "Why does this work need to happen?",
        "prior_art": []
      },
      {
        "name": "risks",
        "required": false,
        "kind": "list",
        "item": "text",
        "prompt": "What could go wrong?",
        "prior_art": [
          { "id": "mx-902", "type": "failure", "summary": "OAuth token refresh race in concurrent sessions" }
        ]
      }
    ],
    "validation": {
      "all_required_present": true,
      "min_steps": 2,
      "min_acceptance": 1
    }
  }
}
```

### Submission JSON shape (consumed by `sd plan submit`)

```json
{
  "template": "feature",
  "sections": {
    "context": "...",
    "approach": "...",
    "alternatives": [
      { "name": "Build custom JWT layer", "rejected_because": "Reinventing wheel; OAuth library is mature." }
    ],
    "steps": [
      { "title": "Add OAuth provider config", "type": "task", "priority": 2, "blocks": [2] },
      { "title": "Wire callback handler", "type": "task", "priority": 2, "blocks": [] }
    ],
    "risks": ["Token refresh race (mx-902)"],
    "acceptance": ["Login flow completes end-to-end"]
  }
}
```

The `blocks: [2]` syntax in `steps` references **1-based** step indices (step 1 is the first step, step N is the last) and uses forward semantics: step 1 with `blocks: [2]` means step 1 *blocks* step 2 (step 2 depends on step 1 finishing first). On submit, indices are translated into spawned-seed IDs: each child gets the targets in its `blocks` field, and each target gets the blocking step's ID appended to its `blockedBy` field. Leave `blocks: []` for steps nothing depends on. Note: the internal `plan_step_index` field stored on each spawned child seed remains 0-based — it's a code-level back-link, not author-facing.

## Plan Templates (Customization)

Templates are declared in `.seeds/config.yaml` under `plan_templates:`. Each template names a set of sections and validation rules. Templates ship with seeds (built-in defaults loaded if not redeclared) and can be overridden or extended per project.

### Built-in templates

| Template   | Use case                                                              |
| ---------- | --------------------------------------------------------------------- |
| `feature`  | New capability or significant change. Default for `type: feature`.    |
| `bug`      | Defect fix. Adds `reproduction` and `root_cause` sections.            |
| `refactor` | Internal restructuring. Adds `behavior_invariant` (must stay equal). |

`sd plan prompt <seed-id>` infers the template from the seed's `type` if `--template` is not passed.

### Section `kind` reference

| Kind          | Shape                              | Notes                                                       |
| ------------- | ---------------------------------- | ----------------------------------------------------------- |
| `text`        | string                             | `min_length` optional.                                      |
| `list`        | array                              | `item: text` or `item: { ...object spec... }`. `min` opt.   |
| `steps`       | array of step objects              | Spawns child seeds 1:1. Step is `{title, type, priority, blocks: [step_index], plan_template?}`. `blocks` uses 1-based step indices. |
| object spec   | nested record of named fields      | Each field has its own `kind` recursively.                  |

A custom template:

```yaml
plan_templates:
  spike:
    sections:
      hypothesis:
        required: true
        kind: text
        prompt: "What are we trying to learn?"
      timebox:
        required: true
        kind: text
        prompt: "Hard upper bound (hours/days)."
      success_signal:
        required: true
        kind: list
        item: text
        prompt: "What observable signals tell us the spike succeeded?"
      kill_signal:
        required: true
        kind: list
        item: text
        prompt: "What signals tell us to stop and abandon?"
      steps:
        required: false
        kind: steps
        prompt: "Optional: tasks if the spike confirms the hypothesis."
```

Validation is generated from the template config the same way mulch generates AJV schemas from `custom_types`.

## Default `feature` Template

Six sections:

1. **context** *(required, text)* — Why the work matters.
2. **approach** *(required, text)* — Chosen approach with rationale.
3. **alternatives** *(optional, list)* — Considered + rejected.
4. **steps** *(required, steps, min 2)* — Decomposition; each becomes a child seed.
5. **risks** *(optional, list, mulch_source: failure)* — Known failure modes.
6. **acceptance** *(required, list, min 1)* — Verifiable completion conditions.

`out_of_scope` and `open_questions` are deliberately omitted from the default. They are workflow-specific and easy to add via custom templates.

## Nested Plans

A step in `kind: steps` may declare `plan_template: <name>` to mark itself as a sub-plan. On submit, the spawned child seed is created with `requires_plan: true`. Calling `sd plan prompt <child-seed-id>` then walks the LLM through the sub-plan using the named template. This decomposes epics in-place without context switching.

```json
{
  "title": "OAuth integration",
  "type": "epic",
  "priority": 1,
  "plan_template": "feature"
}
```

Bidirectional linking is preserved: the sub-plan's `seed` field points at the spawned child; the spawned child's `plan_id` points at the sub-plan once created. `sd plan show <pl-id>` recursively displays nested plans up to a configurable depth (default 3).

A child seed marked `requires_plan: true` is excluded from `sd ready` until its sub-plan reaches `approved`. This guarantees no implementation begins on un-planned epic branches.

## Mulch Integration (Soft)

When `ml` is resolvable on PATH, `sd plan prompt` enriches the prompt JSON with prior art:

1. **Domain inference** — explicit `--domain` flag → seed labels matching declared mulch domains → directory anchors derived from `git diff --name-only` against the seed's referenced files.
2. **Per-section enrichment** — for any section with a `mulch_source: <type>` hint (or for sections matching well-known names: `approach` ↔ pattern + decision; `risks` ↔ failure; `acceptance` ↔ guide), seeds shells out to `ml query --domain <name> --type <type> --json --limit 5` (or calls the programmatic API exported from `mulch/src/api.ts`).
3. **Embedding** — top-N records become `prior_art` entries on the section: `[{id, type, summary, relevance}]`. The LLM is instructed to ground its answer in these entries when relevant.

Mulch absent → `prior_art` arrays are empty, validation rules are unaffected, planning still works.

### Optional outbound write

`sd plan submit --record-decision` (off by default) calls `ml record <inferred-domain> --type decision --rationale <approach> --evidence-seeds <plan-id>` on success. This back-fills the chosen approach as a mulch decision linked to the plan. Defaults to off so seeds remains standalone.

## Validation

AJV schema is generated from each template's section spec. Validation runs on `sd plan submit` and is re-runnable via `sd plan validate <pl-id>` (e.g., after editing the template config).

Validation covers:

- Required sections are present and non-empty.
- `min_length` on `text` sections.
- `min` on `list` and `steps` sections.
- `steps[].blocks` references valid **1-based** step indices in the range `1..steps.length` (step 1 is the first step). `0` and out-of-range values are rejected with a clear "step indices are 1-based" error; self-references (step `n` listing `n` in its own `blocks`) are also rejected.
- Object-spec fields match their declared `kind`.
- `template` name resolves in `plan_templates`.

Validation failure emits the partial-state diff described in Walkthrough Protocol.

## Re-submission and Overwrite

Re-submitting a plan for a seed that already has a non-`draft` plan is rejected by default:

```bash
$ sd plan submit seeds-9c4d --plan plan.json
✗ plan pl-a1b2 already exists for seeds-9c4d (status: approved, revision: 1)
  Use --overwrite to replace it. Spawned children will not be auto-closed;
  obsolete steps from the previous revision will be flagged.
```

With `--overwrite`:

1. The existing `plans.jsonl` row is replaced atomically. `revision` is incremented.
2. The new `steps` are diffed against the previous `children` by step title (or by `step_id` if templates declare stable IDs).
3. Children whose corresponding step is gone are listed in stderr as **obsolete** with a suggestion to close them: `sd close seeds-aa03 --reason "obsoleted by plan pl-a1b2 revision 2"`. Seeds does not auto-close them — the LLM has the context to decide whether the existing work is still useful.
4. New steps spawn new child seeds; existing matching children are kept.

Plan revisions are not preserved as separate rows. Git history of `plans.jsonl` is the audit trail. This keeps storage simple and avoids ID-space inflation.

## Outcomes

Plans gain a lightweight outcome field:

```bash
$ sd plan outcome pl-a1b2 --result success
$ sd plan outcome pl-a1b2 --result failure --note "auth provider library deprecated mid-implementation"
```

Outcome values: `success | partial | failure`. Aggregation, retros, template-evolution-from-failures are deliberately out of scope — those workflows are team-specific. Outcomes are stored so external tooling (or future seeds commands) can build on them.

## Reviewer Suggestion (Not Required)

Human review of plans is suggested but not gated:

- `sd plan submit` transitions `draft → approved` automatically on successful validation.
- `sd plan show` displays a "review suggested" hint when `reviewedBy` is null.
- `sd plan review <pl-id> --by <name>` populates `reviewedBy`. This is informational, not a state transition.
- Teams that want a hard gate can wrap `sd plan submit` in a hook or CI check that blocks the spawned children's `ready` state on a `plan-reviewed` label.

The default optimizes for autonomous swarms; opt-in rigor for teams that need it.

## Out of Scope (V1)

- **Markdown plan documents.** Plans are structured data, not prose.
- **Failure-feedback automation.** Plans don't auto-evolve templates from outcomes; that's workflow-specific and defers to teams.
- **Canopy integration.** Planning prompts are not stored as canopy templates in V1.
- **Plan diffing UI.** Git diff of `plans.jsonl` is the V1 review surface.
- **Cross-repo plans.** A plan lives in one `.seeds/` instance; multi-repo coordination is out of scope.
- **Real-time collaboration.** Same locking model as issues — atomic writes, last-write-wins on conflicts.

## Open Implementation Questions

1. **Section schema vs. `custom_types` reuse.** Should `plan_templates` reuse mulch's `custom_types` AJV-schema-generation code (extract into a shared package), or maintain a parallel implementation in seeds? Sharing reduces drift; keeping them separate keeps seeds dependency-free.
2. **Step ID stability.** `--overwrite` diffing by step title is fragile. Should templates be able to declare stable `step_id` keys that survive title edits, at the cost of more author burden?
3. **Mulch query interface.** Shell out to `ml query --json` (works today, language-agnostic) vs. import from `@os-eco/mulch-cli` programmatically (faster, tighter coupling, requires npm dep). Soft coupling argues for the shell route.
4. **Default template inference.** Inferring template from seed `type` is convenient but couples the type taxonomy to template names. Should the mapping be configurable, or hard-coded to `task→feature, bug→bug, feature→feature, epic→feature` (with `--template` always overriding)?
5. **Sub-plan depth.** Recursive nested plans risk runaway decomposition. Should there be a configurable `max_plan_depth` in `config.yaml` (default 3)?
6. **Children lifecycle when parent plan moves to `done`.** If a plan is marked `done` but children are still open, is that a validation error, a warning, or allowed? Recommend: warning, not error, so plans can be retroactively closed without forcing child cleanup first.
