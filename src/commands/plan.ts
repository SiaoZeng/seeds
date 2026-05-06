import { Command } from "commander";
import { findSeedsDir, readConfig } from "../config.ts";
import { generateId } from "../id.ts";
import { accent, brand, muted, outputJson, printSuccess } from "../output.ts";
import { summarisePlanChildren } from "../plan-context.ts";
import {
	defaultTemplateForType,
	getTemplate,
	listTemplates,
	type PlanSection,
	templateNames,
} from "../plan-templates/index.ts";
import {
	appendPlan,
	issuesPath,
	plansPath,
	readIssues,
	readPlans,
	withLock,
	writeIssues,
	writePlans,
} from "../store.ts";
import type { Issue, Plan } from "../types.ts";

export function register(program: Command): void {
	const plan = new Command("plan").description("Plan management");

	plan
		.command("templates")
		.description("List available plan templates")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await runTemplates(Boolean(opts.json));
		});

	plan
		.command("prompt <seed-id>")
		.description("Emit structured planning prompt JSON for a seed")
		.option("--template <name>", "Override the inferred template")
		.option("--json", "Output as JSON")
		.action(async (seedId: string, opts: { template?: string; json?: boolean }) => {
			await runPrompt(seedId, opts.template, Boolean(opts.json));
		});

	plan
		.command("submit <seed-id>")
		.description("Validate a plan, spawn children, write plans.jsonl row")
		.requiredOption("--plan <file>", "Path to plan JSON, or '-' to read from stdin")
		.option("--json", "Output as JSON")
		.action(async (seedId: string, opts: { plan: string; json?: boolean }) => {
			await runSubmit(seedId, opts.plan, Boolean(opts.json));
		});

	plan
		.command("show <pl-id>")
		.description("Show a plan with sections, children, and status")
		.option("--json", "Output as JSON")
		.action(async (planId: string, opts: { json?: boolean }) => {
			await runShow(planId, Boolean(opts.json));
		});

	plan
		.command("validate <pl-id>")
		.description("Re-run validation against the current template definition")
		.option("--json", "Output as JSON")
		.action(async (planId: string, opts: { json?: boolean }) => {
			await runValidate(planId, Boolean(opts.json));
		});

	plan
		.command("list")
		.description("List plans with optional filters")
		.option("--seed <id>", "Filter by parent seed id")
		.option("--status <status>", "Filter by status (draft|approved|active|done)")
		.option("--outcome <outcome>", "Filter by outcome (success|partial|failure)")
		.option("--template <name>", "Filter by template name")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				seed?: string;
				status?: string;
				outcome?: string;
				template?: string;
				json?: boolean;
			}) => {
				await runList(opts, Boolean(opts.json));
			},
		);

	// `sd plan` (no subcommand) prints help and exits non-zero so scripted callers notice.
	plan.action(() => {
		plan.outputHelp();
		process.exitCode = 1;
	});

	program.addCommand(plan);
}

async function runTemplates(jsonMode: boolean): Promise<void> {
	const templates = listTemplates();
	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan templates",
			templates: templates.map((t) => ({ name: t.name, description: t.description })),
			count: templates.length,
		});
		return;
	}
	console.log(`${brand("Available templates:")}`);
	for (const t of templates) {
		console.log(`  ${accent.bold(t.name)}  ${muted(t.description)}`);
	}
}

interface PromptSection {
	name: string;
	required: boolean;
	kind: PlanSection["kind"];
	prompt: string;
	prior_art: unknown[];
	min_length?: number;
	min?: number;
	item?: PlanSection["item"];
}

interface PlanRequest {
	seed: string;
	template: string;
	instructions: string;
	sections: PromptSection[];
	validation: {
		all_required_present: boolean;
		min_steps: number;
		min_acceptance: number;
	};
}

const INSTRUCTIONS =
	"Fill every section. Required fields are marked. Use prior_art entries to ground decisions.";

function buildPlanRequest(seedId: string, templateName: string): PlanRequest {
	const template = getTemplate(templateName);
	if (!template) {
		const available = templateNames().join(", ");
		throw new Error(`Unknown template: ${templateName}. Available: ${available}`);
	}
	const sections: PromptSection[] = template.sections.map((s) => {
		const out: PromptSection = {
			name: s.name,
			required: s.required,
			kind: s.kind,
			prompt: s.prompt,
			prior_art: [], // Phase 1: empty; Phase 3 fills from mulch
		};
		if (s.min_length !== undefined) out.min_length = s.min_length;
		if (s.min !== undefined) out.min = s.min;
		if (s.item !== undefined) out.item = s.item;
		return out;
	});
	const stepsSection = template.sections.find((s) => s.name === "steps");
	const acceptanceSection = template.sections.find((s) => s.name === "acceptance");
	return {
		seed: seedId,
		template: templateName,
		instructions: INSTRUCTIONS,
		sections,
		validation: {
			all_required_present: true,
			min_steps: stepsSection?.min ?? 0,
			min_acceptance: acceptanceSection?.min ?? 0,
		},
	};
}

