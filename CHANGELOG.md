# Changelog

All notable changes to Seeds will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `Plan.name?: string` — optional short human-readable label so `sd plan list` and `sd plan show` carry semantic signal beyond opaque `pl-*` ids. `sd plan submit` resolves the name in priority order: `--name <text>` flag > top-level `name` field in the plan JSON > parent seed's title (fallback). `sd plan show` renders a `Name:` header line; `sd plan list` shows the name (or `(unnamed)`) in a fixed-width column between `rev` and `template`, truncated with `…` at ~40 chars. `--json` payloads gain the field additively — existing plans without a `name` row continue to deserialize. `--overwrite` preserves the existing name unless `--name` or the plan JSON supplies a new one. (seeds-5640)

## [0.4.3] - 2026-05-10

### Added
- `sd show <id> [<id2> ...]` accepts multiple ids in one call; agents reviewing related issues (blockers, deps, plan children) no longer pay one shell-out per id. Each output format gets a per-format separator: default human uses a 60-char `─` divider between entries, `--format plain` uses a blank line, `--format compact` and `--format ids` print one entry per line, `--json` returns an `issues` array (with optional `errors` for unknown ids). Single-id behavior — including the `{issue, plan, plan_children}` JSON shape and the `pl-*` → `sd plan show` routing — is preserved exactly; plan ids in multi-id mode are reported as per-id errors pointing at `sd plan show`. Unknown ids do not abort the rest of the call (mirroring `sd close`); the command exits non-zero when any id fails. (seeds-4eba)
- `sd config` command tree — schema-driven read/write surface for `.seeds/config.yaml` aimed at warren V2's per-tool config UI (warren ROADMAP R-10). `sd config schema [--json]` emits the JSON Schema; `sd config show [--path <p>] [--json]` reads the whole config or a value at a dot-path; `sd config set <path> <value>` validates + writes atomically (`<value>` is YAML-parsed); `sd config unset <path>` removes a value. Writes hold the `config.yaml` advisory lock and validate the post-write file against the schema; partial writes that would leave the file inconsistent are rejected. The schema covers `project`, `version`, `max_plan_depth`, and the nested `plan_templates` editor (with built-in template defaults in `examples`). Locked with a golden test in `src/commands/config.test.ts` so any wire-format change is intentional. (seeds-ac83)
- `sd doctor` adds a `closed-fields-consistency` check (`--fix`-able): non-closed issues with stale `closedAt`/`closeReason` fail (fix clears both); closed issues missing `closedAt` warn (fix sets it to `updatedAt`). Doctor pass count bumped 11 → 12. (seeds-8526)

### Fixed
- `sd show <pl-id>` now shows the plan instead of erroring `Issue not found`. When the requested id starts with `pl-` and isn't in `issues.jsonl`, `sd show` routes to the same renderer as `sd plan show` for both default and `--json` output. `--format compact|plain|ids` on a plan id errors with a hint pointing to `sd plan show`. Issue lookup happens first, so projects literally named `pl` (whose issue ids share the `pl-XXXX` shape) still resolve normally. (seeds-66de)
- `sd update --status open` (or any non-closed status) now drops stale `closedAt` / `closeReason` from the record. Previously a close→reopen cycle left phantom close metadata so `sd show` displayed a "closed at" timestamp on an open issue. (seeds-8526)

## [0.4.2] - 2026-05-10

