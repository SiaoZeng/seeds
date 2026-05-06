// Plan template registry. Phase 1 ships a single hardcoded template (`feature`);
// Phase 2 will allow custom templates declared in .seeds/config.yaml.

import type { PartialStateDiff } from "../validation.ts";
import { featureTemplate } from "./feature.ts";

export type SectionKind = "text" | "list" | "steps";

export interface ObjectItemSpec {
	kind: "object";
	fields: Record<string, "text">;
}

export interface PlanSection {
	name: string;
	required: boolean;
	kind: SectionKind;
	prompt: string;
	min_length?: number;
	min?: number;
	item?: "text" | ObjectItemSpec;
	mulch_source?: string;
}

export interface PlanTemplate {
	name: string;
	description: string;
	sections: PlanSection[];
	validate: (data: unknown) => { valid: true } | { valid: false; diff: PartialStateDiff };
}

const TEMPLATES: Record<string, PlanTemplate> = {
	feature: featureTemplate,
};

export function getTemplate(name: string): PlanTemplate | undefined {
	return TEMPLATES[name];
}

export function listTemplates(): PlanTemplate[] {
	return Object.values(TEMPLATES);
}

export function templateNames(): string[] {
	return Object.keys(TEMPLATES);
}

// Map seed type -> default template name (PLAN_SPEC.md:271 + Open Question 4).
// Phase 1 only ships `feature`, so every type maps to it. The mapping table
// fills out in later phases when bug/refactor templates land.
const TYPE_DEFAULTS: Record<string, string> = {
	task: "feature",
	bug: "feature",
	feature: "feature",
	epic: "feature",
};

export function defaultTemplateForType(type: string): string {
	return TYPE_DEFAULTS[type] ?? "feature";
}