async function runPrompt(
	seedId: string,
	templateOverride: string | undefined,
	jsonMode: boolean,
): Promise<void> {
	const dir = await findSeedsDir();
	const issues = await readIssues(dir);
	const seed = issues.find((i) => i.id === seedId);
	if (!seed) throw new Error(`Seed not found: ${seedId}`);

	const templateName = templateOverride ?? defaultTemplateForType(seed.type);
	if (!getTemplate(templateName)) {
		const available = templateNames().join(", ");
		throw new Error(`Unknown template: ${templateName}. Available: ${available}`);
	}

	const planRequest = buildPlanRequest(seedId, templateName);

	if (jsonMode) {
		outputJson({ plan_request: planRequest });
		return;
	}

	console.log(`${brand("Plan prompt")} for ${accent.bold(seedId)}`);
	console.log(`${muted("Template:")} ${planRequest.template}`);
	console.log(`${muted("Seed title:")} ${seed.title}`);
	console.log("");
	console.log(planRequest.instructions);
	console.log("");
	for (const s of planRequest.sections) {
		const tag = s.required ? brand("required") : muted("optional");
		console.log(`  ${accent.bold(s.name)} ${muted(`(${s.kind})`)} ${tag}`);
		console.log(`    ${muted(s.prompt)}`);
		if (s.min_length !== undefined) console.log(`    ${muted(`min_length: ${s.min_length}`)}`);
		if (s.min !== undefined) console.log(`    ${muted(`min entries: ${s.min}`)}`);
	}
	console.log("");
	console.log(`${muted("Pipe --json into a file the LLM fills, then run:")}`);
	console.log(`  sd plan submit ${seedId} --plan <file>`);
}

interface SubmittedStep {
	title: string;
	type?: string;
	priority?: number;
	blocks?: number[];
}

interface SubmittedPlan {
	template: string;
	sections: {
		steps: SubmittedStep[];
		[key: string]: unknown;
	};
}

async function readPlanInput(planFile: string): Promise<string> {
	if (planFile === "-") {
		return await Bun.stdin.text();
	}
	const file = Bun.file(planFile);
	if (!(await file.exists())) {
		throw new Error(`Plan file not found: ${planFile}`);
	}
	return await file.text();
}

