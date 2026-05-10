import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { resolveFormat, stripAnsi, VALID_FORMATS } from "../format.ts";
import {
	accent,
	brand,
	formatIssueFull,
	formatIssueOneLineCompact,
	muted,
	outputJson,
	printIssueFull,
} from "../output.ts";
import { loadPlanContext, planForIssue, summarisePlanChildren } from "../plan-context.ts";
import { readIssues } from "../store.ts";
import { runShow as runPlanShow } from "./plan.ts";

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const fmt = resolveFormat(args);
	const jsonMode = fmt.mode === "json";
	if (fmt.error) {
		if (jsonMode) {
			outputJson({ success: false, command: "show", error: fmt.error });
		} else {
			console.error(fmt.error);
		}
		process.exitCode = 1;
		return;
	}
	const id = args.find((a) => !a.startsWith("--"));
	if (!id) throw new Error("Usage: sd show <id>");

	const dir = seedsDir ?? (await findSeedsDir());
	const issues = await readIssues(dir);
	const issue = issues.find((i) => i.id === id);
	if (!issue) {
		if (id.startsWith("pl-")) {
			if (fmt.mode !== "markdown" && fmt.mode !== "json") {
				const errMsg = `sd show ${id}: --format ${fmt.mode} is not supported for plan ids; pass --json or use 'sd plan show ${id}'`;
				console.error(errMsg);
				process.exitCode = 1;
				return;
			}
			await runPlanShow(id, jsonMode);
			return;
		}
		throw new Error(`Issue not found: ${id}`);
	}

	const planCtx = await loadPlanContext(dir);
	const plan = planForIssue(planCtx, issue);
	const planChildren = plan ? summarisePlanChildren(plan, issues) : undefined;

	switch (fmt.mode) {
		case "json": {
			const out: Record<string, unknown> = { success: true, command: "show", issue };
			if (plan) {
				out.plan = {
					id: plan.id,
					status: plan.status,
					revision: plan.revision,
					template: plan.template,
					children: plan.children,
				};
				out.plan_children = planChildren;
			}
			outputJson(out);
			return;
		}
		case "ids":
			console.log(issue.id);
			return;
		case "compact": {
			const closedBlockerIds = new Set(
				issues.filter((i) => i.status === "closed").map((i) => i.id),
			);
			console.log(formatIssueOneLineCompact(issue, closedBlockerIds));
			return;
		}
		case "plain":
			console.log(stripAnsi(formatIssueFull(issue) + renderPlanBlock(plan, planChildren)));
			return;
		default:
			printIssueFull(issue);
			if (plan) process.stdout.write(renderPlanBlock(plan, planChildren));
			return;
	}
}

function renderPlanBlock(
	plan: ReturnType<typeof planForIssue>,
	children: ReturnType<typeof summarisePlanChildren> | undefined,
): string {
	if (!plan) return "";
	const lines: string[] = [
		"",
		`${brand("Plan:")} ${accent(plan.id)}  ${muted(`[${plan.status}]`)}`,
	];
	if (plan.status === "draft") {
		lines.push(`${accent("plan in draft — run sd plan submit")}`);
	} else if (children && children.length > 0) {
		lines.push(`${muted(`Plan steps (${children.length}):`)}`);
		for (const c of children) {
			lines.push(`  ${accent(c.id)}  ${muted(`[${c.status}]`)}  ${c.title}`);
		}
	}
	return `\n${lines.join("\n")}\n`;
}

export function register(program: Command): void {
	program
		.command("show <id>")
		.description("Show issue details")
		.option("--format <mode>", `Output format (${VALID_FORMATS.join("|")})`)
		.option("--json", "Output as JSON (alias for --format json)")
		.action(async (id: string, opts: { format?: string; json?: boolean }) => {
			const args: string[] = [id];
			if (opts.format) args.push("--format", opts.format);
			if (opts.json) args.push("--json");
			await run(args);
		});
}
