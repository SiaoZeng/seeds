import { describe, expect, it } from "bun:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	buildCommandRegistrations,
	type CommandDeps,
	CURRENT_ISSUE_CUSTOM_TYPE,
	collectPersistedCurrentIssueId,
	parseArgs,
	runClaim,
	runClose,
	runCreate,
	runReady,
	runShow,
	tokenize,
} from "./commands.ts";

interface RecordedExec {
	cmd: string;
	args: string[];
	cwd?: string;
}

interface RecordedMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
	options?: { deliverAs?: string };
}

interface RecordedEntry {
	customType: string;
	data: unknown;
}

interface Harness {
	deps: CommandDeps;
	execs: RecordedExec[];
	messages: RecordedMessage[];
	entries: RecordedEntry[];
	notifications: Array<{ message: string; type?: string }>;
	working: { id: string | undefined };
}

function ok(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function fail(stderr: string, code = 1, stdout = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function makeHarness(queue: ExecResult[]): Harness {
	const execs: RecordedExec[] = [];
	const messages: RecordedMessage[] = [];
	const entries: RecordedEntry[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const working: { id: string | undefined } = { id: undefined };
	const deps: CommandDeps = {
		exec: async (cmd, args, options) => {
			execs.push({ cmd, args, cwd: options?.cwd });
			const next = queue.shift();
			if (!next) throw new Error("exec queue exhausted");
			return next;
		},
		cwd: "/tmp/seeds-project",
		sendMessage: (message, options) => {
			messages.push({ ...message, options });
		},
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
		setWorking: (id) => {
			working.id = id;
		},
		notify: (message, type) => {
			notifications.push({ message, type });
		},
		getCurrentIssueId: () => working.id,
	};
	return { deps, execs, messages, entries, notifications, working };
}

describe("tokenize", () => {
	it("splits on whitespace and collapses quoted strings", () => {
		expect(tokenize('foo "bar baz" qux')).toEqual(["foo", "bar baz", "qux"]);
		expect(tokenize("--title 'hello world' --type bug")).toEqual([
			"--title",
			"hello world",
			"--type",
			"bug",
		]);
	});

	it("returns an empty array for whitespace-only input", () => {
		expect(tokenize("   \t  ")).toEqual([]);
	});
});

describe("parseArgs", () => {
	it("separates --flag value pairs from positionals", () => {
		const parsed = parseArgs("seeds-1234 --reason already-fixed extra");
		expect(parsed.positional).toEqual(["seeds-1234", "extra"]);
		expect(parsed.flags).toEqual([["reason", "already-fixed"]]);
	});

	it("supports --flag=value", () => {
		const parsed = parseArgs("--title=Hello --priority=P0");
		expect(parsed.positional).toEqual([]);
		expect(parsed.flags).toEqual([
			["title", "Hello"],
			["priority", "P0"],
		]);
	});

	it("emits an empty value when a flag has no follow-up token", () => {
		const parsed = parseArgs("--respect-schedule");
		expect(parsed.flags).toEqual([["respect-schedule", ""]]);
	});
});

describe("runReady", () => {
	it("shells out to sd ready --json and emits a steer message", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true, issues: [] }))]);
		const result = await runReady(harness.deps, "");
		expect(result.ok).toBe(true);
		expect(harness.execs).toHaveLength(1);
		expect(harness.execs[0]?.cmd).toBe("sd");
		expect(harness.execs[0]?.args).toEqual(["ready", "--json"]);
		expect(harness.messages).toHaveLength(1);
		expect(harness.messages[0]?.options?.deliverAs).toBe("steer");
		expect(harness.messages[0]?.display).toBe(false);
	});

	it("reports failures via notify and returns ok=false", async () => {
		const harness = makeHarness([fail("boom", 2)]);
		const result = await runReady(harness.deps, "");
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(2);
		expect(harness.messages).toHaveLength(0);
		expect(harness.notifications.some((n) => n.type === "error")).toBe(true);
	});

	it("forwards --flag value pairs to sd ready", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true }))]);
		await runReady(harness.deps, "--label backend --priority-max 1");
		expect(harness.execs[0]?.args).toEqual([
			"ready",
			"--label",
			"backend",
			"--priority-max",
			"1",
			"--json",
		]);
	});
});

describe("runCreate", () => {
	it("promotes a positional argument to --title when --title is absent", async () => {
		const harness = makeHarness([
			ok(JSON.stringify({ success: true, command: "create", id: "seeds-abcd" })),
		]);
		await runCreate(harness.deps, '"Wire pi commands" --type task --priority P1');
		expect(harness.execs[0]?.args).toEqual([
			"create",
			"--title",
			"Wire pi commands",
			"--type",
			"task",
			"--priority",
			"P1",
			"--json",
		]);
	});

	it("rejects empty input with a usage warning", async () => {
		const harness = makeHarness([]);
		const result = await runCreate(harness.deps, "");
		expect(result.ok).toBe(false);
		expect(harness.execs).toHaveLength(0);
		expect(harness.notifications.some((n) => n.type === "warning")).toBe(true);
	});
});

