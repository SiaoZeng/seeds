import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue } from "../../../src/types.ts";
import { computeCounts, formatStatusText, readIssuesMtime, readStatus } from "./status.ts";

function issue(overrides: Partial<Issue>): Issue {
	return {
		id: "seeds-aaaa",
		title: "untitled",
		status: "open",
		type: "task",
		priority: 2,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as Issue;
}

describe("computeCounts", () => {
	it("returns zeros for an empty list", () => {
		expect(computeCounts([])).toEqual({ ready: 0, inProgress: 0, blocked: 0 });
	});

	it("excludes closed issues entirely", () => {
		const counts = computeCounts([
			issue({ id: "a", status: "closed" }),
			issue({ id: "b", status: "open" }),
		]);
		expect(counts).toEqual({ ready: 1, inProgress: 0, blocked: 0 });
	});

	it("counts in_progress separately from ready", () => {
		const counts = computeCounts([
			issue({ id: "a", status: "in_progress" }),
			issue({ id: "b", status: "open" }),
		]);
		expect(counts).toEqual({ ready: 1, inProgress: 1, blocked: 0 });
	});

	it("treats issues with unresolved blockers as blocked, not ready", () => {
		const counts = computeCounts([
			issue({ id: "open-1" }),
			issue({ id: "open-2", blockedBy: ["open-1"] }),
		]);
		expect(counts).toEqual({ ready: 1, inProgress: 0, blocked: 1 });
	});

	it("treats issues whose blockers are all closed as ready", () => {
		const counts = computeCounts([
			issue({ id: "closed-1", status: "closed" }),
			issue({ id: "open-2", blockedBy: ["closed-1"] }),
		]);
		expect(counts).toEqual({ ready: 1, inProgress: 0, blocked: 0 });
	});

	it("classifies a blocked in_progress issue as blocked (matches sd ready semantics)", () => {
		const counts = computeCounts([
			issue({ id: "open-1" }),
			issue({ id: "open-2", status: "in_progress", blockedBy: ["open-1"] }),
		]);
		expect(counts).toEqual({ ready: 1, inProgress: 0, blocked: 1 });
	});

	it("ignores blockers pointing at non-existent ids (treats them as unresolved)", () => {
		const counts = computeCounts([issue({ id: "open-2", blockedBy: ["ghost"] })]);
		expect(counts).toEqual({ ready: 0, inProgress: 0, blocked: 1 });
	});
});

describe("formatStatusText", () => {
	it("renders the glanceable widget string", () => {
		expect(formatStatusText({ ready: 3, inProgress: 1, blocked: 2 })).toBe(
			"sd: 3 ready / 1 in-progress / 2 blocked",
		);
	});
});

describe("readStatus + readIssuesMtime", () => {
	async function makeProject(tmp: string, issues: Issue[]): Promise<string> {
		const seedsDir = join(tmp, ".seeds");
		await Bun.write(join(seedsDir, "config.yaml"), 'project: "demo"\nversion: "1"\n');
		const body = issues.map((i) => JSON.stringify(i)).join("\n");
		await Bun.write(join(seedsDir, "issues.jsonl"), body ? `${body}\n` : "");
		return seedsDir;
	}

	it("returns undefined when cwd is not inside a seeds project", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-status-test-"));
		try {
			expect(await readStatus(tmp)).toBeUndefined();
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("returns counts derived from .seeds/issues.jsonl", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-status-test-"));
		try {
			await makeProject(tmp, [
				issue({ id: "a" }),
				issue({ id: "b", status: "in_progress" }),
				issue({ id: "c", blockedBy: ["a"] }),
				issue({ id: "d", status: "closed" }),
			]);
			const snapshot = await readStatus(tmp);
			expect(snapshot).toBeDefined();
			if (!snapshot) throw new Error("unreachable");
			expect(snapshot.counts).toEqual({ ready: 1, inProgress: 1, blocked: 1 });
			expect(snapshot.mtimeMs).toBeGreaterThan(0);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("readIssuesMtime tracks file mtime changes", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-status-test-"));
		try {
			const seedsDir = await makeProject(tmp, [issue({ id: "a" })]);
			const before = readIssuesMtime(seedsDir);
			expect(before).toBeDefined();
			if (before === undefined) throw new Error("unreachable");

			// Bump the mtime explicitly so the assertion doesn't depend on filesystem
			// timestamp resolution.
			const future = new Date(Date.now() + 60_000);
			await utimes(join(seedsDir, "issues.jsonl"), future, future);

			const after = readIssuesMtime(seedsDir);
			expect(after).toBeDefined();
			if (after === undefined) throw new Error("unreachable");
			expect(after).toBeGreaterThan(before);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	it("readIssuesMtime returns undefined when the file is missing", () => {
		expect(readIssuesMtime("/nonexistent-pi-seeds-dir")).toBeUndefined();
	});
});
