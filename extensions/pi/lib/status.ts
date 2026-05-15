// Status widget counts for the @os-eco/pi-seeds extension. Reads
// .seeds/issues.jsonl directly (cheaper than three sd subprocess calls per
// agent_end) and reproduces the basic ready / in-progress / blocked filters.
//
// Plan-context edges (`requires_plan`, plan-draft propagation from
// PLAN_SPEC.md:342, etc.) are intentionally NOT replicated here — the widget
// is a glanceable approximation, not a substitute for `sd ready`. The actual
// `sd ready` output remains authoritative.

import { statSync } from "node:fs";
import { join } from "node:path";
import { findSeedsDir } from "../../../src/config.ts";
import { readIssues } from "../../../src/store.ts";
import { ISSUES_FILE, type Issue } from "../../../src/types.ts";

export interface StatusCounts {
	ready: number;
	inProgress: number;
	blocked: number;
}

export function computeCounts(issues: Issue[]): StatusCounts {
	const closedIds = new Set(issues.filter((i) => i.status === "closed").map((i) => i.id));
	let ready = 0;
	let inProgress = 0;
	let blocked = 0;
	for (const issue of issues) {
		if (issue.status === "closed") continue;
		const blockers = issue.blockedBy ?? [];
		const isBlocked = blockers.some((bid) => !closedIds.has(bid));
		if (isBlocked) {
			blocked++;
			continue;
		}
		if (issue.status === "in_progress") {
			inProgress++;
		} else {
			ready++;
		}
	}
	return { ready, inProgress, blocked };
}

export function formatStatusText(c: StatusCounts): string {
	return `sd: ${c.ready} ready / ${c.inProgress} in-progress / ${c.blocked} blocked`;
}

export interface StatusSnapshot {
	seedsDir: string;
	counts: StatusCounts;
	mtimeMs: number | undefined;
}

export async function readStatus(cwd: string): Promise<StatusSnapshot | undefined> {
	let seedsDir: string;
	try {
		seedsDir = await findSeedsDir(cwd);
	} catch {
		return undefined;
	}
	const issues = await readIssues(seedsDir);
	return {
		seedsDir,
		counts: computeCounts(issues),
		mtimeMs: readIssuesMtime(seedsDir),
	};
}

export function readIssuesMtime(seedsDir: string): number | undefined {
	try {
		return statSync(join(seedsDir, ISSUES_FILE)).mtimeMs;
	} catch {
		return undefined;
	}
}