describe("runShow", () => {
	it("forwards multiple ids and the --json flag", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true }))]);
		await runShow(harness.deps, "seeds-1111 seeds-2222");
		expect(harness.execs[0]?.args).toEqual(["show", "seeds-1111", "seeds-2222", "--json"]);
		expect(harness.messages[0]?.content).toContain("/sd:show seeds-1111 seeds-2222");
	});

	it("rejects empty input", async () => {
		const harness = makeHarness([]);
		const result = await runShow(harness.deps, "  ");
		expect(result.ok).toBe(false);
		expect(harness.execs).toHaveLength(0);
	});
});

describe("runClose", () => {
	it("packs trailing words into --reason when no --reason flag is given", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true }))]);
		await runClose(harness.deps, "seeds-1234 already covered upstream");
		expect(harness.execs[0]?.args).toEqual([
			"close",
			"seeds-1234",
			"--reason",
			"already covered upstream",
			"--json",
		]);
	});

	it("clears the working prefix when closing the active issue", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true }))]);
		harness.working.id = "seeds-1234";
		await runClose(harness.deps, "seeds-1234");
		expect(harness.working.id).toBeUndefined();
		expect(harness.entries.some((e) => e.customType === CURRENT_ISSUE_CUSTOM_TYPE)).toBe(true);
	});

	it("leaves the working prefix alone when closing a different issue", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true }))]);
		harness.working.id = "seeds-9999";
		await runClose(harness.deps, "seeds-1234");
		expect(harness.working.id).toBe("seeds-9999");
		expect(harness.entries).toEqual([]);
	});
});

describe("runClaim", () => {
	it("updates the issue to in_progress and pins the working widget prefix", async () => {
		const harness = makeHarness([ok(JSON.stringify({ success: true, command: "update" }))]);
		await runClaim(harness.deps, "seeds-5103");
		expect(harness.execs[0]?.args).toEqual([
			"update",
			"seeds-5103",
			"--status",
			"in_progress",
			"--json",
		]);
		expect(harness.working.id).toBe("seeds-5103");
		expect(harness.entries).toEqual([
			{ customType: CURRENT_ISSUE_CUSTOM_TYPE, data: { id: "seeds-5103" } },
		]);
	});

	it("rejects empty input with a usage warning", async () => {
		const harness = makeHarness([]);
		const result = await runClaim(harness.deps, "");
		expect(result.ok).toBe(false);
		expect(harness.execs).toHaveLength(0);
	});

	it("does not pin the prefix on CLI failure", async () => {
		const harness = makeHarness([fail("nope", 1)]);
		const result = await runClaim(harness.deps, "seeds-bad");
		expect(result.ok).toBe(false);
		expect(harness.working.id).toBeUndefined();
		expect(harness.entries).toEqual([]);
	});
});

describe("collectPersistedCurrentIssueId", () => {
	it("returns the most recent id from custom entries", () => {
		const entries = [
			{ type: "custom", customType: CURRENT_ISSUE_CUSTOM_TYPE, data: { id: "seeds-aaaa" } },
			{ type: "message" },
			{ type: "custom", customType: CURRENT_ISSUE_CUSTOM_TYPE, data: { id: "seeds-bbbb" } },
		];
		expect(collectPersistedCurrentIssueId(entries)).toBe("seeds-bbbb");
	});

	it("treats a null payload as a clear", () => {
		const entries = [
			{ type: "custom", customType: CURRENT_ISSUE_CUSTOM_TYPE, data: { id: "seeds-aaaa" } },
			{ type: "custom", customType: CURRENT_ISSUE_CUSTOM_TYPE, data: null },
		];
		expect(collectPersistedCurrentIssueId(entries)).toBeUndefined();
	});

	it("ignores entries with mismatched customType", () => {
		const entries = [{ type: "custom", customType: "something-else", data: { id: "seeds-aaaa" } }];
		expect(collectPersistedCurrentIssueId(entries)).toBeUndefined();
	});
});

describe("buildCommandRegistrations", () => {
	it("returns the six expected command names", () => {
		const regs = buildCommandRegistrations(() => undefined);
		const names = regs.map((r) => r.name);
		expect(names).toEqual(["sd", "sd:ready", "sd:create", "sd:show", "sd:close", "sd:claim"]);
	});

	it("handlers are inert when deps are undefined (no exec, no throw)", async () => {
		const regs = buildCommandRegistrations(() => undefined);
		for (const reg of regs) {
			await reg.options.handler("seeds-1234");
		}
		// No assertions on side effects — the contract is "don't throw".
		expect(regs).toHaveLength(6);
	});
});
