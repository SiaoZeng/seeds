import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { resolveFormat, stripAnsi, VALID_FORMATS } from "../format.ts";
import {
	formatIssueFull,
	formatIssueOneLineCompact,
	outputJson,
	printIssueFull,
} from "../output.ts";
import { readIssues } from "../store.ts";

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
	if (!issue) throw new Error(`Issue not found: ${id}`);

	switch (fmt.mode) {
		case "json":
			outputJson({ success: true, command: "show", issue });
			return;
		case "ids":
			console.log(issue.id);
			return;
		case "compact":
			console.log(formatIssueOneLineCompact(issue));
			return;
		case "plain":
			console.log(stripAnsi(formatIssueFull(issue)));
			return;
		default:
			printIssueFull(issue);
			return;
	}
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
