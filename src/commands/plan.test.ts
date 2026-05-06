import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "seeds-plan-test-"));
	// Initialize a seeds project so plan commands have a target
	await run(["init"], tmpDir);
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("sd plan (parent)", () => {
	test("--help lists subcommands", async () => {
		const { stdout, exitCode } = await run(["plan", "--help"], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("templates");
	});

	test("no subcommand prints help and exits non-zero", async () => {
		const { exitCode } = await run(["plan"], tmpDir);
		expect(exitCode).not.toBe(0);
	});

	test("submit --help documents the plan file shape", async () => {
		const { stdout, exitCode } = await run(["plan", "submit", "--help"], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Plan file shape");
		expect(stdout).toContain('"template"');
		expect(stdout).toContain('"sections"');
		expect(stdout).toContain("plan_request wrapper");
	});

	test("prompt instructions explain the submit shape", async () => {
		const seedId = await createSeed(tmpDir, "Demo seed");
		const { stdout, exitCode } = await run(["plan", "prompt", seedId, "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { plan_request: { instructions: string } };
		expect(parsed.plan_request.instructions).toContain("plan_request wrapper");
		expect(parsed.plan_request.instructions).toContain("keyed by name");
	});
});

async function createSeed(cwd: string, title: string, type = "task"): Promise<string> {
	const { stdout } = await run(["create", "--title", title, "--type", type, "--json"], cwd);
	const parsed = JSON.parse(stdout) as { id: string };
	if (!parsed.id) throw new Error(`Could not parse created seed id from: ${stdout}`);
	return parsed.id;
}

const VALID_CONTEXT =
	"This work matters because we need to enable structured planning for AI agents using seeds.";

function validPlanFor(): {
	template: string;
	sections: Record<string, unknown>;
} {
	return {
		template: "feature",
		sections: {
			context: VALID_CONTEXT,
			approach: "Hardcoded TS template + AJV schema, mirroring mulch's custom_types.",
			alternatives: [],
			steps: [
				{ title: "Step A", type: "task", priority: 2, blocks: [] },
				{ title: "Step B", type: "task", priority: 2, blocks: [0] },
				{ title: "Step C", type: "task", priority: 2, blocks: [] },
				{ title: "Step D", type: "task", priority: 2, blocks: [2] },
			],
			risks: [],
			acceptance: ["End-to-end works"],
		},
	};
}

async function writePlanFile(cwd: string, plan: unknown): Promise<string> {
	const path = join(cwd, "plan.json");
	await Bun.write(path, JSON.stringify(plan));
	return path;
}

async function readJsonl<T>(path: string): Promise<T[]> {
	const text = await Bun.file(path).text();
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as T);
}

describe("sd plan templates", () => {
	test("human output lists feature template", async () => {
		const { stdout, exitCode } = await run(["plan", "templates"], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("feature");
	});

	test("--json emits structured output", async () => {
		const { stdout, exitCode } = await run(["plan", "templates", "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as {
			success: boolean;
			templates: Array<{ name: string; description: string }>;
			count: number;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.count).toBe(3);
		const names = parsed.templates.map((t) => t.name);
		expect(names).toEqual(["bug", "feature", "refactor"]);
		for (const t of parsed.templates) expect(t.description.length).toBeGreaterThan(0);
	});
});

describe("sd plan prompt", () => {
	test("--json emits the documented plan_request shape", async () => {
		const seedId = await createSeed(tmpDir, "Add OAuth login");
		const { stdout, exitCode } = await run(["plan", "prompt", seedId, "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as {
			plan_request: {
				seed: string;
				template: string;
				instructions: string;
				sections: Array<{
					name: string;
					required: boolean;
					kind: string;
					prompt: string;
					prior_art: unknown[];
					min_length?: number;
					min?: number;
				}>;
				validation: { all_required_present: boolean; min_steps: number; min_acceptance: number };
			};
		};
		const req = parsed.plan_request;
		expect(req.seed).toBe(seedId);
		expect(req.template).toBe("feature");
		expect(req.sections.length).toBe(6);
		const names = req.sections.map((s) => s.name);
		expect(names).toEqual(["context", "approach", "alternatives", "steps", "risks", "acceptance"]);
		const context = req.sections.find((s) => s.name === "context");
		expect(context?.required).toBe(true);
		expect(context?.min_length).toBe(50);
		expect(context?.prior_art).toEqual([]);
		expect(req.validation.min_steps).toBe(2);
		expect(req.validation.min_acceptance).toBe(1);
		expect(req.validation.all_required_present).toBe(true);
	});

	test("infers template feature from task type by default", async () => {
		const seedId = await createSeed(tmpDir, "A task", "task");
		const { stdout } = await run(["plan", "prompt", seedId, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string } };
		expect(parsed.plan_request.template).toBe("feature");
	});

	test("infers template feature from epic type by default", async () => {
		const seedId = await createSeed(tmpDir, "An epic", "epic");
		const { stdout } = await run(["plan", "prompt", seedId, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string } };
		expect(parsed.plan_request.template).toBe("feature");
	});

	test("--template feature is accepted explicitly", async () => {
		const seedId = await createSeed(tmpDir, "Feature with override");
		const { stdout, exitCode } = await run(
			["plan", "prompt", seedId, "--template", "feature", "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string } };
		expect(parsed.plan_request.template).toBe("feature");
	});

	test("--template <unknown> errors with available templates listed", async () => {
		const seedId = await createSeed(tmpDir, "x");
		const { stderr, exitCode } = await run(
			["plan", "prompt", seedId, "--template", "missing"],
			tmpDir,
		);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("missing");
		expect(stderr).toContain("feature");
	});

	test("unknown seed id errors cleanly", async () => {
		const { stderr, exitCode } = await run(["plan", "prompt", "nope-9999"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("not found");
	});

	test("human output renders readably", async () => {
		const seedId = await createSeed(tmpDir, "Readable plan");
		const { stdout, exitCode } = await run(["plan", "prompt", seedId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("context");
		expect(stdout).toContain("steps");
		expect(stdout).toContain("acceptance");
	});
});

describe("sd plan submit", () => {
	test("golden path: spawns children with correct blockedBy id remap", async () => {
		const seedId = await createSeed(tmpDir, "Parent for plan");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const { stdout, exitCode } = await run(
			["plan", "submit", seedId, "--plan", planPath, "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as {
			success: boolean;
			plan_id: string;
			children: string[];
			parent_seed: string;
		};
		expect(result.success).toBe(true);
		expect(result.children.length).toBe(4);
		expect(result.parent_seed).toBe(seedId);
		expect(result.plan_id.startsWith("pl-")).toBe(true);

		const issues = await readJsonl<{
			id: string;
			plan_id?: string;
			plan_step_index?: number;
			blockedBy?: string[];
			blocks?: string[];
		}>(join(tmpDir, ".seeds", "issues.jsonl"));

		const [aa01, aa02, aa03, aa04] = result.children;
		const child = (id?: string) => issues.find((i) => i.id === id);

		expect(child(aa01)?.plan_id).toBe(result.plan_id);
		expect(child(aa01)?.plan_step_index).toBe(0);
		expect(child(aa01)?.blockedBy ?? []).toEqual([]);

		expect(child(aa02)?.plan_step_index).toBe(1);
		expect(child(aa02)?.blockedBy).toEqual([aa01 ?? ""]);

		expect(child(aa03)?.plan_step_index).toBe(2);
		expect(child(aa03)?.blockedBy ?? []).toEqual([]);

		expect(child(aa04)?.plan_step_index).toBe(3);
		expect(child(aa04)?.blockedBy).toEqual([aa03 ?? ""]);

		// Parent: plan_id back-pointer + blockedBy includes all children
		const parent = child(seedId);
		expect(parent?.plan_id).toBe(result.plan_id);
		expect(parent?.blockedBy).toEqual(result.children);

		// plans.jsonl row written
		const plans = await readJsonl<{
			id: string;
			seed: string;
			template: string;
			status: string;
			revision: number;
			children: string[];
		}>(join(tmpDir, ".seeds", "plans.jsonl"));
		expect(plans.length).toBe(1);
		expect(plans[0]?.id).toBe(result.plan_id);
		expect(plans[0]?.seed).toBe(seedId);
		expect(plans[0]?.template).toBe("feature");
		expect(plans[0]?.status).toBe("approved");
		expect(plans[0]?.revision).toBe(1);
		expect(plans[0]?.children).toEqual(result.children);
	});

	test("validation failure emits partial-state diff to stderr; no writes", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const bad = validPlanFor();
		const { context: _omit, ...restSections } = bad.sections;
		const stripped = { ...bad, sections: restSections };
		const planPath = await writePlanFile(tmpDir, stripped);

		const issuesBefore = await readJsonl<unknown>(join(tmpDir, ".seeds", "issues.jsonl"));
		const plansBefore = await readJsonl<unknown>(join(tmpDir, ".seeds", "plans.jsonl"));

		const { stderr, stdout, exitCode } = await run(
			["plan", "submit", seedId, "--plan", planPath],
			tmpDir,
		);
		expect(exitCode).not.toBe(0);
		expect(stdout.trim()).toBe("");
		const diff = JSON.parse(stderr) as {
			errors: Array<{ path: string; code: string; fix: string }>;
			current: unknown;
		};
		expect(diff.errors.some((e) => e.path.endsWith("context") && e.code === "required")).toBe(true);
		expect(diff.current).toEqual(stripped);

		// No writes
		const issuesAfter = await readJsonl<unknown>(join(tmpDir, ".seeds", "issues.jsonl"));
		const plansAfter = await readJsonl<unknown>(join(tmpDir, ".seeds", "plans.jsonl"));
		expect(issuesAfter.length).toBe(issuesBefore.length);
		expect(plansAfter.length).toBe(plansBefore.length);
	});

	test("resubmit without --overwrite is rejected", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const { exitCode: first } = await run(["plan", "submit", seedId, "--plan", planPath], tmpDir);
		expect(first).toBe(0);
		const { stderr, exitCode: second } = await run(
			["plan", "submit", seedId, "--plan", planPath],
			tmpDir,
		);
		expect(second).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("already exists");
	});

	test("--plan - reads from stdin", async () => {
		const seedId = await createSeed(tmpDir, "Stdin parent");
		const proc = Bun.spawn(["bun", "run", CLI, "plan", "submit", seedId, "--plan", "-", "--json"], {
			cwd: tmpDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.stdin.write(JSON.stringify(validPlanFor()));
		await proc.stdin.end();
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { success: boolean; children: string[] };
		expect(result.success).toBe(true);
		expect(result.children.length).toBe(4);
	});

	test("unknown seed errors cleanly", async () => {
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const { stderr, exitCode } = await run(
			["plan", "submit", "nope-9999", "--plan", planPath],
			tmpDir,
		);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("not found");
	});
});

describe("sd plan submit --overwrite", () => {
	async function readIssue(id: string): Promise<{
		id: string;
		title: string;
		status: string;
		blockedBy?: string[];
	}> {
		const issues = await readJsonl<{
			id: string;
			title: string;
			status: string;
			blockedBy?: string[];
		}>(join(tmpDir, ".seeds/issues.jsonl"));
		const found = issues.find((i) => i.id === id);
		if (!found) throw new Error(`issue not found: ${id}`);
		return found;
	}

	async function readPlanRow(planId: string): Promise<{
		id: string;
		revision: number;
		children: string[];
		sections: Record<string, unknown>;
	}> {
		const plans = await readJsonl<{
			id: string;
			revision: number;
			children: string[];
			sections: Record<string, unknown>;
		}>(join(tmpDir, ".seeds/plans.jsonl"));
		const found = plans.find((p) => p.id === planId);
		if (!found) throw new Error(`plan not found: ${planId}`);
		return found;
	}

	test("rejects re-submit without --overwrite (exit 1, expected stderr format)", async () => {
		const seedId = await createSeed(tmpDir, "Re-plan target");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);

		const second = await run(["plan", "submit", seedId, "--plan", planPath], tmpDir);
		expect(second.exitCode).not.toBe(0);
		expect(second.stderr).toMatch(/already exists for /);
		expect(second.stderr).toMatch(/Use --overwrite to replace it/);
	});

	test("--overwrite rewrites the plan row in place and bumps revision", async () => {
		const seedId = await createSeed(tmpDir, "Re-plan target");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstParsed = JSON.parse(first.stdout) as { plan_id: string; children: string[] };
		const planId = firstParsed.plan_id;

		const v2 = validPlanFor();
		const planPath2 = await writePlanFile(tmpDir, v2);
		const overwriteResult = await run(
			["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"],
			tmpDir,
		);
		expect(overwriteResult.exitCode).toBe(0);
		const parsed = JSON.parse(overwriteResult.stdout) as {
			plan_id: string;
			revision: number;
			overwritten: boolean;
			children: string[];
			obsolete: string[];
		};
		expect(parsed.plan_id).toBe(planId);
		expect(parsed.revision).toBe(2);
		expect(parsed.overwritten).toBe(true);

		// One row in plans.jsonl, revision=2.
		const plans = await readJsonl<{ id: string; revision: number }>(
			join(tmpDir, ".seeds/plans.jsonl"),
		);
		expect(plans.filter((p) => p.id === planId).length).toBe(1);
		expect(plans.find((p) => p.id === planId)?.revision).toBe(2);
	});

	test("revision increments on each overwrite (1 → 2 → 3)", async () => {
		const seedId = await createSeed(tmpDir, "Multi-rev");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const planId = (JSON.parse(first.stdout) as { plan_id: string }).plan_id;

		await run(["plan", "submit", seedId, "--plan", planPath, "--overwrite", "--json"], tmpDir);
		await run(["plan", "submit", seedId, "--plan", planPath, "--overwrite", "--json"], tmpDir);

		const row = await readPlanRow(planId);
		expect(row.revision).toBe(3);
	});

	test("matched steps keep the same child IDs across overwrites", async () => {
		const seedId = await createSeed(tmpDir, "Stable IDs");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstChildren = (JSON.parse(first.stdout) as { children: string[] }).children;

		const overwriteResult = await run(
			["plan", "submit", seedId, "--plan", planPath, "--overwrite", "--json"],
			tmpDir,
		);
		const secondChildren = (JSON.parse(overwriteResult.stdout) as { children: string[] }).children;
		expect(secondChildren).toEqual(firstChildren);
	});

	test("obsolete children are listed on stderr and not auto-closed", async () => {
		const seedId = await createSeed(tmpDir, "With obsolete");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstResult = JSON.parse(first.stdout) as {
			plan_id: string;
			children: string[];
		};

		// Drop the last two steps in the new plan
		const v2 = validPlanFor();
		v2.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [] },
			{ title: "Step B", type: "task", priority: 2, blocks: [0] },
		];
		const planPath2 = await writePlanFile(tmpDir, v2);
		const overwriteResult = await run(
			["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"],
			tmpDir,
		);
		expect(overwriteResult.exitCode).toBe(0);
		const parsed = JSON.parse(overwriteResult.stdout) as {
			plan_id: string;
			children: string[];
			obsolete: string[];
		};

		const obsoleteIds = firstResult.children.slice(2);
		expect(parsed.obsolete.sort()).toEqual([...obsoleteIds].sort());

		// Stderr suggestion lines
		for (const id of obsoleteIds) {
			expect(overwriteResult.stderr).toContain(
				`sd close ${id} --reason "obsoleted by plan ${firstResult.plan_id} revision 2"`,
			);
		}

		// Obsolete children stay open
		for (const id of obsoleteIds) {
			const issue = await readIssue(id);
			expect(issue.status).toBe("open");
		}
	});

	test("new steps spawn fresh children with proper blockedBy and plan_id", async () => {
		const seedId = await createSeed(tmpDir, "Spawn new");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstResult = JSON.parse(first.stdout) as { plan_id: string; children: string[] };

		const v2 = validPlanFor();
		v2.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [] },
			{ title: "Step B", type: "task", priority: 2, blocks: [0] },
			{ title: "Brand New Step", type: "task", priority: 2, blocks: [1] },
		];
		const planPath2 = await writePlanFile(tmpDir, v2);
		const overwriteResult = await run(
			["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"],
			tmpDir,
		);
		const parsed = JSON.parse(overwriteResult.stdout) as {
			plan_id: string;
			children: string[];
		};

		// First two children preserved, third is newly spawned
		expect(parsed.children[0]).toBe(firstResult.children[0]);
		expect(parsed.children[1]).toBe(firstResult.children[1]);
		const newChildId = parsed.children[2];
		expect(newChildId).toBeDefined();
		if (!newChildId) return;
		expect(firstResult.children).not.toContain(newChildId);

		const newIssue = await readJsonl<{
			id: string;
			title: string;
			plan_id?: string;
			blockedBy?: string[];
		}>(join(tmpDir, ".seeds/issues.jsonl"));
		const spawned = newIssue.find((i) => i.id === newChildId);
		expect(spawned?.title).toBe("Brand New Step");
		expect(spawned?.plan_id).toBe(firstResult.plan_id);
		expect(spawned?.blockedBy).toEqual([firstResult.children[1] ?? ""]);
	});

	test("parent.blockedBy drops obsolete children and reflects the new plan", async () => {
		const seedId = await createSeed(tmpDir, "Parent blockers");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstChildren = (JSON.parse(first.stdout) as { children: string[] }).children;

		// New plan keeps Step A & Step B (matched by title), drops C and D.
		const v2 = validPlanFor();
		v2.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [] },
			{ title: "Step B", type: "task", priority: 2, blocks: [0] },
		];
		const planPath2 = await writePlanFile(tmpDir, v2);
		const overwriteResult = await run(
			["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"],
			tmpDir,
		);
		const parsed = JSON.parse(overwriteResult.stdout) as { children: string[] };

		const parent = await readIssue(seedId);
		expect(parent.blockedBy).toEqual(parsed.children);
		// Confirm we actually dropped the old C and D.
		expect(parent.blockedBy).not.toContain(firstChildren[2] ?? "");
		expect(parent.blockedBy).not.toContain(firstChildren[3] ?? "");
	});

	test("validation failure on overwrite leaves the prior plan untouched", async () => {
		const seedId = await createSeed(tmpDir, "No clobber");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const planId = (JSON.parse(first.stdout) as { plan_id: string }).plan_id;
		const beforeRow = await readPlanRow(planId);

		const v2 = validPlanFor();
		// Force validation failure: only 1 step (min 2)
		v2.sections.steps = [{ title: "only one", type: "task", priority: 2, blocks: [] }];
		const badPath = await writePlanFile(tmpDir, v2);
		const overwriteResult = await run(
			["plan", "submit", seedId, "--plan", badPath, "--overwrite"],
			tmpDir,
		);
		expect(overwriteResult.exitCode).not.toBe(0);

		const afterRow = await readPlanRow(planId);
		expect(afterRow.revision).toBe(beforeRow.revision);
		expect(afterRow.children).toEqual(beforeRow.children);
	});
});

describe("sd plan show", () => {
	test("--json emits plan + child summaries", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const submitResult = JSON.parse(submit.stdout) as { plan_id: string; children: string[] };

		const { stdout, exitCode } = await run(
			["plan", "show", submitResult.plan_id, "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as {
			plan: {
				id: string;
				status: string;
				revision: number;
				children: string[];
				reviewedBy?: string;
			};
			children: Array<{ id: string; title: string; status: string }>;
		};
		expect(result.plan.id).toBe(submitResult.plan_id);
		expect(result.plan.status).toBe("approved");
		expect(result.plan.revision).toBe(1);
		expect(result.children.length).toBe(4);
		expect(result.children[0]?.title).toBe("Step A");
		expect(result.children[0]?.status).toBe("open");
	});

	test("human output renders with review hint", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const planId = (JSON.parse(submit.stdout) as { plan_id: string }).plan_id;
		const { stdout, exitCode } = await run(["plan", "show", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(planId);
		expect(stdout).toContain("approved");
		expect(stdout).toContain("Review suggested");
		expect(stdout).toContain("Step A");
	});

	test("unknown plan id errors cleanly", async () => {
		const { stderr, exitCode } = await run(["plan", "show", "pl-9999"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("not found");
	});
});

describe("sd plan show: structured list rendering (seeds-7d17)", () => {
	async function submitPlan(plan: unknown): Promise<string> {
		const seedId = await createSeed(tmpDir, "Renderer parent", "feature");
		const planPath = await writePlanFile(tmpDir, plan);
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		return (JSON.parse(submit.stdout) as { plan_id: string }).plan_id;
	}

	test("steps render titles directly with annotated sub-lines", async () => {
		const plan = {
			template: "feature",
			sections: {
				context: VALID_CONTEXT,
				approach: "Render structured steps in a human-readable way.",
				alternatives: [],
				steps: [
					{ title: "Plain step", type: "task", priority: 2, blocks: [] },
					{ title: "Blocked step", type: "task", priority: 2, blocks: [0] },
					{
						title: "Pre-planned step",
						type: "task",
						priority: 2,
						blocks: [],
						requires_plan: true,
						plan_template: "feature",
					},
				],
				risks: [],
				acceptance: ["End-to-end works"],
			},
		};
		const planId = await submitPlan(plan);
		const { stdout, exitCode } = await run(["plan", "show", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("1. Plain step");
		expect(stdout).toContain("2. Blocked step");
		expect(stdout).toContain("blocks: 1");
		expect(stdout).toContain("3. Pre-planned step");
		expect(stdout).toContain("requires_plan: true");
		expect(stdout).toContain("plan_template: feature");
		expect(stdout).not.toContain('{"title":"Plain step"');
		expect(stdout).not.toContain('"requires_plan":true');
	});

	test("alternatives render named fields per item", async () => {
		const plan = {
			template: "feature",
			sections: {
				context: VALID_CONTEXT,
				approach: "Render list-with-item-schema sections.",
				alternatives: [
					{ name: "Personal access tokens", rejected_because: "Plaintext storage" },
					{ name: "Basic auth", rejected_because: "No revocation" },
				],
				steps: [
					{ title: "Step one", type: "task", priority: 2, blocks: [] },
					{ title: "Step two", type: "task", priority: 2, blocks: [] },
				],
				risks: [],
				acceptance: ["Works"],
			},
		};
		const planId = await submitPlan(plan);
		const { stdout, exitCode } = await run(["plan", "show", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("1. name: Personal access tokens");
		expect(stdout).toContain("rejected_because: Plaintext storage");
		expect(stdout).toContain("2. name: Basic auth");
		expect(stdout).toContain("rejected_because: No revocation");
		expect(stdout).not.toContain('{"name":"Personal access tokens"');
	});

	test("custom templates with declared item schemas render through the same path", async () => {
		const cfgPath = join(tmpDir, ".seeds", "config.yaml");
		const existing = await Bun.file(cfgPath).text();
		const customBlock = [
			"plan_templates:",
			"  custom:",
			"    sections:",
			"      context:",
			"        required: true",
			"        kind: text",
			"        prompt: why",
			"      decisions:",
			"        required: true",
			"        kind: list",
			"        prompt: choices",
			"        item:",
			"          choice:",
			"            required: true",
			"            kind: text",
			"            prompt: ''",
			"          rationale:",
			"            required: true",
			"            kind: text",
			"            prompt: ''",
			"      steps:",
			"        required: true",
			"        kind: steps",
			"        min: 1",
			"        prompt: do work",
			"      acceptance:",
			"        required: true",
			"        kind: list",
			"        item: text",
			"        min: 1",
			"        prompt: done",
			"",
		].join("\n");
		await Bun.write(cfgPath, `${existing.trimEnd()}\n${customBlock}`);

		const plan = {
			template: "custom",
			sections: {
				context: "Custom-template context line that meets the prompt.",
				decisions: [{ choice: "Build it", rationale: "Cheaper than buying" }],
				steps: [{ title: "Lone step", type: "task", priority: 2, blocks: [] }],
				acceptance: ["Done"],
			},
		};
		const planId = await submitPlan(plan);
		const { stdout, exitCode } = await run(["plan", "show", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("1. choice: Build it");
		expect(stdout).toContain("rationale: Cheaper than buying");
		expect(stdout).toContain("1. Lone step");
		expect(stdout).not.toContain('{"choice":"Build it"');
	});

	test("plans whose template is no longer registered fall back to JSON dump", async () => {
		const plan = {
			template: "feature",
			sections: {
				context: VALID_CONTEXT,
				approach: "Verify graceful fallback.",
				alternatives: [{ name: "Some alt", rejected_because: "Not picked" }],
				steps: [
					{ title: "Only step", type: "task", priority: 2, blocks: [] },
					{ title: "Second step", type: "task", priority: 2, blocks: [] },
				],
				risks: [],
				acceptance: ["Works"],
			},
		};
		const planId = await submitPlan(plan);

		const plansPath = join(tmpDir, ".seeds", "plans.jsonl");
		const text = await Bun.file(plansPath).text();
		const rewritten = text
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const row = JSON.parse(l) as { id: string; template: string };
				if (row.id === planId) row.template = "no-such-template";
				return JSON.stringify(row);
			})
			.join("\n");
		await Bun.write(plansPath, `${rewritten}\n`);

		const { stdout, exitCode } = await run(["plan", "show", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('{"name":"Some alt"');
		expect(stdout).toContain('{"title":"Only step"');
	});
});

describe("sd plan show: recursive nesting (Phase 4 / PLAN_SPEC.md:340, 425, 430)", () => {
	async function setMaxDepth(n: number): Promise<void> {
		const cfgPath = join(tmpDir, ".seeds", "config.yaml");
		const text = await Bun.file(cfgPath).text();
		const lines = text.split("\n").filter((l) => !l.startsWith("max_plan_depth:"));
		await Bun.write(cfgPath, `${lines.join("\n").trimEnd()}\nmax_plan_depth: ${n}\n`);
	}

	function planWithSubPlanStep(): { template: string; sections: Record<string, unknown> } {
		const base = validPlanFor();
		base.sections.steps = [
			{ title: "Sub-plan epic", type: "epic", priority: 1, plan_template: "feature" },
			{ title: "Plain task", type: "task", priority: 2, blocks: [0] },
		];
		return base;
	}

	test("depth-1 plan with no nested children renders unchanged (regression)", async () => {
		const seedId = await createSeed(tmpDir, "Solo");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const planId = (JSON.parse(submit.stdout) as { plan_id: string }).plan_id;

		const { stdout, exitCode } = await run(["plan", "show", planId, "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as {
			plan: { id: string };
			children: Array<{ id: string }>;
			children_plans: unknown[];
		};
		expect(parsed.plan.id).toBe(planId);
		expect(parsed.children.length).toBe(4);
		expect(parsed.children_plans).toEqual([]);
	});

	test("depth-2: nested plan appears in children_plans (JSON) and indented in human", async () => {
		const seedId = await createSeed(tmpDir, "Root parent");
		const rootPath = await writePlanFile(tmpDir, planWithSubPlanStep());
		const rootSubmit = await run(["plan", "submit", seedId, "--plan", rootPath, "--json"], tmpDir);
		const rootResult = JSON.parse(rootSubmit.stdout) as { plan_id: string; children: string[] };
		const childWithSubPlan = rootResult.children[0];
		expect(childWithSubPlan).toBeDefined();
		if (!childWithSubPlan) return;

		// Submit a sub-plan for the requires_plan child.
		const subPath = await writePlanFile(tmpDir, validPlanFor());
		const subSubmit = await run(
			["plan", "submit", childWithSubPlan, "--plan", subPath, "--json"],
			tmpDir,
		);
		const subPlanId = (JSON.parse(subSubmit.stdout) as { plan_id: string }).plan_id;

		// JSON form: nested plan appears under children_plans.
		const { stdout } = await run(["plan", "show", rootResult.plan_id, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as {
			plan: { id: string };
			children_plans: Array<{ plan?: { id: string }; truncated?: boolean }>;
		};
		expect(parsed.children_plans.length).toBe(1);
		const nested = parsed.children_plans[0];
		expect(nested?.truncated).toBeFalsy();
		expect(nested?.plan?.id).toBe(subPlanId);

		// Human form: nested plan id appears with indentation.
		const human = await run(["plan", "show", rootResult.plan_id], tmpDir);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain(subPlanId);
		expect(human.stdout).toContain("Sub-plan:");
	});

	test("max_plan_depth: 1 truncates immediately with the documented hint", async () => {
		await setMaxDepth(1);
		const seedId = await createSeed(tmpDir, "Truncation root");
		const rootPath = await writePlanFile(tmpDir, planWithSubPlanStep());
		const rootSubmit = await run(["plan", "submit", seedId, "--plan", rootPath, "--json"], tmpDir);
		const rootResult = JSON.parse(rootSubmit.stdout) as { plan_id: string; children: string[] };
		const childWithSubPlan = rootResult.children[0];
		if (!childWithSubPlan) throw new Error("missing first child");

		const subPath = await writePlanFile(tmpDir, validPlanFor());
		const subSubmit = await run(
			["plan", "submit", childWithSubPlan, "--plan", subPath, "--json"],
			tmpDir,
		);
		const subPlanId = (JSON.parse(subSubmit.stdout) as { plan_id: string }).plan_id;

		// JSON: at depth 1 the nested entry is truncated.
		const { stdout } = await run(["plan", "show", rootResult.plan_id, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as {
			children_plans: Array<{ plan_id?: string; truncated?: boolean; hint?: string }>;
		};
		expect(parsed.children_plans.length).toBe(1);
		const truncated = parsed.children_plans[0];
		expect(truncated?.truncated).toBe(true);
		expect(truncated?.plan_id).toBe(subPlanId);
		expect(truncated?.hint).toBe(
			`depth limit reached — use \`sd plan show ${subPlanId}\` to drill in`,
		);

		// Human: hint string appears once.
		const human = await run(["plan", "show", rootResult.plan_id], tmpDir);
		const occurrences = human.stdout.split(`sd plan show ${subPlanId}`).length - 1;
		expect(occurrences).toBe(1);
		expect(human.stdout).toContain("depth limit reached");
	});

	test("max_plan_depth: 2 with depth-3 nesting truncates only the third level", async () => {
		await setMaxDepth(2);
		// Build A → B → C nesting using plan_template at each level.
		const rootSeed = await createSeed(tmpDir, "Level 1 seed");
		const rootPath = await writePlanFile(tmpDir, planWithSubPlanStep());
		const rootSubmit = await run(
			["plan", "submit", rootSeed, "--plan", rootPath, "--json"],
			tmpDir,
		);
		const rootResult = JSON.parse(rootSubmit.stdout) as { plan_id: string; children: string[] };
		const level2Seed = rootResult.children[0];
		if (!level2Seed) throw new Error("level2 seed missing");

		const level2Path = await writePlanFile(tmpDir, planWithSubPlanStep());
		const level2Submit = await run(
			["plan", "submit", level2Seed, "--plan", level2Path, "--json"],
			tmpDir,
		);
		const level2Result = JSON.parse(level2Submit.stdout) as {
			plan_id: string;
			children: string[];
		};
		const level3Seed = level2Result.children[0];
		if (!level3Seed) throw new Error("level3 seed missing");

		const level3Path = await writePlanFile(tmpDir, validPlanFor());
		const level3Submit = await run(
			["plan", "submit", level3Seed, "--plan", level3Path, "--json"],
			tmpDir,
		);
		const level3PlanId = (JSON.parse(level3Submit.stdout) as { plan_id: string }).plan_id;

		const { stdout } = await run(["plan", "show", rootResult.plan_id, "--json"], tmpDir);
		type Entry = {
			plan?: { id: string };
			children_plans?: Entry[];
			truncated?: boolean;
			hint?: string;
			plan_id?: string;
		};
		const parsed = JSON.parse(stdout) as { children_plans: Entry[] };

		// Level 2 fully rendered; level 3 truncated.
		expect(parsed.children_plans.length).toBe(1);
		const lvl2 = parsed.children_plans[0];
		expect(lvl2?.truncated).toBeFalsy();
		expect(lvl2?.plan?.id).toBe(level2Result.plan_id);
		expect(lvl2?.children_plans?.length).toBe(1);
		const lvl3 = lvl2?.children_plans?.[0];
		expect(lvl3?.truncated).toBe(true);
		expect(lvl3?.plan_id).toBe(level3PlanId);
		expect(lvl3?.hint).toContain(level3PlanId);
		expect(lvl3?.hint).toContain("depth limit reached");
	});
});

describe("sd plan list", () => {
	async function submitPlan(seedTitle: string): Promise<{ planId: string; seedId: string }> {
		const seedId = await createSeed(tmpDir, seedTitle);
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const { stdout } = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const planId = (JSON.parse(stdout) as { plan_id: string }).plan_id;
		return { planId, seedId };
	}

	test("--json on empty store returns empty array", async () => {
		const { stdout, exitCode } = await run(["plan", "list", "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { plans: unknown[]; count: number };
		expect(result.plans).toEqual([]);
		expect(result.count).toBe(0);
	});

	test("--json lists submitted plans", async () => {
		await submitPlan("First");
		await submitPlan("Second");
		const { stdout } = await run(["plan", "list", "--json"], tmpDir);
		const result = JSON.parse(stdout) as { count: number };
		expect(result.count).toBe(2);
	});

	test("--seed filters to that parent's plans", async () => {
		const a = await submitPlan("Plan A");
		await submitPlan("Plan B");
		const { stdout } = await run(["plan", "list", "--seed", a.seedId, "--json"], tmpDir);
		const result = JSON.parse(stdout) as { plans: Array<{ id: string; seed: string }> };
		expect(result.plans.length).toBe(1);
		expect(result.plans[0]?.seed).toBe(a.seedId);
	});

	test("--status approved matches submitted plans", async () => {
		await submitPlan("Plan X");
		const { stdout } = await run(["plan", "list", "--status", "approved", "--json"], tmpDir);
		const result = JSON.parse(stdout) as { plans: Array<{ status: string }> };
		expect(result.plans.length).toBeGreaterThan(0);
		expect(result.plans.every((p) => p.status === "approved")).toBe(true);
	});

	test("--status draft returns empty when only approved plans exist", async () => {
		await submitPlan("Plan Y");
		const { stdout } = await run(["plan", "list", "--status", "draft", "--json"], tmpDir);
		const result = JSON.parse(stdout) as { plans: unknown[] };
		expect(result.plans).toEqual([]);
	});

	test("--template feature matches", async () => {
		await submitPlan("T1");
		const { stdout } = await run(["plan", "list", "--template", "feature", "--json"], tmpDir);
		const result = JSON.parse(stdout) as { count: number };
		expect(result.count).toBeGreaterThan(0);
	});

	test("--outcome success returns empty when no outcome was set", async () => {
		await submitPlan("Z");
		const { stdout } = await run(["plan", "list", "--outcome", "success", "--json"], tmpDir);
		const result = JSON.parse(stdout) as { plans: unknown[] };
		expect(result.plans).toEqual([]);
	});

	test("combined filters: --seed + --status", async () => {
		const a = await submitPlan("Combo A");
		await submitPlan("Combo B");
		const { stdout } = await run(
			["plan", "list", "--seed", a.seedId, "--status", "approved", "--json"],
			tmpDir,
		);
		const result = JSON.parse(stdout) as { plans: Array<{ id: string }> };
		expect(result.plans.length).toBe(1);
		expect(result.plans[0]?.id).toBe(a.planId);
	});

	test("invalid --status errors cleanly", async () => {
		const { stderr, exitCode } = await run(["plan", "list", "--status", "bogus"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("--status");
	});

	test("human output shows the plan id", async () => {
		const { planId } = await submitPlan("Human");
		const { stdout, exitCode } = await run(["plan", "list"], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(planId);
	});
});

describe("sd plan submit: step.plan_template (Phase 4 / PLAN_SPEC.md:329-342)", () => {
	function planWithSubPlanStep(): { template: string; sections: Record<string, unknown> } {
		const base = validPlanFor();
		base.sections.steps = [
			{ title: "OAuth integration", type: "epic", priority: 1, plan_template: "feature" },
			{ title: "Wire UI", type: "task", priority: 2, blocks: [0] },
		];
		return base;
	}

	test("step with plan_template spawns child with requires_plan and no plan_id", async () => {
		const seedId = await createSeed(tmpDir, "Parent with sub-plan step");
		const planPath = await writePlanFile(tmpDir, planWithSubPlanStep());
		const { stdout, exitCode } = await run(
			["plan", "submit", seedId, "--plan", planPath, "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { plan_id: string; children: string[] };

		const issues = await readJsonl<{
			id: string;
			plan_id?: string;
			plan_step_index?: number;
			requires_plan?: boolean;
		}>(join(tmpDir, ".seeds", "issues.jsonl"));

		const subPlanChild = issues.find((i) => i.id === result.children[0]);
		const plainChild = issues.find((i) => i.id === result.children[1]);

		expect(subPlanChild?.requires_plan).toBe(true);
		expect(subPlanChild?.plan_id).toBeUndefined();
		expect(subPlanChild?.plan_step_index).toBe(0);

		// Sibling without plan_template is unchanged: plan_id back-link, no flag.
		expect(plainChild?.requires_plan).toBeUndefined();
		expect(plainChild?.plan_id).toBe(result.plan_id);
	});

	test("requires_plan child is hidden from sd ready (composes with Task 1)", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const planPath = await writePlanFile(tmpDir, planWithSubPlanStep());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const childIds = (JSON.parse(submit.stdout) as { children: string[] }).children;
		const subPlanChild = childIds[0];

		const { stdout: readyJson } = await run(["ready", "--json"], tmpDir);
		const ready = JSON.parse(readyJson) as { issues: Array<{ id: string }> };
		expect(ready.issues.some((i) => i.id === subPlanChild)).toBe(false);
	});

	test("sd plan prompt on the spawned child inherits plan_template from parent step", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const planPath = await writePlanFile(tmpDir, planWithSubPlanStep());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const childId = (JSON.parse(submit.stdout) as { children: string[] }).children[0];
		expect(childId).toBeDefined();
		if (!childId) return;

		const { stdout, exitCode } = await run(["plan", "prompt", childId, "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string; seed: string } };
		expect(parsed.plan_request.seed).toBe(childId);
		expect(parsed.plan_request.template).toBe("feature");
	});

	test("unknown plan_template name fails submit with a clear stderr message", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const bad = validPlanFor();
		bad.sections.steps = [
			{ title: "First step", type: "task", priority: 2 },
			{
				title: "Bad sub-plan ref",
				type: "epic",
				priority: 1,
				plan_template: "nonexistent",
			},
		];
		const planPath = await writePlanFile(tmpDir, bad);
		const { stderr, stdout, exitCode } = await run(
			["plan", "submit", seedId, "--plan", planPath],
			tmpDir,
		);
		expect(exitCode).not.toBe(0);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("nonexistent");
		expect(stderr).toContain("plan_templates");
		expect(stderr).toContain("Bad sub-plan ref");

		// No writes — plans.jsonl stays empty.
		const planRows = await readJsonl<unknown>(join(tmpDir, ".seeds/plans.jsonl"));
		expect(planRows.length).toBe(0);
	});
});

describe("sd plan validate", () => {
	async function submitOne(): Promise<string> {
		const seedId = await createSeed(tmpDir, "Parent for validate");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const { stdout } = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		return (JSON.parse(stdout) as { plan_id: string }).plan_id;
	}

	test("valid plan passes (--json)", async () => {
		const planId = await submitOne();
		const { stdout, exitCode } = await run(["plan", "validate", planId, "--json"], tmpDir);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { valid: boolean; plan_id: string };
		expect(result.valid).toBe(true);
		expect(result.plan_id).toBe(planId);
	});

	test("valid plan passes (human)", async () => {
		const planId = await submitOne();
		const { stdout, exitCode } = await run(["plan", "validate", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(planId);
		expect(stdout.toLowerCase()).toContain("valid");
	});

	test("tampered plan emits partial-state diff to stderr", async () => {
		const planId = await submitOne();
		// Tamper: rewrite plans.jsonl removing acceptance from the only plan
		const path = join(tmpDir, ".seeds", "plans.jsonl");
		const text = await Bun.file(path).text();
		const lines = text.split("\n").filter((l) => l.trim());
		const planRow = JSON.parse(lines[0] ?? "{}");
		const { acceptance: _omit, ...restSections } = planRow.sections;
		const tampered = { ...planRow, sections: restSections };
		await Bun.write(path, `${JSON.stringify(tampered)}\n`);

		const { stderr, stdout, exitCode } = await run(["plan", "validate", planId], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stdout.trim()).toBe("");
		const diff = JSON.parse(stderr) as {
			errors: Array<{ path: string; code: string; fix: string }>;
			current: unknown;
		};
		expect(diff.errors.length).toBeGreaterThan(0);
		expect(diff.errors.some((e) => e.path.endsWith("acceptance") && e.code === "required")).toBe(
			true,
		);
	});

	test("unknown plan id errors cleanly", async () => {
		const { stderr, exitCode } = await run(["plan", "validate", "pl-9999"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("not found");
	});
});

describe("plan-awareness integration: ready / show / list", () => {
	async function injectDraftPlan(seedId: string, planId = "pl-d001"): Promise<void> {
		// Phase 1's submit always writes `approved`. To exercise the draft-plan
		// surface area in ready/show/list we hand-write a draft row, which is
		// what Phase 2's prompt+approval workflow will produce naturally.
		const now = new Date().toISOString();
		const planRow = {
			id: planId,
			seed: seedId,
			template: "feature",
			status: "draft",
			revision: 1,
			sections: {},
			children: [],
			createdAt: now,
			updatedAt: now,
		};
		const planPath = join(tmpDir, ".seeds", "plans.jsonl");
		const existing = await Bun.file(planPath).text();
		await Bun.write(
			planPath,
			`${existing.trim() ? `${existing.trimEnd()}\n` : ""}${JSON.stringify(planRow)}\n`,
		);

		// Set plan_id on the seed so plan-context lookup matches.
		const issuesPath = join(tmpDir, ".seeds", "issues.jsonl");
		const issuesText = await Bun.file(issuesPath).text();
		const lines = issuesText.split("\n").filter((l) => l.trim());
		const updated = lines.map((l) => {
			const obj = JSON.parse(l) as { id: string; [k: string]: unknown };
			if (obj.id === seedId) obj.plan_id = planId;
			return JSON.stringify(obj);
		});
		await Bun.write(issuesPath, `${updated.join("\n")}\n`);
	}

	test("sd ready surfaces a seed with a draft plan and shows the hint", async () => {
		const seedId = await createSeed(tmpDir, "Needs planning");
		await injectDraftPlan(seedId);
		const { stdout: human, exitCode } = await run(["ready"], tmpDir);
		expect(exitCode).toBe(0);
		expect(human).toContain(seedId);
		expect(human).toContain("plan in draft");

		const { stdout: jsonOut } = await run(["ready", "--json"], tmpDir);
		const result = JSON.parse(jsonOut) as {
			issues: Array<{ id: string; plan_status?: string }>;
		};
		const found = result.issues.find((i) => i.id === seedId);
		expect(found?.plan_status).toBe("draft");
	});

	test("sd ready surfaces draft-plan seed even when blocked", async () => {
		const blocker = await createSeed(tmpDir, "Blocker");
		const seedId = await createSeed(tmpDir, "Blocked but planning");
		await run(["dep", "add", seedId, blocker], tmpDir);
		await injectDraftPlan(seedId);
		const { stdout: jsonOut } = await run(["ready", "--json"], tmpDir);
		const result = JSON.parse(jsonOut) as { issues: Array<{ id: string }> };
		expect(result.issues.some((i) => i.id === seedId)).toBe(true);
	});

	test("sd show displays children inline for an approved plan", async () => {
		const seedId = await createSeed(tmpDir, "Parent");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const submitResult = JSON.parse(submit.stdout) as { plan_id: string; children: string[] };

		const { stdout: human, exitCode } = await run(["show", seedId], tmpDir);
		expect(exitCode).toBe(0);
		expect(human).toContain(submitResult.plan_id);
		expect(human).toContain("approved");
		// At least the first child id should appear inline
		expect(human).toContain(submitResult.children[0] ?? "");

		const { stdout: jsonOut } = await run(["show", seedId, "--json"], tmpDir);
		const result = JSON.parse(jsonOut) as {
			issue: { id: string };
			plan?: { id: string; status: string; children: string[] };
			plan_children?: Array<{ id: string; title: string; status: string }>;
		};
		expect(result.plan?.id).toBe(submitResult.plan_id);
		expect(result.plan?.status).toBe("approved");
		expect(result.plan_children?.length).toBe(4);
	});

	test("sd show displays draft hint when plan is in draft", async () => {
		const seedId = await createSeed(tmpDir, "Drafter");
		await injectDraftPlan(seedId);
		const { stdout, exitCode } = await run(["show", seedId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("plan in draft");
	});

	test("sd list shows a plan status indicator for seeds with plans", async () => {
		const planSeed = await createSeed(tmpDir, "Has plan");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		await run(["plan", "submit", planSeed, "--plan", planPath, "--json"], tmpDir);

		const { stdout: human } = await run(["list"], tmpDir);
		expect(human).toContain("[plan approved]");

		const { stdout: jsonOut } = await run(["list", "--json"], tmpDir);
		const result = JSON.parse(jsonOut) as {
			issues: Array<{ id: string; plan_status?: string; plan_children?: string[] }>;
		};
		const parent = result.issues.find((i) => i.id === planSeed);
		expect(parent?.plan_status).toBe("approved");
		expect(parent?.plan_children?.length).toBe(4);
	});

	test("seeds without plans render exactly as before (regression)", async () => {
		const seedId = await createSeed(tmpDir, "Plain seed");
		const { stdout: human } = await run(["list"], tmpDir);
		expect(human).toContain(seedId);
		expect(human).not.toContain("[plan ");
		expect(human).not.toContain("plan in draft");

		const { stdout: jsonOut } = await run(["list", "--json"], tmpDir);
		const result = JSON.parse(jsonOut) as {
			issues: Array<{ id: string; plan_status?: string }>;
		};
		const seed = result.issues.find((i) => i.id === seedId);
		expect(seed?.plan_status).toBeUndefined();
	});
});

async function submitPlanFor(seedId: string): Promise<string> {
	const planPath = await writePlanFile(tmpDir, validPlanFor());
	const { stdout } = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
	return (JSON.parse(stdout) as { plan_id: string }).plan_id;
}

async function readPlansFromDisk(): Promise<
	Array<{ id: string; outcome?: string; outcomeNote?: string; reviewedBy?: string }>
> {
	const path = join(tmpDir, ".seeds", "plans.jsonl");
	const text = await Bun.file(path).text();
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

describe("sd plan outcome (Phase 5 / PLAN_SPEC.md:393-402)", () => {
	test("--result success persists outcome on the plan row", async () => {
		const seed = await createSeed(tmpDir, "Outcome target");
		const planId = await submitPlanFor(seed);
		const { stdout, exitCode } = await run(
			["plan", "outcome", planId, "--result", "success", "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { outcome: string; plan_id: string };
		expect(result.outcome).toBe("success");
		expect(result.plan_id).toBe(planId);
		const plans = await readPlansFromDisk();
		const stored = plans.find((p) => p.id === planId);
		expect(stored?.outcome).toBe("success");
		expect(stored?.outcomeNote).toBeUndefined();
	});

	test("--result partial --note persists both fields", async () => {
		const seed = await createSeed(tmpDir, "With note");
		const planId = await submitPlanFor(seed);
		const { exitCode } = await run(
			[
				"plan",
				"outcome",
				planId,
				"--result",
				"partial",
				"--note",
				"auth provider deprecated",
				"--json",
			],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const stored = (await readPlansFromDisk()).find((p) => p.id === planId);
		expect(stored?.outcome).toBe("partial");
		expect(stored?.outcomeNote).toBe("auth provider deprecated");
	});

	test("rejects an invalid --result value with non-zero exit", async () => {
		const seed = await createSeed(tmpDir, "Bad result");
		const planId = await submitPlanFor(seed);
		const { stderr, exitCode } = await run(["plan", "outcome", planId, "--result", "wat"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("must be one of");
	});

	test("warns (does not fail) when children are still open", async () => {
		const seed = await createSeed(tmpDir, "Has open children");
		const planId = await submitPlanFor(seed);
		const { stderr, exitCode } = await run(
			["plan", "outcome", planId, "--result", "failure", "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		expect(stderr).toMatch(/open child/);
	});

	test("unknown plan id errors cleanly", async () => {
		const { stderr, exitCode } = await run(
			["plan", "outcome", "pl-9999", "--result", "success"],
			tmpDir,
		);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("not found");
	});

	test("--json includes outcome on success", async () => {
		const seed = await createSeed(tmpDir, "Plain JSON");
		const planId = await submitPlanFor(seed);
		const { stdout } = await run(
			["plan", "outcome", planId, "--result", "success", "--json"],
			tmpDir,
		);
		const parsed = JSON.parse(stdout) as { success: boolean; outcome: string };
		expect(parsed.success).toBe(true);
		expect(parsed.outcome).toBe("success");
	});
});

describe("sd plan review (Phase 5 / PLAN_SPEC.md:404-413)", () => {
	test("--by sets reviewedBy and is informational only", async () => {
		const seed = await createSeed(tmpDir, "Reviewed");
		const planId = await submitPlanFor(seed);
		const { stdout, exitCode } = await run(
			["plan", "review", planId, "--by", "alice", "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { reviewedBy: string };
		expect(parsed.reviewedBy).toBe("alice");
		const stored = (await readPlansFromDisk()).find((p) => p.id === planId);
		expect(stored?.reviewedBy).toBe("alice");
	});

	test("show hint appears on approved plan with no reviewer", async () => {
		const seed = await createSeed(tmpDir, "Approved no review");
		const planId = await submitPlanFor(seed);
		const { stdout, exitCode } = await run(["plan", "show", planId], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Review suggested");
	});

	test("show hint disappears once reviewedBy is set", async () => {
		const seed = await createSeed(tmpDir, "Approved + reviewer");
		const planId = await submitPlanFor(seed);
		await run(["plan", "review", planId, "--by", "bob"], tmpDir);
		const { stdout } = await run(["plan", "show", planId], tmpDir);
		expect(stdout).not.toContain("Review suggested");
		expect(stdout).toContain("Reviewed: bob");
	});

	test("show hint absent for draft plans", async () => {
		const seed = await createSeed(tmpDir, "Drafty");
		// Inject a draft plan directly so we cover the status=draft branch.
		const now = new Date().toISOString();
		const planRow = {
			id: "pl-d100",
			seed,
			template: "feature",
			status: "draft",
			revision: 1,
			sections: {},
			children: [],
			createdAt: now,
			updatedAt: now,
		};
		const planPath = join(tmpDir, ".seeds", "plans.jsonl");
		const existing = await Bun.file(planPath).text();
		await Bun.write(
			planPath,
			`${existing.trim() ? `${existing.trimEnd()}\n` : ""}${JSON.stringify(planRow)}\n`,
		);
		const { stdout, exitCode } = await run(["plan", "show", "pl-d100"], tmpDir);
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("Review suggested");
	});

	test("show hint absent for active plans once reviewer set, present without reviewer", async () => {
		// Submit + close one child to flip approved → active.
		const seed = await createSeed(tmpDir, "Active path");
		const planId = await submitPlanFor(seed);
		const showJson = await run(["plan", "show", planId, "--json"], tmpDir);
		const childIds = (
			JSON.parse(showJson.stdout) as { children: Array<{ id: string }> }
		).children.map((c) => c.id);
		const firstChild = childIds[0];
		if (!firstChild) throw new Error("no children");
		await run(["update", firstChild, "--status", "in_progress"], tmpDir);

		const { stdout: humanOutput } = await run(["plan", "show", planId], tmpDir);
		expect(humanOutput).toContain("active");
		expect(humanOutput).toContain("Review suggested");

		await run(["plan", "review", planId, "--by", "carol"], tmpDir);
		const { stdout: afterReview } = await run(["plan", "show", planId], tmpDir);
		expect(afterReview).toContain("Reviewed: carol");
		expect(afterReview).not.toContain("Review suggested");
	});

	test("--json show includes reviewedBy without the cosmetic hint", async () => {
		const seed = await createSeed(tmpDir, "JSON review");
		const planId = await submitPlanFor(seed);
		await run(["plan", "review", planId, "--by", "dora"], tmpDir);
		const { stdout } = await run(["plan", "show", planId, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as { plan: { reviewedBy?: string } };
		expect(parsed.plan.reviewedBy).toBe("dora");
		expect(stdout).not.toContain("Review suggested");
	});

	test("unknown plan id errors cleanly", async () => {
		const { stderr, exitCode } = await run(["plan", "review", "pl-9999", "--by", "ghost"], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("not found");
	});
});

const VALID_REPRO =
	"On master, run `bun test src/foo.test.ts`; the third assertion fails on Linux but passes on macOS.";
const VALID_ROOT_CAUSE =
	"Path comparison in src/foo.ts assumes case-insensitive matching; Linux is case-sensitive.";

function validBugPlan(): { template: string; sections: Record<string, unknown> } {
	return {
		template: "bug",
		sections: {
			context: "Affects CI on Linux runners.",
			reproduction: VALID_REPRO,
			root_cause: VALID_ROOT_CAUSE,
			approach: "Normalize both sides to lowercase before comparing.",
			steps: [
				{ title: "Add lowercasing helper", type: "task", priority: 2, blocks: [] },
				{ title: "Wire through caller", type: "task", priority: 2, blocks: [0] },
			],
			acceptance: ["Regression test passes on Linux"],
		},
	};
}

const VALID_INVARIANT =
	"Public API of src/foo.ts (exported function names + signatures) and observable behavior (return values, errors) MUST match before and after.";

function validRefactorPlan(): { template: string; sections: Record<string, unknown> } {
	return {
		template: "refactor",
		sections: {
			context: "Module has grown unwieldy and obscures intent.",
			behavior_invariant: VALID_INVARIANT,
			approach: "Split into pure helpers + thin orchestrator.",
			steps: [{ title: "Extract helpers", type: "task", priority: 2, blocks: [] }],
			acceptance: ["All existing tests pass unchanged"],
		},
	};
}

describe("sd plan: built-in bug template (Phase 5 / PLAN_SPEC.md:268)", () => {
	test("sd plan templates lists bug", async () => {
		const { stdout } = await run(["plan", "templates"], tmpDir);
		expect(stdout).toContain("bug");
	});

	test("inference: bug-typed seed picks the bug template", async () => {
		const seed = await createSeed(tmpDir, "Bug seed", "bug");
		const { stdout } = await run(["plan", "prompt", seed, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string } };
		expect(parsed.plan_request.template).toBe("bug");
	});

	test("inference: task-typed seed still picks feature (regression)", async () => {
		const seed = await createSeed(tmpDir, "Plain task", "task");
		const { stdout } = await run(["plan", "prompt", seed, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string } };
		expect(parsed.plan_request.template).toBe("feature");
	});

	test("submit golden path: full bug plan validates and spawns children", async () => {
		const seed = await createSeed(tmpDir, "Repro this", "bug");
		const planPath = await writePlanFile(tmpDir, validBugPlan());
		const { stdout, exitCode } = await run(
			["plan", "submit", seed, "--plan", planPath, "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { plan_id: string; children: string[] };
		expect(parsed.children.length).toBe(2);
		const plans = await readPlansFromDisk();
		expect(plans.find((p) => p.id === parsed.plan_id)).toBeDefined();
	});

	test("validation: missing reproduction → diff lists it", async () => {
		const seed = await createSeed(tmpDir, "Bad bug", "bug");
		const plan = validBugPlan();
		const sections = plan.sections as Record<string, unknown>;
		delete sections.reproduction;
		const planPath = await writePlanFile(tmpDir, plan);
		const { stderr, exitCode } = await run(["plan", "submit", seed, "--plan", planPath], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("reproduction");
	});

	test("validation: short reproduction → min_length error", async () => {
		const seed = await createSeed(tmpDir, "Short repro", "bug");
		const plan = validBugPlan();
		(plan.sections as Record<string, unknown>).reproduction = "too short";
		const planPath = await writePlanFile(tmpDir, plan);
		const { stderr, exitCode } = await run(["plan", "submit", seed, "--plan", planPath], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("reproduction");
	});

	test("validation: short root_cause → min_length error", async () => {
		const seed = await createSeed(tmpDir, "Short cause", "bug");
		const plan = validBugPlan();
		(plan.sections as Record<string, unknown>).root_cause = "obvious";
		const planPath = await writePlanFile(tmpDir, plan);
		const { stderr, exitCode } = await run(["plan", "submit", seed, "--plan", planPath], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("root_cause");
	});

	test("validation: empty steps and empty acceptance both rejected", async () => {
		const seed = await createSeed(tmpDir, "Empty arrays", "bug");
		const plan = validBugPlan();
		(plan.sections as Record<string, unknown>).steps = [];
		(plan.sections as Record<string, unknown>).acceptance = [];
		const planPath = await writePlanFile(tmpDir, plan);
		const { stderr, exitCode } = await run(["plan", "submit", seed, "--plan", planPath], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("steps");
		expect(stderr).toContain("acceptance");
	});

	test("override: project config wins over built-in bug template", async () => {
		const cfgPath = join(tmpDir, ".seeds", "config.yaml");
		const text = await Bun.file(cfgPath).text();
		await Bun.write(
			cfgPath,
			`${text.trimEnd()}\nplan_templates:\n  bug:\n    sections:\n      summary:\n        required: true\n        kind: text\n        prompt: "Tiny bug summary"\n      steps:\n        required: true\n        kind: steps\n        min: 1\n        prompt: "Steps"\n`,
		);
		const seed = await createSeed(tmpDir, "Override bug", "bug");
		const { stdout } = await run(["plan", "prompt", seed, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as {
			plan_request: { template: string; sections: Array<{ name: string }> };
		};
		const names = parsed.plan_request.sections.map((s) => s.name);
		expect(names).toContain("summary");
		expect(names).not.toContain("reproduction");
	});
});

describe("sd plan: built-in refactor template (Phase 5 / PLAN_SPEC.md:269)", () => {
	test("sd plan templates lists refactor", async () => {
		const { stdout } = await run(["plan", "templates"], tmpDir);
		expect(stdout).toContain("refactor");
	});

	test("--template refactor accepts a task-typed seed", async () => {
		const seed = await createSeed(tmpDir, "Refactor candidate", "task");
		const { stdout, exitCode } = await run(
			["plan", "prompt", seed, "--template", "refactor", "--json"],
			tmpDir,
		);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as {
			plan_request: { template: string; sections: Array<{ name: string }> };
		};
		expect(parsed.plan_request.template).toBe("refactor");
		expect(parsed.plan_request.sections.map((s) => s.name)).toContain("behavior_invariant");
	});

	test("inference: task-typed seed without --template picks feature, NOT refactor", async () => {
		const seed = await createSeed(tmpDir, "No refactor inference", "task");
		const { stdout } = await run(["plan", "prompt", seed, "--json"], tmpDir);
		const parsed = JSON.parse(stdout) as { plan_request: { template: string } };
		expect(parsed.plan_request.template).toBe("feature");
		expect(parsed.plan_request.template).not.toBe("refactor");
	});

	test("submit golden path: full refactor plan validates", async () => {
		const seed = await createSeed(tmpDir, "Refactor plan", "task");
		const planPath = await writePlanFile(tmpDir, validRefactorPlan());
		const { exitCode } = await run(["plan", "submit", seed, "--plan", planPath, "--json"], tmpDir);
		expect(exitCode).toBe(0);
	});

	test("validation: missing behavior_invariant → diff lists it", async () => {
		const seed = await createSeed(tmpDir, "No invariant", "task");
		const plan = validRefactorPlan();
		delete (plan.sections as Record<string, unknown>).behavior_invariant;
		const planPath = await writePlanFile(tmpDir, plan);
		const { stderr, exitCode } = await run(["plan", "submit", seed, "--plan", planPath], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("behavior_invariant");
	});

	test("validation: short behavior_invariant → min_length error", async () => {
		const seed = await createSeed(tmpDir, "Short invariant", "task");
		const plan = validRefactorPlan();
		(plan.sections as Record<string, unknown>).behavior_invariant = "stays the same";
		const planPath = await writePlanFile(tmpDir, plan);
		const { stderr, exitCode } = await run(["plan", "submit", seed, "--plan", planPath], tmpDir);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("behavior_invariant");
	});

	test("default refactor template has no risks section", async () => {
		const seed = await createSeed(tmpDir, "Refactor sections", "task");
		const { stdout } = await run(
			["plan", "prompt", seed, "--template", "refactor", "--json"],
			tmpDir,
		);
		const parsed = JSON.parse(stdout) as {
			plan_request: { sections: Array<{ name: string }> };
		};
		const names = parsed.plan_request.sections.map((s) => s.name);
		expect(names).not.toContain("risks");
	});

	test("override: project config wins over built-in refactor template", async () => {
		const cfgPath = join(tmpDir, ".seeds", "config.yaml");
		const text = await Bun.file(cfgPath).text();
		await Bun.write(
			cfgPath,
			`${text.trimEnd()}\nplan_templates:\n  refactor:\n    sections:\n      goal:\n        required: true\n        kind: text\n        prompt: "Goal"\n      steps:\n        required: true\n        kind: steps\n        min: 1\n        prompt: "Steps"\n`,
		);
		const seed = await createSeed(tmpDir, "Override refactor", "task");
		const { stdout } = await run(
			["plan", "prompt", seed, "--template", "refactor", "--json"],
			tmpDir,
		);
		const parsed = JSON.parse(stdout) as {
			plan_request: { sections: Array<{ name: string }> };
		};
		const names = parsed.plan_request.sections.map((s) => s.name);
		expect(names).toContain("goal");
		expect(names).not.toContain("behavior_invariant");
	});
});

describe("sd plan submit: child backref block (seeds-76af)", () => {
	type IssueRow = {
		id: string;
		title: string;
		description?: string;
		assignee?: string;
		labels?: string[];
		updatedAt: string;
	};

	async function readIssueRow(id: string): Promise<IssueRow> {
		const issues = await readJsonl<IssueRow>(join(tmpDir, ".seeds/issues.jsonl"));
		const found = issues.find((i) => i.id === id);
		if (!found) throw new Error(`issue not found: ${id}`);
		return found;
	}

	test("fresh submit populates each child description with backref fields", async () => {
		const seedId = await createSeed(tmpDir, "Add OAuth2 device-flow authentication");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const result = JSON.parse(submit.stdout) as { plan_id: string; children: string[] };

		const childB = await readIssueRow(result.children[1] ?? "");
		expect(childB.description).toBeDefined();
		const desc = childB.description ?? "";
		expect(desc).toContain("seeds:plan-backref:start");
		expect(desc).toContain(`Step 2 of plan ${result.plan_id}.`);
		expect(desc).toContain(`Parent seed: ${seedId} — Add OAuth2 device-flow authentication`);
		expect(desc).toContain("Plan template: feature");
		expect(desc).toContain("Plan approach: Hardcoded TS template + AJV schema");
		expect(desc).toContain(`Run \`sd plan show ${result.plan_id}\``);
	});

	test("plan_template children also receive a backref", async () => {
		const seedId = await createSeed(tmpDir, "Parent seed", "feature");
		const plan = validPlanFor();
		plan.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [] },
			{
				title: "Pre-planned step",
				type: "task",
				priority: 2,
				blocks: [],
				plan_template: "feature",
			},
		];
		const planPath = await writePlanFile(tmpDir, plan);
		const submit = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const result = JSON.parse(submit.stdout) as { plan_id: string; children: string[] };
		const subChild = await readIssueRow(result.children[1] ?? "");
		expect(subChild.description ?? "").toContain(`Step 2 of plan ${result.plan_id}.`);
	});

	test("--overwrite refreshes the backref on retained children when approach changes", async () => {
		const seedId = await createSeed(tmpDir, "Stable IDs");
		const v1 = validPlanFor();
		v1.sections.approach = "Original approach for revision 1.";
		const planPath = await writePlanFile(tmpDir, v1);
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstResult = JSON.parse(first.stdout) as { plan_id: string; children: string[] };
		const childId = firstResult.children[0] ?? "";
		const before = await readIssueRow(childId);
		expect(before.description ?? "").toContain("Plan approach: Original approach for revision 1.");

		const v2 = validPlanFor();
		v2.sections.approach = "Revised approach for revision 2.";
		const planPath2 = await writePlanFile(tmpDir, v2);
		await run(["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"], tmpDir);

		const after = await readIssueRow(childId);
		expect(after.description ?? "").toContain("Plan approach: Revised approach for revision 2.");
		expect(after.description ?? "").not.toContain("Original approach for revision 1.");
	});

	test("--overwrite preserves assignee and labels on retained children", async () => {
		const seedId = await createSeed(tmpDir, "Preserve fields");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstResult = JSON.parse(first.stdout) as { plan_id: string; children: string[] };
		const childId = firstResult.children[0] ?? "";

		await run(["update", childId, "--assignee", "alice"], tmpDir);
		await run(["label", "add", childId, "needs-design"], tmpDir);

		const beforeOverwrite = await readIssueRow(childId);
		expect(beforeOverwrite.assignee).toBe("alice");
		expect(beforeOverwrite.labels).toEqual(["needs-design"]);

		const v2 = validPlanFor();
		v2.sections.approach = "Revised approach for retention test.";
		const planPath2 = await writePlanFile(tmpDir, v2);
		const overwrite = await run(
			["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"],
			tmpDir,
		);
		expect(overwrite.exitCode).toBe(0);

		const after = await readIssueRow(childId);
		expect(after.assignee).toBe("alice");
		expect(after.labels).toEqual(["needs-design"]);
		expect(after.description ?? "").toContain(
			"Plan approach: Revised approach for retention test.",
		);
	});

	test("newly spawned children during overwrite get a fresh backref", async () => {
		const seedId = await createSeed(tmpDir, "Spawn fresh on overwrite");
		const planPath = await writePlanFile(tmpDir, validPlanFor());
		const first = await run(["plan", "submit", seedId, "--plan", planPath, "--json"], tmpDir);
		const firstResult = JSON.parse(first.stdout) as { plan_id: string; children: string[] };

		const v2 = validPlanFor();
		v2.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [] },
			{ title: "Step B", type: "task", priority: 2, blocks: [0] },
			{ title: "Brand New Step", type: "task", priority: 2, blocks: [1] },
		];
		const planPath2 = await writePlanFile(tmpDir, v2);
		const overwrite = await run(
			["plan", "submit", seedId, "--plan", planPath2, "--overwrite", "--json"],
			tmpDir,
		);
		const result = JSON.parse(overwrite.stdout) as { children: string[] };
		const newChildId = result.children[2] ?? "";
		expect(firstResult.children).not.toContain(newChildId);

		const spawned = await readIssueRow(newChildId);
		expect(spawned.description ?? "").toContain(`Step 3 of plan ${firstResult.plan_id}.`);
		expect(spawned.description ?? "").toContain("Parent seed:");
	});
});
