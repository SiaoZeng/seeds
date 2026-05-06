import { describe, expect, test } from "bun:test";
import { validateFeaturePlan } from "./feature.ts";

const longContext =
	"This work matters because we need to enable structured planning for AI agents using seeds.";

function validPlan() {
	return {
		template: "feature",
		sections: {
			context: longContext,
			approach: "Hardcoded TypeScript template plus AJV schema, mirroring mulch's custom_types.",
			alternatives: [
				{ name: "YAML-driven from day one", rejected_because: "Phase 2 work; defer." },
			],
			steps: [
				{ title: "Define types", type: "task", priority: 2, blocks: [] },
				{ title: "Implement validator", type: "task", priority: 2, blocks: [0] },
			],
			risks: ["AJV strict mode may reject schemas we expect to load"],
			acceptance: ["Validator returns the documented partial-state diff shape"],
		},
	};
}

describe("validateFeaturePlan — golden path", () => {
	test("accepts a fully populated valid plan", () => {
		const result = validateFeaturePlan(validPlan());
		expect(result.valid).toBe(true);
	});

	test("accepts a minimal-but-valid plan (omits optional sections)", () => {
		const plan = {
			template: "feature",
			sections: {
				context: longContext,
				approach: "Pick the boring approach.",
				steps: [{ title: "Step one" }, { title: "Step two", blocks: [0] }],
				acceptance: ["It works"],
			},
		};
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(true);
	});
});

describe("validateFeaturePlan — failure modes", () => {
	test("missing required section: context", () => {
		const plan = validPlan();
		const { context: _omit, ...rest } = plan.sections;
		const stripped = { ...plan, sections: rest };
		const result = validateFeaturePlan(stripped);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(
			result.diff.errors.some((e) => e.path.endsWith("context") && e.code === "required"),
		).toBe(true);
		expect(result.diff.current).toEqual(stripped);
	});

	test("context too short", () => {
		const plan = validPlan();
		plan.sections.context = "too short";
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(
			result.diff.errors.some((e) => e.path === "sections.context" && e.code === "minLength"),
		).toBe(true);
	});

	test("steps with only 1 entry", () => {
		const plan = validPlan();
		plan.sections.steps = [{ title: "Only step", type: "task", priority: 2, blocks: [] }];
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.diff.errors.some((e) => e.path === "sections.steps" && e.code === "min")).toBe(
			true,
		);
	});

	test("self-reference in steps blocks", () => {
		const plan = validPlan();
		plan.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [0] },
			{ title: "Step B", type: "task", priority: 2, blocks: [] },
		];
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(
			result.diff.errors.some(
				(e) => e.path === "sections.steps.0.blocks" && e.code === "self-reference",
			),
		).toBe(true);
	});

	test("out-of-range index in steps blocks", () => {
		const plan = validPlan();
		plan.sections.steps = [
			{ title: "Step A", type: "task", priority: 2, blocks: [5] },
			{ title: "Step B", type: "task", priority: 2, blocks: [] },
		];
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(
			result.diff.errors.some(
				(e) => e.path === "sections.steps.0.blocks" && e.code === "out-of-range",
			),
		).toBe(true);
	});

	test("acceptance is empty array", () => {
		const plan = validPlan();
		plan.sections.acceptance = [];
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(
			result.diff.errors.some((e) => e.path === "sections.acceptance" && e.code === "min"),
		).toBe(true);
	});

	test("alternatives entry missing rejected_because", () => {
		const plan = validPlan();
		plan.sections.alternatives = [
			{ name: "An alternative" } as unknown as { name: string; rejected_because: string },
		];
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(
			result.diff.errors.some((e) => e.path.includes("alternatives") && e.code === "required"),
		).toBe(true);
	});

	test("partial-state diff carries the submission verbatim", () => {
		const plan = validPlan();
		plan.sections.context = "short";
		const result = validateFeaturePlan(plan);
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.diff.current).toEqual(plan);
		expect(Array.isArray(result.diff.errors)).toBe(true);
	});
});
