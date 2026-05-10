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

async function create(title: string, cwd: string): Promise<string> {
	const out = await runJson<{ id: string }>(["create", "--title", title], cwd);
	return out.id;
}

async function showExtensions(
	id: string,
	cwd: string,
): Promise<Record<string, unknown> | undefined> {
	const out = await runJson<{ issue: { extensions?: Record<string, unknown> } }>(["show", id], cwd);
	return out.issue.extensions;
}

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "seeds-update-test-"));
	await run(["init"], tmpDir);
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("sd update --extensions", () => {
	test("sets extensions on an issue with no prior extensions", async () => {
		const id = await create("ext-1", tmpDir);
		const { exitCode } = await run(
			["update", id, "--extensions", '{"role":"refactor-bot","queued":true}'],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		expect(await showExtensions(id, tmpDir)).toEqual({ role: "refactor-bot", queued: true });
	});

	test("shallow-merges new keys while preserving existing keys", async () => {
		const id = await create("ext-2", tmpDir);
		await run(["update", id, "--extensions", '{"role":"refactor-bot","attempts":1}'], tmpDir);
		await run(
			["update", id, "--extensions", '{"queued":true,"scheduledFor":"2026-05-12T03:00:00Z"}'],
			tmpDir,
		);
		expect(await showExtensions(id, tmpDir)).toEqual({
			role: "refactor-bot",
			attempts: 1,
			queued: true,
			scheduledFor: "2026-05-12T03:00:00Z",
		});
	});

	test("overwrites top-level keys without deep-merging nested values", async () => {
		const id = await create("ext-3", tmpDir);
		await run(["update", id, "--extensions", '{"lastRun":{"id":"run-a","ok":true}}'], tmpDir);
		await run(["update", id, "--extensions", '{"lastRun":{"id":"run-b"}}'], tmpDir);
		// Shallow merge: lastRun is overwritten wholesale, not deep-merged.
		expect(await showExtensions(id, tmpDir)).toEqual({ lastRun: { id: "run-b" } });
	});

	test("--clear-extensions removes the extensions field", async () => {
		const id = await create("ext-4", tmpDir);
		await run(["update", id, "--extensions", '{"role":"x"}'], tmpDir);
		expect(await showExtensions(id, tmpDir)).toEqual({ role: "x" });

		const { exitCode } = await run(["update", id, "--clear-extensions"], tmpDir);
		expect(exitCode).toBe(0);
		expect(await showExtensions(id, tmpDir)).toBeUndefined();
	});

	test("rejects malformed JSON with a clear error", async () => {
		const id = await create("ext-5", tmpDir);
		const { exitCode, stderr } = await run(["update", id, "--extensions", "{not json}"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("--extensions must be valid JSON");
	});

	test("rejects JSON arrays", async () => {
		const id = await create("ext-6", tmpDir);
		const { exitCode, stderr } = await run(["update", id, "--extensions", '["a","b"]'], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("must be a JSON object");
	});

	test("rejects JSON null", async () => {
		const id = await create("ext-7", tmpDir);
		const { exitCode, stderr } = await run(["update", id, "--extensions", "null"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("must be a JSON object");
	});

	test("rejects JSON scalar (string)", async () => {
		const id = await create("ext-8", tmpDir);
		const { exitCode, stderr } = await run(["update", id, "--extensions", '"hello"'], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("must be a JSON object");
	});

	test("rejects --extensions and --clear-extensions together", async () => {
		const id = await create("ext-9", tmpDir);
		const { exitCode, stderr } = await run(
			["update", id, "--extensions", "{}", "--clear-extensions"],
			tmpDir,
		);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("mutually exclusive");
	});

	test("--extensions does not touch other fields", async () => {
		const id = await create("ext-10", tmpDir);
		await run(["update", id, "--title", "renamed", "--assignee", "alice"], tmpDir);
		await run(["update", id, "--extensions", '{"role":"r"}'], tmpDir);
		const out = await runJson<{
			issue: { title: string; assignee?: string; extensions?: Record<string, unknown> };
		}>(["show", id], tmpDir);
		expect(out.issue.title).toBe("renamed");
		expect(out.issue.assignee).toBe("alice");
		expect(out.issue.extensions).toEqual({ role: "r" });
	});

	test("merging an empty object on undefined extensions leaves field absent", async () => {
		const id = await create("ext-11", tmpDir);
		await run(["update", id, "--extensions", "{}"], tmpDir);
		expect(await showExtensions(id, tmpDir)).toBeUndefined();
	});
});
