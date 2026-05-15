// Custom LLM-callable tools for @os-eco/pi-seeds (step seeds-adb1).
// Each tool is a thin shim over `sd <cmd> --json`, executed via pi.exec so
// stdout stays clean and the CLI's JSON schema is the contract. Domain
// errors (e.g. issue not found) come back as { success: false, error } and
// are surfaced as structured tool content — only true exec failures throw.

import type {
	AgentToolResult,
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SD_BIN = "sd";

interface SdJsonOk {
	success: true;
	[k: string]: unknown;
}

interface SdJsonErr {
	success: false;
	error?: string;
	command?: string;
	[k: string]: unknown;
}

type SdJsonResponse = SdJsonOk | SdJsonErr;

export interface SdRunResult {
	ok: boolean;
	parsed: SdJsonResponse | undefined;
	stdout: string;
	stderr: string;
	code: number;
}

export type SdExec = (args: string[], signal: AbortSignal | undefined) => Promise<ExecResult>;

export type SdExecFactory = (ctx: ExtensionContext) => SdExec;

export async function runSd(
	exec: SdExec,
	args: string[],
	signal?: AbortSignal,
): Promise<SdRunResult> {
	const argv = args.includes("--json") ? args : [...args, "--json"];
	const result = await exec(argv, signal);
	let parsed: SdJsonResponse | undefined;
	const trimmed = result.stdout.trim();
	if (trimmed.length > 0) {
		try {
			parsed = JSON.parse(trimmed) as SdJsonResponse;
		} catch {
			parsed = undefined;
		}
	}
	const ok = result.code === 0 && parsed !== undefined && parsed.success !== false;
	return { ok, parsed, stdout: result.stdout, stderr: result.stderr, code: result.code };
}

export interface ToolDetails {
	command: string;
	exitCode: number;
	stderr?: string;
	parsed?: SdJsonResponse;
}

export function buildSuccessResult(
	command: string,
	run: SdRunResult,
): AgentToolResult<ToolDetails> {
	const text = run.parsed ? JSON.stringify(run.parsed) : run.stdout.trim();
	return {
		content: [{ type: "text", text }],
		details: {
			command,
			exitCode: run.code,
			parsed: run.parsed,
		},
	};
}

export function buildErrorResult(command: string, run: SdRunResult): AgentToolResult<ToolDetails> {
	const parsedError =
		run.parsed && "error" in run.parsed && typeof run.parsed.error === "string"
			? run.parsed.error
			: undefined;
	const message = parsedError ?? run.stderr.trim() ?? `sd ${command} exited with code ${run.code}`;
	const body = {
		success: false as const,
		command,
		error: message,
		exitCode: run.code,
		stderr: run.stderr.trim() || undefined,
	};
	return {
		content: [{ type: "text", text: JSON.stringify(body) }],
		details: { command, exitCode: run.code, stderr: run.stderr, parsed: run.parsed },
	};
}

export async function execute(
	exec: SdExec,
	command: string,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<ToolDetails>> {
	const run = await runSd(exec, args, signal);
	return run.ok ? buildSuccessResult(command, run) : buildErrorResult(command, run);
}

function makeExecFactory(pi: ExtensionAPI): SdExecFactory {
	return (ctx) => (args, signal) => pi.exec(SD_BIN, args, { cwd: ctx.cwd, signal });
}

// Lossy: we accept Type.String() everywhere the CLI accepts free text, and
// validate/coerce on the CLI side. TypeBox is for shape, not domain semantics.
const optStr = (description: string) => Type.Optional(Type.String({ description }));

const createSchema = Type.Object({
	title: Type.String({ description: "Issue title (required)" }),
	type: Type.Optional(
		Type.String({ description: "Issue type: task | bug | feature | epic (default: task)" }),
	),
	priority: Type.Optional(
		Type.String({ description: "Priority 0-4 or P0-P4 (default: 2 / Medium)" }),
	),
	description: optStr("Issue description / body"),
	assignee: optStr("Assignee name"),
	labels: optStr("Comma-separated labels (e.g. 'frontend,bug')"),
});

const readySchema = Type.Object({
	type: optStr("Filter by issue type"),
	assignee: optStr("Filter by assignee"),
	label: optStr("Require all of these labels (comma-separated, AND)"),
	label_any: optStr("Require any of these labels (comma-separated, OR)"),
	unlabeled: Type.Optional(Type.Boolean({ description: "Only issues with no labels" })),
	priority: optStr("Exact priority levels (comma-separated, e.g. '0,1' or 'P0,P1')"),
	priority_max: optStr("Max priority (e.g. '1' = P0+P1)"),
	limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
	sort: optStr("Sort order: priority | created | updated | id"),
	respect_schedule: Type.Optional(
		Type.Boolean({
			description: "Exclude issues with extensions.queued=true or future scheduledFor",
		}),
	),
});

const showSchema = Type.Object({
	id: Type.String({ description: "Issue id (e.g. 'seeds-adb1') or plan id (e.g. 'pl-a1d4')" }),
});

const updateSchema = Type.Object({
	id: Type.String({ description: "Issue id" }),
	status: optStr("New status: open | in_progress | closed"),
	title: optStr("New title"),
	type: optStr("New type"),
	priority: optStr("New priority 0-4 or P0-P4"),
	assignee: optStr("New assignee"),
	description: optStr("New description"),
	add_label: optStr("Add label(s) (comma-separated)"),
	remove_label: optStr("Remove label(s) (comma-separated)"),
	set_labels: optStr("Set labels (comma-separated; empty string clears)"),
});

const closeSchema = Type.Object({
	id: Type.String({ description: "Issue id to close" }),
	reason: optStr("Close reason (free text)"),
});

const depSchema = Type.Object({
	action: Type.String({ description: "Subcommand: 'add' | 'remove' | 'list'" }),
	issue: Type.String({ description: "Issue id" }),
	depends_on: optStr("Dependency target id (required for add/remove)"),
});

const searchSchema = Type.Object({
	query: Type.String({ description: "Substring search across title + description" }),
	status: optStr("Filter by status"),
	type: optStr("Filter by type"),
	assignee: optStr("Filter by assignee"),
	label: optStr("Require all labels (comma-separated)"),
	label_any: optStr("Require any label (comma-separated)"),
	unlabeled: Type.Optional(Type.Boolean({ description: "Only unlabeled issues" })),
	priority: optStr("Exact priority levels"),
	priority_max: optStr("Max priority"),
	limit: Type.Optional(Type.Number({ description: "Max results" })),
	sort: optStr("Sort order"),
});

function pushIfString(args: string[], flag: string, value: unknown): void {
	if (typeof value === "string" && value.length > 0) {
		args.push(flag, value);
	}
}

function pushIfNumber(args: string[], flag: string, value: unknown): void {
	if (typeof value === "number" && Number.isFinite(value)) {
		args.push(flag, String(value));
	}
}

function pushIfTrue(args: string[], flag: string, value: unknown): void {
	if (value === true) args.push(flag);
}

export function buildCreateTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof createSchema, ToolDetails> {
	return {
		name: "sd_create",
		label: "sd create",
		description: "Create a new seeds issue. Returns { success, command: 'create', id } on success.",
		promptSnippet: "Create a seeds issue",
		parameters: createSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["create", "--title", params.title];
			pushIfString(args, "--type", params.type);
			pushIfString(args, "--priority", params.priority);
			pushIfString(args, "--description", params.description);
			pushIfString(args, "--assignee", params.assignee);
			pushIfString(args, "--labels", params.labels);
			return execute(getExec(ctx), "create", args, signal);
		},
	};
}

export function buildReadyTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof readySchema, ToolDetails> {
	return {
		name: "sd_ready",
		label: "sd ready",
		description:
			"List open issues with no unresolved blockers. Returns { success, issues, count }.",
		promptSnippet: "List unblocked seeds issues",
		parameters: readySchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["ready"];
			pushIfString(args, "--type", params.type);
			pushIfString(args, "--assignee", params.assignee);
			pushIfString(args, "--label", params.label);
			pushIfString(args, "--label-any", params.label_any);
			pushIfTrue(args, "--unlabeled", params.unlabeled);
			pushIfString(args, "--priority", params.priority);
			pushIfString(args, "--priority-max", params.priority_max);
			pushIfNumber(args, "--limit", params.limit);
			pushIfString(args, "--sort", params.sort);
			pushIfTrue(args, "--respect-schedule", params.respect_schedule);
			return execute(getExec(ctx), "ready", args, signal);
		},
	};
}

