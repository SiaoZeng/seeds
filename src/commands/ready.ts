import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
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

function parseSort(args: string[]): string {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--sort") {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) return next;
		} else if (arg?.startsWith("--sort=")) {
			return arg.slice("--sort=".length);
		}
	}
	return "priority";
}

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const fmt = resolveFormat(args);
	const jsonMode = fmt.mode === "json";
	if (fmt.error) {
		if (jsonMode) {
			outputJson({ success: false, command: "ready", error: fmt.error });
		} else {
			console.error(fmt.error);
		}
		process.exitCode = 1;
		return;
	}
	const dir = seedsDir ?? (await findSeedsDir());
	const issues = await readIssues(dir);

	const closedIds = new Set(issues.filter((i: Issue) => i.status === "closed").map((i) => i.id));

	let ready = issues.filter((i: Issue) => {
		if (i.status !== "open") return false;
		const blockers = i.blockedBy ?? [];
		return blockers.every((bid) => closedIds.has(bid));
	});

	const sortFlag = parseSort(args);
	if (!isSortMode(sortFlag)) {
		const msg = `Invalid --sort value: ${sortFlag}. Valid: ${VALID_SORT_MODES.join("|")}`;
		if (jsonMode) {
			outputJson({ success: false, command: "ready", error: msg });
		} else {
			console.error(msg);
		}
		process.exitCode = 1;
		return;
	}
	ready = sortIssues(ready, sortFlag);

	switch (fmt.mode) {
		case "json":
			outputJson({ success: true, command: "ready", issues: ready, count: ready.length });
			return;
		case "ids":
			for (const issue of ready) console.log(issue.id);
			return;
		case "compact":
			for (const issue of ready) console.log(formatIssueOneLineCompact(issue));
			return;
		case "plain":
			if (ready.length === 0) {
				console.log("No ready issues.");
				return;
			}
			for (const issue of ready) console.log(stripAnsi(formatIssueOneLine(issue)));
			console.log(`\n${ready.length} ready issue(s)`);
			return;
		default:
			if (ready.length === 0) {
				console.log("No ready issues.");
				return;
			}
			for (const issue of ready) printIssueOneLine(issue);
			console.log(`\n${ready.length} ready issue(s)`);
			return;
	}
}

export function register(program: Command): void {
	program
		.command("ready")
		.description("Show open issues with no unresolved blockers")
		.option("--sort <mode>", "Sort order (priority|created|updated|id)", "priority")
		.option("--format <mode>", `Output format (${VALID_FORMATS.join("|")})`)
		.option("--json", "Output as JSON (alias for --format json)")
		.action(async (opts: { sort?: string; format?: string; json?: boolean }) => {
			const args: string[] = [];
			if (opts.sort) args.push("--sort", opts.sort);
			if (opts.format) args.push("--format", opts.format);
			if (opts.json) args.push("--json");
			await run(args);
		});
}