### Added
- `Issue.extensions?: Record<string, unknown>` — optional, opaque-to-seeds field for runtime metadata that consumers (warren, greenhouse, overstory) own under namespaced keys. Seeds performs no schema validation on the value; it round-trips byte-for-byte through `.seeds/issues.jsonl`. (seeds-f35a, plan pl-c195)
- `sd show` renders an `Extensions: key=value ...` line when the field is present and non-empty; each value is JSON-encoded so strings stay quoted and nested objects/arrays/null are unambiguous. JSON output is unchanged — extensions already serialized as part of the issue payload. (seeds-e7ea)
- `sd update --extensions <json>` shallow-merges (`{...existing, ...incoming}`) a JSON object into `Issue.extensions`. `--clear-extensions` removes the field. The two flags are mutually exclusive; arrays, `null`, scalars, and malformed JSON are rejected with a clear error. Merge is one level deep — consumers needing nested structure should keep keys flat (e.g. `lastRunId`, `lastRunAt`) rather than nesting under `lastRun`. (seeds-be14)
- `sd ready --respect-schedule` (opt-in) excludes issues where `extensions.queued === true` (strict equality) or `extensions.scheduledFor` parses to a future ISO8601 timestamp. Default `sd ready` behavior is unchanged — agents still see queued items unless they ask for the schedule-aware view. Designed for warren's cron-driven dispatch. (seeds-614b)
- `sd doctor` adds an `extensions-schema` check that flags non-object `extensions` values (null, arrays, scalars). `sd doctor --fix` drops malformed values. (seeds-56ff)

### Convention
- **Extension namespacing.** Each consumer owns a top-level prefix on `Issue.extensions` (e.g. `extensions.warren_*`, `extensions.greenhouse_*`) or a single namespaced sub-object. The two well-known keys consumed by `sd ready --respect-schedule` are `extensions.queued` (boolean) and `extensions.scheduledFor` (ISO8601 string). Other keys are opaque to seeds.

## [0.4.1] - 2026-05-08

### Added
- `sd plan show|validate|outcome|review` now accept a seed ID in addition to a `pl-*` plan ID — resolves via `seed.plan_id`, removing the round-trip through `sd plan list` when an agent already has the seed in hand. (seeds-51bc)
- `sd plan submit` prints a Next-action block to stderr on success (`sd plan show`, `sd ready`, conditionally `sd plan review`) and surfaces the recorded mulch decision id on the `--record-decision` success path. JSON output is untouched: `--json` mode suppresses the Next block so stdout stays parseable. (seeds-d6cb)
- Child seeds spawned by `sd plan submit` carry a marker-delimited "plan backref" block in their description with the step number, plan id, parent seed id+title, template, an excerpt of `sections.approach`, and a `sd plan show <pl-id>` link. `--overwrite` refreshes just the marker section in place; assignee, labels, and any manual notes outside the markers survive the rewrite. (seeds-76af)
- `sd onboard` snippet surfaces the installed seeds version as both a `<!-- seeds-onboard:v$VERSION -->` marker and inline body text. A separate `<!-- seeds-onboard-schema:N -->` marker drives outdated-snippet detection so patch releases don't mark every existing snippet as outdated; legacy `seeds-onboard-v:N` markers auto-upgrade on next run. `VERSION` extracted to `src/version.ts` so it can be imported without triggering `index.ts` CLI side-effects. (seeds-3da2)

### Fixed
- `sd plan submit`: `step.blocks=[j]` now correctly means "this step blocks step `j`" (matching the PLAN_SPEC.md natural-language example). Previously the indices were written into each child's `blockedBy`, inverting the chain so `sd ready` surfaced trailing steps first. Both fresh-submit and overwrite paths now wire bidirectional edges (`source.blocks += target`, `target.blockedBy += source`) with dedupe; overwrite handles matched-source as well as matched-target, fixing a pre-existing case where edges added in a revision didn't update existing children. Inverted plans submitted before this fix are not auto-corrected (tracked separately in seeds-1c38). (seeds-4a54)
- `sd plan show` no longer `JSON.stringify`s structured list entries into the user-facing review surface for `steps` and `alternatives`. Dispatch on the section spec: `kind=steps` formats step titles with indented `blocks`/`requires_plan`/`plan_template` sub-lines, `kind=list` with an object item schema renders each named field per line, and plans whose template is no longer registered fall back to a JSON dump rather than crash. (seeds-7d17)
- `sd show <child-seed>`: the plan block now labels the step list "Plan steps" rather than "Children (N)" — the list is the seed's siblings, not its descendants. `sd plan show` keeps "Children" since the heading is correct from the plan's perspective. (seeds-b2d7)

## [0.4.0] - 2026-05-06