async function runSubmit(seedId: string, planFile: string, jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();

	const raw = await readPlanInput(planFile);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`Invalid JSON in plan file: ${(e as Error).message}`);
	}

	const templateName =
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as { template?: unknown }).template === "string"
			? (parsed as { template: string }).template
			: "feature";
	const template = getTemplate(templateName);
	if (!template) {
		const available = templateNames().join(", ");
		throw new Error(`Unknown template in plan: ${templateName}. Available: ${available}`);
	}

	const result = template.validate(parsed);
	if (!result.valid) {
		// Partial-state diff JSON to stderr (PLAN_SPEC.md:180-195).
		// stdout stays clean so callers can pipe it into a file.
		process.stderr.write(`${JSON.stringify(result.diff, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	const submitted = parsed as SubmittedPlan;
	const config = await readConfig(dir);

	let createdPlanId = "";
	let childIds: string[] = [];

	// Combined lock: hold plans + issues while we read and write both.
	// Order: outer lock = plans, inner = issues. Same across submit/validate
	// to avoid deadlocks.
	await withLock(plansPath(dir), async () => {
		await withLock(issuesPath(dir), async () => {
			const allIssues = await readIssues(dir);
			const allPlans = await readPlans(dir);

			const seedIdx = allIssues.findIndex((i) => i.id === seedId);
			const seed = allIssues[seedIdx];
			if (!seed) throw new Error(`Seed not found: ${seedId}`);

			// Phase 1 rejects resubmission for any non-draft existing plan.
			// `--overwrite` lands in Phase 2 (PLAN_SPEC.md:374-391).
			const existingPlan = allPlans.find((p) => p.seed === seedId && p.status !== "draft");
			if (existingPlan) {
				throw new Error(
					`Plan ${existingPlan.id} already exists for ${seedId} (status: ${existingPlan.status}, revision: ${existingPlan.revision}). Use --overwrite to replace it. (Phase 1: --overwrite is not yet implemented.)`,
				);
			}

			const steps = submitted.sections.steps;

			// Allocate ids up front so blocks-index translation has them all.
			const issueIds = new Set(allIssues.map((i) => i.id));
			const planIds = new Set(allPlans.map((p) => p.id));
			const planId = generateId("pl", planIds);

			const newChildIds: string[] = [];
			for (let i = 0; i < steps.length; i++) {
				const id = generateId(config.project, new Set([...issueIds, ...newChildIds]));
				newChildIds.push(id);
			}

			const now = new Date().toISOString();

			// Build child issues. step[i].blocks lists the indices step i depends
			// on, so child[i].blockedBy = step[i].blocks ↦ child ids. The reverse
			// `blocks` field is collected in a second pass.
			const newIssues: Issue[] = steps.map((step, idx) => {
				const childId = newChildIds[idx];
				if (!childId) throw new Error(`Internal: missing child id at index ${idx}`);
				const stepType = (step.type ?? "task") as Issue["type"];
				const issue: Issue = {
					id: childId,
					title: step.title,
					status: "open",
					type: stepType,
					priority: step.priority ?? 2,
					plan_id: planId,
					plan_step_index: idx,
					createdAt: now,
					updatedAt: now,
				};
				const deps = step.blocks ?? [];
				if (deps.length > 0) {
					const blockedByIds: string[] = [];
					for (const j of deps) {
						const target = newChildIds[j];
						if (target) blockedByIds.push(target);
					}
					if (blockedByIds.length > 0) issue.blockedBy = blockedByIds;
				}
				return issue;
			});

			// Reverse edges: if step i depends on step j, then j blocks i.
			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				if (!step) continue;
				const childId = newChildIds[i];
				if (!childId) continue;
				for (const j of step.blocks ?? []) {
					const blocker = newIssues[j];
					if (!blocker) continue;
					blocker.blocks = [...(blocker.blocks ?? []), childId];
				}
			}

			// Parent seed gains a back-pointer to the plan and is blocked by all
			// children (so `sd ready` surfaces children, not the parent).
			const updatedSeed: Issue = {
				...seed,
				plan_id: planId,
				blockedBy: [...(seed.blockedBy ?? []), ...newChildIds],
				updatedAt: now,
			};
			allIssues[seedIdx] = updatedSeed;

			// Each child blocks the parent.
			for (const child of newIssues) {
				child.blocks = [...(child.blocks ?? []), seedId];
			}

			const plan: Plan = {
				id: planId,
				seed: seedId,
				template: templateName,
				status: "approved",
				revision: 1,
				sections: submitted.sections as Record<string, unknown>,
				children: newChildIds,
				createdAt: now,
				updatedAt: now,
			};

			// Write issues atomically (rewrite parent + append children) and
			// append the plan row.
			await writeIssues(dir, [...allIssues, ...newIssues]);

			const draftIdx = allPlans.findIndex((p) => p.seed === seedId && p.status === "draft");
			if (draftIdx >= 0) {
				allPlans[draftIdx] = plan;
				await writePlans(dir, allPlans);
			} else {
				await appendPlan(dir, plan);
			}

			createdPlanId = planId;
			childIds = newChildIds;
		});
	});

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan submit",
			plan_id: createdPlanId,
			children: childIds,
			parent_seed: seedId,
		});
		return;
	}

	printSuccess(`plan ${accent(createdPlanId)} created (status: approved)`);
	printSuccess(
		`spawned ${childIds.length} child seeds: ${childIds.map((id) => accent(id)).join(", ")}`,
	);
	printSuccess(`${accent(seedId)} now blocked by ${childIds.length} children`);
}

async function runShow(planId: string, jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();
	const plans = await readPlans(dir);
	const plan = plans.find((p) => p.id === planId);
	if (!plan) {
		throw new Error(`Plan not found: ${planId}. Run 'sd plan list' to see available plans.`);
	}
	const issues = await readIssues(dir);
	const children = summarisePlanChildren(plan, issues);

	if (jsonMode) {
		outputJson({ success: true, command: "plan show", plan, children });
		return;
	}

	console.log(`${accent.bold(plan.id)}  ${brand(plan.status)}  ${muted(`rev ${plan.revision}`)}`);
	console.log(`Seed:     ${accent(plan.seed)}`);
	console.log(`Template: ${plan.template}`);
	console.log(`Created:  ${muted(plan.createdAt)}`);
	console.log(`Updated:  ${muted(plan.updatedAt)}`);
	if (plan.outcome) {
		const note = plan.outcomeNote ? ` — ${plan.outcomeNote}` : "";
		console.log(`Outcome:  ${plan.outcome}${note}`);
	}
	if (!plan.reviewedBy) {
		console.log(muted("Review suggested (no reviewer recorded yet)"));
	} else {
		console.log(`Reviewed: ${plan.reviewedBy}`);
	}

	console.log("");
	console.log(brand("Sections:"));
	const order = ["context", "approach", "alternatives", "steps", "risks", "acceptance"];
	const knownKeys = new Set(order);
	const orderedKeys = [
		...order.filter((k) => k in plan.sections),
		...Object.keys(plan.sections).filter((k) => !knownKeys.has(k)),
	];
	for (const key of orderedKeys) {
		const value = plan.sections[key];
		console.log(`  ${accent.bold(key)}`);
		if (value === undefined || value === null) {
			console.log(muted("    (empty)"));
			continue;
		}
		if (typeof value === "string") {
			for (const line of value.split("\n")) console.log(`    ${line}`);
			continue;
		}
		if (Array.isArray(value)) {
			if (value.length === 0) {
				console.log(muted("    (none)"));
				continue;
			}
			value.forEach((entry, i) => {
				if (typeof entry === "string") {
					console.log(`    ${i + 1}. ${entry}`);
				} else {
					console.log(`    ${i + 1}. ${JSON.stringify(entry)}`);
				}
			});
			continue;
		}
		console.log(`    ${JSON.stringify(value)}`);
	}

	console.log("");
	console.log(brand(`Children (${children.length}):`));
	if (children.length === 0) {
		console.log(muted("  (none)"));
	} else {
		for (const c of children) {
			console.log(`  ${accent(c.id)}  ${muted(`[${c.status}]`)}  ${c.title}`);
		}
	}
}

interface ListFilters {
	seed?: string;
	status?: string;
	outcome?: string;
	template?: string;
}

const VALID_PLAN_STATUSES = new Set(["draft", "approved", "active", "done"]);
const VALID_PLAN_OUTCOMES = new Set(["success", "partial", "failure"]);

async function runList(filters: ListFilters, jsonMode: boolean): Promise<void> {
	if (filters.status && !VALID_PLAN_STATUSES.has(filters.status)) {
		throw new Error(
			`--status must be one of: ${[...VALID_PLAN_STATUSES].join(", ")} (got: ${filters.status})`,
		);
	}
	if (filters.outcome && !VALID_PLAN_OUTCOMES.has(filters.outcome)) {
		throw new Error(
			`--outcome must be one of: ${[...VALID_PLAN_OUTCOMES].join(", ")} (got: ${filters.outcome})`,
		);
	}

	const dir = await findSeedsDir();
	const plans = await readPlans(dir);
	const filtered = plans
		.filter((p) => (filters.seed ? p.seed === filters.seed : true))
		.filter((p) => (filters.status ? p.status === filters.status : true))
		.filter((p) => (filters.outcome ? p.outcome === filters.outcome : true))
		.filter((p) => (filters.template ? p.template === filters.template : true))
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

	if (jsonMode) {
		outputJson({
			success: true,
			command: "plan list",
			plans: filtered,
			count: filtered.length,
		});
		return;
	}

	if (filtered.length === 0) {
		console.log(muted("No plans match."));
		return;
	}
	for (const p of filtered) {
		const outcome = p.outcome ? muted(` (${p.outcome})`) : "";
		console.log(
			`${accent.bold(p.id)}  ${muted(p.status)}  rev ${p.revision}  ${muted(p.template)}  ${muted(`seed=${p.seed}`)}  ${muted(`children=${p.children.length}`)}${outcome}  ${muted(p.createdAt)}`,
		);
	}
}

async function runValidate(planId: string, jsonMode: boolean): Promise<void> {
	const dir = await findSeedsDir();
	const plans = await readPlans(dir);
	const plan = plans.find((p) => p.id === planId);
	if (!plan) {
		throw new Error(`Plan not found: ${planId}. Run 'sd plan list' to see available plans.`);
	}
	const template = getTemplate(plan.template);
	if (!template) {
		const available = templateNames().join(", ");
		throw new Error(
			`Plan ${planId} references unknown template '${plan.template}'. Available: ${available}.`,
		);
	}

	// Re-run the same validator submit uses so the partial-state diff shape stays
	// in sync (PLAN_SPEC.md:148-149 + 180-195).
	const subject = { template: plan.template, sections: plan.sections };
	const result = template.validate(subject);

	if (result.valid) {
		if (jsonMode) {
			outputJson({ success: true, command: "plan validate", valid: true, plan_id: planId });
		} else {
			printSuccess(`plan ${accent(planId)} valid`);
		}
		return;
	}

	process.stderr.write(`${JSON.stringify(result.diff, null, 2)}\n`);
	process.exitCode = 1;
}
