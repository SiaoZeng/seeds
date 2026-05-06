import { describe, expect, test } from "bun:test";
import { formatIssueOneLine, formatIssueOneLineCompact, plain } from "./output.ts";
import type { Issue } from "./types.ts";

const baseIssue = (overrides: Partial<Issue> = {}): Issue => ({
	id: "test-0001",
	title: "title",
	status: "open",
	type: "task",
	priority: 2,
	createdAt: "2026-05-06T00:00:00.000Z",
	updatedAt: "2026-05-06T00:00:00.000Z",
	...overrides,
});

describe("formatIssueOneLine", () => {
	test("no [blocked] tag when blockedBy is empty", () => {
		const out = plain(formatIssueOneLine(baseIssue()));
		expect(out).not.toContain("[blocked]");
	});

	test("legacy: [blocked] when blockedBy is non-empty and no closed-set is passed", () => {
		const out = plain(formatIssueOneLine(baseIssue({ blockedBy: ["x-1"] })));
		expect(out).toContain("[blocked]");
	});

	test("no [blocked] tag when every blocker is closed", () => {
		const out = plain(formatIssueOneLine(baseIssue({ blockedBy: ["x-1"] }), new Set(["x-1"])));
		expect(out).not.toContain("[blocked]");
	});

	test("[blocked] tag when at least one blocker is still open", () => {
		const out = plain(
			formatIssueOneLine(baseIssue({ blockedBy: ["x-1", "x-2"] }), new Set(["x-1"])),
		);
		expect(out).toContain("[blocked]");
	});

	test("no [blocked] tag when blockedBy empty and a closed-set is passed", () => {
		const out = plain(formatIssueOneLine(baseIssue(), new Set(["x-1"])));
		expect(out).not.toContain("[blocked]");
	});
});

describe("formatIssueOneLineCompact", () => {
	test("status reflects issue.status when blockedBy is empty", () => {
		const out = formatIssueOneLineCompact(baseIssue({ status: "open" }));
		expect(out).toContain(" open ");
		expect(out).not.toContain(" blocked ");
	});

	test("legacy: status is 'blocked' when blockedBy is non-empty and no closed-set is passed", () => {
		const out = formatIssueOneLineCompact(baseIssue({ blockedBy: ["x-1"] }));
		expect(out).toContain(" blocked ");
	});

	test("status reflects issue.status when every blocker is closed", () => {
		const out = formatIssueOneLineCompact(
			baseIssue({ blockedBy: ["x-1"], status: "open" }),
			new Set(["x-1"]),
		);
		expect(out).toContain(" open ");
		expect(out).not.toContain(" blocked ");
	});

	test("status is 'blocked' when at least one blocker is still open", () => {
		const out = formatIssueOneLineCompact(
			baseIssue({ blockedBy: ["x-1", "x-2"] }),
			new Set(["x-1"]),
		);
		expect(out).toContain(" blocked ");
	});
});
