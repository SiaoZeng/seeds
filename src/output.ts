import chalk from "chalk";
import { stripAnsi } from "./format.ts";
import type { Issue } from "./types.ts";
import { PRIORITY_LABELS } from "./types.ts";

// Forest palette
export const brand = chalk.rgb(124, 179, 66);
export const accent = chalk.rgb(255, 183, 77);
export const muted = chalk.rgb(120, 120, 110);

let _quiet = false;

export function setQuiet(v: boolean): void {
	_quiet = v;
}

export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function printSuccess(msg: string): void {
	if (_quiet) return;
	console.log(`${brand("✓")} ${brand(msg)}`);
}

export function printError(msg: string): void {
	console.error(`${chalk.red("✗")} ${msg}`);
}

export function printWarning(msg: string): void {
	console.log(`${chalk.yellow("!")} ${msg}`);
}

export function formatIssueOneLine(issue: Issue): string {
	const isBlocked = (issue.blockedBy?.length ?? 0) > 0;
	const statusIcon =
		issue.status === "closed"
			? muted("x")
			: issue.status === "in_progress"
				? chalk.cyan(">")
				: isBlocked
					? chalk.yellow("!")
					: brand("-");
	const priorityLabel = PRIORITY_LABELS[issue.priority] ?? String(issue.priority);
	const assignee = issue.assignee ? ` · ${muted(`@${issue.assignee}`)}` : "";
	const blocked = isBlocked ? ` ${chalk.yellow("[blocked]")}` : "";
	const labelStr = issue.labels?.length ? ` ${muted(`{${issue.labels.join(", ")}}`)}` : "";
	return `${statusIcon} ${accent.bold(issue.id)} · ${issue.title}   ${muted(`[${priorityLabel} · ${issue.type}]`)}${assignee}${blocked}${labelStr}`;
}

export function formatIssueOneLineCompact(issue: Issue): string {
	const priorityLabel = PRIORITY_LABELS[issue.priority] ?? String(issue.priority);
	const isBlocked = (issue.blockedBy?.length ?? 0) > 0;
	const status = isBlocked ? "blocked" : issue.status;
	return `${issue.id} ${priorityLabel} ${status} ${issue.title}`;
}

export function printIssueOneLine(issue: Issue): void {
	if (_quiet) return;
	console.log(formatIssueOneLine(issue));
}

export function formatIssueFull(issue: Issue): string {
	const statusColor =
		issue.status === "closed" ? muted : issue.status === "in_progress" ? chalk.cyan : brand;
	const priorityLabel = PRIORITY_LABELS[issue.priority] ?? String(issue.priority);

	const lines: string[] = [];
	lines.push(`${accent.bold(issue.id)}  ${statusColor(issue.status)}`);
	lines.push(`Title:    ${issue.title}`);
	lines.push(`Type:     ${muted(issue.type)}   Priority: ${muted(priorityLabel)}`);
	if (issue.assignee) lines.push(`Assignee: ${issue.assignee}`);
	if (issue.labels?.length)
		lines.push(`Labels:   ${issue.labels.map((l) => accent(l)).join(", ")}`);
	if (issue.description) lines.push(`\n${issue.description}`);
	if (issue.blockedBy?.length)
		lines.push(`Blocked by: ${issue.blockedBy.map((id) => accent(id)).join(", ")}`);
	if (issue.blocks?.length)
		lines.push(`Blocks:     ${issue.blocks.map((id) => accent(id)).join(", ")}`);
	if (issue.convoy) lines.push(`Convoy:   ${muted(issue.convoy)}`);
	if (issue.closeReason) lines.push(`Reason:   ${issue.closeReason}`);
	lines.push(`Created:  ${muted(issue.createdAt)}`);
	lines.push(`Updated:  ${muted(issue.updatedAt)}`);
	if (issue.closedAt) lines.push(`Closed:   ${muted(issue.closedAt)}`);
	return lines.join("\n");
}

export function printIssueFull(issue: Issue): void {
	if (_quiet) return;
	console.log(formatIssueFull(issue));
}

export function plain(s: string): string {
	return stripAnsi(s);
}