export function buildShowTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof showSchema, ToolDetails> {
	return {
		name: "sd_show",
		label: "sd show",
		description:
			"Show full details for a seeds issue (or plan id). Returns the issue object plus dependency status.",
		promptSnippet: "Show a seeds issue",
		parameters: showSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return execute(getExec(ctx), "show", ["show", params.id], signal);
		},
	};
}

export function buildUpdateTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof updateSchema, ToolDetails> {
	return {
		name: "sd_update",
		label: "sd update",
		description:
			"Update fields on a seeds issue (status, priority, title, labels, etc.). Use status='in_progress' to claim work.",
		promptSnippet: "Update a seeds issue",
		parameters: updateSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["update", params.id];
			pushIfString(args, "--status", params.status);
			pushIfString(args, "--title", params.title);
			pushIfString(args, "--type", params.type);
			pushIfString(args, "--priority", params.priority);
			pushIfString(args, "--assignee", params.assignee);
			pushIfString(args, "--description", params.description);
			pushIfString(args, "--add-label", params.add_label);
			pushIfString(args, "--remove-label", params.remove_label);
			if (typeof params.set_labels === "string") {
				args.push("--set-labels", params.set_labels);
			}
			return execute(getExec(ctx), "update", args, signal);
		},
	};
}

export function buildCloseTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof closeSchema, ToolDetails> {
	return {
		name: "sd_close",
		label: "sd close",
		description: "Close a seeds issue. Optionally records a close reason.",
		promptSnippet: "Close a seeds issue",
		parameters: closeSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["close", params.id];
			pushIfString(args, "--reason", params.reason);
			return execute(getExec(ctx), "close", args, signal);
		},
	};
}