### Added
- `sd plan` command tree — structured planning facilitation that decomposes a seed into child seeds via an LLM-driven walkthrough. Designed for work that's large or ambiguous enough to benefit from upfront decomposition; for small, well-scoped tasks just `sd create` directly. Full design in [PLAN_SPEC.md](./PLAN_SPEC.md).
  - `sd plan templates` — list available plan templates
  - `sd plan prompt <seed-id> [--template <name>] [--domain <name>]` — emit structured `plan_request` JSON the LLM fills out; default template inferred from seed type. `instructions` and `--help` document the submit reply shape so the prompt → submit transformation is explicit. `prior_art` is enriched from mulch (`approach` ↔ pattern+decision, `risks` ↔ failure, `acceptance` ↔ guide) when mulch is on PATH.
  - `sd plan submit <seed-id> --plan <file|->` — validate via AJV + structural `steps[].blocks` index check, spawn one child seed per step with `blockedBy` id remap, append the plan row to `.seeds/plans.jsonl`, and update the parent seed (`plan_id` back-pointer + `blockedBy = [children]`). `-` reads from stdin. Validation failures emit a partial-state diff JSON to stderr. `--overwrite` replaces an existing non-draft plan, matches steps by title, preserves child IDs, and prints obsolete-child close suggestions to stderr (never auto-closes). `--record-decision` writes the approach to mulch as a decision record after success (best-effort, never rolls back the plan). `--domain` forces the mulch domain.
  - `sd plan show <pl-id>` — display sections, child summaries, status, and a "review suggested" hint when status is `approved`/`active` and no reviewer is recorded. Recurses through nested sub-plans up to `max_plan_depth` (default 3, configurable).
  - `sd plan list [--seed --status --outcome --template]` — query plans with combinable filters; default sort `createdAt` desc.
  - `sd plan validate <pl-id>` — re-run validation against the current template definition.
  - `sd plan outcome <pl-id> --result success|partial|failure [--note <text>]` — record a plan outcome (storage-only; never gates child progress).
  - `sd plan review <pl-id> --by <name>` — record a reviewer (informational; not a state transition).
- **Config-driven plan templates.** Custom templates under `plan_templates:` in `.seeds/config.yaml` override the built-ins. Built-in templates: `feature` (default for `task`/`feature`/`epic`; sections: `context`, `approach`, `alternatives`, `steps`, `risks`, `acceptance`), `bug` (default for `bug`; adds `reproduction`, `root_cause`), `refactor` (opt-in via `--template refactor`; adds `behavior_invariant`).
- **Plan lifecycle auto-transitions.** `draft` → `approved` → `active` → `done` driven by child seed status changes (hooked from `update.ts` and `close.ts` under outer plans-lock + inner issues-lock); `done` → `active` reopen path supported. `Plan.revision` increments on `--overwrite`.
- **Nested sub-plans.** A template step can declare `plan_template: <name>` to spawn a child seed that requires its own sub-plan. The child gets `requires_plan: true` and is hidden from `sd ready` until its plan reaches `approved+`. `sd plan prompt` on the spawned child inherits the parent step's `plan_template` unless `--template` overrides. Submit-time validation rejects unknown `plan_template` names.
- `Plan` type and plan storage layer (`readPlans`/`writePlans`/`appendPlan`/`plansPath`) mirroring the issue/template helpers and lock model. `.seeds/plans.jsonl` is created on `sd init` and added to `.gitattributes` with `merge=union`.
- `Issue.plan_id`, `Issue.plan_step_index`, `Issue.requires_plan` (additive optional fields; existing rows remain valid).
- Plan-awareness in `sd ready`, `sd show`, and `sd list`: ready surfaces seeds whose plan is in `draft` even if otherwise blocked, and excludes seeds with `requires_plan` until their sub-plan is approved+; show inlines child seeds for approved/active/done plans; list adds a `[plan <status>]` indicator. `--json` parity (`plan_status`, `plan_children`).
- `src/validation.ts` AJV-based validation foundation (sole AJV-importing module): `compileSchema` returns a `ValidatorFn`; `formatErrors` maps AJV `ErrorObject` to the documented `PartialStateDiff` shape.
- Extended in-tree YAML parser (`src/yaml.ts`) supporting nested maps, block sequences, inline flow maps/seqs, and typed scalars — keeps the minimal-runtime-deps posture (no new YAML dep).
- `sd onboard` snippet refresh — added `sd search`, the global `--format` flag, and the full `sd plan` surface (templates, prompt, submit, show, validate, list, outcome, review). Snippet version bumped to `v:3` so existing CLAUDE.md installs auto-update via the marker.
- `sd prime` includes plan-aware quick reference.

