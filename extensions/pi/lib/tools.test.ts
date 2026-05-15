import { describe, expect, it } from "bun:test";
import type {
	AgentToolResult,
	ExecResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import {
	buildCloseTool,
	buildCreateTool,
	buildDepTool,
	buildReadyTool,
	buildSearchTool,
	buildShowTool,
	buildUpdateTool,
	type SdExec,
	type SdExecFactory,
	type ToolDetails,
} from "./tools.ts";

type ExecCall = { args: string[]; signaled: boolean };

function makeFactory(result: ExecResult): { factory: SdExecFactory; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const exec: SdExec = async (args, signal) => {
		calls.push({ args, signaled: signal?.aborted ?? false });
		return result;
	};
	return { factory: () => exec, calls };
}

function fakeCtx(): ExtensionContext {
	return { cwd: "/tmp/fake" } as unknown as ExtensionContext;
}

async function run<TParams extends TSchema>(
	tool: ToolDefinition<TParams, ToolDetails>,
	params: Static<TParams>,
): Promise<AgentToolResult<ToolDetails>> {
	return tool.execute("call-1", params, undefined, undefined, fakeCtx());
}

function ok(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function fail(stderr: string, stdout = "", code = 1): ExecResult {
	return { stdout, stderr, code, killed: false };
}

describe("sd_create tool", () => {
	it("forwards positional + flag args and surfaces the parsed JSON", async () => {
		const { factory, calls } = makeFactory(
			ok(JSON.stringify({ success: true, command: "create", id: "test-1234" })),
		);
		const tool = buildCreateTool(factory);

		const result = await run(tool, {
			title: "Hello",
			type: "bug",
			priority: "P1",
			labels: "a,b",
		});

		expect(calls).toHaveLength(1);
		const first = calls[0];
		expect(first).toBeDefined();
		if (!first) throw new Error("unreachable");
		expect(first.args).toEqual([
			"create",
			"--title",
			"Hello",
			"--type",
			"bug",
			"--priority",
			"P1",
			"--labels",
			"a,b",
			"--json",
		]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: JSON.stringify({ success: true, command: "create", id: "test-1234" }),
		});
		expect(result.details.command).toBe("create");
		expect(result.details.exitCode).toBe(0);
	});

	it("omits --json duplication when caller-supplied", async () => {
		const { factory, calls } = makeFactory(ok('{"success":true}'));
		const tool = buildCreateTool(factory);
		await run(tool, { title: "X" });
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		const jsonFlags = first.args.filter((a) => a === "--json");
		expect(jsonFlags).toHaveLength(1);
	});
});

describe("sd_ready tool", () => {
	it("emits --unlabeled and --respect-schedule as boolean flags", async () => {
		const { factory, calls } = makeFactory(
			ok(JSON.stringify({ success: true, command: "ready", issues: [], count: 0 })),
		);
		const tool = buildReadyTool(factory);
		await run(tool, { unlabeled: true, respect_schedule: true, limit: 10 });
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		expect(first.args).toContain("--unlabeled");
		expect(first.args).toContain("--respect-schedule");
		expect(first.args).toContain("--limit");
		expect(first.args).toContain("10");
	});
});

describe("sd_show tool", () => {
	it("passes the id as a positional", async () => {
		const { factory, calls } = makeFactory(ok('{"success":true,"issue":{"id":"x"}}'));
		const tool = buildShowTool(factory);
		await run(tool, { id: "seeds-abcd" });
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		expect(first.args).toEqual(["show", "seeds-abcd", "--json"]);
	});
});

describe("sd_update tool", () => {
	it("forwards label flags and set-labels with empty string", async () => {
		const { factory, calls } = makeFactory(
			ok(JSON.stringify({ success: true, command: "update", issue: {} })),
		);
		const tool = buildUpdateTool(factory);
		await run(tool, {
			id: "seeds-1",
			status: "in_progress",
			add_label: "x",
			set_labels: "",
		});
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		expect(first.args).toEqual([
			"update",
			"seeds-1",
			"--status",
			"in_progress",
			"--add-label",
			"x",
			"--set-labels",
			"",
			"--json",
		]);
	});
});

describe("sd_close tool", () => {
	it("surfaces structured errors with stderr instead of throwing", async () => {
		const { factory } = makeFactory(
			fail(
				"Issue not found: seeds-zzzz",
				JSON.stringify({
					success: false,
					command: "close",
					error: "Issue not found: seeds-zzzz",
				}),
			),
		);
		const tool = buildCloseTool(factory);
		const result = await run(tool, { id: "seeds-zzzz" });

		const block = result.content[0];
		expect(block).toBeDefined();
		if (!block || block.type !== "text") throw new Error("expected text content");
		const body = JSON.parse(block.text);
		expect(body.success).toBe(false);
		expect(body.error).toContain("Issue not found");
		expect(body.exitCode).toBe(1);
		expect(body.stderr).toContain("Issue not found");
	});

	it("passes --reason when provided", async () => {
		const { factory, calls } = makeFactory(
			ok(JSON.stringify({ success: true, command: "close", closed: ["seeds-1"] })),
		);
		const tool = buildCloseTool(factory);
		await run(tool, { id: "seeds-1", reason: "done" });
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		expect(first.args).toEqual(["close", "seeds-1", "--reason", "done", "--json"]);
	});
});

describe("sd_dep tool", () => {
	it("requires depends_on for add/remove and reports a structured error otherwise", async () => {
		const { factory, calls } = makeFactory(ok("{}"));
		const tool = buildDepTool(factory);
		const result = await run(tool, { action: "add", issue: "seeds-1" });
		expect(calls).toHaveLength(0);
		const block = result.content[0];
		if (!block || block.type !== "text") throw new Error("expected text content");
		const body = JSON.parse(block.text);
		expect(body.success).toBe(false);
		expect(body.error).toContain("requires depends_on");
	});

	it("rejects unknown actions before shelling out", async () => {
		const { factory, calls } = makeFactory(ok("{}"));
		const tool = buildDepTool(factory);
		const result = await run(tool, { action: "delete", issue: "seeds-1" });
		expect(calls).toHaveLength(0);
		const block = result.content[0];
		if (!block || block.type !== "text") throw new Error("expected text content");
		const body = JSON.parse(block.text);
		expect(body.success).toBe(false);
		expect(body.error).toContain("Unknown dep action");
	});

	it("passes list with just the issue id", async () => {
		const { factory, calls } = makeFactory(
			ok(
				JSON.stringify({
					success: true,
					command: "dep list",
					issueId: "seeds-1",
					blockedBy: [],
					blocks: [],
				}),
			),
		);
		const tool = buildDepTool(factory);
		await run(tool, { action: "list", issue: "seeds-1" });
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		expect(first.args).toEqual(["dep", "list", "seeds-1", "--json"]);
	});
});

describe("sd_search tool", () => {
	it("passes the query as a positional", async () => {
		const { factory, calls } = makeFactory(
			ok(JSON.stringify({ success: true, command: "search", issues: [], count: 0 })),
		);
		const tool = buildSearchTool(factory);
		await run(tool, { query: "auth", type: "bug", limit: 5 });
		const first = calls[0];
		if (!first) throw new Error("unreachable");
		expect(first.args).toEqual(["search", "auth", "--type", "bug", "--limit", "5", "--json"]);
	});
});

describe("malformed CLI output", () => {
	it("treats unparseable stdout with non-zero exit as error", async () => {
		const { factory } = makeFactory(fail("garbage", "not json"));
		const tool = buildShowTool(factory);
		const result = await run(tool, { id: "seeds-1" });
		const block = result.content[0];
		if (!block || block.type !== "text") throw new Error("expected text content");
		const body = JSON.parse(block.text);
		expect(body.success).toBe(false);
		expect(body.exitCode).toBe(1);
	});
});
