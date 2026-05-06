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
		expect(parsed.count).toBe(1);
		expect(parsed.templates[0]?.name).toBe("feature");
		expect(parsed.templates[0]?.description.length).toBeGreaterThan(0);
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
