// Slash commands registered when `pi.commands` is enabled (seeds-5103).
//
// Surface:
//   /sd                  — short help listing the seeds slash commands
//   /sd:ready            — re-fetch `sd ready --json` and inject as a hidden
//                          steer message (display: false)
//   /sd:create "<title>" — `sd create --title "<title>"` (additional `--key
//                          value` pairs forwarded as CLI flags)
//   /sd:show <id>        — `sd show <id> --json` injected as a steer message
//   /sd:close <id>       — `sd close <id>` (optional trailing reason); clears
//                          currentIssueId when <id> matches
//   /sd:claim <id>       — `sd update <id> --status in_progress` + pin the
//                          `working: <id>` widget prefix
//
// currentIssueId state is persisted via pi.appendEntry("seeds-current-issue",
// { id }). On session_start the extension walks sessionManager.getEntries(),
// scans for the latest entry of that customType, and rehydrates the prefix —
// so `/reload` preserves the `working: <id>` indicator.
//
// All commands shell out to `sd <cmd> --json` via pi.exec; the tool surface
// (lib/tools.ts) does the same. Both flows respect the CLI's JSON contract so
// downstream parsing stays consistent.

import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export type SendMessageFn = (
	message: { customType: string; content: string; display: boolean; details?: unknown },
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type AppendEntryFn = (customType: string, data?: unknown) => void;

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export type SetWorkingFn = (id: string | undefined) => void;

export const SD_READY_CUSTOM_TYPE = "seeds-ready-command";
export const SD_SHOW_CUSTOM_TYPE = "seeds-show-command";
export const SD_CREATE_CUSTOM_TYPE = "seeds-create-command";
export const SD_CLOSE_CUSTOM_TYPE = "seeds-close-command";
export const SD_CLAIM_CUSTOM_TYPE = "seeds-claim-command";
export const CURRENT_ISSUE_CUSTOM_TYPE = "seeds-current-issue";

export const SD_COMMAND_BANNER_START = "<!-- seeds:command:start -->";
export const SD_COMMAND_BANNER_END = "<!-- seeds:command:end -->";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export interface CommandDeps {
	exec: ExecFn;
	cwd: string;
	sendMessage: SendMessageFn;
	appendEntry: AppendEntryFn;
	setWorking: SetWorkingFn;
	notify?: NotifyFn;
	getCurrentIssueId?: () => string | undefined;
	timeoutMs?: number;
}

export interface CommandResult {
	ok: boolean;
	exitCode: number;
	error?: string;
}

// Walk session entries to recover the most recent persisted issue id. Defensive
// against the loosely-typed entries surface — mirrors collectPersistedScopeLoadPaths
// in mulch's scope-load module.
export function collectPersistedCurrentIssueId(entries: readonly unknown[]): string | undefined {
	let latest: string | undefined;
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "custom") continue;
		if (e.customType !== CURRENT_ISSUE_CUSTOM_TYPE) continue;
		const data = e.data;
		if (data === null || typeof data !== "object") {
			// A null/missing payload clears the prefix — earlier entries are
			// superseded.
			latest = undefined;
			continue;
		}
		const id = (data as Record<string, unknown>).id;
		latest = typeof id === "string" && id.length > 0 ? id : undefined;
	}
	return latest;
}

function composeCommandBlock(label: string, body: string): string {
	return [SD_COMMAND_BANNER_START, `${label}:`, "", body, SD_COMMAND_BANNER_END].join("\n");
}

async function execSd(deps: CommandDeps, args: string[]): Promise<ExecResult | { error: string }> {
	try {
		return await deps.exec("sd", args, {
			cwd: deps.cwd,
			timeout: deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: msg };
	}
}

// Parse a "key=value" or "--key value" sequence into an args list to forward to
// `sd <cmd>`. We accept only string values; commas and equals signs stay intact.
// Quoted strings are preserved as a single token. Anything not in --key/key=value
// form goes through as positional args (used by /sd:show and /sd:close).
export interface ParsedArgs {
	positional: string[];
	flags: Array<[string, string]>;
	error?: string;
}

export function tokenize(raw: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			if (ch === "\\" && i + 1 < raw.length) {
				buf += raw[i + 1];
				i++;
				continue;
			}
			buf += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (buf.length > 0) {
				out.push(buf);
				buf = "";
			}
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

export function parseArgs(raw: string): ParsedArgs {
	const positional: string[] = [];
	const flags: Array<[string, string]> = [];
	const tokens = tokenize(raw);
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === undefined) continue;
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			if (eq >= 0) {
				flags.push([tok.slice(2, eq), tok.slice(eq + 1)]);
				continue;
			}
			const next = tokens[i + 1];
			if (next === undefined || next.startsWith("--")) {
				flags.push([tok.slice(2), ""]);
				continue;
			}
			flags.push([tok.slice(2), next]);
			i++;
			continue;
		}
		positional.push(tok);
	}
	return { positional, flags };
}

function flagsToArgs(flags: Array<[string, string]>): string[] {
	const out: string[] = [];
	for (const [key, value] of flags) {
		out.push(`--${key}`);
		if (value.length > 0) out.push(value);
	}
	return out;
}

