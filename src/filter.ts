import type { Issue } from "./types.ts";

export interface IssueFilterOptions {
	type?: string;
	assignee?: string;
	label?: string;
	labelAny?: string;
	unlabeled?: boolean;
}

function splitLabels(value: string): string[] {
	return value
		.split(",")
		.map((l) => l.trim().toLowerCase())
		.filter(Boolean);
}

export function applyIssueFilters(issues: Issue[], opts: IssueFilterOptions): Issue[] {
	let result = issues;
	if (opts.type) result = result.filter((i) => i.type === opts.type);
	if (opts.assignee) result = result.filter((i) => i.assignee === opts.assignee);
	if (opts.label) {
		const required = splitLabels(opts.label);
		result = result.filter((i) => {
			const labels = i.labels ?? [];
			return required.every((r) => labels.includes(r));
		});
	}
	if (opts.labelAny) {
		const any = new Set(splitLabels(opts.labelAny));
		result = result.filter((i) => {
			const labels = i.labels ?? [];
			return labels.some((l) => any.has(l));
		});
	}
	if (opts.unlabeled) {
		result = result.filter((i) => !i.labels || i.labels.length === 0);
	}
	return result;
}

export function filterOptionsFromFlags(
	flags: Record<string, string | boolean>,
): IssueFilterOptions {
	return {
		type: typeof flags.type === "string" ? flags.type : undefined,
		assignee: typeof flags.assignee === "string" ? flags.assignee : undefined,
		label: typeof flags.label === "string" ? flags.label : undefined,
		labelAny: typeof flags["label-any"] === "string" ? flags["label-any"] : undefined,
		unlabeled: flags.unlabeled === true,
	};
}
