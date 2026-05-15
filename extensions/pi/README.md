# @os-eco/pi-seeds

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension
that hard-wires the seeds session rituals — `sd prime`, `sd ready`, `sd close` —
into pi lifecycle events. Ships in-tree with [`@os-eco/seeds-cli`](../../README.md)
so the CLI and the extension always agree on JSON shapes.

What you get without prompting the LLM:

- **Auto-prime on session_start** — selected `sd prime --json` sections are
  injected into the system prompt via `before_agent_start`.
- **Status widget** — `sd: <n> ready / <n> in-progress / <n> blocked`, refreshed
  on `agent_end` when `.seeds/issues.jsonl` mtime changes (catches local writes,
  hand-edits, and merges from sibling worktrees).
- **Custom tools** — `sd_create`, `sd_ready`, `sd_show`, `sd_update`,
  `sd_close`, `sd_dep`, `sd_search`. Thin shims over `sd <cmd> --json` so the
  LLM stops re-parsing human output.
- **Autocomplete** — typing `#sd-` in pi's input opens a completion list of
  cached ready ids; selecting one inserts the full `#sd-<id>` token.
- **Reference expansion** — sending a message containing `#sd-<id>` inlines
  `sd show <id> --json` as a hidden `<seeds-context>` block (capped per
  message; configurable).
- **Slash commands** — `/sd`, `/sd:ready`, `/sd:create`, `/sd:show`, `/sd:close`,
  `/sd:claim`. `/sd:claim <id>` pins `working: <id>` onto the status widget,
  and the prefix survives `/reload`.

## Install

```bash
sd setup pi
```

The recipe is idempotent and reversible:

```bash
sd setup pi --check     # → "installed" | "outdated" | "not_installed"
sd setup pi --remove    # reverses both changes
```

What it does:

1. Adds `@os-eco/seeds-cli` to `.pi/settings.json` → `packages` so pi auto-loads
   the extension on every session — no global install needed.
2. Refreshes the seeds section of `CLAUDE.md` / `AGENTS.md` to the short
   pi-aware variant. The schema marker gets a `:pi` suffix that doubles as
   install-state detection.

The extension is a **no-op when pi is not the active runtime**, regardless of
config — the CLI stays a standalone tool.

## Configuration

All knobs live under the `pi:` namespace in `.seeds/config.yaml`. Defaults:

```yaml
pi:
  auto_prime: true
  status_widget: true
  prime:
    sections: [closeProtocol, rules]
  cache:
    invalidate_on_write: true
  reference_expansion:
    max_refs: 5
  commands: true
```

| Key                                  | Default                        | What it does                                                                                                            |
| ------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `auto_prime`                         | `true`                         | Inject the selected sections of `sd prime --json` into the system prompt at `before_agent_start`.                       |
| `status_widget`                      | `true`                         | Show `sd: <n> ready / <n> in-progress / <n> blocked` in pi's status line; refresh on `agent_end` when issues.jsonl changes. |
| `prime.sections`                     | `[closeProtocol, rules]`       | Ordered list of typed section names: `closeProtocol`, `rules`, `commandGroups`, `workflows`. Empty list disables injection without disabling `auto_prime`. |
| `cache.invalidate_on_write`          | `true`                         | Stat `.seeds/issues.jsonl` on `agent_end` and refresh the ready-list cache when mtime changed.                          |
| `reference_expansion.max_refs`       | `5`                            | Cap on unique `#sd-*` references expanded per user message; excess are dropped silently.                                |
| `commands`                           | `true`                         | Register the six `/sd*` slash commands.                                                                                 |

Edit via `sd config`:

```bash
sd config set pi.prime.sections '["rules"]'
sd config set pi.reference_expansion.max_refs 12
sd config show pi
sd config schema --json    # full JSON Schema; consumed by warren's UI
```

`sd config` validates the entire post-write file against the schema before
persisting — partial writes that would violate required fields are rejected.

## Custom tools