### Fixed
- `sd list` / `sd ready` / `sd blocked` / `sd show` (compact) / `sd search` / `sd dep` / `sd tpl` no longer render `[blocked]` when all of an issue's blockers are closed. Formatters now accept an optional `closedBlockerIds` set; callers compute it once from the unfiltered issue list and thread it through.

## [0.3.0] - 2026-05-04

### Added
- `sd search <query>` command — case-insensitive substring search on issue title + description, with the same filters as `sd list` (`--status`, `--type`, `--assignee`, `--label`, `--label-any`, `--unlabeled`, `--priority`, `--priority-max`) and shared `--limit`/`--sort`/`--format`/`--json` output flags. Includes closed issues by default; pass `--status open` to restrict.
- `--sort <mode>` flag on `sd list` and `sd ready` (`priority|created|updated|id`)
- `--format <mode>` flag on `sd list`, `sd ready`, `sd show`, `sd blocked`, and `sd stats` (`markdown|compact|plain|ids|json`). `--json` is preserved as an alias for `--format json`. The `ids` mode emits issue IDs one per line for shell pipelines: `sd list --label bug --format ids | xargs sd close`.
- `sd ready` now accepts the same filters as `sd list`: `--type`, `--assignee`, `--label`, `--label-any`, `--unlabeled`, `--limit`. Shared filter logic lives in `src/filter.ts`.
- `--priority <levels>` and `--priority-max <n>` filters on `sd list` and `sd ready`. `--priority` matches an exact comma-separated set (e.g. `--priority 0,1` or `--priority P0,P1`); `--priority-max` keeps issues at or below a ceiling (e.g. `--priority-max 1` = P0+P1). Both accept numeric (0-4) and P-prefixed (P0-P4) forms consistent with `sd create` / `sd update`.
- `--body` as alias for `--description` on `sd create` and `sd update`

### Changed
- `sd list` and `sd ready` now sort by priority ascending (P0 first) by default, tie-broken by `createdAt` desc, instead of JSONL file order
- Tightened lint and typecheck strictness (Biome `noNonNullAssertion=error`)

### Fixed
- `isInsideWorktree` submodule false positive — now compares resolved git-dir vs git-common-dir instead of path heuristics
- `process.exit()` replaced with `process.exitCode` in version-json handler

## [0.2.5] - 2026-03-04

### Added
- `sd block <id> --by <blocker-id>` command — mark an issue as blocked by another
- `sd unblock <id> --from <blocker-id>` command — remove a specific blocker (`--all` to clear all)
- `sd label` subcommand group — `add`, `remove`, `list`, `list-all` for issue labels
- Labels field on issues — optional `string[]` for categorization and filtering
- `sd list --label <label>` filter — list issues by label
- `--all` flag on `sd list` — show all issues including closed (default now filters to open/in_progress)

### Changed
- `sd list` now defaults to showing only open and in_progress issues (use `--all` for previous behavior)

## [0.2.4] - 2026-02-25

### Added
- `sd completions <shell>` command — output shell completion scripts for bash, zsh, and fish
- `--timing` global flag — show command execution time on stderr
- Typo suggestion tests for misspelled command names
- Tests for `--timing` flag and shell completions

### Fixed
- `sd init` now derives project name from directory name instead of hardcoding "seeds"

## [0.2.3] - 2026-02-24