function describeError(result: ExecResult): string {
	const trimmed = result.stderr.trim() || result.stdout.trim();
	return trimmed.length > 0 ? trimmed : `exit ${result.code}`;
}

export async function runReady(deps: CommandDeps, raw: string): Promise<CommandResult> {
	const parsed = parseArgs(raw);
	const args = ["ready", ...flagsToArgs(parsed.flags), "--json"];
	const result = await execSd(deps, args);
	if ("error" in result) {
		deps.notify?.(`/sd:ready: exec failed — ${result.error}`, "error");
		return { ok: false, exitCode: -1, error: result.error };
	}
	if (result.code !== 0) {
		const tail = describeError(result);
		deps.notify?.(`/sd:ready failed: ${tail}`, "error");
		return { ok: false, exitCode: result.code, error: tail };
	}
	const stdout = result.stdout.trim();
	if (stdout.length === 0) {
		deps.notify?.("/sd:ready: empty response", "info");
		return { ok: true, exitCode: 0 };
	}
	deps.sendMessage(
		{
			customType: SD_READY_CUSTOM_TYPE,
			content: composeCommandBlock("/sd:ready", stdout),
			display: false,
			details: { command: "ready" },
		},
		{ deliverAs: "steer" },
	);
	deps.notify?.("/sd:ready: injected", "info");
	return { ok: true, exitCode: 0 };
}

export async function runShow(deps: CommandDeps, raw: string): Promise<CommandResult> {
	const parsed = parseArgs(raw);
	if (parsed.positional.length === 0) {
		const err = "Usage: /sd:show <id> [<id>...]";
		deps.notify?.(err, "warning");
		return { ok: false, exitCode: -1, error: err };
	}
	const args = ["show", ...parsed.positional, ...flagsToArgs(parsed.flags), "--json"];
	const result = await execSd(deps, args);
	if ("error" in result) {
		deps.notify?.(`/sd:show: exec failed — ${result.error}`, "error");
		return { ok: false, exitCode: -1, error: result.error };
	}
	if (result.code !== 0) {
		const tail = describeError(result);
		deps.notify?.(`/sd:show failed: ${tail}`, "error");
		return { ok: false, exitCode: result.code, error: tail };
	}
	const stdout = result.stdout.trim();
	deps.sendMessage(
		{
			customType: SD_SHOW_CUSTOM_TYPE,
			content: composeCommandBlock(`/sd:show ${parsed.positional.join(" ")}`, stdout),
			display: false,
			details: { command: "show", ids: parsed.positional },
		},
		{ deliverAs: "steer" },
	);
	deps.notify?.(`/sd:show ${parsed.positional.join(" ")}: injected`, "info");
	return { ok: true, exitCode: 0 };
}

export async function runCreate(deps: CommandDeps, raw: string): Promise<CommandResult> {
	const parsed = parseArgs(raw);
	// Default convenience: the first positional becomes --title when no --title
	// flag was passed. Lets the user type `/sd:create Fix the foo` instead of
	// requiring `--title "Fix the foo"`. Quoted strings already collapse into a
	// single positional via tokenize.
	const hasTitle = parsed.flags.some(([k]) => k === "title");
	if (!hasTitle && parsed.positional.length > 0) {
		const title = parsed.positional.join(" ");
		parsed.flags.unshift(["title", title]);
		parsed.positional.length = 0;
	}
	const titleFlag = parsed.flags.find(([k]) => k === "title");
	if (!titleFlag || titleFlag[1].length === 0) {
		const err =
			"Usage: /sd:create <title>  (or --title <text>, plus optional --type/--priority/...)";
		deps.notify?.(err, "warning");
		return { ok: false, exitCode: -1, error: err };
	}
	const args = ["create", ...flagsToArgs(parsed.flags), "--json"];
	const result = await execSd(deps, args);
	if ("error" in result) {
		deps.notify?.(`/sd:create: exec failed — ${result.error}`, "error");
		return { ok: false, exitCode: -1, error: result.error };
	}
	if (result.code !== 0) {
		const tail = describeError(result);
		deps.notify?.(`/sd:create failed: ${tail}`, "error");
		return { ok: false, exitCode: result.code, error: tail };
	}
	const stdout = result.stdout.trim();
	deps.sendMessage(
		{
			customType: SD_CREATE_CUSTOM_TYPE,
			content: composeCommandBlock(`/sd:create ${titleFlag[1]}`, stdout),
			display: false,
			details: { command: "create" },
		},
		{ deliverAs: "steer" },
	);
	deps.notify?.(`/sd:create: ${titleFlag[1]}`, "info");
	return { ok: true, exitCode: 0 };
}