| Tool       | Notes                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `sd_create` | Forwards `--title`, `--type`, `--priority`, `--description`, `--assignee`, `--labels`.        |
| `sd_ready`  | Filter flags + `--respect-schedule`, `--unlabeled`, `--label`, `--label-any`, `--limit`.      |
| `sd_show`   | Returns the full issue JSON for a single id.                                                  |
| `sd_update` | Status, priority, assignee, description; label set/add/remove; opaque `--extensions <json>`.  |
| `sd_close`  | Returns structured `{success:false, error, exitCode, stderr}` on failure instead of throwing. |
| `sd_dep`    | `add` / `remove` / `list`. `add`/`remove` require `depends_on`.                               |
| `sd_search` | Substring search over title + description; supports all the filter flags from `sd_ready`.     |

All tools shell out via `pi.exec("sd", [...args, "--json"], { cwd: ctx.cwd })`
so `.seeds/` resolves correctly inside `git worktree`-linked checkouts.

## Slash commands

| Command          | Behavior                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/sd <args>`     | Run any `sd` subcommand inline; output is appended to chat.                                                       |
| `/sd:ready`      | Renders the current ready list in chat.                                                                           |
| `/sd:create <title>` | One-shot issue creation; positional title plus the usual flags.                                                |
| `/sd:show <id>`  | Inlines `sd show <id>` in chat (human format).                                                                    |
| `/sd:close <id>` | Closes the issue; if it was the `currentIssueId`, also clears the `working: …` prefix.                            |
| `/sd:claim <id>` | `sd update <id> --status in_progress`, then pins `working: <id>` onto the status widget. Persists across `/reload`. |

## Autocomplete & reference expansion

- Typing `#sd-` opens the autocomplete list of cached ready ids
  (priority-then-id sort, filtered by substring after the dash).
- The cache refreshes on `session_start` and on `agent_end` (only when
  `.seeds/issues.jsonl` mtime changed).
- Sending a message that contains `#sd-<id>` tokens prepends a hidden
  `<seeds-context>` block with the `sd show <id> --json` body for each unique
  reference, capped at `pi.reference_expansion.max_refs` (default 5). Duplicates
  are deduped before the cap applies.

## Troubleshooting

**The extension appears inactive.** It's inert in any project where
`.seeds/config.yaml` doesn't exist (run `sd init`) or where pi isn't the active
runtime. The pi CLI logs extension load failures — check `pi logs`.

**Status widget is stale after a `git pull` or `git merge`.** The cache is
invalidated on `agent_end`, so a fast-forward merge while pi is idle won't
trigger a refresh until the next user prompt. Send any message (or run
`/sd:ready`) to force the next `agent_end` to re-stat.

**Autocomplete shows nothing.** The cache is empty if `sd ready` returns no
items, or if the cache hasn't been populated yet (first hook fires on
`session_start`). `/sd:ready` exercises the same path and will surface the
underlying error.

**`#sd-<id>` expansion isn't happening.** Set
`pi.reference_expansion.max_refs` > 0; `0` disables expansion entirely.

**Peer-dep warnings on `npm install -g @os-eco/seeds-cli`.** The pi runtime
is an optional peer (`peerDependenciesMeta.optional: true`). If your npm
version warns anyway, upgrade to npm ≥ 7. The CLI itself works without pi.

**Editing `.seeds/config.yaml` doesn't take effect.** The config is read on
`session_start`, so `/reload` (or restarting pi) picks up edits. `sd config set`
is the supported write path — it validates the whole file against the schema
before saving.

## Development

```bash
bun test extensions/pi/lib    # unit tests for autocomplete, commands, config, prime, status, tools
bun run lint
bun run typecheck
```

The extension imports the CLI's typed section shape (`PrimeSectionsFull`) from
`src/commands/prime.ts` directly — the contract is in-process, not over a JSON
wire. Out-of-tree consumers that prefer subprocess + JSON should defensively
fall back to the legacy `content` field; this extension is the source of truth.