### Added
- Worktree root resolution — `findSeedsDir()` resolves to the main repo's `.seeds/` when running inside a git worktree
- `isInsideWorktree()` helper in `config.ts` for worktree detection
- Worktree guard in `sd sync` — skips commit with warning when running from a worktree (supports `--json`)
- Tests for worktree resolution (`config.test.ts`) and sync worktree guard (`sync.test.ts`)
- Custom branded help formatting for `sd --help` — colored commands, aligned options, branded header

### Changed
- Lock retry interval increased from 50ms to 100ms with random jitter to reduce contention
- Lock timeout increased from 5s to 30s for better multi-agent reliability

## [0.2.2] - 2026-02-24

### Added
- `sd upgrade` command — check for and install latest version from npm (`--check` for version check only)
- `--quiet` / `-q` global flag — suppress non-error output
- `--verbose` global flag — extra diagnostic output
- `--dry-run` flag on `sd sync` — preview what would be committed without committing
- `printWarning()` helper in `output.ts`

### Changed
- Applied os-eco forest branding palette: `brand` (green), `accent` (amber), `muted` (gray) replace raw chalk colors across all commands
- Status icons updated to ASCII-safe set: `✓` (pass), `!` (warn), `✗` (fail), `>` (in-progress), `-` (open), `x` (closed)
- Version flag changed from `-V` to `-v` (standard convention)
- `--version --json` now returns structured `{name, version, runtime, platform}` object
- npm publish workflow: switched from `--provenance` to token-based auth via `NPM_TOKEN` secret

## [0.2.1] - 2026-02-24

### Changed
- Migrated CLI parsing from manual switch/case to Commander.js — proper subcommands, built-in help, and option validation
- Replaced manual ANSI escape codes with chalk for output formatting
- Use `process.exitCode = 1` instead of `process.exit(1)` for graceful shutdown
- Replaced auto-tag workflow with unified publish workflow for npm

### Fixed
- `--desc` flag silently dropped descriptions in `create` and `update` commands

### Added
- chalk and commander as runtime dependencies
- `--desc` as explicit alias for `--description` in `create` and `update`

### Removed
- `.beads/` directory — seeds is now the sole issue tracker
- Manual ANSI color helpers (`c.red`, `c.green`, etc.) in `output.ts`

## [0.2.0] - 2026-02-23

### Added
- `sd doctor` command — validates project health: config, JSONL integrity, field validation, dependency consistency, stale locks, gitattributes, and `.gitignore`. Supports `--fix` for auto-fixable issues
- `sd prime` command — outputs AI agent context (PRIME.md or built-in reference). Supports `--compact` for condensed output
- `sd onboard` command — adds seeds section to CLAUDE.md/AGENTS.md with marker-delimited sections for idempotent updates
- `src/markers.ts` utility for marker-delimited section management (used by `onboard`)
- CODEOWNERS file for branch protection

## [0.1.0] - 2026-02-23

### Added
- Initial release
- Issue CRUD: `sd create`, `sd show`, `sd list`, `sd update`, `sd close`
- Dependency tracking: `sd dep add/remove/list`, `sd blocked`, `sd ready`
- Templates/molecules: `sd tpl create/step/list/show/pour/status`
- Advisory file locking for concurrent multi-agent access
- Atomic writes (temp file + rename) with dedup-on-read
- YAML config (`config.yaml`), JSONL storage (`issues.jsonl`, `templates.jsonl`)
- `--json` flag on all commands for structured output
- Migration from beads: `sd migrate-from-beads`
- `sd sync` to stage and commit `.seeds/` changes
- `sd stats` for project statistics
- Zero runtime dependencies — Bun built-ins only
- `merge=union` gitattribute for git-native parallel branch merges

[Unreleased]: https://github.com/jayminwest/seeds/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/jayminwest/seeds/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/jayminwest/seeds/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jayminwest/seeds/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jayminwest/seeds/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jayminwest/seeds/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/jayminwest/seeds/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jayminwest/seeds/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jayminwest/seeds/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jayminwest/seeds/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jayminwest/seeds/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jayminwest/seeds/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jayminwest/seeds/releases/tag/v0.1.0