export function buildDepTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof depSchema, ToolDetails> {
	return {
		name: "sd_dep",
		label: "sd dep",
		description:
			"Manage dependencies between issues. action='add'|'remove' need depends_on; action='list' shows the issue's deps.",
		promptSnippet: "Manage seeds dependencies",
		parameters: depSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const action = params.action;
			if (action !== "add" && action !== "remove" && action !== "list") {
				return buildErrorResult("dep", {
					ok: false,
					parsed: { success: false, error: `Unknown dep action: ${action}` },
					stdout: "",
					stderr: "",
					code: 1,
				});
			}
			const args = ["dep", action, params.issue];
			if (action !== "list") {
				if (!params.depends_on) {
					return buildErrorResult("dep", {
						ok: false,
						parsed: {
							success: false,
							error: `dep ${action} requires depends_on`,
						},
						stdout: "",
						stderr: "",
						code: 1,
					});
				}
				args.push(params.depends_on);
			}
			return execute(getExec(ctx), `dep ${action}`, args, signal);
		},
	};
}

export function buildSearchTool(
	getExec: SdExecFactory,
): ToolDefinition<typeof searchSchema, ToolDetails> {
	return {
		name: "sd_search",
		label: "sd search",
		description: "Substring search across issue titles and descriptions. Returns matching issues.",
		promptSnippet: "Search seeds issues",
		parameters: searchSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["search", params.query];
			pushIfString(args, "--status", params.status);
			pushIfString(args, "--type", params.type);
			pushIfString(args, "--assignee", params.assignee);
			pushIfString(args, "--label", params.label);
			pushIfString(args, "--label-any", params.label_any);
			pushIfTrue(args, "--unlabeled", params.unlabeled);
			pushIfString(args, "--priority", params.priority);
			pushIfString(args, "--priority-max", params.priority_max);
			pushIfNumber(args, "--limit", params.limit);
			pushIfString(args, "--sort", params.sort);
			return execute(getExec(ctx), "search", args, signal);
		},
	};
}

export function registerSeedsTools(pi: ExtensionAPI): void {
	const getExec = makeExecFactory(pi);
	pi.registerTool(buildCreateTool(getExec));
	pi.registerTool(buildReadyTool(getExec));
	pi.registerTool(buildShowTool(getExec));
	pi.registerTool(buildUpdateTool(getExec));
	pi.registerTool(buildCloseTool(getExec));
	pi.registerTool(buildDepTool(getExec));
	pi.registerTool(buildSearchTool(getExec));
}
