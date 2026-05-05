import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { applyIssueFilters, filterOptionsFromFlags } from "../filter.ts";
import { resolveFormat, stripAnsi, VALID_FORMATS } from "../format.ts";
import {
	formatIssueOneLine,
	formatIssueOneLineCompact,
	outputJson,
	printIssueOneLine,
} from "../output.ts";
import { isSortMode, sortIssues, VALID_SORT_MODES } from "../sort.ts";
import { readIssues } from "../store.ts";
import type { Issue } from "../types.ts";

function parseArgs(args: string[]) {
	const flags: Record<string, string | boolean> = {};
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (!arg) {
			i++;
			continue;
		}
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const eqIdx = key.indexOf("=");
			if (eqIdx !== -1) {
				flags[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
				i++;
			} else {
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i += 2;
				} else {
					flags[key] = true;
					i++;
				}
			}
		} else {
			i++;
		}
	}
	return flags;
}

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const fmt = resolveFormat(args);
	const jsonMode = fmt.mode === "json";
	if (fmt.error) {
		if (jsonMode) {
			outputJson({ success: false, command: "list", error: fmt.error });
		} else {
			console.error(fmt.error);
		}
		process.exitCode = 1;
		return;
	}
	const flags = parseArgs(args);

	const statusFilter = typeof flags.status === "string" ? flags.status : undefined;
	const showAll = flags.all === true;
	const limitStr = typeof flags.limit === "string" ? flags.limit : "50";
	const limit = Number.parseInt(limitStr, 10) || 50;

	const dir = seedsDir ?? (await findSeedsDir());
	let issues = await readIssues(dir);

	if (statusFilter) {
		issues = issues.filter((i: Issue) => i.status === statusFilter);
	} else if (!showAll) {
		issues = issues.filter((i: Issue) => i.status !== "closed");
	}
	issues = applyIssueFilters(issues, filterOptionsFromFlags(flags));

	const sortFlag = typeof flags.sort === "string" ? flags.sort : "priority";
	if (!isSortMode(sortFlag)) {
		const msg = `Invalid --sort value: ${sortFlag}. Valid: ${VALID_SORT_MODES.join("|")}`;
		if (jsonMode) {
			outputJson({ success: false, command: "list", error: msg });
		} else {
			console.error(msg);
		}
		process.exitCode = 1;
		return;
	}
	issues = sortIssues(issues, sortFlag);

	issues = issues.slice(0, limit);

	switch (fmt.mode) {
		case "json":
			outputJson({ success: true, command: "list", issues, count: issues.length });
			return;
		case "ids":
			for (const issue of issues) console.log(issue.id);
			return;
		case "compact":
			for (const issue of issues) console.log(formatIssueOneLineCompact(issue));
			return;
		case "plain":
			if (issues.length === 0) {
				console.log("No issues found.");
				return;
			}
			for (const issue of issues) console.log(stripAnsi(formatIssueOneLine(issue)));
			console.log(`\n${issues.length} issue(s)`);
			return;
		default:
			if (issues.length === 0) {
				console.log("No issues found.");
				return;
			}
			for (const issue of issues) printIssueOneLine(issue);
			console.log(`\n${issues.length} issue(s)`);
			return;
	}
}

export function register(program: Command): void {
	program
		.command("list")
		.description("List issues with filters")
		.option("--status <status>", "Filter by status (open|in_progress|closed)")
		.option("--type <type>", "Filter by type (task|bug|feature|epic)")
		.option("--assignee <name>", "Filter by assignee")
		.option("--all", "Include closed issues (default: only open/in_progress)")
		.option("--label <labels>", "Filter: must have ALL labels (comma-separated, AND)")
		.option("--label-any <labels>", "Filter: must have any label (comma-separated, OR)")
		.option("--unlabeled", "Filter: issues with no labels")
		.option("--limit <n>", "Max issues to show", "50")
		.option("--sort <mode>", "Sort order (priority|created|updated|id)", "priority")
		.option("--format <mode>", `Output format (${VALID_FORMATS.join("|")})`)
		.option("--json", "Output as JSON (alias for --format json)")
		.action(
			async (opts: {
				status?: string;
				type?: string;
				assignee?: string;
				label?: string;
				labelAny?: string;
				unlabeled?: boolean;
				all?: boolean;
				limit?: string;
				sort?: string;
				format?: string;
				json?: boolean;
			}) => {
				const args: string[] = [];
				if (opts.status) args.push("--status", opts.status);
				if (opts.type) args.push("--type", opts.type);
				if (opts.assignee) args.push("--assignee", opts.assignee);
				if (opts.label) args.push("--label", opts.label);
				if (opts.labelAny) args.push("--label-any", opts.labelAny);
				if (opts.unlabeled) args.push("--unlabeled");
				if (opts.all) args.push("--all");
				if (opts.limit) args.push("--limit", opts.limit);
				if (opts.sort) args.push("--sort", opts.sort);
				if (opts.format) args.push("--format", opts.format);
				if (opts.json) args.push("--json");
				await run(args);
			},
		);
}
