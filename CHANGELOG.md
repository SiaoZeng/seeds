# Changelog

All notable changes to Seeds will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jayminwest/seeds/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/jayminwest/seeds/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jayminwest/seeds/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jayminwest/seeds/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jayminwest/seeds/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jayminwest/seeds/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jayminwest/seeds/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jayminwest/seeds/releases/tag/v0.1.0
