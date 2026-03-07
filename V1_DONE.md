# Seeds — V1 Scope

## One-Liner
Git-native issue tracker for AI agent workflows — create, track, and close issues stored as diffable JSONL records with concurrent-safe locking.

## V1 Definition of Done

- [ ] Core issue lifecycle works: `create`, `show`, `list`, `update`, `close`
- [ ] Filtering works: `list` supports `--status`, `--type`, `--assignee`, `--label`, `--limit`, `--all`
- [ ] `ready` surfaces unblocked work (no open blockers)
- [ ] Blocking system works: `block`, `unblock`, `blocked`
- [ ] Dependency tracking works: `dep add`, `dep remove`, `dep list`
- [ ] Label management works: `label add`, `label remove`, `label list`, `label list-all`
- [ ] Template system works: `tpl create`, `tpl step add`, `tpl list`, `tpl show`, `tpl pour`, `tpl status`
- [ ] Project diagnostics work: `stats`, `doctor` (with `--fix`), `sync`
- [ ] Agent integration: `prime` outputs usable context, `onboard` installs to CLAUDE.md
- [ ] Concurrent safety: advisory file locking + atomic writes prevent corruption under multi-agent access
- [ ] Worktree detection resolves to main repo `.seeds/` correctly
- [ ] `--json` flag produces structured output on all commands (for programmatic consumption by overstory)
- [ ] All tests pass (`bun test`)
- [ ] TypeScript strict mode clean (`bun run typecheck`)
- [ ] Linting passes (`bun run lint`)
- [ ] CI pipeline runs lint + typecheck + test on push/PR
- [ ] Published to npm as `@os-eco/seeds-cli`

## Explicitly Out of Scope for V1

- GitHub Issues sync (bidirectional or one-way)
- Web UI or visual board
- Milestone / release tracking
- Time tracking or estimation fields
- Custom fields beyond the fixed schema
- Issue comments or discussion threads
- Notification system
- Search command (full-text search across issues)
- Archive vs. delete semantics
- Multi-repo issue aggregation
- Priority auto-assignment or triage intelligence

## Current State

Seeds is effectively V1-complete. All 32 CLI commands are implemented and tested. 235 tests pass. TypeScript strict mode and linting are clean (21 non-null assertion style warnings, all safe). CI is green. The `--json` output mode is used by overstory for programmatic integration. Published to npm at v0.2.5.

The only open issue (`seeds-5960` — labels support) appears to already be implemented and shipped; the issue just needs to be closed.

**Estimated completion: ~98%.** The tool does everything it needs to do for V1.

## Open Questions

- Should `seeds-5960` (labels support) be formally closed, or is there remaining work on it? A: verify that it can be closed
- Is the `migrate-from-beads` command still needed, or can it be removed/deprecated for V1? A: Yes, this is 100% still needed.