export async function runClose(deps: CommandDeps, raw: string): Promise<CommandResult> {
	const parsed = parseArgs(raw);
	if (parsed.positional.length === 0) {
		const err = "Usage: /sd:close <id> [reason words...]";
		deps.notify?.(err, "warning");
		return { ok: false, exitCode: -1, error: err };
	}
	const [id, ...rest] = parsed.positional;
	if (!id) {
		const err = "Usage: /sd:close <id> [reason words...]";
		deps.notify?.(err, "warning");
		return { ok: false, exitCode: -1, error: err };
	}
	const hasReason = parsed.flags.some(([k]) => k === "reason");
	if (!hasReason && rest.length > 0) {
		parsed.flags.push(["reason", rest.join(" ")]);
	}
	const args = ["close", id, ...flagsToArgs(parsed.flags), "--json"];
	const result = await execSd(deps, args);
	if ("error" in result) {
		deps.notify?.(`/sd:close: exec failed — ${result.error}`, "error");
		return { ok: false, exitCode: -1, error: result.error };
	}
	if (result.code !== 0) {
		const tail = describeError(result);
		deps.notify?.(`/sd:close ${id} failed: ${tail}`, "error");
		return { ok: false, exitCode: result.code, error: tail };
	}
	// Clear `working: <id>` if we just closed the active issue.
	if (deps.getCurrentIssueId?.() === id) {
		deps.appendEntry(CURRENT_ISSUE_CUSTOM_TYPE, null);
		deps.setWorking(undefined);
	}
	const stdout = result.stdout.trim();
	deps.sendMessage(
		{
			customType: SD_CLOSE_CUSTOM_TYPE,
			content: composeCommandBlock(`/sd:close ${id}`, stdout),
			display: false,
			details: { command: "close", id },
		},
		{ deliverAs: "steer" },
	);
	deps.notify?.(`/sd:close ${id}`, "info");
	return { ok: true, exitCode: 0 };
}

export async function runClaim(deps: CommandDeps, raw: string): Promise<CommandResult> {
	const parsed = parseArgs(raw);
	const id = parsed.positional[0];
	if (!id) {
		const err = "Usage: /sd:claim <id>";
		deps.notify?.(err, "warning");
		return { ok: false, exitCode: -1, error: err };
	}
	const args = ["update", id, "--status", "in_progress", "--json"];
	const result = await execSd(deps, args);
	if ("error" in result) {
		deps.notify?.(`/sd:claim: exec failed — ${result.error}`, "error");
		return { ok: false, exitCode: -1, error: result.error };
	}
	if (result.code !== 0) {
		const tail = describeError(result);
		deps.notify?.(`/sd:claim ${id} failed: ${tail}`, "error");
		return { ok: false, exitCode: result.code, error: tail };
	}
	deps.appendEntry(CURRENT_ISSUE_CUSTOM_TYPE, { id });
	deps.setWorking(id);
	deps.notify?.(`/sd:claim: working on ${id}`, "info");
	return { ok: true, exitCode: 0 };
}

const HELP_TEXT = [
	"Seeds slash commands:",
	"  /sd                 — this help",
	"  /sd:ready           — list unblocked work (injected as steer)",
	"  /sd:create <title>  — create a new issue (forwards --flag value pairs)",
	"  /sd:show <id>       — show issue details (one or more ids)",
	"  /sd:close <id>      — close an issue (trailing words become the reason)",
	"  /sd:claim <id>      — set status=in_progress + pin `working: <id>` widget",
].join("\n");

export async function runHelp(deps: CommandDeps): Promise<CommandResult> {
	deps.sendMessage(
		{
			customType: SD_READY_CUSTOM_TYPE,
			content: composeCommandBlock("/sd", HELP_TEXT),
			display: false,
			details: { command: "help" },
		},
		{ deliverAs: "steer" },
	);
	deps.notify?.("/sd: help injected", "info");
	return { ok: true, exitCode: 0 };
}

export interface CommandRegistration {
	name: string;
	options: {
		description: string;
		handler: (args: string) => Promise<void>;
	};
}

function buildCommand(
	name: string,
	description: string,
	getDeps: () => CommandDeps | undefined,
	run: (deps: CommandDeps, raw: string) => Promise<CommandResult>,
): CommandRegistration {
	return {
		name,
		options: {
			description,
			async handler(args) {
				const deps = getDeps();
				if (!deps) return;
				await run(deps, args);
			},
		},
	};
}

export function buildCommandRegistrations(
	getDeps: () => CommandDeps | undefined,
): CommandRegistration[] {
	return [
		buildCommand("sd", "Seeds: show slash-command help.", getDeps, (deps) => runHelp(deps)),
		buildCommand(
			"sd:ready",
			"Seeds: re-fetch the ready list and inject as steer.",
			getDeps,
			runReady,
		),
		buildCommand(
			"sd:create",
			"Seeds: create a new issue (positional title or --title).",
			getDeps,
			runCreate,
		),
		buildCommand("sd:show", "Seeds: show issue details (one or more ids).", getDeps, runShow),
		buildCommand(
			"sd:close",
			"Seeds: close an issue (trailing words become --reason).",
			getDeps,
			runClose,
		),
		buildCommand(
			"sd:claim",
			"Seeds: set issue to in_progress and pin the working widget prefix.",
			getDeps,
			runClaim,
		),
	];
}
