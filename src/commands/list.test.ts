import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/index.ts");
let tmpDir: string;

async function run(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function runJson<T = unknown>(args: string[], cwd: string): Promise<T> {
	const { stdout } = await run([...args, "--json"], cwd);
	return JSON.parse(stdout) as T;
}

async function create(title: string, priority: number, cwd: string): Promise<string> {
	const out = await runJson<{ id: string }>(
		["create", "--title", title, "--priority", String(priority)],
		cwd,
	);
	return out.id;
}

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "seeds-listsort-test-"));
	await run(["init"], tmpDir);
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("sd list sort", () => {
	test("defaults to priority asc, P0 first", async () => {
		await create("low", 3, tmpDir);
		await create("crit", 0, tmpDir);
		await create("med", 2, tmpDir);
		const result = await runJson<{ issues: Array<{ priority: number }> }>(["list"], tmpDir);
		expect(result.issues.map((i) => i.priority)).toEqual([0, 2, 3]);
	});

	test("--sort created sorts newest first", async () => {
		const a = await create("a", 2, tmpDir);
		await new Promise((r) => setTimeout(r, 5));
		const b = await create("b", 2, tmpDir);
		await new Promise((r) => setTimeout(r, 5));
		const c = await create("c", 2, tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["list", "--sort", "created"],
			tmpDir,
		);
		expect(result.issues.map((i) => i.id)).toEqual([c, b, a]);
	});

	test("--sort id sorts ascending by id", async () => {
		await create("a", 0, tmpDir);
		await create("b", 3, tmpDir);
		await create("c", 1, tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["list", "--sort", "id"],
			tmpDir,
		);
		const ids = result.issues.map((i) => i.id);
		expect([...ids].sort()).toEqual(ids);
	});

	test("rejects invalid --sort value", async () => {
		await create("a", 2, tmpDir);
		const { exitCode, stderr } = await run(["list", "--sort", "bogus"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Invalid --sort value");
	});
});

describe("sd ready sort", () => {
	test("defaults to priority asc, P0 first", async () => {
		await create("low", 3, tmpDir);
		await create("crit", 0, tmpDir);
		await create("med", 2, tmpDir);
		const result = await runJson<{ issues: Array<{ priority: number }> }>(["ready"], tmpDir);
		expect(result.issues.map((i) => i.priority)).toEqual([0, 2, 3]);
	});

	test("--sort updated honored", async () => {
		const a = await create("a", 2, tmpDir);
		const b = await create("b", 2, tmpDir);
		await new Promise((r) => setTimeout(r, 10));
		await run(["update", a, "--title", "a-prime"], tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["ready", "--sort", "updated"],
			tmpDir,
		);
		expect(result.issues[0]?.id).toBe(a);
		expect(result.issues[1]?.id).toBe(b);
	});

	test("rejects invalid --sort value", async () => {
		await create("a", 2, tmpDir);
		const { exitCode, stderr } = await run(["ready", "--sort", "bogus"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Invalid --sort value");
	});
});

describe("sd ready filters", () => {
	async function createTyped(
		title: string,
		type: string,
		cwd: string,
		extra: string[] = [],
	): Promise<string> {
		const out = await runJson<{ id: string }>(
			["create", "--title", title, "--type", type, ...extra],
			cwd,
		);
		return out.id;
	}

	test("--type filters ready issues", async () => {
		const bug = await createTyped("a bug", "bug", tmpDir);
		await createTyped("a task", "task", tmpDir);
		const result = await runJson<{ issues: Array<{ id: string; type: string }> }>(
			["ready", "--type", "bug"],
			tmpDir,
		);
		expect(result.issues.map((i) => i.id)).toEqual([bug]);
	});

	test("--assignee filters ready issues", async () => {
		const mine = await createTyped("mine", "task", tmpDir, ["--assignee", "alice"]);
		await createTyped("theirs", "task", tmpDir, ["--assignee", "bob"]);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["ready", "--assignee", "alice"],
			tmpDir,
		);
		expect(result.issues.map((i) => i.id)).toEqual([mine]);
	});

	test("--label AND filter on ready issues", async () => {
		const a = await create("a", 2, tmpDir);
		const b = await create("b", 2, tmpDir);
		await run(["label", "add", a, "bug", "ui"], tmpDir);
		await run(["label", "add", b, "bug"], tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["ready", "--label", "bug,ui"],
			tmpDir,
		);
		const ids = result.issues.map((i) => i.id);
		expect(ids).toContain(a);
		expect(ids).not.toContain(b);
	});

	test("--label-any OR filter on ready issues", async () => {
		const a = await create("a", 2, tmpDir);
		const b = await create("b", 2, tmpDir);
		const c = await create("c", 2, tmpDir);
		await run(["label", "add", a, "ui"], tmpDir);
		await run(["label", "add", b, "backend"], tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["ready", "--label-any", "ui,backend"],
			tmpDir,
		);
		const ids = result.issues.map((i) => i.id);
		expect(ids).toContain(a);
		expect(ids).toContain(b);
		expect(ids).not.toContain(c);
	});

	test("--unlabeled returns only ready issues with no labels", async () => {
		const bare = await create("bare", 2, tmpDir);
		const tagged = await create("tagged", 2, tmpDir);
		await run(["label", "add", tagged, "bug"], tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["ready", "--unlabeled"],
			tmpDir,
		);
		const ids = result.issues.map((i) => i.id);
		expect(ids).toContain(bare);
		expect(ids).not.toContain(tagged);
	});

	test("--limit caps the number of ready issues", async () => {
		await create("a", 2, tmpDir);
		await create("b", 2, tmpDir);
		await create("c", 2, tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }>; count: number }>(
			["ready", "--limit", "2"],
			tmpDir,
		);
		expect(result.issues).toHaveLength(2);
		expect(result.count).toBe(2);
	});

	test("filters compose with sort", async () => {
		const lowBug = await createTyped("low bug", "bug", tmpDir, ["--priority", "3"]);
		const critBug = await createTyped("crit bug", "bug", tmpDir, ["--priority", "0"]);
		await createTyped("a task", "task", tmpDir);
		const result = await runJson<{ issues: Array<{ id: string }> }>(
			["ready", "--type", "bug"],
			tmpDir,
		);
		expect(result.issues.map((i) => i.id)).toEqual([critBug, lowBug]);
	});
});
