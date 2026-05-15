import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

const CLI = join(import.meta.dir, "../../src/index.ts");

async function run(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function initSeeds(cwd: string): Promise<void> {
	const { exitCode } = await run(["init"], cwd);
	expect(exitCode).toBe(0);
}

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "seeds-setup-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("sd setup", () => {
	test("fails outside a seeds project", async () => {
		const { exitCode, stderr } = await run(["setup", "--list"], tmpDir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Not in a seeds project");
	});

	test("--list runs cleanly inside a seeds project (no builtins yet)", async () => {
		await initSeeds(tmpDir);
		const { exitCode, stdout } = await run(["setup", "--list"], tmpDir);
		expect(exitCode).toBe(0);
		// No built-in recipes ship in step 1.
		expect(stdout).toContain("No providers available yet.");
	});

	test("--list --json emits structured providers array", async () => {
		await initSeeds(tmpDir);
		const { stdout, exitCode } = await run(["setup", "--list", "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as {
			success: boolean;
			action: string;
			providers: { name: string; source: string }[];
		};
		expect(result.success).toBe(true);
		expect(result.action).toBe("list");
		expect(Array.isArray(result.providers)).toBe(true);
	});

	test("no provider and no flags exits non-zero", async () => {
		await initSeeds(tmpDir);
		const { exitCode, stderr } = await run(["setup"], tmpDir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Specify a provider");
	});

	test("unknown provider exits non-zero with hint", async () => {
		await initSeeds(tmpDir);
		const { exitCode, stderr } = await run(["setup", "nope"], tmpDir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown provider");
		expect(stderr).toContain("--list");
	});

	test("unknown provider with --json returns structured error", async () => {
		await initSeeds(tmpDir);
		const { exitCode, stdout } = await run(["setup", "nope", "--json"], tmpDir);
		expect(exitCode).toBe(1);
		const result = JSON.parse(stdout) as { success: boolean; error: string };
		expect(result.success).toBe(false);
		expect(result.error).toContain("Unknown provider");
	});

	test("sd --help lists setup", async () => {
		const { stdout, exitCode } = await run(["--help"], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("setup");
	});
});
