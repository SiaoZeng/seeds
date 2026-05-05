import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { outputJson, printIssueOneLine } from "../output.ts";
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
	const jsonMode = args.includes("--json");
	const flags = parseArgs(args);

	const statusFilter = typeof flags.status === "string" ? flags.status : undefined;
	const typeFilter = typeof flags.type === "string" ? flags.type : undefined;
	const assigneeFilter = typeof flags.assignee === "string" ? flags.assignee : undefined;
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
	if (typeFilter) issues = issues.filter((i: Issue) => i.type === typeFilter);
	if (assigneeFilter) issues = issues.filter((i: Issue) => i.assignee === assigneeFilter);

	const labelFilter = typeof flags.label === "string" ? flags.label : undefined;
	const labelAnyFilter = typeof flags["label-any"] === "string" ? flags["label-any"] : undefined;
	const unlabeled = flags.unlabeled === true;

	if (labelFilter) {
		const required = labelFilter
			.split(",")
			.map((l) => l.trim().toLowerCase())
			.filter(Boolean);
		issues = issues.filter((i: Issue) => {
			const labels = i.labels ?? [];
			return required.every((r) => labels.includes(r));
		});
	}
	if (labelAnyFilter) {
		const any = new Set(
			labelAnyFilter
				.split(",")
				.map((l) => l.trim().toLowerCase())
				.filter(Boolean),
		);
		issues = issues.filter((i: Issue) => {
			const labels = i.labels ?? [];
			return labels.some((l) => any.has(l));
		});
	}
	if (unlabeled) {
		issues = issues.filter((i: Issue) => !i.labels || i.labels.length === 0);
	}

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

	if (jsonMode) {
		outputJson({ success: true, command: "list", issues, count: issues.length });
	} else {
		if (issues.length === 0) {
			console.log("No issues found.");
			return;
		}
		for (const issue of issues) {
			printIssueOneLine(issue);
		}
		console.log(`\n${issues.length} issue(s)`);
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
		.option("--json", "Output as JSON")
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
				if (opts.json) args.push("--json");
				await run(args);
			},
		);
}
