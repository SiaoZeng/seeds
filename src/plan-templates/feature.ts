// Built-in `feature` plan template (PLAN_SPEC.md:313-325 + 38-78).
//
// Phase 1 keeps this hardcoded — Phase 2 introduces YAML-driven custom templates.
// The schema is hand-written rather than derived from the section metadata so the
// validation rules stay readable and auditable until that derivation lands.
//
// AJV covers required sections, min_length on text, min on lists, and the
// alternatives object shape. The `steps[].blocks` structural check (index in
// range, no self-reference per PLAN_SPEC.md:367) runs as a second pass below
// since it depends on the array length — out of reach of single-field schemas.

import { compileSchema, type ErrorEntry, type PartialStateDiff } from "../validation.ts";
import type { PlanTemplate } from "./index.ts";

export const featureSchema = {
	type: "object",
	required: ["template", "sections"],
	properties: {
		template: { type: "string", const: "feature" },
		sections: {
			type: "object",
			required: ["context", "approach", "steps", "acceptance"],
			properties: {
				context: { type: "string", minLength: 50 },
				approach: { type: "string", minLength: 1 },
				alternatives: {
					type: "array",
					items: {
						type: "object",
						required: ["name", "rejected_because"],
						properties: {
							name: { type: "string", minLength: 1 },
							rejected_because: { type: "string", minLength: 1 },
						},
					},
				},
				steps: {
					type: "array",
					minItems: 2,
					items: {
						type: "object",
						required: ["title"],
						properties: {
							title: { type: "string", minLength: 1 },
							type: { type: "string", enum: ["task", "bug", "feature", "epic"] },
							priority: { type: "integer", minimum: 0, maximum: 4 },
							blocks: {
								type: "array",
								items: { type: "integer", minimum: 0 },
							},
						},
					},
				},
				risks: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				acceptance: {
					type: "array",
					minItems: 1,
					items: { type: "string", minLength: 1 },
				},
			},
		},
	},
} as const;

const compiled = compileSchema(featureSchema);

export function validateFeaturePlan(
	data: unknown,
): { valid: true } | { valid: false; diff: PartialStateDiff } {
	const ajvResult = compiled(data);
	const errors: ErrorEntry[] = ajvResult.valid ? [] : [...ajvResult.diff.errors];

	const steps = stepsOf(data);
	if (steps) {
		const len = steps.length;
		for (let i = 0; i < len; i++) {
			const step = steps[i];
			if (!step || typeof step !== "object") continue;
			const blocks = (step as { blocks?: unknown }).blocks;
			if (!Array.isArray(blocks)) continue;
			for (const b of blocks) {
				if (typeof b !== "number" || !Number.isInteger(b)) continue;
				if (b === i) {
					errors.push({
						path: `sections.steps.${i}.blocks`,
						code: "self-reference",
						fix: `step ${i} cannot block itself; remove ${b} from blocks`,
					});
				} else if (b < 0 || b >= len) {
					errors.push({
						path: `sections.steps.${i}.blocks`,
						code: "out-of-range",
						fix: `step index ${b} is out of range (have ${len} step${len === 1 ? "" : "s"})`,
					});
				}
			}
		}
	}

	if (errors.length === 0) return { valid: true };
	return { valid: false, diff: { errors, current: data } };
}

function stepsOf(data: unknown): unknown[] | undefined {
	if (!data || typeof data !== "object") return undefined;
	const sections = (data as { sections?: unknown }).sections;
	if (!sections || typeof sections !== "object") return undefined;
	const steps = (sections as { steps?: unknown }).steps;
	return Array.isArray(steps) ? steps : undefined;
}

export const featureTemplate: PlanTemplate = {
	name: "feature",
	description: "New capability or significant change. Default for type: feature.",
	sections: [
		{
			name: "context",
			required: true,
			kind: "text",
			min_length: 50,
			prompt: "Why does this work need to happen? What problem or opportunity drives it?",
		},
		{
			name: "approach",
			required: true,
			kind: "text",
			prompt: "What's the chosen approach, and why this over alternatives?",
		},
		{
			name: "alternatives",
			required: false,
			kind: "list",
			item: { kind: "object", fields: { name: "text", rejected_because: "text" } },
			prompt: "What other approaches were considered and rejected?",
		},
		{
			name: "steps",
			required: true,
			kind: "steps",
			min: 2,
			prompt:
				"Decompose into ordered, independent implementation steps. Each becomes a child seed.",
		},
		{
			name: "risks",
			required: false,
			kind: "list",
			item: "text",
			mulch_source: "failure",
			prompt:
				"What could go wrong? Known failure modes from prior work are pre-filled when mulch is available.",
		},
		{
			name: "acceptance",
			required: true,
			kind: "list",
			item: "text",
			min: 1,
			prompt: "Concrete, verifiable conditions for plan completion.",
		},
	],
	validate: validateFeaturePlan,
};
