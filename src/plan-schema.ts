// Generates an AJV-compatible JSON Schema from a PlanTemplate (PLAN_SPEC.md:312).
//
// The shape of the output mirrors what Phase 1's hand-written `featureSchema`
// produced (src/plan-templates/feature.ts), so the same `compileSchema` from
// src/validation.ts consumes it. Custom templates declared in config.yaml
// compile through the same pipeline.
//
// Step.blocks structural checks (self-reference, out-of-range) live outside the
// schema since they depend on array length — `compilePlanTemplate` runs them
// as a second pass after AJV.

import type { PlanTemplate, SectionSpec } from "./types.ts";
import type { PartialStateDiff } from "./validation.ts";
import { compileSchema, type ErrorEntry } from "./validation.ts";

type JSONSchema = Record<string, unknown>;

const STEP_SCHEMA: JSONSchema = {
	type: "object",
	required: ["title"],
	properties: {
		title: { type: "string", minLength: 1 },
		type: { type: "string", enum: ["task", "bug", "feature", "epic"] },
		priority: { type: "integer", minimum: 0, maximum: 4 },
		blocks: { type: "array", items: { type: "integer" } },
		plan_template: { type: "string" },
		// existing_seed adopts an already-open seed at submit time instead of
		// spawning a fresh child (seeds-3c89 / pl-43ff step 1). The schema accepts
		// any non-empty string; existence, status, and id-shape checks live in
		// runSubmit alongside the rest of the spawn pipeline.
		existing_seed: { type: "string", minLength: 1 },
	},
};

export function generatePlanSchema(template: PlanTemplate): JSONSchema {
	const required: string[] = [];
	const properties: Record<string, JSONSchema> = {};
	for (const [name, spec] of Object.entries(template.sections)) {
		if (spec.required) required.push(name);
		properties[name] = sectionToSchema(spec);
	}
	const sections: JSONSchema = { type: "object", properties };
	if (required.length > 0) sections.required = required;
	return {
		type: "object",
		required: ["template", "sections"],
		properties: {
			template: { type: "string", const: template.name },
			sections,
		},
	};
}

function sectionToSchema(spec: SectionSpec): JSONSchema {
	if (typeof spec.kind === "string") {
		if (spec.kind === "text") {
			return { type: "string", minLength: spec.min_length ?? 1 };
		}
		if (spec.kind === "list") {
			return {
				type: "array",
				minItems: spec.min ?? 0,
				items: itemToSchema(spec.item ?? "text"),
			};
		}
		if (spec.kind === "steps") {
			return { type: "array", minItems: spec.min ?? 0, items: STEP_SCHEMA };
		}
	}
	return objectKindToSchema(spec.kind as Record<string, SectionSpec>);
}

function objectKindToSchema(fields: Record<string, SectionSpec>): JSONSchema {
	const required: string[] = [];
	const properties: Record<string, JSONSchema> = {};
	for (const [k, v] of Object.entries(fields)) {
		if (v.required) required.push(k);
		properties[k] = sectionToSchema(v);
	}
	const out: JSONSchema = { type: "object", properties };
	if (required.length > 0) out.required = required;
	return out;
}

function itemToSchema(item: "text" | Record<string, SectionSpec>): JSONSchema {
	if (item === "text") return { type: "string", minLength: 1 };
	return objectKindToSchema(item);
}

export type PlanValidator = (
	data: unknown,
) => { valid: true } | { valid: false; diff: PartialStateDiff };

// Compile a PlanTemplate into a runnable validator. AJV runs first; the
// steps[].blocks structural pass appends extra errors when relevant.
export function compilePlanTemplate(template: PlanTemplate): PlanValidator {
	const schema = generatePlanSchema(template);
	const ajv = compileSchema(schema);
	const stepsKey = findStepsSectionKey(template);
	return (data: unknown) => {
		const ajvResult = ajv(data);
		const errors: ErrorEntry[] = ajvResult.valid ? [] : [...ajvResult.diff.errors];
		if (stepsKey) {
			errors.push(...validateStepBlocks(data, stepsKey));
		}
		if (errors.length === 0) return { valid: true };
		return { valid: false, diff: { errors, current: data } };
	};
}

function findStepsSectionKey(template: PlanTemplate): string | undefined {
	for (const [k, v] of Object.entries(template.sections)) {
		if (v.kind === "steps") return k;
	}
	return undefined;
}

// step.blocks values are 1-based: step 1 is the first step, step N is the
// last (seeds-185f). Internal `plan_step_index` on spawned children stays
// 0-based — it's a code-level back-link, not author-facing.
function validateStepBlocks(data: unknown, sectionKey: string): ErrorEntry[] {
	const sections = (data as { sections?: unknown })?.sections;
	if (!sections || typeof sections !== "object") return [];
	const steps = (sections as Record<string, unknown>)[sectionKey];
	if (!Array.isArray(steps)) return [];
	const errors: ErrorEntry[] = [];
	const len = steps.length;
	for (let i = 0; i < len; i++) {
		const step = steps[i];
		if (!step || typeof step !== "object") continue;
		const blocks = (step as { blocks?: unknown }).blocks;
		if (!Array.isArray(blocks)) continue;
		const stepLabel = i + 1;
		for (const b of blocks) {
			if (typeof b !== "number" || !Number.isInteger(b)) continue;
			if (b === stepLabel) {
				errors.push({
					path: `sections.${sectionKey}.${i}.blocks`,
					code: "self-reference",
					fix: `step ${stepLabel} cannot block itself; remove ${b} from blocks`,
				});
			} else if (b < 1 || b > len) {
				errors.push({
					path: `sections.${sectionKey}.${i}.blocks`,
					code: "out-of-range",
					fix: `step index ${b} is out of range (step indices are 1-based; valid range 1..${len})`,
				});
			}
		}
	}
	return errors;
}

// Map seed type -> default template name (PLAN_SPEC.md:271, 429). Hard-coded
// per the answer to open question 4. `--template` always overrides. `refactor`
// is intentionally opt-in via `--template` only; see seeds-6730 / the header
// comment on BUILTIN_REFACTOR_TEMPLATE.
const TYPE_DEFAULTS: Record<string, string> = {
	task: "feature",
	bug: "bug",
	feature: "feature",
	epic: "feature",
};

export function defaultTemplateForType(type: string): string {
	return TYPE_DEFAULTS[type] ?? "feature";
}
